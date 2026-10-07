-- ==========================================================================
-- LUNOCA DOCERIA - Script de Otimizações de Banco de Dados e Alta Performance
-- Execute este script no SQL Editor do Supabase (https://supabase.com)
-- ==========================================================================

-- 1. Coluna updated_at e Trigger Automático na Tabela de Pedidos
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.update_pedidos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_pedidos_updated_at ON public.pedidos;
CREATE TRIGGER tr_pedidos_updated_at
  BEFORE UPDATE ON public.pedidos
  FOR EACH ROW
  EXECUTE FUNCTION public.update_pedidos_updated_at();

-- 2. Coluna JSONB para Itens Estruturados (Mantém retrocompatibilidade)
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS itens_json JSONB;
CREATE INDEX IF NOT EXISTS idx_pedidos_itens_json ON public.pedidos USING gin(itens_json);

-- 3. Função Batch para Baixa Atômica de Estoque (Evita N+1 queries e condições de corrida)
CREATE OR REPLACE FUNCTION public.baixar_estoque_pedido_batch(
  p_pedido_id BIGINT,
  p_itens JSONB
)
RETURNS JSON AS $$
DECLARE
  v_item JSONB;
  v_prod_id BIGINT;
  v_qtd INTEGER;
  v_prod RECORD;
  v_novo_saldo INTEGER;
  v_processados INTEGER := 0;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RETURN json_build_object('success', true, 'message', 'Nenhum item para baixa');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    v_prod_id := (v_item->>'id')::BIGINT;
    v_qtd := COALESCE((v_item->>'quantidade')::INTEGER, 1);

    IF v_prod_id IS NOT NULL AND v_qtd > 0 THEN
      -- Bloqueia a linha do produto para update atômico
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
          'Venda no Pedido #' || p_pedido_id,
          p_pedido_id,
          'Sistema Automático'
        );

        v_processados := v_processados + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'pedido_id', p_pedido_id,
    'itens_processados', v_processados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RLS Reforçado para Histórico de Estoque (Apenas vendas automáticas ou admins)
DROP POLICY IF EXISTS "Usuarios podem registrar saida por venda" ON public.estoque_movimentacoes;
CREATE POLICY "Apenas registro de venda em pedido"
  ON public.estoque_movimentacoes
  FOR INSERT
  WITH CHECK (tipo = 'venda' OR is_admin());
