
// Função global de escape para prevenir XSS
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, function(tag) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag;
  });
}

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
  aviso.style.background = 'linear-gradient(135deg, var(--primary-dark), #6d28d9)';
  aviso.style.color = '#fff';
  aviso.style.padding = '14px 28px';
  aviso.style.borderRadius = '30px';
  aviso.style.zIndex = '99999';
  aviso.style.boxShadow = '0 12px 30px rgba(0,0,0,0.25)';
  aviso.style.fontWeight = '600';
  aviso.style.fontSize = '14px';
  aviso.style.textAlign = 'center';
  aviso.style.width = '85%';
  aviso.style.maxWidth = '420px';
  aviso.style.backdropFilter = 'blur(8px)';
  aviso.style.border = '1px solid rgba(255,255,255,0.2)';
  aviso.textContent = msg;
  document.body.appendChild(aviso);
  setTimeout(() => {
    aviso.style.opacity = '0';
    aviso.style.transform = 'translateX(-50%) translateY(10px)';
    aviso.style.transition = 'all 0.35s ease';
    setTimeout(() => aviso.remove(), 350);
  }, 3200);
};

function mascaraTelefone(input) {
  if (!input) return;
  let v = String(input.value || '').replace(/\D/g, '');
  if (v.length > 11) v = v.substring(0, 11);
  if (v.length > 10) {
    input.value = v.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  } else if (v.length > 6) {
    input.value = v.replace(/^(\d{2})(\d{4})(\d{0,4})$/, '($1) $2-$3');
  } else if (v.length > 2) {
    input.value = v.replace(/^(\d{2})(\d{0,5})$/, '($1) $2');
  } else {
    input.value = v;
  }
}

function buscarCepCheckout() {
  const cepEl = document.getElementById('checkout-cep');
  if (!cepEl) return;
  let cep = cepEl.value.replace(/\D/g, '');
  if (cep.length === 8) {
    const ruaEl = document.getElementById('checkout-rua');
    if (ruaEl) ruaEl.placeholder = "Buscando endereço nos Correios...";
    fetch('https://viacep.com.br/ws/' + cep + '/json/')
      .then(res => res.json())
      .then(data => {
        if (!data.erro) {
          if (ruaEl) {
            ruaEl.value = (data.logradouro ? data.logradouro + ", " : "") + (data.bairro ? data.bairro + " - " : "") + (data.localidade || "") + (data.uf ? "/" + data.uf : "");
          }
          const numEl = document.getElementById('checkout-numero');
          if (numEl) numEl.focus();
        } else {
          if (ruaEl) ruaEl.placeholder = "Ex: Rua das Flores, 123";
          alert("CEP não encontrado. Preencha seu endereço manualmente.");
        }
      })
      .catch(() => {
        if (ruaEl) ruaEl.placeholder = "Ex: Rua das Flores, 123";
      });
  }
}

function mostrarTela(telaId) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach(function(el) { 
    el.classList.remove('active'); 
  });
  
  const target = document.getElementById(telaId);
  if (target) {
    target.classList.add('active');
  }
  
  const dropdown = document.getElementById('user-dropdown');
  if (dropdown) dropdown.classList.remove('show');
  
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const btnCarrinho = document.getElementById('btn-ver-carrinho');
  if (btnCarrinho) {
    if (telaId === 'menu-section' && carrinho.length > 0 && usuarioAtual.nivel !== 'admin') {
      btnCarrinho.style.display = 'flex';
    } else {
      btnCarrinho.style.display = 'none';
    }
  }

  if (telaId === 'admin-section') {
    if (typeof carregarPedidosAdmin === 'function') carregarPedidosAdmin();
    if (typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
  }

  if (telaId === 'checkout-section') {
    // Sincroniza dados do usuário logado diretamente nos campos de checkout
    if (usuarioAtual) {
      const nomeInput = document.getElementById('checkout-nome');
      if (nomeInput && usuarioAtual.nome) nomeInput.value = usuarioAtual.nome;

      const whatsInput = document.getElementById('checkout-whatsapp');
      if (whatsInput && usuarioAtual.telefone) {
        whatsInput.value = usuarioAtual.telefone;
        mascaraTelefone(whatsInput);
      }

      const cpfInput = document.getElementById('checkout-cpf');
      if (cpfInput && usuarioAtual.cpf) {
        cpfInput.value = usuarioAtual.cpf;
        if (typeof mascaraCPF === 'function') mascaraCPF(cpfInput);
      }

      const cepInput = document.getElementById('checkout-cep');
      if (cepInput && usuarioAtual.cep) cepInput.value = usuarioAtual.cep;

      const ruaInput = document.getElementById('checkout-rua');
      if (ruaInput && usuarioAtual.endereco) ruaInput.value = usuarioAtual.endereco;

      const numInput = document.getElementById('checkout-numero');
      if (numInput && usuarioAtual.numero) numInput.value = usuarioAtual.numero;

      const compInput = document.getElementById('checkout-complemento');
      if (compInput && usuarioAtual.complemento) compInput.value = usuarioAtual.complemento;

      let endCompleto = usuarioAtual.endereco || "";
      if (usuarioAtual.numero) endCompleto += (endCompleto ? ", " : "") + usuarioAtual.numero;
      if (usuarioAtual.complemento) endCompleto += (endCompleto ? " - " : "") + usuarioAtual.complemento;
      if (usuarioAtual.cep) endCompleto += (endCompleto ? " (CEP: " : "(CEP: ") + usuarioAtual.cep + ")";
      const endEl = document.getElementById('endereco-checkout');
      if (endEl) endEl.value = endCompleto;
    }
  }

  if (telaId === 'conta-section' && typeof carregarMeusPedidos === 'function') {
    carregarMeusPedidos();
  }
}

function configurarRegraData() {
  let d = new Date();
  let diasUteis = 2;
  let adicionados = 0;
  while (adicionados < diasUteis) {
    d.setDate(d.getDate() + 1);
    let dia = d.getDay();
    if (dia !== 0 && dia !== 6) { // Pula Domingo (0) e Sábado (6)
      adicionados++;
    }
  }
  let campo = document.getElementById('data-pedido');
  if (campo) {
    campo.min = d.toISOString().split('T')[0];
  }
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
