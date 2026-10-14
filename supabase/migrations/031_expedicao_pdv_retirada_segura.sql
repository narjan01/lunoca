-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 031: EXPEDIÇÃO DE BALCÃO & RETIRADA PRESENCIAL SEGURA
-- ==============================================================================
-- FRENTE P: Retirada Presencial Segura, PIN Descartável com Hash Server-Side,
-- Throttling contra Brute-Force, Checkout Atômico de Balcão e Quitação de Saldo
-- via Motor Canônico de Pagamentos.
--
-- INVARIANTES RÍGIDOS CONGELADOS:
-- 1. pedidos é a ÚNICA fonte da verdade comercial (zero pedidos_retirada ou vendas_balcao).
-- 2. PIN de retirada NUNCA é armazenado em texto puro (armazenado estritamente como hash SHA-256).
-- 3. Quitação de balcão NÃO escreve em financeiro_lancamentos diretamente; reutiliza
--    o motor canônico public.registrar_pagamento_pedido() preservando caixa, DRE e tesouraria.
-- 4. status_operacional do pedido ('retirado') é a única verdade de conclusão física.
-- 5. Quality Hold da Frente L impede a conclusão da retirada.
-- 6. RBAC fail-closed: anon e clientes não acessam RPCs administrativas de balcão.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CONFIGURAÇÕES DE RETIRADA NO BALCÃO
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retirada_configuracoes (
  id INT PRIMARY KEY DEFAULT 1,
  ttl_pin_minutos INT NOT NULL DEFAULT 120 CHECK (ttl_pin_minutos >= 5),
  max_tentativas_pin INT NOT NULL DEFAULT 3 CHECK (max_tentativas_pin >= 1),
  exigir_pin_retirada BOOLEAN NOT NULL DEFAULT true,
  permitir_retirada_com_saldo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.retirada_configuracoes (id, ttl_pin_minutos, max_tentativas_pin, exigir_pin_retirada, permitir_retirada_com_saldo)
VALUES (1, 120, 3, true, false)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. DESAFIOS / AUTORIZAÇÕES DE RETIRADA (PIN HASH SERVER-SIDE)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_retirada_autorizacoes (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  codigo_hash TEXT NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  tentativas INT NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas INT NOT NULL DEFAULT 3 CHECK (max_tentativas >= 1),
  status TEXT NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'CONSUMIDA', 'REVOGADA', 'BLOQUEADA', 'EXPIRADA')),
  consumido_em TIMESTAMPTZ,
  consumido_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revogado_em TIMESTAMPTZ,
  motivo_revogacao TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retirada_autorizacoes_pedido ON public.pedido_retirada_autorizacoes(pedido_id);
CREATE INDEX IF NOT EXISTS idx_retirada_autorizacoes_status ON public.pedido_retirada_autorizacoes(status);

