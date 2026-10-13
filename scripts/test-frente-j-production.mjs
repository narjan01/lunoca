// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE J (PJ-1 a PJ-10)
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE J (PJ-1 a PJ-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

const rpcsPortal = [
  'obter_painel_minha_conta_cliente',
  'listar_meus_pedidos',
  'obter_meu_pedido',
  'listar_meus_orcamentos',
  'aprovar_meu_orcamento',
  'listar_meu_extrato_credito',
  'listar_meu_extrato_pontos',
  'listar_meus_cupons',
  'listar_minhas_comunicacoes',
  'atualizar_minhas_preferencias_cliente',
  'atualizar_meu_consentimento_marketing'
];

async function runProbes() {
  // PJ-1: Índice de unicidade uq_clientes_auth_user_id existe
  process.stdout.write('⏳ PJ-1: Índice único parcial uq_clientes_auth_user_id existe em public.clientes... ');
  const r1 = await query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'clientes' AND indexname = 'uq_clientes_auth_user_id'
  `);
  assert.equal(r1.length, 1);
  console.log('✅ APROVADO');

  // PJ-2: Zero clientes duplicados por auth_user_id em produção
  process.stdout.write('⏳ PJ-2: Zero clientes duplicados para o mesmo auth_user_id em produção... ');
  const r2 = await query(`
    SELECT auth_user_id, COUNT(*) AS qtd
    FROM public.clientes
    WHERE auth_user_id IS NOT NULL
    GROUP BY auth_user_id
    HAVING COUNT(*) > 1
  `);
  assert.equal(r2.length, 0);
  console.log('✅ APROVADO');

  // PJ-3: Todas as 11 RPCs do Portal do Cliente existem no schema public
  process.stdout.write('⏳ PJ-3: Todas as 11 RPCs canônicas da Frente J existem no schema public... ');
  const r3 = await query(`
    SELECT DISTINCT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${rpcsPortal.map(f => `'${f}'`).join(',')}])
  `);
  assert.equal(r3.length, 11);
  console.log('✅ APROVADO');

  // PJ-4: Nenhuma RPC pública do portal aceita p_cliente_id ou cliente_id
  process.stdout.write('⏳ PJ-4: Nenhuma RPC pública da Frente J aceita parâmetro cliente_id vindo do navegador... ');
  const r4 = await query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${rpcsPortal.map(f => `'${f}'`).join(',')}])
  `);
  for (const row of r4) {
    assert.equal(/cliente_id/i.test(row.args), false, `Função ${row.proname} não pode ter cliente_id`);
  }
  console.log('✅ APROVADO');

  // PJ-5: Permissões revogadas para anon e PUBLIC em todas as 11 RPCs
  process.stdout.write('⏳ PJ-5: Permissões EXECUTE revogadas para anon e PUBLIC nas 11 RPCs do portal... ');
  const r5 = await query(`
    SELECT p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${rpcsPortal.map(f => `'${f}'`).join(',')}])
  `);
  for (const row of r5) {
    assert.equal(row.anon_exec, false, `anon não pode executar ${row.proname}`);
  }
  console.log('✅ APROVADO');

  // PJ-6: Helpers internos bloqueados para authenticated
  process.stdout.write('⏳ PJ-6: Helpers internos _resolver_meu_cliente_id e _derivar_etapa_cliente_pedido bloqueados para authenticated... ');
  const r6 = await query(`
    SELECT p.proname,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('_resolver_meu_cliente_id', '_derivar_etapa_cliente_pedido')
  `);
  assert.equal(r6.length, 2);
  for (const row of r6) {
    assert.equal(row.auth_exec, false);
  }
  console.log('✅ APROVADO');

  // PJ-7: Definição de listar_meus_orcamentos e obter_painel_minha_conta_cliente não expõe token_publico
  process.stdout.write('⏳ PJ-7: Definição de listar_meus_orcamentos e obter_painel_minha_conta_cliente não projeta token_publico... ');
  const r7 = await query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('listar_meus_orcamentos', 'obter_painel_minha_conta_cliente')
  `);
  for (const row of r7) {
    assert.equal(/o\.token_publico/i.test(row.def), false);
  }
  console.log('✅ APROVADO');

  // PJ-8: _derivar_etapa_cliente_pedido retorna os 8 estados semânticos esperados
  process.stdout.write('⏳ PJ-8: _derivar_etapa_cliente_pedido retorna os estados semânticos esperados... ');
  const r8 = await query(`
    SELECT
      public._derivar_etapa_cliente_pedido('confirmado', 'aguardando_producao', 'retirada') AS e1,
      public._derivar_etapa_cliente_pedido('confirmado', 'em_producao', 'retirada') AS e2,
      public._derivar_etapa_cliente_pedido('confirmado', 'pronto', 'retirada') AS e3,
      public._derivar_etapa_cliente_pedido('confirmado', 'pronto', 'entrega') AS e4,
      public._derivar_etapa_cliente_pedido('confirmado', 'saiu_para_entrega', 'entrega') AS e5,
      public._derivar_etapa_cliente_pedido('concluido', 'entregue', 'entrega') AS e6,
      public._derivar_etapa_cliente_pedido('concluido', 'retirado', 'retirada') AS e7,
      public._derivar_etapa_cliente_pedido('cancelado', 'cancelado', 'retirada') AS e8
  `);
  assert.equal(r8[0].e1, 'aguardando_preparo');
  assert.equal(r8[0].e2, 'em_preparo');
  assert.equal(r8[0].e3, 'pronto_para_retirada');
  assert.equal(r8[0].e4, 'pronto_para_entrega');
  assert.equal(r8[0].e5, 'saiu_para_entrega');
  assert.equal(r8[0].e6, 'entregue');
  assert.equal(r8[0].e7, 'retirado');
  assert.equal(r8[0].e8, 'cancelado');
  console.log('✅ APROVADO');

  // PJ-9: Chamada sem sessão (auth.uid() IS NULL) falha fechado com UNAUTHENTICATED
  process.stdout.write('⏳ PJ-9: obter_painel_minha_conta_cliente sem auth.uid() falha fechado com UNAUTHENTICATED... ');
  const r9 = await query(`SELECT public.obter_painel_minha_conta_cliente() AS res`);
  assert.equal(r9[0].res.success, false);
  assert.equal(r9[0].res.code, 'UNAUTHENTICATED');
  console.log('✅ APROVADO');

  // PJ-10: Constraint de cliente_preferencias aceita a categoria 'embalagem'
  process.stdout.write('⏳ PJ-10: Constraint cliente_preferencias_categoria_check inclui embalagem... ');
  const r10 = await query(`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'cliente_preferencias'
      AND c.conname = 'cliente_preferencias_categoria_check'
  `);
  assert.equal(r10.length, 1);
  assert.equal(r10[0].def.includes('embalagem'), true);
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('🎉 TODOS OS 10/10 PROBES DA FRENTE J FORAM HOMOLOGADOS!');
  console.log('============================================================\n');
}

runProbes().catch((err) => {
  console.error('\n❌ FALHA EM PROBE DE PRODUÇÃO FRENTE J:', err);
  process.exit(1);
});
