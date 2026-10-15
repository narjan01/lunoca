import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 035 (Hotfix PDV Histórico & Caixa Ownership) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/035_hotfix_pdv_historico_caixa_ownership.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 035 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 035:', err);
  process.exit(1);
});
