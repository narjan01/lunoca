// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - FRENTE B (MIGRATION 015)
// ==========================================================================
// Valida os 14 probes de comunicação WhatsApp, renderização canônica,
// chaves de idempotência, auditoria de canais e aprovação pública por versão.
// ==========================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54396;

let embedded = null;
let admin; // conexão superuser
let connInfo;

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
}

async function rpc(c, fn, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const { rows } = await c.query(`SELECT public.${fn}(${placeholders}) AS r`, keys.map((k) => params[k]));
  return rows[0].r;
}

let testOrcamentoId;
let testOrcamentoToken;
let testPedidoId;
let testPagamentoId;

before(async () => {
  if (process.env.DATABASE_URL) {
    connInfo = { connectionString: process.env.DATABASE_URL };
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const pgDir = path.join(ROOT, '.pg-integration-015');
    if (fs.existsSync(pgDir)) {
      try { fs.rmSync(pgDir, { recursive: true, force: true }); } catch {}
    }
    embedded = new EmbeddedPostgres({
      databaseDir: pgDir,
      user: 'postgres',
      password: 'postgres',
      port: PORT,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('lunoca_test_015');
    connInfo = { host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'lunoca_test_015' };
  }

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const install = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8');
  await admin.query(install);

  // Fixtures de usuários
  await setIdentity(admin, 'service_role');
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin@lunoca.local'),
      ('${OPER_UID}', 'operador@lunoca.local'),
      ('${CLIENTE_UID}', 'cliente@lunoca.local')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin Master', 'admin@lunoca.local', 'admin', true),
      ('${OPER_UID}', 'Operador Balcao', 'operador@lunoca.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente VIP', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  // Fixture: Orçamento de Teste
  const { rows: [orc] } = await admin.query(`
    INSERT INTO public.orcamentos (
      numero, versao, cliente_nome, cliente_telefone, cliente_email,
      data_evento, hora_evento, tipo_entrega, validade_ate, status,
      total, sinal_sugerido, token_publico
    ) VALUES (
      'ORC-2026-0099', 1, 'Maria Teste', '(83) 99876-5432', 'maria@teste.com',
      CURRENT_DATE + INTERVAL '5 days', '16:00:00', 'entrega', NOW() + INTERVAL '2 days', 'enviado',
      450.00, 225.00, gen_random_uuid()
    ) RETURNING id, token_publico;
  `);
  testOrcamentoId = orc.id;
  testOrcamentoToken = orc.token_publico;

  // Fixture: Pedido e Pagamento Aprovado
  const { rows: [ped] } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, status_comercial, status_financeiro,
      status_operacional, total, valor_pago, canal, modalidade_entrega, endereco_entrega,
      pagamento, itens, data_pedido, data_entrega, hora_entrega
    ) VALUES (
      'João Pedido', 'joao@teste.com', '83988887777', 'confirmado', 'pago',
      'aguardando_producao', 300.00, 150.00, 'whatsapp', 'entrega', 'Rua das Flores, 123',
      'pix', 'Bolo de Teste', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days', '16:00:00'
    ) RETURNING id;
  `);
  testPedidoId = ped.id;

  const { rows: [pag] } = await admin.query(`
    INSERT INTO public.pedido_pagamentos (
      pedido_id, valor, metodo, status
    ) VALUES (
      ${testPedidoId}, 150.00, 'pix', 'aprovado'
    ) RETURNING id;
  `);
  testPagamentoId = pag.id;

  // Histórico de status do pedido para 'pronto'
  await admin.query(`
    INSERT INTO public.pedido_status_historico (
      pedido_id, dimensao, status_anterior, status_novo, origem, metadata
    ) VALUES (
      ${testPedidoId}, 'operacional', 'em_producao', 'pronto', 'admin', '{"motivo": "Confeitaria finalizou bolo"}'::jsonb
    );
  `);
});

after(async () => {
  for (const c of activeClients) {
    try { await c.end(); } catch {}
  }
  if (admin) {
    try { await admin.end(); } catch {}
  }
  if (embedded) {
    try { await embedded.stop(); } catch {}
  }
});

// --------------------------------------------------------------------------
// FB-1: Telefone brasileiro normaliza corretamente E.164
// --------------------------------------------------------------------------
test('FB-1: Telefone brasileiro normaliza corretamente (E.164 com DDI 55, DDD 83, celular 9 dígitos)', async () => {
  const { rows: [r1] } = await admin.query("SELECT public.normalizar_telefone_e164('(83) 99876-5432') AS tel;");
  assert.equal(r1.tel, '5583998765432');

  const { rows: [r2] } = await admin.query("SELECT public.normalizar_telefone_e164('5583998765432') AS tel;");
  assert.equal(r2.tel, '5583998765432');

  // Telefone fixo brasileiro (10 dígitos)
  const { rows: [r3] } = await admin.query("SELECT public.normalizar_telefone_e164('(83) 3221-1234') AS tel;");
  assert.equal(r3.tel, '558332211234');
});

// --------------------------------------------------------------------------
// FB-2: Telefone inválido ou ambíguo é rejeitado
// --------------------------------------------------------------------------
test('FB-2: Telefone inválido ou ambíguo é rejeitado com NULL', async () => {
  const { rows: [r1] } = await admin.query("SELECT public.normalizar_telefone_e164('12345') AS tel;");
  assert.equal(r1.tel, null);

  // DDD 05 não existe no Brasil
  const { rows: [r2] } = await admin.query("SELECT public.normalizar_telefone_e164('05999999999') AS tel;");
  assert.equal(r2.tel, null);

  // Celular com 8 dígitos sem DDD
  const { rows: [r3] } = await admin.query("SELECT public.normalizar_telefone_e164('998765432') AS tel;");
  assert.equal(r3.tel, null);
});

// --------------------------------------------------------------------------
// FB-3: Orçamento gera link público com token correto (?t=UUID)
// --------------------------------------------------------------------------
test('FB-3: Orçamento gera link público com token correto (?t=UUID)', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'ORCAMENTO_ENVIADO',
    p_orcamento_id: testOrcamentoId,
    p_pedido_id: null
  });

  assert.equal(res.success, true);
  assert.equal(res.tipo, 'ORCAMENTO_ENVIADO');
  assert.equal(res.telefone, '5583998765432');
  assert.equal(res.link_publico, `https://lunocadoceria.com.br/orcamento.html?t=${testOrcamentoToken}`);
  assert.match(res.mensagem, /https:\/\/lunocadoceria\.com\.br\/orcamento\.html\?t=/);
  assert.match(res.mensagem, /A aprovação da proposta não reserva estoque ou capacidade/);
});

// --------------------------------------------------------------------------
// FB-4: Canal whatsapp_link registra status link_aberto (não enviado)
// --------------------------------------------------------------------------
test('FB-4: Canal whatsapp_link registra status link_aberto (não enviado)', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'registrar_comunicacao_cliente', {
    p_tipo: 'ORCAMENTO_ENVIADO',
    p_orcamento_id: testOrcamentoId,
    p_pedido_id: null,
    p_canal: 'whatsapp_link',
    p_status: 'link_aberto'
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'link_aberto');
  assert.equal(res.canal, 'whatsapp_link');

  const { rows: [reg] } = await admin.query('SELECT status, canal FROM public.comunicacoes_cliente WHERE id = $1', [res.id]);
  assert.equal(reg.status, 'link_aberto');
  assert.equal(reg.canal, 'whatsapp_link');
});

// --------------------------------------------------------------------------
// FB-5: Retry da mesma comunicação não duplica registro em comunicacoes_cliente
// --------------------------------------------------------------------------
test('FB-5: Retry da mesma comunicação não duplica registro (idempotência por chave)', async () => {
  const oper = await newClient(OPER_UID);
  const { rows: [qtdAntes] } = await admin.query('SELECT COUNT(*)::int AS qtd FROM public.comunicacoes_cliente WHERE orcamento_id = $1', [testOrcamentoId]);

  const resRetry = await rpc(oper, 'registrar_comunicacao_cliente', {
    p_tipo: 'ORCAMENTO_ENVIADO',
    p_orcamento_id: testOrcamentoId,
    p_pedido_id: null,
    p_canal: 'whatsapp_link',
    p_status: 'link_aberto'
  });

  assert.equal(resRetry.success, true);
  const { rows: [qtdDepois] } = await admin.query('SELECT COUNT(*)::int AS qtd FROM public.comunicacoes_cliente WHERE orcamento_id = $1', [testOrcamentoId]);
  assert.equal(qtdDepois.qtd, qtdAntes.qtd, 'Idempotência deve manter exatamente 1 registro para a mesma chave');
});

// --------------------------------------------------------------------------
// FB-6: Confirmação de sinal (SINAL_CONFIRMADO) usa snapshot do pagamento real
// --------------------------------------------------------------------------
test('FB-6: Confirmação de sinal usa snapshot do pagamento aprovado real', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'SINAL_CONFIRMADO',
    p_orcamento_id: null,
    p_pedido_id: testPedidoId
  });

  assert.equal(res.success, true);
  assert.equal(res.tipo, 'SINAL_CONFIRMADO');
  assert.equal(res.chave_idempotencia, `pedido:${testPedidoId}:pagamento:${testPagamentoId}:sinal`);
  assert.match(res.mensagem, /Recebemos seu sinal de R\$ 150[,.]00/);
  assert.match(res.mensagem, /Saldo restante: R\$ 150[,.]00/);
});

