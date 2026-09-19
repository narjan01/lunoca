// ==========================================================================
// Cloudflare Pages Function: /api/infinitepay/webhook
// Processa notificações automáticas de pagamento aprovado da InfinitePay
// ==========================================================================

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    console.log('Webhook InfinitePay recebido:', JSON.stringify(body));

    // Identificar campos padrão da InfinitePay
    const orderNsu = body.order_nsu || body.external_reference || body.order_id;
    const transactionNsu = body.transaction_nsu || body.id;
    const invoiceSlug = body.invoice_slug || body.slug;
    const captureMethod = body.capture_method || (body.payment_method || 'infinitepay');
    const status = (body.status || 'paid').toLowerCase();
    const receiptUrl = body.receipt_url || '';

    if (!orderNsu) {
      return new Response(JSON.stringify({ received: true, note: 'order_nsu não informado no payload' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Apenas atualizar pedidos com pagamento aprovado / pago
    const isApproved = ['paid', 'approved', 'completed', 'authorized'].includes(status);

    const supabaseUrl = context.env.SUPABASE_URL || 'https://kgyyvyxegbqqyvjflcce.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY || context.env.SUPABASE_ANON_KEY;

    if (supabaseKey) {
      const updateData = {
        infinitepay_transaction_nsu: String(transactionNsu || ''),
        infinitepay_invoice_slug: String(invoiceSlug || ''),
        infinitepay_status: status,
        infinitepay_capture_method: captureMethod,
        infinitepay_receipt_url: receiptUrl
      };

      if (isApproved) {
        updateData.status = 'Confirmado';
      }

      await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${encodeURIComponent(orderNsu)}`, {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(updateData)
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Pedido ${orderNsu} atualizado via Webhook InfinitePay.`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Erro no webhook InfinitePay:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
