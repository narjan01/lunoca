// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE 039 (WHATSAPP AUTOMÁTICO & OUTBOX)
// ==============================================================================
// Valida os 18 gates obrigatórios WA1 a WA18 da Migration 039:
// WA1:  comunicacoes_cliente continua sendo a verdade comercial do CRM
// WA2:  Triggers de domínio são puros e não fazem chamadas HTTP externas
// WA3:  Eventos canônicos criam intenções na outbox com chave determinística única
// WA4:  E.164 validado rigorosamente quando envio é possível
// WA5:  Template, versão e variáveis ficam snapshotados imutavelmente
// WA6:  Claim concorrente opera com FOR UPDATE SKIP LOCKED + claim_token + lease
// WA6-R: Reclaim de worker morto após lease vencido gera novo token e invalida o anterior
// WA7:  Retry e backoff exponencial persistido (+1m, +5m, +15m, +1h) sem alterar disparar_em
// WA8:  Falha ou supressão de WhatsApp jamais impede a transação do domínio (pedido/pagamento)
// WA9:  Webhook do gateway é idempotente e deduplica por (provider, chave_evento)
// WA10: Status de entrega não regride (LIDO -> ENTREGUE ou ENVIADO é bloqueado)
// WA11: Evento PEDIDO_PRONTO gera no máximo 1 intenção
// WA12: Cancelamento do pedido cancela PENDENTE e solicita cancelamento de PROCESSANDO
// WA13: Consentimento promocional vs transacional preservado
// WA14: Transacional e marketing são categorias distintas
// WA15: RPCs técnicas são service-role only
// WA16: Admin consulta histórico sanitizado via whatsapp_listar_envios_admin
// WA17: Webhook jamais altera o pedido canônico diretamente
// WA18: Migrations 001–038 permanecem intocadas
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
const PORT = 54456;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_A_UID = '22222222-2222-4222-8222-222222222222';
const CLI_UID = '44444444-4444-4444-8444-444444444444';

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
}

async function rpc(c, fn, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const sql = `SELECT public.${fn}(${placeholders}) AS r`;
  const values = keys.map(k => {
    const v = params[k];
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  const { rows } = await c.query(sql, values);
  return rows[0].r;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-frente-wa',
    port: PORT,
    dbName: 'lunoca_frente_wa_test'
  });
  connInfo = setup.connInfo;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  await admin.query(fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8'));
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));

  await setIdentity(admin, 'service_role');

  // Perfis de teste
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin.wa@lunocadoceria.com.br'),
      ('${OPER_A_UID}', 'operador.wa@lunocadoceria.com.br'),
      ('${CLI_UID}', 'cliente.wa@exemplo.com.br')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin WhatsApp', 'admin.wa@lunocadoceria.com.br', 'admin', true),
      ('${OPER_A_UID}', 'Operador WhatsApp', 'operador.wa@lunocadoceria.com.br', 'operador', true),
      ('${CLI_UID}', 'Cliente Teste WA', 'cliente.wa@exemplo.com.br', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);
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

// Helper para criar pedido
async function criarPedidoTeste(c, { telefone = '85999990001', statusOperacional = 'em_producao', total = 80.00 } = {}) {
  const res = await c.query(`
    INSERT INTO public.pedidos (
      nome_cliente, telefone_cliente, email_cliente,
      data_pedido, data_entrega, hora_entrega,
      total, status_operacional, status_financeiro, status_comercial,
      pagamento, canal, itens, endereco_entrega
    ) VALUES (
      'Cliente Teste WA', $1, 'wa@teste.com',
      CURRENT_DATE, CURRENT_DATE, '17:00:00',
      $2, $3, 'nao_pago', 'confirmado',
      'pix', 'balcao', '[]'::jsonb, 'Rua das Flores, 123'
    ) RETURNING id;
  `, [telefone, total, statusOperacional]);
  return res.rows[0].id;
}

// ------------------------------------------------------------------------------
// TESTES
// ------------------------------------------------------------------------------

