// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Disparo WhatsApp (Seguro & Canônico)
// ==========================================================================
// 1. Autenticação obrigatória (Admin ou Operador).
// 2. Não confia em texto/telefone vindo do cliente: invoca obter_preview_comunicacao() no servidor.
// 3. Fallback wa.me ou adapter Evolution API com secrets seguros do Cloudflare.
// 4. Registra auditoria com idempotência via registrar_comunicacao_cliente().
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
    const { tipo, orcamento_id, pedido_id } = body;

    if (!tipo) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Tipo de template de comunicação é obrigatório.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!orcamento_id && !pedido_id) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'ID da entidade (orcamento_id ou pedido_id) é obrigatório.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Conexão ao Supabase para obter o preview canônico server-side
    const supabaseUrl = env.SUPABASE_URL || '';
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || '';

    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Configuração do banco de dados ausente no ambiente.' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Chama obter_preview_comunicacao
    const rpcUrl = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/obter_preview_comunicacao`;
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({
        p_tipo: tipo,
        p_orcamento_id: orcamento_id || null,
        p_pedido_id: pedido_id || null
      })
    });

    if (!rpcRes.ok) {
      const errTxt = await rpcRes.text();
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Falha ao resolver mensagem canônica: ' + errTxt 
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const preview = await rpcRes.json();
    if (!preview || preview.success !== true) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: preview?.error || 'Não foi possível gerar a mensagem de comunicação.' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Provedor de Envio: Evolution API (se configurado) ou Fallback para wa.me
    const provider = env.WHATSAPP_PROVIDER || 'evolution';
    const evolutionUrl = env.EVOLUTION_API_URL || env.WHATSAPP_API_URL || '';
    const evolutionKey = env.EVOLUTION_API_TOKEN || env.EVOLUTION_API_KEY || env.WHATSAPP_CLIENT_TOKEN || '';
    const evolutionInstance = env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME || 'lunoca';

    if (provider === 'evolution' && evolutionUrl && evolutionKey) {
      // Disparo Automatizado via Evolution API
      let targetUrl = `${evolutionUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(evolutionInstance)}`;

      if (!isSafeExternalUrl(targetUrl)) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'URL do gateway Evolution API inválida ou insegura.' 
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const evoRes = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': evolutionKey,
          'Authorization': `Bearer ${evolutionKey}`
        },
        body: JSON.stringify({
          number: preview.telefone,
          text: preview.mensagem,
          options: { delay: 1000, presence: 'composing' }
        })
      });

      const evoData = await evoRes.json().catch(() => ({}));

      if (evoRes.ok) {
        // Registra como enviado de forma auditável
        await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/registrar_comunicacao_cliente`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({
            p_tipo: tipo,
            p_orcamento_id: orcamento_id || null,
            p_pedido_id: pedido_id || null,
            p_canal: 'evolution_api',
            p_status: 'enviado',
            p_provider_message_id: evoData?.key?.id || null
          })
        });

        return new Response(JSON.stringify({
          success: true,
          canal: 'evolution_api',
          status: 'enviado',
          destinatario: preview.telefone,
          data: evoData
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        // Registra falha de envio
        await fetch(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/registrar_comunicacao_cliente`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({
            p_tipo: tipo,
            p_orcamento_id: orcamento_id || null,
            p_pedido_id: pedido_id || null,
            p_canal: 'evolution_api',
            p_status: 'falhou',
            p_erro: JSON.stringify(evoData)
          })
        });

        return new Response(JSON.stringify({
          success: false,
          canal: 'evolution_api',
          status: 'falhou',
          error: evoData.message || 'Erro ao enviar mensagem via Evolution API.'
        }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // 4. Se não houver Evolution configurada, retorna os dados para deep link wa.me
    const waLink = `https://wa.me/${preview.telefone}?text=${encodeURIComponent(preview.mensagem)}`;

    return new Response(JSON.stringify({
      success: true,
      canal: 'whatsapp_link',
      status: 'gerado',
      destinatario: preview.telefone,
      mensagem: preview.mensagem,
      link_whatsapp: waLink
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
