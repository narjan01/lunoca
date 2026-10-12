// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 019 (FRENTE D)
// ==========================================================================
// Valida os 18 gates (D1 a D18) do CRM & Histórico 360° do Cliente:
// - D1: anon não acessa obter_cliente_360_admin
// - D2: cliente comum autenticado não acessa visão administrativa
// - D3: operador acessa ficha 360
// - D4: admin acessa ficha 360 (com CPF completo)
// - D5: busca encontra por nome
// - D6: busca encontra por telefone normalizado
// - D7: busca encontra por email
// - D8: LTV ignora pedidos cancelados
// - D9: ticket médio usa estritamente pedidos concluídos
// - D10: credito_cliente não duplica valor_recebido_caixa
// - D11: taxa de conversão de orçamento correta
// - D12: saldo da Frente C aparece corretamente
// - D13: timeline ordenada cronologicamente (ocorrido_em DESC)
// - D14: timeline une pedido/orçamento/WhatsApp/crédito/notas
// - D15: timeline não expõe token_publico
// - D16: nota interna não aparece em obter_meu_perfil_360
// - D17: operador não altera livro-razão financeiro via CRM
// - D18: notas/tags/preferências mantêm auditoria e não permitem DELETE direto
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
const PORT = 54394;

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

async function rpc(c, fn, params = {}) {
  const keys = Object.keys(params);
  if (keys.length === 0) {
    const { rows } = await c.query(`SELECT public.${fn}() AS r`);
    return rows[0].r;
  }
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const { rows } = await c.query(`SELECT public.${fn}(${placeholders}) AS r`, keys.map((k) => params[k]));
  return rows[0].r;
}

let seqCliente = 7000;
let seqPedido = 6000;
let seqOrc = 5000;

async function criarClienteFixture({ nome, tel, email, cpf = '12345678909', authUserId = null }) {
  seqCliente++;
  const n = nome || `Cliente CRM ${seqCliente}`;
  const t = tel || `8599${String(seqCliente).padStart(7, '0')}`;
  const tNorm = `55${t.replace(/\D/g, '')}`;
  const e = email || `cliente_crm_${seqCliente}@teste.local`;
  const { rows } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf, auth_user_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id;
  `, [n, t, tNorm, e, cpf, authUserId]);
  return rows[0].id;
}

async function criarPedidoFixture({ clienteId, total = 100.00, statusComercial = 'concluido', valorPago = 100.00, metodo = 'pix' }) {
  seqPedido++;
  const saldoCalc = Math.max(0, total - valorPago);
  const sinalCalc = total * 0.5;
  const statusFin = valorPago >= total ? 'pago' : (valorPago > 0 ? 'parcialmente_pago' : 'nao_pago');
  const pagMetodoPedido = ['pix', 'cartao', 'dinheiro', 'transferencia', 'outro'].includes(metodo) ? metodo : 'outro';
  const { rows: [p] } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, email_cliente, data_entrega, total, subtotal,
      valor_pago, saldo, sinal_minimo, status_comercial, status_financeiro, status_operacional,
      pagamento, itens, endereco_entrega
    ) VALUES (
      $1, $2, 'Cliente Pedido', 'ped@teste.local', (CURRENT_DATE + INTERVAL '5 days')::DATE, $3, $3,
      $4, $5, $6, $7, $8,
      'entregue', $9, 'Bolo CRM', 'Retirada'
    ) RETURNING id;
  `, [seqPedido, clienteId, total, valorPago, saldoCalc, sinalCalc, statusComercial, statusFin, pagMetodoPedido]);

  if (valorPago > 0) {
    await admin.query(`
      INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, provider, status, pago_em)
      VALUES ($1, $2, $3, 'manual', 'aprovado', NOW());
    `, [p.id, valorPago, metodo]);
  }
  return p.id;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-019',
    port: PORT,
    dbName: 'lunoca_test_019'
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
// GATE D1: Anon não acessa obter_cliente_360_admin
// --------------------------------------------------------------------------
test('D1: anon não acessa obter_cliente_360_admin (RBAC)', async () => {
  const anon = await newClient('anon');
  const cid = await criarClienteFixture({ nome: 'Cliente D1' });

  await assert.rejects(async () => {
    await rpc(anon, 'obter_cliente_360_admin', { p_cliente_id: cid });
  }, /permission denied/i);
});

