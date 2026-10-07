-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 003: ESTOQUE E INTEGRIDADE TRANSACIONAL (FASE 3)
-- Arquitetura de reserva com separação entre estoque físico, reservado e disponível.
-- Prevenção rigorosa de overselling (SELECT FOR UPDATE) e expiração automática de PIX.
-- ==========================================================================

-- 1. ADIÇÃO DE COLUNAS DE CONTROLE NA TABELA PRODUTOS
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_fisico INTEGER DEFAULT 0;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_reservado INTEGER DEFAULT 0;

-- Sincronizar dados iniciais existentes (garante que estoque_fisico recebe estoque_qtd)
UPDATE public.produtos
SET 
  estoque_fisico = COALESCE(estoque_qtd, 0),
  estoque_reservado = 0
WHERE estoque_fisico IS NULL OR (estoque_fisico = 0 AND estoque_qtd > 0);

-- Trigger para manter estoque_qtd sempre sincronizado como (estoque_fisico - estoque_reservado)
CREATE OR REPLACE FUNCTION public.sincronizar_estoque_produto()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o operador/admin alterou estoque_qtd diretamente via painel, atualizamos o estoque_fisico
  IF TG_OP = 'UPDATE' AND NEW.estoque_qtd IS DISTINCT FROM OLD.estoque_qtd AND NEW.estoque_fisico = OLD.estoque_fisico THEN
    NEW.estoque_fisico := GREATEST(0, NEW.estoque_qtd + COALESCE(NEW.estoque_reservado, 0));
  END IF;

  -- Garante que estoque_reservado nunca seja negativo
  NEW.estoque_reservado := GREATEST(0, COALESCE(NEW.estoque_reservado, 0));
  NEW.estoque_fisico := GREATEST(0, COALESCE(NEW.estoque_fisico, 0));

  -- estoque_qtd reflete sempre a quantidade disponível para venda
  NEW.estoque_qtd := GREATEST(0, NEW.estoque_fisico - NEW.estoque_reservado);
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trigger_sincronizar_estoque_produto ON public.produtos;
CREATE TRIGGER trigger_sincronizar_estoque_produto
BEFORE INSERT OR UPDATE ON public.produtos
FOR EACH ROW EXECUTE FUNCTION public.sincronizar_estoque_produto();

-- 2. ADIÇÃO DE COLUNAS DE CICLO DE VIDA NA TABELA PEDIDOS
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_pagamento TEXT DEFAULT 'aguardando_pagamento';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_producao TEXT DEFAULT 'recebido';

-- Índices para buscas rápidas de expiração e status
CREATE INDEX IF NOT EXISTS idx_pedidos_expires_at ON public.pedidos(expires_at) WHERE status = 'Pendente';
CREATE INDEX IF NOT EXISTS idx_pedidos_status_pagamento ON public.pedidos(status_pagamento);
CREATE INDEX IF NOT EXISTS idx_pedidos_status_producao ON public.pedidos(status_producao);

