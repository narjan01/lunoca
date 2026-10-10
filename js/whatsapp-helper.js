// ==========================================================================
// LUNOCA DOCERIA - HELPER UNIFICADO DE WHATSAPP & COMUNICAÇÃO COM O CLIENTE
// ==========================================================================
// 1. Normalização rigorosa E.164 (valida DDDs 11-99 e 9º dígito sem inferência cega).
// 2. Geração canônica de deep links wa.me.
// 3. Modal unificado com preview imutável, cópia e abertura auditada (status = link_aberto).
// ==========================================================================

export function normalizarTelefoneE164(telefoneRaw) {
  if (!telefoneRaw) return null;
  const digits = String(telefoneRaw).replace(/\D/g, '');

  if (digits.length < 10 || digits.length > 13) {
    return null;
  }

  // Com DDI 55
  if (digits.startsWith('55')) {
    if (digits.length === 12) {
      const ddd = parseInt(digits.substring(2, 4), 10);
      if (ddd >= 11 && ddd <= 99) return digits;
    } else if (digits.length === 13) {
      const ddd = parseInt(digits.substring(2, 4), 10);
      const nono = digits.charAt(4);
      if (ddd >= 11 && ddd <= 99 && nono === '9') return digits;
    }
    return null;
  }

  // Sem DDI (nacional Brasil)
  if (digits.length === 10) {
    const ddd = parseInt(digits.substring(0, 2), 10);
    if (ddd >= 11 && ddd <= 99) return `55${digits}`;
  } else if (digits.length === 11) {
    const ddd = parseInt(digits.substring(0, 2), 10);
    const nono = digits.charAt(2);
    if (ddd >= 11 && ddd <= 99 && nono === '9') return `55${digits}`;
  }

  return null;
}

export function formatarTelefoneVisual(e164) {
  if (!e164 || e164.length < 12) return e164 || '-';
  const num = e164.startsWith('55') ? e164.substring(2) : e164;
  const ddd = num.substring(0, 2);
  if (num.length === 11) {
    return `(${ddd}) ${num.substring(2, 7)}-${num.substring(7)}`;
  } else if (num.length === 10) {
    return `(${ddd}) ${num.substring(2, 6)}-${num.substring(6)}`;
  }
  return e164;
}

export function gerarLinkWhatsApp({ telefone, mensagem }) {
  const norm = normalizarTelefoneE164(telefone);
  if (!norm) {
    throw new Error('Telefone do cliente é inválido ou incompleto para WhatsApp.');
  }
  return `https://wa.me/${norm}?text=${encodeURIComponent(mensagem || '')}`;
}

