// ==========================================================================
// LUNOCA DOCERIA - MÓDULO DE SACOLA & CARRINHO CHARMOSO
// ==========================================================================

function atualizarBotaoCarrinho() {
  let total = 0;
  for (let i = 0; i < carrinho.length; i++) {
    total += parseFloat(carrinho[i].preco || 0);
  }
  const totalFormatted = total.toFixed(2).replace('.', ',');
  const elQtd = document.getElementById('qtd-carrinho');
  const elVal = document.getElementById('valor-btn-carrinho');
  const elTot = document.getElementById('total-carrinho');
  
  if (elQtd) elQtd.innerText = carrinho.length;
  if (elVal) elVal.innerText = totalFormatted;
  if (elTot) elTot.innerText = totalFormatted;
}

function removerItemCarrinho(index) {
  if (index >= 0 && index < carrinho.length) {
    carrinho.splice(index, 1);
    salvarCarrinhoLocal();
    atualizarBotaoCarrinho();
    irParaCheckout();
    if (carrinho.length === 0) {
      mostrarTela('menu-section');
    }
  }
}

function limparCarrinho() {
  if (confirm("Deseja realmente esvaziar sua sacola de doces?")) {
    carrinho = [];
    salvarCarrinhoLocal();
    atualizarBotaoCarrinho();
    mostrarTela('menu-section');
  }
}

function irParaCheckout() {
  if (carrinho.length === 0) {
    alert("Sua sacola de doces está vazia! Escolha algumas delícias primeiro.");
    return mostrarTela('menu-section');
  }
  
  mostrarTela('checkout-section');
  
  let html = '';
  let total = 0;
  
  for (let i = 0; i < carrinho.length; i++) {
    let item = carrinho[i];
    let preco = parseFloat(item.preco || 0);
    total += preco;
    
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid rgba(43,24,16,0.08);">
        <div style="display:flex; align-items:center; gap:12px; flex:1;">
          <img src="${item.img || 'img/logo.jpg'}" style="width:42px; height:42px; border-radius:10px; object-fit:cover; border:1.5px solid var(--border-gold); box-shadow:0 2px 6px rgba(0,0,0,0.08);">
          <div>
            <div style="font-size:14px; font-weight:600; color:var(--text-dark); line-height:1.3;">${escapeHTML(item.nome)}</div>
            <div style="font-size:12.5px; color:var(--primary); font-weight:700;">R$ ${preco.toFixed(2).replace('.', ',')}</div>
          </div>
        </div>
        <button onclick="removerItemCarrinho(${i})" title="Remover item" style="background:transparent; color:#e74c3c; border:none; box-shadow:none; padding:6px 10px; font-size:14px; border-radius:50%; cursor:pointer; transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.15)'" onmouseout="this.style.transform='scale(1)'">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;
  }
  
  document.getElementById('itens-carrinho').innerHTML = html;
  const elTot = document.getElementById('total-carrinho');
  if (elTot) elTot.innerText = total.toFixed(2).replace('.', ',');
}

function salvarCarrinhoLocal() {
  localStorage.setItem('lunoca_carrinho', JSON.stringify(carrinho));
}

function carregarCarrinhoLocal() {
  const carrinhoSalvo = localStorage.getItem('lunoca_carrinho');
  if (carrinhoSalvo) {
    try {
      carrinho = JSON.parse(carrinhoSalvo);
    } catch (e) {
      carrinho = [];
    }
  }
  atualizarBotaoCarrinho();
}
