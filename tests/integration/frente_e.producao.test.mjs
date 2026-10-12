// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 020 (FRENTE E)
// ==========================================================================
// Valida os 18 gates (E1 a E18) da Agenda de Produção & Operação Visual:
// - E1: Pedido confirmado aparece na agenda correta
// - E2: Pedido cancelado NÃO aparece como produção ativa
// - E3: Operador pode iniciar produção, mas cliente autenticado comum recebe PERMISSION_DENIED
// - E4: Duas transições concorrentes não corrompem status
// - E5: Não é possível ir de aguardando_producao direto para entregue
// - E6: marcar_pedido_pronto exige fluxo válido
// - E7: Entrega e retirada seguem caminhos distintos (saída para entrega bloqueada para retirada)
// - E8: Capacidade diária exibida corresponde à reserva canônica
// - E9: Alteração de data revalida capacidade diária
// - E10: Histórico operacional registra todas as transições com autor
// - E11: Observação de produção é persistida e bloqueia DELETE físico
// - E12: Agenda de produção NÃO recebe campos financeiros sensíveis (sanitização da cozinha)
// - E13: Agenda respeita timezone operacional
// - E14: Filtros por data, status e modalidade funcionam precisamente
// - E15: Pedido com múltiplos itens e opções permanece íntegro
// - E16: Transições repetidas são idempotentes
// - E17: Evento "pedido pronto" integra com WhatsApp da Frente B
// - E18: Conclusão operacional não duplica lançamentos financeiros
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
const PORT = 54395;

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

let seqCliente = 8000;
let seqPedido = 7000;
let seqProd = 9000;

async function criarProdutoFixture({ nome, preco = 50.00, pontos = 1.00 }) {
  seqProd++;
  const n = nome || `Bolo Teste ${seqProd}`;
  const { rows } = await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, pontos_producao, ativo, controlar_estoque)
    VALUES ($1, $2, $3, $4, true, false)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, preco = EXCLUDED.preco
    RETURNING id;
  `, [seqProd, n, preco, pontos]);
  return Number(rows[0].id);
}

async function criarClienteFixture({ nome, tel, email }) {
  seqCliente++;
  const n = nome || `Cliente Prod ${seqCliente}`;
  const t = tel || `8599${String(seqCliente).padStart(7, '0')}`;
  const tNorm = `55${t.replace(/\D/g, '')}`;
  const e = email || `cliente_prod_${seqCliente}@teste.local`;
  const { rows } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf)
    VALUES ($1, $2, $3, $4, '12345678909')
    RETURNING id;
  `, [n, t, tNorm, e]);
  return Number(rows[0].id);
}

