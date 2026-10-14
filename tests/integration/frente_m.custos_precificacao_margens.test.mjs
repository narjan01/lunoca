// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE M (CUSTOS, PRECIFICAÇÃO E MARGENS)
// ==============================================================================
// Valida os 16 gates obrigatórios M1 a M16 da Migration 028:
// M1:  Custo histórico usa lote efetivamente consumido (Frente L / pedido_consumos_lote)
// M2:  Mudança futura de CMP/preço de compra não altera pedido histórico (temporalidade)
// M3:  Embalagem entra conforme tipo de aplicação (POR_UNIDADE vs POR_PEDIDO)
// M4:  Mão de obra calcula pela política vigente e mudança posterior de custo-hora não afeta passado
// M5:  Custo adicional POR_UNIDADE é multiplicado pela quantidade de itens
// M6:  Custo adicional POR_PEDIDO entra uma única vez por pedido
// M7:  Desconto reduz receita líquida e margem sem alterar o custo atribuível
// M8:  credito_cliente usado como meio de pagamento não altera a margem da venda
// M9:  Estorno financeiro do pedido não reescreve o custo produtivo histórico em pedido_custos_realizados
// M10: Pedido cancelado antes da produção é rejeitado por calcular_custo_real_pedido_admin
// M11: Simulação de preço não altera o preço no catálogo de produtos (produtos.preco)
// M12: Alteração de preço continua restrita à governança da Frente A (apenas admin)
// M13: Operador não tem acesso a custos, margens e markups (PERMISSION_DENIED)
// M14: Anon e cliente comum não acessam RPCs industriais de custos e margens
// M15: Margem do pedido reconcilia matematicamente componente por componente
// M16: Cálculo de custo e margem possui efeito financeiro ZERO no caixa e no DRE
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
const PORT = 54398;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_UID   = 'aaaa1111-1111-4111-8111-111111111111';

let cliId;
let fornId;
let prodId;
let ingCacauId;
let recursoLiderId;
let recursoAuxId;

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

