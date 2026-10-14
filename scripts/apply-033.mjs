import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 033 (Hotfix Orçamentos) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/033_hotfix_orcamentos_admin.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 033 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 033:', err);
  process.exit(1);
});
