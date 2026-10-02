// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Disparo WhatsApp
// Suporte a Evolution API, Z-API, Webhooks Customizados e Cloud API
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  try {
    const body = await request.json();
    const { 
      telefone, 
      mensagem, 
      provedor = 'evolution', 
      instanciaUrl, 
      apiKey, 
      instanciaNome,
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

    // Normaliza o telefone do cliente para o formato internacional E.164 (55DDDNÚMERO)
    let foneLimpo = String(telefone).replace(/\D/g, '');
    if (foneLimpo.length === 10 || foneLimpo.length === 11) {
      foneLimpo = '55' + foneLimpo;
    }

    // Se nenhum endpoint de gateway foi configurado, retorna instrução para fallback nativo
    if (!instanciaUrl) {
      return new Response(JSON.stringify({
        success: false,
        fallback: true,
        error: 'Nenhuma URL de gateway WhatsApp configurada. Use o botão de envio direto via WhatsApp Web.',
        telefoneFormatado: foneLimpo
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let targetUrl = instanciaUrl.trim();
    let reqHeaders = { 'Content-Type': 'application/json' };
    let reqBody = {};

    if (provedor === 'evolution') {
      // Suporte a Evolution API (v1 e v2)
      if (apiKey) {
        reqHeaders['apikey'] = apiKey.trim();
        reqHeaders['Authorization'] = `Bearer ${apiKey.trim()}`;
      }
      
      // Se a URL não terminar com o endpoint de texto, constrói adequadamente
      if (!targetUrl.includes('/message/sendText') && instanciaNome) {
        targetUrl = targetUrl.replace(/\/+$/, '') + `/message/sendText/${instanciaNome.trim()}`;
      }

      reqBody = {
        number: foneLimpo,
        text: mensagem,
        textMessage: { text: mensagem }, // Compatibilidade v1
        options: { delay: 1200, presence: 'composing' }
      };
    } else if (provedor === 'z-api') {
      // Suporte a Z-API
      if (clientToken) {
        reqHeaders['Client-Token'] = clientToken.trim();
      }
      if (!targetUrl.includes('/send-text')) {
        targetUrl = targetUrl.replace(/\/+$/, '') + '/send-text';
      }

      reqBody = {
        phone: foneLimpo,
        message: mensagem
      };
    } else {
      // Webhook Genérico / n8n / Make / Custom
      if (apiKey) {
        reqHeaders['Authorization'] = `Bearer ${apiKey.trim()}`;
      }
      reqBody = {
        phone: foneLimpo,
        number: foneLimpo,
        message: mensagem,
        text: mensagem,
        timestamp: new Date().toISOString()
      };
    }

    // Dispara a requisição HTTP para o Gateway do WhatsApp
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
        status: 200,
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
