import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './supabase-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function main() {
  console.log('Aplicando migration 022 no Supabase de produção...');
  const migrationPath = path.join(ROOT, 'supabase', 'migrations', '022_compras_fornecedores_estoque_insumos.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await query(sql);
  console.log('✅ Migration 022 aplicada com sucesso no Supabase de produção!');
}

main().catch(err => {
  console.error('❌ Erro ao aplicar migration 022:', err);
  process.exit(1);
});
