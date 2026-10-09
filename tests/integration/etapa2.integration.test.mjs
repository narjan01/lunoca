// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - ETAPA 2 FECHAMENTO
// ==========================================================================
// Executa contra um PostgreSQL REAL:
//   * Por padrão sobe um servidor embarcado (embedded-postgres) descartável.
//   * Se DATABASE_URL estiver definido, usa esse banco (DEVE ser descartável!).
// Aplica: shim Supabase -> sql/install.sql (gerado) -> fixtures -> cenários.
//
// O que é provado aqui (e NÃO é provado por grep em test-hardening.js):
//   - Reserva de estoque por encomenda admin (Opção A) com flag por item
//   - Idempotência da expiração: "A=3, B=7 => 7 e NUNCA 4"
//   - Caso B (pagamento parcial) não cancela, libera estoque, vai para revisão
//   - Pagamento tardio: revalidação dupla (capacidade + estoque), recriação de reserva
//   - Override admin de capacidade permitido / de estoque proibido
//   - ESTORNAR_E_CANCELAR via fluxo canônico com lançamento no DRE
//   - CANCELAR exige destino do valor (RETENCAO_CANCELAMENTO)
//   - Entrega imediata exige sinal integral
//   - RBAC (operador não resolve revisão; anon não expira)
//   - Corrida real cron x pagamento tardio (locks) termina consistente
//   - Invariante global: produtos.estoque_reservado == soma das reservas ativas
// ==========================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54399;

let embedded = null;
let admin; // conexão superuser (fixtures / inspeção)
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

async function pedido(id) {
  const { rows } = await admin.query('SELECT * FROM public.pedidos WHERE id = $1', [id]);
  return rows[0];
}

async function reservado(produtoId) {
  const { rows } = await admin.query('SELECT estoque_reservado FROM public.produtos WHERE id = $1', [produtoId]);
  return Number(rows[0].estoque_reservado);
}

async function flagsDoPedido(id) {
  const { rows } = await admin.query('SELECT reserva_estoque_ativa, reserva_ciclo, quantidade, produto_id FROM public.pedido_itens WHERE pedido_id = $1 ORDER BY id', [id]);
  return rows;
}

// Invariante global: para cada produto controlado, reservado == soma das reservas ativas
async function assertInvarianteReservas(contexto) {
  const { rows } = await admin.query(`
    SELECT pr.id, pr.nome, pr.estoque_reservado,
           COALESCE((SELECT SUM(pi.quantidade) FROM public.pedido_itens pi WHERE pi.produto_id = pr.id AND pi.reserva_estoque_ativa = true), 0) AS ativas
    FROM public.produtos pr
    WHERE pr.controlar_estoque IS NOT FALSE AND pr.id >= 9000
  `);
  for (const r of rows) {
    assert.equal(Number(r.estoque_reservado), Number(r.ativas), `[${contexto}] Invariante quebrada no produto ${r.nome}: reservado=${r.estoque_reservado} ativas=${r.ativas}`);
  }
}

