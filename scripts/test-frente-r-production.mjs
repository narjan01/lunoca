// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE R (PR-1 a PR-10)
// ==============================================================================
// Valida os 10 probes de conformidade da Migration 034 no Supabase de produção:
// PR-1:  As 4 tabelas canônicas de Caixa existem em public com RLS habilitado
// PR-2:  As 7 RPCs canônicas da Frente R instaladas com SECURITY DEFINER
// PR-3:  Triggers append-only de segurança ativos nas 4 tabelas (SQLSTATE 42501)
// PR-4:  Índices parciais de sessão única e restrições de idempotência ativos
// PR-5:  Zero lançamentos em financeiro_lancamentos/DRE para suprimento ou sangria
// PR-6:  Sangria rejeita valor superior ao dinheiro físico disponível na gaveta
// PR-7:  finalizar_venda_pdv bloqueia checkout sem sessão de caixa aberta
// PR-8:  Projeção cega server-side oculta saldo esperado e total dinheiro do operador
// PR-9:  Exigência de justificativa em divergência e imutabilidade de sessão fechada
// PR-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE R (PR-1 a PR-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PR-1: As 4 tabelas canônicas de Caixa existem em public com RLS habilitado
  process.stdout.write('⏳ PR-1: As 4 tabelas canônicas de Caixa existem em public com RLS habilitado... ');
  const pr1 = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'caixa_sessoes',
        'caixa_sessao_movimentacoes',
        'caixa_sessao_pagamentos',
        'caixa_sessao_auditorias'
      )
    ORDER BY tablename;
  `);
  assert.equal(pr1.length, 4, 'Esperado 4 tabelas canônicas de caixa da Frente R em public');
  for (const r of pr1) {
    assert.equal(r.rowsecurity, true, `Tabela ${r.tablename} deve ter RLS ativo`);
  }
  console.log('✅ APROVADO');

  // PR-2: As 7 RPCs canônicas da Frente R instaladas com SECURITY DEFINER
  process.stdout.write('⏳ PR-2: As 7 RPCs canônicas da Frente R instaladas com SECURITY DEFINER... ');
  const pr2 = await query(`
    SELECT DISTINCT proname, prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        'abrir_sessao_caixa',
        'registrar_movimentacao_caixa',
        'consultar_sessao_caixa_atual',
        'obter_resumo_sessao_caixa_admin',
        'fechar_sessao_caixa',
        'auditar_sessao_caixa_admin',
        'listar_sessoes_caixa_admin'
      )
    ORDER BY proname;
  `);
  assert.equal(pr2.length, 7, 'Esperado 7 RPCs canônicas da Frente R instaladas em public');
  for (const r of pr2) {
    assert.equal(r.prosecdef, true, `RPC ${r.proname} deve ter SECURITY DEFINER ativado`);
  }
  console.log('✅ APROVADO');

  // PR-3: Triggers append-only de segurança ativos nas 4 tabelas (SQLSTATE 42501)
  process.stdout.write('⏳ PR-3: Triggers append-only de segurança ativos nas tabelas de caixa... ');
  const pr3 = await query(`
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND trigger_name IN (
        'trg_valida_sessao_imutavel',
        'trg_caixa_movimentacoes_append_only',
        'trg_caixa_pagamentos_append_only',
        'trg_caixa_auditorias_append_only'
      )
    ORDER BY trigger_name;
  `);
  assert.ok(pr3.length >= 4, 'Esperado ao menos 4 triggers de segurança/append-only da Frente R');
  console.log('✅ APROVADO');

  // PR-4: Índices parciais de sessão única e restrições de idempotência ativos
  process.stdout.write('⏳ PR-4: Índices parciais de sessão única e restrições de unicidade... ');
  const pr4 = await query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'uq_caixa_sessao_operador_aberta',
        'uq_caixa_sessao_terminal_aberta',
        'uq_caixa_sessao_mov_idemp',
        'uq_caixa_sessao_pagamento'
      )
    ORDER BY indexname;
  `);
  assert.equal(pr4.length, 4, 'Esperado 4 índices únicos/parciais de integridade da Frente R');
  console.log('✅ APROVADO');

  // PR-5: Zero lançamentos em financeiro_lancamentos/DRE para suprimento ou sangria
  process.stdout.write('⏳ PR-5: Zero lançamentos contábeis/DRE para suprimento ou sangria (neutralidade patrimonial)... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_sessao_res JSONB;
      v_sessao_id BIGINT;
      v_mov_res JSONB;
      v_cnt_fin_antes INT;
      v_cnt_fin_depois INT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      SELECT COUNT(*) INTO v_cnt_fin_antes FROM public.financeiro_lancamentos;

      -- 1. Abertura de sessão de teste
      v_sessao_res := public.abrir_sessao_caixa(
        p_fundo_troco := 100.00,
        p_terminal := 'PROBE_PR5_TERM',
        p_observacoes := 'Probe PR-5'
      );
      IF (v_sessao_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao abrir sessão no PR-5: %', v_sessao_res;
      END IF;
      v_sessao_id := (v_sessao_res->>'sessao_id')::bigint;

      -- 2. Registro de Suprimento
      v_mov_res := public.registrar_movimentacao_caixa(
        p_tipo := 'SUPRIMENTO',
        p_valor := 50.00,
        p_motivo := 'Troco extra de moedas',
        p_idempotency_key := 'probe-pr5-sup-1',
        p_sessao_id := v_sessao_id
      );
      IF (v_mov_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao registrar suprimento no PR-5: %', v_mov_res;
      END IF;

      -- 3. Registro de Sangria
      v_mov_res := public.registrar_movimentacao_caixa(
        p_tipo := 'SANGRIA',
        p_valor := 30.00,
        p_motivo := 'Recolhimento parcial para cofre',
        p_idempotency_key := 'probe-pr5-san-1',
        p_sessao_id := v_sessao_id
      );
      IF (v_mov_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao registrar sangria no PR-5: %', v_mov_res;
      END IF;

      -- 4. Invariante: financeiro_lancamentos não deve ter sofrido NENHUMA inserção
      SELECT COUNT(*) INTO v_cnt_fin_depois FROM public.financeiro_lancamentos;
      IF v_cnt_fin_depois <> v_cnt_fin_antes THEN
        RAISE EXCEPTION 'Violação de neutralidade contábil: financeiro_lancamentos alterado por suprimento/sangria (% vs %)', v_cnt_fin_depois, v_cnt_fin_antes;
      END IF;

      -- Rollback limpo
      RAISE EXCEPTION 'PROBE_PR5_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PR5_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PR-6: Sangria rejeita valor superior ao dinheiro físico disponível na gaveta
  process.stdout.write('⏳ PR-6: Sangria rejeita valor superior ao dinheiro físico disponível na gaveta... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_sessao_res JSONB;
      v_sessao_id BIGINT;
      v_mov_res JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      v_sessao_res := public.abrir_sessao_caixa(
        p_fundo_troco := 50.00,
        p_terminal := 'PROBE_PR6_TERM',
        p_observacoes := 'Probe PR-6'
      );
      IF (v_sessao_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao abrir sessão no PR-6: %', v_sessao_res;
      END IF;
      v_sessao_id := (v_sessao_res->>'sessao_id')::bigint;

      -- Tenta sangria de R$ 80 quando há apenas R$ 50 na gaveta
      v_mov_res := public.registrar_movimentacao_caixa(
        p_tipo := 'SANGRIA',
        p_valor := 80.00,
        p_motivo := 'Sangria excessiva teste',
        p_idempotency_key := 'probe-pr6-san-excedente',
        p_sessao_id := v_sessao_id
      );

      IF (v_mov_res->>'success')::boolean IS TRUE THEN
        RAISE EXCEPTION 'Sangria de R$ 80 deveria ter sido rejeitada com saldo de R$ 50!';
      END IF;

      IF (v_mov_res->>'code') <> 'INSUFFICIENT_CASH_IN_DRAWER' THEN
        RAISE EXCEPTION 'Código retornado inesperado: %', v_mov_res->>'code';
      END IF;

      RAISE EXCEPTION 'PROBE_PR6_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PR6_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PR-7: finalizar_venda_pdv bloqueia checkout sem sessão de caixa aberta
  process.stdout.write('⏳ PR-7: finalizar_venda_pdv bloqueia checkout sem sessão de caixa aberta... ');
  await query(`
    DO $$
    DECLARE
      v_oper_uid UUID;
      v_prod_id BIGINT;
      v_res JSONB;
    BEGIN
      -- Utiliza operador sem sessão aberta
      SELECT id INTO v_oper_uid FROM public.profiles WHERE nivel IN ('operador', 'admin') AND ativo = true LIMIT 1;
      SELECT id INTO v_prod_id FROM public.produtos WHERE ativo = true LIMIT 1;

      PERFORM set_config('request.jwt.claim.sub', v_oper_uid::text, true);

      -- Garante que o operador não tenha sessão aberta neste contexto
      DELETE FROM public.caixa_sessoes WHERE operador_auth_id = v_oper_uid AND status = 'ABERTA';

      v_res := public.finalizar_venda_pdv(
        p_itens := jsonb_build_array(jsonb_build_object('produto_id', v_prod_id, 'quantidade', 1)),
        p_cliente_id_rel := NULL::bigint,
        p_forma_pagamento := 'dinheiro'::text,
        p_desconto := 0.00::numeric,
        p_motivo_desconto := NULL::text,
        p_chave_idempotencia := 'probe-pr7-checkout-fail-' || floor(random()*10000)::text,
        p_observacoes := NULL::text
      );

      IF (v_res->>'success')::boolean IS TRUE THEN
        RAISE EXCEPTION 'Venda PDV deveria ter sido bloqueada sem sessão de caixa aberta!';
      END IF;

      IF (v_res->>'code') <> 'CASH_SESSION_REQUIRED' THEN
        RAISE EXCEPTION 'Código retornado inesperado: % (esperado CASH_SESSION_REQUIRED)', v_res->>'code';
      END IF;

      RAISE EXCEPTION 'PROBE_PR7_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PR7_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PR-8: Projeção cega server-side oculta saldo esperado e total dinheiro do operador
  process.stdout.write('⏳ PR-8: Projeção cega server-side oculta saldo esperado e total dinheiro do operador... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_sessao_res JSONB;
      v_sessao_id BIGINT;
      v_cons_res JSONB;
      v_sessao_obj JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      v_sessao_res := public.abrir_sessao_caixa(
        p_fundo_troco := 150.00,
        p_terminal := 'PROBE_PR8_TERM',
        p_observacoes := 'Probe PR-8 Contagem Cega'
      );
      IF (v_sessao_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao abrir sessão no PR-8: %', v_sessao_res;
      END IF;
      v_sessao_id := (v_sessao_res->>'sessao_id')::bigint;

      -- Consulta sessão pelo método do operador
      v_cons_res := public.consultar_sessao_caixa_atual();
      IF (v_cons_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao consultar sessão atual: %', v_cons_res;
      END IF;

      v_sessao_obj := v_cons_res->'sessao';

      -- Valida rigorosamente que dados confidenciais NÃO vazaram
      IF v_sessao_obj ? 'saldo_esperado_dinheiro' OR
         v_sessao_obj ? 'total_dinheiro' OR
         v_sessao_obj ? 'diferenca_caixa' OR
         v_sessao_obj ? 'total_vendas_dinheiro' THEN
        RAISE EXCEPTION 'Vazamento de dados confidenciais na consulta cega do operador: %', v_sessao_obj;
      END IF;

      RAISE EXCEPTION 'PROBE_PR8_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PR8_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PR-9: Exigência de justificativa em divergência e imutabilidade de sessão fechada
  process.stdout.write('⏳ PR-9: Exigência de justificativa em divergência e imutabilidade (SQLSTATE 42501)... ');
  await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_sessao_res JSONB;
      v_sessao_id BIGINT;
      v_fechar_res JSONB;
      v_err_code TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claim.sub', v_admin_uid::text, true);

      v_sessao_res := public.abrir_sessao_caixa(
        p_fundo_troco := 200.00,
        p_terminal := 'PROBE_PR9_TERM',
        p_observacoes := 'Probe PR-9 Divergência'
      );
      IF (v_sessao_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao abrir sessão no PR-9: %', v_sessao_res;
      END IF;
      v_sessao_id := (v_sessao_res->>'sessao_id')::bigint;

      -- 1. Tentativa de fechar com contagem de R$ 180 (diferença de -20.00) SEM justificativa
      v_fechar_res := public.fechar_sessao_caixa(
        p_valor_contado_dinheiro := 180.00,
        p_justificativa := NULL,
        p_observacoes := 'Tentativa sem justificativa',
        p_sessao_id := v_sessao_id
      );

      IF (v_fechar_res->>'success')::boolean IS TRUE THEN
        RAISE EXCEPTION 'Fechamento com quebra de caixa deveria exigir justificativa obrigatória!';
      END IF;

      IF (v_fechar_res->>'code') <> 'DIVERGENCE_JUSTIFICATION_REQUIRED' THEN
        RAISE EXCEPTION 'Código de erro retornado inválido: %', v_fechar_res->>'code';
      END IF;

      -- 2. Fechamento com justificativa válida (>= 5 caracteres)
      v_fechar_res := public.fechar_sessao_caixa(
        p_valor_contado_dinheiro := 180.00,
        p_justificativa := 'Quebra de caixa apurada por divergência de troco',
        p_observacoes := 'Fechamento homologado',
        p_sessao_id := v_sessao_id
      );

      IF (v_fechar_res->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Fechamento válido deveria ter sucesso: %', v_fechar_res;
      END IF;

      -- 3. Testa imutabilidade pós-fechamento (tentativa de UPDATE direto na sessão fechada)
      BEGIN
        UPDATE public.caixa_sessoes
        SET observacoes_fechamento = 'Tentativa maliciosa de mutacao'
        WHERE id = v_sessao_id;
        
        RAISE EXCEPTION 'Mutação em sessão fechada deveria ter sido barrada por trigger 42501!';
      EXCEPTION
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_err_code = RETURNED_SQLSTATE;
          IF v_err_code <> '42501' THEN
            RAISE EXCEPTION 'Trigger disparou com erro diferente de 42501: % (%)', SQLERRM, v_err_code;
          END IF;
      END;

      RAISE EXCEPTION 'PROBE_PR9_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PR9_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PR-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
  process.stdout.write('⏳ PR-10: Grants fail-closed confirmados para anon e PUBLIC... ');
  const pr10Tables = await query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'caixa_sessoes',
        'caixa_sessao_movimentacoes',
        'caixa_sessao_pagamentos',
        'caixa_sessao_auditorias'
      )
      AND grantee IN ('PUBLIC', 'anon');
  `);
  assert.equal(pr10Tables.length, 0, 'Nenhum privilégio de tabela deve ser concedido para anon ou PUBLIC na Frente R');

  const pr10Rpcs = await query(`
    SELECT routine_name, grantee
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'abrir_sessao_caixa',
        'registrar_movimentacao_caixa',
        'consultar_sessao_caixa_atual',
        'obter_resumo_sessao_caixa_admin',
        'fechar_sessao_caixa',
        'auditar_sessao_caixa_admin',
        'listar_sessoes_caixa_admin'
      )
      AND grantee IN ('PUBLIC', 'anon');
  `);
  assert.equal(pr10Rpcs.length, 0, 'Nenhum grant de RPC deve permanecer para anon ou PUBLIC na Frente R');
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('🎉 10/10 PROBES DE PRODUÇÃO DA FRENTE R APROVADOS COM SUCESSO!');
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ FALHA NO PROBE DE PRODUÇÃO DA FRENTE R:', err);
  process.exit(1);
});
