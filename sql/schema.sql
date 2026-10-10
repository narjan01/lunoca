-- ==========================================================================
-- LUNOCA DOCERIA - SCRIPT MESTRE DE INSTALAÇÃO (GERADO AUTOMATICAMENTE)
-- ==========================================================================
-- ⚠️  NÃO EDITE ESTE ARQUIVO À MÃO. Ele é gerado por: node scripts/build-sql.mjs
-- Fonte canônica: sql/baseline/000_baseline_ate_migration_010.sql + supabase/migrations/ (> 010)
-- Migrations incluídas: 011_etapa2_fechamento_concorrencia.sql, 012_hardening_politicas_e_nucleo.sql, 013_etapa3_orcamentos_conversao_comercial.sql, 014_governanca_catalogo_estoque_e_portas_dominio.sql, 015_comunicacao_whatsapp_e_relacionamento.sql
-- Execução única e idempotente no SQL Editor do Supabase.
-- ==========================================================================

-- ==========================================================================
-- LUNOCA DOCERIA - BASELINE CONSOLIDADO (estado do banco após a migration 010)
-- ==========================================================================
-- Este arquivo é o ponto de partida do gerador scripts/build-sql.mjs.
-- Ele representa, de forma idempotente, o schema consolidado até a migration 010.
-- NÃO adicione features aqui: crie uma nova migration em supabase/migrations/
-- (numeração >= 011) e rode `npm run build:sql`.
-- ==========================================================================

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
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_fisico INTEGER DEFAULT 0;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_reservado INTEGER DEFAULT 0;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER DEFAULT 5;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS controlar_estoque BOOLEAN DEFAULT true;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

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

-- 2.3 Pedidos
CREATE TABLE IF NOT EXISTS public.pedidos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id UUID REFERENCES public.profiles(id),
  nome_cliente TEXT NOT NULL,
  email_cliente TEXT NOT NULL,
  telefone_cliente TEXT,
  data_pedido DATE NOT NULL DEFAULT CURRENT_DATE,
  data_entrega DATE NOT NULL,
  hora_entrega TIME,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  desconto NUMERIC(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) NOT NULL,
  taxa_entrega DECIMAL(10,2) DEFAULT 0,
  valor_pago NUMERIC(10,2) NOT NULL DEFAULT 0,
  saldo NUMERIC(10,2) NOT NULL DEFAULT 0,
  sinal_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
  saldo_vencimento DATE,
  modalidade_entrega TEXT DEFAULT 'entrega',
  canal TEXT NOT NULL DEFAULT 'loja_online' CHECK (canal IN ('loja_online', 'whatsapp', 'balcao', 'telefone')),
  pagamento TEXT CHECK (pagamento IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro')) NOT NULL,
  status_comercial TEXT NOT NULL DEFAULT 'aguardando_confirmacao' CHECK (status_comercial IN ('aguardando_confirmacao', 'confirmado', 'cancelado', 'concluido')),
  status_financeiro TEXT NOT NULL DEFAULT 'nao_pago' CHECK (status_financeiro IN ('nao_pago', 'parcialmente_pago', 'pago', 'estornado')),
  status_operacional TEXT NOT NULL DEFAULT 'aguardando_producao' CHECK (status_operacional IN ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'retirado', 'cancelado')),
  status TEXT CHECK (status IN ('Pendente', 'Confirmado', 'Em Preparo', 'Pronto', 'Entregue', 'Cancelado')) DEFAULT 'Pendente',
  status_pagamento TEXT DEFAULT 'aguardando_pagamento',
  status_producao TEXT DEFAULT 'recebido',
  expires_at TIMESTAMPTZ,
  itens TEXT NOT NULL,
  itens_json JSONB,
  endereco_entrega TEXT NOT NULL,
  observacoes_cliente TEXT,
  observacoes_internas TEXT,
  possui_estorno BOOLEAN NOT NULL DEFAULT false,
  mercado_pago_status TEXT,
  mercado_pago_id TEXT,
  whatsapp_notificado BOOLEAN DEFAULT false,
  ultimo_status_whatsapp TEXT,
  checkout_token UUID DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS telefone_cliente TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS itens_json JSONB;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_status TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS mercado_pago_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_pagamento TEXT DEFAULT 'aguardando_pagamento';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_producao TEXT DEFAULT 'recebido';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS whatsapp_notificado BOOLEAN DEFAULT false;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS ultimo_status_whatsapp TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS taxa_entrega DECIMAL(10,2) DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS modalidade_entrega TEXT DEFAULT 'entrega';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS checkout_token UUID DEFAULT gen_random_uuid();
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Colunas Confectionery OS
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_comercial TEXT NOT NULL DEFAULT 'aguardando_confirmacao';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_financeiro TEXT NOT NULL DEFAULT 'nao_pago';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS status_operacional TEXT NOT NULL DEFAULT 'aguardando_producao';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'loja_online';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS desconto NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS saldo NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS sinal_minimo NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS saldo_vencimento DATE;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS hora_entrega TIME;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS observacoes_cliente TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS observacoes_internas TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS possui_estorno BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pedidos_checkout_token ON public.pedidos(checkout_token);
CREATE INDEX IF NOT EXISTS idx_pedidos_status_comercial ON public.pedidos(status_comercial);
CREATE INDEX IF NOT EXISTS idx_pedidos_status_financeiro ON public.pedidos(status_financeiro);
CREATE INDEX IF NOT EXISTS idx_pedidos_status_operacional ON public.pedidos(status_operacional);
CREATE INDEX IF NOT EXISTS idx_pedidos_canal ON public.pedidos(canal);
CREATE INDEX IF NOT EXISTS idx_pedidos_possui_estorno ON public.pedidos(possui_estorno);

