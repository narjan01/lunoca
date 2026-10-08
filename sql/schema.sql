-- ==========================================================================
-- LUNOCA DOCERIA - ESQUEMA CONSOLIDADO & SEGURO (v3.0.0)
-- Para instalação completa e idempotente, veja também: sql/install.sql
-- ==========================================================================

-- Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Profiles (Usuários)
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

-- 2. Produtos
CREATE TABLE IF NOT EXISTS public.produtos (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  preco DECIMAL(10,2) NOT NULL,
  descricao TEXT,
  opcoes TEXT,
  img_url TEXT,
  ativo BOOLEAN DEFAULT true,
  estoque_qtd INTEGER DEFAULT 0,
  estoque_fisico INTEGER DEFAULT 0,
  estoque_reservado INTEGER DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 5,
  controlar_estoque BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger para manter estoque_qtd sempre sincronizado como (estoque_fisico - estoque_reservado)
CREATE OR REPLACE FUNCTION public.sincronizar_estoque_produto()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.estoque_qtd IS DISTINCT FROM OLD.estoque_qtd AND NEW.estoque_fisico = OLD.estoque_fisico THEN
    NEW.estoque_fisico := GREATEST(0, NEW.estoque_qtd + COALESCE(NEW.estoque_reservado, 0));
  END IF;

  NEW.estoque_reservado := GREATEST(0, COALESCE(NEW.estoque_reservado, 0));
  NEW.estoque_fisico := GREATEST(0, COALESCE(NEW.estoque_fisico, 0));
  NEW.estoque_qtd := GREATEST(0, NEW.estoque_fisico - NEW.estoque_reservado);
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trigger_sincronizar_estoque_produto ON public.produtos;
CREATE TRIGGER trigger_sincronizar_estoque_produto
BEFORE INSERT OR UPDATE ON public.produtos
FOR EACH ROW EXECUTE FUNCTION public.sincronizar_estoque_produto();

-- 3. Pedidos
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
  status_pagamento TEXT DEFAULT 'aguardando_pagamento',
  status_producao TEXT DEFAULT 'recebido',
  expires_at TIMESTAMPTZ,
  itens TEXT NOT NULL,
  itens_json JSONB,
  endereco_entrega TEXT NOT NULL,
  mercado_pago_status TEXT,
  mercado_pago_id TEXT,
  whatsapp_notificado BOOLEAN DEFAULT false,
  ultimo_status_whatsapp TEXT,
  taxa_entrega DECIMAL(10,2) DEFAULT 0,
  modalidade_entrega TEXT DEFAULT 'entrega',
  checkout_token UUID DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_checkout_token ON public.pedidos(checkout_token);

-- 3.1. Tabela Canônica de Itens do Pedido (Audit 5)
CREATE TABLE IF NOT EXISTS public.pedido_itens (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE SET NULL,
  produto_nome_snapshot TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario_snapshot NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON public.pedido_itens(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto_id ON public.pedido_itens(produto_id);

-- 4. Movimentações de Estoque
CREATE TABLE IF NOT EXISTS public.estoque_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE CASCADE,
  produto_nome TEXT NOT NULL,
  tipo TEXT CHECK (tipo IN ('entrada', 'saida', 'venda', 'ajuste', 'perda', 'reserva')) NOT NULL,
  quantidade INTEGER NOT NULL,
  saldo_resultante INTEGER NOT NULL,
  motivo TEXT,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Lançamentos Financeiros
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

-- 6. Funções de Autorização & Proteção de Profiles
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND nivel = 'admin' AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_admin_or_operator()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND nivel IN ('admin', 'operador') AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.is_user_active()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND ativo = true
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

-- 7. Trigger Anti-Fraude de Total
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
        SELECT preco INTO v_prod_preco FROM public.produtos WHERE id = v_prod_id;
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

DROP TRIGGER IF EXISTS trigger_validar_recalcular_total_pedido ON public.pedidos;
CREATE TRIGGER trigger_validar_recalcular_total_pedido
BEFORE INSERT OR UPDATE ON public.pedidos
FOR EACH ROW EXECUTE FUNCTION public.validar_recalcular_total_pedido();

-- 8. RPC: Criar Pedido Server-Side
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT p.oid::regprocedure AS func_signature
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname IN ('criar_pedido', 'confirmar_pagamento_pedido', 'liberar_pedidos_expirados')
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
  p_nome_cliente TEXT,
  p_taxa_entrega NUMERIC DEFAULT 0,
  p_email_cliente TEXT DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'entrega'
)
RETURNS JSON AS $$
DECLARE
  v_cliente_id UUID := auth.uid();
  v_user_profile RECORD;
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_disponivel INTEGER;
  v_total DECIMAL(10,2) := 0;
  v_taxa DECIMAL(10,2) := 0;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_itens_json_canonical JSONB := '[]'::JSONB;
  v_pedido_id BIGINT;
  v_checkout_token UUID;
  v_expires_at TIMESTAMPTZ;
  v_nome_final TEXT;
  v_email_final TEXT;
  v_telefone_final TEXT;
  v_fone_limpo TEXT;
  v_fone_normalizado TEXT;
BEGIN
  -- 1. Identificação do Cliente (Usuário Autenticado ou Visitante Convidado)
  IF v_cliente_id IS NOT NULL THEN
    SELECT * INTO v_user_profile
    FROM public.profiles
    WHERE id = v_cliente_id AND ativo = true;

    IF NOT FOUND THEN
      RETURN json_build_object('success', false, 'error', 'Sua conta de usuário está inativa ou não foi encontrada.');
    END IF;

    v_nome_final := COALESCE(NULLIF(trim(p_nome_cliente), ''), v_user_profile.nome);
    v_email_final := COALESCE(v_user_profile.email, NULLIF(trim(p_email_cliente), ''), 'cliente@lunocadoceria.com.br');
    v_telefone_final := COALESCE(NULLIF(trim(p_telefone_cliente), ''), v_user_profile.telefone);
  ELSE
    -- Guest Checkout (compra como visitante sem necessidade de senha prévia)
    v_nome_final := trim(COALESCE(p_nome_cliente, ''));
    v_telefone_final := trim(COALESCE(p_telefone_cliente, ''));
    v_email_final := COALESCE(NULLIF(trim(p_email_cliente), ''), 'visitante@lunocadoceria.com.br');

    IF length(v_nome_final) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe seu nome completo para a encomenda.');
    END IF;

    v_fone_limpo := regexp_replace(v_telefone_final, '\D', '', 'g');
    IF length(v_fone_limpo) < 10 THEN
      RETURN json_build_object('success', false, 'error', 'Por favor, informe um WhatsApp válido com DDD para acompanhar o pedido.');
    END IF;

    IF length(v_fone_limpo) IN (10, 11) THEN
      v_fone_normalizado := '55' || v_fone_limpo;
    ELSE
      v_fone_normalizado := v_fone_limpo;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('guest_checkout_' || v_fone_normalizado));

    -- Rate limit estrito de no máximo 3 pedidos pendentes recentes nos últimos 15 min
    IF (
      SELECT COUNT(*)
      FROM public.pedidos
      WHERE (
        regexp_replace(COALESCE(telefone_cliente, ''), '\D', '', 'g') IN (v_fone_limpo, v_fone_normalizado)
        OR (
          p_endereco_entrega IS NOT NULL 
          AND p_endereco_entrega <> '' 
          AND lower(p_endereco_entrega) NOT LIKE '%retirada%'
          AND endereco_entrega = p_endereco_entrega
        )
      )
        AND status = 'Pendente'
        AND created_at >= (NOW() - INTERVAL '15 minutes')
    ) >= 3 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Limite de pedidos pendentes atingido para este telefone/endereço (máx. 3 nos últimos 15 min). Aguarde alguns minutos.'
      );
    END IF;
  END IF;

  -- 2. Validações de entrada
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Sua sacola está vazia.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  IF p_pagamento NOT IN ('pix', 'cartao') THEN
    RETURN json_build_object('success', false, 'error', 'Forma de pagamento inválida.');
  END IF;

  -- 3. Tolerância de pagamento de 30 minutos
  v_expires_at := NOW() + INTERVAL '30 minutes';

  -- 4. ETAPA 1: Agrupamento consolidado dos itens, validação de disponibilidade e cálculo de totais
  -- O agrupamento por produto_id impede que itens duplicados contornem o estoque ou o limite anti-hoarding
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      SUM(GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)))::INTEGER AS quantidade
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    GROUP BY (it->>'id')::BIGINT
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    -- Anti-Hoarding para Visitante sobre a quantidade agregada do item
    IF v_cliente_id IS NULL AND v_qtd > 50 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Quantidade máxima por item para checkout rápido sem cadastro é de 50 unidades. Para encomendas maiores, acesse sua conta ou entre em contato.'
      );
    END IF;

    -- Bloqueio pessimista por linha do produto
    SELECT id, nome, preco, ativo, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id
    FOR UPDATE;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Um dos produtos selecionados não está mais disponível.');
    END IF;

    -- Verifica disponibilidade real sobre o total consolidado (Físico - Reservado)
    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      IF v_disponivel < v_qtd THEN
        RETURN json_build_object(
          'success', false,
          'error', 'Estoque esgotado ou insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;
    END IF;

    v_total := v_total + (v_prod.preco * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);

    -- Constrói o item JSON saneado utilizando o preço oficial do banco de dados
    v_itens_json_canonical := v_itens_json_canonical || jsonb_build_object(
      'id', v_prod.id,
      'nome', v_prod.nome,
      'quantidade', v_qtd,
      'preco', v_prod.preco,
      'preco_unitario', v_prod.preco,
      'subtotal', (v_prod.preco * v_qtd)
    );
  END LOOP;

  -- 5. Validação e cálculo estrito da taxa de entrega no servidor
  IF LOWER(COALESCE(p_modalidade, 'entrega')) = 'retirada' THEN
    v_taxa := 0.00;
  ELSE
    v_taxa := 10.00;
  END IF;

  v_total := v_total + v_taxa;

  -- 6. ETAPA 2: Gravação do Pedido primeiro
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    total,
    taxa_entrega,
    modalidade_entrega,
    pagamento,
    status,
    status_pagamento,
    status_producao,
    expires_at,
    itens,
    itens_json,
    endereco_entrega
  ) VALUES (
    v_cliente_id,
    v_nome_final,
    v_email_final,
    v_telefone_final,
    CURRENT_DATE,
    p_data_entrega,
    v_total,
    v_taxa,
    COALESCE(p_modalidade, 'entrega'),
    p_pagamento,
    'Pendente',
    'aguardando_pagamento',
    'recebido',
    v_expires_at,
    array_to_string(v_nomes_itens, ' + '),
    v_itens_json_canonical,
    p_endereco_entrega
  ) RETURNING id, checkout_token INTO v_pedido_id, v_checkout_token;

  -- 7. ETAPA 3: Gravação na tabela canônica pedido_itens e Reserva atômica do estoque
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      SUM(GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)))::INTEGER AS quantidade
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    GROUP BY (it->>'id')::BIGINT
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    -- Inserção canônica de itens
    INSERT INTO public.pedido_itens (
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      preco_unitario_snapshot,
      subtotal
    ) VALUES (
      v_pedido_id,
      v_prod.id,
      v_prod.nome,
      v_qtd,
      v_prod.preco,
      (v_prod.preco * v_qtd)
    );

    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));

      UPDATE public.produtos
      SET 
        estoque_reservado = estoque_reservado + v_qtd,
        updated_at = NOW()
      WHERE id = v_prod_id;

      INSERT INTO public.estoque_movimentacoes (
        produto_id,
        produto_nome,
        tipo,
        quantidade,
        saldo_resultante,
        pedido_id,
        motivo,
        usuario_nome
      ) VALUES (
        v_prod.id,
        v_prod.nome,
        'reserva',
        v_qtd,
        v_disponivel - v_qtd,
        v_pedido_id,
        'Reserva temporária para novo pedido #' || v_pedido_id || ' (tolerância 30 min)',
        'Sistema / Reserva'
      );
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'total', v_total,
    'taxa_entrega', v_taxa,
    'checkout_token', v_checkout_token,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;

