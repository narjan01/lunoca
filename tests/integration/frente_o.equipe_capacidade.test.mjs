// ==============================================================================
// LUNOCA DOCERIA - SUÍTE DE INTEGRAÇÃO FRENTE O (EQUIPE, ESCALAS & CAPACIDADE REAL)
// ==============================================================================
// Valida os 16 gates obrigatórios O1 a O16 da Migration 030:
// O1:  Colaborador pode existir sem conta auth (auth_user_id NULL)
// O2:  auth_user_id não pode vincular dois colaboradores ativos (índice único parcial)
// O3:  Função pode ser atribuída ao colaborador (colaborador_funcoes)
// O4:  Turnos sobrepostos inválidos para o mesmo colaborador na mesma data (ESCALA_OVERLAP)
// O5:  Intervalo reduz corretamente minutos disponíveis
// O6:  Ausência integral zera capacidade do período afetado
// O7:  Ausência parcial desconta somente a interseção
// O8:  Escala concorrente não gera duplicidade/sobreposição
// O9:  Carga usa produto_tempos_producao da Frente M
// O10: Demanda é calculada separadamente por função
// O11: Capacidade humana não altera capacidade_producao da Frente E
// O12: Pedido cancelado não compõe demanda ativa
// O13: Sobrecarga gera alerta pelo motor proativo da Frente N (SOBRECARGA_EQUIPE)
// O14: Operador vê capacidade sem dados administrativos sensíveis
// O15: Anon/cliente não acessam RPCs internas de equipe (fail-closed)
// O16: Escala e capacidade possuem efeito financeiro ZERO no caixa e DRE
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
const PORT = 54400;

let admin;
let connInfo;
let teardownFn = null;

const ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const OPER_UID  = '22222222-2222-4222-8222-222222222222';
const CLI_UID   = 'aaaa1111-1111-4111-8111-111111111111';
const USER_EXTRA_UID = '33333333-3333-4333-8333-333333333333';

let cliId;
let prodId;
let recursoMaoObraId;
let funcConfeitariaId;
let funcAuxiliarId;
let funcEmbalagemId;

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
  const idx = activeClients.indexOf(c);
  if (idx !== -1) activeClients.splice(idx, 1);
  try {
    await c.end();
  } catch (_) {}
}

async function rpc(c, fnName, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  const callParams = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const sql = keys.length === 0
    ? `SELECT public.${fnName}() AS res`
    : `SELECT public.${fnName}(${callParams}) AS res`;
  const vals = keys.map((k) => args[k]);
  const { rows } = await c.query(sql, vals);
  return rows[0]?.res;
}

