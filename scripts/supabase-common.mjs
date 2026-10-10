#!/usr/bin/env node
// ==============================================================================
// LUNOCA - Utilitários Comuns de Integração Supabase
// ==============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let pgModule = null;

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
export const ENV_FILE = path.join(ROOT_DIR, '.env');

// Carregador simples de .env sem dependências externas
export function loadEnv() {
  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

// Credenciais padrão (com fallback seguro do projeto)
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmxrdmJmYWFjcnJoaHVheGFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDM0MjcsImV4cCI6MjEwNTMxOTQyN30.gq0g8APuVEvVA5_mLAYVLtDabot-x_PsSbdU3u6s13g';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
export const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || null;
export const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'xdnlkvbfaacrrhhuaxao';
export const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || null;

// Formatação e cores ANSI para terminal
export const log = {
  info: (msg) => console.log(`\x1b[36mℹ\x1b[0m ${msg}`),
  ok: (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m⚠\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m✖\x1b[0m ${msg}`),
  section: (title) => console.log(`\n\x1b[1m\x1b[35m=== ${title} ===\x1b[0m`),
  dim: (msg) => console.log(`  \x1b[90m${msg}\x1b[0m`),
};

// Lê e lista todas as migrations locais com metadados
export function getLocalMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => {
      const numA = parseInt(a.split('_')[0], 10) || 0;
      const numB = parseInt(b.split('_')[0], 10) || 0;
      return numA - numB;
    });

  return files.map((file) => {
    const fullPath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const version = file.split('_')[0];
    const name = file.replace(/\.sql$/, '');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return {
      file,
      fullPath,
      version,
      name,
      hash,
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
  });
}

// Cria cliente Postgres se connection string estiver disponível
export async function getDbClient() {
  if (!SUPABASE_DB_URL) return null;
  try {
    if (!pgModule) {
      pgModule = (await import('pg')).default;
    }
  } catch (err) {
    log.warn('Driver PostgreSQL ("pg") não encontrado no node_modules. Para upgrades diretos via SQL connection string, execute: npm install');
    return null;
  }
  const client = new pgModule.Client({
    connectionString: SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requer SSL
  });
  await client.connect();
  return client;
}
