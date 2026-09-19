// ==========================================================================
// LUNOCA DOCERIA - Módulo de Checkout e Integração InfinitePay
// Suporta PIX instantâneo e Cartão de Crédito em até 12x
// ==========================================================================

const INFINITEPAY_STORAGE_KEY = 'lunoca_infinitepay_config';

function getInfinitePayConfig() {
    try {
        const saved = localStorage.getItem(INFINITEPAY_STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) {
        console.error('Erro ao ler config InfinitePay:', e);
    }
    return {
        handle: 'lunocadoceria',
        apiKey: '',
        chavePixFallback: 'lunocadoceria@gmail.com'
    };
}

function salvarInfinitePayConfig(cfg) {
    try {
        localStorage.setItem(INFINITEPAY_STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
        console.error('Erro ao salvar config InfinitePay:', e);
    }
}

async function iniciarPagamentoInfinitePay(pedidoId, total, itens, formaPagamento) {
    abrirModalInfinitePay();
    const conteudo = document.getElementById('modal-infinitepay-conteudo');
    if (!conteudo) return;

    conteudo.innerHTML = `
        <div style="text-align: center; padding: 25px 15px;">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 36px; color: #16a34a; margin-bottom: 15px;"></i>
            <h3 style="margin: 0 0 8px 0; color: #1e293b;">Gerando Pagamento InfinitePay</h3>
            <p style="margin: 0; font-size: 13px; color: #64748b;">Aguarde enquanto preparamos seu checkout seguro...</p>
        </div>
    `;

    const config = getInfinitePayConfig();
    let cleanHandle = (config.handle || 'lunocadoceria').trim();
    if (cleanHandle.startsWith('$')) {
        cleanHandle = cleanHandle.substring(1);
    }

    try {
        const payload = {
            pedidoId: pedidoId,
            total: total,
            items: itens || [],
            cliente: {
                nome: (typeof usuarioAtual !== 'undefined' && usuarioAtual) ? usuarioAtual.nome : 'Cliente Lunoca',
                email: (typeof usuarioAtual !== 'undefined' && usuarioAtual) ? usuarioAtual.email : 'contato@lunocadoceria.com.br'
            },
            forma: formaPagamento || 'pix',
            origin: window.location.origin,
            customHandle: cleanHandle,
            customApiKey: config.apiKey || ''
        };

        const res = await fetch('/api/infinitepay/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.url) {
            // Atualizar o link no Supabase se possível
            if (typeof supabaseClient !== 'undefined' && supabaseClient) {
                supabaseClient.from('pedidos').update({
                    infinitepay_link: data.url,
                    infinitepay_invoice_slug: data.invoice_slug || ''
                }).eq('id', pedidoId).then(() => {});
            }

            renderizarSucessoCheckoutInfinitePay(data.url, total, pedidoId, formaPagamento, cleanHandle);
        } else {
            // Fallback: usar link direto da InfinitePay ou chave Pix
            const directUrl = `https://infinitepay.io/pay/${cleanHandle}/${parseFloat(total).toFixed(2)}`;
            renderizarFallbackInfinitePay(pedidoId, total, cleanHandle, directUrl, config.chavePixFallback);
        }
    } catch (err) {
        console.warn('Erro ao chamar API InfinitePay, usando contingência:', err);
        const directUrl = `https://infinitepay.io/pay/${cleanHandle}/${parseFloat(total).toFixed(2)}`;
        renderizarFallbackInfinitePay(pedidoId, total, cleanHandle, directUrl, config.chavePixFallback);
    }
}

function renderizarSucessoCheckoutInfinitePay(checkoutUrl, total, pedidoId, formaPagamento, handle) {
    const conteudo = document.getElementById('modal-infinitepay-conteudo');
    if (!conteudo) return;

    const valorFormatado = parseFloat(total).toFixed(2).replace('.', ',');

    conteudo.innerHTML = `
        <div style="text-align: center; padding: 10px 5px;">
            <div style="display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; background: #ecfdf5; border-radius: 50%; color: #16a34a; font-size: 26px; margin-bottom: 12px; border: 2px solid #a7f3d0;">
                <i class="fa-solid fa-receipt"></i>
            </div>
            <h3 style="margin: 0 0 5px 0; color: #0f172a; font-size: 18px;">Pedido #${pedidoId} Registrado!</h3>
            <p style="margin: 0 0 16px 0; font-size: 13px; color: #64748b;">
                Pague com segurança via <strong>InfinitePay</strong> (PIX ou Cartão em até 12x)
            </p>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 16px;">
                <div style="font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: bold; letter-spacing: 0.5px;">Total do Pedido</div>
                <div style="font-size: 26px; font-weight: 800; color: #16a34a; margin-top: 4px;">R$ ${valorFormatado}</div>
                <div style="font-size: 11px; color: #059669; margin-top: 4px; display: inline-flex; align-items: center; gap: 4px; font-weight: 600;">
                    <i class="fa-solid fa-bolt"></i> Baixa automática instantânea
                </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px;">
                <a href="${checkoutUrl}" target="_blank" rel="noopener" style="text-decoration: none;">
                    <button style="width: 100%; padding: 14px; background: #000000; color: #ffffff; border: none; border-radius: 10px; font-size: 15px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                        <i class="fa-solid fa-credit-card"></i> Pagar Agora na InfinitePay <i class="fa-solid fa-arrow-up-right-from-square" style="font-size: 12px;"></i>
                    </button>
                </a>

                <button onclick="copiarTextoInfinitePay(this, '${checkoutUrl}')" style="width: 100%; padding: 10px; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;">
                    <i class="fa-regular fa-copy"></i> Copiar Link de Pagamento
                </button>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 10px;">
                <button onclick="avisarWhatsAppInfinitePay('${pedidoId}', '${total}', '${checkoutUrl}')" style="flex: 1; padding: 9px; background: #25d366; color: #fff; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                    <i class="fa-brands fa-whatsapp"></i> Avisar no WhatsApp
                </button>
                <button onclick="fecharModalInfinitePay()" style="flex: 1; padding: 9px; background: #e2e8f0; color: #475569; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;">
                    Concluir
                </button>
            </div>
        </div>
    `;
}

function renderizarFallbackInfinitePay(pedidoId, total, handle, directUrl, chavePix) {
    const conteudo = document.getElementById('modal-infinitepay-conteudo');
    if (!conteudo) return;

    const valorFormatado = parseFloat(total).toFixed(2).replace('.', ',');
    const chave = chavePix || 'lunocadoceria@gmail.com';

    conteudo.innerHTML = `
        <div style="text-align: center; padding: 10px 5px;">
            <div style="display: inline-flex; align-items: center; justify-content: center; width: 50px; height: 50px; background: #f0fdf4; border-radius: 50%; color: #16a34a; font-size: 24px; margin-bottom: 10px;">
                <i class="fa-solid fa-circle-check"></i>
            </div>
            <h3 style="margin: 0 0 5px 0; color: #0f172a; font-size: 17px;">Pedido #${pedidoId} Confirmado!</h3>
            <p style="margin: 0 0 14px 0; font-size: 12px; color: #64748b;">
                Efetue o pagamento via <strong>InfinitePay ($${handle})</strong> ou chave PIX:
            </p>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; margin-bottom: 14px;">
                <div style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: bold;">Valor a Pagar</div>
                <div style="font-size: 24px; font-weight: 800; color: #16a34a;">R$ ${valorFormatado}</div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;">
                <a href="${directUrl}" target="_blank" rel="noopener" style="text-decoration: none;">
                    <button style="width: 100%; padding: 12px; background: #000; color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Pagar pelo InfiniteLink ($${handle})
                    </button>
                </a>

                <div style="background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px;">
                    <span style="font-size: 11px; color: #64748b; display: block; margin-bottom: 4px;">Chave PIX da Loja:</span>
                    <strong style="font-size: 13px; color: #1e293b; word-break: break-all;">${chave}</strong>
                    <button onclick="copiarTextoInfinitePay(this, '${chave}')" style="margin-top: 6px; width: 100%; padding: 6px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 11px; cursor: pointer; font-weight: 600;">
                        <i class="fa-regular fa-copy"></i> Copiar Chave PIX
                    </button>
                </div>
            </div>

            <div style="display: flex; gap: 8px;">
                <button onclick="avisarWhatsAppInfinitePay('${pedidoId}', '${total}', '${directUrl}')" style="flex: 1; padding: 9px; background: #25d366; color: #fff; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;">
                    <i class="fa-brands fa-whatsapp"></i> WhatsApp
                </button>
                <button onclick="fecharModalInfinitePay()" style="flex: 1; padding: 9px; background: #e2e8f0; color: #475569; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;">
                    Fechar
                </button>
            </div>
        </div>
    `;
}

function abrirModalInfinitePay() {
    const modal = document.getElementById('modal-pagamento-infinitepay');
    if (modal) {
        modal.classList.add('active');
        modal.style.display = 'flex';
    }
}

function fecharModalInfinitePay() {
    const modal = document.getElementById('modal-pagamento-infinitepay');
    if (modal) {
        modal.classList.remove('active');
        modal.style.display = 'none';
    }
    if (typeof mostrarTela === 'function') {
        mostrarTela('menu-section');
    }
}

function copiarTextoInfinitePay(btn, texto) {
    navigator.clipboard.writeText(texto).then(() => {
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check" style="color:#16a34a;"></i> Copiado com sucesso!';
        setTimeout(() => { btn.innerHTML = originalHtml; }, 2500);
    }).catch(() => {
        alert('Texto: ' + texto);
    });
}

function avisarWhatsAppInfinitePay(pedidoId, total, linkPagamento) {
    const msg = `Olá Lunoca Doceria! Acabei de realizar o pedido #${pedidoId} no valor de R$ ${parseFloat(total).toFixed(2)}. Segue o link da InfinitePay: ${linkPagamento}`;
    const url = `https://wa.me/5511999999999?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
}
