-- ==============================================================================
-- MIGRATION 028: ENGENHARIA DE CUSTOS, PRECIFICAÇÃO E MARGEM POR PRODUTO/PEDIDO
-- ==============================================================================
-- 1. ESTRUTURAS FABRIS: recursos_producao, produto_tempos_producao,
--    produto_custos_adicionais e politicas_precificacao.
-- 2. CUSTO REALIZADO DO PEDIDO: pedido_custos_realizados e pedido_custo_componentes
--    com trilha auditável append-only imutável, versionamento e decomposição analítica.
-- 3. SEGREGAÇÃO CONCEITUAL RÍGIDA:
--    custo_ingredientes_real != custo_embalagem != custo_mao_de_obra !=
--    custo_indireto_rateado != margem_contribuicao != lucro_liquido_contabil.
-- 4. TEMPORALIDADE HISTÓRICA: custo de insumos derivado estritamente dos lotes
--    consumidos (Frente L / pedido_consumos_lote); alteração futura de CMP ou custo-hora
--    NÃO reescreve pedidos históricos.
-- 5. RECEITA LÍQUIDA: margem calculada sobre a receita líquida comercial,
--    independente do meio de liquidação (PIX, cartão, crédito de cliente).
-- 6. DESACOPLAMENTO DE CATÁLOGO: simular_preco_produto_admin() NÃO altera preco de produtos.
-- 7. ZERO EFEITO FINANCEIRO: cálculos de custos e margens NÃO geram lançamentos em
--    financeiro_lancamentos ou pedido_pagamentos (zero efeito no caixa/DRE).
-- 8. RBAC FAIL-CLOSED: Acesso a custos, margens e markups estritamente restrito a Administradores.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. RECURSOS DE PRODUÇÃO (MÃO DE OBRA, EQUIPAMENTOS E PROCESSOS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recursos_producao (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('mao_de_obra', 'equipamento', 'processo')),
  custo_hora NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (custo_hora >= 0),
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recursos_producao_tipo ON public.recursos_producao(tipo);
CREATE INDEX IF NOT EXISTS idx_recursos_producao_ativo ON public.recursos_producao(ativo);

-- Seed padrão de recursos produtivos da confeitaria
INSERT INTO public.recursos_producao (nome, tipo, custo_hora, descricao, ativo)
VALUES
  ('Confeiteira Líder', 'mao_de_obra', 35.00, 'Montagem fina, decoração artística, bico e acabamento', true),
  ('Auxiliar de Confeitaria', 'mao_de_obra', 20.00, 'Preparo de massas, recheios básicos, pré-pesagem e apoio', true),
  ('Forno Turbo Convector', 'equipamento', 15.00, 'Consumo elétrico e depreciação técnica por hora de cocção', true),
  ('Batedeira Planetária / Refrigeração', 'processo', 8.00, 'Batimento, resfriamento em ultracongelador e descanso', true)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. TEMPOS PADRÃO DE PRODUÇÃO POR PRODUTO E ETAPA
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_tempos_producao (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  etapa TEXT NOT NULL CHECK (etapa IN ('preparo', 'forno', 'resfriamento', 'recheio', 'cobertura', 'decoracao', 'finalizacao', 'embalagem', 'outro')),
  minutos_padrao NUMERIC(8,2) NOT NULL CHECK (minutos_padrao > 0),
  recurso_id BIGINT NOT NULL REFERENCES public.recursos_producao(id) ON DELETE RESTRICT,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_produto_etapa_recurso UNIQUE (produto_id, etapa, recurso_id)
);

CREATE INDEX IF NOT EXISTS idx_produto_tempos_produto ON public.produto_tempos_producao(produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_tempos_recurso ON public.produto_tempos_producao(recurso_id);

-- ------------------------------------------------------------------------------
-- 3. CUSTOS ADICIONAIS POR PRODUTO / OPÇÃO (EMBALAGENS, FITAS, TOPPERS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_custos_adicionais (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT REFERENCES public.produtos(id) ON DELETE CASCADE,
  produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('embalagem', 'decoracao', 'acessorio', 'descartavel', 'outro')),
  tipo_aplicacao TEXT NOT NULL CHECK (tipo_aplicacao IN ('FIXO', 'POR_UNIDADE', 'POR_PEDIDO')),
  valor NUMERIC(10,2) NOT NULL CHECK (valor >= 0),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_produto_custos_adic_prod ON public.produto_custos_adicionais(produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_custos_adic_opcao ON public.produto_custos_adicionais(produto_opcao_id);

-- ------------------------------------------------------------------------------
-- 4. POLÍTICAS DE PRECIFICAÇÃO E DEDUÇÕES VARIÁVEIS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.politicas_precificacao (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT 'Padrão Confeitaria',
  margem_alvo_padrao_percentual NUMERIC(5,2) NOT NULL DEFAULT 40.00 CHECK (margem_alvo_padrao_percentual >= 0 AND margem_alvo_padrao_percentual < 100),
  taxa_cartao_padrao_percentual NUMERIC(5,2) NOT NULL DEFAULT 3.99 CHECK (taxa_cartao_padrao_percentual >= 0 AND taxa_cartao_padrao_percentual < 100),
  impostos_padrao_percentual NUMERIC(5,2) NOT NULL DEFAULT 6.00 CHECK (impostos_padrao_percentual >= 0 AND impostos_padrao_percentual < 100),
  comissao_padrao_percentual NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (comissao_padrao_percentual >= 0 AND comissao_padrao_percentual < 100),
  custo_indireto_padrao_percentual NUMERIC(5,2) NOT NULL DEFAULT 5.00 CHECK (custo_indireto_padrao_percentual >= 0 AND custo_indireto_padrao_percentual < 100),
  padrao BOOLEAN NOT NULL DEFAULT true,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.politicas_precificacao (
  nome, margem_alvo_padrao_percentual, taxa_cartao_padrao_percentual,
  impostos_padrao_percentual, comissao_padrao_percentual, custo_indireto_padrao_percentual,
  padrao, ativo
)
VALUES ('Padrão Confeitaria Lunoca', 40.00, 3.99, 6.00, 0.00, 5.00, true, true)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------------------
-- 5. CUSTOS REALIZADOS DO PEDIDO (CABEÇALHO E CONTROLE DE VERSÃO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_custos_realizados (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  versao INT NOT NULL DEFAULT 1,
  receita_liquida_snapshot NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  custo_ingredientes_real NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_ingredientes_real >= 0),
  custo_embalagem NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_embalagem >= 0),
  custo_mao_de_obra NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_mao_de_obra >= 0),
  custo_adicionais NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_adicionais >= 0),
  custo_indireto_rateado NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_indireto_rateado >= 0),
  taxas_variaveis_atribuiveis NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (taxas_variaveis_atribuiveis >= 0),
  frete_subsidiado NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (frete_subsidiado >= 0),
  custo_atribuivel_total NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (custo_atribuivel_total >= 0),
  margem_contribuicao_valor NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  margem_contribuicao_percentual NUMERIC(6,2) NOT NULL DEFAULT 0.00,
  politica_id BIGINT REFERENCES public.politicas_precificacao(id) ON DELETE SET NULL,
  politica_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'finalizado' CHECK (status IN ('finalizado', 'substituido')),
  substitui_versao INT,
  motivo_retificacao TEXT,
  calculado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calculado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_pedido_custos_realizados_versao UNIQUE (pedido_id, versao)
);

CREATE INDEX IF NOT EXISTS idx_pedido_custos_realizados_ped ON public.pedido_custos_realizados(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_custos_realizados_status ON public.pedido_custos_realizados(status);

-- ------------------------------------------------------------------------------
-- 6. COMPONENTES ANALÍTICOS DO CUSTO REALIZADO (DECOMPOSIÇÃO DETALHADA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_custo_componentes (
  id BIGSERIAL PRIMARY KEY,
  custo_realizado_id BIGINT NOT NULL REFERENCES public.pedido_custos_realizados(id) ON DELETE CASCADE,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE RESTRICT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingrediente', 'embalagem', 'mao_de_obra', 'adicional', 'taxa', 'indireto', 'frete_subsidiado')),
  referencia_tipo TEXT,
  referencia_id BIGINT,
  descricao TEXT NOT NULL,
  quantidade NUMERIC(12,3) NOT NULL DEFAULT 1.000,
  unidade VARCHAR(10) NOT NULL DEFAULT 'un',
  custo_unitario_snapshot NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  valor_total NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ped_custo_comp_realizado ON public.pedido_custo_componentes(custo_realizado_id);
CREATE INDEX IF NOT EXISTS idx_ped_custo_comp_pedido ON public.pedido_custo_componentes(pedido_id);
CREATE INDEX IF NOT EXISTS idx_ped_custo_comp_tipo ON public.pedido_custo_componentes(tipo);

-- ------------------------------------------------------------------------------
-- 7. TRIGGERS DE IMUTABILIDADE APPEND-ONLY
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_pedido_custos_realizados()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: Registros de pedido_custos_realizados são imutáveis e não podem ser excluídos.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Permite única e exclusivamente transicionar status de 'finalizado' para 'substituido' ao gerar nova versão
    IF OLD.status = 'finalizado' AND NEW.status = 'substituido' AND
       NEW.id = OLD.id AND NEW.pedido_id = OLD.pedido_id AND NEW.versao = OLD.versao AND
       NEW.custo_atribuivel_total = OLD.custo_atribuivel_total AND
       NEW.margem_contribuicao_valor = OLD.margem_contribuicao_valor THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'PERMISSION_DENIED: Modificação de pedido_custos_realizados não permitida. Para retificações, registre uma nova versão.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_pedido_custos_realizados ON public.pedido_custos_realizados;
CREATE TRIGGER trg_imutabilidade_pedido_custos_realizados
  BEFORE UPDATE OR DELETE ON public.pedido_custos_realizados
  FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_pedido_custos_realizados();

CREATE OR REPLACE FUNCTION public._bloquear_mutacao_pedido_custo_componentes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PERMISSION_DENIED: Componentes analíticos de pedido_custo_componentes são estritamente imutáveis.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imutabilidade_pedido_custo_componentes ON public.pedido_custo_componentes;
CREATE TRIGGER trg_imutabilidade_pedido_custo_componentes
  BEFORE UPDATE OR DELETE ON public.pedido_custo_componentes
  FOR EACH ROW EXECUTE FUNCTION public._bloquear_mutacao_pedido_custo_componentes();

-- ------------------------------------------------------------------------------
-- 8. RLS E SEGURANÇA FAIL-CLOSED
-- ------------------------------------------------------------------------------
ALTER TABLE public.recursos_producao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_tempos_producao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_custos_adicionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.politicas_precificacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_custos_realizados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_custo_componentes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.recursos_producao FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produto_tempos_producao FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produto_custos_adicionais FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.politicas_precificacao FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_custos_realizados FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pedido_custo_componentes FROM PUBLIC, anon, authenticated;

-- Políticas de Recursos de Produção: leitura para equipe, escrita apenas admin
DROP POLICY IF EXISTS "Equipe visualiza recursos de producao" ON public.recursos_producao;
CREATE POLICY "Equipe visualiza recursos de producao"
  ON public.recursos_producao FOR SELECT
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam recursos de producao" ON public.recursos_producao;
CREATE POLICY "Admins gerenciam recursos de producao"
  ON public.recursos_producao FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Políticas de Tempos de Produção: leitura para equipe, escrita apenas admin
DROP POLICY IF EXISTS "Equipe visualiza tempos de producao" ON public.produto_tempos_producao;
CREATE POLICY "Equipe visualiza tempos de producao"
  ON public.produto_tempos_producao FOR SELECT
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam tempos de producao" ON public.produto_tempos_producao;
CREATE POLICY "Admins gerenciam tempos de producao"
  ON public.produto_tempos_producao FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Políticas de Custos Adicionais: leitura para equipe, escrita apenas admin
DROP POLICY IF EXISTS "Equipe visualiza custos adicionais" ON public.produto_custos_adicionais;
CREATE POLICY "Equipe visualiza custos adicionais"
  ON public.produto_custos_adicionais FOR SELECT
  USING (public.is_admin_or_operator());

DROP POLICY IF EXISTS "Admins gerenciam custos adicionais" ON public.produto_custos_adicionais;
CREATE POLICY "Admins gerenciam custos adicionais"
  ON public.produto_custos_adicionais FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Políticas de Políticas de Precificação: exclusivo admin
DROP POLICY IF EXISTS "Admins gerenciam politicas de precificacao" ON public.politicas_precificacao;
CREATE POLICY "Admins gerenciam politicas de precificacao"
  ON public.politicas_precificacao FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Políticas de Custo Realizado e Componentes: exclusivo admin
DROP POLICY IF EXISTS "Admins visualizam custos realizados" ON public.pedido_custos_realizados;
CREATE POLICY "Admins visualizam custos realizados"
  ON public.pedido_custos_realizados FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins visualizam componentes de custo" ON public.pedido_custo_componentes;
CREATE POLICY "Admins visualizam componentes de custo"
  ON public.pedido_custo_componentes FOR SELECT
  USING (public.is_admin());

GRANT SELECT ON public.recursos_producao TO authenticated, service_role;
GRANT SELECT ON public.produto_tempos_producao TO authenticated, service_role;
GRANT SELECT ON public.produto_custos_adicionais TO authenticated, service_role;
GRANT ALL ON public.recursos_producao TO service_role;
GRANT ALL ON public.produto_tempos_producao TO service_role;
GRANT ALL ON public.produto_custos_adicionais TO service_role;
GRANT ALL ON public.politicas_precificacao TO service_role;
GRANT ALL ON public.pedido_custos_realizados TO service_role;
GRANT ALL ON public.pedido_custo_componentes TO service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC SIMULAR_PRECO_PRODUTO_ADMIN
-- ------------------------------------------------------------------------------
-- Calcula a estrutura estimada de custos do produto e projeta preços de venda.
-- NÃO altera catálogo (produtos.preco permanece intocado).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.simular_preco_produto_admin(
  p_produto_id BIGINT,
  p_margem_alvo NUMERIC DEFAULT NULL,
  p_politica_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
  v_pol RECORD;
  v_custo_insumos NUMERIC(10,2) := 0.00;
  v_custo_mao_obra NUMERIC(10,2) := 0.00;
  v_custo_embalagem NUMERIC(10,2) := 0.00;
  v_custo_adicionais NUMERIC(10,2) := 0.00;
  v_custo_direto_total NUMERIC(10,2) := 0.00;
  v_margem_alvo NUMERIC(5,2);
  v_taxa_cartao NUMERIC(5,2);
  v_impostos NUMERIC(5,2);
  v_comissao NUMERIC(5,2);
  v_custo_indireto_pct NUMERIC(5,2);
  v_deducoes_break_even NUMERIC(5,2);
  v_deducoes_alvo NUMERIC(5,2);
  v_preco_atual NUMERIC(10,2);
  v_preco_equilibrio NUMERIC(10,2);
  v_preco_margem_alvo NUMERIC(10,2);
  v_margem_atual_valor NUMERIC(10,2);
  v_margem_atual_pct NUMERIC(6,2);
  v_insumos_detalhes JSONB := '[]'::jsonb;
  v_tempos_detalhes JSONB := '[]'::jsonb;
  v_adicionais_detalhes JSONB := '[]'::jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem simular preços e custos de produtos.'
    );
  END IF;

  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_NOT_FOUND', 'error', 'Produto não encontrado.');
  END IF;
  v_preco_atual := COALESCE(v_prod.preco, 0.00);

  -- Carregar política de precificação ativa
  IF p_politica_id IS NOT NULL THEN
    SELECT * INTO v_pol FROM public.politicas_precificacao WHERE id = p_politica_id;
  ELSE
    SELECT * INTO v_pol FROM public.politicas_precificacao WHERE padrao = true AND ativo = true LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    SELECT * INTO v_pol FROM public.politicas_precificacao WHERE ativo = true ORDER BY id ASC LIMIT 1;
  END IF;

  v_margem_alvo := COALESCE(p_margem_alvo, v_pol.margem_alvo_padrao_percentual, 40.00);
  v_taxa_cartao := COALESCE(v_pol.taxa_cartao_padrao_percentual, 3.99);
  v_impostos := COALESCE(v_pol.impostos_padrao_percentual, 6.00);
  v_comissao := COALESCE(v_pol.comissao_padrao_percentual, 0.00);
  v_custo_indireto_pct := COALESCE(v_pol.custo_indireto_padrao_percentual, 5.00);

  -- 1. Custo de insumos pelo CMP atual (ou custo_unitario se CMP zerado)
  SELECT
    COALESCE(ROUND(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 2), 0.00),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ingrediente_id', i.id,
      'nome', i.nome,
      'quantidade', pi.quantidade,
      'unidade', i.unidade,
      'custo_unitario_cmp', COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0),
      'custo_total', ROUND(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0), 2)
    )), '[]'::jsonb)
  INTO v_custo_insumos, v_insumos_detalhes
  FROM public.produto_ingredientes pi
  JOIN public.ingredientes i ON i.id = pi.ingrediente_id
  LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
  WHERE pi.produto_id = p_produto_id;

  -- 2. Custo de mão de obra e processos pelos tempos padrão
  SELECT
    COALESCE(ROUND(SUM((pt.minutos_padrao / 60.0) * r.custo_hora), 2), 0.00),
    COALESCE(jsonb_agg(jsonb_build_object(
      'etapa', pt.etapa,
      'minutos', pt.minutos_padrao,
      'recurso_id', r.id,
      'recurso_nome', r.nome,
      'recurso_tipo', r.tipo,
      'custo_hora', r.custo_hora,
      'custo_etapa', ROUND((pt.minutos_padrao / 60.0) * r.custo_hora, 2)
    )), '[]'::jsonb)
  INTO v_custo_mao_obra, v_tempos_detalhes
  FROM public.produto_tempos_producao pt
  JOIN public.recursos_producao r ON r.id = pt.recurso_id
  WHERE pt.produto_id = p_produto_id AND r.ativo = true;

  -- 3. Embalagens e adicionais configurados para o produto
  SELECT
    COALESCE(ROUND(SUM(CASE WHEN categoria = 'embalagem' THEN valor ELSE 0.00 END), 2), 0.00),
    COALESCE(ROUND(SUM(CASE WHEN categoria <> 'embalagem' THEN valor ELSE 0.00 END), 2), 0.00),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', ca.id,
      'nome', ca.nome,
      'categoria', ca.categoria,
      'tipo_aplicacao', ca.tipo_aplicacao,
      'valor', ca.valor
    )), '[]'::jsonb)
  INTO v_custo_embalagem, v_custo_adicionais, v_adicionais_detalhes
  FROM public.produto_custos_adicionais ca
  WHERE ca.produto_id = p_produto_id AND ca.ativo = true;

  v_custo_direto_total := v_custo_insumos + v_custo_mao_obra + v_custo_embalagem + v_custo_adicionais;

  -- 4. Cálculo de Preço de Equilíbrio (Break-even: margem 0)
  v_deducoes_break_even := (v_taxa_cartao + v_impostos + v_comissao + v_custo_indireto_pct);
  IF v_deducoes_break_even >= 100.00 THEN
    v_preco_equilibrio := 0.00;
  ELSE
    v_preco_equilibrio := ROUND(v_custo_direto_total / (1.00 - (v_deducoes_break_even / 100.00)), 2);
  END IF;

  -- 5. Cálculo de Preço para Margem Alvo
  v_deducoes_alvo := (v_deducoes_break_even + v_margem_alvo);
  IF v_deducoes_alvo >= 100.00 THEN
    v_preco_margem_alvo := 0.00;
  ELSE
    v_preco_margem_alvo := ROUND(v_custo_direto_total / (1.00 - (v_deducoes_alvo / 100.00)), 2);
  END IF;

  -- 6. Margem Atual no Preço de Catálogo
  IF v_preco_atual > 0 THEN
    v_margem_atual_valor := ROUND(v_preco_atual - v_custo_direto_total - (v_preco_atual * (v_deducoes_break_even / 100.00)), 2);
    v_margem_atual_pct := ROUND((v_margem_atual_valor / v_preco_atual) * 100.0, 2);
  ELSE
    v_margem_atual_valor := 0.00;
    v_margem_atual_pct := 0.00;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'produto_nome', v_prod.nome,
    'preco_atual_catalogo', v_preco_atual,
    'custo_insumos_cmp', v_custo_insumos,
    'custo_mao_de_obra', v_custo_mao_obra,
    'custo_embalagem', v_custo_embalagem,
    'custo_adicionais', v_custo_adicionais,
    'custo_direto_total', v_custo_direto_total,
    'parametros_politica', jsonb_build_object(
      'politica_id', v_pol.id,
      'politica_nome', v_pol.nome,
      'margem_alvo_pct', v_margem_alvo,
      'taxa_cartao_pct', v_taxa_cartao,
      'impostos_pct', v_impostos,
      'comissao_pct', v_comissao,
      'custo_indireto_pct', v_custo_indireto_pct
    ),
    'preco_equilibrio_breakeven', v_preco_equilibrio,
    'preco_sugerido_margem_alvo', v_preco_margem_alvo,
    'margem_atual_no_preco', jsonb_build_object(
      'margem_valor', v_margem_atual_valor,
      'margem_percentual', v_margem_atual_pct,
      'abaixo_do_alvo', (v_margem_atual_pct < v_margem_alvo),
      'margem_negativa', (v_margem_atual_valor < 0)
    ),
    'detalhamento', jsonb_build_object(
      'insumos', v_insumos_detalhes,
      'tempos_producao', v_tempos_detalhes,
      'adicionais', v_adicionais_detalhes
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.simular_preco_produto_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.simular_preco_produto_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. RPC CALCULAR_CUSTO_REAL_PEDIDO_ADMIN
-- ------------------------------------------------------------------------------
-- Consolida o custo realizado e a margem de contribuição efetiva do pedido.
-- Salva snapshot imutável em pedido_custos_realizados e linhas em pedido_custo_componentes.
-- Idempotente caso já calculado e sem motivo de retificação.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calcular_custo_real_pedido_admin(
  p_pedido_id BIGINT,
  p_motivo_retificacao TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ped RECORD;
  v_pol RECORD;
  v_existente RECORD;
  v_nova_versao INT := 1;
  v_rec RECORD;
  v_custo_realizado_id BIGINT;

  v_receita_liquida NUMERIC(12,2) := 0.00;
  v_desconto_comercial NUMERIC(12,2) := 0.00;
  v_frete_base NUMERIC(12,2) := 0.00;
  v_frete_cobrado NUMERIC(12,2) := 0.00;
  v_frete_subsidiado NUMERIC(12,2) := 0.00;

  v_custo_insumos NUMERIC(12,2) := 0.00;
  v_custo_embalagem NUMERIC(12,2) := 0.00;
  v_custo_mao_obra NUMERIC(12,2) := 0.00;
  v_custo_adicionais NUMERIC(12,2) := 0.00;
  v_taxas_variaveis NUMERIC(12,2) := 0.00;
  v_custo_indireto NUMERIC(12,2) := 0.00;
  v_custo_atribuivel_total NUMERIC(12,2) := 0.00;

  v_margem_valor NUMERIC(12,2) := 0.00;
  v_margem_pct NUMERIC(6,2) := 0.00;

  v_motivo TEXT := NULLIF(TRIM(COALESCE(p_motivo_retificacao, '')), '');
  v_user_id UUID := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem calcular ou auditar custos e margens de pedidos.'
    );
  END IF;

  SELECT * INTO v_ped FROM public.pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_NOT_FOUND', 'error', 'Pedido não encontrado.');
  END IF;

  -- Pedido cancelado antes de produzir não gera custo realizado
  IF v_ped.status_comercial = 'cancelado' AND v_ped.status_operacional IN ('aguardando_producao', 'cancelado') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_CANCELLED_BEFORE_PRODUCTION',
      'error', 'Pedidos cancelados antes do início da produção não possuem custo realizado atribuível.'
    );
  END IF;

  -- Verificar cálculo existente finalizado (idempotência)
  SELECT * INTO v_existente
  FROM public.pedido_custos_realizados
  WHERE pedido_id = p_pedido_id AND status = 'finalizado'
  ORDER BY versao DESC LIMIT 1;

  IF FOUND AND v_motivo IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'custo_realizado_id', v_existente.id,
      'pedido_id', p_pedido_id,
      'versao', v_existente.versao,
      'status', v_existente.status,
      'receita_liquida', v_existente.receita_liquida_snapshot,
      'custo_ingredientes_real', v_existente.custo_ingredientes_real,
      'custo_embalagem', v_existente.custo_embalagem,
      'custo_mao_de_obra', v_existente.custo_mao_de_obra,
      'custo_adicionais', v_existente.custo_adicionais,
      'frete_subsidiado', v_existente.frete_subsidiado,
      'custo_indireto_rateado', v_existente.custo_indireto_rateado,
      'taxas_variaveis_atribuiveis', v_existente.taxas_variaveis_atribuiveis,
      'custo_atribuivel_total', v_existente.custo_atribuivel_total,
      'margem_contribuicao_valor', v_existente.margem_contribuicao_valor,
      'margem_contribuicao_percentual', v_existente.margem_contribuicao_percentual,
      'calculado_em', v_existente.calculado_em
    );
  END IF;

  IF FOUND AND v_motivo IS NOT NULL THEN
    IF length(v_motivo) < 5 THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'RETIFICATION_REASON_REQUIRED',
        'error', 'Para gerar uma nova versão retificada de custos, informe a justificativa (mínimo 5 caracteres).'
      );
    END IF;
    v_nova_versao := v_existente.versao + 1;
  END IF;

  -- 1. Obter Política de Precificação vigente para o cálculo
  SELECT * INTO v_pol FROM public.politicas_precificacao WHERE padrao = true AND ativo = true LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO v_pol FROM public.politicas_precificacao WHERE ativo = true ORDER BY id ASC LIMIT 1;
  END IF;

  -- 2. Determinar Receita Líquida Comercial
  -- receita_liquida = subtotal - desconto
  v_desconto_comercial := GREATEST(0.00, COALESCE(v_ped.desconto, 0.00));
  v_receita_liquida := GREATEST(0.00, COALESCE(v_ped.subtotal, 0.00) - v_desconto_comercial);

  -- Frete Subsidiado
  v_frete_base := COALESCE(v_ped.taxa_entrega_base, v_ped.taxa_entrega, 0.00);
  v_frete_cobrado := COALESCE(v_ped.taxa_entrega_cobrada, v_ped.taxa_entrega, 0.00);
  IF v_frete_base > v_frete_cobrado THEN
    v_frete_subsidiado := ROUND(v_frete_base - v_frete_cobrado, 2);
  ELSE
    v_frete_subsidiado := 0.00;
  END IF;

  -- Se existia versão anterior e estamos retificando, marcar como substituído
  IF v_existente.id IS NOT NULL THEN
    UPDATE public.pedido_custos_realizados
    SET status = 'substituido'
    WHERE id = v_existente.id;
  END IF;

  -- Inserir cabeçalho em pedido_custos_realizados (temporário com valores zerados para obter ID)
  INSERT INTO public.pedido_custos_realizados (
    pedido_id, versao, receita_liquida_snapshot, politica_id,
    politica_snapshot, status, substitui_versao, motivo_retificacao,
    calculado_por
  ) VALUES (
    p_pedido_id, v_nova_versao, v_receita_liquida, v_pol.id,
    to_jsonb(v_pol), 'finalizado',
    CASE WHEN v_existente.id IS NOT NULL THEN v_existente.versao ELSE NULL END,
    v_motivo, v_user_id
  ) RETURNING id INTO v_custo_realizado_id;

  -- 3. Insumos Efetivamente Consumidos (Frente L - pedido_consumos_lote)
  -- Se houver lotes consumidos registrados, usamos os lotes!
  IF EXISTS (SELECT 1 FROM public.pedido_consumos_lote WHERE pedido_id = p_pedido_id) THEN
    FOR v_rec IN
      SELECT
        pcl.id AS lote_consumo_id,
        pcl.ingrediente_id,
        i.nome AS ingrediente_nome,
        pcl.codigo_lote_snapshot,
        pcl.quantidade_consumida,
        pcl.unidade,
        pcl.custo_unitario_lote_snapshot,
        ROUND(pcl.quantidade_consumida * pcl.custo_unitario_lote_snapshot, 2) AS valor_insumo
      FROM public.pedido_consumos_lote pcl
      JOIN public.ingredientes i ON i.id = pcl.ingrediente_id
      WHERE pcl.pedido_id = p_pedido_id
    LOOP
      v_custo_insumos := v_custo_insumos + v_rec.valor_insumo;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'ingrediente', 'lote_consumo', v_rec.lote_consumo_id,
        'Insumo: ' || v_rec.ingrediente_nome || ' (Lote: ' || v_rec.codigo_lote_snapshot || ')',
        v_rec.quantidade_consumida, v_rec.unidade, v_rec.custo_unitario_lote_snapshot, v_rec.valor_insumo,
        jsonb_build_object('ingrediente_id', v_rec.ingrediente_id, 'codigo_lote', v_rec.codigo_lote_snapshot)
      );
    END LOOP;
  ELSE
    -- Fallback para itens com cmv_total_snapshot se não houve registro em lotes
    FOR v_rec IN
      SELECT
        pi.id AS item_id,
        pi.produto_id,
        pi.produto_nome_snapshot,
        pi.quantidade,
        COALESCE(pi.cmv_unitario_snapshot, 0.00) AS cmv_unitario,
        COALESCE(pi.cmv_total_snapshot, 0.00) AS cmv_total
      FROM public.pedido_itens pi
      WHERE pi.pedido_id = p_pedido_id
    LOOP
      v_custo_insumos := v_custo_insumos + v_rec.cmv_total;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'ingrediente', 'item_snapshot', v_rec.item_id,
        'Insumo estimado (Snapshot item): ' || v_rec.produto_nome_snapshot,
        v_rec.quantidade, 'un', v_rec.cmv_unitario, v_rec.cmv_total,
        jsonb_build_object('produto_id', v_rec.produto_id)
      );
    END LOOP;
  END IF;

  -- 4. Mão de Obra e Processos Atribuíveis por Item Produzido
  FOR v_rec IN
    SELECT
      pi.id AS item_id,
      pi.produto_nome_snapshot,
      pi.quantidade AS item_qtd,
      pt.etapa,
      pt.minutos_padrao,
      r.id AS recurso_id,
      r.nome AS recurso_nome,
      r.tipo AS recurso_tipo,
      r.custo_hora,
      ROUND(( (pt.minutos_padrao * pi.quantidade) / 60.0 ) * r.custo_hora, 2) AS valor_etapa
    FROM public.pedido_itens pi
    JOIN public.produto_tempos_producao pt ON pt.produto_id = pi.produto_id
    JOIN public.recursos_producao r ON r.id = pt.recurso_id
    WHERE pi.pedido_id = p_pedido_id AND r.ativo = true
  LOOP
    v_custo_mao_obra := v_custo_mao_obra + v_rec.valor_etapa;
    INSERT INTO public.pedido_custo_componentes (
      custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
      descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
    ) VALUES (
      v_custo_realizado_id, p_pedido_id, 'mao_de_obra', 'recurso_producao', v_rec.recurso_id,
      'Mão de obra / Processo: ' || v_rec.etapa || ' (' || v_rec.recurso_nome || ') para ' || v_rec.produto_nome_snapshot,
      ROUND((v_rec.minutos_padrao * v_rec.item_qtd) / 60.0, 3), 'h', v_rec.custo_hora, v_rec.valor_etapa,
      jsonb_build_object('item_id', v_rec.item_id, 'minutos_total', v_rec.minutos_padrao * v_rec.item_qtd, 'custo_hora', v_rec.custo_hora)
    );
  END LOOP;

  -- 5. Embalagens e Custos Adicionais dos Itens e Opções
  -- A: Adicionais por item (POR_UNIDADE ou FIXO)
  FOR v_rec IN
    SELECT
      pi.id AS item_id,
      pi.produto_nome_snapshot,
      pi.quantidade AS item_qtd,
      ca.id AS adicional_id,
      ca.nome AS adicional_nome,
      ca.categoria,
      ca.tipo_aplicacao,
      ca.valor AS valor_unitario,
      CASE
        WHEN ca.tipo_aplicacao = 'POR_UNIDADE' THEN ROUND(ca.valor * pi.quantidade, 2)
        ELSE ROUND(ca.valor, 2)
      END AS valor_total_adic
    FROM public.pedido_itens pi
    JOIN public.produto_custos_adicionais ca ON ca.produto_id = pi.produto_id AND ca.ativo = true
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    IF v_rec.categoria = 'embalagem' THEN
      v_custo_embalagem := v_custo_embalagem + v_rec.valor_total_adic;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'embalagem', 'produto_custos_adicionais', v_rec.adicional_id,
        'Embalagem: ' || v_rec.adicional_nome || ' (' || v_rec.produto_nome_snapshot || ')',
        CASE WHEN v_rec.tipo_aplicacao = 'POR_UNIDADE' THEN v_rec.item_qtd ELSE 1.000 END, 'un',
        v_rec.valor_unitario, v_rec.valor_total_adic,
        jsonb_build_object('item_id', v_rec.item_id, 'tipo_aplicacao', v_rec.tipo_aplicacao)
      );
    ELSE
      v_custo_adicionais := v_custo_adicionais + v_rec.valor_total_adic;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'adicional', 'produto_custos_adicionais', v_rec.adicional_id,
        'Adicional: ' || v_rec.adicional_nome || ' (' || v_rec.produto_nome_snapshot || ')',
        CASE WHEN v_rec.tipo_aplicacao = 'POR_UNIDADE' THEN v_rec.item_qtd ELSE 1.000 END, 'un',
        v_rec.valor_unitario, v_rec.valor_total_adic,
        jsonb_build_object('item_id', v_rec.item_id, 'tipo_aplicacao', v_rec.tipo_aplicacao)
      );
    END IF;
  END LOOP;

  -- B: Adicionais por Pedido Geral (produto_id IS NULL)
  FOR v_rec IN
    SELECT
      ca.id AS adicional_id,
      ca.nome AS adicional_nome,
      ca.categoria,
      ca.valor AS valor_unitario
    FROM public.produto_custos_adicionais ca
    WHERE ca.produto_id IS NULL AND ca.tipo_aplicacao = 'POR_PEDIDO' AND ca.ativo = true
  LOOP
    IF v_rec.categoria = 'embalagem' THEN
      v_custo_embalagem := v_custo_embalagem + v_rec.valor_unitario;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'embalagem', 'produto_custos_adicionais', v_rec.adicional_id,
        'Embalagem Pedido Geral: ' || v_rec.adicional_nome,
        1.000, 'un', v_rec.valor_unitario, v_rec.valor_unitario,
        jsonb_build_object('tipo_aplicacao', 'POR_PEDIDO')
      );
    ELSE
      v_custo_adicionais := v_custo_adicionais + v_rec.valor_unitario;
      INSERT INTO public.pedido_custo_componentes (
        custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
        descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
      ) VALUES (
        v_custo_realizado_id, p_pedido_id, 'adicional', 'produto_custos_adicionais', v_rec.adicional_id,
        'Adicional Pedido Geral: ' || v_rec.adicional_nome,
        1.000, 'un', v_rec.valor_unitario, v_rec.valor_unitario,
        jsonb_build_object('tipo_aplicacao', 'POR_PEDIDO')
      );
    END IF;
  END LOOP;

  -- 6. Frete Subsidiado (se houver subsídio bancado pela confeitaria)
  IF v_frete_subsidiado > 0 THEN
    INSERT INTO public.pedido_custo_componentes (
      custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
      descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
    ) VALUES (
      v_custo_realizado_id, p_pedido_id, 'frete_subsidiado', 'pedidos', p_pedido_id,
      'Frete Subsidiado pela Loja (Taxa Base R$ ' || v_frete_base || ' - Cobrada R$ ' || v_frete_cobrado || ')',
      1.000, 'un', v_frete_subsidiado, v_frete_subsidiado,
      jsonb_build_object('frete_base', v_frete_base, 'frete_cobrado', v_frete_cobrado)
    );
  END IF;

  -- 7. Taxas Variáveis Atribuíveis (Taxa de adquirência/cartão estimada sobre receita líquida)
  IF COALESCE(v_pol.taxa_cartao_padrao_percentual, 0.00) > 0 AND v_receita_liquida > 0 THEN
    v_taxas_variaveis := ROUND(v_receita_liquida * (v_pol.taxa_cartao_padrao_percentual / 100.0), 2);
    INSERT INTO public.pedido_custo_componentes (
      custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
      descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
    ) VALUES (
      v_custo_realizado_id, p_pedido_id, 'taxa', 'politicas_precificacao', v_pol.id,
      'Taxa variável estimada de transação (' || v_pol.taxa_cartao_padrao_percentual || '%)',
      1.000, 'un', v_taxas_variaveis, v_taxas_variaveis,
      jsonb_build_object('taxa_cartao_pct', v_pol.taxa_cartao_padrao_percentual)
    );
  END IF;

  -- 8. Custo Indireto Rateado (energia, depreciação geral rateada sobre o subtotal)
  IF COALESCE(v_pol.custo_indireto_padrao_percentual, 0.00) > 0 AND v_receita_liquida > 0 THEN
    v_custo_indireto := ROUND(v_receita_liquida * (v_pol.custo_indireto_padrao_percentual / 100.0), 2);
    INSERT INTO public.pedido_custo_componentes (
      custo_realizado_id, pedido_id, tipo, referencia_tipo, referencia_id,
      descricao, quantidade, unidade, custo_unitario_snapshot, valor_total, detalhes
    ) VALUES (
      v_custo_realizado_id, p_pedido_id, 'indireto', 'politicas_precificacao', v_pol.id,
      'Custo indireto rateado fabril (' || v_pol.custo_indireto_padrao_percentual || '%)',
      1.000, 'un', v_custo_indireto, v_custo_indireto,
      jsonb_build_object('custo_indireto_pct', v_pol.custo_indireto_padrao_percentual)
    );
  END IF;

  -- 9. Fechamento Matemático dos Totais
  v_custo_atribuivel_total := v_custo_insumos + v_custo_embalagem + v_custo_mao_obra +
                              v_custo_adicionais + v_frete_subsidiado + v_taxas_variaveis + v_custo_indireto;

  v_margem_valor := ROUND(v_receita_liquida - v_custo_atribuivel_total, 2);
  IF v_receita_liquida > 0 THEN
    v_margem_pct := ROUND((v_margem_valor / v_receita_liquida) * 100.0, 2);
  ELSE
    v_margem_pct := 0.00;
  END IF;

  -- Atualizar registro do cabeçalho com os valores consolidados exatos
  UPDATE public.pedido_custos_realizados
  SET
    custo_ingredientes_real = v_custo_insumos,
    custo_embalagem = v_custo_embalagem,
    custo_mao_de_obra = v_custo_mao_obra,
    custo_adicionais = v_custo_adicionais,
    custo_indireto_rateado = v_custo_indireto,
    taxas_variaveis_atribuiveis = v_taxas_variaveis,
    frete_subsidiado = v_frete_subsidiado,
    custo_atribuivel_total = v_custo_atribuivel_total,
    margem_contribuicao_valor = v_margem_valor,
    margem_contribuicao_percentual = v_margem_pct,
    calculado_em = NOW()
  WHERE id = v_custo_realizado_id;

  RETURN jsonb_build_object(
    'success', true,
    'custo_realizado_id', v_custo_realizado_id,
    'pedido_id', p_pedido_id,
    'versao', v_nova_versao,
    'status', 'finalizado',
    'receita_liquida', v_receita_liquida,
    'custo_ingredientes_real', v_custo_insumos,
    'custo_embalagem', v_custo_embalagem,
    'custo_mao_de_obra', v_custo_mao_obra,
    'custo_adicionais', v_custo_adicionais,
    'frete_subsidiado', v_frete_subsidiado,
    'custo_indireto_rateado', v_custo_indireto,
    'taxas_variaveis_atribuiveis', v_taxas_variaveis,
    'custo_atribuivel_total', v_custo_atribuivel_total,
    'margem_contribuicao_valor', v_margem_valor,
    'margem_contribuicao_percentual', v_margem_pct,
    'calculado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.calcular_custo_real_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calcular_custo_real_pedido_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPC OBTER_MARGEM_PEDIDO_ADMIN
-- ------------------------------------------------------------------------------
-- Consulta analítica da margem e componentes de um pedido (exclusiva Admin).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_margem_pedido_admin(p_pedido_id BIGINT)
RETURNS JSONB AS $$
DECLARE
  v_cr RECORD;
  v_componentes JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem visualizar margens e custos de pedidos.'
    );
  END IF;

  SELECT * INTO v_cr
  FROM public.pedido_custos_realizados
  WHERE pedido_id = p_pedido_id AND status = 'finalizado'
  ORDER BY versao DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'COSTS_NOT_CALCULATED',
      'error', 'Os custos e margens deste pedido ainda não foram consolidados. Execute o cálculo após a produção.'
    );
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.id ASC), '[]'::jsonb)
  INTO v_componentes
  FROM public.pedido_custo_componentes c
  WHERE c.custo_realizado_id = v_cr.id;

  RETURN jsonb_build_object(
    'success', true,
    'custo_realizado_id', v_cr.id,
    'pedido_id', p_pedido_id,
    'versao', v_cr.versao,
    'status', v_cr.status,
    'receita_liquida', v_cr.receita_liquida_snapshot,
    'custo_ingredientes_real', v_cr.custo_ingredientes_real,
    'custo_embalagem', v_cr.custo_embalagem,
    'custo_mao_de_obra', v_cr.custo_mao_de_obra,
    'custo_adicionais', v_cr.custo_adicionais,
    'frete_subsidiado', v_cr.frete_subsidiado,
    'custo_indireto_rateado', v_cr.custo_indireto_rateado,
    'taxas_variaveis_atribuiveis', v_cr.taxas_variaveis_atribuiveis,
    'custo_atribuivel_total', v_cr.custo_atribuivel_total,
    'margem_contribuicao_valor', v_cr.margem_contribuicao_valor,
    'margem_contribuicao_percentual', v_cr.margem_contribuicao_percentual,
    'calculado_em', v_cr.calculado_em,
    'motivo_retificacao', v_cr.motivo_retificacao,
    'componentes', v_componentes
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_margem_pedido_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_margem_pedido_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. RPC OBTER_MARGENS_PRODUTOS_ADMIN
-- ------------------------------------------------------------------------------
-- Visão consolidada de margem estimada por produto do catálogo para gestão de preços.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_margens_produtos_admin(
  p_categoria TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50
)
RETURNS JSONB AS $$
DECLARE
  v_itens JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem consultar margens consolidadas de produtos.'
    );
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.margem_percentual ASC), '[]'::jsonb)
  INTO v_itens
  FROM (
    SELECT
      p.id AS produto_id,
      p.nome AS produto_nome,
      p.preco AS preco_venda,
      p.ativo,
      COALESCE(ROUND(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 2), 0.00) AS custo_insumos_cmp,
      COALESCE(tempos.custo_mo, 0.00) AS custo_mao_obra,
      COALESCE(adics.custo_adicionais, 0.00) AS custo_embalagens_adicionais,
      ROUND(
        COALESCE(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 0.00) +
        COALESCE(tempos.custo_mo, 0.00) +
        COALESCE(adics.custo_adicionais, 0.00)
      , 2) AS custo_direto_total,
      CASE
        WHEN p.preco > 0 THEN ROUND(
          (p.preco - (
            COALESCE(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 0.00) +
            COALESCE(tempos.custo_mo, 0.00) +
            COALESCE(adics.custo_adicionais, 0.00)
          ))
        , 2)
        ELSE 0.00
      END AS margem_bruta_valor,
      CASE
        WHEN p.preco > 0 THEN ROUND(
          ((p.preco - (
            COALESCE(SUM(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0)), 0.00) +
            COALESCE(tempos.custo_mo, 0.00) +
            COALESCE(adics.custo_adicionais, 0.00)
          )) / p.preco) * 100.0
        , 2)
        ELSE 0.00
      END AS margem_percentual
    FROM public.produtos p
    LEFT JOIN public.produto_ingredientes pi ON pi.produto_id = p.id
    LEFT JOIN public.ingredientes i ON i.id = pi.ingrediente_id
    LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
    LEFT JOIN (
      SELECT pt.produto_id, ROUND(SUM((pt.minutos_padrao / 60.0) * r.custo_hora), 2) AS custo_mo
      FROM public.produto_tempos_producao pt
      JOIN public.recursos_producao r ON r.id = pt.recurso_id AND r.ativo = true
      GROUP BY pt.produto_id
    ) tempos ON tempos.produto_id = p.id
    LEFT JOIN (
      SELECT ca.produto_id, ROUND(SUM(ca.valor), 2) AS custo_adicionais
      FROM public.produto_custos_adicionais ca
      WHERE ca.ativo = true AND ca.produto_id IS NOT NULL
      GROUP BY ca.produto_id
    ) adics ON adics.produto_id = p.id
    GROUP BY p.id, p.nome, p.preco, p.ativo, tempos.custo_mo, adics.custo_adicionais
    LIMIT GREATEST(1, LEAST(200, p_limite))
  ) r;

  RETURN jsonb_build_object('success', true, 'produtos', v_itens);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_margens_produtos_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_margens_produtos_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. RPCs DE CADASTRO E GESTÃO FABRIL (ADMIN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_recurso_producao_admin(
  p_id BIGINT DEFAULT NULL,
  p_nome TEXT DEFAULT NULL,
  p_tipo TEXT DEFAULT 'mao_de_obra',
  p_custo_hora NUMERIC DEFAULT 0.00,
  p_descricao TEXT DEFAULT NULL,
  p_ativo BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_rec_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar recursos fabris.');
  END IF;

  IF p_nome IS NULL OR length(trim(p_nome)) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_RESOURCE_NAME', 'error', 'Informe um nome válido para o recurso.');
  END IF;

  IF p_custo_hora < 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_HOURLY_COST', 'error', 'O custo por hora não pode ser negativo.');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.recursos_producao (nome, tipo, custo_hora, descricao, ativo)
    VALUES (trim(p_nome), p_tipo, p_custo_hora, p_descricao, p_ativo)
    RETURNING id INTO v_rec_id;
  ELSE
    UPDATE public.recursos_producao
    SET nome = trim(p_nome), tipo = p_tipo, custo_hora = p_custo_hora, descricao = p_descricao, ativo = p_ativo, updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_rec_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'recurso_id', v_rec_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_recurso_producao_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_recurso_producao_admin TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.salvar_tempo_producao_produto_admin(
  p_produto_id BIGINT,
  p_etapa TEXT,
  p_minutos_padrao NUMERIC,
  p_recurso_id BIGINT,
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_tempo_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem configurar tempos de produção.');
  END IF;

  IF p_minutos_padrao <= 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_MINUTES', 'error', 'A duração em minutos deve ser maior que zero.');
  END IF;

  INSERT INTO public.produto_tempos_producao (produto_id, etapa, minutos_padrao, recurso_id, observacoes)
  VALUES (p_produto_id, p_etapa, p_minutos_padrao, p_recurso_id, p_observacoes)
  ON CONFLICT (produto_id, etapa, recurso_id)
  DO UPDATE SET minutos_padrao = EXCLUDED.minutos_padrao, observacoes = EXCLUDED.observacoes, updated_at = NOW()
  RETURNING id INTO v_tempo_id;

  RETURN jsonb_build_object('success', true, 'tempo_id', v_tempo_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_tempo_producao_produto_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_tempo_producao_produto_admin TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.salvar_custo_adicional_produto_admin(
  p_id BIGINT DEFAULT NULL,
  p_produto_id BIGINT DEFAULT NULL,
  p_produto_opcao_id BIGINT DEFAULT NULL,
  p_nome TEXT DEFAULT NULL,
  p_categoria TEXT DEFAULT 'embalagem',
  p_tipo_aplicacao TEXT DEFAULT 'POR_UNIDADE',
  p_valor NUMERIC DEFAULT 0.00,
  p_ativo BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_adic_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem gerenciar custos adicionais e embalagens.');
  END IF;

  IF p_nome IS NULL OR length(trim(p_nome)) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_NAME', 'error', 'Nome do custo adicional/embalagem inválido.');
  END IF;

  IF p_valor < 0 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVALID_VALUE', 'error', 'O valor não pode ser negativo.');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.produto_custos_adicionais (
      produto_id, produto_opcao_id, nome, categoria, tipo_aplicacao, valor, ativo
    ) VALUES (
      p_produto_id, p_produto_opcao_id, trim(p_nome), p_categoria, p_tipo_aplicacao, p_valor, p_ativo
    ) RETURNING id INTO v_adic_id;
  ELSE
    UPDATE public.produto_custos_adicionais
    SET produto_id = p_produto_id, produto_opcao_id = p_produto_opcao_id, nome = trim(p_nome),
        categoria = p_categoria, tipo_aplicacao = p_tipo_aplicacao, valor = p_valor, ativo = p_ativo, updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_adic_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'custo_adicional_id', v_adic_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_custo_adicional_produto_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_custo_adicional_produto_admin TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.salvar_politica_precificacao_admin(
  p_id BIGINT DEFAULT NULL,
  p_nome TEXT DEFAULT 'Padrão Confeitaria',
  p_margem_alvo NUMERIC DEFAULT 40.00,
  p_taxa_cartao NUMERIC DEFAULT 3.99,
  p_impostos NUMERIC DEFAULT 6.00,
  p_comissao NUMERIC DEFAULT 0.00,
  p_custo_indireto NUMERIC DEFAULT 5.00,
  p_padrao BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_pol_id BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem configurar políticas de precificação.');
  END IF;

  IF p_padrao THEN
    UPDATE public.politicas_precificacao SET padrao = false WHERE padrao = true;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.politicas_precificacao (
      nome, margem_alvo_padrao_percentual, taxa_cartao_padrao_percentual,
      impostos_padrao_percentual, comissao_padrao_percentual, custo_indireto_padrao_percentual, padrao
    ) VALUES (
      trim(p_nome), p_margem_alvo, p_taxa_cartao, p_impostos, p_comissao, p_custo_indireto, p_padrao
    ) RETURNING id INTO v_pol_id;
  ELSE
    UPDATE public.politicas_precificacao
    SET nome = trim(p_nome), margem_alvo_padrao_percentual = p_margem_alvo,
        taxa_cartao_padrao_percentual = p_taxa_cartao, impostos_padrao_percentual = p_impostos,
        comissao_padrao_percentual = p_comissao, custo_indireto_padrao_percentual = p_custo_indireto,
        padrao = p_padrao, updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_pol_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'politica_id', v_pol_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_politica_precificacao_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_politica_precificacao_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. RPC OBTER_ENGENHARIA_CUSTOS_PRODUTO_ADMIN
-- ------------------------------------------------------------------------------
-- Retorna a ficha técnica fabril completa do produto (insumos CMP, tempos e adicionais).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_engenharia_custos_produto_admin(p_produto_id BIGINT)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
  v_tempos JSONB;
  v_adicionais JSONB;
  v_insumos JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'code', 'PERMISSION_DENIED', 'error', 'Apenas administradores podem consultar engenharia de custos de produtos.');
  END IF;

  SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'PRODUCT_NOT_FOUND', 'error', 'Produto não encontrado.');
  END IF;

  -- Insumos com CMP
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'ingrediente_id', i.id,
    'nome', i.nome,
    'quantidade', pi.quantidade,
    'unidade', i.unidade,
    'custo_unitario_teorico', i.custo_unitario,
    'custo_medio_ponderado', COALESCE(s.custo_medio_ponderado, i.custo_unitario),
    'custo_cmp_total', ROUND(pi.quantidade * COALESCE(NULLIF(s.custo_medio_ponderado, 0), i.custo_unitario, 0), 2)
  )), '[]'::jsonb)
  INTO v_insumos
  FROM public.produto_ingredientes pi
  JOIN public.ingredientes i ON i.id = pi.ingrediente_id
  LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
  WHERE pi.produto_id = p_produto_id;

  -- Tempos
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pt.id,
    'etapa', pt.etapa,
    'minutos_padrao', pt.minutos_padrao,
    'recurso_id', r.id,
    'recurso_nome', r.nome,
    'recurso_tipo', r.tipo,
    'custo_hora', r.custo_hora,
    'custo_estimado', ROUND((pt.minutos_padrao / 60.0) * r.custo_hora, 2)
  )), '[]'::jsonb)
  INTO v_tempos
  FROM public.produto_tempos_producao pt
  JOIN public.recursos_producao r ON r.id = pt.recurso_id
  WHERE pt.produto_id = p_produto_id;

  -- Adicionais / Embalagens
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ca.id,
    'nome', ca.nome,
    'categoria', ca.categoria,
    'tipo_aplicacao', ca.tipo_aplicacao,
    'valor', ca.valor,
    'ativo', ca.ativo
  )), '[]'::jsonb)
  INTO v_adicionais
  FROM public.produto_custos_adicionais ca
  WHERE ca.produto_id = p_produto_id;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'produto_nome', v_prod.nome,
    'preco_atual', v_prod.preco,
    'insumos', v_insumos,
    'tempos', v_tempos,
    'adicionais', v_adicionais
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_engenharia_custos_produto_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_engenharia_custos_produto_admin TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC OBTER_DASHBOARD_MARGENS_ADMIN
-- ------------------------------------------------------------------------------
-- Dashboard gerencial de custos e margens de contribuição (Admin only).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_dashboard_margens_admin(
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_inicio DATE := COALESCE(p_data_inicio, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE - INTERVAL '30 days');
  v_fim DATE := COALESCE(p_data_fim, (NOW() AT TIME ZONE 'America/Fortaleza')::DATE);
  v_resumo RECORD;
  v_top_produtos JSONB;
  v_pedidos_alerta JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PERMISSION_DENIED',
      'error', 'Apenas administradores podem visualizar o dashboard de margens.'
    );
  END IF;

  -- Resumo agregado de margens dos pedidos calculados no período
  SELECT
    COUNT(cr.id) AS total_pedidos_calculados,
    COALESCE(SUM(cr.receita_liquida_snapshot), 0.00) AS receita_liquida_total,
    COALESCE(SUM(cr.custo_atribuivel_total), 0.00) AS custo_atribuivel_total,
    COALESCE(SUM(cr.margem_contribuicao_valor), 0.00) AS margem_contribuicao_total,
    COALESCE(SUM(cr.frete_subsidiado), 0.00) AS frete_subsidiado_total,
    CASE
      WHEN SUM(cr.receita_liquida_snapshot) > 0 THEN
        ROUND((SUM(cr.margem_contribuicao_valor) / SUM(cr.receita_liquida_snapshot)) * 100.0, 2)
      ELSE 0.00
    END AS margem_media_percentual
  INTO v_resumo
  FROM public.pedido_custos_realizados cr
  JOIN public.pedidos p ON p.id = cr.pedido_id
  WHERE cr.status = 'finalizado'
    AND (cr.calculado_em AT TIME ZONE 'America/Fortaleza')::DATE BETWEEN v_inicio AND v_fim;

  -- Pedidos com margem negativa ou abaixo de 20%
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'pedido_id', p.id,
    'cliente_nome', p.nome_cliente,
    'receita_liquida', cr.receita_liquida_snapshot,
    'custo_total', cr.custo_atribuivel_total,
    'margem_valor', cr.margem_contribuicao_valor,
    'margem_pct', cr.margem_contribuicao_percentual,
    'calculado_em', cr.calculado_em
  )), '[]'::jsonb)
  INTO v_pedidos_alerta
  FROM public.pedido_custos_realizados cr
  JOIN public.pedidos p ON p.id = cr.pedido_id
  WHERE cr.status = 'finalizado'
    AND (cr.calculado_em AT TIME ZONE 'America/Fortaleza')::DATE BETWEEN v_inicio AND v_fim
    AND (cr.margem_contribuicao_valor < 0 OR cr.margem_contribuicao_percentual < 20.00)
  LIMIT 20;

  RETURN jsonb_build_object(
    'success', true,
    'periodo', jsonb_build_object('inicio', v_inicio, 'fim', v_fim),
    'resumo', jsonb_build_object(
      'total_pedidos_calculados', v_resumo.total_pedidos_calculados,
      'receita_liquida_total', v_resumo.receita_liquida_total,
      'custo_atribuivel_total', v_resumo.custo_atribuivel_total,
      'margem_contribuicao_total', v_resumo.margem_contribuicao_total,
      'frete_subsidiado_total', v_resumo.frete_subsidiado_total,
      'margem_media_percentual', v_resumo.margem_media_percentual
    ),
    'pedidos_alerta', v_pedidos_alerta
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_dashboard_margens_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_dashboard_margens_admin TO authenticated, service_role;