-- 9. Tabela de Idempotência & RPC Atômica de Confirmação & Baixa de Estoque
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

DROP FUNCTION IF EXISTS public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT);

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
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido não informado.');
  END IF;

  -- Validação estrita de status: somente pagamentos aprovados podem confirmar pedidos
  IF COALESCE(p_mercado_pago_payment_id, '') <> 'admin_manual'
     AND LOWER(COALESCE(p_status, '')) <> 'approved'
  THEN
    RETURN json_build_object('success', false, 'error', 'Somente pagamentos aprovados podem confirmar pedidos.');
  END IF;

  -- 9.1. Idempotência por Provider ID
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

  -- 9.2. Bloqueio pessimista por linha (SELECT FOR UPDATE)
  SELECT * INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
  END IF;

  -- Validação de integridade financeira do valor pago vs total do pedido
  IF p_valor IS NOT NULL AND ABS(p_valor - v_pedido.total) > 0.01 THEN
    RETURN json_build_object('success', false, 'error', 'Valor do pagamento (R$ ' || p_valor || ') diverge do total do pedido (R$ ' || v_pedido.total || ').');
  END IF;

  -- 9.3. Se já confirmado anteriormente, impede duplo processamento
  IF v_pedido.status IN ('Confirmado', 'Em Preparo', 'Pronto', 'Entregue') OR v_pedido.status_pagamento = 'pago' THEN
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

  -- 9.4. Atualiza status do pedido para Confirmado / Pago
  UPDATE public.pedidos
  SET 
    status = 'Confirmado',
    status_pagamento = 'pago',
    status_producao = CASE WHEN status_producao IS NULL OR status_producao = 'cancelado' THEN 'recebido' ELSE status_producao END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 9.5. Baixa física e liberação da reserva no estoque (SELECT FOR UPDATE)
  IF v_pedido.itens_json IS NOT NULL AND jsonb_typeof(v_pedido.itens_json) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
    LOOP
      v_prod_id := (v_item->>'id')::BIGINT;
      v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

      IF v_prod_id IS NOT NULL THEN
        SELECT id, nome, estoque_fisico, estoque_reservado, controlar_estoque
        INTO v_prod
        FROM public.produtos
        WHERE id = v_prod_id
        FOR UPDATE;

        IF FOUND AND (v_prod.controlar_estoque IS NOT FALSE) THEN
          -- Converte a reserva em baixa física real
          UPDATE public.produtos
          SET 
            estoque_reservado = GREATEST(0, estoque_reservado - v_qtd),
            estoque_fisico = GREATEST(0, estoque_fisico - v_qtd),
            updated_at = NOW()
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
            GREATEST(0, v_prod.estoque_fisico - v_qtd),
            'Venda confirmada no Pedido #' || p_pedido_id,
            p_pedido_id,
            COALESCE(p_origem, 'Sistema / Mercado Pago')
          );
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 9.5.1. Baixa atômica de insumos da receita (Ficha Técnica)
  PERFORM public.dar_baixa_ingredientes_pedido(p_pedido_id);

  -- 9.6. Registra receita no financeiro com proteção estrita contra duplicidade
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

  -- 9.7. Grava registro na tabela de pagamentos processados (idempotência)
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

  RETURN json_build_object('success', true, 'pedido_id', p_pedido_id, 'status', 'Confirmado');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- 9.8. RPC: LIBERAÇÃO DE ESTOQUE DE PEDIDOS EXPIRADOS (CLEANUP AUTOMÁTICO)
