// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Processamento Proativo de Alertas
// ==========================================================================
// Rota de cron autônomo (Modelo B): invoca public.processar_alertas_operacionais()
// periodicamente sem necessidade de abertura de tela pelo operador.
//
// SEGURANÇA (FAIL-CLOSED):
//   * Requer CRON_SECRET via header `Authorization: Bearer <CRON_SECRET>`.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}

export async function onRequestGet(context) {
  return processAlertsJob(context);
}

export async function onRequestPost(context) {
  return processAlertsJob(context);
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

async function processAlertsJob(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  const cronSecret = env.CRON_SECRET;
  if (!cronSecret || String(cronSecret).length < 16) {
    return json({
      success: false,
      error: 'CRON_SECRET ausente ou inválido no servidor.'
    }, 503, corsHeaders);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!constantTimeEqual(token, cronSecret)) {
    return json({ success: false, error: 'Acesso não autorizado ao job de alertas operacionais.' }, 401, corsHeaders);
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return json({ success: false, error: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente.' }, 500, corsHeaders);
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/processar_alertas_operacionais`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      return json({
        success: false,
        error: data?.message || data?.error || 'Erro ao processar alertas operacionais.',
        details: data
      }, res.status || 500, corsHeaders);
    }

    return json(data, 200, corsHeaders);
  } catch (err) {
    return json({ success: false, error: err.message || 'Erro interno no processamento' }, 500, corsHeaders);
  }
}
