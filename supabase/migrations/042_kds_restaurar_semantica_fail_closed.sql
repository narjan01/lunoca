-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 042: RESTAURAÇÃO DA POLÍTICA FAIL-CLOSED DO KDS
-- ==============================================================================
-- Justificativa Arquitetural (Governança & Integridade da Frente 038):
-- 1. Restaura a semântica canônica: produto que exige produção sem rota cadastrada
--    em produto_etapas_kds gera exceção estrita KDS_ROUTE_NOT_CONFIGURED (P0001).
-- 2. Elimina a síntese de rota implícita ("Confeitaria -> Embalagem") introduzida
--    como fallback na Migration 041.
-- 3. Reconhece explicitamente a exceção legítima de produtos pronta-entrega
--    (pronta_entrega = true): esses itens não necessitam de transformação fabril e
--    são dispensados da fila do KDS sem gerar erro.
-- 4. Preserva 100% das melhorias operacionais da 041:
--    - Badges ao vivo com projeções canônicas
--    - Atalhos de navegação Pedidos -> KDS / Balcão
--    - Filtro "Todos Pendentes" em Retirada
--    - Normalização de dados do cliente na retirada (nome_cliente, telefone_cliente)
--    - Inicialização idempotente (ON CONFLICT DO NOTHING)
-- 5. Preserva o isolamento financeiro: erro de rota na cozinha jamais desfaz a baixa
--    ou confirmação de pagamento do Mercado Pago em confirmar_pagamento_pedido().
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COLUNA CANÔNICA DE PRONTA-ENTREGA EM PRODUTOS
-- ------------------------------------------------------------------------------
ALTER TABLE public.produtos 
  ADD COLUMN IF NOT EXISTS pronta_entrega BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------------------------
-- 2. RESTAURAÇÃO DE KDS_INICIALIZAR_PEDIDO COM SEMÂNTICA PURA FAIL-CLOSED (P0001)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_inicializar_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_pedido RECORD;
  v_kds_id UUID;
  v_item RECORD;
  v_etapas_count INT;
  v_sla_item_total INT;
  v_sla_pedido_total INT := 0;
  v_primeira_etapa RECORD;
  v_itens_kds_count INT := 0;
  v_kds_item_id UUID;
  v_tem_itens_producao BOOLEAN := FALSE;
