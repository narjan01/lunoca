// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 018 (FRENTE C)
// ==========================================================================
// Valida os 15 gates (C1 a C15) da Carteira de Créditos do Cliente:
// - C1: Cancelamento pago -> crédito exatamente uma vez.
// - C2: Retry de cancelamento ou uso é estritamente idempotente.
// - C3: Operador não cria crédito arbitrário (PERMISSION_DENIED).
// - C4: Admin cria ajuste com motivo obrigatório (>= 5 caracteres).
// - C5: Saldo nunca negativo (constraint de banco saldo >= 0.00).
// - C6: Concorrência serializada sem gasto duplo.
// - C7: Uso parcial de crédito em pedido.
// - C8: Pagamento misto Crédito + Outro método.
// - C9: Cancelamento com CREDITO_CLIENTE fecha pedido sem pendências financeiras.
// - C10: ESTORNO devolve à carteira a parcela originalmente paga em crédito.
// - C11: Uso de crédito não gera nova receita no DRE (financeiro_lancamentos).
// - C12: Extrato preserva trilha completa de auditoria.
// - C13: Cancelamento misto (R$ 60 crédito + R$ 40 PIX) retorna exatamente R$ 100 à carteira.
// - C14: Retry concorrente de utilização gera apenas um débito.
// - C15: Anon e authenticated comum não executam RPC administrativa.
// ==========================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { setupEmbeddedPostgres } from './_pg_lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54395;

let embedded = null;
let admin; // conexão superuser
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const CLIENTE_UID = '33333333-3333-3333-3333-333333333333';

const activeClients = [];
async function newClient(identity = 'service_role') {
  const c = new pg.Client(connInfo);
  await c.connect();
  activeClients.push(c);
  await setIdentity(c, identity);
  return c;
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

async function rpc(c, fn, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const { rows } = await c.query(`SELECT public.${fn}(${placeholders}) AS r`, keys.map((k) => params[k]));
  return rows[0].r;
}

// Helpers para criar clientes e pedidos de teste
let seqCliente = 8000;
let seqPedido = 9000;

async function criarClienteTeste(nome = 'Cliente Teste C', telefone = null) {
  seqCliente++;
  const tel = telefone || `558599${String(seqCliente).padStart(7, '0')}`;
  const { rows } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email)
    VALUES ($1, $2, $2, $3)
    RETURNING id;
  `, [nome, tel, `cliente_${seqCliente}@teste.local`]);
  return rows[0].id;
}

async function criarPedidoTeste({ clienteId, total = 100.00, valorPago = 0.00, canal = 'balcao' }) {
  seqPedido++;
  const saldoCalc = Math.max(0, total - valorPago);
  const sinalCalc = total * 0.5;
  const statusFin = valorPago === 0 ? 'nao_pago' : (valorPago >= total ? 'pago' : 'parcialmente_pago');
  const { rows } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, telefone_cliente, email_cliente,
      data_pedido, data_entrega, hora_entrega, total, subtotal,
      valor_pago, saldo, sinal_minimo, status_comercial, status_financeiro, status_operacional,
      canal, pagamento, itens, endereco_entrega
    ) VALUES (
      $1, $2, 'Cliente Pedido', '5585999999999', 'ped@teste.local',
      CURRENT_DATE, (CURRENT_DATE + INTERVAL '3 days')::DATE, '14:00:00'::TIME, $3, $3,
      $4, $5, $6, 'confirmado',
      $7, 'aguardando_producao', $8, 'pix', 'Bolo Teste (1x)', 'Retirada no Balcão'
    ) RETURNING id;
  `, [seqPedido, clienteId, total, valorPago, saldoCalc, sinalCalc, statusFin, canal]);
  return rows[0].id;
}

async function registrarPagamento(pedidoId, valor, metodo = 'pix', status = 'aprovado') {
  const { rows } = await admin.query(`
    INSERT INTO public.pedido_pagamentos (
      pedido_id, valor, metodo, provider, status, pago_em, registrado_por
    ) VALUES (
      $1, $2, $3, 'manual', $4, NOW(), '${ADMIN_UID}'
    ) RETURNING id;
  `, [pedidoId, valor, metodo, status]);
  return rows[0].id;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-018',
    port: PORT,
    dbName: 'lunoca_test_018'
  });
  connInfo = setup.connInfo;
  embedded = setup.embedded;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const install = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8');
  await admin.query(install);

  await admin.query(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  `);

  await setIdentity(admin, 'service_role');
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin@lunoca.local'),
      ('${OPER_UID}', 'operador@lunoca.local'),
      ('${CLIENTE_UID}', 'cliente@lunoca.local')
    ON CONFLICT (id) DO NOTHING;
  `);

  await admin.query(`
    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin Master', 'admin@lunoca.local', 'admin', true),
      ('${OPER_UID}', 'Operador Balcao', 'operador@lunoca.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente VIP', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;
  `);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// --------------------------------------------------------------------------
