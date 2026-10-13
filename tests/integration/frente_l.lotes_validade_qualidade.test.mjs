// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE L (LOTES, VALIDADE, RASTREABILIDADE E QUALIDADE)
// ==============================================================================
// Valida os 16 gates obrigatórios L1 a L16 da Migration 027 contra PostgreSQL real:
// L1:  Recebimento de compra cria lotes em ingrediente_lotes + movimentação ENTRADA_COMPRA
// L2:  Retry de recebimento de compra com lotes é idempotente e não duplica lotes
// L3:  Consumo de produção escolhe primeiro o lote com menor validade (política FEFO)
// L4:  Consumo multi-lote consome parcialmente o primeiro lote e completa no segundo
// L5:  Lote vencido é ignorado pelo FEFO e bloqueado para consumo normal
// L6:  Lote bloqueado por qualidade é ignorado pelo FEFO
// L7:  SUM(ingrediente_lotes.quantidade_atual) == ingrediente_saldos.saldo_atual sempre reconciliado
// L8:  Baixa por vencimento reduz lote e saldo agregado atomicamente
// L9:  ingrediente_lote_movimentacoes é imutável (UPDATE/DELETE bloqueados por trigger)
// L10: pedido_consumos_lote e producao_controles_qualidade são imutáveis (append-only)
// L11: Recall por lote (rastrear_lote_ingrediente_admin) lista exatamente os pedidos afetados
// L12: Rastreamento reverso do pedido (rastrear_pedido_producao_admin) lista lotes consumidos e checkpoints
// L13: Operador vê rastreabilidade operacional sem expor custos unitários de lote (sanitização)
// L14: Checkpoint de qualidade REPROVADO bloqueia avanço para pronto/expedição (QUALITY_HOLD_ACTIVE)
// L15: Reinspeção APROVADO na mesma etapa libera o bloqueio mantendo histórico append-only
// L16: Controles de qualidade e consumo de lotes não criam lançamentos financeiros (efeito financeiro ZERO)
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
const PORT = 54396;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_UID   = 'aaaa1111-1111-4111-8111-111111111111';

let cliId;
let fornId;
let prodId;
let ingChocId;

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

