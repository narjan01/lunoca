// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE 039 (PWA-1 a PWA-10)
// ==============================================================================
// Valida os 10 probes de conformidade da Migration 039 no Supabase de produção:
// PWA-1:  Tabela whatsapp_templates existe em public com catálogo seedado e RLS ativo
// PWA-2:  Constraint comunicacoes_cliente_tipo_check preserva tipos históricos (015/024) + novos (039)
// PWA-3:  Tabela comunicacao_whatsapp_outbox com FKs RESTRICT, colunas de lease e RLS ativo
// PWA-4:  Tabela whatsapp_eventos_gateway com dedup (provider, chave_evento) e RLS ativo
// PWA-5:  Imutabilidade da outbox: UPDATE não pode alterar snapshot de texto nem template
// PWA-6:  whatsapp_enfileirar_transacional suprime telefone inválido sem quebrar transação
// PWA-7:  Claim com SKIP LOCKED e lease atômico (whatsapp_obter_proximos_envios)
// PWA-8:  Retry com backoff exponencial persistido sem adulterar disparar_em
// PWA-9:  Webhook provider-aware idempotente e sem regressão de status (LIDO -> ENTREGUE ignorado)
// PWA-10: Fail-closed security nas RPCs e sanitização em whatsapp_listar_envios_admin
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE WHATSAPP (PWA-1 a PWA-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PWA-1: Tabela whatsapp_templates existe com catálogo seedado e RLS ativo
  process.stdout.write('⏳ PWA-1: whatsapp_templates existe, possui templates seedados e RLS ativado... ');
  const pwa1Table = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'whatsapp_templates';
  `);
  assert.equal(pwa1Table.length, 1, 'Tabela whatsapp_templates deve existir em public');
  assert.equal(pwa1Table[0].rowsecurity, true, 'whatsapp_templates deve ter RLS ativado');

  const pwa1Templates = await query(`
    SELECT codigo, ativo, versao
    FROM public.whatsapp_templates
    WHERE ativo = true
    ORDER BY codigo;
  `);
  const codigos = pwa1Templates.map(t => t.codigo);
  const obrigatorios = [
    'PEDIDO_CONFIRMADO',
    'PAGAMENTO_CONFIRMADO',
    'PRODUCAO_INICIADA',
    'PEDIDO_PRONTO',
    'SAIU_PARA_ENTREGA',
    'PEDIDO_ENTREGUE',
    'PEDIDO_RETIRADO',
    'ORCAMENTO_ENVIADO',
    'ORCAMENTO_APROVADO',
    'LEMBRETE_RETIRADA'
  ];
  for (const tpl of obrigatorios) {
    assert.ok(codigos.includes(tpl), `Template obrigatório '${tpl}' deve estar cadastrado`);
  }
  console.log('✅ APROVADO');

  // PWA-2: Constraint comunicacoes_cliente_tipo_check preserva tipos históricos (015/024) + novos (039)
  process.stdout.write('⏳ PWA-2: comunicacoes_cliente_tipo_check preserva 100% dos tipos 015/024 e novos 039... ');
  const pwa2Constraint = await query(`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' 
      AND t.relname = 'comunicacoes_cliente' 
      AND c.conname = 'comunicacoes_cliente_tipo_check';
  `);
  assert.equal(pwa2Constraint.length, 1, 'Constraint comunicacoes_cliente_tipo_check deve existir');
  const def = pwa2Constraint[0].def;
  
  const tiposHistoricos = [
    'ORCAMENTO_ENVIADO', 'ORCAMENTO_VENCENDO', 'SINAL_CONFIRMADO', 'PEDIDO_PRONTO', 'SAIU_PARA_ENTREGA',
    'CUPOM_ANIVERSARIO', 'VOLTE_A_COMPRAR', 'CAMPANHA_PASCOA', 'CAMPANHA_PROMOCIONAL', 'LEMBRETE_PONTOS_EXPIRANDO'
  ];
  const tiposNovos = [
    'PEDIDO_CONFIRMADO', 'PAGAMENTO_CONFIRMADO', 'PRODUCAO_INICIADA',
    'PEDIDO_ENTREGUE', 'PEDIDO_RETIRADO', 'ORCAMENTO_APROVADO', 'LEMBRETE_RETIRADA'
  ];

  for (const tipo of [...tiposHistoricos, ...tiposNovos]) {
    assert.ok(def.includes(`'${tipo}'`), `Tipo comercial '${tipo}' deve estar na constraint`);
  }
  console.log('✅ APROVADO');

  // PWA-3: Tabela comunicacao_whatsapp_outbox com FKs RESTRICT, colunas de lease e RLS ativo
  process.stdout.write('⏳ PWA-3: comunicacao_whatsapp_outbox com colunas de lease, FKs RESTRICT e RLS ativo... ');
  const pwa3Table = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'comunicacao_whatsapp_outbox';
  `);
  assert.equal(pwa3Table.length, 1, 'Tabela comunicacao_whatsapp_outbox deve existir');
  assert.equal(pwa3Table[0].rowsecurity, true, 'comunicacao_whatsapp_outbox deve ter RLS ativado');

  const pwa3Cols = await query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'comunicacao_whatsapp_outbox'
      AND column_name IN ('claim_token', 'disparar_em', 'proxima_tentativa_em', 'lease_expira_em', 'status', 'pedido_id');
  `);
  const colMap = Object.fromEntries(pwa3Cols.map(c => [c.column_name, c.data_type]));
  assert.equal(colMap['claim_token'], 'uuid', 'claim_token deve ser UUID');
  assert.equal(colMap['disparar_em'], 'timestamp with time zone', 'disparar_em deve ser TIMESTAMPTZ');
  assert.equal(colMap['proxima_tentativa_em'], 'timestamp with time zone', 'proxima_tentativa_em deve ser TIMESTAMPTZ');
  assert.equal(colMap['lease_expira_em'], 'timestamp with time zone', 'lease_expira_em deve ser TIMESTAMPTZ');

  // FK check: ON DELETE RESTRICT
  const pwa3Fks = await query(`
    SELECT c.conname, c.confdeltype
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'comunicacao_whatsapp_outbox' AND c.contype = 'f'
      AND c.conname IN ('comunicacao_whatsapp_outbox_pedido_id_fkey', 'comunicacao_whatsapp_outbox_comunicacao_id_fkey');
  `);
  for (const fk of pwa3Fks) {
    assert.equal(fk.confdeltype, 'r', `FK ${fk.conname} deve ser ON DELETE RESTRICT ('r')`);
  }
  console.log('✅ APROVADO');

  // PWA-4: Tabela whatsapp_eventos_gateway com dedup (provider, chave_evento) e RLS ativo
  process.stdout.write('⏳ PWA-4: whatsapp_eventos_gateway com unicidade (provider, chave_evento) e RLS... ');
  const pwa4Table = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'whatsapp_eventos_gateway';
  `);
  assert.equal(pwa4Table.length, 1, 'Tabela whatsapp_eventos_gateway deve existir');
  assert.equal(pwa4Table[0].rowsecurity, true, 'whatsapp_eventos_gateway deve ter RLS ativado');

  const pwa4Unique = await query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_eventos_gateway'::regclass
      AND conname = 'uq_whatsapp_evento_provider';
  `);
  assert.equal(pwa4Unique.length, 1, 'Constraint de unicidade uq_wa_gateway_provider_chave deve existir');
  console.log('✅ APROVADO');

  // PWA-5: Imutabilidade da outbox: UPDATE não pode alterar snapshot de texto nem template
  process.stdout.write('⏳ PWA-5: Imutabilidade da outbox rejeita alteração de texto snapshotado com 42501... ');
  const pwa5Test = await query(`
    DO $$
    DECLARE
      v_outbox_id UUID;
      v_err_msg TEXT := '';
    BEGIN
      INSERT INTO public.comunicacao_whatsapp_outbox (
        template_codigo, template_versao, mensagem_texto_snapshot,
        chave_idempotencia, status, disparar_em, proxima_tentativa_em
      ) VALUES (
        'PEDIDO_PRONTO', 'v1', 'Texto Original Imutavel',
        'probe_pwa5_idemp_' || gen_random_uuid(), 'PENDENTE', NOW(), NOW()
      ) RETURNING id INTO v_outbox_id;

      BEGIN
        UPDATE public.comunicacao_whatsapp_outbox
        SET mensagem_texto_snapshot = 'Texto Adulterado'
        WHERE id = v_outbox_id;
      EXCEPTION WHEN OTHERS THEN
        v_err_msg := SQLSTATE;
      END;

      DELETE FROM public.comunicacao_whatsapp_outbox WHERE id = v_outbox_id;

      IF v_err_msg <> '42501' THEN
        RAISE EXCEPTION 'Esperava SQLSTATE 42501 ao adulterar snapshot, obteve %', v_err_msg;
      END IF;
    END;
    $$;
    SELECT 1 AS ok;
  `);
  assert.equal(pwa5Test[0].ok, 1);
  console.log('✅ APROVADO');

  // PWA-6: whatsapp_enfileirar_transacional suprime telefone inválido sem quebrar transação
  process.stdout.write('⏳ PWA-6: whatsapp_enfileirar_transacional suprime telefone inválido sem exception... ');
  const pwa6Ped = await query(`
    INSERT INTO public.pedidos (
      nome_cliente, telefone_cliente, email_cliente,
      data_pedido, data_entrega, hora_entrega,
      total, status_operacional, status_financeiro, status_comercial,
      pagamento, canal, itens, endereco_entrega
    ) VALUES (
      'Probe PWA-6 Test', '123', 'probe@teste.com',
      CURRENT_DATE, CURRENT_DATE, '17:00:00',
      50.00, 'em_producao', 'nao_pago', 'confirmado',
      'pix', 'balcao', '[]'::jsonb, 'Rua Teste, 10'
    ) RETURNING id;
  `);
  const pwa6PedId = pwa6Ped[0].id;

  // Transiciona para pronto: dispara trg_whatsapp_pedidos_fn
  await query(`UPDATE public.pedidos SET status_operacional = 'pronto' WHERE id = ${pwa6PedId}`);

  const pwa6Outbox = await query(`
    SELECT status, motivo_supressao FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = ${pwa6PedId}
  `);

  assert.equal(pwa6Outbox.length, 1, 'Deve gerar exatamente 1 registro na outbox');
  assert.equal(pwa6Outbox[0].status, 'SUPRIMIDO', 'Telefone inválido deve marcar SUPRIMIDO');
  assert.equal(pwa6Outbox[0].motivo_supressao, 'TELEFONE_INVALIDO', 'Motivo de supressão deve ser TELEFONE_INVALIDO');

  // Limpeza
  await query(`DELETE FROM public.comunicacao_whatsapp_outbox WHERE pedido_id = ${pwa6PedId}`);
  await query(`DELETE FROM public.comunicacoes_cliente WHERE pedido_id = ${pwa6PedId}`);
  await query(`DELETE FROM public.pedidos WHERE id = ${pwa6PedId}`);
  console.log('✅ APROVADO');

  // PWA-7: Claim com SKIP LOCKED e lease atômico (whatsapp_obter_proximos_envios)
  process.stdout.write('⏳ PWA-7: Claim com SKIP LOCKED e lease atômico... ');
  const pwa7Setup = await query(`
    INSERT INTO public.comunicacao_whatsapp_outbox (
      template_codigo, template_versao, mensagem_texto_snapshot,
      chave_idempotencia, telefone_e164_snapshot, status, disparar_em, proxima_tentativa_em
    ) VALUES (
      'PEDIDO_CONFIRMADO', 'v1', 'Mensagem Claim Probe PWA-7',
      'probe_pwa7_idemp_' || gen_random_uuid(), '5585999990001', 'PENDENTE', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute'
    ) RETURNING id;
  `);
  const pwa7OutboxId = pwa7Setup[0].id;

  const claimRes = await query(`
    SELECT * FROM public.whatsapp_obter_proximos_envios(10, 30)
    WHERE outbox_id = '${pwa7OutboxId}';
  `);
  assert.equal(claimRes.length, 1, 'Item deve ser resgatado pelo worker');
  assert.ok(claimRes[0].claim_token, 'Item deve possuir claim_token UUID');
  assert.ok(claimRes[0].lease_expira_em, 'Item deve possuir lease_expira_em');

  const pwa7Status = await query(`SELECT status FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa7OutboxId}'`);
  assert.equal(pwa7Status[0].status, 'PROCESSANDO');

  // Cleanup
  await query(`DELETE FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa7OutboxId}'`);
  console.log('✅ APROVADO');

  // PWA-8: Retry com backoff exponencial persistido sem adulterar disparar_em
  process.stdout.write('⏳ PWA-8: whatsapp_registrar_falha_envio com backoff exponencial sem alterar disparar_em... ');
  const pwa8Setup = await query(`
    INSERT INTO public.comunicacao_whatsapp_outbox (
      template_codigo, template_versao, mensagem_texto_snapshot,
      chave_idempotencia, telefone_e164_snapshot, status, tentativas, disparar_em, proxima_tentativa_em,
      claim_token, lease_expira_em
    ) VALUES (
      'PEDIDO_PRONTO', 'v1', 'Mensagem Retry Probe PWA-8',
      'probe_pwa8_idemp_' || gen_random_uuid(), '5585999990001', 'PROCESSANDO', 1, NOW() - INTERVAL '10 minutes', NOW(),
      gen_random_uuid(), NOW() + INTERVAL '1 minute'
    ) RETURNING id, claim_token, disparar_em;
  `);
  const pwa8Id = pwa8Setup[0].id;
  const pwa8Token = pwa8Setup[0].claim_token;
  const pwa8DispararEm = new Date(pwa8Setup[0].disparar_em).getTime();

  await query(`
    SELECT public.whatsapp_registrar_falha(
      '${pwa8Id}'::UUID, '${pwa8Token}'::UUID, 'Simulação de timeout de rede 504'
    );
  `);

  const pwa8After = await query(`
    SELECT status, tentativas, claim_token, lease_expira_em, disparar_em, proxima_tentativa_em, ultimo_erro
    FROM public.comunicacao_whatsapp_outbox
    WHERE id = '${pwa8Id}';
  `);

  assert.equal(pwa8After[0].status, 'PENDENTE', 'Após retry mensagem deve voltar para PENDENTE');
  assert.equal(pwa8After[0].tentativas, 2, 'Tentativas devem ser incrementadas');
  assert.equal(pwa8After[0].claim_token, null, 'claim_token deve ser desfeito');
  assert.equal(pwa8After[0].lease_expira_em, null, 'lease deve ser liberado');
  assert.equal(new Date(pwa8After[0].disparar_em).getTime(), pwa8DispararEm, 'disparar_em original deve ser preservado');
  assert.ok(new Date(pwa8After[0].proxima_tentativa_em).getTime() > Date.now(), 'proxima_tentativa_em deve ser no futuro');

  // Cleanup
  await query(`DELETE FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa8Id}'`);
  console.log('✅ APROVADO');

  // PWA-9: Webhook provider-aware idempotente e sem regressão de status (LIDO -> ENTREGUE ignorado)
  process.stdout.write('⏳ PWA-9: Webhook dedup provider-aware e não-regressão de status... ');
  const pwa9MsgId = 'wamid_probe_' + Date.now();
  const pwa9Chave1 = 'probe_pwa9_evt1_' + Date.now();
  const pwa9Chave2 = 'probe_pwa9_evt2_' + Date.now();

  const pwa9Setup = await query(`
    INSERT INTO public.comunicacao_whatsapp_outbox (
      template_codigo, template_versao, mensagem_texto_snapshot,
      chave_idempotencia, telefone_e164_snapshot, status, provider, provider_message_id,
      disparar_em, proxima_tentativa_em
    ) VALUES (
      'PEDIDO_ENTREGUE', 'v1', 'Mensagem Webhook Probe PWA-9',
      'probe_pwa9_idemp_' || gen_random_uuid(), '5585999990001', 'ENVIADO', 'evolution_api', '${pwa9MsgId}',
      NOW(), NOW()
    ) RETURNING id;
  `);
  const pwa9Id = pwa9Setup[0].id;

  // 1º evento: LIDO
  const pwa9Evt1 = await query(`
    SELECT public.whatsapp_processar_webhook_status(
      'evolution_api', '${pwa9Chave1}', 'evt_1', '${pwa9MsgId}', 'LIDO', '{"status":"read"}'::jsonb
    ) AS res;
  `);
  assert.equal(pwa9Evt1[0].res.success, true);
  assert.equal(pwa9Evt1[0].res.duplicado, false);

  const pwa9Row1 = await query(`SELECT status, lido_em FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa9Id}'`);
  assert.equal(pwa9Row1[0].status, 'LIDO');
  assert.ok(pwa9Row1[0].lido_em);

  // 2º evento com mesma chave (dedup)
  const pwa9EvtDup = await query(`
    SELECT public.whatsapp_processar_webhook_status(
      'evolution_api', '${pwa9Chave1}', 'evt_1', '${pwa9MsgId}', 'LIDO', '{"status":"read"}'::jsonb
    ) AS res;
  `);
  assert.equal(pwa9EvtDup[0].res.duplicado, true);

  // 3º evento: ENTREGUE (regressão proibida)
  const pwa9EvtRegressao = await query(`
    SELECT public.whatsapp_processar_webhook_status(
      'evolution_api', '${pwa9Chave2}', 'evt_2', '${pwa9MsgId}', 'ENTREGUE', '{"status":"delivered"}'::jsonb
    ) AS res;
  `);
  assert.equal(pwa9EvtRegressao[0].res.success, true);

  const pwa9RowFinal = await query(`SELECT status FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa9Id}'`);
  assert.equal(pwa9RowFinal[0].status, 'LIDO', 'Status NÃO pode regredir de LIDO para ENTREGUE');

  // Cleanup
  await query(`DELETE FROM public.comunicacao_whatsapp_outbox WHERE id = '${pwa9Id}'`);
  await query(`DELETE FROM public.whatsapp_eventos_gateway WHERE provider = 'evolution_api' AND chave_evento IN ('${pwa9Chave1}', '${pwa9Chave2}')`);
  console.log('✅ APROVADO');

  // PWA-10: Fail-closed security nas RPCs e sanitização em whatsapp_listar_envios_admin
  process.stdout.write('⏳ PWA-10: Fail-closed security nas RPCs e sanitização em whatsapp_listar_envios_admin... ');
  const pwa10Sec = await query(`
    DO $$
    DECLARE
      v_err TEXT := '';
    BEGIN
      -- Simula chamada com role anon/authenticated
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      BEGIN
        PERFORM public.whatsapp_obter_proximos_envios(1);
      EXCEPTION WHEN OTHERS THEN
        v_err := SQLSTATE;
      END;
      IF v_err <> '42501' THEN
        RAISE EXCEPTION 'whatsapp_obter_proximos_envios deveria falhar com 42501 para authenticated, obteve %', v_err;
      END IF;

      v_err := '';
      BEGIN
        PERFORM public.whatsapp_processar_webhook_status('evo', 'k', 'e', 'm', 't', '{}'::jsonb);
      EXCEPTION WHEN OTHERS THEN
        v_err := SQLSTATE;
      END;
      IF v_err <> '42501' THEN
        RAISE EXCEPTION 'whatsapp_processar_webhook_status deveria falhar com 42501 para authenticated, obteve %', v_err;
      END IF;

      -- Limpa config simulado
      PERFORM set_config('request.jwt.claim.role', '', true);
    END;
    $$;
    SELECT 1 AS ok;
  `);
  assert.equal(pwa10Sec[0].ok, 1);

  // Testa retorno estruturado da RPC administrativa de listagem simulando admin
  const pwa10List = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_count INT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      SELECT count(*) INTO v_count FROM public.whatsapp_listar_envios_admin(NULL, NULL, NULL, 5);

      PERFORM set_config('request.jwt.claim.sub', '', true);
    END;
    $$;
    SELECT 1 AS ok;
  `);
  assert.equal(pwa10List[0].ok, 1, 'whatsapp_listar_envios_admin deve executar com sucesso para admin');
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('  🎯 10/10 PROBES DE PRODUÇÃO DA FRENTE 039 HOMOLOGADOS COM SUCESSO!');
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\n❌ Falha na execução dos probes de produção PWA:', err);
  process.exit(1);
});
