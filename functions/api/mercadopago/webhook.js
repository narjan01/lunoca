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
      return new Response(JSON.stringify({ error: 'paymentId inválido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (topic && topic !== 'payment') {
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const webhookSecret = env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (webhookSecret) {
      const isValidSignature = await isWebhookSignatureValid({
        request,
        bodyRaw,
        paymentId,
        secret: webhookSecret,
      });

      if (!isValidSignature) {
        return new Response(JSON.stringify({ error: 'Assinatura inválida.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else {
      console.warn('[Webhook] MERCADO_PAGO_WEBHOOK_SECRET não configurado. Validação HMAC em modo de transição.');
    }

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
    const payment = await payRes.json();

    if (payment.status === 'approved' && payment.external_reference) {
      const orderId = payment.external_reference;

      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

      if (supabaseUrl && supabaseKey) {
        try {
          // Invoca a RPC atômica que confirma pedido, baixa estoque de todos os itens e credita no financeiro
          const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
            method: 'POST',
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              p_pedido_id: Number(orderId),
              p_mercado_pago_payment_id: String(paymentId),
              p_status: payment.status,
              p_forma_pagamento: payment.payment_method_id || 'pix',
              p_valor: Number(payment.transaction_amount || 0)
            }),
          });

          if (!rpcRes.ok) {
            // Fallback para patch direto em caso de indisponibilidade da RPC
            await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${orderId}`, {
              method: 'PATCH',
              headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({
                status: 'Confirmado',
                mercado_pago_id: String(paymentId),
                mercado_pago_status: payment.status,
              }),
            });
          }
        } catch (rpcErr) {
          console.error('[Webhook] Erro ao invocar confirmar_pagamento_pedido:', rpcErr.message);
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