before(async () => {
  const setup = await setupEmbeddedPostgres({
    rootDir: ROOT,
    dirName: '.pg-integration-030',
    port: PORT,
    dbName: 'lunoca_test_030'
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
      ('${CLI_UID}',   'cliente@lunoca.test'),
      ('${USER_EXTRA_UID}', 'extra@lunoca.test')
    ON CONFLICT (id) DO NOTHING;
  `);

  await admin.query(`
    INSERT INTO public.profiles (id, email, nivel, nome, ativo)
    VALUES
      ('${ADMIN_UID}', 'admin@lunoca.test', 'admin',    'Admin Lunoca', true),
      ('${OPER_UID}',  'oper@lunoca.test',  'operador', 'Operador Lunoca', true),
      ('${CLI_UID}',   'cliente@lunoca.test','cliente',  'Cliente Lunoca', true),
      ('${USER_EXTRA_UID}', 'extra@lunoca.test','operador', 'Colaborador Extra', true)
    ON CONFLICT (id) DO UPDATE SET nivel = EXCLUDED.nivel, ativo = true;
  `);

  const resCli = await admin.query(
    `INSERT INTO public.clientes (auth_user_id, nome, telefone, telefone_normalizado, email)
     VALUES ($1, 'Cliente Frente O', '(85) 99801-3000', '5585998013000', 'cliente@lunoca.test')
     ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
     DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [CLI_UID]
  );
  cliId = Number(resCli.rows[0].id);

  // Funções padrão
  const fConf = await admin.query(`SELECT id FROM public.funcoes_equipe WHERE codigo = 'CONFEITARIA'`);
  funcConfeitariaId = fConf.rows[0]?.id;

  const fAux = await admin.query(`SELECT id FROM public.funcoes_equipe WHERE codigo = 'AUXILIAR'`);
  funcAuxiliarId = fAux.rows[0]?.id;

  const fEmb = await admin.query(`SELECT id FROM public.funcoes_equipe WHERE codigo = 'EMBALAGEM'`);
  funcEmbalagemId = fEmb.rows[0]?.id;

  // Recurso mão de obra Frente M
  const rMo = await admin.query(`SELECT id FROM public.recursos_producao WHERE tipo = 'mao_de_obra' LIMIT 1`);
  recursoMaoObraId = rMo.rows[0]?.id;

  // Produto com tempos de produção (Frente M)
  const prodRes = await admin.query(`
    INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
    VALUES ('Torta Holandesa Real', 140.00, 20, true, false)
    RETURNING id;
  `);
  prodId = prodRes.rows[0]?.id;

  // Tempos padrão do produto:
  // Preparo (Auxiliar) -> 30 min
  // Decoração (Confeitaria) -> 45 min
  // Embalagem (Embalagem) -> 15 min
  await admin.query(`
    INSERT INTO public.produto_tempos_producao (produto_id, etapa, minutos_padrao, recurso_id)
    VALUES
      ($1, 'preparo', 30.00, $2),
      ($1, 'decoracao', 45.00, $2),
      ($1, 'embalagem', 15.00, $2)
    ON CONFLICT (produto_id, etapa, recurso_id) DO UPDATE SET minutos_padrao = EXCLUDED.minutos_padrao;
  `, [prodId, recursoMaoObraId]);
});

after(async () => {
  for (const c of activeClients) {
    try { await c.end(); } catch (_) {}
  }
  await closeClient(admin);
  if (teardownFn) await teardownFn();
});

// ==============================================================================
// O1: Colaborador pode existir sem conta auth (auth_user_id NULL)
// ==============================================================================
test('O1: colaborador pode existir sem conta auth (auth_user_id NULL)', async () => {
  await setIdentity(admin, ADMIN_UID);

  const res = await rpc(admin, 'salvar_colaborador_admin', {
    p_nome: 'Maria da Silva (Confeiteira)',
    p_apelido: 'Tia Maria',
    p_telefone: '5585999990001',
    p_email: 'maria@doces.test',
    p_auth_user_id: null, // Sem login no sistema
    p_ativo: true,
    p_observacoes: 'Especialista em bicos russos'
  });

  assert.equal(res.success, true);
  assert.ok(res.colaborador_id > 0);

  // Consulta no banco comprova auth_user_id IS NULL
  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query('SELECT auth_user_id, ativo FROM public.colaboradores WHERE id = $1', [res.colaborador_id]);
  assert.equal(rows[0].auth_user_id, null);
  assert.equal(rows[0].ativo, true);
});

// ==============================================================================
// O2: auth_user_id não pode vincular dois colaboradores ativos (índice único)
// ==============================================================================
test('O2: auth_user_id não pode vincular dois colaboradores ativos', async () => {
  await setIdentity(admin, ADMIN_UID);

  // 1º Colaborador com USER_EXTRA_UID
  const res1 = await rpc(admin, 'salvar_colaborador_admin', {
    p_nome: 'Carlos Eduardo',
    p_auth_user_id: USER_EXTRA_UID,
    p_ativo: true
  });
  assert.equal(res1.success, true);

  // 2º Colaborador tentando usar o mesmo auth_user_id de um colaborador ativo
  await assert.rejects(
    rpc(admin, 'salvar_colaborador_admin', {
      p_nome: 'Carlos Clone',
      p_auth_user_id: USER_EXTRA_UID,
      p_ativo: true
    }),
    /unique|uq_colaborador_auth_user_ativo|duplicate key/i,
    'Deve rejeitar duplicidade de vínculo com o mesmo auth_user_id ativo'
  );
});

// ==============================================================================
// O3: Função pode ser atribuída ao colaborador (colaborador_funcoes)
// ==============================================================================
test('O3: função pode ser atribuída ao colaborador (colaborador_funcoes)', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', {
    p_nome: 'Joana Confeiteira',
    p_ativo: true
  });
  const colabId = cRes.colaborador_id;

  // Atribui função Confeitaria
  const vRes1 = await rpc(admin, 'vincular_funcao_colaborador_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_principal: true
  });
  assert.equal(vRes1.success, true);

  // Atribui função Embalagem como secundária
  const vRes2 = await rpc(admin, 'vincular_funcao_colaborador_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcEmbalagemId,
    p_principal: false
  });
  assert.equal(vRes2.success, true);

  await setIdentity(admin, 'service_role');
  const { rows } = await admin.query('SELECT funcao_id, principal FROM public.colaborador_funcoes WHERE colaborador_id = $1 ORDER BY funcao_id', [colabId]);
  assert.equal(rows.length, 2);
  const princ = rows.find(r => r.principal === true);
  assert.equal(princ.funcao_id, String(funcConfeitariaId));
});

