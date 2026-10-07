-- ==========================================================================
-- LUNOCA DOCERIA - Níveis de Acesso: Cliente, Operador e Administrador
-- Execute este script no SQL Editor do Supabase (https://supabase.com)
-- ==========================================================================

-- 1. Atualizar a restrição CHECK da tabela profiles para permitir 'operador'
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_nivel_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_nivel_check 
  CHECK (nivel IN ('cliente', 'operador', 'admin'));

-- 2. Função auxiliar de segurança para checar se é Admin ou Operador
CREATE OR REPLACE FUNCTION public.is_admin_or_operator()
RETURNS BOOLEAN AS $$
DECLARE
  v_nivel TEXT;
BEGIN
  SELECT nivel INTO v_nivel
  FROM public.profiles
  WHERE id = auth.uid();
  RETURN COALESCE(v_nivel IN ('admin', 'operador'), false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Políticas RLS para Produtos: Permite que Operadores cadastrem e editem produtos
DROP POLICY IF EXISTS "Apenas admins podem inserir produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins podem atualizar produtos" ON public.produtos;
DROP POLICY IF EXISTS "Admins e operadores podem inserir produtos" ON public.produtos;
DROP POLICY IF EXISTS "Admins e operadores podem atualizar produtos" ON public.produtos;

CREATE POLICY "Admins e operadores podem inserir produtos" 
  ON public.produtos 
  FOR INSERT 
  WITH CHECK (is_admin_or_operator());

CREATE POLICY "Admins e operadores podem atualizar produtos" 
  ON public.produtos 
  FOR UPDATE 
  USING (is_admin_or_operator());

-- 4. Exemplo de uso para definir um operador (opcional):
-- UPDATE public.profiles SET nivel = 'operador' WHERE email = 'funcionario@lunocadoceria.com.br';
