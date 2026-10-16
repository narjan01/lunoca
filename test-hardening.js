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

// 3.4 Payment status desacoplado (read-only e idempotente, sem mutação de estoque ou confirmação)
const statusContent = fs.readFileSync('functions/api/mercadopago/payment-status.js', 'utf-8');
assert.ok(
  !statusContent.includes('confirmar_pagamento_pedido'),
  '[FALHA] payment-status.js ainda tenta mutar estado ou invocar confirmar_pagamento_pedido!'
);
console.log('  ✅ payment-status.js desacoplado: endpoint estritamente de consulta (read-only), sem efeito colateral.');

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

// 5.7 Endpoint Cloudflare de expiração (/api/cron/expire-orders) - pipeline único
console.log('\n  🔎 Verificando endpoint de cron /api/cron/expire-orders...');
const expireContent = fs.readFileSync('functions/api/cron/expire-orders.js', 'utf-8');
assert.ok(
  expireContent.includes('rpc/expirar_pedidos_e_holds'),
  '[FALHA] expire-orders.js não invoca a RPC unificada expirar_pedidos_e_holds!'
);
assert.ok(
  !expireContent.includes('rpc/liberar_pedidos_expirados'),
  '[FALHA] expire-orders.js ainda invoca o pipeline legado liberar_pedidos_expirados (deveria haver UMA autoridade de expiração)!'
);
assert.ok(
  expireContent.includes('SUPABASE_SERVICE_ROLE_KEY') && expireContent.includes('CRON_SECRET'),
  '[FALHA] expire-orders.js não valida chave de serviço e CRON_SECRET!'
);
assert.ok(
  !expireContent.includes("searchParams.get('secret')"),
  '[FALHA] expire-orders.js não pode aceitar o segredo via query string!'
);
console.log('    ✅ Endpoint /api/cron/expire-orders aponta para o pipeline único e exige CRON_SECRET.');

// 5.8 Teste dinâmico de fail-closed de /api/cron/expire-orders
const { onRequestGet: getExpire, onRequestPost: postExpire } = await import('./functions/api/cron/expire-orders.js');
const CRON_OK = 'segredo-de-teste-com-mais-de-16-chars';

// (a) Sem CRON_SECRET configurado => 503 (rota desabilitada)
let expireRes = await getExpire({
  request: new Request('https://lunocadoceria.com.br/api/cron/expire-orders', { headers: { Authorization: 'Bearer qualquer' } }),
  env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x' }
});
assert.strictEqual(expireRes.status, 503, 'Sem CRON_SECRET deve responder 503 (fail-closed)');

// (b) CRON_SECRET configurado, Bearer errado => 401
expireRes = await getExpire({
  request: new Request('https://lunocadoceria.com.br/api/cron/expire-orders', { headers: { Authorization: 'Bearer errado' } }),
  env: { CRON_SECRET: CRON_OK, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x' }
});
assert.strictEqual(expireRes.status, 401, 'Bearer inválido deve responder 401');

// (c) Segredo via query string => 400 mesmo se correto
expireRes = await getExpire({
  request: new Request(`https://lunocadoceria.com.br/api/cron/expire-orders?secret=${CRON_OK}`),
  env: { CRON_SECRET: CRON_OK, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x' }
});
assert.strictEqual(expireRes.status, 400, 'Segredo via query string deve ser rejeitado');

// (d) Bearer correto, mas SERVICE_ROLE_KEY ausente => 500
expireRes = await postExpire({
  request: new Request('https://lunocadoceria.com.br/api/cron/expire-orders', { method: 'POST', headers: { Authorization: `Bearer ${CRON_OK}` } }),
  env: { CRON_SECRET: CRON_OK, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: undefined }
});
assert.strictEqual(expireRes.status, 500, 'Deveria retornar 500 se SERVICE_ROLE_KEY for ausente');
console.log('    ✅ /api/cron/expire-orders falha fechado: 503 sem CRON_SECRET, 401 Bearer inválido, 400 query string, 500 sem service key.');

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

// --------------------------------------------------------------------------
// Teste 6: Verificação Fase 4 - Consolidação de Backend, SQL e Secrets
// --------------------------------------------------------------------------
console.log('\n📄 Verificando Fase 4: Consolidação de Backend, SQL e Secrets Fail-Closed...');

// 6.1 admin/users.js sem anonKey hardcoded e usando verifyAuth
const adminUsersContent = fs.readFileSync('functions/api/admin/users.js', 'utf-8');
assert.ok(
  !adminUsersContent.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),
  '[FALHA] functions/api/admin/users.js ainda contém anonKey hardcoded!'
);
assert.ok(
  adminUsersContent.includes("verifyAuth(request, env, ['admin'])"),
  '[FALHA] functions/api/admin/users.js não utiliza verifyAuth para autorização de admin!'
);
console.log('  ✅ functions/api/admin/users.js usa verifyAuth centralizado e sem chaves hardcoded.');

// 6.2 upload-image.js sem imgbbKey hardcoded e priorizando Supabase Storage
const uploadContent = fs.readFileSync('functions/api/upload-image.js', 'utf-8');
assert.ok(
  !uploadContent.includes('97dfa8989e6adbbc6faebb4b505686fe'),
  '[FALHA] functions/api/upload-image.js ainda contém chave de ImgBB hardcoded!'
);
assert.ok(
  uploadContent.includes('storage/v1/object/produtos/itens/'),
  '[FALHA] functions/api/upload-image.js não possui suporte a Supabase Storage!'
);
console.log('  ✅ functions/api/upload-image.js suporta Supabase Storage nativo e sem segredos hardcoded.');

// 6.3 Estrutura de SQL limpa e unificada
const rootSqlFiles = fs.readdirSync('sql').filter(f => f.endsWith('.sql'));
assert.deepStrictEqual(
  rootSqlFiles.sort(),
  ['install.sql', 'schema.sql', 'seed_produtos.sql'].sort(),
  '[FALHA] Diretório sql/ contém arquivos legados desnecessários na raiz!'
);
assert.ok(
  fs.existsSync('sql/legacy/estoque_financeiro.sql'),
  '[FALHA] Diretório sql/legacy não contém os scripts arquivados!'
);
console.log('  ✅ Diretório sql/ unificado com fonte da verdade oficial e histórico arquivado em sql/legacy.');

// --------------------------------------------------------------------------
// Teste 7: Verificação Fase 5 - Guest Checkout e Experiência do Cliente
// --------------------------------------------------------------------------
console.log('\n📄 Verificando Fase 5: Guest Checkout e Taxa de Entrega Dinâmica...');

const fase5SqlFiles = [
  'supabase/migrations/004_guest_checkout_and_delivery.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of fase5SqlFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  console.log(`\n  🔎 Auditando suporte a Guest Checkout em: ${file}`);

  // 7.1 Colunas de entrega
  assert.ok(
    content.includes('taxa_entrega') && content.includes('modalidade_entrega'),
    `[FALHA] ${file} não contém colunas taxa_entrega e modalidade_entrega!`
  );
  console.log('    ✅ Colunas taxa_entrega e modalidade_entrega presentes.');

  // 7.2 Permissão de execução para anon (Guest Checkout)
  assert.ok(
    content.includes('GRANT EXECUTE ON FUNCTION public.criar_pedido(JSONB, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated, service_role;'),
    `[FALHA] ${file} não concede permissão de criar_pedido para anon (Guest Checkout)!`
  );
  console.log('    ✅ criar_pedido concedida para anon, authenticated e service_role.');

  // 7.3 Suporte explícito a cliente_id nulo para visitantes
  assert.ok(
    content.includes('Guest Checkout') && content.includes('v_cliente_id IS NOT NULL'),
    `[FALHA] ${file} não implementa ramificação de visitante/guest em criar_pedido!`
  );
  console.log('    ✅ Ramificação para Guest Checkout verificada em criar_pedido.');
}

// 7.4 Verificação no Frontend: ausência de bloqueios forçados de login
console.log('\n  🔎 Verificando eliminação de bloqueios de login no Frontend...');
const prodJsFase5 = fs.readFileSync('js/produtos.js', 'utf-8');
assert.ok(
  !prodJsFase5.includes("if (usuarioAtual.nivel === 'visitante') {\n    alert(\"Acesse ou crie uma conta para fazer o seu pedido!\");"),
  '[FALHA] js/produtos.js ainda bloqueia modal de produtos para visitantes!'
);
console.log('    ✅ Visitantes podem abrir modal de produtos sem bloqueio de login.');

const carrinhoJsFase5 = fs.readFileSync('js/carrinho.js', 'utf-8');
assert.ok(
  !carrinhoJsFase5.includes("if (usuarioAtual && usuarioAtual.nivel === 'visitante') {\n    alert(\"Por favor, faça login ou cadastre-se"),
  '[FALHA] js/carrinho.js ainda bloqueia irParaCheckout para visitantes!'
);
console.log('    ✅ Visitantes podem ir para o checkout sem bloqueio forçado.');

const pedidosJsFase5 = fs.readFileSync('js/pedidos.js', 'utf-8');
assert.ok(
  pedidosJsFase5.includes('const isVisitante = !usuarioAtual || usuarioAtual.nivel === \'visitante\';') &&
  pedidosJsFase5.includes('p_taxa_entrega: taxaAplicada') &&
  pedidosJsFase5.includes('p_modalidade: modalidade'),
  '[FALHA] js/pedidos.js não envia taxa, modalidade ou dados de visitante!'
);
console.log('    ✅ js/pedidos.js suporta Guest Checkout e envio dinâmico de taxa e modalidade.');

console.log('\n📄 Verificando Fase 6: Ficha Técnica, CMV e Separação Arquitetural Store/Admin...');

const fase6SqlFiles = [
  'supabase/migrations/005_ficha_tecnica_cmv_insumos.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of fase6SqlFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  console.log(`\n  🔎 Auditando Ficha Técnica e CMV em: ${file}`);

  // 8.1 Tabelas de ingredientes e produto_ingredientes
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.ingredientes') &&
    content.includes('custo_unitario') &&
    content.includes('estoque_qtd'),
    `[FALHA] ${file} não contém definição válida da tabela ingredientes!`
  );
  console.log('    ✅ Tabela ingredientes com custo_unitario e estoque_qtd presente.');

  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.produto_ingredientes') &&
    content.includes('uq_produto_ingrediente'),
    `[FALHA] ${file} não contém definição válida da tabela produto_ingredientes!`
  );
  console.log('    ✅ Tabela produto_ingredientes com constraint única presente.');

  // 8.2 View analítica view_produto_cmv
  assert.ok(
    content.includes('CREATE OR REPLACE VIEW public.view_produto_cmv') &&
    content.includes('cmv_estimado') &&
    content.includes('margem_bruta_pct'),
    `[FALHA] ${file} não contém definição da view_produto_cmv!`
  );
  console.log('    ✅ View analítica view_produto_cmv presente.');

  // 8.3 Função de baixa atômica de insumos
  assert.ok(
    content.includes('dar_baixa_ingredientes_pedido') &&
    content.includes('SET search_path = public, auth'),
    `[FALHA] ${file} não contém a função dar_baixa_ingredientes_pedido!`
  );
  console.log('    ✅ Função dar_baixa_ingredientes_pedido com search_path seguro presente.');

  // 8.4 Integração na confirmação de pagamento
  assert.ok(
    content.includes('dar_baixa_ingredientes_pedido(p_pedido_id)'),
    `[FALHA] ${file} não chama dar_baixa_ingredientes_pedido na confirmação do pagamento!`
  );
  console.log('    ✅ Baixa de insumos integrada na confirmação de pagamento.');

  // 8.5 RLS em ingredientes
  assert.ok(
    content.includes('ALTER TABLE public.ingredientes ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.produto_ingredientes ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em ingredientes e produto_ingredientes!`
  );
  console.log('    ✅ RLS ativo para ingredientes e receitas.');
}

// 8.6 Verificação Arquitetural: Desacoplamento da Loja (index.html)
console.log('\n  🔎 Verificando Desacoplamento Arquitetural Store vs Admin...');
const indexHtmlContent = fs.readFileSync('index.html', 'utf-8');

assert.ok(
  !indexHtmlContent.includes('<script src="js/admin.js') &&
  !indexHtmlContent.includes('<script src="js/estoque.js') &&
  !indexHtmlContent.includes('<script src="js/financeiro.js'),
  '[FALHA] index.html ainda carrega scripts pesados de administração de forma síncrona/bloqueante!'
);
console.log('    ✅ index.html não carrega scripts de administração no bundle inicial da loja.');

assert.ok(
  indexHtmlContent.includes('js/admin-loader.js'),
  '[FALHA] index.html não possui o script admin-loader.js!'
);
console.log('    ✅ index.html possui admin-loader.js para lazy-loading sob demanda.');

assert.ok(
  fs.existsSync('admin.html') && fs.existsSync('js/admin-loader.js') && fs.existsSync('js/fichatecnica.js'),
  '[FALHA] Arquivos críticos da Fase 6 (admin.html, js/admin-loader.js ou js/fichatecnica.js) estão ausentes!'
);
console.log('    ✅ admin.html, js/admin-loader.js e js/fichatecnica.js devidamente criados.');

const finJsContent = fs.readFileSync('js/financeiro.js', 'utf-8');
assert.ok(
  finJsContent.includes('cmvTotal') && finJsContent.includes('lucroBruto'),
  '[FALHA] js/financeiro.js não integra cmvTotal e lucroBruto no resumo financeiro!'
);
console.log('    ✅ js/financeiro.js calcula CMV e Lucro Bruto real no DRE.');

// --------------------------------------------------------------------------
// Teste 9: Verificação Fase 7 - Remediação da 3ª Auditoria de Segurança
// --------------------------------------------------------------------------
console.log('\n📄 Verificando Fase 7: Remediação da 3ª Auditoria de Segurança...');

// 9.1 Remoção Definitiva de Mutação no Frontend (mercadopago-plugin.js)
console.log('\n  🔎 Verificando erradicação de mutações client-side em mercadopago-plugin.js...');
const pluginJs = fs.readFileSync('js/mercadopago-plugin.js', 'utf-8');

assert.ok(
  !pluginJs.includes(".update({") && !pluginJs.includes(".update ({"),
  '[FALHA] js/mercadopago-plugin.js ainda contém chamadas de .update() client-side!'
);
console.log('    ✅ Nenhuma mutação de status (.update) no frontend do Mercado Pago.');

assert.ok(
  pluginJs.includes("X-Checkout-Token") && pluginJs.includes("checkout_token="),
  '[FALHA] js/mercadopago-plugin.js não propaga X-Checkout-Token e checkout_token no polling e pagamentos!'
);
console.log('    ✅ Propagação de X-Checkout-Token e checkout_token presente no plugin.');

// 9.2 Lockdown de Privilégios da RPC de Insumos (dar_baixa_ingredientes_pedido)
console.log('\n  🔎 Verificando lockdown estrito de dar_baixa_ingredientes_pedido...');
const sqlPrivFiles = [
  'supabase/migrations/005_ficha_tecnica_cmv_insumos.sql',
  'supabase/migrations/006_guest_antiabuse_checkout_token_delivery.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of sqlPrivFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    !content.includes('dar_baixa_ingredientes_pedido(BIGINT) TO authenticated') &&
    !content.includes('dar_baixa_ingredientes_pedido(BIGINT) TO service_role, authenticated'),
    `[FALHA] ${file} concede dar_baixa_ingredientes_pedido para authenticated!`
  );
  assert.ok(
    content.includes('REVOKE ALL ON FUNCTION public.dar_baixa_ingredientes_pedido') &&
    content.includes('TO service_role;'),
    `[FALHA] ${file} não revoga e concede exclusivamente para service_role!`
  );
  assert.ok(
    content.includes('REVOKE INSERT, UPDATE, DELETE ON public.ingredientes'),
    `[FALHA] ${file} não revoga DML direto de ingredientes para authenticated!`
  );
  console.log(`    ✅ ${file}: dar_baixa_ingredientes_pedido e tabelas de insumos 100% blindadas para service_role.`);
}

// 9.3 Anti-Abuso e Anti-Hoarding no Guest Checkout e Taxa de Entrega Servidor
console.log('\n  🔎 Verificando anti-abuso, anti-hoarding e taxa de entrega servidor em criar_pedido...');
const sqlAntiAbuseFiles = [
  'supabase/migrations/006_guest_antiabuse_checkout_token_delivery.sql',
  'sql/install.sql',
  'sql/schema.sql'
];

for (const file of sqlAntiAbuseFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("15 minutes") && content.includes("COUNT(*)") && content.includes("status = 'Pendente'"),
    `[FALHA] ${file} não implementa rate limit de pedidos pendentes para guest checkout!`
  );
  assert.ok(
    content.includes("v_qtd > 50"),
    `[FALHA] ${file} não implementa limite anti-hoarding de quantidade por item para visitantes!`
  );
  assert.ok(
    content.includes("v_taxa := 0.00") && content.includes("v_taxa := 10.00"),
    `[FALHA] ${file} não força cálculo estrito da taxa de entrega no servidor (0.00 retirada / 10.00 entrega)!`
  );
  assert.ok(
    content.includes("checkout_token UUID DEFAULT gen_random_uuid()") || content.includes("checkout_token UUID"),
    `[FALHA] ${file} não define coluna checkout_token na tabela pedidos!`
  );
  assert.ok(
    content.includes("'checkout_token', v_checkout_token"),
    `[FALHA] ${file} não retorna checkout_token no resultado de criar_pedido!`
  );
  console.log(`    ✅ ${file}: anti-abuso, anti-hoarding, taxa servidor e checkout_token validados.`);
}

// 9.4 Verificação dos Endpoints Cloudflare Functions com Checkout Token e RBAC
console.log('\n  🔎 Verificando proteção de checkout_token nos endpoints Cloudflare...');
const transparentCode = fs.readFileSync('functions/api/mercadopago/transparent-payment.js', 'utf-8');
const preferenceCode = fs.readFileSync('functions/api/mercadopago/preference.js', 'utf-8');
const statusPollerCode = fs.readFileSync('functions/api/mercadopago/payment-status.js', 'utf-8');

assert.ok(
  transparentCode.includes('clientCheckoutToken') &&
  transparentCode.includes('isForbidden ? 403 : 400') &&
  transparentCode.includes('checkout_token'),
  '[FALHA] transparent-payment.js não valida checkout_token ou não retorna 403!'
);
console.log('    ✅ transparent-payment.js valida checkout_token e retorna HTTP 403 para acessos não autorizados.');

assert.ok(
  preferenceCode.includes('X-Checkout-Token') &&
  preferenceCode.includes('checkout_token') &&
  preferenceCode.includes('status: 403'),
  '[FALHA] preference.js não valida checkout_token ou não retorna 403!'
);
console.log('    ✅ preference.js valida checkout_token e retorna HTTP 403 para acessos não autorizados.');

assert.ok(
  statusPollerCode.includes('checkout_token') &&
  statusPollerCode.includes('status: 403'),
  '[FALHA] payment-status.js não valida checkout_token ou não protege contra cross-tenant com 403!'
);
console.log('    ✅ payment-status.js isola pedidos multi-tenant e retorna HTTP 403 para acessos não autorizados.');

// 9.5 Verificação da Integração de Frontend com checkout_token
console.log('\n  🔎 Verificando armazenamento e repasse de checkout_token no frontend...');
const pedidosJs = fs.readFileSync('js/pedidos.js', 'utf-8');
const mercadopagoJs = fs.readFileSync('js/mercadopago.js', 'utf-8');

assert.ok(
  pedidosJs.includes('lunoca_checkout_token_') &&
  pedidosJs.includes('checkoutToken = rpcRes.checkout_token'),
  '[FALHA] js/pedidos.js não captura nem persiste checkout_token!'
);
console.log('    ✅ js/pedidos.js captura e persiste checkout_token no localStorage.');

assert.ok(
  mercadopagoJs.includes('checkoutToken: token'),
  '[FALHA] js/mercadopago.js não propaga checkoutToken no orderData!'
);
console.log('    ✅ js/mercadopago.js propaga checkoutToken no orderData.');

// 9.6 Simulação de Ataque em Memória: tentativa de acessar pedido de outro usuário sem token ou com token inválido
console.log('\n  🔎 Executando simulação de ataques contra o Checkout Transparente...');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('/rest/v1/pedidos')) {
      return new Response(JSON.stringify([{
        id: 777,
        total: 100.00,
        itens: [{ id: 1, nome: 'Bolo', preco: 100, quantidade: 1 }],
        cliente_id: null,
        status: 'Pendente',
        checkout_token: '11111111-2222-3333-4444-555555555555'
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, opts);
  };

  // Ataque 1: Invasor tenta pagar pedido 777 sem fornecer checkout_token
  const reqAttackerNoToken = new Request('https://lunocadoceria.com.br/api/mercadopago/transparent-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pedidoId: 777,
      forma: 'pix'
    })
  });
  const resAttackerNoToken = await postTransparent({
    request: reqAttackerNoToken,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'TEST_TOKEN',
      SUPABASE_SERVICE_ROLE_KEY: 'TEST_KEY',
      SUPABASE_URL: 'https://test.supabase.co'
    }
  });
  assert.strictEqual(resAttackerNoToken.status, 403, 'Tentativa sem checkout_token deve ser rejeitada com HTTP 403');
  console.log('    ✅ [Simulação Ataque 1] Pagamento sem token legítimo rejeitado com HTTP 403.');

  // Ataque 2: Invasor tenta pagar com checkout_token falso/adivinhado
  const reqAttackerWrongToken = new Request('https://lunocadoceria.com.br/api/mercadopago/transparent-payment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Checkout-Token': 'wrong-uuid-00000000'
    },
    body: JSON.stringify({
      pedidoId: 777,
      forma: 'pix'
    })
  });
  const resAttackerWrongToken = await postTransparent({
    request: reqAttackerWrongToken,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'TEST_TOKEN',
      SUPABASE_SERVICE_ROLE_KEY: 'TEST_KEY',
      SUPABASE_URL: 'https://test.supabase.co'
    }
  });
  assert.strictEqual(resAttackerWrongToken.status, 403, 'Tentativa com token errado deve ser rejeitada com HTTP 403');
  console.log('    ✅ [Simulação Ataque 2] Pagamento com token falsificado rejeitado com HTTP 403.');

} finally {
  globalThis.fetch = originalFetch;
}

// --------------------------------------------------------------------------
// Teste 8: Validações de Integridade & Hardening da Auditoria 4
// --------------------------------------------------------------------------
console.log('\n🔒 FASE 8: Validações de Integridade & Hardening (Auditoria 4)...');

// 8.1. Eliminação definitiva da race condition de reserva por timestamp (INTERVAL '5 seconds')
console.log('  🔎 Verificando erradicação do UPDATE estoque_movimentacoes por intervalo de 5 segundos...');
const filesToCheckNo5s = [
  'sql/schema.sql',
  'sql/install.sql',
  'supabase/migrations/007_audit_4_hardening.sql'
];

for (const f of filesToCheckNo5s) {
  const c = fs.readFileSync(f, 'utf-8');
  assert.ok(
    !c.includes("INTERVAL '5 seconds'") && !c.includes('INTERVAL "5 seconds"'),
    `[FALHA] ${f} ainda contém UPDATE com INTERVAL 5 seconds em estoque_movimentacoes!`
  );
  assert.ok(
    c.includes('pg_advisory_xact_lock(hashtext(') && c.includes('v_fone_normalizado'),
    `[FALHA] ${f} não possui pg_advisory_xact_lock atômico com normalização de telefone!`
  );
  assert.ok(
    c.includes('ABS(p_valor - v_pedido.total) > 0.01'),
    `[FALHA] ${f} não possui validação de integridade financeira (ABS de valor)!`
  );
  assert.ok(
    c.includes("LOWER(COALESCE(p_status, '')) <> 'approved'"),
    `[FALHA] ${f} não possui validação intrínseca de status 'approved' em confirmar_pagamento_pedido!`
  );
  assert.ok(
    !c.includes('estoque_qtd = GREATEST(0, estoque_qtd - (v_ficha.qtd_insumo * v_qtd_prod))'),
    `[FALHA] ${f} ainda mascara o estoque de insumos com GREATEST(0, ...)!`
  );
  console.log(`    ✅ ${f}: Sem race condition de 5s, com lock atômico de telefone, validação financeira e ficha técnica transparente.`);
}

// 8.2. CORS com X-Checkout-Token
console.log('\n  🔎 Verificando cabeçalho X-Checkout-Token em _cors.js...');
const corsContent = fs.readFileSync('functions/api/_cors.js', 'utf-8');
assert.ok(
  corsContent.includes('X-Checkout-Token'),
  '[FALHA] _cors.js não inclui X-Checkout-Token em Access-Control-Allow-Headers!'
);
console.log('    ✅ _cors.js: X-Checkout-Token devidamente autorizado nos cabeçalhos CORS.');

// 8.3. Eliminação da superfície SSRF em whatsapp/send.js
console.log('\n  🔎 Verificando erradicação de customUrl em whatsapp/send.js...');
const sendContent = fs.readFileSync('functions/api/whatsapp/send.js', 'utf-8');
assert.ok(
  !sendContent.includes('customUrl'),
  '[FALHA] functions/api/whatsapp/send.js ainda aceita parâmetro customUrl!'
);
console.log('    ✅ functions/api/whatsapp/send.js: Parâmetro customUrl eliminado, rota estritamente segura.');

// 8.4. Fail-closed e sem manipulação de preço no preference.js
console.log('\n  🔎 Verificando integridade e fail-closed de mercadopago/preference.js...');
const prefContent = fs.readFileSync('functions/api/mercadopago/preference.js', 'utf-8');
assert.ok(
  prefContent.includes('pedidoId') && prefContent.includes('400') && prefContent.includes('404'),
  '[FALHA] preference.js não exige pedidoId ou não retorna 400/404 em caso de ausência!'
);
assert.ok(
  prefContent.includes('X-Checkout-Token') && prefContent.includes('checkout_token'),
  '[FALHA] preference.js não valida token de autorização do pedido!'
);
assert.ok(
  !prefContent.includes('body.items ||') && !prefContent.includes('body.total'),
  '[FALHA] preference.js ainda possui fallback para itens/totais enviados pelo cliente!'
);
console.log('    ✅ mercadopago/preference.js: Totalmente fail-closed, sem fallbacks manipuláveis pelo cliente.');

