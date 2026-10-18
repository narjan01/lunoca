// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE EXPEDIÇÃO & BALCÃO DE RETIRADA (FRENTE P)
// ==============================================================================
// Responsável pela operação de balcão presencial: conferência de pedidos de retirada,
// validação segura de PIN de uso único gerado pelo cliente, quitação de saldo devedor
// através do motor canônico de pagamento e conclusão da entrega presencial (Migration 031).
// ==============================================================================

let retiradaPedidosCache = [];
let retiradaFiltroAtual = 'todos';
let retiradaBuscaTexto = '';
let retiradaDataAtual = null; // null = todos os pedidos pendentes/agendados

export async function carregarRetiradaAdmin() {
  const container = document.getElementById('admin-tab-retirada');
  if (!container) return;

  const hojeIso = new Date().toISOString().slice(0, 10);

  container.innerHTML = `
    <div class="retirada-admin-header" style="margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h2 style="margin: 0; font-size: 1.5rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-solid fa-store" style="color: var(--primary, #6b2d5c);"></i> Expedição & Balcão de Retirada
        </h2>
        <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.9rem;">
          Check-out presencial, validação de PIN de retirada e quitação de saldo remanescente.
        </p>
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
        <button id="btn-retirada-ver-todos" class="btn ${!retiradaDataAtual ? 'btn-primary' : 'btn-outline'}" style="padding: 0.45rem 0.8rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600; ${!retiradaDataAtual ? 'background: #6b2d5c; color: #fff;' : 'background: #fff; color: #334155; border: 1px solid #cbd5e1;'}">
          <i class="fa-solid fa-list-check"></i> Todos Pendentes
        </button>
        <button id="btn-retirada-ver-hoje" class="btn ${retiradaDataAtual === hojeIso ? 'btn-primary' : 'btn-outline'}" style="padding: 0.45rem 0.8rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600; ${retiradaDataAtual === hojeIso ? 'background: #6b2d5c; color: #fff;' : 'background: #fff; color: #334155; border: 1px solid #cbd5e1;'}">
          <i class="fa-solid fa-calendar-day"></i> Hoje
        </button>
        <input type="date" id="filtro-retirada-data" value="${retiradaDataAtual || ''}" class="form-control" style="padding: 0.45rem 0.75rem; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 0.9rem;" title="Filtrar por data específica">
        <button id="btn-atualizar-retirada" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff;">
          <i class="fa-solid fa-rotate-right"></i> Atualizar
        </button>
      </div>
    </div>

    <!-- CARDS DE MÉTRICAS OPERACIONAIS DO BALCÃO -->
    <div id="retirada-metricas-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #10b981; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">PRONTOS PARA RETIRADA</div>
        <div id="metrica-retirada-prontos" style="font-size: 1.7rem; font-weight: 700; color: #059669; margin-top: 4px;">0</div>
        <div style="font-size: 0.75rem; color: #64748b;">Aguardando chegada do cliente</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #f59e0b; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">COM SALDO A QUITAR</div>
        <div id="metrica-retirada-saldo" style="font-size: 1.7rem; font-weight: 700; color: #d97706; margin-top: 4px;">0</div>
        <div style="font-size: 0.75rem; color: #64748b;">Requer pagamento no balcão</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #6366f1; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">RETIRADOS HOJE</div>
        <div id="metrica-retirada-concluidos" style="font-size: 1.7rem; font-weight: 700; color: #4f46e5; margin-top: 4px;">0</div>
        <div style="font-size: 0.75rem; color: #64748b;">Entregas de balcão concluídas</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #0ea5e9; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">TOTAL RETIRADAS NO PAINEL</div>
        <div id="metrica-retirada-total" style="font-size: 1.7rem; font-weight: 700; color: #0284c7; margin-top: 4px;">0</div>
        <div style="font-size: 0.75rem; color: #64748b;">Pedidos visíveis no filtro</div>
      </div>
    </div>

    <!-- CONTROLES, FILTROS E BUSCA -->
    <div style="background: #fff; border-radius: 10px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button class="btn btn-sm btn-retirada-filtro active" data-filtro="todos" style="padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid #cbd5e1; background: #6b2d5c; color: #fff; cursor: pointer; font-size: 0.85rem;">Todos</button>
          <button class="btn btn-sm btn-retirada-filtro" data-filtro="prontos" style="padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: #334155; cursor: pointer; font-size: 0.85rem;">Prontos para Retirada</button>
          <button class="btn btn-sm btn-retirada-filtro" data-filtro="saldo" style="padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: #334155; cursor: pointer; font-size: 0.85rem;">Aguardando Saldo</button>
          <button class="btn btn-sm btn-retirada-filtro" data-filtro="retirados" style="padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: #334155; cursor: pointer; font-size: 0.85rem;">Retirados</button>
        </div>
        <div style="position: relative; min-width: 260px;">
          <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 10px; top: 11px; color: #94a3b8; font-size: 0.85rem;"></i>
          <input type="text" id="retirada-busca-input" placeholder="Buscar pedido, cliente ou telefone..." style="width: 100%; padding: 0.45rem 0.75rem 0.45rem 2rem; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 0.85rem; box-sizing: border-box;">
        </div>
      </div>
    </div>

    <!-- LISTAGEM DE PEDIDOS -->
    <div id="retirada-tabela-container" style="background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); overflow-x: auto;">
      <div style="padding: 2rem; text-align: center; color: #64748b;">
        <i class="fa-solid fa-spinner fa-spin fa-2x" style="color: #6b2d5c; margin-bottom: 0.5rem; display: block;"></i>
        Carregando pedidos de retirada...
      </div>
    </div>

    <!-- MODAL DE CHECKOUT NO BALCÃO -->
    <div id="modal-checkout-balcao" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center; padding: 1rem;">
      <div style="background: #fff; border-radius: 12px; width: 100%; max-width: 520px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); overflow: hidden; max-height: 90vh; display: flex; flex-direction: column;">
        <div style="padding: 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; background: #faf5f8;">
          <h3 style="margin: 0; font-size: 1.15rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
            <i class="fa-solid fa-cash-register" style="color: #6b2d5c;"></i> Check-out & Retirada no Balcão
          </h3>
          <button id="btn-fechar-modal-checkout" style="background: transparent; border: none; font-size: 1.25rem; cursor: pointer; color: #64748b;">&times;</button>
        </div>
        <div id="modal-checkout-corpo" style="padding: 1.25rem; overflow-y: auto; flex: 1;">
          <!-- Preenchido dinamicamente -->
        </div>
      </div>
    </div>
  `;

  configurarEventosRetirada();
  await carregarDadosRetirada();
}

