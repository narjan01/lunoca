-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 040 (FORWARD-ONLY HOTFIX)
-- ==============================================================================
-- Descrição:
-- 1. Formaliza a correção forward-only de whatsapp_enfileirar_transacional:
--    - Resolve cliente_id_rel (BIGINT) em pedidos para atribuição a v_cli_id (BIGINT),
--      evitando erro 22P02 (invalid input syntax for type bigint) ao tentar ler
--      pedidos.cliente_id (UUID legado do auth.users).
--    - Corrige resolução de colunas em orçamentos para cliente_telefone e cliente_nome.
-- 2. Formaliza o isolamento de exceção em trg_whatsapp_pedidos_fn:
--    - Bloco BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING; END;
--    - Garante que nenhuma falha no enfileiramento de WhatsApp aborte a transação
--      financeira canônica de confirmação de pagamento.
-- 3. Restringe trg_whatsapp_orcamentos para disparar exclusivamente em UPDATE OF status
--    (evitando duplicidade ou enfileiramento espúrio no INSERT).
-- 4. Reafirma grants fail-closed para service_role.
--
-- Contrato de Imutabilidade:
-- - Migrations 001 a 039 permanecem congeladas e imutáveis.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CORREÇÃO EM WHATSAPP_ENFILEIRAR_TRANSACIONAL (GATE WA6 / WA7)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.whatsapp_enfileirar_transacional(text, bigint, bigint, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION public.whatsapp_enfileirar_transacional(
  p_tipo TEXT,
  p_pedido_id BIGINT DEFAULT NULL,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_disparar_em TIMESTAMPTZ DEFAULT NOW(),
  p_payload_extra JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_tpl RECORD;
  v_cli_id BIGINT;
  v_tel_raw TEXT;
  v_tel_norm TEXT;
  v_nome_cli TEXT;
  v_total NUMERIC;
  v_valor_pago NUMERIC;
  v_data_ent TEXT;
  v_hora_ent TEXT;
  v_end_ent TEXT;
  v_token_pub TEXT;
  v_link_orc TEXT;
  v_texto TEXT;
  v_payload JSONB;
  v_chave_idemp TEXT;
  v_status TEXT := 'PENDENTE';
  v_motivo_sup TEXT := NULL;
  v_comunicacao_id BIGINT;
  v_outbox_id UUID;
  v_existente RECORD;
BEGIN
  -- 1. Validação básica de entrada
  IF p_tipo IS NULL OR btrim(p_tipo) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'TIPO_INVALIDO');
  END IF;

  IF p_pedido_id IS NULL AND p_orcamento_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'REFERENCIA_OBRIGATORIA');
  END IF;

  -- 2. Deduplicação transacional estrita (idempotência por evento)
  v_chave_idemp := COALESCE(p_tipo, '') || ':' || 
                   COALESCE(p_pedido_id::TEXT, '0') || ':' || 
                   COALESCE(p_orcamento_id::TEXT, '0');

  SELECT id, status INTO v_existente 
  FROM public.comunicacao_whatsapp_outbox 
  WHERE chave_idempotencia = v_chave_idemp;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'outbox_id', v_existente.id,
      'status', v_existente.status
    );
  END IF;

  -- 3. Resolução dos dados de domínio
  IF p_pedido_id IS NOT NULL THEN
    SELECT 
      cliente_id_rel, telefone_cliente, nome_cliente, total, 
      to_char(data_entrega, 'DD/MM/YYYY'), hora_entrega::TEXT, endereco_entrega, valor_pago
    INTO 
      v_cli_id, v_tel_raw, v_nome_cli, v_total,
      v_data_ent, v_hora_ent, v_end_ent, v_valor_pago
    FROM public.pedidos 
    WHERE id = p_pedido_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'PEDIDO_NAO_ENCONTRADO');
    END IF;
  ELSE
    SELECT 
      cliente_id, cliente_telefone, cliente_nome, total, token_publico
    INTO 
      v_cli_id, v_tel_raw, v_nome_cli, v_total, v_token_pub
    FROM public.orcamentos 
    WHERE id = p_orcamento_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'ORCAMENTO_NAO_ENCONTRADO');
    END IF;
    v_link_orc := 'https://lunocadoceria.com.br/orcamento.html?t=' || COALESCE(v_token_pub, '');
  END IF;

  -- 4. Normalização do telefone e checagem de supressão (zero falha no domínio)
  v_tel_norm := public.whatsapp_normalizar_telefone_e164(v_tel_raw);

  IF v_tel_raw IS NULL OR btrim(v_tel_raw) = '' THEN
    v_status := 'SUPRIMIDO';
    v_motivo_sup := 'SEM_TELEFONE';
  ELSIF v_tel_norm IS NULL THEN
    v_status := 'SUPRIMIDO';
    v_motivo_sup := 'TELEFONE_INVALIDO';
  END IF;

  -- 5. Resolução de template versionado
  SELECT * INTO v_tpl 
  FROM public.whatsapp_templates 
  WHERE codigo = p_tipo AND ativo = true 
  ORDER BY versao DESC 
  LIMIT 1;

  IF NOT FOUND THEN
    v_status := 'SUPRIMIDO';
    v_motivo_sup := 'TEMPLATE_INDISPONIVEL';
    v_texto := 'Mensagem ' || p_tipo || ' para ' || COALESCE(v_nome_cli, 'Cliente');
    v_payload := '{}'::jsonb;
  ELSE
    -- Renderização básica das variáveis no snapshot
    v_payload := jsonb_build_object(
      'nome_cliente', COALESCE(v_nome_cli, 'Cliente'),
      'pedido_id', COALESCE(p_pedido_id::TEXT, ''),
      'orcamento_id', COALESCE(p_orcamento_id::TEXT, ''),
      'total', COALESCE(to_char(v_total, 'FM999G990D00'), '0,00'),
      'valor_pago', COALESCE(to_char(v_valor_pago, 'FM999G990D00'), '0,00'),
      'data_entrega', COALESCE(v_data_ent, ''),
      'hora_entrega', COALESCE(v_hora_ent, ''),
      'endereco_entrega', COALESCE(v_end_ent, ''),
      'link_orcamento', COALESCE(v_link_orc, ''),
      'hora_limite', '19:00'
    );

    v_texto := v_tpl.conteudo;
    v_texto := replace(v_texto, '{{nome_cliente}}', COALESCE(v_nome_cli, 'Cliente'));
    v_texto := replace(v_texto, '{{pedido_id}}', COALESCE(p_pedido_id::TEXT, ''));
    v_texto := replace(v_texto, '{{orcamento_id}}', COALESCE(p_orcamento_id::TEXT, ''));
    v_texto := replace(v_texto, '{{total}}', COALESCE(to_char(v_total, 'FM999G990D00'), '0,00'));
    v_texto := replace(v_texto, '{{valor_pago}}', COALESCE(to_char(v_valor_pago, 'FM999G990D00'), '0,00'));
    v_texto := replace(v_texto, '{{data_entrega}}', COALESCE(v_data_ent, ''));
    v_texto := replace(v_texto, '{{hora_entrega}}', COALESCE(v_hora_ent, ''));
    v_texto := replace(v_texto, '{{endereco_entrega}}', COALESCE(v_end_ent, ''));
    v_texto := replace(v_texto, '{{link_orcamento}}', COALESCE(v_link_orc, ''));
    v_texto := replace(v_texto, '{{hora_limite}}', '19:00');

    -- Merge de payload extra, se fornecido
    IF p_payload_extra IS NOT NULL AND p_payload_extra <> '{}'::jsonb THEN
      v_payload := v_payload || p_payload_extra;
    END IF;
  END IF;

  -- 6. Registra na verdade comercial comunicacoes_cliente (CRM histórico)
  INSERT INTO public.comunicacoes_cliente (
    orcamento_id, pedido_id, tipo, canal, destinatario,
    mensagem_snapshot, status, chave_idempotencia, metadata
  ) VALUES (
    p_orcamento_id,
    p_pedido_id,
    p_tipo,
    'whatsapp_automatico',
    COALESCE(v_tel_norm, v_tel_raw, 'DESCONHECIDO'),
    v_texto,
    CASE WHEN v_status = 'SUPRIMIDO' THEN 'falhou' ELSE 'gerado' END,
    v_chave_idemp,
    jsonb_build_object(
      'motivo_supressao', v_motivo_sup,
      'template_codigo', COALESCE(v_tpl.codigo, p_tipo),
      'template_versao', COALESCE(v_tpl.versao, 'v1')
    )
  )
  ON CONFLICT (chave_idempotencia) DO UPDATE SET
    updated_at = NOW()
  RETURNING id INTO v_comunicacao_id;

  -- 7. Inserção na Outbox técnica (transporte)
  INSERT INTO public.comunicacao_whatsapp_outbox (
    comunicacao_id,
    chave_idempotencia,
    cliente_id,
    pedido_id,
    orcamento_id,
    template_codigo,
    template_versao,
    categoria,
    telefone_e164_snapshot,
    mensagem_texto_snapshot,
    payload_renderizado,
    status,
    motivo_supressao,
    disparar_em,
    proxima_tentativa_em
  ) VALUES (
    v_comunicacao_id,
    v_chave_idemp,
    v_cli_id,
    p_pedido_id,
    p_orcamento_id,
    COALESCE(v_tpl.codigo, p_tipo),
    COALESCE(v_tpl.versao, '1.0'),
    COALESCE(v_tpl.categoria, 'TRANSACIONAL'),
    v_tel_norm,
    v_texto,
    v_payload,
    v_status,
    v_motivo_sup,
    COALESCE(p_disparar_em, NOW()),
    COALESCE(p_disparar_em, NOW())
  )
  RETURNING id INTO v_outbox_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'outbox_id', v_outbox_id,
    'comunicacao_id', v_comunicacao_id,
    'status', v_status,
    'motivo_supressao', v_motivo_sup
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 2. ISOLAMENTO DE EXCEÇÃO EM TRG_WHATSAPP_PEDIDOS_FN (GATE WA6)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_whatsapp_pedidos_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o pedido foi cancelado, tenta cancelar mensagens pendentes da outbox
  IF NEW.status = 'Cancelado' AND (OLD.status IS NULL OR OLD.status <> 'Cancelado') THEN
    UPDATE public.comunicacao_whatsapp_outbox
    SET status = 'CANCELADO', updated_at = NOW()
    WHERE pedido_id = NEW.id AND status IN ('PENDENTE', 'FALHA_RECUPERAVEL');

    UPDATE public.comunicacao_whatsapp_outbox
    SET cancelamento_solicitado = true, updated_at = NOW()
    WHERE pedido_id = NEW.id AND status = 'PROCESSANDO';

    RETURN NEW;
  END IF;

  BEGIN
    -- Transição para PRONTO (aviso de retirada ou pedido pronto)
    IF NEW.status_operacional = 'pronto' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'pronto') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'PEDIDO_PRONTO',
        p_pedido_id := NEW.id
      );
    END IF;

    -- Transição para SAIU_PARA_ENTREGA
    IF NEW.status_operacional = 'saiu_para_entrega' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'saiu_para_entrega') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'SAIU_PARA_ENTREGA',
        p_pedido_id := NEW.id
      );
    END IF;

    -- Transição para ENTREGUE
    IF NEW.status_operacional = 'entregue' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'entregue') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'PEDIDO_ENTREGUE',
        p_pedido_id := NEW.id
      );
    END IF;

    -- Transição para RETIRADO
    IF NEW.status_operacional = 'retirado' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'retirado') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'PEDIDO_RETIRADO',
        p_pedido_id := NEW.id
      );
    END IF;

    -- Transição de status financeiro para PAGO
    IF NEW.status_financeiro = 'pago' AND (OLD.status_financeiro IS NULL OR OLD.status_financeiro <> 'pago') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'PAGAMENTO_CONFIRMADO',
        p_pedido_id := NEW.id
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Falha não bloqueante ao enfileirar WhatsApp para pedido %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

