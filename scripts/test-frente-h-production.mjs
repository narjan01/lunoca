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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE H (PH-1 a PH-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  try {
    // --------------------------------------------------------------------------
    // PH-1: Tabelas da Frente H existem no schema public (e sem duplicar fluxo_caixa_lancamentos)
    // --------------------------------------------------------------------------
    await runProbe('PH-1: Tabelas contas_financeiras, conciliacoes_financeiras e ajustes_tesouraria existem (sem duplicar livro de fluxo)', async () => {
      const rows = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'contas_financeiras',
            'conciliacoes_financeiras',
            'ajustes_tesouraria'
          )
        ORDER BY table_name;
      `);
      assert(rows.length === 3, `Esperado 3 tabelas, encontrado ${rows.length}`);

      const dup = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'fluxo_caixa_lancamentos';
      `);
      assert(dup.length === 0, 'Não deve existir tabela duplicada fluxo_caixa_lancamentos');
    });

    // --------------------------------------------------------------------------
    // PH-2: RLS habilitado nas 3 tabelas da Frente H
    // --------------------------------------------------------------------------
    await runProbe('PH-2: RLS habilitado em todas as 3 tabelas da Frente H', async () => {
      const rows = await query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'contas_financeiras',
            'conciliacoes_financeiras',
            'ajustes_tesouraria'
          );
      `);
      assert(rows.length === 3, `Esperado 3 tabelas, encontrado ${rows.length}`);
      for (const r of rows) {
        assert(r.rowsecurity === true, `RLS desabilitado em ${r.tablename}`);
      }
    });

    // --------------------------------------------------------------------------
    // PH-3: RPCs e helper da Frente H existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PH-3: RPCs de tesouraria, fluxo de caixa e conciliação existem no schema public', async () => {
      const rows = await query(`
        SELECT proname
        FROM pg_proc
        JOIN pg_namespace n ON n.oid = pg_proc.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN (
            '_tesouraria_data_efetiva_lancamento',
            'salvar_conta_financeira_admin',
            'registrar_ajuste_tesouraria_admin',
            'registrar_conciliacao_financeira_admin',
            'obter_contas_pagar_periodo_admin',
            'obter_recebimentos_previstos_admin',
            'obter_fluxo_caixa_admin',
            'obter_posicao_tesouraria_admin',
            'obter_conciliacao_financeira_admin'
          );
      `);
      assert(rows.length === 9, `Esperado 9 funções, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PH-4: Permissões revogadas para anon e PUBLIC nas RPCs da Frente H
    // --------------------------------------------------------------------------
    await runProbe('PH-4: Permissões revogadas para anon e PUBLIC nas RPCs da Frente H', async () => {
      const rows = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name IN (
            '_tesouraria_data_efetiva_lancamento',
            'salvar_conta_financeira_admin',
            'registrar_ajuste_tesouraria_admin',
            'registrar_conciliacao_financeira_admin',
            'obter_contas_pagar_periodo_admin',
            'obter_recebimentos_previstos_admin',
            'obter_fluxo_caixa_admin',
            'obter_posicao_tesouraria_admin',
            'obter_conciliacao_financeira_admin'
          )
          AND grantee IN ('anon', 'PUBLIC');
      `);
      assert(rows.length === 0, `Encontradas permissões indevidas: ${JSON.stringify(rows)}`);
    });

    // --------------------------------------------------------------------------
    // PH-5: Helper interno _tesouraria_data_efetiva_lancamento restrito a service_role
    // --------------------------------------------------------------------------
    await runProbe('PH-5: _tesouraria_data_efetiva_lancamento bloqueado para authenticated', async () => {
      const rows = await query(`
        SELECT grantee
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name = '_tesouraria_data_efetiva_lancamento'
          AND grantee = 'authenticated';
      `);
      assert(rows.length === 0, '_tesouraria_data_efetiva_lancamento não deve ser executável diretamente por authenticated');
    });

    // --------------------------------------------------------------------------
    // PH-6: Triggers de imutabilidade append-only ativos em conciliacoes_financeiras e ajustes_tesouraria
    // --------------------------------------------------------------------------
    await runProbe('PH-6: Triggers trg_imutabilidade_conciliacoes_fin e trg_imutabilidade_ajustes_tesouraria ativos', async () => {
      const rows = await query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname IN ('trg_imutabilidade_conciliacoes_fin', 'trg_imutabilidade_ajustes_tesouraria');
      `);
      assert(rows.length === 2, `Esperado 2 triggers de imutabilidade, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PH-7: Contas financeiras padrão inicializadas com sucesso
    // --------------------------------------------------------------------------
    await runProbe('PH-7: Contas financeiras padrão (caixa_fisico, conta_pix_principal, gateway_mercadopago) existem', async () => {
      const rows = await query(`
        SELECT codigo
        FROM public.contas_financeiras
        WHERE codigo IN ('caixa_fisico', 'conta_pix_principal', 'gateway_mercadopago');
      `);
      assert(rows.length === 3, `Esperado 3 contas padrão, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PH-8: obter_posicao_tesouraria_admin retorna estrutura completa e segregada
    // --------------------------------------------------------------------------
    await runProbe('PH-8: obter_posicao_tesouraria_admin retorna saldos realizados, projetados e passivo de créditos', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_posicao_tesouraria_admin(30) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('saldo_caixa_realizado_atual' in res, 'Deve conter saldo_caixa_realizado_atual');
      assert('saldo_caixa_projetado' in res, 'Deve conter saldo_caixa_projetado');
      assert('necessidade_caixa' in res, 'Deve conter necessidade_caixa');
      assert('passivo_creditos_clientes' in res, 'Deve conter passivo_creditos_clientes');
      assert(Array.isArray(res.contas_financeiras), 'Deve retornar array contas_financeiras');
    });

    // --------------------------------------------------------------------------
    // PH-9: obter_fluxo_caixa_admin reconcilia com financeiro_lancamentos e retorna série diária
    // --------------------------------------------------------------------------
    await runProbe('PH-9: obter_fluxo_caixa_admin retorna resumo e série diária com saldo acumulado', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_fluxo_caixa_admin(NULL, NULL) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert(res.periodo?.timezone === 'America/Fortaleza', 'Timezone deve ser America/Fortaleza');
      assert('entradas_liquidas_realizadas' in res.resumo, 'Deve conter entradas_liquidas_realizadas');
      assert('liquido_projetado' in res.resumo, 'Deve conter liquido_projetado');
      assert(Array.isArray(res.diario) && res.diario.length > 0, 'Deve conter série diária');
    });

    // --------------------------------------------------------------------------
    // PH-10: obter_conciliacao_financeira_admin e obter_recebimentos_previstos_admin executam com sucesso
    // --------------------------------------------------------------------------
    await runProbe('PH-10: obter_conciliacao_financeira_admin e obter_recebimentos_previstos_admin retornam envelopes válidos', async () => {
      const rows = await adminQuery(`
        SELECT
          public.obter_conciliacao_financeira_admin(NULL, NULL, NULL) AS conc,
          public.obter_recebimentos_previstos_admin(NULL, NULL) AS rec;
      `);
      assert(rows[0].conc.success === true, 'Conciliação deve retornar success: true');
      assert(rows[0].rec.success === true, 'Recebimentos previstos deve retornar success: true');
    });

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DA FRENTE H FORAM HOMOLOGADOS!`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('\n❌ Falha na bateria de probes da Frente H:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
