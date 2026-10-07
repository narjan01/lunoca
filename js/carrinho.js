// ==========================================================================
// LUNOCA DOCERIA - Módulo de Carrinho Interativo com Controle de Quantidades
// ==========================================================================

function atualizarBotaoCarrinho() {
  if (!Array.isArray(carrinho)) carrinho = [];

  let totalValor = 0;
  let totalItens = 0;

  for (let i = 0; i < carrinho.length; i++) {
    const item = carrinho[i];
    const qtd = Math.max(1, parseInt(item.quantidade || 1, 10));
    item.quantidade = qtd;
    const preco = parseFloat(item.preco || 0);
    totalValor += preco * qtd;
    totalItens += qtd;
  }

  // Atualiza botão flutuante inferior
  const qtdEl = document.getElementById('qtd-carrinho');
  const valorBtnEl = document.getElementById('valor-btn-carrinho');
  const totalEl = document.getElementById('total-carrinho');
  const btnFlutuante = document.getElementById('btn-ver-carrinho');

  if (qtdEl) qtdEl.innerText = totalItens;
  if (valorBtnEl) valorBtnEl.innerText = totalValor.toFixed(2);
  if (totalEl) totalEl.innerText = totalValor.toFixed(2);

  if (btnFlutuante) {
    btnFlutuante.style.display = totalItens > 0 ? 'flex' : 'none';
  }

  // Atualiza badge no ícone do header se existir
  const badgeHeader = document.getElementById('badge-header-carrinho');
  if (badgeHeader) {
    if (totalItens > 0) {
      badgeHeader.style.display = 'inline-flex';
      badgeHeader.innerText = totalItens;
    } else {
      badgeHeader.style.display = 'none';
    }
  }

  return { totalValor, totalItens };
}

function renderizarItensCheckout() {
  const container = document.getElementById('itens-carrinho');
  if (!container) return;

  if (!Array.isArray(carrinho) || carrinho.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 25px 10px; color:#888;">
        <i class="fa-solid fa-basket-shopping" style="font-size:38px; color:#d8b4f8; margin-bottom:12px; display:block;"></i>
        <p style="margin: 0 0 14px 0; font-size:14px; font-weight:500;">Seu carrinho está vazio.</p>
        <button class="btn-outline" onclick="mostrarTela('menu-section')" style="font-size:13px; padding: 8px 16px;">
          <i class="fa-solid fa-cake-candles"></i> Ver Cardápio de Doces
        </button>
      </div>
    `;
    const btnConfirmar = document.getElementById('btn-confirmar-checkout');
    if (btnConfirmar) btnConfirmar.disabled = true;
    return;
  }

  const btnConfirmar = document.getElementById('btn-confirmar-checkout');
  if (btnConfirmar) btnConfirmar.disabled = false;

  let html = '<div class="cart-items-list">';
  for (let i = 0; i < carrinho.length; i++) {
    const item = carrinho[i];
    const qtd = Math.max(1, parseInt(item.quantidade || 1, 10));
    const precoUnit = parseFloat(item.preco || 0);
    const subtotal = precoUnit * qtd;

    const nomeSeguro = typeof escapeHTML === 'function'
      ? escapeHTML(item.nome)
      : String(item.nome || 'Doce').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

    const imgUrl = item.img ? (typeof escapeHTML === 'function' ? escapeHTML(item.img) : item.img) : 'img/logo.jpg';

    html += `
      <div class="cart-item-row" data-index="${i}">
        <img src="${imgUrl}" class="cart-item-img" alt="${nomeSeguro}">
        <div class="cart-item-info">
          <div class="cart-item-title">${nomeSeguro}</div>
          <div class="cart-item-price">R$ ${precoUnit.toFixed(2)} un</div>
        </div>
        <div class="cart-item-controls">
          <button type="button" class="btn-qty" onclick="alterarQuantidade(${i}, -1)" title="Diminuir quantidade">
            <i class="fa-solid fa-minus"></i>
          </button>
          <span class="cart-qty-value">${qtd}</span>
          <button type="button" class="btn-qty" onclick="alterarQuantidade(${i}, 1)" title="Aumentar quantidade">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>
        <div class="cart-item-subtotal">
          R$ ${subtotal.toFixed(2)}
        </div>
        <button type="button" class="btn-remove-item" onclick="removerItemCarrinho(${i})" title="Remover doce do carrinho">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;
  }
  html += '</div>';

  container.innerHTML = html;
}