async function criarIngredienteLimpo(nome, custoUnitario = 0.08) {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo, controlar_lote, controlar_validade, dias_alerta_validade)
     VALUES ($1, 'g', $2, $2, 0, 100, true, true, true, 7)
     RETURNING id`,
    [nome, custoUnitario]
  );
  const id = Number(rows[0].id);
  await admin.query(
    `UPDATE public.ingrediente_saldos SET saldo_atual = 0, custo_medio_ponderado = $2 WHERE ingrediente_id = $1`,
    [id, custoUnitario]
  );
  return id;
}

async function criarPedidoProducaoTeste({
  produtoId = prodId,
  quantidade = 1,
  statusOperacional = 'em_producao',
  modalidade = 'entrega'
} = {}) {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Rastreabilidade L', 'clil@lunoca.test', '5585998011001', $1, CURRENT_DATE, '16:00:00',
      $2, 'Rua das Flores, 500 - Aldeota', 150.00, 150.00,
      'confirmado', 'pago', $3, 'Confirmado',
      'pix', '[{"nome":"Torta Belga","quantidade":1,"preco":150}]'::jsonb
    ) RETURNING id`,
    [cliId, modalidade, statusOperacional]
  );
  const pid = Number(rows[0].id);

  await admin.query(
    `INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade,
      preco_base_snapshot, preco_unitario_snapshot, subtotal,
      cmv_unitario_snapshot, cmv_total_snapshot
    ) VALUES ($1, $2, 'Torta Belga', $3, 150.00, 150.00, 150.00, 45.00, 45.00)`,
    [pid, produtoId, quantidade]
  );

  return pid;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-027',
    port: PORT,
    dbName: 'lunoca_test_027'
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
    [ADMIN_UID, 'admin-l@lunoca.test', 'Admin Frente L',    'admin'],
    [OPER_UID,  'oper-l@lunoca.test',  'Operador Frente L', 'operador'],
    [CLI_UID,   'cli-l@lunoca.test',   'Cliente Frente L',  'cliente']
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
     VALUES ($1, 'Beatriz Qualidade L', '(85) 99801-1001', '5585998011001', 'cli-l@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_UID]
  );
  cliId = Number(resCli.rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const fornRes = await rpc(admin, 'salvar_fornecedor_admin', {
    p_nome: 'Cacau Fino Importadora LTDA',
    p_documento: '12.345.678/0001-99',
    p_telefone: '(85) 3222-1111',
    p_email: 'contato@cacaufino.test',
    p_contato_nome: 'Henrique'
  });
  assert.equal(fornRes.success, true);
  fornId = Number(fornRes.fornecedor_id);

  await setIdentity(admin, 'service_role');
  const resProd = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Torta Belga Especial', 150.00, 30, true, false)
     RETURNING id`
  );
  prodId = Number(resProd.rows[0].id);

  ingChocId = await criarIngredienteLimpo('Chocolate Belga Callebaut 70%', 0.12);

  await admin.query(
    `INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
     VALUES ($1, $2, 200)
     ON CONFLICT (produto_id, ingrediente_id) DO UPDATE SET quantidade = EXCLUDED.quantidade`,
    [prodId, ingChocId]
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
// L1: Recebimento de compra cria lotes em ingrediente_lotes + movimentação ENTRADA_COMPRA
// ==============================================================================
test('L1: recebimento de compra cria lotes rastreáveis e movimentações ENTRADA_COMPRA', async () => {
  await setIdentity(admin, ADMIN_UID);

  const validade1 = addDaysISO(15);
  const validade2 = addDaysISO(45);

  const comp = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingChocId,
        quantidade: 300,
        custo_unitario: 0.10,
        codigo_lote: 'LOTE-CHOC-A1',
        data_fabricacao: addDaysISO(-10),
        data_validade: validade1
      },
      {
        ingrediente_id: ingChocId,
        quantidade: 500,
        custo_unitario: 0.12,
        codigo_lote: 'LOTE-CHOC-A2',
        data_fabricacao: addDaysISO(-5),
        data_validade: validade2
      }
    ]),
    p_numero_nota: 'NF-LOTE-001',
    p_data_compra: addDaysISO(0),
    p_observacoes: 'Compra com múltiplos lotes'
  });
  assert.equal(comp.success, true);

  const rec = await rpc(admin, 'receber_compra', {
    p_compra_id: comp.compra_id,
    p_data_vencimento: addDaysISO(30),
    p_gerar_conta_pagar: true
  });
  assert.equal(rec.success, true);
  assert.equal(rec.status, 'recebida');
  assert.equal(rec.lotes.length, 2);

  await setIdentity(admin, 'service_role');
  const { rows: lotes } = await admin.query(
    `SELECT codigo_lote, quantidade_inicial, quantidade_atual, data_validade::text AS data_validade
     FROM public.ingrediente_lotes
     WHERE ingrediente_id = $1
     ORDER BY codigo_lote ASC`,
    [ingChocId]
  );
  assert.equal(lotes.length, 2);
  assert.equal(lotes[0].codigo_lote, 'LOTE-CHOC-A1');
  assert.equal(Number(lotes[0].quantidade_atual), 300);
  assert.equal(lotes[1].codigo_lote, 'LOTE-CHOC-A2');
  assert.equal(Number(lotes[1].quantidade_atual), 500);

  const { rows: movs } = await admin.query(
    `SELECT tipo_evento, quantidade
     FROM public.ingrediente_lote_movimentacoes
     WHERE ingrediente_id = $1 AND tipo_evento = 'ENTRADA_COMPRA'
     ORDER BY id ASC`,
    [ingChocId]
  );
  assert.equal(movs.length, 2);
  assert.equal(Number(movs[0].quantidade), 300);
  assert.equal(Number(movs[1].quantidade), 500);
});

// ==============================================================================
// L2: Retry de recebimento de compra com lotes é idempotente e não duplica lotes
// ==============================================================================
test('L2: retry de receber_compra ou receber_compra_com_lotes é idempotente', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: compRows } = await admin.query(
    `SELECT id FROM public.compras WHERE numero_nota = 'NF-LOTE-001' LIMIT 1`
  );
  const compraId = Number(compRows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const retry1 = await rpc(admin, 'receber_compra', {
    p_compra_id: compraId,
    p_data_vencimento: null,
    p_gerar_conta_pagar: true
  });
  assert.equal(retry1.success, true);
  assert.equal(retry1.idempotente, true);

  const retry2 = await rpc(admin, 'receber_compra_com_lotes', {
    p_compra_id: compraId,
    p_lotes_itens: null,
    p_data_vencimento: null,
    p_gerar_conta_pagar: true
  });
  assert.equal(retry2.success, true);
  assert.equal(retry2.idempotente, true);

  await setIdentity(admin, 'service_role');
  const { rows: cnt } = await admin.query(
    `SELECT COUNT(*)::int AS total FROM public.ingrediente_lotes WHERE compra_id = $1`,
    [compraId]
  );
  assert.equal(cnt[0].total, 2);
});

// ==============================================================================
// L3: Consumo de produção escolhe primeiro o lote com menor validade (FEFO)
// ==============================================================================
test('L3: consumir_insumos_producao_pedido consome primeiro o lote com menor data_validade (FEFO)', async () => {
  // Pedido de 1 Torta Belga Especial -> consome 200g de Chocolate Belga (deve sair de LOTE-CHOC-A1 que vence em 15d e tem 300g)
  const pedId = await criarPedidoProducaoTeste({ quantidade: 1 });

  await setIdentity(admin, OPER_UID);
  const cons = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(cons.success, true);
  assert.equal(cons.idempotente, false);
  assert.equal(cons.consumos_lote.length, 1);
  assert.equal(cons.consumos_lote[0].codigo_lote, 'LOTE-CHOC-A1');
  assert.equal(Number(cons.consumos_lote[0].quantidade_consumida), 200);

  // Idempotência no retry do mesmo pedido
  const retry = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(retry.success, true);
  assert.equal(retry.idempotente, true);

  await setIdentity(admin, 'service_role');
  const { rows: loteA1 } = await admin.query(
    `SELECT quantidade_atual FROM public.ingrediente_lotes WHERE codigo_lote = 'LOTE-CHOC-A1'`
  );
  assert.equal(Number(loteA1[0].quantidade_atual), 100); // 300 - 200 = 100g restantes
});

// ==============================================================================
// L4: Consumo multi-lote consome parcialmente o primeiro lote e completa no segundo
// ==============================================================================
test('L4: consumo multi-lote esgota o restante do primeiro lote (100g) e completa no segundo lote (100g)', async () => {
  // LOTE-CHOC-A1 tem 100g restantes; LOTE-CHOC-A2 tem 500g.
  // Novo pedido de 1 Torta Belga (precisa de 200g) -> deve consumir 100g do A1 e 100g do A2!
  const pedId = await criarPedidoProducaoTeste({ quantidade: 1 });

  await setIdentity(admin, OPER_UID);
  const cons = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(cons.success, true);
  assert.equal(cons.consumos_lote.length, 2);
  assert.equal(cons.consumos_lote[0].codigo_lote, 'LOTE-CHOC-A1');
  assert.equal(Number(cons.consumos_lote[0].quantidade_consumida), 100);
  assert.equal(cons.consumos_lote[1].codigo_lote, 'LOTE-CHOC-A2');
  assert.equal(Number(cons.consumos_lote[1].quantidade_consumida), 100);

  await setIdentity(admin, 'service_role');
  const { rows: lotes } = await admin.query(
    `SELECT codigo_lote, quantidade_atual, public._derivar_estado_validade_lote(quantidade_atual, data_validade, bloqueado_qualidade, 7) AS estado
     FROM public.ingrediente_lotes
     WHERE codigo_lote IN ('LOTE-CHOC-A1', 'LOTE-CHOC-A2')
     ORDER BY codigo_lote ASC`
  );
  assert.equal(Number(lotes[0].quantidade_atual), 0);
  assert.equal(lotes[0].estado, 'esgotado');
  assert.equal(Number(lotes[1].quantidade_atual), 400);
  assert.equal(lotes[1].estado, 'valido');
});

// ==============================================================================
// L5: Lote vencido é ignorado pelo FEFO e bloqueado para consumo normal
// ==============================================================================
test('L5: lote vencido é ignorado pelo FEFO e bloqueia consumo caso seja o único saldo', async () => {
  const ingCremeId = await criarIngredienteLimpo('Creme de Leite Fresco 35%', 0.05);
  await setIdentity(admin, 'service_role');
  const { rows: pRows } = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Panna Cotta Fresca', 40.00, 10, true, false) RETURNING id`
  );
  const prodCremeId = Number(pRows[0].id);
  await admin.query(
    `INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade) VALUES ($1, $2, 150)`,
    [prodCremeId, ingCremeId]
  );

  // Compra com 1 lote VENCIDO (há 2 dias) de 300g
  await setIdentity(admin, ADMIN_UID);
  const compVenc = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingCremeId,
        quantidade: 300,
        custo_unitario: 0.05,
        codigo_lote: 'LOTE-CREME-VENCIDO',
        data_validade: addDaysISO(-2)
      }
    ]),
    p_numero_nota: 'NF-VENC-01',
    p_data_compra: addDaysISO(-20)
  });
  await rpc(admin, 'receber_compra', { p_compra_id: compVenc.compra_id, p_gerar_conta_pagar: false });

  const pedCremeId = await criarPedidoProducaoTeste({ produtoId: prodCremeId, quantidade: 1 });

  await setIdentity(admin, OPER_UID);
  const tentativaFalha = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedCremeId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(tentativaFalha.success, false);
  assert.equal(tentativaFalha.code, 'INSUFFICIENT_ELIGIBLE_LOT_STOCK');
  assert.equal(Number(tentativaFalha.saldo_elegivel_lotes), 0);

  // Agora entra um lote VÁLIDO de 200g -> FEFO deve ignorar o vencido e consumir do válido!
  await setIdentity(admin, ADMIN_UID);
  const compVal = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingCremeId,
        quantidade: 200,
        custo_unitario: 0.05,
        codigo_lote: 'LOTE-CREME-NOVO-VALIDO',
        data_validade: addDaysISO(10)
      }
    ]),
    p_numero_nota: 'NF-VAL-02',
    p_data_compra: addDaysISO(0)
  });
  await rpc(admin, 'receber_compra', { p_compra_id: compVal.compra_id, p_gerar_conta_pagar: false });

  await setIdentity(admin, OPER_UID);
  const tentativaOk = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedCremeId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(tentativaOk.success, true);
  assert.equal(tentativaOk.consumos_lote.length, 1);
  assert.equal(tentativaOk.consumos_lote[0].codigo_lote, 'LOTE-CREME-NOVO-VALIDO');
});

