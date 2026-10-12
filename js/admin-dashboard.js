// ==============================================================================
// LUNOCA - DASHBOARD GERENCIAL, DRE E INDICADORES (FRENTE F - MIGRATION 021)
// ==============================================================================
// Invariante nº 1:
// Venda confirmada != Faturamento realizado != Entrada de caixa != Crédito do cliente
// RBAC:
// - Admin: obter_dashboard_resumo_admin (DRE, Caixa líquido, Créditos, Vendas, Produção, Clientes)
// - Operador: obter_dashboard_operacional (Volumes e Capacidade produtiva sanitizados sem valores R$)
// ==============================================================================

let periodoDashboardAtual = 'mes_atual';
let dataInicioDashboardCustom = null;
let dataFimDashboardCustom = null;
let dashboardCache = null;

function formatarMoedaDashboard(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarNumeroDashboard(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR');
}

function formatarPercentualDashboard(val) {
  const num = Number(val) || 0;
  return num.toFixed(1) + '%';
}

function calcularDatasPeriodoDashboard(periodo) {
  const hoje = new Date();
  const formatarDataIso = (d) => {
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  };

  if (periodo === 'hoje') {
    const dStr = formatarDataIso(hoje);
    return { inicio: dStr, fim: dStr };
  }

  if (periodo === '7dias') {
    const inicio = new Date(hoje);
    inicio.setDate(inicio.getDate() - 6);
    return { inicio: formatarDataIso(inicio), fim: formatarDataIso(hoje) };
  }

  if (periodo === '30dias') {
    const inicio = new Date(hoje);
    inicio.setDate(inicio.getDate() - 29);
    return { inicio: formatarDataIso(inicio), fim: formatarDataIso(hoje) };
  }

  if (periodo === 'mes_anterior') {
    const ano = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();
    const mes = hoje.getMonth() === 0 ? 11 : hoje.getMonth() - 1;
    const inicio = new Date(ano, mes, 1);
    const fim = new Date(ano, mes + 1, 0);
    return { inicio: formatarDataIso(inicio), fim: formatarDataIso(fim) };
  }

  // Padrão: mes_atual
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return { inicio: formatarDataIso(inicio), fim: formatarDataIso(fim) };
}

async function mudarPeriodoDashboard(periodo) {
  periodoDashboardAtual = periodo;
  document.querySelectorAll('.btn-periodo-dash').forEach(btn => btn.classList.remove('active'));
  const btnAtivo = document.getElementById(`btn-dash-${periodo}`);
  if (btnAtivo) btnAtivo.classList.add('active');

  const customContainer = document.getElementById('dash-filtro-datas-custom');
  if (customContainer) {
    customContainer.style.display = periodo === 'custom' ? 'flex' : 'none';
  }

  if (periodo !== 'custom') {
    await carregarDashboardGerencial();
  }
}

async function aplicarFiltroDatasCustomDashboard() {
  const dtInicio = document.getElementById('dash-data-inicio')?.value;
  const dtFim = document.getElementById('dash-data-fim')?.value;

  if (!dtInicio || !dtFim) {
    if (typeof mostrarToast === 'function') mostrarToast('Informe data inicial e final', 'aviso');
    return;
  }

  if (dtInicio > dtFim) {
    if (typeof mostrarToast === 'function') mostrarToast('Data inicial não pode ser maior que final', 'aviso');
    return;
  }

  dataInicioDashboardCustom = dtInicio;
  dataFimDashboardCustom = dtFim;
  await carregarDashboardGerencial();
}

async function carregarDashboardGerencial() {
  const container = document.getElementById('dash-conteudo-container');
  if (!container) return;

  const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';
  const isAdm = usuarioAtual && usuarioAtual.nivel === 'admin';

  container.innerHTML = `
    <div style="text-align:center; padding:60px 20px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:14px; display:block;"></i>
      <div style="font-weight:600; font-size:15px;">Consolidando métricas e indicadores...</div>
      <div style="font-size:12px; margin-top:4px;">Processando regras contábeis em tempo real</div>
    </div>
  `;

  let datas;
  if (periodoDashboardAtual === 'custom' && dataInicioDashboardCustom && dataFimDashboardCustom) {
    datas = { inicio: dataInicioDashboardCustom, fim: dataFimDashboardCustom };
  } else {
    datas = calcularDatasPeriodoDashboard(periodoDashboardAtual);
  }

  try {
    if (isOperador) {
      // Visão Operacional Sanitizada (sem campos financeiros)
      const { data, error } = await supabaseClient.rpc('obter_dashboard_operacional', {
        p_data_inicio: datas.inicio,
        p_data_fim: datas.fim
      });

      if (error) throw error;
      if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar dashboard operacional');

      dashboardCache = data;
      renderizarDashboardOperacional(data, datas);
    } else {
      // Visão Executiva e DRE (Administrador)
      const { data, error } = await supabaseClient.rpc('obter_dashboard_resumo_admin', {
        p_data_inicio: datas.inicio,
        p_data_fim: datas.fim
      });

      if (error) throw error;
      if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar resumo administrativo');

      dashboardCache = data;
      renderizarDashboardAdmin(data, datas);
    }
  } catch (err) {
    console.error('[Dashboard Gerencial] Erro:', err);
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b;">
        <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom:10px; display:block;"></i>
        <div style="font-weight:700; font-size:15px;">Falha ao carregar indicadores</div>
        <div style="font-size:13px; margin-top:4px;">${err.message || 'Erro de comunicação'}</div>
        <button onclick="carregarDashboardGerencial()" class="btn-primary" style="margin-top:14px; padding:6px 16px; font-size:12px;">
          Tentar Novamente
        </button>
      </div>
    `;
  }
}

function renderizarDashboardAdmin(resumo, datas) {
  const container = document.getElementById('dash-conteudo-container');
  if (!container) return;

  const v = resumo.vendas || {};
  const f = resumo.financeiro || {};
  const p = resumo.producao || {};
  const c = resumo.clientes || {};

  container.innerHTML = `
    <!-- ALERTA DE RECONCILIAÇÃO CONTÁBIL (INVARIANTE Nº 1) -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px 16px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <i class="fa-solid fa-scale-balanced fa-lg" style="color:var(--primary);"></i>
        <div>
          <span style="font-size:13px; font-weight:700; color:#1e293b;">Invariante Contábil Consolidada</span>
          <span style="font-size:12px; color:#64748b; margin-left:8px;">Período: ${datas.inicio} a ${datas.fim}</span>
        </div>
      </div>
      <div style="font-size:11px; background:#e0f2fe; color:#0369a1; padding:4px 10px; border-radius:20px; font-weight:600;">
        Faturamento Realizado != Caixa Líquido != Créditos Utilizados
      </div>
    </div>

    <!-- SEÇÃO 1: OS 4 PILARES FINANCEIROS & COMERCIAIS -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px; margin-bottom:22px;">
      <!-- Card 1: Vendas Confirmadas -->
      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px; border-left:4px solid #3b82f6;">
        <div style="font-size:11px; font-weight:700; color:#3b82f6; text-transform:uppercase; letter-spacing:0.5px; display:flex; justify-content:space-between;">
          <span>Vendas Confirmadas</span>
          <i class="fa-solid fa-file-signature"></i>
        </div>
        <div style="font-size:24px; font-weight:800; color:#1e293b; margin:8px 0 4px 0;">
          ${formatarMoedaDashboard(v.vendas_confirmadas_valor)}
        </div>
        <div style="font-size:12px; color:#64748b;">
          <strong>${formatarNumeroDashboard(v.vendas_confirmadas_quantidade)}</strong> pedidos contratados
        </div>
        <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Carteira comercial comprometida</div>
      </div>

      <!-- Card 2: Faturamento Realizado -->
      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px; border-left:4px solid #10b981;">
        <div style="font-size:11px; font-weight:700; color:#10b981; text-transform:uppercase; letter-spacing:0.5px; display:flex; justify-content:space-between;">
          <span>Faturamento Realizado</span>
          <i class="fa-solid fa-circle-check"></i>
        </div>
        <div style="font-size:24px; font-weight:800; color:#047857; margin:8px 0 4px 0;">
          ${formatarMoedaDashboard(v.faturamento_realizado)}
        </div>
        <div style="font-size:12px; color:#64748b;">
          <strong>${formatarNumeroDashboard(v.pedidos_concluidos_quantidade)}</strong> pedidos concluídos
        </div>
        <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Ticket Médio: ${formatarMoedaDashboard(v.ticket_medio_realizado)}</div>
      </div>

      <!-- Card 3: Entrada de Caixa Líquida -->
      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px; border-left:4px solid #06b6d4;">
        <div style="font-size:11px; font-weight:700; color:#06b6d4; text-transform:uppercase; letter-spacing:0.5px; display:flex; justify-content:space-between;">
          <span>Entrada de Caixa Líquida</span>
          <i class="fa-solid fa-cash-register"></i>
        </div>
        <div style="font-size:24px; font-weight:800; color:#0891b2; margin:8px 0 4px 0;">
          ${formatarMoedaDashboard(f.entrada_caixa_liquida)}
        </div>
        <div style="font-size:12px; color:#64748b;">
          Bruto: ${formatarMoedaDashboard(f.entrada_caixa_bruta)}
        </div>
        <div style="font-size:11px; color:#ef4444; margin-top:4px;">
          Estornos: -${formatarMoedaDashboard(f.estornos_caixa)}
        </div>
      </div>

      <!-- Card 4: Créditos Utilizados & Saldo Aberto -->
      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px; border-left:4px solid #8b5cf6;">
        <div style="font-size:11px; font-weight:700; color:#8b5cf6; text-transform:uppercase; letter-spacing:0.5px; display:flex; justify-content:space-between;">
          <span>Crédito Utilizado</span>
          <i class="fa-solid fa-wallet"></i>
        </div>
        <div style="font-size:24px; font-weight:800; color:#6d28d9; margin:8px 0 4px 0;">
          ${formatarMoedaDashboard(f.credito_cliente_utilizado)}
        </div>
        <div style="font-size:12px; color:#64748b;">
          Saldo em Carteira: <strong>${formatarMoedaDashboard(f.saldo_creditos_atual)}</strong>
        </div>
        <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Não duplica receita no DRE</div>
      </div>
    </div>

    <!-- SEÇÃO 2: DRE OPERACIONAL & DETALHAMENTO DE MEIOS DE PAGAMENTO -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:18px; margin-bottom:22px;">
      <!-- Meios de Pagamento Efetivados -->
      <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
        <h4 style="margin:0 0 14px 0; font-size:14px; color:#1e293b; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-money-bill-transfer" style="color:var(--primary);"></i> Meios de Entrada no Caixa
        </h4>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
            <span style="color:#64748b;"><i class="fa-brands fa-pix" style="color:#00BDAE; width:18px;"></i> PIX</span>
            <strong style="color:#1e293b;">${formatarMoedaDashboard(f.recebido_pix)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
            <span style="color:#64748b;"><i class="fa-solid fa-credit-card" style="color:#3b82f6; width:18px;"></i> Cartão</span>
            <strong style="color:#1e293b;">${formatarMoedaDashboard(f.recebido_cartao)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
            <span style="color:#64748b;"><i class="fa-solid fa-money-bill-wave" style="color:#10b981; width:18px;"></i> Dinheiro</span>
            <strong style="color:#1e293b;">${formatarMoedaDashboard(f.recebido_dinheiro)}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
            <span style="color:#64748b;"><i class="fa-solid fa-building-columns" style="color:#6366f1; width:18px;"></i> Transferência</span>
            <strong style="color:#1e293b;">${formatarMoedaDashboard(f.recebido_transferencia)}</strong>
          </div>
          <div style="height:1px; background:#f1f5f9; margin:4px 0;"></div>
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px; font-weight:700;">
            <span style="color:#1e293b;">Total Entradas Externas</span>
            <span style="color:#0891b2;">${formatarMoedaDashboard(f.entrada_caixa_bruta)}</span>
          </div>
        </div>
      </div>

      <!-- Eficiência Comercial & Modalidades -->
      <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
        <h4 style="margin:0 0 14px 0; font-size:14px; color:#1e293b; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-chart-line" style="color:var(--primary);"></i> Funil & Eficiência Comercial
        </h4>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div style="background:#f8fafc; padding:12px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">Conversão de Orçamentos</div>
            <div style="font-size:20px; font-weight:800; color:#10b981; margin:4px 0;">
              ${formatarPercentualDashboard(v.taxa_conversao)}
            </div>
            <div style="font-size:11px; color:#64748b;">
              ${formatarNumeroDashboard(v.orcamentos_convertidos)} de ${formatarNumeroDashboard(v.orcamentos_emitidos)}
            </div>
          </div>
          <div style="background:#f8fafc; padding:12px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">Taxa de Cancelamento</div>
            <div style="font-size:20px; font-weight:800; color:#ef4444; margin:4px 0;">
              ${formatarPercentualDashboard(v.taxa_cancelamento)}
            </div>
            <div style="font-size:11px; color:#64748b;">
              ${formatarNumeroDashboard(v.pedidos_cancelados)} pedidos
            </div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:#64748b; background:#f1f5f9; padding:8px 12px; border-radius:8px;">
          <span>Modalidades Concluídas:</span>
          <strong>${formatarNumeroDashboard(v.entrega_quantidade)} entregas • ${formatarNumeroDashboard(v.retirada_quantidade)} retiradas</strong>
        </div>
      </div>
    </div>

    <!-- SEÇÃO 3: CAPACIDADE PRODUTIVA DA FÁBRICA & RELACIONAMENTO COM CLIENTES -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:18px;">
      <!-- Capacidade Produtiva (Frente E integrada) -->
      <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
        <h4 style="margin:0 0 14px 0; font-size:14px; color:#1e293b; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-kitchen-set" style="color:var(--primary);"></i> Carga Produtiva da Cozinha
        </h4>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div>
            <div style="font-size:22px; font-weight:800; color:#1e293b;">
              ${formatarPercentualDashboard(p.ocupacao_percentual)}
            </div>
            <div style="font-size:11px; color:#64748b;">Ocupação média da fábrica</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:14px; font-weight:700; color:#64748b;">
              ${Number(p.pontos_producao || 0).toFixed(1)} / ${Number(p.capacidade_total || 0).toFixed(1)} pts
            </div>
            <div style="font-size:11px; color:#94a3b8;">Pontos produzidos vs Capacidade</div>
          </div>
        </div>
        <div style="background:#e2e8f0; height:8px; border-radius:4px; overflow:hidden; margin-bottom:14px;">
          <div style="background:var(--primary); width:${Math.min(100, Number(p.ocupacao_percentual || 0))}%; height:100%;"></div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; text-align:center;">
          <div style="background:#f8fafc; padding:8px; border-radius:8px;">
            <div style="font-size:10px; color:#64748b;">Normais</div>
            <div style="font-size:14px; font-weight:700; color:#10b981;">${p.dias_normais || 0} dias</div>
          </div>
          <div style="background:#f8fafc; padding:8px; border-radius:8px;">
            <div style="font-size:10px; color:#64748b;">No Limite</div>
            <div style="font-size:14px; font-weight:700; color:#f59e0b;">${p.dias_proximo_limite || 0} dias</div>
          </div>
          <div style="background:#f8fafc; padding:8px; border-radius:8px;">
            <div style="font-size:10px; color:#64748b;">Lotados/Excedidos</div>
            <div style="font-size:14px; font-weight:700; color:#ef4444;">${(p.dias_lotados || 0) + (p.dias_excedidos || 0)} dias</div>
          </div>
        </div>
      </div>

      <!-- CRM: Novos vs Recorrentes & Top Clientes -->
      <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
        <h4 style="margin:0 0 14px 0; font-size:14px; color:#1e293b; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-address-book" style="color:var(--primary);"></i> Fidelização & Top Clientes
        </h4>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:14px; text-align:center;">
          <div style="background:#f8fafc; padding:10px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b;">Ativos</div>
            <div style="font-size:18px; font-weight:800; color:#1e293b;">${formatarNumeroDashboard(c.clientes_ativos)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b;">Novos</div>
            <div style="font-size:18px; font-weight:800; color:#0284c7;">${formatarNumeroDashboard(c.clientes_novos)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b;">Recorrentes</div>
            <div style="font-size:18px; font-weight:800; color:#8b5cf6;">${formatarNumeroDashboard(c.clientes_recorrentes)}</div>
          </div>
        </div>
        <div style="font-size:12px; color:#64748b; margin-bottom:8px; font-weight:600;">Top Compradores:</div>
        <div style="display:flex; flex-direction:column; gap:6px; max-height:130px; overflow-y:auto;">
          ${(c.top_clientes && c.top_clientes.length > 0) ? c.top_clientes.map((tc, idx) => `
            <div style="display:flex; justify-content:space-between; font-size:12px; padding:4px 6px; background:#fafafa; border-radius:6px;">
              <span style="color:#1e293b; font-weight:600;">${idx + 1}. ${tc.nome || 'Cliente'}</span>
              <span style="color:#047857; font-weight:700;">${formatarMoedaDashboard(tc.valor_historico_compras)} (${tc.pedidos} ped)</span>
            </div>
          `).join('') : '<div style="font-size:11px; color:#94a3b8; text-align:center; padding:10px;">Sem compras no período</div>'}
        </div>
      </div>
    </div>
  `;
}

function renderizarDashboardOperacional(dash, datas) {
  const container = document.getElementById('dash-conteudo-container');
  if (!container) return;

  const v = dash.volumes_pedidos || {};
  const p = dash.producao || {};

  container.innerHTML = `
    <!-- AVISO DE VISÃO OPERACIONAL SEGREGADA -->
    <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:12px; padding:12px 16px; margin-bottom:18px; display:flex; align-items:center; gap:10px;">
      <i class="fa-solid fa-boxes-packing fa-lg" style="color:#0284c7;"></i>
      <div>
        <span style="font-size:13px; font-weight:700; color:#0369a1;">Visão de Volumes & Carga Produtiva (Operador)</span>
        <div style="font-size:12px; color:#0284c7;">Período: ${datas.inicio} a ${datas.fim} • Indicadores financeiros restritos ao administrador</div>
      </div>
    </div>

    <!-- VOLUMES DE EXPEDIÇÃO & STATUS OPERACIONAL -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:22px;">
      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Total Agendado</div>
        <div style="font-size:24px; font-weight:800; color:#1e293b; margin:6px 0;">${formatarNumeroDashboard(v.total_agendados)}</div>
        <div style="font-size:11px; color:#64748b;">${formatarNumeroDashboard(v.entrega_quantidade)} entregas • ${formatarNumeroDashboard(v.retirada_quantidade)} retiradas</div>
      </div>

      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px;">
        <div style="font-size:11px; font-weight:700; color:#f59e0b; text-transform:uppercase;">Em Produção</div>
        <div style="font-size:24px; font-weight:800; color:#d97706; margin:6px 0;">${formatarNumeroDashboard(v.em_producao)}</div>
        <div style="font-size:11px; color:#64748b;">${formatarNumeroDashboard(v.aguardando_producao)} aguardando início</div>
      </div>

      <div class="metric-card-nooty" style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:16px;">
        <div style="font-size:11px; font-weight:700; color:#10b981; text-transform:uppercase;">Prontos / Concluídos</div>
        <div style="font-size:24px; font-weight:800; color:#059669; margin:6px 0;">${formatarNumeroDashboard(v.concluidos)}</div>
        <div style="font-size:11px; color:#64748b;">${formatarNumeroDashboard(v.prontos_expedicao)} prontos para entrega</div>
      </div>
    </div>

    <!-- CARGA DA COZINHA -->
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
      <h4 style="margin:0 0 14px 0; font-size:14px; color:#1e293b; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-kitchen-set" style="color:var(--primary);"></i> Capacidade de Fábrica no Período
      </h4>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div>
          <div style="font-size:22px; font-weight:800; color:#1e293b;">${formatarPercentualDashboard(p.ocupacao_percentual)}</div>
          <div style="font-size:11px; color:#64748b;">Ocupação média dos dias analisados</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:14px; font-weight:700; color:#64748b;">${Number(p.pontos_producao || 0).toFixed(1)} / ${Number(p.capacidade_total || 0).toFixed(1)} pts</div>
        </div>
      </div>
      <div style="background:#e2e8f0; height:8px; border-radius:4px; overflow:hidden; margin-bottom:14px;">
        <div style="background:var(--primary); width:${Math.min(100, Number(p.ocupacao_percentual || 0))}%; height:100%;"></div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; text-align:center;">
        <div style="background:#f8fafc; padding:8px; border-radius:8px;">
          <div style="font-size:10px; color:#64748b;">Dias Normais</div>
          <div style="font-size:14px; font-weight:700; color:#10b981;">${p.dias_normais || 0}</div>
        </div>
        <div style="background:#f8fafc; padding:8px; border-radius:8px;">
          <div style="font-size:10px; color:#64748b;">Próximos do Limite</div>
          <div style="font-size:14px; font-weight:700; color:#f59e0b;">${p.dias_proximo_limite || 0}</div>
        </div>
        <div style="background:#f8fafc; padding:8px; border-radius:8px;">
          <div style="font-size:10px; color:#64748b;">Lotados / Excedidos</div>
          <div style="font-size:14px; font-weight:700; color:#ef4444;">${(p.dias_lotados || 0) + (p.dias_excedidos || 0)}</div>
        </div>
      </div>
    </div>
  `;
}

// Exportações para o escopo global do admin
window.carregarDashboardGerencial = carregarDashboardGerencial;
window.mudarPeriodoDashboard = mudarPeriodoDashboard;
window.aplicarFiltroDatasCustomDashboard = aplicarFiltroDatasCustomDashboard;