function dataFutura(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const P_BOLO = 9001;      // controlar_estoque = true, estoque_fisico = 10
const P_DOCE = 9002;      // controlar_estoque = true, estoque_fisico = 100
const P_SOB_ENC = 9003;   // controlar_estoque = false

before(async () => {
  if (process.env.DATABASE_URL) {
    connInfo = { connectionString: process.env.DATABASE_URL };
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const pgDir = path.join(ROOT, '.pg-integration');
    if (fs.existsSync(pgDir)) {
      try { fs.rmSync(pgDir, { recursive: true, force: true }); } catch {}
    }
    embedded = new EmbeddedPostgres({
      databaseDir: pgDir,
      user: 'postgres', password: 'postgres', port: PORT, persistent: false,
      onLog: () => {}, onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('lunoca_test');
    connInfo = { host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'lunoca_test' };
  }

  admin = new pg.Client(connInfo);
  await admin.connect();

  await admin.query(fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8'));
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));

  // Fixtures (como service_role: o trigger de proteção de profiles.nivel exige admin/service_role)
  await setIdentity(admin, 'service_role');
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin@test.local'), ('${OPER_UID}', 'oper@test.local'), ('${CLIENTE_UID}', 'cli@test.local');
    -- (o trigger handle_new_user em auth.users já cria o profile; garantimos nível/ativo)
    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin Teste', 'admin@test.local', 'admin', true),
      ('${OPER_UID}', 'Operador Teste', 'oper@test.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente Teste', 'cli@test.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;
    INSERT INTO public.produtos (id, nome, descricao, preco, ativo, controlar_estoque, estoque_fisico, estoque_reservado, pontos_producao) VALUES
      (${P_BOLO}, 'Bolo Teste', 'bolo', 100.00, true, true, 10, 0, 5.00),
      (${P_DOCE}, 'Doce Teste', 'doce', 2.00, true, true, 100, 0, 0.10),
      (${P_SOB_ENC}, 'Sob Encomenda', 'sem estoque', 50.00, true, false, 0, 0, 1.00);
    UPDATE public.configuracoes_operacao SET hold_horas_padrao = 24, antecedencia_confirmacao_horas = 2, capacidade_padrao_pontos = 1000 WHERE id = 1;
  `);
});

after(async () => {
  for (const c of activeClients) {
    try { await c.end(); } catch {}
  }
  try { await admin?.end(); } catch {}
  if (embedded) {
    try { await embedded.stop(); } catch {}
  }
});

// --------------------------------------------------------------------------
test('migration: tabelas, colunas e RPCs da Etapa 2 existem', async () => {
  const { rows } = await admin.query(`
    SELECT
      to_regclass('public.configuracoes_operacao') IS NOT NULL AS cfg,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pedido_itens' AND column_name='reserva_estoque_ativa') AS flag,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pedidos' AND column_name='confirmacao_expires_at') AS hold,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='expirar_pedidos_e_holds') AS exp,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='resolver_revisao_encomenda_admin') AS res,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname='atualizar_meus_dados_cliente') AS cli
  `);
  assert.deepEqual(rows[0], { cfg: true, flag: true, hold: true, exp: true, res: true, cli: true });
});

// --------------------------------------------------------------------------
let pedidoA, pedidoB;

test('Opção A: criar_encomenda_admin reserva estoque somente para itens controlados e marca a flag', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente A', p_cliente_telefone: '83999990001', p_canal: 'balcao',
    p_data_entrega: dataFutura(5), p_hora_entrega: '14:00',
    p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 3 }, { id: P_SOB_ENC, quantidade: 1 }]),
    p_sinal_minimo: 100, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 0,
  });
  await c.end();
  assert.equal(r.success, true, JSON.stringify(r));
  pedidoA = r.pedido_id;
  assert.equal(r.status_comercial, 'aguardando_confirmacao');
  assert.ok(r.confirmacao_expires_at, 'hold deve ter prazo');

  assert.equal(await reservado(P_BOLO), 3);
  const flags = await flagsDoPedido(pedidoA);
  const bolo = flags.find((f) => Number(f.produto_id) === P_BOLO);
  const sob = flags.find((f) => Number(f.produto_id) === P_SOB_ENC);
  assert.equal(bolo.reserva_estoque_ativa, true);
  assert.equal(Number(bolo.reserva_ciclo), 1);
  assert.equal(sob.reserva_estoque_ativa, false, 'item sem controle de estoque não reserva');
  await assertInvarianteReservas('após criar A');
});

test('Opção A: estoque insuficiente => INSUFFICIENT_STOCK e NADA persiste (rollback)', async () => {
  const antes = (await admin.query('SELECT COUNT(*)::int AS n FROM public.pedidos')).rows[0].n;
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente X', p_canal: 'whatsapp', p_data_entrega: dataFutura(6),
    p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 50 }]),
  });
  await c.end();
  assert.equal(r.success, false);
  assert.equal(r.code, 'INSUFFICIENT_STOCK', JSON.stringify(r));
  const depois = (await admin.query('SELECT COUNT(*)::int AS n FROM public.pedidos')).rows[0].n;
  assert.equal(depois, antes, 'pedido não pode ter sido criado');
  assert.equal(await reservado(P_BOLO), 3);
});

test('pedido B confirmado com sinal reserva 7 => reservado total = 10', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente B', p_cliente_telefone: '83999990002', p_canal: 'telefone',
    p_data_entrega: dataFutura(5), p_hora_entrega: '15:00',
    p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 7 }]),
    p_sinal_minimo: 100, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 100, p_sinal_metodo: 'pix',
  });
  await c.end();
  assert.equal(r.success, true, JSON.stringify(r));
  pedidoB = r.pedido_id;
  assert.equal(r.status_comercial, 'confirmado');
  assert.equal(await reservado(P_BOLO), 10);
  await assertInvarianteReservas('após criar B');
});

// --------------------------------------------------------------------------
test('TESTE OBRIGATÓRIO: expira A (3) => reservado 7; expira de novo => continua 7 (nunca 4)', async () => {
  // Força o vencimento do hold de A
  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 hour\' WHERE id = $1', [pedidoA]);

  const cron = await newClient('service_role');
  const r1 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r1.success, true);
  assert.equal(r1.cancelados_sem_pagamento, 1, JSON.stringify(r1));

  const a = await pedido(pedidoA);
  assert.equal(a.status_comercial, 'cancelado');
  assert.equal(a.cancelado_por_expiracao, true);
  assert.equal(a.status, 'Cancelado', 'status legado derivado');
  assert.equal(await reservado(P_BOLO), 7);
  assert.ok((await flagsDoPedido(pedidoA)).every((f) => f.reserva_estoque_ativa === false));

  // Segunda execução: idempotente
  const r2 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r2.processados, 0);
  assert.equal(await reservado(P_BOLO), 7, 'NUNCA pode virar 4');

  // Terceira, via wrapper legado
  const r3 = await rpc(cron, 'liberar_pedidos_expirados', {});
  assert.equal(r3.total_cancelados, 0);
  assert.equal(await reservado(P_BOLO), 7);
  await cron.end();

  // Movimentação de liberação registrada uma única vez por item
  const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM public.estoque_movimentacoes WHERE pedido_id = $1 AND origem_evento LIKE 'liberacao#%'`, [pedidoA]);
  assert.equal(rows[0].n, 1);
  await assertInvarianteReservas('após expirar A duas vezes');
});

// --------------------------------------------------------------------------
let pedidoC;

test('Caso B: hold expirado COM pagamento parcial => não cancela, libera estoque, vai para revisão (idempotente)', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente C', p_cliente_telefone: '83999990003', p_canal: 'whatsapp',
    p_data_entrega: dataFutura(7), p_hora_entrega: '10:00',
    p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 2 }]),
    p_sinal_minimo: 100, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 40, p_sinal_metodo: 'pix',
  });
  await c.end();
  assert.equal(r.success, true, JSON.stringify(r));
  pedidoC = r.pedido_id;
  assert.equal(r.status_comercial, 'aguardando_confirmacao');
  assert.equal(await reservado(P_BOLO), 9);

  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pedidoC]);

  const cron = await newClient('service_role');
  const r1 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r1.enviados_para_revisao, 1, JSON.stringify(r1));
  assert.equal(r1.cancelados_sem_pagamento, 0);

  const cped = await pedido(pedidoC);
  assert.equal(cped.status_comercial, 'aguardando_confirmacao', 'NÃO cancela silenciosamente');
  assert.equal(cped.requer_revisao_financeira, true);
  assert.equal(Number(cped.valor_pago), 40);
  assert.equal(await reservado(P_BOLO), 7, 'estoque liberado');

  const r2 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r2.processados, 0, 'pedido em revisão não é reprocessado');
  assert.equal(await reservado(P_BOLO), 7);
  await cron.end();

  // Hold vencido não ocupa capacidade
  const { rows } = await admin.query('SELECT public.pontos_ocupados_data($1::date, NULL) AS pts', [dataFutura(7)]);
  assert.equal(Number(rows[0].pts), 0);
  await assertInvarianteReservas('após caso B');
});

