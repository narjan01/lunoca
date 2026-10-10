import fs from 'node:fs';
import path from 'node:path';

// Parse .env manually
let token = process.env.SUPABASE_ACCESS_TOKEN;
let projectRef = process.env.SUPABASE_PROJECT_REF || 'xdnlkvbfaacrrhhuaxao';

try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.substring(0, idx).trim();
        const v = trimmed.substring(idx + 1).trim();
        if (k === 'SUPABASE_ACCESS_TOKEN' && !token) token = v;
        if (k === 'SUPABASE_PROJECT_REF' && !projectRef) projectRef = v;
      }
    }
  }
} catch {}

if (!token) {
  throw new Error('SUPABASE_ACCESS_TOKEN is required in .env');
}

export async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

  return res.json();
}

// Se executado diretamente:
if (process.argv[1]?.endsWith('supabase-client.mjs')) {
  (async () => {
    try {
      const procs = await query(`
        SELECT proname, pg_get_function_identity_arguments(oid) as args
        FROM pg_proc
        WHERE proname IN (
          'ajustar_estoque_operacao',
          'obter_preview_comunicacao',
          'registrar_comunicacao_cliente',
          'aprovar_orcamento_publico',
          'listar_orcamentos_para_lembrete'
        )
        ORDER BY proname;
      `);
      console.log('Functions in production:');
      console.table(procs);

      const tables = await query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('comunicacoes_cliente', 'orcamento_comunicacoes')
        ORDER BY table_name;
      `);
      console.log('Tables in production:');
      console.table(tables);
    } catch (e) {
      console.error('Error:', e);
      process.exit(1);
    }
  })();
}
