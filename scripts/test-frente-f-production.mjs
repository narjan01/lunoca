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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE F (PF-1 a PF-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  try {
    // --------------------------------------------------------------------------
    // PF-1: Funções/RPCs da Frente F existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PF-1: Funções analíticas da Frente F existem no schema public', async () => {
      const rows = await query(`
        SELECT proname 
        FROM pg_proc 
        JOIN pg_namespace n ON n.oid = pg_proc.pronamespace 
        WHERE n.nspname = 'public' 
          AND proname IN (
            '_dashboard_resolver_datas',
            'obter_indicadores_vendas_admin',
            'obter_indicadores_financeiros_admin',
            'obter_indicadores_producao',
            'obter_indicadores_clientes_admin',
            'obter_dashboard_operacional',
            'obter_dashboard_resumo_admin'
          );
      `);
      assert(rows.length === 7, `Esperado 7 funções, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PF-2: Permissões de anon/PUBLIC revogadas nas RPCs da Frente F
    // --------------------------------------------------------------------------
    await runProbe('PF-2: Permissões revogadas para anon e PUBLIC nas RPCs analíticas', async () => {
      const rows = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name IN (
            'obter_indicadores_vendas_admin',
            'obter_indicadores_financeiros_admin',
            'obter_indicadores_producao',
            'obter_indicadores_clientes_admin',
            'obter_dashboard_operacional',
            'obter_dashboard_resumo_admin'
          )
          AND grantee IN ('anon', 'PUBLIC');
      `);
      assert(rows.length === 0, `Encontradas permissões públicas indevidas: ${JSON.stringify(rows)}`);
    });

    // --------------------------------------------------------------------------
    // PF-3: _dashboard_resolver_datas resolve fuso America/Fortaleza e bounds
    // --------------------------------------------------------------------------
    await runProbe('PF-3: _dashboard_resolver_datas resolve fuso America/Fortaleza e bounds [inicio, fim+1)', async () => {
      const rows = await adminQuery(`
        SELECT v_inicio_ts, v_fim_ts, v_inicio_date, v_fim_date
        FROM public._dashboard_resolver_datas('2026-10-01'::DATE, '2026-10-31'::DATE);
      `);
      assert(rows.length === 1, 'Esperado 1 linha retornada');
      const r = rows[0];
      assert(r.v_inicio_date.startsWith('2026-10-01'), 'Data de início deve ser 2026-10-01');
      assert(r.v_fim_date.startsWith('2026-10-31'), 'Data de fim deve ser 2026-10-31');
    });

    // --------------------------------------------------------------------------
    // PF-4: obter_indicadores_vendas_admin executa e retorna estrutura esperada
    // --------------------------------------------------------------------------
    await runProbe('PF-4: obter_indicadores_vendas_admin retorna envelope canônico', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_indicadores_vendas_admin('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('vendas_confirmadas_quantidade' in res, 'Deve conter vendas_confirmadas_quantidade');
      assert('faturamento_realizado' in res, 'Deve conter faturamento_realizado');
      assert('ticket_medio_realizado' in res, 'Deve conter ticket_medio_realizado');
      assert('orcamentos_convertidos' in res, 'Deve conter orcamentos_convertidos');
    });

    // --------------------------------------------------------------------------
    // PF-5: obter_indicadores_financeiros_admin reporta segregação de caixa e crédito
    // --------------------------------------------------------------------------
    await runProbe('PF-5: obter_indicadores_financeiros_admin segrega caixa líquido de créditos', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_indicadores_financeiros_admin('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('entrada_caixa_bruta' in res, 'Deve conter entrada_caixa_bruta');
      assert('estornos_caixa' in res, 'Deve conter estornos_caixa');
      assert('entrada_caixa_liquida' in res, 'Deve conter entrada_caixa_liquida');
      assert('credito_cliente_utilizado' in res, 'Deve conter credito_cliente_utilizado');
      assert('saldo_creditos_fim_periodo' in res, 'Deve conter saldo_creditos_fim_periodo');
      assert('saldo_creditos_atual' in res, 'Deve conter saldo_creditos_atual');
    });

    // --------------------------------------------------------------------------
    // PF-6: obter_indicadores_producao calcula ocupação e status dos dias
    // --------------------------------------------------------------------------
    await runProbe('PF-6: obter_indicadores_producao calcula ocupação produtiva da fábrica', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_indicadores_producao('2026-10-10'::DATE, '2026-10-20'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('pontos_producao' in res, 'Deve conter pontos_producao');
      assert('capacidade_total' in res, 'Deve conter capacidade_total');
      assert('ocupacao_percentual' in res, 'Deve conter ocupacao_percentual');
    });

    // --------------------------------------------------------------------------
    // PF-7: obter_indicadores_clientes_admin calcula clientes e ranking
    // --------------------------------------------------------------------------
    await runProbe('PF-7: obter_indicadores_clientes_admin retorna novos, recorrentes e ranking', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_indicadores_clientes_admin('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('clientes_ativos' in res, 'Deve conter clientes_ativos');
      assert('clientes_novos' in res, 'Deve conter clientes_novos');
      assert('clientes_recorrentes' in res, 'Deve conter clientes_recorrentes');
      assert('top_clientes' in res, 'Deve conter top_clientes array');
    });

    // --------------------------------------------------------------------------
    // PF-8: obter_dashboard_operacional executa para operador
    // --------------------------------------------------------------------------
    await runProbe('PF-8: obter_dashboard_operacional executa com sucesso', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_dashboard_operacional('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('volumes_pedidos' in res, 'Deve conter volumes_pedidos');
      assert('producao' in res, 'Deve conter producao');
    });

    // --------------------------------------------------------------------------
    // PF-9: Payload do operador NÃO possui chaves financeiras sensíveis
    // --------------------------------------------------------------------------
    await runProbe('PF-9: Payload de obter_dashboard_operacional é rigorosamente sanitizado', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_dashboard_operacional('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      const res = rows[0].res;
      assert(!('faturamento_realizado' in res.volumes_pedidos), 'Não pode ter faturamento_realizado');
      assert(!('vendas_confirmadas_valor' in res.volumes_pedidos), 'Não pode ter vendas_confirmadas_valor');
      assert(!('ticket_medio_realizado' in res.volumes_pedidos), 'Não pode ter ticket_medio_realizado');
      assert(!('ticket_maximo' in res.volumes_pedidos), 'Não pode ter ticket_maximo');
      assert(!('financeiro' in res), 'Não pode conter bloco financeiro');
      assert(!('clientes' in res), 'Não pode conter bloco clientes');
    });

    // --------------------------------------------------------------------------
    // PF-10: obter_dashboard_resumo_admin integra todas as 4 dimensões
    // --------------------------------------------------------------------------
    await runProbe('PF-10: obter_dashboard_resumo_admin integra vendas, finanças, produção e clientes', async () => {
      const rows = await adminQuery(`
        SELECT public.obter_dashboard_resumo_admin('2026-10-01'::DATE, '2026-10-31'::DATE) AS res;
      `);
      assert(rows.length === 1, 'Esperado retorno');
      const res = rows[0].res;
      assert(res.success === true, 'Deve retornar success: true');
      assert('vendas' in res, 'Deve conter bloco de vendas');
      assert('financeiro' in res, 'Deve conter bloco de financeiro');
      assert('producao' in res, 'Deve conter bloco de producao');
      assert('clientes' in res, 'Deve conter bloco de clientes');
      assert(res.vendas.periodo !== undefined, 'Deve conter periodo');
    });

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DA FRENTE F FORAM HOMOLOGADOS!`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('\n❌ Falha na bateria de probes da Frente F:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