function configurarEventosRetirada() {
  const btnAtualizar = document.getElementById('btn-atualizar-retirada');
  if (btnAtualizar) {
    btnAtualizar.addEventListener('click', () => carregarDadosRetirada());
  }

  const btnVerTodos = document.getElementById('btn-retirada-ver-todos');
  if (btnVerTodos) {
    btnVerTodos.addEventListener('click', () => {
      retiradaDataAtual = null;
      const dtInput = document.getElementById('filtro-retirada-data');
      if (dtInput) dtInput.value = '';
      carregarRetiradaAdmin();
    });
  }

  const btnVerHoje = document.getElementById('btn-retirada-ver-hoje');
  if (btnVerHoje) {
    btnVerHoje.addEventListener('click', () => {
      retiradaDataAtual = new Date().toISOString().slice(0, 10);
      const dtInput = document.getElementById('filtro-retirada-data');
      if (dtInput) dtInput.value = retiradaDataAtual;
      carregarRetiradaAdmin();
    });
  }

  const dtFiltro = document.getElementById('filtro-retirada-data');
  if (dtFiltro) {
    dtFiltro.addEventListener('change', (e) => {
      retiradaDataAtual = e.target.value || null;
      carregarRetiradaAdmin();
    });
  }

  const inputBusca = document.getElementById('retirada-busca-input');
  if (inputBusca) {
    inputBusca.addEventListener('input', (e) => {
      retiradaBuscaTexto = e.target.value.toLowerCase().trim();
      renderizarTabelaRetirada();
    });
  }

  document.querySelectorAll('.btn-retirada-filtro').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-retirada-filtro').forEach((b) => {
        b.classList.remove('active');
        b.style.background = '#fff';
        b.style.color = '#334155';
      });
      const t = e.currentTarget;
      t.classList.add('active');
      t.style.background = '#6b2d5c';
      t.style.color = '#fff';
      retiradaFiltroAtual = t.dataset.filtro;
      renderizarTabelaRetirada();
    });
  });

  const btnFecharModal = document.getElementById('btn-fechar-modal-checkout');
  if (btnFecharModal) {
    btnFecharModal.addEventListener('click', fecharModalCheckout);
  }
}

