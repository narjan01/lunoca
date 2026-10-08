-- ==========================================================================
-- MIGRATION 008: Hardening da 5ª Auditoria de Segurança & Integridade
-- 1. Erradicação de INSERT direto em pedidos e revogação de permissões
-- 2. Normalização agregada de itens em criar_pedido (anti-hoarding & anti-overselling)
-- 3. Tabela canônica pedido_itens com snapshot oficial de preços do banco
-- 4. Gravação precisa de saldo_resultante em liberar_pedidos_expirados
-- 5. Restrição de UPDATE em pedidos e RPC alterar_status_operacional_pedido
-- 6. Lockdown estrito de RLS em pagamentos_processados
-- ==========================================================================

-- 1. Revogação de Inserção Direta na tabela pedidos (Única porta de entrada é criar_pedido)
DROP POLICY IF EXISTS "Clientes ativos criam seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Clientes ativos criam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Usuários podem criar seus próprios pedidos" ON public.pedidos;

REVOKE INSERT ON public.pedidos FROM PUBLIC, anon, authenticated;

-- 2. Tabela Canônica pedido_itens
CREATE TABLE IF NOT EXISTS public.pedido_itens (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE SET NULL,
  produto_nome_snapshot TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario_snapshot NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON public.pedido_itens(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto_id ON public.pedido_itens(produto_id);

ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_itens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_itens TO service_role;

DROP POLICY IF EXISTS "Clientes visualizam itens de seus pedidos" ON public.pedido_itens;
CREATE POLICY "Clientes visualizam itens de seus pedidos" ON public.pedido_itens
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_itens.pedido_id
        AND ((p.cliente_id = auth.uid() AND public.is_user_active()) OR public.is_admin_or_operator())
    )
  );

-- 3. Atualização da RPC criar_pedido com agregação prévia de itens e preenchimento de pedido_itens
CREATE OR REPLACE FUNCTION public.criar_pedido(
  p_itens JSONB,
  p_data_entrega DATE,
  p_pagamento TEXT,
  p_endereco_entrega TEXT,
  p_telefone_cliente TEXT,
  p_nome_cliente TEXT,
  p_taxa_entrega NUMERIC DEFAULT 0,
  p_email_cliente TEXT DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'entrega'
)
RETURNS JSON AS $$
DECLARE
  v_cliente_id UUID := auth.uid();
  v_user_profile RECORD;
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_disponivel INTEGER;
  v_total DECIMAL(10,2) := 0;
  v_taxa DECIMAL(10,2) := 0;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_itens_json_canonical JSONB := '[]'::JSONB;
  v_pedido_id BIGINT;
  v_checkout_token UUID;
  v_expires_at TIMESTAMPTZ;
  v_nome_final TEXT;
  v_email_final TEXT;
  v_telefone_final TEXT;
  v_fone_limpo TEXT;
  v_fone_normalizado TEXT;
