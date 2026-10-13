// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE J (PORTAL DO CLIENTE / MINHA CONTA)
// ==============================================================================
// Valida os 16 testes individuais J1 a J16 da Migration 025 contra PostgreSQL real:
// J1:  anon não acessa nenhuma RPC do portal (REVOKE ALL FROM PUBLIC, anon)
// J2:  authenticated sem cliente vinculado falha fechado com CLIENT_LINK_REQUIRED
// J3:  cliente A jamais lê dados (pedidos/orçamentos) do cliente B
// J4:  RPCs públicas do portal não aceitam p_cliente_id vindo do navegador
// J5:  pedido retorna apenas campos sanitizados e etapa_cliente derivada
// J6:  observações internas de produção e motivos técnicos nunca aparecem
// J7:  orçamento próprio é listado sem token_publico
// J8:  aprovação autenticada (aprovar_meu_orcamento) exige versão e propriedade
// J9:  crédito exibido coincide com Frente C
// J10: pontos exibidos coincidem com Frente I
// J11: crédito e pontos permanecem semanticamente e financeiramente isolados
// J12: cupons retornados são elegíveis somente para o próprio cliente
// J13: cliente altera apenas categorias de preferência permitidas (sabor, decoracao, ocasiao, restricao_alimentar, embalagem)
// J14: cliente não acessa nem altera notas/tags administrativas
// J15: opt-out via portal bloqueia marketing imediatamente
// J16: opt-out via portal não bloqueia comunicação transacional (PEDIDO_PRONTO)
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
const PORT = 54394;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID  = '11111111-1111-4111-8111-111111111111';
const OPER_UID   = '22222222-2222-4222-8222-222222222222';
const CLI_A_UID  = 'aaaa1111-1111-4111-8111-111111111111';
const CLI_B_UID  = 'bbbb2222-2222-4222-8222-222222222222';
const UNLINK_UID = 'cccc3333-3333-4333-8333-333333333333';

