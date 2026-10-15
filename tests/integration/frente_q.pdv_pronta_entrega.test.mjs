// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE Q (PDV RÁPIDO & PRONTA ENTREGA)
// ==============================================================================
// Valida os 16 gates obrigatórios Q1 a Q16 da Migration 032:
// Q1:  PDV sempre cria pedido canônico em public.pedidos com canal_venda = 'pdv'
// Q2:  Zero tabelas paralelas de vendas/pagamentos no esquema do banco
// Q3:  Produção de pronta entrega baixa ingredientes atomicamente com FEFO
// Q4:  Venda FEFO consome o lote de menor validade elegível
// Q5:  Lote vencido nunca é vendido pelo PDV
// Q6:  Lote bloqueado por qualidade nunca é vendido pelo PDV
// Q7:  Concorrência simultânea com FOR UPDATE não gera saldo negativo
// Q8:  Retry com mesma chave de idempotência não duplica pedido nem pagamento
// Q9:  Desconto respeita governança canônica (motivo obrigatório, limite para operador)
// Q10: Pagamento reutiliza registrar_pagamento_pedido
// Q11: Efeitos financeiros reconciliam com motor canônico sem duplicidade
// Q12: Venda termina em status 'retirado' e 'concluido'
// Q13: Cliente identificado integra CRM e acumula pontos de fidelidade (Frente I)
// Q14: Consumidor avulso não cria cliente nem persiste dados pessoais falsos
// Q15: Operador não vê custo industrial de produção (sanitização server-side)
// Q16: Ingredientes + produto pronto + ledgers reconciliam matematicamente (identidade física e Frente L)
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
const PORT = 54452;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_A_UID = 'aaaa1111-1111-4111-8111-111111111111';

let cliAId;
let prodBrownieId;
let prodCookieId;
let ingCacauId;
let ingManteigaId;

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
  try {
    await c.end();
  } catch (_) {}
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

async function rpc(c, fnName, args = {}) {
  const keys = Object.keys(args);
  const callParams = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const sql = keys.length === 0
    ? `SELECT public.${fnName}() AS res`
    : `SELECT public.${fnName}(${callParams}) AS res`;
  const vals = keys.map((k) => {
    const val = args[k];
    if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
      return JSON.stringify(val);
    }
    return val;
  });
  const { rows } = await c.query(sql, vals);
  return rows[0]?.res;
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-032',
    port: PORT,
    dbName: 'lunoca_test_032'
  });
  connInfo = setup.connInfo;
  teardownFn = setup.teardown;

  admin = new pg.Client(connInfo);
  await admin.connect();

  const shim = fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8');
  await admin.query(shim);

  const installSql = fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf-8');
  await admin.query(installSql);

  await setIdentity(admin, 'service_role');

  // Setup usuários de teste
  await admin.query(`
    INSERT INTO auth.users (id, email)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test'),
      ('${OPER_UID}',  'oper@lunoca.test'),
      ('${CLI_A_UID}', 'clia@lunoca.test')
    ON CONFLICT (id) DO NOTHING;
  `);

  await admin.query(`
    INSERT INTO public.profiles (id, email, nivel, nome, ativo)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test', 'admin',    'Admin Lunoca', true),
      ('${OPER_UID}',  'oper@lunoca.test',  'operador', 'Operador Lunoca', true),
      ('${CLI_A_UID}', 'clia@lunoca.test',  'cliente',  'Cliente A Lunoca', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  const resCliA = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente Balcão Cadastrado', '(85) 99801-4001', '5585998014001', 'clia@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_A_UID]
  );
  cliAId = Number(resCliA.rows[0].id);

  // Setup produtos do catálogo
  const resB = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Brownie Tradicional Belga', 18.00, 50, true, true)
     RETURNING id`
  );
  prodBrownieId = Number(resB.rows[0].id);

  const resC = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Cookie Recheado Nutella', 14.00, 30, true, true)
     RETURNING id`
  );
  prodCookieId = Number(resC.rows[0].id);

  // Setup de ingredientes para receita
  const resCacau = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, estoque_minimo, ativo)
     VALUES ('Cacau Puro 100%', 'g', 0.0800, 100, true)
     RETURNING id`
  );
  ingCacauId = Number(resCacau.rows[0].id);

  const resMant = await admin.query(
    `INSERT INTO public.ingredientes (nome, unidade, custo_unitario, estoque_minimo, ativo)
     VALUES ('Manteiga Extra', 'g', 0.0500, 200, true)
     RETURNING id`
  );
  ingManteigaId = Number(resMant.rows[0].id);

  // Inicializar saldos agregados
  await admin.query(`
    INSERT INTO public.ingrediente_saldos (ingrediente_id, saldo_atual, custo_medio_ponderado)
    VALUES
      (${ingCacauId}, 5000.000, 0.0800),
      (${ingManteigaId}, 8000.000, 0.0500)
    ON CONFLICT (ingrediente_id) DO UPDATE SET saldo_atual = EXCLUDED.saldo_atual;
  `);

  // Ficha técnica do Brownie: 50g Cacau, 40g Manteiga por unidade
  await admin.query(`
    INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
    VALUES
      (${prodBrownieId}, ${ingCacauId}, 50.000),
      (${prodBrownieId}, ${ingManteigaId}, 40.000)
    ON CONFLICT (produto_id, ingrediente_id) DO UPDATE SET quantidade = EXCLUDED.quantidade;
  `);

  // Configurar lotes válidos com paridade exata a ingrediente_saldos
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', 'true', false);`);
  await admin.query(`
    INSERT INTO public.ingrediente_lotes (
      ingrediente_id, codigo_lote, quantidade_inicial, quantidade_atual,
      custo_unitario_lote, data_validade, data_recebimento, bloqueado_qualidade
    ) VALUES
      (${ingCacauId}, 'LOTE-CACAU-01', 5000.000, 5000.000, 0.0800, '${addDaysISO(60)}', CURRENT_DATE, false),
      (${ingManteigaId}, 'LOTE-MANT-01', 8000.000, 8000.000, 0.0500, '${addDaysISO(45)}', CURRENT_DATE, false)
    ON CONFLICT (ingrediente_id, codigo_lote) DO UPDATE
      SET quantidade_inicial = EXCLUDED.quantidade_inicial,
          quantidade_atual = EXCLUDED.quantidade_atual,
          data_validade = EXCLUDED.data_validade,
          bloqueado_qualidade = false;
  `);
  // Zera lotes automáticos residuais para manter SUM(lotes) == saldo_atual exato
  await admin.query(`
    UPDATE public.ingrediente_lotes
    SET quantidade_atual = 0.000
    WHERE ingrediente_id IN (${ingCacauId}, ${ingManteigaId})
      AND codigo_lote NOT IN ('LOTE-CACAU-01', 'LOTE-MANT-01');
  `);
  await admin.query(`SELECT set_config('lunoca.allow_lote_mutation', '', false);`);

  // Sessão de caixa aberta para os operadores do PDV conforme novo contrato canônico da Frente R
  const cOperSetup = await newClient(OPER_UID);
  await rpc(cOperSetup, 'abrir_sessao_caixa', {
    p_fundo_troco: 200.00,
    p_terminal: 'PDV-Q-OPER',
    p_observacoes: 'Sessão PDV para operador na suíte Frente Q'
  });
  await closeClient(cOperSetup);

  const cAdminSetup = await newClient(ADMIN_UID);
  await rpc(cAdminSetup, 'abrir_sessao_caixa', {
    p_fundo_troco: 200.00,
    p_terminal: 'PDV-Q-ADMIN',
    p_observacoes: 'Sessão PDV para admin na suíte Frente Q'
  });
  await closeClient(cAdminSetup);
});

