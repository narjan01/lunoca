// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE P (EXPEDIÇÃO & RETIRADA SEGURA)
// ==============================================================================
// Valida os 16 gates obrigatórios P1 a P16 da Migration 031:
// P1:  Pedido de entrega não gera PIN de retirada
// P2:  PIN é armazenado somente como hash
// P3:  PIN expirado é rejeitado
// P4:  PIN consumido não pode ser reutilizado
// P5:  Tentativas inválidas são limitadas (throttling e bloqueio)
// P6:  Regeneração revoga PIN anterior
// P7:  Cliente só obtém autorização dos próprios pedidos
// P8:  Operador não consegue confirmar pedido que não está pronto
// P9:  Quality hold da Frente L impede retirada
// P10: Saldo obrigatório impede retirada sem pagamento
// P11: Pagamento de balcão reutiliza motor financeiro canônico
// P12: Retry não duplica pagamento
// P13: Confirmação é idempotente e consome autorização uma única vez
// P14: Retirada atualiza somente status operacional canônico
// P15: Anon/cliente não acessam RPCs administrativas de balcão (fail-closed)
// P16: Nenhuma operação cria lançamento financeiro duplicado
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
const PORT = 54450;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_A_UID = 'aaaa1111-1111-4111-8111-111111111111';
const CLI_B_UID = 'bbbb2222-2222-4222-8222-222222222222';

let cliAId;
let cliBId;

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
  const idx = activeClients.indexOf(c);
  if (idx !== -1) activeClients.splice(idx, 1);
  try {
    await c.end();
  } catch (_) {}
}

async function rpc(c, fnName, args = {}) {
  const keys = Object.keys(args);
  const callParams = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const sql = keys.length === 0
    ? `SELECT public.${fnName}() AS res`
    : `SELECT public.${fnName}(${callParams}) AS res`;
  const vals = keys.map((k) => args[k]);
  const { rows } = await c.query(sql, vals);
  return rows[0]?.res;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-031',
    port: PORT,
    dbName: 'lunoca_test_031'
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

  // Setup usuários de teste
  await admin.query(`
    INSERT INTO auth.users (id, email)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test'),
      ('${OPER_UID}',  'oper@lunoca.test'),
      ('${CLI_A_UID}', 'clia@lunoca.test'),
      ('${CLI_B_UID}', 'clib@lunoca.test')
    ON CONFLICT (id) DO NOTHING;
  `);

  await admin.query(`
    INSERT INTO public.profiles (id, email, nivel, nome, ativo)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test', 'admin',    'Admin Lunoca', true),
      ('${OPER_UID}',  'oper@lunoca.test',  'operador', 'Operador Lunoca', true),
      ('${CLI_A_UID}', 'clia@lunoca.test',  'cliente',  'Cliente A Lunoca', true),
      ('${CLI_B_UID}', 'clib@lunoca.test',  'cliente',  'Cliente B Lunoca', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  const resCliA = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente A', '(85) 99801-3001', '5585998013001', 'clia@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_A_UID]
  );
  cliAId = Number(resCliA.rows[0].id);

  const resCliB = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente B', '(85) 99801-3002', '5585998013002', 'clib@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_B_UID]
  );
  cliBId = Number(resCliB.rows[0].id);
});

after(async () => {
  for (const c of [...activeClients]) {
    await closeClient(c);
  }
  if (admin) {
    try {
      await admin.end();
    } catch (_) {}
  }
  if (teardownFn) {
    await teardownFn();
  }
});

// Helper para criar pedido de teste
async function criarPedidoTeste({ clienteId, tipoEntrega = 'retirada', statusOperacional = 'pronto', valorTotal = 150.00, valorPago = 0 }) {
  await setIdentity(admin, 'service_role');
  const res = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal, saldo, valor_pago,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Teste', 'cli@lunoca.test', '5585998013001', $1, CURRENT_DATE, '15:00:00',
      $2, 'Balcão da Loja', $3::numeric, $3::numeric, GREATEST(0, $3::numeric - $4::numeric), $4::numeric,
      'confirmado', CASE WHEN $4::numeric <= 0 THEN 'nao_pago' WHEN $4::numeric >= $3::numeric THEN 'pago' ELSE 'parcialmente_pago' END,
      $5, 'Confirmado',
      'pix', '[]'::jsonb
    ) RETURNING id;
  `, [clienteId, tipoEntrega, valorTotal, valorPago, statusOperacional]);

  const pedidoId = Number(res.rows[0].id);

  if (valorPago > 0) {
    await admin.query(`
      INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, status)
      VALUES ($1, $2, 'pix', 'aprovado');
    `, [pedidoId, valorPago]);
  }

  return pedidoId;
}

