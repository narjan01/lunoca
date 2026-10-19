import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 044 (KDS Bloqueio por Briefing Pendente & Ajustes) no Supabase...');
  const sql = fs.readFileSync('supabase/migrations/044_kds_bloqueio_briefing_pendente.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 044 aplicada com sucesso no Supabase de produção!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 044:', err);
  process.exit(1);
});