-- 3. RPC: CRIAR PEDIDO COM RESERVA ATÔMICA E SELECT FOR UPDATE (SEM OVERSELLING)
CREATE OR REPLACE FUNCTION public.criar_pedido(
  p_itens JSONB,
  p_data_entrega DATE,
  p_pagamento TEXT,
  p_endereco_entrega TEXT,
  p_telefone_cliente TEXT,
  p_nome_cliente TEXT
)
RETURNS JSON AS $$
DECLARE
  v_cliente_id UUID := auth.uid();
  v_user_profile RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_disponivel INTEGER;
  v_total DECIMAL(10,2) := 0;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_pedido_id BIGINT;
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- 3.1. Valida autenticação do cliente
  IF v_cliente_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Você precisa estar logado para realizar um pedido.');
  END IF;

  SELECT * INTO v_user_profile
  FROM public.profiles
  WHERE id = v_cliente_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Sua conta de usuário está inativa ou não foi encontrada.');
  END IF;

  -- 3.2. Validação dos itens
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Sua sacola está vazia.');
  END IF;

  -- 3.3. Tolerância de pagamento: 30 minutos para PIX/Checkout
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 3.4. Loop com bloqueio pessimista (FOR UPDATE) e reserva de estoque
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    IF v_prod_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Item inválido na sacola.');
    END IF;

    -- Bloqueio pessimista por linha do produto
    SELECT id, nome, preco, ativo, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id
    FOR UPDATE;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'O produto "' || COALESCE(v_item->>'nome', 'item') || '" não está mais disponível.');
    END IF;

    -- Verifica disponibilidade real (Físico - Reservado)
    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      IF v_disponivel < v_qtd THEN
        RETURN json_build_object(
          'success', false,
          'error', 'Estoque esgotado ou insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;

      -- Reserva o estoque atômica e temporariamente
      UPDATE public.produtos
      SET 
        estoque_reservado = estoque_reservado + v_qtd,
        updated_at = NOW()
      WHERE id = v_prod_id;

      -- Registra movimentação de reserva
      INSERT INTO public.estoque_movimentacoes (
        produto_id,
        produto_nome,
        tipo,
        quantidade,
        saldo_resultante,
        motivo,
        usuario_nome
      ) VALUES (
        v_prod.id,
        v_prod.nome,
        'reserva',
        v_qtd,
        v_disponivel - v_qtd,
        'Reserva temporária para novo pedido (tolerância 30 min)',
        'Sistema / Reserva'
      );
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 3.5. Grava o pedido com status de pagamento e expiração
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    total,
    pagamento,
    status,
    status_pagamento,
    status_producao,
    expires_at,
    itens,
    itens_json,
    endereco_entrega
  ) VALUES (
    v_cliente_id,
    COALESCE(NULLIF(trim(p_nome_cliente), ''), v_user_profile.nome),
    v_user_profile.email,
    COALESCE(NULLIF(trim(p_telefone_cliente), ''), v_user_profile.telefone),
    CURRENT_DATE,
    p_data_entrega,
    v_total,
    p_pagamento,
    'Pendente',
    'aguardando_pagamento',
    'recebido',
    v_expires_at,
    array_to_string(v_nomes_itens, ' + '),
    p_itens,
    p_endereco_entrega
  ) RETURNING id INTO v_pedido_id;

  -- Vincula o ID do pedido nas movimentações de reserva geradas nesta transação
  UPDATE public.estoque_movimentacoes
  SET pedido_id = v_pedido_id
  WHERE pedido_id IS NULL AND tipo = 'reserva' AND created_at >= NOW() - INTERVAL '5 seconds';

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 4. ATUALIZAÇÃO DA RPC CONFIRMAR_PAGAMENTO_PEDIDO (CONVERSÃO DE RESERVA EM VENDA FÍSICA)
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
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- 4.1. Idempotência por Provider ID
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

  -- 4.2. Busca o pedido com bloqueio pessimista por linha (SELECT FOR UPDATE)
  SELECT * INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- 4.3. Se já confirmado anteriormente, impede duplo processamento
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

  -- 4.4. Atualiza status do pedido para Confirmado / Pago
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    status_pagamento = 'pago',
    status_producao = CASE WHEN status_producao IS NULL OR status_producao = 'cancelado' THEN 'recebido' ELSE status_producao END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 4.5. Baixa física e liberação da reserva no estoque (SELECT FOR UPDATE)
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
            GREATEST(0, v_prod.estoque_fisico - v_qtd - GREATEST(0, v_prod.estoque_reservado - v_qtd)),
            'Venda confirmada no Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 4.6. Registra receita no financeiro com proteção estrita contra duplicidade
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

  -- 4.7. Grava registro na tabela de pagamentos processados (idempotência)
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

REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- 5. RPC: LIBERAÇÃO DE ESTOQUE DE PEDIDOS EXPIRADOS (CLEANUP AUTOMÁTICO)
CREATE OR REPLACE FUNCTION public.liberar_pedidos_expirados()
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_total_cancelados INTEGER := 0;
BEGIN
  -- Busca pedidos pendentes que ultrapassaram o tempo limite (expires_at)
  FOR v_ped IN (
    SELECT * FROM public.pedidos
    WHERE status = 'Pendente'
      AND status_pagamento = 'aguardando_pagamento'
      AND (
        expires_at < NOW()
        OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '30 minutes')
      )
    FOR UPDATE SKIP LOCKED
  ) LOOP
    -- Atualiza pedido para Cancelado / Expirado
    UPDATE public.pedidos
    SET 
      status = 'Cancelado',
      status_pagamento = 'expirado',
      status_producao = 'cancelado',
      updated_at = NOW()
    WHERE id = v_ped.id;

    -- Devolve a reserva de estoque para cada item
    IF v_ped.itens_json IS NOT NULL AND jsonb_typeof(v_ped.itens_json) = 'array' THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_ped.itens_json)
      LOOP
        v_prod_id := (v_item->>'id')::BIGINT;
        v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

        IF v_prod_id IS NOT NULL THEN
          UPDATE public.produtos
          SET 
            estoque_reservado = GREATEST(0, estoque_reservado - v_qtd),
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
            v_prod_id,
            COALESCE(v_item->>'nome', 'Produto'),
            'ajuste',
            v_qtd,
            0,
            'Devolução de reserva por expiração de PIX do Pedido #' || v_ped.id,
            v_ped.id,
            'Sistema / Expiração Automática'
          );
        END IF;
      END LOOP;
    END IF;

    v_total_cancelados := v_total_cancelados + 1;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'pedidos_cancelados', v_total_cancelados,
    'executado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.liberar_pedidos_expirados() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.liberar_pedidos_expirados() TO service_role;
