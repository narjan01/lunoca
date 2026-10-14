import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 031 no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/031_expedicao_pdv_retirada_segura.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 031 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 031:', err);
  process.exit(1);
});
