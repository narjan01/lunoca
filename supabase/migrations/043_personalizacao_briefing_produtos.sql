-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 043: PERSONALIZAÇÃO DE PRODUTOS & BRIEFING VISUAL
-- ==============================================================================
-- Princípios Arquiteturais (Frente 043):
-- 1. Segregação Conceitual:
--    - Opções Comerciais (preço, massa, recheio, CMV) permanecem em produto_opcoes.
--    - Briefing de Personalização (tema, cores, fotos, descrição, nome, idade)
--      é gerenciado de forma desacoplada sem alterar colunas físicas nas tabelas centrais.
-- 2. Snapshot Histórico Imutável:
--    - As respostas do cliente são congeladas em pedido_item_personalizacoes no
--      momento da compra. Alterações posteriores no catálogo não afetam pedidos antigos.
-- 3. Storage Privado & Sanitizado:
--    - Fotos e referências visuais residem no bucket privado 'pedido-referencias'
--      (max 10MB por arquivo, JPEG/PNG/WebP), com metadados auditados no PostgreSQL.
-- 4. Ciclo de Vida do Briefing:
--    - Suporte a produtos com requer_aprovacao_personalizacao = true (PENDENTE_REVISAO -> APROVADO).
--    - KDS exibe o briefing completo da unidade de produção com fotos e paleta de cores.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. ATRIBUTO DE REVISÃO HUMANA NO CATÁLOGO DE PRODUTOS
-- ------------------------------------------------------------------------------
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS requer_aprovacao_personalizacao BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------------------------
-- 2. TABELA: PRODUTO_CAMPOS_PERSONALIZACAO (CONFIGURAÇÃO NO CATÁLOGO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.produto_campos_personalizacao (
  id BIGSERIAL PRIMARY KEY,
  produto_id BIGINT NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  codigo VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('TEXTO', 'TEXTO_LONGO', 'COR', 'CORES_MULTIPLAS', 'SELECT', 'MULTISELECT', 'NUMERO', 'DATA', 'IMAGEM', 'IMAGENS')),
  obrigatorio BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 1 CHECK (ordem > 0),
  placeholder TEXT,
  texto_ajuda TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_prod_campo_codigo UNIQUE (produto_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_prod_campos_lookup 
  ON public.produto_campos_personalizacao (produto_id, ativo, ordem);

-- ------------------------------------------------------------------------------
-- 3. TABELA: PEDIDO_ITEM_PERSONALIZACOES (SNAPSHOT HISTÓRICO DO BRIEFING)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_item_personalizacoes (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  campo_id BIGINT REFERENCES public.produto_campos_personalizacao(id) ON DELETE SET NULL,
  codigo_snapshot VARCHAR(50) NOT NULL,
  label_snapshot VARCHAR(100) NOT NULL,
  tipo_snapshot VARCHAR(30) NOT NULL,
  valor_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  ordem_snapshot INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_personalizacoes_item 
  ON public.pedido_item_personalizacoes (pedido_item_id);

CREATE INDEX IF NOT EXISTS idx_item_personalizacoes_pedido 
  ON public.pedido_item_personalizacoes (pedido_id);

-- ------------------------------------------------------------------------------
-- 4. TABELA: PEDIDO_ITEM_PERSONALIZACAO_ARQUIVOS (METADADOS DE ANEXOS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_item_personalizacao_arquivos (
  id BIGSERIAL PRIMARY KEY,
  pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  personalizacao_id BIGINT NOT NULL REFERENCES public.pedido_item_personalizacoes(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  tamanho_bytes BIGINT NOT NULL CHECK (tamanho_bytes > 0),
  sha256 VARCHAR(64),
  nome_original TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_arquivos_personalizacao 
  ON public.pedido_item_personalizacao_arquivos (personalizacao_id);

-- ------------------------------------------------------------------------------
-- 5. CICLO DE VIDA DO BRIEFING EM PEDIDO_ITENS E KDS
-- ------------------------------------------------------------------------------
ALTER TABLE public.pedido_itens
  ADD COLUMN IF NOT EXISTS briefing_status VARCHAR(30) NOT NULL DEFAULT 'DISPENSADO'
    CHECK (briefing_status IN ('DISPENSADO', 'PENDENTE_REVISAO', 'APROVADO', 'REJEITADO')),
  ADD COLUMN IF NOT EXISTS briefing_revisado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS briefing_revisado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS briefing_motivo_rejeicao TEXT;

ALTER TABLE public.pedido_item_producao_kds
  ADD COLUMN IF NOT EXISTS briefing_status VARCHAR(30) NOT NULL DEFAULT 'DISPENSADO'
    CHECK (briefing_status IN ('DISPENSADO', 'PENDENTE_REVISAO', 'APROVADO', 'REJEITADO'));

-- ------------------------------------------------------------------------------
-- 6. TABELA: PEDIDO_ITEM_PERSONALIZACAO_HISTORICO (AUDITORIA DE ALTERAÇÃO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedido_item_personalizacao_historico (
  id BIGSERIAL PRIMARY KEY,
  pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id) ON DELETE CASCADE,
  personalizacao_id BIGINT REFERENCES public.pedido_item_personalizacoes(id) ON DELETE SET NULL,
  campo_codigo VARCHAR(50) NOT NULL,
  valor_anterior JSONB,
  valor_novo JSONB NOT NULL,
  motivo TEXT NOT NULL,
  alterado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  alterado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personalizacao_hist_item 
  ON public.pedido_item_personalizacao_historico (pedido_item_id);

-- ------------------------------------------------------------------------------
-- 7. BUCKET PRIVADO NO SUPABASE STORAGE
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'pedido-referencias') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'pedido-referencias',
      'pedido-referencias',
      false,
      10485760, -- 10MB
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    );
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 8. POLÍTICAS ROW LEVEL SECURITY (RLS FAIL-CLOSED)
-- ------------------------------------------------------------------------------
ALTER TABLE public.produto_campos_personalizacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_item_personalizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_item_personalizacao_arquivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_item_personalizacao_historico ENABLE ROW LEVEL SECURITY;

-- 8.1. produto_campos_personalizacao
DROP POLICY IF EXISTS p_campos_select ON public.produto_campos_personalizacao;
CREATE POLICY p_campos_select ON public.produto_campos_personalizacao
  FOR SELECT TO PUBLIC, anon, authenticated
  USING (ativo = true OR public.is_admin_or_operator());

DROP POLICY IF EXISTS p_campos_admin_all ON public.produto_campos_personalizacao;
CREATE POLICY p_campos_admin_all ON public.produto_campos_personalizacao
  FOR ALL TO authenticated, service_role
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 8.2. pedido_item_personalizacoes
DROP POLICY IF EXISTS p_item_personalizacoes_select ON public.pedido_item_personalizacoes;
CREATE POLICY p_item_personalizacoes_select ON public.pedido_item_personalizacoes
  FOR SELECT TO authenticated, service_role
  USING (
    public.is_admin_or_operator() OR
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_item_personalizacoes.pedido_id
        AND p.cliente_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS p_item_personalizacoes_service ON public.pedido_item_personalizacoes;
CREATE POLICY p_item_personalizacoes_service ON public.pedido_item_personalizacoes
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 8.3. pedido_item_personalizacao_arquivos
DROP POLICY IF EXISTS p_item_arquivos_select ON public.pedido_item_personalizacao_arquivos;
CREATE POLICY p_item_arquivos_select ON public.pedido_item_personalizacao_arquivos
  FOR SELECT TO authenticated, service_role
  USING (
    public.is_admin_or_operator() OR
    EXISTS (
      SELECT 1 FROM public.pedidos p
      WHERE p.id = pedido_item_personalizacao_arquivos.pedido_id
        AND p.cliente_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS p_item_arquivos_service ON public.pedido_item_personalizacao_arquivos;
CREATE POLICY p_item_arquivos_service ON public.pedido_item_personalizacao_arquivos
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 8.4. Storage policies para pedido-referencias
DROP POLICY IF EXISTS "Leitura de Referencias por Dono ou Equipe" ON storage.objects;
CREATE POLICY "Leitura de Referencias por Dono ou Equipe" ON storage.objects
  FOR SELECT TO authenticated, service_role
  USING (
    bucket_id = 'pedido-referencias' AND
    (
      public.is_admin_or_operator() OR
      EXISTS (
        SELECT 1 FROM public.pedido_item_personalizacao_arquivos a
        JOIN public.pedidos p ON p.id = a.pedido_id
        WHERE a.storage_path = storage.objects.name
          AND p.cliente_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Upload de Referencias no Checkout" ON storage.objects;
CREATE POLICY "Upload de Referencias no Checkout" ON storage.objects
  FOR INSERT TO PUBLIC, anon, authenticated
  WITH CHECK (
    bucket_id = 'pedido-referencias'
  );

-- ------------------------------------------------------------------------------
-- 9. RPC: OBTER_PERSONALIZACAO_PRODUTO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_personalizacao_produto(
  p_produto_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_prod RECORD;
  v_campos JSONB := '[]'::jsonb;
BEGIN
  SELECT id, nome, requer_aprovacao_personalizacao
  INTO v_prod
  FROM public.produtos
  WHERE id = p_produto_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'PRODUTO_NAO_ENCONTRADO');
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'codigo', c.codigo,
      'label', c.label,
      'tipo', c.tipo,
      'obrigatorio', c.obrigatorio,
      'ordem', c.ordem,
      'placeholder', c.placeholder,
      'texto_ajuda', c.texto_ajuda,
      'config', c.config_json
    ) ORDER BY c.ordem ASC, c.id ASC
  ) INTO v_campos
  FROM public.produto_campos_personalizacao c
  WHERE c.produto_id = p_produto_id AND c.ativo = true;

  RETURN jsonb_build_object(
    'success', true,
    'produto_id', p_produto_id,
    'nome', v_prod.nome,
    'requer_aprovacao', v_prod.requer_aprovacao_personalizacao,
    'tem_personalizacao', (v_campos IS NOT NULL AND jsonb_array_length(v_campos) > 0),
    'campos', COALESCE(v_campos, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_personalizacao_produto(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_personalizacao_produto(BIGINT) TO PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 10. RPC: VALIDAR_PERSONALIZACAO_PRODUTO (VALIDAÇÃO SERVER-SIDE ESTREITA)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validar_personalizacao_produto(
  p_produto_id BIGINT,
  p_respostas JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_campo RECORD;
  v_resp JSONB;
  v_val TEXT;
  v_val_json JSONB;
  v_count INT;
  v_max_itens INT;
BEGIN
  -- Percorre todos os campos ativos configurados para o produto
  FOR v_campo IN
    SELECT *
    FROM public.produto_campos_personalizacao
    WHERE produto_id = p_produto_id AND ativo = true
    ORDER BY ordem ASC
  LOOP
    -- Busca resposta correspondente ao código do campo
    v_resp := p_respostas->(v_campo.codigo);

    -- 1. Validação de obrigatoriedade (PERS2)
    IF v_campo.obrigatorio THEN
      IF v_resp IS NULL 
         OR (jsonb_typeof(v_resp) = 'string' AND btrim(v_resp#>>'{}') = '') 
         OR (jsonb_typeof(v_resp) = 'array' AND jsonb_array_length(v_resp) = 0) THEN
        RETURN jsonb_build_object(
          'valido', false,
          'erro', 'CAMPO_OBRIGATORIO_AUSENTE',
          'campo_codigo', v_campo.codigo,
          'campo_label', v_campo.label,
          'mensagem', 'O campo "' || v_campo.label || '" é obrigatório.'
        );
      END IF;
    END IF;

    -- Se resposta presente, valida tipo e regras de restrição (PERS3)
    IF v_resp IS NOT NULL AND jsonb_typeof(v_resp) <> 'null' THEN
      CASE v_campo.tipo
        WHEN 'NUMERO' THEN
          v_val := v_resp#>>'{}';
          IF v_val !~ '^-?\d+(\.\d+)?$' THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'TIPO_NUMERO_INVALIDO',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'O valor do campo "' || v_campo.label || '" deve ser numérico.'
            );
          END IF;

        WHEN 'COR' THEN
          v_val := v_resp#>>'{}';
          IF v_val !~* '^#([0-9a-f]{3}|[0-9a-f]{6})$' AND length(v_val) > 50 THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'COR_INVALIDA',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'Formato de cor inválido no campo "' || v_campo.label || '".'
            );
          END IF;

        WHEN 'CORES_MULTIPLAS' THEN
          IF jsonb_typeof(v_resp) <> 'array' THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'CORES_MULTIPLAS_ESPERA_ARRAY',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'O campo "' || v_campo.label || '" deve ser uma lista de cores.'
            );
          END IF;
          v_max_itens := COALESCE((v_campo.config_json->>'max_cores')::INT, 10);
          IF jsonb_array_length(v_resp) > v_max_itens THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'MAX_CORES_EXCEDIDO',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'Você pode selecionar no máximo ' || v_max_itens || ' cores em "' || v_campo.label || '".'
            );
          END IF;

        WHEN 'IMAGENS' THEN
          IF jsonb_typeof(v_resp) <> 'array' THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'IMAGENS_ESPERA_ARRAY',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'O campo "' || v_campo.label || '" deve ser uma lista de imagens.'
            );
          END IF;
          v_max_itens := COALESCE((v_campo.config_json->>'max_imagens')::INT, 5);
          IF jsonb_array_length(v_resp) > v_max_itens THEN
            RETURN jsonb_build_object(
              'valido', false,
              'erro', 'MAX_IMAGENS_EXCEDIDO',
              'campo_codigo', v_campo.codigo,
              'mensagem', 'Você pode anexar no máximo ' || v_max_itens || ' fotos em "' || v_campo.label || '".'
            );
          END IF;

        WHEN 'SELECT' THEN
          v_val := v_resp#>>'{}';
          IF v_campo.config_json->'opcoes' IS NOT NULL AND jsonb_typeof(v_campo.config_json->'opcoes') = 'array' THEN
            IF NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(v_campo.config_json->'opcoes') opt
              WHERE lower(trim(opt)) = lower(trim(v_val))
            ) THEN
              RETURN jsonb_build_object(
                'valido', false,
                'erro', 'VALOR_SELECT_INVALIDO',
                'campo_codigo', v_campo.codigo,
                'mensagem', 'A opção selecionada em "' || v_campo.label || '" não é permitida.'
              );
            END IF;
          END IF;

        ELSE
          -- TEXTO / TEXTO_LONGO / DATA
          NULL;
      END CASE;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('valido', true);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.validar_personalizacao_produto(BIGINT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validar_personalizacao_produto(BIGINT, JSONB) TO PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 11. RPC: OBTER_BRIEFING_ITEM (VISUALIZAÇÃO COMPLETA PARA KDS & ADMIN)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_briefing_item(
  p_pedido_item_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_item RECORD;
  v_personalizacoes JSONB := '[]'::jsonb;
  v_arquivos JSONB := '[]'::jsonb;
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    -- Se for cliente, valida se é o dono do pedido
    IF NOT EXISTS (
      SELECT 1 FROM public.pedido_itens pi
      JOIN public.pedidos p ON p.id = pi.pedido_id
      WHERE pi.id = p_pedido_item_id AND p.cliente_id = auth.uid()
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACESSO_NEGADO', 'code', 'PERMISSION_DENIED');
    END IF;
  END IF;

  SELECT pi.id, pi.pedido_id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade,
         pi.briefing_status, pi.briefing_revisado_em, pi.briefing_motivo_rejeicao,
         p.nome_cliente, p.data_entrega, p.hora_entrega
  INTO v_item
  FROM public.pedido_itens pi
  JOIN public.pedidos p ON p.id = pi.pedido_id
  WHERE pi.id = p_pedido_item_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ITEM_NAO_ENCONTRADO');
  END IF;

  -- Busca snapshots de personalizações
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', pz.id,
      'campo_codigo', pz.codigo_snapshot,
      'label', pz.label_snapshot,
      'tipo', pz.tipo_snapshot,
      'valor', pz.valor_jsonb,
      'ordem', pz.ordem_snapshot
    ) ORDER BY pz.ordem_snapshot ASC, pz.id ASC
  ) INTO v_personalizacoes
  FROM public.pedido_item_personalizacoes pz
  WHERE pz.pedido_item_id = p_pedido_item_id;

  -- Busca arquivos anexados
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'personalizacao_id', a.personalizacao_id,
      'nome_original', a.nome_original,
      'storage_path', a.storage_path,
      'mime_type', a.mime_type,
      'tamanho_bytes', a.tamanho_bytes,
      'criado_em', a.created_at
    ) ORDER BY a.id ASC
  ) INTO v_arquivos
  FROM public.pedido_item_personalizacao_arquivos a
  WHERE a.pedido_item_id = p_pedido_item_id;

  RETURN jsonb_build_object(
    'success', true,
    'pedido_item_id', v_item.id,
    'pedido_id', v_item.pedido_id,
    'produto_nome', v_item.produto_nome_snapshot,
    'quantidade', v_item.quantidade,
    'cliente_nome', v_item.nome_cliente,
    'data_entrega', v_item.data_entrega,
    'hora_entrega', v_item.hora_entrega,
    'briefing_status', v_item.briefing_status,
    'briefing_revisado_em', v_item.briefing_revisado_em,
    'briefing_motivo_rejeicao', v_item.briefing_motivo_rejeicao,
    'personalizacoes', COALESCE(v_personalizacoes, '[]'::jsonb),
    'arquivos', COALESCE(v_arquivos, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_briefing_item(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_briefing_item(BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. RPC: APROVAR_BRIEFING_ITEM (AUTORIA SERVER-SIDE E TRANSIÇÃO KDS)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aprovar_briefing_item(
  p_pedido_item_id BIGINT,
  p_aprovado BOOLEAN,
  p_motivo TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_item RECORD;
  v_novo_status VARCHAR(30);
BEGIN
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada. Apenas operadores e administradores podem aprovar briefings.');
  END IF;

  SELECT * INTO v_item
  FROM public.pedido_itens
  WHERE id = p_pedido_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item do pedido não encontrado.');
  END IF;

  IF p_aprovado THEN
    v_novo_status := 'APROVADO';
  ELSE
    v_novo_status := 'REJEITADO';
  END IF;

  UPDATE public.pedido_itens
  SET briefing_status = v_novo_status,
      briefing_revisado_em = NOW(),
      briefing_revisado_por = v_caller_id,
      briefing_motivo_rejeicao = CASE WHEN NOT p_aprovado THEN COALESCE(p_motivo, 'Briefing inviável tecnicamente ou com dados faltantes.') ELSE NULL END
  WHERE id = p_pedido_item_id;

  -- Sincroniza KDS se a unidade já tiver sido gerada
  UPDATE public.pedido_item_producao_kds
  SET briefing_status = v_novo_status,
      updated_at = NOW()
  WHERE pedido_item_id = p_pedido_item_id;

  -- Registra auditoria da decisão no histórico imutável
  INSERT INTO public.pedido_item_personalizacao_historico (
    pedido_item_id, personalizacao_id, campo_codigo, valor_anterior, valor_novo, motivo, alterado_por, alterado_em
  ) VALUES (
    p_pedido_item_id, NULL, 'briefing_status', to_jsonb(v_item.briefing_status), to_jsonb(v_novo_status),
    COALESCE(p_motivo, CASE WHEN p_aprovado THEN 'Aprovação de briefing' ELSE 'Rejeição de briefing' END),
    v_caller_id, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'pedido_item_id', p_pedido_item_id,
    'briefing_status', v_novo_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_briefing_item(BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_briefing_item(BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 13. EVOLUÇÃO ATÔMICA DE CRIAR_PEDIDO COM SUPORTE A BRIEFING DE PERSONALIZAÇÃO
-- ------------------------------------------------------------------------------
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
  v_valida_pz JSONB;
  v_briefing_status VARCHAR(30);
  v_campo RECORD;
  v_val_pz JSONB;
  v_pz_id BIGINT;
  v_arq JSONB;
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

  -- 4.2 Validação POR LINHA (cada linha configurada é uma unidade lógica: produto + opções + personalizações)
  FOR v_linha IN
    SELECT
      ord,
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      CASE WHEN jsonb_typeof(it->'opcoes') = 'array' THEN it->'opcoes' ELSE '[]'::jsonb END AS opcoes,
      CASE WHEN jsonb_typeof(it->'personalizacoes') = 'object' THEN it->'personalizacoes' ELSE '{}'::jsonb END AS personalizacoes
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(it, ord)
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    ORDER BY ord
  LOOP
    SELECT id, nome, preco, opcoes, requer_aprovacao_personalizacao INTO v_prod FROM public.produtos WHERE id = v_linha.produto_id;
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

    -- Validação de briefing de personalização server-side (Frente 043)
    v_valida_pz := public.validar_personalizacao_produto(v_prod.id, v_linha.personalizacoes);
    IF (v_valida_pz->>'valido')::BOOLEAN IS NOT TRUE THEN
      RETURN json_build_object(
        'success', false,
        'code', v_valida_pz->>'erro',
        'error', v_valida_pz->>'mensagem',
        'campo_codigo', v_valida_pz->>'campo_codigo'
      );
    END IF;

    v_total := v_total + ((v_prod.preco + v_adicionais_item) * v_linha.quantidade);

    v_itens_json_canonical := v_itens_json_canonical || jsonb_build_object(
      'id', v_prod.id,
      'nome', v_prod.nome,
      'quantidade', v_linha.quantidade,
      'preco', v_prod.preco,
      'preco_unitario', v_prod.preco + v_adicionais_item,
      'subtotal', (v_prod.preco + v_adicionais_item) * v_linha.quantidade,
      'opcoes', v_opcoes_canon,
      'personalizacoes', v_linha.personalizacoes
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
    cliente_id_rel,
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
    (SELECT c.id FROM public.clientes c WHERE c.auth_user_id = v_cliente_id LIMIT 1),
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

  -- 7. ETAPA 3: pedido_itens POR LINHA com snapshots de produção (Etapa 2) e briefing (Etapa 43)
  FOR v_linha IN
    SELECT
      ord,
      (it->>'id')::BIGINT AS produto_id,
      GREATEST(1, COALESCE((it->>'quantidade')::INTEGER, 1)) AS quantidade,
      CASE WHEN jsonb_typeof(it->'opcoes') = 'array' THEN it->'opcoes' ELSE '[]'::jsonb END AS opcoes,
      CASE WHEN jsonb_typeof(it->'personalizacoes') = 'object' THEN it->'personalizacoes' ELSE '{}'::jsonb END AS personalizacoes
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(it, ord)
    WHERE (it->>'id') IS NOT NULL AND (it->>'id') ~ '^\d+$'
    ORDER BY ord
  LOOP
    SELECT id, nome, preco, opcoes, pontos_producao, requer_aprovacao_personalizacao
    INTO v_prod
    FROM public.produtos WHERE id = v_linha.produto_id;

    v_pts_prod := COALESCE(v_prod.pontos_producao, 1.00);
    v_adicionais_item := 0.00;

    -- Define o status inicial do briefing (Frente 043)
    IF v_linha.personalizacoes IS NOT NULL AND v_linha.personalizacoes <> '{}'::jsonb THEN
      IF v_prod.requer_aprovacao_personalizacao THEN
        v_briefing_status := 'PENDENTE_REVISAO';
      ELSE
        v_briefing_status := 'APROVADO';
      END IF;
    ELSE
      v_briefing_status := 'DISPENSADO';
    END IF;

    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, unidade,
      preco_base_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal,
      pontos_producao_snapshot, briefing_status
    ) VALUES (
      v_pedido_id, v_prod.id, v_prod.nome, v_linha.quantidade, 'un',
      v_prod.preco, 0.00, v_prod.preco, (v_prod.preco * v_linha.quantidade),
      v_pts_prod, v_briefing_status
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

    -- Gravação dos Snapshots de Personalização (PERS4 / PERS10)
    IF v_linha.personalizacoes IS NOT NULL AND v_linha.personalizacoes <> '{}'::jsonb THEN
      FOR v_campo IN
        SELECT *
        FROM public.produto_campos_personalizacao
        WHERE produto_id = v_prod.id AND ativo = true
        ORDER BY ordem ASC
      LOOP
        v_val_pz := v_linha.personalizacoes->(v_campo.codigo);
        IF v_val_pz IS NOT NULL AND jsonb_typeof(v_val_pz) <> 'null' THEN
          INSERT INTO public.pedido_item_personalizacoes (
            pedido_id,
            pedido_item_id,
            campo_id,
            codigo_snapshot,
            label_snapshot,
            tipo_snapshot,
            valor_jsonb,
            ordem_snapshot
          ) VALUES (
            v_pedido_id,
            v_pedido_item_id,
            v_campo.id,
            v_campo.codigo,
            v_campo.label,
            v_campo.tipo,
            v_val_pz,
            v_campo.ordem
          ) RETURNING id INTO v_pz_id;

          -- Se for tipo IMAGENS ou IMAGEM e contiver referências de storage
          IF v_campo.tipo IN ('IMAGEM', 'IMAGENS') AND jsonb_typeof(v_val_pz) = 'array' THEN
            FOR v_arq IN SELECT arq.value FROM jsonb_array_elements(v_val_pz) AS arq(value) LOOP
              IF (v_arq->>'storage_path') IS NOT NULL THEN
                INSERT INTO public.pedido_item_personalizacao_arquivos (
                  pedido_id,
                  pedido_item_id,
                  personalizacao_id,
                  storage_path,
                  mime_type,
                  tamanho_bytes,
                  sha256,
                  nome_original
                ) VALUES (
                  v_pedido_id,
                  v_pedido_item_id,
                  v_pz_id,
                  v_arq->>'storage_path',
                  COALESCE(v_arq->>'mime_type', 'image/jpeg'),
                  GREATEST(1, COALESCE((v_arq->>'tamanho_bytes')::BIGINT, 1024)),
                  v_arq->>'sha256',
                  COALESCE(v_arq->>'nome_original', 'referencia.jpg')
                );
              END IF;
            END LOOP;
          END IF;
        END IF;
      END LOOP;
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

REVOKE ALL ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 14. ATUALIZAÇÃO DA INICIALIZAÇÃO KDS COM PROPAGAÇÃO DE BRIEFING_STATUS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_inicializar_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_pedido RECORD;
  v_kds_id UUID;
  v_item RECORD;
  v_etapas_count INT;
  v_sla_item_total INT;
  v_sla_pedido_total INT := 0;
  v_primeira_etapa RECORD;
  v_itens_kds_count INT := 0;
  v_kds_item_id UUID;
  v_tem_itens_producao BOOLEAN := FALSE;
BEGIN
  SELECT id, status_operacional, observacoes_internas, canal
  INTO v_pedido
  FROM public.pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.', 'code', 'ORDER_NOT_FOUND');
  END IF;

  SELECT id INTO v_kds_id
  FROM public.pedido_producao_kds
  WHERE pedido_id = p_pedido_id;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'kds_id', v_kds_id, 'ja_inicializado', true);
  END IF;

  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, 
           COALESCE(p.pronta_entrega, false) AS pronta_entrega,
           p.ativo
    FROM public.pedido_itens pi
    LEFT JOIN public.produtos p ON p.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    IF v_item.pronta_entrega IS TRUE THEN
      CONTINUE;
    END IF;

    v_tem_itens_producao := TRUE;

    SELECT COUNT(*), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    IF v_etapas_count = 0 THEN
      RAISE EXCEPTION 'KDS_ROUTE_NOT_CONFIGURED: O produto % (ID %) não possui rota de etapas cadastrada no KDS.',
        v_item.produto_nome_snapshot, v_item.produto_id
        USING ERRCODE = 'P0001';
    END IF;

    v_sla_pedido_total := v_sla_pedido_total + v_sla_item_total;
    v_itens_kds_count := v_itens_kds_count + 1;
  END LOOP;

  IF NOT v_tem_itens_producao OR v_itens_kds_count = 0 THEN
    RETURN jsonb_build_object(
      'success', true, 
      'kds_id', null, 
      'pronta_entrega', true, 
      'message', 'Pedido composto exclusivamente por itens de pronta-entrega; KDS dispensado.'
    );
  END IF;

  INSERT INTO public.pedido_producao_kds (
    pedido_id,
    estagio_agregado,
    ativo,
    sla_total_snapshot,
    prioridade_urgencia,
    observacoes_cozinha,
    criado_em,
    updated_at
  ) VALUES (
    p_pedido_id,
    'AGUARDANDO',
    TRUE,
    GREATEST(1, v_sla_pedido_total),
    FALSE,
    v_pedido.observacoes_internas,
    NOW(),
    NOW()
  )
  ON CONFLICT (pedido_id) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_kds_id;

  FOR v_item IN
    SELECT pi.id, pi.produto_id, pi.produto_nome_snapshot, pi.quantidade, pi.observacoes,
           pi.briefing_status,
           COALESCE(p.pronta_entrega, false) AS pronta_entrega
    FROM public.pedido_itens pi
    LEFT JOIN public.produtos p ON p.id = pi.produto_id
    WHERE pi.pedido_id = p_pedido_id
  LOOP
    IF v_item.pronta_entrega IS TRUE THEN
      CONTINUE;
    END IF;

    SELECT ordem, praca, sla_minutos
    INTO v_primeira_etapa
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id
    ORDER BY ordem ASC
    LIMIT 1;

    SELECT MAX(ordem), COALESCE(SUM(sla_minutos), 0)
    INTO v_etapas_count, v_sla_item_total
    FROM public.produto_etapas_kds
    WHERE produto_id = v_item.produto_id;

    INSERT INTO public.pedido_item_producao_kds (
      kds_id,
      pedido_id,
      pedido_item_id,
      produto_id,
      produto_nome_snapshot,
      quantidade,
      ordem_etapa_atual,
      ordem_etapa_max,
      estagio_atual,
      praca_atual,
      proxima_etapa,
      ativo,
      sla_etapa_snapshot,
      sla_total_snapshot,
      observacoes_item,
      briefing_status,
      criado_em,
      updated_at
    ) VALUES (
      v_kds_id,
      p_pedido_id,
      v_item.id,
      v_item.produto_id,
      v_item.produto_nome_snapshot,
      v_item.quantidade,
      0,
      v_etapas_count,
      'AGUARDANDO',
      NULL,
      v_primeira_etapa.praca,
      TRUE,
      v_primeira_etapa.sla_minutos,
      v_sla_item_total,
      v_item.observacoes,
      COALESCE(v_item.briefing_status, 'DISPENSADO'),
      NOW(),
      NOW()
    )
    ON CONFLICT (kds_id, pedido_item_id) DO NOTHING
    RETURNING id INTO v_kds_item_id;

    IF v_kds_item_id IS NULL THEN
      SELECT id INTO v_kds_item_id 
      FROM public.pedido_item_producao_kds 
      WHERE kds_id = v_kds_id AND pedido_item_id = v_item.id;
    END IF;

    IF v_kds_item_id IS NOT NULL THEN
      INSERT INTO public.pedido_item_kds_etapas (
        kds_item_id,
        pedido_id,
        pedido_item_id,
        ordem,
        praca,
        sla_minutos_snapshot,
        obrigatoria_snapshot
      )
      SELECT
        v_kds_item_id,
        p_pedido_id,
        v_item.id,
        ordem,
        praca,
        sla_minutos,
        obrigatoria
      FROM public.produto_etapas_kds
      WHERE produto_id = v_item.produto_id
      ORDER BY ordem ASC
      ON CONFLICT (kds_item_id, ordem) DO NOTHING;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'kds_id', v_kds_id,
    'pedido_id', p_pedido_id,
    'itens_inicializados', v_itens_kds_count,
    'sla_total_minutos', v_sla_pedido_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.kds_inicializar_pedido(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kds_inicializar_pedido(BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 15. RPC KDS_OBTER_PAINEL COM BRIEFING DE PERSONALIZAÇÃO EMBUTIDO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kds_obter_painel(
  p_praca_filtro VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID;
  v_praca_norm VARCHAR;
  v_cards JSONB;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_admin_or_operator() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permissão negada.', 'code', 'PERMISSION_DENIED');
  END IF;

  v_praca_norm := upper(btrim(COALESCE(p_praca_filtro, '')));
  IF v_praca_norm IN ('', 'TODAS', 'NULL') THEN
    v_praca_norm := NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(card_data ORDER BY card_data->>'prioridade_urgencia' DESC, (card_data->>'data_entrega')::text ASC, (card_data->>'hora_entrega')::text ASC, card_data->>'criado_em' ASC), '[]'::jsonb)
  INTO v_cards
  FROM (
    SELECT jsonb_build_object(
      'kds_id', k.id,
      'pedido_id', k.pedido_id,
      'estagio_agregado', k.estagio_agregado,
      'prioridade_urgencia', k.prioridade_urgencia,
      'observacoes_cozinha', k.observacoes_cozinha,
      'criado_em', k.criado_em,
      'iniciado_em', k.iniciado_em,
      'sla_total_minutos', k.sla_total_snapshot,
      'cliente_nome', p.nome_cliente,
      'cliente_telefone', p.telefone_cliente,
      'modalidade_entrega', p.modalidade_entrega,
      'data_entrega', p.data_entrega,
      'hora_entrega', p.hora_entrega,
      'status_operacional_pedido', p.status_operacional,
      'itens', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'kds_item_id', item.id,
            'pedido_item_id', item.pedido_item_id,
            'produto_id', item.produto_id,
            'produto_nome', item.produto_nome_snapshot,
            'quantidade', item.quantidade,
            'ordem_etapa_atual', item.ordem_etapa_atual,
            'ordem_etapa_max', item.ordem_etapa_max,
            'estagio_atual', item.estagio_atual,
            'praca_atual', item.praca_atual,
            'proxima_etapa', item.proxima_etapa,
            'briefing_status', COALESCE(item.briefing_status, 'DISPENSADO'),
            'personalizacoes', (
              SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                  'codigo', pz.codigo_snapshot,
                  'label', pz.label_snapshot,
                  'tipo', pz.tipo_snapshot,
                  'valor', pz.valor_jsonb
                ) ORDER BY pz.ordem_snapshot ASC
              ), '[]'::jsonb)
              FROM public.pedido_item_personalizacoes pz
              WHERE pz.pedido_item_id = item.pedido_item_id
            ),
            'arquivos_count', (
              SELECT COUNT(*)
              FROM public.pedido_item_personalizacao_arquivos a
              WHERE a.pedido_item_id = item.pedido_item_id
            ),
            'tempo_etapa_segundos', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL 
              THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em))::INTEGER)
              ELSE 0 
            END,
            'sla_etapa_minutos', item.sla_etapa_snapshot,
            'atrasado', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL AND (EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) > item.sla_etapa_snapshot
              THEN TRUE
              ELSE FALSE
            END,
            'minutos_atraso', CASE 
              WHEN item.tempo_etapa_iniciado_em IS NOT NULL AND (EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) > item.sla_etapa_snapshot
              THEN ROUND(((EXTRACT(EPOCH FROM (NOW() - item.tempo_etapa_iniciado_em)) / 60) - item.sla_etapa_snapshot)::numeric, 1)
              ELSE 0
            END,
            'observacoes_item', item.observacoes_item
          ) ORDER BY item.ordem_etapa_atual ASC, item.criado_em ASC
        )
        FROM public.pedido_item_producao_kds item
        WHERE item.kds_id = k.id
          AND item.ativo = TRUE
          AND (v_praca_norm IS NULL OR item.praca_atual = v_praca_norm OR (item.estagio_atual = 'AGUARDANDO' AND item.proxima_etapa = v_praca_norm))
      )
    ) AS card_data
    FROM public.pedido_producao_kds k
    JOIN public.pedidos p ON p.id = k.pedido_id
    WHERE k.ativo = TRUE
      AND p.status_operacional IN ('aguardando_producao', 'em_producao')
      AND EXISTS (
        SELECT 1 FROM public.pedido_item_producao_kds item
        WHERE item.kds_id = k.id
          AND item.ativo = TRUE
          AND (v_praca_norm IS NULL OR item.praca_atual = v_praca_norm OR (item.estagio_atual = 'AGUARDANDO' AND item.proxima_etapa = v_praca_norm))
      )
  ) sub;

  RETURN jsonb_build_object(
    'success', true,
    'praca_filtro', v_praca_norm,
    'total_pedidos', jsonb_array_length(v_cards),
    'cards', v_cards
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.kds_obter_painel(VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kds_obter_painel(VARCHAR) TO authenticated, service_role;