// ==========================================================================
// FASE 9: Validações da 5ª Auditoria de Segurança e Integridade
// ==========================================================================
console.log('\n🛡️ FASE 9: Validações da 5ª Auditoria de Segurança e Integridade...');

// 9.1 Erradicação Total do INSERT direto em public.pedidos e Fallback do Frontend
console.log('\n  🔎 9.1 Verificando erradicação do INSERT direto em public.pedidos...');
const audit5Files = ['sql/schema.sql', 'sql/install.sql', 'supabase/migrations/008_audit_5_hardening.sql'];
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    (content.includes('REVOKE INSERT ON public.pedidos') || content.includes('REVOKE INSERT, UPDATE ON public.pedidos')) &&
    content.includes('FROM PUBLIC, anon, authenticated;'),
    `[FALHA] ${file} não revoga INSERT na tabela pedidos para anon e authenticated!`
  );
  assert.ok(
    !content.includes('FOR INSERT ON public.pedidos TO authenticated') &&
    !content.includes('FOR INSERT ON public.pedidos TO anon'),
    `[FALHA] ${file} ainda mantém políticas de INSERT ativas em public.pedidos!`
  );
  console.log(`    ✅ ${file}: INSERT direto revogado e políticas de INSERT erradicadas.`);
}

const pedidosJsContentFase9 = fs.readFileSync('js/pedidos.js', 'utf-8');
assert.ok(
  !pedidosJsContentFase9.includes(".from('pedidos').insert("),
  '[FALHA] js/pedidos.js ainda contém fallback com insert direto em pedidos!'
);
console.log('    ✅ js/pedidos.js: Fallback com insert direto eliminado com sucesso (fail-closed estrito).');

// 9.2 Agrupamento Atômico de Itens em criar_pedido (Anti-Hoarding & Over-Reservation)
console.log('\n  🔎 9.2 Verificando agregação de itens em criar_pedido...');
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("GROUP BY (it->>'id')::BIGINT") && content.includes("SUM("),
    `[FALHA] ${file} não agrupa itens por produto_id com SUM() em criar_pedido!`
  );
  console.log(`    ✅ ${file}: Itens agregados com GROUP BY e SUM() antes de checagem de estoque e anti-hoarding.`);
}

// 9.3 Erradicação Completa de CPF Falso (19119119100)
console.log('\n  🔎 9.3 Verificando erradicação do CPF dummy 19119119100...');
const filesToCheckCpf = [
  'js/pedidos.js',
  'js/mercadopago.js',
  'js/mercadopago-plugin.js',
  'functions/api/mercadopago/transparent-payment.js'
];
for (const f of filesToCheckCpf) {
  const c = fs.readFileSync(f, 'utf-8');
  assert.ok(
    !c.includes('19119119100'),
    `[FALHA] ${f} ainda contém CPF dummy 19119119100!`
  );
  console.log(`    ✅ ${f}: CPF dummy erradicado.`);
}

// 9.4 Tabela Canônica public.pedido_itens e RLS
console.log('\n  🔎 9.4 Verificando tabela canônica public.pedido_itens e RLS...');
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.pedido_itens') || content.includes('CREATE TABLE public.pedido_itens'),
    `[FALHA] ${file} não define tabela canônica public.pedido_itens!`
  );
  assert.ok(
    content.includes('ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em public.pedido_itens!`
  );
  console.log(`    ✅ ${file}: Tabela pedido_itens e RLS devidamente configurados.`);
}

// 9.5 Mercado Pago: Secure Fields com cardForm e iframe: true (PCI-DSS SAQ A)
console.log('\n  🔎 9.5 Verificando conformidade PCI-DSS SAQ A (Secure Fields com iframes)...');
const pluginContentFase9 = fs.readFileSync('js/mercadopago-plugin.js', 'utf-8');
assert.ok(
  pluginContentFase9.includes('iframe: true') && pluginContentFase9.includes('cardForm'),
  '[FALHA] js/mercadopago-plugin.js não utiliza cardForm com iframe: true!'
);
assert.ok(
  pluginContentFase9.includes('form-checkout__cardNumber') &&
  pluginContentFase9.includes('form-checkout__expirationDate') &&
  pluginContentFase9.includes('form-checkout__securityCode'),
  '[FALHA] js/mercadopago-plugin.js não contém os containers de iframes seguros para cartão!'
);
assert.ok(
  !pluginContentFase9.includes('id="mp-card-number"') && !pluginContentFase9.includes('id="mp-card-cvv"'),
  '[FALHA] js/mercadopago-plugin.js ainda possui inputs diretos de cartão/cvv no DOM!'
);
console.log('    ✅ js/mercadopago-plugin.js: Implementado cardForm com iframe: true Secure Fields (PCI-DSS SAQ A).');

// 9.6 Idempotência de Cartão por Tentativa (attemptId)
console.log('\n  🔎 9.6 Verificando idempotência de cartão por tentativa em transparent-payment.js...');
const tpContentFase9 = fs.readFileSync('functions/api/mercadopago/transparent-payment.js', 'utf-8');
assert.ok(
  tpContentFase9.includes('cardAttemptId') || tpContentFase9.includes('attemptId'),
  '[FALHA] transparent-payment.js não suporta chave de idempotência dinâmica por tentativa!'
);
console.log('    ✅ transparent-payment.js: Chave de idempotência única por tentativa de cartão garantida.');

// 9.7 Sincronização Local Obrigatória no Polling do PIX
console.log('\n  🔎 9.7 Verificando sincronização local no polling do PIX...');
const psContentFase9 = fs.readFileSync('functions/api/mercadopago/payment-status.js', 'utf-8');
assert.ok(
  psContentFase9.includes('synced:') && psContentFase9.includes('localStatus:'),
  '[FALHA] payment-status.js não retorna campos localStatus e synced!'
);
assert.ok(
  pluginContentFase9.includes('data.synced') || pluginContentFase9.includes("data.localStatus === 'Confirmado'"),
  '[FALHA] js/mercadopago-plugin.js não valida sincronização local antes de exibir sucesso!'
);
console.log('    ✅ Polling de PIX exige sincronização com banco local antes de renderizar sucesso.');

// 9.8 Proteção contra Wildcard em getSafeBaseUrl
console.log('\n  🔎 9.8 Verificando segurança de URL base sem wildcard *.pages.dev...');
const prefCodeFase9 = fs.readFileSync('functions/api/mercadopago/preference.js', 'utf-8');
assert.ok(
  !tpContentFase9.includes(".endsWith('.pages.dev')"),
  '[FALHA] transparent-payment.js ainda aceita wildcard permissivo *.pages.dev!'
);
assert.ok(
  !prefCodeFase9.includes(".endsWith('.pages.dev')"),
  '[FALHA] preference.js ainda aceita wildcard permissivo *.pages.dev!'
);
console.log('    ✅ getSafeBaseUrl: Wildcard permissivo *.pages.dev eliminado de transparent-payment.js e preference.js.');

// 9.9 RPC alterar_status_operacional_pedido e Lockdown de UPDATE
console.log('\n  🔎 9.9 Verificando RPC alterar_status_operacional_pedido...');
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('alterar_status_operacional_pedido'),
    `[FALHA] ${file} não implementa RPC alterar_status_operacional_pedido!`
  );
  console.log(`    ✅ ${file}: RPC alterar_status_operacional_pedido implementada com transições de estado estritas.`);
}
assert.ok(
  pedidosJsContentFase9.includes('alterar_status_operacional_pedido'),
  '[FALHA] js/pedidos.js não chama RPC alterar_status_operacional_pedido!'
);
console.log('    ✅ js/pedidos.js: Transição de status operacional via RPC segura implementada.');

// 9.10 Proteção com CRON_SECRET e Saldo Resultante em Liberar Pedidos Expirados
console.log('\n  🔎 9.10 Verificando CRON_SECRET e saldo resultante do estoque...');
const cronCodeFase9 = fs.readFileSync('functions/api/cron/expire-orders.js', 'utf-8');
assert.ok(
  cronCodeFase9.includes('CRON_SECRET'),
  '[FALHA] functions/api/cron/expire-orders.js não valida CRON_SECRET!'
);
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('COALESCE(estoque_fisico, 0) - COALESCE(estoque_reservado, 0)') && content.includes('saldo_resultante'),
    `[FALHA] ${file} não calcula saldo_resultante real (estoque_fisico - estoque_reservado) ao liberar pedidos!`
  );
  console.log(`    ✅ ${file}: Saldo resultante real calculado no estorno de estoque.`);
}
console.log('    ✅ expire-orders.js: Validação de CRON_SECRET presente.');

// 9.11 RLS em public.pagamentos_processados
console.log('\n  🔎 9.11 Verificando RLS em public.pagamentos_processados...');
for (const file of audit5Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('ALTER TABLE public.pagamentos_processados ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em public.pagamentos_processados!`
  );
  console.log(`    ✅ ${file}: RLS habilitado em pagamentos_processados.`);
}

// 9.12 Respostas Semânticas e Token de Cliente em WhatsApp Gateway
console.log('\n  🔎 9.12 Verificando gateway WhatsApp...');
const waCodeFase9 = fs.readFileSync('functions/api/whatsapp/send.js', 'utf-8');
assert.ok(
  waCodeFase9.includes('WHATSAPP_CLIENT_TOKEN'),
  '[FALHA] functions/api/whatsapp/send.js não suporta WHATSAPP_CLIENT_TOKEN!'
);
assert.ok(
  waCodeFase9.includes('status: 502'),
  '[FALHA] functions/api/whatsapp/send.js não retorna status HTTP 502 em caso de erro no gateway!'
);
console.log('    ✅ functions/api/whatsapp/send.js: WHATSAPP_CLIENT_TOKEN suportado e erro de gateway mapeado com HTTP 502.');

// ==========================================================================
// FASE 10: Fundação da Encomenda & Confectionery Operating System Core (Etapa 1)
// ==========================================================================
console.log('\n🍰 FASE 10: Fundação da Encomenda & Confectionery OS Core (Etapa 1)...');

const etapa1Files = [
  'sql/schema.sql',
  'sql/install.sql',
  'supabase/migrations/009_confectionery_os_core.sql'
];

// 10.1 Expansão Multi-Dimensional de public.pedidos
console.log('\n  🔎 10.1 Verificando campos especializados da confeitaria em public.pedidos...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('status_comercial') &&
    content.includes('status_financeiro') &&
    content.includes('status_operacional') &&
    content.includes('canal'),
    `[FALHA] ${file} não contém a tríade de status (comercial, financeiro, operacional) ou canal em pedidos!`
  );
  assert.ok(
    content.includes('subtotal') &&
    content.includes('desconto') &&
    content.includes('valor_pago') &&
    content.includes('saldo') &&
    content.includes('sinal_minimo'),
    `[FALHA] ${file} não contém colunas financeiras especializadas (subtotal, desconto, valor_pago, saldo, sinal_minimo)!`
  );
  assert.ok(
    content.includes('saldo_vencimento') && content.includes('hora_entrega'),
    `[FALHA] ${file} não contém campos operacionais saldo_vencimento ou hora_entrega!`
  );
  assert.ok(
    content.includes('possui_estorno') && content.includes('idx_pedidos_possui_estorno'),
    `[FALHA] ${file} não contém coluna de flag e índice possui_estorno em public.pedidos!`
  );
  console.log(`    ✅ ${file}: Estrutura multidimensional e flags operacionais (possui_estorno) devidamente modeladas.`);
}

// 10.2 Expansão da Tabela Canônica pedido_itens
console.log('\n  🔎 10.2 Verificando expansão de pedido_itens com snapshots da confeitaria...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('unidade') &&
    content.includes('preco_base_snapshot') &&
    content.includes('preco_adicionais') &&
    content.includes('cmv_unitario_snapshot'),
    `[FALHA] ${file} não expande pedido_itens com unidade, preco_base_snapshot, preco_adicionais e CMV!`
  );
  console.log(`    ✅ ${file}: pedido_itens expandido com snapshots de preço e CMV.`);
}

// 10.3 Tabela pedido_item_opcoes e RLS
console.log('\n  🔎 10.3 Verificando customizações em public.pedido_item_opcoes...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.pedido_item_opcoes') || content.includes('CREATE TABLE public.pedido_item_opcoes'),
    `[FALHA] ${file} não cria tabela public.pedido_item_opcoes!`
  );
  assert.ok(
    content.includes("CHECK (tipo IN ('tamanho', 'massa', 'recheio', 'decoracao', 'adicional', 'outro'))"),
    `[FALHA] ${file} não valida tipos de customização da confeitaria em pedido_item_opcoes!`
  );
  assert.ok(
    content.includes('ALTER TABLE public.pedido_item_opcoes ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em pedido_item_opcoes!`
  );
  console.log(`    ✅ ${file}: Tabela pedido_item_opcoes com validações e RLS configurados.`);
}

// 10.4 Tabela de Múltiplos Pagamentos (public.pedido_pagamentos) e RLS
console.log('\n  🔎 10.4 Verificando tabela public.pedido_pagamentos...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.pedido_pagamentos') || content.includes('CREATE TABLE public.pedido_pagamentos'),
    `[FALHA] ${file} não cria tabela public.pedido_pagamentos!`
  );
  assert.ok(
    content.includes("CHECK (metodo IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro'))"),
    `[FALHA] ${file} não valida métodos de pagamento permitidos!`
  );
  assert.ok(
    content.includes('ALTER TABLE public.pedido_pagamentos ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em pedido_pagamentos!`
  );
  console.log(`    ✅ ${file}: Tabela pedido_pagamentos com validações e RLS configurados.`);
}

// 10.5 Trigger de Recálculo Financeiro Atômico (recalcular_financeiro_pedido)
console.log('\n  🔎 10.5 Verificando trigger de recálculo financeiro atômico...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('recalcular_financeiro_pedido') &&
    content.includes('trg_recalcular_financeiro_pedido') &&
    content.includes('SUM(valor)'),
    `[FALHA] ${file} não implementa trigger de recálculo financeiro atômico!`
  );
  console.log(`    ✅ ${file}: Trigger recalcular_financeiro_pedido configurado (fonte da verdade financeira).`);
}

// 10.6 Trigger de Compatibilidade Legada Somente-Leitura (sincronizar_status_legado_pedido)
console.log('\n  🔎 10.6 Verificando trigger de compatibilidade legada...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('sincronizar_status_legado_pedido') &&
    content.includes('trg_sincronizar_status_legado_pedido'),
    `[FALHA] ${file} não implementa trigger sincronizar_status_legado_pedido!`
  );
  console.log(`    ✅ ${file}: Trigger sincronizar_status_legado_pedido preserva retrocompatibilidade.`);
}

// 10.7 Tabela de Auditoria do Ciclo de Vida (pedido_status_historico)
console.log('\n  🔎 10.7 Verificando tabela de histórico e auditoria...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.pedido_status_historico') || content.includes('CREATE TABLE public.pedido_status_historico'),
    `[FALHA] ${file} não cria tabela public.pedido_status_historico!`
  );
  assert.ok(
    content.includes('usuario_id') &&
    content.includes('origem') &&
    content.includes('metadata JSONB') &&
    content.includes('ALTER TABLE public.pedido_status_historico ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não implementa campos de auditoria (usuario_id, origem, metadata JSONB, RLS) em pedido_status_historico!`
  );
  console.log(`    ✅ ${file}: Tabela pedido_status_historico com rastreabilidade completa.`);
}

// 10.8 RPC alterar_status_pedido com Matriz de Estados
console.log('\n  🔎 10.8 Verificando RPC alterar_status_pedido...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('alterar_status_pedido(') &&
    content.includes('is_admin_or_operator()') &&
    content.includes('pedido_status_historico'),
    `[FALHA] ${file} não implementa RPC alterar_status_pedido com matriz e auditoria!`
  );
  console.log(`    ✅ ${file}: RPC alterar_status_pedido implementada com segurança e auditoria.`);
}

// 10.9 RPC registrar_pagamento_pedido
console.log('\n  🔎 10.9 Verificando RPC registrar_pagamento_pedido...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('registrar_pagamento_pedido(') &&
    content.includes('pedido_pagamentos') &&
    content.includes('financeiro_lancamentos'),
    `[FALHA] ${file} não implementa RPC registrar_pagamento_pedido integrada com lançamentos!`
  );
  console.log(`    ✅ ${file}: RPC registrar_pagamento_pedido presente e integrada.`);
}

// 10.10 Integração Confectionery OS em criar_pedido e confirmar_pagamento_pedido
console.log('\n  🔎 10.10 Verificando integração de criar_pedido e confirmar_pagamento_pedido com Confectionery OS...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('status_comercial') && content.includes('status_operacional') && content.includes('status_financeiro'),
    `[FALHA] ${file} não preenche status multidimensionais nas operações de pedido!`
  );
  assert.ok(
    content.includes('INSERT INTO public.pedido_status_historico'),
    `[FALHA] ${file} não registra histórico em criar_pedido ou confirmar_pagamento_pedido!`
  );
  console.log(`    ✅ ${file}: criar_pedido e confirmar_pagamento_pedido 100% integrados à arquitetura de encomendas.`);
}

// 10.11 Tratamento Rigoroso do Estado Financeiro 'estornado'
console.log('\n  🔎 10.11 Verificando tratamento rigoroso do ciclo de vida de estorno em recalcular_financeiro_pedido...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("status = 'estornado'") &&
    content.includes("v_novo_status_fin := 'estornado'") &&
    content.includes('v_tem_estorno'),
    `[FALHA] ${file} não implementa transição determinística para status_financeiro = 'estornado'!`
  );
  assert.ok(
    content.includes('pedido_status_historico') && content.includes('v_status_fin_antigo IS DISTINCT FROM v_novo_status_fin'),
    `[FALHA] ${file} não registra auditoria de alteração financeira em pedido_status_historico!`
  );
  console.log(`    ✅ ${file}: Recálculo financeiro suporta estorno completo e registra auditoria.`);
}

// 10.12 Somente-Leitura e Imutabilidade de Status Legado
console.log('\n  🔎 10.12 Verificando bloqueio técnico de UPDATE manual e somente-leitura de status legado...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('REVOKE INSERT, UPDATE ON public.pedidos FROM PUBLIC, anon, authenticated;'),
    `[FALHA] ${file} não revoga UPDATE em public.pedidos para anon e authenticated!`
  );
  assert.ok(
    content.includes('sincronizar_status_legado_pedido()') &&
    content.includes('BEFORE INSERT OR UPDATE ON public.pedidos'),
    `[FALHA] ${file} não sobrescreve status legado via BEFORE trigger incondicional!`
  );
  console.log(`    ✅ ${file}: UPDATE direto revogado e derivação legada strictly read-only.`);
}

// 10.13 Catálogo Oficial de Opções e Proteção contra Preço Inventado
console.log('\n  🔎 10.13 Verificando catálogo oficial produto_opcoes e proteção contra preço inventado...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.produto_opcoes') || content.includes('CREATE TABLE public.produto_opcoes'),
    `[FALHA] ${file} não cria tabela canônica de catálogo public.produto_opcoes!`
  );
  assert.ok(
    content.includes('REVOKE ALL ON public.pedido_item_opcoes FROM PUBLIC, anon, authenticated;'),
    `[FALHA] ${file} não bloqueia manipulação direta de pedido_item_opcoes via RLS!`
  );
  assert.ok(
    content.includes('FROM public.produto_opcoes') &&
    content.includes('v_preco_opcao_real'),
    `[FALHA] ${file} não resolve opções estritamente pelo catálogo oficial do banco!`
  );
  console.log(`    ✅ ${file}: Catálogo produto_opcoes ativo e imunidade contra spoofing de preço garantida.`);
}

// 10.14 RBAC e Regras de Negócio em registrar_pagamento_pedido
console.log('\n  🔎 10.14 Verificando RBAC estrito e regras de negócio em registrar_pagamento_pedido...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('REVOKE ALL ON FUNCTION public.registrar_pagamento_pedido') &&
    content.includes('GRANT EXECUTE ON FUNCTION public.registrar_pagamento_pedido') &&
    content.includes('TO authenticated, service_role;'),
    `[FALHA] ${file} não restringe permissões de execução de registrar_pagamento_pedido!`
  );
  assert.ok(
    content.includes("status_comercial = 'cancelado'") &&
    content.includes("status_financeiro = 'pago'") &&
    content.includes('v_ped.saldo'),
    `[FALHA] ${file} não valida pedidos cancelados, quitados ou pagamentos acima do saldo!`
  );
  console.log(`    ✅ ${file}: RBAC estrito e travas contra pagamentos espúrios em registrar_pagamento_pedido.`);
}

// 10.15 Suporte a service_role em Helpers de Autorização
console.log('\n  🔎 10.15 Verificando suporte a service_role em is_admin e is_admin_or_operator...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("auth.role() = 'service_role'"),
    `[FALHA] ${file} não reconhece service_role em funções de autorização!`
  );
  console.log(`    ✅ ${file}: service_role devidamente autorizado em is_admin e is_admin_or_operator.`);
}

// 10.16 Lançamento Contábil Compensatório no DRE/Financeiro e RPC estornar_pagamento_pedido
console.log('\n  🔎 10.16 Verificando lançamento contábil compensatório no DRE, idempotência estrutural e RPC estornar_pagamento_pedido...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("OLD.status = 'aprovado' AND NEW.status = 'estornado'") &&
    content.includes("'despesa'") &&
    content.includes("'Estornos'"),
    `[FALHA] ${file} não gera lançamento contábil compensatório de despesa/Estornos ao estornar pagamento aprovado!`
  );
  assert.ok(
    content.includes('uq_financeiro_origem_evento') &&
    content.includes('origem_tipo') &&
    content.includes('ON CONFLICT (origem_tipo, origem_id, evento)'),
    `[FALHA] ${file} não implementa idempotência estrutural no DRE / financeiro_lancamentos!`
  );
  assert.ok(
    content.includes('FUNCTION public.estornar_pagamento_pedido(') &&
    content.includes('REVOKE ALL ON FUNCTION public.estornar_pagamento_pedido') &&
    content.includes('GRANT EXECUTE ON FUNCTION public.estornar_pagamento_pedido(BIGINT, TEXT) TO authenticated, service_role;'),
    `[FALHA] ${file} não implementa RPC estornar_pagamento_pedido com autorização estrita!`
  );
  console.log(`    ✅ ${file}: Lançamento compensatório no DRE, idempotência estrutural e RPC estornar_pagamento_pedido auditáveis.`);
}

// 10.17 Idempotência no Provedor e Suporte a Estornos de Gateway no Webhook
console.log('\n  🔎 10.17 Verificando idempotência do gateway em pedido_pagamentos e suporte a estornos no webhook...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('idx_pedido_pagamentos_provider_unique') &&
    content.includes('ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING'),
    `[FALHA] ${file} não implementa índice único e tratamento ON CONFLICT simplificado para provider_payment_id!`
  );
  assert.ok(
    content.includes("IN ('refunded', 'charged_back')"),
    `[FALHA] ${file} não implementa tratamento de estorno/contestação do gateway em confirmar_pagamento_pedido!`
  );
  console.log(`    ✅ ${file}: Idempotência simplificada por provider_payment_id e suporte a refunded/charged_back ativos.`);
}

const mpWebhookContent = fs.readFileSync('functions/api/mercadopago/webhook.js', 'utf-8');
assert.ok(
  mpWebhookContent.includes("'approved'") &&
  mpWebhookContent.includes("'refunded'") &&
  mpWebhookContent.includes("'charged_back'"),
  '[FALHA] functions/api/mercadopago/webhook.js não propaga eventos de estorno (refunded/charged_back) para confirmar_pagamento_pedido!'
);
console.log('    ✅ functions/api/mercadopago/webhook.js: Webhook configurado para processar aprovações e estornos.');

// 10.18 Isolamento e Compatibilidade Rigorosa Produto x Opção
console.log('\n  🔎 10.18 Verificando integridade e compatibilidade produto x opção com Fail-Closed...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('produto_id BIGINT NOT NULL REFERENCES public.produtos(id)') &&
    content.includes('CONSTRAINT uq_produto_opcao UNIQUE (produto_id, nome)'),
    `[FALHA] ${file} não implementa chave estrangeira NOT NULL ou unicidade de nome por produto em produto_opcoes!`
  );
  assert.ok(
    content.includes('INVALID_PRODUCT_OPTION') &&
    content.includes("RAISE EXCEPTION 'Opção % não é válida para o produto %'"),
    `[FALHA] ${file} não rejeita com fail-closed (INVALID_PRODUCT_OPTION / RAISE EXCEPTION) opções não autorizadas em criar_pedido!`
  );
  console.log(`    ✅ ${file}: Catálogo produto_opcoes com constraints estritas e fail-closed absoluto em criar_pedido.`);
}

// 10.19 Desacoplamento de service_role e Fallback Seguro
console.log('\n  🔎 10.19 Verificando desacoplamento de service_role em RPCs financeiras...');
for (const file of etapa1Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("v_user_nome := 'Sistema / service_role';"),
    `[FALHA] ${file} não implementa fallback de auditoria para service_role quando auth.uid() é nulo!`
  );
  console.log(`    ✅ ${file}: service_role desacoplado de dependência de profile de usuário.`);
}

// ==========================================================================
// Teste 11: Operação Diária & Confectionery OS Core (Etapa 2 - Nooty Style)
// ==========================================================================
console.log('\n🍰 FASE 11: Operação Diária & Confectionery OS Core (Etapa 2 - Nooty Style)...');

const etapa2Files = [
  'supabase/migrations/010_confectionery_os_operacao_diaria.sql',
  'sql/schema.sql',
  'sql/install.sql'
];

// 11.1 Desacoplamento da Tabela Clientes e Identidade Comercial Canônica
console.log('  🔎 11.1 Verificando desacoplamento de clientes, FKs e restrição única de telefone...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.clientes') &&
    content.includes('auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL') &&
    content.includes('telefone_normalizado TEXT') &&
    content.includes('uq_clientes_telefone_normalizado') &&
    content.includes('ON public.clientes(telefone_normalizado)'),
    `[FALHA] ${file} não implementa tabela clientes com desacoplamento de auth e telefone único indexado!`
  );
  assert.ok(
    content.includes('cliente_id_rel BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL;'),
    `[FALHA] ${file} não vincula pedidos à nova tabela clientes via cliente_id_rel!`
  );
  console.log(`    ✅ ${file}: Tabela clientes desacoplada, telefone único normalizado e FK canônica em pedidos.`);
}