test('Pagamento tardio com capacidade e estoque disponíveis => confirma e RECRIA a reserva', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'registrar_pagamento_pedido', { p_pedido_id: pedidoC, p_valor: 60, p_metodo: 'pix' });
  await c.end();
  assert.equal(r.success, true, JSON.stringify(r));

  const cped = await pedido(pedidoC);
  assert.equal(cped.status_comercial, 'confirmado');
  assert.equal(cped.requer_revisao_financeira, false);
  assert.equal(cped.bloqueado_por_overbooking_tardio, false);
  assert.equal(cped.confirmacao_expires_at, null);
  assert.equal(await reservado(P_BOLO), 9, 'reserva recriada (7 + 2)');
  const flags = await flagsDoPedido(pedidoC);
  assert.equal(flags[0].reserva_estoque_ativa, true);
  assert.equal(Number(flags[0].reserva_ciclo), 2, 'segundo ciclo de reserva');
  await assertInvarianteReservas('após pagamento tardio OK');
});

// --------------------------------------------------------------------------
let pedidoD;

test('Pagamento tardio SEM estoque => NÃO confirma; bloqueado_por_overbooking_tardio = true', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente D', p_cliente_telefone: '83999990004', p_canal: 'balcao',
    p_data_entrega: dataFutura(8), p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 1 }]),
    p_sinal_minimo: 50, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 10, p_sinal_metodo: 'dinheiro',
  });
  pedidoD = r.pedido_id;
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(await reservado(P_BOLO), 10); // 7 (B) + 2 (C) + 1 (D)

  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pedidoD]);
  const cron = await newClient('service_role');
  await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  await cron.end();
  assert.equal(await reservado(P_BOLO), 9);

  // Some o estoque físico: fisico 9 == reservado 9 => disponível 0
  await admin.query('UPDATE public.produtos SET estoque_fisico = 9 WHERE id = $1', [P_BOLO]);

  const r2 = await rpc(c, 'registrar_pagamento_pedido', { p_pedido_id: pedidoD, p_valor: 40, p_metodo: 'pix' });
  await c.end();
  assert.equal(r2.success, true, JSON.stringify(r2));

  const d = await pedido(pedidoD);
  assert.equal(d.status_comercial, 'aguardando_confirmacao', 'não pode confirmar sem estoque');
  assert.equal(d.requer_revisao_financeira, true);
  assert.equal(d.bloqueado_por_overbooking_tardio, true);
  assert.match(d.motivo_revisao_financeira, /estoque/);
  assert.equal(await reservado(P_BOLO), 9, 'nenhuma reserva fantasma');
  await assertInvarianteReservas('após pagamento tardio sem estoque');
});

test('CONFIRMAR_COM_OVERRIDE NÃO sobrepõe estoque; após reposição confirma e reserva', async () => {
  const c = await newClient(ADMIN_UID);
  const r1 = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoD, p_acao: 'CONFIRMAR_COM_OVERRIDE', p_motivo: 'Tentativa de forçar sem estoque' });
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'INSUFFICIENT_STOCK', JSON.stringify(r1));
  assert.equal((await pedido(pedidoD)).status_comercial, 'aguardando_confirmacao');

  await admin.query('UPDATE public.produtos SET estoque_fisico = 20 WHERE id = $1', [P_BOLO]);
  const r2 = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoD, p_acao: 'CONFIRMAR_COM_OVERRIDE', p_motivo: 'Estoque reposto pelo fornecedor' });
  await c.end();
  assert.equal(r2.success, true, JSON.stringify(r2));
  const d = await pedido(pedidoD);
  assert.equal(d.status_comercial, 'confirmado');
  assert.equal(d.requer_revisao_financeira, false);
  assert.equal(await reservado(P_BOLO), 10);
  await assertInvarianteReservas('após override pós-reposição');
});

