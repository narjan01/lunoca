// ==========================================================================
// LUNOCA DOCERIA - Lazy Loader para Módulos Administrativos (Fase 6)
// ==========================================================================
// Permite que visitantes da loja naveguem sem baixar scripts de gestão interna,
// carregando 'admin.js', 'estoque.js', 'financeiro.js' e 'fichatecnica.js'
// exclusivamente sob demanda para administradores e operadores.
// ==========================================================================

let adminScriptsCarregados = false;
let adminScriptsCarregandoPromise = null;

function carregarScriptDinamico(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src*="${src}"]`)) {
      return resolve();
    }
    const script = document.createElement('script');
    script.src = src + '?v=3.0.0';
    script.async = false;
    script.onload = () => resolve();
    script.onerror = (e) => reject(new Error(`Falha ao carregar módulo administrativo: ${src}`));
    document.body.appendChild(script);
  });
}

/**
 * Garante que todos os módulos do painel administrativo estejam carregados
 */
async function garantirModulosAdmin() {
  if (adminScriptsCarregados) return true;
  if (adminScriptsCarregandoPromise) return adminScriptsCarregandoPromise;

  adminScriptsCarregandoPromise = (async () => {
    try {
      const scripts = [
        'js/estoque.js',
        'js/fichatecnica.js',
        'js/financeiro.js',
        'js/admin.js'
      ];

      for (let i = 0; i < scripts.length; i++) {
        await carregarScriptDinamico(scripts[i]);
      }

      adminScriptsCarregados = true;
      return true;
    } catch (err) {
      console.error('[Admin Loader] Erro ao carregar módulos sob demanda:', err);
      if (typeof mostrarToast === 'function') {
        mostrarToast('Erro ao carregar módulos do painel: ' + err.message, 'erro');
      }
      throw err;
    } finally {
      adminScriptsCarregandoPromise = null;
    }
  })();

  return adminScriptsCarregandoPromise;
}

window.garantirModulosAdmin = garantirModulosAdmin;
