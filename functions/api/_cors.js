// ==========================================================================
// LUNOCA DOCERIA - CORS Helper
// Centraliza a validação de origens permitidas para todas as Cloudflare Functions.
// ==========================================================================

const DEFAULT_ALLOWED_ORIGINS = [
  'https://lunocadoceria.com.br',
  'https://www.lunocadoceria.com.br'
];

/**
 * Retorna os headers CORS adequados com base na origin da request.
 * - Em produção: só permite origens da allowlist.
 * - Em desenvolvimento (localhost): permite automaticamente.
 * - Origens extras podem ser definidas via env.ALLOWED_ORIGINS (comma-separated).
 */
export function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';

  // Monta a lista de origens permitidas
  let allowedOrigins = [...DEFAULT_ALLOWED_ORIGINS];
  if (env && env.ALLOWED_ORIGINS) {
    const extras = env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
    allowedOrigins = allowedOrigins.concat(extras);
  }

  // Permite localhost em desenvolvimento
  const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
  const isAllowed = isLocalhost || allowedOrigins.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

/**
 * Retorna uma Response 204 para preflight OPTIONS com CORS adequado.
 */
export function handleCorsOptions(request, env) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env)
  });
}