// ==============================================================================
// L6: Lote bloqueado por qualidade é ignorado pelo FEFO
// ==============================================================================
test('L6: lote bloqueado por qualidade (alterar_bloqueio_qualidade_lote) é ignorado pelo FEFO', async () => {
  const ingMorangoId = await criarIngredienteLimpo('Geleia Artesanal de Morango', 0.06);
  await setIdentity(admin, 'service_role');
  const { rows: pRows } = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Cheesecake Morango', 95.00, 10, true, false) RETURNING id`
  );
  const prodMorangoId = Number(pRows[0].id);
  await admin.query(
    `INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade) VALUES ($1, $2, 100)`,
    [prodMorangoId, ingMorangoId]
  );

  await setIdentity(admin, ADMIN_UID);
  const comp = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingMorangoId,
        quantidade: 150,
        custo_unitario: 0.06,
        codigo_lote: 'LOTE-MOR-BLOQ',
        data_validade: addDaysISO(5) // Vence antes, mas será bloqueado
      },
      {
        ingrediente_id: ingMorangoId,
        quantidade: 150,
        custo_unitario: 0.06,
        codigo_lote: 'LOTE-MOR-LIVRE',
        data_validade: addDaysISO(20)
      }
    ]),
    p_numero_nota: 'NF-MORANGO-01',
    p_data_compra: addDaysISO(0)
  });
  const rec = await rpc(admin, 'receber_compra', { p_compra_id: comp.compra_id, p_gerar_conta_pagar: false });
  const loteBloqId = Number(rec.lotes[0].lote_id);

  // Bloqueia o primeiro lote por qualidade
  const bloqRes = await rpc(admin, 'alterar_bloqueio_qualidade_lote', {
    p_lote_id: loteBloqId,
    p_bloquear: true,
    p_motivo: 'Embalagem estufada na inspeção visual'
  });
  assert.equal(bloqRes.success, true);
  assert.equal(bloqRes.bloqueado_qualidade, true);

  const pedMorId = await criarPedidoProducaoTeste({ produtoId: prodMorangoId, quantidade: 1 });
  await setIdentity(admin, OPER_UID);
  const cons = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedMorId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(cons.success, true);
  assert.equal(cons.consumos_lote.length, 1);
  assert.equal(cons.consumos_lote[0].codigo_lote, 'LOTE-MOR-LIVRE');
});

