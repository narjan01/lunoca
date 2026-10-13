// ==============================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - MIGRATION 024 (FRENTE I)
// ==============================================================================
// Valida os 18 gates obrigatórios (I1 a I18) de Fidelidade, Recompra,
// Cupons Promocionais, Consentimento de Marketing e Campanhas:
//
// - I1:  Compra concluída gera pontos uma vez
// - I2:  Retry não duplica pontos (idempotência)
// - I3:  Cancelamento gera movimentação compensatória sem apagar ganho anterior
// - I4:  Pontos nunca ficam negativos e bloqueiam UPDATE direto em cliente_pontos
// - I5:  Dois resgates concorrentes não gastam o mesmo saldo (lock FOR UPDATE)
// - I6:  Resgate parcial funciona e preserva saldo remanescente
// - I7:  Pontos expirados não podem ser usados no resgate
// - I8:  Expiração de pontos é estritamente idempotente
// - I9:  Operador não ajusta pontos arbitrariamente (PERMISSION_DENIED)
// - I10: Admin ajusta com motivo obrigatório (>= 5 chars) e livro-razão é append-only
// - I11: Cupom válido aplica desconto correto (percentual e valor fixo)
// - I12: Cupom expirado ou reutilizado além do limite é rejeitado
// - I13: Desconto combinado (cupom + manual + frete + pontos) respeita teto global
// - I14: Marketing sem opt-in é bloqueado (MARKETING_OPT_IN_REQUIRED)
// - I15: Opt-out prevalece imediatamente sobre opt-in anterior
// - I16: Comunicação transacional continua permitida mesmo com opt-out de marketing
// - I17: Campanha não duplica destinatário em disparos repetidos
// - I18: Crédito financeiro (Frente C) nunca é afetado por pontos ou cupons
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
const PORT = 54393;

let embedded = null;
let admin;
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

let seqCli = 9000;
let seqPed = 19000;

async function criarClienteFixture(nome = 'Cliente Fidelidade', dataNascimento = '1992-10-15') {
  seqCli++;
  const tel = `8598${String(seqCli).padStart(7, '0')}`;
  const { rows: [cli] } = await admin.query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf, data_nascimento)
    VALUES ($1, $2, $3, $4, '12345678909', $5::DATE)
    RETURNING id;
  `, [`${nome} #${seqCli}`, tel, `55${tel}`, `fidelidade_${seqCli}@lunoca.local`, dataNascimento]);
  return Number(cli.id);
}

async function criarPedidoFixture({
  clienteId,
  total = 150.00,
  desconto = 0.00,
  statusComercial = 'confirmado',
  statusOperacional = 'aguardando_producao'
}) {
  seqPed++;
  const { rows: [ped] } = await admin.query(`
    INSERT INTO public.pedidos (
      id, cliente_id_rel, nome_cliente, email_cliente, telefone_cliente,
      data_pedido, data_entrega, hora_entrega,
      total, subtotal, desconto, valor_pago, saldo, sinal_minimo,
      status_comercial, status_financeiro, status_operacional, status,
      modalidade_entrega, endereco_entrega, pagamento, itens
    ) VALUES (
      $1, $2, 'Cliente Fidelidade', 'cli@lunoca.local', '85988887777',
      NOW(), CURRENT_DATE + 2, '15:00:00'::TIME,
      $3::NUMERIC, ($3::NUMERIC + $4::NUMERIC), $4::NUMERIC, $3::NUMERIC, 0.00, ROUND($3::NUMERIC * 0.30, 2),
      $5, 'pago', $6, 'Confirmado',
      'retirada', 'Retirada no Balcão', 'pix', 'Bolo Especial'
    ) RETURNING id;
  `, [seqPed, clienteId, total, desconto, statusComercial, statusOperacional]);
  return Number(ped.id);
}