async function criarPedidoFixture({
  clienteId,
  dataEntrega = '2026-10-20',
  horaEntrega = '14:00:00',
  modalidade = 'entrega',
  statusComercial = 'confirmado',
  statusOperacional = 'aguardando_producao',
  total = 120.00,
  qtdItens = 2,
  pontosProducao = 1.50
}) {
  seqPedido++;
  const prodId = await criarProdutoFixture({ preco: total / qtdItens, pontos: pontosProducao });

  const { rows: [p] } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente,
      data_pedido, data_entrega, hora_entrega, total, subtotal, valor_pago, saldo, sinal_minimo,
      status_comercial, status_financeiro, status_operacional, status,
      modalidade_entrega, endereco_entrega, pagamento, itens
    ) VALUES (
      $1, $2, 'Cliente Encomenda', 'cliente@teste.local', '85999990000',
      CURRENT_DATE, $3::DATE, $4::TIME, $5, $5, $5, 0.00, $5 * 0.5,
      $6, 'pago', $7, 'Confirmado',
      $8, 'Rua das Flores, 123', 'pix', 'Bolo de Festa'
    ) RETURNING id;
  `, [seqPedido, clienteId, dataEntrega, horaEntrega, total, statusComercial, statusOperacional, modalidade]);

  // Cria item do pedido com snapshot de carga produtiva
  const precoUnit = total / qtdItens;
  const subtotalItem = total;
  const { rows: [pi] } = await admin.query(`
    INSERT INTO public.pedido_itens (
      pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot,
      subtotal, pontos_producao_snapshot, observacoes
    ) VALUES ($1, $2, 'Bolo Especial', $3, $4, $5, $6, 'Massa branca, recheio brigadeiro')
    RETURNING id;
  `, [p.id, prodId, qtdItens, precoUnit, subtotalItem, pontosProducao]);

  // Cria opção de item para teste de integridade
  await admin.query(`
    INSERT INTO public.pedido_item_opcoes (
      pedido_item_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot
    ) VALUES ($1, 'adicional', 'Topo Personalizado', 15.00, 0.50);
  `, [pi.id]);

  return Number(p.id);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-020',
    port: PORT,
    dbName: 'lunoca_test_020'
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

  await admin.query(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  `);

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
      ('${ADMIN_UID}', 'Admin Chef', 'admin@lunoca.local', 'admin', true),
      ('${OPER_UID}', 'Operador Cozinha', 'operador@lunoca.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente Comum', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;
  `);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// --------------------------------------------------------------------------
// GATE E1: Pedido confirmado aparece na agenda correta
// --------------------------------------------------------------------------
test('E1: pedido confirmado aparece na agenda correta', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E1' });
  const pid = await criarPedidoFixture({
    clienteId: cid,
    dataEntrega: '2026-10-25',
    statusComercial: 'confirmado',
    statusOperacional: 'aguardando_producao'
  });

  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: '2026-10-25',
    p_data_fim: '2026-10-25'
  });

  assert.equal(res.success, true);
  const encontrado = res.pedidos.find(p => p.id === pid);
  assert.ok(encontrado, 'Pedido deve aparecer na agenda do dia 2026-10-25');
  assert.equal(encontrado.status_operacional, 'aguardando_producao');
  assert.equal(encontrado.itens.length, 1);
});

// --------------------------------------------------------------------------
// GATE E2: Pedido cancelado NÃO aparece como produção ativa
// --------------------------------------------------------------------------
test('E2: pedido cancelado NÃO aparece como produção ativa', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E2' });
  const pid = await criarPedidoFixture({
    clienteId: cid,
    dataEntrega: '2026-10-25',
    statusComercial: 'cancelado',
    statusOperacional: 'cancelado'
  });

  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: '2026-10-25',
    p_data_fim: '2026-10-25'
  });

  assert.equal(res.success, true);
  const cancelado = res.pedidos.find(p => p.id === pid);
  assert.equal(cancelado, undefined, 'Pedido cancelado não deve ser listado na agenda operacional');
});

// --------------------------------------------------------------------------
// GATE E3: Operador inicia produção, mas cliente comum recebe PERMISSION_DENIED
// --------------------------------------------------------------------------
test('E3: operador inicia produção, mas cliente recebe PERMISSION_DENIED', async () => {
  const oper = await newClient(OPER_UID);
  const cli = await newClient(CLIENTE_UID);
  const anon = await newClient('anon');

  const cid = await criarClienteFixture({ nome: 'Cliente E3' });
  const pid = await criarPedidoFixture({ clienteId: cid, dataEntrega: '2026-10-26' });

  // Anon é rejeitado (RBAC banco)
  await assert.rejects(async () => {
    await rpc(anon, 'iniciar_producao_pedido', { p_pedido_id: pid });
  }, /permission denied/i);

  // Cliente comum autenticado é rejeitado (PERMISSION_DENIED da RPC)
  const resCli = await rpc(cli, 'iniciar_producao_pedido', { p_pedido_id: pid });
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');

  // Operador tem sucesso
  const resOper = await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  assert.equal(resOper.success, true);
  assert.equal(resOper.status_operacional, 'em_producao');
});

// --------------------------------------------------------------------------
// GATE E4: Duas transições concorrentes não corrompem status (FOR UPDATE)
// --------------------------------------------------------------------------
test('E4: duas transições concorrentes não corrompem status', async () => {
  const oper1 = await newClient(OPER_UID);
  const oper2 = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E4' });
  const pid = await criarPedidoFixture({ clienteId: cid, dataEntrega: '2026-10-26' });

  const [t1, t2] = await Promise.all([
    rpc(oper1, 'iniciar_producao_pedido', { p_pedido_id: pid }),
    rpc(oper2, 'iniciar_producao_pedido', { p_pedido_id: pid })
  ]);

  assert.equal(t1.success, true);
  assert.equal(t2.success, true);
  assert.ok(t1.idempotente || t2.idempotente, 'Uma das chamadas concorrentes deve ser absorvida de forma idempotente');

  const { rows } = await admin.query('SELECT status_operacional FROM public.pedidos WHERE id = $1', [pid]);
  assert.equal(rows[0].status_operacional, 'em_producao');
});

// --------------------------------------------------------------------------
// GATE E5: Não é possível ir de aguardando_producao direto para entregue
// --------------------------------------------------------------------------
test('E5: não é possível ir de aguardando_producao direto para entregue', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E5' });
  const pid = await criarPedidoFixture({
    clienteId: cid,
    dataEntrega: '2026-10-26',
    statusOperacional: 'aguardando_producao'
  });

  const res = await rpc(oper, 'confirmar_entrega_retirada', { p_pedido_id: pid });
  assert.equal(res.success, false);
  assert.equal(res.code, 'INVALID_TRANSITION', 'Deve rejeitar transição direta de aguardando_producao para entregue');
});

// --------------------------------------------------------------------------
// GATE E6: marcar_pedido_pronto exige fluxo válido
// --------------------------------------------------------------------------
test('E6: marcar_pedido_pronto exige fluxo válido', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E6' });
  const pid = await criarPedidoFixture({
    clienteId: cid,
    dataEntrega: '2026-10-26',
    statusOperacional: 'em_producao'
  });

  const res = await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });
  assert.equal(res.success, true);
  assert.equal(res.status_operacional, 'pronto');

  const { rows } = await admin.query('SELECT status_operacional FROM public.pedidos WHERE id = $1', [pid]);
  assert.equal(rows[0].status_operacional, 'pronto');
});

// --------------------------------------------------------------------------
// GATE E7: Entrega e retirada seguem caminhos distintos (saída bloqueada p/ retirada)
// --------------------------------------------------------------------------
test('E7: saída para entrega falha com INVALID_DELIVERY_MODALITY para retirada', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E7' });

  // Pedido na modalidade 'retirada'
  const pidRetirada = await criarPedidoFixture({
    clienteId: cid,
    modalidade: 'retirada',
    statusOperacional: 'pronto'
  });

  const resRetirada = await rpc(oper, 'marcar_saida_entrega', { p_pedido_id: pidRetirada });
  assert.equal(resRetirada.success, false);
  assert.equal(resRetirada.code, 'INVALID_DELIVERY_MODALITY', 'Retirada na loja não tem etapa saiu_para_entrega');

  // Pedido na modalidade 'entrega' tem sucesso
  const pidEntrega = await criarPedidoFixture({
    clienteId: cid,
    modalidade: 'entrega',
    statusOperacional: 'pronto'
  });

  const resEntrega = await rpc(oper, 'marcar_saida_entrega', { p_pedido_id: pidEntrega });
  assert.equal(resEntrega.success, true);
  assert.equal(resEntrega.status_operacional, 'saiu_para_entrega');
});

// --------------------------------------------------------------------------
// GATE E8: Capacidade diária exibida na agenda corresponde à reserva canônica
// --------------------------------------------------------------------------
test('E8: capacidade diária exibida na agenda corresponde à reserva canônica', async () => {
  const oper = await newClient(OPER_UID);
  const dataTeste = '2026-10-28';
  const cid = await criarClienteFixture({ nome: 'Cliente E8' });

  // Cria 2 pedidos de 5 pontos cada = 10 pontos ocupados
  await criarPedidoFixture({ clienteId: cid, dataEntrega: dataTeste, qtdItens: 2, pontosProducao: 2.50 });
  await criarPedidoFixture({ clienteId: cid, dataEntrega: dataTeste, qtdItens: 2, pontosProducao: 2.50 });

  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: dataTeste,
    p_data_fim: dataTeste
  });

  assert.equal(res.success, true);
  const cap = res.capacidades.find(c => c.data === dataTeste);
  assert.ok(cap, 'Capacidade para a data deve ser retornada');
  assert.ok(Number(cap.pontos_ocupados) >= 10.0, 'Pontos ocupados deve computar os itens do dia');
  assert.equal(cap.status_capacidade, 'normal');
});

// --------------------------------------------------------------------------
// GATE E9: Alteração de data revalida capacidade diária
// --------------------------------------------------------------------------
test('E9: alteração de data revalida capacidade diária', async () => {
  const dataA = '2026-10-29';
  const dataB = '2026-10-30';
  const cid = await criarClienteFixture({ nome: 'Cliente E9' });
  const pid = await criarPedidoFixture({ clienteId: cid, dataEntrega: dataA, qtdItens: 2, pontosProducao: 5.00 });

  // Move o pedido de dataA para dataB
  await admin.query('UPDATE public.pedidos SET data_entrega = $1 WHERE id = $2', [dataB, pid]);

  const oper = await newClient(OPER_UID);
  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: dataA,
    p_data_fim: dataB
  });

  const capA = res.capacidades.find(c => c.data === dataA);
  const capB = res.capacidades.find(c => c.data === dataB);

  assert.equal(Number(capA.pontos_ocupados), 0, 'dataA deve estar livre após remanejamento');
  assert.ok(Number(capB.pontos_ocupados) >= 10.0, 'dataB deve receber a carga do pedido');
});

// --------------------------------------------------------------------------
// GATE E10: Histórico operacional registra todas as transições com autor
// --------------------------------------------------------------------------
test('E10: histórico operacional registra todas as transições com autor', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E10' });
  const pid = await criarPedidoFixture({ clienteId: cid, dataEntrega: '2026-10-31', modalidade: 'retirada' });

  await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });
  await rpc(oper, 'confirmar_entrega_retirada', { p_pedido_id: pid });

  const detalhe = await rpc(oper, 'obter_detalhe_producao_pedido', { p_pedido_id: pid });
  assert.equal(detalhe.success, true);
  assert.ok(detalhe.historico_operacional.length >= 3, 'Deve registrar todas as 3 transições operacionais');
  assert.equal(detalhe.historico_operacional[0].status_novo, 'em_producao');
  assert.equal(detalhe.historico_operacional[1].status_novo, 'pronto');
  assert.equal(detalhe.historico_operacional[2].status_novo, 'entregue');
  assert.equal(detalhe.historico_operacional[0].usuario_nome, 'Operador Cozinha');
});

// --------------------------------------------------------------------------
// GATE E11: Observação de produção é persistida e bloqueia DELETE físico
// --------------------------------------------------------------------------
test('E11: observação de produção é persistida e bloqueia DELETE físico', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E11' });
  const pid = await criarPedidoFixture({ clienteId: cid });

  const addObs = await rpc(oper, 'adicionar_observacao_producao', {
    p_pedido_id: pid,
    p_observacao: 'Atenção redobrada: cliente alérgico a corante vermelho',
    p_categoria: 'alergia'
  });

  assert.equal(addObs.success, true);
  const obsId = addObs.observacao_id;

  // Tentativa de DELETE físico deve falhar por trigger
  await assert.rejects(
    async () => {
      await admin.query('DELETE FROM public.pedido_producao_observacoes WHERE id = $1', [obsId]);
    },
    /Exclusão física bloqueada em observações de produção/
  );
});

// --------------------------------------------------------------------------
// GATE E12: Cozinha / agenda de produção NÃO recebe campos financeiros sensíveis
// --------------------------------------------------------------------------
test('E12: agenda de produção NÃO recebe campos financeiros sensíveis (sanitização)', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E12 Financeiro' });
  const pid = await criarPedidoFixture({ clienteId: cid, total: 350.00 });

  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: '2026-10-20',
    p_data_fim: '2026-10-20'
  });

  const p = res.pedidos.find(x => x.id === pid);
  assert.ok(p, 'Pedido deve estar na agenda');
  assert.equal(p.cpf, undefined, 'CPF não deve vazar para a cozinha');
  assert.equal(p.subtotal, undefined, 'Subtotal não deve vazar na agenda operacional');
  assert.equal(p.total, undefined, 'Total monetário não deve estar no card da cozinha');
  assert.equal(p.margem_bruta, undefined, 'Margem não deve estar no card da cozinha');
  assert.ok(p.itens.length > 0, 'Itens devem estar presentes');
});

// --------------------------------------------------------------------------
// GATE E13: Agenda respeita timezone operacional brasileiro
// --------------------------------------------------------------------------
test('E13: agenda respeita timezone operacional brasileiro', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E13' });
  const pid = await criarPedidoFixture({
    clienteId: cid,
    dataEntrega: '2026-11-01',
    horaEntrega: '10:30:00'
  });

  const res = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: '2026-11-01',
    p_data_fim: '2026-11-01'
  });

  const p = res.pedidos.find(x => x.id === pid);
  assert.ok(p);
  assert.equal(p.data_entrega, '2026-11-01');
  assert.equal(p.hora_entrega, '10:30:00');
});

// --------------------------------------------------------------------------
// GATE E14: Filtros por data, status e modalidade funcionam precisamente
// --------------------------------------------------------------------------
test('E14: filtros por status e modalidade funcionam precisamente', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E14' });
  const dataRef = '2026-11-05';

  const pEntrega = await criarPedidoFixture({
    clienteId: cid, dataEntrega: dataRef, modalidade: 'entrega', statusOperacional: 'pronto'
  });
  const pRetirada = await criarPedidoFixture({
    clienteId: cid, dataEntrega: dataRef, modalidade: 'retirada', statusOperacional: 'pronto'
  });

  // Filtra por modalidade entrega
  const resEntrega = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: dataRef,
    p_data_fim: dataRef,
    p_modalidade: 'entrega'
  });
  assert.ok(resEntrega.pedidos.some(p => p.id === pEntrega));
  assert.ok(!resEntrega.pedidos.some(p => p.id === pRetirada));

  // Filtra por modalidade retirada
  const resRetirada = await rpc(oper, 'obter_agenda_producao', {
    p_data_inicio: dataRef,
    p_data_fim: dataRef,
    p_modalidade: 'retirada'
  });
  assert.ok(resRetirada.pedidos.some(p => p.id === pRetirada));
  assert.ok(!resRetirada.pedidos.some(p => p.id === pEntrega));
});

// --------------------------------------------------------------------------
// GATE E15: Pedido com múltiplos itens e opções permanece íntegro
// --------------------------------------------------------------------------
test('E15: pedido com múltiplos itens e opções permanece íntegro', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E15' });
  const pid = await criarPedidoFixture({ clienteId: cid, qtdItens: 3 });

  const detalhe = await rpc(oper, 'obter_detalhe_producao_pedido', { p_pedido_id: pid });
  assert.equal(detalhe.success, true);
  assert.equal(detalhe.itens.length, 1);
  assert.equal(detalhe.itens[0].quantidade, 3);
  assert.equal(detalhe.itens[0].opcoes.length, 1);
  assert.equal(detalhe.itens[0].opcoes[0].nome, 'Topo Personalizado');
});

// --------------------------------------------------------------------------
// GATE E16: Transições repetidas são idempotentes
// --------------------------------------------------------------------------
test('E16: transições repetidas são idempotentes', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E16' });
  const pid = await criarPedidoFixture({ clienteId: cid, statusOperacional: 'aguardando_producao' });

  const r1 = await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  assert.equal(r1.success, true);
  assert.equal(r1.status_operacional, 'em_producao');

  const r2 = await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  assert.equal(r2.success, true);
  assert.equal(r2.idempotente, true, 'Segunda chamada deve retornar idempotente');

  const r3 = await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });
  assert.equal(r3.success, true);

  const r4 = await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });
  assert.equal(r4.success, true);
  assert.equal(r4.idempotente, true);
});

// --------------------------------------------------------------------------
// GATE E17: Evento "pedido pronto" integra com WhatsApp da Frente B
// --------------------------------------------------------------------------
test('E17: evento pedido pronto permite integração com WhatsApp da Frente B', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E17 WhatsApp' });
  const pid = await criarPedidoFixture({ clienteId: cid, modalidade: 'retirada' });

  // Transiciona para pronto gerando histórico
  await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });

  // Consulta preview canônico da Frente B
  const preview = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'PEDIDO_PRONTO',
    p_pedido_id: pid
  });

  assert.equal(preview.success, true);
  assert.equal(preview.tipo, 'PEDIDO_PRONTO');
  assert.ok(preview.mensagem.includes('está pronta! 🎂✨'));
  assert.ok(preview.mensagem.includes('retirada'));
});

// --------------------------------------------------------------------------
// GATE E18: Conclusão operacional NÃO duplica lançamentos financeiros
// --------------------------------------------------------------------------
test('E18: conclusão operacional não duplica lançamentos financeiros', async () => {
  const oper = await newClient(OPER_UID);
  const cid = await criarClienteFixture({ nome: 'Cliente E18 Contábil' });
  const pid = await criarPedidoFixture({ clienteId: cid, total: 200.00 });

  // Conta pagamentos antes da conclusão
  const { rows: pagAntes } = await admin.query('SELECT COUNT(*) as qtd FROM public.pedido_pagamentos WHERE pedido_id = $1', [pid]);

  await rpc(oper, 'iniciar_producao_pedido', { p_pedido_id: pid });
  await rpc(oper, 'marcar_pedido_pronto', { p_pedido_id: pid });
  await rpc(oper, 'marcar_saida_entrega', { p_pedido_id: pid });
  await rpc(oper, 'confirmar_entrega_retirada', { p_pedido_id: pid });

  // Conta pagamentos após a conclusão
  const { rows: pagDepois } = await admin.query('SELECT COUNT(*) as qtd FROM public.pedido_pagamentos WHERE pedido_id = $1', [pid]);

  assert.equal(Number(pagAntes[0].qtd), Number(pagDepois[0].qtd), 'Nenhum pagamento adicional deve ser gerado na conclusão operacional');
});
