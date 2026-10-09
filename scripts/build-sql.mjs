#!/usr/bin/env node
// ==========================================================================
// LUNOCA - Gerador de sql/install.sql e sql/schema.sql
// ==========================================================================
// Fonte canônica: sql/baseline/*.sql (estado consolidado) + supabase/migrations/
// com numeração MAIOR que o baseline. O resultado é escrito em sql/install.sql
// e sql/schema.sql (idênticos; schema.sql mantido apenas por compatibilidade).
//
//   node scripts/build-sql.mjs          # gera
//   node scripts/build-sql.mjs --check  # falha (exit 1) se os gerados estiverem desatualizados
// ==========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = path.join(ROOT, 'sql', 'baseline');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const OUTPUTS = [path.join(ROOT, 'sql', 'install.sql'), path.join(ROOT, 'sql', 'schema.sql')];

const check = process.argv.includes('--check');

function numberOf(file) {
  const m = /^(\d+)_/.exec(path.basename(file));
  return m ? parseInt(m[1], 10) : -1;
}

const baselines = fs.readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.sql')).sort();
if (baselines.length === 0) {
  console.error('Nenhum baseline encontrado em sql/baseline/');
  process.exit(1);
}
const baseline = baselines[baselines.length - 1];
const baselineUpTo = (() => {
  const m = /ate_migration_(\d+)/.exec(baseline);
  return m ? parseInt(m[1], 10) : numberOf(baseline);
})();

const migrations = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && numberOf(f) > baselineUpTo)
  .sort((a, b) => numberOf(a) - numberOf(b));

const parts = [];
parts.push(`-- ==========================================================================
-- LUNOCA DOCERIA - SCRIPT MESTRE DE INSTALAÇÃO (GERADO AUTOMATICAMENTE)
-- ==========================================================================
-- ⚠️  NÃO EDITE ESTE ARQUIVO À MÃO. Ele é gerado por: node scripts/build-sql.mjs
-- Fonte canônica: sql/baseline/${baseline} + supabase/migrations/ (> ${String(baselineUpTo).padStart(3, '0')})
-- Migrations incluídas: ${migrations.length ? migrations.join(', ') : '(nenhuma além do baseline)'}
-- Execução única e idempotente no SQL Editor do Supabase.
-- ==========================================================================
`);
parts.push(fs.readFileSync(path.join(BASELINE_DIR, baseline), 'utf8').trimEnd());
for (const m of migrations) {
  parts.push(`

-- ==========================================================================
-- >>> MIGRATION ${m}
-- ==========================================================================
`);
  parts.push(fs.readFileSync(path.join(MIGRATIONS_DIR, m), 'utf8').trimEnd());
}
const output = parts.join('\n') + '\n';

let stale = false;
for (const out of OUTPUTS) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  const currentNorm = current !== null ? current.replace(/\r\n/g, '\n') : null;
  const outputNorm = output.replace(/\r\n/g, '\n');
  if (currentNorm !== outputNorm) {
    stale = true;
    if (!check) {
      fs.writeFileSync(out, output);
      console.log(`✔ gerado ${path.relative(ROOT, out)} (${output.split('\n').length} linhas)`);
    } else {
      console.error(`✖ ${path.relative(ROOT, out)} está desatualizado. Rode: npm run build:sql`);
    }
  } else if (!check) {
    console.log(`= ${path.relative(ROOT, out)} já estava atualizado`);
  }
}

if (check) {
  if (stale) process.exit(1);
  console.log(`✔ sql/install.sql e sql/schema.sql estão em paridade com baseline + ${migrations.length} migration(s).`);
}