-- 2.3.1 Tabela Canônica de Itens do Pedido (Audit 5 & Etapa 1)
CREATE TABLE IF NOT EXISTS public.pedido_itens (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE SET NULL,
  produto_nome_snapshot TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  unidade TEXT NOT NULL DEFAULT 'un',
  preco_base_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0,
  preco_adicionais NUMERIC(10,2) NOT NULL DEFAULT 0,
  preco_unitario_snapshot NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  cmv_unitario_snapshot NUMERIC(10,2) DEFAULT 0,
  cmv_total_snapshot NUMERIC(10,2) DEFAULT 0,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON public.pedido_itens(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto_id ON public.pedido_itens(produto_id);

-- 2.3.1.5. Catálogo Oficial de Opções e Adicionais de Produtos (Garantia Anti-Preço Inventado)
CREATE TABLE IF NOT EXISTS public.produto_opcoes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL CHECK (categoria IN ('tamanho', 'massa', 'recheio', 'decoracao', 'adicional', 'outro')),
  nome TEXT NOT NULL,
  preco_adicional NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (preco_adicional >= 0),
  obrigatorio BOOLEAN DEFAULT false,
  ativo BOOLEAN DEFAULT true,
  ordem INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_produto_opcao UNIQUE (produto_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_produto_opcoes_produto_id ON public.produto_opcoes(produto_id);

-- 2.3.2 Opções e Customizações de Itens (Snapshots Vinculados ao Pedido - Etapa 1 Confectionery OS)
CREATE TABLE IF NOT EXISTS public.pedido_item_opcoes (
  id BIGSERIAL PRIMARY KEY,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('tamanho', 'massa', 'recheio', 'decoracao', 'adicional', 'outro')),
  opcao_nome TEXT NOT NULL,
  preco_adicional NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_item_opcoes_item_id ON public.pedido_item_opcoes(pedido_item_id);

-- 2.3.3 Múltiplos Pagamentos do Pedido (Etapa 1 Confectionery OS)
CREATE TABLE IF NOT EXISTS public.pedido_pagamentos (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  metodo TEXT NOT NULL CHECK (metodo IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro')),
  provider TEXT NOT NULL DEFAULT 'manual' CHECK (provider IN ('mercadopago', 'manual', 'caixa')),
  provider_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'aprovado' CHECK (status IN ('pendente', 'aprovado', 'estornado')),
  pago_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registrado_por UUID REFERENCES public.profiles(id),
  comprovante_url TEXT,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_pagamentos_pedido_id ON public.pedido_pagamentos(pedido_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagamentos_provider_unique 
  ON public.pedido_pagamentos(provider, provider_payment_id) 
  WHERE provider_payment_id IS NOT NULL;

-- 2.3.4 Auditoria e Histórico de Status (Etapa 1 Confectionery OS)
CREATE TABLE IF NOT EXISTS public.pedido_status_historico (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  dimensao TEXT NOT NULL CHECK (dimensao IN ('comercial', 'financeiro', 'operacional')),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  usuario_id UUID REFERENCES public.profiles(id),
  usuario_nome TEXT,
  origem TEXT NOT NULL CHECK (origem IN ('admin', 'webhook_mercadopago', 'sistema', 'cliente', 'cron')),
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_status_historico_pedido_id ON public.pedido_status_historico(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_status_historico_created_at ON public.pedido_status_historico(created_at);

-- 2.4 Movimentações de Estoque
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

-- 2.5 Lançamentos Financeiros (Fluxo de Caixa com Idempotência Estrutural no DRE)
CREATE TABLE IF NOT EXISTS public.financeiro_lancamentos (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT CHECK (tipo IN ('receita', 'despesa')) NOT NULL,
  categoria TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor DECIMAL(10,2) NOT NULL,
  data_lancamento DATE DEFAULT CURRENT_DATE,
  forma_pagamento TEXT CHECK (forma_pagamento IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'boleto', 'outro')) DEFAULT 'pix',
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  origem_tipo TEXT DEFAULT 'manual',
  origem_id BIGINT,
  evento TEXT,
  comprovante_url TEXT,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.financeiro_lancamentos ADD COLUMN IF NOT EXISTS origem_tipo TEXT DEFAULT 'manual';
ALTER TABLE public.financeiro_lancamentos ADD COLUMN IF NOT EXISTS origem_id BIGINT;
ALTER TABLE public.financeiro_lancamentos ADD COLUMN IF NOT EXISTS evento TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_financeiro_origem_evento
  ON public.financeiro_lancamentos(origem_tipo, origem_id, evento)
  WHERE origem_id IS NOT NULL AND evento IS NOT NULL;

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
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

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
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

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

    -- Se calculou com sucesso, sobrescreve obrigatoriamente o total e subtotal
    IF v_possui_itens_validos AND v_total_calculado > 0 THEN
      NEW.subtotal := v_total_calculado;
      NEW.total := v_total_calculado + COALESCE(NEW.taxa_entrega, 0) - COALESCE(NEW.desconto, 0);
      NEW.saldo := GREATEST(0, NEW.total - COALESCE(NEW.valor_pago, 0));
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

-- Recálculo Financeiro Atômico (Fonte da Verdade em pedido_pagamentos)
CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_ped_id BIGINT := COALESCE(NEW.pedido_id, OLD.pedido_id);
  v_total NUMERIC(10,2);
  v_pago NUMERIC(10,2);
  v_saldo NUMERIC(10,2);
  v_status_fin_antigo TEXT;
  v_novo_status_fin TEXT;
  v_tem_estorno BOOLEAN := false;
BEGIN
  SELECT total, status_financeiro INTO v_total, v_status_fin_antigo 
  FROM public.pedidos 
  WHERE id = v_ped_id;
  
  -- Soma estritamente pagamentos aprovados
  SELECT COALESCE(SUM(valor), 0) INTO v_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = v_ped_id AND status = 'aprovado';

  v_saldo := GREATEST(0, COALESCE(v_total, 0) - v_pago);

  -- Verifica se existem pagamentos com status 'estornado'
  SELECT EXISTS (
    SELECT 1 FROM public.pedido_pagamentos 
    WHERE pedido_id = v_ped_id AND status = 'estornado'
  ) INTO v_tem_estorno;

  -- Transição determinística do status financeiro
  IF v_tem_estorno AND v_pago <= 0 THEN
    v_novo_status_fin := 'estornado';
  ELSIF v_pago <= 0 THEN
    v_novo_status_fin := 'nao_pago';
  ELSIF v_saldo <= 0 THEN
    v_novo_status_fin := 'pago';
  ELSE
    v_novo_status_fin := 'parcialmente_pago';
  END IF;

  UPDATE public.pedidos
  SET 
    valor_pago = v_pago,
    saldo = v_saldo,
    status_financeiro = v_novo_status_fin,
    possui_estorno = v_tem_estorno,
    updated_at = NOW()
  WHERE id = v_ped_id;

  -- Lançamento contábil compensatório no financeiro ao estornar pagamento aprovado (idempotência estrutural garantida)
  IF TG_OP = 'UPDATE' AND OLD.status = 'aprovado' AND NEW.status = 'estornado' THEN
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      origem_tipo,
      origem_id,
      evento,
      observacoes
    ) VALUES (
      'despesa',
      'Estornos',
      'Estorno de Pagamento #' || NEW.id || ' do Pedido #' || v_ped_id || ' (' || upper(NEW.metodo) || ')',
      NEW.valor,
      CURRENT_DATE,
      NEW.metodo,
      v_ped_id,
      'pedido_pagamento',
      NEW.id,
      'estorno',
      'Estorno financeiro contábil automático via pedido_pagamentos #' || NEW.id
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- Se o status financeiro mudou, registrar automaticamente na auditoria de histórico
  IF v_status_fin_antigo IS DISTINCT FROM v_novo_status_fin THEN
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, 
      usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      v_ped_id,
      'financeiro',
      COALESCE(v_status_fin_antigo, 'nao_pago'),
      v_novo_status_fin,
      auth.uid(),
      'Sistema / Trigger Financeiro',
      CASE 
        WHEN auth.role() = 'service_role' THEN 'sistema'
        WHEN public.is_admin_or_operator() THEN 'admin'
        ELSE 'sistema'
      END,
      jsonb_build_object(
        'motivo', 'Recálculo automático via pedido_pagamentos',
        'valor_pago', v_pago,
        'saldo', v_saldo,
        'tem_estorno', v_tem_estorno
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_recalcular_financeiro_pedido ON public.pedido_pagamentos;
CREATE TRIGGER trg_recalcular_financeiro_pedido
  AFTER INSERT OR UPDATE OR DELETE ON public.pedido_pagamentos
  FOR EACH ROW
  EXECUTE FUNCTION public.recalcular_financeiro_pedido();

-- Compatibilidade Legada Somente-Leitura (Derivação estrita de status)
CREATE OR REPLACE FUNCTION public.sincronizar_status_legado_pedido()
RETURNS TRIGGER AS $$
BEGIN
  NEW.status := CASE
    WHEN NEW.status_comercial = 'cancelado' OR NEW.status_operacional = 'cancelado' THEN 'Cancelado'
    WHEN NEW.status_operacional = 'entregue' OR NEW.status_operacional = 'retirado' THEN 'Entregue'
    WHEN NEW.status_operacional = 'pronto' THEN 'Pronto'
    WHEN NEW.status_operacional = 'em_producao' THEN 'Em Preparo'
    WHEN NEW.status_comercial = 'confirmado' OR NEW.status_financeiro = 'pago' THEN 'Confirmado'
    ELSE 'Pendente'
  END;

  IF NEW.status_financeiro = 'pago' THEN
    NEW.status_pagamento := 'pago';
  ELSIF NEW.status_financeiro = 'estornado' THEN
    NEW.status_pagamento := 'reembolsado';
  ELSIF NEW.status_financeiro = 'parcialmente_pago' THEN
    NEW.status_pagamento := 'parcial';
  ELSIF NEW.status_comercial = 'cancelado' THEN
    NEW.status_pagamento := 'cancelado';
  END IF;

  IF NEW.status_operacional = 'em_producao' THEN
    NEW.status_producao := 'em_preparo';
  ELSIF NEW.status_operacional = 'pronto' THEN
    NEW.status_producao := 'pronto';
  ELSIF NEW.status_operacional IN ('entregue', 'retirado') THEN
    NEW.status_producao := 'entregue';
  ELSIF NEW.status_operacional = 'cancelado' THEN
    NEW.status_producao := 'cancelado';
  ELSIF NEW.status_operacional = 'aguardando_producao' AND NEW.status_comercial = 'confirmado' THEN
    NEW.status_producao := 'recebido';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_sincronizar_status_legado_pedido ON public.pedidos;
CREATE TRIGGER trg_sincronizar_status_legado_pedido
  BEFORE INSERT OR UPDATE ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public.sincronizar_status_legado_pedido();

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
  v_pedido_item_id BIGINT;
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_preco_opcao_real NUMERIC(10,2);
  v_tipo_opcao TEXT;
  v_adicionais_item NUMERIC(10,2);
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
    SELECT id, nome, preco, ativo, opcoes, estoque_fisico, estoque_reservado, controlar_estoque 
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

    -- Pré-validação estrita das opções com Fail-Closed (Anti-spoofing e integridade de produção)
    FOR v_opcao IN 
      SELECT value 
      FROM jsonb_array_elements(p_itens) elem,
           jsonb_array_elements(CASE WHEN jsonb_typeof(elem->'opcoes') = 'array' THEN elem->'opcoes' ELSE '[]'::jsonb END) value
      WHERE (elem->>'id')::BIGINT = v_prod_id
    LOOP
      v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
      IF v_opcao_nome <> '' THEN
        SELECT COALESCE(preco_adicional, 0.00), categoria
        INTO v_preco_opcao_real, v_tipo_opcao
        FROM public.produto_opcoes
        WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
        LIMIT 1;

        IF NOT FOUND THEN
          -- Compatibilidade legada com produtos.opcoes
          IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
            v_preco_opcao_real := 0.00;
          ELSE
            -- FAIL-CLOSED: Rejeita antes de criar o pedido para evitar que a cozinha produza item divergente do solicitado
            RETURN json_build_object(
              'success', false,
              'code', 'INVALID_PRODUCT_OPTION',
              'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '". Por favor, selecione as opções disponíveis no cardápio.',
              'produto_id', v_prod.id,
              'opcao', v_opcao_nome
            );
          END IF;
        END IF;

        v_total := v_total + (v_preco_opcao_real * v_qtd);
      END IF;
    END LOOP;

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

  -- 6. ETAPA 2: Gravação do Pedido primeiro com dados do Confectionery OS
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    subtotal,
    desconto,
    total,
    taxa_entrega,
    valor_pago,
    saldo,
    modalidade_entrega,
    canal,
    pagamento,
    status_comercial,
    status_financeiro,
    status_operacional,
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
    (v_total - v_taxa),
    0.00,
    v_total,
    v_taxa,
    0.00,
    v_total,
    COALESCE(p_modalidade, 'entrega'),
    'loja_online',
    p_pagamento,
    'aguardando_confirmacao',
    'nao_pago',
    'aguardando_producao',
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

    SELECT id, nome, preco, opcoes, estoque_fisico, estoque_reservado, controlar_estoque 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_adicionais_item := 0.00;

    -- Inserção canônica de itens com snapshot expandido
    INSERT INTO public.pedido_itens (
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      unidade,
      preco_base_snapshot,
      preco_adicionais,
      preco_unitario_snapshot,
      subtotal
    ) VALUES (
      v_pedido_id,
      v_prod.id,
      v_prod.nome,
      v_qtd,
      'un',
      v_prod.preco,
      0.00,
      v_prod.preco,
      (v_prod.preco * v_qtd)
    ) RETURNING id INTO v_pedido_item_id;

    -- Resolução estrita no servidor das opções da confeitaria (imunidade total a preço inventado)
    FOR v_opcao IN 
      SELECT value 
      FROM jsonb_array_elements(p_itens) elem,
           jsonb_array_elements(CASE WHEN jsonb_typeof(elem->'opcoes') = 'array' THEN elem->'opcoes' ELSE '[]'::jsonb END) value
      WHERE (elem->>'id')::BIGINT = v_prod_id
    LOOP
      v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
      IF v_opcao_nome <> '' THEN
        -- O preço da opção NUNCA é lido do payload do cliente! Ele é obtido do catálogo oficial produto_opcoes.
        SELECT COALESCE(preco_adicional, 0.00), categoria
        INTO v_preco_opcao_real, v_tipo_opcao
        FROM public.produto_opcoes
        WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
        LIMIT 1;

        IF NOT FOUND THEN
          -- Compatibilidade legada com produtos.opcoes
          IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
            v_preco_opcao_real := 0.00;
            v_tipo_opcao := 'outro';
          ELSE
            RAISE EXCEPTION 'Opção % não é válida para o produto %', v_opcao_nome, v_prod.nome;
          END IF;
        END IF;

        INSERT INTO public.pedido_item_opcoes (
          pedido_item_id,
          tipo,
          opcao_nome,
          preco_adicional
        ) VALUES (
          v_pedido_item_id,
          v_tipo_opcao,
          v_opcao_nome,
          v_preco_opcao_real
        );

        v_adicionais_item := v_adicionais_item + v_preco_opcao_real;
      END IF;
    END LOOP;

    IF v_adicionais_item > 0 THEN
      UPDATE public.pedido_itens
      SET 
        preco_adicionais = v_adicionais_item,
        preco_unitario_snapshot = preco_base_snapshot + v_adicionais_item,
        subtotal = (preco_base_snapshot + v_adicionais_item) * quantidade
      WHERE id = v_pedido_item_id;
    END IF;

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

  -- 8. Gravação do Histórico Inicial
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, origem, metadata
  ) VALUES 
    (v_pedido_id, 'comercial', NULL, 'aguardando_confirmacao', 'cliente', jsonb_build_object('canal', 'loja_online')),
    (v_pedido_id, 'financeiro', NULL, 'nao_pago', 'cliente', jsonb_build_object('forma', p_pagamento)),
    (v_pedido_id, 'operacional', NULL, 'aguardando_producao', 'cliente', jsonb_build_object('modalidade', p_modalidade));

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'subtotal', (v_total - v_taxa),
    'total', v_total,
    'taxa_entrega', v_taxa,
    'checkout_token', v_checkout_token,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;

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

  -- Tratamento de estorno / contestação recebido do gateway (refunded / charged_back)
  IF LOWER(COALESCE(p_status, '')) IN ('refunded', 'charged_back') THEN
    SELECT * INTO v_pedido
    FROM public.pedidos
    WHERE id = p_pedido_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN json_build_object('success', false, 'error', 'Pedido não encontrado no banco de dados.');
    END IF;

    -- Atualiza status em pedido_pagamentos (o trigger recalcular_financeiro_pedido lançará a despesa de Estorno e atualizará saldo/status_financeiro)
    UPDATE public.pedido_pagamentos
    SET 
      status = 'estornado',
      observacoes = COALESCE(observacoes, '') || ' [Estorno via ' || COALESCE(p_origem, 'gateway') || ' status: ' || p_status || ' em ' || NOW()::TEXT || ']'
    WHERE pedido_id = p_pedido_id 
      AND (provider_payment_id = p_mercado_pago_payment_id OR (p_mercado_pago_payment_id IS NULL AND provider = 'mercadopago'))
      AND status = 'aprovado';

    UPDATE public.pedidos
    SET 
      mercado_pago_status = p_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (
      pedido_id,
      dimensao,
      status_anterior,
      status_novo,
      origem,
      metadata
    ) VALUES (
      p_pedido_id,
      'financeiro',
      v_pedido.status_financeiro,
      'estornado',
      'webhook_mercadopago',
      jsonb_build_object('provider_payment_id', p_mercado_pago_payment_id, 'status', p_status, 'origem', p_origem)
    );

    RETURN json_build_object(
      'success', true,
      'message', 'Estorno processado com sucesso pelo gateway.',
      'pedido_id', p_pedido_id,
      'status_gateway', p_status
    );
  END IF;

  -- Validação estrita de status: somente pagamentos aprovados podem confirmar pedidos
  IF COALESCE(p_mercado_pago_payment_id, '') <> 'admin_manual'
     AND LOWER(COALESCE(p_status, '')) <> 'approved'
  THEN
    RETURN json_build_object('success', false, 'error', 'Somente pagamentos aprovados podem confirmar pedidos.');
  END IF;

  -- 7.1. Idempotência por Provider ID em pagamentos_processados
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

  -- Validação de integridade financeira do valor pago vs total do pedido
  IF p_valor IS NOT NULL AND ABS(p_valor - v_pedido.total) > 0.01 THEN
    RETURN json_build_object('success', false, 'error', 'Valor do pagamento (R$ ' || p_valor || ') diverge do total do pedido (R$ ' || v_pedido.total || ').');
  END IF;

  -- 7.3. Se já confirmado anteriormente, impede duplo processamento
  IF v_pedido.status_financeiro = 'pago' OR v_pedido.status_comercial = 'confirmado' THEN
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

  -- Idempotência por Provider ID em pedido_pagamentos
  IF p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' AND p_mercado_pago_payment_id <> 'admin_manual' THEN
    IF EXISTS (
      SELECT 1 FROM public.pedido_pagamentos
      WHERE provider = 'mercadopago' AND provider_payment_id = p_mercado_pago_payment_id
    ) THEN
      RETURN json_build_object(
        'success', true,
        'message', 'Pagamento já processado anteriormente em pedido_pagamentos (idempotência confirmada).',
        'pedido_id', p_pedido_id,
        'payment_id', p_mercado_pago_payment_id
      );
    END IF;
  END IF;

  -- 7.4. Registrar na tabela canônica pedido_pagamentos (dispara recálculo financeiro atômico)
  INSERT INTO public.pedido_pagamentos (
    pedido_id,
    valor,
    metodo,
    provider,
    provider_payment_id,
    status,
    pago_em,
    observacoes
  ) VALUES (
    p_pedido_id,
    COALESCE(p_valor, v_pedido.total),
    CASE 
      WHEN COALESCE(p_forma_pagamento, v_pedido.pagamento) ILIKE '%cartao%' THEN 'cartao'
      WHEN COALESCE(p_forma_pagamento, v_pedido.pagamento) ILIKE '%dinheiro%' THEN 'dinheiro'
      ELSE 'pix'
    END,
    CASE WHEN p_mercado_pago_payment_id = 'admin_manual' THEN 'manual' ELSE 'mercadopago' END,
    CASE WHEN p_mercado_pago_payment_id = 'admin_manual' THEN NULL ELSE p_mercado_pago_payment_id END,
    'aprovado',
    NOW(),
    'Confirmação de pagamento via ' || COALESCE(p_origem, 'gateway')
  )
  ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING;

  -- 7.5. Atualiza dados comerciais e de gateway no pedido
  UPDATE public.pedidos
  SET 
    status_comercial = 'confirmado',
    status_operacional = CASE WHEN status_operacional = 'aguardando_producao' OR status_operacional IS NULL THEN 'aguardando_producao' ELSE status_operacional END,
    mercado_pago_status = COALESCE(p_status, 'approved'),
    mercado_pago_id = COALESCE(p_mercado_pago_payment_id, mercado_pago_id),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 7.6. Baixa física e liberação da reserva no estoque (SELECT FOR UPDATE)
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

  -- 7.7. Baixa atômica de insumos da receita (Ficha Técnica)
  PERFORM public.dar_baixa_ingredientes_pedido(p_pedido_id);

  -- 7.8. Registra receita no financeiro com proteção de idempotência estrutural
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    pedido_id,
    origem_tipo,
    origem_id,
    evento,
    observacoes
  ) VALUES (
    'receita',
    'Vendas',
    'Venda do Pedido #' || p_pedido_id || ' (' || v_pedido.nome_cliente || ')',
    COALESCE(p_valor, v_pedido.total),
    CURRENT_DATE,
    COALESCE(p_forma_pagamento, v_pedido.pagamento, 'pix'),
    p_pedido_id,
    'pedido_pagamento',
    p_pedido_id,
    'recebimento',
    'Confirmação via ' || COALESCE(p_origem, 'Mercado Pago') ||
      CASE 
        WHEN p_mercado_pago_payment_id IS NOT NULL AND p_mercado_pago_payment_id <> '' 
        THEN ' [ID: ' || p_mercado_pago_payment_id || ']' 
        ELSE '' 
      END
  )
  ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;

  -- 7.9. Grava registro na tabela de pagamentos processados (idempotência)
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

  -- 7.10. Registro no Histórico de Status
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'financeiro',
    v_pedido.status_financeiro,
    'pago',
    CASE WHEN p_origem ILIKE '%admin%' THEN 'admin' WHEN p_origem ILIKE '%webhook%' THEN 'webhook_mercadopago' ELSE 'sistema' END,
    jsonb_build_object('provider_payment_id', p_mercado_pago_payment_id, 'valor', COALESCE(p_valor, v_pedido.total), 'origem', p_origem)
  );

  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'comercial',
    v_pedido.status_comercial,
    'confirmado',
    CASE WHEN p_origem ILIKE '%admin%' THEN 'admin' WHEN p_origem ILIKE '%webhook%' THEN 'webhook_mercadopago' ELSE 'sistema' END,
    jsonb_build_object('motivo', 'pagamento_confirmado')
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status', 'Confirmado',
    'status_comercial', 'confirmado',
    'status_financeiro', 'pago',
    'status_operacional', 'aguardando_producao'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- ==========================================================================
-- 8. RPC: LIBERAÇÃO DE ESTOQUE DE PEDIDOS EXPIRADOS (CLEANUP AUTOMÁTICO)
-- ==========================================================================
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

DROP POLICY IF EXISTS "Usuário vê seu perfil se ativo ou admin vê todos" ON public.profiles;
CREATE POLICY "Usuário vê seu perfil se ativo ou admin vê todos" 
  ON public.profiles FOR SELECT 
  USING (
    (auth.uid() = id AND ativo = true) 
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "Usuário atualiza dados se ativo ou admin altera" ON public.profiles;
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

DROP POLICY IF EXISTS "Visualização de produtos ativos ou por equipe" ON public.produtos;
CREATE POLICY "Visualização de produtos ativos ou por equipe" 
  ON public.produtos FOR SELECT 
  USING (ativo = true OR public.is_admin_or_operator());

DROP POLICY IF EXISTS "Operadores e admins inserem produtos" ON public.produtos;
CREATE POLICY "Operadores e admins inserem produtos" 
  ON public.produtos FOR INSERT 
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Operadores e admins atualizam produtos" ON public.produtos;
CREATE POLICY "Operadores e admins atualizam produtos" 
  ON public.produtos FOR UPDATE 
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Apenas admins deletam produtos" ON public.produtos;
CREATE POLICY "Apenas admins deletam produtos" 
  ON public.produtos FOR DELETE 
  USING (public.is_admin());

-- 9.3 Pedidos
DROP POLICY IF EXISTS "Usuários podem ver seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Admins podem ver todos os pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Usuários podem criar seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Clientes ativos criam seus próprios pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Clientes ativos criam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Admins podem atualizar pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Apenas administradores ou operadores atualizam pedidos" ON public.pedidos;
DROP POLICY IF EXISTS "Equipe atualiza pedidos" ON public.pedidos;

DROP POLICY IF EXISTS "Clientes ativos veem seus pedidos ou admins veem todos" ON public.pedidos;
CREATE POLICY "Clientes ativos veem seus pedidos ou admins veem todos" 
  ON public.pedidos FOR SELECT 
  USING (
    (auth.uid() = cliente_id AND public.is_user_active()) 
    OR public.is_admin_or_operator()
  );

-- Erradicação de criação e mutação direta de pedidos no cliente (Audit 5)
REVOKE INSERT, UPDATE ON public.pedidos FROM PUBLIC, anon, authenticated;

-- Políticas RLS para produto_opcoes (Catálogo)
ALTER TABLE public.produto_opcoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.produto_opcoes FROM PUBLIC;
GRANT SELECT ON public.produto_opcoes TO anon, authenticated, service_role;
GRANT ALL ON public.produto_opcoes TO service_role;

DROP POLICY IF EXISTS "Opções de produtos visíveis publicamente" ON public.produto_opcoes;
CREATE POLICY "Opções de produtos visíveis publicamente" ON public.produto_opcoes 
  FOR SELECT USING (ativo = true OR public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia opções de produtos" ON public.produto_opcoes;
CREATE POLICY "Equipe gerencia opções de produtos" ON public.produto_opcoes 
  FOR ALL USING (public.is_admin_or_operator());

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

-- Políticas RLS para pedido_item_opcoes
ALTER TABLE public.pedido_item_opcoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_item_opcoes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_item_opcoes TO service_role;

DROP POLICY IF EXISTS "Clientes visualizam opcoes de itens de seus pedidos" ON public.pedido_item_opcoes;
CREATE POLICY "Clientes visualizam opcoes de itens de seus pedidos" ON public.pedido_item_opcoes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.pedido_itens pi
      JOIN public.pedidos p ON p.id = pi.pedido_id
      WHERE pi.id = pedido_item_opcoes.pedido_item_id
        AND ((p.cliente_id = auth.uid() AND public.is_user_active()) OR public.is_admin_or_operator())
    )
  );

-- Políticas RLS para pedido_pagamentos
ALTER TABLE public.pedido_pagamentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_pagamentos FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_pagamentos TO service_role;

DROP POLICY IF EXISTS "Clientes visualizam pagamentos de seus pedidos" ON public.pedido_pagamentos;
CREATE POLICY "Clientes visualizam pagamentos de seus pedidos" ON public.pedido_pagamentos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_pagamentos.pedido_id
        AND ((p.cliente_id = auth.uid() AND public.is_user_active()) OR public.is_admin_or_operator())
    )
  );

-- Políticas RLS para pedido_status_historico
ALTER TABLE public.pedido_status_historico ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pedido_status_historico FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pedido_status_historico TO service_role;

DROP POLICY IF EXISTS "Clientes visualizam historico de seus pedidos" ON public.pedido_status_historico;
CREATE POLICY "Clientes visualizam historico de seus pedidos" ON public.pedido_status_historico
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_status_historico.pedido_id
        AND ((p.cliente_id = auth.uid() AND public.is_user_active()) OR public.is_admin_or_operator())
    )
  );

-- RPC alterar_status_pedido com Matriz de Transições e Auditoria
CREATE OR REPLACE FUNCTION public.alterar_status_pedido(
  p_pedido_id BIGINT,
  p_dimensao TEXT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_antigo TEXT;
  v_permitido BOOLEAN := false;
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();

  IF p_dimensao = 'operacional' THEN
    v_status_antigo := v_ped.status_operacional;

    IF p_novo_status NOT IN ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      RETURN json_build_object('success', false, 'error', 'Status operacional inválido: ' || p_novo_status);
    END IF;

    -- Matriz de transições operacionais
    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_producao' AND p_novo_status IN ('em_producao', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'em_producao' AND p_novo_status IN ('pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'pronto' AND p_novo_status IN ('saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'saiu_para_entrega' AND p_novo_status IN ('entregue', 'pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF public.is_admin() THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição operacional não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_operacional = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

  ELSIF p_dimensao = 'comercial' THEN
    v_status_antigo := v_ped.status_comercial;

    IF p_novo_status NOT IN ('aguardando_confirmacao', 'confirmado', 'cancelado', 'concluido') THEN
      RETURN json_build_object('success', false, 'error', 'Status comercial inválido: ' || p_novo_status);
    END IF;

    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_confirmacao' AND p_novo_status IN ('confirmado', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'confirmado' AND p_novo_status IN ('concluido', 'cancelado') THEN
      v_permitido := true;
    ELSIF public.is_admin() THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição comercial não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_comercial = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

  ELSE
    RETURN json_build_object('success', false, 'error', 'Dimensão de status inválida. Use "operacional" ou "comercial". Para financeiro, registre pagamentos.');
  END IF;

  -- Gravação auditável do histórico
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    p_dimensao,
    v_status_antigo,
    p_novo_status,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object('motivo', p_motivo) || COALESCE(p_metadata, '{}'::JSONB)
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'dimensao', p_dimensao,
    'status_anterior', v_status_antigo,
    'status_novo', p_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- RPC registrar_pagamento_pedido
CREATE OR REPLACE FUNCTION public.registrar_pagamento_pedido(
  p_pedido_id BIGINT,
  p_valor NUMERIC,
  p_metodo TEXT,
  p_observacoes TEXT DEFAULT NULL,
  p_comprovante_url TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_pagamento_id BIGINT;
  v_metodo_norm TEXT;
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem registrar pagamentos.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  IF p_valor IS NULL OR p_valor <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Valor de pagamento deve ser positivo.');
  END IF;

  v_metodo_norm := LOWER(TRIM(COALESCE(p_metodo, 'pix')));
  IF v_metodo_norm NOT IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro') THEN
    RETURN json_build_object('success', false, 'error', 'Método de pagamento inválido: ' || p_metodo);
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- 2. Validações de integridade do pedido
  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN json_build_object('success', false, 'error', 'Não é possível registrar pagamento em um pedido cancelado.');
  END IF;

  IF v_ped.status_financeiro = 'pago' AND p_valor > 0 THEN
    RETURN json_build_object('success', false, 'error', 'Pedido já se encontra totalmente quitado.');
  END IF;

  IF p_valor > (v_ped.saldo + 0.01) THEN
    RETURN json_build_object('success', false, 'error', 'Valor informado (R$ ' || p_valor || ') excede o saldo devedor restante (R$ ' || v_ped.saldo || ').');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL AND auth.role() = 'service_role' THEN
    v_user_nome := 'Sistema / service_role';
  END IF;

  INSERT INTO public.pedido_pagamentos (
    pedido_id,
    valor,
    metodo,
    provider,
    provider_payment_id,
    status,
    pago_em,
    registrado_por,
    comprovante_url,
    observacoes
  ) VALUES (
    p_pedido_id,
    p_valor,
    v_metodo_norm,
    'manual',
    NULL,
    'aprovado',
    NOW(),
    auth.uid(),
    p_comprovante_url,
    p_observacoes
  ) RETURNING id INTO v_pagamento_id;

  -- Lançamento automático no financeiro geral com idempotência estrutural
  INSERT INTO public.financeiro_lancamentos (
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento,
    forma_pagamento,
    pedido_id,
    origem_tipo,
    origem_id,
    evento,
    observacoes
  ) VALUES (
    'receita',
    'Vendas',
    'Recebimento registrado do Pedido #' || p_pedido_id || ' via ' || upper(v_metodo_norm),
    p_valor,
    CURRENT_DATE,
    v_metodo_norm,
    p_pedido_id,
    'pedido_pagamento',
    v_pagamento_id,
    'recebimento',
    p_observacoes
  )
  ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;

  -- Registro de histórico auditável
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'financeiro',
    v_ped.status_financeiro,
    (SELECT status_financeiro FROM public.pedidos WHERE id = p_pedido_id),
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'pagamento_id', v_pagamento_id,
      'valor', p_valor,
      'metodo', v_metodo_norm,
      'observacoes', p_observacoes
    )
  );

  RETURN json_build_object(
    'success', true,
    'pagamento_id', v_pagamento_id,
    'pedido_id', p_pedido_id,
    'valor', p_valor,
    'metodo', v_metodo_norm,
    'saldo_restante', (SELECT saldo FROM public.pedidos WHERE id = p_pedido_id),
    'status_financeiro', (SELECT status_financeiro FROM public.pedidos WHERE id = p_pedido_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_pagamento_pedido(BIGINT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pagamento_pedido(BIGINT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- 9.1. RPC para Estorno Auditável de Pagamentos
CREATE OR REPLACE FUNCTION public.estornar_pagamento_pedido(
  p_pagamento_id BIGINT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_pag RECORD;
  v_user_nome TEXT;
BEGIN
  -- Autorização estrita: anon -> NÃO, cliente -> NÃO, operador/admin/service_role -> SIM
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem estornar pagamentos.');
  END IF;

  IF p_pagamento_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pagamento não informado.');
  END IF;

  SELECT * INTO v_pag FROM public.pedido_pagamentos WHERE id = p_pagamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pagamento não encontrado.');
  END IF;

  -- Idempotência: se já estornado, retorna sucesso sem duplicar lançamentos
  IF v_pag.status = 'estornado' THEN
    RETURN json_build_object(
      'success', true,
      'message', 'Pagamento já se encontra estornado.',
      'pagamento_id', p_pagamento_id,
      'pedido_id', v_pag.pedido_id
    );
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL AND auth.role() = 'service_role' THEN
    v_user_nome := 'Sistema / service_role';
  END IF;

  -- A alteração de status para 'estornado' dispara automaticamente o trigger recalcular_financeiro_pedido,
  -- que ajusta o saldo, transiciona status_financeiro e cria o lançamento compensatório em financeiro_lancamentos.
  UPDATE public.pedido_pagamentos
  SET 
    status = 'estornado',
    observacoes = COALESCE(observacoes, '') || ' [Estornado por ' || COALESCE(v_user_nome, 'Admin') || ' em ' || NOW()::TEXT || ': ' || COALESCE(p_motivo, 'Sem motivo informado') || ']'
  WHERE id = p_pagamento_id;

  RETURN json_build_object(
    'success', true,
    'message', 'Pagamento estornado com sucesso.',
    'pagamento_id', p_pagamento_id,
    'pedido_id', v_pag.pedido_id,
    'valor', v_pag.valor
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.estornar_pagamento_pedido(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estornar_pagamento_pedido(BIGINT, TEXT) TO authenticated, service_role;

-- RPC Segura para Transições Operacionais de Pedidos por Operadores/Admins (Compatibilidade Legada)
CREATE OR REPLACE FUNCTION public.alterar_status_operacional_pedido(
  p_pedido_id BIGINT,
  p_novo_status TEXT
)
RETURNS JSON AS $$
DECLARE
  v_status_op TEXT;
  v_res JSON;
BEGIN
  -- Mapeia status legado de texto para novo status operacional
  v_status_op := CASE 
    WHEN p_novo_status IN ('Em Preparo', 'em_preparo', 'em_producao') THEN 'em_producao'
    WHEN p_novo_status IN ('Pronto', 'pronto') THEN 'pronto'
    WHEN p_novo_status IN ('Entregue', 'entregue') THEN 'entregue'
    WHEN p_novo_status IN ('Cancelado', 'cancelado') THEN 'cancelado'
    WHEN p_novo_status IN ('Confirmado', 'recebido', 'aguardando_producao') THEN 'aguardando_producao'
    ELSE LOWER(p_novo_status)
  END;

  v_res := public.alterar_status_pedido(p_pedido_id, 'operacional', v_status_op, 'Transição solicitada via adapter operacional legado');

  IF (v_res->>'success')::BOOLEAN IS TRUE AND v_status_op = 'cancelado' THEN
    PERFORM public.alterar_status_pedido(p_pedido_id, 'comercial', 'cancelado', 'Cancelamento comercial em cascata via adapter operacional');
  END IF;

  RETURN v_res;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_operacional_pedido(BIGINT, TEXT) TO authenticated, service_role;

-- Lockdown estrito de pagamentos_processados
ALTER TABLE public.pagamentos_processados ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pagamentos_processados FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pagamentos_processados TO service_role;

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
-- 10. FICHA TÉCNICA, INSUMOS E CMV (FASE 6)
-- ==========================================================================

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

-- Seeds de Ingredientes
INSERT INTO public.ingredientes (nome, unidade, custo_unitario, estoque_qtd, estoque_minimo)
VALUES 
  ('Leite Condensado Moça', 'g', 0.0175, 5000.000, 1000.000),
  ('Chocolate Nobre Meio Amargo', 'g', 0.0550, 4000.000, 800.000),
  ('Creme de Leite Nestlé', 'g', 0.0160, 3000.000, 600.000),
  ('Manteiga Extra sem Sal', 'g', 0.0450, 2000.000, 400.000),
  ('Farinha de Trigo Especial', 'g', 0.0050, 10000.000, 2000.000),
  ('Açúcar Refinado União', 'g', 0.0045, 10000.000, 2000.000),
  ('Cacau em Pó 100%', 'g', 0.0480, 2500.000, 500.000),
  ('Embalagem Individual Padrão', 'un', 1.2000, 200.000, 30.000),
  ('Caixa Kraft para Presente', 'un', 3.5000, 100.000, 15.000)
ON CONFLICT DO NOTHING;

-- ==========================================================================
-- FIM DO SCRIPT DE INSTALAÇÃO & SEGURANÇA
-- ==========================================================================

-- ==========================================================================
-- -- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 010: OPERAÇÃO DIÁRIA & CONFECTIONERY OS CORE (ETAPA 2)
-- ==========================================================================
-- Implementa:
-- 1. Entidade canônica public.clientes com RLS fechado e índices de unicidade
-- 2. Vínculo comercial pedidos.cliente_id_rel com backfill idempotente
-- 3. Snapshots imutáveis de carga produtiva em itens e opções
-- 4. Tabela public.capacidade_producao com lock pessimista serializável
-- 5. Trigger recalcular_financeiro_pedido com confirmação automática por sinal
--    e guarda de produção em estornos (não regride produção nem concluído)
-- 6. RPC buscar_clientes_admin (busca rápida por telefone ou nome)
-- 7. RPC criar_encomenda_admin (governança de sinal, desconto máx 10%, anti-overbooking)
-- 8. RPC reagendar_encomenda_admin (inicialização concorrente e lock anti-deadlock)
-- 9. RPC obter_resumo_operacao_hoje (métricas via ledger contábil e America/Fortaleza)
-- 10. RPC obter_agenda_encomendas (agenda tri-modo com capacidade dinâmica derivada)
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. TABELA CANÔNICA DE CLIENTES (CRM E OPERAÇÃO DESACOPLADA DE AUTH)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clientes (
  id BIGSERIAL PRIMARY KEY,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  nome TEXT NOT NULL,
  telefone TEXT,
  telefone_normalizado TEXT, -- apenas dígitos com DDD (ex: 5585999999999)
  email TEXT,
  cpf TEXT,
  data_nascimento DATE,
  endereco_padrao JSONB DEFAULT '{}'::JSONB,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_auth_user_id 
  ON public.clientes(auth_user_id) 
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_telefone_normalizado 
  ON public.clientes(telefone_normalizado) 
  WHERE telefone_normalizado IS NOT NULL AND telefone_normalizado <> '';

CREATE INDEX IF NOT EXISTS idx_clientes_nome_lower 
  ON public.clientes(LOWER(nome));

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clientes FROM PUBLIC, anon, authenticated;

-- Políticas de RLS fechadas em clientes
DROP POLICY IF EXISTS "Equipe ou dono visualiza clientes" ON public.clientes;
CREATE POLICY "Equipe ou dono visualiza clientes" ON public.clientes
  FOR SELECT USING (
    public.is_admin_or_operator() OR (auth_user_id IS NOT NULL AND auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Equipe gerencia clientes" ON public.clientes;
CREATE POLICY "Equipe gerencia clientes" ON public.clientes
  FOR ALL USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

GRANT SELECT, INSERT, UPDATE ON public.clientes TO service_role, authenticated;

-- --------------------------------------------------------------------------
-- 2. VÍNCULO COMERCIAL CANÔNICO EM PEDIDOS & BACKFILL IDEMPOTENTE
-- --------------------------------------------------------------------------
ALTER TABLE public.pedidos 
  ADD COLUMN IF NOT EXISTS cliente_id_rel BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id_rel 
  ON public.pedidos(cliente_id_rel);

-- Backfill idempotente de profiles existentes para a tabela clientes
DO $$
DECLARE
  r RECORD;
  v_tel_norm TEXT;
  v_cid BIGINT;
BEGIN
  FOR r IN SELECT id, nome, email, telefone, cpf, endereco, numero, complemento, cep FROM public.profiles LOOP
    v_tel_norm := regexp_replace(COALESCE(r.telefone, ''), '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    -- Inserir ou reaproveitar cliente
    IF v_tel_norm IS NOT NULL THEN
      INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email, cpf, endereco_padrao)
      VALUES (
        r.id,
        r.nome,
        r.telefone,
        v_tel_norm,
        r.email,
        r.cpf,
        jsonb_build_object('endereco', r.endereco, 'numero', r.numero, 'complemento', r.complemento, 'cep', r.cep)
      )
      ON CONFLICT (telefone_normalizado) WHERE telefone_normalizado IS NOT NULL AND telefone_normalizado <> ''
      DO UPDATE SET auth_user_id = COALESCE(public.clientes.auth_user_id, EXCLUDED.auth_user_id)
      RETURNING id INTO v_cid;
    ELSE
      INSERT INTO public.clientes (auth_user_id, nome, telefone, email, cpf, endereco_padrao)
      VALUES (
        r.id,
        r.nome,
        r.telefone,
        r.email,
        r.cpf,
        jsonb_build_object('endereco', r.endereco, 'numero', r.numero, 'complemento', r.complemento, 'cep', r.cep)
      )
      ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
      DO NOTHING
      RETURNING id INTO v_cid;
    END IF;

    IF v_cid IS NOT NULL THEN
      UPDATE public.pedidos 
      SET cliente_id_rel = v_cid 
      WHERE cliente_id = r.id AND cliente_id_rel IS NULL;
    END IF;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 3. SNAPSHOTS DE CARGA PRODUTIVA EM PRODUTOS, OPÇÕES E ITENS
-- --------------------------------------------------------------------------
ALTER TABLE public.produtos 
  ADD COLUMN IF NOT EXISTS pontos_producao NUMERIC(6,2) NOT NULL DEFAULT 1.00;

ALTER TABLE public.produto_opcoes 
  ADD COLUMN IF NOT EXISTS pontos_producao_adicionais NUMERIC(6,2) NOT NULL DEFAULT 0.00;

ALTER TABLE public.pedido_itens 
  ADD COLUMN IF NOT EXISTS pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00;

ALTER TABLE public.pedido_item_opcoes 
  ADD COLUMN IF NOT EXISTS produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL;

ALTER TABLE public.pedido_item_opcoes 
  ADD COLUMN IF NOT EXISTS pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00;

-- --------------------------------------------------------------------------
-- 4. CAPACIDADE DIÁRIA DE PRODUÇÃO (ÂNCORA SERIALIZÁVEL)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capacidade_producao (
  id BIGSERIAL PRIMARY KEY,
  data DATE NOT NULL UNIQUE,
  capacidade_maxima_pontos NUMERIC(8,2) NOT NULL DEFAULT 30.00,
  bloqueado BOOLEAN NOT NULL DEFAULT false,
  motivo_bloqueio TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capacidade_data 
  ON public.capacidade_producao(data);

ALTER TABLE public.capacidade_producao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capacidade_producao FROM PUBLIC, anon;

DROP POLICY IF EXISTS "Equipe visualiza capacidade" ON public.capacidade_producao;
CREATE POLICY "Equipe visualiza capacidade" ON public.capacidade_producao
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam capacidade" ON public.capacidade_producao;
CREATE POLICY "Admins gerenciam capacidade" ON public.capacidade_producao
  FOR ALL USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT ON public.capacidade_producao TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.capacidade_producao TO service_role;

-- --------------------------------------------------------------------------
-- 5. TRIGGER RECALCULAR_FINANCEIRO_PEDIDO ATUALIZADO (CONFIRMAÇÃO & GUARDA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_ped_id BIGINT := COALESCE(NEW.pedido_id, OLD.pedido_id);
  v_total NUMERIC(10,2);
  v_sinal_minimo NUMERIC(10,2);
  v_status_com_antigo TEXT;
  v_status_oper_antigo TEXT;
  v_pago NUMERIC(10,2);
  v_saldo NUMERIC(10,2);
  v_status_fin_antigo TEXT;
  v_novo_status_fin TEXT;
  v_novo_status_com TEXT;
  v_tem_estorno BOOLEAN := false;
BEGIN
  SELECT 
    total, sinal_minimo, status_comercial, status_operacional, status_financeiro 
  INTO 
    v_total, v_sinal_minimo, v_status_com_antigo, v_status_oper_antigo, v_status_fin_antigo 
  FROM public.pedidos 
  WHERE id = v_ped_id;
  
  -- Soma estritamente pagamentos aprovados
  SELECT COALESCE(SUM(valor), 0) INTO v_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = v_ped_id AND status = 'aprovado';

  v_saldo := GREATEST(0, COALESCE(v_total, 0) - v_pago);

  -- Verifica se existem pagamentos com status 'estornado'
  SELECT EXISTS (
    SELECT 1 FROM public.pedido_pagamentos 
    WHERE pedido_id = v_ped_id AND status = 'estornado'
  ) INTO v_tem_estorno;

  -- Transição determinística do status financeiro
  IF v_tem_estorno AND v_pago <= 0 THEN
    v_novo_status_fin := 'estornado';
  ELSIF v_pago <= 0 THEN
    v_novo_status_fin := 'nao_pago';
  ELSIF v_saldo <= 0 THEN
    v_novo_status_fin := 'pago';
  ELSE
    v_novo_status_fin := 'parcialmente_pago';
  END IF;

  v_novo_status_com := v_status_com_antigo;

  -- Regra 1: Confirmação Automática por Sinal Posterior
  IF v_sinal_minimo > 0 AND v_pago >= v_sinal_minimo AND v_status_com_antigo = 'aguardando_confirmacao' THEN
    v_novo_status_com := 'confirmado';
  END IF;

  -- Regra 2: Guarda de Produção em caso de Estorno do Sinal
  IF v_sinal_minimo > 0 AND v_pago < v_sinal_minimo THEN
    IF v_status_oper_antigo = 'aguardando_producao' AND v_status_com_antigo = 'confirmado' THEN
      -- Antes da produção: reverte para aguardando_confirmacao
      v_novo_status_com := 'aguardando_confirmacao';
    ELSE
      -- Durante/após produção ou se já concluído: NÃO regride status_comercial
      v_novo_status_com := v_status_com_antigo;
    END IF;
  END IF;

  UPDATE public.pedidos
  SET 
    valor_pago = v_pago,
    saldo = v_saldo,
    status_financeiro = v_novo_status_fin,
    status_comercial = v_novo_status_com,
    possui_estorno = v_tem_estorno,
    updated_at = NOW()
  WHERE id = v_ped_id;

  -- Lançamento contábil compensatório no financeiro ao estornar pagamento aprovado (idempotência estrutural garantida)
  IF TG_OP = 'UPDATE' AND OLD.status = 'aprovado' AND NEW.status = 'estornado' THEN
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      origem_tipo,
      origem_id,
      evento,
      observacoes
    ) VALUES (
      'despesa',
      'Estornos',
      'Estorno de Pagamento #' || NEW.id || ' do Pedido #' || v_ped_id || ' (' || upper(NEW.metodo) || ')',
      NEW.valor,
      CURRENT_DATE,
      NEW.metodo,
      v_ped_id,
      'pedido_pagamento',
      NEW.id,
      'estorno',
      'Estorno financeiro contábil automático via pedido_pagamentos #' || NEW.id
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- Auditoria se o status financeiro mudou
  IF v_status_fin_antigo IS DISTINCT FROM v_novo_status_fin THEN
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, 
      usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      v_ped_id,
      'financeiro',
      COALESCE(v_status_fin_antigo, 'nao_pago'),
      v_novo_status_fin,
      auth.uid(),
      'Sistema / Trigger Financeiro',
      CASE 
        WHEN auth.role() = 'service_role' THEN 'sistema'
        WHEN public.is_admin_or_operator() THEN 'admin'
        ELSE 'sistema'
      END,
      jsonb_build_object(
        'motivo', 'Recálculo automático via pedido_pagamentos',
        'valor_pago', v_pago,
        'saldo', v_saldo,
        'tem_estorno', v_tem_estorno
      )
    );
  END IF;

  -- Auditoria se o status comercial mudou automaticamente pelo sinal
  IF v_status_com_antigo IS DISTINCT FROM v_novo_status_com THEN
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, 
      usuario_id, usuario_nome, origem, metadata
    ) VALUES (
      v_ped_id,
      'comercial',
      v_status_com_antigo,
      v_novo_status_com,
      auth.uid(),
      'Sistema / Gatilho de Sinal',
      'sistema',
      jsonb_build_object(
        'motivo', CASE 
          WHEN v_novo_status_com = 'confirmado' THEN 'Sinal mínimo atingido por pagamento acumulado'
          ELSE 'Estorno de sinal reduziu valor pago abaixo do mínimo antes do início da produção'
        END,
        'valor_pago', v_pago,
        'sinal_minimo', v_sinal_minimo
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- --------------------------------------------------------------------------
-- 6. RPC BUSCAR_CLIENTES_ADMIN (AUTOCOMPLETE LEVE & PROTEGIDO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_clientes_admin(
  p_busca TEXT,
  p_limite INT DEFAULT 10
)
RETURNS JSON AS $$
DECLARE
  v_termo TEXT := TRIM(COALESCE(p_busca, ''));
  v_termo_norm TEXT;
  v_resultados JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas equipe autorizada pode consultar clientes.');
  END IF;

  IF length(v_termo) < 2 THEN
    RETURN json_build_object('success', true, 'clientes', '[]'::jsonb);
  END IF;

  v_termo_norm := regexp_replace(v_termo, '\D', '', 'g');

  SELECT jsonb_agg(sub) INTO v_resultados
  FROM (
    SELECT 
      c.id,
      c.nome,
      c.telefone,
      c.telefone_normalizado,
      c.email,
      c.endereco_padrao,
      (
        SELECT MAX(p.data_pedido) 
        FROM public.pedidos p 
        WHERE p.cliente_id_rel = c.id
      ) AS ultima_compra_data,
      (
        SELECT COUNT(*) 
        FROM public.pedidos p 
        WHERE p.cliente_id_rel = c.id
      ) AS total_pedidos
    FROM public.clientes c
    WHERE 
      LOWER(c.nome) LIKE '%' || LOWER(v_termo) || '%'
      OR (v_termo_norm <> '' AND c.telefone_normalizado LIKE '%' || v_termo_norm || '%')
      OR (c.email IS NOT NULL AND LOWER(c.email) LIKE '%' || LOWER(v_termo) || '%')
    ORDER BY c.updated_at DESC
    LIMIT LEAST(GREATEST(p_limite, 1), 20)
  ) sub;

  RETURN json_build_object(
    'success', true,
    'clientes', COALESCE(v_resultados, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.buscar_clientes_admin(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_admin(TEXT, INT) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. RPC CRIAR_ENCOMENDA_ADMIN (BALCÃO / WHATSAPP / TELEFONE)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.criar_encomenda_admin(
  p_cliente_id BIGINT DEFAULT NULL,
  p_cliente_nome TEXT DEFAULT NULL,
  p_cliente_telefone TEXT DEFAULT NULL,
  p_cliente_email TEXT DEFAULT NULL,
  p_canal TEXT DEFAULT 'balcao',
  p_data_entrega DATE DEFAULT NULL,
  p_hora_entrega TIME DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'retirada',
  p_endereco_entrega TEXT DEFAULT NULL,
  p_itens JSONB DEFAULT '[]'::jsonb,
  p_taxa_entrega NUMERIC DEFAULT 0.00,
  p_desconto NUMERIC DEFAULT 0.00,
  p_motivo_desconto TEXT DEFAULT NULL,
  p_sinal_minimo NUMERIC DEFAULT 0.00,
  p_sinal_valor NUMERIC DEFAULT 0.00,
  p_sinal_metodo TEXT DEFAULT 'pix',
  p_sinal_comprovante TEXT DEFAULT NULL,
  p_saldo_vencimento DATE DEFAULT NULL,
  p_forcar_confirmacao_sem_sinal BOOLEAN DEFAULT false,
  p_motivo_confirmacao_sem_sinal TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL,
  p_observacoes_cliente TEXT DEFAULT NULL,
  p_observacoes_internas TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_user_nome TEXT;
  v_cliente_id_final BIGINT;
  v_tel_norm TEXT;
  v_canal_norm TEXT;
  v_modalidade_norm TEXT;
  v_taxa NUMERIC(10,2) := 0.00;
  v_desconto NUMERIC(10,2) := 0.00;
  v_sinal_min NUMERIC(10,2) := 0.00;
  v_sinal_pago NUMERIC(10,2) := 0.00;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_opcao RECORD;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_pts_pedido_total NUMERIC(8,2) := 0.00;
  v_cap RECORD;
  v_pontos_ocupados_atuais NUMERIC(8,2) := 0.00;
  v_status_com_inicial TEXT;
  v_status_fin_inicial TEXT := 'nao_pago';
  v_status_oper_inicial TEXT := 'aguardando_producao';
  v_pedido_id BIGINT;
  v_item_id BIGINT;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_itens_json_canonical JSONB := '[]'::jsonb;
  v_pagamento_id BIGINT;
BEGIN
  -- 1. Validação de RBAC
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem lançar encomendas.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 2. Validações de Canal e Data
  v_canal_norm := LOWER(TRIM(COALESCE(p_canal, 'balcao')));
  IF v_canal_norm NOT IN ('balcao', 'whatsapp', 'telefone') THEN
    RETURN json_build_object('success', false, 'error', 'Canal de encomenda inválido. Use balcao, whatsapp ou telefone.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  -- 3. Validações de Modalidade e Entrega
  v_modalidade_norm := LOWER(TRIM(COALESCE(p_modalidade, 'retirada')));
  IF v_modalidade_norm = 'retirada' THEN
    v_taxa := 0.00;
  ELSIF v_modalidade_norm = 'entrega' THEN
    IF p_endereco_entrega IS NULL OR length(TRIM(p_endereco_entrega)) < 5 THEN
      RETURN json_build_object('success', false, 'error', 'Para entrega em domicílio, o endereço completo é obrigatório.');
    END IF;
    v_taxa := GREATEST(0.00, COALESCE(p_taxa_entrega, 0.00));
  ELSE
    RETURN json_build_object('success', false, 'error', 'Modalidade de entrega inválida. Use retirada ou entrega.');
  END IF;

  -- 4. Resolução ou Cadastro de Cliente em public.clientes
  v_cliente_id_final := p_cliente_id;
  IF v_cliente_id_final IS NOT NULL THEN
    SELECT id INTO v_cliente_id_final FROM public.clientes WHERE id = p_cliente_id;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF p_cliente_nome IS NULL OR length(TRIM(p_cliente_nome)) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Nome do cliente é obrigatório para registrar a encomenda.');
    END IF;

    v_tel_norm := regexp_replace(COALESCE(p_cliente_telefone, ''), '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id INTO v_cliente_id_final FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (
        nome, telefone, telefone_normalizado, email, endereco_padrao
      ) VALUES (
        TRIM(p_cliente_nome),
        TRIM(p_cliente_telefone),
        v_tel_norm,
        TRIM(p_cliente_email),
        CASE WHEN p_endereco_entrega IS NOT NULL THEN jsonb_build_object('endereco', p_endereco_entrega) ELSE '{}'::jsonb END
      ) RETURNING id INTO v_cliente_id_final;
    END IF;
  END IF;

  -- 5. Validação dos Itens e Pré-Cálculo de Subtotal e Pontos
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'A encomenda precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, opcoes, ativo, pontos_producao 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Produto #' || v_prod_id || ' não está disponível no cardápio.');
    END IF;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    -- Pré-validação Fail-Closed de opções
    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF NOT FOUND THEN
            -- Compatibilidade legada com produtos.opcoes
            IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
              v_preco_opt := 0.00;
            ELSE
              RETURN json_build_object(
                'success', false,
                'code', 'INVALID_PRODUCT_OPTION',
                'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '".',
                'produto_id', v_prod.id,
                'opcao', v_opcao_nome
              );
            END IF;
          ELSE
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;

          v_subtotal := v_subtotal + (v_preco_opt * v_qtd);
        END IF;
      END LOOP;
    END IF;

    v_subtotal := v_subtotal + (v_prod.preco * v_qtd);
    v_pts_pedido_total := v_pts_pedido_total + ((v_pts_prod + v_pts_opt_total) * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 6. Política Rigorosa de Descontos
  v_desconto := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  IF v_desconto > v_subtotal THEN
    RETURN json_build_object('success', false, 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  IF v_desconto > (v_subtotal * 0.10) AND NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false, 
      'error', 'Operadores podem conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10)::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  IF v_desconto > 0 AND public.is_admin() AND (p_motivo_desconto IS NULL OR length(TRIM(p_motivo_desconto)) < 3) THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do desconto concedido.');
  END IF;

  v_total := (v_subtotal - v_desconto) + v_taxa;

  -- 7. Trava Concorrente de Capacidade Produtiva (Anti-Overbooking)
  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (p_data_entrega, 30.00)
  ON CONFLICT (data) DO NOTHING;

  SELECT * INTO v_cap
  FROM public.capacidade_producao
  WHERE data = p_data_entrega
  FOR UPDATE;

  -- Carga ocupada calculada estritamente sobre os snapshots dos pedidos reais não cancelados
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  INTO v_pontos_ocupados_atuais
  FROM public.pedidos ped
  JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE ped.data_entrega = p_data_entrega
    AND ped.status_comercial <> 'cancelado';

  IF v_cap.bloqueado = true OR (v_pontos_ocupados_atuais + v_pts_pedido_total) > v_cap.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      -- Permissão especial de Admin para encaixe justificado
      NULL;
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_data_entrega,
        'capacidade_maxima', v_cap.capacidade_maxima_pontos,
        'pontos_ocupados', v_pontos_ocupados_atuais,
        'pontos_solicitados', v_pts_pedido_total,
        'error', 'Capacidade de produção excedida para ' || p_data_entrega || ' (' || v_pontos_ocupados_atuais || '/' || v_cap.capacidade_maxima_pontos || ' pts ocupados). Requer autorização de Administrador para encaixe extraordinário.'
      );
    END IF;
  END IF;

  -- 8. Definição da Matriz de Estados Iniciais
  v_sinal_min := GREATEST(0.00, COALESCE(p_sinal_minimo, 0.00));
  v_sinal_pago := GREATEST(0.00, COALESCE(p_sinal_valor, 0.00));

  IF v_sinal_pago > v_total THEN
    RETURN json_build_object('success', false, 'error', 'Valor do sinal informado excede o total da encomenda.');
  END IF;

  -- Governança de confirmar sem sinal
  IF p_forcar_confirmacao_sem_sinal = true THEN
    IF NOT public.is_admin() THEN
      RETURN json_build_object('success', false, 'error', 'Apenas Administradores podem dispensar a exigência de sinal mínimo.');
    END IF;
    IF p_motivo_confirmacao_sem_sinal IS NULL OR length(TRIM(p_motivo_confirmacao_sem_sinal)) < 3 THEN
      RETURN json_build_object('success', false, 'error', 'Informe o motivo para autorizar a confirmação da encomenda sem sinal.');
    END IF;
  END IF;

  IF v_sinal_min = 0.00 OR p_forcar_confirmacao_sem_sinal = true OR (v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00) THEN
    v_status_com_inicial := 'confirmado';
  ELSE
    v_status_com_inicial := 'aguardando_confirmacao';
  END IF;

  -- 9. Inserção do Pedido
  INSERT INTO public.pedidos (
    cliente_id_rel,
    nome_cliente,
    telefone_cliente,
    email_cliente,
    data_pedido,
    data_entrega,
    hora_entrega,
    subtotal,
    desconto,
    total,
    taxa_entrega,
    valor_pago,
    saldo,
    sinal_minimo,
    saldo_vencimento,
    modalidade_entrega,
    canal,
    pagamento,
    status_comercial,
    status_financeiro,
    status_operacional,
    status,
    itens,
    endereco_entrega,
    observacoes_cliente,
    observacoes_internas
  ) VALUES (
    v_cliente_id_final,
    TRIM(p_cliente_nome),
    TRIM(p_cliente_telefone),
    COALESCE(TRIM(p_cliente_email), 'balcao@lunocadoceria.com.br'),
    CURRENT_DATE,
    p_data_entrega,
    p_hora_entrega,
    v_subtotal,
    v_desconto,
    v_total,
    v_taxa,
    0.00,
    v_total,
    v_sinal_min,
    p_saldo_vencimento,
    v_modalidade_norm,
    v_canal_norm,
    LOWER(TRIM(COALESCE(p_sinal_metodo, 'pix'))),
    v_status_com_inicial,
    v_status_fin_inicial,
    v_status_oper_inicial,
    'Pendente',
    array_to_string(v_nomes_itens, ' + '),
    COALESCE(p_endereco_entrega, 'Retirada no Balcão'),
    p_observacoes_cliente,
    p_observacoes_internas
  ) RETURNING id INTO v_pedido_id;

  -- 10. Gravação Canônica em pedido_itens e pedido_item_opcoes com Snapshots de Pontos
  FOR v_item IN 
    SELECT 
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, pontos_producao 
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);

    INSERT INTO public.pedido_itens (
      pedido_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      unidade,
      preco_base_snapshot,
      preco_adicionais,
      preco_unitario_snapshot,
      subtotal,
      pontos_producao_snapshot
    ) VALUES (
      v_pedido_id,
      v_prod.id,
      v_prod.nome,
      v_qtd,
      'un',
      v_prod.preco,
      0.00,
      v_prod.preco,
      (v_prod.preco * v_qtd),
      v_pts_prod
    ) RETURNING id INTO v_item_id;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, categoria, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id,
              produto_opcao_id,
              tipo,
              opcao_nome,
              preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id,
              v_opt_rec.id,
              v_opt_rec.categoria,
              v_opcao_nome,
              COALESCE(v_opt_rec.preco_adicional, 0.00),
              COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
          ELSE
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id,
              tipo,
              opcao_nome,
              preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id,
              'outro',
              v_opcao_nome,
              0.00,
              0.00
            );
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- 11. Entrada/Sinal via Fluxo Canônico de Pagamentos (Trigger Recalcula Saldo & DRE)
  IF v_sinal_pago > 0 THEN
    INSERT INTO public.pedido_pagamentos (
      pedido_id,
      valor,
      metodo,
      provider,
      provider_payment_id,
      status,
      pago_em,
      registrado_por,
      comprovante_url,
      observacoes
    ) VALUES (
      v_pedido_id,
      v_sinal_pago,
      LOWER(TRIM(p_sinal_metodo)),
      'manual',
      NULL,
      'aprovado',
      NOW(),
      auth.uid(),
      p_sinal_comprovante,
      'Entrada/Sinal registrado no ato da encomenda (' || upper(v_canal_norm) || ')'
    ) RETURNING id INTO v_pagamento_id;

    -- Lançamento financeiro com idempotência estrutural
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      origem_tipo,
      origem_id,
      evento,
      observacoes
    ) VALUES (
      'receita',
      'Vendas',
      'Entrada Encomenda #' || v_pedido_id || ' (' || TRIM(p_cliente_nome) || ')',
      v_sinal_pago,
      CURRENT_DATE,
      LOWER(TRIM(p_sinal_metodo)),
      v_pedido_id,
      'pedido_pagamento',
      v_pagamento_id,
      'recebimento',
      'Entrada de encomenda via canal ' || v_canal_norm
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 12. Auditoria em pedido_status_historico
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    v_pedido_id,
    'comercial',
    'novo',
    v_status_com_inicial,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'canal', v_canal_norm,
      'desconto', v_desconto,
      'motivo_desconto', p_motivo_desconto,
      'sinal_minimo', v_sinal_min,
      'sinal_pago', v_sinal_pago,
      'confirmado_sem_sinal', p_forcar_confirmacao_sem_sinal,
      'motivo_confirmacao_sem_sinal', p_motivo_confirmacao_sem_sinal,
      'pontos_carga', v_pts_pedido_total,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe
    )
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'cliente_id', v_cliente_id_final,
    'total', v_total,
    'status_comercial', v_status_com_inicial,
    'status_financeiro', CASE WHEN v_sinal_pago >= v_total THEN 'pago' WHEN v_sinal_pago > 0 THEN 'parcialmente_pago' ELSE 'nao_pago' END,
    'pontos_carga', v_pts_pedido_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. RPC REAGENDAR_ENCOMENDA_ADMIN (PREVENÇÃO DE DEADLOCK & INICIALIZAÇÃO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reagendar_encomenda_admin(
  p_pedido_id BIGINT,
  p_nova_data DATE,
  p_nova_hora TIME DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_user_nome TEXT;
  v_data_antiga DATE;
  v_primeira_data DATE;
  v_segunda_data DATE;
  v_cap_nova RECORD;
  v_pts_pedido NUMERIC(8,2) := 0.00;
  v_pts_ocupados_nova NUMERIC(8,2) := 0.00;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas equipe autorizada pode reagendar encomendas.');
  END IF;

  IF p_pedido_id IS NULL OR p_nova_data IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido e nova data são obrigatórios.');
  END IF;

  IF p_motivo IS NULL OR length(TRIM(p_motivo)) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do reagendamento.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Encomenda não encontrada.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN json_build_object('success', false, 'error', 'Não é possível reagendar uma encomenda cancelada.');
  END IF;

  v_data_antiga := v_ped.data_entrega;
  IF v_data_antiga = p_nova_data AND (p_nova_hora IS NULL OR v_ped.hora_entrega = p_nova_hora) THEN
    RETURN json_build_object('success', true, 'message', 'A encomenda já estava agendada para este horário.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- Calcula os pontos desta encomenda usando seus snapshots imutáveis
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 1.00)
  INTO v_pts_pedido
  FROM public.pedido_itens pi
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE pi.pedido_id = p_pedido_id;

  -- 1. Ordenação determinística de datas para evitar deadlocks
  v_primeira_data := LEAST(v_data_antiga, p_nova_data);
  v_segunda_data := GREATEST(v_data_antiga, p_nova_data);

  -- 2. Inicialização concorrente segura das duas datas antes dos locks
  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (v_primeira_data, 30.00), (v_segunda_data, 30.00)
  ON CONFLICT (data) DO NOTHING;

  -- 3. Locks pessimistas ordenados
  PERFORM 1 FROM public.capacidade_producao WHERE data = v_primeira_data FOR UPDATE;
  PERFORM 1 FROM public.capacidade_producao WHERE data = v_segunda_data FOR UPDATE;

  SELECT * INTO v_cap_nova FROM public.capacidade_producao WHERE data = p_nova_data;

  -- 4. Cálculo da carga ocupada na nova data (excluindo este próprio pedido)
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  INTO v_pts_ocupados_nova
  FROM public.pedidos ped
  JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE ped.data_entrega = p_nova_data
    AND ped.id <> p_pedido_id
    AND ped.status_comercial <> 'cancelado';

  IF v_cap_nova.bloqueado = true OR (v_pts_ocupados_nova + v_pts_pedido) > v_cap_nova.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      NULL;
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_nova_data,
        'capacidade_maxima', v_cap_nova.capacidade_maxima_pontos,
        'pontos_ocupados', v_pts_ocupados_nova,
        'pontos_solicitados', v_pts_pedido,
        'error', 'Capacidade de produção excedida para a nova data ' || p_nova_data || ' (' || v_pts_ocupados_nova || '/' || v_cap_nova.capacidade_maxima_pontos || ' pts ocupados).'
      );
    END IF;
  END IF;

  -- 5. Atualização da Encomenda
  UPDATE public.pedidos
  SET 
    data_entrega = p_nova_data,
    hora_entrega = COALESCE(p_nova_hora, hora_entrega),
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- 6. Histórico auditável
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    'operacional',
    v_data_antiga::TEXT,
    p_nova_data::TEXT,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object(
      'acao', 'reagendamento',
      'data_anterior', v_data_antiga,
      'data_nova', p_nova_data,
      'hora_nova', p_nova_hora,
      'motivo', p_motivo,
      'pontos_carga', v_pts_pedido,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe
    )
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'data_anterior', v_data_antiga,
    'data_nova', p_nova_data,
    'pontos_carga', v_pts_pedido
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reagendar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reagendar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC OBTER_RESUMO_OPERACAO_HOJE (VIA LEDGER CONTÁBIL & AMERICA/FORTALEZA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_resumo_operacao_hoje()
RETURNS JSON AS $$
DECLARE
  v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
  v_encomendas_qtd INT := 0;
  v_valor_encomendas NUMERIC(10,2) := 0.00;
  v_saldo_encomendas NUMERIC(10,2) := 0.00;
  v_recebido_caixa NUMERIC(10,2) := 0.00;
  v_estornos_caixa NUMERIC(10,2) := 0.00;
  v_caixa_liquido NUMERIC(10,2) := 0.00;
  v_entregas_qtd INT := 0;
  v_retiradas_qtd INT := 0;
  v_pendentes_sinal_qtd INT := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  -- 1. Encomendas do Dia (data de entrega hoje e não canceladas)
  SELECT 
    COUNT(*),
    COALESCE(SUM(total), 0.00),
    COALESCE(SUM(saldo), 0.00),
    COUNT(*) FILTER (WHERE modalidade_entrega = 'entrega'),
    COUNT(*) FILTER (WHERE modalidade_entrega = 'retirada'),
    COUNT(*) FILTER (WHERE status_comercial = 'aguardando_confirmacao' AND sinal_minimo > 0)
  INTO 
    v_encomendas_qtd,
    v_valor_encomendas,
    v_saldo_encomendas,
    v_entregas_qtd,
    v_retiradas_qtd,
    v_pendentes_sinal_qtd
  FROM public.pedidos
  WHERE data_entrega = v_hoje
    AND status_comercial <> 'cancelado';

  -- 2. Movimentação Real do Caixa Hoje via Ledger Contábil (financeiro_lancamentos)
  SELECT 
    COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0.00),
    COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND categoria = 'Estornos'), 0.00)
  INTO 
    v_recebido_caixa,
    v_estornos_caixa
  FROM public.financeiro_lancamentos
  WHERE data_lancamento = v_hoje;

  v_caixa_liquido := v_recebido_caixa - v_estornos_caixa;

  RETURN json_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'fuso_horario', 'America/Fortaleza',
    'encomendas_hoje_qtd', v_encomendas_qtd,
    'valor_encomendas_hoje', v_valor_encomendas,
    'saldo_encomendas_hoje', v_saldo_encomendas,
    'recebimentos_caixa_hoje', v_recebido_caixa,
    'estornos_caixa_hoje', v_estornos_caixa,
    'caixa_liquido_hoje', v_caixa_liquido,
    'entregas_hoje_qtd', v_entregas_qtd,
    'retiradas_hoje_qtd', v_retiradas_qtd,
    'pendentes_sinal_qtd', v_pendentes_sinal_qtd
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_resumo_operacao_hoje FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_resumo_operacao_hoje TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10. RPC OBTER_AGENDA_ENCOMENDAS (COM CAPACIDADE DERIVADA DINÂMICA)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_agenda_encomendas(
  p_inicio DATE,
  p_fim DATE
)
RETURNS JSON AS $$
DECLARE
  v_inicio DATE := COALESCE(p_inicio, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);
  v_fim DATE := COALESCE(p_fim, (v_inicio + INTERVAL '30 days')::DATE);
  v_resultados JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  SELECT jsonb_agg(sub) INTO v_resultados
  FROM (
    SELECT 
      d.data,
      COALESCE(ped_stats.total_pedidos, 0) AS total_pedidos,
      COALESCE(ped_stats.valor_total, 0.00) AS valor_total,
      COALESCE(ped_stats.pontos_ocupados, 0.00) AS pontos_ocupados,
      COALESCE(cap.capacidade_maxima_pontos, 30.00) AS capacidade_maxima,
      COALESCE(cap.bloqueado, false) AS bloqueado,
      cap.motivo_bloqueio
    FROM generate_series(v_inicio, v_fim, INTERVAL '1 day') AS d(data)
    LEFT JOIN public.capacidade_producao cap ON cap.data = d.data::DATE
    LEFT JOIN (
      SELECT 
        ped.data_entrega,
        COUNT(*) AS total_pedidos,
        SUM(ped.total) AS valor_total,
        SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))) AS pontos_ocupados
      FROM public.pedidos ped
      JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
      LEFT JOIN (
        SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) as pts_adicionais
        FROM public.pedido_item_opcoes
        GROUP BY pedido_item_id
      ) opt_pts ON opt_pts.pedido_item_id = pi.id
      WHERE ped.data_entrega BETWEEN v_inicio AND v_fim
        AND ped.status_comercial <> 'cancelado'
      GROUP BY ped.data_entrega
    ) ped_stats ON ped_stats.data_entrega = d.data::DATE
    ORDER BY d.data ASC
  ) sub;

  RETURN json_build_object(
    'success', true,
    'inicio', v_inicio,
    'fim', v_fim,
    'dias', COALESCE(v_resultados, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) TO authenticated, service_role;


-- ==========================================================================
-- >>> MIGRATION 011_etapa2_fechamento_concorrencia.sql
-- ==========================================================================

-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 011
-- ETAPA 2 - FECHAMENTO DEFINITIVO & CONCORRÊNCIA COMPLETA
-- ==========================================================================
-- Decisões arquiteturais consolidadas (ver docs/ARQUITETURA_ETAPA2.md):
--
--   RESERVA DE ESTOQUE ...... Opção A: criar_encomenda_admin reserva estoque quando
--                             produtos.controlar_estoque = true. O ciclo de vida da
--                             reserva é controlado por pedido_itens.reserva_estoque_ativa.
--                             Liberação e recriação passam OBRIGATORIAMENTE pela flag.
--   EXPIRAÇÃO ............... Pipeline único: expirar_pedidos_e_holds() atende PIX da
--                             loja (expires_at) e holds de encomenda (confirmacao_expires_at).
--                             liberar_pedidos_expirados() vira wrapper de compatibilidade.
--   ESTORNO ................. Reutiliza estornar_pagamento_pedido() (fluxo canônico).
--   OVERRIDE ................ Admin pode forçar CAPACIDADE; NUNCA estoque inexistente.
--   CANCELAMENTO C/ VALOR ... Apenas RETENCAO_CANCELAMENTO nesta etapa.
--   ORDEM GLOBAL DE LOCKS ... pedido -> capacidade/data -> produtos (id ASC)
--                             -> itens/reservas -> pagamentos/efeitos financeiros.
--                             Fluxos sem pedido ainda existente (criação): capacidade ->
--                             produtos (id ASC) -> INSERT pedido -> itens -> pagamentos.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. CONFIGURAÇÕES OPERACIONAIS (SINGLETON) & TIMEZONE DINÂMICO
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.configuracoes_operacao (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sinal_percentual_padrao NUMERIC(5,2) NOT NULL DEFAULT 50.00 CHECK (sinal_percentual_padrao BETWEEN 0 AND 100),
  hold_horas_padrao INT NOT NULL DEFAULT 24 CHECK (hold_horas_padrao > 0),
  antecedencia_confirmacao_horas INT NOT NULL DEFAULT 2 CHECK (antecedencia_confirmacao_horas >= 0),
  hold_pix_loja_minutos INT NOT NULL DEFAULT 30 CHECK (hold_pix_loja_minutos > 0),
  capacidade_padrao_pontos NUMERIC(8,2) NOT NULL DEFAULT 30.00 CHECK (capacidade_padrao_pontos > 0),
  timezone TEXT NOT NULL DEFAULT 'America/Fortaleza',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.configuracoes_operacao (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.configuracoes_operacao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.configuracoes_operacao FROM PUBLIC, anon;

DROP POLICY IF EXISTS "Equipe visualiza configuracoes_operacao" ON public.configuracoes_operacao;
CREATE POLICY "Equipe visualiza configuracoes_operacao" ON public.configuracoes_operacao
  FOR SELECT USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins atualizam configuracoes_operacao" ON public.configuracoes_operacao;
CREATE POLICY "Admins atualizam configuracoes_operacao" ON public.configuracoes_operacao
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT ON public.configuracoes_operacao TO authenticated, service_role;
GRANT UPDATE ON public.configuracoes_operacao TO authenticated, service_role;

-- Leitura canônica das configurações (sempre retorna uma linha, com defaults seguros)
CREATE OR REPLACE FUNCTION public.obter_config_operacao()
RETURNS public.configuracoes_operacao AS $$
DECLARE
  v_cfg public.configuracoes_operacao;
BEGIN
  SELECT * INTO v_cfg FROM public.configuracoes_operacao WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.id := 1;
    v_cfg.sinal_percentual_padrao := 50.00;
    v_cfg.hold_horas_padrao := 24;
    v_cfg.antecedencia_confirmacao_horas := 2;
    v_cfg.hold_pix_loja_minutos := 30;
    v_cfg.capacidade_padrao_pontos := 30.00;
    v_cfg.timezone := 'America/Fortaleza';
  END IF;
  -- Fail-safe: timezone inválido nunca pode derrubar a operação
  BEGIN
    PERFORM NOW() AT TIME ZONE v_cfg.timezone;
  EXCEPTION WHEN OTHERS THEN
    v_cfg.timezone := 'America/Fortaleza';
  END;
  RETURN v_cfg;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.obter_config_operacao() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_config_operacao() TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 2. COLUNAS DE CICLO DE VIDA DO HOLD, REVISÃO FINANCEIRA E RESERVA POR ITEM
-- --------------------------------------------------------------------------
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS confirmacao_expires_at TIMESTAMPTZ;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS requer_revisao_financeira BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS bloqueado_por_overbooking_tardio BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS cancelado_por_expiracao BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS motivo_revisao_financeira TEXT;

CREATE INDEX IF NOT EXISTS idx_pedidos_requer_revisao
  ON public.pedidos(requer_revisao_financeira) WHERE requer_revisao_financeira = true;

CREATE INDEX IF NOT EXISTS idx_pedidos_hold_pendente
  ON public.pedidos(confirmacao_expires_at)
  WHERE status_comercial = 'aguardando_confirmacao' AND confirmacao_expires_at IS NOT NULL;

-- Flag de ciclo de vida da reserva de estoque por item (fonte da verdade da reserva)
ALTER TABLE public.pedido_itens ADD COLUMN IF NOT EXISTS reserva_estoque_ativa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.pedido_itens ADD COLUMN IF NOT EXISTS reserva_ciclo INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pedido_itens_reserva_ativa
  ON public.pedido_itens(pedido_id) WHERE reserva_estoque_ativa = true;

-- Idempotência estrutural das movimentações de estoque geradas pelo ciclo de reserva
ALTER TABLE public.estoque_movimentacoes ADD COLUMN IF NOT EXISTS pedido_item_id BIGINT REFERENCES public.pedido_itens(id) ON DELETE SET NULL;
ALTER TABLE public.estoque_movimentacoes ADD COLUMN IF NOT EXISTS origem_evento TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_mov_item_evento
  ON public.estoque_movimentacoes(pedido_item_id, origem_evento)
  WHERE pedido_item_id IS NOT NULL AND origem_evento IS NOT NULL;

-- Backfill: pedidos da loja online ainda aguardando pagamento possuem reserva viva
-- criada por criar_pedido(). Marcamos a flag para que o pipeline unificado consiga liberá-la.
UPDATE public.pedido_itens pi
SET reserva_estoque_ativa = true,
    reserva_ciclo = GREATEST(reserva_ciclo, 1)
FROM public.pedidos p
JOIN public.produtos pr ON true
WHERE pi.pedido_id = p.id
  AND pr.id = pi.produto_id
  AND pi.reserva_estoque_ativa = false
  AND pi.reserva_ciclo = 0
  AND p.canal = 'loja_online'
  AND p.status_comercial = 'aguardando_confirmacao'
  AND p.status_financeiro = 'nao_pago'
  AND pr.controlar_estoque IS NOT FALSE;

-- --------------------------------------------------------------------------
-- 3. CARGA PRODUTIVA DERIVADA (DESCONSIDERA HOLDS VENCIDOS)
-- --------------------------------------------------------------------------
-- Um pedido ocupa capacidade quando NÃO está cancelado e NÃO é um hold vencido
-- (aguardando_confirmacao com confirmacao_expires_at no passado).
CREATE OR REPLACE FUNCTION public.pedido_ocupa_capacidade(
  p_status_comercial TEXT,
  p_confirmacao_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN AS $$
  SELECT p_status_comercial IS DISTINCT FROM 'cancelado'
     AND NOT (
       p_status_comercial = 'aguardando_confirmacao'
       AND p_confirmacao_expires_at IS NOT NULL
       AND p_confirmacao_expires_at <= NOW()
     );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.pontos_pedido(p_pedido_id BIGINT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  FROM public.pedido_itens pi
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) AS pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE pi.pedido_id = p_pedido_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.pontos_ocupados_data(
  p_data DATE,
  p_excluir_pedido_id BIGINT DEFAULT NULL
)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)
  FROM public.pedidos ped
  JOIN public.pedido_itens pi ON pi.pedido_id = ped.id
  LEFT JOIN (
    SELECT pedido_item_id, SUM(pontos_producao_adicionais_snapshot) AS pts_adicionais
    FROM public.pedido_item_opcoes
    GROUP BY pedido_item_id
  ) opt_pts ON opt_pts.pedido_item_id = pi.id
  WHERE ped.data_entrega = p_data
    AND (p_excluir_pedido_id IS NULL OR ped.id <> p_excluir_pedido_id)
    AND public.pedido_ocupa_capacidade(ped.status_comercial, ped.confirmacao_expires_at);
$$ LANGUAGE sql STABLE;

-- Garante a linha de capacidade da data e a trava (lock pessimista). Retorna a linha travada.
CREATE OR REPLACE FUNCTION public.travar_capacidade_data(p_data DATE)
RETURNS public.capacidade_producao AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_cap public.capacidade_producao;
BEGIN
  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (p_data, v_cfg.capacidade_padrao_pontos)
  ON CONFLICT (data) DO NOTHING;

  SELECT * INTO v_cap FROM public.capacidade_producao WHERE data = p_data FOR UPDATE;
  RETURN v_cap;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.travar_capacidade_data(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.travar_capacidade_data(DATE) TO service_role;

-- --------------------------------------------------------------------------
-- 4. HELPERS CANÔNICOS DE RESERVA DE ESTOQUE (IDEMPOTENTES VIA FLAG POR ITEM)
-- --------------------------------------------------------------------------
-- Pré-condição de ambos: o chamador já detém o lock do pedido (ou o adquire aqui,
-- de forma reentrante). Produtos são travados em ordem crescente de id.

CREATE OR REPLACE FUNCTION public.reservar_estoque_itens_pedido(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT NULL,
  p_validar_disponibilidade BOOLEAN DEFAULT true
)
RETURNS JSON AS $$
DECLARE
  v_item RECORD;
  v_prod RECORD;
  v_disponivel INT;
  v_faltantes JSONB := '[]'::jsonb;
  v_reservados INT := 0;
  v_ja_ativos INT := 0;
BEGIN
  PERFORM set_config('lunoca.internal_stock_mutation', 'on', true);
  PERFORM 1 FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  -- Lock determinístico dos produtos envolvidos (id ASC)
  PERFORM 1
  FROM public.produtos pr
  WHERE pr.id IN (SELECT produto_id FROM public.pedido_itens WHERE pedido_id = p_pedido_id AND produto_id IS NOT NULL)
  ORDER BY pr.id
  FOR UPDATE;

  -- Fase 1: validação AGREGADA POR PRODUTO (nenhuma escrita antes de saber se tudo cabe).
  -- Linhas distintas do mesmo produto (ex.: 4 + 4 com 5 em estoque) são somadas antes
  -- de comparar com o disponível; validar linha a linha permitiria ultrapassar o estoque.
  IF p_validar_disponibilidade THEN
    FOR v_item IN
      SELECT pi.produto_id,
             SUM(pi.quantidade)::INT AS quantidade,
             MIN(pi.produto_nome_snapshot) AS produto_nome_snapshot
      FROM public.pedido_itens pi
      JOIN public.produtos pr ON pr.id = pi.produto_id
      WHERE pi.pedido_id = p_pedido_id
        AND pr.controlar_estoque IS NOT FALSE
        AND pi.reserva_estoque_ativa = false  -- já reservado: não conta duas vezes
      GROUP BY pi.produto_id
      ORDER BY pi.produto_id
    LOOP
      SELECT estoque_fisico, estoque_reservado INTO v_prod FROM public.produtos WHERE id = v_item.produto_id;
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));
      IF v_disponivel < v_item.quantidade THEN
        v_faltantes := v_faltantes || jsonb_build_object(
          'produto_id', v_item.produto_id,
          'produto', v_item.produto_nome_snapshot,
          'necessario', v_item.quantidade,
          'disponivel', v_disponivel
        );
      END IF;
    END LOOP;

    IF jsonb_array_length(v_faltantes) > 0 THEN
      RETURN json_build_object(
        'success', false,
        'code', 'INSUFFICIENT_STOCK',
        'error', 'Estoque insuficiente para reservar os itens do pedido #' || p_pedido_id || '.',
        'faltantes', v_faltantes
      );
    END IF;
  END IF;

  -- Fase 2: aplicação (somente itens cuja reserva NÃO está ativa)
  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.quantidade, pi.produto_nome_snapshot, pi.reserva_estoque_ativa, pi.reserva_ciclo
    FROM public.pedido_itens pi
    JOIN public.produtos pr ON pr.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
      AND pr.controlar_estoque IS NOT FALSE
    ORDER BY pi.produto_id, pi.id
  LOOP
    IF v_item.reserva_estoque_ativa THEN
      v_ja_ativos := v_ja_ativos + 1;
      CONTINUE;
    END IF;

    UPDATE public.produtos
    SET estoque_reservado = COALESCE(estoque_reservado, 0) + v_item.quantidade,
        updated_at = NOW()
    WHERE id = v_item.produto_id
    RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_disponivel;

    UPDATE public.pedido_itens
    SET reserva_estoque_ativa = true,
        reserva_ciclo = reserva_ciclo + 1
    WHERE id = v_item.id;

    INSERT INTO public.estoque_movimentacoes (
      produto_id, produto_nome, tipo, quantidade, saldo_resultante,
      motivo, pedido_id, pedido_item_id, origem_evento, usuario_nome
    ) VALUES (
      v_item.produto_id,
      v_item.produto_nome_snapshot,
      'reserva',
      v_item.quantidade,
      COALESCE(v_disponivel, 0),
      COALESCE(p_motivo, 'Reserva de estoque para pedido #' || p_pedido_id),
      p_pedido_id,
      v_item.id,
      'reserva#' || (v_item.reserva_ciclo + 1),
      'Sistema / Reserva'
    )
    ON CONFLICT (pedido_item_id, origem_evento) WHERE pedido_item_id IS NOT NULL AND origem_evento IS NOT NULL DO NOTHING;

    v_reservados := v_reservados + 1;
  END LOOP;

  RETURN json_build_object('success', true, 'itens_reservados', v_reservados, 'itens_ja_ativos', v_ja_ativos);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.reservar_estoque_itens_pedido(BIGINT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reservar_estoque_itens_pedido(BIGINT, TEXT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.liberar_estoque_itens_pedido(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_item RECORD;
  v_saldo INT;
  v_liberados INT := 0;
BEGIN
  PERFORM set_config('lunoca.internal_stock_mutation', 'on', true);
  PERFORM 1 FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  PERFORM 1
  FROM public.produtos pr
  WHERE pr.id IN (SELECT produto_id FROM public.pedido_itens WHERE pedido_id = p_pedido_id AND produto_id IS NOT NULL AND reserva_estoque_ativa = true)
  ORDER BY pr.id
  FOR UPDATE;

  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.quantidade, pi.produto_nome_snapshot, pi.reserva_ciclo
    FROM public.pedido_itens pi
    WHERE pi.pedido_id = p_pedido_id
      AND pi.reserva_estoque_ativa = true
      AND pi.produto_id IS NOT NULL
    ORDER BY pi.produto_id, pi.id
  LOOP
    UPDATE public.produtos
    SET estoque_reservado = GREATEST(0, COALESCE(estoque_reservado, 0) - v_item.quantidade),
        updated_at = NOW()
    WHERE id = v_item.produto_id
    RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_saldo;

    UPDATE public.pedido_itens
    SET reserva_estoque_ativa = false
    WHERE id = v_item.id;

    INSERT INTO public.estoque_movimentacoes (
      produto_id, produto_nome, tipo, quantidade, saldo_resultante,
      motivo, pedido_id, pedido_item_id, origem_evento, usuario_nome
    ) VALUES (
      v_item.produto_id,
      v_item.produto_nome_snapshot,
      'ajuste',
      v_item.quantidade,
      COALESCE(v_saldo, 0),
      COALESCE(p_motivo, 'Liberação de reserva do pedido #' || p_pedido_id),
      p_pedido_id,
      v_item.id,
      'liberacao#' || v_item.reserva_ciclo,
      'Sistema / Liberação de Reserva'
    )
    ON CONFLICT (pedido_item_id, origem_evento) WHERE pedido_item_id IS NOT NULL AND origem_evento IS NOT NULL DO NOTHING;

    v_liberados := v_liberados + 1;
  END LOOP;

  RETURN json_build_object('success', true, 'itens_liberados', v_liberados);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.liberar_estoque_itens_pedido(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.liberar_estoque_itens_pedido(BIGINT, TEXT) TO service_role;

-- 4.1 Qualquer caminho que cancele comercialmente um pedido libera a reserva (uma única autoridade)
CREATE OR REPLACE FUNCTION public.trg_liberar_reserva_ao_cancelar()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status_comercial = 'cancelado' AND OLD.status_comercial IS DISTINCT FROM 'cancelado' THEN
    PERFORM public.liberar_estoque_itens_pedido(NEW.id, 'Liberação de reserva por cancelamento do pedido #' || NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_pedidos_libera_reserva_ao_cancelar ON public.pedidos;
CREATE TRIGGER trg_pedidos_libera_reserva_ao_cancelar
  AFTER UPDATE OF status_comercial ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_liberar_reserva_ao_cancelar();

-- 4.2 Quando a reserva é convertida em baixa física ('venda'), a flag do item é encerrada
CREATE OR REPLACE FUNCTION public.trg_encerrar_reserva_ao_vender()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tipo = 'venda' AND NEW.pedido_id IS NOT NULL AND NEW.produto_id IS NOT NULL THEN
    UPDATE public.pedido_itens
    SET reserva_estoque_ativa = false
    WHERE pedido_id = NEW.pedido_id
      AND produto_id = NEW.produto_id
      AND reserva_estoque_ativa = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_estoque_mov_encerra_reserva ON public.estoque_movimentacoes;
CREATE TRIGGER trg_estoque_mov_encerra_reserva
  AFTER INSERT ON public.estoque_movimentacoes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_encerrar_reserva_ao_vender();

-- 4.3 (REMOVIDO) O trigger trg_pedido_itens_marca_reserva_loja marcava a flag na inserção
--     de itens da loja. criar_pedido agora reserva via reservar_estoque_itens_pedido(),
--     portanto o trigger é descartado (manter os dois duplicaria/anularia a reserva).
DROP TRIGGER IF EXISTS trg_pedido_itens_marca_reserva_loja ON public.pedido_itens;
DROP FUNCTION IF EXISTS public.trg_marcar_reserva_item_loja();

-- --------------------------------------------------------------------------
-- 5. RPC CRIAR_ENCOMENDA_ADMIN (RESERVA DE ESTOQUE, HOLD, TIMEZONE, ENTREGA IMEDIATA)
-- --------------------------------------------------------------------------
-- Ordem de locks (pedido ainda não existe): capacidade/data -> produtos (id ASC)
-- -> INSERT pedido -> itens -> reserva (helper) -> pagamentos.
CREATE OR REPLACE FUNCTION public.criar_encomenda_admin(
  p_cliente_id BIGINT DEFAULT NULL,
  p_cliente_nome TEXT DEFAULT NULL,
  p_cliente_telefone TEXT DEFAULT NULL,
  p_cliente_email TEXT DEFAULT NULL,
  p_canal TEXT DEFAULT 'balcao',
  p_data_entrega DATE DEFAULT NULL,
  p_hora_entrega TIME DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'retirada',
  p_endereco_entrega TEXT DEFAULT NULL,
  p_itens JSONB DEFAULT '[]'::jsonb,
  p_taxa_entrega NUMERIC DEFAULT 0.00,
  p_desconto NUMERIC DEFAULT 0.00,
  p_motivo_desconto TEXT DEFAULT NULL,
  p_sinal_minimo NUMERIC DEFAULT 0.00,
  p_sinal_valor NUMERIC DEFAULT 0.00,
  p_sinal_metodo TEXT DEFAULT 'pix',
  p_sinal_comprovante TEXT DEFAULT NULL,
  p_saldo_vencimento DATE DEFAULT NULL,
  p_forcar_confirmacao_sem_sinal BOOLEAN DEFAULT false,
  p_motivo_confirmacao_sem_sinal TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL,
  p_observacoes_cliente TEXT DEFAULT NULL,
  p_observacoes_internas TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_tz TEXT;
  v_user_nome TEXT;
  v_cliente_id_final BIGINT;
  v_cliente_nome_final TEXT;
  v_cliente_tel_final TEXT;
  v_cliente_email_final TEXT;
  v_tel_norm TEXT;
  v_canal_norm TEXT;
  v_modalidade_norm TEXT;
  v_taxa NUMERIC(10,2) := 0.00;
  v_desconto NUMERIC(10,2) := 0.00;
  v_sinal_min NUMERIC(10,2) := 0.00;
  v_sinal_padrao NUMERIC(10,2) := 0.00;
  v_sinal_pago NUMERIC(10,2) := 0.00;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_opcao RECORD;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_pts_pedido_total NUMERIC(8,2) := 0.00;
  v_cap public.capacidade_producao;
  v_pontos_ocupados_atuais NUMERIC(8,2) := 0.00;
  v_status_com_inicial TEXT;
  v_status_fin_inicial TEXT := 'nao_pago';
  v_status_oper_inicial TEXT := 'aguardando_producao';
  v_pedido_id BIGINT;
  v_item_id BIGINT;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_pagamento_id BIGINT;
  v_entrega_at TIMESTAMPTZ;
  v_confirmacao_expires_at TIMESTAMPTZ;
  v_reserva JSON;
  v_produto_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_exc_hint TEXT;
  v_exc_detail TEXT;
BEGIN
  v_tz := v_cfg.timezone;

  -- 1. RBAC
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem lançar encomendas.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 2. Canal e Data
  v_canal_norm := LOWER(TRIM(COALESCE(p_canal, 'balcao')));
  IF v_canal_norm NOT IN ('balcao', 'whatsapp', 'telefone') THEN
    RETURN json_build_object('success', false, 'error', 'Canal de encomenda inválido. Use balcao, whatsapp ou telefone.');
  END IF;

  IF p_data_entrega IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  -- 3. Modalidade
  v_modalidade_norm := LOWER(TRIM(COALESCE(p_modalidade, 'retirada')));
  IF v_modalidade_norm = 'retirada' THEN
    v_taxa := 0.00;
  ELSIF v_modalidade_norm = 'entrega' THEN
    IF p_endereco_entrega IS NULL OR length(TRIM(p_endereco_entrega)) < 5 THEN
      RETURN json_build_object('success', false, 'error', 'Para entrega em domicílio, o endereço completo é obrigatório.');
    END IF;
    v_taxa := GREATEST(0.00, COALESCE(p_taxa_entrega, 0.00));
  ELSE
    RETURN json_build_object('success', false, 'error', 'Modalidade de entrega inválida. Use retirada ou entrega.');
  END IF;

  -- 4. Cliente (public.clientes)
  v_cliente_id_final := NULL;
  IF p_cliente_id IS NOT NULL THEN
    SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
    FROM public.clientes WHERE id = p_cliente_id;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF p_cliente_nome IS NULL OR length(TRIM(p_cliente_nome)) < 2 THEN
      RETURN json_build_object('success', false, 'error', 'Nome do cliente é obrigatório para registrar a encomenda.');
    END IF;

    v_tel_norm := regexp_replace(COALESCE(p_cliente_telefone, ''), '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
      FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, endereco_padrao)
      VALUES (
        TRIM(p_cliente_nome),
        NULLIF(TRIM(p_cliente_telefone), ''),
        v_tel_norm,
        NULLIF(TRIM(p_cliente_email), ''),
        CASE WHEN p_endereco_entrega IS NOT NULL THEN jsonb_build_object('endereco', p_endereco_entrega) ELSE '{}'::jsonb END
      ) RETURNING id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final;
    END IF;
  END IF;

  v_cliente_nome_final := COALESCE(NULLIF(TRIM(p_cliente_nome), ''), v_cliente_nome_final);
  v_cliente_tel_final := COALESCE(NULLIF(TRIM(p_cliente_telefone), ''), v_cliente_tel_final);
  v_cliente_email_final := COALESCE(NULLIF(TRIM(p_cliente_email), ''), v_cliente_email_final, 'balcao@lunocadoceria.com.br');

  -- 5. Itens: validação, subtotal e pontos (ainda sem locks de produto)
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'A encomenda precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, opcoes, ativo, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Produto #' || v_prod_id || ' não está disponível no cardápio.');
    END IF;

    v_produto_ids := array_append(v_produto_ids, v_prod_id);
    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF NOT FOUND THEN
            IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
              v_preco_opt := 0.00;
            ELSE
              RETURN json_build_object(
                'success', false,
                'code', 'INVALID_PRODUCT_OPTION',
                'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '".',
                'produto_id', v_prod.id,
                'opcao', v_opcao_nome
              );
            END IF;
          ELSE
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;

          v_subtotal := v_subtotal + (v_preco_opt * v_qtd);
        END IF;
      END LOOP;
    END IF;

    v_subtotal := v_subtotal + (v_prod.preco * v_qtd);
    v_pts_pedido_total := v_pts_pedido_total + ((v_pts_prod + v_pts_opt_total) * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  IF array_length(v_produto_ids, 1) IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nenhum item válido informado.');
  END IF;

  -- 6. Descontos
  v_desconto := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  IF v_desconto > v_subtotal THEN
    RETURN json_build_object('success', false, 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  IF v_desconto > (v_subtotal * 0.10) AND NOT public.is_admin() THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Operadores podem conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10)::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  IF v_desconto > 0 AND public.is_admin() AND (p_motivo_desconto IS NULL OR length(TRIM(p_motivo_desconto)) < 3) THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do desconto concedido.');
  END IF;

  v_total := (v_subtotal - v_desconto) + v_taxa;

  -- 7. Sinal / Estados iniciais / Hold (antes dos locks para falhar barato)
  -- GOVERNANÇA DO SINAL: o mínimo padrão é derivado de configuracoes_operacao
  -- (sinal_percentual_padrao x total). Operador NÃO pode reduzi-lo (somente aumentar);
  -- Admin pode reduzir mediante justificativa (p_motivo_confirmacao_sem_sinal).
  v_sinal_padrao := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);
  -- p_sinal_minimo NULL/0 significa "não informado" => padrão. Dispensar o sinal por completo
  -- só é possível via p_forcar_confirmacao_sem_sinal (admin + motivo).
  IF public.is_admin() THEN
    v_sinal_min := CASE WHEN COALESCE(p_sinal_minimo, 0.00) <= 0.00 THEN v_sinal_padrao ELSE p_sinal_minimo END;
    IF v_sinal_min < v_sinal_padrao
       AND p_forcar_confirmacao_sem_sinal IS NOT TRUE
       AND (p_motivo_confirmacao_sem_sinal IS NULL OR length(TRIM(p_motivo_confirmacao_sem_sinal)) < 3) THEN
      RETURN json_build_object(
        'success', false,
        'code', 'SIGNAL_REDUCTION_REQUIRES_REASON',
        'sinal_padrao', v_sinal_padrao,
        'error', 'Reduzir o sinal mínimo abaixo do padrão (R$ ' || v_sinal_padrao || ', ' || v_cfg.sinal_percentual_padrao || '% do total) exige justificativa.'
      );
    END IF;
  ELSE
    v_sinal_min := GREATEST(v_sinal_padrao, COALESCE(p_sinal_minimo, 0.00)); -- operador: nunca abaixo do padrão
  END IF;
  v_sinal_min := ROUND(v_sinal_min, 2);
  v_sinal_pago := GREATEST(0.00, COALESCE(p_sinal_valor, 0.00));

  IF v_sinal_pago > v_total THEN
    RETURN json_build_object('success', false, 'error', 'Valor do sinal informado excede o total da encomenda.');
  END IF;

  IF p_forcar_confirmacao_sem_sinal = true THEN
    IF NOT public.is_admin() THEN
      RETURN json_build_object('success', false, 'error', 'Apenas Administradores podem dispensar a exigência de sinal mínimo.');
    END IF;
    IF p_motivo_confirmacao_sem_sinal IS NULL OR length(TRIM(p_motivo_confirmacao_sem_sinal)) < 3 THEN
      RETURN json_build_object('success', false, 'error', 'Informe o motivo para autorizar a confirmação da encomenda sem sinal.');
    END IF;
  END IF;

  IF v_sinal_min = 0.00 OR p_forcar_confirmacao_sem_sinal = true OR (v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00) THEN
    v_status_com_inicial := 'confirmado';
    v_confirmacao_expires_at := NULL;
  ELSE
    v_status_com_inicial := 'aguardando_confirmacao';

    -- Hold = min(agora + hold_horas, entrega - antecedência), tudo no fuso operacional
    v_entrega_at := ((p_data_entrega + COALESCE(p_hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_tz;
    v_confirmacao_expires_at := LEAST(
      NOW() + make_interval(hours => v_cfg.hold_horas_padrao),
      v_entrega_at - make_interval(hours => v_cfg.antecedencia_confirmacao_horas)
    );

    -- Regra estrita de entrega imediata: sem prazo de hold => sinal integral agora ou override admin
    IF v_confirmacao_expires_at <= NOW() THEN
      RETURN json_build_object(
        'success', false,
        'code', 'IMMEDIATE_CONFIRMATION_REQUIRED',
        'error', 'A data/horário de entrega é muito próxima (menos de ' || v_cfg.antecedencia_confirmacao_horas || ' hora(s)). Encomendas imediatas exigem pagamento integral do sinal mínimo (R$ ' || v_sinal_min || ') no ato da criação ou confirmação excepcional por Administrador.',
        'sinal_minimo', v_sinal_min,
        'sinal_pago', v_sinal_pago,
        'entrega_em', v_entrega_at
      );
    END IF;
  END IF;

  -- 8. LOCKS (ordem global): capacidade/data -> produtos (id ASC)
  v_cap := public.travar_capacidade_data(p_data_entrega);

  PERFORM 1 FROM public.produtos WHERE id = ANY(v_produto_ids) ORDER BY id FOR UPDATE;

  v_pontos_ocupados_atuais := public.pontos_ocupados_data(p_data_entrega, NULL);

  IF v_cap.bloqueado = true OR (v_pontos_ocupados_atuais + v_pts_pedido_total) > v_cap.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      NULL; -- encaixe extraordinário autorizado
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_data_entrega,
        'capacidade_maxima', v_cap.capacidade_maxima_pontos,
        'pontos_ocupados', v_pontos_ocupados_atuais,
        'pontos_solicitados', v_pts_pedido_total,
        'error', 'Capacidade de produção excedida para ' || p_data_entrega || ' (' || v_pontos_ocupados_atuais || '/' || v_cap.capacidade_maxima_pontos || ' pts ocupados). Requer autorização de Administrador para encaixe extraordinário.'
      );
    END IF;
  END IF;

  -- 9. INSERT do pedido
  INSERT INTO public.pedidos (
    cliente_id_rel, nome_cliente, telefone_cliente, email_cliente,
    data_pedido, data_entrega, hora_entrega,
    subtotal, desconto, total, taxa_entrega, valor_pago, saldo, sinal_minimo, saldo_vencimento,
    modalidade_entrega, canal, pagamento,
    status_comercial, status_financeiro, status_operacional, status,
    itens, endereco_entrega, observacoes_cliente, observacoes_internas,
    confirmacao_expires_at
  ) VALUES (
    v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final,
    (NOW() AT TIME ZONE v_tz)::DATE, p_data_entrega, p_hora_entrega,
    v_subtotal, v_desconto, v_total, v_taxa, 0.00, v_total, v_sinal_min, p_saldo_vencimento,
    v_modalidade_norm, v_canal_norm, LOWER(TRIM(COALESCE(p_sinal_metodo, 'pix'))),
    v_status_com_inicial, v_status_fin_inicial, v_status_oper_inicial, 'Pendente',
    array_to_string(v_nomes_itens, ' + '), COALESCE(p_endereco_entrega, 'Retirada no Balcão'), p_observacoes_cliente, p_observacoes_internas,
    v_confirmacao_expires_at
  ) RETURNING id INTO v_pedido_id;

  -- 10. Itens e opções (snapshots)
  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, pontos_producao INTO v_prod FROM public.produtos WHERE id = v_prod_id;
    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, unidade,
      preco_base_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal, pontos_producao_snapshot
    ) VALUES (
      v_pedido_id, v_prod.id, v_prod.nome, v_qtd, 'un',
      v_prod.preco, 0.00, v_prod.preco, (v_prod.preco * v_qtd), v_pts_prod
    ) RETURNING id INTO v_item_id;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, categoria, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.pedido_item_opcoes (pedido_item_id, produto_opcao_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot)
            VALUES (v_item_id, v_opt_rec.id, v_opt_rec.categoria, v_opcao_nome, COALESCE(v_opt_rec.preco_adicional, 0.00), COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00));
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
          ELSE
            INSERT INTO public.pedido_item_opcoes (pedido_item_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot)
            VALUES (v_item_id, 'outro', v_opcao_nome, 0.00, 0.00);
            v_preco_opt := 0.00;
          END IF;
          v_pts_opt_total := v_pts_opt_total + v_preco_opt; -- reutilizado aqui como acumulador de R$ adicionais da linha
        END IF;
      END LOOP;
    END IF;

    IF v_pts_opt_total > 0 THEN
      UPDATE public.pedido_itens
      SET preco_adicionais = v_pts_opt_total,
          preco_unitario_snapshot = preco_base_snapshot + v_pts_opt_total,
          subtotal = (preco_base_snapshot + v_pts_opt_total) * quantidade
      WHERE id = v_item_id;
    END IF;
  END LOOP;

  -- 11. RESERVA DE ESTOQUE (Opção A) — fail-closed, sem override de estoque
  v_reserva := public.reservar_estoque_itens_pedido(
    v_pedido_id,
    'Reserva de estoque para encomenda #' || v_pedido_id || ' (' || upper(v_canal_norm) || ')',
    true
  );
  IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = COALESCE(v_reserva->>'error', 'Estoque insuficiente para a encomenda.'),
      DETAIL = COALESCE(v_reserva::TEXT, '{}'),
      HINT = 'INSUFFICIENT_STOCK';
  END IF;

  -- 12. Entrada/Sinal via fluxo canônico de pagamentos (trigger recalcula saldo & DRE)
  IF v_sinal_pago > 0 THEN
    INSERT INTO public.pedido_pagamentos (
      pedido_id, valor, metodo, provider, provider_payment_id, status, pago_em, registrado_por, comprovante_url, observacoes
    ) VALUES (
      v_pedido_id, v_sinal_pago, LOWER(TRIM(p_sinal_metodo)), 'manual', NULL, 'aprovado', NOW(), auth.uid(), p_sinal_comprovante,
      'Entrada/Sinal registrado no ato da encomenda (' || upper(v_canal_norm) || ')'
    ) RETURNING id INTO v_pagamento_id;

    INSERT INTO public.financeiro_lancamentos (
      tipo, categoria, descricao, valor, data_lancamento, forma_pagamento, pedido_id, origem_tipo, origem_id, evento, observacoes
    ) VALUES (
      'receita', 'Vendas', 'Entrada Encomenda #' || v_pedido_id || ' (' || v_cliente_nome_final || ')',
      v_sinal_pago, (NOW() AT TIME ZONE v_tz)::DATE, LOWER(TRIM(p_sinal_metodo)), v_pedido_id,
      'pedido_pagamento', v_pagamento_id, 'recebimento', 'Entrada de encomenda via canal ' || v_canal_norm
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 13. Auditoria
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    v_pedido_id, 'comercial', 'novo', v_status_com_inicial, auth.uid(), v_user_nome, 'admin',
    jsonb_build_object(
      'canal', v_canal_norm,
      'desconto', v_desconto,
      'motivo_desconto', p_motivo_desconto,
      'sinal_minimo', v_sinal_min,
      'sinal_padrao', v_sinal_padrao,
      'sinal_minimo_solicitado', p_sinal_minimo,
      'sinal_pago', v_sinal_pago,
      'confirmado_sem_sinal', p_forcar_confirmacao_sem_sinal,
      'motivo_confirmacao_sem_sinal', p_motivo_confirmacao_sem_sinal,
      'pontos_carga', v_pts_pedido_total,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe,
      'confirmacao_expires_at', v_confirmacao_expires_at,
      'timezone', v_tz,
      'reserva_estoque', v_reserva
    )
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'cliente_id', v_cliente_id_final,
    'total', v_total,
    'status_comercial', v_status_com_inicial,
    'sinal_minimo', v_sinal_min,
    'sinal_padrao', v_sinal_padrao,
    'status_financeiro', CASE WHEN v_sinal_pago >= v_total THEN 'pago' WHEN v_sinal_pago > 0 THEN 'parcialmente_pago' ELSE 'nao_pago' END,
    'pontos_carga', v_pts_pedido_total,
    'confirmacao_expires_at', v_confirmacao_expires_at,
    'reserva_estoque', v_reserva
  );
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    -- Estoque insuficiente (ou outra violação de domínio): tudo que foi escrito é revertido
    GET STACKED DIAGNOSTICS v_exc_hint = PG_EXCEPTION_HINT, v_exc_detail = PG_EXCEPTION_DETAIL;
    RETURN json_build_object(
      'success', false,
      'code', COALESCE(NULLIF(v_exc_hint, ''), 'DOMAIN_ERROR'),
      'error', SQLERRM,
      'detalhes', CASE WHEN v_exc_detail ~ '^\{' THEN v_exc_detail::JSON ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. PIPELINE ÚNICO DE EXPIRAÇÃO: expirar_pedidos_e_holds()
-- --------------------------------------------------------------------------
-- Atende, numa única autoridade:
--   (a) PIX da loja online sem pagamento (expires_at / tolerância em minutos);
--   (b) Holds de encomenda (confirmacao_expires_at).
-- Idempotência: Caso A cancela (sai do filtro); Caso B marca requer_revisao_financeira
-- (sai do filtro) e a liberação de estoque passa pela flag por item.
-- Concorrência: pedidos travados em ordem de id com SKIP LOCKED (múltiplos workers seguros).
CREATE OR REPLACE FUNCTION public.expirar_pedidos_e_holds(
  p_limite INT DEFAULT 200
)
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_ped RECORD;
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INT;
  v_saldo INT;
  v_tem_itens BOOLEAN;
  v_cancelados INT := 0;
  v_revisao INT := 0;
  v_processados INT := 0;
  v_lib JSON;
BEGIN
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Rotina restrita a service_role ou administradores.');
  END IF;

  FOR v_ped IN
    SELECT p.id, p.valor_pago, p.canal, p.itens_json, p.status_comercial, p.confirmacao_expires_at, p.expires_at
    FROM public.pedidos p
    WHERE p.status_comercial = 'aguardando_confirmacao'
      AND p.requer_revisao_financeira = false
      AND (
        -- (b) Hold de encomenda vencido
        (p.confirmacao_expires_at IS NOT NULL AND p.confirmacao_expires_at <= NOW())
        OR
        -- (a) PIX da loja sem pagamento e sem hold explícito
        (
          p.confirmacao_expires_at IS NULL
          AND p.canal = 'loja_online'
          AND p.status_financeiro = 'nao_pago'
          AND (
            p.expires_at <= NOW()
            OR (p.expires_at IS NULL AND p.created_at < NOW() - make_interval(mins => v_cfg.hold_pix_loja_minutos))
          )
        )
      )
    ORDER BY p.id
    FOR UPDATE OF p SKIP LOCKED
    LIMIT GREATEST(1, COALESCE(p_limite, 200))
  LOOP
    v_processados := v_processados + 1;

    IF COALESCE(v_ped.valor_pago, 0) <= 0 THEN
      -- ===== CASO A: nada recebido -> cancela, libera capacidade e estoque =====
      SELECT EXISTS (SELECT 1 FROM public.pedido_itens WHERE pedido_id = v_ped.id) INTO v_tem_itens;

      UPDATE public.pedidos
      SET status_comercial = 'cancelado',
          status_operacional = 'cancelado',
          cancelado_por_expiracao = true,
          status_pagamento = 'expirado',
          updated_at = NOW()
      WHERE id = v_ped.id;
      -- (o trigger trg_pedidos_libera_reserva_ao_cancelar libera as reservas ativas por item)

      -- Fallback legado: pedidos antigos sem pedido_itens, reserva registrada apenas em itens_json
      IF NOT v_tem_itens AND v_ped.itens_json IS NOT NULL AND jsonb_typeof(v_ped.itens_json) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_ped.itens_json) LOOP
          v_prod_id := NULLIF(v_item->>'id', '')::BIGINT;
          v_qtd := GREATEST(1, COALESCE((v_item->>'quantidade')::INTEGER, 1));
          IF v_prod_id IS NOT NULL THEN
            UPDATE public.produtos
            SET estoque_reservado = GREATEST(0, COALESCE(estoque_reservado, 0) - v_qtd), updated_at = NOW()
            WHERE id = v_prod_id AND controlar_estoque IS NOT FALSE
            RETURNING (COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)) INTO v_saldo;
            IF FOUND THEN
              INSERT INTO public.estoque_movimentacoes (produto_id, produto_nome, tipo, quantidade, saldo_resultante, motivo, pedido_id, usuario_nome)
              VALUES (v_prod_id, COALESCE(v_item->>'nome', 'Produto'), 'ajuste', v_qtd, COALESCE(v_saldo, 0),
                      'Devolução de reserva (legado) por expiração do Pedido #' || v_ped.id, v_ped.id, 'Sistema / Expiração Automática');
            END IF;
          END IF;
        END LOOP;
      END IF;

      INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_nome, origem, metadata)
      VALUES (v_ped.id, 'comercial', 'aguardando_confirmacao', 'cancelado', 'Sistema / Expiração Automática', 'cron',
              jsonb_build_object('motivo', 'Prazo de confirmação/pagamento expirou sem nenhum valor recebido. Vaga de produção e reservas de estoque liberadas.',
                                 'confirmacao_expires_at', v_ped.confirmacao_expires_at, 'expires_at', v_ped.expires_at, 'canal', v_ped.canal));
      v_cancelados := v_cancelados + 1;

    ELSE
      -- ===== CASO B: há valor recebido -> NÃO cancela; libera vaga/estoque e envia à revisão =====
      v_lib := public.liberar_estoque_itens_pedido(v_ped.id, 'Liberação de reserva por expiração de hold com pagamento parcial (Pedido #' || v_ped.id || ')');

      UPDATE public.pedidos
      SET requer_revisao_financeira = true,
          motivo_revisao_financeira = 'Hold expirou com pagamento parcial recebido (R$ ' || v_ped.valor_pago || '). Vaga e estoque liberados; pedido aguarda decisão da administração.',
          updated_at = NOW()
      WHERE id = v_ped.id;

      INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_nome, origem, metadata)
      VALUES (v_ped.id, 'comercial', 'aguardando_confirmacao', 'aguardando_confirmacao', 'Sistema / Expiração Automática', 'cron',
              jsonb_build_object('motivo', 'Hold expirou com pagamento parcial recebido (R$ ' || v_ped.valor_pago || '). Vaga e estoque liberados; pedido aguarda decisão da administração.',
                                 'requer_revisao_financeira', true, 'confirmacao_expires_at', v_ped.confirmacao_expires_at, 'reserva', v_lib));
      v_revisao := v_revisao + 1;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'processados', v_processados,
    'cancelados_sem_pagamento', v_cancelados,
    'enviados_para_revisao', v_revisao,
    'timestamp', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.expirar_pedidos_e_holds(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expirar_pedidos_e_holds(INT) TO authenticated, service_role;

-- Compatibilidade: a RPC legada passa a delegar ao pipeline único
CREATE OR REPLACE FUNCTION public.liberar_pedidos_expirados()
RETURNS JSON AS $$
DECLARE
  v_res JSON := public.expirar_pedidos_e_holds(200);
BEGIN
  RETURN json_build_object(
    'success', COALESCE((v_res->>'success')::BOOLEAN, false),
    'total_cancelados', COALESCE((v_res->>'cancelados_sem_pagamento')::INT, 0),
    'enviados_para_revisao', COALESCE((v_res->>'enviados_para_revisao')::INT, 0),
    'delegado_para', 'expirar_pedidos_e_holds',
    'detalhes', v_res
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- --------------------------------------------------------------------------
-- 7. TRIGGER RECALCULAR_FINANCEIRO_PEDIDO: PAGAMENTO TARDIO COM REVALIDAÇÃO DUPLA
-- --------------------------------------------------------------------------
-- Ordem de locks: pedido -> capacidade/data -> produtos (via helper de reserva).
CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()
RETURNS TRIGGER AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_ped_id BIGINT := COALESCE(NEW.pedido_id, OLD.pedido_id);
  v_ped RECORD;
  v_pago NUMERIC(10,2);
  v_saldo NUMERIC(10,2);
  v_novo_status_fin TEXT;
  v_novo_status_com TEXT;
  v_tem_estorno BOOLEAN := false;
  v_hold_expirado BOOLEAN := false;
  v_novo_expires_at TIMESTAMPTZ;
  v_limite_hold TIMESTAMPTZ;
  v_requer_revisao BOOLEAN;
  v_bloqueado_tardio BOOLEAN;
  v_motivo_revisao TEXT;
  v_motivo_com TEXT := NULL;
  v_cap public.capacidade_producao;
  v_pts_pedido NUMERIC(8,2);
  v_pts_ocupados NUMERIC(8,2);
  v_cap_ok BOOLEAN := true;
  v_reserva JSON;
  v_estoque_ok BOOLEAN := true;
BEGIN
  -- 1. LOCK DO PEDIDO (primeiro recurso da ordem global)
  SELECT id, total, sinal_minimo, status_comercial, status_operacional, status_financeiro,
         confirmacao_expires_at, requer_revisao_financeira, bloqueado_por_overbooking_tardio, data_entrega, hora_entrega
  INTO v_ped
  FROM public.pedidos
  WHERE id = v_ped_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_novo_expires_at := v_ped.confirmacao_expires_at;
  v_requer_revisao := v_ped.requer_revisao_financeira;
  v_bloqueado_tardio := v_ped.bloqueado_por_overbooking_tardio;
  v_motivo_revisao := NULL;

  -- 2. Soma estritamente pagamentos aprovados
  SELECT COALESCE(SUM(valor), 0) INTO v_pago
  FROM public.pedido_pagamentos
  WHERE pedido_id = v_ped_id AND status = 'aprovado';

  v_saldo := GREATEST(0, COALESCE(v_ped.total, 0) - v_pago);

  SELECT EXISTS (SELECT 1 FROM public.pedido_pagamentos WHERE pedido_id = v_ped_id AND status = 'estornado') INTO v_tem_estorno;

  IF v_tem_estorno AND v_pago <= 0 THEN
    v_novo_status_fin := 'estornado';
  ELSIF v_pago <= 0 THEN
    v_novo_status_fin := 'nao_pago';
  ELSIF v_saldo <= 0 THEN
    v_novo_status_fin := 'pago';
  ELSE
    v_novo_status_fin := 'parcialmente_pago';
  END IF;

  v_novo_status_com := v_ped.status_comercial;

  -- 3. Regra 1: Confirmação por sinal (com revalidação dupla se o hold já expirou)
  IF v_ped.sinal_minimo > 0 AND v_pago >= v_ped.sinal_minimo AND v_ped.status_comercial = 'aguardando_confirmacao' THEN
    v_hold_expirado := (v_ped.confirmacao_expires_at IS NOT NULL AND v_ped.confirmacao_expires_at <= NOW()) OR v_ped.requer_revisao_financeira;

    IF NOT v_hold_expirado THEN
      -- Pagamento dentro do prazo: reserva de estoque continua ativa; confirma normalmente
      v_novo_status_com := 'confirmado';
      v_novo_expires_at := NULL;
      v_requer_revisao := false;
      v_bloqueado_tardio := false;
      v_motivo_com := 'Sinal mínimo atingido por pagamento acumulado dentro do prazo de confirmação';
    ELSE
      -- Pagamento TARDIO: lock capacidade -> revalida capacidade -> revalida/recria estoque
      v_cap := public.travar_capacidade_data(v_ped.data_entrega);
      v_pts_pedido := public.pontos_pedido(v_ped_id);
      v_pts_ocupados := public.pontos_ocupados_data(v_ped.data_entrega, v_ped_id);
      v_cap_ok := NOT (v_cap.bloqueado = true OR (v_pts_ocupados + v_pts_pedido) > v_cap.capacidade_maxima_pontos);

      IF v_cap_ok THEN
        v_reserva := public.reservar_estoque_itens_pedido(v_ped_id, 'Reserva recriada após pagamento tardio do pedido #' || v_ped_id, true);
        v_estoque_ok := COALESCE((v_reserva->>'success')::BOOLEAN, false);
      ELSE
        -- Sem capacidade não faz sentido reservar estoque; apenas verifica para reportar com precisão
        v_reserva := NULL;
        SELECT NOT EXISTS (
          SELECT 1
          FROM public.pedido_itens pi
          JOIN public.produtos pr ON pr.id = pi.produto_id
          WHERE pi.pedido_id = v_ped_id
            AND pr.controlar_estoque IS NOT FALSE
            AND pi.reserva_estoque_ativa = false
            AND (COALESCE(pr.estoque_fisico, 0) - COALESCE(pr.estoque_reservado, 0)) < pi.quantidade
        ) INTO v_estoque_ok;
      END IF;

      IF v_cap_ok AND v_estoque_ok THEN
        v_novo_status_com := 'confirmado';
        v_novo_expires_at := NULL;
        v_requer_revisao := false;
        v_bloqueado_tardio := false;
        v_motivo_com := 'Pagamento tardio aceito após revalidação atômica com sucesso de capacidade e estoque';
      ELSE
        v_novo_status_com := 'aguardando_confirmacao';
        v_requer_revisao := true;
        v_bloqueado_tardio := true;
        v_motivo_revisao := 'Pagamento tardio recebido após expiração do hold, porém '
          || CASE
               WHEN NOT v_cap_ok AND NOT v_estoque_ok THEN 'a capacidade de produção e o estoque'
               WHEN NOT v_cap_ok THEN 'a capacidade de produção'
               ELSE 'o estoque'
             END
          || ' já não comportam esta encomenda. Requer decisão administrativa.';
        v_motivo_com := v_motivo_revisao;
      END IF;
    END IF;
  END IF;

  -- 4. Regra 2: Guarda de produção em caso de estorno do sinal (+ renovação do hold)
  IF v_ped.sinal_minimo > 0 AND v_pago < v_ped.sinal_minimo THEN
    IF v_ped.status_operacional = 'aguardando_producao' AND v_ped.status_comercial = 'confirmado' THEN
      v_novo_status_com := 'aguardando_confirmacao';
      -- Novo hold = MIN(agora + hold padrão, entrega - antecedência) — nunca além da própria entrega
      v_limite_hold := (((v_ped.data_entrega + COALESCE(v_ped.hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_cfg.timezone)
                       - make_interval(hours => v_cfg.antecedencia_confirmacao_horas);
      v_novo_expires_at := LEAST(NOW() + make_interval(hours => v_cfg.hold_horas_padrao), v_limite_hold);
      IF v_novo_expires_at <= NOW() THEN
        -- Limite já passou: não há hold possível. Vai direto para revisão financeira e libera estoque/capacidade.
        v_novo_expires_at := NOW();
        v_requer_revisao := true;
        v_motivo_revisao := 'Estorno de sinal reduziu o valor pago abaixo do mínimo e a entrega está dentro da antecedência mínima; sem prazo de hold viável. Requer decisão administrativa.';
        v_motivo_com := v_motivo_revisao;
        PERFORM public.liberar_estoque_itens_pedido(v_ped_id, 'Liberação de reserva: estorno sem hold viável no pedido #' || v_ped_id);
      ELSE
        v_motivo_com := 'Estorno de sinal reduziu valor pago abaixo do mínimo antes do início da produção; hold renovado até ' || to_char(v_novo_expires_at AT TIME ZONE v_cfg.timezone, 'DD/MM HH24:MI');
      END IF;
    ELSE
      v_novo_status_com := v_ped.status_comercial;
    END IF;
  END IF;

  UPDATE public.pedidos
  SET valor_pago = v_pago,
      saldo = v_saldo,
      status_financeiro = v_novo_status_fin,
      status_comercial = v_novo_status_com,
      possui_estorno = v_tem_estorno,
      confirmacao_expires_at = v_novo_expires_at,
      requer_revisao_financeira = v_requer_revisao,
      bloqueado_por_overbooking_tardio = v_bloqueado_tardio,
      motivo_revisao_financeira = CASE WHEN v_requer_revisao THEN COALESCE(v_motivo_revisao, motivo_revisao_financeira) ELSE NULL END,
      updated_at = NOW()
  WHERE id = v_ped_id;

  -- 5. Lançamento compensatório no DRE ao estornar pagamento aprovado (idempotência estrutural)
  IF TG_OP = 'UPDATE' AND OLD.status = 'aprovado' AND NEW.status = 'estornado' THEN
    INSERT INTO public.financeiro_lancamentos (
      tipo, categoria, descricao, valor, data_lancamento, forma_pagamento, pedido_id, origem_tipo, origem_id, evento, observacoes
    ) VALUES (
      'despesa', 'Estornos',
      'Estorno de Pagamento #' || NEW.id || ' do Pedido #' || v_ped_id || ' (' || upper(NEW.metodo) || ')',
      NEW.valor, (NOW() AT TIME ZONE v_cfg.timezone)::DATE, NEW.metodo, v_ped_id,
      'pedido_pagamento', NEW.id, 'estorno',
      'Estorno financeiro contábil automático via pedido_pagamentos #' || NEW.id
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 6. Auditoria financeira
  IF v_ped.status_financeiro IS DISTINCT FROM v_novo_status_fin THEN
    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (
      v_ped_id, 'financeiro', COALESCE(v_ped.status_financeiro, 'nao_pago'), v_novo_status_fin, auth.uid(), 'Sistema / Trigger Financeiro',
      CASE WHEN auth.role() = 'service_role' THEN 'sistema' WHEN public.is_admin_or_operator() THEN 'admin' ELSE 'sistema' END,
      jsonb_build_object('motivo', 'Recálculo automático via pedido_pagamentos', 'valor_pago', v_pago, 'saldo', v_saldo, 'tem_estorno', v_tem_estorno)
    );
  END IF;

  -- 7. Auditoria comercial (mudança de status OU bloqueio tardio sem mudança de status)
  IF v_ped.status_comercial IS DISTINCT FROM v_novo_status_com
     OR (v_bloqueado_tardio AND NOT v_ped.bloqueado_por_overbooking_tardio) THEN
    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (
      v_ped_id, 'comercial', v_ped.status_comercial, v_novo_status_com, auth.uid(), 'Sistema / Gatilho de Sinal', 'sistema',
      jsonb_build_object(
        'motivo', v_motivo_com,
        'valor_pago', v_pago,
        'sinal_minimo', v_ped.sinal_minimo,
        'hold_expirado', v_hold_expirado,
        'capacidade_ok', v_cap_ok,
        'estoque_ok', v_estoque_ok,
        'reserva', v_reserva,
        'requer_revisao_financeira', v_requer_revisao,
        'bloqueado_por_overbooking_tardio', v_bloqueado_tardio
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_recalcular_financeiro_pedido ON public.pedido_pagamentos;
CREATE TRIGGER trg_recalcular_financeiro_pedido
  AFTER INSERT OR UPDATE OR DELETE ON public.pedido_pagamentos
  FOR EACH ROW
  EXECUTE FUNCTION public.recalcular_financeiro_pedido();

-- --------------------------------------------------------------------------
-- 8. RPC RESOLVER_REVISAO_ENCOMENDA_ADMIN (EXCLUSIVO ADMIN, MOTIVO OBRIGATÓRIO)
-- --------------------------------------------------------------------------
-- Ações: ESTENDER_HOLD | CONFIRMAR_COM_OVERRIDE | ESTORNAR_E_CANCELAR | CANCELAR
--   * Override vale para CAPACIDADE. Estoque insuficiente NUNCA é sobreposto.
--   * ESTORNAR_E_CANCELAR reutiliza estornar_pagamento_pedido() (fluxo canônico).
--   * CANCELAR com valor pago exige p_destino_valor = 'RETENCAO_CANCELAMENTO'.
CREATE OR REPLACE FUNCTION public.resolver_revisao_encomenda_admin(
  p_pedido_id BIGINT,
  p_acao TEXT,
  p_motivo TEXT,
  p_novo_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_destino_valor TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_ped RECORD;
  v_acao TEXT := UPPER(TRIM(COALESCE(p_acao, '')));
  v_user_nome TEXT;
  v_cap public.capacidade_producao;
  v_pts_pedido NUMERIC(8,2);
  v_pts_ocupados NUMERIC(8,2);
  v_cap_ok BOOLEAN;
  v_reserva JSON;
  v_pag RECORD;
  v_estornos JSONB := '[]'::jsonb;
  v_res JSON;
  v_status_com_anterior TEXT;
  v_novo_expires TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores podem resolver revisões financeiras.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido é obrigatório.');
  END IF;

  IF v_acao NOT IN ('ESTENDER_HOLD', 'CONFIRMAR_COM_OVERRIDE', 'ESTORNAR_E_CANCELAR', 'CANCELAR') THEN
    RETURN json_build_object('success', false, 'error', 'Ação inválida. Use ESTENDER_HOLD, CONFIRMAR_COM_OVERRIDE, ESTORNAR_E_CANCELAR ou CANCELAR.');
  END IF;

  IF p_motivo IS NULL OR length(TRIM(p_motivo)) < 5 THEN
    RETURN json_build_object('success', false, 'error', 'Informe uma justificativa com pelo menos 5 caracteres.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Administrador' END;
  END IF;

  -- 1. LOCK DO PEDIDO
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN json_build_object('success', false, 'error', 'Pedido já está cancelado.');
  END IF;

  IF NOT (v_ped.requer_revisao_financeira OR v_ped.bloqueado_por_overbooking_tardio) THEN
    RETURN json_build_object('success', false, 'code', 'NOT_IN_REVIEW', 'error', 'Este pedido não está em revisão financeira.');
  END IF;

  v_status_com_anterior := v_ped.status_comercial;

  -- ======================= ESTENDER_HOLD =======================
  IF v_acao = 'ESTENDER_HOLD' THEN
    v_novo_expires := COALESCE(p_novo_expires_at, NOW() + make_interval(hours => v_cfg.hold_horas_padrao));
    IF v_novo_expires <= NOW() THEN
      RETURN json_build_object('success', false, 'error', 'O novo prazo do hold precisa estar no futuro.');
    END IF;

    -- capacidade -> produtos
    v_cap := public.travar_capacidade_data(v_ped.data_entrega);
    v_pts_pedido := public.pontos_pedido(p_pedido_id);
    v_pts_ocupados := public.pontos_ocupados_data(v_ped.data_entrega, p_pedido_id);
    v_cap_ok := NOT (v_cap.bloqueado = true OR (v_pts_ocupados + v_pts_pedido) > v_cap.capacidade_maxima_pontos);
    IF NOT v_cap_ok THEN
      RETURN json_build_object(
        'success', false, 'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'error', 'Capacidade de produção insuficiente em ' || v_ped.data_entrega || ' (' || v_pts_ocupados || '/' || v_cap.capacidade_maxima_pontos || ' pts). Use CONFIRMAR_COM_OVERRIDE para encaixe extraordinário ou reagende.',
        'capacidade_maxima', v_cap.capacidade_maxima_pontos, 'pontos_ocupados', v_pts_ocupados, 'pontos_solicitados', v_pts_pedido
      );
    END IF;

    v_reserva := public.reservar_estoque_itens_pedido(p_pedido_id, 'Reserva recriada ao estender hold do pedido #' || p_pedido_id, true);
    IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
      RETURN json_build_object('success', false, 'code', 'INSUFFICIENT_STOCK',
        'error', 'Estoque insuficiente para recriar a reserva. Reponha o estoque antes de estender o hold.', 'detalhes', v_reserva);
    END IF;

    UPDATE public.pedidos
    SET confirmacao_expires_at = v_novo_expires,
        requer_revisao_financeira = false,
        bloqueado_por_overbooking_tardio = false,
        motivo_revisao_financeira = NULL,
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (p_pedido_id, 'comercial', v_status_com_anterior, v_ped.status_comercial, auth.uid(), v_user_nome, 'admin',
            jsonb_build_object('acao', v_acao, 'motivo', p_motivo, 'novo_expires_at', v_novo_expires, 'reserva', v_reserva, 'pontos_ocupados', v_pts_ocupados));

    RETURN json_build_object('success', true, 'acao', v_acao, 'pedido_id', p_pedido_id, 'confirmacao_expires_at', v_novo_expires, 'reserva', v_reserva);
  END IF;

  -- ======================= CONFIRMAR_COM_OVERRIDE =======================
  IF v_acao = 'CONFIRMAR_COM_OVERRIDE' THEN
    v_cap := public.travar_capacidade_data(v_ped.data_entrega);
    v_pts_pedido := public.pontos_pedido(p_pedido_id);
    v_pts_ocupados := public.pontos_ocupados_data(v_ped.data_entrega, p_pedido_id);
    v_cap_ok := NOT (v_cap.bloqueado = true OR (v_pts_ocupados + v_pts_pedido) > v_cap.capacidade_maxima_pontos);

    -- Estoque NUNCA é sobreposto
    v_reserva := public.reservar_estoque_itens_pedido(p_pedido_id, 'Reserva recriada por confirmação administrativa do pedido #' || p_pedido_id, true);
    IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
      RETURN json_build_object('success', false, 'code', 'INSUFFICIENT_STOCK',
        'error', 'Override de estoque não é permitido. O pedido permanece em revisão até reposição/compra de insumos.',
        'detalhes', v_reserva);
    END IF;

    UPDATE public.pedidos
    SET status_comercial = 'confirmado',
        confirmacao_expires_at = NULL,
        requer_revisao_financeira = false,
        bloqueado_por_overbooking_tardio = false,
        motivo_revisao_financeira = NULL,
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (p_pedido_id, 'comercial', v_status_com_anterior, 'confirmado', auth.uid(), v_user_nome, 'admin',
            jsonb_build_object('acao', v_acao, 'motivo', p_motivo, 'override_capacidade', NOT v_cap_ok,
                               'capacidade_maxima', v_cap.capacidade_maxima_pontos, 'pontos_ocupados', v_pts_ocupados, 'pontos_pedido', v_pts_pedido, 'reserva', v_reserva));

    RETURN json_build_object('success', true, 'acao', v_acao, 'pedido_id', p_pedido_id, 'override_capacidade', NOT v_cap_ok, 'reserva', v_reserva);
  END IF;

  -- ======================= ESTORNAR_E_CANCELAR =======================
  IF v_acao = 'ESTORNAR_E_CANCELAR' THEN
    FOR v_pag IN SELECT id, valor FROM public.pedido_pagamentos WHERE pedido_id = p_pedido_id AND status = 'aprovado' ORDER BY id LOOP
      v_res := public.estornar_pagamento_pedido(v_pag.id, 'Resolução administrativa (' || v_acao || '): ' || p_motivo);
      IF COALESCE((v_res->>'success')::BOOLEAN, false) = false THEN
        RAISE EXCEPTION 'Falha ao estornar pagamento #%: %', v_pag.id, COALESCE(v_res->>'error', 'erro desconhecido');
      END IF;
      v_estornos := v_estornos || jsonb_build_object('pagamento_id', v_pag.id, 'valor', v_pag.valor);
    END LOOP;

    UPDATE public.pedidos
    SET status_comercial = 'cancelado',
        status_operacional = 'cancelado',
        cancelado_por_expiracao = true,
        requer_revisao_financeira = false,
        bloqueado_por_overbooking_tardio = false,
        motivo_revisao_financeira = NULL,
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (p_pedido_id, 'comercial', v_status_com_anterior, 'cancelado', auth.uid(), v_user_nome, 'admin',
            jsonb_build_object('acao', v_acao, 'motivo', p_motivo, 'estornos', v_estornos));

    RETURN json_build_object('success', true, 'acao', v_acao, 'pedido_id', p_pedido_id, 'estornos', v_estornos);
  END IF;

  -- ======================= CANCELAR (valor retido) =======================
  IF v_acao = 'CANCELAR' THEN
    IF COALESCE(v_ped.valor_pago, 0) > 0 AND UPPER(TRIM(COALESCE(p_destino_valor, ''))) <> 'RETENCAO_CANCELAMENTO' THEN
      RETURN json_build_object('success', false, 'code', 'DESTINO_VALOR_OBRIGATORIO',
        'error', 'Há R$ ' || v_ped.valor_pago || ' pagos. Informe p_destino_valor = RETENCAO_CANCELAMENTO (crédito de cliente será suportado em migration própria) ou use ESTORNAR_E_CANCELAR.',
        'destinos_permitidos', jsonb_build_array('RETENCAO_CANCELAMENTO'));
    END IF;

    UPDATE public.pedidos
    SET status_comercial = 'cancelado',
        status_operacional = 'cancelado',
        cancelado_por_expiracao = true,
        requer_revisao_financeira = false,
        bloqueado_por_overbooking_tardio = false,
        motivo_revisao_financeira = NULL,
        observacoes_internas = CONCAT_WS(E'\n', observacoes_internas,
          CASE WHEN COALESCE(valor_pago, 0) > 0 THEN '[RETENÇÃO DE CANCELAMENTO] R$ ' || valor_pago || ' retidos em ' || (NOW() AT TIME ZONE v_cfg.timezone)::DATE || ' por ' || v_user_nome || ': ' || p_motivo END),
        updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
    VALUES (p_pedido_id, 'comercial', v_status_com_anterior, 'cancelado', auth.uid(), v_user_nome, 'admin',
            jsonb_build_object('acao', v_acao, 'motivo', p_motivo, 'destino_valor', CASE WHEN COALESCE(v_ped.valor_pago, 0) > 0 THEN 'RETENCAO_CANCELAMENTO' ELSE NULL END, 'valor_retido', COALESCE(v_ped.valor_pago, 0)));

    RETURN json_build_object('success', true, 'acao', v_acao, 'pedido_id', p_pedido_id, 'valor_retido', COALESCE(v_ped.valor_pago, 0));
  END IF;

  RETURN json_build_object('success', false, 'error', 'Ação não processada.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.resolver_revisao_encomenda_admin(BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolver_revisao_encomenda_admin(BIGINT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC ATUALIZAR_MEUS_DADOS_CLIENTE (HARDENING: SEM auth NO search_path)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atualizar_meus_dados_cliente(
  p_nome TEXT DEFAULT NULL,
  p_telefone TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_endereco_padrao JSONB DEFAULT NULL,
  p_data_nascimento DATE DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tel_norm TEXT;
  v_cliente_id BIGINT;
  v_outro BIGINT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('success', false, 'code', 'UNAUTHENTICATED', 'error', 'É necessário estar autenticado.');
  END IF;

  IF p_nome IS NOT NULL AND length(TRIM(p_nome)) < 2 THEN
    RETURN json_build_object('success', false, 'error', 'Nome inválido.');
  END IF;

  IF p_telefone IS NOT NULL THEN
    v_tel_norm := regexp_replace(p_telefone, '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    ELSIF length(v_tel_norm) < 12 OR length(v_tel_norm) > 13 THEN
      RETURN json_build_object('success', false, 'error', 'Telefone inválido. Informe DDD + número.');
    END IF;
  END IF;

  SELECT id INTO v_cliente_id FROM public.clientes WHERE auth_user_id = v_uid FOR UPDATE;

  IF v_tel_norm IS NOT NULL THEN
    SELECT id INTO v_outro FROM public.clientes
    WHERE telefone_normalizado = v_tel_norm AND (v_cliente_id IS NULL OR id <> v_cliente_id)
    LIMIT 1;
    IF v_outro IS NOT NULL THEN
      RETURN json_build_object('success', false, 'code', 'PHONE_ALREADY_IN_USE',
        'error', 'Este número de telefone já pertence a outro cadastro no sistema.');
    END IF;
  END IF;

  IF v_cliente_id IS NULL THEN
    IF p_nome IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Nome é obrigatório para criar seu cadastro.');
    END IF;
    INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email, endereco_padrao, data_nascimento)
    VALUES (v_uid, TRIM(p_nome), NULLIF(TRIM(p_telefone), ''), v_tel_norm, NULLIF(TRIM(p_email), ''), COALESCE(p_endereco_padrao, '{}'::jsonb), p_data_nascimento)
    RETURNING id INTO v_cliente_id;
  ELSE
    -- Campos de CRM (observacoes, origem) são intocáveis pelo cliente
    UPDATE public.clientes
    SET nome = COALESCE(NULLIF(TRIM(p_nome), ''), nome),
        telefone = CASE WHEN p_telefone IS NOT NULL THEN NULLIF(TRIM(p_telefone), '') ELSE telefone END,
        telefone_normalizado = CASE WHEN p_telefone IS NOT NULL THEN v_tel_norm ELSE telefone_normalizado END,
        email = COALESCE(NULLIF(TRIM(p_email), ''), email),
        endereco_padrao = COALESCE(p_endereco_padrao, endereco_padrao),
        data_nascimento = COALESCE(p_data_nascimento, data_nascimento),
        updated_at = NOW()
    WHERE id = v_cliente_id;
  END IF;

  RETURN json_build_object('success', true, 'cliente_id', v_cliente_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.atualizar_meus_dados_cliente(TEXT, TEXT, TEXT, JSONB, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atualizar_meus_dados_cliente(TEXT, TEXT, TEXT, JSONB, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10. REAGENDAR_ENCOMENDA_ADMIN (TIMEZONE/CAPACIDADE DINÂMICOS, HOLDS VENCIDOS IGNORADOS)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reagendar_encomenda_admin(
  p_pedido_id BIGINT,
  p_nova_data DATE,
  p_nova_hora TIME DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_ped RECORD;
  v_user_nome TEXT;
  v_data_antiga DATE;
  v_primeira_data DATE;
  v_segunda_data DATE;
  v_cap_nova public.capacidade_producao;
  v_pts_pedido NUMERIC(8,2) := 0.00;
  v_pts_ocupados_nova NUMERIC(8,2) := 0.00;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas equipe autorizada pode reagendar encomendas.');
  END IF;

  IF p_pedido_id IS NULL OR p_nova_data IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido e nova data são obrigatórios.');
  END IF;

  IF p_motivo IS NULL OR length(TRIM(p_motivo)) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'Por favor, informe a justificativa do reagendamento.');
  END IF;

  -- 1. LOCK DO PEDIDO
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Encomenda não encontrada.');
  END IF;

  IF v_ped.status_comercial = 'cancelado' THEN
    RETURN json_build_object('success', false, 'error', 'Não é possível reagendar uma encomenda cancelada.');
  END IF;

  IF v_ped.requer_revisao_financeira THEN
    RETURN json_build_object('success', false, 'code', 'IN_REVIEW', 'error', 'Encomenda em revisão financeira. Resolva a revisão antes de reagendar.');
  END IF;

  v_data_antiga := v_ped.data_entrega;
  IF v_data_antiga = p_nova_data AND (p_nova_hora IS NULL OR v_ped.hora_entrega = p_nova_hora) THEN
    RETURN json_build_object('success', true, 'message', 'A encomenda já estava agendada para este horário.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  v_pts_pedido := GREATEST(public.pontos_pedido(p_pedido_id), 1.00);

  -- 2. Datas em ordem determinística (anti-deadlock), inicialização e locks ordenados
  v_primeira_data := LEAST(v_data_antiga, p_nova_data);
  v_segunda_data := GREATEST(v_data_antiga, p_nova_data);

  INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
  VALUES (v_primeira_data, v_cfg.capacidade_padrao_pontos), (v_segunda_data, v_cfg.capacidade_padrao_pontos)
  ON CONFLICT (data) DO NOTHING;

  PERFORM 1 FROM public.capacidade_producao WHERE data = v_primeira_data FOR UPDATE;
  PERFORM 1 FROM public.capacidade_producao WHERE data = v_segunda_data FOR UPDATE;

  SELECT * INTO v_cap_nova FROM public.capacidade_producao WHERE data = p_nova_data;

  -- 3. Carga da nova data (excluindo este pedido; holds vencidos não ocupam)
  v_pts_ocupados_nova := public.pontos_ocupados_data(p_nova_data, p_pedido_id);

  IF v_cap_nova.bloqueado = true OR (v_pts_ocupados_nova + v_pts_pedido) > v_cap_nova.capacidade_maxima_pontos THEN
    IF p_forcar_encaixe = true AND public.is_admin() AND (p_motivo_encaixe IS NOT NULL AND length(TRIM(p_motivo_encaixe)) >= 3) THEN
      NULL;
    ELSE
      RETURN json_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', p_nova_data,
        'capacidade_maxima', v_cap_nova.capacidade_maxima_pontos,
        'pontos_ocupados', v_pts_ocupados_nova,
        'pontos_solicitados', v_pts_pedido,
        'error', 'Capacidade de produção excedida para a nova data ' || p_nova_data || ' (' || v_pts_ocupados_nova || '/' || v_cap_nova.capacidade_maxima_pontos || ' pts ocupados).'
      );
    END IF;
  END IF;

  -- 4. Atualização (hold pendente é recalculado se a nova entrega encurtar o prazo)
  UPDATE public.pedidos
  SET data_entrega = p_nova_data,
      hora_entrega = COALESCE(p_nova_hora, hora_entrega),
      confirmacao_expires_at = CASE
        WHEN status_comercial = 'aguardando_confirmacao' AND confirmacao_expires_at IS NOT NULL THEN
          LEAST(confirmacao_expires_at,
                (((p_nova_data + COALESCE(p_nova_hora, hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_cfg.timezone)
                  - make_interval(hours => v_cfg.antecedencia_confirmacao_horas))
        ELSE confirmacao_expires_at
      END,
      updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_id, usuario_nome, origem, metadata)
  VALUES (p_pedido_id, 'operacional', v_data_antiga::TEXT, p_nova_data::TEXT, auth.uid(), v_user_nome, 'admin',
          jsonb_build_object('acao', 'reagendamento', 'data_anterior', v_data_antiga, 'data_nova', p_nova_data, 'hora_nova', p_nova_hora,
                             'motivo', p_motivo, 'pontos_carga', v_pts_pedido, 'forcar_encaixe', p_forcar_encaixe, 'motivo_encaixe', p_motivo_encaixe, 'timezone', v_cfg.timezone));

  RETURN json_build_object('success', true, 'pedido_id', p_pedido_id, 'data_anterior', v_data_antiga, 'data_nova', p_nova_data, 'pontos_carga', v_pts_pedido);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reagendar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reagendar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 11. OBTER_RESUMO_OPERACAO_HOJE (TIMEZONE DINÂMICO + CONTADOR DE REVISÕES)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_resumo_operacao_hoje()
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_hoje DATE;
  v_encomendas_qtd INT := 0;
  v_valor_encomendas NUMERIC(10,2) := 0.00;
  v_saldo_encomendas NUMERIC(10,2) := 0.00;
  v_recebido_caixa NUMERIC(10,2) := 0.00;
  v_estornos_caixa NUMERIC(10,2) := 0.00;
  v_entregas_qtd INT := 0;
  v_retiradas_qtd INT := 0;
  v_pendentes_sinal_qtd INT := 0;
  v_revisao_qtd INT := 0;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  v_hoje := (NOW() AT TIME ZONE v_cfg.timezone)::DATE;

  SELECT COUNT(*), COALESCE(SUM(total), 0.00), COALESCE(SUM(saldo), 0.00),
         COUNT(*) FILTER (WHERE modalidade_entrega = 'entrega'),
         COUNT(*) FILTER (WHERE modalidade_entrega = 'retirada'),
         COUNT(*) FILTER (WHERE status_comercial = 'aguardando_confirmacao' AND sinal_minimo > 0)
  INTO v_encomendas_qtd, v_valor_encomendas, v_saldo_encomendas, v_entregas_qtd, v_retiradas_qtd, v_pendentes_sinal_qtd
  FROM public.pedidos
  WHERE data_entrega = v_hoje AND status_comercial <> 'cancelado';

  SELECT COUNT(*) INTO v_revisao_qtd FROM public.pedidos
  WHERE requer_revisao_financeira = true AND status_comercial <> 'cancelado';

  SELECT COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0.00),
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND categoria = 'Estornos'), 0.00)
  INTO v_recebido_caixa, v_estornos_caixa
  FROM public.financeiro_lancamentos
  WHERE data_lancamento = v_hoje;

  RETURN json_build_object(
    'success', true,
    'data_referencia', v_hoje,
    'fuso_horario', v_cfg.timezone,
    'encomendas_hoje_qtd', v_encomendas_qtd,
    'valor_encomendas_hoje', v_valor_encomendas,
    'saldo_encomendas_hoje', v_saldo_encomendas,
    'recebimentos_caixa_hoje', v_recebido_caixa,
    'estornos_caixa_hoje', v_estornos_caixa,
    'caixa_liquido_hoje', v_recebido_caixa - v_estornos_caixa,
    'entregas_hoje_qtd', v_entregas_qtd,
    'retiradas_hoje_qtd', v_retiradas_qtd,
    'pendentes_sinal_qtd', v_pendentes_sinal_qtd,
    'revisao_financeira_qtd', v_revisao_qtd
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_resumo_operacao_hoje FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_resumo_operacao_hoje TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 12. OBTER_AGENDA_ENCOMENDAS (TIMEZONE DINÂMICO, HOLDS VENCIDOS NÃO OCUPAM)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_agenda_encomendas(
  p_inicio DATE,
  p_fim DATE
)
RETURNS JSON AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_inicio DATE;
  v_fim DATE;
  v_resultados JSONB;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada.');
  END IF;

  v_inicio := COALESCE(p_inicio, (NOW() AT TIME ZONE v_cfg.timezone)::DATE);
  v_fim := COALESCE(p_fim, (v_inicio + INTERVAL '30 days')::DATE);

  SELECT jsonb_agg(sub) INTO v_resultados
  FROM (
    SELECT
      d.data,
      COALESCE(ped_stats.total_pedidos, 0) AS total_pedidos,
      COALESCE(ped_stats.valor_total, 0.00) AS valor_total,
      COALESCE(ped_stats.pontos_ocupados, 0.00) AS pontos_ocupados,
      COALESCE(cap.capacidade_maxima_pontos, v_cfg.capacidade_padrao_pontos) AS capacidade_maxima,
      COALESCE(cap.bloqueado, false) AS bloqueado,
      cap.motivo_bloqueio
    FROM generate_series(v_inicio, v_fim, INTERVAL '1 day') AS d(data)
    LEFT JOIN public.capacidade_producao cap ON cap.data = d.data::DATE
    LEFT JOIN (
      -- Estatísticas por pedido (evita multiplicar o total pelo nº de itens)
      SELECT
        ped.data_entrega,
        COUNT(*) AS total_pedidos,
        SUM(ped.total) AS valor_total,
        SUM(pp.pts) AS pontos_ocupados
      FROM public.pedidos ped
      JOIN LATERAL (SELECT public.pontos_pedido(ped.id) AS pts) pp ON true
      WHERE ped.data_entrega BETWEEN v_inicio AND v_fim
        AND public.pedido_ocupa_capacidade(ped.status_comercial, ped.confirmacao_expires_at)
      GROUP BY ped.data_entrega
    ) ped_stats ON ped_stats.data_entrega = d.data::DATE
    ORDER BY d.data ASC
  ) sub;

  RETURN json_build_object(
    'success', true,
    'inicio', v_inicio,
    'fim', v_fim,
    'fuso_horario', v_cfg.timezone,
    'dias', COALESCE(v_resultados, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_agenda_encomendas(DATE, DATE) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 14. HOTFIX CRIAR_PEDIDO (LOJA ONLINE): alias ambíguo "value" quebrava o checkout
-- --------------------------------------------------------------------------
-- Em 009/baseline, `jsonb_array_elements(...) value` dava ao alias de tabela o mesmo
-- nome da coluna gerada, e o PostgreSQL rejeita `SELECT value` com
-- "column reference \"value\" is ambiguous" — para QUALQUER item do carrinho.
-- Detectado pelo teste de integração real (tests/integration). Corrigido com alias explícito.
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
  v_pedido_item_id BIGINT;
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_preco_opcao_real NUMERIC(10,2);
  v_tipo_opcao TEXT;
  v_adicionais_item NUMERIC(10,2);
  v_cfg public.configuracoes_operacao;
  v_produto_ids BIGINT[];
  v_linha RECORD;
  v_opt_rec RECORD;
  v_pts_prod NUMERIC(6,2);
  v_opcoes_canon JSONB;
  v_reserva JSON;
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

  -- 3. Tolerância de pagamento PIX/cartão: única fonte da verdade = configuracoes_operacao.hold_pix_loja_minutos
  v_cfg := public.obter_config_operacao();
  v_expires_at := NOW() + make_interval(mins => GREATEST(1, COALESCE(v_cfg.hold_pix_loja_minutos, 30)));

  -- 4. ORDEM GLOBAL DE LOCKS (pedido ainda não existe): produtos em id ASC, numa única consulta
  SELECT array_agg(DISTINCT pid ORDER BY pid)
  INTO v_produto_ids
  FROM (
    SELECT (it->>'id')::BIGINT AS pid
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  ) ids;

  IF v_produto_ids IS NULL OR array_length(v_produto_ids, 1) IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Nenhum item válido informado.');
  END IF;

  PERFORM 1 FROM public.produtos WHERE id = ANY(v_produto_ids) ORDER BY id FOR UPDATE;

  -- 4.1 Validação AGREGADA por produto (disponibilidade e anti-hoarding sobre a soma de todas as linhas)
  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      SUM(GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)))::INTEGER AS quantidade
    FROM jsonb_array_elements(p_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    GROUP BY (it->>'id')::BIGINT
    ORDER BY (it->>'id')::BIGINT
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    IF v_cliente_id IS NULL AND v_qtd > 50 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Quantidade máxima por item para checkout rápido sem cadastro é de 50 unidades. Para encomendas maiores, acesse sua conta ou entre em contato.'
      );
    END IF;

    SELECT id, nome, preco, ativo, opcoes, estoque_fisico, estoque_reservado, controlar_estoque
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN json_build_object('success', false, 'error', 'Um dos produtos selecionados não está mais disponível.');
    END IF;

    IF v_prod.controlar_estoque IS NOT FALSE THEN
      v_disponivel := GREATEST(0, COALESCE(v_prod.estoque_fisico, 0) - COALESCE(v_prod.estoque_reservado, 0));
      IF v_disponivel < v_qtd THEN
        RETURN json_build_object(
          'success', false,
          'code', 'INSUFFICIENT_STOCK',
          'error', 'Estoque esgotado ou insuficiente para "' || v_prod.nome || '". Disponível no momento: apenas ' || v_disponivel || ' unidade(s).'
        );
      END IF;
    END IF;

    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  -- 4.2 Validação POR LINHA (cada linha configurada é uma unidade lógica: produto + conjunto de opções)
  --     Opções fail-closed; preços SEMPRE do catálogo; totais e itens_json canônico.
  FOR v_linha IN
    SELECT
      ord,
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      CASE WHEN jsonb_typeof(it->'opcoes') = 'array' THEN it->'opcoes' ELSE '[]'::jsonb END AS opcoes
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(it, ord)
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    ORDER BY ord
  LOOP
    SELECT id, nome, preco, opcoes INTO v_prod FROM public.produtos WHERE id = v_linha.produto_id;
    v_adicionais_item := 0.00;
    v_opcoes_canon := '[]'::jsonb;

    FOR v_opcao IN SELECT opt.value FROM jsonb_array_elements(v_linha.opcoes) AS opt(value) LOOP
      v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
      IF v_opcao_nome <> '' THEN
        SELECT COALESCE(preco_adicional, 0.00), categoria
        INTO v_preco_opcao_real, v_tipo_opcao
        FROM public.produto_opcoes
        WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
        LIMIT 1;

        IF NOT FOUND THEN
          IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
            v_preco_opcao_real := 0.00;
          ELSE
            RETURN json_build_object(
              'success', false,
              'code', 'INVALID_PRODUCT_OPTION',
              'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '". Por favor, selecione as opções disponíveis no cardápio.',
              'produto_id', v_prod.id,
              'opcao', v_opcao_nome
            );
          END IF;
        END IF;

        v_adicionais_item := v_adicionais_item + v_preco_opcao_real;
        v_opcoes_canon := v_opcoes_canon || jsonb_build_object('nome', v_opcao_nome, 'preco_adicional', v_preco_opcao_real);
      END IF;
    END LOOP;

    v_total := v_total + ((v_prod.preco + v_adicionais_item) * v_linha.quantidade);

    v_itens_json_canonical := v_itens_json_canonical || jsonb_build_object(
      'id', v_prod.id,
      'nome', v_prod.nome,
      'quantidade', v_linha.quantidade,
      'preco', v_prod.preco,
      'preco_unitario', v_prod.preco + v_adicionais_item,
      'subtotal', (v_prod.preco + v_adicionais_item) * v_linha.quantidade,
      'opcoes', v_opcoes_canon
    );
  END LOOP;

  -- 5. Validação e cálculo estrito da taxa de entrega no servidor
  IF LOWER(COALESCE(p_modalidade, 'entrega')) = 'retirada' THEN
    v_taxa := 0.00;
  ELSE
    v_taxa := 10.00;
  END IF;

  v_total := v_total + v_taxa;

  -- 6. ETAPA 2: Gravação do Pedido primeiro com dados do Confectionery OS
  INSERT INTO public.pedidos (
    cliente_id,
    nome_cliente,
    email_cliente,
    telefone_cliente,
    data_pedido,
    data_entrega,
    subtotal,
    desconto,
    total,
    taxa_entrega,
    valor_pago,
    saldo,
    modalidade_entrega,
    canal,
    pagamento,
    status_comercial,
    status_financeiro,
    status_operacional,
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
    (v_total - v_taxa),
    0.00,
    v_total,
    v_taxa,
    0.00,
    v_total,
    COALESCE(p_modalidade, 'entrega'),
    'loja_online',
    p_pagamento,
    'aguardando_confirmacao',
    'nao_pago',
    'aguardando_producao',
    'Pendente',
    'aguardando_pagamento',
    'recebido',
    v_expires_at,
    array_to_string(v_nomes_itens, ' + '),
    v_itens_json_canonical,
    p_endereco_entrega
  ) RETURNING id, checkout_token INTO v_pedido_id, v_checkout_token;

  -- 7. ETAPA 3: pedido_itens POR LINHA com snapshots de produção (Etapa 2) e opções vinculadas ao catálogo
  FOR v_linha IN
    SELECT
      ord,
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      CASE WHEN jsonb_typeof(it->'opcoes') = 'array' THEN it->'opcoes' ELSE '[]'::jsonb END AS opcoes
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(it, ord)
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    ORDER BY ord
  LOOP
    SELECT id, nome, preco, opcoes, pontos_producao INTO v_prod FROM public.produtos WHERE id = v_linha.produto_id;
    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_adicionais_item := 0.00;

    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, unidade,
      preco_base_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal,
      pontos_producao_snapshot
    ) VALUES (
      v_pedido_id, v_prod.id, v_prod.nome, v_linha.quantidade, 'un',
      v_prod.preco, 0.00, v_prod.preco, (v_prod.preco * v_linha.quantidade),
      v_pts_prod
    ) RETURNING id INTO v_pedido_item_id;

    FOR v_opcao IN SELECT opt.value FROM jsonb_array_elements(v_linha.opcoes) AS opt(value) LOOP
      v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
      IF v_opcao_nome <> '' THEN
        SELECT id, COALESCE(preco_adicional, 0.00) AS preco_adicional, categoria, COALESCE(pontos_producao_adicionais, 0.00) AS pontos_producao_adicionais
        INTO v_opt_rec
        FROM public.produto_opcoes
        WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
        LIMIT 1;

        IF FOUND THEN
          INSERT INTO public.pedido_item_opcoes (pedido_item_id, produto_opcao_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot)
          VALUES (v_pedido_item_id, v_opt_rec.id, v_opt_rec.categoria, v_opcao_nome, v_opt_rec.preco_adicional, v_opt_rec.pontos_producao_adicionais);
          v_adicionais_item := v_adicionais_item + v_opt_rec.preco_adicional;
        ELSIF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
          INSERT INTO public.pedido_item_opcoes (pedido_item_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot)
          VALUES (v_pedido_item_id, 'outro', v_opcao_nome, 0.00, 0.00);
        ELSE
          RAISE EXCEPTION 'Opção % não é válida para o produto %', v_opcao_nome, v_prod.nome;
        END IF;
      END IF;
    END LOOP;

    IF v_adicionais_item > 0 THEN
      UPDATE public.pedido_itens
      SET preco_adicionais = v_adicionais_item,
          preco_unitario_snapshot = preco_base_snapshot + v_adicionais_item,
          subtotal = (preco_base_snapshot + v_adicionais_item) * quantidade
      WHERE id = v_pedido_item_id;
    END IF;
  END LOOP;

  -- 7.1 RESERVA DE ESTOQUE pelo helper canônico (agrega por produto; flag reserva_estoque_ativa por item)
  v_reserva := public.reservar_estoque_itens_pedido(
    v_pedido_id,
    'Reserva temporária para novo pedido #' || v_pedido_id || ' (tolerância ' || GREATEST(1, COALESCE(v_cfg.hold_pix_loja_minutos, 30)) || ' min)',
    true
  );
  IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
    RAISE EXCEPTION 'Falha ao reservar estoque do pedido #%: %', v_pedido_id, COALESCE(v_reserva->>'error', 'estoque insuficiente');
  END IF;

  -- 8. Gravação do Histórico Inicial
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo, origem, metadata
  ) VALUES 
    (v_pedido_id, 'comercial', NULL, 'aguardando_confirmacao', 'cliente', jsonb_build_object('canal', 'loja_online')),
    (v_pedido_id, 'financeiro', NULL, 'nao_pago', 'cliente', jsonb_build_object('forma', p_pagamento)),
    (v_pedido_id, 'operacional', NULL, 'aguardando_producao', 'cliente', jsonb_build_object('modalidade', p_modalidade));

  RETURN json_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'subtotal', (v_total - v_taxa),
    'total', v_total,
    'taxa_entrega', v_taxa,
    'checkout_token', v_checkout_token,
    'expires_at', v_expires_at
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 13. NOTAS DE ESCOPO
-- --------------------------------------------------------------------------
-- * Políticas RLS de escrita em produtos/produto_opcoes NÃO foram restringidas a admin
--   nesta migration: a Etapa 2 concede a aba "Produtos" a operadores e a mudança
--   quebraria esse fluxo. Decisão registrada para avaliação explícita.
-- * Crédito de cliente (CREDITO_CLIENTE) fica para migration própria.


-- ==========================================================================
-- >>> MIGRATION 012_hardening_politicas_e_nucleo.sql
-- ==========================================================================

-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 012: HARDENING PRÉ-ETAPA 3 & NÚCLEO CANÔNICO
-- ==========================================================================
-- Decisões Arquiteturais Consolidadas:
-- 1. Loja Online permanece isolada em criar_pedido() (guest/PIX hold curto/carrinho).
-- 2. nucleo_criar_encomenda() atende estritamente a Encomenda Administrativa e Conversão de Orçamento.
-- 3. Funções de política comercial (politica_desconto, politica_sinal, validar_modalidade_frete)
--    resolvem internamente o papel do ator (is_admin / is_admin_or_operator), NUNCA aceitando p_is_admin por parâmetro.
-- 4. Frete completo: taxa_entrega_base, taxa_entrega_cobrada, desconto_frete.
-- 5. pedidos.orcamento_origem_id BIGINT UNIQUE para rastreabilidade bidirecional direta.
-- 6. configuracoes_operacao com parâmetros para orçamentos e frete padrão.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. EXPANSÃO DE CONFIGURACOES_OPERACAO & PEDIDOS
-- --------------------------------------------------------------------------
ALTER TABLE public.configuracoes_operacao
  ADD COLUMN IF NOT EXISTS validade_orcamento_horas INT NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS antecedencia_minima_orcamento_horas INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS janela_conversao_horas INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS taxa_entrega_padrao NUMERIC(10,2) NOT NULL DEFAULT 15.00;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS orcamento_origem_id BIGINT UNIQUE,
  ADD COLUMN IF NOT EXISTS taxa_entrega_base NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS taxa_entrega_cobrada NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS desconto_frete NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS motivo_desconto TEXT;

ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_canal_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_canal_check CHECK (canal IN ('loja_online', 'whatsapp', 'balcao', 'telefone', 'orcamento'));

CREATE INDEX IF NOT EXISTS idx_pedidos_orcamento_origem_id ON public.pedidos(orcamento_origem_id) WHERE orcamento_origem_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 2. POLÍTICA DE DESCONTO COMPARTILHADA (SEM p_is_admin EXTERNO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.politica_desconto(
  p_subtotal NUMERIC,
  p_desconto NUMERIC,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_subtotal NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_subtotal, 0.00));
  v_desc NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  v_pct NUMERIC(6,2) := 0.00;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode aplicar descontos.');
  END IF;

  IF v_desc <= 0.00 THEN
    RETURN jsonb_build_object(
      'success', true,
      'desconto_aprovado', 0.00,
      'percentual', 0.00,
      'excecao_admin', false,
      'motivo', NULL
    );
  END IF;

  IF v_subtotal <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_SUBTOTAL', 'error', 'Subtotal dos produtos inválido para cálculo de desconto.');
  END IF;

  IF v_desc > v_subtotal THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_EXCEEDS_SUBTOTAL', 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  v_pct := ROUND((v_desc / v_subtotal) * 100.0, 2);

  -- Teto de operador: 10% do subtotal
  IF v_pct > 10.00 AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED',
      'teto_operador_valor', ROUND(v_subtotal * 0.10, 2),
      'error', 'Operadores podem conceder no máximo 10% de desconto (R$ ' || (v_subtotal * 0.10)::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  -- Justificativa auditável obrigatória para QUALQUER desconto > 0 (operador ou admin) (D3)
  IF v_desc > 0.00 AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_REASON_REQUIRED', 'error', 'Por favor, informe a justificativa do desconto concedido (mínimo 5 caracteres).');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'desconto_aprovado', v_desc,
    'percentual', v_pct,
    'excecao_admin', (v_pct > 10.00),
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_desconto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_desconto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. POLÍTICA DE SINAL MÍNIMO COMPARTILHADA (SEM p_is_admin EXTERNO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.politica_sinal(
  p_total NUMERIC,
  p_sinal_solicitado NUMERIC DEFAULT NULL,
  p_forcar_reducao BOOLEAN DEFAULT FALSE,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_total NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_total, 0.00));
  v_sinal_padrao NUMERIC(10,2);
  v_sinal_final NUMERIC(10,2);
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada para avaliar política de sinal.');
  END IF;

  v_sinal_padrao := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);

  -- Dispensar sinal por completo (p_forcar_reducao)
  IF p_forcar_reducao = true THEN
    IF NOT v_is_admin THEN
      RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas Administradores podem dispensar a exigência de sinal mínimo.');
    END IF;
    IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
      RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'Informe o motivo para autorizar a confirmação da encomenda sem sinal (mínimo 5 caracteres).');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'sinal_minimo', 0.00,
      'sinal_padrao', v_sinal_padrao,
      'dispensado', true,
      'motivo', v_motivo
    );
  END IF;

  -- Redução parcial de sinal
  IF v_is_admin THEN
    v_sinal_final := CASE WHEN COALESCE(p_sinal_solicitado, 0.00) <= 0.00 THEN v_sinal_padrao ELSE p_sinal_solicitado END;
    IF v_sinal_final < v_sinal_padrao AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'SIGNAL_REDUCTION_REQUIRES_REASON',
        'sinal_padrao', v_sinal_padrao,
        'error', 'Reduzir o sinal mínimo abaixo do padrão (R$ ' || v_sinal_padrao || ', ' || v_cfg.sinal_percentual_padrao || '% do total) exige justificativa (mínimo 5 caracteres).'
      );
    END IF;
  ELSE
    -- Operador: NUNCA abaixo do padrão
    v_sinal_final := GREATEST(v_sinal_padrao, COALESCE(p_sinal_solicitado, 0.00));
  END IF;

  v_sinal_final := ROUND(v_sinal_final, 2);

  RETURN jsonb_build_object(
    'success', true,
    'sinal_minimo', v_sinal_final,
    'sinal_padrao', v_sinal_padrao,
    'dispensado', false,
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_sinal FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_sinal TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. VALIDAÇÃO DE MODALIDADE E FRETE COMPARTILHADA
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validar_modalidade_frete(
  p_modalidade TEXT,
  p_taxa_informada NUMERIC DEFAULT 0.00,
  p_endereco TEXT DEFAULT NULL,
  p_desconto_frete NUMERIC DEFAULT 0.00,
  p_motivo_frete TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_mod TEXT := LOWER(TRIM(COALESCE(p_modalidade, 'retirada')));
  v_taxa_base NUMERIC(10,2) := 0.00;
  v_taxa_cobrada NUMERIC(10,2) := 0.00;
  v_desc_frete NUMERIC(10,2) := 0.00;
  v_end TEXT := NULLIF(TRIM(COALESCE(p_endereco, '')), '');
BEGIN
  IF v_mod = 'retirada' THEN
    RETURN jsonb_build_object(
      'success', true,
      'modalidade', 'retirada',
      'taxa_entrega_base', 0.00,
      'taxa_entrega_cobrada', 0.00,
      'desconto_frete', 0.00,
      'endereco_entrega', NULL
    );
  ELSIF v_mod = 'entrega' THEN
    IF v_end IS NULL OR length(v_end) < 5 THEN
      RETURN jsonb_build_object('success', false, 'code', 'ADDRESS_REQUIRED_FOR_DELIVERY', 'error', 'Para entrega em domicílio, o endereço completo é obrigatório.');
    END IF;

    -- Se não informada ou zero, usa a taxa padrão da configuração
    v_taxa_base := CASE 
      WHEN p_taxa_informada IS NOT NULL AND p_taxa_informada > 0.00 THEN ROUND(p_taxa_informada, 2)
      ELSE COALESCE(v_cfg.taxa_entrega_padrao, 15.00)
    END;

    v_desc_frete := GREATEST(0.00, COALESCE(p_desconto_frete, 0.00));
    IF v_desc_frete > v_taxa_base THEN
      v_desc_frete := v_taxa_base;
    END IF;

    -- Governança de frete: desconto requer motivo; frete 100% grátis requer perfil Admin
    IF v_desc_frete > 0.00 AND (p_motivo_frete IS NULL OR length(trim(p_motivo_frete)) < 5) THEN
      RETURN jsonb_build_object('success', false, 'code', 'SHIPPING_DISCOUNT_REASON_REQUIRED', 'error', 'Informe a justificativa do desconto de frete (mínimo 5 caracteres).');
    END IF;

    IF v_desc_frete >= v_taxa_base AND v_taxa_base > 0.00 AND NOT public.is_admin() THEN
      RETURN jsonb_build_object('success', false, 'code', 'OPERATOR_FREE_SHIPPING_NOT_ALLOWED', 'error', 'Operadores não podem conceder frete 100% grátis. Ação restrita a Administradores.');
    END IF;

    v_taxa_cobrada := GREATEST(0.00, v_taxa_base - v_desc_frete);

    RETURN jsonb_build_object(
      'success', true,
      'modalidade', 'entrega',
      'taxa_entrega_base', v_taxa_base,
      'taxa_entrega_cobrada', v_taxa_cobrada,
      'desconto_frete', v_desc_frete,
      'endereco_entrega', v_end
    );
  ELSE
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MODALITY', 'error', 'Modalidade de entrega inválida. Use retirada ou entrega.');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.validar_modalidade_frete FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validar_modalidade_frete TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 5. NÚCLEO CANÔNICO DE ENCOMENDAS: NUCLEO_CRIAR_ENCOMENDA()
-- --------------------------------------------------------------------------
-- Atende estritamente a criar_encomenda_admin() e converter_orcamento_em_pedido().
-- Loja Online permanece isolada em criar_pedido().
-- Ordem de locks: capacidade/data -> produtos (id ASC) -> INSERT pedido -> itens -> reserva -> pagamentos.
CREATE OR REPLACE FUNCTION public.nucleo_criar_encomenda(
  p_dados JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_tz TEXT := v_cfg.timezone;
  v_user_nome TEXT;
  
  -- Cliente
  v_cliente_id_in BIGINT := (p_dados->>'cliente_id')::BIGINT;
  v_cliente_nome_in TEXT := TRIM(COALESCE(p_dados->>'cliente_nome', ''));
  v_cliente_tel_in TEXT := TRIM(COALESCE(p_dados->>'cliente_telefone', ''));
  v_cliente_email_in TEXT := TRIM(COALESCE(p_dados->>'cliente_email', ''));
  v_cliente_id_final BIGINT;
  v_cliente_nome_final TEXT;
  v_cliente_tel_final TEXT;
  v_cliente_email_final TEXT;
  v_tel_norm TEXT;

  -- Logística
  v_canal TEXT := LOWER(TRIM(COALESCE(p_dados->>'canal', 'balcao')));
  v_data_entrega DATE := (p_dados->>'data_entrega')::DATE;
  v_hora_entrega TIME := CASE WHEN (p_dados->>'hora_entrega') IS NOT NULL AND (p_dados->>'hora_entrega') <> '' THEN (p_dados->>'hora_entrega')::TIME ELSE NULL END;
  v_modalidade_in TEXT := COALESCE(p_dados->>'modalidade', 'retirada');
  v_endereco_in TEXT := p_dados->>'endereco_entrega';
  v_frete_val JSONB;

  -- Itens e Totais
  v_itens JSONB := COALESCE(p_dados->'itens', '[]'::jsonb);
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_exc_hint TEXT;
  v_exc_detail TEXT;
  v_pts_pedido_total NUMERIC(8,2) := 0.00;
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_nomes_itens TEXT[] := ARRAY[]::TEXT[];
  v_produto_ids BIGINT[] := ARRAY[]::BIGINT[];

  -- Desconto e Sinal (via políticas compartilhadas)
  v_desc_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto')::NUMERIC, 0.00));
  v_motivo_desc TEXT := p_dados->>'motivo_desconto';
  v_desc_pol JSONB;
  v_sinal_pol JSONB;
  v_sinal_min NUMERIC(10,2) := 0.00;
  v_sinal_pago NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'sinal_valor')::NUMERIC, 0.00));
  v_sinal_metodo TEXT := LOWER(TRIM(COALESCE(p_dados->>'sinal_metodo', 'pix')));
  v_sinal_comp TEXT := p_dados->>'sinal_comprovante';
  v_forcar_confirm_sem_sinal BOOLEAN := COALESCE((p_dados->>'forcar_confirmacao_sem_sinal')::BOOLEAN, false);
  v_motivo_sem_sinal TEXT := p_dados->>'motivo_confirmacao_sem_sinal';
  v_saldo_venc DATE := CASE WHEN (p_dados->>'saldo_vencimento') IS NOT NULL AND (p_dados->>'saldo_vencimento') <> '' THEN (p_dados->>'saldo_vencimento')::DATE ELSE NULL END;

  -- Capacidade & Encaixe
  v_forcar_encaixe BOOLEAN := COALESCE((p_dados->>'forcar_encaixe')::BOOLEAN, false);
  v_motivo_encaixe TEXT := p_dados->>'motivo_encaixe';
  v_cap public.capacidade_producao;
  v_pontos_ocupados_atuais NUMERIC(8,2) := 0.00;

  -- Estados
  v_status_com_inicial TEXT;
  v_status_fin_inicial TEXT := 'nao_pago';
  v_status_oper_inicial TEXT := 'aguardando_producao';
  v_entrega_at TIMESTAMPTZ;
  v_confirmacao_expires_at TIMESTAMPTZ;

  -- Identificação e Destino
  v_orcamento_origem_id BIGINT := (p_dados->>'orcamento_origem_id')::BIGINT;
  v_pedido_id BIGINT;
  v_item_id BIGINT;
  v_reserva JSON;
  v_pagamento_id BIGINT;
BEGIN
  -- 1. RBAC
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode registrar encomendas.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 2. Canal e Data
  IF v_canal NOT IN ('balcao', 'whatsapp', 'telefone', 'orcamento') THEN
    v_canal := 'balcao';
  END IF;

  IF v_data_entrega IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'DATE_REQUIRED', 'error', 'Data de entrega/retirada é obrigatória.');
  END IF;

  -- 3. Modalidade e Frete (via função compartilhada)
  v_frete_val := public.validar_modalidade_frete(
    v_modalidade_in,
    COALESCE((p_dados->>'taxa_entrega')::NUMERIC, 0.00),
    v_endereco_in,
    COALESCE((p_dados->>'desconto_frete')::NUMERIC, 0.00),
    p_dados->>'motivo_frete'
  );
  IF NOT COALESCE((v_frete_val->>'success')::BOOLEAN, false) THEN
    RETURN v_frete_val;
  END IF;

  -- 4. Resolução / Cadastro do Cliente
  v_cliente_id_final := NULL;
  IF v_cliente_id_in IS NOT NULL THEN
    SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
    FROM public.clientes WHERE id = v_cliente_id_in;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF length(v_cliente_nome_in) < 2 THEN
      RETURN jsonb_build_object('success', false, 'code', 'CUSTOMER_NAME_REQUIRED', 'error', 'Nome do cliente é obrigatório para registrar a encomenda.');
    END IF;

    v_tel_norm := regexp_replace(v_cliente_tel_in, '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN
      v_tel_norm := NULL;
    END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
      FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, endereco_padrao)
      VALUES (
        v_cliente_nome_in,
        NULLIF(v_cliente_tel_in, ''),
        v_tel_norm,
        NULLIF(v_cliente_email_in, ''),
        CASE WHEN (v_frete_val->>'endereco_entrega') IS NOT NULL THEN jsonb_build_object('endereco', v_frete_val->>'endereco_entrega') ELSE '{}'::jsonb END
      ) RETURNING id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final;
    END IF;
  END IF;

  v_cliente_nome_final := COALESCE(NULLIF(v_cliente_nome_in, ''), v_cliente_nome_final);
  v_cliente_tel_final := COALESCE(NULLIF(v_cliente_tel_in, ''), v_cliente_tel_final);
  v_cliente_email_final := COALESCE(NULLIF(v_cliente_email_in, ''), v_cliente_email_final, 'balcao@lunocadoceria.com.br');

  -- 5. Itens: validação, opções, subtotal e pontos
  IF jsonb_typeof(v_itens) = 'string' THEN
    BEGIN
      v_itens := (p_dados->>'itens')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_itens := '[]'::jsonb;
    END;
  END IF;

  IF v_itens IS NULL OR jsonb_typeof(v_itens) <> 'array' OR jsonb_array_length(v_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'A encomenda precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, opcoes, ativo, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_UNAVAILABLE', 'error', 'Produto #' || v_prod_id || ' não está disponível no cardápio.');
    END IF;

    v_produto_ids := array_append(v_produto_ids, v_prod_id);
    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF NOT FOUND THEN
            IF v_prod.opcoes IS NOT NULL AND position(LOWER(TRIM(v_opcao_nome)) IN LOWER(v_prod.opcoes)) > 0 THEN
              v_preco_opt := 0.00;
            ELSE
              RETURN jsonb_build_object(
                'success', false,
                'code', 'INVALID_PRODUCT_OPTION',
                'error', 'A opção "' || v_opcao_nome || '" não é válida para o item "' || v_prod.nome || '".',
                'produto_id', v_prod.id,
                'opcao', v_opcao_nome
              );
            END IF;
          ELSE
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;

          v_subtotal := v_subtotal + (v_preco_opt * v_qtd);
        END IF;
      END LOOP;
    END IF;

    v_subtotal := v_subtotal + (v_prod.preco * v_qtd);
    v_pts_pedido_total := v_pts_pedido_total + ((v_pts_prod + v_pts_opt_total) * v_qtd);
    v_nomes_itens := array_append(v_nomes_itens, v_qtd || 'x ' || v_prod.nome);
  END LOOP;

  IF array_length(v_produto_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'Nenhum item válido informado.');
  END IF;

  -- 6. Política de Desconto (via função compartilhada sem p_is_admin)
  v_desc_pol := public.politica_desconto(v_subtotal, v_desc_in, v_motivo_desc);
  IF NOT COALESCE((v_desc_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_desc_pol;
  END IF;

  v_total := (v_subtotal - (v_desc_pol->>'desconto_aprovado')::NUMERIC) + (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC;

  -- 7. Política de Sinal (via função compartilhada sem p_is_admin)
  v_sinal_pol := public.politica_sinal(
    v_total,
    (p_dados->>'sinal_minimo')::NUMERIC,
    v_forcar_confirm_sem_sinal,
    v_motivo_sem_sinal
  );
  IF NOT COALESCE((v_sinal_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_sinal_pol;
  END IF;

  v_sinal_min := (v_sinal_pol->>'sinal_minimo')::NUMERIC;

  IF v_sinal_pago > v_total THEN
    RETURN jsonb_build_object('success', false, 'code', 'DOWN_PAYMENT_EXCEEDS_TOTAL', 'error', 'Valor do sinal informado excede o total da encomenda.');
  END IF;

  -- Estados iniciais e Hold
  IF v_sinal_min = 0.00 OR v_forcar_confirm_sem_sinal = true OR (v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00) THEN
    v_status_com_inicial := 'confirmado';
    v_confirmacao_expires_at := NULL;
  ELSE
    v_status_com_inicial := 'aguardando_confirmacao';

    v_entrega_at := ((v_data_entrega + COALESCE(v_hora_entrega, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_tz;
    v_confirmacao_expires_at := LEAST(
      NOW() + make_interval(hours => v_cfg.hold_horas_padrao),
      v_entrega_at - make_interval(hours => v_cfg.antecedencia_confirmacao_horas)
    );

    IF v_confirmacao_expires_at <= NOW() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'IMMEDIATE_CONFIRMATION_REQUIRED',
        'error', 'A data/horário de entrega é muito próxima (menos de ' || v_cfg.antecedencia_confirmacao_horas || ' hora(s)). Encomendas imediatas exigem pagamento integral do sinal mínimo (R$ ' || v_sinal_min || ') no ato da criação ou confirmação excepcional por Administrador.',
        'sinal_minimo', v_sinal_min,
        'sinal_pago', v_sinal_pago,
        'entrega_em', v_entrega_at
      );
    END IF;
  END IF;

  -- 8. LOCKS ORDENADOS: capacidade/data -> produtos (id ASC)
  v_cap := public.travar_capacidade_data(v_data_entrega);

  PERFORM 1 FROM public.produtos WHERE id = ANY(v_produto_ids) ORDER BY id FOR UPDATE;

  v_pontos_ocupados_atuais := public.pontos_ocupados_data(v_data_entrega, NULL);

  IF v_cap.bloqueado = true OR (v_pontos_ocupados_atuais + v_pts_pedido_total) > v_cap.capacidade_maxima_pontos THEN
    IF v_forcar_encaixe = true AND public.is_admin() AND (v_motivo_encaixe IS NOT NULL AND length(TRIM(v_motivo_encaixe)) >= 3) THEN
      NULL; -- Encaixe autorizado
    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRODUCTION_CAPACITY_EXCEEDED',
        'data', v_data_entrega,
        'capacidade_maxima', v_cap.capacidade_maxima_pontos,
        'pontos_ocupados', v_pontos_ocupados_atuais,
        'pontos_solicitados', v_pts_pedido_total,
        'error', 'Capacidade de produção excedida para ' || v_data_entrega || '. Ocupados: ' || v_pontos_ocupados_atuais || ' pts, Solicitados: ' || v_pts_pedido_total || ' pts, Limite: ' || v_cap.capacidade_maxima_pontos || ' pts.'
      );
    END IF;
  END IF;

  -- 9. INSERT PEDIDO
  INSERT INTO public.pedidos (
    cliente_id_rel, nome_cliente, telefone_cliente, email_cliente,
    data_pedido, data_entrega, hora_entrega,
    subtotal, desconto, total, taxa_entrega, taxa_entrega_base, taxa_entrega_cobrada, desconto_frete,
    motivo_desconto, valor_pago, saldo, sinal_minimo, saldo_vencimento,
    modalidade_entrega, canal, pagamento,
    status_comercial, status_financeiro, status_operacional, status,
    itens, endereco_entrega, observacoes_cliente, observacoes_internas,
    confirmacao_expires_at, orcamento_origem_id
  ) VALUES (
    v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final,
    (NOW() AT TIME ZONE v_tz)::DATE, v_data_entrega, v_hora_entrega,
    v_subtotal, (v_desc_pol->>'desconto_aprovado')::NUMERIC, v_total, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
    (v_frete_val->>'taxa_entrega_base')::NUMERIC, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC, (v_frete_val->>'desconto_frete')::NUMERIC,
    v_desc_pol->>'motivo', 0.00, v_total, v_sinal_min, v_saldo_venc,
    v_frete_val->>'modalidade', v_canal, LOWER(TRIM(COALESCE(p_dados->>'sinal_metodo', 'pix'))),
    v_status_com_inicial, v_status_fin_inicial, v_status_oper_inicial, 'Pendente',
    array_to_string(v_nomes_itens, ' + '), COALESCE(v_frete_val->>'endereco_entrega', 'Retirada no Balcão'),
    p_dados->>'observacoes_cliente', p_dados->>'observacoes_internas',
    v_confirmacao_expires_at, v_orcamento_origem_id
  ) RETURNING id INTO v_pedido_id;

  -- 10. INSERT ITENS E OPÇÕES
  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);

    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, unidade,
      preco_base_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal,
      cmv_unitario_snapshot, cmv_total_snapshot,
      pontos_producao_snapshot, reserva_estoque_ativa, reserva_ciclo
    ) VALUES (
      v_pedido_id, v_prod_id, v_prod.nome, v_qtd, 'un',
      v_prod.preco, 0.00, v_prod.preco, (v_prod.preco * v_qtd),
      0.00, 0.00,
      v_pts_prod, false, 0
    ) RETURNING id INTO v_item_id;

    v_pts_opt_total := 0.00;
    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, categoria, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id, produto_opcao_id, tipo, opcao_nome, preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, v_opt_rec.id, v_opt_rec.categoria, v_opcao_nome, COALESCE(v_opt_rec.preco_adicional, 0.00),
              COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
            v_preco_opt := COALESCE(v_opt_rec.preco_adicional, 0.00);
          ELSE
            INSERT INTO public.pedido_item_opcoes (
              pedido_item_id, tipo, opcao_nome, preco_adicional,
              pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, 'outro', v_opcao_nome, 0.00,
              0.00
            );
            v_preco_opt := 0.00;
          END IF;
          v_pts_opt_total := v_pts_opt_total + v_preco_opt;
        END IF;
      END LOOP;
    END IF;

    IF v_pts_opt_total > 0.00 THEN
      UPDATE public.pedido_itens
      SET preco_adicionais = v_pts_opt_total,
          preco_unitario_snapshot = preco_base_snapshot + v_pts_opt_total,
          subtotal = (preco_base_snapshot + v_pts_opt_total) * quantidade
      WHERE id = v_item_id;
    END IF;
  END LOOP;

  -- 11. RESERVA DE ESTOQUE ATÔMICA VIA HELPER CANÔNICO (Opção A)
  v_reserva := public.reservar_estoque_itens_pedido(
    v_pedido_id,
    'Reserva da encomenda #' || v_pedido_id || ' (' || array_to_string(v_nomes_itens, ', ') || ')',
    true
  );

  IF COALESCE((v_reserva->>'success')::BOOLEAN, false) = false THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = COALESCE(v_reserva->>'error', 'Estoque insuficiente para a encomenda.'),
      DETAIL = COALESCE(v_reserva::TEXT, '{}'),
      HINT = 'INSUFFICIENT_STOCK';
  END IF;

  -- 12. PAGAMENTO DE SINAL (se informado)
  IF v_sinal_pago > 0.00 THEN
    INSERT INTO public.pedido_pagamentos (
      pedido_id, valor, metodo, provider, provider_payment_id,
      status, pago_em, registrado_por, comprovante_url, observacoes
    ) VALUES (
      v_pedido_id, v_sinal_pago, v_sinal_metodo, 'manual', NULL,
      'aprovado', NOW(), auth.uid(), v_sinal_comp, 'Sinal de entrada registrado na abertura da encomenda'
    ) RETURNING id INTO v_pagamento_id;

    -- Lançamento financeiro com idempotência estrutural no DRE
    INSERT INTO public.financeiro_lancamentos (
      tipo,
      categoria,
      descricao,
      valor,
      data_lancamento,
      forma_pagamento,
      pedido_id,
      origem_tipo,
      origem_id,
      evento,
      observacoes
    ) VALUES (
      'receita',
      'Vendas',
      'Entrada Encomenda #' || v_pedido_id || ' (' || TRIM(v_cliente_nome_final) || ')',
      v_sinal_pago,
      CURRENT_DATE,
      v_sinal_metodo,
      v_pedido_id,
      'pedido_pagamento',
      v_pagamento_id,
      'recebimento',
      'Recebimento de entrada da encomenda via ' || upper(v_sinal_metodo)
    )
    ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;
  END IF;

  -- 13. HISTÓRICO DE AUDITORIA
  INSERT INTO public.pedido_status_historico (
    pedido_id, dimensao, status_anterior, status_novo,
    usuario_id, usuario_nome, origem, metadata
  ) VALUES (
    v_pedido_id, 'comercial', NULL, v_status_com_inicial,
    auth.uid(), v_user_nome, CASE WHEN auth.role() = 'service_role' THEN 'sistema' ELSE 'admin' END,
    jsonb_build_object(
      'acao', 'CRIAR_ENCOMENDA',
      'canal', v_canal,
      'total', v_total,
      'subtotal', v_subtotal,
      'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      'sinal_minimo', v_sinal_min,
      'sinal_pago', v_sinal_pago,
      'confirmacao_expires_at', v_confirmacao_expires_at,
      'pontos_totais', v_pts_pedido_total,
      'forcar_encaixe', v_forcar_encaixe,
      'reserva', v_reserva,
      'orcamento_origem_id', v_orcamento_origem_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'cliente_id', v_cliente_id_final,
    'total', v_total,
    'subtotal', v_subtotal,
    'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
    'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
    'sinal_minimo', v_sinal_min,
    'sinal_padrao', (v_sinal_pol->>'sinal_padrao')::NUMERIC,
    'status_comercial', v_status_com_inicial,
    'status_financeiro', CASE WHEN v_sinal_pago >= v_total THEN 'pago' WHEN v_sinal_pago > 0 THEN 'parcialmente_pago' ELSE 'nao_pago' END,
    'pontos_carga', v_pts_pedido_total,
    'confirmacao_expires_at', v_confirmacao_expires_at,
    'reserva', v_reserva,
    'reserva_estoque', v_reserva
  );
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_exc_hint = PG_EXCEPTION_HINT, v_exc_detail = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object(
      'success', false,
      'code', COALESCE(NULLIF(v_exc_hint, ''), 'DOMAIN_ERROR'),
      'error', SQLERRM,
      'detalhes', CASE WHEN v_exc_detail ~ '^\{' THEN v_exc_detail::JSONB ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.nucleo_criar_encomenda FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nucleo_criar_encomenda TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. REFACTOR CRIAR_ENCOMENDA_ADMIN (CHAMADOR DO NÚCLEO CANÔNICO)
-- --------------------------------------------------------------------------
-- Mantém 100% de compatibilidade de assinatura e retorno com o frontend da Etapa 2.
CREATE OR REPLACE FUNCTION public.criar_encomenda_admin(
  p_cliente_id BIGINT DEFAULT NULL,
  p_cliente_nome TEXT DEFAULT NULL,
  p_cliente_telefone TEXT DEFAULT NULL,
  p_cliente_email TEXT DEFAULT NULL,
  p_canal TEXT DEFAULT 'balcao',
  p_data_entrega DATE DEFAULT NULL,
  p_hora_entrega TIME DEFAULT NULL,
  p_modalidade TEXT DEFAULT 'retirada',
  p_endereco_entrega TEXT DEFAULT NULL,
  p_itens JSONB DEFAULT '[]'::jsonb,
  p_taxa_entrega NUMERIC DEFAULT 0.00,
  p_desconto NUMERIC DEFAULT 0.00,
  p_motivo_desconto TEXT DEFAULT NULL,
  p_sinal_minimo NUMERIC DEFAULT 0.00,
  p_sinal_valor NUMERIC DEFAULT 0.00,
  p_sinal_metodo TEXT DEFAULT 'pix',
  p_sinal_comprovante TEXT DEFAULT NULL,
  p_saldo_vencimento DATE DEFAULT NULL,
  p_forcar_confirmacao_sem_sinal BOOLEAN DEFAULT false,
  p_motivo_confirmacao_sem_sinal TEXT DEFAULT NULL,
  p_forcar_encaixe BOOLEAN DEFAULT false,
  p_motivo_encaixe TEXT DEFAULT NULL,
  p_observacoes_cliente TEXT DEFAULT NULL,
  p_observacoes_internas TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_res JSONB;
BEGIN
  v_res := public.nucleo_criar_encomenda(
    jsonb_build_object(
      'cliente_id', p_cliente_id,
      'cliente_nome', p_cliente_nome,
      'cliente_telefone', p_cliente_telefone,
      'cliente_email', p_cliente_email,
      'canal', p_canal,
      'data_entrega', p_data_entrega,
      'hora_entrega', p_hora_entrega,
      'modalidade', p_modalidade,
      'endereco_entrega', p_endereco_entrega,
      'itens', p_itens,
      'taxa_entrega', p_taxa_entrega,
      'desconto', p_desconto,
      'motivo_desconto', p_motivo_desconto,
      'sinal_minimo', p_sinal_minimo,
      'sinal_valor', p_sinal_valor,
      'sinal_metodo', p_sinal_metodo,
      'sinal_comprovante', p_sinal_comprovante,
      'saldo_vencimento', p_saldo_vencimento,
      'forcar_confirmacao_sem_sinal', p_forcar_confirmacao_sem_sinal,
      'motivo_confirmacao_sem_sinal', p_motivo_confirmacao_sem_sinal,
      'forcar_encaixe', p_forcar_encaixe,
      'motivo_encaixe', p_motivo_encaixe,
      'observacoes_cliente', p_observacoes_cliente,
      'observacoes_internas', p_observacoes_internas
    )
  );

  RETURN v_res::JSON;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_encomenda_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_encomenda_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. HARDENING DE ALTERAR_STATUS_PEDIDO (FECHAMENTO DE BRECHAS S3 / S3b)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alterar_status_pedido(
  p_pedido_id BIGINT,
  p_dimensao TEXT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_antigo TEXT;
  v_permitido BOOLEAN := false;
  v_user_nome TEXT;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  IF p_dimensao = 'operacional' THEN
    v_status_antigo := v_ped.status_operacional;

    IF p_novo_status NOT IN ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      RETURN json_build_object('success', false, 'error', 'Status operacional inválido: ' || p_novo_status);
    END IF;

    -- Matriz de transições operacionais
    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_producao' AND p_novo_status IN ('em_producao', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'em_producao' AND p_novo_status IN ('pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'pronto' AND p_novo_status IN ('saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'saiu_para_entrega' AND p_novo_status IN ('entregue', 'pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_is_admin THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição operacional não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_operacional = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

  ELSIF p_dimensao = 'comercial' THEN
    v_status_antigo := v_ped.status_comercial;

    IF p_novo_status NOT IN ('aguardando_confirmacao', 'confirmado', 'cancelado', 'concluido') THEN
      RETURN json_build_object('success', false, 'error', 'Status comercial inválido: ' || p_novo_status);
    END IF;

    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_confirmacao' AND p_novo_status = 'confirmado' THEN
      -- S3: Bloqueio de confirmação comercial sem sinal por operador
      IF v_ped.valor_pago < v_ped.sinal_minimo THEN
        IF NOT v_is_admin THEN
          RETURN json_build_object(
            'success', false,
            'code', 'SIGNAL_REQUIRED',
            'error', 'Confirmação comercial sem sinal pago integral (R$ ' || v_ped.sinal_minimo || ') requer privilégio de Administrador e justificativa.'
          );
        END IF;
        IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
          RETURN json_build_object(
            'success', false,
            'code', 'REASON_REQUIRED',
            'error', 'Administrador confirmando sem sinal mínimo deve informar justificativa auditável (mínimo 5 caracteres).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'aguardando_confirmacao' AND p_novo_status = 'cancelado' THEN
      -- S3b: Cancelamento com valor pago exige destino do valor (operadores)
      IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
        IF COALESCE(p_metadata->>'destino_valor', '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
          RETURN json_build_object(
            'success', false,
            'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
            'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'confirmado' AND p_novo_status = 'cancelado' THEN
      -- Guarda de produção: se produção já iniciou, cancelar exige privilégio de Administrador
      IF v_ped.status_operacional NOT IN ('aguardando_producao', 'cancelado') AND NOT v_is_admin THEN
        RETURN json_build_object(
          'success', false,
          'code', 'PRODUCTION_ACTIVE_CANCEL_DENIED',
          'error', 'A produção deste pedido já foi iniciada. Cancelamentos nesta fase requerem autorização de Administrador.'
        );
      END IF;

      -- S3b: Cancelamento com valor pago exige destino do valor (operadores)
      IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
        IF COALESCE(p_metadata->>'destino_valor', '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
          RETURN json_build_object(
            'success', false,
            'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
            'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
          );
        END IF;
      END IF;
      v_permitido := true;

    ELSIF v_status_antigo = 'confirmado' AND p_novo_status = 'concluido' THEN
      v_permitido := true;
    ELSIF v_is_admin THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição comercial não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_comercial = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

  ELSE
    RETURN json_build_object('success', false, 'error', 'Dimensão de status inválida. Use "operacional" ou "comercial". Para financeiro, registre pagamentos.');
  END IF;

  -- Gravação auditável do histórico
  INSERT INTO public.pedido_status_historico (
    pedido_id,
    dimensao,
    status_anterior,
    status_novo,
    usuario_id,
    usuario_nome,
    origem,
    metadata
  ) VALUES (
    p_pedido_id,
    p_dimensao,
    v_status_antigo,
    p_novo_status,
    auth.uid(),
    v_user_nome,
    'admin',
    jsonb_build_object('motivo', v_motivo) || COALESCE(p_metadata, '{}'::JSONB)
  );

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'dimensao', p_dimensao,
    'status_anterior', v_status_antigo,
    'status_novo', p_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_pedido(BIGINT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. TRIGGER DE PROTEÇÃO DE ESTOQUE EM PRODUTOS (ANTI-INFLAÇÃO NO CATÁLOGO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_proteger_estoque_produtos()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Mutação de estoque_reservado é estritamente restrita a helpers internos e service_role
  IF NEW.estoque_reservado IS DISTINCT FROM OLD.estoque_reservado THEN
    IF current_setting('lunoca.internal_stock_mutation', true) IS DISTINCT FROM 'on' AND auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Modificação direta de estoque_reservado não é permitida. Use os fluxos de reserva/liberação.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Mutação de estoque_fisico requer privilégio de Administrador, service_role ou helper interno
  IF NEW.estoque_fisico IS DISTINCT FROM OLD.estoque_fisico THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role' OR current_setting('lunoca.internal_stock_mutation', true) = 'on') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o saldo de estoque físico do produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_proteger_estoque_produtos ON public.produtos;
CREATE TRIGGER trg_proteger_estoque_produtos
  BEFORE UPDATE ON public.produtos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_proteger_estoque_produtos();


-- ==========================================================================
-- >>> MIGRATION 013_etapa3_orcamentos_conversao_comercial.sql
-- ==========================================================================

-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 013: ETAPA 3 - ORÇAMENTOS E CONVERSÃO COMERCIAL
-- ==========================================================================
-- Decisões Arquiteturais Consolidadas:
-- 1. Orçamento é entidade própria desacoplada de pedidos até o momento da conversão.
-- 2. Não reserva estoque nem capacidade produtiva enquanto estiver em rascunho/enviado/aprovado.
-- 3. Link público anônimo expõe apenas dados comerciais estritamente sanitizados (sem CMV, sem notas internas).
-- 4. Aprovação pública é idempotente e protegida contra repetições e orçamentos vencidos.
-- 5. Dois relógios operacionais independentes: validade_ate (aprovação cliente) e janela_conversao_limite (operador).
-- 6. Conversão atômica delegada exclusivamente a public.nucleo_criar_encomenda() com snapshots imutáveis.
-- 7. Rastreamento bidirecional unívoco: orcamentos.pedido_id UNIQUE e pedidos.orcamento_origem_id UNIQUE.
-- 8. Expiração transacional em lote via public.expirar_orcamentos() integrada ao cron existente.
-- 9. Trilha de auditoria (orcamento_status_historico) e log de comunicações WhatsApp (orcamento_comunicacoes).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. SEQUÊNCIA DE NUMERAÇÃO DE ORÇAMENTOS (ORC-AAAA-XXXX)
-- --------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.orcamentos_numero_seq START 1;

-- --------------------------------------------------------------------------
-- 2. TABELA PRINCIPAL DE ORÇAMENTOS
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamentos (
  id BIGSERIAL PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  versao INT NOT NULL DEFAULT 1,
  cliente_id BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL,
  cliente_nome TEXT NOT NULL,
  cliente_telefone TEXT,
  cliente_email TEXT,
  data_evento DATE NOT NULL,
  hora_evento TIME,
  tipo_entrega TEXT NOT NULL DEFAULT 'retirada' CHECK (tipo_entrega IN ('retirada', 'entrega')),
  endereco_entrega TEXT,
  validade_ate TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'enviado', 'aprovado', 'recusado', 'cancelado', 'expirado', 'convertido')),
  aprovado_em TIMESTAMPTZ,
  janela_conversao_limite TIMESTAMPTZ,
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  desconto_produtos NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  motivo_desconto TEXT,
  taxa_entrega_base NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  taxa_entrega_cobrada NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  desconto_frete NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  total NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  sinal_sugerido NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  observacoes_cliente TEXT,
  observacoes_internas TEXT,
  token_publico UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  pedido_id BIGINT UNIQUE REFERENCES public.pedidos(id) ON DELETE SET NULL,
  convertido_em TIMESTAMPTZ,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  visualizado_em TIMESTAMPTZ,
  visualizacoes_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente_id ON public.orcamentos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_status ON public.orcamentos(status);
CREATE INDEX IF NOT EXISTS idx_orcamentos_data_evento ON public.orcamentos(data_evento);
CREATE INDEX IF NOT EXISTS idx_orcamentos_token_publico ON public.orcamentos(token_publico);
CREATE INDEX IF NOT EXISTS idx_orcamentos_validade ON public.orcamentos(validade_ate) WHERE status = 'enviado';

-- --------------------------------------------------------------------------
-- 3. ITENS E OPÇÕES DO ORÇAMENTO (SNAPSHOTS IMUTÁVEIS)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_itens (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE RESTRICT,
  quantidade INT NOT NULL CHECK (quantidade > 0),
  preco_unitario_snapshot NUMERIC(10,2) NOT NULL,
  cmv_unitario_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00,
  subtotal NUMERIC(10,2) NOT NULL,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_itens_orcamento_id ON public.orcamento_itens(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_orcamento_itens_produto_id ON public.orcamento_itens(produto_id);

CREATE TABLE IF NOT EXISTS public.orcamento_item_opcoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_item_id BIGINT NOT NULL REFERENCES public.orcamento_itens(id) ON DELETE CASCADE,
  produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL DEFAULT 'personalizacao',
  opcao_nome TEXT NOT NULL,
  preco_adicional_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_item_opcoes_item_id ON public.orcamento_item_opcoes(orcamento_item_id);

-- --------------------------------------------------------------------------
-- 4. AUTORIZAÇÕES DE EXCEÇÕES POR VERSÃO (DESCONTO / SINAL / FRETE)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_autorizacoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  versao INT NOT NULL,
  tipo_autorizacao TEXT NOT NULL CHECK (tipo_autorizacao IN ('DESCONTO', 'SINAL_REDUZIDO', 'CONFIRMACAO_SEM_SINAL', 'FRETE')),
  autorizado_por UUID NOT NULL REFERENCES auth.users(id),
  autorizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) >= 3),
  dados_autorizacao JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_orcamento_autorizacao UNIQUE (orcamento_id, versao, tipo_autorizacao)
);

CREATE INDEX IF NOT EXISTS idx_orcamento_autorizacoes_lookup ON public.orcamento_autorizacoes(orcamento_id, versao);

-- --------------------------------------------------------------------------
-- 5. HISTÓRICO DE AUDITORIA COMERCIAL
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_status_historico (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  evento TEXT NOT NULL CHECK (evento IN ('CRIADO', 'ENVIADO', 'VISUALIZADO', 'APROVADO', 'RECUSADO', 'EXPIRADO', 'REVISADO', 'CONVERTIDO')),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  versao INT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('admin', 'link_publico', 'cron', 'sistema')),
  ator_id UUID REFERENCES auth.users(id),
  ator_nome TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamento_status_historico_orcamento_id ON public.orcamento_status_historico(orcamento_id);

-- --------------------------------------------------------------------------
-- 6. LOG DE COMUNICAÇÕES WHATSAPP
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orcamento_comunicacoes (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT NOT NULL REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  canal TEXT NOT NULL CHECK (canal IN ('evolution_api', 'whatsapp_link')),
  tipo TEXT NOT NULL CHECK (tipo IN ('envio_proposta', 'lembrete_validade', 'confirmacao_aprovacao', 'cobranca_sinal')),
  destinatario_telefone TEXT NOT NULL,
  mensagem_preview TEXT NOT NULL,
  disparado_por UUID REFERENCES auth.users(id),
  disparado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_orcamento_comunicacoes_orcamento_id ON public.orcamento_comunicacoes(orcamento_id);

-- --------------------------------------------------------------------------
-- 7. SEGURANÇA E POLÍTICAS RLS (FAIL-CLOSED)
-- --------------------------------------------------------------------------
ALTER TABLE public.orcamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamentos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_itens FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_item_opcoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_item_opcoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_autorizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_autorizacoes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_status_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_status_historico FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_comunicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orcamento_comunicacoes FORCE ROW LEVEL SECURITY;

-- Equipe (admin e operador) visualiza orçamentos e detalhes
DROP POLICY IF EXISTS "Equipe visualiza orcamentos" ON public.orcamentos;
CREATE POLICY "Equipe visualiza orcamentos"
  ON public.orcamentos FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamentos" ON public.orcamentos;
CREATE POLICY "Equipe gerencia orcamentos"
  ON public.orcamentos FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_itens" ON public.orcamento_itens;
CREATE POLICY "Equipe gerencia orcamento_itens"
  ON public.orcamento_itens FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_item_opcoes" ON public.orcamento_item_opcoes;
CREATE POLICY "Equipe gerencia orcamento_item_opcoes"
  ON public.orcamento_item_opcoes FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe visualiza autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Equipe visualiza autorizacoes"
  ON public.orcamento_autorizacoes FOR SELECT TO authenticated
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admin gerencia autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Admin gerencia autorizacoes"
  ON public.orcamento_autorizacoes FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_status_historico" ON public.orcamento_status_historico;
CREATE POLICY "Equipe gerencia orcamento_status_historico"
  ON public.orcamento_status_historico FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe gerencia orcamento_comunicacoes" ON public.orcamento_comunicacoes;
CREATE POLICY "Equipe gerencia orcamento_comunicacoes"
  ON public.orcamento_comunicacoes FOR ALL TO authenticated
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

-- Service role tem acesso irrestrito
DROP POLICY IF EXISTS "Service role acesso completo orcamentos" ON public.orcamentos;
CREATE POLICY "Service role acesso completo orcamentos" ON public.orcamentos FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_itens" ON public.orcamento_itens;
CREATE POLICY "Service role acesso completo orcamento_itens" ON public.orcamento_itens FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_item_opcoes" ON public.orcamento_item_opcoes;
CREATE POLICY "Service role acesso completo orcamento_item_opcoes" ON public.orcamento_item_opcoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_autorizacoes" ON public.orcamento_autorizacoes;
CREATE POLICY "Service role acesso completo orcamento_autorizacoes" ON public.orcamento_autorizacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_status_historico" ON public.orcamento_status_historico;
CREATE POLICY "Service role acesso completo orcamento_status_historico" ON public.orcamento_status_historico FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role acesso completo orcamento_comunicacoes" ON public.orcamento_comunicacoes;
CREATE POLICY "Service role acesso completo orcamento_comunicacoes" ON public.orcamento_comunicacoes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Tabela e políticas para Rate Limiting na aprovação pública
CREATE TABLE IF NOT EXISTS public.orcamento_rate_limits (
  token UUID PRIMARY KEY,
  tentativas INT NOT NULL DEFAULT 1,
  bloqueado_ate TIMESTAMPTZ,
  ultimo_acesso TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.orcamento_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role rate limits" ON public.orcamento_rate_limits;
CREATE POLICY "Service role rate limits" ON public.orcamento_rate_limits FOR ALL TO service_role USING (true) WITH CHECK (true);

-- --------------------------------------------------------------------------
-- 8. HELPER PARA GERAR NÚMERO DO ORÇAMENTO (ORC-AAAA-XXXX)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerar_numero_orcamento()
RETURNS TEXT AS $$
DECLARE
  v_ano TEXT := TO_CHAR(NOW(), 'YYYY');
  v_seq BIGINT := nextval('public.orcamentos_numero_seq');
BEGIN
  RETURN 'ORC-' || v_ano || '-' || LPAD(v_seq::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

REVOKE ALL ON FUNCTION public.gerar_numero_orcamento FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerar_numero_orcamento TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 9. RPC CRIAR OU ATUALIZAR ORÇAMENTO (ADMIN / OPERADOR)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.criar_ou_atualizar_orcamento_admin(
  p_dados JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_tz TEXT := COALESCE(v_cfg.timezone, 'America/Fortaleza');
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_user_nome TEXT;

  v_id BIGINT := NULLIF((p_dados->>'id')::BIGINT, 0);
  v_orc_existente public.orcamentos;
  v_versao INT := 1;
  v_numero TEXT;

  v_cliente_id_in BIGINT := NULLIF((p_dados->>'cliente_id')::BIGINT, 0);
  v_cliente_nome_in TEXT := TRIM(COALESCE(p_dados->>'cliente_nome', ''));
  v_cliente_tel_in TEXT := TRIM(COALESCE(p_dados->>'cliente_telefone', ''));
  v_cliente_email_in TEXT := TRIM(COALESCE(p_dados->>'cliente_email', ''));

  v_cliente_id_final BIGINT;
  v_cliente_nome_final TEXT;
  v_cliente_tel_final TEXT;
  v_cliente_email_final TEXT;
  v_tel_norm TEXT;

  v_data_evento DATE := (p_dados->>'data_evento')::DATE;
  v_hora_evento TIME := (p_dados->>'hora_evento')::TIME;
  v_modalidade TEXT := LOWER(TRIM(COALESCE(p_dados->>'tipo_entrega', p_dados->>'modalidade', 'retirada')));
  v_endereco TEXT := NULLIF(TRIM(COALESCE(p_dados->>'endereco_entrega', '')), '');

  v_evento_ts TIMESTAMPTZ;
  v_validade_ate TIMESTAMPTZ;

  v_itens JSONB := p_dados->'itens';
  v_item RECORD;
  v_prod_id BIGINT;
  v_qtd INT;
  v_prod RECORD;
  v_pts_prod NUMERIC(6,2);
  v_pts_opt_total NUMERIC(6,2);
  v_opcao JSONB;
  v_opcao_nome TEXT;
  v_opt_rec RECORD;
  v_preco_opt NUMERIC(10,2);
  v_subtotal NUMERIC(10,2) := 0.00;
  v_total NUMERIC(10,2) := 0.00;
  v_sinal_sugerido NUMERIC(10,2) := 0.00;

  v_desc_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto_produtos')::NUMERIC, (p_dados->>'desconto')::NUMERIC, 0.00));
  v_motivo_desc TEXT := TRIM(COALESCE(p_dados->>'motivo_desconto', ''));
  v_desc_pol JSONB;

  v_taxa_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'taxa_entrega')::NUMERIC, 0.00));
  v_desc_frete_in NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados->>'desconto_frete')::NUMERIC, 0.00));
  v_motivo_frete TEXT := TRIM(COALESCE(p_dados->>'motivo_desconto_frete', ''));
  v_frete_val JSONB;

  v_status_alvo TEXT := LOWER(TRIM(COALESCE(p_dados->>'status', 'rascunho')));
  v_obs_cliente TEXT := NULLIF(TRIM(COALESCE(p_dados->>'observacoes_cliente', '')), '');
  v_obs_internas TEXT := NULLIF(TRIM(COALESCE(p_dados->>'observacoes_internas', '')), '');

  v_orc_id BIGINT;
  v_item_id BIGINT;
  v_item_subtotal NUMERIC(10,2);
  v_evento_hist TEXT := 'CRIADO';
  v_status_ant TEXT := NULL;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode gerenciar orçamentos.');
  END IF;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = auth.uid();

  -- 1. Se edição, carregar e validar integridade do orçamento existente
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_orc_existente FROM public.orcamentos WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
    END IF;

    IF v_orc_existente.status = 'convertido' THEN
      RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ALREADY_CONVERTED', 'error', 'Orçamento já convertido em pedido não pode ser editado.');
    END IF;

    -- Se já havia sido enviado ou aprovado, edição gera nova versão e reseta aprovação (E3-11)
    IF v_orc_existente.status IN ('enviado', 'aprovado') THEN
      v_versao := v_orc_existente.versao + 1;
      v_evento_hist := 'REVISADO';
    ELSE
      v_versao := v_orc_existente.versao;
      v_evento_hist := 'REVISADO';
    END IF;

    v_numero := v_orc_existente.numero;
    v_status_ant := v_orc_existente.status;
  ELSE
    v_numero := public.gerar_numero_orcamento();
    v_versao := 1;
    v_evento_hist := 'CRIADO';
  END IF;

  -- 2. Validação da Data do Evento e Timezone
  IF v_data_evento IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_EVENT_DATE', 'error', 'Data do evento é obrigatória.');
  END IF;

  v_evento_ts := ((v_data_evento + COALESCE(v_hora_evento, TIME '12:00:00'))::TIMESTAMP) AT TIME ZONE v_tz;

  -- Validade com dois limites: agora + validade_orcamento_horas vs evento - antecedencia_minima_orcamento_horas
  v_validade_ate := LEAST(
    NOW() + make_interval(hours => v_cfg.validade_orcamento_horas),
    v_evento_ts - make_interval(hours => v_cfg.antecedencia_minima_orcamento_horas)
  );

  IF v_validade_ate <= NOW() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INSUFFICIENT_LEAD_TIME',
      'error', 'A data do evento é muito próxima para emissão de proposta. A antecedência mínima exigida é de ' || v_cfg.antecedencia_minima_orcamento_horas || ' horas antes do evento.'
    );
  END IF;

  -- 3. Resolução do Cliente
  v_cliente_id_final := NULL;
  IF v_cliente_id_in IS NOT NULL THEN
    SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
    FROM public.clientes WHERE id = v_cliente_id_in;
  END IF;

  IF v_cliente_id_final IS NULL THEN
    IF length(v_cliente_nome_in) < 2 THEN
      RETURN jsonb_build_object('success', false, 'code', 'CUSTOMER_NAME_REQUIRED', 'error', 'Nome do cliente é obrigatório.');
    END IF;

    v_tel_norm := regexp_replace(v_cliente_tel_in, '\D', '', 'g');
    IF length(v_tel_norm) IN (10, 11) THEN
      v_tel_norm := '55' || v_tel_norm;
    END IF;
    IF v_tel_norm = '' THEN v_tel_norm := NULL; END IF;

    IF v_tel_norm IS NOT NULL THEN
      SELECT id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final
      FROM public.clientes WHERE telefone_normalizado = v_tel_norm LIMIT 1;
    END IF;

    IF v_cliente_id_final IS NULL THEN
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, endereco_padrao)
      VALUES (
        v_cliente_nome_in,
        NULLIF(v_cliente_tel_in, ''),
        v_tel_norm,
        NULLIF(v_cliente_email_in, ''),
        CASE WHEN v_endereco IS NOT NULL THEN jsonb_build_object('endereco', v_endereco) ELSE '{}'::jsonb END
      ) RETURNING id, nome, telefone, email INTO v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final;
    END IF;
  END IF;

  v_cliente_nome_final := COALESCE(NULLIF(v_cliente_nome_in, ''), v_cliente_nome_final);
  v_cliente_tel_final := COALESCE(NULLIF(v_cliente_tel_in, ''), v_cliente_tel_final);
  v_cliente_email_final := COALESCE(NULLIF(v_cliente_email_in, ''), v_cliente_email_final);

  -- 4. Validação de Modalidade e Frete
  v_frete_val := public.validar_modalidade_frete(v_modalidade, v_taxa_in, v_endereco, v_desc_frete_in, v_motivo_frete);
  IF NOT COALESCE((v_frete_val->>'success')::BOOLEAN, false) THEN
    RETURN v_frete_val;
  END IF;

  -- 5. Itens e Subtotal (leitura do catálogo atual com snapshots)
  IF v_itens IS NULL OR jsonb_typeof(v_itens) <> 'array' OR jsonb_array_length(v_itens) = 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'ITEMS_REQUIRED', 'error', 'O orçamento precisa ter pelo menos um item.');
  END IF;

  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, ativo, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    IF NOT FOUND OR v_prod.ativo = false THEN
      RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_UNAVAILABLE', 'error', 'Produto #' || v_prod_id || ' não está disponível no catálogo.');
    END IF;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_pts_opt_total := 0.00;
    v_preco_opt := 0.00;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            v_preco_opt := v_preco_opt + COALESCE(v_opt_rec.preco_adicional, 0.00);
            v_pts_opt_total := v_pts_opt_total + COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00);
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_item_subtotal := (v_prod.preco + v_preco_opt) * v_qtd;
    v_subtotal := v_subtotal + v_item_subtotal;
  END LOOP;

  -- 6. Política de Desconto (sem p_is_admin por parâmetro)
  v_desc_pol := public.politica_desconto(v_subtotal, v_desc_in, v_motivo_desc);
  IF NOT COALESCE((v_desc_pol->>'success')::BOOLEAN, false) THEN
    RETURN v_desc_pol;
  END IF;

  v_total := (v_subtotal - (v_desc_pol->>'desconto_aprovado')::NUMERIC) + (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC;
  v_sinal_sugerido := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);

  -- 7. Persistência Principal (INSERT ou UPDATE)
  IF v_id IS NOT NULL THEN
    v_orc_id := v_id;
    UPDATE public.orcamentos SET
      versao = v_versao,
      cliente_id = v_cliente_id_final,
      cliente_nome = v_cliente_nome_final,
      cliente_telefone = v_cliente_tel_final,
      cliente_email = v_cliente_email_final,
      data_evento = v_data_evento,
      hora_evento = v_hora_evento,
      tipo_entrega = v_frete_val->>'modalidade',
      endereco_entrega = v_frete_val->>'endereco_entrega',
      validade_ate = v_validade_ate,
      status = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN 'rascunho' ELSE v_status_alvo END,
      aprovado_em = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN NULL ELSE v_orc_existente.aprovado_em END,
      janela_conversao_limite = CASE WHEN v_status_ant IN ('enviado', 'aprovado') THEN NULL ELSE v_orc_existente.janela_conversao_limite END,
      subtotal = v_subtotal,
      desconto_produtos = (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      motivo_desconto = v_desc_pol->>'motivo',
      taxa_entrega_base = (v_frete_val->>'taxa_entrega_base')::NUMERIC,
      taxa_entrega_cobrada = (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      desconto_frete = (v_frete_val->>'desconto_frete')::NUMERIC,
      total = v_total,
      sinal_sugerido = v_sinal_sugerido,
      observacoes_cliente = v_obs_cliente,
      observacoes_internas = v_obs_internas,
      updated_at = NOW()
    WHERE id = v_orc_id;

    -- Deleta itens anteriores para regravação consistente da nova versão
    DELETE FROM public.orcamento_itens WHERE orcamento_id = v_orc_id;
  ELSE
    INSERT INTO public.orcamentos (
      numero, versao, cliente_id, cliente_nome, cliente_telefone, cliente_email,
      data_evento, hora_evento, tipo_entrega, endereco_entrega, validade_ate,
      status, subtotal, desconto_produtos, motivo_desconto,
      taxa_entrega_base, taxa_entrega_cobrada, desconto_frete,
      total, sinal_sugerido, observacoes_cliente, observacoes_internas,
      criado_por
    ) VALUES (
      v_numero, v_versao, v_cliente_id_final, v_cliente_nome_final, v_cliente_tel_final, v_cliente_email_final,
      v_data_evento, v_hora_evento, v_frete_val->>'modalidade', v_frete_val->>'endereco_entrega', v_validade_ate,
      v_status_alvo, v_subtotal, (v_desc_pol->>'desconto_aprovado')::NUMERIC, v_desc_pol->>'motivo',
      (v_frete_val->>'taxa_entrega_base')::NUMERIC, (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC, (v_frete_val->>'desconto_frete')::NUMERIC,
      v_total, v_sinal_sugerido, v_obs_cliente, v_obs_internas,
      auth.uid()
    ) RETURNING id INTO v_orc_id;
  END IF;

  -- 8. Persistência de Itens e Opções (snapshots)
  FOR v_item IN
    SELECT
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      it->'opcoes' AS opcoes,
      it->>'observacoes' AS observacoes
    FROM jsonb_array_elements(v_itens) it
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
  LOOP
    v_prod_id := v_item.produto_id;
    v_qtd := v_item.quantidade;

    SELECT id, nome, preco, pontos_producao
    INTO v_prod
    FROM public.produtos
    WHERE id = v_prod_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_preco_opt := 0.00;

    -- Primeiro calcula adicionais das opções
    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            v_preco_opt := v_preco_opt + COALESCE(v_opt_rec.preco_adicional, 0.00);
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_item_subtotal := (v_prod.preco + v_preco_opt) * v_qtd;

    INSERT INTO public.orcamento_itens (
      orcamento_id, produto_id, quantidade, preco_unitario_snapshot,
      cmv_unitario_snapshot, pontos_producao_snapshot, subtotal, observacoes
    ) VALUES (
      v_orc_id, v_prod_id, v_qtd, v_prod.preco,
      0.00, v_pts_prod, v_item_subtotal, v_item.observacoes
    ) RETURNING id INTO v_item_id;

    IF v_item.opcoes IS NOT NULL AND jsonb_typeof(v_item.opcoes) = 'array' THEN
      FOR v_opcao IN SELECT value FROM jsonb_array_elements(v_item.opcoes) LOOP
        v_opcao_nome := TRIM(COALESCE(v_opcao->>'nome', v_opcao->>'opcao_nome', ''));
        IF v_opcao_nome <> '' THEN
          SELECT id, preco_adicional, pontos_producao_adicionais
          INTO v_opt_rec
          FROM public.produto_opcoes
          WHERE produto_id = v_prod.id AND LOWER(TRIM(nome)) = LOWER(TRIM(v_opcao_nome)) AND ativo = true
          LIMIT 1;

          IF FOUND THEN
            INSERT INTO public.orcamento_item_opcoes (
              orcamento_item_id, produto_opcao_id, tipo, opcao_nome,
              preco_adicional_snapshot, pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, v_opt_rec.id, 'personalizacao', v_opcao_nome,
              COALESCE(v_opt_rec.preco_adicional, 0.00), COALESCE(v_opt_rec.pontos_producao_adicionais, 0.00)
            );
          ELSE
            INSERT INTO public.orcamento_item_opcoes (
              orcamento_item_id, produto_opcao_id, tipo, opcao_nome,
              preco_adicional_snapshot, pontos_producao_adicionais_snapshot
            ) VALUES (
              v_item_id, NULL, 'personalizacao', v_opcao_nome, 0.00, 0.00
            );
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- 9. Se desconto excepcional admin, persistir autorização para a versão atual
  IF (v_desc_pol->>'excecao_admin')::BOOLEAN = true AND v_is_admin THEN
    INSERT INTO public.orcamento_autorizacoes (
      orcamento_id, versao, tipo_autorizacao, autorizado_por, motivo, dados_autorizacao
    ) VALUES (
      v_orc_id, v_versao, 'DESCONTO', auth.uid(), v_desc_pol->>'motivo',
      jsonb_build_object('desconto_aprovado', (v_desc_pol->>'desconto_aprovado')::NUMERIC, 'percentual', (v_desc_pol->>'percentual')::NUMERIC)
    ) ON CONFLICT (orcamento_id, versao, tipo_autorizacao)
    DO UPDATE SET
      autorizado_por = EXCLUDED.autorizado_por,
      autorizado_em = NOW(),
      motivo = EXCLUDED.motivo,
      dados_autorizacao = EXCLUDED.dados_autorizacao;
  END IF;

  -- 10. Gravação da Trilha de Histórico
  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    v_orc_id, v_evento_hist, v_status_ant,
    (SELECT status FROM public.orcamentos WHERE id = v_orc_id),
    v_versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object(
      'total', v_total,
      'subtotal', v_subtotal,
      'desconto', (v_desc_pol->>'desconto_aprovado')::NUMERIC,
      'taxa_entrega', (v_frete_val->>'taxa_entrega_cobrada')::NUMERIC,
      'validade_ate', v_validade_ate,
      'numero', v_numero
    )
  );

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      'id', id,
      'numero', numero,
      'versao', versao,
      'status', status,
      'total', total,
      'subtotal', subtotal,
      'validade_ate', validade_ate,
      'token_publico', token_publico
    )
    FROM public.orcamentos
    WHERE id = v_orc_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.criar_ou_atualizar_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.criar_ou_atualizar_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 10. RPC ALTERAR STATUS DO ORÇAMENTO (ENVIAR / RECUSAR / CANCELAR)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alterar_status_orcamento_admin(
  p_orcamento_id BIGINT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_novo TEXT := LOWER(TRIM(p_novo_status));
  v_evento TEXT;
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  IF v_orc.status = 'convertido' THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ALREADY_CONVERTED', 'error', 'Orçamento convertido não pode ter o status alterado.');
  END IF;

  IF v_novo NOT IN ('enviado', 'recusado', 'cancelado', 'rascunho') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_STATUS', 'error', 'Status de transição inválido.');
  END IF;

  IF v_novo = 'enviado' THEN
    IF NOW() > v_orc.validade_ate THEN
      RETURN jsonb_build_object('success', false, 'code', 'QUOTE_EXPIRED', 'error', 'Não é possível enviar um orçamento com validade expirada. Atualize a data do evento.');
    END IF;
    v_evento := 'ENVIADO';
  ELSIF v_novo = 'recusado' THEN
    v_evento := 'RECUSADO';
  ELSIF v_novo = 'cancelado' THEN
    v_evento := 'CANCELADO';
  ELSE
    v_evento := 'REVISADO';
  END IF;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE u.id = auth.uid();

  UPDATE public.orcamentos
  SET status = v_novo, updated_at = NOW()
  WHERE id = p_orcamento_id;

  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    p_orcamento_id, v_evento, v_orc.status, v_novo, v_orc.versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object('motivo', p_motivo)
  );

  RETURN jsonb_build_object('success', true, 'id', p_orcamento_id, 'status', v_novo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_status_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_status_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 11. RPC OBTER ORÇAMENTO PÚBLICO (ANÔNIMO / SANITIZADO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_orcamento_publico(
  p_token UUID
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_itens JSONB;
  v_expirado BOOLEAN;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE token_publico = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  v_expirado := (NOW() > v_orc.validade_ate) OR (v_orc.status = 'expirado');

  -- Atualiza visualização de forma segura
  UPDATE public.orcamentos
  SET visualizado_em = COALESCE(visualizado_em, NOW()),
      visualizacoes_count = visualizacoes_count + 1
  WHERE id = v_orc.id;

  -- Se for a primeira visualização, registra evento no histórico
  IF v_orc.visualizacoes_count = 0 THEN
    INSERT INTO public.orcamento_status_historico (
      orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
    ) VALUES (
      v_orc.id, 'VISUALIZADO', v_orc.status, v_orc.status, v_orc.versao, 'link_publico',
      jsonb_build_object('primeira_visualizacao', true)
    );
  END IF;

  -- Monta itens com opções (estritamente sanitizados: sem CMV, sem custos internos)
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', oi.id,
      'produto_id', oi.produto_id,
      'produto_nome', pr.nome,
      'produto_descricao', pr.descricao,
      'produto_imagem_url', pr.img_url,
      'quantidade', oi.quantidade,
      'preco_unitario', oi.preco_unitario_snapshot,
      'subtotal', oi.subtotal,
      'observacoes', oi.observacoes,
      'opcoes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'tipo', oio.tipo,
            'opcao_nome', oio.opcao_nome,
            'preco_adicional', oio.preco_adicional_snapshot
          )
        )
        FROM public.orcamento_item_opcoes oio
        WHERE oio.orcamento_item_id = oi.id
      ), '[]'::jsonb)
    )
  )
  INTO v_itens
  FROM public.orcamento_itens oi
  JOIN public.produtos pr ON pr.id = oi.produto_id
  WHERE oi.orcamento_id = v_orc.id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_orc.id,
    'numero', v_orc.numero,
    'versao', v_orc.versao,
    'cliente_nome', v_orc.cliente_nome,
    'cliente_telefone', v_orc.cliente_telefone,
    'data_evento', v_orc.data_evento,
    'hora_evento', v_orc.hora_evento,
    'tipo_entrega', v_orc.tipo_entrega,
    'endereco_entrega', v_orc.endereco_entrega,
    'validade_ate', v_orc.validade_ate,
    'expirado', v_expirado,
    'status', v_orc.status,
    'subtotal', v_orc.subtotal,
    'desconto_produtos', v_orc.desconto_produtos,
    'taxa_entrega', v_orc.taxa_entrega_cobrada,
    'total', v_orc.total,
    'sinal_sugerido', v_orc.sinal_sugerido,
    'observacoes_cliente', v_orc.observacoes_cliente,
    'aprovado_em', v_orc.aprovado_em,
    'itens', COALESCE(v_itens, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_orcamento_publico FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obter_orcamento_publico TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 12. RPC APROVAÇÃO PÚBLICA (IDEMPOTENTE E RATE-LIMITED)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(
  p_token UUID
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_orc public.orcamentos;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- Rate limit: máximo 5 tentativas em 1 minuto
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

  -- Se já aprovado na mesma versão: IDEMPOTÊNCIA (E3-4)
  IF v_orc.status = 'aprovado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'aprovado',
      'idempotente', true,
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

  -- Validação de expiração temporal (E3-13)
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
    jsonb_build_object('aprovado_em', NOW(), 'janela_conversao_horas', v_cfg.janela_conversao_horas)
  );

  RETURN jsonb_build_object(
    'success', true,
    'status', 'aprovado',
    'idempotente', false,
    'aprovado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_orcamento_publico FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aprovar_orcamento_publico TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 13. RPC EXPIRAÇÃO AUTOMÁTICA EM LOTE (CRON UNIFICADO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expirar_orcamentos(
  p_limite INT DEFAULT 100
)
RETURNS JSONB AS $$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_expirados BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  FOR v_rec IN
    SELECT id, status, versao
    FROM public.orcamentos
    WHERE status = 'enviado' AND validade_ate < NOW()
    ORDER BY validade_ate ASC
    LIMIT GREATEST(1, COALESCE(p_limite, 100))
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.orcamentos
    SET status = 'expirado', updated_at = NOW()
    WHERE id = v_rec.id;

    INSERT INTO public.orcamento_status_historico (
      orcamento_id, evento, status_anterior, status_novo, versao, origem, metadata
    ) VALUES (
      v_rec.id, 'EXPIRADO', v_rec.status, 'expirado', v_rec.versao, 'cron',
      jsonb_build_object('expirado_em', NOW())
    );

    v_count := v_count + 1;
    v_expirados := array_append(v_expirados, v_rec.id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expirados_count', v_count,
    'orcamentos_ids', v_expirados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.expirar_orcamentos FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expirar_orcamentos TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 14. RPC CONVERTER ORÇAMENTO EM PEDIDO (CHAMA NÚCLEO CANÔNICO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.converter_orcamento_em_pedido_admin(
  p_orcamento_id BIGINT,
  p_dados_complementares JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_is_admin BOOLEAN := public.is_admin();
  v_orc public.orcamentos;
  v_itens_payload JSONB := '[]'::jsonb;
  v_item_rec RECORD;
  v_opcoes_payload JSONB;
  v_nucleo_payload JSONB;
  v_nucleo_res JSONB;
  v_pedido_id BIGINT;
  v_user_nome TEXT;

  v_sinal_valor NUMERIC(10,2) := GREATEST(0.00, COALESCE((p_dados_complementares->>'sinal_valor')::NUMERIC, 0.00));
  v_sinal_metodo TEXT := COALESCE(p_dados_complementares->>'sinal_metodo', 'pix');
  v_sinal_comp TEXT := p_dados_complementares->>'sinal_comprovante';
  v_forcar_sem_sinal BOOLEAN := COALESCE((p_dados_complementares->>'forcar_confirmacao_sem_sinal')::BOOLEAN, false);
  v_motivo_sem_sinal TEXT := p_dados_complementares->>'motivo_confirmacao_sem_sinal';
  v_forcar_encaixe BOOLEAN := COALESCE((p_dados_complementares->>'forcar_encaixe')::BOOLEAN, false);
  v_motivo_encaixe TEXT := p_dados_complementares->>'motivo_encaixe';
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
  END IF;

  -- 1. Idempotência Transacional Concorrente (E3-8)
  IF v_orc.status = 'convertido' AND v_orc.pedido_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'pedido_id', v_orc.pedido_id,
      'idempotente', true,
      'message', 'Orçamento já convertido em encomenda.'
    );
  END IF;

  -- 2. Guarda de Estado: Somente orçamentos em status 'aprovado' podem ser convertidos (E3-5)
  IF v_orc.status <> 'aprovado' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUOTE_NOT_CONVERTIBLE',
      'status', v_orc.status,
      'error', 'Apenas orçamentos aprovados pelo cliente podem ser convertidos em encomenda.'
    );
  END IF;

  -- 3. Guarda de Janela Operacional: Limite de horas pós-aprovação (E3-7)
  IF v_orc.janela_conversao_limite IS NOT NULL AND NOW() > v_orc.janela_conversao_limite THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'CONVERSION_WINDOW_EXPIRED',
      'error', 'A janela de conversão pós-aprovação (' || v_cfg.janela_conversao_horas || ' horas) expirou. É necessário revalidar custos e renovar a proposta com o cliente.'
    );
  END IF;

  -- 4. Construção dos Itens usando ESTRITAMENTE os Snapshots Imutáveis do Orçamento
  -- (Nunca lê o preço atual da tabela produtos nem produto_opcoes!)
  FOR v_item_rec IN
    SELECT
      oi.id AS orcamento_item_id,
      oi.produto_id,
      oi.quantidade,
      oi.preco_unitario_snapshot,
      oi.cmv_unitario_snapshot,
      oi.pontos_producao_snapshot,
      oi.observacoes
    FROM public.orcamento_itens oi
    WHERE oi.orcamento_id = v_orc.id
    ORDER BY oi.id ASC
  LOOP
    SELECT jsonb_agg(
      jsonb_build_object(
        'opcao_nome', oio.opcao_nome,
        'preco_adicional', oio.preco_adicional_snapshot,
        'pontos_producao_adicionais', oio.pontos_producao_adicionais_snapshot,
        'produto_opcao_id', oio.produto_opcao_id
      )
    )
    INTO v_opcoes_payload
    FROM public.orcamento_item_opcoes oio
    WHERE oio.orcamento_item_id = v_item_rec.orcamento_item_id;

    v_itens_payload := v_itens_payload || jsonb_build_array(
      jsonb_build_object(
        'id', v_item_rec.produto_id,
        'quantidade', v_item_rec.quantidade,
        'opcoes', COALESCE(v_opcoes_payload, '[]'::jsonb),
        'observacoes', v_item_rec.observacoes
      )
    );
  END LOOP;

  -- 5. Montagem do Payload para nucleo_criar_encomenda()
  v_nucleo_payload := jsonb_build_object(
    'cliente_id', v_orc.cliente_id,
    'cliente_nome', v_orc.cliente_nome,
    'cliente_telefone', v_orc.cliente_telefone,
    'cliente_email', v_orc.cliente_email,
    'canal', 'orcamento',
    'data_entrega', v_orc.data_evento,
    'hora_entrega', v_orc.hora_evento,
    'modalidade', v_orc.tipo_entrega,
    'endereco_entrega', v_orc.endereco_entrega,
    'itens', v_itens_payload,
    'taxa_entrega', v_orc.taxa_entrega_cobrada,
    'taxa_entrega_base', v_orc.taxa_entrega_base,
    'desconto_frete', v_orc.desconto_frete,
    'desconto', v_orc.desconto_produtos,
    'motivo_desconto', v_orc.motivo_desconto,
    'sinal_minimo', v_orc.sinal_sugerido,
    'sinal_valor', v_sinal_valor,
    'sinal_metodo', v_sinal_metodo,
    'sinal_comprovante', v_sinal_comp,
    'forcar_confirmacao_sem_sinal', v_forcar_sem_sinal,
    'motivo_confirmacao_sem_sinal', v_motivo_sem_sinal,
    'forcar_encaixe', v_forcar_encaixe,
    'motivo_encaixe', v_motivo_encaixe,
    'observacoes_cliente', v_orc.observacoes_cliente,
    'observacoes_internas', 'Convertido a partir do Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || '). ' || COALESCE(v_orc.observacoes_internas, ''),
    'orcamento_origem_id', v_orc.id
  );

  -- 6. Execução do Núcleo Canônico (Locks ordenados, Capacidade, Estoque atômico, Pedido)
  v_nucleo_res := public.nucleo_criar_encomenda(v_nucleo_payload);

  IF NOT COALESCE((v_nucleo_res->>'success')::BOOLEAN, false) THEN
    -- Rollback implícito ou propagação de erro mantendo o orçamento intacto (E3-10)
    RETURN v_nucleo_res;
  END IF;

  v_pedido_id := (v_nucleo_res->>'pedido_id')::BIGINT;

  -- 7. Atualização do Orçamento para Convertido com Vinculação Bidirecional
  UPDATE public.orcamentos SET
    status = 'convertido',
    pedido_id = v_pedido_id,
    convertido_em = NOW(),
    updated_at = NOW()
  WHERE id = v_orc.id;

  SELECT COALESCE(p.nome, u.email, 'Equipe') INTO v_user_nome
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE u.id = auth.uid();

  INSERT INTO public.orcamento_status_historico (
    orcamento_id, evento, status_anterior, status_novo, versao, origem, ator_id, ator_nome, metadata
  ) VALUES (
    v_orc.id, 'CONVERTIDO', 'aprovado', 'convertido', v_orc.versao, 'admin', auth.uid(), v_user_nome,
    jsonb_build_object('pedido_id', v_pedido_id, 'nucleo_resultado', v_nucleo_res)
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', v_pedido_id,
    'orcamento_id', v_orc.id,
    'numero', v_orc.numero,
    'idempotente', false,
    'detalhes_pedido', v_nucleo_res
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.converter_orcamento_em_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.converter_orcamento_em_pedido_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 15. RPC REGISTRO DE COMUNICAÇÕES WHATSAPP
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_comunicacao_orcamento_admin(
  p_orcamento_id BIGINT,
  p_canal TEXT,
  p_tipo TEXT,
  p_destinatario TEXT,
  p_mensagem TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada.');
  END IF;

  INSERT INTO public.orcamento_comunicacoes (
    orcamento_id, canal, tipo, destinatario_telefone, mensagem_preview, disparado_por, metadata
  ) VALUES (
    p_orcamento_id, LOWER(TRIM(p_canal)), LOWER(TRIM(p_tipo)),
    TRIM(p_destinatario), TRIM(p_mensagem), auth.uid(), p_metadata
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'comunicacao_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_orcamento_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_orcamento_admin TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 16. RPC BUSCAR ORÇAMENTOS (BACKOFFICE / FILTROS E PAGINAÇÃO)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.buscar_orcamentos_admin(
  p_busca TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_termo TEXT := NULLIF(TRIM(COALESCE(p_busca, '')), '');
  v_st TEXT := NULLIF(TRIM(COALESCE(p_novo_status, p_status, '')), '');
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


-- ==========================================================================
-- >>> MIGRATION 014_governanca_catalogo_estoque_e_portas_dominio.sql
-- ==========================================================================

-- ==============================================================================
-- MIGRATION 014: GOVERNANÇA DE CATÁLOGO, ESTOQUE ATÔMICO & PORTAS DE DOMÍNIO
-- ==============================================================================
-- 1. ESTOQUE ATÔMICO: RPC ajustar_estoque_operacao() com lock FOR UPDATE,
--    validação contra reserva e gravação atômica em estoque_movimentacoes.
-- 2. CATÁLOGO & RLS: Operador perde UPDATE/INSERT direto em produtos e produto_opcoes.
--    Trigger impede operador de desativar controlar_estoque.
-- 3. PORTAS COMERCIAIS DEDICADAS: cancelar_pedido_equipe() e
--    gerenciar_confirmacao_pedido_admin(), desacoplando o comercial de alterar_status_pedido().
-- 4. DESCONTO DINÂMICO: configuracoes_operacao.desconto_operador_percentual_max (default 10.00)
--    consumido dinamicamente por politica_desconto().
-- ==============================================================================

-- --------------------------------------------------------------------------
-- 1. CONFIGURAÇÃO DE DESCONTO DINÂMICO EM CONFIGURACOES_OPERACAO
-- --------------------------------------------------------------------------
ALTER TABLE public.configuracoes_operacao
  ADD COLUMN IF NOT EXISTS desconto_operador_percentual_max NUMERIC(5,2) NOT NULL DEFAULT 10.00;

-- Atualizar helper de leitura de configurações com fallback seguro
CREATE OR REPLACE FUNCTION public.obter_config_operacao()
RETURNS public.configuracoes_operacao AS $$
DECLARE
  v_cfg public.configuracoes_operacao;
BEGIN
  SELECT * INTO v_cfg FROM public.configuracoes_operacao WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.id := 1;
    v_cfg.sinal_percentual_padrao := 50.00;
    v_cfg.hold_horas_padrao := 24;
    v_cfg.antecedencia_confirmacao_horas := 2;
    v_cfg.hold_pix_loja_minutos := 30;
    v_cfg.capacidade_padrao_pontos := 30.00;
    v_cfg.timezone := 'America/Fortaleza';
    v_cfg.validade_orcamento_horas := 120;
    v_cfg.antecedencia_minima_orcamento_horas := 24;
    v_cfg.janela_conversao_horas := 24;
    v_cfg.taxa_entrega_padrao := 15.00;
    v_cfg.desconto_operador_percentual_max := 10.00;
  END IF;

  IF v_cfg.desconto_operador_percentual_max IS NULL THEN
    v_cfg.desconto_operador_percentual_max := 10.00;
  END IF;

  BEGIN
    PERFORM NOW() AT TIME ZONE v_cfg.timezone;
  EXCEPTION WHEN OTHERS THEN
    v_cfg.timezone := 'America/Fortaleza';
  END;

  RETURN v_cfg;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- Atualizar politica_desconto() para consumir o teto da configuração dinamicamente
CREATE OR REPLACE FUNCTION public.politica_desconto(
  p_subtotal NUMERIC,
  p_desconto NUMERIC,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_teto_operador NUMERIC(5,2) := COALESCE(v_cfg.desconto_operador_percentual_max, 10.00);
  v_subtotal NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_subtotal, 0.00));
  v_desc NUMERIC(10,2) := GREATEST(0.00, COALESCE(p_desconto, 0.00));
  v_pct NUMERIC(6,2) := 0.00;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode aplicar descontos.');
  END IF;

  IF v_desc <= 0.00 THEN
    RETURN jsonb_build_object(
      'success', true,
      'desconto_aprovado', 0.00,
      'percentual', 0.00,
      'excecao_admin', false,
      'motivo', NULL
    );
  END IF;

  IF v_subtotal <= 0.00 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_SUBTOTAL', 'error', 'Subtotal dos produtos inválido para cálculo de desconto.');
  END IF;

  IF v_desc > v_subtotal THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_EXCEEDS_SUBTOTAL', 'error', 'O valor do desconto não pode exceder o subtotal dos produtos.');
  END IF;

  v_pct := ROUND((v_desc / v_subtotal) * 100.0, 2);

  -- Teto de operador dinâmico derivado de configuracoes_operacao
  IF v_pct > v_teto_operador AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED',
      'teto_operador_percentual', v_teto_operador,
      'teto_operador_valor', ROUND(v_subtotal * (v_teto_operador / 100.0), 2),
      'error', 'Operadores podem conceder no máximo ' || v_teto_operador || '% de desconto (R$ ' || (ROUND(v_subtotal * (v_teto_operador / 100.0), 2))::NUMERIC(10,2) || '). Descontos maiores requerem perfil de Administrador.'
    );
  END IF;

  -- Justificativa auditável obrigatória para QUALQUER desconto > 0 (D3)
  IF v_desc > 0.00 AND (v_motivo IS NULL OR length(v_motivo) < 5) THEN
    RETURN jsonb_build_object('success', false, 'code', 'DISCOUNT_REASON_REQUIRED', 'error', 'Por favor, informe a justificativa do desconto concedido (mínimo 5 caracteres).');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'desconto_aprovado', v_desc,
    'percentual', v_pct,
    'excecao_admin', (v_pct > v_teto_operador),
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.politica_desconto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.politica_desconto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 2. ESTOQUE ATÔMICO: RPC AJUSTAR_ESTOQUE_OPERACAO()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ajustar_estoque_operacao(
  p_produto_id BIGINT,
  p_tipo TEXT,
  p_quantidade INT DEFAULT NULL,
  p_novo_saldo_fisico INT DEFAULT NULL,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
  v_delta INT := 0;
  v_fisico_antigo INT;
  v_fisico_novo INT;
  v_reservado INT;
  v_qtd_novo INT;
  v_mov_id BIGINT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode ajustar estoque.');
  END IF;

  IF p_produto_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_ID_REQUIRED', 'error', 'ID do produto é obrigatório.');
  END IF;

  IF p_tipo NOT IN ('entrada', 'saida', 'perda', 'contagem') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_OPERATION_TYPE', 'error', 'Tipo de operação inválido. Use entrada, saida, perda ou contagem.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- 1. Trava a linha do produto no banco
  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_NOT_FOUND', 'error', 'Produto não encontrado.');
  END IF;

  v_fisico_antigo := COALESCE(v_prod.estoque_fisico, 0);
  v_reservado := COALESCE(v_prod.estoque_reservado, 0);

  -- 2. Determinar novo saldo físico
  IF p_tipo = 'entrada' THEN
    IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'Quantidade de entrada deve ser maior que zero.');
    END IF;
    v_delta := p_quantidade;
    v_fisico_novo := v_fisico_antigo + v_delta;

  ELSIF p_tipo IN ('saida', 'perda') THEN
    IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_QUANTITY', 'error', 'Quantidade deve ser maior que zero.');
    END IF;
    v_delta := p_quantidade;
    v_fisico_novo := v_fisico_antigo - v_delta;

  ELSIF p_tipo = 'contagem' THEN
    IF p_novo_saldo_fisico IS NULL OR p_novo_saldo_fisico < 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_COUNT_BALANCE', 'error', 'Saldo da contagem deve ser informado e não negativo.');
    END IF;
    v_fisico_novo := p_novo_saldo_fisico;
    v_delta := ABS(v_fisico_novo - v_fisico_antigo);
  END IF;

  -- 3. Invariante: estoque_fisico nunca pode ficar menor que estoque_reservado
  IF v_fisico_novo < v_reservado THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'RESERVED_STOCK_CONFLICT',
      'estoque_fisico_tentado', v_fisico_novo,
      'estoque_reservado', v_reservado,
      'error', 'Ajuste rejeitado: o novo saldo físico (' || v_fisico_novo || ') não pode ser menor que o estoque reservado ativo (' || v_reservado || ').'
    );
  END IF;

  v_qtd_novo := v_fisico_novo - v_reservado;

  -- 4. Sinalizar mutação interna controlada para o trigger de proteção
  PERFORM set_config('lunoca.internal_stock_mutation', 'on', true);

  UPDATE public.produtos
  SET 
    estoque_fisico = v_fisico_novo,
    estoque_qtd = v_qtd_novo,
    updated_at = NOW()
  WHERE id = p_produto_id;

  -- 5. Gravar movimentação de estoque na mesma transação atômica
  INSERT INTO public.estoque_movimentacoes (
    produto_id,
    produto_nome,
    tipo,
    quantidade,
    saldo_resultante,
    motivo,
    usuario_nome,
    created_at
  ) VALUES (
    p_produto_id,
    v_prod.nome,
    CASE WHEN p_tipo = 'contagem' THEN 'ajuste' ELSE p_tipo END,
    v_delta,
    v_fisico_novo,
    COALESCE(v_motivo, CASE 
      WHEN p_tipo = 'entrada' THEN 'Entrada manual de estoque'
      WHEN p_tipo = 'saida' THEN 'Saída manual de estoque'
      WHEN p_tipo = 'perda' THEN 'Perda de estoque registrada'
      WHEN p_tipo = 'contagem' THEN 'Ajuste de inventário / contagem'
    END),
    v_user_nome,
    NOW()
  ) RETURNING id INTO v_mov_id;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'produto_nome', v_prod.nome,
    'tipo', p_tipo,
    'delta', v_delta,
    'estoque_fisico_anterior', v_fisico_antigo,
    'estoque_fisico_novo', v_fisico_novo,
    'estoque_reservado', v_reservado,
    'estoque_qtd_novo', v_qtd_novo,
    'movimentacao_id', v_mov_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.ajustar_estoque_operacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_estoque_operacao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 3. REFORÇO DE TRIGGER & RLS DE PRODUTOS E PRODUTO_OPCOES
-- --------------------------------------------------------------------------
-- Trigger trg_proteger_estoque_produtos: impede operador de desativar controlar_estoque
CREATE OR REPLACE FUNCTION public.fn_proteger_estoque_produtos()
RETURNS TRIGGER AS $$
BEGIN
  -- 1. Mutação de estoque_reservado é estritamente restrita a helpers internos e service_role
  IF NEW.estoque_reservado IS DISTINCT FROM OLD.estoque_reservado THEN
    IF current_setting('lunoca.internal_stock_mutation', true) IS DISTINCT FROM 'on' AND auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Modificação direta de estoque_reservado não é permitida. Use os fluxos de reserva/liberação.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Mutação de estoque_fisico requer Administrador, service_role ou helper interno
  IF NEW.estoque_fisico IS DISTINCT FROM OLD.estoque_fisico THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role' OR current_setting('lunoca.internal_stock_mutation', true) = 'on') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o saldo de estoque físico do produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 3. Alternar controlar_estoque requer privilégio de Administrador
  IF NEW.controlar_estoque IS DISTINCT FROM OLD.controlar_estoque THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED: Apenas Administradores podem alterar o controle de estoque de um produto.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- RLS Fechado: Operador perde UPDATE direto em produtos e produto_opcoes
-- Modificações de dados de catálogo (nome, preço, descrição) são exclusivas de Administradores
DROP POLICY IF EXISTS "Admins e operadores podem atualizar produtos" ON public.produtos;
DROP POLICY IF EXISTS "Admins e operadores podem inserir produtos" ON public.produtos;
DROP POLICY IF EXISTS "Operadores e admins atualizam produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins atualizam produtos" ON public.produtos;
CREATE POLICY "Apenas admins atualizam produtos" 
  ON public.produtos FOR UPDATE 
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Operadores e admins inserem produtos" ON public.produtos;
DROP POLICY IF EXISTS "Apenas admins inserem produtos" ON public.produtos;
CREATE POLICY "Apenas admins inserem produtos" 
  ON public.produtos FOR INSERT 
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Equipe gerencia opções de produtos" ON public.produto_opcoes;
DROP POLICY IF EXISTS "Apenas admins gerenciam opções de produtos" ON public.produto_opcoes;
CREATE POLICY "Apenas admins gerenciam opções de produtos" 
  ON public.produto_opcoes FOR ALL 
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Porta de domínio dedicada para alternar controle de estoque (exclusiva Admin)
CREATE OR REPLACE FUNCTION public.alterar_controle_estoque_produto(
  p_produto_id BIGINT,
  p_controlar BOOLEAN
)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas Administradores podem alterar o controle de estoque de um produto.');
  END IF;

  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_NOT_FOUND', 'error', 'Produto não encontrado.');
  END IF;

  UPDATE public.produtos
  SET controlar_estoque = p_controlar, updated_at = NOW()
  WHERE id = p_produto_id;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'controlar_estoque', p_controlar
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.alterar_controle_estoque_produto FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.alterar_controle_estoque_produto TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 4. PORTAS COMERCIAIS DEDICADAS
-- --------------------------------------------------------------------------

-- 4.1 CANCELAMENTO COMERCIAL E OPERACIONAL DEDICADO
CREATE OR REPLACE FUNCTION public.cancelar_pedido_equipe(
  p_pedido_id BIGINT,
  p_motivo TEXT DEFAULT NULL,
  p_destino_valor TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ped RECORD;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas administradores ou operadores podem cancelar pedidos.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido obrigatório.');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  -- Idempotência: se já está cancelado comercial e operacionalmente
  IF v_ped.status_comercial = 'cancelado' AND v_ped.status_operacional = 'cancelado' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'pedido_id', p_pedido_id,
      'status_comercial', 'cancelado',
      'status_operacional', 'cancelado'
    );
  END IF;

  -- Guarda de Produção Ativa: se já em preparo/pronto/entrega, operador é bloqueado
  IF v_ped.status_operacional NOT IN ('aguardando_producao', 'cancelado') AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PRODUCTION_ACTIVE_CANCEL_DENIED',
      'error', 'Pedidos com produção já iniciada ("' || v_ped.status_operacional || '") só podem ser cancelados por Administradores.'
    );
  END IF;

  -- Guarda S3b: Cancelamento com valor pago exige destino de valor
  IF v_ped.valor_pago > 0.00 AND NOT v_is_admin THEN
    IF COALESCE(p_destino_valor, '') <> 'RETENCAO_CANCELAMENTO' AND v_ped.status_financeiro <> 'estornado' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'CANCELLATION_REQUIRES_VALUE_DESTINATION',
        'error', 'Pedido com pagamentos ativos requer estorno prévio ou definição explícita de retenção (destino_valor = RETENCAO_CANCELAMENTO).'
      );
    END IF;
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  -- Atualiza o pedido. O trigger trg_liberar_reserva_ao_cancelar cuidará de liberar o estoque e capacidade
  UPDATE public.pedidos
  SET 
    status_comercial = 'cancelado',
    status_operacional = 'cancelado',
    updated_at = NOW()
  WHERE id = p_pedido_id;

  -- Registra no histórico auditável
  INSERT INTO public.pedidos_historico (
    pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
  ) VALUES (
    p_pedido_id,
    auth.uid(),
    v_user_nome,
    v_ped.status_comercial,
    'cancelado',
    COALESCE(v_motivo, 'Cancelamento via porta dedicada cancelar_pedido_equipe'),
    jsonb_build_object(
      'porta_dominio', 'cancelar_pedido_equipe',
      'destino_valor', p_destino_valor,
      'status_operacional_anterior', v_ped.status_operacional
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_comercial', 'cancelado',
    'status_operacional', 'cancelado',
    'reservas_liberadas', true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.cancelar_pedido_equipe FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_equipe TO authenticated, service_role;

-- 4.2 CONFIRMAÇÃO EXCEPCIONAL ADMINISTRATIVA DEDICADA
CREATE OR REPLACE FUNCTION public.gerenciar_confirmacao_pedido_admin(
  p_pedido_id BIGINT,
  p_motivo TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_ped RECORD;
  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo, '')), '');
  v_user_nome TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas Administradores podem gerenciar confirmações excepcionais.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido obrigatório.');
  END IF;

  IF v_motivo IS NULL OR length(v_motivo) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'REASON_REQUIRED', 'error', 'A confirmação excepcional exige justificativa auditável (mínimo 5 caracteres).');
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  IF v_ped.status_comercial = 'confirmado' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'pedido_id', p_pedido_id, 'status_comercial', 'confirmado');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Administrador' END;
  END IF;

  UPDATE public.pedidos
  SET 
    status_comercial = 'confirmado',
    updated_at = NOW()
  WHERE id = p_pedido_id;

  INSERT INTO public.pedidos_historico (
    pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
  ) VALUES (
    p_pedido_id,
    auth.uid(),
    v_user_nome,
    v_ped.status_comercial,
    'confirmado',
    v_motivo,
    jsonb_build_object(
      'porta_dominio', 'gerenciar_confirmacao_pedido_admin',
      'sinal_minimo', v_ped.sinal_minimo,
      'valor_pago', v_ped.valor_pago
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'status_comercial', 'confirmado',
    'motivo', v_motivo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.gerenciar_confirmacao_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerenciar_confirmacao_pedido_admin TO authenticated, service_role;

-- 4.3 RESTRINGIR DIMENSÃO COMERCIAL EM ALTERAR_STATUS_PEDIDO
-- Delegar transições comerciais para as portas de domínio dedicadas
CREATE OR REPLACE FUNCTION public.alterar_status_pedido(
  p_pedido_id BIGINT,
  p_dimensao TEXT,
  p_novo_status TEXT,
  p_motivo TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSON AS $$
DECLARE
  v_ped RECORD;
  v_status_antigo TEXT;
  v_permitido BOOLEAN := false;
  v_user_nome TEXT;
  v_is_admin BOOLEAN := public.is_admin();
  v_is_equipe BOOLEAN := public.is_admin_or_operator();
  v_res_porta JSONB;
BEGIN
  IF NOT v_is_equipe THEN
    RETURN json_build_object('success', false, 'error', 'Permissão negada. Apenas administradores ou operadores podem alterar status.');
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'ID do pedido obrigatório.');
  END IF;

  -- Se for dimensão comercial, delegar para as portas de domínio correspondentes
  IF p_dimensao = 'comercial' THEN
    IF p_novo_status = 'cancelado' THEN
      v_res_porta := public.cancelar_pedido_equipe(p_pedido_id, p_motivo, p_metadata->>'destino_valor');
      RETURN v_res_porta::json;
    ELSIF p_novo_status = 'confirmado' THEN
      SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
      IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
      END IF;
      -- Se não tem sinal pago integral, exige a porta administrativa dedicada
      IF v_ped.valor_pago < v_ped.sinal_minimo THEN
        v_res_porta := public.gerenciar_confirmacao_pedido_admin(p_pedido_id, p_motivo);
        RETURN v_res_porta::json;
      END IF;
    END IF;
  END IF;

  -- Dimensão estritamente operacional ou confirmação comercial com sinal pago
  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  SELECT nome INTO v_user_nome FROM public.profiles WHERE id = auth.uid();
  IF v_user_nome IS NULL THEN
    v_user_nome := CASE WHEN auth.role() = 'service_role' THEN 'Sistema / service_role' ELSE 'Equipe' END;
  END IF;

  IF p_dimensao = 'operacional' THEN
    v_status_antigo := v_ped.status_operacional;

    IF p_novo_status NOT IN ('aguardando_producao', 'em_producao', 'pronto', 'saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      RETURN json_build_object('success', false, 'error', 'Status operacional inválido: ' || p_novo_status);
    END IF;

    -- Matriz de transições operacionais
    IF v_status_antigo = p_novo_status THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'aguardando_producao' AND p_novo_status IN ('em_producao', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'em_producao' AND p_novo_status IN ('pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'pronto' AND p_novo_status IN ('saiu_para_entrega', 'entregue', 'retirado', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_status_antigo = 'saiu_para_entrega' AND p_novo_status IN ('entregue', 'pronto', 'cancelado') THEN
      v_permitido := true;
    ELSIF v_is_admin THEN
      v_permitido := true;
    END IF;

    IF NOT v_permitido THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Transição operacional não permitida de "' || v_status_antigo || '" para "' || p_novo_status || '".'
      );
    END IF;

    UPDATE public.pedidos
    SET 
      status_operacional = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedidos_historico (
      pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
    ) VALUES (
      p_pedido_id,
      auth.uid(),
      v_user_nome,
      v_status_antigo,
      p_novo_status,
      p_motivo,
      p_metadata
    );

    RETURN json_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'dimensao', 'operacional',
      'status_anterior', v_status_antigo,
      'status_novo', p_novo_status
    );

  ELSIF p_dimensao = 'comercial' THEN
    -- Apenas transição para confirmado com sinal pago atinge este ponto
    v_status_antigo := v_ped.status_comercial;

    IF v_status_antigo = p_novo_status THEN
      RETURN json_build_object('success', true, 'pedido_id', p_pedido_id, 'status_comercial', p_novo_status);
    END IF;

    UPDATE public.pedidos
    SET 
      status_comercial = p_novo_status,
      updated_at = NOW()
    WHERE id = p_pedido_id;

    INSERT INTO public.pedidos_historico (
      pedido_id, usuario_id, usuario_nome, status_anterior, status_novo, motivo, metadata
    ) VALUES (
      p_pedido_id,
      auth.uid(),
      v_user_nome,
      v_status_antigo,
      p_novo_status,
      p_motivo,
      p_metadata
    );

    RETURN json_build_object(
      'success', true,
      'pedido_id', p_pedido_id,
      'dimensao', 'comercial',
      'status_anterior', v_status_antigo,
      'status_novo', p_novo_status
    );
  ELSE
    RETURN json_build_object('success', false, 'error', 'Dimensão desconhecida: ' || p_dimensao);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;


-- ==========================================================================
-- >>> MIGRATION 015_comunicacao_whatsapp_e_relacionamento.sql
-- ==========================================================================

-- ==========================================================================
-- LUNOCA DOCERIA - MIGRATION 015: COMUNICAÇÃO WHATSAPP & RELACIONAMENTO
-- ==========================================================================
-- Contratos Consolidados:
-- 1. Tabela canônica única public.comunicacoes_cliente com duas FKs opcionais
--    (orcamento_id, pedido_id) e constraint XOR de integridade referencial.
-- 2. Chaves de idempotência determinísticas e granulares por evento/versão.
-- 3. Renderizador canônico server-side (obter_preview_comunicacao) com dados de snapshots.
-- 4. Registro de comunicação (registrar_comunicacao_cliente) blindado contra falsificação:
--    rejeita status "enviado" para canal "whatsapp_link" (aceita apenas link_aberto/gerado).
-- 5. Link público canônico estritamente padronizado em /orcamento.html?t=<token>.
-- 6. Aprovação pública vinculada à versão esperada (QUOTE_VERSION_CHANGED).
-- 7. Normalização rigorosa de telefone E.164 (sem adição cega de 9º dígito).
-- 8. Busca de pendências de lembrete de orçamentos (listar_orcamentos_para_lembrete).
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. COMPATIBILIDADE DE SESSÃO ADMIN/OPERADOR (POSTGRES / SERVICE ROLE)
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') OR auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

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
  IF current_user IN ('postgres', 'supabase_admin') OR auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() 
      AND nivel IN ('admin', 'operador') 
      AND ativo = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- --------------------------------------------------------------------------
-- 1. TABELA CANÔNICA DE COMUNICAÇÕES COM O CLIENTE
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comunicacoes_cliente (
  id BIGSERIAL PRIMARY KEY,
  orcamento_id BIGINT REFERENCES public.orcamentos(id) ON DELETE CASCADE,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (
    tipo IN (
      'ORCAMENTO_ENVIADO',
      'ORCAMENTO_VENCENDO',
      'SINAL_CONFIRMADO',
      'PEDIDO_PRONTO',
      'SAIU_PARA_ENTREGA'
    )
  ),
  canal TEXT NOT NULL CHECK (
    canal IN ('whatsapp_link', 'evolution_api')
  ),
  destinatario TEXT NOT NULL,
  mensagem_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'gerado',
      'link_aberto',
      'enviado',
      'entregue',
      'falhou'
    )
  ),
  provider TEXT,
  provider_message_id TEXT,
  chave_idempotencia TEXT NOT NULL UNIQUE,
  erro TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  CONSTRAINT ck_comunicacao_entidade CHECK (
    (orcamento_id IS NOT NULL AND pedido_id IS NULL)
    OR
    (orcamento_id IS NULL AND pedido_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_orcamento_id ON public.comunicacoes_cliente(orcamento_id) WHERE orcamento_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_pedido_id ON public.comunicacoes_cliente(pedido_id) WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_tipo ON public.comunicacoes_cliente(tipo);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_status ON public.comunicacoes_cliente(status);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_cliente_created_at ON public.comunicacoes_cliente(created_at DESC);

-- --------------------------------------------------------------------------
-- 2. BACKFILL IDEMPOTENTE DA TABELA LEGADA ORCAMENTO_COMUNICACOES
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orcamento_comunicacoes') THEN
    INSERT INTO public.comunicacoes_cliente (
      orcamento_id,
      tipo,
      canal,
      destinatario,
      mensagem_snapshot,
      status,
      provider,
      chave_idempotencia,
      metadata,
      criado_por,
      created_at,
      enviado_em
    )
    SELECT
      oc.orcamento_id,
      CASE
        WHEN oc.tipo = 'lembrete_validade' THEN 'ORCAMENTO_VENCENDO'
        ELSE 'ORCAMENTO_ENVIADO'
      END,
      CASE
        WHEN oc.canal = 'evolution_api' THEN 'evolution_api'
        ELSE 'whatsapp_link'
      END,
      oc.destinatario_telefone,
      oc.mensagem_preview,
      CASE
        WHEN oc.canal = 'evolution_api' THEN 'enviado'
        ELSE 'link_aberto'
      END,
      CASE WHEN oc.canal = 'evolution_api' THEN 'evolution_api' ELSE NULL END,
      'legacy:orcamento_comunicacoes:' || oc.id,
      COALESCE(oc.metadata, '{}'::jsonb),
      oc.disparado_por,
      oc.disparado_em,
      CASE WHEN oc.canal = 'evolution_api' THEN oc.disparado_em ELSE NULL END
    FROM public.orcamento_comunicacoes oc
    WHERE oc.orcamento_id IS NOT NULL
    ON CONFLICT (chave_idempotencia) DO NOTHING;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 3. RLS EM COMUNICACOES_CLIENTE (FAIL-CLOSED)
-- --------------------------------------------------------------------------
ALTER TABLE public.comunicacoes_cliente ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Equipe visualiza comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe visualiza comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR SELECT
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe insere comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe insere comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR INSERT
  WITH CHECK (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Equipe atualiza comunicacoes com cliente" ON public.comunicacoes_cliente;
CREATE POLICY "Equipe atualiza comunicacoes com cliente"
  ON public.comunicacoes_cliente FOR UPDATE
  USING (public.is_admin_or_operator())
  WITH CHECK (public.is_admin_or_operator());

-- --------------------------------------------------------------------------
-- 4. FUNÇÃO AUXILIAR: NORMALIZAÇÃO RIGOROSA DE TELEFONE E.164
-- --------------------------------------------------------------------------
-- Rejeita formatos ambíguos ou inválidos sem adicionar cegamente 9º dígito.
CREATE OR REPLACE FUNCTION public.normalizar_telefone_e164(
  p_telefone TEXT
)
RETURNS TEXT AS $$
DECLARE
  v_num TEXT;
  v_ddd INT;
BEGIN
  IF p_telefone IS NULL THEN
    RETURN NULL;
  END IF;

  -- Remove tudo que não for dígito
  v_num := regexp_replace(p_telefone, '\D', '', 'g');

  -- Tamanho mínimo nacional: 10 dígitos (DDD + 8 dígitos fixo)
  -- Tamanho máximo internacional com DDI 55: 13 dígitos (55 + DDD + 9 dígitos celular)
  IF length(v_num) < 10 OR length(v_num) > 13 THEN
    RETURN NULL;
  END IF;

  -- Se começa com DDI 55
  IF substring(v_num FROM 1 FOR 2) = '55' THEN
    IF length(v_num) = 12 THEN
      -- 55 + DDD (2) + 8 dígitos (fixo)
      v_ddd := substring(v_num FROM 3 FOR 2)::INT;
      IF v_ddd >= 11 AND v_ddd <= 99 THEN
        RETURN v_num;
      END IF;
    ELSIF length(v_num) = 13 THEN
      -- 55 + DDD (2) + 9 dígitos (celular, deve começar com 9)
      v_ddd := substring(v_num FROM 3 FOR 2)::INT;
      IF v_ddd >= 11 AND v_ddd <= 99 AND substring(v_num FROM 5 FOR 1) = '9' THEN
        RETURN v_num;
      END IF;
    END IF;
    -- Qualquer outra extensão com 55 é inválida
    RETURN NULL;
  END IF;

  -- Sem DDI: número nacional brasileiro
  IF length(v_num) = 10 THEN
    -- DDD (2) + 8 dígitos (fixo)
    v_ddd := substring(v_num FROM 1 FOR 2)::INT;
    IF v_ddd >= 11 AND v_ddd <= 99 THEN
      RETURN '55' || v_num;
    END IF;
  ELSIF length(v_num) = 11 THEN
    -- DDD (2) + 9 dígitos (celular, deve começar com 9)
    v_ddd := substring(v_num FROM 1 FOR 2)::INT;
    IF v_ddd >= 11 AND v_ddd <= 99 AND substring(v_num FROM 3 FOR 1) = '9' THEN
      RETURN '55' || v_num;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- --------------------------------------------------------------------------
-- 5. RENDERIZADOR CANÔNICO SERVER-SIDE: OBTER_PREVIEW_COMUNICACAO()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_preview_comunicacao(
  p_tipo TEXT,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_orc public.orcamentos;
  v_ped public.pedidos;
  v_pag RECORD;
  v_hist RECORD;
  v_telefone_raw TEXT;
  v_telefone_norm TEXT;
  v_mensagem TEXT;
  v_chave_idempotencia TEXT;
  v_link_publico TEXT := NULL;
  v_saldo_restante NUMERIC(10,2);
  v_valor_sinal NUMERIC(10,2);
  v_data_formatada TEXT;
  v_hora_formatada TEXT;
  v_validade_formatada TEXT;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO', 'SINAL_CONFIRMADO', 'PEDIDO_PRONTO', 'SAIU_PARA_ENTREGA') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_TEMPLATE_TYPE', 'error', 'Tipo de template de comunicação inválido.');
  END IF;

  -- Validação de entidade coerente com o tipo
  IF p_tipo IN ('ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO') THEN
    IF p_orcamento_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_ID_REQUIRED', 'error', 'ID do orçamento é obrigatório para este template.');
    END IF;

    SELECT * INTO v_orc FROM public.orcamentos WHERE id = p_orcamento_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'ORCAMENTO_NOT_FOUND', 'error', 'Orçamento não encontrado.');
    END IF;

    v_telefone_raw := v_orc.cliente_telefone;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_link_publico := 'https://lunocadoceria.com.br/orcamento.html?t=' || v_orc.token_publico::TEXT;
    v_data_formatada := to_char(v_orc.data_evento, 'DD/MM/YYYY');
    v_hora_formatada := COALESCE(to_char(v_orc.hora_evento, 'HH24:MI'), 'A combinar');
    v_validade_formatada := to_char(v_orc.validade_ate AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI');

    IF p_tipo = 'ORCAMENTO_ENVIADO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':envio';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Preparamos sua proposta Lunoca:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Evento: ' || v_data_formatada || ' às ' || v_hora_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n\n' ||
                    'Veja todos os detalhes e aprove sua proposta:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'A aprovação da proposta não reserva estoque ou capacidade até que a encomenda seja efetivamente convertida e confirmada.';

    ELSIF p_tipo = 'ORCAMENTO_VENCENDO' THEN
      v_chave_idempotencia := 'orcamento:' || v_orc.id || ':v' || v_orc.versao || ':vencendo';
      v_mensagem := 'Olá, ' || v_orc.cliente_nome || '! 🎂' || E'\n\n' ||
                    'Lembramos que sua proposta Lunoca está próxima do vencimento:' || E'\n' ||
                    'Orçamento ' || v_orc.numero || ' (v' || v_orc.versao || ')' || E'\n' ||
                    'Validade: até ' || v_validade_formatada || E'\n' ||
                    'Total: R$ ' || to_char(v_orc.total, 'FM999G999G990D00') || E'\n\n' ||
                    'Acesse para conferir ou aprovar antes do prazo expirar:' || E'\n' ||
                    v_link_publico || E'\n\n' ||
                    'Lembramos que a disponibilidade de data e capacidade de produção permanece sujeita à confirmação no momento da conversão da encomenda.';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'entidade_tipo', 'orcamento',
      'orcamento_id', v_orc.id,
      'numero', v_orc.numero,
      'versao', v_orc.versao,
      'cliente_nome', v_orc.cliente_nome,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', v_link_publico,
      'chave_idempotencia', v_chave_idempotencia
    );

  ELSE
    -- Templates vinculados a Pedidos
    IF p_pedido_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_ID_REQUIRED', 'error', 'ID do pedido é obrigatório para este template.');
    END IF;

    SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'PEDIDO_NOT_FOUND', 'error', 'Pedido não encontrado.');
    END IF;

    v_telefone_raw := v_ped.telefone_cliente;
    v_telefone_norm := public.normalizar_telefone_e164(v_telefone_raw);
    IF v_telefone_norm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'INVALID_PHONE', 'telefone_informado', v_telefone_raw, 'error', 'Telefone do cliente inválido ou ambíguo. Corrija o cadastro para prosseguir.');
    END IF;

    v_data_formatada := COALESCE(to_char(v_ped.data_entrega, 'DD/MM/YYYY'), 'A combinar');
    v_hora_formatada := COALESCE(to_char(v_ped.hora_entrega, 'HH24:MI'), 'A combinar');
    v_saldo_restante := GREATEST(0.00, COALESCE(v_ped.total, 0.00) - COALESCE(v_ped.valor_pago, 0.00));

    IF p_tipo = 'SINAL_CONFIRMADO' THEN
      -- Busca o último pagamento aprovado do pedido
      SELECT id, valor INTO v_pag
      FROM public.pedido_pagamentos
      WHERE pedido_id = v_ped.id AND status = 'aprovado'
      ORDER BY id DESC LIMIT 1;

      IF NOT FOUND THEN
        -- Fallback seguro: se valor_pago > 0 mas sem linha em pedido_pagamentos
        IF COALESCE(v_ped.valor_pago, 0.00) > 0.00 THEN
          v_valor_sinal := v_ped.valor_pago;
          v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:0:sinal';
        ELSE
          RETURN jsonb_build_object('success', false, 'code', 'PAYMENT_NOT_APPROVED', 'error', 'Nenhum pagamento aprovado foi localizado para este pedido.');
        END IF;
      ELSE
        v_valor_sinal := v_pag.valor;
        v_chave_idempotencia := 'pedido:' || v_ped.id || ':pagamento:' || v_pag.id || ':sinal';
      END IF;

      v_mensagem := 'Recebemos seu sinal de R$ ' || to_char(v_valor_sinal, 'FM999G999G990D00') || ' ✅' || E'\n\n' ||
                    'Encomenda #' || v_ped.id || ' confirmada!' || E'\n' ||
                    'Data: ' || v_data_formatada || E'\n' ||
                    'Horário: ' || v_hora_formatada || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n' ||
                    'Total: R$ ' || to_char(v_ped.total, 'FM999G999G990D00') || E'\n' ||
                    'Saldo restante: R$ ' || to_char(v_saldo_restante, 'FM999G999G990D00') || E'\n\n' ||
                    'Agradecemos a confiança! Em breve sua encomenda entrará em produção.';

    ELSIF p_tipo = 'PEDIDO_PRONTO' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo = 'pronto'
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':pronto';
      v_mensagem := 'Sua encomenda está pronta! 🎂✨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Cliente: ' || v_ped.nome_cliente || E'\n' ||
                    'Modalidade: ' || CASE WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Entrega' ELSE 'Retirada na loja' END || E'\n\n' ||
                    CASE 
                      WHEN COALESCE(v_ped.modalidade_entrega, 'retirada') = 'entrega' THEN 'Já finalizamos a preparação e em breve seu pedido sairá para entrega!'
                      ELSE 'Seu pedido já está disponível para retirada em nossa doceria. Aguardamos sua visita!'
                    END;

    ELSIF p_tipo = 'SAIU_PARA_ENTREGA' THEN
      SELECT id INTO v_hist
      FROM public.pedido_status_historico
      WHERE pedido_id = v_ped.id AND status_novo IN ('entregue', 'saiu_para_entrega', 'em_rota')
      ORDER BY id DESC LIMIT 1;

      v_chave_idempotencia := 'pedido:' || v_ped.id || ':historico:' || COALESCE(v_hist.id::TEXT, '0') || ':entrega';
      v_mensagem := 'Sua encomenda Lunoca saiu para entrega! 🚗💨' || E'\n\n' ||
                    'Pedido #' || v_ped.id || E'\n' ||
                    'Destinatário: ' || v_ped.nome_cliente || E'\n' ||
                    'Endereço: ' || COALESCE(v_ped.endereco_entrega, 'Conforme combinado') || E'\n\n' ||
                    'Por favor, certifique-se de que haverá alguém para receber o pedido.' || E'\n' ||
                    'Bom apetite! 🍰';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'tipo', p_tipo,
      'entidade_tipo', 'pedido',
      'pedido_id', v_ped.id,
      'cliente_nome', v_ped.nome_cliente,
      'telefone', v_telefone_norm,
      'mensagem', v_mensagem,
      'link_publico', NULL,
      'chave_idempotencia', v_chave_idempotencia
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_preview_comunicacao FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_preview_comunicacao TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 6. REGISTRO AUDITÁVEL DE COMUNICAÇÃO: REGISTRAR_COMUNICACAO_CLIENTE()
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_comunicacao_cliente(
  p_tipo TEXT,
  p_orcamento_id BIGINT DEFAULT NULL,
  p_pedido_id BIGINT DEFAULT NULL,
  p_canal TEXT DEFAULT 'whatsapp_link',
  p_status TEXT DEFAULT 'link_aberto',
  p_provider_message_id TEXT DEFAULT NULL,
  p_erro TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_preview JSONB;
  v_com_id BIGINT;
  v_status_final TEXT;
  v_chave TEXT;
  v_destinatario TEXT;
  v_mensagem TEXT;
  v_enviado_em TIMESTAMPTZ := NULL;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Permissão negada. Apenas equipe autorizada pode registrar comunicações.');
  END IF;

  IF p_canal NOT IN ('whatsapp_link', 'evolution_api') THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_CHANNEL', 'error', 'Canal de comunicação inválido.');
  END IF;

  v_status_final := COALESCE(p_status, 'link_aberto');

  -- Regra estrita de auditoria: o canal whatsapp_link NUNCA pode ser gravado como "enviado" ou "entregue"
  IF p_canal = 'whatsapp_link' AND v_status_final IN ('enviado', 'entregue') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_STATUS_FOR_CHANNEL',
      'error', 'Abertura de link wa.me não comprova envio efetivo da mensagem. Para whatsapp_link, utilize status "link_aberto" ou "gerado".'
    );
  END IF;

  -- Obtém preview canônico gerado pelo servidor (nunca confia no cliente)
  v_preview := public.obter_preview_comunicacao(p_tipo, p_orcamento_id, p_pedido_id);
  IF (v_preview->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_preview;
  END IF;

  v_destinatario := v_preview->>'telefone';
  v_mensagem := v_preview->>'mensagem';
  v_chave := v_preview->>'chave_idempotencia';

  IF v_status_final IN ('enviado', 'entregue') THEN
    v_enviado_em := NOW();
  END IF;

  -- Inserção idempotente na tabela canônica
  INSERT INTO public.comunicacoes_cliente (
    orcamento_id,
    pedido_id,
    tipo,
    canal,
    destinatario,
    mensagem_snapshot,
    status,
    provider,
    provider_message_id,
    chave_idempotencia,
    erro,
    metadata,
    criado_por,
    created_at,
    enviado_em
  ) VALUES (
    p_orcamento_id,
    p_pedido_id,
    p_tipo,
    p_canal,
    v_destinatario,
    v_mensagem,
    v_status_final,
    CASE WHEN p_canal = 'evolution_api' THEN 'evolution_api' ELSE NULL END,
    p_provider_message_id,
    v_chave,
    p_erro,
    jsonb_build_object('preview_gerado_em', NOW()),
    auth.uid(),
    NOW(),
    v_enviado_em
  )
  ON CONFLICT (chave_idempotencia) DO UPDATE SET
    status = EXCLUDED.status,
    provider_message_id = COALESCE(EXCLUDED.provider_message_id, comunicacoes_cliente.provider_message_id),
    erro = COALESCE(EXCLUDED.erro, comunicacoes_cliente.erro),
    enviado_em = COALESCE(EXCLUDED.enviado_em, comunicacoes_cliente.enviado_em)
  RETURNING id INTO v_com_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_com_id,
    'tipo', p_tipo,
    'canal', p_canal,
    'status', v_status_final,
    'destinatario', v_destinatario,
    'chave_idempotencia', v_chave
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.registrar_comunicacao_cliente FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_comunicacao_cliente TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. APROVAÇÃO PÚBLICA VINCULADA À VERSÃO ESPERADA (QUOTE_VERSION_CHANGED)
-- --------------------------------------------------------------------------
-- Substituição consciente da assinatura anterior para evitar overloads ambíguas no PostgREST
DROP FUNCTION IF EXISTS public.aprovar_orcamento_publico(UUID);

CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(
  p_token UUID,
  p_versao_esperada INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_cfg public.configuracoes_operacao := public.obter_config_operacao();
  v_orc public.orcamentos;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'NOT_FOUND', 'error', 'Orçamento não encontrado.');
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
  IF p_versao_esperada IS NOT NULL AND v_orc.versao <> p_versao_esperada THEN
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

REVOKE ALL ON FUNCTION public.aprovar_orcamento_publico FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aprovar_orcamento_publico TO anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- 8. CONSULTA DE LEMBRETES PENDENTES: LISTAR_ORCAMENTOS_PARA_LEMBRETE()
-- --------------------------------------------------------------------------
-- Localiza orçamentos enviados que vencem nas próximas X horas e não receberam lembrete
CREATE OR REPLACE FUNCTION public.listar_orcamentos_para_lembrete(
  p_horas_antecedencia INT DEFAULT 24
)
RETURNS TABLE (
  orcamento_id BIGINT,
  numero TEXT,
  versao INT,
  cliente_nome TEXT,
  cliente_telefone TEXT,
  validade_ate TIMESTAMPTZ,
  horas_restantes NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id AS orcamento_id,
    o.numero,
    o.versao,
    o.cliente_nome,
    o.cliente_telefone,
    o.validade_ate,
    ROUND(EXTRACT(EPOCH FROM (o.validade_ate - NOW())) / 3600.0, 1) AS horas_restantes
  FROM public.orcamentos o
  WHERE o.status = 'enviado'
    AND o.validade_ate > NOW()
    AND o.validade_ate <= NOW() + make_interval(hours => p_horas_antecedencia)
    AND NOT EXISTS (
      SELECT 1 FROM public.comunicacoes_cliente cc
      WHERE cc.orcamento_id = o.id
        AND cc.tipo = 'ORCAMENTO_VENCENDO'
        AND cc.chave_idempotencia = 'orcamento:' || o.id || ':v' || o.versao || ':vencendo'
    )
  ORDER BY o.validade_ate ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_orcamentos_para_lembrete FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_orcamentos_para_lembrete TO authenticated, service_role;
