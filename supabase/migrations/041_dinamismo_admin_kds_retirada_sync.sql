-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 041: DINAMISMO OPERACIONAL, KDS & BALCÃO DE RETIRADA
-- ==============================================================================
-- 1. Resiliência do KDS: fallback automático para produtos sem rota específica
-- 2. Gatilho inteligente de sincronização do KDS para pedidos confirmados/pagos
-- 3. Invocação canônica do KDS em confirmar_pagamento_pedido()
-- 4. Melhoria no painel de Balcão & Retirada (suporte a listagem geral pendente e nome de cliente da loja)
-- 5. Backfill idempotente dos pedidos confirmados para a fila de produção do KDS
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. RESILIÊNCIA DE ROTA NO KDS (FALLBACK AUTOMÁTICO DE ETAPA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_inicializar_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_pedido RECORD;
  v_kds_id UUID;
  v_item RECORD;
  v_etapa RECORD;
  v_kds_item_id UUID;
  v_etapas_count INT;
  v_sla_item_total INT;
  v_sla_pedido_total INT := 0;
  v_primeira_etapa RECORD;
  v_itens_kds_count INT := 0;
BEGIN
  -- 1. Trava e validação do pedido
  SELECT id, status_operacional, observacoes_internas, canal
  INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- Se já estiver inicializado no KDS, retorna idempotente
  SELECT id INTO v_kds_id
  FROM public.pedido_producao_kds
  WHERE pedido_id = p_pedido_id;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'kds_id', v_kds_id, 'ja_inicializado', true);
  END IF;

  -- 2. Validar elegibilidade de rota de todos os itens do pedido
  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, p.ativo, p.controlar_estoque
    FROM public.pedido_itens pi
    LEFT JOIN public.produtos p ON p.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    SELECT COUNT(*), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    IF v_etapas_count = 0 THEN
      -- Fallback resiliente: cria rota padrão de Confeitaria/Embalagem para o produto
      INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos, obrigatoria)
      VALUES (v_item.produto_id, 1, 'EMBALAGEM', 15, TRUE)
      ON CONFLICT DO NOTHING;
      v_sla_item_total := 15;
    END IF;

    v_sla_pedido_total := v_sla_pedido_total + v_sla_item_total;
    v_itens_kds_count := v_itens_kds_count + 1;
  END LOOP;

  IF v_itens_kds_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não possui itens para produção.', 'code', 'EMPTY_ORDER_ITEMS');
  END IF;

  -- 3. Criar cabeçalho do pedido no KDS
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
    v_sla_pedido_total,
    FALSE,
    v_pedido.observacoes_internas,
    NOW(),
    NOW()
  ) RETURNING id INTO v_kds_id;

  -- 4. Criar itens de produção do KDS com suporte a multi-etapas
  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, pi.observacoes
    FROM public.pedido_itens pi
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    -- Buscar a primeira etapa da rota cadastrada
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
      tempo_etapa_iniciado_em,
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
      COALESCE(v_etapas_count, 1),
      'AGUARDANDO',
      NULL,
      v_primeira_etapa.praca,
      TRUE,
      NULL,
      COALESCE(v_primeira_etapa.sla_minutos, 15),
      v_sla_item_total,
      v_item.observacoes,
      NOW(),
      NOW()
    ) RETURNING id INTO v_kds_item_id;

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
    ORDER BY ordem ASC;
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

