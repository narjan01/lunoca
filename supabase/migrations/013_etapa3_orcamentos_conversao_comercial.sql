-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 013: ETAPA 3 - ORÇAMENTOS E CONVERSÃO COMERCIAL
-- ==========================================================================
-- Decisões Arquiteturais Consolidadas:
-- 1. Orçamento é entidade própria desacoplada de pedidos até o momento da conversão.
-- 2. Não reserva estoque nem capacidade produtiva enquanto estiver em rascunho/enviado/aprovado.
-- 3. Link público anônimo expõe apenas dados comerciais estritamente sanitizados (sem CMV, sem notas internas).
-- 4. Aprovação pública é idempotente e protegida contra repetições e orçamentos vencidos.
-- 5. Dois relógios operacionais independentes: validade_ate (aprovação cliente) e janela_conversao_limite (operador).
-- 6. Conversão atômica delegada exclusivamente a public.nucleo_criar_encomenda() com snapshots imutáveis.
-- 7. Rastreamento bidirecional unívoco: orcamentos.pedido_id UNIQUE e pedidos.orcamento_origem_id UNIQUE.
-- 8. Expiração transacional em lote via public.expirar_orcamentos() integrada ao cron existente.
-- 9. Trilha de auditoria (orcamento_status_historico) e log de comunicações WhatsApp (orcamento_comunicacoes).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. SEQUÊNCIA DE NUMERAÇÃO DE ORÇAMENTOS (ORC-AAAA-XXXX)
-- --------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.orcamentos_numero_seq START 1;

-- --------------------------------------------------------------------------
-- 2. TABELA PRINCIPAL DE ORÇAMENTOS
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamentos (
  id BIGSERIAL PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  versao INT NOT NULL DEFAULT 1,
  cliente_id BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL,
  cliente_nome TEXT NOT NULL,
  cliente_telefone TEXT,
  cliente_email TEXT,
  data_evento DATE NOT NULL,
  hora_evento TIME,
  tipo_entrega TEXT NOT NULL DEFAULT 'retirada' CHECK (tipo_entrega IN ('retirada', 'entrega')),
  endereco_entrega TEXT,
  validade_ate TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'enviado', 'aprovado', 'recusado', 'cancelado', 'expirado', 'convertido')),
  aprovado_em TIMESTAMPTZ,
  janela_conversao_limite TIMESTAMPTZ,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  desconto_produtos NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  motivo_desconto TEXT,
  taxa_entrega_base NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  taxa_entrega_cobrada NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  desconto_frete NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  total NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  sinal_sugerido NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  observacoes_cliente TEXT,
  observacoes_internas TEXT,
  token_publico UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  pedido_id BIGINT UNIQUE REFERENCES public.pedidos(id) ON DELETE SET NULL,
  convertido_em TIMESTAMPTZ,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  visualizado_em TIMESTAMPTZ,
  visualizacoes_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente_id ON public.orcamentos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_status ON public.orcamentos(status);
CREATE INDEX IF NOT EXISTS idx_orcamentos_data_evento ON public.orcamentos(data_evento);
CREATE INDEX IF NOT EXISTS idx_orcamentos_token_publico ON public.orcamentos(token_publico);
CREATE INDEX IF NOT EXISTS idx_orcamentos_validade ON public.orcamentos(validade_ate) WHERE status = 'enviado';

-- --------------------------------------------------------------------------
-- 3. ITENS E OPÇÕES DO ORÇAMENTO (SNAPSHOTS IMUTÁVEIS)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_itens (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  quantidade INT NOT NULL CHECK (quantidade > 0),
  preco_unitario_snapshot NUMERIC(10,2) NOT NULL,
  cmv_unitario_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00,
  subtotal NUMERIC(10,2) NOT NULL,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_itens_orcamento_id ON public.orcamento_itens(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_orcamento_itens_produto_id ON public.orcamento_itens(produto_id);

CREATE TABLE IF NOT EXISTS public.orcamento_item_opcoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_item_id BIGINT NOT NULL REFERENCES public.orcamento_itens(id) ON DELETE CASCADE,
  produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL DEFAULT 'personalizacao',
  opcao_nome TEXT NOT NULL,
  preco_adicional_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_item_opcoes_item_id ON public.orcamento_item_opcoes(orcamento_item_id);

-- --------------------------------------------------------------------------
-- 4. AUTORIZAÇÕES DE EXCEÇÕES POR VERSÃO (DESCONTO / SINAL / FRETE)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_autorizacoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  versao INT NOT NULL,
  tipo_autorizacao TEXT NOT NULL CHECK (tipo_autorizacao IN ('DESCONTO', 'SINAL_REDUZIDO', 'CONFIRMACAO_SEM_SINAL', 'FRETE')),
  autorizado_por UUID NOT NULL REFERENCES auth.users(id),
  autorizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) >= 3),
  dados_autorizacao JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_orcamento_autorizacao UNIQUE (orcamento_id, versao, tipo_autorizacao)
);

