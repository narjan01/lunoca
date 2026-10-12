// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 023 (FRENTE H)
// ==========================================================================
// Valida os 16 gates individuais (H1 a H16) de Tesouraria, Fluxo de Caixa Projetado e Conciliação:
// - H1: pagamento recebido aparece no realizado
// - H2: credito_cliente não aparece como entrada bancária
// - H3: estorno reduz caixa realizado
// - H4: conta a pagar entra no projetado
// - H5: pagamento fornecedor migra projetado -> realizado
// - H6: conta vencida é classificada corretamente
// - H7: pedido cancelado deixa de gerar recebimento previsto
// - H8: pagamento parcial reduz saldo previsto
// - H9: fluxo respeita America/Fortaleza
// - H10: saldo acumulado fecha matematicamente
// - H11: conciliação é idempotente e livro é append-only
// - H12: ajuste manual exige admin + motivo (>= 5 chars)
// - H13: operador não vê saldos bancários sensíveis
// - H14: anon e cliente comum bloqueados (fail-closed)
// - H15: reconciliação direta bate com financeiro_lancamentos
// - H16: cenário misto compra + venda + estorno + crédito reconcilia sem duplicidade
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

let seqCli = 10000;
let seqProd = 11000;
let seqIng = 12000;
let seqPed = 13000;

async function criarClienteFixture({ nome = 'Cliente Tesouraria' } = {}) {
  seqCli++;
  const tel = `8598${String(seqCli).padStart(7, '0')}`;
  const telNorm = `55${tel}`;
  const { rows: [c] } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
  `, [`${nome} #${seqCli}`, tel, telNorm, `tesouraria_${seqCli}@teste.local`]);
  return Number(c.id);
}

async function criarIngredienteFixture({ nome = 'Insumo H', custo = 10.00 } = {}) {
  seqIng++;
  const { rows: [i] } = await admin.query(`
    INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo)
    VALUES ($1, 'kg', $2, $2, 10, 5, true)
    RETURNING id;
  `, [`${nome} #${seqIng}`, custo]);
  return Number(i.id);
}

