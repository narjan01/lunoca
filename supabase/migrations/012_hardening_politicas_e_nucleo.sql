-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 012: HARDENING PRÉ-ETAPA 3 & NÚCLEO CANÔNICO
-- ==========================================================================
-- Decisões Arquiteturais Consolidadas:
-- 1. Loja Online permanece isolada em criar_pedido() (guest/PIX hold curto/carrinho).
-- 2. nucleo_criar_encomenda() atende estritamente a Encomenda Administrativa e Conversão de Orçamento.
-- 3. Funções de política comercial (politica_desconto, politica_sinal, validar_modalidade_frete)
--    resolvem internamente o papel do ator (is_admin / is_admin_or_operator), NUNCA aceitando p_is_admin por parâmetro.
-- 4. Frete completo: taxa_entrega_base, taxa_entrega_cobrada, desconto_frete.
-- 5. pedidos.orcamento_origem_id BIGINT UNIQUE para rastreabilidade bidirecional direta.
-- 6. configuracoes_operacao com parâmetros para orçamentos e frete padrão.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. EXPANSÃO DE CONFIGURACOES_OPERACAO & PEDIDOS
-- --------------------------------------------------------------------------
ALTER TABLE public.configuracoes_operacao
  ADD COLUMN IF NOT EXISTS validade_orcamento_horas INT NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS antecedencia_minima_orcamento_horas INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS janela_conversao_horas INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS taxa_entrega_padrao NUMERIC(10,2) NOT NULL DEFAULT 15.00;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS orcamento_origem_id BIGINT UNIQUE,
  ADD COLUMN IF NOT EXISTS taxa_entrega_base NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS taxa_entrega_cobrada NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS desconto_frete NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS motivo_desconto TEXT;

ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_canal_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_canal_check CHECK (canal IN ('loja_online', 'whatsapp', 'balcao', 'telefone', 'orcamento'));

