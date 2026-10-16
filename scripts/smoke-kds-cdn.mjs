import assert from 'node:assert/strict';

async function check() {
  const ts = Date.now();
  console.log('📡 Executando smoke test CDN KDS em https://lunocadoceria.com.br/ ...');
  const [resAdmin, resKds] = await Promise.all([
    fetch(`https://lunocadoceria.com.br/admin.html?v=${ts}`),
    fetch(`https://lunocadoceria.com.br/js/admin-kds.js?v=${ts}`)
  ]);

  console.log(`- admin.html status: ${resAdmin.status}`);
  console.log(`- js/admin-kds.js status: ${resKds.status}`);

  const html = await resAdmin.text();
  const kdsJs = await resKds.text();

  const tabs = html.match(/id="tab-btn-[^"]+"/g) || [];
  console.log('- Tabs encontrados em admin.html:', tabs);

  const hasTabBtn = html.includes('id="tab-btn-kds"');
  const hasTabPane = html.includes('id="admin-tab-kds"');
  const hasScript = html.includes('js/admin-kds.js');
  const hasKdsInit = kdsJs.includes('carregarKdsAdmin');

  console.log(`- tab-btn-kds presente: ${hasTabBtn}`);
  console.log(`- admin-tab-kds presente: ${hasTabPane}`);
  console.log(`- script js/admin-kds.js importado: ${hasScript}`);
  console.log(`- carregarKdsAdmin presente no JS: ${hasKdsInit}`);

  if (hasTabBtn && hasTabPane && hasScript && hasKdsInit) {
    console.log('🎉 SMOKE TEST CDN KDS 100% VERDE EM PRODUÇÃO!');
    process.exit(0);
  } else {
    console.log('⏳ Build do Cloudflare Pages ainda propagando no CDN...');
    process.exit(2);
  }
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
