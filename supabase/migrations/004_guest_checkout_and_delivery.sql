-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 004: GUEST CHECKOUT & TAXA DE ENTREGA (FASE 5)
-- Permite compras rápidas sem login obrigatório (Guest Checkout)
-- Suporte a modalidade (Entrega/Retirada) e taxa de entrega validada no servidor.
-- ==========================================================================

-- 1. Colunas de entrega e modalidade na tabela pedidos
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS taxa_entrega DECIMAL(10,2) DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS modalidade_entrega TEXT DEFAULT 'entrega';

-- 2. Drop de versões anteriores da RPC para atualizar a assinatura
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT p.oid::regprocedure AS func_signature
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'criar_pedido'
  ) LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.func_signature || ' CASCADE;';
  END LOOP;
END $$;

-- 3. Nova RPC criar_pedido com suporte a Guest Checkout e Taxa de Entrega
CREATE OR REPLACE FUNCTION public.criar_pedido(
  p_itens JSONB,
  p_data_entrega DATE,
  p_pagamento TEXT,
  p_endereco_entrega TEXT,
  p_telefone_cliente TEXT,
  p_nome_cliente TEXT,
  p_taxa_entrega NUMERIC DEFAULT 0,
  p_email_cliente TEXT DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'entrega'
)
RETURNS JSON AS $$
DECLARE
  v_cliente_id UUID := auth.uid();
  v_user_profile RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_disponivel INTEGER;
  v_total DECIMAL(10,2) := 0;
  v_taxa DECIMAL(10,2) := 0;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_pedido_id BIGINT;
  v_expires_at TIMESTAMPTZ;
  v_nome_final TEXT;
  v_email_final TEXT;
  v_telefone_final TEXT;
  v_fone_limpo TEXT;
BEGIN
  -- 3.1. Identificação do Cliente (Usuário Autenticado ou Visitante Convidado)
  IF v_cliente_id IS NOT NULL THEN
    -- Cliente logado: busca perfil oficial
    SELECT * INTO v_user_profile
    FROM public.profiles
    WHERE id = v_cliente_id AND ativo = true;

    IF NOT FOUND THEN
      RETURN json_build_object('success', false, 'error', 'Sua conta de usuário está inativa ou não foi encontrada.');
    END IF;

    v_nome_final := COALESCE(NULLIF(trim(p_nome_cliente), ''), v_user_profile.nome);
    v_email_final := COALESCE(v_user_profile.email, NULLIF(trim(p_email_cliente), ''), 'cliente@lunocadoceria.com.br');
    v_telefone_final := COALESCE(NULLIF(trim(p_telefone_cliente), ''), v_user_profile.telefone);
  ELSE
    -- Guest Checkout (compra como visitante sem necessidade de senha prévia)
    v_nome_final := trim(COALESCE(p_nome_cliente, ''));
    v_telefone_final := trim(COALESCE(p_telefone_cliente, ''));
    v_email_final := COALESCE(NULLIF(trim(p_email_cliente), ''), 'visitante@lunocadoceria.com.br');

    IF length(v_nome_final) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe seu nome completo para a encomenda.');
    END IF;

    v_fone_limpo := regexp_replace(v_telefone_final, '\D', '', 'g');
    IF length(v_fone_limpo) < 10 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe um WhatsApp válido com DDD para acompanhar o pedido.');
    END IF;
  END IF;

  -- 3.2. Validações de entrada
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Sua sacola está vazia.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  IF p_pagamento NOT IN ('pix', 'cartao') THEN
    RETURN json_build_object('success', false, 'error', 'Forma de pagamento inválida.');
  END IF;

  -- 3.3. Tolerância de pagamento: 30 minutos para PIX/Checkout
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 3.4. Loop com bloqueio pessimista (FOR UPDATE) e reserva de estoque
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    IF v_prod_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Item inválido na sacola.');
    END IF;

    -- Bloqueio pessimista por linha do produto
    SELECT id, nome, preco, ativo, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id
    FOR UPDATE;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'O produto "' || COALESCE(v_item->>'nome', 'item') || '" não está mais disponível.');
    END IF;

    -- Verifica disponibilidade real (Físico - Reservado)
    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      IF v_disponivel < v_qtd THEN
        RETURN json_build_object(
          'success', false,
          'error', 'Estoque insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;

      -- Reserva o estoque temporariamente
      UPDATE public.produtos
      SET 
        estoque_reservado = estoque_reservado + v_qtd,
        updated_at = NOW()
      WHERE id = v_prod_id;

      -- Registra movimentação de reserva
      INSERT INTO public.estoque_movimentacoes (
        produto_id,
        produto_nome,
        tipo,
        quantidade,
        saldo_resultante,
        motivo,
        usuario_nome
      ) VALUES (
        v_prod.id,
        v_prod.nome,
        'reserva',
        v_qtd,
        v_disponivel - v_qtd,
        'Reserva temporária para novo pedido (tolerância 30 min)',
        'Sistema / Reserva'
      );
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 3.5. Adiciona taxa de entrega validada (caso seja entrega em domicílio)
  IF COALESCE(p_modalidade, 'entrega') = 'entrega' THEN
    v_taxa := GREATEST(0, COALESCE(p_taxa_entrega, 0));
  ELSE
    v_taxa := 0;
  END IF;

  v_total := v_total + v_taxa;

  -- 3.6. Grava o pedido com status de pagamento e expiração
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    total,
    taxa_entrega,
    modalidade_entrega,
    pagamento,
    status,
    status_pagamento,
    status_producao,
    expires_at,
    itens,
    itens_json,
    endereco_entrega
  ) VALUES (
    v_cliente_id,
    v_nome_final,
    v_email_final,
    v_telefone_final,
    CURRENT_DATE,
    p_data_entrega,
    v_total,
    v_taxa,
    COALESCE(p_modalidade, 'entrega'),
    p_pagamento,
    'Pendente',
    'aguardando_pagamento',
    'recebido',
    v_expires_at,
    array_to_string(v_nomes_itens, ' + '),
    p_itens,
    p_endereco_entrega
  ) RETURNING id INTO v_pedido_id;

  -- Vincula o ID do pedido nas movimentações de reserva geradas nesta transação
  UPDATE public.estoque_movimentacoes
  SET pedido_id = v_pedido_id
  WHERE pedido_id IS NULL AND tipo = 'reserva' AND created_at >= NOW() - INTERVAL '5 seconds';

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total,
    'taxa_entrega', v_taxa,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Concede execução para usuários autenticados, service_role e VISITANTES ANÔNIMOS (Guest Checkout)
GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;
