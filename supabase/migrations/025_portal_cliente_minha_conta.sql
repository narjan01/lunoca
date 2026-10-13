-- ==============================================================================
-- LUNOCA DOCERIA - MIGRATION 025: FRENTE J - PORTAL DO CLIENTE / MINHA CONTA
-- ==============================================================================
-- Diretrizes Centrais e Invariantes (Frente J):
-- 1. Zero lógica de negócio nova: O portal é uma camada pura de projeção
--    sanitizada e self-service fail-closed sobre as Frentes B, C, D, E e I.
-- 2. Resolução estrita de identidade:
--      auth.uid() -> clientes.auth_user_id -> cliente_id
--    Sem fallback por e-mail ou telefone, sem aceitar p_cliente_id vindo do
--    navegador em nenhuma RPC pública do portal (Gate J4).
-- 3. Unicidade estrutural de vínculo: no máximo 1 cliente por auth_user_id;
--    ausência de vínculo falha fechado com CLIENT_LINK_REQUIRED (Gate J2).
-- 4. Zero exposição de credenciais ou dados internos:
--    - Orçamentos no portal JAMAIS retornam token_publico (Gate J7).
--    - Aprovação autenticada usa aprovar_meu_orcamento(p_orcamento_id, p_versao_esperada)
--      validando propriedade do cliente e delegando internamente para
--      aprovar_orcamento_publico (Gate J8).
--    - Pedidos JAMAIS expõem observacoes_internas, pedido_producao_observacoes,
--      prioridade_cozinha, custos, margens, provider_payment_id ou metadata (Gates J5, J6).
-- 5. Separação semântica estrita (Gates J9, J10, J11):
--    - Meu Crédito Financeiro (R$ - Frente C) != Meus Pontos (pts - Frente I).
-- 6. Preferências Self-Service e Privacidade (Gates J13, J14, J15, J16):
--    - Cliente gerencia apenas categorias permitidas ('sabor', 'decoracao',
--      'ocasiao', 'restricao_alimentar', 'embalagem').
--    - Notas internas e tags administrativas permanecem 100% invisíveis e intocáveis.
--    - Consentimento de marketing (opt_in / opt_out) é gravado append-only com
--      origem = 'portal_cliente' e prevalece imediatamente sobre campanhas,
--      sem bloquear comunicações transacionais.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. UNICIDADE ESTRUTURAL DO VÍNCULO AUTH_USER_ID E CATEGORIAS DE PREFERÊNCIA
-- ------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_auth_user_id
  ON public.clientes(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Amplia o CHECK de categorias de cliente_preferencias para incluir 'embalagem'
-- (mantendo retrocompatibilidade com 'atendimento' e 'outro' para uso da equipe)
DO $$
BEGIN
  ALTER TABLE public.cliente_preferencias
    DROP CONSTRAINT IF EXISTS cliente_preferencias_categoria_check;
  ALTER TABLE public.cliente_preferencias
    ADD CONSTRAINT cliente_preferencias_categoria_check
    CHECK (categoria IN ('sabor', 'decoracao', 'ocasiao', 'atendimento', 'restricao_alimentar', 'embalagem', 'outro'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------------------------
-- 2. HELPER INTERNO FAIL-CLOSED DE RESOLUÇÃO DE IDENTIDADE DO CLIENTE
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._resolver_meu_cliente_id()
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_qtd INTEGER := 0;
  v_cli public.clientes;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'UNAUTHENTICATED',
      'error', 'Sessão autenticada obrigatória para acessar o Portal do Cliente.'
    );
  END IF;

  SELECT COUNT(*) INTO v_qtd
  FROM public.clientes
  WHERE auth_user_id = v_uid;

  IF v_qtd = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'CLIENT_LINK_REQUIRED',
      'error', 'Sua conta ainda não possui um cadastro de cliente vinculado.'
    );
  END IF;

  IF v_qtd > 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'AMBIGUOUS_CLIENT_LINK',
      'error', 'Múltiplos cadastros vinculados ao mesmo usuário. Contate o suporte.'
    );
  END IF;

  SELECT * INTO v_cli
  FROM public.clientes
  WHERE auth_user_id = v_uid
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'cliente_id', v_cli.id,
    'nome', v_cli.nome,
    'email', v_cli.email,
    'telefone', v_cli.telefone,
    'data_nascimento', v_cli.data_nascimento,
    'endereco_padrao', COALESCE(v_cli.endereco_padrao, '{}'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._resolver_meu_cliente_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._resolver_meu_cliente_id() TO service_role;

-- ------------------------------------------------------------------------------
-- 3. HELPER INTERNO DE DERIVAÇÃO DA ETAPA AMIGÁVEL DO CLIENTE
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._derivar_etapa_cliente_pedido(
  p_status_comercial TEXT,
  p_status_operacional TEXT,
  p_modalidade TEXT
)
RETURNS TEXT AS $$
BEGIN
  IF COALESCE(p_status_comercial, '') = 'cancelado' OR COALESCE(p_status_operacional, '') = 'cancelado' THEN
    RETURN 'cancelado';
  END IF;

  IF COALESCE(p_status_operacional, '') = 'entregue' THEN
    RETURN 'entregue';
  END IF;

  IF COALESCE(p_status_operacional, '') = 'retirado' THEN
    RETURN 'retirado';
  END IF;

  IF COALESCE(p_status_operacional, '') IN ('saiu_para_entrega', 'em_rota') THEN
    RETURN 'saiu_para_entrega';
  END IF;

  IF COALESCE(p_status_operacional, '') = 'pronto' THEN
    IF COALESCE(p_modalidade, 'retirada') = 'entrega' THEN
      RETURN 'pronto_para_entrega';
    ELSE
      RETURN 'pronto_para_retirada';
    END IF;
  END IF;

  IF COALESCE(p_status_operacional, '') = 'em_producao' THEN
    RETURN 'em_preparo';
  END IF;

  RETURN 'aguardando_preparo';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

REVOKE ALL ON FUNCTION public._derivar_etapa_cliente_pedido(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._derivar_etapa_cliente_pedido(TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------------------------
-- 4. RPC RESUMO DO PORTAL: OBTER_PAINEL_MINHA_CONTA_CLIENTE()
-- ------------------------------------------------------------------------------
-- Retorna apenas resumo enxuto e itens recentes (sem históricos gigantescos).
CREATE OR REPLACE FUNCTION public.obter_painel_minha_conta_cliente()
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_saldo_credito NUMERIC(10,2) := 0.00;
  v_saldo_pontos INTEGER := 0;
  v_pontos_expirando_30d INTEGER := 0;
  v_prog RECORD;
  v_pedidos_recentes JSONB;
  v_orcamentos_recentes JSONB;
  v_cupons_elegiveis_qtd INTEGER := 0;
  v_preferencias JSONB;
  v_consentimento_whatsapp TEXT;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Atualiza expiração de pontos vencidos de forma transparente antes da leitura
  PERFORM public._processar_expiracao_pontos_cliente(v_cli_id, NOW());

  -- 1. Saldo Financeiro (Frente C - estritamente separado de pontos)
  SELECT COALESCE(saldo, 0.00) INTO v_saldo_credito
  FROM public.cliente_creditos
  WHERE cliente_id = v_cli_id;

  -- 2. Saldo de Pontos de Fidelidade (Frente I - benefício promocional)
  SELECT COALESCE(saldo_pontos, 0) INTO v_saldo_pontos
  FROM public.cliente_pontos
  WHERE cliente_id = v_cli_id;

  SELECT COALESCE(SUM(pontos), 0) INTO v_pontos_expirando_30d
  FROM public.cliente_pontos_movimentacoes pm
  WHERE pm.cliente_id = v_cli_id
    AND pm.natureza = 'credito'
    AND pm.expira_em IS NOT NULL
    AND pm.expira_em > NOW()
    AND pm.expira_em <= NOW() + INTERVAL '30 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.cliente_pontos_movimentacoes exp_m
      WHERE exp_m.lote_origem_id = pm.id AND exp_m.tipo = 'EXPIRACAO'
    );

  SELECT nome, pontos_por_real, valor_por_ponto_resgate, resgate_minimo_pontos
  INTO v_prog
  FROM public.programas_fidelidade
  WHERE ativo = true
  ORDER BY id ASC
  LIMIT 1;

  -- 3. Pedidos recentes (máximo 5, sanitizados)
  SELECT COALESCE(jsonb_agg(row_to_json(p_row)::jsonb ORDER BY p_row.created_at DESC), '[]'::jsonb)
  INTO v_pedidos_recentes
  FROM (
    SELECT
      p.id AS pedido_id,
      p.data_entrega,
      p.hora_entrega,
      COALESCE(p.modalidade_entrega, 'retirada') AS modalidade,
      p.status_comercial,
      p.status_financeiro,
      public._derivar_etapa_cliente_pedido(p.status_comercial, p.status_operacional, p.modalidade_entrega) AS etapa_cliente,
      ROUND(COALESCE(p.total, 0.00), 2) AS total,
      ROUND(GREATEST(0.00, COALESCE(p.saldo, COALESCE(p.total, 0.00) - COALESCE(p.valor_pago, 0.00))), 2) AS saldo_a_pagar,
      p.created_at
    FROM public.pedidos p
    WHERE p.cliente_id_rel = v_cli_id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 5
  ) p_row;

  -- 4. Orçamentos recentes (máximo 5, SEM token_publico)
  SELECT COALESCE(jsonb_agg(row_to_json(o_row)::jsonb ORDER BY o_row.created_at DESC), '[]'::jsonb)
  INTO v_orcamentos_recentes
  FROM (
    SELECT
      o.id AS orcamento_id,
      o.numero,
      o.versao,
      o.status,
      o.data_evento,
      o.hora_evento,
      o.tipo_entrega AS modalidade,
      ROUND(COALESCE(o.total, 0.00), 2) AS total,
      o.validade_ate,
      o.aprovado_em,
      o.pedido_id,
      o.created_at
    FROM public.orcamentos o
    WHERE o.cliente_id = v_cli_id
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT 5
  ) o_row;

  -- 5. Contagem de cupons elegíveis para o próprio cliente
  SELECT COUNT(*) INTO v_cupons_elegiveis_qtd
  FROM public.cupons_promocionais cp
  WHERE cp.ativo = true
    AND cp.validade_inicio <= NOW()
    AND cp.validade_fim >= NOW()
    AND (
      cp.uso_maximo_global IS NULL
      OR (SELECT COUNT(*) FROM public.cupom_utilizacoes cu WHERE cu.cupom_id = cp.id AND cu.status = 'aplicado') < cp.uso_maximo_global
    )
    AND (
      cp.uso_maximo_cliente IS NULL
      OR (SELECT COUNT(*) FROM public.cupom_utilizacoes cu WHERE cu.cupom_id = cp.id AND cu.cliente_id = v_cli_id AND cu.status = 'aplicado') < cp.uso_maximo_cliente
    );

  -- 6. Preferências declaradas ativas (apenas categorias self-service)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', pref.id,
      'categoria', pref.categoria,
      'valor', pref.valor,
      'observacao', pref.observacao,
      'updated_at', pref.updated_at
    ) ORDER BY pref.categoria ASC, pref.id DESC
  ), '[]'::jsonb)
  INTO v_preferencias
  FROM public.cliente_preferencias pref
  WHERE pref.cliente_id = v_cli_id
    AND pref.ativo = true
    AND pref.categoria IN ('sabor', 'decoracao', 'ocasiao', 'restricao_alimentar', 'embalagem');

  -- 7. Status atual de consentimento de marketing
  v_consentimento_whatsapp := public.obter_status_consentimento_marketing(v_cli_id, 'whatsapp_marketing');

  RETURN jsonb_build_object(
    'success', true,
    'perfil', jsonb_build_object(
      'nome', v_ident->>'nome',
      'email', v_ident->>'email',
      'telefone', v_ident->>'telefone',
      'data_nascimento', v_ident->>'data_nascimento',
      'endereco_padrao', v_ident->'endereco_padrao'
    ),
    'meu_credito', jsonb_build_object(
      'natureza', 'valor_financeiro',
      'moeda', 'BRL',
      'saldo_reais', ROUND(v_saldo_credito, 2),
      'descricao', 'Crédito financeiro em carteira (Frente C)'
    ),
    'meus_pontos', jsonb_build_object(
      'natureza', 'beneficio_promocional',
      'unidade', 'pts',
      'saldo_pontos', v_saldo_pontos,
      'pontos_expirando_30d', LEAST(v_saldo_pontos, v_pontos_expirando_30d),
      'programa_nome', COALESCE(v_prog.nome, 'Clube de Fidelidade Lunoca'),
      'resgate_minimo_pontos', COALESCE(v_prog.resgate_minimo_pontos, 20),
      'valor_por_ponto_resgate', COALESCE(v_prog.valor_por_ponto_resgate, 0.0500),
      'descricao', 'Pontos promocionais do programa de fidelidade (Frente I)'
    ),
    'resumo_contadores', jsonb_build_object(
      'cupons_disponiveis', v_cupons_elegiveis_qtd,
      'consentimento_whatsapp_marketing', v_consentimento_whatsapp
    ),
    'pedidos_recentes', v_pedidos_recentes,
    'orcamentos_recentes', v_orcamentos_recentes,
    'preferencias_declaradas', v_preferencias
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_painel_minha_conta_cliente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_painel_minha_conta_cliente() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. MEUS PEDIDOS E DETALHE DE PEDIDO SANITIZADO (GATES J3, J5, J6)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_meus_pedidos(
  p_limite INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_lim INTEGER := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50);
  v_off INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_total INTEGER := 0;
  v_pedidos JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  SELECT COUNT(*) INTO v_total
  FROM public.pedidos p
  WHERE p.cliente_id_rel = v_cli_id;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.created_at DESC, r.pedido_id DESC), '[]'::jsonb)
  INTO v_pedidos
  FROM (
    SELECT
      p.id AS pedido_id,
      p.data_entrega,
      p.hora_entrega,
      COALESCE(p.modalidade_entrega, 'retirada') AS modalidade,
      p.status_comercial,
      p.status_financeiro,
      public._derivar_etapa_cliente_pedido(p.status_comercial, p.status_operacional, p.modalidade_entrega) AS etapa_cliente,
      ROUND(COALESCE(p.subtotal, p.total, 0.00), 2) AS subtotal,
      ROUND(COALESCE(p.desconto, 0.00), 2) AS desconto,
      ROUND(COALESCE(p.taxa_entrega, 0.00), 2) AS taxa_entrega,
      ROUND(COALESCE(p.total, 0.00), 2) AS total,
      ROUND(COALESCE(p.valor_pago, 0.00), 2) AS valor_pago,
      ROUND(GREATEST(0.00, COALESCE(p.saldo, COALESCE(p.total, 0.00) - COALESCE(p.valor_pago, 0.00))), 2) AS saldo_a_pagar,
      p.observacoes_cliente,
      p.created_at,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'item_id', pi.id,
            'nome', pi.produto_nome_snapshot,
            'quantidade', pi.quantidade,
            'unidade', COALESCE(pi.unidade, 'un'),
            'preco_unitario', ROUND(COALESCE(pi.preco_unitario_snapshot, 0.00), 2),
            'opcoes', COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'tipo', pio.tipo,
                  'opcao_nome', pio.opcao_nome,
                  'preco_adicional', ROUND(COALESCE(pio.preco_adicional, 0.00), 2)
                ) ORDER BY pio.id ASC
              )
              FROM public.pedido_item_opcoes pio
              WHERE pio.pedido_item_id = pi.id
            ), '[]'::jsonb)
          ) ORDER BY pi.id ASC
        )
        FROM public.pedido_itens pi
        WHERE pi.pedido_id = p.id
      ), '[]'::jsonb) AS itens
    FROM public.pedidos p
    WHERE p.cliente_id_rel = v_cli_id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT v_lim OFFSET v_off
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'total_registros', v_total,
    'limite', v_lim,
    'offset', v_off,
    'pedidos', v_pedidos
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_meus_pedidos(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_meus_pedidos(INTEGER, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.obter_meu_pedido(
  p_pedido_id BIGINT
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_ped RECORD;
  v_itens JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'ORDER_ID_REQUIRED', 'error', 'ID do pedido é obrigatório.');
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Gate J3: Filtra estritamente por id E cliente_id_rel = v_cli_id
  SELECT
    p.id AS pedido_id,
    p.data_entrega,
    p.hora_entrega,
    COALESCE(p.modalidade_entrega, 'retirada') AS modalidade,
    p.endereco_entrega,
    p.status_comercial,
    p.status_financeiro,
    public._derivar_etapa_cliente_pedido(p.status_comercial, p.status_operacional, p.modalidade_entrega) AS etapa_cliente,
    ROUND(COALESCE(p.subtotal, p.total, 0.00), 2) AS subtotal,
    ROUND(COALESCE(p.desconto, 0.00), 2) AS desconto,
    ROUND(COALESCE(p.taxa_entrega, 0.00), 2) AS taxa_entrega,
    ROUND(COALESCE(p.total, 0.00), 2) AS total,
    ROUND(COALESCE(p.valor_pago, 0.00), 2) AS valor_pago,
    ROUND(GREATEST(0.00, COALESCE(p.saldo, COALESCE(p.total, 0.00) - COALESCE(p.valor_pago, 0.00))), 2) AS saldo_a_pagar,
    p.observacoes_cliente,
    p.created_at
  INTO v_ped
  FROM public.pedidos p
  WHERE p.id = p_pedido_id
    AND p.cliente_id_rel = v_cli_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Pedido não encontrado para sua conta.'
    );
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'item_id', pi.id,
      'nome', pi.produto_nome_snapshot,
      'quantidade', pi.quantidade,
      'unidade', COALESCE(pi.unidade, 'un'),
      'preco_unitario', ROUND(COALESCE(pi.preco_unitario_snapshot, 0.00), 2),
      'opcoes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'tipo', pio.tipo,
            'opcao_nome', pio.opcao_nome,
            'preco_adicional', ROUND(COALESCE(pio.preco_adicional, 0.00), 2)
          ) ORDER BY pio.id ASC
        )
        FROM public.pedido_item_opcoes pio
        WHERE pio.pedido_item_id = pi.id
      ), '[]'::jsonb)
    ) ORDER BY pi.id ASC
  ), '[]'::jsonb)
  INTO v_itens
  FROM public.pedido_itens pi
  WHERE pi.pedido_id = v_ped.pedido_id;

  RETURN jsonb_build_object(
    'success', true,
    'pedido', jsonb_build_object(
      'pedido_id', v_ped.pedido_id,
      'data_entrega', v_ped.data_entrega,
      'hora_entrega', v_ped.hora_entrega,
      'modalidade', v_ped.modalidade,
      'endereco_entrega', v_ped.endereco_entrega,
      'status_comercial', v_ped.status_comercial,
      'status_financeiro', v_ped.status_financeiro,
      'etapa_cliente', v_ped.etapa_cliente,
      'subtotal', v_ped.subtotal,
      'desconto', v_ped.desconto,
      'taxa_entrega', v_ped.taxa_entrega,
      'total', v_ped.total,
      'valor_pago', v_ped.valor_pago,
      'saldo_a_pagar', v_ped.saldo_a_pagar,
      'observacoes_cliente', v_ped.observacoes_cliente,
      'created_at', v_ped.created_at,
      'itens', v_itens
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_meu_pedido(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_meu_pedido(BIGINT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 6. MEUS ORÇAMENTOS SEM TOKEN_PUBLICO E APROVAÇÃO AUTENTICADA (GATES J7, J8)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_meus_orcamentos(
  p_limite INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_lim INTEGER := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50);
  v_off INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_total INTEGER := 0;
  v_orcamentos JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  SELECT COUNT(*) INTO v_total
  FROM public.orcamentos o
  WHERE o.cliente_id = v_cli_id;

  -- Gate J7: JAMAIS inclui token_publico nem observacoes_internas
  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.created_at DESC, r.orcamento_id DESC), '[]'::jsonb)
  INTO v_orcamentos
  FROM (
    SELECT
      o.id AS orcamento_id,
      o.numero,
      o.versao,
      o.status,
      o.data_evento,
      o.hora_evento,
      o.tipo_entrega AS modalidade,
      o.endereco_entrega,
      ROUND(COALESCE(o.subtotal, 0.00), 2) AS subtotal,
      ROUND(COALESCE(o.desconto_produtos, 0.00) + COALESCE(o.desconto_frete, 0.00), 2) AS desconto,
      ROUND(COALESCE(o.taxa_entrega_cobrada, 0.00), 2) AS taxa_entrega,
      ROUND(COALESCE(o.total, 0.00), 2) AS total,
      ROUND(COALESCE(o.sinal_sugerido, 0.00), 2) AS sinal_minimo,
      o.validade_ate,
      o.aprovado_em,
      o.pedido_id,
      o.observacoes_cliente,
      o.created_at,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'item_id', oi.id,
            'nome', COALESCE(pr.nome, 'Produto #' || oi.produto_id::TEXT),
            'quantidade', oi.quantidade,
            'unidade', 'un',
            'preco_unitario', ROUND(COALESCE(oi.preco_unitario_snapshot, 0.00), 2),
            'subtotal', ROUND(COALESCE(oi.subtotal, 0.00), 2),
            'opcoes', COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'categoria', oio.tipo,
                  'opcao_nome', oio.opcao_nome,
                  'preco_adicional', ROUND(COALESCE(oio.preco_adicional_snapshot, 0.00), 2)
                ) ORDER BY oio.id ASC
              )
              FROM public.orcamento_item_opcoes oio
              WHERE oio.orcamento_item_id = oi.id
            ), '[]'::jsonb)
          ) ORDER BY oi.id ASC
        )
        FROM public.orcamento_itens oi
        LEFT JOIN public.produtos pr ON pr.id = oi.produto_id
        WHERE oi.orcamento_id = o.id
      ), '[]'::jsonb) AS itens
    FROM public.orcamentos o
    WHERE o.cliente_id = v_cli_id
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT v_lim OFFSET v_off
  ) r;

  RETURN jsonb_build_object(
    'success', true,
    'total_registros', v_total,
    'limite', v_lim,
    'offset', v_off,
    'orcamentos', v_orcamentos
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_meus_orcamentos(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_meus_orcamentos(INTEGER, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.aprovar_meu_orcamento(
  p_orcamento_id BIGINT,
  p_versao_esperada INTEGER
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_orc public.orcamentos;
  v_res JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  IF p_orcamento_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'QUOTE_ID_REQUIRED', 'error', 'ID do orçamento é obrigatório.');
  END IF;

  IF p_versao_esperada IS NULL OR p_versao_esperada < 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'VERSION_REQUIRED',
      'error', 'A versão esperada da proposta é obrigatória para aprovação.'
    );
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Gate J8: Valida propriedade estrita (orcamento pertence ao cliente autenticado)
  SELECT * INTO v_orc
  FROM public.orcamentos
  WHERE id = p_orcamento_id
    AND cliente_id = v_cli_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'QUOTE_NOT_FOUND',
      'error', 'Orçamento não encontrado para sua conta.'
    );
  END IF;

  -- Reutiliza internamente o motor canônico da Migration 017 sem expor o token_publico ao cliente
  v_res := public.aprovar_orcamento_publico(v_orc.token_publico, p_versao_esperada);

  RETURN v_res || jsonb_build_object('orcamento_id', v_orc.id, 'numero', v_orc.numero);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.aprovar_meu_orcamento(BIGINT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aprovar_meu_orcamento(BIGINT, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 7. EXTRATO DE CRÉDITO FINANCEIRO E EXTRATO DE PONTOS (GATES J9, J10, J11)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_meu_extrato_credito(
  p_limite INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_lim INTEGER := LEAST(GREATEST(COALESCE(p_limite, 25), 1), 100);
  v_off INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_saldo NUMERIC(10,2) := 0.00;
  v_movs JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  SELECT COALESCE(saldo, 0.00) INTO v_saldo
  FROM public.cliente_creditos
  WHERE cliente_id = v_cli_id;

  SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb)
  INTO v_movs
  FROM (
    SELECT
      cm.id,
      cm.origem AS tipo,
      cm.tipo AS natureza,
      ROUND(cm.valor, 2) AS valor,
      ROUND(cm.saldo_anterior, 2) AS saldo_anterior,
      ROUND(cm.saldo_posterior, 2) AS saldo_posterior,
      cm.pedido_id,
      cm.motivo,
      cm.created_at
    FROM public.cliente_credito_movimentacoes cm
    WHERE cm.cliente_id = v_cli_id
    ORDER BY cm.created_at DESC, cm.id DESC
    LIMIT v_lim OFFSET v_off
  ) m;

  RETURN jsonb_build_object(
    'success', true,
    'natureza_carteira', 'valor_financeiro',
    'moeda', 'BRL',
    'saldo_reais', ROUND(v_saldo, 2),
    'movimentacoes', v_movs
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_meu_extrato_credito(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_meu_extrato_credito(INTEGER, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.listar_meu_extrato_pontos(
  p_limite INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_lim INTEGER := LEAST(GREATEST(COALESCE(p_limite, 25), 1), 100);
  v_off INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_carteira RECORD;
  v_movs JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  PERFORM public._processar_expiracao_pontos_cliente(v_cli_id, NOW());

  SELECT
    COALESCE(saldo_pontos, 0) AS saldo_pontos,
    COALESCE(pontos_acumulados_total, 0) AS pontos_acumulados_total,
    COALESCE(pontos_resgatados_total, 0) AS pontos_resgatados_total,
    COALESCE(pontos_expirados_total, 0) AS pontos_expirados_total
  INTO v_carteira
  FROM public.cliente_pontos
  WHERE cliente_id = v_cli_id;

  SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb)
  INTO v_movs
  FROM (
    SELECT
      pm.id,
      pm.tipo,
      pm.natureza,
      pm.pontos,
      pm.saldo_anterior,
      pm.saldo_posterior,
      pm.pedido_id,
      pm.expira_em,
      pm.motivo,
      pm.created_at
    FROM public.cliente_pontos_movimentacoes pm
    WHERE pm.cliente_id = v_cli_id
    ORDER BY pm.created_at DESC, pm.id DESC
    LIMIT v_lim OFFSET v_off
  ) m;

  RETURN jsonb_build_object(
    'success', true,
    'natureza_carteira', 'beneficio_promocional',
    'unidade', 'pts',
    'saldo_pontos', COALESCE(v_carteira.saldo_pontos, 0),
    'pontos_acumulados_total', COALESCE(v_carteira.pontos_acumulados_total, 0),
    'pontos_resgatados_total', COALESCE(v_carteira.pontos_resgatados_total, 0),
    'pontos_expirados_total', COALESCE(v_carteira.pontos_expirados_total, 0),
    'movimentacoes', v_movs
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_meu_extrato_pontos(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_meu_extrato_pontos(INTEGER, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 8. MEUS CUPONS PROMOCIONAIS ELEGÍVEIS E UTILIZADOS (GATE J12)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.listar_meus_cupons()
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_disponiveis JSONB;
  v_utilizados JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Gate J12: Retorna apenas cupons ativos, dentro da vigência e cujo limite global e por cliente ainda não foi atingido
  SELECT COALESCE(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.validade_fim ASC, c.cupom_id DESC), '[]'::jsonb)
  INTO v_disponiveis
  FROM (
    SELECT
      cp.id AS cupom_id,
      cp.codigo,
      cp.descricao,
      cp.tipo,
      ROUND(cp.valor, 2) AS valor,
      ROUND(COALESCE(cp.pedido_minimo, 0.00), 2) AS pedido_minimo,
      CASE WHEN cp.desconto_maximo IS NOT NULL THEN ROUND(cp.desconto_maximo, 2) ELSE NULL END AS desconto_maximo,
      cp.validade_fim
    FROM public.cupons_promocionais cp
    WHERE cp.ativo = true
      AND cp.validade_inicio <= NOW()
      AND cp.validade_fim >= NOW()
      AND (
        cp.uso_maximo_global IS NULL
        OR (SELECT COUNT(*) FROM public.cupom_utilizacoes cu WHERE cu.cupom_id = cp.id AND cu.status = 'aplicado') < cp.uso_maximo_global
      )
      AND (
        cp.uso_maximo_cliente IS NULL
        OR (SELECT COUNT(*) FROM public.cupom_utilizacoes cu WHERE cu.cupom_id = cp.id AND cu.cliente_id = v_cli_id AND cu.status = 'aplicado') < cp.uso_maximo_cliente
      )
      -- Se o cupom for vinculado a uma campanha específica que teve disparo segmentado,
      -- exibe apenas se a campanha for geral (sem campanha_publicos restrito) ou se o cliente foi público elegível
      AND (
        cp.campanha_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.campanha_publicos pub WHERE pub.campanha_id = cp.campanha_id)
        OR EXISTS (SELECT 1 FROM public.campanha_publicos pub WHERE pub.campanha_id = cp.campanha_id AND pub.cliente_id = v_cli_id)
      )
  ) c;

  SELECT COALESCE(jsonb_agg(row_to_json(u)::jsonb ORDER BY u.created_at DESC), '[]'::jsonb)
  INTO v_utilizados
  FROM (
    SELECT
      cu.id AS utilizacao_id,
      cp.codigo,
      cp.descricao,
      cu.pedido_id,
      ROUND(cu.valor_desconto_cupom, 2) AS valor_desconto_aplicado,
      cu.status,
      cu.created_at
    FROM public.cupom_utilizacoes cu
    JOIN public.cupons_promocionais cp ON cp.id = cu.cupom_id
    WHERE cu.cliente_id = v_cli_id
    ORDER BY cu.created_at DESC
    LIMIT 30
  ) u;

  RETURN jsonb_build_object(
    'success', true,
    'cupons_disponiveis', v_disponiveis,
    'historico_utilizacoes', v_utilizados
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_meus_cupons() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_meus_cupons() TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 9. HISTÓRICO SANITIZADO DE COMUNICAÇÕES DO CLIENTE
-- ------------------------------------------------------------------------------
-- Retorna somente tipo, canal, status público amigável, descrição amigável e data.
CREATE OR REPLACE FUNCTION public.listar_minhas_comunicacoes(
  p_limite INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_lim INTEGER := LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50);
  v_off INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_lista JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  SELECT COALESCE(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.data DESC, c.id DESC), '[]'::jsonb)
  INTO v_lista
  FROM (
    SELECT
      cc.id,
      cc.tipo,
      CASE
        WHEN cc.canal IN ('whatsapp_link', 'evolution_api', 'whatsapp_marketing') THEN 'whatsapp'
        ELSE cc.canal
      END AS canal,
      CASE
        WHEN cc.status IN ('enviado', 'entregue') THEN 'enviado'
        WHEN cc.status IN ('link_aberto', 'gerado') THEN 'disponibilizado'
        ELSE 'processado'
      END AS status_publico,
      CASE cc.tipo
        WHEN 'ORCAMENTO_ENVIADO' THEN 'Proposta de orçamento disponibilizada'
        WHEN 'ORCAMENTO_VENCENDO' THEN 'Lembrete de validade de orçamento'
        WHEN 'SINAL_CONFIRMADO' THEN 'Confirmação de recebimento de sinal'
        WHEN 'PEDIDO_PRONTO' THEN 'Aviso de encomenda pronta'
        WHEN 'SAIU_PARA_ENTREGA' THEN 'Aviso de saída para entrega'
        WHEN 'CUPOM_ANIVERSARIO' THEN 'Presente de aniversário Lunoca'
        WHEN 'VOLTE_A_COMPRAR' THEN 'Convite especial de recompra'
        WHEN 'CAMPANHA_PASCOA' THEN 'Novidades sazonais de Páscoa'
        WHEN 'CAMPANHA_PROMOCIONAL' THEN 'Comunicado promocional Lunoca'
        WHEN 'LEMBRETE_PONTOS_EXPIRANDO' THEN 'Aviso de pontos próximos de expirar'
        ELSE 'Notificação de atendimento Lunoca'
      END AS descricao,
      COALESCE(cc.enviado_em, cc.created_at) AS data
    FROM public.comunicacoes_cliente cc
    WHERE cc.cliente_id = v_cli_id
       OR (cc.pedido_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.pedidos p WHERE p.id = cc.pedido_id AND p.cliente_id_rel = v_cli_id))
       OR (cc.orcamento_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.orcamentos o WHERE o.id = cc.orcamento_id AND o.cliente_id = v_cli_id))
    ORDER BY COALESCE(cc.enviado_em, cc.created_at) DESC, cc.id DESC
    LIMIT v_lim OFFSET v_off
  ) c;

  RETURN jsonb_build_object(
    'success', true,
    'comunicacoes', v_lista
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.listar_minhas_comunicacoes(INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_minhas_comunicacoes(INTEGER, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 10. ATUALIZAR MINHAS PREFERÊNCIAS SELF-SERVICE (GATES J13, J14)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atualizar_minhas_preferencias_cliente(
  p_categoria TEXT,
  p_valor TEXT,
  p_observacao TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_cat TEXT := LOWER(TRIM(COALESCE(p_categoria, '')));
  v_val TEXT := NULLIF(TRIM(COALESCE(p_valor, '')), '');
  v_obs TEXT := NULLIF(TRIM(COALESCE(p_observacao, '')), '');
  v_pref_id BIGINT;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  -- Gate J13: Restrito exclusivamente às 5 categorias self-service autorizadas para o cliente
  IF v_cat NOT IN ('sabor', 'decoracao', 'ocasiao', 'restricao_alimentar', 'embalagem') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PREFERENCE_CATEGORY',
      'error', 'Categoria não permitida no autoatendimento. Escolha entre sabor, decoracao, ocasiao, restricao_alimentar ou embalagem.'
    );
  END IF;

  IF v_val IS NULL OR char_length(v_val) < 2 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PREFERENCE_VALUE',
      'error', 'Informe uma preferência válida com pelo menos 2 caracteres.'
    );
  END IF;

  -- Desativa declaração anterior da mesma categoria para manter o estado atual limpo e histórico preservado
  UPDATE public.cliente_preferencias
  SET ativo = false,
      updated_at = NOW()
  WHERE cliente_id = v_cli_id
    AND categoria = v_cat
    AND ativo = true;

  INSERT INTO public.cliente_preferencias (
    cliente_id,
    categoria,
    valor,
    observacao,
    ativo,
    criado_por,
    created_at,
    updated_at
  ) VALUES (
    v_cli_id,
    v_cat,
    v_val,
    COALESCE(v_obs, 'Declarado pelo próprio cliente no Portal Minha Conta'),
    true,
    auth.uid(),
    NOW(),
    NOW()
  )
  RETURNING id INTO v_pref_id;

  RETURN jsonb_build_object(
    'success', true,
    'preferencia_id', v_pref_id,
    'categoria', v_cat,
    'valor', v_val,
    'declarado_pelo_cliente', true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.atualizar_minhas_preferencias_cliente(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atualizar_minhas_preferencias_cliente(TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 11. ATUALIZAR MEU CONSENTIMENTO DE MARKETING (GATES J15, J16)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atualizar_meu_consentimento_marketing(
  p_canal TEXT DEFAULT 'whatsapp_marketing',
  p_status TEXT DEFAULT 'opt_out',
  p_versao_termo TEXT DEFAULT 'v1.0-portal'
)
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_canal TEXT := LOWER(TRIM(COALESCE(p_canal, 'whatsapp_marketing')));
  v_status TEXT := LOWER(TRIM(COALESCE(p_status, '')));
  v_versao TEXT := COALESCE(NULLIF(TRIM(p_versao_termo), ''), 'v1.0-portal');
  v_id BIGINT;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  IF v_canal NOT IN ('whatsapp_marketing', 'email_marketing', 'sms_marketing') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_MARKETING_CHANNEL',
      'error', 'Canal de marketing inválido.'
    );
  END IF;

  IF v_status NOT IN ('opt_in', 'opt_out') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_CONSENT_STATUS',
      'error', 'O status de consentimento deve ser opt_in ou opt_out.'
    );
  END IF;

  -- Registro append-only auditável em cliente_consentimentos_marketing
  INSERT INTO public.cliente_consentimentos_marketing (
    cliente_id,
    canal,
    status,
    origem,
    versao_termo,
    observacao,
    registrado_por,
    data_hora
  ) VALUES (
    v_cli_id,
    v_canal,
    v_status,
    'portal_cliente',
    v_versao,
    'Atualizado pelo titular via Portal Minha Conta (auth.uid=' || auth.uid()::TEXT || ')',
    auth.uid(),
    NOW()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'consentimento_id', v_id,
    'canal', v_canal,
    'status', v_status,
    'origem', 'portal_cliente',
    'versao_termo', v_versao,
    'registrado_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.atualizar_meu_consentimento_marketing(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.atualizar_meu_consentimento_marketing(TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 12. SANEAMENTO DE OBTER_MEU_PERFIL_360 LEGADO (MIGRATION 019) PARA NÃO EXPOR TOKEN_PUBLICO
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obter_meu_perfil_360()
RETURNS JSONB AS $$
DECLARE
  v_ident JSONB := public._resolver_meu_cliente_id();
  v_cli_id BIGINT;
  v_saldo NUMERIC(10,2) := 0.00;
  v_pedidos JSONB;
  v_orcamentos JSONB;
BEGIN
  IF (v_ident->>'success')::BOOLEAN IS NOT TRUE THEN
    RETURN v_ident;
  END IF;

  v_cli_id := (v_ident->>'cliente_id')::BIGINT;

  SELECT COALESCE(saldo, 0.00) INTO v_saldo
  FROM public.cliente_creditos
  WHERE cliente_id = v_cli_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'total', total,
      'status_comercial', status_comercial,
      'etapa_cliente', public._derivar_etapa_cliente_pedido(status_comercial, status_operacional, modalidade_entrega),
      'status_financeiro', status_financeiro,
      'data_entrega', data_entrega,
      'created_at', created_at
    ) ORDER BY created_at DESC
  ), '[]'::jsonb) INTO v_pedidos
  FROM public.pedidos
  WHERE cliente_id_rel = v_cli_id;

  -- Sem token_publico
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', id,
      'numero', numero,
      'versao', versao,
      'status', status,
      'total', total,
      'data_evento', data_evento,
      'validade_ate', validade_ate,
      'created_at', created_at
    ) ORDER BY created_at DESC
  ), '[]'::jsonb) INTO v_orcamentos
  FROM public.orcamentos
  WHERE cliente_id = v_cli_id;

  RETURN jsonb_build_object(
    'success', true,
    'cliente', jsonb_build_object(
      'id', v_cli_id,
      'nome', v_ident->>'nome',
      'telefone', v_ident->>'telefone',
      'email', v_ident->>'email',
      'endereco_padrao', v_ident->'endereco_padrao'
    ),
    'credito', jsonb_build_object(
      'saldo', v_saldo
    ),
    'pedidos', v_pedidos,
    'orcamentos', v_orcamentos
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.obter_meu_perfil_360() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.obter_meu_perfil_360() TO authenticated, service_role;