CREATE INDEX IF NOT EXISTS idx_orcamento_autorizacoes_lookup ON public.orcamento_autorizacoes(orcamento_id, versao);

-- --------------------------------------------------------------------------
-- 5. HISTÓRICO DE AUDITORIA COMERCIAL
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_status_historico (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  evento TEXT NOT NULL CHECK (evento IN ('CRIADO', 'ENVIADO', 'VISUALIZADO', 'APROVADO', 'RECUSADO', 'EXPIRADO', 'REVISADO', 'CONVERTIDO')),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  versao INT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('admin', 'link_publico', 'cron', 'sistema')),
  ator_id UUID REFERENCES auth.users(id),
  ator_nome TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_status_historico_orcamento_id ON public.orcamento_status_historico(orcamento_id);

-- --------------------------------------------------------------------------
-- 6. LOG DE COMUNICAÇÕES WHATSAPP
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_comunicacoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  canal TEXT NOT NULL CHECK (canal IN ('evolution_api', 'whatsapp_link')),
  tipo TEXT NOT NULL CHECK (tipo IN ('envio_proposta', 'lembrete_validade', 'confirmacao_aprovacao', 'cobranca_sinal')),
  destinatario_telefone TEXT NOT NULL,
  mensagem_preview TEXT NOT NULL,
  disparado_por UUID REFERENCES auth.users(id),
  disparado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_orcamento_comunicacoes_orcamento_id ON public.orcamento_comunicacoes(orcamento_id);

-- --------------------------------------------------------------------------
-- 7. SEGURANÇA E POLÍTICAS RLS (FAIL-CLOSED)
-- --------------------------------------------------------------------------
ALTER TABLE public.orcamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamentos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_itens FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_item_opcoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_item_opcoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_autorizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_autorizacoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_status_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_status_historico FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_comunicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_comunicacoes FORCE ROW LEVEL SECURITY;

-- Equipe (admin e operador) visualiza orçamentos e detalhes
DROP POLICY IF EXISTS "Equipe visualiza orcamentos" ON public.orcamentos;
CREATE POLICY "Equipe visualiza orcamentos"
  ON public.orcamentos FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamentos" ON public.orcamentos;
CREATE POLICY "Equipe gerencia orcamentos"
  ON public.orcamentos FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_itens" ON public.orcamento_itens;
CREATE POLICY "Equipe gerencia orcamento_itens"
  ON public.orcamento_itens FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_item_opcoes" ON public.orcamento_item_opcoes;
CREATE POLICY "Equipe gerencia orcamento_item_opcoes"
  ON public.orcamento_item_opcoes FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Equipe visualiza autorizacoes"
  ON public.orcamento_autorizacoes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admin gerencia autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Admin gerencia autorizacoes"
  ON public.orcamento_autorizacoes FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_status_historico" ON public.orcamento_status_historico;
CREATE POLICY "Equipe gerencia orcamento_status_historico"
  ON public.orcamento_status_historico FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_comunicacoes" ON public.orcamento_comunicacoes;
CREATE POLICY "Equipe gerencia orcamento_comunicacoes"
  ON public.orcamento_comunicacoes FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

