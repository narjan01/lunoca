-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 019: FRENTE D - CRM & HISTÓRICO 360° DO CLIENTE
-- ==========================================================================
-- Diretrizes Centrais e Regras de Negócio:
-- 1. Camada de Projeção Pura: Não duplica nem cria fonte concorrente de verdade
--    para pedidos, orçamentos, crédito, pagamentos ou comunicações.
-- 2. Não inflar LTV / Caixa: 'valor_recebido_caixa' apura estritamente pagamentos
--    externos líquidos de estornos, excluindo 'credito_cliente' para evitar duplicar caixa.
-- 3. Métricas Derivadas On-Demand: LTV de pedidos considera exclusivamente 'concluido';
--    ticket médio = SUM(total concluído) / COUNT(concluído).
-- 4. Estruturas Próprias de Relacionamento:
--    - cliente_notas (observações internas sem DELETE físico, com arquivamento auditável).
--    - cliente_tags (tags operacionais unívocas por cliente).
--    - cliente_preferencias (sabor, decoração, restrição alimentar declarada).
-- 5. Timeline 360° Unificada: Construída dinamicamente via UNION ALL, sanitizada,
--    sem expor tokens públicos, segredos de provider ou hashes confidenciais.
-- 6. Isolamento e LGPD:
--    - obter_cliente_360_admin (restrito a admin/operador, CPF mascarado para operador).
--    - obter_meu_perfil_360 (visão privada do cliente via auth.uid(), fail-closed sem notas/tags internas).
--    - buscar_clientes_crm (busca rápida por nome, telefone normalizado ou email).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. ESTRUTURAS PRÓPRIAS DE RELACIONAMENTO (CRM)
-- --------------------------------------------------------------------------