// --------------------------------------------------------------------------
test('Override de CAPACIDADE é permitido ao admin (estoque ok)', async () => {
  const data = dataFutura(9);
  await admin.query(`INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos) VALUES ($1, 5.00) ON CONFLICT (data) DO UPDATE SET capacidade_maxima_pontos = 5.00`, [data]);

  const c = await newClient(ADMIN_UID);
  // 1 bolo = 5 pts => cabe exatamente; segundo pedido estoura
  const r0 = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente E0', p_canal: 'balcao', p_data_entrega: data, p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 1 }]), p_sinal_minimo: 0, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)' });
  assert.equal(r0.success, true, JSON.stringify(r0));

  const r = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente E', p_canal: 'balcao', p_data_entrega: data, p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 10, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 5 });
  // 10 doces = 1 pt, excede 5 => sem encaixe falha
  assert.equal(r.success, false);
  assert.equal(r.code, 'PRODUCTION_CAPACITY_EXCEEDED');

  const rE = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente E', p_canal: 'balcao', p_data_entrega: data, p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 10, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 5, p_forcar_encaixe: true, p_motivo_encaixe: 'Cliente VIP' });
  assert.equal(rE.success, true, JSON.stringify(rE));
  const pedidoE = rE.pedido_id;

  // Expira com parcial, depois paga tardio: capacidade está estourada => bloqueia
  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pedidoE]);
  const cron = await newClient('service_role');
  await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  await cron.end();
  const rp = await rpc(c, 'registrar_pagamento_pedido', { p_pedido_id: pedidoE, p_valor: 5, p_metodo: 'pix' });
  assert.equal(rp.success, true, JSON.stringify(rp));
  let e = await pedido(pedidoE);
  assert.equal(e.status_comercial, 'aguardando_confirmacao');
  assert.equal(e.bloqueado_por_overbooking_tardio, true);
  assert.match(e.motivo_revisao_financeira, /capacidade/);

  // ESTENDER_HOLD também respeita capacidade
  const rh = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoE, p_acao: 'ESTENDER_HOLD', p_motivo: 'Tentando estender' });
  assert.equal(rh.code, 'PRODUCTION_CAPACITY_EXCEEDED');

  // Override de capacidade: permitido
  const ro = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoE, p_acao: 'CONFIRMAR_COM_OVERRIDE', p_motivo: 'Encaixe extraordinário autorizado' });
  await c.end();
  assert.equal(ro.success, true, JSON.stringify(ro));
  assert.equal(ro.override_capacidade, true);
  e = await pedido(pedidoE);
  assert.equal(e.status_comercial, 'confirmado');
  await assertInvarianteReservas('após override de capacidade');
});

// --------------------------------------------------------------------------
test('ESTORNAR_E_CANCELAR reutiliza estornar_pagamento_pedido e gera despesa "Estornos" no DRE', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente F', p_canal: 'balcao', p_data_entrega: dataFutura(10), p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 5 }]), p_sinal_minimo: 10, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 4 });
  const pedidoF = r.pedido_id;
  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pedidoF]);
  const cron = await newClient('service_role');
  await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  await cron.end();

  const rr = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoF, p_acao: 'ESTORNAR_E_CANCELAR', p_motivo: 'Cliente desistiu, devolver sinal' });
  await c.end();
  assert.equal(rr.success, true, JSON.stringify(rr));
  assert.equal(rr.estornos.length, 1);

  const f = await pedido(pedidoF);
  assert.equal(f.status_comercial, 'cancelado');
  assert.equal(f.status_financeiro, 'estornado');
  assert.equal(Number(f.valor_pago), 0);
  const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM public.financeiro_lancamentos WHERE pedido_id = $1 AND tipo = 'despesa' AND categoria = 'Estornos' AND evento = 'estorno'`, [pedidoF]);
  assert.equal(rows[0].n, 1);
  const { rows: pags } = await admin.query(`SELECT status FROM public.pedido_pagamentos WHERE pedido_id = $1`, [pedidoF]);
  assert.ok(pags.every((p) => p.status === 'estornado'));
  await assertInvarianteReservas('após estornar e cancelar');
});

test('CANCELAR com valor pago exige RETENCAO_CANCELAMENTO', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente G', p_canal: 'balcao', p_data_entrega: dataFutura(11), p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 5 }]), p_sinal_minimo: 10, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 4 });
  const pedidoG = r.pedido_id;
  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pedidoG]);
  const cron = await newClient('service_role');
  await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  await cron.end();

  const r1 = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoG, p_acao: 'CANCELAR', p_motivo: 'Cancelar sem destino' });
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'DESTINO_VALOR_OBRIGATORIO');

  const r2 = await rpc(c, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoG, p_acao: 'CANCELAR', p_motivo: 'Política de cancelamento: sinal retido', p_destino_valor: 'RETENCAO_CANCELAMENTO' });
  await c.end();
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(Number(r2.valor_retido), 4);
  const g = await pedido(pedidoG);
  assert.equal(g.status_comercial, 'cancelado');
  assert.match(g.observacoes_internas, /RETENÇÃO DE CANCELAMENTO/);
  assert.equal(Number(g.valor_pago), 4, 'valor retido permanece como receita');
});

// --------------------------------------------------------------------------
test('Entrega imediata: sem sinal integral => IMMEDIATE_CONFIRMATION_REQUIRED; com sinal => confirmado', async () => {
  // Data/hora "agora + 30min" no fuso configurado
  const { rows } = await admin.query(`
    SELECT 
      TO_CHAR((NOW() + INTERVAL '30 minutes') AT TIME ZONE (public.obter_config_operacao()).timezone, 'YYYY-MM-DD') AS data,
      TO_CHAR((NOW() + INTERVAL '30 minutes') AT TIME ZONE (public.obter_config_operacao()).timezone, 'HH24:MI') AS hora
  `);
  const { data, hora } = rows[0];

  const c = await newClient(ADMIN_UID);
  const r1 = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente H', p_canal: 'balcao', p_data_entrega: data, p_hora_entrega: hora, p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 2 }]), p_sinal_minimo: 4, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 1 });
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'IMMEDIATE_CONFIRMATION_REQUIRED', JSON.stringify(r1));

  const r2 = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente H', p_canal: 'balcao', p_data_entrega: data, p_hora_entrega: hora, p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 2 }]), p_sinal_minimo: 4, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 4 });
  await c.end();
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(r2.status_comercial, 'confirmado');
});

// --------------------------------------------------------------------------
test('RBAC: operador não resolve revisão; anon não executa expiração; operador cria encomenda', async () => {
  const op = await newClient(OPER_UID);
  const r = await rpc(op, 'resolver_revisao_encomenda_admin', { p_pedido_id: pedidoD, p_acao: 'CANCELAR', p_motivo: 'operador tentando' });
  assert.equal(r.success, false);
  assert.match(r.error, /Permissão negada/);

  const rc = await rpc(op, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente Op', p_canal: 'balcao', p_data_entrega: dataFutura(12), p_itens: JSON.stringify([{ id: P_SOB_ENC, quantidade: 1 }]), p_sinal_minimo: 0, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)' });
  assert.equal(rc.success, true, JSON.stringify(rc));
  await op.end();

  const anon = await newClient('anon');
  const ra = await rpc(anon, 'expirar_pedidos_e_holds', { p_limite: 10 });
  await anon.end();
  assert.equal(ra.success, false);
});

test('atualizar_meus_dados_cliente: cria, atualiza e bloqueia telefone duplicado', async () => {
  const cli = await newClient(CLIENTE_UID);
  const r1 = await rpc(cli, 'atualizar_meus_dados_cliente', { p_nome: 'Cliente Teste', p_telefone: '(83) 98888-0001' });
  assert.equal(r1.success, true, JSON.stringify(r1));
  // Telefone já usado por "Cliente A" (83999990001)
  const r2 = await rpc(cli, 'atualizar_meus_dados_cliente', { p_telefone: '83999990001' });
  assert.equal(r2.success, false);
  assert.equal(r2.code, 'PHONE_ALREADY_IN_USE');
  await cli.end();
  const { rows } = await admin.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'atualizar_meus_dados_cliente'`);
  assert.equal(rows[0].prosecdef, true);
  assert.ok(rows[0].proconfig.some((s) => s === 'search_path=public'), 'search_path estrito sem auth');
});