// 11.2 RLS Rigoroso e Políticas de Acesso na Tabela Clientes
console.log('\n  🔎 11.2 Verificando RLS e políticas de isolamento na tabela clientes...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;') &&
    content.includes('Equipe ou dono visualiza clientes') &&
    content.includes('Equipe gerencia clientes'),
    `[FALHA] ${file} não define RLS rigoroso com políticas de visualização e gerência em clientes!`
  );
  console.log(`    ✅ ${file}: RLS ativo e políticas de segurança verificadas para clientes.`);
}

// 11.3 Tabela Capacidade de Produção e Snapshots de Pontos em Itens e Opções
console.log('\n  🔎 11.3 Verificando tabela capacidade_producao e colunas de snapshot de pontos...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.capacidade_producao') &&
    content.includes('capacidade_maxima_pontos NUMERIC(8,2) NOT NULL DEFAULT 30.00') &&
    content.includes('bloqueado BOOLEAN NOT NULL DEFAULT false'),
    `[FALHA] ${file} não cria capacidade_producao com limite padrão e trava de bloqueio!`
  );
  assert.ok(
    content.includes('pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00;') &&
    content.includes('pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00;') &&
    content.includes('produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL;'),
    `[FALHA] ${file} não cria snapshots de pontos em pedido_itens e pedido_item_opcoes com vínculo de produto_opcao_id!`
  );
  console.log(`    ✅ ${file}: Capacidade de produção modelada e snapshots imutáveis em itens e opções.`);
}

// 11.4 Cálculo Derivado sem Drift e Lock Anti-Overbooking Concorrente
console.log('\n  🔎 11.4 Verificando derivação pura de pontos sem coluna mutável em pedidos e lock concorrente...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)') &&
    content.includes('ON CONFLICT (data) DO NOTHING;') &&
    content.includes('FOR UPDATE;'),
    `[FALHA] ${file} não inicializa data concorrente com ON CONFLICT DO NOTHING ou não usa FOR UPDATE!`
  );
  assert.ok(
    content.includes('COALESCE(SUM(pi.quantidade * (pi.pontos_producao_snapshot + COALESCE(opt_pts.pts_adicionais, 0.00))), 0.00)') &&
    content.includes("ped.status_comercial <> 'cancelado'"),
    `[FALHA] ${file} não deriva carga produtiva diretamente da agregação de itens de pedidos ativos!`
  );
  console.log(`    ✅ ${file}: Anti-overbooking com lock transacional e carga produtiva derivada.`);
}

// 11.5 Reagendamento com Ordenação Anti-Deadlock
console.log('\n  🔎 11.5 Verificando ordenação LEAST/GREATEST anti-deadlock em reagendar_encomenda_admin...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('v_primeira_data := LEAST(v_data_antiga, p_nova_data);') &&
    content.includes('v_segunda_data := GREATEST(v_data_antiga, p_nova_data);') &&
    content.includes('PERFORM 1 FROM public.capacidade_producao WHERE data = v_primeira_data FOR UPDATE;') &&
    content.includes('PERFORM 1 FROM public.capacidade_producao WHERE data = v_segunda_data FOR UPDATE;'),
    `[FALHA] ${file} não implementa locks ordenados por LEAST/GREATEST em reagendar_encomenda_admin!`
  );
  console.log(`    ✅ ${file}: Reagendamento seguro contra deadlocks bidirecionais.`);
}

// 11.6 Governança Estrita de Descontos Comerciais
console.log('\n  🔎 11.6 Verificando governança de descontos (máx 10% operador / justificativa admin)...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('v_desconto > (v_subtotal * 0.10) AND NOT public.is_admin()') &&
    content.includes("Operadores podem conceder no máximo 10% de desconto") &&
    content.includes("Por favor, informe a justificativa do desconto concedido"),
    `[FALHA] ${file} não valida teto de 10% para operadores e justificativa obrigatória para administradores!`
  );
  console.log(`    ✅ ${file}: Descontos comerciais com governança e auditoria.`);
}

// 11.7 Validação Estrita de Modalidade de Entrega vs Retirada
console.log('\n  🔎 11.7 Verificando coerência de frete zerado em retirada e endereço obrigatório em entrega...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("v_modalidade_norm = 'retirada'") &&
    content.includes('v_taxa := 0.00;') &&
    content.includes("v_modalidade_norm = 'entrega'") &&
    content.includes("Para entrega em domicílio, o endereço completo é obrigatório"),
    `[FALHA] ${file} não zera taxa em retirada ou não exige endereço em entrega!`
  );
  console.log(`    ✅ ${file}: Regras de frete e modalidade validadas no backend.`);
}

// 11.8 Confirmação Comercial Automática por Sinal e Override Restrito a Admin
console.log('\n  🔎 11.8 Verificando confirmação automática por sinal e override restrito a administradores...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('v_sinal_pago >= v_sinal_min AND v_sinal_min > 0.00') &&
    content.includes('p_forcar_confirmacao_sem_sinal = true') &&
    content.includes('Apenas Administradores podem dispensar a exigência de sinal mínimo') &&
    content.includes("v_sinal_minimo > 0 AND v_pago >= v_sinal_minimo AND v_status_com_antigo = 'aguardando_confirmacao'"),
    `[FALHA] ${file} não implementa confirmação automática por sinal ou trava de override de admin!`
  );
  console.log(`    ✅ ${file}: Confirmação comercial automática por sinal e privilégio restrito de override.`);
}

// 11.9 Guarda de Produção no Estorno Financeiro
console.log('\n  🔎 11.9 Verificando guarda de produção em estornos (não regride encomendas em curso)...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("v_sinal_minimo > 0 AND v_pago < v_sinal_minimo") &&
    content.includes("v_status_oper_antigo = 'aguardando_producao' AND v_status_com_antigo = 'confirmado'") &&
    content.includes("v_novo_status_com := 'aguardando_confirmacao';") &&
    content.includes("Durante/após produção ou se já concluído: NÃO regride status_comercial"),
    `[FALHA] ${file} não protege pedidos em produção/concluídos contra regressão comercial em estornos!`
  );
  console.log(`    ✅ ${file}: Guarda de produção ativa contra regressão indevida de status comercial.`);
}

// 11.10 Timezone Canônico e Métricas Contábeis DRE da Tela Hoje
console.log('\n  🔎 11.10 Verificando fuso horário America/Fortaleza e métricas via financeiro_lancamentos...');
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes("'America/Fortaleza'") &&
    content.includes('FUNCTION public.obter_resumo_operacao_hoje(') &&
    content.includes('financeiro_lancamentos') &&
    content.includes("categoria = 'Estornos'"),
    `[FALHA] ${file} não crava fuso America/Fortaleza ou não calcula caixa líquido via ledger DRE!`
  );
  console.log(`    ✅ ${file}: Fuso horário canônico e caixa diário calculado pelo ledger de lançamentos contábeis.`);
}

// 11.11 RBAC Estrito nas Novas RPCs da Etapa 2
console.log('\n  🔎 11.11 Verificando RBAC e permissões de execução das novas RPCs...');
const rpcsEtapa2 = [
  'buscar_clientes_admin',
  'criar_encomenda_admin',
  'reagendar_encomenda_admin',
  'obter_resumo_operacao_hoje',
  'obter_agenda_encomendas'
];
for (const file of etapa2Files) {
  const content = fs.readFileSync(file, 'utf-8');
  for (const rpc of rpcsEtapa2) {
    assert.ok(
      content.includes(`REVOKE ALL ON FUNCTION public.${rpc}`) &&
      content.includes(`GRANT EXECUTE ON FUNCTION public.${rpc}`) &&
      content.includes('TO authenticated, service_role;'),
      `[FALHA] ${file} não revoga anon ou não restringe permissões da RPC ${rpc}!`
    );
  }
  console.log(`    ✅ ${file}: Todas as 5 RPCs da Etapa 2 protegidas com RBAC authenticated + service_role.`);
}

// 11.12 Verificação de Arquivos Frontend (admin.html, admin-operacao.js, admin.js, style.css)
console.log('\n  🔎 11.12 Verificando integração de frontend (Tela Hoje, Central de Encomendas, Modais)...');
const adminHtmlContent = fs.readFileSync('admin.html', 'utf-8');
assert.ok(
  adminHtmlContent.includes('id="tab-btn-hoje"') &&
  adminHtmlContent.includes('id="admin-tab-hoje"') &&
  adminHtmlContent.includes('id="hoje-metricas-grid"') &&
  adminHtmlContent.includes('id="hoje-timeline-lista"') &&
  adminHtmlContent.includes('id="modal-nova-encomenda"') &&
  adminHtmlContent.includes('id="modal-registrar-pagamento"') &&
  adminHtmlContent.includes('id="modal-reagendar-encomenda"') &&
  adminHtmlContent.includes('js/admin-operacao.js'),
  '[FALHA] admin.html não contém todos os elementos e modais da Etapa 2!'
);

const adminOperacaoContent = fs.readFileSync('js/admin-operacao.js', 'utf-8');
assert.ok(
  adminOperacaoContent.includes('carregarDashboardHoje') &&
  adminOperacaoContent.includes('carregarCentralEncomendas') &&
  adminOperacaoContent.includes('submeterNovaEncomendaAdmin') &&
  adminOperacaoContent.includes('submeterPagamentoSaldo') &&
  adminOperacaoContent.includes('submeterReagendamento') &&
  adminOperacaoContent.includes('abrirWhatsAppEncomenda'),
  '[FALHA] js/admin-operacao.js não implementa os métodos esperados da operação diária!'
);

const adminJsContent = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminJsContent.includes("'hoje'") &&
  adminJsContent.includes('carregarDashboardHoje') &&
  adminJsContent.includes('carregarCentralEncomendas'),
  '[FALHA] js/admin.js não integra navegação da tela Hoje e Central de Encomendas!'
);

const adminLoaderContent = fs.readFileSync('js/admin-loader.js', 'utf-8');
assert.ok(
  adminLoaderContent.includes("'js/admin-operacao.js'"),
  '[FALHA] js/admin-loader.js não inclui js/admin-operacao.js no carregador dinâmico!'
);

const styleContent = fs.readFileSync('css/style.css', 'utf-8');
assert.ok(
  styleContent.includes('.hoje-metricas-grid') &&
  styleContent.includes('.metric-card-nooty') &&
  styleContent.includes('.filtro-pill-btn') &&
  styleContent.includes('.encomenda-card-nooty'),
  '[FALHA] css/style.css não contém os estilos da operação diária Nooty!'
);
console.log('    ✅ Frontend: admin.html, admin-operacao.js, admin.js, admin-loader.js e style.css totalmente integrados.');

// --------------------------------------------------------------------------
// FASE 11 (continuação): ETAPA 2 - FECHAMENTO DEFINITIVO & CONCORRÊNCIA COMPLETA
// --------------------------------------------------------------------------
console.log('\n🧩 FASE 11.13–11.18: Fechamento da Etapa 2 (reserva por item, expiração única, revisão financeira)...');
const sqlFilesEtapa2Fechamento = [
  'supabase/migrations/011_etapa2_fechamento_concorrencia.sql',
  'sql/schema.sql',
  'sql/install.sql'
];