BEGIN
  -- 1. Identificação do Cliente (Usuário Autenticado ou Visitante Convidado)
  IF v_cliente_id IS NOT NULL THEN
    SELECT * INTO v_user_profile
    FROM public.profiles
    WHERE id = v_cliente_id AND ativo = true;

    IF NOT FOUND THEN
      RETURN json_build_object('success', false, 'error', 'Sua conta de usuário está inativa ou não foi encontrada.');
    END IF;

    v_nome_final := COALESCE(NULLIF(trim(p_nome_cliente), ''), v_user_profile.nome);
    v_email_final := COALESCE(v_user_profile.email, NULLIF(trim(p_email_cliente), ''), 'cliente@lunocadoceria.com.br');
    v_telefone_final := COALESCE(NULLIF(trim(p_telefone_cliente), ''), v_user_profile.telefone);
  ELSE
    v_nome_final := trim(COALESCE(p_nome_cliente, ''));
    v_telefone_final := trim(COALESCE(p_telefone_cliente, ''));
    v_email_final := COALESCE(NULLIF(trim(p_email_cliente), ''), 'visitante@lunocadoceria.com.br');

    IF length(v_nome_final) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe seu nome completo para a encomenda.');
    END IF;

    v_fone_limpo := regexp_replace(v_telefone_final, '\D', '', 'g');
    IF length(v_fone_limpo) < 10 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe um WhatsApp válido com DDD para acompanhar o pedido.');
    END IF;

    IF length(v_fone_limpo) IN (10, 11) THEN
      v_fone_normalizado := '55' || v_fone_limpo;
    ELSE
      v_fone_normalizado := v_fone_limpo;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('guest_checkout_' || v_fone_normalizado));

    -- Rate limit estrito de no máximo 3 pedidos pendentes recentes nos últimos 15 min
    IF (
      SELECT COUNT(*)
      FROM public.pedidos
      WHERE (
        regexp_replace(COALESCE(telefone_cliente, ''), '\D', '', 'g') IN (v_fone_limpo, v_fone_normalizado)
        OR (
          p_endereco_entrega IS NOT NULL 
          AND p_endereco_entrega <> '' 
          AND lower(p_endereco_entrega) NOT LIKE '%retirada%'
          AND endereco_entrega = p_endereco_entrega
        )
      )
        AND status = 'Pendente'
        AND created_at >= (NOW() - INTERVAL '15 minutes')
    ) >= 3 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Limite de pedidos pendentes atingido para este telefone/endereço (máx. 3 nos últimos 15 min). Aguarde alguns minutos.'
      );
    END IF;
  END IF;

  -- 2. Validações de entrada
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Sua sacola está vazia.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  IF p_pagamento NOT IN ('pix', 'cartao') THEN
    RETURN json_build_object('success', false, 'error', 'Forma de pagamento inválida.');
  END IF;

  -- 3. Tolerância de pagamento de 30 minutos
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 4. ETAPA 1: Agrupamento consolidado dos itens, validação de disponibilidade e cálculo de totais
  -- O agrupamento por produto_id impede que itens duplicados contornem o estoque ou o limite anti-hoarding
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      SUM(GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)))::INTEGER AS quantidade
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    GROUP BY (it->>'id')::BIGINT
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    -- Anti-Hoarding para Visitante sobre a quantidade agregada do item
    IF v_cliente_id IS NULL AND v_qtd > 50 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Quantidade máxima por item para checkout rápido sem cadastro é de 50 unidades. Para encomendas maiores, acesse sua conta ou entre em contato.'
      );
    END IF;

    -- Bloqueio pessimista por linha do produto
    SELECT id, nome, preco, ativo, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id
    FOR UPDATE;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Um dos produtos selecionados não está mais disponível.');
    END IF;

    -- Verifica disponibilidade real sobre o total consolidado (Físico - Reservado)
    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      IF v_disponivel < v_qtd THEN
        RETURN json_build_object(
          'success', false,
          'error', 'Estoque esgotado ou insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);

    -- Constrói o item JSON saneado utilizando o preço oficial do banco de dados
    v_itens_json_canonical := v_itens_json_canonical || jsonb_build_object(
      'id', v_prod.id,
      'nome', v_prod.nome,
      'quantidade', v_qtd,
      'preco', v_prod.preco,
      'preco_unitario', v_prod.preco,
      'subtotal', (v_prod.preco * v_qtd)
    );
  END LOOP;

  -- 5. Validação e cálculo estrito da taxa de entrega no servidor
  IF LOWER(COALESCE(p_modalidade, 'entrega')) = 'retirada' THEN
    v_taxa := 0.00;
  ELSE
    v_taxa := 10.00;
  END IF;

  v_total := v_total + v_taxa;

  -- 6. ETAPA 2: Gravação do Pedido primeiro
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    total,
    taxa_entrega,
    modalidade_entrega,
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
    v_nome_final,
    v_email_final,
    v_telefone_final,
    CURRENT_DATE,
    p_data_entrega,
    v_total,
    v_taxa,
    COALESCE(p_modalidade, 'entrega'),
    p_pagamento,
    'Pendente',
    'aguardando_pagamento',
    'recebido',
    v_expires_at,
    array_to_string(v_nomes_itens, ' + '),
    v_itens_json_canonical,
    p_endereco_entrega
  ) RETURNING id, checkout_token INTO v_pedido_id, v_checkout_token;

  -- 7. ETAPA 3: Gravação na tabela canônica pedido_itens e Reserva atômica do estoque
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      SUM(GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)))::INTEGER AS quantidade
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    GROUP BY (it->>'id')::BIGINT
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    -- Inserção canônica de itens
    INSERT INTO public.pedido_itens (
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      preco_unitario_snapshot,
      subtotal
    ) VALUES (
      v_pedido_id,
      v_prod.id,
      v_prod.nome,
      v_qtd,
      v_prod.preco,
      (v_prod.preco * v_qtd)
    );

    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      UPDATE public.produtos
      SET 
        estoque_reservado = estoque_reservado + v_qtd,
        updated_at = NOW()
      WHERE id = v_prod_id;

      INSERT INTO public.estoque_movimentacoes (
        produto_id,
        produto_nome,
        tipo,
        quantidade,
        saldo_resultante,
        pedido_id,
        motivo,
        usuario_nome
      ) VALUES (
        v_prod.id,
        v_prod.nome,
        'reserva',
        v_qtd,
        v_disponivel - v_qtd,
        v_pedido_id,
        'Reserva temporária para novo pedido #' || v_pedido_id || ' (tolerância 30 min)',
        'Sistema / Reserva'
      );
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total,
    'taxa_entrega', v_taxa,
    'checkout_token', v_checkout_token,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;