CREATE INDEX IF NOT EXISTS idx_pedidos_orcamento_origem_id ON public.pedidos(orcamento_origem_id) WHERE orcamento_origem_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 2. POLÍTICA DE DESCONTO COMPARTILHADA (SEM p_is_admin EXTERNO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.politica_desconto(
  p_subtotal NUMERIC,
  p_desconto NUMERIC,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
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

  -- Teto de operador: 10% do subtotal
  IF v_pct > 10.00 AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED',
      'teto_operador_valor', ROUND(v_subtotal * 0.10, 2),
      'error', 'Operadores podem conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10)::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  -- Justificativa auditável obrigatória para QUALQUER desconto > 0 (operador ou admin) (D3)
  IF v_desc > 0.00 AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_REASON_REQUIRED', 'error', 'Por favor, informe a justificativa do desconto concedido (mínimo 5 caracteres).');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'desconto_aprovado', v_desc,
    'percentual', v_pct,
    'excecao_admin', (v_pct > 10.00),
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_desconto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_desconto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. POLÍTICA DE SINAL MÍNIMO COMPARTILHADA (SEM p_is_admin EXTERNO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.politica_sinal(
  p_total NUMERIC,
  p_sinal_solicitado NUMERIC DEFAULT NULL,
  p_forcar_reducao BOOLEAN DEFAULT FALSE,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_total NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_total, 0.00));
  v_sinal_padrao NUMERIC(10,2);
  v_sinal_final NUMERIC(10,2);
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada para avaliar política de sinal.');
  END IF;

  v_sinal_padrao := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);

  -- Dispensar sinal por completo (p_forcar_reducao)
  IF p_forcar_reducao = true THEN
    IF NOT v_is_admin THEN
      RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas Administradores podem dispensar a exigência de sinal mínimo.');
    END IF;
    IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
      RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe o motivo para autorizar a confirmação da encomenda sem sinal (mínimo 5 caracteres).');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'sinal_minimo', 0.00,
      'sinal_padrao', v_sinal_padrao,
      'dispensado', true,
      'motivo', v_motivo
    );
  END IF;

  -- Redução parcial de sinal
  IF v_is_admin THEN
    v_sinal_final := CASE WHEN COALESCE(p_sinal_solicitado, 0.00) <= 0.00 THEN v_sinal_padrao ELSE p_sinal_solicitado END;
    IF v_sinal_final < v_sinal_padrao AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'SIGNAL_REDUCTION_REQUIRES_REASON',
        'sinal_padrao', v_sinal_padrao,
        'error', 'Reduzir o sinal mínimo abaixo do padrão (R$ ' || v_sinal_padrao || ', ' || v_cfg.sinal_percentual_padrao || '% do total) exige justificativa (mínimo 5 caracteres).'
      );
    END IF;
  ELSE
    -- Operador: NUNCA abaixo do padrão
    v_sinal_final := GREATEST(v_sinal_padrao, COALESCE(p_sinal_solicitado, 0.00));
  END IF;

  v_sinal_final := ROUND(v_sinal_final, 2);

  RETURN jsonb_build_object(
    'success', true,
    'sinal_minimo', v_sinal_final,
    'sinal_padrao', v_sinal_padrao,
    'dispensado', false,
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_sinal FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_sinal TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. VALIDAÇÃO DE MODALIDADE E FRETE COMPARTILHADA
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validar_modalidade_frete(
  p_modalidade TEXT,
  p_taxa_informada NUMERIC DEFAULT 0.00,
  p_endereco TEXT DEFAULT NULL,
  p_desconto_frete NUMERIC DEFAULT 0.00,
  p_motivo_frete TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_mod TEXT := LOWER(TRIM(COALESCE(p_modalidade, 'retirada')));
  v_taxa_base NUMERIC(10,2) := 0.00;
  v_taxa_cobrada NUMERIC(10,2) := 0.00;
  v_desc_frete NUMERIC(10,2) := 0.00;
  v_end TEXT := NULLIF(TRIM(COALESCE(p_endereco, '')), '');
BEGIN
  IF v_mod = 'retirada' THEN
    RETURN jsonb_build_object(
      'success', true,
      'modalidade', 'retirada',
      'taxa_entrega_base', 0.00,
      'taxa_entrega_cobrada', 0.00,
      'desconto_frete', 0.00,
      'endereco_entrega', NULL
    );
  ELSIF v_mod = 'entrega' THEN
    IF v_end IS NULL OR length(v_end) < 5 THEN
      RETURN jsonb_build_object('success', false, 'code', 'ADDRESS_REQUIRED_FOR_DELIVERY', 'error', 'Para entrega em domicílio, o endereço completo é obrigatório.');
    END IF;

    -- Se não informada ou zero, usa a taxa padrão da configuração
    v_taxa_base := CASE 
      WHEN p_taxa_informada IS NOT NULL AND p_taxa_informada > 0.00 THEN ROUND(p_taxa_informada, 2)
      ELSE COALESCE(v_cfg.taxa_entrega_padrao, 15.00)
    END;

    v_desc_frete := GREATEST(0.00, COALESCE(p_desconto_frete, 0.00));
    IF v_desc_frete > v_taxa_base THEN
      v_desc_frete := v_taxa_base;
    END IF;

    -- Governança de frete: desconto requer motivo; frete 100% grátis requer perfil Admin
    IF v_desc_frete > 0.00 AND (p_motivo_frete IS NULL OR length(trim(p_motivo_frete)) < 5) THEN
      RETURN jsonb_build_object('success', false, 'code', 'SHIPPING_DISCOUNT_REASON_REQUIRED', 'error', 'Informe a justificativa do desconto de frete (mínimo 5 caracteres).');
    END IF;

    IF v_desc_frete >= v_taxa_base AND v_taxa_base > 0.00 AND NOT public.is_admin() THEN
      RETURN jsonb_build_object('success', false, 'code', 'OPERATOR_FREE_SHIPPING_NOT_ALLOWED', 'error', 'Operadores não podem conceder frete 100% grátis. Ação restrita a Administradores.');
    END IF;

    v_taxa_cobrada := GREATEST(0.00, v_taxa_base - v_desc_frete);

    RETURN jsonb_build_object(
      'success', true,
      'modalidade', 'entrega',
      'taxa_entrega_base', v_taxa_base,
      'taxa_entrega_cobrada', v_taxa_cobrada,
      'desconto_frete', v_desc_frete,
      'endereco_entrega', v_end
    );
  ELSE
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MODALITY', 'error', 'Modalidade de entrega inválida. Use retirada ou entrega.');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.validar_modalidade_frete FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validar_modalidade_frete TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. NÚCLEO CANÔNICO DE ENCOMENDAS: NUCLEO_CRIAR_ENCOMENDA()
-- --------------------------------------------------------------------------
-- Atende estritamente a criar_encomenda_admin() e converter_orcamento_em_pedido().
-- Loja Online permanece isolada em criar_pedido().
-- Ordem de locks: capacidade/data -> produtos (id ASC) -> INSERT pedido -> itens -> reserva -> pagamentos.
CREATE OR REPLACE FUNCTION public.nucleo_criar_encomenda(
  p_dados JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_tz TEXT := v_cfg.timezone;
  v_user_nome TEXT;
  
  -- Cliente
  v_cliente_id_in BIGINT := (p_dados->>'cliente_id')::BIGINT;
  v_cliente_nome_in TEXT := TRIM(COALESCE(p_dados->>'cliente_nome', ''));
  v_cliente_tel_in TEXT := TRIM(COALESCE(p_dados->>'cliente_telefone', ''));
  v_cliente_email_in TEXT := TRIM(COALESCE(p_dados->>'cliente_email', ''));
  v_cliente_id_final BIGINT;
  v_cliente_nome_final TEXT;
  v_cliente_tel_final TEXT;
  v_cliente_email_final TEXT;
  v_tel_norm TEXT;

  -- Logística
  v_canal TEXT := LOWER(TRIM(COALESCE(p_dados->>'canal', 'balcao')));
  v_data_entrega DATE := (p_dados->>'data_entrega')::DATE;
  v_hora_entrega TIME := CASE WHEN (p_dados->>'hora_entrega') IS NOT NULL AND (p_dados->>'hora_entrega') <> '' THEN (p_dados->>'hora_entrega')::TIME ELSE NULL END;
  v_modalidade_in TEXT := COALESCE(p_dados->>'modalidade', 'retirada');
  v_endereco_in TEXT := p_dados->>'endereco_entrega';
  v_frete_val JSONB;

  -- Itens e Totais
  v_itens JSONB := COALESCE(p_dados->'itens', '[]'::jsonb);
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_exc_hint TEXT;
  v_exc_detail TEXT;
  v_pts_pedido_total NUMERIC(8,2) := 0.00;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_produto_ids BIGINT[] := ARRAY[]::BIGINT[];

  -- Desconto e Sinal (via políticas compartilhadas)
  v_desc_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto')::NUMERIC, 0.00));
  v_motivo_desc TEXT := p_dados->>'motivo_desconto';
  v_desc_pol JSONB;
  v_sinal_pol JSONB;
  v_sinal_min NUMERIC(10,2) := 0.00;
  v_sinal_pago NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'sinal_valor')::NUMERIC, 0.00));
  v_sinal_metodo TEXT := LOWER(TRIM(COALESCE(p_dados->>'sinal_metodo', 'pix')));
  v_sinal_comp TEXT := p_dados->>'sinal_comprovante';
  v_forcar_confirm_sem_sinal BOOLEAN := COALESCE((p_dados->>'forcar_confirmacao_sem_sinal')::BOOLEAN, false);
  v_motivo_sem_sinal TEXT := p_dados->>'motivo_confirmacao_sem_sinal';
  v_saldo_venc DATE := CASE WHEN (p_dados->>'saldo_vencimento') IS NOT NULL AND (p_dados->>'saldo_vencimento') <> '' THEN (p_dados->>'saldo_vencimento')::DATE ELSE NULL END;

  -- Capacidade & Encaixe
  v_forcar_encaixe BOOLEAN := COALESCE((p_dados->>'forcar_encaixe')::BOOLEAN, false);
  v_motivo_encaixe TEXT := p_dados->>'motivo_encaixe';
  v_cap public.capacidade_producao;
  v_pontos_ocupados_atuais NUMERIC(8,2) := 0.00;

  -- Estados
  v_status_com_inicial TEXT;
  v_status_fin_inicial TEXT := 'nao_pago';
  v_status_oper_inicial TEXT := 'aguardando_producao';
  v_entrega_at TIMESTAMPTZ;
  v_confirmacao_expires_at TIMESTAMPTZ;

  -- Identificação e Destino
  v_orcamento_origem_id BIGINT := (p_dados->>'orcamento_origem_id')::BIGINT;
  v_pedido_id BIGINT;
  v_item_id BIGINT;
  v_reserva JSON;
  v_pagamento_id BIGINT;
