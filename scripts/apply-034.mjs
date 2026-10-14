import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 034 (Frente R - Caixa PDV & Turnos) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/034_caixa_pdv_sessoes_fechamento.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 034 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 034:', err);
  process.exit(1);
});