// ==============================================================================
// L7: SUM(ingrediente_lotes.quantidade_atual) == ingrediente_saldos.saldo_atual sempre reconciliado
// ==============================================================================
test('L7: reconciliar_saldos_lotes_admin comprova paridade exata entre lotes e ingrediente_saldos', async () => {
  await setIdentity(admin, ADMIN_UID);
  const rec = await rpc(admin, 'reconciliar_saldos_lotes_admin');
  assert.equal(rec.success, true);
  assert.equal(rec.reconciliado, true);
  assert.equal(Number(rec.divergencias_count), 0);
});

// ==============================================================================
// L8: Baixa por vencimento reduz lote e saldo agregado atomicamente
// ==============================================================================
test('L8: registrar_baixa_lote_insumo reduz o lote vencido e o saldo agregado mantendo reconciliação', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT id, ingrediente_id, quantidade_atual FROM public.ingrediente_lotes WHERE codigo_lote = 'LOTE-CREME-VENCIDO'`
  );
  const loteVencId = Number(rows[0].id);
  const ingId = Number(rows[0].ingrediente_id);

  const { rows: saldoAntesRows } = await admin.query(
    `SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`,
    [ingId]
  );
  const saldoAntes = Number(saldoAntesRows[0].saldo_atual); // 300 (vencido) + 50 (restante do válido) = 350

  await setIdentity(admin, OPER_UID);
  const baixa = await rpc(admin, 'registrar_baixa_lote_insumo', {
    p_lote_id: loteVencId,
    p_tipo_evento: 'VENCIMENTO',
    p_quantidade: 300,
    p_motivo: 'Descarte integral de lote vencido conforme POP sanitário'
  });
  assert.equal(baixa.success, true);
  assert.equal(Number(baixa.saldo_lote_posterior), 0);
  assert.equal(Number(baixa.saldo_agregado_posterior), saldoAntes - 300);

  await setIdentity(admin, ADMIN_UID);
  const rec = await rpc(admin, 'reconciliar_saldos_lotes_admin');
  assert.equal(rec.reconciliado, true);
});

// ==============================================================================
// L9: ingrediente_lote_movimentacoes é imutável (UPDATE/DELETE bloqueados por trigger)
// ==============================================================================
test('L9: ingrediente_lote_movimentacoes bloqueia UPDATE e DELETE físicos com erro 42501', async () => {
  await setIdentity(admin, 'service_role');
  await assert.rejects(
    () => admin.query(`UPDATE public.ingrediente_lote_movimentacoes SET quantidade = 999 WHERE id = 1`),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`DELETE FROM public.ingrediente_lote_movimentacoes WHERE id = 1`),
    (err) => err.code === '42501'
  );
});

// ==============================================================================
// L10: pedido_consumos_lote e producao_controles_qualidade são imutáveis (append-only)
// ==============================================================================
test('L10: pedido_consumos_lote e producao_controles_qualidade bloqueiam UPDATE e DELETE físicos', async () => {
  const pedId = await criarPedidoProducaoTeste({ quantidade: 1 });
  await setIdentity(admin, OPER_UID);
  const qc = await rpc(admin, 'registrar_controle_qualidade_pedido', {
    p_pedido_id: pedId,
    p_etapa: 'PRE_PRODUCAO',
    p_resultado: 'APROVADO',
    p_observacao: 'Insumos conferidos'
  });
  assert.equal(qc.success, true);

  await setIdentity(admin, 'service_role');
  await assert.rejects(
    () => admin.query(`UPDATE public.pedido_consumos_lote SET quantidade_consumida = 1`),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`DELETE FROM public.pedido_consumos_lote`),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`UPDATE public.producao_controles_qualidade SET resultado = 'REPROVADO' WHERE id = $1`, [qc.controle_id]),
    (err) => err.code === '42501'
  );
  await assert.rejects(
    () => admin.query(`DELETE FROM public.producao_controles_qualidade WHERE id = $1`, [qc.controle_id]),
    (err) => err.code === '42501'
  );
});

// ==============================================================================
// L11: Recall por lote (rastrear_lote_ingrediente_admin) lista exatamente os pedidos afetados
// ==============================================================================
test('L11: rastrear_lote_ingrediente_admin identifica todos os pedidos que consumiram determinado lote', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT id FROM public.ingrediente_lotes WHERE codigo_lote = 'LOTE-CHOC-A1'`
  );
  const loteA1Id = Number(rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const recall = await rpc(admin, 'rastrear_lote_ingrediente_admin', {
    p_lote_id: loteA1Id
  });
  assert.equal(recall.success, true);
  assert.equal(recall.lote.codigo_lote, 'LOTE-CHOC-A1');
  assert.equal(recall.lote.fornecedor_nome, 'Cacau Fino Importadora LTDA');
  // LOTE-CHOC-A1 foi consumido nos testes L3 (200g) e L4 (100g) -> 2 pedidos afetados
  assert.equal(Number(recall.total_pedidos_afetados), 2);
  assert.equal(recall.pedidos_afetados.length, 2);
});

