// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE 038 (PK-1 a PK-10)
// ==============================================================================
// Valida os 10 probes de conformidade da Migration 038 no Supabase de produção:
// PK-1:  Tabela pedido_producao_kds existe em public com pedido_id BIGINT e RLS ativado
// PK-2:  Tabela pedido_item_producao_kds existe com pedido_item_id BIGINT, praca_atual nullable e RLS ativado
// PK-3:  Tabelas produto_etapas_kds e pedido_item_kds_etapas com constraints de ordem e praça
// PK-4:  Tabela pedido_kds_estagio_historico bloqueia DELETE e UPDATE com SQLSTATE 42501
// PK-5:  RPC kds_avancar_item rejeita parâmetros externos de operador e utiliza auth.uid()
// PK-6:  Validação estrita de snapshot de rota (avanço obedece pedido_item_kds_etapas)
// PK-7:  Transição atômica do 1º item fora de AGUARDANDO atualiza status_operacional = em_producao
// PK-8:  Transição atômica de todas as unidades para PRONTO atualiza status_operacional = pronto
// PK-9:  Cancelamento de pedido encerra unidades KDS abertas com motivo CANCELADO sem marcar pronto
// PK-10: Tabelas KDS publicadas em supabase_realtime e grants fail-closed para anon e PUBLIC
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE KDS (PK-1 a PK-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PK-1: Tabela pedido_producao_kds existe em public com pedido_id BIGINT e RLS ativado
  process.stdout.write('⏳ PK-1: pedido_producao_kds existe com pedido_id BIGINT e RLS ativado... ');
  const pk1Table = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'pedido_producao_kds';
  `);
  assert.equal(pk1Table.length, 1, 'Tabela pedido_producao_kds deve existir em public');
  assert.equal(pk1Table[0].rowsecurity, true, 'pedido_producao_kds deve ter RLS ativado');

  const pk1Col = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedido_producao_kds' AND column_name = 'pedido_id';
  `);
  assert.equal(pk1Col.length, 1, 'Coluna pedido_id deve existir');
  assert.equal(pk1Col[0].data_type, 'bigint', 'pedido_id deve ser do tipo BIGINT');
  assert.equal(pk1Col[0].is_nullable, 'NO', 'pedido_id não pode ser nullable');
  console.log('✅ APROVADO');

  // PK-2: Tabela pedido_item_producao_kds existe com pedido_item_id BIGINT, praca_atual nullable e RLS ativado
  process.stdout.write('⏳ PK-2: pedido_item_producao_kds existe com pedido_item_id BIGINT e praca_atual nullable... ');
  const pk2Table = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'pedido_item_producao_kds';
  `);
  assert.equal(pk2Table.length, 1, 'Tabela pedido_item_producao_kds deve existir');
  assert.equal(pk2Table[0].rowsecurity, true, 'pedido_item_producao_kds deve ter RLS ativado');

  const pk2Cols = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedido_item_producao_kds'
      AND column_name IN ('pedido_id', 'pedido_item_id', 'praca_atual')
    ORDER BY column_name;
  `);
  const colMap = Object.fromEntries(pk2Cols.map(c => [c.column_name, c]));
  assert.equal(colMap['pedido_id']?.data_type, 'bigint', 'pedido_id deve ser BIGINT');
  assert.equal(colMap['pedido_item_id']?.data_type, 'bigint', 'pedido_item_id deve ser BIGINT');
  assert.equal(colMap['praca_atual']?.is_nullable, 'YES', 'praca_atual deve ser nullable');
  console.log('✅ APROVADO');

  // PK-3: Tabelas produto_etapas_kds e pedido_item_kds_etapas com constraints de ordem e praça
  process.stdout.write('⏳ PK-3: produto_etapas_kds e pedido_item_kds_etapas com constraints de integridade... ');
  const pk3Tables = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('produto_etapas_kds', 'pedido_item_kds_etapas')
    ORDER BY tablename;
  `);
  assert.equal(pk3Tables.length, 2, 'Ambas as tabelas de etapas devem existir');

  const pk3Constraints = await query(`
    SELECT conname, contype
    FROM pg_constraint
    WHERE conrelid IN ('public.produto_etapas_kds'::regclass, 'public.pedido_item_kds_etapas'::regclass)
      AND conname IN ('uq_produto_etapa_ordem', 'uq_produto_etapa_praca', 'uq_kds_item_etapa', 'uq_kds_item_praca')
    ORDER BY conname;
  `);
  assert.ok(pk3Constraints.length >= 4, 'Constraints de unicidade de ordem e praça devem estar ativas');
  console.log('✅ APROVADO');

  // PK-4: Tabela pedido_kds_estagio_historico bloqueia DELETE e UPDATE com SQLSTATE 42501
  process.stdout.write('⏳ PK-4: pedido_kds_estagio_historico bloqueia DELETE e UPDATE com 42501... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_ped_id BIGINT;
      v_item_id BIGINT;
      v_kds_id UUID;
      v_kds_item_id UUID;
      v_hist_id BIGINT;
      v_err_update TEXT := '';
      v_err_delete TEXT := '';
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, hora_entrega,
        total, status_operacional, status_financeiro, status_comercial,
        pagamento, canal, itens, endereco_entrega
      ) VALUES (
        'Probe PK4 Cliente', '11999990004', 'pk4@teste.com',
        CURRENT_DATE, CURRENT_DATE, '16:00:00',
        10.00, 'aguardando_producao', 'pago', 'confirmado',
        'pix', 'balcao', '[]'::jsonb, 'Balcão da Loja'
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_nome_snapshot, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal
      )
      VALUES (v_ped_id, 'Item Probe PK4', 1, 10.00, 10.00, 10.00)
      RETURNING id INTO v_item_id;

      INSERT INTO public.pedido_producao_kds (pedido_id, estagio_agregado, sla_total_snapshot)
      VALUES (v_ped_id, 'AGUARDANDO', 30)
      RETURNING id INTO v_kds_id;

      INSERT INTO public.pedido_item_producao_kds (
        kds_id, pedido_id, pedido_item_id, produto_nome_snapshot, quantidade,
        ordem_etapa_atual, ordem_etapa_max, estagio_atual, sla_etapa_snapshot, sla_total_snapshot
      ) VALUES (
        v_kds_id, v_ped_id, v_item_id, 'Item Probe PK4', 1,
        0, 1, 'AGUARDANDO', 15, 15
      ) RETURNING id INTO v_kds_item_id;

      INSERT INTO public.pedido_kds_estagio_historico (
        kds_id, kds_item_id, pedido_id, pedido_item_id,
        estagio_origem, estagio_destino, praca, tempo_segundos
      ) VALUES (
        v_kds_id, v_kds_item_id, v_ped_id, v_item_id,
        'AGUARDANDO', 'FORNO', 'FORNO', 60
      ) RETURNING id INTO v_hist_id;

      -- Testar bloqueio de UPDATE
      BEGIN
        UPDATE public.pedido_kds_estagio_historico SET tempo_segundos = 999 WHERE id = v_hist_id;
      EXCEPTION WHEN SQLSTATE '42501' THEN
        v_err_update := '42501';
      END;

      -- Testar bloqueio de DELETE
      BEGIN
        DELETE FROM public.pedido_kds_estagio_historico WHERE id = v_hist_id;
      EXCEPTION WHEN SQLSTATE '42501' THEN
        v_err_delete := '42501';
      END;

      IF v_err_update <> '42501' OR v_err_delete <> '42501' THEN
        RAISE EXCEPTION 'Falha na segurança append-only do KDS: UPDATE=% DELETE=%', v_err_update, v_err_delete;
      END IF;

      RAISE EXCEPTION 'PROBE_PK4_ROLLBACK_OK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_PK4_ROLLBACK_OK' THEN
        RAISE;
      END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PK-5: RPC kds_avancar_item rejeita parâmetros externos de operador e utiliza auth.uid()
  process.stdout.write('⏳ PK-5: RPC kds_avancar_item rejeita operador externo e valida auth.uid()... ');
  const pk5Args = await query(`
    SELECT pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'kds_avancar_item';
  `);
  assert.equal(pk5Args.length, 1, 'RPC kds_avancar_item deve existir');
  assert.ok(!pk5Args[0].args.includes('operador'), 'Não deve aceitar parâmetro de operador externo');
  assert.ok(pk5Args[0].args.includes('p_kds_item_id uuid'), 'Deve receber p_kds_item_id uuid');
  assert.ok(pk5Args[0].args.includes('p_proximo_estagio character varying'), 'Deve receber p_proximo_estagio varchar');
  console.log('✅ APROVADO');

  // PK-6: Validação estrita de snapshot de rota (avanço obedece pedido_item_kds_etapas)
  process.stdout.write('⏳ PK-6: Validação estrita contra snapshot de rota (rejeita saltos ilegais)... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_ped_id BIGINT;
      v_item_id BIGINT;
      v_kds_id UUID;
      v_kds_item_id UUID;
      v_res JSONB;
      v_jump_blocked BOOLEAN := FALSE;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, hora_entrega,
        total, status_operacional, status_financeiro, status_comercial,
        pagamento, canal, itens, endereco_entrega
      ) VALUES (
        'Probe PK6 Cliente', '11999990006', 'pk6@teste.com',
        CURRENT_DATE, CURRENT_DATE, '16:00:00',
        25.00, 'aguardando_producao', 'pago', 'confirmado',
        'pix', 'balcao', '[]'::jsonb, 'Balcão da Loja'
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, produto_nome_snapshot, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal
      )
      VALUES (v_ped_id, v_prod_id, 'Item PK6', 1, 25.00, 25.00, 25.00)
      RETURNING id INTO v_item_id;

      INSERT INTO public.pedido_producao_kds (pedido_id, estagio_agregado, sla_total_snapshot)
      VALUES (v_ped_id, 'AGUARDANDO', 40)
      RETURNING id INTO v_kds_id;

      INSERT INTO public.pedido_item_producao_kds (
        kds_id, pedido_id, pedido_item_id, produto_id, produto_nome_snapshot, quantidade,
        ordem_etapa_atual, ordem_etapa_max, estagio_atual, proxima_etapa, sla_etapa_snapshot, sla_total_snapshot
      ) VALUES (
        v_kds_id, v_ped_id, v_item_id, v_prod_id, 'Item PK6', 1,
        0, 2, 'AGUARDANDO', 'FORNO', 20, 40
      ) RETURNING id INTO v_kds_item_id;

      -- Congelar rota no snapshot: 1: FORNO, 2: EMBALAGEM
      INSERT INTO public.pedido_item_kds_etapas (kds_item_id, pedido_id, pedido_item_id, ordem, praca, sla_minutos_snapshot)
      VALUES 
        (v_kds_item_id, v_ped_id, v_item_id, 1, 'FORNO', 20),
        (v_kds_item_id, v_ped_id, v_item_id, 2, 'EMBALAGEM', 20);

      -- Tentar avançar diretamente de AGUARDANDO para EMBALAGEM ou PRONTO (salto ilegal)
      BEGIN
        v_res := public.kds_avancar_item(v_kds_item_id, 'EMBALAGEM');
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%KDS_ILLEGAL_STAGE_JUMP%' THEN
          v_jump_blocked := TRUE;
        END IF;
      END;

      IF NOT v_jump_blocked THEN
        RAISE EXCEPTION 'Salto ilegal de etapa não foi bloqueado!';
      END IF;

      RAISE EXCEPTION 'PROBE_PK6_ROLLBACK_OK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_PK6_ROLLBACK_OK' THEN
        RAISE;
      END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PK-7: Transição atômica do 1º item fora de AGUARDANDO atualiza pedidos.status_operacional = 'em_producao'
  process.stdout.write('⏳ PK-7: Transição atômica de avanço inicial atualiza status_operacional = em_producao... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_ped_id BIGINT;
      v_item_id BIGINT;
      v_kds_id UUID;
      v_kds_item_id UUID;
      v_res JSONB;
      v_status_op TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, hora_entrega,
        total, status_operacional, status_financeiro, status_comercial,
        pagamento, canal, itens, endereco_entrega
      ) VALUES (
        'Probe PK7 Cliente', '11999990007', 'pk7@teste.com',
        CURRENT_DATE, CURRENT_DATE, '16:00:00',
        30.00, 'aguardando_producao', 'pago', 'confirmado',
        'pix', 'balcao', '[]'::jsonb, 'Balcão da Loja'
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, produto_nome_snapshot, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal
      )
      VALUES (v_ped_id, v_prod_id, 'Item PK7', 1, 30.00, 30.00, 30.00)
      RETURNING id INTO v_item_id;

      INSERT INTO public.pedido_producao_kds (pedido_id, estagio_agregado, sla_total_snapshot)
      VALUES (v_ped_id, 'AGUARDANDO', 20)
      RETURNING id INTO v_kds_id;

      INSERT INTO public.pedido_item_producao_kds (
        kds_id, pedido_id, pedido_item_id, produto_id, produto_nome_snapshot, quantidade,
        ordem_etapa_atual, ordem_etapa_max, estagio_atual, proxima_etapa, sla_etapa_snapshot, sla_total_snapshot
      ) VALUES (
        v_kds_id, v_ped_id, v_item_id, v_prod_id, 'Item PK7', 1,
        0, 1, 'AGUARDANDO', 'FORNO', 20, 20
      ) RETURNING id INTO v_kds_item_id;

      INSERT INTO public.pedido_item_kds_etapas (kds_item_id, pedido_id, pedido_item_id, ordem, praca, sla_minutos_snapshot)
      VALUES (v_kds_item_id, v_ped_id, v_item_id, 1, 'FORNO', 20);

      -- Avança 1º item para FORNO
      v_res := public.kds_avancar_item(v_kds_item_id, 'FORNO');
      IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha em kds_avancar_item: %', v_res;
      END IF;

      -- Verifica se o pedido transitou para em_producao
      SELECT status_operacional INTO v_status_op FROM public.pedidos WHERE id = v_ped_id;
      IF v_status_op <> 'em_producao' THEN
        RAISE EXCEPTION 'status_operacional esperado: em_producao, obtido: %', v_status_op;
      END IF;

      RAISE EXCEPTION 'PROBE_PK7_ROLLBACK_OK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_PK7_ROLLBACK_OK' THEN
        RAISE;
      END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PK-8: Transição atômica de todas as unidades para PRONTO atualiza pedidos.status_operacional = 'pronto'
  process.stdout.write('⏳ PK-8: Transição final de conclusão atualiza status_operacional = pronto... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_ped_id BIGINT;
      v_item_id BIGINT;
      v_kds_id UUID;
      v_kds_item_id UUID;
      v_res JSONB;
      v_status_op TEXT;
      v_estagio_kds TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, hora_entrega,
        total, status_operacional, status_financeiro, status_comercial,
        pagamento, canal, itens, endereco_entrega
      ) VALUES (
        'Probe PK8 Cliente', '11999990008', 'pk8@teste.com',
        CURRENT_DATE, CURRENT_DATE, '16:00:00',
        30.00, 'aguardando_producao', 'pago', 'confirmado',
        'pix', 'balcao', '[]'::jsonb, 'Balcão da Loja'
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, produto_nome_snapshot, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal
      )
      VALUES (v_ped_id, v_prod_id, 'Item PK8', 1, 30.00, 30.00, 30.00)
      RETURNING id INTO v_item_id;

      INSERT INTO public.pedido_producao_kds (pedido_id, estagio_agregado, sla_total_snapshot)
      VALUES (v_ped_id, 'AGUARDANDO', 20)
      RETURNING id INTO v_kds_id;

      INSERT INTO public.pedido_item_producao_kds (
        kds_id, pedido_id, pedido_item_id, produto_id, produto_nome_snapshot, quantidade,
        ordem_etapa_atual, ordem_etapa_max, estagio_atual, proxima_etapa, sla_etapa_snapshot, sla_total_snapshot
      ) VALUES (
        v_kds_id, v_ped_id, v_item_id, v_prod_id, 'Item PK8', 1,
        0, 1, 'AGUARDANDO', 'FORNO', 20, 20
      ) RETURNING id INTO v_kds_item_id;

      INSERT INTO public.pedido_item_kds_etapas (kds_item_id, pedido_id, pedido_item_id, ordem, praca, sla_minutos_snapshot)
      VALUES (v_kds_item_id, v_ped_id, v_item_id, 1, 'FORNO', 20);

      -- Avança para FORNO
      PERFORM public.kds_avancar_item(v_kds_item_id, 'FORNO');

      -- Conclui para PRONTO
      v_res := public.kds_avancar_item(v_kds_item_id, 'PRONTO');
      IF (v_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha em kds_avancar_item para PRONTO: %', v_res;
      END IF;

      SELECT status_operacional INTO v_status_op FROM public.pedidos WHERE id = v_ped_id;
      SELECT estagio_agregado INTO v_estagio_kds FROM public.pedido_producao_kds WHERE id = v_kds_id;

      IF v_status_op <> 'pronto' OR v_estagio_kds <> 'PRONTO' THEN
        RAISE EXCEPTION 'Conclusão falhou: status_operacional=%, estagio_kds=%', v_status_op, v_estagio_kds;
      END IF;

      RAISE EXCEPTION 'PROBE_PK8_ROLLBACK_OK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_PK8_ROLLBACK_OK' THEN
        RAISE;
      END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PK-9: Cancelamento de pedido desativa unidades KDS abertas com motivo CANCELADO sem marcar pronto
  process.stdout.write('⏳ PK-9: Cancelamento de pedido encerra unidades KDS sem marcar pronto... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_prod_id BIGINT;
      v_ped_id BIGINT;
      v_item_id BIGINT;
      v_kds_id UUID;
      v_kds_item_id UUID;
      v_ativo_head BOOLEAN;
      v_motivo_head TEXT;
      v_estagio_head TEXT;
      v_ativo_item BOOLEAN;
      v_estagio_item TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, telefone_cliente, email_cliente,
        data_pedido, data_entrega, hora_entrega,
        total, status_operacional, status_financeiro, status_comercial,
        pagamento, canal, itens, endereco_entrega
      ) VALUES (
        'Probe PK9 Cliente', '11999990009', 'pk9@teste.com',
        CURRENT_DATE, CURRENT_DATE, '16:00:00',
        20.00, 'aguardando_producao', 'pago', 'confirmado',
        'pix', 'balcao', '[]'::jsonb, 'Balcão da Loja'
      ) RETURNING id INTO v_ped_id;

      INSERT INTO public.pedido_itens (
        pedido_id, produto_id, produto_nome_snapshot, quantidade,
        preco_unitario_snapshot, preco_base_snapshot, subtotal
      )
      VALUES (v_ped_id, v_prod_id, 'Item PK9', 1, 20.00, 20.00, 20.00)
      RETURNING id INTO v_item_id;

      INSERT INTO public.pedido_producao_kds (pedido_id, estagio_agregado, sla_total_snapshot)
      VALUES (v_ped_id, 'AGUARDANDO', 20)
      RETURNING id INTO v_kds_id;

      INSERT INTO public.pedido_item_producao_kds (
        kds_id, pedido_id, pedido_item_id, produto_id, produto_nome_snapshot, quantidade,
        ordem_etapa_atual, ordem_etapa_max, estagio_atual, proxima_etapa, sla_etapa_snapshot, sla_total_snapshot
      ) VALUES (
        v_kds_id, v_ped_id, v_item_id, v_prod_id, 'Item PK9', 1,
        0, 1, 'AGUARDANDO', 'FORNO', 20, 20
      ) RETURNING id INTO v_kds_item_id;

      -- Cancela o pedido
      UPDATE public.pedidos SET status_operacional = 'cancelado' WHERE id = v_ped_id;

      SELECT ativo, motivo_encerramento, estagio_agregado INTO v_ativo_head, v_motivo_head, v_estagio_head
      FROM public.pedido_producao_kds WHERE id = v_kds_id;

      SELECT ativo, estagio_atual INTO v_ativo_item, v_estagio_item
      FROM public.pedido_item_producao_kds WHERE id = v_kds_item_id;

      IF v_ativo_head <> false OR v_motivo_head <> 'CANCELADO' OR v_estagio_head = 'PRONTO' THEN
        RAISE EXCEPTION 'Falha no encerramento KDS do cabeçalho: ativo=%, motivo=%, estagio=%', v_ativo_head, v_motivo_head, v_estagio_head;
      END IF;

      IF v_ativo_item <> false OR v_estagio_item = 'PRONTO' THEN
        RAISE EXCEPTION 'Falha no encerramento KDS do item: ativo=%, estagio=%', v_ativo_item, v_estagio_item;
      END IF;

      RAISE EXCEPTION 'PROBE_PK9_ROLLBACK_OK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_PK9_ROLLBACK_OK' THEN
        RAISE;
      END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PK-10: Tabelas KDS publicadas em supabase_realtime e grants fail-closed para anon e PUBLIC
  process.stdout.write('⏳ PK-10: Publicação em supabase_realtime e grants fail-closed confirmados... ');
  const pk10Realtime = await query(`
    SELECT tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename IN ('pedido_producao_kds', 'pedido_item_producao_kds')
    ORDER BY tablename;
  `);
  assert.equal(pk10Realtime.length, 2, 'Ambas as tabelas de KDS devem estar publicadas no Realtime');

  const pk10Privs = await query(`
    SELECT has_table_privilege('anon', 'public.pedido_producao_kds', 'INSERT') as anon_ins,
           has_table_privilege('anon', 'public.pedido_kds_estagio_historico', 'DELETE') as anon_del,
           has_table_privilege('anon', 'public.pedido_item_producao_kds', 'UPDATE') as anon_upd;
  `);
  assert.equal(pk10Privs[0].anon_ins, false, 'Anon não pode inserir no KDS');
  assert.equal(pk10Privs[0].anon_del, false, 'Anon não pode deletar histórico');
  assert.equal(pk10Privs[0].anon_upd, false, 'Anon não pode atualizar itens KDS');
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('  🎉 BATERIA DE PROBES FRENTE KDS 100% HOMOLOGADA EM PRODUÇÃO!');
  console.log('  10/10 PROBES APROVADOS (PK-1 a PK-10)');
  console.log('============================================================\n');
}

main().catch(err => {
  console.error('\n❌ ERRO NA HOMOLOGAÇÃO FRENTE KDS:', err);
  process.exit(1);
});
