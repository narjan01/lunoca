// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Gestão de Instância WhatsApp
// Permite verificar status, gerar QR Code na tela e resetar instância (Evolution API v2)
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
      action = 'status', // 'status', 'connect', 'delete'
      instanciaUrl,
      apiKey,
      instanciaNome = 'lunoca-whatsapp'
    } = body;

    if (!instanciaUrl || !apiKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'URL da Instância e API Key são obrigatórios.'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = instanciaUrl.replace(/\/+$/, '');
    const cleanNome = encodeURIComponent(instanciaNome.trim());
    const headers = {
      'apikey': apiKey.trim(),
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
        state: state, // 'open' (conectado), 'connecting' (aguardando), 'close'
        connected: state === 'open'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ------------------------------------------------------------------------
    // AÇÃO 2: CONECTAR / GERAR QR CODE (Cria se não existir)
    // ------------------------------------------------------------------------
    if (action === 'connect') {
      // 1. Tenta obter o QR code da instância existente
      let connectRes = await fetch(`${baseUrl}/instance/connect/${cleanNome}`, {
        method: 'GET',
        headers
      });

      // Se a instância não existir (404), cria automaticamente
      if (connectRes.status === 404) {
        const createRes = await fetch(`${baseUrl}/instance/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            instanceName: instanciaNome.trim(),
            qrcode: true,
            integration: 'WHATSAPP-BAILEYS'
          })
        });

        const createData = await createRes.json().catch(() => ({}));
        if (!createRes.ok) {
          return new Response(JSON.stringify({
            success: false,
            error: createData?.response?.message || createData?.message || createData?.error || 'Erro ao criar instância na Evolution API.'
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Se a criação já retornou o QR Code
        const qrBase64 = createData?.qrcode?.base64 || createData?.base64;
        if (qrBase64) {
          return new Response(JSON.stringify({
            success: true,
            state: 'connecting',
            qrcode: qrBase64,
            pairingCode: createData?.pairingCode || null
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Caso contrário, busca a conexão novamente
        connectRes = await fetch(`${baseUrl}/instance/connect/${cleanNome}`, {
          method: 'GET',
          headers
        });
      }

      const connectData = await connectRes.json().catch(() => ({}));
      const qrBase64 = connectData?.base64 || connectData?.qrcode?.base64 || connectData?.code;

      // Se já estiver conectada
      if (connectData?.instance?.state === 'open' || connectData?.state === 'open') {
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
