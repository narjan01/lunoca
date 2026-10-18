// ==========================================================================
// LUNOCA - Worker Cron (Opção B): Worker -> HTTP -> Pages Function
// ==========================================================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(disparar(env, event.cron));
  },

  // Permite teste manual: `npx wrangler dev` e GET /__trigger (exige o mesmo Bearer)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/__trigger') return new Response('lunoca-cron-expire-orders', { status: 200 });
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.CRON_SECRET}`) return new Response('unauthorized', { status: 401 });
    const result = await disparar(env, 'manual');
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }
};

async function disparar(env, origem) {
  if (!env.CRON_SECRET || !env.APP_BASE_URL) {
    console.error('[cron] CRON_SECRET ou APP_BASE_URL ausente; abortando (fail-closed).');
    return { success: false, error: 'config ausente' };
  }

  // 1. Expiração de pedidos & holds vencidos
  const res = await fetch(`${env.APP_BASE_URL}/api/cron/expire-orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CRON_SECRET}`,
      'Content-Type': 'application/json',
      'User-Agent': 'lunoca-cron-worker'
    },
    body: JSON.stringify({ limite: 200 })
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[cron:${origem}:expire] status=${res.status}`, JSON.stringify(data));

  // 2. Dispatcher assíncrono de WhatsApp Outbox
  let dataWa = null;
  try {
    const resWa = await fetch(`${env.APP_BASE_URL}/api/whatsapp/dispatcher`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CRON_SECRET}`,
        'Content-Type': 'application/json',
        'User-Agent': 'lunoca-cron-worker'
      }
    });
    dataWa = await resWa.json().catch(() => ({}));
    console.log(`[cron:${origem}:whatsapp] status=${resWa.status}`, JSON.stringify(dataWa));
  } catch (errWa) {
    console.warn(`[cron:${origem}:whatsapp] Erro de conexão com dispatcher:`, errWa.message);
  }

  return { status: res.status, expire: data, whatsapp: dataWa };
}
