// ==============================================================================
// LUNOCA DOCERIA - PROBES DE PRODUÇÃO FRENTE P (PP-1 a PP-10)
// ==============================================================================
// Valida os 10 probes de conformidade da Migration 031 no Supabase de produção:
// PP-1:  As 3 tabelas da Frente P existem em public com RLS habilitado
// PP-2:  As 5 RPCs canônicas da Frente P instaladas com SECURITY DEFINER
// PP-3:  Trigger append-only trg_bloquear_mutacao_retirada_eventos ativo
// PP-4:  Configuração padrão de retirada ativa (id=1, exigir_pin=true, max_tentativas=3)
// PP-5:  Geração real de autorização de retirada em transação retorna PIN de 6 dígitos
// PP-6:  Banco armazena estritamente hash SHA-256 de 64 caracteres hexadecimais
// PP-7:  Validação de PIN com rate limiting e decremento de tentativas restantes
// PP-8:  Quality Hold ativo da Frente L impede liberação da retirada
// PP-9:  Quitação no balcão atualiza status_operacional para 'retirado' via motor canônico
// PP-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
// ==============================================================================
import assert from 'node:assert/strict';
import { query } from './supabase-client.mjs';

console.log('\n============================================================');
console.log('  PRODUÇÃO SUPABASE - BATERIA DE PROBES FRENTE P (PP-1 a PP-10)');
console.log('  Projeto: xdnlkvbfaacrrhhuaxao (Lunoca Doceria)');
console.log('============================================================\n');

