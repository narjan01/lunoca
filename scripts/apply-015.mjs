import fs from 'node:fs';
import path from 'node:path';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('--- Aplicando Migration 015 no Supabase (Produção) ---');
  const migrationPath = path.resolve('supabase/migrations/015_comunicacao_whatsapp_e_relacionamento.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  console.log(`Lendo ${migrationPath} (${sql.length} bytes)...`);
  const result = await query(sql);
  console.log('Resultado da execução:', result);

  console.log('--- Verificando funções criadas/atualizadas em public ---');
  const procs = await query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'normalizar_telefone_e164',
        'obter_preview_comunicacao',
        'registrar_comunicacao_cliente',
        'aprovar_orcamento_publico',
        'listar_orcamentos_para_lembrete'
      )
    ORDER BY p.proname;
  `);
  console.table(procs);

  console.log('--- Verificando policies em comunicacoes_cliente ---');
  const policies = await query(`
    SELECT policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'comunicacoes_cliente';
  `);
  console.table(policies);
}

main().catch(e => {
  console.error('Falha ao aplicar migration 015:', e);
  process.exit(1);
});
