import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 038 (KDS em Tempo Real / Produção de Cozinha) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/038_kds_producao_tempo_real.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 038 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 038:', err);
  process.exit(1);
});
