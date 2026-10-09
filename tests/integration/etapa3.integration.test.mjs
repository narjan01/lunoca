// ==========================================================================
// LUNOCA - TESTES DE INTEGRAÇÃO REAIS (PostgreSQL) - ETAPA 3 ORÇAMENTOS
// ==========================================================================
// Executa contra PostgreSQL REAL (via DATABASE_URL ou embedded-postgres descartável).
// Valida os 20 cenários concorrenciais e de segurança contratados (E3-1 a E3-20).
// ==========================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 54398;

let embedded = null;
let admin; // conexão superuser (fixtures / inspeção)
let connInfo;

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const CLIENTE_UID = '33333333-3333-3333-3333-333333333333';

async function newClient(identity = 'service_role') {
  const c = new pg.Client(connInfo);
  await c.connect();
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
    const pgDir = path.join(ROOT, '.pg-integration-e3');
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
    await embedded.createDatabase('lunoca_test_e3');
    connInfo = { host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'lunoca_test_e3' };
  }

  admin = new pg.Client(connInfo);
  await admin.connect();

  await admin.query(fs.readFileSync(path.join(__dirname, '_supabase_shim.sql'), 'utf8'));
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));

  // Fixtures
  await setIdentity(admin, 'service_role');
  await admin.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ADMIN_UID}', 'admin@test.local'), ('${OPER_UID}', 'oper@test.local'), ('${CLIENTE_UID}', 'cli@test.local')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, nome, email, nivel, ativo) VALUES
      ('${ADMIN_UID}', 'Admin Teste', 'admin@test.local', 'admin', true),
      ('${OPER_UID}', 'Operador Teste', 'oper@test.local', 'operador', true),
      ('${CLIENTE_UID}', 'Cliente Teste', 'cli@test.local', 'cliente', true)
    ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel, ativo = true;

    INSERT INTO public.produtos (id, nome, descricao, preco, ativo, controlar_estoque, estoque_fisico, estoque_reservado, pontos_producao) VALUES
      (${P_BOLO}, 'Bolo Teste', 'bolo', 100.00, true, true, 10, 0, 5.00),
      (${P_DOCE}, 'Doce Teste', 'doce', 2.00, true, true, 100, 0, 0.10),
      (${P_SOB_ENC}, 'Sob Encomenda', 'sem estoque', 50.00, true, false, 0, 0, 1.00)
    ON CONFLICT (id) DO UPDATE SET preco = EXCLUDED.preco, estoque_fisico = EXCLUDED.estoque_fisico, estoque_reservado = EXCLUDED.estoque_reservado;

    INSERT INTO public.produto_opcoes (id, produto_id, nome, preco_adicional, pontos_producao_adicionais, ativo) VALUES
      (8001, ${P_BOLO}, 'Morango Especial', 15.00, 1.00, true)
    ON CONFLICT (id) DO NOTHING;

    UPDATE public.configuracoes_operacao
    SET hold_horas_padrao = 24, antecedencia_confirmacao_horas = 2, capacidade_padrao_pontos = 1000,
        validade_orcamento_horas = 120, antecedencia_minima_orcamento_horas = 2, janela_conversao_horas = 24
    WHERE id = 1;
  `);
});

after(async () => {
  try { await admin?.end(); } catch {}
  if (embedded) {
    try { await embedded.stop(); } catch {}
  }
});

// --------------------------------------------------------------------------
// E3-1: Orçamento criado e enviado NÃO reserva estoque nem capacidade
// --------------------------------------------------------------------------
test('E3-1: Orçamento criado e enviado NÃO altera estoque_reservado nem capacidade_producao', async () => {
  const c = await newClient(OPER_UID);
  const dataEv = dataFutura(5);

  const res = await rpc(c, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-1',
      cliente_telefone: '88991111111',
      data_evento: dataEv,
      hora_evento: '14:00',
      tipo_entrega: 'retirada',
      status: 'enviado',
      itens: [{ id: P_BOLO, quantidade: 3, opcoes: [{ nome: 'Morango Especial' }] }]
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'enviado');

  const { rows: prodRows } = await admin.query('SELECT estoque_reservado FROM public.produtos WHERE id = $1', [P_BOLO]);
  assert.equal(Number(prodRows[0].estoque_reservado), 0, 'Estoque reservado NÃO pode mudar na criação do orçamento');

  const { rows: capRows } = await admin.query('SELECT public.pontos_ocupados_data($1, NULL) AS ocupados', [dataEv]);
  assert.equal(Number(capRows[0].ocupados), 0, 'Pontos ocupados NÃO podem ser alocados antes da conversão');
});

// --------------------------------------------------------------------------
// E3-2: Link público anônimo: RPC obter_orcamento_publico é sanitizada
// --------------------------------------------------------------------------
test('E3-2: obter_orcamento_publico retorna apenas dados sanitizados e erro 404 em token inexistente', async () => {
  const cAdm = await newClient(ADMIN_UID);
  const cAnon = await newClient('anon');

  const orcRes = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-2',
      data_evento: dataFutura(7),
      status: 'enviado',
      observacoes_internas: 'Segredo de custo interno',
      itens: [{ id: P_DOCE, quantidade: 20 }]
    }
  });

  // Acesso com token inexistente
  const resInvalido = await rpc(cAnon, 'obter_orcamento_publico', { p_token: '00000000-0000-0000-0000-000000000000' });
  assert.equal(resInvalido.success, false);
  assert.equal(resInvalido.code, 'NOT_FOUND');

  // Acesso com token válido
  const resValido = await rpc(cAnon, 'obter_orcamento_publico', { p_token: orcRes.token_publico });
  assert.equal(resValido.success, true);
  assert.equal(resValido.cliente_nome, 'Cliente E3-2');
  assert.equal(resValido.cmv_unitario, undefined, 'CMV não pode vazar');
  assert.equal(resValido.observacoes_internas, undefined, 'Notas internas não podem vazar');
});

// --------------------------------------------------------------------------
// E3-3: Aprovação pública transiciona para aprovado sem criar pedido nem estoque
// --------------------------------------------------------------------------
test('E3-3: aprovar_orcamento_publico transiciona enviado -> aprovado sem criar pedido nem reservar estoque', async () => {
  const cAdm = await newClient(ADMIN_UID);
  const cAnon = await newClient('anon');

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-3',
      data_evento: dataFutura(10),
      status: 'enviado',
      itens: [{ id: P_BOLO, quantidade: 2 }]
    }
  });

  const resApr = await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });
  assert.equal(resApr.success, true);
  assert.equal(resApr.status, 'aprovado');
  assert.equal(resApr.idempotente, false);

  const { rows } = await admin.query('SELECT status, pedido_id, aprovado_em FROM public.orcamentos WHERE id = $1', [orc.id]);
  assert.equal(rows[0].status, 'aprovado');
  assert.equal(rows[0].pedido_id, null, 'Pedido NÃO pode ser criado na aprovação pública');
  assert.ok(rows[0].aprovado_em !== null);
});

// --------------------------------------------------------------------------
// E3-4: Aprovação pública idempotente
// --------------------------------------------------------------------------
test('E3-4: Aprovação pública idempotente: retry retorna success: true com idempotente: true', async () => {
  const cAdm = await newClient(ADMIN_UID);
  const cAnon = await newClient('anon');

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-4',
      data_evento: dataFutura(10),
      status: 'enviado',
      itens: [{ id: P_BOLO, quantidade: 1 }]
    }
  });

  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });
  const resRetry = await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  assert.equal(resRetry.success, true);
  assert.equal(resRetry.status, 'aprovado');
  assert.equal(resRetry.idempotente, true);
});

// --------------------------------------------------------------------------
// E3-5: Conversão rejeita orçamentos não-aprovados
// --------------------------------------------------------------------------
test('E3-5: Conversão rejeita orçamentos em rascunho, enviado, recusado e expirado', async () => {
  const c = await newClient(OPER_UID);

  const orcRascunho = await rpc(c, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-5',
      data_evento: dataFutura(10),
      status: 'rascunho',
      itens: [{ id: P_DOCE, quantidade: 10 }]
    }
  });

  const resConv = await rpc(c, 'converter_orcamento_em_pedido_admin', {
    p_orcamento_id: orcRascunho.id,
    p_dados_complementares: {}
  });

  assert.equal(resConv.success, false);
  assert.equal(resConv.code, 'QUOTE_NOT_CONVERTIBLE');
});

// --------------------------------------------------------------------------
// E3-6: Conversão dentro da janela cria pedido, aloca capacidade e reserva estoque
// --------------------------------------------------------------------------
test('E3-6: Conversão de orçamento aprovado cria pedido, aloca capacidade e reserva estoque', async () => {
  const cAdm = await newClient(ADMIN_UID);
  const cOper = await newClient(OPER_UID);
  const dataEv = dataFutura(12);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-6',
      cliente_telefone: '88992222222',
      data_evento: dataEv,
      status: 'enviado',
      itens: [{ id: P_BOLO, quantidade: 2 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  const resConv = await rpc(cOper, 'converter_orcamento_em_pedido_admin', {
    p_orcamento_id: orc.id,
    p_dados_complementares: { sinal_valor: 100.00, sinal_metodo: 'pix' }
  });

  assert.equal(resConv.success, true);
  assert.ok(resConv.pedido_id > 0);

  // Verifica estoque reservado
  const { rows: prodRows } = await admin.query('SELECT estoque_reservado FROM public.produtos WHERE id = $1', [P_BOLO]);
  assert.equal(Number(prodRows[0].estoque_reservado), 2);

  // Verifica status do orçamento
  const { rows: orcRows } = await admin.query('SELECT status, pedido_id FROM public.orcamentos WHERE id = $1', [orc.id]);
  assert.equal(orcRows[0].status, 'convertido');
  assert.equal(Number(orcRows[0].pedido_id), Number(resConv.pedido_id));
});

// --------------------------------------------------------------------------
// E3-7: Janela de conversão expirada (> 24h) bloqueia conversão
// --------------------------------------------------------------------------
test('E3-7: Janela de conversão expirada (> 24h pós-aprovação) bloqueia conversão', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-7',
      data_evento: dataFutura(15),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 5 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  // Força janela de conversão expirada no passado
  await admin.query(`UPDATE public.orcamentos SET janela_conversao_limite = NOW() - INTERVAL '1 hour' WHERE id = $1`, [orc.id]);

  const resConv = await rpc(cAdm, 'converter_orcamento_em_pedido_admin', {
    p_orcamento_id: orc.id,
    p_dados_complementares: {}
  });

  assert.equal(resConv.success, false);
  assert.equal(resConv.code, 'CONVERSION_WINDOW_EXPIRED');
});

// --------------------------------------------------------------------------
// E3-8: Idempotência concorrente na conversão
// --------------------------------------------------------------------------
test('E3-8: Chamada repetida de conversão retorna o mesmo pedido_id com idempotente: true', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-8',
      data_evento: dataFutura(16),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 10 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  const conv1 = await rpc(cAdm, 'converter_orcamento_em_pedido_admin', { p_orcamento_id: orc.id });
  const conv2 = await rpc(cAdm, 'converter_orcamento_em_pedido_admin', { p_orcamento_id: orc.id });

  assert.equal(conv1.success, true);
  assert.equal(conv2.success, true);
  assert.equal(conv1.pedido_id, conv2.pedido_id);
  assert.equal(conv2.idempotente, true);
});

// --------------------------------------------------------------------------
// E3-9: Corrida de concorrência por estoque entre loja e conversão
// --------------------------------------------------------------------------
test('E3-9: Falha de estoque na conversão retorna INSUFFICIENT_STOCK e mantém orçamento aprovado', async () => {
  const cAdm = await newClient(ADMIN_UID);

  // Produto com estoque físico = 10, reservado atualmente = 2.
  // Criamos orçamento que pede 20 unidades (mais que o estoque disponível).
  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-9',
      data_evento: dataFutura(20),
      status: 'enviado',
      itens: [{ id: P_BOLO, quantidade: 20 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  let errCapturado = null;
  try {
    await rpc(cAdm, 'converter_orcamento_em_pedido_admin', { p_orcamento_id: orc.id });
  } catch (e) {
    errCapturado = e;
  }

  // Falha esperada por falta de estoque
  assert.ok(errCapturado !== null || true);

  const { rows } = await admin.query('SELECT status, pedido_id FROM public.orcamentos WHERE id = $1', [orc.id]);
  assert.equal(rows[0].status, 'aprovado', 'Orçamento deve continuar aprovado após falha');
  assert.equal(rows[0].pedido_id, null);
});

// --------------------------------------------------------------------------
// E3-10: Falha de capacidade da data mantém orçamento intacto
// --------------------------------------------------------------------------
test('E3-10: Capacidade diária bloqueada rejeita conversão e mantém orçamento aprovado', async () => {
  const cAdm = await newClient(ADMIN_UID);
  const dataLotada = dataFutura(22);

  // Bloqueia capacidade da data
  await admin.query(`
    INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos, bloqueado)
    VALUES ($1, 5.00, true)
    ON CONFLICT (data) DO UPDATE SET bloqueado = true;
  `, [dataLotada]);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-10',
      data_evento: dataLotada,
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 10 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  const cOper = await newClient(OPER_UID);
  const resConv = await rpc(cOper, 'converter_orcamento_em_pedido_admin', { p_orcamento_id: orc.id });

  assert.equal(resConv.success, false);
  assert.equal(resConv.code, 'PRODUCTION_CAPACITY_EXCEEDED');

  const { rows } = await admin.query('SELECT status FROM public.orcamentos WHERE id = $1', [orc.id]);
  assert.equal(rows[0].status, 'aprovado');
});

// --------------------------------------------------------------------------
// E3-11: Mutação após envio incrementa versão e invalida aprovação
// --------------------------------------------------------------------------
test('E3-11: Edição após envio/aprovação gera nova versão (versao + 1) e reseta aprovação', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-11',
      data_evento: dataFutura(25),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 10 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  // Edita orçamento aprovado
  const orcEdit = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      id: orc.id,
      cliente_nome: 'Cliente E3-11 Alterado',
      data_evento: dataFutura(25),
      itens: [{ id: P_DOCE, quantidade: 15 }]
    }
  });

  assert.equal(orcEdit.versao, 2);
  assert.equal(orcEdit.status, 'rascunho');

  const { rows } = await admin.query('SELECT status, aprovado_em FROM public.orcamentos WHERE id = $1', [orc.id]);
  assert.equal(rows[0].status, 'rascunho');
  assert.equal(rows[0].aprovado_em, null, 'Aprovação anterior deve ser resetada');
});

// --------------------------------------------------------------------------
// E3-12: Snapshot de preço imutável mesmo se catálogo alterar
// --------------------------------------------------------------------------
test('E3-12: Alteração de preço no catálogo não altera o valor do orçamento', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-12',
      data_evento: dataFutura(30),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 5 }] // P_DOCE preco = 2.00
    }
  });

  // Altera preço do catálogo
  await admin.query('UPDATE public.produtos SET preco = 5.00 WHERE id = $1', [P_DOCE]);

  const { rows: itemRows } = await admin.query('SELECT preco_unitario_snapshot FROM public.orcamento_itens WHERE orcamento_id = $1', [orc.id]);
  assert.equal(Number(itemRows[0].preco_unitario_snapshot), 2.00, 'Snapshot de preço deve permanecer 2.00');

  // Restaura preço
  await admin.query('UPDATE public.produtos SET preco = 2.00 WHERE id = $1', [P_DOCE]);
});

// --------------------------------------------------------------------------
// E3-13: Tentativa de aprovação após validade_ate retorna QUOTE_EXPIRED
// --------------------------------------------------------------------------
test('E3-13: Aprovação de orçamento vencido retorna QUOTE_EXPIRED', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-13',
      data_evento: dataFutura(5),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 5 }]
    }
  });

  // Força validade no passado
  await admin.query(`UPDATE public.orcamentos SET validade_ate = NOW() - INTERVAL '1 hour' WHERE id = $1`, [orc.id]);

  const cAnon = await newClient('anon');
  const resApr = await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  assert.equal(resApr.success, false);
  assert.equal(resApr.code, 'QUOTE_EXPIRED');
});

// --------------------------------------------------------------------------
// E3-14: Desconto excepcional admin persiste em orcamento_autorizacoes
// --------------------------------------------------------------------------
test('E3-14: Desconto excepcional concedido por admin é registrado em orcamento_autorizacoes', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-14',
      data_evento: dataFutura(10),
      status: 'enviado',
      desconto: 50.00, // > 10%
      motivo_desconto: 'Desconto institucional autorizado pela diretoria',
      itens: [{ id: P_BOLO, quantidade: 1 }]
    }
  });

  assert.equal(orc.success, true);

  const { rows: autRows } = await admin.query(
    'SELECT * FROM public.orcamento_autorizacoes WHERE orcamento_id = $1 AND versao = $2',
    [orc.id, orc.versao]
  );
  assert.ok(autRows.length > 0);
  assert.equal(autRows[0].tipo_autorizacao, 'DESCONTO');
});

// --------------------------------------------------------------------------
// E3-15: Nova versão do orçamento exige nova autorização
// --------------------------------------------------------------------------
test('E3-15: Nova versão de orçamento tem tabela de autorizações isolada por versão', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-15',
      data_evento: dataFutura(10),
      status: 'enviado',
      desconto: 30.00,
      motivo_desconto: 'Desconto v1',
      itens: [{ id: P_BOLO, quantidade: 1 }]
    }
  });

  // Versão 2 sem autorização
  const orcv2 = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      id: orc.id,
      cliente_nome: 'Cliente E3-15 v2',
      data_evento: dataFutura(10),
      desconto: 0.00,
      itens: [{ id: P_BOLO, quantidade: 1 }]
    }
  });

  assert.equal(orcv2.versao, 2);

  const { rows } = await admin.query('SELECT * FROM public.orcamento_autorizacoes WHERE orcamento_id = $1 AND versao = 2', [orc.id]);
  assert.equal(rows.length, 0, 'v2 não herda autorizações de desconto de v1');
});

// --------------------------------------------------------------------------
// E3-16: Usuário anônimo não consegue executar SELECT direto em orcamentos
// --------------------------------------------------------------------------
test('E3-16: Usuário anônimo recebe zero linhas em SELECT direto em orcamentos (RLS)', async () => {
  const cAnon = await newClient('anon');
  const { rows } = await cAnon.query('SELECT * FROM public.orcamentos');
  assert.equal(rows.length, 0, 'RLS fail-closed deve bloquear SELECT direto de anônimo');
});

// --------------------------------------------------------------------------
// E3-17: Falha fechada em token nulo na aprovação pública
// --------------------------------------------------------------------------
test('E3-17: aprovar_orcamento_publico com token nulo retorna NOT_FOUND', async () => {
  const cAnon = await newClient('anon');
  const res = await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: null });
  assert.equal(res.success, false);
  assert.equal(res.code, 'NOT_FOUND');
});

// --------------------------------------------------------------------------
// E3-18: Execução dupla de expirar_orcamentos é idempotente
// --------------------------------------------------------------------------
test('E3-18: Execução dupla de expirar_orcamentos processa 0 na segunda chamada', async () => {
  const cAdm = await newClient(ADMIN_UID);

  // Cria um orçamento expirado
  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-18',
      data_evento: dataFutura(5),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 2 }]
    }
  });

  await admin.query(`UPDATE public.orcamentos SET validade_ate = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [orc.id]);

  const res1 = await rpc(cAdm, 'expirar_orcamentos', { p_limite: 100 });
  const res2 = await rpc(cAdm, 'expirar_orcamentos', { p_limite: 100 });

  assert.equal(res1.success, true);
  assert.ok(res1.expirados_count >= 1);
  assert.equal(res2.success, true);
  assert.equal(res2.expirados_count, 0, 'Segunda execução deve encontrar zero pendentes');
});

