// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE R (CAIXA PDV & FECHAMENTO DE TURNO)
// ==============================================================================
// Valida os 16 gates obrigatórios R1 a R16 da Migration 034:
// R1:  Uma sessão aberta por operador (bloqueio de duplicidade)
// R2:  Uma sessão aberta por terminal (bloqueio de concorrência no terminal)
// R3:  Fundo de troco válido e financeiramente neutro (zero DRE/Tesouraria)
// R4:  Sangria não supera dinheiro físico disponível (bloqueio de saldo negativo)
// R5:  PDV exige sessão aberta (CASH_SESSION_REQUIRED)
// R6:  Pagamento PDV vincula exatamente uma sessão de caixa (caixa_sessao_pagamentos)
// R7:  Somente dinheiro compõe saldo físico (PIX/Cartão são segregados)
// R8:  Visão do operador cega no servidor (omite saldo esperado antes da contagem)
// R9:  Divergência exige justificativa (DIVERGENCE_JUSTIFICATION_REQUIRED)
// R10: Fechamento grava snapshots matematicamente corretos na sessão
// R11: Fechamento é idempotente e sessão fechada é imutável (SQLSTATE 42501)
// R12: Suprimento/sangria são idempotentes e append-only (SQLSTATE 42501)
// R13: Vínculos de pagamentos são estritamente append-only (SQLSTATE 42501)
// R14: Auditoria gerencial é append-only e não altera fechamento original
// R15: anon/PUBLIC/clientes bloqueados; fail-closed em RPCs e tabelas
// R16: Frente Q continua íntegra e sem regressão (catálogo, FEFO e quitação)
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
const PORT = 54453;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_A_UID = '22222222-2222-4222-8222-222222222222';
const OPER_B_UID = '33333333-3333-4333-8333-333333333333';
const CLI_UID    = '44444444-4444-4444-8444-444444444444';

let prodBoloId;
let prodTortaId;

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
    dirName: '.pg-integration-frente-r',
    port: PORT,
    dbName: 'lunoca_frente_r_test'
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
      ('${ADMIN_UID}', 'admin_r@lunoca.com'),
      ('${OPER_A_UID}', 'oper_a@lunoca.com'),
      ('${OPER_B_UID}', 'oper_b@lunoca.com'),
      ('${CLI_UID}', 'cliente_r@gmail.com')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Gerente Admin R', 'admin_r@lunoca.com', 'admin', true),
      ('${OPER_A_UID}', 'Operadora Ana R', 'oper_a@lunoca.com', 'operador', true),
      ('${OPER_B_UID}', 'Operador Bruno R', 'oper_b@lunoca.com', 'operador', true),
      ('${CLI_UID}', 'Cliente Carlos R', 'cliente_r@gmail.com', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  // Cadastrar produtos e lotes de pronta entrega para testes integrados do PDV
  const rProd1 = await admin.query(`
    INSERT INTO public.produtos (nome, preco, ativo, controlar_estoque, estoque_fisico)
    VALUES ('Bolo de Pote R', 15.00, true, true, 50)
    RETURNING id;
  `);
  prodBoloId = rProd1.rows[0].id;

  const rProd2 = await admin.query(`
    INSERT INTO public.produtos (nome, preco, ativo, controlar_estoque, estoque_fisico)
    VALUES ('Torta Holandesa R', 22.00, true, true, 20)
    RETURNING id;
  `);
  prodTortaId = rProd2.rows[0].id;

  // Lotes PT para Frente Q
  const hoje = (new Date()).toISOString().slice(0, 10);
  const validade = new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10);

  await admin.query(`
    INSERT INTO public.produto_pronto_lotes (
      produto_id, codigo_lote, quantidade_inicial, quantidade_disponivel,
      data_producao, data_validade, custo_unitario_producao, bloqueado_qualidade
    ) VALUES 
      (${prodBoloId}, 'PT-BOLO-R1', 50, 50, '${hoje}', '${validade}', 6.50, false),
      (${prodTortaId}, 'PT-TORTA-R1', 20, 20, '${hoje}', '${validade}', 10.00, false);
  `);
});

