// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Expiração Automática de Pedidos
// Cancela pedidos PIX não pagos dentro da tolerância (30 min) e devolve estoque.
// Pode ser acionado via Cloudflare Cron Trigger, webhook ou chamada administrativa.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestGet(context) {
  return processExpiredOrders(context);
}

export async function onRequestPost(context) {
  return processExpiredOrders(context);
}

async function processExpiredOrders(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  try {
    const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceKey) {
      console.error('[Expire Orders] Falha: SUPABASE_SERVICE_ROLE_KEY ausente.');
      return new Response(JSON.stringify({
        error: 'Configuração crítica ausente no servidor (SUPABASE_SERVICE_ROLE_KEY).'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Invoca a RPC atômica que busca pedidos expirados, cancela e devolve a reserva de estoque
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/liberar_pedidos_expirados`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const rpcData = await rpcRes.json();

    if (!rpcRes.ok) {
      console.error('[Expire Orders] Erro ao executar liberar_pedidos_expirados:', rpcData);
      return new Response(JSON.stringify({
        error: rpcData.message || rpcData.error || 'Erro ao processar expiração de pedidos.',
        details: rpcData
      }), {
        status: rpcRes.status || 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Rotina de expiração executada com sucesso.',
      data: rpcData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    console.error('[Expire Orders Error]:', err);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no processamento' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
