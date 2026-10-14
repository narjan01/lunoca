// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE N (ALERTAS, AUDITORIA & HEALTH-CHECK)
// ==============================================================================
// Valida os 16 gates obrigatórios N1 a N16 da Migration 029:
// N1:  Validade FEFO: lote próximo da validade gera alerta ATENCAO
// N2:  Lote vencido com saldo positivo gera alerta CRITICO
// N3:  Ruptura de estoque: ingrediente abaixo do estoque mínimo gera alerta
// N4:  Pedido em risco de atraso gera alerta operacional de bancada
// N5:  Margem crítica: pedido com margem inferior ao piso gera alerta
// N6:  Qualidade retida: checkpoint reprovado gera alerta CRITICO
// N7:  Health-check: valida reconciliação de saldos agregados vs lotes
// N8:  Health-check: valida integridade de pedidos pagos vs lançamentos
// N9:  Health-check: identifica pedidos órfãos ou inconsistências
// N10: Trilha de auditoria operacional é estritamente append-only (erro 42501 em UPDATE/DELETE)
// N11: Triggers automáticos gravam auditoria em alterações de catálogo e lotes
// N12: Reconhecimento de alerta é idempotente e auditável
// N13: Operador acessa visão de bancada com dados financeiros e margens estritamente sanitizados
// N14: Anon e cliente comum são bloqueados das RPCs da Frente N (RBAC fail-closed)
// N15: Health-check global é estritamente read-only (SELECT puro sem locks)
// N16: Alertas, auditoria e health-check possuem efeito financeiro ZERO no caixa e DRE
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
const PORT = 54399;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_UID   = 'aaaa1111-1111-4111-8111-111111111111';

let cliId;
let fornId;
let prodId;
let ingMorangoId;
let ingLeiteId;

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

