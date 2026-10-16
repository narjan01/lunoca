import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 039 (WhatsApp Automático Transacional & Outbox) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/039_whatsapp_automatico_outbox.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 039 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 039:', err);
  process.exit(1);
});
