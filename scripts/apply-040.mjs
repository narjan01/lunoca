import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 040 (Hotfix Checkout / Pix / WhatsApp E2E) no Supabase de produção...');
  const sql = fs.readFileSync('supabase/migrations/040_hotfix_checkout_pix_whatsapp_e2e.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 040 aplicada com sucesso no Supabase de produção!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 040:', err);
  process.exit(1);
});
