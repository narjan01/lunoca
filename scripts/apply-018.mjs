import fs from 'node:fs';
import path from 'node:path';
import { query } from './supabase-client.mjs';

async function apply018() {
  console.log('🚀 Aplicando Migration 018 (Frente C: Carteira de Crédito do Cliente) em Produção Supabase...');
  const migrationPath = path.resolve('supabase/migrations/018_credito_cliente_carteira_financeira.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await query(sql);
  console.log('✅ Migration 018 aplicada com sucesso no Supabase!');

  console.log('\n🔍 Verificando criação das tabelas cliente_creditos e cliente_credito_movimentacoes...');
  const tables = await query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('cliente_creditos', 'cliente_credito_movimentacoes')
    ORDER BY table_name;
  `);
  console.log('Tabelas encontradas:', tables);
  if (tables.length !== 2) {
    console.error('❌ FALHA: Uma ou mais tabelas não foram criadas.');
    process.exit(1);
  }

  console.log('\n🔍 Verificando funções criadas no catálogo pg_proc...');
  const funcs = await query(`
    SELECT proname, pg_get_function_arguments(p.oid) as argumentos
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        'aplicar_movimento_credito_cliente',
        'ajustar_credito_cliente_admin',
        'utilizar_credito_cliente_pedido',
        'consultar_saldo_credito'
      )
    ORDER BY proname;
  `);
  console.log('Funções confirmadas em produção:', funcs);
  if (funcs.length < 4) {
    console.error('❌ FALHA: Funções não foram devidamente instaladas.');
    process.exit(1);
  }

  console.log('\n🔒 Verificando grants e segurança fail-closed da função interna aplicar_movimento_credito_cliente...');
  const internalGrants = await query(`
    SELECT grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'aplicar_movimento_credito_cliente';
  `);
  console.log('Grants da função interna:', internalGrants);
  const publicOrAnon = internalGrants.filter(g => ['PUBLIC', 'anon', 'authenticated'].includes(g.grantee));
  if (publicOrAnon.length > 0) {
    console.error('❌ FALHA: Função interna aplicar_movimento_credito_cliente possui grants indevidos:', publicOrAnon);
    process.exit(1);
  } else {
    console.log('🎉 SUCESSO: Função interna é estritamente privada (sem grants para PUBLIC/anon/authenticated)!');
  }

  console.log('\n💳 Verificando aceitação de credito_cliente na constraint de pedido_pagamentos...');
  const chk = await query(`
    SELECT pg_get_constraintdef(c.oid) as def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pedido_pagamentos'
      AND c.conname = 'chk_pedido_pagamentos_metodo';
  `);
  console.log('Definição da constraint de pagamentos:', chk[0]?.def);
  if (chk[0]?.def?.includes('credito_cliente')) {
    console.log('🎉 SUCESSO: Metodo credito_cliente aceito com sucesso em pedido_pagamentos!');
  } else {
    console.error('❌ FALHA: Metodo credito_cliente não está na constraint!');
    process.exit(1);
  }

  console.log('\n✨ Todas as verificações de produção para a Migration 018 passaram com sucesso!');
}

apply018().catch(err => {
  console.error('Erro na aplicação da Migration 018:', err);
  process.exit(1);
});