-- ------------------------------------------------------------------------------
-- 3. LIVRO DE EVENTOS DA RETIRADA (EVIDÊNCIA APPEND-ONLY)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_retirada_eventos (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  autorizacao_id BIGINT REFERENCES public.pedido_retirada_autorizacoes(id) ON DELETE SET NULL,
  evento_tipo TEXT NOT NULL CHECK (evento_tipo IN (
    'PIN_GERADO',
    'PIN_REGERADO',
    'PIN_INVALIDO',
    'PIN_BLOQUEADO',
    'PAGAMENTO_BALCAO_CONFIRMADO',
    'RETIRADA_CONFIRMADA',
    'AUTORIZACAO_REVOGADA'
  )),
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retirada_eventos_pedido ON public.pedido_retirada_eventos(pedido_id);

-- Trigger de Imutabilidade Append-Only para pedido_retirada_eventos
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_retirada_eventos()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'RETIRADA_EVENTOS_APPEND_ONLY: Registros de eventos de retirada são estritamente imutáveis.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_retirada_eventos ON public.pedido_retirada_eventos;
CREATE TRIGGER trg_bloquear_mutacao_retirada_eventos
  BEFORE UPDATE OR DELETE ON public.pedido_retirada_eventos
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_retirada_eventos();

-- ------------------------------------------------------------------------------
-- 4. RPC: GERAR AUTORIZAÇÃO DE RETIRADA (PORTAL MINHA CONTA / CLIENTE OU EQUIPE)
-- ------------------------------------------------------------------------------
-- P1: Pedido de entrega NÃO gera PIN de retirada
-- P2: PIN é armazenado estritamente como hash SHA-256 no banco
-- P6: Nova geração revoga a autorização anterior
CREATE OR REPLACE FUNCTION public.gerar_autorizacao_retirada_cliente(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_ped RECORD;
  v_cliente_id BIGINT;
  v_cfg RECORD;
  v_pin TEXT;
  v_pin_hash TEXT;
  v_expira_em TIMESTAMPTZ;
  v_aut_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  -- Obter configurações de retirada
  SELECT * INTO v_cfg FROM public.retirada_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.ttl_pin_minutos := 120;
    v_cfg.max_tentativas_pin := 3;
  END IF;

  -- Localizar pedido com lock
  SELECT id, cliente_id_rel, modalidade_entrega, status_comercial, status_operacional
  INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- P1: Pedido de entrega não gera autorização de retirada
  IF COALESCE(v_ped.modalidade_entrega, '') <> 'retirada' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN de retirada aplicável apenas para pedidos com retirada no balcão.', 'code', 'DELIVERY_ORDER_NO_PICKUP_PIN');
  END IF;

  -- P7: Validação de ownership (cliente só gera para o próprio pedido) ou equipe
  IF NOT public.is_admin_or_operator() THEN
    SELECT id INTO v_cliente_id
    FROM public.clientes
    WHERE auth_user_id = v_caller_id;

    IF v_cliente_id IS NULL OR v_ped.cliente_id_rel <> v_cliente_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Você só pode gerar PIN dos seus próprios pedidos.', 'code', 'PERMISSION_DENIED');
    END IF;
  END IF;

  -- Não permite gerar para pedido cancelado ou já concluído/retirado
  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional IN ('retirado', 'entregue', 'cancelado') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido já concluído ou cancelado não permite geração de PIN.', 'code', 'ORDER_CLOSED');
  END IF;

  -- P6: Revogar autorizações ATIVAS anteriores do mesmo pedido
  UPDATE public.pedido_retirada_autorizacoes
  SET status = 'REVOGADA',
      revogado_em = NOW(),
      motivo_revogacao = 'Regeneração de código solicitada',
      updated_at = NOW()
  WHERE pedido_id = p_pedido_id AND status = 'ATIVA';

  IF FOUND THEN
    INSERT INTO public.pedido_retirada_eventos (pedido_id, evento_tipo, detalhes, usuario_id)
    VALUES (p_pedido_id, 'PIN_REGERADO', jsonb_build_object('motivo', 'Regeneração de PIN'), v_caller_id);
  END IF;

  -- Gerar PIN numérico de 6 dígitos (100000 a 999999)
  v_pin := lpad((floor(random() * 900000) + 100000)::text, 6, '0');
  v_pin_hash := encode(sha256(v_pin::bytea), 'hex');
  v_expira_em := NOW() + make_interval(mins => v_cfg.ttl_pin_minutos);

  -- P2: Armazenar estritamente o HASH do PIN
  INSERT INTO public.pedido_retirada_autorizacoes (
    pedido_id, codigo_hash, expira_em, max_tentativas, status
  ) VALUES (
    p_pedido_id, v_pin_hash, v_expira_em, v_cfg.max_tentativas_pin, 'ATIVA'
  ) RETURNING id INTO v_aut_id;

  INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
  VALUES (p_pedido_id, v_aut_id, 'PIN_GERADO', jsonb_build_object('expira_em', v_expira_em), v_caller_id);

  -- Retorna o código exclusivamente nesta resposta ao solicitante autorizado
  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'autorizacao_id', v_aut_id,
    'codigo_pin', v_pin,
    'expira_em', v_expira_em
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 5. RPC: OBTER MINHA AUTORIZAÇÃO DE RETIRADA (SANITIZADA PARA PORTAL CLIENTE)
-- ------------------------------------------------------------------------------
-- P7: Cliente só obtém autorização dos próprios pedidos; nunca expõe codigo_hash
CREATE OR REPLACE FUNCTION public.obter_minha_autorizacao_retirada(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_ped RECORD;
  v_cliente_id BIGINT;
  v_aut RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  -- Localizar pedido
  SELECT id, cliente_id_rel, modalidade_entrega, status_operacional, status_comercial
  INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- P7: Validação rigorosa de ownership pelo auth.uid()
  IF NOT public.is_admin_or_operator() THEN
    SELECT id INTO v_cliente_id FROM public.clientes WHERE auth_user_id = v_caller_id;
    IF v_cliente_id IS NULL OR v_ped.cliente_id_rel <> v_cliente_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Acesso negado aos dados deste pedido.', 'code', 'PERMISSION_DENIED');
    END IF;
  END IF;

  -- Buscar autorização mais recente
  SELECT id, status, expira_em, tentativas, max_tentativas, consumido_em, created_at
  INTO v_aut
  FROM public.pedido_retirada_autorizacoes
  WHERE pedido_id = p_pedido_id
  ORDER BY id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'possui_autorizacao', false,
      'pode_gerar_pin', (COALESCE(v_ped.modalidade_entrega, '') = 'retirada' AND v_ped.status_operacional = 'pronto')
    );
  END IF;

  -- Se expirada por tempo, atualizar status
  IF v_aut.status = 'ATIVA' AND NOW() > v_aut.expira_em THEN
    UPDATE public.pedido_retirada_autorizacoes SET status = 'EXPIRADA', updated_at = NOW() WHERE id = v_aut.id;
    v_aut.status := 'EXPIRADA';
  END IF;

  -- Retorno estritamente sanitizado (zero exposição de hash ou salt)
  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'possui_autorizacao', true,
    'autorizacao_id', v_aut.id,
    'status', v_aut.status,
    'expira_em', v_aut.expira_em,
    'consumido_em', v_aut.consumido_em,
    'status_operacional_pedido', v_ped.status_operacional
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 6. RPC: VALIDAR PIN NO BALCÃO (ADMINISTRADOR / OPERADOR)
-- ------------------------------------------------------------------------------
-- P3: PIN expirado é rejeitado
-- P4: PIN consumido não pode ser reutilizado
-- P5: Tentativas inválidas são limitadas (throttling e bloqueio automático)
CREATE OR REPLACE FUNCTION public.validar_pin_retirada_balcao(
  p_pedido_id BIGINT,
  p_pin TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_aut RECORD;
  v_fornecido_hash TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas a equipe autorizada pode validar códigos de retirada.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Informe o PIN de retirada.', 'code', 'PIN_REQUIRED');
  END IF;

  -- Localizar autorização ativa com lock
  SELECT * INTO v_aut
  FROM public.pedido_retirada_autorizacoes
  WHERE pedido_id = p_pedido_id
    AND status IN ('ATIVA', 'BLOQUEADA', 'EXPIRADA', 'CONSUMIDA')
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nenhuma autorização de retirada encontrada para este pedido.', 'code', 'NO_AUTHORIZATION');
  END IF;

  -- P4: PIN já consumido
  IF v_aut.status = 'CONSUMIDA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este PIN já foi consumido na retirada.', 'code', 'PIN_ALREADY_CONSUMED');
  END IF;

  -- P5: PIN já bloqueado por excesso de tentativas
  IF v_aut.status = 'BLOQUEADA' OR v_aut.tentativas >= v_aut.max_tentativas THEN
    RETURN jsonb_build_object('success', false, 'error', 'Autorização bloqueada por excesso de tentativas incorretas. Gere um novo PIN.', 'code', 'MAX_ATTEMPTS_EXCEEDED');
  END IF;

  -- P3: PIN expirado
  IF v_aut.status = 'EXPIRADA' OR NOW() > v_aut.expira_em THEN
    UPDATE public.pedido_retirada_autorizacoes SET status = 'EXPIRADA', updated_at = NOW() WHERE id = v_aut.id;
    RETURN jsonb_build_object('success', false, 'error', 'PIN expirado. Solicite a geração de um novo código no aplicativo.', 'code', 'PIN_EXPIRED');
  END IF;

  -- Comparar Hash do PIN
  v_fornecido_hash := encode(sha256(trim(p_pin)::bytea), 'hex');

  IF v_fornecido_hash <> v_aut.codigo_hash THEN
    -- Incrementar tentativas incorretas
    UPDATE public.pedido_retirada_autorizacoes
    SET tentativas = tentativas + 1,
        status = CASE WHEN (tentativas + 1) >= max_tentativas THEN 'BLOQUEADA' ELSE status END,
        updated_at = NOW()
    WHERE id = v_aut.id;

    INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
    VALUES (p_pedido_id, v_aut.id, 'PIN_INVALIDO', jsonb_build_object('tentativas', v_aut.tentativas + 1), v_caller_id);

    IF (v_aut.tentativas + 1) >= v_aut.max_tentativas THEN
      INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
      VALUES (p_pedido_id, v_aut.id, 'PIN_BLOQUEADO', jsonb_build_object('motivo', 'Excesso de tentativas incorretas'), v_caller_id);

      RETURN jsonb_build_object('success', false, 'error', 'Limite de tentativas excedido. Autorização bloqueada.', 'code', 'MAX_ATTEMPTS_EXCEEDED');
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'error', 'PIN incorreto.',
      'code', 'INVALID_PIN',
      'tentativas_restantes', (v_aut.max_tentativas - (v_aut.tentativas + 1))
    );
  END IF;

  -- PIN Válido
  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'autorizacao_id', v_aut.id,
    'status', 'VALIDADO'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 7. RPC: FINALIZAR CHECKOUT & RETIRADA NO BALCÃO (ATÔMICA, IDEMPOTENTE)
-- ------------------------------------------------------------------------------
-- P8:  Operador não consegue confirmar pedido que não está 'pronto'
-- P9:  Quality Hold da Frente L impede retirada
-- P10: Saldo devedor impede retirada sem quitação
-- P11: Quitação de balcão reutiliza o motor canônico de pagamento (pedido_pagamentos)
-- P12: Retry com idempotência não duplica pagamento
-- P13: Confirmação é idempotente e consome autorização uma única vez
-- P14: Retirada atualiza somente status operacional canônico ('retirado')
-- P16: Zero lançamento paralelo ou duplicado no financeiro
CREATE OR REPLACE FUNCTION public.finalizar_checkout_retirada_balcao(
  p_pedido_id BIGINT,
  p_pin TEXT DEFAULT NULL,
  p_quitar_saldo BOOLEAN DEFAULT false,
  p_forma_pagamento TEXT DEFAULT NULL,
  p_observacao_pagamento TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_ped RECORD;
  v_cfg RECORD;
  v_aut RECORD;
  v_fornecido_hash TEXT;
  v_total_pago NUMERIC(10,2) := 0;
  v_saldo NUMERIC(10,2) := 0;
  v_pag_res JSON;
  v_pag_id BIGINT;
  v_metodo_canonico TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas operadores ou administradores podem registrar a retirada no balcão.', 'code', 'PERMISSION_DENIED');
  END IF;

  -- Configurações de retirada
  SELECT * INTO v_cfg FROM public.retirada_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.exigir_pin_retirada := true;
    v_cfg.permitir_retirada_com_saldo := false;
  END IF;

  -- P13: Lock exclusivo no pedido para garantir atomicidade e serialização
  SELECT id, modalidade_entrega, status_operacional, status_comercial, status_financeiro, total
  INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- P13: Idempotência de retirada (se já foi retirado, retorna sucesso sem duplicar)
  IF v_ped.status_operacional = 'retirado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'ja_retirado', true,
      'status_operacional', 'retirado',
      'mensagem', 'Pedido já foi retirado anteriormente.'
    );
  END IF;

  -- Validar modalidade
  IF COALESCE(v_ped.modalidade_entrega, '') <> 'retirada' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas pedidos com modalidade de retirada podem ser retirados no balcão.', 'code', 'NOT_PICKUP_ORDER');
  END IF;

  -- P8: Operador não consegue retirar pedido que não esteja 'pronto'
  IF v_ped.status_operacional <> 'pronto' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido ainda não está pronto para retirada (status: ' || v_ped.status_operacional || ').', 'code', 'ORDER_NOT_READY');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido cancelado não pode ser retirado.', 'code', 'ORDER_CANCELLED');
  END IF;

  -- P9: Quality Hold da Frente L impede a conclusão da retirada
  IF EXISTS (
    SELECT 1 FROM public.producao_controles_qualidade q
    WHERE q.pedido_id = p_pedido_id
      AND q.resultado = 'REPROVADO'
      AND NOT EXISTS (
        SELECT 1 FROM public.producao_controles_qualidade q2
        WHERE q2.pedido_id = p_pedido_id
          AND q2.etapa = q.etapa
          AND q2.resultado = 'APROVADO'
          AND q2.id > q.id
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'QUALITY_HOLD_ACTIVE: Pedido possui checkpoint de qualidade reprovado e não pode ser liberado.', 'code', 'QUALITY_HOLD_ACTIVE');
  END IF;

  -- Validação de PIN (se exigido pela configuração)
  IF v_cfg.exigir_pin_retirada THEN
    IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'PIN de retirada é obrigatório.', 'code', 'PIN_REQUIRED');
    END IF;

    SELECT * INTO v_aut
    FROM public.pedido_retirada_autorizacoes
    WHERE pedido_id = p_pedido_id
      AND status = 'ATIVA'
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Nenhuma autorização ativa de retirada encontrada.', 'code', 'NO_ACTIVE_PIN');
    END IF;

    -- P3: Rejeição de PIN expirado
    IF NOW() > v_aut.expira_em THEN
      UPDATE public.pedido_retirada_autorizacoes SET status = 'EXPIRADA', updated_at = NOW() WHERE id = v_aut.id;
      RETURN jsonb_build_object('success', false, 'error', 'PIN expirado.', 'code', 'PIN_EXPIRED');
    END IF;

    -- P5: Rejeição se bloqueado por tentativas
    IF v_aut.tentativas >= v_aut.max_tentativas THEN
      UPDATE public.pedido_retirada_autorizacoes SET status = 'BLOQUEADA', updated_at = NOW() WHERE id = v_aut.id;
      RETURN jsonb_build_object('success', false, 'error', 'Limite de tentativas excedido.', 'code', 'MAX_ATTEMPTS_EXCEEDED');
    END IF;

    -- P2: Comparação pelo HASH
    v_fornecido_hash := encode(sha256(trim(p_pin)::bytea), 'hex');
    IF v_fornecido_hash <> v_aut.codigo_hash THEN
      UPDATE public.pedido_retirada_autorizacoes
      SET tentativas = tentativas + 1,
          status = CASE WHEN (tentativas + 1) >= max_tentativas THEN 'BLOQUEADA' ELSE status END,
          updated_at = NOW()
      WHERE id = v_aut.id;

      INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
      VALUES (p_pedido_id, v_aut.id, 'PIN_INVALIDO', jsonb_build_object('tentativas', v_aut.tentativas + 1), v_caller_id);

      RETURN jsonb_build_object('success', false, 'error', 'PIN de retirada incorreto.', 'code', 'INVALID_PIN');
    END IF;
  END IF;

  -- Calcular saldo atual do pedido
  SELECT COALESCE(SUM(valor), 0) INTO v_total_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = p_pedido_id AND status = 'aprovado';

  v_saldo := GREATEST(0, v_ped.total - v_total_pago);

  -- P11 & P12: Quitação do saldo remanescente via motor canônico
  IF p_quitar_saldo AND v_saldo > 0 THEN
    -- P12: Idempotência de pagamento
    IF p_chave_idempotencia IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.pedido_pagamentos
      WHERE pedido_id = p_pedido_id
        AND comprovante_url LIKE '%idemp:' || p_chave_idempotencia || '%'
    ) THEN
      -- Já processado previamente, segue sem duplicar
      NULL;
    ELSE
      -- P11: Chama a RPC canônica registrar_pagamento_pedido
      v_metodo_canonico := CASE
        WHEN p_forma_pagamento ILIKE '%cartao%' THEN 'cartao'
        WHEN p_forma_pagamento ILIKE '%pix%' THEN 'pix'
        WHEN p_forma_pagamento ILIKE '%dinheiro%' THEN 'dinheiro'
        WHEN p_forma_pagamento ILIKE '%transfer%' THEN 'transferencia'
        ELSE 'outro'
      END;

      v_pag_res := public.registrar_pagamento_pedido(
        p_pedido_id => p_pedido_id,
        p_valor => v_saldo,
        p_metodo => v_metodo_canonico,
        p_observacoes => COALESCE(p_observacao_pagamento, 'Quitação de balcão na retirada presencial') || ' (' || COALESCE(p_forma_pagamento, v_metodo_canonico) || ')',
        p_comprovante_url => CASE WHEN p_chave_idempotencia IS NOT NULL THEN 'idemp:' || p_chave_idempotencia ELSE NULL END
      );

      IF COALESCE((v_pag_res->>'success')::boolean, false) IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'Falha ao registrar pagamento do saldo: ' || (v_pag_res->>'error'), 'code', 'PAYMENT_FAILED');
      END IF;

      INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
      VALUES (p_pedido_id, v_aut.id, 'PAGAMENTO_BALCAO_CONFIRMADO', jsonb_build_object('valor', v_saldo, 'forma', p_forma_pagamento), v_caller_id);

      -- Recalcular saldo
      SELECT COALESCE(SUM(valor), 0) INTO v_total_pago
      FROM public.pedido_pagamentos
      WHERE pedido_id = p_pedido_id AND status = 'aprovado';

      v_saldo := GREATEST(0, v_ped.total - v_total_pago);
    END IF;
  END IF;

  -- P10: Se ainda houver saldo e a política proibir retirada com saldo
  IF v_saldo > 0 AND NOT v_cfg.permitir_retirada_com_saldo THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_REQUIRED: Pedido possui saldo devedor de R$ ' || to_char(v_saldo, 'FM999G990D00') || ' que deve ser quitado antes da liberação.',
      'code', 'PAYMENT_REQUIRED',
      'saldo_devedor', v_saldo
    );
  END IF;

  -- P4 & P13: Consumir autorização de forma definitiva
  IF v_aut.id IS NOT NULL THEN
    UPDATE public.pedido_retirada_autorizacoes
    SET status = 'CONSUMIDA',
        consumido_em = NOW(),
        consumido_por = v_caller_id,
        updated_at = NOW()
    WHERE id = v_aut.id;
  END IF;

  -- P14: Atualizar status operacional canônico para 'retirado' e comercial para 'concluido'
  UPDATE public.pedidos
  SET status_operacional = 'retirado',
      status_comercial = 'concluido',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_retirada_eventos (pedido_id, autorizacao_id, evento_tipo, detalhes, usuario_id)
  VALUES (
    p_pedido_id,
    v_aut.id,
    'RETIRADA_CONFIRMADA',
    jsonb_build_object('saldo_restante', v_saldo, 'quitado_no_balcao', p_quitar_saldo),
    v_caller_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_operacional', 'retirado',
    'status_comercial', 'concluido',
    'saldo_final', v_saldo,
    'mensagem', 'Retirada confirmada com sucesso.'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 8. RPC: OBTER PAINEL DO BALCÃO & EXPEDIÇÃO DE RETIRADAS (EQUIPE ADMIN/OPERADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_balcao_retiradas(
  p_data DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_data_ref DATE;
  v_pedidos JSONB := '[]'::jsonb;
  v_res RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas a equipe autorizada pode acessar a central do balcão.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_data_ref := COALESCE(p_data, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);

  SELECT jsonb_agg(
    jsonb_build_object(
      'pedido_id', p.id,
      'numero', p.id::text,
      'cliente_id', p.cliente_id_rel,
      'cliente_nome', COALESCE(c.nome, 'Cliente Balcão'),
      'cliente_telefone', c.telefone,
      'data_entrega', p.data_entrega,
      'horario_entrega', p.hora_entrega,
      'valor_total', p.total,
      'valor_pago', COALESCE(pag.total_pago, 0),
      'saldo_devedor', GREATEST(0, p.total - COALESCE(pag.total_pago, 0)),
      'status_comercial', p.status_comercial,
      'status_operacional', p.status_operacional,
      'status_financeiro', p.status_financeiro,
      'quality_hold_ativo', EXISTS (
        SELECT 1 FROM public.producao_controles_qualidade q
        WHERE q.pedido_id = p.id
          AND q.resultado = 'REPROVADO'
          AND NOT EXISTS (
            SELECT 1 FROM public.producao_controles_qualidade q2
            WHERE q2.pedido_id = p.id AND q2.etapa = q.etapa AND q2.resultado = 'APROVADO' AND q2.id > q.id
          )
      ),
      'possui_pin_ativo', EXISTS (
        SELECT 1 FROM public.pedido_retirada_autorizacoes a
        WHERE a.pedido_id = p.id AND a.status = 'ATIVA' AND a.expira_em > NOW()
      )
    ) ORDER BY p.hora_entrega NULLS LAST, p.id
  ) INTO v_pedidos
  FROM public.pedidos p
  LEFT JOIN public.clientes c ON c.id = p.cliente_id_rel
  LEFT JOIN (
    SELECT pedido_id, SUM(valor) AS total_pago
    FROM public.pedido_pagamentos
    WHERE status = 'aprovado'
    GROUP BY pedido_id
  ) pag ON pag.pedido_id = p.id
  WHERE COALESCE(p.modalidade_entrega, '') = 'retirada'
    AND (p.data_entrega = v_data_ref OR (p.data_entrega IS NULL AND p.created_at::date = v_data_ref))
    AND p.status_comercial <> 'cancelado';

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_data_ref,
    'pedidos', COALESCE(v_pedidos, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 9. SEGURANÇA, RLS E GRANTS FAIL-CLOSED (P15)
-- ------------------------------------------------------------------------------
ALTER TABLE public.retirada_configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_retirada_autorizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_retirada_eventos ENABLE ROW LEVEL SECURITY;

-- Revogar acessos públicos diretos
REVOKE ALL ON public.retirada_configuracoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_retirada_autorizacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_retirada_eventos FROM PUBLIC, anon, authenticated;

-- Políticas de Leitura para Autenticados
DROP POLICY IF EXISTS retirada_configuracoes_select ON public.retirada_configuracoes;
CREATE POLICY retirada_configuracoes_select ON public.retirada_configuracoes FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS retirada_autorizacoes_select ON public.pedido_retirada_autorizacoes;
CREATE POLICY retirada_autorizacoes_select ON public.pedido_retirada_autorizacoes FOR SELECT TO authenticated
  USING (
    public.is_admin_or_operator() OR
    EXISTS (
      SELECT 1 FROM public.pedidos p
      JOIN public.clientes c ON c.id = p.cliente_id_rel
      WHERE p.id = pedido_retirada_autorizacoes.pedido_id
        AND c.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS retirada_eventos_select ON public.pedido_retirada_eventos;
CREATE POLICY retirada_eventos_select ON public.pedido_retirada_eventos FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- Políticas Totais para service_role
DROP POLICY IF EXISTS retirada_configuracoes_service_role ON public.retirada_configuracoes;
CREATE POLICY retirada_configuracoes_service_role ON public.retirada_configuracoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS retirada_autorizacoes_service_role ON public.pedido_retirada_autorizacoes;
CREATE POLICY retirada_autorizacoes_service_role ON public.pedido_retirada_autorizacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS retirada_eventos_service_role ON public.pedido_retirada_eventos;
CREATE POLICY retirada_eventos_service_role ON public.pedido_retirada_eventos FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grants de Execução das RPCs (P15: fail-closed para anon e públicos)
REVOKE ALL ON FUNCTION public.gerar_autorizacao_retirada_cliente(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerar_autorizacao_retirada_cliente(BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_minha_autorizacao_retirada(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_minha_autorizacao_retirada(BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.validar_pin_retirada_balcao(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validar_pin_retirada_balcao(BIGINT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalizar_checkout_retirada_balcao(BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalizar_checkout_retirada_balcao(BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_painel_balcao_retiradas(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_balcao_retiradas(DATE) TO authenticated, service_role;