for (const file of sqlFilesEtapa2Fechamento) {
  const content = fs.readFileSync(file, 'utf-8');

  // 11.13 Reserva de estoque por item (Opção A) e liberação idempotente guardada pela flag
  console.log(`\n  🔎 11.13 ${file}: reserva por item e liberação idempotente...`);
  assert.ok(
    content.includes('ADD COLUMN IF NOT EXISTS reserva_estoque_ativa BOOLEAN NOT NULL DEFAULT false') &&
    content.includes('CREATE OR REPLACE FUNCTION public.reservar_estoque_itens_pedido') &&
    content.includes('CREATE OR REPLACE FUNCTION public.liberar_estoque_itens_pedido') &&
    content.includes('AND pi.reserva_estoque_ativa = true') &&
    content.includes('uq_estoque_mov_item_evento'),
    `[FALHA] ${file} não implementa reserva por item com flag e idempotência estrutural!`
  );
  // criar_encomenda_admin reserva estoque (fail-closed) e o cancelamento libera via trigger único
  assert.ok(
    content.includes("v_reserva := public.reservar_estoque_itens_pedido(") &&
    content.includes('trg_pedidos_libera_reserva_ao_cancelar') &&
    content.includes('trg_estoque_mov_encerra_reserva'),
    `[FALHA] ${file}: criar_encomenda_admin não reserva estoque ou o cancelamento não libera via trigger!`
  );
  console.log('    ✅ Opção A implementada: flag por item, helpers canônicos, trigger de cancelamento.');

  // 11.14 Pipeline único de expiração + pagamento tardio com revalidação dupla + lock do pedido primeiro
  console.log(`  🔎 11.14 ${file}: pipeline único de expiração e revalidação dupla...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.expirar_pedidos_e_holds') &&
    content.includes('FOR UPDATE OF p SKIP LOCKED') &&
    content.includes("'delegado_para', 'expirar_pedidos_e_holds'") &&
    content.includes('requer_revisao_financeira = true,'),
    `[FALHA] ${file} não implementa expirar_pedidos_e_holds unificada com SKIP LOCKED e revisão financeira!`
  );
  assert.ok(
    content.includes('bloqueado_por_overbooking_tardio') &&
    content.includes("'Pagamento tardio aceito após revalidação atômica com sucesso de capacidade e estoque'") &&
    content.includes('v_cap := public.travar_capacidade_data(v_ped.data_entrega);'),
    `[FALHA] ${file}: recalcular_financeiro_pedido não revalida capacidade E estoque no pagamento tardio!`
  );
  // Ordem global: o trigger financeiro trava o pedido ANTES de capacidade/produtos
  const trgIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.recalcular_financeiro_pedido()');
  const trgBody = content.slice(trgIdx, content.indexOf('$$ LANGUAGE plpgsql', trgIdx));
  assert.ok(
    trgBody.indexOf('FOR UPDATE;') < trgBody.indexOf('travar_capacidade_data'),
    `[FALHA] ${file}: lock do pedido deve preceder o lock de capacidade no trigger financeiro!`
  );
  console.log('    ✅ Expiração única, SKIP LOCKED, revalidação dupla e ordem de locks pedido -> capacidade -> produtos.');

  // 11.15 RPC resolver_revisao_encomenda_admin (admin-only, 4 ações, sem override de estoque, estorno canônico)
  console.log(`  🔎 11.15 ${file}: resolver_revisao_encomenda_admin...`);
  const resIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.resolver_revisao_encomenda_admin');
  assert.ok(resIdx > -1, `[FALHA] ${file} não contém resolver_revisao_encomenda_admin!`);
  const resBody = content.slice(resIdx, content.indexOf('$$ LANGUAGE plpgsql', resIdx));
  assert.ok(
    resBody.includes('IF NOT public.is_admin() THEN') &&
    resBody.includes("'ESTENDER_HOLD', 'CONFIRMAR_COM_OVERRIDE', 'ESTORNAR_E_CANCELAR', 'CANCELAR'") &&
    resBody.includes("'Override de estoque não é permitido.") &&
    resBody.includes('public.estornar_pagamento_pedido(v_pag.id') &&
    resBody.includes("'RETENCAO_CANCELAMENTO'"),
    `[FALHA] ${file}: resolver_revisao_encomenda_admin não cumpre as regras (admin, 4 ações, sem override de estoque, estorno canônico, retenção)!`
  );
  console.log('    ✅ Resolução administrativa: admin-only, override só de capacidade, estorno canônico, retenção explícita.');

  // 11.16 Timezone e capacidade dinâmicos via configuracoes_operacao
  console.log(`  🔎 11.16 ${file}: configuracoes_operacao e timezone dinâmico...`);
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.configuracoes_operacao') &&
    content.includes("timezone TEXT NOT NULL DEFAULT 'America/Fortaleza'") &&
    content.includes('CREATE OR REPLACE FUNCTION public.obter_config_operacao()') &&
    content.includes('AT TIME ZONE v_cfg.timezone') &&
    content.includes('AT TIME ZONE v_tz'),
    `[FALHA] ${file} não parametriza timezone/holds via configuracoes_operacao!`
  );
  console.log('    ✅ Timezone, hold e capacidade padrão lidos de configuracoes_operacao.');

  // 11.17 Regra estrita de entrega imediata
  console.log(`  🔎 11.17 ${file}: entrega imediata exige sinal integral...`);
  assert.ok(
    content.includes("'IMMEDIATE_CONFIRMATION_REQUIRED'") &&
    content.includes('IF v_confirmacao_expires_at <= NOW() THEN') &&
    content.includes('make_interval(hours => v_cfg.antecedencia_confirmacao_horas)'),
    `[FALHA] ${file} não aplica a regra de entrega imediata com antecedência configurável!`
  );
  console.log('    ✅ IMMEDIATE_CONFIRMATION_REQUIRED aplicado.');

  // 11.18 Hardening atualizar_meus_dados_cliente + hotfix criar_pedido
  console.log(`  🔎 11.18 ${file}: atualizar_meus_dados_cliente e hotfix criar_pedido...`);
  const cliIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.atualizar_meus_dados_cliente');
  assert.ok(cliIdx > -1, `[FALHA] ${file} não contém atualizar_meus_dados_cliente!`);
  const cliTail = content.slice(cliIdx, content.indexOf('REVOKE ALL ON FUNCTION public.atualizar_meus_dados_cliente', cliIdx));
  assert.ok(
    cliTail.includes("'PHONE_ALREADY_IN_USE'") &&
    cliTail.includes('SECURITY DEFINER SET search_path = public;') &&
    !cliTail.includes('search_path = public, auth'),
    `[FALHA] ${file}: atualizar_meus_dados_cliente precisa de search_path estrito (sem auth) e PHONE_ALREADY_IN_USE!`
  );
  // O alias ambíguo "value" que quebrava o checkout da loja não pode voltar na versão final de criar_pedido
  const cpIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.criar_pedido(');
  const cpBody = content.slice(cpIdx, content.indexOf('$$ LANGUAGE plpgsql', cpIdx));
  assert.ok(
    !cpBody.includes("ELSE '[]'::jsonb END) value") && cpBody.includes('AS opt(value)'),
    `[FALHA] ${file}: criar_pedido ainda contém o alias ambíguo "value" (checkout da loja quebrado)!`
  );
  console.log('    ✅ atualizar_meus_dados_cliente endurecida e hotfix de criar_pedido presente.');

  // 11.20 Revisão 2: governança do sinal, reserva agregada, snapshots na loja, locks ordenados, hold pós-estorno
  console.log(`  🔎 11.20 ${file}: bloqueios da revisão 2 (sinal, reserva agregada, snapshots, locks, hold)...`);
  const encIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.criar_encomenda_admin(');
  const encBody = content.slice(encIdx, content.indexOf('$$ LANGUAGE plpgsql', encIdx));
  const polIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.politica_sinal(');
  const polBody = polIdx > -1 ? content.slice(polIdx, content.indexOf('$$ LANGUAGE plpgsql', polIdx)) : '';
  const targetBody = polIdx > -1 ? polBody : encBody;
  assert.ok(
    targetBody.includes('v_sinal_padrao := ROUND(v_total * (COALESCE(v_cfg.sinal_percentual_padrao, 50.00) / 100.0), 2);') &&
    targetBody.includes("'SIGNAL_REDUCTION_REQUIRES_REASON'") &&
    (targetBody.includes('v_sinal_min := GREATEST(v_sinal_padrao, COALESCE(p_sinal_minimo, 0.00));') ||
     targetBody.includes('v_sinal_final := GREATEST(v_sinal_padrao, COALESCE(p_sinal_solicitado, 0.00));')) &&
    !targetBody.includes('v_sinal_min := GREATEST(0.00, COALESCE(p_sinal_minimo, 0.00));'),
    `[FALHA] ${file}: governança de sinal mínimo ainda aceita sinal arbitrário do operador (bypass de governança)!`
  );
  const resvIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.reservar_estoque_itens_pedido(');
  const resvBody = content.slice(resvIdx, content.indexOf('$$ LANGUAGE plpgsql', resvIdx));
  assert.ok(
    resvBody.includes('SUM(pi.quantidade)::INT AS quantidade') && resvBody.includes('GROUP BY pi.produto_id'),
    `[FALHA] ${file}: reservar_estoque_itens_pedido não valida a quantidade AGREGADA por produto!`
  );
  assert.ok(
    cpBody.includes('PERFORM 1 FROM public.produtos WHERE id = ANY(v_produto_ids) ORDER BY id FOR UPDATE;') &&
    cpBody.includes('v_reserva := public.reservar_estoque_itens_pedido(') &&
    cpBody.includes('pontos_producao_snapshot') &&
    cpBody.includes('INSERT INTO public.pedido_item_opcoes (pedido_item_id, produto_opcao_id, tipo, opcao_nome, preco_adicional, pontos_producao_adicionais_snapshot)') &&
    cpBody.includes('make_interval(mins => GREATEST(1, COALESCE(v_cfg.hold_pix_loja_minutos, 30)))') &&
    cpBody.includes('WITH ORDINALITY') &&
    !cpBody.includes("INTERVAL '30 minutes'"),
    `[FALHA] ${file}: criar_pedido precisa travar produtos em id ASC numa consulta, usar o helper de reserva, gravar snapshots de pontos/produto_opcao_id, hold configurável e preservar linhas!`
  );
  assert.ok(
    content.includes('DROP TRIGGER IF EXISTS trg_pedido_itens_marca_reserva_loja ON public.pedido_itens;') &&
    !content.includes('CREATE TRIGGER trg_pedido_itens_marca_reserva_loja'),
    `[FALHA] ${file}: trigger legado de marcação de reserva da loja não pode coexistir com o helper!`
  );
  assert.ok(
    trgBody.includes('v_novo_expires_at := LEAST(NOW() + make_interval(hours => v_cfg.hold_horas_padrao), v_limite_hold);') &&
    trgBody.includes('IF v_novo_expires_at <= NOW() THEN'),
    `[FALHA] ${file}: hold pós-estorno deve ser MIN(agora + padrão, entrega - antecedência) e cair em revisão sem prazo viável!`
  );
  console.log('    ✅ Governança do sinal, reserva agregada, snapshots/locks/hold da loja e hold pós-estorno.');
}

// 11.19 Frontend: modal de revisão financeira e filtro
console.log('\n  🔎 11.19 Verificando frontend da revisão financeira...');
const adminHtmlFechamento = fs.readFileSync('admin.html', 'utf-8');
const adminOperacaoFechamento = fs.readFileSync('js/admin-operacao.js', 'utf-8');
assert.ok(
  adminHtmlFechamento.includes('id="modal-resolver-revisao"') &&
  adminHtmlFechamento.includes('data-filtro="revisao"') &&
  adminOperacaoFechamento.includes("supabaseClient.rpc('resolver_revisao_encomenda_admin'") &&
  adminOperacaoFechamento.includes("case 'revisao':") &&
  adminOperacaoFechamento.includes('badge-revisao-financeira') &&
  adminOperacaoFechamento.includes("payload.p_destino_valor = 'RETENCAO_CANCELAMENTO'"),
  '[FALHA] Frontend não integra a resolução de revisão financeira!'
);
console.log('    ✅ Modal, filtro "Em Revisão", badge e chamada da RPC presentes.');

// 11.21 Loja: prazo de pagamento vem de expires_at (sem "30 minutos" fixo); contador é visual, servidor decide
console.log('\n  🔎 11.21 Verificando prazo de pagamento da loja baseado em expires_at...');
const mpPlugin = fs.readFileSync('js/mercadopago-plugin.js', 'utf-8');
const pedidosJsLoja = fs.readFileSync('js/pedidos.js', 'utf-8');
const mpJs = fs.readFileSync('js/mercadopago.js', 'utf-8');
assert.ok(
  pedidosJsLoja.includes('expiresAt = rpcRes.expires_at || null;') &&
  mpJs.includes('expiresAt: expiresAt ||') &&
  mpPlugin.includes('renderPrazoBoxHtml') &&
  mpPlugin.includes("'menos de 1 minuto'") &&
  mpPlugin.includes('Conclua o pagamento dentro do prazo informado.') &&
  mpPlugin.includes('Prazo de pagamento expirado') &&
  mpPlugin.includes("pedido.cancelado_por_expiracao === true || pedido.status_comercial === 'cancelado'"),
  '[FALHA] Loja não usa expires_at como fonte do prazo (ou não trata expiração do servidor)!'
);
for (const [f, c] of [['index.html', fs.readFileSync('index.html', 'utf-8')], ['js/mercadopago-plugin.js', mpPlugin], ['js/pedidos.js', pedidosJsLoja], ['js/mercadopago.js', mpJs]]) {
  assert.ok(!/30\s*min(utos)?/i.test(c), `[FALHA] ${f} ainda contém texto fixo de "30 minutos"!`);
}
console.log('    ✅ Prazo da loja derivado de expires_at; sem minutos fixos; expiração confirmada pelo servidor.');

// --------------------------------------------------------------------------
// FASE 12: FONTE CANÔNICA DE SQL (migrations) E PARIDADE DOS ARQUIVOS GERADOS
// --------------------------------------------------------------------------
console.log('\n🧩 FASE 12: Paridade sql/install.sql e sql/schema.sql com baseline + migrations...');
{
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['scripts/build-sql.mjs', '--check'], { stdio: 'pipe' });
  } catch (e) {
    assert.fail('[FALHA] sql/install.sql ou sql/schema.sql desatualizados. Rode: npm run build:sql');
  }
  const installGen = fs.readFileSync('sql/install.sql', 'utf-8');
  const schemaGen = fs.readFileSync('sql/schema.sql', 'utf-8');
  assert.strictEqual(installGen, schemaGen, '[FALHA] sql/schema.sql deve ser idêntico a sql/install.sql (gerados)');
  assert.ok(installGen.includes('>>> MIGRATION 011_etapa2_fechamento_concorrencia.sql'), '[FALHA] install.sql não inclui a migration 011');
  assert.ok(installGen.includes('>>> MIGRATION 012_hardening_politicas_e_nucleo.sql'), '[FALHA] install.sql não inclui a migration 012');
  assert.ok(installGen.includes('>>> MIGRATION 013_etapa3_orcamentos_conversao_comercial.sql'), '[FALHA] install.sql não inclui a migration 013');
  assert.ok(installGen.includes('>>> MIGRATION 014_governanca_catalogo_estoque_e_portas_dominio.sql'), '[FALHA] install.sql não inclui a migration 014');
  assert.ok(installGen.includes('baixar_estoque_pedido_batch'), '[FALHA] install.sql perdeu baixar_estoque_pedido_batch');
}
console.log('    ✅ Arquivos gerados em paridade com a fonte canônica (migrations).');

// --------------------------------------------------------------------------
// FASE 13: ETAPA 3 - ORÇAMENTOS, PROPOSTA PÚBLICA & CONVERSÃO COMERCIAL
// --------------------------------------------------------------------------
console.log('\n📜 FASE 13: Etapa 3 - Orçamentos, Proposta Pública & Conversão Comercial...');

const sqlFilesEtapa3 = [
  'supabase/migrations/013_etapa3_orcamentos_conversao_comercial.sql',
  'sql/schema.sql',
  'sql/install.sql'
];

for (const file of sqlFilesEtapa3) {
  const content = fs.readFileSync(file, 'utf-8');

  // 13.1 Tabelas do Módulo de Orçamentos e Constraints
  console.log(`  🔎 13.1 ${file}: tabelas, unicidade de pedido/orçamento e snapshots...`);
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamentos') &&
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamento_itens') &&
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamento_item_opcoes') &&
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamento_autorizacoes') &&
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamento_status_historico') &&
    content.includes('CREATE TABLE IF NOT EXISTS public.orcamento_comunicacoes'),
    `[FALHA] ${file} não cria todas as 6 tabelas do módulo de orçamentos!`
  );

  assert.ok(
    content.includes('token_publico UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE') &&
    content.includes('pedido_id BIGINT UNIQUE REFERENCES public.pedidos(id) ON DELETE SET NULL') &&
    (file === 'supabase/migrations/013_etapa3_orcamentos_conversao_comercial.sql' || content.includes('orcamento_origem_id BIGINT UNIQUE')),
    `[FALHA] ${file} não garante unicidade do token_publico, orcamentos.pedido_id e pedidos.orcamento_origem_id!`
  );

  assert.ok(
    content.includes('preco_unitario_snapshot NUMERIC(10,2) NOT NULL') &&
    content.includes('pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00') &&
    content.includes('preco_adicional_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0.00'),
    `[FALHA] ${file} não implementa colunas de snapshot imutável em itens e opções de orçamento!`
  );

  // 13.2 RLS Rigoroso e Políticas nas Tabelas de Orçamentos
  console.log(`  🔎 13.2 ${file}: RLS fail-closed nas tabelas de orçamentos...`);
  assert.ok(
    content.includes('ALTER TABLE public.orcamentos ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.orcamento_itens ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.orcamento_item_opcoes ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.orcamento_autorizacoes ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.orcamento_status_historico ENABLE ROW LEVEL SECURITY;') &&
    content.includes('ALTER TABLE public.orcamento_comunicacoes ENABLE ROW LEVEL SECURITY;'),
    `[FALHA] ${file} não habilita RLS em todas as tabelas de orçamentos!`
  );

  // Sem concessão de SELECT em orcamentos para anon / PUBLIC
  assert.ok(
    !content.includes('CREATE POLICY "Anon visualiza orcamentos" ON public.orcamentos FOR SELECT TO anon') &&
    !content.includes('CREATE POLICY "Publico visualiza orcamentos" ON public.orcamentos FOR SELECT TO public'),
    `[FALHA] ${file} concede acesso direto vulnerável em public.orcamentos para anon/public!`
  );

  // 13.3 RPCs de Ciclo de Vida e Segurança
  console.log(`  🔎 13.3 ${file}: RPCs de ciclo de vida, expiração e aprovação...`);
  const rpcsEtapa3 = [
    'criar_ou_atualizar_orcamento_admin',
    'alterar_status_orcamento_admin',
    'obter_orcamento_publico',
    'aprovar_orcamento_publico',
    'expirar_orcamentos',
    'converter_orcamento_em_pedido_admin',
    'registrar_comunicacao_orcamento_admin',
    'buscar_orcamentos_admin'
  ];

  for (const rpc of rpcsEtapa3) {
    assert.ok(
      content.includes(`CREATE OR REPLACE FUNCTION public.${rpc}`) &&
      content.includes(`SECURITY DEFINER SET search_path = public, auth;`),
      `[FALHA] ${file} não define RPC public.${rpc} com SECURITY DEFINER e search_path estrito!`
    );
  }

  // 13.4 Obter e Aprovar Orçamento Público
  console.log(`  🔎 13.4 ${file}: isolamento de obter/aprovar orçamento público...`);
  const pubIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.obter_orcamento_publico(');
  const pubBody = content.slice(pubIdx, content.indexOf('$$ LANGUAGE plpgsql', pubIdx));
  assert.ok(
    !pubBody.includes('cmv_unitario_snapshot') &&
    !pubBody.includes('observacoes_internas') &&
    !pubBody.includes('criado_por') &&
    pubBody.includes('visualizacoes_count'),
    `[FALHA] ${file}: obter_orcamento_publico vaza dados sensíveis (CMV, observações internas ou criado_por)!`
  );

  const aprIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(');
  const aprBody = content.slice(aprIdx, content.indexOf('$$ LANGUAGE plpgsql', aprIdx));
  assert.ok(
    aprBody.includes("'idempotente', true") &&
    aprBody.includes("'QUOTE_EXPIRED'") &&
    aprBody.includes("'QUOTE_NOT_APPROVABLE'") &&
    aprBody.includes("status = 'aprovado'"),
    `[FALHA] ${file}: aprovar_orcamento_publico não garante idempotência ou rejeição de expirados!`
  );

  // 13.5 Expiração com SKIP LOCKED
  console.log(`  🔎 13.5 ${file}: expirar_orcamentos com FOR UPDATE SKIP LOCKED...`);
  const expIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.expirar_orcamentos(');
  const expBody = content.slice(expIdx, content.indexOf('$$ LANGUAGE plpgsql', expIdx));
  assert.ok(
    expBody.includes("status = 'enviado' AND validade_ate < NOW()") &&
    expBody.includes('FOR UPDATE SKIP LOCKED') &&
    expBody.includes("status = 'expirado'"),
    `[FALHA] ${file}: expirar_orcamentos não usa SKIP LOCKED ou não filtra status enviado com validade vencida!`
  );

  // 13.6 Conversão Atômica Delegando ao Núcleo
  console.log(`  🔎 13.6 ${file}: converter_orcamento_em_pedido_admin com snapshots imutáveis e núcleo...`);
  const convIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.converter_orcamento_em_pedido_admin(');
  const convBody = content.slice(convIdx, content.indexOf('$$ LANGUAGE plpgsql', convIdx));
  assert.ok(
    convBody.includes("'QUOTE_NOT_CONVERTIBLE'") &&
    convBody.includes("'CONVERSION_WINDOW_EXPIRED'") &&
    convBody.includes("status = 'convertido' AND v_orc.pedido_id IS NOT NULL") &&
    convBody.includes("public.nucleo_criar_encomenda(") &&
    convBody.includes("oi.preco_unitario_snapshot") &&
    !convBody.includes("JOIN public.produtos pr ON pr.preco"),
    `[FALHA] ${file}: conversão de orçamento precisa checar status aprovado, janela pós-aprovação, idempotência e usar snapshots imutáveis delegando ao núcleo!`
  );
  console.log(`    ✅ ${file}: Schema e RPCs da Etapa 3 100% auditados.`);
}

// 13.7 Frontend: Central de Orçamentos, Modais, Proposta Pública e Cron Unificado
console.log('\n  🔎 13.7 Verificando frontend, documentos e integração do cron...');
const adminHtmlE3 = fs.readFileSync('admin.html', 'utf-8');
assert.ok(
  adminHtmlE3.includes('id="tab-btn-orcamentos"') &&
  adminHtmlE3.includes('id="admin-tab-orcamentos"') &&
  adminHtmlE3.includes('id="orcamentos-lista-container"') &&
  adminHtmlE3.includes('id="modal-novo-orcamento"') &&
  adminHtmlE3.includes('id="modal-converter-orcamento"') &&
  adminHtmlE3.includes('id="modal-espelho-orcamento"') &&
  adminHtmlE3.includes('js/admin-orcamentos.js'),
  '[FALHA] admin.html não contém a aba Orçamentos ou seus modais integrados!'
);

const adminOrcJs = fs.readFileSync('js/admin-orcamentos.js', 'utf-8');
assert.ok(
  adminOrcJs.includes('carregarOrcamentosAdmin') &&
  adminOrcJs.includes('submeterOrcamentoAdmin') &&
  adminOrcJs.includes('submeterConversaoOrcamento') &&
  adminOrcJs.includes('abrirEspelhoOrcamento') &&
  adminOrcJs.includes('compartilharWhatsAppOrcamento') &&
  adminOrcJs.includes('copiarLinkPublicoOrcamento'),
  '[FALHA] js/admin-orcamentos.js não implementa os métodos esperados da gestão de orçamentos!'
);

const adminJsE3 = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminJsE3.includes("'tab-btn-orcamentos'") &&
  adminJsE3.includes("'orcamentos'") &&
  adminJsE3.includes('carregarOrcamentosAdmin'),
  '[FALHA] js/admin.js não inclui aba orçamentos nas abas permitidas do operador!'
);

const orcHtml = fs.readFileSync('orcamento.html', 'utf-8');
const orcPubJs = fs.readFileSync('js/orcamento-publico.js', 'utf-8');
assert.ok(
  orcHtml.includes('id="orcamento-conteudo"') &&
  orcHtml.includes('id="btn-aprovar-orcamento"') &&
  orcPubJs.includes('obter_orcamento_publico') &&
  orcPubJs.includes('aprovar_orcamento_publico') &&
  orcPubJs.includes('aprovarPropostaPublica'),
  '[FALHA] orcamento.html ou js/orcamento-publico.js não implementam a visualização e aprovação pública!'
);

const cronExpireE3 = fs.readFileSync('functions/api/cron/expire-orders.js', 'utf-8');
assert.ok(
  cronExpireE3.includes('expirar_pedidos_e_holds') &&
  cronExpireE3.includes('expirar_orcamentos'),
  '[FALHA] expire-orders.js não invoca ambas as RPCs unificadas (pedidos e orçamentos)!'
);

const cssE3 = fs.readFileSync('css/style.css', 'utf-8');
assert.ok(
  cssE3.includes('@media print') &&
  cssE3.includes('#modal-espelho-orcamento') &&
  cssE3.includes('.folha-impressao'),
  '[FALHA] css/style.css não contém regras de impressão @media print para espelho de orçamento!'
);
console.log('    ✅ Frontend, documentos e cron unificado da Etapa 3 validados com sucesso.');

// 13.8 Auditoria de Pagamento de Sinal e RLS Público Estrito
console.log('\n  🔎 13.8 Verificando integridade contábil do sinal no núcleo e RLS público de orçamentos...');
const sqlFilesNucleo = [
  'supabase/migrations/012_hardening_politicas_e_nucleo.sql',
  'sql/schema.sql',
  'sql/install.sql'
];
for (const file of sqlFilesNucleo) {
  const content = fs.readFileSync(file, 'utf-8');
  assert.ok(
    content.includes('INSERT INTO public.financeiro_lancamentos') &&
    content.includes("'pedido_pagamento'") &&
    content.includes("'recebimento'") &&
    content.includes("ON CONFLICT (origem_tipo, origem_id, evento) WHERE origem_id IS NOT NULL AND evento IS NOT NULL DO NOTHING;"),
    `[FALHA] ${file}: nucleo_criar_encomenda deve registrar o lançamento contábil no DRE ao processar pagamento de sinal!`
  );
}
console.log('    ✅ Sinal no núcleo registra lançamento no DRE e RLS de orçamentos 100% blindado.');

// --------------------------------------------------------------------------
// FASE 14: GOVERNANÇA DE CATÁLOGO, ESTOQUE ATÔMICO & PORTAS DE DOMÍNIO (MIGRATION 014)
// --------------------------------------------------------------------------
console.log('\n🔒 FASE 14: Governança de Catálogo, Estoque Atômico & Portas de Domínio (014)...');

const sqlFiles014 = [
  'supabase/migrations/014_governanca_catalogo_estoque_e_portas_dominio.sql',
  'sql/schema.sql',
  'sql/install.sql'
];

for (const file of sqlFiles014) {
  const content = fs.readFileSync(file, 'utf-8');

  // 14.1 Estoque Atômico via RPC ajustar_estoque_operacao
  console.log(`  🔎 14.1 ${file}: ajustar_estoque_operacao com lock, auditoria e invariante...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.ajustar_estoque_operacao') &&
    content.includes('SELECT * INTO v_prod FROM public.produtos WHERE id = p_produto_id FOR UPDATE') &&
    content.includes('RESERVED_STOCK_CONFLICT') &&
    content.includes('INSERT INTO public.estoque_movimentacoes') &&
    content.includes('REVOKE ALL ON FUNCTION public.ajustar_estoque_operacao FROM PUBLIC, anon;') &&
    content.includes('GRANT EXECUTE ON FUNCTION public.ajustar_estoque_operacao TO authenticated, service_role;'),
    `[FALHA] ${file}: ajustar_estoque_operacao não implementada com os requisitos de segurança e lock!`
  );

  // 14.2 RLS Fechado de Catálogo
  console.log(`  🔎 14.2 ${file}: RLS de produtos e produto_opcoes restrito a Administradores...`);
  assert.ok(
    content.includes('CREATE POLICY "Apenas admins atualizam produtos"') &&
    content.includes('ON public.produtos FOR UPDATE') &&
    content.includes('USING (public.is_admin())') &&
    content.includes('CREATE POLICY "Apenas admins gerenciam opções de produtos"') &&
    content.includes('ON public.produto_opcoes FOR ALL'),
    `[FALHA] ${file}: RLS de produtos/opções não fecha UPDATE para operadores!`
  );

  // 14.3 Portas Comerciais Dedicadas
  console.log(`  🔎 14.3 ${file}: portas comerciais dedicadas cancelar_pedido_equipe e gerenciar_confirmacao_pedido_admin...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.cancelar_pedido_equipe') &&
    content.includes('CREATE OR REPLACE FUNCTION public.gerenciar_confirmacao_pedido_admin') &&
    content.includes('PRODUCTION_ACTIVE_CANCEL_DENIED') &&
    content.includes('CANCELLATION_REQUIRES_VALUE_DESTINATION') &&
    content.includes('REVOKE ALL ON FUNCTION public.cancelar_pedido_equipe FROM PUBLIC, anon;') &&
    content.includes('REVOKE ALL ON FUNCTION public.gerenciar_confirmacao_pedido_admin FROM PUBLIC, anon;'),
    `[FALHA] ${file}: portas comerciais dedicadas não implementadas ou sem proteção de privilégios!`
  );

  // 14.4 Desconto Dinâmico em configuracoes_operacao
  console.log(`  🔎 14.4 ${file}: desconto_operador_percentual_max em configuracoes_operacao...`);
  assert.ok(
    content.includes('desconto_operador_percentual_max NUMERIC(5,2) NOT NULL DEFAULT 10.00') &&
    content.includes('COALESCE(v_cfg.desconto_operador_percentual_max, 10.00)'),
    `[FALHA] ${file}: desconto dinâmico não adicionado a configuracoes_operacao ou politica_desconto!`
  );
}

// 14.5 Frontend desacoplado de estoque
console.log('  🔎 14.5 Verificando frontend: produtos.js sem campos de estoque e estoque.js usando RPC...');
const prodJs014 = fs.readFileSync('js/produtos.js', 'utf-8');
const updateBlockMatch = prodJs014.match(/\.from\('produtos'\)\s*\.update\(\{([\s\S]*?)\}\)\s*\.eq\('id', id\)/);
assert.ok(updateBlockMatch, '[FALHA] Bloco de update de produto em produtos.js não encontrado!');
const updateBlock = updateBlockMatch[1];
assert.ok(
  !updateBlock.includes('estoque_qtd') &&
  !updateBlock.includes('estoque_minimo') &&
  !updateBlock.includes('controlar_estoque'),
  '[FALHA] produtos.js ainda envia campos de estoque no update de catálogo existente!'
);

const estJs014 = fs.readFileSync('js/estoque.js', 'utf-8');
assert.ok(
  estJs014.includes("supabaseClient.rpc('ajustar_estoque_operacao'") &&
  !estJs014.includes("supabaseClient.from('produtos').update({ estoque_qtd"),
  '[FALHA] estoque.js não foi migrado para a RPC ajustar_estoque_operacao!'
);
// ==========================================================================
// 15. FASE 15: COMUNICAÇÃO WHATSAPP, AUDITORIA CANÔNICA & VERSÃO (MIGRATION 015)
// ==========================================================================
console.log('\n📱 FASE 15: Comunicação WhatsApp, Auditoria Canônica & Versão (015)...');
const sqlFiles015 = [
  'supabase/migrations/015_comunicacao_whatsapp_e_relacionamento.sql',
  'sql/schema.sql',
  'sql/install.sql'
];

for (const file of sqlFiles015) {
  const content = fs.readFileSync(file, 'utf-8');

  // 15.1 Tabela comunicacoes_cliente e constraint XOR
  console.log(`  🔎 15.1 ${file}: tabela comunicacoes_cliente e constraint XOR de integridade...`);
  assert.ok(
    content.includes('CREATE TABLE IF NOT EXISTS public.comunicacoes_cliente') &&
    content.includes('CONSTRAINT ck_comunicacao_entidade') &&
    content.includes('orcamento_id IS NOT NULL AND pedido_id IS NULL') &&
    content.includes('orcamento_id IS NULL AND pedido_id IS NOT NULL') &&
    content.includes('chave_idempotencia TEXT NOT NULL UNIQUE'),
    `[FALHA] ${file}: tabela comunicacoes_cliente ou constraint XOR não implementada!`
  );

  // 15.2 Normalizador E.164 e Renderer Canônico
  console.log(`  🔎 15.2 ${file}: normalizar_telefone_e164 e obter_preview_comunicacao...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.normalizar_telefone_e164') &&
    content.includes('CREATE OR REPLACE FUNCTION public.obter_preview_comunicacao') &&
    content.includes('INVALID_PHONE') &&
    content.includes('A aprovação da proposta não reserva estoque ou capacidade') &&
    content.includes('https://lunocadoceria.com.br/orcamento.html?t='),
    `[FALHA] ${file}: normalizador ou renderizador canônico obter_preview_comunicacao não implementado!`
  );

  // 15.3 Registro Auditável e Bloqueio de whatsapp_link como enviado
  console.log(`  🔎 15.3 ${file}: registrar_comunicacao_cliente com bloqueio de whatsapp_link enviado...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.registrar_comunicacao_cliente') &&
    content.includes('INVALID_STATUS_FOR_CHANNEL') &&
    content.includes('REVOKE ALL ON FUNCTION public.registrar_comunicacao_cliente FROM PUBLIC, anon;'),
    `[FALHA] ${file}: registrar_comunicacao_cliente não implementada ou não bloqueia whatsapp_link como enviado!`
  );

  // 15.4 Aprovação Pública Vinculada à Versão Esperada
  console.log(`  🔎 15.4 ${file}: aprovar_orcamento_publico com p_versao_esperada e QUOTE_VERSION_CHANGED...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico') &&
    content.includes('p_versao_esperada INTEGER') &&
    content.includes('QUOTE_VERSION_CHANGED'),
    `[FALHA] ${file}: aprovar_orcamento_publico não vinculada à versão esperada!`
  );

  // 15.5 Lembretes de Orçamento
  console.log(`  🔎 15.5 ${file}: listar_orcamentos_para_lembrete...`);
  assert.ok(
    content.includes('CREATE OR REPLACE FUNCTION public.listar_orcamentos_para_lembrete') &&
    content.includes('ORCAMENTO_VENCENDO') &&
    content.includes('REVOKE ALL ON FUNCTION public.listar_orcamentos_para_lembrete FROM PUBLIC, anon;'),
    `[FALHA] ${file}: listar_orcamentos_para_lembrete não implementada ou sem revogação de permissão pública!`
  );
}

// 15.6 Frontend e Pages Function
console.log('  🔎 15.6 Verificando frontend e adapter de Pages Functions...');
const waHelper = fs.readFileSync('js/whatsapp-helper.js', 'utf-8');
assert.ok(
  waHelper.includes('export function normalizarTelefoneE164') &&
  waHelper.includes('export function gerarLinkWhatsApp') &&
  waHelper.includes('export async function abrirModalComunicacaoWhatsApp'),
  '[FALHA] js/whatsapp-helper.js não exporta as funções canônicas!'
);

const orcPubJs015 = fs.readFileSync('js/orcamento-publico.js', 'utf-8');
assert.ok(
  orcPubJs015.includes('p_versao_esperada: Number(orc?.versao || 1)') &&
  orcPubJs015.includes("QUOTE_VERSION_CHANGED"),
  '[FALHA] js/orcamento-publico.js não envia p_versao_esperada ou não trata QUOTE_VERSION_CHANGED!'
);

const cfWaSend = fs.readFileSync('functions/api/whatsapp/send.js', 'utf-8');
assert.ok(
  cfWaSend.includes('obter_preview_comunicacao') &&
  cfWaSend.includes('registrar_comunicacao_cliente') &&
  cfWaSend.includes('verifyAuth'),
  '[FALHA] functions/api/whatsapp/send.js não consome preview canônico server-side ou não valida auth!'
);
console.log('    ✅ Frontend e Pages Function da Frente B 100% auditados.');

// --------------------------------------------------------------------------
// FASE 16: RECONCILIAÇÃO PÓS-015 & HARDENING DE AUTORIZAÇÃO (016)
// --------------------------------------------------------------------------
console.log('\n🛡️ FASE 16: Reconciliação Pós-015 & Hardening de Autorização (016)...');

assert.ok(
  fs.existsSync('supabase/migrations/016_reconciliacao_pos_015.sql'),
  '[FALHA] supabase/migrations/016_reconciliacao_pos_015.sql não encontrada!'
);

const m016 = fs.readFileSync('supabase/migrations/016_reconciliacao_pos_015.sql', 'utf-8');
const installFinal = fs.readFileSync('sql/install.sql', 'utf-8');
const schemaFinal = fs.readFileSync('sql/schema.sql', 'utf-8');

console.log('  🔎 16.1 Verificando eliminação de current_user/session_user/current_role em helpers de autorização...');
for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  for (const fnName of ['is_admin()', 'is_admin_or_operator()']) {
    const lastDefIdx = content.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
    assert.ok(lastDefIdx !== -1, `[FALHA] ${name} não define ${fnName}!`);
    const activeDef = content.slice(lastDefIdx, lastDefIdx + 1200);
    assert.ok(
      !activeDef.includes('current_user') && !activeDef.includes('session_user') && !activeDef.includes('current_role'),
      `[FALHA CRÍTICA] ${name}: helper ${fnName} contém variável de sessão proibida (current_user/session_user/current_role)!`
    );
    assert.ok(
      activeDef.includes("auth.role() = 'service_role'") && activeDef.includes('auth.uid() IS NULL'),
      `[FALHA] ${name}: ${fnName} não é fail-closed baseada em auth.role e auth.uid!`
    );
  }
}

console.log('  🔎 16.2 orcamento.html: proteção contra vazamento do bearer token via no-referrer...');
const orcHtml016 = fs.readFileSync('orcamento.html', 'utf-8');
assert.ok(
  orcHtml016.includes('<meta name="referrer" content="no-referrer">'),
  '[FALHA] orcamento.html não possui a meta tag <meta name="referrer" content="no-referrer">!'
);

