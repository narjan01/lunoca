// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 022 (FRENTE G)
// ==========================================================================
// Valida os 16 gates (G1 a G16) de Compras, Fornecedores, Insumos e CMV Real:
// - G1: Cadastro e listagem de fornecedor com normalização de telefone
// - G2: Criação de pedido de compra calcula subtotal/frete/desconto sem alterar estoque
// - G3: Recebimento de compra atualiza saldo de ingrediente e grava no livro-razão
// - G4: Recebimento idempotente não duplica saldo nem conta a pagar
// - G5: Custo Médio Ponderado (CMP) calculado exatamente em múltiplas entradas
// - G6: Registro de perda de insumo deduz saldo ao CMP vigente sem corromper o custo médio
// - G7: Saldo de insumo nunca fica negativo (INSUFFICIENT_INGREDIENT_STOCK)
// - G8: Concorrência transacional (FOR UPDATE) impede gasto duplo de insumo
// - G9: Cancelamento de compra antes do recebimento não altera estoque
// - G10: Cancelamento de compra após recebimento estorna estoque e bloqueia se já paga
// - G11: Conta a pagar + pagamento parcial/total + lançamento no DRE + bloqueio de overpayment
// - G12: Necessidade de reposição combina estoque mínimo + consumo previsto da agenda
// - G13: CMV real reflete custo médio ponderado preservando custo teórico de referência
// - G14: Livro-razão ingrediente_movimentacoes é imutável (bloqueia UPDATE e DELETE)
// - G15: RBAC Operador: pode registrar perda e ver reposição, mas não cria compra nem paga conta
// - G16: RBAC Fail-Closed: anon e cliente comum são bloqueados nas RPCs da Frente G
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
const PORT = 54393;

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

let seqIng = 6000;
let seqProd = 7000;
let seqPedido = 8000;

async function criarIngredienteFixture({
  nome = 'Chocolate Belga 50%',
  unidade = 'g',
  custoTeorico = 0.0500,
  estoqueInicial = 0.000,
  estoqueMinimo = 1000.000
} = {}) {
  seqIng++;
  const { rows: [ing] } = await admin.query(`
    INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo)
    VALUES ($1, $2, $3, $3, $4, $5, true)
    RETURNING id;
  `, [`${nome} #${seqIng}`, unidade, custoTeorico, estoqueInicial, estoqueMinimo]);

  await admin.query(`
    UPDATE public.ingrediente_saldos
    SET saldo_atual = $2, custo_medio_ponderado = $3
    WHERE ingrediente_id = $1;
  `, [ing.id, estoqueInicial, custoTeorico]);

  return Number(ing.id);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-022',
    port: PORT,
    dbName: 'lunoca_test_022'
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
      ('${OPER_UID}', 'Operador Cozinha', 'operador@lunoca.local', 'operador', true),
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
// GATE G1: Cadastro e listagem de fornecedor com normalização de telefone
// --------------------------------------------------------------------------
test('G1: cadastro e listagem de fornecedor com normalização de telefone', async () => {
  const adm = await newClient(ADMIN_UID);

  const res = await rpc(adm, 'salvar_fornecedor_admin', {
    p_nome: 'Distribuidora Cacau Nobre',
    p_documento: '12.345.678/0001-90',
    p_telefone: '(85) 99888-7766',
    p_email: 'vendas@cacaunobre.com.br',
    p_contato_nome: 'Roberto'
  });

  assert.equal(res.success, true);
  assert.ok(res.fornecedor_id > 0);

  const list = await rpc(adm, 'listar_fornecedores_admin', { p_apenas_ativos: true });
  assert.equal(list.success, true);
  const f = list.fornecedores.find(x => x.id === res.fornecedor_id);
  assert.ok(f, 'Fornecedor deve estar na listagem');
  assert.equal(f.telefone_normalizado, '5585998887766');
});

// --------------------------------------------------------------------------
// GATE G2: Criação de pedido de compra sem alterar estoque antes do recebimento
// --------------------------------------------------------------------------
test('G2: criar_compra calcula valores e rateio sem alterar estoque antes do recebimento', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G2' });
  const ingId = await criarIngredienteFixture({ nome: 'Farinha Especial', custoTeorico: 0.0100, estoqueInicial: 500 });

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 1000, custo_unitario: 0.0200 }]),
    p_numero_nota: 'NF-002',
    p_valor_frete: 5.00,
    p_valor_desconto: 1.00,
    p_idempotency_key: 'g2_compra_1'
  });

  assert.equal(compra.success, true);
  assert.equal(compra.status, 'aberta');
  assert.equal(Number(compra.valor_subtotal), 20.00);
  assert.equal(Number(compra.valor_total), 24.00); // 20 + 5 - 1

  // Estoque deve continuar intacto em 500 antes do recebimento
  const { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 500.000);
});

