-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 015: COMUNICAÇÃO WHATSAPP & RELACIONAMENTO
-- ==========================================================================
-- Contratos Consolidados:
-- 1. Tabela canônica única public.comunicacoes_cliente com duas FKs opcionais
--    (orcamento_id, pedido_id) e constraint XOR de integridade referencial.
-- 2. Chaves de idempotência determinísticas e granulares por evento/versão.
-- 3. Renderizador canônico server-side (obter_preview_comunicacao) com dados de snapshots.
-- 4. Registro de comunicação (registrar_comunicacao_cliente) blindado contra falsificação:
--    rejeita status "enviado" para canal "whatsapp_link" (aceita apenas link_aberto/gerado).
-- 5. Link público canônico estritamente padronizado em /orcamento.html?t=<token>.
-- 6. Aprovação pública vinculada à versão esperada (QUOTE_VERSION_CHANGED).
-- 7. Normalização rigorosa de telefone E.164 (sem adição cega de 9º dígito).
-- 8. Busca de pendências de lembrete de orçamentos (listar_orcamentos_para_lembrete).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. COMPATIBILIDADE DE SESSÃO ADMIN/OPERADOR (SERVICE ROLE)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND nivel = 'admin' 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_admin_or_operator()
RETURNS BOOLEAN AS $$
BEGIN
  IF auth.role() = 'service_role' OR current_user IN ('postgres', 'supabase_admin') THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND nivel IN ('admin', 'operador') 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- --------------------------------------------------------------------------
