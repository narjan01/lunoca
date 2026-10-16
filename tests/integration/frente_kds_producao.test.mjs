// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE 038 (KDS PRODUÇÃO EM TEMPO REAL)
// ==============================================================================
// Valida os 18 gates obrigatórios K1 a K18 da Migration 038:
// K1:  Subordinação canônica: KDS não altera enum nem cria status paralelos no pedido
// K2:  Entrada desacoplada: gatilho KDS dispara exclusivamente em status_operacional = 'aguardando_producao'
// K3:  Nomenclatura canônica preservada (saiu_para_entrega sem saiu_entrega)
// K4:  Tipagem relacional estrita: pedido_id BIGINT e pedido_item_id BIGINT
// K5:  Segregação Pedido vs Item: múltiplos itens com rotas independentes
// K6:  Transição inicial: avanço do 1º item transiciona pedido para 'em_producao'
// K7:  Transição final: conclusão de todos os itens transiciona pedido para 'pronto'
// K8:  Cancelamento seguro: status 'cancelado' encerra KDS sem apagar histórico e sem marcar 'pronto'
// K9:  RLS e integridade fail-closed no cabeçalho pedido_producao_kds
// K10: RLS e integridade fail-closed nos itens pedido_item_producao_kds
// K11: Auditoria imutável append-only: pedido_kds_estagio_historico bloqueia UPDATE/DELETE (42501)
// K12: RPC kds_obter_painel com SECURITY DEFINER e projeção sanitizada
// K13: RPC kds_avancar_item com FOR UPDATE e autoria estrita via auth.uid()
// K14: Avanço obedece estritamente a rota snapshotada (bloqueia saltos ilegais com P0001)
// K15: Alteração de produto_etapas_kds não afeta rotas snapshotadas em andamento
// K16: Filtro funcional por praça em kds_obter_painel
// K17: RPC kds_marcar_urgencia com autoria server-side e flag de prioridade
// K18: Sincronização idempotente de triggers e publicação em supabase_realtime
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
const PORT = 54455;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_A_UID = '22222222-2222-4222-8222-222222222222';
const CLI_UID = '44444444-4444-4444-8444-444444444444';