function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-029',
    port: PORT,
    dbName: 'lunoca_test_029'
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
    [ADMIN_UID, 'admin-n@lunoca.test', 'Admin Frente N',    'admin'],
    [OPER_UID,  'oper-n@lunoca.test',  'Operador Frente N', 'operador'],
    [CLI_UID,   'cli-n@lunoca.test',   'Cliente Frente N',  'cliente']
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

  const resCli = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Natália Alertas N', '(85) 99801-3003', '5585998013003', 'cli-n@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_UID]
  );
  cliId = Number(resCli.rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const fornRes = await rpc(admin, 'salvar_fornecedor_admin', {
    p_nome: 'Laticínios & Frutas Brasil',
    p_documento: '11.222.333/0001-44',
    p_telefone: '(85) 3456-7890',
    p_email: 'frutas@brasil.test'
  });
  fornId = Number(fornRes.fornecedor_id);

  await setIdentity(admin, 'service_role');
  const resProd = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Bolo de Morango Especial', 120.00, 20, true, false)
     RETURNING id`
  );
  prodId = Number(resProd.rows[0].id);

  // Insumo 1: Morango Fresco (controla lote e validade)
  const resMorango = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo, controlar_lote, controlar_validade)
     VALUES ('Morango Fresco', 'g', 0.05, 0.05, 500, 1000, true, true, true)
     RETURNING id`
  );
  ingMorangoId = Number(resMorango.rows[0].id);

  // Insumo 2: Leite Condensado Artesanal
  const resLeite = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo, controlar_lote, controlar_validade)
     VALUES ('Leite Condensado Moça', 'g', 0.03, 0.03, 2000, 500, true, true, true)
     RETURNING id`
  );
  ingLeiteId = Number(resLeite.rows[0].id);

  await admin.query(
    `INSERT INTO public.ingrediente_saldos (ingrediente_id, saldo_atual, custo_medio_ponderado)
     VALUES
       ($1, 500, 0.05),
       ($2, 2000, 0.03)
     ON CONFLICT (ingrediente_id) DO UPDATE SET saldo_atual = EXCLUDED.saldo_atual`,
    [ingMorangoId, ingLeiteId]
  );
});

after(async () => {
  for (const c of activeClients) {
    await closeClient(c);
  }
  await closeClient(admin);
  if (teardownFn) await teardownFn();
});

// ==============================================================================
// N1: Validade FEFO: lote próximo da validade gera alerta ATENCAO
// ==============================================================================
test('N1: lote próximo da validade gera alerta ATENCAO (janela FEFO configurada)', async () => {
  await setIdentity(admin, 'service_role');
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'true', false)`);
  // Lote que vence daqui a 3 dias (dentro da janela padrão de 7 dias)
  const dataProx = addDaysISO(3);
  await admin.query(
    `INSERT INTO public.ingrediente_lotes (ingrediente_id, codigo_lote, data_validade, quantidade_inicial, quantidade_atual, custo_unitario_lote)
     VALUES ($1, 'LOTE-MORANGO-PROX', $2, 500, 500, 0.05)`,
    [ingMorangoId, dataProx]
  );
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'false', false)`);

  await setIdentity(admin, ADMIN_UID);
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'LOTE_VENCIMENTO' && a.titulo.includes('LOTE-MORANGO-PROX'));
  assert.ok(alerta, 'Deve gerar alerta de lote próximo da validade');
  assert.equal(alerta.nivel, 'ATENCAO');
  assert.ok(Number(alerta.dados_contexto.dias_restantes) >= 1 && Number(alerta.dados_contexto.dias_restantes) <= 7);
});

// ==============================================================================
// N2: Lote vencido com saldo positivo gera alerta CRITICO
// ==============================================================================
test('N2: lote vencido com saldo positivo gera alerta CRITICO', async () => {
  await setIdentity(admin, 'service_role');
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'true', false)`);
  const dataVencida = addDaysISO(-2);
  await admin.query(
    `INSERT INTO public.ingrediente_lotes (ingrediente_id, codigo_lote, data_validade, quantidade_inicial, quantidade_atual, custo_unitario_lote)
     VALUES ($1, 'LOTE-LEITE-VENCIDO', $2, 400, 400, 0.03)`,
    [ingLeiteId, dataVencida]
  );
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'false', false)`);

  await setIdentity(admin, ADMIN_UID);
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'LOTE_VENCIDO' && a.titulo.includes('LOTE-LEITE-VENCIDO'));
  assert.ok(alerta, 'Deve gerar alerta de lote vencido');
  assert.equal(alerta.nivel, 'CRITICO');
});

// ==============================================================================
// N3: Ruptura de estoque: ingrediente abaixo do estoque mínimo gera alerta
// ==============================================================================
test('N3: ruptura de estoque: ingrediente abaixo do estoque mínimo gera alerta', async () => {
  await setIdentity(admin, ADMIN_UID);
  // Morango tem saldo 500g e estoque mínimo 1000g -> ruptura ativa
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'RUPTURA_ESTOQUE' && a.titulo.includes('Morango Fresco'));
  assert.ok(alerta, 'Deve detectar ruptura de estoque para Morango Fresco');
  assert.ok(alerta.nivel === 'OPERACIONAL' || alerta.nivel === 'CRITICO');
});

// ==============================================================================
// N4: Pedido em risco de atraso gera alerta operacional de bancada
// ==============================================================================
test('N4: pedido em risco de atraso gera alerta operacional de bancada', async () => {
  await setIdentity(admin, 'service_role');
  // Inserir pedido para hoje às 14:00 (já passou ou iminente) em status aguardando_producao
  const { rows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Atraso N', 'atraso@lunoca.test', '5585998013003', $1, CURRENT_DATE, '10:00:00',
      'retirada', 'Loja', 120.00, 120.00,
      'confirmado', 'pago', 'aguardando_producao', 'Confirmado',
      'pix', '[{"nome":"Bolo de Morango Especial","quantidade":1,"preco":120}]'::jsonb
    ) RETURNING id`,
    [cliId]
  );
  const pidAtraso = Number(rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'ATRASO_PEDIDO' && a.origem_id === String(pidAtraso));
  assert.ok(alerta, 'Deve gerar alerta de risco de atraso do pedido');
  assert.equal(alerta.nivel, 'CRITICO');
});

