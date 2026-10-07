-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 002: PAGAMENTOS ATÔMICOS E IDEMPOTÊNCIA (FASE 2)
-- Transação atômica única com locks FOR UPDATE, proteção contra duplo processamento
-- e registro estrito no financeiro e estoque.
-- ==========================================================================

-- 1. Tabela de Pagamentos Processados para Idempotência Distribuída
CREATE TABLE IF NOT EXISTS public.pagamentos_processados (
  provider_id TEXT PRIMARY KEY,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  provider TEXT DEFAULT 'mercadopago',
  forma TEXT,
  valor DECIMAL(10,2),
  processado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_proc_pedido ON public.pagamentos_processados(pedido_id);

-- 2. Índice único parcial para evitar duplicidade de mercado_pago_id em pedidos
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_mercado_pago_id_unique 
  ON public.pedidos(mercado_pago_id) 
  WHERE mercado_pago_id IS NOT NULL;

-- 3. Função RPC Atômica e Idempotente de Confirmação de Pagamento
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pedido(
  p_pedido_id BIGINT,
  p_mercado_pago_payment_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'approved',
  p_forma_pagamento TEXT DEFAULT NULL,
  p_valor NUMERIC DEFAULT NULL,
  p_origem TEXT DEFAULT 'webhook'
)
RETURNS JSON AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_novo_saldo INTEGER;
  v_ja_processado BOOLEAN := false;
BEGIN
  -- 3.1. Validação de parâmetros
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- 3.2. Idempotência por Provider ID (se informado)
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.pagamentos_processados
      WHERE provider_id = p_mercado_pago_payment_id
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente (idempotência confirmada).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 3.3. Bloqueio pessimista por linha do pedido (SELECT FOR UPDATE)
  SELECT * INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- 3.4. Se o pedido já estiver confirmado ou em produção, não duplica efeitos colaterais
  IF v_pedido.status IN ('Confirmado', 'Em Preparo', 'Pronto', 'Entregue') THEN
    -- Apenas garante o registro de idempotência caso ainda não conste
    IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
      INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
      VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
      ON CONFLICT (provider_id) DO NOTHING;
    END IF;

    RETURN json_build_object(
      'success', true,
      'message', 'Pedido já estava previamente confirmado no sistema.',
      'pedido_id', p_pedido_id,
      'status', v_pedido.status
    );
  END IF;

  -- 3.5. Atualiza o status do pedido para Confirmado com timestamp
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 3.6. Baixa atômica de estoque com bloqueio por linha em cada produto (SELECT FOR UPDATE)
  IF v_pedido.itens_json IS NOT NULL AND jsonb_typeof(v_pedido.itens_json) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
    LOOP
      v_prod_id := (v_item->>'id')::BIGINT;
      v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

      IF v_prod_id IS NOT NULL THEN
        SELECT id, nome, estoque_qtd, controlar_estoque
        INTO v_prod
        FROM public.produtos
        WHERE id = v_prod_id
        FOR UPDATE;

        IF FOUND AND (v_prod.controlar_estoque IS NOT FALSE) THEN
          v_novo_saldo := GREATEST(0, COALESCE(v_prod.estoque_qtd, 0) - v_qtd);

          UPDATE public.produtos
          SET 
            estoque_qtd = v_novo_saldo,
            updated_at = NOW()
          WHERE id = v_prod_id;

          -- Registrar movimentação de estoque
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
            v_novo_saldo,
            'Venda confirmada no Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 3.7. Registra receita no financeiro com proteção estrita contra duplicidade
  IF NOT EXISTS (
    SELECT 1 FROM public.financeiro_lancamentos 
    WHERE pedido_id = p_pedido_id AND tipo = 'receita'
  ) THEN
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
      'Venda do Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
      v_pedido.total,
      CURRENT_DATE,
      COALESCE(p_forma_pagamento, v_pedido.pagamento, 'pix'),
      p_pedido_id,
      'Confirmação via ' || COALESCE(p_origem, 'Mercado Pago') || 
        CASE 
          WHEN p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' 
          THEN ' [ID: ' || p_mercado_pago_payment_id || ']' 
          ELSE '' 
        END
    );
  END IF;

  -- 3.8. Grava registro na tabela de pagamentos processados (idempotência)
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    INSERT INTO public.pagamentos_processados (
      provider_id,
      pedido_id,
      forma,
      valor
    ) VALUES (
      p_mercado_pago_payment_id,
      p_pedido_id,
      COALESCE(p_forma_pagamento, v_pedido.pagamento),
      COALESCE(p_valor, v_pedido.total)
    )
    ON CONFLICT (provider_id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status', 'Confirmado'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 4. Permissões estritas: Apenas service_role pode executar
REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;
