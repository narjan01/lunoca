-- ==========================================
-- LUNOCA - Esquema de Banco de Dados Supabase
-- ==========================================

-- 1. Função Auxiliar: Verificar se o usuário atual é admin
-- Usado nas políticas RLS (Row Level Security)
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  is_admin BOOLEAN;
BEGIN
  SELECT (nivel = 'admin') INTO is_admin
  FROM public.profiles
  WHERE id = auth.uid();
  RETURN COALESCE(is_admin, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Tabela de Perfis de Usuário (Profiles)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  cpf TEXT,
  telefone TEXT,
  cep TEXT,
  endereco TEXT,
  numero TEXT,
  complemento TEXT,
  nivel TEXT CHECK (nivel IN ('cliente', 'admin')) DEFAULT 'cliente',
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS para Profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Políticas de RLS para Profiles
CREATE POLICY "Usuários podem ver seu próprio perfil" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Admins podem ver todos os perfis" ON public.profiles FOR SELECT USING (is_admin());
CREATE POLICY "Usuários podem atualizar seu próprio perfil" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admins podem atualizar todos os perfis" ON public.profiles FOR UPDATE USING (is_admin());

-- 3. Tabela de Produtos
CREATE TABLE public.produtos (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  preco DECIMAL(10,2) NOT NULL,
  descricao TEXT,
  opcoes TEXT,
  img_url TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS para Produtos
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;

-- Políticas de RLS para Produtos
CREATE POLICY "Produtos são visíveis publicamente" ON public.produtos FOR SELECT USING (true);
CREATE POLICY "Apenas admins podem inserir produtos" ON public.produtos FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "Apenas admins podem atualizar produtos" ON public.produtos FOR UPDATE USING (is_admin());
CREATE POLICY "Apenas admins podem deletar produtos" ON public.produtos FOR DELETE USING (is_admin());

-- 4. Tabela de Pedidos
CREATE TABLE public.pedidos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id UUID REFERENCES public.profiles(id),
  nome_cliente TEXT NOT NULL,
  email_cliente TEXT NOT NULL,
  data_pedido DATE NOT NULL,
  data_entrega DATE NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  pagamento TEXT CHECK (pagamento IN ('pix', 'cartao')) NOT NULL,
  status TEXT CHECK (status IN ('Pendente', 'Confirmado', 'Em Preparo', 'Pronto', 'Entregue', 'Cancelado')) DEFAULT 'Pendente',
  itens TEXT NOT NULL,
  endereco_entrega TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS para Pedidos
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;

-- Políticas de RLS para Pedidos
CREATE POLICY "Usuários podem ver seus próprios pedidos" ON public.pedidos FOR SELECT USING (auth.uid() = cliente_id);
CREATE POLICY "Admins podem ver todos os pedidos" ON public.pedidos FOR SELECT USING (is_admin());
CREATE POLICY "Usuários podem criar seus próprios pedidos" ON public.pedidos FOR INSERT WITH CHECK (auth.uid() = cliente_id);
CREATE POLICY "Admins podem atualizar pedidos" ON public.pedidos FOR UPDATE USING (is_admin());

-- 5. Triggers e Funções Adicionais

-- Função para atualizar updated_at automaticamente na tabela produtos
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_produtos_updated_at
BEFORE UPDATE ON public.produtos
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger para criar um profile automaticamente após o cadastro no Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, nome, email, nivel)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'nome', new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    'cliente'
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 6. Índices para Otimização de Consultas
CREATE INDEX idx_pedidos_data_entrega ON public.pedidos(data_entrega);
CREATE INDEX idx_pedidos_cliente_id ON public.pedidos(cliente_id);
CREATE INDEX idx_pedidos_status ON public.pedidos(status);
CREATE INDEX idx_produtos_ativo ON public.produtos(ativo);
CREATE INDEX idx_profiles_nivel ON public.profiles(nivel);
CREATE INDEX idx_profiles_email ON public.profiles(email);

-- ==========================================
-- INSTRUÇÕES PÓS-CONFIGURAÇÃO:
-- Após executar este script e registrar o primeiro usuário pelo app,
-- torne esse usuário administrador executando o comando abaixo no SQL Editor:
-- 
-- UPDATE public.profiles SET nivel = 'admin' WHERE email = 'seu_email@exemplo.com';
-- ==========================================


-- =======================================================
-- ATUALIZAÇÃO DE SEGURANÇA: Proteção de Nível Admin e RLS
-- =======================================================

-- Trigger para impedir que usuários comuns alterem 'nivel' ou 'ativo'
CREATE OR REPLACE FUNCTION public.check_profile_update()
RETURNS TRIGGER AS $$
DECLARE
    current_user_level TEXT;
BEGIN
    SELECT nivel INTO current_user_level 
    FROM public.profiles 
    WHERE id = auth.uid();

    IF current_user_level IS DISTINCT FROM 'admin' THEN
        IF NEW.nivel IS DISTINCT FROM OLD.nivel THEN
            RAISE EXCEPTION 'Operação não autorizada: você não pode alterar seu nível de privilégio.';
        END IF;

        IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
            RAISE EXCEPTION 'Operação não autorizada: você não pode alterar o status da conta.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_check_profile_update ON public.profiles;
CREATE TRIGGER tr_check_profile_update
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.check_profile_update();

-- =======================================================
-- ATUALIZAÇÃO: Integração Mercado Pago (PIX e Cartão)
-- =======================================================
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_status TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_preference_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_link TEXT;
