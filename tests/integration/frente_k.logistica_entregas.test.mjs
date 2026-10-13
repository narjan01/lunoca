// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE K (LOGÍSTICA, ROTAS E ENTREGAS)
// ==============================================================================
// Valida os 16 testes individuais K1 a K16 da Migration 026 contra PostgreSQL real:
// K1:  Pedido retirada não pode entrar em rota de entrega nem ser despachado como entrega
// K2:  Pedido não pronto não pode ser despachado (ORDER_NOT_READY_FOR_DISPATCH)
// K3:  Despacho válido move status_operacional para saiu_para_entrega
// K4:  Retry de despacho é idempotente e não duplica eventos
// K5:  Confirmação de entrega move status_operacional para entregue
// K6:  Retry de confirmação de entrega é idempotente
// K7:  Falha de entrega registra motivo em entrega_eventos sem tocar financeiro
// K8:  Reagendamento mantém histórico append-only e permite nova tentativa
// K9:  Cliente vê apenas seus eventos sanitizados de entrega (sem dados internos)
// K10: Comprovante de entrega é imutável (UPDATE/DELETE bloqueados por trigger)
// K11: Eventos de entrega são imutáveis (UPDATE/DELETE bloqueados por trigger)
// K12: Confirmação de entrega não cria lançamento financeiro
// K13: WhatsApp de saída para entrega usa preview e auditoria da Frente B
// K14: Cliente A não consulta entrega/comprovante do Cliente B
// K15: Pedido de retirada não acessa tracking de rota de entrega
// K16: Concorrência de despacho/confirmação usa lock transacional sem duplicar eventos
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
const PORT = 54395;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_A_UID = 'aaaa1111-1111-4111-8111-111111111111';
const CLI_B_UID = 'bbbb2222-2222-4222-8222-222222222222';

let cliAId;
let cliBId;
let prodId;
let rotaPadraoId;

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

