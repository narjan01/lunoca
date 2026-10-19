-- ==============================================================================
-- MIGRATION 044: KDS BLOQUEIO DE PRODUÇÃO POR BRIEFING PENDENTE & AJUSTES (PERS13)
-- Princípio: Fail-Closed em kds_avancar_item quando briefing_status <> 'APROVADO'
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. EXPANSÃO DE ENUM/CHECK PARA STATUS DO BRIEFING (SUPORTE A 'AJUSTE_SOLICITADO')
-- ------------------------------------------------------------------------------
ALTER TABLE public.pedido_itens
  DROP CONSTRAINT IF EXISTS pedido_itens_briefing_status_check;

ALTER TABLE public.pedido_itens
  ADD CONSTRAINT pedido_itens_briefing_status_check
  CHECK (briefing_status IN ('NAO_REQUERIDO', 'DISPENSADO', 'PENDENTE_REVISAO', 'APROVADO', 'REJEITADO', 'AJUSTE_SOLICITADO'));

ALTER TABLE public.pedido_item_producao_kds
  DROP CONSTRAINT IF EXISTS pedido_item_producao_kds_briefing_status_check;

ALTER TABLE public.pedido_item_producao_kds
  ADD CONSTRAINT pedido_item_producao_kds_briefing_status_check
  CHECK (briefing_status IN ('DISPENSADO', 'PENDENTE_REVISAO', 'APROVADO', 'REJEITADO', 'AJUSTE_SOLICITADO'));

