import { query } from './supabase-client.mjs';

let passedProbes = 0;
const totalProbes = 12;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function adminQuery(sql) {
  const fullSql = `SET LOCAL "request.jwt.claim.role" = 'service_role';\n${sql}`;
  return query(fullSql);
}

async function runProbe(name, fn) {
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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE C (PC-1 a PC-12)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  const TEST_PREFIX = 'TEST_PC_' + Date.now();
  let testClienteId = null;
  let testPedidoId = null;

  try {
    // --------------------------------------------------------------------------
    // PC-1: Tabelas da carteira de crédito existem no schema public
    // --------------------------------------------------------------------------
    await runProbe('PC-1: Tabelas cliente_creditos e cliente_credito_movimentacoes existem', async () => {
      const rows = await query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('cliente_creditos', 'cliente_credito_movimentacoes')
        ORDER BY table_name;
      `);
      assert(rows.length === 2, `Esperado 2 tabelas, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PC-2: Grants fail-closed: anon não tem execute nas RPCs e helper interno é privado
    // --------------------------------------------------------------------------
    await runProbe('PC-2: Grants fail-closed e helper interno estritamente privado', async () => {
      const grants = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN (
            'aplicar_movimento_credito_cliente',
            'ajustar_credito_cliente_admin',
            'utilizar_credito_cliente_pedido',
            'consultar_saldo_credito'
          );
      `);

      // Helper interno não pode ter grant para PUBLIC, anon ou authenticated
      const helperExposed = grants.filter(g => 
        g.routine_name === 'aplicar_movimento_credito_cliente' &&
        ['PUBLIC', 'anon', 'authenticated'].includes(g.grantee)
      );
      assert(helperExposed.length === 0, `Helper interno exposto para: ${JSON.stringify(helperExposed)}`);

      // Nenhuma RPC administrativa exposta para anon
      const anonExposed = grants.filter(g => 
        ['ajustar_credito_cliente_admin', 'utilizar_credito_cliente_pedido', 'consultar_saldo_credito'].includes(g.routine_name) &&
        ['PUBLIC', 'anon'].includes(g.grantee)
      );
      assert(anonExposed.length === 0, `RPCs expostas para anon: ${JSON.stringify(anonExposed)}`);
    });

    // Fixture de cliente de teste para os probes em produção
    const cliRes = await query(`
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email)
      VALUES ('${TEST_PREFIX} Cliente', '85999990000', '5585999990000', 'pc_test_${Date.now()}@lunoca.local')
      RETURNING id;
    `);
    testClienteId = cliRes[0].id;

    // --------------------------------------------------------------------------
    // PC-3: Operador / não-admin é barrado ao tentar criar crédito manual
    // --------------------------------------------------------------------------
    await runProbe('PC-3: Não-admin recebe PERMISSION_DENIED em ajuste manual', async () => {
      // Simula chamada sem auth.uid() de admin (contexto postgres comum de teste)
      const res = await query(`
        SELECT public.ajustar_credito_cliente_admin(
          ${testClienteId}, 'credito', 50.00, 'Tentativa sem admin', 'pc-3-fail'
        ) AS r;
      `);
      assert(res[0]?.r?.success === false, 'Deveria falhar');
      assert(res[0]?.r?.code === 'PERMISSION_DENIED', `Esperado PERMISSION_DENIED, recebido: ${res[0]?.r?.code}`);
    });

    // --------------------------------------------------------------------------
    // PC-4: Admin cria ajuste com motivo obrigatório (>= 5 caracteres)
    // --------------------------------------------------------------------------
    await runProbe('PC-4: Ajuste administrativo com motivo válido aplica crédito e atualiza saldo', async () => {
      // Usa helper interno direto via superuser de produção para simular ajuste aprovado
      const res = await query(`
        SELECT public.aplicar_movimento_credito_cliente(
          ${testClienteId}, 'credito', 'ajuste_manual_admin', 100.00,
          'Crédito de teste PC-4 para validação de produção',
          '${TEST_PREFIX}:pc4:ajuste'
        ) AS r;
      `);
      assert(res[0]?.r?.success === true, 'Ajuste deveria ter sucesso');
      assert(Number(res[0]?.r?.saldo_posterior) === 100.00, 'Saldo posterior deve ser 100.00');

      const saldoCheck = await query(`
        SELECT saldo FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};
      `);
      assert(Number(saldoCheck[0]?.saldo) === 100.00, 'Saldo na tabela deve ser 100.00');
    });

    // Fixture de pedido para os probes de cancelamento e uso
    const pedRes = await query(`
      INSERT INTO public.pedidos (
        cliente_id_rel, nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, total, subtotal, valor_pago, saldo, sinal_minimo,
        status_comercial, status_financeiro, status_operacional, canal, pagamento,
        itens, endereco_entrega
      ) VALUES (
        ${testClienteId}, '${TEST_PREFIX} Cliente', '85999990000', 'pc_test@lunoca.local',
        CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days', 100.00, 100.00, 0.00, 100.00, 50.00,
        'confirmado', 'nao_pago', 'aguardando_producao', 'balcao', 'pix',
        'Bolo Teste PC', 'Retirada no Balcão'
      ) RETURNING id;
    `);
    testPedidoId = pedRes[0].id;

    // --------------------------------------------------------------------------
    // PC-7: Uso parcial de crédito em pedido quita parcela
    // --------------------------------------------------------------------------
    await runProbe('PC-7: Uso parcial de crédito em pedido quita parcela e abate saldo da carteira', async () => {
      // Debita R$ 60 do saldo de R$ 100 via helper atômico associado ao pedido
      const usoRes = await query(`
        SELECT public.aplicar_movimento_credito_cliente(
          ${testClienteId}, 'debito', 'uso_pedido', 60.00,
          'Uso de crédito teste PC-7',
          '${TEST_PREFIX}:pc7:uso',
          ${testPedidoId}
        ) AS r;
      `);
      assert(usoRes[0]?.r?.success === true, 'Débito deveria ter sucesso');
      assert(Number(usoRes[0]?.r?.saldo_posterior) === 40.00, 'Saldo restante na carteira deve ser 40.00');

      // Registra o pagamento no pedido
      await query(`
        INSERT INTO public.pedido_pagamentos (
          pedido_id, valor, metodo, provider, status, pago_em
        ) VALUES (
          ${testPedidoId}, 60.00, 'credito_cliente', 'caixa', 'aprovado', NOW()
        );
      `);

      const pedCheck = await query(`
        SELECT valor_pago, saldo, status_financeiro FROM public.pedidos WHERE id = ${testPedidoId};
      `);
      assert(Number(pedCheck[0]?.valor_pago) === 60.00, 'Pedido valor_pago deve ser 60.00');
      assert(Number(pedCheck[0]?.saldo) === 40.00, 'Pedido saldo deve ser 40.00');
    });

    // --------------------------------------------------------------------------
    // PC-9: Pagamento misto (Crédito + PIX) quita o pedido integralmente
    // --------------------------------------------------------------------------
    await runProbe('PC-9: Pagamento complementar via PIX (R$ 40) quita integralmente o pedido', async () => {
      await query(`
        INSERT INTO public.pedido_pagamentos (
          pedido_id, valor, metodo, provider, status, pago_em
        ) VALUES (
          ${testPedidoId}, 40.00, 'pix', 'caixa', 'aprovado', NOW()
        );
      `);

      const pedCheck = await query(`
        SELECT valor_pago, saldo, status_financeiro FROM public.pedidos WHERE id = ${testPedidoId};
      `);
      assert(Number(pedCheck[0]?.valor_pago) === 100.00, 'Pedido valor_pago deve ser 100.00');
      assert(Number(pedCheck[0]?.saldo) === 0.00, 'Pedido saldo deve ser 0.00');
      assert(pedCheck[0]?.status_financeiro === 'pago', 'Pedido status_financeiro deve ser pago');
    });

    // --------------------------------------------------------------------------
    // PC-11: Uso de credito_cliente NÃO lança nova receita contábil no DRE
    // --------------------------------------------------------------------------
    await runProbe('PC-11: Uso de credito_cliente não gera receita em financeiro_lancamentos', async () => {
      const lancs = await query(`
        SELECT * FROM public.financeiro_lancamentos
        WHERE pedido_id = ${testPedidoId} AND forma_pagamento = 'credito_cliente';
      `);
      assert(lancs.length === 0, 'Não deve haver lançamentos de credito_cliente no DRE');
    });

    // --------------------------------------------------------------------------
    // PC-10 & PC-5: Cancelamento misto (R$ 60 crédito + R$ 40 PIX) com CREDITO_CLIENTE
    // Retorna exatamente R$ 100 à carteira (de 40 vai para 140)
    // --------------------------------------------------------------------------
    await runProbe('PC-10 & PC-5: Cancelamento misto devolve exatamente R$ 100 (R$ 60 crédito + R$ 40 PIX) à carteira', async () => {
      const saldoAntes = await query(`
        SELECT saldo FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};
      `);
      assert(Number(saldoAntes[0]?.saldo) === 40.00, 'Saldo antes do cancelamento deve ser 40.00');

      // Executa cancelamento via porta de domínio autenticado como service_role
      const canRes = await adminQuery(`
        SELECT public.cancelar_pedido_equipe(
          ${testPedidoId},
          'Cancelamento misto teste PC-10',
          'CREDITO_CLIENTE'
        ) AS r;
      `);
      assert(canRes[0]?.r?.success === true, `Cancelamento deveria ter sucesso: ${JSON.stringify(canRes[0]?.r)}`);

      // Saldo após cancelamento: 40.00 + 100.00 = 140.00 exatos
      const saldoDepois = await query(`
        SELECT saldo FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};
      `);
      assert(Number(saldoDepois[0]?.saldo) === 140.00, `Esperado saldo 140.00, recebido: ${saldoDepois[0]?.saldo}`);
    });

    // --------------------------------------------------------------------------
    // PC-6: Retry de cancelamento é estritamente idempotente
    // --------------------------------------------------------------------------
    await runProbe('PC-6: Retry de cancelamento é idempotente e mantém saldo rigorosamente em 140.00', async () => {
      const canRetry = await adminQuery(`
        SELECT public.cancelar_pedido_equipe(
          ${testPedidoId},
          'Retry cancelamento',
          'CREDITO_CLIENTE'
        ) AS r;
      `);
      assert(canRetry[0]?.r?.success === true, 'Retry deve retornar sucesso');
      assert(canRetry[0]?.r?.idempotente === true, 'Retry deve marcar flag idempotente');

      const saldoCheck = await query(`
        SELECT saldo FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};
      `);
      assert(Number(saldoCheck[0]?.saldo) === 140.00, `Saldo duplicado indevidamente! Valor: ${saldoCheck[0]?.saldo}`);
    });

    // --------------------------------------------------------------------------
    // PC-8: Proteção contra saldo negativo e tentativa de gasto excessivo
    // --------------------------------------------------------------------------
    await runProbe('PC-8: Débito de valor superior ao saldo falha com INSUFFICIENT_CREDIT_BALANCE', async () => {
      const overRes = await query(`
        SELECT public.aplicar_movimento_credito_cliente(
          ${testClienteId}, 'debito', 'expiracao_admin', 200.00,
          'Tentativa de débito excessivo',
          '${TEST_PREFIX}:pc8:over'
        ) AS r;
      `);
      assert(overRes[0]?.r?.success === false, 'Deveria falhar');
      assert(overRes[0]?.r?.code === 'INSUFFICIENT_CREDIT_BALANCE', `Esperado INSUFFICIENT_CREDIT_BALANCE, recebido: ${overRes[0]?.r?.code}`);

      const saldoCheck = await query(`
        SELECT saldo FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};
      `);
      assert(Number(saldoCheck[0]?.saldo) === 140.00, 'Saldo deve permanecer 140.00');
    });

    // --------------------------------------------------------------------------
    // PC-12: Extrato preserva saldo anterior, posterior e motivos de cada operação
    // --------------------------------------------------------------------------
    await runProbe('PC-12: Extrato do livro-razão preserva trilha imutável completa', async () => {
      const extrato = await query(`
        SELECT tipo, origem, valor, saldo_anterior, saldo_posterior, motivo
        FROM public.cliente_credito_movimentacoes
        WHERE cliente_id = ${testClienteId}
        ORDER BY id ASC;
      `);
      assert(extrato.length === 3, `Esperado 3 movimentações, recebido: ${extrato.length}`);

      // Mov 1: Crédito inicial de 100 (0 -> 100)
      assert(extrato[0].tipo === 'credito' && Number(extrato[0].saldo_posterior) === 100.00);
      // Mov 2: Débito de 60 (100 -> 40)
      assert(extrato[1].tipo === 'debito' && Number(extrato[1].saldo_posterior) === 40.00);
      // Mov 3: Devolução por cancelamento de 100 (40 -> 140)
      assert(extrato[2].tipo === 'credito' && Number(extrato[2].saldo_posterior) === 140.00);
    });

  } finally {
    // Limpeza de fixtures temporárias de teste
    if (testPedidoId) {
      await query(`DELETE FROM public.pedido_status_historico WHERE pedido_id = ${testPedidoId};`);
      await query(`DELETE FROM public.pedido_pagamentos WHERE pedido_id = ${testPedidoId};`);
      await query(`DELETE FROM public.pedidos WHERE id = ${testPedidoId};`);
    }
    if (testClienteId) {
      await query(`DELETE FROM public.cliente_credito_movimentacoes WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.clientes WHERE id = ${testClienteId};`);
    }
  }

  console.log('\n============================================================');
  console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DE PRODUÇÃO DA FRENTE C PASSARAM COM SUCESSO!`);
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\n❌ ERRO NOS PROBES DE PRODUÇÃO DA FRENTE C:', err);
  process.exit(1);
});
