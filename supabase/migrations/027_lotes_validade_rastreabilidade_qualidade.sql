-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 027: LOTES, VALIDADE, RASTREABILIDADE E QUALIDADE DE PRODUÇÃO (FRENTE L)
-- ==============================================================================
-- Fecha o elo físico-operacional entre Fornecedor -> Ingrediente (Lote/Validade) ->
-- Consumo Produtivo (FEFO) -> Controle de Qualidade -> Pedido -> Cliente.
--
-- Invariantes garantidas:
-- 1. Zero substituição de public.ingrediente_saldos: o saldo agregado permanece a
--    verdade consolidada e public.ingrediente_lotes é a sua composição rastreável.
-- 2. Invariante matemática universal (Gate L7):
--    SUM(ingrediente_lotes.quantidade_atual) == ingrediente_saldos.saldo_atual
--    verificada transacionalmente ao final de toda movimentação.
-- 3. Política FEFO (First Expire, First Out) server-side com FOR UPDATE (Gates L3, L4, L5, L6):
--    Consome primeiro o lote elegível com menor data_validade, ignorando lotes
--    vencidos (data_validade < hoje) e lotes bloqueados por qualidade.
-- 4. Livros-razão estritamente append-only (Gate L10):
--    public.ingrediente_lote_movimentacoes, public.pedido_consumos_lote e
--    public.producao_controles_qualidade bloqueiam UPDATE e DELETE físicos.
-- 5. Bloqueio de escrita direta em public.ingrediente_lotes fora das portas canônicas.
-- 6. Controle de Qualidade com bloqueio automático de avanço operacional em caso de
--    reprovação até que haja reinspeção aprovada (Gates L14, L15) e efeito financeiro ZERO (Gate L16).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSÕES FORWARD-ONLY EM CONFIGURAÇÕES, INGREDIENTES E COMPRA_ITENS
-- ------------------------------------------------------------------------------
ALTER TABLE public.configuracoes_operacao
  ADD COLUMN IF NOT EXISTS dias_alerta_validade_padrao INTEGER NOT NULL DEFAULT 7
  CHECK (dias_alerta_validade_padrao >= 1 AND dias_alerta_validade_padrao <= 365);

ALTER TABLE public.ingredientes
  ADD COLUMN IF NOT EXISTS controlar_lote BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS controlar_validade BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dias_alerta_validade INTEGER
    CHECK (dias_alerta_validade IS NULL OR (dias_alerta_validade >= 1 AND dias_alerta_validade <= 365));

ALTER TABLE public.compra_itens
  ADD COLUMN IF NOT EXISTS codigo_lote TEXT,
  ADD COLUMN IF NOT EXISTS data_fabricacao DATE,
  ADD COLUMN IF NOT EXISTS data_validade DATE;

ALTER TABLE public.compra_itens
  DROP CONSTRAINT IF EXISTS uq_compra_ingrediente;

-- ------------------------------------------------------------------------------
-- 2. TABELA PUBLIC.INGREDIENTE_LOTES (COMPOSIÇÃO RASTREÁVEL DO SALDO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingrediente_lotes (
  id BIGSERIAL PRIMARY KEY,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  fornecedor_id BIGINT REFERENCES public.fornecedores(id) ON DELETE SET NULL,
  compra_id BIGINT REFERENCES public.compras(id) ON DELETE SET NULL,
  compra_item_id BIGINT REFERENCES public.compra_itens(id) ON DELETE SET NULL,
  codigo_lote TEXT NOT NULL CHECK (char_length(btrim(codigo_lote)) >= 1),
  data_recebimento DATE NOT NULL DEFAULT CURRENT_DATE,
  data_fabricacao DATE,
  data_validade DATE,
  quantidade_inicial NUMERIC(12,3) NOT NULL CHECK (quantidade_inicial > 0),
  quantidade_atual NUMERIC(12,3) NOT NULL CHECK (quantidade_atual >= 0 AND quantidade_atual <= quantidade_inicial),
  custo_unitario_lote NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_lote >= 0),
  bloqueado_qualidade BOOLEAN NOT NULL DEFAULT false,
  motivo_bloqueio TEXT,
  bloqueado_em TIMESTAMPTZ,
  bloqueado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  observacoes TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ingrediente_codigo_lote UNIQUE (ingrediente_id, codigo_lote)
);

CREATE INDEX IF NOT EXISTS idx_ing_lotes_fefo
  ON public.ingrediente_lotes(ingrediente_id, data_validade ASC NULLS LAST, data_recebimento ASC, id ASC)
  WHERE quantidade_atual > 0 AND bloqueado_qualidade = false;

CREATE INDEX IF NOT EXISTS idx_ing_lotes_validade
  ON public.ingrediente_lotes(data_validade ASC)
  WHERE quantidade_atual > 0;

CREATE INDEX IF NOT EXISTS idx_ing_lotes_compra
  ON public.ingrediente_lotes(compra_id);

-- Proteção contra escrita/UPDATE direto fora das RPCs canônicas
CREATE OR REPLACE FUNCTION public._proteger_escrita_direta_ingrediente_lotes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_LOT_RECORD: Lotes de ingredientes não podem ser excluídos fisicamente.'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(current_setting('lunoca.allow_lote_mutation', true), '') <> 'true' THEN
    RAISE EXCEPTION 'DIRECT_LOT_MUTATION_FORBIDDEN: Alteração direta em ingrediente_lotes proibida. Utilize as RPCs canônicas de recebimento, consumo FEFO, perda ou ajuste.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proteger_escrita_ingrediente_lotes ON public.ingrediente_lotes;
CREATE TRIGGER trg_proteger_escrita_ingrediente_lotes
  BEFORE INSERT OR UPDATE OR DELETE ON public.ingrediente_lotes
  FOR EACH ROW
  EXECUTE FUNCTION public._proteger_escrita_direta_ingrediente_lotes();

