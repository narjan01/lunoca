
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

// Formatação monetária BRL unificada
function formatarBRL(valor) {
  const num = parseFloat(valor) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Validação real de CPF (Módulo 11 com checagem de dígitos verificadores)
function validarCPF(cpf) {
  if (!cpf) return false;
  const limpo = String(cpf).replace(/\D/g, '');
  if (limpo.length !== 11) return false;
  
  // Elimina sequências conhecidas de dígitos iguais
  if (/^(\d)\1{10}$/.test(limpo)) return false;

  let soma = 0;
  let resto;

  for (let i = 1; i <= 9; i++) {
    soma += parseInt(limpo.substring(i - 1, i), 10) * (11 - i);
  }
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo.substring(9, 10), 10)) return false;

  soma = 0;
  for (let i = 1; i <= 10; i++) {
    soma += parseInt(limpo.substring(i - 1, i), 10) * (12 - i);
  }
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo.substring(10, 11), 10)) return false;

  return true;
}

// Máscara padronizada de CPF (000.000.000-00)
function mascaraCPF(input) {
  if (!input) return;
  let v = String(input.value || '').replace(/\D/g, '');
  if (v.length > 11) v = v.substring(0, 11);
  if (v.length > 9) {
    input.value = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
  } else if (v.length > 6) {
    input.value = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
  } else if (v.length > 3) {
    input.value = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
  } else {
    input.value = v;
  }
}

// Sistema de Notificações / Toasts Moderno e Não-Bloqueante
function mostrarToast(msg, tipo = 'info', duracao = 3800) {
  let container = document.getElementById('toast-container-global');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container-global';
    container.style.position = 'fixed';
    container.style.bottom = '25px';
    container.style.left = '50%';
    container.style.transform = 'translateX(-50%)';
    container.style.zIndex = '999999';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '10px';
    container.style.width = '90%';
    container.style.maxWidth = '420px';
    container.style.pointerEvents = 'none';
    document.body.appendChild(container);
  }

  let cores = {
    sucesso: { bg: 'linear-gradient(135deg, #059669, #10b981)', icon: 'fa-circle-check', border: '#a7f3d0' },
    erro: { bg: 'linear-gradient(135deg, #b91c1c, #ef4444)', icon: 'fa-circle-exclamation', border: '#fca5a5' },
    aviso: { bg: 'linear-gradient(135deg, #d97706, #f59e0b)', icon: 'fa-triangle-exclamation', border: '#fcd34d' },
    info: { bg: 'linear-gradient(135deg, var(--primary-dark, #8e4ec6), #6d28d9)', icon: 'fa-bell', border: 'rgba(255,255,255,0.25)' }
  };

  const estilo = cores[tipo] || cores.info;

  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.style.pointerEvents = 'auto';
  toast.style.background = estilo.bg;
  toast.style.color = '#ffffff';
  toast.style.padding = '12px 18px';
  toast.style.borderRadius = '16px';
  toast.style.boxShadow = '0 12px 30px rgba(0,0,0,0.22)';
  toast.style.fontWeight = '600';
  toast.style.fontSize = '13.5px';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '10px';
  toast.style.border = `1px solid ${estilo.border}`;
  toast.style.backdropFilter = 'blur(10px)';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(12px) scale(0.98)';
  toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';

  toast.innerHTML = `
    <i class="fa-solid ${estilo.icon}" style="font-size: 16px; shrink: 0;"></i>
    <span style="flex: 1; line-height: 1.35;">${escapeHTML(msg)}</span>
    <button type="button" style="background: transparent; border: none; color: rgba(255,255,255,0.8); cursor: pointer; padding: 0 4px; font-size: 14px; box-shadow: none;" onclick="this.parentElement.remove()">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  container.appendChild(toast);

  // Animação de entrada
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0) scale(1)';
  });

  // Remoção programada
  const timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px) scale(0.95)';
    setTimeout(() => toast.remove(), 320);
  }, duracao);

  toast.addEventListener('mouseenter', () => clearTimeout(timer));
}

// Fallback compatível para window.alert redirecionando para toasts contextuais
window.alert = function(msg) {
  const txt = String(msg || '');
  let tipo = 'info';
  if (txt.includes('✅') || txt.toLowerCase().includes('sucesso') || txt.toLowerCase().includes('confirmado')) {
    tipo = 'sucesso';
  } else if (txt.includes('❌') || txt.toLowerCase().includes('erro') || txt.toLowerCase().includes('falha')) {
    tipo = 'erro';
  } else if (txt.includes('⚠️') || txt.toLowerCase().includes('atenção') || txt.toLowerCase().includes('preencha')) {
    tipo = 'aviso';
  }
  mostrarToast(txt, tipo, tipo === 'erro' ? 5000 : 3800);
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
    if (typeof configurarAcessoAdminPorNivel === 'function') {
      configurarAcessoAdminPorNivel();
    }
    if (usuarioAtual && usuarioAtual.nivel === 'admin') {
      if (typeof carregarPedidosAdmin === 'function') carregarPedidosAdmin();
    }
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