// --------------------------------------------------------------------------
test('Cancelamento por qualquer caminho (alterar_status_pedido) libera reserva via trigger único', async () => {
  const antes = await reservado(P_BOLO);
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'alterar_status_pedido', { p_pedido_id: pedidoB, p_dimensao: 'comercial', p_novo_status: 'cancelado', p_motivo: 'Teste de cancelamento' });
  await c.end();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(await reservado(P_BOLO), antes - 7);
  await assertInvarianteReservas('após cancelar B');
});

// --------------------------------------------------------------------------
test('CORRIDA REAL: cron expira (caso B) enquanto webhook paga tardio => termina consistente', async () => {
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', { p_cliente_nome: 'Cliente Race', p_canal: 'whatsapp', p_data_entrega: dataFutura(13), p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 2 }]), p_sinal_minimo: 100, p_motivo_confirmacao_sem_sinal: 'Sinal ajustado (cenário de teste)', p_sinal_valor: 30 });
  assert.equal(r.success, true, JSON.stringify(r));
  const pid = r.pedido_id;
  await admin.query('UPDATE public.pedidos SET confirmacao_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pid]);
  const reservadoAntes = await reservado(P_BOLO);

  // T1 (cron) abre transação e adquire o lock do pedido como faria expirar_pedidos_e_holds
  const t1 = await newClient('service_role');
  await t1.query('BEGIN');
  await t1.query('SELECT id FROM public.pedidos WHERE id = $1 FOR UPDATE', [pid]);

  // T2 (webhook/pagamento) tenta pagar: deve BLOQUEAR no lock do pedido (ordem global: pedido primeiro)
  let t2Done = false;
  const t2Promise = (async () => {
    const res = await rpc(c, 'registrar_pagamento_pedido', { p_pedido_id: pid, p_valor: 70, p_metodo: 'pix' });
    t2Done = true;
    return res;
  })();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t2Done, false, 'pagamento deve aguardar o lock do pedido');

  // T1 executa a expiração dentro da mesma transação (ela própria detém o lock) e comita
  const r1 = await rpc(t1, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r1.enviados_para_revisao, 1, JSON.stringify(r1));
  await t1.query('COMMIT');
  await t1.end();

  const r2 = await t2Promise;
  await c.end();
  assert.equal(r2.success, true, JSON.stringify(r2));

  // Resultado final: pagamento tardio enxergou a revisão e revalidou => confirmado com reserva recriada
  const p = await pedido(pid);
  assert.equal(p.status_comercial, 'confirmado');
  assert.equal(p.requer_revisao_financeira, false);
  assert.equal(Number(p.valor_pago), 100);
  assert.equal(await reservado(P_BOLO), reservadoAntes, 'liberou 2 e recriou 2');
  const flags = await flagsDoPedido(pid);
  assert.equal(flags[0].reserva_estoque_ativa, true);
  assert.equal(Number(flags[0].reserva_ciclo), 2);
  await assertInvarianteReservas('após corrida');
});

// --------------------------------------------------------------------------
test('LOJA ONLINE (regressão): criar_pedido marca flag; PIX expirado passa pelo pipeline único e devolve reserva', async () => {
  const antes = await reservado(P_DOCE);
  const anon = await newClient('anon');
  const r = await rpc(anon, 'criar_pedido', {
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 4, nome: 'Doce Teste', preco: 2 }]),
    p_data_entrega: dataFutura(3), p_pagamento: 'pix', p_endereco_entrega: 'Rua X, 1', p_telefone_cliente: '83977770001', p_nome_cliente: 'Guest Loja',
  });
  await anon.end();
  assert.equal(r.success, true, JSON.stringify(r));
  const pid = r.pedido_id;
  assert.equal(await reservado(P_DOCE), antes + 4);
  const flags = await flagsDoPedido(pid);
  assert.ok(flags.length > 0 && flags.every((f) => f.reserva_estoque_ativa === true), 'itens da loja nascem com reserva ativa');
  await assertInvarianteReservas('após criar_pedido loja');

  await admin.query('UPDATE public.pedidos SET expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1', [pid]);
  const cron = await newClient('service_role');
  const r1 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r1.cancelados_sem_pagamento, 1, JSON.stringify(r1));
  const r2 = await rpc(cron, 'expirar_pedidos_e_holds', { p_limite: 100 });
  assert.equal(r2.processados, 0);
  await cron.end();
  const p = await pedido(pid);
  assert.equal(p.status_comercial, 'cancelado');
  assert.equal(p.cancelado_por_expiracao, true);
  assert.equal(p.status_pagamento, 'cancelado', 'derivado pelo trigger de sincronização legado');
  assert.equal(await reservado(P_DOCE), antes, 'reserva devolvida exatamente uma vez');
  await assertInvarianteReservas('após expirar PIX loja');
});