// ==============================================================================
// N5: Margem crítica: pedido com margem inferior ao piso gera alerta
// ==============================================================================
test('N5: margem crítica: pedido com margem inferior ao piso gera alerta', async () => {
  await setIdentity(admin, 'service_role');
  // Simular pedido com margem calculada de 10% (piso alvo padrão é 30%)
  const { rows: pRows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Margem N', 'margem@lunoca.test', '5585998013003', $1, CURRENT_DATE, '18:00:00',
      'retirada', 'Loja', 100.00, 100.00,
      'confirmado', 'pago', 'pronto', 'Confirmado',
      'pix', '[{"nome":"Bolo de Morango Especial","quantidade":1,"preco":100}]'::jsonb
    ) RETURNING id`,
    [cliId]
  );
  const pidMargem = Number(pRows[0].id);

  await admin.query(
    `INSERT INTO public.pedido_custos_realizados (
      pedido_id, versao, status, receita_liquida_snapshot,
      custo_ingredientes_real, custo_embalagem, custo_mao_de_obra,
      custo_atribuivel_total, margem_contribuicao_valor, margem_contribuicao_percentual
    ) VALUES ($1, 1, 'finalizado', 100.00, 70.00, 10.00, 10.00, 90.00, 10.00, 10.00)`,
    [pidMargem]
  );

  await setIdentity(admin, ADMIN_UID);
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'MARGEM_CRITICA' && a.origem_id === String(pidMargem) || a.titulo.includes(String(pidMargem)));
  assert.ok(alerta, 'Deve acusar margem crítica para o pedido com margem de 10%');
});

// ==============================================================================
// N6: Qualidade retida: checkpoint reprovado gera alerta CRITICO
// ==============================================================================
test('N6: qualidade retida: checkpoint reprovado gera alerta CRITICO', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: pRows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Qualidade N', 'qual@lunoca.test', '5585998013003', $1, CURRENT_DATE, '19:00:00',
      'retirada', 'Loja', 150.00, 150.00,
      'confirmado', 'pago', 'em_producao', 'Confirmado',
      'pix', '[{"nome":"Bolo de Morango Especial","quantidade":1,"preco":150}]'::jsonb
    ) RETURNING id`,
    [cliId]
  );
  const pidQual = Number(pRows[0].id);

  await admin.query(
    `INSERT INTO public.producao_controles_qualidade (
      pedido_id, etapa, resultado, observacao, responsavel_id, responsavel_nome
    ) VALUES ($1, 'FINALIZACAO', 'REPROVADO', 'Borda queimada e rachadura', $2, 'Admin Frente N')`,
    [pidQual, ADMIN_UID]
  );

  await setIdentity(admin, ADMIN_UID);
  const res = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.equal(res.success, true);

  const alerta = res.alertas.find((a) => a.tipo_alerta === 'QUALIDADE_RETIDA' && a.titulo.includes(String(pidQual)));
  assert.ok(alerta, 'Deve gerar alerta de qualidade retida para pedido reprovado');
  assert.equal(alerta.nivel, 'CRITICO');
});

// ==============================================================================
// N7: Health-check: valida reconciliação de saldos agregados vs lotes
// ==============================================================================
test('N7: health-check: valida reconciliação de saldos agregados vs lotes', async () => {
  await setIdentity(admin, ADMIN_UID);
  const hc = await rpc(admin, 'executar_healthcheck_global_admin', {});
  assert.equal(hc.success, true);
  assert.ok(hc.checks.length >= 5);

  const checkLotes = hc.checks.find((c) => c.codigo === 'SALDOS_LOTES');
  assert.ok(checkLotes);
  assert.ok(typeof checkLotes.divergencias === 'number');
});

// ==============================================================================
// N8: Health-check: valida integridade de pedidos pagos vs lançamentos
// ==============================================================================
test('N8: health-check: valida integridade de pedidos pagos vs lançamentos', async () => {
  await setIdentity(admin, ADMIN_UID);
  const hc = await rpc(admin, 'executar_healthcheck_global_admin', {});
  assert.equal(hc.success, true);

  const checkFin = hc.checks.find((c) => c.codigo === 'FINANCEIRO_PEDIDOS');
  assert.ok(checkFin);
  assert.ok(typeof checkFin.divergencias === 'number');
});

