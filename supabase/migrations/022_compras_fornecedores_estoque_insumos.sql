-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 022: COMPRAS, FORNECEDORES, ESTOQUE DE INSUMOS E CMV REAL (FRENTE G)
-- ==============================================================================
-- Esta migration implementa a camada transacional de abastecimento e custos reais:
-- 1. Fornecedores (public.fornecedores)
-- 2. Saldos e Custo Médio Ponderado de Insumos (public.ingrediente_saldos)
-- 3. Livro-Razão Imutável de Movimentações de Insumos (public.ingrediente_movimentacoes)
-- 4. Pedidos de Compra e Itens (public.compras, public.compra_itens)
-- 5. Contas a Pagar de Fornecedores (public.contas_pagar) integrada ao DRE
-- 6. RPCs Transacionais:
--    - salvar_fornecedor_admin / listar_fornecedores_admin
--    - criar_compra / receber_compra / cancelar_compra
--    - registrar_perda_insumo / ajustar_estoque_insumo_admin
--    - registrar_pagamento_fornecedor
--    - obter_necessidade_reposicao / obter_cmv_real_produto
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABELA DE FORNECEDORES
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fornecedores (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL CHECK (char_length(btrim(nome)) >= 2),
  documento TEXT,
  telefone TEXT,
  telefone_normalizado TEXT,
  email TEXT,
  contato_nome TEXT,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fornecedores_nome ON public.fornecedores(nome);
CREATE INDEX IF NOT EXISTS idx_fornecedores_ativo ON public.fornecedores(ativo);

ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fornecedores_select_staff ON public.fornecedores;
CREATE POLICY fornecedores_select_staff ON public.fornecedores
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS fornecedores_write_admin ON public.fornecedores;
CREATE POLICY fornecedores_write_admin ON public.fornecedores
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

REVOKE ALL ON public.fornecedores FROM PUBLIC, anon;
GRANT SELECT ON public.fornecedores TO authenticated;
GRANT ALL ON public.fornecedores TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fornecedores_id_seq TO service_role;

-- ------------------------------------------------------------------------------
-- 2. EXTENSÃO DE PUBLIC.INGREDIENTES & TABELA DE SALDOS / CUSTO MÉDIO
-- ------------------------------------------------------------------------------
ALTER TABLE public.ingredientes
  ADD COLUMN IF NOT EXISTS custo_medio_unitario NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS ultimo_custo_compra NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS fornecedor_padrao_id BIGINT REFERENCES public.fornecedores(id) ON DELETE SET NULL;

-- Backfill inicial: se custo_medio_unitario for 0 e custo_unitario > 0, inicializa com custo_unitario
UPDATE public.ingredientes
SET
  custo_medio_unitario = custo_unitario,
  ultimo_custo_compra = custo_unitario
WHERE custo_medio_unitario = 0 AND custo_unitario > 0;

CREATE TABLE IF NOT EXISTS public.ingrediente_saldos (
  ingrediente_id BIGINT PRIMARY KEY REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  saldo_atual NUMERIC(12,3) NOT NULL DEFAULT 0.000 CHECK (saldo_atual >= 0),
  custo_medio_ponderado NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_medio_ponderado >= 0),
  ultimo_custo_compra NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (ultimo_custo_compra >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sincronização inicial de saldos a partir de public.ingredientes
INSERT INTO public.ingrediente_saldos (ingrediente_id, saldo_atual, custo_medio_ponderado, ultimo_custo_compra, updated_at)
SELECT
  i.id,
  GREATEST(0, COALESCE(i.estoque_qtd, 0)),
  GREATEST(0, COALESCE(NULLIF(i.custo_medio_unitario, 0), i.custo_unitario, 0)),
  GREATEST(0, COALESCE(NULLIF(i.ultimo_custo_compra, 0), i.custo_unitario, 0)),
  NOW()
FROM public.ingredientes i
ON CONFLICT (ingrediente_id) DO NOTHING;

-- Trigger para criar linha em ingrediente_saldos sempre que um novo ingrediente for cadastrado
CREATE OR REPLACE FUNCTION public._trg_inicializar_saldo_ingrediente()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.ingrediente_saldos (
    ingrediente_id, saldo_atual, custo_medio_ponderado, ultimo_custo_compra, updated_at
  ) VALUES (
    NEW.id,
    GREATEST(0, COALESCE(NEW.estoque_qtd, 0)),
    GREATEST(0, COALESCE(NULLIF(NEW.custo_medio_unitario, 0), NEW.custo_unitario, 0)),
    GREATEST(0, COALESCE(NULLIF(NEW.ultimo_custo_compra, 0), NEW.custo_unitario, 0)),
    NOW()
  )
  ON CONFLICT (ingrediente_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_inicializar_saldo_ingrediente ON public.ingredientes;
CREATE TRIGGER trg_inicializar_saldo_ingrediente
  AFTER INSERT ON public.ingredientes
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_inicializar_saldo_ingrediente();

ALTER TABLE public.ingrediente_saldos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingrediente_saldos_select_staff ON public.ingrediente_saldos;
CREATE POLICY ingrediente_saldos_select_staff ON public.ingrediente_saldos
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

REVOKE ALL ON public.ingrediente_saldos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ingrediente_saldos TO authenticated;
GRANT ALL ON public.ingrediente_saldos TO service_role;

-- ------------------------------------------------------------------------------
-- 3. COMPRAS E ITENS DE COMPRA
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compras (
  id BIGSERIAL PRIMARY KEY,
  numero_nota TEXT,
  fornecedor_id BIGINT NOT NULL REFERENCES public.fornecedores(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'recebida', 'cancelada')),
  data_compra DATE NOT NULL DEFAULT CURRENT_DATE,
  data_recebimento TIMESTAMPTZ,
  valor_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_subtotal >= 0),
  valor_frete NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_frete >= 0),
  valor_desconto NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_desconto >= 0),
  valor_total NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_total >= 0),
  observacoes TEXT,
  motivo_cancelamento TEXT,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recebido_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compras_fornecedor ON public.compras(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_compras_status ON public.compras(status);
CREATE INDEX IF NOT EXISTS idx_compras_data ON public.compras(data_compra);

CREATE TABLE IF NOT EXISTS public.compra_itens (
  id BIGSERIAL PRIMARY KEY,
  compra_id BIGINT NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  quantidade NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  unidade VARCHAR(10) NOT NULL DEFAULT 'g',
  custo_unitario NUMERIC(12,4) NOT NULL CHECK (custo_unitario >= 0),
  custo_unitario_efetivo NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_efetivo >= 0),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_compra_ingrediente UNIQUE (compra_id, ingrediente_id)
);

CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON public.compra_itens(compra_id);
CREATE INDEX IF NOT EXISTS idx_compra_itens_ingrediente ON public.compra_itens(ingrediente_id);

ALTER TABLE public.compras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compra_itens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compras_select_admin ON public.compras;
CREATE POLICY compras_select_admin ON public.compras
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS compra_itens_select_admin ON public.compra_itens;
CREATE POLICY compra_itens_select_admin ON public.compra_itens
  FOR SELECT TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.compras FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.compra_itens FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.compras TO authenticated;
GRANT SELECT ON public.compra_itens TO authenticated;
GRANT ALL ON public.compras TO service_role;
GRANT ALL ON public.compra_itens TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.compras_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.compra_itens_id_seq TO service_role;

-- ------------------------------------------------------------------------------
-- 4. LIVRO-RAZÃO IMUTÁVEL DE MOVIMENTAÇÕES DE INSUMOS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingrediente_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'entrada_compra',
    'consumo_producao',
    'perda',
    'ajuste_entrada',
    'ajuste_saida',
    'estorno_compra'
  )),
  quantidade NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  saldo_anterior NUMERIC(12,3) NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior NUMERIC(12,3) NOT NULL CHECK (saldo_posterior >= 0),
  custo_unitario_aplicado NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_aplicado >= 0),
  custo_medio_anterior NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_medio_anterior >= 0),
  custo_medio_posterior NUMERIC(12,4) NOT NULL DEFAULT 0.0000 CHECK (custo_medio_posterior >= 0),
  valor_total_movimento NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_total_movimento >= 0),
  compra_id BIGINT REFERENCES public.compras(id) ON DELETE SET NULL,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  motivo TEXT NOT NULL CHECK (char_length(btrim(motivo)) >= 3),
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ing_mov_ingrediente ON public.ingrediente_movimentacoes(ingrediente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ing_mov_compra ON public.ingrediente_movimentacoes(compra_id);
CREATE INDEX IF NOT EXISTS idx_ing_mov_pedido ON public.ingrediente_movimentacoes(pedido_id);
CREATE INDEX IF NOT EXISTS idx_ing_mov_tipo ON public.ingrediente_movimentacoes(tipo);

-- Imutabilidade estrita do Livro-Razão de Insumos
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_ingrediente_movimentacoes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_LEDGER_VIOLATION: O livro-razão ingrediente_movimentacoes é imutável e não permite %.', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_ingrediente_mov ON public.ingrediente_movimentacoes;
CREATE TRIGGER trg_imutabilidade_ingrediente_mov
  BEFORE UPDATE OR DELETE ON public.ingrediente_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_ingrediente_movimentacoes();

ALTER TABLE public.ingrediente_movimentacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ing_mov_select_staff ON public.ingrediente_movimentacoes;
CREATE POLICY ing_mov_select_staff ON public.ingrediente_movimentacoes
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

REVOKE ALL ON public.ingrediente_movimentacoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ingrediente_movimentacoes TO authenticated;
GRANT ALL ON public.ingrediente_movimentacoes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ingrediente_movimentacoes_id_seq TO service_role;

-- ------------------------------------------------------------------------------
-- 5. CONTAS A PAGAR (FORNECEDORES & ABASTECIMENTO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contas_pagar (
  id BIGSERIAL PRIMARY KEY,
  compra_id BIGINT UNIQUE REFERENCES public.compras(id) ON DELETE RESTRICT,
  fornecedor_id BIGINT NOT NULL REFERENCES public.fornecedores(id) ON DELETE RESTRICT,
  descricao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'Insumos / Fornecedores',
  valor_total NUMERIC(12,2) NOT NULL CHECK (valor_total > 0),
  valor_pago NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (valor_pago >= 0),
  saldo_aberto NUMERIC(12,2) NOT NULL CHECK (saldo_aberto >= 0),
  data_vencimento DATE NOT NULL DEFAULT CURRENT_DATE,
  data_quitacao TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'parcial', 'paga', 'cancelada')),
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_contas_pagar_consistencia CHECK (ROUND(valor_pago + saldo_aberto, 2) = ROUND(valor_total, 2) OR status = 'cancelada')
);

CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor ON public.contas_pagar(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_status ON public.contas_pagar(status);
CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento ON public.contas_pagar(data_vencimento);

ALTER TABLE public.contas_pagar ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contas_pagar_select_admin ON public.contas_pagar;
CREATE POLICY contas_pagar_select_admin ON public.contas_pagar
  FOR SELECT TO authenticated
  USING (public.is_admin());

REVOKE ALL ON public.contas_pagar FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.contas_pagar TO authenticated;
GRANT ALL ON public.contas_pagar TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.contas_pagar_id_seq TO service_role;

-- ------------------------------------------------------------------------------
-- 6. MOTOR INTERNO DE MOVIMENTAÇÃO E CUSTO MÉDIO PONDERADO
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

  -- Lock em ingredientes e ingrediente_saldos em ordem fixa
  SELECT * INTO v_ing
  FROM public.ingredientes
  WHERE id = p_ingrediente_id
  FOR UPDATE;

  IF NOT FOUND THEN
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

    -- Cálculo do Custo Médio Ponderado (CMP)
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
    -- Saídas: consumo_producao, perda, ajuste_saida, estorno_compra
    IF v_saldo_ant < p_quantidade THEN
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
      -- Ao estornar uma compra, recompõe o custo médio anterior se sobrar saldo
      IF v_saldo_post > 0 THEN
        v_cmp_post := GREATEST(0.0000, ROUND(((v_saldo_ant * v_cmp_ant) - (p_quantidade * v_custo_aplicado)) / v_saldo_post, 4));
      ELSE
        v_cmp_post := v_cmp_ant;
      END IF;
    ELSE
      -- Consumo, perda e saída usam o CMP vigente sem alterá-lo
      v_custo_aplicado := v_cmp_ant;
      v_cmp_post := v_cmp_ant;
    END IF;
  END IF;

  v_valor_total := ROUND(p_quantidade * v_custo_aplicado, 2);

  -- Atualiza tabela de saldos consolidados
  UPDATE public.ingrediente_saldos
  SET
    saldo_atual = v_saldo_post,
    custo_medio_ponderado = v_cmp_post,
    ultimo_custo_compra = CASE WHEN p_tipo = 'entrada_compra' THEN v_custo_aplicado ELSE ultimo_custo_compra END,
    updated_at = NOW()
  WHERE ingrediente_id = p_ingrediente_id;

  -- Sincroniza tabela public.ingredientes para retrocompatibilidade total
  UPDATE public.ingredientes
  SET
    estoque_qtd = v_saldo_post,
    custo_medio_unitario = v_cmp_post,
    ultimo_custo_compra = CASE WHEN p_tipo = 'entrada_compra' THEN v_custo_aplicado ELSE ultimo_custo_compra END,
    updated_at = NOW()
  WHERE id = p_ingrediente_id;

  -- Grava no livro-razão imutável
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
-- 7. RPCs DE FORNECEDORES
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_fornecedor_admin(
  p_nome TEXT,
  p_documento TEXT DEFAULT NULL,
  p_telefone TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_contato_nome TEXT DEFAULT NULL,
  p_observacoes TEXT DEFAULT NULL,
  p_id BIGINT DEFAULT NULL,
  p_ativo BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_tel_norm TEXT;
  v_forn_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar fornecedores.');
  END IF;

  IF p_nome IS NULL OR char_length(btrim(p_nome)) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_SUPPLIER_NAME', 'error', 'Nome do fornecedor deve ter pelo menos 2 caracteres.');
  END IF;

  IF p_telefone IS NOT NULL AND btrim(p_telefone) <> '' THEN
    v_tel_norm := public.normalizar_telefone_e164(p_telefone);
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.fornecedores
    SET
      nome = btrim(p_nome),
      documento = NULLIF(btrim(p_documento), ''),
      telefone = NULLIF(btrim(p_telefone), ''),
      telefone_normalizado = v_tel_norm,
      email = NULLIF(btrim(p_email), ''),
      contato_nome = NULLIF(btrim(p_contato_nome), ''),
      observacoes = NULLIF(btrim(p_observacoes), ''),
      ativo = COALESCE(p_ativo, true),
      updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_forn_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'SUPPLIER_NOT_FOUND', 'error', 'Fornecedor não encontrado.');
    END IF;
  ELSE
    INSERT INTO public.fornecedores (
      nome, documento, telefone, telefone_normalizado, email, contato_nome, observacoes, ativo
    ) VALUES (
      btrim(p_nome),
      NULLIF(btrim(p_documento), ''),
      NULLIF(btrim(p_telefone), ''),
      v_tel_norm,
      NULLIF(btrim(p_email), ''),
      NULLIF(btrim(p_contato_nome), ''),
      NULLIF(btrim(p_observacoes), ''),
      COALESCE(p_ativo, true)
    )
    RETURNING id INTO v_forn_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'fornecedor_id', v_forn_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_fornecedor_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_fornecedor_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BOOLEAN) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.listar_fornecedores_admin(
  p_apenas_ativos BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
  v_lista JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Acesso restrito à equipe.');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(f)::jsonb ORDER BY f.nome), '[]'::jsonb)
  INTO v_lista
  FROM public.fornecedores f
  WHERE (NOT COALESCE(p_apenas_ativos, false)) OR f.ativo = true;

  RETURN jsonb_build_object('success', true, 'fornecedores', v_lista);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_fornecedores_admin(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_fornecedores_admin(BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 8. RPC: CRIAR_COMPRA
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
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem registrar compras de insumos.');
  END IF;

  -- Idempotência
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

  -- Valida todos os itens e calcula subtotal
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

  -- Insere os itens calculando custo efetivo rateado (frete - desconto proporcional)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_ing_id := (v_item->>'ingrediente_id')::BIGINT;
    v_qtd := ROUND((v_item->>'quantidade')::NUMERIC, 3);
    v_custo := ROUND((v_item->>'custo_unitario')::NUMERIC, 4);
    v_sub_item := ROUND(v_qtd * v_custo, 2);

    SELECT unidade INTO v_ing FROM public.ingredientes WHERE id = v_ing_id;

    INSERT INTO public.compra_itens (
      compra_id,
      ingrediente_id,
      quantidade,
      unidade,
      custo_unitario,
      custo_unitario_efetivo,
      subtotal
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
      v_sub_item
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

-- ------------------------------------------------------------------------------
-- 9. RPC: RECEBER_COMPRA (IDEMPOTENTE + CUSTO MÉDIO + CONTA A PAGAR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.receber_compra(
  p_compra_id BIGINT,
  p_data_vencimento DATE DEFAULT NULL,
  p_gerar_conta_pagar BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_compra RECORD;
  v_forn RECORD;
  v_item RECORD;
  v_mov JSONB;
  v_usuario_nome TEXT;
  v_conta_id BIGINT;
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

  -- Idempotência: se já recebida, retorna sucesso sem duplicar entrada nem conta a pagar
  IF v_compra.status = 'recebida' THEN
    SELECT id INTO v_conta_id FROM public.contas_pagar WHERE compra_id = v_compra.id;
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'compra_id', v_compra.id,
      'status', v_compra.status,
      'conta_pagar_id', v_conta_id
    );
  END IF;

  IF v_compra.status = 'cancelada' THEN
    RETURN jsonb_build_object('success', false, 'code', 'PURCHASE_CANCELLED', 'error', 'Não é possível receber uma compra cancelada.');
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  SELECT * INTO v_forn FROM public.fornecedores WHERE id = v_compra.fornecedor_id;

  -- Processa entrada no estoque para cada item em ordem de ingrediente_id (evita deadlocks)
  FOR v_item IN
    SELECT * FROM public.compra_itens
    WHERE compra_id = v_compra.id
    ORDER BY ingrediente_id ASC
  LOOP
    v_mov := public._aplicar_movimento_ingrediente(
      p_ingrediente_id => v_item.ingrediente_id,
      p_tipo => 'entrada_compra',
      p_quantidade => v_item.quantidade,
      p_custo_unitario => v_item.custo_unitario_efetivo,
      p_motivo => format('Recebimento de Compra #%s (%s)', v_compra.id, COALESCE(v_forn.nome, 'Fornecedor')),
      p_compra_id => v_compra.id,
      p_pedido_id => NULL,
      p_usuario_id => auth.uid(),
      p_usuario_nome => COALESCE(v_usuario_nome, 'Administrador'),
      p_idempotency_key => format('rec_compra_%s_ing_%s', v_compra.id, v_item.ingrediente_id)
    );

    IF NOT COALESCE((v_mov->>'success')::BOOLEAN, false) THEN
      RAISE EXCEPTION '%', v_mov->>'error';
    END IF;
  END LOOP;

  -- Atualiza status da compra
  UPDATE public.compras
  SET
    status = 'recebida',
    data_recebimento = NOW(),
    recebido_por = auth.uid(),
    updated_at = NOW()
  WHERE id = v_compra.id;

  -- Gera conta a pagar se solicitado e valor_total > 0
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
    'conta_pagar_id', v_conta_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.receber_compra(BIGINT, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receber_compra(BIGINT, DATE, BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. RPC: CANCELAR_COMPRA (ANTES OU DEPOIS DO RECEBIMENTO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancelar_compra(
  p_compra_id BIGINT,
  p_motivo TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_compra RECORD;
  v_conta RECORD;
  v_item RECORD;
  v_mov JSONB;
  v_usuario_nome TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem cancelar compras.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe um motivo válido (mínimo 5 caracteres) para o cancelamento.');
  END IF;

  SELECT * INTO v_compra
  FROM public.compras
  WHERE id = p_compra_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PURCHASE_NOT_FOUND', 'error', 'Compra não encontrada.');
  END IF;

  IF v_compra.status = 'cancelada' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'compra_id', v_compra.id, 'status', 'cancelada');
  END IF;

  -- Verifica conta a pagar vinculada
  SELECT * INTO v_conta
  FROM public.contas_pagar
  WHERE compra_id = v_compra.id
  FOR UPDATE;

  IF FOUND AND v_conta.valor_pago > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PURCHASE_ALREADY_PAID',
      'error', 'Não é possível cancelar diretamente uma compra que já possui pagamentos efetuados ao fornecedor.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  -- Se a compra já havia sido recebida, estorna a entrada de cada insumo
  IF v_compra.status = 'recebida' THEN
    FOR v_item IN
      SELECT * FROM public.compra_itens
      WHERE compra_id = v_compra.id
      ORDER BY ingrediente_id ASC
    LOOP
      v_mov := public._aplicar_movimento_ingrediente(
        p_ingrediente_id => v_item.ingrediente_id,
        p_tipo => 'estorno_compra',
        p_quantidade => v_item.quantidade,
        p_custo_unitario => v_item.custo_unitario_efetivo,
        p_motivo => format('Estorno por cancelamento da Compra #%s: %s', v_compra.id, btrim(p_motivo)),
        p_compra_id => v_compra.id,
        p_pedido_id => NULL,
        p_usuario_id => auth.uid(),
        p_usuario_nome => COALESCE(v_usuario_nome, 'Administrador'),
        p_idempotency_key => format('est_compra_%s_ing_%s', v_compra.id, v_item.ingrediente_id)
      );

      IF NOT COALESCE((v_mov->>'success')::BOOLEAN, false) THEN
        RETURN v_mov;
      END IF;
    END LOOP;
  END IF;

  -- Cancela conta a pagar vinculada (se existir)
  IF v_conta.id IS NOT NULL THEN
    UPDATE public.contas_pagar
    SET
      status = 'cancelada',
      saldo_aberto = 0.00,
      observacoes = COALESCE(observacoes || ' | ', '') || 'Cancelada: ' || btrim(p_motivo),
      updated_at = NOW()
    WHERE id = v_conta.id;
  END IF;

  UPDATE public.compras
  SET
    status = 'cancelada',
    motivo_cancelamento = btrim(p_motivo),
    cancelado_por = auth.uid(),
    updated_at = NOW()
  WHERE id = v_compra.id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'compra_id', v_compra.id,
    'status', 'cancelada'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.cancelar_compra(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_compra(BIGINT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPCs: PERDA DE INSUMO (OPERADOR/ADMIN) & AJUSTE MANUAL (ADMIN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_perda_insumo(
  p_ingrediente_id BIGINT,
  p_quantidade NUMERIC,
  p_motivo TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_usuario_nome TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas a equipe autorizada pode registrar perda de insumos.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe o motivo da perda (mínimo 5 caracteres).');
  END IF;

  SELECT COALESCE(nome, email, 'Equipe') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN public._aplicar_movimento_ingrediente(
    p_ingrediente_id => p_ingrediente_id,
    p_tipo => 'perda',
    p_quantidade => p_quantidade,
    p_custo_unitario => NULL,
    p_motivo => 'Perda operacional: ' || btrim(p_motivo),
    p_compra_id => NULL,
    p_pedido_id => NULL,
    p_usuario_id => auth.uid(),
    p_usuario_nome => COALESCE(v_usuario_nome, 'Equipe'),
    p_idempotency_key => p_idempotency_key
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_perda_insumo(BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_perda_insumo(BIGINT, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ajustar_estoque_insumo_admin(
  p_ingrediente_id BIGINT,
  p_tipo TEXT,
  p_quantidade NUMERIC,
  p_motivo TEXT,
  p_custo_unitario NUMERIC DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_usuario_nome TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem realizar ajustes de inventário de insumos.');
  END IF;

  IF p_tipo NOT IN ('ajuste_entrada', 'ajuste_saida') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_ADJUSTMENT_TYPE', 'error', 'O tipo de ajuste deve ser ajuste_entrada ou ajuste_saida.');
  END IF;

  IF p_motivo IS NULL OR char_length(btrim(p_motivo)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe um motivo auditável (mínimo 5 caracteres).');
  END IF;

  SELECT COALESCE(nome, email, 'Administrador') INTO v_usuario_nome
  FROM public.profiles
  WHERE id = auth.uid();

  RETURN public._aplicar_movimento_ingrediente(
    p_ingrediente_id => p_ingrediente_id,
    p_tipo => p_tipo,
    p_quantidade => p_quantidade,
    p_custo_unitario => p_custo_unitario,
    p_motivo => 'Ajuste de inventário: ' || btrim(p_motivo),
    p_compra_id => NULL,
    p_pedido_id => NULL,
    p_usuario_id => auth.uid(),
    p_usuario_nome => COALESCE(v_usuario_nome, 'Administrador'),
    p_idempotency_key => p_idempotency_key
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_estoque_insumo_admin(BIGINT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_estoque_insumo_admin(BIGINT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. RPC: REGISTRAR_PAGAMENTO_FORNECEDOR (PARCIAL/TOTAL + LANÇAMENTO DRE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_pagamento_fornecedor(
  p_conta_id BIGINT,
  p_valor NUMERIC,
  p_forma_pagamento TEXT DEFAULT 'pix',
  p_observacoes TEXT DEFAULT NULL,
  p_evento_idempotencia TEXT DEFAULT 'pagamento_1'
)
RETURNS JSONB AS $$
DECLARE
  v_conta RECORD;
  v_lanc_existente RECORD;
  v_novo_pago NUMERIC(12,2);
  v_novo_saldo NUMERIC(12,2);
  v_novo_status TEXT;
  v_evento TEXT := COALESCE(NULLIF(btrim(p_evento_idempotencia), ''), 'pagamento_1');
  v_lanc_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem liquidar contas a pagar.');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PAYMENT_AMOUNT', 'error', 'O valor do pagamento deve ser maior que zero.');
  END IF;

  SELECT * INTO v_conta
  FROM public.contas_pagar
  WHERE id = p_conta_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PAYABLE_NOT_FOUND', 'error', 'Conta a pagar não encontrada.');
  END IF;

  -- Idempotência via financeiro_lancamentos (origem_tipo = 'conta_pagar', origem_id = p_conta_id, evento = v_evento)
  SELECT * INTO v_lanc_existente
  FROM public.financeiro_lancamentos
  WHERE origem_tipo = 'conta_pagar'
    AND origem_id = p_conta_id
    AND evento = v_evento;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'conta_id', v_conta.id,
      'status', v_conta.status,
      'valor_pago', v_conta.valor_pago,
      'saldo_aberto', v_conta.saldo_aberto,
      'lancamento_id', v_lanc_existente.id
    );
  END IF;

  IF v_conta.status = 'cancelada' THEN
    RETURN jsonb_build_object('success', false, 'code', 'PAYABLE_CANCELLED', 'error', 'Não é possível pagar uma conta cancelada.');
  END IF;

  IF v_conta.status = 'paga' OR v_conta.saldo_aberto <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ALREADY_PAID', 'error', 'Esta conta a pagar já está integralmente quitada.');
  END IF;

  IF ROUND(p_valor, 2) > ROUND(v_conta.saldo_aberto, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OVERPAYMENT_NOT_ALLOWED',
      'error', format('Valor do pagamento (R$ %s) excede o saldo em aberto (R$ %s).', ROUND(p_valor, 2), v_conta.saldo_aberto)
    );
  END IF;

  v_novo_pago := ROUND(v_conta.valor_pago + p_valor, 2);
  v_novo_saldo := ROUND(v_conta.valor_total - v_novo_pago, 2);
  v_novo_status := CASE WHEN v_novo_saldo <= 0 THEN 'paga' ELSE 'parcial' END;

  UPDATE public.contas_pagar
  SET
    valor_pago = v_novo_pago,
    saldo_aberto = v_novo_saldo,
    status = v_novo_status,
    data_quitacao = CASE WHEN v_novo_status = 'paga' THEN NOW() ELSE data_quitacao END,
    observacoes = CASE WHEN p_observacoes IS NOT NULL AND btrim(p_observacoes) <> '' THEN COALESCE(observacoes || ' | ', '') || btrim(p_observacoes) ELSE observacoes END,
    updated_at = NOW()
  WHERE id = v_conta.id;

  -- Lança saída de caixa no DRE (financeiro_lancamentos)
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    observacoes,
    origem_tipo,
    origem_id,
    evento
  ) VALUES (
    'despesa',
    'Insumos',
    v_conta.descricao,
    ROUND(p_valor, 2),
    CURRENT_DATE,
    COALESCE(NULLIF(btrim(p_forma_pagamento), ''), 'pix'),
    COALESCE(p_observacoes, 'Pagamento de fornecedor via Frente G'),
    'conta_pagar',
    v_conta.id,
    v_evento
  )
  RETURNING id INTO v_lanc_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'conta_id', v_conta.id,
    'status', v_novo_status,
    'valor_pago', v_novo_pago,
    'saldo_aberto', v_novo_saldo,
    'lancamento_id', v_lanc_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_pagamento_fornecedor(BIGINT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pagamento_fornecedor(BIGINT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. RPC: OBTER_NECESSIDADE_REPOSICAO (ESTOQUE MÍNIMO + CONSUMO PREVISTO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_necessidade_reposicao(
  p_dias_horizonte INT DEFAULT 7
)
RETURNS JSONB AS $$
DECLARE
  v_horizonte INT := GREATEST(1, LEAST(COALESCE(p_dias_horizonte, 7), 90));
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_fim DATE := v_hoje + v_horizonte;
  v_itens JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas a equipe autorizada pode consultar a necessidade de reposição.');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.precisa_repor DESC, t.sugestao_compra DESC, t.nome ASC), '[]'::jsonb)
  INTO v_itens
  FROM (
    SELECT
      i.id AS ingrediente_id,
      i.nome,
      i.unidade,
      COALESCE(s.saldo_atual, i.estoque_qtd, 0.000) AS saldo_atual,
      COALESCE(i.estoque_minimo, 0.000) AS estoque_minimo,
      COALESCE(dem.consumo_previsto, 0.000) AS consumo_previsto,
      GREATEST(0.000, ROUND(COALESCE(i.estoque_minimo, 0.000) - COALESCE(s.saldo_atual, i.estoque_qtd, 0.000), 3)) AS deficit_minimo,
      GREATEST(0.000, ROUND((COALESCE(i.estoque_minimo, 0.000) + COALESCE(dem.consumo_previsto, 0.000)) - COALESCE(s.saldo_atual, i.estoque_qtd, 0.000), 3)) AS sugestao_compra,
      COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0.0000) AS custo_medio_ponderado,
      ROUND(
        GREATEST(0.000, (COALESCE(i.estoque_minimo, 0.000) + COALESCE(dem.consumo_previsto, 0.000)) - COALESCE(s.saldo_atual, i.estoque_qtd, 0.000))
        * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0.0000),
        2
      ) AS custo_estimado_reposicao,
      (
        COALESCE(s.saldo_atual, i.estoque_qtd, 0.000) < (COALESCE(i.estoque_minimo, 0.000) + COALESCE(dem.consumo_previsto, 0.000))
        AND (COALESCE(i.estoque_minimo, 0.000) > 0 OR COALESCE(dem.consumo_previsto, 0.000) > 0)
      ) AS precisa_repor
    FROM public.ingredientes i
    LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
    LEFT JOIN (
      -- Consumo previsto pelos pedidos confirmados com entrega no horizonte e ainda não concluídos/cancelados
      SELECT
        pi_ficha.ingrediente_id,
        ROUND(SUM(pi_ficha.quantidade * p_item.quantidade), 3) AS consumo_previsto
      FROM public.pedidos p
      JOIN public.pedido_itens p_item ON p_item.pedido_id = p.id
      JOIN public.produto_ingredientes pi_ficha ON pi_ficha.produto_id = p_item.produto_id
      WHERE p.status_comercial = 'confirmado'
        AND p.status_operacional IN ('aguardando_producao', 'em_producao')
        AND p.data_entrega BETWEEN v_hoje AND v_fim
      GROUP BY pi_ficha.ingrediente_id
    ) dem ON dem.ingrediente_id = i.id
    WHERE i.ativo = true
  ) t;

  RETURN jsonb_build_object(
    'success', true,
    'horizonte_dias', v_horizonte,
    'data_inicio', v_hoje,
    'data_fim', v_fim,
    'itens', v_itens
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_necessidade_reposicao(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_necessidade_reposicao(INT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. RPC: OBTER_CMV_REAL_PRODUTO (CUSTO TEÓRICO VS CUSTO MÉDIO REAL)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_cmv_real_produto(
  p_produto_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_produtos JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar o CMV real e margens.');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.produto_nome), '[]'::jsonb)
  INTO v_produtos
  FROM (
    SELECT
      p.id AS produto_id,
      p.nome AS produto_nome,
      p.preco AS preco_venda,
      p.ativo,
      COUNT(pi.id) AS total_ingredientes,
      COALESCE(ROUND(SUM(pi.quantidade * i.custo_unitario), 2), 0.00) AS custo_teorico_receita,
      COALESCE(ROUND(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 2), 0.00) AS cmv_real,
      CASE
        WHEN p.preco > 0 THEN ROUND(((p.preco - COALESCE(SUM(pi.quantidade * i.custo_unitario), 0)) / p.preco) * 100.0, 2)
        ELSE 0.00
      END AS margem_teorica_pct,
      CASE
        WHEN p.preco > 0 THEN ROUND(((p.preco - COALESCE(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 0)) / p.preco) * 100.0, 2)
        ELSE 0.00
      END AS margem_real_pct,
      ROUND(p.preco - COALESCE(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 0), 2) AS lucro_bruto_real
    FROM public.produtos p
    LEFT JOIN public.produto_ingredientes pi ON pi.produto_id = p.id
    LEFT JOIN public.ingredientes i ON i.id = pi.ingrediente_id AND i.ativo = true
    LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
    WHERE p_produto_id IS NULL OR p.id = p_produto_id
    GROUP BY p.id, p.nome, p.preco, p.ativo
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'produtos', v_produtos
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_cmv_real_produto(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_cmv_real_produto(BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. ATUALIZAÇÃO DE DAR_BAIXA_INGREDIENTES_PEDIDO PARA USAR O LIVRO-RAZÃO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dar_baixa_ingredientes_pedido(p_pedido_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_rec RECORD;
  v_saldo_disp NUMERIC(12,3);
  v_qtd_baixar NUMERIC(12,3);
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN;
  END IF;

  -- 1. Caminho canônico: pedido_itens x produto_ingredientes
  IF EXISTS (SELECT 1 FROM public.pedido_itens WHERE pedido_id = p_pedido_id) THEN
    FOR v_rec IN
      SELECT
        pi.ingrediente_id,
        ROUND(SUM(pi.quantidade * item.quantidade), 3) AS qtd_total
      FROM public.pedido_itens item
      JOIN public.produto_ingredientes pi ON pi.produto_id = item.produto_id
      JOIN public.ingredientes i ON i.id = pi.ingrediente_id AND i.ativo = true
      WHERE item.pedido_id = p_pedido_id
      GROUP BY pi.ingrediente_id
      ORDER BY pi.ingrediente_id ASC
    LOOP
      SELECT COALESCE(saldo_atual, 0) INTO v_saldo_disp
      FROM public.ingrediente_saldos
      WHERE ingrediente_id = v_rec.ingrediente_id;

      v_qtd_baixar := LEAST(COALESCE(v_saldo_disp, 0), v_rec.qtd_total);
      IF v_qtd_baixar > 0 THEN
        PERFORM public._aplicar_movimento_ingrediente(
          p_ingrediente_id => v_rec.ingrediente_id,
          p_tipo => 'consumo_producao',
          p_quantidade => v_qtd_baixar,
          p_custo_unitario => NULL,
          p_motivo => format('Consumo produtivo automático - Pedido #%s', p_pedido_id),
          p_compra_id => NULL,
          p_pedido_id => p_pedido_id,
          p_usuario_id => NULL,
          p_usuario_nome => 'Sistema / Produção',
          p_idempotency_key => format('consumo_ped_%s_ing_%s', p_pedido_id, v_rec.ingrediente_id)
        );
      END IF;
    END LOOP;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role;