BEGIN
  -- 1. RBAC
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode registrar encomendas.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 2. Canal e Data
  IF v_canal NOT IN ('balcao', 'whatsapp', 'telefone', 'orcamento') THEN
    v_canal := 'balcao';
  END IF;

  IF v_data_entrega IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'DATE_REQUIRED', 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  -- 3. Modalidade e Frete (via função compartilhada)
  v_frete_val := public.validar_modalidade_frete(
    v_modalidade_in,
    COALESCE((p_dados->>'taxa_entrega')::NUMERIC, 0.00),
    v_endereco_in,
    COALESCE((p_dados->>'desconto_frete')::NUMERIC, 0.00),
    p_dados->>'motivo_frete'
  );
  IF NOT COALESCE((v_frete_val->>'success')::BOOLEAN, false) THEN
    RETURN v_frete_val;
  END IF;

  -- 4. Resolução / Cadastro do Cliente
  v_cliente_id_final := NULL;
  IF v_cliente_id_in IS NOT NULL THEN
    SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
    FROM public.clientes WHERE id = v_cliente_id_in;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF length(v_cliente_nome_in) < 2 THEN
      RETURN jsonb_build_object('success', false, 'code', 'CUSTOMER_NAME_REQUIRED', 'error', 'Nome do cliente é obrigatório para registrar a encomenda.');
    END IF;

    v_tel_norm := regexp_replace(v_cliente_tel_in, '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

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
        CASE WHEN (v_frete_val->>'endereco_entrega') IS NOT NULL THEN jsonb_build_object('endereco', v_frete_val->>'endereco_entrega') ELSE '{}'::jsonb END
      ) RETURNING id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final;
    END IF;
  END IF;

  v_cliente_nome_final := COALESCE(NULLIF(v_cliente_nome_in, ''), v_cliente_nome_final);
  v_cliente_tel_final := COALESCE(NULLIF(v_cliente_tel_in, ''), v_cliente_tel_final);
  v_cliente_email_final := COALESCE(NULLIF(v_cliente_email_in, ''), v_cliente_email_final, 'balcao@lunocadoceria.com.br');

  -- 5. Itens: validação, opções, subtotal e pontos
  IF jsonb_typeof(v_itens) = 'string' THEN
    BEGIN
      v_itens := (p_dados->>'itens')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_itens := '[]'::jsonb;
    END;
  END IF;

  IF v_itens IS NULL OR jsonb_typeof(v_itens) <> 'array' OR jsonb_array_length(v_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'A encomenda precisa ter pelo menos um item.');
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

    SELECT id, nome, preco, opcoes, ativo, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_UNAVAILABLE', 'error', 'Produto #' || v_prod_id || ' não está disponível no cardápio.');
    END IF;

    v_produto_ids := array_append(v_produto_ids, v_prod_id);
    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF NOT FOUND THEN
            IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
              v_preco_opt := 0.00;
            ELSE
              RETURN jsonb_build_object(
                'success', false,
                'code', 'INVALID_PRODUCT_OPTION',
                'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '".',
                'produto_id', v_prod.id,
                'opcao', v_opcao_nome
              );
            END IF;
          ELSE
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;

          v_subtotal := v_subtotal + (v_preco_opt * v_qtd);
        END IF;
      END LOOP;
    END IF;

    v_subtotal := v_subtotal + (v_prod.preco * v_qtd);
    v_pts_pedido_total := v_pts_pedido_total + ((v_pts_prod + v_pts_opt_total) * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  IF array_length(v_produto_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'Nenhum item válido informado.');
  END IF;

  -- 6. Política de Desconto (via função compartilhada sem p_is_admin)
  v_desc_pol := public.politica_desconto(v_subtotal, v_desc_in, v_motivo_desc);
  IF NOT COALESCE((v_desc_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_desc_pol;
  END IF;

  v_total := (v_subtotal - (v_desc_pol->>'desconto_aprovado')::NUMERIC) + (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC;

  -- 7. Política de Sinal (via função compartilhada sem p_is_admin)
  v_sinal_pol := public.politica_sinal(
    v_total,
    (p_dados->>'sinal_minimo')::NUMERIC,
    v_forcar_confirm_sem_sinal,
    v_motivo_sem_sinal
  );
  IF NOT COALESCE((v_sinal_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_sinal_pol;
  END IF;

  v_sinal_min := (v_sinal_pol->>'sinal_minimo')::NUMERIC;

  IF v_sinal_pago > v_total THEN
    RETURN jsonb_build_object('success', false, 'code', 'DOWN_PAYMENT_EXCEEDS_TOTAL', 'error', 'Valor do sinal informado excede o total da encomenda.');
  END IF;

  -- Estados iniciais e Hold
  IF v_sinal_min = 0.00 OR v_forcar_confirm_sem_sinal = true OR (v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00) THEN
    v_status_com_inicial := 'confirmado';
    v_confirmacao_expires_at := NULL;
  ELSE
    v_status_com_inicial := 'aguardando_confirmacao';

    v_entrega_at := ((v_data_entrega + COALESCE(v_hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_tz;
    v_confirmacao_expires_at := LEAST(
      NOW() + make_interval(hours => v_cfg.hold_horas_padrao),
      v_entrega_at - make_interval(hours => v_cfg.antecedencia_confirmacao_horas)
    );

    IF v_confirmacao_expires_at <= NOW() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'IMMEDIATE_CONFIRMATION_REQUIRED',
        'error', 'A data/horário de entrega é muito próxima (menos de ' || v_cfg.antecedencia_confirmacao_horas || ' hora(s)). Encomendas imediatas exigem pagamento integral do sinal mínimo (R$ ' || v_sinal_min || ') no ato da criação ou confirmação excepcional por Administrador.',
        'sinal_minimo', v_sinal_min,
        'sinal_pago', v_sinal_pago,
        'entrega_em', v_entrega_at
      );
    END IF;
  END IF;

  -- 8. LOCKS ORDENADOS: capacidade/data -> produtos (id ASC)
  v_cap := public.travar_capacidade_data(v_data_entrega);

  PERFORM 1 FROM public.produtos WHERE id = ANY(v_produto_ids) ORDER BY id FOR UPDATE;

  v_pontos_ocupados_atuais := public.pontos_ocupados_data(v_data_entrega, NULL);

  IF v_cap.bloqueado = true OR (v_pontos_ocupados_atuais + v_pts_pedido_total) > v_cap.capacidade_maxima_pontos THEN
    IF v_forcar_encaixe = true AND public.is_admin() AND (v_motivo_encaixe IS NOT NULL AND length(TRIM(v_motivo_encaixe)) >= 3) THEN
      NULL; -- Encaixe autorizado
    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', v_data_entrega,
        'capacidade_maxima', v_cap.capacidade_maxima_pontos,
        'pontos_ocupados', v_pontos_ocupados_atuais,
        'pontos_solicitados', v_pts_pedido_total,
        'error', 'Capacidade de produção excedida para ' || v_data_entrega || '. Ocupados: ' || v_pontos_ocupados_atuais || ' pts, Solicitados: ' || v_pts_pedido_total || ' pts, Limite: ' || v_cap.capacidade_maxima_pontos || ' pts.'
      );
    END IF;
  END IF;

  -- 9. INSERT PEDIDO
  INSERT INTO public.pedidos (
    cliente_id_rel, nome_cliente, telefone_cliente, email_cliente,
    data_pedido, data_entrega, hora_entrega,
    subtotal, desconto, total, taxa_entrega, taxa_entrega_base, taxa_entrega_cobrada, desconto_frete,
    motivo_desconto, valor_pago, saldo, sinal_minimo, saldo_vencimento,
    modalidade_entrega, canal, pagamento,
    status_comercial, status_financeiro, status_operacional, status,
    itens, endereco_entrega, observacoes_cliente, observacoes_internas,
    confirmacao_expires_at, orcamento_origem_id
  ) VALUES (
    v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final,
    (NOW() AT TIME ZONE v_tz)::DATE, v_data_entrega, v_hora_entrega,
    v_subtotal, (v_desc_pol->>'desconto_aprovado')::NUMERIC, v_total, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
    (v_frete_val->>'taxa_entrega_base')::NUMERIC, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC, (v_frete_val->>'desconto_frete')::NUMERIC,
    v_desc_pol->>'motivo', 0.00, v_total, v_sinal_min, v_saldo_venc,
    v_frete_val->>'modalidade', v_canal, LOWER(TRIM(COALESCE(p_dados->>'sinal_metodo', 'pix'))),
    v_status_com_inicial, v_status_fin_inicial, v_status_oper_inicial, 'Pendente',
    array_to_string(v_nomes_itens, ' + '), COALESCE(v_frete_val->>'endereco_entrega', 'Retirada no Balcão'),
    p_dados->>'observacoes_cliente', p_dados->>'observacoes_internas',
    v_confirmacao_expires_at, v_orcamento_origem_id
  ) RETURNING id INTO v_pedido_id;

  -- 10. INSERT ITENS E OPÇÕES
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

    SELECT id, nome, preco, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);

    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, unidade,
      preco_base_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal,
      cmv_unitario_snapshot, cmv_total_snapshot,
      pontos_producao_snapshot, reserva_estoque_ativa, reserva_ciclo
    ) VALUES (
      v_pedido_id, v_prod_id, v_prod.nome, v_qtd, 'un',
      v_prod.preco, 0.00, v_prod.preco, (v_prod.preco * v_qtd),
      0.00, 0.00,
      v_pts_prod, false, 0
    ) RETURNING id INTO v_item_id;

    v_pts_opt_total := 0.00;
    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, categoria, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id, produto_opcao_id, tipo, opcao_nome, preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, v_opt_rec.id, v_opt_rec.categoria, v_opcao_nome, COALESCE(v_opt_rec.preco_adicional, 0.00),
              COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
          ELSE
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id, tipo, opcao_nome, preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, 'outro', v_opcao_nome, 0.00,
              0.00
            );
            v_preco_opt := 0.00;
          END IF;
          v_pts_opt_total := v_pts_opt_total + v_preco_opt;
        END IF;
      END LOOP;
    END IF;

    IF v_pts_opt_total > 0.00 THEN
      UPDATE public.pedido_itens
      SET preco_adicionais = v_pts_opt_total,
          preco_unitario_snapshot = preco_base_snapshot + v_pts_opt_total,
          subtotal = (preco_base_snapshot + v_pts_opt_total) * quantidade
      WHERE id = v_item_id;
    END IF;
  END LOOP;

  -- 11. RESERVA DE ESTOQUE ATÔMICA VIA HELPER CANÔNICO (Opção A)
  v_reserva := public.reservar_estoque_itens_pedido(
    v_pedido_id,
    'Reserva da encomenda #' || v_pedido_id || ' (' || array_to_string(v_nomes_itens, ', ') || ')',
    true
  );

  IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = COALESCE(v_reserva->>'error', 'Estoque insuficiente para a encomenda.'),
      DETAIL = COALESCE(v_reserva::TEXT, '{}'),
      HINT = 'INSUFFICIENT_STOCK';
  END IF;

  -- 12. PAGAMENTO DE SINAL (se informado)
  IF v_sinal_pago > 0.00 THEN
    INSERT INTO public.pedido_pagamentos (
      pedido_id, valor, metodo, provider, provider_payment_id,
      status, pago_em, registrado_por, comprovante_url, observacoes
    ) VALUES (
      v_pedido_id, v_sinal_pago, v_sinal_metodo, 'manual', NULL,
      'aprovado', NOW(), auth.uid(), v_sinal_comp, 'Sinal de entrada registrado na abertura da encomenda'
    ) RETURNING id INTO v_pagamento_id;

    -- Lançamento financeiro com idempotência estrutural no DRE
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      origem_tipo,
      origem_id,
      evento,
      observacoes
    ) VALUES (
      'receita',
      'Vendas',
      'Entrada Encomenda #' || v_pedido_id || ' (' || TRIM(v_cliente_nome_final) || ')',
      v_sinal_pago,
      CURRENT_DATE,
      v_sinal_metodo,
      v_pedido_id,
      'pedido_pagamento',
      v_pagamento_id,
      'recebimento',
      'Recebimento de entrada da encomenda via ' || upper(v_sinal_metodo)
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 13. HISTÓRICO DE AUDITORIA
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo,
    usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    v_pedido_id, 'comercial', NULL, v_status_com_inicial,
    auth.uid(), v_user_nome, CASE WHEN auth.role() = 'service_role' THEN 'sistema' ELSE 'admin' END,
    jsonb_build_object(
      'acao', 'CRIAR_ENCOMENDA',
      'canal', v_canal,
      'total', v_total,
      'subtotal', v_subtotal,
      'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      'sinal_minimo', v_sinal_min,
      'sinal_pago', v_sinal_pago,
      'confirmacao_expires_at', v_confirmacao_expires_at,
      'pontos_totais', v_pts_pedido_total,
      'forcar_encaixe', v_forcar_encaixe,
      'reserva', v_reserva,
      'orcamento_origem_id', v_orcamento_origem_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'cliente_id', v_cliente_id_final,
    'total', v_total,
    'subtotal', v_subtotal,
    'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
    'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
    'sinal_minimo', v_sinal_min,
    'sinal_padrao', (v_sinal_pol->>'sinal_padrao')::NUMERIC,
    'status_comercial', v_status_com_inicial,
    'status_financeiro', CASE WHEN v_sinal_pago >= v_total THEN 'pago' WHEN v_sinal_pago > 0 THEN 'parcialmente_pago' ELSE 'nao_pago' END,
    'pontos_carga', v_pts_pedido_total,
    'confirmacao_expires_at', v_confirmacao_expires_at,
    'reserva', v_reserva,
    'reserva_estoque', v_reserva
  );
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_exc_hint = PG_EXCEPTION_HINT, v_exc_detail = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object(
      'success', false,
      'code', COALESCE(NULLIF(v_exc_hint, ''), 'DOMAIN_ERROR'),
      'error', SQLERRM,
      'detalhes', CASE WHEN v_exc_detail ~ '^\{' THEN v_exc_detail::JSONB ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.nucleo_criar_encomenda FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nucleo_criar_encomenda TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. REFACTOR CRIAR_ENCOMENDA_ADMIN (CHAMADOR DO NÚCLEO CANÔNICO)
-- --------------------------------------------------------------------------
-- Mantém 100% de compatibilidade de assinatura e retorno com o frontend da Etapa 2.
CREATE OR REPLACE FUNCTION public.criar_encomenda_admin(
  p_cliente_id BIGINT DEFAULT NULL,
  p_cliente_nome TEXT DEFAULT NULL,
  p_cliente_telefone TEXT DEFAULT NULL,
  p_cliente_email TEXT DEFAULT NULL,
  p_canal TEXT DEFAULT 'balcao',
  p_data_entrega DATE DEFAULT NULL,
  p_hora_entrega TIME DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'retirada',
  p_endereco_entrega TEXT DEFAULT NULL,
  p_itens JSONB DEFAULT '[]'::jsonb,
  p_taxa_entrega NUMERIC DEFAULT 0.00,
  p_desconto NUMERIC DEFAULT 0.00,
  p_motivo_desconto TEXT DEFAULT NULL,
  p_sinal_minimo NUMERIC DEFAULT 0.00,
  p_sinal_valor NUMERIC DEFAULT 0.00,
  p_sinal_metodo TEXT DEFAULT 'pix',
  p_sinal_comprovante TEXT DEFAULT NULL,
  p_saldo_vencimento DATE DEFAULT NULL,
  p_forcar_confirmacao_sem_sinal BOOLEAN DEFAULT false,
  p_motivo_confirmacao_sem_sinal TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL,
  p_observacoes_cliente TEXT DEFAULT NULL,
  p_observacoes_internas TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_res JSONB;
BEGIN
  v_res := public.nucleo_criar_encomenda(
    jsonb_build_object(
      'cliente_id', p_cliente_id,
      'cliente_nome', p_cliente_nome,
      'cliente_telefone', p_cliente_telefone,
      'cliente_email', p_cliente_email,
      'canal', p_canal,
      'data_entrega', p_data_entrega,
      'hora_entrega', p_hora_entrega,
      'modalidade', p_modalidade,
      'endereco_entrega', p_endereco_entrega,
      'itens', p_itens,
      'taxa_entrega', p_taxa_entrega,
      'desconto', p_desconto,
      'motivo_desconto', p_motivo_desconto,
      'sinal_minimo', p_sinal_minimo,
      'sinal_valor', p_sinal_valor,
      'sinal_metodo', p_sinal_metodo,
      'sinal_comprovante', p_sinal_comprovante,
      'saldo_vencimento', p_saldo_vencimento,
      'forcar_confirmacao_sem_sinal', p_forcar_confirmacao_sem_sinal,
      'motivo_confirmacao_sem_sinal', p_motivo_confirmacao_sem_sinal,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe,
      'observacoes_cliente', p_observacoes_cliente,
      'observacoes_internas', p_observacoes_internas
    )
  );

  RETURN v_res::JSON;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. HARDENING DE ALTERAR_STATUS_PEDIDO (FECHAMENTO DE BRECHAS S3 / S3b)
-- --------------------------------------------------------------------------
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
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

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

  ELSIF p_dimensao = 'comercial' THEN
    v_status_antigo := v_ped.status_comercial;

    IF p_novo_status NOT IN ('aguardando_confirmacao', 'confirmado', 'cancelado', 'concluido') THEN
      RETURN json_build_object('success', false, 'error', 'Status comercial inválido: ' || p_novo_status);
    END IF;

    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_confirmacao' AND p_novo_status = 'confirmado' THEN
      -- S3: Bloqueio de confirmação comercial sem sinal por operador
      IF v_ped.valor_pago < v_ped.sinal_minimo THEN
        IF NOT v_is_admin THEN
          RETURN json_build_object(
            'success', false,
            'code', 'SIGNAL_REQUIRED',
            'error', 'Confirmação comercial sem sinal pago integral (R$ ' || v_ped.sinal_minimo || ') requer privilégio de Administrador e justificativa.'
          );
        END IF;
        IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
          RETURN json_build_object(
            'success', false,
            'code', 'REASON_REQUIRED',
            'error', 'Administrador confirmando sem sinal mínimo deve informar justificativa auditável (mínimo 5 caracteres).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'aguardando_confirmacao' AND p_novo_status = 'cancelado' THEN
      -- S3b: Cancelamento com valor pago exige destino do valor (operadores)
      IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
        IF COALESCE(p_metadata->>'destino_valor', '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
          RETURN json_build_object(
            'success', false,
            'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
            'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'confirmado' AND p_novo_status = 'cancelado' THEN
      -- Guarda de produção: se produção já iniciou, cancelar exige privilégio de Administrador
      IF v_ped.status_operacional NOT IN ('aguardando_producao', 'cancelado') AND NOT v_is_admin THEN
        RETURN json_build_object(
          'success', false,
          'code', 'PRODUCTION_ACTIVE_CANCEL_DENIED',
          'error', 'A produção deste pedido já foi iniciada. Cancelamentos nesta fase requerem autorização de Administrador.'
        );
      END IF;

      -- S3b: Cancelamento com valor pago exige destino do valor (operadores)
      IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
        IF COALESCE(p_metadata->>'destino_valor', '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
          RETURN json_build_object(
            'success', false,
            'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
            'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'confirmado' AND p_novo_status = 'concluido' THEN
      v_permitido := true;
    ELSIF v_is_admin THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição comercial não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_comercial = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

  ELSE
    RETURN json_build_object('success', false, 'error', 'Dimensão de status inválida. Use "operacional" ou "comercial". Para financeiro, registre pagamentos.');
  END IF;

  -- Gravação auditável do histórico
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
    p_pedido_id,
    p_dimensao,
    v_status_antigo,
    p_novo_status,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object('motivo', v_motivo) || COALESCE(p_metadata, '{}'::JSONB)
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'dimensao', p_dimensao,
    'status_anterior', v_status_antigo,
    'status_novo', p_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. TRIGGER DE PROTEÇÃO DE ESTOQUE EM PRODUTOS (ANTI-INFLAÇÃO NO CATÁLOGO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_proteger_estoque_produtos()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Mutação de estoque_reservado é estritamente restrita a helpers internos e service_role
  IF NEW.estoque_reservado IS DISTINCT FROM OLD.estoque_reservado THEN
    IF current_setting('lunoca.internal_stock_mutation', true) IS DISTINCT FROM 'on' AND auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Modificação direta de estoque_reservado não é permitida. Use os fluxos de reserva/liberação.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Mutação de estoque_fisico requer privilégio de Administrador, service_role ou helper interno
  IF NEW.estoque_fisico IS DISTINCT FROM OLD.estoque_fisico THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role' OR current_setting('lunoca.internal_stock_mutation', true) = 'on') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o saldo de estoque físico do produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_proteger_estoque_produtos ON public.produtos;
CREATE TRIGGER trg_proteger_estoque_produtos
  BEFORE UPDATE ON public.produtos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_proteger_estoque_produtos();