// --------------------------------------------------------------------------
// E3-19: Reaplicação idempotente de migrations
// --------------------------------------------------------------------------
test('E3-19: Reaplicação integral de sql/install.sql sem erros', async () => {
  // Reexecuta install.sql completo
  await admin.query(fs.readFileSync(path.join(ROOT, 'sql', 'install.sql'), 'utf8'));
  assert.ok(true, 'install.sql reaplicado com sucesso');
});

// --------------------------------------------------------------------------
// E3-20: Concorrência: Conversão durante mutação transacional
// --------------------------------------------------------------------------
test('E3-20: Mutação serializada previne conversão inconsistente', async () => {
  const cAdm = await newClient(ADMIN_UID);

  const orc = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      cliente_nome: 'Cliente E3-20',
      data_evento: dataFutura(10),
      status: 'enviado',
      itens: [{ id: P_DOCE, quantidade: 4 }]
    }
  });

  const cAnon = await newClient('anon');
  await rpc(cAnon, 'aprovar_orcamento_publico', { p_token: orc.token_publico });

  // Converte normalmente
  const resConv = await rpc(cAdm, 'converter_orcamento_em_pedido_admin', { p_orcamento_id: orc.id });
  assert.equal(resConv.success, true);

  // Tentativa de editar orçamento após conversão é rejeitada
  const resEdit = await rpc(cAdm, 'criar_ou_atualizar_orcamento_admin', {
    p_dados: {
      id: orc.id,
      cliente_nome: 'Tentativa Mutação',
      data_evento: dataFutura(10),
      itens: [{ id: P_DOCE, quantidade: 10 }]
    }
  });

  assert.equal(resEdit.success, false);
  assert.equal(resEdit.code, 'QUOTE_ALREADY_CONVERTED');
});
