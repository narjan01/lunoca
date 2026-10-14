// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE EQUIPE, ESCALAS & CAPACIDADE REAL (FRENTE O)
// ==============================================================================
// Responsável pela gestão de colaboradores (sem RH/folha), turnos, escalas de trabalho,
// ausências/folgas operacionais e cálculo da capacidade humana líquida planejada
// confrontada com a demanda de produção por função (Migration 030).
// ==============================================================================

let equipeColaboradoresCache = [];
let equipeFuncoesCache = [];
let equipeEscalasCache = [];
let equipeCapacidadeCache = null;
let equipeSubTabAtual = 'capacidade';
let equipeDataFiltro = new Date().toISOString().slice(0, 10);

export async function carregarEquipeAdmin() {
  const container = document.getElementById('admin-tab-equipe');
  if (!container) return;

  const usuarioAtual = JSON.parse(sessionStorage.getItem('lunoca_usuario') || '{}');
  if (usuarioAtual.nivel === 'operador') {
    await renderizarVisaoOperadorEquipe(container);
    return;
  }

  container.innerHTML = `
    <div class="equipe-admin-header" style="margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h2 style="margin: 0; font-size: 1.5rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-solid fa-users-gear" style="color: var(--primary, #6b2d5c);"></i> Central de Equipe, Escalas & Capacidade
        </h2>
        <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.9rem;">
          Gestão operacional de turnos, escalas líquidas e confronto entre capacidade humana e demanda por função.
        </p>
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button id="btn-atualizar-equipe" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff;">
          <i class="fa-solid fa-rotate-right"></i> Atualizar
        </button>
        <button id="btn-novo-colaborador" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; border: 1px solid #6b2d5c; color: #6b2d5c; background: #fff;">
          <i class="fa-solid fa-user-plus"></i> Novo Colaborador
        </button>
        <button id="btn-nova-ausencia" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; border: 1px solid #d97706; color: #d97706; background: #fff;">
          <i class="fa-solid fa-calendar-xmark"></i> Registrar Ausência
        </button>
        <button id="btn-nova-escala" class="btn btn-primary" style="padding: 0.5rem 1rem; border-radius: 8px; background: #6b2d5c; color: #fff; border: none; cursor: pointer;">
          <i class="fa-solid fa-calendar-plus"></i> Nova Escala
        </button>
      </div>
    </div>

    <!-- CARDS DE MÉTRICAS OPERACIONAIS DO DIA -->
    <div id="equipe-metricas-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #0ea5e9; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">CAPACIDADE LÍQUIDA PLANEJADA</div>
        <div id="metrica-equipe-capacidade" style="font-size: 1.7rem; font-weight: 700; color: #0284c7; margin-top: 4px;">-- h</div>
        <div id="metrica-equipe-colabs-ativos" style="font-size: 0.75rem; color: #64748b;">-- colaboradores escalados</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #8b5cf6; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">DEMANDA DE PRODUÇÃO</div>
        <div id="metrica-equipe-demanda" style="font-size: 1.7rem; font-weight: 700; color: #7c3aed; margin-top: 4px;">-- h</div>
        <div style="font-size: 0.75rem; color: #64748b;">calculada via tempos padrão</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #10b981; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">UTILIZAÇÃO DA EQUIPE</div>
        <div id="metrica-equipe-utilizacao" style="font-size: 1.7rem; font-weight: 700; color: #059669; margin-top: 4px;">--%</div>
        <div id="metrica-equipe-status-ocupacao" style="font-size: 0.75rem; color: #059669; font-weight: 600;">Carga Adequada</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 10px; border-left: 4px solid #f59e0b; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
        <div style="font-size: 0.8rem; color: #64748b; font-weight: 600;">SOBRECARGA & GARGALOS</div>
        <div id="metrica-equipe-sobrecarga" style="font-size: 1.3rem; font-weight: 700; color: #d97706; margin-top: 6px;">Nenhum</div>
        <div style="font-size: 0.75rem; color: #64748b;">monitoramento proativo</div>
      </div>
    </div>

    <!-- NAVEGAÇÃO DE SUB-ABAS -->
    <div style="display: flex; gap: 0.5rem; border-bottom: 2px solid #e2e8f0; margin-bottom: 1.5rem; overflow-x: auto;">
      <button id="subtab-capacidade-btn" class="subtab-btn-equipe active" style="padding: 0.6rem 1.2rem; background: none; border: none; border-bottom: 3px solid #6b2d5c; font-weight: 700; cursor: pointer; color: #6b2d5c; white-space: nowrap;">
        <i class="fa-solid fa-chart-column"></i> Capacidade do Dia & Gargalos
      </button>
      <button id="subtab-escalas-btn" class="subtab-btn-equipe" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #64748b; white-space: nowrap;">
        <i class="fa-solid fa-calendar-days"></i> Escalas & Turnos
      </button>
      <button id="subtab-colaboradores-btn" class="subtab-btn-equipe" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #64748b; white-space: nowrap;">
        <i class="fa-solid fa-users"></i> Colaboradores & Funções
      </button>
      <button id="subtab-ausencias-btn" class="subtab-btn-equipe" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #64748b; white-space: nowrap;">
        <i class="fa-solid fa-umbrella-beach"></i> Ausências & Folgas
      </button>
    </div>

    <!-- CONTEÚDO DAS SUB-ABAS -->
    <div id="equipe-subtab-conteudo"></div>

    <!-- MODAIS OPERACIONAIS -->
    <div id="modal-equipe-container"></div>
  `;

  vincularEventosEquipe();
  await carregarDadosIniciaisEquipe();
  renderizarSubTabEquipe(equipeSubTabAtual);
}

