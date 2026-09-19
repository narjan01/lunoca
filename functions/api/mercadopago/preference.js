import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const body = await request.json();
    const token = env.MERCADO_PAGO_ACCESS_TOKEN || body.customAccessToken;

    if (!token) {
      return new Response(JSON.stringify({
        error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado no Cloudflare Pages ou nas configurações do Lunoca.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const { pedidoId, items, total, cliente, forma, origin } = body;
    const baseUrl = origin || 'https://lunocadoceria.com.br';

    // Montar preferência de checkout no Mercado Pago
    const preferencePayload = {
      items: (items && items.length > 0) ? items.map((it, idx) => ({
        id: String(it.id || idx + 1),
        title: String(it.nome || 'Doce Artesanal Lunoca'),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: parseFloat(it.preco)
      })) : [
        {
          id: String(pedidoId || '1'),
          title: `Pedido Lunoca Doceria #${pedidoId || ''}`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: parseFloat(total)
        }
      ],
      payer: {
        name: cliente?.nome || 'Cliente Lunoca',
        email: cliente?.email || 'cliente@lunocadoceria.com.br'
      },
      payment_methods: {
        excluded_payment_types: forma === 'pix' ? [
          { id: 'ticket' },
          { id: 'credit_card' },
          { id: 'debit_card' }
        ] : (forma === 'cartao' ? [
          { id: 'ticket' }
        ] : [])
      },
      back_urls: {
        success: `${baseUrl}?payment=success&order_id=${pedidoId}`,
        failure: `${baseUrl}?payment=failure&order_id=${pedidoId}`,
        pending: `${baseUrl}?payment=pending&order_id=${pedidoId}`
      },
      auto_return: 'approved',
      external_reference: String(pedidoId),
      statement_descriptor: 'LUNOCA DOCERIA',
      notification_url: `${baseUrl}/api/mercadopago/webhook`
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferencePayload)
    });

    const mpData = await mpRes.json();

    if (!mpRes.ok) {
      return new Response(JSON.stringify({
        error: mpData.message || 'Erro ao criar preferência no Mercado Pago',
        details: mpData
      }), {
        status: mpRes.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      preferenceId: mpData.id,
      initPoint: mpData.init_point,
      sandboxInitPoint: mpData.sandbox_init_point
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
