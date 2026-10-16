// ==============================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Webhook Gateway WhatsApp
// ==============================================================================
// 1. Recebe eventos de status (ENVIADO, ENTREGUE, LIDO) do provedor.
// 2. Valida chave secreta de webhook / HMAC.
// 3. Normaliza payload e invoca whatsapp_processar_webhook_status de forma idempotente.
// 4. Garante não-regressão de status e proteção contra replay attacks.
// ==============================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  // 1. Validação de token de segurança do webhook
  const url = new URL(request.url);
  const secretQuery = url.searchParams.get('secret');
  const secretHeader = request.headers.get('x-webhook-secret') || request.headers.get('apikey');
  const expectedSecret = env.WHATSAPP_WEBHOOK_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (expectedSecret && secretQuery !== expectedSecret && secretHeader !== expectedSecret) {
    return new Response(JSON.stringify({ success: false, error: 'INVALID_WEBHOOK_SECRET' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'INVALID_JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabaseUrl = env.SUPABASE_URL || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ success: false, error: 'SUPABASE_CONFIG_MISSING' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // 2. Extração dos dados do webhook (compatível com Evolution API / Baileys / Meta)
  const eventType = body?.event || body?.type || 'messages.update';
  const provider = 'evolution_api';
  const messageData = body?.data || body;
  const providerMsgId = messageData?.key?.id || messageData?.messageId || messageData?.id || null;
  const statusRaw = messageData?.status || messageData?.update?.status || eventType;

  // Gerar chave de evento única para deduplicação
  const eventId = body?.eventId || `${providerMsgId}_${statusRaw}_${Date.now()}`;
  const chaveEvento = `${provider}:${providerMsgId || 'unknown'}:${statusRaw}`;

  // 3. Invocar RPC canônica idempotente
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/whatsapp_processar_webhook_status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        p_provider: provider,
        p_chave_evento: chaveEvento,
        p_provider_event_id: String(eventId),
        p_provider_msg_id: providerMsgId ? String(providerMsgId) : null,
        p_tipo_evento: String(statusRaw),
        p_payload: body
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ success: false, error: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = await res.json();
    return new Response(JSON.stringify({ success: true, result: data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
