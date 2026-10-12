-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 023: TESOURARIA, FLUXO DE CAIXA PROJETADO E CONCILIAÇÃO (FRENTE H)
-- ==============================================================================
-- Objetivo:
-- Consolidar a gestão financeira temporal (Passado Realizado x Presente Vencido x Futuro Projetado)
-- e a conciliação de lançamentos sem criar um livro-razão duplicado de fluxo de caixa.
--
-- Princípios e Invariantes Centrais:
-- 1. Separação Financeira Estrita:
--    caixa_realizado != caixa_projetado != faturamento_competencia != saldo_credito_cliente
-- 2. Fontes Canônicas (Zero Duplicação de Movimentações):
--    - Realizado: public.financeiro_lancamentos + public.pedido_pagamentos
--    - Contas a Pagar (Projetado/Vencido): public.contas_pagar (Frente G)
--    - Recebimentos Previstos (Projetado/Vencido): public.pedidos (somente status_comercial = 'confirmado'
--      com saldo > 0; orçamentos ou pedidos cancelados NUNCA entram no projetado)
--    - Passivo de Créditos: public.cliente_creditos e public.cliente_credito_movimentacoes (Frente C)
-- 3. Estruturas Próprias da Tesouraria (apenas fatos inéditos):
--    - public.contas_financeiras (caixa físico, conta PIX, gateway, banco)
--    - public.conciliacoes_financeiras (livro append-only imutável de conciliação)
--    - public.ajustes_tesouraria (livro append-only imutável de ajustes manuais de tesouraria)
-- 4. Timezone Canônico: America/Fortaleza
-- 5. Segregação de Privilégios (RBAC Fail-Closed):
--    - Exclusivamente Administradores (public.is_admin()) acessam saldos bancários,
--      fluxo de caixa, posição de tesouraria, conciliações e ajustes manuais.
--    - Operadores, clientes comuns e anônimos são bloqueados (fail-closed).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSÃO DE ORIGEM_TIPO EM FINANCEIRO_LANCAMENTOS (COMPATIBILIDADE)
-- ------------------------------------------------------------------------------
-- Garante que financeiro_lancamentos aceite ajustes de tesouraria mantendo uq_financeiro_origem_evento
CREATE INDEX IF NOT EXISTS idx_financeiro_lancamentos_origem
  ON public.financeiro_lancamentos(origem_tipo, origem_id);