// ==============================================================================
// P1: Pedido de entrega não gera PIN de retirada
// ==============================================================================
test('P1: pedido de entrega não gera PIN de retirada', async () => {
  const pedidoEntregaId = await criarPedidoTeste({ clienteId: cliAId, tipoEntrega: 'entrega' });

  const clientA = await newClient(CLI_A_UID);
  const res = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoEntregaId });

  assert.equal(res.success, false);
  assert.equal(res.code, 'DELIVERY_ORDER_NO_PICKUP_PIN');

  await closeClient(clientA);
});

// ==============================================================================
// P2: PIN é armazenado somente como hash
// ==============================================================================
test('P2: PIN é armazenado somente como hash', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, tipoEntrega: 'retirada' });

  const clientA = await newClient(CLI_A_UID);
  const res = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });

  assert.equal(res.success, true);
  assert.ok(res.codigo_pin, 'PIN em texto claro deve ser retornado ao solicitante autorizado');
  assert.equal(res.codigo_pin.length, 6, 'PIN deve ter 6 dígitos');

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    'SELECT codigo_hash FROM public.pedido_retirada_autorizacoes WHERE id = $1',
    [res.autorizacao_id]
  );

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].codigo_hash, res.codigo_pin, 'Banco NÃO pode conter o PIN em texto claro');
  assert.equal(rows[0].codigo_hash.length, 64, 'Hash deve ser SHA-256 de 64 caracteres hexadecimais');

  await closeClient(clientA);
});

