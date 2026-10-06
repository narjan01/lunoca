import { getCorsHeaders, handleCorsOptions } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

function getSafeBaseUrl(origin, env) {
  const allowedHostnames = ['lunocadoceria.com.br', 'www.lunocadoceria.com.br', 'localhost', '127.0.0.1'];
  if (origin) {
    try {
      const u = new URL(origin);
      if (allowedHostnames.includes(u.hostname) || u.hostname.endsWith('.pages.dev')) {
        return u.origin;
      }
    } catch (_) {}
  }
  return env.APP_BASE_URL || 'https://lunocadoceria.com.br';
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const body = await request.json();
    const token = env.MERCADO_PAGO_ACCESS_TOKEN;

    if (!token) {
      return new Response(JSON.stringify({
        error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado no Cloudflare Pages ou nas configurações do Lunoca.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const { pedidoId, items, total, cliente, forma, origin } = body;
    const baseUrl = getSafeBaseUrl(origin, env);

    // Validação de titularidade e busca de dados confiáveis no Supabase
    let safeItems = items;
    let safeTotal = total;

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseKey && pedidoId) {
      const pedRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${pedidoId}&select=id,total,itens,cliente_id,status`, {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      });
      const pedData = await pedRes.json();
      if (Array.isArray(pedData) && pedData.length > 0) {
        const ped = pedData[0];
        // Checar autorização se token Bearer estiver presente
        const authHeader = request.headers.get('Authorization') || '';
        if (authHeader.startsWith('Bearer ')) {
          const authCheck = await verifyAuth(request, env);
          if (authCheck.authorized && authCheck.user) {
            const u = authCheck.user;
            if (ped.cliente_id && u.id !== ped.cliente_id && u.nivel !== 'admin' && u.nivel !== 'operador') {
              return new Response(JSON.stringify({ error: 'Acesso negado a este pedido.' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
              });
            }
          }
        }

        // Usar total do banco
        safeTotal = parseFloat(ped.total);
        if (ped.itens && Array.isArray(ped.itens) && ped.itens.length > 0) {
          safeItems = ped.itens;
        }
      }
    }

    // Montar preferência de checkout no Mercado Pago
    const preferencePayload = {
      items: (safeItems && safeItems.length > 0) ? safeItems.map((it, idx) => ({
        id: String(it.id || idx + 1),
        title: String(it.nome || 'Doce Artesanal Lunoca'),
        quantity: parseInt(it.quantidade || 1, 10),
        currency_id: 'BRL',
        unit_price: parseFloat(it.preco_unitario || it.preco || (safeTotal / (safeItems.length || 1)))
      })) : [
        {
          id: String(pedidoId || '1'),
          title: `Pedido Lunoca Doceria #${pedidoId || ''}`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: parseFloat(safeTotal)
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
