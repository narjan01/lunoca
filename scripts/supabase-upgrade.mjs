#!/usr/bin/env node
// ==============================================================================
// LUNOCA - Runner Automático de Migrações e Upgrades para o Supabase
// ==============================================================================
// Gerencia a aplicação idempotente e transacional de migrações no banco
// de dados Supabase com suporte a transações seguras, rollback e dry-run.
//
// Uso:
//   node scripts/supabase-upgrade.mjs           # Executa upgrade automático
//   node scripts/supabase-upgrade.mjs --dry-run # Pré-visualização sem aplicar
//   node scripts/supabase-upgrade.mjs --status  # Lista status das migrações
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT_DIR,
  SUPABASE_URL,
  SUPABASE_DB_URL,
  SUPABASE_PROJECT_REF,
  getLocalMigrations,
  getDbClient,
  log,
} from './supabase-common.mjs';

const isDryRun = process.argv.includes('--dry-run');
const isStatusOnly = process.argv.includes('--status');

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255),
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      checksum VARCHAR(64)
    );
  `);
}

async function getAppliedVersions(client) {
  await ensureMigrationTable(client);
  const res = await client.query(`
    SELECT version, name, applied_at, checksum 
    FROM supabase_migrations.schema_migrations 
    ORDER BY version ASC;
  `);
  return res.rows;
}

async function runDirectUpgrade() {
  log.info(`Conectando diretamente ao PostgreSQL do Supabase (${SUPABASE_PROJECT_REF})...`);
  let client = null;
  try {
    client = await getDbClient();
    if (!client) {
      log.warn('Não foi possível inicializar o cliente PostgreSQL.');
      return false;
    }

    const appliedList = await getAppliedVersions(client);
    const appliedMap = new Map(appliedList.map((r) => [r.version, r]));
    const localMigrations = getLocalMigrations();

    const pending = localMigrations.filter((m) => !appliedMap.has(m.version));

    log.section('STATUS DAS MIGRAÇÕES NO BANCO');
    log.info(`Total local: ${localMigrations.length} | Aplicadas: ${appliedList.length} | Pendentes: ${pending.length}`);

    localMigrations.forEach((m) => {
      const isApplied = appliedMap.has(m.version);
      if (isApplied) {
        log.ok(`[v${m.version}] ${m.name} (aplicada em: ${appliedMap.get(m.version).applied_at})`);
      } else {
        log.warn(`[v${m.version}] ${m.name} -> PENDENTE DE APLICAÇÃO`);
      }
    });

    if (isStatusOnly) return true;

    if (pending.length === 0) {
      log.ok('O banco de dados do Supabase já está 100% atualizado! Nenhum upgrade pendente.');
      return true;
    }

    if (isDryRun) {
      log.section('MODO DRY-RUN: Migrações que seriam executadas');
      pending.forEach((m) => {
        log.info(`[Plano de Upgrade] Aplicar v${m.version}: ${m.file} (${(m.sizeBytes / 1024).toFixed(1)} KB)`);
      });
      log.ok('Simulação Dry-Run concluída sem alterações no banco.');
      return true;
    }

    log.section(`APLICANDO ${pending.length} MIGRAÇÃO(ÕES) PENDENTE(S)`);
    for (const m of pending) {
      console.log(`\n\x1b[34m▶ Aplicando migração v${m.version}: ${m.file}...\x1b[0m`);
      const start = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.content);
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations (version, name, checksum) 
           VALUES ($1, $2, $3)
           ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW();`,
          [m.version, m.name, m.hash]
        );
        await client.query('COMMIT');
        const duration = Date.now() - start;
        log.ok(`Migração v${m.version} concluída com sucesso em ${duration}ms.`);
      } catch (err) {
        await client.query('ROLLBACK');
        log.error(`FALHA na migração v${m.version} (${m.file}): ${err.message}`);
        log.error('Transação desfeita (ROLLBACK executado). Abortando upgrades subsequentes.');
        return false;
      }
    }

    log.ok('TODOS OS UPGRADES FORAM CONCLUÍDOS COM SUCESSO!');
    return true;
  } catch (err) {
    log.error(`Erro na execução do upgrade direto: ${err.message}`);
    return false;
  } finally {
    if (client) await client.end();
  }
}

