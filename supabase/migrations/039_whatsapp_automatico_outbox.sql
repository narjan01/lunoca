-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 039: WHATSAPP AUTOMÁTICO TRANSACIONAL & OUTBOX
-- ==============================================================================
-- Princípio Central:
-- 1. comunicacoes_cliente = Verdade Comercial / Histórico CRM (imutabilidade das regras 015 e 024)
-- 2. comunicacao_whatsapp_outbox = Transporte técnico resiliente, assíncrono e com lease/claim
-- 3. whatsapp_eventos_gateway = Auditoria e deduplicação provider-aware de webhooks
-- 4. Zero chamadas HTTP em triggers de PostgreSQL: mensageria desacoplada do domínio
-- 5. Não-bloqueio: ausência/invalidação de telefone ou template resulta em SUPRIMIDO sem falhar o pedido
-- 6. Claim concorrente: FOR UPDATE SKIP LOCKED + claim_token + lease para reprocessamento seguro
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. PRESERVAÇÃO E AMPLIAÇÃO FORWARD-ONLY DE COMUNICACOES_CLIENTE (GATES WA1 E WA2)
-- ------------------------------------------------------------------------------
-- Preserva 100% dos tipos das migrações 015 e 024:
-- 015: ORCAMENTO_ENVIADO, ORCAMENTO_VENCENDO, SINAL_CONFIRMADO, PEDIDO_PRONTO, SAIU_PARA_ENTREGA
-- 024: CUPOM_ANIVERSARIO, VOLTE_A_COMPRAR, CAMPANHA_PASCOA, CAMPANHA_PROMOCIONAL, LEMBRETE_PONTOS_EXPIRANDO
-- 039: PEDIDO_CONFIRMADO, PAGAMENTO_CONFIRMADO, PRODUCAO_INICIADA, PEDIDO_ENTREGUE, PEDIDO_RETIRADO, ORCAMENTO_APROVADO, LEMBRETE_RETIRADA
ALTER TABLE public.comunicacoes_cliente 
  DROP CONSTRAINT IF EXISTS comunicacoes_cliente_tipo_check;

ALTER TABLE public.comunicacoes_cliente 
  ADD CONSTRAINT comunicacoes_cliente_tipo_check CHECK (
    tipo IN (
      'ORCAMENTO_ENVIADO',
      'ORCAMENTO_VENCENDO',
      'SINAL_CONFIRMADO',
      'PEDIDO_PRONTO',
      'SAIU_PARA_ENTREGA',
      'CUPOM_ANIVERSARIO',
      'VOLTE_A_COMPRAR',
      'CAMPANHA_PASCOA',
      'CAMPANHA_PROMOCIONAL',
      'LEMBRETE_PONTOS_EXPIRANDO',
      'PEDIDO_CONFIRMADO',
      'PAGAMENTO_CONFIRMADO',
      'PRODUCAO_INICIADA',
      'PEDIDO_ENTREGUE',
      'PEDIDO_RETIRADO',
      'ORCAMENTO_APROVADO',
      'LEMBRETE_RETIRADA'
    )
  );

-- Atualização de canais suportados
ALTER TABLE public.comunicacoes_cliente
  DROP CONSTRAINT IF EXISTS comunicacoes_cliente_canal_check;

ALTER TABLE public.comunicacoes_cliente
  ADD CONSTRAINT comunicacoes_cliente_canal_check CHECK (
    canal IN (
      'whatsapp_link',
      'evolution_api',
      'whatsapp_marketing',
      'email_marketing',
      'sms_marketing',
      'whatsapp_automatico',
      'whatsapp_outbox'
    )
  );

