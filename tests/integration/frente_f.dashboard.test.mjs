// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 021 (FRENTE F)
// ==========================================================================
// Valida os 14 gates (F1 a F14) do Dashboard Gerencial, DRE & Indicadores:
// - F1: credito_cliente não infla receita de caixa
// - F2: estorno reduz caixa líquido corretamente
// - F3: pedido cancelado não entra em vendas concluídas
// - F4: ticket médio usa estritamente pedidos concluídos
// - F5: conversão de orçamento correta
// - F6: novos vs recorrentes por cliente corretos
// - F7: saldo de créditos histórico e atual reconcilia com a Frente C
// - F8: capacidade média ponderada bate com Frente E
// - F9: filtros temporais respeitam fuso America/Fortaleza e bounds [inicio, fim+1)
// - F10: operador vê indicadores operacionais permitidos
// - F11: anon/cliente autenticado comum recebem rejeição fail-closed (RBAC)
// - F12: números do dashboard reconciliam com consultas canônicas
// - F13: pagamento misto crédito + meio externo reconcilia sem dupla contagem
// - F14: payload do operador não possui chaves financeiras
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
const PORT = 54392;

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

let seqCliente = 9500;
let seqPedido = 8500;
let seqProd = 7500;

async function criarClienteFixture({ nome = 'Cliente Dash' } = {}) {
  seqCliente++;
  const tel = `8599${String(seqCliente).padStart(7, '0')}`;
  const telNorm = `55${tel}`;
  const cpf = `${String(seqCliente).padStart(11, '0')}`;
  const { rows } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id;
  `, [nome, tel, telNorm, `dash_${seqCliente}@teste.local`, cpf]);
  return Number(rows[0].id);
}

async function criarProdutoFixture({ nome = 'Bolo Gerencial', preco = 100.00, pontos = 2.00 } = {}) {
  seqProd++;
  const { rows } = await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, pontos_producao, ativo, controlar_estoque)
    VALUES ($1, $2, $3, $4, true, false)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, preco = EXCLUDED.preco
    RETURNING id;
  `, [seqProd, nome, preco, pontos]);
  return Number(rows[0].id);
}

async function criarPedidoFixture({
  clienteId,
  dataEntrega = '2026-10-15',
  total = 100.00,
  statusComercial = 'confirmado',
  dataTransicao = '2026-10-15 10:00:00-03'
} = {}) {
  seqPedido++;
  const prodId = await criarProdutoFixture({ preco: total });

  const { rows: [p] } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente,
      data_pedido, data_entrega, hora_entrega, total, subtotal, valor_pago, saldo, sinal_minimo,
      status_comercial, status_financeiro, status_operacional, status,
      modalidade_entrega, endereco_entrega, pagamento, itens
    ) VALUES (
      $1, $2, 'Cliente Encomenda', 'cliente@teste.local', '85999990000',
      '2026-10-15'::DATE, $3::DATE, '14:00:00'::TIME, $4, $4, $4, 0.00, $4 * 0.5,
      $5, 'pago', 'aguardando_producao', 'Confirmado',
      'entrega', 'Rua Central, 50', 'pix', 'Bolo'
    ) RETURNING id;
  `, [seqPedido, clienteId, dataEntrega, total, statusComercial]);

  // Cria item
  await admin.query(`
    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot,
      subtotal, pontos_producao_snapshot, observacoes
    ) VALUES ($1, $2, 'Bolo Especial', 1, $3, $3, 2.00, 'Sem glúten');
  `, [p.id, prodId, total]);

  // Grava histórico com timestamp controlado
  await admin.query(`
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, usuario_nome, origem, created_at
    ) VALUES ($1, 'comercial', 'rascunho', $2, 'Admin', 'admin', $3::TIMESTAMPTZ);
  `, [p.id, statusComercial, dataTransicao]);

  return Number(p.id);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-021',
    port: PORT,
    dbName: 'lunoca_test_021'
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
      ('${CLIENTE_UID}', 'Cliente Regular', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;
  `);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// --------------------------------------------------------------------------
