// ==========================================================================
// LUNOCA DOCERIA - MÓDULO DE OPERAÇÃO DIÁRIA & CONFECTIONERY OS (ETAPA 2)
// ==========================================================================
// Centraliza:
// 1. Dashboard "Tela Hoje" (Métricas contábeis e Timeline do dia)
// 2. Central de Encomendas Tridimensional com filtros e ações rápidas
// 3. Modal de Nova Encomenda Rápida (Balcão / WhatsApp / Telefone)
// 4. Modal de Registro de Pagamento de Saldo
// 5. Modal de Reagendamento com validação de capacidade
// 6. Integração WhatsApp 1-Clique
// 7. Revisão Financeira (holds expirados com pagamento / pagamento tardio sem vaga ou estoque)
//    -> Modal de resolução administrativa via RPC resolver_revisao_encomenda_admin
// ==========================================================================

let filtroCentralEncomendasAtual = 'todas';
let termoBuscaCentralEncomendas = '';
let listaEncomendasCentralCache = [];
let debounceBuscaClientesTimer = null;
let carrinhoNovaEncomendaItens = [];
let produtoSelecionadoNovaEncomenda = null;
let produtosCatalogoCache = [];
let opcoesCatalogoCache = [];
let mesOffsetAgenda = 0;

// --------------------------------------------------------------------------
// 1. TELA "HOJE" - DASHBOARD OPERACIONAL EM TEMPO REAL
// --------------------------------------------------------------------------
async function carregarDashboardHoje() {
  const containerMetricas = document.getElementById('hoje-metricas-grid');
  const containerTimeline = document.getElementById('hoje-timeline-lista');
  const alertContainer = document.getElementById('hoje-alertas-container');

  if (containerTimeline) {
    containerTimeline.innerHTML = '<div style="text-align:center; padding:30px; color:#888;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">Carregando operação de hoje...</p></div>';
  }

  try {
    // 1.1 Consulta métricas consolidadas via RPC do ledger contábil
    const { data: metricas, error: errMetricas } = await supabaseClient.rpc('obter_resumo_operacao_hoje');
    if (errMetricas) {
      console.warn('[Dashboard Hoje] Erro na RPC obter_resumo_operacao_hoje:', errMetricas);
    }

    if (containerMetricas && metricas && metricas.success) {
      document.getElementById('metric-encomendas-qtd').innerText = metricas.encomendas_hoje_qtd || 0;
      document.getElementById('metric-entregas-split').innerText = `${metricas.entregas_hoje_qtd || 0} entregas • ${metricas.retiradas_hoje_qtd || 0} retiradas`;
      document.getElementById('metric-valor-hoje').innerText = `R$ ${parseFloat(metricas.valor_encomendas_hoje || 0).toFixed(2).replace('.', ',')}`;
      document.getElementById('metric-saldo-hoje').innerText = `R$ ${parseFloat(metricas.saldo_encomendas_hoje || 0).toFixed(2).replace('.', ',')}`;
      
      const elCaixa = document.getElementById('metric-caixa-hoje');
      if (elCaixa) {
        elCaixa.innerText = `R$ ${parseFloat(metricas.caixa_liquido_hoje || 0).toFixed(2).replace('.', ',')}`;
        const subCaixa = document.getElementById('metric-caixa-sub');
        if (subCaixa) {
          subCaixa.innerText = `+R$ ${parseFloat(metricas.recebimentos_caixa_hoje || 0).toFixed(2).replace('.', ',')} | -R$ ${parseFloat(metricas.estornos_caixa_hoje || 0).toFixed(2).replace('.', ',')} estornos`;
        }
      }

      // Alertas Operacionais
      if (alertContainer) {
        let alertasHtml = '';
        if (metricas.pendentes_sinal_qtd > 0) {
          alertasHtml += `
            <div class="alerta-operacional aviso" style="margin-bottom:12px; background:#fffbeb; border:1px solid #fde68a; border-left:4px solid #f59e0b; padding:10px 14px; border-radius:8px; font-size:13px; color:#92400e; display:flex; align-items:center; justify-content:space-between;">
              <span><i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i> <strong>Atenção:</strong> Há <strong>${metricas.pendentes_sinal_qtd}</strong> encomenda(s) de hoje aguardando confirmação de sinal!</span>
              <button onclick="filtrarCentralEncomendas('pendente_sinal')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-color:#d97706; color:#b45309;">Ver Pendentes</button>
            </div>`;
        }
        if (metricas.revisao_financeira_qtd > 0) {
          alertasHtml += `
            <div class="alerta-operacional urgente" style="margin-bottom:12px; background:#fef2f2; border:1px solid #fecaca; border-left:4px solid #dc2626; padding:10px 14px; border-radius:8px; font-size:13px; color:#991b1b; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
              <span><i class="fa-solid fa-circle-exclamation" style="margin-right:8px;"></i> <strong>Revisão financeira:</strong> <strong>${metricas.revisao_financeira_qtd}</strong> encomenda(s) com valor recebido e prazo/vaga/estoque comprometidos aguardam decisão da administração.</span>
              <button onclick="filtrarCentralEncomendas('revisao')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-color:#dc2626; color:#b91c1c;">Resolver agora</button>
            </div>`;
        }
        alertContainer.innerHTML = alertasHtml;
      }
    }

    // 1.2 Busca encomendas do dia ordenadas por hora de entrega
    const hojeStr = metricas?.data_referencia || (new Date()).toLocaleDateString('en-CA');
    const { data: pedidosHoje, error: errPedidos } = await supabaseClient
      .from('pedidos')
      .select('*, clientes:cliente_id_rel(nome, telefone, telefone_normalizado)')
      .eq('data_entrega', hojeStr)
      .neq('status_comercial', 'cancelado')
      .order('hora_entrega', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });

    if (errPedidos) throw errPedidos;

    if (!pedidosHoje || pedidosHoje.length === 0) {
      if (containerTimeline) {
        containerTimeline.innerHTML = `
          <div style="text-align:center; padding:40px 20px; background:#fff; border-radius:12px; border:1px dashed #e2e8f0; color:#64748b;">
            <i class="fa-regular fa-calendar-check fa-3x" style="color:#cbd5e1; margin-bottom:12px;"></i>
            <h4 style="margin:0 0 6px 0; color:#334155;">Nenhuma encomenda agendada para hoje!</h4>
            <p style="margin:0 0 15px 0; font-size:13px;">O dia está livre ou todas as encomendas foram atendidas.</p>
            <button onclick="abrirModalNovaEncomenda()" class="btn-primary" style="padding:8px 16px; font-size:13px;"><i class="fa-solid fa-plus"></i> Lançar Nova Encomenda</button>
          </div>`;
      }
      return;
    }

    // Renderiza linha do tempo de hoje
    let htmlTimeline = '<div class="timeline-operacao-container" style="display:flex; flex-direction:column; gap:12px;">';
    for (const p of pedidosHoje) {
      htmlTimeline += renderizarCardEncomendaHtml(p, true);
    }
    htmlTimeline += '</div>';

    if (containerTimeline) {
      containerTimeline.innerHTML = htmlTimeline;
    }

  } catch (err) {
    console.error('[Dashboard Hoje] Erro fatal:', err);
    if (containerTimeline) {
      containerTimeline.innerHTML = `<div style="text-align:center; padding:20px; color:#ef4444;"><p>Erro ao carregar dados operacionais: ${err.message}</p></div>`;
    }
  }
}