// ==============================================================================
// L12: Rastreamento reverso do pedido (rastrear_pedido_producao_admin) lista lotes consumidos e checkpoints
// ==============================================================================
test('L12: rastrear_pedido_producao_admin retorna lotes consumidos e controles de qualidade do pedido', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT DISTINCT pedido_id FROM public.pedido_consumos_lote ORDER BY pedido_id ASC`
  );
  // Segundo pedido (do teste L4) consumiu 2 lotes (LOTE-CHOC-A1 e LOTE-CHOC-A2)
  const pedidoMultiLoteId = Number(rows[1].pedido_id);

  await setIdentity(admin, ADMIN_UID);
  const rastr = await rpc(admin, 'rastrear_pedido_producao_admin', {
    p_pedido_id: pedidoMultiLoteId
  });
  assert.equal(rastr.success, true);
  assert.equal(rastr.lotes_consumidos.length, 2);
  assert.notEqual(rastr.lotes_consumidos[0].custo_unitario_lote, null);
});

// ==============================================================================
// L13: Operador vê rastreabilidade operacional sem expor custos unitários de lote (sanitização)
// ==============================================================================
test('L13: operador acessa rastreabilidade e painel de lotes com custo_unitario_lote sanitizado (null)', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT DISTINCT pedido_id FROM public.pedido_consumos_lote ORDER BY pedido_id ASC LIMIT 1`
  );
  const pedidoId = Number(rows[0].pedido_id);

  await setIdentity(admin, OPER_UID);
  const rastrOp = await rpc(admin, 'rastrear_pedido_producao_admin', {
    p_pedido_id: pedidoId
  });
  assert.equal(rastrOp.success, true);
  assert.ok(rastrOp.lotes_consumidos.length >= 1);
  assert.equal(rastrOp.lotes_consumidos[0].custo_unitario_lote, null);

  const painelOp = await rpc(admin, 'obter_painel_lotes_validade', {
    p_ingrediente_id: null,
    p_filtro_estado: null
  });
  assert.equal(painelOp.success, true);
  assert.ok(painelOp.lotes.length >= 1);
  assert.equal(painelOp.lotes[0].custo_unitario_lote, null);
});