// ==============================================================================
// O4: Turnos sobrepostos inválidos para o mesmo colaborador na mesma data
// ==============================================================================
test('O4: turnos sobrepostos inválidos para o mesmo colaborador na mesma data (ESCALA_OVERLAP)', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Roberto Escala', p_ativo: true });
  const colabId = cRes.colaborador_id;

  // 1ª Escala: 08:00 às 14:00
  const e1 = await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-20',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '14:00:00',
    p_intervalo_minutos: 30
  });
  assert.equal(e1.success, true);

  // 2ª Escala sobreposta: 12:00 às 18:00 na mesma data
  await assert.rejects(
    rpc(admin, 'salvar_escala_equipe_admin', {
      p_colaborador_id: colabId,
      p_funcao_id: funcConfeitariaId,
      p_data_escala: '2026-10-20',
      p_hora_inicio: '12:00:00',
      p_hora_fim: '18:00:00'
    }),
    /ESCALA_OVERLAP/i,
    'Deve bloquear escala sobreposta para o mesmo colaborador na mesma data'
  );
});

// ==============================================================================
// O5: Intervalo reduz corretamente minutos disponíveis
// ==============================================================================
test('O5: intervalo reduz corretamente minutos disponíveis', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Paula Intervalo', p_ativo: true });
  const colabId = cRes.colaborador_id;

  // Turno: 08:00 às 17:00 (9 horas = 540 min). Intervalo: 60 min. Disponível esperado: 480 min.
  const eRes = await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-21',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '17:00:00',
    p_intervalo_minutos: 60
  });
  assert.equal(eRes.success, true);

  const list = await rpc(admin, 'obter_escala_periodo', {
    p_data_inicio: '2026-10-21',
    p_data_fim: '2026-10-21',
    p_colaborador_id: colabId
  });

  assert.equal(list.success, true);
  const escala = list.escalas[0];
  assert.equal(Number(escala.minutos_disponiveis), 480);
});

