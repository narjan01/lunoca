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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE I (PI-1 a PI-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  try {
    // --------------------------------------------------------------------------
    // PI-1: As 8 tabelas da Frente I existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PI-1: Tabelas de fidelidade, cupons, consentimento e campanhas existem no schema public', async () => {
      const rows = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'programas_fidelidade',
            'cliente_pontos',
            'cliente_pontos_movimentacoes',
            'cliente_consentimentos_marketing',
            'campanhas',
            'cupons_promocionais',
            'cupom_utilizacoes',
            'campanha_publicos'
          )
        ORDER BY table_name;
      `);
      assert(rows.length === 8, `Esperado 8 tabelas, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PI-2: RLS habilitado em todas as 8 tabelas da Frente I
    // --------------------------------------------------------------------------
    await runProbe('PI-2: RLS habilitado em todas as 8 tabelas da Frente I', async () => {
      const rows = await query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (
            'programas_fidelidade',
            'cliente_pontos',
            'cliente_pontos_movimentacoes',
            'cliente_consentimentos_marketing',
            'campanhas',
            'cupons_promocionais',
            'cupom_utilizacoes',
            'campanha_publicos'
          );
      `);
      assert(rows.length === 8, `Esperado 8 tabelas, encontrado ${rows.length}`);
      for (const r of rows) {
        assert(r.rowsecurity === true, `RLS desabilitado em ${r.tablename}`);
      }
    });

    // --------------------------------------------------------------------------
    // PI-3: RPCs e helpers da Frente I existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PI-3: RPCs de fidelidade, cupons, consentimento e campanhas existem no schema public', async () => {
      const rows = await query(`
        SELECT DISTINCT proname
        FROM pg_proc
        JOIN pg_namespace n ON n.oid = pg_proc.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN (
            '_aplicar_movimento_pontos_cliente',
            '_processar_expiracao_pontos_cliente',
            'expirar_pontos_fidelidade',
            'creditar_pontos_pedido_concluido',
            'compensar_pontos_pedido_cancelado',
            'resgatar_pontos_fidelidade',
            'ajustar_pontos_fidelidade_admin',
            'salvar_cupom_promocional_admin',
            'aplicar_cupom_promocional',
            'registrar_consentimento_marketing',
            'salvar_campanha_admin',
            'avaliar_publico_campanha',
            'disparar_campanha_marketing',
            'obter_painel_fidelidade_campanhas_admin'
          );
      `);
      assert(rows.length === 14, `Esperado 14 funções, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PI-4: Permissões revogadas para anon e PUBLIC nas RPCs da Frente I
    // --------------------------------------------------------------------------
    await runProbe('PI-4: Permissões revogadas para anon e PUBLIC nas RPCs da Frente I', async () => {
      const rows = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name IN (
            '_aplicar_movimento_pontos_cliente',
            '_processar_expiracao_pontos_cliente',
            'expirar_pontos_fidelidade',
            'creditar_pontos_pedido_concluido',
            'compensar_pontos_pedido_cancelado',
            'resgatar_pontos_fidelidade',
            'ajustar_pontos_fidelidade_admin',
            'salvar_cupom_promocional_admin',
            'aplicar_cupom_promocional',
            'registrar_consentimento_marketing',
            'salvar_campanha_admin',
            'avaliar_publico_campanha',
            'disparar_campanha_marketing',
            'obter_painel_fidelidade_campanhas_admin'
          )
          AND grantee IN ('anon', 'PUBLIC');
      `);
      assert(rows.length === 0, `Permissões indevidas para anon/PUBLIC: ${JSON.stringify(rows)}`);
    });

    // --------------------------------------------------------------------------
    // PI-5: Helpers internos privados bloqueados para authenticated
    // --------------------------------------------------------------------------
    await runProbe('PI-5: Helpers internos _aplicar_movimento_pontos_cliente e _processar_expiracao_pontos_cliente bloqueados para authenticated', async () => {
      const rows = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name IN ('_aplicar_movimento_pontos_cliente', '_processar_expiracao_pontos_cliente')
          AND grantee = 'authenticated';
      `);
      assert(rows.length === 0, 'Helpers internos não podem ser executáveis diretamente por authenticated');
    });

    // --------------------------------------------------------------------------
    // PI-6: Triggers de imutabilidade e proteção de saldo ativos
    // --------------------------------------------------------------------------
    await runProbe('PI-6: Triggers trg_imutabilidade_cliente_pontos_mov e trg_proteger_mutacao_direta_cliente_pontos ativos', async () => {
      const rows = await query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname IN (
          'trg_imutabilidade_cliente_pontos_mov',
          'trg_proteger_mutacao_direta_cliente_pontos',
          'trg_imutabilidade_consentimentos_mkt',
          'trg_fidelidade_pedido_status'
        )
        AND NOT tgisinternal;
      `);
      assert(rows.length === 4, `Triggers esperados ausentes: encontrados ${rows.length}/4`);
    });

    // --------------------------------------------------------------------------
    // PI-7: Programa de fidelidade padrão (PADRAO_LUNOCA) ativo
    // --------------------------------------------------------------------------
    await runProbe('PI-7: Programa de fidelidade padrão PADRAO_LUNOCA existe e está ativo', async () => {
      const rows = await adminQuery(`
        SELECT codigo, ativo, marco_credito
        FROM public.programas_fidelidade
        WHERE codigo = 'PADRAO_LUNOCA';
      `);
      assert(rows.length === 1, 'PADRAO_LUNOCA não encontrado');
      assert(rows[0].ativo === true, 'PADRAO_LUNOCA inativo');
      assert(rows[0].marco_credito === 'concluido', 'marco_credito deve ser concluido');
    });

    // --------------------------------------------------------------------------
    // PI-8: obter_painel_fidelidade_campanhas_admin retorna envelope válido
    // --------------------------------------------------------------------------
    await runProbe('PI-8: obter_painel_fidelidade_campanhas_admin retorna envelope completo com resumo e listas', async () => {
      const rows = await adminQuery(`SELECT public.obter_painel_fidelidade_campanhas_admin() AS res;`);
      const res = rows[0].res;
      assert(res && res.success === true, `Falha em obter_painel_fidelidade_campanhas_admin: ${JSON.stringify(res)}`);
      assert(res.programa && res.programa.codigo === 'PADRAO_LUNOCA', 'Programa ausente no painel');
      assert(res.resumo && res.resumo.saldo_pontos_circulacao !== undefined, 'Resumo ausente no painel');
      assert(Array.isArray(res.cupons), 'cupons deve ser array');
      assert(Array.isArray(res.campanhas), 'campanhas deve ser array');
    });

    // --------------------------------------------------------------------------
    // PI-9: expirar_pontos_fidelidade executa de forma idempotente em produção
    // --------------------------------------------------------------------------
    await runProbe('PI-9: expirar_pontos_fidelidade executa de forma limpa e idempotente', async () => {
      const rows = await adminQuery(`SELECT public.expirar_pontos_fidelidade() AS res;`);
      const res = rows[0].res;
      assert(res && res.success === true, `Falha em expirar_pontos_fidelidade: ${JSON.stringify(res)}`);
      assert(Number(res.pontos_expirados) >= 0, 'pontos_expirados inválido');
    });

    // --------------------------------------------------------------------------
    // PI-10: Invariante de isolamento — cliente_creditos permanece intacto
    // --------------------------------------------------------------------------
    await runProbe('PI-10: Invariante de isolamento — carteira financeira cliente_creditos permanece separada de cliente_pontos', async () => {
      const cols = await query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'cliente_creditos'
          AND column_name LIKE '%ponto%';
      `);
      assert(cols.length === 0, 'cliente_creditos não pode conter colunas de pontos');
    });

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DA FRENTE I FORAM HOMOLOGADOS!`);
    console.log('============================================================\n');
  } catch (err) {
    console.error(`\n💥 Execução interrompida: ${passedProbes}/${totalProbes} probes passaram antes da falha.`);
    process.exit(1);
  }
}

main();
