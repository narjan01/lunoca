import { query } from './supabase-client.mjs';

async function main() {
  const res = await query(`
    SELECT
        p.proname,
        pg_get_function_arguments(p.oid) AS argumentos
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'aprovar_orcamento_publico';
  `);
  console.log('Assinatura em produção:', res);
}

main().catch(console.error);
