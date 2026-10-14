-- ==============================================================================
-- MIGRATION 034: CAIXA PDV, SESSÕES DE TURNO & FECHAMENTO DE GAVETA (FRENTE R)
-- ==============================================================================
-- 1. SEGREGAÇÃO CONCEITUAL ESTRITA:
--    Sessão de Caixa != Tesouraria != Receita Comercial != DRE Contábil
--    - pedido_pagamentos: Fonte da verdade canônica de recebimentos
--    - caixa_sessao_movimentacoes: Fonte da verdade de suprimento e sangria física
--    - caixa_sessao_pagamentos: Vínculo canônico entre recebimento e sessão de caixa
--    - caixa_sessao_auditorias: Revisão gerencial posterior append-only
-- 2. REGRAS DA GAVETA FÍSICA:
--    - SUPRIMENTO: Aporte de troco na gaveta (NÃO é receita; ZERO lançamento no DRE/Tesouraria)
--    - SANGRIA: Recolhimento de dinheiro da gaveta para cofre (NÃO é despesa; ZERO lançamento no DRE/Tesouraria)
--    - Meios eletrônicos (PIX, Cartão, Crédito) transitam por contas e NÃO compõem a gaveta física.
--    - Somente pagamentos em DINHEIRO entram na gaveta física.
-- 3. EQUAÇÃO DA GAVETA:
--    saldo_esperado_dinheiro = fundo_troco_inicial + soma(dinheiro) + suprimentos - sangrias - devolucoes_dinheiro
-- 4. CONFERÊNCIA CEGA NO SERVIDOR:
--    Operador não recebe saldo esperado antes da contagem física.
--    Divergência (quebra/sobra) exige justificativa obrigatória com mínimo de caracteres.
-- 5. SNAPSHOTS CONGELADOS E IMUTABILIDADE:
--    Fechamento calcula e congela snapshots definitivos; sessão fechada é estritamente imutável (42501).
--    Movimentações, pagamentos e auditorias são rigorosamente append-only.
-- 6. EVOLUÇÃO FORWARD-ONLY DE FINALIZAR_VENDA_PDV:
--    Exige sessão de caixa aberta para o operador (CASH_SESSION_REQUIRED) e vincula pagamento à sessão.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABELA CANÔNICA DE SESSÕES DE CAIXA (TURNO OPERACIONAL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.caixa_sessoes (
  id BIGSERIAL PRIMARY KEY,
  operador_auth_id UUID NOT NULL REFERENCES auth.users(id),
  colaborador_id BIGINT REFERENCES public.colaboradores(id) ON DELETE SET NULL,
  terminal_id TEXT NOT NULL DEFAULT 'PRINCIPAL',
  status TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'FECHADA')),
  
  aberta_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fundo_troco_inicial NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (fundo_troco_inicial >= 0),
  observacoes_abertura TEXT,
  
  fechada_em TIMESTAMPTZ,
  fechada_por UUID REFERENCES auth.users(id),
  observacoes_fechamento TEXT,
  
  -- Snapshots de fechamento congelados (preenchidos exclusivamente no fechamento)
  total_dinheiro_snapshot NUMERIC(10,2) CHECK (total_dinheiro_snapshot IS NULL OR total_dinheiro_snapshot >= 0),
  total_pix_snapshot NUMERIC(10,2) CHECK (total_pix_snapshot IS NULL OR total_pix_snapshot >= 0),
  total_cartao_snapshot NUMERIC(10,2) CHECK (total_cartao_snapshot IS NULL OR total_cartao_snapshot >= 0),
  total_outros_snapshot NUMERIC(10,2) CHECK (total_outros_snapshot IS NULL OR total_outros_snapshot >= 0),
  total_suprimentos_snapshot NUMERIC(10,2) CHECK (total_suprimentos_snapshot IS NULL OR total_suprimentos_snapshot >= 0),
  total_sangrias_snapshot NUMERIC(10,2) CHECK (total_sangrias_snapshot IS NULL OR total_sangrias_snapshot >= 0),
  total_devolucoes_dinheiro_snapshot NUMERIC(10,2) CHECK (total_devolucoes_dinheiro_snapshot IS NULL OR total_devolucoes_dinheiro_snapshot >= 0),
  
  saldo_esperado_dinheiro_snapshot NUMERIC(10,2),
  valor_contado_dinheiro NUMERIC(10,2) CHECK (valor_contado_dinheiro IS NULL OR valor_contado_dinheiro >= 0),
  diferenca_caixa NUMERIC(10,2),
  justificativa_diferenca TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- R1: Exatamente 1 sessão aberta por operador
CREATE UNIQUE INDEX IF NOT EXISTS uq_caixa_sessao_operador_aberta 
ON public.caixa_sessoes(operador_auth_id) WHERE status = 'ABERTA';

-- R2: Exatamente 1 sessão aberta por terminal
CREATE UNIQUE INDEX IF NOT EXISTS uq_caixa_sessao_terminal_aberta 
ON public.caixa_sessoes(terminal_id) WHERE status = 'ABERTA';

CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_status ON public.caixa_sessoes(status);
CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_operador ON public.caixa_sessoes(operador_auth_id);
CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_aberta_em ON public.caixa_sessoes(aberta_em);

