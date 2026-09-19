// ==========================================================================
// LUNOCA DOCERIA - Módulo de Checkout Transparente Mercado Pago
// 100% no próprio site (Sem redirecionamentos)
// ==========================================================================

const MP_STORAGE_KEY = 'lunoca_mercadopago_config';

function getMercadoPagoConfig() {
  if (window.MercadoPagoPlugin) {
    return window.MercadoPagoPlugin.getConfig();
  }
  try {
    const raw = localStorage.getItem(MP_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    publicKey: '',
    accessToken: '',
    chavePixFallback: 'lunocadoceria@gmail.com',
    modoTransparente: true
  };
}

function salvarMercadoPagoConfig(cfg) {
  if (window.MercadoPagoPlugin) {
    return window.MercadoPagoPlugin.saveConfig(cfg);
  }
  try {
    localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(cfg));
    return true;
  } catch (e) {
    return false;
  }
}

// Iniciar Checkout Transparente após finalizar o pedido
async function iniciarPagamentoMercadoPago(pedidoId, total, itens, forma) {
  const orderData = {
    pedidoId: pedidoId,
    total: total,
    items: itens,
    forma: forma,
    cliente: {
      nome: (window.usuarioAtual && window.usuarioAtual.nome) || 'Cliente Lunoca',
      email: (window.usuarioAtual && window.usuarioAtual.email) || 'cliente@lunocadoceria.com.br',
      cpf: (window.usuarioAtual && window.usuarioAtual.cpf) || '19119119100'
    }
  };

  if (window.MercadoPagoPlugin && typeof window.MercadoPagoPlugin.iniciarCheckoutTransparente === 'function') {
    await window.MercadoPagoPlugin.iniciarCheckoutTransparente(orderData);
  } else {
    console.error('MercadoPagoPlugin não carregado.');
    alert('Erro ao carregar módulo de pagamento transparente. Tente novamente.');
  }
}

function fecharModalMP() {
  if (window.MercadoPagoPlugin) {
    window.MercadoPagoPlugin.closeModal();
  } else {
    const modal = document.getElementById('modal-pagamento-mp');
    if (modal) modal.classList.remove('active');
    if (typeof mostrarTela === 'function') mostrarTela('menu-section');
  }
}

function copiarTexto(txt, msgSucesso) {
  navigator.clipboard.writeText(txt).then(() => {
    alert(msgSucesso || 'Copiado para a área de transferência!');
  }).catch(() => {
    prompt('Copie o texto abaixo:', txt);
  });
}