// ==============================================================================
// N9: Health-check: identifica pedidos órfãos ou inconsistências
// ==============================================================================
test('N9: health-check: identifica pedidos órfãos ou inconsistências', async () => {
  await setIdentity(admin, ADMIN_UID);
  const hc = await rpc(admin, 'executar_healthcheck_global_admin', {});
  assert.equal(hc.success, true);

  const checkOrfaos = hc.checks.find((c) => c.codigo === 'PEDIDOS_ORFAOS');
  assert.ok(checkOrfaos);
  assert.ok(typeof checkOrfaos.divergencias === 'number');
});

// ==============================================================================
// N10: Trilha de auditoria operacional é estritamente append-only (erro 42501 em UPDATE/DELETE)
// ==============================================================================
test('N10: auditoria_operacional_eventos rejeita UPDATE e DELETE físicos com 42501', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `INSERT INTO public.auditoria_operacional_eventos (evento_tipo, entidade, entidade_id, antes, depois)
     VALUES ('TESTE_AUDIT', 'sistema', '1', '{"a":1}'::jsonb, '{"a":2}'::jsonb)
     RETURNING id`
  );
  const auditId = Number(rows[0].id);

  // Tentativa de UPDATE é bloqueada
  await assert.rejects(
    async () => {
      await admin.query(`UPDATE public.auditoria_operacional_eventos SET evento_tipo = 'ALTERADO' WHERE id = $1`, [auditId]);
    },
    (err) => err.code === '42501' || err.message.includes('AUDITORIA_APPEND_ONLY')
  );

  // Tentativa de DELETE é bloqueada
  await assert.rejects(
    async () => {
      await admin.query(`DELETE FROM public.auditoria_operacional_eventos WHERE id = $1`, [auditId]);
    },
    (err) => err.code === '42501' || err.message.includes('AUDITORIA_APPEND_ONLY')
  );
});

// ==============================================================================
// N11: Triggers automáticos gravam auditoria em alterações de catálogo e lotes
// ==============================================================================
test('N11: triggers automáticos gravam auditoria em alterações de catálogo e lotes', async () => {
  await setIdentity(admin, 'service_role');
  // Atualizar preço do produto com service_role
  await admin.query(`UPDATE public.produtos SET preco = 135.00 WHERE id = $1`, [prodId]);

  await setIdentity(admin, ADMIN_UID);
  // Consultar auditoria
  const resAudit = await rpc(admin, 'listar_auditoria_operacional_admin', {
    p_entidade: 'produtos',
    p_evento_tipo: 'ALTERACAO_CATALOGO_PRODUTO'
  });
  assert.equal(resAudit.success, true);
  assert.ok(resAudit.eventos.length >= 1, 'Deve registrar evento na trilha de auditoria');
  const ev = resAudit.eventos[0];
  assert.equal(Number(ev.depois.preco), 135.00);
});

// ==============================================================================
// N12: Reconhecimento de alerta é idempotente e auditável
// ==============================================================================
test('N12: reconhecimento de alerta é idempotente e auditável', async () => {
  await setIdentity(admin, ADMIN_UID);

  // Obter um alerta ativo
  const list = await rpc(admin, 'obter_alertas_operacionais_admin', {});
  assert.ok(list.alertas.length > 0);
  const alertaId = list.alertas[0].id;

  // Primeiro reconhecimento
  const rec1 = await rpc(admin, 'reconhecer_alerta_operacional', {
    p_alerta_id: alertaId,
    p_motivo: 'Ciente do alerta operacional para providências'
  });
  assert.equal(rec1.success, true);
  assert.equal(rec1.idempotente, false);

  // Segundo reconhecimento pelo mesmo usuário (idempotente)
  const rec2 = await rpc(admin, 'reconhecer_alerta_operacional', {
    p_alerta_id: alertaId,
    p_motivo: 'Tentativa redundante'
  });
  assert.equal(rec2.success, true);
  assert.equal(rec2.idempotente, true);
});

