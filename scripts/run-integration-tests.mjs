#!/usr/bin/env node
// ==============================================================================
// LUNOCA - Runner Sequencial de Testes de Integração
// ==============================================================================
// Executa cada arquivo de teste de integração em um processo Node.js dedicado,
// garantindo isolamento total de memória, limpeza de processos de PostgreSQL
// embarcado e erradicação de colisões de disco NTFS no Windows.
// ==============================================================================

import { spawnSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function cleanupOrphanPostgres() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /f /im postgres.exe /fi "MEMUSAGE lt 4096"', { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }
}

const testSuites = [
  'tests/integration/etapa2.integration.test.mjs',
  'tests/integration/etapa3.integration.test.mjs',
  'tests/integration/etapa4.governanca.test.mjs',
  'tests/integration/frente_b.integration.test.mjs',
  'tests/integration/frente_c.credito.test.mjs',
  'tests/integration/frente_d.crm.test.mjs',
  'tests/integration/frente_e.producao.test.mjs',
  'tests/integration/frente_f.dashboard.test.mjs',
  'tests/integration/frente_g.compras_insumos.test.mjs',
  'tests/integration/frente_h.tesouraria_fluxo.test.mjs',
  'tests/integration/frente_i.fidelidade_campanhas.test.mjs',
  'tests/integration/frente_j.portal_cliente.test.mjs',
  'tests/integration/frente_k.logistica_entregas.test.mjs',
  'tests/integration/frente_l.lotes_validade_qualidade.test.mjs',
];

console.log('🚀 Iniciando Runner Sequencial de Testes de Integração Lunoca...');

cleanupOrphanPostgres();

for (const suite of testSuites) {
  const suiteName = path.basename(suite);
  console.log(`\n============================================================`);
  console.log(`▶ Executando suíte: ${suiteName}`);
  console.log(`============================================================`);

  const result = spawnSync('node', ['--test', suite], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180000,
    env: { ...process.env },
  });

  cleanupOrphanPostgres();

  if (result.status !== 0) {
    console.error(`\n❌ Falha na execução da suíte ${suiteName} (exit code: ${result.status})`);
    process.exit(result.status || 1);
  }
}

console.log(`\n============================================================`);
console.log(`🎉 TODAS AS ${testSuites.length} SUÍTES DE INTEGRAÇÃO PASSARAM COM SUCESSO!`);
console.log(`============================================================\n`);
