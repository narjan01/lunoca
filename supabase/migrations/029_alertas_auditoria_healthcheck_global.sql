-- ==============================================================================
-- MIGRATION 029: ALERTAS OPERACIONAIS PROATIVOS, AUDITORIA AVANÇADA & HEALTH-CHECK GLOBAL
-- ==============================================================================
-- 1. ESTRUTURAS DE ALERTAS: alertas_configuracoes, alertas_operacionais e
--    alertas_reconhecimentos com desacoplamento estrito (alertas como projeção).
-- 2. TRILHA DE AUDITORIA OPERACIONAL: auditoria_operacional_eventos append-only
--    imutável (rejeita UPDATE e DELETE físicos com erro 42501).
-- 3. TRIGGERS AUTOMÁTICOS DE AUDITORIA: monitoram alterações em catálogo (preço/status),
--    ajustes manuais de ingredientes/lotes, políticas de precificação e configurações.
-- 4. MOTOR DE ALERTAS DINÂMICO: detecção de ruptura de insumos, lotes vencidos,
--    risco de validade FEFO, risco de atraso na bancada, qualidade retida e margem crítica.
-- 5. SANITIZAÇÃO DE OPERADOR: visão de bancada estritamente desprovida de dados financeiros,
--    custos, margens, markups e markdowns.
-- 6. HEALTH-CHECK GLOBAL: diagnóstico sistêmico estritamente read-only em 5 eixos
--    (saldos vs lotes, financeiro vs pagamentos, integridade de pedidos, FEFO e margens).
-- 7. ZERO EFEITO FINANCEIRO: alertas e auditoria são observacionais; zero efeito
--    em financeiro_lancamentos ou pedido_pagamentos (caixa e DRE intocados).
-- 8. RBAC FAIL-CLOSED: health-check global, auditoria e margens restritos a Administradores.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CONFIGURAÇÕES GLOBAIS DE ALERTAS OPERACIONAIS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_configuracoes (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  dias_aviso_validade INTEGER NOT NULL DEFAULT 7 CHECK (dias_aviso_validade >= 1),
  margem_minima_alvo NUMERIC(5,2) NOT NULL DEFAULT 30.00 CHECK (margem_minima_alvo >= 0.00 AND margem_minima_alvo <= 100.00),
  antecedencia_atraso_minutos INTEGER NOT NULL DEFAULT 120 CHECK (antecedencia_atraso_minutos >= 15),
  ativo BOOLEAN NOT NULL DEFAULT true,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed de inicialização único
INSERT INTO public.alertas_configuracoes (id, dias_aviso_validade, margem_minima_alvo, antecedencia_atraso_minutos, ativo)
VALUES (1, 7, 30.00, 120, true)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. TABELA DE ALERTAS OPERACIONAIS (FATO OPERACIONAL / PROJEÇÃO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_operacionais (
  id BIGSERIAL PRIMARY KEY,
  tipo_alerta TEXT NOT NULL CHECK (tipo_alerta IN (
    'RUPTURA_ESTOQUE',
    'LOTE_VENCIMENTO',
    'LOTE_VENCIDO',
    'ATRASO_PEDIDO',
    'MARGEM_CRITICA',
    'QUALIDADE_RETIDA',
    'DIVERGENCIA_INVENTARIO',
    'SISTEMICO'
  )),
  nivel TEXT NOT NULL CHECK (nivel IN ('CRITICO', 'ATENCAO', 'OPERACIONAL', 'INFO')),
  origem_tabela TEXT,
  origem_id TEXT,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  dados_contexto JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'RECONHECIDO', 'RESOLVIDO')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolvido_em TIMESTAMPTZ,
  CONSTRAINT uq_alerta_origem_tipo UNIQUE (tipo_alerta, origem_tabela, origem_id)
);

CREATE INDEX IF NOT EXISTS idx_alertas_op_status ON public.alertas_operacionais(status);
CREATE INDEX IF NOT EXISTS idx_alertas_op_nivel ON public.alertas_operacionais(nivel);
CREATE INDEX IF NOT EXISTS idx_alertas_op_tipo ON public.alertas_operacionais(tipo_alerta);
CREATE INDEX IF NOT EXISTS idx_alertas_op_criado_em ON public.alertas_operacionais(criado_em DESC);

-- ------------------------------------------------------------------------------
-- 3. TABELA DE RECONHECIMENTOS DE ALERTAS (COMPORTAMENTO HUMANO AUDITÁVEL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_reconhecimentos (
  id BIGSERIAL PRIMARY KEY,
  alerta_id BIGINT NOT NULL REFERENCES public.alertas_operacionais(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES auth.users(id),
  usuario_nome TEXT,
  acao TEXT NOT NULL DEFAULT 'RECONHECER',
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_alerta_reconhecimento_usuario UNIQUE (alerta_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_alertas_rec_alerta ON public.alertas_reconhecimentos(alerta_id);
CREATE INDEX IF NOT EXISTS idx_alertas_rec_usuario ON public.alertas_reconhecimentos(usuario_id);

-- ------------------------------------------------------------------------------
-- 4. TRILHA DE AUDITORIA OPERACIONAL AVANÇADA (APPEND-ONLY IMUTÁVEL)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auditoria_operacional_eventos (
  id BIGSERIAL PRIMARY KEY,
  evento_tipo TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT NOT NULL,
  antes JSONB,
  depois JSONB,
  usuario_id UUID,
  origem TEXT NOT NULL DEFAULT 'SISTEMA',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_op_entidade ON public.auditoria_operacional_eventos(entidade, entidade_id);
CREATE INDEX IF NOT EXISTS idx_audit_op_evento ON public.auditoria_operacional_eventos(evento_tipo);
CREATE INDEX IF NOT EXISTS idx_audit_op_created_at ON public.auditoria_operacional_eventos(created_at DESC);

-- Trigger de Imutabilidade Estrita em auditoria_operacional_eventos
CREATE OR REPLACE FUNCTION public._bloquear_mutacao_auditoria_operacional()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AUDITORIA_APPEND_ONLY: Registros da trilha de auditoria são estritamente imutáveis e não podem ser alterados ou excluídos.'
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_mutacao_auditoria_operacional ON public.auditoria_operacional_eventos;
CREATE TRIGGER trg_bloquear_mutacao_auditoria_operacional
  BEFORE UPDATE OR DELETE ON public.auditoria_operacional_eventos
  FOR EACH ROW
  EXECUTE FUNCTION public._bloquear_mutacao_auditoria_operacional();

-- ------------------------------------------------------------------------------
-- 5. TRIGGERS AUTOMÁTICOS DE AUDITORIA OPERACIONAL
-- ------------------------------------------------------------------------------

-- 5.1 Auditoria de alteração de preço e status em produtos
CREATE OR REPLACE FUNCTION public._audit_produtos_mutacao()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.preco IS DISTINCT FROM NEW.preco) OR (OLD.ativo IS DISTINCT FROM NEW.ativo) THEN
      INSERT INTO public.auditoria_operacional_eventos (
        evento_tipo, entidade, entidade_id, antes, depois, usuario_id, origem
      ) VALUES (
        'ALTERACAO_CATALOGO_PRODUTO',
        'produtos',
        NEW.id::TEXT,
        jsonb_build_object('preco', OLD.preco, 'ativo', OLD.ativo, 'nome', OLD.nome),
        jsonb_build_object('preco', NEW.preco, 'ativo', NEW.ativo, 'nome', NEW.nome),
        v_uid,
        'TRIGGER_PRODUTOS'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_audit_produtos_mutacao ON public.produtos;
CREATE TRIGGER trg_audit_produtos_mutacao
  AFTER UPDATE ON public.produtos
  FOR EACH ROW
  EXECUTE FUNCTION public._audit_produtos_mutacao();

-- 5.2 Auditoria de alteração em bloqueio de qualidade de lotes
CREATE OR REPLACE FUNCTION public._audit_ingrediente_lotes_mutacao()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.bloqueado_qualidade IS DISTINCT FROM NEW.bloqueado_qualidade) OR
       (OLD.motivo_bloqueio IS DISTINCT FROM NEW.motivo_bloqueio) THEN
      INSERT INTO public.auditoria_operacional_eventos (
        evento_tipo, entidade, entidade_id, antes, depois, usuario_id, origem
      ) VALUES (
        'ALTERACAO_BLOQUEIO_LOTE',
        'ingrediente_lotes',
        NEW.id::TEXT,
        jsonb_build_object('bloqueado', OLD.bloqueado_qualidade, 'motivo', OLD.motivo_bloqueio, 'lote', OLD.codigo_lote),
        jsonb_build_object('bloqueado', NEW.bloqueado_qualidade, 'motivo', NEW.motivo_bloqueio, 'lote', NEW.codigo_lote),
        v_uid,
        'TRIGGER_LOTES'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_audit_ingrediente_lotes_mutacao ON public.ingrediente_lotes;
CREATE TRIGGER trg_audit_ingrediente_lotes_mutacao
  AFTER UPDATE ON public.ingrediente_lotes
  FOR EACH ROW
  EXECUTE FUNCTION public._audit_ingrediente_lotes_mutacao();

-- 5.3 Auditoria de alteração de políticas de precificação
CREATE OR REPLACE FUNCTION public._audit_politicas_precificacao_mutacao()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO public.auditoria_operacional_eventos (
      evento_tipo, entidade, entidade_id, antes, depois, usuario_id, origem
    ) VALUES (
      'ALTERACAO_POLITICA_PRECIFICACAO',
      'politicas_precificacao',
      NEW.id::TEXT,
      to_jsonb(OLD),
      to_jsonb(NEW),
      v_uid,
      'TRIGGER_POLITICAS'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_audit_politicas_precificacao_mutacao ON public.politicas_precificacao;
CREATE TRIGGER trg_audit_politicas_precificacao_mutacao
  AFTER UPDATE ON public.politicas_precificacao
  FOR EACH ROW
  EXECUTE FUNCTION public._audit_politicas_precificacao_mutacao();

-- ------------------------------------------------------------------------------
-- 6. RPC: PROCESSAMENTO AUTÔNOMO PROATIVO DE ALERTAS OPERACIONAIS (WORKER/CRON)
-- ------------------------------------------------------------------------------
-- Executada de forma autônoma e periódica por crons ou trabalhadores em background,
-- materializando e resolvendo alertas mesmo sem qualquer usuário com o painel aberto.
CREATE OR REPLACE FUNCTION public.processar_alertas_operacionais()
RETURNS JSONB AS $$
DECLARE
  v_cfg RECORD;
  v_resolvidos INT := 0;
  v_total_ativos INT := 0;
BEGIN
  -- Obter configurações ativas
  SELECT * INTO v_cfg FROM public.alertas_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.dias_aviso_validade := 7;
    v_cfg.margem_minima_alvo := 30.00;
    v_cfg.antecedencia_atraso_minutos := 120;
    v_cfg.ativo := true;
  END IF;

  -- 1. Detecção: RUPTURA_ESTOQUE (insumos com estoque atual <= estoque mínimo)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'RUPTURA_ESTOQUE',
    CASE WHEN COALESCE(s.saldo_atual, i.estoque_qtd, 0) <= 0 THEN 'CRITICO' ELSE 'OPERACIONAL' END,
    'ingredientes',
    i.id::TEXT,
    'Ruptura de Estoque: ' || i.nome,
    'Estoque atual (' || COALESCE(s.saldo_atual, i.estoque_qtd, 0) || ' ' || i.unidade || ') está abaixo ou no nível mínimo configurado (' || i.estoque_minimo || ' ' || i.unidade || ').',
    jsonb_build_object(
      'ingrediente_id', i.id,
      'nome', i.nome,
      'saldo_atual', COALESCE(s.saldo_atual, i.estoque_qtd, 0),
      'estoque_minimo', i.estoque_minimo,
      'unidade', i.unidade
    ),
    'ATIVO'
  FROM public.ingredientes i
  LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
  WHERE i.ativo = true
    AND COALESCE(s.saldo_atual, i.estoque_qtd, 0) <= i.estoque_minimo
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = EXCLUDED.nivel,
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- 2. Detecção: LOTE_VENCIDO (lotes vencidos ainda com saldo físico positivo)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'LOTE_VENCIDO',
    'CRITICO',
    'ingrediente_lotes',
    l.id::TEXT,
    'Lote Vencido com Saldo: ' || l.codigo_lote,
    'Lote ' || l.codigo_lote || ' de ' || i.nome || ' venceu em ' || to_char(l.data_validade, 'DD/MM/YYYY') || ' e ainda possui saldo de ' || l.quantidade_atual || ' ' || i.unidade || '.',
    jsonb_build_object(
      'lote_id', l.id,
      'codigo_lote', l.codigo_lote,
      'ingrediente_id', i.id,
      'ingrediente_nome', i.nome,
      'quantidade_atual', l.quantidade_atual,
      'data_validade', l.data_validade,
      'dias_vencido', (CURRENT_DATE - l.data_validade)
    ),
    'ATIVO'
  FROM public.ingrediente_lotes l
  JOIN public.ingredientes i ON i.id = l.ingrediente_id
  WHERE l.quantidade_atual > 0
    AND l.data_validade < CURRENT_DATE
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = 'CRITICO',
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- 3. Detecção: LOTE_VENCIMENTO (lotes válidos próximos da validade FEFO)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'LOTE_VENCIMENTO',
    'ATENCAO',
    'ingrediente_lotes',
    l.id::TEXT,
    'Validade Próxima: Lote ' || l.codigo_lote,
    'Lote ' || l.codigo_lote || ' de ' || i.nome || ' vence em ' || (l.data_validade - CURRENT_DATE) || ' dia(s) (' || to_char(l.data_validade, 'DD/MM/YYYY') || '). Saldo: ' || l.quantidade_atual || ' ' || i.unidade || '.',
    jsonb_build_object(
      'lote_id', l.id,
      'codigo_lote', l.codigo_lote,
      'ingrediente_id', i.id,
      'ingrediente_nome', i.nome,
      'quantidade_atual', l.quantidade_atual,
      'data_validade', l.data_validade,
      'dias_restantes', (l.data_validade - CURRENT_DATE)
    ),
    'ATIVO'
  FROM public.ingrediente_lotes l
  JOIN public.ingredientes i ON i.id = l.ingrediente_id
  WHERE l.quantidade_atual > 0
    AND l.data_validade >= CURRENT_DATE
    AND l.data_validade <= (CURRENT_DATE + v_cfg.dias_aviso_validade)
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = 'ATENCAO',
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- 4. Detecção: ATRASO_PEDIDO (pedidos confirmados/em produção com entrega iminente ou atrasada)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'ATRASO_PEDIDO',
    CASE
      WHEN p.data_entrega < CURRENT_DATE OR (p.data_entrega = CURRENT_DATE AND p.hora_entrega <= CURRENT_TIME) THEN 'CRITICO'
      ELSE 'ATENCAO'
    END,
    'pedidos',
    p.id::TEXT,
    'Risco de Atraso: Pedido #' || p.id,
    'Pedido #' || p.id || ' (' || p.nome_cliente || ') com entrega prevista para ' || to_char(p.data_entrega, 'DD/MM/YYYY') || ' às ' || p.hora_entrega || ' ainda está em status ' || p.status_operacional || '.',
    jsonb_build_object(
      'pedido_id', p.id,
      'nome_cliente', p.nome_cliente,
      'data_entrega', p.data_entrega,
      'hora_entrega', p.hora_entrega,
      'status_operacional', p.status_operacional,
      'total', p.total
    ),
    'ATIVO'
  FROM public.pedidos p
  WHERE p.status_operacional IN ('aguardando_producao', 'em_producao', 'pronto')
    AND p.status_comercial NOT IN ('cancelado')
    AND (
      p.data_entrega < CURRENT_DATE
      OR (
        p.data_entrega = CURRENT_DATE
        AND (p.data_entrega + p.hora_entrega) <= (NOW() + (v_cfg.antecedencia_atraso_minutos || ' minutes')::interval)
      )
    )
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = EXCLUDED.nivel,
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- 5. Detecção: MARGEM_CRITICA (pedidos calculados com margem < margem_minima_alvo)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'MARGEM_CRITICA',
    CASE WHEN c.margem_contribuicao_percentual < 0 THEN 'CRITICO' ELSE 'ATENCAO' END,
    'pedido_custos_realizados',
    c.id::TEXT,
    'Margem Crítica: Pedido #' || c.pedido_id,
    'Pedido #' || c.pedido_id || ' fechou com margem de ' || to_char(c.margem_contribuicao_percentual, 'FM990.00') || '%, inferior ao alvo configurado de ' || to_char(v_cfg.margem_minima_alvo, 'FM990.00') || '%.',
    jsonb_build_object(
      'custo_id', c.id,
      'pedido_id', c.pedido_id,
      'receita_liquida', c.receita_liquida_snapshot,
      'custo_atribuivel_total', c.custo_atribuivel_total,
      'margem_contribuicao_valor', c.margem_contribuicao_valor,
      'margem_contribuicao_percentual', c.margem_contribuicao_percentual,
      'alvo_configurado', v_cfg.margem_minima_alvo
    ),
    'ATIVO'
  FROM public.pedido_custos_realizados c
  WHERE c.status = 'finalizado'
    AND c.margem_contribuicao_percentual < v_cfg.margem_minima_alvo
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = EXCLUDED.nivel,
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- 6. Detecção: QUALIDADE_RETIDA (itens com checkpoint de qualidade REPROVADO não resolvidos)
  INSERT INTO public.alertas_operacionais (tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status)
  SELECT
    'QUALIDADE_RETIDA',
    'CRITICO',
    'producao_controles_qualidade',
    q.id::TEXT,
    'Retenção de Qualidade: Pedido #' || q.pedido_id,
    'Pedido #' || q.pedido_id || ' foi reprovado na etapa ' || q.etapa || ' e requer reinspeção ou intervenção.',
    jsonb_build_object(
      'controle_id', q.id,
      'pedido_id', q.pedido_id,
      'etapa', q.etapa,
      'observacao', q.observacao,
      'responsavel', q.responsavel_nome,
      'inspecionado_em', q.registrado_em
    ),
    'ATIVO'
  FROM public.producao_controles_qualidade q
  JOIN public.pedidos p ON p.id = q.pedido_id
  WHERE q.resultado = 'REPROVADO'
    AND p.status_operacional NOT IN ('entregue', 'retirado')
    AND p.status_comercial NOT IN ('cancelado')
    AND NOT EXISTS (
      SELECT 1 FROM public.producao_controles_qualidade q2
      WHERE q2.pedido_id = q.pedido_id
        AND q2.etapa = q.etapa
        AND q2.resultado = 'APROVADO'
        AND q2.registrado_em > q.registrado_em
    )
  ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
  DO UPDATE SET
    nivel = 'CRITICO',
    descricao = EXCLUDED.descricao,
    dados_contexto = EXCLUDED.dados_contexto,
    status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
    resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
    atualizado_em = NOW();

  -- RESOLUÇÃO AUTOMÁTICA (a condição de risco deixou de existir no mundo real)
  -- 1) Rupturas resolvidas
  WITH resolvidas AS (
    UPDATE public.alertas_operacionais a
    SET status = 'RESOLVIDO', resolvido_em = NOW()
    WHERE a.tipo_alerta = 'RUPTURA_ESTOQUE'
      AND a.status IN ('ATIVO', 'RECONHECIDO')
      AND EXISTS (
        SELECT 1 FROM public.ingredientes i
        LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
        WHERE i.id::TEXT = a.origem_id
          AND COALESCE(s.saldo_atual, i.estoque_qtd, 0) > i.estoque_minimo
      )
    RETURNING a.id
  )
  SELECT v_resolvidos + count(*) INTO v_resolvidos FROM resolvidas;

  -- 2) Lotes vencidos com saldo zerado
  WITH resolvidas AS (
    UPDATE public.alertas_operacionais a
    SET status = 'RESOLVIDO', resolvido_em = NOW()
    WHERE a.tipo_alerta IN ('LOTE_VENCIDO', 'LOTE_VENCIMENTO')
      AND a.status IN ('ATIVO', 'RECONHECIDO')
      AND EXISTS (
        SELECT 1 FROM public.ingrediente_lotes l
        WHERE l.id::TEXT = a.origem_id
          AND l.quantidade_atual <= 0
      )
    RETURNING a.id
  )
  SELECT v_resolvidos + count(*) INTO v_resolvidos FROM resolvidas;

  -- 3) Pedidos atrasados que foram entregues ou cancelados
  WITH resolvidas AS (
    UPDATE public.alertas_operacionais a
    SET status = 'RESOLVIDO', resolvido_em = NOW()
    WHERE a.tipo_alerta = 'ATRASO_PEDIDO'
      AND a.status IN ('ATIVO', 'RECONHECIDO')
      AND EXISTS (
        SELECT 1 FROM public.pedidos p
        WHERE p.id::TEXT = a.origem_id
          AND (p.status_operacional IN ('entregue', 'retirado') OR p.status_comercial = 'cancelado')
      )
    RETURNING a.id
  )
  SELECT v_resolvidos + count(*) INTO v_resolvidos FROM resolvidas;

  -- 4) Qualidade retida liberada por nova inspeção
  WITH resolvidas AS (
    UPDATE public.alertas_operacionais a
    SET status = 'RESOLVIDO', resolvido_em = NOW()
    WHERE a.tipo_alerta = 'QUALIDADE_RETIDA'
      AND a.status IN ('ATIVO', 'RECONHECIDO')
      AND EXISTS (
        SELECT 1 FROM public.producao_controles_qualidade q
        JOIN public.producao_controles_qualidade q2
          ON q2.pedido_id = q.pedido_id AND q2.etapa = q.etapa AND q2.resultado = 'APROVADO' AND q2.registrado_em > q.registrado_em
        WHERE q.id::TEXT = a.origem_id
      )
    RETURNING a.id
  )
  SELECT v_resolvidos + count(*) INTO v_resolvidos FROM resolvidas;

  SELECT count(*) INTO v_total_ativos FROM public.alertas_operacionais WHERE status IN ('ATIVO', 'RECONHECIDO');

  RETURN jsonb_build_object(
    'success', true,
    'processado_em', NOW(),
    'resolvidos', v_resolvidos,
    'total_ativos', v_total_ativos
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.processar_alertas_operacionais() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.processar_alertas_operacionais() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 6.1 RPC: SINCRONIZAR E OBTER ALERTAS OPERACIONAIS (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_alertas_operacionais_admin(
  p_tipo TEXT DEFAULT NULL,
  p_nivel TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_cfg RECORD;
  v_criticos INT := 0;
  v_atencao INT := 0;
  v_operacionais INT := 0;
  v_info INT := 0;
  v_alertas JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Apenas administradores podem acessar o painel completo de alertas e diagnósticos.',
      'code', 'PERMISSION_DENIED'
    );
  END IF;

  -- Processamento proativo autônomo de alertas
  PERFORM public.processar_alertas_operacionais();

  -- Obter configurações ativas
  SELECT * INTO v_cfg FROM public.alertas_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.dias_aviso_validade := 7;
    v_cfg.margem_minima_alvo := 30.00;
    v_cfg.antecedencia_atraso_minutos := 120;
    v_cfg.ativo := true;
  END IF;

  -- Contagem de métricas agregadas dos alertas não-resolvidos
  SELECT
    COUNT(*) FILTER (WHERE nivel = 'CRITICO' AND status != 'RESOLVIDO'),
    COUNT(*) FILTER (WHERE nivel = 'ATENCAO' AND status != 'RESOLVIDO'),
    COUNT(*) FILTER (WHERE nivel = 'OPERACIONAL' AND status != 'RESOLVIDO'),
    COUNT(*) FILTER (WHERE nivel = 'INFO' AND status != 'RESOLVIDO')
  INTO v_criticos, v_atencao, v_operacionais, v_info
  FROM public.alertas_operacionais;

  -- Seleção dos alertas solicitados
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'tipo_alerta', a.tipo_alerta,
      'nivel', a.nivel,
      'origem_tabela', a.origem_tabela,
      'origem_id', a.origem_id,
      'titulo', a.titulo,
      'descricao', a.descricao,
      'dados_contexto', a.dados_contexto,
      'status', a.status,
      'criado_em', a.criado_em,
      'atualizado_em', a.atualizado_em,
      'resolvido_em', a.resolvido_em,
      'reconhecido_por', (
        SELECT jsonb_agg(jsonb_build_object(
          'usuario_id', r.usuario_id,
          'usuario_nome', r.usuario_nome,
          'observacao', r.observacao,
          'criado_em', r.criado_em
        ))
        FROM public.alertas_reconhecimentos r
        WHERE r.alerta_id = a.id
      )
    ) ORDER BY
      CASE a.nivel
        WHEN 'CRITICO' THEN 1
        WHEN 'ATENCAO' THEN 2
        WHEN 'OPERACIONAL' THEN 3
        ELSE 4
      END,
      a.criado_em DESC
  ) INTO v_alertas
  FROM public.alertas_operacionais a
  WHERE (p_tipo IS NULL OR a.tipo_alerta = p_tipo)
    AND (p_nivel IS NULL OR a.nivel = p_nivel)
    AND a.status != 'RESOLVIDO';

  RETURN jsonb_build_object(
    'success', true,
    'metricas', jsonb_build_object(
      'criticos', COALESCE(v_criticos, 0),
      'atencao', COALESCE(v_atencao, 0),
      'operacionais', COALESCE(v_operacionais, 0),
      'info', COALESCE(v_info, 0),
      'total_pendentes', (COALESCE(v_criticos, 0) + COALESCE(v_atencao, 0) + COALESCE(v_operacionais, 0) + COALESCE(v_info, 0))
    ),
    'configuracoes', to_jsonb(v_cfg),
    'alertas', COALESCE(v_alertas, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_alertas_operacionais_admin(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_alertas_operacionais_admin(TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 7. RPC: OBTER ALERTAS OPERACIONAIS SANITIZADOS (OPERADOR DE BANCADA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_alertas_operacionais_operador()
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_res JSONB;
  v_itens JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuário não autenticado.',
      'code', 'UNAUTHENTICATED'
    );
  END IF;

  -- Processamento proativo autônomo de alertas
  PERFORM public.processar_alertas_operacionais();

  -- Seleciona somente alertas operacionais de chão de fábrica/produção
  -- Oculta estritamente MARGEM_CRITICA, SISTEMICO e DIVERGENCIA_INVENTARIO
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'tipo_alerta', a.tipo_alerta,
      'nivel', a.nivel,
      'origem_tabela', a.origem_tabela,
      'origem_id', a.origem_id,
      'titulo', a.titulo,
      'descricao', a.descricao,
      -- Sanitização estrita: remove todos os dados financeiros e custos
      'dados_contexto', a.dados_contexto - 'custo_atribuivel_total' - 'margem_contribuicao_valor' - 'margem_contribuicao_percentual' - 'receita_liquida' - 'alvo_configurado' - 'total',
      'status', a.status,
      'criado_em', a.criado_em
    ) ORDER BY
      CASE a.nivel WHEN 'CRITICO' THEN 1 WHEN 'ATENCAO' THEN 2 ELSE 3 END,
      a.criado_em DESC
  ) INTO v_itens
  FROM public.alertas_operacionais a
  WHERE a.status != 'RESOLVIDO'
    AND a.tipo_alerta IN ('RUPTURA_ESTOQUE', 'LOTE_VENCIMENTO', 'LOTE_VENCIDO', 'ATRASO_PEDIDO', 'QUALIDADE_RETIDA');

  RETURN jsonb_build_object(
    'success', true,
    'modo', 'operador_sanitizado',
    'alertas', COALESCE(v_itens, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_alertas_operacionais_operador() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_alertas_operacionais_operador() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 8. RPC: RECONHECER ALERTA OPERACIONAL (COM IDEMPOTÊNCIA E AUDITORIA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconhecer_alerta_operacional(
  p_alerta_id BIGINT,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_user_nome TEXT;
  v_alerta RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuário não autenticado.',
      'code', 'UNAUTHENTICATED'
    );
  END IF;

  -- Localizar o alerta
  SELECT * INTO v_alerta FROM public.alertas_operacionais WHERE id = p_alerta_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Alerta operacional não localizado.',
      'code', 'ALERT_NOT_FOUND'
    );
  END IF;

  -- Resolver nome do usuário
  SELECT COALESCE(nome, email, 'Colaborador') INTO v_user_nome
  FROM public.profiles
  WHERE id = v_caller_id;

  -- Idempotência: Se o usuário já reconheceu o alerta
  IF EXISTS (
    SELECT 1 FROM public.alertas_reconhecimentos
    WHERE alerta_id = p_alerta_id AND usuario_id = v_caller_id
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'alerta_id', p_alerta_id,
      'mensagem', 'Alerta já reconhecido previamente por este usuário.'
    );
  END IF;

  -- Gravar reconhecimento humano
  INSERT INTO public.alertas_reconhecimentos (
    alerta_id, usuario_id, usuario_nome, acao, observacao
  ) VALUES (
    p_alerta_id, v_caller_id, v_user_nome, 'RECONHECER', p_motivo
  );

  -- Atualizar status do alerta para RECONHECIDO se ainda estiver ATIVO
  UPDATE public.alertas_operacionais
  SET status = 'RECONHECIDO', atualizado_em = NOW()
  WHERE id = p_alerta_id AND status = 'ATIVO';

  -- Gravar evento na trilha imutável de auditoria
  INSERT INTO public.auditoria_operacional_eventos (
    evento_tipo, entidade, entidade_id, antes, depois, usuario_id, origem
  ) VALUES (
    'RECONHECIMENTO_ALERTA_OPERACIONAL',
    'alertas_operacionais',
    p_alerta_id::TEXT,
    jsonb_build_object('status_anterior', v_alerta.status),
    jsonb_build_object('novo_status', 'RECONHECIDO', 'motivo', p_motivo, 'usuario', v_user_nome),
    v_caller_id,
    'RPC_RECONHECER_ALERTA'
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'alerta_id', p_alerta_id,
    'reconhecido_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.reconhecer_alerta_operacional(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconhecer_alerta_operacional(BIGINT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. RPC: EXECUTAR HEALTH-CHECK GLOBAL DO SISTEMA (ESTRITAMENTE READ-ONLY)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.executar_healthcheck_global_admin()
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_status_geral TEXT := 'OK';
  v_checks JSONB := '[]'::jsonb;

  -- Contadores de divergência
  v_div_lotes INT := 0;
  v_div_financeiro INT := 0;
  v_div_orfaos INT := 0;
  v_div_fefo INT := 0;
  v_div_margens INT := 0;

  v_detalhes_lotes JSONB := '[]'::jsonb;
  v_detalhes_fin JSONB := '[]'::jsonb;
  v_detalhes_orfaos JSONB := '[]'::jsonb;
  v_detalhes_fefo JSONB := '[]'::jsonb;
  v_detalhes_margens JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Apenas administradores podem executar o health-check global.',
      'code', 'PERMISSION_DENIED'
    );
  END IF;

  -- ----------------------------------------------------------------------------
  -- CHECK 1: SALDOS_LOTES
  -- Compara a soma dos lotes ativos com ingrediente_saldos.saldo_atual
  -- ----------------------------------------------------------------------------
  SELECT
    COUNT(*),
    COALESCE(jsonb_agg(jsonb_build_object(
      'ingrediente_id', sub.ingrediente_id,
      'nome', sub.nome,
      'saldo_consolidado', sub.saldo_consolidado,
      'soma_lotes', sub.soma_lotes,
      'diferenca', sub.diferenca
    )), '[]'::jsonb)
  INTO v_div_lotes, v_detalhes_lotes
  FROM (
    SELECT
      i.id AS ingrediente_id,
      i.nome,
      COALESCE(s.saldo_atual, 0) AS saldo_consolidado,
      COALESCE(SUM(l.quantidade_atual), 0) AS soma_lotes,
      ABS(COALESCE(s.saldo_atual, 0) - COALESCE(SUM(l.quantidade_atual), 0)) AS diferenca
    FROM public.ingredientes i
    JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
    LEFT JOIN public.ingrediente_lotes l ON l.ingrediente_id = i.id
    WHERE i.ativo = true AND (i.controlar_lote = true OR i.controlar_validade = true)
    GROUP BY i.id, i.nome, s.saldo_atual
    HAVING ABS(COALESCE(s.saldo_atual, 0) - COALESCE(SUM(l.quantidade_atual), 0)) > 0.001
  ) sub;

  -- ----------------------------------------------------------------------------
  -- CHECK 2: FINANCEIRO_PEDIDOS
  -- Verifica pedidos marcados como 'pago' que não possuam registro de pagamento
  -- ----------------------------------------------------------------------------
  SELECT
    COUNT(*),
    COALESCE(jsonb_agg(jsonb_build_object(
      'pedido_id', p.id,
      'total', p.total,
      'status_financeiro', p.status_financeiro,
      'created_at', p.created_at
    )), '[]'::jsonb)
  INTO v_div_financeiro, v_detalhes_fin
  FROM public.pedidos p
  WHERE p.status_financeiro = 'pago'
    AND p.total > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.pedido_pagamentos pp
      WHERE pp.pedido_id = p.id AND pp.status = 'aprovado'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.financeiro_lancamentos fl
      WHERE fl.pedido_id = p.id AND fl.tipo = 'receita'
    );

  -- ----------------------------------------------------------------------------
  -- CHECK 3: PEDIDOS_ORFAOS
  -- Verifica pedidos sem itens filhos ou com valores negativos anômalos
  -- ----------------------------------------------------------------------------
  SELECT
    COUNT(*),
    COALESCE(jsonb_agg(jsonb_build_object(
      'pedido_id', p.id,
      'cliente', p.nome_cliente,
      'motivo', CASE WHEN p.total < 0 THEN 'VALOR_NEGATIVO' ELSE 'SEM_ITENS' END
    )), '[]'::jsonb)
  INTO v_div_orfaos, v_detalhes_orfaos
  FROM public.pedidos p
  WHERE (p.total < 0)
     OR (NOT EXISTS (SELECT 1 FROM public.pedido_itens pi WHERE pi.pedido_id = p.id) AND p.status_comercial != 'cancelado');

  -- ----------------------------------------------------------------------------
  -- CHECK 4: FEFO_INTEGRIDADE
  -- Verifica se existem lotes com quantidade_atual negativa ou sem data de validade
  -- ----------------------------------------------------------------------------
  SELECT
    COUNT(*),
    COALESCE(jsonb_agg(jsonb_build_object(
      'lote_id', l.id,
      'codigo_lote', l.codigo_lote,
      'ingrediente_id', l.ingrediente_id,
      'quantidade_atual', l.quantidade_atual
    )), '[]'::jsonb)
  INTO v_div_fefo, v_detalhes_fefo
  FROM public.ingrediente_lotes l
  WHERE l.quantidade_atual < 0 OR l.data_validade IS NULL;

  -- ----------------------------------------------------------------------------
  -- CHECK 5: MARGENS_ANOMALAS
  -- Identifica pedidos finalizados cuja receita líquida seja positiva mas margem seja nula
  -- ----------------------------------------------------------------------------
  SELECT
    COUNT(*),
    COALESCE(jsonb_agg(jsonb_build_object(
      'custo_id', c.id,
      'pedido_id', c.pedido_id,
      'margem_percentual', c.margem_contribuicao_percentual
    )), '[]'::jsonb)
  INTO v_div_margens, v_detalhes_margens
  FROM public.pedido_custos_realizados c
  WHERE c.status = 'finalizado'
    AND (c.margem_contribuicao_percentual IS NULL OR c.custo_atribuivel_total < 0);

  -- Avaliação do Status Geral
  IF (v_div_lotes > 0 OR v_div_financeiro > 0 OR v_div_fefo > 0) THEN
    v_status_geral := 'CRITICAL';
  ELSIF (v_div_orfaos > 0 OR v_div_margens > 0) THEN
    v_status_geral := 'DEGRADED';
  ELSE
    v_status_geral := 'OK';
  END IF;

  -- Montagem dos 5 checks padronizados
  v_checks := jsonb_build_array(
    jsonb_build_object(
      'codigo', 'SALDOS_LOTES',
      'nome', 'Reconciliação de Saldos Agregados vs Lotes (Frente L)',
      'status', CASE WHEN v_div_lotes = 0 THEN 'OK' ELSE 'CRITICAL' END,
      'divergencias', v_div_lotes,
      'detalhes', v_detalhes_lotes
    ),
    jsonb_build_object(
      'codigo', 'FINANCEIRO_PEDIDOS',
      'nome', 'Integridade Pedidos Pagos vs Lançamentos de Caixa (Frentes C/H)',
      'status', CASE WHEN v_div_financeiro = 0 THEN 'OK' ELSE 'CRITICAL' END,
      'divergencias', v_div_financeiro,
      'detalhes', v_detalhes_fin
    ),
    jsonb_build_object(
      'codigo', 'PEDIDOS_ORFAOS',
      'nome', 'Consistência de Itens e Valores de Pedidos',
      'status', CASE WHEN v_div_orfaos = 0 THEN 'OK' ELSE 'DEGRADED' END,
      'divergencias', v_div_orfaos,
      'detalhes', v_detalhes_orfaos
    ),
    jsonb_build_object(
      'codigo', 'FEFO_INTEGRIDADE',
      'nome', 'Integridade de Lotes e Validades FEFO',
      'status', CASE WHEN v_div_fefo = 0 THEN 'OK' ELSE 'CRITICAL' END,
      'divergencias', v_div_fefo,
      'detalhes', v_detalhes_fefo
    ),
    jsonb_build_object(
      'codigo', 'MARGENS_ANOMALAS',
      'nome', 'Conformidade de Cálculos de Margem & Custo (Frente M)',
      'status', CASE WHEN v_div_margens = 0 THEN 'OK' ELSE 'DEGRADED' END,
      'divergencias', v_div_margens,
      'detalhes', v_detalhes_margens
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'executado_em', NOW(),
    'status', v_status_geral,
    'total_checks', 5,
    'checks', v_checks
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.executar_healthcheck_global_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.executar_healthcheck_global_admin() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. RPC: SALVAR CONFIGURAÇÕES DE ALERTAS (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_configuracoes_alertas_admin(
  p_dias_aviso_validade INTEGER DEFAULT NULL,
  p_margem_minima_alvo NUMERIC DEFAULT NULL,
  p_antecedencia_atraso_minutos INTEGER DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_antiga RECORD;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Apenas administradores podem alterar as configurações de alertas.',
      'code', 'PERMISSION_DENIED'
    );
  END IF;

  SELECT * INTO v_antiga FROM public.alertas_configuracoes WHERE id = 1;

  UPDATE public.alertas_configuracoes
  SET
    dias_aviso_validade = COALESCE(p_dias_aviso_validade, dias_aviso_validade),
    margem_minima_alvo = COALESCE(p_margem_minima_alvo, margem_minima_alvo),
    antecedencia_atraso_minutos = COALESCE(p_antecedencia_atraso_minutos, antecedencia_atraso_minutos),
    atualizado_em = NOW()
  WHERE id = 1;

  -- Gravar evento na trilha imutável de auditoria
  INSERT INTO public.auditoria_operacional_eventos (
    evento_tipo, entidade, entidade_id, antes, depois, usuario_id, origem
  ) VALUES (
    'ALTERACAO_CONFIGURACAO_ALERTAS',
    'alertas_configuracoes',
    '1',
    to_jsonb(v_antiga),
    (SELECT to_jsonb(c) FROM public.alertas_configuracoes c WHERE c.id = 1),
    v_caller_id,
    'RPC_SALVAR_CONFIG_ALERTAS'
  );

  RETURN jsonb_build_object(
    'success', true,
    'configuracoes', (SELECT to_jsonb(c) FROM public.alertas_configuracoes c WHERE c.id = 1)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.salvar_configuracoes_alertas_admin(INTEGER, NUMERIC, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_configuracoes_alertas_admin(INTEGER, NUMERIC, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. RPC: LISTAR TRILHA DE AUDITORIA OPERACIONAL (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_auditoria_operacional_admin(
  p_entidade TEXT DEFAULT NULL,
  p_evento_tipo TEXT DEFAULT NULL,
  p_limite INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_total INT;
  v_eventos JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Apenas administradores podem visualizar a trilha de auditoria operacional.',
      'code', 'PERMISSION_DENIED'
    );
  END IF;

  SELECT COUNT(*) INTO v_total
  FROM public.auditoria_operacional_eventos a
  WHERE (p_entidade IS NULL OR a.entidade = p_entidade)
    AND (p_evento_tipo IS NULL OR a.evento_tipo = p_evento_tipo);

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'evento_tipo', a.evento_tipo,
      'entidade', a.entidade,
      'entidade_id', a.entidade_id,
      'antes', a.antes,
      'depois', a.depois,
      'usuario_id', a.usuario_id,
      'usuario_nome', (SELECT COALESCE(nome, email, 'Colaborador') FROM public.profiles WHERE id = a.usuario_id),
      'origem', a.origem,
      'created_at', a.created_at
    ) ORDER BY a.created_at DESC
  ) INTO v_eventos
  FROM (
    SELECT * FROM public.auditoria_operacional_eventos a
    WHERE (p_entidade IS NULL OR a.entidade = p_entidade)
      AND (p_evento_tipo IS NULL OR a.evento_tipo = p_evento_tipo)
    ORDER BY a.created_at DESC
    LIMIT LEAST(GREATEST(p_limite, 1), 200)
    OFFSET GREATEST(p_offset, 0)
  ) a;

  RETURN jsonb_build_object(
    'success', true,
    'total', v_total,
    'limite', p_limite,
    'offset', p_offset,
    'eventos', COALESCE(v_eventos, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_auditoria_operacional_admin(TEXT, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_auditoria_operacional_admin(TEXT, TEXT, INT, INT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. SEGURANÇA E ROW LEVEL SECURITY (FAIL-CLOSED)
-- ------------------------------------------------------------------------------
ALTER TABLE public.alertas_configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertas_operacionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertas_reconhecimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auditoria_operacional_eventos ENABLE ROW LEVEL SECURITY;

-- Revoke explícito de acesso direto às tabelas
REVOKE ALL ON public.alertas_configuracoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.alertas_operacionais FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.alertas_reconhecimentos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.auditoria_operacional_eventos FROM PUBLIC, anon, authenticated;

-- Políticas de RLS restritas para service_role e admins
DROP POLICY IF EXISTS alertas_configuracoes_admin ON public.alertas_configuracoes;
CREATE POLICY alertas_configuracoes_admin ON public.alertas_configuracoes
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS alertas_operacionais_admin ON public.alertas_operacionais;
CREATE POLICY alertas_operacionais_admin ON public.alertas_operacionais
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS alertas_reconhecimentos_admin ON public.alertas_reconhecimentos;
CREATE POLICY alertas_reconhecimentos_admin ON public.alertas_reconhecimentos
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS auditoria_operacional_select_admin ON public.auditoria_operacional_eventos;
CREATE POLICY auditoria_operacional_select_admin ON public.auditoria_operacional_eventos
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS auditoria_operacional_service_role ON public.auditoria_operacional_eventos;
CREATE POLICY auditoria_operacional_service_role ON public.auditoria_operacional_eventos
  FOR ALL TO service_role USING (true) WITH CHECK (true);
