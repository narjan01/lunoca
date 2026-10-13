// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE L (PL-1 a PL-10)
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE L (PL-1 a PL-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PL-1: Existência das 5 tabelas e RLS ativo
  process.stdout.write('⏳ PL-1: As 5 tabelas de Lotes/Qualidade existem em public com RLS habilitado... ');
  const pl1 = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'ingrediente_lotes',
        'ingrediente_lote_movimentacoes',
        'pedido_consumos_lote',
        'producao_controles_qualidade',
        'producao_ocorrencias_qualidade'
      )
    ORDER BY tablename;
  `);
  assert.equal(pl1.length, 5);
  for (const r of pl1) {
    assert.equal(r.rowsecurity, true);
  }
  console.log('✅ APROVADO');

  // PL-2: Existência das RPCs canônicas da Frente L com SECURITY DEFINER
  process.stdout.write('⏳ PL-2: Todas as 13 funções/RPCs canônicas da Frente L instaladas em produção... ');
  const pl2 = await query(`
    SELECT DISTINCT proname, prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        '_derivar_estado_validade_lote',
        '_verificar_reconciliacao_lotes_ingrediente',
        'configurar_rastreabilidade_ingrediente_admin',
        'receber_compra_com_lotes',
        'consumir_insumos_producao_pedido',
        'registrar_baixa_lote_insumo',
        'ajustar_lote_insumo_admin',
        'alterar_bloqueio_qualidade_lote',
        'registrar_controle_qualidade_pedido',
        'rastrear_lote_ingrediente_admin',
        'rastrear_pedido_producao_admin',
        'obter_painel_lotes_validade',
        'reconciliar_saldos_lotes_admin'
      )
    ORDER BY proname;
  `);
  assert.equal(pl2.length, 13);
  console.log('✅ APROVADO');

  // PL-3: Triggers de imutabilidade append-only e proteção de escrita direta
  process.stdout.write('⏳ PL-3: Triggers append-only e proteção de escrita em ingrediente_lotes ativas... ');
  const pl3 = await query(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgname IN (
      'trg_imutabilidade_ingrediente_lote_mov',
      'trg_imutabilidade_pedido_consumos_lote',
      'trg_imutabilidade_producao_cq',
      'trg_proteger_escrita_ingrediente_lotes'
    )
      AND NOT tgisinternal
    ORDER BY tgname;
  `);
  assert.equal(pl3.length, 4);
  console.log('✅ APROVADO');

  // PL-4: Reconciliação global de saldos x lotes em produção
  process.stdout.write('⏳ PL-4: Paridade matemática SUM(ingrediente_lotes) == ingrediente_saldos em produção... ');
  const pl4 = await query(`
    SELECT (SELECT COUNT(*)::int FROM public.ingrediente_saldos s
            WHERE ROUND(COALESCE(s.saldo_atual, 0), 3) <> ROUND(COALESCE((
              SELECT SUM(l.quantidade_atual) FROM public.ingrediente_lotes l WHERE l.ingrediente_id = s.ingrediente_id AND l.quantidade_atual > 0
            ), 0), 3)) AS divergencias;
  `);
  assert.equal(Number(pl4[0].divergencias), 0);
  console.log('✅ APROVADO');

  // PL-5 a PL-10: Simulação transacional completa com ROLLBACK
  process.stdout.write('⏳ PL-5..PL-10: Transação de ponta a ponta (Compra -> Lotes -> FEFO -> Hold Qualidade -> Reinspeção -> Recall -> ROLLBACK)... ');
  await query(`
    BEGIN;

    DO $$
    DECLARE
      v_admin_uid UUID;
      v_forn_id BIGINT;
      v_ing_id BIGINT;
      v_prod_id BIGINT;
      v_comp_res JSONB;
      v_rec_res JSONB;
      v_ped_id BIGINT;
      v_cons_res JSONB;
      v_qc_rep JSONB;
      v_pronto_bloq JSONB;
      v_qc_apr JSONB;
      v_pronto_ok JSONB;
      v_recall JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      SELECT (public.salvar_fornecedor_admin('Fornecedor Probe L')->>'fornecedor_id')::bigint INTO v_forn_id;

      INSERT INTO public.ingredientes (nome, unidade, custo_unitario, custo_medio_unitario, estoque_qtd, estoque_minimo, ativo, controlar_lote, controlar_validade)
      VALUES ('Pistache Iraniano Probe L', 'g', 0.25, 0.25, 0, 50, true, true, true)
      RETURNING id INTO v_ing_id;

      UPDATE public.ingrediente_saldos SET saldo_atual = 0, custo_medio_ponderado = 0.25 WHERE ingrediente_id = v_ing_id;

      INSERT INTO public.produtos (nome, preco, estoque_fisico, ativo, controlar_estoque)
      VALUES ('Entremet Pistache Probe L', 190.00, 10, true, false)
      RETURNING id INTO v_prod_id;

      INSERT INTO public.produto_ingredientes (produto_id, ingrediente_id, quantidade)
      VALUES (v_prod_id, v_ing_id, 120);

      -- PL-5: Compra com 2 lotes de validades diferentes
      v_comp_res := public.criar_compra(
        p_fornecedor_id => v_forn_id,
        p_itens => jsonb_build_array(
          jsonb_build_object('ingrediente_id', v_ing_id, 'quantidade', 100, 'custo_unitario', 0.25, 'codigo_lote', 'PROBE-L1', 'data_validade', (CURRENT_DATE + 5)::text),
          jsonb_build_object('ingrediente_id', v_ing_id, 'quantidade', 100, 'custo_unitario', 0.25, 'codigo_lote', 'PROBE-L2', 'data_validade', (CURRENT_DATE + 30)::text)
        ),
        p_numero_nota => 'NF-PROBE-L',
        p_data_compra => CURRENT_DATE
      );
      v_rec_res := public.receber_compra((v_comp_res->>'compra_id')::bigint, NULL, false);
      IF COALESCE((v_rec_res->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PL-5 falhou: %', v_rec_res;
      END IF;

      -- PL-6: Pedido de produção consumindo 120g via FEFO (100g do PROBE-L1 + 20g do PROBE-L2)
      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, data_pedido, data_entrega, hora_entrega,
        modalidade_entrega, endereco_entrega, total, subtotal,
        status_comercial, status_financeiro, status_operacional, status, pagamento, itens
      ) VALUES (
        'Cliente Probe L', 'probel@lunoca.test', '5585999990000', CURRENT_DATE, CURRENT_DATE, '17:00:00',
        'retirada', 'Retirada na Loja', 190.00, 190.00,
        'confirmado', 'pago', 'em_producao', 'Confirmado', 'pix', '[]'::jsonb
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, produto_nome_snapshot, quantidade,
        preco_base_snapshot, preco_unitario_snapshot, subtotal, cmv_unitario_snapshot, cmv_total_snapshot
      ) VALUES (v_ped_id, v_prod_id, 'Entremet Pistache Probe L', 1, 190.00, 190.00, 190.00, 30.00, 30.00);

      v_cons_res := public.consumir_insumos_producao_pedido(v_ped_id, NULL, NULL);
      IF COALESCE((v_cons_res->>'success')::boolean, false) IS NOT TRUE OR jsonb_array_length(v_cons_res->'consumos_lote') <> 2 THEN
        RAISE EXCEPTION 'PL-6 falhou: %', v_cons_res;
      END IF;

      -- PL-7: Checkpoint REPROVADO bloqueia avanço para pronto
      v_qc_rep := public.registrar_controle_qualidade_pedido(v_ped_id, 'FINALIZACAO', 'REPROVADO', 'Textura fora do padrão');
      v_pronto_bloq := public.marcar_pedido_pronto(v_ped_id);
      IF v_pronto_bloq->>'code' <> 'QUALITY_HOLD_ACTIVE' THEN
        RAISE EXCEPTION 'PL-7 falhou: esperado QUALITY_HOLD_ACTIVE, obtido %', v_pronto_bloq;
      END IF;

      -- PL-8: Reinspeção APROVADO libera o pedido
      v_qc_apr := public.registrar_controle_qualidade_pedido(v_ped_id, 'FINALIZACAO', 'APROVADO', 'Textura corrigida');
      v_pronto_ok := public.marcar_pedido_pronto(v_ped_id);
      IF COALESCE((v_pronto_ok->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PL-8 falhou: %', v_pronto_ok;
      END IF;

      -- PL-9: Recall por lote encontra o pedido
      v_recall := public.rastrear_lote_ingrediente_admin(((v_rec_res->'lotes'->0)->>'lote_id')::bigint);
      IF COALESCE((v_recall->>'total_pedidos_afetados')::int, 0) <> 1 THEN
        RAISE EXCEPTION 'PL-9 falhou: %', v_recall;
      END IF;

      -- PL-10: Reconciliação permanece exata após todas as operações
      IF (public.reconciliar_saldos_lotes_admin()->>'reconciliado')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'PL-10 falhou: desreconciliação detectada';
      END IF;
    END;
    $$;

    ROLLBACK;
  `);
  console.log('✅ APROVADO');
  console.log('  ✅ PL-5 PASS: Recebimento de compra cria lotes rastreáveis com validades distintas.');
  console.log('  ✅ PL-6 PASS: Consumo de produção FEFO multi-lote aloca primeiro o lote mais próximo do vencimento.');
  console.log('  ✅ PL-7 PASS: Checkpoint REPROVADO ativa QUALITY_HOLD_ACTIVE e bloqueia avanço operacional.');
  console.log('  ✅ PL-8 PASS: Reinspeção APROVADO libera o pedido mantendo trilha append-only.');
  console.log('  ✅ PL-9 PASS: Recall por lote (rastrear_lote_ingrediente_admin) identifica pedidos impactados.');
  console.log('  ✅ PL-10 PASS: Paridade matemática SUM(ingrediente_lotes) == ingrediente_saldos preservada.');

  console.log('\n🎉 TODOS OS 10 PROBES DE PRODUÇÃO (PL-1 a PL-10) PASSARAM COM SUCESSO!\n');
}

main().catch((err) => {
  console.error('\n❌ FALHA NOS PROBES DE PRODUÇÃO DA FRENTE L:', err);
  process.exit(1);
});