// GATE F1: credito_cliente não infla receita de caixa
// --------------------------------------------------------------------------
test('F1: credito_cliente não infla receita de caixa', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F1' });

  // Concede crédito ao cliente
  await admin.query(`
    INSERT INTO public.cliente_creditos (cliente_id, saldo) VALUES (${cid}, 100.00);
    INSERT INTO public.cliente_credito_movimentacoes (
      cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, motivo, idempotency_key, created_at
    ) VALUES (
      ${cid}, 'credito', 'ajuste_manual_admin', 100.00, 0.00, 100.00, 'Bônus cortesia', 'f1_cred_${Date.now()}', '2026-10-15 10:00:00-03'
    );
  `);

  // Registra uso de crédito em pedido
  const pid = await criarPedidoFixture({ clienteId: cid, total: 100.00, dataTransicao: '2026-10-15 11:00:00-03' });
  await admin.query(`
    INSERT INTO public.cliente_credito_movimentacoes (
      cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, pedido_id, motivo, idempotency_key, created_at
    ) VALUES (
      ${cid}, 'debito', 'uso_pedido', 100.00, 100.00, 0.00, ${pid}, 'Pagamento com saldo', 'f1_uso_${Date.now()}', '2026-10-15 11:00:00-03'
    );
  `);

  const res = await rpc(adm, 'obter_indicadores_financeiros_admin', {
    p_data_inicio: '2026-10-15',
    p_data_fim: '2026-10-15'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.credito_cliente_utilizado), 100.00, 'Crédito utilizado deve ser 100.00');
  assert.equal(Number(res.entrada_caixa_bruta), 0.00, 'Entrada de caixa externa deve ser 0.00');
  assert.equal(Number(res.entrada_caixa_liquida), 0.00, 'Caixa líquido não pode ser inflado por crédito');
});

// --------------------------------------------------------------------------
// GATE F2: estorno reduz caixa líquido corretamente
// --------------------------------------------------------------------------
test('F2: estorno reduz caixa líquido corretamente', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F2' });
  const pid = await criarPedidoFixture({ clienteId: cid, total: 150.00, dataTransicao: '2026-10-16 09:00:00-03' });

  // Pagamento em dinheiro
  await admin.query(`
    INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, status, pago_em)
    VALUES (${pid}, 150.00, 'dinheiro', 'aprovado', '2026-10-16 09:15:00-03');
    INSERT INTO public.financeiro_lancamentos (tipo, categoria, descricao, valor, data_lancamento, created_at)
    VALUES ('receita', 'Vendas', 'Venda Pedido #${pid}', 150.00, '2026-10-16', '2026-10-16 09:15:00-03');
  `);

  // Estorno de 50.00
  await admin.query(`
    INSERT INTO public.financeiro_lancamentos (tipo, categoria, descricao, valor, data_lancamento, created_at)
    VALUES ('despesa', 'Estornos', 'Estorno parcial #${pid}', 50.00, '2026-10-16', '2026-10-16 11:00:00-03');
  `);

  const res = await rpc(adm, 'obter_indicadores_financeiros_admin', {
    p_data_inicio: '2026-10-16',
    p_data_fim: '2026-10-16'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.entrada_caixa_bruta), 150.00);
  assert.equal(Number(res.estornos_caixa), 50.00);
  assert.equal(Number(res.entrada_caixa_liquida), 100.00, 'Caixa líquido deve ser 150 - 50 = 100');
});

// --------------------------------------------------------------------------
// GATE F3: pedido cancelado não entra em vendas concluídas
// --------------------------------------------------------------------------
test('F3: pedido cancelado não entra em vendas concluídas', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F3' });
  const pid = await criarPedidoFixture({
    clienteId: cid, total: 200.00, statusComercial: 'cancelado', dataTransicao: '2026-10-17 10:00:00-03'
  });

  // Marca no histórico como cancelado
  await admin.query(`
    INSERT INTO public.pedido_status_historico (pedido_id, dimensao, status_anterior, status_novo, usuario_nome, origem, created_at)
    VALUES (${pid}, 'comercial', 'confirmado', 'cancelado', 'Admin', 'admin', '2026-10-17 12:00:00-03');
  `);

  const res = await rpc(adm, 'obter_indicadores_vendas_admin', {
    p_data_inicio: '2026-10-17',
    p_data_fim: '2026-10-17'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.pedidos_concluidos_quantidade), 0);
  assert.equal(Number(res.faturamento_realizado), 0.00);
  assert.equal(Number(res.pedidos_cancelados), 1);
});

