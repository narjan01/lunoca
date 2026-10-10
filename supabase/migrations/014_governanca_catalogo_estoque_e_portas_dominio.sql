-- ==============================================================================
-- MIGRATION 014: GOVERNANÇA DE CATÁLOGO, ESTOQUE ATÔMICO & PORTAS DE DOMÍNIO
-- ==============================================================================
-- 1. ESTOQUE ATÔMICO: RPC ajustar_estoque_operacao() com lock FOR UPDATE,
--    validação contra reserva e gravação atômica em estoque_movimentacoes.
-- 2. CATÁLOGO & RLS: Operador perde UPDATE/INSERT direto em produtos e produto_opcoes.
--    Trigger impede operador de desativar controlar_estoque.
-- 3. PORTAS COMERCIAIS DEDICADAS: cancelar_pedido_equipe() e
--    gerenciar_confirmacao_pedido_admin(), desacoplando o comercial de alterar_status_pedido().
-- 4. DESCONTO DINÂMICO: configuracoes_operacao.desconto_operador_percentual_max (default 10.00)
--    consumido dinamicamente por politica_desconto().
-- ==============================================================================

-- --------------------------------------------------------------------------
-- 1. CONFIGURAÇÃO DE DESCONTO DINÂMICO EM CONFIGURACOES_OPERACAO
-- --------------------------------------------------------------------------
ALTER TABLE public.configuracoes_operacao
  ADD COLUMN IF NOT EXISTS desconto_operador_percentual_max NUMERIC(5,2) NOT NULL DEFAULT 10.00;

-- Atualizar helper de leitura de configurações com fallback seguro
CREATE OR REPLACE FUNCTION public.obter_config_operacao()
RETURNS public.configuracoes_operacao AS $$
DECLARE
  v_cfg public.configuracoes_operacao;
BEGIN
  SELECT * INTO v_cfg FROM public.configuracoes_operacao WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.id := 1;
    v_cfg.sinal_percentual_padrao := 50.00;
    v_cfg.hold_horas_padrao := 24;
    v_cfg.antecedencia_confirmacao_horas := 2;
    v_cfg.hold_pix_loja_minutos := 30;
    v_cfg.capacidade_padrao_pontos := 30.00;
    v_cfg.timezone := 'America/Fortaleza';
    v_cfg.validade_orcamento_horas := 120;
    v_cfg.antecedencia_minima_orcamento_horas := 24;
    v_cfg.janela_conversao_horas := 24;
    v_cfg.taxa_entrega_padrao := 15.00;
    v_cfg.desconto_operador_percentual_max := 10.00;
  END IF;

  IF v_cfg.desconto_operador_percentual_max IS NULL THEN
    v_cfg.desconto_operador_percentual_max := 10.00;
  END IF;

  BEGIN
    PERFORM NOW() AT TIME ZONE v_cfg.timezone;
  EXCEPTION WHEN OTHERS THEN
    v_cfg.timezone := 'America/Fortaleza';
  END;

  RETURN v_cfg;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- Atualizar politica_desconto() para consumir o teto da configuração dinamicamente
