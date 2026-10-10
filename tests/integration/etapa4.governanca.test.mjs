// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 014
// ==========================================================================
// Valida os 8 probes de governança de catálogo, estoque atômico, portas
// de domínio dedicadas e teto de desconto dinâmico em PostgreSQL REAL.
// ==========================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54397;

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

const P_PROD_TESTE = 9501;

before(async () => {
  if (process.env.DATABASE_URL) {
    connInfo = { connectionString: process.env.DATABASE_URL };
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const pgDir = path.join(ROOT, '.pg-integration-014');
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
    await embedded.createDatabase('lunoca_test_014');
    connInfo = { host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'lunoca_test_014' };
  }

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const install = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8');
  await admin.query(install);

  // Fixtures de usuários (com identity service_role para contornar triggers de profiles.nivel)
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
      ('${CLIENTE_UID}', 'Cliente VIP', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  // Fixture de produto para testes da 014
  await admin.query(`
    INSERT INTO public.produtos (id, nome, preco, descricao, estoque_fisico, estoque_reservado, estoque_qtd, estoque_minimo, controlar_estoque, ativo)
    VALUES (${P_PROD_TESTE}, 'Bolo Trufado 014', 120.00, 'Bolo especial para testes', 20, 5, 15, 3, true, true)
    ON CONFLICT (id) DO UPDATE SET 
      estoque_fisico = 20,
      estoque_reservado = 5,
      estoque_qtd = 15,
      preco = 120.00,
      controlar_estoque = true,
      ativo = true;
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
// PROBE 1: Editar preço de catálogo não altera estoque físico nem reservado
// --------------------------------------------------------------------------
test('G4-1: Editar preço de catálogo não altera estoque físico nem reservado', async () => {
  const adm = await newClient(ADMIN_UID);

  // Consulta estado inicial
  const { rows: [antes] } = await admin.query(`SELECT estoque_fisico, estoque_reservado, estoque_qtd, preco FROM public.produtos WHERE id = ${P_PROD_TESTE}`);
  assert.equal(Number(antes.preco), 120.00);
  assert.equal(antes.estoque_fisico, 20);
  assert.equal(antes.estoque_reservado, 5);
  assert.equal(antes.estoque_qtd, 15);

  // Admin edita apenas dados de catálogo (como o novo produtos.js faz)
  await adm.query(`
    UPDATE public.produtos 
    SET preco = 145.00, descricao = 'Descrição atualizada sem campos de estoque'
    WHERE id = ${P_PROD_TESTE}
  `);

  const { rows: [depois] } = await admin.query(`SELECT estoque_fisico, estoque_reservado, estoque_qtd, preco FROM public.produtos WHERE id = ${P_PROD_TESTE}`);
  assert.equal(Number(depois.preco), 145.00);
  // O estoque permaneceu estritamente intacto
  assert.equal(depois.estoque_fisico, 20, 'Estoque físico não pode ser alterado por edição de preço');
  assert.equal(depois.estoque_reservado, 5, 'Estoque reservado não pode ser alterado por edição de preço');
  assert.equal(depois.estoque_qtd, 15, 'Estoque disponível não pode ser alterado por edição de preço');
});

// --------------------------------------------------------------------------
// PROBE 2: Operador não atualiza produto diretamente (RLS bloqueia UPDATE)
// --------------------------------------------------------------------------
test('G4-2: Operador não atualiza produto diretamente (RLS bloqueia UPDATE)', async () => {
  const oper = await newClient(OPER_UID);

  // Operador tenta fazer UPDATE direto no produto
  const res = await oper.query(`
    UPDATE public.produtos 
    SET preco = 10.00 
    WHERE id = ${P_PROD_TESTE}
  `);

  // Com RLS fail-closed, UPDATE de operador afeta 0 linhas
  assert.equal(res.rowCount, 0, 'Operador não pode ter permissão de UPDATE direto na tabela produtos');

  // Garante que o preço no banco não foi modificado
  const { rows: [p] } = await admin.query(`SELECT preco FROM public.produtos WHERE id = ${P_PROD_TESTE}`);
  assert.equal(Number(p.preco), 145.00);
});

// --------------------------------------------------------------------------
// PROBE 3: Ajuste via RPC gerar movimentação atômica em estoque_movimentacoes
// --------------------------------------------------------------------------
test('G4-3: Ajuste via RPC ajustar_estoque_operacao() registra movimentação atômica', async () => {
  const oper = await newClient(OPER_UID);

  const res = await rpc(oper, 'ajustar_estoque_operacao', {
    p_produto_id: P_PROD_TESTE,
    p_tipo: 'entrada',
    p_quantidade: 10,
    p_novo_saldo_fisico: null,
    p_motivo: 'Entrada de lote fornecedor'
  });

  assert.equal(res.success, true);
  assert.equal(res.estoque_fisico_anterior, 20);
  assert.equal(res.estoque_fisico_novo, 30);
  assert.equal(res.estoque_qtd_novo, 25); // 30 físico - 5 reservado = 25 disponível

  // Verifica que a movimentação foi gravada em estoque_movimentacoes na mesma transação
  const { rows: movs } = await admin.query(`
    SELECT * FROM public.estoque_movimentacoes 
    WHERE id = $1
  `, [res.movimentacao_id]);

  assert.equal(movs.length, 1);
  assert.equal(movs[0].tipo, 'entrada');
  assert.equal(movs[0].quantidade, 10);
  assert.equal(movs[0].saldo_resultante, 30);
  assert.equal(movs[0].usuario_nome, 'Operador Balcao');
});

// --------------------------------------------------------------------------
// PROBE 4: Contagem abaixo do reservado falha com RESERVED_STOCK_CONFLICT
// --------------------------------------------------------------------------
test('G4-4: Contagem de inventário abaixo do reservado falha com RESERVED_STOCK_CONFLICT', async () => {
  const oper = await newClient(OPER_UID);

  // Saldo físico atual = 30, reservado ativo = 5
  // Tentativa de ajustar contagem para 3 (menor que o reservado 5)
  const res = await rpc(oper, 'ajustar_estoque_operacao', {
    p_produto_id: P_PROD_TESTE,
    p_tipo: 'contagem',
    p_quantidade: null,
    p_novo_saldo_fisico: 3,
    p_motivo: 'Contagem com erro'
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'RESERVED_STOCK_CONFLICT');
  assert.match(res.error, /não pode ser menor que o estoque reservado ativo/);

  // Garante que o estoque físico continuou em 30
  const { rows: [p] } = await admin.query(`SELECT estoque_fisico FROM public.produtos WHERE id = ${P_PROD_TESTE}`);
  assert.equal(p.estoque_fisico, 30);
});

// --------------------------------------------------------------------------
// PROBE 5: Operador não desativa controlar_estoque (Trigger bloqueia)
// --------------------------------------------------------------------------
test('G4-5: Operador não desativa controlar_estoque', async () => {
  const oper = await newClient(OPER_UID);

  // Operador tentando alterar controlar_estoque via query direta
  const res = await oper.query(`
    UPDATE public.produtos 
    SET controlar_estoque = false 
    WHERE id = ${P_PROD_TESTE}
  `);
  // RLS bloqueia o update
  assert.equal(res.rowCount, 0);

  // Verifica que controlar_estoque continua true
  const { rows: [p] } = await admin.query(`SELECT controlar_estoque FROM public.produtos WHERE id = ${P_PROD_TESTE}`);
  assert.equal(p.controlar_estoque, true);
});

// --------------------------------------------------------------------------
// PROBE 6: Cancelamento com valor pago exige destino do valor
// --------------------------------------------------------------------------
test('G4-6: Cancelamento pago não usa setter genérico sem destino do valor', async () => {
  const oper = await newClient(OPER_UID);

  // Cria pedido fixture com valor pago de R$ 50,00
  const { rows: [ped] } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, data_entrega, total, subtotal, valor_pago, sinal_minimo, pagamento, status_comercial, status_operacional, status_financeiro
    ) VALUES (
      'Cliente Cancelamento', 'canc@test.local', CURRENT_DATE + 5, 100.00, 100.00, 50.00, 50.00, 'pix', 'aguardando_confirmacao', 'aguardando_producao', 'parcialmente_pago'
    ) RETURNING id;
  `);

  // Operador tenta cancelar via porta dedicada sem destino do valor
  const r1 = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: ped.id,
    p_motivo: 'Cliente desistiu',
    p_destino_valor: null
  });

  assert.equal(r1.success, false);
  assert.equal(r1.code, 'CANCELLATION_REQUIRES_VALUE_DESTINATION');

  // Operador cancela fornecendo destino do valor RETENCAO_CANCELAMENTO
  const r2 = await rpc(oper, 'cancelar_pedido_equipe', {
    p_pedido_id: ped.id,
    p_motivo: 'Cliente desistiu com sinal retido',
    p_destino_valor: 'RETENCAO_CANCELAMENTO'
  });

  assert.equal(r2.success, true);
  assert.equal(r2.status_comercial, 'cancelado');

  const { rows: [pedCheck] } = await admin.query(`SELECT status_comercial FROM public.pedidos WHERE id = $1`, [ped.id]);
  assert.equal(pedCheck.status_comercial, 'cancelado');
});