-- 4. Atualização de liberar_pedidos_expirados com cálculo preciso de saldo_resultante
CREATE OR REPLACE FUNCTION public.liberar_pedidos_expirados()
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_saldo INTEGER;
  v_total_cancelados INTEGER := 0;
BEGIN
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
    UPDATE public.pedidos
    SET 
      status = 'Cancelado',
      status_pagamento = 'expirado',
      status_producao = 'cancelado',
      updated_at = NOW()
    WHERE id = v_ped.id;

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
          WHERE id = v_prod_id
          RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_saldo;

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
            COALESCE(v_saldo, 0),
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

-- 5. Restrição de UPDATE direto em pedidos e RPC segura para transições operacionais
DROP POLICY IF EXISTS "Apenas administradores ou operadores atualizam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Equipe atualiza pedidos" ON public.pedidos;

REVOKE UPDATE ON public.pedidos FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.alterar_status_operacional_pedido(
  p_pedido_id BIGINT,
  p_novo_status TEXT
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_permitido BOOLEAN := false;
  v_status_prod TEXT;
BEGIN
  -- 1. Validação de perfil (Apenas admin ou operador ativo)
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  -- 2. Busca do pedido com bloqueio pessimista
  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- 3. Validação de matriz de transição operacional
  -- Transições permitidas:
  -- Confirmado -> Em Preparo ou Cancelado
  -- Em Preparo -> Pronto ou Cancelado
  -- Pronto -> Entregue ou Cancelado
  -- Pendente -> Cancelado
  IF v_ped.status = 'Confirmado' AND p_novo_status IN ('Em Preparo', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Em Preparo' AND p_novo_status IN ('Pronto', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Pronto' AND p_novo_status IN ('Entregue', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Pendente' AND p_novo_status = 'Cancelado' THEN
    v_status_permitido := true;
  ELSIF v_ped.status = p_novo_status THEN
    RETURN json_build_object('success', true, 'message', 'Pedido já está no status solicitado.', 'status', v_ped.status);
  END IF;

  IF NOT v_status_permitido THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Transição operacional não permitida de "' || v_ped.status || '" para "' || p_novo_status || '".'
    );
  END IF;

  -- Mapeamento para status de produção
  v_status_prod := CASE 
    WHEN p_novo_status = 'Confirmado' THEN 'recebido'
    WHEN p_novo_status = 'Em Preparo' THEN 'em_preparo'
    WHEN p_novo_status = 'Pronto' THEN 'pronto'
    WHEN p_novo_status = 'Entregue' THEN 'entregue'
    WHEN p_novo_status = 'Cancelado' THEN 'cancelado'
    ELSE v_ped.status_producao
  END;

  -- 4. Atualização estrita sem tocar em dados financeiros ou de pagamento
  UPDATE public.pedidos
  SET 
    status = p_novo_status,
    status_producao = v_status_prod,
    updated_at = NOW()
  WHERE id = p_pedido_id;

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status,
    'status_novo', p_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) TO authenticated, service_role;

-- 6. Lockdown estrito de RLS em pagamentos_processados
ALTER TABLE public.pagamentos_processados ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pagamentos_processados FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pagamentos_processados TO service_role;

-- 7. Atualização de liberar_pedidos_expirados com gravação precisa de saldo_resultante
CREATE OR REPLACE FUNCTION public.liberar_pedidos_expirados()
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_saldo INTEGER;
  v_total_cancelados INTEGER := 0;
BEGIN
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
    UPDATE public.pedidos
    SET 
      status = 'Cancelado',
      status_pagamento = 'expirado',
      status_producao = 'cancelado',
      updated_at = NOW()
    WHERE id = v_ped.id;

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
          WHERE id = v_prod_id
          RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_saldo;

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
            COALESCE(v_saldo, 0),
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
    'timestamp', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.liberar_pedidos_expirados() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.liberar_pedidos_expirados() TO service_role;