CREATE OR REPLACE FUNCTION public.politica_desconto(
  p_subtotal NUMERIC,
  p_desconto NUMERIC,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_teto_operador NUMERIC(5,2) := COALESCE(v_cfg.desconto_operador_percentual_max, 10.00);
  v_subtotal NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_subtotal, 0.00));
  v_desc NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  v_pct NUMERIC(6,2) := 0.00;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode aplicar descontos.');
  END IF;

  IF v_desc <= 0.00 THEN
    RETURN jsonb_build_object(
      'success', true,
      'desconto_aprovado', 0.00,
      'percentual', 0.00,
      'excecao_admin', false,
      'motivo', NULL
    );
  END IF;

  IF v_subtotal <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_SUBTOTAL', 'error', 'Subtotal dos produtos inválido para cálculo de desconto.');
  END IF;

  IF v_desc > v_subtotal THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_EXCEEDS_SUBTOTAL', 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  v_pct := ROUND((v_desc / v_subtotal) * 100.0, 2);

  -- Teto de operador dinâmico derivado de configuracoes_operacao
  IF v_pct > v_teto_operador AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED',
      'teto_operador_percentual', v_teto_operador,
      'teto_operador_valor', ROUND(v_subtotal * (v_teto_operador / 100.0), 2),
      'error', 'Operadores podem conceder no máximo ' || v_teto_operador || '% de desconto (R$ ' || (ROUND(v_subtotal * (v_teto_operador / 100.0), 2))::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  -- Justificativa auditável obrigatória para QUALQUER desconto > 0 (D3)
  IF v_desc > 0.00 AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_REASON_REQUIRED', 'error', 'Por favor, informe a justificativa do desconto concedido (mínimo 5 caracteres).');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'desconto_aprovado', v_desc,
    'percentual', v_pct,
    'excecao_admin', (v_pct > v_teto_operador),
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_desconto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_desconto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 2. ESTOQUE ATÔMICO: RPC AJUSTAR_ESTOQUE_OPERACAO()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ajustar_estoque_operacao(
  p_produto_id BIGINT,
  p_tipo TEXT,
  p_quantidade INT DEFAULT NULL,
  p_novo_saldo_fisico INT DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
  v_delta INT := 0;
  v_fisico_antigo INT;
  v_fisico_novo INT;
  v_reservado INT;
  v_qtd_novo INT;
  v_mov_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode ajustar estoque.');
  END IF;

  IF p_produto_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_ID_REQUIRED', 'error', 'ID do produto é obrigatório.');
  END IF;

  IF p_tipo NOT IN ('entrada', 'saida', 'perda', 'contagem') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_OPERATION_TYPE', 'error', 'Tipo de operação inválido. Use entrada, saida, perda ou contagem.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 1. Trava a linha do produto no banco
  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_NOT_FOUND', 'error', 'Produto não encontrado.');
  END IF;

  v_fisico_antigo := COALESCE(v_prod.estoque_fisico, 0);
  v_reservado := COALESCE(v_prod.estoque_reservado, 0);

  -- 2. Determinar novo saldo físico
  IF p_tipo = 'entrada' THEN
    IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'Quantidade de entrada deve ser maior que zero.');
    END IF;
    v_delta := p_quantidade;
    v_fisico_novo := v_fisico_antigo + v_delta;

  ELSIF p_tipo IN ('saida', 'perda') THEN
    IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'Quantidade deve ser maior que zero.');
    END IF;
    v_delta := p_quantidade;
    v_fisico_novo := v_fisico_antigo - v_delta;

  ELSIF p_tipo = 'contagem' THEN
    IF p_novo_saldo_fisico IS NULL OR p_novo_saldo_fisico < 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_COUNT_BALANCE', 'error', 'Saldo da contagem deve ser informado e não negativo.');
    END IF;
    v_fisico_novo := p_novo_saldo_fisico;
    v_delta := ABS(v_fisico_novo - v_fisico_antigo);
  END IF;

  -- 3. Invariante: estoque_fisico nunca pode ficar menor que estoque_reservado
  IF v_fisico_novo < v_reservado THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'RESERVED_STOCK_CONFLICT',
      'estoque_fisico_tentado', v_fisico_novo,
      'estoque_reservado', v_reservado,
      'error', 'Ajuste rejeitado: o novo saldo físico (' || v_fisico_novo || ') não pode ser menor que o estoque reservado ativo (' || v_reservado || ').'
    );
  END IF;

  v_qtd_novo := v_fisico_novo - v_reservado;

  -- 4. Sinalizar mutação interna controlada para o trigger de proteção
  PERFORM set_config('lunoca.internal_stock_mutation', 'on', true);

  UPDATE public.produtos
  SET 
    estoque_fisico = v_fisico_novo,
    estoque_qtd = v_qtd_novo,
    updated_at = NOW()
  WHERE id = p_produto_id;

  -- 5. Gravar movimentação de estoque na mesma transação atômica
  INSERT INTO public.estoque_movimentacoes (
    produto_id,
    produto_nome,
    tipo,
    quantidade,
    saldo_resultante,
    motivo,
    usuario_nome,
    created_at
  ) VALUES (
    p_produto_id,
    v_prod.nome,
    CASE WHEN p_tipo = 'contagem' THEN 'ajuste' ELSE p_tipo END,
    v_delta,
    v_fisico_novo,
    COALESCE(v_motivo, CASE 
      WHEN p_tipo = 'entrada' THEN 'Entrada manual de estoque'
      WHEN p_tipo = 'saida' THEN 'Saída manual de estoque'
      WHEN p_tipo = 'perda' THEN 'Perda de estoque registrada'
      WHEN p_tipo = 'contagem' THEN 'Ajuste de inventário / contagem'
    END),
    v_user_nome,
    NOW()
  ) RETURNING id INTO v_mov_id;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'produto_nome', v_prod.nome,
    'tipo', p_tipo,
    'delta', v_delta,
    'estoque_fisico_anterior', v_fisico_antigo,
    'estoque_fisico_novo', v_fisico_novo,
    'estoque_reservado', v_reservado,
    'estoque_qtd_novo', v_qtd_novo,
    'movimentacao_id', v_mov_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_estoque_operacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_estoque_operacao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. REFORÇO DE TRIGGER & RLS DE PRODUTOS E PRODUTO_OPCOES
