-- ==============================================================================
-- MIGRATION 033: HOTFIX DE ORÇAMENTOS ADMIN (CORREÇÃO DE P_NOVO_STATUS)
-- ==============================================================================
-- Corrige a RPC public.buscar_orcamentos_admin que continha referência à variável
-- inexistente p_novo_status no bloco DECLARE (v_st).
-- Garante compatibilidade forward-only para qualquer ambiente em migração contínua.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.buscar_orcamentos_admin(
  p_busca TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_termo TEXT := NULLIF(TRIM(COALESCE(p_busca, '')), '');
  v_st TEXT := NULLIF(TRIM(COALESCE(p_status, '')), '');
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