// --------------------------------------------------------------------------
// PROBE 7: Confirmação excepcional passa por RPC dedicada e exige motivo
// --------------------------------------------------------------------------
test('G4-7: Confirmação excepcional sem sinal passa por gerenciar_confirmacao_pedido_admin()', async () => {
  const oper = await newClient(OPER_UID);
  const adm = await newClient(ADMIN_UID);

  // Pedido fixture sem sinal pago (valor_pago = 0, sinal_minimo = 50)
  const { rows: [ped] } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, data_entrega, total, subtotal, valor_pago, sinal_minimo, pagamento, status_comercial, status_operacional
    ) VALUES (
      'Cliente Sem Sinal', 'semsinal@test.local', CURRENT_DATE + 6, 100.00, 100.00, 0.00, 50.00, 'pix', 'aguardando_confirmacao', 'aguardando_producao'
    ) RETURNING id;
  `);

  // Operador tenta confirmar excepcional -> Erro de permissão
  const rOper = await rpc(oper, 'gerenciar_confirmacao_pedido_admin', {
    p_pedido_id: ped.id,
    p_motivo: 'Operador tentando'
  });
  assert.equal(rOper.success, false);
  assert.equal(rOper.code, 'PERMISSION_DENIED');

  // Admin tenta confirmar com motivo curto (< 5 chars) -> Erro
  const rCurto = await rpc(adm, 'gerenciar_confirmacao_pedido_admin', {
    p_pedido_id: ped.id,
    p_motivo: 'Ok'
  });
  assert.equal(rCurto.success, false);
  assert.equal(rCurto.code, 'REASON_REQUIRED');

  // Admin confirma com justificativa válida (>= 5 chars)
  const rOk = await rpc(adm, 'gerenciar_confirmacao_pedido_admin', {
    p_pedido_id: ped.id,
    p_motivo: 'Autorização extraordinária concedida pela gerência'
  });
  assert.equal(rOk.success, true);
  assert.equal(rOk.status_comercial, 'confirmado');
});

// --------------------------------------------------------------------------
// PROBE 8: Limite de desconto vem dinamicamente da configuração
// --------------------------------------------------------------------------
test('G4-8: Limite de desconto de operador vem dinamicamente de configuracoes_operacao', async () => {
  const oper = await newClient(OPER_UID);

  // Configuração padrão: desconto_operador_percentual_max = 10.00%
  // Teste com 12% de desconto para subtotal de R$ 100,00 (desconto de R$ 12,00)
  const r1 = await rpc(oper, 'politica_desconto', {
    p_subtotal: 100.00,
    p_desconto: 12.00,
    p_motivo: 'Tentativa de 12%'
  });
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED');
  assert.equal(r1.teto_operador_percentual, 10.00);

  // Admin altera a configuração dinâmica para permitir até 15.00%
  await admin.query(`
    UPDATE public.configuracoes_operacao
    SET desconto_operador_percentual_max = 15.00
    WHERE id = 1
  `);

  // O mesmo desconto de 12% agora é aprovado com sucesso para o operador
  const r2 = await rpc(oper, 'politica_desconto', {
    p_subtotal: 100.00,
    p_desconto: 12.00,
    p_motivo: 'Desconto de 12% agora dentro da nova margem'
  });
  assert.equal(r2.success, true);
  assert.equal(r2.desconto_aprovado, 12.00);
  assert.equal(r2.percentual, 12.00);
  assert.equal(r2.excecao_admin, false);

  // Restaura configuração para 10.00%
  await admin.query(`
    UPDATE public.configuracoes_operacao
    SET desconto_operador_percentual_max = 10.00
    WHERE id = 1
  `);
});
