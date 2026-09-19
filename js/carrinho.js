function atualizarBotaoCarrinho() {
  let total = 0;
  for (let i = 0; i < carrinho.length; i++) {
    total += parseFloat(carrinho[i].preco);
  }
  document.getElementById('qtd-carrinho').innerText = carrinho.length;
  document.getElementById('valor-btn-carrinho').innerText = total.toFixed(2);
  document.getElementById('total-carrinho').innerText = total.toFixed(2);
}

function irParaCheckout() {
  if (carrinho.length === 0) return;
  mostrarTela('checkout-section');
  let html = '';
  for (let i = 0; i < carrinho.length; i++) {
    let item = carrinho[i];
    html += '<p style="font-size:14px; margin:8px 0; border-bottom: 1px solid #f0f0f0; padding-bottom: 5px;"><i class="fa-solid fa-angle-right" style="color:var(--primary); font-size:10px;"></i> ' + item.nome + '<strong style="float:right;">R$ ' + parseFloat(item.preco).toFixed(2) + '</strong></p>';
  }
  document.getElementById('itens-carrinho').innerHTML = html;
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
