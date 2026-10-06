// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Gestão de Instância WhatsApp (Segura)
// Permite verificar status, gerar QR Code na tela e resetar instância (Evolution API v2)
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

  // 1. Autorização Obrigatória (Apenas administradores logados podem gerenciar instâncias)
  const authResult = await verifyAuth(request, env, ['admin']);
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
      action = 'status', // 'status', 'connect', 'delete'
      instanciaUrl: customUrl,
      instanciaNome: customNome = 'lunoca-whatsapp'
    } = body;

    // 2. Resolução Segura de Credenciais Server-Side
    const serverApiKey = env.EVOLUTION_API_KEY || env.WHATSAPP_API_KEY || '';
    const defaultUrl = env.EVOLUTION_API_URL || env.WHATSAPP_API_URL || 'https://lunoca-whatsapp.onrender.com';
    const serverInstanciaNome = env.EVOLUTION_INSTANCE_NAME || env.WHATSAPP_INSTANCE_NAME || customNome;

    let targetBaseUrl = defaultUrl;
    if (customUrl && typeof customUrl === 'string' && customUrl.trim()) {
      const trimmed = customUrl.trim();
      if (!isSafeExternalUrl(trimmed)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'URL de instância não permitida por política de segurança (Anti-SSRF).'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      targetBaseUrl = trimmed;
    }

    if (!serverApiKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'EVOLUTION_API_KEY não configurada nas variáveis de ambiente da Cloudflare.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = targetBaseUrl.replace(/\/+$/, '');
    const cleanNome = encodeURIComponent(serverInstanciaNome.trim());
    const headers = {
      'apikey': serverApiKey.trim(),
      'Content-Type': 'application/json'
    };

    // ------------------------------------------------------------------------
    // AÇÃO 1: CONSULTAR STATUS DA CONEXÃO
    // ------------------------------------------------------------------------
    if (action === 'status') {
      const stateRes = await fetch(`${baseUrl}/instance/connectionState/${cleanNome}`, {
        method: 'GET',
        headers
      });

      if (stateRes.status === 404) {
        return new Response(JSON.stringify({
          success: true,
          exists: false,
          state: 'not_found',
          message: 'Instância ainda não criada no servidor.'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (stateRes.status === 401 || stateRes.status === 403) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Chave API incorreta ou não autorizada pela Evolution API.'
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const stateData = await stateRes.json().catch(() => ({}));
      const state = stateData?.instance?.state || stateData?.state || 'close';

      return new Response(JSON.stringify({
        success: true,
        exists: true,
        state: state,
        connected: state === 'open'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ------------------------------------------------------------------------
    // AÇÃO 2: CONECTAR / GERAR QR CODE COM BAILEYS
    // ------------------------------------------------------------------------
    if (action === 'connect') {
      const stateCheckRes = await fetch(`${baseUrl}/instance/connectionState/${cleanNome}`, {
        method: 'GET',
        headers
      });

      if (stateCheckRes.status === 404) {
        const createRes = await fetch(`${baseUrl}/instance/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            instanceName: serverInstanciaNome.trim(),
            token: '',
            qrcode: true,
            integration: 'WHATSAPP-BAILEYS',
            reject_call: false,
            msgCall: ''
          })
        });

        if (!createRes.ok) {
          const createErr = await createRes.json().catch(() => ({}));
          return new Response(JSON.stringify({
            success: false,
            error: createErr.message || 'Erro ao criar instância na Evolution API.'
          }), {
            status: createRes.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      const connectRes = await fetch(`${baseUrl}/instance/connect/${cleanNome}`, {
        method: 'GET',
        headers
      });

      const connectData = await connectRes.json().catch(() => ({}));
      let qrBase64 = connectData?.base64 || connectData?.qrcode?.base64 || connectData?.code || '';

      if (qrBase64 && qrBase64.startsWith('data:image/')) {
        qrBase64 = qrBase64.split(',')[1] || qrBase64;
      }

      const isConnected = connectData?.instance?.state === 'open' || connectData?.state === 'open';

      if (isConnected) {
        return new Response(JSON.stringify({
          success: true,
          connected: true,
          state: 'open',
          message: 'WhatsApp já está conectado com sucesso!'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        connected: false,
        state: 'connecting',
        qrcode: qrBase64,
        pairingCode: connectData?.pairingCode || null
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ------------------------------------------------------------------------
    // AÇÃO 3: RESETAR / DELETAR INSTÂNCIA TRAVADA
    // ------------------------------------------------------------------------
    if (action === 'delete') {
      const delRes = await fetch(`${baseUrl}/instance/delete/${cleanNome}`, {
        method: 'DELETE',
        headers
      });

      const delData = await delRes.json().catch(() => ({}));
      return new Response(JSON.stringify({
        success: delRes.ok,
        data: delData,
        message: 'Instância reiniciada. Agora você pode gerar um novo QR Code.'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Ação não suportada.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[WhatsApp Instance] Erro interno:', err);
    return new Response(JSON.stringify({
      success: false,
      error: 'Erro de conexão com a Evolution API: ' + err.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