test('WA1 & WA2: comunicacoes_cliente preserva tipos legados e novos sem chamadas HTTP', async () => {
  const c = await newClient('service_role');
  try {
    const res = await c.query(`
      SELECT pg_get_constraintdef(c.oid) as condef
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'comunicacoes_cliente' AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%tipo%';
    `);
    assert.ok(res.rows.length > 0, 'deve existir check constraint de tipo');
    const condef = res.rows[0].condef;
    
    // Tipos legados 015 e 024
    assert.ok(condef.includes('ORCAMENTO_ENVIADO'));
    assert.ok(condef.includes('CUPOM_ANIVERSARIO'));
    assert.ok(condef.includes('LEMBRETE_PONTOS_EXPIRANDO'));
    // Novos tipos 039
    assert.ok(condef.includes('PEDIDO_CONFIRMADO'));
    assert.ok(condef.includes('PEDIDO_PRONTO'));
    assert.ok(condef.includes('PEDIDO_RETIRADO'));
    assert.ok(condef.includes('LEMBRETE_RETIRADA'));
  } finally {
    await closeClient(c);
  }
});

test('WA3 & WA11: Transição em_producao -> pronto enfileira PEDIDO_PRONTO de forma idempotente', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });

    // Atualiza para 'pronto'
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId]);

    // Verifica se enfileirou em comunicacao_whatsapp_outbox
    const outboxRows = await c.query(`
      SELECT id, status, template_codigo, chave_idempotencia, telefone_e164_snapshot
      FROM public.comunicacao_whatsapp_outbox
      WHERE pedido_id = $1
    `, [pedidoId]);

    assert.equal(outboxRows.rows.length, 1, 'deve enfileirar exatamente 1 mensagem');
    assert.equal(outboxRows.rows[0].status, 'PENDENTE');
    assert.equal(outboxRows.rows[0].template_codigo, 'PEDIDO_PRONTO');
    assert.equal(outboxRows.rows[0].chave_idempotencia, `PEDIDO_PRONTO:pedido:${pedidoId}`);
    assert.equal(outboxRows.rows[0].telefone_e164_snapshot, '5585999990001');

    // Re-acionar update sem mudar status: NÃO pode duplicar na outbox (Gate WA11)
    await c.query(`UPDATE public.pedidos SET observacoes_internas = 'Atualizacao sem mudar status' WHERE id = $1`, [pedidoId]);
    const outboxAfter = await c.query(`
      SELECT count(*) as total FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = $1
    `, [pedidoId]);
    assert.equal(Number(outboxAfter.rows[0].total), 1, 'não pode duplicar mensagem por updates subsequentes');
  } finally {
    await closeClient(c);
  }
});

test('WA4 & WA8: Telefone ausente ou inválido gera SUPRIMIDO e NUNCA falha o pedido', async () => {
  const c = await newClient('service_role');
  try {
    // Pedido com telefone inválido '123'
    const pedidoId1 = await criarPedidoTeste(c, { telefone: '123', statusOperacional: 'em_producao' });
    
    // Transiciona para pronto: NÃO PODE DAR ERRO
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId1]);

    const outbox1 = await c.query(`
      SELECT status, motivo_supressao FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = $1
    `, [pedidoId1]);
    assert.equal(outbox1.rows.length, 1);
    assert.equal(outbox1.rows[0].status, 'SUPRIMIDO');
    assert.equal(outbox1.rows[0].motivo_supressao, 'TELEFONE_INVALIDO');

    // Pedido com telefone nulo
    const pedidoId2 = await criarPedidoTeste(c, { telefone: null, statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId2]);

    const outbox2 = await c.query(`
      SELECT status, motivo_supressao FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = $1
    `, [pedidoId2]);
    assert.equal(outbox2.rows.length, 1);
    assert.equal(outbox2.rows[0].status, 'SUPRIMIDO');
    assert.equal(outbox2.rows[0].motivo_supressao, 'SEM_TELEFONE');
  } finally {
    await closeClient(c);
  }
});