CREATE OR REPLACE FUNCTION public.liberar_pedidos_expirados()
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_saldo INTEGER;
  v_total_cancelados INTEGER := 0;
BEGIN
  FOR v_ped IN (
    SELECT * FROM public.pedidos
    WHERE status = 'Pendente'
      AND status_pagamento = 'aguardando_pagamento'
      AND (
        expires_at < NOW()
        OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '30 minutes')
      )
    FOR UPDATE SKIP LOCKED
  ) LOOP
    UPDATE public.pedidos
    SET 
      status = 'Cancelado',
      status_pagamento = 'expirado',
      status_producao = 'cancelado',
      updated_at = NOW()
    WHERE id = v_ped.id;

    IF v_ped.itens_json IS NOT NULL AND jsonb_typeof(v_ped.itens_json) = 'array' THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_ped.itens_json)
      LOOP
        v_prod_id := (v_item->>'id')::BIGINT;
        v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));

        IF v_prod_id IS NOT NULL THEN
          UPDATE public.produtos
          SET 
            estoque_reservado = GREATEST(0, estoque_reservado - v_qtd),
            updated_at = NOW()
          WHERE id = v_prod_id
          RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_saldo;

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
            v_prod_id,
            COALESCE(v_item->>'nome', 'Produto'),
            'ajuste',
            v_qtd,
            COALESCE(v_saldo, 0),
            'Devolução de reserva por expiração de PIX do Pedido #' || v_ped.id,
            v_ped.id,
            'Sistema / Expiração Automática'
          );
        END IF;
      END LOOP;
    END IF;

    v_total_cancelados := v_total_cancelados + 1;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'pedidos_cancelados', v_total_cancelados,
    'executado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.liberar_pedidos_expirados() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.liberar_pedidos_expirados() TO service_role;