test('LOJA ONLINE (regressão): confirmação via webhook converte reserva em venda e encerra a flag', async () => {
  const antes = await reservado(P_DOCE);
  const anon = await newClient('anon');
  const r = await rpc(anon, 'criar_pedido', {
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 3, nome: 'Doce Teste', preco: 2 }]),
    p_data_entrega: dataFutura(3), p_pagamento: 'pix', p_endereco_entrega: 'Rua Y, 2', p_telefone_cliente: '83977770002', p_nome_cliente: 'Guest Pago',
  });
  await anon.end();
  assert.equal(r.success, true, JSON.stringify(r));
  const pid = r.pedido_id;
  assert.equal(await reservado(P_DOCE), antes + 3);

  const svc = await newClient('service_role');
  const rc = await rpc(svc, 'confirmar_pagamento_pedido', { p_pedido_id: pid, p_mercado_pago_payment_id: 'mp-test-' + pid, p_status: 'approved', p_forma_pagamento: 'pix', p_valor: Number(r.total ?? 6), p_origem: 'webhook' });
  await svc.end();
  assert.equal(rc.success, true, JSON.stringify(rc));
  assert.equal(await reservado(P_DOCE), antes, 'reserva convertida em baixa física');
  const flags = await flagsDoPedido(pid);
  assert.ok(flags.every((f) => f.reserva_estoque_ativa === false), 'flag encerrada após venda');
  await assertInvarianteReservas('após webhook loja');
});

// ==========================================================================
// REVISÃO 2 — bloqueios apontados na auditoria do SQL
// ==========================================================================

test('R2-1 INSTALAÇÃO: install.sql já foi executado inteiro num banco vazio; migration 011 reaplicada e install.sql reexecutado sem erros (idempotência)', async () => {
  // O before() já executou sql/install.sql completo. Aqui provamos que o artefato e a migration são reaplicáveis.
  const antesFn = (await admin.query(`SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).rows[0].n;
  await admin.query(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '011_etapa2_fechamento_concorrencia.sql'), 'utf8'));
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));
  const depoisFn = (await admin.query(`SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).rows[0].n;
  assert.equal(depoisFn, antesFn, 'reaplicar não deve criar funções duplicadas/sobrecargas inesperadas');
  await setIdentity(admin, 'service_role');
  // trigger legado da loja NÃO pode existir (criar_pedido usa o helper)
  const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_pedido_itens_marca_reserva_loja'`);
  assert.equal(rows[0].n, 0);
  await assertInvarianteReservas('após reinstalação');
});

test('R2-2 GOVERNANÇA DO SINAL: operador não burla o sinal mínimo (0 => padrão 50%); admin só reduz com motivo', async () => {
  const op = await newClient(OPER_UID);
  const r = await rpc(op, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Sinal', p_canal: 'balcao', p_data_entrega: dataFutura(12),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), // total 20,00 => padrão 10,00
    p_sinal_minimo: 0, p_sinal_valor: 0, p_forcar_confirmacao_sem_sinal: false,
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.status_comercial, 'aguardando_confirmacao', 'operador com sinal 0 NÃO obtém confirmado');
  assert.equal(Number(r.sinal_minimo), 10);
  assert.ok(r.confirmacao_expires_at, 'hold criado');

  // operador tentando reduzir (5 < 10) => sobe para o padrão
  const r2 = await rpc(op, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Sinal 2', p_canal: 'balcao', p_data_entrega: dataFutura(12),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 5, p_sinal_valor: 5,
  });
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(Number(r2.sinal_minimo), 10);
  assert.equal(r2.status_comercial, 'aguardando_confirmacao');

  // operador pode AUMENTAR
  const r3 = await rpc(op, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Sinal 3', p_canal: 'balcao', p_data_entrega: dataFutura(12),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 15, p_sinal_valor: 0,
  });
  assert.equal(Number(r3.sinal_minimo), 15);
  await op.end();

  // admin reduzindo sem motivo => erro; com motivo => ok
  const ad = await newClient(ADMIN_UID);
  const r4 = await rpc(ad, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Sinal 4', p_canal: 'balcao', p_data_entrega: dataFutura(12),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 5, p_sinal_valor: 0,
  });
  assert.equal(r4.success, false);
  assert.equal(r4.code, 'SIGNAL_REDUCTION_REQUIRES_REASON');
  const r5 = await rpc(ad, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Sinal 5', p_canal: 'balcao', p_data_entrega: dataFutura(12),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 5, p_sinal_valor: 5,
    p_motivo_confirmacao_sem_sinal: 'Cliente recorrente, sinal reduzido',
  });
  assert.equal(r5.success, true, JSON.stringify(r5));
  assert.equal(Number(r5.sinal_minimo), 5);
  assert.equal(r5.status_comercial, 'confirmado');
  await ad.end();
  await assertInvarianteReservas('após governança do sinal');
});

