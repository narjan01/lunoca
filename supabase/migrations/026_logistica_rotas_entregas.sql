-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 026: FRENTE K - LOGÍSTICA, ROTAS E COMPROVANTE DE ENTREGA
-- ==============================================================================
-- Diretrizes Arquiteturais e Invariantes Congeladas (Frente K):
-- 1. Zero duplicação de máquina de estados ou de pedido:
--    - public.pedidos.status_operacional continua sendo a única fonte da verdade
--      para pronto -> saiu_para_entrega -> entregue.
--    - Endereço, telefone e nome do cliente nunca são duplicados em entregas;
--      são lidos dos snapshots canônicos de public.pedidos.
-- 2. Segregação estrita de modalidade (Gates K1, K15):
--    - Pedidos com modalidade_entrega = 'retirada' jamais entram em rota de entrega,
--      jamais são despachados como entrega e jamais acessam tracking de rota.
-- 3. Pré-condição de despacho e idempotência (Gates K2, K3, K4, K16):
--    - Pedido que não está 'pronto' não pode ser despachado.
--    - Despacho válido move status_operacional para 'saiu_para_entrega' com lock FOR UPDATE.
--    - Retry de despacho é idempotente e não duplica eventos.
-- 4. Falha de entrega como evento logístico próprio (Gates K7, K8):
--    - Problemas de rua (DESTINATARIO_AUSENTE, ENDERECO_NAO_LOCALIZADO, RECUSADO,
--      PROBLEMA_TRANSPORTE, OUTRO) ficam em entrega_eventos e status_logistico,
--      sem explodir pedidos.status_operacional e sem alterar o financeiro.
--    - Permite reagendamento e nova tentativa até a entrega efetiva.
-- 5. Confirmação de entrega e Comprovante Imutável (Gates K5, K6, K10, K11, K12):
--    - confirmar_entrega_pedido() serializa o pedido (FOR UPDATE), muda
--      status_operacional para 'entregue', é idempotente e JAMAIS gera
--      lançamentos em financeiro_lancamentos ou pedido_pagamentos.
--    - entrega_eventos e entrega_comprovantes são estritamente append-only
--      (triggers bloqueando UPDATE e DELETE físicos).
--    - Comprovante armazena apenas metadados e referência externa (sem BYTEA).
-- 6. Sanitização de Rota e Tracking no Portal do Cliente (Gates K9, K14, K15):
--    - obter_acompanhamento_entrega_cliente() resolve identidade por
--      _resolver_meu_cliente_id() (auth.uid()), valida propriedade do pedido,
--      bloqueia pedidos de retirada e não expõe entregador, telefone interno,
--      notas logísticas nem outros clientes/endereços da rota.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABELA: ROTAS_ENTREGA (AGRUPAMENTO DE ENTREGAS POR DIA / TURNO)
-- ------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.rotas_entrega_seq START 1;

