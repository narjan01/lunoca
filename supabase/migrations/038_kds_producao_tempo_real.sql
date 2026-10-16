-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 038 (FORWARD-ONLY)
-- FRENTE 038: KDS EM TEMPO REAL / PRODUÇÃO DE COZINHA (BANCADA & PRAÇAS)
-- ==============================================================================
-- Premissas Arquiteturais Inegociáveis:
-- 1. Subordinação Estrita ao pedidos.status_operacional Canônico:
--    ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'cancelado').
-- 2. Desacoplamento Financeiro: Ingressam no KDS apenas pedidos cujo status_operacional
--    esteja em 'aguardando_producao' (ou 'em_producao').
-- 3. Pedido != Unidade de Produção: Cada item possui sua própria rota produtiva.
-- 4. Snapshot Congelado da Rota (pedido_item_kds_etapas): A rota inteira do item é
--    congelada no momento da entrada no KDS.
-- 5. Autoria Estrita Server-Side: auth.uid() obrigatório, sem aceitar p_operador_id vindo do cliente.
-- 6. Cancelamento Seguro: Cancelamento encerra itens ativos sem apagar histórico e sem marcar pronto.
-- 7. Auditoria Append-Only: pedido_kds_estagio_historico com bloqueio 42501 para UPDATE/DELETE.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CADASTRO DE ROTAS POR PRODUTO (CONFIGURAÇÃO PARA FUTUROS CICLOS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_etapas_kds (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL CHECK (ordem > 0),
  praca VARCHAR(30) NOT NULL CHECK (praca IN ('MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM')),
  sla_minutos INTEGER NOT NULL CHECK (sla_minutos > 0),
  obrigatoria BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_produto_etapa_ordem UNIQUE (produto_id, ordem),
  CONSTRAINT uq_produto_etapa_praca UNIQUE (produto_id, praca)
);

CREATE INDEX IF NOT EXISTS idx_produto_etapas_kds_prod ON public.produto_etapas_kds(produto_id);

-- ------------------------------------------------------------------------------
-- 2. CABEÇALHO AGREGADO DE PRODUÇÃO DO PEDIDO (KDS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_producao_kds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id BIGINT NOT NULL UNIQUE REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  estagio_agregado VARCHAR(30) NOT NULL DEFAULT 'AGUARDANDO'
    CHECK (estagio_agregado IN ('AGUARDANDO', 'MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM', 'PRONTO')),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  iniciado_em TIMESTAMPTZ,
  concluido_em TIMESTAMPTZ,
  encerrado_em TIMESTAMPTZ,
  motivo_encerramento VARCHAR(50),
  sla_total_snapshot INTEGER NOT NULL CHECK (sla_total_snapshot > 0),
  prioridade_urgencia BOOLEAN NOT NULL DEFAULT FALSE,
  observacoes_cozinha TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kds_pedido_ativo ON public.pedido_producao_kds (ativo, estagio_agregado);
CREATE INDEX IF NOT EXISTS idx_kds_pedido_fk ON public.pedido_producao_kds (pedido_id);

-- ------------------------------------------------------------------------------
-- 3. UNIDADE EFETIVA DE PRODUÇÃO (ITEM NO KDS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_item_producao_kds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kds_id UUID NOT NULL REFERENCES public.pedido_producao_kds(id) ON DELETE CASCADE,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE RESTRICT,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE SET NULL,
  produto_nome_snapshot TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  ordem_etapa_atual INTEGER NOT NULL DEFAULT 0,
  ordem_etapa_max INTEGER NOT NULL CHECK (ordem_etapa_max > 0),
  estagio_atual VARCHAR(30) NOT NULL DEFAULT 'AGUARDANDO'
    CHECK (estagio_atual IN ('AGUARDANDO', 'MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM', 'PRONTO')),
  praca_atual VARCHAR(30)
    CHECK (praca_atual IS NULL OR praca_atual IN ('MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM')),
  proxima_etapa VARCHAR(30),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  tempo_etapa_iniciado_em TIMESTAMPTZ,
  encerrado_em TIMESTAMPTZ,
  motivo_encerramento VARCHAR(50),
  sla_etapa_snapshot INTEGER NOT NULL CHECK (sla_etapa_snapshot > 0),
  sla_total_snapshot INTEGER NOT NULL CHECK (sla_total_snapshot > 0),
  operador_id UUID,
  observacoes_item TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kds_item UNIQUE (kds_id, pedido_item_id)
);

CREATE INDEX IF NOT EXISTS idx_kds_item_ativo_praca ON public.pedido_item_producao_kds (ativo, praca_atual, estagio_atual);
CREATE INDEX IF NOT EXISTS idx_kds_item_pedido ON public.pedido_item_producao_kds (pedido_id);

-- ------------------------------------------------------------------------------
-- 4. SNAPSHOT CONGELADO DA ROTA DO ITEM (IMUTÁVEL APÓS CRIAÇÃO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_item_kds_etapas (
  id BIGSERIAL PRIMARY KEY,
  kds_item_id UUID NOT NULL REFERENCES public.pedido_item_producao_kds(id) ON DELETE CASCADE,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE RESTRICT,
  ordem INTEGER NOT NULL CHECK (ordem > 0),
  praca VARCHAR(30) NOT NULL CHECK (praca IN ('MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM')),
  sla_minutos_snapshot INTEGER NOT NULL CHECK (sla_minutos_snapshot > 0),
  obrigatoria_snapshot BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kds_item_etapa UNIQUE (kds_item_id, ordem),
  CONSTRAINT uq_kds_item_praca UNIQUE (kds_item_id, praca)
);

CREATE INDEX IF NOT EXISTS idx_kds_item_etapas_lookup ON public.pedido_item_kds_etapas (kds_item_id, ordem);

-- ------------------------------------------------------------------------------
-- 5. AUDITORIA APPEND-ONLY DE TRANSIÇÕES DO KDS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_kds_estagio_historico (
  id BIGSERIAL PRIMARY KEY,
  kds_id UUID NOT NULL REFERENCES public.pedido_producao_kds(id) ON DELETE RESTRICT,
  kds_item_id UUID NOT NULL REFERENCES public.pedido_item_producao_kds(id) ON DELETE RESTRICT,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE RESTRICT,
  estagio_origem VARCHAR(30) NOT NULL,
  estagio_destino VARCHAR(30) NOT NULL,
  praca VARCHAR(30),
  tempo_segundos INTEGER NOT NULL DEFAULT 0,
  operador_id UUID,
  transicionado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kds_hist_pedido ON public.pedido_kds_estagio_historico(pedido_id);
CREATE INDEX IF NOT EXISTS idx_kds_hist_item ON public.pedido_kds_estagio_historico(kds_item_id);

CREATE OR REPLACE FUNCTION public._trg_bloquear_mutacao_kds_historico()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'VIOLACAO_SEGURANCA: O histórico de transições do KDS é estritamente append-only e imutável.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_kds_historico ON public.pedido_kds_estagio_historico;
CREATE TRIGGER trg_bloquear_mutacao_kds_historico
  BEFORE UPDATE OR DELETE ON public.pedido_kds_estagio_historico
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_bloquear_mutacao_kds_historico();

-- ------------------------------------------------------------------------------
-- 6. PUBLICAR TABELAS KDS NO SUPABASE REALTIME
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pedido_producao_kds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.pedido_producao_kds;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pedido_item_producao_kds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.pedido_item_producao_kds;
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------------------------
ALTER TABLE public.produto_etapas_kds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_producao_kds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_item_producao_kds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_item_kds_etapas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_kds_estagio_historico ENABLE ROW LEVEL SECURITY;

-- Políticas produto_etapas_kds
DROP POLICY IF EXISTS "produto_etapas_kds_select" ON public.produto_etapas_kds;
CREATE POLICY "produto_etapas_kds_select" ON public.produto_etapas_kds
  FOR SELECT TO authenticated, service_role
  USING (true);

DROP POLICY IF EXISTS "produto_etapas_kds_admin_all" ON public.produto_etapas_kds;
CREATE POLICY "produto_etapas_kds_admin_all" ON public.produto_etapas_kds
  FOR ALL TO authenticated, service_role
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Políticas pedido_producao_kds
DROP POLICY IF EXISTS "pedido_producao_kds_select" ON public.pedido_producao_kds;
CREATE POLICY "pedido_producao_kds_select" ON public.pedido_producao_kds
  FOR SELECT TO authenticated, service_role
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "pedido_producao_kds_service" ON public.pedido_producao_kds;
CREATE POLICY "pedido_producao_kds_service" ON public.pedido_producao_kds
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Políticas pedido_item_producao_kds
DROP POLICY IF EXISTS "pedido_item_producao_kds_select" ON public.pedido_item_producao_kds;
CREATE POLICY "pedido_item_producao_kds_select" ON public.pedido_item_producao_kds
  FOR SELECT TO authenticated, service_role
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "pedido_item_producao_kds_service" ON public.pedido_item_producao_kds;
CREATE POLICY "pedido_item_producao_kds_service" ON public.pedido_item_producao_kds
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Políticas pedido_item_kds_etapas
DROP POLICY IF EXISTS "pedido_item_kds_etapas_select" ON public.pedido_item_kds_etapas;
CREATE POLICY "pedido_item_kds_etapas_select" ON public.pedido_item_kds_etapas
  FOR SELECT TO authenticated, service_role
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "pedido_item_kds_etapas_service" ON public.pedido_item_kds_etapas;
CREATE POLICY "pedido_item_kds_etapas_service" ON public.pedido_item_kds_etapas
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Políticas pedido_kds_estagio_historico
DROP POLICY IF EXISTS "pedido_kds_estagio_historico_select" ON public.pedido_kds_estagio_historico;
CREATE POLICY "pedido_kds_estagio_historico_select" ON public.pedido_kds_estagio_historico
  FOR SELECT TO authenticated, service_role
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "pedido_kds_estagio_historico_insert" ON public.pedido_kds_estagio_historico;
CREATE POLICY "pedido_kds_estagio_historico_insert" ON public.pedido_kds_estagio_historico
  FOR INSERT TO authenticated, service_role
  WITH CHECK (public.is_admin_or_operator());

-- ------------------------------------------------------------------------------
-- 8. RPC: INICIALIZAR PEDIDO NO KDS (USO INTERNO / TRIGGER)
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
      -- Se o produto existe mas não tem rota cadastrada: Fail-Closed P0001
      RAISE EXCEPTION 'KDS_ROUTE_NOT_CONFIGURED: O produto % (ID %) não possui rota de etapas cadastrada no KDS.',
        v_item.produto_nome_snapshot, v_item.produto_id
        USING ERRCODE = 'P0001';
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
    observacoes_cozinha
  ) VALUES (
    p_pedido_id,
    'AGUARDANDO',
    TRUE,
    GREATEST(1, v_sla_pedido_total),
    FALSE,
    v_pedido.observacoes_internas
  ) RETURNING id INTO v_kds_id;

  -- 4. Criar unidades de produção dos itens e congelar o snapshot de rota
  FOR v_item IN
    SELECT pi.id AS pedido_item_id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade
    FROM public.pedido_itens pi
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    SELECT COUNT(*), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    SELECT ordem, praca, sla_minutos
    INTO v_primeira_etapa
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id AND ordem = 1;

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
      sla_total_snapshot
    ) VALUES (
      v_kds_id,
      p_pedido_id,
      v_item.pedido_item_id,
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
      v_sla_item_total
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
      v_item.pedido_item_id,
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

-- Revogação estrita de inicialização para clientes e anônimos
REVOKE ALL ON FUNCTION public.kds_inicializar_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kds_inicializar_pedido(BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC: AVANÇAR ITEM NO KDS (AUTORIA SERVER-SIDE VIA auth.uid() & FOR UPDATE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_avancar_item(
  p_kds_item_id UUID,
  p_proximo_estagio VARCHAR
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_item RECORD;
  v_pedido RECORD;
  v_kds RECORD;
  v_proxima_etapa_snap RECORD;
  v_nova_proxima RECORD;
  v_tempo_segundos INT := 0;
  v_todos_prontos BOOLEAN := FALSE;
  v_primeiro_avanco BOOLEAN := FALSE;
  v_estagio_agregado_novo VARCHAR(30);
  v_min_ordem INT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas a equipe de cozinha pode operar o KDS.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_proximo_estagio IS NULL OR btrim(p_proximo_estagio) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Próximo estágio é obrigatório.', 'code', 'STAGE_REQUIRED');
  END IF;

  -- 1. Trava atômica no item e no cabeçalho KDS
  SELECT * INTO v_item
  FROM public.pedido_item_producao_kds
  WHERE id = p_kds_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item de produção KDS não encontrado.', 'code', 'ITEM_NOT_FOUND');
  END IF;

  IF NOT v_item.ativo THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este item do KDS já foi encerrado ou cancelado.', 'code', 'ITEM_INACTIVE');
  END IF;

  -- 2. Trava do pedido canônico
  SELECT id, status_operacional INTO v_pedido
  FROM public.pedidos
  WHERE id = v_item.pedido_id
  FOR UPDATE;

  IF v_pedido.status_operacional NOT IN ('aguardando_producao', 'em_producao') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operação bloqueada: o pedido #' || v_pedido.id || ' encontra-se em status ' || v_pedido.status_operacional,
      'code', 'ORDER_STATUS_INVALID'
    );
  END IF;

  SELECT * INTO v_kds
  FROM public.pedido_producao_kds
  WHERE id = v_item.kds_id
  FOR UPDATE;

  -- 3. Validação estrita contra o snapshot congelado do item (pedido_item_kds_etapas)
  IF upper(p_proximo_estagio) = 'PRONTO' THEN
    -- Só pode transicionar para PRONTO se já completou a etapa máxima da rota
    IF v_item.ordem_etapa_atual <> v_item.ordem_etapa_max THEN
      RAISE EXCEPTION 'KDS_ILLEGAL_STAGE_JUMP: O item ainda possui etapas pendentes antes de ser concluído.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Procura a próxima etapa no snapshot congelado
    SELECT * INTO v_proxima_etapa_snap
    FROM public.pedido_item_kds_etapas
    WHERE kds_item_id = p_kds_item_id
      AND ordem = v_item.ordem_etapa_atual + 1;

    IF NOT FOUND OR v_proxima_etapa_snap.praca <> upper(p_proximo_estagio) THEN
      RAISE EXCEPTION 'KDS_ILLEGAL_STAGE_JUMP: Estágio % não corresponde à próxima etapa da rota do produto.',
        p_proximo_estagio
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4. Cálculo de tempo transcorrido
  IF v_item.tempo_etapa_iniciado_em IS NOT NULL THEN
    v_tempo_segundos := GREATEST(0, EXTRACT(EPOCH FROM (NOW() - v_item.tempo_etapa_iniciado_em))::INTEGER);
  END IF;

  -- 5. Gravação de auditoria append-only
  INSERT INTO public.pedido_kds_estagio_historico (
    kds_id,
    kds_item_id,
    pedido_id,
    pedido_item_id,
    estagio_origem,
    estagio_destino,
    praca,
    tempo_segundos,
    operador_id,
    transicionado_em
  ) VALUES (
    v_item.kds_id,
    v_item.id,
    v_item.pedido_id,
    v_item.pedido_item_id,
    v_item.estagio_atual,
    upper(p_proximo_estagio),
    CASE WHEN upper(p_proximo_estagio) = 'PRONTO' THEN NULL ELSE upper(p_proximo_estagio) END,
    v_tempo_segundos,
    v_caller_id,
    NOW()
  );

  -- 6. Atualização do item de produção
  IF upper(p_proximo_estagio) = 'PRONTO' THEN
    UPDATE public.pedido_item_producao_kds
    SET estagio_atual = 'PRONTO',
        praca_atual = NULL,
        proxima_etapa = NULL,
        operador_id = v_caller_id,
        encerrado_em = NOW(),
        motivo_encerramento = 'CONCLUIDO',
        updated_at = NOW()
    WHERE id = p_kds_item_id;
  ELSE
    -- Buscar se há outra etapa seguinte além desta
    SELECT praca, sla_minutos_snapshot INTO v_nova_proxima
    FROM public.pedido_item_kds_etapas
    WHERE kds_item_id = p_kds_item_id
      AND ordem = v_proxima_etapa_snap.ordem + 1;

    UPDATE public.pedido_item_producao_kds
    SET ordem_etapa_atual = v_proxima_etapa_snap.ordem,
        estagio_atual = v_proxima_etapa_snap.praca,
        praca_atual = v_proxima_etapa_snap.praca,
        proxima_etapa = COALESCE(v_nova_proxima.praca, 'PRONTO'),
        tempo_etapa_iniciado_em = NOW(),
        sla_etapa_snapshot = v_proxima_etapa_snap.sla_minutos_snapshot,
        operador_id = v_caller_id,
        updated_at = NOW()
    WHERE id = p_kds_item_id;
  END IF;

  -- 7. Atualização do Cabeçalho KDS e do Pedido Canônico
  -- Se foi o 1º avanço fora de AGUARDANDO no KDS:
  IF v_kds.estagio_agregado = 'AGUARDANDO' THEN
    UPDATE public.pedido_producao_kds
    SET iniciado_em = COALESCE(iniciado_em, NOW()),
        estagio_agregado = upper(p_proximo_estagio),
        updated_at = NOW()
    WHERE id = v_item.kds_id;

    IF v_pedido.status_operacional = 'aguardando_producao' THEN
      UPDATE public.pedidos
      SET status_operacional = 'em_producao',
          updated_at = NOW()
      WHERE id = v_pedido.id;
    END IF;
  END IF;

  -- 8. Verificar se todos os itens atingiram PRONTO
  SELECT NOT EXISTS (
    SELECT 1 FROM public.pedido_item_producao_kds
    WHERE kds_id = v_item.kds_id
      AND ativo = TRUE
      AND estagio_atual <> 'PRONTO'
  ) INTO v_todos_prontos;

  IF v_todos_prontos THEN
    UPDATE public.pedido_producao_kds
    SET estagio_agregado = 'PRONTO',
        concluido_em = NOW(),
        ativo = FALSE,
        encerrado_em = NOW(),
        motivo_encerramento = 'CONCLUIDO',
        updated_at = NOW()
    WHERE id = v_item.kds_id;

    -- Conclusão canônica do pedido para pronto
    UPDATE public.pedidos
    SET status_operacional = 'pronto',
        updated_at = NOW()
    WHERE id = v_pedido.id;

    INSERT INTO public.pedido_status_historico (
      pedido_id,
      dimensao,
      status_anterior,
      status_novo,
      usuario_id,
      usuario_nome,
      origem,
      metadata
    ) VALUES (
      v_pedido.id,
      'operacional',
      'em_producao',
      'pronto',
      v_caller_id,
      'Cozinha / KDS',
      'sistema',
      jsonb_build_object('origem_fluxo', 'kds_producao', 'kds_id', v_item.kds_id)
    );
  ELSE
    -- Recalcular estágio agregado representativo (menor estágio entre itens ativos)
    SELECT MIN(ordem_etapa_atual) INTO v_min_ordem
    FROM public.pedido_item_producao_kds
    WHERE kds_id = v_item.kds_id AND ativo = TRUE AND estagio_atual <> 'PRONTO';

    IF v_min_ordem IS NOT NULL THEN
      SELECT praca INTO v_estagio_agregado_novo
      FROM public.pedido_item_kds_etapas
      WHERE kds_item_id = p_kds_item_id AND ordem = v_min_ordem;

      UPDATE public.pedido_producao_kds
      SET estagio_agregado = COALESCE(v_estagio_agregado_novo, estagio_agregado),
          updated_at = NOW()
      WHERE id = v_item.kds_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'kds_item_id', p_kds_item_id,
    'novo_estagio', upper(p_proximo_estagio),
    'pedido_id', v_pedido.id,
    'todos_prontos', v_todos_prontos
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 10. RPC: MARCAR URGÊNCIA NO PEDIDO KDS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_marcar_urgencia(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_kds_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  UPDATE public.pedido_producao_kds
  SET prioridade_urgencia = TRUE,
      observacoes_cozinha = CASE 
        WHEN p_motivo IS NOT NULL AND btrim(p_motivo) <> '' 
        THEN COALESCE(observacoes_cozinha || ' | ', '') || '⚡ URGÊNCIA: ' || btrim(p_motivo)
        ELSE observacoes_cozinha
      END,
      updated_at = NOW()
  WHERE pedido_id = p_pedido_id AND ativo = TRUE
  RETURNING id INTO v_kds_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado ou sem produção KDS ativa.', 'code', 'KDS_NOT_FOUND');
  END IF;

  RETURN jsonb_build_object('success', true, 'kds_id', v_kds_id, 'pedido_id', p_pedido_id, 'urgente', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 11. RPC: OBTER PAINEL DO KDS (BANCADA & TOUCHSCREEN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_obter_painel(
  p_praca_filtro VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_praca_norm VARCHAR;
  v_cards JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_praca_norm := upper(btrim(COALESCE(p_praca_filtro, '')));
  IF v_praca_norm IN ('', 'TODAS', 'NULL') THEN
    v_praca_norm := NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(card_data ORDER BY card_data->>'prioridade_urgencia' DESC, (card_data->>'data_entrega')::text ASC, (card_data->>'hora_entrega')::text ASC, card_data->>'criado_em' ASC), '[]'::jsonb)
  INTO v_cards
  FROM (
    SELECT jsonb_build_object(
      'kds_id', k.id,
      'pedido_id', k.pedido_id,
      'estagio_agregado', k.estagio_agregado,
      'prioridade_urgencia', k.prioridade_urgencia,
      'observacoes_cozinha', k.observacoes_cozinha,
      'criado_em', k.criado_em,
      'iniciado_em', k.iniciado_em,
      'sla_total_minutos', k.sla_total_snapshot,
      'cliente_nome', p.nome_cliente,
      'cliente_telefone', p.telefone_cliente,
      'modalidade_entrega', p.modalidade_entrega,
      'data_entrega', p.data_entrega,
      'hora_entrega', p.hora_entrega,
      'status_operacional_pedido', p.status_operacional,
      'itens', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'kds_item_id', item.id,
            'pedido_item_id', item.pedido_item_id,
            'produto_id', item.produto_id,
            'produto_nome', item.produto_nome_snapshot,
            'quantidade', item.quantidade,
            'ordem_etapa_atual', item.ordem_etapa_atual,
            'ordem_etapa_max', item.ordem_etapa_max,
            'estagio_atual', item.estagio_atual,
            'praca_atual', item.praca_atual,
            'proxima_etapa', item.proxima_etapa,
            'tempo_etapa_segundos', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL 
              THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em))::INTEGER)
              ELSE 0 
            END,
            'sla_etapa_minutos', item.sla_etapa_snapshot,
            'atrasado', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL AND (EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) > item.sla_etapa_snapshot
              THEN TRUE
              ELSE FALSE
            END,
            'minutos_atraso', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL AND (EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) > item.sla_etapa_snapshot
              THEN ROUND(((EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) - item.sla_etapa_snapshot)::numeric, 1)
              ELSE 0
            END,
            'observacoes_item', item.observacoes_item
          ) ORDER BY item.ordem_etapa_atual ASC, item.criado_em ASC
        )
        FROM public.pedido_item_producao_kds item
        WHERE item.kds_id = k.id
          AND item.ativo = TRUE
          AND (v_praca_norm IS NULL OR item.praca_atual = v_praca_norm OR (item.estagio_atual = 'AGUARDANDO' AND item.proxima_etapa = v_praca_norm))
      )
    ) AS card_data
    FROM public.pedido_producao_kds k
    JOIN public.pedidos p ON p.id = k.pedido_id
    WHERE k.ativo = TRUE
      AND p.status_operacional IN ('aguardando_producao', 'em_producao')
      AND EXISTS (
        SELECT 1 FROM public.pedido_item_producao_kds item
        WHERE item.kds_id = k.id
          AND item.ativo = TRUE
          AND (v_praca_norm IS NULL OR item.praca_atual = v_praca_norm OR (item.estagio_atual = 'AGUARDANDO' AND item.proxima_etapa = v_praca_norm))
      )
  ) sub;

  RETURN jsonb_build_object(
    'success', true,
    'praca_filtro', COALESCE(v_praca_norm, 'TODAS'),
    'total_cards', jsonb_array_length(v_cards),
    'cards', v_cards
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 12. TRIGGER DE SINCRONIZAÇÃO ENTRE PEDIDO CANÔNICO E KDS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_sincronizar_kds_pedido()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o pedido transicionar para aguardando_producao, inicializa no KDS se ainda não existir
  IF NEW.status_operacional = 'aguardando_producao' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'aguardando_producao') THEN
    IF NOT EXISTS (SELECT 1 FROM public.pedido_producao_kds WHERE pedido_id = NEW.id) THEN
      PERFORM public.kds_inicializar_pedido(NEW.id);
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

DROP TRIGGER IF EXISTS trg_sincronizar_kds_pedido ON public.pedidos;
CREATE TRIGGER trg_sincronizar_kds_pedido
  AFTER UPDATE OF status_operacional ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_sincronizar_kds_pedido();

-- ------------------------------------------------------------------------------
-- 13. SEED DE ROTAS KDS PARA PRODUTOS EXISTENTES (PARA OPERAÇÃO IMEDIATA)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, nome FROM public.produtos LOOP
    IF NOT EXISTS (SELECT 1 FROM public.produto_etapas_kds WHERE produto_id = r.id) THEN
      IF r.nome ILIKE '%Bolo%' OR r.nome ILIKE '%Torta%' THEN
        INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos) VALUES
          (r.id, 1, 'MASSA', 20),
          (r.id, 2, 'FORNO', 35),
          (r.id, 3, 'RECHEIO', 25),
          (r.id, 4, 'DECORACAO', 30),
          (r.id, 5, 'EMBALAGEM', 15);
      ELSIF r.nome ILIKE '%Brownie%' OR r.nome ILIKE '%Cookie%' THEN
        INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos) VALUES
          (r.id, 1, 'FORNO', 25),
          (r.id, 2, 'EMBALAGEM', 10);
      ELSIF r.nome ILIKE '%Brigadeiro%' OR r.nome ILIKE '%Docinho%' THEN
        INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos) VALUES
          (r.id, 1, 'MASSA', 15),
          (r.id, 2, 'DECORACAO', 20),
          (r.id, 3, 'EMBALAGEM', 10);
      ELSE
        INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos) VALUES
          (r.id, 1, 'FORNO', 20),
          (r.id, 2, 'EMBALAGEM', 10);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 14. GRANTS FAIL-CLOSED DE SEGURANÇA
-- ------------------------------------------------------------------------------
REVOKE ALL ON public.produto_etapas_kds FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.produto_etapas_kds TO authenticated, service_role;

REVOKE ALL ON public.pedido_producao_kds FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.pedido_producao_kds TO authenticated, service_role;

REVOKE ALL ON public.pedido_item_producao_kds FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.pedido_item_producao_kds TO authenticated, service_role;

REVOKE ALL ON public.pedido_item_kds_etapas FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.pedido_item_kds_etapas TO authenticated, service_role;

REVOKE ALL ON public.pedido_kds_estagio_historico FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.pedido_kds_estagio_historico TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kds_obter_painel(VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_obter_painel(VARCHAR) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kds_avancar_item(UUID, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_avancar_item(UUID, VARCHAR) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kds_marcar_urgencia(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_marcar_urgencia(BIGINT, TEXT) TO authenticated, service_role;
