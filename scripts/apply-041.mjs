import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 041 (Dinamismo Admin, KDS & Balcão de Retirada) no Supabase...');
  const sql = fs.readFileSync('supabase/migrations/041_dinamismo_admin_kds_retirada_sync.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 041 aplicada com sucesso no Supabase de produção!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 041:', err);
  process.exit(1);
});
