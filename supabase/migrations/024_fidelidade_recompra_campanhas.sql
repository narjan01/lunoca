-- ==============================================================================
-- MIGRATION 024: FRENTE I — FIDELIDADE, RECOMPRA, CAMPANHAS E CONSENTIMENTO
-- ==============================================================================
-- Princípio Central e Invariante Fundamental:
--   credito_financeiro_cliente != pontos_fidelidade != cupom_desconto_promocional
--
-- Regras de Ouro:
-- 1. A carteira da Frente C (cliente_creditos / cliente_credito_movimentacoes)
--    representa valor financeiro real e jamais é tocada por pontos ou cupons.
-- 2. O livro-razão de pontos (cliente_pontos_movimentacoes) é estritamente
--    append-only (bloqueia UPDATE e DELETE físicos).
-- 3. O saldo de pontos (cliente_pontos.saldo_pontos) nunca fica negativo e
--    bloqueia UPDATE direto fora da porta transacional canônica.
-- 4. Pontos de compra são creditados apenas no marco estável (pedido concluído)
--    com chave de idempotência determinística; cancelamento gera compensação.
-- 5. Desconto combinado (cupom + desconto manual + desconto de frete + pontos)
--    respeita centralizadamente o teto de governança (politica_desconto).
-- 6. Consentimento de marketing (opt_in / opt_out) é estritamente separado da
--    comunicação operacional/transacional da Frente B.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABELA: PROGRAMAS_FIDELIDADE (CONFIGURAÇÃO SERVER-SIDE)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.programas_fidelidade (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  pontos_por_real NUMERIC(10,4) NOT NULL DEFAULT 1.0000 CHECK (pontos_por_real > 0),
  valor_por_ponto_resgate NUMERIC(10,4) NOT NULL DEFAULT 0.0500 CHECK (valor_por_ponto_resgate > 0),
  pedido_minimo_elegivel NUMERIC(10,2) NOT NULL DEFAULT 20.00 CHECK (pedido_minimo_elegivel >= 0.00),
  resgate_minimo_pontos INTEGER NOT NULL DEFAULT 10 CHECK (resgate_minimo_pontos >= 1),
  validade_pontos_dias INTEGER NOT NULL DEFAULT 180 CHECK (validade_pontos_dias >= 1),
  marco_credito TEXT NOT NULL DEFAULT 'concluido' CHECK (marco_credito IN ('concluido')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.programas_fidelidade (
  codigo, nome, pontos_por_real, valor_por_ponto_resgate,
  pedido_minimo_elegivel, resgate_minimo_pontos, validade_pontos_dias, marco_credito, ativo
) VALUES (
  'PADRAO_LUNOCA',
  'Clube de Fidelidade Lunoca Doceria',
  1.0000,
  0.0500,
  20.00,
  10,
  180,
  'concluido',
  true
) ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. TABELAS: CLIENTE_PONTOS E CLIENTE_PONTOS_MOVIMENTACOES (APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_pontos (
  cliente_id BIGINT PRIMARY KEY REFERENCES public.clientes(id) ON DELETE CASCADE,
  saldo_pontos INTEGER NOT NULL DEFAULT 0 CHECK (saldo_pontos >= 0),
  pontos_acumulados_total INTEGER NOT NULL DEFAULT 0 CHECK (pontos_acumulados_total >= 0),
  pontos_resgatados_total INTEGER NOT NULL DEFAULT 0 CHECK (pontos_resgatados_total >= 0),
  pontos_expirados_total INTEGER NOT NULL DEFAULT 0 CHECK (pontos_expirados_total >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cliente_pontos_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (
    tipo IN (
      'GANHO_COMPRA',
      'RESGATE',
      'EXPIRACAO',
      'ESTORNO_RESGATE',
      'COMPENSACAO_CANCELAMENTO',
      'AJUSTE_ADMIN',
      'BONUS_CAMPANHA'
    )
  ),
  natureza TEXT NOT NULL CHECK (natureza IN ('credito', 'debito')),
  pontos INTEGER NOT NULL CHECK (pontos > 0),
  saldo_anterior INTEGER NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior INTEGER NOT NULL CHECK (saldo_posterior >= 0),
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  campanha_id BIGINT,
  lote_origem_id BIGINT REFERENCES public.cliente_pontos_movimentacoes(id) ON DELETE RESTRICT,
  expira_em TIMESTAMPTZ,
  motivo TEXT NOT NULL CHECK (char_length(btrim(motivo)) >= 3),
  chave_idempotencia TEXT NOT NULL UNIQUE,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cli_pontos_mov_cliente_id
  ON public.cliente_pontos_movimentacoes(cliente_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_cli_pontos_mov_expiracao
  ON public.cliente_pontos_movimentacoes(cliente_id, expira_em)
  WHERE natureza = 'credito' AND expira_em IS NOT NULL;

-- Trigger de imutabilidade no livro-razão cliente_pontos_movimentacoes
CREATE OR REPLACE FUNCTION public.bloquear_mutacao_cliente_pontos_mov()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Operação % não permitida em cliente_pontos_movimentacoes. O livro-razão de pontos de fidelidade é estritamente imutável (append-only).', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_cliente_pontos_mov ON public.cliente_pontos_movimentacoes;
CREATE TRIGGER trg_imutabilidade_cliente_pontos_mov
  BEFORE UPDATE OR DELETE ON public.cliente_pontos_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_cliente_pontos_mov();

-- Trigger que impede UPDATE/INSERT/DELETE direto em cliente_pontos fora da porta canônica
CREATE OR REPLACE FUNCTION public.proteger_mutacao_direta_cliente_pontos()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('lunoca.internal_points_mutation', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Mutação direta em cliente_pontos proibida. Utilize exclusivamente as portas transacionais canônicas de fidelidade.'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proteger_mutacao_direta_cliente_pontos ON public.cliente_pontos;
CREATE TRIGGER trg_proteger_mutacao_direta_cliente_pontos
  BEFORE INSERT OR UPDATE OR DELETE ON public.cliente_pontos
  FOR EACH ROW
  EXECUTE FUNCTION public.proteger_mutacao_direta_cliente_pontos();

-- ------------------------------------------------------------------------------
-- 3. TABELA: CLIENTE_CONSENTIMENTOS_MARKETING (HISTÓRICO AUDITÁVEL OPT-IN/OPT-OUT)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_consentimentos_marketing (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp_marketing', 'email_marketing', 'sms_marketing')),
  status TEXT NOT NULL CHECK (status IN ('opt_in', 'opt_out')),
  origem TEXT NOT NULL DEFAULT 'painel_admin',
  versao_termo TEXT NOT NULL DEFAULT 'v1.0',
  observacao TEXT,
  data_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registrado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_consentimentos_mkt_cliente_canal
  ON public.cliente_consentimentos_marketing(cliente_id, canal, data_hora DESC, id DESC);

DROP TRIGGER IF EXISTS trg_imutabilidade_consentimentos_mkt ON public.cliente_consentimentos_marketing;
CREATE TRIGGER trg_imutabilidade_consentimentos_mkt
  BEFORE UPDATE OR DELETE ON public.cliente_consentimentos_marketing
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_cliente_pontos_mov();

-- ------------------------------------------------------------------------------
-- 4. TABELAS: CAMPANHAS, CUPONS_PROMOCIONAIS, CUPOM_UTILIZACOES, CAMPANHA_PUBLICOS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campanhas (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  tipo_template TEXT NOT NULL CHECK (
    tipo_template IN (
      'CUPOM_ANIVERSARIO',
      'VOLTE_A_COMPRAR',
      'CAMPANHA_PASCOA',
      'CAMPANHA_PROMOCIONAL',
      'LEMBRETE_PONTOS_EXPIRANDO'
    )
  ),
  canal TEXT NOT NULL DEFAULT 'whatsapp_marketing' CHECK (
    canal IN ('whatsapp_marketing', 'email_marketing', 'sms_marketing')
  ),
  regra_segmentacao JSONB NOT NULL DEFAULT '{"segmento": "todos"}'::jsonb,
  mensagem_template TEXT NOT NULL,
  cupom_id BIGINT,
  bonus_pontos INTEGER NOT NULL DEFAULT 0 CHECK (bonus_pontos >= 0),
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (
    status IN ('rascunho', 'ativa', 'disparada', 'encerrada', 'cancelada')
  ),
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cupons_promocionais (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  descricao TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('percentual', 'valor_fixo')),
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0.00),
  validade_inicio TIMESTAMPTZ NOT NULL DEFAULT (NOW() - INTERVAL '1 minute'),
  validade_fim TIMESTAMPTZ NOT NULL,
  uso_maximo_global INTEGER CHECK (uso_maximo_global IS NULL OR uso_maximo_global >= 1),
  uso_maximo_cliente INTEGER NOT NULL DEFAULT 1 CHECK (uso_maximo_cliente >= 1),
  pedido_minimo NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (pedido_minimo >= 0.00),
  desconto_maximo NUMERIC(10,2) CHECK (desconto_maximo IS NULL OR desconto_maximo > 0.00),
  ativo BOOLEAN NOT NULL DEFAULT true,
  campanha_id BIGINT REFERENCES public.campanhas(id) ON DELETE SET NULL,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_cupom_percentual_valido CHECK (tipo <> 'percentual' OR valor <= 100.00)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'campanhas'
      AND constraint_name = 'fk_campanhas_cupom_id'
  ) THEN
    ALTER TABLE public.campanhas
      ADD CONSTRAINT fk_campanhas_cupom_id
      FOREIGN KEY (cupom_id) REFERENCES public.cupons_promocionais(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cupom_utilizacoes (
  id BIGSERIAL PRIMARY KEY,
  cupom_id BIGINT NOT NULL REFERENCES public.cupons_promocionais(id) ON DELETE RESTRICT,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  subtotal_pedido NUMERIC(10,2) NOT NULL CHECK (subtotal_pedido > 0.00),
  valor_desconto_cupom NUMERIC(10,2) NOT NULL CHECK (valor_desconto_cupom > 0.00),
  desconto_manual_combinado NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (desconto_manual_combinado >= 0.00),
  desconto_frete_combinado NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (desconto_frete_combinado >= 0.00),
  beneficio_pontos_combinado NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (beneficio_pontos_combinado >= 0.00),
  status TEXT NOT NULL DEFAULT 'aplicado' CHECK (status IN ('aplicado', 'estornado')),
  chave_idempotencia TEXT NOT NULL UNIQUE,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cupom_utilizacoes_cupom_cliente
  ON public.cupom_utilizacoes(cupom_id, cliente_id)
  WHERE status = 'aplicado';

CREATE TABLE IF NOT EXISTS public.campanha_publicos (
  id BIGSERIAL PRIMARY KEY,
  campanha_id BIGINT NOT NULL REFERENCES public.campanhas(id) ON DELETE CASCADE,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  telefone_destino TEXT,
  consentimento_status TEXT NOT NULL,
  comunicacao_id BIGINT REFERENCES public.comunicacoes_cliente(id) ON DELETE SET NULL,
  status_disparo TEXT NOT NULL CHECK (
    status_disparo IN ('elegivel', 'disparado', 'bloqueado_sem_consentimento', 'ignorado_sem_telefone')
  ),
  motivo_bloqueio TEXT,
  snapshot_criterio JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campanha_publico_cliente UNIQUE (campanha_id, cliente_id)
);

CREATE INDEX IF NOT EXISTS idx_campanha_publicos_campanha
  ON public.campanha_publicos(campanha_id, status_disparo);

-- ------------------------------------------------------------------------------
-- 5. EXTENSÃO FORWARD-ONLY DE COMUNICACOES_CLIENTE PARA CAMPANHAS (FRENTE B)
-- ------------------------------------------------------------------------------
ALTER TABLE public.comunicacoes_cliente
  ADD COLUMN IF NOT EXISTS campanha_id BIGINT REFERENCES public.campanhas(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS cliente_id BIGINT REFERENCES public.clientes(id) ON DELETE CASCADE;

ALTER TABLE public.comunicacoes_cliente
  DROP CONSTRAINT IF EXISTS ck_comunicacao_entidade;

ALTER TABLE public.comunicacoes_cliente
  ADD CONSTRAINT ck_comunicacao_entidade CHECK (
    (orcamento_id IS NOT NULL AND pedido_id IS NULL AND campanha_id IS NULL)
    OR
    (orcamento_id IS NULL AND pedido_id IS NOT NULL AND campanha_id IS NULL)
    OR
    (orcamento_id IS NULL AND pedido_id IS NULL AND campanha_id IS NOT NULL AND cliente_id IS NOT NULL)
  );

ALTER TABLE public.comunicacoes_cliente
  DROP CONSTRAINT IF EXISTS comunicacoes_cliente_tipo_check;

ALTER TABLE public.comunicacoes_cliente
  ADD CONSTRAINT comunicacoes_cliente_tipo_check CHECK (
    tipo IN (
      'ORCAMENTO_ENVIADO',
      'ORCAMENTO_VENCENDO',
      'SINAL_CONFIRMADO',
      'PEDIDO_PRONTO',
      'SAIU_PARA_ENTREGA',
      'CUPOM_ANIVERSARIO',
      'VOLTE_A_COMPRAR',
      'CAMPANHA_PASCOA',
      'CAMPANHA_PROMOCIONAL',
      'LEMBRETE_PONTOS_EXPIRANDO'
    )
  );

-- Coluna opcional data_nascimento em clientes para segmentação de aniversariantes
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS data_nascimento DATE;

-- ------------------------------------------------------------------------------
-- 6. RLS FAIL-CLOSED E REVOGAÇÃO DE ESCRITA DIRETA NAS TABELAS DA FRENTE I
-- ------------------------------------------------------------------------------
ALTER TABLE public.programas_fidelidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_pontos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_pontos_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_consentimentos_marketing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campanhas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cupons_promocionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cupom_utilizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campanha_publicos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.programas_fidelidade FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cliente_pontos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cliente_pontos_movimentacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cliente_consentimentos_marketing FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.campanhas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cupons_promocionais FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cupom_utilizacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.campanha_publicos FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.programas_fidelidade TO authenticated, service_role;
GRANT SELECT ON public.cliente_pontos TO authenticated, service_role;
GRANT SELECT ON public.cliente_pontos_movimentacoes TO authenticated, service_role;
GRANT SELECT ON public.cliente_consentimentos_marketing TO authenticated, service_role;
GRANT SELECT ON public.campanhas TO authenticated, service_role;
GRANT SELECT ON public.cupons_promocionais TO authenticated, service_role;
GRANT SELECT ON public.cupom_utilizacoes TO authenticated, service_role;
GRANT SELECT ON public.campanha_publicos TO authenticated, service_role;

GRANT ALL ON public.programas_fidelidade TO service_role;
GRANT ALL ON public.cliente_pontos TO service_role;
GRANT ALL ON public.cliente_pontos_movimentacoes TO service_role;
GRANT ALL ON public.cliente_consentimentos_marketing TO service_role;
GRANT ALL ON public.campanhas TO service_role;
GRANT ALL ON public.cupons_promocionais TO service_role;
GRANT ALL ON public.cupom_utilizacoes TO service_role;
GRANT ALL ON public.campanha_publicos TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.programas_fidelidade_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cliente_pontos_movimentacoes_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cliente_consentimentos_marketing_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.campanhas_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cupons_promocionais_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cupom_utilizacoes_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.campanha_publicos_id_seq TO service_role;

DROP POLICY IF EXISTS "Equipe visualiza programas_fidelidade" ON public.programas_fidelidade;
CREATE POLICY "Equipe visualiza programas_fidelidade"
  ON public.programas_fidelidade FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza cliente_pontos" ON public.cliente_pontos;
CREATE POLICY "Equipe visualiza cliente_pontos"
  ON public.cliente_pontos FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza cliente_pontos_movimentacoes" ON public.cliente_pontos_movimentacoes;
CREATE POLICY "Equipe visualiza cliente_pontos_movimentacoes"
  ON public.cliente_pontos_movimentacoes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza cliente_consentimentos_marketing" ON public.cliente_consentimentos_marketing;
CREATE POLICY "Equipe visualiza cliente_consentimentos_marketing"
  ON public.cliente_consentimentos_marketing FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza campanhas" ON public.campanhas;
CREATE POLICY "Equipe visualiza campanhas"
  ON public.campanhas FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza cupons_promocionais" ON public.cupons_promocionais;
CREATE POLICY "Equipe visualiza cupons_promocionais"
  ON public.cupons_promocionais FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza cupom_utilizacoes" ON public.cupom_utilizacoes;
CREATE POLICY "Equipe visualiza cupom_utilizacoes"
  ON public.cupom_utilizacoes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza campanha_publicos" ON public.campanha_publicos;
CREATE POLICY "Equipe visualiza campanha_publicos"
  ON public.campanha_publicos FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- ------------------------------------------------------------------------------
-- 7. HELPER INTERNO PRIVADO: _APLICAR_MOVIMENTO_PONTOS_CLIENTE (LOCK + LEDGER)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._aplicar_movimento_pontos_cliente(
  p_cliente_id BIGINT,
  p_tipo TEXT,
  p_natureza TEXT,
  p_pontos INTEGER,
  p_motivo TEXT,
  p_chave_idempotencia TEXT,
  p_pedido_id BIGINT DEFAULT NULL,
  p_campanha_id BIGINT DEFAULT NULL,
  p_lote_origem_id BIGINT DEFAULT NULL,
  p_expira_em TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_mov_existente RECORD;
  v_carteira RECORD;
  v_saldo_anterior INTEGER := 0;
  v_saldo_posterior INTEGER := 0;
  v_mov_id BIGINT;
BEGIN
  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_REQUIRED', 'error', 'Cliente é obrigatório.');
  END IF;

  IF p_pontos IS NULL OR p_pontos <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_POINTS', 'error', 'Quantidade de pontos deve ser estritamente positiva.');
  END IF;

  IF p_natureza NOT IN ('credito', 'debito') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_NATURE', 'error', 'Natureza da movimentação inválida.');
  END IF;

  IF p_chave_idempotencia IS NULL OR btrim(p_chave_idempotencia) = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'IDEMPOTENCY_KEY_REQUIRED', 'error', 'Chave de idempotência obrigatória.');
  END IF;

  -- Libera flag de mutação interna controlada para cliente_pontos
  PERFORM set_config('lunoca.internal_points_mutation', 'on', true);

  -- Garante existência da linha em cliente_pontos e adquire lock pessimista FOR UPDATE
  INSERT INTO public.cliente_pontos (cliente_id, saldo_pontos)
  VALUES (p_cliente_id, 0)
  ON CONFLICT (cliente_id) DO NOTHING;

  SELECT * INTO v_carteira
  FROM public.cliente_pontos
  WHERE cliente_id = p_cliente_id
  FOR UPDATE;

  -- Verifica idempotência sob o lock do cliente
  SELECT * INTO v_mov_existente
  FROM public.cliente_pontos_movimentacoes
  WHERE chave_idempotencia = btrim(p_chave_idempotencia);

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'movimentacao_id', v_mov_existente.id,
      'cliente_id', p_cliente_id,
      'tipo', v_mov_existente.tipo,
      'natureza', v_mov_existente.natureza,
      'pontos', v_mov_existente.pontos,
      'saldo_anterior', v_mov_existente.saldo_anterior,
      'saldo_posterior', v_mov_existente.saldo_posterior,
      'saldo_atual', v_carteira.saldo_pontos
    );
  END IF;

  v_saldo_anterior := COALESCE(v_carteira.saldo_pontos, 0);

  IF p_natureza = 'credito' THEN
    v_saldo_posterior := v_saldo_anterior + p_pontos;
  ELSE
    IF v_saldo_anterior < p_pontos THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INSUFFICIENT_POINTS_BALANCE',
        'saldo_atual', v_saldo_anterior,
        'pontos_solicitados', p_pontos,
        'error', 'Saldo de pontos insuficiente para a operação.'
      );
    END IF;
    v_saldo_posterior := v_saldo_anterior - p_pontos;
  END IF;

  UPDATE public.cliente_pontos
  SET saldo_pontos = v_saldo_posterior,
      pontos_acumulados_total = pontos_acumulados_total + CASE WHEN p_natureza = 'credito' AND p_tipo IN ('GANHO_COMPRA', 'BONUS_CAMPANHA', 'AJUSTE_ADMIN') THEN p_pontos ELSE 0 END,
      pontos_resgatados_total = pontos_resgatados_total + CASE WHEN p_tipo = 'RESGATE' THEN p_pontos ELSE 0 END,
      pontos_expirados_total = pontos_expirados_total + CASE WHEN p_tipo = 'EXPIRACAO' THEN p_pontos ELSE 0 END,
      updated_at = NOW()
  WHERE cliente_id = p_cliente_id;

  INSERT INTO public.cliente_pontos_movimentacoes (
    cliente_id,
    tipo,
    natureza,
    pontos,
    saldo_anterior,
    saldo_posterior,
    pedido_id,
    campanha_id,
    lote_origem_id,
    expira_em,
    motivo,
    chave_idempotencia,
    criado_por
  ) VALUES (
    p_cliente_id,
    p_tipo,
    p_natureza,
    p_pontos,
    v_saldo_anterior,
    v_saldo_posterior,
    p_pedido_id,
    p_campanha_id,
    p_lote_origem_id,
    p_expira_em,
    btrim(p_motivo),
    btrim(p_chave_idempotencia),
    auth.uid()
  ) RETURNING id INTO v_mov_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'movimentacao_id', v_mov_id,
    'cliente_id', p_cliente_id,
    'tipo', p_tipo,
    'natureza', p_natureza,
    'pontos', p_pontos,
    'saldo_anterior', v_saldo_anterior,
    'saldo_posterior', v_saldo_posterior,
    'saldo_atual', v_saldo_posterior
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._aplicar_movimento_pontos_cliente(BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._aplicar_movimento_pontos_cliente(BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ) TO service_role;

-- ------------------------------------------------------------------------------
-- 8. EXPIRAÇÃO FIFO E IDEMPOTENTE DE PONTOS (GATES I7 E I8)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._processar_expiracao_pontos_cliente(
  p_cliente_id BIGINT,
  p_referencia TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB AS $$
DECLARE
  v_ref TIMESTAMPTZ := COALESCE(p_referencia, NOW());
  v_carteira RECORD;
  v_lote RECORD;
  v_debitos_nao_expiracao INTEGER := 0;
  v_creditos_anteriores INTEGER := 0;
  v_ja_consumido_do_lote INTEGER := 0;
  v_disponivel_lote INTEGER := 0;
  v_a_expirar INTEGER := 0;
  v_total_expirado INTEGER := 0;
  v_qtd_lotes INTEGER := 0;
  v_res JSONB;
BEGIN
  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'pontos_expirados', 0, 'lotes_processados', 0);
  END IF;

  PERFORM set_config('lunoca.internal_points_mutation', 'on', true);

  INSERT INTO public.cliente_pontos (cliente_id, saldo_pontos)
  VALUES (p_cliente_id, 0)
  ON CONFLICT (cliente_id) DO NOTHING;

  SELECT * INTO v_carteira
  FROM public.cliente_pontos
  WHERE cliente_id = p_cliente_id
  FOR UPDATE;

  IF COALESCE(v_carteira.saldo_pontos, 0) <= 0 THEN
    RETURN jsonb_build_object('success', true, 'pontos_expirados', 0, 'lotes_processados', 0, 'saldo_atual', 0);
  END IF;

  -- Total de débitos que consumiram pontos em ordem FIFO (resgates, compensações, ajustes de débito)
  SELECT COALESCE(SUM(pontos), 0)::INT
  INTO v_debitos_nao_expiracao
  FROM public.cliente_pontos_movimentacoes
  WHERE cliente_id = p_cliente_id
    AND natureza = 'debito'
    AND tipo <> 'EXPIRACAO';

  FOR v_lote IN
    SELECT m.*
    FROM public.cliente_pontos_movimentacoes m
    WHERE m.cliente_id = p_cliente_id
      AND m.natureza = 'credito'
      AND m.expira_em IS NOT NULL
      AND m.expira_em <= v_ref
      AND NOT EXISTS (
        SELECT 1 FROM public.cliente_pontos_movimentacoes e
        WHERE e.lote_origem_id = m.id AND e.tipo = 'EXPIRACAO'
      )
    ORDER BY m.id ASC
  LOOP
    -- Créditos acumulados estritamente antes deste lote
    SELECT COALESCE(SUM(c.pontos), 0)::INT
    INTO v_creditos_anteriores
    FROM public.cliente_pontos_movimentacoes c
    WHERE c.cliente_id = p_cliente_id
      AND c.natureza = 'credito'
      AND c.id < v_lote.id;

    -- Quanto dos débitos FIFO alcançou este lote
    v_ja_consumido_do_lote := GREATEST(0, LEAST(v_lote.pontos, v_debitos_nao_expiracao - v_creditos_anteriores));
    v_disponivel_lote := GREATEST(0, v_lote.pontos - v_ja_consumido_do_lote);

    -- Atualiza saldo corrente antes de expirar
    SELECT saldo_pontos INTO v_carteira.saldo_pontos
    FROM public.cliente_pontos
    WHERE cliente_id = p_cliente_id;

    v_a_expirar := LEAST(v_disponivel_lote, COALESCE(v_carteira.saldo_pontos, 0));

    IF v_a_expirar > 0 THEN
      v_res := public._aplicar_movimento_pontos_cliente(
        p_cliente_id := p_cliente_id,
        p_tipo := 'EXPIRACAO',
        p_natureza := 'debito',
        p_pontos := v_a_expirar,
        p_motivo := 'Expiração automática do lote #' || v_lote.id,
        p_chave_idempotencia := 'expiracao:lote:' || v_lote.id,
        p_pedido_id := v_lote.pedido_id,
        p_campanha_id := v_lote.campanha_id,
        p_lote_origem_id := v_lote.id,
        p_expira_em := NULL
      );
      IF (v_res->>'success')::BOOLEAN IS TRUE AND (v_res->>'idempotente')::BOOLEAN IS NOT TRUE THEN
        v_total_expirado := v_total_expirado + v_a_expirar;
        v_qtd_lotes := v_qtd_lotes + 1;
      END IF;
    END IF;
  END LOOP;

  SELECT saldo_pontos INTO v_carteira.saldo_pontos
  FROM public.cliente_pontos
  WHERE cliente_id = p_cliente_id;

  RETURN jsonb_build_object(
    'success', true,
    'cliente_id', p_cliente_id,
    'pontos_expirados', v_total_expirado,
    'lotes_processados', v_qtd_lotes,
    'saldo_atual', COALESCE(v_carteira.saldo_pontos, 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._processar_expiracao_pontos_cliente(BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._processar_expiracao_pontos_cliente(BIGINT, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.expirar_pontos_fidelidade(
  p_cliente_id BIGINT DEFAULT NULL,
  p_referencia TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB AS $$
DECLARE
  v_cli RECORD;
  v_res JSONB;
  v_total_pontos INTEGER := 0;
  v_total_lotes INTEGER := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  IF p_cliente_id IS NOT NULL THEN
    RETURN public._processar_expiracao_pontos_cliente(p_cliente_id, COALESCE(p_referencia, NOW()));
  END IF;

  FOR v_cli IN
    SELECT DISTINCT cliente_id
    FROM public.cliente_pontos_movimentacoes
    WHERE natureza = 'credito'
      AND expira_em IS NOT NULL
      AND expira_em <= COALESCE(p_referencia, NOW())
  LOOP
    v_res := public._processar_expiracao_pontos_cliente(v_cli.cliente_id, COALESCE(p_referencia, NOW()));
    v_total_pontos := v_total_pontos + COALESCE((v_res->>'pontos_expirados')::INT, 0);
    v_total_lotes := v_total_lotes + COALESCE((v_res->>'lotes_processados')::INT, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'pontos_expirados', v_total_pontos,
    'lotes_processados', v_total_lotes
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.expirar_pontos_fidelidade(BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expirar_pontos_fidelidade(BIGINT, TIMESTAMPTZ) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. CRÉDITO DE PONTOS EM COMPRA CONCLUÍDA E COMPENSAÇÃO NO CANCELAMENTO (I1-I4)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._creditar_pontos_pedido_interno(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_ped public.pedidos;
  v_prog public.programas_fidelidade;
  v_valor_elegivel NUMERIC(10,2);
  v_pontos INTEGER;
  v_expira_em TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial <> 'concluido' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_COMPLETED',
      'status_comercial', v_ped.status_comercial,
      'error', 'Pontos de fidelidade só são creditados após o pedido atingir o marco estável concluído.'
    );
  END IF;

  IF v_ped.cliente_id_rel IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_WITHOUT_CLIENT', 'error', 'Pedido não possui cliente vinculado.');
  END IF;

  SELECT * INTO v_prog
  FROM public.programas_fidelidade
  WHERE ativo = true
  ORDER BY id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PROGRAM_INACTIVE', 'error', 'Nenhum programa de fidelidade ativo.');
  END IF;

  v_valor_elegivel := GREATEST(0.00, COALESCE(v_ped.subtotal, v_ped.total, 0.00) - COALESCE(v_ped.desconto, 0.00));

  IF v_valor_elegivel < v_prog.pedido_minimo_elegivel THEN
    RETURN jsonb_build_object(
      'success', true,
      'elegivel', false,
      'pontos', 0,
      'motivo', 'Valor elegível abaixo do mínimo do programa.'
    );
  END IF;

  v_pontos := FLOOR(v_valor_elegivel * v_prog.pontos_por_real)::INT;
  IF v_pontos <= 0 THEN
    RETURN jsonb_build_object('success', true, 'elegivel', false, 'pontos', 0);
  END IF;

  v_expira_em := NOW() + make_interval(days => v_prog.validade_pontos_dias);

  RETURN public._aplicar_movimento_pontos_cliente(
    p_cliente_id := v_ped.cliente_id_rel,
    p_tipo := 'GANHO_COMPRA',
    p_natureza := 'credito',
    p_pontos := v_pontos,
    p_motivo := 'Pontos por compra concluída (Pedido #' || v_ped.id || ')',
    p_chave_idempotencia := 'ganho_compra:pedido:' || v_ped.id,
    p_pedido_id := v_ped.id,
    p_campanha_id := NULL,
    p_lote_origem_id := NULL,
    p_expira_em := v_expira_em
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._creditar_pontos_pedido_interno(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._creditar_pontos_pedido_interno(BIGINT) TO service_role;

CREATE OR REPLACE FUNCTION public.creditar_pontos_pedido_concluido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;
  RETURN public._creditar_pontos_pedido_interno(p_pedido_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.creditar_pontos_pedido_concluido(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.creditar_pontos_pedido_concluido(BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._compensar_pontos_pedido_cancelado_interno(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT 'Estorno compensatório por cancelamento do pedido'
)
RETURNS JSONB AS $$
DECLARE
  v_ganho RECORD;
  v_resgate RECORD;
  v_carteira RECORD;
  v_pontos_compensar INTEGER := 0;
  v_res_comp JSONB := NULL;
  v_res_est_resgate JSONB := NULL;
BEGIN
  -- 1. Se o pedido gerou GANHO_COMPRA, lança COMPENSACAO_CANCELAMENTO (sem apagar o ganho original)
  SELECT * INTO v_ganho
  FROM public.cliente_pontos_movimentacoes
  WHERE pedido_id = p_pedido_id
    AND tipo = 'GANHO_COMPRA'
    AND natureza = 'credito'
  ORDER BY id DESC
  LIMIT 1;

  IF FOUND THEN
    PERFORM set_config('lunoca.internal_points_mutation', 'on', true);
    SELECT * INTO v_carteira
    FROM public.cliente_pontos
    WHERE cliente_id = v_ganho.cliente_id
    FOR UPDATE;

    v_pontos_compensar := LEAST(v_ganho.pontos, COALESCE(v_carteira.saldo_pontos, 0));
    IF v_pontos_compensar > 0 THEN
      v_res_comp := public._aplicar_movimento_pontos_cliente(
        p_cliente_id := v_ganho.cliente_id,
        p_tipo := 'COMPENSACAO_CANCELAMENTO',
        p_natureza := 'debito',
        p_pontos := v_pontos_compensar,
        p_motivo := COALESCE(NULLIF(btrim(p_motivo), ''), 'Compensação por cancelamento do Pedido #' || p_pedido_id),
        p_chave_idempotencia := 'compensacao_cancelamento:pedido:' || p_pedido_id,
        p_pedido_id := p_pedido_id,
        p_campanha_id := NULL,
        p_lote_origem_id := v_ganho.id,
        p_expira_em := NULL
      );
    END IF;
  END IF;

  -- 2. Se houve RESGATE vinculado ao pedido, devolve via ESTORNO_RESGATE
  SELECT * INTO v_resgate
  FROM public.cliente_pontos_movimentacoes
  WHERE pedido_id = p_pedido_id
    AND tipo = 'RESGATE'
    AND natureza = 'debito'
  ORDER BY id DESC
  LIMIT 1;

  IF FOUND THEN
    v_res_est_resgate := public._aplicar_movimento_pontos_cliente(
      p_cliente_id := v_resgate.cliente_id,
      p_tipo := 'ESTORNO_RESGATE',
      p_natureza := 'credito',
      p_pontos := v_resgate.pontos,
      p_motivo := 'Devolução de pontos resgatados por cancelamento do Pedido #' || p_pedido_id,
      p_chave_idempotencia := 'estorno_resgate:pedido:' || p_pedido_id,
      p_pedido_id := p_pedido_id,
      p_campanha_id := NULL,
      p_lote_origem_id := v_resgate.id,
      p_expira_em := NOW() + INTERVAL '180 days'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'compensacao_ganho', v_res_comp,
    'estorno_resgate', v_res_est_resgate
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._compensar_pontos_pedido_cancelado_interno(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._compensar_pontos_pedido_cancelado_interno(BIGINT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.compensar_pontos_pedido_cancelado(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT 'Estorno compensatório por cancelamento do pedido'
)
RETURNS JSONB AS $$
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;
  RETURN public._compensar_pontos_pedido_cancelado_interno(p_pedido_id, p_motivo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.compensar_pontos_pedido_cancelado(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compensar_pontos_pedido_cancelado(BIGINT, TEXT) TO authenticated, service_role;

-- Trigger automático em public.pedidos para creditar na conclusão e compensar no cancelamento
CREATE OR REPLACE FUNCTION public.trg_fn_fidelidade_pedido_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status_comercial = 'concluido' AND COALESCE(OLD.status_comercial, '') <> 'concluido' THEN
    PERFORM public._creditar_pontos_pedido_interno(NEW.id);
  ELSIF NEW.status_comercial = 'cancelado' AND COALESCE(OLD.status_comercial, '') <> 'cancelado' THEN
    PERFORM public._compensar_pontos_pedido_cancelado_interno(NEW.id, 'Cancelamento do Pedido #' || NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_fidelidade_pedido_status ON public.pedidos;
CREATE TRIGGER trg_fidelidade_pedido_status
  AFTER UPDATE OF status_comercial ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_fidelidade_pedido_status();

-- ------------------------------------------------------------------------------
-- 10. RESGATE CONCORRENTE E AJUSTE ADMINISTRATIVO DE PONTOS (GATES I5, I6, I9, I10)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resgatar_pontos_fidelidade(
  p_cliente_id BIGINT,
  p_pontos INTEGER,
  p_pedido_id BIGINT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_prog public.programas_fidelidade;
  v_res JSONB;
  v_beneficio NUMERIC(10,2);
  v_chave TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  IF p_cliente_id IS NULL OR p_pontos IS NULL OR p_pontos <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_POINTS', 'error', 'Cliente e quantidade de pontos positiva são obrigatórios.');
  END IF;

  -- 1. Processa expiração de lotes vencidos antes de permitir qualquer resgate (Gate I7)
  PERFORM public._processar_expiracao_pontos_cliente(p_cliente_id, NOW());

  SELECT * INTO v_prog
  FROM public.programas_fidelidade
  WHERE ativo = true
  ORDER BY id ASC
  LIMIT 1;

  IF p_pontos < COALESCE(v_prog.resgate_minimo_pontos, 10) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MIN_REDEMPTION_NOT_MET',
      'minimo_pontos', COALESCE(v_prog.resgate_minimo_pontos, 10),
      'error', 'Quantidade de pontos abaixo do mínimo para resgate.'
    );
  END IF;

  v_chave := COALESCE(NULLIF(btrim(p_chave_idempotencia), ''), 'resgate:' || p_cliente_id || ':' || COALESCE(p_pedido_id::TEXT, gen_random_uuid()::TEXT));

  v_res := public._aplicar_movimento_pontos_cliente(
    p_cliente_id := p_cliente_id,
    p_tipo := 'RESGATE',
    p_natureza := 'debito',
    p_pontos := p_pontos,
    p_motivo := CASE WHEN p_pedido_id IS NOT NULL THEN 'Resgate de pontos no Pedido #' || p_pedido_id ELSE 'Resgate de pontos de fidelidade' END,
    p_chave_idempotencia := v_chave,
    p_pedido_id := p_pedido_id,
    p_campanha_id := NULL,
    p_lote_origem_id := NULL,
    p_expira_em := NULL
  );

  IF (v_res->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_res;
  END IF;

  v_beneficio := ROUND(p_pontos * COALESCE(v_prog.valor_por_ponto_resgate, 0.0500), 2);

  RETURN v_res || jsonb_build_object(
    'valor_beneficio_reais', v_beneficio
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.resgatar_pontos_fidelidade(BIGINT, INTEGER, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resgatar_pontos_fidelidade(BIGINT, INTEGER, BIGINT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ajustar_pontos_fidelidade_admin(
  p_cliente_id BIGINT,
  p_natureza TEXT,
  p_pontos INTEGER,
  p_motivo TEXT,
  p_chave_idempotencia TEXT DEFAULT NULL,
  p_expira_em TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_prog public.programas_fidelidade;
  v_chave TEXT;
  v_expira TIMESTAMPTZ;
BEGIN
  -- Gate I9: Operador nunca ajusta pontos arbitrariamente
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem realizar ajustes manuais de pontos de fidelidade.'
    );
  END IF;

  -- Gate I10: Motivo obrigatório (>= 5 caracteres)
  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'REASON_REQUIRED',
      'error', 'Informe uma justificativa auditável com pelo menos 5 caracteres para ajustar pontos.'
    );
  END IF;

  SELECT * INTO v_prog FROM public.programas_fidelidade WHERE ativo = true ORDER BY id ASC LIMIT 1;
  v_expira := CASE
    WHEN p_natureza = 'credito' THEN COALESCE(p_expira_em, NOW() + make_interval(days => COALESCE(v_prog.validade_pontos_dias, 180)))
    ELSE NULL
  END;

  v_chave := COALESCE(NULLIF(btrim(p_chave_idempotencia), ''), 'ajuste_admin:' || p_cliente_id || ':' || gen_random_uuid()::TEXT);

  RETURN public._aplicar_movimento_pontos_cliente(
    p_cliente_id := p_cliente_id,
    p_tipo := 'AJUSTE_ADMIN',
    p_natureza := p_natureza,
    p_pontos := p_pontos,
    p_motivo := btrim(p_motivo),
    p_chave_idempotencia := v_chave,
    p_pedido_id := NULL,
    p_campanha_id := NULL,
    p_lote_origem_id := NULL,
    p_expira_em := v_expira
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_pontos_fidelidade_admin(BIGINT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_pontos_fidelidade_admin(BIGINT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. GESTÃO DE CUPONS E MOTOR CENTRAL DE DESCONTO COMBINADO (GATES I11, I12, I13, I18)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_cupom_promocional_admin(
  p_codigo TEXT,
  p_tipo TEXT,
  p_valor NUMERIC,
  p_validade_fim TIMESTAMPTZ,
  p_validade_inicio TIMESTAMPTZ DEFAULT NULL,
  p_uso_maximo_global INTEGER DEFAULT NULL,
  p_uso_maximo_cliente INTEGER DEFAULT 1,
  p_pedido_minimo NUMERIC DEFAULT 0.00,
  p_desconto_maximo NUMERIC DEFAULT NULL,
  p_descricao TEXT DEFAULT NULL,
  p_campanha_id BIGINT DEFAULT NULL,
  p_ativo BOOLEAN DEFAULT true,
  p_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_codigo_norm TEXT;
  v_cupom_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar cupons promocionais.');
  END IF;

  v_codigo_norm := UPPER(btrim(COALESCE(p_codigo, '')));
  IF char_length(v_codigo_norm) < 3 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_COUPON_CODE', 'error', 'Código do cupom deve ter ao menos 3 caracteres.');
  END IF;

  IF p_tipo NOT IN ('percentual', 'valor_fixo') OR p_valor IS NULL OR p_valor <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_COUPON_VALUE', 'error', 'Tipo ou valor do cupom inválido.');
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.cupons_promocionais
    SET codigo = v_codigo_norm,
        descricao = p_descricao,
        tipo = p_tipo,
        valor = ROUND(p_valor, 2),
        validade_inicio = COALESCE(p_validade_inicio, validade_inicio),
        validade_fim = p_validade_fim,
        uso_maximo_global = p_uso_maximo_global,
        uso_maximo_cliente = COALESCE(p_uso_maximo_cliente, 1),
        pedido_minimo = COALESCE(p_pedido_minimo, 0.00),
        desconto_maximo = p_desconto_maximo,
        campanha_id = p_campanha_id,
        ativo = COALESCE(p_ativo, true),
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_cupom_id;
  ELSE
    INSERT INTO public.cupons_promocionais (
      codigo, descricao, tipo, valor, validade_inicio, validade_fim,
      uso_maximo_global, uso_maximo_cliente, pedido_minimo, desconto_maximo,
      campanha_id, ativo, criado_por
    ) VALUES (
      v_codigo_norm, p_descricao, p_tipo, ROUND(p_valor, 2),
      COALESCE(p_validade_inicio, NOW() - INTERVAL '1 minute'), p_validade_fim,
      p_uso_maximo_global, COALESCE(p_uso_maximo_cliente, 1),
      COALESCE(p_pedido_minimo, 0.00), p_desconto_maximo,
      p_campanha_id, COALESCE(p_ativo, true), auth.uid()
    )
    ON CONFLICT (codigo) DO UPDATE SET
      tipo = EXCLUDED.tipo,
      valor = EXCLUDED.valor,
      validade_inicio = EXCLUDED.validade_inicio,
      validade_fim = EXCLUDED.validade_fim,
      uso_maximo_global = EXCLUDED.uso_maximo_global,
      uso_maximo_cliente = EXCLUDED.uso_maximo_cliente,
      pedido_minimo = EXCLUDED.pedido_minimo,
      desconto_maximo = EXCLUDED.desconto_maximo,
      ativo = EXCLUDED.ativo,
      updated_at = NOW()
    RETURNING id INTO v_cupom_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'cupom_id', v_cupom_id, 'codigo', v_codigo_norm);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_cupom_promocional_admin(TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, BIGINT, BOOLEAN, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_cupom_promocional_admin(TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, BIGINT, BOOLEAN, BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.aplicar_cupom_promocional(
  p_codigo_cupom TEXT,
  p_cliente_id BIGINT,
  p_subtotal NUMERIC,
  p_desconto_manual NUMERIC DEFAULT 0.00,
  p_desconto_frete NUMERIC DEFAULT 0.00,
  p_pontos_resgate INTEGER DEFAULT 0,
  p_motivo TEXT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL,
  p_registrar_uso BOOLEAN DEFAULT true,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cupom public.cupons_promocionais;
  v_prog public.programas_fidelidade;
  v_subtotal NUMERIC(10,2) := ROUND(COALESCE(p_subtotal, 0.00), 2);
  v_desc_manual NUMERIC(10,2) := GREATEST(0.00, ROUND(COALESCE(p_desconto_manual, 0.00), 2));
  v_desc_frete NUMERIC(10,2) := GREATEST(0.00, ROUND(COALESCE(p_desconto_frete, 0.00), 2));
  v_desc_pontos NUMERIC(10,2) := 0.00;
  v_desc_cupom NUMERIC(10,2) := 0.00;
  v_desc_total_combinado NUMERIC(10,2) := 0.00;
  v_usos_global INTEGER := 0;
  v_usos_cliente INTEGER := 0;
  v_pol JSONB;
  v_motivo_final TEXT;
  v_chave TEXT;
  v_utilizacao_id BIGINT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  IF v_subtotal <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_SUBTOTAL', 'error', 'Subtotal do pedido inválido.');
  END IF;

  IF p_codigo_cupom IS NOT NULL AND btrim(p_codigo_cupom) <> '' THEN
    SELECT * INTO v_cupom
    FROM public.cupons_promocionais
    WHERE codigo = UPPER(btrim(p_codigo_cupom))
    FOR UPDATE;

    IF NOT FOUND OR v_cupom.ativo IS NOT TRUE THEN
      RETURN jsonb_build_object('success', false, 'code', 'COUPON_NOT_FOUND_OR_INACTIVE', 'error', 'Cupom promocional inexistente ou inativo.');
    END IF;

    IF NOW() < v_cupom.validade_inicio OR NOW() > v_cupom.validade_fim THEN
      RETURN jsonb_build_object('success', false, 'code', 'COUPON_EXPIRED', 'error', 'Este cupom promocional está fora do período de validade.');
    END IF;

    IF v_subtotal < v_cupom.pedido_minimo THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'ORDER_BELOW_MINIMUM',
        'pedido_minimo', v_cupom.pedido_minimo,
        'error', 'O subtotal do pedido não atinge o valor mínimo exigido pelo cupom.'
      );
    END IF;

    SELECT COUNT(*)::INT INTO v_usos_global
    FROM public.cupom_utilizacoes
    WHERE cupom_id = v_cupom.id AND status = 'aplicado';

    IF v_cupom.uso_maximo_global IS NOT NULL AND v_usos_global >= v_cupom.uso_maximo_global THEN
      RETURN jsonb_build_object('success', false, 'code', 'COUPON_GLOBAL_LIMIT_REACHED', 'error', 'Limite global de utilizações deste cupom foi atingido.');
    END IF;

    IF p_cliente_id IS NOT NULL THEN
      SELECT COUNT(*)::INT INTO v_usos_cliente
      FROM public.cupom_utilizacoes
      WHERE cupom_id = v_cupom.id AND cliente_id = p_cliente_id AND status = 'aplicado';

      IF v_usos_cliente >= v_cupom.uso_maximo_cliente THEN
        RETURN jsonb_build_object('success', false, 'code', 'COUPON_CLIENT_LIMIT_REACHED', 'error', 'Cliente já atingiu o limite máximo de uso deste cupom.');
      END IF;
    END IF;

    IF v_cupom.tipo = 'percentual' THEN
      v_desc_cupom := ROUND(v_subtotal * (v_cupom.valor / 100.0), 2);
    ELSE
      v_desc_cupom := ROUND(v_cupom.valor, 2);
    END IF;

    IF v_cupom.desconto_maximo IS NOT NULL THEN
      v_desc_cupom := LEAST(v_desc_cupom, v_cupom.desconto_maximo);
    END IF;

    v_desc_cupom := LEAST(v_desc_cupom, v_subtotal);
  END IF;

  IF COALESCE(p_pontos_resgate, 0) > 0 THEN
    SELECT * INTO v_prog FROM public.programas_fidelidade WHERE ativo = true ORDER BY id ASC LIMIT 1;
    v_desc_pontos := ROUND(p_pontos_resgate * COALESCE(v_prog.valor_por_ponto_resgate, 0.0500), 2);
  END IF;

  -- Gate I13: Desconto combinado (cupom + manual + frete + pontos) validado centralizadamente em politica_desconto
  v_desc_total_combinado := ROUND(v_desc_cupom + v_desc_manual + v_desc_frete + v_desc_pontos, 2);
  v_motivo_final := COALESCE(
    NULLIF(btrim(p_motivo), ''),
    CASE WHEN v_cupom.id IS NOT NULL THEN 'Cupom promocional ' || v_cupom.codigo ELSE NULL END
  );

  v_pol := public.politica_desconto(v_subtotal, v_desc_total_combinado, v_motivo_final);
  IF (v_pol->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_pol;
  END IF;

  IF p_registrar_uso IS TRUE AND v_cupom.id IS NOT NULL AND p_cliente_id IS NOT NULL THEN
    v_chave := COALESCE(
      NULLIF(btrim(p_chave_idempotencia), ''),
      'cupom:' || v_cupom.id || ':cli:' || p_cliente_id || ':' || COALESCE(p_pedido_id::TEXT, (v_usos_cliente + 1)::TEXT)
    );

    INSERT INTO public.cupom_utilizacoes (
      cupom_id, cliente_id, pedido_id, subtotal_pedido,
      valor_desconto_cupom, desconto_manual_combinado, desconto_frete_combinado,
      beneficio_pontos_combinado, status, chave_idempotencia, usuario_id
    ) VALUES (
      v_cupom.id, p_cliente_id, p_pedido_id, v_subtotal,
      v_desc_cupom, v_desc_manual, v_desc_frete,
      v_desc_pontos, 'aplicado', v_chave, auth.uid()
    )
    ON CONFLICT (chave_idempotencia) DO NOTHING
    RETURNING id INTO v_utilizacao_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'cupom_id', v_cupom.id,
    'codigo_cupom', v_cupom.codigo,
    'utilizacao_id', v_utilizacao_id,
    'subtotal', v_subtotal,
    'desconto_cupom', v_desc_cupom,
    'desconto_manual', v_desc_manual,
    'desconto_frete', v_desc_frete,
    'beneficio_pontos', v_desc_pontos,
    'desconto_total_combinado', v_desc_total_combinado,
    'total_liquido', ROUND(v_subtotal - v_desc_total_combinado, 2),
    'percentual_combinado', (v_pol->>'percentual')::NUMERIC
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aplicar_cupom_promocional(TEXT, BIGINT, NUMERIC, NUMERIC, NUMERIC, INTEGER, TEXT, BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aplicar_cupom_promocional(TEXT, BIGINT, NUMERIC, NUMERIC, NUMERIC, INTEGER, TEXT, BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. CONSENTIMENTO DE MARKETING (OPT-IN / OPT-OUT) E VERIFICAÇÃO (GATES I14, I15, I16)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_status_consentimento_marketing(
  p_cliente_id BIGINT,
  p_canal TEXT DEFAULT 'whatsapp_marketing'
)
RETURNS TEXT AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM public.cliente_consentimentos_marketing
  WHERE cliente_id = p_cliente_id
    AND canal = p_canal
  ORDER BY data_hora DESC, id DESC
  LIMIT 1;

  -- Fail-closed para marketing: sem opt-in explícito registrado, considera opt_out
  RETURN COALESCE(v_status, 'sem_consentimento');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_status_consentimento_marketing(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_status_consentimento_marketing(BIGINT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.registrar_consentimento_marketing(
  p_cliente_id BIGINT,
  p_canal TEXT,
  p_status TEXT,
  p_origem TEXT DEFAULT 'painel_admin',
  p_versao_termo TEXT DEFAULT 'v1.0',
  p_observacao TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_REQUIRED', 'error', 'Cliente é obrigatório.');
  END IF;

  IF p_canal NOT IN ('whatsapp_marketing', 'email_marketing', 'sms_marketing') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MARKETING_CHANNEL', 'error', 'Canal de marketing inválido.');
  END IF;

  IF p_status NOT IN ('opt_in', 'opt_out') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CONSENT_STATUS', 'error', 'Status deve ser opt_in ou opt_out.');
  END IF;

  INSERT INTO public.cliente_consentimentos_marketing (
    cliente_id, canal, status, origem, versao_termo, observacao, data_hora, registrado_por
  ) VALUES (
    p_cliente_id,
    p_canal,
    p_status,
    COALESCE(NULLIF(btrim(p_origem), ''), 'painel_admin'),
    COALESCE(NULLIF(btrim(p_versao_termo), ''), 'v1.0'),
    p_observacao,
    NOW(),
    auth.uid()
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'consentimento_id', v_id,
    'cliente_id', p_cliente_id,
    'canal', p_canal,
    'status_vigente', p_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_consentimento_marketing(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_consentimento_marketing(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. EXTENSÃO DA ESTEIRA CANÔNICA DE COMUNICAÇÃO (FRENTE B) PARA MARKETING
-- ------------------------------------------------------------------------------
-- Mantém assinatura única para obter_preview_comunicacao (3 args) e
-- registrar_comunicacao_cliente (7 args) para 100% de idempotência do install.sql
-- com a Migration 015, e expõe obter_preview_comunicacao_marketing e
-- registrar_comunicacao_cliente_marketing gravando na mesma trilha comunicacoes_cliente.
DROP FUNCTION IF EXISTS public.obter_preview_comunicacao(TEXT, BIGINT, BIGINT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS public.registrar_comunicacao_cliente(TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT);

CREATE OR REPLACE FUNCTION public.obter_preview_comunicacao_marketing(
  p_tipo TEXT,
  p_campanha_id BIGINT,
  p_cliente_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_camp public.campanhas;
  v_cli public.clientes;
  v_cupom public.cupons_promocionais;
  v_telefone_raw TEXT;
  v_telefone_norm TEXT;
  v_mensagem TEXT;
  v_chave_idempotencia TEXT;
  v_consentimento TEXT;
  v_saldo_pontos INTEGER := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerar previews de comunicação.');
  END IF;

  IF p_tipo IS NULL OR p_tipo NOT IN (
    'CUPOM_ANIVERSARIO',
    'VOLTE_A_COMPRAR',
    'CAMPANHA_PASCOA',
    'CAMPANHA_PROMOCIONAL',
    'LEMBRETE_PONTOS_EXPIRANDO'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_TEMPLATE_TYPE', 'error', 'Tipo de template de marketing inválido.');
  END IF;

  IF p_campanha_id IS NULL OR p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMPAIGN_AND_CLIENT_REQUIRED', 'error', 'Campanha e cliente são obrigatórios para templates de marketing.');
  END IF;

  SELECT * INTO v_camp FROM public.campanhas WHERE id = p_campanha_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMPAIGN_NOT_FOUND', 'error', 'Campanha não encontrada.');
  END IF;

  SELECT * INTO v_cli FROM public.clientes WHERE id = p_cliente_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_NOT_FOUND', 'error', 'Cliente não encontrado.');
  END IF;

  v_consentimento := public.obter_status_consentimento_marketing(v_cli.id, v_camp.canal);
  IF v_consentimento <> 'opt_in' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MARKETING_OPT_IN_REQUIRED',
      'consentimento_status', v_consentimento,
      'error', 'Envio promocional bloqueado: o cliente não possui consentimento ativo (opt-in) para marketing neste canal.'
    );
  END IF;

  v_telefone_raw := COALESCE(v_cli.telefone_normalizado, v_cli.telefone);
  v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
  IF v_telefone_norm IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido para envio.');
  END IF;

  SELECT COALESCE((
    SELECT saldo_pontos FROM public.cliente_pontos WHERE cliente_id = v_cli.id
  ), 0) INTO v_saldo_pontos;

  IF v_camp.cupom_id IS NOT NULL THEN
    SELECT * INTO v_cupom FROM public.cupons_promocionais WHERE id = v_camp.cupom_id;
  END IF;

  v_chave_idempotencia := 'campanha:' || v_camp.id || ':cliente:' || v_cli.id;
  v_mensagem := replace(COALESCE(v_camp.mensagem_template, ''), '{{nome}}', COALESCE(v_cli.nome, 'Cliente'));
  v_mensagem := replace(v_mensagem, '{{pontos}}', COALESCE(v_saldo_pontos, 0)::TEXT);
  v_mensagem := replace(v_mensagem, '{{cupom}}', COALESCE(v_cupom.codigo, ''));

  RETURN jsonb_build_object(
    'success', true,
    'tipo', p_tipo,
    'natureza_comunicacao', 'marketing',
    'entidade_tipo', 'campanha',
    'campanha_id', v_camp.id,
    'cliente_id', v_cli.id,
    'cliente_nome', v_cli.nome,
    'telefone', v_telefone_norm,
    'mensagem', v_mensagem,
    'link_publico', NULL,
    'chave_idempotencia', v_chave_idempotencia
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_preview_comunicacao_marketing(TEXT, BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_preview_comunicacao_marketing(TEXT, BIGINT, BIGINT) TO authenticated, service_role;

-- Mantém assinatura única de 3 argumentos de obter_preview_comunicacao (com suporte a naturezas transacionais e, via p_orcamento_id=campanha_id e p_pedido_id=cliente_id quando p_tipo for template de marketing)
CREATE OR REPLACE FUNCTION public.obter_preview_comunicacao(
  p_tipo TEXT,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_ped public.pedidos;
  v_pag RECORD;
  v_hist RECORD;
  v_telefone_raw TEXT;
  v_telefone_norm TEXT;
  v_mensagem TEXT;
  v_chave_idempotencia TEXT;
  v_link_publico TEXT := NULL;
  v_saldo_restante NUMERIC(10,2);
  v_valor_sinal NUMERIC(10,2);
  v_data_formatada TEXT;
  v_hora_formatada TEXT;
  v_validade_formatada TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerar previews de comunicação.');
  END IF;

  IF p_tipo IN (
    'CUPOM_ANIVERSARIO',
    'VOLTE_A_COMPRAR',
    'CAMPANHA_PASCOA',
    'CAMPANHA_PROMOCIONAL',
    'LEMBRETE_PONTOS_EXPIRANDO'
  ) THEN
    RETURN public.obter_preview_comunicacao_marketing(p_tipo, p_orcamento_id, p_pedido_id);
  END IF;

  IF p_tipo IS NULL OR p_tipo NOT IN (
    'ORCAMENTO_ENVIADO',
    'ORCAMENTO_VENCENDO',
    'SINAL_CONFIRMADO',
    'PEDIDO_PRONTO',
    'SAIU_PARA_ENTREGA'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_TEMPLATE_TYPE', 'error', 'Tipo de template de comunicação inválido.');
  END IF;

  -- 1. Templates Transacionais de Orçamento (NÃO exigem opt-in de marketing — Gate I16)
  IF p_tipo IN ('ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO') THEN
    IF p_orcamento_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_ID_REQUIRED', 'error', 'ID do orçamento é obrigatório para este template.');
    END IF;

    SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_NOT_FOUND', 'error', 'Orçamento não encontrado.');
    END IF;

    v_telefone_raw := v_orc.cliente_telefone;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_link_publico := 'https://lunocadoceria.com.br/orcamento.html?t=' || v_orc.token_publico::TEXT;
    v_data_formatada := to_char(v_orc.data_evento, 'DD/MM/YYYY');
    v_hora_formatada := COALESCE(to_char(v_orc.hora_evento, 'HH24:MI'), 'A combinar');
    v_validade_formatada := to_char(v_orc.validade_ate AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI');

    IF p_tipo = 'ORCAMENTO_ENVIADO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':envio';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Preparamos sua proposta Lunoca:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Evento: ' || v_data_formatada || ' às ' || v_hora_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n\n' ||
                    'Veja todos os detalhes e aprove sua proposta:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'A aprovação da proposta não reserva estoque ou capacidade até que a encomenda seja efetivamente convertida e confirmada.';

    ELSIF p_tipo = 'ORCAMENTO_VENCENDO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':vencendo';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Lembramos que sua proposta Lunoca está próxima do vencimento:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n\n' ||
                    'Acesse para conferir ou aprovar antes do prazo expirar:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'Lembramos que a disponibilidade de data e capacidade de produção permanece sujeita à confirmação no momento da conversão da encomenda.';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'natureza_comunicacao', 'transacional',
      'entidade_tipo', 'orcamento',
      'orcamento_id', v_orc.id,
      'numero', v_orc.numero,
      'versao', v_orc.versao,
      'cliente_nome', v_orc.cliente_nome,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', v_link_publico,
      'chave_idempotencia', v_chave_idempotencia
    );

  -- 2. Templates Transacionais de Pedido (NÃO exigem opt-in de marketing — Gate I16)
  ELSE
    IF p_pedido_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_ID_REQUIRED', 'error', 'ID do pedido é obrigatório para este template.');
    END IF;

    SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_NOT_FOUND', 'error', 'Pedido não encontrado.');
    END IF;

    v_telefone_raw := v_ped.telefone_cliente;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_data_formatada := COALESCE(to_char(v_ped.data_entrega, 'DD/MM/YYYY'), 'A combinar');
    v_hora_formatada := COALESCE(to_char(v_ped.hora_entrega, 'HH24:MI'), 'A combinar');
    v_saldo_restante := GREATEST(0.00, COALESCE(v_ped.total, 0.00) - COALESCE(v_ped.valor_pago, 0.00));

    IF p_tipo = 'SINAL_CONFIRMADO' THEN
      SELECT id, valor INTO v_pag
      FROM public.pedido_pagamentos
      WHERE pedido_id = v_ped.id AND status = 'aprovado'
      ORDER BY id DESC LIMIT 1;

      IF NOT FOUND THEN
        IF COALESCE(v_ped.valor_pago, 0.00) > 0.00 THEN
          v_valor_sinal := v_ped.valor_pago;
          v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:0:sinal';
        ELSE
          RETURN jsonb_build_object('success', false, 'code', 'PAYMENT_NOT_APPROVED', 'error', 'Nenhum pagamento aprovado foi localizado para este pedido.');
        END IF;
      ELSE
        v_valor_sinal := v_pag.valor;
        v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:' || v_pag.id || ':sinal';
      END IF;

      v_mensagem := 'Recebemos seu sinal de R$ ' || to_char(v_valor_sinal, 'FM999G999G990D00') || ' ✅' || E'\n\n' ||
                    'Encomenda #' || v_ped.id || ' confirmada!' || E'\n' ||
                    'Data: ' || v_data_formatada || E'\n' ||
                    'Horário: ' || v_hora_formatada || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n' ||
                    'Total: R$ ' || to_char(v_ped.total, 'FM999G999G990D00') || E'\n' ||
                    'Saldo restante: R$ ' || to_char(v_saldo_restante, 'FM999G999G990D00') || E'\n\n' ||
                    'Agradecemos a confiança! Em breve sua encomenda entrará em produção.';

    ELSIF p_tipo = 'PEDIDO_PRONTO' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo = 'pronto'
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':pronto';
      v_mensagem := 'Sua encomenda está pronta! 🎂✨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Cliente: ' || v_ped.nome_cliente || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n\n' ||
                    CASE
                      WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Já finalizamos a preparação e em breve seu pedido sairá para entrega!'
                      ELSE 'Seu pedido já está disponível para retirada em nossa doceria. Aguardamos sua visita!'
                    END;

    ELSIF p_tipo = 'SAIU_PARA_ENTREGA' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo IN ('entregue', 'saiu_para_entrega', 'em_rota')
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':entrega';
      v_mensagem := 'Sua encomenda Lunoca saiu para entrega! 🚗💨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Destinatário: ' || v_ped.nome_cliente || E'\n' ||
                    'Endereço: ' || COALESCE(v_ped.endereco_entrega, 'Conforme combinado') || E'\n\n' ||
                    'Por favor, certifique-se de que haverá alguém para receber o pedido.' || E'\n' ||
                    'Bom apetite! 🍰';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'natureza_comunicacao', 'transacional',
      'entidade_tipo', 'pedido',
      'pedido_id', v_ped.id,
      'cliente_nome', v_ped.nome_cliente,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', NULL,
      'chave_idempotencia', v_chave_idempotencia
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_preview_comunicacao(TEXT, BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_preview_comunicacao(TEXT, BIGINT, BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.registrar_comunicacao_cliente_marketing(
  p_tipo TEXT,
  p_campanha_id BIGINT,
  p_cliente_id BIGINT,
  p_canal TEXT DEFAULT 'whatsapp_link',
  p_status TEXT DEFAULT 'link_aberto',
  p_provider_message_id TEXT DEFAULT NULL,
  p_erro TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_preview JSONB;
  v_com_id BIGINT;
  v_status_final TEXT;
  v_chave TEXT;
  v_destinatario TEXT;
  v_mensagem TEXT;
  v_enviado_em TIMESTAMPTZ := NULL;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode registrar comunicações.');
  END IF;

  IF p_canal NOT IN ('whatsapp_link', 'evolution_api') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CHANNEL', 'error', 'Canal de comunicação inválido.');
  END IF;

  v_status_final := COALESCE(p_status, 'link_aberto');

  IF p_canal = 'whatsapp_link' AND v_status_final IN ('enviado', 'entregue') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_STATUS_FOR_CHANNEL',
      'error', 'Abertura de link wa.me não comprova envio efetivo da mensagem. Para whatsapp_link, utilize status "link_aberto" ou "gerado".'
    );
  END IF;

  v_preview := public.obter_preview_comunicacao_marketing(p_tipo, p_campanha_id, p_cliente_id);
  IF (v_preview->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_preview;
  END IF;

  v_destinatario := v_preview->>'telefone';
  v_mensagem := v_preview->>'mensagem';
  v_chave := v_preview->>'chave_idempotencia';

  IF v_status_final IN ('enviado', 'entregue') THEN
    v_enviado_em := NOW();
  END IF;

  INSERT INTO public.comunicacoes_cliente (
    orcamento_id,
    pedido_id,
    campanha_id,
    cliente_id,
    tipo,
    canal,
    destinatario,
    mensagem_snapshot,
    status,
    provider,
    provider_message_id,
    chave_idempotencia,
    erro,
    metadata,
    criado_por,
    created_at,
    enviado_em
  ) VALUES (
    NULL,
    NULL,
    p_campanha_id,
    p_cliente_id,
    p_tipo,
    p_canal,
    v_destinatario,
    v_mensagem,
    v_status_final,
    CASE WHEN p_canal = 'evolution_api' THEN 'evolution_api' ELSE NULL END,
    p_provider_message_id,
    v_chave,
    p_erro,
    jsonb_build_object('preview_gerado_em', NOW(), 'natureza', 'marketing'),
    auth.uid(),
    NOW(),
    v_enviado_em
  )
  ON CONFLICT (chave_idempotencia) DO UPDATE SET
    status = EXCLUDED.status,
    provider_message_id = COALESCE(EXCLUDED.provider_message_id, comunicacoes_cliente.provider_message_id),
    erro = COALESCE(EXCLUDED.erro, comunicacoes_cliente.erro),
    enviado_em = COALESCE(EXCLUDED.enviado_em, comunicacoes_cliente.enviado_em)
  RETURNING id INTO v_com_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_com_id,
    'tipo', p_tipo,
    'canal', p_canal,
    'status', v_status_final,
    'destinatario', v_destinatario,
    'chave_idempotencia', v_chave
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_cliente_marketing(TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_cliente_marketing(TEXT, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. SEGMENTAÇÃO DINÂMICA E DISPARO AUDITÁVEL DE CAMPANHAS (GATE I17)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_campanha_admin(
  p_codigo TEXT,
  p_nome TEXT,
  p_tipo_template TEXT,
  p_mensagem_template TEXT,
  p_regra_segmentacao JSONB DEFAULT '{"segmento": "todos"}'::jsonb,
  p_canal TEXT DEFAULT 'whatsapp_marketing',
  p_cupom_id BIGINT DEFAULT NULL,
  p_bonus_pontos INTEGER DEFAULT 0,
  p_status TEXT DEFAULT 'ativa',
  p_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_camp_id BIGINT;
  v_cod TEXT := UPPER(btrim(COALESCE(p_codigo, '')));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar campanhas.');
  END IF;

  IF char_length(v_cod) < 3 OR p_nome IS NULL OR btrim(p_nome) = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CAMPAIGN', 'error', 'Código e nome da campanha são obrigatórios.');
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.campanhas
    SET codigo = v_cod,
        nome = btrim(p_nome),
        tipo_template = p_tipo_template,
        mensagem_template = p_mensagem_template,
        regra_segmentacao = COALESCE(p_regra_segmentacao, '{"segmento": "todos"}'::jsonb),
        canal = COALESCE(p_canal, 'whatsapp_marketing'),
        cupom_id = p_cupom_id,
        bonus_pontos = COALESCE(p_bonus_pontos, 0),
        status = COALESCE(p_status, 'ativa'),
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_camp_id;
  ELSE
    INSERT INTO public.campanhas (
      codigo, nome, tipo_template, mensagem_template,
      regra_segmentacao, canal, cupom_id, bonus_pontos, status, criado_por
    ) VALUES (
      v_cod, btrim(p_nome), p_tipo_template, p_mensagem_template,
      COALESCE(p_regra_segmentacao, '{"segmento": "todos"}'::jsonb),
      COALESCE(p_canal, 'whatsapp_marketing'),
      p_cupom_id, COALESCE(p_bonus_pontos, 0), COALESCE(p_status, 'ativa'), auth.uid()
    )
    ON CONFLICT (codigo) DO UPDATE SET
      nome = EXCLUDED.nome,
      tipo_template = EXCLUDED.tipo_template,
      mensagem_template = EXCLUDED.mensagem_template,
      regra_segmentacao = EXCLUDED.regra_segmentacao,
      cupom_id = EXCLUDED.cupom_id,
      bonus_pontos = EXCLUDED.bonus_pontos,
      status = EXCLUDED.status,
      updated_at = NOW()
    RETURNING id INTO v_camp_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'campanha_id', v_camp_id, 'codigo', v_cod);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_campanha_admin(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BIGINT, INTEGER, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_campanha_admin(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BIGINT, INTEGER, TEXT, BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.avaliar_publico_campanha(
  p_campanha_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_camp public.campanhas;
  v_seg TEXT;
  v_dias_inativo INT;
  v_ticket_min NUMERIC(10,2);
  v_mes_aniv INT;
  v_dias_expiracao INT;
  v_audiencia JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT * INTO v_camp FROM public.campanhas WHERE id = p_campanha_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMPAIGN_NOT_FOUND', 'error', 'Campanha não encontrada.');
  END IF;

  v_seg := COALESCE(v_camp.regra_segmentacao->>'segmento', 'todos');
  v_dias_inativo := COALESCE((v_camp.regra_segmentacao->>'dias_inatividade')::INT, 30);
  v_ticket_min := COALESCE((v_camp.regra_segmentacao->>'ticket_minimo')::NUMERIC, 150.00);
  v_mes_aniv := COALESCE((v_camp.regra_segmentacao->>'mes_aniversario')::INT, EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'America/Fortaleza'))::INT);
  v_dias_expiracao := COALESCE((v_camp.regra_segmentacao->>'dias_expiracao')::INT, 30);

  WITH metricas_cli AS (
    SELECT
      c.id AS cliente_id,
      c.nome,
      c.telefone,
      c.telefone_normalizado,
      c.data_nascimento,
      COUNT(p.id) FILTER (WHERE p.status_comercial = 'concluido') AS qtd_concluidos,
      COALESCE(AVG(p.total) FILTER (WHERE p.status_comercial = 'concluido'), 0.00) AS ticket_medio,
      MAX(p.created_at) FILTER (WHERE p.status_comercial <> 'cancelado') AS ultimo_pedido_em,
      EXISTS (
        SELECT 1 FROM public.orcamentos o
        WHERE o.cliente_id = c.id AND o.status IN ('enviado', 'aprovado', 'expirado') AND o.pedido_id IS NULL
      ) AS tem_orcamento_nao_convertido,
      COALESCE(cp.saldo_pontos, 0) AS saldo_pontos,
      EXISTS (
        SELECT 1 FROM public.cliente_pontos_movimentacoes pm
        WHERE pm.cliente_id = c.id
          AND pm.natureza = 'credito'
          AND pm.expira_em IS NOT NULL
          AND pm.expira_em > NOW()
          AND pm.expira_em <= NOW() + make_interval(days => v_dias_expiracao)
      ) AS tem_pontos_expirando,
      public.obter_status_consentimento_marketing(c.id, v_camp.canal) AS consentimento_status
    FROM public.clientes c
    LEFT JOIN public.pedidos p ON p.cliente_id_rel = c.id
    LEFT JOIN public.cliente_pontos cp ON cp.cliente_id = c.id
    GROUP BY c.id, c.nome, c.telefone, c.telefone_normalizado, c.data_nascimento, cp.saldo_pontos
  ),
  filtrados AS (
    SELECT *
    FROM metricas_cli m
    WHERE
      CASE v_seg
        WHEN 'recorrentes' THEN m.qtd_concluidos >= 2
        WHEN 'inativos' THEN m.qtd_concluidos >= 1 AND m.ultimo_pedido_em < (NOW() - make_interval(days => v_dias_inativo))
        WHEN 'aniversariantes' THEN m.data_nascimento IS NOT NULL AND EXTRACT(MONTH FROM m.data_nascimento)::INT = v_mes_aniv
        WHEN 'alto_ticket' THEN m.ticket_medio >= v_ticket_min
        WHEN 'orcamento_nao_convertido' THEN m.tem_orcamento_nao_convertido IS TRUE
        WHEN 'pontos_expirando' THEN m.saldo_pontos > 0 AND m.tem_pontos_expirando IS TRUE
        ELSE true
      END
  )
  SELECT COALESCE(jsonb_agg(row_to_json(f)::jsonb ORDER BY f.cliente_id ASC), '[]'::jsonb)
  INTO v_audiencia
  FROM filtrados f;

  RETURN jsonb_build_object(
    'success', true,
    'campanha_id', v_camp.id,
    'segmento', v_seg,
    'total_Matching', jsonb_array_length(v_audiencia),
    'audiencia', v_audiencia
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.avaliar_publico_campanha(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.avaliar_publico_campanha(BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.disparar_campanha_marketing(
  p_campanha_id BIGINT,
  p_canal_envio TEXT DEFAULT 'whatsapp_link'
)
RETURNS JSONB AS $$
DECLARE
  v_camp public.campanhas;
  v_aval JSONB;
  v_item JSONB;
  v_cli_id BIGINT;
  v_consent TEXT;
  v_com_res JSONB;
  v_qtd_disparados INTEGER := 0;
  v_qtd_bloqueados INTEGER := 0;
  v_qtd_ja_processados INTEGER := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem disparar campanhas de marketing.');
  END IF;

  SELECT * INTO v_camp FROM public.campanhas WHERE id = p_campanha_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CAMPAIGN_NOT_FOUND', 'error', 'Campanha não encontrada.');
  END IF;

  v_aval := public.avaliar_publico_campanha(p_campanha_id);
  IF (v_aval->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_aval;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_aval->'audiencia')
  LOOP
    v_cli_id := (v_item->>'cliente_id')::BIGINT;
    v_consent := v_item->>'consentimento_status';

    -- Gate I17: Nunca duplica destinatário na mesma campanha
    IF EXISTS (
      SELECT 1 FROM public.campanha_publicos
      WHERE campanha_id = p_campanha_id AND cliente_id = v_cli_id
    ) THEN
      v_qtd_ja_processados := v_qtd_ja_processados + 1;
      CONTINUE;
    END IF;

    IF v_consent <> 'opt_in' THEN
      INSERT INTO public.campanha_publicos (
        campanha_id, cliente_id, telefone_destino, consentimento_status,
        comunicacao_id, status_disparo, motivo_bloqueio, snapshot_criterio
      ) VALUES (
        p_campanha_id, v_cli_id, v_item->>'telefone_normalizado', v_consent,
        NULL, 'bloqueado_sem_consentimento', 'Cliente sem opt-in ativo de marketing', v_item
      ) ON CONFLICT (campanha_id, cliente_id) DO NOTHING;

      v_qtd_bloqueados := v_qtd_bloqueados + 1;
      CONTINUE;
    END IF;

    -- Dispara pela esteira canônica da Frente B (registrar_comunicacao_cliente_marketing -> comunicacoes_cliente)
    v_com_res := public.registrar_comunicacao_cliente_marketing(
      p_tipo := v_camp.tipo_template,
      p_campanha_id := p_campanha_id,
      p_cliente_id := v_cli_id,
      p_canal := p_canal_envio,
      p_status := CASE WHEN p_canal_envio = 'evolution_api' THEN 'enviado' ELSE 'link_aberto' END,
      p_provider_message_id := NULL,
      p_erro := NULL
    );

    IF (v_com_res->>'success')::BOOLEAN IS TRUE THEN
      INSERT INTO public.campanha_publicos (
        campanha_id, cliente_id, telefone_destino, consentimento_status,
        comunicacao_id, status_disparo, motivo_bloqueio, snapshot_criterio
      ) VALUES (
        p_campanha_id, v_cli_id, v_com_res->>'destinatario', v_consent,
        (v_com_res->>'id')::BIGINT, 'disparado', NULL, v_item
      ) ON CONFLICT (campanha_id, cliente_id) DO NOTHING;

      IF v_camp.bonus_pontos > 0 THEN
        PERFORM public._aplicar_movimento_pontos_cliente(
          p_cliente_id := v_cli_id,
          p_tipo := 'BONUS_CAMPANHA',
          p_natureza := 'credito',
          p_pontos := v_camp.bonus_pontos,
          p_motivo := 'Bônus da campanha ' || v_camp.codigo,
          p_chave_idempotencia := 'bonus_campanha:' || p_campanha_id || ':cli:' || v_cli_id,
          p_pedido_id := NULL,
          p_campanha_id := p_campanha_id,
          p_lote_origem_id := NULL,
          p_expira_em := NOW() + INTERVAL '90 days'
        );
      END IF;

      v_qtd_disparados := v_qtd_disparados + 1;
    ELSE
      INSERT INTO public.campanha_publicos (
        campanha_id, cliente_id, telefone_destino, consentimento_status,
        comunicacao_id, status_disparo, motivo_bloqueio, snapshot_criterio
      ) VALUES (
        p_campanha_id, v_cli_id, v_item->>'telefone_normalizado', v_consent,
        NULL, 'ignorado_sem_telefone', v_com_res->>'error', v_item
      ) ON CONFLICT (campanha_id, cliente_id) DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.campanhas
  SET status = 'disparada', updated_at = NOW()
  WHERE id = p_campanha_id;

  RETURN jsonb_build_object(
    'success', true,
    'campanha_id', p_campanha_id,
    'disparados', v_qtd_disparados,
    'bloqueados_sem_consentimento', v_qtd_bloqueados,
    'ja_processados_idempotente', v_qtd_ja_processados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.disparar_campanha_marketing(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disparar_campanha_marketing(BIGINT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC DE LEITURA ADMINISTRATIVA: OBTER_PAINEL_FIDELIDADE_CAMPANHAS_ADMIN
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_fidelidade_campanhas_admin()
RETURNS JSONB AS $$
DECLARE
  v_prog JSONB;
  v_resumo JSONB;
  v_cupons JSONB;
  v_campanhas JSONB;
  v_carteira_top JSONB;
  v_movs JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT row_to_json(pf)::jsonb INTO v_prog
  FROM public.programas_fidelidade pf
  WHERE pf.ativo = true
  ORDER BY pf.id ASC
  LIMIT 1;

  SELECT jsonb_build_object(
    'clientes_com_pontos', (SELECT COUNT(*) FROM public.cliente_pontos WHERE saldo_pontos > 0),
    'saldo_pontos_circulacao', COALESCE((SELECT SUM(saldo_pontos) FROM public.cliente_pontos), 0),
    'pontos_acumulados_total', COALESCE((SELECT SUM(pontos_acumulados_total) FROM public.cliente_pontos), 0),
    'pontos_resgatados_total', COALESCE((SELECT SUM(pontos_resgatados_total) FROM public.cliente_pontos), 0),
    'pontos_expirados_total', COALESCE((SELECT SUM(pontos_expirados_total) FROM public.cliente_pontos), 0),
    'cupons_ativos', (SELECT COUNT(*) FROM public.cupons_promocionais WHERE ativo = true AND validade_fim >= NOW()),
    'campanhas_registradas', (SELECT COUNT(*) FROM public.campanhas),
    'clientes_opt_in_whatsapp', (
      SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (cliente_id) cliente_id, status
        FROM public.cliente_consentimentos_marketing
        WHERE canal = 'whatsapp_marketing'
        ORDER BY cliente_id, data_hora DESC, id DESC
      ) s WHERE s.status = 'opt_in'
    )
  ) INTO v_resumo;

  SELECT COALESCE(jsonb_agg(row_to_json(cp)::jsonb ORDER BY cp.id DESC), '[]'::jsonb)
  INTO v_cupons
  FROM (
    SELECT
      c.*,
      (SELECT COUNT(*) FROM public.cupom_utilizacoes cu WHERE cu.cupom_id = c.id AND cu.status = 'aplicado') AS total_usos
    FROM public.cupons_promocionais c
    ORDER BY c.id DESC
    LIMIT 50
  ) cp;

  SELECT COALESCE(jsonb_agg(row_to_json(cm)::jsonb ORDER BY cm.id DESC), '[]'::jsonb)
  INTO v_campanhas
  FROM (
    SELECT
      ca.*,
      (SELECT COUNT(*) FROM public.campanha_publicos pub WHERE pub.campanha_id = ca.id AND pub.status_disparo = 'disparado') AS total_disparados,
      (SELECT COUNT(*) FROM public.campanha_publicos pub WHERE pub.campanha_id = ca.id AND pub.status_disparo = 'bloqueado_sem_consentimento') AS total_bloqueados
    FROM public.campanhas ca
    ORDER BY ca.id DESC
    LIMIT 50
  ) cm;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.saldo_pontos DESC), '[]'::jsonb)
  INTO v_carteira_top
  FROM (
    SELECT
      cp.cliente_id,
      cl.nome AS cliente_nome,
      cl.telefone,
      cp.saldo_pontos,
      cp.pontos_acumulados_total,
      cp.pontos_resgatados_total,
      cp.pontos_expirados_total,
      public.obter_status_consentimento_marketing(cp.cliente_id, 'whatsapp_marketing') AS consentimento_whatsapp
    FROM public.cliente_pontos cp
    JOIN public.clientes cl ON cl.id = cp.cliente_id
    ORDER BY cp.saldo_pontos DESC, cp.cliente_id ASC
    LIMIT 50
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.id DESC), '[]'::jsonb)
  INTO v_movs
  FROM (
    SELECT
      pm.id,
      pm.cliente_id,
      cl.nome AS cliente_nome,
      pm.tipo,
      pm.natureza,
      pm.pontos,
      pm.saldo_anterior,
      pm.saldo_posterior,
      pm.pedido_id,
      pm.expira_em,
      pm.motivo,
      pm.created_at
    FROM public.cliente_pontos_movimentacoes pm
    JOIN public.clientes cl ON cl.id = pm.cliente_id
    ORDER BY pm.id DESC
    LIMIT 50
  ) m;

  RETURN jsonb_build_object(
    'success', true,
    'programa', v_prog,
    'resumo', v_resumo,
    'cupons', v_cupons,
    'campanhas', v_campanhas,
    'clientes_pontos', v_carteira_top,
    'movimentacoes_recentes', v_movs
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_painel_fidelidade_campanhas_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_fidelidade_campanhas_admin() TO authenticated, service_role;