let cliAId;
let cliBId;
let prodPadraoId;
let pedidoASharedId;
let orcASharedId;
let orcASharedToken;

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

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-025',
    port: PORT,
    dbName: 'lunoca_test_025'
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
    [ADMIN_UID,  'admin-j@lunoca.test',   'Admin Frente J',    'admin'],
    [OPER_UID,   'oper-j@lunoca.test',    'Operador Frente J', 'operador'],
    [CLI_A_UID,  'clientea-j@lunoca.test','Cliente A Portal',  'cliente'],
    [CLI_B_UID,  'clienteb-j@lunoca.test','Cliente B Portal',  'cliente'],
    [UNLINK_UID, 'semvinculo@lunoca.test','Usuário Sem Vínculo','cliente']
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

  await admin.query(`DELETE FROM public.clientes WHERE auth_user_id = $1`, [UNLINK_UID]);

  const { rows: rA } = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente A Portal', '(85) 99888-1111', '5585998881111', 'clientea-j@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome, telefone_normalizado = EXCLUDED.telefone_normalizado
     RETURNING id`,
    [CLI_A_UID]
  );
  cliAId = Number(rA[0].id);

  const { rows: rB } = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente B Portal', '(85) 99888-2222', '5585998882222', 'clienteb-j@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome, telefone_normalizado = EXCLUDED.telefone_normalizado
     RETURNING id`,
    [CLI_B_UID]
  );
  cliBId = Number(rB[0].id);

  const { rows: prodRows } = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Bolo Red Velvet Portal J', 140.00, 100, true, false)
     RETURNING id`
  );
  prodPadraoId = Number(prodRows[0].id);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// ------------------------------------------------------------------------------
// GATE J1: anon não acessa nenhuma RPC do portal
// ------------------------------------------------------------------------------
test('J1: anon não acessa nenhuma RPC do portal (REVOKE EXECUTE FROM PUBLIC, anon)', async () => {
  const anonClient = await newClient('anon');
  const rpcsPortal = [
    'obter_painel_minha_conta_cliente()',
    'listar_meus_pedidos(10, 0)',
    'obter_meu_pedido(1)',
    'listar_meus_orcamentos(10, 0)',
    'aprovar_meu_orcamento(1, 1)',
    'listar_meu_extrato_credito(10, 0)',
    'listar_meu_extrato_pontos(10, 0)',
    'listar_meus_cupons()',
    'listar_minhas_comunicacoes(10, 0)',
    "atualizar_minhas_preferencias_cliente('sabor', 'Chocolate', NULL)",
    "atualizar_meu_consentimento_marketing('whatsapp_marketing', 'opt_out', 'v1.0')"
  ];

  try {
    for (const callExpr of rpcsPortal) {
      await assert.rejects(
        async () => {
          await anonClient.query(`SELECT public.${callExpr}`);
        },
        /permission denied for function/i,
        `Anon deveria ser bloqueado em ${callExpr}`
      );
    }
  } finally {
    await closeClient(anonClient);
  }
});

// ------------------------------------------------------------------------------
// GATE J2: authenticated sem cliente vinculado falha fechado
// ------------------------------------------------------------------------------
test('J2: authenticated sem cliente vinculado em public.clientes falha fechado com CLIENT_LINK_REQUIRED', async () => {
  const unlinked = await newClient(UNLINK_UID);
  try {
    const resPainel = await rpc(unlinked, 'obter_painel_minha_conta_cliente');
    assert.equal(resPainel.success, false);
    assert.equal(resPainel.code, 'CLIENT_LINK_REQUIRED');

    const resPed = await rpc(unlinked, 'listar_meus_pedidos');
    assert.equal(resPed.success, false);
    assert.equal(resPed.code, 'CLIENT_LINK_REQUIRED');

    const resPref = await rpc(unlinked, 'atualizar_minhas_preferencias_cliente', {
      p_categoria: 'sabor',
      p_valor: 'Pistache'
    });
    assert.equal(resPref.success, false);
    assert.equal(resPref.code, 'CLIENT_LINK_REQUIRED');
  } finally {
    await closeClient(unlinked);
  }
});

// ------------------------------------------------------------------------------
// GATE J3: cliente A jamais lê dados do cliente B
// ------------------------------------------------------------------------------
test('J3: cliente A jamais lê pedidos, orçamentos ou dados pertencentes ao cliente B', async () => {
  const { rows: pedB } = await admin.query(
    `INSERT INTO public.pedidos (
       id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente, canal, modalidade_entrega, endereco_entrega,
       data_pedido, data_entrega, hora_entrega, subtotal, total, valor_pago, saldo, sinal_minimo,
       status_comercial, status_financeiro, status_operacional, status, pagamento, itens
     ) VALUES (29001, $1, 'Cliente B Portal', 'b@lunoca.test', '5585998882222', 'whatsapp', 'retirada', 'Retirada na loja', NOW(), CURRENT_DATE + 3, '14:00:00'::TIME, 220.00, 220.00, 220.00, 0.00, 110.00, 'confirmado', 'pago', 'em_producao', 'Confirmado', 'pix', 'Bolo')
     RETURNING id`,
    [cliBId]
  );
  const pedidoBId = Number(pedB[0].id);

  const { rows: orcB } = await admin.query(
    `INSERT INTO public.orcamentos (
       numero, versao, cliente_id, cliente_nome, cliente_telefone,
       data_evento, tipo_entrega, subtotal, total, sinal_sugerido, validade_ate, status
     ) VALUES ('ORC-J3-B', 1, $1, 'Cliente B Portal', '5585998882222', CURRENT_DATE + 7, 'retirada', 300.00, 300.00, 150.00, NOW() + INTERVAL '3 days', 'enviado')
     RETURNING id`,
    [cliBId]
  );
  const orcBId = Number(orcB[0].id);

  const clientA = await newClient(CLI_A_UID);
  try {
    const detB = await rpc(clientA, 'obter_meu_pedido', { p_pedido_id: pedidoBId });
    assert.equal(detB.success, false);
    assert.equal(detB.code, 'ORDER_NOT_FOUND');

    const listaA = await rpc(clientA, 'listar_meus_pedidos');
    assert.equal(listaA.success, true);
    assert.equal(listaA.pedidos.some((p) => Number(p.pedido_id) === pedidoBId), false);

    const apB = await rpc(clientA, 'aprovar_meu_orcamento', { p_orcamento_id: orcBId, p_versao_esperada: 1 });
    assert.equal(apB.success, false);
    assert.equal(apB.code, 'QUOTE_NOT_FOUND');
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J4: RPCs não aceitam cliente_id do navegador
// ------------------------------------------------------------------------------
test('J4: nenhuma RPC pública do portal aceita argumento p_cliente_id ou cliente_id no catálogo pg_proc', async () => {
  const { rows } = await admin.query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'obter_painel_minha_conta_cliente',
        'listar_meus_pedidos',
        'obter_meu_pedido',
        'listar_meus_orcamentos',
        'aprovar_meu_orcamento',
        'listar_meu_extrato_credito',
        'listar_meu_extrato_pontos',
        'listar_meus_cupons',
        'listar_minhas_comunicacoes',
        'atualizar_minhas_preferencias_cliente',
        'atualizar_meu_consentimento_marketing'
      )
  `);

  assert.equal(rows.length, 11);
  for (const r of rows) {
    assert.equal(/cliente_id/i.test(r.args), false, `A RPC ${r.proname} não pode aceitar cliente_id (${r.args})`);
  }
});

