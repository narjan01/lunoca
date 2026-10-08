-- ==========================================================================
-- LUNOCA DOCERIA - MIGRAÇÃO 005: FICHA TÉCNICA, CMV E CONTROLE DE INSUMOS
-- ==========================================================================
-- Esta migração implementa a gestão de matérias-primas e custos para a confeitaria:
-- 1. Tabela 'ingredientes' (insumos, estoque em g/ml/un e custo unitário)
-- 2. Tabela 'produto_ingredientes' (composição da receita por produto)
-- 3. View 'view_produto_cmv' (cálculo em tempo real de CMV, Lucro Bruto e Margem)
-- 4. Função 'dar_baixa_ingredientes_pedido' (baixa atômica de insumos na confirmação)
-- 5. Atualização da RPC 'confirmar_pagamento_pedido' para acionar baixa de insumos
-- 6. Políticas estritas de Row Level Security (RLS)
-- ==========================================================================

-- 1. TABELA DE INGREDIENTES / MATÉRIAS-PRIMAS
CREATE TABLE IF NOT EXISTS public.ingredientes (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  unidade VARCHAR(10) NOT NULL DEFAULT 'g' CHECK (unidade IN ('g', 'kg', 'ml', 'l', 'un')),
  custo_unitario NUMERIC(10,4) NOT NULL DEFAULT 0.0000,
  estoque_qtd NUMERIC(10,3) NOT NULL DEFAULT 0.000,
  estoque_minimo NUMERIC(10,3) NOT NULL DEFAULT 0.000,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. TABELA DE FICHA TÉCNICA (PRODUTO x INGREDIENTES)
CREATE TABLE IF NOT EXISTS public.produto_ingredientes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE CASCADE,
  quantidade NUMERIC(10,3) NOT NULL CHECK (quantidade > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_produto_ingrediente UNIQUE (produto_id, ingrediente_id)
);

CREATE INDEX IF NOT EXISTS idx_produto_ingredientes_prod ON public.produto_ingredientes(produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_ingredientes_ing ON public.produto_ingredientes(ingrediente_id);

-- 3. VIEW ANALÍTICA DE CMV E MARGEM BRUTA
CREATE OR REPLACE VIEW public.view_produto_cmv AS
SELECT 
  p.id AS produto_id,
  p.nome AS produto_nome,
  p.preco AS preco_venda,
  p.ativo,
  COALESCE(SUM(pi.quantidade * i.custo_unitario), 0)::NUMERIC(10,2) AS cmv_estimado,
  CASE 
    WHEN p.preco > 0 THEN 
      ROUND(((p.preco - COALESCE(SUM(pi.quantidade * i.custo_unitario), 0)) / p.preco * 100), 2)
    ELSE 0 
  END AS margem_bruta_pct,
  CASE 
    WHEN p.preco > 0 THEN 
      (p.preco - COALESCE(SUM(pi.quantidade * i.custo_unitario), 0))::NUMERIC(10,2)
    ELSE 0 
  END AS lucro_bruto_unitario,
  COUNT(pi.id) AS total_ingredientes
FROM public.produtos p
LEFT JOIN public.produto_ingredientes pi ON pi.produto_id = p.id
LEFT JOIN public.ingredientes i ON i.id = pi.ingrediente_id AND i.ativo = true
GROUP BY p.id, p.nome, p.preco, p.ativo;

-- 4. FUNÇÃO PARA BAIXA ATÔMICA DE INSUMOS AO CONFIRMAR PEDIDO
CREATE OR REPLACE FUNCTION public.dar_baixa_ingredientes_pedido(p_pedido_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd_prod NUMERIC;
  v_ficha RECORD;
BEGIN
  SELECT itens_json INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id;
  IF NOT FOUND OR v_pedido.itens_json IS NULL OR jsonb_typeof(v_pedido.itens_json) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd_prod := GREATEST(1, COALESCE((v_item->>'quantidade')::NUMERIC, 1));

    IF v_prod_id IS NOT NULL THEN
      -- Deduz cada ingrediente associado ao produto na ficha técnica
      FOR v_ficha IN 
        SELECT pi.ingrediente_id, pi.quantidade AS qtd_insumo
        FROM public.produto_ingredientes pi
        JOIN public.ingredientes i ON i.id = pi.ingrediente_id
        WHERE pi.produto_id = v_prod_id AND i.ativo = true
      LOOP
        UPDATE public.ingredientes
        SET 
          estoque_qtd = GREATEST(0, estoque_qtd - (v_ficha.qtd_insumo * v_qtd_prod)),
          updated_at = NOW()
        WHERE id = v_ficha.ingrediente_id;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

-- 5. ATUALIZAÇÃO DA RPC CONFIRMAR_PAGAMENTO_PEDIDO (COM BAIXA DE INSUMOS INTEGRADA)
DROP FUNCTION IF EXISTS public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pedido(
  p_pedido_id BIGINT,
  p_mercado_pago_payment_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'approved',
  p_forma_pagamento TEXT DEFAULT NULL,
  p_valor NUMERIC DEFAULT NULL,
  p_origem TEXT DEFAULT 'webhook'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- 5.1. Valida existência de registro no livro-caixa de idempotência
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (SELECT 1 FROM public.pagamentos_processados WHERE provider_id = p_mercado_pago_payment_id) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente (idempotência)',
        'pedido_id', p_pedido_id
      );
    END IF;
  END IF;

  -- 5.2. Bloqueia o pedido com SELECT FOR UPDATE
  SELECT *
  INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- 5.3. Se já confirmado anteriormente, impede duplo processamento
  IF v_pedido.status IN ('Confirmado', 'Em Preparo', 'Pronto', 'Entregue') OR v_pedido.status_pagamento = 'pago' THEN
    IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
      INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
      VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
      ON CONFLICT (provider_id) DO NOTHING;
    END IF;

    RETURN json_build_object(
      'success', true,
      'message', 'Pedido já estava confirmado anteriormente',
      'pedido_id', p_pedido_id,
      'status', v_pedido.status
    );
  END IF;

  -- 5.4. Atualiza status do pedido para Confirmado / Pago
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    status_pagamento = 'pago',
    status_producao = CASE WHEN status_producao IS NULL OR status_producao = 'cancelado' THEN 'recebido' ELSE status_producao END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 5.5. Baixa física e liberação da reserva no estoque de produtos
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
            'Venda confirmada - Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 5.6. Baixa atômica de insumos da receita (Ficha Técnica)
  PERFORM public.dar_baixa_ingredientes_pedido(p_pedido_id);

  -- 5.7. Registro de transação financeira
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    pedido_id,
    observacoes
  ) VALUES (
    'receita',
    'Vendas',
    'Recebimento Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
    COALESCE(p_valor, v_pedido.total),
    CURRENT_DATE,
    COALESCE(p_forma_pagamento, v_pedido.pagamento),
    p_pedido_id,
    'Confirmado via ' || COALESCE(p_mercado_pago_payment_id, 'manual') || ' (' || COALESCE(p_origem, 'Sistema') || ')'
  );

  -- 5.8. Registro de Idempotência
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
    VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
    ON CONFLICT (provider_id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'success', true,
    'message', 'Pagamento confirmado, estoque baixado e insumos descontados com sucesso!',
    'pedido_id', p_pedido_id
  );
END;
$$;

-- 6. PERMISSÕES E ROW LEVEL SECURITY (RLS)
REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role, authenticated;

ALTER TABLE public.ingredientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_ingredientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Equipe visualiza ingredientes" ON public.ingredientes;
CREATE POLICY "Equipe visualiza ingredientes" ON public.ingredientes
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam ingredientes" ON public.ingredientes;
CREATE POLICY "Admins gerenciam ingredientes" ON public.ingredientes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe visualiza produto_ingredientes" ON public.produto_ingredientes;
CREATE POLICY "Equipe visualiza produto_ingredientes" ON public.produto_ingredientes
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam produto_ingredientes" ON public.produto_ingredientes;
CREATE POLICY "Admins gerenciam produto_ingredientes" ON public.produto_ingredientes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingredientes TO service_role, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.produto_ingredientes TO service_role, authenticated;
GRANT SELECT ON public.view_produto_cmv TO service_role, authenticated;

-- 7. SEEDS DE INGREDIENTES ESSENCIAIS DA LUNOCA
INSERT INTO public.ingredientes (nome, unidade, custo_unitario, estoque_qtd, estoque_minimo)
VALUES 
  ('Leite Condensado Moça', 'g', 0.0175, 5000.000, 1000.000),       -- R$ 6,90 / 395g
  ('Chocolate Nobre Meio Amargo', 'g', 0.0550, 4000.000, 800.000),  -- R$ 55,00 / 1kg
  ('Creme de Leite Nestlé', 'g', 0.0160, 3000.000, 600.000),        -- R$ 3,20 / 200g
  ('Manteiga Extra sem Sal', 'g', 0.0450, 2000.000, 400.000),       -- R$ 9,00 / 200g
  ('Farinha de Trigo Especial', 'g', 0.0050, 10000.000, 2000.000),  -- R$ 5,00 / 1kg
  ('Açúcar Refinado União', 'g', 0.0045, 10000.000, 2000.000),      -- R$ 4,50 / 1kg
  ('Cacau em Pó 100%', 'g', 0.0480, 2500.000, 500.000),             -- R$ 48,00 / 1kg
  ('Embalagem Individual Padrão', 'un', 1.2000, 200.000, 30.000),
  ('Caixa Kraft para Presente', 'un', 3.5000, 100.000, 15.000)
ON CONFLICT DO NOTHING;
