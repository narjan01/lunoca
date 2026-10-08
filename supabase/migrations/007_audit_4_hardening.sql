-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 007: AUDIT 4 INTEGRITY & CONCURRENCY HARDENING
-- 1. Eliminação total de race conditions na associação de reservas ao pedido
--    (v_pedido_id obtido ANTES da gravação de estoque_movimentacoes).
-- 2. Autossuficiência e validação intrínseca de status ('approved') e valor
--    financeiro na RPC confirmar_pagamento_pedido.
-- 3. Rate-limiting atômico do Guest Checkout via pg_advisory_xact_lock
--    e normalização estrita de telefone (DDI 55).
-- 4. Rastreabilidade real de consumo e estoque de matérias-primas na Ficha Técnica.
-- 5. Saldo físico real registrado nas movimentações de venda.
-- ==========================================================================

-- 1. RPC criar_pedido com criação direta e atômica de reservas
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
  v_fone_normalizado TEXT;
BEGIN
  -- 1. Identificação do Cliente (Usuário Autenticado ou Visitante Convidado)
  IF v_cliente_id IS NOT NULL THEN
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
    -- Guest Checkout: compra como visitante
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

    -- Normalização de telefone (DDI 55)
    IF length(v_fone_limpo) IN (10, 11) THEN
      v_fone_normalizado := '55' || v_fone_limpo;
    ELSE
      v_fone_normalizado := v_fone_limpo;
    END IF;

    -- Proteção Atômica Anti-Abuso: Serializa requisições simultâneas para o mesmo telefone normalizado via advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('guest_checkout_' || v_fone_normalizado));

    -- Limite estrito de no máximo 3 pedidos pendentes recentes nos últimos 15 min
    IF (
      SELECT COUNT(*)
      FROM public.pedidos
      WHERE (
        regexp_replace(COALESCE(telefone_cliente, ''), '\D', '', 'g') IN (v_fone_limpo, v_fone_normalizado)
        OR endereco_entrega = p_endereco_entrega
      )
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

  -- 3. Tolerância de pagamento de 30 minutos
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 4. ETAPA 1: Validação dos itens, bloqueio pessimista (FOR UPDATE) e cálculo de totais
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    IF v_prod_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Item inválido na sacola.');
    END IF;

    -- Anti-Hoarding para Visitante
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
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 5. Validação e cálculo estrito da taxa de entrega no servidor
  IF LOWER(COALESCE(p_modalidade, 'entrega')) = 'retirada' THEN
    v_taxa := 0.00;
  ELSE
    v_taxa := 10.00;
  END IF;

  v_total := v_total + v_taxa;

  -- 6. ETAPA 2: GRAVAÇÃO DO PEDIDO PRIMEIRO (Gera v_pedido_id e v_checkout_token deterministicamente)
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

  -- 7. ETAPA 3: RESERVA ATÔMICA DO ESTOQUE COM PEDIDO_ID DIRETAMENTE ATRIBUÍDO (Sem qualquer corrida de timestamp)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    SELECT id, nome, preco, ativo, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      UPDATE public.produtos
      SET 
        estoque_reservado = estoque_reservado + v_qtd,
        updated_at = NOW()
      WHERE id = v_prod_id;

      INSERT INTO public.estoque_movimentacoes (
        produto_id,
        produto_nome,
        tipo,
        quantidade,
        saldo_resultante,
        pedido_id,
        motivo,
        usuario_nome
      ) VALUES (
        v_prod.id,
        v_prod.nome,
        'reserva',
        v_qtd,
        v_disponivel - v_qtd,
        v_pedido_id,
        'Reserva temporária para novo pedido #' || v_pedido_id || ' (tolerância 30 min)',
        'Sistema / Reserva'
      );
    END IF;
  END LOOP;

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


-- 2. RPC confirmar_pagamento_pedido com validação intrínseca de status e integridade financeira
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pedido(
  p_pedido_id BIGINT,
  p_mercado_pago_payment_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'approved',
  p_forma_pagamento TEXT DEFAULT NULL,
  p_valor NUMERIC DEFAULT NULL,
  p_origem TEXT DEFAULT 'webhook'
)
RETURNS JSON AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- Validação estrita de status: somente pagamentos aprovados podem confirmar pedidos
  IF COALESCE(p_mercado_pago_payment_id, '') <> 'admin_manual'
     AND LOWER(COALESCE(p_status, '')) <> 'approved'
  THEN
    RETURN json_build_object('success', false, 'error', 'Somente pagamentos aprovados podem confirmar pedidos.');
  END IF;

  -- 2.1. Idempotência por Provider ID
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.pagamentos_processados
      WHERE provider_id = p_mercado_pago_payment_id
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente (idempotência confirmada).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 2.2. Bloqueio pessimista por linha (SELECT FOR UPDATE)
  SELECT * INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- Validação de integridade financeira do valor pago vs total do pedido
  IF p_valor IS NOT NULL AND ABS(p_valor - v_pedido.total) > 0.01 THEN
    RETURN json_build_object('success', false, 'error', 'Valor do pagamento (R$ ' || p_valor || ') diverge do total do pedido (R$ ' || v_pedido.total || ').');
  END IF;

  -- 2.3. Se já confirmado anteriormente, impede duplo processamento
  IF v_pedido.status IN ('Confirmado', 'Em Preparo', 'Pronto', 'Entregue') OR v_pedido.status_pagamento = 'pago' THEN
    IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
      INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
      VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
      ON CONFLICT (provider_id) DO NOTHING;
    END IF;

    RETURN json_build_object(
      'success', true,
      'message', 'Pedido já estava confirmado anteriormente',
      'pedido_id', p_pedido_id,
      'status', v_pedido.status
    );
  END IF;

  -- 2.4. Atualiza status do pedido para Confirmado / Pago
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    status_pagamento = 'pago',
    status_producao = CASE WHEN status_producao IS NULL OR status_producao = 'cancelado' THEN 'recebido' ELSE status_producao END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 2.5. Baixa física e liberação da reserva no estoque (SELECT FOR UPDATE)
  IF v_pedido.itens_json IS NOT NULL AND jsonb_typeof(v_pedido.itens_json) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
    LOOP
      v_prod_id := (v_item->>'id')::BIGINT;
      v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

      IF v_prod_id IS NOT NULL THEN
        SELECT id, nome, estoque_fisico, estoque_reservado, controlar_estoque
        INTO v_prod
        FROM public.produtos
        WHERE id = v_prod_id
        FOR UPDATE;

        IF FOUND AND (v_prod.controlar_estoque IS NOT FALSE) THEN
          -- Converte a reserva em baixa física real
          UPDATE public.produtos
          SET 
            estoque_reservado = GREATEST(0, estoque_reservado - v_qtd),
            estoque_fisico = GREATEST(0, estoque_fisico - v_qtd),
            updated_at = NOW()
          WHERE id = v_prod_id;

          INSERT INTO public.estoque_movimentacoes (
            produto_id,
            produto_nome,
            tipo,
            quantidade,
            saldo_resultante,
            motivo,
            pedido_id,
            usuario_nome
          ) VALUES (
            v_prod.id,
            v_prod.nome,
            'venda',
            v_qtd,
            GREATEST(0, v_prod.estoque_fisico - v_qtd),
            'Venda confirmada no Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 2.6. Baixa atômica de insumos da receita (Ficha Técnica)
  PERFORM public.dar_baixa_ingredientes_pedido(p_pedido_id);

  -- 2.7. Lançamento Financeiro Automático (com proteção estrita contra duplicidade)
  IF NOT EXISTS (
    SELECT 1 FROM public.financeiro_lancamentos 
    WHERE pedido_id = p_pedido_id AND tipo = 'receita'
  ) THEN
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      observacoes
    ) VALUES (
      'receita',
      'Vendas',
      'Venda do Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
      v_pedido.total,
      CURRENT_DATE,
      COALESCE(p_forma_pagamento, v_pedido.pagamento, 'pix'),
      p_pedido_id,
      'Confirmação via ' || COALESCE(p_origem, 'Mercado Pago') ||
        CASE 
          WHEN p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' 
          THEN ' [ID: ' || p_mercado_pago_payment_id || ']' 
          ELSE '' 
        END
    );
  END IF;

  -- 2.8. Registro de Idempotência
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
    VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
    ON CONFLICT (provider_id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'success', true,
    'message', 'Pagamento confirmado, estoque baixado e insumos descontados com sucesso!',
    'pedido_id', p_pedido_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;


-- 3. Função dar_baixa_ingredientes_pedido com transparência real de déficit
CREATE OR REPLACE FUNCTION public.dar_baixa_ingredientes_pedido(p_pedido_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd_prod NUMERIC;
  v_ficha RECORD;
BEGIN
  SELECT itens_json INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id;
  IF NOT FOUND OR v_pedido.itens_json IS NULL OR jsonb_typeof(v_pedido.itens_json) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd_prod := GREATEST(1, COALESCE((v_item->>'quantidade')::NUMERIC, 1));

    IF v_prod_id IS NOT NULL THEN
      FOR v_ficha IN 
        SELECT pi.ingrediente_id, pi.quantidade AS qtd_insumo
        FROM public.produto_ingredientes pi
        JOIN public.ingredientes i ON i.id = pi.ingrediente_id
        WHERE pi.produto_id = v_prod_id AND i.ativo = true
      LOOP
        -- Permite registrar estoque negativo para auditoria de matéria-prima sem mascarar consumo
        UPDATE public.ingredientes
        SET 
          estoque_qtd = estoque_qtd - (v_ficha.qtd_insumo * v_qtd_prod),
          updated_at = NOW()
        WHERE id = v_ficha.ingrediente_id;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role;
