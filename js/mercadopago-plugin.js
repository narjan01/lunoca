// ==========================================================================
// LUNOCA DOCERIA - Plug-in Oficial Mercado Pago v2.0
// Suporte a PIX Instantâneo com QR Code, Cartão de Crédito em até 12x
// e Gestão Integrada no Painel Administrativo.
// ==========================================================================

(function (window, document) {
  'use strict';

  const PLUGIN_VERSION = '2.0.0';
  const STORAGE_KEY = 'lunoca_mercadopago_config';
  const MP_SDK_URL = 'https://sdk.mercadopago.com/js/v2';

  // Configurações padrão
  const defaultConfig = {
    publicKey: '',
    accessToken: '',
    chavePixFallback: 'lunocadoceria@gmail.com',
    storeName: 'Lunoca Doceria',
    environment: 'production', // 'production' ou 'sandbox'
    autoPollStatus: true,
  };

  const MercadoPagoPlugin = {
    version: PLUGIN_VERSION,
    isLoaded: false,
    mpInstance: null,

    // Obter configurações armazenadas
    getConfig: function () {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          return Object.assign({}, defaultConfig, JSON.parse(stored));
        }
      } catch (e) {
        console.warn('[MercadoPagoPlugin] Erro ao ler configurações do storage:', e);
      }
      return Object.assign({}, defaultConfig);
    },

    // Salvar configurações
    saveConfig: function (newConfig) {
      try {
        const current = this.getConfig();
        const merged = Object.assign({}, current, newConfig);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        if (merged.accessToken) {
          localStorage.setItem('lunoca_mercadopago_token', merged.accessToken);
        }
        if (merged.publicKey) {
          localStorage.setItem('lunoca_mercadopago_public_key', merged.publicKey);
        }
        return true;
      } catch (e) {
        console.error('[MercadoPagoPlugin] Erro ao salvar configurações:', e);
        return false;
      }
    },

    // Carregar SDK oficial do Mercado Pago dinamicamente se necessário
    loadSDK: function () {
      return new Promise((resolve) => {
        if (window.MercadoPago) {
          this.isLoaded = true;
          return resolve(window.MercadoPago);
        }

        const existingScript = document.querySelector(`script[src*="mercadopago.com"]`);
        if (existingScript) {
          existingScript.addEventListener('load', () => {
            this.isLoaded = true;
            resolve(window.MercadoPago);
          });
          return;
        }

        const script = document.createElement('script');
        script.src = MP_SDK_URL;
        script.async = true;
        script.onload = () => {
          this.isLoaded = true;
          console.log('[MercadoPagoPlugin] SDK Mercado Pago carregado com sucesso.');
          resolve(window.MercadoPago);
        };
        script.onerror = () => {
          console.warn('[MercadoPagoPlugin] Falha ao carregar SDK externo do Mercado Pago.');
          resolve(null);
        };
        document.head.appendChild(script);
      });
    },

    // Inicializar o plugin
    init: async function (options) {
      if (options) {
        this.saveConfig(options);
      }
      await this.loadSDK();
      const cfg = this.getConfig();
      if (cfg.publicKey && window.MercadoPago) {
        try {
          this.mpInstance = new window.MercadoPago(cfg.publicKey, {
            locale: 'pt-BR',
          });
        } catch (e) {
          console.warn('[MercadoPagoPlugin] Falha ao instanciar MercadoPago com public key:', e);
        }
      }

      this.injectModalMarkup();
      console.log(`[MercadoPagoPlugin] Plug-in Mercado Pago v${PLUGIN_VERSION} inicializado.`);
      return this;
    },

    // Garantir marcação do modal no DOM
    injectModalMarkup: function () {
      let modal = document.getElementById('modal-pagamento-mp');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-pagamento-mp';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal-content" style="max-width: 440px; border-radius: 16px; padding: 24px; position: relative;">
            <span class="close-modal" onclick="window.MercadoPagoPlugin.closeModal()" style="position: absolute; right: 16px; top: 14px; font-size: 24px; cursor: pointer;">&times;</span>
            <div id="modal-mp-conteudo"></div>
          </div>
        `;
        document.body.appendChild(modal);
      }
    },

    closeModal: function () {
      const modal = document.getElementById('modal-pagamento-mp');
      if (modal) {
        modal.classList.remove('active');
      }
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    },

    // Iniciar fluxo de checkout a partir de um pedido
    checkout: async function (orderData) {
      const { pedidoId, total, itens, forma, cliente } = orderData;
      const cfg = this.getConfig();
      this.injectModalMarkup();

      const modal = document.getElementById('modal-pagamento-mp');
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (!modal || !conteudo) return;

      modal.classList.add('active');
      conteudo.innerHTML = `
        <div style="text-align:center; padding: 25px 10px;">
          <div style="display:inline-block; width:44px; height:44px; border:4px solid #e0f2fe; border-top-color:#0284c7; border-radius:50%; animation: spin 0.8s linear infinite; margin-bottom:15px;"></div>
          <h3 style="margin:0 0 8px 0; color:#18181b; font-size:18px;">Gerando Pagamento Seguro...</h3>
          <p style="font-size:13px; color:#71717a; margin:0;">Conectando com o Mercado Pago para ${forma === 'pix' ? 'PIX instantâneo com QR Code' : 'Cartão de Crédito'}.</p>
        </div>
        <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
      `;

      try {
        const res = await fetch('/api/mercadopago/preference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pedidoId: pedidoId,
            total: total,
            items: itens || [],
            forma: forma || 'todos',
            cliente: cliente || {
              nome: (window.usuarioAtual && window.usuarioAtual.nome) || 'Cliente Lunoca',
              email: (window.usuarioAtual && window.usuarioAtual.email) || 'cliente@lunocadoceria.com.br',
            },
            customAccessToken: cfg.accessToken || undefined,
            origin: window.location.origin,
          }),
        });

        const data = await res.json();

        if (res.ok && data.initPoint) {
          // Atualizar dados no Supabase se cliente existir
          try {
            if (typeof window.supabaseClient !== 'undefined') {
              await window.supabaseClient
                .from('pedidos')
                .update({
                  mercado_pago_preference_id: data.preferenceId,
                  mercado_pago_link: data.initPoint,
                })
                .eq('id', pedidoId);
            }
          } catch (dbErr) {
            console.warn('[MercadoPagoPlugin] Aviso ao salvar preference no Supabase:', dbErr);
          }

          this.renderCheckoutScreen(conteudo, {
            pedidoId,
            total,
            initPoint: data.initPoint,
            forma,
          });

          // Iniciar polling de aprovação no Supabase
          this.startOrderPolling(pedidoId);
        } else {
          // Fallback para chave PIX se backend falhar
          console.warn('[MercadoPagoPlugin] Falha na preferência do Mercado Pago, exibindo contingência:', data.error);
          this.renderFallbackPix(conteudo, { pedidoId, total });
        }
      } catch (err) {
        console.error('[MercadoPagoPlugin] Erro ao conectar ao Mercado Pago:', err);
        this.renderFallbackPix(conteudo, { pedidoId, total });
      }
    },

    // Renderizar tela de checkout com botão e QR Code
    renderCheckoutScreen: function (container, info) {
      const { pedidoId, total, initPoint, forma } = info;
      const formattedTotal = Number(total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      container.innerHTML = `
        <div style="text-align: center;">
          <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px;">
            <span style="background: #0284c7; color: white; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
              Mercado Pago Oficial
            </span>
          </div>

          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 19px; font-weight: 700;">
            Pedido #${pedidoId}
          </h3>
          <div style="font-size: 26px; font-weight: 800; color: #0284c7; margin-bottom: 16px;">
            ${formattedTotal}
          </div>

          <p style="font-size: 13px; color: #475569; margin: 0 0 20px 0; line-height: 1.5;">
            Clique no botão abaixo para pagar via <strong>PIX Instantâneo com QR Code</strong> ou <strong>Cartão de Crédito em até 12x</strong> com aprovação automática.
          </p>

          <a href="${initPoint}" target="_blank" rel="noopener noreferrer" id="btn-mp-open-checkout"
            style="display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; background: #0284c7; color: white; text-decoration: none; padding: 14px 20px; border-radius: 12px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3); transition: all 0.2s;"
            onmouseover="this.style.background='#0369a1'"
            onmouseout="this.style.background='#0284c7'">
            <span>Pagar Agora no Mercado Pago</span>
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>

          <div style="margin-top: 14px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 12px; color: #64748b; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <i class="fa-solid fa-shield-halved" style="color: #10b981;"></i>
            <span>Pagamento 100% protegido pelo Mercado Pago</span>
          </div>

          <div id="mp-status-polling" style="margin-top: 12px; font-size: 12px; color: #0284c7; font-weight: 600;">
            <i class="fa-solid fa-rotate fa-spin"></i> Aguardando confirmação do pagamento...
          </div>
        </div>
      `;
    },

    // Renderizar fallback para chave Pix
    renderFallbackPix: function (container, info) {
      const { pedidoId, total } = info;
      const cfg = this.getConfig();
      const chavePix = cfg.chavePixFallback || 'lunocadoceria@gmail.com';
      const formattedTotal = Number(total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      container.innerHTML = `
        <div style="text-align: center;">
          <div style="display:inline-block; padding: 8px; background: #ecfdf5; border-radius: 50%; color: #059669; font-size: 24px; margin-bottom: 12px;">
            <i class="fa-brands fa-pix"></i>
          </div>
          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 18px;">Pagamento via Chave PIX</h3>
          <p style="font-size: 12px; color: #64748b; margin: 0 0 14px 0;">Pedido #${pedidoId} &bull; Total: <strong>${formattedTotal}</strong></p>

          <div style="background: #f8fafc; border: 1px dashed #cbd5e1; padding: 14px; border-radius: 12px; margin-bottom: 14px;">
            <span style="font-size: 11px; color: #64748b; display: block; margin-bottom: 4px; font-weight: 600;">CHAVE PIX (E-MAIL)</span>
            <strong id="texto-chave-pix-plugin" style="font-size: 14px; color: #0f172a; font-family: monospace; word-break: break-all;">${chavePix}</strong>
          </div>

          <button onclick="window.MercadoPagoPlugin.copyPixKey('${chavePix}')" id="btn-copiar-chave-pix"
            style="width: 100%; background: #059669; color: white; border: none; padding: 12px; border-radius: 10px; font-weight: bold; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <i class="fa-solid fa-copy"></i> Copiar Chave PIX
          </button>

          <p style="font-size: 11px; color: #94a3b8; margin: 12px 0 0 0;">
            Após realizar a transferência, envie o comprovante pelo WhatsApp com o número do pedido.
          </p>
        </div>
      `;
    },

    copyPixKey: function (text) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btn-copiar-chave-pix');
        if (btn) {
          btn.innerHTML = '<i class="fa-solid fa-check"></i> Chave Copiada!';
          btn.style.background = '#10b981';
          setTimeout(() => {
            btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copiar Chave PIX';
            btn.style.background = '#059669';
          }, 2500);
        }
      });
    },

    // Checagem em tempo real se o pedido foi aprovado
    startOrderPolling: function (pedidoId) {
      if (this.pollInterval) clearInterval(this.pollInterval);
      const startTime = Date.now();

      this.pollInterval = setInterval(async () => {
        // Interrompe após 10 minutos
        if (Date.now() - startTime > 10 * 60 * 1000) {
          clearInterval(this.pollInterval);
          return;
        }

        if (typeof window.supabaseClient === 'undefined') return;

        try {
          const { data, error } = await window.supabaseClient
            .from('pedidos')
            .select('status, mercado_pago_status')
            .eq('id', pedidoId)
            .single();

          if (!error && data) {
            if (data.status === 'Confirmado' || data.mercado_pago_status === 'approved') {
              clearInterval(this.pollInterval);
              const pollingEl = document.getElementById('mp-status-polling');
              if (pollingEl) {
                pollingEl.innerHTML = `
                  <div style="padding: 10px; background: #ecfdf5; color: #047857; border-radius: 8px; border: 1px solid #a7f3d0; margin-top: 10px;">
                    <i class="fa-solid fa-circle-check"></i> Pagamento Aprovado com Sucesso! Seu pedido já está sendo preparado.
                  </div>
                `;
              }
            }
          }
        } catch (e) {
          // silencia erros transitórios de rede
        }
      }, 5000);
    },

    // Testar token diretamente
    testToken: async function (token) {
      const tk = (token || this.getConfig().accessToken || '').trim();
      if (!tk) {
        return { success: false, error: 'Access Token não informado.' };
      }

      try {
        const res = await fetch('/api/mercadopago/test-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tk }),
        });
        return await res.json();
      } catch (err) {
        return { success: false, error: err.message || 'Erro ao conectar à API do Mercado Pago.' };
      }
    },
  };

  // Expor globalmente
  window.MercadoPagoPlugin = MercadoPagoPlugin;

  // Auto inicialização ao carregar documento
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MercadoPagoPlugin.init());
  } else {
    MercadoPagoPlugin.init();
  }
})(window, document);