test('R2-3 LOJA ONLINE grava snapshots de pontos (item + opção com produto_opcao_id) e a agenda enxerga a carga real', async () => {
  await admin.query(`
    INSERT INTO public.produto_opcoes (id, produto_id, categoria, nome, preco_adicional, ativo, pontos_producao_adicionais)
    VALUES (9901, ${P_BOLO}, 'decoracao', 'Decoração Premium', 30.00, true, 3.00)
    ON CONFLICT (id) DO UPDATE SET pontos_producao_adicionais = 3.00, preco_adicional = 30.00, ativo = true;
  `);
  const data = dataFutura(20);
  const antesPts = Number((await admin.query('SELECT public.pontos_ocupados_data($1::date, NULL) AS p', [data])).rows[0].p);
  const anon = await newClient('anon');
  const r = await rpc(anon, 'criar_pedido', {
    p_itens: JSON.stringify([{ id: P_BOLO, quantidade: 2, opcoes: [{ nome: 'Decoração Premium' }] }]),
    p_data_entrega: data, p_pagamento: 'pix', p_endereco_entrega: 'Rua Y, 2', p_telefone_cliente: '83977770002', p_nome_cliente: 'Guest Pontos',
  });
  await anon.end();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(Number(r.total), 2 * (100 + 30) + 10, 'preço da opção vem do catálogo');

  const { rows: itens } = await admin.query('SELECT pontos_producao_snapshot, preco_adicionais, preco_unitario_snapshot, subtotal FROM public.pedido_itens WHERE pedido_id = $1', [r.pedido_id]);
  assert.equal(itens.length, 1);
  assert.equal(Number(itens[0].pontos_producao_snapshot), 5, 'snapshot do bolo = 5 pts (não o default 1)');
  assert.equal(Number(itens[0].preco_adicionais), 30);
  assert.equal(Number(itens[0].preco_unitario_snapshot), 130);
  assert.equal(Number(itens[0].subtotal), 260);

  const { rows: opts } = await admin.query('SELECT o.produto_opcao_id, o.pontos_producao_adicionais_snapshot, o.tipo FROM public.pedido_item_opcoes o JOIN public.pedido_itens i ON i.id = o.pedido_item_id WHERE i.pedido_id = $1', [r.pedido_id]);
  assert.equal(opts.length, 1);
  assert.equal(Number(opts[0].produto_opcao_id), 9901);
  assert.equal(Number(opts[0].pontos_producao_adicionais_snapshot), 3);
  assert.equal(opts[0].tipo, 'decoracao');

  const depoisPts = Number((await admin.query('SELECT public.pontos_ocupados_data($1::date, NULL) AS p', [data])).rows[0].p);
  assert.equal(depoisPts - antesPts, 2 * (5 + 3), 'agenda: 2 x (5 + 3) = 16 pontos');
  await assertInvarianteReservas('após loja com snapshots');
});

