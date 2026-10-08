-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 010: OPERAÇÃO DIÁRIA & CONFECTIONERY OS CORE (ETAPA 2)
-- ==========================================================================
-- Implementa:
-- 1. Entidade canônica public.clientes com RLS fechado e índices de unicidade
-- 2. Vínculo comercial pedidos.cliente_id_rel com backfill idempotente
-- 3. Snapshots imutáveis de carga produtiva em itens e opções
-- 4. Tabela public.capacidade_producao com lock pessimista serializável
-- 5. Trigger recalcular_financeiro_pedido com confirmação automática por sinal
--    e guarda de produção em estornos (não regride produção nem concluído)
-- 6. RPC buscar_clientes_admin (busca rápida por telefone ou nome)
-- 7. RPC criar_encomenda_admin (governança de sinal, desconto máx 10%, anti-overbooking)
-- 8. RPC reagendar_encomenda_admin (inicialização concorrente e lock anti-deadlock)
-- 9. RPC obter_resumo_operacao_hoje (métricas via ledger contábil e America/Fortaleza)
-- 10. RPC obter_agenda_encomendas (agenda tri-modo com capacidade dinâmica derivada)
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. TABELA CANÔNICA DE CLIENTES (CRM E OPERAÇÃO DESACOPLADA DE AUTH)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes (
  id BIGSERIAL PRIMARY KEY,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  telefone TEXT,
  telefone_normalizado TEXT, -- apenas dígitos com DDD (ex: 5585999999999)
  email TEXT,
  cpf TEXT,
  data_nascimento DATE,
  endereco_padrao JSONB DEFAULT '{}'::JSONB,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_auth_user_id 
  ON public.clientes(auth_user_id) 
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_telefone_normalizado 
  ON public.clientes(telefone_normalizado) 
  WHERE telefone_normalizado IS NOT NULL AND telefone_normalizado <> '';

CREATE INDEX IF NOT EXISTS idx_clientes_nome_lower 
  ON public.clientes(LOWER(nome));

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clientes FROM PUBLIC, anon, authenticated;

-- Políticas de RLS fechadas em clientes
DROP POLICY IF EXISTS "Equipe ou dono visualiza clientes" ON public.clientes;
CREATE POLICY "Equipe ou dono visualiza clientes" ON public.clientes
  FOR SELECT USING (
    public.is_admin_or_operator() OR (auth_user_id IS NOT NULL AND auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Equipe gerencia clientes" ON public.clientes;
CREATE POLICY "Equipe gerencia clientes" ON public.clientes
  FOR ALL USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

GRANT SELECT, INSERT, UPDATE ON public.clientes TO service_role, authenticated;

-- --------------------------------------------------------------------------
-- 2. VÍNCULO COMERCIAL CANÔNICO EM PEDIDOS & BACKFILL IDEMPOTENTE
-- --------------------------------------------------------------------------
ALTER TABLE public.pedidos 
  ADD COLUMN IF NOT EXISTS cliente_id_rel BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id_rel 
  ON public.pedidos(cliente_id_rel);

-- Backfill idempotente de profiles existentes para a tabela clientes
DO $$
DECLARE
  r RECORD;
  v_tel_norm TEXT;
  v_cid BIGINT;
BEGIN
  FOR r IN SELECT id, nome, email, telefone, cpf, endereco, numero, complemento, cep FROM public.profiles LOOP
    v_tel_norm := regexp_replace(COALESCE(r.telefone, ''), '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    -- Inserir ou reaproveitar cliente
    IF v_tel_norm IS NOT NULL THEN
      INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email, cpf, endereco_padrao)
      VALUES (
        r.id,
        r.nome,
        r.telefone,
        v_tel_norm,
        r.email,
        r.cpf,
        jsonb_build_object('endereco', r.endereco, 'numero', r.numero, 'complemento', r.complemento, 'cep', r.cep)
      )
      ON CONFLICT (telefone_normalizado) WHERE telefone_normalizado IS NOT NULL AND telefone_normalizado <> ''
      DO UPDATE SET auth_user_id = COALESCE(public.clientes.auth_user_id, EXCLUDED.auth_user_id)
      RETURNING id INTO v_cid;
    ELSE
      INSERT INTO public.clientes (auth_user_id, nome, telefone, email, cpf, endereco_padrao)
      VALUES (
        r.id,
        r.nome,
        r.telefone,
        r.email,
        r.cpf,
        jsonb_build_object('endereco', r.endereco, 'numero', r.numero, 'complemento', r.complemento, 'cep', r.cep)
      )
      ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
      DO NOTHING
      RETURNING id INTO v_cid;
    END IF;

    IF v_cid IS NOT NULL THEN
      UPDATE public.pedidos 
      SET cliente_id_rel = v_cid 
      WHERE cliente_id = r.id AND cliente_id_rel IS NULL;
    END IF;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 3. SNAPSHOTS DE CARGA PRODUTIVA EM PRODUTOS, OPÇÕES E ITENS
-- --------------------------------------------------------------------------
ALTER TABLE public.produtos 
  ADD COLUMN IF NOT EXISTS pontos_producao NUMERIC(6,2) NOT NULL DEFAULT 1.00;

ALTER TABLE public.produto_opcoes 
  ADD COLUMN IF NOT EXISTS pontos_producao_adicionais NUMERIC(6,2) NOT NULL DEFAULT 0.00;

ALTER TABLE public.pedido_itens 
  ADD COLUMN IF NOT EXISTS pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00;

ALTER TABLE public.pedido_item_opcoes 
  ADD COLUMN IF NOT EXISTS produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL;

ALTER TABLE public.pedido_item_opcoes 
  ADD COLUMN IF NOT EXISTS pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00;

-- --------------------------------------------------------------------------
-- 4. CAPACIDADE DIÁRIA DE PRODUÇÃO (ÂNCORA SERIALIZÁVEL)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capacidade_producao (
  id BIGSERIAL PRIMARY KEY,
  data DATE NOT NULL UNIQUE,
  capacidade_maxima_pontos NUMERIC(8,2) NOT NULL DEFAULT 30.00,
  bloqueado BOOLEAN NOT NULL DEFAULT false,
  motivo_bloqueio TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capacidade_data 
  ON public.capacidade_producao(data);

ALTER TABLE public.capacidade_producao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capacidade_producao FROM PUBLIC, anon;

DROP POLICY IF EXISTS "Equipe visualiza capacidade" ON public.capacidade_producao;
CREATE POLICY "Equipe visualiza capacidade" ON public.capacidade_producao
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam capacidade" ON public.capacidade_producao;
CREATE POLICY "Admins gerenciam capacidade" ON public.capacidade_producao
  FOR ALL USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT ON public.capacidade_producao TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.capacidade_producao TO service_role;

-- --------------------------------------------------------------------------
-- 5. TRIGGER RECALCULAR_FINANCEIRO_PEDIDO ATUALIZADO (CONFIRMAÇÃO & GUARDA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_ped_id BIGINT := COALESCE(NEW.pedido_id, OLD.pedido_id);
  v_total NUMERIC(10,2);
  v_sinal_minimo NUMERIC(10,2);
  v_status_com_antigo TEXT;
  v_status_oper_antigo TEXT;
  v_pago NUMERIC(10,2);
  v_saldo NUMERIC(10,2);
  v_status_fin_antigo TEXT;
  v_novo_status_fin TEXT;
  v_novo_status_com TEXT;
  v_tem_estorno BOOLEAN := false;
BEGIN
  SELECT 
    total, sinal_minimo, status_comercial, status_operacional, status_financeiro 
  INTO 
    v_total, v_sinal_minimo, v_status_com_antigo, v_status_oper_antigo, v_status_fin_antigo 
  FROM public.pedidos 
  WHERE id = v_ped_id;
  
  -- Soma estritamente pagamentos aprovados
  SELECT COALESCE(SUM(valor), 0) INTO v_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = v_ped_id AND status = 'aprovado';

  v_saldo := GREATEST(0, COALESCE(v_total, 0) - v_pago);

  -- Verifica se existem pagamentos com status 'estornado'
  SELECT EXISTS (
    SELECT 1 FROM public.pedido_pagamentos 
    WHERE pedido_id = v_ped_id AND status = 'estornado'
  ) INTO v_tem_estorno;

  -- Transição determinística do status financeiro
  IF v_tem_estorno AND v_pago <= 0 THEN
    v_novo_status_fin := 'estornado';
  ELSIF v_pago <= 0 THEN
    v_novo_status_fin := 'nao_pago';
  ELSIF v_saldo <= 0 THEN
    v_novo_status_fin := 'pago';
  ELSE
    v_novo_status_fin := 'parcialmente_pago';
  END IF;

  v_novo_status_com := v_status_com_antigo;

  -- Regra 1: Confirmação Automática por Sinal Posterior
  IF v_sinal_minimo > 0 AND v_pago >= v_sinal_minimo AND v_status_com_antigo = 'aguardando_confirmacao' THEN
    v_novo_status_com := 'confirmado';
  END IF;

  -- Regra 2: Guarda de Produção em caso de Estorno do Sinal
  IF v_sinal_minimo > 0 AND v_pago < v_sinal_minimo THEN
    IF v_status_oper_antigo = 'aguardando_producao' AND v_status_com_antigo = 'confirmado' THEN
      -- Antes da produção: reverte para aguardando_confirmacao
      v_novo_status_com := 'aguardando_confirmacao';
    ELSE
      -- Durante/após produção ou se já concluído: NÃO regride status_comercial
      v_novo_status_com := v_status_com_antigo;
    END IF;
  END IF;

  UPDATE public.pedidos
  SET 
    valor_pago = v_pago,
    saldo = v_saldo,
    status_financeiro = v_novo_status_fin,
    status_comercial = v_novo_status_com,
    possui_estorno = v_tem_estorno,
    updated_at = NOW()
  WHERE id = v_ped_id;

  -- Lançamento contábil compensatório no financeiro ao estornar pagamento aprovado (idempotência estrutural garantida)
  IF TG_OP = 'UPDATE' AND OLD.status = 'aprovado' AND NEW.status = 'estornado' THEN
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
      'despesa',
      'Estornos',
      'Estorno de Pagamento #' || NEW.id || ' do Pedido #' || v_ped_id || ' (' || upper(NEW.metodo) || ')',
      NEW.valor,
      CURRENT_DATE,
      NEW.metodo,
      v_ped_id,
      'pedido_pagamento',
      NEW.id,
      'estorno',
      'Estorno financeiro contábil automático via pedido_pagamentos #' || NEW.id
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- Auditoria se o status financeiro mudou
  IF v_status_fin_antigo IS DISTINCT FROM v_novo_status_fin THEN
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, 
      usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      v_ped_id,
      'financeiro',
      COALESCE(v_status_fin_antigo, 'nao_pago'),
      v_novo_status_fin,
      auth.uid(),
      'Sistema / Trigger Financeiro',
      CASE 
        WHEN auth.role() = 'service_role' THEN 'sistema'
        WHEN public.is_admin_or_operator() THEN 'admin'
        ELSE 'sistema'
      END,
      jsonb_build_object(
        'motivo', 'Recálculo automático via pedido_pagamentos',
        'valor_pago', v_pago,
        'saldo', v_saldo,
        'tem_estorno', v_tem_estorno
      )
    );
  END IF;

  -- Auditoria se o status comercial mudou automaticamente pelo sinal
  IF v_status_com_antigo IS DISTINCT FROM v_novo_status_com THEN
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, 
      usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      v_ped_id,
      'comercial',
      v_status_com_antigo,
      v_novo_status_com,
      auth.uid(),
      'Sistema / Gatilho de Sinal',
      'sistema',
      jsonb_build_object(
        'motivo', CASE 
          WHEN v_novo_status_com = 'confirmado' THEN 'Sinal mínimo atingido por pagamento acumulado'
          ELSE 'Estorno de sinal reduziu valor pago abaixo do mínimo antes do início da produção'
        END,
        'valor_pago', v_pago,
        'sinal_minimo', v_sinal_minimo
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- --------------------------------------------------------------------------
-- 6. RPC BUSCAR_CLIENTES_ADMIN (AUTOCOMPLETE LEVE & PROTEGIDO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_clientes_admin(
  p_busca TEXT,
  p_limite INT DEFAULT 10
)
RETURNS JSON AS $$
DECLARE
  v_termo TEXT := TRIM(COALESCE(p_busca, ''));
  v_termo_norm TEXT;
  v_resultados JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas equipe autorizada pode consultar clientes.');
  END IF;

  IF length(v_termo) < 2 THEN
    RETURN json_build_object('success', true, 'clientes', '[]'::jsonb);
  END IF;

  v_termo_norm := regexp_replace(v_termo, '\D', '', 'g');

  SELECT jsonb_agg(sub) INTO v_resultados
  FROM (
    SELECT 
      c.id,
      c.nome,
      c.telefone,
      c.telefone_normalizado,
      c.email,
      c.endereco_padrao,
      (
        SELECT MAX(p.data_pedido) 
        FROM public.pedidos p 
        WHERE p.cliente_id_rel = c.id
      ) AS ultima_compra_data,
      (
        SELECT COUNT(*) 
        FROM public.pedidos p 
        WHERE p.cliente_id_rel = c.id
      ) AS total_pedidos
    FROM public.clientes c
    WHERE 
      LOWER(c.nome) LIKE '%' || LOWER(v_termo) || '%'
      OR (v_termo_norm <> '' AND c.telefone_normalizado LIKE '%' || v_termo_norm || '%')
      OR (c.email IS NOT NULL AND LOWER(c.email) LIKE '%' || LOWER(v_termo) || '%')
    ORDER BY c.updated_at DESC
    LIMIT LEAST(GREATEST(p_limite, 1), 20)
  ) sub;

  RETURN json_build_object(
    'success', true,
    'clientes', COALESCE(v_resultados, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.buscar_clientes_admin(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_admin(TEXT, INT) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. RPC CRIAR_ENCOMENDA_ADMIN (BALCÃO / WHATSAPP / TELEFONE)
-- --------------------------------------------------------------------------
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
  v_user_nome TEXT;
  v_cliente_id_final BIGINT;
  v_tel_norm TEXT;
  v_canal_norm TEXT;
  v_modalidade_norm TEXT;
  v_taxa NUMERIC(10,2) := 0.00;
  v_desconto NUMERIC(10,2) := 0.00;
  v_sinal_min NUMERIC(10,2) := 0.00;
  v_sinal_pago NUMERIC(10,2) := 0.00;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_opcao RECORD;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_pts_pedido_total NUMERIC(8,2) := 0.00;
  v_cap RECORD;
  v_pontos_ocupados_atuais NUMERIC(8,2) := 0.00;
  v_status_com_inicial TEXT;
  v_status_fin_inicial TEXT := 'nao_pago';
  v_status_oper_inicial TEXT := 'aguardando_producao';
  v_pedido_id BIGINT;
  v_item_id BIGINT;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_itens_json_canonical JSONB := '[]'::jsonb;
  v_pagamento_id BIGINT;
BEGIN
  -- 1. Validação de RBAC
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem lançar encomendas.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 2. Validações de Canal e Data
  v_canal_norm := LOWER(TRIM(COALESCE(p_canal, 'balcao')));
  IF v_canal_norm NOT IN ('balcao', 'whatsapp', 'telefone') THEN
    RETURN json_build_object('success', false, 'error', 'Canal de encomenda inválido. Use balcao, whatsapp ou telefone.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  -- 3. Validações de Modalidade e Entrega
  v_modalidade_norm := LOWER(TRIM(COALESCE(p_modalidade, 'retirada')));
  IF v_modalidade_norm = 'retirada' THEN
    v_taxa := 0.00;
  ELSIF v_modalidade_norm = 'entrega' THEN
    IF p_endereco_entrega IS NULL OR length(TRIM(p_endereco_entrega)) < 5 THEN
      RETURN json_build_object('success', false, 'error', 'Para entrega em domicílio, o endereço completo é obrigatório.');
    END IF;
    v_taxa := GREATEST(0.00, COALESCE(p_taxa_entrega, 0.00));
  ELSE
    RETURN json_build_object('success', false, 'error', 'Modalidade de entrega inválida. Use retirada ou entrega.');
  END IF;

  -- 4. Resolução ou Cadastro de Cliente em public.clientes
  v_cliente_id_final := p_cliente_id;
  IF v_cliente_id_final IS NOT NULL THEN
    SELECT id INTO v_cliente_id_final FROM public.clientes WHERE id = p_cliente_id;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF p_cliente_nome IS NULL OR length(TRIM(p_cliente_nome)) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Nome do cliente é obrigatório para registrar a encomenda.');
    END IF;

    v_tel_norm := regexp_replace(COALESCE(p_cliente_telefone, ''), '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id INTO v_cliente_id_final FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (
        nome, telefone, telefone_normalizado, email, endereco_padrao
      ) VALUES (
        TRIM(p_cliente_nome),
        TRIM(p_cliente_telefone),
        v_tel_norm,
        TRIM(p_cliente_email),
        CASE WHEN p_endereco_entrega IS NOT NULL THEN jsonb_build_object('endereco', p_endereco_entrega) ELSE '{}'::jsonb END
      ) RETURNING id INTO v_cliente_id_final;
    END IF;
  END IF;

  -- 5. Validação dos Itens e Pré-Cálculo de Subtotal e Pontos
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'A encomenda precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, opcoes, ativo, pontos_producao 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Produto #' || v_prod_id || ' não está disponível no cardápio.');
    END IF;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    -- Pré-validação Fail-Closed de opções
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
            -- Compatibilidade legada com produtos.opcoes
            IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
              v_preco_opt := 0.00;
            ELSE
              RETURN json_build_object(
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

  -- 6. Política Rigorosa de Descontos
  v_desconto := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  IF v_desconto > v_subtotal THEN
    RETURN json_build_object('success', false, 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  IF v_desconto > (v_subtotal * 0.10) AND NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false, 
      'error', 'Operadores podem conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10)::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  IF v_desconto > 0 AND public.is_admin() AND (p_motivo_desconto IS NULL OR length(TRIM(p_motivo_desconto)) < 3) THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do desconto concedido.');
  END IF;

  v_total := (v_subtotal - v_desconto) + v_taxa;

  -- 7. Trava Concorrente de Capacidade Produtiva (Anti-Overbooking)
  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (p_data_entrega, 30.00)
  ON CONFLICT (data) DO NOTHING;

  SELECT * INTO v_cap
  FROM public.capacidade_producao
  WHERE data = p_data_entrega
  FOR UPDATE;

  -- Carga ocupada calculada estritamente sobre os snapshots dos pedidos reais não cancelados
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  INTO v_pontos_ocupados_atuais
  FROM public.pedidos ped
  JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE ped.data_entrega = p_data_entrega
    AND ped.status_comercial <> 'cancelado';

  IF v_cap.bloqueado = true OR (v_pontos_ocupados_atuais + v_pts_pedido_total) > v_cap.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      -- Permissão especial de Admin para encaixe justificado
      NULL;
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_data_entrega,
        'capacidade_maxima', v_cap.capacidade_maxima_pontos,
        'pontos_ocupados', v_pontos_ocupados_atuais,
        'pontos_solicitados', v_pts_pedido_total,
        'error', 'Capacidade de produção excedida para ' || p_data_entrega || ' (' || v_pontos_ocupados_atuais || '/' || v_cap.capacidade_maxima_pontos || ' pts ocupados). Requer autorização de Administrador para encaixe extraordinário.'
      );
    END IF;
  END IF;

  -- 8. Definição da Matriz de Estados Iniciais
  v_sinal_min := GREATEST(0.00, COALESCE(p_sinal_minimo, 0.00));
  v_sinal_pago := GREATEST(0.00, COALESCE(p_sinal_valor, 0.00));

  IF v_sinal_pago > v_total THEN
    RETURN json_build_object('success', false, 'error', 'Valor do sinal informado excede o total da encomenda.');
  END IF;

  -- Governança de confirmar sem sinal
  IF p_forcar_confirmacao_sem_sinal = true THEN
    IF NOT public.is_admin() THEN
      RETURN json_build_object('success', false, 'error', 'Apenas Administradores podem dispensar a exigência de sinal mínimo.');
    END IF;
    IF p_motivo_confirmacao_sem_sinal IS NULL OR length(TRIM(p_motivo_confirmacao_sem_sinal)) < 3 THEN
      RETURN json_build_object('success', false, 'error', 'Informe o motivo para autorizar a confirmação da encomenda sem sinal.');
    END IF;
  END IF;

  IF v_sinal_min = 0.00 OR p_forcar_confirmacao_sem_sinal = true OR (v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00) THEN
    v_status_com_inicial := 'confirmado';
  ELSE
    v_status_com_inicial := 'aguardando_confirmacao';
  END IF;

  -- 9. Inserção do Pedido
  INSERT INTO public.pedidos (
    cliente_id_rel,
    nome_cliente,
    telefone_cliente,
    email_cliente,
    data_pedido,
    data_entrega,
    hora_entrega,
    subtotal,
    desconto,
    total,
    taxa_entrega,
    valor_pago,
    saldo,
    sinal_minimo,
    saldo_vencimento,
    modalidade_entrega,
    canal,
    pagamento,
    status_comercial,
    status_financeiro,
    status_operacional,
    status,
    itens,
    endereco_entrega,
    observacoes_cliente,
    observacoes_internas
  ) VALUES (
    v_cliente_id_final,
    TRIM(p_cliente_nome),
    TRIM(p_cliente_telefone),
    COALESCE(TRIM(p_cliente_email), 'balcao@lunocadoceria.com.br'),
    CURRENT_DATE,
    p_data_entrega,
    p_hora_entrega,
    v_subtotal,
    v_desconto,
    v_total,
    v_taxa,
    0.00,
    v_total,
    v_sinal_min,
    p_saldo_vencimento,
    v_modalidade_norm,
    v_canal_norm,
    LOWER(TRIM(COALESCE(p_sinal_metodo, 'pix'))),
    v_status_com_inicial,
    v_status_fin_inicial,
    v_status_oper_inicial,
    'Pendente',
    array_to_string(v_nomes_itens, ' + '),
    COALESCE(p_endereco_entrega, 'Retirada no Balcão'),
    p_observacoes_cliente,
    p_observacoes_internas
  ) RETURNING id INTO v_pedido_id;

  -- 10. Gravação Canônica em pedido_itens e pedido_item_opcoes com Snapshots de Pontos
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
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
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      unidade,
      preco_base_snapshot,
      preco_adicionais,
      preco_unitario_snapshot,
      subtotal,
      pontos_producao_snapshot
    ) VALUES (
      v_pedido_id,
      v_prod.id,
      v_prod.nome,
      v_qtd,
      'un',
      v_prod.preco,
      0.00,
      v_prod.preco,
      (v_prod.preco * v_qtd),
      v_pts_prod
    ) RETURNING id INTO v_item_id;

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
              pedido_item_id,
              produto_opcao_id,
              tipo,
              opcao_nome,
              preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id,
              v_opt_rec.id,
              v_opt_rec.categoria,
              v_opcao_nome,
              COALESCE(v_opt_rec.preco_adicional, 0.00),
              COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
          ELSE
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id,
              tipo,
              opcao_nome,
              preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id,
              'outro',
              v_opcao_nome,
              0.00,
              0.00
            );
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- 11. Entrada/Sinal via Fluxo Canônico de Pagamentos (Trigger Recalcula Saldo & DRE)
  IF v_sinal_pago > 0 THEN
    INSERT INTO public.pedido_pagamentos (
      pedido_id,
      valor,
      metodo,
      provider,
      provider_payment_id,
      status,
      pago_em,
      registrado_por,
      comprovante_url,
      observacoes
    ) VALUES (
      v_pedido_id,
      v_sinal_pago,
      LOWER(TRIM(p_sinal_metodo)),
      'manual',
      NULL,
      'aprovado',
      NOW(),
      auth.uid(),
      p_sinal_comprovante,
      'Entrada/Sinal registrado no ato da encomenda (' || upper(v_canal_norm) || ')'
    ) RETURNING id INTO v_pagamento_id;

    -- Lançamento financeiro com idempotência estrutural
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
      'Entrada Encomenda #' || v_pedido_id || ' (' || TRIM(p_cliente_nome) || ')',
      v_sinal_pago,
      CURRENT_DATE,
      LOWER(TRIM(p_sinal_metodo)),
      v_pedido_id,
      'pedido_pagamento',
      v_pagamento_id,
      'recebimento',
      'Entrada de encomenda via canal ' || v_canal_norm
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 12. Auditoria em pedido_status_historico
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
    'comercial',
    'novo',
    v_status_com_inicial,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'canal', v_canal_norm,
      'desconto', v_desconto,
      'motivo_desconto', p_motivo_desconto,
      'sinal_minimo', v_sinal_min,
      'sinal_pago', v_sinal_pago,
      'confirmado_sem_sinal', p_forcar_confirmacao_sem_sinal,
      'motivo_confirmacao_sem_sinal', p_motivo_confirmacao_sem_sinal,
      'pontos_carga', v_pts_pedido_total,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe
    )
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'cliente_id', v_cliente_id_final,
    'total', v_total,
    'status_comercial', v_status_com_inicial,
    'status_financeiro', CASE WHEN v_sinal_pago >= v_total THEN 'pago' WHEN v_sinal_pago > 0 THEN 'parcialmente_pago' ELSE 'nao_pago' END,
    'pontos_carga', v_pts_pedido_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. RPC REAGENDAR_ENCOMENDA_ADMIN (PREVENÇÃO DE DEADLOCK & INICIALIZAÇÃO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reagendar_encomenda_admin(
  p_pedido_id BIGINT,
  p_nova_data DATE,
  p_nova_hora TIME DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_user_nome TEXT;
  v_data_antiga DATE;
  v_primeira_data DATE;
  v_segunda_data DATE;
  v_cap_nova RECORD;
  v_pts_pedido NUMERIC(8,2) := 0.00;
  v_pts_ocupados_nova NUMERIC(8,2) := 0.00;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas equipe autorizada pode reagendar encomendas.');
  END IF;

  IF p_pedido_id IS NULL OR p_nova_data IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido e nova data são obrigatórios.');
  END IF;

  IF p_motivo IS NULL OR length(TRIM(p_motivo)) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do reagendamento.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Encomenda não encontrada.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN json_build_object('success', false, 'error', 'Não é possível reagendar uma encomenda cancelada.');
  END IF;

  v_data_antiga := v_ped.data_entrega;
  IF v_data_antiga = p_nova_data AND (p_nova_hora IS NULL OR v_ped.hora_entrega = p_nova_hora) THEN
    RETURN json_build_object('success', true, 'message', 'A encomenda já estava agendada para este horário.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- Calcula os pontos desta encomenda usando seus snapshots imutáveis
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 1.00)
  INTO v_pts_pedido
  FROM public.pedido_itens pi
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE pi.pedido_id = p_pedido_id;

  -- 1. Ordenação determinística de datas para evitar deadlocks
  v_primeira_data := LEAST(v_data_antiga, p_nova_data);
  v_segunda_data := GREATEST(v_data_antiga, p_nova_data);

  -- 2. Inicialização concorrente segura das duas datas antes dos locks
  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (v_primeira_data, 30.00), (v_segunda_data, 30.00)
  ON CONFLICT (data) DO NOTHING;

  -- 3. Locks pessimistas ordenados
  PERFORM 1 FROM public.capacidade_producao WHERE data = v_primeira_data FOR UPDATE;
  PERFORM 1 FROM public.capacidade_producao WHERE data = v_segunda_data FOR UPDATE;

  SELECT * INTO v_cap_nova FROM public.capacidade_producao WHERE data = p_nova_data;

  -- 4. Cálculo da carga ocupada na nova data (excluindo este próprio pedido)
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  INTO v_pts_ocupados_nova
  FROM public.pedidos ped
  JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE ped.data_entrega = p_nova_data
    AND ped.id <> p_pedido_id
    AND ped.status_comercial <> 'cancelado';

  IF v_cap_nova.bloqueado = true OR (v_pts_ocupados_nova + v_pts_pedido) > v_cap_nova.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      NULL;
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_nova_data,
        'capacidade_maxima', v_cap_nova.capacidade_maxima_pontos,
        'pontos_ocupados', v_pts_ocupados_nova,
        'pontos_solicitados', v_pts_pedido,
        'error', 'Capacidade de produção excedida para a nova data ' || p_nova_data || ' (' || v_pts_ocupados_nova || '/' || v_cap_nova.capacidade_maxima_pontos || ' pts ocupados).'
      );
    END IF;
  END IF;

  -- 5. Atualização da Encomenda
  UPDATE public.pedidos
  SET 
    data_entrega = p_nova_data,
    hora_entrega = COALESCE(p_nova_hora, hora_entrega),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 6. Histórico auditável
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
    'operacional',
    v_data_antiga::TEXT,
    p_nova_data::TEXT,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'acao', 'reagendamento',
      'data_anterior', v_data_antiga,
      'data_nova', p_nova_data,
      'hora_nova', p_nova_hora,
      'motivo', p_motivo,
      'pontos_carga', v_pts_pedido,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe
    )
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'data_anterior', v_data_antiga,
    'data_nova', p_nova_data,
    'pontos_carga', v_pts_pedido
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reagendar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reagendar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC OBTER_RESUMO_OPERACAO_HOJE (VIA LEDGER CONTÁBIL & AMERICA/FORTALEZA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_resumo_operacao_hoje()
RETURNS JSON AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_encomendas_qtd INT := 0;
  v_valor_encomendas NUMERIC(10,2) := 0.00;
  v_saldo_encomendas NUMERIC(10,2) := 0.00;
  v_recebido_caixa NUMERIC(10,2) := 0.00;
  v_estornos_caixa NUMERIC(10,2) := 0.00;
  v_caixa_liquido NUMERIC(10,2) := 0.00;
  v_entregas_qtd INT := 0;
  v_retiradas_qtd INT := 0;
  v_pendentes_sinal_qtd INT := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  -- 1. Encomendas do Dia (data de entrega hoje e não canceladas)
  SELECT 
    COUNT(*),
    COALESCE(SUM(total), 0.00),
    COALESCE(SUM(saldo), 0.00),
    COUNT(*) FILTER (WHERE modalidade_entrega = 'entrega'),
    COUNT(*) FILTER (WHERE modalidade_entrega = 'retirada'),
    COUNT(*) FILTER (WHERE status_comercial = 'aguardando_confirmacao' AND sinal_minimo > 0)
  INTO 
    v_encomendas_qtd,
    v_valor_encomendas,
    v_saldo_encomendas,
    v_entregas_qtd,
    v_retiradas_qtd,
    v_pendentes_sinal_qtd
  FROM public.pedidos
  WHERE data_entrega = v_hoje
    AND status_comercial <> 'cancelado';

  -- 2. Movimentação Real do Caixa Hoje via Ledger Contábil (financeiro_lancamentos)
  SELECT 
    COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND categoria = 'Estornos'), 0.00)
  INTO 
    v_recebido_caixa,
    v_estornos_caixa
  FROM public.financeiro_lancamentos
  WHERE data_lancamento = v_hoje;

  v_caixa_liquido := v_recebido_caixa - v_estornos_caixa;

  RETURN json_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'fuso_horario', 'America/Fortaleza',
    'encomendas_hoje_qtd', v_encomendas_qtd,
    'valor_encomendas_hoje', v_valor_encomendas,
    'saldo_encomendas_hoje', v_saldo_encomendas,
    'recebimentos_caixa_hoje', v_recebido_caixa,
    'estornos_caixa_hoje', v_estornos_caixa,
    'caixa_liquido_hoje', v_caixa_liquido,
    'entregas_hoje_qtd', v_entregas_qtd,
    'retiradas_hoje_qtd', v_retiradas_qtd,
    'pendentes_sinal_qtd', v_pendentes_sinal_qtd
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_resumo_operacao_hoje FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_resumo_operacao_hoje TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10. RPC OBTER_AGENDA_ENCOMENDAS (COM CAPACIDADE DERIVADA DINÂMICA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_agenda_encomendas(
  p_inicio DATE,
  p_fim DATE
)
RETURNS JSON AS $$
DECLARE
  v_inicio DATE := COALESCE(p_inicio, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);
  v_fim DATE := COALESCE(p_fim, (v_inicio + INTERVAL '30 days')::DATE);
  v_resultados JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  SELECT jsonb_agg(sub) INTO v_resultados
  FROM (
    SELECT 
      d.data,
      COALESCE(ped_stats.total_pedidos, 0) AS total_pedidos,
      COALESCE(ped_stats.valor_total, 0.00) AS valor_total,
      COALESCE(ped_stats.pontos_ocupados, 0.00) AS pontos_ocupados,
      COALESCE(cap.capacidade_maxima_pontos, 30.00) AS capacidade_maxima,
      COALESCE(cap.bloqueado, false) AS bloqueado,
      cap.motivo_bloqueio
    FROM generate_series(v_inicio, v_fim, INTERVAL '1 day') AS d(data)
    LEFT JOIN public.capacidade_producao cap ON cap.data = d.data::DATE
    LEFT JOIN (
      SELECT 
        ped.data_entrega,
        COUNT(*) AS total_pedidos,
        SUM(ped.total) AS valor_total,
        SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))) AS pontos_ocupados
      FROM public.pedidos ped
      JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
      LEFT JOIN (
        SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
        FROM public.pedido_item_opcoes
        GROUP BY pedido_item_id
      ) opt_pts ON opt_pts.pedido_item_id = pi.id
      WHERE ped.data_entrega BETWEEN v_inicio AND v_fim
        AND ped.status_comercial <> 'cancelado'
      GROUP BY ped.data_entrega
    ) ped_stats ON ped_stats.data_entrega = d.data::DATE
    ORDER BY d.data ASC
  ) sub;

  RETURN json_build_object(
    'success', true,
    'inicio', v_inicio,
    'fim', v_fim,
    'dias', COALESCE(v_resultados, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) TO authenticated, service_role;