// ==============================================================================
// P3: PIN expirado é rejeitado
// ==============================================================================
test('P3: PIN expirado é rejeitado', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId });

  const clientA = await newClient(CLI_A_UID);
  const resGen = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  // Forçar expiração temporal
  await setIdentity(admin, 'service_role');
  await admin.query(
    `UPDATE public.pedido_retirada_autorizacoes SET expira_em = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [resGen.autorizacao_id]
  );

  const operClient = await newClient(OPER_UID);
  const resVal = await rpc(operClient, 'validar_pin_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });

  assert.equal(resVal.success, false);
  assert.equal(resVal.code, 'PIN_EXPIRED');

  await closeClient(clientA);
  await closeClient(operClient);
});

// ==============================================================================
// P4: PIN consumido não pode ser reutilizado
// ==============================================================================
test('P4: PIN consumido não pode ser reutilizado', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 100, valorPago: 100 });

  const clientA = await newClient(CLI_A_UID);
  const resGen = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);
  // Finalizar retirada com sucesso
  const resCheckout = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });
  assert.equal(resCheckout.success, true);
  assert.equal(resCheckout.status_operacional, 'retirado');

  // Tentar revalidar o PIN já consumido
  const resRetry = await rpc(operClient, 'validar_pin_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });
  assert.equal(resRetry.success, false);
  assert.equal(resRetry.code, 'PIN_ALREADY_CONSUMED');

  await closeClient(clientA);
  await closeClient(operClient);
});

// ==============================================================================
// P5: Tentativas inválidas são limitadas (throttling e bloqueio)
// ==============================================================================
test('P5: tentativas inválidas são limitadas (throttling e bloqueio)', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId });

  const clientA = await newClient(CLI_A_UID);
  const resGen = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);

  // Tentativa 1 incorreta
  const t1 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: '000000' });
  assert.equal(t1.success, false);
  assert.equal(t1.code, 'INVALID_PIN');
  assert.equal(t1.tentativas_restantes, 2);

  // Tentativa 2 incorreta
  const t2 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: '111111' });
  assert.equal(t2.success, false);
  assert.equal(t2.code, 'INVALID_PIN');
  assert.equal(t2.tentativas_restantes, 1);

  // Tentativa 3 incorreta: excede limite e bloqueia
  const t3 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: '222222' });
  assert.equal(t3.success, false);
  assert.equal(t3.code, 'MAX_ATTEMPTS_EXCEEDED');

  // Tentativa 4 mesmo com o PIN correto deve ser rejeitada por autorização bloqueada
  const t4 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: resGen.codigo_pin });
  assert.equal(t4.success, false);
  assert.equal(t4.code, 'MAX_ATTEMPTS_EXCEEDED');

  await closeClient(clientA);
  await closeClient(operClient);
});

// ==============================================================================
// P6: Regeneração revoga PIN anterior
// ==============================================================================
test('P6: regeneração revoga PIN anterior', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId });

  const clientA = await newClient(CLI_A_UID);
  // 1ª Geração
  const res1 = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(res1.success, true);

  // 2ª Geração (Regeneração)
  const res2 = await rpc(clientA, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(res2.success, true);
  assert.notEqual(res1.autorizacao_id, res2.autorizacao_id);

  // Verificar status no banco
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    'SELECT id, status FROM public.pedido_retirada_autorizacoes WHERE id IN ($1, $2) ORDER BY id ASC',
    [res1.autorizacao_id, res2.autorizacao_id]
  );

  assert.equal(rows[0].status, 'REVOGADA', '1º PIN deve ser revogado');
  assert.equal(rows[1].status, 'ATIVA', '2º PIN deve estar ativo');

  // Tentar validar o 1º PIN
  const operClient = await newClient(OPER_UID);
  const val1 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: res1.codigo_pin });
  assert.equal(val1.success, false, '1º PIN revogado não pode ser validado');

  // O 2º PIN deve validar com sucesso
  const val2 = await rpc(operClient, 'validar_pin_retirada_balcao', { p_pedido_id: pedidoId, p_pin: res2.codigo_pin });
  assert.equal(val2.success, true, '2º PIN deve validar com sucesso');

  await closeClient(clientA);
  await closeClient(operClient);
});

// ==============================================================================
// P7: Cliente só obtém autorização dos próprios pedidos
// ==============================================================================
test('P7: cliente só obtém autorização dos próprios pedidos', async () => {
  const pedidoA = await criarPedidoTeste({ clienteId: cliAId });

  const clientB = await newClient(CLI_B_UID);
  // Cliente B tenta obter autorização do Pedido do Cliente A
  const resObter = await rpc(clientB, 'obter_minha_autorizacao_retirada', { p_pedido_id: pedidoA });
  assert.equal(resObter.success, false);
  assert.equal(resObter.code, 'PERMISSION_DENIED');

  // Cliente B tenta gerar PIN para o Pedido do Cliente A
  const resGen = await rpc(clientB, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoA });
  assert.equal(resGen.success, false);
  assert.equal(resGen.code, 'PERMISSION_DENIED');

  await closeClient(clientB);
});

// ==============================================================================
// P8: Operador não consegue confirmar pedido que não está pronto
// ==============================================================================
test('P8: operador não consegue confirmar pedido que não está pronto', async () => {
  // Pedido ainda em produção
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, statusOperacional: 'em_producao', valorTotal: 100, valorPago: 100 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);
  const resCheckout = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });

  assert.equal(resCheckout.success, false);
  assert.equal(resCheckout.code, 'ORDER_NOT_READY');

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P9: Quality hold da Frente L impede retirada
// ==============================================================================
test('P9: quality hold da Frente L impede retirada', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 100, valorPago: 100 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  // Inserir checkpoint de qualidade REPROVADO (Frente L)
  await setIdentity(admin, 'service_role');
  await admin.query(`
    INSERT INTO public.producao_controles_qualidade (
      pedido_id, etapa, resultado, bloqueia_avanco, observacao, responsavel_id, responsavel_nome
    ) VALUES ($1, 'EXPEDICAO', 'REPROVADO', true, 'Defeito estrutural', '${ADMIN_UID}', 'Admin Tester');
  `, [pedidoId]);

  const operClient = await newClient(OPER_UID);
  const resCheckout = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });

  assert.equal(resCheckout.success, false);
  assert.equal(resCheckout.code, 'QUALITY_HOLD_ACTIVE');

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P10: Saldo obrigatório impede retirada sem pagamento
// ==============================================================================
test('P10: saldo obrigatório impede retirada sem pagamento', async () => {
  // Pedido com R$ 120,00 total e apenas R$ 40,00 pagos (Saldo de R$ 80,00)
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 120.00, valorPago: 40.00 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);
  // Tentar checkout sem quitar saldo (p_quitar_saldo = false)
  const resCheckout = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin,
    p_quitar_saldo: false
  });

  assert.equal(resCheckout.success, false);
  assert.equal(resCheckout.code, 'PAYMENT_REQUIRED');
  assert.equal(Number(resCheckout.saldo_devedor), 80.00);

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P11: Pagamento de balcão reutiliza motor financeiro canônico
// ==============================================================================
test('P11: pagamento de balcão reutiliza motor financeiro canônico', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 180.00, valorPago: 80.00 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);
  // Quitar saldo restante de R$ 100,00 no balcão
  const resCheckout = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin,
    p_quitar_saldo: true,
    p_forma_pagamento: 'cartao_presencial',
    p_observacao_pagamento: 'Balcão débito'
  });

  assert.equal(resCheckout.success, true);
  assert.equal(resCheckout.status_operacional, 'retirado');
  assert.equal(Number(resCheckout.saldo_final), 0.00);

  // Validar que o pagamento foi gravado na tabela canônica pedido_pagamentos
  await setIdentity(admin, 'service_role');
  const { rows: pagamentos } = await admin.query(
    'SELECT valor, metodo, status FROM public.pedido_pagamentos WHERE pedido_id = $1 ORDER BY id DESC LIMIT 1',
    [pedidoId]
  );
  assert.equal(pagamentos.length, 1);
  assert.equal(Number(pagamentos[0].valor), 100.00);
  assert.equal(pagamentos[0].status, 'aprovado');

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P12: Retry não duplica pagamento
// ==============================================================================
test('P12: retry não duplica pagamento', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 150.00, valorPago: 50.00 });
  const idempotencyKey = 'balcao_idemp_' + Date.now();

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);

  // 1ª Chamada
  const call1 = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin,
    p_quitar_saldo: true,
    p_forma_pagamento: 'pix_balcao',
    p_chave_idempotencia: idempotencyKey
  });
  assert.equal(call1.success, true);

  // 2ª Chamada (Retry de rede com a mesma chave)
  const call2 = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin,
    p_quitar_saldo: true,
    p_forma_pagamento: 'pix_balcao',
    p_chave_idempotencia: idempotencyKey
  });
  assert.equal(call2.success, true);
  assert.equal(call2.ja_retirado, true);

  // Verificar que não duplicou pagamentos
  await setIdentity(admin, 'service_role');
  const { rows: pags } = await admin.query(
    'SELECT count(*) AS total FROM public.pedido_pagamentos WHERE pedido_id = $1',
    [pedidoId]
  );
  assert.equal(Number(pags[0].total), 2, 'Deve ter exatamente 2 pagamentos: o inicial de R$ 50 e o de quitação de R$ 100');

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P13: Confirmação é idempotente e consome autorização uma única vez
// ==============================================================================
test('P13: confirmação é idempotente e consome autorização uma única vez', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 100, valorPago: 100 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });
  assert.equal(resGen.success, true);

  const operClient = await newClient(OPER_UID);
  const res1 = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });
  assert.equal(res1.success, true);

  // Retry
  const res2 = await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });
  assert.equal(res2.success, true);
  assert.equal(res2.ja_retirado, true);

  // Autorização no banco deve estar com status CONSUMIDA
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    'SELECT status, consumido_em FROM public.pedido_retirada_autorizacoes WHERE id = $1',
    [resGen.autorizacao_id]
  );
  assert.equal(rows[0].status, 'CONSUMIDA');
  assert.ok(rows[0].consumido_em);

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P14: Retirada atualiza somente status operacional canônico
// ==============================================================================
test('P14: retirada atualiza somente status operacional canônico', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 100, valorPago: 100 });

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });

  const operClient = await newClient(OPER_UID);
  await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    'SELECT status_operacional, status_comercial FROM public.pedidos WHERE id = $1',
    [pedidoId]
  );
  assert.equal(rows[0].status_operacional, 'retirado');
  assert.equal(rows[0].status_comercial, 'concluido');

  await closeClient(adminClient);
  await closeClient(operClient);
});

// ==============================================================================
// P15: Anon/cliente não acessam RPCs administrativas de balcão (fail-closed)
// ==============================================================================
test('P15: anon/cliente não acessam RPCs administrativas de balcão (fail-closed)', async () => {
  const anonClient = await newClient('anon');

  // Anon não pode validar PIN
  await assert.rejects(
    rpc(anonClient, 'validar_pin_retirada_balcao', { p_pedido_id: 1, p_pin: '123456' }),
    /permission denied/i
  );

  // Anon não pode finalizar checkout
  await assert.rejects(
    rpc(anonClient, 'finalizar_checkout_retirada_balcao', { p_pedido_id: 1, p_pin: '123456' }),
    /permission denied/i
  );

  // Anon não pode acessar painel do balcão
  await assert.rejects(
    rpc(anonClient, 'obter_painel_balcao_retiradas', {}),
    /permission denied/i
  );

  // Cliente comum autenticado não pode finalizar checkout
  const clientA = await newClient(CLI_A_UID);
  const resCliCheckout = await rpc(clientA, 'finalizar_checkout_retirada_balcao', { p_pedido_id: 1, p_pin: '123456' });
  assert.equal(resCliCheckout.success, false);
  assert.equal(resCliCheckout.code, 'PERMISSION_DENIED');

  await closeClient(anonClient);
  await closeClient(clientA);
});

// ==============================================================================
// P16: Nenhuma operação cria lançamento financeiro duplicado
// ==============================================================================
test('P16: nenhuma operação cria lançamento financeiro duplicado', async () => {
  const pedidoId = await criarPedidoTeste({ clienteId: cliAId, valorTotal: 100, valorPago: 100 });

  await setIdentity(admin, 'service_role');
  const { rows: lancAntes } = await admin.query('SELECT count(*) AS total FROM public.financeiro_lancamentos');

  const adminClient = await newClient(ADMIN_UID);
  const resGen = await rpc(adminClient, 'gerar_autorizacao_retirada_cliente', { p_pedido_id: pedidoId });

  const operClient = await newClient(OPER_UID);
  // Checkout de pedido já quitado
  await rpc(operClient, 'finalizar_checkout_retirada_balcao', {
    p_pedido_id: pedidoId,
    p_pin: resGen.codigo_pin
  });

  await setIdentity(admin, 'service_role');
  const { rows: lancDepois } = await admin.query('SELECT count(*) AS total FROM public.financeiro_lancamentos');

  assert.equal(Number(lancAntes[0].total), Number(lancDepois[0].total), 'Retirada de pedido quitado NÃO gera novo lançamento contábil');

  await closeClient(adminClient);
  await closeClient(operClient);
});