// ==============================================================================
// O6: Ausência integral zera capacidade do período afetado
// ==============================================================================
test('O6: ausência integral zera capacidade do período afetado', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Lucia Ausente', p_ativo: true });
  const colabId = cRes.colaborador_id;

  // Escala: 08:00 às 16:00 (480 min brutos - 60 min intervalo = 420 min)
  await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcAuxiliarId,
    p_data_escala: '2026-10-22',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '16:00:00',
    p_intervalo_minutos: 60
  });

  // Registra ausência integral (hora_inicio e hora_fim = null)
  const aRes = await rpc(admin, 'registrar_ausencia_equipe_admin', {
    p_colaborador_id: colabId,
    p_data_inicio: '2026-10-22',
    p_data_fim: '2026-10-22',
    p_hora_inicio: null,
    p_hora_fim: null,
    p_tipo: 'FOLGA',
    p_motivo_geral: 'Folga compensatória'
  });
  assert.equal(aRes.success, true);

  const list = await rpc(admin, 'obter_escala_periodo', {
    p_data_inicio: '2026-10-22',
    p_data_fim: '2026-10-22',
    p_colaborador_id: colabId
  });

  assert.equal(Number(list.escalas[0].minutos_disponiveis), 0, 'Ausência integral deve zerar minutos disponíveis');
});

// ==============================================================================
// O7: Ausência parcial desconta somente a interseção
// ==============================================================================
test('O7: ausência parcial desconta somente a interseção', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Beatriz Parcial', p_ativo: true });
  const colabId = cRes.colaborador_id;

  // Escala: 08:00 às 17:00 (540 min - 60 min intervalo = 480 min)
  await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-23',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '17:00:00',
    p_intervalo_minutos: 60
  });

  // Ausência parcial: 14:00 às 16:00 (2 horas = 120 min de interseção)
  await rpc(admin, 'registrar_ausencia_equipe_admin', {
    p_colaborador_id: colabId,
    p_data_inicio: '2026-10-23',
    p_data_fim: '2026-10-23',
    p_hora_inicio: '14:00:00',
    p_hora_fim: '16:00:00',
    p_tipo: 'ATESTADO',
    p_motivo_geral: 'Consulta odontológica'
  });

  const list = await rpc(admin, 'obter_escala_periodo', {
    p_data_inicio: '2026-10-23',
    p_data_fim: '2026-10-23',
    p_colaborador_id: colabId
  });

  // 480 min - 120 min de ausência = 360 min
  assert.equal(Number(list.escalas[0].minutos_disponiveis), 360);
});

// ==============================================================================
// O8: Escala concorrente não gera duplicidade/sobreposição
// ==============================================================================
test('O8: escala concorrente não gera duplicidade/sobreposição', async () => {
  await setIdentity(admin, ADMIN_UID);

  const cRes = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Marcos Concorrente', p_ativo: true });
  const colabId = cRes.colaborador_id;

  const client1 = await newClient(ADMIN_UID);
  const client2 = await newClient(ADMIN_UID);

  // Ambas as conexões tentam inserir escala para o mesmo colaborador no mesmo horário
  const p1 = rpc(client1, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-24',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '16:00:00'
  });
  const p2 = rpc(client2, 'salvar_escala_equipe_admin', {
    p_colaborador_id: colabId,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-24',
    p_hora_inicio: '10:00:00',
    p_hora_fim: '18:00:00'
  });

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exatamente uma chamada concorrente deve suceder');
  assert.equal(rejected.length, 1, 'A outra chamada concorrente deve ser rejeitada por sobreposição');

  await closeClient(client1);
  await closeClient(client2);
});