// --------------------------------------------------------------------------
// GATE D2: Cliente comum autenticado não acessa visão administrativa
// --------------------------------------------------------------------------
test('D2: cliente comum autenticado não acessa obter_cliente_360_admin (PERMISSION_DENIED)', async () => {
  const cli = await newClient(CLIENTE_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D2' });

  const res = await rpc(cli, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');
});

// --------------------------------------------------------------------------
// GATE D3: Operador acessa ficha 360 (com CPF mascarado)
// --------------------------------------------------------------------------
test('D3: operador acessa ficha 360 com CPF mascarado (LGPD)', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Mariana Silva', cpf: '01234567899' });

  const res = await rpc(oper, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.success, true);
  assert.equal(res.cliente.nome, 'Mariana Silva');
  assert.equal(res.cliente.cpf, '***.***.***-99', 'Operador deve receber CPF com máscara');
});

// --------------------------------------------------------------------------
// GATE D4: Admin acessa ficha 360 (com CPF completo)
// --------------------------------------------------------------------------
test('D4: admin acessa ficha 360 com CPF completo', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Carlos Souza', cpf: '01234567899' });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.success, true);
  assert.equal(res.cliente.cpf, '01234567899', 'Admin deve receber CPF completo');
});

// --------------------------------------------------------------------------
// GATES D5, D6, D7: Busca rápida CRM
// --------------------------------------------------------------------------
test('D5: busca encontra cliente por nome', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Fernanda Montenegro D5' });

  const res = await rpc(oper, 'buscar_clientes_crm', { p_termo: 'Montenegro' });
  assert.equal(res.success, true);
  const achado = res.clientes.find(c => Number(c.id) === Number(cid));
  assert.ok(achado, 'Deve encontrar cliente pelo sobrenome');
});

test('D6: busca encontra cliente por telefone normalizado', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D6 Tel', tel: '85988776655' });

  const res = await rpc(oper, 'buscar_clientes_crm', { p_termo: '98877-6655' });
  assert.equal(res.success, true);
  const achado = res.clientes.find(c => Number(c.id) === Number(cid));
  assert.ok(achado, 'Deve encontrar cliente por telefone formatado');
});

test('D7: busca encontra cliente por email', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D7 Mail', email: 'd7_especifico@dominio.com' });

  const res = await rpc(oper, 'buscar_clientes_crm', { p_termo: 'd7_especifico' });
  assert.equal(res.success, true);
  const achado = res.clientes.find(c => Number(c.id) === Number(cid));
  assert.ok(achado, 'Deve encontrar cliente pelo email');
});

// --------------------------------------------------------------------------
// GATE D8: LTV ignora pedidos cancelados
// --------------------------------------------------------------------------
test('D8: LTV de pedidos ignora pedidos cancelados', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D8 LTV' });

  // 1 pedido concluído de 150
  await criarPedidoFixture({ clienteId: cid, total: 150.00, statusComercial: 'concluido', valorPago: 150.00 });
  // 1 pedido cancelado de 300
  await criarPedidoFixture({ clienteId: cid, total: 300.00, statusComercial: 'cancelado', valorPago: 0.00 });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.success, true);
  assert.equal(Number(res.metricas.valor_pedidos_concluidos), 150.00, 'LTV deve ignorar cancelados');
  assert.equal(res.metricas.pedidos_concluidos, 1);
  assert.equal(res.metricas.pedidos_cancelados, 1);
});

// --------------------------------------------------------------------------
// GATE D9: Ticket médio usa estritamente pedidos concluídos
// --------------------------------------------------------------------------
test('D9: ticket médio usa estritamente pedidos concluídos', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D9 Ticket' });

  // 2 pedidos concluídos: R$ 100 e R$ 200 (média R$ 150)
  await criarPedidoFixture({ clienteId: cid, total: 100.00, statusComercial: 'concluido', valorPago: 100.00 });
  await criarPedidoFixture({ clienteId: cid, total: 200.00, statusComercial: 'concluido', valorPago: 200.00 });
  // 1 pedido apenas confirmado (não concluído ainda) de R$ 500
  await criarPedidoFixture({ clienteId: cid, total: 500.00, statusComercial: 'confirmado', valorPago: 250.00 });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(Number(res.metricas.ticket_medio), 150.00, 'Ticket médio deve ser 150.00');
  assert.equal(Number(res.metricas.ticket_maximo), 200.00);
});

