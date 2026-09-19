-- ==========================================================================
-- LUNOCA DOCERIA - MÓDULO DE GESTÃO DE ESTOQUE E CONTROLE FINANCEIRO
-- ==========================================================================

-- 1. Campos de Estoque na Tabela de Produtos
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_qtd INTEGER DEFAULT 10;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER DEFAULT 3;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS controlar_estoque BOOLEAN DEFAULT true;

-- Atualizar produtos existentes que estejam com estoque nulo
UPDATE public.produtos SET estoque_qtd = 10 WHERE estoque_qtd IS NULL;
UPDATE public.produtos SET estoque_minimo = 3 WHERE estoque_minimo IS NULL;
UPDATE public.produtos SET controlar_estoque = true WHERE controlar_estoque IS NULL;

-- 2. Tabela de Histórico de Movimentações de Estoque
CREATE TABLE IF NOT EXISTS public.estoque_movimentacoes (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE CASCADE,
  produto_nome TEXT NOT NULL,
  tipo TEXT CHECK (tipo IN ('entrada', 'saida', 'ajuste', 'venda')) NOT NULL,
  quantidade INTEGER NOT NULL,
  saldo_resultante INTEGER NOT NULL,
  motivo TEXT,
  pedido_id BIGINT REFERENCES public.pedidos(id) ON DELETE SET NULL,
  usuario_nome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS para Movimentações de Estoque
ALTER TABLE public.estoque_movimentacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins podem gerenciar movimentacoes de estoque" ON public.estoque_movimentacoes;
CREATE POLICY "Admins podem gerenciar movimentacoes de estoque" 
  ON public.estoque_movimentacoes 
  FOR ALL 
  USING (is_admin());

DROP POLICY IF EXISTS "Usuarios podem registrar saida por venda" ON public.estoque_movimentacoes;
CREATE POLICY "Usuarios podem registrar saida por venda" 
  ON public.estoque_movimentacoes 
  FOR INSERT 
  WITH CHECK (true);

-- 3. Tabela de Lançamentos do Controle Financeiro (Fluxo de Caixa)
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

-- RLS para Lançamentos Financeiros (Apenas admins têm acesso total)
ALTER TABLE public.financeiro_lancamentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins possuem acesso total ao controle financeiro" ON public.financeiro_lancamentos;
CREATE POLICY "Admins possuem acesso total ao controle financeiro" 
  ON public.financeiro_lancamentos 
  FOR ALL 
  USING (is_admin());

-- 4. Índices para Alta Performance
CREATE INDEX IF NOT EXISTS idx_produtos_estoque ON public.produtos(estoque_qtd);
CREATE INDEX IF NOT EXISTS idx_estoque_mov_prod ON public.estoque_movimentacoes(produto_id);
CREATE INDEX IF NOT EXISTS idx_estoque_mov_data ON public.estoque_movimentacoes(created_at);
CREATE INDEX IF NOT EXISTS idx_financeiro_data ON public.financeiro_lancamentos(data_lancamento);
CREATE INDEX IF NOT EXISTS idx_financeiro_tipo ON public.financeiro_lancamentos(tipo);
CREATE INDEX IF NOT EXISTS idx_financeiro_categoria ON public.financeiro_lancamentos(categoria);

-- 5. Função para dar Baixa Automática no Estoque após Confirmação de Venda
CREATE OR REPLACE FUNCTION public.baixar_estoque_item(
  p_produto_id BIGINT,
  p_quantidade INTEGER,
  p_pedido_id BIGINT,
  p_motivo TEXT
)
RETURNS JSON AS $$
DECLARE
  v_prod RECORD;
  v_novo_saldo INTEGER;
BEGIN
  SELECT id, nome, estoque_qtd, controlar_estoque 
  INTO v_prod 
  FROM public.produtos 
  WHERE id = p_produto_id 
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Produto não encontrado');
  END IF;

  IF v_prod.controlar_estoque = false THEN
    RETURN json_build_object('success', true, 'message', 'Produto sob encomenda (sem controle estrito)');
  END IF;

  v_novo_saldo := GREATEST(0, v_prod.estoque_qtd - p_quantidade);

  UPDATE public.produtos 
  SET estoque_qtd = v_novo_saldo, updated_at = NOW() 
  WHERE id = p_produto_id;

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
    p_quantidade,
    v_novo_saldo,
    COALESCE(p_motivo, 'Venda no Pedido #' || p_pedido_id),
    p_pedido_id,
    'Sistema Automático'
  );

  RETURN json_build_object(
    'success', true, 
    'produto_id', v_prod.id, 
    'novo_saldo', v_novo_saldo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
