// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Checkout Transparente
// Processamento direto de PIX (com QR Code Base64) e Cartão de Crédito
// 100% no próprio site, sem redirecionamentos externos.
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
 * Busca o pedido no Supabase, valida status, titularidade e calcula o total correto.
 * Retorna { validatedTotal, orderData } ou lança erro se houver divergência.
 */
async function fetchAndValidateOrder(pedidoId, clientTotal, env, authUser) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { validatedTotal: clientTotal, orderData: null };
  }

  const pedidoRes = await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${pedidoId}&select=id,total,itens,cliente_id,status`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  });

  const pedidos = await pedidoRes.json();
  if (!pedidos || pedidos.length === 0) {
    return { validatedTotal: clientTotal, orderData: null };
  }

  const order = pedidos[0];

  // Se o usuário estiver autenticado, garante que ele é o dono do pedido ou admin
  if (authUser && authUser.id && order.cliente_id && authUser.id !== order.cliente_id && authUser.nivel !== 'admin' && authUser.nivel !== 'operador') {
    throw new Error('Acesso negado: este pedido pertence a outro usuário.');
  }

  // Não permitir pagamento de pedido já confirmado ou cancelado
  if (order.status === 'Confirmado' || order.status === 'Entregue') {
    throw new Error(`Este pedido já se encontra com status "${order.status}".`);
  }

  const totalNoBanco = parseFloat(order.total);
  return { validatedTotal: totalNoBanco, orderData: order };
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const body = await request.json();

    const token = env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({
        error: 'MERCADO_PAGO_ACCESS_TOKEN não configurado no Cloudflare Pages ou nas configurações da Lunoca.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Validação opcional de usuário logado (se fornecido token Bearer)
    let authUser = null;
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const authCheck = await verifyAuth(request, env);
      if (authCheck.authorized) {
        authUser = authCheck.user;
      }
    }

    const {
      pedidoId,
      total,
      forma, // 'pix' ou 'cartao'
      cliente,
      cardData, // dados do cartão para checkout transparente
      cardToken, // token do cartão já criado
      parcelas,
      paymentMethodId,
      origin
    } = body;

    const baseUrl = getSafeBaseUrl(origin, env);

    // Validação server-side do total e titularidade do pedido
    let amount = parseFloat(total);
    try {
      const { validatedTotal } = await fetchAndValidateOrder(pedidoId, amount, env, authUser);
      if (typeof validatedTotal === 'number' && !isNaN(validatedTotal)) {
        if (Math.abs(validatedTotal - amount) > 0.01) {
          console.warn(`[SEGURANÇA] Divergência de total detectada! Pedido #${pedidoId}: cliente enviou R$${amount}, banco tem R$${validatedTotal}`);
        }
        amount = validatedTotal; // Sempre prioriza o valor seguro do banco
      }
    } catch (valErr) {
      console.error('Erro na validação do pedido:', valErr.message);
      return new Response(JSON.stringify({ error: valErr.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (isNaN(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Valor total inválido para pagamento.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 1. FLUXO PIX TRANSPARENTE
    if (forma === 'pix') {
      const email = cliente?.email || (authUser?.email) || 'cliente@lunocadoceria.com.br';
      const nomeCompleto = (cliente?.nome || authUser?.nome || 'Cliente Lunoca').trim().split(' ');
      const firstName = nomeCompleto[0] || 'Cliente';
      const lastName = nomeCompleto.slice(1).join(' ') || 'Doceria';
      const cpf = (cliente?.cpf || '00000000000').replace(/\D/g, '');

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
            number: cpf.length === 11 ? cpf : '19119119100'
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
        qrCodeBase64: txData.qr_code_base64, // Imagem do QR Code em Base64
        ticketUrl: txData.ticket_url,
        expirationDate: mpData.date_of_expiration
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 2. FLUXO CARTÃO DE CRÉDITO TRANSPARENTE
    if (forma === 'cartao') {
      let finalCardToken = cardToken;

      // Se enviou dados brutos do cartão em vez de token pré-gerado, gerar o token com segurança na API
      if (!finalCardToken && cardData) {
        const cleanCardNumber = String(cardData.numero || '').replace(/\D/g, '');
        const cleanExpMonth = parseInt(cardData.mesExpiracao, 10);
        const cleanExpYear = parseInt(cardData.anoExpiracao.length === 2 ? `20${cardData.anoExpiracao}` : cardData.anoExpiracao, 10);
        const cleanCvv = String(cardData.cvv || '').trim();
        const cleanCpf = String(cardData.cpfTitular || cliente?.cpf || '19119119100').replace(/\D/g, '');

        const tokenPayload = {
          card_number: cleanCardNumber,
          expiration_month: cleanExpMonth,
          expiration_year: cleanExpYear,
          security_code: cleanCvv,
          cardholder: {
            name: cardData.nomeTitular || cliente?.nome || 'TITULAR DO CARTAO',
            identification: {
              type: 'CPF',
              number: cleanCpf.length === 11 ? cleanCpf : '19119119100'
            }
          }
        };

        const tokenRes = await fetch('https://api.mercadopago.com/v1/card_tokens', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(tokenPayload)
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.id) {
          return new Response(JSON.stringify({
            error: tokenData.message || 'Dados do cartão de crédito inválidos ou recusados na validação.',
            details: tokenData
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        finalCardToken = tokenData.id;
      }

      if (!finalCardToken) {
        return new Response(JSON.stringify({ error: 'Token do cartão não fornecido.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const email = cliente?.email || 'cliente@lunocadoceria.com.br';
      const cleanCpf = String(cardData?.cpfTitular || cliente?.cpf || '19119119100').replace(/\D/g, '');

      const cardPaymentPayload = {
        transaction_amount: amount,
        token: finalCardToken,
        description: `Pedido #${pedidoId} - Lunoca Doceria`,
        installments: parseInt(parcelas || 1, 10),
        payment_method_id: paymentMethodId || 'credit_card',
        payer: {
          email: email,
          identification: {
            type: 'CPF',
            number: cleanCpf.length === 11 ? cleanCpf : '19119119100'
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

      // Se aprovado, invocar RPC atômica confirmar_pagamento_pedido (atualiza pedido, baixa estoque e lança financeiro)
      if (mpData.status === 'approved') {
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
        if (supabaseUrl && supabaseKey) {
          try {
            const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/confirmar_pagamento_pedido`, {
              method: 'POST',
              headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                p_pedido_id: Number(pedidoId),
                p_mercado_pago_payment_id: String(mpData.id),
                p_status: mpData.status,
                p_forma_pagamento: 'cartao',
                p_valor: amount
              })
            });

            if (!rpcRes.ok) {
              // Fallback para patch direto em caso de falha na RPC
              await fetch(`${supabaseUrl}/rest/v1/pedidos?id=eq.${pedidoId}`, {
                method: 'PATCH',
                headers: {
                  'apikey': supabaseKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Content-Type': 'application/json',
                  'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                  status: 'Confirmado',
                  mercado_pago_id: String(mpData.id),
                  mercado_pago_status: mpData.status
                })
              }).catch(() => {});
            }
          } catch (confirmErr) {
            console.error('[MercadoPago] Erro ao confirmar pedido atômico:', confirmErr.message);
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
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
