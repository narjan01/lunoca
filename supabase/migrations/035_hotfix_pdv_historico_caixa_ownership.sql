-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 035 (FORWARD-ONLY HOTFIX)
-- ==============================================================================
-- Descrição:
-- 1. Restaura a integridade canônica de finalizar_venda_pdv mantendo o schema
--    real do banco (public.pedidos, public.pedido_itens, public.pedido_consumos_produto_pronto,
--    public.produto_pronto_movimentacoes, public.pedido_status_historico), vinculando
--    o pagamento à sessão de caixa (public.caixa_sessao_pagamentos) e exigindo
--    sessão aberta (CASH_SESSION_REQUIRED).
-- 2. Reforça a governança de ownership de sessão de caixa em registrar_movimentacao_caixa
--    e fechar_sessao_caixa (CASH_SESSION_NOT_OWNED com bloqueio FOR UPDATE).
--
-- Contrato de Imutabilidade:
-- - Migrations 001 a 034 permanecem congeladas e imutáveis.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CORREÇÃO DE OWNERSHIP EM REGISTRAR_MOVIMENTACAO_CAIXA
-- ------------------------------------------------------------------------------
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

  -- Trava da sessão com FOR UPDATE
  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = v_sessao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  -- Trava de Ownership: Apenas o operador responsável pode movimentar sua própria sessão
  IF v_sessao.operador_auth_id <> v_caller_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operação não permitida. Apenas o operador responsável pode movimentar esta sessão de caixa.',
      'code', 'CASH_SESSION_NOT_OWNED'
    );
  END IF;

  IF v_sessao.status <> 'ABERTA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'A sessão de caixa # ' || v_sessao_id || ' já está fechada.', 'code', 'SESSION_CLOSED');
  END IF;

  -- Verificação de Idempotência
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

  -- Validação de Saldo Físico para SANGRIA
  IF v_tipo = 'SANGRIA' THEN
    SELECT COALESCE(SUM(valor), 0.00) INTO v_dinheiro_recebido
    FROM public.caixa_sessao_pagamentos
    WHERE sessao_id = v_sessao_id
      AND metodo = 'dinheiro';

    SELECT COALESCE(SUM(valor), 0.00) INTO v_suprimentos
    FROM public.caixa_sessao_movimentacoes
    WHERE sessao_id = v_sessao_id
      AND tipo = 'SUPRIMENTO';

    SELECT COALESCE(SUM(valor), 0.00) INTO v_sangrias
    FROM public.caixa_sessao_movimentacoes
    WHERE sessao_id = v_sessao_id
      AND tipo = 'SANGRIA';

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
-- 2. CORREÇÃO DE OWNERSHIP EM FECHAR_SESSAO_CAIXA
-- ------------------------------------------------------------------------------
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

  -- Trava da linha para exclusão mútua concorrente com FOR UPDATE
  SELECT * INTO v_sessao
  FROM public.caixa_sessoes
  WHERE id = v_sessao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sessão de caixa não encontrada.', 'code', 'SESSION_NOT_FOUND');
  END IF;

  -- Trava de Ownership: Apenas o operador responsável pode fechar sua própria sessão
  IF v_sessao.operador_auth_id <> v_caller_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operação não permitida. Apenas o operador responsável pode fechar esta sessão de caixa.',
      'code', 'CASH_SESSION_NOT_OWNED'
    );
  END IF;

  -- Idempotência de Fechamento
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
  WHERE sessao_id = v_sessao_id AND metodo IN ('cartao', 'credito', 'debito', 'cartao_credito', 'cartao_debito');

  SELECT COALESCE(SUM(valor), 0.00) INTO v_tot_outros
  FROM public.caixa_sessao_pagamentos
  WHERE sessao_id = v_sessao_id AND metodo NOT IN ('dinheiro', 'pix', 'cartao', 'credito', 'debito', 'cartao_credito', 'cartao_debito');

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

  -- Validação de Divergência (Quebra ou Sobra)
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
-- 3. FINALIZAR_VENDA_PDV (CANÔNICO COM SESSÃO DE CAIXA E HISTÓRICO DE STATUS)
-- ------------------------------------------------------------------------------
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

  -- Exige exatamente uma sessão de caixa aberta para o operador
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

  -- Idempotência com p_chave_idempotencia
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

  -- Validação do cliente
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

  -- Governança de Desconto
  v_desconto_aplicado := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  IF v_desconto_aplicado > 0 THEN
    IF p_motivo_desconto IS NULL OR char_length(btrim(p_motivo_desconto)) < 3 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Justificativa obrigatória para aplicação de desconto no PDV.', 'code', 'DISCOUNT_REASON_REQUIRED');
    END IF;

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

    PERFORM 1
    FROM public.produto_pronto_lotes l
    WHERE l.produto_id = v_item.produto_id
      AND l.quantidade_disponivel > 0
      AND l.bloqueado_qualidade = false
      AND l.data_validade >= v_data_op
    FOR UPDATE;

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

  -- Normaliza método canônico: 'cartao', 'pix', 'dinheiro', 'transferencia', 'credito_cliente', 'outro'
  v_metodo_norm := CASE
    WHEN p_forma_pagamento ILIKE '%cartao%' THEN 'cartao'
    WHEN p_forma_pagamento ILIKE '%pix%' THEN 'pix'
    WHEN p_forma_pagamento ILIKE '%dinheiro%' THEN 'dinheiro'
    WHEN p_forma_pagamento ILIKE '%transfer%' THEN 'transferencia'
    WHEN p_forma_pagamento ILIKE '%credito_cliente%' THEN 'credito_cliente'
    ELSE 'outro'
  END;

  -- 3. Criação do Pedido Canônico
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

    v_nec_qtd := v_item.quantidade;
    v_restante := v_nec_qtd;

    FOR v_lote_pt IN
      SELECT *
      FROM public.produto_pronto_lotes
      WHERE produto_id = v_item.produto_id
        AND quantidade_disponivel > 0
        AND bloqueado_qualidade = false
        AND data_validade >= v_data_op
      ORDER BY data_validade ASC, id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_restante <= 0;

      v_consumir := LEAST(v_restante, v_lote_pt.quantidade_disponivel);

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
    COALESCE(v_user_nome, 'Operador'),
    'admin',
    jsonb_build_object(
      'canal', 'balcao',
      'retirada_imediata', true,
      'origem_detalhada', 'pdv',
      'origem_fluxo', 'pdv_pronta_entrega',
      'sessao_caixa_id', v_sessao_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'numero', '#' || v_pedido_id::text,
    'subtotal', v_subtotal,
    'desconto', v_desconto_aplicado,
    'total', v_total_liquido,
    'forma_pagamento', v_metodo_norm,
    'sessao_caixa_id', v_sessao_id,
    'status_operacional', 'retirado',
    'status_comercial', 'concluido',
    'status_financeiro', 'pago',
    'consumos_lotes', v_consumos_retorno
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 4. GRANTS FAIL-CLOSED DE SEGURANÇA
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.registrar_movimentacao_caixa(TEXT, NUMERIC, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_movimentacao_caixa(TEXT, NUMERIC, TEXT, TEXT, BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