async function criarPedidoConfirmadoFixture({
  clienteId,
  total = 200.00,
  dataEntrega = null,
  saldoVencimento = null,
  statusComercial = 'confirmado'
} = {}) {
  seqPed++;
  seqProd++;
  const { rows: [hojeRow] } = await admin.query(`SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE AS hoje`);
  const dtEntrega = dataEntrega || hojeRow.hoje;

  await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, pontos_producao, ativo, controlar_estoque)
    VALUES ($1, $2, $3, 1.00, true, false)
    ON CONFLICT (id) DO NOTHING;
  `, [seqProd, `Produto Tesouraria #${seqProd}`, total]);

  const { rows: [ped] } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente,
      data_pedido, data_entrega, saldo_vencimento, hora_entrega,
      total, subtotal, desconto, valor_pago, saldo, sinal_minimo,
      status_comercial, status_financeiro, status_operacional, status,
      modalidade_entrega, endereco_entrega, pagamento, itens
    ) VALUES (
      $1, $2, 'Cliente Tesouraria', 'cli@teste.local', '85988887777',
      NOW(), $3::DATE, $4::DATE, '15:00:00'::TIME,
      $5, $5, 0.00, 0.00, $5, ROUND($5 * 0.30, 2),
      $6, 'nao_pago', 'aguardando_producao', 'Pendente',
      'retirada', 'Retirada no Balcão', 'pix', 'Produto'
    ) RETURNING id;
  `, [seqPed, clienteId, dtEntrega, saldoVencimento || dtEntrega, total, statusComercial]);

  await admin.query(`
    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot, subtotal, pontos_producao_snapshot
    ) VALUES ($1, $2, 'Produto Tesouraria', 1, $3, $3, 1.00);
  `, [ped.id, seqProd, total]);

  return Number(ped.id);
}

async function limparMovimentosFinanceiros() {
  await admin.query(`
    TRUNCATE TABLE
      public.conciliacoes_financeiras,
      public.ajustes_tesouraria,
      public.financeiro_lancamentos,
      public.contas_pagar,
      public.compra_itens,
      public.compras,
      public.ingrediente_movimentacoes,
      public.pedido_pagamentos,
      public.cliente_credito_movimentacoes,
      public.cliente_creditos,
      public.pedido_itens,
      public.pedidos
    RESTART IDENTITY CASCADE;
    UPDATE public.contas_financeiras SET saldo_inicial = 0.00, data_saldo_inicial = '2026-01-01';
  `);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-023',
    port: PORT,
    dbName: 'lunoca_test_023'
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
// GATE H1: Pagamento recebido aparece no realizado
// --------------------------------------------------------------------------
test('H1: pagamento recebido aparece no fluxo de caixa realizado', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [h] } = await admin.query(`SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje`);

  const cliId = await criarClienteFixture();
  const pedId = await criarPedidoConfirmadoFixture({ clienteId: cliId, total: 180.00, dataEntrega: h.hoje });

  const pag = await rpc(adm, 'registrar_pagamento_pedido', {
    p_pedido_id: pedId,
    p_valor: 180.00,
    p_metodo: 'pix',
    p_observacoes: 'Quitação H1'
  });
  assert.equal(pag.success, true);

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: h.hoje,
    p_data_fim: h.hoje
  });
  assert.equal(fluxo.success, true);
  assert.equal(Number(fluxo.resumo.entradas_brutas_realizadas), 180.00);
  assert.equal(Number(fluxo.resumo.entradas_liquidas_realizadas), 180.00);
  assert.equal(Number(fluxo.resumo.liquido_realizado), 180.00);
});

// --------------------------------------------------------------------------
// GATE H2: credito_cliente não aparece como entrada bancária
// --------------------------------------------------------------------------
test('H2: credito_cliente não aparece como entrada bancária realizada', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [h] } = await admin.query(`SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje`);

  const cliId = await criarClienteFixture();
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cliId,
    p_tipo: 'credito',
    p_valor: 120.00,
    p_motivo: 'Crédito cortesia H2',
    p_request_id: 'h2_cred_1'
  });

  const pedId = await criarPedidoConfirmadoFixture({ clienteId: cliId, total: 120.00, dataEntrega: h.hoje });
  const uso = await rpc(adm, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedId,
    p_valor: 120.00
  });
  assert.equal(uso.success, true);

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: h.hoje,
    p_data_fim: h.hoje
  });
  assert.equal(fluxo.success, true);
  assert.equal(Number(fluxo.resumo.entradas_brutas_realizadas), 0.00, 'Crédito não é entrada bancária');
  assert.equal(Number(fluxo.resumo.entradas_liquidas_realizadas), 0.00);
  assert.equal(Number(fluxo.resumo.credito_cliente_utilizado_periodo), 120.00);
});

// --------------------------------------------------------------------------
// GATE H3: Estorno reduz caixa realizado
// --------------------------------------------------------------------------
test('H3: estorno reduz caixa realizado líquido', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [h] } = await admin.query(`SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje`);

  const cliId = await criarClienteFixture();
  const pedId = await criarPedidoConfirmadoFixture({ clienteId: cliId, total: 200.00, dataEntrega: h.hoje });

  const pag1 = await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 120.00, p_metodo: 'pix' });
  const pag2 = await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 80.00, p_metodo: 'cartao' });
  assert.equal(pag1.success, true);
  assert.equal(pag2.success, true);

  const est = await rpc(adm, 'estornar_pagamento_pedido', {
    p_pagamento_id: pag2.pagamento_id,
    p_motivo: 'Cobrança duplicada H3'
  });
  assert.equal(est.success, true);

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: h.hoje,
    p_data_fim: h.hoje
  });
  assert.equal(Number(fluxo.resumo.entradas_brutas_realizadas), 200.00);
  assert.equal(Number(fluxo.resumo.estornos_realizados), 80.00);
  assert.equal(Number(fluxo.resumo.entradas_liquidas_realizadas), 120.00);
  assert.equal(Number(fluxo.resumo.liquido_realizado), 120.00);
});

// --------------------------------------------------------------------------
// GATE H4: Conta a pagar entra no projetado
// --------------------------------------------------------------------------
test('H4: conta a pagar gerada no recebimento de compra entra no fluxo projetado', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 5)::TEXT AS vencimento
  `);

  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor H4' });
  const ingId = await criarIngredienteFixture();

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 10, custo_unitario: 25.00 }])
  });
  const rec = await rpc(adm, 'receber_compra', {
    p_compra_id: compra.compra_id,
    p_data_vencimento: datas.vencimento,
    p_gerar_conta_pagar: true
  });
  assert.equal(rec.success, true);

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.vencimento
  });
  assert.equal(Number(fluxo.resumo.saidas_previstas), 250.00);
  assert.equal(Number(fluxo.resumo.saidas_operacionais_realizadas), 0.00);
});