-- 1.1 Notas Internas Auditáveis
CREATE TABLE IF NOT EXISTS public.cliente_notas (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  nota TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'atendimento' CHECK (categoria IN ('atendimento', 'preferencia', 'comercial', 'pos_venda', 'outro')),
  criado_por UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arquivada BOOLEAN NOT NULL DEFAULT false,
  arquivada_por UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  arquivada_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cliente_notas_cliente_id_ativo 
  ON public.cliente_notas(cliente_id, criado_em DESC)
  WHERE arquivada = false;

-- 1.2 Tags Operacionais do Cliente
CREATE TABLE IF NOT EXISTS public.cliente_tags (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  criado_por UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cliente_tags_cliente_tag UNIQUE (cliente_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_cliente_tags_cliente_id 
  ON public.cliente_tags(cliente_id);

CREATE INDEX IF NOT EXISTS idx_cliente_tags_tag 
  ON public.cliente_tags(LOWER(tag));

-- 1.3 Preferências e Restrições Declaradas
CREATE TABLE IF NOT EXISTS public.cliente_preferencias (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL CHECK (categoria IN ('sabor', 'decoracao', 'ocasiao', 'atendimento', 'restricao_alimentar', 'outro')),
  valor TEXT NOT NULL,
  observacao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cliente_preferencias_cliente_id_ativo 
  ON public.cliente_preferencias(cliente_id, categoria)
  WHERE ativo = true;

-- --------------------------------------------------------------------------
-- 2. RLS E RESTRIÇÕES DE SEGURANÇA NAS TABELAS DO CRM
-- --------------------------------------------------------------------------

ALTER TABLE public.cliente_notas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_preferencias ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cliente_notas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cliente_tags FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cliente_preferencias FROM PUBLIC, anon, authenticated;

-- Somente leitura via RLS para equipe autorizada
DROP POLICY IF EXISTS "Equipe visualiza notas crm" ON public.cliente_notas;
CREATE POLICY "Equipe visualiza notas crm" ON public.cliente_notas
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza tags crm" ON public.cliente_tags;
CREATE POLICY "Equipe visualiza tags crm" ON public.cliente_tags
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza preferencias crm" ON public.cliente_preferencias;
CREATE POLICY "Equipe visualiza preferencias crm" ON public.cliente_preferencias
  FOR SELECT USING (public.is_admin_or_operator());

-- Bloqueio total de DELETE direto para clientes, operadores e authenticated
-- Mutações devem ocorrer exclusivamente via RPCs auditáveis.
REVOKE DELETE ON public.cliente_notas FROM PUBLIC, anon, authenticated;
REVOKE DELETE ON public.cliente_tags FROM PUBLIC, anon, authenticated;
REVOKE DELETE ON public.cliente_preferencias FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. ÍNDICES ADICIONAIS DE PERFORMANCE PARA PROJEÇÃO CRM
-- --------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id_rel_status_com 
  ON public.pedidos(cliente_id_rel, status_comercial);

CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente_id_status 
  ON public.orcamentos(cliente_id, status);

CREATE INDEX IF NOT EXISTS idx_pedido_pagamentos_pedido_metodo_status 
  ON public.pedido_pagamentos(pedido_id, metodo, status);

-- --------------------------------------------------------------------------
-- 4. RPC DE BUSCA RÁPIDA CRM (AUTOCOMPLETE & LISTAGEM LEVE)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.buscar_clientes_crm(
  p_termo TEXT,
  p_limite INTEGER DEFAULT 20
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_limite INTEGER := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50);
  v_termo_norm TEXT;
  v_termo_digitos TEXT;
  v_resultados JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode buscar no CRM.');
  END IF;

  v_termo_norm := NULLIF(TRIM(COALESCE(p_termo, '')), '');
  IF v_termo_norm IS NULL THEN
    RETURN jsonb_build_object('success', true, 'clientes', '[]'::jsonb);
  END IF;

  v_termo_digitos := regexp_replace(v_termo_norm, '\D', '', 'g');

  SELECT COALESCE(jsonb_agg(c_row), '[]'::jsonb) INTO v_resultados
  FROM (
    SELECT 
      c.id,
      c.nome,
      c.telefone,
      c.telefone_normalizado,
      c.email,
      COALESCE(cc.saldo, 0.00) AS credito_disponivel,
      (
        SELECT COUNT(*)
        FROM public.pedidos p
        WHERE p.cliente_id_rel = c.id AND p.status_comercial = 'concluido'
      ) AS pedidos_concluidos,
      (
        SELECT MAX(p.created_at)
        FROM public.pedidos p
        WHERE p.cliente_id_rel = c.id AND p.status_comercial <> 'cancelado'
      ) AS ultimo_pedido_em
    FROM public.clientes c
    LEFT JOIN public.cliente_creditos cc ON cc.cliente_id = c.id
    WHERE (
      c.nome ILIKE '%' || v_termo_norm || '%'
      OR (c.email IS NOT NULL AND c.email ILIKE '%' || v_termo_norm || '%')
      OR (v_termo_digitos <> '' AND c.telefone_normalizado LIKE '%' || v_termo_digitos || '%')
      OR (v_termo_digitos <> '' AND c.telefone LIKE '%' || v_termo_digitos || '%')
    )
    ORDER BY c.nome ASC
    LIMIT v_limite
  ) c_row;

  RETURN jsonb_build_object('success', true, 'clientes', v_resultados);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.buscar_clientes_crm FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_crm TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. RPC PRINCIPAL: OBTER FICHA 360° DO CLIENTE (ADMIN/OPERADOR)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.obter_cliente_360_admin(
  p_cliente_id BIGINT,
  p_timeline_limite INTEGER DEFAULT 50,
  p_timeline_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_cli RECORD;
  v_limite INTEGER := LEAST(GREATEST(COALESCE(p_timeline_limite, 50), 1), 100);
  v_offset INTEGER := GREATEST(COALESCE(p_timeline_offset, 0), 0);
  
  -- Métricas
  v_ped_total INT := 0;
  v_ped_concluidos INT := 0;
  v_ped_cancelados INT := 0;
  v_val_concluidos NUMERIC(10,2) := 0.00;
  v_val_recebido_caixa NUMERIC(10,2) := 0.00;
  v_ticket_medio NUMERIC(10,2) := 0.00;
  v_ticket_maximo NUMERIC(10,2) := 0.00;
  v_primeiro_ped TIMESTAMPTZ;
  v_ultimo_ped TIMESTAMPTZ;
  v_ultima_compra_concluida TIMESTAMPTZ;
  
  v_orc_total INT := 0;
  v_orc_convertidos INT := 0;
  v_taxa_conversao NUMERIC(5,2) := 0.00;
  v_saldo_credito NUMERIC(10,2) := 0.00;

  -- Coleções
  v_tags JSONB;
  v_preferencias JSONB;
  v_notas JSONB;
  v_timeline JSONB;
  v_cpf_exibicao TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode acessar a Ficha 360 do CRM.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  SELECT * INTO v_cli FROM public.clientes WHERE id = p_cliente_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_NOT_FOUND', 'error', 'Cliente não encontrado no CRM.');
  END IF;

  -- Tratamento LGPD de CPF (admin vê completo; operador vê mascarado)
  IF v_cli.cpf IS NOT NULL AND length(v_cli.cpf) >= 4 THEN
    IF v_is_admin THEN
      v_cpf_exibicao := v_cli.cpf;
    ELSE
      v_cpf_exibicao := '***.***.***-' || right(regexp_replace(v_cli.cpf, '\D', '', 'g'), 2);
    END IF;
  ELSE
    v_cpf_exibicao := v_cli.cpf;
  END IF;

  -- 1. Apuração de Métricas de Pedidos
  SELECT
    COALESCE(COUNT(*), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_comercial = 'concluido'), 0),
    COALESCE(COUNT(*) FILTER (WHERE status_comercial = 'cancelado'), 0),
    COALESCE(SUM(total) FILTER (WHERE status_comercial = 'concluido'), 0.00),
    COALESCE(MAX(total) FILTER (WHERE status_comercial = 'concluido'), 0.00),
    MIN(created_at) FILTER (WHERE status_comercial <> 'cancelado'),
    MAX(created_at) FILTER (WHERE status_comercial <> 'cancelado'),
    MAX(created_at) FILTER (WHERE status_comercial = 'concluido')
  INTO
    v_ped_total, v_ped_concluidos, v_ped_cancelados,
    v_val_concluidos, v_ticket_maximo,
    v_primeiro_ped, v_ultimo_ped, v_ultima_compra_concluida
  FROM public.pedidos
  WHERE cliente_id_rel = p_cliente_id;

  IF v_ped_concluidos > 0 THEN
    v_ticket_medio := ROUND(v_val_concluidos / v_ped_concluidos, 2);
  ELSE
    v_ticket_medio := 0.00;
  END IF;

  -- 2. Apuração do Caixa Efetivo (SEM DUPLICAR CREDITO_CLIENTE)
  -- Considera pagamentos aprovados em dinheiro/pix/cartão/etc. subtraindo estornos externos desses métodos.
  SELECT COALESCE(SUM(
    CASE 
      WHEN pp.status = 'aprovado' THEN pp.valor
      WHEN pp.status = 'estornado' THEN -pp.valor
      ELSE 0.00
    END
  ), 0.00) INTO v_val_recebido_caixa
  FROM public.pedido_pagamentos pp
  JOIN public.pedidos p ON p.id = pp.pedido_id
  WHERE p.cliente_id_rel = p_cliente_id
    AND pp.metodo <> 'credito_cliente'
    AND pp.status IN ('aprovado', 'estornado');

  v_val_recebido_caixa := GREATEST(0.00, v_val_recebido_caixa);

  -- 3. Apuração de Orçamentos
  SELECT
    COALESCE(COUNT(*), 0),
    COALESCE(COUNT(*) FILTER (WHERE status = 'convertido'), 0)
  INTO
    v_orc_total, v_orc_convertidos
  FROM public.orcamentos
  WHERE cliente_id = p_cliente_id;

  IF v_orc_total > 0 THEN
    v_taxa_conversao := ROUND((v_orc_convertidos::NUMERIC / v_orc_total::NUMERIC) * 100.00, 2);
  ELSE
    v_taxa_conversao := 0.00;
  END IF;

  -- 4. Saldo da Carteira de Crédito
  SELECT COALESCE(saldo, 0.00) INTO v_saldo_credito
  FROM public.cliente_creditos
  WHERE cliente_id = p_cliente_id;

  -- 5. Tags Ativas
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'tag', tag, 'created_at', created_at) ORDER BY tag ASC), '[]'::jsonb)
  INTO v_tags
  FROM public.cliente_tags
  WHERE cliente_id = p_cliente_id;

  -- 6. Preferências Ativas
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id, 'categoria', categoria, 'valor', valor,
      'observacao', observacao, 'created_at', created_at
    ) ORDER BY categoria ASC, created_at DESC
  ), '[]'::jsonb)
  INTO v_preferencias
  FROM public.cliente_preferencias
  WHERE cliente_id = p_cliente_id AND ativo = true;

  -- 7. Notas Internas Não Arquivadas
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', n.id, 'nota', n.nota, 'categoria', n.categoria,
      'criado_em', n.criado_em, 'criado_por_nome', COALESCE(p.nome, 'Equipe')
    ) ORDER BY n.criado_em DESC
  ), '[]'::jsonb)
  INTO v_notas
  FROM public.cliente_notas n
  LEFT JOIN public.profiles p ON p.id = n.criado_por
  WHERE n.cliente_id = p_cliente_id AND n.arquivada = false;

  -- 8. Timeline Cronológica Unificada (UNION ALL Dinâmico Sanitizado)
  SELECT COALESCE(jsonb_agg(t_item), '[]'::jsonb) INTO v_timeline
  FROM (
    SELECT * FROM (
      -- Eventos de Pedidos
      SELECT 
        'pedido' AS tipo,
        p.status_comercial AS subtitulo,
        p.id AS entidade_id,
        'Pedido #' || p.id || ' (' || UPPER(p.status_comercial) || ')' AS titulo,
        'Valor Total: R$ ' || TRIM(TO_CHAR(p.total, '999999990.00')) || ' | Pagamento: ' || UPPER(p.pagamento) AS descricao,
        p.total AS valor,
        p.status_comercial AS status,
        p.created_at AS ocorrido_em,
        jsonb_build_object(
          'canal', p.canal,
          'status_operacional', p.status_operacional,
          'status_financeiro', p.status_financeiro,
          'valor_pago', p.valor_pago,
          'saldo', p.saldo
        ) AS metadata
      FROM public.pedidos p
      WHERE p.cliente_id_rel = p_cliente_id

      UNION ALL

      -- Eventos de Orçamentos
      SELECT 
        'orcamento' AS tipo,
        o.status AS subtitulo,
        o.id AS entidade_id,
        'Orçamento ' || o.numero || ' (v' || o.versao || ')' AS titulo,
        'Valor Total: R$ ' || TRIM(TO_CHAR(o.total, '999999990.00')) || ' | Status: ' || UPPER(o.status) AS descricao,
        o.total AS valor,
        o.status AS status,
        o.created_at AS ocorrido_em,
        jsonb_build_object(
          'numero', o.numero,
          'versao', o.versao,
          'pedido_id', o.pedido_id,
          'validade_ate', o.validade_ate
        ) AS metadata
      FROM public.orcamentos o
      WHERE o.cliente_id = p_cliente_id

      UNION ALL

      -- Eventos de WhatsApp / Comunicações
      SELECT 
        'comunicacao' AS tipo,
        c.tipo AS subtitulo,
        c.id AS entidade_id,
        'WhatsApp: ' || c.tipo AS titulo,
        'Canal: ' || c.canal || ' | Status: ' || c.status || ' | Dest: ' || COALESCE(c.destinatario, '-') AS descricao,
        0.00 AS valor,
        c.status AS status,
        c.created_at AS ocorrido_em,
        jsonb_build_object(
          'tipo', c.tipo,
          'canal', c.canal,
          'pedido_id', c.pedido_id,
          'orcamento_id', c.orcamento_id
        ) AS metadata
      FROM public.comunicacoes_cliente c
      LEFT JOIN public.pedidos cp ON cp.id = c.pedido_id
      LEFT JOIN public.orcamentos co ON co.id = c.orcamento_id
      WHERE cp.cliente_id_rel = p_cliente_id OR co.cliente_id = p_cliente_id

      UNION ALL

      -- Eventos de Crédito / Carteira
      SELECT 
        'credito' AS tipo,
        m.origem AS subtitulo,
        m.id AS entidade_id,
        'Movimentação de Crédito: ' || UPPER(m.tipo) AS titulo,
        m.motivo || ' (Saldo Anterior: R$ ' || m.saldo_anterior || ' -> Atual: R$ ' || m.saldo_posterior || ')' AS descricao,
        m.valor AS valor,
        m.tipo AS status,
        m.created_at AS ocorrido_em,
        jsonb_build_object(
          'origem', m.origem,
          'pedido_id', m.pedido_id,
          'saldo_anterior', m.saldo_anterior,
          'saldo_posterior', m.saldo_posterior
        ) AS metadata
      FROM public.cliente_credito_movimentacoes m
      WHERE m.cliente_id = p_cliente_id

      UNION ALL

      -- Eventos de Notas Internas
      SELECT 
        'nota' AS tipo,
        n.categoria AS subtitulo,
        n.id AS entidade_id,
        'Nota Interna: ' || UPPER(n.categoria) AS titulo,
        n.nota AS descricao,
        0.00 AS valor,
        CASE WHEN n.arquivada THEN 'arquivada' ELSE 'ativa' END AS status,
        n.criado_em AS ocorrido_em,
        jsonb_build_object(
          'categoria', n.categoria,
          'arquivada', n.arquivada
        ) AS metadata
      FROM public.cliente_notas n
      WHERE n.cliente_id = p_cliente_id
    ) timeline_union
    ORDER BY ocorrido_em DESC
    LIMIT v_limite
    OFFSET v_offset
  ) t_item;

  RETURN jsonb_build_object(
    'success', true,
    'cliente', jsonb_build_object(
      'id', v_cli.id,
      'nome', v_cli.nome,
      'telefone', v_cli.telefone,
      'telefone_normalizado', v_cli.telefone_normalizado,
      'email', v_cli.email,
      'cpf', v_cpf_exibicao,
      'data_nascimento', v_cli.data_nascimento,
      'endereco_padrao', v_cli.endereco_padrao,
      'observacoes', v_cli.observacoes,
      'created_at', v_cli.created_at,
      'updated_at', v_cli.updated_at
    ),
    'metricas', jsonb_build_object(
      'pedidos_total', v_ped_total,
      'pedidos_concluidos', v_ped_concluidos,
      'pedidos_cancelados', v_ped_cancelados,
      'valor_pedidos_concluidos', v_val_concluidos,
      'valor_recebido_caixa', v_val_recebido_caixa,
      'ticket_medio', v_ticket_medio,
      'ticket_maximo', v_ticket_maximo,
      'primeiro_pedido_em', v_primeiro_ped,
      'ultimo_pedido_em', v_ultimo_ped,
      'ultima_compra_concluida_em', v_ultima_compra_concluida,
      'orcamentos_total', v_orc_total,
      'orcamentos_convertidos', v_orc_convertidos,
      'taxa_conversao_orcamentos', v_taxa_conversao
    ),
    'credito', jsonb_build_object(
      'saldo', v_saldo_credito
    ),
    'tags', v_tags,
    'preferencias', v_preferencias,
    'notas', v_notas,
    'timeline', v_timeline
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_cliente_360_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_cliente_360_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. RPCs DE MANUTENÇÃO CRM (NOTAS, TAGS E PREFERÊNCIAS)
-- --------------------------------------------------------------------------

-- 6.1 Adicionar Nota Interna
CREATE OR REPLACE FUNCTION public.adicionar_nota_cliente(
  p_cliente_id BIGINT,
  p_nota TEXT,
  p_categoria TEXT DEFAULT 'atendimento'
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_nota TEXT := NULLIF(TRIM(COALESCE(p_nota, '')), '');
  v_cat TEXT := LOWER(TRIM(COALESCE(p_categoria, 'atendimento')));
  v_nota_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode adicionar notas internas.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  IF v_nota IS NULL OR length(v_nota) < 3 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_NOTE', 'error', 'A nota deve conter pelo menos 3 caracteres.');
  END IF;

  IF v_cat NOT IN ('atendimento', 'preferencia', 'comercial', 'pos_venda', 'outro') THEN
    v_cat := 'atendimento';
  END IF;

  INSERT INTO public.cliente_notas (cliente_id, nota, categoria, criado_por, criado_em)
  VALUES (p_cliente_id, v_nota, v_cat, auth.uid(), NOW())
  RETURNING id INTO v_nota_id;

  RETURN jsonb_build_object('success', true, 'nota_id', v_nota_id, 'cliente_id', p_cliente_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.adicionar_nota_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adicionar_nota_cliente TO authenticated, service_role;

-- 6.2 Arquivar Nota Interna (Sem DELETE Físico)
CREATE OR REPLACE FUNCTION public.arquivar_nota_cliente(
  p_nota_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode arquivar notas internas.');
  END IF;

  IF p_nota_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTE_ID_REQUIRED', 'error', 'ID da nota é obrigatório.');
  END IF;

  UPDATE public.cliente_notas
  SET arquivada = true,
      arquivada_por = auth.uid(),
      arquivada_em = NOW()
  WHERE id = p_nota_id AND arquivada = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOTE_NOT_FOUND', 'error', 'Nota não encontrada ou já arquivada.');
  END IF;

  RETURN jsonb_build_object('success', true, 'nota_id', p_nota_id, 'arquivada', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.arquivar_nota_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arquivar_nota_cliente TO authenticated, service_role;

-- 6.3 Adicionar Tag ao Cliente
CREATE OR REPLACE FUNCTION public.adicionar_tag_cliente(
  p_cliente_id BIGINT,
  p_tag TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_tag TEXT := NULLIF(TRIM(COALESCE(p_tag, '')), '');
  v_tag_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerenciar tags.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  IF v_tag IS NULL OR length(v_tag) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_TAG', 'error', 'A tag deve conter pelo menos 2 caracteres.');
  END IF;

  INSERT INTO public.cliente_tags (cliente_id, tag, criado_por, created_at)
  VALUES (p_cliente_id, v_tag, auth.uid(), NOW())
  ON CONFLICT (cliente_id, tag) DO NOTHING
  RETURNING id INTO v_tag_id;

  RETURN jsonb_build_object('success', true, 'tag', v_tag, 'cliente_id', p_cliente_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.adicionar_tag_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adicionar_tag_cliente TO authenticated, service_role;

-- 6.4 Remover Tag do Cliente (Exceção controlada para tags efêmeras)
CREATE OR REPLACE FUNCTION public.remover_tag_cliente(
  p_cliente_id BIGINT,
  p_tag TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_tag TEXT := NULLIF(TRIM(COALESCE(p_tag, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerenciar tags.');
  END IF;

  IF p_cliente_id IS NULL OR v_tag IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PARAMS', 'error', 'ID do cliente e tag são obrigatórios.');
  END IF;

  DELETE FROM public.cliente_tags
  WHERE cliente_id = p_cliente_id AND LOWER(tag) = LOWER(v_tag);

  RETURN jsonb_build_object('success', true, 'tag_removida', v_tag, 'cliente_id', p_cliente_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.remover_tag_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remover_tag_cliente TO authenticated, service_role;

-- 6.5 Definir Preferência do Cliente
CREATE OR REPLACE FUNCTION public.definir_preferencia_cliente(
  p_cliente_id BIGINT,
  p_categoria TEXT,
  p_valor TEXT,
  p_observacao TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_cat TEXT := LOWER(TRIM(COALESCE(p_categoria, 'outro')));
  v_val TEXT := NULLIF(TRIM(COALESCE(p_valor, '')), '');
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_pref_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerenciar preferências.');
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'CLIENT_ID_REQUIRED', 'error', 'ID do cliente é obrigatório.');
  END IF;

  IF v_val IS NULL OR length(v_val) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_VALUE', 'error', 'O valor da preferência deve conter pelo menos 2 caracteres.');
  END IF;

  IF v_cat NOT IN ('sabor', 'decoracao', 'ocasiao', 'atendimento', 'restricao_alimentar', 'outro') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CATEGORY', 'error', 'Categoria de preferência inválida.');
  END IF;

  INSERT INTO public.cliente_preferencias (
    cliente_id, categoria, valor, observacao, ativo, criado_por, created_at, updated_at
  ) VALUES (
    p_cliente_id, v_cat, v_val, v_obs, true, auth.uid(), NOW(), NOW()
  ) RETURNING id INTO v_pref_id;

  RETURN jsonb_build_object('success', true, 'preferencia_id', v_pref_id, 'cliente_id', p_cliente_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.definir_preferencia_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.definir_preferencia_cliente TO authenticated, service_role;

-- 6.6 Arquivar Preferência do Cliente (Desativação Auditável)
CREATE OR REPLACE FUNCTION public.arquivar_preferencia_cliente(
  p_preferencia_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode desativar preferências.');
  END IF;

  IF p_preferencia_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PREFERENCE_ID_REQUIRED', 'error', 'ID da preferência é obrigatório.');
  END IF;

  UPDATE public.cliente_preferencias
  SET ativo = false,
      updated_at = NOW()
  WHERE id = p_preferencia_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PREFERENCE_NOT_FOUND', 'error', 'Preferência não encontrada ou já desativada.');
  END IF;

  RETURN jsonb_build_object('success', true, 'preferencia_id', p_preferencia_id, 'ativo', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.arquivar_preferencia_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arquivar_preferencia_cliente TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. VISÃO PRÓPRIA DO CLIENTE AUTENTICADO (FAIL-CLOSED & SEM DADOS INTERNOS)
-- --------------------------------------------------------------------------
-- O cliente autenticado (auth.uid()) só visualiza seus próprios dados cadastrais,
-- seus pedidos, seus orçamentos e seu saldo de crédito, SEM NOTAS NEM TAGS INTERNAS.

CREATE OR REPLACE FUNCTION public.obter_meu_perfil_360()
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cli RECORD;
  v_saldo NUMERIC(10,2) := 0.00;
  v_pedidos JSONB;
  v_orcamentos JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'UNAUTHENTICATED', 'error', 'Sessão necessária para consultar perfil.');
  END IF;

  SELECT * INTO v_cli FROM public.clientes WHERE auth_user_id = v_uid LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PROFILE_NOT_LINKED', 'error', 'Perfil do cliente não encontrado.');
  END IF;

  -- Saldo de Crédito
  SELECT COALESCE(saldo, 0.00) INTO v_saldo
  FROM public.cliente_creditos
  WHERE cliente_id = v_cli.id;

  -- Pedidos do Próprio Cliente
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id, 'total', total, 'status_comercial', status_comercial,
      'status_operacional', status_operacional, 'status_financeiro', status_financeiro,
      'data_entrega', data_entrega, 'created_at', created_at
    ) ORDER BY created_at DESC
  ), '[]'::jsonb) INTO v_pedidos
  FROM public.pedidos
  WHERE cliente_id_rel = v_cli.id;

  -- Orçamentos do Próprio Cliente
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id, 'numero', numero, 'versao', versao,
      'status', status, 'total', total, 'data_evento', data_evento,
      'validade_ate', validade_ate, 'token_publico', token_publico, 'created_at', created_at
    ) ORDER BY created_at DESC
  ), '[]'::jsonb) INTO v_orcamentos
  FROM public.orcamentos
  WHERE cliente_id = v_cli.id;

  RETURN jsonb_build_object(
    'success', true,
    'cliente', jsonb_build_object(
      'id', v_cli.id,
      'nome', v_cli.nome,
      'telefone', v_cli.telefone,
      'email', v_cli.email,
      'endereco_padrao', v_cli.endereco_padrao
    ),
    'credito', jsonb_build_object(
      'saldo', v_saldo
    ),
    'pedidos', v_pedidos,
    'orcamentos', v_orcamentos
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_meu_perfil_360 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_meu_perfil_360 TO authenticated, service_role;
