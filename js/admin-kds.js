// ==============================================================================
// LUNOCA DOCERIA - KDS DE PRODUÇÃO EM TEMPO REAL (BANCADA & PRAÇAS)
// ==============================================================================
// Frente 038: Kitchen Display System ergonômico para bancadas e telas touchscreen.
// - Subordinação estrita à máquina de estados canônica do pedido
// - Subscrição Supabase Realtime nas tabelas KDS + reconciliação periódica (30s)
// - Ergonomia de bancada: botões >= 48px, alto contraste, modo fullscreen
// - Áudio suave via Web Audio API gerenciado no cliente (1 tom por atraso)
// ==============================================================================

import { supabase } from './supabase.js';

let kdsState = {
  cards: [],
  pracaFiltro: 'TODAS',
  realtimeSubscription: null,
  reconcileTimer: null,
  relogioTimer: null,
  isFullscreen: false,
  alertasJaEmitidos: new Set(),
  audioCtx: null
};

// ------------------------------------------------------------------------------
// SINTETIZADOR WEB AUDIO API (SOM SUAVE DE TRANSIÇÃO PARA ATRASO)
// ------------------------------------------------------------------------------
function emitirAlertaSonoroSuave() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    if (!kdsState.audioCtx) {
      kdsState.audioCtx = new AudioContext();
    }

    if (kdsState.audioCtx.state === 'suspended') {
      kdsState.audioCtx.resume();
    }

    const ctx = kdsState.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    // Frequência suave: acorde Ré Maior suave (587.33 Hz)
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880.00, ctx.currentTime + 0.18);

    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.36);
  } catch (err) {
    console.warn('[KDS Audio] Navegador bloqueou áudio não iniciado por gesto:', err);
  }
}