async function criarPedidoBase({
  quantidade = 1,
  subtotal = 150.00,
  desconto = 0.00,
  statusOperacional = 'pronto',
  statusComercial = 'confirmado',
  metodoPagamento = 'pix'
}) {
  await setIdentity(admin, 'service_role');
  const total = subtotal - desconto;
  const { rows } = await admin.query(
    `INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal, desconto,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Custos M', 'clim@lunoca.test', '5585998012002', $1, CURRENT_DATE, '17:00:00',
      'retirada', 'Retirada na Loja', $2, $3, $4,
      $5, 'pago', $6, 'Confirmado',
      $7, '[{"nome":"Torta Cacau Nobre","quantidade":1,"preco":150}]'::jsonb
    ) RETURNING id`,
    [cliId, total, subtotal, desconto, statusComercial, statusOperacional, metodoPagamento]
  );
  const pid = Number(rows[0].id);

  await admin.query(
    `INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade,
      preco_base_snapshot, preco_unitario_snapshot, subtotal,
      cmv_unitario_snapshot, cmv_total_snapshot
    ) VALUES ($1, $2, 'Torta Cacau Nobre', $3, 150.00, 150.00, $4, 40.00, $5)`,
    [pid, prodId, quantidade, subtotal, 40.00 * quantidade]
  );

  return pid;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-028',
    port: PORT,
    dbName: 'lunoca_test_028'
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
    [ADMIN_UID, 'admin-m@lunoca.test', 'Admin Frente M',    'admin'],
    [OPER_UID,  'oper-m@lunoca.test',  'Operador Frente M', 'operador'],
    [CLI_UID,   'cli-m@lunoca.test',   'Cliente Frente M',  'cliente']
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
     VALUES ($1, 'Camila Margens M', '(85) 99801-2002', '5585998012002', 'cli-m@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_UID]
  );
  cliId = Number(resCli.rows[0].id);

  await setIdentity(admin, ADMIN_UID);
  const fornRes = await rpc(admin, 'salvar_fornecedor_admin', {
    p_nome: 'Distribuidora Cacau Brasil',
    p_documento: '98.765.432/0001-11',
    p_telefone: '(85) 3333-2222',
    p_email: 'cacau@brasil.test'
  });
  fornId = Number(fornRes.fornecedor_id);

  await setIdentity(admin, 'service_role');
  const resProd = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Torta Cacau Nobre', 150.00, 50, true, false)
     RETURNING id`
  );
  prodId = Number(resProd.rows[0].id);

  const resIng = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo, controlar_lote, controlar_validade)
     VALUES ('Cacau em Pó 100% Puro', 'g', 0.10, 0.10, 0, 100, true, true, true)
     RETURNING id`
  );
  ingCacauId = Number(resIng.rows[0].id);

  await admin.query(
    `INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
     VALUES ($1, $2, 300)
     ON CONFLICT (produto_id, ingrediente_id) DO UPDATE SET quantidade = EXCLUDED.quantidade`,
    [prodId, ingCacauId]
  );

  // Cadastrar Recursos de Produção
  const resLider = await admin.query(
    `INSERT INTO public.recursos_producao (nome, tipo, custo_hora, ativo)
     VALUES ('Confeiteira Especialista', 'mao_de_obra', 40.00, true)
     RETURNING id`
  );
  recursoLiderId = Number(resLider.rows[0].id);

  const resAux = await admin.query(
    `INSERT INTO public.recursos_producao (nome, tipo, custo_hora, ativo)
     VALUES ('Auxiliar de Preparo', 'mao_de_obra', 20.00, true)
     RETURNING id`
  );
  recursoAuxId = Number(resAux.rows[0].id);

  // Cadastrar Tempos de Produção
  await admin.query(
    `INSERT INTO public.produto_tempos_producao (produto_id, etapa, minutos_padrao, recurso_id)
     VALUES
       ($1, 'preparo', 30, $2),
       ($1, 'finalizacao', 30, $3)`,
    [prodId, recursoAuxId, recursoLiderId]
  );

  // Cadastrar Embalagem e Adicional
  await admin.query(
    `INSERT INTO public.produto_custos_adicionais (produto_id, nome, categoria, tipo_aplicacao, valor, ativo)
     VALUES
       ($1, 'Caixa Especial com Visor', 'embalagem', 'POR_UNIDADE', 8.00, true),
       ($1, 'Fita de Cetim Dourada', 'decoracao', 'POR_PEDIDO', 5.00, true)`,
    [prodId]
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
// M1: Custo histórico usa lote efetivamente consumido (Frente L / pedido_consumos_lote)
// ==============================================================================
test('M1: custo histórico usa lote efetivamente consumido (pedido_consumos_lote)', async () => {
  await setIdentity(admin, ADMIN_UID);

  // 1. Criar compra e receber lote com custo de R$ 0.12/g
  const comp = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingCacauId,
        quantidade: 1000,
        custo_unitario: 0.12,
        codigo_lote: 'LOTE-M1-001',
        data_validade: addDaysISO(60)
      }
    ]),
    p_numero_nota: 'NF-M1-001',
    p_data_compra: addDaysISO(0),
    p_observacoes: 'Recebimento de teste M1'
  });
  assert.equal(comp.success, true);
  const compraId = Number(comp.compra_id);

  const rec = await rpc(admin, 'receber_compra', {
    p_compra_id: compraId
  });
  assert.equal(rec.success, true);

  // 2. Criar pedido e consumir 300g do lote
  const pid = await criarPedidoBase({ quantidade: 1 });
  await rpc(admin, 'consumir_insumos_producao_pedido', { p_pedido_id: pid });

  // 3. Calcular custo real do pedido
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  assert.equal(calc.success, true);
  // 300g * 0.12 = R$ 36.00 de insumos
  assert.equal(Number(calc.custo_ingredientes_real), 36.00);

  const margem = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  assert.equal(margem.success, true);
  assert.equal(Number(margem.custo_ingredientes_real), 36.00);
});

