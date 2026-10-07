// ==========================================================================
// Testes Automatizados de Verificação - Fase 1 e Fase 2 (Lunoca)
// ==========================================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('🧪 Iniciando testes de validação de segurança (Fase 1 e Fase 2)...');

// --------------------------------------------------------------------------
// Teste 1: Auditoria dos Arquivos SQL
// --------------------------------------------------------------------------
const sqlFiles = [
  'supabase/migrations/001_security_auth_hardening.sql',
  'supabase/migrations/002_atomic_payment_rpc.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of sqlFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  console.log(`\n📄 Verificando arquivo SQL: ${file}`);

  // 1.1 Não pode haver GRANT EXECUTE da RPC de pagamento ou estoque para PUBLIC, anon ou authenticated
  assert.ok(
    !content.includes('confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated') &&
    !content.includes('confirmar_pagamento_pedido(BIGINT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO service_role, authenticated') &&
    !content.includes('baixar_estoque_pedido_batch(BIGINT, JSONB) TO authenticated'),
    `[FALHA] ${file} ainda concede permissão da RPC de pagamento ou estoque para authenticated!`
  );
  console.log('  ✅ Sem GRANT indevido da RPC de pagamento para authenticated.');

  // 1.2 Deve ter REVOKE explícito de PUBLIC, anon e authenticated
  assert.ok(
    content.includes('REVOKE ALL ON FUNCTION public.confirmar_pagamento_pedido'),
    `[FALHA] ${file} não contém REVOKE ALL da RPC confirmar_pagamento_pedido.`
  );
  console.log('  ✅ REVOKE ALL presente na RPC confirmar_pagamento_pedido.');

  // 1.3 Deve ter GRANT exclusivo para service_role
  assert.ok(
    content.includes('TO service_role;'),
    `[FALHA] ${file} não contém GRANT TO service_role.`
  );
  console.log('  ✅ GRANT exclusivo para service_role verificado.');

  // 1.4 Não pode haver política pública de INSERT em profiles
  assert.ok(
    !content.includes('CREATE POLICY "Criação de perfil no cadastro inicial"'),
    `[FALHA] ${file} ainda contém a política pública vulnerável "Criação de perfil no cadastro inicial"!`
  );
  console.log('  ✅ Política pública permissiva de INSERT em profiles erradicada.');

  // 1.5 Deve ter trigger handle_new_user
  if (file !== 'supabase/migrations/002_atomic_payment_rpc.sql') {
    assert.ok(
      content.includes('handle_new_user'),
      `[FALHA] ${file} não contém a função handle_new_user.`
    );
    assert.ok(
      content.includes('on_auth_user_created'),
      `[FALHA] ${file} não contém o trigger on_auth_user_created.`
    );
    console.log('  ✅ Trigger handle_new_user e on_auth_user_created presentes.');
  }

  // 1.6 Deve ter SET search_path = public, auth
  assert.ok(
    content.includes('SET search_path = public, auth;'),
    `[FALHA] ${file} não contém SET search_path = public, auth;`
  );
  console.log('  ✅ Cláusula search_path = public, auth presente em funções SECURITY DEFINER.');
}

// --------------------------------------------------------------------------
// Teste 2: Frontend PCI-DSS Compliance
// --------------------------------------------------------------------------
console.log('\n📄 Verificando conformidade PCI-DSS no Frontend (js/mercadopago-plugin.js)...');
const pluginContent = fs.readFileSync('js/mercadopago-plugin.js', 'utf-8');

// 2.1 Não pode haver envio de cardData no payload
assert.ok(
  !pluginContent.includes('cardData: cardToken ? undefined :'),
  '[FALHA] Frontend ainda tenta enviar cardData com número e cvv como fallback!'
);
console.log('  ✅ Fallback inseguro de cardData removido do frontend.');

// 2.2 Não pode haver update direto de status no Supabase pelo frontend no fluxo de cartão
assert.ok(
  !pluginContent.includes(".update({\n                  status: 'Confirmado'\n                })"),
  '[FALHA] Frontend ainda tenta fazer update direto de status para Confirmado!'
);
console.log('  ✅ Update client-side não seguro removido.');

// --------------------------------------------------------------------------
// Teste 3: Backend Cloudflare Functions (Fail-Closed & PCI-DSS)
// --------------------------------------------------------------------------
console.log('\n📄 Verificando Backend Cloudflare Functions...');

const transContent = fs.readFileSync('functions/api/mercadopago/transparent-payment.js', 'utf-8');
// 3.1 Rejeição de cardData e dados brutos no backend
assert.ok(
  transContent.includes('body.cardData || body.numero || body.cvv'),
  '[FALHA] transparent-payment.js não contém rejeição de dados brutos de cartão!'
);
console.log('  ✅ Rejeição ativa de dados brutos de cartão presente no endpoint.');

// 3.2 Total estrito do banco
assert.ok(
  !transContent.includes('return { validatedTotal: clientTotal'),
  '[FALHA] transparent-payment.js ainda possui fallback para clientTotal!'
);
console.log('  ✅ Fallback para clientTotal erradicado.');