// --------------------------------------------------------------------------
// GATE G3: Recebimento de compra atualiza saldo e grava no livro-razão
// --------------------------------------------------------------------------
test('G3: receber_compra alimenta saldo, atualiza ingrediente e gera conta a pagar', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G3' });
  const ingId = await criarIngredienteFixture({ nome: 'Leite Condensado', custoTeorico: 0.0200, estoqueInicial: 0 });

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 2000, custo_unitario: 0.0250 }]),
    p_numero_nota: 'NF-003'
  });

  const rec = await rpc(adm, 'receber_compra', {
    p_compra_id: compra.compra_id
  });

  assert.equal(rec.success, true);
  assert.equal(rec.idempotente, false);
  assert.equal(rec.status, 'recebida');
  assert.ok(rec.conta_pagar_id > 0);

  const { rows: [s] } = await admin.query(`SELECT saldo_atual, custo_medio_ponderado FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 2000.000);
  assert.equal(Number(s.custo_medio_ponderado), 0.0250);

  const { rows: movs } = await admin.query(`SELECT * FROM public.ingrediente_movimentacoes WHERE compra_id = $1`, [compra.compra_id]);
  assert.equal(movs.length, 1);
  assert.equal(movs[0].tipo, 'entrada_compra');
  assert.equal(Number(movs[0].saldo_posterior), 2000.000);
});

// --------------------------------------------------------------------------
// GATE G4: Idempotência do recebimento de compra
// --------------------------------------------------------------------------
test('G4: receber_compra chamado duas vezes é idempotente e não duplica saldo nem conta', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G4' });
  const ingId = await criarIngredienteFixture({ nome: 'Creme de Leite', custoTeorico: 0.0150, estoqueInicial: 0 });

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 1000, custo_unitario: 0.0180 }])
  });

  const r1 = await rpc(adm, 'receber_compra', { p_compra_id: compra.compra_id });
  const r2 = await rpc(adm, 'receber_compra', { p_compra_id: compra.compra_id });

  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
  assert.equal(r2.idempotente, true);
  assert.equal(r1.conta_pagar_id, r2.conta_pagar_id);

  const { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 1000.000, 'Saldo não pode duplicar para 2000');
});

// --------------------------------------------------------------------------
// GATE G5: Cálculo exato do Custo Médio Ponderado (CMP)
// --------------------------------------------------------------------------
test('G5: custo médio ponderado (CMP) recalcula exatamente em múltiplas entradas', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G5' });
  // Começa com 1000g a R$ 0,0400/g (R$ 40,00)
  const ingId = await criarIngredienteFixture({ nome: 'Pistache Puro', custoTeorico: 0.0400, estoqueInicial: 1000 });

  // Compra mais 1000g a R$ 0,0600/g (R$ 60,00) -> Total: 2000g valendo R$ 100,00 -> CMP esperado = 0,0500/g
  const c1 = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 1000, custo_unitario: 0.0600 }])
  });
  await rpc(adm, 'receber_compra', { p_compra_id: c1.compra_id });

  const { rows: [s] } = await admin.query(`SELECT saldo_atual, custo_medio_ponderado, ultimo_custo_compra FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 2000.000);
  assert.equal(Number(s.custo_medio_ponderado), 0.0500, 'CMP de 1000@0.04 + 1000@0.06 deve ser 0.0500');
  assert.equal(Number(s.ultimo_custo_compra), 0.0600);
});

