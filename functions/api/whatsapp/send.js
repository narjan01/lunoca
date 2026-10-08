// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Disparo WhatsApp (Seguro & Anti-SSRF)
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

function isSafeExternalUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(host)) return false;
    if (/^[0-9.]+$/.test(host)) return false;
    if (host.includes(':')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  // 1. Autorização Obrigatória (Apenas operadores/admins logados podem disparar)
  const authResult = await verifyAuth(request, env, ['admin', 'operador']);
  if (!authResult.authorized) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: authResult.error 
    }), {
      status: authResult.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json();
    const { 
      telefone, 
      mensagem, 
      provedor = 'evolution', 
      instanciaNome: customNome,
      clientToken
    } = body;

    if (!telefone || !mensagem) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Telefone e mensagem são obrigatórios.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let foneLimpo = String(telefone).replace(/\D/g, '');
    if (foneLimpo.length === 10 || foneLimpo.length === 11) {
      foneLimpo = '55' + foneLimpo;
    }

    // 2. Resolução Segura de Credenciais (Server-Side Environment Variables exclusivamente)
    const serverApiKey = env.EVOLUTION_API_KEY || env.WHATSAPP_API_KEY || '';
    const defaultUrl = env.EVOLUTION_API_URL || env.WHATSAPP_API_URL || 'https://lunoca-whatsapp.onrender.com';
    const serverInstanciaNome = env.EVOLUTION_INSTANCE_NAME || env.WHATSAPP_INSTANCE_NAME || customNome || 'lunoca-whatsapp';

    let targetBaseUrl = defaultUrl;
    let targetUrl = targetBaseUrl.replace(/\/+$/, '');
    let reqHeaders = { 'Content-Type': 'application/json' };
    let reqBody = {};

    if (provedor === 'evolution') {
      if (serverApiKey) {
        reqHeaders['apikey'] = serverApiKey.trim();
        reqHeaders['Authorization'] = `Bearer ${serverApiKey.trim()}`;
      }
      
      if (!targetUrl.includes('/message/sendText')) {
        targetUrl = targetUrl + `/message/sendText/${encodeURIComponent(serverInstanciaNome.trim())}`;
      }

      reqBody = {
        number: foneLimpo,
        text: mensagem,
        textMessage: { text: mensagem },
        options: { delay: 1200, presence: 'composing' }
      };
    } else if (provedor === 'z-api') {
      const zToken = env.WHATSAPP_CLIENT_TOKEN || clientToken || '';
      if (zToken) reqHeaders['Client-Token'] = zToken.trim();
      if (!targetUrl.includes('/send-text')) {
        targetUrl = targetUrl + '/send-text';
      }
      reqBody = { phone: foneLimpo, message: mensagem };
    } else {
      if (serverApiKey) reqHeaders['Authorization'] = `Bearer ${serverApiKey.trim()}`;
      reqBody = {
        phone: foneLimpo,
        number: foneLimpo,
        message: mensagem,
        timestamp: new Date().toISOString()
      };
    }

    const apiRes = await fetch(targetUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(reqBody)
    });

    const resContentType = apiRes.headers.get('content-type') || '';
    let resData;
    if (resContentType.includes('application/json')) {
      resData = await apiRes.json();
    } else {
      resData = { rawText: await apiRes.text() };
    }

    if (!apiRes.ok) {
      console.warn('[WhatsApp Send] Resposta de erro do gateway:', apiRes.status, resData);
      return new Response(JSON.stringify({
        success: false,
        status: apiRes.status,
        error: resData.message || resData.error || `Erro HTTP ${apiRes.status} no gateway WhatsApp.`,
        telefoneFormatado: foneLimpo
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: resData,
      telefoneFormatado: foneLimpo
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[WhatsApp Send] Erro interno:', err);
    return new Response(JSON.stringify({
      success: false,
      error: 'Erro interno ao processar disparo WhatsApp: ' + err.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