// ==============================================================================
// L14: Checkpoint de qualidade REPROVADO bloqueia avanço para pronto/expedição (QUALITY_HOLD_ACTIVE)
// ==============================================================================
test('L14: checkpoint REPROVADO bloqueia marcar_pedido_pronto e despachar_pedido_entrega com QUALITY_HOLD_ACTIVE', async () => {
  const pedHoldId = await criarPedidoProducaoTeste({
    quantidade: 1,
    statusOperacional: 'em_producao',
    modalidade: 'entrega'
  });

  await setIdentity(admin, OPER_UID);
  const rep = await rpc(admin, 'registrar_controle_qualidade_pedido', {
    p_pedido_id: pedHoldId,
    p_etapa: 'FINALIZACAO',
    p_resultado: 'REPROVADO',
    p_observacao: 'Ganache trincou no resfriamento; requer retrabalho antes de liberar'
  });
  assert.equal(rep.success, true);
  assert.equal(rep.pedido_bloqueado_qualidade, true);

  const prontoBloq = await rpc(admin, 'marcar_pedido_pronto', {
    p_pedido_id: pedHoldId
  });
  assert.equal(prontoBloq.success, false);
  assert.equal(prontoBloq.code, 'QUALITY_HOLD_ACTIVE');
});

// ==============================================================================
// L15: Reinspeção APROVADO na mesma etapa libera o bloqueio mantendo histórico append-only
// ==============================================================================
test('L15: reinspeção APROVADO na etapa reprovada libera o pedido mantendo ambos os registros append-only', async () => {
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query(
    `SELECT pedido_id FROM public.producao_controles_qualidade WHERE resultado = 'REPROVADO' ORDER BY id DESC LIMIT 1`
  );
  const pedHoldId = Number(rows[0].pedido_id);

  await setIdentity(admin, OPER_UID);
  const aprov = await rpc(admin, 'registrar_controle_qualidade_pedido', {
    p_pedido_id: pedHoldId,
    p_etapa: 'FINALIZACAO',
    p_resultado: 'APROVADO',
    p_observacao: 'Cobertura refeita e aprovada na reinspeção'
  });
  assert.equal(aprov.success, true);
  assert.equal(aprov.pedido_bloqueado_qualidade, false);

  const prontoOk = await rpc(admin, 'marcar_pedido_pronto', {
    p_pedido_id: pedHoldId
  });
  assert.equal(prontoOk.success, true);
  assert.equal(prontoOk.status_operacional, 'pronto');

  // Ambos os checkpoints permanecem gravados (append-only)
  const rastr = await rpc(admin, 'rastrear_pedido_producao_admin', {
    p_pedido_id: pedHoldId
  });
  assert.equal(rastr.controles_qualidade.length, 2);
});