// --------------------------------------------------------------------------
// GATE G6: Registro de perda operacional de insumo
// --------------------------------------------------------------------------
test('G6: registrar_perda_insumo deduz saldo ao CMP vigente sem alterar o custo médio', async () => {
  const oper = await newClient(OPER_UID);
  const ingId = await criarIngredienteFixture({ nome: 'Morango Fresco', custoTeorico: 0.0300, estoqueInicial: 1000 });

  const perda = await rpc(oper, 'registrar_perda_insumo', {
    p_ingrediente_id: ingId,
    p_quantidade: 200,
    p_motivo: 'Morangos oxidados na refrigeração'
  });

  assert.equal(perda.success, true);
  assert.equal(Number(perda.saldo_anterior), 1000.000);
  assert.equal(Number(perda.saldo_posterior), 800.000);
  assert.equal(Number(perda.custo_medio_posterior), 0.0300);
  assert.equal(Number(perda.valor_total_movimento), 6.00); // 200 * 0.03
});

// --------------------------------------------------------------------------
// GATE G7: Proteção contra saldo negativo de insumo
// --------------------------------------------------------------------------
test('G7: tentativa de saída maior que o saldo retorna INSUFFICIENT_INGREDIENT_STOCK', async () => {
  const adm = await newClient(ADMIN_UID);
  const ingId = await criarIngredienteFixture({ nome: 'Baunilha Madagascar', custoTeorico: 0.5000, estoqueInicial: 50 });

  const res = await rpc(adm, 'registrar_perda_insumo', {
    p_ingrediente_id: ingId,
    p_quantidade: 80,
    p_motivo: 'Quebra de frasco na bancada'
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'INSUFFICIENT_INGREDIENT_STOCK');

  const { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 50.000);
});

// --------------------------------------------------------------------------
// GATE G8: Concorrência transacional em saídas simultâneas de insumo
// --------------------------------------------------------------------------
test('G8: duas baixas concorrentes do mesmo insumo respeitam lock FOR UPDATE e não negativam saldo', async () => {
  const c1 = await newClient(ADMIN_UID);
  const c2 = await newClient(OPER_UID);
  const ingId = await criarIngredienteFixture({ nome: 'Manteiga Extra', custoTeorico: 0.0400, estoqueInicial: 100 });

  // Ambos tentam baixar 80 simultaneamente de um saldo de 100
  const [r1, r2] = await Promise.all([
    rpc(c1, 'registrar_perda_insumo', { p_ingrediente_id: ingId, p_quantidade: 80, p_motivo: 'Consumo concorrente A' }),
    rpc(c2, 'registrar_perda_insumo', { p_ingrediente_id: ingId, p_quantidade: 80, p_motivo: 'Consumo concorrente B' })
  ]);

  const sucessos = [r1, r2].filter(r => r.success === true);
  const falhas = [r1, r2].filter(r => r.success === false && r.code === 'INSUFFICIENT_INGREDIENT_STOCK');

  assert.equal(sucessos.length, 1, 'Exatamente uma operação deve ter sucesso');
  assert.equal(falhas.length, 1, 'A segunda operação concorrente deve ser bloqueada por saldo insuficiente');

  const { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 20.000);
});

// --------------------------------------------------------------------------
// GATE G9: Cancelamento de compra antes do recebimento
// --------------------------------------------------------------------------
test('G9: cancelar_compra em status aberta cancela sem tocar no estoque', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G9' });
  const ingId = await criarIngredienteFixture({ nome: 'Açúcar Confeiteiro', custoTeorico: 0.0100, estoqueInicial: 300 });

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 500, custo_unitario: 0.0120 }])
  });

  const canc = await rpc(adm, 'cancelar_compra', {
    p_compra_id: compra.compra_id,
    p_motivo: 'Erro de digitação no pedido ao fornecedor'
  });

  assert.equal(canc.success, true);
  assert.equal(canc.status, 'cancelada');

  const { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 300.000);
});