-- ------------------------------------------------------------------------------
-- 2. RPC CANÔNICA: KDS_AVANCAR_ITEM COM TRAVA FAIL-CLOSED DE BRIEFING (PERS13)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_avancar_item(
  p_kds_item_id UUID,
  p_proximo_estagio VARCHAR
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_item RECORD;
  v_pedido RECORD;
  v_kds RECORD;
  v_proxima_etapa_snap RECORD;
  v_nova_proxima RECORD;
  v_tempo_segundos INT := 0;
  v_todos_prontos BOOLEAN := FALSE;
  v_primeiro_avanco BOOLEAN := FALSE;
  v_estagio_agregado_novo VARCHAR(30);
  v_min_ordem INT;
  v_briefing_status VARCHAR(30);
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas a equipe de cozinha pode operar o KDS.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_proximo_estagio IS NULL OR btrim(p_proximo_estagio) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Próximo estágio é obrigatório.', 'code', 'STAGE_REQUIRED');
  END IF;

  -- 1. Trava atômica no item e no cabeçalho KDS
  SELECT * INTO v_item
  FROM public.pedido_item_producao_kds
  WHERE id = p_kds_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item de produção KDS não encontrado.', 'code', 'ITEM_NOT_FOUND');
  END IF;

  IF NOT v_item.ativo THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este item do KDS já foi encerrado ou cancelado.', 'code', 'ITEM_INACTIVE');
  END IF;

  -- 2. Trava do pedido canônico
  SELECT id, status_operacional INTO v_pedido
  FROM public.pedidos
  WHERE id = v_item.pedido_id
  FOR UPDATE;

  IF v_pedido.status_operacional NOT IN ('aguardando_producao', 'em_producao') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Operação bloqueada: o pedido #' || v_pedido.id || ' encontra-se em status ' || v_pedido.status_operacional,
      'code', 'ORDER_STATUS_INVALID'
    );
  END IF;

  -- 2.1 BLOQUEIO FAIL-CLOSED DE BRIEFING PENDENTE / REJEITADO (PERS13)
  SELECT COALESCE(pi.briefing_status, 'NAO_REQUERIDO')
  INTO v_briefing_status
  FROM public.pedido_itens pi
  WHERE pi.id = v_item.pedido_item_id;

  IF v_briefing_status = 'PENDENTE_REVISAO' THEN
    RAISE EXCEPTION 'BRIEFING_PENDENTE_REVISAO: Transição bloqueada. O briefing deste item está pendente de aprovação pela confeitaria.'
      USING ERRCODE = 'P0001';
  ELSIF v_briefing_status = 'REJEITADO' THEN
    RAISE EXCEPTION 'BRIEFING_REJEITADO: Transição bloqueada. O briefing deste item foi rejeitado.'
      USING ERRCODE = 'P0001';
  ELSIF v_briefing_status = 'AJUSTE_SOLICITADO' THEN
    RAISE EXCEPTION 'BRIEFING_AJUSTE_SOLICITADO: Transição bloqueada. Ajustes foram solicitados no briefing do item.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_kds
  FROM public.pedido_producao_kds
  WHERE id = v_item.kds_id
  FOR UPDATE;

  -- 3. Validação estrita contra o snapshot congelado do item (pedido_item_kds_etapas)
  IF upper(p_proximo_estagio) = 'PRONTO' THEN
    -- Só pode transicionar para PRONTO se já completou a etapa máxima da rota
    IF v_item.ordem_etapa_atual <> v_item.ordem_etapa_max THEN
      RAISE EXCEPTION 'KDS_ILLEGAL_STAGE_JUMP: O item ainda possui etapas pendentes antes de ser concluído.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Procura a próxima etapa no snapshot congelado
    SELECT * INTO v_proxima_etapa_snap
    FROM public.pedido_item_kds_etapas
    WHERE kds_item_id = p_kds_item_id
      AND ordem = v_item.ordem_etapa_atual + 1;

    IF NOT FOUND OR v_proxima_etapa_snap.praca <> upper(p_proximo_estagio) THEN
      RAISE EXCEPTION 'KDS_ILLEGAL_STAGE_JUMP: Estágio % não corresponde à próxima etapa da rota do produto.',
        p_proximo_estagio
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4. Cálculo de tempo transcorrido
  IF v_item.tempo_etapa_iniciado_em IS NOT NULL THEN
    v_tempo_segundos := GREATEST(0, EXTRACT(EPOCH FROM (NOW() - v_item.tempo_etapa_iniciado_em))::INTEGER);
  END IF;

  -- 5. Gravação de auditoria append-only
  INSERT INTO public.pedido_kds_estagio_historico (
    kds_id,
    kds_item_id,
    pedido_id,
    pedido_item_id,
    estagio_origem,
    estagio_destino,
    praca,
    tempo_segundos,
    operador_id,
    transicionado_em
  ) VALUES (
    v_item.kds_id,
    v_item.id,
    v_item.pedido_id,
    v_item.pedido_item_id,
    v_item.estagio_atual,
    upper(p_proximo_estagio),
    CASE WHEN upper(p_proximo_estagio) = 'PRONTO' THEN NULL ELSE upper(p_proximo_estagio) END,
    v_tempo_segundos,
    v_caller_id,
    NOW()
  );

  -- 6. Atualização do item de produção
  IF upper(p_proximo_estagio) = 'PRONTO' THEN
    UPDATE public.pedido_item_producao_kds
    SET estagio_atual = 'PRONTO',
        praca_atual = NULL,
        proxima_etapa = NULL,
        operador_id = v_caller_id,
        encerrado_em = NOW(),
        motivo_encerramento = 'CONCLUIDO',
        updated_at = NOW()
    WHERE id = p_kds_item_id;
  ELSE
    -- Buscar se há outra etapa seguinte além desta
    SELECT praca, sla_minutos_snapshot INTO v_nova_proxima
    FROM public.pedido_item_kds_etapas
    WHERE kds_item_id = p_kds_item_id
      AND ordem = v_proxima_etapa_snap.ordem + 1;

    UPDATE public.pedido_item_producao_kds
    SET ordem_etapa_atual = v_proxima_etapa_snap.ordem,
        estagio_atual = v_proxima_etapa_snap.praca,
        praca_atual = v_proxima_etapa_snap.praca,
        proxima_etapa = COALESCE(v_nova_proxima.praca, 'PRONTO'),
        tempo_etapa_iniciado_em = NOW(),
        sla_etapa_snapshot = v_proxima_etapa_snap.sla_minutos_snapshot,
        operador_id = v_caller_id,
        updated_at = NOW()
    WHERE id = p_kds_item_id;
  END IF;

  -- 7. Atualização do Cabeçalho KDS e do Pedido Canônico
  -- Se foi o 1º avanço fora de AGUARDANDO no KDS:
  IF v_kds.estagio_agregado = 'AGUARDANDO' THEN
    UPDATE public.pedido_producao_kds
    SET iniciado_em = COALESCE(iniciado_em, NOW()),
        estagio_agregado = upper(p_proximo_estagio),
        updated_at = NOW()
    WHERE id = v_item.kds_id;

    IF v_pedido.status_operacional = 'aguardando_producao' THEN
      UPDATE public.pedidos
      SET status_operacional = 'em_producao',
          updated_at = NOW()
      WHERE id = v_pedido.id;
    END IF;
  END IF;

  -- 8. Verificar se todos os itens atingiram PRONTO
  SELECT NOT EXISTS (
    SELECT 1 FROM public.pedido_item_producao_kds
    WHERE kds_id = v_item.kds_id
      AND ativo = TRUE
      AND estagio_atual <> 'PRONTO'
  ) INTO v_todos_prontos;

  IF v_todos_prontos THEN
    UPDATE public.pedido_producao_kds
    SET estagio_agregado = 'PRONTO',
        concluido_em = NOW(),
        ativo = FALSE,
        encerrado_em = NOW(),
        motivo_encerramento = 'CONCLUIDO',
        updated_at = NOW()
    WHERE id = v_item.kds_id;

    -- Conclusão canônica do pedido para pronto
    UPDATE public.pedidos
    SET status_operacional = 'pronto',
        updated_at = NOW()
    WHERE id = v_pedido.id;

    INSERT INTO public.pedido_status_historico (
      pedido_id,
      dimensao,
      status_anterior,
      status_novo,
      motivo,
      alterado_por,
      created_at
    ) VALUES (
      v_pedido.id,
      'operacional',
      v_pedido.status_operacional,
      'pronto',
      'Todos os itens concluídos na esteira KDS',
      v_caller_id,
      NOW()
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'kds_item_id', p_kds_item_id,
    'estagio_novo', upper(p_proximo_estagio),
    'pedido_id', v_pedido.id,
    'todos_prontos', v_todos_prontos
  );
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.kds_avancar_item(UUID, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_avancar_item(UUID, VARCHAR) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. EXPANSÃO DE RPC: APROVAR_BRIEFING_ITEM COM SUPORTE A DECISÃO E AJUSTE
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revisar_briefing_item(
  p_pedido_item_id BIGINT,
  p_decisao VARCHAR,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_item RECORD;
  v_novo_status VARCHAR(30);
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem revisar briefings.');
  END IF;

  SELECT * INTO v_item
  FROM public.pedido_itens
  WHERE id = p_pedido_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item do pedido não encontrado.');
  END IF;

  v_novo_status := upper(btrim(p_decisao));
  IF v_novo_status NOT IN ('APROVADO', 'REJEITADO', 'AJUSTE_SOLICITADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decisão inválida. Valores aceitos: APROVADO, REJEITADO, AJUSTE_SOLICITADO.');
  END IF;

  IF v_novo_status IN ('REJEITADO', 'AJUSTE_SOLICITADO') AND (p_motivo IS NULL OR btrim(p_motivo) = '') THEN
    RETURN jsonb_build_object('success', false, 'error', 'É obrigatório fornecer um motivo/orientação ao rejeitar ou solicitar ajustes no briefing.');
  END IF;

  UPDATE public.pedido_itens
  SET briefing_status = v_novo_status,
      briefing_revisado_em = NOW(),
      briefing_revisado_por = v_caller_id,
      briefing_motivo_rejeicao = CASE WHEN v_novo_status IN ('REJEITADO', 'AJUSTE_SOLICITADO') THEN p_motivo ELSE NULL END
  WHERE id = p_pedido_item_id;

  UPDATE public.pedido_item_producao_kds
  SET briefing_status = v_novo_status,
      updated_at = NOW()
  WHERE pedido_item_id = p_pedido_item_id;

  INSERT INTO public.pedido_item_personalizacao_historico (
    pedido_item_id, personalizacao_id, campo_codigo, valor_anterior, valor_novo, motivo, alterado_por, alterado_em
  ) VALUES (
    p_pedido_item_id, NULL, 'briefing_status', to_jsonb(v_item.briefing_status), to_jsonb(v_novo_status),
    COALESCE(p_motivo, 'Decisão de briefing: ' || v_novo_status),
    v_caller_id, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_item_id', p_pedido_item_id,
    'status_anterior', v_item.briefing_status,
    'status_novo', v_novo_status
  );
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.revisar_briefing_item(BIGINT, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revisar_briefing_item(BIGINT, VARCHAR, TEXT) TO authenticated, service_role;

-- Compatibilidade retroativa com aprovar_briefing_item(BIGINT, BOOLEAN, TEXT)
CREATE OR REPLACE FUNCTION public.aprovar_briefing_item(
  p_pedido_item_id BIGINT,
  p_aprovado BOOLEAN,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
BEGIN
  IF p_aprovado THEN
    RETURN public.revisar_briefing_item(p_pedido_item_id, 'APROVADO', p_motivo);
  ELSE
    RETURN public.revisar_briefing_item(p_pedido_item_id, 'REJEITADO', p_motivo);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_briefing_item(BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_briefing_item(BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;