async function closeClient(c) {
  try { await c.end(); } catch (_) {}
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

async function criarPedidoTeste({
  clienteId,
  nomeCliente,
  telefoneCliente,
  modalidade = 'entrega',
  statusOperacional = 'pronto',
  endereco = 'Av. Beira Mar, 1000 - Meireles'
}) {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      $1, 'cliente-k@lunoca.test', $2, $3, CURRENT_DATE, '15:00:00',
      $4, $5, 180.00, 180.00,
      'confirmado', 'pago', $6, 'Confirmado',
      'pix', '[{"nome":"Bolo Red Velvet","quantidade":1,"preco":180}]'::jsonb
    ) RETURNING id`,
    [nomeCliente, telefoneCliente, clienteId, modalidade, endereco, statusOperacional]
  );
  const pid = Number(rows[0].id);

  await admin.query(
    `INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade,
      preco_base_snapshot, preco_unitario_snapshot, subtotal,
      cmv_unitario_snapshot, cmv_total_snapshot
    ) VALUES ($1, $2, 'Bolo Red Velvet', 1, 180.00, 180.00, 180.00, 55.00, 55.00)`,
    [pid, prodId]
  );

  return pid;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-026',
    port: PORT,
    dbName: 'lunoca_test_026'
  });
  connInfo = setup.connInfo;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const install = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8');
  await admin.query(install);

  await setIdentity(admin, 'service_role');

  for (const [uid, email, nome, nivel] of [
    [ADMIN_UID, 'admin-k@lunoca.test', 'Admin Frente K',    'admin'],
    [OPER_UID,  'oper-k@lunoca.test',  'Operador Frente K', 'operador'],
    [CLI_A_UID, 'clia-k@lunoca.test',  'Cliente A Entrega', 'cliente'],
    [CLI_B_UID, 'clib-k@lunoca.test',  'Cliente B Entrega', 'cliente']
  ]) {
    await admin.query(
      `INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [uid, email]
    );
    await admin.query(
      `INSERT INTO public.profiles (id, nome, email, nivel, ativo)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true`,
      [uid, nome, email, nivel]
    );
  }

  const resCliA = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Helena Entrega A', '(85) 99701-1001', '5585997011001', 'clia-k@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome, telefone_normalizado = EXCLUDED.telefone_normalizado
     RETURNING id`,
    [CLI_A_UID]
  );
  cliAId = Number(resCliA.rows[0].id);

  const resCliB = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Roberto Entrega B', '(85) 99702-2002', '5585997022002', 'clib-k@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome, telefone_normalizado = EXCLUDED.telefone_normalizado
     RETURNING id`,
    [CLI_B_UID]
  );
  cliBId = Number(resCliB.rows[0].id);

  const resProd = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Bolo Red Velvet', 180.00, 50, true, false)
     RETURNING id`
  );
  prodId = Number(resProd.rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const rotaRes = await rpc(admin, 'criar_rota_entrega_admin', {
    p_data_rota: new Date().toISOString().slice(0, 10),
    p_turno: 'tarde',
    p_responsavel_nome: 'Carlos Motoboy',
    p_responsavel_telefone: '85988887777',
    p_veiculo_identificacao: 'Moto Placa XYZ-9999',
    p_observacoes_internas: 'Cuidado com bolos de andar na rota tarde'
  });
  assert.equal(rotaRes.success, true);
  rotaPadraoId = Number(rotaRes.rota_id);
});

after(async () => {
  for (const c of activeClients) {
    await closeClient(c);
  }
  await closeClient(admin);
  if (teardownFn) await teardownFn();
});

// ==============================================================================
// K1: Pedido retirada não pode entrar em rota de entrega nem ser despachado como entrega
// ==============================================================================
test('K1: pedido com modalidade retirada é bloqueado em atribuir_entrega_rota e despachar_pedido_entrega', async () => {
  const pedRetiradaId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'retirada',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);

  const atrib = await rpc(admin, 'atribuir_entrega_rota', {
    p_rota_id: rotaPadraoId,
    p_pedido_id: pedRetiradaId
  });
  assert.equal(atrib.success, false);
  assert.equal(atrib.code, 'PICKUP_ORDER_NOT_ROUTABLE');

  const desp = await rpc(admin, 'despachar_pedido_entrega', {
    p_pedido_id: pedRetiradaId,
    p_observacao: 'Tentativa indevida de despachar retirada'
  });
  assert.equal(desp.success, false);
  assert.equal(desp.code, 'INVALID_DELIVERY_MODALITY');
});

// ==============================================================================
// K2: Pedido não pronto não pode ser despachado
// ==============================================================================
test('K2: pedido que ainda está em produção (não pronto) não pode ser despachado', async () => {
  const pedEmProdId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'em_producao'
  });

  await setIdentity(admin, OPER_UID);
  const desp = await rpc(admin, 'despachar_pedido_entrega', {
    p_pedido_id: pedEmProdId
  });
  assert.equal(desp.success, false);
  assert.equal(desp.code, 'ORDER_NOT_READY_FOR_DISPATCH');
});

// ==============================================================================
// K3: Despacho válido move status_operacional para saiu_para_entrega
// ==============================================================================
test('K3: despacho válido de pedido pronto move pedidos.status_operacional para saiu_para_entrega e registra entrega em_rota', async () => {
  const pedProntoId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  const atrib = await rpc(admin, 'atribuir_entrega_rota', {
    p_rota_id: rotaPadraoId,
    p_pedido_id: pedProntoId,
    p_ordem_sequencia: 1
  });
  assert.equal(atrib.success, true);

  const desp = await rpc(admin, 'despachar_pedido_entrega', {
    p_pedido_id: pedProntoId,
    p_observacao: 'Saiu com embalagem térmica'
  });
  assert.equal(desp.success, true);
  assert.equal(desp.status_operacional, 'saiu_para_entrega');
  assert.equal(desp.status_logistico, 'em_rota');

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT status_operacional FROM public.pedidos WHERE id = $1`,
    [pedProntoId]
  );
  assert.equal(rows[0].status_operacional, 'saiu_para_entrega');
});

// ==============================================================================
// K4: Retry de despacho é idempotente e não duplica eventos
// ==============================================================================
test('K4: retry de despacho em pedido já em rota é idempotente e não duplica eventos DESPACHADO', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  const d1 = await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });
  assert.equal(d1.success, true);
  assert.equal(d1.idempotente, false);

  const d2 = await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });
  assert.equal(d2.success, true);
  assert.equal(d2.idempotente, true);

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_eventos WHERE pedido_id = $1 AND tipo_evento = 'DESPACHADO'`,
    [pedId]
  );
  assert.equal(rows[0].qtd, 1);
});

// ==============================================================================
// K5: Confirmação de entrega move status_operacional para entregue
// ==============================================================================
test('K5: confirmar_entrega_pedido move status_operacional para entregue e registra comprovante', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });

  const conf = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Helena (Própria Cliente)',
    p_tipo_comprovante: 'assinatura_recebedor',
    p_referencia_arquivo: 'https://cdn.lunocadoceria.com.br/comprovantes/ped-' + pedId + '.jpg',
    p_observacao: 'Entregue na portaria principal'
  });
  assert.equal(conf.success, true);
  assert.equal(conf.status_operacional, 'entregue');
  assert.equal(conf.status_logistico, 'entregue');
  assert.ok(conf.comprovante_id);

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT status_operacional FROM public.pedidos WHERE id = $1`,
    [pedId]
  );
  assert.equal(rows[0].status_operacional, 'entregue');
});