async function carregarDadosRetirada() {
  const containerTabela = document.getElementById('retirada-tabela-container');
  if (containerTabela) {
    containerTabela.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: #64748b;">
        <i class="fa-solid fa-spinner fa-spin fa-2x" style="color: #6b2d5c; margin-bottom: 0.5rem; display: block;"></i>
        Atualizando lista de pedidos de retirada...
      </div>
    `;
  }

  try {
    const { data, error } = await supabaseClient.rpc('obter_painel_balcao_retiradas', {
      p_data: retiradaDataAtual || null
    });

    if (error || !data || !data.success) {
      if (containerTabela) {
        containerTabela.innerHTML = `
          <div style="padding: 2rem; text-align: center; color: #ef4444;">
            <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 0.5rem; display: block;"></i>
            Erro ao carregar pedidos de retirada: ${(error?.message || data?.error || 'Falha de comunicação')}
          </div>
        `;
      }
      return;
    }

    retiradaPedidosCache = (data.pedidos || []).map(p => ({
      id: p.pedido_id || p.id,
      numero: p.numero || p.pedido_id || p.id,
      cliente_nome: p.cliente_nome,
      cliente_telefone: p.cliente_telefone,
      data_entrega: p.data_entrega,
      hora_entrega: p.horario_entrega || p.hora_entrega,
      total: p.valor_total != null ? p.valor_total : (p.total != null ? p.total : 0),
      saldo: p.saldo_devedor != null ? p.saldo_devedor : (p.saldo != null ? p.saldo : 0),
      valor_pago: p.valor_pago != null ? p.valor_pago : 0,
      status_comercial: p.status_comercial,
      status_operacional: p.status_operacional,
      status_financeiro: p.status_financeiro,
      quality_hold_ativo: p.quality_hold_ativo,
      possui_pin_ativo: p.possui_pin_ativo,
      autorizacao_status: p.possui_pin_ativo ? 'ATIVA' : 'SEM_PIN'
    }));

    atualizarMetricasRetirada(retiradaPedidosCache);
    renderizarTabelaRetirada();
  } catch (err) {
    if (containerTabela) {
      containerTabela.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: #ef4444;">
          <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom: 0.5rem; display: block;"></i>
          Erro inesperado: ${err.message}
        </div>
      `;
    }
  }
}

function atualizarMetricasRetirada(pedidos) {
  const prontos = pedidos.filter((p) => p.status_operacional === 'pronto').length;
  const comSaldo = pedidos.filter((p) => Number(p.saldo || 0) > 0 && p.status_operacional !== 'retirado' && p.status_operacional !== 'cancelado').length;
  const concluidos = pedidos.filter((p) => p.status_operacional === 'retirado').length;
  const total = pedidos.length;

  const elProntos = document.getElementById('metrica-retirada-prontos');
  const elSaldo = document.getElementById('metrica-retirada-saldo');
  const elConcluidos = document.getElementById('metrica-retirada-concluidos');
  const elTotal = document.getElementById('metrica-retirada-total');

  if (elProntos) elProntos.textContent = prontos;
  if (elSaldo) elSaldo.textContent = comSaldo;
  if (elConcluidos) elConcluidos.textContent = concluidos;
  if (elTotal) elTotal.textContent = total;
}

