// ==============================================================================
// LUNOCA DOCERIA - SMOKE TEST CANÔNICO FRENTE Q
// ==============================================================================
import assert from 'node:assert/strict';

const ts = Date.now();
console.log('📡 Executando smoke test HTTP no domínio canônico https://lunocadoceria.com.br/ ...');

const [resAdmin, resJsPdv, resHome] = await Promise.all([
  fetch(`https://lunocadoceria.com.br/admin.html?v=${ts}`),
  fetch(`https://lunocadoceria.com.br/js/admin-pdv.js?v=${ts}`),
  fetch(`https://lunocadoceria.com.br/index.html?v=${ts}`)
]);

console.log(`- admin.html status: ${resAdmin.status}`);
console.log(`- js/admin-pdv.js status: ${resJsPdv.status}`);
console.log(`- index.html status: ${resHome.status}`);

assert.equal(resAdmin.status, 200, 'admin.html deve responder 200 OK');
assert.equal(resJsPdv.status, 200, 'js/admin-pdv.js deve responder 200 OK');
assert.equal(resHome.status, 200, 'index.html deve responder 200 OK');

const htmlAdmin = await resAdmin.text();
const jsPdv = await resJsPdv.text();

assert.ok(htmlAdmin.includes('id="tab-btn-pdv"'), 'admin.html deve conter tab-btn-pdv');
assert.ok(htmlAdmin.includes('id="admin-tab-pdv"'), 'admin.html deve conter admin-tab-pdv');
assert.ok(htmlAdmin.includes('js/admin-pdv.js'), 'admin.html deve importar js/admin-pdv.js');

assert.ok(jsPdv.includes('finalizar_venda_pdv'), 'admin-pdv.js deve conter RPC finalizar_venda_pdv');
assert.ok(jsPdv.includes('listar_catalogo_pdv'), 'admin-pdv.js deve conter RPC listar_catalogo_pdv');

console.log('🎉 SMOKE TEST CANÔNICO APROVADO COM 100% DE SUCESSO!');