// ==============================================================================
// O9: Carga usa produto_tempos_producao da Frente M
// ==============================================================================
test('O9: carga usa produto_tempos_producao da Frente M', async () => {
  await setIdentity(admin, 'service_role');

  const dataAlvo = '2026-10-25';
  // Criar pedido de 2 Tortas Holandesas para a dataAlvo
  // 2 tortas * 30 min preparo = 60 min (Auxiliar)
  // 2 tortas * 45 min decoracao = 90 min (Confeitaria)
  // 2 tortas * 15 min embalagem = 30 min (Embalagem)
  // Total: 180 min
  const { rows: pedRows } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Carga O9', 'carga@lunoca.test', '5585999990009', $1, $2, '18:00:00',
      'retirada', 'Loja', 280.00, 280.00,
      'confirmado', 'pago', 'aguardando_producao', 'Confirmado',
      'pix', '[]'::jsonb
    ) RETURNING id;
  `, [cliId, dataAlvo]);
  const pedId = pedRows[0].id;

  await admin.query(`
    INSERT INTO public.pedido_itens (pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot, subtotal)
    VALUES ($1, $2, 'Torta Holandesa Real', 2, 140.00, 280.00)
  `, [pedId, prodId]);

  await setIdentity(admin, ADMIN_UID);
  const carga = await rpc(admin, 'obter_carga_equipe_data', { p_data: dataAlvo });
  assert.equal(carga.success, true);
  assert.equal(Number(carga.total_minutos_demandados), 180.00);
});

// ==============================================================================
// O10: Demanda é calculada separadamente por função
// ==============================================================================
test('O10: demanda é calculada separadamente por função', async () => {
  await setIdentity(admin, ADMIN_UID);

  const dataAlvo = '2026-10-25';
  const carga = await rpc(admin, 'obter_carga_equipe_data', { p_data: dataAlvo });
  assert.equal(carga.success, true);

  const dConf = carga.demanda_por_funcao.find(d => d.codigo === 'CONFEITARIA');
  const dAux  = carga.demanda_por_funcao.find(d => d.codigo === 'AUXILIAR');
  const dEmb  = carga.demanda_por_funcao.find(d => d.codigo === 'EMBALAGEM');

  assert.ok(dConf, 'Deve conter demanda para Confeitaria');
  assert.ok(dAux, 'Deve conter demanda para Auxiliar');
  assert.ok(dEmb, 'Deve conter demanda para Embalagem');

  assert.equal(Number(dConf.minutos_demandados), 90.00);
  assert.equal(Number(dAux.minutos_demandados), 60.00);
  assert.equal(Number(dEmb.minutos_demandados), 30.00);
});

// ==============================================================================
// O11: Capacidade humana não altera capacidade_producao da Frente E
// ==============================================================================
test('O11: capacidade humana não altera capacidade_producao da Frente E', async () => {
  await setIdentity(admin, 'service_role');

  const dataAlvo = '2026-10-26';
  await admin.query(`
    INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos, bloqueado)
    VALUES ('${dataAlvo}', 35.00, false)
    ON CONFLICT (data) DO UPDATE SET capacidade_maxima_pontos = 35.00;
  `);

  const { rows: capEAntes } = await admin.query(`SELECT capacidade_maxima_pontos, bloqueado FROM public.capacidade_producao WHERE data = '${dataAlvo}'`);

  await setIdentity(admin, ADMIN_UID);
  // Escalar múltiplos colaboradores
  const c1 = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Colab E1', p_ativo: true });
  await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: c1.colaborador_id,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: dataAlvo,
    p_hora_inicio: '08:00:00',
    p_hora_fim: '18:00:00',
    p_intervalo_minutos: 60
  });

  // Obter capacidade humana da Frente O
  await rpc(admin, 'obter_capacidade_humana_data', { p_data: dataAlvo });

  await setIdentity(admin, 'service_role');
  const { rows: capEDepois } = await admin.query(`SELECT capacidade_maxima_pontos, bloqueado FROM public.capacidade_producao WHERE data = '${dataAlvo}'`);

  assert.deepEqual(capEDepois[0], capEAntes[0], 'Frente E deve permanecer inalterada byte-a-byte');
});

// ==============================================================================
// O12: Pedido cancelado não compõe demanda ativa
// ==============================================================================
test('O12: pedido cancelado não compõe demanda ativa', async () => {
  await setIdentity(admin, 'service_role');

  const dataAlvo = '2026-10-27';
  // Pedido cancelado
  const { rows: pCanc } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Cancelado O12', 'canc@lunoca.test', '5585999990012', $1, $2, '18:00:00',
      'retirada', 'Loja', 140.00, 140.00,
      'cancelado', 'estornado', 'aguardando_producao', 'Cancelado',
      'pix', '[]'::jsonb
    ) RETURNING id;
  `, [cliId, dataAlvo]);
  const pedCancId = pCanc[0].id;

  await admin.query(`
    INSERT INTO public.pedido_itens (pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot, subtotal)
    VALUES ($1, $2, 'Torta Holandesa Real', 1, 140.00, 140.00)
  `, [pedCancId, prodId]);

  await setIdentity(admin, ADMIN_UID);
  const carga = await rpc(admin, 'obter_carga_equipe_data', { p_data: dataAlvo });
  assert.equal(Number(carga.total_minutos_demandados), 0, 'Pedido cancelado não deve gerar minutos de demanda');
});