// ------------------------------------------------------------------------------
// CARREGAR E RECONCILIAR PAINEL DO KDS
// ------------------------------------------------------------------------------
export async function carregarPainelKds(praca = null) {
  try {
    if (praca !== null) {
      kdsState.pracaFiltro = praca;
    }

    const filtroParam = kdsState.pracaFiltro === 'TODAS' ? null : kdsState.pracaFiltro;
    const { data, error } = await supabase.rpc('kds_obter_painel', {
      p_praca_filtro: filtroParam
    });

    if (error) throw error;
    if (!data || !data.success) {
      throw new Error(data?.error || 'Falha ao carregar painel KDS');
    }

    kdsState.cards = data.cards || [];
    verificarAlertasDeAtraso();
    renderizarPainelKds();
  } catch (err) {
    console.error('[KDS] Erro ao carregar painel:', err);
    const container = document.getElementById('kds-cards-container');
    if (container && kdsState.cards.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
          <h3 style="margin-bottom: 8px;">Falha na conexão do KDS</h3>
          <p style="margin-bottom: 16px;">${err.message}</p>
          <button class="kds-action-btn" onclick="window.carregarPainelKds()" style="background: #dc2626; color: #fff; padding: 12px 24px; min-height: 48px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Tentar Novamente</button>
        </div>
      `;
    }
  }
}

// ------------------------------------------------------------------------------
// VERIFICAÇÃO DE SLA E ALERTAS DE ATRASO
// ------------------------------------------------------------------------------
function verificarAlertasDeAtraso() {
  let novoAtrasoDetectado = false;

  for (const card of kdsState.cards) {
    for (const item of (card.itens || [])) {
      if (item.atrasado) {
        const chaveAlerta = `${item.kds_item_id}_${item.minutos_atraso >= 1 ? Math.floor(item.minutos_atraso) : 'atrasado'}`;
        if (!kdsState.alertasJaEmitidos.has(chaveAlerta)) {
          kdsState.alertasJaEmitidos.add(chaveAlerta);
          novoAtrasoDetectado = true;
        }
      }
    }
  }

  if (novoAtrasoDetectado) {
    emitirAlertaSonoroSuave();
  }
}

// ------------------------------------------------------------------------------
// RENDERIZAÇÃO DO KDS (DESIGN ERGONÔMICO DE BANCADA)
// ------------------------------------------------------------------------------
function renderizarPainelKds() {
  const container = document.getElementById('kds-cards-container');
  if (!container) return;

  const totalPedidosSpan = document.getElementById('kds-total-pedidos');
  if (totalPedidosSpan) {
    totalPedidosSpan.textContent = `${kdsState.cards.length} pedido(s) em produção`;
  }

  if (kdsState.cards.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 60px 20px; text-align: center; color: #64748b; background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px;">
        <div style="font-size: 48px; margin-bottom: 12px;">🍰</div>
        <h3 style="font-size: 20px; font-weight: 600; color: #334155; margin-bottom: 6px;">Bancada de Confeitaria Livre</h3>
        <p style="font-size: 15px;">Nenhum pedido aguardando produção para a praça selecionada (${kdsState.pracaFiltro}).</p>
      </div>
    `;
    return;
  }

  container.innerHTML = kdsState.cards.map(card => {
    const isUrgente = card.prioridade_urgencia;
    const horaEntrega = card.hora_entrega ? card.hora_entrega.substring(0, 5) : '—';
    const dataEntrega = card.data_entrega || '';

    // Itens da rota
    const itensHtml = (card.itens || []).map(item => {
      const isAtrasado = item.atrasado;
      const slaMin = item.sla_etapa_minutos || 0;
      const tempoSeg = item.tempo_etapa_segundos || 0;
      const minDecorridos = Math.floor(tempoSeg / 60);
      const segDecorridos = tempoSeg % 60;
      const tempoFmt = `${String(minDecorridos).padStart(2, '0')}:${String(segDecorridos).padStart(2, '0')}`;
      const slaFmt = `${String(slaMin).padStart(2, '0')}:00`;

      const pracaDisplay = item.estagio_atual === 'AGUARDANDO' 
        ? `<span style="background: #e2e8f0; color: #475569; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">AGUARDANDO ➔ ${item.proxima_etapa}</span>`
        : `<span style="background: #dbeafe; color: #1e40af; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 700;">PRAÇA: ${item.praca_atual}</span>`;

      const botaoTexto = item.estagio_atual === 'AGUARDANDO'
        ? `INICIAR NA PRAÇA ${item.proxima_etapa}`
        : item.proxima_etapa === 'PRONTO'
          ? 'CONCLUIR ITEM (➔ PRONTO)'
          : `AVANÇAR ➔ ${item.proxima_etapa}`;

      const proximoEstagioArg = item.estagio_atual === 'AGUARDANDO'
        ? item.proxima_etapa
        : item.proxima_etapa;

      let briefingHtml = '';
      const isBriefingBloqueado = item.briefing_status === 'PENDENTE_REVISAO';
      const isBriefingRejeitado = item.briefing_status === 'REJEITADO';
      const isBriefingAjuste = item.briefing_status === 'AJUSTE_SOLICITADO';
      const bloqueioProducao = isBriefingBloqueado || isBriefingRejeitado || isBriefingAjuste;

      if (Array.isArray(item.personalizacoes) && item.personalizacoes.length > 0) {
        let statusBadge = '';
        if (isBriefingBloqueado) {
          statusBadge = `
            <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:6px; margin-bottom:6px;">
              <span style="color:#b45309; font-weight:700; font-size:11px; display:block; margin-bottom:4px;">
                <i class="fa-solid fa-triangle-exclamation"></i> Briefing Pendente de Revisão
              </span>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" onclick="window.kdsRevisarBriefing(${item.pedido_item_id}, 'APROVADO')" style="background:#16a34a; color:#fff; border:none; border-radius:4px; font-size:11px; padding:3px 8px; font-weight:600; cursor:pointer;">
                  <i class="fa-solid fa-check"></i> Aprovar
                </button>
                <button type="button" onclick="window.kdsRevisarBriefing(${item.pedido_item_id}, 'AJUSTE_SOLICITADO')" style="background:#d97706; color:#fff; border:none; border-radius:4px; font-size:11px; padding:3px 8px; font-weight:600; cursor:pointer;">
                  <i class="fa-solid fa-comments"></i> Pedir Ajuste
                </button>
                <button type="button" onclick="window.kdsRevisarBriefing(${item.pedido_item_id}, 'REJEITADO')" style="background:#dc2626; color:#fff; border:none; border-radius:4px; font-size:11px; padding:3px 8px; font-weight:600; cursor:pointer;">
                  <i class="fa-solid fa-xmark"></i> Rejeitar
                </button>
              </div>
            </div>
          `;
        } else if (item.briefing_status === 'APROVADO') {
          statusBadge = `<span style="background:#dcfce7; color:#166534; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-block; margin-bottom:4px;"><i class="fa-solid fa-circle-check"></i> Briefing Aprovado</span>`;
        } else if (isBriefingAjuste) {
          statusBadge = `
            <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:4px 8px; margin-bottom:4px;">
              <span style="color:#b45309; font-weight:700; font-size:10.5px; display:block;"><i class="fa-solid fa-comments"></i> Ajuste Solicitado ao Cliente</span>
              <button type="button" onclick="window.kdsRevisarBriefing(${item.pedido_item_id}, 'APROVADO')" style="background:#16a34a; color:#fff; border:none; border-radius:4px; font-size:10px; padding:2px 6px; font-weight:600; cursor:pointer; margin-top:3px;">
                <i class="fa-solid fa-check"></i> Aprovar Ajuste
              </button>
            </div>
          `;
        } else if (isBriefingRejeitado) {
          statusBadge = `<span style="background:#fee2e2; color:#991b1b; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; display:inline-block; margin-bottom:4px;"><i class="fa-solid fa-circle-xmark"></i> Briefing Rejeitado</span>`;
        }

        const pzLinhas = item.personalizacoes.map(p => {
          let valStr = '';
          if (Array.isArray(p.valor)) {
            valStr = p.valor.map(v => typeof v === 'object' ? (v.nome_original || 'Arquivo') : v).join(', ');
          } else if (typeof p.valor === 'object' && p.valor !== null) {
            valStr = JSON.stringify(p.valor);
          } else {
            valStr = String(p.valor || '');
          }
          return `<div style="font-size:11.5px; color:#334155; margin-bottom:2px;"><strong>${escapeHTML(p.label)}:</strong> ${escapeHTML(valStr)}</div>`;
        }).join('');

        const btnRefHtml = item.arquivos_count > 0 ? `
          <button type="button" onclick="window.abrirModalBriefingKds(${item.pedido_item_id})" style="background:#fdf2f8; border:1px solid #fbcfe8; color:#be185d; border-radius:6px; font-size:11px; font-weight:600; padding:3px 8px; margin-top:4px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
            <i class="fa-solid fa-images"></i> Fotos de Referência (${item.arquivos_count})
          </button>
        ` : '';

        briefingHtml = `
          <div style="background:#fdf2f8; border:1px solid #fce7f3; border-radius:6px; padding:6px 10px; margin:6px 0;">
            ${statusBadge}
            <div style="font-size:11px; font-weight:700; color:#be185d; margin-bottom:3px;"><i class="fa-solid fa-wand-magic-sparkles"></i> Detalhes da Personalização:</div>
            ${pzLinhas}
            ${btnRefHtml}
          </div>
        `;
      }

      let botaoAvancoHtml = '';
      if (bloqueioProducao) {
        botaoAvancoHtml = `
          <button 
            type="button"
            class="kds-btn-avancar"
            data-kds-item-id="${item.kds_item_id}"
            disabled
            style="width: 100%; min-height: 48px; font-size: 13px; font-weight: 700; background: ${isBriefingRejeitado ? '#ef4444' : isBriefingAjuste ? '#f59e0b' : '#94a3b8'}; color: #ffffff; border: none; border-radius: 6px; cursor: not-allowed; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <span>${isBriefingRejeitado ? '⛔' : isBriefingAjuste ? '💬' : '🔒'}</span> 
            ${isBriefingRejeitado ? 'Briefing Rejeitado' : isBriefingAjuste ? 'Aguardando Ajustes do Cliente' : 'Briefing Pendente de Aprovação'}
          </button>
        `;
      } else {
        botaoAvancoHtml = `
          <button 
            type="button"
            class="kds-btn-avancar"
            data-kds-item-id="${item.kds_item_id}"
            data-proximo-estagio="${proximoEstagioArg}"
            onclick="window.kdsAvancarItem('${item.kds_item_id}', '${proximoEstagioArg}')"
            style="width: 100%; min-height: 48px; font-size: 14px; font-weight: 700; background: ${isAtrasado ? '#dc2626' : '#2563eb'}; color: #ffffff; border: none; border-radius: 6px; cursor: pointer; transition: background 0.15s; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <span>➔</span> ${botaoTexto}
          </button>
        `;
      }

      return `
        <div class="kds-item-row ${isAtrasado ? 'kds-item-atrasado' : ''}" style="padding: 12px; border: 1px solid ${isAtrasado ? '#fca5a5' : '#e2e8f0'}; border-radius: 8px; background: ${isAtrasado ? '#fff1f2' : '#ffffff'}; margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <div>
              <strong style="font-size: 15px; color: #0f172a;">${item.quantidade}× ${item.produto_nome}</strong>
              <div style="margin-top: 4px;">${pracaDisplay}</div>
            </div>
            <div style="text-align: right;">
              <span style="font-family: monospace; font-size: 14px; font-weight: 700; color: ${isAtrasado ? '#b91c1c' : '#334155'};">
                ⏱ ${tempoFmt} / ${slaFmt}
              </span>
              ${isAtrasado ? `<div style="font-size: 11px; font-weight: 800; color: #dc2626; margin-top: 2px;">⚠ ATRASADO +${item.minutos_atraso}m</div>` : ''}
            </div>
          </div>
          ${briefingHtml}
          ${item.observacoes_item ? `<div style="font-size: 12px; color: #64748b; background: #f8fafc; padding: 4px 8px; border-radius: 4px; margin-bottom: 8px;">Obs: ${item.observacoes_item}</div>` : ''}
          ${botaoAvancoHtml}
        </div>
      `;
    }).join('');

    return `
      <div class="kds-card ${isUrgente ? 'kds-card-urgente' : ''}" style="background: #ffffff; border: 2px solid ${isUrgente ? '#f59e0b' : '#cbd5e1'}; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); display: flex; flex-direction: column; overflow: hidden;">
        <!-- Cabeçalho do Card -->
        <div style="background: ${isUrgente ? '#fffbeb' : '#f1f5f9'}; padding: 12px 16px; border-bottom: 1px solid ${isUrgente ? '#fde68a' : '#e2e8f0'}; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-size: 18px; font-weight: 800; color: #0f172a;">#${card.pedido_id}</span>
            ${isUrgente ? `<span style="background: #f59e0b; color: #fff; font-size: 11px; font-weight: 800; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">⚡ URGENTE</span>` : ''}
          </div>
          <div style="font-size: 13px; font-weight: 600; color: #475569;">
            Previsto: <strong style="color: #0f172a;">${horaEntrega}</strong> (${card.modalidade_entrega || 'Retirada'})
          </div>
        </div>

        <!-- Dados do Cliente e Pedido -->
        <div style="padding: 10px 16px; background: #fafafa; border-bottom: 1px solid #f1f5f9; font-size: 13px; color: #475569; display: flex; justify-content: space-between; align-items: center;">
          <div>Cliente: <strong style="color: #1e293b;">${card.cliente_nome || 'Cliente Balcão'}</strong></div>
          <button 
            type="button"
            onclick="window.kdsMarcarUrgencia(${card.pedido_id})"
            title="Marcar Urgência"
            style="background: none; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; color: #64748b; cursor: pointer;">
            ⚡ Priorizar
          </button>
        </div>

        ${card.observacoes_cozinha ? `
          <div style="padding: 6px 16px; background: #fffbeb; font-size: 12px; color: #92400e; border-bottom: 1px solid #fef3c7;">
            ${card.observacoes_cozinha}
          </div>
        ` : ''}

        <!-- Lista de Itens do KDS -->
        <div style="padding: 12px; flex: 1;">
          ${itensHtml}
        </div>

        <!-- Rodapé do Card -->
        <div style="padding: 8px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; display: flex; justify-content: space-between;">
          <span>Status: <strong>${card.status_operacional_pedido}</strong></span>
          <span>SLA Estágio Total: ${card.sla_total_minutos}m</span>
        </div>
      </div>
    `;
  }).join('');
}

// ------------------------------------------------------------------------------
// AVANÇAR ITEM NO KDS (RPC CANÔNICA COM auth.uid())
// ------------------------------------------------------------------------------
export async function kdsAvancarItem(kdsItemId, proximoEstagio) {
  try {
    const btn = document.querySelector(`[data-kds-item-id="${kdsItemId}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Processando...';
    }

    const { data, error } = await supabase.rpc('kds_avancar_item', {
      p_kds_item_id: kdsItemId,
      p_proximo_estagio: proximoEstagio
    });

    if (error) throw error;
    if (!data || !data.success) {
      throw new Error(data?.error || 'Não foi possível avançar o item no KDS');
    }

    // Recarregar imediatamente o painel
    await carregarPainelKds();
  } catch (err) {
    console.error('[KDS] Erro ao avançar item:', err);
    alert('Erro ao avançar item no KDS: ' + err.message);
    await carregarPainelKds();
  }
}

// ------------------------------------------------------------------------------
// MARCAR URGÊNCIA NO PEDIDO
// ------------------------------------------------------------------------------
export async function kdsMarcarUrgencia(pedidoId) {
  try {
    const motivo = prompt('Motivo da urgência prioritária (opcional):');
    const { data, error } = await supabase.rpc('kds_marcar_urgencia', {
      p_pedido_id: pedidoId,
      p_motivo: motivo || null
    });

    if (error) throw error;
    if (!data || !data.success) {
      throw new Error(data?.error || 'Falha ao marcar urgência');
    }

    await carregarPainelKds();
  } catch (err) {
    console.error('[KDS] Erro ao marcar urgência:', err);
    alert('Erro: ' + err.message);
  }
}

// ------------------------------------------------------------------------------
// MODO TELA CHEIA (KDS FULLSCREEN ERGONÔMICO)
// ------------------------------------------------------------------------------
export function alternarKdsFullscreen() {
  const container = document.getElementById('admin-tab-kds');
  if (!container) return;

  if (!document.fullscreenElement) {
    container.requestFullscreen().then(() => {
      kdsState.isFullscreen = true;
      document.body.classList.add('kds-fullscreen-active');
      atualizarBotaoFullscreen(true);
    }).catch(err => {
      console.warn('[KDS] Erro ao entrar em tela cheia:', err);
    });
  } else {
    document.exitFullscreen().then(() => {
      kdsState.isFullscreen = false;
      document.body.classList.remove('kds-fullscreen-active');
      atualizarBotaoFullscreen(false);
    }).catch(() => {});
  }
}

function atualizarBotaoFullscreen(ativo) {
  const btn = document.getElementById('btn-kds-fullscreen');
  if (btn) {
    btn.textContent = ativo ? '🗗 Sair da Tela Cheia' : '⛶ Tela Cheia (Bancada)';
  }
}

// ------------------------------------------------------------------------------
// INICIALIZAÇÃO DA ABA KDS & SUBSCRIÇÃO REALTIME
// ------------------------------------------------------------------------------
export function inicializarKds() {
  // Bind nos botões de filtro de praça
  const filterBtns = document.querySelectorAll('[data-kds-praca]');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      filterBtns.forEach(b => b.classList.remove('active-tab', 'active-filter'));
      btn.classList.add('active-tab', 'active-filter');
      const praca = btn.getAttribute('data-kds-praca');
      carregarPainelKds(praca);
    });
  });

  const btnFullscreen = document.getElementById('btn-kds-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', alternarKdsFullscreen);
  }

  // Listener para saída de fullscreen pelo teclado (ESC)
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      kdsState.isFullscreen = false;
      document.body.classList.remove('kds-fullscreen-active');
      atualizarBotaoFullscreen(false);
    }
  });

  // Configuração de subscrição Supabase Realtime
  iniciarRealtimeKds();

  // Reconciliação periódica a cada 30 segundos
  if (kdsState.reconcileTimer) clearInterval(kdsState.reconcileTimer);
  kdsState.reconcileTimer = setInterval(() => {
    carregarPainelKds();
  }, 30000);

  // Atualização cronométrica visual local a cada 10 segundos
  if (kdsState.relogioTimer) clearInterval(kdsState.relogioTimer);
  kdsState.relogioTimer = setInterval(() => {
    verificarAlertasDeAtraso();
    renderizarPainelKds();
  }, 10000);

  // Primeiro carregamento
  carregarPainelKds('TODAS');
}

function iniciarRealtimeKds() {
  try {
    if (kdsState.realtimeSubscription) {
      supabase.removeChannel(kdsState.realtimeSubscription);
    }

    kdsState.realtimeSubscription = supabase
      .channel('kds_bancada_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedido_producao_kds' }, () => {
        carregarPainelKds();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedido_item_producao_kds' }, () => {
        carregarPainelKds();
      })
      .subscribe((status) => {
        console.log('[KDS Realtime] Status da conexão:', status);
      });
  } catch (err) {
    console.warn('[KDS Realtime] Falha ao conectar Realtime (fallback ativo):', err);
  }
}

let kdsInicializado = false;
export function carregarKdsAdmin() {
  if (!kdsInicializado) {
    kdsInicializado = true;
    inicializarKds();
  } else {
    carregarPainelKds();
  }
}

// Expor funções globais para acesso pelos botões HTML
window.carregarPainelKds = carregarPainelKds;
window.carregarKdsAdmin = carregarKdsAdmin;
window.kdsAvancarItem = kdsAvancarItem;
window.kdsMarcarUrgencia = kdsMarcarUrgencia;
window.alternarKdsFullscreen = alternarKdsFullscreen;
window.inicializarKds = inicializarKds;

// ------------------------------------------------------------------------------
// MODAL DE BRIEFING & REFERÊNCIAS VISUAIS NO KDS (FRENTE 043)
// ------------------------------------------------------------------------------
async function abrirModalBriefingKds(pedidoItemId) {
  const modal = document.getElementById('modal-briefing-kds');
  const conteudo = document.getElementById('modal-briefing-conteudo');
  if (!modal || !conteudo) return;

  conteudo.innerHTML = '<p style="color:#64748b; font-size:13px; text-align:center; padding:20px;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando briefing e referências visuais...</p>';
  modal.style.display = 'flex';

  try {
    const { data: res, error } = await supabaseClient
      .rpc('obter_briefing_item', { p_pedido_item_id: pedidoItemId });

    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Briefing não encontrado.');

    let pzHtml = '';
    if (Array.isArray(res.personalizacoes) && res.personalizacoes.length > 0) {
      pzHtml = res.personalizacoes.map(p => {
        let valStr = '';
        if (Array.isArray(p.valor)) {
          valStr = p.valor.map(v => typeof v === 'object' ? (v.nome_original || 'Arquivo') : v).join(', ');
        } else if (typeof p.valor === 'object' && p.valor !== null) {
          valStr = JSON.stringify(p.valor);
        } else {
          valStr = String(p.valor || '');
        }
        return `
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 12px; margin-bottom:6px;">
            <div style="font-size:11px; font-weight:600; color:#64748b;">${escapeHTML(p.label)} (${escapeHTML(p.codigo)})</div>
            <div style="font-size:13px; font-weight:700; color:#1e293b; margin-top:2px;">${escapeHTML(valStr)}</div>
          </div>
        `;
      }).join('');
    }

    let fotosHtml = '';
    if (Array.isArray(res.arquivos) && res.arquivos.length > 0) {
      const fotosPromises = res.arquivos.map(async arq => {
        let signedUrl = '';
        try {
          const { data: sData } = await supabaseClient.storage
            .from('pedido-referencias')
            .createSignedUrl(arq.storage_path, 3600);
          signedUrl = sData?.signedUrl || '';
        } catch (_) {}

        return `
          <div style="text-align:center;">
            <a href="${signedUrl || '#'}" target="_blank" rel="noopener noreferrer" style="display:block; border:1px solid #cbd5e1; border-radius:10px; overflow:hidden; background:#000;">
              <img src="${signedUrl}" alt="${escapeHTML(arq.nome_original)}" style="width:100%; max-height:220px; object-fit:contain; display:block;">
            </a>
            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">${escapeHTML(arq.nome_original)}</span>
          </div>
        `;
      });
      const fotosArr = await Promise.all(fotosPromises);
      fotosHtml = `
        <div style="margin-top:14px;">
          <h4 style="font-size:13px; font-weight:700; color:#334155; margin-bottom:8px;"><i class="fa-solid fa-camera"></i> Fotos Anexadas pelo Cliente (${res.arquivos.length}):</h4>
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:12px;">
            ${fotosArr.join('')}
          </div>
        </div>
      `;
    } else {
      fotosHtml = '<p style="color:#94a3b8; font-size:12px; font-style:italic; margin-top:10px;">Nenhuma foto anexada.</p>';
    }

    conteudo.innerHTML = `
      <h3 style="margin-top:0; color:var(--text-dark); font-size:18px;">
        <i class="fa-solid fa-wand-magic-sparkles" style="color:var(--primary);"></i> Briefing: ${escapeHTML(res.produto_nome)}
      </h3>
      <div style="margin-bottom:12px;">
        <span style="font-size:12px; color:#64748b;">Status do Briefing: </span>
        <strong style="color:var(--primary); font-size:12px;">${escapeHTML(res.briefing_status)}</strong>
      </div>
      <div>${pzHtml}</div>
      ${fotosHtml}
      <div style="text-align:right; margin-top:16px;">
        <button type="button" onclick="fecharModalBriefingKds()" class="btn-primary" style="padding:6px 16px;">Fechar</button>
      </div>
    `;
  } catch (err) {
    conteudo.innerHTML = `
      <p style="color:#dc2626; font-size:13px;">Erro ao carregar briefing: ${escapeHTML(err.message)}</p>
      <div style="text-align:right; margin-top:12px;">
        <button type="button" onclick="fecharModalBriefingKds()" class="btn-primary" style="padding:6px 14px;">Fechar</button>
      </div>
    `;
  }
}

function fecharModalBriefingKds() {
  const modal = document.getElementById('modal-briefing-kds');
  if (modal) modal.style.display = 'none';
}

async function kdsAprovarBriefing(pedidoItemId, aprovado) {
  let motivo = null;
  if (!aprovado) {
    motivo = prompt('Por favor, informe o motivo da rejeição do briefing:');
    if (!motivo || !motivo.trim()) {
      alert('É necessário fornecer um motivo para rejeitar o briefing.');
      return;
    }
  }

  try {
    const { data, error } = await supabaseClient.rpc('aprovar_briefing_item', {
      p_pedido_item_id: pedidoItemId,
      p_aprovado: aprovado,
      p_motivo: motivo
    });

    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Falha na atualização.');

    alert(aprovado ? '✅ Briefing aprovado com sucesso!' : '⚠ Briefing rejeitado.');
    if (typeof window.carregarPainelKds === 'function') {
      await window.carregarPainelKds();
    }
  } catch (err) {
    alert('Erro ao atualizar status do briefing: ' + err.message);
  }
}

async function kdsRevisarBriefing(pedidoItemId, decisao) {
  let motivo = null;
  if (decisao === 'AJUSTE_SOLICITADO') {
    motivo = prompt('Descreva quais ajustes ou esclarecimentos o cliente deve fornecer:');
    if (!motivo || !motivo.trim()) {
      alert('É necessário fornecer uma mensagem de orientação para o cliente.');
      return;
    }
  } else if (decisao === 'REJEITADO') {
    motivo = prompt('Por favor, informe o motivo da rejeição do briefing:');
    if (!motivo || !motivo.trim()) {
      alert('É necessário fornecer um motivo para rejeitar o briefing.');
      return;
    }
  }

  try {
    const { data, error } = await supabaseClient.rpc('revisar_briefing_item', {
      p_pedido_item_id: pedidoItemId,
      p_decisao: decisao,
      p_motivo: motivo
    });

    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Falha na atualização.');

    const msgSucesso = decisao === 'APROVADO' 
      ? '✅ Briefing aprovado! Produção liberada.' 
      : decisao === 'AJUSTE_SOLICITADO'
      ? '💬 Solicitação de ajuste registrada com sucesso!'
      : '⛔ Briefing rejeitado.';

    alert(msgSucesso);
    if (typeof window.carregarPainelKds === 'function') {
      await window.carregarPainelKds();
    }
  } catch (err) {
    alert('Erro ao revisar briefing: ' + err.message);
  }
}

window.abrirModalBriefingKds = abrirModalBriefingKds;
window.fecharModalBriefingKds = fecharModalBriefingKds;
window.kdsAprovarBriefing = kdsAprovarBriefing;
window.kdsRevisarBriefing = kdsRevisarBriefing;