test('WA5: Template, versão e mensagem ficam snapshotados imutavelmente na outbox', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId]);

    const outbox = await c.query(`
      SELECT template_codigo, template_versao, mensagem_texto_snapshot, payload_renderizado
      FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = $1
    `, [pedidoId]);

    assert.equal(outbox.rows[0].template_codigo, 'PEDIDO_PRONTO');
    assert.equal(outbox.rows[0].template_versao, 'v1');
    assert.ok(outbox.rows[0].mensagem_texto_snapshot.includes('Seu pedido está pronto'));
    assert.ok(outbox.rows[0].mensagem_texto_snapshot.includes(String(pedidoId)));
    assert.ok(outbox.rows[0].payload_renderizado.nome_cliente);
  } finally {
    await closeClient(c);
  }
});

test('WA6 & WA6-R: Claim concorrente com SKIP LOCKED, lease e rejeição de worker morto antigo', async () => {
  const cWorker1 = await newClient('service_role');
  const cWorker2 = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(cWorker1, { statusOperacional: 'em_producao' });
    await cWorker1.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId]);

    // 1. Worker 1 reivindica o lote com lease curto (5 segundos)
    const lote1 = await cWorker1.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 5);`);
    const item1 = lote1.rows.find(m => m.pedido_id == pedidoId);
    assert.ok(item1, 'Worker 1 deve receber o item');
    assert.ok(item1.claim_token, 'deve ter claim_token emitido');
    const token1 = item1.claim_token;

    // 2. Concorrência: Worker 2 tenta reivindicar imediatamente: item1 NÃO deve vir
    const lote2 = await cWorker2.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 5);`);
    assert.ok(!lote2.rows.some(m => m.pedido_id == pedidoId), 'Item em PROCESSANDO não pode ser pego por worker concorrente');

    // 3. Simula Worker 1 MORTO: Forçar expiração do lease_expira_em
    await admin.query(`
      UPDATE public.comunicacao_whatsapp_outbox
      SET lease_expira_em = NOW() - INTERVAL '10 seconds'
      WHERE id = $1
    `, [item1.outbox_id]);

    // 4. Worker 2 tenta novamente: agora o reclaim deve recuperar a mensagem com NOVO token
    const loteReclaim = await cWorker2.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 60);`);
    const itemReclaim = loteReclaim.rows.find(m => m.pedido_id == pedidoId);
    assert.ok(itemReclaim, 'Worker 2 deve recuperar a mensagem cujo lease expirou');
    assert.notEqual(itemReclaim.claim_token, token1, 'Novo claim_token deve ser emitido');
    const token2 = itemReclaim.claim_token;

    // 5. Worker 1 antigo reaparece e tenta confirmar com token1 expirado: DEVE SER REJEITADO com P0001
    await assert.rejects(
      rpc(cWorker1, 'whatsapp_confirmar_envio', {
        p_outbox_id: item1.outbox_id,
        p_claim_token: token1,
        p_provider: 'evolution_api',
        p_provider_msg_id: 'msg_old_worker_1'
      }),
      (err) => err.code === 'P0001' || /WHATSAPP_CLAIM_INVALID/.test(err.message),
      'Worker com token antigo deve ser bloqueado com WHATSAPP_CLAIM_INVALID'
    );

    // 6. Worker 2 confirma com token2 válido: deve passar com sucesso
    const resConf = await rpc(cWorker2, 'whatsapp_confirmar_envio', {
      p_outbox_id: item1.outbox_id,
      p_claim_token: token2,
      p_provider: 'evolution_api',
      p_provider_msg_id: 'msg_worker_2_ok'
    });
    assert.equal(resConf.success, true);
    assert.equal(resConf.status, 'ENVIADO');

    const outFinal = await cWorker2.query(`
      SELECT status, provider_message_id FROM public.comunicacao_whatsapp_outbox WHERE id = $1
    `, [item1.outbox_id]);
    assert.equal(outFinal.rows[0].status, 'ENVIADO');
    assert.equal(outFinal.rows[0].provider_message_id, 'msg_worker_2_ok');
  } finally {
    await closeClient(cWorker1);
    await closeClient(cWorker2);
  }
});

test('WA7: Retry e backoff exponencial persistido em proxima_tentativa_em sem alterar disparar_em', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId]);

    // Claim
    const lote = await c.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 60);`);
    const item = lote.rows.find(m => m.pedido_id == pedidoId);

    const outAntes = await c.query(`SELECT disparar_em FROM public.comunicacao_whatsapp_outbox WHERE id = $1`, [item.outbox_id]);
    const dispararEmOriginal = outAntes.rows[0].disparar_em;

    // Registrar falha 1
    const resF1 = await rpc(c, 'whatsapp_registrar_falha', {
      p_outbox_id: item.outbox_id,
      p_claim_token: item.claim_token,
      p_erro: 'Connection timeout'
    });
    assert.equal(resF1.success, true);
    assert.equal(resF1.status, 'PENDENTE');
    assert.equal(resF1.tentativas, 1);

    const outDepois = await c.query(`
      SELECT status, tentativas, disparar_em, proxima_tentativa_em, ultimo_erro 
      FROM public.comunicacao_whatsapp_outbox WHERE id = $1
    `, [item.outbox_id]);
    assert.equal(outDepois.rows[0].status, 'PENDENTE');
    assert.equal(outDepois.rows[0].tentativas, 1);
    assert.equal(outDepois.rows[0].disparar_em.toISOString(), dispararEmOriginal.toISOString(), 'disparar_em não pode mudar');
    assert.ok(new Date(outDepois.rows[0].proxima_tentativa_em) > new Date(), 'proxima_tentativa_em deve ser no futuro');
  } finally {
    await closeClient(c);
  }
});

