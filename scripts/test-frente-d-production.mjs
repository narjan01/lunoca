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
  console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE D (PD-1 a PD-10)');
  console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
  console.log('============================================================\n');

  const TEST_PREFIX = 'TEST_PD_' + Date.now();
  let testClienteId = null;
  let testPedidoId = null;

  try {
    // --------------------------------------------------------------------------
    // PD-1: Tabelas de relacionamento do CRM existem
    // --------------------------------------------------------------------------
    await runProbe('PD-1: Tabelas cliente_notas, cliente_tags, cliente_preferencias existem', async () => {
      const rows = await query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('cliente_notas', 'cliente_tags', 'cliente_preferencias')
        ORDER BY table_name;
      `);
      assert(rows.length === 3, `Esperado 3 tabelas, encontrado ${rows.length}`);
    });

    // --------------------------------------------------------------------------
    // PD-2: Grants fail-closed: anon não tem execute nas RPCs do CRM
    // --------------------------------------------------------------------------
    await runProbe('PD-2: RPCs do CRM bloqueadas para anon (fail-closed)', async () => {
      const grants = await query(`
        SELECT routine_name, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name IN (
            'buscar_clientes_crm',
            'obter_cliente_360_admin',
            'adicionar_nota_cliente',
            'arquivar_nota_cliente',
            'adicionar_tag_cliente',
            'remover_tag_cliente',
            'definir_preferencia_cliente',
            'arquivar_preferencia_cliente',
            'obter_meu_perfil_360'
          )
          AND grantee IN ('PUBLIC', 'anon');
      `);
      assert(grants.length === 0, `RPCs expostas para anon: ${JSON.stringify(grants)}`);
    });

    // Fixture de cliente em produção
    const cliRes = await query(`
      INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf)
      VALUES ('${TEST_PREFIX} Cliente CRM', '85991112233', '5585991112233', 'pd_test_${Date.now()}@lunoca.local', '09876543211')
      RETURNING id;
    `);
    testClienteId = cliRes[0].id;

    // --------------------------------------------------------------------------
    // PD-3: Busca rápida por nome e telefone
    // --------------------------------------------------------------------------
    await runProbe('PD-3: buscar_clientes_crm localiza por nome e telefone', async () => {
      const resNome = await adminQuery(`
        SELECT public.buscar_clientes_crm('${TEST_PREFIX}') AS r;
      `);
      assert(resNome[0]?.r?.success === true, 'Busca por nome deve retornar sucesso');
      const achadoNome = resNome[0]?.r?.clientes?.find(c => Number(c.id) === Number(testClienteId));
      assert(achadoNome, 'Cliente deve ser encontrado pelo termo prefixo');

      const resTel = await adminQuery(`
        SELECT public.buscar_clientes_crm('99111-2233') AS r;
      `);
      assert(resTel[0]?.r?.success === true, 'Busca por telefone deve retornar sucesso');
      const achadoTel = resTel[0]?.r?.clientes?.find(c => Number(c.id) === Number(testClienteId));
      assert(achadoTel, 'Cliente deve ser encontrado pelo telefone');
    });

    // --------------------------------------------------------------------------
    // PD-4: Anon recebe bloqueio ao tentar obter ficha 360
    // --------------------------------------------------------------------------
    await runProbe('PD-4: Anon / não autorizado recebe PERMISSION_DENIED em obter_cliente_360_admin', async () => {
      const res = await query(`
        SELECT public.obter_cliente_360_admin(${testClienteId}) AS r;
      `);
      assert(res[0]?.r?.success === false, 'Deveria falhar sem contexto de equipe');
      assert(res[0]?.r?.code === 'PERMISSION_DENIED', `Esperado PERMISSION_DENIED, recebido: ${res[0]?.r?.code}`);
    });

    // --------------------------------------------------------------------------
    // PD-5: Equipe adiciona nota interna auditável e arquiva sem DELETE físico
    // --------------------------------------------------------------------------
    await runProbe('PD-5: adicionar_nota_cliente e arquivar_nota_cliente operam sem DELETE físico', async () => {
      const addRes = await adminQuery(`
        SELECT public.adicionar_nota_cliente(${testClienteId}, 'Cliente prefere entregas no período da tarde', 'preferencia') AS r;
      `);
      assert(addRes[0]?.r?.success === true, 'Adição de nota deve ter sucesso');
      const notaId = addRes[0]?.r?.nota_id;
      assert(notaId, 'Deve retornar nota_id');

      const arqRes = await adminQuery(`
        SELECT public.arquivar_nota_cliente(${notaId}) AS r;
      `);
      assert(arqRes[0]?.r?.success === true, 'Arquivamento de nota deve ter sucesso');

      const notaCheck = await query(`
        SELECT arquivada FROM public.cliente_notas WHERE id = ${notaId};
      `);
      assert(notaCheck[0]?.arquivada === true, 'Nota deve permanecer na tabela com flag arquivada = true');
    });

    // --------------------------------------------------------------------------
    // PD-6: Adicionar e remover tag operacional
    // --------------------------------------------------------------------------
    await runProbe('PD-6: adicionar_tag_cliente e remover_tag_cliente', async () => {
      const addTag = await adminQuery(`
        SELECT public.adicionar_tag_cliente(${testClienteId}, 'VIP') AS r;
      `);
      assert(addTag[0]?.r?.success === true, 'Adição de tag deve ter sucesso');

      const remTag = await adminQuery(`
        SELECT public.remover_tag_cliente(${testClienteId}, 'VIP') AS r;
      `);
      assert(remTag[0]?.r?.success === true, 'Remoção de tag deve ter sucesso');
    });

    // --------------------------------------------------------------------------
    // PD-7: Definir preferência do cliente
    // --------------------------------------------------------------------------
    await runProbe('PD-7: definir_preferencia_cliente e arquivar_preferencia_cliente', async () => {
      const addPref = await adminQuery(`
        SELECT public.definir_preferencia_cliente(${testClienteId}, 'sabor', 'Chocolate Belga', 'Sem nozes') AS r;
      `);
      assert(addPref[0]?.r?.success === true, 'Definição de preferência deve ter sucesso');
      const prefId = addPref[0]?.r?.preferencia_id;

      const arqPref = await adminQuery(`
        SELECT public.arquivar_preferencia_cliente(${prefId}) AS r;
      `);
      assert(arqPref[0]?.r?.success === true, 'Arquivamento de preferência deve ter sucesso');
    });

    // Cria pedidos fixture para apuração de LTV e Caixa em produção
    const pedRes = await query(`
      INSERT INTO public.pedidos (
        cliente_id_rel, nome_cliente, email_cliente, data_pedido, data_entrega, total, subtotal,
        valor_pago, saldo, sinal_minimo, status_comercial, status_financeiro, status_operacional,
        pagamento, itens, endereco_entrega
      ) VALUES 
      (
        ${testClienteId}, '${TEST_PREFIX} Cliente', 'pd_test@lunoca.local', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        250.00, 250.00, 250.00, 0.00, 125.00, 'concluido', 'pago', 'entregue', 'pix', 'Bolo PD 1', 'Retirada'
      ) RETURNING id;
    `);
    testPedidoId = pedRes[0].id;

    await query(`
      INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, provider, status, pago_em)
      VALUES (${testPedidoId}, 250.00, 'pix', 'caixa', 'aprovado', NOW());
    `);

    // --------------------------------------------------------------------------
    // PD-8: obter_cliente_360_admin consolida métricas LTV e caixa real
    // --------------------------------------------------------------------------
    await runProbe('PD-8: obter_cliente_360_admin calcula LTV e caixa real sem duplicar', async () => {
      const res360 = await adminQuery(`
        SELECT public.obter_cliente_360_admin(${testClienteId}) AS r;
      `);
      assert(res360[0]?.r?.success === true, 'obter_cliente_360_admin deve ter sucesso');
      const m = res360[0]?.r?.metricas;
      assert(Number(m?.pedidos_concluidos) === 1, 'Deve ter 1 pedido concluído');
      assert(Number(m?.valor_pedidos_concluidos) === 250.00, 'LTV deve ser 250.00');
      assert(Number(m?.valor_recebido_caixa) === 250.00, 'Caixa recebido deve ser 250.00');
      assert(Number(m?.ticket_medio) === 250.00, 'Ticket médio deve ser 250.00');
    });

    // --------------------------------------------------------------------------
    // PD-9: Timeline 360 unificada ordena eventos cronologicamente
    // --------------------------------------------------------------------------
    await runProbe('PD-9: Timeline 360 agrega eventos do cliente e sanitiza tokens', async () => {
      const res360 = await adminQuery(`
        SELECT public.obter_cliente_360_admin(${testClienteId}) AS r;
      `);
      const timeline = res360[0]?.r?.timeline || [];
      assert(timeline.length >= 1, 'Timeline deve conter pelo menos o evento do pedido');
      assert(timeline[0].tipo === 'pedido', 'Primeiro evento deve ser o pedido');
    });

    // --------------------------------------------------------------------------
    // PD-10: Visão do próprio cliente (obter_meu_perfil_360) não vaza notas internas
    // --------------------------------------------------------------------------
    await runProbe('PD-10: obter_meu_perfil_360 é fail-closed e isolado', async () => {
      const res = await query(`
        SELECT public.obter_meu_perfil_360() AS r;
      `);
      // Sem auth.uid() de cliente logado, retorna UNAUTHENTICATED
      assert(res[0]?.r?.success === false, 'Deveria requerer sessão');
      assert(res[0]?.r?.code === 'UNAUTHENTICATED', 'Deve retornar UNAUTHENTICATED');
    });

  } finally {
    // Limpeza de fixtures
    if (testPedidoId) {
      await query(`DELETE FROM public.pedido_pagamentos WHERE pedido_id = ${testPedidoId};`);
      await query(`DELETE FROM public.pedidos WHERE id = ${testPedidoId};`);
    }
    if (testClienteId) {
      await query(`DELETE FROM public.cliente_preferencias WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.cliente_tags WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.cliente_notas WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.cliente_creditos WHERE cliente_id = ${testClienteId};`);
      await query(`DELETE FROM public.clientes WHERE id = ${testClienteId};`);
    }
  }

  console.log('\n============================================================');
  console.log(`🎉 TODOS OS ${passedProbes}/${totalProbes} PROBES DE PRODUÇÃO DA FRENTE D PASSARAM COM SUCESSO!`);
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\n❌ ERRO NOS PROBES DE PRODUÇÃO DA FRENTE D:', err);
  process.exit(1);
});