-- Adiciona coluna updated_at caso não exista
ALTER TABLE public.comunicacoes_cliente
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ------------------------------------------------------------------------------
-- 2. TABELA: WHATSAPP_TEMPLATES (CATÁLOGO VERSIONADO DE MENSAGENS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id BIGSERIAL PRIMARY KEY,
  codigo VARCHAR(50) NOT NULL,
  versao VARCHAR(10) NOT NULL DEFAULT 'v1',
  categoria VARCHAR(30) NOT NULL DEFAULT 'TRANSACIONAL' CHECK (categoria IN ('TRANSACIONAL', 'MARKETING')),
  provider_template_name VARCHAR(100),
  locale VARCHAR(10) NOT NULL DEFAULT 'pt_BR',
  conteudo TEXT NOT NULL,
  variaveis_esperadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_template_codigo_versao UNIQUE (codigo, versao)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_lookup 
  ON public.whatsapp_templates (codigo, ativo);

-- Seed canônico de templates v1
INSERT INTO public.whatsapp_templates (codigo, versao, categoria, provider_template_name, conteudo, variaveis_esperadas)
VALUES
  (
    'PEDIDO_CONFIRMADO', 'v1', 'TRANSACIONAL', 'pedido_confirmado_v1',
    'Olá, {{nome_cliente}}! Seu pedido #{{pedido_id}} foi confirmado com sucesso na Lunoca Doceria. Total: R$ {{total}}. Previsão de entrega/retirada: {{data_entrega}} às {{hora_entrega}}.',
    '["nome_cliente", "pedido_id", "total", "data_entrega", "hora_entrega"]'::jsonb
  ),
  (
    'PAGAMENTO_CONFIRMADO', 'v1', 'TRANSACIONAL', 'pagamento_confirmado_v1',
    'Olá, {{nome_cliente}}! O pagamento de R$ {{valor_pago}} referente ao pedido #{{pedido_id}} foi aprovado com sucesso. Muito obrigado!',
    '["nome_cliente", "pedido_id", "valor_pago"]'::jsonb
  ),
  (
    'PRODUCAO_INICIADA', 'v1', 'TRANSACIONAL', 'producao_iniciada_v1',
    'Boas notícias, {{nome_cliente}}! Seu pedido #{{pedido_id}} acabou de entrar em produção na nossa cozinha artesanal.',
    '["nome_cliente", "pedido_id"]'::jsonb
  ),
  (
    'PEDIDO_PRONTO', 'v1', 'TRANSACIONAL', 'pedido_pronto_v1',
    'Seu pedido está pronto, {{nome_cliente}}! 🎉 O pedido #{{pedido_id}} já pode ser retirado no balcão da Lunoca Doceria.',
    '["nome_cliente", "pedido_id"]'::jsonb
  ),
  (
    'SAIU_PARA_ENTREGA', 'v1', 'TRANSACIONAL', 'saiu_entrega_v1',
    'Seu pedido saiu para entrega, {{nome_cliente}}! 🛵 O pedido #{{pedido_id}} está a caminho do endereço: {{endereco_entrega}}.',
    '["nome_cliente", "pedido_id", "endereco_entrega"]'::jsonb
  ),
  (
    'PEDIDO_ENTREGUE', 'v1', 'TRANSACIONAL', 'pedido_entregue_v1',
    'Pedido entregue com sucesso! Esperamos que você ame cada pedacinho, {{nome_cliente}}. Agradecemos a preferência!',
    '["nome_cliente", "pedido_id"]'::jsonb
  ),
  (
    'PEDIDO_RETIRADO', 'v1', 'TRANSACIONAL', 'pedido_retirado_v1',
    'Retirada concluída com sucesso! Muito obrigado pela visita à Lunoca Doceria, {{nome_cliente}}. Bom apetite!',
    '["nome_cliente", "pedido_id"]'::jsonb
  ),
  (
    'ORCAMENTO_ENVIADO', 'v1', 'TRANSACIONAL', 'orcamento_enviado_v1',
    'Olá, {{nome_cliente}}! Seu orçamento personalizado #{{orcamento_id}} está pronto. Acesse o link para conferir os detalhes e aprovar: {{link_orcamento}}',
    '["nome_cliente", "orcamento_id", "link_orcamento"]'::jsonb
  ),
  (
    'ORCAMENTO_APROVADO', 'v1', 'TRANSACIONAL', 'orcamento_aprovado_v1',
    'Orçamento #{{orcamento_id}} aprovado com sucesso! Já estamos preparando tudo para o seu evento, {{nome_cliente}}.',
    '["nome_cliente", "orcamento_id"]'::jsonb
  ),
  (
    'LEMBRETE_RETIRADA', 'v1', 'TRANSACIONAL', 'lembrete_retirada_v1',
    'Lembrete Lunoca: Seu pedido #{{pedido_id}} está pronto aguardando sua retirada no balcão até as {{hora_limite}}.',
    '["nome_cliente", "pedido_id", "hora_limite"]'::jsonb
  )
ON CONFLICT (codigo, versao) DO UPDATE SET
  conteudo = EXCLUDED.conteudo,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  updated_at = NOW();

-- ------------------------------------------------------------------------------
-- 3. TABELA: COMUNICACAO_WHATSAPP_OUTBOX (FILA TÉCNICA COM CLAIM & LEASE)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comunicacao_whatsapp_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comunicacao_id BIGINT REFERENCES public.comunicacoes_cliente(id) ON DELETE RESTRICT,
  cliente_id BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  orcamento_id BIGINT REFERENCES public.orcamentos(id) ON DELETE RESTRICT,
  telefone_e164_snapshot VARCHAR(20),
  template_codigo VARCHAR(50) NOT NULL,
  template_versao VARCHAR(10) NOT NULL DEFAULT 'v1',
  categoria VARCHAR(30) NOT NULL DEFAULT 'TRANSACIONAL' CHECK (categoria IN ('TRANSACIONAL', 'MARKETING')),
  payload_renderizado JSONB NOT NULL DEFAULT '{}'::jsonb,
  mensagem_texto_snapshot TEXT NOT NULL,
  chave_idempotencia VARCHAR(150) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
    CHECK (status IN ('PENDENTE', 'PROCESSANDO', 'ENVIADO', 'ENTREGUE', 'LIDO', 'FALHOU', 'CANCELADO', 'SUPRIMIDO')),
  motivo_supressao VARCHAR(50)
    CHECK (motivo_supressao IS NULL OR motivo_supressao IN ('SEM_TELEFONE', 'TELEFONE_INVALIDO', 'SEM_CONSENTIMENTO', 'EVENTO_DESABILITADO', 'TEMPLATE_INDISPONIVEL')),
  disparar_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tentativas INTEGER NOT NULL DEFAULT 0,
  max_tentativas INTEGER NOT NULL DEFAULT 5,
  claim_token UUID,
  claimed_em TIMESTAMPTZ,
  lease_expira_em TIMESTAMPTZ,
  cancelamento_solicitado BOOLEAN NOT NULL DEFAULT false,
  provider VARCHAR(50),
  provider_message_id VARCHAR(100),
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  lido_em TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_fila 
  ON public.comunicacao_whatsapp_outbox (status, disparar_em, proxima_tentativa_em)
  WHERE status IN ('PENDENTE', 'PROCESSANDO');

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_lease 
  ON public.comunicacao_whatsapp_outbox (status, lease_expira_em)
  WHERE status = 'PROCESSANDO';

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_pedido 
  ON public.comunicacao_whatsapp_outbox (pedido_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_orcamento 
  ON public.comunicacao_whatsapp_outbox (orcamento_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_outbox_provider_msg 
  ON public.comunicacao_whatsapp_outbox (provider, provider_message_id) 
  WHERE provider_message_id IS NOT NULL;

-- Trigger de Imutabilidade Estrita de Snapshot (Gate WA5)
CREATE OR REPLACE FUNCTION public.trg_whatsapp_outbox_snapshot_immutable_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.mensagem_texto_snapshot <> OLD.mensagem_texto_snapshot
     OR NEW.template_codigo <> OLD.template_codigo
     OR NEW.template_versao <> OLD.template_versao
     OR NEW.payload_renderizado <> OLD.payload_renderizado THEN
    RAISE EXCEPTION 'CANNOT_ALTER_SNAPSHOT: Snapshot imutável de mensagem não pode ser adulterado' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whatsapp_outbox_snapshot_immutable ON public.comunicacao_whatsapp_outbox;
CREATE TRIGGER trg_whatsapp_outbox_snapshot_immutable
BEFORE UPDATE ON public.comunicacao_whatsapp_outbox
FOR EACH ROW
EXECUTE FUNCTION public.trg_whatsapp_outbox_snapshot_immutable_fn();

-- ------------------------------------------------------------------------------
-- 4. TABELA: WHATSAPP_EVENTOS_GATEWAY (AUDITORIA DEDUP DE WEBHOOK)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_eventos_gateway (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  chave_evento VARCHAR(150) NOT NULL,
  provider_event_id VARCHAR(100),
  provider_message_id VARCHAR(100),
  tipo_evento VARCHAR(50) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  payload_raw JSONB NOT NULL,
  status_processamento VARCHAR(30) NOT NULL DEFAULT 'RECEBIDO'
    CHECK (status_processamento IN ('RECEBIDO', 'PROCESSADO', 'IGNORADO', 'ERRO')),
  erro_processamento TEXT,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processado_em TIMESTAMPTZ,
  CONSTRAINT uq_whatsapp_evento_provider UNIQUE (provider, chave_evento)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_eventos_msg 
  ON public.whatsapp_eventos_gateway (provider, provider_message_id);

-- ------------------------------------------------------------------------------
-- 5. NORMALIZAÇÃO ESTREITA E.164 NO BANCO (GATE WA4)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_normalizar_telefone_e164(p_raw TEXT)
RETURNS VARCHAR(20) AS $$
DECLARE
  v_digits TEXT;
  v_ddd INT;
  v_nono CHAR(1);
BEGIN
  IF p_raw IS NULL THEN
    RETURN NULL;
  END IF;

  v_digits := regexp_replace(p_raw, '\D', '', 'g');

  IF length(v_digits) < 10 OR length(v_digits) > 13 THEN
    RETURN NULL;
  END IF;

  -- Com DDI 55
  IF v_digits LIKE '55%' THEN
    IF length(v_digits) = 12 THEN
      v_ddd := substring(v_digits FROM 3 FOR 2)::INT;
      IF v_ddd >= 11 AND v_ddd <= 99 THEN
        RETURN v_digits;
      END IF;
    ELSIF length(v_digits) = 13 THEN
      v_ddd := substring(v_digits FROM 3 FOR 2)::INT;
      v_nono := substring(v_digits FROM 5 FOR 1);
      IF v_ddd >= 11 AND v_ddd <= 99 AND v_nono = '9' THEN
        RETURN v_digits;
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  -- Sem DDI (Brasil)
  IF length(v_digits) = 10 THEN
    v_ddd := substring(v_digits FROM 1 FOR 2)::INT;
    IF v_ddd >= 11 AND v_ddd <= 99 THEN
      RETURN '55' || v_digits;
    END IF;
  ELSIF length(v_digits) = 11 THEN
    v_ddd := substring(v_digits FROM 1 FOR 2)::INT;
    v_nono := substring(v_digits FROM 3 FOR 1);
    IF v_ddd >= 11 AND v_ddd <= 99 AND v_nono = '9' THEN
      RETURN '55' || v_digits;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------------------------
-- 6. RPC: WHATSAPP_ENFILEIRAR_TRANSACIONAL (INTERNA, FAIL-SAFE, ZERO BLOQUEIO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_enfileirar_transacional(
  p_tipo TEXT,
  p_pedido_id BIGINT DEFAULT NULL,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_disparar_em TIMESTAMPTZ DEFAULT NOW(),
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_chave_idemp VARCHAR(150);
  v_existente RECORD;
  v_cli_id BIGINT;
  v_tel_raw TEXT;
  v_tel_norm VARCHAR(20);
  v_nome_cli TEXT;
  v_total NUMERIC(10,2);
  v_data_ent TEXT;
  v_hora_ent TEXT;
  v_end_ent TEXT;
  v_valor_pago NUMERIC(10,2);
  v_token_pub TEXT;
  v_link_orc TEXT;
  v_tpl RECORD;
  v_texto TEXT;
  v_payload JSONB;
  v_status VARCHAR(20) := 'PENDENTE';
  v_motivo_sup VARCHAR(50) := NULL;
  v_comunicacao_id BIGINT;
  v_outbox_id UUID;
BEGIN
  -- 1. Determinação da chave de idempotência determinística
  IF p_pedido_id IS NOT NULL THEN
    v_chave_idemp := p_tipo || ':pedido:' || p_pedido_id;
  ELSIF p_orcamento_id IS NOT NULL THEN
    v_chave_idemp := p_tipo || ':orcamento:' || p_orcamento_id;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'ENTIDADE_NAO_FORNECIDA');
  END IF;

  -- 2. Se já existe na outbox com a mesma chave, retorna idempotente sem duplicar
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
      cliente_id, telefone_cliente, nome_cliente, total, 
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
  END IF;

  -- 6. Registra na verdade comercial comunicacoes_cliente
  INSERT INTO public.comunicacoes_cliente (
    orcamento_id, pedido_id, tipo, canal, destinatario,
    mensagem_snapshot, status, chave_idempotencia, metadata
  ) VALUES (
    p_orcamento_id,
    p_pedido_id,
    CASE 
      WHEN p_tipo IN ('PAGAMENTO_CONFIRMADO', 'PEDIDO_CONFIRMADO') THEN 'SINAL_CONFIRMADO'
      WHEN p_tipo IN ('ORCAMENTO_APROVADO') THEN 'ORCAMENTO_ENVIADO'
      WHEN p_tipo IN ('PEDIDO_RETIRADO', 'LEMBRETE_RETIRADA', 'PRODUCAO_INICIADA') THEN 'PEDIDO_PRONTO'
      WHEN p_tipo IN ('PEDIDO_ENTREGUE') THEN 'SAIU_PARA_ENTREGA'
      ELSE p_tipo
    END,
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

  -- 7. Registra na outbox técnica
  INSERT INTO public.comunicacao_whatsapp_outbox (
    comunicacao_id, cliente_id, pedido_id, orcamento_id,
    telefone_e164_snapshot, template_codigo, template_versao,
    payload_renderizado, mensagem_texto_snapshot, chave_idempotencia,
    status, motivo_supressao, disparar_em, proxima_tentativa_em
  ) VALUES (
    v_comunicacao_id,
    v_cli_id,
    p_pedido_id,
    p_orcamento_id,
    v_tel_norm,
    COALESCE(v_tpl.codigo, p_tipo),
    COALESCE(v_tpl.versao, 'v1'),
    v_payload,
    v_texto,
    v_chave_idemp,
    v_status,
    v_motivo_sup,
    COALESCE(p_disparar_em, NOW()),
    COALESCE(p_disparar_em, NOW())
  ) RETURNING id INTO v_outbox_id;

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
-- 7. RPC: WHATSAPP_OBTER_PROXIMOS_ENVIOS (CLAIM & LEASE COM SKIP LOCKED)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_obter_proximos_envios(
  p_limite INT DEFAULT 10,
  p_lease_segundos INT DEFAULT 60
)
RETURNS TABLE (
  outbox_id UUID,
  claim_token UUID,
  pedido_id BIGINT,
  orcamento_id BIGINT,
  telefone_e164 VARCHAR(20),
  template_codigo VARCHAR(50),
  template_versao VARCHAR(10),
  mensagem_texto TEXT,
  payload JSONB,
  tentativas INT,
  lease_expira_em TIMESTAMPTZ
) AS $$
DECLARE
  v_new_token UUID := gen_random_uuid();
  v_lease_exp TIMESTAMPTZ := NOW() + (GREATEST(COALESCE(p_lease_segundos, 60), 10) || ' seconds')::INTERVAL;
BEGIN
  IF auth.role() = 'authenticated' OR auth.role() = 'anon' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Acesso restrito a service_role' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH selecionados AS (
    SELECT o.id
    FROM public.comunicacao_whatsapp_outbox o
    WHERE (
      (o.status = 'PENDENTE' AND o.disparar_em <= NOW() AND o.proxima_tentativa_em <= NOW())
      OR
      (o.status = 'PROCESSANDO' AND o.lease_expira_em < NOW())
    )
    ORDER BY o.proxima_tentativa_em ASC
    LIMIT GREATEST(COALESCE(p_limite, 10), 1)
    FOR UPDATE SKIP LOCKED
  ),
  atualizados AS (
    UPDATE public.comunicacao_whatsapp_outbox o
    SET 
      status = 'PROCESSANDO',
      claim_token = v_new_token,
      claimed_em = NOW(),
      lease_expira_em = v_lease_exp,
      updated_at = NOW()
    FROM selecionados s
    WHERE o.id = s.id
    RETURNING 
      o.id,
      o.claim_token,
      o.pedido_id,
      o.orcamento_id,
      o.telefone_e164_snapshot,
      o.template_codigo,
      o.template_versao,
      o.mensagem_texto_snapshot,
      o.payload_renderizado,
      o.tentativas,
      o.lease_expira_em
  )
  SELECT 
    a.id,
    a.claim_token,
    a.pedido_id,
    a.orcamento_id,
    a.telefone_e164_snapshot,
    a.template_codigo,
    a.template_versao,
    a.mensagem_texto_snapshot,
    a.payload_renderizado,
    a.tentativas,
    a.lease_expira_em
  FROM atualizados a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 8. RPC: WHATSAPP_CONFIRMAR_ENVIO (VALIDAÇÃO ESTRITA DE CLAIM TOKEN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_confirmar_envio(
  p_outbox_id UUID,
  p_claim_token UUID,
  p_provider VARCHAR(50),
  p_provider_msg_id VARCHAR(100)
)
RETURNS JSONB AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF auth.role() = 'authenticated' OR auth.role() = 'anon' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Acesso restrito a service_role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.comunicacao_whatsapp_outbox
  WHERE id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Registro outbox não encontrado.');
  END IF;

  -- Validação estrita de lease e claim_token
  IF v_row.status <> 'PROCESSANDO' OR v_row.claim_token IS NULL OR v_row.claim_token <> p_claim_token THEN
    RAISE EXCEPTION 'WHATSAPP_CLAIM_INVALID: Token de claim expirado ou inválido' USING ERRCODE = 'P0001';
  END IF;

  -- Corrida com cancelamento solicitado antes do envio HTTP
  IF v_row.cancelamento_solicitado IS TRUE THEN
    UPDATE public.comunicacao_whatsapp_outbox
    SET 
      status = 'CANCELADO',
      claim_token = NULL,
      lease_expira_em = NULL,
      updated_at = NOW()
    WHERE id = p_outbox_id;

    RETURN jsonb_build_object('success', true, 'cancelado', true, 'status', 'CANCELADO');
  END IF;

  -- Sucesso de envio
  UPDATE public.comunicacao_whatsapp_outbox
  SET 
    status = 'ENVIADO',
    provider = p_provider,
    provider_message_id = p_provider_msg_id,
    enviado_em = NOW(),
    claim_token = NULL,
    lease_expira_em = NULL,
    updated_at = NOW()
  WHERE id = p_outbox_id;

  -- Reconcilia verdade comercial
  IF v_row.comunicacao_id IS NOT NULL THEN
    UPDATE public.comunicacoes_cliente
    SET 
      status = 'enviado',
      provider = p_provider,
      provider_message_id = p_provider_msg_id,
      enviado_em = NOW()
    WHERE id = v_row.comunicacao_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', 'ENVIADO', 'provider_message_id', p_provider_msg_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 9. RPC: WHATSAPP_REGISTRAR_FALHA (BACKOFF EXPONENCIAL PERSISTIDO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_registrar_falha(
  p_outbox_id UUID,
  p_claim_token UUID,
  p_erro TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_row RECORD;
  v_novas_tentativas INT;
  v_novo_status VARCHAR(20);
  v_prox_tentativa TIMESTAMPTZ;
BEGIN
  IF auth.role() = 'authenticated' OR auth.role() = 'anon' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Acesso restrito a service_role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.comunicacao_whatsapp_outbox
  WHERE id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Registro outbox não encontrado.');
  END IF;

  IF v_row.status <> 'PROCESSANDO' OR v_row.claim_token IS NULL OR v_row.claim_token <> p_claim_token THEN
    RAISE EXCEPTION 'WHATSAPP_CLAIM_INVALID: Token de claim expirado ou inválido' USING ERRCODE = 'P0001';
  END IF;

  v_novas_tentativas := v_row.tentativas + 1;

  IF v_novas_tentativas >= v_row.max_tentativas THEN
    v_novo_status := 'FALHOU';
    v_prox_tentativa := v_row.proxima_tentativa_em;
  ELSE
    v_novo_status := 'PENDENTE';
    -- Backoff persistido: 1a falha: +1m, 2a: +5m, 3a: +15m, 4a+: +60m
    CASE v_novas_tentativas
      WHEN 1 THEN v_prox_tentativa := NOW() + INTERVAL '1 minute';
      WHEN 2 THEN v_prox_tentativa := NOW() + INTERVAL '5 minutes';
      WHEN 3 THEN v_prox_tentativa := NOW() + INTERVAL '15 minutes';
      ELSE        v_prox_tentativa := NOW() + INTERVAL '60 minutes';
    END CASE;
  END IF;

  UPDATE public.comunicacao_whatsapp_outbox
  SET 
    status = v_novo_status,
    tentativas = v_novas_tentativas,
    proxima_tentativa_em = v_prox_tentativa,
    ultimo_erro = p_erro,
    claim_token = NULL,
    lease_expira_em = NULL,
    updated_at = NOW()
  WHERE id = p_outbox_id;

  IF v_novo_status = 'FALHOU' AND v_row.comunicacao_id IS NOT NULL THEN
    UPDATE public.comunicacoes_cliente
    SET status = 'falhou', erro = p_erro
    WHERE id = v_row.comunicacao_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_novo_status,
    'tentativas', v_novas_tentativas,
    'proxima_tentativa_em', v_prox_tentativa
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 10. RPC: WHATSAPP_PROCESSAR_WEBHOOK_STATUS (NÃO-REGRESSÃO E DEDUP PROVIDER-AWARE)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_processar_webhook_status(
  p_provider VARCHAR(50),
  p_chave_evento VARCHAR(150),
  p_provider_event_id VARCHAR(100),
  p_provider_msg_id VARCHAR(100),
  p_tipo_evento VARCHAR(50),
  p_payload JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_hash VARCHAR(64);
  v_inserted_id BIGINT;
  v_outbox RECORD;
  v_status_atual VARCHAR(20);
  v_novo_status VARCHAR(20);
BEGIN
  IF auth.role() = 'authenticated' OR auth.role() = 'anon' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Acesso restrito a service_role' USING ERRCODE = '42501';
  END IF;

  IF p_provider IS NULL OR p_chave_evento IS NULL OR p_tipo_evento IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'PARAMETROS_INVALIDOS');
  END IF;

  v_hash := encode(digest(COALESCE(p_payload::TEXT, '')::bytea, 'sha256'), 'hex');

  -- Deduplicação estrita de evento no gateway
  INSERT INTO public.whatsapp_eventos_gateway (
    provider, chave_evento, provider_event_id, provider_message_id,
    tipo_evento, payload_hash, payload_raw
  ) VALUES (
    p_provider, p_chave_evento, p_provider_event_id, p_provider_msg_id,
    p_tipo_evento, v_hash, COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (provider, chave_evento) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'duplicado', true, 'msg', 'Evento já processado anteriormente.');
  END IF;

  -- Localiza a outbox pelo provider_message_id
  IF p_provider_msg_id IS NOT NULL THEN
    SELECT * INTO v_outbox
    FROM public.comunicacao_whatsapp_outbox
    WHERE provider = p_provider AND provider_message_id = p_provider_msg_id
    FOR UPDATE;

    IF FOUND THEN
      v_status_atual := v_outbox.status;
      v_novo_status := v_status_atual;

      -- Máquina de estados não-regressiva: ENVIADO -> ENTREGUE -> LIDO
      IF p_tipo_evento IN ('DELIVERED', 'ENTREGUE', 'messages.update') THEN
        IF v_status_atual = 'ENVIADO' THEN
          v_novo_status := 'ENTREGUE';
          UPDATE public.comunicacao_whatsapp_outbox
          SET status = 'ENTREGUE', entregue_em = NOW(), updated_at = NOW()
          WHERE id = v_outbox.id;
        END IF;
      ELSIF p_tipo_evento IN ('READ', 'LIDO', 'messages.read') THEN
        IF v_status_atual IN ('ENVIADO', 'ENTREGUE') THEN
          v_novo_status := 'LIDO';
          UPDATE public.comunicacao_whatsapp_outbox
          SET 
            status = 'LIDO', 
            lido_em = NOW(), 
            entregue_em = COALESCE(entregue_em, NOW()),
            updated_at = NOW()
          WHERE id = v_outbox.id;
        END IF;
      END IF;

      -- Sincroniza em comunicacoes_cliente
      IF v_outbox.comunicacao_id IS NOT NULL AND v_novo_status <> v_status_atual THEN
        UPDATE public.comunicacoes_cliente
        SET 
          status = CASE WHEN v_novo_status = 'ENTREGUE' THEN 'entregue' ELSE 'enviado' END,
          entregue_em = CASE WHEN v_novo_status IN ('ENTREGUE', 'LIDO') THEN NOW() ELSE entregue_em END
        WHERE id = v_outbox.comunicacao_id;
      END IF;
    END IF;
  END IF;

  UPDATE public.whatsapp_eventos_gateway
  SET status_processamento = 'PROCESSADO', processado_em = NOW()
  WHERE id = v_inserted_id;

  RETURN jsonb_build_object(
    'success', true,
    'duplicado', false,
    'evento_id', v_inserted_id,
    'novo_status', v_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 11. TRIGGERS DE DOMÍNIO AUTOMÁTICOS (PUROS, ZERO HTTP)
-- ------------------------------------------------------------------------------

-- 11.1 Transições em Pedidos (Confirmado, Pronto, Saiu p/ Entrega, Entregue, Retirado, Cancelamento)
CREATE OR REPLACE FUNCTION public.trg_whatsapp_pedidos_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Cancelamento de Pedido: Cancelar mensagens pendentes / solicitar cancelamento
  IF NEW.status_operacional = 'cancelado' AND (OLD.status_operacional IS NULL OR OLD.status_operacional <> 'cancelado') THEN
    UPDATE public.comunicacao_whatsapp_outbox
    SET status = 'CANCELADO', updated_at = NOW()
    WHERE pedido_id = NEW.id AND status = 'PENDENTE';

    UPDATE public.comunicacao_whatsapp_outbox
    SET cancelamento_solicitado = true, updated_at = NOW()
    WHERE pedido_id = NEW.id AND status = 'PROCESSANDO';

    RETURN NEW;
  END IF;

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

DROP TRIGGER IF EXISTS trg_whatsapp_pedidos ON public.pedidos;
CREATE TRIGGER trg_whatsapp_pedidos
AFTER INSERT OR UPDATE OF status_operacional, status_financeiro
ON public.pedidos
FOR EACH ROW
EXECUTE FUNCTION public.trg_whatsapp_pedidos_fn();

-- 11.2 Transições em Orçamentos (Aprovado)
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
-- 12. RPC ADMINISTRATIVA SANITIZADA (GATE WA16)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_listar_envios_admin(
  p_pedido_id BIGINT DEFAULT NULL,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  pedido_id BIGINT,
  orcamento_id BIGINT,
  telefone_visual TEXT,
  template_codigo VARCHAR(50),
  template_versao VARCHAR(10),
  status VARCHAR(20),
  motivo_supressao VARCHAR(50),
  tentativas INT,
  disparar_em TIMESTAMPTZ,
  enviado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  lido_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  mensagem_preview TEXT
) AS $$
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Acesso restrito a administradores e operadores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT 
    o.id,
    o.pedido_id,
    o.orcamento_id,
    (CASE 
      WHEN o.telefone_e164_snapshot IS NOT NULL AND length(o.telefone_e164_snapshot) >= 12 THEN
        '+' || substring(o.telefone_e164_snapshot FROM 1 FOR 2) || ' (' || 
        substring(o.telefone_e164_snapshot FROM 3 FOR 2) || ') ' ||
        substring(o.telefone_e164_snapshot FROM 5 FOR 5) || '-' ||
        substring(o.telefone_e164_snapshot FROM 10)
      ELSE o.telefone_e164_snapshot
    END)::TEXT AS telefone_visual,
    o.template_codigo,
    o.template_versao,
    o.status,
    o.motivo_supressao,
    o.tentativas,
    o.disparar_em,
    o.enviado_em,
    o.entregue_em,
    o.lido_em,
    o.ultimo_erro,
    substring(o.mensagem_texto_snapshot FROM 1 FOR 80) || '...' AS mensagem_preview
  FROM public.comunicacao_whatsapp_outbox o
  WHERE (p_pedido_id IS NULL OR o.pedido_id = p_pedido_id)
    AND (p_orcamento_id IS NULL OR o.orcamento_id = p_orcamento_id)
    AND (p_status IS NULL OR o.status = p_status)
  ORDER BY o.criado_em DESC
  LIMIT GREATEST(COALESCE(p_limite, 50), 1);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ------------------------------------------------------------------------------
-- 13. RLS E SEGURANÇA FAIL-CLOSED (GATE WA15)
-- ------------------------------------------------------------------------------
ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comunicacao_whatsapp_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_eventos_gateway ENABLE ROW LEVEL SECURITY;

-- Templates: leitura pública para operadores/admins, escrita restrita a admin
DROP POLICY IF EXISTS p_whatsapp_templates_select ON public.whatsapp_templates;
CREATE POLICY p_whatsapp_templates_select ON public.whatsapp_templates
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS p_whatsapp_templates_write ON public.whatsapp_templates;
CREATE POLICY p_whatsapp_templates_write ON public.whatsapp_templates
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Outbox: leitura autenticada admin/operador, escrita direta bloqueada
DROP POLICY IF EXISTS p_whatsapp_outbox_select ON public.comunicacao_whatsapp_outbox;
CREATE POLICY p_whatsapp_outbox_select ON public.comunicacao_whatsapp_outbox
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- Gateway eventos: apenas admin pode auditar
DROP POLICY IF EXISTS p_whatsapp_eventos_select ON public.whatsapp_eventos_gateway;
CREATE POLICY p_whatsapp_eventos_select ON public.whatsapp_eventos_gateway
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Revogação estrita de privilégios públicos nas RPCs técnicas
REVOKE ALL ON FUNCTION public.whatsapp_enfileirar_transacional(TEXT, BIGINT, BIGINT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_enfileirar_transacional(TEXT, BIGINT, BIGINT, TIMESTAMPTZ, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_obter_proximos_envios(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_obter_proximos_envios(INT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_confirmar_envio(UUID, UUID, VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_confirmar_envio(UUID, UUID, VARCHAR, VARCHAR) TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_registrar_falha(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_registrar_falha(UUID, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_processar_webhook_status(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_processar_webhook_status(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.whatsapp_listar_envios_admin(BIGINT, BIGINT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_listar_envios_admin(BIGINT, BIGINT, TEXT, INT) TO authenticated, service_role;