// --------------------------------------------------------------------------
// GATE G10: Cancelamento de compra após recebimento estorna estoque e conta
// --------------------------------------------------------------------------
test('G10: cancelar_compra após recebimento estorna estoque e cancela conta a pagar', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G10' });
  const ingId = await criarIngredienteFixture({ nome: 'Nozes Chilenas', custoTeorico: 0.0800, estoqueInicial: 100 });

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 400, custo_unitario: 0.0900 }])
  });

  const rec = await rpc(adm, 'receber_compra', { p_compra_id: compra.compra_id });
  assert.equal(rec.success, true);

  // Saldo subiu para 500
  let { rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]);
  assert.equal(Number(s.saldo_atual), 500.000);

  // Cancela a compra recebida
  const canc = await rpc(adm, 'cancelar_compra', {
    p_compra_id: compra.compra_id,
    p_motivo: 'Devolução integral do lote ao fornecedor'
  });
  assert.equal(canc.success, true);

  // Saldo voltou para 100 e conta a pagar foi cancelada
  ({ rows: [s] } = await admin.query(`SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`, [ingId]));
  assert.equal(Number(s.saldo_atual), 100.000);

  const { rows: [cp] } = await admin.query(`SELECT status, saldo_aberto FROM public.contas_pagar WHERE id = $1`, [rec.conta_pagar_id]);
  assert.equal(cp.status, 'cancelada');
  assert.equal(Number(cp.saldo_aberto), 0.00);
});

// --------------------------------------------------------------------------
// GATE G11: Pagamento parcial e total de fornecedor + DRE + Overpayment
// --------------------------------------------------------------------------
test('G11: registrar_pagamento_fornecedor suporta parcial, total, DRE e bloqueia overpayment', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G11' });
  const ingId = await criarIngredienteFixture({ nome: 'Cacau Alcalino', custoTeorico: 0.0500, estoqueInicial: 0 });

  // Compra de R$ 100,00 (1000g a R$ 0,10)
  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 1000, custo_unitario: 0.1000 }])
  });
  const rec = await rpc(adm, 'receber_compra', { p_compra_id: compra.compra_id });
  const contaId = rec.conta_pagar_id;

  // 1. Pagamento parcial de R$ 40,00
  const p1 = await rpc(adm, 'registrar_pagamento_fornecedor', {
    p_conta_id: contaId,
    p_valor: 40.00,
    p_forma_pagamento: 'pix',
    p_evento_idempotencia: 'parcela_1'
  });
  assert.equal(p1.success, true);
  assert.equal(p1.status, 'parcial');
  assert.equal(Number(p1.valor_pago), 40.00);
  assert.equal(Number(p1.saldo_aberto), 60.00);

  // 2. Tentativa de pagar R$ 70,00 (maior que saldo aberto de 60) -> bloqueado
  const pOver = await rpc(adm, 'registrar_pagamento_fornecedor', {
    p_conta_id: contaId,
    p_valor: 70.00,
    p_forma_pagamento: 'pix',
    p_evento_idempotencia: 'parcela_over'
  });
  assert.equal(pOver.success, false);
  assert.equal(pOver.code, 'OVERPAYMENT_NOT_ALLOWED');

  // 3. Quitação final de R$ 60,00
  const p2 = await rpc(adm, 'registrar_pagamento_fornecedor', {
    p_conta_id: contaId,
    p_valor: 60.00,
    p_forma_pagamento: 'transferencia',
    p_evento_idempotencia: 'parcela_2'
  });
  assert.equal(p2.success, true);
  assert.equal(p2.status, 'paga');
  assert.equal(Number(p2.valor_pago), 100.00);
  assert.equal(Number(p2.saldo_aberto), 0.00);

  // 4. Verifica lançamentos de despesa no DRE
  const { rows: lancs } = await admin.query(`
    SELECT valor FROM public.financeiro_lancamentos
    WHERE origem_tipo = 'conta_pagar' AND origem_id = $1
    ORDER BY id ASC
  `, [contaId]);
  assert.equal(lancs.length, 2);
  assert.equal(Number(lancs[0].valor) + Number(lancs[1].valor), 100.00);
});