async function limparFidelidade() {
  await admin.query(`
    TRUNCATE TABLE
      public.campanha_publicos,
      public.cupom_utilizacoes,
      public.cupons_promocionais,
      public.campanhas,
      public.cliente_consentimentos_marketing,
      public.cliente_pontos_movimentacoes,
      public.cliente_pontos,
      public.comunicacoes_cliente,
      public.cliente_credito_movimentacoes,
      public.cliente_creditos
    RESTART IDENTITY CASCADE;
  `);
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-024',
    port: PORT,
    dbName: 'lunoca_test_024'
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
      ('${OPER_UID}', 'Operador Caixa', 'operador@lunoca.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente Comum', 'cliente@lunoca.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;
  `);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// ------------------------------------------------------------------------------
// GATE I1: Compra concluída gera pontos uma vez
// ------------------------------------------------------------------------------
test('I1: compra concluída gera pontos exatamente uma vez (pedido confirmado ainda não gera)', async () => {
  await limparFidelidade();
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente I1');
  const pedId = await criarPedidoFixture({ clienteId: cliId, total: 150.00, statusComercial: 'confirmado' });

  // Enquanto apenas confirmado, tentativa de creditar pontos retorna ORDER_NOT_COMPLETED
  const antes = await rpc(oper, 'creditar_pontos_pedido_concluido', { p_pedido_id: pedId });
  assert.equal(antes.success, false);
  assert.equal(antes.code, 'ORDER_NOT_COMPLETED');

  // Conclui o pedido -> trigger credita pontos automaticamente
  await admin.query(`UPDATE public.pedidos SET status_comercial = 'concluido' WHERE id = $1`, [pedId]);

  const { rows: [cp] } = await admin.query(`SELECT * FROM public.cliente_pontos WHERE cliente_id = $1`, [cliId]);
  assert.equal(Number(cp.saldo_pontos), 150);
  assert.equal(Number(cp.pontos_acumulados_total), 150);
});

// ------------------------------------------------------------------------------
// GATE I2: Retry não duplica pontos
// ------------------------------------------------------------------------------
test('I2: retry de creditar_pontos_pedido_concluido é idempotente e não duplica pontos', async () => {
  await limparFidelidade();
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente I2');
  const pedId = await criarPedidoFixture({ clienteId: cliId, total: 200.00, statusComercial: 'confirmado' });

  await admin.query(`UPDATE public.pedidos SET status_comercial = 'concluido' WHERE id = $1`, [pedId]);

  // Chamar explicitamente a RPC mais duas vezes (retries)
  const r1 = await rpc(oper, 'creditar_pontos_pedido_concluido', { p_pedido_id: pedId });
  assert.equal(r1.success, true);
  assert.equal(r1.idempotente, true);
  assert.equal(Number(r1.saldo_atual), 200);

  const r2 = await rpc(oper, 'creditar_pontos_pedido_concluido', { p_pedido_id: pedId });
  assert.equal(r2.success, true);
  assert.equal(r2.idempotente, true);

  const { rows } = await admin.query(
    `SELECT * FROM public.cliente_pontos_movimentacoes WHERE cliente_id = $1 AND tipo = 'GANHO_COMPRA'`,
    [cliId]
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].pontos), 200);
});

// ------------------------------------------------------------------------------
// GATE I3: Cancelamento gera compensação sem apagar o ganho original
// ------------------------------------------------------------------------------
test('I3: cancelamento de pedido concluído gera movimentação compensatória sem apagar o ganho anterior', async () => {
  await limparFidelidade();
  const cliId = await criarClienteFixture('Cliente I3');
  const pedId = await criarPedidoFixture({ clienteId: cliId, total: 180.00, statusComercial: 'confirmado' });

  await admin.query(`UPDATE public.pedidos SET status_comercial = 'concluido' WHERE id = $1`, [pedId]);

  // Agora cancela o pedido
  await admin.query(`UPDATE public.pedidos SET status_comercial = 'cancelado' WHERE id = $1`, [pedId]);

  const { rows: [cp] } = await admin.query(`SELECT * FROM public.cliente_pontos WHERE cliente_id = $1`, [cliId]);
  assert.equal(Number(cp.saldo_pontos), 0);

  const { rows: movs } = await admin.query(
    `SELECT tipo, natureza, pontos, saldo_posterior FROM public.cliente_pontos_movimentacoes WHERE cliente_id = $1 ORDER BY id ASC`,
    [cliId]
  );
  assert.equal(movs.length, 2);
  assert.equal(movs[0].tipo, 'GANHO_COMPRA');
  assert.equal(movs[0].natureza, 'credito');
  assert.equal(Number(movs[0].pontos), 180);
  assert.equal(movs[1].tipo, 'COMPENSACAO_CANCELAMENTO');
  assert.equal(movs[1].natureza, 'debito');
  assert.equal(Number(movs[1].pontos), 180);
  assert.equal(Number(movs[1].saldo_posterior), 0);
});

// ------------------------------------------------------------------------------
// GATE I4: Pontos nunca ficam negativos e UPDATE direto em cliente_pontos é bloqueado
// ------------------------------------------------------------------------------
test('I4: pontos nunca ficam negativos e UPDATE direto em cliente_pontos fora da porta canônica falha', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I4');

  await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 50,
    p_motivo: 'Crédito inicial de teste I4'
  });

  // Tentativa de resgatar mais do que o saldo disponível
  const resInsuf = await rpc(adm, 'resgatar_pontos_fidelidade', {
    p_cliente_id: cliId,
    p_pontos: 80
  });
  assert.equal(resInsuf.success, false);
  assert.equal(resInsuf.code, 'INSUFFICIENT_POINTS_BALANCE');

  // Tentativa de UPDATE direto na tabela cliente_pontos mesmo como superuser sem a flag transacional
  await assert.rejects(
    async () => {
      await admin.query(`UPDATE public.cliente_pontos SET saldo_pontos = 9999 WHERE cliente_id = $1`, [cliId]);
    },
    (err) => err.code === '42501'
  );
});

// ------------------------------------------------------------------------------
// GATE I5: Dois resgates concorrentes não gastam o mesmo saldo
// ------------------------------------------------------------------------------
test('I5: dois resgates concorrentes não gastam o mesmo saldo (serialização FOR UPDATE)', async () => {
  await limparFidelidade();
  const c1 = await newClient(OPER_UID);
  const c2 = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I5 Concorrência');

  await rpc(c2, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 100,
    p_motivo: 'Saldo para teste de concorrência I5'
  });

  // Dispara dois resgates concorrentes de 70 pontos cada para um saldo de 100
  const [r1, r2] = await Promise.all([
    rpc(c1, 'resgatar_pontos_fidelidade', { p_cliente_id: cliId, p_pontos: 70, p_chave_idempotencia: 'conc-1' }),
    rpc(c2, 'resgatar_pontos_fidelidade', { p_cliente_id: cliId, p_pontos: 70, p_chave_idempotencia: 'conc-2' })
  ]);

  const sucessos = [r1, r2].filter((r) => r.success === true);
  const falhas = [r1, r2].filter((r) => r.success === false && r.code === 'INSUFFICIENT_POINTS_BALANCE');

  assert.equal(sucessos.length, 1, 'Apenas um dos resgates concorrentes pode suceder');
  assert.equal(falhas.length, 1, 'O segundo resgate concorrente deve falhar com INSUFFICIENT_POINTS_BALANCE');

  const { rows: [cp] } = await admin.query(`SELECT saldo_pontos FROM public.cliente_pontos WHERE cliente_id = $1`, [cliId]);
  assert.equal(Number(cp.saldo_pontos), 30);
});

// ------------------------------------------------------------------------------
// GATE I6: Resgate parcial funciona
// ------------------------------------------------------------------------------
test('I6: resgate parcial deduz exatamente os pontos solicitados e calcula benefício em reais', async () => {
  await limparFidelidade();
  const oper = await newClient(OPER_UID);
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I6');

  await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 200,
    p_motivo: 'Saldo inicial para resgate parcial'
  });

  const res = await rpc(oper, 'resgatar_pontos_fidelidade', {
    p_cliente_id: cliId,
    p_pontos: 60
  });
  assert.equal(res.success, true);
  assert.equal(Number(res.saldo_anterior), 200);
  assert.equal(Number(res.saldo_posterior), 140);
  // 60 pontos * R$ 0,05 = R$ 3,00
  assert.equal(Number(res.valor_beneficio_reais), 3.00);
});

// ------------------------------------------------------------------------------
// GATE I7: Pontos expirados não podem ser usados
// ------------------------------------------------------------------------------
test('I7: pontos expirados são automaticamente baixados antes do resgate e não podem ser usados', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente I7 Expirado');

  // Credita 120 pontos já vencidos ontem
  const { rows: [ontem] } = await admin.query(`SELECT (NOW() - INTERVAL '2 days')::TIMESTAMPTZ AS dt`);
  await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 120,
    p_motivo: 'Lote com validade vencida para I7',
    p_expira_em: ontem.dt
  });

  // Tentativa de resgatar 50 pontos -> deve expirar os 120 primeiro e retornar INSUFFICIENT_POINTS_BALANCE
  const res = await rpc(oper, 'resgatar_pontos_fidelidade', {
    p_cliente_id: cliId,
    p_pontos: 50
  });
  assert.equal(res.success, false);
  assert.equal(res.code, 'INSUFFICIENT_POINTS_BALANCE');
  assert.equal(Number(res.saldo_atual), 0);
});

// ------------------------------------------------------------------------------
// GATE I8: Expiração é idempotente
// ------------------------------------------------------------------------------
test('I8: expirar_pontos_fidelidade é estritamente idempotente em execuções repetidas', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I8');

  const { rows: [passado] } = await admin.query(`SELECT (NOW() - INTERVAL '5 days')::TIMESTAMPTZ AS dt`);
  await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 90,
    p_motivo: 'Lote expirado I8',
    p_expira_em: passado.dt
  });

  const exp1 = await rpc(adm, 'expirar_pontos_fidelidade', { p_cliente_id: cliId });
  assert.equal(exp1.success, true);
  assert.equal(Number(exp1.pontos_expirados), 90);
  assert.equal(Number(exp1.saldo_atual), 0);

  // Segunda execução (retry)
  const exp2 = await rpc(adm, 'expirar_pontos_fidelidade', { p_cliente_id: cliId });
  assert.equal(exp2.success, true);
  assert.equal(Number(exp2.pontos_expirados), 0);
  assert.equal(Number(exp2.saldo_atual), 0);

  const { rows } = await admin.query(
    `SELECT * FROM public.cliente_pontos_movimentacoes WHERE cliente_id = $1 AND tipo = 'EXPIRACAO'`,
    [cliId]
  );
  assert.equal(rows.length, 1);
});

// ------------------------------------------------------------------------------
// GATE I9: Operador não ajusta pontos arbitrariamente
// ------------------------------------------------------------------------------
test('I9: operador é bloqueado com PERMISSION_DENIED ao tentar ajustar pontos manualmente', async () => {
  await limparFidelidade();
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente I9');

  const res = await rpc(oper, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 500,
    p_motivo: 'Tentativa indevida de operador'
  });
  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');
});

// ------------------------------------------------------------------------------
// GATE I10: Admin ajusta com motivo obrigatório e livro-razão é imutável
// ------------------------------------------------------------------------------
test('I10: admin exige motivo válido (>= 5 chars) para ajuste e livro-razão bloqueia UPDATE/DELETE', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I10');

  const semMotivo = await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 100,
    p_motivo: 'abc'
  });
  assert.equal(semMotivo.success, false);
  assert.equal(semMotivo.code, 'REASON_REQUIRED');

  const comMotivo = await rpc(adm, 'ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: 'credito',
    p_pontos: 100,
    p_motivo: 'Bonificação autorizada pela diretoria'
  });
  assert.equal(comMotivo.success, true);

  await assert.rejects(
    async () => {
      await admin.query(`DELETE FROM public.cliente_pontos_movimentacoes WHERE id = $1`, [comMotivo.movimentacao_id]);
    },
    (err) => err.code === '42501'
  );
});

// ------------------------------------------------------------------------------
// GATE I11: Cupom válido aplica desconto correto
// ------------------------------------------------------------------------------
test('I11: cupom promocional válido calcula e aplica desconto percentual e valor fixo com precisão', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I11');

  const { rows: [futuro] } = await admin.query(`SELECT (NOW() + INTERVAL '10 days')::TIMESTAMPTZ AS dt`);
  await rpc(adm, 'salvar_cupom_promocional_admin', {
    p_codigo: 'DOCE10',
    p_tipo: 'percentual',
    p_valor: 10.00,
    p_validade_fim: futuro.dt,
    p_uso_maximo_cliente: 2,
    p_pedido_minimo: 100.00
  });

  const ap = await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'doce10',
    p_cliente_id: cliId,
    p_subtotal: 250.00
  });
  assert.equal(ap.success, true);
  assert.equal(Number(ap.desconto_cupom), 25.00);
  assert.equal(Number(ap.total_liquido), 225.00);
});

// ------------------------------------------------------------------------------
// GATE I12: Cupom expirado ou reutilizado além do limite é rejeitado
// ------------------------------------------------------------------------------
test('I12: cupom expirado (COUPON_EXPIRED) ou já utilizado pelo cliente (COUPON_CLIENT_LIMIT_REACHED) é rejeitado', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I12');

  const { rows: [datas] } = await admin.query(`
    SELECT
      (NOW() - INTERVAL '10 days')::TIMESTAMPTZ AS inicio_venc,
      (NOW() - INTERVAL '1 day')::TIMESTAMPTZ AS fim_venc,
      (NOW() + INTERVAL '5 days')::TIMESTAMPTZ AS fim_valido
  `);

  await rpc(adm, 'salvar_cupom_promocional_admin', {
    p_codigo: 'VENCIDO20',
    p_tipo: 'valor_fixo',
    p_valor: 20.00,
    p_validade_inicio: datas.inicio_venc,
    p_validade_fim: datas.fim_venc
  });

  const resVenc = await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'VENCIDO20',
    p_cliente_id: cliId,
    p_subtotal: 200.00
  });
  assert.equal(resVenc.success, false);
  assert.equal(resVenc.code, 'COUPON_EXPIRED');

  // Cupom de uso único por cliente
  await rpc(adm, 'salvar_cupom_promocional_admin', {
    p_codigo: 'UNICO15',
    p_tipo: 'valor_fixo',
    p_valor: 15.00,
    p_validade_fim: datas.fim_valido,
    p_uso_maximo_cliente: 1
  });

  const uso1 = await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'UNICO15',
    p_cliente_id: cliId,
    p_subtotal: 200.00,
    p_chave_idempotencia: 'uso-1'
  });
  assert.equal(uso1.success, true);

  const uso2 = await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'UNICO15',
    p_cliente_id: cliId,
    p_subtotal: 200.00,
    p_chave_idempotencia: 'uso-2'
  });
  assert.equal(uso2.success, false);
  assert.equal(uso2.code, 'COUPON_CLIENT_LIMIT_REACHED');
});

// ------------------------------------------------------------------------------
// GATE I13: Desconto combinado respeita política global (não contorna teto do operador)
// ------------------------------------------------------------------------------
test('I13: desconto combinado (cupom + manual + frete + pontos) bloqueia operador acima do teto global de 10%', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente I13');

  const { rows: [futuro] } = await admin.query(`SELECT (NOW() + INTERVAL '5 days')::TIMESTAMPTZ AS dt`);
  await rpc(adm, 'salvar_cupom_promocional_admin', {
    p_codigo: 'CUPOM6',
    p_tipo: 'percentual',
    p_valor: 6.00,
    p_validade_fim: futuro.dt
  });

  // Operador tenta combinar cupom de 6% (R$ 12) + desconto manual R$ 8 + frete R$ 5 = R$ 25 (12,5% > 10% teto operador)
  const resOper = await rpc(oper, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'CUPOM6',
    p_cliente_id: cliId,
    p_subtotal: 200.00,
    p_desconto_manual: 8.00,
    p_desconto_frete: 5.00,
    p_motivo: 'Tentativa de acumular descontos acima do teto'
  });
  assert.equal(resOper.success, false);
  assert.equal(resOper.code, 'OPERATOR_DISCOUNT_LIMIT_EXCEEDED');

  // Admin aprova o mesmo desconto combinado com justificativa
  const resAdm = await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'CUPOM6',
    p_cliente_id: cliId,
    p_subtotal: 200.00,
    p_desconto_manual: 8.00,
    p_desconto_frete: 5.00,
    p_motivo: 'Aprovação gerencial de campanha combinada'
  });
  assert.equal(resAdm.success, true);
  assert.equal(Number(resAdm.desconto_total_combinado), 25.00);
});

// ------------------------------------------------------------------------------
// GATE I14: Marketing sem opt-in é bloqueado
// ------------------------------------------------------------------------------
test('I14: envio de template de marketing sem opt-in explícito é bloqueado com MARKETING_OPT_IN_REQUIRED', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente Sem OptIn');

  const camp = await rpc(adm, 'salvar_campanha_admin', {
    p_codigo: 'CAMP_ANIV_I14',
    p_nome: 'Aniversariantes do Mês',
    p_tipo_template: 'CUPOM_ANIVERSARIO',
    p_mensagem_template: 'Parabéns {{nome}}! Use o cupom {{cupom}}!'
  });

  const prev = await rpc(adm, 'obter_preview_comunicacao_marketing', {
    p_tipo: 'CUPOM_ANIVERSARIO',
    p_campanha_id: camp.campanha_id,
    p_cliente_id: cliId
  });
  assert.equal(prev.success, false);
  assert.equal(prev.code, 'MARKETING_OPT_IN_REQUIRED');
});

// ------------------------------------------------------------------------------
// GATE I15: Opt-out prevalece imediatamente
// ------------------------------------------------------------------------------
test('I15: opt-out registrado após opt-in prevalece imediatamente e bloqueia marketing', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente OptOut');

  const camp = await rpc(adm, 'salvar_campanha_admin', {
    p_codigo: 'CAMP_PASCOA_I15',
    p_nome: 'Campanha Páscoa',
    p_tipo_template: 'CAMPANHA_PASCOA',
    p_mensagem_template: 'Olá {{nome}}, confira nosso menu de Páscoa!'
  });

  // 1. Registra opt_in
  await rpc(adm, 'registrar_consentimento_marketing', {
    p_cliente_id: cliId,
    p_canal: 'whatsapp_marketing',
    p_status: 'opt_in',
    p_origem: 'cadastro_loja',
    p_versao_termo: 'v1.0'
  });

  const prevOk = await rpc(adm, 'obter_preview_comunicacao_marketing', {
    p_tipo: 'CAMPANHA_PASCOA',
    p_campanha_id: camp.campanha_id,
    p_cliente_id: cliId
  });
  assert.equal(prevOk.success, true);

  // 2. Cliente solicita opt_out -> deve bloquear imediatamente
  await rpc(adm, 'registrar_consentimento_marketing', {
    p_cliente_id: cliId,
    p_canal: 'whatsapp_marketing',
    p_status: 'opt_out',
    p_origem: 'solicitacao_whatsapp',
    p_versao_termo: 'v1.0'
  });

  const prevBloq = await rpc(adm, 'obter_preview_comunicacao_marketing', {
    p_tipo: 'CAMPANHA_PASCOA',
    p_campanha_id: camp.campanha_id,
    p_cliente_id: cliId
  });
  assert.equal(prevBloq.success, false);
  assert.equal(prevBloq.code, 'MARKETING_OPT_IN_REQUIRED');
});

// ------------------------------------------------------------------------------
// GATE I16: Comunicação transacional continua permitida mesmo com marketing opt-out
// ------------------------------------------------------------------------------
test('I16: comunicação operacional/transacional (PEDIDO_PRONTO) continua permitida mesmo para cliente em opt-out de marketing', async () => {
  await limparFidelidade();
  const oper = await newClient(OPER_UID);
  const cliId = await criarClienteFixture('Cliente Transacional OptOut');
  const pedId = await criarPedidoFixture({ clienteId: cliId, total: 140.00, statusComercial: 'confirmado', statusOperacional: 'pronto' });

  await rpc(oper, 'registrar_consentimento_marketing', {
    p_cliente_id: cliId,
    p_canal: 'whatsapp_marketing',
    p_status: 'opt_out'
  });

  const prevTrans = await rpc(oper, 'obter_preview_comunicacao', {
    p_tipo: 'PEDIDO_PRONTO',
    p_orcamento_id: null,
    p_pedido_id: pedId
  });
  assert.equal(prevTrans.success, true);
  assert.equal(prevTrans.natureza_comunicacao, 'transacional');
});

// ------------------------------------------------------------------------------
// GATE I17: Campanha não duplica destinatário
// ------------------------------------------------------------------------------
test('I17: disparar_campanha_marketing não duplica destinatário nem comunicação em disparos repetidos', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliComOptIn = await criarClienteFixture('Cliente OptIn Campanha');
  const cliSemOptIn = await criarClienteFixture('Cliente SemOptIn Campanha');

  await rpc(adm, 'registrar_consentimento_marketing', {
    p_cliente_id: cliComOptIn,
    p_canal: 'whatsapp_marketing',
    p_status: 'opt_in'
  });

  const camp = await rpc(adm, 'salvar_campanha_admin', {
    p_codigo: 'CAMP_RECOMPRA_I17',
    p_nome: 'Volte a Comprar',
    p_tipo_template: 'VOLTE_A_COMPRAR',
    p_mensagem_template: 'Olá {{nome}}, sentimos sua falta na Lunoca! Você tem {{pontos}} pontos.',
    p_regra_segmentacao: { segmento: 'todos' },
    p_bonus_pontos: 15
  });

  const d1 = await rpc(adm, 'disparar_campanha_marketing', {
    p_campanha_id: camp.campanha_id,
    p_canal_envio: 'whatsapp_link'
  });
  assert.equal(d1.success, true);
  assert.equal(Number(d1.disparados), 1);
  assert.ok(Number(d1.bloqueados_sem_consentimento) >= 1);

  const totalProcessadosD1 = Number(d1.disparados) + Number(d1.bloqueados_sem_consentimento);

  // Segundo disparo da mesma campanha -> zero novos envios e zero duplicatas
  const d2 = await rpc(adm, 'disparar_campanha_marketing', {
    p_campanha_id: camp.campanha_id,
    p_canal_envio: 'whatsapp_link'
  });
  assert.equal(d2.success, true);
  assert.equal(Number(d2.disparados), 0);
  assert.equal(Number(d2.ja_processados_idempotente), totalProcessadosD1);

  const { rows: pubCliOptIn } = await admin.query(
    `SELECT * FROM public.campanha_publicos WHERE campanha_id = $1 AND cliente_id = $2`,
    [camp.campanha_id, cliComOptIn]
  );
  assert.equal(pubCliOptIn.length, 1);
  assert.equal(pubCliOptIn[0].status_disparo, 'disparado');

  const { rows: comRows } = await admin.query(
    `SELECT * FROM public.comunicacoes_cliente WHERE campanha_id = $1`,
    [camp.campanha_id]
  );
  assert.equal(comRows.length, 1);
});

// ------------------------------------------------------------------------------
// GATE I18: Crédito financeiro nunca é afetado por pontos ou cupons
// ------------------------------------------------------------------------------
test('I18: operações de pontos de fidelidade e cupons promocionais jamais alteram cliente_creditos nem passivo da tesouraria', async () => {
  await limparFidelidade();
  const adm = await newClient(ADMIN_UID);
  const cliId = await criarClienteFixture('Cliente I18 Isolamento');

  // 1. Cliente recebe R$ 50,00 de crédito financeiro real (Frente C)
  await rpc(adm, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cliId,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Crédito financeiro real da Frente C',
    p_request_id: 'i18-cred-real'
  });

  // 2. Ganha 300 pontos por pedido concluído, recebe bônus de ajuste, resgata 100 pontos e usa cupom promocional
  const pedId = await criarPedidoFixture({ clienteId: cliId, total: 300.00, statusComercial: 'confirmado' });
  await admin.query(`UPDATE public.pedidos SET status_comercial = 'concluido' WHERE id = $1`, [pedId]);

  await rpc(adm, 'resgatar_pontos_fidelidade', {
    p_cliente_id: cliId,
    p_pontos: 100
  });

  const { rows: [futuro] } = await admin.query(`SELECT (NOW() + INTERVAL '7 days')::TIMESTAMPTZ AS dt`);
  await rpc(adm, 'salvar_cupom_promocional_admin', {
    p_codigo: 'PROMO25',
    p_tipo: 'valor_fixo',
    p_valor: 25.00,
    p_validade_fim: futuro.dt
  });

  await rpc(adm, 'aplicar_cupom_promocional', {
    p_codigo_cupom: 'PROMO25',
    p_cliente_id: cliId,
    p_subtotal: 200.00,
    p_motivo: 'Uso de cupom promocional'
  });

  // 3. Verifica que a carteira financeira da Frente C permanece exatamente em R$ 50,00 com apenas 1 movimentação
  const saldoFin = await rpc(adm, 'consultar_saldo_credito', { p_cliente_id: cliId });
  assert.equal(saldoFin.success, true);
  assert.equal(Number(saldoFin.saldo), 50.00);
  assert.equal(saldoFin.extrato.length, 1);

  // 4. Verifica que o passivo de créditos na posição de tesouraria da Frente H continua exatamente R$ 50,00
  const posTes = await rpc(adm, 'obter_posicao_tesouraria_admin', { p_horizonte_dias: 30 });
  assert.equal(posTes.success, true);
  assert.equal(Number(posTes.passivo_creditos_clientes), 50.00);
});
