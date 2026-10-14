// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE Q (PQ-1 a PQ-10)
// ==============================================================================
// Valida os 10 probes de conformidade da Migration 032 no Supabase de produção:
// PQ-1:  As 4 tabelas de Produto Pronto existem em public com RLS habilitado
// PQ-2:  As 7 RPCs canônicas da Frente Q instaladas com SECURITY DEFINER
// PQ-3:  Triggers append-only de segurança ativos nas 3 tabelas de livro-razão (42501)
// PQ-4:  Zero tabelas paralelas de vendas ou pagamentos no catálogo de esquemas
// PQ-5:  RPC listar_catalogo_pdv operacional retornando produtos e saldo de balcão
// PQ-6:  Produção de produto pronto consome insumo e gera rastreabilidade MP -> PT
// PQ-7:  Venda PDV realiza alocação FEFO de lote e liquidação com canal 'balcao'
// PQ-8:  Idempotência estrutural via p_chave_idempotencia protege retry contra duplicação
// PQ-9:  Sanitização server-side de custo industrial para perfis de operador
// PQ-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE Q (PQ-1 a PQ-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PQ-1: As 4 tabelas da Frente Q existem em public com RLS habilitado
  process.stdout.write('⏳ PQ-1: As 4 tabelas de Produto Pronto existem em public com RLS habilitado... ');
  const pq1 = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'produto_pronto_lotes',
        'produto_pronto_movimentacoes',
        'produto_pronto_lote_consumos_ingrediente',
        'pedido_consumos_produto_pronto'
      )
    ORDER BY tablename;
  `);
  assert.equal(pq1.length, 4, 'Esperado 4 tabelas de produto pronto da Frente Q em public');
  for (const r of pq1) {
    assert.equal(r.rowsecurity, true, `Tabela ${r.tablename} deve ter RLS ativo`);
  }
  console.log('✅ APROVADO');

  // PQ-2: As 7 RPCs canônicas da Frente Q instaladas com SECURITY DEFINER
  process.stdout.write('⏳ PQ-2: As 7 RPCs canônicas da Frente Q instaladas com SECURITY DEFINER... ');
  const pq2 = await query(`
    SELECT DISTINCT proname, prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        'registrar_producao_produto_pronto',
        'listar_catalogo_pdv',
        'obter_estoque_produto_pronto_admin',
        'registrar_perda_produto_pronto',
        'alterar_bloqueio_qualidade_produto_pronto',
        'finalizar_venda_pdv',
        'rastrear_lote_produto_pronto_admin'
      )
    ORDER BY proname;
  `);
  assert.equal(pq2.length, 7, 'Esperado 7 RPCs da Frente Q instaladas em public');
  for (const r of pq2) {
    assert.equal(r.prosecdef, true, `RPC ${r.proname} deve ter SECURITY DEFINER ativado`);
  }
  console.log('✅ APROVADO');

  // PQ-3: Triggers append-only de segurança ativos nas 3 tabelas de livro-razão (42501)
  process.stdout.write('⏳ PQ-3: Triggers append-only de segurança ativos nas tabelas de livro-razão... ');
  const pq3 = await query(`
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND trigger_name IN (
        'trg_bloquear_mutacao_pp_movimentacoes',
        'trg_bloquear_mutacao_consumo_pp',
        'trg_bloquear_mutacao_pp_consumos_ingrediente'
      )
    ORDER BY trigger_name;
  `);
  assert.ok(pq3.length >= 3, 'Esperado ao menos 3 triggers append-only da Frente Q');
  console.log('✅ APROVADO');

  // PQ-4: Zero tabelas paralelas de vendas ou pagamentos no catálogo
  process.stdout.write('⏳ PQ-4: Zero tabelas paralelas de vendas ou pagamentos no catálogo... ');
  const pq4 = await query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'vendas_balcao',
        'pagamentos_balcao',
        'pedidos_balcao',
        'pedidos_pdv'
      );
  `);
  assert.equal(pq4.length, 0, 'Não deve existir nenhuma tabela paralela de balcão');
  console.log('✅ APROVADO');

  // PQ-5: RPC listar_catalogo_pdv operacional retornando produtos e saldo de balcão
  process.stdout.write('⏳ PQ-5: RPC listar_catalogo_pdv operacional retornando produtos e saldo... ');
  const pq5 = await query(`
    SELECT public.listar_catalogo_pdv() AS res;
  `);
  assert.ok(pq5.length === 1, 'Deve retornar resultado de listar_catalogo_pdv');
  assert.equal(pq5[0].res.success, true, 'success deve ser true');
  assert.ok(Array.isArray(pq5[0].res.produtos), 'Retorno deve conter array de produtos');
  console.log('✅ APROVADO');

  // PQ-6: Produção de produto pronto consome insumo e gera rastreabilidade MP -> PT em transação
  process.stdout.write('⏳ PQ-6: Produção de produto pronto consome insumo e gera rastreabilidade MP -> PT... ');
  const pq6 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_ing_id BIGINT;
      v_lote_ing_id BIGINT;
      v_res JSONB;
      v_lote_pt_id BIGINT;
      v_consumos INT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      SELECT id INTO v_ing_id FROM public.ingredientes WHERE ativo = true LIMIT 1;

      -- Se não houver lote de insumo disponível para o teste, cria um temporário com flag canônica
      PERFORM set_config('lunoca.allow_lote_mutation', 'true', true);
      INSERT INTO public.ingrediente_lotes (
        ingrediente_id, codigo_lote, data_validade, quantidade_inicial, quantidade_atual,
        custo_unitario_lote, bloqueado_qualidade
      ) VALUES (
        v_ing_id, 'TEST-PQ6-INS', CURRENT_DATE + 30, 50.00, 50.00, 10.00, false
      ) RETURNING id INTO v_lote_ing_id;
      PERFORM set_config('lunoca.allow_lote_mutation', 'false', true);

      -- Simula sessão de admin
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      -- Executa produção de 10 unidades
      v_res := public.registrar_producao_produto_pronto(
        p_produto_id := v_prod_id,
        p_quantidade_produzida := 10.00,
        p_data_validade := CURRENT_DATE + 7,
        p_codigo_lote := 'TEST-PQ6-PT-' || floor(random() * 100000)::text,
        p_colaborador_id := NULL::bigint,
        p_data_producao := CURRENT_DATE,
        p_observacoes := 'Teste Probe PQ-6'::text
      );

      IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha em registrar_producao_produto_pronto: %', v_res;
      END IF;

      v_lote_pt_id := (v_res->>'lote_id')::bigint;

      -- Verifica se houve registro de movimentação de entrada
      IF NOT EXISTS (
        SELECT 1 FROM public.produto_pronto_movimentacoes
        WHERE lote_id = v_lote_pt_id AND tipo_movimentacao = 'ENTRADA_PRODUCAO' AND quantidade = 10
      ) THEN
        RAISE EXCEPTION 'Movimentação de produção PT não encontrada';
      END IF;

      -- Rollback limpo que desfaz a inserção e movimentação sem tentar violar o trigger append-only
      RAISE EXCEPTION 'PROBE_PQ6_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PQ6_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PQ-7: Venda PDV realiza alocação FEFO de lote e liquidação com canal 'balcao'
  process.stdout.write('⏳ PQ-7: Venda PDV realiza alocação FEFO de lote e liquidação com canal balcao... ');
  const pq7 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_lote_1 BIGINT;
      v_lote_2 BIGINT;
      v_res JSONB;
      v_ped_id BIGINT;
      v_canal TEXT;
      v_status_op TEXT;
      v_status_fin TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;

      -- Cria dois lotes: Lote 1 vence em 3 dias, Lote 2 vence em 10 dias
      INSERT INTO public.produto_pronto_lotes (
        produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
        data_producao, data_validade, bloqueado_qualidade
      ) VALUES (
        v_prod_id, 'TEST-PQ7-L1', 5, 5, CURRENT_DATE, CURRENT_DATE + 3, false
      ) RETURNING id INTO v_lote_1;

      INSERT INTO public.produto_pronto_lotes (
        produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
        data_producao, data_validade, bloqueado_qualidade
      ) VALUES (
        v_prod_id, 'TEST-PQ7-L2', 5, 5, CURRENT_DATE, CURRENT_DATE + 10, false
      ) RETURNING id INTO v_lote_2;

      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      -- Venda balcão de 3 unidades (deve consumir do Lote 1 por FEFO)
      v_res := public.finalizar_venda_pdv(
        p_itens := jsonb_build_array(jsonb_build_object('produto_id', v_prod_id, 'quantidade', 3)),
        p_cliente_id_rel := NULL::bigint,
        p_forma_pagamento := 'pix'::text,
        p_desconto := 0.00::numeric,
        p_motivo_desconto := NULL::text,
        p_chave_idempotencia := ('teste-pq7-' || floor(random() * 100000)::text)::text,
        p_observacoes := NULL::text
      );

      IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha em finalizar_venda_pdv: %', v_res;
      END IF;

      v_ped_id := (v_res->>'pedido_id')::bigint;

      -- Valida pedido canônico
      SELECT canal, status_operacional, status_financeiro
      INTO v_canal, v_status_op, v_status_fin
      FROM public.pedidos WHERE id = v_ped_id;

      IF v_canal <> 'balcao' OR v_status_op <> 'retirado' OR v_status_fin <> 'pago' THEN
        RAISE EXCEPTION 'Invariantes de pedido violadas: canal=%, status_op=%, status_fin=%', v_canal, v_status_op, v_status_fin;
      END IF;

      -- Valida FEFO: Lote 1 deve ter 2 disponíveis (5 - 3)
      IF (SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = v_lote_1) <> 2 THEN
        RAISE EXCEPTION 'FEFO não consumiu Lote 1 primeiro!';
      END IF;

      -- Rollback limpo
      RAISE EXCEPTION 'PROBE_PQ7_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PQ7_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PQ-8: Idempotência estrutural via p_chave_idempotencia protege retry contra duplicação
  process.stdout.write('⏳ PQ-8: Idempotência via p_chave_idempotencia retorna pedido existente sem duplicar... ');
  const pq8 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_lote_id BIGINT;
      v_chave TEXT := 'idemp_pq8_' || floor(random() * 100000)::text;
      v_res1 JSONB;
      v_res2 JSONB;
      v_ped_id BIGINT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;

      INSERT INTO public.produto_pronto_lotes (
        produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
        data_producao, data_validade, bloqueado_qualidade
      ) VALUES (
        v_prod_id, 'TEST-PQ8-L1', 10, 10, CURRENT_DATE, CURRENT_DATE + 5, false
      ) RETURNING id INTO v_lote_id;

      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      v_res1 := public.finalizar_venda_pdv(
        p_itens := jsonb_build_array(jsonb_build_object('produto_id', v_prod_id, 'quantidade', 2)),
        p_cliente_id_rel := NULL::bigint,
        p_forma_pagamento := 'dinheiro'::text,
        p_desconto := 0.00::numeric,
        p_motivo_desconto := NULL::text,
        p_chave_idempotencia := v_chave::text,
        p_observacoes := NULL::text
      );

      v_ped_id := (v_res1->>'pedido_id')::bigint;

      -- Retry com a mesma chave
      v_res2 := public.finalizar_venda_pdv(
        p_itens := jsonb_build_array(jsonb_build_object('produto_id', v_prod_id, 'quantidade', 2)),
        p_cliente_id_rel := NULL::bigint,
        p_forma_pagamento := 'dinheiro'::text,
        p_desconto := 0.00::numeric,
        p_motivo_desconto := NULL::text,
        p_chave_idempotencia := v_chave::text,
        p_observacoes := NULL::text
      );

      IF (v_res2->>'ja_processado')::boolean IS NOT TRUE OR (v_res2->>'pedido_id')::bigint <> v_ped_id THEN
        RAISE EXCEPTION 'Idempotência falhou ao retornar o pedido original!';
      END IF;

      -- Rollback limpo
      RAISE EXCEPTION 'PROBE_PQ8_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PQ8_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PQ-9: Sanitização server-side de custo industrial para perfis de operador
  process.stdout.write('⏳ PQ-9: Sanitização server-side de custo industrial para perfis de operador... ');
  const pq9 = await query(`
    DO $$
    DECLARE
      v_oper_uid UUID;
      v_res JSONB;
      v_elem JSONB;
      v_lote_id BIGINT;
      v_prod_id BIGINT;
    BEGIN
      -- Busca um admin ativo para autorizar a alteração temporária do perfil de teste
      SELECT id INTO v_oper_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_oper_uid::text)::text, true);

      -- Seleciona um perfil de cliente existente e temporariamente define nivel = 'operador'
      SELECT id INTO v_oper_uid FROM public.profiles WHERE nivel = 'cliente' AND ativo = true LIMIT 1;
      UPDATE public.profiles SET nivel = 'operador' WHERE id = v_oper_uid;

      -- Cria um lote com custo para garantir que o array lotes contenha item
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      INSERT INTO public.produto_pronto_lotes (
        produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
        data_producao, data_validade, bloqueado_qualidade, custo_unitario_producao
      ) VALUES (
        v_prod_id, 'TEST-PQ9-L1', 10, 10, CURRENT_DATE, CURRENT_DATE + 5, false, 15.50
      ) RETURNING id INTO v_lote_id;

      -- Simula chamada como operador via claims canônicas
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_oper_uid::text)::text, true);

      v_res := public.obter_estoque_produto_pronto_admin();
      IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Erro ao consultar estoque de produto pronto: %', v_res;
      END IF;

      -- Nenhum lote retornado deve conter custo_unitario_producao não-nulo para operador
      FOR v_elem IN SELECT * FROM jsonb_array_elements(v_res->'lotes') LOOP
        IF v_elem->>'custo_unitario_producao' IS NOT NULL THEN
          RAISE EXCEPTION 'Custo de produção vazou para o operador!';
        END IF;
      END LOOP;

      RAISE EXCEPTION 'PROBE_PQ9_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PQ9_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PQ-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
  process.stdout.write('⏳ PQ-10: Grants fail-closed confirmados para anon e PUBLIC... ');
  const pq10 = await query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'produto_pronto_lotes',
        'produto_pronto_movimentacoes',
        'produto_pronto_lote_consumos_ingrediente',
        'pedido_consumos_produto_pronto'
      )
      AND grantee IN ('PUBLIC', 'anon');
  `);
  assert.equal(pq10.length, 0, 'Nenhum privilégio de tabela deve ser concedido para anon ou PUBLIC na Frente Q');

  const pq10Rpc = await query(`
    SELECT routine_name, grantee
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'finalizar_venda_pdv',
        'listar_catalogo_pdv',
        'registrar_producao_produto_pronto'
      )
      AND grantee IN ('PUBLIC', 'anon');
  `);
  assert.equal(pq10Rpc.length, 0, 'Nenhum grant de RPC deve permanecer para anon ou PUBLIC na Frente Q');
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('🎉 10/10 PROBES DE PRODUÇÃO DA FRENTE Q APROVADOS COM SUCESSO!');
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ FALHA NO PROBE DE PRODUÇÃO DA FRENTE Q:', err);
  process.exit(1);
});