function renderizarTabelaRetirada() {
  const container = document.getElementById('retirada-tabela-container');
  if (!container) return;

  let filtrados = [...retiradaPedidosCache];

  if (retiradaFiltroAtual === 'prontos') {
    filtrados = filtrados.filter((p) => p.status_operacional === 'pronto');
  } else if (retiradaFiltroAtual === 'saldo') {
    filtrados = filtrados.filter((p) => Number(p.saldo || 0) > 0 && p.status_operacional !== 'retirado');
  } else if (retiradaFiltroAtual === 'retirados') {
    filtrados = filtrados.filter((p) => p.status_operacional === 'retirado');
  }

  if (retiradaBuscaTexto) {
    filtrados = filtrados.filter((p) => {
      const num = String(p.numero || p.id || '').toLowerCase();
      const cli = String(p.cliente_nome || '').toLowerCase();
      const tel = String(p.cliente_telefone || '').toLowerCase();
      return num.includes(retiradaBuscaTexto) || cli.includes(retiradaBuscaTexto) || tel.includes(retiradaBuscaTexto);
    });
  }

  if (filtrados.length === 0) {
    container.innerHTML = `
      <div style="padding: 3rem 1rem; text-align: center; color: #64748b;">
        <i class="fa-solid fa-box-open fa-3x" style="color: #cbd5e1; margin-bottom: 0.75rem; display: block;"></i>
        <div style="font-weight: 600; font-size: 1.1rem; color: #334155;">Nenhum pedido de retirada encontrado</div>
        <p style="margin: 0.25rem 0 0; font-size: 0.85rem;">Não há encomendas com os filtros selecionados para esta data.</p>
      </div>
    `;
    return;
  }

  let html = `
    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.875rem;">
      <thead>
        <tr style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; color: #475569; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;">
          <th style="padding: 0.75rem 1rem;">Pedido</th>
          <th style="padding: 0.75rem 1rem;">Cliente</th>
          <th style="padding: 0.75rem 1rem;">Horário</th>
          <th style="padding: 0.75rem 1rem;">Status Produção</th>
          <th style="padding: 0.75rem 1rem;">Financeiro</th>
          <th style="padding: 0.75rem 1rem;">Autorização PIN</th>
          <th style="padding: 0.75rem 1rem; text-align: right;">Ações de Balcão</th>
        </tr>
      </thead>
      <tbody style="divide-y divide-gray-100;">
  `;

  filtrados.forEach((p) => {
    const isRetirado = p.status_operacional === 'retirado';
    const isPronto = p.status_operacional === 'pronto';
    const saldoNum = Number(p.saldo || 0);
    const temSaldo = saldoNum > 0.01;

    let badgeStatus = '';
    if (isRetirado) {
      badgeStatus = `<span style="background: #e0e7ff; color: #3730a3; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;"><i class="fa-solid fa-check"></i> Retirado</span>`;
    } else if (isPronto) {
      badgeStatus = `<span style="background: #dcfce7; color: #166534; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;"><i class="fa-solid fa-bell"></i> Pronto</span>`;
    } else {
      badgeStatus = `<span style="background: #f1f5f9; color: #475569; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;">${p.status_operacional}</span>`;
    }

    let badgeFin = '';
    if (!temSaldo) {
      badgeFin = `<span style="background: #ecfdf5; color: #047857; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;">Quitado</span>`;
    } else {
      badgeFin = `<span style="background: #fffbeb; color: #b45309; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;">Saldo: R$ ${saldoNum.toFixed(2).replace('.', ',')}</span>`;
    }

    let badgePin = '';
    if (p.autorizacao_status === 'ATIVA') {
      badgePin = `<span style="background: #f3e8ff; color: #7e22ce; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;"><i class="fa-solid fa-key"></i> PIN Ativo</span>`;
    } else if (p.autorizacao_status === 'CONSUMIDA') {
      badgePin = `<span style="background: #e2e8f0; color: #475569; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;">Consumido</span>`;
    } else if (p.autorizacao_status === 'BLOQUEADA') {
      badgePin = `<span style="background: #fee2e2; color: #b91c1c; padding: 3px 8px; border-radius: 12px; font-weight: 600; font-size: 0.75rem;">Bloqueado</span>`;
    } else {
      badgePin = `<span style="color: #94a3b8; font-size: 0.75rem;">Sem PIN emitido</span>`;
    }

    html += `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 0.75rem 1rem;">
          <strong style="color: #1e293b;">#${p.numero || p.id}</strong>
          <div style="font-size: 0.75rem; color: #64748b;">R$ ${Number(p.total || 0).toFixed(2).replace('.', ',')}</div>
        </td>
        <td style="padding: 0.75rem 1rem;">
          <div style="font-weight: 600; color: #334155;">${escapeHtml(p.cliente_nome || 'Cliente')}</div>
          <div style="font-size: 0.75rem; color: #64748b;">${escapeHtml(p.cliente_telefone || '')}</div>
        </td>
        <td style="padding: 0.75rem 1rem; color: #475569;">
          <div><i class="fa-regular fa-calendar"></i> ${p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '--'}</div>
          <div style="font-size: 0.75rem; color: #64748b;"><i class="fa-regular fa-clock"></i> ${p.hora_entrega ? String(p.hora_entrega).slice(0, 5) : '--:--'}</div>
        </td>
        <td style="padding: 0.75rem 1rem;">${badgeStatus}</td>
        <td style="padding: 0.75rem 1rem;">${badgeFin}</td>
        <td style="padding: 0.75rem 1rem;">${badgePin}</td>
        <td style="padding: 0.75rem 1rem; text-align: right;">
          ${isRetirado
            ? `<span style="color: #10b981; font-weight: 600; font-size: 0.8rem;"><i class="fa-solid fa-circle-check"></i> Entregue</span>`
            : isPronto
              ? `<button class="btn btn-sm btn-abrir-checkout" data-pedido-id="${p.id}" style="padding: 0.35rem 0.75rem; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-size: 0.8rem; font-weight: 600;">
                  <i class="fa-solid fa-cash-register"></i> Realizar Retirada
                </button>`
              : `<button type="button" onclick="if(typeof mudarTabAdmin==='function') mudarTabAdmin('kds')" class="btn btn-sm btn-outline" style="padding: 0.35rem 0.75rem; border-radius: 6px; color: #0284c7; border: 1px solid #7dd3fc; background: #f0f9ff; cursor: pointer; font-size: 0.8rem; font-weight: 600;" title="Avançar produção no KDS para liberar a retirada">
                  <i class="fa-solid fa-desktop"></i> Ver no KDS
                </button>`
          }
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;

  container.querySelectorAll('.btn-abrir-checkout').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const pid = Number(e.currentTarget.dataset.pedidoId);
      abrirModalCheckout(pid);
    });
  });
}

function abrirModalCheckout(pedidoId) {
  const p = retiradaPedidosCache.find((item) => Number(item.id) === pedidoId);
  if (!p) return;

  const modal = document.getElementById('modal-checkout-balcao');
  const corpo = document.getElementById('modal-checkout-corpo');
  if (!modal || !corpo) return;

  const saldoNum = Number(p.saldo || 0);
  const temSaldo = saldoNum > 0.01;

  corpo.innerHTML = `
    <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem; border: 1px solid #e2e8f0;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <div>
          <strong style="font-size: 1.1rem; color: #1e293b;">Pedido #${p.numero || p.id}</strong>
          <span style="font-size: 0.8rem; color: #64748b; margin-left: 0.5rem;">${escapeHtml(p.cliente_nome || '')}</span>
        </div>
        <span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600;">Pronto para Retirada</span>
      </div>
      <div style="font-size: 0.85rem; color: #475569; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.5rem; border-top: 1px solid #e2e8f0; padding-top: 0.5rem;">
        <div>Total: <strong>R$ ${Number(p.total || 0).toFixed(2).replace('.', ',')}</strong></div>
        <div>Pago: <strong style="color: #059669;">R$ ${Number(p.valor_pago || 0).toFixed(2).replace('.', ',')}</strong></div>
        <div>Saldo: <strong style="color: ${temSaldo ? '#d97706' : '#059669'};">R$ ${saldoNum.toFixed(2).replace('.', ',')}</strong></div>
      </div>
    </div>

    <!-- VALIDAÇÃO DO PIN -->
    <div style="margin-bottom: 1.25rem;">
      <label style="display: block; font-weight: 600; font-size: 0.875rem; color: #334155; margin-bottom: 0.25rem;">
        <i class="fa-solid fa-key" style="color: #6b2d5c;"></i> PIN de Retirada do Cliente
      </label>
      <input type="text" id="checkout-pin-input" maxlength="6" placeholder="000000" style="width: 100%; text-align: center; letter-spacing: 0.4em; font-size: 1.5rem; font-weight: 700; padding: 0.5rem; border-radius: 8px; border: 2px solid #cbd5e1; box-sizing: border-box; color: #1e293b;">
      <small style="color: #64748b; font-size: 0.75rem; display: block; margin-top: 0.25rem;">
        Código de 6 dígitos gerado pelo cliente em "Minha Conta".
      </small>
    </div>

    <!-- QUITAÇÃO DE SALDO -->
    ${temSaldo ? `
      <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
          <div style="font-weight: 700; color: #b45309; font-size: 0.9rem;">
            <i class="fa-solid fa-triangle-exclamation"></i> Saldo Pendente: R$ ${saldoNum.toFixed(2).replace('.', ',')}
          </div>
          <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; font-weight: 600; color: #334155; cursor: pointer;">
            <input type="checkbox" id="checkout-quitar-saldo-chk" checked disabled> Quitar no Balcão
          </label>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <label style="font-size: 0.8rem; font-weight: 600; color: #475569; display: block; margin-bottom: 0.25rem;">Forma de Pagamento:</label>
          <select id="checkout-forma-pagamento" style="width: 100%; padding: 0.45rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
            <option value="cartao_debito">Cartão de Débito (Máquina Balcão)</option>
            <option value="cartao_credito">Cartão de Crédito (Máquina Balcão)</option>
            <option value="pix_balcao">PIX Balcão (Chave QR Loja)</option>
            <option value="dinheiro_especie">Dinheiro em Espécie</option>
          </select>
        </div>
      </div>
    ` : ''}

    <div id="checkout-erro-msg" style="display: none; background: #fee2e2; color: #b91c1c; padding: 0.75rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem;"></div>

    <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
      <button type="button" id="btn-cancelar-checkout" class="btn" style="padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer;">Cancelar</button>
      <button type="button" id="btn-confirmar-checkout" class="btn btn-primary" style="padding: 0.5rem 1.25rem; border-radius: 8px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-weight: 600;">
        <i class="fa-solid fa-check"></i> Confirmar Retirada
      </button>
    </div>
  `;

  document.getElementById('btn-cancelar-checkout')?.addEventListener('click', fecharModalCheckout);
  document.getElementById('btn-confirmar-checkout')?.addEventListener('click', () => executarCheckoutBalcao(pedidoId, temSaldo));

  modal.style.display = 'flex';
  document.getElementById('checkout-pin-input')?.focus();
}

function fecharModalCheckout() {
  const modal = document.getElementById('modal-checkout-balcao');
  if (modal) modal.style.display = 'none';
}

async function executarCheckoutBalcao(pedidoId, temSaldo) {
  const pinInput = document.getElementById('checkout-pin-input');
  const erroBox = document.getElementById('checkout-erro-msg');
  const btnConfirmar = document.getElementById('btn-confirmar-checkout');

  if (erroBox) erroBox.style.display = 'none';

  const pin = (pinInput?.value || '').trim();
  if (pin.length !== 6) {
    if (erroBox) {
      erroBox.textContent = 'Por favor, informe o PIN de retirada completo (6 dígitos).';
      erroBox.style.display = 'block';
    }
    pinInput?.focus();
    return;
  }

  let formaPagamento = null;
  if (temSaldo) {
    const selForma = document.getElementById('checkout-forma-pagamento');
    formaPagamento = selForma ? selForma.value : 'cartao_debito';
  }

  const idempotencyKey = 'balcao_chk_' + pedidoId + '_' + Date.now();

  try {
    if (btnConfirmar) {
      btnConfirmar.disabled = true;
      btnConfirmar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando Retirada...';
    }

    const { data, error } = await supabaseClient.rpc('finalizar_checkout_retirada_balcao', {
      p_pedido_id: pedidoId,
      p_pin: pin,
      p_quitar_saldo: temSaldo,
      p_forma_pagamento: formaPagamento,
      p_chave_idempotencia: idempotencyKey
    });

    if (error || !data || !data.success) {
      const msg = error?.message || data?.error || 'Não foi possível concluir a retirada.';
      if (erroBox) {
        erroBox.textContent = msg;
        erroBox.style.display = 'block';
      }
      if (btnConfirmar) {
        btnConfirmar.disabled = false;
        btnConfirmar.innerHTML = '<i class="fa-solid fa-check"></i> Confirmar Retirada';
      }
      return;
    }

    fecharModalCheckout();
    if (typeof mostrarToast === 'function') {
      mostrarToast('Retirada do Pedido #' + pedidoId + ' concluída com sucesso!', 'sucesso', 4000);
    } else {
      alert('Retirada concluída com sucesso!');
    }

    await carregarDadosRetirada();
  } catch (err) {
    if (erroBox) {
      erroBox.textContent = 'Erro inesperado: ' + err.message;
      erroBox.style.display = 'block';
    }
    if (btnConfirmar) {
      btnConfirmar.disabled = false;
      btnConfirmar.innerHTML = '<i class="fa-solid fa-check"></i> Confirmar Retirada';
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Exposição global para o ecossistema admin
if (typeof window !== 'undefined') {
  window.carregarRetiradaAdmin = carregarRetiradaAdmin;
  window.abrirModalCheckoutBalcao = abrirModalCheckout;
}