-- --------------------------------------------------------------------------
-- Trigger trg_proteger_estoque_produtos: impede operador de desativar controlar_estoque
CREATE OR REPLACE FUNCTION public.fn_proteger_estoque_produtos()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Mutação de estoque_reservado é estritamente restrita a helpers internos e service_role
  IF NEW.estoque_reservado IS DISTINCT FROM OLD.estoque_reservado THEN
    IF current_setting('lunoca.internal_stock_mutation', true) IS DISTINCT FROM 'on' AND auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Modificação direta de estoque_reservado não é permitida. Use os fluxos de reserva/liberação.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Mutação de estoque_fisico requer Administrador, service_role ou helper interno
  IF NEW.estoque_fisico IS DISTINCT FROM OLD.estoque_fisico THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role' OR current_setting('lunoca.internal_stock_mutation', true) = 'on') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o saldo de estoque físico do produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 3. Alternar controlar_estoque requer privilégio de Administrador
  IF NEW.controlar_estoque IS DISTINCT FROM OLD.controlar_estoque THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o controle de estoque de um produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- RLS Fechado: Operador perde UPDATE direto em produtos e produto_opcoes
-- Modificações de dados de catálogo (nome, preço, descrição) são exclusivas de Administradores
DROP POLICY IF EXISTS "Operadores e admins atualizam produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins atualizam produtos" ON public.produtos;
CREATE POLICY "Apenas admins atualizam produtos" 
  ON public.produtos FOR UPDATE 
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Operadores e admins inserem produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins inserem produtos" ON public.produtos;
CREATE POLICY "Apenas admins inserem produtos" 
  ON public.produtos FOR INSERT 
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe gerencia opções de produtos" ON public.produto_opcoes;
DROP POLICY IF EXISTS "Apenas admins gerenciam opções de produtos" ON public.produto_opcoes;
CREATE POLICY "Apenas admins gerenciam opções de produtos" 
  ON public.produto_opcoes FOR ALL 
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- --------------------------------------------------------------------------
-- 4. PORTAS COMERCIAIS DEDICADAS
-- --------------------------------------------------------------------------