export async function abrirModalComunicacaoWhatsApp({ tipo, orcamentoId = null, pedidoId = null }) {
  if (typeof supabaseClient === 'undefined') {
    alert('Erro: Conexão com o banco não inicializada.');
    return;
  }

  // Exibe loading ou feedback
  const previewRes = await supabaseClient.rpc('obter_preview_comunicacao', {
    p_tipo: tipo,
    p_orcamento_id: orcamentoId,
    p_pedido_id: pedidoId
  });

  if (previewRes.error || !previewRes.data || previewRes.data.success === false) {
    const msg = previewRes.data?.error || previewRes.error?.message || 'Erro ao gerar mensagem de comunicação.';
    alert(`Não foi possível preparar o WhatsApp: ${msg}`);
    return;
  }

  const preview = previewRes.data;
  const telVisual = formatarTelefoneVisual(preview.telefone);
  const waLink = gerarLinkWhatsApp({ telefone: preview.telefone, mensagem: preview.mensagem });

  // Cria ou reutiliza container do modal
  let modalEl = document.getElementById('modal-whatsapp-comunicacao');
  if (!modalEl) {
    modalEl = document.createElement('div');
    modalEl.id = 'modal-whatsapp-comunicacao';
    modalEl.className = 'modal-overlay';
    modalEl.style.cssText = `
      position: fixed; inset: 0; background: rgba(15,23,42,0.6); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; z-index: 9999;
    `;
    document.body.appendChild(modalEl);
  }

  modalEl.innerHTML = `
    <div style="background: white; border-radius: 16px; max-width: 540px; width: 92%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; animation: popIn 0.2s ease-out;">
      <div style="background: #0f172a; color: white; padding: 18px 24px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <i class="fa-brands fa-whatsapp" style="font-size: 24px; color: #22c55e;"></i>
          <div>
            <h3 style="margin: 0; font-size: 16px; font-weight: 600;">Comunicação WhatsApp</h3>
            <span style="font-size: 12px; color: #94a3b8;">${escapeHtml(preview.tipo)}</span>
          </div>
        </div>
        <button id="btn-fechar-modal-wa" style="background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
      </div>

      <div style="padding: 24px;">
        <div style="margin-bottom: 16px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;">
          <div style="font-size: 12px; color: #64748b; font-weight: 500; margin-bottom: 4px;">DESTINATÁRIO</div>
          <div style="font-size: 15px; font-weight: 600; color: #0f172a;">
            ${escapeHtml(preview.cliente_nome || 'Cliente')} • <span style="color: #2563eb;">${escapeHtml(telVisual)}</span>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <div style="font-size: 12px; color: #64748b; font-weight: 500; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>MENSAGEM CANÔNICA</span>
            <span style="color: #16a34a; font-size: 11px;"><i class="fa-solid fa-lock"></i> Dados validados pelo servidor</span>
          </div>
          <textarea id="txt-wa-preview-msg" readonly style="width: 100%; height: 160px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-family: inherit; font-size: 13px; line-height: 1.5; color: #334155; background: #fdfdfd; resize: none; box-sizing: border-box;">${escapeHtml(preview.mensagem)}</textarea>
        </div>

        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="btn-copiar-wa-msg" style="padding: 10px 16px; border-radius: 10px; border: 1px solid #cbd5e1; background: white; color: #334155; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <i class="fa-regular fa-copy"></i> Copiar Mensagem
          </button>
          <button id="btn-abrir-wa-link" style="padding: 10px 20px; border-radius: 10px; border: none; background: #22c55e; color: white; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(34,197,94,0.3);">
            <i class="fa-brands fa-whatsapp"></i> Abrir WhatsApp
          </button>
        </div>
      </div>
    </div>
  `;

  modalEl.style.display = 'flex';

  // Fechar
  document.getElementById('btn-fechar-modal-wa').onclick = () => {
    modalEl.style.display = 'none';
  };

  // Copiar
  document.getElementById('btn-copiar-wa-msg').onclick = async () => {
    try {
      await navigator.clipboard.writeText(preview.mensagem);
      const btn = document.getElementById('btn-copiar-wa-msg');
      btn.innerHTML = '<i class="fa-solid fa-check" style="color: #16a34a;"></i> Copiado!';
      setTimeout(() => {
        btn.innerHTML = '<i class="fa-regular fa-copy"></i> Copiar Mensagem';
      }, 2000);
    } catch {
      alert('Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.');
    }
  };

  // Abrir WhatsApp -> registra link_aberto no banco de forma auditável
  document.getElementById('btn-abrir-wa-link').onclick = async () => {
    const btn = document.getElementById('btn-abrir-wa-link');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Abrindo...';

    try {
      await supabaseClient.rpc('registrar_comunicacao_cliente', {
        p_tipo: tipo,
        p_orcamento_id: orcamentoId,
        p_pedido_id: pedidoId,
        p_canal: 'whatsapp_link',
        p_status: 'link_aberto'
      });
    } catch (err) {
      console.warn('[WhatsApp] Erro ao registrar abertura de link:', err);
    }

    window.open(waLink, '_blank', 'noopener,noreferrer');
    modalEl.style.display = 'none';
  };
}

function escapeHtml(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

if (typeof window !== 'undefined') {
  window.normalizarTelefoneE164 = normalizarTelefoneE164;
  window.gerarLinkWhatsApp = gerarLinkWhatsApp;
  window.abrirModalComunicacaoWhatsApp = abrirModalComunicacaoWhatsApp;
}
