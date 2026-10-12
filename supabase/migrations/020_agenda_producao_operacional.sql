-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 020: AGENDA DE PRODUÇÃO & OPERAÇÃO VISUAL (FRENTE E)
-- ==========================================================================
-- Objetivo:
-- Projeção operacional dos pedidos canônicos para visualização e condução do fluxo diário:
-- 1. Fila de Produção: aguardando_producao -> em_producao -> pronto
-- 2. Expedição Segregada:
--    - Entrega: pronto -> saiu_para_entrega -> entregue
--    - Retirada: pronto -> entregue (rejeita saiu_para_entrega)
-- 3. Sanitização da Cozinha: Não expõe CPF, meios de pagamento ou margens no display operacional.
-- 4. Capacidade Diária: Projeção de carga máxima vs ocupada sem inventar disponibilidade no frontend.
-- 5. Estruturas complementares: observações de produção e prioridade operacional.
-- 6. Imutabilidade contábil: Conclusão operacional NUNCA duplica lançamentos financeiros.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. ESTRUTURAS COMPLEMENTARES DE PRODUÇÃO
-- --------------------------------------------------------------------------

-- 1.1 Observações de Produção da Equipe (auditável, sem delete físico)
CREATE TABLE IF NOT EXISTS public.pedido_producao_observacoes (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  observacao TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'geral' CHECK (categoria IN ('geral', 'cozinha', 'embalagem', 'entrega', 'alergia')),
  autor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  autor_nome TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prod_obs_pedido_ativo 
  ON public.pedido_producao_observacoes(pedido_id) WHERE ativo = true;

ALTER TABLE public.pedido_producao_observacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_producao_observacoes FROM PUBLIC, anon;

DROP POLICY IF EXISTS "Equipe visualiza observacoes producao" ON public.pedido_producao_observacoes;
CREATE POLICY "Equipe visualiza observacoes producao" ON public.pedido_producao_observacoes
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe insere observacoes producao" ON public.pedido_producao_observacoes;
CREATE POLICY "Equipe insere observacoes producao" ON public.pedido_producao_observacoes
  FOR INSERT WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe atualiza observacoes producao" ON public.pedido_producao_observacoes;
CREATE POLICY "Equipe atualiza observacoes producao" ON public.pedido_producao_observacoes
  FOR UPDATE USING (public.is_admin_or_operator()) WITH CHECK (public.is_admin_or_operator());

-- Bloqueio de DELETE físico na tabela de observações de produção
CREATE OR REPLACE FUNCTION public.bloquear_delete_pedido_producao_observacoes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Exclusão física bloqueada em observações de produção. Utilize arquivamento com ativo = false.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_delete_prod_obs ON public.pedido_producao_observacoes;
CREATE TRIGGER trg_bloquear_delete_prod_obs
  BEFORE DELETE ON public.pedido_producao_observacoes
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_delete_pedido_producao_observacoes();

GRANT SELECT, INSERT, UPDATE ON public.pedido_producao_observacoes TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pedido_producao_observacoes_id_seq TO authenticated, service_role;

-- 1.2 Prioridade e Configurações Operacionais por Pedido
CREATE TABLE IF NOT EXISTS public.pedido_producao_config (
  pedido_id BIGINT PRIMARY KEY REFERENCES public.pedidos(id) ON DELETE CASCADE,
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('baixa', 'normal', 'alta', 'urgente')),
  responsavel TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.pedido_producao_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_producao_config FROM PUBLIC, anon;

DROP POLICY IF EXISTS "Equipe gerencia config producao" ON public.pedido_producao_config;
CREATE POLICY "Equipe gerencia config producao" ON public.pedido_producao_config
  FOR ALL USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

GRANT SELECT, INSERT, UPDATE ON public.pedido_producao_config TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 2. RPC: OBTER_AGENDA_PRODUCAO
-- --------------------------------------------------------------------------
-- Projeta os pedidos confirmados/em andamento para a linha de produção no período,
-- agregando capacidade diária real e sanitizando dados financeiros para a cozinha.
CREATE OR REPLACE FUNCTION public.obter_agenda_producao(
  p_data_inicio DATE DEFAULT CURRENT_DATE,
  p_data_fim DATE DEFAULT (CURRENT_DATE + INTERVAL '7 days')::DATE,
  p_status_operacional TEXT DEFAULT NULL,
  p_modalidade TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_inicio DATE;
  v_fim DATE;
  v_pedidos JSONB;
  v_capacidades JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas operadores e administradores podem visualizar a agenda de produção.'
    );
  END IF;

  v_inicio := COALESCE(p_data_inicio, CURRENT_DATE);
  v_fim := COALESCE(p_data_fim, (v_inicio + INTERVAL '7 days')::DATE);

  IF v_fim < v_inicio THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DATE_RANGE',
      'error', 'Data final não pode ser anterior à data inicial.'
    );
  END IF;

  -- Limite preventivo de 31 dias por consulta
  IF (v_fim - v_inicio) > 31 THEN
    v_fim := (v_inicio + INTERVAL '31 days')::DATE;
  END IF;

  -- 1. Projeção dos Pedidos Ativos na Agenda (Ignora pedidos cancelados)
  SELECT COALESCE(jsonb_agg(ped_row), '[]'::jsonb) INTO v_pedidos
  FROM (
    SELECT
      p.id,
      p.id AS numero_pedido,
      p.data_entrega,
      p.hora_entrega,
      p.nome_cliente,
      p.telefone_cliente AS cliente_telefone,
      COALESCE(p.modalidade_entrega, 'retirada') AS modalidade_entrega,
      p.endereco_entrega,
      p.status_operacional,
      p.status_comercial,
      p.status_financeiro,
      COALESCE(cfg.prioridade, 'normal') AS prioridade,
      cfg.responsavel AS responsavel_producao,
      public.pontos_pedido(p.id) AS pontos_producao,
      p.observacoes_cliente AS observacoes_cliente,
      -- Lista estruturada de itens para a cozinha
      (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'item_id', pi.id,
            'produto_id', pi.produto_id,
            'produto_nome', COALESCE(pr.nome, 'Item'),
            'quantidade', pi.quantidade,
            'observacoes', pi.observacoes,
            'pontos_producao', pi.pontos_producao_snapshot,
            'opcoes', (
              SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                  'opcao_id', pio.id,
                  'nome', pio.opcao_nome,
                  'valor', pio.preco_adicional
                )
              ), '[]'::jsonb)
              FROM public.pedido_item_opcoes pio
              WHERE pio.pedido_item_id = pi.id
            )
          ) ORDER BY pi.id ASC
        ), '[]'::jsonb)
        FROM public.pedido_itens pi
        LEFT JOIN public.produtos pr ON pr.id = pi.produto_id
        WHERE pi.pedido_id = p.id
      ) AS itens,
      -- Observações de produção ativas
      (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'id', po.id,
            'observacao', po.observacao,
            'categoria', po.categoria,
            'autor_nome', po.autor_nome,
            'created_at', po.created_at
          ) ORDER BY po.created_at DESC
        ), '[]'::jsonb)
        FROM public.pedido_producao_observacoes po
        WHERE po.pedido_id = p.id AND po.ativo = true
      ) AS observacoes_producao
    FROM public.pedidos p
    LEFT JOIN public.pedido_producao_config cfg ON cfg.pedido_id = p.id
    WHERE p.data_entrega BETWEEN v_inicio AND v_fim
      AND p.status_comercial <> 'cancelado'
      AND (p_status_operacional IS NULL OR p.status_operacional = p_status_operacional)
      AND (p_modalidade IS NULL OR COALESCE(p.modalidade_entrega, 'retirada') = p_modalidade)
    ORDER BY
      p.data_entrega ASC,
      p.hora_entrega ASC NULLS LAST,
      CASE COALESCE(cfg.prioridade, 'normal')
        WHEN 'urgente' THEN 1
        WHEN 'alta' THEN 2
        WHEN 'normal' THEN 3
        WHEN 'baixa' THEN 4
        ELSE 5
      END ASC,
      p.id ASC
  ) ped_row;

  -- 2. Capacidade Diária para cada dia do intervalo
  SELECT COALESCE(jsonb_agg(cap_row), '[]'::jsonb) INTO v_capacidades
  FROM (
    SELECT
      d.dia::DATE AS data,
      COALESCE(cp.capacidade_maxima_pontos, 30.00) AS capacidade_maxima,
      public.pontos_ocupados_data(d.dia::DATE) AS pontos_ocupados,
      GREATEST(0.00, COALESCE(cp.capacidade_maxima_pontos, 30.00) - public.pontos_ocupados_data(d.dia::DATE)) AS pontos_disponiveis,
      ROUND(
        LEAST(100.00, (public.pontos_ocupados_data(d.dia::DATE) / GREATEST(1.00, COALESCE(cp.capacidade_maxima_pontos, 30.00))) * 100.00),
        1
      ) AS percentual_ocupado,
      COALESCE(cp.bloqueado, false) AS bloqueado,
      cp.motivo_bloqueio,
      CASE
        WHEN COALESCE(cp.bloqueado, false) THEN 'bloqueado'
        WHEN public.pontos_ocupados_data(d.dia::DATE) > COALESCE(cp.capacidade_maxima_pontos, 30.00) THEN 'excedido'
        WHEN public.pontos_ocupados_data(d.dia::DATE) >= COALESCE(cp.capacidade_maxima_pontos, 30.00) THEN 'lotado'
        WHEN public.pontos_ocupados_data(d.dia::DATE) >= (COALESCE(cp.capacidade_maxima_pontos, 30.00) * 0.80) THEN 'proximo_limite'
        ELSE 'normal'
      END AS status_capacidade
    FROM generate_series(v_inicio::TIMESTAMP, v_fim::TIMESTAMP, '1 day'::INTERVAL) d(dia)
    LEFT JOIN public.capacidade_producao cp ON cp.data = d.dia::DATE
    ORDER BY d.dia ASC
  ) cap_row;

  RETURN jsonb_build_object(
    'success', true,
    'data_inicio', v_inicio,
    'data_fim', v_fim,
    'pedidos', v_pedidos,
    'capacidades', v_capacidades,
    'total_pedidos', jsonb_array_length(v_pedidos)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_agenda_producao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_agenda_producao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. RPC: OBTER_DETALHE_PRODUCAO_PEDIDO
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_detalhe_producao_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_itens JSONB;
  v_historico JSONB;
  v_observacoes JSONB;
  v_preferencias_cliente JSONB;
  v_cfg RECORD;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode ver detalhes de produção.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  -- Itens com opções
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', pi.id,
      'produto_id', pi.produto_id,
      'produto_nome', COALESCE(pr.nome, 'Produto'),
      'quantidade', pi.quantidade,
      'observacoes', pi.observacoes,
      'pontos_producao', pi.pontos_producao_snapshot,
      'opcoes', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'nome', pio.opcao_nome,
            'valor', pio.preco_adicional
          )
        ), '[]'::jsonb)
        FROM public.pedido_item_opcoes pio
        WHERE pio.pedido_item_id = pi.id
      )
    ) ORDER BY pi.id ASC
  ), '[]'::jsonb) INTO v_itens
  FROM public.pedido_itens pi
  LEFT JOIN public.produtos pr ON pr.id = pi.produto_id
  WHERE pi.pedido_id = v_ped.id;

  -- Histórico operacional
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', h.id,
      'status_anterior', h.status_anterior,
      'status_novo', h.status_novo,
      'usuario_nome', h.usuario_nome,
      'origem', h.origem,
      'metadata', h.metadata,
      'created_at', h.created_at
    ) ORDER BY h.created_at ASC
  ), '[]'::jsonb) INTO v_historico
  FROM public.pedido_status_historico h
  WHERE h.pedido_id = v_ped.id AND h.dimensao = 'operacional';

  -- Observações de produção
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', po.id,
      'observacao', po.observacao,
      'categoria', po.categoria,
      'autor_nome', po.autor_nome,
      'created_at', po.created_at
    ) ORDER BY po.created_at DESC
  ), '[]'::jsonb) INTO v_observacoes
  FROM public.pedido_producao_observacoes po
  WHERE po.pedido_id = v_ped.id AND po.ativo = true;

  -- Restrições e preferências alimentares do cliente (da Frente D, se cliente vinculado)
  IF v_ped.cliente_id_rel IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'categoria', cp.categoria,
        'preferencia', cp.valor,
        'detalhes', cp.observacao
      ) ORDER BY cp.categoria ASC
    ), '[]'::jsonb) INTO v_preferencias_cliente
    FROM public.cliente_preferencias cp
    WHERE cp.cliente_id = v_ped.cliente_id_rel AND cp.ativo = true;
  ELSE
    v_preferencias_cliente := '[]'::jsonb;
  END IF;

  SELECT * INTO v_cfg FROM public.pedido_producao_config WHERE pedido_id = v_ped.id;

  RETURN jsonb_build_object(
    'success', true,
    'pedido', jsonb_build_object(
      'id', v_ped.id,
      'data_entrega', v_ped.data_entrega,
      'hora_entrega', v_ped.hora_entrega,
      'modalidade_entrega', COALESCE(v_ped.modalidade_entrega, 'retirada'),
      'endereco_entrega', v_ped.endereco_entrega,
      'nome_cliente', v_ped.nome_cliente,
      'telefone_cliente', v_ped.telefone_cliente,
      'status_operacional', v_ped.status_operacional,
      'status_comercial', v_ped.status_comercial,
      'observacoes_cliente', v_ped.observacoes_cliente,
      'pontos_producao', public.pontos_pedido(v_ped.id),
      'prioridade', COALESCE(v_cfg.prioridade, 'normal'),
      'responsavel_producao', v_cfg.responsavel
    ),
    'itens', v_itens,
    'historico_operacional', v_historico,
    'observacoes_producao', v_observacoes,
    'restricoes_cliente', v_preferencias_cliente
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_detalhe_producao_pedido FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_detalhe_producao_pedido TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. RPC: INICIAR_PRODUCAO_PEDIDO
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.iniciar_producao_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode iniciar produção.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Não é possível iniciar produção de pedido cancelado.');
  END IF;

  -- Idempotência
  IF v_ped.status_operacional = 'em_producao' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'status_operacional', 'em_producao', 'pedido_id', p_pedido_id);
  END IF;

  -- Validação de transição: não permite retroceder de pronto/entregue
  IF v_ped.status_operacional IN ('pronto', 'saiu_para_entrega', 'entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Pedido já foi finalizado ou está pronto/entregue. Não pode retornar para em produção.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome 
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Produção'; END IF;

  -- Transição para em_producao
  UPDATE public.pedidos
  SET status_operacional = 'em_producao',
      status = 'Em Preparo',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'em_producao',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'iniciar_producao')
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', 'em_producao'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.iniciar_producao_pedido FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.iniciar_producao_pedido TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. RPC: MARCAR_PEDIDO_PRONTO
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marcar_pedido_pronto(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode marcar pedido como pronto.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Não é possível marcar pedido cancelado como pronto.');
  END IF;

  -- Idempotência
  IF v_ped.status_operacional = 'pronto' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'status_operacional', 'pronto', 'pedido_id', p_pedido_id);
  END IF;

  -- Transição válida: apenas se estiver em_producao ou aguardando_producao
  IF v_ped.status_operacional IN ('saiu_para_entrega', 'entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Pedido já saiu para entrega ou foi entregue. Não pode retornar para pronto.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome 
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Produção'; END IF;

  UPDATE public.pedidos
  SET status_operacional = 'pronto',
      status = 'Pronto',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'pronto',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'marcar_pronto', 'modalidade', COALESCE(v_ped.modalidade_entrega, 'retirada'))
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', 'pronto',
    'modalidade_entrega', COALESCE(v_ped.modalidade_entrega, 'retirada')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.marcar_pedido_pronto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_pedido_pronto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. RPC: MARCAR_SAIDA_ENTREGA
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marcar_saida_entrega(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode despachar entrega.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode sair para entrega.');
  END IF;

  -- SEGREGACAO ESTRITA DE MODALIDADE: Retirada não pode ter saída para entrega
  IF COALESCE(v_ped.modalidade_entrega, 'retirada') = 'retirada' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DELIVERY_MODALITY',
      'error', 'Pedidos na modalidade retirada na loja não possuem etapa de saída para entrega.'
    );
  END IF;

  -- Idempotência
  IF v_ped.status_operacional = 'saiu_para_entrega' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'status_operacional', 'saiu_para_entrega', 'pedido_id', p_pedido_id);
  END IF;

  -- Validação de transição: Não pode ir direto de aguardando_producao sem estar pronto
  IF v_ped.status_operacional NOT IN ('pronto', 'em_producao') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Pedido precisa estar pronto (ou em finalização de produção) para sair para entrega.'
    );
  END IF;

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome 
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Expedição'; END IF;

  UPDATE public.pedidos
  SET status_operacional = 'saiu_para_entrega',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'saiu_para_entrega',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'saiu_para_entrega')
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', 'saiu_para_entrega'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.marcar_saida_entrega FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marcar_saida_entrega TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. RPC: CONFIRMAR_ENTREGA_RETIRADA
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirmar_entrega_retirada(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_status_final TEXT;
  v_usuario_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode confirmar conclusão da entrega/retirada.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode ser entregue.');
  END IF;

  -- Idempotência
  IF v_ped.status_operacional IN ('entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'status_operacional', v_ped.status_operacional,
      'pedido_id', p_pedido_id
    );
  END IF;

  -- Validação estrita: não pode pular de aguardando_producao direto para entregue
  IF v_ped.status_operacional = 'aguardando_producao' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TRANSITION',
      'error', 'Não é possível concluir entrega de pedido que ainda aguarda produção. O pedido deve passar pelas etapas de preparo.'
    );
  END IF;

  v_status_final := 'entregue';

  SELECT COALESCE(nome, email, 'Operador') INTO v_usuario_nome 
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Balcão/Entrega'; END IF;

  -- Atualização operacional (sem duplicar ou forçar financeiro)
  UPDATE public.pedidos
  SET status_operacional = v_status_final,
      status = 'Entregue',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, v_status_final,
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'confirmar_entrega_retirada', 'modalidade', COALESCE(v_ped.modalidade_entrega, 'retirada'))
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status_operacional,
    'status_operacional', v_status_final,
    'modalidade_entrega', COALESCE(v_ped.modalidade_entrega, 'retirada')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_entrega_retirada FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_entrega_retirada TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. RPC: DEFINIR_PRIORIDADE_PRODUCAO
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.definir_prioridade_producao(
  p_pedido_id BIGINT,
  p_prioridade TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_prio TEXT := LOWER(TRIM(COALESCE(p_prioridade, 'normal')));
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode alterar prioridade.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_prio NOT IN ('baixa', 'normal', 'alta', 'urgente') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PRIORITY', 'error', 'Prioridade inválida. Utilize: baixa, normal, alta ou urgente.');
  END IF;

  INSERT INTO public.pedido_producao_config (pedido_id, prioridade, updated_at, updated_by)
  VALUES (p_pedido_id, v_prio, NOW(), auth.uid())
  ON CONFLICT (pedido_id) DO UPDATE SET
    prioridade = EXCLUDED.prioridade,
    updated_at = NOW(),
    updated_by = auth.uid();

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'prioridade', v_prio
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.definir_prioridade_producao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.definir_prioridade_producao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC: ADICIONAR_OBSERVACAO_PRODUCAO
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adicionar_observacao_producao(
  p_pedido_id BIGINT,
  p_observacao TEXT,
  p_categoria TEXT DEFAULT 'geral'
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_cat TEXT := LOWER(TRIM(COALESCE(p_categoria, 'geral')));
  v_usuario_nome TEXT;
  v_obs_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe pode adicionar notas de produção.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_obs IS NULL OR length(v_obs) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'OBSERVATION_REQUIRED', 'error', 'Observação de produção não pode ser vazia.');
  END IF;

  IF v_cat NOT IN ('geral', 'cozinha', 'embalagem', 'entrega', 'alergia') THEN
    v_cat := 'geral';
  END IF;

  SELECT COALESCE(nome, email, 'Equipe') INTO v_usuario_nome 
  FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.pedido_producao_observacoes (
    pedido_id, observacao, categoria, autor_id, autor_nome, ativo, created_at
  ) VALUES (
    p_pedido_id, v_obs, v_cat, auth.uid(), v_usuario_nome, true, NOW()
  ) RETURNING id INTO v_obs_id;

  RETURN jsonb_build_object(
    'success', true,
    'observacao_id', v_obs_id,
    'pedido_id', p_pedido_id,
    'categoria', v_cat,
    'observacao', v_obs
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.adicionar_observacao_producao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adicionar_observacao_producao TO authenticated, service_role;
