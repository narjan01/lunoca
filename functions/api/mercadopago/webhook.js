// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Webhook Mercado Pago
// Notificação assíncrona de status de pagamento (PIX e Cartão).
// Validação HMAC x-signature estrita, RPC atômica via service_role e sem fallback.
// ==========================================================================

function parseSignatureHeader(signatureHeader) {
  const parts = String(signatureHeader || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const values = {};
  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    values[key.trim()] = rest.join('=').trim();
  }

  return {
    ts: values.ts || '',
    v1: values.v1 || '',
  };
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function hmacSha256Hex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const bytes = Array.from(new Uint8Array(sig));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function isWebhookSignatureValid({ request, bodyRaw, paymentId, secret }) {
  const signatureHeader = request.headers.get('x-signature');
  const requestId = request.headers.get('x-request-id') || '';

  if (!signatureHeader) return false;

  const { ts, v1 } = parseSignatureHeader(signatureHeader);
  if (!ts || !v1) return false;

  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const fallbackPayload = `${ts}.${bodyRaw}`;

  const [calcManifest, calcFallback] = await Promise.all([
    hmacSha256Hex(secret, manifest),
    hmacSha256Hex(secret, fallbackPayload),
  ]);

  return constantTimeEqual(v1, calcManifest) || constantTimeEqual(v1, calcFallback);
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const bodyRaw = await request.text();
    let body = {};
    try {
      body = JSON.parse(bodyRaw || '{}');
    } catch (_) {}

    const url = new URL(request.url);
    const paymentId = String(url.searchParams.get('data.id') || body?.data?.id || body?.id || '');
    const topic = url.searchParams.get('type') || body?.type || body?.topic;

    if (!paymentId || !/^\d+$/.test(paymentId)) {
      return new Response(JSON.stringify({ error: 'paymentId ausente ou inválido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Ignora eventos que não sejam de pagamento (ex: merchant_order)
    if (topic && topic !== 'payment') {
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Validação Criptográfica HMAC da Assinatura (Fail-Closed)
    const webhookSecret = env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Webhook] Falha de Configuração: MERCADO_PAGO_WEBHOOK_SECRET ausente.');
      return new Response(JSON.stringify({
        error: 'Configuração do webhook ausente no servidor (MERCADO_PAGO_WEBHOOK_SECRET).'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isValidSignature = await isWebhookSignatureValid({
      request,
      bodyRaw,
      paymentId,
      secret: webhookSecret,
    });

    if (!isValidSignature) {
      console.warn('[Webhook] Assinatura HMAC rejeitada para paymentId:', paymentId);
      return new Response(JSON.stringify({ error: 'Assinatura inválida.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Consulta detalhes oficiais do pagamento na API do Mercado Pago
    const token = env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'MERCADO_PAGO_ACCESS_TOKEN ausente.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!payRes.ok) {
      console.error(`[Webhook] Erro ao consultar pagamento #${paymentId} no Mercado Pago: HTTP ${payRes.status}`);
      return new Response(JSON.stringify({ error: 'Erro ao consultar pagamento na API do provedor.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const payment = await payRes.json();

    // 3. Se aprovado ou estornado/contestado, executa processamento atômico no Supabase
    if (['approved', 'refunded', 'charged_back'].includes(payment.status) && payment.external_reference) {
      const orderId = payment.external_reference;
      const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

      if (!serviceKey) {
        console.error('[Webhook] Falha Crítica: SUPABASE_SERVICE_ROLE_KEY ausente.');
        return new Response(JSON.stringify({
          error: 'Configuração do banco de dados ausente (SUPABASE_SERVICE_ROLE_KEY).'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Invoca a RPC atômica que confirma pedido (approved) ou estorna pagamento (refunded / charged_back)
      const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_pedido_id: Number(orderId),
          p_mercado_pago_payment_id: String(paymentId),
          p_status: payment.status,
          p_forma_pagamento: payment.payment_method_id || 'pix',
          p_valor: Number(payment.transaction_amount || 0),
          p_origem: 'Mercado Pago Webhook'
        }),
      });

      if (!rpcRes.ok) {
        const errDetails = await rpcRes.text();
        console.error(`[Webhook] Falha na RPC confirmar_pagamento_pedido para Pedido #${orderId} (status: ${payment.status}):`, errDetails);
        // Retorna HTTP 500 para que o Mercado Pago faça retry com backoff exponencial
        return new Response(JSON.stringify({
          error: 'Erro no processamento da transação atômica.',
          details: errDetails
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const rpcResult = await rpcRes.json();
      console.log(`[Webhook] Pedido #${orderId} processado atomicamente (${payment.status}):`, rpcResult);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[Webhook Error]:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