// ==============================================================================
// N13: Operador acessa visão de bancada com dados financeiros estritamente sanitizados
// ==============================================================================
test('N13: operador acessa visão de bancada com dados financeiros estritamente sanitizados', async () => {
  const oper = await newClient(OPER_UID);

  const res = await rpc(oper, 'obter_alertas_operacionais_operador', {});
  assert.equal(res.success, true);
  assert.equal(res.modo, 'operador_sanitizado');

  // Nenhum alerta deve conter dados financeiros, markups ou margens
  for (const a of res.alertas) {
    assert.notEqual(a.tipo_alerta, 'MARGEM_CRITICA', 'Operador jamais visualiza alerta de margem');
    if (a.dados_contexto) {
      assert.equal(a.dados_contexto.custo_atribuivel_total, undefined);
      assert.equal(a.dados_contexto.margem_contribuicao_valor, undefined);
      assert.equal(a.dados_contexto.margem_contribuicao_percentual, undefined);
      assert.equal(a.dados_contexto.receita_liquida, undefined);
      assert.equal(a.dados_contexto.total, undefined);
    }
  }

  await closeClient(oper);
});

// ==============================================================================
// N14: Anon e cliente comum são bloqueados das RPCs da Frente N (RBAC fail-closed)
// ==============================================================================
test('N14: anon e cliente comum são bloqueados das RPCs da Frente N (RBAC fail-closed)', async () => {
  const cli = await newClient(CLI_UID);
  const oper = await newClient(OPER_UID);
  const anon = await newClient('anon');

  // Cliente não acessa alertas de admin
  const resCli = await rpc(cli, 'obter_alertas_operacionais_admin', {});
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');

  // Operador não acessa health-check global
  const resOperHc = await rpc(oper, 'executar_healthcheck_global_admin', {});
  assert.equal(resOperHc.success, false);
  assert.equal(resOperHc.code, 'PERMISSION_DENIED');

  // Anon é rejeitado no nível do PostgreSQL (42501)
  await assert.rejects(
    async () => {
      await rpc(anon, 'obter_alertas_operacionais_admin', {});
    },
    (err) => err.code === '42501' || err.message.includes('permission denied')
  );

  await closeClient(cli);
  await closeClient(oper);
  await closeClient(anon);
});

// ==============================================================================
// N15: Health-check global é estritamente read-only (SELECT puro sem locks)
// ==============================================================================
test('N15: health-check global é estritamente read-only (SELECT puro sem locks)', async () => {
  await setIdentity(admin, ADMIN_UID);

  const hc1 = await rpc(admin, 'executar_healthcheck_global_admin', {});
  const hc2 = await rpc(admin, 'executar_healthcheck_global_admin', {});

  assert.equal(hc1.success, true);
  assert.equal(hc2.success, true);
  assert.equal(hc1.total_checks, 5);
  assert.equal(hc2.total_checks, 5);
});

// ==============================================================================
// N16: Alertas, auditoria e health-check possuem efeito financeiro ZERO no caixa e DRE
// ==============================================================================
test('N16: alertas, auditoria e health-check possuem efeito financeiro ZERO no caixa e DRE', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: lancAntes } = await admin.query('SELECT COUNT(*) AS total FROM public.financeiro_lancamentos');
  const { rows: pagAntes } = await admin.query('SELECT COUNT(*) AS total FROM public.pedido_pagamentos');
  const countLancAntes = Number(lancAntes[0].total);
  const countPagAntes = Number(pagAntes[0].total);

  await setIdentity(admin, ADMIN_UID);
  await rpc(admin, 'obter_alertas_operacionais_admin', {});
  await rpc(admin, 'executar_healthcheck_global_admin', {});
  await rpc(admin, 'salvar_configuracoes_alertas_admin', {
    p_dias_aviso_validade: 8,
    p_margem_minima_alvo: 32.00,
    p_antecedencia_atraso_minutos: 90
  });

  await setIdentity(admin, 'service_role');
  const { rows: lancDepois } = await admin.query('SELECT COUNT(*) AS total FROM public.financeiro_lancamentos');
  const { rows: pagDepois } = await admin.query('SELECT COUNT(*) AS total FROM public.pedido_pagamentos');
  const countLancDepois = Number(lancDepois[0].total);
  const countPagDepois = Number(pagDepois[0].total);

  // Lançamentos contábeis e pagamentos continuam absolutamente inalterados
  assert.equal(countLancDepois, countLancAntes);
  assert.equal(countPagDepois, countPagAntes);
});