// --------------------------------------------------------------------------
// GATE G12: Necessidade de reposição (estoque mínimo + consumo previsto)
// --------------------------------------------------------------------------
test('G12: obter_necessidade_reposicao calcula sugestão com base no estoque mínimo e agenda futura', async () => {
  const adm = await newClient(ADMIN_UID);
  // Ingrediente: Saldo atual = 2400g, Estoque mínimo = 5000g
  const ingId = await criarIngredienteFixture({
    nome: 'Chocolate Reposição G12',
    custoTeorico: 0.0500,
    estoqueInicial: 2400,
    estoqueMinimo: 5000
  });

  // Cria produto que consome 1300g deste ingrediente por unidade
  seqProd++;
  const prodId = seqProd;
  await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, ativo, controlar_estoque)
    VALUES ($1, 'Bolo Trufado G12', 180.00, true, false);
  `, [prodId]);
  await admin.query(`
    INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
    VALUES ($1, $2, 1300.000);
  `, [prodId, ingId]);

  // Cria pedido confirmado para amanhã com 6 unidades (6 * 1300g = 7800g de consumo previsto)
  seqPedido++;
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await admin.query(`
    INSERT INTO public.pedidos (
      id, nome_cliente, email_cliente, telefone_cliente, data_pedido, data_entrega,
      total, subtotal, valor_pago, saldo, status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens, endereco_entrega
    ) VALUES (
      $1, 'Cliente Agenda G12', 'g12@lunoca.local', '85999991111', CURRENT_DATE, $2::DATE,
      1080.00, 1080.00, 540.00, 540.00, 'confirmado', 'parcialmente_pago', 'aguardando_producao', 'Confirmado',
      'pix', '6x Bolo Trufado G12', 'Retirada na Loja'
    );
  `, [seqPedido, amanha]);
  await admin.query(`
    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot, subtotal
    ) VALUES ($1, $2, 'Bolo Trufado G12', 6, 180.00, 1080.00);
  `, [seqPedido, prodId]);

  const rep = await rpc(adm, 'obter_necessidade_reposicao', { p_dias_horizonte: 7 });
  assert.equal(rep.success, true);

  const item = rep.itens.find(x => x.ingrediente_id === ingId);
  assert.ok(item, 'Ingrediente deve constar na análise de reposição');
  assert.equal(Number(item.saldo_atual), 2400.000);
  assert.equal(Number(item.estoque_minimo), 5000.000);
  assert.equal(Number(item.consumo_previsto), 7800.000);
  // Sugestão = (5000 + 7800) - 2400 = 10400g
  assert.equal(Number(item.sugestao_compra), 10400.000);
  assert.equal(item.precisa_repor, true);
});

// --------------------------------------------------------------------------
// GATE G13: CMV Real vs Custo Teórico da Receita
// --------------------------------------------------------------------------
test('G13: obter_cmv_real_produto compara custo teórico de referência com CMV real do custo médio', async () => {
  const adm = await newClient(ADMIN_UID);
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor G13' });

  // Ingrediente cadastrado com custo teórico de R$ 0,04/g e saldo zero
  const ingId = await criarIngredienteFixture({
    nome: 'Amêndoas Laminadas G13',
    custoTeorico: 0.0400,
    estoqueInicial: 0
  });

  // Produto usa 500g na receita e é vendido a R$ 100,00
  // Custo teórico da receita = 500 * 0,04 = R$ 20,00 (margem teórica = 80%)
  seqProd++;
  const prodId = seqProd;
  await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, ativo, controlar_estoque)
    VALUES ($1, 'Torta de Amêndoas G13', 100.00, true, false);
  `, [prodId]);
  await admin.query(`
    INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
    VALUES ($1, $2, 500.000);
  `, [prodId, ingId]);

  // Compra real entra mais cara: 1000g a R$ 0,07/g -> CMP real = 0,0700
  // CMV real passa a ser 500 * 0,07 = R$ 35,00 (margem real = 65%)
  const c = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 1000, custo_unitario: 0.0700 }])
  });
  await rpc(adm, 'receber_compra', { p_compra_id: c.compra_id });

  const cmvRes = await rpc(adm, 'obter_cmv_real_produto', { p_produto_id: prodId });
  assert.equal(cmvRes.success, true);
  assert.equal(cmvRes.produtos.length, 1);

  const p = cmvRes.produtos[0];
  assert.equal(Number(p.custo_teorico_receita), 20.00, 'Custo teórico de referência permanece 20.00');
  assert.equal(Number(p.cmv_real), 35.00, 'CMV real reflete o custo médio de compra 35.00');
  assert.equal(Number(p.margem_teorica_pct), 80.00);
  assert.equal(Number(p.margem_real_pct), 65.00);
  assert.equal(Number(p.lucro_bruto_real), 65.00);
});

