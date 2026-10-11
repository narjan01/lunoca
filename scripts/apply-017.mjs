import fs from 'node:fs';
import path from 'node:path';
import { query } from './supabase-client.mjs';

async function apply017() {
  console.log('🚀 Aplicando Migration 017 em Produção Supabase...');
  const migrationPath = path.resolve('supabase/migrations/017_aprovacao_orcamento_versao_obrigatoria.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  await query(sql);
  console.log('✅ Migration 017 aplicada com sucesso no Supabase!');

  console.log('\n🔍 Verificando assinatura de aprovar_orcamento_publico no catálogo pg_proc...');
  const resSig = await query(`
    SELECT
        p.proname,
        pg_get_function_arguments(p.oid) AS argumentos
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'aprovar_orcamento_publico';
  `);

  console.log('Assinatura confirmada em produção:', resSig);
  const sig = resSig[0]?.argumentos || '';

  if (sig === 'p_token uuid, p_versao_esperada integer') {
    console.log('🎉 SUCESSO: DEFAULT NULL foi eliminado com sucesso! Assinatura é estritamente obrigatória.');
  } else {
    console.error('❌ FALHA: Assinatura ainda contém default ou formato inesperado:', sig);
    process.exit(1);
  }

  console.log('\n🔒 Testando chamada sem versão (NULL) para validar guarda VERSION_REQUIRED...');
  const testRes = await query(`
    SELECT public.aprovar_orcamento_publico(gen_random_uuid(), NULL) AS res;
  `);
  console.log('Resultado com versão nula:', testRes[0]?.res);
  if (testRes[0]?.res?.code === 'VERSION_REQUIRED') {
    console.log('🎉 SUCESSO: VERSION_REQUIRED retornado com sucesso para versão nula!');
  } else {
    console.error('❌ FALHA: Resposta inesperada para versão nula:', testRes);
    process.exit(1);
  }
}

apply017().catch(err => {
  console.error('Erro na aplicação da Migration 017:', err);
  process.exit(1);
});