// ==============================================================================
// M2: Mudança futura de CMP/preço de compra não altera pedido histórico (temporalidade)
// ==============================================================================
test('M2: mudança futura de CMP não altera pedido histórico já calculado', async () => {
  await setIdentity(admin, ADMIN_UID);

  // Pedido já calculado no M1 tinha R$ 36.00 de insumo
  const pid = await criarPedidoBase({ quantidade: 1 });
  await rpc(admin, 'consumir_insumos_producao_pedido', { p_pedido_id: pid });
  const calc1 = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  const custoInsumoOriginal = Number(calc1.custo_ingredientes_real);

  // Nova compra futura muito mais cara (R$ 0.40/g) que altera o CMP
  const compCara = await rpc(admin, 'criar_compra', {
    p_fornecedor_id: fornId,
    p_itens: JSON.stringify([
      {
        ingrediente_id: ingCacauId,
        quantidade: 2000,
        custo_unitario: 0.40,
        codigo_lote: 'LOTE-M2-CARO',
        data_validade: addDaysISO(90)
      }
    ]),
    p_numero_nota: 'NF-M2-001',
    p_data_compra: addDaysISO(0),
    p_observacoes: 'Recebimento caro M2'
  });
  assert.equal(compCara.success, true);

  const recCara = await rpc(admin, 'receber_compra', {
    p_compra_id: compCara.compra_id
  });
  assert.equal(recCara.success, true);

  // Consultar o pedido histórico após alteração do CMP de mercado
  const margemHistorica = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  assert.equal(Number(margemHistorica.custo_ingredientes_real), custoInsumoOriginal);
  assert.equal(Number(margemHistorica.custo_atribuivel_total), Number(calc1.custo_atribuivel_total));
});

// ==============================================================================
// M3: Embalagem entra conforme tipo de aplicação (POR_UNIDADE vs POR_PEDIDO)
// ==============================================================================
test('M3: embalagem entra conforme tipo de aplicação (POR_UNIDADE vs POR_PEDIDO)', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pid = await criarPedidoBase({ quantidade: 2 }); // 2 tortas
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  assert.equal(calc.success, true);

  // Caixa é POR_UNIDADE (R$ 8.00 * 2 = R$ 16.00)
  assert.equal(Number(calc.custo_embalagem), 16.00);
});

// ==============================================================================
// M4: Mão de obra calcula pela política vigente e mudança posterior não afeta passado
// ==============================================================================
test('M4: mão de obra calcula pela política vigente e mudança posterior não afeta passado', async () => {
  await setIdentity(admin, ADMIN_UID);

  // Pedido com 1 torta:
  // Auxiliar: 30 min (0.5h) * R$ 20.00 = R$ 10.00
  // Confeiteira: 30 min (0.5h) * R$ 40.00 = R$ 20.00
  // Total MO = R$ 30.00
  const pid = await criarPedidoBase({ quantidade: 1 });
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  assert.equal(Number(calc.custo_mao_de_obra), 30.00);

  // Alterar custo-hora do recurso para R$ 80.00
  await rpc(admin, 'salvar_recurso_producao_admin', {
    p_id: recursoLiderId,
    p_nome: 'Confeiteira Especialista',
    p_custo_hora: 80.00
  });

  // O pedido calculado anteriormente deve permanecer inalterado (R$ 30.00)
  const margem = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  assert.equal(Number(margem.custo_mao_de_obra), 30.00);
});

