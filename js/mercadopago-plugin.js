/**
 * ============================================================================
 * LUNOCA DOCERIA - Plug-in Mercado Pago v2.5 (Checkout Transparente)
 * Integração 100% no próprio site (Sem redirecionamentos externos)
 * - PIX Transparente com QR Code na tela + Código Copia e Cola
 * - Cartão de Crédito Transparente com aprovação imediata e parcelamento
 * - Polling em tempo real de confirmação bancária
 * ============================================================================
 */

(function (window, document) {
  'use strict';

  const STORAGE_KEY = 'lunoca_mercadopago_config';

  const MercadoPagoPlugin = {
    version: '2.5.0-transparent',
    initialized: false,
    mpInstance: null,
    pollInterval: null,
    currentOrder: null,

    // Inicialização do Plugin
    init: function () {
      if (this.initialized) return;
      this.initialized = true;
      console.log('[MercadoPagoPlugin] Inicializado no modo Checkout Transparente v' + this.version);

      const cfg = this.getConfig();
      if (cfg.publicKey && typeof window.MercadoPago !== 'undefined') {
        try {
          this.mpInstance = new window.MercadoPago(cfg.publicKey, { locale: 'pt-BR' });
        } catch (e) {
          console.warn('[MercadoPagoPlugin] Aviso ao instanciar SDK v2:', e);
        }
      }

      this.ensureModalExists();
    },

    getConfig: function () {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {
        console.error('[MercadoPagoPlugin] Erro ao ler localStorage:', e);
      }
      return {
        publicKey: '',
        accessToken: '',
        chavePixFallback: 'lunocadoceria@gmail.com',
        modoTransparente: true,
      };
    },

    saveConfig: function (cfg) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
        if (cfg.publicKey && typeof window.MercadoPago !== 'undefined') {
          this.mpInstance = new window.MercadoPago(cfg.publicKey, { locale: 'pt-BR' });
        }
        return true;
      } catch (e) {
        console.error('[MercadoPagoPlugin] Erro ao salvar config:', e);
        return false;
      }
    },

    ensureModalExists: function () {
      let modal = document.getElementById('modal-pagamento-mp');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-pagamento-mp';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal-box" style="max-width: 520px; width: 95%; max-height: 92vh; overflow-y: auto; padding: 22px; border-radius: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.25); background: #ffffff;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <img src="https://http2.mlstatic.com/frontend-assets/ui-navigation/5.18.9/mercadopago/logo__small.png" alt="Mercado Pago" style="height: 22px;">
                <span style="font-size: 13px; font-weight: 700; color: #0086d6; background: #e0f2fe; padding: 3px 8px; border-radius: 12px;">Transparente</span>
              </div>
              <button onclick="window.MercadoPagoPlugin.closeModal()" style="background: #f1f5f9; border: none; width: 32px; height: 32px; border-radius: 50%; font-size: 16px; cursor: pointer; color: #64748b; display: flex; align-items: center; justify-content: center;">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div id="modal-mp-conteudo"></div>
          </div>
        `;
        document.body.appendChild(modal);
      }
    },

    closeModal: function () {
      if (this.pollInterval) clearInterval(this.pollInterval);
      const modal = document.getElementById('modal-pagamento-mp');
      if (modal) modal.classList.remove('active');
      if (typeof window.mostrarTela === 'function') {
        window.mostrarTela('menu-section');
      }
    },

    // Entrada principal do Checkout Transparente
    iniciarCheckoutTransparente: async function (orderData) {
      this.ensureModalExists();
      this.currentOrder = orderData;
      const modal = document.getElementById('modal-pagamento-mp');
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (!modal || !conteudo) return;

      modal.classList.add('active');

      const forma = orderData.forma || 'pix';
      if (forma === 'pix') {
        await this.iniciarPixTransparente(orderData);
      } else {
        this.renderFormCartaoTransparente(conteudo, orderData);
      }
    },

    // 1. FLUXO PIX TRANSPARENTE
    iniciarPixTransparente: async function (orderData) {
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (!conteudo) return;

      const formattedTotal = Number(orderData.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      conteudo.innerHTML = `
        <div style="text-align: center; padding: 25px 10px;">
          <div style="width: 60px; height: 60px; border-radius: 50%; background: #e0f2fe; color: #0284c7; display: inline-flex; align-items: center; justify-content: center; font-size: 26px; margin-bottom: 16px;">
            <i class="fa-solid fa-qrcode fa-fade"></i>
          </div>
          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 18px;">Gerando QR Code Pix...</h3>
          <p style="font-size: 13px; color: #64748b; margin: 0 0 12px 0;">Pedido #${orderData.pedidoId} &bull; Total: <strong>${formattedTotal}</strong></p>
          <div style="font-size: 12px; color: #0284c7; display: flex; align-items: center; justify-content: center; gap: 6px;">
            <i class="fa-solid fa-spinner fa-spin"></i> Comunicando diretamente com o Mercado Pago
          </div>
        </div>
      `;

      try {
        const cfg = this.getConfig();
        const payload = {
          pedidoId: orderData.pedidoId,
          total: orderData.total,
          forma: 'pix',
          items: orderData.items || [],
          cliente: orderData.cliente || {
            nome: window.usuarioAtual?.nome || 'Cliente Lunoca',
            email: window.usuarioAtual?.email || 'cliente@lunocadoceria.com.br',
            cpf: window.usuarioAtual?.cpf || '19119119100'
          },
          customAccessToken: cfg.accessToken || '',
          origin: window.location.origin
        };

        const res = await fetch('/api/mercadopago/transparent-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.success && data.qrCode) {
          // Atualizar o Supabase com o ID do pagamento gerado
          try {
            if (typeof window.supabaseClient !== 'undefined') {
              await window.supabaseClient.from('pedidos').update({
                mercado_pago_id: String(data.paymentId),
                mercado_pago_status: data.status || 'pending'
              }).eq('id', orderData.pedidoId);
            }
          } catch (dbErr) {
            console.warn('[MercadoPagoPlugin] Aviso ao salvar pedido:', dbErr);
          }

          this.renderTelaPixCompleta(conteudo, {
            pedidoId: orderData.pedidoId,
            total: orderData.total,
            paymentId: data.paymentId,
            qrCode: data.qrCode,
            qrCodeBase64: data.qrCodeBase64,
            ticketUrl: data.ticketUrl,
            expirationDate: data.expirationDate
          });

          // Iniciar verificação automática em tempo real
          this.startRealtimePolling(data.paymentId, orderData.pedidoId);

        } else {
          console.warn('[MercadoPagoPlugin] Falha ao gerar PIX:', data.error);
          this.renderFallbackPix(conteudo, {
            pedidoId: orderData.pedidoId,
            total: orderData.total,
            motivo: data.error
          });
        }
      } catch (err) {
        console.error('[MercadoPagoPlugin] Erro na requisição do PIX:', err);
        this.renderFallbackPix(conteudo, {
          pedidoId: orderData.pedidoId,
          total: orderData.total,
          motivo: 'Erro de conexão.'
        });
      }
    },

    // Renderizar Tela do PIX Transparente com QR Code na tela e Copia e Cola
    renderTelaPixCompleta: function (container, pixInfo) {
      const formattedTotal = Number(pixInfo.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      container.innerHTML = `
        <div style="text-align: center;">
          <!-- Seletor de Abas Transparente -->
          <div style="display: flex; gap: 6px; background: #f1f5f9; padding: 4px; border-radius: 12px; margin-bottom: 16px;">
            <button style="flex: 1; padding: 8px; border: none; border-radius: 8px; font-weight: 700; font-size: 13px; background: #ffffff; color: #0284c7; box-shadow: 0 2px 4px rgba(0,0,0,0.05); display: flex; align-items: center; justify-content: center; gap: 6px;">
              <i class="fa-brands fa-pix" style="color: #32bcad;"></i> PIX Transparente
            </button>
            <button onclick="window.MercadoPagoPlugin.switchToCard()" style="flex: 1; padding: 8px; border: none; border-radius: 8px; font-weight: 600; font-size: 13px; background: transparent; color: #64748b; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <i class="fa-solid fa-credit-card"></i> Pagar com Cartão
            </button>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; padding: 0 4px;">
            <div style="text-align: left;">
              <span style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; letter-spacing: 0.5px;">Pedido #${pixInfo.pedidoId}</span>
              <div style="font-size: 13px; color: #334155; font-weight: 500;">Escaneie o QR Code no app do banco</div>
            </div>
            <div style="font-size: 22px; font-weight: 800; color: #0284c7;">
              ${formattedTotal}
            </div>
          </div>

          <!-- Card do QR Code -->
          <div style="background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 16px; padding: 16px; display: inline-block; margin-bottom: 14px; box-shadow: inset 0 2px 6px rgba(0,0,0,0.02);">
            ${pixInfo.qrCodeBase64 ? `
              <img src="data:image/png;base64,${pixInfo.qrCodeBase64}" alt="QR Code Pix" style="width: 210px; height: 210px; display: block; border-radius: 8px; margin: 0 auto; background: white; padding: 6px;">
            ` : `
              <div style="width: 210px; height: 210px; display: flex; align-items: center; justify-content: center; background: white; border-radius: 8px; font-size: 12px; color: #64748b;">
                QR Code indisponível
              </div>
            `}
            <div style="margin-top: 8px; font-size: 11px; color: #059669; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <i class="fa-solid fa-bolt"></i> Liberação imediata após o pagamento
            </div>
          </div>

          <!-- Código Pix Copia e Cola -->
          <div style="text-align: left; margin-bottom: 14px;">
            <label style="font-size: 11px; font-weight: 700; color: #475569; display: block; margin-bottom: 4px;">
              Ou copie o código PIX Copia e Cola:
            </label>
            <div style="display: flex; gap: 6px;">
              <input type="text" readonly id="campo-pix-copia-cola" value="${pixInfo.qrCode}" style="flex: 1; padding: 10px 12px; font-size: 12px; font-family: monospace; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; color: #334155; outline: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              <button onclick="window.MercadoPagoPlugin.copyPixCopiaCola()" id="btn-copiar-pix-completo" style="background: #0284c7; color: white; border: none; padding: 10px 14px; border-radius: 10px; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; transition: all 0.2s;">
                <i class="fa-solid fa-copy"></i> Copiar
              </button>
            </div>
          </div>

          <!-- Status do Pagamento em Tempo Real -->
          <div id="mp-pix-status-box" style="padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; font-size: 13px; color: #1e40af; display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 14px;">
            <i class="fa-solid fa-circle-notch fa-spin" style="color: #0284c7;"></i>
            <span>Aguardando você pagar no app do banco...</span>
          </div>

          <div style="display: flex; gap: 8px;">
            <button onclick="window.MercadoPagoPlugin.closeModal()" style="flex: 1; padding: 10px; background: transparent; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 12px; font-weight: 600; color: #64748b; cursor: pointer;">
              Concluir Depois / Voltar ao Início
            </button>
          </div>
        </div>
      `;
    },

    copyPixCopiaCola: function () {
      const input = document.getElementById('campo-pix-copia-cola');
      if (!input) return;
      navigator.clipboard.writeText(input.value).then(() => {
        const btn = document.getElementById('btn-copiar-pix-completo');
        if (btn) {
          btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
          btn.style.background = '#059669';
          setTimeout(() => {
            btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copiar';
            btn.style.background = '#0284c7';
          }, 3000);
        }
      }).catch(() => {
        input.select();
        document.execCommand('copy');
      });
    },

    switchToCard: function () {
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (conteudo && this.currentOrder) {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.renderFormCartaoTransparente(conteudo, this.currentOrder);
      }
    },

    switchToPix: function () {
      if (this.currentOrder) {
        this.iniciarPixTransparente(this.currentOrder);
      }
    },

    // 2. FLUXO CARTÃO DE CRÉDITO TRANSPARENTE
    renderFormCartaoTransparente: function (container, orderData) {
      const formattedTotal = Number(orderData.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const totalNum = parseFloat(orderData.total);

      // Gerar opções de parcelas até 12x
      let opcoesParcelas = '';
      for (let i = 1; i <= 12; i++) {
        const valorParcela = (totalNum / i).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        opcoesParcelas += `<option value="${i}">${i}x de ${valorParcela} sem juros</option>`;
      }

      container.innerHTML = `
        <div>
          <!-- Seletor de Abas Transparente -->
          <div style="display: flex; gap: 6px; background: #f1f5f9; padding: 4px; border-radius: 12px; margin-bottom: 16px;">
            <button onclick="window.MercadoPagoPlugin.switchToPix()" style="flex: 1; padding: 8px; border: none; border-radius: 8px; font-weight: 600; font-size: 13px; background: transparent; color: #64748b; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <i class="fa-brands fa-pix" style="color: #32bcad;"></i> PIX Transparente
            </button>
            <button style="flex: 1; padding: 8px; border: none; border-radius: 8px; font-weight: 700; font-size: 13px; background: #ffffff; color: #0284c7; box-shadow: 0 2px 4px rgba(0,0,0,0.05); display: flex; align-items: center; justify-content: center; gap: 6px;">
              <i class="fa-solid fa-credit-card"></i> Cartão de Crédito
            </button>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; padding: 0 4px;">
            <div>
              <span style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700;">Pedido #${orderData.pedidoId}</span>
              <div style="font-size: 13px; color: #334155; font-weight: 500;">Pague com Cartão de Crédito no próprio site</div>
            </div>
            <div style="font-size: 22px; font-weight: 800; color: #0284c7;">
              ${formattedTotal}
            </div>
          </div>

          <form id="form-mp-cartao-transparente" onsubmit="window.MercadoPagoPlugin.submitCardPayment(event)" style="display: flex; flex-direction: column; gap: 12px;">
            <!-- Número do Cartão com detector de bandeira -->
            <div>
              <label style="font-size: 12px; font-weight: 700; color: #334155; display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>Número do Cartão</span>
                <span id="card-brand-indicator" style="font-size: 11px; color: #0284c7; font-weight: 600;"></span>
              </label>
              <div style="position: relative;">
                <input type="text" id="mp-card-number" placeholder="0000 0000 0000 0000" maxlength="19" required
                  oninput="window.MercadoPagoPlugin.formatCardNumber(this)"
                  style="width: 100%; box-sizing: border-box; padding: 10px 12px 10px 38px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; font-family: monospace;">
                <i class="fa-solid fa-credit-card" style="position: absolute; left: 12px; top: 12px; color: #94a3b8; font-size: 15px;"></i>
              </div>
            </div>

            <!-- Nome no Cartão -->
            <div>
              <label style="font-size: 12px; font-weight: 700; color: #334155; display: block; margin-bottom: 4px;">
                Nome Impresso no Cartão
              </label>
              <input type="text" id="mp-card-holder" placeholder="NOME COMO NO CARTAO" required
                style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; text-transform: uppercase;">
            </div>

            <!-- Validade e CVV -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div>
                <label style="font-size: 12px; font-weight: 700; color: #334155; display: block; margin-bottom: 4px;">
                  Validade (MM/AA)
                </label>
                <input type="text" id="mp-card-exp" placeholder="MM/AA" maxlength="5" required
                  oninput="window.MercadoPagoPlugin.formatExpiry(this)"
                  style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; font-family: monospace; text-align: center;">
              </div>
              <div>
                <label style="font-size: 12px; font-weight: 700; color: #334155; display: block; margin-bottom: 4px;">
                  Código CVV
                </label>
                <input type="password" id="mp-card-cvv" placeholder="123" maxlength="4" required
                  style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; font-family: monospace; text-align: center;">
              </div>
            </div>

            <!-- CPF do Titular e Parcelamento -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div>
                <label style="font-size: 12px; font-weight: 700; color: #334155; display: block; margin-bottom: 4px;">
                  CPF do Titular
                </label>
                <input type="text" id="mp-card-cpf" placeholder="000.000.000-00" maxlength="14" required
                  oninput="window.MercadoPagoPlugin.formatCPF(this)"
                  style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 13px; font-family: monospace;">
              </div>
              <div>
                <label style="font-size: 12px; font-weight: 700; color: #334155; display: block; margin-bottom: 4px;">
                  Parcelas
                </label>
                <select id="mp-card-installments" style="width: 100%; box-sizing: border-box; padding: 10px 8px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 12px; background: white; color: #334155;">
                  ${opcoesParcelas}
                </select>
              </div>
            </div>

            <div id="mp-card-error-msg" style="display: none; padding: 10px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; font-size: 12px; color: #b91c1c; text-align: left;"></div>

            <!-- Botão de Pagamento com Cartão -->
            <button type="submit" id="btn-submit-cartao-transparente"
              style="width: 100%; padding: 14px; background: #0284c7; color: white; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3); transition: all 0.2s;">
              <i class="fa-solid fa-lock"></i>
              <span>Pagar ${formattedTotal}</span>
            </button>

            <div style="font-size: 11px; color: #64748b; text-align: center; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <i class="fa-solid fa-shield-halved" style="color: #10b981;"></i>
              <span>Dados 100% criptografados &bull; Mercado Pago Oficial</span>
            </div>
          </form>
        </div>
      `;
    },

    // Formatação de Número do Cartão
    formatCardNumber: function (input) {
      let v = input.value.replace(/\D/g, '');
      let formatted = '';
      for (let i = 0; i < v.length; i++) {
        if (i > 0 && i % 4 === 0) formatted += ' ';
        formatted += v[i];
      }
      input.value = formatted;

      // Detectar bandeira
      const brandIndicator = document.getElementById('card-brand-indicator');
      if (brandIndicator) {
        if (/^4/.test(v)) brandIndicator.innerHTML = '<i class="fa-brands fa-cc-visa" style="font-size: 16px;"></i> Visa';
        else if (/^(5[1-5]|2[2-7])/.test(v)) brandIndicator.innerHTML = '<i class="fa-brands fa-cc-mastercard" style="font-size: 16px;"></i> Mastercard';
        else if (/^3[47]/.test(v)) brandIndicator.innerHTML = '<i class="fa-brands fa-cc-amex" style="font-size: 16px;"></i> Amex';
        else if (/^(606282|3841)/.test(v)) brandIndicator.innerHTML = 'Hipercard';
        else if (/^(40117[8-9]|438935|451416|457631|457632|504175|627780|636297|636368)/.test(v)) brandIndicator.innerHTML = 'Elo';
        else brandIndicator.innerHTML = '';
      }
    },

    formatExpiry: function (input) {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 2) {
        input.value = v.substring(0, 2) + '/' + v.substring(2, 4);
      } else {
        input.value = v;
      }
    },

    formatCPF: function (input) {
      let v = input.value.replace(/\D/g, '');
      if (v.length > 9) {
        input.value = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
      } else if (v.length > 6) {
        input.value = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
      } else if (v.length > 3) {
        input.value = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
      } else {
        input.value = v;
      }
    },

    // Submissão do Cartão Transparente
    submitCardPayment: async function (e) {
      e.preventDefault();
      const btn = document.getElementById('btn-submit-cartao-transparente');
      const errBox = document.getElementById('mp-card-error-msg');
      if (errBox) errBox.style.display = 'none';

      const num = document.getElementById('mp-card-number').value.replace(/\D/g, '');
      const holder = document.getElementById('mp-card-holder').value.trim();
      const exp = document.getElementById('mp-card-exp').value.split('/');
      const cvv = document.getElementById('mp-card-cvv').value.trim();
      const cpf = document.getElementById('mp-card-cpf').value.replace(/\D/g, '');
      const installments = document.getElementById('mp-card-installments').value;

      if (num.length < 13 || num.length > 19) {
        this.showCardError('Número do cartão inválido.');
        return;
      }
      if (!holder) {
        this.showCardError('Informe o nome impresso no cartão.');
        return;
      }
      if (exp.length !== 2 || !exp[0] || !exp[1]) {
        this.showCardError('Data de validade inválida (MM/AA).');
        return;
      }
      if (cvv.length < 3) {
        this.showCardError('Código CVV inválido.');
        return;
      }
      if (cpf.length !== 11) {
        this.showCardError('CPF do titular inválido (11 dígitos).');
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando Pagamento com Segurança...';
        btn.style.opacity = '0.8';
      }

      try {
        const cfg = this.getConfig();
        const payload = {
          pedidoId: this.currentOrder.pedidoId,
          total: this.currentOrder.total,
          forma: 'cartao',
          parcelas: parseInt(installments, 10),
          cardData: {
            numero: num,
            nomeTitular: holder,
            mesExpiracao: exp[0],
            anoExpiracao: exp[1],
            cvv: cvv,
            cpfTitular: cpf
          },
          cliente: {
            nome: holder,
            email: window.usuarioAtual?.email || 'cliente@lunocadoceria.com.br',
            cpf: cpf
          },
          customAccessToken: cfg.accessToken || '',
          origin: window.location.origin
        };

        const res = await fetch('/api/mercadopago/transparent-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.success) {
          if (data.status === 'approved') {
            // Atualizar status no Supabase para Confirmado
            try {
              if (typeof window.supabaseClient !== 'undefined') {
                await window.supabaseClient.from('pedidos').update({
                  status: 'Confirmado',
                  mercado_pago_id: String(data.paymentId),
                  mercado_pago_status: 'approved'
                }).eq('id', this.currentOrder.pedidoId);
              }
            } catch (dbErr) {
              console.warn('[MercadoPagoPlugin] Erro ao atualizar status do pedido:', dbErr);
            }

            this.renderSucessoAprovado({
              pedidoId: this.currentOrder.pedidoId,
              total: this.currentOrder.total,
              forma: 'cartao',
              paymentId: data.paymentId,
              cardLastFour: data.cardLastFour,
              installments: data.installments
            });
          } else if (data.status === 'in_process') {
            this.renderEmAnalise({
              pedidoId: this.currentOrder.pedidoId,
              total: this.currentOrder.total,
              paymentId: data.paymentId
            });
          } else {
            // Recusado
            this.showCardError('Cartão recusado pelo emissor: ' + (data.statusDetail || 'Verifique o limite ou dados informados.'));
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = '<i class="fa-solid fa-lock"></i> Tentar Novamente';
              btn.style.opacity = '1';
            }
          }
        } else {
          this.showCardError(data.error || 'Erro ao processar o cartão.');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-lock"></i> Tentar Novamente';
            btn.style.opacity = '1';
          }
        }
      } catch (err) {
        this.showCardError('Erro de conexão ao processar o cartão.');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-lock"></i> Tentar Novamente';
          btn.style.opacity = '1';
        }
      }
    },

    showCardError: function (msg) {
      const errBox = document.getElementById('mp-card-error-msg');
      if (errBox) {
        errBox.style.display = 'block';
        errBox.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + msg;
      }
    },

    // 3. MONITORAMENTO DE PIX EM TEMPO REAL
    startRealtimePolling: function (paymentId, pedidoId) {
      if (this.pollInterval) clearInterval(this.pollInterval);
      const startTime = Date.now();
      const maxTime = 20 * 60 * 1000; // 20 minutos

      this.pollInterval = setInterval(async () => {
        if (Date.now() - startTime > maxTime) {
          clearInterval(this.pollInterval);
          return;
        }

        try {
          const cfg = this.getConfig();
          // 1. Checar diretamente na API do Mercado Pago via endpoint local
          const res = await fetch(`/api/mercadopago/payment-status?id=${paymentId}&token=${encodeURIComponent(cfg.accessToken || '')}`);
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'approved') {
              clearInterval(this.pollInterval);

              // Atualizar Supabase se necessário
              try {
                if (typeof window.supabaseClient !== 'undefined') {
                  await window.supabaseClient.from('pedidos').update({
                    status: 'Confirmado',
                    mercado_pago_status: 'approved'
                  }).eq('id', pedidoId);
                }
              } catch (e) {}

              this.renderSucessoAprovado({
                pedidoId: pedidoId,
                total: this.currentOrder?.total || data.amount,
                forma: 'pix',
                paymentId: paymentId
              });
              return;
            }
          }

          // 2. Checar também via Supabase caso webhook tenha disparado antes
          if (typeof window.supabaseClient !== 'undefined') {
            const { data: pedido } = await window.supabaseClient
              .from('pedidos')
              .select('status, mercado_pago_status')
              .eq('id', pedidoId)
              .single();

            if (pedido && (pedido.status === 'Confirmado' || pedido.mercado_pago_status === 'approved')) {
              clearInterval(this.pollInterval);
              this.renderSucessoAprovado({
                pedidoId: pedidoId,
                total: this.currentOrder?.total,
                forma: 'pix',
                paymentId: paymentId
              });
            }
          }
        } catch (e) {
          // silencia erros momentâneos
        }
      }, 3000); // Polling a cada 3 segundos
    },

    // Tela de Pagamento Aprovado com Sucesso
    renderSucessoAprovado: function (info) {
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (!conteudo) return;

      const formattedTotal = Number(info.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      conteudo.innerHTML = `
        <div style="text-align: center; padding: 15px 5px;">
          <div style="width: 70px; height: 70px; border-radius: 50%; background: #ecfdf5; color: #059669; display: inline-flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 16px; box-shadow: 0 4px 15px rgba(5, 150, 105, 0.2);">
            <i class="fa-solid fa-check"></i>
          </div>
          <span style="display: inline-block; background: #d1fae5; color: #065f46; font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 20px; text-transform: uppercase; margin-bottom: 10px;">
            Pagamento Aprovado Instantaneamente
          </span>
          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 22px; font-weight: 800;">
            Pedido #${info.pedidoId} Confirmado!
          </h3>
          <p style="font-size: 14px; color: #475569; margin: 0 0 16px 0;">
            Valor pago: <strong style="color: #059669; font-size: 18px;">${formattedTotal}</strong>
          </p>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px; text-align: left; margin-bottom: 18px; font-size: 13px; color: #334155;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: #64748b;">Método:</span>
              <strong>${info.forma === 'pix' ? 'Pix Transparente' : 'Cartão de Crédito'}</strong>
            </div>
            ${info.cardLastFour ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <span style="color: #64748b;">Cartão:</span>
                <span>Final •••• ${info.cardLastFour} (${info.installments || 1}x)</span>
              </div>
            ` : ''}
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: #64748b;">Código MP:</span>
              <span style="font-family: monospace;">#${info.paymentId}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #64748b;">Status da Cozinha:</span>
              <span style="color: #0284c7; font-weight: 700;">Em Preparação</span>
            </div>
          </div>

          <button onclick="window.MercadoPagoPlugin.closeModal()" style="width: 100%; padding: 14px; background: #059669; color: white; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 12px rgba(5, 150, 105, 0.3);">
            <i class="fa-solid fa-cake-candles"></i> Acompanhar em "Minha Conta"
          </button>
        </div>
      `;
    },

    // Tela de Pagamento em Análise
    renderEmAnalise: function (info) {
      const conteudo = document.getElementById('modal-mp-conteudo');
      if (!conteudo) return;

      conteudo.innerHTML = `
        <div style="text-align: center; padding: 15px 5px;">
          <div style="width: 60px; height: 60px; border-radius: 50%; background: #fffbeb; color: #d97706; display: inline-flex; align-items: center; justify-content: center; font-size: 30px; margin-bottom: 14px;">
            <i class="fa-solid fa-clock"></i>
          </div>
          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 20px;">Pagamento em Análise</h3>
          <p style="font-size: 13px; color: #64748b; margin: 0 0 16px 0;">
            O Mercado Pago está analisando a transação do Pedido #${info.pedidoId}. Assim que for aprovado, seu pedido entrará em produção.
          </p>
          <button onclick="window.MercadoPagoPlugin.closeModal()" style="width: 100%; padding: 12px; background: #0284c7; color: white; border: none; border-radius: 10px; font-weight: 700; cursor: pointer;">
            Entendido, Voltar ao Início
          </button>
        </div>
      `;
    },

    // Fallback amigável caso não tenha Access Token configurado
    renderFallbackPix: function (container, info) {
      const { pedidoId, total, motivo } = info;
      const cfg = this.getConfig();
      const chavePix = cfg.chavePixFallback || 'lunocadoceria@gmail.com';
      const formattedTotal = Number(total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      container.innerHTML = `
        <div style="text-align: center;">
          <div style="display:inline-block; padding: 10px; background: #ecfdf5; border-radius: 50%; color: #059669; font-size: 26px; margin-bottom: 12px;">
            <i class="fa-brands fa-pix"></i>
          </div>
          <h3 style="margin: 0 0 6px 0; color: #0f172a; font-size: 19px;">Pagamento via Pix Manual</h3>
          <p style="font-size: 13px; color: #64748b; margin: 0 0 14px 0;">Pedido #${pedidoId} &bull; Total: <strong>${formattedTotal}</strong></p>

          <div style="background: #f8fafc; border: 1px dashed #cbd5e1; padding: 14px; border-radius: 12px; margin-bottom: 14px; text-align: left;">
            <span style="font-size: 11px; color: #64748b; display: block; margin-bottom: 4px; font-weight: 700;">CHAVE PIX (E-MAIL):</span>
            <div style="display: flex; gap: 8px; align-items: center;">
              <code id="texto-chave-pix-fallback" style="flex: 1; font-size: 13px; color: #0f172a; font-weight: 700; word-break: break-all;">${chavePix}</code>
              <button onclick="window.MercadoPagoPlugin.copyFallbackKey('${chavePix}')" id="btn-copy-fallback-pix"
                style="background: #059669; color: white; border: none; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;">
                Copiar
              </button>
            </div>
          </div>

          ${window.usuarioAtual?.nivel === 'admin' ? `
            <div style="background: #fffbeb; border: 1px solid #fef3c7; padding: 10px; border-radius: 8px; font-size: 11px; color: #92400e; margin-bottom: 14px; text-align: left;">
              <strong>Dica de Administrador:</strong> Configure o <em>Access Token do Mercado Pago</em> na aba de Configurações no Painel Admin para gerar o QR Code dinâmico com aprovação automática na tela.
            </div>
          ` : ''}

          <button onclick="window.MercadoPagoPlugin.closeModal()" style="width: 100%; padding: 12px; background: #0f172a; color: white; border: none; border-radius: 10px; font-weight: 700; cursor: pointer;">
            Concluir e Voltar ao Início
          </button>
        </div>
      `;
    },

    copyFallbackKey: function (key) {
      navigator.clipboard.writeText(key).then(() => {
        const btn = document.getElementById('btn-copy-fallback-pix');
        if (btn) {
          btn.innerHTML = 'Copiado!';
          setTimeout(() => { btn.innerHTML = 'Copiar'; }, 2000);
        }
      });
    },

    testToken: async function (token) {
      const tk = (token || this.getConfig().accessToken || '').trim();
      if (!tk) return { success: false, error: 'Access Token não informado.' };
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
    }
  };

  window.MercadoPagoPlugin = MercadoPagoPlugin;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MercadoPagoPlugin.init());
  } else {
    MercadoPagoPlugin.init();
  }
})(window, document);
