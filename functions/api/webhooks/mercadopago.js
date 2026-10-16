// ==============================================================================
// LUNOCA DOCERIA - Alias de Webhook Mercado Pago
// Rota canônica: /api/webhooks/mercadopago -> reexporta /api/mercadopago/webhook
// Garante compatibilidade total tanto para chamadas com /api/mercadopago/webhook
// quanto para o padrão /api/webhooks/mercadopago configurado no painel do gateway.
// ==============================================================================

export { onRequestPost, onRequestOptions } from '../mercadopago/webhook.js';