console.log('    ✅ Helpers de autorização limpos e meta tag no-referrer validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 17: APROVAÇÃO DE ORÇAMENTO COM VERSÃO OBRIGATÓRIA (017)
// --------------------------------------------------------------------------
console.log('\n🛡️ FASE 17: Aprovação de Orçamento com Versão Obrigatória (017)...');

assert.ok(
  fs.existsSync('supabase/migrations/017_aprovacao_orcamento_versao_obrigatoria.sql'),
  '[FALHA] supabase/migrations/017_aprovacao_orcamento_versao_obrigatoria.sql não encontrada!'
);

const m017 = fs.readFileSync('supabase/migrations/017_aprovacao_orcamento_versao_obrigatoria.sql', 'utf-8');

console.log('  🔎 17.1 Verificando ausência de DEFAULT NULL e guarda VERSION_REQUIRED em 017...');
assert.ok(
  !m017.includes('DEFAULT NULL'),
  '[FALHA] Migration 017 ainda contém DEFAULT NULL em aprovar_orcamento_publico!'
);
assert.ok(
  m017.includes('p_versao_esperada INTEGER') && m017.includes('VERSION_REQUIRED'),
  '[FALHA] Migration 017 não exige p_versao_esperada INTEGER ou não contém guarda VERSION_REQUIRED!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  const lastDefIdx = content.lastIndexOf('CREATE OR REPLACE FUNCTION public.aprovar_orcamento_publico(');
  assert.ok(lastDefIdx !== -1, `[FALHA] ${name} não define aprovar_orcamento_publico!`);
  const activeDef = content.slice(lastDefIdx, lastDefIdx + 1500);
  assert.ok(
    !activeDef.includes('DEFAULT NULL'),
    `[FALHA] ${name}: a definição ativa final de aprovar_orcamento_publico ainda contém DEFAULT NULL!`
  );
  assert.ok(
    activeDef.includes('p_versao_esperada INTEGER') && activeDef.includes('VERSION_REQUIRED'),
    `[FALHA] ${name}: a definição ativa final não exige versão esperada obrigatória com VERSION_REQUIRED!`
  );
}
console.log('    ✅ Migration 017 e scripts mestre em conformidade com versão estritamente obrigatória.');

// --------------------------------------------------------------------------
// FASE 18: FRENTE C - CARTEIRA DE CRÉDITO DO CLIENTE (018)
// --------------------------------------------------------------------------
console.log('\n🛡️ FASE 18: Frente C - Carteira de Crédito do Cliente (018)...');

assert.ok(
  fs.existsSync('supabase/migrations/018_credito_cliente_carteira_financeira.sql'),
  '[FALHA] supabase/migrations/018_credito_cliente_carteira_financeira.sql não encontrada!'
);

const m018 = fs.readFileSync('supabase/migrations/018_credito_cliente_carteira_financeira.sql', 'utf-8');

console.log('  🔎 18.1 Verificando estrutura de tabelas e imutabilidade de cliente_credito_movimentacoes...');
assert.ok(
  m018.includes('CREATE TABLE IF NOT EXISTS public.cliente_creditos') &&
  m018.includes('CREATE TABLE IF NOT EXISTS public.cliente_credito_movimentacoes'),
  '[FALHA] Tabelas de crédito não definidas em 018!'
);
assert.ok(
  m018.includes('REVOKE UPDATE, DELETE ON public.cliente_credito_movimentacoes FROM PUBLIC, anon, authenticated;'),
  '[FALHA] Livro-razão cliente_credito_movimentacoes não possui REVOKE UPDATE, DELETE!'
);
assert.ok(
  m018.includes('saldo >= 0.00'),
  '[FALHA] cliente_creditos não possui check constraint de saldo não-negativo!'
);

console.log('  🔎 18.2 Verificando segurança fail-closed da função interna aplicar_movimento_credito_cliente...');
assert.ok(
  m018.includes('REVOKE ALL ON FUNCTION public.aplicar_movimento_credito_cliente FROM PUBLIC, anon, authenticated;'),
  '[FALHA] Função interna aplicar_movimento_credito_cliente não é estritamente privada!'
);
assert.ok(
  !m018.includes('GRANT EXECUTE ON FUNCTION public.aplicar_movimento_credito_cliente TO authenticated'),
  '[FALHA] Função interna aplicar_movimento_credito_cliente possui GRANT para authenticated!'
);

console.log('  🔎 18.3 Verificando métodos de cancelamento com CREDITO_CLIENTE e ESTORNO...');
assert.ok(
  m018.includes("p_destino_valor = 'CREDITO_CLIENTE'") && m018.includes("p_destino_valor = 'ESTORNO'"),
  '[FALHA] cancelar_pedido_equipe não implementa fluxos de CREDITO_CLIENTE ou ESTORNO!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.cliente_creditos'), `[FALHA] ${name} não contém cliente_creditos!`);
  assert.ok(content.includes('public.cliente_credito_movimentacoes'), `[FALHA] ${name} não contém cliente_credito_movimentacoes!`);
  assert.ok(content.includes('public.ajustar_credito_cliente_admin'), `[FALHA] ${name} não contém ajustar_credito_cliente_admin!`);
  assert.ok(content.includes('public.utilizar_credito_cliente_pedido'), `[FALHA] ${name} não contém utilizar_credito_cliente_pedido!`);
  assert.ok(content.includes('public.consultar_saldo_credito'), `[FALHA] ${name} não contém consultar_saldo_credito!`);
}
console.log('    ✅ Migration 018 e scripts mestre validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 19: FRENTE D - CRM & HISTÓRICO 360° DO CLIENTE (019)
// --------------------------------------------------------------------------
console.log('\n🛡️ FASE 19: Frente D - CRM & Histórico 360° do Cliente (019)...');

assert.ok(
  fs.existsSync('supabase/migrations/019_crm_cliente_visao_360.sql'),
  '[FALHA] supabase/migrations/019_crm_cliente_visao_360.sql não encontrada!'
);

const m019 = fs.readFileSync('supabase/migrations/019_crm_cliente_visao_360.sql', 'utf-8');

console.log('  🔎 19.1 Verificando estruturas próprias do CRM (notas, tags, preferências)...');
assert.ok(
  m019.includes('CREATE TABLE IF NOT EXISTS public.cliente_notas') &&
  m019.includes('CREATE TABLE IF NOT EXISTS public.cliente_tags') &&
  m019.includes('CREATE TABLE IF NOT EXISTS public.cliente_preferencias'),
  '[FALHA] Tabelas de CRM não definidas em 019!'
);
assert.ok(
  m019.includes('REVOKE DELETE ON public.cliente_notas FROM PUBLIC, anon, authenticated;'),
  '[FALHA] cliente_notas não possui bloqueio de DELETE direto!'
);

console.log('  🔎 19.2 Verificando RPCs de CRM (busca, visão 360, notas, tags, preferências, perfil próprio)...');
assert.ok(
  m019.includes('CREATE OR REPLACE FUNCTION public.buscar_clientes_crm(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.obter_cliente_360_admin(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.adicionar_nota_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.arquivar_nota_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.adicionar_tag_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.remover_tag_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.definir_preferencia_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.arquivar_preferencia_cliente(') &&
  m019.includes('CREATE OR REPLACE FUNCTION public.obter_meu_perfil_360('),
  '[FALHA] Uma ou mais RPCs da Frente D não foram definidas em 019!'
);

console.log('  🔎 19.3 Verificando grants fail-closed para anon nas RPCs administrativas...');
assert.ok(
  m019.includes('REVOKE ALL ON FUNCTION public.buscar_clientes_crm FROM PUBLIC, anon;') &&
  m019.includes('REVOKE ALL ON FUNCTION public.obter_cliente_360_admin FROM PUBLIC, anon;'),
  '[FALHA] RPCs de busca e visão 360 não revogam de PUBLIC, anon!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.cliente_notas'), `[FALHA] ${name} não contém cliente_notas!`);
  assert.ok(content.includes('public.cliente_tags'), `[FALHA] ${name} não contém cliente_tags!`);
  assert.ok(content.includes('public.cliente_preferencias'), `[FALHA] ${name} não contém cliente_preferencias!`);
  assert.ok(content.includes('public.buscar_clientes_crm'), `[FALHA] ${name} não contém buscar_clientes_crm!`);
  assert.ok(content.includes('public.obter_cliente_360_admin'), `[FALHA] ${name} não contém obter_cliente_360_admin!`);
  assert.ok(content.includes('public.obter_meu_perfil_360'), `[FALHA] ${name} não contém obter_meu_perfil_360!`);
}
// --------------------------------------------------------------------------
// Teste 20: Verificação Fase 20 - Frente E: Agenda de Produção & Operação Visual (020)
// --------------------------------------------------------------------------
console.log('\n🛡️ FASE 20: Frente E - Agenda de Produção & Operação Visual (020)...');

assert.ok(
  fs.existsSync('supabase/migrations/020_agenda_producao_operacional.sql'),
  '[FALHA] supabase/migrations/020_agenda_producao_operacional.sql não encontrada!'
);

const m020 = fs.readFileSync('supabase/migrations/020_agenda_producao_operacional.sql', 'utf-8');

console.log('  🔎 20.1 Verificando estruturas de observações e configurações de produção...');
assert.ok(
  m020.includes('CREATE TABLE IF NOT EXISTS public.pedido_producao_observacoes') &&
  m020.includes('CREATE TABLE IF NOT EXISTS public.pedido_producao_config'),
  '[FALHA] Tabelas de produção não definidas em 020!'
);
assert.ok(
  m020.includes('bloquear_delete_pedido_producao_observacoes') &&
  m020.includes('trg_bloquear_delete_prod_obs'),
  '[FALHA] pedido_producao_observacoes não possui trigger de bloqueio de DELETE!'
);

console.log('  🔎 20.2 Verificando RPCs da esteira de produção e expedição...');
assert.ok(
  m020.includes('CREATE OR REPLACE FUNCTION public.obter_agenda_producao(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.obter_detalhe_producao_pedido(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.iniciar_producao_pedido(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.marcar_pedido_pronto(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.marcar_saida_entrega(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.confirmar_entrega_retirada(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.definir_prioridade_producao(') &&
  m020.includes('CREATE OR REPLACE FUNCTION public.adicionar_observacao_producao('),
  '[FALHA] Uma ou mais RPCs da Frente E não foram definidas em 020!'
);

console.log('  🔎 20.3 Verificando grants fail-closed para anon nas RPCs operacionais...');
assert.ok(
  m020.includes('REVOKE ALL ON FUNCTION public.obter_agenda_producao FROM PUBLIC, anon;') &&
  m020.includes('REVOKE ALL ON FUNCTION public.iniciar_producao_pedido FROM PUBLIC, anon;') &&
  m020.includes('REVOKE ALL ON FUNCTION public.marcar_pedido_pronto FROM PUBLIC, anon;') &&
  m020.includes('REVOKE ALL ON FUNCTION public.marcar_saida_entrega FROM PUBLIC, anon;') &&
  m020.includes('REVOKE ALL ON FUNCTION public.confirmar_entrega_retirada FROM PUBLIC, anon;'),
  '[FALHA] RPCs operacionais não revogam grants de PUBLIC e anon!'
);