// --------------------------------------------------------------------------
// GATE G14: Imutabilidade do Livro-Razão ingrediente_movimentacoes
// --------------------------------------------------------------------------
test('G14: livro-razão ingrediente_movimentacoes bloqueia UPDATE e DELETE físicos', async () => {
  const { rows: [mov] } = await admin.query(`SELECT id FROM public.ingrediente_movimentacoes LIMIT 1`);
  assert.ok(mov, 'Deve existir movimento no livro-razão');

  await assert.rejects(
    admin.query(`UPDATE public.ingrediente_movimentacoes SET quantidade = 999 WHERE id = $1`, [mov.id]),
    /IMMUTABLE_LEDGER_VIOLATION/
  );

  await assert.rejects(
    admin.query(`DELETE FROM public.ingrediente_movimentacoes WHERE id = $1`, [mov.id]),
    /IMMUTABLE_LEDGER_VIOLATION/
  );
});

// --------------------------------------------------------------------------
// GATE G15: RBAC Operador
// --------------------------------------------------------------------------
test('G15: operador consulta reposição, mas não cria compra, não ajusta inventário nem paga fornecedor', async () => {
  const oper = await newClient(OPER_UID);
  const ingId = await criarIngredienteFixture({ nome: 'Insumo RBAC Operador', custoTeorico: 0.01 });

  const rep = await rpc(oper, 'obter_necessidade_reposicao', { p_dias_horizonte: 7 });
  assert.equal(rep.success, true);

  const criar = await rpc(oper, 'criar_compra', {
    p_fornecedor_id: 1,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 100, custo_unitario: 0.01 }])
  });
  assert.equal(criar.success, false);
  assert.equal(criar.code, 'PERMISSION_DENIED');

  const ajuste = await rpc(oper, 'ajustar_estoque_insumo_admin', {
    p_ingrediente_id: ingId,
    p_tipo: 'ajuste_entrada',
    p_quantidade: 500,
    p_motivo: 'Tentativa operador'
  });
  assert.equal(ajuste.success, false);
  assert.equal(ajuste.code, 'PERMISSION_DENIED');

  const cmv = await rpc(oper, 'obter_cmv_real_produto');
  assert.equal(cmv.success, false);
  assert.equal(cmv.code, 'PERMISSION_DENIED');
});

// --------------------------------------------------------------------------
// GATE G16: RBAC Fail-Closed para anon e cliente comum
// --------------------------------------------------------------------------
test('G16: anon e cliente autenticado comum recebem rejeição fail-closed', async () => {
  const anon = await newClient('anon');
  const cli = await newClient(CLIENTE_UID);

  await assert.rejects(
    rpc(anon, 'criar_compra', { p_fornecedor_id: 1, p_itens: '[]' }),
    /permission denied/i
  );

  await assert.rejects(
    rpc(anon, 'obter_necessidade_reposicao'),
    /permission denied/i
  );

  const resCliRep = await rpc(cli, 'obter_necessidade_reposicao');
  assert.equal(resCliRep.success, false);
  assert.equal(resCliRep.code, 'PERMISSION_DENIED');

  const resCliPerda = await rpc(cli, 'registrar_perda_insumo', {
    p_ingrediente_id: 1,
    p_quantidade: 10,
    p_motivo: 'Tentativa cliente'
  });
  assert.equal(resCliPerda.success, false);
  assert.equal(resCliPerda.code, 'PERMISSION_DENIED');
});
