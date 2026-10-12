import fs from 'node:fs';
import path from 'node:path';
import { query } from './supabase-client.mjs';

async function apply019() {
  console.log('🚀 Aplicando Migration 019 (Frente D: CRM e Visão 360 do Cliente) em Produção Supabase...');
  const migrationPath = path.resolve('supabase/migrations/019_crm_cliente_visao_360.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await query(sql);
  console.log('✅ Migration 019 aplicada com sucesso no Supabase!');

  console.log('\n🔍 Verificando tabelas do CRM criadas no schema public...');
  const tables = await query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_name IN ('cliente_notas', 'cliente_tags', 'cliente_preferencias')
    ORDER BY table_name;
  `);
  console.log('Tabelas CRM encontradas:', tables);
  if (tables.length !== 3) {
    console.error('❌ FALHA: Uma ou mais tabelas do CRM não foram criadas.');
    process.exit(1);
  }

  console.log('\n🔍 Verificando novas RPCs de projeção e manutenção do CRM no catálogo pg_proc...');
  const funcs = await query(`
    SELECT proname, pg_get_function_arguments(p.oid) as argumentos
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        'buscar_clientes_crm',
        'obter_cliente_360_admin',
        'adicionar_nota_cliente',
        'arquivar_nota_cliente',
        'adicionar_tag_cliente',
        'remover_tag_cliente',
        'definir_preferencia_cliente',
        'arquivar_preferencia_cliente',
        'obter_meu_perfil_360'
      )
    ORDER BY proname;
  `);
  console.log('Funções CRM confirmadas em produção:', funcs);
  if (funcs.length < 9) {
    console.error(`❌ FALHA: Esperado 9 funções, encontrado ${funcs.length}.`);
    process.exit(1);
  }

  console.log('\n🔒 Verificando grants fail-closed para anon nas RPCs administrativas...');
  const anonGrants = await query(`
    SELECT routine_name, grantee, privilege_type
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'buscar_clientes_crm',
        'obter_cliente_360_admin',
        'adicionar_nota_cliente',
        'arquivar_nota_cliente',
        'adicionar_tag_cliente',
        'remover_tag_cliente',
        'definir_preferencia_cliente',
        'arquivar_preferencia_cliente',
        'obter_meu_perfil_360'
      )
      AND grantee IN ('PUBLIC', 'anon');
  `);
  console.log('Grants anon encontrados:', anonGrants);
  if (anonGrants.length > 0) {
    console.error('❌ FALHA: RPCs administrativas expostas para PUBLIC/anon:', anonGrants);
    process.exit(1);
  } else {
    console.log('🎉 SUCESSO: Nenhuma RPC administrativa do CRM é acessível por anon!');
  }

  console.log('\n✨ Todas as verificações estruturais de produção para a Migration 019 passaram com sucesso!');
}

apply019().catch(err => {
  console.error('Erro na aplicação da Migration 019:', err);
  process.exit(1);
});
