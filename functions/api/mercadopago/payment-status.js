// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Consulta de Status
// Permite checar em tempo real se o PIX foi pago pelo cliente.
// Sincronização atômica devidamente aguardada via await com service_role.
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
        status: 500,
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

    // Validação de titularidade e isolamento multi-tenant do pedido
    if (orderId) {
      const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && serviceKey) {
        const pedRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${orderId}&select=id,cliente_id,checkout_token`, {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`
          }
        });
        const pedData = await pedRes.json();
        if (Array.isArray(pedData) && pedData.length > 0) {
          const ped = pedData[0];
          let isAuthorized = false;

          // 1. Validação via JWT (Usuário autenticado)
          const authHeader = request.headers.get('Authorization') || '';
          if (authHeader.startsWith('Bearer ')) {
            const authCheck = await verifyAuth(request, env);
            if (authCheck.authorized && authCheck.user) {
              const u = authCheck.user;
              if (u.nivel === 'admin' || u.nivel === 'operador' || (ped.cliente_id && u.id === ped.cliente_id)) {
                isAuthorized = true;
              } else if (ped.cliente_id && u.id !== ped.cliente_id) {
                return new Response(JSON.stringify({ error: 'Acesso negado aos dados deste pagamento.' }), {
                  status: 403,
                  headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
              }
            }
          }

          // 2. Validação via checkout_token (Guest Checkout)
          const headerToken = request.headers.get('X-Checkout-Token') || '';
          const queryToken = url.searchParams.get('checkout_token') || '';
          const clientToken = (headerToken || queryToken).trim();

          if (!isAuthorized && clientToken && ped.checkout_token && clientToken === ped.checkout_token) {
            isAuthorized = true;
          }

          // Bloqueio estrito se o pedido tiver proteção por token e o chamador não comprovar titularidade
          if (ped.checkout_token && !isAuthorized) {
            return new Response(JSON.stringify({ error: 'Acesso não autorizado aos dados deste pagamento (checkout_token inválido ou ausente).' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        }
      }
    }

    // Se aprovado, sincronizar com o banco via RPC atômica confirmar_pagamento_pedido (aguardada via await)
    if (data.status === 'approved' && orderId) {
      const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

      if (supabaseUrl && serviceKey) {
        try {
          const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
            method: 'POST',
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              p_pedido_id: Number(orderId),
              p_mercado_pago_payment_id: String(data.id),
              p_status: data.status,
              p_forma_pagamento: data.payment_method_id || 'pix',
              p_valor: Number(data.transaction_amount || 0),
              p_origem: 'Consulta Status Cliente'
            })
          });

          if (!rpcRes.ok) {
            const rpcErr = await rpcRes.text();
            console.error('[PaymentStatus] Erro na RPC confirmar_pagamento_pedido:', rpcErr);
          }
        } catch (syncErr) {
          console.error('[PaymentStatus] Falha ao invocar confirmação atômica:', syncErr.message);
        }
      }
    } else if ((data.status === 'cancelled' || data.status === 'expired') && orderId) {
      // Se cancelado ou expirado no gateway, libera as reservas do pedido
      const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && serviceKey) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/rpc/liberar_pedidos_expirados`, {
            method: 'POST',
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
          });
        } catch (_) {}
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
