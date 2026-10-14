const resHtml = await fetch('https://lunocadoceria.com.br/admin.html?v=' + Date.now());
const resJs = await fetch('https://lunocadoceria.com.br/js/admin-custos.js?v=' + Date.now());

console.log('admin.html status:', resHtml.status);
console.log('js/admin-custos.js status:', resJs.status);

const textHtml = await resHtml.text();
const textJs = await resJs.text();

console.log('admin.html contains admin-tab-custos:', textHtml.includes('id="admin-tab-custos"'));
console.log('admin-custos.js contains simular_preco:', textJs.includes('simular_preco_produto_admin'));