// --------------------------------------------------------------------------
// FB-7: Retry de webhook não duplica mensagem de sinal
// --------------------------------------------------------------------------
test('FB-7: Retry de webhook não duplica mensagem de sinal', async () => {
  const oper = await newClient(OPER_UID);
  const r1 = await rpc(oper, 'registrar_comunicacao_cliente', {
    p_tipo: 'SINAL_CONFIRMADO',
    p_orcamento_id: null,
    p_pedido_id: testPedidoId,
    p_canal: 'whatsapp_link',
    p_status: 'link_aberto'
  });
  assert.equal(r1.success, true);

  const r2 = await rpc(oper, 'registrar_comunicacao_cliente', {
    p_tipo: 'SINAL_CONFIRMADO',
    p_orcamento_id: null,
    p_pedido_id: testPedidoId,
    p_canal: 'whatsapp_link',
    p_status: 'link_aberto'
  });
  assert.equal(r2.success, true);
  assert.equal(r1.id, r2.id, 'Mesmo id retornado em chamadas repetidas');
});

// --------------------------------------------------------------------------
// FB-8: Orçamento vencido não permite aprovação pública (QUOTE_EXPIRED)
// --------------------------------------------------------------------------
test('FB-8: Orçamento vencido não permite aprovação pública (QUOTE_EXPIRED)', async () => {
  const { rows: [orcVencido] } = await admin.query(`
    INSERT INTO public.orcamentos (
      numero, versao, cliente_nome, cliente_telefone, validade_ate, status, total, token_publico
    ) VALUES (
      'ORC-2026-VENCIDO', 1, 'Cliente Vencido', '83991112233', NOW() - INTERVAL '1 hour', 'enviado', 200.00, gen_random_uuid()
    ) RETURNING token_publico;
  `);

  const anon = await newClient('anon');
  const res = await rpc(anon, 'aprovar_orcamento_publico', {
    p_token: orcVencido.token_publico,
    p_versao_esperada: 1
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'QUOTE_EXPIRED');
});

// --------------------------------------------------------------------------
// FB-9: Versão alterada entre leitura e aprovação pública retorna QUOTE_VERSION_CHANGED
// --------------------------------------------------------------------------
test('FB-9: Versão alterada entre leitura e aprovação pública retorna QUOTE_VERSION_CHANGED', async () => {
  const { rows: [orcMultiVersao] } = await admin.query(`
    INSERT INTO public.orcamentos (
      numero, versao, cliente_nome, cliente_telefone, validade_ate, status, total, token_publico
    ) VALUES (
      'ORC-2026-V2', 2, 'Cliente Revisado', '83991112233', NOW() + INTERVAL '2 days', 'enviado', 350.00, gen_random_uuid()
    ) RETURNING token_publico;
  `);

  const anon = await newClient('anon');
  // Cliente leu a versão 1, mas o admin já havia avançado para a versão 2
  const res = await rpc(anon, 'aprovar_orcamento_publico', {
    p_token: orcMultiVersao.token_publico,
    p_versao_esperada: 1
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'QUOTE_VERSION_CHANGED');
  assert.equal(res.versao_atual, 2);
  assert.equal(res.versao_esperada, 1);
});

// --------------------------------------------------------------------------
// FB-10: Evento PEDIDO_PRONTO gera template canônico correto
// --------------------------------------------------------------------------
test('FB-10: Evento PEDIDO_PRONTO gera template canônico correto', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'PEDIDO_PRONTO',
    p_orcamento_id: null,
    p_pedido_id: testPedidoId
  });

  assert.equal(res.success, true);
  assert.equal(res.tipo, 'PEDIDO_PRONTO');
  assert.match(res.mensagem, /Sua encomenda está pronta!/);
  assert.match(res.mensagem, /João Pedido/);
  assert.match(res.chave_idempotencia, /:pronto$/);
});