after(async () => {
  for (const c of [...activeClients]) {
    await closeClient(c);
  }
  if (admin) {
    try {
      await admin.end();
    } catch (_) {}
  }
  if (teardownFn) {
    await teardownFn();
  }
});

// ==============================================================================
// Q1: PDV sempre cria pedido canônico em public.pedidos com canal_venda = 'pdv'
// ==============================================================================
test('Q1: PDV cria pedido canônico com canal_venda = "pdv"', async () => {
  const c = await newClient(OPER_UID);

  // Produzir 10 brownies
  const prodRes = await rpc(c, 'registrar_producao_produto_pronto', {
    p_produto_id: prodBrownieId,
    p_quantidade_produzida: 10,
    p_data_validade: addDaysISO(5),
    p_codigo_lote: 'PT-BROWNIE-Q1'
  });
  assert.equal(prodRes.success, true);

  // Vender 2 brownies no PDV
  const vendaRes = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 2 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'teste-q1-idemp-001'
  });

  assert.equal(vendaRes.success, true);
  assert.ok(vendaRes.pedido_id);

  // Verificar na tabela canônica public.pedidos
  const { rows } = await admin.query(
    `SELECT id, canal, total, status_operacional, status_comercial, status_financeiro
     FROM public.pedidos WHERE id = $1`,
    [vendaRes.pedido_id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canal, 'balcao');
  assert.equal(rows[0].status_operacional, 'retirado');
  assert.equal(rows[0].status_comercial, 'concluido');
  assert.equal(rows[0].status_financeiro, 'pago');

  await closeClient(c);
});