BEGIN
  -- 1. Trava pessimista e validação do pedido
  SELECT id, status_operacional, observacoes_internas, canal
  INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- 2. Idempotência estrita: se já existir cabeçalho no KDS, retorna sem duplicar
  SELECT id INTO v_kds_id
  FROM public.pedido_producao_kds
  WHERE pedido_id = p_pedido_id;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'kds_id', v_kds_id, 'ja_inicializado', true);
  END IF;

  -- 3. Validar elegibilidade de rota de todos os itens do pedido (Fail-Closed)
  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, 
           COALESCE(p.pronta_entrega, false) AS pronta_entrega,
           p.ativo
    FROM public.pedido_itens pi
    LEFT JOIN public.produtos p ON p.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    -- Exceção legítima: produto pronta-entrega não entra no KDS
    IF v_item.pronta_entrega IS TRUE THEN
      CONTINUE;
    END IF;

    v_tem_itens_producao := TRUE;

    SELECT COUNT(*), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    IF v_etapas_count = 0 THEN
      -- POLÍTICA CANÔNICA FRENTE 038: Fail-Closed P0001 (Zero rotas implícitas sintetizadas)
      RAISE EXCEPTION 'KDS_ROUTE_NOT_CONFIGURED: O produto % (ID %) não possui rota de etapas cadastrada no KDS.',
        v_item.produto_nome_snapshot, v_item.produto_id
        USING ERRCODE = 'P0001';
    END IF;

    v_sla_pedido_total := v_sla_pedido_total + v_sla_item_total;
    v_itens_kds_count := v_itens_kds_count + 1;
  END LOOP;

  -- Se o pedido for composto exclusivamente por pronta-entrega, o KDS é dispensado
  IF NOT v_tem_itens_producao OR v_itens_kds_count = 0 THEN
    RETURN jsonb_build_object(
      'success', true, 
      'kds_id', null, 
      'pronta_entrega', true, 
      'message', 'Pedido composto exclusivamente por itens de pronta-entrega; KDS dispensado.'
    );
  END IF;

  -- 4. Criar cabeçalho do pedido no KDS de forma idempotente
  INSERT INTO public.pedido_producao_kds (
    pedido_id,
    estagio_agregado,
    ativo,
    sla_total_snapshot,
    prioridade_urgencia,
    observacoes_cozinha,
    criado_em,
    updated_at
  ) VALUES (
    p_pedido_id,
    'AGUARDANDO',
    TRUE,
    GREATEST(1, v_sla_pedido_total),
    FALSE,
    v_pedido.observacoes_internas,
    NOW(),
    NOW()
  )
  ON CONFLICT (pedido_id) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_kds_id;

  -- 5. Criar unidades de produção no KDS para os itens que exigem produção
  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, pi.observacoes,
           COALESCE(p.pronta_entrega, false) AS pronta_entrega
    FROM public.pedido_itens pi
    LEFT JOIN public.produtos p ON p.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    IF v_item.pronta_entrega IS TRUE THEN
      CONTINUE;
    END IF;

    SELECT ordem, praca, sla_minutos
    INTO v_primeira_etapa
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id
    ORDER BY ordem ASC
    LIMIT 1;

    SELECT MAX(ordem), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    INSERT INTO public.pedido_item_producao_kds (
      kds_id,
      pedido_id,
      pedido_item_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      ordem_etapa_atual,
      ordem_etapa_max,
      estagio_atual,
      praca_atual,
      proxima_etapa,
      ativo,
      sla_etapa_snapshot,
      sla_total_snapshot,
      observacoes_item,
      criado_em,
      updated_at
    ) VALUES (
      v_kds_id,
      p_pedido_id,
      v_item.id,
      v_item.produto_id,
      v_item.produto_nome_snapshot,
      v_item.quantidade,
      0,
      v_etapas_count,
      'AGUARDANDO',
      NULL,
      v_primeira_etapa.praca,
      TRUE,
      v_primeira_etapa.sla_minutos,
      v_sla_item_total,
      v_item.observacoes,
      NOW(),
      NOW()
    )
    ON CONFLICT (kds_id, pedido_item_id) DO NOTHING
    RETURNING id INTO v_kds_item_id;

    -- Se já existia, recupera id existente
    IF v_kds_item_id IS NULL THEN
      SELECT id INTO v_kds_item_id 
      FROM public.pedido_item_producao_kds 
      WHERE kds_id = v_kds_id AND pedido_item_id = v_item.id;
    END IF;

    IF v_kds_item_id IS NOT NULL THEN
      -- Congelar snapshot imutável da rota do item
      INSERT INTO public.pedido_item_kds_etapas (
        kds_item_id,
        pedido_id,
        pedido_item_id,
        ordem,
        praca,
        sla_minutos_snapshot,
        obrigatoria_snapshot
      )
      SELECT
        v_kds_item_id,
        p_pedido_id,
        v_item.id,
        ordem,
        praca,
        sla_minutos,
        obrigatoria
      FROM public.produto_etapas_kds
      WHERE produto_id = v_item.produto_id
      ORDER BY ordem ASC
      ON CONFLICT (kds_item_id, ordem) DO NOTHING;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'kds_id', v_kds_id,
    'pedido_id', p_pedido_id,
    'itens_inicializados', v_itens_kds_count,
    'sla_total_minutos', v_sla_pedido_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Grants estritos fail-closed
REVOKE ALL ON FUNCTION public.kds_inicializar_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kds_inicializar_pedido(BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 3. TRIGGER DE SINCRONIZAÇÃO RESILIENTE (NÃO BLOQUEIA MUTADOR DE PEDIDO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_sincronizar_kds_pedido()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o pedido transicionar para aguardando_producao, tenta inicializar no KDS
  IF NEW.status_operacional = 'aguardando_producao' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'aguardando_producao') THEN
    IF NOT EXISTS (SELECT 1 FROM public.pedido_producao_kds WHERE pedido_id = NEW.id) THEN
      BEGIN
        PERFORM public.kds_inicializar_pedido(NEW.id);
      EXCEPTION WHEN OTHERS THEN
        -- Log fail-safe: não aborta transação de confirmação de pedido caso produto esteja sem rota
        RAISE WARNING 'KDS_INIT_SKIPPED: Pedido % não inicializado no KDS: %', NEW.id, SQLERRM;
      END;
    END IF;
  END IF;

  -- Se o pedido for cancelado, encerra as unidades do KDS sem apagar histórico e sem marcar pronto
  IF NEW.status_operacional = 'cancelado' AND OLD.status_operacional <> 'cancelado' THEN
    UPDATE public.pedido_producao_kds
    SET ativo = FALSE,
        encerrado_em = NOW(),
        motivo_encerramento = 'CANCELADO',
        updated_at = NOW()
    WHERE pedido_id = NEW.id AND ativo = TRUE;

    UPDATE public.pedido_item_producao_kds
    SET ativo = FALSE,
        encerrado_em = NOW(),
        motivo_encerramento = 'CANCELADO',
        updated_at = NOW()
    WHERE pedido_id = NEW.id AND ativo = TRUE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