// --------------------------------------------------------------------------
// FB-11: Evento SAIU_PARA_ENTREGA gera template canônico correto com endereço
// --------------------------------------------------------------------------
test('FB-11: Evento SAIU_PARA_ENTREGA gera template canônico correto com endereço', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'SAIU_PARA_ENTREGA',
    p_orcamento_id: null,
    p_pedido_id: testPedidoId
  });

  assert.equal(res.success, true);
  assert.equal(res.tipo, 'SAIU_PARA_ENTREGA');
  assert.match(res.mensagem, /saiu para entrega/);
  assert.match(res.mensagem, /Rua das Flores, 123/);
  assert.match(res.chave_idempotencia, /:entrega$/);
});

// --------------------------------------------------------------------------
// FB-12: Usuário anon não executa RPCs administrativas de comunicação
// --------------------------------------------------------------------------
test('FB-12: Usuário anon não executa RPCs administrativas de comunicação', async () => {
  const anon = await newClient('anon');

  let erroPreview = false;
  try {
    await rpc(anon, 'obter_preview_comunicacao', {
      p_tipo: 'ORCAMENTO_ENVIADO',
      p_orcamento_id: testOrcamentoId,
      p_pedido_id: null
    });
  } catch (err) {
    erroPreview = true;
  }
  assert.equal(erroPreview, true, 'Anon deve receber erro ao tentar chamar obter_preview_comunicacao');

  let erroRegistrar = false;
  try {
    await rpc(anon, 'registrar_comunicacao_cliente', {
      p_tipo: 'ORCAMENTO_ENVIADO',
      p_orcamento_id: testOrcamentoId,
      p_pedido_id: null,
      p_canal: 'whatsapp_link',
      p_status: 'link_aberto'
    });
  } catch (err) {
    erroRegistrar = true;
  }
  assert.equal(erroRegistrar, true, 'Anon deve receber erro ao tentar chamar registrar_comunicacao_cliente');
});