// ==============================================================================
// K6: Retry de confirmação de entrega é idempotente
// ==============================================================================
test('K6: retry de confirmar_entrega_pedido é idempotente e não duplica eventos ENTREGUE nem comprovantes', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });

  const c1 = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Porteiro João'
  });
  assert.equal(c1.success, true);
  assert.equal(c1.idempotente, false);

  const c2 = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Porteiro João'
  });
  assert.equal(c2.success, true);
  assert.equal(c2.idempotente, true);

  await setIdentity(admin, 'service_role');
  const evs = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_eventos WHERE pedido_id = $1 AND tipo_evento = 'ENTREGUE'`,
    [pedId]
  );
  assert.equal(evs.rows[0].qtd, 1);

  const comps = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_comprovantes WHERE pedido_id = $1`,
    [pedId]
  );
  assert.equal(comps.rows[0].qtd, 1);
});

// ==============================================================================
// K7: Falha de entrega registra motivo sem tocar financeiro
// ==============================================================================
test('K7: registrar_falha_entrega grava motivo estruturado em entrega_eventos e status_logistico falha_temporaria sem tocar financeiro', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, 'service_role');
  const finBefore = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.financeiro_lancamentos`);

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });

  const falha = await rpc(admin, 'registrar_falha_entrega', {
    p_pedido_id: pedId,
    p_motivo_falha: 'DESTINATARIO_AUSENTE',
    p_descricao: 'Interfone tocou 3 vezes sem resposta'
  });
  assert.equal(falha.success, true);
  assert.equal(falha.status_logistico, 'falha_temporaria');
  assert.equal(falha.motivo_falha, 'DESTINATARIO_AUSENTE');

  await setIdentity(admin, 'service_role');
  const finAfter = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.financeiro_lancamentos`);
  assert.equal(finAfter.rows[0].qtd, finBefore.rows[0].qtd);
});