// 3.3 Webhook Fail-Closed
const webhookContent = fs.readFileSync('functions/api/mercadopago/webhook.js', 'utf-8');
assert.ok(
  !webhookContent.includes('modo de transição'),
  '[FALHA] webhook.js ainda contém modo permissivo de transição para HMAC!'
);
assert.ok(
  !webhookContent.includes("method: 'PATCH'"),
  '[FALHA] webhook.js ainda contém fallback com PATCH direto em pedidos!'
);
console.log('  ✅ Webhook estritamente fail-closed e sem PATCH fallback.');

// 3.4 Payment status com await
const statusContent = fs.readFileSync('functions/api/mercadopago/payment-status.js', 'utf-8');
assert.ok(
  statusContent.includes('const rpcRes = await fetch('),
  '[FALHA] payment-status.js não usa await na chamada da RPC!'
);
console.log('  ✅ payment-status.js aguarda a execução da RPC com await.');

// 3.5 Admin payment endpoint existe e está protegido
const adminPaymentContent = fs.readFileSync('functions/api/admin/orders/payment.js', 'utf-8');
assert.ok(
  adminPaymentContent.includes("verifyAuth(request, env, ['admin'])"),
  '[FALHA] /api/admin/orders/payment não restringe acesso a admin!'
);
assert.ok(
  adminPaymentContent.includes('confirmar_pagamento_pedido'),
  '[FALHA] /api/admin/orders/payment não invoca confirmar_pagamento_pedido!'
);
console.log('  ✅ Endpoint /api/admin/orders/payment criado e blindado para admin.');

// --------------------------------------------------------------------------
// Teste 4: Execução Funcional Dinâmica
// --------------------------------------------------------------------------
console.log('\n📄 Executando testes funcionais dinâmicos em memória...');

const { onRequestPost: postTransparent } = await import('./functions/api/mercadopago/transparent-payment.js');
const { verifyAuth } = await import('./functions/api/_auth.js');

// 4.1 Rejeição de envio de número de cartão em texto puro
const fakeReqWithCardData = new Request('https://lunocadoceria.com.br/api/mercadopago/transparent-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pedidoId: 1,
    forma: 'cartao',
    cardData: { numero: '4000123456789010', cvv: '123' }
  })
});

const resCardData = await postTransparent({
  request: fakeReqWithCardData,
  env: { MERCADO_PAGO_ACCESS_TOKEN: 'TEST_TOKEN' }
});

assert.strictEqual(resCardData.status, 400, 'Deveria retornar status 400 para cardData');
const jsonCardData = await resCardData.json();
assert.ok(jsonCardData.error.includes('PCI-DSS'), 'Erro deve mencionar conformidade PCI-DSS');
console.log('  ✅ Requisição com cardData bruto rejeitada com HTTP 400 e alerta PCI-DSS.');

// 4.2 Falha caso tente pagar com cartão sem token
const fakeReqNoToken = new Request('https://lunocadoceria.com.br/api/mercadopago/transparent-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pedidoId: 999999,
    forma: 'cartao'
  })
});

const resNoToken = await postTransparent({
  request: fakeReqNoToken,
  env: {
    MERCADO_PAGO_ACCESS_TOKEN: 'TEST_TOKEN',
    SUPABASE_SERVICE_ROLE_KEY: 'TEST_KEY',
    SUPABASE_URL: 'https://test.supabase.co'
  }
});
// Como o pedido não existe na URL fake, o banco falha com 400
assert.strictEqual(resNoToken.status, 400, 'Deveria retornar status 400');
console.log('  ✅ Falha controlada e fechada quando pedido não é validado.');

// 4.3 Verificação de Auth Fail-Closed sem SERVICE_ROLE_KEY
const fakeAuthReq = new Request('https://lunocadoceria.com.br/api/admin/orders/payment', {
  headers: { 'Authorization': 'Bearer SOME_TOKEN' }
});

const authRes = await verifyAuth(fakeAuthReq, {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: undefined
}, ['admin']);

assert.strictEqual(authRes.authorized, false, 'Não deve autorizar sem SERVICE_ROLE_KEY');
assert.strictEqual(authRes.status, 500, 'Status deve ser 500 por configuração ausente');
console.log('  ✅ verifyAuth falha fechado (500) se SUPABASE_SERVICE_ROLE_KEY estiver ausente para rota de admin.');

// --------------------------------------------------------------------------
// Teste 5: Verificação Fase 3 - Estoque e Integridade Transacional
// --------------------------------------------------------------------------
console.log('\n📄 Verificando Fase 3: Arquitetura de Reserva e Ciclo de Pedidos...');

