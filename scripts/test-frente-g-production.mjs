import { query } from './supabase-client.mjs';

let passedProbes = 0;
const totalProbes = 10;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function adminQuery(sql) {
  const fullSql = `SET LOCAL "request.jwt.claim.role" = 'service_role';\n${sql}`;
  return query(fullSql);
}

async function runProbe(name, fn) {
  try {
    process.stdout.write(`⏳ ${name}... `);
    await fn();
    console.log(`✅ APROVADO`);
    passedProbes++;
  } catch (err) {
    console.log(`❌ FALHOU: ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('\n============================================================');
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE G (PG-1 a PG-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  try {
    // --------------------------------------------------------------------------
    // PG-1: Tabelas da Frente G existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PG-1: Tabelas fornecedores, compras, compra_itens, ingrediente_saldos, ingrediente_movimentacoes e contas_pagar existem', async () => {
      const rows = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'fornecedores',
            'compras',
            'compra_itens',
            'ingrediente_saldos',
            'ingrediente_movimentacoes',
            'contas_pagar'
          )
        ORDER BY table_name;
      `);
      assert(rows.length === 6, `Esperado 6 tabelas, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PG-2: RLS habilitado nas 6 tabelas da Frente G
    // --------------------------------------------------------------------------
    await runProbe('PG-2: RLS habilitado em todas as 6 tabelas da Frente G', async () => {
      const rows = await query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'fornecedores',
            'compras',
            'compra_itens',
            'ingrediente_saldos',
            'ingrediente_movimentacoes',
            'contas_pagar'
          );
      `);
      assert(rows.length === 6, `Esperado 6 tabelas, encontrado ${rows.length}`);
      for (const r of rows) {
        assert(r.rowsecurity === true, `RLS desabilitado em ${r.tablename}`);
      }
    });

    // --------------------------------------------------------------------------
    // PG-3: Funções / RPCs da Frente G existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PG-3: RPCs transacionais da Frente G existem no schema public', async () => {
      const rows = await query(`
        SELECT proname
        FROM pg_proc
        JOIN pg_namespace n ON n.oid = pg_proc.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN (
            '_aplicar_movimento_ingrediente',
            'salvar_fornecedor_admin',
            'listar_fornecedores_admin',
            'criar_compra',
            'receber_compra',
            'cancelar_compra',
            'registrar_perda_insumo',
            'ajustar_estoque_insumo_admin',
            'registrar_pagamento_fornecedor',
            'obter_necessidade_reposicao',
            'obter_cmv_real_produto'
          );
      `);
      assert(rows.length === 11, `Esperado 11 funções, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PG-4: Permissões revogadas para anon e PUBLIC nas RPCs da Frente G
    // --------------------------------------------------------------------------
    await runProbe('PG-4: Permissões revogadas para anon e PUBLIC nas RPCs de compras e insumos', async () => {
      const rows = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name IN (
            '_aplicar_movimento_ingrediente',
            'salvar_fornecedor_admin',
            'listar_fornecedores_admin',
            'criar_compra',
            'receber_compra',
            'cancelar_compra',
            'registrar_perda_insumo',
            'ajustar_estoque_insumo_admin',
            'registrar_pagamento_fornecedor',
            'obter_necessidade_reposicao',
            'obter_cmv_real_produto'
          )
          AND grantee IN ('anon', 'PUBLIC');
      `);
      assert(rows.length === 0, `Encontradas permissões indevidas: ${JSON.stringify(rows)}`);
    });

    // --------------------------------------------------------------------------
    // PG-5: Função interna _aplicar_movimento_ingrediente bloqueada para authenticated
    // --------------------------------------------------------------------------
    await runProbe('PG-5: _aplicar_movimento_ingrediente restrita exclusivamente a service_role', async () => {
      const rows = await query(`
        SELECT grantee
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name = '_aplicar_movimento_ingrediente'
          AND grantee = 'authenticated';
      `);
      assert(rows.length === 0, '_aplicar_movimento_ingrediente não deve ser executável diretamente por authenticated');
    });

    // --------------------------------------------------------------------------
    // PG-6: Trigger de imutabilidade em ingrediente_movimentacoes existe
    // --------------------------------------------------------------------------
    await runProbe('PG-6: Trigger trg_imutabilidade_ingrediente_mov protege o livro-razão', async () => {
      const rows = await query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname = 'trg_imutabilidade_ingrediente_mov';
      `);
      assert(rows.length === 1, 'Trigger trg_imutabilidade_ingrediente_mov não encontrado');
    });

    // --------------------------------------------------------------------------
    // PG-7: Paridade entre ingredientes e ingrediente_saldos
    // --------------------------------------------------------------------------
    await runProbe('PG-7: Todos os ingredientes ativos possuem registro correspondente em ingrediente_saldos', async () => {
      const rows = await query(`
        SELECT COUNT(*)::int AS faltantes
        FROM public.ingredientes i
        LEFT JOIN public.ingrediente_saldos s ON s.ingrediente_id = i.id
        WHERE s.ingrediente_id IS NULL;
      `);
      assert(rows[0].faltantes === 0, `Existem ${rows[0].faltantes} ingredientes sem registro em ingrediente_saldos`);
    });

    // --------------------------------------------------------------------------
    // PG-8: obter_necessidade_reposicao executa e retorna estrutura esperada
    // --------------------------------------------------------------------------
    await runProbe('PG-8: obter_necessidade_reposicao retorna envelope canônico com análise de reposição', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_necessidade_reposicao(7) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert(Array.isArray(res.itens), 'Deve retornar array de itens');
      assert(res.horizonte_dias === 7, 'Horizonte deve ser 7 dias');
    });

    // --------------------------------------------------------------------------
    // PG-9: obter_cmv_real_produto retorna custo_teorico_receita e cmv_real separados
    // --------------------------------------------------------------------------
    await runProbe('PG-9: obter_cmv_real_produto segrega custo_teorico_receita de cmv_real', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_cmv_real_produto(NULL) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert(Array.isArray(res.produtos), 'Deve retornar array de produtos');
      if (res.produtos.length > 0) {
        const p = res.produtos[0];
        assert('custo_teorico_receita' in p, 'Deve conter custo_teorico_receita');
        assert('cmv_real' in p, 'Deve conter cmv_real');
        assert('margem_teorica_pct' in p, 'Deve conter margem_teorica_pct');
        assert('margem_real_pct' in p, 'Deve conter margem_real_pct');
      }
    });

    // --------------------------------------------------------------------------
    // PG-10: listar_fornecedores_admin executa com sucesso
    // --------------------------------------------------------------------------
    await runProbe('PG-10: listar_fornecedores_admin retorna envelope canônico', async () => {
      const rows = await adminQuery(`
        SELECT public.listar_fornecedores_admin(false) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert(Array.isArray(res.fornecedores), 'Deve retornar array de fornecedores');
    });

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DA FRENTE G FORAM HOMOLOGADOS!`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('\n❌ Falha na bateria de probes da Frente G:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
