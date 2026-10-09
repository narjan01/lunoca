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
async function iniciarPagamentoMercadoPago(pedidoId, total, itens, forma, clienteCustom, checkoutToken, expiresAt) {
  const token = checkoutToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('lunoca_checkout_token_' + pedidoId) : null) || null;
  const orderData = {
    pedidoId: pedidoId,
    total: total,
    items: itens,
    forma: forma,
    checkoutToken: token,
    // Prazo de pagamento vindo do servidor (criar_pedido.expires_at). Sem ele: texto neutro, nunca um valor fixo.
    expiresAt: expiresAt || (typeof localStorage !== 'undefined' ? localStorage.getItem('lunoca_checkout_expires_' + pedidoId) : null) || null,
    cliente: {
      nome: clienteCustom?.nome || (window.usuarioAtual && window.usuarioAtual.nome) || 'Cliente Lunoca',
      email: clienteCustom?.email || (window.usuarioAtual && window.usuarioAtual.email) || 'cliente@lunocadoceria.com.br',
      cpf: clienteCustom?.cpf || (window.usuarioAtual && window.usuarioAtual.cpf) || ''
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
  if (window.MercadoPagoPlugin && typeof window.MercadoPagoPlugin.closeModal === 'function') {
    window.MercadoPagoPlugin.closeModal();
  }
  const modal = document.getElementById('modal-pagamento-mp');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function copiarTexto(txt, msgSucesso) {
  navigator.clipboard.writeText(txt).then(() => {
    alert(msgSucesso || 'Copiado para a área de transferência!');
  }).catch(() => {
    prompt('Copie o texto abaixo:', txt);
  });
}