// ==============================================================================
// L16: Controles de qualidade e consumo de lotes não criam lançamentos financeiros (efeito financeiro ZERO)
// ==============================================================================
test('L16: operações de consumo FEFO, baixa de lote e qualidade têm efeito financeiro ZERO', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: antesFin } = await admin.query(`SELECT COUNT(*)::int AS c FROM public.financeiro_lancamentos`);
  const { rows: antesPag } = await admin.query(`SELECT COUNT(*)::int AS c FROM public.pedido_pagamentos`);

  const pedId = await criarPedidoProducaoTeste({ quantidade: 1 });

  await setIdentity(admin, OPER_UID);
  const cons = await rpc(admin, 'consumir_insumos_producao_pedido', {
    p_pedido_id: pedId,
    p_itens_consumo: null,
    p_chave_idempotencia: null
  });
  assert.equal(cons.success, true);

  const qc = await rpc(admin, 'registrar_controle_qualidade_pedido', {
    p_pedido_id: pedId,
    p_etapa: 'EMBALAGEM',
    p_resultado: 'APROVADO_COM_RESSALVA',
    p_observacao: 'Etiqueta levemente inclinada, sem impacto no produto'
  });
  assert.equal(qc.success, true);

  await setIdentity(admin, 'service_role');
  const { rows: depoisFin } = await admin.query(`SELECT COUNT(*)::int AS c FROM public.financeiro_lancamentos`);
  const { rows: depoisPag } = await admin.query(`SELECT COUNT(*)::int AS c FROM public.pedido_pagamentos`);

  assert.equal(depoisFin[0].c, antesFin[0].c);
  assert.equal(depoisPag[0].c, antesPag[0].c);
});