// GATE C1: Cancelamento pago -> crédito exatamente uma vez
// --------------------------------------------------------------------------
test('C1: Cancelamento pago -> crédito gerado exatamente uma vez na carteira', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C1');
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 100.00, valorPago: 50.00 });
  await registrarPagamento(pedId, 50.00, 'pix', 'aprovado');

  const res = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cliente solicitou cancelamento com crédito',
    p_destino_valor: 'CREDITO_CLIENTE'
  });

  assert.equal(res.success, true);
  assert.equal(res.status_comercial, 'cancelado');

  // Verifica saldo do cliente
  const saldoRes = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(saldoRes.success, true);
  assert.equal(Number(saldoRes.saldo), 50.00);
  assert.equal(saldoRes.extrato.length, 1);
  assert.equal(saldoRes.extrato[0].origem, 'cancelamento_pedido');
  assert.equal(Number(saldoRes.extrato[0].valor), 50.00);
});

// --------------------------------------------------------------------------
// GATE C2: Retry de cancelamento é estritamente idempotente
// --------------------------------------------------------------------------
test('C2: Retry de cancelamento é idempotente e não duplica saldo de crédito', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C2');
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 80.00, valorPago: 80.00 });
  await registrarPagamento(pedId, 80.00, 'pix', 'aprovado');

  const res1 = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento C2',
    p_destino_valor: 'CREDITO_CLIENTE'
  });
  assert.equal(res1.success, true);

  // Segunda chamada (retry)
  const res2 = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento C2 retry',
    p_destino_valor: 'CREDITO_CLIENTE'
  });
  assert.equal(res2.success, true);
  assert.equal(res2.idempotente, true);

  // Saldo deve continuar rigorosamente 80.00 (nunca 160.00)
  const saldoRes = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoRes.saldo), 80.00);
  assert.equal(saldoRes.extrato.length, 1);
});

// --------------------------------------------------------------------------
// GATE C3: Operador não cria crédito arbitrário (PERMISSION_DENIED)
// --------------------------------------------------------------------------
test('C3: Operador não cria crédito arbitrário (PERMISSION_DENIED)', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C3');

  const res = await rpc(oper, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 100.00,
    p_motivo: 'Tentativa de crédito por operador',
    p_request_id: 'c3-req'
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');

  const saldoRes = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoRes.saldo), 0.00);
});

// --------------------------------------------------------------------------
// GATE C4: Admin cria ajuste com motivo obrigatório (>= 5 caracteres)
// --------------------------------------------------------------------------
test('C4: Admin cria ajuste com motivo obrigatório (>= 5 caracteres)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteTeste('Cliente C4');

  // Motivo curto demais (< 5 chars)
  const resCurto = await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 35.00,
    p_motivo: 'Erro',
    p_request_id: 'c4-fail'
  });
  assert.equal(resCurto.success, false);
  assert.equal(resCurto.code, 'REASON_REQUIRED');

  // Motivo válido
  const resOk = await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 35.00,
    p_motivo: 'Bonificação concedida pela gerência',
    p_request_id: 'c4-ok'
  });
  assert.equal(resOk.success, true);
  assert.equal(Number(resOk.saldo_posterior), 35.00);
});

// --------------------------------------------------------------------------
// GATE C5: Saldo nunca negativo (constraint de banco saldo >= 0.00)
// --------------------------------------------------------------------------
test('C5: Débito maior que saldo retorna INSUFFICIENT_CREDIT_BALANCE e saldo >= 0 no banco', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteTeste('Cliente C5');

  // Ajusta saldo para 20
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 20.00,
    p_motivo: 'Saldo inicial C5',
    p_request_id: 'c5-init'
  });

  // Tenta debitar 50
  const debRes = await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'debito',
    p_valor: 50.00,
    p_motivo: 'Tentativa de débito excessivo',
    p_request_id: 'c5-over'
  });
  assert.equal(debRes.success, false);
  assert.equal(debRes.code, 'INSUFFICIENT_CREDIT_BALANCE');

  // Verifica que o saldo continua exatamente 20.00
  const { rows } = await admin.query('SELECT saldo FROM public.cliente_creditos WHERE cliente_id = $1', [cid]);
  assert.equal(Number(rows[0].saldo), 20.00);
});

