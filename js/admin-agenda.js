// ==========================================================================
// LUNOCA DOCERIA - Módulo Administrativo: Fila de Produção & Agenda Operacional (Frente E)
// ==========================================================================

var agendaProducaoCache = null;
var agendaDataFiltroAtual = null;
var agendaModalidadeFiltroAtual = null;
var agendaPedidoObservacaoAtivoId = null;

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Carrega a agenda e a fila de produção para a data especificada
 */
async function carregarProducaoAdmin(dataForcada = null, modalidadeForcada = null) {
  const container = document.getElementById('producao-kanban-container');
  const barraCapacidade = document.getElementById('producao-barra-capacidade');
  if (!container) return;

  const inputData = document.getElementById('producao-filtro-data');
  const selectModalidade = document.getElementById('producao-filtro-modalidade');

  const hojeStr = new Date().toISOString().split('T')[0];
  const data = dataForcada || (inputData && inputData.value ? inputData.value : hojeStr);
  const modalidade = modalidadeForcada !== null ? modalidadeForcada : (selectModalidade ? selectModalidade.value : null);

  agendaDataFiltroAtual = data;
  agendaModalidadeFiltroAtual = modalidade || null;

  if (inputData && !inputData.value) inputData.value = data;

  container.innerHTML = `
    <div style="grid-column: 1 / -1; text-align:center; padding:40px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:12px; display:block;"></i>
      Carregando fila de produção e capacidade...
    </div>
  `;

  try {
    const { data: res, error } = await supabaseClient.rpc('obter_agenda_producao', {
      p_data_inicio: data,
      p_data_fim: data,
      p_status_operacional: null,
      p_modalidade: modalidade && modalidade !== 'todas' ? modalidade : null
    });

    if (error) throw error;
    if (!res || !res.success) {
      throw new Error(res?.error || 'Erro ao carregar agenda de produção.');
    }

    agendaProducaoCache = res;
    renderizarBarraCapacidadeProducao(res.capacidades?.[0]);
    renderizarFilaProducaoKanban(res.pedidos || []);
  } catch (err) {
    console.error('[Produção Admin] Erro ao carregar:', err);
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding:20px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b; text-align:center;">
        <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom:8px; display:block;"></i>
        <strong>Não foi possível carregar a produção:</strong> ${escapeHTML(err.message)}
        <div style="margin-top:12px;">
          <button onclick="carregarProducaoAdmin()" class="btn-primary" style="padding:6px 14px; font-size:12px; border-radius:8px;">
            <i class="fa-solid fa-rotate-right"></i> Tentar Novamente
          </button>
        </div>
      </div>
    `;
  }
}

/**
 * Renderiza o widget de capacidade diária
 */
function renderizarBarraCapacidadeProducao(cap) {
  const el = document.getElementById('producao-barra-capacidade');
  if (!el) return;

  if (!cap) {
    el.innerHTML = '';
    return;
  }

  const max = Number(cap.capacidade_maxima || 30);
  const ocup = Number(cap.pontos_ocupados || 0);
  const perc = Math.min(100, Number(cap.percentual_ocupado || 0));
  const status = cap.status_capacidade || 'normal';

  let corBarra = '#10b981'; // verde
  let textoStatus = 'Capacidade Disponível';
  let badgeCor = '#ecfdf5';
  let badgeTextoCor = '#065f46';

  if (status === 'proximo_limite') {
    corBarra = '#f59e0b'; // amarelo
    textoStatus = 'Próximo do Limite (≥80%)';
    badgeCor = '#fffbeb';
    badgeTextoCor = '#92400e';
  } else if (status === 'lotado') {
    corBarra = '#ea580c'; // laranja
    textoStatus = 'Capacidade Lotada (100%)';
    badgeCor = '#fff7ed';
    badgeTextoCor = '#9a3412';
  } else if (status === 'excedido') {
    corBarra = '#ef4444'; // vermelho
    textoStatus = 'Capacidade Excedida (>100%)';
    badgeCor = '#fef2f2';
    badgeTextoCor = '#991b1b';
  } else if (status === 'bloqueado') {
    corBarra = '#64748b';
    textoStatus = 'Data Bloqueada para Produção';
    badgeCor = '#f1f5f9';
    badgeTextoCor = '#334155';
  }

  el.innerHTML = `
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:16px; margin-bottom:18px; box-shadow:0 1px 3px rgba(0,0,0,0.02);">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-gauge-high" style="color:var(--primary); font-size:16px;"></i>
          <span style="font-size:14px; font-weight:800; color:#1e293b;">Carga Produtiva do Dia</span>
          <span style="font-size:11px; font-weight:700; padding:3px 10px; border-radius:12px; background:${badgeCor}; color:${badgeTextoCor};">
            ${textoStatus}
          </span>
        </div>
        <div style="font-size:13px; font-weight:700; color:#475569;">
          <strong style="color:#0f172a; font-size:16px;">${ocup.toFixed(1)}</strong> / ${max.toFixed(1)} pts (${perc.toFixed(1)}%)
        </div>
      </div>
      <div style="width:100%; height:10px; background:#f1f5f9; border-radius:8px; overflow:hidden;">
        <div style="height:100%; width:${perc}%; background:${corBarra}; border-radius:8px; transition:width 0.4s ease;"></div>
      </div>
      ${cap.motivo_bloqueio ? `
        <div style="margin-top:8px; font-size:12px; color:#b91c1c; display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-lock"></i> Motivo do bloqueio: ${escapeHTML(cap.motivo_bloqueio)}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Renderiza o quadro Kanban com as 3 colunas de produção
 */
function renderizarFilaProducaoKanban(pedidos) {
  const container = document.getElementById('producao-kanban-container');
  if (!container) return;

  if (!pedidos || pedidos.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding:40px; text-align:center; background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; color:#64748b;">
        <i class="fa-solid fa-cake-candles fa-3x" style="color:#cbd5e1; margin-bottom:12px; display:block;"></i>
        <h4 style="margin:0 0 6px; font-size:16px; color:#334155;">Nenhum pedido na fila para este dia</h4>
        <p style="margin:0; font-size:13px;">Selecione outra data ou utilize o botão de atualização.</p>
      </div>
    `;
    return;
  }

  // Segmentação por coluna operacional
  const filaAguardando = pedidos.filter(p => p.status_operacional === 'aguardando_producao');
  const filaEmProducao = pedidos.filter(p => p.status_operacional === 'em_producao');
  const filaProntoExpedicao = pedidos.filter(p => ['pronto', 'saiu_para_entrega', 'entregue'].includes(p.status_operacional));

  container.innerHTML = `
    <!-- COLUNA 1: Aguardando Preparo -->
    <div class="producao-coluna" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:14px; min-height:450px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid #cbd5e1;">
        <h4 style="margin:0; font-size:14px; color:#334155; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-clock" style="color:#f59e0b;"></i> Aguardando Preparo
        </h4>
        <span style="background:#e2e8f0; color:#475569; font-size:11px; font-weight:800; padding:2px 8px; border-radius:10px;">
          ${filaAguardando.length}
        </span>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${filaAguardando.length === 0
          ? '<p style="font-size:12px; color:#94a3b8; text-align:center; padding:20px 0;">Fila limpa</p>'
          : filaAguardando.map(p => renderizarCardCozinha(p, 'aguardando')).join('')}
      </div>
    </div>

    <!-- COLUNA 2: Em Produção -->
    <div class="producao-coluna" style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:14px; padding:14px; min-height:450px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid #93c5fd;">
        <h4 style="margin:0; font-size:14px; color:#1e40af; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-fire-burner" style="color:#2563eb;"></i> Na Cozinha (Em Preparo)
        </h4>
        <span style="background:#dbeafe; color:#1d4ed8; font-size:11px; font-weight:800; padding:2px 8px; border-radius:10px;">
          ${filaEmProducao.length}
        </span>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${filaEmProducao.length === 0
          ? '<p style="font-size:12px; color:#93c5fd; text-align:center; padding:20px 0;">Nenhum doce em produção agora</p>'
          : filaEmProducao.map(p => renderizarCardCozinha(p, 'em_producao')).join('')}
      </div>
    </div>

    <!-- COLUNA 3: Pronto & Expedição -->
    <div class="producao-coluna" style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:14px; padding:14px; min-height:450px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid #86efac;">
        <h4 style="margin:0; font-size:14px; color:#166534; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-box-open" style="color:#16a34a;"></i> Pronto & Expedição
        </h4>
        <span style="background:#dcfce7; color:#15803d; font-size:11px; font-weight:800; padding:2px 8px; border-radius:10px;">
          ${filaProntoExpedicao.length}
        </span>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${filaProntoExpedicao.length === 0
          ? '<p style="font-size:12px; color:#86efac; text-align:center; padding:20px 0;">Nenhum pedido finalizado ainda</p>'
          : filaProntoExpedicao.map(p => renderizarCardCozinha(p, 'expedicao')).join('')}
      </div>
    </div>
  `;
}

/**
 * Renderiza um card da cozinha sanitizado (SEM DADOS FINANCEIROS)
 */
function renderizarCardCozinha(p, coluna) {
  const isRetirada = (p.modalidade_entrega || 'retirada') === 'retirada';
  const horaStr = p.hora_entrega ? p.hora_entrega.substring(0, 5) : '--:--';
  const pontos = Number(p.pontos_producao || 0).toFixed(1);

  // Cores de prioridade
  const prioColors = {
    urgente: { bg: '#fee2e2', text: '#991b1b', border: '#f87171' },
    alta: { bg: '#ffedd5', text: '#9a3412', border: '#fb923c' },
    normal: { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' },
    baixa: { bg: '#f8fafc', text: '#64748b', border: '#e2e8f0' }
  };
  const prio = prioColors[p.prioridade] || prioColors.normal;

  // Itens formatados para cozinheiro
  const itensHtml = (p.itens || []).map(it => `
    <div style="padding:6px 0; border-bottom:1px dashed #f1f5f9; font-size:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:700; color:#1e293b;">${it.quantidade}x ${escapeHTML(it.produto_nome)}</span>
        ${it.pontos_producao ? `<span style="font-size:10px; color:#64748b;">(${Number(it.pontos_producao).toFixed(1)} pts)</span>` : ''}
      </div>
      ${it.opcoes && it.opcoes.length > 0 ? `
        <div style="padding-left:8px; font-size:11px; color:#64748b; margin-top:2px;">
          ${it.opcoes.map(op => `• ${escapeHTML(op.nome)}`).join('<br>')}
        </div>
      ` : ''}
      ${it.observacoes ? `
        <div style="padding-left:8px; font-size:11px; color:#d97706; margin-top:2px; font-style:italic;">
          Nota: ${escapeHTML(it.observacoes)}
        </div>
      ` : ''}
    </div>
  `).join('');

  // Notas de produção da equipe
  const notasHtml = (p.observacoes_producao || []).map(n => `
    <div style="background:#fefce8; border:1px solid #fef08a; border-radius:6px; padding:6px 8px; font-size:11px; color:#854d0e; margin-top:4px;">
      <strong>[${escapeHTML(n.categoria)}]</strong> ${escapeHTML(n.observacao)}
      <span style="font-size:10px; color:#a16207; display:block; margin-top:2px;">por ${escapeHTML(n.autor_nome || 'Equipe')}</span>
    </div>
  `).join('');

  return `
    <div class="card-cozinha" style="background:#ffffff; border-radius:12px; border:1px solid ${prio.border}; padding:14px; box-shadow:0 1px 4px rgba(0,0,0,0.04); position:relative;">
      <!-- Cabeçalho do Card -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:6px;">
        <div>
          <span style="font-size:13px; font-weight:800; color:#0f172a;">#${p.id}</span>
          <span style="font-size:12px; font-weight:700; color:#334155; margin-left:4px;">${escapeHTML(p.nome_cliente || 'Cliente')}</span>
        </div>
        <div style="display:flex; align-items:center; gap:4px;">
          <!-- Seletor Rápido de Prioridade -->
          <select onchange="alterarPrioridadeProducaoUI(${p.id}, this.value)" style="font-size:10px; font-weight:700; background:${prio.bg}; color:${prio.text}; border:1px solid ${prio.border}; border-radius:8px; padding:2px 4px; cursor:pointer;">
            <option value="baixa" ${p.prioridade === 'baixa' ? 'selected' : ''}>Baixa</option>
            <option value="normal" ${p.prioridade === 'normal' ? 'selected' : ''}>Normal</option>
            <option value="alta" ${p.prioridade === 'alta' ? 'selected' : ''}>Alta</option>
            <option value="urgente" ${p.prioridade === 'urgente' ? 'selected' : ''}>Urgente</option>
          </select>
        </div>
      </div>

      <!-- Informações de Entrega / Retirada e Carga -->
      <div style="display:flex; align-items:center; justify-content:space-between; background:#f8fafc; border-radius:8px; padding:6px 10px; margin-bottom:10px; font-size:11px;">
        <span style="display:flex; align-items:center; gap:6px; font-weight:700; color:${isRetirada ? '#0284c7' : '#059669'};">
          <i class="fa-solid ${isRetirada ? 'fa-store' : 'fa-motorcycle'}"></i>
          ${isRetirada ? 'Retirada na Loja' : 'Entrega em Domicílio'}
        </span>
        <span style="color:#475569; font-weight:700;">
          <i class="fa-regular fa-clock"></i> ${horaStr} • ${pontos} pts
        </span>
      </div>

      ${!isRetirada && p.endereco_entrega ? `
        <div style="font-size:11px; color:#64748b; margin-bottom:8px; line-height:1.3; background:#fff7ed; padding:4px 8px; border-radius:6px;">
          <i class="fa-solid fa-location-dot" style="color:#ea580c;"></i> ${escapeHTML(p.endereco_entrega)}
        </div>
      ` : ''}

      <!-- Lista de Itens do Pedido -->
      <div style="margin-bottom:10px;">
        ${itensHtml}
      </div>

      <!-- Observações do Cliente -->
      ${p.observacoes_cliente ? `
        <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:6px; padding:6px 8px; font-size:11px; color:#92400e; margin-bottom:8px;">
          <i class="fa-regular fa-message"></i> <strong>Cliente:</strong> ${escapeHTML(p.observacoes_cliente)}
        </div>
      ` : ''}

      <!-- Observações Internas da Cozinha -->
      <div style="margin-bottom:10px;">
        ${notasHtml}
      </div>

      <!-- Botão para Adicionar Observação -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px solid #f1f5f9;">
        <button onclick="abrirModalObservacaoProducao(${p.id})" style="background:none; border:none; color:#64748b; font-size:11px; cursor:pointer; display:flex; align-items:center; gap:4px; padding:4px 0;">
          <i class="fa-solid fa-plus-circle" style="color:var(--primary);"></i> Adicionar Nota
        </button>
      </div>

      <!-- Botões de Ação de 1 Clique Conforme a Etapa -->
      <div style="margin-top:10px; display:flex; gap:6px; flex-direction:column;">
        ${coluna === 'aguardando' ? `
          <button onclick="iniciarProducaoPedidoUI(${p.id})" class="btn-primary" style="width:100%; padding:8px; font-size:12px; border-radius:8px; font-weight:700; cursor:pointer; background:#2563eb; color:#fff; border:none; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fa-solid fa-fire-burner"></i> Iniciar Produção
          </button>
        ` : ''}

        ${coluna === 'em_producao' ? `
          <button onclick="marcarPedidoProntoUI(${p.id})" class="btn-primary" style="width:100%; padding:8px; font-size:12px; border-radius:8px; font-weight:700; cursor:pointer; background:#16a34a; color:#fff; border:none; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fa-solid fa-circle-check"></i> Marcar como Pronto
          </button>
        ` : ''}

        ${coluna === 'expedicao' ? `
          ${p.status_operacional === 'pronto' && isRetirada ? `
            <button onclick="confirmarEntregaRetiradaUI(${p.id})" class="btn-primary" style="width:100%; padding:8px; font-size:12px; border-radius:8px; font-weight:700; cursor:pointer; background:#0284c7; color:#fff; border:none; display:flex; align-items:center; justify-content:center; gap:6px;">
              <i class="fa-solid fa-hand-holding-heart"></i> Confirmar Retirada
            </button>
          ` : ''}

          ${p.status_operacional === 'pronto' && !isRetirada ? `
            <button onclick="marcarSaidaEntregaUI(${p.id})" class="btn-primary" style="width:100%; padding:8px; font-size:12px; border-radius:8px; font-weight:700; cursor:pointer; background:#ea580c; color:#fff; border:none; display:flex; align-items:center; justify-content:center; gap:6px;">
              <i class="fa-solid fa-truck-fast"></i> Despachar Entrega
            </button>
          ` : ''}

          ${p.status_operacional === 'saiu_para_entrega' ? `
            <div style="background:#fff7ed; color:#c2410c; padding:4px 8px; border-radius:6px; font-size:11px; text-align:center; font-weight:700; margin-bottom:4px;">
              <i class="fa-solid fa-motorcycle fa-bounce"></i> Em Trânsito
            </div>
            <button onclick="confirmarEntregaRetiradaUI(${p.id})" class="btn-primary" style="width:100%; padding:8px; font-size:12px; border-radius:8px; font-weight:700; cursor:pointer; background:#15803d; color:#fff; border:none; display:flex; align-items:center; justify-content:center; gap:6px;">
              <i class="fa-solid fa-house-circle-check"></i> Confirmar Entrega
            </button>
          ` : ''}

          ${p.status_operacional === 'entregue' ? `
            <div style="background:#ecfdf5; color:#065f46; padding:6px; border-radius:6px; font-size:12px; text-align:center; font-weight:800;">
              <i class="fa-solid fa-check-double"></i> Concluído
            </div>
          ` : ''}

          <!-- Ação rápida de WhatsApp integrada ao helper da Frente B -->
          ${p.cliente_telefone ? `
            <button onclick="notificarClientePedidoProntoUI(${p.id}, '${escapeHTML(p.cliente_telefone)}')" class="btn-outline" style="width:100%; padding:6px; font-size:11px; border-radius:8px; color:#16a34a; border-color:#86efac; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
              <i class="fa-brands fa-whatsapp"></i> Avisar no WhatsApp
            </button>
          ` : ''}
        ` : ''}
      </div>
    </div>
  `;
}

// ==========================================================================
// AÇÕES OPERACIONAIS (TRANSIÇÕES COM 1 CLIQUE)
// ==========================================================================

async function iniciarProducaoPedidoUI(pedidoId) {
  if (!confirm(`Iniciar produção do pedido #${pedidoId}?`)) return;
  try {
    const { data: res, error } = await supabaseClient.rpc('iniciar_producao_pedido', {
      p_pedido_id: pedidoId
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao iniciar produção.');

    mostrarToast(`Pedido #${pedidoId} em produção!`, 'sucesso');
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro iniciar_producao:', err);
    mostrarToast(err.message, 'erro');
  }
}

async function marcarPedidoProntoUI(pedidoId) {
  if (!confirm(`Marcar pedido #${pedidoId} como pronto na cozinha?`)) return;
  try {
    const { data: res, error } = await supabaseClient.rpc('marcar_pedido_pronto', {
      p_pedido_id: pedidoId
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao marcar pedido pronto.');

    mostrarToast(`Pedido #${pedidoId} pronto para expedição!`, 'sucesso');
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro marcar_pronto:', err);
    mostrarToast(err.message, 'erro');
  }
}

async function marcarSaidaEntregaUI(pedidoId) {
  if (!confirm(`Despachar pedido #${pedidoId} para entrega em domicílio?`)) return;
  try {
    const { data: res, error } = await supabaseClient.rpc('marcar_saida_entrega', {
      p_pedido_id: pedidoId
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao despachar entrega.');

    mostrarToast(`Pedido #${pedidoId} saiu para entrega!`, 'sucesso');
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro marcar_saida_entrega:', err);
    mostrarToast(err.message, 'erro');
  }
}

async function confirmarEntregaRetiradaUI(pedidoId) {
  if (!confirm(`Confirmar entrega/retirada definitiva do pedido #${pedidoId}?`)) return;
  try {
    const { data: res, error } = await supabaseClient.rpc('confirmar_entrega_retirada', {
      p_pedido_id: pedidoId
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao concluir entrega.');

    mostrarToast(`Pedido #${pedidoId} finalizado com sucesso!`, 'sucesso');
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro confirmar_entrega_retirada:', err);
    mostrarToast(err.message, 'erro');
  }
}

async function alterarPrioridadeProducaoUI(pedidoId, prio) {
  try {
    const { data: res, error } = await supabaseClient.rpc('definir_prioridade_producao', {
      p_pedido_id: pedidoId,
      p_prioridade: prio
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao definir prioridade.');

    mostrarToast(`Prioridade do pedido #${pedidoId} alterada para ${prio}.`, 'info');
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro definir_prioridade:', err);
    mostrarToast(err.message, 'erro');
  }
}

// ==========================================================================
// OBSERVAÇÕES DE PRODUÇÃO (MODAL & TRIGGER DE BLOQUEIO DE DELETE)
// ==========================================================================

function abrirModalObservacaoProducao(pedidoId) {
  agendaPedidoObservacaoAtivoId = pedidoId;
  const modal = document.getElementById('modal-observacao-producao');
  const spanId = document.getElementById('obs-prod-pedido-id');
  const txt = document.getElementById('obs-prod-texto');
  if (spanId) spanId.innerText = '#' + pedidoId;
  if (txt) txt.value = '';
  if (modal) modal.style.display = 'flex';
}

function fecharModalObservacaoProducao() {
  agendaPedidoObservacaoAtivoId = null;
  const modal = document.getElementById('modal-observacao-producao');
  if (modal) modal.style.display = 'none';
}

async function salvarObservacaoProducaoUI() {
  if (!agendaPedidoObservacaoAtivoId) return;
  const txt = document.getElementById('obs-prod-texto');
  const cat = document.getElementById('obs-prod-categoria');
  const texto = txt ? txt.value.trim() : '';
  const categoria = cat ? cat.value : 'geral';

  if (!texto || texto.length < 2) {
    mostrarToast('Digite o conteúdo da observação para a equipe.', 'aviso');
    return;
  }

  try {
    const { data: res, error } = await supabaseClient.rpc('adicionar_observacao_producao', {
      p_pedido_id: agendaPedidoObservacaoAtivoId,
      p_observacao: texto,
      p_categoria: categoria
    });
    if (error) throw error;
    if (!res || !res.success) throw new Error(res?.error || 'Erro ao adicionar observação.');

    mostrarToast('Observação de produção registrada!', 'sucesso');
    fecharModalObservacaoProducao();
    await carregarProducaoAdmin(agendaDataFiltroAtual, agendaModalidadeFiltroAtual);
  } catch (err) {
    console.error('[Produção] Erro salvar observação:', err);
    mostrarToast(err.message, 'erro');
  }
}

// ==========================================================================
// NOTIFICAÇÃO VIA WHATSAPP (INTEGRAÇÃO CANÔNICA FRENTE B)
// ==========================================================================

function notificarClientePedidoProntoUI(pedidoId, telefoneRaw) {
  if (typeof window.abrirModalComunicacaoWhatsApp === 'function') {
    window.abrirModalComunicacaoWhatsApp({ tipo: 'PEDIDO_PRONTO', pedidoId: pedidoId });
    return;
  }

  // Fallback seguro
  const norm = (typeof window.normalizarTelefoneE164 === 'function')
    ? window.normalizarTelefoneE164(telefoneRaw)
    : telefoneRaw.replace(/\D/g, '');

  const msg = `Olá! Seu pedido #${pedidoId} na Lunoca Doceria está pronto! 🍰`;
  const url = `https://wa.me/${norm}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Expõe helpers no escopo global
window.carregarProducaoAdmin = carregarProducaoAdmin;
window.iniciarProducaoPedidoUI = iniciarProducaoPedidoUI;
window.marcarPedidoProntoUI = marcarPedidoProntoUI;
window.marcarSaidaEntregaUI = marcarSaidaEntregaUI;
window.confirmarEntregaRetiradaUI = confirmarEntregaRetiradaUI;
window.alterarPrioridadeProducaoUI = alterarPrioridadeProducaoUI;
window.abrirModalObservacaoProducao = abrirModalObservacaoProducao;
window.fecharModalObservacaoProducao = fecharModalObservacaoProducao;
window.salvarObservacaoProducaoUI = salvarObservacaoProducaoUI;
window.notificarClientePedidoProntoUI = notificarClientePedidoProntoUI;