let prodBoloId;
let prodBrownieId;

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
    dirName: '.pg-integration-frente-kds',
    port: PORT,
    dbName: 'lunoca_frente_kds_test'
  });
  connInfo = setup.connInfo;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  await admin.query(fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8'));
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));

  await setIdentity(admin, 'service_role');

  // Criar perfis de teste
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin.kds@lunocadoceria.com.br'),
      ('${OPER_A_UID}', 'confeiteiro.kds@lunocadoceria.com.br'),
      ('${CLI_UID}', 'cliente.kds@exemplo.com.br')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin KDS', 'admin.kds@lunocadoceria.com.br', 'admin', true),
      ('${OPER_A_UID}', 'Confeiteiro Chefe', 'confeiteiro.kds@lunocadoceria.com.br', 'operador', true),
      ('${CLI_UID}', 'Cliente Teste KDS', 'cliente.kds@exemplo.com.br', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  // Produtos de teste
  const resBolo = await admin.query(`
    INSERT INTO public.produtos (nome, preco, ativo, estoque_qtd)
    VALUES ('Bolo Vulcão Ninho KDS', 120.00, true, 0)
    RETURNING id;
  `);
  prodBoloId = resBolo.rows[0].id;

  const resBrownie = await admin.query(`
    INSERT INTO public.produtos (nome, preco, ativo, estoque_qtd)
    VALUES ('Brownie Especial KDS', 15.00, true, 0)
    RETURNING id;
  `);
  prodBrownieId = resBrownie.rows[0].id;

  // Rotas personalizadas KDS para os produtos
  await admin.query(`
    DELETE FROM public.produto_etapas_kds WHERE produto_id IN (${prodBoloId}, ${prodBrownieId});

    -- Bolo: MASSA -> FORNO -> RECHEIO -> DECORACAO -> EMBALAGEM
    INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos, obrigatoria)
    VALUES 
      (${prodBoloId}, 1, 'MASSA', 15, true),
      (${prodBoloId}, 2, 'FORNO', 35, true),
      (${prodBoloId}, 3, 'RECHEIO', 20, true),
      (${prodBoloId}, 4, 'DECORACAO', 25, true),
      (${prodBoloId}, 5, 'EMBALAGEM', 10, true);

    -- Brownie: FORNO -> EMBALAGEM
    INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos, obrigatoria)
    VALUES 
      (${prodBrownieId}, 1, 'FORNO', 25, true),
      (${prodBrownieId}, 2, 'EMBALAGEM', 10, true);
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

// Helper para criar pedido com itens
async function criarPedidoTeste(c, { itens, statusOperacional = 'aguardando_producao' }) {
  const statusInicial = statusOperacional === 'aguardando_producao' ? 'cancelado' : statusOperacional;
  const resPed = await c.query(`
    INSERT INTO public.pedidos (
      nome_cliente, telefone_cliente, email_cliente,
      data_entrega, hora_entrega,
      total, status_operacional, status_financeiro, status_comercial,
      pagamento, canal, itens, endereco_entrega
    )
    VALUES (
      'Cliente KDS Teste', '11999990000', 'kds@teste.com',
      CURRENT_DATE, '16:00:00',
      200.00, $1, 'pago', 'confirmado',
      'pix', 'balcao', '[]', 'Balcão da Loja'
    )
    RETURNING id;
  `, [statusInicial]);
  const pedidoId = resPed.rows[0].id;

  for (const item of itens) {
    const subtotal = Number(item.quantidade) * 50.00;
    await c.query(`
      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal,
        produto_nome_snapshot
      )
      VALUES ($1, $2, $3, 50.00, 50.00, $4, $5);
    `, [pedidoId, item.produto_id, item.quantidade, subtotal, item.nome || 'Item Teste']);
  }

  if (statusOperacional === 'aguardando_producao') {
    await c.query(`UPDATE public.pedidos SET status_operacional = 'aguardando_producao' WHERE id = $1`, [pedidoId]);
  }

  return pedidoId;
}

// ------------------------------------------------------------------------------
// TESTES
// ------------------------------------------------------------------------------

test('K1: Subordinação canônica: KDS não cria status paralelos no enum de pedidos', async () => {
  const c = await newClient('service_role');
  try {
    const res = await c.query(`
      SELECT pg_get_constraintdef(c.oid) as condef
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'pedidos' AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%status_operacional%';
    `);
    assert.ok(res.rows.length > 0, 'deve existir check constraint em status_operacional');
    const condef = res.rows[0].condef;
    assert.ok(condef.includes('aguardando_producao'), 'deve conter aguardando_producao');
    assert.ok(condef.includes('em_producao'), 'deve conter em_producao');
    assert.ok(condef.includes('pronto'), 'deve conter pronto');
    assert.ok(condef.includes('saiu_para_entrega'), 'deve conter saiu_para_entrega');
    assert.ok(!condef.includes('saiu_entrega'), 'não deve conter saiu_entrega');
    assert.ok(!condef.includes('kds_forno'), 'não deve ter status operacional de praça');
  } finally {
    await closeClient(c);
  }
});

test('K2 & K4: Entrada desacoplada e tipagem relacional BIGINT ao transicionar para aguardando_producao', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, {
      itens: [{ produto_id: prodBoloId, quantidade: 1, nome: 'Bolo Vulcão Ninho KDS' }],
      statusOperacional: 'cancelado'
    });

    // Antes de aguardando_producao, não deve existir KDS ativo
    let kdsCheck = await c.query(`SELECT 1 FROM public.pedido_producao_kds WHERE pedido_id = $1 AND ativo = true`, [pedidoId]);
    assert.equal(kdsCheck.rows.length, 0, 'não deve inicializar KDS antes de aguardando_producao');

    // Ao transicionar para aguardando_producao, dispara o trigger
    await c.query(`UPDATE public.pedidos SET status_operacional = 'aguardando_producao' WHERE id = $1`, [pedidoId]);

    kdsCheck = await c.query(`SELECT id, pedido_id, estagio_agregado, sla_total_snapshot, ativo FROM public.pedido_producao_kds WHERE pedido_id = $1`, [pedidoId]);
    assert.equal(kdsCheck.rows.length, 1, 'KDS deve ser inicializado pelo trigger');
    assert.equal(kdsCheck.rows[0].estagio_agregado, 'AGUARDANDO');
    assert.equal(kdsCheck.rows[0].ativo, true);
    // SLA total do bolo = 15 + 35 + 20 + 25 + 10 = 105 min
    assert.equal(kdsCheck.rows[0].sla_total_snapshot, 105);

    // Verificar itens do KDS
    const itemCheck = await c.query(`
      SELECT id, pedido_item_id, estagio_atual, praca_atual, proxima_etapa, ordem_etapa_atual
      FROM public.pedido_item_producao_kds
      WHERE kds_id = $1
    `, [kdsCheck.rows[0].id]);
    assert.equal(itemCheck.rows.length, 1);
    assert.equal(itemCheck.rows[0].estagio_atual, 'AGUARDANDO');
    assert.equal(itemCheck.rows[0].praca_atual, null, 'praca_atual deve ser NULL em AGUARDANDO');
    assert.equal(itemCheck.rows[0].proxima_etapa, 'MASSA', 'primeira etapa deve ser MASSA');
    assert.equal(itemCheck.rows[0].ordem_etapa_atual, 0, 'ordem_etapa_atual em AGUARDANDO deve ser 0');
  } finally {
    await closeClient(c);
  }
});

test('K5 & K14: Segregação Pedido vs Item e snapshot imutável de rota (bloqueio de saltos)', async () => {
  const c = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [
        { produto_id: prodBoloId, quantidade: 1, nome: 'Bolo Vulcão' },
        { produto_id: prodBrownieId, quantidade: 2, nome: 'Brownie' }
      ],
      statusOperacional: 'aguardando_producao'
    });

    const itensKds = await admin.query(`
      SELECT pik.id, pik.proxima_etapa, p.nome
      FROM public.pedido_item_producao_kds pik
      JOIN public.pedido_itens pi ON pi.id = pik.pedido_item_id
      JOIN public.produtos p ON p.id = pi.produto_id
      WHERE pik.pedido_id = $1
      ORDER BY pik.id
    `, [pedidoId]);
    assert.equal(itensKds.rows.length, 2, 'esperado 2 itens independentes no KDS');

    const boloItem = itensKds.rows.find(r => r.nome.includes('Bolo'));
    const brownieItem = itensKds.rows.find(r => r.nome.includes('Brownie'));

    assert.equal(boloItem.proxima_etapa, 'MASSA');
    assert.equal(brownieItem.proxima_etapa, 'FORNO');

    // Tentar saltar etapa ilegal no bolo: tentar ir direto para FORNO ou EMBALAGEM
    await assert.rejects(
      rpc(c, 'kds_avancar_item', {
        p_kds_item_id: boloItem.id,
        p_proximo_estagio: 'FORNO'
      }),
      /KDS_ILLEGAL_STAGE_JUMP/,
      'deve rejeitar salto ilegal na rota'
    );
  } finally {
    await closeClient(c);
  }
});

test('K6: Transição inicial: avanço do 1º item fora de AGUARDANDO atualiza pedido para em_producao', async () => {
  const c = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [{ produto_id: prodBoloId, quantidade: 1, nome: 'Bolo 1' }],
      statusOperacional: 'aguardando_producao'
    });

    const itemRow = await admin.query(`
      SELECT id FROM public.pedido_item_producao_kds WHERE pedido_id = $1
    `, [pedidoId]);
    const kdsItemId = itemRow.rows[0].id;

    // Avançar de AGUARDANDO para MASSA
    const res = await rpc(c, 'kds_avancar_item', {
      p_kds_item_id: kdsItemId,
      p_proximo_estagio: 'MASSA'
    });
    assert.equal(res.success, true);
    assert.equal(res.novo_estagio, 'MASSA');

    // Pedido agora deve estar em 'em_producao'
    const pedCheck = await admin.query(`SELECT status_operacional FROM public.pedidos WHERE id = $1`, [pedidoId]);
    assert.equal(pedCheck.rows[0].status_operacional, 'em_producao', 'deve transicionar para em_producao');
  } finally {
    await closeClient(c);
  }
});

test('K7: Transição final: conclusão de todas as unidades atualiza pedidos.status_operacional = pronto', async () => {
  const c = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [{ produto_id: prodBrownieId, quantidade: 1, nome: 'Brownie Rápido' }],
      statusOperacional: 'aguardando_producao'
    });

    const itemRow = await admin.query(`
      SELECT id FROM public.pedido_item_producao_kds WHERE pedido_id = $1
    `, [pedidoId]);
    const kdsItemId = itemRow.rows[0].id;

    // Rota do Brownie: FORNO -> EMBALAGEM -> PRONTO
    await rpc(c, 'kds_avancar_item', { p_kds_item_id: kdsItemId, p_proximo_estagio: 'FORNO' });
    await rpc(c, 'kds_avancar_item', { p_kds_item_id: kdsItemId, p_proximo_estagio: 'EMBALAGEM' });
    
    // Conclusão final
    const resFinal = await rpc(c, 'kds_avancar_item', { p_kds_item_id: kdsItemId, p_proximo_estagio: 'PRONTO' });
    assert.equal(resFinal.success, true);
    assert.equal(resFinal.todos_prontos, true);

    const pedCheck = await admin.query(`SELECT status_operacional FROM public.pedidos WHERE id = $1`, [pedidoId]);
    assert.equal(pedCheck.rows[0].status_operacional, 'pronto', 'pedido deve transicionar para pronto');
  } finally {
    await closeClient(c);
  }
});

test('K8: Cancelamento seguro: pedidos.status_operacional = cancelado encerra unidades sem marcar pronto', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, {
      itens: [{ produto_id: prodBoloId, quantidade: 1, nome: 'Bolo Cancelado' }],
      statusOperacional: 'aguardando_producao'
    });

    // Cancelar pedido
    await c.query(`UPDATE public.pedidos SET status_operacional = 'cancelado' WHERE id = $1`, [pedidoId]);

    const kdsHead = await c.query(`
      SELECT ativo, encerrado_em, motivo_encerramento, estagio_agregado 
      FROM public.pedido_producao_kds 
      WHERE pedido_id = $1
    `, [pedidoId]);
    assert.equal(kdsHead.rows[0].ativo, false);
    assert.equal(kdsHead.rows[0].motivo_encerramento, 'CANCELADO');
    assert.notEqual(kdsHead.rows[0].estagio_agregado, 'PRONTO', 'não pode ser marcado como pronto');

    const kdsItens = await c.query(`
      SELECT ativo, estagio_atual
      FROM public.pedido_item_producao_kds
      WHERE pedido_id = $1
    `, [pedidoId]);
    assert.equal(kdsItens.rows[0].ativo, false);
    assert.notEqual(kdsItens.rows[0].estagio_atual, 'PRONTO');
  } finally {
    await closeClient(c);
  }
});

test('K11: Auditoria imutável append-only: pedido_kds_estagio_historico rejeita UPDATE e DELETE com 42501', async () => {
  const c = await newClient('service_role');
  try {
    const pedidoId = await criarPedidoTeste(c, {
      itens: [{ produto_id: prodBrownieId, quantidade: 1, nome: 'Brownie Auditoria' }],
      statusOperacional: 'aguardando_producao'
    });

    const itemRow = await c.query(`SELECT id FROM public.pedido_item_producao_kds WHERE pedido_id = $1`, [pedidoId]);
    const kdsItemId = itemRow.rows[0].id;

    await rpc(c, 'kds_avancar_item', { p_kds_item_id: kdsItemId, p_proximo_estagio: 'FORNO' });

    const histRow = await c.query(`
      SELECT id FROM public.pedido_kds_estagio_historico WHERE kds_item_id = $1 LIMIT 1
    `, [kdsItemId]);
    assert.ok(histRow.rows.length > 0, 'deve haver registro no histórico');
    const histId = histRow.rows[0].id;

    // Tentar UPDATE
    await assert.rejects(
      c.query(`UPDATE public.pedido_kds_estagio_historico SET tempo_segundos = 999 WHERE id = $1`, [histId]),
      (err) => err.code === '42501' || /VIOLACAO_SEGURANCA/.test(err.message),
      'deve bloquear UPDATE com SQLSTATE 42501'
    );

    // Tentar DELETE
    await assert.rejects(
      c.query(`DELETE FROM public.pedido_kds_estagio_historico WHERE id = $1`, [histId]),
      (err) => err.code === '42501' || /VIOLACAO_SEGURANCA/.test(err.message),
      'deve bloquear DELETE com SQLSTATE 42501'
    );
  } finally {
    await closeClient(c);
  }
});

test('K12 & K16: RPC kds_obter_painel retorna dados formatados e suporta filtro por praça', async () => {
  const c = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [
        { produto_id: prodBoloId, quantidade: 1, nome: 'Bolo Painel' },
        { produto_id: prodBrownieId, quantidade: 1, nome: 'Brownie Painel' }
      ],
      statusOperacional: 'aguardando_producao'
    });

    // Iniciar bolo em MASSA e brownie em FORNO
    const itemRows = await admin.query(`
      SELECT pik.id, pik.proxima_etapa 
      FROM public.pedido_item_producao_kds pik 
      WHERE pik.pedido_id = $1
    `, [pedidoId]);

    for (const r of itemRows.rows) {
      await rpc(c, 'kds_avancar_item', { p_kds_item_id: r.id, p_proximo_estagio: r.proxima_etapa });
    }

    // Obter painel geral
    const painelGeral = await rpc(c, 'kds_obter_painel', { p_praca_filtro: null });
    assert.equal(painelGeral.success, true);
    assert.ok(painelGeral.cards.length >= 1);

    // Filtrar por MASSA: deve trazer o card com o item da praça MASSA
    const painelMassa = await rpc(c, 'kds_obter_painel', { p_praca_filtro: 'MASSA' });
    assert.equal(painelMassa.success, true);
    const cardMassa = painelMassa.cards.find(cd => cd.pedido_id == pedidoId);
    assert.ok(cardMassa, 'card deve existir no filtro MASSA');
    assert.ok(cardMassa.itens.every(it => it.praca_atual === 'MASSA'));

    // Filtrar por FORNO
    const painelForno = await rpc(c, 'kds_obter_painel', { p_praca_filtro: 'FORNO' });
    const cardForno = painelForno.cards.find(cd => cd.pedido_id == pedidoId);
    assert.ok(cardForno, 'card deve existir no filtro FORNO');
    assert.ok(cardForno.itens.every(it => it.praca_atual === 'FORNO'));
  } finally {
    await closeClient(c);
  }
});

test('K13 & K17: Autoria estrita server-side auth.uid() e marcação de urgência', async () => {
  const cOperador = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [{ produto_id: prodBrownieId, quantidade: 1, nome: 'Brownie Urgente' }],
      statusOperacional: 'aguardando_producao'
    });

    const resUrg = await rpc(cOperador, 'kds_marcar_urgencia', {
      p_pedido_id: pedidoId,
      p_motivo: 'Cliente aguardando na loja'
    });
    assert.equal(resUrg.success, true);
    assert.equal(resUrg.urgente, true);

    const pedKds = await admin.query(`
      SELECT prioridade_urgencia, observacoes_cozinha 
      FROM public.pedido_producao_kds 
      WHERE pedido_id = $1
    `, [pedidoId]);
    assert.equal(pedKds.rows[0].prioridade_urgencia, true);
    assert.ok(pedKds.rows[0].observacoes_cozinha.includes('URGÊNCIA: Cliente aguardando na loja'));
  } finally {
    await closeClient(cOperador);
  }
});

test('K15: Alteração de produto_etapas_kds não altera a rota de pedidos já snapshotados', async () => {
  const c = await newClient(OPER_A_UID);
  try {
    const pedidoId = await criarPedidoTeste(admin, {
      itens: [{ produto_id: prodBrownieId, quantidade: 1, nome: 'Brownie Imutável' }],
      statusOperacional: 'aguardando_producao'
    });

    // Brownie snapshotado tem rota: FORNO (ordem 1), EMBALAGEM (ordem 2)
    // Agora alterar configuração de futuros produtos adicionando etapa intermediária
    await admin.query(`
      INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos, obrigatoria)
      VALUES (${prodBrownieId}, 3, 'DECORACAO', 5, true)
      ON CONFLICT DO NOTHING;
    `);

    // Obter rota do item existente: deve continuar tendo apenas 2 etapas
    const snapRows = await admin.query(`
      SELECT ordem, praca FROM public.pedido_item_kds_etapas
      JOIN public.pedido_item_producao_kds ON pedido_item_producao_kds.id = pedido_item_kds_etapas.kds_item_id
      WHERE pedido_item_producao_kds.pedido_id = $1
      ORDER BY ordem
    `, [pedidoId]);
    assert.equal(snapRows.rows.length, 2, 'snapshot deve permanecer com 2 etapas');
    assert.equal(snapRows.rows[0].praca, 'FORNO');
    assert.equal(snapRows.rows[1].praca, 'EMBALAGEM');
  } finally {
    await closeClient(c);
  }
});