function vincularEventosEquipe() {
  document.getElementById('btn-atualizar-equipe')?.addEventListener('click', async () => {
    await carregarDadosIniciaisEquipe();
    renderizarSubTabEquipe(equipeSubTabAtual);
  });

  document.getElementById('subtab-capacidade-btn')?.addEventListener('click', () => trocarSubTabEquipe('capacidade'));
  document.getElementById('subtab-escalas-btn')?.addEventListener('click', () => trocarSubTabEquipe('escalas'));
  document.getElementById('subtab-colaboradores-btn')?.addEventListener('click', () => trocarSubTabEquipe('colaboradores'));
  document.getElementById('subtab-ausencias-btn')?.addEventListener('click', () => trocarSubTabEquipe('ausencias'));

  document.getElementById('btn-novo-colaborador')?.addEventListener('click', () => abrirModalNovoColaborador());
  document.getElementById('btn-nova-escala')?.addEventListener('click', () => abrirModalNovaEscala());
  document.getElementById('btn-nova-ausencia')?.addEventListener('click', () => abrirModalNovaAusencia());
}

function trocarSubTabEquipe(tab) {
  equipeSubTabAtual = tab;
  document.querySelectorAll('.subtab-btn-equipe').forEach((btn) => {
    btn.style.borderBottom = 'none';
    btn.style.color = '#64748b';
    btn.style.fontWeight = '600';
  });
  const ativo = document.getElementById(`subtab-${tab}-btn`);
  if (ativo) {
    ativo.style.borderBottom = '3px solid #6b2d5c';
    ativo.style.color = '#6b2d5c';
    ativo.style.fontWeight = '700';
  }
  renderizarSubTabEquipe(tab);
}

async function carregarDadosIniciaisEquipe() {
  try {
    const sb = window.supabase;
    if (!sb) return;

    // 1. Obter funções cadastradas
    const { data: funcoes } = await sb.from('funcoes_equipe').select('*').order('ordem');
    equipeFuncoesCache = funcoes || [];

    // 2. Obter colaboradores
    const { data: colabs } = await sb.from('colaboradores').select('*, colaborador_funcoes(funcao_id, principal)').order('nome');
    equipeColaboradoresCache = colabs || [];

    // 3. Obter painel de capacidade da data atual
    const { data: capRes } = await sb.rpc('obter_painel_capacidade_equipe', {
      p_data_inicio: equipeDataFiltro,
      p_data_fim: equipeDataFiltro
    });
    equipeCapacidadeCache = capRes && capRes.success ? capRes : null;

    atualizarMetricasCabecalhoEquipe();
  } catch (err) {
    console.error('Erro ao carregar dados iniciais de equipe:', err);
  }
}

