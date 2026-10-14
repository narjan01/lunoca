import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 030 no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/030_equipe_turnos_escalas_capacidade_real.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 030 aplicada com sucesso no Supabase de produção!');
}

main().catch((err) => {
  console.error('❌ Erro ao aplicar migration 030:', err);
  process.exit(1);
});
