-- ==============================================================================
-- MIGRATION 030: PESSOAS, TURNOS, ESCALAS & CAPACIDADE REAL DA EQUIPE (FRENTE O)
-- ==============================================================================
-- 1. ESTRUTURAS: funcoes_equipe, colaboradores, colaborador_funcoes, turnos_trabalho,
--    escalas_equipe, escala_intervalos, ausencias_equipe, equipe_configuracoes.
-- 2. SEGREGAÇÃO CONCEITUAL RÍGIDA:
--    - escala_planejada_minutos != minutos_trabalhados_reais (sem ponto/clock-in nesta fase)
--    - capacidade_humana_planejada_minutos != capacidade_producao_pontos (Frente E intocada)
--    - colaborador != auth.users (colaborador pode ou não ter login no sistema)
-- 3. ZERO FOLHA / RH: sem salários, benefícios, horas extras financeiras ou banco de horas.
-- 4. AUSÊNCIAS NÃO-CLÍNICAS: motivos operacionais (FOLGA, FERIAS, AUSENCIA, ATESTADO, INDISPONIBILIDADE, OUTRO) sem diagnósticos médicos.
-- 5. MINUTOS DISPONÍVEIS DERIVADOS: calculados dinamicamente (turno - intervalos - ausências).
-- 6. CARGA E UTILIZAÇÃO POR FUNÇÃO: integra com produto_tempos_producao da Frente M.
-- 7. DETECÇÃO PROATIVA (Frente N / Modelo B): processar_alertas_operacionais() estendida com SOBRECARGA_EQUIPE.
-- 8. ZERO EFEITO FINANCEIRO: sem lançamentos em financeiro_lancamentos ou pedido_pagamentos.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. FUNÇÕES DA EQUIPE OPERACIONAL
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.funcoes_equipe (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9_]+$'),
  nome TEXT NOT NULL,
  descricao TEXT,
  cor_identificadora TEXT NOT NULL DEFAULT '#3b82f6',
  etapas_padrao TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funcoes_equipe_ativo ON public.funcoes_equipe(ativo);

-- Seed de funções operacionais da confeitaria
INSERT INTO public.funcoes_equipe (codigo, nome, descricao, cor_identificadora, etapas_padrao, ativo)
VALUES
  ('CONFEITARIA', 'Confeitaria Artística', 'Montagem fina, recheio, cobertura e acabamento artesanal', '#ec4899', '{"recheio","cobertura","decoracao","finalizacao"}', true),
  ('AUXILIAR', 'Auxiliar de Cozinha', 'Pesagem, preparo de massas, cocção em fornos e resfriamento', '#f59e0b', '{"preparo","forno","resfriamento"}', true),
  ('EMBALAGEM', 'Embalagem & Expedição', 'Caixas personalizadas, laços, rotulagem e conferência final', '#8b5cf6', '{"embalagem"}', true),
  ('ENTREGA', 'Logística & Entrega', 'Separação de rotas, transporte seguro e entrega ao cliente', '#06b6d4', '{"outro"}', true),
  ('ATENDIMENTO', 'Atendimento & Balcão', 'Recepção de clientes para retirada e suporte a encomendas', '#10b981', '{"outro"}', true)
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  etapas_padrao = EXCLUDED.etapas_padrao;