// ==============================================================================
// K8: Reagendamento mantém histórico append-only e permite nova tentativa
// ==============================================================================
test('K8: reagendar_entrega preserva histórico append-only e permite nova tentativa de despacho e entrega final', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });
  await rpc(admin, 'registrar_falha_entrega', {
    p_pedido_id: pedId,
    p_motivo_falha: 'ENDERECO_NAO_LOCALIZADO',
    p_descricao: 'Numeração da rua confusa'
  });

  const reag = await rpc(admin, 'reagendar_entrega', {
    p_pedido_id: pedId,
    p_nova_data: new Date().toISOString().slice(0, 10),
    p_nova_hora: '18:00:00',
    p_observacao: 'Cliente enviou localização exata do condomínio'
  });
  assert.equal(reag.success, true);
  assert.equal(reag.status_logistico, 'reagendada');

  const redesp = await rpc(admin, 'despachar_pedido_entrega', {
    p_pedido_id: pedId,
    p_observacao: 'Segunda tentativa após confirmação de endereço'
  });
  assert.equal(redesp.success, true);
  assert.equal(redesp.status_logistico, 'em_rota');
  assert.equal(Number(redesp.tentativas_count), 2);

  const conf = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Helena Entrega A'
  });
  assert.equal(conf.success, true);
  assert.equal(conf.status_operacional, 'entregue');

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT tipo_evento FROM public.entrega_eventos WHERE pedido_id = $1 ORDER BY id ASC`,
    [pedId]
  );
  const tipos = rows.map((r) => r.tipo_evento);
  assert.ok(tipos.includes('DESPACHADO'));
  assert.ok(tipos.includes('FALHA_ENTREGA'));
  assert.ok(tipos.includes('REAGENDADO'));
  assert.ok(tipos.includes('NOVA_TENTATIVA_DESPACHO'));
  assert.ok(tipos.includes('ENTREGUE'));
});

// ==============================================================================
// K9: Cliente vê apenas seus eventos sanitizados de entrega
// ==============================================================================
test('K9: obter_acompanhamento_entrega_cliente retorna apenas dados sanitizados sem expor entregador, telefone, placa ou notas internas', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'atribuir_entrega_rota', {
    p_rota_id: rotaPadraoId,
    p_pedido_id: pedId
  });
  await rpc(admin, 'despachar_pedido_entrega', {
    p_pedido_id: pedId,
    p_observacao: 'NOTA INTERNA CONFIDENCIAL: portão azul ao lado da guarita'
  });
  await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Helena Recebedora',
    p_documento_recebedor: '123.456.789-00',
    p_referencia_arquivo: 'https://internal-bucket/secret-proof.jpg'
  });

  const cliA = await newClient(CLI_A_UID);
  const track = await rpc(cliA, 'obter_acompanhamento_entrega_cliente', {
    p_pedido_id: pedId
  });
  assert.equal(track.success, true);
  assert.equal(track.rastreamento.pedido_id, pedId);
  assert.equal(track.rastreamento.status_logistico, 'entregue');
  assert.equal(track.rastreamento.comprovante.recebido_por, 'Helena Recebedora');

  const rawJson = JSON.stringify(track);
  assert.ok(!rawJson.includes('85988887777'), 'Não pode vazar telefone do entregador');
  assert.ok(!rawJson.includes('XYZ-9999'), 'Não pode vazar placa do veículo');
  assert.ok(!rawJson.includes('NOTA INTERNA CONFIDENCIAL'), 'Não pode vazar observação logística interna');
  assert.ok(!rawJson.includes('123.456.789-00'), 'Não pode vazar documento interno no tracking');
  assert.ok(!rawJson.includes('secret-proof.jpg'), 'Não pode vazar URL interna do arquivo');
});

// ==============================================================================
// K10: Comprovante de entrega é imutável (UPDATE/DELETE bloqueados)
// ==============================================================================
test('K10: entrega_comprovantes é estritamente append-only e bloqueia UPDATE e DELETE físicos', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });
  const conf = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Recebedor Original'
  });
  assert.equal(conf.success, true);

  await setIdentity(admin, 'service_role');
  await assert.rejects(
    () => admin.query(`UPDATE public.entrega_comprovantes SET recebido_por = 'Adulterado' WHERE pedido_id = $1`, [pedId]),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`DELETE FROM public.entrega_comprovantes WHERE pedido_id = $1`, [pedId]),
    (err) => err.code === '42501'
  );
});

// ==============================================================================
// K11: Eventos de entrega são imutáveis (UPDATE/DELETE bloqueados)
// ==============================================================================
test('K11: entrega_eventos é estritamente append-only e bloqueia UPDATE e DELETE físicos', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(`SELECT id FROM public.entrega_eventos LIMIT 1`);
  assert.ok(rows.length > 0);
  const evtId = rows[0].id;

  await assert.rejects(
    () => admin.query(`UPDATE public.entrega_eventos SET descricao = 'Adulterado' WHERE id = $1`, [evtId]),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`DELETE FROM public.entrega_eventos WHERE id = $1`, [evtId]),
    (err) => err.code === '42501'
  );
});

// ==============================================================================
// K12: Confirmação de entrega não cria lançamento financeiro
// ==============================================================================
test('K12: confirmar_entrega_pedido tem efeito financeiro ZERO em financeiro_lancamentos e pedido_pagamentos', async () => {
  await setIdentity(admin, 'service_role');
  const beforeFin = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.financeiro_lancamentos`);
  const beforePag = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.pedido_pagamentos`);

  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });
  const conf = await rpc(admin, 'confirmar_entrega_pedido', {
    p_pedido_id: pedId,
    p_recebido_por: 'Helena Sem Efeito Financeiro'
  });
  assert.equal(conf.success, true);

  await setIdentity(admin, 'service_role');
  const afterFin = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.financeiro_lancamentos`);
  const afterPag = await admin.query(`SELECT COUNT(*)::INT AS qtd FROM public.pedido_pagamentos`);

  assert.equal(afterFin.rows[0].qtd, beforeFin.rows[0].qtd);
  assert.equal(afterPag.rows[0].qtd, beforePag.rows[0].qtd);
});

