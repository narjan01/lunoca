-- ==========================================================================
-- MIGRATION 016: RECONCILIAÇÃO PÓS-015 & HARDENING DE AUTORIZAÇÃO
-- ==========================================================================
-- 1. Elimina 'current_user' de funções SECURITY DEFINER (vulnerabilidade crítica de elevação de privilégio).
--    Em funções SECURITY DEFINER, 'current_user' assume a identidade do owner ('postgres'),
--    fazendo com que 'anon' e 'authenticated' comuns avaliassem indevidamente como true.
-- 2. Constrói helpers canônicos baseados estritamente em auth.role() = 'service_role',
--    auth.uid() no perfil, e conscientemente session_user IN ('postgres', 'supabase_admin')
--    apenas para sessões de manutenção direta do banco.
-- 3. Governança estrita de privilégios de execução (REVOKE de PUBLIC/anon em RPCs administrativas).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. HELPERS CANÔNICOS DE AUTORIZAÇÃO (SEM CURRENT_USER EM SECURITY DEFINER)
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  -- Service role key / backend legítimo possui bypass administrativo
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

  -- Nenhuma autenticação presente
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  -- Consulta estrita e fail-closed da tabela canônica de perfis
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
  -- Service role key / backend legítimo possui bypass administrativo
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

  -- Nenhuma autenticação presente
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  -- Consulta estrita e fail-closed da tabela canônica de perfis
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND nivel IN ('admin', 'operador') 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Revoga explicitamente de PUBLIC e concede apenas para roles controladas
REVOKE ALL ON FUNCTION public.is_admin FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_admin_or_operator FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_operator TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 2. GOVERNANÇA DE GRANTS PARA AS RPCS ADMINISTRATIVAS (FAIL-CLOSED)
-- --------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.cancelar_pedido_equipe FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_equipe TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gerenciar_confirmacao_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerenciar_confirmacao_pedido_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ajustar_estoque_operacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_estoque_operacao TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.alterar_controle_estoque_produto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_controle_estoque_produto TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_preview_comunicacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_preview_comunicacao TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_cliente TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.listar_orcamentos_para_lembrete FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_orcamentos_para_lembrete TO authenticated, service_role;

-- As funções públicas de orçamento permanecem acessíveis a 'anon' para visualização e aprovação pública:
GRANT EXECUTE ON FUNCTION public.obter_orcamento_publico TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.aprovar_orcamento_publico TO anon, authenticated, service_role;