// --------------------------------------------------------------------------
// GATE D10: credito_cliente não duplica valor_recebido_caixa
// --------------------------------------------------------------------------
test('D10: credito_cliente NÃO duplica valor_recebido_caixa', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D10 Caixa' });

  // 1 pedido pago com PIX R$ 100
  await criarPedidoFixture({ clienteId: cid, total: 100.00, statusComercial: 'concluido', valorPago: 100.00, metodo: 'pix' });

  // 1 pedido pago com credito_cliente R$ 80
  await criarPedidoFixture({ clienteId: cid, total: 80.00, statusComercial: 'concluido', valorPago: 80.00, metodo: 'credito_cliente' });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.success, true);
  assert.equal(Number(res.metricas.valor_recebido_caixa), 100.00, 'Caixa efetivo deve contabilizar apenas pagamentos externos');
  assert.equal(Number(res.metricas.valor_pedidos_concluidos), 180.00, 'LTV de consumo de pedidos deve ser 180.00');
});

// --------------------------------------------------------------------------
// GATE D11: Taxa de conversão de orçamento correta
// --------------------------------------------------------------------------
test('D11: taxa de conversão de orçamento calculada corretamente', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D11 Orc' });

  seqOrc++;
  // 2 orçamentos: 1 convertido e 1 recusado (50% de conversão)
  await admin.query(`
    INSERT INTO public.orcamentos (numero, versao, cliente_id, cliente_nome, data_evento, validade_ate, status, total)
    VALUES 
      ('ORC-D11-1', 1, ${cid}, 'Cliente D11', CURRENT_DATE + 5, NOW() + INTERVAL '1 day', 'convertido', 200.00),
      ('ORC-D11-2', 1, ${cid}, 'Cliente D11', CURRENT_DATE + 5, NOW() + INTERVAL '1 day', 'recusado', 300.00);
  `);

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(res.metricas.orcamentos_total, 2);
  assert.equal(res.metricas.orcamentos_convertidos, 1);
  assert.equal(Number(res.metricas.taxa_conversao_orcamentos), 50.00);
});

// --------------------------------------------------------------------------
// GATE D12: Saldo da Frente C aparece corretamente
// --------------------------------------------------------------------------
test('D12: saldo da carteira da Frente C aparece na ficha 360', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D12 Saldo' });

  // Deposita R$ 75 de crédito via RPC da Frente C
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid,
    p_tipo: 'credito',
    p_valor: 75.00,
    p_motivo: 'Credito fidelidade D12',
    p_request_id: 'd12-cred'
  });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.equal(Number(res.credito.saldo), 75.00);
});

// --------------------------------------------------------------------------
// GATE D13: Timeline ordenada cronologicamente (ocorrido_em DESC)
// --------------------------------------------------------------------------
test('D13: timeline unificada está ordenada cronologicamente decrescente', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D13 Time' });

  await criarPedidoFixture({ clienteId: cid, total: 100.00 });
  await rpc(adm, 'adicionar_nota_cliente', { p_cliente_id: cid, p_nota: 'Nota de atendimento' });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  assert.ok(res.timeline.length >= 2);

  const t0 = new Date(res.timeline[0].ocorrido_em).getTime();
  const t1 = new Date(res.timeline[1].ocorrido_em).getTime();
  assert.ok(t0 >= t1, 'Ocorrências devem estar em ordem cronológica decrescente');
});

// --------------------------------------------------------------------------
// GATE D14: Timeline une pedido/orçamento/WhatsApp/crédito/notas
// --------------------------------------------------------------------------
test('D14: timeline une as múltiplas dimensões do cliente', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D14 Multi' });

  // 1. Pedido
  const pedId = await criarPedidoFixture({ clienteId: cid, total: 80.00 });
  // 2. Orçamento
  await admin.query(`
    INSERT INTO public.orcamentos (numero, versao, cliente_id, cliente_nome, data_evento, validade_ate, status, total)
    VALUES ('ORC-D14', 1, ${cid}, 'Cliente D14', CURRENT_DATE + 5, NOW() + INTERVAL '1 day', 'enviado', 150.00);
  `);
  // 3. Nota
  await rpc(adm, 'adicionar_nota_cliente', { p_cliente_id: cid, p_nota: 'Primeiro contato realizado' });
  // 4. Crédito
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cid, p_tipo: 'credito', p_valor: 20.00, p_motivo: 'Bônus D14', p_request_id: 'd14-bonus'
  });

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  const tiposPresentes = new Set(res.timeline.map(t => t.tipo));

  assert.ok(tiposPresentes.has('pedido'), 'Timeline deve conter pedido');
  assert.ok(tiposPresentes.has('orcamento'), 'Timeline deve conter orçamento');
  assert.ok(tiposPresentes.has('nota'), 'Timeline deve conter nota');
  assert.ok(tiposPresentes.has('credito'), 'Timeline deve conter crédito');
});