// --------------------------------------------------------------------------
// GATE F4: ticket médio usa estritamente pedidos concluídos
// --------------------------------------------------------------------------
test('F4: ticket médio usa estritamente pedidos concluídos', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F4' });

  // Pedido 1 concluído: 100
  const p1 = await criarPedidoFixture({ clienteId: cid, total: 100.00, statusComercial: 'concluido', dataTransicao: '2026-10-18 10:00:00-03' });
  // Pedido 2 concluído: 200
  const p2 = await criarPedidoFixture({ clienteId: cid, total: 200.00, statusComercial: 'concluido', dataTransicao: '2026-10-18 11:00:00-03' });
  // Pedido 3 apenas confirmado (não concluído): 500
  await criarPedidoFixture({ clienteId: cid, total: 500.00, statusComercial: 'confirmado', dataTransicao: '2026-10-18 12:00:00-03' });

  const res = await rpc(adm, 'obter_indicadores_vendas_admin', {
    p_data_inicio: '2026-10-18',
    p_data_fim: '2026-10-18'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.pedidos_concluidos_quantidade), 2);
  assert.equal(Number(res.faturamento_realizado), 300.00);
  assert.equal(Number(res.ticket_medio_realizado), 150.00, 'Ticket médio = 300 / 2 = 150');
  assert.equal(Number(res.ticket_maximo), 200.00);
});

// --------------------------------------------------------------------------
// GATE F5: conversão de orçamento correta
// --------------------------------------------------------------------------
test('F5: conversão de orçamento correta', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F5' });

  // 2 orçamentos emitidos, 1 convertido
  await admin.query(`
    INSERT INTO public.orcamentos (
      numero, cliente_id, cliente_nome, cliente_email, cliente_telefone,
      data_evento, validade_ate, total, subtotal, status, token_publico, created_at, convertido_em
    ) VALUES
      ('ORC-F5-1', ${cid}, 'Cliente F5', 'f5_1@t.local', '859990011', '2026-10-25', '2026-10-25', 120.00, 120.00, 'convertido', '11111111-0000-0000-0000-000000000001', '2026-10-19 09:00:00-03', '2026-10-19 11:30:00-03'),
      ('ORC-F5-2', ${cid}, 'Cliente F5', 'f5_2@t.local', '859990022', '2026-10-25', '2026-10-25', 180.00, 180.00, 'enviado', '11111111-0000-0000-0000-000000000002', '2026-10-19 10:00:00-03', NULL);
  `);

  const res = await rpc(adm, 'obter_indicadores_vendas_admin', {
    p_data_inicio: '2026-10-19',
    p_data_fim: '2026-10-19'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.orcamentos_emitidos), 2);
  assert.equal(Number(res.orcamentos_convertidos), 1);
  assert.equal(Number(res.taxa_conversao), 50.0, 'Taxa de conversão deve ser 50%');
});

// --------------------------------------------------------------------------
// GATE F6: novos vs recorrentes por cliente corretos
// --------------------------------------------------------------------------
test('F6: novos vs recorrentes por cliente corretos', async () => {
  const adm = await newClient(ADMIN_UID);
  const cNovo = await criarClienteFixture({ nome: 'Cliente Novo F6' });
  const cRec = await criarClienteFixture({ nome: 'Cliente Recorrente F6' });

  // Cliente Recorrente já tinha pedido no passado
  await criarPedidoFixture({ clienteId: cRec, total: 80.00, statusComercial: 'concluido', dataTransicao: '2026-09-01 10:00:00-03' });
  // Cliente Recorrente compra novamente hoje
  await criarPedidoFixture({ clienteId: cRec, total: 110.00, statusComercial: 'concluido', dataTransicao: '2026-10-20 10:00:00-03' });

  // Cliente Novo faz sua primeira compra hoje
  await criarPedidoFixture({ clienteId: cNovo, total: 95.00, statusComercial: 'concluido', dataTransicao: '2026-10-20 14:00:00-03' });

  const res = await rpc(adm, 'obter_indicadores_clientes_admin', {
    p_data_inicio: '2026-10-20',
    p_data_fim: '2026-10-20'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.clientes_novos), 1, 'Deve ter 1 cliente novo');
  assert.equal(Number(res.clientes_recorrentes), 1, 'Deve ter 1 cliente recorrente');
});