function atualizarMetricasCabecalhoEquipe() {
  if (!equipeCapacidadeCache || !equipeCapacidadeCache.dias || equipeCapacidadeCache.dias.length === 0) {
    return;
  }

  const dia = equipeCapacidadeCache.dias[0];
  const totalCapMin = Number(dia.total_capacidade_minutos || 0);
  const totalDemMin = Number(dia.total_demanda_minutos || 0);
  const colabsEscalados = dia.colaboradores_escalados || 0;

  const capHoras = (totalCapMin / 60).toFixed(1);
  const demHoras = (totalDemMin / 60).toFixed(1);
  const ocupacao = totalCapMin > 0 ? ((totalDemMin / totalCapMin) * 100).toFixed(1) : 0;

  const elCap = document.getElementById('metrica-equipe-capacidade');
  if (elCap) elCap.textContent = `${capHoras} h`;

  const elColabs = document.getElementById('metrica-equipe-colabs-ativos');
  if (elColabs) elColabs.textContent = `${colabsEscalados} colaboradores escalados`;

  const elDem = document.getElementById('metrica-equipe-demanda');
  if (elDem) elDem.textContent = `${demHoras} h`;

  const elUtil = document.getElementById('metrica-equipe-utilizacao');
  const elStatus = document.getElementById('metrica-equipe-status-ocupacao');
  if (elUtil) elUtil.textContent = `${ocupacao}%`;

  const elSobrecarga = document.getElementById('metrica-equipe-sobrecarga');

  if (ocupacao >= 120) {
    if (elUtil) elUtil.style.color = '#dc2626';
    if (elStatus) {
      elStatus.textContent = 'Sobrecarga Crítica (> 120%)';
      elStatus.style.color = '#dc2626';
    }
    if (elSobrecarga) {
      elSobrecarga.textContent = 'CRÍTICA';
      elSobrecarga.style.color = '#dc2626';
    }
  } else if (ocupacao >= 100) {
    if (elUtil) elUtil.style.color = '#ea580c';
    if (elStatus) {
      elStatus.textContent = 'Carga Máxima Atingida';
      elStatus.style.color = '#ea580c';
    }
    if (elSobrecarga) {
      elSobrecarga.textContent = 'ALERTA ALTO';
      elSobrecarga.style.color = '#ea580c';
    }
  } else if (ocupacao >= 80) {
    if (elUtil) elUtil.style.color = '#d97706';
    if (elStatus) {
      elStatus.textContent = 'Atenção (≥ 80%)';
      elStatus.style.color = '#d97706';
    }
    if (elSobrecarga) {
      elSobrecarga.textContent = 'ATENÇÃO';
      elSobrecarga.style.color = '#d97706';
    }
  } else {
    if (elUtil) elUtil.style.color = '#059669';
    if (elStatus) {
      elStatus.textContent = 'Carga Equilibrada';
      elStatus.style.color = '#059669';
    }
    if (elSobrecarga) {
      elSobrecarga.textContent = 'Normal';
      elSobrecarga.style.color = '#059669';
    }
  }
}

function renderizarSubTabEquipe(tab) {
  const container = document.getElementById('equipe-subtab-conteudo');
  if (!container) return;

  switch (tab) {
    case 'capacidade':
      renderizarCapacidadeDoDia(container);
      break;
    case 'escalas':
      renderizarEscalasEquipe(container);
      break;
    case 'colaboradores':
      renderizarColaboradoresEquipe(container);
      break;
    case 'ausencias':
      renderizarAusenciasEquipe(container);
      break;
  }
}

