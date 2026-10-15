// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE CONTRATO RUNTIME DE RPCs CRÍTICAS
// ==============================================================================
// Garante que RPCs com dependências dinâmicas em SQL/PLpgSQL não possuam
// referências a colunas ou variáveis inexistentes (evitando erros 42703 em runtime).
// Prova a esteira completa:
// 1. buscar_orcamentos_admin (hotfix 033 sem p_novo_status)
// 2. abrir_sessao_caixa (034)
// 3. registrar_movimentacao_caixa (034/035) com ownership forçado
// 4. registrar_producao_produto_pronto (032)
// 5. finalizar_venda_pdv (032/034/035):
//    - status_comercial = 'concluido'
//    - status_operacional = 'retirado'
//    - status_financeiro = 'pago'
//    - pedido_status_historico gravado com status_novo = 'retirado'
//    - caixa_sessao_pagamentos vinculado à sessão
// 6. fechar_sessao_caixa (034/035) com fechamento cego e snapshots
// ==============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { setupEmbeddedPostgres } from './_pg_lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54454;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';

let prodId;
let ingId;

const activeClients = [];
async function newClient(identity = 'service_role') {
  const c = new pg.Client(connInfo);
  await c.connect();
  activeClients.push(c);
  await setIdentity(c, identity);
  return c;
}

async function closeClient(c) {
  const idx = activeClients.indexOf(c);
  if (idx !== -1) activeClients.splice(idx, 1);
  try { await c.end(); } catch {}
}

async function setIdentity(c, identity) {
  const claims = identity === 'service_role'
    ? { role: 'service_role' }
    : identity === 'anon'
      ? { role: 'anon' }
      : { role: 'authenticated', sub: identity };

  await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  if (identity === 'anon') {
    await c.query('SET ROLE anon');
  } else if (identity === 'service_role') {
    await c.query('RESET ROLE');
  } else {
    await c.query('SET ROLE authenticated');
  }
}

async function rpc(c, fnName, args = {}) {
  const keys = Object.keys(args);
  const callParams = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const sql = keys.length === 0
    ? `SELECT public.${fnName}() AS res`
    : `SELECT public.${fnName}(${callParams}) AS res`;
  const vals = keys.map((k) => {
    const val = args[k];
    if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
      return JSON.stringify(val);
    }
    return val;
  });
  const { rows } = await c.query(sql, vals);
  return rows[0]?.res;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-rpc-contract',
    port: PORT,
    dbName: 'lunoca_rpc_contract'
  });
  connInfo = setup.connInfo;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const installSql = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf-8');
  await admin.query(installSql);

  await setIdentity(admin, 'service_role');

  await admin.query(`
    INSERT INTO auth.users (id, email)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test'),
      ('${OPER_UID}',  'oper@lunoca.test')
    ON CONFLICT (id) DO NOTHING;
  `);

  await admin.query(`
    INSERT INTO public.profiles (id, email, nivel, nome, ativo)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test', 'admin',    'Admin Lunoca', true),
      ('${OPER_UID}',  'oper@lunoca.test',  'operador', 'Operador Lunoca', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  const resProd = await admin.query(`
    INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
    VALUES ('Bolo Vulcão Contract Test', 35.00, 20, true, true)
    RETURNING id;
  `);
  prodId = Number(resProd.rows[0].id);

  const resIng = await admin.query(`
    INSERT INTO public.ingredientes (nome, unidade, custo_unitario, estoque_minimo, ativo)
    VALUES ('Chocolate 50%', 'g', 0.0400, 100, true)
    RETURNING id;
  `);
  ingId = Number(resIng.rows[0].id);

  await admin.query(`
    INSERT INTO public.ingrediente_saldos (ingrediente_id, saldo_atual, custo_medio_ponderado)
    VALUES (${ingId}, 5000.000, 0.0400)
    ON CONFLICT (ingrediente_id) DO UPDATE SET saldo_atual = EXCLUDED.saldo_atual;
  `);

  await admin.query(`
    INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
    VALUES (${prodId}, ${ingId}, 50.000)
    ON CONFLICT (produto_id, ingrediente_id) DO UPDATE SET quantidade = EXCLUDED.quantidade;
  `);

  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'true', false);`);
  await admin.query(`
    INSERT INTO public.ingrediente_lotes (
      ingrediente_id, codigo_lote, quantidade_inicial, quantidade_atual,
      custo_unitario_lote, data_validade, data_recebimento, bloqueado_qualidade
    ) VALUES (
      ${ingId}, 'LOTE-ING-CONTRACT-01', 5000.000, 5000.000, 0.0400, CURRENT_DATE + INTERVAL '60 days', CURRENT_DATE, false
    ) ON CONFLICT (ingrediente_id, codigo_lote) DO NOTHING;
  `);
  // Zera lotes automáticos residuais para manter SUM(lotes) == saldo_atual exato
  await admin.query(`
    UPDATE public.ingrediente_lotes
    SET quantidade_atual = 0.000
    WHERE ingrediente_id = ${ingId}
      AND codigo_lote NOT IN ('LOTE-ING-CONTRACT-01');
  `);
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', '', false);`);
});

