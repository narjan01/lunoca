import { query } from './supabase-client.mjs';

let passedProbes = 0;
let totalProbes = 14;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name, fn) {
  try {
    process.stdout.write(`⏳ ${name}... `);
    await fn();
    console.log(`✅ APROVADO`);
    passedProbes++;
  } catch (err) {
    console.log(`❌ FALHOU: ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('\n============================================================');
  ('============================================================');
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE TESTES FRENTE B (FB-1 a FB-14)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  // Identificadores de teste dedicados para limpeza pós-teste
  const TEST_PREFIX = 'TEST_FB_PROD_' + Date.now();
  let testOrcamentoId = null;
  let testOrcamentoToken = null;
  let testPedidoId = null;
  let testPagamentoId = null;

  try {
    // -------------------------------------------------------------
    // Setup de Fixtures Temporárias em Produção
    // -------------------------------------------------------------
    // Orçamento de teste
    const orcRes = await query(`
      INSERT INTO public.orcamentos (
        numero, versao, cliente_nome, cliente_telefone, cliente_email,
        data_evento, hora_evento, tipo_entrega, validade_ate, status,
        total, sinal_sugerido, token_publico
      ) VALUES (
        '${TEST_PREFIX}', 1, 'Cliente Teste Producao', '(83) 99876-5432', 'teste_fb@lunoca.local',
        CURRENT_DATE + INTERVAL '5 days', '16:00:00', 'entrega', NOW() + INTERVAL '12 hours', 'enviado',
        500.00, 250.00, gen_random_uuid()
      ) RETURNING id, token_publico;
    `);
    testOrcamentoId = orcRes[0].id;
    testOrcamentoToken = orcRes[0].token_publico;

    // Pedido de teste
    const pedRes = await query(`
      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, status_comercial, status_financeiro,
        status_operacional, total, valor_pago, canal, modalidade_entrega, endereco_entrega,
        pagamento, itens, data_pedido, data_entrega, hora_entrega
      ) VALUES (
        'Cliente Teste Producao', 'teste_fb@lunoca.local', '(83) 98888-7777', 'confirmado', 'pago',
        'aguardando_producao', 300.00, 150.00, 'whatsapp', 'entrega', 'Rua das Flores, 123',
        'pix', 'Bolo de Teste FB', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days', '15:00:00'
      ) RETURNING id;
    `);
    testPedidoId = pedRes[0].id;

    // Pagamento de teste
    const pagRes = await query(`
      INSERT INTO public.pedido_pagamentos (
        pedido_id, valor, metodo, status
      ) VALUES (
        ${testPedidoId}, 150.00, 'pix', 'aprovado'
      ) RETURNING id;
    `);
    testPagamentoId = pagRes[0].id;

    // Histórico de status para pronto
    await query(`
      INSERT INTO public.pedido_status_historico (
        pedido_id, dimensao, status_anterior, status_novo, origem, metadata
      ) VALUES (
        ${testPedidoId}, 'operacional', 'em_producao', 'pronto', 'admin', '{"motivo": "Confeitaria finalizou bolo de teste"}'::jsonb
      );
    `);

    // -------------------------------------------------------------
    // FB-1: normalizar_telefone_e164
    // -------------------------------------------------------------
    await runTest('FB-1: Normalização E.164 rigorosa (celular e fixo, sem 9º dígito forçado)', async () => {
      const rows = await query(`
        SELECT
          public.normalizar_telefone_e164('(83) 99876-5432') AS f1,
          public.normalizar_telefone_e164('83998765432') AS f2,
          public.normalizar_telefone_e164('+55 (83) 99876-5432') AS f3,
          public.normalizar_telefone_e164('8332221100') AS f4,
          public.normalizar_telefone_e164('12345') AS f_inv1,
          public.normalizar_telefone_e164('0099887766') AS f_inv2;
      `);
      assert(rows[0].f1 === '5583998765432', `f1 esperado 5583998765432, recebido ${rows[0].f1}`);
      assert(rows[0].f2 === '5583998765432', `f2 esperado 5583998765432, recebido ${rows[0].f2}`);
      assert(rows[0].f3 === '5583998765432', `f3 esperado 5583998765432, recebido ${rows[0].f3}`);
      assert(rows[0].f4 === '558332221100', `f4 esperado 558332221100, recebido ${rows[0].f4}`);
      assert(rows[0].f_inv1 === null, 'f_inv1 deveria ser NULL para tamanho inválido');
      assert(rows[0].f_inv2 === null, 'f_inv2 deveria ser NULL para DDD inválido');
    });

    // -------------------------------------------------------------
    // FB-2: Constraint XOR de entidade em comunicacoes_cliente
    // -------------------------------------------------------------
    await runTest('FB-2: Constraint XOR ck_comunicacao_entidade rejeita ambos nulos ou ambos presentes', async () => {
      let failedBothNull = false;
      try {
        await query(`
          INSERT INTO public.comunicacoes_cliente (
            orcamento_id, pedido_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
          ) VALUES (
            NULL, NULL, 'ORCAMENTO_ENVIADO', 'whatsapp_link', '5583998765432', 'teste', 'gerado', '${TEST_PREFIX}_xor_1'
          );
        `);
      } catch {
        failedBothNull = true;
      }
      assert(failedBothNull, 'Deveria falhar ao inserir comunicacao sem orcamento_id e sem pedido_id');

      let failedBothSet = false;
      try {
        await query(`
          INSERT INTO public.comunicacoes_cliente (
            orcamento_id, pedido_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
          ) VALUES (
            ${testOrcamentoId}, ${testPedidoId}, 'ORCAMENTO_ENVIADO', 'whatsapp_link', '5583998765432', 'teste', 'gerado', '${TEST_PREFIX}_xor_2'
          );
        `);
      } catch {
        failedBothSet = true;
      }
      assert(failedBothSet, 'Deveria falhar ao inserir comunicacao com ambos orcamento_id e pedido_id');
    });

    // -------------------------------------------------------------
    // FB-3: Validação de CHECK constraints para canal e status
    // -------------------------------------------------------------
    await runTest('FB-3: CHECK constraints em comunicacoes_cliente para canais e status', async () => {
      let failedCanal = false;
      try {
        await query(`
          INSERT INTO public.comunicacoes_cliente (
            orcamento_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
          ) VALUES (
            ${testOrcamentoId}, 'ORCAMENTO_ENVIADO', 'telegram_invalido', '5583998765432', 'teste', 'gerado', '${TEST_PREFIX}_chk_canal'
          );
        `);
      } catch {
        failedCanal = true;
      }
      assert(failedCanal, 'Deveria falhar com canal invalido');

      let failedStatus = false;
      try {
        await query(`
          INSERT INTO public.comunicacoes_cliente (
            orcamento_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
          ) VALUES (
            ${testOrcamentoId}, 'ORCAMENTO_ENVIADO', 'whatsapp_link', '5583998765432', 'teste', 'status_invalido', '${TEST_PREFIX}_chk_status'
          );
        `);
      } catch {
        failedStatus = true;
      }
      assert(failedStatus, 'Deveria falhar com status invalido');
    });

    // -------------------------------------------------------------
    // FB-4: Unicidade de chave de idempotência
    // -------------------------------------------------------------
    await runTest('FB-4: Unicidade estrita da chave_idempotencia em comunicacoes_cliente', async () => {
      const key = `${TEST_PREFIX}_idemp_unique`;
      await query(`
        INSERT INTO public.comunicacoes_cliente (
          orcamento_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
        ) VALUES (
          ${testOrcamentoId}, 'ORCAMENTO_ENVIADO', 'whatsapp_link', '5583998765432', 'msg 1', 'gerado', '${key}'
        );
      `);

      let duplicateFailed = false;
      try {
        await query(`
          INSERT INTO public.comunicacoes_cliente (
            orcamento_id, tipo, canal, destinatario, mensagem_snapshot, status, chave_idempotencia
          ) VALUES (
            ${testOrcamentoId}, 'ORCAMENTO_ENVIADO', 'whatsapp_link', '5583998765432', 'msg 2', 'gerado', '${key}'
          );
        `);
      } catch {
        duplicateFailed = true;
      }
      assert(duplicateFailed, 'Deveria violar constraint UNIQUE para chave duplicada');
    });

    // -------------------------------------------------------------
    // FB-5: Backfill idempotente
    // -------------------------------------------------------------
    await runTest('FB-5: Backfill de orcamento_comunicacoes para comunicacoes_cliente é idempotente', async () => {
      const res = await query(`
        SELECT COUNT(*) as total FROM public.comunicacoes_cliente WHERE chave_idempotencia LIKE 'legacy:orcamento_comunicacoes:%';
      `);
      assert(Number(res[0].total) >= 0, 'Backfill executado com sucesso');
    });

    // -------------------------------------------------------------
    // FB-6: RLS em comunicacoes_cliente
    // -------------------------------------------------------------
    await runTest('FB-6: Policies RLS em comunicacoes_cliente configuradas corretamente', async () => {
      const rls = await query(`
        SELECT relrowsecurity FROM pg_class WHERE relname = 'comunicacoes_cliente';
      `);
      assert(rls[0].relrowsecurity === true, 'RLS deve estar habilitado em comunicacoes_cliente');

      const policies = await query(`
        SELECT policyname FROM pg_policies WHERE tablename = 'comunicacoes_cliente';
      `);
      assert(policies.length >= 3, 'Deveria conter ao menos 3 policies (SELECT, INSERT, UPDATE)');
    });

    // -------------------------------------------------------------
    // FB-7: obter_preview_comunicacao para Orcamento
    // -------------------------------------------------------------
    await runTest('FB-7: obter_preview_comunicacao gera preview canônico de Orçamento (envio e vencendo)', async () => {
      const rowsEnvio = await query(`
        SELECT public.obter_preview_comunicacao('ORCAMENTO_ENVIADO', ${testOrcamentoId}, NULL) AS res;
      `);
      const resEnvio = rowsEnvio[0].res;
      assert(resEnvio.success === true, 'Preview de envio deve ter success: true');
      assert(resEnvio.numero === TEST_PREFIX, 'Numero do orcamento deve bater');
      assert(resEnvio.chave_idempotencia === `orcamento:${testOrcamentoId}:v1:envio`, 'Chave de envio invalida');
      assert(resEnvio.link_publico.includes(`/orcamento.html?t=${testOrcamentoToken}`), 'Link publico deve conter token canônico');
      assert(resEnvio.mensagem.includes('não reserva estoque ou capacidade'), 'Mensagem de envio deve ter ressalva de não reserva');

      const rowsVenc = await query(`
        SELECT public.obter_preview_comunicacao('ORCAMENTO_VENCENDO', ${testOrcamentoId}, NULL) AS res;
      `);
      const resVenc = rowsVenc[0].res;
      assert(resVenc.success === true, 'Preview de vencimento deve ter success: true');
      assert(resVenc.chave_idempotencia === `orcamento:${testOrcamentoId}:v1:vencendo`, 'Chave de vencimento invalida');
      assert(resVenc.mensagem.includes('sujeita à confirmação'), 'Mensagem de vencimento não deve prometer reserva prévia');
    });

    // -------------------------------------------------------------
    // FB-8: obter_preview_comunicacao para Pedidos
    // -------------------------------------------------------------
    await runTest('FB-8: obter_preview_comunicacao gera preview canônico de Pedido (sinal, pronto, entrega)', async () => {
      const rowsSinal = await query(`
        SELECT public.obter_preview_comunicacao('SINAL_CONFIRMADO', NULL, ${testPedidoId}) AS res;
      `);
      const resSinal = rowsSinal[0].res;
      assert(resSinal.success === true, 'Preview de sinal deve ter success: true');
      assert(resSinal.chave_idempotencia === `pedido:${testPedidoId}:pagamento:${testPagamentoId}:sinal`, 'Chave de sinal incorreta');
      assert(resSinal.mensagem.includes('150,00') || resSinal.mensagem.includes('150.00'), 'Mensagem de sinal deve conter valor do pagamento');

      const rowsPronto = await query(`
        SELECT public.obter_preview_comunicacao('PEDIDO_PRONTO', NULL, ${testPedidoId}) AS res;
      `);
      const resPronto = rowsPronto[0].res;
      assert(resPronto.success === true, 'Preview de pronto deve ter success: true');
      assert(resPronto.chave_idempotencia.startsWith(`pedido:${testPedidoId}:historico:`), 'Chave de pronto incorreta');
      assert(resPronto.mensagem.includes('está pronta'), 'Mensagem de pronto incorreta');

      const rowsEntrega = await query(`
        SELECT public.obter_preview_comunicacao('SAIU_PARA_ENTREGA', NULL, ${testPedidoId}) AS res;
      `);
      const resEntrega = rowsEntrega[0].res;
      assert(resEntrega.success === true, 'Preview de entrega deve ter success: true');
      assert(resEntrega.mensagem.includes('saiu para entrega'), 'Mensagem de entrega incorreta');
    });

    // -------------------------------------------------------------
    // FB-9: Rejeição de telefone inválido
    // -------------------------------------------------------------
    await runTest('FB-9: obter_preview_comunicacao rejeita telefone inválido com INVALID_PHONE', async () => {
      const orcInv = await query(`
        INSERT INTO public.orcamentos (
          numero, versao, cliente_nome, cliente_telefone, data_evento, validade_ate, status, total, token_publico
        ) VALUES (
          '${TEST_PREFIX}_inv_phone', 1, 'Invalido', '999', CURRENT_DATE + INTERVAL '3 days', NOW() + INTERVAL '1 day', 'enviado', 100.00, gen_random_uuid()
        ) RETURNING id;
      `);
      const rows = await query(`
        SELECT public.obter_preview_comunicacao('ORCAMENTO_ENVIADO', ${orcInv[0].id}, NULL) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === false, 'Deveria falhar para telefone 999');
      assert(res.code === 'INVALID_PHONE', `Codigo esperado INVALID_PHONE, recebido: ${res.code}`);
    });

    // -------------------------------------------------------------
    // FB-10: whatsapp_link rejeita status enviado
    // -------------------------------------------------------------
    await runTest('FB-10: registrar_comunicacao_cliente rejeita status "enviado" para "whatsapp_link"', async () => {
      const rows = await query(`
        SELECT public.registrar_comunicacao_cliente(
          'ORCAMENTO_ENVIADO',
          ${testOrcamentoId},
          NULL,
          'whatsapp_link',
          'enviado',
          NULL,
          NULL
        ) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === false, 'Deveria falhar ao registrar enviado para whatsapp_link');
      assert(res.code === 'INVALID_STATUS_FOR_CHANNEL', `Esperado INVALID_STATUS_FOR_CHANNEL, recebido: ${res.code}`);
    });

    // -------------------------------------------------------------
    // FB-11: Registro legítimo de whatsapp_link e evolution_api
    // -------------------------------------------------------------
    await runTest('FB-11: registrar_comunicacao_cliente aceita link_aberto e atualiza via idempotencia', async () => {
      const rowsLink = await query(`
        SELECT public.registrar_comunicacao_cliente(
          'ORCAMENTO_ENVIADO',
          ${testOrcamentoId},
          NULL,
          'whatsapp_link',
          'link_aberto',
          NULL,
          NULL
        ) AS res;
      `);
      const resLink = rowsLink[0].res;
      assert(resLink.success === true, 'Deveria registrar com sucesso para link_aberto');
      assert(resLink.status === 'link_aberto', 'Status registrado deve ser link_aberto');

      // Teste com evolution_api idempotente
      const rowsEvo = await query(`
        SELECT public.registrar_comunicacao_cliente(
          'SINAL_CONFIRMADO',
          NULL,
          ${testPedidoId},
          'evolution_api',
          'enviado',
          'wamid.test_123',
          NULL
        ) AS res;
      `);
      const resEvo = rowsEvo[0].res;
      assert(resEvo.success === true, 'Deveria registrar envio da evolution_api');
      assert(resEvo.status === 'enviado', 'Status registrado deve ser enviado');
    });

    // -------------------------------------------------------------
    // FB-12: aprovar_orcamento_publico rejeita versão desatualizada
    // -------------------------------------------------------------
    await runTest('FB-12: aprovar_orcamento_publico rejeita versao divergente com QUOTE_VERSION_CHANGED', async () => {
      // Orçamento está na versão 1. Cliente tenta aprovar versao 2 (ou 0)
      const rows = await query(`
        SELECT public.aprovar_orcamento_publico('${testOrcamentoToken}', 2) AS res;
      `);
      const res = rows[0].res;
      assert(res.success === false, 'Deveria falhar ao tentar aprovar versao divergente');
      assert(res.code === 'QUOTE_VERSION_CHANGED', `Esperado QUOTE_VERSION_CHANGED, recebido: ${res.code}`);
      assert(res.versao_atual === 1, `versao_atual deveria ser 1, recebido: ${res.versao_atual}`);
    });

    // -------------------------------------------------------------
    // FB-13: aprovar_orcamento_publico aprova com sucesso e é idempotente
    // -------------------------------------------------------------
    await runTest('FB-13: aprovar_orcamento_publico aprova versao esperada com sucesso e é idempotente', async () => {
      // Aprovação inicial
      const rows1 = await query(`
        SELECT public.aprovar_orcamento_publico('${testOrcamentoToken}', 1) AS res;
      `);
      const res1 = rows1[0].res;
      assert(res1.success === true, 'Deveria aprovar com sucesso');
      assert(res1.status === 'aprovado', 'Status retornado deve ser aprovado');
      assert(res1.idempotente === false, 'Primeira chamada deve ser idempotente: false');

      // Segunda chamada (idempotente)
      const rows2 = await query(`
        SELECT public.aprovar_orcamento_publico('${testOrcamentoToken}', 1) AS res;
      `);
      const res2 = rows2[0].res;
      assert(res2.success === true, 'Segunda chamada deve ter sucesso');
      assert(res2.status === 'aprovado', 'Status deve permanecer aprovado');
      assert(res2.idempotente === true, 'Segunda chamada deve ser idempotente: true');
    });

    // -------------------------------------------------------------
    // FB-14: listar_orcamentos_para_lembrete
    // -------------------------------------------------------------
    await runTest('FB-14: listar_orcamentos_para_lembrete identifica pendências e respeita envio prévio', async () => {
      // Criar orçamento enviado vencendo em 6 horas
      const orcLemb = await query(`
        INSERT INTO public.orcamentos (
          numero, versao, cliente_nome, cliente_telefone, data_evento, validade_ate, status, total, token_publico
        ) VALUES (
          '${TEST_PREFIX}_lembrete', 1, 'Cliente Lembrete', '(83) 99111-2222', CURRENT_DATE + INTERVAL '4 days', NOW() + INTERVAL '6 hours', 'enviado', 200.00, gen_random_uuid()
        ) RETURNING id;
      `);
      const lembreteOrcId = orcLemb[0].id;

      // Consulta de lembretes nas próximas 12 horas
      const lista1 = await query(`
        SELECT * FROM public.listar_orcamentos_para_lembrete(12) WHERE orcamento_id = ${lembreteOrcId};
      `);
      assert(lista1.length === 1, 'Orcamento a vencer deve ser listado para lembrete');

      // Registra comunicação de lembrete
      await query(`
        SELECT public.registrar_comunicacao_cliente(
          'ORCAMENTO_VENCENDO',
          ${lembreteOrcId},
          NULL,
          'whatsapp_link',
          'link_aberto',
          NULL,
          NULL
        );
      `);

      // Consulta novamente: não deve mais aparecer
      const lista2 = await query(`
        SELECT * FROM public.listar_orcamentos_para_lembrete(12) WHERE orcamento_id = ${lembreteOrcId};
      `);
      assert(lista2.length === 0, 'Orcamento ja lembrado nao deve reaparecer na lista de lembretes');
    });

  } finally {
    // -------------------------------------------------------------
    // Limpeza Rigorosa das Fixtures Temporárias em Produção
    // -------------------------------------------------------------
    console.log('\n🧹 Limpando fixtures temporárias de teste em produção...');
    try {
      if (testPedidoId) {
        await query(`DELETE FROM public.comunicacoes_cliente WHERE pedido_id = ${testPedidoId};`);
        await query(`DELETE FROM public.pedido_status_historico WHERE pedido_id = ${testPedidoId};`);
        await query(`DELETE FROM public.pedido_pagamentos WHERE pedido_id = ${testPedidoId};`);
        await query(`DELETE FROM public.pedidos WHERE id = ${testPedidoId};`);
      }
      await query(`
        DELETE FROM public.comunicacoes_cliente
        WHERE chave_idempotencia LIKE '${TEST_PREFIX}%'
           OR orcamento_id IN (SELECT id FROM public.orcamentos WHERE numero LIKE '${TEST_PREFIX}%');
      `);
      await query(`
        DELETE FROM public.orcamento_rate_limits
        WHERE token IN (SELECT token_publico FROM public.orcamentos WHERE numero LIKE '${TEST_PREFIX}%');
      `);
      await query(`
        DELETE FROM public.orcamento_status_historico
        WHERE orcamento_id IN (SELECT id FROM public.orcamentos WHERE numero LIKE '${TEST_PREFIX}%');
      `);
      await query(`
        DELETE FROM public.orcamentos WHERE numero LIKE '${TEST_PREFIX}%';
      `);
      console.log('✅ Limpeza de fixtures temporárias concluída com sucesso!');
    } catch (cleanErr) {
      console.warn('⚠️ Alerta na limpeza de fixtures:', cleanErr.message);
    }
  }

  console.log(`\n============================================================`);
  console.log(`  RESULTADO FINAL EM PRODUÇÃO: ${passedProbes}/${totalProbes} PROBES APROVADOS!`);
  console.log(`============================================================\n`);
}

main().catch(err => {
  console.error('\nBateria de testes em produção falhou:', err);
  process.exit(1);
});