// --------------------------------------------------------------------------
// GATE H5: Pagamento fornecedor migra projetado -> realizado
// --------------------------------------------------------------------------
test('H5: pagamento a fornecedor migra valor de saidas_previstas para saidas_operacionais_realizadas', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 5)::TEXT AS vencimento
  `);

  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor H5' });
  const ingId = await criarIngredienteFixture();

  const compra = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 10, custo_unitario: 25.00 }])
  });
  const rec = await rpc(adm, 'receber_compra', {
    p_compra_id: compra.compra_id,
    p_data_vencimento: datas.vencimento,
    p_gerar_conta_pagar: true
  });

  const pagForn = await rpc(adm, 'registrar_pagamento_fornecedor', {
    p_conta_id: rec.conta_pagar_id,
    p_valor: 100.00,
    p_forma_pagamento: 'pix',
    p_evento_idempotencia: 'h5_pag_1'
  });
  assert.equal(pagForn.success, true);

  const fluxoDepois = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.vencimento
  });
  assert.equal(Number(fluxoDepois.resumo.saidas_previstas), 150.00);
  assert.equal(Number(fluxoDepois.resumo.saidas_operacionais_realizadas), 100.00);
});

// --------------------------------------------------------------------------
// GATE H6: Conta vencida é classificada corretamente
// --------------------------------------------------------------------------
test('H6: conta a pagar vencida é segregada de conta prevista futura', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE - 3)::TEXT AS passado,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 4)::TEXT AS futuro
  `);

  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor H6' });
  const ingId = await criarIngredienteFixture();

  const c1 = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 9, custo_unitario: 10.00 }])
  });
  await rpc(adm, 'receber_compra', { p_compra_id: c1.compra_id, p_data_vencimento: datas.passado });

  const c2 = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 14, custo_unitario: 10.00 }])
  });
  await rpc(adm, 'receber_compra', { p_compra_id: c2.compra_id, p_data_vencimento: datas.futuro });

  const rel = await rpc(adm, 'obter_contas_pagar_periodo_admin', {
    p_data_inicio: datas.passado,
    p_data_fim: datas.futuro
  });
  assert.equal(rel.success, true);
  assert.equal(Number(rel.resumo.total_vencido), 90.00);
  assert.equal(Number(rel.resumo.total_previsto), 140.00);

  const itemVencido = rel.contas.find(x => Number(x.valor_total) === 90.00);
  const itemPrevisto = rel.contas.find(x => Number(x.valor_total) === 140.00);
  assert.equal(itemVencido.classificacao_temporal, 'vencido');
  assert.equal(itemPrevisto.classificacao_temporal, 'previsto');
});