after(async () => {
  for (const c of [...activeClients]) {
    await closeClient(c);
  }
  if (admin) {
    try { await admin.end(); } catch {}
  }
  if (teardownFn) {
    await teardownFn();
  }
});

// ==============================================================================
// TESTES DE CONTRATO RUNTIME DE RPCs CRÍTICAS
// ==============================================================================

test('CONTRACT 1: buscar_orcamentos_admin executa sem erro de variável (hotfix 033)', async () => {
  const cAdmin = await newClient(ADMIN_UID);

  const res = await rpc(cAdmin, 'buscar_orcamentos_admin', {
    p_status: 'todos',
    p_limite: 10,
    p_offset: 0
  });

  assert.ok(res !== null && typeof res === 'object', 'buscar_orcamentos_admin deve retornar objeto');
  assert.equal(res.success, true);
  assert.ok(Array.isArray(res.orcamentos));

  await closeClient(cAdmin);
});

test('CONTRACT 2: Fluxo end-to-end de Caixa -> Produção -> Venda PDV -> Histórico -> Fechamento', async () => {
  const cOper = await newClient(OPER_UID);

  // 1. Abrir sessão de caixa
  const resAbertura = await rpc(cOper, 'abrir_sessao_caixa', {
    p_fundo_troco: 150.00,
    p_terminal: 'TERM-CONTRACT-01',
    p_observacoes: 'Abertura para teste de contrato runtime'
  });
  assert.equal(resAbertura.success, true);
  const sessaoId = resAbertura.sessao_id;
  assert.ok(sessaoId > 0);

  // 2. Registrar movimentação (suprimento)
  const resMov = await rpc(cOper, 'registrar_movimentacao_caixa', {
    p_tipo: 'SUPRIMENTO',
    p_valor: 50.00,
    p_motivo: 'Reforço de moedas para troco',
    p_idempotency_key: 'mov_suprimento_contract_01'
  });
  assert.equal(resMov.success, true);

  // 3. Produzir produto pronto
  const resProd = await rpc(cOper, 'registrar_producao_produto_pronto', {
    p_produto_id: prodId,
    p_quantidade_produzida: 5,
    p_data_validade: (new Date(Date.now() + 86400000 * 5)).toISOString().split('T')[0],
    p_codigo_lote: 'PT-CONTRACT-VULCAO-01'
  });
  assert.equal(resProd.success, true);
  const loteId = resProd.lote_id;
  assert.ok(loteId > 0);

  // 4. Finalizar venda PDV em dinheiro (R$ 35,00)
  const resVenda = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodId, quantidade: 1 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'pdv_venda_contract_01',
    p_observacoes: 'Venda de contrato'
  });

  assert.equal(resVenda.success, true);
  const pedidoId = resVenda.pedido_id;
  assert.ok(pedidoId > 0);
  assert.equal(resVenda.status_comercial, 'concluido');
  assert.equal(resVenda.status_operacional, 'retirado');
  assert.equal(resVenda.status_financeiro, 'pago');
  assert.equal(Number(resVenda.total), 35.00);

  // 5. Prova física de auditoria em public.pedido_status_historico
  const { rows: rowsHist } = await admin.query(
    `SELECT * FROM public.pedido_status_historico WHERE pedido_id = $1 ORDER BY id DESC LIMIT 1;`,
    [pedidoId]
  );
  assert.equal(rowsHist.length, 1, 'Deve haver exatamente 1 registro no histórico de status');
  assert.equal(rowsHist[0].dimensao, 'operacional');
  assert.equal(rowsHist[0].status_novo, 'retirado', 'Status novo deve ser "retirado" no schema canônico');
  assert.equal(rowsHist[0].origem, 'admin');
  assert.equal(rowsHist[0].usuario_id, OPER_UID);

  // 6. Prova de vínculo de pagamento em caixa_sessao_pagamentos
  const { rows: rowsPagCaixa } = await admin.query(
    `SELECT * FROM public.caixa_sessao_pagamentos WHERE pedido_id = $1;`,
    [pedidoId]
  );
  assert.equal(rowsPagCaixa.length, 1, 'Deve haver exatamente 1 vínculo em caixa_sessao_pagamentos');
  assert.equal(Number(rowsPagCaixa[0].sessao_id), Number(sessaoId));
  assert.equal(rowsPagCaixa[0].metodo, 'dinheiro');
  assert.equal(Number(rowsPagCaixa[0].valor), 35.00);

  // 7. Fechamento cego de caixa
  // Saldo esperado: 150 (fundo) + 50 (suprimento) + 35 (dinheiro) = R$ 235,00
  const resFechamento = await rpc(cOper, 'fechar_sessao_caixa', {
    p_valor_contado_dinheiro: 235.00,
    p_observacoes: 'Fechamento perfeito de contrato',
    p_idempotency_key: 'fechamento_contract_01'
  });

  assert.equal(resFechamento.success, true);
  assert.equal(resFechamento.status, 'FECHADA');
  assert.equal(Number(resFechamento.saldo_esperado_dinheiro), 235.00);
  assert.equal(Number(resFechamento.valor_contado_dinheiro), 235.00);
  assert.equal(Number(resFechamento.diferenca_caixa), 0.00);

  await closeClient(cOper);
});