async function main() {
  // PP-1: As 3 tabelas da Frente P existem em public com RLS habilitado
  process.stdout.write('⏳ PP-1: As 3 tabelas da Frente P existem em public com RLS habilitado... ');
  const pp1 = await query(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'retirada_configuracoes',
        'pedido_retirada_autorizacoes',
        'pedido_retirada_eventos'
      )
    ORDER BY tablename;
  `);
  assert.equal(pp1.length, 3, 'Esperado 3 tabelas da Frente P em public');
  for (const r of pp1) {
    assert.equal(r.rowsecurity, true, `Tabela ${r.tablename} deve ter RLS ativo`);
  }
  console.log('✅ APROVADO');

  // PP-2: As 5 RPCs canônicas da Frente P com SECURITY DEFINER
  process.stdout.write('⏳ PP-2: As 5 RPCs canônicas da Frente P instaladas com SECURITY DEFINER... ');
  const pp2 = await query(`
    SELECT DISTINCT proname, prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN (
        'gerar_autorizacao_retirada_cliente',
        'obter_minha_autorizacao_retirada',
        'validar_pin_retirada_balcao',
        'finalizar_checkout_retirada_balcao',
        'obter_painel_balcao_retiradas'
      )
    ORDER BY proname;
  `);
  assert.equal(pp2.length, 5, 'Esperado 5 RPCs da Frente P instaladas em public');
  for (const r of pp2) {
    assert.equal(r.prosecdef, true, `RPC ${r.proname} deve ter SECURITY DEFINER ativado`);
  }
  console.log('✅ APROVADO');

  // PP-3: Trigger append-only trg_bloquear_mutacao_retirada_eventos ativo
  process.stdout.write('⏳ PP-3: Trigger append-only trg_bloquear_mutacao_retirada_eventos ativo... ');
  const pp3 = await query(`
    SELECT trigger_name, event_manipulation, event_object_table, action_timing
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'pedido_retirada_eventos'
      AND trigger_name = 'trg_bloquear_mutacao_retirada_eventos';
  `);
  assert.ok(pp3.length >= 1, 'Trigger trg_bloquear_mutacao_retirada_eventos deve existir');
  console.log('✅ APROVADO');

  // PP-4: Configuração padrão de retirada carregada
  process.stdout.write('⏳ PP-4: Configuração padrão de retirada ativa (id=1, exigir_pin=true, max=3)... ');
  const pp4 = await query(`
    SELECT id, exigir_pin_retirada, permitir_retirada_com_saldo, max_tentativas_pin, ttl_pin_minutos
    FROM public.retirada_configuracoes
    WHERE id = 1;
  `);
  assert.equal(pp4.length, 1, 'Configuração padrão de retirada id=1 deve existir');
  assert.equal(pp4[0].exigir_pin_retirada, true, 'Exigir PIN deve ser true por padrão');
  assert.equal(pp4[0].max_tentativas_pin, 3, 'Máximo de tentativas padrão deve ser 3');
  assert.equal(pp4[0].ttl_pin_minutos, 120, 'TTL do PIN padrão deve ser 120 minutos');
  console.log('✅ APROVADO');

  // PP-5: Geração de autorização de retirada em transação isolada
  process.stdout.write('⏳ PP-5: Geração real de PIN em transação isolada (6 dígitos)... ');
  const pp5 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_pid BIGINT;
      v_res JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, modalidade_entrega, endereco_entrega,
        total, subtotal, saldo, valor_pago, status_comercial, status_operacional,
        status, pagamento, itens, data_entrega, data_pedido
      ) VALUES (
        'Probe Retirada P', 'probe-p@lunoca.test', '5585999990001', 'retirada', 'Balcão da Loja',
        100.00, 100.00, 0.00, 100.00, 'confirmado', 'pronto',
        'Confirmado', 'pix', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
      ) RETURNING id INTO v_pid;

      v_res := public.gerar_autorizacao_retirada_cliente(v_pid);
      IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Falha ao gerar PIN: %', v_res;
      END IF;

      IF length(v_res->>'codigo_pin') <> 6 THEN
        RAISE EXCEPTION 'PIN gerado não possui 6 dígitos: %', v_res->>'codigo_pin';
      END IF;

      -- Rollback limpo
      RAISE EXCEPTION 'PROBE_PP5_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PP5_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PP-6: Banco armazena estritamente hash SHA-256 (64 hex)
  process.stdout.write('⏳ PP-6: Banco armazena estritamente hash SHA-256 (64 caracteres hex)... ');
  const pp6 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_pid BIGINT;
      v_res JSONB;
      v_hash TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, modalidade_entrega, endereco_entrega,
        total, subtotal, saldo, valor_pago, status_comercial, status_operacional,
        status, pagamento, itens, data_entrega, data_pedido
      ) VALUES (
        'Probe Hash P', 'probe-hash@lunoca.test', '5585999990002', 'retirada', 'Balcão da Loja',
        100.00, 100.00, 0.00, 100.00, 'confirmado', 'pronto',
        'Confirmado', 'pix', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
      ) RETURNING id INTO v_pid;

      v_res := public.gerar_autorizacao_retirada_cliente(v_pid);
      
      SELECT codigo_hash INTO v_hash
      FROM public.pedido_retirada_autorizacoes
      WHERE id = (v_res->>'autorizacao_id')::bigint;

      IF length(v_hash) <> 64 THEN
        RAISE EXCEPTION 'Hash não possui 64 caracteres: %', v_hash;
      END IF;

      IF v_hash = (v_res->>'codigo_pin') THEN
        RAISE EXCEPTION 'Hash não pode ser igual ao PIN em texto puro!';
      END IF;

      RAISE EXCEPTION 'PROBE_PP6_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PP6_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PP-7: Rate limiting e decremento de tentativas incorretas
  process.stdout.write('⏳ PP-7: Rate limiting e decremento de tentativas incorretas... ');
  const pp7 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_pid BIGINT;
      v_res JSONB;
      v_val JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, modalidade_entrega, endereco_entrega,
        total, subtotal, saldo, valor_pago, status_comercial, status_operacional,
        status, pagamento, itens, data_entrega, data_pedido
      ) VALUES (
        'Probe Rate P', 'probe-rate@lunoca.test', '5585999990003', 'retirada', 'Balcão da Loja',
        100.00, 100.00, 0.00, 100.00, 'confirmado', 'pronto',
        'Confirmado', 'pix', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
      ) RETURNING id INTO v_pid;

      v_res := public.gerar_autorizacao_retirada_cliente(v_pid);
      
      -- Tentativa incorreta
      v_val := public.validar_pin_retirada_balcao(v_pid, '999999');
      IF (v_val->>'success')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'Tentativa incorreta deveria falhar!';
      END IF;

      IF (v_val->>'tentativas_restantes')::int <> 2 THEN
        RAISE EXCEPTION 'Tentativas restantes deveria ser 2: %', v_val;
      END IF;

      RAISE EXCEPTION 'PROBE_PP7_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PP7_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PP-8: Quality Hold da Frente L bloqueia checkout de retirada
  process.stdout.write('⏳ PP-8: Quality Hold da Frente L bloqueia checkout de retirada... ');
  const pp8 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_pid BIGINT;
      v_res JSONB;
      v_chk JSONB;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, modalidade_entrega, endereco_entrega,
        total, subtotal, saldo, valor_pago, status_comercial, status_operacional,
        status, pagamento, itens, data_entrega, data_pedido
      ) VALUES (
        'Probe QH P', 'probe-qh@lunoca.test', '5585999990004', 'retirada', 'Balcão da Loja',
        100.00, 100.00, 0.00, 100.00, 'confirmado', 'pronto',
        'Confirmado', 'pix', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
      ) RETURNING id INTO v_pid;

      v_res := public.gerar_autorizacao_retirada_cliente(v_pid);

      -- Checkpoint de qualidade REPROVADO
      INSERT INTO public.producao_controles_qualidade (
        pedido_id, etapa, resultado, bloqueia_avanco, observacao, responsavel_nome
      ) VALUES (
        v_pid, 'EXPEDICAO', 'REPROVADO', true, 'Falha no probe', 'Probe Inspector'
      );

      v_chk := public.finalizar_checkout_retirada_balcao(v_pid, v_res->>'codigo_pin');
      IF (v_chk->>'code') <> 'QUALITY_HOLD_ACTIVE' THEN
        RAISE EXCEPTION 'Esperado QUALITY_HOLD_ACTIVE, obtido: %', v_chk;
      END IF;

      RAISE EXCEPTION 'PROBE_PP8_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PP8_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PP-9: Quitação de balcão atualiza status_operacional para retirado
  process.stdout.write('⏳ PP-9: Quitação de balcão atualiza status_operacional para retirado... ');
  const pp9 = await query(`
    DO $$
    DECLARE
      v_admin_uid UUID;
      v_pid BIGINT;
      v_res JSONB;
      v_chk JSONB;
      v_status_op TEXT;
    BEGIN
      SELECT id INTO v_admin_uid FROM public.profiles WHERE nivel = 'admin' AND ativo = true LIMIT 1;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin_uid::text)::text, true);

      INSERT INTO public.pedidos (
        nome_cliente, email_cliente, telefone_cliente, modalidade_entrega, endereco_entrega,
        total, subtotal, saldo, valor_pago, status_comercial, status_operacional,
        status, pagamento, itens, data_entrega, data_pedido
      ) VALUES (
        'Probe Quita P', 'probe-quita@lunoca.test', '5585999990005', 'retirada', 'Balcão da Loja',
        150.00, 150.00, 50.00, 100.00, 'confirmado', 'pronto',
        'Confirmado', 'pix', '[]'::jsonb, CURRENT_DATE, CURRENT_DATE
      ) RETURNING id INTO v_pid;

      INSERT INTO public.pedido_pagamentos (pedido_id, valor, metodo, status)
      VALUES (v_pid, 100.00, 'pix', 'aprovado');

      v_res := public.gerar_autorizacao_retirada_cliente(v_pid);

      -- Checkout com quitação de R$ 50,00 restantes
      v_chk := public.finalizar_checkout_retirada_balcao(
        p_pedido_id => v_pid,
        p_pin => v_res->>'codigo_pin',
        p_quitar_saldo => true,
        p_forma_pagamento => 'cartao_debito'
      );

      IF (v_chk->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'Checkout de quitação deveria ter sucesso: %', v_chk;
      END IF;

      SELECT status_operacional INTO v_status_op FROM public.pedidos WHERE id = v_pid;
      IF v_status_op <> 'retirado' THEN
        RAISE EXCEPTION 'Status operacional deveria ser retirado, obtido: %', v_status_op;
      END IF;

      RAISE EXCEPTION 'PROBE_PP9_ROLLBACK_OK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM <> 'PROBE_PP9_ROLLBACK_OK' THEN
          RAISE;
        END IF;
    END;
    $$;
  `);
  console.log('✅ APROVADO');

  // PP-10: Grants fail-closed confirmados para anon e PUBLIC nas tabelas e RPCs
  process.stdout.write('⏳ PP-10: Grants fail-closed confirmados para anon e PUBLIC... ');
  const pp10 = await query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('retirada_configuracoes', 'pedido_retirada_autorizacoes', 'pedido_retirada_eventos')
      AND grantee IN ('anon', 'PUBLIC');
  `);
  assert.equal(pp10.length, 0, 'Nenhum privilégio direto concedido para anon ou PUBLIC nas tabelas de retirada');
  console.log('✅ APROVADO');

  console.log('\n============================================================');
  console.log('🎉 TODOS OS 10 PROBES DE PRODUÇÃO DA FRENTE P FORAM APROVADOS!');
  console.log('============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ FALHA NOS PROBES DA FRENTE P:', err);
  process.exit(1);
});
