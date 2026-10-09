// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Expiração de Pedidos & Holds
// ==========================================================================
// Autoridade ÚNICA de expiração: invoca a RPC public.expirar_pedidos_e_holds(),
// que trata num só pipeline transacional:
//   (a) PIX da loja online sem pagamento (expires_at / tolerância em minutos);
//   (b) Holds de encomenda (confirmacao_expires_at):
//        - sem valor pago  -> cancela, libera capacidade e reservas de estoque;
//        - com valor pago  -> NÃO cancela; libera vaga/estoque e marca revisão financeira.
//
// SEGURANÇA (FAIL-CLOSED):
//   * CRON_SECRET é OBRIGATÓRIO. Sem ele configurado, o endpoint responde 503 e não executa.
//   * O segredo só é aceito via header `Authorization: Bearer <CRON_SECRET>`
//     (nunca via query string, para não vazar em logs/proxies).
//   * Comparação em tempo constante.
//
// AGENDAMENTO (Cloudflare):
//   Pages Functions são rotas HTTP; Cron Triggers só existem em Workers (handler
//   `scheduled()`). Arquitetura adotada: um Worker Cron mínimo (ver
//   docs/ARQUITETURA_ETAPA2.md) chama esta rota via HTTP a cada 5-10 min com o Bearer.
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

function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length || x.length === 0) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) {
    out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return out === 0;
}

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders }
  });
}

async function processExpiredOrders(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  // 1. FAIL-CLOSED: sem CRON_SECRET configurado, a rota não existe operacionalmente
  const cronSecret = env.CRON_SECRET;
  if (!cronSecret || String(cronSecret).length < 16) {
    console.error('[Expire Orders] Bloqueado: CRON_SECRET ausente ou muito curto (mínimo 16 caracteres).');
    return json({
      success: false,
      error: 'Rotina de expiração desabilitada: CRON_SECRET não configurado no servidor.'
    }, 503, corsHeaders);
  }

  // 2. Somente Bearer no header (query string é rejeitada explicitamente)
  const url = new URL(request.url);
  if (url.searchParams.has('secret') || url.searchParams.has('token')) {
    return json({ success: false, error: 'Segredo via query string não é aceito. Use o header Authorization: Bearer.' }, 400, corsHeaders);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!constantTimeEqual(token, cronSecret)) {
    return json({ success: false, error: 'Acesso não autorizado ao job de expiração de pedidos.' }, 401, corsHeaders);
  }

  // 3. Dependências críticas
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('[Expire Orders] Falha: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente.');
    return json({ success: false, error: 'Configuração crítica ausente no servidor (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }, 500, corsHeaders);
  }

  // 4. Limite opcional por execução (body JSON { limite } ou ?limite=), com teto
  let limite = 200;
  try {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body && Number.isFinite(Number(body.limite))) limite = Number(body.limite);
    } else if (url.searchParams.has('limite')) {
      limite = Number(url.searchParams.get('limite'));
    }
  } catch (_) {}
  limite = Math.min(1000, Math.max(1, Number.isFinite(limite) ? Math.floor(limite) : 200));

  try {
    // 1. Expiração de pedidos e holds (loja online + encomendas)
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/expirar_pedidos_e_holds`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_limite: limite })
    });

    const rpcData = await rpcRes.json().catch(() => ({}));

    if (!rpcRes.ok || rpcData?.success === false) {
      console.error('[Expire Orders] Erro ao executar expirar_pedidos_e_holds:', rpcData);
      return json({
        success: false,
        error: rpcData?.message || rpcData?.error || 'Erro ao processar expiração de pedidos.',
        details: rpcData
      }, rpcRes.ok ? 500 : (rpcRes.status || 500), corsHeaders);
    }

    // 2. Expiração de orçamentos vencidos (Etapa 3 - cron unificado)
    const orcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/expirar_orcamentos`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_limite: limite })
    });
    const orcData = await orcRes.json().catch(() => ({}));

    return json({
      success: true,
      processados: rpcData?.processados ?? 0,
      cancelados_sem_pagamento: rpcData?.cancelados_sem_pagamento ?? 0,
      enviados_para_revisao: rpcData?.enviados_para_revisao ?? 0,
      orcamentos_expirados: orcData?.expirados_count ?? 0,
      orcamentos_ids: orcData?.orcamentos_ids ?? [],
      timestamp: rpcData?.timestamp || new Date().toISOString()
    }, 200, corsHeaders);

  } catch (err) {
    console.error('[Expire Orders Error]:', err);
    return json({ success: false, error: err.message || 'Erro interno no processamento' }, 500, corsHeaders);
  }
}