// --------------------------------------------------------------------------
// GATE C6: Concorrência serializada sem gasto duplo
// --------------------------------------------------------------------------
test('C6: Duas requisições simultâneas de débito não geram gasto duplo', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteTeste('Cliente C6');

  // Crédito de R$ 50
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Depósito inicial para corrida',
    p_request_id: 'c6-init'
  });

  const c1 = await newClient(ADMIN_UID);
  const c2 = await newClient(ADMIN_UID);

  // Dois débitos concorrentes de R$ 40 cada (total R$ 80, mas saldo é 50)
  const [r1, r2] = await Promise.all([
    rpc(c1, 'ajustar_credito_cliente_admin', {
      p_cliente_id: cid,
      p_tipo: 'debito',
      p_valor: 40.00,
      p_motivo: 'Debito concorrente 1',
      p_request_id: 'c6-corrida-1'
    }),
    rpc(c2, 'ajustar_credito_cliente_admin', {
      p_cliente_id: cid,
      p_tipo: 'debito',
      p_valor: 40.00,
      p_motivo: 'Debito concorrente 2',
      p_request_id: 'c6-corrida-2'
    })
  ]);

  const sucessos = [r1, r2].filter(r => r.success === true);
  const falhas = [r1, r2].filter(r => r.success === false);

  assert.equal(sucessos.length, 1, 'Exatamente um débito deve ter sucesso');
  assert.equal(falhas.length, 1, 'Exatamente um débito deve falhar por falta de saldo');
  assert.equal(falhas[0].code, 'INSUFFICIENT_CREDIT_BALANCE');

  const saldoRes = await rpc(adm, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoRes.saldo), 10.00);
});

// --------------------------------------------------------------------------
// GATE C7: Uso parcial de crédito em pedido
// --------------------------------------------------------------------------
test('C7: Uso parcial de crédito em pedido quita parcela e abate saldo', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C7');

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 40.00,
    p_motivo: 'Crédito para uso parcial',
    p_request_id: 'c7-credit'
  });

  // Pedido de 100 reais
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 100.00, valorPago: 0.00 });

  // Aplica 40 de crédito
  const usoRes = await rpc(oper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 40.00
  });

  assert.equal(usoRes.success, true);
  assert.equal(Number(usoRes.valor_utilizado), 40.00);
  assert.equal(Number(usoRes.saldo_credito_restante), 0.00);

  // Verifica pedido no banco
  const { rows: [p] } = await admin.query('SELECT valor_pago, saldo, status_financeiro FROM public.pedidos WHERE id = $1', [pedId]);
  assert.equal(Number(p.valor_pago), 40.00);
  assert.equal(Number(p.saldo), 60.00);
  assert.equal(p.status_financeiro, 'parcialmente_pago');
});

// --------------------------------------------------------------------------
// GATE C8: Pagamento misto Crédito + PIX/Cartão funciona
// --------------------------------------------------------------------------
test('C8: Pagamento misto (R$ 50 Crédito + R$ 50 PIX) liquida integralmente o pedido', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C8');

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Crédito misto',
    p_request_id: 'c8-credit'
  });

  const pedId = await criarPedidoTeste({ clienteId: cid, total: 100.00, valorPago: 0.00 });

  // 1. Usa crédito de 50
  await rpc(oper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 50.00
  });

  // 2. Paga os 50 restantes via PIX
  await registrarPagamento(pedId, 50.00, 'pix', 'aprovado');

  const { rows: [p] } = await admin.query('SELECT valor_pago, saldo, status_financeiro FROM public.pedidos WHERE id = $1', [pedId]);
  assert.equal(Number(p.valor_pago), 100.00);
  assert.equal(Number(p.saldo), 0.00);
  assert.equal(p.status_financeiro, 'pago');
});