function generatePendingUpgradeBundle(pendingMigrations) {
  const bundlePath = path.join(ROOT_DIR, 'supabase', 'pending-upgrade.sql');
  const parts = [
    `-- ==============================================================================`,
    `-- LUNOCA DOCERIA - BUNDLE DE UPGRADE AUTOMÁTICO PARA SUPABASE`,
    `-- Gerado automaticamente por: node scripts/supabase-upgrade.mjs`,
    `-- ==============================================================================`,
    `-- Migrações incluídas: ${pendingMigrations.map((m) => m.file).join(', ')}`,
    `-- ==============================================================================\n`,
    `BEGIN;\n`,
  ];

  for (const m of pendingMigrations) {
    parts.push(`-- >>> MIGRATION v${m.version}: ${m.file}`);
    parts.push(m.content.trimEnd());
    parts.push(`\n-- Registrar na tabela de controle de migrações`);
    parts.push(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;`);
    parts.push(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version VARCHAR(255) PRIMARY KEY, name VARCHAR(255), applied_at TIMESTAMPTZ DEFAULT NOW(), checksum VARCHAR(64));`);
    parts.push(`INSERT INTO supabase_migrations.schema_migrations (version, name, checksum) VALUES ('${m.version}', '${m.name}', '${m.hash}') ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW();\n`);
  }

  parts.push(`COMMIT;`);
  fs.writeFileSync(bundlePath, parts.join('\n\n') + '\n', 'utf8');
  return bundlePath;
}

async function main() {
  console.log('\x1b[1m\x1b[36m==============================================================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m        LUNOCA DOCERIA - UPGRADE AUTOMÁTICO DE SCHEMA NO SUPABASE             \x1b[0m');
  console.log('\x1b[1m\x1b[36m==============================================================================\x1b[0m');

  const localMigrations = getLocalMigrations();

  // Caso 1: Se temos SUPABASE_DB_URL configurada no .env, rodamos direto via PostgreSQL
  if (SUPABASE_DB_URL) {
    const ok = await runDirectUpgrade();
    process.exit(ok ? 0 : 1);
  }

  // Caso 2: Não temos SUPABASE_DB_URL configurada no .env
  log.section('GERENCIAMENTO DE MIGRAÇÕES PENDENTES');
  log.warn('A variável SUPABASE_DB_URL não está configurada no seu arquivo .env.');
  log.info(`URL do Projeto: ${SUPABASE_URL}`);
  log.info(`Total de migrações no repositório: ${localMigrations.length}`);

  // Como o verify detectou que as migrações 010, 011, 012 e 013 estão pendentes no banco remoto,
  // vamos gerar o bundle consolidado das migrations mais recentes (ou o bundle mestre)
  const bundlePath = generatePendingUpgradeBundle(localMigrations.filter((m) => parseInt(m.version, 10) >= 10));
  log.ok(`Bundle de upgrade gerado com sucesso em: ${path.relative(ROOT_DIR, bundlePath)}`);

  console.log(`
\x1b[1m\x1b[32mOPÇÕES PARA APLICAR OS UPGRADES AUTOMATICAMENTE:\x1b[0m
  \x1b[1mOpção 1 (Recomendada - Conexão Direta):\x1b[0m
    1. Crie o arquivo .env (copie de .env.example):
       \x1b[36mcp .env.example .env\x1b[0m
    2. Adicione sua senha do banco em \x1b[33mSUPABASE_DB_URL\x1b[0m:
       \x1b[36mSUPABASE_DB_URL=postgresql://postgres.xdnlkvbfaacrrhhuaxao:[SUA_SENHA]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres\x1b[0m
    3. Execute novamente:
       \x1b[32mnpm run db:upgrade\x1b[0m

  \x1b[1mOpção 2 (Via Supabase SQL Editor):\x1b[0m
    1. Abra o SQL Editor do Supabase:
       \x1b[36mhttps://supabase.com/dashboard/project/${SUPABASE_PROJECT_REF}/sql/new\x1b[0m
    2. Copie e execute o conteúdo do arquivo gerado:
       \x1b[33m${path.relative(ROOT_DIR, bundlePath)}\x1b[0m
    3. Valide o sucesso executando:
       \x1b[32mnpm run db:verify\x1b[0m
`);

  process.exit(0);
}

main().catch((err) => {
  log.error(`Erro inesperado no runner de upgrades: ${err.message}`);
  process.exit(1);
});
