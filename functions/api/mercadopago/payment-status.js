// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Consulta de Status
// Permite checar em tempo real se o PIX foi pago pelo cliente.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const url = new URL(request.url);
    const paymentId = url.searchParams.get('id');
    const customToken = url.searchParams.get('token');

    const token = env.MERCADO_PAGO_ACCESS_TOKEN || customToken;
    if (!token) {
      return new Response(JSON.stringify({ error: 'MERCADO_PAGO_ACCESS_TOKEN não disponível.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (!paymentId) {
      return new Response(JSON.stringify({ error: 'ID do pagamento não informado.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

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

    return new Response(JSON.stringify({
      success: true,
      id: data.id,
      status: data.status, // approved, pending, in_process, rejected
      statusDetail: data.status_detail,
      amount: data.transaction_amount,
      orderId: data.external_reference
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
