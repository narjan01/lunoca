// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Confirmação Administrativa de Pagamento
// Permite que apenas administradores autenticados confirmem pagamentos manualmente.
// A execução é protegida via service_role após validação rigorosa do token do admin.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../../_cors.js';
import { verifyAuth } from '../../_auth.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestPost(context) {
  return handlePaymentConfirmation(context);
}

export async function onRequestPatch(context) {
  return handlePaymentConfirmation(context);
}

async function handlePaymentConfirmation(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  try {
    // 1. Validação estrita de autorização: apenas administradores ativos
    const authCheck = await verifyAuth(request, env, ['admin']);
    if (!authCheck.authorized) {
      return new Response(JSON.stringify({ error: authCheck.error }), {
        status: authCheck.status || 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 2. Validação da chave do Supabase (Fail-Closed)
    const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceKey) {
      console.error('[Admin Orders Payment] SUPABASE_SERVICE_ROLE_KEY ausente.');
      return new Response(JSON.stringify({
        error: 'Configuração crítica do servidor ausente (SUPABASE_SERVICE_ROLE_KEY).'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 3. Leitura e validação dos parâmetros do corpo da requisição
    const body = await request.json();
    const pedidoId = body.pedidoId || body.id;

    if (!pedidoId || isNaN(Number(pedidoId))) {
      return new Response(JSON.stringify({ error: 'ID do pedido obrigatório e deve ser numérico.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const paymentId = body.paymentId ? String(body.paymentId) : 'admin_manual';
    const status = body.status || 'approved';
    const formaPagamento = body.formaPagamento || 'admin_manual';
    const valor = body.valor ? Number(body.valor) : null;
    const adminEmail = authCheck.user?.email || 'admin@lunocadoceria.com.br';

    // 4. Invocação atômica da RPC confirmar_pagamento_pedido usando service_role
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_pedido_id: Number(pedidoId),
        p_mercado_pago_payment_id: paymentId,
        p_status: status,
        p_forma_pagamento: formaPagamento,
        p_valor: valor,
        p_origem: `Admin Manual (${adminEmail})`
      })
    });

    const rpcData = await rpcRes.json();

    if (!rpcRes.ok) {
      console.error('[Admin Orders Payment] Falha na RPC confirmar_pagamento_pedido:', rpcData);
      return new Response(JSON.stringify({
        error: rpcData.message || rpcData.error || 'Erro ao confirmar pagamento no banco de dados.',
        details: rpcData
      }), {
        status: rpcRes.status || 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Pagamento confirmado com sucesso e estoque atualizado atomicamente.',
      data: rpcData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    console.error('[Admin Orders Payment] Erro interno:', err);
    return new Response(JSON.stringify({ error: 'Erro interno ao processar confirmação de pagamento: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