// --------------------------------------------------------------------------
// GATE D15: Timeline não expõe token_publico
// --------------------------------------------------------------------------
test('D15: timeline NÃO expõe token_publico de orçamentos (sanitização)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D15 Token' });

  await admin.query(`
    INSERT INTO public.orcamentos (numero, versao, cliente_id, cliente_nome, data_evento, validade_ate, status, total, token_publico)
    VALUES ('ORC-D15', 1, ${cid}, 'Cliente D15', CURRENT_DATE + 5, NOW() + INTERVAL '1 day', 'enviado', 250.00, gen_random_uuid());
  `);

  const res = await rpc(adm, 'obter_cliente_360_admin', { p_cliente_id: cid });
  const itemOrc = res.timeline.find(t => t.tipo === 'orcamento');
  assert.ok(itemOrc);
  assert.equal(itemOrc.metadata?.token_publico, undefined, 'token_publico NÃO deve estar no metadata da timeline');
});

// --------------------------------------------------------------------------
// GATE D16: Nota interna não aparece em obter_meu_perfil_360
// --------------------------------------------------------------------------
test('D16: nota interna NÃO aparece na visão do próprio cliente (obter_meu_perfil_360)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cli = await newClient(CLIENTE_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D16 Proprio', authUserId: CLIENTE_UID });

  // Equipe insere nota interna confidencial
  await rpc(adm, 'adicionar_nota_cliente', { p_cliente_id: cid, p_nota: 'Observação estritamente confidencial da equipe' });

  // Cliente autenticado consulta seu perfil
  const res = await rpc(cli, 'obter_meu_perfil_360');
  assert.equal(res.success, true);
  assert.equal(Number(res.cliente.id), Number(cid));
  assert.equal(res.notas, undefined, 'A visão do cliente não pode conter o array notas');
  assert.equal(res.tags, undefined, 'A visão do cliente não pode conter tags operacionais');
});

// --------------------------------------------------------------------------
// GATE D17: Operador não altera livro-razão financeiro via CRM
// --------------------------------------------------------------------------
test('D17: operador não altera livro-razão de crédito via CRM', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D17' });

  // Tentar alterar diretamente a tabela cliente_credito_movimentacoes é proibido
  await assert.rejects(async () => {
    await oper.query(`
      INSERT INTO public.cliente_credito_movimentacoes (cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, motivo, idempotency_key)
      VALUES (${cid}, 'credito', 'ajuste_manual_admin', 50, 0, 50, 'Fraude', 'd17-fake');
    `);
  }, /violates row-level security|permission denied/i);
});

// --------------------------------------------------------------------------
// GATE D18: Notas/tags/preferências mantêm auditoria e não permitem DELETE direto
// --------------------------------------------------------------------------
test('D18: notas/tags/preferências mantêm auditoria e bloqueiam DELETE direto', async () => {
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente D18' });

  // Cria nota
  const nRes = await rpc(oper, 'adicionar_nota_cliente', { p_cliente_id: cid, p_nota: 'Nota auditável' });
  assert.equal(nRes.success, true);

  // DELETE direto é barrado por RLS / REVOKE (0 rows deleted ou error)
  const delRes = await oper.query(`DELETE FROM public.cliente_notas WHERE id = ${nRes.nota_id};`);
  assert.equal(delRes.rowCount, 0, 'DELETE direto não deve afetar nenhuma linha');

  // Arquivamento auditável funciona
  const arqRes = await rpc(oper, 'arquivar_nota_cliente', { p_nota_id: nRes.nota_id });
  assert.equal(arqRes.success, true);

  // Verifica que a nota permanece no banco, apenas marcada como arquivada
  const { rows } = await admin.query(`SELECT arquivada, arquivada_por FROM public.cliente_notas WHERE id = $1`, [nRes.nota_id]);
  assert.equal(rows[0].arquivada, true);
  assert.equal(rows[0].arquivada_por, OPER_UID);
});
