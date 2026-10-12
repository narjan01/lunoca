#!/usr/bin/env node
// ==============================================================================
// LUNOCA - Runner Sequencial de Testes de Integração
// ==============================================================================
// Executa cada arquivo de teste de integração em um processo Node.js dedicado,
// garantindo isolamento total de memória, limpeza de processos de PostgreSQL
// embarcado e erradicação de colisões de disco NTFS no Windows.
// ==============================================================================

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testSuites = [
  'tests/integration/etapa2.integration.test.mjs',
  'tests/integration/etapa3.integration.test.mjs',
  'tests/integration/etapa4.governanca.test.mjs',
  'tests/integration/frente_b.integration.test.mjs',
  'tests/integration/frente_c.credito.test.mjs',
  'tests/integration/frente_d.crm.test.mjs',
];

console.log('🚀 Iniciando Runner Sequencial de Testes de Integração Lunoca...');
let totalPassed = 0;
let totalFailed = 0;

for (const suite of testSuites) {
  const suiteName = path.basename(suite);
  console.log(`\n============================================================`);
  console.log(`▶ Executando suíte: ${suiteName}`);
  console.log(`============================================================`);

  const result = spawnSync('node', ['--test', suite], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  if (result.status !== 0) {
    console.error(`\n❌ Falha na execução da suíte ${suiteName} (exit code: ${result.status})`);
    process.exit(result.status || 1);
  }
}

console.log(`\n============================================================`);
console.log(`🎉 TODAS AS ${testSuites.length} SUÍTES DE INTEGRAÇÃO PASSARAM COM SUCESSO!`);
console.log(`============================================================\n`);