-- ------------------------------------------------------------------------------
-- 2. TABELA: CONTAS_FINANCEIRAS (CARTEIRAS BANCÁRIAS / CAIXA DA CONFEITARIA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contas_financeiras (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('caixa', 'banco', 'gateway', 'carteira_digital')),
  instituicao TEXT,
  saldo_inicial NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  data_saldo_inicial DATE NOT NULL DEFAULT '2026-01-01',
  padrao_metodo TEXT CHECK (padrao_metodo IS NULL OR padrao_metodo IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'boleto', 'outro')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed idempotente das contas financeiras padrão da operação
INSERT INTO public.contas_financeiras (codigo, nome, tipo, instituicao, saldo_inicial, data_saldo_inicial, padrao_metodo, ativo)
VALUES
  ('caixa_fisico', 'Caixa Físico (Loja / Balcão)', 'caixa', 'Interno', 0.00, '2026-01-01', 'dinheiro', true),
  ('conta_pix_principal', 'Conta Bancária PIX / Transferências', 'banco', 'Banco Principal', 0.00, '2026-01-01', 'pix', true),
  ('gateway_mercadopago', 'Mercado Pago (Cartões & Checkout)', 'gateway', 'Mercado Pago', 0.00, '2026-01-01', 'cartao', true)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. TABELA: CONCILIACOES_FINANCEIRAS (APPEND-ONLY / IMUTÁVEL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conciliacoes_financeiras (
  id BIGSERIAL PRIMARY KEY,
  origem_tipo TEXT NOT NULL CHECK (origem_tipo IN ('pedido_pagamento', 'financeiro_lancamento', 'ajuste_tesouraria')),
  origem_id BIGINT NOT NULL,
  conta_financeira_id BIGINT REFERENCES public.contas_financeiras(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pendente', 'conciliado', 'divergente', 'ignorado_com_motivo')),
  valor_interno NUMERIC(12,2) NOT NULL,
  valor_extrato NUMERIC(12,2) NOT NULL,
  diferenca NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  referencia_externa TEXT,
  motivo TEXT,
  idempotency_key TEXT UNIQUE,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT 'Administrador',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conciliacoes_fin_origem
  ON public.conciliacoes_financeiras(origem_tipo, origem_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_conciliacoes_fin_status
  ON public.conciliacoes_financeiras(status, created_at DESC);

-- ------------------------------------------------------------------------------
-- 4. TABELA: AJUSTES_TESOURARIA (APPEND-ONLY / IMUTÁVEL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ajustes_tesouraria (
  id BIGSERIAL PRIMARY KEY,
  conta_financeira_id BIGINT NOT NULL REFERENCES public.contas_financeiras(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  categoria TEXT NOT NULL DEFAULT 'Ajuste de Tesouraria',
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0.00),
  data_competencia DATE NOT NULL DEFAULT CURRENT_DATE,
  motivo TEXT NOT NULL CHECK (char_length(btrim(motivo)) >= 5),
  lancamento_id BIGINT REFERENCES public.financeiro_lancamentos(id) ON DELETE RESTRICT,
  idempotency_key TEXT UNIQUE,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT 'Administrador',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ajustes_tesouraria_data
  ON public.ajustes_tesouraria(data_competencia DESC, id DESC);

-- ------------------------------------------------------------------------------
-- 5. TRIGGERS DE IMUTABILIDADE (APPEND-ONLY) PARA CONCILIAÇÕES E AJUSTES
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bloquear_mutacao_tesouraria_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Operação % não permitida em %. Os registros de conciliação e ajustes de tesouraria são estritamente imutáveis (append-only).', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_conciliacoes_fin ON public.conciliacoes_financeiras;
CREATE TRIGGER trg_imutabilidade_conciliacoes_fin
  BEFORE UPDATE OR DELETE ON public.conciliacoes_financeiras
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_tesouraria_append_only();

DROP TRIGGER IF EXISTS trg_imutabilidade_ajustes_tesouraria ON public.ajustes_tesouraria;
CREATE TRIGGER trg_imutabilidade_ajustes_tesouraria
  BEFORE UPDATE OR DELETE ON public.ajustes_tesouraria
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_tesouraria_append_only();

-- ------------------------------------------------------------------------------
-- 6. RLS FAIL-CLOSED E REVOGAÇÃO DE ESCRITA DIRETA
-- ------------------------------------------------------------------------------
ALTER TABLE public.contas_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conciliacoes_financeiras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ajustes_tesouraria ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.contas_financeiras FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.conciliacoes_financeiras FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ajustes_tesouraria FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.contas_financeiras TO authenticated, service_role;
GRANT SELECT ON public.conciliacoes_financeiras TO authenticated, service_role;
GRANT SELECT ON public.ajustes_tesouraria TO authenticated, service_role;

GRANT ALL ON public.contas_financeiras TO service_role;
GRANT ALL ON public.conciliacoes_financeiras TO service_role;
GRANT ALL ON public.ajustes_tesouraria TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.contas_financeiras_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.conciliacoes_financeiras_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ajustes_tesouraria_id_seq TO service_role;

DROP POLICY IF EXISTS "Apenas admins visualizam contas_financeiras" ON public.contas_financeiras;
CREATE POLICY "Apenas admins visualizam contas_financeiras"
  ON public.contas_financeiras FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Apenas admins visualizam conciliacoes_financeiras" ON public.conciliacoes_financeiras;
CREATE POLICY "Apenas admins visualizam conciliacoes_financeiras"
  ON public.conciliacoes_financeiras FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Apenas admins visualizam ajustes_tesouraria" ON public.ajustes_tesouraria;
CREATE POLICY "Apenas admins visualizam ajustes_tesouraria"
  ON public.ajustes_tesouraria FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------------------------
-- 7. HELPER INTERNO: DATA EFETIVA DO LANÇAMENTO NO FUSO AMERICA/FORTALEZA
-- ------------------------------------------------------------------------------
-- Resolve a data local (America/Fortaleza) respeitando timestamps explícitos (created_at / pago_em)
-- ou data_lancamento informada manualmente.
CREATE OR REPLACE FUNCTION public._tesouraria_data_efetiva_lancamento(
  p_data_lancamento DATE,
  p_created_at TIMESTAMPTZ,
  p_origem_tipo TEXT DEFAULT NULL,
  p_origem_id BIGINT DEFAULT NULL
)
RETURNS DATE AS $$
DECLARE
  v_pago_em TIMESTAMPTZ;
  v_hoje_fortaleza DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
BEGIN
  -- Se o lançamento veio de um pedido_pagamento e possui pago_em explícito, prioriza pago_em no fuso Fortaleza
  IF p_origem_tipo = 'pedido_pagamento' AND p_origem_id IS NOT NULL THEN
    SELECT pago_em INTO v_pago_em
    FROM public.pedido_pagamentos
    WHERE id = p_origem_id;

    IF v_pago_em IS NOT NULL THEN
      RETURN (v_pago_em AT TIME ZONE 'America/Fortaleza')::DATE;
    END IF;
  END IF;

  -- Se created_at foi explicitamente definido fora do instante atual (ex: backfill ou teste de fuso),
  -- converte diretamente created_at para America/Fortaleza
  IF p_created_at IS NOT NULL AND ABS(EXTRACT(EPOCH FROM (p_created_at - NOW()))) > 5 THEN
    RETURN (p_created_at AT TIME ZONE 'America/Fortaleza')::DATE;
  END IF;

  -- Se data_lancamento foi informada diferente do CURRENT_DATE padrão, respeita data_lancamento
  IF p_data_lancamento IS NOT NULL AND p_data_lancamento <> CURRENT_DATE AND p_data_lancamento <> v_hoje_fortaleza THEN
    RETURN p_data_lancamento;
  END IF;

  RETURN COALESCE((p_created_at AT TIME ZONE 'America/Fortaleza')::DATE, p_data_lancamento, v_hoje_fortaleza);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._tesouraria_data_efetiva_lancamento(DATE, TIMESTAMPTZ, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._tesouraria_data_efetiva_lancamento(DATE, TIMESTAMPTZ, TEXT, BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 8. RPC: SALVAR_CONTA_FINANCEIRA_ADMIN
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_conta_financeira_admin(
  p_codigo TEXT,
  p_nome TEXT,
  p_tipo TEXT DEFAULT 'banco',
  p_instituicao TEXT DEFAULT NULL,
  p_saldo_inicial NUMERIC DEFAULT 0.00,
  p_data_saldo_inicial DATE DEFAULT '2026-01-01',
  p_padrao_metodo TEXT DEFAULT NULL,
  p_ativo BOOLEAN DEFAULT true,
  p_observacoes TEXT DEFAULT NULL,
  p_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_conta_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar contas financeiras.');
  END IF;

  IF p_nome IS NULL OR char_length(btrim(p_nome)) < 2 OR p_codigo IS NULL OR char_length(btrim(p_codigo)) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ACCOUNT_DATA', 'error', 'Código e nome da conta financeira são obrigatórios.');
  END IF;

  IF p_tipo NOT IN ('caixa', 'banco', 'gateway', 'carteira_digital') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ACCOUNT_TYPE', 'error', 'Tipo de conta inválido.');
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.contas_financeiras
    SET
      codigo = lower(btrim(p_codigo)),
      nome = btrim(p_nome),
      tipo = p_tipo,
      instituicao = NULLIF(btrim(p_instituicao), ''),
      saldo_inicial = ROUND(COALESCE(p_saldo_inicial, 0.00), 2),
      data_saldo_inicial = COALESCE(p_data_saldo_inicial, '2026-01-01'::DATE),
      padrao_metodo = p_padrao_metodo,
      ativo = COALESCE(p_ativo, true),
      observacoes = NULLIF(btrim(p_observacoes), ''),
      updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_conta_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ACCOUNT_NOT_FOUND', 'error', 'Conta financeira não encontrada.');
    END IF;
  ELSE
    INSERT INTO public.contas_financeiras (
      codigo, nome, tipo, instituicao, saldo_inicial, data_saldo_inicial, padrao_metodo, ativo, observacoes
    ) VALUES (
      lower(btrim(p_codigo)),
      btrim(p_nome),
      p_tipo,
      NULLIF(btrim(p_instituicao), ''),
      ROUND(COALESCE(p_saldo_inicial, 0.00), 2),
      COALESCE(p_data_saldo_inicial, '2026-01-01'::DATE),
      p_padrao_metodo,
      COALESCE(p_ativo, true),
      NULLIF(btrim(p_observacoes), '')
    )
    ON CONFLICT (codigo) DO UPDATE SET
      nome = EXCLUDED.nome,
      tipo = EXCLUDED.tipo,
      instituicao = EXCLUDED.instituicao,
      saldo_inicial = EXCLUDED.saldo_inicial,
      data_saldo_inicial = EXCLUDED.data_saldo_inicial,
      padrao_metodo = EXCLUDED.padrao_metodo,
      ativo = EXCLUDED.ativo,
      observacoes = EXCLUDED.observacoes,
      updated_at = NOW()
    RETURNING id INTO v_conta_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'conta_financeira_id', v_conta_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_conta_financeira_admin(TEXT, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT, BOOLEAN, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_conta_financeira_admin(TEXT, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT, BOOLEAN, TEXT, BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC: REGISTRAR_AJUSTE_TESOURARIA_ADMIN (ADMIN + MOTIVO + DRE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_ajuste_tesouraria_admin(
  p_conta_financeira_id BIGINT,
  p_tipo TEXT,
  p_valor NUMERIC,
  p_motivo TEXT,
  p_data_competencia DATE DEFAULT NULL,
  p_categoria TEXT DEFAULT 'Ajuste de Tesouraria',
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_conta RECORD;
  v_existente RECORD;
  v_data DATE := COALESCE(p_data_competencia, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);
  v_usuario_nome TEXT;
  v_lanc_id BIGINT;
  v_ajuste_id BIGINT;
  v_forma_pag TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem registrar ajustes manuais de tesouraria.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe um motivo auditável com pelo menos 5 caracteres para o ajuste de tesouraria.');
  END IF;

  IF p_tipo NOT IN ('entrada', 'saida') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ADJUSTMENT_TYPE', 'error', 'O tipo de ajuste deve ser entrada ou saida.');
  END IF;

  IF p_valor IS NULL OR ROUND(p_valor, 2) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_AMOUNT', 'error', 'O valor do ajuste deve ser maior que zero.');
  END IF;

  -- Idempotência
  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT * INTO v_existente
    FROM public.ajustes_tesouraria
    WHERE idempotency_key = btrim(p_idempotency_key);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'ajuste_id', v_existente.id,
        'lancamento_id', v_existente.lancamento_id,
        'valor', v_existente.valor,
        'tipo', v_existente.tipo
      );
    END IF;
  END IF;

  SELECT * INTO v_conta
  FROM public.contas_financeiras
  WHERE id = p_conta_financeira_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ACCOUNT_NOT_FOUND', 'error', 'Conta financeira não encontrada ou inativa.');
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  v_forma_pag := COALESCE(v_conta.padrao_metodo, CASE WHEN v_conta.tipo = 'caixa' THEN 'dinheiro' ELSE 'transferencia' END);

  -- 1. Insere lançamento espelhado em financeiro_lancamentos para reconciliação 100% com o DRE/Caixa
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    origem_tipo,
    origem_id,
    evento,
    observacoes
  ) VALUES (
    CASE WHEN p_tipo = 'entrada' THEN 'receita' ELSE 'despesa' END,
    COALESCE(NULLIF(btrim(p_categoria), ''), 'Ajuste de Tesouraria'),
    format('Ajuste de Tesouraria (%s): %s', v_conta.nome, btrim(p_motivo)),
    ROUND(p_valor, 2),
    v_data,
    v_forma_pag,
    'ajuste_tesouraria',
    NULL,
    NULL,
    btrim(p_motivo)
  )
  RETURNING id INTO v_lanc_id;

  -- 2. Registra no livro append-only ajustes_tesouraria
  INSERT INTO public.ajustes_tesouraria (
    conta_financeira_id,
    tipo,
    categoria,
    valor,
    data_competencia,
    motivo,
    lancamento_id,
    idempotency_key,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_conta.id,
    p_tipo,
    COALESCE(NULLIF(btrim(p_categoria), ''), 'Ajuste de Tesouraria'),
    ROUND(p_valor, 2),
    v_data,
    btrim(p_motivo),
    v_lanc_id,
    NULLIF(btrim(p_idempotency_key), ''),
    auth.uid(),
    COALESCE(v_usuario_nome, 'Administrador')
  )
  RETURNING id INTO v_ajuste_id;

  -- Vincula origem_id no lançamento financeiro
  UPDATE public.financeiro_lancamentos
  SET origem_id = v_ajuste_id,
      evento = 'ajuste_' || v_ajuste_id::TEXT
  WHERE id = v_lanc_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'ajuste_id', v_ajuste_id,
    'lancamento_id', v_lanc_id,
    'valor', ROUND(p_valor, 2),
    'tipo', p_tipo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_ajuste_tesouraria_admin(BIGINT, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_ajuste_tesouraria_admin(BIGINT, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. RPC: REGISTRAR_CONCILIACAO_FINANCEIRA_ADMIN (IDEMPOTENTE + APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_conciliacao_financeira_admin(
  p_origem_tipo TEXT,
  p_origem_id BIGINT,
  p_status TEXT,
  p_valor_extrato NUMERIC DEFAULT NULL,
  p_conta_financeira_id BIGINT DEFAULT NULL,
  p_referencia_externa TEXT DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_existente RECORD;
  v_ult_conc RECORD;
  v_valor_interno NUMERIC(12,2);
  v_valor_ext NUMERIC(12,2);
  v_dif NUMERIC(12,2);
  v_metodo TEXT;
  v_conta_id BIGINT := p_conta_financeira_id;
  v_usuario_nome TEXT;
  v_conc_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem realizar conciliação financeira.');
  END IF;

  IF p_origem_tipo NOT IN ('pedido_pagamento', 'financeiro_lancamento', 'ajuste_tesouraria') OR p_origem_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ORIGIN', 'error', 'Origem de conciliação inválida.');
  END IF;

  IF p_status NOT IN ('pendente', 'conciliado', 'divergente', 'ignorado_com_motivo') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_STATUS', 'error', 'Status de conciliação inválido.');
  END IF;

  IF p_status IN ('divergente', 'ignorado_com_motivo') AND (p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5) THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Para conciliação divergente ou ignorada, informe o motivo (mínimo 5 caracteres).');
  END IF;

  -- 1. Idempotência por chave explícita
  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT * INTO v_existente
    FROM public.conciliacoes_financeiras
    WHERE idempotency_key = btrim(p_idempotency_key);

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotente', true,
        'conciliacao_id', v_existente.id,
        'origem_tipo', v_existente.origem_tipo,
        'origem_id', v_existente.origem_id,
        'status', v_existente.status,
        'valor_interno', v_existente.valor_interno,
        'valor_extrato', v_existente.valor_extrato,
        'diferenca', v_existente.diferenca
      );
    END IF;
  END IF;

  -- 2. Resolve o valor interno canônico e valida que não é crédito interno de cliente
  IF p_origem_tipo = 'pedido_pagamento' THEN
    SELECT valor, metodo INTO v_valor_interno, v_metodo
    FROM public.pedido_pagamentos
    WHERE id = p_origem_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORIGIN_NOT_FOUND', 'error', 'Pagamento de pedido não encontrado.');
    END IF;

    IF v_metodo = 'credito_cliente' THEN
      RETURN jsonb_build_object('success', false, 'code', 'CREDIT_NOT_RECONCILABLE_AS_BANK', 'error', 'Uso de crédito do cliente é liquidação interna de passivo e não transação bancária conciliável.');
    END IF;
  ELSIF p_origem_tipo = 'financeiro_lancamento' THEN
    SELECT valor, forma_pagamento INTO v_valor_interno, v_metodo
    FROM public.financeiro_lancamentos
    WHERE id = p_origem_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORIGIN_NOT_FOUND', 'error', 'Lançamento financeiro não encontrado.');
    END IF;
  ELSIF p_origem_tipo = 'ajuste_tesouraria' THEN
    SELECT valor, conta_financeira_id INTO v_valor_interno, v_conta_id
    FROM public.ajustes_tesouraria
    WHERE id = p_origem_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORIGIN_NOT_FOUND', 'error', 'Ajuste de tesouraria não encontrado.');
    END IF;
  END IF;

  v_valor_ext := ROUND(COALESCE(p_valor_extrato, v_valor_interno), 2);
  v_dif := ROUND(v_valor_ext - v_valor_interno, 2);

  -- Se conta_financeira_id não foi informada, infere pela conta padrão do método
  IF v_conta_id IS NULL AND v_metodo IS NOT NULL THEN
    SELECT id INTO v_conta_id
    FROM public.contas_financeiras
    WHERE padrao_metodo = v_metodo AND ativo = true
    ORDER BY id ASC
    LIMIT 1;
  END IF;

  -- 3. Idempotência de estado: se o último registro para a mesma (origem_tipo, origem_id)
  -- já tem exatamente o mesmo status e valor_extrato, retorna idempotente sem duplicar
  SELECT * INTO v_ult_conc
  FROM public.conciliacoes_financeiras
  WHERE origem_tipo = p_origem_tipo
    AND origem_id = p_origem_id
  ORDER BY id DESC
  LIMIT 1;

  IF FOUND
     AND v_ult_conc.status = p_status
     AND v_ult_conc.valor_extrato = v_valor_ext
     AND COALESCE(v_ult_conc.referencia_externa, '') = COALESCE(NULLIF(btrim(p_referencia_externa), ''), '')
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'conciliacao_id', v_ult_conc.id,
      'origem_tipo', v_ult_conc.origem_tipo,
      'origem_id', v_ult_conc.origem_id,
      'status', v_ult_conc.status,
      'valor_interno', v_ult_conc.valor_interno,
      'valor_extrato', v_ult_conc.valor_extrato,
      'diferenca', v_ult_conc.diferenca
    );
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  INSERT INTO public.conciliacoes_financeiras (
    origem_tipo,
    origem_id,
    conta_financeira_id,
    status,
    valor_interno,
    valor_extrato,
    diferenca,
    referencia_externa,
    motivo,
    idempotency_key,
    usuario_id,
    usuario_nome
  ) VALUES (
    p_origem_tipo,
    p_origem_id,
    v_conta_id,
    p_status,
    v_valor_interno,
    v_valor_ext,
    v_dif,
    NULLIF(btrim(p_referencia_externa), ''),
    NULLIF(btrim(p_motivo), ''),
    NULLIF(btrim(p_idempotency_key), ''),
    auth.uid(),
    COALESCE(v_usuario_nome, 'Administrador')
  )
  RETURNING id INTO v_conc_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'conciliacao_id', v_conc_id,
    'origem_tipo', p_origem_tipo,
    'origem_id', p_origem_id,
    'status', p_status,
    'valor_interno', v_valor_interno,
    'valor_extrato', v_valor_ext,
    'diferenca', v_dif
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_conciliacao_financeira_admin(TEXT, BIGINT, TEXT, NUMERIC, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_conciliacao_financeira_admin(TEXT, BIGINT, TEXT, NUMERIC, BIGINT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPC: OBTER_CONTAS_PAGAR_PERIODO_ADMIN (PREVISTO VS VENCIDO VS PAGO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_contas_pagar_periodo_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL,
  p_status TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_inicio DATE := COALESCE(p_data_inicio, (date_trunc('month', v_hoje))::DATE);
  v_fim DATE := COALESCE(p_data_fim, (v_hoje + 30));
  v_contas JSONB;
  v_total_previsto NUMERIC(12,2) := 0.00;
  v_total_vencido NUMERIC(12,2) := 0.00;
  v_total_pago NUMERIC(12,2) := 0.00;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar o calendário de contas a pagar.');
  END IF;

  SELECT
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.status IN ('aberta', 'parcial') AND cp.saldo_aberto > 0 AND cp.data_vencimento >= v_hoje), 0.00),
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.status IN ('aberta', 'parcial') AND cp.saldo_aberto > 0 AND cp.data_vencimento < v_hoje), 0.00),
    COALESCE(SUM(cp.valor_pago) FILTER (WHERE cp.status <> 'cancelada'), 0.00)
  INTO v_total_previsto, v_total_vencido, v_total_pago
  FROM public.contas_pagar cp
  WHERE cp.data_vencimento BETWEEN v_inicio AND v_fim
    AND (p_status IS NULL OR cp.status = p_status);

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.data_vencimento ASC, t.id ASC), '[]'::jsonb)
  INTO v_contas
  FROM (
    SELECT
      cp.id,
      cp.compra_id,
      cp.fornecedor_id,
      f.nome AS fornecedor_nome,
      cp.descricao,
      cp.categoria,
      cp.valor_total,
      cp.valor_pago,
      cp.saldo_aberto,
      cp.data_vencimento,
      cp.status,
      CASE
        WHEN cp.status = 'cancelada' THEN 'cancelado'
        WHEN cp.status = 'paga' OR cp.saldo_aberto <= 0 THEN 'realizado'
        WHEN cp.data_vencimento < v_hoje THEN 'vencido'
        ELSE 'previsto'
      END AS classificacao_temporal,
      cp.observacoes
    FROM public.contas_pagar cp
    LEFT JOIN public.fornecedores f ON f.id = cp.fornecedor_id
    WHERE cp.data_vencimento BETWEEN v_inicio AND v_fim
      AND (p_status IS NULL OR cp.status = p_status)
  ) t;

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'periodo', jsonb_build_object('data_inicio', v_inicio, 'data_fim', v_fim, 'timezone', 'America/Fortaleza'),
    'resumo', jsonb_build_object(
      'total_previsto', v_total_previsto,
      'total_vencido', v_total_vencido,
      'total_aberto', ROUND(v_total_previsto + v_total_vencido, 2),
      'total_pago', v_total_pago
    ),
    'contas', v_contas
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_contas_pagar_periodo_admin(DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_contas_pagar_periodo_admin(DATE, DATE, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. RPC: OBTER_RECEBIMENTOS_PREVISTOS_ADMIN (OBRIGAÇÕES COMERCIAIS REAIS)
-- ------------------------------------------------------------------------------
-- Regra de Ouro: Somente pedidos com status_comercial = 'confirmado' e saldo > 0.
-- Orçamentos não convertidos ou pedidos cancelados NUNCA entram como dinheiro futuro.
CREATE OR REPLACE FUNCTION public.obter_recebimentos_previstos_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_inicio DATE := COALESCE(p_data_inicio, (date_trunc('month', v_hoje))::DATE);
  v_fim DATE := COALESCE(p_data_fim, (v_hoje + 30));
  v_recebiveis JSONB;
  v_total_previsto NUMERIC(12,2) := 0.00;
  v_total_vencido NUMERIC(12,2) := 0.00;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar recebimentos previstos.');
  END IF;

  SELECT
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) >= v_hoje), 0.00),
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) < v_hoje), 0.00)
  INTO v_total_previsto, v_total_vencido
  FROM public.pedidos p
  WHERE p.status_comercial = 'confirmado'
    AND p.saldo > 0.00
    AND COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) BETWEEN v_inicio AND v_fim;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.data_prevista ASC, r.pedido_id ASC), '[]'::jsonb)
  INTO v_recebiveis
  FROM (
    SELECT
      p.id AS pedido_id,
      p.cliente_id_rel AS cliente_id,
      p.nome_cliente,
      p.telefone_cliente,
      p.total AS valor_total_pedido,
      p.valor_pago,
      p.saldo AS saldo_previsto,
      p.sinal_minimo,
      p.status_comercial,
      p.status_financeiro,
      p.data_entrega,
      COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) AS data_prevista,
      CASE
        WHEN COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) < v_hoje THEN 'vencido'
        ELSE 'previsto'
      END AS classificacao_temporal
    FROM public.pedidos p
    WHERE p.status_comercial = 'confirmado'
      AND p.saldo > 0.00
      AND COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) BETWEEN v_inicio AND v_fim
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'periodo', jsonb_build_object('data_inicio', v_inicio, 'data_fim', v_fim, 'timezone', 'America/Fortaleza'),
    'resumo', jsonb_build_object(
      'total_previsto', v_total_previsto,
      'total_vencido', v_total_vencido,
      'total_a_receber', ROUND(v_total_previsto + v_total_vencido, 2)
    ),
    'recebiveis', v_recebiveis
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_recebimentos_previstos_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_recebimentos_previstos_admin(DATE, DATE) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. RPC: OBTER_FLUXO_CAIXA_ADMIN (DIÁRIO + ACUMULADO + REALIZADO X PROJETADO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_fluxo_caixa_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_inicio DATE := COALESCE(p_data_inicio, (date_trunc('month', v_hoje))::DATE);
  v_fim DATE := COALESCE(p_data_fim, (v_hoje + 15));

  v_saldo_inicial_contas NUMERIC(12,2) := 0.00;
  v_mov_ant_liquido NUMERIC(12,2) := 0.00;
  v_saldo_inicial_periodo NUMERIC(12,2) := 0.00;

  v_entradas_brutas NUMERIC(12,2) := 0.00;
  v_estornos NUMERIC(12,2) := 0.00;
  v_entradas_liquidas NUMERIC(12,2) := 0.00;
  v_saidas_operacionais NUMERIC(12,2) := 0.00;
  v_liquido_realizado NUMERIC(12,2) := 0.00;

  v_entradas_previstas NUMERIC(12,2) := 0.00;
  v_entradas_vencidas NUMERIC(12,2) := 0.00;
  v_saidas_previstas NUMERIC(12,2) := 0.00;
  v_saidas_vencidas NUMERIC(12,2) := 0.00;
  v_liquido_projetado NUMERIC(12,2) := 0.00;

  v_credito_utilizado NUMERIC(12,2) := 0.00;
  v_diario JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar o fluxo de caixa.');
  END IF;

  IF v_fim < v_inicio THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_DATE_RANGE', 'error', 'A data final não pode ser anterior à data inicial.');
  END IF;

  IF (v_fim - v_inicio) > 366 THEN
    v_inicio := (v_fim - 366);
  END IF;

  -- 1. Saldo inicial das contas financeiras ativas cuja data_saldo_inicial <= v_inicio
  SELECT COALESCE(SUM(saldo_inicial), 0.00)
  INTO v_saldo_inicial_contas
  FROM public.contas_financeiras
  WHERE ativo = true
    AND data_saldo_inicial <= v_inicio;

  -- 2. Movimentação realizada líquida anterior a v_inicio (em financeiro_lancamentos)
  SELECT
    COALESCE(SUM(CASE WHEN fl.tipo = 'receita' THEN fl.valor ELSE -fl.valor END), 0.00)
  INTO v_mov_ant_liquido
  FROM public.financeiro_lancamentos fl
  WHERE public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) < v_inicio;

  v_saldo_inicial_periodo := ROUND(v_saldo_inicial_contas + v_mov_ant_liquido, 2);

  -- 3. Totais realizados no período [v_inicio, v_fim] via financeiro_lancamentos
  SELECT
    COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'receita'), 0.00),
    COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'despesa' AND fl.categoria = 'Estornos'), 0.00),
    COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'despesa' AND COALESCE(fl.categoria, '') <> 'Estornos'), 0.00)
  INTO v_entradas_brutas, v_estornos, v_saidas_operacionais
  FROM public.financeiro_lancamentos fl
  WHERE public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) BETWEEN v_inicio AND v_fim;

  v_entradas_liquidas := ROUND(v_entradas_brutas - v_estornos, 2);
  v_liquido_realizado := ROUND(v_entradas_liquidas - v_saidas_operacionais, 2);

  -- 4. Totais projetados/vencidos de Entradas (pedidos confirmados com saldo > 0) no período
  SELECT
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) >= v_hoje), 0.00),
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) < v_hoje), 0.00)
  INTO v_entradas_previstas, v_entradas_vencidas
  FROM public.pedidos p
  WHERE p.status_comercial = 'confirmado'
    AND p.saldo > 0.00
    AND COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) BETWEEN v_inicio AND v_fim;

  -- 5. Totais projetados/vencidos de Saídas (contas_pagar abertas/parciais) no período
  SELECT
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento >= v_hoje), 0.00),
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento < v_hoje), 0.00)
  INTO v_saidas_previstas, v_saidas_vencidas
  FROM public.contas_pagar cp
  WHERE cp.status IN ('aberta', 'parcial')
    AND cp.saldo_aberto > 0.00
    AND cp.data_vencimento BETWEEN v_inicio AND v_fim;

  v_liquido_projetado := ROUND((v_entradas_previstas + v_entradas_vencidas) - (v_saidas_previstas + v_saidas_vencidas), 2);

  -- 6. Crédito de cliente utilizado no período (informativo, NÃO soma no caixa bancário)
  SELECT COALESCE(SUM(ccm.valor), 0.00)
  INTO v_credito_utilizado
  FROM public.cliente_credito_movimentacoes ccm
  WHERE ccm.tipo = 'debito'
    AND ccm.origem = 'uso_pedido'
    AND (ccm.created_at AT TIME ZONE 'America/Fortaleza')::DATE BETWEEN v_inicio AND v_fim;

  -- 7. Série Diária com Saldo Acumulado Realizado e Projetado
  WITH dias AS (
    SELECT generate_series(v_inicio, v_fim, INTERVAL '1 day')::DATE AS data
  ),
  realizado_dia AS (
    SELECT
      public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) AS data,
      COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'receita'), 0.00) AS entradas_brutas,
      COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'despesa' AND fl.categoria = 'Estornos'), 0.00) AS estornos,
      COALESCE(SUM(fl.valor) FILTER (WHERE fl.tipo = 'despesa' AND COALESCE(fl.categoria, '') <> 'Estornos'), 0.00) AS saidas_operacionais
    FROM public.financeiro_lancamentos fl
    WHERE public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) BETWEEN v_inicio AND v_fim
    GROUP BY 1
  ),
  rec_prev_dia AS (
    SELECT
      COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) AS data,
      COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) >= v_hoje), 0.00) AS entradas_previstas,
      COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) < v_hoje), 0.00) AS entradas_vencidas
    FROM public.pedidos p
    WHERE p.status_comercial = 'confirmado'
      AND p.saldo > 0.00
      AND COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) BETWEEN v_inicio AND v_fim
    GROUP BY 1
  ),
  pag_prev_dia AS (
    SELECT
      cp.data_vencimento AS data,
      COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento >= v_hoje), 0.00) AS saidas_previstas,
      COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento < v_hoje), 0.00) AS saidas_vencidas
    FROM public.contas_pagar cp
    WHERE cp.status IN ('aberta', 'parcial')
      AND cp.saldo_aberto > 0.00
      AND cp.data_vencimento BETWEEN v_inicio AND v_fim
    GROUP BY 1
  ),
  consolidado_dia AS (
    SELECT
      d.data,
      COALESCE(r.entradas_brutas, 0.00) AS entradas_brutas_realizadas,
      COALESCE(r.estornos, 0.00) AS estornos_realizados,
      ROUND(COALESCE(r.entradas_brutas, 0.00) - COALESCE(r.estornos, 0.00), 2) AS entradas_realizadas,
      COALESCE(r.saidas_operacionais, 0.00) AS saidas_realizadas,
      ROUND((COALESCE(r.entradas_brutas, 0.00) - COALESCE(r.estornos, 0.00)) - COALESCE(r.saidas_operacionais, 0.00), 2) AS liquido_realizado,
      COALESCE(rp.entradas_previstas, 0.00) AS entradas_previstas,
      COALESCE(rp.entradas_vencidas, 0.00) AS entradas_vencidas,
      COALESCE(pp.saidas_previstas, 0.00) AS saidas_previstas,
      COALESCE(pp.saidas_vencidas, 0.00) AS saidas_vencidas,
      ROUND(
        (COALESCE(rp.entradas_previstas, 0.00) + COALESCE(rp.entradas_vencidas, 0.00))
        - (COALESCE(pp.saidas_previstas, 0.00) + COALESCE(pp.saidas_vencidas, 0.00)),
        2
      ) AS liquido_projetado
    FROM dias d
    LEFT JOIN realizado_dia r ON r.data = d.data
    LEFT JOIN rec_prev_dia rp ON rp.data = d.data
    LEFT JOIN pag_prev_dia pp ON pp.data = d.data
  ),
  acumulado AS (
    SELECT
      c.*,
      ROUND(
        v_saldo_inicial_periodo + SUM(c.liquido_realizado) OVER (ORDER BY c.data ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
        2
      ) AS saldo_acumulado_realizado,
      ROUND(
        v_saldo_inicial_periodo + SUM(c.liquido_realizado + c.liquido_projetado) OVER (ORDER BY c.data ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
        2
      ) AS saldo_acumulado_projetado
    FROM consolidado_dia c
  )
  SELECT COALESCE(jsonb_agg(row_to_json(a)::jsonb ORDER BY a.data ASC), '[]'::jsonb)
  INTO v_diario
  FROM acumulado a;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object(
      'data_inicio', v_inicio,
      'data_fim', v_fim,
      'data_referencia', v_hoje,
      'timezone', 'America/Fortaleza'
    ),
    'resumo', jsonb_build_object(
      'saldo_inicial_periodo', v_saldo_inicial_periodo,
      'entradas_brutas_realizadas', v_entradas_brutas,
      'estornos_realizados', v_estornos,
      'entradas_liquidas_realizadas', v_entradas_liquidas,
      'saidas_operacionais_realizadas', v_saidas_operacionais,
      'liquido_realizado', v_liquido_realizado,
      'saldo_final_realizado', ROUND(v_saldo_inicial_periodo + v_liquido_realizado, 2),
      'entradas_previstas', v_entradas_previstas,
      'entradas_vencidas', v_entradas_vencidas,
      'saidas_previstas', v_saidas_previstas,
      'saidas_vencidas', v_saidas_vencidas,
      'liquido_projetado', v_liquido_projetado,
      'saldo_final_projetado', ROUND(v_saldo_inicial_periodo + v_liquido_realizado + v_liquido_projetado, 2),
      'credito_cliente_utilizado_periodo', v_credito_utilizado
    ),
    'diario', v_diario
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_fluxo_caixa_admin(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_fluxo_caixa_admin(DATE, DATE) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. RPC: OBTER_POSICAO_TESOURARIA_ADMIN (SALDOS BANCÁRIOS + PASSIVOS + LIQUIDEZ)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_posicao_tesouraria_admin(
  p_horizonte_dias INT DEFAULT 30
)
RETURNS JSONB AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_horizonte INT := GREATEST(1, LEAST(COALESCE(p_horizonte_dias, 30), 365));
  v_fim DATE := v_hoje + v_horizonte;

  v_saldo_inicial_total NUMERIC(12,2) := 0.00;
  v_mov_liquido_ate_hoje NUMERIC(12,2) := 0.00;
  v_saldo_caixa_atual NUMERIC(12,2) := 0.00;

  v_receber_previsto NUMERIC(12,2) := 0.00;
  v_receber_vencido NUMERIC(12,2) := 0.00;
  v_pagar_previsto NUMERIC(12,2) := 0.00;
  v_pagar_vencido NUMERIC(12,2) := 0.00;

  v_passivo_creditos NUMERIC(12,2) := 0.00;
  v_saldo_projetado NUMERIC(12,2) := 0.00;
  v_necessidade_caixa NUMERIC(12,2) := 0.00;

  v_contas JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar a posição de tesouraria e saldos bancários.');
  END IF;

  SELECT COALESCE(SUM(saldo_inicial), 0.00)
  INTO v_saldo_inicial_total
  FROM public.contas_financeiras
  WHERE ativo = true AND data_saldo_inicial <= v_hoje;

  SELECT COALESCE(SUM(CASE WHEN fl.tipo = 'receita' THEN fl.valor ELSE -fl.valor END), 0.00)
  INTO v_mov_liquido_ate_hoje
  FROM public.financeiro_lancamentos fl
  WHERE public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) <= v_hoje;

  v_saldo_caixa_atual := ROUND(v_saldo_inicial_total + v_mov_liquido_ate_hoje, 2);

  -- Recebimentos em aberto no horizonte (e vencidos até hoje)
  SELECT
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) BETWEEN v_hoje AND v_fim), 0.00),
    COALESCE(SUM(p.saldo) FILTER (WHERE COALESCE(p.saldo_vencimento, p.data_entrega, (p.data_pedido AT TIME ZONE 'America/Fortaleza')::DATE) < v_hoje), 0.00)
  INTO v_receber_previsto, v_receber_vencido
  FROM public.pedidos p
  WHERE p.status_comercial = 'confirmado'
    AND p.saldo > 0.00;

  -- Contas a pagar em aberto no horizonte (e vencidas até hoje)
  SELECT
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento BETWEEN v_hoje AND v_fim), 0.00),
    COALESCE(SUM(cp.saldo_aberto) FILTER (WHERE cp.data_vencimento < v_hoje), 0.00)
  INTO v_pagar_previsto, v_pagar_vencido
  FROM public.contas_pagar cp
  WHERE cp.status IN ('aberta', 'parcial')
    AND cp.saldo_aberto > 0.00;

  -- Passivo contábil de créditos de clientes (separado do caixa bancário)
  SELECT COALESCE(SUM(saldo), 0.00)
  INTO v_passivo_creditos
  FROM public.cliente_creditos;

  v_saldo_projetado := ROUND(
    v_saldo_caixa_atual + v_receber_previsto + v_receber_vencido - v_pagar_previsto - v_pagar_vencido,
    2
  );

  v_necessidade_caixa := GREATEST(0.00, ROUND(-v_saldo_projetado, 2));

  -- Detalhamento por conta financeira
  SELECT COALESCE(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.id ASC), '[]'::jsonb)
  INTO v_contas
  FROM (
    SELECT
      cf.id,
      cf.codigo,
      cf.nome,
      cf.tipo,
      cf.instituicao,
      cf.padrao_metodo,
      cf.saldo_inicial,
      ROUND(
        cf.saldo_inicial
        + COALESCE((
            SELECT SUM(CASE WHEN fl.tipo = 'receita' THEN fl.valor ELSE -fl.valor END)
            FROM public.financeiro_lancamentos fl
            WHERE (
              (fl.origem_tipo = 'ajuste_tesouraria' AND EXISTS (
                SELECT 1 FROM public.ajustes_tesouraria at2
                WHERE at2.id = fl.origem_id AND at2.conta_financeira_id = cf.id
              ))
              OR (
                COALESCE(fl.origem_tipo, '') <> 'ajuste_tesouraria'
                AND cf.padrao_metodo IS NOT NULL
                AND (
                  fl.forma_pagamento = cf.padrao_metodo
                  OR (cf.padrao_metodo = 'pix' AND fl.forma_pagamento IN ('pix', 'transferencia'))
                  OR (cf.padrao_metodo = 'cartao' AND fl.forma_pagamento IN ('cartao', 'boleto', 'outro'))
                )
              )
            )
          ), 0.00),
        2
      ) AS saldo_estimado_atual
    FROM public.contas_financeiras cf
    WHERE cf.ativo = true
  ) c;

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'horizonte_dias', v_horizonte,
    'saldo_caixa_realizado_atual', v_saldo_caixa_atual,
    'recebimentos_previstos_horizonte', v_receber_previsto,
    'recebimentos_vencidos', v_receber_vencido,
    'contas_pagar_previstas_horizonte', v_pagar_previsto,
    'contas_pagar_vencidas', v_pagar_vencido,
    'saldo_caixa_projetado', v_saldo_projetado,
    'necessidade_caixa', v_necessidade_caixa,
    'passivo_creditos_clientes', v_passivo_creditos,
    'contas_financeiras', v_contas
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_posicao_tesouraria_admin(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_posicao_tesouraria_admin(INT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC: OBTER_CONCILIACAO_FINANCEIRA_ADMIN (VISÃO DE CONCILIAÇÃO NO PERÍODO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_conciliacao_financeira_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL,
  p_status TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_inicio DATE := COALESCE(p_data_inicio, (date_trunc('month', v_hoje))::DATE);
  v_fim DATE := COALESCE(p_data_fim, v_hoje);
  v_itens JSONB;
  v_qtd_pendente BIGINT := 0;
  v_qtd_conciliado BIGINT := 0;
  v_qtd_divergente BIGINT := 0;
  v_qtd_ignorado BIGINT := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar a conciliação financeira.');
  END IF;

  WITH ult_conc AS (
    SELECT DISTINCT ON (origem_tipo, origem_id)
      id AS conciliacao_id,
      origem_tipo,
      origem_id,
      conta_financeira_id,
      status,
      valor_interno,
      valor_extrato,
      diferenca,
      referencia_externa,
      motivo,
      usuario_nome,
      created_at AS conciliado_em
    FROM public.conciliacoes_financeiras
    ORDER BY origem_tipo, origem_id, id DESC
  ),
  lancamentos_base AS (
    SELECT
      'financeiro_lancamento'::TEXT AS origem_tipo,
      fl.id AS origem_id,
      fl.tipo AS natureza,
      fl.categoria,
      fl.descricao,
      fl.valor AS valor_interno,
      fl.forma_pagamento,
      fl.pedido_id,
      public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) AS data_efetiva,
      COALESCE(uc.status, 'pendente') AS status_conciliacao,
      uc.conciliacao_id,
      COALESCE(uc.valor_extrato, fl.valor) AS valor_extrato,
      COALESCE(uc.diferenca, 0.00) AS diferenca,
      uc.referencia_externa,
      uc.motivo,
      uc.usuario_nome,
      uc.conciliado_em
    FROM public.financeiro_lancamentos fl
    LEFT JOIN ult_conc uc
      ON uc.origem_tipo = 'financeiro_lancamento' AND uc.origem_id = fl.id
    WHERE public._tesouraria_data_efetiva_lancamento(fl.data_lancamento, fl.created_at, fl.origem_tipo, fl.origem_id) BETWEEN v_inicio AND v_fim
  )
  SELECT
    COUNT(*) FILTER (WHERE status_conciliacao = 'pendente'),
    COUNT(*) FILTER (WHERE status_conciliacao = 'conciliado'),
    COUNT(*) FILTER (WHERE status_conciliacao = 'divergente'),
    COUNT(*) FILTER (WHERE status_conciliacao = 'ignorado_com_motivo'),
    COALESCE(
      jsonb_agg(row_to_json(lb)::jsonb ORDER BY lb.data_efetiva DESC, lb.origem_id DESC)
      FILTER (WHERE p_status IS NULL OR lb.status_conciliacao = p_status),
      '[]'::jsonb
    )
  INTO v_qtd_pendente, v_qtd_conciliado, v_qtd_divergente, v_qtd_ignorado, v_itens
  FROM lancamentos_base lb;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object('data_inicio', v_inicio, 'data_fim', v_fim, 'timezone', 'America/Fortaleza'),
    'resumo', jsonb_build_object(
      'pendente', v_qtd_pendente,
      'conciliado', v_qtd_conciliado,
      'divergente', v_qtd_divergente,
      'ignorado_com_motivo', v_qtd_ignorado
    ),
    'itens', v_itens
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_conciliacao_financeira_admin(DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_conciliacao_financeira_admin(DATE, DATE, TEXT) TO authenticated, service_role;