-- 1. TABELA CANÔNICA DE COMUNICAÇÕES COM O CLIENTE
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comunicacoes_cliente (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (
    tipo IN (
      'ORCAMENTO_ENVIADO',
      'ORCAMENTO_VENCENDO',
      'SINAL_CONFIRMADO',
      'PEDIDO_PRONTO',
      'SAIU_PARA_ENTREGA'
    )
  ),
  canal TEXT NOT NULL CHECK (
    canal IN ('whatsapp_link', 'evolution_api')
  ),
  destinatario TEXT NOT NULL,
  mensagem_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'gerado',
      'link_aberto',
      'enviado',
      'entregue',
      'falhou'
    )
  ),
  provider TEXT,
  provider_message_id TEXT,
  chave_idempotencia TEXT NOT NULL UNIQUE,
  erro TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  CONSTRAINT ck_comunicacao_entidade CHECK (
    (orcamento_id IS NOT NULL AND pedido_id IS NULL)
    OR
    (orcamento_id IS NULL AND pedido_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_orcamento_id ON public.comunicacoes_cliente(orcamento_id) WHERE orcamento_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_pedido_id ON public.comunicacoes_cliente(pedido_id) WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_tipo ON public.comunicacoes_cliente(tipo);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_status ON public.comunicacoes_cliente(status);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_created_at ON public.comunicacoes_cliente(created_at DESC);

-- --------------------------------------------------------------------------
-- 2. BACKFILL IDEMPOTENTE DA TABELA LEGADA ORCAMENTO_COMUNICACOES
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orcamento_comunicacoes') THEN
    INSERT INTO public.comunicacoes_cliente (
      orcamento_id,
      tipo,
      canal,
      destinatario,
      mensagem_snapshot,
      status,
      provider,
      chave_idempotencia,
      metadata,
      criado_por,
      created_at,
      enviado_em
    )
    SELECT
      oc.orcamento_id,
      CASE
        WHEN oc.tipo = 'lembrete_validade' THEN 'ORCAMENTO_VENCENDO'
        ELSE 'ORCAMENTO_ENVIADO'
      END,
      CASE
        WHEN oc.canal = 'evolution_api' THEN 'evolution_api'
        ELSE 'whatsapp_link'
      END,
      oc.destinatario_telefone,
      oc.mensagem_preview,
      CASE
        WHEN oc.canal = 'evolution_api' THEN 'enviado'
        ELSE 'link_aberto'
      END,
      CASE WHEN oc.canal = 'evolution_api' THEN 'evolution_api' ELSE NULL END,
      'legacy:orcamento_comunicacoes:' || oc.id,
      COALESCE(oc.metadata, '{}'::jsonb),
      oc.disparado_por,
      oc.disparado_em,
      CASE WHEN oc.canal = 'evolution_api' THEN oc.disparado_em ELSE NULL END
    FROM public.orcamento_comunicacoes oc
    WHERE oc.orcamento_id IS NOT NULL
    ON CONFLICT (chave_idempotencia) DO NOTHING;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 3. RLS EM COMUNICACOES_CLIENTE (FAIL-CLOSED)
-- --------------------------------------------------------------------------
ALTER TABLE public.comunicacoes_cliente ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Equipe visualiza comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe visualiza comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR SELECT
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe insere comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe insere comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR INSERT
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe atualiza comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe atualiza comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR UPDATE
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

-- --------------------------------------------------------------------------
-- 4. FUNÇÃO AUXILIAR: NORMALIZAÇÃO RIGOROSA DE TELEFONE E.164
-- --------------------------------------------------------------------------
-- Rejeita formatos ambíguos ou inválidos sem adicionar cegamente 9º dígito.
CREATE OR REPLACE FUNCTION public.normalizar_telefone_e164(
  p_telefone TEXT
)
RETURNS TEXT AS $$
DECLARE
  v_num TEXT;
  v_ddd INT;
BEGIN
  IF p_telefone IS NULL THEN
    RETURN NULL;
  END IF;

  -- Remove tudo que não for dígito
  v_num := regexp_replace(p_telefone, '\D', '', 'g');

  -- Tamanho mínimo nacional: 10 dígitos (DDD + 8 dígitos fixo)
  -- Tamanho máximo internacional com DDI 55: 13 dígitos (55 + DDD + 9 dígitos celular)
  IF length(v_num) < 10 OR length(v_num) > 13 THEN
    RETURN NULL;
  END IF;

  -- Se começa com DDI 55
  IF substring(v_num FROM 1 FOR 2) = '55' THEN
    IF length(v_num) = 12 THEN
      -- 55 + DDD (2) + 8 dígitos (fixo)
      v_ddd := substring(v_num FROM 3 FOR 2)::INT;
      IF v_ddd >= 11 AND v_ddd <= 99 THEN
        RETURN v_num;
      END IF;
    ELSIF length(v_num) = 13 THEN
      -- 55 + DDD (2) + 9 dígitos (celular, deve começar com 9)
      v_ddd := substring(v_num FROM 3 FOR 2)::INT;
      IF v_ddd >= 11 AND v_ddd <= 99 AND substring(v_num FROM 5 FOR 1) = '9' THEN
        RETURN v_num;
      END IF;
    END IF;
    -- Qualquer outra extensão com 55 é inválida
    RETURN NULL;
  END IF;

  -- Sem DDI: número nacional brasileiro
  IF length(v_num) = 10 THEN
    -- DDD (2) + 8 dígitos (fixo)
    v_ddd := substring(v_num FROM 1 FOR 2)::INT;
    IF v_ddd >= 11 AND v_ddd <= 99 THEN
      RETURN '55' || v_num;
    END IF;
  ELSIF length(v_num) = 11 THEN
    -- DDD (2) + 9 dígitos (celular, deve começar com 9)
    v_ddd := substring(v_num FROM 1 FOR 2)::INT;
    IF v_ddd >= 11 AND v_ddd <= 99 AND substring(v_num FROM 3 FOR 1) = '9' THEN
      RETURN '55' || v_num;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- --------------------------------------------------------------------------
-- 5. RENDERIZADOR CANÔNICO SERVER-SIDE: OBTER_PREVIEW_COMUNICACAO()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_preview_comunicacao(
  p_tipo TEXT,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_ped public.pedidos;
  v_pag RECORD;
  v_hist RECORD;
  v_telefone_raw TEXT;
  v_telefone_norm TEXT;
  v_mensagem TEXT;
  v_chave_idempotencia TEXT;
  v_link_publico TEXT := NULL;
  v_saldo_restante NUMERIC(10,2);
  v_valor_sinal NUMERIC(10,2);
  v_data_formatada TEXT;
  v_hora_formatada TEXT;
  v_validade_formatada TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerar previews de comunicação.');
  END IF;

  IF p_tipo IS NULL OR p_tipo NOT IN ('ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO', 'SINAL_CONFIRMADO', 'PEDIDO_PRONTO', 'SAIU_PARA_ENTREGA') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_TEMPLATE_TYPE', 'error', 'Tipo de template de comunicação inválido.');
  END IF;

  -- Validação de entidade coerente com o tipo
  IF p_tipo IN ('ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO') THEN
    IF p_orcamento_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_ID_REQUIRED', 'error', 'ID do orçamento é obrigatório para este template.');
    END IF;

    SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_NOT_FOUND', 'error', 'Orçamento não encontrado.');
    END IF;

    v_telefone_raw := v_orc.cliente_telefone;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_link_publico := 'https://lunocadoceria.com.br/orcamento.html?t=' || v_orc.token_publico::TEXT;
    v_data_formatada := to_char(v_orc.data_evento, 'DD/MM/YYYY');
    v_hora_formatada := COALESCE(to_char(v_orc.hora_evento, 'HH24:MI'), 'A combinar');
    v_validade_formatada := to_char(v_orc.validade_ate AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI');

    IF p_tipo = 'ORCAMENTO_ENVIADO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':envio';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Preparamos sua proposta Lunoca:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Evento: ' || v_data_formatada || ' às ' || v_hora_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n\n' ||
                    'Veja todos os detalhes e aprove sua proposta:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'A aprovação da proposta não reserva estoque ou capacidade até que a encomenda seja efetivamente convertida e confirmada.';

    ELSIF p_tipo = 'ORCAMENTO_VENCENDO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':vencendo';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Lembramos que sua proposta Lunoca está próxima do vencimento:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n\n' ||
                    'Acesse para conferir ou aprovar antes do prazo expirar:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'Lembramos que a disponibilidade de data e capacidade de produção permanece sujeita à confirmação no momento da conversão da encomenda.';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'entidade_tipo', 'orcamento',
      'orcamento_id', v_orc.id,
      'numero', v_orc.numero,
      'versao', v_orc.versao,
      'cliente_nome', v_orc.cliente_nome,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', v_link_publico,
      'chave_idempotencia', v_chave_idempotencia
    );

  ELSE
    -- Templates vinculados a Pedidos
    IF p_pedido_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_ID_REQUIRED', 'error', 'ID do pedido é obrigatório para este template.');
    END IF;

    SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_NOT_FOUND', 'error', 'Pedido não encontrado.');
    END IF;

    v_telefone_raw := v_ped.telefone_cliente;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_data_formatada := COALESCE(to_char(v_ped.data_entrega, 'DD/MM/YYYY'), 'A combinar');
    v_hora_formatada := COALESCE(to_char(v_ped.hora_entrega, 'HH24:MI'), 'A combinar');
    v_saldo_restante := GREATEST(0.00, COALESCE(v_ped.total, 0.00) - COALESCE(v_ped.valor_pago, 0.00));

    IF p_tipo = 'SINAL_CONFIRMADO' THEN
      -- Busca o último pagamento aprovado do pedido
      SELECT id, valor INTO v_pag
      FROM public.pedido_pagamentos
      WHERE pedido_id = v_ped.id AND status = 'aprovado'
      ORDER BY id DESC LIMIT 1;

      IF NOT FOUND THEN
        -- Fallback seguro: se valor_pago > 0 mas sem linha em pedido_pagamentos
        IF COALESCE(v_ped.valor_pago, 0.00) > 0.00 THEN
          v_valor_sinal := v_ped.valor_pago;
          v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:0:sinal';
        ELSE
          RETURN jsonb_build_object('success', false, 'code', 'PAYMENT_NOT_APPROVED', 'error', 'Nenhum pagamento aprovado foi localizado para este pedido.');
        END IF;
      ELSE
        v_valor_sinal := v_pag.valor;
        v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:' || v_pag.id || ':sinal';
      END IF;

      v_mensagem := 'Recebemos seu sinal de R$ ' || to_char(v_valor_sinal, 'FM999G999G990D00') || ' ✅' || E'\n\n' ||
                    'Encomenda #' || v_ped.id || ' confirmada!' || E'\n' ||
                    'Data: ' || v_data_formatada || E'\n' ||
                    'Horário: ' || v_hora_formatada || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n' ||
                    'Total: R$ ' || to_char(v_ped.total, 'FM999G999G990D00') || E'\n' ||
                    'Saldo restante: R$ ' || to_char(v_saldo_restante, 'FM999G999G990D00') || E'\n\n' ||
                    'Agradecemos a confiança! Em breve sua encomenda entrará em produção.';

    ELSIF p_tipo = 'PEDIDO_PRONTO' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo = 'pronto'
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':pronto';
      v_mensagem := 'Sua encomenda está pronta! 🎂✨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Cliente: ' || v_ped.nome_cliente || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n\n' ||
                    CASE 
                      WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Já finalizamos a preparação e em breve seu pedido sairá para entrega!'
                      ELSE 'Seu pedido já está disponível para retirada em nossa doceria. Aguardamos sua visita!'
                    END;

    ELSIF p_tipo = 'SAIU_PARA_ENTREGA' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo IN ('entregue', 'saiu_para_entrega', 'em_rota')
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':entrega';
      v_mensagem := 'Sua encomenda Lunoca saiu para entrega! 🚗💨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Destinatário: ' || v_ped.nome_cliente || E'\n' ||
                    'Endereço: ' || COALESCE(v_ped.endereco_entrega, 'Conforme combinado') || E'\n\n' ||
                    'Por favor, certifique-se de que haverá alguém para receber o pedido.' || E'\n' ||
                    'Bom apetite! 🍰';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'entidade_tipo', 'pedido',
      'pedido_id', v_ped.id,
      'cliente_nome', v_ped.nome_cliente,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', NULL,
      'chave_idempotencia', v_chave_idempotencia
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_preview_comunicacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_preview_comunicacao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. REGISTRO AUDITÁVEL DE COMUNICAÇÃO: REGISTRAR_COMUNICACAO_CLIENTE()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_comunicacao_cliente(
  p_tipo TEXT,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL,
  p_canal TEXT DEFAULT 'whatsapp_link',
  p_status TEXT DEFAULT 'link_aberto',
  p_provider_message_id TEXT DEFAULT NULL,
  p_erro TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_preview JSONB;
  v_com_id BIGINT;
  v_status_final TEXT;
  v_chave TEXT;
  v_destinatario TEXT;
  v_mensagem TEXT;
  v_enviado_em TIMESTAMPTZ := NULL;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode registrar comunicações.');
  END IF;

  IF p_canal NOT IN ('whatsapp_link', 'evolution_api') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CHANNEL', 'error', 'Canal de comunicação inválido.');
  END IF;

  v_status_final := COALESCE(p_status, 'link_aberto');

  -- Regra estrita de auditoria: o canal whatsapp_link NUNCA pode ser gravado como "enviado" ou "entregue"
  IF p_canal = 'whatsapp_link' AND v_status_final IN ('enviado', 'entregue') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_STATUS_FOR_CHANNEL',
      'error', 'Abertura de link wa.me não comprova envio efetivo da mensagem. Para whatsapp_link, utilize status "link_aberto" ou "gerado".'
    );
  END IF;

  -- Obtém preview canônico gerado pelo servidor (nunca confia no cliente)
  v_preview := public.obter_preview_comunicacao(p_tipo, p_orcamento_id, p_pedido_id);
  IF (v_preview->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_preview;
  END IF;

  v_destinatario := v_preview->>'telefone';
  v_mensagem := v_preview->>'mensagem';
  v_chave := v_preview->>'chave_idempotencia';

  IF v_status_final IN ('enviado', 'entregue') THEN
    v_enviado_em := NOW();
  END IF;

  -- Inserção idempotente na tabela canônica
  INSERT INTO public.comunicacoes_cliente (
    orcamento_id,
    pedido_id,
    tipo,
    canal,
    destinatario,
    mensagem_snapshot,
    status,
    provider,
    provider_message_id,
    chave_idempotencia,
    erro,
    metadata,
    criado_por,
    created_at,
    enviado_em
  ) VALUES (
    p_orcamento_id,
    p_pedido_id,
    p_tipo,
    p_canal,
    v_destinatario,
    v_mensagem,
    v_status_final,
    CASE WHEN p_canal = 'evolution_api' THEN 'evolution_api' ELSE NULL END,
    p_provider_message_id,
    v_chave,
    p_erro,
    jsonb_build_object('preview_gerado_em', NOW()),
    auth.uid(),
    NOW(),
    v_enviado_em
  )
  ON CONFLICT (chave_idempotencia) DO UPDATE SET
    status = EXCLUDED.status,
    provider_message_id = COALESCE(EXCLUDED.provider_message_id, comunicacoes_cliente.provider_message_id),
    erro = COALESCE(EXCLUDED.erro, comunicacoes_cliente.erro),
    enviado_em = COALESCE(EXCLUDED.enviado_em, comunicacoes_cliente.enviado_em)
  RETURNING id INTO v_com_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_com_id,
    'tipo', p_tipo,
    'canal', p_canal,
    'status', v_status_final,
    'destinatario', v_destinatario,
    'chave_idempotencia', v_chave
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_cliente TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. APROVAÇÃO PÚBLICA VINCULADA À VERSÃO ESPERADA (QUOTE_VERSION_CHANGED)
-- --------------------------------------------------------------------------
-- Substituição consciente da assinatura anterior para evitar overloads ambíguas no PostgREST
DROP FUNCTION IF EXISTS public.aprovar_orcamento_publico(UUID);
DROP FUNCTION IF EXISTS public.aprovar_orcamento_publico(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(
  p_token UUID,
  p_versao_esperada INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_orc public.orcamentos;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- Rate limit funcional no banco: máximo 5 tentativas em 1 minuto
  INSERT INTO public.orcamento_rate_limits (token, tentativas, ultimo_acesso)
  VALUES (p_token, 1, NOW())
  ON CONFLICT (token) DO UPDATE
    SET tentativas = CASE
          WHEN orcamento_rate_limits.ultimo_acesso < NOW() - INTERVAL '1 minute' THEN 1
          ELSE orcamento_rate_limits.tentativas + 1
        END,
        bloqueado_ate = CASE
          WHEN orcamento_rate_limits.ultimo_acesso >= NOW() - INTERVAL '1 minute' AND orcamento_rate_limits.tentativas + 1 > 5
          THEN NOW() + INTERVAL '5 minutes'
          ELSE orcamento_rate_limits.bloqueado_ate
        END,
        ultimo_acesso = NOW();

  IF EXISTS (
    SELECT 1 FROM public.orcamento_rate_limits
    WHERE token = p_token AND bloqueado_ate IS NOT NULL AND bloqueado_ate > NOW()
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'RATE_LIMIT_EXCEEDED', 'error', 'Muitas tentativas de aprovação. Tente novamente mais tarde.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE token_publico = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- Guarda de versão esperada: impede aceite de versão desatualizada
  IF p_versao_esperada IS NOT NULL AND v_orc.versao <> p_versao_esperada THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUOTE_VERSION_CHANGED',
      'versao_atual', v_orc.versao,
      'versao_esperada', p_versao_esperada,
      'error', 'A proposta foi atualizada para uma nova versão. Por favor, confira a versão mais recente antes de aprovar.'
    );
  END IF;

  -- Se já aprovado na mesma versão: IDEMPOTÊNCIA
  IF v_orc.status = 'aprovado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'aprovado',
      'idempotente', true,
      'versao', v_orc.versao,
      'aprovado_em', v_orc.aprovado_em,
      'message', 'Orçamento já foi aprovado anteriormente.'
    );
  END IF;

  IF v_orc.status = 'convertido' THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ALREADY_CONVERTED', 'error', 'Este orçamento já foi confirmado e convertido em encomenda.');
  END IF;

  IF v_orc.status = 'recusado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_NOT_APPROVABLE', 'error', 'Este orçamento foi marcado como recusado.');
  END IF;

  -- Validação de expiração temporal
  IF NOW() > v_orc.validade_ate OR v_orc.status = 'expirado' THEN
    IF v_orc.status <> 'expirado' THEN
      UPDATE public.orcamentos SET status = 'expirado', updated_at = NOW() WHERE id = v_orc.id;
      INSERT INTO public.orcamento_status_historico (
        orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
      ) VALUES (
        v_orc.id, 'EXPIRADO', v_orc.status, 'expirado', v_orc.versao, 'link_publico',
        jsonb_build_object('motivo', 'Tentativa de aprovação após validade')
      );
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_EXPIRED', 'error', 'Este orçamento expirou e não pode mais ser aprovado.');
  END IF;

  IF v_orc.status <> 'enviado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_NOT_APPROVABLE', 'error', 'O orçamento ainda não foi disponibilizado para aprovação.');
  END IF;

  -- Transição para aprovado com gravação dos dois relógios
  UPDATE public.orcamentos SET
    status = 'aprovado',
    aprovado_em = NOW(),
    janela_conversao_limite = NOW() + make_interval(hours => v_cfg.janela_conversao_horas),
    updated_at = NOW()
  WHERE id = v_orc.id;

  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
  ) VALUES (
    v_orc.id, 'APROVADO', 'enviado', 'aprovado', v_orc.versao, 'link_publico',
    jsonb_build_object('aprovado_em', NOW(), 'versao', v_orc.versao, 'janela_conversao_horas', v_cfg.janela_conversao_horas)
  );

  RETURN jsonb_build_object(
    'success', true,
    'status', 'aprovado',
    'idempotente', false,
    'versao', v_orc.versao,
    'aprovado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_orcamento_publico(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aprovar_orcamento_publico(UUID, INTEGER) TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. CONSULTA DE LEMBRETES PENDENTES: LISTAR_ORCAMENTOS_PARA_LEMBRETE()
-- --------------------------------------------------------------------------
-- Localiza orçamentos enviados que vencem nas próximas X horas e não receberam lembrete
CREATE OR REPLACE FUNCTION public.listar_orcamentos_para_lembrete(
  p_horas_antecedencia INT DEFAULT 24
)
RETURNS TABLE (
  orcamento_id BIGINT,
  numero TEXT,
  versao INT,
  cliente_nome TEXT,
  cliente_telefone TEXT,
  validade_ate TIMESTAMPTZ,
  horas_restantes NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id AS orcamento_id,
    o.numero,
    o.versao,
    o.cliente_nome,
    o.cliente_telefone,
    o.validade_ate,
    ROUND(EXTRACT(EPOCH FROM (o.validade_ate - NOW())) / 3600.0, 1) AS horas_restantes
  FROM public.orcamentos o
  WHERE o.status = 'enviado'
    AND o.validade_ate > NOW()
    AND o.validade_ate <= NOW() + make_interval(hours => p_horas_antecedencia)
    AND NOT EXISTS (
      SELECT 1 FROM public.comunicacoes_cliente cc
      WHERE cc.orcamento_id = o.id
        AND cc.tipo = 'ORCAMENTO_VENCENDO'
        AND cc.chave_idempotencia = 'orcamento:' || o.id || ':v' || o.versao || ':vencendo'
    )
  ORDER BY o.validade_ate ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_orcamentos_para_lembrete FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_orcamentos_para_lembrete TO authenticated, service_role;
