// ==========================================================================
// LUNOCA DOCERIA - Módulo de Controle Financeiro & Fluxo de Caixa
// ==========================================================================

let financeiroPeriodoAtual = 'mes_atual'; // 'hoje', '7dias', 'mes_atual', 'mes_anterior', 'tudo'
let financeiroFiltroTipo = 'todos'; // 'todos', 'receitas', 'despesas'
let financeiroLancamentos = [];
let financeiroResumo = {
  faturamento: 0,
  despesas: 0,
  lucro: 0,
  ticketMedio: 0,
  qtdPedidos: 0,
  totalPix: 0,
  totalCartao: 0,
  totalOutro: 0,
  margem: 0
};

/**
 * Carrega a visão financeira do painel administrativo
 */
async function carregarFinanceiroAdmin() {
  const container = document.getElementById('admin-tab-financeiro');
  if (!container) return;

  const lista = document.getElementById('lista-financeiro-extrato');
  if (lista) {
    lista.innerHTML = "<p style='text-align:center; color:#888;'><i class='fa-solid fa-spinner fa-spin'></i> Calculando fluxo de caixa e indicadores...</p>";
  }

  try {
    // 1. Garante que os pedidos estejam carregados
    if (!pedidosGlobal || pedidosGlobal.length === 0) {
      const { data: peds } = await supabaseClient
        .from('pedidos')
        .select('*')
        .order('data_pedido', { ascending: false });
      pedidosGlobal = peds || [];
    }

    // 2. Busca lançamentos manuais de receitas e despesas
    try {
      const { data: lancs, error } = await supabaseClient
        .from('financeiro_lancamentos')
        .select('*')
        .order('data_lancamento', { ascending: false });

      if (!error && lancs) {
        financeiroLancamentos = lancs;
      } else {
        financeiroLancamentos = JSON.parse(localStorage.getItem('lunoca_financeiro_local') || '[]');
      }
    } catch (e) {
      financeiroLancamentos = JSON.parse(localStorage.getItem('lunoca_financeiro_local') || '[]');
    }

    // 3. Processa métricas com base no período selecionado
    calcularMetricasFinanceiras();

    // 4. Renderiza cards de resumo executivo
    atualizarCardsFinanceiro();

    // 5. Renderiza a barra de pagamentos (PIX vs Cartão)
    renderizarGraficoPagamentos();

    // 6. Renderiza o DRE simplificado
    renderizarDRE();

    // 7. Renderiza o extrato completo de movimentações
    renderizarExtratoFinanceiro();

  } catch (err) {
    console.error('Erro ao carregar dados financeiros:', err);
    if (lista) {
      lista.innerHTML = `
        <div style="padding:15px; background:#fff1f2; color:#be123c; border-radius:10px; border:1px solid #fecdd3; font-size:13px;">
          <i class="fa-solid fa-triangle-exclamation"></i> <strong>Erro ao carregar financeiro:</strong> ${escapeHTML(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Filtra pedidos e lançamentos pela data escolhida
 */
function isDataNoPeriodo(dataIso, periodo) {
  if (!dataIso) return false;
  if (periodo === 'tudo') return true;

  const data = new Date(dataIso + (dataIso.includes('T') ? '' : 'T00:00:00'));
  const hoje = new Date();

  if (periodo === 'hoje') {
    return data.toDateString() === hoje.toDateString();
  }

  if (periodo === '7dias') {
    const seteDiasAtras = new Date();
    seteDiasAtras.setDate(hoje.getDate() - 7);
    return data >= seteDiasAtras && data <= hoje;
  }

  if (periodo === 'mes_atual') {
    return data.getMonth() === hoje.getMonth() && data.getFullYear() === hoje.getFullYear();
  }

  if (periodo === 'mes_anterior') {
    const mesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    return data.getMonth() === mesPassado.getMonth() && data.getFullYear() === mesPassado.getFullYear();
  }

  return true;
}

/**
 * Calcula todas as métricas de receita, custo e margem
 */
function calcularMetricasFinanceiras() {
  let faturamento = 0;
  let despesas = 0;
  let totalPix = 0;
  let totalCartao = 0;
  let totalOutro = 0;
  let qtdPedidos = 0;

  // Processa pedidos confirmados/válidos
  for (let i = 0; i < pedidosGlobal.length; i++) {
    const p = pedidosGlobal[i];
    if (p.status === 'Cancelado') continue;

    const dataBase = p.data_pedido || p.data_entrega || (p.created_at ? p.created_at.split('T')[0] : null);
    if (!isDataNoPeriodo(dataBase, financeiroPeriodoAtual)) continue;

    const valor = parseFloat(p.total) || 0;
    faturamento += valor;
    qtdPedidos++;

    if (p.pagamento === 'pix') {
      totalPix += valor;
    } else if (p.pagamento === 'cartao') {
      totalCartao += valor;
    } else {
      totalOutro += valor;
    }
  }

  // Processa lançamentos manuais
  for (let i = 0; i < financeiroLancamentos.length; i++) {
    const l = financeiroLancamentos[i];
    if (!isDataNoPeriodo(l.data_lancamento, financeiroPeriodoAtual)) continue;

    const valor = parseFloat(l.valor) || 0;
    if (l.tipo === 'receita') {
      faturamento += valor;
    } else if (l.tipo === 'despesa') {
      despesas += valor;
    }
  }

  const lucro = faturamento - despesas;
  const ticketMedio = qtdPedidos > 0 ? faturamento / qtdPedidos : 0;
  const margem = faturamento > 0 ? (lucro / faturamento) * 100 : 0;

  financeiroResumo = {
    faturamento,
    despesas,
    lucro,
    ticketMedio,
    qtdPedidos,
    totalPix,
    totalCartao,
    totalOutro,
    margem
  };
}

/**
 * Atualiza os cards superiores de indicadores
 */
function atualizarCardsFinanceiro() {
  const elFat = document.getElementById('fin-card-faturamento');
  const elDesp = document.getElementById('fin-card-despesas');
  const elLucro = document.getElementById('fin-card-lucro');
  const elTicket = document.getElementById('fin-card-ticket');
  const elSubFat = document.getElementById('fin-sub-faturamento');
  const elSubLucro = document.getElementById('fin-sub-lucro');

  if (elFat) elFat.innerText = 'R$ ' + financeiroResumo.faturamento.toFixed(2).replace('.', ',');
  if (elDesp) elDesp.innerText = 'R$ ' + financeiroResumo.despesas.toFixed(2).replace('.', ',');
  if (elLucro) {
    elLucro.innerText = 'R$ ' + financeiroResumo.lucro.toFixed(2).replace('.', ',');
    elLucro.style.color = financeiroResumo.lucro >= 0 ? '#059669' : '#dc2626';
  }
  if (elTicket) elTicket.innerText = 'R$ ' + financeiroResumo.ticketMedio.toFixed(2).replace('.', ',');

  if (elSubFat) {
    elSubFat.innerText = `${financeiroResumo.qtdPedidos} pedidos no período`;
  }
  if (elSubLucro) {
    elSubLucro.innerText = `Margem Líquida: ${financeiroResumo.margem.toFixed(1)}%`;
  }
}

/**
 * Renderiza gráfico e porcentagens de formas de pagamento
 */
function renderizarGraficoPagamentos() {
  const container = document.getElementById('fin-grafico-pagamentos');
  if (!container) return;

  const total = financeiroResumo.faturamento || 1;
  const pctPix = ((financeiroResumo.totalPix / total) * 100).toFixed(1);
  const pctCartao = ((financeiroResumo.totalCartao / total) * 100).toFixed(1);

  container.innerHTML = `
    <div style="background:#fff; padding:16px; border-radius:12px; border:1px solid #e5e7eb; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h4 style="margin:0; font-size:14px; color:var(--text-dark);"><i class="fa-solid fa-chart-pie" style="color:var(--primary);"></i> Formas de Pagamento Recebidas</h4>
        <span style="font-size:12px; color:#6b7280; font-weight:600;">Total: R$ ${financeiroResumo.faturamento.toFixed(2).replace('.', ',')}</span>
      </div>

      <!-- Barra de progresso comparativa -->
      <div style="height:14px; width:100%; border-radius:7px; background:#f1f5f9; display:flex; overflow:hidden; margin-bottom:14px;">
        <div style="width:${pctPix}%; background:#0d9488;" title="PIX: ${pctPix}%"></div>
        <div style="width:${pctCartao}%; background:#2563eb;" title="Cartão: ${pctCartao}%"></div>
      </div>

      <div style="display:flex; justify-content:space-around; flex-wrap:wrap; gap:10px; font-size:12px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:12px; height:12px; border-radius:3px; background:#0d9488; display:inline-block;"></span>
          <div>
            <strong>PIX:</strong> R$ ${financeiroResumo.totalPix.toFixed(2).replace('.', ',')} 
            <span style="color:#0d9488; font-weight:bold;">(${pctPix}%)</span>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:12px; height:12px; border-radius:3px; background:#2563eb; display:inline-block;"></span>
          <div>
            <strong>Cartão:</strong> R$ ${financeiroResumo.totalCartao.toFixed(2).replace('.', ',')} 
            <span style="color:#2563eb; font-weight:bold;">(${pctCartao}%)</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renderiza o Demonstrativo de Resultado (DRE Simplificado)
 */
function renderizarDRE() {
  const container = document.getElementById('fin-dre-simplificado');
  if (!container) return;

  // Agrupa despesas por categoria
  const categoriasDespesas = {};
  for (let i = 0; i < financeiroLancamentos.length; i++) {
    const l = financeiroLancamentos[i];
    if (l.tipo !== 'despesa') continue;
    if (!isDataNoPeriodo(l.data_lancamento, financeiroPeriodoAtual)) continue;

    const cat = l.categoria || 'Outras Despesas';
    categoriasDespesas[cat] = (categoriasDespesas[cat] || 0) + (parseFloat(l.valor) || 0);
  }

  let htmlDespesas = '';
  for (const [cat, val] of Object.entries(categoriasDespesas)) {
    htmlDespesas += `
      <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px; color:#64748b;">
        <span>(-) ${escapeHTML(cat)}</span>
        <span style="color:#dc2626; font-weight:600;">- R$ ${val.toFixed(2).replace('.', ',')}</span>
      </div>
    `;
  }

  if (!htmlDespesas) {
    htmlDespesas = `
      <div style="font-size:11px; color:#94a3b8; font-style:italic; padding:4px 0;">
        Nenhuma despesa operacional lançada neste período.
      </div>
    `;
  }

  container.innerHTML = `
    <div style="background:#fff; padding:16px; border-radius:12px; border:1px solid #e5e7eb; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h4 style="margin:0; font-size:14px; color:var(--text-dark);"><i class="fa-solid fa-file-invoice-dollar" style="color:var(--primary);"></i> DRE Simplificado da Doceria</h4>
        <button onclick="abrirModalNovaDespesa()" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:6px; cursor:pointer;">
          <i class="fa-solid fa-plus"></i> Lançar Despesa
        </button>
      </div>

      <div style="border-bottom:1px solid #f1f5f9; padding-bottom:8px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:bold; color:#0f172a;">
          <span>(+) Receita Bruta de Vendas</span>
          <span style="color:#059669;">R$ ${financeiroResumo.faturamento.toFixed(2).replace('.', ',')}</span>
        </div>
      </div>

      <div style="border-bottom:1px solid #f1f5f9; padding-bottom:8px; margin-bottom:8px;">
        <div style="font-size:12px; font-weight:bold; color:#475569; margin-bottom:4px;">Custos e Despesas Operacionais:</div>
        ${htmlDespesas}
        <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:bold; color:#b91c1c; margin-top:6px;">
          <span>Total de Saídas</span>
          <span>- R$ ${financeiroResumo.despesas.toFixed(2).replace('.', ',')}</span>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; font-size:14px; font-weight:bold; color:#0f172a; padding-top:4px;">
        <span>(=) Lucro Operacional Líquido</span>
        <span style="color:${financeiroResumo.lucro >= 0 ? '#059669' : '#dc2626'};">
          R$ ${financeiroResumo.lucro.toFixed(2).replace('.', ',')}
        </span>
      </div>
    </div>
  `;
}

/**
 * Renderiza o extrato completo de entradas e saídas
 */
function renderizarExtratoFinanceiro() {
  const container = document.getElementById('lista-financeiro-extrato');
  if (!container) return;

  // Unifica pedidos confirmados e lançamentos manuais em uma timeline
  const timeline = [];

  // Adiciona pedidos
  for (let i = 0; i < pedidosGlobal.length; i++) {
    const p = pedidosGlobal[i];
    if (p.status === 'Cancelado') continue;
    const dataBase = p.data_pedido || p.data_entrega || (p.created_at ? p.created_at.split('T')[0] : null);
    if (!isDataNoPeriodo(dataBase, financeiroPeriodoAtual)) continue;

    timeline.push({
      tipo: 'receita',
      origem: 'pedido',
      id: p.id,
      data: dataBase,
      descricao: `Pedido #${p.id} - ${escapeHTML(p.nome_cliente || 'Cliente')}`,
      detalhes: p.itens || '',
      categoria: 'Venda de Doces',
      forma: p.pagamento === 'pix' ? 'PIX' : 'Cartão',
      valor: parseFloat(p.total) || 0
    });
  }

  // Adiciona lançamentos manuais
  for (let i = 0; i < financeiroLancamentos.length; i++) {
    const l = financeiroLancamentos[i];
    if (!isDataNoPeriodo(l.data_lancamento, financeiroPeriodoAtual)) continue;

    timeline.push({
      tipo: l.tipo, // 'receita' ou 'despesa'
      origem: 'manual',
      id: l.id,
      data: l.data_lancamento,
      descricao: l.descricao,
      detalhes: l.observacoes || '',
      categoria: l.categoria || 'Geral',
      forma: l.forma_pagamento ? l.forma_pagamento.toUpperCase() : 'OUTRO',
      valor: parseFloat(l.valor) || 0
    });
  }

  // Ordena por data decrescente
  timeline.sort((a, b) => new Date(b.data) - new Date(a.data));

  // Aplica filtro de tipo (todos, receitas, despesas)
  const filtrados = timeline.filter(t => {
    if (financeiroFiltroTipo === 'receitas') return t.tipo === 'receita';
    if (financeiroFiltroTipo === 'despesas') return t.tipo === 'despesa';
    return true;
  });

  if (filtrados.length === 0) {
    container.innerHTML = "<p style='text-align:center; color:#888; padding:20px;'>Nenhuma movimentação financeira no período selecionado.</p>";
    return;
  }

  let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

  for (let i = 0; i < filtrados.length; i++) {
    const item = filtrados[i];
    const isReceita = item.tipo === 'receita';
    const cor = isReceita ? '#059669' : '#dc2626';
    const sinal = isReceita ? '+ ' : '- ';
    const icone = isReceita ? '<i class="fa-solid fa-arrow-down-left"></i>' : '<i class="fa-solid fa-arrow-up-right"></i>';
    const dataFmt = item.data ? item.data.split('-').reverse().join('/') : '--/--';

    let btnExcluir = '';
    if (item.origem === 'manual') {
      btnExcluir = `
        <button onclick="excluirLancamentoFinanceiro('${item.id}')" style="background:transparent; border:none; color:#9ca3af; hover:color:#dc2626; cursor:pointer; font-size:12px; padding:2px;" title="Excluir lançamento">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      `;
    }

    html += `
      <div style="background:#fff; padding:12px; border-radius:10px; border:1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="width:34px; height:34px; border-radius:8px; background:${isReceita ? '#d1fae5' : '#fee2e2'}; color:${cor}; display:flex; align-items:center; justify-content:center; font-size:14px; shrink:0;">
            ${icone}
          </div>
          <div>
            <div style="font-weight:bold; font-size:13px; color:#1e293b;">${escapeHTML(item.descricao)}</div>
            <div style="font-size:11px; color:#64748b; margin-top:2px;">
              <span>${dataFmt}</span> &bull; 
              <span style="background:#f1f5f9; padding:2px 6px; border-radius:4px;">${escapeHTML(item.categoria)}</span> &bull; 
              <span>${escapeHTML(item.forma)}</span>
            </div>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:10px;">
          <div style="font-size:14px; font-weight:bold; color:${cor}; text-align:right;">
            ${sinal}R$ ${item.valor.toFixed(2).replace('.', ',')}
          </div>
          ${btnExcluir}
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;
}

/**
 * Modal de Novo Lançamento de Despesa ou Receita Extra
 */
function abrirModalNovaDespesa() {
  const modal = document.getElementById('modal-novo-lancamento');
  if (!modal) return;
  const hoje = new Date().toISOString().split('T')[0];
  document.getElementById('fin-novo-data').value = hoje;
  document.getElementById('fin-novo-valor').value = '';
  document.getElementById('fin-novo-desc').value = '';
  document.getElementById('fin-novo-tipo').value = 'despesa';
  modal.style.display = 'flex';
}

function fecharModalNovaDespesa() {
  const modal = document.getElementById('modal-novo-lancamento');
  if (modal) modal.style.display = 'none';
}

async function salvarNovoLancamentoFinanceiro() {
  const tipo = document.getElementById('fin-novo-tipo').value;
  const categoria = document.getElementById('fin-novo-categoria').value;
  const descricao = document.getElementById('fin-novo-desc').value.trim();
  const valor = parseFloat(document.getElementById('fin-novo-valor').value);
  const data = document.getElementById('fin-novo-data').value;
  const forma = document.getElementById('fin-novo-forma').value;

  if (!descricao || isNaN(valor) || valor <= 0) {
    alert('Por favor, informe a descrição e um valor válido.');
    return;
  }

  const btn = document.getElementById('btn-salvar-lancamento');
  const txtOriginal = btn ? btn.innerHTML : 'Salvar';
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';

  const novoItem = {
    tipo,
    categoria,
    descricao,
    valor,
    data_lancamento: data,
    forma_pagamento: forma,
    created_at: new Date().toISOString()
  };

  try {
    const { data: inserted, error } = await supabaseClient
      .from('financeiro_lancamentos')
      .insert(novoItem)
      .select();

    if (error) {
      // Fallback local se a tabela ainda não tiver sido criada no Supabase
      console.warn('Salvando localmente devido a tabela ausente no Supabase:', error.message);
      novoItem.id = 'local_' + Date.now();
      financeiroLancamentos.unshift(novoItem);
      localStorage.setItem('lunoca_financeiro_local', JSON.stringify(financeiroLancamentos));
    } else if (inserted && inserted[0]) {
      financeiroLancamentos.unshift(inserted[0]);
    }

    fecharModalNovaDespesa();
    calcularMetricasFinanceiras();
    atualizarCardsFinanceiro();
    renderizarGraficoPagamentos();
    renderizarDRE();
    renderizarExtratoFinanceiro();

    alert('✅ Lançamento gravado com sucesso!');
  } catch (err) {
    console.error('Erro ao gravar lançamento:', err);
    alert('Erro ao gravar: ' + err.message);
  } finally {
    if (btn) btn.innerHTML = txtOriginal;
  }
}

/**
 * Exclui um lançamento manual
 */
async function excluirLancamentoFinanceiro(id) {
  if (!confirm('Deseja realmente excluir este lançamento financeiro?')) return;

  try {
    if (String(id).startsWith('local_')) {
      financeiroLancamentos = financeiroLancamentos.filter(l => l.id !== id);
      localStorage.setItem('lunoca_financeiro_local', JSON.stringify(financeiroLancamentos));
    } else {
      await supabaseClient.from('financeiro_lancamentos').delete().eq('id', id);
      financeiroLancamentos = financeiroLancamentos.filter(l => l.id != id);
    }

    calcularMetricasFinanceiras();
    atualizarCardsFinanceiro();
    renderizarGraficoPagamentos();
    renderizarDRE();
    renderizarExtratoFinanceiro();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

/**
 * Filtros de período e tipo
 */
function mudarPeriodoFinanceiro(periodo) {
  financeiroPeriodoAtual = periodo;
  document.querySelectorAll('.btn-periodo-fin').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('btn-periodo-' + periodo);
  if (btn) btn.classList.add('active');

  calcularMetricasFinanceiras();
  atualizarCardsFinanceiro();
  renderizarGraficoPagamentos();
  renderizarDRE();
  renderizarExtratoFinanceiro();
}

function filtrarExtratoFinanceiro(tipo) {
  financeiroFiltroTipo = tipo;
  document.querySelectorAll('.btn-filtro-extrato').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('btn-extrato-' + tipo);
  if (btn) btn.classList.add('active');
  renderizarExtratoFinanceiro();
}
