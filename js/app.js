// Global state variables
var produtos = [];
var carrinho = [];
var pedidosGlobal = [];
var usuarioAtual = { nivel: 'visitante', nome: '', email: '', id: null };
var modoCadastro = false;
var dataCalendario = new Date();
var produtoSendoVisto = null;

window.alert = function(msg) {
  let aviso = document.createElement('div');
  aviso.style.position = 'fixed';
  aviso.style.bottom = '30px';
  aviso.style.left = '50%';
  aviso.style.transform = 'translateX(-50%)';
  aviso.style.background = 'var(--primary-dark)';
  aviso.style.color = '#fff';
  aviso.style.padding = '12px 24px';
  aviso.style.borderRadius = '30px';
  aviso.style.zIndex = '99999';
  aviso.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';
  aviso.style.fontWeight = '600';
  aviso.style.textAlign = 'center';
  aviso.style.width = '80%';
  aviso.style.maxWidth = '400px';
  aviso.innerHTML = msg;
  document.body.appendChild(aviso);
  setTimeout(() => {
    aviso.style.opacity = '0';
    aviso.style.transition = 'opacity 0.4s';
    setTimeout(() => aviso.remove(), 400);
  }, 3000);
};

function mostrarTela(telaId) {
  document.querySelectorAll('.screen').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById(telaId).classList.add('active');
  document.getElementById('user-dropdown').classList.remove('show');
  window.scrollTo(0, 0);

  if (telaId === 'menu-section' && carrinho.length > 0 && usuarioAtual.nivel !== 'admin') {
    document.getElementById('btn-ver-carrinho').style.display = 'flex';
  } else {
    document.getElementById('btn-ver-carrinho').style.display = 'none';
  }

  if (telaId === 'admin-section') {
    if (typeof carregarPedidosAdmin === 'function') carregarPedidosAdmin();
    if (typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
  }

  if (telaId === 'checkout-section') {
    let endCompleto = usuarioAtual.endereco || "";
    if (usuarioAtual.numero) endCompleto += (endCompleto ? ", " : "") + usuarioAtual.numero;
    if (usuarioAtual.complemento) endCompleto += (endCompleto ? " - " : "") + usuarioAtual.complemento;
    if (usuarioAtual.cep) endCompleto += (endCompleto ? " (CEP: " : "(CEP: ") + usuarioAtual.cep + ")";
    document.getElementById('endereco-checkout').value = endCompleto;
  }
}

function configurarRegraData() {
  let d = new Date();
  d.setDate(d.getDate() + 2);
  document.getElementById('data-pedido').min = d.toISOString().split('T')[0];
}

window.onclick = function(event) {
  if (!event.target.matches('.user-menu-btn') && !event.target.matches('.fa-user')) {
    let dropdowns = document.getElementsByClassName("user-dropdown");
    for (let i = 0; i < dropdowns.length; i++) {
      dropdowns[i].classList.remove('show');
    }
  }
};

window.onload = async function() {
  if (typeof carregarProdutosServidor === 'function') carregarProdutosServidor();
  configurarRegraData();
  if (typeof atualizarInterfaceUsuario === 'function') atualizarInterfaceUsuario();
  if (typeof carregarCarrinhoLocal === 'function') carregarCarrinhoLocal();
  if (typeof carregarSessaoAtual === 'function') await carregarSessaoAtual();
};