// --------------------------------------------------------------------------
// GATE C9: Cancelamento com CREDITO_CLIENTE fecha pedido sem pendências
// --------------------------------------------------------------------------
test('C9: Cancelamento com CREDITO_CLIENTE cancela comercialmente e estorna pagamentos', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C9');
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 120.00, valorPago: 60.00 });
  await registrarPagamento(pedId, 60.00, 'pix', 'aprovado');

  const res = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento C9',
    p_destino_valor: 'CREDITO_CLIENTE'
  });
  assert.equal(res.success, true);

  const { rows: [p] } = await admin.query('SELECT status_comercial, status_operacional, status_financeiro, valor_pago FROM public.pedidos WHERE id = $1', [pedId]);
  assert.equal(p.status_comercial, 'cancelado');
  assert.equal(p.status_operacional, 'cancelado');
  assert.equal(p.status_financeiro, 'estornado');
  assert.equal(Number(p.valor_pago), 0.00);
});

// --------------------------------------------------------------------------
// GATE C10: ESTORNO devolve à carteira a parcela originalmente paga em crédito
// --------------------------------------------------------------------------
test('C10: ESTORNO devolve parcela em crédito para a carteira com movimentacao_origem_id', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C10');

  // Cliente tem 70 de saldo inicial
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 70.00,
    p_motivo: 'Saldo inicial C10',
    p_request_id: 'c10-init'
  });

  const pedId = await criarPedidoTeste({ clienteId: cid, total: 100.00, valorPago: 0.00 });

  // Paga 70 em crédito e 30 em PIX
  const usoRes = await rpc(oper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 70.00
  });
  await registrarPagamento(pedId, 30.00, 'pix', 'aprovado');

  // Cancela com ESTORNO (70 deve voltar pra carteira; 30 vai para estorno externo)
  const canRes = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento com estorno',
    p_destino_valor: 'ESTORNO'
  });
  assert.equal(canRes.success, true);

  // Saldo na carteira volta para 70.00
  const saldoRes = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoRes.saldo), 70.00);

  // Verifica vínculo com a movimentação original de débito
  const { rows: [movEstorno] } = await admin.query(`
    SELECT movimentacao_origem_id, origem, valor
    FROM public.cliente_credito_movimentacoes
    WHERE cliente_id = $1 AND origem = 'estorno_uso_pedido'
  `, [cid]);

  assert.ok(movEstorno);
  assert.equal(Number(movEstorno.valor), 70.00);
  assert.equal(Number(movEstorno.movimentacao_origem_id), usoRes.movimentacao_id);
});

// --------------------------------------------------------------------------
// GATE C11: Uso de crédito não gera nova receita de caixa no DRE
// --------------------------------------------------------------------------
test('C11: Uso de credito_cliente NÃO lança nova receita nem despesa indevida no DRE', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C11');

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Saldo C11',
    p_request_id: 'c11-init'
  });

  const pedId = await criarPedidoTeste({ clienteId: cid, total: 50.00, valorPago: 0.00 });

  // Antes do uso
  const { rows: [antes] } = await admin.query(`
    SELECT COUNT(*) as cnt FROM public.financeiro_lancamentos WHERE pedido_id = $1
  `, [pedId]);
  assert.equal(Number(antes.cnt), 0);

  // Usa crédito
  await rpc(oper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 50.00
  });

  // Não deve ter criado receita em financeiro_lancamentos
  const { rows: [depois] } = await admin.query(`
    SELECT COUNT(*) as cnt FROM public.financeiro_lancamentos WHERE pedido_id = $1
  `, [pedId]);
  assert.equal(Number(depois.cnt), 0, 'Uso de saldo de carteira não pode criar lançamento de receita redundante no DRE');
});

// --------------------------------------------------------------------------
// GATE C12: Extrato preserva trilha completa de auditoria
// --------------------------------------------------------------------------
test('C12: Extrato preserva trilha completa (saldo_anterior, saldo_posterior, origem, pedido_id, usuario_nome)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteTeste('Cliente C12');

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 100.00,
    p_motivo: 'Ajuste inicial C12',
    p_request_id: 'c12-aud-1'
  });

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'debito',
    p_valor: 30.00,
    p_motivo: 'Ajuste de debito C12',
    p_request_id: 'c12-aud-2'
  });

  const saldoRes = await rpc(adm, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(saldoRes.extrato.length, 2);

  const [mDeb, mCred] = saldoRes.extrato;
  assert.equal(Number(mCred.saldo_anterior), 0.00);
  assert.equal(Number(mCred.saldo_posterior), 100.00);
  assert.equal(mCred.tipo, 'credito');

  assert.equal(Number(mDeb.saldo_anterior), 100.00);
  assert.equal(Number(mDeb.saldo_posterior), 70.00);
  assert.equal(mDeb.tipo, 'debito');
  assert.ok(mDeb.usuario_nome);
});

