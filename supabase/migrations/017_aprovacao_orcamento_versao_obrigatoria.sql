-- ==========================================================================
-- MIGRATION 017: APROVAÇÃO PÚBLICA DE ORÇAMENTO COM VERSÃO OBRIGATÓRIA
-- ==========================================================================
-- 1. Remove qualquer versão anterior e elimina valor default nulo do parâmetro p_versao_esperada.
-- 2. Torna p_versao_esperada INTEGER estritamente obrigatório (sem default) na assinatura.
-- 3. Adiciona guarda fail-closed explícita no início da função caso p_versao_esperada seja NULL ou < 1:
--    retorna code: 'VERSION_REQUIRED'.
-- 4. Mantém rate limiting, concorrência FOR UPDATE, status checks, idempotência e auditoria.
-- 5. Revoga de PUBLIC e concede execução a anon, authenticated e service_role.
-- ==========================================================================

DROP FUNCTION IF EXISTS public.aprovar_orcamento_publico(UUID);
DROP FUNCTION IF EXISTS public.aprovar_orcamento_publico(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(
  p_token UUID,
  p_versao_esperada INTEGER
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_orc public.orcamentos;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- Guarda de versão estritamente obrigatória (sem fallback / sem bypass de versionamento)
  IF p_versao_esperada IS NULL OR p_versao_esperada < 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'VERSION_REQUIRED',
      'error', 'A versão esperada da proposta é obrigatória para aprovação pública.'
    );
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
  IF v_orc.versao <> p_versao_esperada THEN
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
