import { getCorsHeaders, handleCorsOptions } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

function getSafeBaseUrl(origin, env) {
  const allowedHostnames = ['lunocadoceria.com.br', 'www.lunocadoceria.com.br', 'localhost', '127.0.0.1'];
  if (env.APP_BASE_URL) {
    try {
      const appUrl = new URL(env.APP_BASE_URL);
      if (!allowedHostnames.includes(appUrl.hostname)) {
        allowedHostnames.push(appUrl.hostname);
      }
    } catch (_) {}
  }
  if (origin) {
    try {
      const u = new URL(origin);
      if (allowedHostnames.includes(u.hostname)) {
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

    const { pedidoId, cliente, forma, origin } = body;
    const baseUrl = getSafeBaseUrl(origin, env);

    if (!pedidoId) {
      return new Response(JSON.stringify({ error: 'ID do pedido é obrigatório para gerar a preferência.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: 'Configuração do banco de dados não disponível.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const pedRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${pedidoId}&select=id,total,taxa_entrega,itens_json,cliente_id,status,checkout_token`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    });

    if (!pedRes.ok) {
      return new Response(JSON.stringify({ error: 'Falha ao buscar dados do pedido no servidor.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const pedData = await pedRes.json();
    if (!Array.isArray(pedData) || pedData.length === 0) {
      return new Response(JSON.stringify({ error: `Pedido #${pedidoId} não encontrado.` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const ped = pedData[0];

    // Validação estrita de autorização
    let isAuthorized = false;
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const authCheck = await verifyAuth(request, env);
      if (authCheck.authorized && authCheck.user) {
        const u = authCheck.user;
        if (u.nivel === 'admin' || u.nivel === 'operador' || (ped.cliente_id && u.id === ped.cliente_id)) {
          isAuthorized = true;
        } else if (ped.cliente_id && u.id !== ped.cliente_id) {
          return new Response(JSON.stringify({ error: 'Acesso negado a este pedido.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }
    }

    const headerToken = request.headers.get('X-Checkout-Token') || '';
    const bodyToken = body.checkoutToken || body.checkout_token || '';
    const clientToken = (headerToken || bodyToken).trim();

    if (!isAuthorized && clientToken && ped.checkout_token && clientToken === ped.checkout_token) {
      isAuthorized = true;
    }

    if (ped.checkout_token && !isAuthorized) {
      return new Response(JSON.stringify({ error: 'Acesso não autorizado a este pedido (checkout_token inválido ou ausente).' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Usar dados 100% autoritativos do banco de dados (sem fallback inseguro do cliente)
    const safeTotal = parseFloat(ped.total);
    const taxaEntrega = parseFloat(ped.taxa_entrega || 0);
    let preferenceItems = [];

    if (Array.isArray(ped.itens_json) && ped.itens_json.length > 0) {
      preferenceItems = ped.itens_json.map((it, idx) => ({
        id: String(it.id || idx + 1),
        title: String(it.nome || 'Doce Artesanal Lunoca'),
        quantity: parseInt(it.quantidade || 1, 10),
        currency_id: 'BRL',
        unit_price: parseFloat(it.preco_unitario || it.preco || 0)
      }));

      if (taxaEntrega > 0) {
        preferenceItems.push({
          id: 'taxa_entrega',
          title: 'Taxa de Entrega',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: taxaEntrega
        });
      }
    } else {
      preferenceItems = [
        {
          id: String(ped.id),
          title: `Pedido Lunoca Doceria #${ped.id}`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: safeTotal
        }
      ];
    }

    const preferencePayload = {
      items: preferenceItems,
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
