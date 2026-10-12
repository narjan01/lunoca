-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 018: FRENTE C - CARTEIRA DE CRÉDITOS DO CLIENTE
-- ==========================================================================
-- Arquitetura e Contrato Financeiro:
-- 1. Livro-Razão Imutável (Append-Only):
--    - public.cliente_creditos: saldo consolidado por cliente (sem colunas redundantes).
--    - public.cliente_credito_movimentacoes: trilha de auditoria estrita. NUNCA UPDATE/DELETE.
--    - ON DELETE RESTRICT no cliente para preservar a integridade histórica contábil.
-- 2. Concorrência Serializada e Idempotência:
--    - Trava ordinal rigorosa: clientes(id) FOR UPDATE -> cliente_creditos(cliente_id) FOR UPDATE.
--    - Chaves de idempotência unívocas geradas server-side:
--      * Cancelamento: 'cancelamento:{pedido_id}:credito_cliente'
--      * Uso em Pedido: 'pedido:{pedido_id}:credito:{ciclo}'
--      * Ajuste Administrativo: 'ajuste:{auth.uid()}:{request_id}'
-- 3. Blindagem de Risco e DRE:
--    - saldo >= 0.00 com constraint de banco intransponível.
--    - Uso de crédito_cliente não lança receita operacional redundante no DRE (evita duplicar caixa).
--    - Cancelamento misto (C13): retorna exatamente o valor pago à carteira sem dupla restituição.
--    - Estorno de pedido pago parcialmente com crédito (C10): reverte a parcela à carteira
--      com movimentacao_origem_id preenchido.
-- 4. Segregação de Privilégios (RBAC Fail-Closed):
--    - Helper interno public.aplicar_movimento_credito_cliente: SEM grants para PUBLIC/anon/authenticated.
--    - RPC public.ajustar_credito_cliente_admin: estritamente admin (motivo >= 5 caracteres).
--    - RPC public.utilizar_credito_cliente_pedido: admin/operador atrelado a pedido existente.
--    - RPC public.consultar_saldo_credito: admin/operador.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. ESTRUTURA DE TABELAS DA CARTEIRA DE CRÉDITOS
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cliente_creditos (
  cliente_id BIGINT PRIMARY KEY REFERENCES public.clientes(id) ON DELETE RESTRICT,
  saldo NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (saldo >= 0.00),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cliente_credito_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN ('credito', 'debito')),
  origem TEXT NOT NULL CHECK (origem IN ('cancelamento_pedido', 'ajuste_manual_admin', 'uso_pedido', 'estorno_uso_pedido', 'expiracao_admin')),
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0.00),
  saldo_anterior NUMERIC(10,2) NOT NULL CHECK (saldo_anterior >= 0.00),
  saldo_posterior NUMERIC(10,2) NOT NULL CHECK (saldo_posterior >= 0.00),
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  movimentacao_origem_id BIGINT REFERENCES public.cliente_credito_movimentacoes(id) ON DELETE RESTRICT,
  motivo TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT 'Sistema',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_credito_mov_idempotency
  ON public.cliente_credito_movimentacoes(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_cliente_credito_mov_cliente_id
  ON public.cliente_credito_movimentacoes(cliente_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cliente_credito_mov_pedido_id
  ON public.cliente_credito_movimentacoes(pedido_id)
  WHERE pedido_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 2. POLÍTICAS DE RLS E PROTEÇÃO CONTRA MUTAÇÃO NO LIVRO-RAZÃO
-- --------------------------------------------------------------------------

ALTER TABLE public.cliente_creditos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_credito_movimentacoes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cliente_creditos FROM PUBLIC, anon;
REVOKE ALL ON public.cliente_credito_movimentacoes FROM PUBLIC, anon;

-- Imutabilidade do Livro-Razão: NENHUM UPDATE NEM DELETE sob nenhuma circunstância
REVOKE UPDATE, DELETE ON public.cliente_credito_movimentacoes FROM PUBLIC, anon, authenticated;

-- RLS: apenas equipe autorizada ou o próprio cliente (se vinculado por auth_user_id)
DROP POLICY IF EXISTS "Equipe visualiza saldo de creditos" ON public.cliente_creditos;
CREATE POLICY "Equipe visualiza saldo de creditos" ON public.cliente_creditos
  FOR SELECT USING (
    public.is_admin_or_operator() OR
    EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = cliente_creditos.cliente_id
        AND c.auth_user_id IS NOT NULL
        AND c.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Equipe visualiza extrato de creditos" ON public.cliente_credito_movimentacoes;
CREATE POLICY "Equipe visualiza extrato de creditos" ON public.cliente_credito_movimentacoes
  FOR SELECT USING (
    public.is_admin_or_operator() OR
    EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = cliente_credito_movimentacoes.cliente_id
        AND c.auth_user_id IS NOT NULL
        AND c.auth_user_id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- 3. EXTENSÃO DO MÉTODO DE PAGAMENTO EM PEDIDO_PAGAMENTOS
-- --------------------------------------------------------------------------
-- Substitui dinamicamente a check constraint para aceitar 'credito_cliente'

DO $$
DECLARE
  v_con_name TEXT;
BEGIN
  SELECT conname INTO v_con_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'pedido_pagamentos'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%metodo%ANY%';

  IF v_con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.pedido_pagamentos DROP CONSTRAINT ' || quote_ident(v_con_name);
  END IF;

  -- Também busca por constraints que utilizam IN (...)
  SELECT conname INTO v_con_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'pedido_pagamentos'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%metodo%IN%';

  IF v_con_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.pedido_pagamentos DROP CONSTRAINT ' || quote_ident(v_con_name);
  END IF;

  ALTER TABLE public.pedido_pagamentos
    ADD CONSTRAINT chk_pedido_pagamentos_metodo
    CHECK (metodo IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro', 'credito_cliente'));
END $$;

-- --------------------------------------------------------------------------
-- 4. HELPER INTERNO: APLICAR MOVIMENTO DE CRÉDITO DO CLIENTE (SERIALIZADO)
-- --------------------------------------------------------------------------
-- Sem GRANT para PUBLIC/anon/authenticated. Apenas SECURITY DEFINER interno.

CREATE OR REPLACE FUNCTION public.aplicar_movimento_credito_cliente(
  p_cliente_id BIGINT,
  p_tipo TEXT,
  p_origem TEXT,
  p_valor NUMERIC,
  p_motivo TEXT,
  p_idempotency_key TEXT,
  p_pedido_id BIGINT DEFAULT NULL,
  p_movimentacao_origem_id BIGINT DEFAULT NULL,
  p_usuario_id UUID DEFAULT NULL,
  p_usuario_nome TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_mov_existente RECORD;
  v_saldo_atual NUMERIC(10,2);
  v_saldo_novo NUMERIC(10,2);
  v_mov_id BIGINT;
  v_user_nome TEXT := COALESCE(NULLIF(TRIM(p_usuario_nome), ''), 'Sistema');
BEGIN
  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  IF p_tipo NOT IN ('credito', 'debito') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MOVEMENT_TYPE', 'error', 'Tipo de movimentação inválido. Use crédito ou débito.');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_AMOUNT', 'error', 'Valor da movimentação deve ser maior que zero.');
  END IF;

  IF NULLIF(TRIM(p_idempotency_key), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'IDEMPOTENCY_KEY_REQUIRED', 'error', 'Chave de idempotência é obrigatória.');
  END IF;

  -- 1. Idempotência por chave: se já foi executada, retorna sucesso sem reprocessar
  SELECT * INTO v_mov_existente
  FROM public.cliente_credito_movimentacoes
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    SELECT saldo INTO v_saldo_atual FROM public.cliente_creditos WHERE cliente_id = p_cliente_id;
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'movimentacao_id', v_mov_existente.id,
      'cliente_id', p_cliente_id,
      'tipo', v_mov_existente.tipo,
      'valor', v_mov_existente.valor,
      'saldo_anterior', v_mov_existente.saldo_anterior,
      'saldo_posterior', v_mov_existente.saldo_posterior,
      'saldo_atual', COALESCE(v_saldo_atual, v_mov_existente.saldo_posterior)
    );
  END IF;

  -- 2. LOCK ORDINAL ESTRITO: clientes -> cliente_creditos
  PERFORM 1 FROM public.clientes WHERE id = p_cliente_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_NOT_FOUND', 'error', 'Cliente não encontrado no CRM.');
  END IF;

  -- Garante registro de saldo para o cliente
  INSERT INTO public.cliente_creditos (cliente_id, saldo, created_at, updated_at)
  VALUES (p_cliente_id, 0.00, NOW(), NOW())
  ON CONFLICT (cliente_id) DO NOTHING;

  SELECT saldo INTO v_saldo_atual
  FROM public.cliente_creditos
  WHERE cliente_id = p_cliente_id
  FOR UPDATE;

  -- 3. Cálculo e guarda de saldo não negativo
  IF p_tipo = 'credito' THEN
    v_saldo_novo := v_saldo_atual + p_valor;
  ELSE
    IF v_saldo_atual < p_valor THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INSUFFICIENT_CREDIT_BALANCE',
        'error', 'Saldo de crédito insuficiente para débito.',
        'saldo_atual', v_saldo_atual,
        'valor_solicitado', p_valor
      );
    END IF;
    v_saldo_novo := v_saldo_atual - p_valor;
  END IF;

  -- 4. Atualiza saldo consolidado
  UPDATE public.cliente_creditos
  SET saldo = v_saldo_novo,
      updated_at = NOW()
  WHERE cliente_id = p_cliente_id;

  -- 5. Insere movimentação imutável no livro-razão
  INSERT INTO public.cliente_credito_movimentacoes (
    cliente_id, tipo, origem, valor,
    saldo_anterior, saldo_posterior,
    pedido_id, movimentacao_origem_id,
    motivo, idempotency_key,
    usuario_id, usuario_nome, created_at
  ) VALUES (
    p_cliente_id, p_tipo, p_origem, p_valor,
    v_saldo_atual, v_saldo_novo,
    p_pedido_id, p_movimentacao_origem_id,
    TRIM(p_motivo), p_idempotency_key,
    p_usuario_id, v_user_nome, NOW()
  ) RETURNING id INTO v_mov_id;

  RETURN jsonb_build_object(
    'success', true,
    'movimentacao_id', v_mov_id,
    'cliente_id', p_cliente_id,
    'tipo', p_tipo,
    'origem', p_origem,
    'valor', p_valor,
    'saldo_anterior', v_saldo_atual,
    'saldo_posterior', v_saldo_novo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aplicar_movimento_credito_cliente FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- 5. RPC ADMINISTRATIVA: AJUSTAR CRÉDITO DO CLIENTE (ADMIN-ONLY)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ajustar_credito_cliente_admin(
  p_cliente_id BIGINT,
  p_tipo TEXT,
  p_valor NUMERIC,
  p_motivo TEXT,
  p_request_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_admin BOOLEAN := public.is_admin();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
  v_idempotency_key TEXT;
  v_origem TEXT;
BEGIN
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas Administradores podem efetuar ajustes manuais de crédito.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  IF p_tipo NOT IN ('credito', 'debito') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_OPERATION_TYPE', 'error', 'Tipo de operação inválido. Use crédito ou débito.');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_AMOUNT', 'error', 'Valor do ajuste deve ser maior que zero.');
  END IF;

  IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Motivo explicativo obrigatório (mínimo de 5 caracteres).');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Administrador' END;
  END IF;

  v_idempotency_key := 'ajuste:' || COALESCE(auth.uid()::TEXT, 'sys') || ':' || COALESCE(NULLIF(TRIM(p_request_id), ''), encode(digest(p_cliente_id::TEXT || p_tipo || p_valor::TEXT || v_motivo, 'sha256'), 'hex'));
  v_origem := CASE WHEN p_tipo = 'credito' THEN 'ajuste_manual_admin' ELSE 'expiracao_admin' END;

  RETURN public.aplicar_movimento_credito_cliente(
    p_cliente_id := p_cliente_id,
    p_tipo := p_tipo,
    p_origem := v_origem,
    p_valor := p_valor,
    p_motivo := v_motivo,
    p_idempotency_key := v_idempotency_key,
    p_usuario_id := auth.uid(),
    p_usuario_nome := v_user_nome
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_credito_cliente_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_credito_cliente_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. RPC OPERACIONAL: UTILIZAR CRÉDITO EM PEDIDO (EQUIPE)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.utilizar_credito_cliente_pedido(
  p_pedido_id BIGINT,
  p_valor NUMERIC
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped RECORD;
  v_cliente_id BIGINT;
  v_user_nome TEXT;
  v_idempotency_key TEXT;
  v_mov_res JSONB;
  v_pag_id BIGINT;
  v_ciclo_uso INT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas administradores ou operadores podem aplicar crédito em pedidos.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido obrigatório.');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_AMOUNT', 'error', 'Valor de crédito a utilizar deve ser maior que zero.');
  END IF;

  -- 1. Trava o pedido
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Não é possível utilizar crédito em pedido cancelado.');
  END IF;

  IF v_ped.saldo <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ALREADY_PAID', 'error', 'Pedido já está integralmente quitado.');
  END IF;

  IF p_valor > v_ped.saldo THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'AMOUNT_EXCEEDS_BALANCE',
      'error', 'Valor informado (R$ ' || p_valor || ') é maior que o saldo em aberto do pedido (R$ ' || v_ped.saldo || ').',
      'saldo_pedido', v_ped.saldo
    );
  END IF;

  -- 2. Identifica o cliente canônico
  v_cliente_id := v_ped.cliente_id_rel;
  IF v_cliente_id IS NULL THEN
    -- Fallback: resolve ou cria cliente por telefone ou email
    IF v_ped.telefone_cliente IS NOT NULL AND length(v_ped.telefone_cliente) >= 8 THEN
      SELECT id INTO v_cliente_id FROM public.clientes
      WHERE telefone_normalizado = regexp_replace(v_ped.telefone_cliente, '\D', '', 'g')
      LIMIT 1;
    END IF;

    IF v_cliente_id IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, email)
      VALUES (v_ped.nome_cliente, v_ped.telefone_cliente, v_ped.email_cliente)
      RETURNING id INTO v_cliente_id;
    END IF;

    UPDATE public.pedidos SET cliente_id_rel = v_cliente_id WHERE id = p_pedido_id;
  END IF;

  -- 3. Determina o ciclo de uso para chave idempotente
  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_ciclo_uso
  FROM public.pedido_pagamentos
  WHERE pedido_id = p_pedido_id AND metodo = 'credito_cliente';

  v_idempotency_key := 'pedido:' || p_pedido_id || ':credito:' || v_ciclo_uso;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 4. Debita da carteira via helper atômico
  v_mov_res := public.aplicar_movimento_credito_cliente(
    p_cliente_id := v_cliente_id,
    p_tipo := 'debito',
    p_origem := 'uso_pedido',
    p_valor := p_valor,
    p_motivo := 'Utilização de crédito no pedido #' || p_pedido_id,
    p_idempotency_key := v_idempotency_key,
    p_pedido_id := p_pedido_id,
    p_usuario_id := auth.uid(),
    p_usuario_nome := v_user_nome
  );

  IF NOT (v_mov_res->>'success')::BOOLEAN THEN
    RETURN v_mov_res;
  END IF;

  -- 5. Registra o pagamento no pedido (o trigger recalcular_financeiro_pedido atualizará valor_pago e saldo)
  INSERT INTO public.pedido_pagamentos (
    pedido_id, valor, metodo, provider, provider_payment_id,
    status, pago_em, registrado_por, observacoes
  ) VALUES (
    p_pedido_id, p_valor, 'credito_cliente', 'caixa', 'credito_mov:' || (v_mov_res->>'movimentacao_id'),
    'aprovado', NOW(), auth.uid(), 'Liquidação via saldo da carteira do cliente'
  ) RETURNING id INTO v_pag_id;

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'cliente_id', v_cliente_id,
    'pagamento_id', v_pag_id,
    'valor_utilizado', p_valor,
    'saldo_credito_restante', (v_mov_res->>'saldo_posterior')::NUMERIC,
    'movimentacao_id', (v_mov_res->>'movimentacao_id')::BIGINT
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.utilizar_credito_cliente_pedido FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.utilizar_credito_cliente_pedido TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. RPC DE CONSULTA: SALDO E EXTRATO DE CRÉDITO DO CLIENTE
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.consultar_saldo_credito(
  p_cliente_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_saldo NUMERIC(10,2);
  v_extrato JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    -- Permite cliente autenticado consultar apenas o próprio saldo
    IF NOT EXISTS (
      SELECT 1 FROM public.clientes c
      WHERE c.id = p_cliente_id
        AND c.auth_user_id IS NOT NULL
        AND c.auth_user_id = auth.uid()
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada para consultar saldo deste cliente.');
    END IF;
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  SELECT COALESCE(saldo, 0.00) INTO v_saldo
  FROM public.cliente_creditos
  WHERE cliente_id = p_cliente_id;

  v_saldo := COALESCE(v_saldo, 0.00);

  SELECT COALESCE(jsonb_agg(m ORDER BY m.created_at DESC), '[]'::jsonb) INTO v_extrato
  FROM (
    SELECT id, tipo, origem, valor, saldo_anterior, saldo_posterior,
           pedido_id, motivo, created_at, usuario_nome
    FROM public.cliente_credito_movimentacoes
    WHERE cliente_id = p_cliente_id
    ORDER BY created_at DESC
    LIMIT 20
  ) m;

  RETURN jsonb_build_object(
    'success', true,
    'cliente_id', p_cliente_id,
    'saldo', v_saldo,
    'extrato', v_extrato
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.consultar_saldo_credito FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consultar_saldo_credito TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. ATUALIZAÇÃO CANÔNICA DE CANCELAR_PEDIDO_EQUIPE (FRENTE C)
-- --------------------------------------------------------------------------
-- Incorpora 'CREDITO_CLIENTE' e 'ESTORNO' com cancelamento misto auditado e atômico.

CREATE OR REPLACE FUNCTION public.cancelar_pedido_equipe(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT NULL,
  p_destino_valor TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ped RECORD;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
  v_cliente_id BIGINT;
  v_idempotency_key TEXT;
  v_mov_res JSONB;
  v_pago_credito NUMERIC(10,2) := 0.00;
  v_pago_externo NUMERIC(10,2) := 0.00;
  v_total_pago NUMERIC(10,2) := 0.00;
  v_pag RECORD;
  v_mov_origem_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas administradores ou operadores podem cancelar pedidos.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  -- 1. Idempotência: se já cancelado comercial e operacionalmente
  IF v_ped.status_comercial = 'cancelado' AND v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'status_comercial', 'cancelado',
      'status_operacional', 'cancelado'
    );
  END IF;

  -- 2. Guarda de Produção Ativa: se já em preparo/pronto/entrega, operador é bloqueado
  IF v_ped.status_operacional NOT IN ('aguardando_producao', 'cancelado') AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PRODUCTION_ACTIVE_CANCEL_DENIED',
      'error', 'Pedidos com produção já iniciada ("' || v_ped.status_operacional || '") só podem ser cancelados por Administradores.'
    );
  END IF;

  -- 3. Apuração precisa dos pagamentos aprovados existentes
  SELECT COALESCE(SUM(valor), 0.00) INTO v_pago_credito
  FROM public.pedido_pagamentos
  WHERE pedido_id = p_pedido_id AND status = 'aprovado' AND metodo = 'credito_cliente';

  SELECT COALESCE(SUM(valor), 0.00) INTO v_pago_externo
  FROM public.pedido_pagamentos
  WHERE pedido_id = p_pedido_id AND status = 'aprovado' AND metodo <> 'credito_cliente';

  v_total_pago := v_pago_credito + v_pago_externo;

  -- 4. Guarda de Destino Financeiro
  IF GREATEST(v_total_pago, COALESCE(v_ped.valor_pago, 0.00)) > 0.00 AND NOT v_is_admin THEN
    IF COALESCE(p_destino_valor, '') NOT IN ('RETENCAO_CANCELAMENTO', 'CREDITO_CLIENTE', 'ESTORNO') 
       AND v_ped.status_financeiro <> 'estornado' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
        'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de destino (RETENCAO_CANCELAMENTO, CREDITO_CLIENTE ou ESTORNO).'
      );
    END IF;
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 5. Resolução/Garantia do cliente canônico se houver movimentação de crédito
  v_cliente_id := v_ped.cliente_id_rel;
  IF (v_total_pago > 0.00 OR v_pago_credito > 0.00) AND v_cliente_id IS NULL THEN
    IF v_ped.telefone_cliente IS NOT NULL AND length(v_ped.telefone_cliente) >= 8 THEN
      SELECT id INTO v_cliente_id FROM public.clientes
      WHERE telefone_normalizado = regexp_replace(v_ped.telefone_cliente, '\D', '', 'g')
      LIMIT 1;
    END IF;

    IF v_cliente_id IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, email)
      VALUES (v_ped.nome_cliente, v_ped.telefone_cliente, v_ped.email_cliente)
      RETURNING id INTO v_cliente_id;
    END IF;

    UPDATE public.pedidos SET cliente_id_rel = v_cliente_id WHERE id = p_pedido_id;
  END IF;

  -- 6. Execução do Destino Financeiro
  IF p_destino_valor = 'CREDITO_CLIENTE' AND v_total_pago > 0.00 THEN
    -- C1 & C13: Todo o valor pago (crédito + externo) é transformado em crédito para a carteira
    v_idempotency_key := 'cancelamento:' || p_pedido_id || ':credito_cliente';
    
    v_mov_res := public.aplicar_movimento_credito_cliente(
      p_cliente_id := v_cliente_id,
      p_tipo := 'credito',
      p_origem := 'cancelamento_pedido',
      p_valor := v_total_pago,
      p_motivo := 'Crédito integral decorrente do cancelamento do pedido #' || p_pedido_id,
      p_idempotency_key := v_idempotency_key,
      p_pedido_id := p_pedido_id,
      p_usuario_id := auth.uid(),
      p_usuario_nome := v_user_nome
    );

    IF NOT (v_mov_res->>'success')::BOOLEAN THEN
      RETURN v_mov_res;
    END IF;

    -- Marca os pagamentos como estornados para atualizar o status financeiro do pedido
    UPDATE public.pedido_pagamentos
    SET status = 'estornado'
    WHERE pedido_id = p_pedido_id AND status = 'aprovado';

  ELSIF p_destino_valor = 'ESTORNO' THEN
    -- C10: Se houve pagamento em crédito, reverte a parcela à carteira; a parcela externa é estornada
    IF v_pago_credito > 0.00 THEN
      -- Localiza a movimentação original de débito para vinculação
      SELECT id INTO v_mov_origem_id
      FROM public.cliente_credito_movimentacoes
      WHERE pedido_id = p_pedido_id AND tipo = 'debito' AND origem = 'uso_pedido'
      ORDER BY id DESC LIMIT 1;

      v_idempotency_key := 'cancelamento:' || p_pedido_id || ':estorno_credito';
      
      v_mov_res := public.aplicar_movimento_credito_cliente(
        p_cliente_id := v_cliente_id,
        p_tipo := 'credito',
        p_origem := 'estorno_uso_pedido',
        p_valor := v_pago_credito,
        p_motivo := 'Estorno de crédito decorrente de cancelamento do pedido #' || p_pedido_id,
        p_idempotency_key := v_idempotency_key,
        p_pedido_id := p_pedido_id,
        p_movimentacao_origem_id := v_mov_origem_id,
        p_usuario_id := auth.uid(),
        p_usuario_nome := v_user_nome
      );

      IF NOT (v_mov_res->>'success')::BOOLEAN THEN
        RETURN v_mov_res;
      END IF;
    END IF;

    -- Atualiza todos os pagamentos aprovados para estornado
    UPDATE public.pedido_pagamentos
    SET status = 'estornado'
    WHERE pedido_id = p_pedido_id AND status = 'aprovado';

  ELSIF p_destino_valor = 'RETENCAO_CANCELAMENTO' THEN
    -- Valor é retido pela loja; não estorna pagamento e não devolve à carteira
    NULL;
  END IF;

  -- 7. Atualiza o pedido. O trigger trg_liberar_reserva_ao_cancelar liberará estoque e capacidade
  UPDATE public.pedidos
  SET 
    status_comercial = 'cancelado',
    status_operacional = 'cancelado',
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 8. Registra no histórico auditável
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id,
    'comercial',
    v_ped.status_comercial,
    'cancelado',
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'motivo', COALESCE(v_motivo, 'Cancelamento via porta dedicada cancelar_pedido_equipe'),
      'porta_dominio', 'cancelar_pedido_equipe',
      'destino_valor', p_destino_valor,
      'valor_pago_total', v_total_pago,
      'valor_credito_devolvido', CASE WHEN p_destino_valor = 'CREDITO_CLIENTE' THEN v_total_pago WHEN p_destino_valor = 'ESTORNO' THEN v_pago_credito ELSE 0.00 END,
      'status_operacional_anterior', v_ped.status_operacional
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_comercial', 'cancelado',
    'status_operacional', 'cancelado',
    'destino_valor', p_destino_valor,
    'reservas_liberadas', true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.cancelar_pedido_equipe FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_equipe TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. ATUALIZAÇÃO DO TRIGGER RECALCULAR_FINANCEIRO_PEDIDO (BLINDAGEM DRE)
-- --------------------------------------------------------------------------
-- Ao estornar pagamentos com metodo = 'credito_cliente', NÃO gera despesa
-- contábil de estorno no DRE (preserva caixa real).

CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_ped_id BIGINT := COALESCE(NEW.pedido_id, OLD.pedido_id);
  v_ped RECORD;
  v_pago NUMERIC(10,2);
  v_saldo NUMERIC(10,2);
  v_novo_status_fin TEXT;
  v_novo_status_com TEXT;
  v_tem_estorno BOOLEAN := false;
  v_hold_expirado BOOLEAN := false;
  v_novo_expires_at TIMESTAMPTZ;
  v_limite_hold TIMESTAMPTZ;
  v_requer_revisao BOOLEAN;
  v_bloqueado_tardio BOOLEAN;
  v_motivo_revisao TEXT;
  v_motivo_com TEXT := NULL;
  v_cap public.capacidade_producao;
  v_pts_pedido NUMERIC(8,2);
  v_pts_ocupados NUMERIC(8,2);
  v_cap_ok BOOLEAN := true;
  v_reserva JSON;
  v_estoque_ok BOOLEAN := true;
BEGIN
  -- 1. LOCK DO PEDIDO (primeiro recurso da ordem global)
  SELECT id, total, sinal_minimo, status_comercial, status_operacional, status_financeiro,
         confirmacao_expires_at, requer_revisao_financeira, bloqueado_por_overbooking_tardio, data_entrega, hora_entrega
  INTO v_ped
  FROM public.pedidos
  WHERE id = v_ped_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_novo_expires_at := v_ped.confirmacao_expires_at;
  v_requer_revisao := v_ped.requer_revisao_financeira;
  v_bloqueado_tardio := v_ped.bloqueado_por_overbooking_tardio;
  v_motivo_revisao := NULL;

  -- 2. Soma estritamente pagamentos aprovados
  SELECT COALESCE(SUM(valor), 0) INTO v_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = v_ped_id AND status = 'aprovado';

  v_saldo := GREATEST(0, COALESCE(v_ped.total, 0) - v_pago);

  SELECT EXISTS (SELECT 1 FROM public.pedido_pagamentos WHERE pedido_id = v_ped_id AND status = 'estornado') INTO v_tem_estorno;

  IF v_tem_estorno AND v_pago <= 0 THEN
    v_novo_status_fin := 'estornado';
  ELSIF v_pago <= 0 THEN
    v_novo_status_fin := 'nao_pago';
  ELSIF v_saldo <= 0 THEN
    v_novo_status_fin := 'pago';
  ELSE
    v_novo_status_fin := 'parcialmente_pago';
  END IF;

  v_novo_status_com := v_ped.status_comercial;

  -- 3. Regra 1: Confirmação por sinal (com revalidação dupla se o hold já expirou)
  IF v_ped.sinal_minimo > 0 AND v_pago >= v_ped.sinal_minimo AND v_ped.status_comercial = 'aguardando_confirmacao' THEN
    v_hold_expirado := (v_ped.confirmacao_expires_at IS NOT NULL AND v_ped.confirmacao_expires_at <= NOW()) OR v_ped.requer_revisao_financeira;

    IF NOT v_hold_expirado THEN
      v_novo_status_com := 'confirmado';
      v_novo_expires_at := NULL;
      v_requer_revisao := false;
      v_bloqueado_tardio := false;
      v_motivo_com := 'Sinal mínimo atingido por pagamento acumulado dentro do prazo de confirmação';
    ELSE
      v_cap := public.travar_capacidade_data(v_ped.data_entrega);
      v_pts_pedido := public.pontos_pedido(v_ped_id);
      v_pts_ocupados := public.pontos_ocupados_data(v_ped.data_entrega, v_ped_id);
      v_cap_ok := NOT (v_cap.bloqueado = true OR (v_pts_ocupados + v_pts_pedido) > v_cap.capacidade_maxima_pontos);

      IF v_cap_ok THEN
        v_reserva := public.reservar_estoque_itens_pedido(v_ped_id, 'Reserva recriada após pagamento tardio do pedido #' || v_ped_id, true);
        v_estoque_ok := COALESCE((v_reserva->>'success')::BOOLEAN, false);
      ELSE
        v_reserva := NULL;
        SELECT NOT EXISTS (
          SELECT 1
          FROM public.pedido_itens pi
          JOIN public.produtos pr ON pr.id = pi.produto_id
          WHERE pi.pedido_id = v_ped_id
            AND pr.controlar_estoque IS NOT FALSE
            AND pi.reserva_estoque_ativa = false
            AND (COALESCE(pr.estoque_fisico, 0) - COALESCE(pr.estoque_reservado, 0)) < pi.quantidade
        ) INTO v_estoque_ok;
      END IF;

      IF v_cap_ok AND v_estoque_ok THEN
        v_novo_status_com := 'confirmado';
        v_novo_expires_at := NULL;
        v_requer_revisao := false;
        v_bloqueado_tardio := false;
        v_motivo_com := 'Pagamento tardio aceito após revalidação atômica com sucesso de capacidade e estoque';
      ELSE
        v_novo_status_com := 'aguardando_confirmacao';
        v_requer_revisao := true;
        v_bloqueado_tardio := true;
        v_motivo_revisao := 'Pagamento tardio recebido após expiração do hold, porém '
          || CASE
               WHEN NOT v_cap_ok AND NOT v_estoque_ok THEN 'a capacidade de produção e o estoque'
               WHEN NOT v_cap_ok THEN 'a capacidade de produção'
               ELSE 'o estoque'
             END
          || ' já não comportam esta encomenda. Requer decisão administrativa.';
        v_motivo_com := v_motivo_revisao;
      END IF;
    END IF;
  END IF;

  -- 4. Regra 2: Guarda de produção em caso de estorno do sinal (+ renovação do hold)
  IF v_ped.sinal_minimo > 0 AND v_pago < v_ped.sinal_minimo THEN
    IF v_ped.status_operacional = 'aguardando_producao' AND v_ped.status_comercial = 'confirmado' THEN
      v_novo_status_com := 'aguardando_confirmacao';
      v_limite_hold := (((v_ped.data_entrega + COALESCE(v_ped.hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_cfg.timezone)
                       - make_interval(hours => v_cfg.antecedencia_confirmacao_horas);
      v_novo_expires_at := LEAST(NOW() + make_interval(hours => v_cfg.hold_horas_padrao), v_limite_hold);
      IF v_novo_expires_at <= NOW() THEN
        v_novo_expires_at := NOW();
        v_requer_revisao := true;
        v_motivo_revisao := 'Estorno de sinal reduziu o valor pago abaixo do mínimo e a entrega está dentro da antecedência mínima; sem prazo de hold viável. Requer decisão administrativa.';
        v_motivo_com := v_motivo_revisao;
        PERFORM public.liberar_estoque_itens_pedido(v_ped_id, 'Liberação de reserva: estorno sem hold viável no pedido #' || v_ped_id);
      ELSE
        v_motivo_com := 'Estorno de sinal reduziu valor pago abaixo do mínimo antes do início da produção; hold renovado até ' || to_char(v_novo_expires_at AT TIME ZONE v_cfg.timezone, 'DD/MM HH24:MI');
      END IF;
    ELSE
      v_novo_status_com := v_ped.status_comercial;
    END IF;
  END IF;

  UPDATE public.pedidos
  SET valor_pago = v_pago,
      saldo = v_saldo,
      status_financeiro = v_novo_status_fin,
      status_comercial = v_novo_status_com,
      possui_estorno = v_tem_estorno,
      confirmacao_expires_at = v_novo_expires_at,
      requer_revisao_financeira = v_requer_revisao,
      bloqueado_por_overbooking_tardio = v_bloqueado_tardio,
      motivo_revisao_financeira = CASE WHEN v_requer_revisao THEN COALESCE(v_motivo_revisao, motivo_revisao_financeira) ELSE NULL END,
      updated_at = NOW()
  WHERE id = v_ped_id;

  -- 5. Lançamento compensatório no DRE ao estornar pagamento aprovado (apenas para métodos externos de caixa)
  IF TG_OP = 'UPDATE' AND OLD.status = 'aprovado' AND NEW.status = 'estornado' THEN
    IF NEW.metodo <> 'credito_cliente' THEN
      INSERT INTO public.financeiro_lancamentos (
        tipo, categoria, descricao, valor, data_lancamento, forma_pagamento, pedido_id, origem_tipo, origem_id, evento, observacoes
      ) VALUES (
        'despesa', 'Estornos',
        'Estorno de Pagamento #' || NEW.id || ' do Pedido #' || v_ped_id || ' (' || upper(NEW.metodo) || ')',
        NEW.valor, (NOW() AT TIME ZONE v_cfg.timezone)::DATE, NEW.metodo, v_ped_id,
        'pedido_pagamento', NEW.id, 'estorno',
        'Estorno financeiro contábil automático via pedido_pagamentos #' || NEW.id
      )
      ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
    END IF;
  END IF;

  -- 6. Auditoria financeira
  IF v_ped.status_financeiro IS DISTINCT FROM v_novo_status_fin THEN
    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (
      v_ped_id, 'financeiro', COALESCE(v_ped.status_financeiro, 'nao_pago'), v_novo_status_fin, auth.uid(), 'Sistema / Trigger Financeiro',
      CASE WHEN auth.role() = 'service_role' THEN 'sistema' WHEN public.is_admin_or_operator() THEN 'admin' ELSE 'sistema' END,
      jsonb_build_object('motivo', 'Recálculo automático via pedido_pagamentos', 'valor_pago', v_pago, 'saldo', v_saldo, 'tem_estorno', v_tem_estorno)
    );
  END IF;

  -- 7. Auditoria comercial
  IF v_ped.status_comercial IS DISTINCT FROM v_novo_status_com
     OR (v_bloqueado_tardio AND NOT v_ped.bloqueado_por_overbooking_tardio) THEN
    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (
      v_ped_id, 'comercial', v_ped.status_comercial, v_novo_status_com, auth.uid(), 'Sistema / Gatilho de Sinal', 'sistema',
      jsonb_build_object(
        'motivo', v_motivo_com,
        'valor_pago', v_pago,
        'sinal_minimo', v_ped.sinal_minimo,
        'hold_expirado', v_hold_expirado,
        'capacidade_ok', v_cap_ok,
        'estoque_ok', v_estoque_ok,
        'reserva', v_reserva,
        'requer_revisao_financeira', v_requer_revisao,
        'bloqueado_por_overbooking_tardio', v_bloqueado_tardio
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