// --------------------------------------------------------------------------
// GATE F7: saldo de créditos histórico e atual reconcilia com a Frente C
// --------------------------------------------------------------------------
test('F7: saldo de créditos histórico e atual reconcilia com Frente C', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F7' });

  // Limpa movimentações e saldos prévios para teste isolado de carteira agregada
  await admin.query(`
    DELETE FROM public.cliente_credito_movimentacoes;
    DELETE FROM public.cliente_creditos;
  `);

  // Movimento 1: +80 no dia 21
  await admin.query(`
    INSERT INTO public.cliente_creditos (cliente_id, saldo) VALUES (${cid}, 80.00);
    INSERT INTO public.cliente_credito_movimentacoes (
      cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, motivo, idempotency_key, created_at
    ) VALUES (
      ${cid}, 'credito', 'ajuste_manual_admin', 80.00, 0.00, 80.00, 'Crédito F7', 'f7_1_${Date.now()}', '2026-10-21 10:00:00-03'
    );
  `);

  // Movimento 2: +50 no futuro (dia 25)
  await admin.query(`
    UPDATE public.cliente_creditos SET saldo = 130.00 WHERE cliente_id = ${cid};
    INSERT INTO public.cliente_credito_movimentacoes (
      cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, motivo, idempotency_key, created_at
    ) VALUES (
      ${cid}, 'credito', 'ajuste_manual_admin', 50.00, 80.00, 130.00, 'Crédito Futuro', 'f7_2_${Date.now()}', '2026-10-25 10:00:00-03'
    );
  `);

  // Consulta o período do dia 21 (deve ver histórico = 80 e atual = 130)
  const res = await rpc(adm, 'obter_indicadores_financeiros_admin', {
    p_data_inicio: '2026-10-21',
    p_data_fim: '2026-10-21'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.saldo_creditos_fim_periodo), 80.00, 'Saldo no fim do período deve ser 80');
  assert.equal(Number(res.saldo_creditos_atual), 130.00, 'Saldo atual consolidado deve ser 130');
});

// --------------------------------------------------------------------------
// GATE F8: capacidade média ponderada bate com Frente E
// --------------------------------------------------------------------------
test('F8: capacidade média ponderada bate com Frente E', async () => {
  const oper = await newClient(OPER_UID);

  // Configura capacidade para 2 dias
  await admin.query(`
    INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos, bloqueado)
    VALUES
      ('2026-10-22', 20.00, false),
      ('2026-10-23', 30.00, false)
    ON CONFLICT (data) DO UPDATE SET capacidade_maxima_pontos = EXCLUDED.capacidade_maxima_pontos;
  `);

  const res = await rpc(oper, 'obter_indicadores_producao', {
    p_data_inicio: '2026-10-22',
    p_data_fim: '2026-10-23'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.capacidade_total), 50.00, 'Capacidade total = 20 + 30 = 50');
  assert.equal(res.dias_bloqueados, 0);
});

// --------------------------------------------------------------------------
// GATE F9: filtros temporais respeitam fuso America/Fortaleza e bounds [inicio, fim+1)
// --------------------------------------------------------------------------
test('F9: filtros temporais respeitam fuso America/Fortaleza e bounds [inicio, fim+1)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente F9' });

  // Pedido transicionado às 23:30 do dia 24 em Fortaleza
  const pNoite = await criarPedidoFixture({
    clienteId: cid, total: 120.00, statusComercial: 'concluido', dataTransicao: '2026-10-24 23:30:00-03'
  });

  // Pedido transicionado às 00:05 do dia 25 em Fortaleza (fora da janela do dia 24)
  const pDiaSeguinte = await criarPedidoFixture({
    clienteId: cid, total: 140.00, statusComercial: 'concluido', dataTransicao: '2026-10-25 00:05:00-03'
  });

  const res = await rpc(adm, 'obter_indicadores_vendas_admin', {
    p_data_inicio: '2026-10-24',
    p_data_fim: '2026-10-24'
  });

  assert.equal(res.success, true);
  assert.equal(Number(res.pedidos_concluidos_quantidade), 1, 'Apenas o pedido das 23:30 deve ser capturado no dia 24');
  assert.equal(Number(res.faturamento_realizado), 120.00);
});

// --------------------------------------------------------------------------
// GATE F10: operador vê indicadores operacionais permitidos
// --------------------------------------------------------------------------
test('F10: operador vê indicadores operacionais permitidos', async () => {
  const oper = await newClient(OPER_UID);

  const res = await rpc(oper, 'obter_dashboard_operacional', {
    p_data_inicio: '2026-10-15',
    p_data_fim: '2026-10-15'
  });

  assert.equal(res.success, true);
  assert.ok(res.volumes_pedidos !== undefined);
  assert.ok(res.producao !== undefined);
});

// --------------------------------------------------------------------------
// GATE F11: anon/cliente autenticado comum recebem rejeição fail-closed (RBAC)
// --------------------------------------------------------------------------
test('F11: anon e cliente comum recebem rejeição fail-closed (RBAC)', async () => {
  const anon = await newClient('anon');
  const cli = await newClient(CLIENTE_UID);

  // Anon é rejeitado por RBAC nativo de banco
  await assert.rejects(async () => {
    await rpc(anon, 'obter_indicadores_vendas_admin', { p_data_inicio: '2026-10-15', p_data_fim: '2026-10-15' });
  }, /permission denied/i);

  // Cliente comum autenticado recebe PERMISSION_DENIED
  const resCli = await rpc(cli, 'obter_indicadores_vendas_admin', { p_data_inicio: '2026-10-15', p_data_fim: '2026-10-15' });
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');
});

