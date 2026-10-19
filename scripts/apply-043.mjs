import fs from 'node:fs';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('🚀 Aplicando migration 043 (Personalização de Produtos & Briefing Visual) no Supabase...');
  const sql = fs.readFileSync('supabase/migrations/043_personalizacao_briefing_produtos.sql', 'utf-8');
  await query(sql);
  console.log('✅ Migration 043 aplicada com sucesso no Supabase de produção!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 043:', err);
  process.exit(1);
});