test('R2-4 RESERVA AGREGADA: estoque 5, duas linhas do mesmo produto 4 + 4 => INSUFFICIENT_STOCK e reservado continua 0', async () => {
  await admin.query(`INSERT INTO public.produtos (id, nome, descricao, preco, ativo, controlar_estoque, estoque_fisico, estoque_reservado, pontos_producao)
    VALUES (9004, 'Torta Limitada', 't', 40.00, true, true, 5, 0, 1.00) ON CONFLICT (id) DO UPDATE SET estoque_fisico = 5, estoque_reservado = 0`);
  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Dup', p_canal: 'balcao', p_data_entrega: dataFutura(13),
    p_itens: JSON.stringify([{ id: 9004, quantidade: 4 }, { id: 9004, quantidade: 4 }]),
    p_sinal_minimo: 0,
  });
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.code, 'INSUFFICIENT_STOCK');
  assert.equal(r.detalhes.faltantes[0].necessario, 8, 'validação usa a SOMA das linhas');
  assert.equal(await reservado(9004), 0);
  const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM public.pedidos WHERE nome_cliente = 'Cliente Dup'`);
  assert.equal(rows[0].n, 0, 'nada persistiu');

  // 3 + 2 = 5 cabe exatamente
  const ok = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Dup OK', p_canal: 'balcao', p_data_entrega: dataFutura(13),
    p_itens: JSON.stringify([{ id: 9004, quantidade: 3 }, { id: 9004, quantidade: 2 }]),
    p_sinal_minimo: 0,
  });
  await c.end();
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(await reservado(9004), 5);
  assert.equal((await flagsDoPedido(ok.pedido_id)).length, 2, 'linhas preservadas');
  await assertInvarianteReservas('após reserva agregada');
});

test('R2-5 LOJA: duas linhas do mesmo produto com opções diferentes são preservadas (não viram 2x com todas as opções); estoque agregado', async () => {
  await admin.query(`
    INSERT INTO public.produto_opcoes (id, produto_id, categoria, nome, preco_adicional, ativo, pontos_producao_adicionais) VALUES
      (9902, ${P_DOCE}, 'recheio', 'Pistache', 1.00, true, 0.00),
      (9903, ${P_DOCE}, 'recheio', 'Brigadeiro', 0.50, true, 0.00)
    ON CONFLICT (id) DO NOTHING;
  `);
  const antes = await reservado(P_DOCE);
  const anon = await newClient('anon');
  const r = await rpc(anon, 'criar_pedido', {
    p_itens: JSON.stringify([
      { id: P_DOCE, quantidade: 1, opcoes: [{ nome: 'Pistache' }] },
      { id: P_DOCE, quantidade: 1, opcoes: [{ nome: 'Brigadeiro' }] },
    ]),
    p_data_entrega: dataFutura(4), p_pagamento: 'pix', p_endereco_entrega: 'Rua Z', p_telefone_cliente: '83977770003', p_nome_cliente: 'Guest Opções',
  });
  await anon.end();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(Number(r.total), (2 + 1) + (2 + 0.5) + 10, 'cada linha com SUA opção (não 2 x ambas)');
  const { rows } = await admin.query(`
    SELECT i.id, i.quantidade, i.reserva_estoque_ativa, array_agg(o.opcao_nome ORDER BY o.opcao_nome) AS opcoes
    FROM public.pedido_itens i LEFT JOIN public.pedido_item_opcoes o ON o.pedido_item_id = i.id
    WHERE i.pedido_id = $1 GROUP BY i.id ORDER BY i.id`, [r.pedido_id]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.opcoes), [['Pistache'], ['Brigadeiro']]);
  assert.ok(rows.every((x) => x.reserva_estoque_ativa === true));
  assert.equal(await reservado(P_DOCE), antes + 2, 'reserva agregada: 1 + 1');
  await assertInvarianteReservas('após linhas com opções distintas');
});

test('R2-6 LOJA: hold PIX usa configuracoes_operacao.hold_pix_loja_minutos (única fonte da verdade)', async () => {
  await admin.query('UPDATE public.configuracoes_operacao SET hold_pix_loja_minutos = 7 WHERE id = 1');
  const anon = await newClient('anon');
  const r = await rpc(anon, 'criar_pedido', {
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 1 }]),
    p_data_entrega: dataFutura(5), p_pagamento: 'pix', p_endereco_entrega: 'Rua W', p_telefone_cliente: '83977770004', p_nome_cliente: 'Guest Hold',
  });
  await anon.end();
  assert.equal(r.success, true, JSON.stringify(r));
  const { rows } = await admin.query('SELECT EXTRACT(EPOCH FROM (expires_at - NOW()))/60 AS mins FROM public.pedidos WHERE id = $1', [r.pedido_id]);
  const mins = Number(rows[0].mins);
  assert.ok(mins > 6 && mins <= 7, `expires_at deve ser ~7 min (obtido ${mins.toFixed(2)})`);
  await admin.query('UPDATE public.configuracoes_operacao SET hold_pix_loja_minutos = 30 WHERE id = 1');
});

test('R2-7 HOLD PÓS-ESTORNO: novo hold = MIN(agora + padrão, entrega - antecedência); sem prazo viável => revisão financeira', async () => {
  // Caso 1: entrega daqui a ~6h (no fuso operacional) => hold renovado deve ser ~4h, não 24h
  const { rows: tz } = await admin.query(`SELECT (NOW() AT TIME ZONE timezone) AS agora_local FROM public.configuracoes_operacao WHERE id = 1`);
  const agoraLocal = new Date(tz[0].agora_local + 'Z'); // sem fuso: tratamos como relógio local operacional
  const entrega = new Date(agoraLocal.getTime() + 6 * 3600 * 1000);
  const data = entrega.toISOString().slice(0, 10);
  const hora = entrega.toISOString().slice(11, 19);

  const c = await newClient(ADMIN_UID);
  const r = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Estorno Hold', p_canal: 'balcao', p_data_entrega: data, p_hora_entrega: hora,
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 10, p_sinal_valor: 10, p_sinal_metodo: 'pix',
    p_motivo_confirmacao_sem_sinal: 'cenário de teste',
  });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.status_comercial, 'confirmado');
  const { rows: pg1 } = await admin.query('SELECT id FROM public.pedido_pagamentos WHERE pedido_id = $1', [r.pedido_id]);
  const e = await rpc(c, 'estornar_pagamento_pedido', { p_pagamento_id: pg1[0].id, p_motivo: 'Teste de hold pós-estorno' });
  assert.equal(e.success, true, JSON.stringify(e));
  const p1 = await pedido(r.pedido_id);
  assert.equal(p1.status_comercial, 'aguardando_confirmacao');
  assert.equal(p1.requer_revisao_financeira, false);
  const horasHold = (new Date(p1.confirmacao_expires_at).getTime() - Date.now()) / 3600000;
  assert.ok(horasHold > 3 && horasHold < 4.2, `hold deve ser ~4h (entrega-2h), obtido ${horasHold.toFixed(2)}h`);

  // Caso 2: entrega daqui a ~1h (< antecedência 2h): sinal integral confirma; estorno => sem hold viável => revisão + estoque liberado
  const entrega2 = new Date(agoraLocal.getTime() + 60 * 60 * 1000);
  const antes = await reservado(P_DOCE);
  const r2 = await rpc(c, 'criar_encomenda_admin', {
    p_cliente_nome: 'Cliente Estorno Imediato', p_canal: 'balcao', p_data_entrega: entrega2.toISOString().slice(0, 10), p_hora_entrega: entrega2.toISOString().slice(11, 19),
    p_itens: JSON.stringify([{ id: P_DOCE, quantidade: 10 }]), p_sinal_minimo: 10, p_sinal_valor: 10, p_sinal_metodo: 'pix',
    p_motivo_confirmacao_sem_sinal: 'cenário de teste',
  });
  assert.equal(r2.success, true, JSON.stringify(r2));
  assert.equal(await reservado(P_DOCE), antes + 10);
  const { rows: pg2 } = await admin.query('SELECT id FROM public.pedido_pagamentos WHERE pedido_id = $1', [r2.pedido_id]);
  const e2 = await rpc(c, 'estornar_pagamento_pedido', { p_pagamento_id: pg2[0].id, p_motivo: 'Teste sem hold viável' });
  assert.equal(e2.success, true, JSON.stringify(e2));
  await c.end();
  const p2 = await pedido(r2.pedido_id);
  assert.equal(p2.status_comercial, 'aguardando_confirmacao');
  assert.equal(p2.requer_revisao_financeira, true, 'sem prazo de hold viável => revisão financeira');
  assert.ok(new Date(p2.confirmacao_expires_at).getTime() <= Date.now() + 1000, 'hold não pode ultrapassar a entrega');
  assert.equal(await reservado(P_DOCE), antes, 'estoque liberado ao ir para revisão');
  await assertInvarianteReservas('após hold pós-estorno');
});

test('Invariante final: estoque_reservado == soma das reservas ativas em todos os produtos', async () => {
  await assertInvarianteReservas('final');
});