-- 10. Políticas RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financeiro_lancamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Perfis visíveis por titular ativo ou admin" ON public.profiles FOR SELECT USING ((auth.uid() = id AND ativo = true) OR public.is_admin());
CREATE POLICY "Perfis editáveis por titular ativo ou admin" ON public.profiles FOR UPDATE USING ((auth.uid() = id AND ativo = true) OR public.is_admin());

-- Apenas administradores inserem perfis manualmente (o cadastro comum ocorre via trigger handle_new_user)
DROP POLICY IF EXISTS "Apenas admins inserem perfis manualmente" ON public.profiles;
CREATE POLICY "Apenas admins inserem perfis manualmente" ON public.profiles FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "Produtos visíveis publicamente se ativos" ON public.produtos FOR SELECT USING (ativo = true OR public.is_admin_or_operator());
CREATE POLICY "Equipe gerencia produtos" ON public.produtos FOR ALL USING (public.is_admin_or_operator());
CREATE POLICY "Pedidos visíveis por clientes ativos ou equipe" ON public.pedidos FOR SELECT USING ((auth.uid() = cliente_id AND public.is_user_active()) OR public.is_admin_or_operator());

-- Erradicação de criação e mutação direta de pedidos no cliente (Audit 5)
DROP POLICY IF EXISTS "Clientes ativos criam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Clientes ativos criam seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Usuários podem criar seus próprios pedidos" ON public.pedidos;
REVOKE INSERT, UPDATE ON public.pedidos FROM PUBLIC, anon, authenticated;