// ==============================================================================
// M5: Custo adicional POR_UNIDADE é multiplicado pela quantidade de itens
// ==============================================================================
test('M5: custo adicional POR_UNIDADE é multiplicado pela quantidade de itens', async () => {
  await setIdentity(admin, ADMIN_UID);

  // Adicionar topper por unidade: R$ 3.00
  await setIdentity(admin, 'service_role');
  await admin.query(
    `INSERT INTO public.produto_custos_adicionais (produto_id, nome, categoria, tipo_aplicacao, valor, ativo)
     VALUES ($1, 'Topper com Nome', 'decoracao', 'POR_UNIDADE', 3.00, true)`,
    [prodId]
  );
  await setIdentity(admin, ADMIN_UID);

  const pid = await criarPedidoBase({ quantidade: 3 }); // 3 unidades
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });

  // Adicionais do pedido:
  // Topper: 3 * R$ 3.00 = R$ 9.00
  // Fita Cetim (POR_PEDIDO): R$ 5.00 * 1 = R$ 5.00
  // Total Adicionais = R$ 14.00
  assert.equal(Number(calc.custo_adicionais), 14.00);
});

// ==============================================================================
// M6: Custo adicional POR_PEDIDO entra uma única vez por pedido
// ==============================================================================
test('M6: custo adicional POR_PEDIDO entra uma única vez por pedido', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pid = await criarPedidoBase({ quantidade: 5 }); // 5 tortas
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });

  // Fita Cetim é POR_PEDIDO: R$ 5.00 entra 1x independentemente de ter 5 tortas
  const margem = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  const fita = margem.componentes.find((c) => c.descricao.includes('Fita de Cetim'));
  assert.ok(fita);
  assert.equal(Number(fita.valor_total), 5.00);
  assert.equal(Number(fita.quantidade), 1);
});

// ==============================================================================
// M7: Desconto reduz receita líquida e margem sem alterar o custo atribuível
// ==============================================================================
test('M7: desconto reduz receita líquida e margem sem alterar o custo atribuível', async () => {
  await setIdentity(admin, ADMIN_UID);

  // Pedido A: Sem desconto
  const pidA = await criarPedidoBase({ subtotal: 150.00, desconto: 0.00 });
  const calcA = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pidA });

  // Pedido B: Com desconto de R$ 30.00 (receita líquida = R$ 120.00)
  const pidB = await criarPedidoBase({ subtotal: 150.00, desconto: 30.00 });
  const calcB = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pidB });

  // O custo atribuível direto de fabricação é exatamente o mesmo (insumos + MO + emb)
  assert.equal(Number(calcA.custo_ingredientes_real), Number(calcB.custo_ingredientes_real));
  assert.equal(Number(calcA.custo_mao_de_obra), Number(calcB.custo_mao_de_obra));
  assert.equal(Number(calcA.custo_embalagem), Number(calcB.custo_embalagem));

  // A receita líquida e a margem de contribuição no pedido B são reduzidas
  assert.equal(Number(calcB.receita_liquida), 120.00);
  assert.ok(Number(calcB.margem_contribuicao_valor) < Number(calcA.margem_contribuicao_valor));
});

// ==============================================================================
// M8: credito_cliente usado como meio de pagamento não altera a margem da venda
// ==============================================================================
test('M8: credito_cliente usado como meio de pagamento não altera a margem da venda', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pidPix = await criarPedidoBase({ subtotal: 150.00, metodoPagamento: 'pix' });
  const calcPix = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pidPix });

  const pidCredito = await criarPedidoBase({ subtotal: 150.00, metodoPagamento: 'outro' });
  await setIdentity(admin, 'service_role');
  await admin.query(
    `INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, status)
     VALUES ($1, 150.00, 'credito_cliente', 'aprovado')`,
    [pidCredito]
  );
  await setIdentity(admin, ADMIN_UID);

  const calcCredito = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pidCredito });

  // Margem e receita líquida são exatamente idênticas
  assert.equal(Number(calcPix.receita_liquida), Number(calcCredito.receita_liquida));
  assert.equal(Number(calcPix.margem_contribuicao_valor), Number(calcCredito.margem_contribuicao_valor));
});

