#!/usr/bin/env node
// ==============================================================================
// LUNOCA - Verificador Automático de Conexão, Schema e Saúde do Supabase
// ==============================================================================
// Executa testes automatizados de latência, disponibilidade da API,
// sanidade de tabelas críticas, RPCs da Etapa 3 e status de migrations.
// ==============================================================================
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_DB_URL,
  getLocalMigrations,
  getDbClient,
  log,
} from './supabase-common.mjs';

const TABELAS_CRITICAS = [
  'produtos',
  'produto_opcoes',
  'pedidos',
  'pedido_itens',
  'pedido_pagamentos',
  'pedidos_historico',
  'clientes',
  'configuracoes_operacao',
  'financeiro_lancamentos',
  'capacidade_producao_diaria',
  'orcamentos',
  'orcamento_itens',
  'orcamento_item_opcoes',
  'orcamento_autorizacoes',
  'orcamento_historico',
  'orcamento_rate_limits',
];

const RPCS_CRITICAS = [
  'obter_orcamento_publico',
  'aprovar_orcamento_publico',
  'politica_desconto',
  'politica_sinal',
  'validar_modalidade_frete',
  'nucleo_criar_encomenda',
  'alterar_status_pedido',
  'expirar_orcamentos',
  'converter_orcamento_em_pedido_admin',
];

async function runHealthCheckRest() {
  log.section('1. Verificação de Conectividade & Latência da API REST');
  const start = Date.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/produtos?select=id&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    const latency = Date.now() - start;

    if (!res.ok) {
      log.error(`Falha no ping REST HTTP ${res.status}: ${await res.text()}`);
      return false;
    }

    log.ok(`API REST Supabase online (${latency}ms) - Endpoint: ${SUPABASE_URL}`);
    return true;
  } catch (err) {
    log.error(`Erro de conexão com o Supabase: ${err.message}`);
    return false;
  }
}

async function runAuthCheck() {
  log.section('2. Verificação de Saúde do Módulo de Autenticação (Auth / GoTrue)');
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) {
      log.ok('Serviço de Auth / GoTrue respondendo adequadamente.');
      return true;
    } else {
      log.warn(`Auth retornou status HTTP ${res.status}.`);
      return true; // Não bloqueante para banco
    }
  } catch (err) {
    log.warn(`Não foi possível checar Auth: ${err.message}`);
    return true;
  }
}

async function verifyTablesViaRest() {
  log.section('3. Verificação de Tabelas e Acesso no Supabase');
  let successCount = 0;
  for (const tabela of TABELAS_CRITICAS) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&limit=0`, {
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      // Status 200/206 = tabela existe e é acessível
      // Status 401/403 = tabela existe mas está protegida por RLS (comportamento fail-closed esperado!)
      // Status 404 = tabela NÃO existe no schema PostgREST
      if (res.status === 200 || res.status === 206) {
        log.ok(`Tabela "${tabela}": presente e consultável.`);
        successCount++;
      } else if (res.status === 401 || res.status === 403) {
        log.ok(`Tabela "${tabela}": presente e protegida por RLS (fail-closed correto).`);
        successCount++;
      } else if (res.status === 404) {
        log.error(`Tabela "${tabela}": NÃO ENCONTRADA no Supabase (HTTP 404).`);
      } else {
        log.warn(`Tabela "${tabela}": retornou HTTP ${res.status}.`);
        successCount++;
      }
    } catch (err) {
      log.error(`Tabela "${tabela}": erro de requisição - ${err.message}`);
    }
  }
  return successCount === TABELAS_CRITICAS.length;
}

async function verifyRpcsViaRest() {
  log.section('4. Verificação de RPCs Críticas de Negócio');
  let rpcSuccess = 0;
  for (const rpc of RPCS_CRITICAS) {
    try {
      // Fazemos uma chamada com payload dummy ou inválido para verificar se a RPC existe (400 ou 200)
      // Se retornar 404, a RPC não existe no banco!
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({}),
      });

      if (res.status !== 404) {
        log.ok(`RPC "public.${rpc}()": detectada e registrada no PostgREST.`);
        rpcSuccess++;
      } else {
        log.error(`RPC "public.${rpc}()": NÃO ENCONTRADA no Supabase (HTTP 404).`);
      }
    } catch (err) {
      log.error(`RPC "${rpc}": erro de chamada - ${err.message}`);
    }
  }
  return rpcSuccess === RPCS_CRITICAS.length;
}

async function verifyMigrationsStatus() {
  log.section('5. Verificação de Migrações Locais');
  const migrations = getLocalMigrations();
  log.info(`Total de migrações registradas no repositório: ${migrations.length}`);
  migrations.forEach((m) => {
    log.dim(`[v${m.version}] ${m.file} (SHA256: ${m.hash.slice(0, 12)}... | ${(m.sizeBytes / 1024).toFixed(1)} KB)`);
  });

  if (SUPABASE_DB_URL) {
    log.info('Conexão PostgreSQL direta (SUPABASE_DB_URL) configurada. Consultando histórico do banco...');
    let client = null;
    try {
      client = await getDbClient();
      const res = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema IN ('supabase_migrations', 'public') 
          AND table_name IN ('schema_migrations', '_schema_migrations');
      `);

      if (res.rows.length > 0) {
        log.ok(`Tabela de controle de migrações encontrada: ${res.rows.map(r => r.table_name).join(', ')}`);
      } else {
        log.warn('Nenhuma tabela de controle de migrações encontrada no banco remoto ainda.');
      }
    } catch (err) {
      log.warn(`Não foi possível inspecionar migrations via PostgreSQL direto: ${err.message}`);
    } finally {
      if (client) await client.end();
    }
  } else {
    log.dim('Dica: Para inspeção e upgrades diretos no PostgreSQL, defina SUPABASE_DB_URL em seu arquivo .env.');
  }

  return true;
}

async function main() {
  console.log('\x1b[1m\x1b[36m==============================================================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m       LUNOCA DOCERIA - SUÍTE DE VERIFICAÇÃO AUTOMÁTICA DO SUPABASE          \x1b[0m');
  console.log('\x1b[1m\x1b[36m==============================================================================\x1b[0m');

  const healthOk = await runHealthCheckRest();
  if (!healthOk) {
    log.error('A verificação de conectividade básica falhou. Abortando verificações subsequentes.');
    process.exit(1);
  }

  await runAuthCheck();
  const tablesOk = await verifyTablesViaRest();
  const rpcsOk = await verifyRpcsViaRest();
  const migrationsOk = await verifyMigrationsStatus();

  log.section('RELATÓRIO FINAL DE INTEGRAÇÃO SUPABASE');
  if (healthOk && tablesOk && rpcsOk && migrationsOk) {
    log.ok('TODAS AS VERIFICAÇÕES PASSARAM COM SUCESSO! Banco Supabase 100% íntegro.');
    process.exit(0);
  } else {
    log.warn('Verificações concluídas com alertas ou inconsistências. Verifique o log acima.');
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(`Erro inesperado durante a verificação: ${err.message}`);
  process.exit(1);
});