// --------------------------------------------------------------------------
// GATE C13: Cancelamento misto (R$ 60 crédito + R$ 40 PIX) -> R$ 100 na carteira
// --------------------------------------------------------------------------
test('C13: Cancelamento misto (R$ 60 crédito + R$ 40 PIX) retorna exatamente R$ 100 à carteira', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteTeste('Cliente C13');

  // Dá 60 de crédito inicial
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 60.00,
    p_motivo: 'C13 credito inicial',
    p_request_id: 'c13-init'
  });

  // Pedido total 100
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 100.00, valorPago: 0.00 });

  // Paga 60 com crédito
  await rpc(oper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 60.00
  });

  // Paga 40 com PIX
  await registrarPagamento(pedId, 40.00, 'pix', 'aprovado');

  // Carteira agora está com 0
  let saldoCheck = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoCheck.saldo), 0.00);

  // Cancela com CREDITO_CLIENTE (deve devolver os 60 do crédito + os 40 do PIX = R$ 100 para a carteira)
  const canRes = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento misto integral para carteira',
    p_destino_valor: 'CREDITO_CLIENTE'
  });
  assert.equal(canRes.success, true);

  // Saldo na carteira deve ser rigorosamente 100.00
  saldoCheck = await rpc(oper, 'consultar_saldo_credito', { p_cliente_id: cid });
  assert.equal(Number(saldoCheck.saldo), 100.00);
});

// --------------------------------------------------------------------------
// GATE C14: Retry concorrente de utilização de crédito gera apenas um débito
// --------------------------------------------------------------------------
test('C14: Duas chamadas de utilização de crédito concorrentes respeitam trava e saldo', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteTeste('Cliente C14');

  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 80.00,
    p_motivo: 'C14 saldo',
    p_request_id: 'c14-init'
  });

  const pedId = await criarPedidoTeste({ clienteId: cid, total: 80.00, valorPago: 0.00 });

  const c1 = await newClient(OPER_UID);
  const c2 = await newClient(OPER_UID);

  // Tenta pagar integralmente o pedido de 80.00 por dois clientes simultâneos
  const [res1, res2] = await Promise.all([
    rpc(c1, 'utilizar_credito_cliente_pedido', { p_pedido_id: pedId, p_valor: 80.00 }),
    rpc(c2, 'utilizar_credito_cliente_pedido', { p_pedido_id: pedId, p_valor: 80.00 })
  ]);

  const sucessos = [res1, res2].filter(r => r.success === true);
  const falhas = [res1, res2].filter(r => r.success === false);

  assert.equal(sucessos.length, 1);
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0].code, 'ORDER_ALREADY_PAID');

  const { rows: [p] } = await admin.query('SELECT valor_pago, saldo FROM public.pedidos WHERE id = $1', [pedId]);
  assert.equal(Number(p.valor_pago), 80.00);
  assert.equal(Number(p.saldo), 0.00);
});

// --------------------------------------------------------------------------
// GATE C15: Usuário anon e authenticated comum não executam RPC de crédito
// --------------------------------------------------------------------------
test('C15: Usuário anônimo e authenticated comum não executam RPC de crédito (RBAC)', async () => {
  const cid = await criarClienteTeste('Cliente C15');
  const pedId = await criarPedidoTeste({ clienteId: cid, total: 50.00 });

  const anonClient = await newClient('anon');
  const clienteAuthClient = await newClient(CLIENTE_UID);

  // Anon não pode ajustar nem utilizar
  await assert.rejects(async () => {
    await rpc(anonClient, 'ajustar_credito_cliente_admin', {
      p_cliente_id: cid, p_tipo: 'credito', p_valor: 10, p_motivo: 'teste anon'
    });
  }, /permission denied/i);

  await assert.rejects(async () => {
    await rpc(anonClient, 'utilizar_credito_cliente_pedido', {
      p_pedido_id: pedId, p_valor: 10
    });
  }, /permission denied/i);

  // Authenticated comum (cliente) recebe PERMISSION_DENIED
  const resAuthAjuste = await rpc(clienteAuthClient, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid, p_tipo: 'credito', p_valor: 10, p_motivo: 'tentativa cliente'
  });
  assert.equal(resAuthAjuste.success, false);
  assert.equal(resAuthAjuste.code, 'PERMISSION_DENIED');

  const resAuthUso = await rpc(clienteAuthClient, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId, p_valor: 10
  });
  assert.equal(resAuthUso.success, false);
  assert.equal(resAuthUso.code, 'PERMISSION_DENIED');
});
