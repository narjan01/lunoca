-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 021: DASHBOARD GERENCIAL, DRE & INDICADORES (FRENTE F)
-- ==========================================================================
-- Objetivo:
-- Projeções analíticas server-side sobre os dados canônicos existentes:
-- 1. Separação Contábil Estrita (Invariante Central):
--    Vendas Confirmadas != Faturamento Realizado != Entrada de Caixa Líquida != Crédito Utilizado
-- 2. Não cria tabelas estáticas de métricas; cálculo sob demanda por período.
-- 3. Timezone canônico: America/Fortaleza com bounds [inicio 00:00:00, fim + 1 dia 00:00:00)
-- 4. Segregação de Privilégios (RBAC):
--    - Admin: acesso a faturamento, DRE, caixa, saldos de crédito e ranking financeiro.
--    - Operador: acesso restrito a volumes, carga produtiva e capacidade (sem chaves financeiras).
--    - Anon/Cliente: fail-closed (PERMISSION_DENIED e REVOKE nativo).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. HELPER INTERNO: RESOLUÇÃO DE JANELA TEMPORAL CANÔNICA
-- --------------------------------------------------------------------------
-- Converte p_data_inicio e p_data_fim para timestamptz fechado em [inicio 00:00, fim+1 00:00)
CREATE OR REPLACE FUNCTION public._dashboard_resolver_datas(
  p_data_inicio DATE,
  p_data_fim DATE,
  OUT v_inicio_ts TIMESTAMPTZ,
  OUT v_fim_ts TIMESTAMPTZ,
  OUT v_inicio_date DATE,
  OUT v_fim_date DATE
)
AS $$
BEGIN
  v_inicio_date := COALESCE(p_data_inicio, (date_trunc('month', (NOW() AT TIME ZONE 'America/Fortaleza')::DATE))::DATE);
  v_fim_date := COALESCE(p_data_fim, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);

  IF v_fim_date < v_inicio_date THEN
    RAISE EXCEPTION 'Data final (%) não pode ser anterior à data inicial (%).', v_fim_date, v_inicio_date
      USING ERRCODE = '22023';
  END IF;

  -- Limite preventivo de 366 dias por consulta
  IF (v_fim_date - v_inicio_date) > 366 THEN
    v_inicio_date := (v_fim_date - INTERVAL '366 days')::DATE;
  END IF;

  v_inicio_ts := (v_inicio_date::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE 'America/Fortaleza';
  v_fim_ts := ((v_fim_date + 1)::TEXT || ' 00:00:00')::TIMESTAMP AT TIME ZONE 'America/Fortaleza';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._dashboard_resolver_datas(DATE, DATE) FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- 2. RPC: OBTER_INDICADORES_VENDAS_ADMIN
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_indicadores_vendas_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio_ts TIMESTAMPTZ;
  v_fim_ts TIMESTAMPTZ;
  v_inicio_date DATE;
  v_fim_date DATE;

  v_vendas_conf_qtd BIGINT := 0;
  v_vendas_conf_val NUMERIC(10,2) := 0.00;

  v_ped_conc_qtd BIGINT := 0;
  v_fat_realizado NUMERIC(10,2) := 0.00;
  v_ticket_max NUMERIC(10,2) := 0.00;
  v_ticket_medio NUMERIC(10,2) := 0.00;

  v_ped_canc_qtd BIGINT := 0;
  v_taxa_canc NUMERIC(5,2) := 0.00;

  v_entrega_qtd BIGINT := 0;
  v_retirada_qtd BIGINT := 0;

  v_orc_emit_qtd BIGINT := 0;
  v_orc_conv_qtd BIGINT := 0;
  v_taxa_conv NUMERIC(5,2) := 0.00;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem acessar os indicadores de vendas.'
    );
  END IF;

  SELECT * INTO v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
  FROM public._dashboard_resolver_datas(p_data_inicio, p_data_fim);

  -- 1. Vendas Confirmadas no período (primeira transição para 'confirmado' na janela e não cancelados)
  SELECT
    COALESCE(COUNT(DISTINCT p.id), 0),
    COALESCE(SUM(p.total), 0.00)
  INTO v_vendas_conf_qtd, v_vendas_conf_val
  FROM public.pedidos p
  JOIN (
    SELECT pedido_id, MIN(created_at) AS primeiro_conf_at
    FROM public.pedido_status_historico
    WHERE dimensao = 'comercial' AND status_novo = 'confirmado'
    GROUP BY pedido_id
  ) conf ON conf.pedido_id = p.id
  WHERE conf.primeiro_conf_at >= v_inicio_ts AND conf.primeiro_conf_at < v_fim_ts
    AND p.status_comercial <> 'cancelado';

  -- 2. Faturamento Realizado (transição comercial para 'concluido' dentro do período)
  SELECT
    COALESCE(COUNT(DISTINCT p.id), 0),
    COALESCE(SUM(p.total), 0.00),
    COALESCE(MAX(p.total), 0.00)
  INTO v_ped_conc_qtd, v_fat_realizado, v_ticket_max
  FROM public.pedidos p
  JOIN (
    SELECT pedido_id, MIN(created_at) AS primeiro_conc_at
    FROM public.pedido_status_historico
    WHERE dimensao = 'comercial' AND status_novo = 'concluido'
    GROUP BY pedido_id
  ) conc ON conc.pedido_id = p.id
  WHERE conc.primeiro_conc_at >= v_inicio_ts AND conc.primeiro_conc_at < v_fim_ts;

  IF v_ped_conc_qtd > 0 THEN
    v_ticket_medio := ROUND(v_fat_realizado / v_ped_conc_qtd, 2);
  END IF;

  -- 3. Pedidos Cancelados no período
  SELECT COALESCE(COUNT(DISTINCT h.pedido_id), 0)
  INTO v_ped_canc_qtd
  FROM public.pedido_status_historico h
  WHERE h.dimensao = 'comercial' AND h.status_novo = 'cancelado'
    AND h.created_at >= v_inicio_ts AND h.created_at < v_fim_ts;

  IF (v_vendas_conf_qtd + v_ped_canc_qtd) > 0 THEN
    v_taxa_canc := ROUND((v_ped_canc_qtd * 100.0) / (v_vendas_conf_qtd + v_ped_canc_qtd), 2);
  END IF;

  -- 4. Pedidos por Modalidade (entrega vs retirada) dos concluídos no período
  SELECT
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(p.modalidade_entrega, 'retirada') = 'entrega'), 0),
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(p.modalidade_entrega, 'retirada') = 'retirada'), 0)
  INTO v_entrega_qtd, v_retirada_qtd
  FROM public.pedidos p
  JOIN (
    SELECT pedido_id, MIN(created_at) AS conc_at
    FROM public.pedido_status_historico
    WHERE dimensao = 'comercial' AND status_novo = 'concluido'
    GROUP BY pedido_id
  ) c ON c.pedido_id = p.id
  WHERE c.conc_at >= v_inicio_ts AND c.conc_at < v_fim_ts;

  -- 5. Orçamentos Emitidos e Convertidos
  SELECT COALESCE(COUNT(*), 0) INTO v_orc_emit_qtd
  FROM public.orcamentos
  WHERE created_at >= v_inicio_ts AND created_at < v_fim_ts;

  SELECT COALESCE(COUNT(*), 0) INTO v_orc_conv_qtd
  FROM public.orcamentos
  WHERE status = 'convertido' AND convertido_em >= v_inicio_ts AND convertido_em < v_fim_ts;

  IF v_orc_emit_qtd > 0 THEN
    v_taxa_conv := ROUND((v_orc_conv_qtd * 100.0) / v_orc_emit_qtd, 2);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio_date,
      'data_fim', v_fim_date,
      'timezone', 'America/Fortaleza'
    ),
    'vendas_confirmadas_quantidade', v_vendas_conf_qtd,
    'vendas_confirmadas_valor', v_vendas_conf_val,
    'pedidos_concluidos_quantidade', v_ped_conc_qtd,
    'faturamento_realizado', v_fat_realizado,
    'ticket_medio_realizado', v_ticket_medio,
    'ticket_maximo', v_ticket_max,
    'pedidos_cancelados', v_ped_canc_qtd,
    'taxa_cancelamento', v_taxa_canc,
    'entrega_quantidade', v_entrega_qtd,
    'retirada_quantidade', v_retirada_qtd,
    'orcamentos_emitidos', v_orc_emit_qtd,
    'orcamentos_convertidos', v_orc_conv_qtd,
    'taxa_conversao', v_taxa_conv
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_indicadores_vendas_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_indicadores_vendas_admin(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. RPC: OBTER_INDICADORES_FINANCEIROS_ADMIN
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_indicadores_financeiros_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio_ts TIMESTAMPTZ;
  v_fim_ts TIMESTAMPTZ;
  v_inicio_date DATE;
  v_fim_date DATE;

  v_rec_pix NUMERIC(10,2) := 0.00;
  v_rec_cartao NUMERIC(10,2) := 0.00;
  v_rec_dinheiro NUMERIC(10,2) := 0.00;
  v_rec_transf NUMERIC(10,2) := 0.00;
  v_rec_outro NUMERIC(10,2) := 0.00;
  v_entrada_bruta NUMERIC(10,2) := 0.00;

  v_estornos NUMERIC(10,2) := 0.00;
  v_entrada_liquida NUMERIC(10,2) := 0.00;

  v_credito_utilizado NUMERIC(10,2) := 0.00;
  v_saldo_cred_fim NUMERIC(10,2) := 0.00;
  v_saldo_cred_atual NUMERIC(10,2) := 0.00;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem acessar os indicadores financeiros.'
    );
  END IF;

  SELECT * INTO v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
  FROM public._dashboard_resolver_datas(p_data_inicio, p_data_fim);

  -- 1. Entrada de Caixa Bruta por meio de pagamento externo recebido na janela
  -- Considera pagamentos aprovados em pedido_pagamentos (excluindo crédito que não é entrada externa)
  SELECT
    COALESCE(SUM(valor) FILTER (WHERE metodo = 'pix'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE metodo = 'cartao'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE metodo = 'dinheiro'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE metodo = 'transferencia'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE metodo NOT IN ('pix', 'cartao', 'dinheiro', 'transferencia')), 0.00),
    COALESCE(SUM(valor), 0.00)
  INTO v_rec_pix, v_rec_cartao, v_rec_dinheiro, v_rec_transf, v_rec_outro, v_entrada_bruta
  FROM public.pedido_pagamentos
  WHERE status IN ('aprovado', 'estornado')
    AND pago_em >= v_inicio_ts AND pago_em < v_fim_ts;

  -- 2. Estornos efetivados na janela (registrados no DRE ou pagamentos estornados no período)
  SELECT COALESCE(SUM(valor), 0.00)
  INTO v_estornos
  FROM public.financeiro_lancamentos
  WHERE tipo = 'despesa' AND categoria = 'Estornos'
    AND created_at >= v_inicio_ts AND created_at < v_fim_ts;

  v_entrada_liquida := GREATEST(0.00, v_entrada_bruta - v_estornos);

  -- 3. Crédito do cliente utilizado no período (livro-razão da Frente C)
  SELECT COALESCE(SUM(valor), 0.00)
  INTO v_credito_utilizado
  FROM public.cliente_credito_movimentacoes
  WHERE tipo = 'debito' AND origem = 'uso_pedido'
    AND created_at >= v_inicio_ts AND created_at < v_fim_ts;

  -- 4. Saldo de créditos histórico (reconstruído até o fim do período)
  SELECT COALESCE(SUM(CASE WHEN tipo = 'credito' THEN valor ELSE -valor END), 0.00)
  INTO v_saldo_cred_fim
  FROM public.cliente_credito_movimentacoes
  WHERE created_at < v_fim_ts;

  -- 5. Saldo de créditos atual na carteira consolidada
  SELECT COALESCE(SUM(saldo), 0.00)
  INTO v_saldo_cred_atual
  FROM public.cliente_creditos;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio_date,
      'data_fim', v_fim_date,
      'timezone', 'America/Fortaleza'
    ),
    'entrada_caixa_bruta', v_entrada_bruta,
    'estornos_caixa', v_estornos,
    'entrada_caixa_liquida', v_entrada_liquida,
    'recebido_pix', v_rec_pix,
    'recebido_cartao', v_rec_cartao,
    'recebido_dinheiro', v_rec_dinheiro,
    'recebido_transferencia', v_rec_transf,
    'recebido_outro', v_rec_outro,
    'credito_cliente_utilizado', v_credito_utilizado,
    'saldo_creditos_fim_periodo', v_saldo_cred_fim,
    'saldo_creditos_atual', v_saldo_cred_atual
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_indicadores_financeiros_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_indicadores_financeiros_admin(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. RPC: OBTER_INDICADORES_PRODUCAO (ADMIN & OPERADOR)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_indicadores_producao(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio_ts TIMESTAMPTZ;
  v_fim_ts TIMESTAMPTZ;
  v_inicio_date DATE;
  v_fim_date DATE;

  v_pontos_total NUMERIC(10,2) := 0.00;
  v_cap_total NUMERIC(10,2) := 0.00;
  v_ocup_perc NUMERIC(5,2) := 0.00;

  v_dias_normais INT := 0;
  v_dias_prox_lim INT := 0;
  v_dias_lotados INT := 0;
  v_dias_excedidos INT := 0;
  v_dias_bloqueados INT := 0;
  v_total_dias INT := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas a equipe autorizada pode visualizar indicadores de produção.'
    );
  END IF;

  SELECT * INTO v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
  FROM public._dashboard_resolver_datas(p_data_inicio, p_data_fim);

  -- Itera dia a dia na série temporal da janela
  SELECT
    COALESCE(SUM(t.pts_dia), 0.00),
    COALESCE(SUM(t.cap_dia), 0.00),
    COALESCE(COUNT(*) FILTER (WHERE t.status_cap = 'normal'), 0),
    COALESCE(COUNT(*) FILTER (WHERE t.status_cap = 'proximo_limite'), 0),
    COALESCE(COUNT(*) FILTER (WHERE t.status_cap = 'lotado'), 0),
    COALESCE(COUNT(*) FILTER (WHERE t.status_cap = 'excedido'), 0),
    COALESCE(COUNT(*) FILTER (WHERE t.bloqueado = true), 0),
    COALESCE(COUNT(*), 0)
  INTO
    v_pontos_total,
    v_cap_total,
    v_dias_normais,
    v_dias_prox_lim,
    v_dias_lotados,
    v_dias_excedidos,
    v_dias_bloqueados,
    v_total_dias
  FROM (
    SELECT
      d.dia::DATE AS dt,
      public.pontos_ocupados_data(d.dia::DATE) AS pts_dia,
      COALESCE(cp.capacidade_maxima_pontos, 30.00) AS cap_dia,
      COALESCE(cp.bloqueado, false) AS bloqueado,
      CASE
        WHEN COALESCE(cp.bloqueado, false) THEN 'bloqueado'
        WHEN public.pontos_ocupados_data(d.dia::DATE) > COALESCE(cp.capacidade_maxima_pontos, 30.00) THEN 'excedido'
        WHEN public.pontos_ocupados_data(d.dia::DATE) >= COALESCE(cp.capacidade_maxima_pontos, 30.00) THEN 'lotado'
        WHEN public.pontos_ocupados_data(d.dia::DATE) >= (COALESCE(cp.capacidade_maxima_pontos, 30.00) * 0.80) THEN 'proximo_limite'
        ELSE 'normal'
      END AS status_cap
    FROM generate_series(v_inicio_date::TIMESTAMP, v_fim_date::TIMESTAMP, '1 day'::INTERVAL) d(dia)
    LEFT JOIN public.capacidade_producao cp ON cp.data = d.dia::DATE
  ) t;

  IF v_cap_total > 0 THEN
    v_ocup_perc := ROUND((v_pontos_total * 100.0) / v_cap_total, 2);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio_date,
      'data_fim', v_fim_date,
      'total_dias', v_total_dias
    ),
    'pontos_producao', v_pontos_total,
    'capacidade_total', v_cap_total,
    'ocupacao_percentual', v_ocup_perc,
    'dias_normais', v_dias_normais,
    'dias_proximo_limite', v_dias_prox_lim,
    'dias_lotados', v_dias_lotados,
    'dias_excedidos', v_dias_excedidos,
    'dias_bloqueados', v_dias_bloqueados
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_indicadores_producao(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_indicadores_producao(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. RPC: OBTER_INDICADORES_CLIENTES_ADMIN
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_indicadores_clientes_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio_ts TIMESTAMPTZ;
  v_fim_ts TIMESTAMPTZ;
  v_inicio_date DATE;
  v_fim_date DATE;

  v_clientes_ativos BIGINT := 0;
  v_clientes_novos BIGINT := 0;
  v_clientes_recorrentes BIGINT := 0;
  v_taxa_recorrencia NUMERIC(5,2) := 0.00;
  v_top_clientes JSONB := '[]'::jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem acessar os indicadores de clientes.'
    );
  END IF;

  SELECT * INTO v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
  FROM public._dashboard_resolver_datas(p_data_inicio, p_data_fim);

  -- 1. Clientes Ativos (clientes vinculados a pedidos concluídos ou confirmados no período)
  SELECT COUNT(DISTINCT p.cliente_id_rel)
  INTO v_clientes_ativos
  FROM public.pedidos p
  JOIN public.pedido_status_historico h ON h.pedido_id = p.id
  WHERE p.cliente_id_rel IS NOT NULL
    AND h.dimensao = 'comercial' AND h.status_novo IN ('confirmado', 'concluido')
    AND h.created_at >= v_inicio_ts AND h.created_at < v_fim_ts;

  -- 2. Clientes Novos (primeiro pedido concluído na vida ocorreu exatamente nesta janela)
  SELECT COUNT(DISTINCT c_primeiro.cliente_id_rel)
  INTO v_clientes_novos
  FROM (
    SELECT p.cliente_id_rel, MIN(h.created_at) AS primeiro_concluido_at
    FROM public.pedidos p
    JOIN public.pedido_status_historico h ON h.pedido_id = p.id
    WHERE p.cliente_id_rel IS NOT NULL
      AND h.dimensao = 'comercial' AND h.status_novo = 'concluido'
    GROUP BY p.cliente_id_rel
  ) c_primeiro
  WHERE c_primeiro.primeiro_concluido_at >= v_inicio_ts AND c_primeiro.primeiro_concluido_at < v_fim_ts;

  -- 3. Clientes Recorrentes (compraram no período e já possuíam pedido concluído anterior)
  SELECT COUNT(DISTINCT p.cliente_id_rel)
  INTO v_clientes_recorrentes
  FROM public.pedidos p
  JOIN public.pedido_status_historico h ON h.pedido_id = p.id
  WHERE p.cliente_id_rel IS NOT NULL
    AND h.dimensao = 'comercial' AND h.status_novo = 'concluido'
    AND h.created_at >= v_inicio_ts AND h.created_at < v_fim_ts
    AND EXISTS (
      SELECT 1 FROM public.pedido_status_historico h_ant
      JOIN public.pedidos p_ant ON p_ant.id = h_ant.pedido_id
      WHERE p_ant.cliente_id_rel = p.cliente_id_rel
        AND h_ant.dimensao = 'comercial' AND h_ant.status_novo = 'concluido'
        AND h_ant.created_at < v_inicio_ts
    );

  IF v_clientes_ativos > 0 THEN
    v_taxa_recorrencia := ROUND((v_clientes_recorrentes * 100.0) / v_clientes_ativos, 2);
  END IF;

  -- 4. Top Clientes por valor_historico_compras (somente pedidos concluídos)
  SELECT COALESCE(jsonb_agg(top_row), '[]'::jsonb)
  INTO v_top_clientes
  FROM (
    SELECT
      c.id AS cliente_id,
      c.nome,
      COUNT(DISTINCT p.id) AS pedidos,
      COALESCE(SUM(p.total), 0.00) AS valor_historico_compras
    FROM public.clientes c
    JOIN public.pedidos p ON p.cliente_id_rel = c.id
    JOIN public.pedido_status_historico h ON h.pedido_id = p.id
    WHERE h.dimensao = 'comercial' AND h.status_novo = 'concluido'
      AND h.created_at < v_fim_ts
    GROUP BY c.id, c.nome
    ORDER BY valor_historico_compras DESC, pedidos DESC
    LIMIT 10
  ) top_row;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio_date,
      'data_fim', v_fim_date
    ),
    'clientes_ativos', v_clientes_ativos,
    'clientes_novos', v_clientes_novos,
    'clientes_recorrentes', v_clientes_recorrentes,
    'taxa_recorrencia', v_taxa_recorrencia,
    'top_clientes', v_top_clientes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_indicadores_clientes_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_indicadores_clientes_admin(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. RPC: OBTER_DASHBOARD_OPERACIONAL (ADMIN & OPERADOR - SEM CAMPOS FINANCEIROS)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_dashboard_operacional(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio_ts TIMESTAMPTZ;
  v_fim_ts TIMESTAMPTZ;
  v_inicio_date DATE;
  v_fim_date DATE;

  v_ind_prod JSONB;
  v_vendas_qtd BIGINT := 0;
  v_concluidos_qtd BIGINT := 0;
  v_cancelados_qtd BIGINT := 0;
  v_em_producao_qtd BIGINT := 0;
  v_aguardando_qtd BIGINT := 0;
  v_prontos_qtd BIGINT := 0;

  v_entrega_qtd BIGINT := 0;
  v_retirada_qtd BIGINT := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas a equipe autorizada pode visualizar o dashboard operacional.'
    );
  END IF;

  SELECT * INTO v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
  FROM public._dashboard_resolver_datas(p_data_inicio, p_data_fim);

  -- Indicadores de capacidade da cozinha
  v_ind_prod := public.obter_indicadores_producao(v_inicio_date, v_fim_date);

  -- Volumes de pedidos com entrega na janela
  SELECT
    COALESCE(COUNT(*), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_comercial = 'concluido'), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_comercial = 'cancelado'), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_operacional = 'em_producao'), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_operacional = 'aguardando_producao'), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_operacional = 'pronto'), 0),
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(modalidade_entrega, 'retirada') = 'entrega'), 0),
    COALESCE(COUNT(*) FILTER (WHERE COALESCE(modalidade_entrega, 'retirada') = 'retirada'), 0)
  INTO
    v_vendas_qtd,
    v_concluidos_qtd,
    v_cancelados_qtd,
    v_em_producao_qtd,
    v_aguardando_qtd,
    v_prontos_qtd,
    v_entrega_qtd,
    v_retirada_qtd
  FROM public.pedidos
  WHERE data_entrega BETWEEN v_inicio_date AND v_fim_date;

  -- PAYLOAD SANITIZADO: sem faturamento, sem caixa, sem crédito, sem DRE, sem valores R$
  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio_date,
      'data_fim', v_fim_date
    ),
    'volumes_pedidos', jsonb_build_object(
      'total_agendados', v_vendas_qtd,
      'concluidos', v_concluidos_qtd,
      'cancelados', v_cancelados_qtd,
      'aguardando_producao', v_aguardando_qtd,
      'em_producao', v_em_producao_qtd,
      'prontos_expedicao', v_prontos_qtd,
      'entrega_quantidade', v_entrega_qtd,
      'retirada_quantidade', v_retirada_qtd
    ),
    'producao', v_ind_prod
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_dashboard_operacional(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_dashboard_operacional(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. RPC: OBTER_DASHBOARD_RESUMO_ADMIN (CONSOLIDADO EXECUTIVO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_dashboard_resumo_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_vendas JSONB;
  v_financeiro JSONB;
  v_producao JSONB;
  v_clientes JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem visualizar o resumo executivo do dashboard.'
    );
  END IF;

  v_vendas := public.obter_indicadores_vendas_admin(p_data_inicio, p_data_fim);
  v_financeiro := public.obter_indicadores_financeiros_admin(p_data_inicio, p_data_fim);
  v_producao := public.obter_indicadores_producao(p_data_inicio, p_data_fim);
  v_clientes := public.obter_indicadores_clientes_admin(p_data_inicio, p_data_fim);

  RETURN jsonb_build_object(
    'success', true,
    'vendas', v_vendas,
    'financeiro', v_financeiro,
    'producao', v_producao,
    'clientes', v_clientes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_dashboard_resumo_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_dashboard_resumo_admin(DATE, DATE) TO authenticated, service_role;