// --------------------------------------------------------------------------
// 2. CENTRAL DE ENCOMENDAS (VISÃO TRIDIMENSIONAL & FILTROS)
// --------------------------------------------------------------------------
async function carregarCentralEncomendas(filtro = null) {
  if (filtro) filtroCentralEncomendasAtual = filtro;
  const container = document.getElementById('lista-pedidos-admin');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center; padding:30px; color:#888;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">Carregando encomendas...</p></div>';

  try {
    let query = supabaseClient
      .from('pedidos')
      .select('*, clientes:cliente_id_rel(nome, telefone, telefone_normalizado)')
      .order('data_entrega', { ascending: false })
      .order('id', { ascending: false });

    const hojeStr = (new Date()).toLocaleDateString('en-CA');
    const dAmanha = new Date();
    dAmanha.setDate(dAmanha.getDate() + 1);
    const amanhaStr = dAmanha.toLocaleDateString('en-CA');

    // Aplicação dos filtros rápidos
    switch (filtroCentralEncomendasAtual) {
      case 'hoje':
        query = query.eq('data_entrega', hojeStr).neq('status_comercial', 'cancelado');
        break;
      case 'amanha':
        query = query.eq('data_entrega', amanhaStr).neq('status_comercial', 'cancelado');
        break;
      case 'pendente_sinal':
        query = query.eq('status_comercial', 'aguardando_confirmacao').gt('sinal_minimo', 0);
        break;
      case 'em_producao':
        query = query.eq('status_operacional', 'em_producao').neq('status_comercial', 'cancelado');
        break;
      case 'prontos':
        query = query.eq('status_operacional', 'pronto').neq('status_comercial', 'cancelado');
        break;
      case 'concluidos':
        query = query.in('status_comercial', ['concluido', 'confirmado']).in('status_operacional', ['entregue', 'retirado']);
        break;
      case 'revisao':
        query = query.eq('requer_revisao_financeira', true).neq('status_comercial', 'cancelado');
        break;
      default:
        // 'todas'
        break;
    }

    const { data: pedidos, error } = await query.limit(100);
    if (error) throw error;

    listaEncomendasCentralCache = pedidos || [];

    // Filtro client-side por termo de busca se houver
    let filtrados = listaEncomendasCentralCache;
    if (termoBuscaCentralEncomendas && termoBuscaCentralEncomendas.trim() !== '') {
      const termo = termoBuscaCentralEncomendas.toLowerCase().trim();
      filtrados = filtrados.filter(p => 
        String(p.id).includes(termo) ||
        (p.nome_cliente && p.nome_cliente.toLowerCase().includes(termo)) ||
        (p.telefone_cliente && p.telefone_cliente.includes(termo)) ||
        (p.itens && p.itens.toLowerCase().includes(termo))
      );
    }

    // Atualiza botões de filtro pills
    document.querySelectorAll('.filtro-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-filtro') === filtroCentralEncomendasAtual);
    });

    if (filtrados.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px 20px; background:#fff; border-radius:12px; border:1px dashed #cbd5e1; color:#64748b;">
          <i class="fa-solid fa-filter fa-2x" style="color:#cbd5e1; margin-bottom:10px;"></i>
          <p style="margin:0; font-weight:600;">Nenhuma encomenda encontrada para este filtro.</p>
        </div>`;
      return;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:12px;">';
    for (const p of filtrados) {
      html += renderizarCardEncomendaHtml(p, false);
    }
    html += '</div>';

    container.innerHTML = html;

  } catch (err) {
    console.error('[Central Encomendas] Erro:', err);
    container.innerHTML = `<div style="text-align:center; padding:20px; color:#ef4444;"><p>Erro ao carregar central de encomendas: ${err.message}</p></div>`;
  }
}

function filtrarCentralEncomendas(filtro) {
  mudarTabAdmin('pedidos');
  carregarCentralEncomendas(filtro);
}

function buscarCentralEncomendasInput(e) {
  termoBuscaCentralEncomendas = e.target.value;
  carregarCentralEncomendas();
}

// --------------------------------------------------------------------------
// 3. RENDERIZADOR DO CARD DE ENCOMENDA (ESTILO NOOTY TRIDIMENSIONAL)
// --------------------------------------------------------------------------
function renderizarCardEncomendaHtml(p, isTimeline = false) {
  const dtaEntrega = p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '--/--/----';
  const horaEntrega = p.hora_entrega ? p.hora_entrega.substring(0, 5) : 'Sem hora';
  const tel = p.telefone_cliente || p.clientes?.telefone || '';
  const total = parseFloat(p.total || 0).toFixed(2).replace('.', ',');
  const saldo = parseFloat(p.saldo || 0).toFixed(2).replace('.', ',');
  const pago = parseFloat(p.valor_pago || 0).toFixed(2).replace('.', ',');

  // Badges Tridimensionais
  const badgeComercial = obterBadgeComercial(p.status_comercial);
  const badgeFinanceiro = obterBadgeFinanceiro(p.status_financeiro);
  const badgeOperacional = obterBadgeOperacional(p.status_operacional);
  const badgeEstorno = p.possui_estorno ? '<span class="badge-estorno-alerta" title="Este pedido possui histórico de devolução financeira"><i class="fa-solid fa-rotate-left"></i> Estorno Registrado</span>' : '';
  const emRevisao = p.requer_revisao_financeira === true && p.status_comercial !== 'cancelado';
  const badgeRevisao = emRevisao
    ? `<span class="badge-revisao-financeira" title="${escapeHTML(p.motivo_revisao_financeira || 'Requer decisão administrativa')}"><i class="fa-solid fa-circle-exclamation"></i> ${p.bloqueado_por_overbooking_tardio ? 'Pagamento tardio sem vaga/estoque' : 'Hold expirado c/ pagamento'}</span>`
    : '';
  const holdInfo = (!emRevisao && p.status_comercial === 'aguardando_confirmacao' && p.confirmacao_expires_at)
    ? `<div style="font-size:11px; color:#b45309; margin-top:3px;"><i class="fa-regular fa-hourglass-half"></i> Reserva válida até ${new Date(p.confirmacao_expires_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`
    : '';
  const isAdminAtual = typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin';

  // Canal
  const canalIcon = {
    'balcao': '<i class="fa-solid fa-store" title="Balcão"></i> Balcão',
    'whatsapp': '<i class="fa-brands fa-whatsapp" style="color:#25d366" title="WhatsApp"></i> WhatsApp',
    'telefone': '<i class="fa-solid fa-phone" title="Telefone"></i> Telefone',
    'loja_online': '<i class="fa-solid fa-globe" title="Loja Online"></i> Loja Online'
  }[p.canal || 'loja_online'] || p.canal;

  const modalidadeBadge = p.modalidade_entrega === 'retirada'
    ? '<span style="font-size:11px; background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:6px; font-weight:600;"><i class="fa-solid fa-bag-shopping"></i> Retirada no Balcão</span>'
    : '<span style="font-size:11px; background:#eff6ff; color:#1d4ed8; padding:2px 8px; border-radius:6px; font-weight:600;"><i class="fa-solid fa-truck"></i> Entrega em Domicílio</span>';

  return `
    <div class="encomenda-card-nooty" data-pedido-id="${p.id}" style="background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; box-shadow:0 1px 3px rgba(0,0,0,0.02); transition:all 0.2s ease;">
      <!-- Topo do Card -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px; margin-bottom:12px; border-bottom:1px solid #f1f5f9; padding-bottom:10px;">
        <div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
            <span style="font-weight:800; font-size:15px; color:#1e293b;">#${p.id}</span>
            <span style="font-size:12px; font-weight:600; color:#64748b;">${canalIcon}</span>
            ${modalidadeBadge}
          </div>
          <div style="font-size:13px; font-weight:700; color:#0f172a;">
            <i class="fa-regular fa-clock" style="color:var(--primary);"></i> ${horaEntrega} • ${dtaEntrega}
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          ${badgeComercial}
          ${badgeFinanceiro}
          ${badgeOperacional}
          ${badgeEstorno}
          ${badgeRevisao}
        </div>
      </div>
      ${emRevisao ? `<div style="margin-bottom:10px; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:8px 10px; font-size:12px; color:#991b1b;"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHTML(p.motivo_revisao_financeira || 'Esta encomenda requer decisão administrativa.')}</div>` : ''}

      <!-- Corpo com Dados do Cliente e Cesta -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; font-size:13px; color:#334155;">
        <div>
          <p style="margin:2px 0;"><strong>Cliente:</strong> ${escapeHTML(p.nome_cliente || 'Não informado')}</p>
          <p style="margin:2px 0;"><strong>Contato:</strong> ${tel ? escapeHTML(tel) : '<span style="color:#94a3b8">Sem telefone</span>'}</p>
          ${p.endereco_entrega && p.modalidade_entrega !== 'retirada' ? `<p style="margin:2px 0; color:#64748b;"><i class="fa-solid fa-location-dot"></i> ${escapeHTML(p.endereco_entrega)}</p>` : ''}
        </div>
        <div>
          <div style="background:#f8fafc; padding:8px 10px; border-radius:8px; border:1px solid #edf2f7;">
            <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
              <span>Total:</span> <strong>R$ ${total}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; color:#16a34a;">
              <span>Pago:</span> <span>R$ ${pago}</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; color:${parseFloat(p.saldo) > 0 ? '#dc2626' : '#64748b'};">
              <span>Saldo restante:</span> <strong>R$ ${saldo}</strong>
            </div>
            ${p.sinal_minimo > 0 ? `<div style="font-size:11px; color:#64748b; margin-top:3px; border-top:1px dashed #e2e8f0; padding-top:2px;">Sinal exigido: R$ ${parseFloat(p.sinal_minimo).toFixed(2).replace('.', ',')}</div>` : ''}
            ${holdInfo}
          </div>
        </div>
      </div>

      <!-- Itens e Observações -->
      <div style="margin-top:10px; padding:8px 10px; background:#fffdfa; border-radius:8px; border:1px solid #fef3c7; font-size:12px; color:#78350f;">
        <strong><i class="fa-solid fa-cake-candles"></i> Itens:</strong> ${escapeHTML(p.itens || 'Sem itens')}
        ${p.observacoes_internas ? `<div style="margin-top:4px; color:#b45309;"><i class="fa-solid fa-note-sticky"></i> <strong>Cozinha:</strong> ${escapeHTML(p.observacoes_internas)}</div>` : ''}
      </div>

      <!-- Barra de Ações Rápidas (Estilo Nooty) -->
      <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; flex-wrap:wrap; margin-top:12px; padding-top:10px; border-top:1px solid #f1f5f9;">
        ${tel ? `
          <button onclick="abrirWhatsAppEncomenda('${p.id}')" class="btn-outline" style="padding:5px 10px; font-size:12px; color:#15803d; border-color:#86efac; border-radius:8px;" title="Conversar no WhatsApp">
            <i class="fa-brands fa-whatsapp"></i> WhatsApp
          </button>` : ''}

        ${emRevisao && isAdminAtual ? `
          <button onclick="abrirModalResolverRevisao('${p.id}')" class="btn-outline" style="padding:5px 10px; font-size:12px; color:#b91c1c; border-color:#fca5a5; border-radius:8px; background:#fef2f2;" title="Decidir destino desta encomenda">
            <i class="fa-solid fa-gavel"></i> Resolver Revisão
          </button>` : ''}

        ${parseFloat(p.saldo) > 0 ? `
          <button onclick="abrirModalRegistrarPagamento('${p.id}', '${p.saldo}')" class="btn-outline" style="padding:5px 10px; font-size:12px; color:#0284c7; border-color:#7dd3fc; border-radius:8px;" title="Registrar quitação de saldo">
            <i class="fa-solid fa-hand-holding-dollar"></i> Receber Saldo
          </button>` : ''}

        <button onclick="abrirModalReagendar('${p.id}', '${p.data_entrega}', '${p.hora_entrega || ''}')" class="btn-outline" style="padding:5px 10px; font-size:12px; color:#6366f1; border-color:#c7d2fe; border-radius:8px;" title="Alterar data/hora da entrega">
          <i class="fa-regular fa-calendar"></i> Reagendar
        </button>

        <button onclick="avancarStatusOperacional('${p.id}', '${p.status_operacional}')" class="btn-primary" style="padding:5px 12px; font-size:12px; border-radius:8px;" title="Avançar etapa de produção">
          <i class="fa-solid fa-forward-step"></i> ${obterRotuloBotaoAvanco(p.status_operacional)}
        </button>
      </div>
    </div>`;
}

function obterBadgeComercial(st) {
  const map = {
    'aguardando_confirmacao': { bg: '#fef3c7', text: '#b45309', label: 'Aguard. Sinal' },
    'confirmado': { bg: '#dcfce7', text: '#15803d', label: 'Confirmado' },
    'cancelado': { bg: '#fee2e2', text: '#b91c1c', label: 'Cancelado' },
    'concluido': { bg: '#e0f2fe', text: '#0369a1', label: 'Concluído' }
  }[st] || { bg: '#f1f5f9', text: '#475569', label: st };
  return `<span style="font-size:11px; background:${map.bg}; color:${map.text}; padding:3px 8px; border-radius:6px; font-weight:700;">${map.label}</span>`;
}

function obterBadgeFinanceiro(st) {
  const map = {
    'nao_pago': { bg: '#fee2e2', text: '#b91c1c', label: 'Não Pago' },
    'parcialmente_pago': { bg: '#fef3c7', text: '#b45309', label: 'Sinal Pago' },
    'pago': { bg: '#dcfce7', text: '#15803d', label: 'Quitado' },
    'estornado': { bg: '#f3e8ff', text: '#7e22ce', label: 'Estornado' }
  }[st] || { bg: '#f1f5f9', text: '#475569', label: st };
  return `<span style="font-size:11px; background:${map.bg}; color:${map.text}; padding:3px 8px; border-radius:6px; font-weight:700;">${map.label}</span>`;
}

function obterBadgeOperacional(st) {
  const map = {
    'aguardando_producao': { bg: '#f1f5f9', text: '#475569', label: 'Fila' },
    'em_producao': { bg: '#fef3c7', text: '#b45309', label: 'Em Produção' },
    'pronto': { bg: '#dcfce7', text: '#15803d', label: 'Pronto' },
    'saiu_para_entrega': { bg: '#e0f2fe', text: '#0369a1', label: 'Em Rota' },
    'entregue': { bg: '#dcfce7', text: '#15803d', label: 'Entregue' },
    'retirado': { bg: '#dcfce7', text: '#15803d', label: 'Retirado' },
    'cancelado': { bg: '#fee2e2', text: '#b91c1c', label: 'Cancelado' }
  }[st] || { bg: '#f1f5f9', text: '#475569', label: st };
  return `<span style="font-size:11px; background:${map.bg}; color:${map.text}; padding:3px 8px; border-radius:6px; font-weight:700;">${map.label}</span>`;
}

function obterRotuloBotaoAvanco(st) {
  switch (st) {
    case 'aguardando_producao': return 'Iniciar Produção';
    case 'em_producao': return 'Marcar Pronto';
    case 'pronto': return 'Finalizar Entrega/Retirada';
    case 'saiu_para_entrega': return 'Confirmar Entrega';
    default: return 'Avançar';
  }
}

// --------------------------------------------------------------------------
// 4. FLUXO "+ NOVA ENCOMENDA RÁPIDA" (BALCÃO / WHATSAPP / TELEFONE)
// --------------------------------------------------------------------------
let configOperacaoCache = null;
async function carregarConfigOperacao() {
  if (configOperacaoCache) return configOperacaoCache;
  try {
    const { data, error } = await supabaseClient.rpc('obter_config_operacao');
    if (!error && data) configOperacaoCache = data;
  } catch (e) {
    console.warn('[Config Operação] usando padrões:', e);
  }
  return configOperacaoCache;
}

async function abrirModalNovaEncomenda() {
  const modal = document.getElementById('modal-nova-encomenda');
  if (!modal) return;
  await carregarConfigOperacao();

  carrinhoNovaEncomendaItens = [];
  document.getElementById('nova-enc-cliente-busca').value = '';
  document.getElementById('nova-enc-cliente-id').value = '';
  document.getElementById('nova-enc-cliente-nome').value = '';
  document.getElementById('nova-enc-cliente-telefone').value = '';
  document.getElementById('nova-enc-cliente-email').value = '';
  document.getElementById('nova-enc-data-entrega').value = (new Date()).toLocaleDateString('en-CA');
  document.getElementById('nova-enc-hora-entrega').value = '14:00';
  document.getElementById('nova-enc-modalidade').value = 'retirada';
  document.getElementById('nova-enc-endereco').value = '';
  document.getElementById('nova-enc-taxa').value = '0.00';
  document.getElementById('nova-enc-desconto').value = '0.00';
  document.getElementById('nova-enc-motivo-desconto').value = '';
  document.getElementById('nova-enc-sinal-minimo').value = '';
  document.getElementById('nova-enc-sinal-valor').value = '0.00';
  document.getElementById('nova-enc-obs-internas').value = '';

  // GOVERNANÇA DO SINAL: operador vê o sinal padrão (somente leitura; o servidor impõe o mínimo);
  // admin pode editar, mas reduzir abaixo do padrão exige justificativa (validado no servidor).
  const isAdminNovaEnc = !!(typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin');
  const sinalMinEl = document.getElementById('nova-enc-sinal-minimo');
  if (sinalMinEl) {
    sinalMinEl.readOnly = !isAdminNovaEnc;
    sinalMinEl.style.background = isAdminNovaEnc ? '' : '#f1f5f9';
    sinalMinEl.title = isAdminNovaEnc ? 'Reduzir abaixo do padrão exige justificativa' : 'Sinal mínimo padrão (definido pela operação). Apenas Admin pode reduzir.';
  }
  const motivoSinalEl = document.getElementById('nova-enc-motivo-sinal');
  if (motivoSinalEl) motivoSinalEl.value = '';
  
  const chkSemSinal = document.getElementById('nova-enc-confirmar-sem-sinal');
  if (chkSemSinal) {
    chkSemSinal.checked = false;
    chkSemSinal.disabled = !isAdminNovaEnc;
  }

  // Carrega catálogo de produtos para seleção
  await carregarProdutosCatalogoNovaEncomenda();
  renderizarItensNovaEncomenda();
  calcularTotaisNovaEncomenda();

  modal.style.display = 'flex';
}

function fecharModalNovaEncomenda() {
  const modal = document.getElementById('modal-nova-encomenda');
  if (modal) modal.style.display = 'none';
}

async function carregarProdutosCatalogoNovaEncomenda() {
  try {
    const { data: prods } = await supabaseClient.from('produtos').select('id, nome, preco, pontos_producao, ativo').eq('ativo', true).order('nome');
    produtosCatalogoCache = prods || [];
    
    const { data: opts } = await supabaseClient.from('produto_opcoes').select('*').eq('ativo', true);
    opcoesCatalogoCache = opts || [];

    const selectProd = document.getElementById('nova-enc-select-produto');
    if (selectProd) {
      selectProd.innerHTML = '<option value="">-- Selecione o produto --</option>' + 
        produtosCatalogoCache.map(p => `<option value="${p.id}">${escapeHTML(p.nome)} - R$ ${parseFloat(p.preco).toFixed(2).replace('.', ',')}</option>`).join('');
    }
  } catch (err) {
    console.error('[Catálogo Nova Encomenda] Erro:', err);
  }
}

function onProdutoSelecionadoNovaEncomenda(e) {
  const prodId = e.target.value;
  const containerOpcoes = document.getElementById('nova-enc-opcoes-dinamicas');
  if (!containerOpcoes) return;

  if (!prodId) {
    containerOpcoes.innerHTML = '';
    produtoSelecionadoNovaEncomenda = null;
    return;
  }

  produtoSelecionadoNovaEncomenda = produtosCatalogoCache.find(p => String(p.id) === String(prodId));
  const opcoesDesteProd = opcoesCatalogoCache.filter(o => String(o.produto_id) === String(prodId));

  if (opcoesDesteProd.length === 0) {
    containerOpcoes.innerHTML = '<p style="font-size:12px; color:#64748b; margin:6px 0;">Sem opções adicionais cadastradas para este item.</p>';
    return;
  }

  let htmlOpcoes = '<div style="background:#f8fafc; padding:8px 10px; border-radius:8px; border:1px solid #e2e8f0; margin-top:6px;">';
  htmlOpcoes += '<p style="font-size:12px; font-weight:700; margin:0 0 6px 0; color:#334155;">Opções e Adicionais:</p>';
  opcoesDesteProd.forEach(opt => {
    htmlOpcoes += `
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:4px; cursor:pointer;">
        <input type="checkbox" class="chk-opt-nova-enc" value="${opt.id}" data-nome="${escapeHTML(opt.nome)}" data-preco="${opt.preco_adicional || 0}">
        <span>${escapeHTML(opt.nome)} ${opt.preco_adicional > 0 ? `(+R$ ${parseFloat(opt.preco_adicional).toFixed(2).replace('.', ',')})` : ''}</span>
      </label>`;
  });
  htmlOpcoes += '</div>';

  containerOpcoes.innerHTML = htmlOpcoes;
}

function adicionarItemNovaEncomenda() {
  if (!produtoSelecionadoNovaEncomenda) {
    alert('Por favor, selecione um produto.');
    return;
  }

  const qtdInput = document.getElementById('nova-enc-qtd-produto');
  const qtd = Math.max(1, parseInt(qtdInput?.value || 1, 10));

  // Opções marcadas
  const opcoesMarcadas = [];
  document.querySelectorAll('.chk-opt-nova-enc:checked').forEach(chk => {
    opcoesMarcadas.push({
      id: chk.value,
      nome: chk.getAttribute('data-nome'),
      preco: parseFloat(chk.getAttribute('data-preco') || 0)
    });
  });

  carrinhoNovaEncomendaItens.push({
    id: produtoSelecionadoNovaEncomenda.id,
    nome: produtoSelecionadoNovaEncomenda.nome,
    preco: parseFloat(produtoSelecionadoNovaEncomenda.preco),
    quantidade: qtd,
    opcoes: opcoesMarcadas
  });

  // Limpa seleção
  document.getElementById('nova-enc-select-produto').value = '';
  document.getElementById('nova-enc-opcoes-dinamicas').innerHTML = '';
  produtoSelecionadoNovaEncomenda = null;
  if (qtdInput) qtdInput.value = '1';

  renderizarItensNovaEncomenda();
  calcularTotaisNovaEncomenda();
}

function removerItemNovaEncomenda(index) {
  carrinhoNovaEncomendaItens.splice(index, 1);
  renderizarItensNovaEncomenda();
  calcularTotaisNovaEncomenda();
}

function renderizarItensNovaEncomenda() {
  const container = document.getElementById('nova-enc-cesta-itens');
  if (!container) return;

  if (carrinhoNovaEncomendaItens.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:#94a3b8; text-align:center; margin:10px 0;">Nenhum item adicionado ainda.</p>';
    return;
  }

  let html = '<div style="display:flex; flex-direction:column; gap:6px; margin:8px 0;">';
  carrinhoNovaEncomendaItens.forEach((it, idx) => {
    const optsStr = it.opcoes.length > 0 ? ` (+ ${it.opcoes.map(o => o.nome).join(', ')})` : '';
    const sub = (it.preco + it.opcoes.reduce((acc, o) => acc + o.preco, 0)) * it.quantidade;
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:#fff; padding:6px 10px; border-radius:6px; border:1px solid #e2e8f0; font-size:12px;">
        <span><strong>${it.quantidade}x</strong> ${escapeHTML(it.nome)}${escapeHTML(optsStr)}</span>
        <div style="display:flex; align-items:center; gap:8px;">
          <span>R$ ${sub.toFixed(2).replace('.', ',')}</span>
          <button onclick="removerItemNovaEncomenda(${idx})" style="background:none; border:none; color:#ef4444; cursor:pointer;" title="Remover item"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  });
  html += '</div>';

  container.innerHTML = html;
}

// Admin editou o sinal manualmente: deixa de ser auto-preenchido
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'nova-enc-sinal-minimo') e.target.dataset.auto = '0';
});

function calcularTotaisNovaEncomenda() {
  let subtotal = 0;
  carrinhoNovaEncomendaItens.forEach(it => {
    const optSum = it.opcoes.reduce((acc, o) => acc + o.preco, 0);
    subtotal += (it.preco + optSum) * it.quantidade;
  });

  const modalidade = document.getElementById('nova-enc-modalidade')?.value || 'retirada';
  const taxaInput = document.getElementById('nova-enc-taxa');
  let taxa = modalidade === 'retirada' ? 0.00 : Math.max(0, parseFloat(taxaInput?.value || 0));
  if (taxaInput && modalidade === 'retirada') taxaInput.value = '0.00';

  const descontoInput = document.getElementById('nova-enc-desconto');
  let desconto = Math.max(0, parseFloat(descontoInput?.value || 0));

  // Validação em tempo real de desconto para Operador (máx 10%)
  const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';
  if (isOperador && desconto > (subtotal * 0.10)) {
    desconto = subtotal * 0.10;
    if (descontoInput) descontoInput.value = desconto.toFixed(2);
    alert('Operadores podem conceder no máximo 10% de desconto.');
  }

  const total = Math.max(0, (subtotal - desconto) + taxa);

  const elSub = document.getElementById('nova-enc-subtotal-display');
  const elTot = document.getElementById('nova-enc-total-display');
  if (elSub) elSub.innerText = `R$ ${subtotal.toFixed(2).replace('.', ',')}`;
  if (elTot) elTot.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;

  // Sinal padrão = percentual da operação (fallback 50%). Operador: sempre o padrão; admin: preenchido se vazio.
  const pct = (typeof configOperacaoCache !== 'undefined' && configOperacaoCache && configOperacaoCache.sinal_percentual_padrao != null)
    ? parseFloat(configOperacaoCache.sinal_percentual_padrao) : 50;
  const sinalPadrao = (total * (pct / 100)).toFixed(2);
  const sinalMinInput = document.getElementById('nova-enc-sinal-minimo');
  if (sinalMinInput) {
    const isAdminCalc = !!(typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin');
    if (!isAdminCalc || sinalMinInput.value === '' || sinalMinInput.dataset.auto === '1') {
      sinalMinInput.value = sinalPadrao;
      sinalMinInput.dataset.auto = '1';
    }
    sinalMinInput.dataset.padrao = sinalPadrao;
  }
  const hint = document.getElementById('nova-enc-sinal-hint');
  if (hint) hint.innerText = `Padrão da operação: ${pct}% = R$ ${sinalPadrao.replace('.', ',')}`;
}

// Autocomplete de clientes na Nova Encomenda
function onBuscarClienteNovaEncomendaInput(e) {
  clearTimeout(debounceBuscaClientesTimer);
  const termo = e.target.value.trim();
  const dropdown = document.getElementById('nova-enc-cliente-dropdown');
  if (!dropdown) return;

  if (termo.length < 2) {
    dropdown.style.display = 'none';
    return;
  }

  debounceBuscaClientesTimer = setTimeout(async () => {
    try {
      const { data: res } = await supabaseClient.rpc('buscar_clientes_admin', { p_busca: termo, p_limite: 6 });
      if (res && res.success && res.clientes && res.clientes.length > 0) {
        dropdown.innerHTML = res.clientes.map(c => `
          <div onclick="selecionarClienteNovaEncomenda(${c.id}, '${escapeHTML(c.nome)}', '${escapeHTML(c.telefone || '')}', '${escapeHTML(c.email || '')}')" style="padding:8px 12px; border-bottom:1px solid #f1f5f9; cursor:pointer; font-size:12px;">
            <strong>${escapeHTML(c.nome)}</strong> - ${c.telefone || 'Sem telefone'}
          </div>
        `).join('');
        dropdown.style.display = 'block';
      } else {
        dropdown.innerHTML = '<div style="padding:8px 12px; font-size:12px; color:#94a3b8;">Nenhum cliente cadastrado com este nome/telefone. Preencha os campos abaixo para cadastrar.</div>';
        dropdown.style.display = 'block';
      }
    } catch (err) {
      console.error('[Busca Clientes] Erro:', err);
    }
  }, 300);
}

function selecionarClienteNovaEncomenda(id, nome, telefone, email) {
  document.getElementById('nova-enc-cliente-id').value = id;
  document.getElementById('nova-enc-cliente-nome').value = nome;
  document.getElementById('nova-enc-cliente-telefone').value = telefone;
  document.getElementById('nova-enc-cliente-email').value = email;
  document.getElementById('nova-enc-cliente-busca').value = `${nome} (${telefone})`;
  document.getElementById('nova-enc-cliente-dropdown').style.display = 'none';
}

async function submeterNovaEncomendaAdmin() {
  const btn = document.getElementById('btn-salvar-nova-encomenda');
  const txtOrig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gravando Encomenda...';
  }

  try {
    if (carrinhoNovaEncomendaItens.length === 0) {
      throw new Error('Adicione pelo menos um item à encomenda.');
    }

    const isAdminSubmit = !!(typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin');
    const sinalMinEl = document.getElementById('nova-enc-sinal-minimo');
    const chkSemSinalEl = document.getElementById('nova-enc-confirmar-sem-sinal');
    const motivoSinal = (document.getElementById('nova-enc-motivo-sinal')?.value || '').trim();
    if (isAdminSubmit) {
      const padrao = parseFloat(sinalMinEl?.dataset?.padrao || '0');
      const informado = parseFloat(sinalMinEl?.value || '0');
      const semSinal = !!(chkSemSinalEl && chkSemSinalEl.checked);
      if ((semSinal || (informado > 0 && informado < padrao)) && motivoSinal.length < 3) {
        throw new Error('Informe a justificativa para reduzir/dispensar o sinal mínimo (auditável).');
      }
    }

    const payload = {
      p_cliente_id: document.getElementById('nova-enc-cliente-id').value || null,
      p_cliente_nome: document.getElementById('nova-enc-cliente-nome').value.trim(),
      p_cliente_telefone: document.getElementById('nova-enc-cliente-telefone').value.trim(),
      p_cliente_email: document.getElementById('nova-enc-cliente-email').value.trim() || null,
      p_canal: document.getElementById('nova-enc-canal').value,
      p_data_entrega: document.getElementById('nova-enc-data-entrega').value,
      p_hora_entrega: document.getElementById('nova-enc-hora-entrega').value || null,
      p_modalidade: document.getElementById('nova-enc-modalidade').value,
      p_endereco_entrega: document.getElementById('nova-enc-endereco').value.trim() || null,
      p_itens: carrinhoNovaEncomendaItens,
      p_taxa_entrega: parseFloat(document.getElementById('nova-enc-taxa').value || 0),
      p_desconto: parseFloat(document.getElementById('nova-enc-desconto').value || 0),
      p_motivo_desconto: document.getElementById('nova-enc-motivo-desconto').value.trim() || null,
      // Operador: não envia sinal mínimo (servidor aplica o padrão). Admin: envia o valor editado.
      p_sinal_minimo: isAdminSubmit ? (parseFloat(sinalMinEl.value) || null) : null,
      p_sinal_valor: parseFloat(document.getElementById('nova-enc-sinal-valor').value || 0),
      p_sinal_metodo: document.getElementById('nova-enc-sinal-metodo').value,
      p_forcar_confirmacao_sem_sinal: isAdminSubmit && !!(chkSemSinalEl && chkSemSinalEl.checked),
      p_motivo_confirmacao_sem_sinal: motivoSinal || null,
      p_observacoes_cliente: document.getElementById('nova-enc-obs-cliente').value.trim() || null,
      p_observacoes_internas: document.getElementById('nova-enc-obs-internas').value.trim() || null
    };

    const { data: res, error } = await supabaseClient.rpc('criar_encomenda_admin', payload);
    if (error) throw error;
    if (!res.success) {
      let msg = res.error || 'Erro ao registrar encomenda.';
      if (res.code === 'INSUFFICIENT_STOCK' && res.detalhes && Array.isArray(res.detalhes.faltantes)) {
        msg += '\n\nItens sem estoque:\n' + res.detalhes.faltantes.map(f => `• ${f.produto}: precisa ${f.necessario}, disponível ${f.disponivel}`).join('\n');
      }
      if (res.code === 'SIGNAL_REDUCTION_REQUIRES_REASON') {
        msg += `\n\nSinal padrão: R$ ${parseFloat(res.sinal_padrao || 0).toFixed(2)}. Preencha a justificativa do sinal.`;
      }
      if (res.code === 'IMMEDIATE_CONFIRMATION_REQUIRED') {
        msg += `\n\nSinal mínimo: R$ ${parseFloat(res.sinal_minimo || 0).toFixed(2)} | Informado: R$ ${parseFloat(res.sinal_pago || 0).toFixed(2)}`;
      }
      throw new Error(msg);
    }

    fecharModalNovaEncomenda();
    mostrarToast(`Encomenda #${res.pedido_id} criada com sucesso!` + (res.confirmacao_expires_at ? ` Reserva válida até ${new Date(res.confirmacao_expires_at).toLocaleString('pt-BR')}.` : ''), 'sucesso', 5000);
    
    // Atualiza as telas abertas
    carregarDashboardHoje();
    carregarCentralEncomendas();

  } catch (err) {
    console.error('[Criar Encomenda Admin] Falha:', err);
    alert('Erro ao registrar encomenda: ' + (err.message || err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = txtOrig;
    }
  }
}

// --------------------------------------------------------------------------
// 5. REGISTRAR PAGAMENTO DE SALDO (RECEBIMENTO RÁPIDO)
// --------------------------------------------------------------------------
function abrirModalRegistrarPagamento(pedidoId, saldo) {
  const modal = document.getElementById('modal-registrar-pagamento');
  if (!modal) return;

  document.getElementById('pag-pedido-id').value = pedidoId;
  document.getElementById('pag-valor').value = parseFloat(saldo || 0).toFixed(2);
  document.getElementById('pag-metodo').value = 'pix';
  document.getElementById('pag-obs').value = '';
  document.getElementById('pag-saldo-info').innerText = `Saldo devedor restante: R$ ${parseFloat(saldo || 0).toFixed(2).replace('.', ',')}`;

  modal.style.display = 'flex';
}

function fecharModalRegistrarPagamento() {
  const modal = document.getElementById('modal-registrar-pagamento');
  if (modal) modal.style.display = 'none';
}

async function submeterPagamentoSaldo() {
  const pedidoId = document.getElementById('pag-pedido-id').value;
  const valor = parseFloat(document.getElementById('pag-valor').value);
  const metodo = document.getElementById('pag-metodo').value;
  const obs = document.getElementById('pag-obs').value.trim();

  if (!pedidoId || isNaN(valor) || valor <= 0) {
    alert('Informe um valor de pagamento positivo.');
    return;
  }

  try {
    const { data: res, error } = await supabaseClient.rpc('registrar_pagamento_pedido', {
      p_pedido_id: parseInt(pedidoId, 10),
      p_valor: valor,
      p_metodo: metodo,
      p_observacoes: obs || null
    });

    if (error) throw error;
    if (!res.success) throw new Error(res.error || 'Erro ao registrar pagamento.');

    fecharModalRegistrarPagamento();
    mostrarToast(`Pagamento de R$ ${valor.toFixed(2)} registrado com sucesso!`, 'sucesso', 3500);

    carregarDashboardHoje();
    carregarCentralEncomendas();

  } catch (err) {
    console.error('[Registrar Pagamento] Falha:', err);
    alert('Erro ao registrar pagamento: ' + (err.message || err));
  }
}

// --------------------------------------------------------------------------
// 6. REAGENDAMENTO COM VALIDAÇÃO DE CAPACIDADE
// --------------------------------------------------------------------------
function abrirModalReagendar(pedidoId, dataAtual, horaAtual) {
  const modal = document.getElementById('modal-reagendar-encomenda');
  if (!modal) return;

  document.getElementById('reag-pedido-id').value = pedidoId;
  document.getElementById('reag-nova-data').value = dataAtual;
  document.getElementById('reag-nova-hora').value = horaAtual ? horaAtual.substring(0, 5) : '14:00';
  document.getElementById('reag-motivo').value = '';

  modal.style.display = 'flex';
}

function fecharModalReagendar() {
  const modal = document.getElementById('modal-reagendar-encomenda');
  if (modal) modal.style.display = 'none';
}

async function submeterReagendamento() {
  const pedidoId = document.getElementById('reag-pedido-id').value;
  const novaData = document.getElementById('reag-nova-data').value;
  const novaHora = document.getElementById('reag-nova-hora').value;
  const motivo = document.getElementById('reag-motivo').value.trim();

  if (!pedidoId || !novaData || !motivo) {
    alert('Nova data e motivo do reagendamento são obrigatórios.');
    return;
  }

  try {
    const { data: res, error } = await supabaseClient.rpc('reagendar_encomenda_admin', {
      p_pedido_id: parseInt(pedidoId, 10),
      p_nova_data: novaData,
      p_nova_hora: novaHora || null,
      p_motivo: motivo
    });

    if (error) throw error;
    if (!res.success) throw new Error(res.error || 'Erro ao reagendar.');

    fecharModalReagendar();
    mostrarToast(`Encomenda #${pedidoId} reagendada para ${novaData.split('-').reverse().join('/')}!`, 'sucesso', 3500);

    carregarDashboardHoje();
    carregarCentralEncomendas();

  } catch (err) {
    console.error('[Reagendar] Falha:', err);
    alert('Erro ao reagendar encomenda: ' + (err.message || err));
  }
}

// --------------------------------------------------------------------------
// 7. AVANÇO RÁPIDO DE STATUS OPERACIONAL
// --------------------------------------------------------------------------
async function avancarStatusOperacional(pedidoId, statusAtual) {
  const proximoMap = {
    'aguardando_producao': 'em_producao',
    'em_producao': 'pronto',
    'pronto': 'entregue',
    'saiu_para_entrega': 'entregue'
  };

  const proximo = proximoMap[statusAtual];
  if (!proximo) {
    alert('Esta encomenda já se encontra na etapa final.');
    return;
  }

  try {
    const { data: res, error } = await supabaseClient.rpc('alterar_status_pedido', {
      p_pedido_id: parseInt(pedidoId, 10),
      p_dimensao: 'operacional',
      p_novo_status: proximo,
      p_motivo: 'Avanço de etapa de produção na operação diária'
    });

    if (error) throw error;
    if (!res.success) throw new Error(res.error || 'Erro ao avançar status.');

    mostrarToast(`Encomenda #${pedidoId} avançada para: ${proximo}!`, 'sucesso', 2500);
    carregarDashboardHoje();
    carregarCentralEncomendas();

  } catch (err) {
    console.error('[Avançar Status] Erro:', err);
    alert('Erro ao avançar etapa: ' + (err.message || err));
  }
}

// --------------------------------------------------------------------------
// 8. WHATSAPP 1-CLIQUE ÁGIL (FORMATADO)
// --------------------------------------------------------------------------
function abrirWhatsAppEncomenda(pedidoId) {
  const p = listaEncomendasCentralCache.find(it => String(it.id) === String(pedidoId));
  if (!p) return;

  let tel = p.telefone_cliente || p.clientes?.telefone || '';
  let telNorm = p.clientes?.telefone_normalizado || tel.replace(/\D/g, '');
  if (telNorm.length === 10 || telNorm.length === 11) {
    telNorm = '55' + telNorm;
  }

  if (!telNorm) {
    alert('Cliente sem telefone cadastrado.');
    return;
  }

  const dta = p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '';
  const hora = p.hora_entrega ? p.hora_entrega.substring(0, 5) : '';
  const saldo = parseFloat(p.saldo || 0).toFixed(2).replace('.', ',');
  const total = parseFloat(p.total || 0).toFixed(2).replace('.', ',');

  const texto = 
`Olá, *${p.nome_cliente}*! Aqui é da *Lunoca Doceria* 🍰✨
Passando para confirmar os detalhes da sua encomenda *#${p.id}*:

🎂 *Itens:* ${p.itens}
📅 *Data:* ${dta}${hora ? ` às ${hora}` : ''}
📍 *Modalidade:* ${p.modalidade_entrega === 'retirada' ? 'Retirada no Balcão' : 'Entrega em Domicílio'}
💰 *Valor Total:* R$ ${total}
${parseFloat(p.saldo) > 0 ? `👉 *Saldo a acertar:* R$ ${saldo}` : '✅ *Status:* Quitado com sucesso!'}

Qualquer dúvida estamos à disposição!`;

  window.open(`https://wa.me/${telNorm}?text=${encodeURIComponent(texto)}`, '_blank');
}

// --------------------------------------------------------------------------
// 7. REVISÃO FINANCEIRA - RESOLUÇÃO ADMINISTRATIVA (resolver_revisao_encomenda_admin)
// --------------------------------------------------------------------------
// Ações:
//   ESTENDER_HOLD          -> novo prazo; revalida capacidade e RECRIA reserva de estoque
//   CONFIRMAR_COM_OVERRIDE -> admin força CAPACIDADE (nunca estoque inexistente)
//   ESTORNAR_E_CANCELAR    -> estorna todos os pagamentos (fluxo canônico) e cancela
//   CANCELAR               -> cancela retendo o valor (RETENCAO_CANCELAMENTO)

function abrirModalResolverRevisao(pedidoId) {
  if (!(typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin')) {
    alert('Apenas administradores podem resolver revisões financeiras.');
    return;
  }
  const p = listaEncomendasCentralCache.find(x => String(x.id) === String(pedidoId));
  document.getElementById('rev-pedido-id').value = pedidoId;
  document.getElementById('rev-acao').value = 'ESTENDER_HOLD';
  document.getElementById('rev-motivo').value = '';
  document.getElementById('rev-destino-retencao').checked = false;

  const resumo = document.getElementById('rev-resumo');
  if (resumo) {
    const pago = parseFloat(p?.valor_pago || 0).toFixed(2).replace('.', ',');
    const total = parseFloat(p?.total || 0).toFixed(2).replace('.', ',');
    resumo.innerHTML = `
      <div><strong>Pedido #${escapeHTML(String(pedidoId))}</strong> • ${escapeHTML(p?.nome_cliente || '')}</div>
      <div>Pago: <strong>R$ ${pago}</strong> de R$ ${total} • Entrega: ${p?.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '--'}</div>
      <div style="margin-top:4px; color:#991b1b;">${escapeHTML(p?.motivo_revisao_financeira || 'Requer decisão administrativa.')}</div>`;
  }

  // Prazo padrão sugerido: +24h
  const dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  dt.setSeconds(0, 0);
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  document.getElementById('rev-novo-prazo').value = local;

  onAcaoRevisaoChange();
  const modal = document.getElementById('modal-resolver-revisao');
  if (modal) modal.style.display = 'flex';
}

function fecharModalResolverRevisao() {
  const modal = document.getElementById('modal-resolver-revisao');
  if (modal) modal.style.display = 'none';
}

function onAcaoRevisaoChange() {
  const acao = document.getElementById('rev-acao').value;
  document.getElementById('rev-grupo-prazo').style.display = acao === 'ESTENDER_HOLD' ? 'block' : 'none';
  document.getElementById('rev-grupo-destino').style.display = acao === 'CANCELAR' ? 'block' : 'none';
  const hint = document.getElementById('rev-hint');
  const hints = {
    ESTENDER_HOLD: 'Dá um novo prazo ao cliente. O sistema revalida a capacidade da data e recria a reserva de estoque. Falha se não houver vaga ou estoque.',
    CONFIRMAR_COM_OVERRIDE: 'Confirma a encomenda mesmo com a capacidade do dia estourada (encaixe extraordinário). Estoque insuficiente NÃO pode ser forçado.',
    ESTORNAR_E_CANCELAR: 'Estorna todos os pagamentos aprovados (lançamento compensatório no DRE) e cancela a encomenda.',
    CANCELAR: 'Cancela sem estornar: o valor pago fica retido como receita (política de cancelamento). Crédito em loja será suportado futuramente.'
  };
  if (hint) hint.innerText = hints[acao] || '';
}

async function submeterResolucaoRevisao() {
  const pedidoId = document.getElementById('rev-pedido-id').value;
  const acao = document.getElementById('rev-acao').value;
  const motivo = document.getElementById('rev-motivo').value.trim();
  const btn = document.getElementById('btn-submeter-revisao');

  if (motivo.length < 5) {
    alert('Informe uma justificativa com pelo menos 5 caracteres.');
    return;
  }

  const payload = { p_pedido_id: parseInt(pedidoId, 10), p_acao: acao, p_motivo: motivo };

  if (acao === 'ESTENDER_HOLD') {
    const prazo = document.getElementById('rev-novo-prazo').value;
    if (!prazo) { alert('Informe o novo prazo do hold.'); return; }
    const dt = new Date(prazo);
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) { alert('O novo prazo precisa estar no futuro.'); return; }
    payload.p_novo_expires_at = dt.toISOString();
  }

  if (acao === 'CANCELAR') {
    if (!document.getElementById('rev-destino-retencao').checked) {
      alert('Para cancelar sem estorno, confirme a retenção do valor pago.');
      return;
    }
    payload.p_destino_valor = 'RETENCAO_CANCELAMENTO';
  }

  if (acao === 'ESTORNAR_E_CANCELAR' && !confirm('Confirmar o estorno de TODOS os pagamentos e o cancelamento desta encomenda?')) return;

  const txtOrig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando...'; }

  try {
    const { data: res, error } = await supabaseClient.rpc('resolver_revisao_encomenda_admin', payload);
    if (error) throw error;
    if (!res.success) {
      let msg = res.error || 'Não foi possível resolver a revisão.';
      if (res.code === 'INSUFFICIENT_STOCK' && res.detalhes && Array.isArray(res.detalhes.faltantes)) {
        msg += '\n\nItens sem estoque:\n' + res.detalhes.faltantes.map(f => `• ${f.produto}: precisa ${f.necessario}, disponível ${f.disponivel}`).join('\n');
      }
      throw new Error(msg);
    }

    fecharModalResolverRevisao();
    const msgs = {
      ESTENDER_HOLD: `Hold da encomenda #${pedidoId} estendido e reserva recriada.`,
      CONFIRMAR_COM_OVERRIDE: `Encomenda #${pedidoId} confirmada${res.override_capacidade ? ' com encaixe extraordinário' : ''}.`,
      ESTORNAR_E_CANCELAR: `Encomenda #${pedidoId} estornada e cancelada (${(res.estornos || []).length} pagamento(s)).`,
      CANCELAR: `Encomenda #${pedidoId} cancelada com retenção de R$ ${parseFloat(res.valor_retido || 0).toFixed(2).replace('.', ',')}.`
    };
    mostrarToast(msgs[acao] || 'Revisão resolvida.', 'sucesso', 5000);
    carregarDashboardHoje();
    carregarCentralEncomendas();
  } catch (err) {
    console.error('[Resolver Revisão] Falha:', err);
    alert('Erro: ' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = txtOrig; }
  }
}