function alterarQuantidade(index, delta) {
  if (!carrinho[index]) return;

  const item = carrinho[index];
  const prodRef = Array.isArray(produtos) ? produtos.find(p => String(p.id) === String(item.id)) : null;

  if (delta > 0 && prodRef && prodRef.controlar_estoque !== false && prodRef.estoque_qtd != null) {
    const totalMesmoProd = carrinho
      .filter(it => String(it.id) === String(item.id))
      .reduce((s, it) => s + (parseInt(it.quantidade, 10) || 1), 0);
    if (totalMesmoProd + delta > prodRef.estoque_qtd) {
      alert(`Quantidade máxima disponível para "${prodRef.nome}" é ${prodRef.estoque_qtd} unidade(s).`);
      return;
    }
  }

  const novaQtd = (parseInt(carrinho[index].quantidade || 1, 10)) + delta;
  if (novaQtd <= 0) {
    removerItemCarrinho(index);
    return;
  }

  carrinho[index].quantidade = novaQtd;
  salvarCarrinhoLocal();
  atualizarBotaoCarrinho();
  renderizarItensCheckout();
}

function removerItemCarrinho(index) {
  if (!carrinho[index]) return;
  carrinho.splice(index, 1);
  salvarCarrinhoLocal();
  atualizarBotaoCarrinho();
  renderizarItensCheckout();
}

function irParaCheckout() {
  if (usuarioAtual && usuarioAtual.nivel === 'visitante') {
    alert("Por favor, faça login ou cadastre-se para finalizar seu pedido!");
    mostrarTela('login-section');
    return;
  }

  if (!carrinho || carrinho.length === 0) {
    alert("Seu carrinho está vazio! Adicione deliciosos doces antes de continuar.");
    mostrarTela('menu-section');
    return;
  }

  mostrarTela('checkout-section');
  renderizarItensCheckout();

  // Pré-preenche o CPF no checkout se o usuário já tiver cadastrado
  const cpfInput = document.getElementById('checkout-cpf');
  if (cpfInput && usuarioAtual && usuarioAtual.cpf) {
    cpfInput.value = usuarioAtual.cpf;
  }

  // Pré-preenche endereço se já configurado
  const endInput = document.getElementById('endereco-checkout');
  if (endInput && usuarioAtual && usuarioAtual.endereco && !endInput.value) {
    let enderecoCompleto = usuarioAtual.endereco;
    if (usuarioAtual.numero) enderecoCompleto += ', ' + usuarioAtual.numero;
    if (usuarioAtual.complemento) enderecoCompleto += ' (' + usuarioAtual.complemento + ')';
    if (usuarioAtual.cep) enderecoCompleto += ' - CEP: ' + usuarioAtual.cep;
    endInput.value = enderecoCompleto;
  }
}

function salvarCarrinhoLocal() {
  try {
    localStorage.setItem('lunoca_carrinho', JSON.stringify(carrinho));
  } catch (e) {
    console.warn('Erro ao salvar carrinho no localStorage:', e);
  }
}

function carregarCarrinhoLocal() {
  const carrinhoSalvo = localStorage.getItem('lunoca_carrinho');
  if (carrinhoSalvo) {
    try {
      const parsed = JSON.parse(carrinhoSalvo);
      carrinho = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      carrinho = [];
    }
  }
  atualizarBotaoCarrinho();
}