// ==============================================================================
// K13: WhatsApp de saída para entrega usa preview e auditoria da Frente B
// ==============================================================================
test('K13: aviso WhatsApp SAIU_PARA_ENTREGA reutiliza obter_preview_comunicacao e registrar_comunicacao_cliente da Frente B', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedId });

  const prev = await rpc(admin, 'obter_preview_comunicacao', {
    p_tipo: 'SAIU_PARA_ENTREGA',
    p_orcamento_id: null,
    p_pedido_id: pedId
  });
  assert.equal(prev.success, true);
  assert.equal(prev.tipo, 'SAIU_PARA_ENTREGA');
  assert.ok(prev.mensagem.toLowerCase().includes('entrega'));

  const reg = await rpc(admin, 'registrar_comunicacao_cliente', {
    p_tipo: 'SAIU_PARA_ENTREGA',
    p_orcamento_id: null,
    p_pedido_id: pedId,
    p_canal: 'whatsapp_link',
    p_status: 'link_aberto'
  });
  assert.equal(reg.success, true);
});

// ==============================================================================
// K14: Cliente A não consulta entrega/comprovante do Cliente B
// ==============================================================================
test('K14: isolamento estrito — Cliente A não consegue consultar acompanhamento de entrega de pedido do Cliente B', async () => {
  const pedBId = await criarPedidoTeste({
    clienteId: cliBId,
    nomeCliente: 'Roberto Entrega B',
    telefoneCliente: '5585997022002',
    modalidade: 'entrega',
    statusOperacional: 'pronto',
    endereco: 'Rua Secreta do Cliente B, 999'
  });

  await setIdentity(admin, OPER_UID);
  await rpc(admin, 'despachar_pedido_entrega', { p_pedido_id: pedBId });

  const cliA = await newClient(CLI_A_UID);
  const trackInvasao = await rpc(cliA, 'obter_acompanhamento_entrega_cliente', {
    p_pedido_id: pedBId
  });
  assert.equal(trackInvasao.success, false);
  assert.equal(trackInvasao.code, 'ORDER_NOT_FOUND');
});

// ==============================================================================
// K15: Pedido de retirada não acessa tracking de rota de entrega
// ==============================================================================
test('K15: pedido de retirada do próprio cliente retorna DELIVERY_TRACKING_NOT_APPLICABLE em obter_acompanhamento_entrega_cliente', async () => {
  const pedRetId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'retirada',
    statusOperacional: 'pronto'
  });

  const cliA = await newClient(CLI_A_UID);
  const trackRet = await rpc(cliA, 'obter_acompanhamento_entrega_cliente', {
    p_pedido_id: pedRetId
  });
  assert.equal(trackRet.success, false);
  assert.equal(trackRet.code, 'DELIVERY_TRACKING_NOT_APPLICABLE');
});

// ==============================================================================
// K16: Concorrência de despacho/confirmação usa lock transacional
// ==============================================================================
test('K16: chamadas concorrentes de despacho e confirmação serializam via FOR UPDATE sem duplicar eventos nem comprovantes', async () => {
  const pedId = await criarPedidoTeste({
    clienteId: cliAId,
    nomeCliente: 'Helena Entrega A',
    telefoneCliente: '5585997011001',
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  const op1 = await newClient(OPER_UID);
  const op2 = await newClient(ADMIN_UID);

  const [d1, d2] = await Promise.all([
    rpc(op1, 'despachar_pedido_entrega', { p_pedido_id: pedId }),
    rpc(op2, 'despachar_pedido_entrega', { p_pedido_id: pedId })
  ]);
  assert.equal(d1.success, true);
  assert.equal(d2.success, true);
  assert.equal([d1.idempotente, d2.idempotente].filter(Boolean).length, 1);

  const [c1, c2] = await Promise.all([
    rpc(op1, 'confirmar_entrega_pedido', { p_pedido_id: pedId, p_recebido_por: 'Recebedor Concorrente' }),
    rpc(op2, 'confirmar_entrega_pedido', { p_pedido_id: pedId, p_recebido_por: 'Recebedor Concorrente' })
  ]);
  assert.equal(c1.success, true);
  assert.equal(c2.success, true);
  assert.equal([c1.idempotente, c2.idempotente].filter(Boolean).length, 1);

  await setIdentity(admin, 'service_role');
  const evDesp = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_eventos WHERE pedido_id = $1 AND tipo_evento = 'DESPACHADO'`,
    [pedId]
  );
  assert.equal(evDesp.rows[0].qtd, 1);

  const evEnt = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_eventos WHERE pedido_id = $1 AND tipo_evento = 'ENTREGUE'`,
    [pedId]
  );
  assert.equal(evEnt.rows[0].qtd, 1);

  const comps = await admin.query(
    `SELECT COUNT(*)::INT AS qtd FROM public.entrega_comprovantes WHERE pedido_id = $1`,
    [pedId]
  );
  assert.equal(comps.rows[0].qtd, 1);
});
