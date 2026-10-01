import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);

    const token = env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado no ambiente.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const res = await fetch('https://api.mercadopago.com/users/me', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await res.json();

    if (!res.ok || !data?.id) {
      return new Response(JSON.stringify({
        success: false,
        error: data?.message || 'Falha ao validar credencial no Mercado Pago.'
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      account: {
        id: data.id,
        nickname: data.nickname || data.first_name || 'Vendedor Mercado Pago',
        email: data.email || null,
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (err) {
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({ success: false, error: err.message || 'Erro interno.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
