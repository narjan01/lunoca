// ==========================================================================
// LUNOCA DOCERIA - Módulo de Integração com Mercado Pago (PIX e Cartão)
// ==========================================================================

const MP_STORAGE_KEY = 'lunoca_mercadopago_config';

// Obter configurações locais ou do ambiente
function getMercadoPagoConfig() {
  try {
    const raw = localStorage.getItem(MP_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Erro ao ler configuração Mercado Pago:', e);
  }
  return {
    publicKey: '',
    accessToken: '',
    chavePixFallback: 'lunocadoceria@gmail.com'
  };
}

function salvarMercadoPagoConfig(cfg) {
  try {
    localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(cfg));
    return true;
  } catch (e) {
    console.error('Erro ao salvar configuração Mercado Pago:', e);
    return false;
  }
}

// Iniciar fluxo de pagamento após criar pedido
async function iniciarPagamentoMercadoPago(pedidoId, total, itens, forma) {
  const cfg = getMercadoPagoConfig();
  const modal = document.getElementById('modal-pagamento-mp');
  const conteudo = document.getElementById('modal-mp-conteudo');

  if (!modal || !conteudo) return;

  // Abrir modal com estado de carregamento
  modal.classList.add('active');
  conteudo.innerHTML = `
    <div style="text-align:center; padding: 25px 10px;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size:36px; color:var(--primary); margin-bottom:15px;"></i>
      <h3 style="margin:0 0 8px 0; color:var(--text-dark);">Gerando Pagamento Seguro...</h3>
      <p style="font-size:14px; color:#666; margin:0;">Conectando com Mercado Pago para ${forma === 'pix' ? 'Pix instantâneo' : 'Cartão de crédito'}.</p>
    </div>
  `;

  try {
    // 1. Tentar gerar preferência no backend Cloudflare Pages Functions
    const res = await fetch('/api/mercadopago/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pedidoId: pedidoId,
        total: total,
        items: itens,
        forma: forma,
        cliente: {
          nome: usuarioAtual.nome || 'Cliente Lunoca',
          email: usuarioAtual.email || 'cliente@lunoca.com.br'
        },
        customAccessToken: cfg.accessToken || undefined,
        origin: window.location.origin
      })
    });

    const data = await res.json();

    if (res.ok && data.initPoint) {
      // Atualizar pedido no Supabase com o preferenceId e link
      try {
        if (typeof supabaseClient !== 'undefined') {
          await supabaseClient.from('pedidos').update({
            mercado_pago_preference_id: data.preferenceId,
            mercado_pago_link: data.initPoint
          }).eq('id', pedidoId);
        }
      } catch (dbErr) {
        console.warn('Nota: Coluna mercado_pago_link opcional no schema:', dbErr);
      }

      renderizarSucessoCheckoutMP(pedidoId, total, forma, data.initPoint, cfg);
    } else {
      // Fallback amigável caso o Access Token do Mercado Pago ainda não tenha sido cadastrado
      renderizarFallbackPix(pedidoId, total, forma, cfg, data.error);
    }
  } catch (err) {
    console.error('Erro ao conectar com Mercado Pago:', err);
    renderizarFallbackPix(pedidoId, total, forma, cfg, 'Erro de conexão com o Mercado Pago.');
  }
}

// Renderizar tela de checkout Mercado Pago
function renderizarSucessoCheckoutMP(pedidoId, total, forma, initPoint, cfg) {
  const conteudo = document.getElementById('modal-mp-conteudo');
  const isPix = forma === 'pix';

  conteudo.innerHTML = `
    <div style="text-align:center; padding:10px 5px;">
      <div style="display:inline-flex; align-items:center; justify-content:center; width:64px; height:64px; border-radius:50%; background:#e8f8f0; color:#27ae60; margin-bottom:15px; font-size:28px;">
        <i class="fa-solid fa-shield-halved"></i>
      </div>

      <h3 style="margin:0 0 6px 0; color:var(--text-dark); font-size:20px;">
        Pedido #${pedidoId} Registrado!
      </h3>
      <p style="font-size:14px; color:#666; margin:0 0 15px 0;">
        Total a pagar: <strong style="color:var(--primary-dark); font-size:18px;">R$ ${parseFloat(total).toFixed(2)}</strong>
      </p>

      <div style="background:#f4f9ff; border:1px solid #d0e4ff; border-radius:12px; padding:15px; text-align:left; margin-bottom:15px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <img src="https://http2.mlstatic.com/frontend-assets/ui-navigation/5.18.9/mercadopago/logo__small.png" alt="Mercado Pago" style="height:20px;">
          <strong style="color:#0086d6; font-size:13px;">Pagamento 100% Protegido</strong>
        </div>
        <p style="font-size:12px; color:#444; margin:0; line-height:1.5;">
          ${isPix 
            ? 'Você será direcionado para o ambiente seguro do Mercado Pago para gerar o <strong>QR Code Pix</strong> e o código <strong>Copia e Cola</strong> com aprovação na hora.' 
            : 'Pague com <strong>Cartão de Crédito</strong> em ambiente criptografado pelo Mercado Pago com opção de parcelamento.'}
        </p>
      </div>

      <div style="display:flex; flex-direction:column; gap:10px;">
        <a href="${initPoint}" target="_blank" rel="noopener" style="display:block; text-decoration:none;">
          <button style="width:100%; padding:14px; font-size:15px; background:#009ee3; color:#fff; border:none; border-radius:10px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 4px 12px rgba(0,158,227,0.3);">
            <i class="fa-solid ${isPix ? 'fa-qrcode' : 'fa-credit-card'}"></i>
            ${isPix ? 'Pagar via PIX no Mercado Pago' : 'Pagar com Cartão no Mercado Pago'}
          </button>
        </a>

        <button class="btn-outline" onclick="copiarLinkMP('${initPoint}')" style="width:100%; padding:10px; font-size:13px;">
          <i class="fa-solid fa-copy"></i> Copiar Link de Pagamento
        </button>
      </div>

      <div style="margin-top:15px; border-top:1px solid #eee; padding-top:12px;">
        <button onclick="fecharModalMP()" style="background:none; border:none; color:#888; font-size:13px; cursor:pointer; text-decoration:underline;">
          Acompanhar na Minha Conta / Voltar ao Início
        </button>
      </div>
    </div>
  `;
}