after(async () => {
  if (teardownFn) {
    await teardownFn(activeClients, admin);
  }
});

// ------------------------------------------------------------------------------
// R1: UMA SESSÃO ABERTA POR OPERADOR
// ------------------------------------------------------------------------------
test('R1: Operador pode abrir apenas uma sessão ativa simultaneamente', async () => {
  const cOperA = await newClient(OPER_A_UID);

  const res1 = await rpc(cOperA, 'abrir_sessao_caixa', {
    p_fundo_troco: 100.00,
    p_terminal: 'TERMINAL_1',
    p_observacoes: 'Abertura turno manhã'
  });
  assert.equal(res1.success, true, 'Primeira abertura deve suceder');
  assert.ok(res1.sessao_id > 0);

  // Segunda tentativa do mesmo operador deve ser bloqueada
  const res2 = await rpc(cOperA, 'abrir_sessao_caixa', {
    p_fundo_troco: 50.00,
    p_terminal: 'TERMINAL_2',
    p_observacoes: 'Tentativa duplicada'
  });
  assert.equal(res2.success, false);
  assert.equal(res2.code, 'OPEN_SESSION_EXISTS_OPERATOR');

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R2: UMA SESSÃO ABERTA POR TERMINAL
// ------------------------------------------------------------------------------
test('R2: Terminal ocupado não pode receber nova sessão de outro operador', async () => {
  const cOperB = await newClient(OPER_B_UID);

  // Operador B tenta abrir no TERMINAL_1 (que já está ocupado pela Operadora A)
  const res = await rpc(cOperB, 'abrir_sessao_caixa', {
    p_fundo_troco: 80.00,
    p_terminal: 'TERMINAL_1',
    p_observacoes: 'Tentativa de colisão no mesmo terminal'
  });
  assert.equal(res.success, false);
  assert.equal(res.code, 'OPEN_SESSION_EXISTS_TERMINAL');

  await closeClient(cOperB);
});

// ------------------------------------------------------------------------------
// R3: FUNDO DE TROCO VÁLIDO E FINANCEIRAMENTE NEUTRO (ZERO DRE/TESOURARIA)
// ------------------------------------------------------------------------------
test('R3: Fundo de troco inicial não gera lançamentos contábeis no financeiro/DRE', async () => {
  const { rows } = await admin.query(`
    SELECT COUNT(*) AS total
    FROM public.financeiro_lancamentos
    WHERE descricao ILIKE '%fundo de troco%' OR descricao ILIKE '%sessão de caixa%';
  `);
  assert.equal(Number(rows[0].total), 0, 'Zero lançamentos automáticos de caixa no financeiro canônico');
});

// ------------------------------------------------------------------------------
// R4: GUARDA DE SANGRIA FÍSICA (NÃO PODE SUPERAR DINHEIRO DISPONÍVEL)
// ------------------------------------------------------------------------------
test('R4: Sangria não pode superar o dinheiro físico disponível na gaveta', async () => {
  const cOperA = await newClient(OPER_A_UID);

  // Fundo inicial = R$ 100,00. Tentativa de sangria de R$ 150,00 deve falhar.
  const resFalha = await rpc(cOperA, 'registrar_movimentacao_caixa', {
    p_tipo: 'SANGRIA',
    p_valor: 150.00,
    p_motivo: 'Retirada excessiva',
    p_idempotency_key: 'sangria_excessiva_001'
  });
  assert.equal(resFalha.success, false);
  assert.equal(resFalha.code, 'INSUFFICIENT_CASH_IN_DRAWER');

  // Sangria de R$ 40,00 deve ser aprovada
  const resSucesso = await rpc(cOperA, 'registrar_movimentacao_caixa', {
    p_tipo: 'SANGRIA',
    p_valor: 40.00,
    p_motivo: 'Recolhimento parcial para cofre',
    p_idempotency_key: 'sangria_valida_001'
  });
  assert.equal(resSucesso.success, true);
  assert.equal(resSucesso.tipo, 'SANGRIA');
  assert.equal(resSucesso.valor, 40.00);

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R5: PDV EXIGE SESSÃO ABERTA (CASH_SESSION_REQUIRED)
// ------------------------------------------------------------------------------
test('R5: Operador sem sessão aberta não pode finalizar venda no PDV', async () => {
  const cOperB = await newClient(OPER_B_UID);

  const res = await rpc(cOperB, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBoloId, quantidade: 2 }],
    p_forma_pagamento: 'dinheiro'
  });
  assert.equal(res.success, false);
  assert.equal(res.code, 'CASH_SESSION_REQUIRED');

  await closeClient(cOperB);
});

// ------------------------------------------------------------------------------
// R6: PAGAMENTO PDV VINCULA EXATAMENTE UMA SESSÃO DE CAIXA
// ------------------------------------------------------------------------------
test('R6: Venda PDV concluída registra vínculo atômico em caixa_sessao_pagamentos', async () => {
  const cOperA = await newClient(OPER_A_UID);

  // Venda em dinheiro de 2 Bolos = R$ 30,00
  const resVenda = await rpc(cOperA, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBoloId, quantidade: 2 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'pdv_venda_r6_dinheiro'
  });
  assert.equal(resVenda.success, true);
  const pedId = resVenda.pedido_id;
  assert.ok(pedId > 0);

  const { rows } = await admin.query(`
    SELECT csp.*, pp.metodo AS pag_metodo
    FROM public.caixa_sessao_pagamentos csp
    JOIN public.pedido_pagamentos pp ON pp.id = csp.pagamento_id
    WHERE csp.pedido_id = $1;
  `, [pedId]);

  assert.equal(rows.length, 1, 'Exatamente um vínculo de pagamento com a sessão');
  assert.equal(rows[0].metodo, 'dinheiro');
  assert.equal(Number(rows[0].valor), 30.00);

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R7: SOMENTE DINHEIRO COMPÕE SALDO FÍSICO (PIX/CARTÃO NÃO ALTERAM GAVETA FÍSICA)
// ------------------------------------------------------------------------------
test('R7: Vendas em PIX e Cartão não entram na gaveta física de dinheiro', async () => {
  const cOperA = await newClient(OPER_A_UID);

  // Venda em PIX de 1 Torta = R$ 22,00
  const resPix = await rpc(cOperA, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodTortaId, quantidade: 1 }],
    p_forma_pagamento: 'pix',
    p_chave_idempotencia: 'pdv_venda_r7_pix'
  });
  assert.equal(resPix.success, true);

  // Consulta saldo físico disponível para sangria:
  // Fundo inicial (100) - Sangria anterior (40) + Venda dinheiro (30) = R$ 90,00 disponível
  // PIX de R$ 22,00 NÃO pode somar no dinheiro físico.
  const resTentativaSangria = await rpc(cOperA, 'registrar_movimentacao_caixa', {
    p_tipo: 'SANGRIA',
    p_valor: 90.01,
    p_motivo: 'Tentativa de sangrar valor do PIX',
    p_idempotency_key: 'sangria_pix_invalida'
  });
  assert.equal(resTentativaSangria.success, false);
  assert.equal(resTentativaSangria.code, 'INSUFFICIENT_CASH_IN_DRAWER');

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R8: VISÃO DO OPERADOR CEGA NO SERVIDOR
// ------------------------------------------------------------------------------
test('R8: consultar_sessao_caixa_atual omite saldo esperado antes da contagem', async () => {
  const cOperA = await newClient(OPER_A_UID);

  const res = await rpc(cOperA, 'consultar_sessao_caixa_atual', {});
  assert.equal(res.success, true);
  assert.equal(res.sessao_aberta, true);

  // Invariante de Segurança: campos não devem constar na projeção retornada
  assert.equal(res.sessao.saldo_esperado_dinheiro, undefined, 'Saldo esperado não pode ser projetado para operador');
  assert.equal(res.sessao.total_dinheiro_esperado, undefined, 'Total dinheiro esperado não pode ser projetado');
  assert.equal(res.sessao.diferenca, undefined, 'Diferença não pode ser projetada');

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R9: DIVERGÊNCIA EXIGE JUSTIFICATIVA
// ------------------------------------------------------------------------------
test('R9: Fechamento com quebra de caixa exige justificativa obrigatória', async () => {
  const cOperA = await newClient(OPER_A_UID);

  // Saldo esperado atual: 100 - 40 + 30 = R$ 90,00
  // Informando R$ 85,00 sem justificativa (quebra de R$ 5,00)
  const res = await rpc(cOperA, 'fechar_sessao_caixa', {
    p_valor_contado_dinheiro: 85.00,
    p_justificativa: null
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'DIVERGENCE_JUSTIFICATION_REQUIRED');
  assert.equal(Number(res.diferenca), -5.00);

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R10: FECHAMENTO GRAVA SNAPSHOTS MATEMATICAMENTE CORRETOS
// ------------------------------------------------------------------------------
test('R10: Fechamento com justificativa grava snapshots exatos na sessão', async () => {
  const cOperA = await newClient(OPER_A_UID);

  const res = await rpc(cOperA, 'fechar_sessao_caixa', {
    p_valor_contado_dinheiro: 85.00,
    p_justificativa: 'Diferença de R$ 5 por erro de troco em moedas',
    p_observacoes: 'Encerramento de turno ok',
    p_idempotency_key: 'close_oper_a_001'
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'FECHADA');
  assert.equal(Number(res.saldo_esperado_dinheiro), 90.00);
  assert.equal(Number(res.valor_contado_dinheiro), 85.00);
  assert.equal(Number(res.diferenca_caixa), -5.00);
  assert.equal(Number(res.total_dinheiro), 30.00);
  assert.equal(Number(res.total_pix), 22.00);
  assert.equal(Number(res.total_sangrias), 40.00);

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R11: FECHAMENTO É IDEMPOTENTE E SESSÃO FECHADA É IMUTÁVEL (SQLSTATE 42501)
// ------------------------------------------------------------------------------
test('R11: Retry de fechamento é idempotente e UPDATE direto na sessão fechada lança 42501', async () => {
  const cOperA = await newClient(OPER_A_UID);

  // Retry com mesmo valor contado
  const resRetry = await rpc(cOperA, 'fechar_sessao_caixa', {
    p_valor_contado_dinheiro: 85.00
  });
  assert.equal(resRetry.success, true);
  assert.equal(resRetry.ja_fechada, true);

  // Tentativa de UPDATE direto na sessão fechada deve ser barrada pelo trigger
  await assert.rejects(
    async () => {
      await admin.query(`
        UPDATE public.caixa_sessoes
        SET valor_contado_dinheiro = 90.00
        WHERE id = $1;
      `, [resRetry.sessao_id]);
    },
    /42501|imutável/
  );

  await closeClient(cOperA);
});

// ------------------------------------------------------------------------------
// R12: SUPRIMENTO/SANGRIA SÃO IDEMPOTENTES E APPEND-ONLY (SQLSTATE 42501)
// ------------------------------------------------------------------------------
test('R12: Suprimento com idempotency_key repetida retorna existente e bloqueia mutação', async () => {
  const cOperB = await newClient(OPER_B_UID);

  // Abre nova sessão para Operador B
  const resAbre = await rpc(cOperB, 'abrir_sessao_caixa', {
    p_fundo_troco: 50.00,
    p_terminal: 'TERMINAL_B'
  });
  const sessaoBId = resAbre.sessao_id;

  const key = 'sup_idemp_teste_123';
  const res1 = await rpc(cOperB, 'registrar_movimentacao_caixa', {
    p_tipo: 'SUPRIMENTO',
    p_valor: 60.00,
    p_motivo: 'Aporte de troco',
    p_idempotency_key: key
  });
  assert.equal(res1.success, true);
  assert.equal(res1.idempotente, false);

  // Repetição com mesma chave retorna o registro anterior sem duplicar
  const res2 = await rpc(cOperB, 'registrar_movimentacao_caixa', {
    p_tipo: 'SUPRIMENTO',
    p_valor: 60.00,
    p_motivo: 'Aporte de troco',
    p_idempotency_key: key
  });
  assert.equal(res2.success, true);
  assert.equal(res2.idempotente, true);
  assert.equal(res2.movimentacao_id, res1.movimentacao_id);

  // Trigger append-only bloqueia DELETE
  await assert.rejects(
    async () => {
      await admin.query('DELETE FROM public.caixa_sessao_movimentacoes WHERE id = $1;', [res1.movimentacao_id]);
    },
    /42501|append-only/
  );

  await closeClient(cOperB);
});

// ------------------------------------------------------------------------------
// R13: VÍNCULOS DE PAGAMENTO SÃO APPEND-ONLY (SQLSTATE 42501)
// ------------------------------------------------------------------------------
test('R13: Registros em caixa_sessao_pagamentos barram UPDATE e DELETE', async () => {
  const { rows } = await admin.query('SELECT id FROM public.caixa_sessao_pagamentos LIMIT 1;');
  assert.ok(rows.length > 0);
  const vinculoId = rows[0].id;

  await assert.rejects(
    async () => {
      await admin.query('UPDATE public.caixa_sessao_pagamentos SET valor = 999.00 WHERE id = $1;', [vinculoId]);
    },
    /42501|append-only/
  );

  await assert.rejects(
    async () => {
      await admin.query('DELETE FROM public.caixa_sessao_pagamentos WHERE id = $1;', [vinculoId]);
    },
    /42501|append-only/
  );
});

// ------------------------------------------------------------------------------
// R14: AUDITORIA É APPEND-ONLY E NÃO ALTERA FECHAMENTO ORIGINAL
// ------------------------------------------------------------------------------
test('R14: Auditoria administrativa registra parecer sem reescrever a sessão', async () => {
  const cAdmin = await newClient(ADMIN_UID);

  // Obter sessão fechada
  const { rows } = await admin.query('SELECT id, diferenca_caixa FROM public.caixa_sessoes WHERE status = \'FECHADA\' LIMIT 1;');
  assert.ok(rows.length > 0);
  const sessaoFechadaId = rows[0].id;
  const difOriginal = rows[0].diferenca_caixa;

  const resAud = await rpc(cAdmin, 'auditar_sessao_caixa_admin', {
    p_sessao_id: sessaoFechadaId,
    p_parecer: 'RESSALVA',
    p_observacoes: 'Diferença aceita após verificação de conferência de moedas'
  });
  assert.equal(resAud.success, true);
  assert.equal(resAud.parecer, 'RESSALVA');

  // Verifica que a sessão não foi reescrita
  const rPos = await admin.query('SELECT diferenca_caixa FROM public.caixa_sessoes WHERE id = $1;', [sessaoFechadaId]);
  assert.equal(rPos.rows[0].diferenca_caixa, difOriginal);

  // Bloqueio de DELETE na auditoria
  await assert.rejects(
    async () => {
      await admin.query('DELETE FROM public.caixa_sessao_auditorias WHERE id = $1;', [resAud.auditoria_id]);
    },
    /42501|append-only/
  );

  await closeClient(cAdmin);
});

// ------------------------------------------------------------------------------
// R15: FAIL-CLOSED E RBAC
// ------------------------------------------------------------------------------
test('R15: Usuário anon e clientes comuns recebem PERMISSION_DENIED', async () => {
  const cAnon = await newClient('anon');
  const cCli = await newClient(CLI_UID);

  const resAnon = await rpc(cAnon, 'abrir_sessao_caixa', { p_fundo_troco: 50.00 });
  assert.equal(resAnon.success, false);
  assert.equal(resAnon.code, 'PERMISSION_DENIED');

  const resCli = await rpc(cCli, 'abrir_sessao_caixa', { p_fundo_troco: 50.00 });
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');

  await closeClient(cAnon);
  await closeClient(cCli);
});

// ------------------------------------------------------------------------------
// R16: INTEGRIDADE E NÃO-REGRESSÃO DA FRENTE Q
// ------------------------------------------------------------------------------
test('R16: Frente Q consome lote PT FEFO, registra quitação e atualiza status para concluido', async () => {
  const cOperB = await newClient(OPER_B_UID);

  // Operador B vende 3 Bolos no PDV
  const res = await rpc(cOperB, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBoloId, quantidade: 3 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'pdv_r16_integridade'
  });

  assert.equal(res.success, true);
  assert.equal(res.status_operacional, 'retirado');
  assert.equal(res.status_comercial, 'concluido');
  assert.equal(res.status_financeiro, 'pago');
  assert.equal(Number(res.total), 45.00);

  // Verifica que o lote PT baixou exatamente 3 unidades
  const rLote = await admin.query('SELECT quantidade_disponivel FROM public.produto_pronto_lotes WHERE id = (SELECT id FROM public.produto_pronto_lotes WHERE codigo_lote = \'PT-BOLO-R1\');');
  // Inicialmente eram 50, baixou 2 no R6 e 3 no R16 = 45 restantes
  assert.equal(Number(rLote.rows[0].quantidade_disponivel), 45.00);

  await closeClient(cOperB);
});

// ------------------------------------------------------------------------------
// R17: GOVERNANÇA DE OWNERSHIP (CASH_SESSION_NOT_OWNED)
// ------------------------------------------------------------------------------
test('R17: Operador ou Admin não pode movimentar nem fechar sessão de caixa de outro operador', async () => {
  const cOperA = await newClient(OPER_A_UID);
  const cOperB = await newClient(OPER_B_UID);

  // Obter ID da sessão aberta do Operador B
  const { rows: sessoesB } = await admin.query(
    "SELECT id FROM public.caixa_sessoes WHERE operador_auth_id = $1 AND status = 'ABERTA' LIMIT 1;",
    [OPER_B_UID]
  );
  assert.ok(sessoesB.length > 0);
  const sessaoBId = sessoesB[0].id;

  // Operador A tenta fazer sangria na sessão do Operador B passando p_sessao_id
  const resSangriaAlheia = await rpc(cOperA, 'registrar_movimentacao_caixa', {
    p_tipo: 'SANGRIA',
    p_valor: 10.00,
    p_motivo: 'Tentativa indevida de sangria na sessão de outro operador',
    p_idempotency_key: 'sangria_alheia_fail',
    p_sessao_id: sessaoBId
  });
  assert.equal(resSangriaAlheia.success, false);
  assert.equal(resSangriaAlheia.code, 'CASH_SESSION_NOT_OWNED');

  // Operador A tenta fechar a sessão do Operador B
  const resFecharAlheia = await rpc(cOperA, 'fechar_sessao_caixa', {
    p_valor_contado_dinheiro: 100.00,
    p_sessao_id: sessaoBId
  });
  assert.equal(resFecharAlheia.success, false);
  assert.equal(resFecharAlheia.code, 'CASH_SESSION_NOT_OWNED');

  await closeClient(cOperA);
  await closeClient(cOperB);
});

// ------------------------------------------------------------------------------
// R18: RETRY DE PDV NÃO DUPLICA REGISTRO EM CAIXA_SESSAO_PAGAMENTOS (UNIQUE)
// ------------------------------------------------------------------------------
test('R18: Retry de finalizar_venda_pdv não gera vínculos adicionais em caixa_sessao_pagamentos', async () => {
  const cOperB = await newClient(OPER_B_UID);

  const { count: antesCount } = (await admin.query("SELECT COUNT(*)::int AS count FROM public.caixa_sessao_pagamentos;")).rows[0];

  // Chamar novamente com a mesma chave de idempotência de R16
  const retryRes = await rpc(cOperB, 'finalizar_venda_pdv', {
    p_itens: [{ produto_id: prodBoloId, quantidade: 3 }],
    p_forma_pagamento: 'dinheiro',
    p_chave_idempotencia: 'pdv_r16_integridade'
  });

  assert.equal(retryRes.success, true);
  assert.equal(retryRes.ja_processado, true);

  const { count: depoisCount } = (await admin.query("SELECT COUNT(*)::int AS count FROM public.caixa_sessao_pagamentos;")).rows[0];
  assert.equal(depoisCount, antesCount, 'Retry de venda PDV não pode adicionar novas linhas em caixa_sessao_pagamentos');

  await closeClient(cOperB);
});

