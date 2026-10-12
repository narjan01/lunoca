import { query } from './supabase-client.mjs';

let passedProbes = 0;
const totalProbes = 10;

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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE E (PE-1 a PE-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  const TEST_PREFIX = 'TEST_PE_' + Date.now();
  let testClienteId = null;
  let testPedidoId = null;
  let testObsId = null;

  try {
    // --------------------------------------------------------------------------
    // PE-1: Tabelas de operação de produção existem
    // --------------------------------------------------------------------------
    await runProbe('PE-1: Tabelas pedido_producao_observacoes e pedido_producao_config existem', async () => {
      const rows = await query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('pedido_producao_observacoes', 'pedido_producao_config')
        ORDER BY table_name;
      `);
      assert(rows.length === 2, `Esperado 2 tabelas, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PE-2: RLS habilitado nas tabelas da Frente E
    // --------------------------------------------------------------------------
    await runProbe('PE-2: RLS habilitado em pedido_producao_observacoes e pedido_producao_config', async () => {
      const rls = await query(`
        SELECT tablename, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('pedido_producao_observacoes', 'pedido_producao_config');
      `);
      assert(rls.length === 2, 'Ambas as tabelas devem estar registradas');
      assert(rls.every(r => r.rowsecurity === true), 'Todas as tabelas da Frente E devem ter RLS ativo');
    });

    // --------------------------------------------------------------------------
    // PE-3: Grants fail-closed: anon não tem execute nas RPCs de produção
    // --------------------------------------------------------------------------
    await runProbe('PE-3: RPCs de produção bloqueadas para anon (fail-closed)', async () => {
      const grants = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN (
            'obter_agenda_producao',
            'obter_detalhe_producao_pedido',
            'iniciar_producao_pedido',
            'marcar_pedido_pronto',
            'marcar_saida_entrega',
            'confirmar_entrega_retirada',
            'definir_prioridade_producao',
            'adicionar_observacao_producao'
          )
          AND grantee IN ('PUBLIC', 'anon');
      `);
      assert(grants.length === 0, `RPCs expostas para anon: ${JSON.stringify(grants)}`);
    });

    // Setup de Fixtures em produção (Cliente e Pedido de Encomenda)
    const cliRes = await query(`
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf)
      VALUES ('${TEST_PREFIX} Cliente Probe E', '85994445566', '5585994445566', 'pe_test_${Date.now()}@lunoca.local', '11122233344')
      RETURNING id;
    `);
    testClienteId = cliRes[0].id;

    const dataRef = '2026-10-28';
    const pedRes = await query(`
      INSERT INTO public.pedidos (
        cliente_id_rel, nome_cliente, email_cliente, telefone_cliente,
        data_pedido, data_entrega, hora_entrega, total, subtotal, valor_pago, saldo, sinal_minimo,
        status_comercial, status_financeiro, status_operacional, status,
        modalidade_entrega, endereco_entrega, pagamento, itens
      ) VALUES (
        ${testClienteId}, '${TEST_PREFIX} Cliente Probe E', 'pe_test@lunoca.local', '85994445566',
        CURRENT_DATE, '${dataRef}'::DATE, '15:30:00'::TIME, 180.00, 180.00, 180.00, 0.00, 90.00,
        'confirmado', 'pago', 'aguardando_producao', 'Confirmado',
        'retirada', 'Retirada na loja', 'pix', 'Bolo Cenográfico'
      ) RETURNING id;
    `);
    testPedidoId = pedRes[0].id;

    // --------------------------------------------------------------------------
    // PE-4: RPC obter_agenda_producao bloqueia chamada sem role autorizada
    // --------------------------------------------------------------------------
    await runProbe('PE-4: obter_agenda_producao falha fechada para chamadas não autorizadas', async () => {
      const semAuth = await query(`
        SELECT public.obter_agenda_producao('${dataRef}', '${dataRef}') AS r;
      `);
      assert(semAuth[0]?.r?.success === false, 'Deve recusar sem autorização');
      assert(semAuth[0]?.r?.code === 'PERMISSION_DENIED', 'Código deve ser PERMISSION_DENIED');
    });

    // --------------------------------------------------------------------------
    // PE-5: obter_agenda_producao projeta pedidos e sanitiza campos da cozinha
    // --------------------------------------------------------------------------
    await runProbe('PE-5: obter_agenda_producao projeta capacidade e sanitiza dados financeiros', async () => {
      const res = await adminQuery(`
        SELECT public.obter_agenda_producao('${dataRef}', '${dataRef}') AS r;
      `);
      assert(res[0]?.r?.success === true, 'Deve retornar sucesso com service_role');
      assert(Array.isArray(res[0]?.r?.capacidades), 'Deve conter projeção de capacidade diária');
      assert(res[0]?.r?.capacidades.length > 0, 'Deve conter registro para o dia pesquisado');

      const ped = res[0]?.r?.pedidos?.find(p => Number(p.id) === Number(testPedidoId));
      assert(ped, 'Pedido de teste deve ser encontrado na agenda');
      assert(ped.status_operacional === 'aguardando_producao', 'Status inicial deve ser aguardando_producao');
      assert(ped.cpf === undefined, 'CPF não pode estar presente na cozinha');
      assert(ped.total === undefined, 'Total monetário não deve constar no card');
      assert(ped.subtotal === undefined, 'Subtotal não deve constar no card');
    });

    // --------------------------------------------------------------------------
    // PE-6: iniciar_producao_pedido transita para em_producao e gera histórico
    // --------------------------------------------------------------------------
    await runProbe('PE-6: iniciar_producao_pedido transita status e grava histórico com origem admin', async () => {
      const res = await adminQuery(`
        SELECT public.iniciar_producao_pedido(${testPedidoId}) AS r;
      `);
      assert(res[0]?.r?.success === true, 'Transição deve suceder');
      assert(res[0]?.r?.status_operacional === 'em_producao', 'Novo status deve ser em_producao');

      const hist = await query(`
        SELECT status_anterior, status_novo, origem 
        FROM public.pedido_status_historico 
        WHERE pedido_id = ${testPedidoId} AND status_novo = 'em_producao';
      `);
      assert(hist.length > 0, 'Histórico de transição deve existir');
      assert(hist[0].origem === 'admin', 'Origem deve ser admin');
    });

    // --------------------------------------------------------------------------
    // PE-7: marcar_pedido_pronto transita para pronto
    // --------------------------------------------------------------------------
    await runProbe('PE-7: marcar_pedido_pronto transita operacional para pronto', async () => {
      const res = await adminQuery(`
        SELECT public.marcar_pedido_pronto(${testPedidoId}) AS r;
      `);
      assert(res[0]?.r?.success === true, 'Transição para pronto deve suceder');
      assert(res[0]?.r?.status_operacional === 'pronto', 'Status deve ser pronto');
    });

    // --------------------------------------------------------------------------
    // PE-8: marcar_saida_entrega rejeita modalidade retirada
    // --------------------------------------------------------------------------
    await runProbe('PE-8: marcar_saida_entrega rejeita modalidade retirada (segregação estrita)', async () => {
      const res = await adminQuery(`
        SELECT public.marcar_saida_entrega(${testPedidoId}) AS r;
      `);
      assert(res[0]?.r?.success === false, 'Deve rejeitar saída para entrega em modalidade retirada');
      assert(res[0]?.r?.code === 'INVALID_DELIVERY_MODALITY', 'Código deve ser INVALID_DELIVERY_MODALITY');
    });

    // --------------------------------------------------------------------------
    // PE-9: Observação de produção persiste e bloqueia DELETE físico
    // --------------------------------------------------------------------------
    await runProbe('PE-9: adicionar_observacao_producao persiste e bloqueia DELETE físico', async () => {
      const res = await adminQuery(`
        SELECT public.adicionar_observacao_producao(${testPedidoId}, 'Atenção aos detalhes decorativos', 'cozinha') AS r;
      `);
      assert(res[0]?.r?.success === true, 'Nota de produção deve ser criada');
      testObsId = res[0]?.r?.observacao_id;
      assert(testObsId, 'ID da observação deve existir');

      // Tenta DELETE físico direto
      let deleteFalhou = false;
      try {
        await query(`DELETE FROM public.pedido_producao_observacoes WHERE id = ${testObsId};`);
      } catch (err) {
        deleteFalhou = true;
      }
      assert(deleteFalhou, 'DELETE físico deve ser impedido pelo trigger');
    });

    // --------------------------------------------------------------------------
    // PE-10: confirmar_entrega_retirada conclui operacional de forma idempotente
    // --------------------------------------------------------------------------
    await runProbe('PE-10: confirmar_entrega_retirada conclui com sucesso e idempotência', async () => {
      const res1 = await adminQuery(`
        SELECT public.confirmar_entrega_retirada(${testPedidoId}) AS r;
      `);
      assert(res1[0]?.r?.success === true, 'Conclusão operacional deve suceder');
      assert(res1[0]?.r?.status_operacional === 'entregue', 'Status deve ser entregue');

      const res2 = await adminQuery(`
        SELECT public.confirmar_entrega_retirada(${testPedidoId}) AS r;
      `);
      assert(res2[0]?.r?.success === true, 'Segunda execução deve ser válida');
      assert(res2[0]?.r?.idempotente === true, 'Segunda chamada deve ser idempotente');
    });

  } finally {
    // Limpeza de fixtures
    if (testObsId) {
      // Soft-delete/desativação permitida
      await query(`UPDATE public.pedido_producao_observacoes SET ativo = false WHERE id = ${testObsId};`).catch(() => {});
    }
    if (testPedidoId) {
      await query(`DELETE FROM public.pedido_status_historico WHERE pedido_id = ${testPedidoId};`).catch(() => {});
      await query(`DELETE FROM public.pedido_producao_config WHERE pedido_id = ${testPedidoId};`).catch(() => {});
      // Observações filhas com cascade desativado precisam ser limpas sem violar trigger:
      await query(`DELETE FROM public.pedidos WHERE id = ${testPedidoId};`).catch(() => {});
    }
    if (testClienteId) {
      await query(`DELETE FROM public.clientes WHERE id = ${testClienteId};`).catch(() => {});
    }
  }

  console.log('\n============================================================');
  console.log(`  RESULTADO: ${passedProbes}/${totalProbes} probes aprovados em produção!`);
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\n❌ Erro fatal durante a execução dos probes:', err);
  process.exit(1);
});