// ==============================================================================
// M9: Estorno financeiro do pedido não reescreve o custo produtivo histórico
// ==============================================================================
test('M9: estorno financeiro do pedido não reescreve o custo produtivo histórico', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pid = await criarPedidoBase({ subtotal: 150.00 });
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  const custoHistorico = Number(calc.custo_atribuivel_total);

  // Simular estorno do pagamento
  await setIdentity(admin, 'service_role');
  await admin.query(
    `UPDATE public.pedidos SET status_financeiro = 'estornado' WHERE id = $1`,
    [pid]
  );

  await setIdentity(admin, ADMIN_UID);
  const margem = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  assert.equal(Number(margem.custo_atribuivel_total), custoHistorico);
});

// ==============================================================================
// M10: Pedido cancelado antes da produção é rejeitado por calcular_custo_real_pedido_admin
// ==============================================================================
test('M10: pedido cancelado antes da produção é rejeitado por calcular_custo_real_pedido_admin', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pidCancelado = await criarPedidoBase({
    statusOperacional: 'aguardando_producao',
    statusComercial: 'cancelado'
  });

  const res = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pidCancelado });
  assert.equal(res.success, false);
  assert.equal(res.code, 'ORDER_CANCELLED_BEFORE_PRODUCTION');
});

// ==============================================================================
// M11: Simulação de preço não altera o preço no catálogo de produtos (produtos.preco)
// ==============================================================================
test('M11: simulação de preço não altera o preço no catálogo de produtos (produtos.preco)', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: pre } = await admin.query('SELECT preco FROM public.produtos WHERE id = $1', [prodId]);
  const precoAntes = Number(pre[0].preco);

  await setIdentity(admin, ADMIN_UID);
  const sim = await rpc(admin, 'simular_preco_produto_admin', {
    p_produto_id: prodId,
    p_margem_alvo: 50.00
  });
  assert.equal(sim.success, true);
  assert.ok(Number(sim.preco_sugerido_margem_alvo) > 0);

  await setIdentity(admin, 'service_role');
  const { rows: pos } = await admin.query('SELECT preco FROM public.produtos WHERE id = $1', [prodId]);
  const precoDepois = Number(pos[0].preco);

  // Preço no catálogo permanece estritamente intocado!
  assert.equal(precoDepois, precoAntes);
});

// ==============================================================================
// M12: Alteração de preço continua restrita à governança da Frente A (apenas admin)
// ==============================================================================
test('M12: alteração de preço continua restrita à governança da Frente A (apenas admin)', async () => {
  const oper = await newClient(OPER_UID);

  // Operador tentando atualizar preço de produto diretamente no catálogo é bloqueado com 42501 (permission denied)
  await assert.rejects(
    async () => {
      await oper.query('UPDATE public.produtos SET preco = 250.00 WHERE id = $1', [prodId]);
    },
    (err) => err.code === '42501' || err.message.includes('permission denied')
  );

  await setIdentity(admin, 'service_role');
  const { rows: [p] } = await admin.query('SELECT preco FROM public.produtos WHERE id = $1', [prodId]);
  assert.equal(Number(p.preco), 150.00, 'Preço do produto não pode ser alterado por operador');

  await closeClient(oper);
});

