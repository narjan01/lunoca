export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    const paymentId = url.searchParams.get('data.id') || body?.data?.id || body?.id;
    const topic = url.searchParams.get('type') || body?.type || body?.topic;

    const token = env.MERCADO_PAGO_ACCESS_TOKEN;

    if (paymentId && token && (topic === 'payment' || !topic)) {
      // Buscar detalhes do pagamento no Mercado Pago
      const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const payment = await payRes.json();

      if (payment.status === 'approved' && payment.external_reference) {
        const orderId = payment.external_reference;

        // Se Supabase Service Role ou URL estiverem disponíveis
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${orderId}`, {
            method: 'PATCH',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              status: 'Confirmado',
              mercado_pago_id: String(paymentId),
              mercado_pago_status: payment.status
            })
          });
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
