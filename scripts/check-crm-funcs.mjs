import { query } from './supabase-client.mjs';

async function main() {
  const sql = `
    SELECT
        p.proname,
        pg_get_function_identity_arguments(p.oid) AS argumentos
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
          'buscar_clientes_crm',
          'obter_cliente_360_admin',
          'obter_meu_perfil_360',
          'adicionar_nota_cliente',
          'arquivar_nota_cliente',
          'adicionar_tag_cliente',
          'remover_tag_cliente',
          'definir_preferencia_cliente',
          'arquivar_preferencia_cliente'
      )
    ORDER BY p.proname;
  `;
  const res = await query(sql);
  console.table(res);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