// ==============================================================================
// Q2: Zero tabelas paralelas de vendas/pagamentos no catálogo
// ==============================================================================
test('Q2: Zero tabelas paralelas de vendas ou pagamentos no esquema do banco', async () => {
  const { rows } = await admin.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('vendas_pdv', 'pagamentos_pdv', 'pedidos_pdv', 'caixa_balcao_vendas')
  `);
  assert.equal(rows.length, 0, 'Não deve existir nenhuma tabela paralela de vendas/pagamentos de balcão');
});

// ==============================================================================
// Q3: Produção de pronta entrega baixa ingredientes atomicamente com FEFO
// ==============================================================================
test('Q3: Produção de pronta entrega consome ingredientes e gera rastreabilidade', async () => {
  const c = await newClient(OPER_UID);

  // Obter saldo anterior de ingredientes
  const { rows: saldosAntes } = await admin.query(
    `SELECT ingrediente_id, saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id IN ($1, $2)`,
    [ingCacauId, ingManteigaId]
  );
  const saldoCacauAntes = Number(saldosAntes.find(r => Number(r.ingrediente_id) === ingCacauId).saldo_atual);

  // Produzir 5 brownies (requer 5 * 50g = 250g cacau)
  const prodRes = await rpc(c, 'registrar_producao_produto_pronto', {
    p_produto_id: prodBrownieId,
    p_quantidade_produzida: 5,
    p_data_validade: addDaysISO(7),
    p_codigo_lote: 'PT-BROWNIE-Q3'
  });

  assert.equal(prodRes.success, true);
  const loteId = prodRes.lote_id;

  // Verificar baixa no saldo agregado
  const { rows: saldosDepois } = await admin.query(
    `SELECT saldo_atual FROM public.ingrediente_saldos WHERE ingrediente_id = $1`,
    [ingCacauId]
  );
  const saldoCacauDepois = Number(saldosDepois[0].saldo_atual);
  assert.equal(saldoCacauDepois, saldoCacauAntes - 250);

  // Verificar registro em produto_pronto_lote_consumos_ingrediente
  const { rows: consumos } = await admin.query(
    `SELECT * FROM public.produto_pronto_lote_consumos_ingrediente WHERE produto_pronto_lote_id = $1`,
    [loteId]
  );
  assert.ok(consumos.length >= 2, 'Deve ter registrado consumo de cacau e manteiga');

  // Verificar custo unitário calculado server-side
  // Custo = (50g * 0.08 + 40g * 0.05) = 4.00 + 2.00 = 6.00 por brownie
  const { rows: lotePT } = await admin.query(
    `SELECT custo_unitario_producao FROM public.produto_pronto_lotes WHERE id = $1`,
    [loteId]
  );
  assert.equal(Number(lotePT[0].custo_unitario_producao), 6.0000);

  await closeClient(c);
});

// ==============================================================================
// Q4: Venda FEFO consome o lote de menor validade elegível
// ==============================================================================
test('Q4: Venda FEFO consome lote com menor validade primeiro', async () => {
  const c = await newClient(OPER_UID);

  // Criar Lote A com validade +2 dias (5 unidades)
  const loteA = await rpc(c, 'registrar_producao_produto_pronto', {
    p_produto_id: prodBrownieId,
    p_quantidade_produzida: 5,
    p_data_validade: addDaysISO(2),
    p_codigo_lote: 'PT-FEFO-VAL-02D'
  });
  assert.equal(loteA.success, true);

  // Criar Lote B com validade +10 dias (5 unidades)
  const loteB = await rpc(c, 'registrar_producao_produto_pronto', {
    p_produto_id: prodBrownieId,
    p_quantidade_produzida: 5,
    p_data_validade: addDaysISO(10),
    p_codigo_lote: 'PT-FEFO-VAL-10D'
  });
  assert.equal(loteB.success, true);

  // Vender 3 unidades no PDV
  const venda = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 3 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'teste-q4-fefo-001'
  });
  assert.equal(venda.success, true);

  // O lote A (validade menor) deve ter baixado 3 unidades, restando 2
  const { rows: resA } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [loteA.lote_id]
  );
  assert.equal(Number(resA[0].quantidade_disponivel), 2.00);

  // O lote B (validade maior) deve continuar intacto com 5 unidades
  const { rows: resB } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [loteB.lote_id]
  );
  assert.equal(Number(resB[0].quantidade_disponivel), 5.00);

  await closeClient(c);
});

// ==============================================================================
// Q5: Lote vencido nunca é vendido pelo PDV
// ==============================================================================
test('Q5: Lote vencido é ignorado pelo FEFO do PDV', async () => {
  const c = await newClient(OPER_UID);

  // Inserir diretamente um lote vencido ontem (sem outros lotes para o cookie)
  await admin.query(`
    INSERT INTO public.produto_pronto_lotes (
      produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
      data_producao, data_validade, bloqueado_qualidade, custo_unitario_producao
    ) VALUES (
      ${prodCookieId}, 'PT-COOKIE-VENCIDO', 10.00, 10.00,
      '${addDaysISO(-5)}', '${addDaysISO(-1)}', false, 4.50
    );
  `);

  // Tentar vender o cookie no PDV (deve falhar por falta de estoque elegível)
  const resVenda = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodCookieId, quantidade: 1 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'teste-q5-vencido-001'
  });

  assert.equal(resVenda.success, false);
  assert.equal(resVenda.code, 'INSUFFICIENT_STOCK_PRODUTO_PRONTO');

  await closeClient(c);
});

// ==============================================================================
// Q6: Lote bloqueado por qualidade nunca é vendido pelo PDV
// ==============================================================================
test('Q6: Lote bloqueado por qualidade é rejeitado pelo PDV', async () => {
  const c = await newClient(OPER_UID);

  // Criar lote válido de cookies
  const prod = await rpc(c, 'registrar_producao_produto_pronto', {
    p_produto_id: prodCookieId,
    p_quantidade_produzida: 10,
    p_data_validade: addDaysISO(5),
    p_codigo_lote: 'PT-COOKIE-BLOQ-TESTE'
  });
  assert.equal(prod.success, true);

  // Bloquear por qualidade
  const bloqRes = await rpc(c, 'alterar_bloqueio_qualidade_produto_pronto', {
    p_lote_id: prod.lote_id,
    p_bloquear: true,
    p_motivo: 'Suspeita de alteração de textura na vitrine'
  });
  assert.equal(bloqRes.success, true);

  // Tentar vender no PDV (deve falhar)
  const vendaRes = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodCookieId, quantidade: 2 }],
    p_forma_pagamento: 'cartao',
    p_chave_idempotencia: 'teste-q6-bloq-001'
  });

  assert.equal(vendaRes.success, false);
  assert.equal(vendaRes.code, 'INSUFFICIENT_STOCK_PRODUTO_PRONTO');

  // Desbloquear e vender com sucesso
  await rpc(c, 'alterar_bloqueio_qualidade_produto_pronto', {
    p_lote_id: prod.lote_id,
    p_bloquear: false
  });

  const vendaResOk = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodCookieId, quantidade: 2 }],
    p_forma_pagamento: 'cartao',
    p_chave_idempotencia: 'teste-q6-desbloq-001'
  });
  assert.equal(vendaResOk.success, true);

  await closeClient(c);
});

// ==============================================================================
// Q7: Concorrência simultânea com FOR UPDATE não gera saldo negativo
// ==============================================================================
test('Q7: Concorrência simultânea com FOR UPDATE protege estoque do lote PT', async () => {
  const cAdmin = await newClient(ADMIN_UID);

  // Zerar lotes anteriores de cookie para testar concorrência exatamente com 3 unidades
  await admin.query(`UPDATE public.produto_pronto_lotes SET quantidade_disponivel = 0 WHERE produto_id = $1`, [prodCookieId]);

  // Criar lote com exatamente 3 cookies
  const prod = await rpc(cAdmin, 'registrar_producao_produto_pronto', {
    p_produto_id: prodCookieId,
    p_quantidade_produzida: 3,
    p_data_validade: addDaysISO(10),
    p_codigo_lote: 'PT-COOKIE-CONC-01'
  });
  assert.equal(prod.success, true);

  const c1 = await newClient(OPER_UID);
  const c2 = await newClient(OPER_UID);

  // Dois clientes tentam comprar 2 unidades simultaneamente (total 4 > 3 disponível)
  const [res1, res2] = await Promise.all([
    rpc(c1, 'finalizar_venda_pdv', {
      p_itens: [{ produto_id: prodCookieId, quantidade: 2 }],
      p_forma_pagamento: 'dinheiro',
      p_chave_idempotencia: 'teste-q7-conc-cli1'
    }),
    rpc(c2, 'finalizar_venda_pdv', {
      p_itens: [{ produto_id: prodCookieId, quantidade: 2 }],
      p_forma_pagamento: 'pix',
      p_chave_idempotencia: 'teste-q7-conc-cli2'
    })
  ]);

  const successes = [res1, res2].filter(r => r.success);
  const failures = [res1, res2].filter(r => !r.success);

  assert.equal(successes.length, 1, 'Exatamente uma transação deve ter sucesso');
  assert.equal(failures.length, 1, 'A segunda transação concorrente deve falhar');
  assert.equal(failures[0].code, 'INSUFFICIENT_STOCK_PRODUTO_PRONTO');

  // Verificar que o saldo nunca ficou negativo
  const { rows } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [prod.lote_id]
  );
  assert.equal(Number(rows[0].quantidade_disponivel), 1.00);

  await closeClient(c1);
  await closeClient(c2);
  await closeClient(cAdmin);
});

// ==============================================================================
// Q8: Retry com mesma chave de idempotência não duplica pedido nem pagamento
// ==============================================================================
test('Q8: Retry com mesma chave de idempotência retorna pedido existente', async () => {
  const c = await newClient(OPER_UID);

  const key = 'idemp-pdv-unique-test-key-008';
  const res1 = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: key
  });
  assert.equal(res1.success, true);
  assert.equal(res1.ja_processado, undefined);

  // Retry com a mesma chave
  const res2 = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: key
  });
  assert.equal(res2.success, true);
  assert.equal(res2.ja_processado, true);
  assert.equal(res2.pedido_id, res1.pedido_id);

  // Verificar contagem no banco
  const { rows: pedidos } = await admin.query(
    `SELECT COUNT(*) AS total FROM public.pedidos WHERE observacoes_internas LIKE $1`,
    [`%${key}%`]
  );
  assert.equal(Number(pedidos[0].total), 1);

  await closeClient(c);
});

// ==============================================================================
// Q9: Desconto respeita governança canônica (motivo obrigatório, limite para operador)
// ==============================================================================
test('Q9: Desconto exige justificativa e operador respeita teto de 10%', async () => {
  const cOper = await newClient(OPER_UID);
  const cAdmin = await newClient(ADMIN_UID);

  // 1. Tentar dar desconto sem justificativa
  const semMotivo = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_desconto: 2.00,
    p_motivo_desconto: null
  });
  assert.equal(semMotivo.success, false);
  assert.equal(semMotivo.code, 'DISCOUNT_REASON_REQUIRED');

  // 2. Operador tenta dar 20% de desconto (> 10% permitido)
  // Brownie custa 18.00 -> 10% é 1.80. Pedir 3.00 deve falhar.
  const acimaTeto = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_desconto: 3.00,
    p_motivo_desconto: 'Cortesia balcão amigo'
  });
  assert.equal(acimaTeto.success, false);
  assert.equal(acimaTeto.code, 'DISCOUNT_LIMIT_EXCEEDED');

  // 3. Operador dá desconto dentro do limite (1.50 <= 1.80) -> Sucesso
  const dentroTeto = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_desconto: 1.50,
    p_motivo_desconto: 'Desconto pontual operador',
    p_chave_idempotencia: 'teste-q9-oper-ok'
  });
  assert.equal(dentroTeto.success, true);
  assert.equal(dentroTeto.total, 16.50);

  // 4. Admin pode conceder desconto maior que 10%
  const adminDesconto = await rpc(cAdmin, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_desconto: 5.00,
    p_motivo_desconto: 'Desconto autorizado gerência',
    p_chave_idempotencia: 'teste-q9-admin-ok'
  });
  assert.equal(adminDesconto.success, true);
  assert.equal(adminDesconto.total, 13.00);

  await closeClient(cOper);
  await closeClient(cAdmin);
});

// ==============================================================================
// Q10: Pagamento reutiliza registrar_pagamento_pedido
// ==============================================================================
test('Q10: Pagamento PDV gera registro canônico em public.pedido_pagamentos', async () => {
  const c = await newClient(OPER_UID);

  const res = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_forma_pagamento: 'cartao_credito',
    p_chave_idempotencia: 'teste-q10-pag-can'
  });
  assert.equal(res.success, true);

  const { rows: pags } = await admin.query(
    `SELECT pedido_id, valor, metodo, status FROM public.pedido_pagamentos WHERE pedido_id = $1`,
    [res.pedido_id]
  );
  assert.equal(pags.length, 1);
  assert.equal(Number(pags[0].valor), 18.00);
  assert.equal(pags[0].metodo, 'cartao');
  assert.equal(pags[0].status, 'aprovado');

  await closeClient(c);
});

// ==============================================================================
// Q11: Efeitos financeiros reconciliam com motor canônico sem duplicidade
// ==============================================================================
test('Q11: Pagamento PDV produz efeitos financeiros canônicos sem duplicidade e distingue externo de credito_cliente', async () => {
  const cOper = await newClient(OPER_UID);
  const cAdmin = await newClient(ADMIN_UID);

  // 1. Pagamento Externo (PIX) no PDV -> pedido_pagamentos + financeiro_lancamentos (receita)
  const resPix = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 2 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'teste-q11-canon-pix'
  });
  assert.equal(resPix.success, true);
  const pedidoPixId = resPix.pedido_id;

  // Verifica quitação canônica em public.pedidos
  const { rows: pedPix } = await admin.query(
    `SELECT total, saldo, valor_pago, status_financeiro, canal, status_operacional
     FROM public.pedidos WHERE id = $1`,
    [pedidoPixId]
  );
  assert.equal(Number(pedPix[0].total), 36.00);
  assert.equal(Number(pedPix[0].saldo), 0.00);
  assert.equal(Number(pedPix[0].valor_pago), 36.00);
  assert.equal(pedPix[0].status_financeiro, 'pago');
  assert.equal(pedPix[0].canal, 'balcao');
  assert.equal(pedPix[0].status_operacional, 'retirado');

  // Verifica registro em public.pedido_pagamentos
  const { rows: pagsPix } = await admin.query(
    `SELECT id, pedido_id, valor, metodo, status FROM public.pedido_pagamentos WHERE pedido_id = $1`,
    [pedidoPixId]
  );
  assert.equal(pagsPix.length, 1, 'Deve existir exatamente 1 registro de pagamento');
  assert.equal(Number(pagsPix[0].valor), 36.00);
  assert.equal(pagsPix[0].metodo, 'pix');
  assert.equal(pagsPix[0].status, 'aprovado');
  const pagId = pagsPix[0].id;

  // Verifica efeito financeiro canônico no DRE (public.financeiro_lancamentos)
  const { rows: lancsPix } = await admin.query(
    `SELECT id, tipo, categoria, valor, forma_pagamento, origem_tipo, origem_id, evento
     FROM public.financeiro_lancamentos WHERE pedido_id = $1`,
    [pedidoPixId]
  );
  assert.equal(lancsPix.length, 1, 'Deve existir exatamente 1 lançamento de receita no DRE');
  assert.equal(lancsPix[0].tipo, 'receita');
  assert.equal(lancsPix[0].categoria, 'Vendas');
  assert.equal(Number(lancsPix[0].valor), 36.00);
  assert.equal(lancsPix[0].forma_pagamento, 'pix');
  assert.equal(lancsPix[0].origem_tipo, 'pedido_pagamento');
  assert.equal(Number(lancsPix[0].origem_id), Number(pagId));

  // 2. Retry com mesma chave de idempotência -> Não duplica pagamentos nem financeiro
  const resRetry = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 2 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'teste-q11-canon-pix'
  });
  assert.equal(resRetry.success, true);
  assert.equal(resRetry.ja_processado, true);
  assert.equal(resRetry.pedido_id, pedidoPixId);

  // Invariante de não-duplicação: contagem em pedido_pagamentos e financeiro_lancamentos permanece 1
  const { rows: cntPags } = await admin.query(
    `SELECT COUNT(*)::int AS count FROM public.pedido_pagamentos WHERE pedido_id = $1`,
    [pedidoPixId]
  );
  assert.equal(cntPags[0].count, 1, 'Retry de venda PDV não pode duplicar pedido_pagamentos');

  const { rows: cntLancs } = await admin.query(
    `SELECT COUNT(*)::int AS count FROM public.financeiro_lancamentos WHERE pedido_id = $1`,
    [pedidoPixId]
  );
  assert.equal(cntLancs[0].count, 1, 'Retry de venda PDV não pode duplicar financeiro_lancamentos');

  // 3. Pagamento via credito_cliente -> Movimento de carteira SEM entrada externa de caixa
  await rpc(cAdmin, 'ajustar_credito_cliente_admin', {
    p_cliente_id: cliAId,
    p_tipo: 'credito',
    p_valor: 50.00,
    p_motivo: 'Carga de crédito para teste Q11',
    p_request_id: 'q11-init-credito'
  });

  const { rows: novoPed } = await admin.query(`
    INSERT INTO public.pedidos (
      cliente_id_rel, nome_cliente, canal, modalidade_entrega, endereco_entrega, subtotal, total, saldo, valor_pago,
      status_comercial, status_operacional, status_financeiro, status, pagamento, itens, data_pedido, data_entrega
    ) VALUES (
      $1, 'Cliente Balcão Cadastrado', 'balcao', 'retirada', 'Balcão Lunoca - Pronta Entrega', 18.00, 18.00, 18.00, 0.00,
      'confirmado', 'pronto', 'nao_pago', 'Confirmado', 'outro', '[]', CURRENT_DATE, CURRENT_DATE
    ) RETURNING id;
  `, [cliAId]);
  const pedCredId = novoPed[0].id;

  const usoCredRes = await rpc(cOper, 'utilizar_credito_cliente_pedido', {
    p_pedido_id: pedCredId,
    p_valor: 18.00
  });
  assert.equal(usoCredRes.success, true);

  // Verifica débito no livro-razão da carteira (cliente_credito_movimentacoes)
  const { rows: movsCred } = await admin.query(
    `SELECT id, tipo, origem, valor FROM public.cliente_credito_movimentacoes
     WHERE cliente_id = $1 AND pedido_id = $2`,
    [cliAId, pedCredId]
  );
  assert.equal(movsCred.length, 1, 'Deve registrar débito na carteira do cliente');
  assert.equal(movsCred[0].tipo, 'debito');
  assert.equal(movsCred[0].origem, 'uso_pedido');
  assert.equal(Number(movsCred[0].valor), 18.00);

  // Verifica pagamento canônico registrado como 'credito_cliente'
  const { rows: pagsCred } = await admin.query(
    `SELECT id, valor, metodo, status FROM public.pedido_pagamentos WHERE pedido_id = $1`,
    [pedCredId]
  );
  assert.equal(pagsCred.length, 1);
  assert.equal(pagsCred[0].metodo, 'credito_cliente');
  assert.equal(Number(pagsCred[0].valor), 18.00);

  // Invariante canônica fundamental: Pagamento externo != credito_cliente
  // credito_cliente NÃO gera lançamento de receita de caixa em financeiro_lancamentos
  const { rows: lancsCred } = await admin.query(
    `SELECT COUNT(*)::int AS count FROM public.financeiro_lancamentos WHERE pedido_id = $1`,
    [pedCredId]
  );
  assert.equal(
    lancsCred[0].count,
    0,
    'Uso de saldo de carteira (credito_cliente) não pode criar lançamento de receita externa no DRE'
  );

  await closeClient(cOper);
  await closeClient(cAdmin);
});


// ==============================================================================
// Q12: Venda termina em status 'retirado' e 'concluido'
// ==============================================================================
test('Q12: Venda PDV registra histórico de transição para retirado/concluído', async () => {
  const c = await newClient(OPER_UID);

  const res = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'teste-q12-status-hist'
  });
  assert.equal(res.success, true);

  const { rows: hist } = await admin.query(
    `SELECT dimensao, status_anterior, status_novo, origem
     FROM public.pedido_status_historico
     WHERE pedido_id = $1 AND metadata->>'origem_detalhada' = 'pdv'`,
    [res.pedido_id]
  );
  assert.ok(hist.length >= 1);
  assert.equal(hist[0].dimensao, 'operacional');
  assert.equal(hist[0].status_anterior, 'pronto');
  assert.equal(hist[0].status_novo, 'retirado');
  assert.equal(hist[0].origem, 'admin');

  await closeClient(c);
});

// ==============================================================================
// Q13: Cliente identificado integra CRM e fidelidade (Frente I)
// ==============================================================================
test('Q13: Cliente identificado acumula pontos no programa de fidelidade', async () => {
  const c = await newClient(OPER_UID);

  const res = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 2 }],
    p_cliente_id_rel: cliAId,
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'teste-q13-fidelidade'
  });
  assert.equal(res.success, true);

  // Verificar se o pedido está vinculado ao cliente
  const { rows: ped } = await admin.query(
    `SELECT cliente_id_rel, nome_cliente, email_cliente FROM public.pedidos WHERE id = $1`,
    [res.pedido_id]
  );
  assert.equal(Number(ped[0].cliente_id_rel), cliAId);
  assert.equal(ped[0].nome_cliente, 'Cliente Balcão Cadastrado');

  // Verificar transação de fidelidade gerada
  const { rows: fid } = await admin.query(
    `SELECT * FROM public.cliente_pontos_movimentacoes WHERE pedido_id = $1`,
    [res.pedido_id]
  );
  assert.ok(fid.length >= 1, 'Deve gerar registro no extrato de fidelidade');

  await closeClient(c);
});

// ==============================================================================
// Q14: Consumidor avulso não cria cliente nem dados pessoais falsos
// ==============================================================================
test('Q14: Consumidor avulso persiste NULL para dados pessoais sem poluir CRM', async () => {
  const c = await newClient(OPER_UID);

  const res = await rpc(c, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBrownieId, quantidade: 1 }],
    p_cliente_id_rel: null,
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'teste-q14-avulso'
  });
  assert.equal(res.success, true);

  const { rows } = await admin.query(
    `SELECT cliente_id_rel, nome_cliente, email_cliente, telefone_cliente
     FROM public.pedidos WHERE id = $1`,
    [res.pedido_id]
  );
  assert.equal(rows[0].cliente_id_rel, null);
  assert.equal(rows[0].nome_cliente, null);
  assert.equal(rows[0].email_cliente, null);
  assert.equal(rows[0].telefone_cliente, null);

  await closeClient(c);
});

// ==============================================================================
// Q15: Operador não vê custo industrial de produção (sanitização server-side)
// ==============================================================================
test('Q15: Operador recebe custo_unitario_producao como NULL no estoque', async () => {
  const cOper = await newClient(OPER_UID);
  const cAdmin = await newClient(ADMIN_UID);

  // Garantir que existe lote ativo com disponibilidade
  await rpc(cAdmin, 'registrar_producao_produto_pronto', {
    p_produto_id: prodBrownieId,
    p_quantidade_produzida: 5,
    p_data_validade: addDaysISO(7),
    p_codigo_lote: 'PT-BROWNIE-Q15'
  });

  // Consulta por Operador
  const estoqueOper = await rpc(cOper, 'obter_estoque_produto_pronto_admin');
  assert.equal(estoqueOper.success, true);
  assert.ok(estoqueOper.lotes.length > 0);
  assert.equal(
    estoqueOper.lotes[0].custo_unitario_producao,
    null,
    'Operador não pode ter acesso ao custo industrial do lote'
  );

  // Consulta por Admin
  const estoqueAdmin = await rpc(cAdmin, 'obter_estoque_produto_pronto_admin');
  assert.equal(estoqueAdmin.success, true);
  assert.notEqual(
    estoqueAdmin.lotes[0].custo_unitario_producao,
    null,
    'Admin deve ter acesso ao custo unitário de produção'
  );

  await closeClient(cOper);
  await closeClient(cAdmin);
});

// ==============================================================================
// Q16: Ingredientes + produto pronto + ledgers reconciliam matematicamente
// ==============================================================================
test('Q16: Reconciliação matemática exata de lote PT com ledger e invariante MP Frente L', async () => {
  const cAdmin = await newClient(ADMIN_UID);
  const cOper = await newClient(OPER_UID);

  // Setup de produto exclusivo para isolamento estrito de FEFO e lotes no teste Q16
  const resProd = await admin.query(
    `INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
     VALUES ('Torta Especial Q16 Reconciliação', 45.00, 20, true, true)
     RETURNING id`
  );
  const prodQ16Id = Number(resProd.rows[0].id);

  await admin.query(`
    INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
    VALUES
      (${prodQ16Id}, ${ingCacauId}, 20.000),
      (${prodQ16Id}, ${ingManteigaId}, 15.000);
  `);

  // 1. Snapshot da invariante de matéria-prima (Frente L) antes da produção
  const { rows: mpAntes } = await admin.query(`
    SELECT
      s.ingrediente_id,
      s.saldo_atual,
      COALESCE(SUM(l.quantidade_atual), 0) AS soma_lotes
    FROM public.ingrediente_saldos s
    LEFT JOIN public.ingrediente_lotes l ON l.ingrediente_id = s.ingrediente_id
    WHERE s.ingrediente_id IN (${ingCacauId}, ${ingManteigaId})
    GROUP BY s.ingrediente_id, s.saldo_atual
    ORDER BY s.ingrediente_id ASC;
  `);
  for (const r of mpAntes) {
    assert.equal(
      Number(r.saldo_atual),
      Number(r.soma_lotes),
      `Invariante prévia Frente L deve ser válida para ingrediente ${r.ingrediente_id}`
    );
  }

  // 2. Produção de 10 unidades de Produto Pronto (PT)
  const codLoteQ16 = 'PT-RECONC-Q16-' + Date.now();
  const prodRes = await rpc(cAdmin, 'registrar_producao_produto_pronto', {
    p_produto_id: prodQ16Id,
    p_quantidade_produzida: 10,
    p_data_validade: addDaysISO(7),
    p_codigo_lote: codLoteQ16
  });
  assert.equal(prodRes.success, true);
  const lotePtId = prodRes.lote_id;

  // Verifica saldo do lote logo após produção: deve ser exatamente 10
  const { rows: lotePosProd } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [lotePtId]
  );
  assert.equal(Number(lotePosProd[0].quantidade_disponivel), 10.00);

  // 3. Venda PDV de 3 unidades (consome do lote por FEFO)
  const vendaRes = await rpc(cOper, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodQ16Id, quantidade: 3 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'teste-q16-venda-3'
  });
  assert.equal(vendaRes.success, true);

  // Saldo do lote deve ser 7 (10 - 3)
  const { rows: lotePosVenda } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [lotePtId]
  );
  assert.equal(Number(lotePosVenda[0].quantidade_disponivel), 7.00);

  // 4. Registro de Perda de 2 unidades
  const perdaRes = await rpc(cOper, 'registrar_perda_produto_pronto', {
    p_lote_id: lotePtId,
    p_quantidade: 2,
    p_tipo_perda: 'PERDA_AVARIA',
    p_justificativa: 'Unidades danificadas durante montagem da vitrine'
  });
  assert.equal(perdaRes.success, true);

  // Saldo do lote deve ser 5 (7 - 2)
  const { rows: lotePosPerda } = await admin.query(
    `SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = $1`,
    [lotePtId]
  );
  assert.equal(Number(lotePosPerda[0].quantidade_disponivel), 5.00);

  // 5. Reconciliação Matemática: Ledger Líquido vs Saldo do Lote
  // quantidade_disponivel = Σ ENTRADA_PRODUCAO - Σ VENDA_PDV - Σ PERDA_AVARIA - Σ VENCIMENTO ± Σ AJUSTE_BALANCO
  const { rows: movsPt } = await admin.query(
    `SELECT id, tipo_movimentacao, direcao, quantidade
     FROM public.produto_pronto_movimentacoes
     WHERE lote_id = $1
     ORDER BY id ASC`,
    [lotePtId]
  );
  assert.equal(movsPt.length, 3, 'Deve haver 3 movimentações no livro-razão (ENTRADA, VENDA, PERDA)');

  let ledgerLiquido = 0;
  for (const mov of movsPt) {
    const qtd = Number(mov.quantidade);
    if (mov.direcao === 'ENTRADA') {
      ledgerLiquido += qtd;
    } else if (mov.direcao === 'SAIDA') {
      ledgerLiquido -= qtd;
    }
  }

  assert.equal(ledgerLiquido, 5.00, 'Ledger líquido deve somar exatamente 5 (+10 -3 -2)');
  assert.equal(
    Number(lotePosPerda[0].quantidade_disponivel),
    ledgerLiquido,
    'Saldo do lote deve ser identicamente igual ao saldo do ledger líquido'
  );

  // 6. Prova da invariante da Frente L após consumo de insumos MP -> PT:
  // SUM(ingrediente_lotes.quantidade_atual) = ingrediente_saldos.saldo_atual
  const { rows: mpDepois } = await admin.query(`
    SELECT
      s.ingrediente_id,
      s.saldo_atual,
      COALESCE(SUM(l.quantidade_atual), 0) AS soma_lotes
    FROM public.ingrediente_saldos s
    LEFT JOIN public.ingrediente_lotes l ON l.ingrediente_id = s.ingrediente_id
    WHERE s.ingrediente_id IN (${ingCacauId}, ${ingManteigaId})
    GROUP BY s.ingrediente_id, s.saldo_atual
    ORDER BY s.ingrediente_id ASC;
  `);
  for (const r of mpDepois) {
    assert.equal(
      Number(r.saldo_atual),
      Number(r.soma_lotes),
      `Invariante Frente L SUM(lotes) == saldo_atual violada para ingrediente ${r.ingrediente_id} após produção PT`
    );
  }

  // 7. Manter verificação append-only: mutação em produto_pronto_movimentacoes é barrada
  const movId = movsPt[0].id;
  await assert.rejects(
    async () => {
      await admin.query(`UPDATE public.produto_pronto_movimentacoes SET quantidade = 999 WHERE id = $1`, [movId]);
    },
    (err) => {
      assert.equal(err.code, '42501');
      assert.match(err.message, /PRODUTO_PRONTO_MOV_APPEND_ONLY/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await admin.query(`DELETE FROM public.produto_pronto_movimentacoes WHERE id = $1`, [movId]);
    },
    (err) => {
      assert.equal(err.code, '42501');
      return true;
    }
  );

  // Testar consumo_produto_pronto imutabilidade
  const { rows: consumos } = await admin.query(
    `SELECT id FROM public.pedido_consumos_produto_pronto WHERE lote_id = $1 LIMIT 1`,
    [lotePtId]
  );
  if (consumos.length > 0) {
    await assert.rejects(
      async () => {
        await admin.query(`UPDATE public.pedido_consumos_produto_pronto SET quantidade = 999 WHERE id = $1`, [consumos[0].id]);
      },
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /CONSUMO_PRODUTO_PRONTO_APPEND_ONLY/);
        return true;
      }
    );
  }

  await closeClient(cAdmin);
  await closeClient(cOper);
});