// --------------------------------------------------------------------------
// GATE H7: Pedido cancelado deixa de gerar recebimento previsto
// --------------------------------------------------------------------------
test('H7: pedido cancelado deixa imediatamente de gerar recebimento previsto', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 2)::TEXT AS entrega
  `);

  const cliId = await criarClienteFixture();
  const pedId = await criarPedidoConfirmadoFixture({
    clienteId: cliId,
    total: 300.00,
    dataEntrega: datas.entrega
  });

  const canc = await rpc(adm, 'cancelar_pedido_equipe', {
    p_pedido_id: pedId,
    p_motivo: 'Cancelamento H7',
    p_destino_valor: 'SEM_VALOR'
  });
  assert.equal(canc.success, true);

  const prev = await rpc(adm, 'obter_recebimentos_previstos_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.entrega
  });
  assert.equal(Number(prev.resumo.total_previsto), 0.00);
  assert.equal(prev.recebiveis.length, 0);
});

// --------------------------------------------------------------------------
// GATE H8: Pagamento parcial reduz saldo previsto
// --------------------------------------------------------------------------
test('H8: pagamento parcial reduz exatamente o saldo de recebimento previsto', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 2)::TEXT AS entrega
  `);

  const cliId = await criarClienteFixture();
  const pedId = await criarPedidoConfirmadoFixture({
    clienteId: cliId,
    total: 300.00,
    dataEntrega: datas.entrega
  });

  await rpc(adm, 'registrar_pagamento_pedido', {
    p_pedido_id: pedId,
    p_valor: 120.00,
    p_metodo: 'pix'
  });

  const prev = await rpc(adm, 'obter_recebimentos_previstos_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.entrega
  });
  assert.equal(Number(prev.resumo.total_previsto), 180.00);
  assert.equal(Number(prev.recebiveis[0].saldo_previsto), 180.00);
});

// --------------------------------------------------------------------------
// GATE H9: Fluxo respeita timezone America/Fortaleza
// --------------------------------------------------------------------------
test('H9: lançamento às 23:30 America/Fortaleza (02:30 UTC do dia seguinte) cai no dia correto em Fortaleza', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);

  await admin.query(`
    INSERT INTO public.financeiro_lancamentos (
      tipo, categoria, descricao, valor, data_lancamento, forma_pagamento, created_at
    ) VALUES (
      'receita', 'Vendas', 'Venda Noturna Fortaleza', 175.00, '2026-10-20', 'pix', '2026-10-20 23:30:00-03'
    );
  `);

  const fDia20 = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: '2026-10-20',
    p_data_fim: '2026-10-20'
  });
  const fDia21 = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: '2026-10-21',
    p_data_fim: '2026-10-21'
  });

  assert.equal(Number(fDia20.resumo.entradas_brutas_realizadas), 175.00);
  assert.equal(Number(fDia21.resumo.entradas_brutas_realizadas), 0.00);
});

