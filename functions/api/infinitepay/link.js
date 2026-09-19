// ==========================================================================
// Cloudflare Pages Function: /api/infinitepay/link
// Gera links de checkout oficiais da InfinitePay para PIX e Cartão em até 12x
// ==========================================================================

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { pedidoId, items, total, cliente, origin, customHandle, customApiKey } = body;

    // Obter InfiniteTag ($handle) das variáveis de ambiente do Cloudflare ou customHandle
    let handle = (customHandle || context.env.INFINITEPAY_HANDLE || 'lunocadoceria').trim();
    // Remover o cifrão "$" se o usuário digitou ex: "$lunocadoceria"
    if (handle.startsWith('$')) {
      handle = handle.substring(1);
    }

    const apiKey = (customApiKey || context.env.INFINITEPAY_API_KEY || '').trim();

    if (!handle) {
      return new Response(JSON.stringify({
        error: 'InfiniteTag (handle) da InfinitePay não configurado no Cloudflare Pages ou nas configurações do Admin.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = origin || 'https://lunocadoceria.com.br';
    const redirectUrl = `${baseUrl}?payment=success&order_id=${pedidoId || ''}`;
    const webhookUrl = `${baseUrl}/api/infinitepay/webhook`;

    // Mapeia os itens do pedido com valores convertidos em centavos (padrão InfinitePay)
    let formattedItems = [];
    if (items && items.length > 0) {
      formattedItems = items.map((it, idx) => ({
        id: String(it.id || idx + 1),
        description: String(it.nome || 'Doce Lunoca Doceria'),
        price: Math.round(parseFloat(it.preco || 0) * 100), // centavos
        quantity: parseInt(it.quantidade || 1, 10)
      }));
    } else {
      formattedItems = [{
        id: String(pedidoId || '1'),
        description: `Pedido Lunoca Doceria #${pedidoId || ''}`,
        price: Math.round(parseFloat(total || 0) * 100),
        quantity: 1
      }];
    }

    // Payload oficial da API de Checkout da InfinitePay
    const payload = {
      handle: handle,
      order_nsu: String(pedidoId || Date.now()),
      items: formattedItems,
      customer: {
        name: cliente?.nome || 'Cliente Lunoca',
        email: cliente?.email || 'cliente@lunocadoceria.com.br',
        phone_number: cliente?.telefone ? String(cliente.telefone).replace(/\D/g, '') : undefined
      },
      redirect_url: redirectUrl,
      webhook_url: webhookUrl
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Tentar endpoint oficial de links da InfinitePay
    const response = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      // Caso a API pública com handle retorne erro ou endpoint alternativo
      return new Response(JSON.stringify({
        error: data.message || data.error || 'Erro ao gerar link de pagamento na InfinitePay.',
        details: data,
        fallbackLink: `https://infinitepay.io/pay/${handle}/${total ? parseFloat(total).toFixed(2) : ''}`
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const checkoutUrl = data.url || data.link || data.payment_link || data.checkout_url || (data.data && data.data.url);
    const invoiceSlug = data.invoice_slug || data.id || data.slug;

    return new Response(JSON.stringify({
      success: true,
      url: checkoutUrl,
      invoice_slug: invoiceSlug,
      handle: handle
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message || 'Erro inesperado ao conectar com a InfinitePay.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