-- ------------------------------------------------------------------------------
-- 2. TABELA CANÔNICA DE MOVIMENTAÇÕES DE CAIXA (SUPRIMENTO & SANGRIA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.caixa_sessao_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  sessao_id BIGINT NOT NULL REFERENCES public.caixa_sessoes(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN ('SUPRIMENTO', 'SANGRIA')),
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  motivo TEXT NOT NULL CHECK (LENGTH(TRIM(motivo)) >= 3),
  idempotency_key TEXT NOT NULL,
  autorizado_por UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_caixa_sessao_mov_idemp UNIQUE (sessao_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_caixa_sessao_mov_sessao ON public.caixa_sessao_movimentacoes(sessao_id);

-- ------------------------------------------------------------------------------
-- 3. TABELA DE VÍNCULO ENTRE PAGAMENTOS DE PEDIDOS E SESSÃO DE CAIXA
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.caixa_sessao_pagamentos (
  id BIGSERIAL PRIMARY KEY,
  sessao_id BIGINT NOT NULL REFERENCES public.caixa_sessoes(id) ON DELETE RESTRICT,
  pagamento_id BIGINT NOT NULL REFERENCES public.pedido_pagamentos(id) ON DELETE RESTRICT,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  metodo TEXT NOT NULL,
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_caixa_sessao_pagamento UNIQUE (pagamento_id)
);

CREATE INDEX IF NOT EXISTS idx_caixa_sessao_pag_sessao ON public.caixa_sessao_pagamentos(sessao_id);
CREATE INDEX IF NOT EXISTS idx_caixa_sessao_pag_pedido ON public.caixa_sessao_pagamentos(pedido_id);

-- ------------------------------------------------------------------------------
-- 4. TABELA DE AUDITORIAS DE SESSÃO (REVISÃO GERENCIAL POSTERIOR APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.caixa_sessao_auditorias (
  id BIGSERIAL PRIMARY KEY,
  sessao_id BIGINT NOT NULL REFERENCES public.caixa_sessoes(id) ON DELETE RESTRICT,
  auditor_auth_id UUID NOT NULL REFERENCES auth.users(id),
  parecer TEXT NOT NULL CHECK (parecer IN ('APROVADO', 'RESSALVA', 'REJEITADO')),
  observacoes TEXT NOT NULL CHECK (LENGTH(TRIM(observacoes)) >= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_caixa_sessao_aud_sessao ON public.caixa_sessao_auditorias(sessao_id);

-- ------------------------------------------------------------------------------
-- 5. TRIGGERS DE SEGURANÇA E IMUTABILIDADE (SQLSTATE 42501)
-- ------------------------------------------------------------------------------

-- R11: Bloqueio de mutação em sessão fechada e bloqueio de exclusão
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_sessao_fechada()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exclusão de sessões de caixa é proibida por governança contábil.'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'FECHADA' THEN
    RAISE EXCEPTION 'Sessão de caixa fechada é imutável. Ajustes devem ser registrados em caixa_sessao_auditorias.'
      USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_valida_sessao_imutavel ON public.caixa_sessoes;
CREATE TRIGGER trg_valida_sessao_imutavel
BEFORE UPDATE OR DELETE ON public.caixa_sessoes
FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_sessao_fechada();

-- R12, R13, R14: Triggers estritamente append-only para livros auxiliares de caixa
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_livro_caixa()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Operação % proibida. Os registros de movimentações, pagamentos e auditorias de caixa são estritamente append-only.', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_caixa_movimentacoes_append_only ON public.caixa_sessao_movimentacoes;
CREATE TRIGGER trg_caixa_movimentacoes_append_only
BEFORE UPDATE OR DELETE ON public.caixa_sessao_movimentacoes
FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_livro_caixa();

DROP TRIGGER IF EXISTS trg_caixa_pagamentos_append_only ON public.caixa_sessao_pagamentos;
CREATE TRIGGER trg_caixa_pagamentos_append_only
BEFORE UPDATE OR DELETE ON public.caixa_sessao_pagamentos
FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_livro_caixa();

DROP TRIGGER IF EXISTS trg_caixa_auditorias_append_only ON public.caixa_sessao_auditorias;
CREATE TRIGGER trg_caixa_auditorias_append_only
BEFORE UPDATE OR DELETE ON public.caixa_sessao_auditorias
FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_livro_caixa();

-- ------------------------------------------------------------------------------
-- 6. HABILITAÇÃO DE ROW LEVEL SECURITY (RLS)
-- ------------------------------------------------------------------------------
ALTER TABLE public.caixa_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caixa_sessao_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caixa_sessao_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caixa_sessao_auditorias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "caixa_sessoes_select" ON public.caixa_sessoes;
CREATE POLICY "caixa_sessoes_select" ON public.caixa_sessoes
FOR SELECT TO authenticated
USING (
  public.is_admin() OR
  operador_auth_id = auth.uid()
);

DROP POLICY IF EXISTS "caixa_sessoes_service_all" ON public.caixa_sessoes;
CREATE POLICY "caixa_sessoes_service_all" ON public.caixa_sessoes
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "caixa_movimentacoes_select" ON public.caixa_sessao_movimentacoes;
CREATE POLICY "caixa_movimentacoes_select" ON public.caixa_sessao_movimentacoes
FOR SELECT TO authenticated
USING (
  public.is_admin() OR
  EXISTS (
    SELECT 1 FROM public.caixa_sessoes s
    WHERE s.id = sessao_id AND s.operador_auth_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "caixa_movimentacoes_service_all" ON public.caixa_sessao_movimentacoes;
CREATE POLICY "caixa_movimentacoes_service_all" ON public.caixa_sessao_movimentacoes
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "caixa_pagamentos_select" ON public.caixa_sessao_pagamentos;
CREATE POLICY "caixa_pagamentos_select" ON public.caixa_sessao_pagamentos
FOR SELECT TO authenticated
USING (
  public.is_admin() OR
  EXISTS (
    SELECT 1 FROM public.caixa_sessoes s
    WHERE s.id = sessao_id AND s.operador_auth_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "caixa_pagamentos_service_all" ON public.caixa_sessao_pagamentos;
CREATE POLICY "caixa_pagamentos_service_all" ON public.caixa_sessao_pagamentos
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "caixa_auditorias_select" ON public.caixa_sessao_auditorias;
CREATE POLICY "caixa_auditorias_select" ON public.caixa_sessao_auditorias
FOR SELECT TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "caixa_auditorias_service_all" ON public.caixa_sessao_auditorias;
CREATE POLICY "caixa_auditorias_service_all" ON public.caixa_sessao_auditorias
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 7. RPC: ABRIR SESSÃO DE CAIXA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.abrir_sessao_caixa(
  p_fundo_troco NUMERIC,
  p_terminal TEXT DEFAULT 'PRINCIPAL',
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_colab_id BIGINT;
  v_term TEXT;
  v_sessao_id BIGINT;
  v_sessao RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem abrir o caixa.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_fundo_troco IS NULL OR p_fundo_troco < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Fundo de troco inicial deve ser maior ou igual a zero.', 'code', 'INVALID_INITIAL_CASH');
  END IF;

  v_term := upper(btrim(COALESCE(p_terminal, 'PRINCIPAL')));
  IF v_term = '' THEN
    v_term := 'PRINCIPAL';
  END IF;

  -- R1: Valida se operador já possui sessão aberta
  SELECT id INTO v_sessao_id
  FROM public.caixa_sessoes
  WHERE operador_auth_id = v_caller_id
    AND status = 'ABERTA';

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operador já possui uma sessão de caixa aberta (# ' || v_sessao_id || '). Feche-a antes de abrir uma nova.',
      'code', 'OPEN_SESSION_EXISTS_OPERATOR',
      'sessao_id', v_sessao_id
    );
  END IF;

  -- R2: Valida se terminal já possui sessão aberta
  SELECT id INTO v_sessao_id
  FROM public.caixa_sessoes
  WHERE terminal_id = v_term
    AND status = 'ABERTA';

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'O terminal ' || v_term || ' já possui uma sessão aberta (# ' || v_sessao_id || ').',
      'code', 'OPEN_SESSION_EXISTS_TERMINAL',
      'sessao_id', v_sessao_id
    );
  END IF;

  -- Resolver vínculo com colaborador da Frente O se cadastrado
  SELECT id INTO v_colab_id
  FROM public.colaboradores
  WHERE auth_user_id = v_caller_id
    AND ativo = true
  LIMIT 1;

  INSERT INTO public.caixa_sessoes (
    operador_auth_id,
    colaborador_id,
    terminal_id,
    status,
    aberta_em,
    fundo_troco_inicial,
    observacoes_abertura
  ) VALUES (
    v_caller_id,
    v_colab_id,
    v_term,
    'ABERTA',
    NOW(),
    ROUND(p_fundo_troco, 2),
    p_observacoes
  ) RETURNING * INTO v_sessao;

  RETURN jsonb_build_object(
    'success', true,
    'sessao_id', v_sessao.id,
    'terminal_id', v_sessao.terminal_id,
    'status', v_sessao.status,
    'aberta_em', v_sessao.aberta_em,
    'fundo_troco_inicial', v_sessao.fundo_troco_inicial
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 8. RPC: REGISTRAR MOVIMENTAÇÃO DE CAIXA (SUPRIMENTO / SANGRIA)
-- ------------------------------------------------------------------------------
-- R3:  Neutro no DRE/Tesouraria
-- R4:  Sangria não supera dinheiro físico disponível
-- R12: Idempotência com p_idempotency_key e append-only
CREATE OR REPLACE FUNCTION public.registrar_movimentacao_caixa(
  p_tipo TEXT,
  p_valor NUMERIC,
  p_motivo TEXT,
  p_idempotency_key TEXT,
  p_sessao_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_sessao RECORD;
  v_sessao_id BIGINT;
  v_tipo TEXT;
  v_motivo TEXT;
  v_mov_existente RECORD;
  v_dinheiro_recebido NUMERIC(10,2) := 0.00;
  v_suprimentos NUMERIC(10,2) := 0.00;
  v_sangrias NUMERIC(10,2) := 0.00;
  v_devolucoes NUMERIC(10,2) := 0.00;
  v_saldo_fisico_disponivel NUMERIC(10,2) := 0.00;
  v_mov_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem movimentar o caixa.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Chave de idempotência obrigatória para movimentação de caixa.', 'code', 'IDEMPOTENCY_KEY_REQUIRED');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Valor da movimentação deve ser maior que zero.', 'code', 'INVALID_AMOUNT');
  END IF;

  v_tipo := upper(btrim(COALESCE(p_tipo, '')));
  IF v_tipo NOT IN ('SUPRIMENTO', 'SANGRIA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de movimentação inválido. Use SUPRIMENTO ou SANGRIA.', 'code', 'INVALID_MOVEMENT_TYPE');
  END IF;

  v_motivo := btrim(COALESCE(p_motivo, ''));
  IF LENGTH(v_motivo) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Motivo da movimentação deve ter no mínimo 3 caracteres.', 'code', 'REASON_REQUIRED');
  END IF;

  -- Resolver sessão
  IF p_sessao_id IS NOT NULL THEN
    v_sessao_id := p_sessao_id;
  ELSE
    SELECT id INTO v_sessao_id
    FROM public.caixa_sessoes
    WHERE operador_auth_id = v_caller_id
      AND status = 'ABERTA';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Nenhuma sessão de caixa aberta para o operador.', 'code', 'CASH_SESSION_REQUIRED');
    END IF;
  END IF;

  -- Trava da sessão
  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = v_sessao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  IF v_sessao.status <> 'ABERTA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'A sessão de caixa # ' || v_sessao_id || ' já está fechada.', 'code', 'SESSION_CLOSED');
  END IF;

  -- R12: Verificação de Idempotência
  SELECT id, tipo, valor, motivo, created_at INTO v_mov_existente
  FROM public.caixa_sessao_movimentacoes
  WHERE sessao_id = v_sessao_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'movimentacao_id', v_mov_existente.id,
      'sessao_id', v_sessao_id,
      'tipo', v_mov_existente.tipo,
      'valor', v_mov_existente.valor,
      'motivo', v_mov_existente.motivo,
      'idempotente', true,
      'created_at', v_mov_existente.created_at
    );
  END IF;

  -- R4: Validação de Saldo Físico para SANGRIA
  IF v_tipo = 'SANGRIA' THEN
    -- Total dinheiro recebido canônico na sessão
    SELECT COALESCE(SUM(valor), 0.00) INTO v_dinheiro_recebido
    FROM public.caixa_sessao_pagamentos
    WHERE sessao_id = v_sessao_id
      AND metodo = 'dinheiro';

    -- Suprimentos anteriores
    SELECT COALESCE(SUM(valor), 0.00) INTO v_suprimentos
    FROM public.caixa_sessao_movimentacoes
    WHERE sessao_id = v_sessao_id
      AND tipo = 'SUPRIMENTO';

    -- Sangrias anteriores
    SELECT COALESCE(SUM(valor), 0.00) INTO v_sangrias
    FROM public.caixa_sessao_movimentacoes
    WHERE sessao_id = v_sessao_id
      AND tipo = 'SANGRIA';

    -- Devoluções em dinheiro canônicas vinculadas à sessão
    SELECT COALESCE(SUM(pp.valor), 0.00) INTO v_devolucoes
    FROM public.caixa_sessao_pagamentos csp
    JOIN public.pedido_pagamentos pp ON pp.id = csp.pagamento_id
    WHERE csp.sessao_id = v_sessao_id
      AND csp.metodo = 'dinheiro'
      AND pp.status = 'estornado';

    v_saldo_fisico_disponivel := ROUND(v_sessao.fundo_troco_inicial + v_dinheiro_recebido + v_suprimentos - v_sangrias - v_devolucoes, 2);

    IF p_valor > v_saldo_fisico_disponivel THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Valor da sangria (R$ ' || p_valor || ') excede o dinheiro físico disponível na gaveta (R$ ' || v_saldo_fisico_disponivel || ').',
        'code', 'INSUFFICIENT_CASH_IN_DRAWER',
        'saldo_disponivel', v_saldo_fisico_disponivel
      );
    END IF;
  END IF;

  INSERT INTO public.caixa_sessao_movimentacoes (
    sessao_id,
    tipo,
    valor,
    motivo,
    idempotency_key,
    autorizado_por,
    created_at
  ) VALUES (
    v_sessao_id,
    v_tipo,
    ROUND(p_valor, 2),
    v_motivo,
    p_idempotency_key,
    v_caller_id,
    NOW()
  ) RETURNING id INTO v_mov_id;

  RETURN jsonb_build_object(
    'success', true,
    'movimentacao_id', v_mov_id,
    'sessao_id', v_sessao_id,
    'tipo', v_tipo,
    'valor', ROUND(p_valor, 2),
    'motivo', v_motivo,
    'idempotente', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 9. RPC: CONSULTAR SESSÃO DE CAIXA ATUAL (OPERADOR COM FECHAMENTO CEGO)
-- ------------------------------------------------------------------------------
-- R8: Projeção rigorosamente cega no servidor. Omite saldo_esperado_dinheiro,
--     total_dinheiro_esperado e diferenca enquanto status for ABERTA.
CREATE OR REPLACE FUNCTION public.consultar_sessao_caixa_atual()
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_sessao RECORD;
  v_qtd_vendas INT := 0;
  v_qtd_movimentacoes INT := 0;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE operador_auth_id = v_caller_id
    AND status = 'ABERTA'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'sessao_aberta', false
    );
  END IF;

  SELECT COUNT(*) INTO v_qtd_vendas
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao.id;

  SELECT COUNT(*) INTO v_qtd_movimentacoes
  FROM public.caixa_sessao_movimentacoes
  WHERE sessao_id = v_sessao.id;

  -- Retorno estritamente cego: dados operacionais sem revelar o total em dinheiro da gaveta
  RETURN jsonb_build_object(
    'success', true,
    'sessao_aberta', true,
    'sessao', jsonb_build_object(
      'id', v_sessao.id,
      'terminal_id', v_sessao.terminal_id,
      'status', v_sessao.status,
      'aberta_em', v_sessao.aberta_em,
      'fundo_troco_inicial', v_sessao.fundo_troco_inicial,
      'observacoes_abertura', v_sessao.observacoes_abertura,
      'total_transacoes', v_qtd_vendas,
      'total_movimentacoes', v_qtd_movimentacoes
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 10. RPC: OBTER RESUMO COMPLETO DE SESSÃO DE CAIXA (ADMINISTRADOR / GERENTE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_resumo_sessao_caixa_admin(
  p_sessao_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_sessao RECORD;
  v_tot_dinheiro NUMERIC(10,2) := 0.00;
  v_tot_pix NUMERIC(10,2) := 0.00;
  v_tot_cartao NUMERIC(10,2) := 0.00;
  v_tot_outros NUMERIC(10,2) := 0.00;
  v_tot_suprimentos NUMERIC(10,2) := 0.00;
  v_tot_sangrias NUMERIC(10,2) := 0.00;
  v_tot_devolucoes NUMERIC(10,2) := 0.00;
  v_saldo_esperado NUMERIC(10,2) := 0.00;
  v_movimentacoes JSONB;
  v_pagamentos JSONB;
  v_auditorias JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Visão detalhada de auditoria restrita a administradores.', 'code', 'PERMISSION_DENIED');
  END IF;

  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = p_sessao_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  -- Se aberta, calcula em tempo real; se fechada, projeta snapshots
  IF v_sessao.status = 'FECHADA' THEN
    v_tot_dinheiro := COALESCE(v_sessao.total_dinheiro_snapshot, 0.00);
    v_tot_pix := COALESCE(v_sessao.total_pix_snapshot, 0.00);
    v_tot_cartao := COALESCE(v_sessao.total_cartao_snapshot, 0.00);
    v_tot_outros := COALESCE(v_sessao.total_outros_snapshot, 0.00);
    v_tot_suprimentos := COALESCE(v_sessao.total_suprimentos_snapshot, 0.00);
    v_tot_sangrias := COALESCE(v_sessao.total_sangrias_snapshot, 0.00);
    v_tot_devolucoes := COALESCE(v_sessao.total_devolucoes_dinheiro_snapshot, 0.00);
    v_saldo_esperado := COALESCE(v_sessao.saldo_esperado_dinheiro_snapshot, 0.00);
  ELSE
    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_dinheiro
    FROM public.caixa_sessao_pagamentos WHERE sessao_id = v_sessao.id AND metodo = 'dinheiro';

    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_pix
    FROM public.caixa_sessao_pagamentos WHERE sessao_id = v_sessao.id AND metodo = 'pix';

    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_cartao
    FROM public.caixa_sessao_pagamentos WHERE sessao_id = v_sessao.id AND metodo IN ('cartao', 'credito', 'debito');

    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_outros
    FROM public.caixa_sessao_pagamentos WHERE sessao_id = v_sessao.id AND metodo NOT IN ('dinheiro', 'pix', 'cartao', 'credito', 'debito');

    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_suprimentos
    FROM public.caixa_sessao_movimentacoes WHERE sessao_id = v_sessao.id AND tipo = 'SUPRIMENTO';

    SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_sangrias
    FROM public.caixa_sessao_movimentacoes WHERE sessao_id = v_sessao.id AND tipo = 'SANGRIA';

    SELECT COALESCE(SUM(pp.valor), 0.00) INTO v_tot_devolucoes
    FROM public.caixa_sessao_pagamentos csp
    JOIN public.pedido_pagamentos pp ON pp.id = csp.pagamento_id
    WHERE csp.sessao_id = v_sessao.id AND csp.metodo = 'dinheiro' AND pp.status = 'estornado';

    v_saldo_esperado := ROUND(v_sessao.fundo_troco_inicial + v_tot_dinheiro + v_tot_suprimentos - v_tot_sangrias - v_tot_devolucoes, 2);
  END IF;

  SELECT COALESCE(jsonb_agg(m ORDER BY m.created_at ASC), '[]'::jsonb)
  INTO v_movimentacoes
  FROM (
    SELECT id, tipo, valor, motivo, idempotency_key, created_at
    FROM public.caixa_sessao_movimentacoes
    WHERE sessao_id = v_sessao.id
  ) m;

  SELECT COALESCE(jsonb_agg(p ORDER BY p.created_at ASC), '[]'::jsonb)
  INTO v_pagamentos
  FROM (
    SELECT id, pagamento_id, pedido_id, metodo, valor, created_at
    FROM public.caixa_sessao_pagamentos
    WHERE sessao_id = v_sessao.id
  ) p;

  SELECT COALESCE(jsonb_agg(a ORDER BY a.created_at ASC), '[]'::jsonb)
  INTO v_auditorias
  FROM (
    SELECT id, auditor_auth_id, parecer, observacoes, created_at
    FROM public.caixa_sessao_auditorias
    WHERE sessao_id = v_sessao.id
  ) a;

  RETURN jsonb_build_object(
    'success', true,
    'sessao', jsonb_build_object(
      'id', v_sessao.id,
      'operador_auth_id', v_sessao.operador_auth_id,
      'colaborador_id', v_sessao.colaborador_id,
      'terminal_id', v_sessao.terminal_id,
      'status', v_sessao.status,
      'aberta_em', v_sessao.aberta_em,
      'fechada_em', v_sessao.fechada_em,
      'fundo_troco_inicial', v_sessao.fundo_troco_inicial,
      'total_dinheiro', v_tot_dinheiro,
      'total_pix', v_tot_pix,
      'total_cartao', v_tot_cartao,
      'total_outros', v_tot_outros,
      'total_suprimentos', v_tot_suprimentos,
      'total_sangrias', v_tot_sangrias,
      'total_devolucoes_dinheiro', v_tot_devolucoes,
      'saldo_esperado_dinheiro', v_saldo_esperado,
      'valor_contado_dinheiro', v_sessao.valor_contado_dinheiro,
      'diferenca_caixa', v_sessao.diferenca_caixa,
      'justificativa_diferenca', v_sessao.justificativa_diferenca,
      'observacoes_abertura', v_sessao.observacoes_abertura,
      'observacoes_fechamento', v_sessao.observacoes_fechamento
    ),
    'movimentacoes', v_movimentacoes,
    'pagamentos', v_pagamentos,
    'auditorias', v_auditorias
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 11. RPC: FECHAR SESSÃO DE CAIXA (FECHAMENTO CEGO NO SERVIDOR COM IDEMPOTÊNCIA)
-- ------------------------------------------------------------------------------
-- R9:  Divergência exige justificativa
-- R10: Grava snapshots matematicamente corretos
-- R11: Fechamento é idempotente e imutável
CREATE OR REPLACE FUNCTION public.fechar_sessao_caixa(
  p_valor_contado_dinheiro NUMERIC,
  p_justificativa TEXT DEFAULT NULL,
  p_observacoes TEXT DEFAULT NULL,
  p_sessao_id BIGINT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_sessao_id BIGINT;
  v_sessao RECORD;
  v_tot_dinheiro NUMERIC(10,2) := 0.00;
  v_tot_pix NUMERIC(10,2) := 0.00;
  v_tot_cartao NUMERIC(10,2) := 0.00;
  v_tot_outros NUMERIC(10,2) := 0.00;
  v_tot_suprimentos NUMERIC(10,2) := 0.00;
  v_tot_sangrias NUMERIC(10,2) := 0.00;
  v_tot_devolucoes NUMERIC(10,2) := 0.00;
  v_saldo_esperado NUMERIC(10,2) := 0.00;
  v_diferenca NUMERIC(10,2) := 0.00;
  v_justificativa TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem fechar o caixa.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_valor_contado_dinheiro IS NULL OR p_valor_contado_dinheiro < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Valor contado em dinheiro deve ser maior ou igual a zero.', 'code', 'INVALID_COUNTED_CASH');
  END IF;

  -- Resolver sessão
  IF p_sessao_id IS NOT NULL THEN
    v_sessao_id := p_sessao_id;
  ELSE
    SELECT id INTO v_sessao_id
    FROM public.caixa_sessoes
    WHERE operador_auth_id = v_caller_id
      AND status = 'ABERTA';

    IF NOT FOUND THEN
      -- Verifica se a última sessão já foi fechada recentemente (para retry idempotente)
      SELECT id INTO v_sessao_id
      FROM public.caixa_sessoes
      WHERE operador_auth_id = v_caller_id
      ORDER BY id DESC
      LIMIT 1;

      IF FOUND THEN
        SELECT * INTO v_sessao FROM public.caixa_sessoes WHERE id = v_sessao_id;
        IF v_sessao.status = 'FECHADA' AND v_sessao.valor_contado_dinheiro = ROUND(p_valor_contado_dinheiro, 2) THEN
          RETURN jsonb_build_object(
            'success', true,
            'sessao_id', v_sessao.id,
            'status', 'FECHADA',
            'saldo_esperado_dinheiro', v_sessao.saldo_esperado_dinheiro_snapshot,
            'valor_contado_dinheiro', v_sessao.valor_contado_dinheiro,
            'diferenca_caixa', v_sessao.diferenca_caixa,
            'ja_fechada', true
          );
        END IF;
      END IF;

      RETURN jsonb_build_object('success', false, 'error', 'Nenhuma sessão de caixa aberta para fechamento.', 'code', 'CASH_SESSION_REQUIRED');
    END IF;
  END IF;

  -- Trava da linha para exclusão mútua concorrente
  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = v_sessao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  -- R11: Idempotência de Fechamento
  IF v_sessao.status = 'FECHADA' THEN
    IF v_sessao.valor_contado_dinheiro = ROUND(p_valor_contado_dinheiro, 2) THEN
      RETURN jsonb_build_object(
        'success', true,
        'sessao_id', v_sessao.id,
        'status', 'FECHADA',
        'saldo_esperado_dinheiro', v_sessao.saldo_esperado_dinheiro_snapshot,
        'valor_contado_dinheiro', v_sessao.valor_contado_dinheiro,
        'diferenca_caixa', v_sessao.diferenca_caixa,
        'ja_fechada', true
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'error', 'A sessão de caixa # ' || v_sessao_id || ' já se encontra encerrada com valor contado diferente.',
        'code', 'SESSION_ALREADY_CLOSED'
      );
    END IF;
  END IF;

  -- 1. Calcular totais das fontes canônicas
  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_dinheiro
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao_id AND metodo = 'dinheiro';

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_pix
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao_id AND metodo = 'pix';

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_cartao
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao_id AND metodo IN ('cartao', 'credito', 'debito');

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_outros
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao_id AND metodo NOT IN ('dinheiro', 'pix', 'cartao', 'credito', 'debito');

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_suprimentos
  FROM public.caixa_sessao_movimentacoes
  WHERE sessao_id = v_sessao_id AND tipo = 'SUPRIMENTO';

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_sangrias
  FROM public.caixa_sessao_movimentacoes
  WHERE sessao_id = v_sessao_id AND tipo = 'SANGRIA';

  -- Devoluções canônicas em dinheiro vinculadas à sessão
  SELECT COALESCE(SUM(pp.valor), 0.00) INTO v_tot_devolucoes
  FROM public.caixa_sessao_pagamentos csp
  JOIN public.pedido_pagamentos pp ON pp.id = csp.pagamento_id
  WHERE csp.sessao_id = v_sessao_id
    AND csp.metodo = 'dinheiro'
    AND pp.status = 'estornado';

  -- 2. Equação da Gaveta Física
  v_saldo_esperado := ROUND(v_sessao.fundo_troco_inicial + v_tot_dinheiro + v_tot_suprimentos - v_tot_sangrias - v_tot_devolucoes, 2);
  v_diferenca := ROUND(p_valor_contado_dinheiro - v_saldo_esperado, 2);

  -- R9: Validação de Divergência (Quebra ou Sobra)
  v_justificativa := btrim(COALESCE(p_justificativa, ''));
  IF v_diferenca <> 0.00 THEN
    IF LENGTH(v_justificativa) < 5 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Divergência identificada entre o valor contado e o saldo esperado. Justificativa com no mínimo 5 caracteres é obrigatória.',
        'code', 'DIVERGENCE_JUSTIFICATION_REQUIRED',
        'diferenca', v_diferenca
      );
    END IF;
  END IF;

  -- 3. Atualizar e congelar snapshots definitivos
  UPDATE public.caixa_sessoes
  SET status = 'FECHADA',
      fechada_em = NOW(),
      fechada_por = v_caller_id,
      observacoes_fechamento = p_observacoes,
      total_dinheiro_snapshot = v_tot_dinheiro,
      total_pix_snapshot = v_tot_pix,
      total_cartao_snapshot = v_tot_cartao,
      total_outros_snapshot = v_tot_outros,
      total_suprimentos_snapshot = v_tot_suprimentos,
      total_sangrias_snapshot = v_tot_sangrias,
      total_devolucoes_dinheiro_snapshot = v_tot_devolucoes,
      saldo_esperado_dinheiro_snapshot = v_saldo_esperado,
      valor_contado_dinheiro = ROUND(p_valor_contado_dinheiro, 2),
      diferenca_caixa = v_diferenca,
      justificativa_diferenca = CASE WHEN v_diferenca <> 0.00 THEN v_justificativa ELSE NULL END,
      updated_at = NOW()
  WHERE id = v_sessao_id;

  RETURN jsonb_build_object(
    'success', true,
    'sessao_id', v_sessao_id,
    'status', 'FECHADA',
    'saldo_esperado_dinheiro', v_saldo_esperado,
    'valor_contado_dinheiro', ROUND(p_valor_contado_dinheiro, 2),
    'diferenca_caixa', v_diferenca,
    'total_dinheiro', v_tot_dinheiro,
    'total_pix', v_tot_pix,
    'total_cartao', v_tot_cartao,
    'total_outros', v_tot_outros,
    'total_suprimentos', v_tot_suprimentos,
    'total_sangrias', v_tot_sangrias,
    'ja_fechada', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 12. RPC: AUDITAR SESSÃO DE CAIXA (ADMINISTRADOR COM AUDITORIA APPEND-ONLY)
-- ------------------------------------------------------------------------------
-- R14: Não altera os snapshots originais da sessão de caixa
CREATE OR REPLACE FUNCTION public.auditar_sessao_caixa_admin(
  p_sessao_id BIGINT,
  p_parecer TEXT,
  p_observacoes TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_sessao RECORD;
  v_parecer TEXT;
  v_obs TEXT;
  v_aud_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas administradores podem registrar auditorias de caixa.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_parecer := upper(btrim(COALESCE(p_parecer, '')));
  IF v_parecer NOT IN ('APROVADO', 'RESSALVA', 'REJEITADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Parecer inválido. Opções permitidas: APROVADO, RESSALVA, REJEITADO.', 'code', 'INVALID_AUDIT_OPINION');
  END IF;

  v_obs := btrim(COALESCE(p_observacoes, ''));
  IF LENGTH(v_obs) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Observações da auditoria devem ter no mínimo 5 caracteres.', 'code', 'OBSERVATIONS_REQUIRED');
  END IF;

  SELECT id, status INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = p_sessao_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  INSERT INTO public.caixa_sessao_auditorias (
    sessao_id,
    auditor_auth_id,
    parecer,
    observacoes,
    created_at
  ) VALUES (
    p_sessao_id,
    v_caller_id,
    v_parecer,
    v_obs,
    NOW()
  ) RETURNING id INTO v_aud_id;

  RETURN jsonb_build_object(
    'success', true,
    'auditoria_id', v_aud_id,
    'sessao_id', p_sessao_id,
    'parecer', v_parecer,
    'observacoes', v_obs,
    'created_at', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 13. RPC: LISTAR SESSÕES DE CAIXA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_sessoes_caixa_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_is_admin BOOLEAN;
  v_st TEXT;
  v_total INT;
  v_sessoes JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_is_admin := public.is_admin();
  v_st := upper(btrim(COALESCE(p_status, '')));

  SELECT COUNT(*) INTO v_total
  FROM public.caixa_sessoes s
  WHERE (v_is_admin OR s.operador_auth_id = v_caller_id)
    AND (v_st = '' OR s.status = v_st)
    AND (p_data_inicio IS NULL OR s.aberta_em::date >= p_data_inicio)
    AND (p_data_fim IS NULL OR s.aberta_em::date <= p_data_fim);

  SELECT COALESCE(jsonb_agg(r ORDER BY r.aberta_em DESC), '[]'::jsonb)
  INTO v_sessoes
  FROM (
    SELECT
      s.id,
      s.operador_auth_id,
      p.nome AS operador_nome,
      c.nome AS colaborador_nome,
      s.terminal_id,
      s.status,
      s.aberta_em,
      s.fechada_em,
      s.fundo_troco_inicial,
      s.total_dinheiro_snapshot,
      s.total_pix_snapshot,
      s.total_cartao_snapshot,
      s.total_outros_snapshot,
      s.total_suprimentos_snapshot,
      s.total_sangrias_snapshot,
      s.saldo_esperado_dinheiro_snapshot,
      s.valor_contado_dinheiro,
      s.diferenca_caixa,
      s.justificativa_diferenca,
      (SELECT COUNT(*) FROM public.caixa_sessao_pagamentos csp WHERE csp.sessao_id = s.id) AS total_pagamentos,
      (SELECT COUNT(*) FROM public.caixa_sessao_movimentacoes csm WHERE csm.sessao_id = s.id) AS total_movimentacoes,
      (SELECT COUNT(*) FROM public.caixa_sessao_auditorias csa WHERE csa.sessao_id = s.id) AS total_auditorias
    FROM public.caixa_sessoes s
    LEFT JOIN public.profiles p ON p.id = s.operador_auth_id
    LEFT JOIN public.colaboradores c ON c.id = s.colaborador_id
    WHERE (v_is_admin OR s.operador_auth_id = v_caller_id)
      AND (v_st = '' OR s.status = v_st)
      AND (p_data_inicio IS NULL OR s.aberta_em::date >= p_data_inicio)
      AND (p_data_fim IS NULL OR s.aberta_em::date <= p_data_fim)
    ORDER BY s.aberta_em DESC
    LIMIT GREATEST(1, COALESCE(p_limite, 50))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'total', v_total,
    'sessoes', v_sessoes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 14. EVOLUÇÃO FORWARD-ONLY DE FINALIZAR_VENDA_PDV (INTEGRAÇÃO COM FRENTE R)
-- ------------------------------------------------------------------------------
-- R5:  PDV exige sessão de caixa aberta para o operador (CASH_SESSION_REQUIRED)
-- R6:  Pagamento PDV vincula exatamente uma sessão de caixa
-- R7:  Somente dinheiro compõe o saldo físico da gaveta
-- R16: Não-regressão da Frente Q (catálogo, FEFO, lock FOR UPDATE, rastreabilidade)
CREATE OR REPLACE FUNCTION public.finalizar_venda_pdv(
  p_itens JSONB,
  p_cliente_id_rel BIGINT DEFAULT NULL,
  p_forma_pagamento TEXT DEFAULT 'dinheiro',
  p_desconto NUMERIC DEFAULT 0.00,
  p_motivo_desconto TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL,
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_is_admin BOOLEAN;
  v_user_nome TEXT;
  v_data_op DATE;
  v_pedido_id BIGINT;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_desconto_aplicado NUMERIC(10,2) := 0.00;
  v_total_liquido NUMERIC(10,2) := 0.00;
  v_cli_nome TEXT := NULL;
  v_cli_email TEXT := NULL;
  v_cli_tel TEXT := NULL;
  v_item RECORD;
  v_prod RECORD;
  v_ped_item_id BIGINT;
  v_nec_qtd NUMERIC(10,2);
  v_restante NUMERIC(10,2);
  v_lote_pt RECORD;
  v_consumir NUMERIC(10,2);
  v_pag_res JSON;
  v_pag_id BIGINT;
  v_metodo_norm TEXT;
  v_consumos_retorno JSONB := '[]'::jsonb;
  v_ped_existente RECORD;
  v_sessao_id BIGINT;
  v_cont_sessoes INT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem operar o PDV.', 'code', 'PERMISSION_DENIED');
  END IF;

  -- R5: Exige exatamente uma sessão de caixa aberta para o operador
  SELECT COUNT(*), MAX(id) INTO v_cont_sessoes, v_sessao_id
  FROM public.caixa_sessoes
  WHERE operador_auth_id = v_caller_id
    AND status = 'ABERTA';

  IF v_cont_sessoes = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Nenhuma sessão de caixa aberta para este operador. Abra o caixa antes de realizar vendas no PDV.',
      'code', 'CASH_SESSION_REQUIRED'
    );
  ELSIF v_cont_sessoes > 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Inconsistência de sessões: mais de uma sessão aberta para o operador.',
      'code', 'CASH_SESSION_INCONSISTENT'
    );
  END IF;

  v_is_admin := public.is_admin();
  v_data_op := (NOW() AT TIME ZONE 'America/Fortaleza')::date;

  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Carrinho de PDV vazio.', 'code', 'EMPTY_CART');
  END IF;

  -- Q8: Idempotência com p_chave_idempotencia
  IF p_chave_idempotencia IS NOT NULL AND btrim(p_chave_idempotencia) <> '' THEN
    SELECT id, total, status_operacional, status_comercial, status_financeiro
    INTO v_ped_existente
    FROM public.pedidos
    WHERE observacoes_internas LIKE '%pdv_idemp:' || p_chave_idempotencia || '%'
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'pedido_id', v_ped_existente.id,
        'numero', '#' || v_ped_existente.id::text,
        'total', v_ped_existente.total,
        'status_operacional', v_ped_existente.status_operacional,
        'status_comercial', v_ped_existente.status_comercial,
        'ja_processado', true
      );
    END IF;
  END IF;

  SELECT COALESCE(nome, 'Operador') INTO v_user_nome FROM public.profiles WHERE id = v_caller_id;

  -- Q13 & Q14: Validação do cliente
  IF p_cliente_id_rel IS NOT NULL THEN
    SELECT nome, email, telefone INTO v_cli_nome, v_cli_email, v_cli_tel
    FROM public.clientes
    WHERE id = p_cliente_id_rel;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Cliente informado não encontrado no cadastro.', 'code', 'CLIENT_NOT_FOUND');
    END IF;
  END IF;

  -- 1. Validação de Catálogo e Cálculo de Subtotal com Preço Canônico
  FOR v_item IN
    SELECT
      (elem->>'produto_id')::bigint AS produto_id,
      (elem->>'quantidade')::numeric AS quantidade
    FROM jsonb_array_elements(p_itens) elem
  LOOP
    IF v_item.quantidade IS NULL OR v_item.quantidade <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Quantidade inválida para o produto ID ' || v_item.produto_id, 'code', 'INVALID_QUANTITY');
    END IF;

    SELECT id, nome, preco, ativo, controlar_estoque INTO v_prod
    FROM public.produtos
    WHERE id = v_item.produto_id;

    IF NOT FOUND OR NOT v_prod.ativo THEN
      RETURN jsonb_build_object('success', false, 'error', 'Produto inativo ou não encontrado: ID ' || v_item.produto_id, 'code', 'PRODUCT_INACTIVE');
    END IF;

    v_subtotal := v_subtotal + ROUND(v_prod.preco * v_item.quantidade, 2);
  END LOOP;

  -- Q9: Governança de Desconto
  v_desconto_aplicado := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  IF v_desconto_aplicado > 0 THEN
    IF p_motivo_desconto IS NULL OR char_length(btrim(p_motivo_desconto)) < 3 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Justificativa obrigatória para aplicação de desconto no PDV.', 'code', 'DISCOUNT_REASON_REQUIRED');
    END IF;

    -- Operador não pode conceder mais de 10% de desconto sem autorização de admin
    IF NOT v_is_admin AND v_desconto_aplicado > (v_subtotal * 0.10) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Operador pode conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10) || ').', 'code', 'DISCOUNT_LIMIT_EXCEEDED');
    END IF;

    IF v_desconto_aplicado > v_subtotal THEN
      RETURN jsonb_build_object('success', false, 'error', 'Desconto não pode exceder o valor total dos produtos.', 'code', 'DISCOUNT_EXCEEDS_SUBTOTAL');
    END IF;
  END IF;

  v_total_liquido := v_subtotal - v_desconto_aplicado;

  -- 2. Alocação FEFO de cada item em produto_pronto_lotes com FOR UPDATE
  FOR v_item IN
    SELECT
      (elem->>'produto_id')::bigint AS produto_id,
      (elem->>'quantidade')::numeric AS quantidade
    FROM jsonb_array_elements(p_itens) elem
    ORDER BY (elem->>'produto_id')::bigint ASC
  LOOP
    v_nec_qtd := v_item.quantidade;

    -- Trava os lotes elegíveis do produto para garantir exclusão mútua concorrente
    PERFORM 1
    FROM public.produto_pronto_lotes l
    WHERE l.produto_id = v_item.produto_id
      AND l.quantidade_disponivel > 0
      AND l.bloqueado_qualidade = false
      AND l.data_validade >= v_data_op
    FOR UPDATE;

    -- Verifica disponibilidade total elegível (não vencido e não bloqueado)
    SELECT COALESCE(SUM(l.quantidade_disponivel), 0) INTO v_restante
    FROM public.produto_pronto_lotes l
    WHERE l.produto_id = v_item.produto_id
      AND l.quantidade_disponivel > 0
      AND l.bloqueado_qualidade = false
      AND l.data_validade >= v_data_op;

    IF v_restante < v_nec_qtd THEN
      SELECT nome INTO v_prod FROM public.produtos WHERE id = v_item.produto_id;
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Estoque de pronta entrega insuficiente para o produto: ' || COALESCE(v_prod.nome, 'ID ' || v_item.produto_id) || ' (solicitado: ' || v_nec_qtd || ', disponível: ' || v_restante || ').',
        'code', 'INSUFFICIENT_STOCK_PRODUTO_PRONTO'
      );
    END IF;
  END LOOP;

  -- 3. Criação do Pedido Canônico
  v_metodo_norm := CASE
    WHEN p_forma_pagamento ILIKE '%cartao%' THEN 'cartao'
    WHEN p_forma_pagamento ILIKE '%pix%' THEN 'pix'
    WHEN p_forma_pagamento ILIKE '%dinheiro%' THEN 'dinheiro'
    WHEN p_forma_pagamento ILIKE '%transfer%' THEN 'transferencia'
    ELSE 'outro'
  END;

  INSERT INTO public.pedidos (
    cliente_id_rel,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    hora_entrega,
    modalidade_entrega,
    endereco_entrega,
    canal,
    subtotal,
    desconto,
    total,
    saldo,
    valor_pago,
    status_comercial,
    status_operacional,
    status_financeiro,
    status,
    pagamento,
    itens,
    itens_json,
    observacoes_internas
  ) VALUES (
    p_cliente_id_rel,
    v_cli_nome,
    v_cli_email,
    v_cli_tel,
    v_data_op,
    v_data_op,
    (NOW() AT TIME ZONE 'America/Fortaleza')::time,
    'retirada',
    'Balcão Lunoca - Pronta Entrega',
    'balcao',
    v_subtotal,
    v_desconto_aplicado,
    v_total_liquido,
    v_total_liquido,
    0.00,
    'confirmado',
    'pronto',
    'nao_pago',
    'Confirmado',
    v_metodo_norm,
    p_itens::text,
    p_itens,
    CASE
      WHEN p_chave_idempotencia IS NOT NULL THEN 'Venda PDV balcão pdv_idemp:' || p_chave_idempotencia
      ELSE 'Venda PDV balcão'
    END
  ) RETURNING id INTO v_pedido_id;

  -- 4. Criação de pedido_itens e consumo FEFO de Produto Pronto
  FOR v_item IN
    SELECT
      (elem->>'produto_id')::bigint AS produto_id,
      (elem->>'quantidade')::numeric AS quantidade
    FROM jsonb_array_elements(p_itens) elem
  LOOP
    SELECT * INTO v_prod FROM public.produtos WHERE id = v_item.produto_id;

    INSERT INTO public.pedido_itens (
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      preco_base_snapshot,
      preco_unitario_snapshot,
      subtotal
    ) VALUES (
      v_pedido_id,
      v_item.produto_id,
      v_prod.nome,
      v_item.quantidade,
      v_prod.preco,
      v_prod.preco,
      ROUND(v_prod.preco * v_item.quantidade, 2)
    ) RETURNING id INTO v_ped_item_id;

    v_restante := v_item.quantidade;

    FOR v_lote_pt IN
      SELECT *
      FROM public.produto_pronto_lotes l
      WHERE l.produto_id = v_item.produto_id
        AND l.quantidade_disponivel > 0
        AND l.bloqueado_qualidade = false
        AND l.data_validade >= v_data_op
      ORDER BY l.data_validade ASC, l.id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_restante <= 0;

      v_consumir := LEAST(v_lote_pt.quantidade_disponivel, v_restante);

      UPDATE public.produto_pronto_lotes
      SET quantidade_disponivel = ROUND(quantidade_disponivel - v_consumir, 2),
          updated_at = NOW()
      WHERE id = v_lote_pt.id;

      INSERT INTO public.produto_pronto_movimentacoes (
        lote_id,
        produto_id,
        tipo_movimentacao,
        quantidade,
        direcao,
        quantidade_anterior,
        quantidade_posterior,
        justificativa,
        usuario_id,
        usuario_nome
      ) VALUES (
        v_lote_pt.id,
        v_item.produto_id,
        'VENDA_PDV',
        v_consumir,
        'SAIDA',
        v_lote_pt.quantidade_disponivel,
        ROUND(v_lote_pt.quantidade_disponivel - v_consumir, 2),
        'Venda PDV Balcão - Pedido #' || v_pedido_id,
        v_caller_id,
        COALESCE(v_user_nome, 'Operador')
      );

      INSERT INTO public.pedido_consumos_produto_pronto (
        pedido_id,
        pedido_item_id,
        produto_id,
        lote_id,
        quantidade,
        preco_unitario_venda,
        custo_unitario_snapshot
      ) VALUES (
        v_pedido_id,
        v_ped_item_id,
        v_item.produto_id,
        v_lote_pt.id,
        v_consumir,
        v_prod.preco,
        v_lote_pt.custo_unitario_producao
      );

      v_consumos_retorno := v_consumos_retorno || jsonb_build_array(jsonb_build_object(
        'produto_id', v_item.produto_id,
        'lote_id', v_lote_pt.id,
        'codigo_lote', v_lote_pt.codigo_lote,
        'quantidade', v_consumir
      ));

      v_restante := ROUND(v_restante - v_consumir, 2);
    END LOOP;

    IF v_restante > 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK_PRODUTO_PRONTO: Estoque esgotado durante processamento concorrente.'
        USING ERRCODE = '23514';
    END IF;

    IF v_prod.controlar_estoque THEN
      UPDATE public.produtos
      SET estoque_fisico = GREATEST(0, COALESCE(estoque_fisico, 0) - v_item.quantidade)
      WHERE id = v_item.produto_id;
    END IF;
  END LOOP;

  -- 5. Quitação Canônica via registrar_pagamento_pedido
  v_pag_res := public.registrar_pagamento_pedido(
    p_pedido_id => v_pedido_id,
    p_valor => v_total_liquido,
    p_metodo => v_metodo_norm,
    p_observacoes => 'Pagamento no check-out PDV (' || p_forma_pagamento || ')',
    p_comprovante_url => CASE WHEN p_chave_idempotencia IS NOT NULL THEN 'pdv_idemp:' || p_chave_idempotencia ELSE NULL END
  );

  IF COALESCE((v_pag_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FALHA_PAGAMENTO_PDV: %', (v_pag_res->>'error');
  END IF;

  v_pag_id := (v_pag_res->>'pagamento_id')::bigint;

  -- R6: Vincula pagamento à sessão de caixa ativa
  INSERT INTO public.caixa_sessao_pagamentos (
    sessao_id,
    pagamento_id,
    pedido_id,
    metodo,
    valor,
    created_at
  ) VALUES (
    v_sessao_id,
    v_pag_id,
    v_pedido_id,
    v_metodo_norm,
    v_total_liquido,
    NOW()
  );

  -- 6. Transição de Ciclo Canônico para Retirado e Concluído
  UPDATE public.pedidos
  SET status_operacional = 'retirado',
      status_comercial = 'concluido',
      status_financeiro = 'pago',
      saldo = 0.00,
      valor_pago = v_total_liquido,
      updated_at = NOW()
  WHERE id = v_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id,
    status_anterior,
    novo_status,
    tipo_status,
    observacoes,
    criado_por
  ) VALUES (
    v_pedido_id,
    'novo',
    'retirado',
    'operacional',
    'Retirada imediata de pronta entrega no PDV',
    v_caller_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'numero', '#' || v_pedido_id::text,
    'total', v_total_liquido,
    'subtotal', v_subtotal,
    'desconto', v_desconto_aplicado,
    'forma_pagamento', v_metodo_norm,
    'sessao_caixa_id', v_sessao_id,
    'status_operacional', 'retirado',
    'status_comercial', 'concluido',
    'status_financeiro', 'pago',
    'consumos_lote', v_consumos_retorno
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 15. GRANTS FAIL-CLOSED DE SEGURANÇA
-- ------------------------------------------------------------------------------
REVOKE ALL ON public.caixa_sessoes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.caixa_sessoes TO authenticated, service_role;

REVOKE ALL ON public.caixa_sessao_movimentacoes FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.caixa_sessao_movimentacoes TO authenticated, service_role;

REVOKE ALL ON public.caixa_sessao_pagamentos FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.caixa_sessao_pagamentos TO authenticated, service_role;

REVOKE ALL ON public.caixa_sessao_auditorias FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.caixa_sessao_auditorias TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.abrir_sessao_caixa(NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abrir_sessao_caixa(NUMERIC, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.registrar_movimentacao_caixa(TEXT, NUMERIC, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_movimentacao_caixa(TEXT, NUMERIC, TEXT, TEXT, BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.consultar_sessao_caixa_atual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consultar_sessao_caixa_atual() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_resumo_sessao_caixa_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_resumo_sessao_caixa_admin(BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.auditar_sessao_caixa_admin(BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auditar_sessao_caixa_admin(BIGINT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.listar_sessoes_caixa_admin(DATE, DATE, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_sessoes_caixa_admin(DATE, DATE, TEXT, INT, INT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