// --------------------------------------------------------------------------
// FB-13: Frontend tenta registrar whatsapp_link como "enviado" -> rejeitado
// --------------------------------------------------------------------------
test('FB-13: Frontend tenta registrar whatsapp_link como enviado -> rejeitado com INVALID_STATUS_FOR_CHANNEL', async () => {
  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'registrar_comunicacao_cliente', {
    p_tipo: 'ORCAMENTO_ENVIADO',
    p_orcamento_id: testOrcamentoId,
    p_pedido_id: null,
    p_canal: 'whatsapp_link',
    p_status: 'enviado' // Status fraudulento/proibido para deep link
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'INVALID_STATUS_FOR_CHANNEL');
});

// --------------------------------------------------------------------------
// FB-14: Duas chamadas concorrentes para a mesma chave idempotente -> exatamente 1 comunicação
// --------------------------------------------------------------------------
test('FB-14: Duas chamadas concorrentes para a mesma chave idempotente -> exatamente 1 comunicação persistida', async () => {
  const oper1 = await newClient(OPER_UID);
  const oper2 = await newClient(OPER_UID);

  // Cria um novo orçamento para corrida concorrente
  const { rows: [orcCorrida] } = await admin.query(`
    INSERT INTO public.orcamentos (
      numero, versao, cliente_nome, cliente_telefone, validade_ate, status, total, token_publico
    ) VALUES (
      'ORC-CORRIDA-14', 1, 'Cliente Concorrencia', '83999990014', NOW() + INTERVAL '2 days', 'enviado', 500.00, gen_random_uuid()
    ) RETURNING id;
  `);

  // Disparo simultâneo de ambas as conexões
  const [res1, res2] = await Promise.all([
    rpc(oper1, 'registrar_comunicacao_cliente', {
      p_tipo: 'ORCAMENTO_ENVIADO',
      p_orcamento_id: orcCorrida.id,
      p_pedido_id: null,
      p_canal: 'whatsapp_link',
      p_status: 'link_aberto'
    }),
    rpc(oper2, 'registrar_comunicacao_cliente', {
      p_tipo: 'ORCAMENTO_ENVIADO',
      p_orcamento_id: orcCorrida.id,
      p_pedido_id: null,
      p_canal: 'whatsapp_link',
      p_status: 'link_aberto'
    })
  ]);

  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  assert.equal(res1.id, res2.id, 'Ambas devem resolver para o mesmo registro id');

  const { rows: [cont] } = await admin.query('SELECT COUNT(*)::int AS total FROM public.comunicacoes_cliente WHERE orcamento_id = $1', [orcCorrida.id]);
  assert.equal(cont.total, 1, 'Exatamente 1 linha deve existir em comunicacoes_cliente');
});