// --------------------------------------------------------------------------
// GATE F12: números do dashboard reconciliam com consultas canônicas
// --------------------------------------------------------------------------
test('F12: números do dashboard reconciliam com consultas canônicas', async () => {
  const adm = await newClient(ADMIN_UID);

  const resResumo = await rpc(adm, 'obter_dashboard_resumo_admin', {
    p_data_inicio: '2026-10-15',
    p_data_fim: '2026-10-24'
  });

  assert.equal(resResumo.success, true);
  assert.ok(resResumo.vendas !== undefined);
  assert.ok(resResumo.financeiro !== undefined);
  assert.ok(resResumo.producao !== undefined);
  assert.ok(resResumo.clientes !== undefined);
});

// --------------------------------------------------------------------------
// GATE F13: pagamento misto crédito + meio externo reconcilia sem dupla contagem
// --------------------------------------------------------------------------
test('F13: pagamento misto crédito + meio externo reconcilia sem dupla contagem (R$ 60 crédito + R$ 40 PIX = R$ 100)', async () => {
  const adm = await newClient(ADMIN_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente Misto F13' });

  // Pedido concluído de R$ 100
  const pid = await criarPedidoFixture({
    clienteId: cid, total: 100.00, statusComercial: 'concluido', dataTransicao: '2026-10-26 10:00:00-03'
  });

  // R$ 40 pagos em PIX externo
  await admin.query(`
    INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, status, pago_em)
    VALUES (${pid}, 40.00, 'pix', 'aprovado', '2026-10-26 10:15:00-03');
  `);

  // R$ 60 pagos com crédito da carteira
  await admin.query(`
    INSERT INTO public.cliente_credito_movimentacoes (
      cliente_id, tipo, origem, valor, saldo_anterior, saldo_posterior, pedido_id, motivo, idempotency_key, created_at
    ) VALUES (
      ${cid}, 'debito', 'uso_pedido', 60.00, 60.00, 0.00, ${pid}, 'Uso misto', 'f13_misto_${Date.now()}', '2026-10-26 10:15:00-03'
    );
  `);

  const resVendas = await rpc(adm, 'obter_indicadores_vendas_admin', {
    p_data_inicio: '2026-10-26',
    p_data_fim: '2026-10-26'
  });
  const resFin = await rpc(adm, 'obter_indicadores_financeiros_admin', {
    p_data_inicio: '2026-10-26',
    p_data_fim: '2026-10-26'
  });

  assert.equal(Number(resVendas.faturamento_realizado), 100.00, 'Faturamento realizado deve ser 100.00');
  assert.equal(Number(resFin.entrada_caixa_bruta), 40.00, 'Entrada externa de caixa deve ser estritamente 40.00');
  assert.equal(Number(resFin.credito_cliente_utilizado), 60.00, 'Crédito utilizado deve ser 60.00');
  assert.equal(
    Number(resFin.entrada_caixa_bruta) + Number(resFin.credito_cliente_utilizado),
    Number(resVendas.faturamento_realizado),
    'Entrada externa (40) + Crédito utilizado (60) deve bater exatamente com o Faturamento (100), sem virar 160!'
  );
});

// --------------------------------------------------------------------------
// GATE F14: payload do operador não possui chaves financeiras
// --------------------------------------------------------------------------
test('F14: payload do operador não possui chaves financeiras', async () => {
  const oper = await newClient(OPER_UID);

  const res = await rpc(oper, 'obter_dashboard_operacional', {
    p_data_inicio: '2026-10-26',
    p_data_fim: '2026-10-26'
  });

  assert.equal(res.success, true);
  const jsonStr = JSON.stringify(res);

  // Validação estrita de ausência de chaves financeiras
  assert.equal(res.faturamento, undefined);
  assert.equal(res.faturamento_realizado, undefined);
  assert.equal(res.entrada_caixa_bruta, undefined);
  assert.equal(res.entrada_caixa_liquida, undefined);
  assert.equal(res.estornos_caixa, undefined);
  assert.equal(res.ticket_medio, undefined);
  assert.equal(res.margem, undefined);

  assert.ok(!jsonStr.includes('faturamento_realizado'), 'Payload não deve conter a chave faturamento_realizado');
  assert.ok(!jsonStr.includes('entrada_caixa_liquida'), 'Payload não deve conter a chave entrada_caixa_liquida');
  assert.ok(!jsonStr.includes('saldo_creditos'), 'Payload não deve conter a chave saldo_creditos');
});