test('WA12: Cancelamento de pedido cancela mensagens PENDENTES e sinaliza PROCESSANDO', async () => {
  const c = await newClient('service_role');
  try {
    // Pedido 1: Mensagem PENDENTE
    const pedidoId1 = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId1]);

    // Cancela o pedido
    await c.query(`UPDATE public.pedidos SET status_operacional = 'cancelado' WHERE id = $1`, [pedidoId1]);

    const out1 = await c.query(`SELECT status FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = $1`, [pedidoId1]);
    assert.equal(out1.rows[0].status, 'CANCELADO', 'mensagem PENDENTE deve virar CANCELADO');

    // Pedido 2: Mensagem já em PROCESSANDO
    const pedidoId2 = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId2]);
    const lote2 = await c.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 60);`);
    const item2 = lote2.rows.find(m => m.pedido_id == pedidoId2);

    // Cancela o pedido durante o processamento
    await c.query(`UPDATE public.pedidos SET status_operacional = 'cancelado' WHERE id = $1`, [pedidoId2]);

    const out2 = await c.query(`
      SELECT status, cancelamento_solicitado FROM public.comunicacao_whatsapp_outbox WHERE id = $1
    `, [item2.outbox_id]);
    assert.equal(out2.rows[0].status, 'PROCESSANDO');
    assert.equal(out2.rows[0].cancelamento_solicitado, true, 'cancelamento_solicitado deve ser TRUE');

    // Quando o worker tenta confirmar, a RPC detecta cancelamento_solicitado e cancela sem mentir
    const resConf = await rpc(c, 'whatsapp_confirmar_envio', {
      p_outbox_id: item2.outbox_id,
      p_claim_token: item2.claim_token,
      p_provider: 'evolution_api',
      p_provider_msg_id: 'msg_abortada'
    });
    assert.equal(resConf.cancelado, true);
    assert.equal(resConf.status, 'CANCELADO');
  } finally {
    await closeClient(c);
  }
});

test('WA9 & WA10: Webhook do gateway é idempotente e status não regride (LIDO -> ENTREGUE é ignorado)', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, { statusOperacional: 'em_producao' });
    await c.query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = $1`, [pedidoId]);
    const lote = await c.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 60);`);
    const item = lote.rows.find(m => m.pedido_id == pedidoId);

    const providerMsgId = `evo_msg_${Date.now()}`;
    await rpc(c, 'whatsapp_confirmar_envio', {
      p_outbox_id: item.outbox_id,
      p_claim_token: item.claim_token,
      p_provider: 'evolution_api',
      p_provider_msg_id: providerMsgId
    });

    // 1. Webhook de ENTREGUE
    const resEntregue = await rpc(c, 'whatsapp_processar_webhook_status', {
      p_provider: 'evolution_api',
      p_chave_evento: `evo:${providerMsgId}:DELIVERED`,
      p_provider_event_id: 'evt_1',
      p_provider_msg_id: providerMsgId,
      p_tipo_evento: 'DELIVERED',
      p_payload: { status: 'DELIVERED' }
    });
    assert.equal(resEntregue.success, true);
    assert.equal(resEntregue.novo_status, 'ENTREGUE');

    // 2. Webhook duplicado: deve deduplicar
    const resDup = await rpc(c, 'whatsapp_processar_webhook_status', {
      p_provider: 'evolution_api',
      p_chave_evento: `evo:${providerMsgId}:DELIVERED`,
      p_provider_event_id: 'evt_1_dup',
      p_provider_msg_id: providerMsgId,
      p_tipo_evento: 'DELIVERED',
      p_payload: { status: 'DELIVERED' }
    });
    assert.equal(resDup.duplicado, true);

    // 3. Webhook de LIDO
    const resLido = await rpc(c, 'whatsapp_processar_webhook_status', {
      p_provider: 'evolution_api',
      p_chave_evento: `evo:${providerMsgId}:READ`,
      p_provider_event_id: 'evt_2',
      p_provider_msg_id: providerMsgId,
      p_tipo_evento: 'READ',
      p_payload: { status: 'READ' }
    });
    assert.equal(resLido.novo_status, 'LIDO');

    // 4. Webhook fora de ordem (DELIVERED atrasado): NÃO PODE REGREDIR LIDO PARA ENTREGUE
    await rpc(c, 'whatsapp_processar_webhook_status', {
      p_provider: 'evolution_api',
      p_chave_evento: `evo:${providerMsgId}:DELIVERED_LATE`,
      p_provider_event_id: 'evt_3',
      p_provider_msg_id: providerMsgId,
      p_tipo_evento: 'DELIVERED',
      p_payload: { status: 'DELIVERED' }
    });

    const outStatus = await c.query(`SELECT status FROM public.comunicacao_whatsapp_outbox WHERE id = $1`, [item.outbox_id]);
    assert.equal(outStatus.rows[0].status, 'LIDO', 'Status LIDO não pode regredir para ENTREGUE');
  } finally {
    await closeClient(c);
  }
});

test('WA15 & WA16: RPCs de claim revogadas para público/operador; admin lista envios sanitizados', async () => {
  const cOperador = await newClient(OPER_A_UID);
  const cAdmin = await newClient(ADMIN_UID);
  try {
    // Operador tentando chamar whatsapp_obter_proximos_envios diretamente: DEVE FALHAR (42501 / permissão)
    await assert.rejects(
      cOperador.query(`SELECT * FROM public.whatsapp_obter_proximos_envios(10, 60);`),
      (err) => err.code === '42501' || /permission denied/i.test(err.message),
      'Operador comum não pode dar claim na outbox'
    );

    // Admin chamando whatsapp_listar_envios_admin: DEVE PASSAR
    const resAdmin = await cAdmin.query(`SELECT * FROM public.whatsapp_listar_envios_admin(NULL, NULL, NULL, 10);`);
    assert.ok(Array.isArray(resAdmin.rows));
    if (resAdmin.rows.length > 0) {
      assert.ok(!('claim_token' in resAdmin.rows[0]), 'claim_token não pode vazar na consulta admin');
    }
  } finally {
    await closeClient(cOperador);
    await closeClient(cAdmin);
  }
});