// ==============================================================================
// O13: Sobrecarga gera alerta pelo motor proativo da Frente N (SOBRECARGA_EQUIPE)
// ==============================================================================
test('O13: sobrecarga gera alerta pelo motor proativo da Frente N (SOBRECARGA_EQUIPE)', async () => {
  await setIdentity(admin, 'service_role');

  const dataHoje = new Date().toISOString().slice(0, 10);

  // 1. Escalar 1 colaborador para Embalagem por apenas 1 hora (60 min disponíveis)
  const { rows: cEmb } = await admin.query(`INSERT INTO public.colaboradores (nome, ativo) VALUES ('Embalador Limitado', true) RETURNING id`);
  const colabEmbId = cEmb[0].id;

  await admin.query(`
    INSERT INTO public.escalas_equipe (colaborador_id, funcao_id, data_escala, hora_inicio, hora_fim, intervalo_minutos)
    VALUES ($1, $2, $3, '08:00:00', '09:00:00', 0)
  `, [colabEmbId, funcEmbalagemId, dataHoje]);

  // 2. Inserir pedidos com alta demanda de embalagem para hoje: 10 tortas * 15 min embalagem = 150 min demandados
  // Demanda: 150 min / Capacidade: 60 min = 250% de utilização -> CRÍTICO (> 120%)
  const { rows: pSob } = await admin.query(`
    INSERT INTO public.pedidos (
      nome_cliente, email_cliente, telefone_cliente, cliente_id_rel, data_entrega, hora_entrega,
      modalidade_entrega, endereco_entrega, total, subtotal,
      status_comercial, status_financeiro, status_operacional, status,
      pagamento, itens
    ) VALUES (
      'Cliente Sobrecarga O13', 'sob@lunoca.test', '5585999990013', $1, $2, '18:00:00',
      'retirada', 'Loja', 1400.00, 1400.00,
      'confirmado', 'pago', 'aguardando_producao', 'Confirmado',
      'pix', '[]'::jsonb
    ) RETURNING id;
  `, [cliId, dataHoje]);
  const pedSobId = pSob[0].id;

  await admin.query(`
    INSERT INTO public.pedido_itens (pedido_id, produto_id, produto_nome_snapshot, quantidade, preco_unitario_snapshot, subtotal)
    VALUES ($1, $2, 'Torta Holandesa Real', 10, 140.00, 1400.00)
  `, [pedSobId, prodId]);

  // 3. Processamento proativo autônomo da Frente N
  await setIdentity(admin, ADMIN_UID);
  const proc = await rpc(admin, 'processar_alertas_operacionais', {});
  assert.equal(proc.success, true);

  // 4. Obter alertas e conferir SOBRECARGA_EQUIPE
  const list = await rpc(admin, 'obter_alertas_operacionais_admin', { p_tipo: 'SOBRECARGA_EQUIPE' });
  assert.equal(list.success, true);

  const alerta = list.alertas.find(a => a.tipo_alerta === 'SOBRECARGA_EQUIPE' && a.origem_id.includes(String(funcEmbalagemId)));
  assert.ok(alerta, 'Deve gerar alerta de SOBRECARGA_EQUIPE');
  assert.equal(alerta.nivel, 'CRITICO');
  assert.ok(Number(alerta.dados_contexto.percentual_utilizacao) >= 120.00);
});