-- ------------------------------------------------------------------------------
-- 3. TABELA PUBLIC.INGREDIENTE_LOTE_MOVIMENTACOES (LIVRO-RAZÃO APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingrediente_lote_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  lote_id BIGINT NOT NULL REFERENCES public.ingrediente_lotes(id) ON DELETE RESTRICT,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  ingrediente_movimentacao_id BIGINT REFERENCES public.ingrediente_movimentacoes(id) ON DELETE SET NULL,
  tipo_evento TEXT NOT NULL CHECK (tipo_evento IN (
    'ENTRADA_COMPRA',
    'CONSUMO_PRODUCAO',
    'PERDA',
    'VENCIMENTO',
    'AJUSTE_CONTAGEM',
    'DEVOLUCAO'
  )),
  quantidade NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  saldo_lote_anterior NUMERIC(12,3) NOT NULL CHECK (saldo_lote_anterior >= 0),
  saldo_lote_posterior NUMERIC(12,3) NOT NULL CHECK (saldo_lote_posterior >= 0),
  custo_unitario_aplicado NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_aplicado >= 0),
  compra_id BIGINT REFERENCES public.compras(id) ON DELETE SET NULL,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  motivo TEXT NOT NULL CHECK (char_length(btrim(motivo)) >= 3),
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ing_lote_mov_lote ON public.ingrediente_lote_movimentacoes(lote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ing_lote_mov_ing ON public.ingrediente_lote_movimentacoes(ingrediente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ing_lote_mov_pedido ON public.ingrediente_lote_movimentacoes(pedido_id) WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ing_lote_mov_compra ON public.ingrediente_lote_movimentacoes(compra_id) WHERE compra_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._bloquear_mutacao_ingrediente_lote_mov()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_LOT_LEDGER_VIOLATION: O livro-razão ingrediente_lote_movimentacoes é estritamente append-only e não permite %.', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_ingrediente_lote_mov ON public.ingrediente_lote_movimentacoes;
CREATE TRIGGER trg_imutabilidade_ingrediente_lote_mov
  BEFORE UPDATE OR DELETE ON public.ingrediente_lote_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_ingrediente_lote_mov();

-- ------------------------------------------------------------------------------
-- 4. TABELA PUBLIC.PEDIDO_CONSUMOS_LOTE (RASTREABILIDADE LOTE <-> PEDIDO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_consumos_lote (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  pedido_item_id BIGINT REFERENCES public.pedido_itens(id) ON DELETE SET NULL,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE SET NULL,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  lote_id BIGINT NOT NULL REFERENCES public.ingrediente_lotes(id) ON DELETE RESTRICT,
  lote_movimentacao_id BIGINT REFERENCES public.ingrediente_lote_movimentacoes(id) ON DELETE SET NULL,
  codigo_lote_snapshot TEXT NOT NULL,
  data_validade_snapshot DATE,
  quantidade_consumida NUMERIC(12,3) NOT NULL CHECK (quantidade_consumida > 0),
  unidade VARCHAR(10) NOT NULL DEFAULT 'g',
  custo_unitario_lote_snapshot NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_lote_snapshot >= 0),
  consumido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registrado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  registrado_por_nome TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_ped_consumos_lote_pedido ON public.pedido_consumos_lote(pedido_id);
CREATE INDEX IF NOT EXISTS idx_ped_consumos_lote_lote ON public.pedido_consumos_lote(lote_id);
CREATE INDEX IF NOT EXISTS idx_ped_consumos_lote_ingrediente ON public.pedido_consumos_lote(ingrediente_id);

CREATE OR REPLACE FUNCTION public._bloquear_mutacao_pedido_consumos_lote()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TRACEABILITY_VIOLATION: Os registros de rastreabilidade pedido_consumos_lote são imutáveis e não permitem %.', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_pedido_consumos_lote ON public.pedido_consumos_lote;
CREATE TRIGGER trg_imutabilidade_pedido_consumos_lote
  BEFORE UPDATE OR DELETE ON public.pedido_consumos_lote
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_pedido_consumos_lote();

-- ------------------------------------------------------------------------------
-- 5. TABELAS DE CONTROLE DE QUALIDADE E OCORRÊNCIAS DE PRODUÇÃO
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.producao_controles_qualidade (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  etapa TEXT NOT NULL CHECK (etapa IN ('PRE_PRODUCAO', 'FINALIZACAO', 'EMBALAGEM', 'EXPEDICAO')),
  resultado TEXT NOT NULL CHECK (resultado IN ('APROVADO', 'REPROVADO', 'APROVADO_COM_RESSALVA')),
  bloqueia_avanco BOOLEAN NOT NULL DEFAULT false,
  observacao TEXT,
  reinspecao_de_id BIGINT REFERENCES public.producao_controles_qualidade(id) ON DELETE SET NULL,
  responsavel_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  responsavel_nome TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prod_cq_pedido ON public.producao_controles_qualidade(pedido_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_prod_cq_etapa ON public.producao_controles_qualidade(pedido_id, etapa, id DESC);

CREATE OR REPLACE FUNCTION public._bloquear_mutacao_producao_cq()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_QUALITY_CHECKPOINT: Os registros de controle de qualidade são append-only e não permitem %.', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_producao_cq ON public.producao_controles_qualidade;
CREATE TRIGGER trg_imutabilidade_producao_cq
  BEFORE UPDATE OR DELETE ON public.producao_controles_qualidade
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_producao_cq();

CREATE TABLE IF NOT EXISTS public.producao_ocorrencias_qualidade (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  lote_id BIGINT REFERENCES public.ingrediente_lotes(id) ON DELETE RESTRICT,
  controle_qualidade_id BIGINT REFERENCES public.producao_controles_qualidade(id) ON DELETE SET NULL,
  severidade TEXT NOT NULL DEFAULT 'critica' CHECK (severidade IN ('baixa', 'media', 'critica')),
  tipo_ocorrencia TEXT NOT NULL CHECK (tipo_ocorrencia IN (
    'REPROVACAO_ETAPA',
    'CONTAMINACAO_OU_DANO_LOTE',
    'DESVIO_PADRAO_VISUAL',
    'PROBLEMA_EMBALAGEM',
    'OUTRO'
  )),
  descricao TEXT NOT NULL CHECK (char_length(btrim(descricao)) >= 3),
  acao_corretiva TEXT,
  resolvida BOOLEAN NOT NULL DEFAULT false,
  resolvida_em TIMESTAMPTZ,
  resolvida_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  registrado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  registrado_por_nome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ocorrencia_alvo CHECK (pedido_id IS NOT NULL OR lote_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_prod_ocorr_pedido ON public.producao_ocorrencias_qualidade(pedido_id) WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prod_ocorr_lote ON public.producao_ocorrencias_qualidade(lote_id) WHERE lote_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 6. RLS E GRANTS FAIL-CLOSED PARA AS 5 TABELAS DA FRENTE L
-- ------------------------------------------------------------------------------
ALTER TABLE public.ingrediente_lotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingrediente_lote_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_consumos_lote ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.producao_controles_qualidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.producao_ocorrencias_qualidade ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ingrediente_lotes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ingrediente_lote_movimentacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_consumos_lote FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.producao_controles_qualidade FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.producao_ocorrencias_qualidade FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.ingrediente_lotes TO authenticated;
GRANT SELECT ON public.ingrediente_lote_movimentacoes TO authenticated;
GRANT SELECT ON public.pedido_consumos_lote TO authenticated;
GRANT SELECT ON public.producao_controles_qualidade TO authenticated;
GRANT SELECT ON public.producao_ocorrencias_qualidade TO authenticated;

GRANT ALL ON public.ingrediente_lotes TO service_role;
GRANT ALL ON public.ingrediente_lote_movimentacoes TO service_role;
GRANT ALL ON public.pedido_consumos_lote TO service_role;
GRANT ALL ON public.producao_controles_qualidade TO service_role;
GRANT ALL ON public.producao_ocorrencias_qualidade TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.ingrediente_lotes_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ingrediente_lote_movimentacoes_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pedido_consumos_lote_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.producao_controles_qualidade_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.producao_ocorrencias_qualidade_id_seq TO service_role;

DROP POLICY IF EXISTS ing_lotes_equipe_select ON public.ingrediente_lotes;
CREATE POLICY ing_lotes_equipe_select ON public.ingrediente_lotes
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS ing_lote_mov_equipe_select ON public.ingrediente_lote_movimentacoes;
CREATE POLICY ing_lote_mov_equipe_select ON public.ingrediente_lote_movimentacoes
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS ped_consumos_lote_equipe_select ON public.pedido_consumos_lote;
CREATE POLICY ped_consumos_lote_equipe_select ON public.pedido_consumos_lote
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS prod_cq_equipe_select ON public.producao_controles_qualidade;
CREATE POLICY prod_cq_equipe_select ON public.producao_controles_qualidade
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS prod_ocorr_equipe_select ON public.producao_ocorrencias_qualidade;
CREATE POLICY prod_ocorr_equipe_select ON public.producao_ocorrencias_qualidade
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- ------------------------------------------------------------------------------
-- 7. HELPERS INTERNOS: ESTADO DERIVADO DE VALIDADE E RECONCILIAÇÃO DE SALDO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._derivar_estado_validade_lote(
  p_quantidade_atual NUMERIC,
  p_data_validade DATE,
  p_bloqueado_qualidade BOOLEAN,
  p_dias_alerta INTEGER DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_horizonte INTEGER := COALESCE(p_dias_alerta, (SELECT dias_alerta_validade_padrao FROM public.configuracoes_operacao ORDER BY id ASC LIMIT 1), 7);
BEGIN
  IF COALESCE(p_bloqueado_qualidade, false) THEN
    RETURN 'bloqueado';
  END IF;

  IF COALESCE(p_quantidade_atual, 0) <= 0 THEN
    RETURN 'esgotado';
  END IF;

  IF p_data_validade IS NOT NULL THEN
    IF p_data_validade < v_hoje THEN
      RETURN 'vencido';
    END IF;
    IF p_data_validade <= (v_hoje + v_horizonte) THEN
      RETURN 'vence_em_breve';
    END IF;
  END IF;

  RETURN 'valido';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public._derivar_estado_validade_lote(NUMERIC, DATE, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._derivar_estado_validade_lote(NUMERIC, DATE, BOOLEAN, INTEGER) TO service_role;

-- Gate L7: Verificador atômico de reconciliação SUM(lotes ativos) == ingrediente_saldos.saldo_atual
CREATE OR REPLACE FUNCTION public._verificar_reconciliacao_lotes_ingrediente(
  p_ingrediente_id BIGINT
)
RETURNS VOID AS $$
DECLARE
  v_saldo_agregado NUMERIC(12,3);
  v_soma_lotes NUMERIC(12,3);
BEGIN
  SELECT COALESCE(saldo_atual, 0.000)
  INTO v_saldo_agregado
  FROM public.ingrediente_saldos
  WHERE ingrediente_id = p_ingrediente_id;

  IF NOT FOUND THEN
    v_saldo_agregado := 0.000;
  END IF;

  SELECT COALESCE(ROUND(SUM(quantidade_atual), 3), 0.000)
  INTO v_soma_lotes
  FROM public.ingrediente_lotes
  WHERE ingrediente_id = p_ingrediente_id
    AND quantidade_atual > 0;

  IF ROUND(v_soma_lotes, 3) <> ROUND(v_saldo_agregado, 3) THEN
    RAISE EXCEPTION 'LOT_AGGREGATE_MISMATCH: Soma dos lotes ativos (%) diverge de ingrediente_saldos.saldo_atual (%) para o ingrediente #%.',
      v_soma_lotes, v_saldo_agregado, p_ingrediente_id
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public._verificar_reconciliacao_lotes_ingrediente(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._verificar_reconciliacao_lotes_ingrediente(BIGINT) TO service_role;

-- Backfill inicial para ingredientes já existentes com saldo_atual > 0 antes da 027
DO $$
DECLARE
  v_rec RECORD;
  v_soma NUMERIC(12,3);
  v_diff NUMERIC(12,3);
  v_lote_id BIGINT;
BEGIN
  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);

  FOR v_rec IN
    SELECT s.ingrediente_id, s.saldo_atual, s.custo_medio_ponderado
    FROM public.ingrediente_saldos s
    WHERE s.saldo_atual > 0
  LOOP
    SELECT COALESCE(ROUND(SUM(quantidade_atual), 3), 0.000)
    INTO v_soma
    FROM public.ingrediente_lotes
    WHERE ingrediente_id = v_rec.ingrediente_id
      AND quantidade_atual > 0;

    v_diff := ROUND(v_rec.saldo_atual - v_soma, 3);
    IF v_diff > 0 THEN
      INSERT INTO public.ingrediente_lotes (
        ingrediente_id,
        codigo_lote,
        data_recebimento,
        quantidade_inicial,
        quantidade_atual,
        custo_unitario_lote,
        observacoes,
        idempotency_key
      ) VALUES (
        v_rec.ingrediente_id,
        'LOTE-INICIAL-' || v_rec.ingrediente_id::TEXT,
        CURRENT_DATE,
        v_diff,
        v_diff,
        COALESCE(v_rec.custo_medio_ponderado, 0.0000),
        'Lote de abertura para reconciliação inicial com ingrediente_saldos',
        'lote_abertura_027_ing_' || v_rec.ingrediente_id::TEXT
      )
      ON CONFLICT (ingrediente_id, codigo_lote) DO UPDATE
        SET quantidade_inicial = GREATEST(public.ingrediente_lotes.quantidade_inicial, EXCLUDED.quantidade_atual),
            quantidade_atual = EXCLUDED.quantidade_atual,
            updated_at = NOW()
      RETURNING id INTO v_lote_id;

      INSERT INTO public.ingrediente_lote_movimentacoes (
        lote_id,
        ingrediente_id,
        tipo_evento,
        quantidade,
        saldo_lote_anterior,
        saldo_lote_posterior,
        custo_unitario_aplicado,
        motivo,
        usuario_nome,
        idempotency_key
      ) VALUES (
        v_lote_id,
        v_rec.ingrediente_id,
        'AJUSTE_CONTAGEM',
        v_diff,
        0.000,
        v_diff,
        COALESCE(v_rec.custo_medio_ponderado, 0.0000),
        'Carga inicial de reconciliação de saldo existente (Migration 027)',
        'Sistema / Migration 027',
        'mov_abertura_027_ing_' || v_rec.ingrediente_id::TEXT
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Trigger para manter LOTE-INICIAL sincronizado quando fixtures ou INSERT em ingredientes criarem saldo inicial direto
CREATE OR REPLACE FUNCTION public._trg_sync_lote_saldo_direto()
RETURNS TRIGGER AS $$
DECLARE
  v_soma_lotes NUMERIC(12,3);
  v_diff NUMERIC(12,3);
  v_lote RECORD;
  v_lote_id BIGINT;
  v_prev_flag TEXT := COALESCE(current_setting('lunoca.allow_lote_mutation', true), '');
BEGIN
  -- Se já estamos dentro de _aplicar_movimento_ingrediente, a própria função gerencia os lotes
  IF COALESCE(current_setting('lunoca.in_movimento_ingrediente', true), '') = 'true' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);

  SELECT COALESCE(ROUND(SUM(quantidade_atual), 3), 0.000)
  INTO v_soma_lotes
  FROM public.ingrediente_lotes
  WHERE ingrediente_id = NEW.ingrediente_id
    AND quantidade_atual > 0;

  v_diff := ROUND(COALESCE(NEW.saldo_atual, 0.000) - v_soma_lotes, 3);

  IF v_diff > 0 THEN
    INSERT INTO public.ingrediente_lotes (
      ingrediente_id,
      codigo_lote,
      data_recebimento,
      quantidade_inicial,
      quantidade_atual,
      custo_unitario_lote,
      observacoes
    ) VALUES (
      NEW.ingrediente_id,
      'LOTE-INICIAL-' || NEW.ingrediente_id::TEXT,
      CURRENT_DATE,
      v_diff,
      v_diff,
      COALESCE(NEW.custo_medio_ponderado, 0.0000),
      'Sincronização automática de saldo inicial'
    )
    ON CONFLICT (ingrediente_id, codigo_lote) DO UPDATE
      SET quantidade_inicial = public.ingrediente_lotes.quantidade_inicial + v_diff,
          quantidade_atual = public.ingrediente_lotes.quantidade_atual + v_diff,
          custo_unitario_lote = COALESCE(EXCLUDED.custo_unitario_lote, public.ingrediente_lotes.custo_unitario_lote),
          updated_at = NOW()
    RETURNING id INTO v_lote_id;

    INSERT INTO public.ingrediente_lote_movimentacoes (
      lote_id,
      ingrediente_id,
      tipo_evento,
      quantidade,
      saldo_lote_anterior,
      saldo_lote_posterior,
      custo_unitario_aplicado,
      motivo,
      usuario_nome
    ) VALUES (
      v_lote_id,
      NEW.ingrediente_id,
      'AJUSTE_CONTAGEM',
      v_diff,
      0.000,
      v_diff,
      COALESCE(NEW.custo_medio_ponderado, 0.0000),
      'Sincronização de abertura de saldo do ingrediente',
      'Sistema'
    );
  ELSIF v_diff < 0 THEN
    -- Reduz de lotes existentes se um fixture zerou ou reduziu o saldo inicial diretamente
    v_diff := ABS(v_diff);
    FOR v_lote IN
      SELECT * FROM public.ingrediente_lotes
      WHERE ingrediente_id = NEW.ingrediente_id AND quantidade_atual > 0
      ORDER BY data_validade ASC NULLS LAST, id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_diff <= 0;
      IF v_lote.quantidade_atual <= v_diff THEN
        v_diff := ROUND(v_diff - v_lote.quantidade_atual, 3);
        UPDATE public.ingrediente_lotes SET quantidade_atual = 0, updated_at = NOW() WHERE id = v_lote.id;
      ELSE
        UPDATE public.ingrediente_lotes SET quantidade_atual = ROUND(quantidade_atual - v_diff, 3), updated_at = NOW() WHERE id = v_lote.id;
        v_diff := 0;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', v_prev_flag, true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_lote_saldo_direto ON public.ingrediente_saldos;
CREATE TRIGGER trg_sync_lote_saldo_direto
  AFTER INSERT OR UPDATE OF saldo_atual ON public.ingrediente_saldos
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_sync_lote_saldo_direto();

-- ------------------------------------------------------------------------------
-- 8. EVOLUÇÃO DO MOTOR INTERNO _APLICAR_MOVIMENTO_INGREDIENTE COM RECONCILIAÇÃO DE LOTES
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._aplicar_movimento_ingrediente(
  p_ingrediente_id BIGINT,
  p_tipo TEXT,
  p_quantidade NUMERIC,
  p_custo_unitario NUMERIC,
  p_motivo TEXT,
  p_compra_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL,
  p_usuario_nome TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ing RECORD;
  v_saldo RECORD;
  v_mov_existente RECORD;
  v_eh_entrada BOOLEAN;
  v_saldo_ant NUMERIC(12,3);
  v_saldo_post NUMERIC(12,3);
  v_cmp_ant NUMERIC(12,4);
  v_cmp_post NUMERIC(12,4);
  v_custo_aplicado NUMERIC(12,4);
  v_valor_total NUMERIC(12,2);
  v_mov_id BIGINT;
  v_lote_ja_sincronizado BOOLEAN := (COALESCE(current_setting('lunoca.lote_already_synced', true), '') = 'true');
  v_prev_in_mov TEXT := COALESCE(current_setting('lunoca.in_movimento_ingrediente', true), '');
  v_prev_allow_lote TEXT := COALESCE(current_setting('lunoca.allow_lote_mutation', true), '');
  v_restante NUMERIC(12,3);
  v_consumir NUMERIC(12,3);
  v_lote RECORD;
  v_lote_id BIGINT;
  v_cod_auto TEXT;
  v_tipo_evt_lote TEXT;
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
BEGIN
  IF p_ingrediente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_INGREDIENT', 'error', 'Ingrediente não informado.');
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'A quantidade movimentada deve ser maior que zero.');
  END IF;

  IF p_tipo NOT IN ('entrada_compra', 'consumo_producao', 'perda', 'ajuste_entrada', 'ajuste_saida', 'estorno_compra') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MOVEMENT_TYPE', 'error', 'Tipo de movimentação inválido.');
  END IF;

  -- Idempotência por chave
  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT * INTO v_mov_existente
    FROM public.ingrediente_movimentacoes
    WHERE idempotency_key = btrim(p_idempotency_key);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'movimentacao_id', v_mov_existente.id,
        'ingrediente_id', v_mov_existente.ingrediente_id,
        'saldo_anterior', v_mov_existente.saldo_anterior,
        'saldo_posterior', v_mov_existente.saldo_posterior,
        'custo_medio_anterior', v_mov_existente.custo_medio_anterior,
        'custo_medio_posterior', v_mov_existente.custo_medio_posterior
      );
    END IF;
  END IF;

  PERFORM set_config('lunoca.in_movimento_ingrediente', 'true', true);
  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);

  SELECT * INTO v_ing
  FROM public.ingredientes
  WHERE id = p_ingrediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM set_config('lunoca.in_movimento_ingrediente', v_prev_in_mov, true);
    PERFORM set_config('lunoca.allow_lote_mutation', v_prev_allow_lote, true);
    RETURN jsonb_build_object('success', false, 'code', 'INGREDIENT_NOT_FOUND', 'error', 'Ingrediente não encontrado.');
  END IF;

  INSERT INTO public.ingrediente_saldos (
    ingrediente_id, saldo_atual, custo_medio_ponderado, ultimo_custo_compra, updated_at
  ) VALUES (
    v_ing.id,
    GREATEST(0, COALESCE(v_ing.estoque_qtd, 0)),
    GREATEST(0, COALESCE(NULLIF(v_ing.custo_medio_unitario, 0), v_ing.custo_unitario, 0)),
    GREATEST(0, COALESCE(NULLIF(v_ing.ultimo_custo_compra, 0), v_ing.custo_unitario, 0)),
    NOW()
  )
  ON CONFLICT (ingrediente_id) DO NOTHING;

  SELECT * INTO v_saldo
  FROM public.ingrediente_saldos
  WHERE ingrediente_id = p_ingrediente_id
  FOR UPDATE;

  v_saldo_ant := COALESCE(v_saldo.saldo_atual, 0.000);
  v_cmp_ant := COALESCE(NULLIF(v_saldo.custo_medio_ponderado, 0), v_ing.custo_unitario, 0.0000);
  v_eh_entrada := p_tipo IN ('entrada_compra', 'ajuste_entrada');

  IF v_eh_entrada THEN
    v_saldo_post := ROUND(v_saldo_ant + p_quantidade, 3);
    v_custo_aplicado := GREATEST(0.0000, COALESCE(p_custo_unitario, v_cmp_ant));

    IF p_tipo = 'entrada_compra' OR (p_tipo = 'ajuste_entrada' AND p_custo_unitario IS NOT NULL AND p_custo_unitario > 0) THEN
      IF v_saldo_post > 0 THEN
        v_cmp_post := ROUND(((v_saldo_ant * v_cmp_ant) + (p_quantidade * v_custo_aplicado)) / v_saldo_post, 4);
      ELSE
        v_cmp_post := v_custo_aplicado;
      END IF;
    ELSE
      v_cmp_post := v_cmp_ant;
    END IF;
  ELSE
    IF v_saldo_ant < p_quantidade THEN
      PERFORM set_config('lunoca.in_movimento_ingrediente', v_prev_in_mov, true);
      PERFORM set_config('lunoca.allow_lote_mutation', v_prev_allow_lote, true);
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INSUFFICIENT_INGREDIENT_STOCK',
        'error', format('Saldo insuficiente do insumo "%s" (disponível: %s, solicitado: %s).', v_ing.nome, v_saldo_ant, p_quantidade),
        'ingrediente_id', v_ing.id,
        'saldo_disponivel', v_saldo_ant,
        'quantidade_solicitada', p_quantidade
      );
    END IF;

    v_saldo_post := ROUND(v_saldo_ant - p_quantidade, 3);
    IF p_tipo = 'estorno_compra' AND p_custo_unitario IS NOT NULL AND p_custo_unitario > 0 THEN
      v_custo_aplicado := p_custo_unitario;
      IF v_saldo_post > 0 THEN
        v_cmp_post := GREATEST(0.0000, ROUND(((v_saldo_ant * v_cmp_ant) - (p_quantidade * v_custo_aplicado)) / v_saldo_post, 4));
      ELSE
        v_cmp_post := v_cmp_ant;
      END IF;
    ELSE
      v_custo_aplicado := v_cmp_ant;
      v_cmp_post := v_cmp_ant;
    END IF;
  END IF;

  v_valor_total := ROUND(p_quantidade * v_custo_aplicado, 2);

  UPDATE public.ingrediente_saldos
  SET
    saldo_atual = v_saldo_post,
    custo_medio_ponderado = v_cmp_post,
    ultimo_custo_compra = CASE WHEN p_tipo = 'entrada_compra' THEN v_custo_aplicado ELSE ultimo_custo_compra END,
    updated_at = NOW()
  WHERE ingrediente_id = p_ingrediente_id;

  UPDATE public.ingredientes
  SET
    estoque_qtd = v_saldo_post,
    custo_medio_unitario = v_cmp_post,
    ultimo_custo_compra = CASE WHEN p_tipo = 'entrada_compra' THEN v_custo_aplicado ELSE ultimo_custo_compra END,
    updated_at = NOW()
  WHERE id = p_ingrediente_id;

  INSERT INTO public.ingrediente_movimentacoes (
    ingrediente_id,
    tipo,
    quantidade,
    saldo_anterior,
    saldo_posterior,
    custo_unitario_aplicado,
    custo_medio_anterior,
    custo_medio_posterior,
    valor_total_movimento,
    compra_id,
    pedido_id,
    motivo,
    usuario_id,
    usuario_nome,
    idempotency_key
  ) VALUES (
    p_ingrediente_id,
    p_tipo,
    p_quantidade,
    v_saldo_ant,
    v_saldo_post,
    v_custo_aplicado,
    v_cmp_ant,
    v_cmp_post,
    v_valor_total,
    p_compra_id,
    p_pedido_id,
    btrim(p_motivo),
    p_usuario_id,
    COALESCE(p_usuario_nome, 'Sistema'),
    NULLIF(btrim(p_idempotency_key), '')
  )
  RETURNING id INTO v_mov_id;

  -- Se a chamada veio de uma RPC genérica (ex: ajustar_estoque_insumo_admin, registrar_perda_insumo, cancelar_compra),
  -- sincroniza automaticamente os lotes para preservar SUM(lotes) == ingrediente_saldos.saldo_atual
  IF NOT v_lote_ja_sincronizado THEN
    IF v_eh_entrada THEN
      v_cod_auto := CASE
        WHEN p_compra_id IS NOT NULL THEN format('LOTE-COMP-%s-ING-%s', p_compra_id, p_ingrediente_id)
        ELSE format('LOTE-AJUSTE-%s-%s', p_ingrediente_id, v_mov_id)
      END;

      INSERT INTO public.ingrediente_lotes (
        ingrediente_id,
        compra_id,
        codigo_lote,
        data_recebimento,
        quantidade_inicial,
        quantidade_atual,
        custo_unitario_lote,
        observacoes
      ) VALUES (
        p_ingrediente_id,
        p_compra_id,
        v_cod_auto,
        v_hoje,
        ROUND(p_quantidade, 3),
        v_custo_aplicado,
        btrim(p_motivo)
      )
      ON CONFLICT (ingrediente_id, codigo_lote) DO UPDATE
        SET quantidade_inicial = public.ingrediente_lotes.quantidade_inicial + EXCLUDED.quantidade_inicial,
            quantidade_atual = public.ingrediente_lotes.quantidade_atual + EXCLUDED.quantidade_atual,
            updated_at = NOW()
      RETURNING id INTO v_lote_id;

      INSERT INTO public.ingrediente_lote_movimentacoes (
        lote_id,
        ingrediente_id,
        ingrediente_movimentacao_id,
        tipo_evento,
        quantidade,
        saldo_lote_anterior,
        saldo_lote_posterior,
        custo_unitario_aplicado,
        compra_id,
        pedido_id,
        motivo,
        usuario_id,
        usuario_nome
      ) VALUES (
        v_lote_id,
        p_ingrediente_id,
        v_mov_id,
        CASE WHEN p_tipo = 'entrada_compra' THEN 'ENTRADA_COMPRA' ELSE 'AJUSTE_CONTAGEM' END,
        ROUND(p_quantidade, 3),
        0.000,
        ROUND(p_quantidade, 3),
        v_custo_aplicado,
        p_compra_id,
        p_pedido_id,
        btrim(p_motivo),
        p_usuario_id,
        COALESCE(p_usuario_nome, 'Sistema')
      );
    ELSE
      v_restante := ROUND(p_quantidade, 3);
      v_tipo_evt_lote := CASE p_tipo
        WHEN 'consumo_producao' THEN 'CONSUMO_PRODUCAO'
        WHEN 'perda' THEN 'PERDA'
        WHEN 'estorno_compra' THEN 'DEVOLUCAO'
        ELSE 'AJUSTE_CONTAGEM'
      END;

      FOR v_lote IN
        SELECT *
        FROM public.ingrediente_lotes
        WHERE ingrediente_id = p_ingrediente_id
          AND quantidade_atual > 0
          AND (p_compra_id IS NULL OR compra_id = p_compra_id OR p_tipo <> 'estorno_compra')
        ORDER BY
          CASE WHEN p_compra_id IS NOT NULL AND compra_id = p_compra_id THEN 0 ELSE 1 END ASC,
          bloqueado_qualidade ASC,
          CASE WHEN data_validade IS NOT NULL AND data_validade < v_hoje THEN 1 ELSE 0 END ASC,
          data_validade ASC NULLS LAST,
          data_recebimento ASC,
          id ASC
        FOR UPDATE
      LOOP
        EXIT WHEN v_restante <= 0;
        v_consumir := LEAST(v_lote.quantidade_atual, v_restante);

        UPDATE public.ingrediente_lotes
        SET quantidade_atual = ROUND(quantidade_atual - v_consumir, 3),
            updated_at = NOW()
        WHERE id = v_lote.id;

        INSERT INTO public.ingrediente_lote_movimentacoes (
          lote_id,
          ingrediente_id,
          ingrediente_movimentacao_id,
          tipo_evento,
          quantidade,
          saldo_lote_anterior,
          saldo_lote_posterior,
          custo_unitario_aplicado,
          compra_id,
          pedido_id,
          motivo,
          usuario_id,
          usuario_nome
        ) VALUES (
          v_lote.id,
          p_ingrediente_id,
          v_mov_id,
          v_tipo_evt_lote,
          v_consumir,
          v_lote.quantidade_atual,
          ROUND(v_lote.quantidade_atual - v_consumir, 3),
          v_lote.custo_unitario_lote,
          p_compra_id,
          p_pedido_id,
          btrim(p_motivo),
          p_usuario_id,
          COALESCE(p_usuario_nome, 'Sistema')
        );

        v_restante := ROUND(v_restante - v_consumir, 3);
      END LOOP;
    END IF;
  END IF;

  -- Gate L7: Verifica invariante crítica SUM(lotes ativos) == ingrediente_saldos.saldo_atual
  PERFORM public._verificar_reconciliacao_lotes_ingrediente(p_ingrediente_id);

  PERFORM set_config('lunoca.in_movimento_ingrediente', v_prev_in_mov, true);
  PERFORM set_config('lunoca.allow_lote_mutation', v_prev_allow_lote, true);

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'movimentacao_id', v_mov_id,
    'ingrediente_id', p_ingrediente_id,
    'saldo_anterior', v_saldo_ant,
    'saldo_posterior', v_saldo_post,
    'custo_medio_anterior', v_cmp_ant,
    'custo_medio_posterior', v_cmp_post,
    'valor_total_movimento', v_valor_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._aplicar_movimento_ingrediente(BIGINT, TEXT, NUMERIC, NUMERIC, TEXT, BIGINT, BIGINT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._aplicar_movimento_ingrediente(BIGINT, TEXT, NUMERIC, NUMERIC, TEXT, BIGINT, BIGINT, UUID, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC: CONFIGURAR_RASTREABILIDADE_INGREDIENTE_ADMIN
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.configurar_rastreabilidade_ingrediente_admin(
  p_ingrediente_id BIGINT,
  p_controlar_lote BOOLEAN,
  p_controlar_validade BOOLEAN,
  p_dias_alerta_validade INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem configurar políticas de lote e validade.');
  END IF;

  IF p_ingrediente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_INGREDIENT', 'error', 'Ingrediente é obrigatório.');
  END IF;

  IF p_dias_alerta_validade IS NOT NULL AND (p_dias_alerta_validade < 1 OR p_dias_alerta_validade > 365) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ALERT_HORIZON', 'error', 'O horizonte de alerta deve estar entre 1 e 365 dias.');
  END IF;

  UPDATE public.ingredientes
  SET
    controlar_lote = COALESCE(p_controlar_lote, false),
    controlar_validade = COALESCE(p_controlar_validade, false),
    dias_alerta_validade = p_dias_alerta_validade,
    updated_at = NOW()
  WHERE id = p_ingrediente_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'INGREDIENT_NOT_FOUND', 'error', 'Ingrediente não encontrado.');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'ingrediente_id', p_ingrediente_id,
    'controlar_lote', COALESCE(p_controlar_lote, false),
    'controlar_validade', COALESCE(p_controlar_validade, false),
    'dias_alerta_validade', p_dias_alerta_validade
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.configurar_rastreabilidade_ingrediente_admin(BIGINT, BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.configurar_rastreabilidade_ingrediente_admin(BIGINT, BOOLEAN, BOOLEAN, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. EVOLUÇÃO DE CRIAR_COMPRA E RECEBER_COMPRA COM SUPORTE A LOTES E VALIDADE (GATES L1, L2, L7)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.criar_compra(
  p_fornecedor_id BIGINT,
  p_itens JSONB,
  p_numero_nota TEXT DEFAULT NULL,
  p_data_compra DATE DEFAULT NULL,
  p_valor_frete NUMERIC DEFAULT 0.00,
  p_valor_desconto NUMERIC DEFAULT 0.00,
  p_observacoes TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_forn RECORD;
  v_compra_existente RECORD;
  v_item JSONB;
  v_ing RECORD;
  v_ing_id BIGINT;
  v_qtd NUMERIC(12,3);
  v_custo NUMERIC(12,4);
  v_sub_item NUMERIC(12,2);
  v_subtotal NUMERIC(12,2) := 0.00;
  v_frete NUMERIC(12,2) := GREATEST(0.00, COALESCE(p_valor_frete, 0.00));
  v_desconto NUMERIC(12,2) := GREATEST(0.00, COALESCE(p_valor_desconto, 0.00));
  v_total NUMERIC(12,2) := 0.00;
  v_compra_id BIGINT;
  v_cod_lote TEXT;
  v_dt_fab DATE;
  v_dt_val DATE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem registrar compras de insumos.');
  END IF;

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT * INTO v_compra_existente
    FROM public.compras
    WHERE idempotency_key = btrim(p_idempotency_key);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'compra_id', v_compra_existente.id,
        'status', v_compra_existente.status,
        'valor_total', v_compra_existente.valor_total
      );
    END IF;
  END IF;

  SELECT * INTO v_forn FROM public.fornecedores WHERE id = p_fornecedor_id AND ativo = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'SUPPLIER_NOT_FOUND', 'error', 'Fornecedor não encontrado ou inativo.');
  END IF;

  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'EMPTY_PURCHASE_ITEMS', 'error', 'A compra deve conter ao menos um insumo.');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_ing_id := (v_item->>'ingrediente_id')::BIGINT;
    v_qtd := ROUND(COALESCE((v_item->>'quantidade')::NUMERIC, 0), 3);
    v_custo := ROUND(COALESCE((v_item->>'custo_unitario')::NUMERIC, -1), 4);

    IF v_ing_id IS NULL OR v_qtd <= 0 OR v_custo < 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PURCHASE_ITEM', 'error', 'Item de compra inválido (verifique ingrediente, quantidade > 0 e custo >= 0).');
    END IF;

    SELECT * INTO v_ing FROM public.ingredientes WHERE id = v_ing_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'INGREDIENT_NOT_FOUND', 'error', format('Ingrediente #%s não encontrado.', v_ing_id));
    END IF;

    v_sub_item := ROUND(v_qtd * v_custo, 2);
    v_subtotal := v_subtotal + v_sub_item;
  END LOOP;

  IF v_desconto > (v_subtotal + v_frete) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_DISCOUNT', 'error', 'Desconto não pode superar o valor da compra.');
  END IF;

  v_total := ROUND(v_subtotal + v_frete - v_desconto, 2);

  INSERT INTO public.compras (
    numero_nota,
    fornecedor_id,
    status,
    data_compra,
    valor_subtotal,
    valor_frete,
    valor_desconto,
    valor_total,
    observacoes,
    criado_por,
    idempotency_key
  ) VALUES (
    NULLIF(btrim(p_numero_nota), ''),
    p_fornecedor_id,
    'aberta',
    COALESCE(p_data_compra, CURRENT_DATE),
    v_subtotal,
    v_frete,
    v_desconto,
    v_total,
    NULLIF(btrim(p_observacoes), ''),
    auth.uid(),
    NULLIF(btrim(p_idempotency_key), '')
  )
  RETURNING id INTO v_compra_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_ing_id := (v_item->>'ingrediente_id')::BIGINT;
    v_qtd := ROUND((v_item->>'quantidade')::NUMERIC, 3);
    v_custo := ROUND((v_item->>'custo_unitario')::NUMERIC, 4);
    v_sub_item := ROUND(v_qtd * v_custo, 2);
    v_cod_lote := NULLIF(btrim(COALESCE(v_item->>'codigo_lote', v_item->>'lote', '')), '');
    v_dt_fab := CASE WHEN NULLIF(btrim(COALESCE(v_item->>'data_fabricacao', '')), '') IS NOT NULL THEN (v_item->>'data_fabricacao')::DATE ELSE NULL END;
    v_dt_val := CASE
      WHEN NULLIF(btrim(COALESCE(v_item->>'data_validade', v_item->>'validade', '')), '') IS NOT NULL
      THEN COALESCE(v_item->>'data_validade', v_item->>'validade')::DATE
      ELSE NULL
    END;

    SELECT unidade INTO v_ing FROM public.ingredientes WHERE id = v_ing_id;

    INSERT INTO public.compra_itens (
      compra_id,
      ingrediente_id,
      quantidade,
      unidade,
      custo_unitario,
      custo_unitario_efetivo,
      subtotal,
      codigo_lote,
      data_fabricacao,
      data_validade
    ) VALUES (
      v_compra_id,
      v_ing_id,
      v_qtd,
      v_ing.unidade,
      v_custo,
      CASE
        WHEN v_subtotal > 0 THEN ROUND(((v_sub_item / v_subtotal) * v_total) / v_qtd, 4)
        ELSE v_custo
      END,
      v_sub_item,
      v_cod_lote,
      v_dt_fab,
      v_dt_val
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'compra_id', v_compra_id,
    'status', 'aberta',
    'valor_subtotal', v_subtotal,
    'valor_total', v_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_compra(BIGINT, JSONB, TEXT, DATE, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_compra(BIGINT, JSONB, TEXT, DATE, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

-- Evolução de receber_compra (mantendo a assinatura de 3 parâmetros da 022 e criando também receber_compra_com_lotes)
CREATE OR REPLACE FUNCTION public.receber_compra_com_lotes(
  p_compra_id BIGINT,
  p_lotes_itens JSONB DEFAULT NULL,
  p_data_vencimento DATE DEFAULT NULL,
  p_gerar_conta_pagar BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_compra RECORD;
  v_forn RECORD;
  v_item RECORD;
  v_ing RECORD;
  v_lote_override JSONB;
  v_cod_lote TEXT;
  v_dt_val DATE;
  v_dt_fab DATE;
  v_mov JSONB;
  v_mov_id BIGINT;
  v_lote_id BIGINT;
  v_saldo_lote_ant NUMERIC(12,3);
  v_usuario_nome TEXT;
  v_conta_id BIGINT;
  v_lotes_criados JSONB := '[]'::jsonb;
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem confirmar o recebimento de compras.');
  END IF;

  SELECT * INTO v_compra
  FROM public.compras
  WHERE id = p_compra_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PURCHASE_NOT_FOUND', 'error', 'Pedido de compra não encontrado.');
  END IF;

  -- Gate L2: Idempotência estrita — se já recebida, retorna os lotes já criados sem duplicar lote nem movimento
  IF v_compra.status = 'recebida' THEN
    SELECT id INTO v_conta_id FROM public.contas_pagar WHERE compra_id = v_compra.id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'lote_id', l.id,
      'ingrediente_id', l.ingrediente_id,
      'codigo_lote', l.codigo_lote,
      'data_validade', l.data_validade,
      'quantidade_inicial', l.quantidade_inicial,
      'quantidade_atual', l.quantidade_atual
    ) ORDER BY l.id ASC), '[]'::jsonb)
    INTO v_lotes_criados
    FROM public.ingrediente_lotes l
    WHERE l.compra_id = v_compra.id;

    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'compra_id', v_compra.id,
      'status', v_compra.status,
      'conta_pagar_id', v_conta_id,
      'lotes', v_lotes_criados
    );
  END IF;

  IF v_compra.status = 'cancelada' THEN
    RETURN jsonb_build_object('success', false, 'code', 'PURCHASE_CANCELLED', 'error', 'Não é possível receber uma compra cancelada.');
  END IF;

  -- Fase 1: Validação prévia de obrigatoriedade de lote e validade para todos os itens
  FOR v_item IN
    SELECT * FROM public.compra_itens
    WHERE compra_id = v_compra.id
    ORDER BY ingrediente_id ASC, id ASC
  LOOP
    SELECT * INTO v_ing FROM public.ingredientes WHERE id = v_item.ingrediente_id;

    v_lote_override := NULL;
    IF p_lotes_itens IS NOT NULL AND jsonb_typeof(p_lotes_itens) = 'array' THEN
      SELECT elem INTO v_lote_override
      FROM jsonb_array_elements(p_lotes_itens) elem
      WHERE (elem->>'ingrediente_id')::BIGINT = v_item.ingrediente_id
      LIMIT 1;
    END IF;

    v_cod_lote := NULLIF(btrim(COALESCE(
      v_lote_override->>'codigo_lote',
      v_lote_override->>'lote',
      v_item.codigo_lote,
      ''
    )), '');

    v_dt_val := COALESCE(
      CASE WHEN NULLIF(btrim(COALESCE(v_lote_override->>'data_validade', v_lote_override->>'validade', '')), '') IS NOT NULL
           THEN COALESCE(v_lote_override->>'data_validade', v_lote_override->>'validade')::DATE
           ELSE NULL END,
      v_item.data_validade
    );

    IF v_ing.controlar_lote AND v_cod_lote IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'LOT_CODE_REQUIRED',
        'error', format('O insumo "%s" exige código de lote no recebimento.', v_ing.nome),
        'ingrediente_id', v_ing.id
      );
    END IF;

    IF v_ing.controlar_validade AND v_dt_val IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'EXPIRY_DATE_REQUIRED',
        'error', format('O insumo "%s" exige data de validade no recebimento.', v_ing.nome),
        'ingrediente_id', v_ing.id
      );
    END IF;
  END LOOP;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  SELECT * INTO v_forn FROM public.fornecedores WHERE id = v_compra.fornecedor_id;

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
  PERFORM set_config('lunoca.lote_already_synced', 'true', true);

  -- Fase 2: Criação dos lotes, lançamento em ingrediente_lote_movimentacoes e atualização do saldo agregado
  FOR v_item IN
    SELECT * FROM public.compra_itens
    WHERE compra_id = v_compra.id
    ORDER BY ingrediente_id ASC, id ASC
  LOOP
    SELECT * INTO v_ing FROM public.ingredientes WHERE id = v_item.ingrediente_id FOR UPDATE;

    v_lote_override := NULL;
    IF p_lotes_itens IS NOT NULL AND jsonb_typeof(p_lotes_itens) = 'array' THEN
      SELECT elem INTO v_lote_override
      FROM jsonb_array_elements(p_lotes_itens) elem
      WHERE (elem->>'ingrediente_id')::BIGINT = v_item.ingrediente_id
      LIMIT 1;
    END IF;

    v_cod_lote := COALESCE(
      NULLIF(btrim(COALESCE(v_lote_override->>'codigo_lote', v_lote_override->>'lote', v_item.codigo_lote, '')), ''),
      format('LOTE-COMP-%s-ITEM-%s', v_compra.id, v_item.id)
    );

    v_dt_val := COALESCE(
      CASE WHEN NULLIF(btrim(COALESCE(v_lote_override->>'data_validade', v_lote_override->>'validade', '')), '') IS NOT NULL
           THEN COALESCE(v_lote_override->>'data_validade', v_lote_override->>'validade')::DATE
           ELSE NULL END,
      v_item.data_validade
    );

    v_dt_fab := COALESCE(
      CASE WHEN NULLIF(btrim(COALESCE(v_lote_override->>'data_fabricacao', '')), '') IS NOT NULL
           THEN (v_lote_override->>'data_fabricacao')::DATE
           ELSE NULL END,
      v_item.data_fabricacao
    );

    UPDATE public.compra_itens
    SET codigo_lote = v_cod_lote,
        data_validade = v_dt_val,
        data_fabricacao = v_dt_fab
    WHERE id = v_item.id;

    SELECT COALESCE(quantidade_atual, 0.000) INTO v_saldo_lote_ant
    FROM public.ingrediente_lotes
    WHERE ingrediente_id = v_item.ingrediente_id
      AND codigo_lote = v_cod_lote
    FOR UPDATE;

    IF NOT FOUND THEN
      v_saldo_lote_ant := 0.000;
    END IF;

    INSERT INTO public.ingrediente_lotes (
      ingrediente_id,
      fornecedor_id,
      compra_id,
      compra_item_id,
      codigo_lote,
      data_recebimento,
      data_fabricacao,
      data_validade,
      quantidade_inicial,
      quantidade_atual,
      custo_unitario_lote,
      observacoes,
      idempotency_key,
      created_at,
      updated_at
    ) VALUES (
      v_item.ingrediente_id,
      v_compra.fornecedor_id,
      v_compra.id,
      v_item.id,
      v_cod_lote,
      v_hoje,
      v_dt_fab,
      v_dt_val,
      v_item.quantidade,
      v_item.quantidade,
      v_item.custo_unitario_efetivo,
      format('Recebimento Compra #%s (%s)', v_compra.id, COALESCE(v_forn.nome, 'Fornecedor')),
      format('lote_compra_%s_item_%s', v_compra.id, v_item.id),
      NOW(),
      NOW()
    )
    ON CONFLICT (ingrediente_id, codigo_lote) DO UPDATE
      SET quantidade_inicial = public.ingrediente_lotes.quantidade_inicial + EXCLUDED.quantidade_inicial,
          quantidade_atual = public.ingrediente_lotes.quantidade_atual + EXCLUDED.quantidade_atual,
          data_validade = COALESCE(EXCLUDED.data_validade, public.ingrediente_lotes.data_validade),
          custo_unitario_lote = EXCLUDED.custo_unitario_lote,
          compra_id = EXCLUDED.compra_id,
          fornecedor_id = EXCLUDED.fornecedor_id,
          updated_at = NOW()
    RETURNING id INTO v_lote_id;

    -- Atualiza o saldo agregado e livro-razão de insumos (que no final valida _verificar_reconciliacao_lotes_ingrediente)
    v_mov := public._aplicar_movimento_ingrediente(
      p_ingrediente_id => v_item.ingrediente_id,
      p_tipo => 'entrada_compra',
      p_quantidade => v_item.quantidade,
      p_custo_unitario => v_item.custo_unitario_efetivo,
      p_motivo => format('Recebimento de Compra #%s - Lote %s (%s)', v_compra.id, v_cod_lote, COALESCE(v_forn.nome, 'Fornecedor')),
      p_compra_id => v_compra.id,
      p_pedido_id => NULL,
      p_usuario_id => auth.uid(),
      p_usuario_nome => COALESCE(v_usuario_nome, 'Administrador'),
      p_idempotency_key => format('rec_compra_%s_item_%s', v_compra.id, v_item.id)
    );

    IF NOT COALESCE((v_mov->>'success')::BOOLEAN, false) THEN
      RAISE EXCEPTION '%', v_mov->>'error';
    END IF;

    v_mov_id := (v_mov->>'movimentacao_id')::BIGINT;

    INSERT INTO public.ingrediente_lote_movimentacoes (
      lote_id,
      ingrediente_id,
      ingrediente_movimentacao_id,
      tipo_evento,
      quantidade,
      saldo_lote_anterior,
      saldo_lote_posterior,
      custo_unitario_aplicado,
      compra_id,
      pedido_id,
      motivo,
      usuario_id,
      usuario_nome,
      idempotency_key
    ) VALUES (
      v_lote_id,
      v_item.ingrediente_id,
      v_mov_id,
      'ENTRADA_COMPRA',
      v_item.quantidade,
      v_saldo_lote_ant,
      ROUND(v_saldo_lote_ant + v_item.quantidade, 3),
      v_item.custo_unitario_efetivo,
      v_compra.id,
      NULL,
      format('Entrada por recebimento da Compra #%s (Lote %s)', v_compra.id, v_cod_lote),
      auth.uid(),
      COALESCE(v_usuario_nome, 'Administrador'),
      format('lote_mov_compra_%s_item_%s', v_compra.id, v_item.id)
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    v_lotes_criados := v_lotes_criados || jsonb_build_array(jsonb_build_object(
      'lote_id', v_lote_id,
      'ingrediente_id', v_item.ingrediente_id,
      'codigo_lote', v_cod_lote,
      'data_validade', v_dt_val,
      'quantidade_inicial', v_item.quantidade,
      'quantidade_atual', ROUND(v_saldo_lote_ant + v_item.quantidade, 3)
    ));
  END LOOP;

  PERFORM set_config('lunoca.lote_already_synced', '', true);
  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  UPDATE public.compras
  SET
    status = 'recebida',
    data_recebimento = NOW(),
    recebido_por = auth.uid(),
    updated_at = NOW()
  WHERE id = v_compra.id;

  IF COALESCE(p_gerar_conta_pagar, true) AND v_compra.valor_total > 0 THEN
    INSERT INTO public.contas_pagar (
      compra_id,
      fornecedor_id,
      descricao,
      categoria,
      valor_total,
      valor_pago,
      saldo_aberto,
      data_vencimento,
      status
    ) VALUES (
      v_compra.id,
      v_compra.fornecedor_id,
      format('Compra #%s - %s%s', v_compra.id, COALESCE(v_forn.nome, 'Fornecedor'), CASE WHEN v_compra.numero_nota IS NOT NULL THEN ' (NF ' || v_compra.numero_nota || ')' ELSE '' END),
      'Insumos / Fornecedores',
      v_compra.valor_total,
      0.00,
      v_compra.valor_total,
      COALESCE(p_data_vencimento, CURRENT_DATE + 7),
      'aberta'
    )
    ON CONFLICT (compra_id) DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_conta_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'compra_id', v_compra.id,
    'status', 'recebida',
    'conta_pagar_id', v_conta_id,
    'lotes', v_lotes_criados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.receber_compra_com_lotes(BIGINT, JSONB, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receber_compra_com_lotes(BIGINT, JSONB, DATE, BOOLEAN) TO authenticated, service_role;

-- Evolui receber_compra(BIGINT, DATE, BOOLEAN) delegando para receber_compra_com_lotes
CREATE OR REPLACE FUNCTION public.receber_compra(
  p_compra_id BIGINT,
  p_data_vencimento DATE DEFAULT NULL,
  p_gerar_conta_pagar BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
BEGIN
  RETURN public.receber_compra_com_lotes(
    p_compra_id => p_compra_id,
    p_lotes_itens => NULL,
    p_data_vencimento => p_data_vencimento,
    p_gerar_conta_pagar => p_gerar_conta_pagar
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.receber_compra(BIGINT, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receber_compra(BIGINT, DATE, BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPC: CONSUMIR_INSUMOS_PRODUCAO_PEDIDO (SELEÇÃO FEFO SERVER-SIDE COM FOR UPDATE)
--     GATES L3, L4, L5, L6, L7, L11
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consumir_insumos_producao_pedido(
  p_pedido_id BIGINT,
  p_itens_consumo JSONB DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_key_base TEXT;
  v_ja_consumido BOOLEAN := false;
  v_nec RECORD;
  v_ing RECORD;
  v_lote RECORD;
  v_disp_elegivel NUMERIC(12,3);
  v_restante NUMERIC(12,3);
  v_consumir NUMERIC(12,3);
  v_mov JSONB;
  v_mov_id BIGINT;
  v_lote_mov_id BIGINT;
  v_consumos_gerados JSONB := '[]'::jsonb;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas a equipe autorizada pode registrar consumo produtivo de insumos.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  -- Lock no pedido para serializar chamadas concorrentes do mesmo pedido (Gate L6)
  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode consumir insumos de produção.');
  END IF;

  v_key_base := COALESCE(NULLIF(btrim(COALESCE(p_chave_idempotencia, '')), ''), 'fefo_ped_' || p_pedido_id::TEXT);

  -- Verifica idempotência: se já houver consumo registrado com o prefixo v_key_base
  SELECT EXISTS (
    SELECT 1 FROM public.pedido_consumos_lote
    WHERE pedido_id = p_pedido_id
      AND idempotency_key LIKE v_key_base || ':%'
  ) INTO v_ja_consumido;

  IF v_ja_consumido THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'pedido_id', pcl.pedido_id,
      'ingrediente_id', pcl.ingrediente_id,
      'lote_id', pcl.lote_id,
      'codigo_lote', pcl.codigo_lote_snapshot,
      'data_validade', pcl.data_validade_snapshot,
      'quantidade_consumida', pcl.quantidade_consumida,
      'unidade', pcl.unidade
    ) ORDER BY pcl.id ASC), '[]'::jsonb)
    INTO v_consumos_gerados
    FROM public.pedido_consumos_lote pcl
    WHERE pcl.pedido_id = p_pedido_id
      AND pcl.idempotency_key LIKE v_key_base || ':%';

    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'consumos_lote', v_consumos_gerados
    );
  END IF;

  SELECT COALESCE(nome, email, 'Equipe Produção') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
  PERFORM set_config('lunoca.lote_already_synced', 'true', true);

  -- Iterar pelas necessidades de insumos em ordem estrita de ingrediente_id ASC (evita deadlocks em L6)
  FOR v_nec IN
    SELECT
      t.ingrediente_id,
      ROUND(SUM(t.quantidade), 3) AS qtd_necessaria,
      MAX(t.pedido_item_id) AS pedido_item_id,
      MAX(t.produto_id) AS produto_id
    FROM (
      -- Se p_itens_consumo foi fornecido explicitamente, usa-o; caso contrário, deriva da ficha técnica do pedido
      SELECT
        (elem->>'ingrediente_id')::BIGINT AS ingrediente_id,
        ROUND((elem->>'quantidade')::NUMERIC, 3) AS quantidade,
        (elem->>'pedido_item_id')::BIGINT AS pedido_item_id,
        (elem->>'produto_id')::BIGINT AS produto_id
      FROM jsonb_array_elements(
        CASE
          WHEN p_itens_consumo IS NOT NULL AND jsonb_typeof(p_itens_consumo) = 'array' AND jsonb_array_length(p_itens_consumo) > 0
          THEN p_itens_consumo
          ELSE '[]'::jsonb
        END
      ) elem
      UNION ALL
      SELECT
        pi.ingrediente_id,
        ROUND(pi.quantidade * item.quantidade, 3) AS quantidade,
        item.id AS pedido_item_id,
        item.produto_id
      FROM public.pedido_itens item
      JOIN public.produto_ingredientes pi ON pi.produto_id = item.produto_id
      WHERE item.pedido_id = p_pedido_id
        AND (p_itens_consumo IS NULL OR jsonb_typeof(p_itens_consumo) <> 'array' OR jsonb_array_length(p_itens_consumo) = 0)
    ) t
    WHERE t.ingrediente_id IS NOT NULL AND t.quantidade > 0
    GROUP BY t.ingrediente_id
    ORDER BY t.ingrediente_id ASC
  LOOP
    -- Lock no ingrediente e no saldo consolidado (Gate L6)
    SELECT * INTO v_ing
    FROM public.ingredientes
    WHERE id = v_nec.ingrediente_id
    FOR UPDATE;

    IF NOT FOUND THEN
      PERFORM set_config('lunoca.lote_already_synced', '', true);
      PERFORM set_config('lunoca.allow_lote_mutation', '', true);
      RETURN jsonb_build_object('success', false, 'code', 'INGREDIENT_NOT_FOUND', 'error', format('Ingrediente #%s não encontrado.', v_nec.ingrediente_id));
    END IF;

    PERFORM 1 FROM public.ingrediente_saldos WHERE ingrediente_id = v_nec.ingrediente_id FOR UPDATE;

    -- Gate L3, L4, L5, L6: Calcula total elegível (lotes ativos, NÃO bloqueados e NÃO vencidos)
    SELECT COALESCE(ROUND(SUM(l.quantidade_atual), 3), 0.000)
    INTO v_disp_elegivel
    FROM public.ingrediente_lotes l
    WHERE l.ingrediente_id = v_nec.ingrediente_id
      AND l.quantidade_atual > 0
      AND l.bloqueado_qualidade = false
      AND (l.data_validade IS NULL OR l.data_validade >= v_hoje);

    IF v_disp_elegivel < v_nec.qtd_necessaria THEN
      PERFORM set_config('lunoca.lote_already_synced', '', true);
      PERFORM set_config('lunoca.allow_lote_mutation', '', true);
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INSUFFICIENT_ELIGIBLE_LOT_STOCK',
        'error', format('Saldo elegível insuficiente em lotes válidos/desbloqueados para "%s" (disponível elegível: %s, necessário: %s).', v_ing.nome, v_disp_elegivel, v_nec.qtd_necessaria),
        'ingrediente_id', v_ing.id,
        'saldo_elegivel_lotes', v_disp_elegivel,
        'quantidade_necessaria', v_nec.qtd_necessaria
      );
    END IF;

    -- Seleção FEFO (First Expire, First Out) com FOR UPDATE nos lotes elegíveis
    v_restante := v_nec.qtd_necessaria;

    FOR v_lote IN
      SELECT *
      FROM public.ingrediente_lotes l
      WHERE l.ingrediente_id = v_nec.ingrediente_id
        AND l.quantidade_atual > 0
        AND l.bloqueado_qualidade = false
        AND (l.data_validade IS NULL OR l.data_validade >= v_hoje)
      ORDER BY l.data_validade ASC NULLS LAST, l.data_recebimento ASC, l.id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_restante <= 0;

      v_consumir := LEAST(v_lote.quantidade_atual, v_restante);

      UPDATE public.ingrediente_lotes
      SET quantidade_atual = ROUND(quantidade_atual - v_consumir, 3),
          updated_at = NOW()
      WHERE id = v_lote.id;

      INSERT INTO public.ingrediente_lote_movimentacoes (
        lote_id,
        ingrediente_id,
        tipo_evento,
        quantidade,
        saldo_lote_anterior,
        saldo_lote_posterior,
        custo_unitario_aplicado,
        pedido_id,
        motivo,
        usuario_id,
        usuario_nome,
        idempotency_key
      ) VALUES (
        v_lote.id,
        v_nec.ingrediente_id,
        'CONSUMO_PRODUCAO',
        v_consumir,
        v_lote.quantidade_atual,
        ROUND(v_lote.quantidade_atual - v_consumir, 3),
        v_lote.custo_unitario_lote,
        p_pedido_id,
        format('Consumo FEFO em produção - Pedido #%s (Lote %s)', p_pedido_id, v_lote.codigo_lote),
        auth.uid(),
        COALESCE(v_usuario_nome, 'Equipe Produção'),
        v_key_base || ':mov:ing:' || v_nec.ingrediente_id::TEXT || ':lote:' || v_lote.id::TEXT
      )
      RETURNING id INTO v_lote_mov_id;

      INSERT INTO public.pedido_consumos_lote (
        pedido_id,
        pedido_item_id,
        produto_id,
        ingrediente_id,
        lote_id,
        lote_movimentacao_id,
        codigo_lote_snapshot,
        data_validade_snapshot,
        quantidade_consumida,
        unidade,
        custo_unitario_lote_snapshot,
        consumido_em,
        registrado_por,
        registrado_por_nome,
        idempotency_key
      ) VALUES (
        p_pedido_id,
        v_nec.pedido_item_id,
        v_nec.produto_id,
        v_nec.ingrediente_id,
        v_lote.id,
        v_lote_mov_id,
        v_lote.codigo_lote,
        v_lote.data_validade,
        v_consumir,
        v_ing.unidade,
        v_lote.custo_unitario_lote,
        NOW(),
        auth.uid(),
        COALESCE(v_usuario_nome, 'Equipe Produção'),
        v_key_base || ':pcl:ing:' || v_nec.ingrediente_id::TEXT || ':lote:' || v_lote.id::TEXT
      );

      v_consumos_gerados := v_consumos_gerados || jsonb_build_array(jsonb_build_object(
        'pedido_id', p_pedido_id,
        'ingrediente_id', v_nec.ingrediente_id,
        'ingrediente_nome', v_ing.nome,
        'lote_id', v_lote.id,
        'codigo_lote', v_lote.codigo_lote,
        'data_validade', v_lote.data_validade,
        'quantidade_consumida', v_consumir,
        'unidade', v_ing.unidade
      ));

      v_restante := ROUND(v_restante - v_consumir, 3);
    END LOOP;

    -- Baixa consolidada em ingrediente_saldos + ingrediente_movimentacoes + validação Gate L7
    v_mov := public._aplicar_movimento_ingrediente(
      p_ingrediente_id => v_nec.ingrediente_id,
      p_tipo => 'consumo_producao',
      p_quantidade => v_nec.qtd_necessaria,
      p_custo_unitario => NULL,
      p_motivo => format('Consumo produtivo FEFO - Pedido #%s', p_pedido_id),
      p_compra_id => NULL,
      p_pedido_id => p_pedido_id,
      p_usuario_id => auth.uid(),
      p_usuario_nome => COALESCE(v_usuario_nome, 'Equipe Produção'),
      p_idempotency_key => v_key_base || ':agg:ing:' || v_nec.ingrediente_id::TEXT
    );

    IF NOT COALESCE((v_mov->>'success')::BOOLEAN, false) THEN
      RAISE EXCEPTION '%', v_mov->>'error';
    END IF;
  END LOOP;

  PERFORM set_config('lunoca.lote_already_synced', '', true);
  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'pedido_id', p_pedido_id,
    'consumos_lote', v_consumos_gerados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.consumir_insumos_producao_pedido(BIGINT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumir_insumos_producao_pedido(BIGINT, JSONB, TEXT) TO authenticated, service_role;

-- Evolui dar_baixa_ingredientes_pedido para usar o motor FEFO rastreável por lote quando houver lotes elegíveis
CREATE OR REPLACE FUNCTION public.dar_baixa_ingredientes_pedido(p_pedido_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_rec RECORD;
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_disp_elegivel NUMERIC(12,3);
  v_qtd_baixar NUMERIC(12,3);
  v_itens JSONB := '[]'::jsonb;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.pedido_itens WHERE pedido_id = p_pedido_id) THEN
    FOR v_rec IN
      SELECT
        pi.ingrediente_id,
        ROUND(SUM(pi.quantidade * item.quantidade), 3) AS qtd_total,
        MAX(item.id) AS pedido_item_id,
        MAX(item.produto_id) AS produto_id
      FROM public.pedido_itens item
      JOIN public.produto_ingredientes pi ON pi.produto_id = item.produto_id
      JOIN public.ingredientes i ON i.id = pi.ingrediente_id AND i.ativo = true
      WHERE item.pedido_id = p_pedido_id
      GROUP BY pi.ingrediente_id
      ORDER BY pi.ingrediente_id ASC
    LOOP
      SELECT COALESCE(ROUND(SUM(l.quantidade_atual), 3), 0.000)
      INTO v_disp_elegivel
      FROM public.ingrediente_lotes l
      WHERE l.ingrediente_id = v_rec.ingrediente_id
        AND l.quantidade_atual > 0
        AND l.bloqueado_qualidade = false
        AND (l.data_validade IS NULL OR l.data_validade >= v_hoje);

      v_qtd_baixar := LEAST(COALESCE(v_disp_elegivel, 0), v_rec.qtd_total);
      IF v_qtd_baixar > 0 THEN
        v_itens := v_itens || jsonb_build_array(jsonb_build_object(
          'ingrediente_id', v_rec.ingrediente_id,
          'quantidade', v_qtd_baixar,
          'pedido_item_id', v_rec.pedido_item_id,
          'produto_id', v_rec.produto_id
        ));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_itens) > 0 THEN
      PERFORM public.consumir_insumos_producao_pedido(
        p_pedido_id => p_pedido_id,
        p_itens_consumo => v_itens,
        p_chave_idempotencia => 'consumo_auto_ped_' || p_pedido_id::TEXT
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 12. RPCs DE PERDA/VENCIMENTO POR LOTE, AJUSTE DE CONTAGEM E BLOQUEIO (GATES L5, L8, L9)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_baixa_lote_insumo(
  p_lote_id BIGINT,
  p_tipo_evento TEXT,
  p_quantidade NUMERIC,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_lote public.ingrediente_lotes;
  v_mov_lote_existente public.ingrediente_lote_movimentacoes;
  v_tipo TEXT := UPPER(TRIM(COALESCE(p_tipo_evento, 'PERDA')));
  v_usuario_nome TEXT;
  v_mov_agg JSONB;
  v_mov_agg_id BIGINT;
  v_mov_lote_id BIGINT;
  v_key TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode registrar baixa ou perda por lote.');
  END IF;

  IF p_lote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'LOT_ID_REQUIRED', 'error', 'ID do lote é obrigatório.');
  END IF;

  IF v_tipo NOT IN ('PERDA', 'VENCIMENTO', 'DEVOLUCAO') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_LOT_EVENT', 'error', 'Tipo de baixa inválido. Use PERDA, VENCIMENTO ou DEVOLUCAO.');
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'A quantidade deve ser maior que zero.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe um motivo auditável (mínimo 5 caracteres).');
  END IF;

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT * INTO v_mov_lote_existente
    FROM public.ingrediente_lote_movimentacoes
    WHERE idempotency_key = btrim(p_idempotency_key);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'lote_id', v_mov_lote_existente.lote_id,
        'ingrediente_id', v_mov_lote_existente.ingrediente_id,
        'lote_movimentacao_id', v_mov_lote_existente.id,
        'saldo_lote_anterior', v_mov_lote_existente.saldo_lote_anterior,
        'saldo_lote_posterior', v_mov_lote_existente.saldo_lote_posterior
      );
    END IF;
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
  PERFORM set_config('lunoca.lote_already_synced', 'true', true);

  SELECT * INTO v_lote
  FROM public.ingrediente_lotes
  WHERE id = p_lote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM set_config('lunoca.lote_already_synced', '', true);
    PERFORM set_config('lunoca.allow_lote_mutation', '', true);
    RETURN jsonb_build_object('success', false, 'code', 'LOT_NOT_FOUND', 'error', 'Lote não encontrado.');
  END IF;

  IF v_lote.quantidade_atual < ROUND(p_quantidade, 3) THEN
    PERFORM set_config('lunoca.lote_already_synced', '', true);
    PERFORM set_config('lunoca.allow_lote_mutation', '', true);
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INSUFFICIENT_LOT_BALANCE',
      'error', format('Saldo insuficiente no lote %s (disponível: %s, solicitado: %s).', v_lote.codigo_lote, v_lote.quantidade_atual, p_quantidade)
    );
  END IF;

  SELECT COALESCE(nome, email, 'Equipe') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  UPDATE public.ingrediente_lotes
  SET quantidade_atual = ROUND(quantidade_atual - p_quantidade, 3),
      updated_at = NOW()
  WHERE id = v_lote.id;

  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  -- Gate L8: Atualiza o saldo agregado uma única vez e valida reconciliação L7
  v_mov_agg := public._aplicar_movimento_ingrediente(
    p_ingrediente_id => v_lote.ingrediente_id,
    p_tipo => 'perda',
    p_quantidade => ROUND(p_quantidade, 3),
    p_custo_unitario => NULL,
    p_motivo => format('%s no Lote %s: %s', v_tipo, v_lote.codigo_lote, btrim(p_motivo)),
    p_compra_id => v_lote.compra_id,
    p_pedido_id => NULL,
    p_usuario_id => auth.uid(),
    p_usuario_nome => COALESCE(v_usuario_nome, 'Equipe'),
    p_idempotency_key => CASE WHEN v_key IS NOT NULL THEN 'agg:' || v_key ELSE NULL END
  );

  IF NOT COALESCE((v_mov_agg->>'success')::BOOLEAN, false) THEN
    RAISE EXCEPTION '%', v_mov_agg->>'error';
  END IF;

  v_mov_agg_id := (v_mov_agg->>'movimentacao_id')::BIGINT;

  INSERT INTO public.ingrediente_lote_movimentacoes (
    lote_id,
    ingrediente_id,
    ingrediente_movimentacao_id,
    tipo_evento,
    quantidade,
    saldo_lote_anterior,
    saldo_lote_posterior,
    custo_unitario_aplicado,
    compra_id,
    motivo,
    usuario_id,
    usuario_nome,
    idempotency_key
  ) VALUES (
    v_lote.id,
    v_lote.ingrediente_id,
    v_mov_agg_id,
    v_tipo,
    ROUND(p_quantidade, 3),
    v_lote.quantidade_atual,
    ROUND(v_lote.quantidade_atual - p_quantidade, 3),
    v_lote.custo_unitario_lote,
    v_lote.compra_id,
    btrim(p_motivo),
    auth.uid(),
    COALESCE(v_usuario_nome, 'Equipe'),
    v_key
  )
  RETURNING id INTO v_mov_lote_id;

  PERFORM set_config('lunoca.lote_already_synced', '', true);
  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'lote_id', v_lote.id,
    'codigo_lote', v_lote.codigo_lote,
    'ingrediente_id', v_lote.ingrediente_id,
    'tipo_evento', v_tipo,
    'lote_movimentacao_id', v_mov_lote_id,
    'ingrediente_movimentacao_id', v_mov_agg_id,
    'saldo_lote_anterior', v_lote.quantidade_atual,
    'saldo_lote_posterior', ROUND(v_lote.quantidade_atual - p_quantidade, 3),
    'saldo_agregado_posterior', (v_mov_agg->>'saldo_posterior')::NUMERIC
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_baixa_lote_insumo(BIGINT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_baixa_lote_insumo(BIGINT, TEXT, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

-- Gate L9: Ajuste de contagem de lote mantendo trilha append-only e reconciliação com ingrediente_saldos
CREATE OR REPLACE FUNCTION public.ajustar_lote_insumo_admin(
  p_lote_id BIGINT,
  p_nova_quantidade NUMERIC,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote public.ingrediente_lotes;
  v_mov_existente public.ingrediente_lote_movimentacoes;
  v_delta NUMERIC(12,3);
  v_tipo_agg TEXT;
  v_usuario_nome TEXT;
  v_mov_agg JSONB;
  v_mov_agg_id BIGINT;
  v_mov_lote_id BIGINT;
  v_key TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem ajustar contagem de lotes.');
  END IF;

  IF p_lote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'LOT_ID_REQUIRED', 'error', 'ID do lote é obrigatório.');
  END IF;

  IF p_nova_quantidade IS NULL OR p_nova_quantidade < 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'A nova quantidade do lote não pode ser negativa.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe um motivo auditável (mínimo 5 caracteres).');
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_mov_existente
    FROM public.ingrediente_lote_movimentacoes
    WHERE idempotency_key = v_key;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'lote_id', v_mov_existente.lote_id,
        'lote_movimentacao_id', v_mov_existente.id,
        'saldo_lote_anterior', v_mov_existente.saldo_lote_anterior,
        'saldo_lote_posterior', v_mov_existente.saldo_lote_posterior
      );
    END IF;
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
  PERFORM set_config('lunoca.lote_already_synced', 'true', true);

  SELECT * INTO v_lote
  FROM public.ingrediente_lotes
  WHERE id = p_lote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM set_config('lunoca.lote_already_synced', '', true);
    PERFORM set_config('lunoca.allow_lote_mutation', '', true);
    RETURN jsonb_build_object('success', false, 'code', 'LOT_NOT_FOUND', 'error', 'Lote não encontrado.');
  END IF;

  v_delta := ROUND(p_nova_quantidade - v_lote.quantidade_atual, 3);
  IF v_delta = 0 THEN
    PERFORM set_config('lunoca.lote_already_synced', '', true);
    PERFORM set_config('lunoca.allow_lote_mutation', '', true);
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'lote_id', v_lote.id,
      'saldo_lote_anterior', v_lote.quantidade_atual,
      'saldo_lote_posterior', v_lote.quantidade_atual
    );
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  UPDATE public.ingrediente_lotes
  SET
    quantidade_inicial = GREATEST(quantidade_inicial, ROUND(p_nova_quantidade, 3)),
    quantidade_atual = ROUND(p_nova_quantidade, 3),
    updated_at = NOW()
  WHERE id = v_lote.id;

  v_tipo_agg := CASE WHEN v_delta > 0 THEN 'ajuste_entrada' ELSE 'ajuste_saida' END;

  v_mov_agg := public._aplicar_movimento_ingrediente(
    p_ingrediente_id => v_lote.ingrediente_id,
    p_tipo => v_tipo_agg,
    p_quantidade => ABS(v_delta),
    p_custo_unitario => v_lote.custo_unitario_lote,
    p_motivo => format('Ajuste de contagem Lote %s: %s', v_lote.codigo_lote, btrim(p_motivo)),
    p_compra_id => v_lote.compra_id,
    p_pedido_id => NULL,
    p_usuario_id => auth.uid(),
    p_usuario_nome => COALESCE(v_usuario_nome, 'Administrador'),
    p_idempotency_key => CASE WHEN v_key IS NOT NULL THEN 'agg:' || v_key ELSE NULL END
  );

  IF NOT COALESCE((v_mov_agg->>'success')::BOOLEAN, false) THEN
    RAISE EXCEPTION '%', v_mov_agg->>'error';
  END IF;

  v_mov_agg_id := (v_mov_agg->>'movimentacao_id')::BIGINT;

  INSERT INTO public.ingrediente_lote_movimentacoes (
    lote_id,
    ingrediente_id,
    ingrediente_movimentacao_id,
    tipo_evento,
    quantidade,
    saldo_lote_anterior,
    saldo_lote_posterior,
    custo_unitario_aplicado,
    compra_id,
    motivo,
    usuario_id,
    usuario_nome,
    idempotency_key
  ) VALUES (
    v_lote.id,
    v_lote.ingrediente_id,
    v_mov_agg_id,
    'AJUSTE_CONTAGEM',
    ABS(v_delta),
    v_lote.quantidade_atual,
    ROUND(p_nova_quantidade, 3),
    v_lote.custo_unitario_lote,
    v_lote.compra_id,
    btrim(p_motivo),
    auth.uid(),
    COALESCE(v_usuario_nome, 'Administrador'),
    v_key
  )
  RETURNING id INTO v_mov_lote_id;

  PERFORM set_config('lunoca.lote_already_synced', '', true);
  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'lote_id', v_lote.id,
    'codigo_lote', v_lote.codigo_lote,
    'lote_movimentacao_id', v_mov_lote_id,
    'ingrediente_movimentacao_id', v_mov_agg_id,
    'saldo_lote_anterior', v_lote.quantidade_atual,
    'saldo_lote_posterior', ROUND(p_nova_quantidade, 3),
    'saldo_agregado_posterior', (v_mov_agg->>'saldo_posterior')::NUMERIC
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_lote_insumo_admin(BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_lote_insumo_admin(BIGINT, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

-- Gate L5: Bloqueio/desbloqueio de lote por qualidade
CREATE OR REPLACE FUNCTION public.alterar_bloqueio_qualidade_lote(
  p_lote_id BIGINT,
  p_bloquear BOOLEAN,
  p_motivo TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_lote public.ingrediente_lotes;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode bloquear ou desbloquear lotes por qualidade.');
  END IF;

  IF p_lote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'LOT_ID_REQUIRED', 'error', 'ID do lote é obrigatório.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe o motivo técnico (mínimo 5 caracteres).');
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);

  SELECT * INTO v_lote
  FROM public.ingrediente_lotes
  WHERE id = p_lote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM set_config('lunoca.allow_lote_mutation', '', true);
    RETURN jsonb_build_object('success', false, 'code', 'LOT_NOT_FOUND', 'error', 'Lote não encontrado.');
  END IF;

  SELECT COALESCE(nome, email, 'Equipe Qualidade') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  UPDATE public.ingrediente_lotes
  SET
    bloqueado_qualidade = COALESCE(p_bloquear, true),
    motivo_bloqueio = CASE WHEN COALESCE(p_bloquear, true) THEN btrim(p_motivo) ELSE NULL END,
    bloqueado_em = CASE WHEN COALESCE(p_bloquear, true) THEN NOW() ELSE NULL END,
    bloqueado_por = CASE WHEN COALESCE(p_bloquear, true) THEN auth.uid() ELSE NULL END,
    updated_at = NOW()
  WHERE id = v_lote.id;

  IF COALESCE(p_bloquear, true) THEN
    INSERT INTO public.producao_ocorrencias_qualidade (
      lote_id,
      severidade,
      tipo_ocorrencia,
      descricao,
      registrado_por,
      registrado_por_nome
    ) VALUES (
      v_lote.id,
      'critica',
      'CONTAMINACAO_OU_DANO_LOTE',
      btrim(p_motivo),
      auth.uid(),
      COALESCE(v_usuario_nome, 'Equipe Qualidade')
    );
  ELSE
    UPDATE public.producao_ocorrencias_qualidade
    SET resolvida = true,
        acao_corretiva = btrim(p_motivo),
        resolvida_em = NOW(),
        resolvida_por = auth.uid()
    WHERE lote_id = v_lote.id
      AND resolvida = false;
  END IF;

  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'lote_id', v_lote.id,
    'codigo_lote', v_lote.codigo_lote,
    'bloqueado_qualidade', COALESCE(p_bloquear, true),
    'estado_validade', public._derivar_estado_validade_lote(v_lote.quantidade_atual, v_lote.data_validade, COALESCE(p_bloquear, true))
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_bloqueio_qualidade_lote(BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_bloqueio_qualidade_lote(BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. CONTROLE DE QUALIDADE EM PRODUÇÃO E BLOQUEIO DE AVANÇO (GATES L14, L15, L16)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pedido_possui_bloqueio_qualidade_ativo(
  p_pedido_id BIGINT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_bloqueado BOOLEAN := false;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN false;
  END IF;

  -- Verifica se o checkpoint mais recente de qualquer etapa do pedido está com resultado = 'REPROVADO'
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (cq.etapa)
        cq.etapa,
        cq.resultado,
        cq.bloqueia_avanco
      FROM public.producao_controles_qualidade cq
      WHERE cq.pedido_id = p_pedido_id
      ORDER BY cq.etapa, cq.id DESC
    ) ult
    WHERE ult.resultado = 'REPROVADO' OR ult.bloqueia_avanco = true
  ) INTO v_bloqueado;

  RETURN COALESCE(v_bloqueado, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public._pedido_possui_bloqueio_qualidade_ativo(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pedido_possui_bloqueio_qualidade_ativo(BIGINT) TO service_role;

CREATE OR REPLACE FUNCTION public.registrar_controle_qualidade_pedido(
  p_pedido_id BIGINT,
  p_etapa TEXT,
  p_resultado TEXT,
  p_observacao TEXT DEFAULT NULL,
  p_reinspecao_de_id BIGINT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_etapa TEXT := UPPER(TRIM(COALESCE(p_etapa, '')));
  v_res TEXT := UPPER(TRIM(COALESCE(p_resultado, '')));
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_cq_existente public.producao_controles_qualidade;
  v_bloqueia BOOLEAN;
  v_usuario_nome TEXT;
  v_cq_id BIGINT;
  v_ocorr_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode registrar checkpoints de qualidade.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_etapa NOT IN ('PRE_PRODUCAO', 'FINALIZACAO', 'EMBALAGEM', 'EXPEDICAO') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_QUALITY_STAGE',
      'error', 'Etapa inválida. Utilize PRE_PRODUCAO, FINALIZACAO, EMBALAGEM ou EXPEDICAO.'
    );
  END IF;

  IF v_res NOT IN ('APROVADO', 'REPROVADO', 'APROVADO_COM_RESSALVA') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_QUALITY_RESULT',
      'error', 'Resultado inválido. Utilize APROVADO, REPROVADO ou APROVADO_COM_RESSALVA.'
    );
  END IF;

  IF v_res IN ('REPROVADO', 'APROVADO_COM_RESSALVA') AND (v_obs IS NULL OR char_length(v_obs) < 3) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OBSERVATION_REQUIRED',
      'error', 'Informe a observação técnica para reprovação ou aprovação com ressalva.'
    );
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_cq_existente
    FROM public.producao_controles_qualidade
    WHERE idempotency_key = v_key;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'controle_id', v_cq_existente.id,
        'pedido_id', v_cq_existente.pedido_id,
        'etapa', v_cq_existente.etapa,
        'resultado', v_cq_existente.resultado,
        'bloqueia_avanco', v_cq_existente.bloqueia_avanco,
        'pedido_bloqueado_qualidade', public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id)
      );
    END IF;
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  SELECT COALESCE(nome, email, 'Equipe Qualidade') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Qualidade'; END IF;

  v_bloqueia := (v_res = 'REPROVADO');

  -- Se não foi informado p_reinspecao_de_id, vincula automaticamente ao último REPROVADO da mesma etapa, se houver
  IF p_reinspecao_de_id IS NULL AND v_res IN ('APROVADO', 'APROVADO_COM_RESSALVA') THEN
    SELECT id INTO p_reinspecao_de_id
    FROM public.producao_controles_qualidade
    WHERE pedido_id = p_pedido_id
      AND etapa = v_etapa
      AND resultado = 'REPROVADO'
    ORDER BY id DESC
    LIMIT 1;
  END IF;

  INSERT INTO public.producao_controles_qualidade (
    pedido_id,
    etapa,
    resultado,
    bloqueia_avanco,
    observacao,
    reinspecao_de_id,
    responsavel_id,
    responsavel_nome,
    idempotency_key,
    registrado_em
  ) VALUES (
    p_pedido_id,
    v_etapa,
    v_res,
    v_bloqueia,
    v_obs,
    p_reinspecao_de_id,
    auth.uid(),
    v_usuario_nome,
    v_key,
    NOW()
  )
  RETURNING id INTO v_cq_id;

  IF v_res = 'REPROVADO' THEN
    INSERT INTO public.producao_ocorrencias_qualidade (
      pedido_id,
      controle_qualidade_id,
      severidade,
      tipo_ocorrencia,
      descricao,
      registrado_por,
      registrado_por_nome
    ) VALUES (
      p_pedido_id,
      v_cq_id,
      'critica',
      CASE WHEN v_etapa = 'EMBALAGEM' THEN 'PROBLEMA_EMBALAGEM' ELSE 'REPROVACAO_ETAPA' END,
      COALESCE(v_obs, 'Reprovação na etapa ' || v_etapa),
      auth.uid(),
      v_usuario_nome
    )
    RETURNING id INTO v_ocorr_id;
  ELSE
    -- Reinspeção aprovada resolve ocorrências pendentes daquela etapa no pedido
    UPDATE public.producao_ocorrencias_qualidade oq
    SET
      resolvida = true,
      acao_corretiva = COALESCE(v_obs, 'Reinspeção aprovada na etapa ' || v_etapa),
      resolvida_em = NOW(),
      resolvida_por = auth.uid()
    WHERE oq.pedido_id = p_pedido_id
      AND oq.resolvida = false
      AND (
        oq.controle_qualidade_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.producao_controles_qualidade cq_ant
          WHERE cq_ant.id = oq.controle_qualidade_id
            AND cq_ant.etapa = v_etapa
        )
      );
  END IF;

  -- Gate L16: Efeito financeiro ZERO (nenhum acesso a financeiro_lancamentos ou pedido_pagamentos)
  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'controle_id', v_cq_id,
    'ocorrencia_id', v_ocorr_id,
    'pedido_id', p_pedido_id,
    'etapa', v_etapa,
    'resultado', v_res,
    'bloqueia_avanco', v_bloqueia,
    'reinspecao_de_id', p_reinspecao_de_id,
    'pedido_bloqueado_qualidade', public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_controle_qualidade_pedido(BIGINT, TEXT, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_controle_qualidade_pedido(BIGINT, TEXT, TEXT, TEXT, BIGINT, TEXT) TO authenticated, service_role;

-- Evolução das RPCs de avanço operacional para respeitar bloqueio de qualidade (Gates L14 e L15)
CREATE OR REPLACE FUNCTION public.marcar_pedido_pronto(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode marcar pedido como pronto.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Não é possível marcar pedido cancelado como pronto.');
  END IF;

  -- Gate L14: Bloqueia avanço se houver reprovação de qualidade ativa sem reinspeção aprovada
  IF public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUALITY_HOLD_ACTIVE',
      'error', 'Pedido bloqueado por reprovação no controle de qualidade. Registre a reinspeção aprovada antes de concluir o preparo.'
    );
  END IF;

  IF v_ped.status_operacional = 'pronto' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'status_operacional', 'pronto', 'pedido_id', p_pedido_id);
  END IF;

  IF v_ped.status_operacional IN ('saiu_para_entrega', 'entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Pedido já saiu para entrega ou foi entregue. Não pode retornar para pronto.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Produção'; END IF;

  UPDATE public.pedidos
  SET status_operacional = 'pronto',
      status = 'Pronto',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'pronto',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'marcar_pronto', 'modalidade', COALESCE(v_ped.modalidade_entrega, 'retirada'))
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', 'pronto',
    'modalidade_entrega', COALESCE(v_ped.modalidade_entrega, 'retirada')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.marcar_pedido_pronto(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_pedido_pronto(BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marcar_saida_entrega(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode despachar entrega.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode sair para entrega.');
  END IF;

  IF COALESCE(v_ped.modalidade_entrega, 'retirada') = 'retirada' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DELIVERY_MODALITY',
      'error', 'Pedidos na modalidade retirada na loja não possuem etapa de saída para entrega.'
    );
  END IF;

  -- Gate L14: Bloqueia saída se houver reprovação de qualidade ativa
  IF public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUALITY_HOLD_ACTIVE',
      'error', 'Pedido bloqueado por reprovação no controle de qualidade. Realize a reinspeção aprovada antes da expedição.'
    );
  END IF;

  IF v_ped.status_operacional = 'saiu_para_entrega' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'status_operacional', 'saiu_para_entrega', 'pedido_id', p_pedido_id);
  END IF;

  IF v_ped.status_operacional NOT IN ('pronto', 'em_producao') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Pedido precisa estar pronto (ou em finalização de produção) para sair para entrega.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Expedição'; END IF;

  UPDATE public.pedidos
  SET status_operacional = 'saiu_para_entrega',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'saiu_para_entrega',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'saiu_para_entrega')
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', 'saiu_para_entrega'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.marcar_saida_entrega(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_saida_entrega(BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.confirmar_entrega_retirada(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_status_final TEXT;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode confirmar conclusão da entrega/retirada.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode ser entregue.');
  END IF;

  -- Gate L14: Bloqueia entrega/retirada se houver reprovação de qualidade ativa
  IF public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUALITY_HOLD_ACTIVE',
      'error', 'Pedido bloqueado por reprovação no controle de qualidade. Realize a reinspeção aprovada antes da entrega/retirada.'
    );
  END IF;

  IF v_ped.status_operacional IN ('entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'status_operacional', v_ped.status_operacional,
      'pedido_id', p_pedido_id
    );
  END IF;

  IF v_ped.status_operacional = 'aguardando_producao' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Não é possível concluir entrega de pedido que ainda aguarda produção. O pedido deve passar pelas etapas de preparo.'
    );
  END IF;

  v_status_final := 'entregue';

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Balcão/Entrega'; END IF;

  UPDATE public.pedidos
  SET status_operacional = v_status_final,
      status = 'Entregue',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, v_status_final,
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'confirmar_entrega_retirada', 'modalidade', COALESCE(v_ped.modalidade_entrega, 'retirada'))
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', v_status_final,
    'modalidade_entrega', COALESCE(v_ped.modalidade_entrega, 'retirada')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_entrega_retirada(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_entrega_retirada(BIGINT) TO authenticated, service_role;

-- Também adiciona a guarda de qualidade em despachar_pedido_entrega (da Frente K)
CREATE OR REPLACE FUNCTION public.despachar_pedido_entrega(
  p_pedido_id BIGINT,
  p_observacao TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_rota_id BIGINT;
  v_usuario_nome TEXT;
  v_tipo_evento TEXT;
  v_evt_key TEXT;
  v_tentativa INTEGER;
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode despachar entregas.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode ser despachado.');
  END IF;

  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DELIVERY_MODALITY',
      'error', 'Pedidos na modalidade retirada na loja não possuem despacho logístico de entrega.'
    );
  END IF;

  -- Gate L14: Bloqueia despacho logístico se houver reprovação crítica ativa em embalagem/expedição
  IF public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUALITY_HOLD_ACTIVE',
      'error', 'Pedido bloqueado por reprovação no controle de qualidade. Realize a reinspeção aprovada antes de despachar para entrega.'
    );
  END IF;

  IF v_ped.status_operacional IN ('entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_ALREADY_DELIVERED',
      'error', 'Este pedido já consta como entregue.'
    );
  END IF;

  INSERT INTO public.entregas (
    pedido_id,
    status_logistico,
    created_at,
    updated_at
  ) VALUES (
    p_pedido_id,
    'aguardando_despacho',
    NOW(),
    NOW()
  )
  ON CONFLICT (pedido_id) DO NOTHING;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id
  FOR UPDATE;

  IF v_ped.status_operacional = 'saiu_para_entrega' AND v_entrega.status_logistico = 'em_rota' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'entrega_id', v_entrega.id,
      'status_operacional', 'saiu_para_entrega',
      'status_logistico', 'em_rota',
      'tentativas_count', v_entrega.tentativas_count
    );
  END IF;

  IF v_ped.status_operacional <> 'pronto'
     AND NOT (v_ped.status_operacional = 'saiu_para_entrega' AND v_entrega.status_logistico IN ('falha_temporaria', 'reagendada', 'aguardando_despacho')) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_READY_FOR_DISPATCH',
      'error', 'Pedido ainda não está pronto na produção e não pode ser despachado para entrega.',
      'status_operacional_atual', v_ped.status_operacional
    );
  END IF;

  SELECT COALESCE(nome, email, 'Expedição Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Expedição Logística'; END IF;

  SELECT re.rota_id INTO v_rota_id
  FROM public.rota_entregas re
  WHERE re.entrega_id = v_entrega.id
    AND re.ativo = true
  LIMIT 1;

  v_tentativa := COALESCE(v_entrega.tentativas_count, 0) + 1;

  IF v_entrega.status_logistico IN ('falha_temporaria', 'reagendada') THEN
    v_tipo_evento := 'NOVA_TENTATIVA_DESPACHO';
  ELSE
    v_tipo_evento := 'DESPACHADO';
  END IF;

  v_evt_key := COALESCE(
    NULLIF(TRIM(COALESCE(p_chave_idempotencia, '')), ''),
    'despacho:ped:' || p_pedido_id::TEXT || ':tentativa:' || v_tentativa::TEXT
  );

  IF v_ped.status_operacional <> 'saiu_para_entrega' THEN
    UPDATE public.pedidos
    SET status_operacional = 'saiu_para_entrega',
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      p_pedido_id, 'operacional', v_ped.status_operacional, 'saiu_para_entrega',
      auth.uid(), v_usuario_nome, 'admin',
      jsonb_build_object('acao', 'despachar_pedido_entrega', 'tentativa', v_tentativa, 'rota_id', v_rota_id)
    );
  END IF;

  UPDATE public.entregas
  SET status_logistico = 'em_rota',
      tentativas_count = v_tentativa,
      despachado_em = COALESCE(despachado_em, NOW()),
      observacoes_logisticas = COALESCE(v_obs, observacoes_logisticas),
      updated_at = NOW()
  WHERE id = v_entrega.id;

  IF v_rota_id IS NOT NULL THEN
    UPDATE public.rotas_entrega
    SET status = CASE WHEN status = 'planejada' THEN 'em_andamento' ELSE status END,
        iniciada_em = COALESCE(iniciada_em, NOW()),
        updated_at = NOW()
    WHERE id = v_rota_id;
  END IF;

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    rota_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    v_rota_id,
    v_tipo_evento,
    COALESCE(v_obs, 'Pedido despachado para entrega (tentativa #' || v_tentativa::TEXT || ').'),
    v_evt_key,
    jsonb_build_object('tentativa', v_tentativa, 'rota_id', v_rota_id),
    auth.uid(),
    v_usuario_nome
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'rota_id', v_rota_id,
    'status_operacional', 'saiu_para_entrega',
    'status_logistico', 'em_rota',
    'tentativas_count', v_tentativa
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.despachar_pedido_entrega(BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.despachar_pedido_entrega(BIGINT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. RPCs DE RECALL / RASTREABILIDADE REVERSA E DIRETA (GATES L12, L13)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rastrear_lote_ingrediente_admin(
  p_lote_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_lote RECORD;
  v_pedidos_afetados JSONB;
  v_movimentacoes JSONB;
  v_ocorrencias JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode rastrear lotes.');
  END IF;

  IF p_lote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'LOT_ID_REQUIRED', 'error', 'ID do lote é obrigatório.');
  END IF;

  SELECT
    l.id AS lote_id,
    l.codigo_lote,
    l.ingrediente_id,
    i.nome AS ingrediente_nome,
    i.unidade,
    i.dias_alerta_validade,
    l.fornecedor_id,
    f.nome AS fornecedor_nome,
    f.telefone AS fornecedor_telefone,
    l.compra_id,
    c.numero_nota,
    l.data_recebimento,
    l.data_fabricacao,
    l.data_validade,
    l.quantidade_inicial,
    l.quantidade_atual,
    CASE WHEN v_is_admin THEN l.custo_unitario_lote ELSE NULL END AS custo_unitario_lote,
    l.bloqueado_qualidade,
    l.motivo_bloqueio,
    l.bloqueado_em,
    public._derivar_estado_validade_lote(l.quantidade_atual, l.data_validade, l.bloqueado_qualidade, i.dias_alerta_validade) AS estado_validade
  INTO v_lote
  FROM public.ingrediente_lotes l
  JOIN public.ingredientes i ON i.id = l.ingrediente_id
  LEFT JOIN public.fornecedores f ON f.id = l.fornecedor_id
  LEFT JOIN public.compras c ON c.id = l.compra_id
  WHERE l.id = p_lote_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'LOT_NOT_FOUND', 'error', 'Lote não encontrado.');
  END IF;

  -- Gate L12: Lista exata de pedidos que consumiram este lote (Recall)
  SELECT COALESCE(jsonb_agg(row_to_json(ped_row)::jsonb ORDER BY ped_row.pedido_id ASC), '[]'::jsonb)
  INTO v_pedidos_afetados
  FROM (
    SELECT
      p.id AS pedido_id,
      p.nome_cliente,
      p.telefone_cliente,
      p.data_entrega,
      p.hora_entrega,
      p.modalidade_entrega,
      p.status_comercial,
      p.status_operacional,
      ROUND(SUM(pcl.quantidade_consumida), 3) AS quantidade_consumida,
      MAX(pcl.unidade) AS unidade,
      MIN(pcl.consumido_em) AS primeiro_consumo_em,
      MAX(pcl.consumido_em) AS ultimo_consumo_em
    FROM public.pedido_consumos_lote pcl
    JOIN public.pedidos p ON p.id = pcl.pedido_id
    WHERE pcl.lote_id = p_lote_id
    GROUP BY p.id, p.nome_cliente, p.telefone_cliente, p.data_entrega, p.hora_entrega, p.modalidade_entrega, p.status_comercial, p.status_operacional
  ) ped_row;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', m.id,
      'tipo_evento', m.tipo_evento,
      'quantidade', m.quantidade,
      'saldo_lote_anterior', m.saldo_lote_anterior,
      'saldo_lote_posterior', m.saldo_lote_posterior,
      'pedido_id', m.pedido_id,
      'compra_id', m.compra_id,
      'motivo', m.motivo,
      'usuario_nome', m.usuario_nome,
      'created_at', m.created_at
    ) ORDER BY m.id DESC
  ), '[]'::jsonb)
  INTO v_movimentacoes
  FROM public.ingrediente_lote_movimentacoes m
  WHERE m.lote_id = p_lote_id;

  SELECT COALESCE(jsonb_agg(row_to_json(oc)::jsonb ORDER BY oc.id DESC), '[]'::jsonb)
  INTO v_ocorrencias
  FROM public.producao_ocorrencias_qualidade oc
  WHERE oc.lote_id = p_lote_id;

  RETURN jsonb_build_object(
    'success', true,
    'lote', row_to_json(v_lote)::jsonb,
    'pedidos_afetados', v_pedidos_afetados,
    'total_pedidos_afetados', jsonb_array_length(v_pedidos_afetados),
    'movimentacoes', v_movimentacoes,
    'ocorrencias_qualidade', v_ocorrencias
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.rastrear_lote_ingrediente_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rastrear_lote_ingrediente_admin(BIGINT) TO authenticated, service_role;

-- Gate L13: Rastreabilidade Pedido -> Lotes de Ingredientes e Checkpoints de Qualidade
CREATE OR REPLACE FUNCTION public.rastrear_pedido_producao_admin(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_ped RECORD;
  v_lotes_consumidos JSONB;
  v_controles_qualidade JSONB;
  v_ocorrencias JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode consultar a rastreabilidade do pedido.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT
    p.id AS pedido_id,
    p.nome_cliente,
    p.data_entrega,
    p.hora_entrega,
    p.modalidade_entrega,
    p.status_comercial,
    p.status_operacional
  INTO v_ped
  FROM public.pedidos p
  WHERE p.id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'consumo_id', pcl.id,
      'ingrediente_id', pcl.ingrediente_id,
      'ingrediente_nome', i.nome,
      'lote_id', pcl.lote_id,
      'codigo_lote', pcl.codigo_lote_snapshot,
      'data_validade', pcl.data_validade_snapshot,
      'fornecedor_nome', f.nome,
      'quantidade_consumida', pcl.quantidade_consumida,
      'unidade', pcl.unidade,
      'custo_unitario_lote', CASE WHEN v_is_admin THEN pcl.custo_unitario_lote_snapshot ELSE NULL END,
      'consumido_em', pcl.consumido_em,
      'registrado_por_nome', pcl.registrado_por_nome
    ) ORDER BY pcl.id ASC
  ), '[]'::jsonb)
  INTO v_lotes_consumidos
  FROM public.pedido_consumos_lote pcl
  JOIN public.ingredientes i ON i.id = pcl.ingrediente_id
  JOIN public.ingrediente_lotes l ON l.id = pcl.lote_id
  LEFT JOIN public.fornecedores f ON f.id = l.fornecedor_id
  WHERE pcl.pedido_id = p_pedido_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'controle_id', cq.id,
      'etapa', cq.etapa,
      'resultado', cq.resultado,
      'bloqueia_avanco', cq.bloqueia_avanco,
      'observacao', cq.observacao,
      'reinspecao_de_id', cq.reinspecao_de_id,
      'responsavel_nome', cq.responsavel_nome,
      'registrado_em', cq.registrado_em
    ) ORDER BY cq.id ASC
  ), '[]'::jsonb)
  INTO v_controles_qualidade
  FROM public.producao_controles_qualidade cq
  WHERE cq.pedido_id = p_pedido_id;

  SELECT COALESCE(jsonb_agg(row_to_json(oc)::jsonb ORDER BY oc.id DESC), '[]'::jsonb)
  INTO v_ocorrencias
  FROM public.producao_ocorrencias_qualidade oc
  WHERE oc.pedido_id = p_pedido_id;

  RETURN jsonb_build_object(
    'success', true,
    'pedido', row_to_json(v_ped)::jsonb,
    'pedido_bloqueado_qualidade', public._pedido_possui_bloqueio_qualidade_ativo(p_pedido_id),
    'lotes_consumidos', v_lotes_consumidos,
    'controles_qualidade', v_controles_qualidade,
    'ocorrencias_qualidade', v_ocorrencias
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.rastrear_pedido_producao_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rastrear_pedido_producao_admin(BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC: OBTER_PAINEL_LOTES_VALIDADE (VISÃO DE COMPRAS/ESTOQUE SANITIZADA POR PAPEL)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_lotes_validade(
  p_ingrediente_id BIGINT DEFAULT NULL,
  p_filtro_estado TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_lotes JSONB;
  v_qtd_vencidos INTEGER := 0;
  v_qtd_vence_breve INTEGER := 0;
  v_qtd_regulares INTEGER := 0;
  v_qtd_bloqueados INTEGER := 0;
  v_qtd_esgotados INTEGER := 0;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode consultar o painel de lotes e validades.');
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE est = 'vencido'),
    COUNT(*) FILTER (WHERE est = 'vence_em_breve'),
    COUNT(*) FILTER (WHERE est = 'valido'),
    COUNT(*) FILTER (WHERE est = 'bloqueado'),
    COUNT(*) FILTER (WHERE est = 'esgotado')
  INTO v_qtd_vencidos, v_qtd_vence_breve, v_qtd_regulares, v_qtd_bloqueados, v_qtd_esgotados
  FROM (
    SELECT public._derivar_estado_validade_lote(l.quantidade_atual, l.data_validade, l.bloqueado_qualidade, i.dias_alerta_validade) AS est
    FROM public.ingrediente_lotes l
    JOIN public.ingredientes i ON i.id = l.ingrediente_id
    WHERE (p_ingrediente_id IS NULL OR l.ingrediente_id = p_ingrediente_id)
  ) r_cnt;

  SELECT COALESCE(jsonb_agg(row_to_json(lt_row)::jsonb ORDER BY
    CASE lt_row.estado_validade
      WHEN 'vencido' THEN 1
      WHEN 'vence_em_breve' THEN 2
      WHEN 'bloqueado' THEN 3
      WHEN 'valido' THEN 4
      ELSE 5
    END ASC,
    lt_row.data_validade ASC NULLS LAST,
    lt_row.lote_id DESC
  ), '[]'::jsonb)
  INTO v_lotes
  FROM (
    SELECT
      l.id AS lote_id,
      l.ingrediente_id,
      i.nome AS ingrediente_nome,
      i.unidade,
      i.controlar_lote,
      i.controlar_validade,
      l.codigo_lote,
      l.fornecedor_id,
      f.nome AS fornecedor_nome,
      l.compra_id,
      l.data_recebimento,
      l.data_fabricacao,
      l.data_validade,
      CASE WHEN l.data_validade IS NOT NULL THEN (l.data_validade - v_hoje) ELSE NULL END AS dias_para_vencer,
      l.quantidade_inicial,
      l.quantidade_atual,
      CASE WHEN v_is_admin THEN l.custo_unitario_lote ELSE NULL END AS custo_unitario_lote,
      l.bloqueado_qualidade,
      l.motivo_bloqueio,
      public._derivar_estado_validade_lote(l.quantidade_atual, l.data_validade, l.bloqueado_qualidade, i.dias_alerta_validade) AS estado_validade
    FROM public.ingrediente_lotes l
    JOIN public.ingredientes i ON i.id = l.ingrediente_id
    LEFT JOIN public.fornecedores f ON f.id = l.fornecedor_id
    WHERE (p_ingrediente_id IS NULL OR l.ingrediente_id = p_ingrediente_id)
  ) lt_row
  WHERE p_filtro_estado IS NULL OR lt_row.estado_validade = LOWER(TRIM(p_filtro_estado));

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'resumo', jsonb_build_object(
      'vencidos', v_qtd_vencidos,
      'vencem_em_breve', v_qtd_vence_breve,
      'regulares', v_qtd_regulares,
      'bloqueados', v_qtd_bloqueados,
      'esgotados', v_qtd_esgotados
    ),
    'lotes', v_lotes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_painel_lotes_validade(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_lotes_validade(BIGINT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 16. RPC: RECONCILIAR_SALDOS_LOTES_ADMIN (AUDITORIA DE INVARIANTE L7)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconciliar_saldos_lotes_admin(
  p_ingrediente_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_itens JSONB;
  v_divergencias INTEGER := 0;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Acesso restrito à equipe.');
  END IF;

  SELECT
    COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.ingrediente_id ASC), '[]'::jsonb),
    COUNT(*) FILTER (WHERE r.reconciliado = false)
  INTO v_itens, v_divergencias
  FROM (
    SELECT
      i.id AS ingrediente_id,
      i.nome AS ingrediente_nome,
      COALESCE(s.saldo_atual, 0.000) AS saldo_agregado,
      COALESCE(ROUND(SUM(l.quantidade_atual) FILTER (WHERE l.quantidade_atual > 0), 3), 0.000) AS soma_lotes_ativos,
      ROUND(COALESCE(s.saldo_atual, 0.000) - COALESCE(ROUND(SUM(l.quantidade_atual) FILTER (WHERE l.quantidade_atual > 0), 3), 0.000), 3) AS diferenca,
      (ROUND(COALESCE(s.saldo_atual, 0.000), 3) = COALESCE(ROUND(SUM(l.quantidade_atual) FILTER (WHERE l.quantidade_atual > 0), 3), 0.000)) AS reconciliado
    FROM public.ingredientes i
    LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
    LEFT JOIN public.ingrediente_lotes l ON l.ingrediente_id = i.id
    WHERE (p_ingrediente_id IS NULL OR i.id = p_ingrediente_id)
    GROUP BY i.id, i.nome, s.saldo_atual
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'reconciliado', (v_divergencias = 0),
    'divergencias_count', v_divergencias,
    'itens', v_itens
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reconciliar_saldos_lotes_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconciliar_saldos_lotes_admin(BIGINT) TO authenticated, service_role;
