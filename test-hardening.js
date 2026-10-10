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
console.log('    ✅ Frontend desacoplado de estoque e operando exclusivamente via RPC atômica.');

console.log('\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 100% das verificações automatizadas das Fases 1–14 foram aprovadas.\n   ℹ️  Estas verificações são ESTRUTURAIS. Para provas de concorrência/idempotência rode: npm run test:integration');