// ------------------------------------------------------------------------------
// SUB-ABA 1: CAPACIDADE DO DIA & GARGALOS POR FUNÇÃO
// ------------------------------------------------------------------------------
function renderizarCapacidadeDoDia(container) {
  const dia = equipeCapacidadeCache?.dias?.[0] || { funcoes: [] };

  let funcoesHtml = '';
  if (!dia.funcoes || dia.funcoes.length === 0) {
    funcoesHtml = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: #64748b;">
          Nenhuma escala planejada para esta data. Clique em <strong>Nova Escala</strong> para alocar a equipe.
        </td>
      </tr>
    `;
  } else {
    dia.funcoes.forEach((f) => {
      const capMin = Number(f.capacidade_planejada_minutos || 0);
      const demMin = Number(f.demanda_minutos || 0);
      const capHoras = (capMin / 60).toFixed(1);
      const demHoras = (demMin / 60).toFixed(1);
      const util = Number(f.percentual_ocupacao || 0);

      let corBarra = '#10b981';
      let tagStatus = '<span style="color: #059669; font-weight: 700; background: #ecfdf5; padding: 2px 8px; border-radius: 6px;">Normal</span>';
      if (util >= 120) {
        corBarra = '#dc2626';
        tagStatus = '<span style="color: #dc2626; font-weight: 700; background: #fef2f2; padding: 2px 8px; border-radius: 6px;">Crítico</span>';
      } else if (util >= 100) {
        corBarra = '#ea580c';
        tagStatus = '<span style="color: #ea580c; font-weight: 700; background: #fff7ed; padding: 2px 8px; border-radius: 6px;">Alto</span>';
      } else if (util >= 80) {
        corBarra = '#f59e0b';
        tagStatus = '<span style="color: #d97706; font-weight: 700; background: #fffbeb; padding: 2px 8px; border-radius: 6px;">Atenção</span>';
      }

      const larguraBarra = Math.min(util, 100);

      funcoesHtml += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 16px; font-weight: 600; color: #1e293b;">
            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${f.funcao_cor || '#6b2d5c'}; margin-right: 8px;"></span>
            ${f.funcao_nome}
          </td>
          <td style="padding: 12px 16px; color: #64748b;">${f.colaboradores_escalados} colab(s)</td>
          <td style="padding: 12px 16px; font-weight: 600; color: #0284c7;">${capHoras} h (${capMin} min)</td>
          <td style="padding: 12px 16px; font-weight: 600; color: #7c3aed;">${demHoras} h (${demMin} min)</td>
          <td style="padding: 12px 16px; width: 220px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
                <div style="width: ${larguraBarra}%; height: 100%; background: ${corBarra}; border-radius: 4px;"></div>
              </div>
              <span style="font-size: 0.8rem; font-weight: 700; color: ${corBarra}; min-width: 45px;">${util}%</span>
            </div>
          </td>
          <td style="padding: 12px 16px;">${tagStatus}</td>
          <td style="padding: 12px 16px; text-align: right;">
            <button onclick="window.filtrarEscalasPorFuncao('${f.funcao_id}')" class="btn-outline" style="padding: 4px 8px; font-size: 11px; border-radius: 6px; border: 1px solid #cbd5e1;">
              Ver Escala
            </button>
          </td>
        </tr>
      `;
    });
  }

  container.innerHTML = `
    <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem; margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <label style="font-weight: 600; font-size: 0.9rem; color: #1e293b;">Data de Análise:</label>
          <input type="date" id="filtro-data-equipe" value="${equipeDataFiltro}" style="padding: 6px 12px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.9rem;">
          <button id="btn-aplicar-data-equipe" class="btn-primary" style="padding: 6px 12px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-size: 0.85rem;">
            Filtrar
          </button>
        </div>
        <div style="font-size: 0.85rem; color: #64748b;">
          * A demanda em minutos utiliza os tempos de preparo da Frente M (Engenharia de Custos).
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 0.75rem; text-transform: uppercase;">
              <th style="padding: 10px 16px;">Função Operacional</th>
              <th style="padding: 10px 16px;">Equipe Alocada</th>
              <th style="padding: 10px 16px;">Capacidade Humana</th>
              <th style="padding: 10px 16px;">Demanda Pedidos</th>
              <th style="padding: 10px 16px;">Nível de Ocupação</th>
              <th style="padding: 10px 16px;">Status</th>
              <th style="padding: 10px 16px; text-align: right;">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${funcoesHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btn-aplicar-data-equipe')?.addEventListener('click', async () => {
    const el = document.getElementById('filtro-data-equipe');
    if (el) {
      equipeDataFiltro = el.value;
      await carregarDadosIniciaisEquipe();
      renderizarCapacidadeDoDia(container);
    }
  });
}

// ------------------------------------------------------------------------------
// SUB-ABA 2: ESCALAS & TURNOS DE TRABALHO
// ------------------------------------------------------------------------------
async function renderizarEscalasEquipe(container) {
  container.innerHTML = `
    <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem;">
        <div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
          <input type="date" id="filtro-escala-data-ini" value="${equipeDataFiltro}" style="padding: 6px 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
          <span style="color: #64748b;">até</span>
          <input type="date" id="filtro-escala-data-fim" value="${equipeDataFiltro}" style="padding: 6px 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
          <button id="btn-filtrar-escalas" class="btn-primary" style="padding: 6px 12px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-size: 0.85rem;">
            Buscar Escalas
          </button>
        </div>
        <div>
          <button onclick="window.abrirModalNovaEscala()" class="btn-primary" style="padding: 6px 12px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-size: 0.85rem;">
            <i class="fa-solid fa-plus"></i> Nova Escala
          </button>
        </div>
      </div>
      <div id="lista-escalas-tabela">Carregando escalas...</div>
    </div>
  `;

  document.getElementById('btn-filtrar-escalas')?.addEventListener('click', carregarTabelaEscalas);
  await carregarTabelaEscalas();
}

async function carregarTabelaEscalas() {
  const container = document.getElementById('lista-escalas-tabela');
  if (!container) return;

  const dataIni = document.getElementById('filtro-escala-data-ini')?.value || equipeDataFiltro;
  const dataFim = document.getElementById('filtro-escala-data-fim')?.value || equipeDataFiltro;

  try {
    const sb = window.supabase;
    const { data: res } = await sb.rpc('obter_escala_periodo', {
      p_data_inicio: dataIni,
      p_data_fim: dataFim
    });

    if (!res || !res.success || !res.escalas || res.escalas.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2.5rem; color: #64748b;">
          <i class="fa-solid fa-calendar-xmark" style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.5;"></i>
          <p>Nenhuma escala registrada no período selecionado.</p>
        </div>
      `;
      return;
    }

    let linhas = '';
    res.escalas.forEach((e) => {
      const horasLiq = (Number(e.minutos_disponiveis || 0) / 60).toFixed(1);
      linhas += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${e.colaborador_nome}</td>
          <td style="padding: 10px 14px;">
            <span style="background: #f3e8ff; color: #6b2d5c; font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem;">
              ${e.funcao_nome}
            </span>
          </td>
          <td style="padding: 10px 14px; color: #64748b;">${e.data_escala}</td>
          <td style="padding: 10px 14px; color: #1e293b; font-weight: 500;">${e.hora_inicio.slice(0,5)} às ${e.hora_fim.slice(0,5)}</td>
          <td style="padding: 10px 14px; color: #64748b;">${e.intervalo_minutos} min</td>
          <td style="padding: 10px 14px; font-weight: 700; color: #0284c7;">${horasLiq} h (${e.minutos_disponiveis}m)</td>
          <td style="padding: 10px 14px;">
            <span style="font-size: 0.75rem; font-weight: 700; color: ${e.status === 'CONFIRMADA' ? '#059669' : '#dc2626'};">
              ${e.status}
            </span>
          </td>
        </tr>
      `;
    });

    container.innerHTML = `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 0.75rem; text-transform: uppercase;">
              <th style="padding: 10px 14px;">Colaborador</th>
              <th style="padding: 10px 14px;">Função</th>
              <th style="padding: 10px 14px;">Data</th>
              <th style="padding: 10px 14px;">Turno</th>
              <th style="padding: 10px 14px;">Intervalo</th>
              <th style="padding: 10px 14px;">Disponível Líquido</th>
              <th style="padding: 10px 14px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${linhas}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color: #dc2626; padding: 1rem;">Erro ao listar escalas: ${err.message}</div>`;
  }
}

// ------------------------------------------------------------------------------
// SUB-ABA 3: COLABORADORES & FUNÇÕES
// ------------------------------------------------------------------------------
function renderizarColaboradoresEquipe(container) {
  let linhas = '';
  if (equipeColaboradoresCache.length === 0) {
    linhas = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #64748b;">Nenhum colaborador cadastrado.</td></tr>`;
  } else {
    equipeColaboradoresCache.forEach((c) => {
      const funcoes = (c.colaborador_funcoes || []).map((cf) => {
        const f = equipeFuncoesCache.find((fn) => fn.id === cf.funcao_id);
        return f ? `<span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 4px;">${f.nome}${cf.principal ? ' ★' : ''}</span>` : '';
      }).join('');

      linhas += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 12px 16px; font-weight: 600; color: #1e293b;">
            ${c.nome} ${c.apelido ? `<span style="color: #64748b; font-weight: 400;">(${c.apelido})</span>` : ''}
          </td>
          <td style="padding: 12px 16px; color: #64748b;">${c.telefone || '--'}</td>
          <td style="padding: 12px 16px;">${funcoes || '<span style="color: #94a3b8; font-size: 0.75rem;">Sem função</span>'}</td>
          <td style="padding: 12px 16px;">
            <span style="font-size: 0.75rem; font-weight: 700; color: ${c.ativo ? '#059669' : '#dc2626'}; background: ${c.ativo ? '#ecfdf5' : '#fef2f2'}; padding: 2px 8px; border-radius: 4px;">
              ${c.ativo ? 'ATIVO' : 'INATIVO'}
            </span>
          </td>
          <td style="padding: 12px 16px; text-align: right;">
            <button onclick="window.abrirModalAtribuirFuncao(${c.id})" class="btn-outline" style="padding: 4px 8px; font-size: 11px; border-radius: 6px; border: 1px solid #cbd5e1;">
              Atribuir Função
            </button>
          </td>
        </tr>
      `;
    });
  }

  container.innerHTML = `
    <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h3 style="margin: 0; font-size: 1.1rem; color: #1e293b;">Colaboradores Cadastrados</h3>
        <button onclick="window.abrirModalNovoColaborador()" class="btn-primary" style="padding: 6px 12px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer; font-size: 0.85rem;">
          <i class="fa-solid fa-user-plus"></i> Novo Colaborador
        </button>
      </div>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 0.75rem; text-transform: uppercase;">
              <th style="padding: 10px 16px;">Nome</th>
              <th style="padding: 10px 16px;">Telefone</th>
              <th style="padding: 10px 16px;">Funções Operacionais</th>
              <th style="padding: 10px 16px;">Status</th>
              <th style="padding: 10px 16px; text-align: right;">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${linhas}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------------
// SUB-ABA 4: AUSÊNCIAS & FOLGAS
// ------------------------------------------------------------------------------
async function renderizarAusenciasEquipe(container) {
  container.innerHTML = `
    <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <div>
          <h3 style="margin: 0; font-size: 1.1rem; color: #1e293b;">Ausências, Folgas e Férias</h3>
          <p style="margin: 2px 0 0; font-size: 0.8rem; color: #64748b;">
            Registros operacionais de indisponibilidade que descontam automaticamente da capacidade da escala.
          </p>
        </div>
        <button onclick="window.abrirModalNovaAusencia()" class="btn-primary" style="padding: 6px 12px; border-radius: 6px; background: #d97706; color: #fff; border: none; cursor: pointer; font-size: 0.85rem;">
          <i class="fa-solid fa-calendar-xmark"></i> Registrar Ausência
        </button>
      </div>
      <div id="lista-ausencias-tabela">Carregando ausências...</div>
    </div>
  `;

  try {
    const sb = window.supabase;
    const { data: ausencias } = await sb.from('ausencias_equipe')
      .select('*, colaboradores(nome)')
      .order('data_inicio', { ascending: false })
      .limit(30);

    const tabela = document.getElementById('lista-ausencias-tabela');
    if (!tabela) return;

    if (!ausencias || ausencias.length === 0) {
      tabela.innerHTML = `<div style="text-align: center; padding: 2rem; color: #64748b;">Nenhuma ausência registrada recentemente.</div>`;
      return;
    }

    let linhas = '';
    ausencias.forEach((a) => {
      linhas += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${a.colaboradores?.nome || 'Colaborador'}</td>
          <td style="padding: 10px 14px;">
            <span style="background: #fffbeb; color: #b45309; font-weight: 700; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem;">
              ${a.tipo}
            </span>
          </td>
          <td style="padding: 10px 14px; color: #1e293b;">${a.data_inicio} até ${a.data_fim}</td>
          <td style="padding: 10px 14px; color: #64748b;">
            ${a.hora_inicio ? `${a.hora_inicio.slice(0,5)} às ${a.hora_fim.slice(0,5)}` : 'Dia Integral'}
          </td>
          <td style="padding: 10px 14px; color: #64748b; font-size: 0.8rem;">${a.motivo_geral || '--'}</td>
        </tr>
      `;
    });

    tabela.innerHTML = `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 0.75rem; text-transform: uppercase;">
              <th style="padding: 10px 14px;">Colaborador</th>
              <th style="padding: 10px 14px;">Tipo</th>
              <th style="padding: 10px 14px;">Período</th>
              <th style="padding: 10px 14px;">Horário</th>
              <th style="padding: 10px 14px;">Observação</th>
            </tr>
          </thead>
          <tbody>
            ${linhas}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.error('Erro ao carregar ausências:', err);
  }
}

// ------------------------------------------------------------------------------
// VISÃO SANITIZADA PARA OPERADORES DE BANCADA (O14)
// ------------------------------------------------------------------------------
async function renderizarVisaoOperadorEquipe(container) {
  container.innerHTML = `
    <div style="margin-bottom: 1.5rem;">
      <h2 style="margin: 0; font-size: 1.3rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
        <i class="fa-solid fa-users" style="color: #6b2d5c;"></i> Equipe de Bancada & Capacidade do Dia
      </h2>
      <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.85rem;">
        Acompanhamento operacional das escalas e minutos de preparo do dia.
      </p>
    </div>
    <div id="operador-equipe-conteudo">Carregando dados da equipe...</div>
  `;

  try {
    const sb = window.supabase;
    const { data: res } = await sb.rpc('obter_painel_capacidade_equipe', {
      p_data_inicio: equipeDataFiltro,
      p_data_fim: equipeDataFiltro
    });

    const el = document.getElementById('operador-equipe-conteudo');
    if (!el) return;

    if (!res || !res.success || !res.dias || res.dias.length === 0) {
      el.innerHTML = `<div style="background: #fff; padding: 1.5rem; border-radius: 8px; text-align: center; color: #64748b;">Nenhuma escala para hoje.</div>`;
      return;
    }

    const dia = res.dias[0];
    let cards = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem;">';
    (dia.funcoes || []).forEach((f) => {
      const util = Number(f.percentual_ocupacao || 0);
      const cor = util >= 100 ? '#dc2626' : util >= 80 ? '#f59e0b' : '#10b981';
      cards += `
        <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; border-left: 4px solid ${cor};">
          <strong style="color: #1e293b; font-size: 1rem;">${f.funcao_nome}</strong>
          <div style="margin-top: 0.5rem; font-size: 0.85rem; color: #64748b;">
            Equipe: <strong>${f.colaboradores_escalados}</strong> pessoas
          </div>
          <div style="font-size: 0.85rem; color: #64748b;">
            Capacidade: <strong>${(f.capacidade_planejada_minutos / 60).toFixed(1)} h</strong>
          </div>
          <div style="font-size: 0.85rem; color: #64748b;">
            Demanda Pedidos: <strong>${(f.demanda_minutos / 60).toFixed(1)} h</strong>
          </div>
          <div style="margin-top: 0.5rem; font-weight: 700; color: ${cor};">
            Ocupação: ${util}%
          </div>
        </div>
      `;
    });
    cards += '</div>';
    el.innerHTML = cards;
  } catch (err) {
    console.error('Erro ao renderizar visão operador equipe:', err);
  }
}

// ------------------------------------------------------------------------------
// MODAIS OPERACIONAIS: NOVO COLABORADOR, NOVA ESCALA, NOVA AUSÊNCIA
// ------------------------------------------------------------------------------
export function abrirModalNovoColaborador() {
  const container = document.getElementById('modal-equipe-container');
  if (!container) return;

  container.innerHTML = `
    <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
      <div style="background: #fff; width: 100%; max-width: 480px; border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
        <h3 style="margin-top: 0; color: #2c1810;">Novo Colaborador</h3>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: -0.5rem;">Cadastro operacional de bancada (sem RH ou folha).</p>
        
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Nome Completo *</label>
          <input type="text" id="modal-colab-nome" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;" placeholder="Ex: Maria Clara Silva">
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Apelido Operacional</label>
          <input type="text" id="modal-colab-apelido" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;" placeholder="Ex: Clara">
        </div>

        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Telefone</label>
          <input type="text" id="modal-colab-tel" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;" placeholder="(85) 99999-0000">
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button onclick="document.getElementById('modal-equipe-container').innerHTML=''" class="btn-outline" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #cbd5e1; cursor: pointer;">Cancelar</button>
          <button id="btn-salvar-colaborador-submit" class="btn-primary" style="padding: 8px 16px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer;">Salvar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-salvar-colaborador-submit')?.addEventListener('click', async () => {
    const nome = document.getElementById('modal-colab-nome')?.value;
    const apelido = document.getElementById('modal-colab-apelido')?.value;
    const tel = document.getElementById('modal-colab-tel')?.value;

    if (!nome || !nome.trim()) {
      alert('Informe o nome do colaborador.');
      return;
    }

    try {
      const sb = window.supabase;
      const { data: res, error } = await sb.rpc('salvar_colaborador_admin', {
        p_nome: nome.trim(),
        p_apelido: apelido ? apelido.trim() : null,
        p_telefone: tel ? tel.trim() : null,
        p_ativo: true
      });

      if (error || (res && !res.success)) {
        alert('Erro ao salvar: ' + (error?.message || res?.error));
        return;
      }

      container.innerHTML = '';
      await carregarDadosIniciaisEquipe();
      renderizarSubTabEquipe(equipeSubTabAtual);
    } catch (err) {
      alert('Erro inesperado: ' + err.message);
    }
  });
}

export function abrirModalNovaEscala() {
  const container = document.getElementById('modal-equipe-container');
  if (!container) return;

  const colabsOptions = equipeColaboradoresCache.filter(c => c.ativo).map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
  const funcoesOptions = equipeFuncoesCache.filter(f => f.ativo).map(f => `<option value="${f.id}">${f.nome}</option>`).join('');

  container.innerHTML = `
    <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
      <div style="background: #fff; width: 100%; max-width: 500px; border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
        <h3 style="margin-top: 0; color: #2c1810;">Nova Escala de Trabalho</h3>
        
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Colaborador *</label>
          <select id="modal-escala-colab" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;">
            ${colabsOptions}
          </select>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Função Operacional *</label>
          <select id="modal-escala-funcao" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;">
            ${funcoesOptions}
          </select>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Data da Escala *</label>
          <input type="date" id="modal-escala-data" value="${equipeDataFiltro}" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
        </div>

        <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
          <div style="flex: 1;">
            <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Hora Início *</label>
            <input type="time" id="modal-escala-inicio" value="08:00" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
          </div>
          <div style="flex: 1;">
            <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Hora Fim *</label>
            <input type="time" id="modal-escala-fim" value="16:00" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
          </div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Intervalo Padrão (minutos)</label>
          <input type="number" id="modal-escala-intervalo" value="60" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button onclick="document.getElementById('modal-equipe-container').innerHTML=''" class="btn-outline" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #cbd5e1; cursor: pointer;">Cancelar</button>
          <button id="btn-salvar-escala-submit" class="btn-primary" style="padding: 8px 16px; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer;">Confirmar Escala</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-salvar-escala-submit')?.addEventListener('click', async () => {
    const colabId = document.getElementById('modal-escala-colab')?.value;
    const funcaoId = document.getElementById('modal-escala-funcao')?.value;
    const dataEsc = document.getElementById('modal-escala-data')?.value;
    const hIni = document.getElementById('modal-escala-inicio')?.value;
    const hFim = document.getElementById('modal-escala-fim')?.value;
    const intervalo = document.getElementById('modal-escala-intervalo')?.value;

    try {
      const sb = window.supabase;
      const { data: res, error } = await sb.rpc('salvar_escala_equipe_admin', {
        p_colaborador_id: Number(colabId),
        p_funcao_id: Number(funcaoId),
        p_data_escala: dataEsc,
        p_hora_inicio: hIni.length === 5 ? `${hIni}:00` : hIni,
        p_hora_fim: hFim.length === 5 ? `${hFim}:00` : hFim,
        p_intervalo_minutos: Number(intervalo || 60)
      });

      if (error || (res && !res.success)) {
        alert('Erro ao salvar escala: ' + (error?.message || res?.error));
        return;
      }

      container.innerHTML = '';
      await carregarDadosIniciaisEquipe();
      renderizarSubTabEquipe(equipeSubTabAtual);
    } catch (err) {
      alert('Erro inesperado: ' + err.message);
    }
  });
}

export function abrirModalNovaAusencia() {
  const container = document.getElementById('modal-equipe-container');
  if (!container) return;

  const colabsOptions = equipeColaboradoresCache.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');

  container.innerHTML = `
    <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
      <div style="background: #fff; width: 100%; max-width: 500px; border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
        <h3 style="margin-top: 0; color: #2c1810;">Registrar Ausência / Folga</h3>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: -0.5rem;">Desconta automaticamente da capacidade líquida do período.</p>
        
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Colaborador *</label>
          <select id="modal-ausencia-colab" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;">
            ${colabsOptions}
          </select>
        </div>

        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Tipo de Ausência *</label>
          <select id="modal-ausencia-tipo" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;">
            <option value="FOLGA">Folga Programada</option>
            <option value="FERIAS">Férias</option>
            <option value="AUSENCIA">Ausência Injustificada</option>
            <option value="ATESTADO">Atestado / Motivo Médico</option>
            <option value="INDISPONIBILIDADE">Indisponibilidade Parcial</option>
            <option value="OUTRO">Outro Motivo</option>
          </select>
        </div>

        <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
          <div style="flex: 1;">
            <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Data Início *</label>
            <input type="date" id="modal-ausencia-dt-ini" value="${equipeDataFiltro}" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
          </div>
          <div style="flex: 1;">
            <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Data Fim *</label>
            <input type="date" id="modal-ausencia-dt-fim" value="${equipeDataFiltro}" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
          </div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Motivo Operacional Geral</label>
          <input type="text" id="modal-ausencia-motivo" placeholder="Ex: Compensação de banco ou liberação da gerência" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button onclick="document.getElementById('modal-equipe-container').innerHTML=''" class="btn-outline" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #cbd5e1; cursor: pointer;">Cancelar</button>
          <button id="btn-salvar-ausencia-submit" class="btn-primary" style="padding: 8px 16px; border-radius: 6px; background: #d97706; color: #fff; border: none; cursor: pointer;">Registrar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-salvar-ausencia-submit')?.addEventListener('click', async () => {
    const colabId = document.getElementById('modal-ausencia-colab')?.value;
    const tipo = document.getElementById('modal-ausencia-tipo')?.value;
    const dtIni = document.getElementById('modal-ausencia-dt-ini')?.value;
    const dtFim = document.getElementById('modal-ausencia-dt-fim')?.value;
    const motivo = document.getElementById('modal-ausencia-motivo')?.value;

    try {
      const sb = window.supabase;
      const { data: res, error } = await sb.rpc('registrar_ausencia_equipe_admin', {
        p_colaborador_id: Number(colabId),
        p_tipo: tipo,
        p_data_inicio: dtIni,
        p_data_fim: dtFim,
        p_motivo_geral: motivo ? motivo.trim() : null
      });

      if (error || (res && !res.success)) {
        alert('Erro ao registrar ausência: ' + (error?.message || res?.error));
        return;
      }

      container.innerHTML = '';
      await carregarDadosIniciaisEquipe();
      renderizarSubTabEquipe(equipeSubTabAtual);
    } catch (err) {
      alert('Erro inesperado: ' + err.message);
    }
  });
}

// Expor funções globalmente para acesso inline via window
if (typeof window !== 'undefined') {
  window.carregarEquipeAdmin = carregarEquipeAdmin;
  window.abrirModalNovoColaborador = abrirModalNovoColaborador;
  window.abrirModalNovaEscala = abrirModalNovaEscala;
  window.abrirModalNovaAusencia = abrirModalNovaAusencia;
}