-- Políticas RLS para pedido_itens
ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_itens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_itens TO service_role;

DROP POLICY IF EXISTS "Clientes visualizam itens de seus pedidos" ON public.pedido_itens;
CREATE POLICY "Clientes visualizam itens de seus pedidos" ON public.pedido_itens
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_itens.pedido_id
        AND ((p.cliente_id = auth.uid() AND public.is_user_active()) OR public.is_admin_or_operator())
    )
  );

-- RPC Segura para Transições Operacionais de Pedidos por Operadores/Admins
CREATE OR REPLACE FUNCTION public.alterar_status_operacional_pedido(
  p_pedido_id BIGINT,
  p_novo_status TEXT
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_permitido BOOLEAN := false;
  v_status_prod TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  SELECT * INTO v_ped
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- Matriz restrita de transições operacionais
  IF v_ped.status = 'Confirmado' AND p_novo_status IN ('Em Preparo', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Em Preparo' AND p_novo_status IN ('Pronto', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Pronto' AND p_novo_status IN ('Entregue', 'Cancelado') THEN
    v_status_permitido := true;
  ELSIF v_ped.status = 'Pendente' AND p_novo_status = 'Cancelado' THEN
    v_status_permitido := true;
  ELSIF v_ped.status = p_novo_status THEN
    RETURN json_build_object('success', true, 'message', 'Pedido já está no status solicitado.', 'status', v_ped.status);
  END IF;

  IF NOT v_status_permitido THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Transição operacional não permitida de "' || v_ped.status || '" para "' || p_novo_status || '".'
    );
  END IF;

  v_status_prod := CASE 
    WHEN p_novo_status = 'Confirmado' THEN 'recebido'
    WHEN p_novo_status = 'Em Preparo' THEN 'em_preparo'
    WHEN p_novo_status = 'Pronto' THEN 'pronto'
    WHEN p_novo_status = 'Entregue' THEN 'entregue'
    WHEN p_novo_status = 'Cancelado' THEN 'cancelado'
    ELSE v_ped.status_producao
  END;

  UPDATE public.pedidos
  SET 
    status = p_novo_status,
    status_producao = v_status_prod,
    updated_at = NOW()
  WHERE id = p_pedido_id;

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_anterior', v_ped.status,
    'status_novo', p_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) TO authenticated, service_role;

-- Lockdown estrito de pagamentos_processados
ALTER TABLE public.pagamentos_processados ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pagamentos_processados FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pagamentos_processados TO service_role;

CREATE POLICY "Equipe visualiza estoque" ON public.estoque_movimentacoes FOR SELECT USING (public.is_admin_or_operator());
CREATE POLICY "Admins gerenciam financeiro" ON public.financeiro_lancamentos FOR ALL USING (public.is_admin());