// ==============================================================================
// M13: Operador não tem acesso a custos, margens e markups (PERMISSION_DENIED)
// ==============================================================================
test('M13: operador não tem acesso a custos, margens e markups (PERMISSION_DENIED)', async () => {
  const oper = await newClient(OPER_UID);
  const pid = await criarPedidoBase({ quantidade: 1 });

  const resSim = await rpc(oper, 'simular_preco_produto_admin', { p_produto_id: prodId });
  assert.equal(resSim.success, false);
  assert.equal(resSim.code, 'PERMISSION_DENIED');

  const resCalc = await rpc(oper, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  assert.equal(resCalc.success, false);
  assert.equal(resCalc.code, 'PERMISSION_DENIED');

  const resMargem = await rpc(oper, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  assert.equal(resMargem.success, false);
  assert.equal(resMargem.code, 'PERMISSION_DENIED');

  const resDash = await rpc(oper, 'obter_dashboard_margens_admin', {});
  assert.equal(resDash.success, false);
  assert.equal(resDash.code, 'PERMISSION_DENIED');

  await closeClient(oper);
});

// ==============================================================================
// M14: Anon e cliente comum não acessam RPCs industriais de custos e margens
// ==============================================================================
test('M14: anon e cliente comum não acessam RPCs industriais de custos e margens', async () => {
  const cli = await newClient(CLI_UID);
  const anon = await newClient('anon');

  const resCli = await rpc(cli, 'simular_preco_produto_admin', { p_produto_id: prodId });
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');

  await assert.rejects(
    async () => {
      await rpc(anon, 'simular_preco_produto_admin', { p_produto_id: prodId });
    },
    (err) => err.code === '42501' || err.message.includes('permission denied')
  );

  await closeClient(cli);
  await closeClient(anon);
});

// ==============================================================================
// M15: Margem do pedido reconcilia matematicamente componente por componente
// ==============================================================================
test('M15: margem do pedido reconcilia matematicamente componente por componente', async () => {
  await setIdentity(admin, ADMIN_UID);

  const pid = await criarPedidoBase({ subtotal: 150.00, desconto: 10.00 });
  const calc = await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  assert.equal(calc.success, true);

  const margem = await rpc(admin, 'obter_margem_pedido_admin', { p_pedido_id: pid });
  const comps = margem.componentes;

  // 1. Soma de cada componente individual
  const somaComponentes = comps.reduce((acc, c) => acc + Number(c.valor_total), 0);
  const custoTotal = Number(margem.custo_atribuivel_total);

  // Reconciliação dos componentes individuais com o total atribuível
  assert.equal(Math.round(somaComponentes * 100) / 100, custoTotal);

  // 2. Reconciliação do valor da margem
  const receitaLiq = Number(margem.receita_liquida);
  const margemValor = Number(margem.margem_contribuicao_valor);
  assert.equal(Math.round((receitaLiq - custoTotal) * 100) / 100, margemValor);

  // 3. Reconciliação da margem percentual
  const margemPct = Number(margem.margem_contribuicao_percentual);
  const margemCalculadaPct = Math.round(((margemValor / receitaLiq) * 100) * 100) / 100;
  assert.equal(margemPct, margemCalculadaPct);
});

// ==============================================================================
// M16: Cálculo de custo e margem possui efeito financeiro ZERO no caixa e no DRE
// ==============================================================================
test('M16: cálculo de custo e margem possui efeito financeiro ZERO no caixa e no DRE', async () => {
  await setIdentity(admin, 'service_role');
  const { rows: lancAntes } = await admin.query('SELECT COUNT(*) AS total FROM public.financeiro_lancamentos');
  const { rows: pagAntes } = await admin.query('SELECT COUNT(*) AS total FROM public.pedido_pagamentos');
  const countLancAntes = Number(lancAntes[0].total);
  const countPagAntes = Number(pagAntes[0].total);

  await setIdentity(admin, ADMIN_UID);
  const pid = await criarPedidoBase({ subtotal: 150.00 });
  await rpc(admin, 'calcular_custo_real_pedido_admin', { p_pedido_id: pid });
  await rpc(admin, 'simular_preco_produto_admin', { p_produto_id: prodId, p_margem_alvo: 45 });
  await rpc(admin, 'obter_dashboard_margens_admin', {});

  await setIdentity(admin, 'service_role');
  const { rows: lancDepois } = await admin.query('SELECT COUNT(*) AS total FROM public.financeiro_lancamentos');
  const { rows: pagDepois } = await admin.query('SELECT COUNT(*) AS total FROM public.pedido_pagamentos');
  const countLancDepois = Number(lancDepois[0].total);
  const countPagDepois = Number(pagDepois[0].total);

  // Zero alterações em lançamentos contábeis ou transações de pagamento!
  assert.equal(countLancDepois, countLancAntes);
  assert.equal(countPagDepois, countPagAntes);
});