DROP TRIGGER IF EXISTS trg_whatsapp_pedidos ON public.pedidos;
CREATE TRIGGER trg_whatsapp_pedidos
AFTER INSERT OR UPDATE OF status_operacional, status_financeiro
ON public.pedidos
FOR EACH ROW
EXECUTE FUNCTION public.trg_whatsapp_pedidos_fn();

-- ------------------------------------------------------------------------------
-- 3. AJUSTE DE TRIGGER EM ORÇAMENTOS (APENAS UPDATE DE STATUS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_whatsapp_orcamentos_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'aprovado' AND (OLD.status IS NULL OR OLD.status <> 'aprovado') THEN
      PERFORM public.whatsapp_enfileirar_transacional(
        p_tipo := 'ORCAMENTO_APROVADO',
        p_orcamento_id := NEW.id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

DROP TRIGGER IF EXISTS trg_whatsapp_orcamentos ON public.orcamentos;
CREATE TRIGGER trg_whatsapp_orcamentos
AFTER UPDATE OF status
ON public.orcamentos
FOR EACH ROW
EXECUTE FUNCTION public.trg_whatsapp_orcamentos_fn();

-- ------------------------------------------------------------------------------
-- 4. SEGURANÇA E GRANTS FAIL-CLOSED
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.whatsapp_enfileirar_transacional(TEXT, BIGINT, BIGINT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_enfileirar_transacional(TEXT, BIGINT, BIGINT, TIMESTAMPTZ, JSONB) TO service_role;