-- 4.1 CANCELAMENTO COMERCIAL E OPERACIONAL DEDICADO
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

  -- Idempotência: se já está cancelado comercial e operacionalmente
  IF v_ped.status_comercial = 'cancelado' AND v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'status_comercial', 'cancelado',
      'status_operacional', 'cancelado'
    );
  END IF;

  -- Guarda de Produção Ativa: se já em preparo/pronto/entrega, operador é bloqueado
  IF v_ped.status_operacional NOT IN ('aguardando_producao', 'cancelado') AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PRODUCTION_ACTIVE_CANCEL_DENIED',
      'error', 'Pedidos com produção já iniciada ("' || v_ped.status_operacional || '") só podem ser cancelados por Administradores.'
    );
  END IF;

  -- Guarda S3b: Cancelamento com valor pago exige destino de valor
  IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
    IF COALESCE(p_destino_valor, '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
        'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
      );
    END IF;
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- Atualiza o pedido. O trigger trg_liberar_reserva_ao_cancelar cuidará de liberar o estoque e capacidade
  UPDATE public.pedidos
  SET 
    status_comercial = 'cancelado',
    status_operacional = 'cancelado',
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- Registra no histórico auditável
  INSERT INTO public.pedidos_historico (
    pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
  ) VALUES (
    p_pedido_id,
    auth.uid(),
    v_user_nome,
    v_ped.status_comercial,
    'cancelado',
    COALESCE(v_motivo, 'Cancelamento via porta dedicada cancelar_pedido_equipe'),
    jsonb_build_object(
      'porta_dominio', 'cancelar_pedido_equipe',
      'destino_valor', p_destino_valor,
      'status_operacional_anterior', v_ped.status_operacional
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_comercial', 'cancelado',
    'status_operacional', 'cancelado',
    'reservas_liberadas', true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.cancelar_pedido_equipe FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_equipe TO authenticated, service_role;

-- 4.2 CONFIRMAÇÃO EXCEPCIONAL ADMINISTRATIVA DEDICADA
CREATE OR REPLACE FUNCTION public.gerenciar_confirmacao_pedido_admin(
  p_pedido_id BIGINT,
  p_motivo TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_ped RECORD;
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas Administradores podem gerenciar confirmações excepcionais.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido obrigatório.');
  END IF;

  IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'A confirmação excepcional exige justificativa auditável (mínimo 5 caracteres).');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'confirmado' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'pedido_id', p_pedido_id, 'status_comercial', 'confirmado');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Administrador' END;
  END IF;

  UPDATE public.pedidos
  SET 
    status_comercial = 'confirmado',
    updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedidos_historico (
    pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
  ) VALUES (
    p_pedido_id,
    auth.uid(),
    v_user_nome,
    v_ped.status_comercial,
    'confirmado',
    v_motivo,
    jsonb_build_object(
      'porta_dominio', 'gerenciar_confirmacao_pedido_admin',
      'sinal_minimo', v_ped.sinal_minimo,
      'valor_pago', v_ped.valor_pago
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_comercial', 'confirmado',
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.gerenciar_confirmacao_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerenciar_confirmacao_pedido_admin TO authenticated, service_role;

-- 4.3 RESTRINGIR DIMENSÃO COMERCIAL EM ALTERAR_STATUS_PEDIDO
-- Delegar transições comerciais para as portas de domínio dedicadas
CREATE OR REPLACE FUNCTION public.alterar_status_pedido(
  p_pedido_id BIGINT,
  p_dimensao TEXT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_antigo TEXT;
  v_permitido BOOLEAN := false;
  v_user_nome TEXT;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_res_porta JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  -- Se for dimensão comercial, delegar para as portas de domínio correspondentes
  IF p_dimensao = 'comercial' THEN
    IF p_novo_status = 'cancelado' THEN
      v_res_porta := public.cancelar_pedido_equipe(p_pedido_id, p_motivo, p_metadata->>'destino_valor');
      RETURN v_res_porta::json;
    ELSIF p_novo_status = 'confirmado' THEN
      SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
      IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
      END IF;
      -- Se não tem sinal pago integral, exige a porta administrativa dedicada
      IF v_ped.valor_pago < v_ped.sinal_minimo THEN
        v_res_porta := public.gerenciar_confirmacao_pedido_admin(p_pedido_id, p_motivo);
        RETURN v_res_porta::json;
      END IF;
    END IF;
  END IF;

  -- Dimensão estritamente operacional ou confirmação comercial com sinal pago
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  IF p_dimensao = 'operacional' THEN
    v_status_antigo := v_ped.status_operacional;

    IF p_novo_status NOT IN ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      RETURN json_build_object('success', false, 'error', 'Status operacional inválido: ' || p_novo_status);
    END IF;

    -- Matriz de transições operacionais
    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_producao' AND p_novo_status IN ('em_producao', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'em_producao' AND p_novo_status IN ('pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'pronto' AND p_novo_status IN ('saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'saiu_para_entrega' AND p_novo_status IN ('entregue', 'pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_is_admin THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição operacional não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_operacional = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedidos_historico (
      pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
    ) VALUES (
      p_pedido_id,
      auth.uid(),
      v_user_nome,
      v_status_antigo,
      p_novo_status,
      p_motivo,
      p_metadata
    );

    RETURN json_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'dimensao', 'operacional',
      'status_anterior', v_status_antigo,
      'status_novo', p_novo_status
    );

  ELSIF p_dimensao = 'comercial' THEN
    -- Apenas transição para confirmado com sinal pago atinge este ponto
    v_status_antigo := v_ped.status_comercial;

    IF v_status_antigo = p_novo_status THEN
      RETURN json_build_object('success', true, 'pedido_id', p_pedido_id, 'status_comercial', p_novo_status);
    END IF;

    UPDATE public.pedidos
    SET 
      status_comercial = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedidos_historico (
      pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
    ) VALUES (
      p_pedido_id,
      auth.uid(),
      v_user_nome,
      v_status_antigo,
      p_novo_status,
      p_motivo,
      p_metadata
    );

    RETURN json_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'dimensao', 'comercial',
      'status_anterior', v_status_antigo,
      'status_novo', p_novo_status
    );
  ELSE
    RETURN json_build_object('success', false, 'error', 'Dimensão desconhecida: ' || p_dimensao);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