// ------------------------------------------------------------------------------
// GATE J5: pedido retorna apenas campos sanitizados
// ------------------------------------------------------------------------------
test('J5: pedido retorna apenas campos sanitizados com etapa_cliente derivada corretamente', async () => {
  const { rows: pedA } = await admin.query(
    `INSERT INTO public.pedidos (
       id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente, canal, modalidade_entrega, endereco_entrega,
       data_pedido, data_entrega, hora_entrega, subtotal, total, valor_pago, saldo, sinal_minimo,
       status_comercial, status_financeiro, status_operacional, status, pagamento, itens,
       observacoes_cliente, observacoes_internas
     ) VALUES (
       29002, $1, 'Cliente A Portal', 'a@lunoca.test', '5585998881111', 'whatsapp', 'retirada', 'Retirada na loja',
       NOW(), CURRENT_DATE + 2, '15:00:00'::TIME, 180.00, 180.00, 90.00, 90.00, 90.00,
       'confirmado', 'parcialmente_pago', 'pronto', 'Confirmado', 'pix', 'Bolo Red Velvet',
       'Escrever Parabéns Ana no topo',
       'SEGREDO_INTERNO_EQUIPE_NAO_EXPOR'
     ) RETURNING id`,
    [cliAId]
  );
  pedidoASharedId = Number(pedA[0].id);

  await admin.query(
    `INSERT INTO public.pedido_itens (pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_base_snapshot, preco_unitario_snapshot, subtotal, cmv_unitario_snapshot, cmv_total_snapshot)
     VALUES ($1, $2, 'Bolo Red Velvet Portal J', 1, 180.00, 180.00, 180.00, 45.00, 45.00)`,
    [pedidoASharedId, prodPadraoId]
  );

  await admin.query(
    `INSERT INTO public.pedido_producao_observacoes (pedido_id, categoria, observacao, autor_id)
     VALUES ($1, 'cozinha', 'NOTA_BANCADA_SECRETA_COZINHA', $2)`,
    [pedidoASharedId, ADMIN_UID]
  );

  const clientA = await newClient(CLI_A_UID);
  try {
    const det = await rpc(clientA, 'obter_meu_pedido', { p_pedido_id: pedidoASharedId });
    assert.equal(det.success, true);
    assert.equal(det.pedido.pedido_id, pedidoASharedId);
    assert.equal(det.pedido.etapa_cliente, 'pronto_para_retirada');
    assert.equal(Number(det.pedido.total), 180.00);
    assert.equal(Number(det.pedido.saldo_a_pagar), 90.00);
    assert.equal(det.pedido.observacoes_cliente, 'Escrever Parabéns Ana no topo');
    assert.equal(det.pedido.itens.length, 1);
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J6: observações internas de produção nunca aparecem
// ------------------------------------------------------------------------------
test('J6: observações internas de produção, custos e segredos de bancada jamais aparecem nas RPCs do portal', async () => {
  const clientA = await newClient(CLI_A_UID);
  try {
    const det = await rpc(clientA, 'obter_meu_pedido', { p_pedido_id: pedidoASharedId });
    const lista = await rpc(clientA, 'listar_meus_pedidos');
    const painel = await rpc(clientA, 'obter_painel_minha_conta_cliente');

    for (const payload of [det, lista, painel]) {
      const jsonStr = JSON.stringify(payload);
      assert.equal(jsonStr.includes('SEGREDO_INTERNO_EQUIPE_NAO_EXPOR'), false);
      assert.equal(jsonStr.includes('NOTA_BANCADA_SECRETA_COZINHA'), false);
      assert.equal(jsonStr.includes('observacoes_internas'), false);
      assert.equal(jsonStr.includes('cmv_unitario_snapshot'), false);
      assert.equal(jsonStr.includes('provider_payment_id'), false);
    }
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J7: orçamento próprio é listado sem token_publico
// ------------------------------------------------------------------------------
test('J7: listar_meus_orcamentos e obter_painel_minha_conta_cliente jamais expõem token_publico', async () => {
  const { rows: orcRows } = await admin.query(
    `INSERT INTO public.orcamentos (
       numero, versao, cliente_id, cliente_nome, cliente_telefone,
       data_evento, tipo_entrega, subtotal, total, sinal_sugerido, validade_ate, status,
       observacoes_internas
     ) VALUES (
       'ORC-J7-A', 2, $1, 'Cliente A Portal', '5585998881111',
       CURRENT_DATE + 10, 'retirada', 250.00, 250.00, 125.00, NOW() + INTERVAL '5 days', 'enviado',
       'MARGEM_INTERNA_CONFIDENCIAL'
     ) RETURNING id, token_publico`,
    [cliAId]
  );
  orcASharedId = Number(orcRows[0].id);
  orcASharedToken = String(orcRows[0].token_publico);

  const clientA = await newClient(CLI_A_UID);
  try {
    const lista = await rpc(clientA, 'listar_meus_orcamentos');
    assert.equal(lista.success, true);

    const rawLista = JSON.stringify(lista);
    assert.equal(rawLista.includes('token_publico'), false, 'token_publico jamais deve existir no JSON do portal');
    assert.equal(rawLista.includes(orcASharedToken), false, 'UUID do token_publico não pode vazar');
    assert.equal(rawLista.includes('MARGEM_INTERNA_CONFIDENCIAL'), false);

    const painel = await rpc(clientA, 'obter_painel_minha_conta_cliente');
    assert.equal(JSON.stringify(painel).includes('token_publico'), false);
    assert.equal(JSON.stringify(painel).includes(orcASharedToken), false);
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J8: aprovação autenticada exige versão e propriedade
// ------------------------------------------------------------------------------
test('J8: aprovar_meu_orcamento exige versão esperada exata e propriedade do cliente autenticado', async () => {
  const clientA = await newClient(CLI_A_UID);
  try {
    const apErr = await rpc(clientA, 'aprovar_meu_orcamento', {
      p_orcamento_id: orcASharedId,
      p_versao_esperada: 1
    });
    assert.equal(apErr.success, false);
    assert.equal(apErr.code, 'QUOTE_VERSION_CHANGED');

    const apOk = await rpc(clientA, 'aprovar_meu_orcamento', {
      p_orcamento_id: orcASharedId,
      p_versao_esperada: 2
    });
    assert.equal(apOk.success, true);
    assert.equal(apOk.status, 'aprovado');
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J9: crédito exibido coincide com Frente C
// ------------------------------------------------------------------------------
test('J9: crédito financeiro exibido no portal coincide ao centavo com a carteira da Frente C', async () => {
  const admClient = await newClient(ADMIN_UID);
  try {
    await rpc(admClient, 'ajustar_credito_cliente_admin', {
      p_cliente_id: cliAId,
      p_tipo: 'credito',
      p_valor: 75.00,
      p_motivo: 'Crédito financeiro teste J9',
      p_request_id: 'j9-cred-cli-a'
    });
  } finally {
    await closeClient(admClient);
  }

  const clientA = await newClient(CLI_A_UID);
  try {
    const extCred = await rpc(clientA, 'listar_meu_extrato_credito');
    assert.equal(extCred.success, true);
    assert.equal(Number(extCred.saldo_reais), 75.00);
    assert.equal(extCred.movimentacoes.length >= 1, true);
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J10: pontos exibidos coincidem com Frente I
// ------------------------------------------------------------------------------
test('J10: pontos de fidelidade exibidos no portal coincidem exatamente com o livro-razão da Frente I', async () => {
  const admClient = await newClient(ADMIN_UID);
  try {
    await rpc(admClient, 'ajustar_pontos_fidelidade_admin', {
      p_cliente_id: cliAId,
      p_natureza: 'credito',
      p_pontos: 320,
      p_motivo: 'Bônus fidelidade teste J10',
      p_chave_idempotencia: 'j10-pts-cli-a'
    });
  } finally {
    await closeClient(admClient);
  }

  const clientA = await newClient(CLI_A_UID);
  try {
    const extPts = await rpc(clientA, 'listar_meu_extrato_pontos');
    assert.equal(extPts.success, true);
    assert.equal(Number(extPts.saldo_pontos), 320);
    assert.equal(extPts.movimentacoes.length >= 1, true);
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J11: crédito e pontos permanecem semanticamente isolados
// ------------------------------------------------------------------------------
test('J11: crédito financeiro (BRL) e pontos promocionais (pts) permanecem semanticamente e estruturalmente isolados no portal', async () => {
  const clientA = await newClient(CLI_A_UID);
  try {
    const painel = await rpc(clientA, 'obter_painel_minha_conta_cliente');
    assert.equal(painel.success, true);
    assert.equal(painel.meu_credito.natureza, 'valor_financeiro');
    assert.equal(painel.meu_credito.moeda, 'BRL');
    assert.equal(Number(painel.meu_credito.saldo_reais), 75.00);

    assert.equal(painel.meus_pontos.natureza, 'beneficio_promocional');
    assert.equal(painel.meus_pontos.unidade, 'pts');
    assert.equal(Number(painel.meus_pontos.saldo_pontos), 320);
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J12: cupons retornados são elegíveis somente para o próprio cliente
// ------------------------------------------------------------------------------
test('J12: listar_meus_cupons retorna apenas cupons vigentes e elegíveis para o próprio cliente', async () => {
  const admClient = await newClient(ADMIN_UID);
  try {
    await rpc(admClient, 'salvar_cupom_promocional_admin', {
      p_codigo: 'PORTAL15',
      p_tipo: 'percentual',
      p_valor: 15,
      p_validade_fim: new Date(Date.now() + 86400000 * 5).toISOString(),
      p_uso_maximo_cliente: 1,
      p_pedido_minimo: 50.00
    });

    await rpc(admClient, 'salvar_cupom_promocional_admin', {
      p_codigo: 'EXPIRADOJ12',
      p_tipo: 'valor_fixo',
      p_valor: 10,
      p_validade_inicio: new Date(Date.now() - 86400000 * 10).toISOString(),
      p_validade_fim: new Date(Date.now() - 86400000 * 1).toISOString()
    });
  } finally {
    await closeClient(admClient);
  }

  const clientA = await newClient(CLI_A_UID);
  try {
    const res1 = await rpc(clientA, 'listar_meus_cupons');
    assert.equal(res1.success, true);
    assert.equal(res1.cupons_disponiveis.some((c) => c.codigo === 'PORTAL15'), true);
    assert.equal(res1.cupons_disponiveis.some((c) => c.codigo === 'EXPIRADOJ12'), false);

    const adm2 = await newClient(ADMIN_UID);
    try {
      await rpc(adm2, 'aplicar_cupom_promocional', {
        p_codigo_cupom: 'PORTAL15',
        p_cliente_id: cliAId,
        p_subtotal: 100.00,
        p_registrar_uso: true,
        p_chave_idempotencia: 'uso-j12-cli-a'
      });
    } finally {
      await closeClient(adm2);
    }

    const resAfterA = await rpc(clientA, 'listar_meus_cupons');
    assert.equal(resAfterA.cupons_disponiveis.some((c) => c.codigo === 'PORTAL15'), false);
    assert.equal(resAfterA.historico_utilizacoes.some((u) => u.codigo === 'PORTAL15'), true);
  } finally {
    await closeClient(clientA);
  }

  const clientB = await newClient(CLI_B_UID);
  try {
    const resB = await rpc(clientB, 'listar_meus_cupons');
    assert.equal(resB.cupons_disponiveis.some((c) => c.codigo === 'PORTAL15'), true);
  } finally {
    await closeClient(clientB);
  }
});

// ------------------------------------------------------------------------------
// GATE J13: cliente altera apenas categorias de preferência permitidas
// ------------------------------------------------------------------------------
test('J13: cliente altera apenas categorias self-service permitidas (sabor, decoracao, ocasiao, restricao_alimentar, embalagem)', async () => {
  const clientA = await newClient(CLI_A_UID);
  try {
    const ok1 = await rpc(clientA, 'atualizar_minhas_preferencias_cliente', {
      p_categoria: 'restricao_alimentar',
      p_valor: 'Intolerância a lactose declarada pelo titular'
    });
    assert.equal(ok1.success, true);

    const ok2 = await rpc(clientA, 'atualizar_minhas_preferencias_cliente', {
      p_categoria: 'embalagem',
      p_valor: 'Caixa rígida com fita lilás'
    });
    assert.equal(ok2.success, true);

    const bloqCat = await rpc(clientA, 'atualizar_minhas_preferencias_cliente', {
      p_categoria: 'atendimento',
      p_valor: 'Tentativa de injetar preferência de atendimento'
    });
    assert.equal(bloqCat.success, false);
    assert.equal(bloqCat.code, 'INVALID_PREFERENCE_CATEGORY');
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J14: cliente não acessa notas/tags administrativas
// ------------------------------------------------------------------------------
test('J14: cliente não acessa nem altera notas internas ou tags administrativas do CRM', async () => {
  const admClient = await newClient(ADMIN_UID);
  try {
    await rpc(admClient, 'adicionar_nota_cliente', {
      p_cliente_id: cliAId,
      p_nota: 'NOTA_INTERNA_ADMIN_J14_SECRETA',
      p_categoria: 'comercial'
    });
    await rpc(admClient, 'adicionar_tag_cliente', {
      p_cliente_id: cliAId,
      p_tag: 'TAG_VIP_INTERNA_J14'
    });
  } finally {
    await closeClient(admClient);
  }

  const clientA = await newClient(CLI_A_UID);
  try {
    const painel = await rpc(clientA, 'obter_painel_minha_conta_cliente');
    const rawPainel = JSON.stringify(painel);
    assert.equal(rawPainel.includes('Intolerância a lactose declarada pelo titular'), true);
    assert.equal(rawPainel.includes('NOTA_INTERNA_ADMIN_J14_SECRETA'), false);
    assert.equal(rawPainel.includes('TAG_VIP_INTERNA_J14'), false);

    const tentNota = await rpc(clientA, 'adicionar_nota_cliente', {
      p_cliente_id: cliAId,
      p_nota: 'Tentativa do cliente',
      p_categoria: 'outro'
    });
    assert.equal(tentNota.success, false);
    assert.equal(tentNota.code, 'PERMISSION_DENIED');
  } finally {
    await closeClient(clientA);
  }
});

// ------------------------------------------------------------------------------
// GATE J15: opt-out via portal bloqueia marketing imediatamente
// ------------------------------------------------------------------------------
test('J15: opt-out registrado pelo cliente no portal bloqueia comunicações de marketing imediatamente', async () => {
  const clientA = await newClient(CLI_A_UID);
  const admClient = await newClient(ADMIN_UID);

  try {
    const cIn = await rpc(clientA, 'atualizar_meu_consentimento_marketing', {
      p_canal: 'whatsapp_marketing',
      p_status: 'opt_in',
      p_versao_termo: 'v1.0-portal'
    });
    assert.equal(cIn.success, true);
    assert.equal(cIn.origem, 'portal_cliente');

    const camp = await rpc(admClient, 'salvar_campanha_admin', {
      p_codigo: 'CAMP_PORTAL_J15',
      p_nome: 'Campanha Teste Portal J15',
      p_tipo_template: 'CAMPANHA_PROMOCIONAL',
      p_mensagem_template: 'Olá {{nome}}, novidade Lunoca!'
    });

    const prevOk = await rpc(admClient, 'obter_preview_comunicacao_marketing', {
      p_tipo: 'CAMPANHA_PROMOCIONAL',
      p_campanha_id: camp.campanha_id,
      p_cliente_id: cliAId
    });
    assert.equal(prevOk.success, true);

    const cOut = await rpc(clientA, 'atualizar_meu_consentimento_marketing', {
      p_canal: 'whatsapp_marketing',
      p_status: 'opt_out',
      p_versao_termo: 'v1.0-portal'
    });
    assert.equal(cOut.success, true);
    assert.equal(cOut.status, 'opt_out');

    const prevBloq = await rpc(admClient, 'obter_preview_comunicacao_marketing', {
      p_tipo: 'CAMPANHA_PROMOCIONAL',
      p_campanha_id: camp.campanha_id,
      p_cliente_id: cliAId
    });
    assert.equal(prevBloq.success, false);
    assert.equal(prevBloq.code, 'MARKETING_OPT_IN_REQUIRED');
  } finally {
    await closeClient(clientA);
    await closeClient(admClient);
  }
});

// ------------------------------------------------------------------------------
// GATE J16: opt-out não bloqueia comunicação transacional
// ------------------------------------------------------------------------------
test('J16: opt-out de marketing não bloqueia comunicações transacionais e listar_minhas_comunicacoes retorna visão sanitizada', async () => {
  const clientA = await newClient(CLI_A_UID);
  const admClient = await newClient(ADMIN_UID);

  try {
    const regTrans = await rpc(admClient, 'registrar_comunicacao_cliente', {
      p_tipo: 'PEDIDO_PRONTO',
      p_orcamento_id: null,
      p_pedido_id: pedidoASharedId,
      p_canal: 'whatsapp_link',
      p_status: 'link_aberto'
    });
    assert.equal(regTrans.success, true);

    const histCom = await rpc(clientA, 'listar_minhas_comunicacoes');
    assert.equal(histCom.success, true);
    assert.equal(histCom.comunicacoes.length >= 1, true);
    const comItem = histCom.comunicacoes[0];
    assert.equal(comItem.tipo, 'PEDIDO_PRONTO');
    assert.equal(comItem.canal, 'whatsapp');
    assert.equal(comItem.status_publico, 'disponibilizado');
    assert.equal('chave_idempotencia' in comItem, false);
    assert.equal('mensagem_snapshot' in comItem, false);
    assert.equal('metadata' in comItem, false);
  } finally {
    await closeClient(clientA);
    await closeClient(admClient);
  }
});