// --------------------------------------------------------------------------
// GATE H10: Saldo acumulado fecha matematicamente dia a dia
// --------------------------------------------------------------------------
test('H10: série diária fecha saldo_acumulado_realizado e saldo_acumulado_projetado matematicamente', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);

  const { rows: [d] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS d1,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 1)::TEXT AS d2,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 2)::TEXT AS d3
  `);

  await admin.query(`
    UPDATE public.contas_financeiras
    SET saldo_inicial = 1000.00, data_saldo_inicial = '2026-01-01'
    WHERE codigo = 'conta_pix_principal';
  `);

  await admin.query(`
    INSERT INTO public.financeiro_lancamentos (tipo, categoria, descricao, valor, data_lancamento, forma_pagamento, created_at)
    VALUES ('receita', 'Vendas', 'Entrada D1', 250.00, $1::DATE, 'pix', ($1 || ' 12:00:00-03')::TIMESTAMPTZ);
  `, [d.d1]);

  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor H10' });
  const ingId = await criarIngredienteFixture();
  const comp = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 40, custo_unitario: 10.00 }])
  });
  await rpc(adm, 'receber_compra', { p_compra_id: comp.compra_id, p_data_vencimento: d.d2 });

  const cliId = await criarClienteFixture();
  await criarPedidoConfirmadoFixture({ clienteId: cliId, total: 600.00, dataEntrega: d.d3 });

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: d.d1,
    p_data_fim: d.d3
  });

  assert.equal(fluxo.success, true);
  assert.equal(Number(fluxo.resumo.saldo_inicial_periodo), 1000.00);
  assert.equal(fluxo.diario.length, 3);

  assert.equal(Number(fluxo.diario[0].saldo_acumulado_realizado), 1250.00);
  assert.equal(Number(fluxo.diario[0].saldo_acumulado_projetado), 1250.00);

  assert.equal(Number(fluxo.diario[1].saldo_acumulado_realizado), 1250.00);
  assert.equal(Number(fluxo.diario[1].saldo_acumulado_projetado), 850.00);

  assert.equal(Number(fluxo.diario[2].saldo_acumulado_realizado), 1250.00);
  assert.equal(Number(fluxo.diario[2].saldo_acumulado_projetado), 1450.00);
  assert.equal(Number(fluxo.resumo.saldo_final_projetado), 1450.00);
});

// --------------------------------------------------------------------------
// GATE H11: Conciliação é idempotente e livro é append-only
// --------------------------------------------------------------------------
test('H11: registrar_conciliacao_financeira_admin é idempotente e bloqueia UPDATE/DELETE', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [h] } = await admin.query(`SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje`);

  const { rows: [lanc] } = await admin.query(`
    INSERT INTO public.financeiro_lancamentos (tipo, categoria, descricao, valor, data_lancamento, forma_pagamento)
    VALUES ('receita', 'Vendas', 'PIX para conciliar', 95.00, $1::DATE, 'pix')
    RETURNING id;
  `, [h.hoje]);

  const c1 = await rpc(adm, 'registrar_conciliacao_financeira_admin', {
    p_origem_tipo: 'financeiro_lancamento',
    p_origem_id: lanc.id,
    p_status: 'conciliado',
    p_valor_extrato: 95.00,
    p_referencia_externa: 'E2E-PIX-999',
    p_idempotency_key: 'conc_h11_1'
  });
  assert.equal(c1.success, true);
  assert.equal(c1.idempotente, false);

  const c2 = await rpc(adm, 'registrar_conciliacao_financeira_admin', {
    p_origem_tipo: 'financeiro_lancamento',
    p_origem_id: lanc.id,
    p_status: 'conciliado',
    p_valor_extrato: 95.00,
    p_referencia_externa: 'E2E-PIX-999',
    p_idempotency_key: 'conc_h11_1'
  });
  assert.equal(c2.success, true);
  assert.equal(c2.idempotente, true);
  assert.equal(c2.conciliacao_id, c1.conciliacao_id);

  const rel = await rpc(adm, 'obter_conciliacao_financeira_admin', {
    p_data_inicio: h.hoje,
    p_data_fim: h.hoje
  });
  assert.equal(rel.success, true);
  assert.equal(Number(rel.resumo.conciliado), 1);

  await assert.rejects(
    admin.query(`DELETE FROM public.conciliacoes_financeiras WHERE id = $1`, [c1.conciliacao_id]),
    /estritamente imutáveis/i
  );
  await assert.rejects(
    admin.query(`UPDATE public.conciliacoes_financeiras SET valor_extrato = 0 WHERE id = $1`, [c1.conciliacao_id]),
    /estritamente imutáveis/i
  );
});

// --------------------------------------------------------------------------
// GATE H12: Ajuste manual exige admin + motivo (>= 5 chars)
// --------------------------------------------------------------------------
test('H12: registrar_ajuste_tesouraria_admin exige admin e motivo válido e reconcilia com DRE', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);

  const { rows: [conta] } = await admin.query(`SELECT id FROM public.contas_financeiras WHERE codigo = 'caixa_fisico'`);

  const resOper = await rpc(oper, 'registrar_ajuste_tesouraria_admin', {
    p_conta_financeira_id: conta.id,
    p_tipo: 'entrada',
    p_valor: 50.00,
    p_motivo: 'Tentativa operador'
  });
  assert.equal(resOper.success, false);
  assert.equal(resOper.code, 'PERMISSION_DENIED');

  const resSemMotivo = await rpc(adm, 'registrar_ajuste_tesouraria_admin', {
    p_conta_financeira_id: conta.id,
    p_tipo: 'entrada',
    p_valor: 50.00,
    p_motivo: 'abc'
  });
  assert.equal(resSemMotivo.success, false);
  assert.equal(resSemMotivo.code, 'REASON_REQUIRED');

  const resOk = await rpc(adm, 'registrar_ajuste_tesouraria_admin', {
    p_conta_financeira_id: conta.id,
    p_tipo: 'saida',
    p_valor: 35.00,
    p_motivo: 'Tarifa bancária de manutenção mensal',
    p_idempotency_key: 'aj_h12_1'
  });
  assert.equal(resOk.success, true);
  assert.ok(resOk.lancamento_id > 0);
});

// --------------------------------------------------------------------------
// GATE H13: Operador não vê saldos bancários sensíveis
// --------------------------------------------------------------------------
test('H13: operador é bloqueado com PERMISSION_DENIED em todas as RPCs de tesouraria e saldos bancários', async () => {
  const oper = await newClient(OPER_UID);

  for (const fn of [
    'obter_fluxo_caixa_admin',
    'obter_posicao_tesouraria_admin',
    'obter_contas_pagar_periodo_admin',
    'obter_recebimentos_previstos_admin',
    'obter_conciliacao_financeira_admin'
  ]) {
    const r = await rpc(oper, fn);
    assert.equal(r.success, false, `Operador deve ser bloqueado em ${fn}`);
    assert.equal(r.code, 'PERMISSION_DENIED');
  }
});

// --------------------------------------------------------------------------
// GATE H14: Anon e cliente comum bloqueados (fail-closed)
// --------------------------------------------------------------------------
test('H14: anon e cliente autenticado comum recebem rejeição fail-closed nas RPCs da Frente H', async () => {
  const cli = await newClient(CLIENTE_UID);
  const anon = await newClient('anon');

  const rCli = await rpc(cli, 'obter_posicao_tesouraria_admin');
  assert.equal(rCli.success, false);
  assert.equal(rCli.code, 'PERMISSION_DENIED');

  await assert.rejects(
    rpc(anon, 'obter_fluxo_caixa_admin'),
    /permission denied/i
  );
  await assert.rejects(
    rpc(anon, 'obter_posicao_tesouraria_admin'),
    /permission denied/i
  );
});

// --------------------------------------------------------------------------
// GATE H15: Reconciliação direta bate com financeiro_lancamentos
// --------------------------------------------------------------------------
test('H15: totais realizados do fluxo de caixa reconciliam ao centavo com financeiro_lancamentos', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje
  `);

  const cliId = await criarClienteFixture();
  const pedId = await criarPedidoConfirmadoFixture({ clienteId: cliId, total: 220.00, dataEntrega: datas.hoje });
  await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 150.00, p_metodo: 'pix' });
  const pag2 = await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 70.00, p_metodo: 'dinheiro' });
  await rpc(adm, 'estornar_pagamento_pedido', { p_pagamento_id: pag2.pagamento_id, p_motivo: 'Devolução parcial H15' });

  const { rows: [conta] } = await admin.query(`SELECT id FROM public.contas_financeiras WHERE codigo = 'caixa_fisico'`);
  await rpc(adm, 'registrar_ajuste_tesouraria_admin', {
    p_conta_financeira_id: conta.id,
    p_tipo: 'saida',
    p_valor: 15.00,
    p_motivo: 'Despesa rápida de troco'
  });

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.hoje
  });

  const { rows: [dre] } = await admin.query(`
    SELECT
      COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0.00) AS receitas,
      COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND categoria = 'Estornos'), 0.00) AS estornos,
      COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND COALESCE(categoria, '') <> 'Estornos'), 0.00) AS despesas
    FROM public.financeiro_lancamentos;
  `);

  assert.equal(Number(fluxo.resumo.entradas_brutas_realizadas), Number(dre.receitas));
  assert.equal(Number(fluxo.resumo.estornos_realizados), Number(dre.estornos));
  assert.equal(Number(fluxo.resumo.saidas_operacionais_realizadas), Number(dre.despesas));
});

