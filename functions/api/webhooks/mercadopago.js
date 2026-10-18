// ==============================================================================
// LUNOCA DOCERIA - Alias de Webhook Mercado Pago
// Rota canônica: /api/webhooks/mercadopago -> reexporta /api/mercadopago/webhook
// Garante compatibilidade total tanto para chamadas com /api/mercadopago/webhook
// quanto para o padrão /api/webhooks/mercadopago configurado no painel do gateway.
// ==============================================================================

import { handleCorsOptions } from '../_cors.js';
export { onRequestPost } from '../mercadopago/webhook.js';

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