-- 11. Ficha Técnica, Insumos e CMV (Fase 6)
CREATE TABLE IF NOT EXISTS public.ingredientes (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  unidade VARCHAR(10) NOT NULL DEFAULT 'g' CHECK (unidade IN ('g', 'kg', 'ml', 'l', 'un')),
  custo_unitario NUMERIC(10,4) NOT NULL DEFAULT 0.0000,
  estoque_qtd NUMERIC(10,3) NOT NULL DEFAULT 0.000,
  estoque_minimo NUMERIC(10,3) NOT NULL DEFAULT 0.000,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.produto_ingredientes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  ingrediente_id BIGINT NOT NULL REFERENCES public.ingredientes(id) ON DELETE CASCADE,
  quantidade NUMERIC(10,3) NOT NULL CHECK (quantidade > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_produto_ingrediente UNIQUE (produto_id, ingrediente_id)
);

CREATE INDEX IF NOT EXISTS idx_produto_ingredientes_prod ON public.produto_ingredientes(produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_ingredientes_ing ON public.produto_ingredientes(ingrediente_id);

CREATE OR REPLACE VIEW public.view_produto_cmv AS
SELECT 
  p.id AS produto_id,
  p.nome AS produto_nome,
  p.preco AS preco_venda,
  p.ativo,
  COALESCE(SUM(pi.quantidade * i.custo_unitario), 0)::NUMERIC(10,2) AS cmv_estimado,
  CASE 
    WHEN p.preco > 0 THEN 
      ROUND(((p.preco - COALESCE(SUM(pi.quantidade * i.custo_unitario), 0)) / p.preco * 100), 2)
    ELSE 0 
  END AS margem_bruta_pct,
  CASE 
    WHEN p.preco > 0 THEN 
      (p.preco - COALESCE(SUM(pi.quantidade * i.custo_unitario), 0))::NUMERIC(10,2)
    ELSE 0 
  END AS lucro_bruto_unitario,
  COUNT(pi.id) AS total_ingredientes
FROM public.produtos p
LEFT JOIN public.produto_ingredientes pi ON pi.produto_id = p.id
LEFT JOIN public.ingredientes i ON i.id = pi.ingrediente_id AND i.ativo = true
GROUP BY p.id, p.nome, p.preco, p.ativo;

CREATE OR REPLACE FUNCTION public.dar_baixa_ingredientes_pedido(p_pedido_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_pedido RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd_prod NUMERIC;
  v_ficha RECORD;
BEGIN
  SELECT itens_json INTO v_pedido FROM public.pedidos WHERE id = p_pedido_id;
  IF NOT FOUND OR v_pedido.itens_json IS NULL OR jsonb_typeof(v_pedido.itens_json) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_pedido.itens_json)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd_prod := GREATEST(1, COALESCE((v_item->>'quantidade')::NUMERIC, 1));

    IF v_prod_id IS NOT NULL THEN
      FOR v_ficha IN 
        SELECT pi.ingrediente_id, pi.quantidade AS qtd_insumo
        FROM public.produto_ingredientes pi
        JOIN public.ingredientes i ON i.id = pi.ingrediente_id
        WHERE pi.produto_id = v_prod_id AND i.ativo = true
      LOOP
        UPDATE public.ingredientes
        SET 
          estoque_qtd = estoque_qtd - (v_ficha.qtd_insumo * v_qtd_prod),
          updated_at = NOW()
        WHERE id = v_ficha.ingrediente_id;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dar_baixa_ingredientes_pedido(BIGINT) TO service_role;

REVOKE INSERT, UPDATE, DELETE ON public.ingredientes, public.produto_ingredientes FROM authenticated;

ALTER TABLE public.ingredientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_ingredientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Equipe visualiza ingredientes" ON public.ingredientes;
CREATE POLICY "Equipe visualiza ingredientes" ON public.ingredientes
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam ingredientes" ON public.ingredientes;
CREATE POLICY "Admins gerenciam ingredientes" ON public.ingredientes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe visualiza produto_ingredientes" ON public.produto_ingredientes;
CREATE POLICY "Equipe visualiza produto_ingredientes" ON public.produto_ingredientes
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam produto_ingredientes" ON public.produto_ingredientes;
CREATE POLICY "Admins gerenciam produto_ingredientes" ON public.produto_ingredientes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingredientes TO service_role, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.produto_ingredientes TO service_role, authenticated;
GRANT SELECT ON public.view_produto_cmv TO service_role, authenticated;