-- Service role tem acesso irrestrito
DROP POLICY IF EXISTS "Service role acesso completo orcamentos" ON public.orcamentos;
CREATE POLICY "Service role acesso completo orcamentos" ON public.orcamentos FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_itens" ON public.orcamento_itens;
CREATE POLICY "Service role acesso completo orcamento_itens" ON public.orcamento_itens FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_item_opcoes" ON public.orcamento_item_opcoes;
CREATE POLICY "Service role acesso completo orcamento_item_opcoes" ON public.orcamento_item_opcoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Service role acesso completo orcamento_autorizacoes" ON public.orcamento_autorizacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_status_historico" ON public.orcamento_status_historico;
CREATE POLICY "Service role acesso completo orcamento_status_historico" ON public.orcamento_status_historico FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_comunicacoes" ON public.orcamento_comunicacoes;
CREATE POLICY "Service role acesso completo orcamento_comunicacoes" ON public.orcamento_comunicacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Tabela e políticas para Rate Limiting na aprovação pública
CREATE TABLE IF NOT EXISTS public.orcamento_rate_limits (
  token UUID PRIMARY KEY,
  tentativas INT NOT NULL DEFAULT 1,
  bloqueado_ate TIMESTAMPTZ,
  ultimo_acesso TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.orcamento_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role rate limits" ON public.orcamento_rate_limits;
CREATE POLICY "Service role rate limits" ON public.orcamento_rate_limits FOR ALL TO service_role USING (true) WITH CHECK (true);

-- --------------------------------------------------------------------------
-- 8. HELPER PARA GERAR NÚMERO DO ORÇAMENTO (ORC-AAAA-XXXX)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerar_numero_orcamento()
RETURNS TEXT AS $$
DECLARE
  v_ano TEXT := TO_CHAR(NOW(), 'YYYY');
  v_seq BIGINT := nextval('public.orcamentos_numero_seq');
BEGIN
  RETURN 'ORC-' || v_ano || '-' || LPAD(v_seq::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

REVOKE ALL ON FUNCTION public.gerar_numero_orcamento FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerar_numero_orcamento TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC CRIAR OU ATUALIZAR ORÇAMENTO (ADMIN / OPERADOR)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.criar_ou_atualizar_orcamento_admin(
  p_dados JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_tz TEXT := COALESCE(v_cfg.timezone, 'America/Fortaleza');
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_user_nome TEXT;

  v_id BIGINT := NULLIF((p_dados->>'id')::BIGINT, 0);
  v_orc_existente public.orcamentos;
  v_versao INT := 1;
  v_numero TEXT;

  v_cliente_id_in BIGINT := NULLIF((p_dados->>'cliente_id')::BIGINT, 0);
  v_cliente_nome_in TEXT := TRIM(COALESCE(p_dados->>'cliente_nome', ''));
  v_cliente_tel_in TEXT := TRIM(COALESCE(p_dados->>'cliente_telefone', ''));
  v_cliente_email_in TEXT := TRIM(COALESCE(p_dados->>'cliente_email', ''));

  v_cliente_id_final BIGINT;
  v_cliente_nome_final TEXT;
  v_cliente_tel_final TEXT;
  v_cliente_email_final TEXT;
  v_tel_norm TEXT;

  v_data_evento DATE := (p_dados->>'data_evento')::DATE;
  v_hora_evento TIME := (p_dados->>'hora_evento')::TIME;
  v_modalidade TEXT := LOWER(TRIM(COALESCE(p_dados->>'tipo_entrega', p_dados->>'modalidade', 'retirada')));
  v_endereco TEXT := NULLIF(TRIM(COALESCE(p_dados->>'endereco_entrega', '')), '');

  v_evento_ts TIMESTAMPTZ;
  v_validade_ate TIMESTAMPTZ;

  v_itens JSONB := p_dados->'itens';
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_sinal_sugerido NUMERIC(10,2) := 0.00;

  v_desc_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto_produtos')::NUMERIC, (p_dados->>'desconto')::NUMERIC, 0.00));
  v_motivo_desc TEXT := TRIM(COALESCE(p_dados->>'motivo_desconto', ''));
  v_desc_pol JSONB;

  v_taxa_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'taxa_entrega')::NUMERIC, 0.00));
  v_desc_frete_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto_frete')::NUMERIC, 0.00));
  v_motivo_frete TEXT := TRIM(COALESCE(p_dados->>'motivo_desconto_frete', ''));
  v_frete_val JSONB;

  v_status_alvo TEXT := LOWER(TRIM(COALESCE(p_dados->>'status', 'rascunho')));
  v_obs_cliente TEXT := NULLIF(TRIM(COALESCE(p_dados->>'observacoes_cliente', '')), '');
  v_obs_internas TEXT := NULLIF(TRIM(COALESCE(p_dados->>'observacoes_internas', '')), '');

  v_orc_id BIGINT;
  v_item_id BIGINT;
  v_item_subtotal NUMERIC(10,2);
  v_evento_hist TEXT := 'CRIADO';
  v_status_ant TEXT := NULL;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerenciar orçamentos.');
  END IF;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = auth.uid();

  -- 1. Se edição, carregar e validar integridade do orçamento existente
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_orc_existente FROM public.orcamentos WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
    END IF;

    IF v_orc_existente.status = 'convertido' THEN
      RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ALREADY_CONVERTED', 'error', 'Orçamento já convertido em pedido não pode ser editado.');
    END IF;

    -- Se já havia sido enviado ou aprovado, edição gera nova versão e reseta aprovação (E3-11)
    IF v_orc_existente.status IN ('enviado', 'aprovado') THEN
      v_versao := v_orc_existente.versao + 1;
      v_evento_hist := 'REVISADO';
    ELSE
      v_versao := v_orc_existente.versao;
      v_evento_hist := 'REVISADO';
    END IF;

    v_numero := v_orc_existente.numero;
    v_status_ant := v_orc_existente.status;
  ELSE
    v_numero := public.gerar_numero_orcamento();
    v_versao := 1;
    v_evento_hist := 'CRIADO';
  END IF;

  -- 2. Validação da Data do Evento e Timezone
  IF v_data_evento IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_EVENT_DATE', 'error', 'Data do evento é obrigatória.');
  END IF;

  v_evento_ts := ((v_data_evento + COALESCE(v_hora_evento, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_tz;

  -- Validade com dois limites: agora + validade_orcamento_horas vs evento - antecedencia_minima_orcamento_horas
  v_validade_ate := LEAST(
    NOW() + make_interval(hours => v_cfg.validade_orcamento_horas),
    v_evento_ts - make_interval(hours => v_cfg.antecedencia_minima_orcamento_horas)
  );

  IF v_validade_ate <= NOW() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INSUFFICIENT_LEAD_TIME',
      'error', 'A data do evento é muito próxima para emissão de proposta. A antecedência mínima exigida é de ' || v_cfg.antecedencia_minima_orcamento_horas || ' horas antes do evento.'
    );
  END IF;

  -- 3. Resolução do Cliente
  v_cliente_id_final := NULL;
  IF v_cliente_id_in IS NOT NULL THEN
    SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
    FROM public.clientes WHERE id = v_cliente_id_in;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF length(v_cliente_nome_in) < 2 THEN
      RETURN jsonb_build_object('success', false, 'code', 'CUSTOMER_NAME_REQUIRED', 'error', 'Nome do cliente é obrigatório.');
    END IF;

    v_tel_norm := regexp_replace(v_cliente_tel_in, '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN v_tel_norm := NULL; END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
      FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, endereco_padrao)
      VALUES (
        v_cliente_nome_in,
        NULLIF(v_cliente_tel_in, ''),
        v_tel_norm,
        NULLIF(v_cliente_email_in, ''),
        CASE WHEN v_endereco IS NOT NULL THEN jsonb_build_object('endereco', v_endereco) ELSE '{}'::jsonb END
      ) RETURNING id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final;
    END IF;
  END IF;

  v_cliente_nome_final := COALESCE(NULLIF(v_cliente_nome_in, ''), v_cliente_nome_final);
  v_cliente_tel_final := COALESCE(NULLIF(v_cliente_tel_in, ''), v_cliente_tel_final);
  v_cliente_email_final := COALESCE(NULLIF(v_cliente_email_in, ''), v_cliente_email_final);

  -- 4. Validação de Modalidade e Frete
  v_frete_val := public.validar_modalidade_frete(v_modalidade, v_taxa_in, v_endereco, v_desc_frete_in, v_motivo_frete);
  IF NOT COALESCE((v_frete_val->>'success')::BOOLEAN, false) THEN
    RETURN v_frete_val;
  END IF;

  -- 5. Itens e Subtotal (leitura do catálogo atual com snapshots)
  IF v_itens IS NULL OR jsonb_typeof(v_itens) <> 'array' OR jsonb_array_length(v_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'O orçamento precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, ativo, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_UNAVAILABLE', 'error', 'Produto #' || v_prod_id || ' não está disponível no catálogo.');
    END IF;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;
    v_preco_opt := 0.00;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            v_preco_opt := v_preco_opt + COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_item_subtotal := (v_prod.preco + v_preco_opt) * v_qtd;
    v_subtotal := v_subtotal + v_item_subtotal;
  END LOOP;

  -- 6. Política de Desconto (sem p_is_admin por parâmetro)
  v_desc_pol := public.politica_desconto(v_subtotal, v_desc_in, v_motivo_desc);
  IF NOT COALESCE((v_desc_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_desc_pol;
  END IF;

  v_total := (v_subtotal - (v_desc_pol->>'desconto_aprovado')::NUMERIC) + (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC;
  v_sinal_sugerido := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);

  -- 7. Persistência Principal (INSERT ou UPDATE)
  IF v_id IS NOT NULL THEN
    v_orc_id := v_id;
    UPDATE public.orcamentos SET
      versao = v_versao,
      cliente_id = v_cliente_id_final,
      cliente_nome = v_cliente_nome_final,
      cliente_telefone = v_cliente_tel_final,
      cliente_email = v_cliente_email_final,
      data_evento = v_data_evento,
      hora_evento = v_hora_evento,
      tipo_entrega = v_frete_val->>'modalidade',
      endereco_entrega = v_frete_val->>'endereco_entrega',
      validade_ate = v_validade_ate,
      status = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN 'rascunho' ELSE v_status_alvo END,
      aprovado_em = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN NULL ELSE v_orc_existente.aprovado_em END,
      janela_conversao_limite = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN NULL ELSE v_orc_existente.janela_conversao_limite END,
      subtotal = v_subtotal,
      desconto_produtos = (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      motivo_desconto = v_desc_pol->>'motivo',
      taxa_entrega_base = (v_frete_val->>'taxa_entrega_base')::NUMERIC,
      taxa_entrega_cobrada = (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      desconto_frete = (v_frete_val->>'desconto_frete')::NUMERIC,
      total = v_total,
      sinal_sugerido = v_sinal_sugerido,
      observacoes_cliente = v_obs_cliente,
      observacoes_internas = v_obs_internas,
      updated_at = NOW()
    WHERE id = v_orc_id;

    -- Deleta itens anteriores para regravação consistente da nova versão
    DELETE FROM public.orcamento_itens WHERE orcamento_id = v_orc_id;
  ELSE
    INSERT INTO public.orcamentos (
      numero, versao, cliente_id, cliente_nome, cliente_telefone, cliente_email,
      data_evento, hora_evento, tipo_entrega, endereco_entrega, validade_ate,
      status, subtotal, desconto_produtos, motivo_desconto,
      taxa_entrega_base, taxa_entrega_cobrada, desconto_frete,
      total, sinal_sugerido, observacoes_cliente, observacoes_internas,
      criado_por
    ) VALUES (
      v_numero, v_versao, v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final,
      v_data_evento, v_hora_evento, v_frete_val->>'modalidade', v_frete_val->>'endereco_entrega', v_validade_ate,
      v_status_alvo, v_subtotal, (v_desc_pol->>'desconto_aprovado')::NUMERIC, v_desc_pol->>'motivo',
      (v_frete_val->>'taxa_entrega_base')::NUMERIC, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC, (v_frete_val->>'desconto_frete')::NUMERIC,
      v_total, v_sinal_sugerido, v_obs_cliente, v_obs_internas,
      auth.uid()
    ) RETURNING id INTO v_orc_id;
  END IF;

  -- 8. Persistência de Itens e Opções (snapshots)
  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes,
      it->>'observacoes' AS observacoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_preco_opt := 0.00;

    -- Primeiro calcula adicionais das opções
    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            v_preco_opt := v_preco_opt + COALESCE(v_opt_rec.preco_adicional, 0.00);
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_item_subtotal := (v_prod.preco + v_preco_opt) * v_qtd;

    INSERT INTO public.orcamento_itens (
      orcamento_id, produto_id, quantidade, preco_unitario_snapshot,
      cmv_unitario_snapshot, pontos_producao_snapshot, subtotal, observacoes
    ) VALUES (
      v_orc_id, v_prod_id, v_qtd, v_prod.preco,
      0.00, v_pts_prod, v_item_subtotal, v_item.observacoes
    ) RETURNING id INTO v_item_id;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.orcamento_item_opcoes (
              orcamento_item_id, produto_opcao_id, tipo, opcao_nome,
              preco_adicional_snapshot, pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, v_opt_rec.id, 'personalizacao', v_opcao_nome,
              COALESCE(v_opt_rec.preco_adicional, 0.00), COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
          ELSE
            INSERT INTO public.orcamento_item_opcoes (
              orcamento_item_id, produto_opcao_id, tipo, opcao_nome,
              preco_adicional_snapshot, pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, NULL, 'personalizacao', v_opcao_nome, 0.00, 0.00
            );
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- 9. Se desconto excepcional admin, persistir autorização para a versão atual
  IF (v_desc_pol->>'excecao_admin')::BOOLEAN = true AND v_is_admin THEN
    INSERT INTO public.orcamento_autorizacoes (
      orcamento_id, versao, tipo_autorizacao, autorizado_por, motivo, dados_autorizacao
    ) VALUES (
      v_orc_id, v_versao, 'DESCONTO', auth.uid(), v_desc_pol->>'motivo',
      jsonb_build_object('desconto_aprovado', (v_desc_pol->>'desconto_aprovado')::NUMERIC, 'percentual', (v_desc_pol->>'percentual')::NUMERIC)
    ) ON CONFLICT (orcamento_id, versao, tipo_autorizacao)
    DO UPDATE SET
      autorizado_por = EXCLUDED.autorizado_por,
      autorizado_em = NOW(),
      motivo = EXCLUDED.motivo,
      dados_autorizacao = EXCLUDED.dados_autorizacao;
  END IF;

  -- 10. Gravação da Trilha de Histórico
  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    v_orc_id, v_evento_hist, v_status_ant,
    (SELECT status FROM public.orcamentos WHERE id = v_orc_id),
    v_versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object(
      'total', v_total,
      'subtotal', v_subtotal,
      'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      'validade_ate', v_validade_ate,
      'numero', v_numero
    )
  );

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      'id', id,
      'numero', numero,
      'versao', versao,
      'status', status,
      'total', total,
      'subtotal', subtotal,
      'validade_ate', validade_ate,
      'token_publico', token_publico
    )
    FROM public.orcamentos
    WHERE id = v_orc_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_ou_atualizar_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_ou_atualizar_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10. RPC ALTERAR STATUS DO ORÇAMENTO (ENVIAR / RECUSAR / CANCELAR)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alterar_status_orcamento_admin(
  p_orcamento_id BIGINT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_novo TEXT := LOWER(TRIM(p_novo_status));
  v_evento TEXT;
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  IF v_orc.status = 'convertido' THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ALREADY_CONVERTED', 'error', 'Orçamento convertido não pode ter o status alterado.');
  END IF;

  IF v_novo NOT IN ('enviado', 'recusado', 'cancelado', 'rascunho') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_STATUS', 'error', 'Status de transição inválido.');
  END IF;

  IF v_novo = 'enviado' THEN
    IF NOW() > v_orc.validade_ate THEN
      RETURN jsonb_build_object('success', false, 'code', 'QUOTE_EXPIRED', 'error', 'Não é possível enviar um orçamento com validade expirada. Atualize a data do evento.');
    END IF;
    v_evento := 'ENVIADO';
  ELSIF v_novo = 'recusado' THEN
    v_evento := 'RECUSADO';
  ELSIF v_novo = 'cancelado' THEN
    v_evento := 'CANCELADO';
  ELSE
    v_evento := 'REVISADO';
  END IF;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE u.id = auth.uid();

  UPDATE public.orcamentos
  SET status = v_novo, updated_at = NOW()
  WHERE id = p_orcamento_id;

  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    p_orcamento_id, v_evento, v_orc.status, v_novo, v_orc.versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object('motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'id', p_orcamento_id, 'status', v_novo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 11. RPC OBTER ORÇAMENTO PÚBLICO (ANÔNIMO / SANITIZADO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_orcamento_publico(
  p_token UUID
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_itens JSONB;
  v_expirado BOOLEAN;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE token_publico = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  v_expirado := (NOW() > v_orc.validade_ate) OR (v_orc.status = 'expirado');

  -- Atualiza visualização de forma segura
  UPDATE public.orcamentos
  SET visualizado_em = COALESCE(visualizado_em, NOW()),
      visualizacoes_count = visualizacoes_count + 1
  WHERE id = v_orc.id;

  -- Se for a primeira visualização, registra evento no histórico
  IF v_orc.visualizacoes_count = 0 THEN
    INSERT INTO public.orcamento_status_historico (
      orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
    ) VALUES (
      v_orc.id, 'VISUALIZADO', v_orc.status, v_orc.status, v_orc.versao, 'link_publico',
      jsonb_build_object('primeira_visualizacao', true)
    );
  END IF;

  -- Monta itens com opções (estritamente sanitizados: sem CMV, sem custos internos)
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', oi.id,
      'produto_id', oi.produto_id,
      'produto_nome', pr.nome,
      'produto_descricao', pr.descricao,
      'produto_imagem_url', pr.img_url,
      'quantidade', oi.quantidade,
      'preco_unitario', oi.preco_unitario_snapshot,
      'subtotal', oi.subtotal,
      'observacoes', oi.observacoes,
      'opcoes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'tipo', oio.tipo,
            'opcao_nome', oio.opcao_nome,
            'preco_adicional', oio.preco_adicional_snapshot
          )
        )
        FROM public.orcamento_item_opcoes oio
        WHERE oio.orcamento_item_id = oi.id
      ), '[]'::jsonb)
    )
  )
  INTO v_itens
  FROM public.orcamento_itens oi
  JOIN public.produtos pr ON pr.id = oi.produto_id
  WHERE oi.orcamento_id = v_orc.id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_orc.id,
    'numero', v_orc.numero,
    'versao', v_orc.versao,
    'cliente_nome', v_orc.cliente_nome,
    'cliente_telefone', v_orc.cliente_telefone,
    'data_evento', v_orc.data_evento,
    'hora_evento', v_orc.hora_evento,
    'tipo_entrega', v_orc.tipo_entrega,
    'endereco_entrega', v_orc.endereco_entrega,
    'validade_ate', v_orc.validade_ate,
    'expirado', v_expirado,
    'status', v_orc.status,
    'subtotal', v_orc.subtotal,
    'desconto_produtos', v_orc.desconto_produtos,
    'taxa_entrega', v_orc.taxa_entrega_cobrada,
    'total', v_orc.total,
    'sinal_sugerido', v_orc.sinal_sugerido,
    'observacoes_cliente', v_orc.observacoes_cliente,
    'aprovado_em', v_orc.aprovado_em,
    'itens', COALESCE(v_itens, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_orcamento_publico FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obter_orcamento_publico TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 12. RPC APROVAÇÃO PÚBLICA (IDEMPOTENTE E RATE-LIMITED)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(
  p_token UUID
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_orc public.orcamentos;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- Rate limit: máximo 5 tentativas em 1 minuto
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

  -- Se já aprovado na mesma versão: IDEMPOTÊNCIA (E3-4)
  IF v_orc.status = 'aprovado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'aprovado',
      'idempotente', true,
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

  -- Validação de expiração temporal (E3-13)
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
    jsonb_build_object('aprovado_em', NOW(), 'janela_conversao_horas', v_cfg.janela_conversao_horas)
  );

  RETURN jsonb_build_object(
    'success', true,
    'status', 'aprovado',
    'idempotente', false,
    'aprovado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_orcamento_publico(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aprovar_orcamento_publico(UUID) TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 13. RPC EXPIRAÇÃO AUTOMÁTICA EM LOTE (CRON UNIFICADO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expirar_orcamentos(
  p_limite INT DEFAULT 100
)
RETURNS JSONB AS $$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_expirados BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  FOR v_rec IN
    SELECT id, status, versao
    FROM public.orcamentos
    WHERE status = 'enviado' AND validade_ate < NOW()
    ORDER BY validade_ate ASC
    LIMIT GREATEST(1, COALESCE(p_limite, 100))
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.orcamentos
    SET status = 'expirado', updated_at = NOW()
    WHERE id = v_rec.id;

    INSERT INTO public.orcamento_status_historico (
      orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
    ) VALUES (
      v_rec.id, 'EXPIRADO', v_rec.status, 'expirado', v_rec.versao, 'cron',
      jsonb_build_object('expirado_em', NOW())
    );

    v_count := v_count + 1;
    v_expirados := array_append(v_expirados, v_rec.id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expirados_count', v_count,
    'orcamentos_ids', v_expirados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.expirar_orcamentos FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expirar_orcamentos TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 14. RPC CONVERTER ORÇAMENTO EM PEDIDO (CHAMA NÚCLEO CANÔNICO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.converter_orcamento_em_pedido_admin(
  p_orcamento_id BIGINT,
  p_dados_complementares JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_orc public.orcamentos;
  v_itens_payload JSONB := '[]'::jsonb;
  v_item_rec RECORD;
  v_opcoes_payload JSONB;
  v_nucleo_payload JSONB;
  v_nucleo_res JSONB;
  v_pedido_id BIGINT;
  v_user_nome TEXT;

  v_sinal_valor NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados_complementares->>'sinal_valor')::NUMERIC, 0.00));
  v_sinal_metodo TEXT := COALESCE(p_dados_complementares->>'sinal_metodo', 'pix');
  v_sinal_comp TEXT := p_dados_complementares->>'sinal_comprovante';
  v_forcar_sem_sinal BOOLEAN := COALESCE((p_dados_complementares->>'forcar_confirmacao_sem_sinal')::BOOLEAN, false);
  v_motivo_sem_sinal TEXT := p_dados_complementares->>'motivo_confirmacao_sem_sinal';
  v_forcar_encaixe BOOLEAN := COALESCE((p_dados_complementares->>'forcar_encaixe')::BOOLEAN, false);
  v_motivo_encaixe TEXT := p_dados_complementares->>'motivo_encaixe';
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- 1. Idempotência Transacional Concorrente (E3-8)
  IF v_orc.status = 'convertido' AND v_orc.pedido_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'pedido_id', v_orc.pedido_id,
      'idempotente', true,
      'message', 'Orçamento já convertido em encomenda.'
    );
  END IF;

  -- 2. Guarda de Estado: Somente orçamentos em status 'aprovado' podem ser convertidos (E3-5)
  IF v_orc.status <> 'aprovado' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUOTE_NOT_CONVERTIBLE',
      'status', v_orc.status,
      'error', 'Apenas orçamentos aprovados pelo cliente podem ser convertidos em encomenda.'
    );
  END IF;

  -- 3. Guarda de Janela Operacional: Limite de horas pós-aprovação (E3-7)
  IF v_orc.janela_conversao_limite IS NOT NULL AND NOW() > v_orc.janela_conversao_limite THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'CONVERSION_WINDOW_EXPIRED',
      'error', 'A janela de conversão pós-aprovação (' || v_cfg.janela_conversao_horas || ' horas) expirou. É necessário revalidar custos e renovar a proposta com o cliente.'
    );
  END IF;

  -- 4. Construção dos Itens usando ESTRITAMENTE os Snapshots Imutáveis do Orçamento
  -- (Nunca lê o preço atual da tabela produtos nem produto_opcoes!)
  FOR v_item_rec IN
    SELECT
      oi.id AS orcamento_item_id,
      oi.produto_id,
      oi.quantidade,
      oi.preco_unitario_snapshot,
      oi.cmv_unitario_snapshot,
      oi.pontos_producao_snapshot,
      oi.observacoes
    FROM public.orcamento_itens oi
    WHERE oi.orcamento_id = v_orc.id
    ORDER BY oi.id ASC
  LOOP
    SELECT jsonb_agg(
      jsonb_build_object(
        'opcao_nome', oio.opcao_nome,
        'preco_adicional', oio.preco_adicional_snapshot,
        'pontos_producao_adicionais', oio.pontos_producao_adicionais_snapshot,
        'produto_opcao_id', oio.produto_opcao_id
      )
    )
    INTO v_opcoes_payload
    FROM public.orcamento_item_opcoes oio
    WHERE oio.orcamento_item_id = v_item_rec.orcamento_item_id;

    v_itens_payload := v_itens_payload || jsonb_build_array(
      jsonb_build_object(
        'id', v_item_rec.produto_id,
        'quantidade', v_item_rec.quantidade,
        'opcoes', COALESCE(v_opcoes_payload, '[]'::jsonb),
        'observacoes', v_item_rec.observacoes
      )
    );
  END LOOP;

  -- 5. Montagem do Payload para nucleo_criar_encomenda()
  v_nucleo_payload := jsonb_build_object(
    'cliente_id', v_orc.cliente_id,
    'cliente_nome', v_orc.cliente_nome,
    'cliente_telefone', v_orc.cliente_telefone,
    'cliente_email', v_orc.cliente_email,
    'canal', 'orcamento',
    'data_entrega', v_orc.data_evento,
    'hora_entrega', v_orc.hora_evento,
    'modalidade', v_orc.tipo_entrega,
    'endereco_entrega', v_orc.endereco_entrega,
    'itens', v_itens_payload,
    'taxa_entrega', v_orc.taxa_entrega_cobrada,
    'taxa_entrega_base', v_orc.taxa_entrega_base,
    'desconto_frete', v_orc.desconto_frete,
    'desconto', v_orc.desconto_produtos,
    'motivo_desconto', v_orc.motivo_desconto,
    'sinal_minimo', v_orc.sinal_sugerido,
    'sinal_valor', v_sinal_valor,
    'sinal_metodo', v_sinal_metodo,
    'sinal_comprovante', v_sinal_comp,
    'forcar_confirmacao_sem_sinal', v_forcar_sem_sinal,
    'motivo_confirmacao_sem_sinal', v_motivo_sem_sinal,
    'forcar_encaixe', v_forcar_encaixe,
    'motivo_encaixe', v_motivo_encaixe,
    'observacoes_cliente', v_orc.observacoes_cliente,
    'observacoes_internas', 'Convertido a partir do Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || '). ' || COALESCE(v_orc.observacoes_internas, ''),
    'orcamento_origem_id', v_orc.id
  );

  -- 6. Execução do Núcleo Canônico (Locks ordenados, Capacidade, Estoque atômico, Pedido)
  v_nucleo_res := public.nucleo_criar_encomenda(v_nucleo_payload);

  IF NOT COALESCE((v_nucleo_res->>'success')::BOOLEAN, false) THEN
    -- Rollback implícito ou propagação de erro mantendo o orçamento intacto (E3-10)
    RETURN v_nucleo_res;
  END IF;

  v_pedido_id := (v_nucleo_res->>'pedido_id')::BIGINT;

  -- 7. Atualização do Orçamento para Convertido com Vinculação Bidirecional
  UPDATE public.orcamentos SET
    status = 'convertido',
    pedido_id = v_pedido_id,
    convertido_em = NOW(),
    updated_at = NOW()
  WHERE id = v_orc.id;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE u.id = auth.uid();

  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    v_orc.id, 'CONVERTIDO', 'aprovado', 'convertido', v_orc.versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object('pedido_id', v_pedido_id, 'nucleo_resultado', v_nucleo_res)
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'orcamento_id', v_orc.id,
    'numero', v_orc.numero,
    'idempotente', false,
    'detalhes_pedido', v_nucleo_res
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.converter_orcamento_em_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.converter_orcamento_em_pedido_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 15. RPC REGISTRO DE COMUNICAÇÕES WHATSAPP
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_comunicacao_orcamento_admin(
  p_orcamento_id BIGINT,
  p_canal TEXT,
  p_tipo TEXT,
  p_destinatario TEXT,
  p_mensagem TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  INSERT INTO public.orcamento_comunicacoes (
    orcamento_id, canal, tipo, destinatario_telefone, mensagem_preview, disparado_por, metadata
  ) VALUES (
    p_orcamento_id, LOWER(TRIM(p_canal)), LOWER(TRIM(p_tipo)),
    TRIM(p_destinatario), TRIM(p_mensagem), auth.uid(), p_metadata
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'comunicacao_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 16. RPC BUSCAR ORÇAMENTOS (BACKOFFICE / FILTROS E PAGINAÇÃO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_orcamentos_admin(
  p_busca TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_termo TEXT := NULLIF(TRIM(COALESCE(p_busca, '')), '');
  v_st TEXT := NULLIF(TRIM(COALESCE(p_novo_status, p_status, '')), '');
  v_total_registros INT;
  v_lista JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT COUNT(*) INTO v_total_registros
  FROM public.orcamentos o
  WHERE (v_st IS NULL OR o.status = v_st)
    AND (
      v_termo IS NULL OR
      o.numero ILIKE '%' || v_termo || '%' OR
      o.cliente_nome ILIKE '%' || v_termo || '%' OR
      o.cliente_telefone ILIKE '%' || v_termo || '%'
    );

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', o.id,
      'numero', o.numero,
      'versao', o.versao,
      'cliente_id', o.cliente_id,
      'cliente_nome', o.cliente_nome,
      'cliente_telefone', o.cliente_telefone,
      'data_evento', o.data_evento,
      'hora_evento', o.hora_evento,
      'tipo_entrega', o.tipo_entrega,
      'status', o.status,
      'total', o.total,
      'subtotal', o.subtotal,
      'sinal_sugerido', o.sinal_sugerido,
      'validade_ate', o.validade_ate,
      'aprovado_em', o.aprovado_em,
      'janela_conversao_limite', o.janela_conversao_limite,
      'pedido_id', o.pedido_id,
      'token_publico', o.token_publico,
      'visualizacoes_count', o.visualizacoes_count,
      'created_at', o.created_at,
      'itens_count', (SELECT COUNT(*) FROM public.orcamento_itens oi WHERE oi.orcamento_id = o.id)
    )
  )
  INTO v_lista
  FROM (
    SELECT o.*
    FROM public.orcamentos o
    WHERE (v_st IS NULL OR o.status = v_st)
      AND (
        v_termo IS NULL OR
        o.numero ILIKE '%' || v_termo || '%' OR
        o.cliente_nome ILIKE '%' || v_termo || '%' OR
        o.cliente_telefone ILIKE '%' || v_termo || '%'
      )
    ORDER BY o.created_at DESC
    LIMIT GREATEST(1, COALESCE(p_limite, 50))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  ) o;

  RETURN jsonb_build_object(
    'success', true,
    'total', v_total_registros,
    'orcamentos', COALESCE(v_lista, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.buscar_orcamentos_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_orcamentos_admin TO authenticated, service_role;