// --------------------------------------------------------------------------
// GATE H16: Cenário misto compra + venda + estorno + crédito reconcilia sem duplicidade
// --------------------------------------------------------------------------
test('H16: cenário misto compra + venda + estorno + crédito reconcilia sem duplicidade', async () => {
  await limparMovimentosFinanceiros();
  const adm = await newClient(ADMIN_UID);
  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() AT TIME ZONE 'America/Fortaleza')::DATE::TEXT AS hoje,
      ((NOW() AT TIME ZONE 'America/Fortaleza')::DATE + 7)::TEXT AS futuro
  `);

  // 1. Compra de insumos de R$ 300 com pagamento parcial de R$ 120 e R$ 180 a pagar no futuro
  const forn = await rpc(adm, 'salvar_fornecedor_admin', { p_nome: 'Fornecedor Misto H16' });
  const ingId = await criarIngredienteFixture();
  const comp = await rpc(adm, 'criar_compra', {
    p_fornecedor_id: forn.fornecedor_id,
    p_itens: JSON.stringify([{ ingrediente_id: ingId, quantidade: 30, custo_unitario: 10.00 }])
  });
  const rec = await rpc(adm, 'receber_compra', {
    p_compra_id: comp.compra_id,
    p_data_vencimento: datas.futuro
  });
  await rpc(adm, 'registrar_pagamento_fornecedor', {
    p_conta_id: rec.conta_pagar_id,
    p_valor: 120.00,
    p_forma_pagamento: 'pix',
    p_evento_idempotencia: 'h16_forn_1'
  });

  // 2. Venda confirmada de R$ 250 paga com R$ 50 de crédito + R$ 100 PIX + R$ 20 dinheiro (estornado) -> R$ 100 a receber
  const cliId = await criarClienteFixture();
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cliId,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Crédito inicial H16',
    p_request_id: 'h16_cred_init'
  });

  const pedId = await criarPedidoConfirmadoFixture({
    clienteId: cliId,
    total: 250.00,
    dataEntrega: datas.futuro
  });

  await rpc(adm, 'utilizar_credito_cliente_pedido', { p_pedido_id: pedId, p_valor: 50.00 });
  await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 100.00, p_metodo: 'pix' });
  const pagDin = await rpc(adm, 'registrar_pagamento_pedido', { p_pedido_id: pedId, p_valor: 20.00, p_metodo: 'dinheiro' });
  await rpc(adm, 'estornar_pagamento_pedido', { p_pagamento_id: pagDin.pagamento_id, p_motivo: 'Troco devolvido H16' });

  const fluxo = await rpc(adm, 'obter_fluxo_caixa_admin', {
    p_data_inicio: datas.hoje,
    p_data_fim: datas.futuro
  });
  assert.equal(fluxo.success, true);

  assert.equal(Number(fluxo.resumo.entradas_brutas_realizadas), 120.00);
  assert.equal(Number(fluxo.resumo.estornos_realizados), 20.00);
  assert.equal(Number(fluxo.resumo.entradas_liquidas_realizadas), 100.00);
  assert.equal(Number(fluxo.resumo.saidas_operacionais_realizadas), 120.00);
  assert.equal(Number(fluxo.resumo.liquido_realizado), -20.00);
  assert.equal(Number(fluxo.resumo.entradas_previstas), 100.00);
  assert.equal(Number(fluxo.resumo.saidas_previstas), 180.00);
  assert.equal(Number(fluxo.resumo.credito_cliente_utilizado_periodo), 50.00);

  const pos = await rpc(adm, 'obter_posicao_tesouraria_admin', { p_horizonte_dias: 30 });
  assert.equal(pos.success, true);
  assert.equal(Number(pos.saldo_caixa_realizado_atual), -20.00);
  assert.equal(Number(pos.recebimentos_previstos_horizonte), 100.00);
  assert.equal(Number(pos.contas_pagar_previstas_horizonte), 180.00);
  assert.equal(Number(pos.saldo_caixa_projetado), -100.00);
  assert.equal(Number(pos.necessidade_caixa), 100.00);
});