CREATE TABLE IF NOT EXISTS public.rotas_entrega (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  data_rota DATE NOT NULL,
  turno TEXT NOT NULL CHECK (turno IN ('manha', 'tarde', 'noite', 'personalizado')),
  responsavel_nome TEXT NOT NULL CHECK (char_length(btrim(responsavel_nome)) >= 2),
  responsavel_telefone TEXT,
  veiculo_identificacao TEXT,
  status TEXT NOT NULL DEFAULT 'planejada' CHECK (status IN ('planejada', 'em_andamento', 'concluida', 'cancelada')),
  observacoes_internas TEXT,
  iniciada_em TIMESTAMPTZ,
  concluida_em TIMESTAMPTZ,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rotas_entrega_data_turno
  ON public.rotas_entrega(data_rota DESC, turno, id DESC);

-- ------------------------------------------------------------------------------
-- 2. TABELA: ENTREGAS (OPERAÇÃO LOGÍSTICA 1:1 COM PEDIDO DE ENTREGA)
-- ------------------------------------------------------------------------------
-- Não duplica nome, telefone ou endereço do cliente (usa public.pedidos).
CREATE TABLE IF NOT EXISTS public.entregas (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL UNIQUE REFERENCES public.pedidos(id) ON DELETE CASCADE,
  status_logistico TEXT NOT NULL DEFAULT 'aguardando_despacho' CHECK (
    status_logistico IN ('aguardando_despacho', 'em_rota', 'falha_temporaria', 'reagendada', 'entregue', 'cancelada')
  ),
  tentativas_count INTEGER NOT NULL DEFAULT 0 CHECK (tentativas_count >= 0),
  ultimo_motivo_falha TEXT CHECK (
    ultimo_motivo_falha IS NULL OR ultimo_motivo_falha IN (
      'DESTINATARIO_AUSENTE',
      'ENDERECO_NAO_LOCALIZADO',
      'RECUSADO',
      'PROBLEMA_TRANSPORTE',
      'OUTRO'
    )
  ),
  proxima_janela_data DATE,
  proxima_janela_hora TIME,
  despachado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  observacoes_logisticas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entregas_status_logistico
  ON public.entregas(status_logistico, updated_at DESC);

-- ------------------------------------------------------------------------------
-- 3. TABELA: ROTA_ENTREGAS (SEQUÊNCIA DE ENTREGAS DENTRO DE UMA ROTA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rota_entregas (
  id BIGSERIAL PRIMARY KEY,
  rota_id BIGINT NOT NULL REFERENCES public.rotas_entrega(id) ON DELETE CASCADE,
  entrega_id BIGINT NOT NULL REFERENCES public.entregas(id) ON DELETE CASCADE,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  ordem_sequencia INTEGER NOT NULL DEFAULT 1 CHECK (ordem_sequencia >= 1),
  ativo BOOLEAN NOT NULL DEFAULT true,
  atribuido_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rota_entrega_vinculo UNIQUE (rota_id, entrega_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rota_entregas_entrega_ativa
  ON public.rota_entregas(entrega_id)
  WHERE ativo = true;

CREATE INDEX IF NOT EXISTS idx_rota_entregas_rota_ordem
  ON public.rota_entregas(rota_id, ordem_sequencia ASC)
  WHERE ativo = true;

-- ------------------------------------------------------------------------------
-- 4. TABELA: ENTREGA_EVENTOS (HISTÓRICO LOGÍSTICO APPEND-ONLY IMUTÁVEL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entrega_eventos (
  id BIGSERIAL PRIMARY KEY,
  entrega_id BIGINT NOT NULL REFERENCES public.entregas(id) ON DELETE RESTRICT,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  rota_id BIGINT REFERENCES public.rotas_entrega(id) ON DELETE SET NULL,
  tipo_evento TEXT NOT NULL CHECK (
    tipo_evento IN (
      'ROTA_ATRIBUIDA',
      'DESPACHADO',
      'TENTATIVA_ENTREGA',
      'FALHA_ENTREGA',
      'REAGENDADO',
      'NOVA_TENTATIVA_DESPACHO',
      'ENTREGUE',
      'COMPROVANTE_REGISTRADO'
    )
  ),
  motivo_falha TEXT CHECK (
    motivo_falha IS NULL OR motivo_falha IN (
      'DESTINATARIO_AUSENTE',
      'ENDERECO_NAO_LOCALIZADO',
      'RECUSADO',
      'PROBLEMA_TRANSPORTE',
      'OUTRO'
    )
  ),
  descricao TEXT NOT NULL CHECK (char_length(btrim(descricao)) >= 3),
  chave_idempotencia TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT 'Equipe Logística',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entrega_eventos_pedido
  ON public.entrega_eventos(pedido_id, id ASC);

CREATE INDEX IF NOT EXISTS idx_entrega_eventos_entrega
  ON public.entrega_eventos(entrega_id, id ASC);

CREATE OR REPLACE FUNCTION public.bloquear_mutacao_entrega_eventos()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Operação % não permitida em entrega_eventos. O histórico de eventos logísticos é estritamente imutável (append-only).', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_entrega_eventos ON public.entrega_eventos;
CREATE TRIGGER trg_imutabilidade_entrega_eventos
  BEFORE UPDATE OR DELETE ON public.entrega_eventos
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_entrega_eventos();

-- ------------------------------------------------------------------------------
-- 5. TABELA: ENTREGA_COMPROVANTES (COMPROVANTE DE RECEBIMENTO APPEND-ONLY IMUTÁVEL)
-- ------------------------------------------------------------------------------
-- Sem BYTEA no banco: armazena apenas fatos do recebimento e referência externa.
CREATE TABLE IF NOT EXISTS public.entrega_comprovantes (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  entrega_id BIGINT NOT NULL REFERENCES public.entregas(id) ON DELETE RESTRICT,
  recebido_por TEXT NOT NULL CHECK (char_length(btrim(recebido_por)) >= 2),
  tipo_comprovante TEXT NOT NULL DEFAULT 'assinatura_recebedor' CHECK (
    tipo_comprovante IN (
      'assinatura_recebedor',
      'foto_entrega',
      'codigo_confirmacao',
      'confirmacao_verbal_autorizada'
    )
  ),
  documento_recebedor TEXT,
  referencia_arquivo TEXT,
  hash_arquivo TEXT,
  metadata_tecnica JSONB NOT NULL DEFAULT '{}'::jsonb,
  chave_idempotencia TEXT NOT NULL UNIQUE,
  registrado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  registrado_por_nome TEXT NOT NULL DEFAULT 'Equipe Logística',
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entrega_comprovantes_pedido
  ON public.entrega_comprovantes(pedido_id, id DESC);

CREATE OR REPLACE FUNCTION public.bloquear_mutacao_entrega_comprovantes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Operação % não permitida em entrega_comprovantes. Os comprovantes de entrega são estritamente imutáveis (append-only).', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_entrega_comprovantes ON public.entrega_comprovantes;
CREATE TRIGGER trg_imutabilidade_entrega_comprovantes
  BEFORE UPDATE OR DELETE ON public.entrega_comprovantes
  FOR EACH ROW
  EXECUTE FUNCTION public.bloquear_mutacao_entrega_comprovantes();

-- ------------------------------------------------------------------------------
-- 6. RLS & PRIVILÉGIOS FAIL-CLOSED NAS TABELAS LOGÍSTICAS
-- ------------------------------------------------------------------------------
ALTER TABLE public.rotas_entrega ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entregas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rota_entregas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entrega_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entrega_comprovantes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rotas_entrega FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.entregas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.rota_entregas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.entrega_eventos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.entrega_comprovantes FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.rotas_entrega TO authenticated;
GRANT SELECT ON public.entregas TO authenticated;
GRANT SELECT ON public.rota_entregas TO authenticated;
GRANT SELECT ON public.entrega_eventos TO authenticated;
GRANT SELECT ON public.entrega_comprovantes TO authenticated;

GRANT ALL ON public.rotas_entrega TO service_role;
GRANT ALL ON public.entregas TO service_role;
GRANT ALL ON public.rota_entregas TO service_role;
GRANT ALL ON public.entrega_eventos TO service_role;
GRANT ALL ON public.entrega_comprovantes TO service_role;

DROP POLICY IF EXISTS rutas_entrega_equipe_select ON public.rotas_entrega;
CREATE POLICY rutas_entrega_equipe_select ON public.rotas_entrega
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS entregas_equipe_select ON public.entregas;
CREATE POLICY entregas_equipe_select ON public.entregas
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS rota_entregas_equipe_select ON public.rota_entregas;
CREATE POLICY rota_entregas_equipe_select ON public.rota_entregas
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS entrega_eventos_equipe_select ON public.entrega_eventos;
CREATE POLICY entrega_eventos_equipe_select ON public.entrega_eventos
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS entrega_comprovantes_equipe_select ON public.entrega_comprovantes;
CREATE POLICY entrega_comprovantes_equipe_select ON public.entrega_comprovantes
  FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

-- ------------------------------------------------------------------------------
-- 7. RPC: CRIAR_ROTA_ENTREGA_ADMIN
-- ------------------------------------------------------------------------------
-- Cria ou atualiza uma rota diária/turno. JAMAIS altera pedidos diretamente.
CREATE OR REPLACE FUNCTION public.criar_rota_entrega_admin(
  p_data_rota DATE,
  p_turno TEXT,
  p_responsavel_nome TEXT,
  p_responsavel_telefone TEXT DEFAULT NULL,
  p_veiculo_identificacao TEXT DEFAULT NULL,
  p_observacoes_internas TEXT DEFAULT NULL,
  p_codigo TEXT DEFAULT NULL,
  p_rota_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_turno TEXT := LOWER(TRIM(COALESCE(p_turno, 'manha')));
  v_resp TEXT := NULLIF(TRIM(COALESCE(p_responsavel_nome, '')), '');
  v_codigo TEXT := UPPER(NULLIF(TRIM(COALESCE(p_codigo, '')), ''));
  v_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores ou operadores podem planejar rotas de entrega.'
    );
  END IF;

  IF p_data_rota IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ROUTE_DATE_REQUIRED',
      'error', 'A data da rota de entrega é obrigatória.'
    );
  END IF;

  IF v_turno NOT IN ('manha', 'tarde', 'noite', 'personalizado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_ROUTE_SHIFT',
      'error', 'Turno inválido. Utilize manha, tarde, noite ou personalizado.'
    );
  END IF;

  IF v_resp IS NULL OR char_length(v_resp) < 2 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'DRIVER_NAME_REQUIRED',
      'error', 'Informe o nome do responsável/entregador da rota.'
    );
  END IF;

  IF p_rota_id IS NOT NULL THEN
    UPDATE public.rotas_entrega
    SET data_rota = p_data_rota,
        turno = v_turno,
        responsavel_nome = v_resp,
        responsavel_telefone = NULLIF(TRIM(COALESCE(p_responsavel_telefone, '')), ''),
        veiculo_identificacao = NULLIF(TRIM(COALESCE(p_veiculo_identificacao, '')), ''),
        observacoes_internas = NULLIF(TRIM(COALESCE(p_observacoes_internas, '')), ''),
        updated_at = NOW()
    WHERE id = p_rota_id
    RETURNING id, codigo INTO v_id, v_codigo;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ROUTE_NOT_FOUND', 'error', 'Rota não encontrada.');
    END IF;
  ELSE
    IF v_codigo IS NULL THEN
      v_codigo := 'ROTA-' || to_char(p_data_rota, 'YYYYMMDD') || '-' || UPPER(SUBSTRING(v_turno FROM 1 FOR 3)) || '-' || LPAD(nextval('public.rotas_entrega_seq')::TEXT, 3, '0');
    END IF;

    INSERT INTO public.rotas_entrega (
      codigo,
      data_rota,
      turno,
      responsavel_nome,
      responsavel_telefone,
      veiculo_identificacao,
      status,
      observacoes_internas,
      criado_por,
      created_at,
      updated_at
    ) VALUES (
      v_codigo,
      p_data_rota,
      v_turno,
      v_resp,
      NULLIF(TRIM(COALESCE(p_responsavel_telefone, '')), ''),
      NULLIF(TRIM(COALESCE(p_veiculo_identificacao, '')), ''),
      'planejada',
      NULLIF(TRIM(COALESCE(p_observacoes_internas, '')), ''),
      auth.uid(),
      NOW(),
      NOW()
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'rota_id', v_id,
    'codigo', v_codigo,
    'data_rota', p_data_rota,
    'turno', v_turno,
    'responsavel_nome', v_resp
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_rota_entrega_admin(DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_rota_entrega_admin(DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 8. RPC: ATRIBUIR_ENTREGA_ROTA (GATE K1: RETIRADA NUNCA ENTRA EM ROTA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atribuir_entrega_rota(
  p_rota_id BIGINT,
  p_pedido_id BIGINT,
  p_ordem_sequencia INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_rota public.rotas_entrega;
  v_ped public.pedidos;
  v_entrega_id BIGINT;
  v_ordem INTEGER;
  v_usuario_nome TEXT;
  v_evt_key TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas equipe autorizada pode atribuir entregas a rotas.'
    );
  END IF;

  IF p_rota_id IS NULL OR p_pedido_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PARAMS_REQUIRED',
      'error', 'ID da rota e ID do pedido são obrigatórios.'
    );
  END IF;

  SELECT * INTO v_rota
  FROM public.rotas_entrega
  WHERE id = p_rota_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ROUTE_NOT_FOUND', 'error', 'Rota de entrega não encontrada.');
  END IF;

  IF v_rota.status IN ('concluida', 'cancelada') THEN
    RETURN jsonb_build_object('success', false, 'code', 'ROUTE_CLOSED', 'error', 'Não é possível atribuir pedidos a uma rota já concluída ou cancelada.');
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode entrar em rota de entrega.');
  END IF;

  -- GATE K1: Pedidos de retirada na loja NUNCA entram em rota de entrega
  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PICKUP_ORDER_NOT_ROUTABLE',
      'error', 'Pedidos na modalidade retirada na loja não podem ser incluídos em rotas de entrega.'
    );
  END IF;

  IF v_ped.status_operacional IN ('entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_ALREADY_DELIVERED',
      'error', 'Este pedido já foi entregue e não pode ser atribuído a uma nova rota.'
    );
  END IF;

  -- Garante a existência do registro logístico em public.entregas sem alterar o pedido
  INSERT INTO public.entregas (
    pedido_id,
    status_logistico,
    created_at,
    updated_at
  ) VALUES (
    p_pedido_id,
    CASE WHEN v_ped.status_operacional = 'saiu_para_entrega' THEN 'em_rota' ELSE 'aguardando_despacho' END,
    NOW(),
    NOW()
  )
  ON CONFLICT (pedido_id) DO UPDATE
    SET updated_at = NOW()
  RETURNING id INTO v_entrega_id;

  -- Desativa vínculo ativo anterior em outra rota, se existir
  UPDATE public.rota_entregas
  SET ativo = false,
      updated_at = NOW()
  WHERE entrega_id = v_entrega_id
    AND rota_id <> p_rota_id
    AND ativo = true;

  IF p_ordem_sequencia IS NOT NULL AND p_ordem_sequencia >= 1 THEN
    v_ordem := p_ordem_sequencia;
  ELSE
    SELECT COALESCE(MAX(ordem_sequencia), 0) + 1 INTO v_ordem
    FROM public.rota_entregas
    WHERE rota_id = p_rota_id
      AND ativo = true;
  END IF;

  INSERT INTO public.rota_entregas (
    rota_id,
    entrega_id,
    pedido_id,
    ordem_sequencia,
    ativo,
    atribuido_por,
    created_at,
    updated_at
  ) VALUES (
    p_rota_id,
    v_entrega_id,
    p_pedido_id,
    v_ordem,
    true,
    auth.uid(),
    NOW(),
    NOW()
  )
  ON CONFLICT (rota_id, entrega_id) DO UPDATE
    SET ordem_sequencia = EXCLUDED.ordem_sequencia,
        ativo = true,
        atribuido_por = EXCLUDED.atribuido_por,
        updated_at = NOW();

  SELECT COALESCE(nome, email, 'Equipe Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Logística'; END IF;

  v_evt_key := 'rota_atrib:' || p_rota_id::TEXT || ':ped:' || p_pedido_id::TEXT || ':ord:' || v_ordem::TEXT;

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    rota_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega_id,
    p_pedido_id,
    p_rota_id,
    'ROTA_ATRIBUIDA',
    'Pedido #' || p_pedido_id::TEXT || ' atribuído à rota ' || v_rota.codigo || ' (sequência #' || v_ordem::TEXT || ').',
    v_evt_key,
    jsonb_build_object('rota_codigo', v_rota.codigo, 'ordem_sequencia', v_ordem),
    auth.uid(),
    v_usuario_nome
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'rota_id', p_rota_id,
    'rota_codigo', v_rota.codigo,
    'entrega_id', v_entrega_id,
    'pedido_id', p_pedido_id,
    'ordem_sequencia', v_ordem
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.atribuir_entrega_rota(BIGINT, BIGINT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atribuir_entrega_rota(BIGINT, BIGINT, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC: REORDENAR_ROTA_ENTREGA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reordenar_rota_entrega(
  p_rota_id BIGINT,
  p_pedido_ids_ordenados BIGINT[]
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_idx INTEGER;
  v_ped_id BIGINT;
  v_atualizados INTEGER := 0;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode reordenar rotas.');
  END IF;

  IF p_rota_id IS NULL OR p_pedido_ids_ordenados IS NULL OR array_length(p_pedido_ids_ordenados, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PARAMS_REQUIRED', 'error', 'Informe a rota e a lista ordenada de pedidos.');
  END IF;

  PERFORM 1 FROM public.rotas_entrega WHERE id = p_rota_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ROUTE_NOT_FOUND', 'error', 'Rota não encontrada.');
  END IF;

  FOR v_idx IN 1..array_length(p_pedido_ids_ordenados, 1) LOOP
    v_ped_id := p_pedido_ids_ordenados[v_idx];
    UPDATE public.rota_entregas
    SET ordem_sequencia = v_idx,
        updated_at = NOW()
    WHERE rota_id = p_rota_id
      AND pedido_id = v_ped_id
      AND ativo = true;

    IF FOUND THEN
      v_atualizados := v_atualizados + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'rota_id', p_rota_id,
    'itens_reordenados', v_atualizados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reordenar_rota_entrega(BIGINT, BIGINT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reordenar_rota_entrega(BIGINT, BIGINT[]) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. RPC: DESPACHAR_PEDIDO_ENTREGA (GATES K1, K2, K3, K4, K8, K16)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.despachar_pedido_entrega(
  p_pedido_id BIGINT,
  p_observacao TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_rota_id BIGINT;
  v_usuario_nome TEXT;
  v_tipo_evento TEXT;
  v_evt_key TEXT;
  v_tentativa INTEGER;
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode despachar entregas.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  -- Lock serializado no pedido (Gate K16)
  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode ser despachado.');
  END IF;

  -- Gate K1: Retirada nunca é despachada como entrega
  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DELIVERY_MODALITY',
      'error', 'Pedidos na modalidade retirada na loja não possuem despacho logístico de entrega.'
    );
  END IF;

  IF v_ped.status_operacional IN ('entregue', 'retirado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_ALREADY_DELIVERED',
      'error', 'Este pedido já consta como entregue.'
    );
  END IF;

  -- Garante registro em public.entregas com lock
  INSERT INTO public.entregas (
    pedido_id,
    status_logistico,
    created_at,
    updated_at
  ) VALUES (
    p_pedido_id,
    'aguardando_despacho',
    NOW(),
    NOW()
  )
  ON CONFLICT (pedido_id) DO NOTHING;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id
  FOR UPDATE;

  -- Gate K4: Idempotência estrita — se já está em saiu_para_entrega E status_logistico = 'em_rota'
  IF v_ped.status_operacional = 'saiu_para_entrega' AND v_entrega.status_logistico = 'em_rota' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'entrega_id', v_entrega.id,
      'status_operacional', 'saiu_para_entrega',
      'status_logistico', 'em_rota',
      'tentativas_count', v_entrega.tentativas_count
    );
  END IF;

  -- Gate K2: Pedido não pronto não pode ser despachado
  -- Exceção legítima (Gate K8): se já estava em saiu_para_entrega porém com status_logistico IN ('falha_temporaria', 'reagendada')
  IF v_ped.status_operacional <> 'pronto'
     AND NOT (v_ped.status_operacional = 'saiu_para_entrega' AND v_entrega.status_logistico IN ('falha_temporaria', 'reagendada', 'aguardando_despacho')) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_READY_FOR_DISPATCH',
      'error', 'Pedido ainda não está pronto na produção e não pode ser despachado para entrega.',
      'status_operacional_atual', v_ped.status_operacional
    );
  END IF;

  SELECT COALESCE(nome, email, 'Expedição Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Expedição Logística'; END IF;

  SELECT re.rota_id INTO v_rota_id
  FROM public.rota_entregas re
  WHERE re.entrega_id = v_entrega.id
    AND re.ativo = true
  LIMIT 1;

  v_tentativa := COALESCE(v_entrega.tentativas_count, 0) + 1;

  IF v_entrega.status_logistico IN ('falha_temporaria', 'reagendada') THEN
    v_tipo_evento := 'NOVA_TENTATIVA_DESPACHO';
  ELSE
    v_tipo_evento := 'DESPACHADO';
  END IF;

  v_evt_key := COALESCE(
    NULLIF(TRIM(COALESCE(p_chave_idempotencia, '')), ''),
    'despacho:ped:' || p_pedido_id::TEXT || ':tentativa:' || v_tentativa::TEXT
  );

  -- Gate K3: Transição canônica de pedidos.status_operacional para saiu_para_entrega
  IF v_ped.status_operacional <> 'saiu_para_entrega' THEN
    UPDATE public.pedidos
    SET status_operacional = 'saiu_para_entrega',
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      p_pedido_id, 'operacional', v_ped.status_operacional, 'saiu_para_entrega',
      auth.uid(), v_usuario_nome, 'admin',
      jsonb_build_object('acao', 'despachar_pedido_entrega', 'tentativa', v_tentativa, 'rota_id', v_rota_id)
    );
  END IF;

  UPDATE public.entregas
  SET status_logistico = 'em_rota',
      tentativas_count = v_tentativa,
      despachado_em = COALESCE(despachado_em, NOW()),
      observacoes_logisticas = COALESCE(v_obs, observacoes_logisticas),
      updated_at = NOW()
  WHERE id = v_entrega.id;

  IF v_rota_id IS NOT NULL THEN
    UPDATE public.rotas_entrega
    SET status = CASE WHEN status = 'planejada' THEN 'em_andamento' ELSE status END,
        iniciada_em = COALESCE(iniciada_em, NOW()),
        updated_at = NOW()
    WHERE id = v_rota_id;
  END IF;

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    rota_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    v_rota_id,
    v_tipo_evento,
    COALESCE(v_obs, CASE WHEN v_tipo_evento = 'NOVA_TENTATIVA_DESPACHO'
      THEN 'Nova saída para entrega iniciada (tentativa #' || v_tentativa::TEXT || ').'
      ELSE 'Pedido despachado e saiu para entrega (tentativa #' || v_tentativa::TEXT || ').'
    END),
    v_evt_key,
    jsonb_build_object('tentativa', v_tentativa, 'rota_id', v_rota_id),
    auth.uid(),
    v_usuario_nome
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'rota_id', v_rota_id,
    'status_operacional', 'saiu_para_entrega',
    'status_logistico', 'em_rota',
    'tipo_evento', v_tipo_evento,
    'tentativas_count', v_tentativa
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.despachar_pedido_entrega(BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.despachar_pedido_entrega(BIGINT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPC: REGISTRAR_FALHA_ENTREGA (GATE K7: FALHA MANTÉM HISTÓRICO E NÃO TOCA NO FINANCEIRO)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_falha_entrega(
  p_pedido_id BIGINT,
  p_motivo_falha TEXT,
  p_descricao TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_motivo TEXT := UPPER(TRIM(COALESCE(p_motivo_falha, '')));
  v_desc TEXT := NULLIF(TRIM(COALESCE(p_descricao, '')), '');
  v_rota_id BIGINT;
  v_usuario_nome TEXT;
  v_evt_key TEXT;
  v_evt_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode registrar ocorrências de entrega.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_motivo NOT IN ('DESTINATARIO_AUSENTE', 'ENDERECO_NAO_LOCALIZADO', 'RECUSADO', 'PROBLEMA_TRANSPORTE', 'OUTRO') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_FAILURE_REASON',
      'error', 'Motivo de falha inválido. Use DESTINATARIO_AUSENTE, ENDERECO_NAO_LOCALIZADO, RECUSADO, PROBLEMA_TRANSPORTE ou OUTRO.'
    );
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_operacional <> 'saiu_para_entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_IN_TRANSIT',
      'error', 'Apenas pedidos que saíram para entrega podem receber registro de falha de entrega.'
    );
  END IF;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'DELIVERY_NOT_FOUND', 'error', 'Registro logístico de entrega não localizado.');
  END IF;

  SELECT re.rota_id INTO v_rota_id
  FROM public.rota_entregas re
  WHERE re.entrega_id = v_entrega.id
    AND re.ativo = true
  LIMIT 1;

  SELECT COALESCE(nome, email, 'Equipe Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Logística'; END IF;

  IF v_desc IS NULL THEN
    v_desc := 'Falha na tentativa #' || GREATEST(1, v_entrega.tentativas_count)::TEXT || ': ' || v_motivo;
  END IF;

  v_evt_key := COALESCE(
    NULLIF(TRIM(COALESCE(p_chave_idempotencia, '')), ''),
    'falha:ped:' || p_pedido_id::TEXT || ':tentativa:' || GREATEST(1, v_entrega.tentativas_count)::TEXT || ':' || v_motivo
  );

  SELECT id INTO v_evt_id
  FROM public.entrega_eventos
  WHERE chave_idempotencia = v_evt_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'entrega_id', v_entrega.id,
      'evento_id', v_evt_id,
      'status_operacional', v_ped.status_operacional,
      'status_logistico', v_entrega.status_logistico,
      'motivo_falha', v_motivo
    );
  END IF;

  UPDATE public.entregas
  SET status_logistico = 'falha_temporaria',
      ultimo_motivo_falha = v_motivo,
      observacoes_logisticas = v_desc,
      updated_at = NOW()
  WHERE id = v_entrega.id;

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    rota_id,
    tipo_evento,
    motivo_falha,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    v_rota_id,
    'FALHA_ENTREGA',
    v_motivo,
    v_desc,
    v_evt_key,
    jsonb_build_object('tentativa', v_entrega.tentativas_count, 'motivo_falha', v_motivo),
    auth.uid(),
    v_usuario_nome
  )
  RETURNING id INTO v_evt_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'evento_id', v_evt_id,
    'status_operacional', v_ped.status_operacional,
    'status_logistico', 'falha_temporaria',
    'motivo_falha', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_falha_entrega(BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_falha_entrega(BIGINT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. RPC: REAGENDAR_ENTREGA (GATE K8: PREPARA NOVA TENTATIVA APÓS FALHA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reagendar_entrega(
  p_pedido_id BIGINT,
  p_nova_data DATE,
  p_nova_hora TIME DEFAULT NULL,
  p_observacao TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_usuario_nome TEXT;
  v_evt_key TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode reagendar entregas.');
  END IF;

  IF p_pedido_id IS NULL OR p_nova_data IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PARAMS_REQUIRED', 'error', 'ID do pedido e nova data são obrigatórios.');
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_DELIVERY_MODALITY', 'error', 'Apenas pedidos de entrega podem ser reagendados na logística.');
  END IF;

  IF v_ped.status_operacional IN ('entregue', 'retirado', 'cancelado') THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CLOSED', 'error', 'Pedido já entregue ou cancelado não pode ser reagendado.');
  END IF;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'DELIVERY_NOT_FOUND', 'error', 'Entrega não localizada para este pedido.');
  END IF;

  SELECT COALESCE(nome, email, 'Equipe Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Logística'; END IF;

  UPDATE public.entregas
  SET status_logistico = 'reagendada',
      proxima_janela_data = p_nova_data,
      proxima_janela_hora = p_nova_hora,
      observacoes_logisticas = COALESCE(v_obs, observacoes_logisticas),
      updated_at = NOW()
  WHERE id = v_entrega.id;

  v_evt_key := 'reagendado:ped:' || p_pedido_id::TEXT || ':tent:' || v_entrega.tentativas_count::TEXT || ':' || p_nova_data::TEXT || ':' || COALESCE(p_nova_hora::TEXT, 'sem_hora');

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    'REAGENDADO',
    COALESCE(v_obs, 'Entrega reagendada para ' || to_char(p_nova_data, 'DD/MM/YYYY') || COALESCE(' às ' || to_char(p_nova_hora, 'HH24:MI'), '')),
    v_evt_key,
    jsonb_build_object('nova_data', p_nova_data, 'nova_hora', p_nova_hora),
    auth.uid(),
    v_usuario_nome
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'status_operacional', v_ped.status_operacional,
    'status_logistico', 'reagendada',
    'proxima_janela_data', p_nova_data,
    'proxima_janela_hora', p_nova_hora
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reagendar_entrega(BIGINT, DATE, TIME, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reagendar_entrega(BIGINT, DATE, TIME, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. RPC: REGISTRAR_COMPROVANTE_ENTREGA (GATE K10: COMPROVANTE APPEND-ONLY IMUTÁVEL)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_comprovante_entrega(
  p_pedido_id BIGINT,
  p_recebido_por TEXT,
  p_tipo_comprovante TEXT DEFAULT 'assinatura_recebedor',
  p_documento_recebedor TEXT DEFAULT NULL,
  p_referencia_arquivo TEXT DEFAULT NULL,
  p_hash_arquivo TEXT DEFAULT NULL,
  p_metadata_tecnica JSONB DEFAULT '{}'::jsonb,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_rec_por TEXT := NULLIF(TRIM(COALESCE(p_recebido_por, '')), '');
  v_tipo TEXT := LOWER(TRIM(COALESCE(p_tipo_comprovante, 'assinatura_recebedor')));
  v_usuario_nome TEXT;
  v_comp_key TEXT;
  v_comp_existente public.entrega_comprovantes;
  v_comp_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode registrar comprovante de entrega.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_rec_por IS NULL OR char_length(v_rec_por) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'RECIPIENT_REQUIRED', 'error', 'Informe o nome de quem recebeu a encomenda (mínimo 2 caracteres).');
  END IF;

  IF v_tipo NOT IN ('assinatura_recebedor', 'foto_entrega', 'codigo_confirmacao', 'confirmacao_verbal_autorizada') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_PROOF_TYPE', 'error', 'Tipo de comprovante inválido.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_DELIVERY_MODALITY', 'error', 'Comprovante logístico de rota aplica-se apenas a pedidos de entrega.');
  END IF;

  SELECT * INTO v_entrega FROM public.entregas WHERE pedido_id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'DELIVERY_NOT_FOUND', 'error', 'Operação logística de entrega não localizada para este pedido.');
  END IF;

  v_comp_key := COALESCE(
    NULLIF(TRIM(COALESCE(p_chave_idempotencia, '')), ''),
    'comprovante:ped:' || p_pedido_id::TEXT || ':' || v_tipo || ':' || LOWER(v_rec_por)
  );

  SELECT * INTO v_comp_existente
  FROM public.entrega_comprovantes
  WHERE chave_idempotencia = v_comp_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'comprovante_id', v_comp_existente.id,
      'pedido_id', p_pedido_id,
      'entrega_id', v_entrega.id,
      'recebido_por', v_comp_existente.recebido_por,
      'tipo_comprovante', v_comp_existente.tipo_comprovante,
      'registrado_em', v_comp_existente.registrado_em
    );
  END IF;

  SELECT COALESCE(nome, email, 'Equipe Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Logística'; END IF;

  INSERT INTO public.entrega_comprovantes (
    pedido_id,
    entrega_id,
    recebido_por,
    tipo_comprovante,
    documento_recebedor,
    referencia_arquivo,
    hash_arquivo,
    metadata_tecnica,
    chave_idempotencia,
    registrado_por,
    registrado_por_nome,
    registrado_em
  ) VALUES (
    p_pedido_id,
    v_entrega.id,
    v_rec_por,
    v_tipo,
    NULLIF(TRIM(COALESCE(p_documento_recebedor, '')), ''),
    NULLIF(TRIM(COALESCE(p_referencia_arquivo, '')), ''),
    NULLIF(TRIM(COALESCE(p_hash_arquivo, '')), ''),
    COALESCE(p_metadata_tecnica, '{}'::jsonb),
    v_comp_key,
    auth.uid(),
    v_usuario_nome,
    NOW()
  )
  RETURNING id INTO v_comp_id;

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    'COMPROVANTE_REGISTRADO',
    'Comprovante de entrega registrado — recebido por: ' || v_rec_por,
    'evt:' || v_comp_key,
    jsonb_build_object('comprovante_id', v_comp_id, 'recebido_por', v_rec_por, 'tipo_comprovante', v_tipo),
    auth.uid(),
    v_usuario_nome
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'comprovante_id', v_comp_id,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'recebido_por', v_rec_por,
    'tipo_comprovante', v_tipo,
    'registrado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comprovante_entrega(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comprovante_entrega(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. RPC: CONFIRMAR_ENTREGA_PEDIDO (GATES K5, K6, K12, K16)
-- ------------------------------------------------------------------------------
-- Serializa o pedido, transiciona saiu_para_entrega -> entregue de forma idempotente,
-- registra o comprovante quando informado e JAMAIS gera financeiro_lancamentos.
CREATE OR REPLACE FUNCTION public.confirmar_entrega_pedido(
  p_pedido_id BIGINT,
  p_recebido_por TEXT DEFAULT NULL,
  p_tipo_comprovante TEXT DEFAULT 'assinatura_recebedor',
  p_documento_recebedor TEXT DEFAULT NULL,
  p_referencia_arquivo TEXT DEFAULT NULL,
  p_hash_arquivo TEXT DEFAULT NULL,
  p_observacao TEXT DEFAULT NULL,
  p_chave_idempotencia TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_rota_id BIGINT;
  v_usuario_nome TEXT;
  v_rec_por TEXT := COALESCE(NULLIF(TRIM(COALESCE(p_recebido_por, '')), ''), 'Destinatário');
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_evt_key TEXT;
  v_comp_res JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas equipe autorizada pode confirmar conclusão de entrega.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  -- Lock serializado no pedido (Gate K16)
  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' OR v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_CANCELLED', 'error', 'Pedido cancelado não pode ter entrega confirmada.');
  END IF;

  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_DELIVERY_MODALITY',
      'error', 'Este pedido é de retirada na loja. Use a conclusão de retirada no balcão.'
    );
  END IF;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id
  FOR UPDATE;

  -- Gate K6: Idempotência estrita — se já consta entregue, não duplica evento nem comprovante
  IF v_ped.status_operacional = 'entregue' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'entrega_id', v_entrega.id,
      'status_operacional', 'entregue',
      'status_logistico', 'entregue'
    );
  END IF;

  -- Exige que tenha saído para entrega antes de confirmar entrega logística
  IF v_ped.status_operacional <> 'saiu_para_entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_DISPATCHED',
      'error', 'O pedido precisa ser despachado (saiu_para_entrega) antes de confirmar a entrega.',
      'status_operacional_atual', v_ped.status_operacional
    );
  END IF;

  IF v_entrega.id IS NULL THEN
    INSERT INTO public.entregas (
      pedido_id, status_logistico, tentativas_count, despachado_em, created_at, updated_at
    ) VALUES (
      p_pedido_id, 'em_rota', 1, NOW(), NOW(), NOW()
    )
    RETURNING * INTO v_entrega;
  END IF;

  SELECT re.rota_id INTO v_rota_id
  FROM public.rota_entregas re
  WHERE re.entrega_id = v_entrega.id
    AND re.ativo = true
  LIMIT 1;

  SELECT COALESCE(nome, email, 'Equipe Logística') INTO v_usuario_nome
  FROM public.profiles WHERE id = auth.uid();
  IF v_usuario_nome IS NULL THEN v_usuario_nome := 'Equipe Logística'; END IF;

  -- Gate K5 & K12: Atualiza status_operacional para 'entregue' SEM tocar em financeiro_lancamentos
  UPDATE public.pedidos
  SET status_operacional = 'entregue',
      status = 'Entregue',
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    p_pedido_id, 'operacional', v_ped.status_operacional, 'entregue',
    auth.uid(), v_usuario_nome, 'admin',
    jsonb_build_object('acao', 'confirmar_entrega_pedido', 'recebido_por', v_rec_por, 'rota_id', v_rota_id)
  );

  UPDATE public.entregas
  SET status_logistico = 'entregue',
      entregue_em = NOW(),
      observacoes_logisticas = COALESCE(v_obs, observacoes_logisticas),
      updated_at = NOW()
  WHERE id = v_entrega.id;

  v_evt_key := COALESCE(
    NULLIF(TRIM(COALESCE(p_chave_idempotencia, '')), ''),
    'entregue:ped:' || p_pedido_id::TEXT
  );

  INSERT INTO public.entrega_eventos (
    entrega_id,
    pedido_id,
    rota_id,
    tipo_evento,
    descricao,
    chave_idempotencia,
    metadata,
    usuario_id,
    usuario_nome
  ) VALUES (
    v_entrega.id,
    p_pedido_id,
    v_rota_id,
    'ENTREGUE',
    COALESCE(v_obs, 'Entrega concluída com sucesso. Recebido por: ' || v_rec_por),
    v_evt_key,
    jsonb_build_object('recebido_por', v_rec_por, 'tentativas', v_entrega.tentativas_count),
    auth.uid(),
    v_usuario_nome
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING;

  -- Registra o comprovante canônico de entrega de forma idempotente
  v_comp_res := public.registrar_comprovante_entrega(
    p_pedido_id := p_pedido_id,
    p_recebido_por := v_rec_por,
    p_tipo_comprovante := COALESCE(p_tipo_comprovante, 'assinatura_recebedor'),
    p_documento_recebedor := p_documento_recebedor,
    p_referencia_arquivo := p_referencia_arquivo,
    p_hash_arquivo := p_hash_arquivo,
    p_metadata_tecnica := jsonb_build_object('origem', 'confirmar_entrega_pedido'),
    p_chave_idempotencia := 'comp:confirmacao:ped:' || p_pedido_id::TEXT
  );

  -- Se todas as entregas ativas da rota estiverem entregues, marca a rota como concluída
  IF v_rota_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.rota_entregas re
      JOIN public.entregas e ON e.id = re.entrega_id
      WHERE re.rota_id = v_rota_id
        AND re.ativo = true
        AND e.status_logistico <> 'entregue'
    ) THEN
      UPDATE public.rotas_entrega
      SET status = 'concluida',
          concluida_em = NOW(),
          updated_at = NOW()
      WHERE id = v_rota_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'pedido_id', p_pedido_id,
    'entrega_id', v_entrega.id,
    'rota_id', v_rota_id,
    'status_operacional', 'entregue',
    'status_logistico', 'entregue',
    'recebido_por', v_rec_por,
    'comprovante_id', v_comp_res->>'comprovante_id'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_entrega_pedido(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirmar_entrega_pedido(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC: OBTER_PAINEL_LOGISTICA (VISÃO OPERACIONAL DA EQUIPE: EXPEDIÇÃO, ROTAS, EM ROTA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_logistica(
  p_data DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_data_ref DATE := COALESCE(p_data, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);
  v_expedicao JSONB;
  v_rotas JSONB;
  v_em_rota JSONB;
  v_qtd_prontos INTEGER := 0;
  v_qtd_em_rota INTEGER := 0;
  v_qtd_falha INTEGER := 0;
  v_qtd_entregues INTEGER := 0;
  v_qtd_rotas INTEGER := 0;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores ou operadores podem consultar o painel de logística.'
    );
  END IF;

  -- 1. EXPEDIÇÃO: pedidos de entrega com status_operacional = 'pronto' aguardando despacho
  SELECT COALESCE(jsonb_agg(row_to_json(exp_row)::jsonb ORDER BY exp_row.data_entrega ASC, exp_row.hora_entrega ASC NULLS LAST, exp_row.pedido_id ASC), '[]'::jsonb)
  INTO v_expedicao
  FROM (
    SELECT
      p.id AS pedido_id,
      p.nome_cliente,
      p.telefone_cliente,
      p.endereco_entrega,
      p.data_entrega,
      p.hora_entrega,
      p.status_comercial,
      p.status_operacional,
      COALESCE(e.id, NULL) AS entrega_id,
      COALESCE(e.status_logistico, 'aguardando_despacho') AS status_logistico,
      r.id AS rota_id,
      r.codigo AS rota_codigo,
      r.turno AS rota_turno,
      r.responsavel_nome AS rota_responsavel,
      re.ordem_sequencia
    FROM public.pedidos p
    LEFT JOIN public.entregas e ON e.pedido_id = p.id
    LEFT JOIN public.rota_entregas re ON re.entrega_id = e.id AND re.ativo = true
    LEFT JOIN public.rotas_entrega r ON r.id = re.rota_id
    WHERE COALESCE(p.modalidade_entrega, 'retirada') = 'entrega'
      AND p.status_comercial <> 'cancelado'
      AND p.status_operacional = 'pronto'
      AND (p_data IS NULL OR p.data_entrega = v_data_ref OR COALESCE(e.proxima_janela_data, p.data_entrega) = v_data_ref)
  ) exp_row;

  -- 2. ROTAS DO DIA
  SELECT COALESCE(jsonb_agg(row_to_json(rt_row)::jsonb ORDER BY rt_row.data_rota DESC, rt_row.id DESC), '[]'::jsonb)
  INTO v_rotas
  FROM (
    SELECT
      r.id,
      r.codigo,
      r.data_rota,
      r.turno,
      r.responsavel_nome,
      r.responsavel_telefone,
      r.veiculo_identificacao,
      r.status,
      r.observacoes_internas,
      r.iniciada_em,
      r.concluida_em,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'ordem_sequencia', re.ordem_sequencia,
            'pedido_id', p.id,
            'entrega_id', e.id,
            'nome_cliente', p.nome_cliente,
            'telefone_cliente', p.telefone_cliente,
            'endereco_entrega', p.endereco_entrega,
            'hora_entrega', p.hora_entrega,
            'status_operacional', p.status_operacional,
            'status_logistico', e.status_logistico,
            'tentativas_count', e.tentativas_count,
            'ultimo_motivo_falha', e.ultimo_motivo_falha
          ) ORDER BY re.ordem_sequencia ASC, re.id ASC
        )
        FROM public.rota_entregas re
        JOIN public.entregas e ON e.id = re.entrega_id
        JOIN public.pedidos p ON p.id = re.pedido_id
        WHERE re.rota_id = r.id
          AND re.ativo = true
      ), '[]'::jsonb) AS paradas
    FROM public.rotas_entrega r
    WHERE r.data_rota = v_data_ref
  ) rt_row;

  -- 3. EM ROTA / OCORRÊNCIAS / ENTREGUES
  SELECT COALESCE(jsonb_agg(row_to_json(tr_row)::jsonb ORDER BY tr_row.updated_at DESC, tr_row.pedido_id DESC), '[]'::jsonb)
  INTO v_em_rota
  FROM (
    SELECT
      p.id AS pedido_id,
      e.id AS entrega_id,
      p.nome_cliente,
      p.telefone_cliente,
      p.endereco_entrega,
      p.data_entrega,
      p.hora_entrega,
      p.status_operacional,
      e.status_logistico,
      e.tentativas_count,
      e.ultimo_motivo_falha,
      e.proxima_janela_data,
      e.proxima_janela_hora,
      e.despachado_em,
      e.entregue_em,
      e.observacoes_logisticas,
      e.updated_at,
      r.id AS rota_id,
      r.codigo AS rota_codigo,
      r.responsavel_nome AS rota_responsavel,
      re.ordem_sequencia,
      (
        SELECT jsonb_build_object(
          'comprovante_id', ec.id,
          'recebido_por', ec.recebido_por,
          'tipo_comprovante', ec.tipo_comprovante,
          'referencia_arquivo', ec.referencia_arquivo,
          'registrado_em', ec.registrado_em
        )
        FROM public.entrega_comprovantes ec
        WHERE ec.pedido_id = p.id
        ORDER BY ec.id DESC
        LIMIT 1
      ) AS comprovante
    FROM public.pedidos p
    JOIN public.entregas e ON e.pedido_id = p.id
    LEFT JOIN public.rota_entregas re ON re.entrega_id = e.id AND re.ativo = true
    LEFT JOIN public.rotas_entrega r ON r.id = re.rota_id
    WHERE COALESCE(p.modalidade_entrega, 'retirada') = 'entrega'
      AND (
        p.status_operacional = 'saiu_para_entrega'
        OR e.status_logistico IN ('em_rota', 'falha_temporaria', 'reagendada')
        OR (p.status_operacional = 'entregue' AND (p.data_entrega = v_data_ref OR (e.entregue_em AT TIME ZONE 'America/Fortaleza')::DATE = v_data_ref))
      )
  ) tr_row;

  SELECT COUNT(*) INTO v_qtd_prontos FROM jsonb_array_elements(v_expedicao);
  SELECT COUNT(*) INTO v_qtd_rotas FROM jsonb_array_elements(v_rotas);

  SELECT
    COUNT(*) FILTER (WHERE e.status_logistico = 'em_rota'),
    COUNT(*) FILTER (WHERE e.status_logistico IN ('falha_temporaria', 'reagendada')),
    COUNT(*) FILTER (WHERE e.status_logistico = 'entregue' AND (p.data_entrega = v_data_ref OR (e.entregue_em AT TIME ZONE 'America/Fortaleza')::DATE = v_data_ref))
  INTO v_qtd_em_rota, v_qtd_falha, v_qtd_entregues
  FROM public.entregas e
  JOIN public.pedidos p ON p.id = e.pedido_id
  WHERE COALESCE(p.modalidade_entrega, 'retirada') = 'entrega';

  RETURN jsonb_build_object(
    'success', true,
    'data_referencia', v_data_ref,
    'resumo', jsonb_build_object(
      'prontos_expedicao', v_qtd_prontos,
      'em_rota', v_qtd_em_rota,
      'com_falha_ou_reagendados', v_qtd_falha,
      'entregues_no_dia', v_qtd_entregues,
      'rotas_no_dia', v_qtd_rotas
    ),
    'expedicao_aguardando', v_expedicao,
    'rotas_do_dia', v_rotas,
    'em_rota_e_ocorrencias', v_em_rota
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_painel_logistica(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_logistica(DATE) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 16. RPC PORTAL DO CLIENTE: OBTER_ACOMPANHAMENTO_ENTREGA_CLIENTE (GATES K9, K14, K15)
-- ------------------------------------------------------------------------------
-- Resolve identidade exclusivamente por _resolver_meu_cliente_id() (auth.uid()).
-- Jamais expõe telefone do entregador, notas logísticas da equipe, placa,
-- rota completa, endereços de outros clientes ou comprovantes de terceiros.
CREATE OR REPLACE FUNCTION public.obter_acompanhamento_entrega_cliente(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_ped public.pedidos;
  v_entrega public.entregas;
  v_eventos JSONB;
  v_comp JSONB;
  v_etapa_cliente TEXT;
  v_prod_concluida BOOLEAN := false;
  v_saiu_entrega BOOLEAN := false;
  v_em_rota BOOLEAN := false;
  v_entregue BOOLEAN := false;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Gate K14: Isolamento estrito por titular da conta
  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
    AND cliente_id_rel = v_cli_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Pedido não encontrado para sua conta.'
    );
  END IF;

  -- Gate K15: Pedido de retirada não acessa tracking de rota de entrega
  IF COALESCE(v_ped.modalidade_entrega, 'retirada') <> 'entrega' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'DELIVERY_TRACKING_NOT_APPLICABLE',
      'error', 'Este pedido está na modalidade retirada na loja e não possui rastreamento de rota de entrega.'
    );
  END IF;

  SELECT * INTO v_entrega
  FROM public.entregas
  WHERE pedido_id = p_pedido_id;

  v_etapa_cliente := public._derivar_etapa_cliente_pedido(
    v_ped.status_comercial,
    v_ped.status_operacional,
    v_ped.modalidade_entrega
  );

  v_prod_concluida := v_ped.status_operacional IN ('pronto', 'saiu_para_entrega', 'entregue');
  v_saiu_entrega := v_ped.status_operacional IN ('saiu_para_entrega', 'entregue') OR v_entrega.despachado_em IS NOT NULL;
  v_em_rota := v_ped.status_operacional = 'saiu_para_entrega' AND COALESCE(v_entrega.status_logistico, 'em_rota') = 'em_rota';
  v_entregue := v_ped.status_operacional = 'entregue';

  -- Gate K9: Linha do tempo estritamente sanitizada (sem usuario_nome, sem rota_id, sem notas internas)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'tipo_evento', ev.tipo_evento,
      'titulo', CASE ev.tipo_evento
        WHEN 'DESPACHADO' THEN 'Saiu para entrega'
        WHEN 'NOVA_TENTATIVA_DESPACHO' THEN 'Nova saída para entrega iniciada'
        WHEN 'FALHA_ENTREGA' THEN 'Tentativa de entrega não concluída'
        WHEN 'REAGENDADO' THEN 'Entrega reagendada'
        WHEN 'ENTREGUE' THEN 'Pedido entregue'
        ELSE 'Atualização de entrega'
      END,
      'motivo_falha', ev.motivo_falha,
      'horario', ev.created_at
    ) ORDER BY ev.id ASC
  ), '[]'::jsonb)
  INTO v_eventos
  FROM public.entrega_eventos ev
  WHERE ev.pedido_id = p_pedido_id
    AND ev.tipo_evento IN ('DESPACHADO', 'NOVA_TENTATIVA_DESPACHO', 'FALHA_ENTREGA', 'REAGENDADO', 'ENTREGUE');

  -- Comprovante sanitizado do próprio pedido (apenas recebido_por, tipo_comprovante e registrado_em)
  SELECT jsonb_build_object(
    'recebido_por', ec.recebido_por,
    'tipo_comprovante', ec.tipo_comprovante,
    'registrado_em', ec.registrado_em
  )
  INTO v_comp
  FROM public.entrega_comprovantes ec
  WHERE ec.pedido_id = p_pedido_id
  ORDER BY ec.id DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'rastreamento', jsonb_build_object(
      'pedido_id', v_ped.id,
      'data_entrega_prevista', v_ped.data_entrega,
      'hora_entrega_prevista', v_ped.hora_entrega,
      'etapa_cliente', v_etapa_cliente,
      'status_logistico', COALESCE(v_entrega.status_logistico, CASE
        WHEN v_ped.status_operacional = 'entregue' THEN 'entregue'
        WHEN v_ped.status_operacional = 'saiu_para_entrega' THEN 'em_rota'
        ELSE 'aguardando_despacho'
      END),
      'tentativas_realizadas', COALESCE(v_entrega.tentativas_count, 0),
      'ultimo_motivo_falha', v_entrega.ultimo_motivo_falha,
      'proxima_janela_data', v_entrega.proxima_janela_data,
      'proxima_janela_hora', v_entrega.proxima_janela_hora,
      'despachado_em', v_entrega.despachado_em,
      'entregue_em', v_entrega.entregue_em,
      'etapas_visuais', jsonb_build_object(
        'producao_concluida', v_prod_concluida,
        'saiu_para_entrega', v_saiu_entrega,
        'em_rota', v_em_rota,
        'entregue', v_entregue
      ),
      'eventos', v_eventos,
      'comprovante', v_comp
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_acompanhamento_entrega_cliente(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_acompanhamento_entrega_cliente(BIGINT) TO authenticated, service_role;
