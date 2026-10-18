// ==============================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Outbox Dispatcher WhatsApp
// ==============================================================================
// 1. Processa lotes pequenos (10-25) com claim_token e lease via whatsapp_obter_proximos_envios.
// 2. Não mantém transação de banco aberta durante chamada HTTP externa.
// 3. Validação individual: falha em um envio não aborta os demais.
// 4. Invoca whatsapp_confirmar_envio ou whatsapp_registrar_falha com o claim_token.
// ==============================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  // Validação de segurança: aceita tanto o CRON_SECRET do worker agendado quanto a service_role key do webhook interno
  const authHeader = request.headers.get('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const cronSecret = env.CRON_SECRET || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';

  const isAuthorized = Boolean(
    (cronSecret && bearerToken === cronSecret) ||
    (serviceKey && bearerToken === serviceKey)
  );

  if (!isAuthorized) {
    return new Response(JSON.stringify({ success: false, error: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabaseUrl = env.SUPABASE_URL || '';
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ success: false, error: 'SUPABASE_CONFIG_MISSING' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const rpcHeaders = {
    'Content-Type': 'application/json',
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`
  };

  try {
    // 1. Obter próximo lote com claim e lease (TX 1 isolada)
    const claimRes = await fetch(`${supabaseUrl}/rest/v1/rpc/whatsapp_obter_proximos_envios`, {
      method: 'POST',
      headers: rpcHeaders,
      body: JSON.stringify({ p_limite: 15, p_lease_segundos: 60 })
    });

    if (!claimRes.ok) {
      const errText = await claimRes.text();
      return new Response(JSON.stringify({ success: false, error: `CLAIM_FAILED: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const mensagens = await claimRes.json();
    if (!Array.isArray(mensagens) || mensagens.length === 0) {
      return new Response(JSON.stringify({ success: true, total: 0, processados: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const rawUrl = env.EVOLUTION_API_URL || env.WHATSAPP_API_URL || 'https://lunoca-whatsapp.onrender.com';
    const evolutionUrl = rawUrl ? rawUrl.replace(/\/+$/, '') : null;
    const evolutionKey = env.EVOLUTION_API_KEY || env.AUTHENTICATION_API_KEY || env.WHATSAPP_API_KEY || null;
    const evolutionInstance = env.EVOLUTION_INSTANCE_NAME || env.WHATSAPP_INSTANCE_NAME || 'lunoca-whatsapp';

    let sucessos = 0;
    let falhas = 0;

    // 2. Iterar mensagens individualmente sem transação aberta no banco
    for (const msg of mensagens) {
      const { outbox_id, claim_token, telefone_e164, mensagem_texto } = msg;

      if (!evolutionUrl || !evolutionKey) {
        // Modo simulado / gateway offline
        await fetch(`${supabaseUrl}/rest/v1/rpc/whatsapp_confirmar_envio`, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({
            p_outbox_id: outbox_id,
            p_claim_token: claim_token,
            p_provider: 'simulated_worker',
            p_provider_msg_id: `sim_${Date.now()}_${outbox_id.substring(0, 8)}`
          })
        });
        sucessos++;
        continue;
      }

      try {
        // Chamada HTTP ao provedor com timeout de 10 segundos
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const sendRes = await fetch(`${evolutionUrl}/message/sendText/${encodeURIComponent(evolutionInstance)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': evolutionKey
          },
          body: JSON.stringify({
            number: telefone_e164,
            options: { delay: 1200, presence: 'composing' },
            textMessage: { text: mensagem_texto }
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!sendRes.ok) {
          const errBody = await sendRes.text();
          throw new Error(`HTTP ${sendRes.status}: ${errBody}`);
        }

        const sendData = await sendRes.json();
        const providerMsgId = sendData?.key?.id || sendData?.messageId || `msg_${Date.now()}`;

        // 3. Confirmar envio com claim_token (TX 2 isolada)
        await fetch(`${supabaseUrl}/rest/v1/rpc/whatsapp_confirmar_envio`, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({
            p_outbox_id: outbox_id,
            p_claim_token: claim_token,
            p_provider: 'evolution_api',
            p_provider_msg_id: String(providerMsgId)
          })
        });

        sucessos++;
      } catch (err) {
        // 4. Registrar falha e aplicar backoff persistido (TX 2 de erro)
        await fetch(`${supabaseUrl}/rest/v1/rpc/whatsapp_registrar_falha`, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({
            p_outbox_id: outbox_id,
            p_claim_token: claim_token,
            p_erro: err.message || 'Erro no envio HTTP'
          })
        });

        falhas++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      total: mensagens.length,
      sucessos,
      falhas
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (globalErr) {
    return new Response(JSON.stringify({ success: false, error: globalErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
