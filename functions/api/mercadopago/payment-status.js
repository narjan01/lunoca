// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Consulta de Status
// Permite checar em tempo real se o PIX foi pago pelo cliente.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const url = new URL(request.url);
    const paymentId = url.searchParams.get('id');
    const token = env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'MERCADO_PAGO_ACCESS_TOKEN não disponível.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (!paymentId || !/^\d+$/.test(paymentId)) {
      return new Response(JSON.stringify({ error: 'ID do pagamento não informado ou inválido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Consulta detalhes do pagamento na API oficial do Mercado Pago
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await mpRes.json();
    if (!mpRes.ok) {
      return new Response(JSON.stringify({ error: data.message || 'Erro ao consultar status no Mercado Pago' }), {
        status: mpRes.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const orderId = data.external_reference;

    // Se o cliente enviar token de autenticação, validar titularidade do pedido
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ') && orderId) {
      const authCheck = await verifyAuth(request, env);
      if (authCheck.authorized && authCheck.user) {
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
        if (supabaseUrl && supabaseKey) {
          const pedRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${orderId}&select=cliente_id`, {
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`
            }
          });
          const pedData = await pedRes.json();
          if (Array.isArray(pedData) && pedData.length > 0) {
            const donoId = pedData[0].cliente_id;
            const u = authCheck.user;
            if (donoId && u.id !== donoId && u.nivel !== 'admin' && u.nivel !== 'operador') {
              return new Response(JSON.stringify({ error: 'Acesso negado aos dados deste pagamento.' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
          }
        }
      }
    }

    // Se aprovado, sincronizar com o banco via RPC atômica confirmar_pagamento_pedido
    if (data.status === 'approved' && orderId) {
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
      if (supabaseUrl && supabaseKey) {
        fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            p_pedido_id: Number(orderId),
            p_mercado_pago_payment_id: String(data.id),
            p_status: data.status,
            p_forma_pagamento: data.payment_method_id || 'pix',
            p_valor: Number(data.transaction_amount || 0)
          })
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify({
      success: true,
      id: data.id,
      status: data.status, // approved, pending, in_process, rejected
      statusDetail: data.status_detail,
      amount: data.transaction_amount,
      orderId: orderId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (err) {
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