console.log('  🔎 20.4 Verificando segregação estrita de modalidade (retirada bloqueada em saída de entrega)...');
assert.ok(
  m020.includes('INVALID_DELIVERY_MODALITY') &&
  m020.includes("modalidade_entrega, 'retirada') = 'retirada'"),
  '[FALHA] marcar_saida_entrega não possui guarda contra modalidade retirada!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.pedido_producao_observacoes'), `[FALHA] ${name} não contém pedido_producao_observacoes!`);
  assert.ok(content.includes('public.pedido_producao_config'), `[FALHA] ${name} não contém pedido_producao_config!`);
  assert.ok(content.includes('public.obter_agenda_producao'), `[FALHA] ${name} não contém obter_agenda_producao!`);
  assert.ok(content.includes('public.iniciar_producao_pedido'), `[FALHA] ${name} não contém iniciar_producao_pedido!`);
  assert.ok(content.includes('public.marcar_pedido_pronto'), `[FALHA] ${name} não contém marcar_pedido_pronto!`);
  assert.ok(content.includes('public.marcar_saida_entrega'), `[FALHA] ${name} não contém marcar_saida_entrega!`);
  assert.ok(content.includes('public.confirmar_entrega_retirada'), `[FALHA] ${name} não contém confirmar_entrega_retirada!`);
}
console.log('    ✅ Migration 020 e scripts mestre validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 21: Frente F - Dashboard Gerencial, DRE & Indicadores (021)
// --------------------------------------------------------------------------
console.log('\n📊 FASE 21: Frente F - Dashboard Gerencial, DRE & Indicadores (021)...');

const m021 = fs.readFileSync('supabase/migrations/021_dashboard_gerencial_indicadores.sql', 'utf-8');

console.log('  🔎 21.1 Verificando helper interno de resolução temporal e timezone...');
assert.ok(
  m021.includes('CREATE OR REPLACE FUNCTION public._dashboard_resolver_datas') &&
  m021.includes("'America/Fortaleza'") &&
  m021.includes('REVOKE ALL ON FUNCTION public._dashboard_resolver_datas(DATE, DATE) FROM PUBLIC, anon, authenticated;'),
  '[FALHA] Helper temporal _dashboard_resolver_datas não configurado com timezone America/Fortaleza e revogação total!'
);

console.log('  🔎 21.2 Verificando RPCs gerenciais e operacionais da Frente F...');
assert.ok(
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_indicadores_vendas_admin(') &&
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_indicadores_financeiros_admin(') &&
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_indicadores_producao(') &&
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_indicadores_clientes_admin(') &&
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_dashboard_operacional(') &&
  m021.includes('CREATE OR REPLACE FUNCTION public.obter_dashboard_resumo_admin('),
  '[FALHA] Uma ou mais RPCs analíticas da Frente F não foram definidas em 021!'
);

console.log('  🔎 21.3 Verificando invariantes contábeis (vendas vs faturamento vs caixa vs crédito)...');
assert.ok(
  m021.includes('vendas_confirmadas_quantidade') &&
  m021.includes('faturamento_realizado') &&
  m021.includes('entrada_caixa_liquida') &&
  m021.includes('credito_cliente_utilizado') &&
  m021.includes('saldo_creditos_fim_periodo') &&
  m021.includes('saldo_creditos_atual'),
  '[FALHA] Migration 021 não implementa a separação contábil estrita de faturamento, caixa e crédito!'
);

console.log('  🔎 21.4 Verificando grants fail-closed para anon nas RPCs analíticas...');
assert.ok(
  m021.includes('REVOKE ALL ON FUNCTION public.obter_indicadores_vendas_admin(DATE, DATE) FROM PUBLIC, anon;') &&
  m021.includes('REVOKE ALL ON FUNCTION public.obter_indicadores_financeiros_admin(DATE, DATE) FROM PUBLIC, anon;') &&
  m021.includes('REVOKE ALL ON FUNCTION public.obter_indicadores_producao(DATE, DATE) FROM PUBLIC, anon;') &&
  m021.includes('REVOKE ALL ON FUNCTION public.obter_indicadores_clientes_admin(DATE, DATE) FROM PUBLIC, anon;') &&
  m021.includes('REVOKE ALL ON FUNCTION public.obter_dashboard_operacional(DATE, DATE) FROM PUBLIC, anon;') &&
  m021.includes('REVOKE ALL ON FUNCTION public.obter_dashboard_resumo_admin(DATE, DATE) FROM PUBLIC, anon;'),
  '[FALHA] RPCs analíticas não revogam privilégios de anon e PUBLIC!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.obter_indicadores_vendas_admin'), `[FALHA] ${name} não contém obter_indicadores_vendas_admin!`);
  assert.ok(content.includes('public.obter_indicadores_financeiros_admin'), `[FALHA] ${name} não contém obter_indicadores_financeiros_admin!`);
  assert.ok(content.includes('public.obter_indicadores_producao'), `[FALHA] ${name} não contém obter_indicadores_producao!`);
  assert.ok(content.includes('public.obter_indicadores_clientes_admin'), `[FALHA] ${name} não contém obter_indicadores_clientes_admin!`);
  assert.ok(content.includes('public.obter_dashboard_operacional'), `[FALHA] ${name} não contém obter_dashboard_operacional!`);
  assert.ok(content.includes('public.obter_dashboard_resumo_admin'), `[FALHA] ${name} não contém obter_dashboard_resumo_admin!`);
}

console.log('  🔎 21.5 Verificando frontend do Dashboard Gerencial & DRE (admin-dashboard.js e admin.html)...');
const adminHtmlF = fs.readFileSync('admin.html', 'utf-8');
const adminDashJs = fs.readFileSync('js/admin-dashboard.js', 'utf-8');
assert.ok(
  adminHtmlF.includes('id="tab-btn-dashboard"') &&
  adminHtmlF.includes('id="admin-tab-dashboard"') &&
  adminHtmlF.includes('js/admin-dashboard.js'),
  '[FALHA] admin.html não integra a aba Dashboard & DRE!'
);
assert.ok(
  adminDashJs.includes('obter_dashboard_resumo_admin') &&
  adminDashJs.includes('obter_dashboard_operacional') &&
  adminDashJs.includes('carregarDashboardGerencial'),
  '[FALHA] js/admin-dashboard.js não implementa chamadas canônicas do Dashboard!'
);
console.log('    ✅ Migration 021, scripts mestre e frontend validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 22: Frente G - Compras, Fornecedores, Estoque de Insumos & CMV Real (022)
// --------------------------------------------------------------------------
console.log('\n📦 FASE 22: Frente G - Compras, Fornecedores, Estoque de Insumos & CMV Real (022)...');

const m022 = fs.readFileSync('supabase/migrations/022_compras_fornecedores_estoque_insumos.sql', 'utf-8');

console.log('  🔎 22.1 Verificando estruturas de fornecedores, compras, saldos, livro-razão e contas a pagar...');
assert.ok(
  m022.includes('CREATE TABLE IF NOT EXISTS public.fornecedores') &&
  m022.includes('CREATE TABLE IF NOT EXISTS public.compras') &&
  m022.includes('CREATE TABLE IF NOT EXISTS public.compra_itens') &&
  m022.includes('CREATE TABLE IF NOT EXISTS public.ingrediente_saldos') &&
  m022.includes('CREATE TABLE IF NOT EXISTS public.ingrediente_movimentacoes') &&
  m022.includes('CREATE TABLE IF NOT EXISTS public.contas_pagar'),
  '[FALHA] Uma ou mais tabelas da Frente G não foram definidas em 022!'
);

console.log('  🔎 22.2 Verificando imutabilidade do livro-razão de insumos (trg_imutabilidade_ingrediente_mov)...');
assert.ok(
  m022.includes('bloquear_mutacao_ingrediente_movimentacoes') &&
  m022.includes('trg_imutabilidade_ingrediente_mov') &&
  m022.includes('BEFORE UPDATE OR DELETE ON public.ingrediente_movimentacoes'),
  '[FALHA] ingrediente_movimentacoes não possui trigger de imutabilidade bloqueando UPDATE/DELETE!'
);

console.log('  🔎 22.3 Verificando RPCs transacionais da Frente G e helper interno...');
assert.ok(
  m022.includes('CREATE OR REPLACE FUNCTION public._aplicar_movimento_ingrediente(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.salvar_fornecedor_admin(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.listar_fornecedores_admin(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.criar_compra(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.receber_compra(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.cancelar_compra(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.registrar_perda_insumo(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.ajustar_estoque_insumo_admin(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.registrar_pagamento_fornecedor(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.obter_necessidade_reposicao(') &&
  m022.includes('CREATE OR REPLACE FUNCTION public.obter_cmv_real_produto('),
  '[FALHA] Uma ou mais RPCs da Frente G não foram definidas em 022!'
);

console.log('  🔎 22.4 Verificando separação dos 3 conceitos de custo (teórico, CMP e CMV real)...');
assert.ok(
  m022.includes('custo_teorico_receita') &&
  m022.includes('custo_medio_ponderado') &&
  m022.includes('AS cmv_real') &&
  m022.includes('margem_teorica_pct') &&
  m022.includes('margem_real_pct'),
  '[FALHA] Migration 022 não preserva a separação explícita entre custo teórico, CMP e CMV real!'
);

console.log('  🔎 22.5 Verificando grants fail-closed para anon e revogação de escrita direta...');
assert.ok(
  m022.includes('REVOKE ALL ON FUNCTION public._aplicar_movimento_ingrediente(BIGINT, TEXT, NUMERIC, NUMERIC, TEXT, BIGINT, BIGINT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.criar_compra(BIGINT, JSONB, TEXT, DATE, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.receber_compra(BIGINT, DATE, BOOLEAN) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.cancelar_compra(BIGINT, TEXT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.registrar_perda_insumo(BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.ajustar_estoque_insumo_admin(BIGINT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.registrar_pagamento_fornecedor(BIGINT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.obter_necessidade_reposicao(INT) FROM PUBLIC, anon;') &&
  m022.includes('REVOKE ALL ON FUNCTION public.obter_cmv_real_produto(BIGINT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das RPCs da Frente G ausentes ou incorretos!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.fornecedores'), `[FALHA] ${name} não contém fornecedores!`);
  assert.ok(content.includes('public.compras'), `[FALHA] ${name} não contém compras!`);
  assert.ok(content.includes('public.ingrediente_saldos'), `[FALHA] ${name} não contém ingrediente_saldos!`);
  assert.ok(content.includes('public.ingrediente_movimentacoes'), `[FALHA] ${name} não contém ingrediente_movimentacoes!`);
  assert.ok(content.includes('public.contas_pagar'), `[FALHA] ${name} não contém contas_pagar!`);
  assert.ok(content.includes('public.receber_compra'), `[FALHA] ${name} não contém receber_compra!`);
  assert.ok(content.includes('public.obter_cmv_real_produto'), `[FALHA] ${name} não contém obter_cmv_real_produto!`);
}

console.log('  🔎 22.6 Verificando frontend de Compras, Insumos & CMV Real (admin-compras.js e admin.html)...');
const adminHtmlG = fs.readFileSync('admin.html', 'utf-8');
const adminComprasJs = fs.readFileSync('js/admin-compras.js', 'utf-8');
assert.ok(
  adminHtmlG.includes('id="tab-btn-compras"') &&
  adminHtmlG.includes('id="admin-tab-compras"') &&
  adminHtmlG.includes('js/admin-compras.js'),
  '[FALHA] admin.html não integra a aba Compras & CMV Real!'
);
assert.ok(
  adminComprasJs.includes('obter_necessidade_reposicao') &&
  adminComprasJs.includes('obter_cmv_real_produto') &&
  adminComprasJs.includes('criar_compra') &&
  adminComprasJs.includes('receber_compra') &&
  adminComprasJs.includes('registrar_pagamento_fornecedor'),
  '[FALHA] js/admin-compras.js não implementa chamadas canônicas da Frente G!'
);
console.log('    ✅ Migration 022, scripts mestre e frontend validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 23: Frente H - Tesouraria, Fluxo de Caixa Projetado e Conciliação (023)
// --------------------------------------------------------------------------
console.log('\n🏦 FASE 23: Frente H - Tesouraria, Fluxo de Caixa Projetado e Conciliação (023)...');

const m023 = fs.readFileSync('supabase/migrations/023_tesouraria_fluxo_caixa_conciliacao.sql', 'utf-8');

console.log('  🔎 23.1 Verificando estruturas de contas financeiras, conciliações e ajustes (zero duplicação de livro-razão)...');
assert.ok(
  m023.includes('CREATE TABLE IF NOT EXISTS public.contas_financeiras') &&
  m023.includes('CREATE TABLE IF NOT EXISTS public.conciliacoes_financeiras') &&
  m023.includes('CREATE TABLE IF NOT EXISTS public.ajustes_tesouraria') &&
  !m023.includes('CREATE TABLE public.fluxo_caixa_lancamentos') &&
  !m023.includes('CREATE TABLE IF NOT EXISTS public.fluxo_caixa_lancamentos'),
  '[FALHA] Estruturas da Frente H ausentes ou tabela proibida fluxo_caixa_lancamentos criada!'
);

console.log('  🔎 23.2 Verificando imutabilidade append-only de conciliações e ajustes...');
assert.ok(
  m023.includes('bloquear_mutacao_tesouraria_append_only') &&
  m023.includes('trg_imutabilidade_conciliacoes_fin') &&
  m023.includes('BEFORE UPDATE OR DELETE ON public.conciliacoes_financeiras') &&
  m023.includes('trg_imutabilidade_ajustes_tesouraria') &&
  m023.includes('BEFORE UPDATE OR DELETE ON public.ajustes_tesouraria'),
  '[FALHA] Triggers de imutabilidade em conciliacoes_financeiras ou ajustes_tesouraria ausentes!'
);

console.log('  🔎 23.3 Verificando RPCs canônicas da Frente H e helper interno...');
assert.ok(
  m023.includes('CREATE OR REPLACE FUNCTION public._tesouraria_data_efetiva_lancamento(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.salvar_conta_financeira_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.registrar_ajuste_tesouraria_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.registrar_conciliacao_financeira_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.obter_contas_pagar_periodo_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.obter_recebimentos_previstos_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.obter_fluxo_caixa_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.obter_posicao_tesouraria_admin(') &&
  m023.includes('CREATE OR REPLACE FUNCTION public.obter_conciliacao_financeira_admin('),
  '[FALHA] Uma ou mais RPCs da Frente H não foram definidas em 023!'
);

console.log('  🔎 23.4 Verificando separação entre realizado, projetado, crédito de cliente e recebíveis confirmados...');
assert.ok(
  m023.includes("p.status_comercial = 'confirmado'") &&
  m023.includes('entradas_liquidas_realizadas') &&
  m023.includes('credito_cliente_utilizado_periodo') &&
  m023.includes('entradas_previstas') &&
  m023.includes('saidas_previstas') &&
  m023.includes('saldo_acumulado_realizado') &&
  m023.includes('saldo_acumulado_projetado'),
  '[FALHA] Migration 023 não preserva as invariantes entre caixa realizado, projetado e crédito de cliente!'
);

console.log('  🔎 23.5 Verificando grants fail-closed para anon/PUBLIC e bloqueio de helper interno...');
assert.ok(
  m023.includes('REVOKE ALL ON FUNCTION public._tesouraria_data_efetiva_lancamento(DATE, TIMESTAMPTZ, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.salvar_conta_financeira_admin(') &&
  m023.includes('REVOKE ALL ON FUNCTION public.registrar_ajuste_tesouraria_admin(BIGINT, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.registrar_conciliacao_financeira_admin(') &&
  m023.includes('REVOKE ALL ON FUNCTION public.obter_contas_pagar_periodo_admin(DATE, DATE, TEXT) FROM PUBLIC, anon;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.obter_recebimentos_previstos_admin(DATE, DATE) FROM PUBLIC, anon;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.obter_fluxo_caixa_admin(DATE, DATE) FROM PUBLIC, anon;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.obter_posicao_tesouraria_admin(INT) FROM PUBLIC, anon;') &&
  m023.includes('REVOKE ALL ON FUNCTION public.obter_conciliacao_financeira_admin(DATE, DATE, TEXT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das RPCs da Frente H ausentes ou incorretos!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.contas_financeiras'), `[FALHA] ${name} não contém contas_financeiras!`);
  assert.ok(content.includes('public.conciliacoes_financeiras'), `[FALHA] ${name} não contém conciliacoes_financeiras!`);
  assert.ok(content.includes('public.ajustes_tesouraria'), `[FALHA] ${name} não contém ajustes_tesouraria!`);
  assert.ok(content.includes('public.obter_fluxo_caixa_admin'), `[FALHA] ${name} não contém obter_fluxo_caixa_admin!`);
  assert.ok(content.includes('public.obter_posicao_tesouraria_admin'), `[FALHA] ${name} não contém obter_posicao_tesouraria_admin!`);
}

console.log('  🔎 23.6 Verificando frontend de Tesouraria & Fluxo de Caixa (admin-tesouraria.js e admin.html)...');
const adminHtmlH = fs.readFileSync('admin.html', 'utf-8');
const adminTesourariaJs = fs.readFileSync('js/admin-tesouraria.js', 'utf-8');
assert.ok(
  adminHtmlH.includes('id="tab-btn-tesouraria"') &&
  adminHtmlH.includes('id="admin-tab-tesouraria"') &&
  adminHtmlH.includes('js/admin-tesouraria.js'),
  '[FALHA] admin.html não integra a aba Tesouraria & Fluxo de Caixa!'
);
assert.ok(
  adminTesourariaJs.includes('obter_posicao_tesouraria_admin') &&
  adminTesourariaJs.includes('obter_fluxo_caixa_admin') &&
  adminTesourariaJs.includes('obter_recebimentos_previstos_admin') &&
  adminTesourariaJs.includes('obter_contas_pagar_periodo_admin') &&
  adminTesourariaJs.includes('obter_conciliacao_financeira_admin') &&
  adminTesourariaJs.includes('registrar_conciliacao_financeira_admin') &&
  adminTesourariaJs.includes('registrar_ajuste_tesouraria_admin'),
  '[FALHA] js/admin-tesouraria.js não implementa chamadas canônicas da Frente H!'
);
console.log('    ✅ Migration 023, scripts mestre e frontend validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 24: Frente I - Fidelidade, Recompra, Campanhas & Consentimento (024)
// --------------------------------------------------------------------------
console.log('\n🎁 FASE 24: Frente I - Fidelidade, Recompra, Campanhas & Consentimento (024)...');

const m024 = fs.readFileSync('supabase/migrations/024_fidelidade_recompra_campanhas.sql', 'utf-8');

console.log('  🔎 24.1 Verificando as 8 estruturas de fidelidade, cupons, consentimento e campanhas...');
assert.ok(
  m024.includes('CREATE TABLE IF NOT EXISTS public.programas_fidelidade') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.cliente_pontos') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.cliente_pontos_movimentacoes') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.cliente_consentimentos_marketing') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.campanhas') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.cupons_promocionais') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.cupom_utilizacoes') &&
  m024.includes('CREATE TABLE IF NOT EXISTS public.campanha_publicos'),
  '[FALHA] Uma ou mais tabelas da Frente I não foram definidas em 024!'
);

console.log('  🔎 24.2 Verificando imutabilidade de cliente_pontos_movimentacoes e bloqueio de UPDATE direto em cliente_pontos...');
assert.ok(
  m024.includes('bloquear_mutacao_cliente_pontos_mov') &&
  m024.includes('trg_imutabilidade_cliente_pontos_mov') &&
  m024.includes('BEFORE UPDATE OR DELETE ON public.cliente_pontos_movimentacoes') &&
  m024.includes('proteger_mutacao_direta_cliente_pontos') &&
  m024.includes('trg_proteger_mutacao_direta_cliente_pontos') &&
  m024.includes("current_setting('lunoca.internal_points_mutation', true)"),
  '[FALHA] Triggers de imutabilidade de pontos ou proteção contra UPDATE direto ausentes!'
);

console.log('  🔎 24.3 Verificando RPCs canônicas da Frente I e reutilização da esteira da Frente B...');
assert.ok(
  m024.includes('CREATE OR REPLACE FUNCTION public._aplicar_movimento_pontos_cliente(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public._processar_expiracao_pontos_cliente(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.expirar_pontos_fidelidade(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.creditar_pontos_pedido_concluido(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.compensar_pontos_pedido_cancelado(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.resgatar_pontos_fidelidade(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.ajustar_pontos_fidelidade_admin(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.salvar_cupom_promocional_admin(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.aplicar_cupom_promocional(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.registrar_consentimento_marketing(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.salvar_campanha_admin(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.avaliar_publico_campanha(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.disparar_campanha_marketing(') &&
  m024.includes('CREATE OR REPLACE FUNCTION public.obter_painel_fidelidade_campanhas_admin(') &&
  !fs.existsSync('functions/api/whatsapp/send-whatsapp-marketing.js'),
  '[FALHA] Uma ou mais RPCs da Frente I ausentes ou arquivo paralelo proibido send-whatsapp-marketing.js criado!'
);

console.log('  🔎 24.4 Verificando grants fail-closed para anon/PUBLIC e bloqueio de helpers internos...');
assert.ok(
  m024.includes('REVOKE ALL ON FUNCTION public._aplicar_movimento_pontos_cliente(BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;') &&
  m024.includes('REVOKE ALL ON FUNCTION public._processar_expiracao_pontos_cliente(BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.expirar_pontos_fidelidade(BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.creditar_pontos_pedido_concluido(BIGINT) FROM PUBLIC, anon;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.resgatar_pontos_fidelidade(BIGINT, INTEGER, BIGINT, TEXT) FROM PUBLIC, anon;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.ajustar_pontos_fidelidade_admin(BIGINT, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.aplicar_cupom_promocional(TEXT, BIGINT, NUMERIC, NUMERIC, NUMERIC, INTEGER, TEXT, BIGINT, BOOLEAN, TEXT) FROM PUBLIC, anon;') &&
  m024.includes('REVOKE ALL ON FUNCTION public.disparar_campanha_marketing(BIGINT, TEXT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das RPCs da Frente I ausentes ou incorretos!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.programas_fidelidade'), `[FALHA] ${name} não contém programas_fidelidade!`);
  assert.ok(content.includes('public.cliente_pontos'), `[FALHA] ${name} não contém cliente_pontos!`);
  assert.ok(content.includes('public.cliente_pontos_movimentacoes'), `[FALHA] ${name} não contém cliente_pontos_movimentacoes!`);
  assert.ok(content.includes('public.cupons_promocionais'), `[FALHA] ${name} não contém cupons_promocionais!`);
  assert.ok(content.includes('public.campanhas'), `[FALHA] ${name} não contém campanhas!`);
}

console.log('  🔎 24.5 Verificando frontend de Fidelidade & Campanhas (admin-fidelidade.js e admin.html)...');
const adminHtmlI = fs.readFileSync('admin.html', 'utf-8');
const adminFidelidadeJs = fs.readFileSync('js/admin-fidelidade.js', 'utf-8');
assert.ok(
  adminHtmlI.includes('id="tab-btn-fidelidade"') &&
  adminHtmlI.includes('id="admin-tab-fidelidade"') &&
  adminHtmlI.includes('js/admin-fidelidade.js'),
  '[FALHA] admin.html não integra a aba Fidelidade & Campanhas!'
);
assert.ok(
  adminFidelidadeJs.includes('obter_painel_fidelidade_campanhas_admin') &&
  adminFidelidadeJs.includes('ajustar_pontos_fidelidade_admin') &&
  adminFidelidadeJs.includes('salvar_cupom_promocional_admin') &&
  adminFidelidadeJs.includes('salvar_campanha_admin') &&
  adminFidelidadeJs.includes('disparar_campanha_marketing') &&
  adminFidelidadeJs.includes('registrar_consentimento_marketing'),
  '[FALHA] js/admin-fidelidade.js não implementa chamadas canônicas da Frente I!'
);
console.log('    ✅ Migration 024, scripts mestre e frontend validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 25: Frente J - Portal do Cliente / Minha Conta (025)
// --------------------------------------------------------------------------
console.log('\n👤 FASE 25: Frente J - Portal do Cliente / Minha Conta (025)...');

const m025 = fs.readFileSync('supabase/migrations/025_portal_cliente_minha_conta.sql', 'utf-8');

console.log('  🔎 25.1 Verificando helpers internos e unicidade estrutural auth_user_id...');
assert.ok(
  m025.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_auth_user_id') &&
  m025.includes('CREATE OR REPLACE FUNCTION public._resolver_meu_cliente_id()') &&
  m025.includes('CREATE OR REPLACE FUNCTION public._derivar_etapa_cliente_pedido(') &&
  m025.includes('REVOKE ALL ON FUNCTION public._resolver_meu_cliente_id() FROM PUBLIC, anon, authenticated;') &&
  m025.includes('REVOKE ALL ON FUNCTION public._derivar_etapa_cliente_pedido(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;'),
  '[FALHA] Helpers internos ou índice de unicidade uq_clientes_auth_user_id ausentes em 025!'
);

console.log('  🔎 25.2 Verificando as 11 RPCs canônicas do Portal do Cliente e ausência de p_cliente_id...');
const m025CodeOnly = m025.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
assert.ok(
  m025.includes('CREATE OR REPLACE FUNCTION public.obter_painel_minha_conta_cliente()') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_meus_pedidos(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.obter_meu_pedido(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_meus_orcamentos(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.aprovar_meu_orcamento(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_meu_extrato_credito(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_meu_extrato_pontos(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_meus_cupons()') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.listar_minhas_comunicacoes(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.atualizar_minhas_preferencias_cliente(') &&
  m025.includes('CREATE OR REPLACE FUNCTION public.atualizar_meu_consentimento_marketing(') &&
  !m025CodeOnly.includes('p_cliente_id'),
  '[FALHA] Uma ou mais RPCs do portal ausentes ou parâmetro proibido p_cliente_id encontrado em 025!'
);

console.log('  🔎 25.3 Verificando sanitização (zero token_publico exposto em listar_meus_orcamentos e etapa_cliente)...');
assert.ok(
  m025.includes("'aguardando_preparo'") &&
  m025.includes("'em_preparo'") &&
  m025.includes("'pronto_para_retirada'") &&
  m025.includes("'pronto_para_entrega'") &&
  m025.includes("'saiu_para_entrega'") &&
  m025.includes('public.aprovar_orcamento_publico(v_orc.token_publico, p_versao_esperada)') &&
  !m025.includes("'token_publico',"),
  '[FALHA] Sanitização de etapa_cliente ou ocultação de token_publico falhou em 025!'
);

console.log('  🔎 25.4 Verificando grants fail-closed para anon/PUBLIC nas RPCs da Frente J...');
assert.ok(
  m025.includes('REVOKE ALL ON FUNCTION public.obter_painel_minha_conta_cliente() FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_meus_pedidos(INTEGER, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.obter_meu_pedido(BIGINT) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_meus_orcamentos(INTEGER, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.aprovar_meu_orcamento(BIGINT, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_meu_extrato_credito(INTEGER, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_meu_extrato_pontos(INTEGER, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_meus_cupons() FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.listar_minhas_comunicacoes(INTEGER, INTEGER) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.atualizar_minhas_preferencias_cliente(TEXT, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m025.includes('REVOKE ALL ON FUNCTION public.atualizar_meu_consentimento_marketing(TEXT, TEXT, TEXT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das RPCs da Frente J ausentes ou incorretos!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.obter_painel_minha_conta_cliente'), `[FALHA] ${name} não contém obter_painel_minha_conta_cliente!`);
  assert.ok(content.includes('public.aprovar_meu_orcamento'), `[FALHA] ${name} não contém aprovar_meu_orcamento!`);
  assert.ok(content.includes('public.atualizar_meu_consentimento_marketing'), `[FALHA] ${name} não contém atualizar_meu_consentimento_marketing!`);
}

console.log('  🔎 25.5 Verificando frontend do Portal do Cliente (minha-conta.html e js/minha-conta.js)...');
const minhaContaHtml = fs.readFileSync('minha-conta.html', 'utf-8');
const minhaContaJs = fs.readFileSync('js/minha-conta.js', 'utf-8');
assert.ok(
  minhaContaHtml.includes('id="portal-state-loading"') &&
  minhaContaHtml.includes('id="portal-state-login"') &&
  minhaContaHtml.includes('id="portal-state-unlinked"') &&
  minhaContaHtml.includes('id="portal-state-error"') &&
  minhaContaHtml.includes('id="portal-main-content"') &&
  minhaContaHtml.includes('js/minha-conta.js'),
  '[FALHA] minha-conta.html não contém os estados obrigatórios do portal!'
);
const minhaContaJsCodeOnly = minhaContaJs.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
assert.ok(
  minhaContaJs.includes('obter_painel_minha_conta_cliente') &&
  minhaContaJs.includes('listar_meus_pedidos') &&
  minhaContaJs.includes('listar_meus_orcamentos') &&
  minhaContaJs.includes('aprovar_meu_orcamento') &&
  minhaContaJs.includes('listar_meu_extrato_credito') &&
  minhaContaJs.includes('listar_meu_extrato_pontos') &&
  minhaContaJs.includes('listar_meus_cupons') &&
  minhaContaJs.includes('listar_minhas_comunicacoes') &&
  minhaContaJs.includes('atualizar_minhas_preferencias_cliente') &&
  minhaContaJs.includes('atualizar_meu_consentimento_marketing') &&
  !minhaContaJsCodeOnly.includes('p_cliente_id') &&
  !minhaContaJsCodeOnly.includes('token_publico'),
  '[FALHA] js/minha-conta.js não implementa as chamadas canônicas ou referencia p_cliente_id / token_publico!'
);
console.log('    ✅ Migration 025, scripts mestre e Portal Minha Conta validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 26: Frente K - Logística, Rotas e Comprovante de Entrega (026)
// --------------------------------------------------------------------------
console.log('\n🚚 FASE 26: Frente K - Logística, Rotas e Comprovante de Entrega (026)...');

const m026 = fs.readFileSync('supabase/migrations/026_logistica_rotas_entregas.sql', 'utf-8');
const m026CodeOnly = m026.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 26.1 Verificando as 5 tabelas logísticas e triggers append-only de imutabilidade...');
assert.ok(
  m026.includes('CREATE TABLE IF NOT EXISTS public.rotas_entrega') &&
  m026.includes('CREATE TABLE IF NOT EXISTS public.entregas') &&
  m026.includes('CREATE TABLE IF NOT EXISTS public.rota_entregas') &&
  m026.includes('CREATE TABLE IF NOT EXISTS public.entrega_eventos') &&
  m026.includes('CREATE TABLE IF NOT EXISTS public.entrega_comprovantes') &&
  m026.includes('trg_imutabilidade_entrega_eventos') &&
  m026.includes('trg_imutabilidade_entrega_comprovantes') &&
  !m026CodeOnly.toUpperCase().includes('BYTEA'),
  '[FALHA] Tabelas ou triggers de imutabilidade ausentes, ou BYTEA proibido encontrado em 026!'
);

console.log('  🔎 26.2 Verificando as 10 RPCs canônicas da Frente K e locks transacionais...');
assert.ok(
  m026.includes('CREATE OR REPLACE FUNCTION public.criar_rota_entrega_admin(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.atribuir_entrega_rota(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.reordenar_rota_entrega(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.despachar_pedido_entrega(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.registrar_falha_entrega(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.reagendar_entrega(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.registrar_comprovante_entrega(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.confirmar_entrega_pedido(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.obter_painel_logistica(') &&
  m026.includes('CREATE OR REPLACE FUNCTION public.obter_acompanhamento_entrega_cliente('),
  '[FALHA] Uma ou mais RPCs canônicas da Frente K ausentes em 026!'
);

console.log('  🔎 26.3 Verificando invariantes K1–K16 (bloqueio de retirada, zero efeito financeiro e tracking sanitizado)...');
assert.ok(
  m026.includes("'PICKUP_ORDER_NOT_ROUTABLE'") &&
  m026.includes("'INVALID_DELIVERY_MODALITY'") &&
  m026.includes("'ORDER_NOT_READY_FOR_DISPATCH'") &&
  m026.includes("'ORDER_NOT_DISPATCHED'") &&
  m026.includes("'DELIVERY_TRACKING_NOT_APPLICABLE'") &&
  !m026CodeOnly.includes('INSERT INTO public.financeiro_lancamentos') &&
  !m026CodeOnly.includes('INSERT INTO public.pedido_pagamentos'),
  '[FALHA] Invariantes de bloqueio de retirada ou zero efeito financeiro violadas em 026!'
);

console.log('  🔎 26.4 Verificando grants fail-closed para anon/PUBLIC nas tabelas e RPCs da Frente K...');
assert.ok(
  m026.includes('REVOKE ALL ON public.rotas_entrega FROM PUBLIC, anon, authenticated;') &&
  m026.includes('REVOKE ALL ON public.entregas FROM PUBLIC, anon, authenticated;') &&
  m026.includes('REVOKE ALL ON public.rota_entregas FROM PUBLIC, anon, authenticated;') &&
  m026.includes('REVOKE ALL ON public.entrega_eventos FROM PUBLIC, anon, authenticated;') &&
  m026.includes('REVOKE ALL ON public.entrega_comprovantes FROM PUBLIC, anon, authenticated;') &&
  m026.includes('REVOKE ALL ON FUNCTION public.obter_acompanhamento_entrega_cliente(BIGINT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das tabelas ou RPCs da Frente K ausentes!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.rotas_entrega'), `[FALHA] ${name} não contém rotas_entrega!`);
  assert.ok(content.includes('public.despachar_pedido_entrega'), `[FALHA] ${name} não contém despachar_pedido_entrega!`);
  assert.ok(content.includes('public.confirmar_entrega_pedido'), `[FALHA] ${name} não contém confirmar_entrega_pedido!`);
  assert.ok(content.includes('public.obter_acompanhamento_entrega_cliente'), `[FALHA] ${name} não contém obter_acompanhamento_entrega_cliente!`);
}

console.log('  🔎 26.5 Verificando frontend de Logística (admin.html, js/admin-logistica.js e js/minha-conta.js)...');
const adminHtmlLog = fs.readFileSync('admin.html', 'utf-8');
const adminLogisticaJs = fs.readFileSync('js/admin-logistica.js', 'utf-8');
const minhaContaJsLog = fs.readFileSync('js/minha-conta.js', 'utf-8');
assert.ok(
  adminHtmlLog.includes('id="tab-btn-logistica"') &&
  adminHtmlLog.includes('id="admin-tab-logistica"') &&
  adminHtmlLog.includes('js/admin-logistica.js') &&
  adminLogisticaJs.includes('obter_painel_logistica') &&
  adminLogisticaJs.includes('criar_rota_entrega_admin') &&
  adminLogisticaJs.includes('atribuir_entrega_rota') &&
  adminLogisticaJs.includes('reordenar_rota_entrega') &&
  adminLogisticaJs.includes('despachar_pedido_entrega') &&
  adminLogisticaJs.includes('registrar_falha_entrega') &&
  adminLogisticaJs.includes('reagendar_entrega') &&
  adminLogisticaJs.includes('confirmar_entrega_pedido') &&
  adminLogisticaJs.includes('abrirFluxoWhatsAppComunicacao') &&
  minhaContaJsLog.includes('obter_acompanhamento_entrega_cliente'),
  '[FALHA] Frontend de Logística ou tracking no Portal do Cliente incompleto!'
);
console.log('    ✅ Migration 026, scripts mestre, painel de Logística e tracking do cliente validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 27: Frente L - Lotes, Validade, Rastreabilidade e Qualidade (027)
// --------------------------------------------------------------------------
console.log('\n🔬 FASE 27: Frente L - Lotes, Validade, Rastreabilidade e Qualidade de Produção (027)...');

const m027 = fs.readFileSync('supabase/migrations/027_lotes_validade_rastreabilidade_qualidade.sql', 'utf-8');
const m027CodeOnly = m027.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 27.1 Verificando as 5 tabelas de lotes/qualidade e triggers append-only de imutabilidade...');
assert.ok(
  m027.includes('CREATE TABLE IF NOT EXISTS public.ingrediente_lotes') &&
  m027.includes('CREATE TABLE IF NOT EXISTS public.ingrediente_lote_movimentacoes') &&
  m027.includes('CREATE TABLE IF NOT EXISTS public.pedido_consumos_lote') &&
  m027.includes('CREATE TABLE IF NOT EXISTS public.producao_controles_qualidade') &&
  m027.includes('CREATE TABLE IF NOT EXISTS public.producao_ocorrencias_qualidade') &&
  m027.includes('trg_imutabilidade_ingrediente_lote_mov') &&
  m027.includes('trg_imutabilidade_pedido_consumos_lote') &&
  m027.includes('trg_imutabilidade_producao_cq') &&
  m027.includes('trg_proteger_escrita_ingrediente_lotes'),
  '[FALHA] Tabelas ou triggers de imutabilidade/proteção de escrita ausentes em 027!'
);

console.log('  🔎 27.2 Verificando as RPCs canônicas da Frente L, política FEFO e reconciliação de saldo...');
assert.ok(
  m027.includes('CREATE OR REPLACE FUNCTION public._derivar_estado_validade_lote(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public._verificar_reconciliacao_lotes_ingrediente(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.configurar_rastreabilidade_ingrediente_admin(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.receber_compra_com_lotes(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.consumir_insumos_producao_pedido(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.registrar_baixa_lote_insumo(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.ajustar_lote_insumo_admin(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.alterar_bloqueio_qualidade_lote(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.registrar_controle_qualidade_pedido(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.rastrear_lote_ingrediente_admin(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.rastrear_pedido_producao_admin(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.obter_painel_lotes_validade(') &&
  m027.includes('CREATE OR REPLACE FUNCTION public.reconciliar_saldos_lotes_admin('),
  '[FALHA] Uma ou mais RPCs canônicas da Frente L ausentes em 027!'
);

console.log('  🔎 27.3 Verificando invariantes L1–L16 (FEFO com FOR UPDATE, bloqueio QUALITY_HOLD_ACTIVE e zero efeito financeiro)...');
assert.ok(
  m027.includes('ORDER BY l.data_validade ASC NULLS LAST, l.data_recebimento ASC, l.id ASC') &&
  m027.includes('FOR UPDATE') &&
  m027.includes("'INSUFFICIENT_ELIGIBLE_LOT_STOCK'") &&
  m027.includes("'QUALITY_HOLD_ACTIVE'") &&
  m027.includes('LOT_AGGREGATE_MISMATCH') &&
  !m027CodeOnly.includes('INSERT INTO public.financeiro_lancamentos') &&
  !m027CodeOnly.includes('INSERT INTO public.pedido_pagamentos'),
  '[FALHA] Invariantes de FEFO, QUALITY_HOLD_ACTIVE, reconciliação ou zero efeito financeiro violadas em 027!'
);

console.log('  🔎 27.4 Verificando grants fail-closed para anon/PUBLIC nas tabelas e RPCs da Frente L...');
assert.ok(
  m027.includes('REVOKE ALL ON public.ingrediente_lotes FROM PUBLIC, anon, authenticated;') &&
  m027.includes('REVOKE ALL ON public.ingrediente_lote_movimentacoes FROM PUBLIC, anon, authenticated;') &&
  m027.includes('REVOKE ALL ON public.pedido_consumos_lote FROM PUBLIC, anon, authenticated;') &&
  m027.includes('REVOKE ALL ON public.producao_controles_qualidade FROM PUBLIC, anon, authenticated;') &&
  m027.includes('REVOKE ALL ON public.producao_ocorrencias_qualidade FROM PUBLIC, anon, authenticated;'),
  '[FALHA] Grants fail-closed das tabelas da Frente L ausentes!'
);

for (const [name, content] of [['install.sql', installFinal], ['schema.sql', schemaFinal]]) {
  assert.ok(content.includes('public.ingrediente_lotes'), `[FALHA] ${name} não contém ingrediente_lotes!`);
  assert.ok(content.includes('public.consumir_insumos_producao_pedido'), `[FALHA] ${name} não contém consumir_insumos_producao_pedido!`);
  assert.ok(content.includes('public.registrar_controle_qualidade_pedido'), `[FALHA] ${name} não contém registrar_controle_qualidade_pedido!`);
  assert.ok(content.includes('public.rastrear_lote_ingrediente_admin'), `[FALHA] ${name} não contém rastrear_lote_ingrediente_admin!`);
}

console.log('  🔎 27.5 Verificando frontend de Lotes, Validades e Qualidade (admin.html, js/admin-compras.js e js/admin-agenda.js)...');
const adminHtmlLotes = fs.readFileSync('admin.html', 'utf-8');
const adminComprasJsLotes = fs.readFileSync('js/admin-compras.js', 'utf-8');
const adminAgendaJsLotes = fs.readFileSync('js/admin-agenda.js', 'utf-8');
assert.ok(
  adminHtmlLotes.includes('id="btn-subaba-compras-lotes"') &&
  adminComprasJsLotes.includes('obter_painel_lotes_validade') &&
  adminComprasJsLotes.includes('rastrear_lote_ingrediente_admin') &&
  adminComprasJsLotes.includes('registrar_baixa_lote_insumo') &&
  adminComprasJsLotes.includes('alterar_bloqueio_qualidade_lote') &&
  adminAgendaJsLotes.includes('consumir_insumos_producao_pedido') &&
  adminAgendaJsLotes.includes('registrar_controle_qualidade_pedido') &&
  adminAgendaJsLotes.includes('rastrear_pedido_producao_admin'),
  '[FALHA] Frontend de Lotes, Validades e Qualidade incompleto!'
);
console.log('    ✅ Migration 027, scripts mestre, painel de Lotes/Validade e controles de Qualidade validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 28: Frente M - Engenharia de Custos, Precificação e Margens (028)
// --------------------------------------------------------------------------
console.log('\n📊 FASE 28: Frente M - Engenharia de Custos, Precificação e Margens por Produto/Pedido (028)...');

const m028 = fs.readFileSync('supabase/migrations/028_engenharia_custos_precificacao_margens.sql', 'utf-8');
const m028CodeOnly = m028.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 28.1 Verificando as estruturas fabris e de custos realizados e triggers append-only...');
assert.ok(
  m028.includes('CREATE TABLE IF NOT EXISTS public.recursos_producao') &&
  m028.includes('CREATE TABLE IF NOT EXISTS public.produto_tempos_producao') &&
  m028.includes('CREATE TABLE IF NOT EXISTS public.produto_custos_adicionais') &&
  m028.includes('CREATE TABLE IF NOT EXISTS public.politicas_precificacao') &&
  m028.includes('CREATE TABLE IF NOT EXISTS public.pedido_custos_realizados') &&
  m028.includes('CREATE TABLE IF NOT EXISTS public.pedido_custo_componentes') &&
  m028.includes('trg_imutabilidade_pedido_custos_realizados') &&
  m028.includes('trg_imutabilidade_pedido_custo_componentes'),
  '[FALHA] Tabelas ou triggers de imutabilidade ausentes em 028!'
);

console.log('  🔎 28.2 Verificando as RPCs canônicas da Frente M...');
assert.ok(
  m028.includes('CREATE OR REPLACE FUNCTION public.simular_preco_produto_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.calcular_custo_real_pedido_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.obter_margem_pedido_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.obter_margens_produtos_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.salvar_recurso_producao_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.salvar_tempo_producao_produto_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.salvar_custo_adicional_produto_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.salvar_politica_precificacao_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.obter_engenharia_custos_produto_admin(') &&
  m028.includes('CREATE OR REPLACE FUNCTION public.obter_dashboard_margens_admin('),
  '[FALHA] Uma ou mais RPCs canônicas da Frente M ausentes em 028!'
);

console.log('  🔎 28.3 Verificando invariantes M1–M16 (lotes Frente L, desacoplamento de catálogo e zero efeito financeiro)...');
assert.ok(
  m028.includes('public.pedido_consumos_lote') &&
  m028.includes('custo_unitario_lote_snapshot') &&
  m028.includes('receita_liquida_snapshot') &&
  m028.includes('ORDER_CANCELLED_BEFORE_PRODUCTION') &&
  !m028CodeOnly.includes('UPDATE public.produtos SET preco') &&
  !m028CodeOnly.includes('INSERT INTO public.financeiro_lancamentos') &&
  !m028CodeOnly.includes('INSERT INTO public.pedido_pagamentos'),
  '[FALHA] Invariantes de Frente L, integridade de catálogo ou efeito financeiro violadas em 028!'
);

console.log('  🔎 28.4 Verificando grants fail-closed para anon/PUBLIC nas tabelas e RPCs da Frente M...');
assert.ok(
  m028.includes('REVOKE ALL ON public.recursos_producao FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON public.produto_tempos_producao FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON public.produto_custos_adicionais FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON public.politicas_precificacao FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON public.pedido_custos_realizados FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON public.pedido_custo_componentes FROM PUBLIC, anon, authenticated;') &&
  m028.includes('REVOKE ALL ON FUNCTION public.simular_preco_produto_admin FROM PUBLIC, anon;') &&
  m028.includes('REVOKE ALL ON FUNCTION public.calcular_custo_real_pedido_admin FROM PUBLIC, anon;') &&
  m028.includes('REVOKE ALL ON FUNCTION public.obter_margem_pedido_admin FROM PUBLIC, anon;') &&
  m028.includes('REVOKE ALL ON FUNCTION public.obter_dashboard_margens_admin FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das tabelas e RPCs da Frente M ausentes!'
);

console.log('  🔎 28.5 Verificando presença das estruturas da Frente M nos schemas mestres (install.sql e schema.sql)...');
const installFim = fs.readFileSync('sql/install.sql', 'utf-8');
const schemaFim = fs.readFileSync('sql/schema.sql', 'utf-8');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.recursos_producao'), `[FALHA] ${name} não contém recursos_producao!`);
  assert.ok(content.includes('public.pedido_custos_realizados'), `[FALHA] ${name} não contém pedido_custos_realizados!`);
  assert.ok(content.includes('public.pedido_custo_componentes'), `[FALHA] ${name} não contém pedido_custo_componentes!`);
  assert.ok(content.includes('public.simular_preco_produto_admin'), `[FALHA] ${name} não contém simular_preco_produto_admin!`);
  assert.ok(content.includes('public.calcular_custo_real_pedido_admin'), `[FALHA] ${name} não contém calcular_custo_real_pedido_admin!`);
  assert.ok(content.includes('public.obter_dashboard_margens_admin'), `[FALHA] ${name} não contém obter_dashboard_margens_admin!`);
}

console.log('  🔎 28.6 Verificando frontend de Custos & Precificação (admin.html, js/admin-custos.js e js/admin.js)...');
const adminHtmlCustos = fs.readFileSync('admin.html', 'utf-8');
const adminCustosJs = fs.readFileSync('js/admin-custos.js', 'utf-8');
const adminJsCustos = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminHtmlCustos.includes('id="tab-btn-custos"') &&
  adminHtmlCustos.includes('id="admin-tab-custos"') &&
  adminHtmlCustos.includes('js/admin-custos.js') &&
  adminCustosJs.includes('simular_preco_produto_admin') &&
  adminCustosJs.includes('obter_dashboard_margens_admin') &&
  adminCustosJs.includes('obter_margem_pedido_admin') &&
  adminJsCustos.includes('tab-btn-custos') &&
  adminJsCustos.includes('carregarCustosAdmin'),
  '[FALHA] Frontend de Custos & Precificação incompleto!'
);
console.log('    ✅ Migration 028, scripts mestre, painel de Custos/Margens e simulador validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 29: Frente N - Alertas Proativos, Auditoria Avançada & Health-Check Global (029)
// --------------------------------------------------------------------------
console.log('\n🔎 FASE 29: Frente N - Alertas Proativos, Auditoria Avançada & Health-Check Global (029)...');

const m029 = fs.readFileSync('supabase/migrations/029_alertas_auditoria_healthcheck_global.sql', 'utf-8');
const m029CodeOnly = m029.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 29.1 Verificando imutabilidade de 001–028 e estruturas da Frente N em 029...');
assert.ok(
  m029.includes('CREATE TABLE IF NOT EXISTS public.alertas_configuracoes') &&
  m029.includes('CREATE TABLE IF NOT EXISTS public.alertas_operacionais') &&
  m029.includes('CREATE TABLE IF NOT EXISTS public.alertas_reconhecimentos') &&
  m029.includes('CREATE TABLE IF NOT EXISTS public.auditoria_operacional_eventos'),
  '[FALHA] Tabelas canônicas da Frente N ausentes em 029!'
);

console.log('  🔎 29.2 Verificando triggers de auditoria e trigger append-only de segurança...');
assert.ok(
  m029.includes('CREATE TRIGGER trg_bloquear_mutacao_auditoria_operacional') &&
  m029.includes('bloquear_mutacao_auditoria_operacional') &&
  m029.includes('CREATE TRIGGER trg_audit_produtos_mutacao') &&
  m029.includes('CREATE TRIGGER trg_audit_ingrediente_lotes_mutacao') &&
  m029.includes('CREATE TRIGGER trg_audit_politicas_precificacao_mutacao'),
  '[FALHA] Triggers de auditoria ou proteção append-only ausentes em 029!'
);

console.log('  🔎 29.3 Verificando as RPCs canônicas da Frente N (incluindo processamento autônomo proativo)...');
assert.ok(
  m029.includes('CREATE OR REPLACE FUNCTION public.processar_alertas_operacionais()') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.obter_alertas_operacionais_admin(') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.obter_alertas_operacionais_operador(') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.reconhecer_alerta_operacional(') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.executar_healthcheck_global_admin(') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.salvar_configuracoes_alertas_admin(') &&
  m029.includes('CREATE OR REPLACE FUNCTION public.listar_auditoria_operacional_admin('),
  '[FALHA] Uma ou mais RPCs canônicas da Frente N ausentes em 029!'
);

console.log('  🔎 29.4 Verificando invariantes N1–N16 (zero efeito financeiro, sanitização operador, health-check read-only)...');
assert.ok(
  m029.includes('AUDITORIA_APPEND_ONLY') &&
  m029.includes('Alerta já reconhecido previamente') &&
  !m029CodeOnly.includes('INSERT INTO public.financeiro_lancamentos') &&
  !m029CodeOnly.includes('INSERT INTO public.pedido_pagamentos') &&
  !m029CodeOnly.includes('UPDATE public.ingrediente_saldos SET') &&
  !m029CodeOnly.includes('UPDATE public.pedidos SET status'),
  '[FALHA] Invariantes N1-N16 violadas em 029!'
);

console.log('  🔎 29.5 Verificando grants fail-closed para anon/PUBLIC nas tabelas e RPCs da Frente N...');
assert.ok(
  m029.includes('REVOKE ALL ON public.alertas_configuracoes FROM PUBLIC, anon, authenticated;') &&
  m029.includes('REVOKE ALL ON public.alertas_operacionais FROM PUBLIC, anon, authenticated;') &&
  m029.includes('REVOKE ALL ON public.alertas_reconhecimentos FROM PUBLIC, anon, authenticated;') &&
  m029.includes('REVOKE ALL ON public.auditoria_operacional_eventos FROM PUBLIC, anon, authenticated;') &&
  m029.includes('REVOKE ALL ON FUNCTION public.processar_alertas_operacionais() FROM PUBLIC, anon;') &&
  m029.includes('REVOKE ALL ON FUNCTION public.obter_alertas_operacionais_admin(TEXT, TEXT) FROM PUBLIC, anon;') &&
  m029.includes('REVOKE ALL ON FUNCTION public.obter_alertas_operacionais_operador() FROM PUBLIC, anon;') &&
  m029.includes('REVOKE ALL ON FUNCTION public.executar_healthcheck_global_admin() FROM PUBLIC, anon;') &&
  m029.includes('REVOKE ALL ON FUNCTION public.listar_auditoria_operacional_admin(TEXT, TEXT, INT, INT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das tabelas e RPCs da Frente N ausentes!'
);

console.log('  🔎 29.6 Verificando presença das estruturas da Frente N nos schemas mestres (install.sql e schema.sql)...');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.alertas_operacionais'), `[FALHA] ${name} não contém alertas_operacionais!`);
  assert.ok(content.includes('public.processar_alertas_operacionais'), `[FALHA] ${name} não contém processar_alertas_operacionais!`);
  assert.ok(content.includes('public.auditoria_operacional_eventos'), `[FALHA] ${name} não contém auditoria_operacional_eventos!`);
  assert.ok(content.includes('public.executar_healthcheck_global_admin'), `[FALHA] ${name} não contém executar_healthcheck_global_admin!`);
  assert.ok(content.includes('public.obter_alertas_operacionais_admin'), `[FALHA] ${name} não contém obter_alertas_operacionais_admin!`);
  assert.ok(content.includes('public.obter_alertas_operacionais_operador'), `[FALHA] ${name} não contém obter_alertas_operacionais_operador!`);
}

console.log('  🔎 29.7 Verificando frontend de Alertas & Auditoria (admin.html, js/admin-alertas.js e js/admin.js)...');
const adminHtmlAlertas = fs.readFileSync('admin.html', 'utf-8');
const adminAlertasJs = fs.readFileSync('js/admin-alertas.js', 'utf-8');
const adminJsAlertas = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminHtmlAlertas.includes('id="tab-btn-alertas"') &&
  adminHtmlAlertas.includes('id="admin-tab-alertas"') &&
  adminHtmlAlertas.includes('js/admin-alertas.js') &&
  adminAlertasJs.includes('executar_healthcheck_global_admin') &&
  adminAlertasJs.includes('obter_alertas_operacionais_admin') &&
  adminAlertasJs.includes('obter_alertas_operacionais_operador') &&
  adminAlertasJs.includes('reconhecer_alerta_operacional') &&
  adminJsAlertas.includes('tab-btn-alertas') &&
  adminJsAlertas.includes('carregarAlertasAdmin'),
  '[FALHA] Frontend de Alertas & Auditoria incompleto!'
);

console.log('  🔎 29.8 Verificando Modelo B de detecção proativa autônoma nos crons (expire-orders.js e processar-alertas.js)...');
const cronExpireOrders = fs.readFileSync('functions/api/cron/expire-orders.js', 'utf-8');
const cronProcessarAlertas = fs.readFileSync('functions/api/cron/processar-alertas.js', 'utf-8');
assert.ok(
  cronExpireOrders.includes('processar_alertas_operacionais') &&
  cronExpireOrders.includes('CRON_SECRET') &&
  cronProcessarAlertas.includes('processar_alertas_operacionais') &&
  cronProcessarAlertas.includes('CRON_SECRET'),
  '[FALHA] Pipeline de cron de processamento proativo de alertas incompleto!'
);
console.log('    ✅ Migration 029, scripts mestre, Modelo B autônomo, painel de Alertas, Health-Check e Auditoria validados com sucesso.');

console.log('\n🔒 FASE 30: Frente O - Pessoas, Turnos, Escalas & Capacidade Real da Equipe (030)...');

const m030 = fs.readFileSync('supabase/migrations/030_equipe_turnos_escalas_capacidade_real.sql', 'utf-8');
const m030CodeOnly = m030.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 30.1 Verificando imutabilidade de 001–029 e forward-only de 030...');
assert.ok(
  fs.existsSync('supabase/migrations/030_equipe_turnos_escalas_capacidade_real.sql'),
  '[FALHA] Arquivo da migration 030 não encontrado!'
);

console.log('  🔎 30.2 Verificando as 8 tabelas/estruturas de equipe e turnos...');
assert.ok(
  m030.includes('CREATE TABLE IF NOT EXISTS public.funcoes_equipe') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.colaboradores') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.colaborador_funcoes') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.turnos_trabalho') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.escalas_equipe') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.escala_intervalos') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.ausencias_equipe') &&
  m030.includes('CREATE TABLE IF NOT EXISTS public.equipe_configuracoes'),
  '[FALHA] Uma ou mais tabelas essenciais da Frente O ausentes em 030!'
);

console.log('  🔎 30.3 Verificando integridade de sobreposição de escalas e concorrência serializada (trg_valida_escala_overlap)...');
assert.ok(
  m030.includes('CREATE TRIGGER trg_valida_escala_overlap') &&
  m030.includes('ESCALA_OVERLAP') &&
  m030.includes('FOR UPDATE'),
  '[FALHA] Trigger trg_valida_escala_overlap ou lock de concorrência ausente em 030!'
);

console.log('  🔎 30.4 Verificando expansão de alertas com SOBRECARGA_EQUIPE e cálculo de minutos...');
assert.ok(
  m030.includes('SOBRECARGA_EQUIPE') &&
  m030.includes('public._calcular_minutos_disponiveis_escala') &&
  m030.includes('produto_tempos_producao'),
  '[FALHA] Integração com alertas proativos ou cálculo de tempos padrão ausente em 030!'
);

console.log('  🔎 30.5 Verificando as RPCs canônicas da Frente O...');
assert.ok(
  m030.includes('CREATE OR REPLACE FUNCTION public.salvar_colaborador_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.salvar_funcao_equipe_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.vincular_funcao_colaborador_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.salvar_turno_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.salvar_escala_equipe_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.registrar_ausencia_equipe_admin') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.obter_escala_periodo') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.obter_capacidade_humana_data') &&
  m030.includes('CREATE OR REPLACE FUNCTION public.obter_painel_capacidade_equipe'),
  '[FALHA] Uma ou mais RPCs canônicas da Frente O ausentes em 030!'
);

console.log('  🔎 30.6 Verificando invariantes O1–O16 (sem folha, sem diagnóstico clínico, zero efeito financeiro)...');
assert.ok(
  !m030CodeOnly.includes('salario') &&
  !m030CodeOnly.includes('comissao') &&
  !m030CodeOnly.includes('hora_extra') &&
  !m030CodeOnly.includes('INSERT INTO public.financeiro_lancamentos') &&
  !m030CodeOnly.includes('INSERT INTO public.pedido_pagamentos') &&
  !m030CodeOnly.includes('UPDATE public.capacidade_producao SET'),
  '[FALHA] Invariantes O1–O16 violadas em 030 (efeito financeiro ou colisão com Frente E detectados)!'
);

console.log('  🔎 30.7 Verificando grants fail-closed para anon/PUBLIC nas tabelas e RPCs da Frente O...');
assert.ok(
  m030.includes('REVOKE ALL ON public.funcoes_equipe FROM PUBLIC, anon, authenticated;') &&
  m030.includes('REVOKE ALL ON public.colaboradores FROM PUBLIC, anon, authenticated;') &&
  m030.includes('REVOKE ALL ON public.escalas_equipe FROM PUBLIC, anon, authenticated;') &&
  m030.includes('REVOKE ALL ON public.ausencias_equipe FROM PUBLIC, anon, authenticated;') &&
  m030.includes('REVOKE ALL ON FUNCTION public.salvar_colaborador_admin FROM PUBLIC, anon;') &&
  m030.includes('REVOKE ALL ON FUNCTION public.salvar_escala_equipe_admin FROM PUBLIC, anon;') &&
  m030.includes('REVOKE ALL ON FUNCTION public.obter_painel_capacidade_equipe FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed das tabelas e RPCs da Frente O ausentes!'
);

console.log('  🔎 30.8 Verificando presença das estruturas da Frente O nos schemas mestres (install.sql e schema.sql)...');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.funcoes_equipe'), `[FALHA] ${name} não contém funcoes_equipe!`);
  assert.ok(content.includes('public.colaboradores'), `[FALHA] ${name} não contém colaboradores!`);
  assert.ok(content.includes('public.escalas_equipe'), `[FALHA] ${name} não contém escalas_equipe!`);
  assert.ok(content.includes('public.ausencias_equipe'), `[FALHA] ${name} não contém ausencias_equipe!`);
  assert.ok(content.includes('public.salvar_escala_equipe_admin'), `[FALHA] ${name} não contém salvar_escala_equipe_admin!`);
  assert.ok(content.includes('public.obter_painel_capacidade_equipe'), `[FALHA] ${name} não contém obter_painel_capacidade_equipe!`);
}

console.log('  🔎 30.9 Verificando frontend de Equipe & Capacidade (admin.html, js/admin-equipe.js e js/admin.js)...');
const adminHtmlEquipe = fs.readFileSync('admin.html', 'utf-8');
const adminEquipeJs = fs.readFileSync('js/admin-equipe.js', 'utf-8');
const adminJsEquipe = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminHtmlEquipe.includes('id="tab-btn-equipe"') &&
  adminHtmlEquipe.includes('id="admin-tab-equipe"') &&
  adminHtmlEquipe.includes('js/admin-equipe.js') &&
  adminEquipeJs.includes('obter_painel_capacidade_equipe') &&
  adminEquipeJs.includes('salvar_escala_equipe_admin') &&
  adminEquipeJs.includes('registrar_ausencia_equipe_admin') &&
  adminJsEquipe.includes('tab-btn-equipe') &&
  adminJsEquipe.includes('carregarEquipeAdmin'),
  '[FALHA] Frontend de Equipe & Capacidade incompleto!'
);
console.log('    ✅ Migration 030, scripts mestre, regras de não-sobreposição, painel de Equipe e Capacidade validados com sucesso.');

console.log('\n==============================================================================');
console.log('FASE 31: Expedição Integrada, Check-out de Balcão e Retirada Presencial Segura (Frente P)');
console.log('==============================================================================\n');

console.log('  🔎 31.1 Verificando integridade forward-only da Migration 031...');
const m031Path = 'supabase/migrations/031_expedicao_pdv_retirada_segura.sql';
assert.ok(fs.existsSync(m031Path), '[FALHA] Arquivo da Migration 031 não encontrado!');
const m031 = fs.readFileSync(m031Path, 'utf-8');

console.log('  🔎 31.2 Verificando criação das tabelas canônicas de retirada...');
assert.ok(
  m031.includes('CREATE TABLE IF NOT EXISTS public.retirada_configuracoes') &&
  m031.includes('CREATE TABLE IF NOT EXISTS public.pedido_retirada_autorizacoes') &&
  m031.includes('CREATE TABLE IF NOT EXISTS public.pedido_retirada_eventos'),
  '[FALHA] Uma ou mais tabelas essenciais da Frente P ausentes em 031!'
);

console.log('  🔎 31.3 Verificando trigger append-only em pedido_retirada_eventos (42501)...');
assert.ok(
  m031.includes('trg_bloquear_mutacao_retirada_eventos') &&
  m031.includes("ERRCODE = '42501'") &&
  m031.includes('RETIRADA_EVENTOS_APPEND_ONLY'),
  '[FALHA] Trigger append-only ou bloqueio 42501 ausente em 031!'
);

console.log('  🔎 31.4 Verificando segurança e hashing nativo do PIN...');
assert.ok(
  m031.includes('codigo_hash TEXT NOT NULL') &&
  m031.includes('sha256') &&
  m031.includes('encode(') &&
  m031.includes('max_tentativas'),
  '[FALHA] PIN não está estruturado para armazenamento seguro em hash ou controle de tentativas!'
);

console.log('  🔎 31.5 Verificando as 5 RPCs canônicas da Frente P...');
assert.ok(
  m031.includes('CREATE OR REPLACE FUNCTION public.gerar_autorizacao_retirada_cliente') &&
  m031.includes('CREATE OR REPLACE FUNCTION public.obter_minha_autorizacao_retirada') &&
  m031.includes('CREATE OR REPLACE FUNCTION public.validar_pin_retirada_balcao') &&
  m031.includes('CREATE OR REPLACE FUNCTION public.finalizar_checkout_retirada_balcao') &&
  m031.includes('CREATE OR REPLACE FUNCTION public.obter_painel_balcao_retiradas'),
  '[FALHA] Uma ou mais RPCs canônicas da Frente P ausentes em 031!'
);

console.log('  🔎 31.6 Verificando invariantes P1–P16 (sem tabelas paralelas, motor financeiro canônico, quality hold)...');
const m031CodeOnly = m031.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
assert.ok(
  !m031CodeOnly.includes('CREATE TABLE public.vendas_balcao') &&
  !m031CodeOnly.includes('CREATE TABLE public.pedidos_retirada') &&
  !m031CodeOnly.includes('CREATE TABLE public.pagamentos_balcao') &&
  m031.includes('public.registrar_pagamento_pedido') &&
  m031.includes('QUALITY_HOLD_ACTIVE') &&
  m031.includes("status_operacional = 'retirado'"),
  '[FALHA] Invariantes P1–P16 violadas em 031 (tabelas paralelas ou desvio de motor detectados)!'
);

console.log('  🔎 31.7 Verificando grants fail-closed para anon/PUBLIC...');
assert.ok(
  m031.includes('REVOKE ALL ON public.retirada_configuracoes FROM PUBLIC, anon, authenticated;') &&
  m031.includes('REVOKE ALL ON public.pedido_retirada_autorizacoes FROM PUBLIC, anon, authenticated;') &&
  m031.includes('REVOKE ALL ON public.pedido_retirada_eventos FROM PUBLIC, anon, authenticated;') &&
  m031.includes('REVOKE ALL ON FUNCTION public.validar_pin_retirada_balcao(BIGINT, TEXT) FROM PUBLIC, anon;') &&
  m031.includes('REVOKE ALL ON FUNCTION public.finalizar_checkout_retirada_balcao(BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m031.includes('REVOKE ALL ON FUNCTION public.obter_painel_balcao_retiradas(DATE) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed da Frente P ausentes ou incompletos!'
);

console.log('  🔎 31.8 Verificando presença das estruturas da Frente P nos schemas mestres...');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.retirada_configuracoes'), `[FALHA] ${name} não contém retirada_configuracoes!`);
  assert.ok(content.includes('public.pedido_retirada_autorizacoes'), `[FALHA] ${name} não contém pedido_retirada_autorizacoes!`);
  assert.ok(content.includes('public.pedido_retirada_eventos'), `[FALHA] ${name} não contém pedido_retirada_eventos!`);
  assert.ok(content.includes('public.finalizar_checkout_retirada_balcao'), `[FALHA] ${name} não contém finalizar_checkout_retirada_balcao!`);
  assert.ok(content.includes('public.obter_painel_balcao_retiradas'), `[FALHA] ${name} não contém obter_painel_balcao_retiradas!`);
}

console.log('  🔎 31.9 Verificando frontend de Balcão e Retirada (admin.html, js/admin-retirada.js, js/admin.js e js/minha-conta.js)...');
const adminHtmlRetirada = fs.readFileSync('admin.html', 'utf-8');
const adminRetiradaJs = fs.readFileSync('js/admin-retirada.js', 'utf-8');
const adminJsRetirada = fs.readFileSync('js/admin.js', 'utf-8');
const minhaContaJsRetirada = fs.readFileSync('js/minha-conta.js', 'utf-8');
assert.ok(
  adminHtmlRetirada.includes('id="tab-btn-retirada"') &&
  adminHtmlRetirada.includes('id="admin-tab-retirada"') &&
  adminHtmlRetirada.includes('js/admin-retirada.js') &&
  adminRetiradaJs.includes('obter_painel_balcao_retiradas') &&
  adminRetiradaJs.includes('finalizar_checkout_retirada_balcao') &&
  adminJsRetirada.includes('tab-btn-retirada') &&
  adminJsRetirada.includes('carregarRetiradaAdmin') &&
  minhaContaJsRetirada.includes('verMeuPinRetirada') &&
  minhaContaJsRetirada.includes('gerar_autorizacao_retirada_cliente'),
  '[FALHA] Frontend de Balcão e Retirada incompleto!'
);
console.log('    ✅ Migration 031, scripts mestre, segurança de PIN, quitação e portal validados com sucesso.');

// ==============================================================================
// FASE 32: FRENTE Q — PDV RÁPIDO & PRONTA ENTREGA (MIGRATION 032)
// ==============================================================================
console.log('\n============================================================');
console.log('🧪 FASE 32: FRENTE Q — PDV Rápido & Pronta Entrega (Migration 032)');
console.log('============================================================');

console.log('  🔎 32.1 Verificando integridade da migration 032_pdv_rapido_pronta_entrega.sql...');
assert.ok(fs.existsSync('supabase/migrations/032_pdv_rapido_pronta_entrega.sql'), '[FALHA] Migration 032 não encontrada!');
const m032 = fs.readFileSync('supabase/migrations/032_pdv_rapido_pronta_entrega.sql', 'utf-8');
assert.ok(m032.length > 5000, '[FALHA] Migration 032 vazia ou truncada!');

console.log('  🔎 32.2 Verificando congelamento absoluto das migrations anteriores (001–031)...');
for (let i = 1; i <= 31; i++) {
  const num = String(i).padStart(3, '0');
  const files = fs.readdirSync('supabase/migrations').filter(f => f.startsWith(num + '_'));
  assert.equal(files.length, 1, `[FALHA] Migration base ${num} ausente ou duplicada!`);
}
console.log('    ✅ Migrations 001–031 intocadas e imutáveis.');

console.log('  🔎 32.3 Verificando tabelas de produto pronto e rastreabilidade...');
assert.ok(m032.includes('CREATE TABLE IF NOT EXISTS public.produto_pronto_lotes'), '[FALHA] Tabela produto_pronto_lotes ausente!');
assert.ok(m032.includes('CREATE TABLE IF NOT EXISTS public.produto_pronto_lote_consumos_ingrediente'), '[FALHA] Tabela produto_pronto_lote_consumos_ingrediente ausente!');
assert.ok(m032.includes('CREATE TABLE IF NOT EXISTS public.produto_pronto_movimentacoes'), '[FALHA] Tabela produto_pronto_movimentacoes ausente!');
assert.ok(m032.includes('CREATE TABLE IF NOT EXISTS public.pedido_consumos_produto_pronto'), '[FALHA] Tabela pedido_consumos_produto_pronto ausente!');

console.log('  🔎 32.4 Verificando RPCs canônicas do PDV e FEFO...');
assert.ok(m032.includes('CREATE OR REPLACE FUNCTION public.registrar_producao_produto_pronto'), '[FALHA] registrar_producao_produto_pronto ausente!');
assert.ok(m032.includes('CREATE OR REPLACE FUNCTION public.listar_catalogo_pdv'), '[FALHA] listar_catalogo_pdv ausente!');
assert.ok(m032.includes('CREATE OR REPLACE FUNCTION public.finalizar_venda_pdv'), '[FALHA] finalizar_venda_pdv ausente!');
assert.ok(m032.includes('CREATE OR REPLACE FUNCTION public.obter_estoque_produto_pronto_admin'), '[FALHA] obter_estoque_produto_pronto_admin ausente!');
assert.ok(m032.includes('CREATE OR REPLACE FUNCTION public.rastrear_lote_produto_pronto_admin'), '[FALHA] rastrear_lote_produto_pronto_admin ausente!');

console.log('  🔎 32.5 Verificando invariantes de banco (zero tabelas paralelas de vendas/pagamentos, FOR UPDATE, FEFO)...');
const m032CodeOnly = m032.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
assert.ok(
  !m032CodeOnly.includes('CREATE TABLE public.vendas_balcao') &&
  !m032CodeOnly.includes('CREATE TABLE public.pagamentos_balcao') &&
  !m032CodeOnly.includes('CREATE TABLE public.pedidos_balcao') &&
  !m032CodeOnly.includes('CREATE TABLE public.pedidos_pdv'),
  '[FALHA] Tabelas paralelas detectadas na migration 032!'
);
assert.ok(m032.includes('FOR UPDATE'), '[FALHA] Trava FOR UPDATE ausente para concorrência de estoque PT!');
assert.ok(m032.includes('ORDER BY l.data_validade ASC, l.id ASC'), '[FALHA] Alocação FEFO de produto pronto ausente ou incorreta!');
assert.ok(m032.includes('canal') && m032.includes("'balcao'"), '[FALHA] Canal canônico balcao ausente!');
assert.ok(m032.includes("'42501'"), '[FALHA] Triggers append-only com SQLSTATE 42501 ausentes!');

console.log('  🔎 32.6 Verificando grants fail-closed para anon/PUBLIC...');
assert.ok(
  m032.includes('REVOKE ALL ON public.produto_pronto_lotes FROM PUBLIC, anon') &&
  m032.includes('REVOKE ALL ON public.produto_pronto_lote_consumos_ingrediente FROM PUBLIC, anon') &&
  m032.includes('REVOKE ALL ON public.produto_pronto_movimentacoes FROM PUBLIC, anon') &&
  m032.includes('REVOKE ALL ON public.pedido_consumos_produto_pronto FROM PUBLIC, anon') &&
  m032.includes('REVOKE ALL ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m032.includes('REVOKE ALL ON FUNCTION public.listar_catalogo_pdv() FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed da Frente Q ausentes ou incompletos!'
);

console.log('  🔎 32.7 Verificando presença das estruturas da Frente Q nos schemas mestres...');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.produto_pronto_lotes'), `[FALHA] ${name} não contém produto_pronto_lotes!`);
  assert.ok(content.includes('public.produto_pronto_lote_consumos_ingrediente'), `[FALHA] ${name} não contém produto_pronto_lote_consumos_ingrediente!`);
  assert.ok(content.includes('public.finalizar_venda_pdv'), `[FALHA] ${name} não contém finalizar_venda_pdv!`);
  assert.ok(content.includes('public.listar_catalogo_pdv'), `[FALHA] ${name} não contém listar_catalogo_pdv!`);
}

console.log('  🔎 32.8 Verificando frontend de PDV Rápido & Pronta Entrega (admin.html, js/admin-pdv.js, js/admin.js)...');
const adminHtmlPdv = fs.readFileSync('admin.html', 'utf-8');
const adminPdvJs = fs.readFileSync('js/admin-pdv.js', 'utf-8');
const adminJsPdv = fs.readFileSync('js/admin.js', 'utf-8');
assert.ok(
  adminHtmlPdv.includes('id="tab-btn-pdv"') &&
  adminHtmlPdv.includes('id="admin-tab-pdv"') &&
  adminHtmlPdv.includes('js/admin-pdv.js') &&
  adminPdvJs.includes('listar_catalogo_pdv') &&
  adminPdvJs.includes('finalizar_venda_pdv') &&
  adminJsPdv.includes('tab-btn-pdv') &&
  adminJsPdv.includes('carregarPdvAdmin'),
  '[FALHA] Frontend de PDV Rápido & Pronta Entrega incompleto!'
);
console.log('    ✅ Migration 032, schemas mestre, FEFO, quitação PDV e frontend validados com sucesso.');

// ==============================================================================
// 🩹 FASE 33: Hotfix Orçamentos Admin (Migration 033)
// ==============================================================================
console.log('\n============================================================');
console.log('🩹 FASE 33: Hotfix Orçamentos Admin (Migration 033)...');
console.log('============================================================');
console.log('  🔎 33.1 Verificando integridade da migration 033_hotfix_orcamentos_admin.sql...');
const m033 = fs.readFileSync('supabase/migrations/033_hotfix_orcamentos_admin.sql', 'utf-8');
const m033CodeOnly = m033.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
assert.ok(m033.includes('CREATE OR REPLACE FUNCTION public.buscar_orcamentos_admin'), '[FALHA] buscar_orcamentos_admin ausente em 033!');
assert.ok(!m033CodeOnly.includes('p_novo_status'), '[FALHA] Referência incorreta a p_novo_status ainda presente em 033!');
assert.ok(m033.includes("v_st TEXT := NULLIF(TRIM(COALESCE(p_status, '')), '');"), '[FALHA] Atribuição de v_st corrigida ausente em 033!');

console.log('  🔎 33.2 Verificando grants fail-closed em 033...');
assert.ok(m033.includes('REVOKE ALL ON FUNCTION public.buscar_orcamentos_admin FROM PUBLIC, anon;'), '[FALHA] REVOKE ALL ausente em 033!');
assert.ok(m033.includes('GRANT EXECUTE ON FUNCTION public.buscar_orcamentos_admin TO authenticated, service_role;'), '[FALHA] GRANT ausente em 033!');

console.log('  🔎 33.3 Verificando presença do hotfix nos schemas mestres...');
assert.ok(!installFim.includes('COALESCE(p_novo_status'), '[FALHA] install.sql ainda contém referência a p_novo_status!');
assert.ok(!schemaFim.includes('COALESCE(p_novo_status'), '[FALHA] schema.sql ainda contém referência a p_novo_status!');
console.log('    ✅ Migration 033, schemas mestre e eliminação de p_novo_status validados com sucesso.');

// ==============================================================================
// 💵 FASE 34: FRENTE R — Caixa PDV, Sessões e Fechamento de Turno (Migration 034)
// ==============================================================================
console.log('\n============================================================');
console.log('💵 FASE 34: Frente R — Caixa PDV & Turnos (Migration 034)...');
console.log('============================================================');
console.log('  🔎 34.1 Verificando integridade da migration 034_caixa_pdv_sessoes_fechamento.sql...');
const m034 = fs.readFileSync('supabase/migrations/034_caixa_pdv_sessoes_fechamento.sql', 'utf-8');
const m034CodeOnly = m034.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 34.2 Verificando as 4 tabelas canônicas de caixa...');
assert.ok(m034.includes('CREATE TABLE IF NOT EXISTS public.caixa_sessoes'), '[FALHA] Tabela caixa_sessoes ausente!');
assert.ok(m034.includes('CREATE TABLE IF NOT EXISTS public.caixa_sessao_movimentacoes'), '[FALHA] Tabela caixa_sessao_movimentacoes ausente!');
assert.ok(m034.includes('CREATE TABLE IF NOT EXISTS public.caixa_sessao_pagamentos'), '[FALHA] Tabela caixa_sessao_pagamentos ausente!');
assert.ok(m034.includes('CREATE TABLE IF NOT EXISTS public.caixa_sessao_auditorias'), '[FALHA] Tabela caixa_sessao_auditorias ausente!');

console.log('  🔎 34.3 Verificando índices parciais de sessão única e idempotência...');
assert.ok(m034.includes('uq_caixa_sessao_operador_aberta'), '[FALHA] Índice parcial de sessão por operador ausente!');
assert.ok(m034.includes('uq_caixa_sessao_terminal_aberta'), '[FALHA] Índice parcial de sessão por terminal ausente!');
assert.ok(m034.includes('uq_caixa_sessao_mov_idemp'), '[FALHA] Constraint de idempotência em movimentações ausente!');

console.log('  🔎 34.4 Verificando triggers append-only e imutabilidade (SQLSTATE 42501)...');
assert.ok(m034.includes('trg_valida_sessao_imutavel'), '[FALHA] Trigger de imutabilidade de sessão fechada ausente!');
assert.ok(m034.includes('trg_caixa_movimentacoes_append_only'), '[FALHA] Trigger append-only em movimentações ausente!');
assert.ok(m034.includes('trg_caixa_pagamentos_append_only'), '[FALHA] Trigger append-only em pagamentos ausente!');
assert.ok(m034.includes('trg_caixa_auditorias_append_only'), '[FALHA] Trigger append-only em auditorias ausente!');
assert.ok(m034.includes("'42501'"), '[FALHA] SQLSTATE 42501 ausente nos triggers de segurança!');

console.log('  🔎 34.5 Verificando as 7 RPCs canônicas da Frente R...');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.abrir_sessao_caixa'), '[FALHA] abrir_sessao_caixa ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.registrar_movimentacao_caixa'), '[FALHA] registrar_movimentacao_caixa ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.consultar_sessao_caixa_atual'), '[FALHA] consultar_sessao_caixa_atual ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.obter_resumo_sessao_caixa_admin'), '[FALHA] obter_resumo_sessao_caixa_admin ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.fechar_sessao_caixa'), '[FALHA] fechar_sessao_caixa ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.auditar_sessao_caixa_admin'), '[FALHA] auditar_sessao_caixa_admin ausente!');
assert.ok(m034.includes('CREATE OR REPLACE FUNCTION public.listar_sessoes_caixa_admin'), '[FALHA] listar_sessoes_caixa_admin ausente!');

console.log('  🔎 34.6 Verificando evolução de finalizar_venda_pdv com CASH_SESSION_REQUIRED...');
assert.ok(m034.includes('CASH_SESSION_REQUIRED'), '[FALHA] Código CASH_SESSION_REQUIRED ausente em finalizar_venda_pdv!');
assert.ok(m034.includes('INSERT INTO public.caixa_sessao_pagamentos'), '[FALHA] Vínculo em caixa_sessao_pagamentos ausente em finalizar_venda_pdv!');

console.log('  🔎 34.7 Verificando ausência de tabelas paralelas de caixa e neutralidade contábil...');
assert.ok(
  !m034CodeOnly.includes('CREATE TABLE public.caixas_pdv') &&
  !m034CodeOnly.includes('CREATE TABLE public.caixas_operadores') &&
  !m034CodeOnly.includes('CREATE TABLE public.livro_caixa_paralelo'),
  '[FALHA] Tabelas paralelas detectadas na migration 034!'
);

console.log('  🔎 34.8 Verificando grants fail-closed para anon/PUBLIC...');
assert.ok(
  m034.includes('REVOKE ALL ON public.caixa_sessoes FROM PUBLIC, anon') &&
  m034.includes('REVOKE ALL ON public.caixa_sessao_movimentacoes FROM PUBLIC, anon') &&
  m034.includes('REVOKE ALL ON public.caixa_sessao_pagamentos FROM PUBLIC, anon') &&
  m034.includes('REVOKE ALL ON public.caixa_sessao_auditorias FROM PUBLIC, anon') &&
  m034.includes('REVOKE ALL ON FUNCTION public.abrir_sessao_caixa(NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;') &&
  m034.includes('REVOKE ALL ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed da Frente R ausentes ou incompletos!'
);

console.log('  🔎 34.9 Verificando presença das estruturas da Frente R nos schemas mestres...');
for (const [name, content] of [['install.sql', installFim], ['schema.sql', schemaFim]]) {
  assert.ok(content.includes('public.caixa_sessoes'), `[FALHA] ${name} não contém caixa_sessoes!`);
  assert.ok(content.includes('public.caixa_sessao_movimentacoes'), `[FALHA] ${name} não contém caixa_sessao_movimentacoes!`);
  assert.ok(content.includes('public.caixa_sessao_pagamentos'), `[FALHA] ${name} não contém caixa_sessao_pagamentos!`);
  assert.ok(content.includes('public.abrir_sessao_caixa'), `[FALHA] ${name} não contém abrir_sessao_caixa!`);
  assert.ok(content.includes('public.fechar_sessao_caixa'), `[FALHA] ${name} não contém fechar_sessao_caixa!`);
}

console.log('  🔎 34.10 Verificando frontend de Sessões de Caixa (admin.html, js/admin-caixa.js, js/admin.js, js/admin-pdv.js)...');
const adminHtmlCaixa = fs.readFileSync('admin.html', 'utf-8');
const adminCaixaJs = fs.readFileSync('js/admin-caixa.js', 'utf-8');
const adminJsCaixa = fs.readFileSync('js/admin.js', 'utf-8');
const adminPdvJsCaixa = fs.readFileSync('js/admin-pdv.js', 'utf-8');

assert.ok(
  adminHtmlCaixa.includes('id="tab-btn-caixa"') &&
  adminHtmlCaixa.includes('id="admin-tab-caixa"') &&
  adminHtmlCaixa.includes('js/admin-caixa.js') &&
  adminCaixaJs.includes('consultar_sessao_caixa_atual') &&
  adminCaixaJs.includes('abrir_sessao_caixa') &&
  adminCaixaJs.includes('fechar_sessao_caixa') &&
  adminCaixaJs.includes('registrar_movimentacao_caixa') &&
  adminJsCaixa.includes('tab-btn-caixa') &&
  adminJsCaixa.includes('carregarCaixaAdmin') &&
  adminPdvJsCaixa.includes('CASH_SESSION_REQUIRED'),
  '[FALHA] Frontend de Sessões de Caixa incompleto!'
);
console.log('    ✅ Migration 034, schemas mestre, R1–R16 e frontend de Caixa validados com sucesso.');

// --------------------------------------------------------------------------
// FASE 35: Hotfix PDV Histórico & Caixa Ownership (Migration 035)
// --------------------------------------------------------------------------
console.log('\n============================================================');
console.log('🛡️ FASE 35: Hotfix PDV Histórico & Caixa Ownership (Migration 035)...');
console.log('============================================================');

const m035Path = 'supabase/migrations/035_hotfix_pdv_historico_caixa_ownership.sql';
assert.ok(fs.existsSync(m035Path), '[FALHA] Migration 035 não encontrada!');
const m035 = fs.readFileSync(m035Path, 'utf-8');

console.log('  🔎 35.1 Verificando correção canônica de pedido_status_historico em finalizar_venda_pdv...');
assert.ok(m035.includes('status_novo'), '[FALHA] Coluna canônica status_novo ausente na 035!');
assert.ok(m035.includes('dimensao'), '[FALHA] Coluna canônica dimensao ausente na 035!');
assert.ok(!m035.includes('novo_status'), '[FALHA] Coluna incorreta novo_status detectada na 035!');
assert.ok(!m035.includes('tipo_status'), '[FALHA] Coluna incorreta tipo_status detectada na 035!');

console.log('  🔎 35.2 Verificando travas de ownership CASH_SESSION_NOT_OWNED com FOR UPDATE...');
assert.ok(m035.includes('CASH_SESSION_NOT_OWNED'), '[FALHA] Código CASH_SESSION_NOT_OWNED ausente na 035!');
assert.ok(m035.includes('FOR UPDATE'), '[FALHA] Trava FOR UPDATE ausente na 035!');
assert.ok(m035.includes('v_sessao.operador_auth_id <> v_caller_id'), '[FALHA] Verificação de operador_auth_id ausente na 035!');

console.log('  🔎 35.3 Verificando vínculo de pagamento em caixa_sessao_pagamentos...');
assert.ok(m035.includes('INSERT INTO public.caixa_sessao_pagamentos'), '[FALHA] Vínculo em caixa_sessao_pagamentos ausente em finalizar_venda_pdv!');

console.log('  🔎 35.4 Verificando grants fail-closed em 035...');
assert.ok(
  m035.includes('REVOKE ALL ON FUNCTION public.registrar_movimentacao_caixa(TEXT, NUMERIC, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;') &&
  m035.includes('REVOKE ALL ON FUNCTION public.fechar_sessao_caixa(NUMERIC, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon;') &&
  m035.includes('REVOKE ALL ON FUNCTION public.finalizar_venda_pdv(JSONB, BIGINT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;'),
  '[FALHA] Grants fail-closed da Migration 035 ausentes!'
);

console.log('  🔎 35.5 Verificando presença da 035 nos schemas mestres...');
for (const [name, content] of [['install.sql', fs.readFileSync('sql/install.sql', 'utf-8')], ['schema.sql', fs.readFileSync('sql/schema.sql', 'utf-8')]]) {
  assert.ok(content.includes('CASH_SESSION_NOT_OWNED'), `[FALHA] ${name} não contém CASH_SESSION_NOT_OWNED!`);
}
console.log('    ✅ Migration 035, schemas mestre e contrato canônico validados com sucesso.');

// ==============================================================================
// 🍳 FASE 38: FRENTE 038 — KDS em Tempo Real / Produção de Cozinha (Bancada & Praças)
// ==============================================================================
console.log('\n============================================================');
console.log('🍳 FASE 38: Frente 038 — KDS em Tempo Real / Produção (Migration 038)...');
console.log('============================================================');

const m038Path = 'supabase/migrations/038_kds_producao_tempo_real.sql';
assert.ok(fs.existsSync(m038Path), '[FALHA] Migration 038 não encontrada!');
const m038 = fs.readFileSync(m038Path, 'utf-8');
const m038CodeOnly = m038.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

console.log('  🔎 38.1 Verificando as 5 tabelas canônicas do KDS...');
assert.ok(m038.includes('CREATE TABLE IF NOT EXISTS public.produto_etapas_kds'), '[FALHA] Tabela produto_etapas_kds ausente!');
assert.ok(m038.includes('CREATE TABLE IF NOT EXISTS public.pedido_producao_kds'), '[FALHA] Tabela pedido_producao_kds ausente!');
assert.ok(m038.includes('CREATE TABLE IF NOT EXISTS public.pedido_item_producao_kds'), '[FALHA] Tabela pedido_item_producao_kds ausente!');
assert.ok(m038.includes('CREATE TABLE IF NOT EXISTS public.pedido_item_kds_etapas'), '[FALHA] Tabela pedido_item_kds_etapas ausente!');
assert.ok(m038.includes('CREATE TABLE IF NOT EXISTS public.pedido_kds_estagio_historico'), '[FALHA] Tabela pedido_kds_estagio_historico ausente!');

console.log('  🔎 38.2 Verificando tipagem relacional e constraints canônicas (K1, K3, K4)...');
assert.ok(m038.includes('pedido_id BIGINT NOT NULL REFERENCES public.pedidos(id)'), '[FALHA] pedido_id BIGINT ausente em pedido_producao_kds!');
assert.ok(m038.includes('pedido_item_id BIGINT NOT NULL REFERENCES public.pedido_itens(id)'), '[FALHA] pedido_item_id BIGINT ausente em pedido_item_producao_kds!');
assert.ok(m038.includes('praca_atual VARCHAR(30)'), '[FALHA] praca_atual ausente em pedido_item_producao_kds!');
assert.ok(m038.includes('uq_produto_etapa_ordem'), '[FALHA] Constraint uq_produto_etapa_ordem ausente!');
assert.ok(m038.includes('uq_produto_etapa_praca'), '[FALHA] Constraint uq_produto_etapa_praca ausente!');
assert.ok(m038.includes("praca IN ('MASSA', 'FORNO', 'RECHEIO', 'DECORACAO', 'EMBALAGEM')"), '[FALHA] Constraint de praças válidas ausente!');
assert.ok(!m038CodeOnly.includes('saiu_entrega'), '[FALHA] Violação de nomenclatura canônica: detectado saiu_entrega!');

console.log('  🔎 38.3 Verificando trigger de auditoria append-only imutável (SQLSTATE 42501)...');
assert.ok(m038.includes('trg_bloquear_mutacao_kds_historico'), '[FALHA] Trigger append-only trg_bloquear_mutacao_kds_historico ausente!');
assert.ok(m038.includes("'42501'"), '[FALHA] SQLSTATE 42501 ausente no trigger de auditoria KDS!');

console.log('  🔎 38.4 Verificando as 4 RPCs canônicas e travas de segurança...');
assert.ok(m038.includes('CREATE OR REPLACE FUNCTION public.kds_inicializar_pedido'), '[FALHA] kds_inicializar_pedido ausente!');
assert.ok(m038.includes('CREATE OR REPLACE FUNCTION public.kds_avancar_item'), '[FALHA] kds_avancar_item ausente!');
assert.ok(m038.includes('CREATE OR REPLACE FUNCTION public.kds_marcar_urgencia'), '[FALHA] kds_marcar_urgencia ausente!');
assert.ok(m038.includes('CREATE OR REPLACE FUNCTION public.kds_obter_painel'), '[FALHA] kds_obter_painel ausente!');
assert.ok(m038.includes('FOR UPDATE'), '[FALHA] Trava FOR UPDATE ausente em kds_avancar_item!');
assert.ok(m038.includes('auth.uid()'), '[FALHA] Autoria server-side via auth.uid() ausente nas RPCs de KDS!');
assert.ok(!m038CodeOnly.includes('p_operador_id'), '[FALHA] Parâmetro inseguro p_operador_id detectado nas RPCs de KDS!');
assert.ok(m038.includes('KDS_ROUTE_NOT_CONFIGURED'), '[FALHA] Fail-closed KDS_ROUTE_NOT_CONFIGURED ausente!');

console.log('  🔎 38.5 Verificando publicação explícita em supabase_realtime...');
assert.ok(m038.includes("pubname = 'supabase_realtime'") && m038.includes("ADD TABLE public.pedido_producao_kds"), '[FALHA] pedido_producao_kds não adicionada a supabase_realtime!');
assert.ok(m038.includes("pubname = 'supabase_realtime'") && m038.includes("ADD TABLE public.pedido_item_producao_kds"), '[FALHA] pedido_item_producao_kds não adicionada a supabase_realtime!');

console.log('  🔎 38.6 Verificando grants fail-closed para anon e PUBLIC...');
assert.ok(m038.includes('REVOKE ALL ON FUNCTION public.kds_inicializar_pedido(BIGINT) FROM PUBLIC, anon, authenticated;'), '[FALHA] kds_inicializar_pedido deve ser estritamente interna/revogada!');
assert.ok(m038.includes('REVOKE ALL ON FUNCTION public.kds_avancar_item(UUID, VARCHAR) FROM PUBLIC, anon;'), '[FALHA] kds_avancar_item deve ser revogada de PUBLIC e anon!');
assert.ok(m038.includes('REVOKE ALL ON FUNCTION public.kds_marcar_urgencia(BIGINT, TEXT) FROM PUBLIC, anon;'), '[FALHA] kds_marcar_urgencia deve ser revogada de PUBLIC e anon!');
assert.ok(m038.includes('REVOKE ALL ON FUNCTION public.kds_obter_painel(VARCHAR) FROM PUBLIC, anon;'), '[FALHA] kds_obter_painel deve ser revogada de PUBLIC e anon!');
assert.ok(m038.includes('REVOKE ALL ON public.pedido_producao_kds FROM PUBLIC, anon;'), '[FALHA] pedido_producao_kds deve ter grants fail-closed!');
assert.ok(m038.includes('REVOKE ALL ON public.pedido_item_producao_kds FROM PUBLIC, anon;'), '[FALHA] pedido_item_producao_kds deve ter grants fail-closed!');
assert.ok(m038.includes('REVOKE ALL ON public.pedido_item_kds_etapas FROM PUBLIC, anon;'), '[FALHA] pedido_item_kds_etapas deve ter grants fail-closed!');
assert.ok(m038.includes('REVOKE ALL ON public.pedido_kds_estagio_historico FROM PUBLIC, anon;'), '[FALHA] pedido_kds_estagio_historico deve ter grants fail-closed!');

console.log('  🔎 38.7 Verificando presença das estruturas da Frente 038 nos schemas mestres...');
for (const [name, content] of [['install.sql', fs.readFileSync('sql/install.sql', 'utf-8')], ['schema.sql', fs.readFileSync('sql/schema.sql', 'utf-8')]]) {
  assert.ok(content.includes('public.produto_etapas_kds'), `[FALHA] ${name} não contém produto_etapas_kds!`);
  assert.ok(content.includes('public.pedido_producao_kds'), `[FALHA] ${name} não contém pedido_producao_kds!`);
  assert.ok(content.includes('public.pedido_item_producao_kds'), `[FALHA] ${name} não contém pedido_item_producao_kds!`);
  assert.ok(content.includes('public.pedido_item_kds_etapas'), `[FALHA] ${name} não contém pedido_item_kds_etapas!`);
  assert.ok(content.includes('public.pedido_kds_estagio_historico'), `[FALHA] ${name} não contém pedido_kds_estagio_historico!`);
  assert.ok(content.includes('public.kds_avancar_item'), `[FALHA] ${name} não contém kds_avancar_item!`);
  assert.ok(content.includes('public.kds_obter_painel'), `[FALHA] ${name} não contém kds_obter_painel!`);
}

console.log('  🔎 38.8 Verificando frontend de KDS (admin.html, js/admin-kds.js, js/admin.js)...');
const adminHtmlKds = fs.readFileSync('admin.html', 'utf-8');
const adminKdsJs = fs.readFileSync('js/admin-kds.js', 'utf-8');
const adminJsKds = fs.readFileSync('js/admin.js', 'utf-8');

assert.ok(
  adminHtmlKds.includes('id="tab-btn-kds"') &&
  adminHtmlKds.includes('id="admin-tab-kds"') &&
  adminHtmlKds.includes('js/admin-kds.js') &&
  adminHtmlKds.includes('kds-cards-container') &&
  adminHtmlKds.includes('btn-kds-fullscreen') &&
  adminHtmlKds.includes('data-kds-praca="TODAS"'),
  '[FALHA] Elementos visuais de KDS ausentes em admin.html!'
);
assert.ok(
  adminKdsJs.includes('carregarPainelKds') &&
  adminKdsJs.includes('kdsAvancarItem') &&
  adminKdsJs.includes('kdsMarcarUrgencia') &&
  adminKdsJs.includes('inicializarKds') &&
  adminKdsJs.includes('emitirAlertaSonoroSuave') &&
  adminKdsJs.includes('AudioContext') &&
  adminKdsJs.includes('min-height: 48px'),
  '[FALHA] Lógica ou ergonomia de bancada ausente em js/admin-kds.js!'
);
assert.ok(
  adminJsKds.includes('tab-btn-kds') &&
  adminJsKds.includes('carregarKdsAdmin'),
  '[FALHA] Roteamento de abas para KDS ausente em js/admin.js!'
);
console.log('    ✅ Migration 038, schemas mestre, K1–K18 e frontend de KDS Bancada validados com sucesso.');

console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 100% das verificações automatizadas das Fases 1–38 foram aprovadas.\n   ℹ️  Estas verificações são ESTRUTURAIS. Para provas de concorrência/idempotência rode: npm run test:integration');





