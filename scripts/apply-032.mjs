import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 032 no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/032_pdv_rapido_pronta_entrega.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 032 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 032:', err);
  process.exit(1);
});
