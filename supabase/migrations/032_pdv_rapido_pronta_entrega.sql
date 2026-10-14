-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 032: PDV RÁPIDO & ESTOQUE DE PRONTA ENTREGA (FRENTE Q)
-- ==============================================================================
-- Conecta a vitrine física de balcão ao ecossistema canônico da doceria:
-- 1. Produção de Pronta Entrega: transforma matéria-prima em lote de produto pronto,
--    baixando ingredientes com FEFO atômico e calculando custo unitário snapshot server-side.
-- 2. Venda Rápida de Balcão (PDV):
--    - Consome produto pronto por FEFO com FOR UPDATE (bloqueia vencidos e reprovados).
--    - Cria o pedido canônico em public.pedidos com canal_venda = 'pdv'.
--    - Suporta consumidor avulso sem persistir dados fictícios (nome, email, telefone NULL).
--    - Suporta cliente identificado integrando CRM, crédito e fidelidade da Frente I.
--    - Executa o ciclo canônico de status sem contornar portas de domínio.
--    - Quita via motor canônico registrar_pagamento_pedido sem duplicar livro financeiro.
--    - Livros-razão estritamente append-only (SQLSTATE 42501).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXTENSÕES FORWARD-ONLY EM PUBLIC.PEDIDOS
-- ------------------------------------------------------------------------------
-- Permite que consumidor avulso não identificado tenha nome/email/telefone NULL
-- em vez de persistir identificadores artificiais ou dados espúrios no banco.
ALTER TABLE public.pedidos ALTER COLUMN nome_cliente DROP NOT NULL;
ALTER TABLE public.pedidos ALTER COLUMN email_cliente DROP NOT NULL;
ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_pagamento_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_pagamento_check CHECK (pagamento IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro'));

-- ------------------------------------------------------------------------------
-- 2. TABELA PUBLIC.PRODUTO_PRONTO_LOTES (ESTOQUE DE PRODUTO ACABADO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_pronto_lotes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  codigo_lote TEXT NOT NULL UNIQUE CHECK (char_length(btrim(codigo_lote)) >= 2),
  quantidade_inicial NUMERIC(10,2) NOT NULL CHECK (quantidade_inicial > 0),
  quantidade_disponivel NUMERIC(10,2) NOT NULL CHECK (quantidade_disponivel >= 0 AND quantidade_disponivel <= quantidade_inicial),
  data_producao DATE NOT NULL DEFAULT (now() AT TIME ZONE 'America/Fortaleza')::date,
  data_validade DATE NOT NULL,
  bloqueado_qualidade BOOLEAN NOT NULL DEFAULT false,
  motivo_bloqueio TEXT,
  bloqueado_em TIMESTAMPTZ,
  bloqueado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  custo_unitario_producao NUMERIC(10,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_producao >= 0),
  registrado_por_auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  colaborador_responsavel_id BIGINT REFERENCES public.colaboradores(id) ON DELETE SET NULL,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pp_lote_datas CHECK (data_validade >= data_producao)
);

CREATE INDEX IF NOT EXISTS idx_pp_lotes_produto_fefo
  ON public.produto_pronto_lotes (produto_id, data_validade ASC, id ASC)
  WHERE bloqueado_qualidade = false AND quantidade_disponivel > 0;

CREATE INDEX IF NOT EXISTS idx_pp_lotes_codigo ON public.produto_pronto_lotes (codigo_lote);

-- ------------------------------------------------------------------------------
-- 3. TABELA PUBLIC.PRODUTO_PRONTO_MOVIMENTACOES (LIVRO-RAZÃO APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_pronto_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  lote_id BIGINT NOT NULL REFERENCES public.produto_pronto_lotes(id) ON DELETE RESTRICT,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  tipo_movimentacao TEXT NOT NULL CHECK (tipo_movimentacao IN ('ENTRADA_PRODUCAO', 'VENDA_PDV', 'PERDA_AVARIA', 'VENCIMENTO', 'AJUSTE_BALANCO')),
  quantidade NUMERIC(10,2) NOT NULL CHECK (quantidade > 0),
  direcao TEXT NOT NULL CHECK (direcao IN ('ENTRADA', 'SAIDA')),
  quantidade_anterior NUMERIC(10,2) NOT NULL CHECK (quantidade_anterior >= 0),
  quantidade_posterior NUMERIC(10,2) NOT NULL CHECK (quantidade_posterior >= 0),
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  justificativa TEXT,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT 'Sistema',
  idempotency_key TEXT UNIQUE,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_mov_lote ON public.produto_pronto_movimentacoes (lote_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_pp_mov_produto ON public.produto_pronto_movimentacoes (produto_id, registrado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pp_mov_pedido ON public.produto_pronto_movimentacoes (pedido_id) WHERE pedido_id IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 4. TABELA PUBLIC.PRODUTO_PRONTO_LOTE_CONSUMOS_INGREDIENTE (TRANSFORMAÇÃO MP -> PT)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_pronto_lote_consumos_ingrediente (
  id BIGSERIAL PRIMARY KEY,
  produto_pronto_lote_id BIGINT NOT NULL REFERENCES public.produto_pronto_lotes(id) ON DELETE RESTRICT,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE RESTRICT,
  ingrediente_lote_id BIGINT NOT NULL REFERENCES public.ingrediente_lotes(id) ON DELETE RESTRICT,
  ingrediente_lote_mov_id BIGINT REFERENCES public.ingrediente_lote_movimentacoes(id) ON DELETE SET NULL,
  quantidade_consumida NUMERIC(12,3) NOT NULL CHECK (quantidade_consumida > 0),
  custo_unitario_snapshot NUMERIC(12,4) NOT NULL CHECK (custo_unitario_snapshot >= 0),
  consumido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_lote_consumos_pp_lote ON public.produto_pronto_lote_consumos_ingrediente (produto_pronto_lote_id);
CREATE INDEX IF NOT EXISTS idx_pp_lote_consumos_ing_lote ON public.produto_pronto_lote_consumos_ingrediente (ingrediente_lote_id);

-- ------------------------------------------------------------------------------
-- 5. TABELA PUBLIC.PEDIDO_CONSUMOS_PRODUTO_PRONTO (RASTREABILIDADE PEDIDO -> LOTE PT)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_consumos_produto_pronto (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  lote_id BIGINT NOT NULL REFERENCES public.produto_pronto_lotes(id) ON DELETE RESTRICT,
  quantidade NUMERIC(10,2) NOT NULL CHECK (quantidade > 0),
  preco_unitario_venda NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (preco_unitario_venda >= 0),
  custo_unitario_snapshot NUMERIC(10,4) NOT NULL DEFAULT 0.0000 CHECK (custo_unitario_snapshot >= 0),
  consumido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ped_consumos_pp_pedido ON public.pedido_consumos_produto_pronto (pedido_id);
CREATE INDEX IF NOT EXISTS idx_ped_consumos_pp_lote ON public.pedido_consumos_produto_pronto (lote_id);

-- ------------------------------------------------------------------------------
-- 6. TRIGGERS DE SEGURANÇA E IMUTABILIDADE APPEND-ONLY (SQLSTATE 42501)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_produto_pronto_mov()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PRODUTO_PRONTO_MOV_APPEND_ONLY: Registros do livro-razão de produto pronto são estritamente imutáveis.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_pp_movimentacoes ON public.produto_pronto_movimentacoes;
CREATE TRIGGER trg_bloquear_mutacao_pp_movimentacoes
  BEFORE UPDATE OR DELETE ON public.produto_pronto_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_produto_pronto_mov();

CREATE OR REPLACE FUNCTION public._bloquear_mutacao_consumo_pp()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CONSUMO_PRODUTO_PRONTO_APPEND_ONLY: Registros de consumo de produto pronto são estritamente imutáveis.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_consumo_pp ON public.pedido_consumos_produto_pronto;
CREATE TRIGGER trg_bloquear_mutacao_consumo_pp
  BEFORE UPDATE OR DELETE ON public.pedido_consumos_produto_pronto
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_consumo_pp();

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_pp_consumos_ingrediente ON public.produto_pronto_lote_consumos_ingrediente;
CREATE TRIGGER trg_bloquear_mutacao_pp_consumos_ingrediente
  BEFORE UPDATE OR DELETE ON public.produto_pronto_lote_consumos_ingrediente
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_consumo_pp();

-- ------------------------------------------------------------------------------
-- 7. RPC: REGISTRAR PRODUÇÃO DE PRODUTO PRONTO (TRANSFORMAÇÃO MATÉRIA-PRIMA -> PRODUTO ACABADO)
-- ------------------------------------------------------------------------------
-- Q3: Produção pronta baixa ingredientes com FEFO atômico
-- Q16: Reconciliação integral MP + PT + Ledgers
CREATE OR REPLACE FUNCTION public.registrar_producao_produto_pronto(
  p_produto_id BIGINT,
  p_quantidade_produzida NUMERIC,
  p_data_validade DATE,
  p_codigo_lote TEXT DEFAULT NULL,
  p_colaborador_id BIGINT DEFAULT NULL,
  p_data_producao DATE DEFAULT NULL,
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_prod RECORD;
  v_data_op DATE;
  v_codigo TEXT;
  v_lote_id BIGINT;
  v_usuario_nome TEXT;
  v_custo_total_insumos NUMERIC(14,4) := 0.0000;
  v_custo_unit_snapshot NUMERIC(10,4) := 0.0000;
  v_rec RECORD;
  v_ing RECORD;
  v_nec_qtd NUMERIC(12,3);
  v_restante NUMERIC(12,3);
  v_lote_mp RECORD;
  v_consumir NUMERIC(12,3);
  v_mov_id BIGINT;
  v_mov_agg JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas equipe de produção ou administradores podem registrar produtos prontos.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_quantidade_produzida IS NULL OR p_quantidade_produzida <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantidade produzida deve ser maior que zero.', 'code', 'INVALID_QUANTITY');
  END IF;

  -- Data operacional canônica da Lunoca
  v_data_op := COALESCE(p_data_producao, (NOW() AT TIME ZONE 'America/Fortaleza')::date);

  IF p_data_validade IS NULL OR p_data_validade < v_data_op THEN
    RETURN jsonb_build_object('success', false, 'error', 'Data de validade deve ser igual ou posterior à data de produção.', 'code', 'INVALID_EXPIRATION_DATE');
  END IF;

  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Produto não encontrado no catálogo.', 'code', 'PRODUCT_NOT_FOUND');
  END IF;

  SELECT COALESCE(nome, 'Operador') INTO v_usuario_nome FROM public.profiles WHERE id = v_caller_id;

  -- Gerar código do lote se não informado
  IF p_codigo_lote IS NOT NULL AND char_length(btrim(p_codigo_lote)) >= 2 THEN
    v_codigo := upper(btrim(p_codigo_lote));
  ELSE
    v_codigo := 'PT-' || to_char(v_data_op, 'YYMMDD') || '-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 4));
  END IF;

  -- 1. Baixa FEFO dos ingredientes cadastrados na ficha técnica (produto_ingredientes)
  FOR v_rec IN
    SELECT pi.ingrediente_id, pi.quantidade AS qtd_unitaria, i.nome AS ingrediente_nome, i.unidade
    FROM public.produto_ingredientes pi
    JOIN public.ingredientes i ON i.id = pi.ingrediente_id
    WHERE pi.produto_id = p_produto_id
  LOOP
    v_nec_qtd := ROUND(v_rec.qtd_unitaria * p_quantidade_produzida, 3);
    v_restante := v_nec_qtd;

    -- Verificar se o saldo agregado do ingrediente é suficiente
    SELECT saldo_atual INTO v_consumir FROM public.ingrediente_saldos WHERE ingrediente_id = v_rec.ingrediente_id;
    IF COALESCE(v_consumir, 0) < v_nec_qtd THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Estoque insuficiente de ingrediente para produzir o lote: ' || v_rec.ingrediente_nome || ' (necessário ' || v_nec_qtd || ' ' || v_rec.unidade || ', disponível ' || COALESCE(v_consumir, 0) || ').',
        'code', 'INSUFFICIENT_INGREDIENT_STOCK'
      );
    END IF;
  END LOOP;

  -- 2. Cria o lote de produto acabado (inicialmente custo 0 para atualizar após baixa dos ingredientes)
  INSERT INTO public.produto_pronto_lotes (
    produto_id,
    codigo_lote,
    quantidade_inicial,
    quantidade_disponivel,
    data_producao,
    data_validade,
    custo_unitario_producao,
    registrado_por_auth_user_id,
    colaborador_responsavel_id,
    observacoes
  ) VALUES (
    p_produto_id,
    v_codigo,
    p_quantidade_produzida,
    p_quantidade_produzida,
    v_data_op,
    p_data_validade,
    0.0000,
    v_caller_id,
    p_colaborador_id,
    p_observacoes
  ) RETURNING id INTO v_lote_id;

  -- 3. Execução efetiva do consumo FEFO de cada ingrediente
  PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
  PERFORM set_config('lunoca.lote_already_synced', 'true', true);

  FOR v_rec IN
    SELECT pi.ingrediente_id, pi.quantidade AS qtd_unitaria, i.nome AS ingrediente_nome, i.unidade
    FROM public.produto_ingredientes pi
    JOIN public.ingredientes i ON i.id = pi.ingrediente_id
    WHERE pi.produto_id = p_produto_id
  LOOP
    v_nec_qtd := ROUND(v_rec.qtd_unitaria * p_quantidade_produzida, 3);
    v_restante := v_nec_qtd;

    FOR v_lote_mp IN
      SELECT *
      FROM public.ingrediente_lotes l
      WHERE l.ingrediente_id = v_rec.ingrediente_id
        AND l.quantidade_atual > 0
        AND l.bloqueado_qualidade = false
        AND (l.data_validade IS NULL OR l.data_validade >= v_data_op)
      ORDER BY l.data_validade ASC NULLS LAST, l.data_recebimento ASC, l.id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_restante <= 0;

      v_consumir := LEAST(v_lote_mp.quantidade_atual, v_restante);

      UPDATE public.ingrediente_lotes
      SET quantidade_atual = ROUND(quantidade_atual - v_consumir, 3),
          updated_at = NOW()
      WHERE id = v_lote_mp.id;

      INSERT INTO public.ingrediente_lote_movimentacoes (
        lote_id,
        ingrediente_id,
        tipo_evento,
        quantidade,
        saldo_lote_anterior,
        saldo_lote_posterior,
        custo_unitario_aplicado,
        motivo,
        usuario_id,
        usuario_nome,
        idempotency_key
      ) VALUES (
        v_lote_mp.id,
        v_rec.ingrediente_id,
        'CONSUMO_PRODUCAO',
        v_consumir,
        v_lote_mp.quantidade_atual,
        ROUND(v_lote_mp.quantidade_atual - v_consumir, 3),
        v_lote_mp.custo_unitario_lote,
        format('Consumo FEFO para Produção de Pronta Entrega - Lote PT #%s (%s)', v_lote_id, v_codigo),
        v_caller_id,
        COALESCE(v_usuario_nome, 'Equipe Produção'),
        'pt:' || v_lote_id::text || ':ing:' || v_rec.ingrediente_id::text || ':lote:' || v_lote_mp.id::text
      ) RETURNING id INTO v_mov_id;

      -- Rastreabilidade da transformação MP -> PT
      INSERT INTO public.produto_pronto_lote_consumos_ingrediente (
        produto_pronto_lote_id,
        ingrediente_id,
        ingrediente_lote_id,
        ingrediente_lote_mov_id,
        quantidade_consumida,
        custo_unitario_snapshot
      ) VALUES (
        v_lote_id,
        v_rec.ingrediente_id,
        v_lote_mp.id,
        v_mov_id,
        v_consumir,
        v_lote_mp.custo_unitario_lote
      );

      v_custo_total_insumos := v_custo_total_insumos + (v_consumir * v_lote_mp.custo_unitario_lote);
      v_restante := ROUND(v_restante - v_consumir, 3);
    END LOOP;

    -- Baixa consolidada em ingrediente_saldos
    v_mov_agg := public._aplicar_movimento_ingrediente(
      p_ingrediente_id => v_rec.ingrediente_id,
      p_tipo => 'consumo_producao',
      p_quantidade => v_nec_qtd,
      p_custo_unitario => NULL,
      p_motivo => format('Consumo para lote de produto pronto PT #%s (%s)', v_lote_id, v_codigo),
      p_compra_id => NULL,
      p_pedido_id => NULL,
      p_usuario_id => v_caller_id,
      p_usuario_nome => COALESCE(v_usuario_nome, 'Equipe Produção'),
      p_idempotency_key => 'pt:' || v_lote_id::text || ':agg:ing:' || v_rec.ingrediente_id::text
    );
  END LOOP;

  PERFORM set_config('lunoca.lote_already_synced', '', true);
  PERFORM set_config('lunoca.allow_lote_mutation', '', true);

  -- 4. Atualizar o custo unitário real calculado server-side
  IF p_quantidade_produzida > 0 AND v_custo_total_insumos > 0 THEN
    v_custo_unit_snapshot := ROUND(v_custo_total_insumos / p_quantidade_produzida, 4);
    UPDATE public.produto_pronto_lotes
    SET custo_unitario_producao = v_custo_unit_snapshot
    WHERE id = v_lote_id;
  END IF;

  -- 5. Registrar movimento no livro-razão de produto pronto
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
    usuario_nome,
    idempotency_key
  ) VALUES (
    v_lote_id,
    p_produto_id,
    'ENTRADA_PRODUCAO',
    p_quantidade_produzida,
    'ENTRADA',
    0.00,
    p_quantidade_produzida,
    'Produção finalizada de pronta entrega / vitrine',
    v_caller_id,
    COALESCE(v_usuario_nome, 'Equipe Produção'),
    'pt:lote:entrada:' || v_lote_id::text
  );

  -- 6. Manter sincronizado produtos.estoque_fisico se controlar_estoque = true
  IF v_prod.controlar_estoque THEN
    UPDATE public.produtos
    SET estoque_fisico = COALESCE(estoque_fisico, 0) + p_quantidade_produzida
    WHERE id = p_produto_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'lote_id', v_lote_id,
    'codigo_lote', v_codigo,
    'produto_id', p_produto_id,
    'produto_nome', v_prod.nome,
    'quantidade_produzida', p_quantidade_produzida,
    'data_validade', p_data_validade,
    'custo_unitario_producao', v_custo_unit_snapshot
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 8. RPC: LISTAR CATÁLOGO PDV (DISPONIBILIDADE REAL DE PRONTA ENTREGA)
-- ------------------------------------------------------------------------------
-- Q3: Exibe apenas produtos com disponibilidade real
-- Q5: Ignora lotes vencidos
-- Q6: Ignora lotes bloqueados por qualidade
CREATE OR REPLACE FUNCTION public.listar_catalogo_pdv()
RETURNS JSONB AS $$
DECLARE
  v_data_op DATE;
  v_catalogo JSONB;
BEGIN
  v_data_op := (NOW() AT TIME ZONE 'America/Fortaleza')::date;

  SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.nome ASC), '[]'::jsonb)
  INTO v_catalogo
  FROM (
    SELECT
      p.id AS produto_id,
      p.nome,
      p.descricao,
      p.preco,
      p.img_url,
      p.controlar_estoque,
      COALESCE(SUM(l.quantidade_disponivel), 0.00) AS estoque_pronto_disponivel,
      MIN(l.data_validade) AS proximo_vencimento,
      COUNT(l.id) AS total_lotes_ativos
    FROM public.produtos p
    LEFT JOIN public.produto_pronto_lotes l
      ON l.produto_id = p.id
     AND l.quantidade_disponivel > 0
     AND l.bloqueado_qualidade = false
     AND l.data_validade >= v_data_op
    WHERE p.ativo = true
    GROUP BY p.id, p.nome, p.descricao, p.preco, p.img_url, p.controlar_estoque
  ) item;

  RETURN jsonb_build_object(
    'success', true,
    'data_operacional', v_data_op,
    'produtos', v_catalogo
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 9. RPC: OBTER ESTOQUE DE PRODUTO PRONTO (ADMIN & OPERADOR COM SANITIZAÇÃO)
-- ------------------------------------------------------------------------------
-- Q15: Operador não vê custo industrial de produção
CREATE OR REPLACE FUNCTION public.obter_estoque_produto_pronto_admin(
  p_produto_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_is_admin BOOLEAN;
  v_lotes JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_is_admin := public.is_admin();

  SELECT COALESCE(jsonb_agg(r ORDER BY r.data_validade ASC, r.id ASC), '[]'::jsonb)
  INTO v_lotes
  FROM (
    SELECT
      l.id,
      l.produto_id,
      p.nome AS produto_nome,
      l.codigo_lote,
      l.quantidade_inicial,
      l.quantidade_disponivel,
      l.data_producao,
      l.data_validade,
      l.bloqueado_qualidade,
      l.motivo_bloqueio,
      CASE WHEN v_is_admin THEN l.custo_unitario_producao ELSE NULL END AS custo_unitario_producao,
      c.nome AS colaborador_nome,
      l.observacoes,
      l.created_at
    FROM public.produto_pronto_lotes l
    JOIN public.produtos p ON p.id = l.produto_id
    LEFT JOIN public.colaboradores c ON c.id = l.colaborador_responsavel_id
    WHERE (p_produto_id IS NULL OR l.produto_id = p_produto_id)
      AND l.quantidade_disponivel > 0
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'lotes', v_lotes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 10. RPC: REGISTRAR PERDA DE PRODUTO PRONTO (VENCIMENTO / AVARIA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_perda_produto_pronto(
  p_lote_id BIGINT,
  p_quantidade NUMERIC,
  p_tipo_perda TEXT,
  p_justificativa TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_lote RECORD;
  v_tipo TEXT;
  v_user_nome TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantidade deve ser maior que zero.', 'code', 'INVALID_QUANTITY');
  END IF;

  v_tipo := upper(btrim(COALESCE(p_tipo_perda, 'PERDA_AVARIA')));
  IF v_tipo NOT IN ('PERDA_AVARIA', 'VENCIMENTO', 'AJUSTE_BALANCO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de perda inválido.', 'code', 'INVALID_LOSS_TYPE');
  END IF;

  IF p_justificativa IS NULL OR char_length(btrim(p_justificativa)) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Justificativa obrigatória.', 'code', 'JUSTIFICATION_REQUIRED');
  END IF;

  SELECT * INTO v_lote
  FROM public.produto_pronto_lotes
  WHERE id = p_lote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lote não encontrado.', 'code', 'LOT_NOT_FOUND');
  END IF;

  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Quantidade informada (' || p_quantidade || ') excede o disponível no lote (' || v_lote.quantidade_disponivel || ').',
      'code', 'INSUFFICIENT_LOT_QUANTITY'
    );
  END IF;

  SELECT COALESCE(nome, 'Operador') INTO v_user_nome FROM public.profiles WHERE id = v_caller_id;

  UPDATE public.produto_pronto_lotes
  SET quantidade_disponivel = ROUND(quantidade_disponivel - p_quantidade, 2),
      updated_at = NOW()
  WHERE id = p_lote_id;

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
    p_lote_id,
    v_lote.produto_id,
    v_tipo,
    p_quantidade,
    'SAIDA',
    v_lote.quantidade_disponivel,
    ROUND(v_lote.quantidade_disponivel - p_quantidade, 2),
    p_justificativa,
    v_caller_id,
    COALESCE(v_user_nome, 'Equipe')
  );

  RETURN jsonb_build_object(
    'success', true,
    'lote_id', p_lote_id,
    'quantidade_baixada', p_quantidade,
    'saldo_remanescente', ROUND(v_lote.quantidade_disponivel - p_quantidade, 2)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 11. RPC: ALTERAR BLOQUEIO DE QUALIDADE DE PRODUTO PRONTO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alterar_bloqueio_qualidade_produto_pronto(
  p_lote_id BIGINT,
  p_bloquear BOOLEAN,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_lote RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  SELECT * INTO v_lote FROM public.produto_pronto_lotes WHERE id = p_lote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lote de produto pronto não encontrado.', 'code', 'LOT_NOT_FOUND');
  END IF;

  UPDATE public.produto_pronto_lotes
  SET bloqueado_qualidade = p_bloquear,
      motivo_bloqueio = CASE WHEN p_bloquear THEN p_motivo ELSE NULL END,
      bloqueado_em = CASE WHEN p_bloquear THEN NOW() ELSE NULL END,
      bloqueado_por = CASE WHEN p_bloquear THEN v_caller_id ELSE NULL END,
      updated_at = NOW()
  WHERE id = p_lote_id;

  RETURN jsonb_build_object(
    'success', true,
    'lote_id', p_lote_id,
    'bloqueado_qualidade', p_bloquear,
    'motivo_bloqueio', p_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 12. RPC: FINALIZAR VENDA PDV (VENDA ATÔMICA SERVER-SIDE)
-- ------------------------------------------------------------------------------
-- Q1:  Cria pedido canônico
-- Q2:  Sem tabelas paralelas
-- Q4:  FEFO consome menor validade elegível
-- Q5:  Lote vencido nunca é vendido
-- Q6:  Lote bloqueado nunca é vendido
-- Q7:  Lock FOR UPDATE impede saldo negativo concorrente
-- Q8:  Idempotência total com p_chave_idempotencia
-- Q9:  Desconto respeita governança canônica
-- Q10: Reutiliza registrar_pagamento_pedido
-- Q11: Efeito financeiro previsto pelo motor canônico sem duplicidade
-- Q12: Venda termina como 'retirado' + 'concluido'
-- Q13: Cliente identificado integra CRM e fidelidade da Frente I
-- Q14: Consumidor avulso não cria cliente nem dados falsos
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
  v_metodo_norm TEXT;
  v_consumos_retorno JSONB := '[]'::jsonb;
  v_ped_existente RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem operar o PDV.', 'code', 'PERMISSION_DENIED');
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
  -- Normaliza método canônico: 'cartao', 'pix', 'dinheiro', 'transferencia', 'outro'
  v_metodo_norm := CASE
    WHEN p_forma_pagamento ILIKE '%cartao%' THEN 'cartao'
    WHEN p_forma_pagamento ILIKE '%pix%' THEN 'pix'
    WHEN p_forma_pagamento ILIKE '%dinheiro%' THEN 'dinheiro'
    WHEN p_forma_pagamento ILIKE '%transfer%' THEN 'transferencia'
    ELSE 'outro'
  END;

  -- Q14: Consumidor avulso não insere dados fictícios (nome, email, telefone ficam NULL)
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

    -- Consumo FEFO com FOR UPDATE nos lotes de produto pronto
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
        pedido_id,
        justificativa,
        usuario_id,
        usuario_nome,
        idempotency_key
      ) VALUES (
        v_lote_pt.id,
        v_item.produto_id,
        'VENDA_PDV',
        v_consumir,
        'SAIDA',
        v_lote_pt.quantidade_disponivel,
        ROUND(v_lote_pt.quantidade_disponivel - v_consumir, 2),
        v_pedido_id,
        format('Venda PDV Pedido #%s', v_pedido_id),
        v_caller_id,
        COALESCE(v_user_nome, 'Operador PDV'),
        'pdv:' || v_pedido_id::text || ':item:' || v_ped_item_id::text || ':lote:' || v_lote_pt.id::text
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

    -- Manter sincronia do estoque_fisico se o produto tiver a flag
    IF v_prod.controlar_estoque THEN
      UPDATE public.produtos
      SET estoque_fisico = GREATEST(0, COALESCE(estoque_fisico, 0) - v_item.quantidade)
      WHERE id = v_item.produto_id;
    END IF;
  END LOOP;

  -- 5. Quitação Canônica via registrar_pagamento_pedido
  -- Normaliza método canônico: 'cartao', 'pix', 'dinheiro', 'outro'
  v_metodo_norm := CASE
    WHEN p_forma_pagamento ILIKE '%cartao%' THEN 'cartao'
    WHEN p_forma_pagamento ILIKE '%pix%' THEN 'pix'
    WHEN p_forma_pagamento ILIKE '%dinheiro%' THEN 'dinheiro'
    WHEN p_forma_pagamento ILIKE '%transfer%' THEN 'transferencia'
    ELSE 'outro'
  END;

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
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    v_pedido_id,
    'operacional',
    'pronto',
    'retirado',
    v_caller_id,
    v_user_nome,
    'admin',
    jsonb_build_object('canal', 'balcao', 'retirada_imediata', true, 'origem_detalhada', 'pdv')
  );

  -- 7. Acúmulo de fidelidade gerenciado automaticamente pelo trigger canônico trg_fidelidade_pedido_status

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'numero', '#' || v_pedido_id::text,
    'subtotal', v_subtotal,
    'desconto', v_desconto_aplicado,
    'total', v_total_liquido,
    'status_operacional', 'retirado',
    'status_comercial', 'concluido',
    'status_financeiro', 'pago',
    'consumos_lotes', v_consumos_retorno
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 13. RPC: RASTREAR LOTE DE PRODUTO PRONTO (RASTREABILIDADE BIDIRECIONAL)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rastrear_lote_produto_pronto_admin(
  p_lote_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_is_admin BOOLEAN;
  v_lote RECORD;
  v_ingredientes JSONB;
  v_pedidos JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_is_admin := public.is_admin();

  SELECT l.*, p.nome AS produto_nome
  INTO v_lote
  FROM public.produto_pronto_lotes l
  JOIN public.produtos p ON p.id = l.produto_id
  WHERE l.id = p_lote_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Lote de produto pronto não encontrado.', 'code', 'LOT_NOT_FOUND');
  END IF;

  -- Ingredientes que compuseram o lote PT
  SELECT COALESCE(jsonb_agg(ci), '[]'::jsonb)
  INTO v_ingredientes
  FROM (
    SELECT
      c.ingrediente_id,
      i.nome AS ingrediente_nome,
      c.ingrediente_lote_id,
      il.codigo_lote AS codigo_lote_ingrediente,
      il.data_validade AS validade_ingrediente,
      c.quantidade_consumida,
      i.unidade,
      CASE WHEN v_is_admin THEN c.custo_unitario_snapshot ELSE NULL END AS custo_unitario_snapshot
    FROM public.produto_pronto_lote_consumos_ingrediente c
    JOIN public.ingredientes i ON i.id = c.ingrediente_id
    JOIN public.ingrediente_lotes il ON il.id = c.ingrediente_lote_id
    WHERE c.produto_pronto_lote_id = p_lote_id
  ) ci;

  -- Pedidos que consumiram este lote PT
  SELECT COALESCE(jsonb_agg(cp), '[]'::jsonb)
  INTO v_pedidos
  FROM (
    SELECT
      cpp.pedido_id,
      '#' || p.id::text AS pedido_numero,
      p.data_pedido,
      p.status_comercial,
      p.status_operacional,
      cpp.quantidade,
      cpp.consumido_em
    FROM public.pedido_consumos_produto_pronto cpp
    JOIN public.pedidos p ON p.id = cpp.pedido_id
    WHERE cpp.lote_id = p_lote_id
    ORDER BY cpp.consumido_em DESC
  ) cp;

  RETURN jsonb_build_object(
    'success', true,
    'lote', jsonb_build_object(
      'id', v_lote.id,
      'produto_id', v_lote.produto_id,
      'produto_nome', v_lote.produto_nome,
      'codigo_lote', v_lote.codigo_lote,
      'quantidade_inicial', v_lote.quantidade_inicial,
      'quantidade_disponivel', v_lote.quantidade_disponivel,
      'data_producao', v_lote.data_producao,
      'data_validade', v_lote.data_validade,
      'bloqueado_qualidade', v_lote.bloqueado_qualidade,
      'custo_unitario_producao', CASE WHEN v_is_admin THEN v_lote.custo_unitario_producao ELSE NULL END
    ),
    'ingredientes_consumidos', v_ingredientes,
    'pedidos_atendidos', v_pedidos
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 14. SEGURANÇA, RLS E GRANTS FAIL-CLOSED
-- ------------------------------------------------------------------------------
ALTER TABLE public.produto_pronto_lotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_pronto_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_pronto_lote_consumos_ingrediente ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_consumos_produto_pronto ENABLE ROW LEVEL SECURITY;

-- Revogar acessos públicos diretos
REVOKE ALL ON public.produto_pronto_lotes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produto_pronto_movimentacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produto_pronto_lote_consumos_ingrediente FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_consumos_produto_pronto FROM PUBLIC, anon, authenticated;

-- Políticas para usuários autenticados (apenas admin ou operador acessa via interface operacional)
DROP POLICY IF EXISTS pp_lotes_select ON public.produto_pronto_lotes;
CREATE POLICY pp_lotes_select ON public.produto_pronto_lotes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS pp_mov_select ON public.produto_pronto_movimentacoes;
CREATE POLICY pp_mov_select ON public.produto_pronto_movimentacoes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS pp_consumos_ing_select ON public.produto_pronto_lote_consumos_ingrediente;
CREATE POLICY pp_consumos_ing_select ON public.produto_pronto_lote_consumos_ingrediente FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS ped_consumos_pp_select ON public.pedido_consumos_produto_pronto;
CREATE POLICY ped_consumos_pp_select ON public.pedido_consumos_produto_pronto FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- Políticas Totais para service_role
DROP POLICY IF EXISTS pp_lotes_service_role ON public.produto_pronto_lotes;
CREATE POLICY pp_lotes_service_role ON public.produto_pronto_lotes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pp_mov_service_role ON public.produto_pronto_movimentacoes;
CREATE POLICY pp_mov_service_role ON public.produto_pronto_movimentacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pp_consumos_ing_service_role ON public.produto_pronto_lote_consumos_ingrediente;
CREATE POLICY pp_consumos_ing_service_role ON public.produto_pronto_lote_consumos_ingrediente FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ped_consumos_pp_service_role ON public.pedido_consumos_produto_pronto;
CREATE POLICY ped_consumos_pp_service_role ON public.pedido_consumos_produto_pronto FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grants de Execução das RPCs (fail-closed para anon e públicos)
REVOKE ALL ON FUNCTION public.registrar_producao_produto_pronto(BIGINT, NUMERIC, DATE, TEXT, BIGINT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_producao_produto_pronto(BIGINT, NUMERIC, DATE, TEXT, BIGINT, DATE, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.listar_catalogo_pdv() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_catalogo_pdv() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_estoque_produto_pronto_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_estoque_produto_pronto_admin(BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.registrar_perda_produto_pronto(BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_perda_produto_pronto(BIGINT, NUMERIC, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.alterar_bloqueio_qualidade_produto_pronto(BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_bloqueio_qualidade_produto_pronto(BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.rastrear_lote_produto_pronto_admin(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rastrear_lote_produto_pronto_admin(BIGINT) TO authenticated, service_role;