// Fallback caso ainda não tenha Access Token configurado
function renderizarFallbackPix(pedidoId, total, forma, cfg, motivo) {
  const conteudo = document.getElementById('modal-mp-conteudo');
  const chavePix = cfg.chavePixFallback || 'lunocadoceria@gmail.com';

  conteudo.innerHTML = `
    <div style="text-align:center; padding:10px 5px;">
      <div style="display:inline-flex; align-items:center; justify-content:center; width:56px; height:56px; border-radius:50%; background:#fff4e5; color:#d97706; margin-bottom:12px; font-size:24px;">
        <i class="fa-solid fa-check"></i>
      </div>

      <h3 style="margin:0 0 6px 0; color:var(--text-dark); font-size:18px;">
        Pedido #${pedidoId} Criado com Sucesso!
      </h3>
      <p style="font-size:13px; color:#666; margin:0 0 15px 0;">
        Total: <strong style="color:var(--primary-dark); font-size:16px;">R$ ${parseFloat(total).toFixed(2)}</strong>
      </p>

      <div style="background:#faf8ff; border:1px solid #e2d9f3; border-radius:12px; padding:14px; text-align:left; margin-bottom:15px;">
        <strong style="color:var(--primary-dark); font-size:13px; display:block; margin-bottom:6px;">
          <i class="fa-brands fa-pix" style="color:#32bcad;"></i> Pagamento via Pix:
        </strong>
        <p style="font-size:12px; color:#555; margin:0 0 8px 0;">
          Transfira para a chave Pix abaixo e envie o comprovante para o nosso WhatsApp para agilizar a preparação:
        </p>
        <div style="display:flex; align-items:center; gap:8px; background:#fff; padding:8px 12px; border-radius:8px; border:1px dashed #c496f2;">
          <code id="campo-chave-pix" style="flex:1; font-size:13px; color:#333; font-weight:bold; word-break:break-all;">${chavePix}</code>
          <button onclick="copiarTexto('${chavePix}', 'Chave Pix copiada!')" style="padding:6px 10px; font-size:12px; border-radius:6px; background:var(--primary); color:#fff; border:none; cursor:pointer;">
            Copiar
          </button>
        </div>
      </div>

      ${usuarioAtual.nivel === 'admin' ? `
        <div style="background:#fffbeb; border:1px solid #fef3c7; padding:8px 10px; border-radius:8px; font-size:11px; color:#92400e; margin-bottom:12px; text-align:left;">
          <strong>Aviso de Administrador:</strong> Configure seu <em>Access Token do Mercado Pago</em> na aba de Configurações no Painel Admin para ativar a geração automática de PIX e Cartão com QR Code na tela.
        </div>
      ` : ''}

      <button onclick="fecharModalMP()" style="width:100%; padding:12px; font-size:14px; background:var(--primary); color:#fff; border:none; border-radius:10px; font-weight:bold; cursor:pointer;">
        Entendido, Voltar ao Menu
      </button>
    </div>
  `;
}

function fecharModalMP() {
  const modal = document.getElementById('modal-pagamento-mp');
  if (modal) modal.classList.remove('active');
  mostrarTela('menu-section');
}

function copiarLinkMP(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert('Link de pagamento copiado com sucesso!');
  }).catch(() => {
    prompt('Copie o link abaixo:', url);
  });
}

function copiarTexto(txt, msgSucesso) {
  navigator.clipboard.writeText(txt).then(() => {
    alert(msgSucesso || 'Copiado para a área de transferência!');
  }).catch(() => {
    prompt('Copie o texto abaixo:', txt);
  });
}

// Checar retorno de pagamento via Mercado Pago na URL
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get('payment') || params.get('status') || params.get('collection_status');
  const orderId = params.get('order_id') || params.get('external_reference');

  if (paymentStatus === 'success' || paymentStatus === 'approved') {
    setTimeout(() => {
      alert(`🎉 Parabéns! O pagamento do Pedido #${orderId || ''} foi aprovado com sucesso pelo Mercado Pago.`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 1000);
  } else if (paymentStatus === 'failure' || paymentStatus === 'rejected') {
    setTimeout(() => {
      alert(`⚠️ O pagamento não foi concluído. Você pode tentar novamente na aba "Minha Conta".`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }, 1000);
  }
});
