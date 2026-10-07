// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Checkout Transparente
// Processamento direto de PIX (com QR Code Base64) e Cartão de Crédito
// 100% no próprio site, sem redirecionamentos externos.
// Conformidade PCI-DSS estrita: sem dados brutos de cartão; total obtido do banco.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

function getSafeBaseUrl(origin, env) {
  const allowedHostnames = ['lunocadoceria.com.br', 'www.lunocadoceria.com.br', 'localhost', '127.0.0.1'];
  if (origin) {
    try {
      const u = new URL(origin);
      if (allowedHostnames.includes(u.hostname) || u.hostname.endsWith('.pages.dev')) {
        return u.origin;
      }
    } catch (_) {}
  }
  return env.APP_BASE_URL || 'https://lunocadoceria.com.br';
}

/**
 * Busca o pedido no Supabase, valida status, titularidade e extrai o total oficial do banco.
 * Lança exceção caso o pedido não exista ou haja divergência de segurança.
 * NUNCA recorre a fallbacks inseguros de valores do cliente.
 */
async function fetchAndValidateOrder(pedidoId, env, authUser) {
  const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey) {
    throw new Error('Configuração crítica ausente no servidor: SUPABASE_SERVICE_ROLE_KEY.');
  }

  const pedidoRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${pedidoId}&select=id,total,itens,cliente_id,status`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });

  if (!pedidoRes.ok) {
    throw new Error('Falha na comunicação com o banco de dados ao verificar o pedido.');
  }

  const pedidos = await pedidoRes.json();
  if (!pedidos || pedidos.length === 0) {
    throw new Error(`Pedido #${pedidoId} não encontrado no banco de dados.`);
  }

  const order = pedidos[0];

  // Se o usuário estiver autenticado, garante que ele é o dono do pedido ou membro da equipe
  if (authUser && authUser.id && order.cliente_id && authUser.id !== order.cliente_id && authUser.nivel !== 'admin' && authUser.nivel !== 'operador') {
    throw new Error('Acesso negado: este pedido pertence a outro usuário.');
  }

  // Não permitir pagamento de pedido já confirmado ou entregue
  if (order.status === 'Confirmado' || order.status === 'Em Preparo' || order.status === 'Pronto' || order.status === 'Entregue') {
    throw new Error(`Este pedido já se encontra confirmado ou em andamento (Status: "${order.status}").`);
  }

  if (order.status === 'Cancelado') {
    throw new Error('Este pedido foi cancelado e não pode receber pagamentos.');
  }

  const totalNoBanco = parseFloat(order.total);
  if (isNaN(totalNoBanco) || totalNoBanco <= 0) {
    throw new Error('Valor total do pedido no banco de dados é inválido.');
  }

  return { validatedTotal: totalNoBanco, orderData: order };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  try {
    const token = env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({
        error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado no servidor.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.json();

    // Rejeição preventiva de conformidade PCI-DSS: dados brutos de cartão não são permitidos
    if (body.cardData || body.numero || body.cvv || body.cardNumber || body.securityCode) {
      console.warn('[SEGURANÇA PCI-DSS] Tentativa de envio de dados brutos de cartão rejeitada.');
      return new Response(JSON.stringify({
        error: 'Transmissão direta de dados de cartão não é permitida por conformidade PCI-DSS. Utilize a tokenização segura via SDK.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const {
      pedidoId,
      forma, // 'pix' ou 'cartao'
      cliente,
      cardToken, // token seguro do cartão gerado no frontend pelo SDK oficial
      parcelas,
      paymentMethodId,
      origin
    } = body;

    if (!pedidoId) {
      return new Response(JSON.stringify({ error: 'ID do pedido é obrigatório.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Validação opcional de autenticação se fornecido header Bearer
    let authUser = null;
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const authCheck = await verifyAuth(request, env);
      if (authCheck.authorized) {
        authUser = authCheck.user;
      }
    }

    const baseUrl = getSafeBaseUrl(origin, env);

    // Validação server-side estrita do total diretamente do banco de dados (Fail-Closed)
    let amount;
    try {
      const { validatedTotal } = await fetchAndValidateOrder(pedidoId, env, authUser);
      amount = validatedTotal;
    } catch (valErr) {
      console.error('[Validação do Pedido Falhou]:', valErr.message);
      return new Response(JSON.stringify({ error: valErr.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ========================================================================
    // 1. FLUXO PIX TRANSPARENTE
    // ========================================================================
    if (forma === 'pix') {
      const email = cliente?.email || authUser?.email || 'cliente@lunocadoceria.com.br';
      const nomeCompleto = (cliente?.nome || authUser?.nome || 'Cliente Lunoca').trim().split(' ');
      const firstName = nomeCompleto[0] || 'Cliente';
      const lastName = nomeCompleto.slice(1).join(' ') || 'Doceria';
      const rawCpf = String(cliente?.cpf || '').replace(/\D/g, '');
      const cpf = rawCpf.length === 11 ? rawCpf : '19119119100';

      const pixPayload = {
        transaction_amount: amount,
        description: `Pedido #${pedidoId} - Lunoca Doceria`,
        payment_method_id: 'pix',
        payer: {
          email: email,
          first_name: firstName,
          last_name: lastName,
          identification: {
            type: 'CPF',
            number: cpf
          }
        },
        external_reference: String(pedidoId),
        notification_url: `${baseUrl}/api/mercadopago/webhook`
      };

      const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `order_${pedidoId}_pix_v1`
        },
        body: JSON.stringify(pixPayload)
      });

      const mpData = await mpRes.json();

      if (!mpRes.ok) {
        return new Response(JSON.stringify({
          error: mpData.message || 'Erro ao gerar PIX no Mercado Pago',
          details: mpData
        }), {
          status: mpRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const pointOfInteraction = mpData.point_of_interaction || {};
      const txData = pointOfInteraction.transaction_data || {};

      return new Response(JSON.stringify({
        success: true,
        type: 'pix',
        paymentId: mpData.id,
        status: mpData.status,
        statusDetail: mpData.status_detail,
        qrCode: txData.qr_code, // Código Pix Copia e Cola
        qrCodeBase64: txData.qr_code_base64, // Imagem QR Code Base64
        ticketUrl: txData.ticket_url,
        expirationDate: mpData.date_of_expiration
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ========================================================================
    // 2. FLUXO CARTÃO DE CRÉDITO TRANSPARENTE
    // ========================================================================
    if (forma === 'cartao') {
      if (!cardToken || typeof cardToken !== 'string') {
        return new Response(JSON.stringify({
          error: 'Token do cartão de crédito obrigatório (PCI-DSS compliance). Gere o token via SDK oficial.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const email = cliente?.email || authUser?.email || 'cliente@lunocadoceria.com.br';
      const rawCpf = String(cliente?.cpf || '').replace(/\D/g, '');
      const cleanCpf = rawCpf.length === 11 ? rawCpf : '19119119100';

      const cardPaymentPayload = {
        transaction_amount: amount,
        token: cardToken,
        description: `Pedido #${pedidoId} - Lunoca Doceria`,
        installments: parseInt(parcelas || 1, 10),
        payment_method_id: paymentMethodId || 'credit_card',
        payer: {
          email: email,
          identification: {
            type: 'CPF',
            number: cleanCpf
          }
        },
        external_reference: String(pedidoId),
        statement_descriptor: 'LUNOCA DOCERIA',
        notification_url: `${baseUrl}/api/mercadopago/webhook`
      };

      const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `order_${pedidoId}_card_${parcelas || 1}_v1`
        },
        body: JSON.stringify(cardPaymentPayload)
      });

      const mpData = await mpRes.json();

      if (!mpRes.ok) {
        return new Response(JSON.stringify({
          error: mpData.message || 'Erro ao processar cartão no Mercado Pago',
          details: mpData
        }), {
          status: mpRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Se aprovado, invocar RPC atômica confirmar_pagamento_pedido usando service_role
      if (mpData.status === 'approved') {
        const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
        const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

        if (supabaseUrl && serviceKey) {
          try {
            const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
              method: 'POST',
              headers: {
                'apikey': serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                p_pedido_id: Number(pedidoId),
                p_mercado_pago_payment_id: String(mpData.id),
                p_status: mpData.status,
                p_forma_pagamento: 'cartao',
                p_valor: amount,
                p_origem: 'Mercado Pago Transparente'
              })
            });

            if (!rpcRes.ok) {
              const rpcErrText = await rpcRes.text();
              console.error('[MercadoPago] RPC confirmar_pagamento_pedido retornou erro:', rpcErrText);
            }
          } catch (confirmErr) {
            console.error('[MercadoPago] Falha ao invocar RPC de confirmação:', confirmErr.message);
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        type: 'cartao',
        paymentId: mpData.id,
        status: mpData.status, // approved, in_process, rejected
        statusDetail: mpData.status_detail,
        paymentMethod: mpData.payment_method_id,
        cardLastFour: mpData.card?.last_four_digits,
        installments: mpData.installments
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: 'Forma de pagamento não suportada: ' + forma }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    console.error('[Transparent Payment Error]:', err);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
