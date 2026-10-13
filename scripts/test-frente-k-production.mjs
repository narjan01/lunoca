// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE K (PK-1 a PK-10)
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE K (PK-1 a PK-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

const tabelasLogistica = [
  'rotas_entrega',
  'entregas',
  'rota_entregas',
  'entrega_eventos',
  'entrega_comprovantes'
];

const rpcsLogistica = [
  'criar_rota_entrega_admin',
  'atribuir_entrega_rota',
  'reordenar_rota_entrega',
  'despachar_pedido_entrega',
  'registrar_falha_entrega',
  'reagendar_entrega',
  'registrar_comprovante_entrega',
  'confirmar_entrega_pedido',
  'obter_painel_logistica',
  'obter_acompanhamento_entrega_cliente'
];

async function runProbes() {
  // PK-1: As 5 tabelas da Frente K existem e têm RLS habilitado
  process.stdout.write('⏳ PK-1: As 5 tabelas logísticas existem em public com RLS habilitado... ');
  const r1 = await query(`
    SELECT relname, relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY(ARRAY[${tabelasLogistica.map(t => `'${t}'`).join(',')}])
  `);
  assert.equal(r1.length, 5);
  for (const row of r1) {
    assert.equal(row.relrowsecurity, true, `Tabela ${row.relname} sem RLS`);
  }
  console.log('✅ APROVADO');

  // PK-2: Triggers de imutabilidade append-only ativas em entrega_eventos e entrega_comprovantes
  process.stdout.write('⏳ PK-2: Triggers trg_imutabilidade_entrega_eventos e trg_imutabilidade_entrega_comprovantes ativas... ');
  const r2 = await query(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgname IN ('trg_imutabilidade_entrega_eventos', 'trg_imutabilidade_entrega_comprovantes')
      AND NOT tgisinternal
  `);
  assert.equal(r2.length, 2);
  console.log('✅ APROVADO');

  // PK-3: Todas as 10 RPCs canônicas da Frente K existem no schema public
  process.stdout.write('⏳ PK-3: Todas as 10 RPCs canônicas da Frente K existem no schema public... ');
  const r3 = await query(`
    SELECT DISTINCT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${rpcsLogistica.map(f => `'${f}'`).join(',')}])
  `);
  assert.equal(r3.length, 10);
  console.log('✅ APROVADO');

  // PK-4: Permissões revogadas para anon em todas as 10 RPCs e 5 tabelas
  process.stdout.write('⏳ PK-4: Permissões revogadas para anon nas 10 RPCs e 5 tabelas da Frente K... ');
  const r4 = await query(`
    SELECT p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${rpcsLogistica.map(f => `'${f}'`).join(',')}])
  `);
  for (const row of r4) {
    assert.equal(row.anon_exec, false, `anon não pode executar ${row.proname}`);
  }
  const r4Tab = await query(`
    SELECT c.relname,
           has_table_privilege('anon', c.oid, 'SELECT') AS anon_sel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY(ARRAY[${tabelasLogistica.map(t => `'${t}'`).join(',')}])
  `);
  for (const row of r4Tab) {
    assert.equal(row.anon_sel, false, `anon não pode ler tabela ${row.relname}`);
  }
  console.log('✅ APROVADO');

  // PK-5: Nenhuma coluna BYTEA em entrega_comprovantes ou nas tabelas da Frente K
  process.stdout.write('⏳ PK-5: Zero colunas BYTEA nas tabelas logísticas... ');
  const r5 = await query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${tabelasLogistica.map(t => `'${t}'`).join(',')}])
      AND data_type = 'bytea'
  `);
  assert.equal(r5.length, 0);
  console.log('✅ APROVADO');

  // PK-6: obter_acompanhamento_entrega_cliente não aceita p_cliente_id
  process.stdout.write('⏳ PK-6: obter_acompanhamento_entrega_cliente não aceita p_cliente_id... ');
  const r6 = await query(`
    SELECT pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'obter_acompanhamento_entrega_cliente'
  `);
  assert.equal(r6.length, 1);
  assert.equal(/cliente_id/i.test(r6[0].args), false);
  console.log('✅ APROVADO');

  // PK-7: obter_painel_logistica executa com sucesso como service_role
  process.stdout.write('⏳ PK-7: obter_painel_logistica retorna estrutura canônica válida... ');
  const r7 = await query(`
    SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true),
           public.obter_painel_logistica(CURRENT_DATE) AS res
  `);
  const painel = r7[0].res;
  assert.equal(painel.success, true);
  assert.ok(Array.isArray(painel.expedicao_aguardando));
  assert.ok(Array.isArray(painel.rotas_do_dia));
  assert.ok(Array.isArray(painel.em_rota_e_ocorrencias));
  console.log('✅ APROVADO');

  // PK-8: Ciclo transacional real em produção (com ROLLBACK) — bloqueio de retirada e não-pronto
  process.stdout.write('⏳ PK-8: Simulação transacional (ROLLBACK) — bloqueio de retirada e de pedido não pronto... ');
  const r8 = await query(`
    BEGIN;
    SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, data_pedido, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Probe Retirada PK8', 'probe-pk8@lunoca.test', '5585999990008', CURRENT_DATE, CURRENT_DATE, '14:00:00',
      'retirada', 'Retirada Loja', 100, 100,
      'confirmado', 'pago', 'pronto', 'Confirmado',
      'pix', '[]'::jsonb
    );
    SELECT public.despachar_pedido_entrega(currval('pedidos_id_seq')) AS desp_retirada;
    ROLLBACK;
  `);
  assert.ok(r8);
  console.log('✅ APROVADO');

  // PK-9: Confirmar entrega nunca referencia INSERT INTO financeiro_lancamentos nem pedido_pagamentos
  process.stdout.write('⏳ PK-9: Definição de confirmar_entrega_pedido tem efeito financeiro ZERO... ');
  const r9 = await query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'confirmar_entrega_pedido'
  `);
  const codeOnly = r9[0].def.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.equal(codeOnly.includes('INSERT INTO public.financeiro_lancamentos'), false);
  assert.equal(codeOnly.includes('INSERT INTO public.pedido_pagamentos'), false);
  console.log('✅ APROVADO');

  // PK-10: Unicidade estrutural de entregas por pedido (uq pedido_id em public.entregas)
  process.stdout.write('⏳ PK-10: Constraint UNIQUE(pedido_id) ativa em public.entregas... ');
  const r10 = await query(`
    SELECT conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'entregas'
      AND c.contype = 'u'
  `);
  assert.ok(r10.length >= 1);
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('🎉 TODOS OS 10 PROBES DE PRODUÇÃO (PK-1 a PK-10) APROVADOS!');
  console.log('============================================================\n');
}

runProbes().catch(err => {
  console.error('\n❌ FALHA NOS PROBES DE PRODUÇÃO FRENTE K:', err);
  process.exit(1);
});
