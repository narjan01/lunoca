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
