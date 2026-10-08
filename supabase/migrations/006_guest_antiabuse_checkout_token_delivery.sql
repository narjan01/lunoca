-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 006: GUEST ANTI-ABUSE, CHECKOUT TOKEN & DELIVERY
-- Hardening da 3ª Auditoria de Segurança:
-- 1. Coluna checkout_token UUID em pedidos para proteção de acesso a pedidos de visitantes.
-- 2. Anti-abuso contra esgotamento de estoque (rate limit por telefone/endereço em 15 min).
-- 3. Anti-hoarding limitando quantidade máxima por item no guest checkout.
-- 4. Cálculo estrito e imutável da taxa de entrega no servidor (R$ 0 para retirada, R$ 10 para entrega).
-- 5. Revogação estrita de permissões de dar_baixa_ingredientes_pedido para authenticated.
-- ==========================================================================

-- 1. Coluna checkout_token na tabela pedidos
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS checkout_token UUID DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS idx_pedidos_checkout_token ON public.pedidos(checkout_token);

-- 2. Revogação estrita de privilégios da rotina interna de insumos
REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.ingredientes, public.produto_ingredientes FROM authenticated;

-- 3. Atualização da RPC criar_pedido com proteções ativas
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
  v_checkout_token UUID;
  v_expires_at TIMESTAMPTZ;
  v_nome_final TEXT;
  v_email_final TEXT;
  v_telefone_final TEXT;
  v_fone_limpo TEXT;
BEGIN
  -- 1. Identificação do Cliente (Usuário Autenticado ou Visitante Convidado)
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

    -- 1.2. Proteção Anti-Abuso para Visitantes: limite de pedidos pendentes recentes (máx 3 nos últimos 15 min)
    IF (
      SELECT COUNT(*)
      FROM public.pedidos
      WHERE (telefone_cliente = v_telefone_final OR endereco_entrega = p_endereco_entrega)
        AND status = 'Pendente'
        AND created_at >= (NOW() - INTERVAL '15 minutes')
    ) >= 3 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Limite de pedidos pendentes atingido para este telefone/endereço (máx. 3 nos últimos 15 min). Aguarde alguns minutos.'
      );
    END IF;
  END IF;

  -- 2. Validações de entrada
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Sua sacola está vazia.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  IF p_pagamento NOT IN ('pix', 'cartao') THEN
    RETURN json_build_object('success', false, 'error', 'Forma de pagamento inválida.');
  END IF;

  -- 3. Tolerância de pagamento: 30 minutos para PIX/Checkout
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 4. Loop com bloqueio pessimista (FOR UPDATE) e reserva de estoque
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    IF v_prod_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Item inválido na sacola.');
    END IF;

    -- Anti-Hoarding para Visitante: limite razoável por item no checkout anônimo
    IF v_cliente_id IS NULL AND v_qtd > 50 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Quantidade máxima por item para checkout rápido sem cadastro é de 50 unidades. Para encomendas maiores, acesse sua conta ou entre em contato.'
      );
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
          'error', 'Estoque esgotado ou insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;

      -- Reserva o estoque atômica e temporariamente
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

  -- 5. Validação e cálculo estrito da taxa de entrega no servidor (desconsidera manipulação do cliente)
  IF LOWER(COALESCE(p_modalidade, 'entrega')) = 'retirada' THEN
    v_taxa := 0.00;
  ELSE
    -- Taxa fixa oficial de entrega Lunoca
    v_taxa := 10.00;
  END IF;

  v_total := v_total + v_taxa;

  -- 6. Grava o pedido com status de pagamento, token e expiração
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
  ) RETURNING id, checkout_token INTO v_pedido_id, v_checkout_token;

  -- Vincula o ID do pedido nas movimentações de reserva geradas nesta transação
  UPDATE public.estoque_movimentacoes
  SET pedido_id = v_pedido_id
  WHERE pedido_id IS NULL AND tipo = 'reserva' AND created_at >= NOW() - INTERVAL '5 seconds';

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total,
    'taxa_entrega', v_taxa,
    'checkout_token', v_checkout_token,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;
