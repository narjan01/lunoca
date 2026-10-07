-- ==========================================================================
-- LUNOCA DOCERIA - SCRIPT MESTRE DE INSTALAÇÃO & HARDENING (v3.0.0)
-- Execução única, idempotente e segura no SQL Editor do Supabase.
-- Corrige todas as vulnerabilidades de RLS, total manipulado, estoque e usuários inativos.
-- ==========================================================================

-- 1. Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================================================
-- 2. TABELAS PRINCIPAIS
-- ==========================================================================

-- 2.1 Profiles (Usuários da loja)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  cpf TEXT,
  telefone TEXT,
  cep TEXT,
  endereco TEXT,
  numero TEXT,
  complemento TEXT,
  nivel TEXT CHECK (nivel IN ('cliente', 'operador', 'admin')) DEFAULT 'cliente',
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Garantir colunas essenciais caso a tabela já existisse
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cpf TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS telefone TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nivel TEXT DEFAULT 'cliente';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2.2 Produtos
CREATE TABLE IF NOT EXISTS public.produtos (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  preco DECIMAL(10,2) NOT NULL,
  descricao TEXT,
  opcoes TEXT,
  img_url TEXT,
  ativo BOOLEAN DEFAULT true,
  estoque_qtd INTEGER DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 5,
  controlar_estoque BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_qtd INTEGER DEFAULT 0;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER DEFAULT 5;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS controlar_estoque BOOLEAN DEFAULT true;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2.3 Pedidos
CREATE TABLE IF NOT EXISTS public.pedidos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id UUID REFERENCES public.profiles(id),
  nome_cliente TEXT NOT NULL,
  email_cliente TEXT NOT NULL,
  telefone_cliente TEXT,
  data_pedido DATE NOT NULL DEFAULT CURRENT_DATE,
  data_entrega DATE NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  pagamento TEXT CHECK (pagamento IN ('pix', 'cartao')) NOT NULL,
  status TEXT CHECK (status IN ('Pendente', 'Confirmado', 'Em Preparo', 'Pronto', 'Entregue', 'Cancelado')) DEFAULT 'Pendente',
  itens TEXT NOT NULL,
  itens_json JSONB,
  endereco_entrega TEXT NOT NULL,
  mercado_pago_status TEXT,
  mercado_pago_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS telefone_cliente TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS itens_json JSONB;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_status TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2.4 Movimentações de Estoque
CREATE TABLE IF NOT EXISTS public.estoque_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE CASCADE,
  produto_nome TEXT NOT NULL,
  tipo TEXT CHECK (tipo IN ('entrada', 'saida', 'venda', 'ajuste', 'perda')) NOT NULL,
  quantidade INTEGER NOT NULL,
  saldo_resultante INTEGER NOT NULL,
  motivo TEXT,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2.5 Lançamentos Financeiros (Fluxo de Caixa)
CREATE TABLE IF NOT EXISTS public.financeiro_lancamentos (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT CHECK (tipo IN ('receita', 'despesa')) NOT NULL,
  categoria TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor DECIMAL(10,2) NOT NULL,
  data_lancamento DATE DEFAULT CURRENT_DATE,
  forma_pagamento TEXT CHECK (forma_pagamento IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'boleto', 'outro')) DEFAULT 'pix',
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  comprovante_url TEXT,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================================================
-- 3. ÍNDICES DE PERFORMANCE
-- ==========================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_ativo ON public.profiles(ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo ON public.produtos(ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_estoque ON public.produtos(estoque_qtd);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON public.pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON public.pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_data_pedido ON public.pedidos(data_pedido);
CREATE INDEX IF NOT EXISTS idx_pedidos_itens_json ON public.pedidos USING gin(itens_json);
CREATE INDEX IF NOT EXISTS idx_estoque_mov_prod ON public.estoque_movimentacoes(produto_id);
CREATE INDEX IF NOT EXISTS idx_financeiro_data ON public.financeiro_lancamentos(data_lancamento);
CREATE INDEX IF NOT EXISTS idx_financeiro_tipo ON public.financeiro_lancamentos(tipo);

-- ==========================================================================
-- 4. FUNÇÕES DE AUTORIZAÇÃO E SEGURANÇA (SECURITY DEFINER + search_path)
-- ==========================================================================

-- Verifica se o usuário atual é admin ativo
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

-- Verifica se o usuário atual é operador ou admin ativo
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

-- Verifica se o usuário autenticado está com a conta ativa
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

-- Criação automática e segura de perfil para novos usuários (impossibilita autoelevação a admin)
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
    'cliente',  -- Forçado estritamente no banco como cliente
    true,       -- Ativo por padrão
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Proteção: Impede que o próprio cliente altere seu nivel ou status ativo
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

-- ==========================================================================
-- 5. ANTI-FRAUDE: RECÁLCULO ATÔMICO DO TOTAL DO PEDIDO
-- Garante que o banco de dados NUNCA aceite um total adulterado pelo cliente
-- ==========================================================================
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
  -- Se houver array de itens JSON estruturado, recalcula o total rigorosamente do banco
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

    -- Se calculou com sucesso, sobrescreve obrigatoriamente o total enviado pelo cliente
    IF v_possui_itens_validos AND v_total_calculado > 0 THEN
      NEW.total := v_total_calculado;
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trigger_validar_recalcular_total_pedido ON public.pedidos;
CREATE TRIGGER trigger_validar_recalcular_total_pedido
BEFORE INSERT OR UPDATE ON public.pedidos
FOR EACH ROW EXECUTE FUNCTION public.validar_recalcular_total_pedido();

-- ==========================================================================
-- 6. RPC: CRIAR PEDIDO SEGURO (Transação Atômica Server-Side)
-- O cliente envia os itens e dados, o servidor valida produtos, estoque e calcula o preço
-- ==========================================================================

-- Limpeza preventiva de quaisquer assinaturas anteriores para evitar erro 42725
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT p.oid::regprocedure AS func_signature
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname IN ('criar_pedido', 'confirmar_pagamento_pedido')
  ) LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.func_signature || ' CASCADE;';
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.criar_pedido(
  p_itens JSONB,
  p_data_entrega DATE,
  p_pagamento TEXT,
  p_endereco_entrega TEXT,
  p_telefone_cliente TEXT,
  p_nome_cliente TEXT
)
RETURNS JSON AS $$
DECLARE
  v_cliente_id UUID := auth.uid();
  v_user_profile RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_total DECIMAL(10,2) := 0;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_pedido_id BIGINT;
BEGIN
  -- 1. Valida autenticação do cliente
  IF v_cliente_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Você precisa estar logado para realizar um pedido.');
  END IF;

  SELECT * INTO v_user_profile
  FROM public.profiles
  WHERE id = v_cliente_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Sua conta de usuário está inativa ou não foi encontrada.');
  END IF;

  -- 2. Validações de entrada
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'O carrinho de compras está vazio.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  IF p_pagamento NOT IN ('pix', 'cartao') THEN
    RETURN json_build_object('success', false, 'error', 'Forma de pagamento inválida.');
  END IF;

  -- 3. Itera sobre os itens, buscando preços oficiais e validando estoque disponível
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

    IF v_prod_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Item do carrinho inválido.');
    END IF;

    SELECT id, nome, preco, ativo, estoque_qtd, controlar_estoque
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Produto indisponível ou desativado: ' || COALESCE(v_item->>'nome', 'Desconhecido'));
    END IF;

    -- Checa disponibilidade de estoque no momento da intenção de compra
    IF v_prod.controlar_estoque = true AND v_prod.estoque_qtd < v_qtd THEN
      RETURN json_build_object('success', false, 'error', 'Estoque insuficiente para o doce: ' || v_prod.nome || '. Restam apenas ' || v_prod.estoque_qtd || ' unidades.');
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 4. Grava o pedido com status 'Pendente' e o total REAL calculado pelo servidor
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    total,
    pagamento,
    status,
    itens,
    itens_json,
    endereco_entrega
  ) VALUES (
    v_cliente_id,
    COALESCE(NULLIF(trim(p_nome_cliente), ''), v_user_profile.nome),
    v_user_profile.email,
    COALESCE(NULLIF(trim(p_telefone_cliente), ''), v_user_profile.telefone),
    CURRENT_DATE,
    p_data_entrega,
    v_total,
    p_pagamento,
    'Pendente',
    array_to_string(v_nomes_itens, ' + '),
    p_itens,
    p_endereco_entrega
  ) RETURNING id INTO v_pedido_id;

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ==========================================================================
-- 7. TABELA DE IDEMPOTÊNCIA E TRANSAÇÃO ATÔMICA DE CONFIRMAÇÃO DE PAGAMENTO
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.pagamentos_processados (
  provider_id TEXT PRIMARY KEY,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  provider TEXT DEFAULT 'mercadopago',
  forma TEXT,
  valor DECIMAL(10,2),
  processado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_proc_pedido ON public.pagamentos_processados(pedido_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_mercado_pago_id_unique 
  ON public.pedidos(mercado_pago_id) 
  WHERE mercado_pago_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.confirmar_pagamento_pedido(
  p_pedido_id BIGINT,
  p_mercado_pago_payment_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'approved',
  p_forma_pagamento TEXT DEFAULT NULL,
  p_valor NUMERIC DEFAULT NULL,
  p_origem TEXT DEFAULT 'webhook'
)
RETURNS JSON AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_novo_saldo INTEGER;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- 7.1. Idempotência por Provider ID
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.pagamentos_processados
      WHERE provider_id = p_mercado_pago_payment_id
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente (idempotência confirmada).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 7.2. Busca o pedido com bloqueio pessimista por linha (SELECT FOR UPDATE)
  SELECT * INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- 7.3. Se já estiver confirmado ou em estágios posteriores, não duplica a baixa
  IF v_pedido.status IN ('Confirmado', 'Em Preparo', 'Pronto', 'Entregue') THEN
    IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
      INSERT INTO public.pagamentos_processados (provider_id, pedido_id, forma, valor)
      VALUES (p_mercado_pago_payment_id, p_pedido_id, COALESCE(p_forma_pagamento, v_pedido.pagamento), COALESCE(p_valor, v_pedido.total))
      ON CONFLICT (provider_id) DO NOTHING;
    END IF;

    RETURN json_build_object(
      'success', true,
      'message', 'Pedido já estava confirmado anteriormente',
      'pedido_id', p_pedido_id,
      'status', v_pedido.status
    );
  END IF;

  -- 7.4. Atualiza status do pedido para Confirmado
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 7.5. Executa a baixa de estoque dos itens com FOR UPDATE por produto
  IF v_pedido.itens_json IS NOT NULL AND jsonb_typeof(v_pedido.itens_json) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
    LOOP
      v_prod_id := (v_item->>'id')::BIGINT;
      v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

      IF v_prod_id IS NOT NULL THEN
        SELECT id, nome, estoque_qtd, controlar_estoque
        INTO v_prod
        FROM public.produtos
        WHERE id = v_prod_id
        FOR UPDATE;

        IF FOUND AND (v_prod.controlar_estoque IS NOT FALSE) THEN
          v_novo_saldo := GREATEST(0, COALESCE(v_prod.estoque_qtd, 0) - v_qtd);

          UPDATE public.produtos
          SET estoque_qtd = v_novo_saldo, updated_at = NOW()
          WHERE id = v_prod_id;

          INSERT INTO public.estoque_movimentacoes (
            produto_id,
            produto_nome,
            tipo,
            quantidade,
            saldo_resultante,
            motivo,
            pedido_id,
            usuario_nome
          ) VALUES (
            v_prod.id,
            v_prod.nome,
            'venda',
            v_qtd,
            v_novo_saldo,
            'Venda confirmada no Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 7.6. Registra receita no financeiro com proteção estrita contra duplicidade
  IF NOT EXISTS (
    SELECT 1 FROM public.financeiro_lancamentos 
    WHERE pedido_id = p_pedido_id AND tipo = 'receita'
  ) THEN
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      observacoes
    ) VALUES (
      'receita',
      'Vendas',
      'Venda do Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
      v_pedido.total,
      CURRENT_DATE,
      COALESCE(p_forma_pagamento, v_pedido.pagamento, 'pix'),
      p_pedido_id,
      'Confirmação via ' || COALESCE(p_origem, 'Mercado Pago') ||
        CASE 
          WHEN p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' 
          THEN ' [ID: ' || p_mercado_pago_payment_id || ']' 
          ELSE '' 
        END
    );
  END IF;

  -- 7.7. Grava registro na tabela de pagamentos processados (idempotência)
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    INSERT INTO public.pagamentos_processados (
      provider_id,
      pedido_id,
      forma,
      valor
    ) VALUES (
      p_mercado_pago_payment_id,
      p_pedido_id,
      COALESCE(p_forma_pagamento, v_pedido.pagamento),
      COALESCE(p_valor, v_pedido.total)
    )
    ON CONFLICT (provider_id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status', 'Confirmado'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ==========================================================================
-- 8. FECHAMENTO DE RPCs DE ESTOQUE VULNERÁVEIS
-- Revoga acesso público e autenticado: apenas service_role pode executar
-- ==========================================================================
REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- Reforço nas funções legadas para impedir uso indevido
CREATE OR REPLACE FUNCTION public.baixar_estoque_pedido_batch(
  p_pedido_id BIGINT,
  p_itens JSONB
)
RETURNS JSON AS $$
BEGIN
  IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION 'Acesso negado: apenas administradores ou automações do sistema podem alterar estoque.';
  END IF;

  -- Redireciona para o fluxo oficial de confirmação
  RETURN public.confirmar_pagamento_pedido(p_pedido_id, NULL, 'approved', NULL, NULL, 'Admin Manual');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.baixar_estoque_pedido_batch(BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baixar_estoque_pedido_batch(BIGINT, JSONB) TO service_role;

-- ==========================================================================
-- 9. POLÍTICAS DE ROW LEVEL SECURITY (RLS) RIGOROSAS
-- ==========================================================================

-- Habilitar RLS em todas as tabelas
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financeiro_lancamentos ENABLE ROW LEVEL SECURITY;

-- 9.1 Profiles
DROP POLICY IF EXISTS "Usuários podem ver seu próprio perfil" ON public.profiles;
DROP POLICY IF EXISTS "Admins podem ver todos os perfis" ON public.profiles;
DROP POLICY IF EXISTS "Usuários podem atualizar seu próprio perfil" ON public.profiles;
DROP POLICY IF EXISTS "Admins podem atualizar todos os perfis" ON public.profiles;
DROP POLICY IF EXISTS "Perfis são visíveis conforme status" ON public.profiles;

CREATE POLICY "Usuário vê seu perfil se ativo ou admin vê todos" 
  ON public.profiles FOR SELECT 
  USING (
    (auth.uid() = id AND ativo = true) 
    OR public.is_admin()
  );

CREATE POLICY "Usuário atualiza dados se ativo ou admin altera" 
  ON public.profiles FOR UPDATE 
  USING (
    (auth.uid() = id AND ativo = true) 
    OR public.is_admin()
  );

-- Remoção estrita de política pública de INSERT:
-- Perfis são gerados pelo trigger handle_new_user; apenas admins podem inserir manualmente
DROP POLICY IF EXISTS "Criação de perfil no cadastro inicial" ON public.profiles;
DROP POLICY IF EXISTS "Apenas admins inserem perfis manualmente" ON public.profiles;

CREATE POLICY "Apenas admins inserem perfis manualmente" 
  ON public.profiles FOR INSERT 
  WITH CHECK (public.is_admin());

-- 9.2 Produtos
DROP POLICY IF EXISTS "Produtos são visíveis publicamente" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins podem inserir produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins podem atualizar produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins podem deletar produtos" ON public.produtos;
DROP POLICY IF EXISTS "Operadores e admins gerenciam produtos" ON public.produtos;

CREATE POLICY "Visualização de produtos ativos ou por equipe" 
  ON public.produtos FOR SELECT 
  USING (ativo = true OR public.is_admin_or_operator());

CREATE POLICY "Operadores e admins inserem produtos" 
  ON public.produtos FOR INSERT 
  WITH CHECK (public.is_admin_or_operator());

CREATE POLICY "Operadores e admins atualizam produtos" 
  ON public.produtos FOR UPDATE 
  USING (public.is_admin_or_operator());

CREATE POLICY "Apenas admins deletam produtos" 
  ON public.produtos FOR DELETE 
  USING (public.is_admin());

-- 9.3 Pedidos
DROP POLICY IF EXISTS "Usuários podem ver seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Admins podem ver todos os pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Usuários podem criar seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Admins podem atualizar pedidos" ON public.pedidos;

CREATE POLICY "Clientes ativos veem seus pedidos ou admins veem todos" 
  ON public.pedidos FOR SELECT 
  USING (
    (auth.uid() = cliente_id AND public.is_user_active()) 
    OR public.is_admin_or_operator()
  );

CREATE POLICY "Clientes ativos criam seus próprios pedidos" 
  ON public.pedidos FOR INSERT 
  WITH CHECK (
    auth.uid() = cliente_id 
    AND public.is_user_active()
  );

CREATE POLICY "Apenas administradores ou operadores atualizam pedidos" 
  ON public.pedidos FOR UPDATE 
  USING (public.is_admin_or_operator());

-- 9.4 Estoque e Financeiro
DROP POLICY IF EXISTS "Admins e operadores visualizam estoque" ON public.estoque_movimentacoes;
CREATE POLICY "Admins e operadores visualizam estoque" 
  ON public.estoque_movimentacoes FOR SELECT 
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Apenas admins gerenciam financeiro" ON public.financeiro_lancamentos;
CREATE POLICY "Apenas admins gerenciam financeiro" 
  ON public.financeiro_lancamentos FOR ALL 
  USING (public.is_admin());

-- ==========================================================================
-- FIM DO SCRIPT DE INSTALAÇÃO & SEGURANÇA
-- ==========================================================================