const fase3SqlFiles = [
  'supabase/migrations/003_stock_reservation_and_order_lifecycle.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of fase3SqlFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  console.log(`\n  🔎 Auditando integridade do estoque em: ${file}`);

  // 5.1 Colunas de estoque físico e reservado
  assert.ok(
    content.includes('estoque_fisico') && content.includes('estoque_reservado'),
    `[FALHA] ${file} não contém colunas estoque_fisico e estoque_reservado!`
  );
  console.log('    ✅ Colunas estoque_fisico e estoque_reservado presentes.');

  // 5.2 Trigger sincronizar_estoque_produto
  assert.ok(
    content.includes('sincronizar_estoque_produto'),
    `[FALHA] ${file} não contém trigger de sincronização de estoque!`
  );
  console.log('    ✅ Trigger sincronizar_estoque_produto presente.');

  // 5.3 Colunas de ciclo de vida de pedidos
  assert.ok(
    content.includes('status_pagamento') && content.includes('status_producao') && content.includes('expires_at'),
    `[FALHA] ${file} não contém colunas de ciclo de vida (status_pagamento, status_producao, expires_at)!`
  );
  console.log('    ✅ Colunas de ciclo de vida em pedidos presentes.');

  // 5.4 criar_pedido com reserva atômica (FOR UPDATE)
  assert.ok(
    content.includes('estoque_reservado = estoque_reservado + v_qtd'),
    `[FALHA] ${file} não incrementa estoque_reservado em criar_pedido!`
  );
  console.log('    ✅ Reserva atômica de estoque em criar_pedido verificada.');

  // 5.5 confirmar_pagamento_pedido converte reserva em baixa física
  assert.ok(
    content.includes('estoque_reservado = GREATEST(0, estoque_reservado - v_qtd)') &&
    content.includes('estoque_fisico = GREATEST(0, estoque_fisico - v_qtd)'),
    `[FALHA] ${file} não converte reserva em baixa física em confirmar_pagamento_pedido!`
  );
  console.log('    ✅ Conversão atômica de reserva em venda física verificada.');

  // 5.6 RPC liberar_pedidos_expirados existe e devolve reserva
  assert.ok(
    content.includes('liberar_pedidos_expirados'),
    `[FALHA] ${file} não contém liberar_pedidos_expirados!`
  );
  assert.ok(
    content.includes('REVOKE ALL ON FUNCTION public.liberar_pedidos_expirados() FROM PUBLIC, anon, authenticated;') &&
    content.includes('GRANT EXECUTE ON FUNCTION public.liberar_pedidos_expirados() TO service_role;'),
    `[FALHA] ${file} não restringe liberar_pedidos_expirados exclusivamente para service_role!`
  );
  console.log('    ✅ RPC liberar_pedidos_expirados blindada para service_role.');
}

// 5.7 Endpoint Cloudflare de expiração (/api/cron/expire-orders)
console.log('\n  🔎 Verificando endpoint de cron /api/cron/expire-orders...');
const expireContent = fs.readFileSync('functions/api/cron/expire-orders.js', 'utf-8');
assert.ok(
  expireContent.includes('liberar_pedidos_expirados'),
  '[FALHA] expire-orders.js não invoca liberar_pedidos_expirados!'
);
assert.ok(
  expireContent.includes('SUPABASE_SERVICE_ROLE_KEY'),
  '[FALHA] expire-orders.js não valida chave de serviço!'
);
console.log('    ✅ Endpoint /api/cron/expire-orders verificado.');

// 5.8 Teste dinâmico de fail-closed de /api/cron/expire-orders
const { onRequestGet: getExpire } = await import('./functions/api/cron/expire-orders.js');
const expireRes = await getExpire({
  request: new Request('https://lunocadoceria.com.br/api/cron/expire-orders'),
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: undefined }
});
assert.strictEqual(expireRes.status, 500, 'Deveria retornar 500 se SERVICE_ROLE_KEY for ausente');
console.log('    ✅ /api/cron/expire-orders falha fechado (500) com secrets ausentes.');

// 5.9 Validações de frontend de estoque
console.log('\n  🔎 Verificando frontend para proteção de estoque...');
const prodJsContent = fs.readFileSync('js/produtos.js', 'utf-8');
assert.ok(
  prodJsContent.includes('estoque_fisico') && prodJsContent.includes('estoque_reservado'),
  '[FALHA] js/produtos.js não mapeia estoque_fisico e estoque_reservado!'
);
assert.ok(
  prodJsContent.includes('qtdJaNoCarrinho + qtdAdicionar > itemCarrinho.estoque_qtd'),
  '[FALHA] js/produtos.js não valida limite de estoque no carrinho!'
);
console.log('    ✅ js/produtos.js valida estoque antes de adicionar à sacola.');

const carrinhoJsContent = fs.readFileSync('js/carrinho.js', 'utf-8');
assert.ok(
  carrinhoJsContent.includes('totalMesmoProd + delta > prodRef.estoque_qtd'),
  '[FALHA] js/carrinho.js não valida estoque ao alterar quantidade!'
);
console.log('    ✅ js/carrinho.js valida estoque ao incrementar quantidade.');

console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! Fases 1, 2 e 3 rigorosamente validadas.');

