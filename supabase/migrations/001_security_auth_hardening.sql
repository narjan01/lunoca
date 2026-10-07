-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 001: SEGURANÇA E AUTORIZAÇÃO (FASE 1)
-- Erradica autoelevação para admin, fecha RPCs públicas e blinda SECURITY DEFINER
-- ==========================================================================

-- 1. Cláusula search_path e funções de autorização seguras
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
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
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND nivel IN ('admin', 'operador') 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_user_active()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 2. Trigger automático para novos cadastros (Impossibilita autoelevação)
-- Força sempre nivel = 'cliente' e ativo = true
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    nome,
    email,
    nivel,
    ativo,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'nome',
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1)
    ),
    NEW.email,
    'cliente',  -- Regra estrita: qualquer novo usuário entra como cliente
    true,       -- Ativo por padrão
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- Conectar o trigger à tabela de autenticação auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Proteção rigorosa contra alteração de privilégios (nivel e ativo)
CREATE OR REPLACE FUNCTION public.check_profile_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT public.is_admin() THEN
    IF NEW.nivel IS DISTINCT FROM OLD.nivel THEN
      RAISE EXCEPTION 'Acesso negado: apenas administradores ativos podem alterar o nível de acesso.';
    END IF;
    IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
      RAISE EXCEPTION 'Acesso negado: apenas administradores ativos podem ativar ou desativar contas.';
    END IF;
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trigger_check_profile_update ON public.profiles;
CREATE TRIGGER trigger_check_profile_update
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.check_profile_update();

-- 4. Remoção da política pública de INSERT na tabela profiles
-- Clientes não podem inserir profiles diretamente via REST
DROP POLICY IF EXISTS "Criação de perfil no cadastro inicial" ON public.profiles;
DROP POLICY IF EXISTS "Apenas admins inserem perfis manualmente" ON public.profiles;

CREATE POLICY "Apenas admins inserem perfis manualmente"
  ON public.profiles FOR INSERT
  WITH CHECK (public.is_admin());

-- 5. Revogação estrita de RPCs críticas de pagamento e estoque
-- Apenas service_role pode executar
REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.baixar_estoque_pedido_batch(BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baixar_estoque_pedido_batch(BIGINT, JSONB) TO service_role;

-- 6. Garantir busca segura em criar_pedido e validar_recalcular_total_pedido
CREATE OR REPLACE FUNCTION public.validar_recalcular_total_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod_preco DECIMAL(10,2);
  v_total_calculado DECIMAL(10,2) := 0;
  v_possui_itens_validos BOOLEAN := false;
BEGIN
  IF NEW.itens_json IS NOT NULL AND jsonb_typeof(NEW.itens_json) = 'array' AND jsonb_array_length(NEW.itens_json) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.itens_json)
    LOOP
      v_prod_id := (v_item->>'id')::BIGINT;
      v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

      IF v_prod_id IS NOT NULL THEN
        SELECT preco INTO v_prod_preco
        FROM public.produtos
        WHERE id = v_prod_id;

        IF FOUND THEN
          v_total_calculado := v_total_calculado + (v_prod_preco * v_qtd);
          v_possui_itens_validos := true;
        END IF;
      END IF;
    END LOOP;

    IF v_possui_itens_validos AND v_total_calculado > 0 THEN
      NEW.total := v_total_calculado;
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