REVOKE ALL ON FUNCTION public.kds_inicializar_pedido(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_inicializar_pedido(BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. TRIGGER DE SINCRONIZAÇÃO KDS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_sincronizar_kds_pedido()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o pedido for confirmado ou pago, ou se estiver aguardando/em produção, inicializa se ainda não existir
  IF (NEW.status_operacional IN ('aguardando_producao', 'em_producao'))
     AND (NEW.status_comercial = 'confirmado' OR NEW.status_financeiro = 'pago') THEN
    IF NOT EXISTS (SELECT 1 FROM public.pedido_producao_kds WHERE pedido_id = NEW.id) THEN
      IF EXISTS (SELECT 1 FROM public.pedido_itens WHERE pedido_id = NEW.id) THEN
        BEGIN
          PERFORM public.kds_inicializar_pedido(NEW.id);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END IF;
    END IF;
  END IF;

  -- Se o pedido for cancelado, encerra as unidades do KDS sem apagar histórico
  IF NEW.status_operacional = 'cancelado' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'cancelado') THEN
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

DROP TRIGGER IF EXISTS trg_sincronizar_kds_pedido ON public.pedidos;
CREATE TRIGGER trg_sincronizar_kds_pedido
  AFTER UPDATE OF status_operacional, status_comercial, status_financeiro ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_sincronizar_kds_pedido();

-- Gatilho para itens: quando itens forem inseridos em pedido já confirmado, inicializa no KDS
CREATE OR REPLACE FUNCTION public._trg_sincronizar_kds_pedido_itens()
RETURNS TRIGGER AS $$
DECLARE
  v_ped RECORD;
BEGIN
  SELECT id, status_operacional, status_comercial, status_financeiro
  INTO v_ped
  FROM public.pedidos
  WHERE id = NEW.pedido_id;

  IF FOUND AND v_ped.status_operacional IN ('aguardando_producao', 'em_producao')
     AND (v_ped.status_comercial = 'confirmado' OR v_ped.status_financeiro = 'pago') THEN
    IF NOT EXISTS (SELECT 1 FROM public.pedido_producao_kds WHERE pedido_id = NEW.pedido_id) THEN
      BEGIN
        PERFORM public.kds_inicializar_pedido(NEW.pedido_id);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_sincronizar_kds_pedido_itens ON public.pedido_itens;
CREATE TRIGGER trg_sincronizar_kds_pedido_itens
  AFTER INSERT ON public.pedido_itens
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_sincronizar_kds_pedido_itens();

-- ------------------------------------------------------------------------------
-- 3. CANONICAL CONFIRMAR_PAGAMENTO_PEDIDO INVOCANDO KDS DE FORMA SEGURA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pedido(
  p_pedido_id bigint,
  p_status text DEFAULT 'approved'::text,
  p_mercado_pago_payment_id text DEFAULT NULL::text,
  p_valor numeric DEFAULT NULL::numeric,
  p_forma_pagamento text DEFAULT 'pix'::text,
  p_origem text DEFAULT 'webhook_mercadopago'::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_pedido RECORD;
  v_item RECORD;
  v_prod RECORD;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_lancamento_id BIGINT;
BEGIN
  -- 7.1. Validação de idempotência por webhook_eventos
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.gateway_webhook_eventos
      WHERE provider = 'mercadopago' 
        AND provider_payment_id = p_mercado_pago_payment_id 
        AND status = 'PROCESSADO'
    ) AND EXISTS (
      SELECT 1 FROM public.pedidos 
      WHERE id = p_pedido_id AND status_financeiro = 'pago'
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente por webhook (idempotência garantida).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 7.2. Busca o pedido com bloqueio pessimista por linha (SELECT FOR UPDATE)
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

  -- 7.3. Se já confirmado anteriormente, impede duplo processamento
  IF v_pedido.status_financeiro = 'pago' OR v_pedido.status_comercial = 'confirmado' THEN
    IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
      INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
      VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
      ON CONFLICT (provider_id) DO NOTHING;
    END IF;

    -- Tenta inicializar KDS caso ainda não estivesse inicializado
    BEGIN
      PERFORM public.kds_inicializar_pedido(p_pedido_id);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN json_build_object(
      'success', true,
      'message', 'Pedido já estava confirmado anteriormente',
      'pedido_id', p_pedido_id,
      'status', v_pedido.status
    );
  END IF;

  -- Idempotência por Provider ID em pedido_pagamentos
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.pedido_pagamentos
      WHERE provider = 'mercadopago' AND provider_payment_id = p_mercado_pago_payment_id
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente em pedido_pagamentos (idempotência confirmada).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 7.4. Registrar na tabela canônica pedido_pagamentos (dispara recálculo financeiro atômico)
  INSERT INTO public.pedido_pagamentos (
    pedido_id,
    valor,
    metodo,
    provider,
    provider_payment_id,
    status,
    pago_em,
    observacoes
  ) VALUES (
    p_pedido_id,
    COALESCE(p_valor, v_pedido.total),
    CASE 
      WHEN COALESCE(p_forma_pagamento, v_pedido.pagamento) ILIKE '%cartao%' THEN 'cartao'
      WHEN COALESCE(p_forma_pagamento, v_pedido.pagamento) ILIKE '%dinheiro%' THEN 'dinheiro'
      ELSE 'pix'
    END,
    CASE WHEN p_mercado_pago_payment_id = 'admin_manual' THEN 'manual' ELSE 'mercadopago' END,
    CASE WHEN p_mercado_pago_payment_id = 'admin_manual' THEN NULL ELSE p_mercado_pago_payment_id END,
    'aprovado',
    NOW(),
    'Confirmação de pagamento via ' || COALESCE(p_origem, 'gateway')
  )
  ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING;

  -- 7.5. Atualiza dados comerciais e de gateway no pedido
  UPDATE public.pedidos
  SET 
    status_comercial = 'confirmado',
    status_operacional = CASE WHEN status_operacional = 'aguardando_producao' OR status_operacional IS NULL THEN 'aguardando_producao' ELSE status_operacional END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 7.6. Inicialização do KDS para a cozinha
  BEGIN
    PERFORM public.kds_inicializar_pedido(p_pedido_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- 7.7. Baixa física e liberação da reserva no estoque (SELECT FOR UPDATE)
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

  -- 7.8. Baixa atômica de insumos da receita (Ficha Técnica)
  PERFORM public.dar_baixa_ingredientes_pedido(p_pedido_id);

  -- 7.9. Registra receita no financeiro com proteção de idempotência estrutural
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    pedido_id,
    origem_tipo,
    origem_id,
    evento,
    observacoes
  ) VALUES (
    'receita',
    'Vendas',
    'Venda do Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
    COALESCE(p_valor, v_pedido.total),
    CURRENT_DATE,
    COALESCE(p_forma_pagamento, v_pedido.pagamento, 'pix'),
    p_pedido_id,
    'pedido_pagamento',
    p_pedido_id,
    'recebimento',
    'Confirmação via ' || COALESCE(p_origem, 'Mercado Pago') ||
      CASE 
        WHEN p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' 
        THEN ' [ID: ' || p_mercado_pago_payment_id || ']' 
        ELSE '' 
      END
  )
  ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;

  -- 7.10. Grava registro na tabela de pagamentos processados (idempotência)
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    INSERT INTO public.pagamentos_processados (
      provider_id,
      pedido_id,
      forma,
      valor
    ) VALUES (
      p_mercado_pago_payment_id,
      p_pedido_id,
      COALESCE(p_forma_pagamento, v_pedido.pagamento),
      COALESCE(p_valor, v_pedido.total)
    )
    ON CONFLICT (provider_id) DO NOTHING;
  END IF;

  -- 7.11. Registro no Histórico de Status
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'financeiro',
    v_pedido.status_financeiro,
    'pago',
    CASE WHEN p_origem ILIKE '%admin%' THEN 'admin' WHEN p_origem ILIKE '%webhook%' THEN 'webhook_mercadopago' ELSE 'sistema' END,
    jsonb_build_object('provider_payment_id', p_mercado_pago_payment_id, 'valor', COALESCE(p_valor, v_pedido.total), 'origem', p_origem)
  );

  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'comercial',
    v_pedido.status_comercial,
    'confirmado',
    CASE WHEN p_origem ILIKE '%admin%' THEN 'admin' WHEN p_origem ILIKE '%webhook%' THEN 'webhook_mercadopago' ELSE 'sistema' END,
    jsonb_build_object('motivo', 'pagamento_confirmado')
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status', 'Confirmado',
    'status_comercial', 'confirmado',
    'status_financeiro', 'pago',
    'status_operacional', 'aguardando_producao'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(bigint, text, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(bigint, text, text, numeric, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 4. OBTENÇÃO DINÂMICA DO PAINEL DE BALCÃO & RETIRADA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_balcao_retiradas(
  p_data DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_pedidos JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas a equipe autorizada pode acessar a central do balcão.', 'code', 'PERMISSION_DENIED');
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'pedido_id', p.id,
      'numero', p.id::text,
      'cliente_id', p.cliente_id_rel,
      'cliente_nome', COALESCE(c.nome, p.nome_cliente, 'Cliente Balcão'),
      'cliente_telefone', COALESCE(c.telefone, p.telefone_cliente),
      'data_entrega', p.data_entrega,
      'horario_entrega', p.hora_entrega,
      'valor_total', p.total,
      'valor_pago', COALESCE(pag.total_pago, 0),
      'saldo_devedor', GREATEST(0, p.total - COALESCE(pag.total_pago, 0)),
      'status_comercial', p.status_comercial,
      'status_operacional', p.status_operacional,
      'status_financeiro', p.status_financeiro,
      'quality_hold_ativo', EXISTS (
        SELECT 1 FROM public.producao_controles_qualidade q
        WHERE q.pedido_id = p.id
          AND q.resultado = 'REPROVADO'
          AND NOT EXISTS (
            SELECT 1 FROM public.producao_controles_qualidade q2
            WHERE q2.pedido_id = p.id AND q2.etapa = q.etapa AND q2.resultado = 'APROVADO' AND q2.id > q.id
          )
      ),
      'possui_pin_ativo', EXISTS (
        SELECT 1 FROM public.pedido_retirada_autorizacoes a
        WHERE a.pedido_id = p.id AND a.status = 'ATIVA' AND a.expira_em > NOW()
      )
    ) ORDER BY p.data_entrega ASC NULLS LAST, p.hora_entrega NULLS LAST, p.id ASC
  ) INTO v_pedidos
  FROM public.pedidos p
  LEFT JOIN public.clientes c ON c.id = p.cliente_id_rel
  LEFT JOIN (
    SELECT pedido_id, SUM(valor) AS total_pago
    FROM public.pedido_pagamentos
    WHERE status = 'aprovado'
    GROUP BY pedido_id
  ) pag ON pag.pedido_id = p.id
  WHERE COALESCE(p.modalidade_entrega, '') = 'retirada'
    AND (
      p_data IS NULL
      OR (p.data_entrega = p_data OR (p.data_entrega IS NULL AND p.created_at::date = p_data))
    )
    AND p.status_comercial <> 'cancelado'
    AND (
      p_data IS NOT NULL
      OR p.status_operacional IN ('aguardando_producao', 'em_producao', 'pronto', 'aguardando_retirada')
    );

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', p_data,
    'pedidos', COALESCE(v_pedidos, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_painel_balcao_retiradas(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_balcao_retiradas(DATE) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. BACKFILL IDEMPOTENTE PARA PEDIDOS CONFIRMADOS RECENTES
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id
    FROM public.pedidos p
    WHERE p.status_comercial = 'confirmado'
      AND p.status_operacional IN ('aguardando_producao', 'em_producao')
      AND NOT EXISTS (
        SELECT 1 FROM public.pedido_producao_kds k WHERE k.pedido_id = p.id
      )
  LOOP
    BEGIN
      PERFORM public.kds_inicializar_pedido(r.id);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;
