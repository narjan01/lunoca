import fs from 'node:fs';
import path from 'node:path';
import { query } from './supabase-client.mjs';

async function apply016() {
  console.log('🚀 Aplicando Migration 016 em Produção Supabase...');
  const migrationPath = path.resolve('supabase/migrations/016_reconciliacao_pos_015.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await query(sql);
  console.log('✅ Migration 016 aplicada com sucesso no Supabase!');

  console.log('\n🔒 Executando teste decisivo de autorização sob role anon...');
  const res = await query(`
    SELECT
      public.is_admin() AS anon_e_admin,
      public.is_admin_or_operator() AS anon_e_equipe
    FROM (SELECT set_config('request.jwt.claim.role', 'anon', true)) s;
  `);

  console.log('Resultado do Teste Decisivo:', res);
  const { anon_e_admin, anon_e_equipe } = res[0];

  if (anon_e_admin === false && anon_e_equipe === false) {
    console.log('🎉 SUCESSO ABSOLUTO: anon_e_admin = false e anon_e_equipe = false!');
  } else {
    console.error('❌ FALHA CRÍTICA: Helpers ainda retornam true para anon!', res);
    process.exit(1);
  }
}

apply016().catch(err => {
  console.error('Erro na aplicação da Migration 016:', err);
  process.exit(1);
});
