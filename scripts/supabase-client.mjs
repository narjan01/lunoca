import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 1. Carregar variáveis de ambiente de .env se existir
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'xdnlkvbfaacrrhhuaxao';
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

let pgClient = null;

export async function query(sql) {
  // Opção A: Conexão direta via PostgreSQL (DATABASE_URL / SUPABASE_DB_URL)
  if (SUPABASE_DB_URL) {
    const { default: pg } = await import('pg');
    if (!pgClient) {
      pgClient = new pg.Client({
        connectionString: SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false }
      });
      await pgClient.connect();
    }
    const res = await pgClient.query(sql);
    return res.rows;
  }

  // Opção B: Execução via Supabase Management API (SUPABASE_ACCESS_TOKEN)
  if (SUPABASE_ACCESS_TOKEN) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase Management API Query Failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data;
  }

  throw new Error(
    'Credenciais de banco ausentes: configure SUPABASE_ACCESS_TOKEN (para Management API) ' +
    'ou DATABASE_URL / SUPABASE_DB_URL (para conexão direta PostgreSQL via pg) no arquivo .env ou variáveis de ambiente.\n' +
    'Alternativamente, execute o SQL diretamente no Supabase SQL Editor.'
  );
}