-- ------------------------------------------------------------------------------
-- 2. CADASTRO DE COLABORADORES (PESSOAS FÍSICAS OPERACIONAIS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.colaboradores (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  apelido TEXT,
  telefone TEXT,
  email TEXT,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- O2: auth_user_id não pode vincular dois colaboradores ativos
CREATE UNIQUE INDEX IF NOT EXISTS uq_colaborador_auth_user_ativo 
ON public.colaboradores(auth_user_id) 
WHERE auth_user_id IS NOT NULL AND ativo = true;

CREATE INDEX IF NOT EXISTS idx_colaboradores_ativo ON public.colaboradores(ativo);

-- ------------------------------------------------------------------------------
-- 3. VÍNCULO COLABORADOR <-> FUNÇÕES (HABILIDADES E COMPETÊNCIAS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.colaborador_funcoes (
  id BIGSERIAL PRIMARY KEY,
  colaborador_id BIGINT NOT NULL REFERENCES public.colaboradores(id) ON DELETE CASCADE,
  funcao_id BIGINT NOT NULL REFERENCES public.funcoes_equipe(id) ON DELETE CASCADE,
  principal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_colaborador_funcao UNIQUE (colaborador_id, funcao_id)
);

CREATE INDEX IF NOT EXISTS idx_colab_funcoes_colab ON public.colaborador_funcoes(colaborador_id);
CREATE INDEX IF NOT EXISTS idx_colab_funcoes_funcao ON public.colaborador_funcoes(funcao_id);

-- ------------------------------------------------------------------------------
-- 4. TURNOS DE TRABALHO (MODELOS / TEMPLATES DE JORNADA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.turnos_trabalho (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  intervalo_minutos INT NOT NULL DEFAULT 60 CHECK (intervalo_minutos >= 0),
  dias_semana INT[] NOT NULL DEFAULT '{1,2,3,4,5,6}'::INT[],
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_turno_horarios CHECK (hora_fim > hora_inicio)
);

-- Seed de turnos padrão da confeitaria
INSERT INTO public.turnos_trabalho (nome, hora_inicio, hora_fim, intervalo_minutos, dias_semana, ativo)
VALUES
  ('Manhã (07h às 15h)', '07:00:00', '15:00:00', 60, '{1,2,3,4,5,6}', true),
  ('Tarde (12h às 20h)', '12:00:00', '20:00:00', 60, '{1,2,3,4,5,6}', true),
  ('Integral Comercial (08h às 17h)', '08:00:00', '17:00:00', 60, '{1,2,3,4,5,6}', true),
  ('Sábado Reduzido (08h às 14h)', '08:00:00', '14:00:00', 30, '{6}', true)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------------------
-- 5. ESCALAS DA EQUIPE (PLANEJAMENTO DIÁRIO DE JORNADA)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.escalas_equipe (
  id BIGSERIAL PRIMARY KEY,
  colaborador_id BIGINT NOT NULL REFERENCES public.colaboradores(id) ON DELETE RESTRICT,
  funcao_id BIGINT NOT NULL REFERENCES public.funcoes_equipe(id) ON DELETE RESTRICT,
  data_escala DATE NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  intervalo_minutos INT NOT NULL DEFAULT 60 CHECK (intervalo_minutos >= 0),
  turno_id BIGINT REFERENCES public.turnos_trabalho(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMADA' CHECK (status IN ('CONFIRMADA', 'PENDENTE', 'CANCELADA')),
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_escala_horario CHECK (hora_fim > hora_inicio)
);

CREATE INDEX IF NOT EXISTS idx_escalas_equipe_data ON public.escalas_equipe(data_escala);
CREATE INDEX IF NOT EXISTS idx_escalas_equipe_colab ON public.escalas_equipe(colaborador_id, data_escala);
CREATE INDEX IF NOT EXISTS idx_escalas_equipe_funcao ON public.escalas_equipe(funcao_id, data_escala);

-- Trigger de Validação de Sobreposição de Escalas (O4 e O8: concorrência e não-sobreposição)
CREATE OR REPLACE FUNCTION public._valida_escala_overlap()
RETURNS TRIGGER AS $$
DECLARE
  v_conflito RECORD;
BEGIN
  IF NEW.status = 'CANCELADA' THEN
    RETURN NEW;
  END IF;

  -- Serialização por colaborador para erradicar corridas de concorrência em transações simultâneas
  PERFORM 1 FROM public.colaboradores WHERE id = NEW.colaborador_id FOR UPDATE;

  SELECT id, hora_inicio, hora_fim INTO v_conflito
  FROM public.escalas_equipe
  WHERE colaborador_id = NEW.colaborador_id
    AND data_escala = NEW.data_escala
    AND status != 'CANCELADA'
    AND id != COALESCE(NEW.id, -1)
    AND (NEW.hora_inicio < hora_fim AND NEW.hora_fim > hora_inicio)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ESCALA_OVERLAP: Colaborador já possui escala com horário sobreposto (% às %) nesta data.'
      , v_conflito.hora_inicio, v_conflito.hora_fim
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_valida_escala_overlap ON public.escalas_equipe;
CREATE TRIGGER trg_valida_escala_overlap
  BEFORE INSERT OR UPDATE ON public.escalas_equipe
  FOR EACH ROW
  EXECUTE FUNCTION public._valida_escala_overlap();

-- ------------------------------------------------------------------------------
-- 6. INTERVALOS ESPECÍFICOS DA ESCALA (OPCIONAL / DETALHADO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.escala_intervalos (
  id BIGSERIAL PRIMARY KEY,
  escala_id BIGINT NOT NULL REFERENCES public.escalas_equipe(id) ON DELETE CASCADE,
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'ALMOCO' CHECK (tipo IN ('ALMOCO', 'DESCANSO', 'OUTRO')),
  duracao_minutos INT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (hora_fim - hora_inicio))::INT / 60
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_intervalo_horario CHECK (hora_fim > hora_inicio)
);

CREATE INDEX IF NOT EXISTS idx_escala_intervalos_escala ON public.escala_intervalos(escala_id);

-- ------------------------------------------------------------------------------
-- 7. AUSÊNCIAS, FOLGAS E ATESTADOS DA EQUIPE
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ausencias_equipe (
  id BIGSERIAL PRIMARY KEY,
  colaborador_id BIGINT NOT NULL REFERENCES public.colaboradores(id) ON DELETE CASCADE,
  data_inicio DATE NOT NULL,
  data_fim DATE NOT NULL,
  hora_inicio TIME,
  hora_fim TIME,
  tipo TEXT NOT NULL CHECK (tipo IN ('FOLGA', 'FERIAS', 'AUSENCIA', 'ATESTADO', 'INDISPONIBILIDADE', 'OUTRO')),
  motivo_geral TEXT,
  aprovado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ausencia_datas CHECK (data_fim >= data_inicio),
  CONSTRAINT chk_ausencia_horas CHECK ((hora_inicio IS NULL AND hora_fim IS NULL) OR (hora_fim > hora_inicio))
);

CREATE INDEX IF NOT EXISTS idx_ausencias_equipe_periodo ON public.ausencias_equipe(colaborador_id, data_inicio, data_fim);

-- ------------------------------------------------------------------------------
-- 8. CONFIGURAÇÕES DE CAPACIDADE E ALERTAS DE EQUIPE
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.equipe_configuracoes (
  id INT PRIMARY KEY DEFAULT 1,
  percentual_alerta_atencao NUMERIC(5,2) NOT NULL DEFAULT 80.00 CHECK (percentual_alerta_atencao > 0),
  percentual_alerta_alto NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (percentual_alerta_alto >= percentual_alerta_atencao),
  percentual_alerta_critico NUMERIC(5,2) NOT NULL DEFAULT 120.00 CHECK (percentual_alerta_critico >= percentual_alerta_alto),
  dias_antecedencia_analise INT NOT NULL DEFAULT 7 CHECK (dias_antecedencia_analise >= 1),
  ativo BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.equipe_configuracoes (id, percentual_alerta_atencao, percentual_alerta_alto, percentual_alerta_critico, dias_antecedencia_analise, ativo)
VALUES (1, 80.00, 100.00, 120.00, 7, true)
ON CONFLICT (id) DO NOTHING;

-- Atualizar o check constraint de alertas_operacionais para incluir SOBRECARGA_EQUIPE
ALTER TABLE public.alertas_operacionais 
  DROP CONSTRAINT IF EXISTS alertas_operacionais_tipo_alerta_check;

ALTER TABLE public.alertas_operacionais
  ADD CONSTRAINT alertas_operacionais_tipo_alerta_check CHECK (tipo_alerta IN (
    'RUPTURA_ESTOQUE',
    'LOTE_VENCIMENTO',
    'LOTE_VENCIDO',
    'ATRASO_PEDIDO',
    'MARGEM_CRITICA',
    'QUALIDADE_RETIDA',
    'DIVERGENCIA_INVENTARIO',
    'SISTEMICO',
    'SOBRECARGA_EQUIPE'
  ));

-- ------------------------------------------------------------------------------
-- 9. FUNÇÃO AUXILIAR: CALCULAR MINUTOS DISPONÍVEIS DE UMA ESCALA ESPECÍFICA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._calcular_minutos_disponiveis_escala(
  p_escala_id BIGINT
)
RETURNS NUMERIC AS $$
DECLARE
  v_escala RECORD;
  v_minutos_brutos NUMERIC;
  v_minutos_intervalos NUMERIC;
  v_minutos_ausencias NUMERIC := 0;
  v_aus RECORD;
  v_intersecao_inicio TIME;
  v_intersecao_fim TIME;
BEGIN
  SELECT * INTO v_escala FROM public.escalas_equipe WHERE id = p_escala_id;
  IF NOT FOUND OR v_escala.status = 'CANCELADA' THEN
    RETURN 0;
  END IF;

  -- 1. Minutos brutos do turno
  v_minutos_brutos := EXTRACT(EPOCH FROM (v_escala.hora_fim - v_escala.hora_inicio)) / 60;

  -- 2. Intervalos: se houver escala_intervalos detalhados usa a soma, senão usa intervalo_minutos padrão
  SELECT COALESCE(SUM(duracao_minutos), v_escala.intervalo_minutos)
  INTO v_minutos_intervalos
  FROM public.escala_intervalos
  WHERE escala_id = p_escala_id;

  v_minutos_intervalos := COALESCE(v_minutos_intervalos, v_escala.intervalo_minutos, 0);

  -- 3. Ausências para este colaborador nesta data
  FOR v_aus IN
    SELECT hora_inicio, hora_fim
    FROM public.ausencias_equipe
    WHERE colaborador_id = v_escala.colaborador_id
      AND v_escala.data_escala BETWEEN data_inicio AND data_fim
  LOOP
    -- Se ausência integral do dia (sem hora definida), zera a escala (O6)
    IF v_aus.hora_inicio IS NULL AND v_aus.hora_fim IS NULL THEN
      RETURN 0;
    ELSE
      -- Ausência parcial: desconta apenas a interseção com o turno escalado (O7)
      v_intersecao_inicio := GREATEST(v_escala.hora_inicio, v_aus.hora_inicio);
      v_intersecao_fim := LEAST(v_escala.hora_fim, v_aus.hora_fim);
      IF v_intersecao_fim > v_intersecao_inicio THEN
        v_minutos_ausencias := v_minutos_ausencias + (EXTRACT(EPOCH FROM (v_intersecao_fim - v_intersecao_inicio)) / 60);
      END IF;
    END IF;
  END LOOP;

  RETURN GREATEST(0, v_minutos_brutos - v_minutos_intervalos - v_minutos_ausencias);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 10. RPC: SALVAR COLABORADOR (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_colaborador_admin(
  p_id BIGINT DEFAULT NULL,
  p_nome TEXT DEFAULT NULL,
  p_apelido TEXT DEFAULT NULL,
  p_telefone TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL,
  p_auth_user_id UUID DEFAULT NULL,
  p_ativo BOOLEAN DEFAULT true,
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_colab_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem cadastrar colaboradores.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_nome IS NULL OR trim(p_nome) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nome do colaborador é obrigatório.', 'code', 'INVALID_NAME');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.colaboradores (nome, apelido, telefone, email, auth_user_id, ativo, observacoes)
    VALUES (trim(p_nome), trim(p_apelido), trim(p_telefone), trim(p_email), p_auth_user_id, COALESCE(p_ativo, true), p_observacoes)
    RETURNING id INTO v_colab_id;
  ELSE
    UPDATE public.colaboradores
    SET nome = trim(p_nome),
        apelido = trim(p_apelido),
        telefone = trim(p_telefone),
        email = trim(p_email),
        auth_user_id = p_auth_user_id,
        ativo = COALESCE(p_ativo, true),
        observacoes = p_observacoes,
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_colab_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'colaborador_id', v_colab_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 11. RPC: SALVAR FUNÇÃO DE EQUIPE (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_funcao_equipe_admin(
  p_id BIGINT DEFAULT NULL,
  p_codigo TEXT DEFAULT NULL,
  p_nome TEXT DEFAULT NULL,
  p_descricao TEXT DEFAULT NULL,
  p_cor TEXT DEFAULT '#3b82f6',
  p_etapas_padrao TEXT[] DEFAULT '{}'::TEXT[],
  p_ativo BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_funcao_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem gerenciar funções da equipe.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_codigo IS NULL OR trim(p_codigo) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Código da função é obrigatório.', 'code', 'INVALID_CODE');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.funcoes_equipe (codigo, nome, descricao, cor_identificadora, etapas_padrao, ativo)
    VALUES (upper(trim(p_codigo)), trim(p_nome), p_descricao, COALESCE(p_cor, '#3b82f6'), COALESCE(p_etapas_padrao, '{}'::TEXT[]), COALESCE(p_ativo, true))
    RETURNING id INTO v_funcao_id;
  ELSE
    UPDATE public.funcoes_equipe
    SET codigo = upper(trim(p_codigo)),
        nome = trim(p_nome),
        descricao = p_descricao,
        cor_identificadora = COALESCE(p_cor, '#3b82f6'),
        etapas_padrao = COALESCE(p_etapas_padrao, '{}'::TEXT[]),
        ativo = COALESCE(p_ativo, true),
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_funcao_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'funcao_id', v_funcao_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 12. RPC: VINCULAR FUNÇÃO A COLABORADOR (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vincular_funcao_colaborador_admin(
  p_colaborador_id BIGINT,
  p_funcao_id BIGINT,
  p_principal BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem atribuir funções.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_principal THEN
    UPDATE public.colaborador_funcoes SET principal = false WHERE colaborador_id = p_colaborador_id;
  END IF;

  INSERT INTO public.colaborador_funcoes (colaborador_id, funcao_id, principal)
  VALUES (p_colaborador_id, p_funcao_id, COALESCE(p_principal, false))
  ON CONFLICT (colaborador_id, funcao_id)
  DO UPDATE SET principal = EXCLUDED.principal;

  RETURN jsonb_build_object('success', true, 'colaborador_id', p_colaborador_id, 'funcao_id', p_funcao_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 13. RPC: SALVAR TURNO DE TRABALHO (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_turno_admin(
  p_id BIGINT DEFAULT NULL,
  p_nome TEXT DEFAULT NULL,
  p_hora_inicio TIME DEFAULT NULL,
  p_hora_fim TIME DEFAULT NULL,
  p_intervalo_minutos INT DEFAULT 60,
  p_dias_semana INT[] DEFAULT '{1,2,3,4,5,6}'::INT[],
  p_ativo BOOLEAN DEFAULT true
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_turno_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem configurar turnos.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_hora_fim <= p_hora_inicio THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hora de término deve ser posterior à hora de início.', 'code', 'INVALID_HOURS');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.turnos_trabalho (nome, hora_inicio, hora_fim, intervalo_minutos, dias_semana, ativo)
    VALUES (trim(p_nome), p_hora_inicio, p_hora_fim, COALESCE(p_intervalo_minutos, 60), COALESCE(p_dias_semana, '{1,2,3,4,5,6}'::INT[]), COALESCE(p_ativo, true))
    RETURNING id INTO v_turno_id;
  ELSE
    UPDATE public.turnos_trabalho
    SET nome = trim(p_nome),
        hora_inicio = p_hora_inicio,
        hora_fim = p_hora_fim,
        intervalo_minutos = COALESCE(p_intervalo_minutos, 60),
        dias_semana = COALESCE(p_dias_semana, '{1,2,3,4,5,6}'::INT[]),
        ativo = COALESCE(p_ativo, true),
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_turno_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'turno_id', v_turno_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 14. RPC: SALVAR ESCALA DA EQUIPE (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salvar_escala_equipe_admin(
  p_id BIGINT DEFAULT NULL,
  p_colaborador_id BIGINT DEFAULT NULL,
  p_funcao_id BIGINT DEFAULT NULL,
  p_data_escala DATE DEFAULT NULL,
  p_hora_inicio TIME DEFAULT NULL,
  p_hora_fim TIME DEFAULT NULL,
  p_intervalo_minutos INT DEFAULT 60,
  p_turno_id BIGINT DEFAULT NULL,
  p_status TEXT DEFAULT 'CONFIRMADA',
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_escala_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem gerenciar escalas.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_hora_fim <= p_hora_inicio THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hora de término deve ser posterior à hora de início.', 'code', 'INVALID_HOURS');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.escalas_equipe (
      colaborador_id, funcao_id, data_escala, hora_inicio, hora_fim, intervalo_minutos, turno_id, status, observacoes
    ) VALUES (
      p_colaborador_id, p_funcao_id, p_data_escala, p_hora_inicio, p_hora_fim, COALESCE(p_intervalo_minutos, 60), p_turno_id, COALESCE(p_status, 'CONFIRMADA'), p_observacoes
    ) RETURNING id INTO v_escala_id;
  ELSE
    UPDATE public.escalas_equipe
    SET colaborador_id = p_colaborador_id,
        funcao_id = p_funcao_id,
        data_escala = p_data_escala,
        hora_inicio = p_hora_inicio,
        hora_fim = p_hora_fim,
        intervalo_minutos = COALESCE(p_intervalo_minutos, 60),
        turno_id = p_turno_id,
        status = COALESCE(p_status, 'CONFIRMADA'),
        observacoes = p_observacoes,
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_escala_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'escala_id', v_escala_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 15. RPC: REGISTRAR AUSÊNCIA / FOLGA / ATESTADO (ADMINISTRADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_ausencia_equipe_admin(
  p_id BIGINT DEFAULT NULL,
  p_colaborador_id BIGINT DEFAULT NULL,
  p_data_inicio DATE DEFAULT NULL,
  p_data_fim DATE DEFAULT NULL,
  p_hora_inicio TIME DEFAULT NULL,
  p_hora_fim TIME DEFAULT NULL,
  p_tipo TEXT DEFAULT 'FOLGA',
  p_motivo_geral TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_aus_id BIGINT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas administradores podem registrar ausências.', 'code', 'PERMISSION_DENIED');
  END IF;

  IF p_data_fim < p_data_inicio THEN
    RETURN jsonb_build_object('success', false, 'error', 'Data final não pode ser anterior à data inicial.', 'code', 'INVALID_DATES');
  END IF;

  IF p_hora_inicio IS NOT NULL AND p_hora_fim IS NOT NULL AND p_hora_fim <= p_hora_inicio THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hora final deve ser posterior à inicial em ausência parcial.', 'code', 'INVALID_HOURS');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.ausencias_equipe (
      colaborador_id, data_inicio, data_fim, hora_inicio, hora_fim, tipo, motivo_geral, aprovado_por
    ) VALUES (
      p_colaborador_id, p_data_inicio, p_data_fim, p_hora_inicio, p_hora_fim, p_tipo, p_motivo_geral, v_caller_id
    ) RETURNING id INTO v_aus_id;
  ELSE
    UPDATE public.ausencias_equipe
    SET colaborador_id = p_colaborador_id,
        data_inicio = p_data_inicio,
        data_fim = p_data_fim,
        hora_inicio = p_hora_inicio,
        hora_fim = p_hora_fim,
        tipo = p_tipo,
        motivo_geral = p_motivo_geral,
        aprovado_por = v_caller_id,
        updated_at = NOW()
    WHERE id = p_id
    RETURNING id INTO v_aus_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'ausencia_id', v_aus_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 16. RPC: OBTER ESCALA POR PERÍODO (ADMIN E OPERADOR)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_escala_periodo(
  p_data_inicio DATE,
  p_data_fim DATE,
  p_funcao_id BIGINT DEFAULT NULL,
  p_colaborador_id BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_escalas JSONB := '[]'::jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'colaborador_id', e.colaborador_id,
      'colaborador_nome', c.nome,
      'colaborador_apelido', c.apelido,
      'funcao_id', e.funcao_id,
      'funcao_nome', f.nome,
      'funcao_cor', f.cor_identificadora,
      'data_escala', e.data_escala,
      'hora_inicio', e.hora_inicio,
      'hora_fim', e.hora_fim,
      'intervalo_minutos', e.intervalo_minutos,
      'minutos_disponiveis', public._calcular_minutos_disponiveis_escala(e.id),
      'status', e.status,
      'observacoes', e.observacoes
    ) ORDER BY e.data_escala, e.hora_inicio, c.nome
  ) INTO v_escalas
  FROM public.escalas_equipe e
  JOIN public.colaboradores c ON c.id = e.colaborador_id
  JOIN public.funcoes_equipe f ON f.id = e.funcao_id
  WHERE e.data_escala BETWEEN p_data_inicio AND p_data_fim
    AND (p_funcao_id IS NULL OR e.funcao_id = p_funcao_id)
    AND (p_colaborador_id IS NULL OR e.colaborador_id = p_colaborador_id);

  RETURN jsonb_build_object(
    'success', true,
    'data_inicio', p_data_inicio,
    'data_fim', p_data_fim,
    'escalas', COALESCE(v_escalas, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 17. RPC: OBTER CAPACIDADE HUMANA PLANEJADA DE UMA DATA ESPECÍFICA
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_capacidade_humana_data(
  p_data DATE
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_funcoes JSONB := '[]'::jsonb;
  v_total_minutos NUMERIC := 0;
  v_total_colaboradores INT := 0;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  WITH capacidade_por_escala AS (
    SELECT
      e.id AS escala_id,
      e.funcao_id,
      f.codigo AS funcao_codigo,
      f.nome AS funcao_nome,
      f.cor_identificadora AS funcao_cor,
      e.colaborador_id,
      public._calcular_minutos_disponiveis_escala(e.id) AS minutos_disponiveis
    FROM public.escalas_equipe e
    JOIN public.funcoes_equipe f ON f.id = e.funcao_id
    WHERE e.data_escala = p_data
      AND e.status != 'CANCELADA'
  ),
  agrupado_por_funcao AS (
    SELECT
      funcao_id,
      funcao_codigo,
      funcao_nome,
      funcao_cor,
      COUNT(DISTINCT colaborador_id) AS total_colaboradores,
      COALESCE(SUM(minutos_disponiveis), 0) AS total_minutos_disponiveis
    FROM capacidade_por_escala
    GROUP BY funcao_id, funcao_codigo, funcao_nome, funcao_cor
  )
  SELECT
    COALESCE(SUM(total_minutos_disponiveis), 0),
    COALESCE(SUM(total_colaboradores), 0),
    jsonb_agg(
      jsonb_build_object(
        'funcao_id', funcao_id,
        'codigo', funcao_codigo,
        'nome', funcao_nome,
        'cor', funcao_cor,
        'colaboradores_escalados', total_colaboradores,
        'minutos_disponiveis', total_minutos_disponiveis,
        'horas_disponiveis', round(total_minutos_disponiveis / 60.0, 2)
      ) ORDER BY funcao_nome
    )
  INTO v_total_minutos, v_total_colaboradores, v_funcoes
  FROM agrupado_por_funcao;

  RETURN jsonb_build_object(
    'success', true,
    'data', p_data,
    'total_minutos_disponiveis', v_total_minutos,
    'total_horas_disponiveis', round(v_total_minutos / 60.0, 2),
    'total_colaboradores_escalados', v_total_colaboradores,
    'funcoes', COALESCE(v_funcoes, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 18. RPC: OBTER CARGA E DEMANDA DE PRODUÇÃO POR FUNÇÃO EM UMA DATA
-- ------------------------------------------------------------------------------
-- Cruza pedidos ativos agendados (Frente E) com tempos padrão (Frente M) e funcoes_equipe (Frente O)
CREATE OR REPLACE FUNCTION public.obter_carga_equipe_data(
  p_data DATE
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_demanda_funcoes JSONB := '[]'::jsonb;
  v_total_minutos_demanda NUMERIC := 0;
  v_total_pedidos INT := 0;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  WITH pedidos_do_dia AS (
    SELECT id AS pedido_id
    FROM public.pedidos
    WHERE data_entrega = p_data
      AND status_comercial NOT IN ('cancelado') -- O12: pedido cancelado não gera demanda
      AND status_operacional IN ('aguardando_producao', 'em_producao', 'pronto')
  ),
  itens_expandidos AS (
    SELECT
      pi.pedido_id,
      pi.produto_id,
      pi.quantidade,
      pt.etapa,
      pt.minutos_padrao,
      (pi.quantidade * pt.minutos_padrao) AS minutos_item_etapa
    FROM pedidos_do_dia pd
    JOIN public.pedido_itens pi ON pi.pedido_id = pd.pedido_id
    JOIN public.produto_tempos_producao pt ON pt.produto_id = pi.produto_id
  ),
  etapas_mapeadas AS (
    SELECT
      ie.pedido_id,
      ie.minutos_item_etapa,
      -- Mapeia a etapa para a função correspondente
      COALESCE(
        (SELECT id FROM public.funcoes_equipe f WHERE ie.etapa = ANY(f.etapas_padrao) AND f.ativo = true LIMIT 1),
        (SELECT id FROM public.funcoes_equipe WHERE codigo = 'CONFEITARIA' LIMIT 1)
      ) AS funcao_id
    FROM itens_expandidos ie
  ),
  demanda_agrupada AS (
    SELECT
      em.funcao_id,
      f.codigo AS funcao_codigo,
      f.nome AS funcao_nome,
      f.cor_identificadora AS funcao_cor,
      COUNT(DISTINCT em.pedido_id) AS pedidos_envolvidos,
      COALESCE(SUM(em.minutos_item_etapa), 0) AS minutos_demandados
    FROM etapas_mapeadas em
    JOIN public.funcoes_equipe f ON f.id = em.funcao_id
    GROUP BY em.funcao_id, f.codigo, f.nome, f.cor_identificadora
  )
  SELECT
    COALESCE(SUM(minutos_demandados), 0),
    (SELECT COUNT(*) FROM pedidos_do_dia),
    jsonb_agg(
      jsonb_build_object(
        'funcao_id', funcao_id,
        'codigo', funcao_codigo,
        'nome', funcao_nome,
        'cor', funcao_cor,
        'pedidos_envolvidos', pedidos_envolvidos,
        'minutos_demandados', minutos_demandados,
        'horas_demandadas', round(minutos_demandados / 60.0, 2)
      ) ORDER BY funcao_nome
    )
  INTO v_total_minutos_demanda, v_total_pedidos, v_demanda_funcoes
  FROM demanda_agrupada;

  RETURN jsonb_build_object(
    'success', true,
    'data', p_data,
    'total_pedidos', v_total_pedidos,
    'total_minutos_demandados', v_total_minutos_demanda,
    'total_horas_demandadas', round(v_total_minutos_demanda / 60.0, 2),
    'demanda_por_funcao', COALESCE(v_demanda_funcoes, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 19. RPC: PAINEL CONSOLIDADO DE CAPACIDADE HUMANA X CARGA DO PERÍODO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_painel_capacidade_equipe(
  p_data_inicio DATE DEFAULT CURRENT_DATE,
  p_data_fim DATE DEFAULT CURRENT_DATE + 6
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_dias JSONB := '[]'::jsonb;
  v_cur_data DATE;
  v_cap JSONB;
  v_dem JSONB;
  v_funcoes_dia JSONB;
  v_cfg RECORD;
  v_gargalo_dia TEXT;
  v_max_utilizacao NUMERIC;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Usuário não autenticado.', 'code', 'UNAUTHENTICATED');
  END IF;

  SELECT * INTO v_cfg FROM public.equipe_configuracoes WHERE id = 1;

  v_cur_data := p_data_inicio;
  WHILE v_cur_data <= p_data_fim LOOP
    v_cap := public.obter_capacidade_humana_data(v_cur_data);
    v_dem := public.obter_carga_equipe_data(v_cur_data);

    -- Cruzamento de capacidade x demanda por função
    WITH funcoes_todas AS (
      SELECT id AS funcao_id, codigo, nome, cor_identificadora AS cor FROM public.funcoes_equipe WHERE ativo = true
    ),
    cruzamento AS (
      SELECT
        ft.funcao_id,
        ft.codigo,
        ft.nome,
        ft.cor,
        COALESCE((
          SELECT (c->>'minutos_disponiveis')::NUMERIC
          FROM jsonb_array_elements(v_cap->'funcoes') c
          WHERE (c->>'funcao_id')::BIGINT = ft.funcao_id
        ), 0.0) AS minutos_capacidade,
        COALESCE((
          SELECT (d->>'minutos_demandados')::NUMERIC
          FROM jsonb_array_elements(v_dem->'demanda_por_funcao') d
          WHERE (d->>'funcao_id')::BIGINT = ft.funcao_id
        ), 0.0) AS minutos_demanda
      FROM funcoes_todas ft
    )
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'funcao_id', funcao_id,
          'codigo', codigo,
          'nome', nome,
          'cor', cor,
          'minutos_capacidade', minutos_capacidade,
          'minutos_demanda', minutos_demanda,
          'saldo_minutos', (minutos_capacidade - minutos_demanda),
          'percentual_utilizacao', CASE
            WHEN minutos_capacidade > 0 THEN round((minutos_demanda / minutos_capacidade) * 100.0, 1)
            WHEN minutos_demanda > 0 THEN 999.9
            ELSE 0.0
          END,
          'status', CASE
            WHEN minutos_capacidade = 0 AND minutos_demanda > 0 THEN 'SEM_ESCALA'
            WHEN minutos_capacidade = 0 THEN 'VAZIO'
            WHEN (minutos_demanda / minutos_capacidade) * 100.0 >= v_cfg.percentual_alerta_critico THEN 'CRITICO'
            WHEN (minutos_demanda / minutos_capacidade) * 100.0 >= v_cfg.percentual_alerta_alto THEN 'SOBRECARGA'
            WHEN (minutos_demanda / minutos_capacidade) * 100.0 >= v_cfg.percentual_alerta_atencao THEN 'ATENCAO'
            ELSE 'CONFORTAVEL'
          END
        ) ORDER BY nome
      )
    INTO v_funcoes_dia
    FROM cruzamento;

    -- Identifica o maior gargalo do dia
    SELECT
      f->>'nome',
      (f->>'percentual_utilizacao')::NUMERIC
    INTO v_gargalo_dia, v_max_utilizacao
    FROM jsonb_array_elements(v_funcoes_dia) f
    WHERE (f->>'minutos_demanda')::NUMERIC > 0
    ORDER BY (f->>'percentual_utilizacao')::NUMERIC DESC
    LIMIT 1;

    v_dias := v_dias || jsonb_build_array(jsonb_build_object(
      'data', v_cur_data,
      'dia_semana', to_char(v_cur_data, 'Dy'),
      'total_pedidos', (v_dem->>'total_pedidos')::INT,
      'total_minutos_capacidade', (v_cap->>'total_minutos_disponiveis')::NUMERIC,
      'total_minutos_demanda', (v_dem->>'total_minutos_demandados')::NUMERIC,
      'percentual_utilizacao_geral', CASE
        WHEN (v_cap->>'total_minutos_disponiveis')::NUMERIC > 0 THEN
          round(((v_dem->>'total_minutos_demandados')::NUMERIC / (v_cap->>'total_minutos_disponiveis')::NUMERIC) * 100.0, 1)
        ELSE 0.0
      END,
      'gargalo', v_gargalo_dia,
      'maior_utilizacao', COALESCE(v_max_utilizacao, 0),
      'funcoes', v_funcoes_dia
    ));

    v_cur_data := v_cur_data + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'data_inicio', p_data_inicio,
    'data_fim', p_data_fim,
    'dias', v_dias
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

-- ------------------------------------------------------------------------------
-- 20. EVOLUÇÃO FORWARD-ONLY DA DETECÇÃO PROATIVA (SOBRECARGA_EQUIPE)
-- ------------------------------------------------------------------------------
-- Sobrescreve a função da Frente N para incluir a detecção autônoma de sobrecarga de equipe
CREATE OR REPLACE FUNCTION public.processar_alertas_operacionais()
RETURNS JSONB AS $$
DECLARE
  v_cfg RECORD;
  v_eq_cfg RECORD;
  v_resolvidos INT := 0;
  v_total_ativos INT := 0;
  v_cur_data DATE;
  v_fim_data DATE;
  v_painel JSONB;
  v_dia JSONB;
  v_func JSONB;
  v_utilizacao NUMERIC;
BEGIN
  -- Obter configurações gerais de alertas
  SELECT * INTO v_cfg FROM public.alertas_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_cfg.dias_aviso_validade := 7;
    v_cfg.margem_minima_alvo := 30.00;
    v_cfg.antecedencia_atraso_minutos := 120;
    v_cfg.ativo := true;
  END IF;

  -- Obter configurações de equipe
  SELECT * INTO v_eq_cfg FROM public.equipe_configuracoes WHERE id = 1;
  IF NOT FOUND THEN
    v_eq_cfg.percentual_alerta_atencao := 80.00;
    v_eq_cfg.percentual_alerta_alto := 100.00;
    v_eq_cfg.percentual_alerta_critico := 120.00;
    v_eq_cfg.dias_antecedencia_analise := 7;
  END IF;

  -- 1. Detecção: RUPTURA_ESTOQUE
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

  -- 2. Detecção: LOTE_VENCIDO
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

  -- 3. Detecção: LOTE_VENCIMENTO
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

  -- 4. Detecção: ATRASO_PEDIDO
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

  -- 5. Detecção: MARGEM_CRITICA
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

  -- 6. Detecção: QUALIDADE_RETIDA
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

  -- 7. DETECÇÃO PROATIVA FRENTE O: SOBRECARGA_EQUIPE (O13)
  v_cur_data := CURRENT_DATE;
  v_fim_data := CURRENT_DATE + v_eq_cfg.dias_antecedencia_analise;
  v_painel := public.obter_painel_capacidade_equipe(v_cur_data, v_fim_data);

  FOR v_dia IN SELECT * FROM jsonb_array_elements(v_painel->'dias')
  LOOP
    FOR v_func IN SELECT * FROM jsonb_array_elements(v_dia->'funcoes')
    LOOP
      v_utilizacao := (v_func->>'percentual_utilizacao')::NUMERIC;
      IF v_utilizacao >= v_eq_cfg.percentual_alerta_atencao THEN
        INSERT INTO public.alertas_operacionais (
          tipo_alerta, nivel, origem_tabela, origem_id, titulo, descricao, dados_contexto, status
        ) VALUES (
          'SOBRECARGA_EQUIPE',
          CASE
            WHEN v_utilizacao >= v_eq_cfg.percentual_alerta_critico THEN 'CRITICO'
            WHEN v_utilizacao >= v_eq_cfg.percentual_alerta_alto THEN 'ATENCAO'
            ELSE 'OPERACIONAL'
          END,
          'escalas_equipe',
          (v_dia->>'data') || '_' || (v_func->>'funcao_id'),
          'Sobrecarga Prevista: ' || (v_func->>'nome') || ' em ' || to_char((v_dia->>'data')::DATE, 'DD/MM'),
          'Demanda de ' || (v_func->>'minutos_demanda') || ' min para capacidade de ' || (v_func->>'minutos_capacidade') || ' min (' || v_utilizacao || '% de utilização).',
          jsonb_build_object(
            'data', (v_dia->>'data'),
            'funcao_id', (v_func->>'funcao_id'),
            'funcao_nome', (v_func->>'nome'),
            'minutos_capacidade', (v_func->>'minutos_capacidade'),
            'minutos_demanda', (v_func->>'minutos_demanda'),
            'percentual_utilizacao', v_utilizacao
          ),
          'ATIVO'
        )
        ON CONFLICT (tipo_alerta, origem_tabela, origem_id)
        DO UPDATE SET
          nivel = EXCLUDED.nivel,
          descricao = EXCLUDED.descricao,
          dados_contexto = EXCLUDED.dados_contexto,
          status = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN 'ATIVO' ELSE public.alertas_operacionais.status END,
          resolvido_em = CASE WHEN public.alertas_operacionais.status = 'RESOLVIDO' THEN NULL ELSE public.alertas_operacionais.resolvido_em END,
          atualizado_em = NOW();
      ELSE
        -- Auto-resolução se a sobrecarga cessou
        UPDATE public.alertas_operacionais
        SET status = 'RESOLVIDO', resolvido_em = NOW()
        WHERE tipo_alerta = 'SOBRECARGA_EQUIPE'
          AND origem_id = (v_dia->>'data') || '_' || (v_func->>'funcao_id')
          AND status IN ('ATIVO', 'RECONHECIDO');
      END IF;
    END LOOP;
  END LOOP;

  -- RESOLUÇÃO AUTOMÁTICA GERAL (Frentes Anteriores)
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

  -- 3) Pedidos atrasados entregues ou cancelados
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

  -- 4) Qualidade retida liberada
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

-- ------------------------------------------------------------------------------
-- 21. SEGURANÇA (RLS & GRANTS FAIL-CLOSED)
-- ------------------------------------------------------------------------------
ALTER TABLE public.funcoes_equipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.colaboradores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.colaborador_funcoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turnos_trabalho ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalas_equipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escala_intervalos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ausencias_equipe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipe_configuracoes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.funcoes_equipe FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.colaboradores FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.colaborador_funcoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.turnos_trabalho FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.escalas_equipe FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.escala_intervalos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ausencias_equipe FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.equipe_configuracoes FROM PUBLIC, anon, authenticated;

-- Políticas de Leitura para Usuários Autenticados (Admin e Operadores autorizados)
DROP POLICY IF EXISTS funcoes_equipe_select ON public.funcoes_equipe;
CREATE POLICY funcoes_equipe_select ON public.funcoes_equipe FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS colaboradores_select ON public.colaboradores;
CREATE POLICY colaboradores_select ON public.colaboradores FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS colaborador_funcoes_select ON public.colaborador_funcoes;
CREATE POLICY colaborador_funcoes_select ON public.colaborador_funcoes FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS turnos_trabalho_select ON public.turnos_trabalho;
CREATE POLICY turnos_trabalho_select ON public.turnos_trabalho FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS escalas_equipe_select ON public.escalas_equipe;
CREATE POLICY escalas_equipe_select ON public.escalas_equipe FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS escala_intervalos_select ON public.escala_intervalos;
CREATE POLICY escala_intervalos_select ON public.escala_intervalos FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ausencias_equipe_select ON public.ausencias_equipe;
CREATE POLICY ausencias_equipe_select ON public.ausencias_equipe FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS equipe_configuracoes_select ON public.equipe_configuracoes;
CREATE POLICY equipe_configuracoes_select ON public.equipe_configuracoes FOR SELECT TO authenticated USING (true);

-- Permissões Totais para service_role
DROP POLICY IF EXISTS funcoes_equipe_service_role ON public.funcoes_equipe;
CREATE POLICY funcoes_equipe_service_role ON public.funcoes_equipe FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS colaboradores_service_role ON public.colaboradores;
CREATE POLICY colaboradores_service_role ON public.colaboradores FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS colaborador_funcoes_service_role ON public.colaborador_funcoes;
CREATE POLICY colaborador_funcoes_service_role ON public.colaborador_funcoes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS turnos_trabalho_service_role ON public.turnos_trabalho;
CREATE POLICY turnos_trabalho_service_role ON public.turnos_trabalho FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS escalas_equipe_service_role ON public.escalas_equipe;
CREATE POLICY escalas_equipe_service_role ON public.escalas_equipe FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS escala_intervalos_service_role ON public.escala_intervalos;
CREATE POLICY escala_intervalos_service_role ON public.escala_intervalos FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ausencias_equipe_service_role ON public.ausencias_equipe;
CREATE POLICY ausencias_equipe_service_role ON public.ausencias_equipe FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS equipe_configuracoes_service_role ON public.equipe_configuracoes;
CREATE POLICY equipe_configuracoes_service_role ON public.equipe_configuracoes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grants de Execução das RPCs (O15: anon e clientes não acessam)
REVOKE ALL ON FUNCTION public.salvar_colaborador_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_colaborador_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.salvar_funcao_equipe_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_funcao_equipe_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.vincular_funcao_colaborador_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vincular_funcao_colaborador_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.salvar_turno_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_turno_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.salvar_escala_equipe_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salvar_escala_equipe_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.registrar_ausencia_equipe_admin FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_ausencia_equipe_admin TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_escala_periodo FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_escala_periodo TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_capacidade_humana_data FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_capacidade_humana_data TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_carga_equipe_data FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_carga_equipe_data TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.obter_painel_capacidade_equipe FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_capacidade_equipe TO authenticated, service_role;
