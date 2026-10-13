import fs from 'node:fs';
import assert from 'node:assert/strict';

console.log('🔍 Executando Smoke Test da Interface de Custos & Margens...');

const adminHtml = fs.readFileSync('admin.html', 'utf8');
const adminCustos = fs.readFileSync('js/admin-custos.js', 'utf8');
const adminJs = fs.readFileSync('js/admin.js', 'utf8');

assert.ok(adminHtml.includes('id="tab-btn-custos"'), 'Botão tab-btn-custos ausente em admin.html');
assert.ok(adminHtml.includes('id="admin-tab-custos"'), 'Container admin-tab-custos ausente em admin.html');
assert.ok(adminHtml.includes('js/admin-custos.js'), 'Inclusão de js/admin-custos.js ausente em admin.html');

assert.ok(adminCustos.includes('simular_preco_produto_admin'), 'RPC simular_preco_produto_admin ausente em admin-custos.js');
assert.ok(adminCustos.includes('calcular_custo_real_pedido_admin'), 'RPC calcular_custo_real_pedido_admin ausente em admin-custos.js');
assert.ok(adminCustos.includes('obter_margem_pedido_admin'), 'RPC obter_margem_pedido_admin ausente em admin-custos.js');
assert.ok(adminCustos.includes('obter_dashboard_margens_admin'), 'RPC obter_dashboard_margens_admin ausente em admin-custos.js');

assert.ok(adminJs.includes('tab-btn-custos'), 'tab-btn-custos ausente de abasRestritas em admin.js');
assert.ok(adminJs.includes('carregarCustosAdmin'), 'carregarCustosAdmin ausente de mudarTabAdmin em admin.js');

// Prova de bloqueio de operador:
const isOperadorCheck = adminCustos.includes("usuarioAtual.nivel === 'operador'");
assert.ok(isOperadorCheck, 'admin-custos.js deve bloquear operador com mensagem de acesso restrito');

console.log('✅ SMOKE TEST CUSTOS & MARGENS: 100% VERDE!');