// ==============================================================================
// O14: Operador vê capacidade sem dados administrativos sensíveis
// ==============================================================================
test('O14: operador vê capacidade sem dados administrativos sensíveis', async () => {
  const oper = await newClient(OPER_UID);

  const dataHoje = new Date().toISOString().slice(0, 10);
  const resCap = await rpc(oper, 'obter_capacidade_humana_data', { p_data: dataHoje });
  assert.equal(resCap.success, true);
  assert.ok(resCap.funcoes.length >= 1);

  // Verifica que não há dados financeiros ou salariais
  for (const f of resCap.funcoes) {
    assert.equal(f.custo_hora, undefined);
    assert.equal(f.salario, undefined);
  }

  await closeClient(oper);
});

// ==============================================================================
// O15: Anon/cliente não acessam RPCs internas de equipe (fail-closed)
// ==============================================================================
test('O15: anon e cliente comum não acessam RPCs de equipe (fail-closed)', async () => {
  const anon = await newClient('anon');
  const cli = await newClient(CLI_UID);

  // Anon
  await assert.rejects(
    rpc(anon, 'obter_capacidade_humana_data', { p_data: '2026-10-28' }),
    /permission denied|UNAUTHENTICATED/i
  );
  await assert.rejects(
    rpc(anon, 'salvar_colaborador_admin', { p_nome: 'Hacker' }),
    /permission denied|PERMISSION_DENIED/i
  );

  // Cliente comum
  const resCli = await rpc(cli, 'salvar_colaborador_admin', { p_nome: 'Tentativa Cliente' });
  assert.equal(resCli.success, false);
  assert.equal(resCli.code, 'PERMISSION_DENIED');

  await closeClient(anon);
  await closeClient(cli);
});

// ==============================================================================
// O16: Escala e capacidade possuem efeito financeiro ZERO no caixa e DRE
// ==============================================================================
test('O16: escala e capacidade possuem efeito financeiro ZERO no caixa e DRE', async () => {
  await setIdentity(admin, 'service_role');

  const { rows: lAntes } = await admin.query('SELECT count(*) AS qtd FROM public.financeiro_lancamentos');
  const { rows: pAntes } = await admin.query('SELECT count(*) AS qtd FROM public.pedido_pagamentos');

  await setIdentity(admin, ADMIN_UID);

  // Cadastra colaborador, escala, turno e gera painel de capacidade
  const c = await rpc(admin, 'salvar_colaborador_admin', { p_nome: 'Auditoria Financeira Zero', p_ativo: true });
  await rpc(admin, 'salvar_escala_equipe_admin', {
    p_colaborador_id: c.colaborador_id,
    p_funcao_id: funcConfeitariaId,
    p_data_escala: '2026-10-29',
    p_hora_inicio: '08:00:00',
    p_hora_fim: '17:00:00',
    p_intervalo_minutos: 60
  });
  await rpc(admin, 'obter_painel_capacidade_equipe', { p_data_inicio: '2026-10-29', p_data_fim: '2026-10-29' });
  await rpc(admin, 'processar_alertas_operacionais', {});

  await setIdentity(admin, 'service_role');
  const { rows: lDepois } = await admin.query('SELECT count(*) AS qtd FROM public.financeiro_lancamentos');
  const { rows: pDepois } = await admin.query('SELECT count(*) AS qtd FROM public.pedido_pagamentos');

  assert.equal(lDepois[0].qtd, lAntes[0].qtd, 'financeiro_lancamentos deve permanecer intocado');
  assert.equal(pDepois[0].qtd, pAntes[0].qtd, 'pedido_pagamentos deve permanecer intocado');
});
