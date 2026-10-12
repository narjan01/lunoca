// ==========================================================================
// LUNOCA DOCERIA - MÓDULO ADMIN: TESOURARIA, FLUXO DE CAIXA E CONCILIAÇÃO (FRENTE H)
// ==========================================================================
// Consome exclusivamente as RPCs canônicas da Migration 023:
// - obter_posicao_tesouraria_admin
// - obter_fluxo_caixa_admin
// - obter_recebimentos_previstos_admin
// - obter_contas_pagar_periodo_admin
// - obter_conciliacao_financeira_admin
// - registrar_conciliacao_financeira_admin
// - registrar_ajuste_tesouraria_admin
// - salvar_conta_financeira_admin
// ==========================================================================

let subAbaTesourariaAtual = 'posicao';
let cachePosicaoTesouraria = null;

function formatarMoedaTesouraria(val) {
  const num = Number(val || 0);
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDataBrTesouraria(isoDate) {
  if (!isoDate) return '-';
  const parts = String(isoDate).slice(0, 10).split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function escTesouraria(str) {
  if (typeof escapeHTML === 'function') return escapeHTML(String(str ?? ''));
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function obterDatasPadraoTesouraria() {
  const inicioEl = document.getElementById('tesouraria-data-inicio');
  const fimEl = document.getElementById('tesouraria-data-fim');
  const hoje = new Date();
  const y = hoje.getFullYear();
  const m = String(hoje.getMonth() + 1).padStart(2, '0');
  const d = String(hoje.getDate()).padStart(2, '0');

  const padraoInicio = `${y}-${m}-01`;
  const futuro = new Date(hoje.getTime() + 15 * 86400000);
  const fy = futuro.getFullYear();
  const fm = String(futuro.getMonth() + 1).padStart(2, '0');
  const fd = String(futuro.getDate()).padStart(2, '0');
  const padraoFim = `${fy}-${fm}-${fd}`;

  if (inicioEl && !inicioEl.value) inicioEl.value = padraoInicio;
  if (fimEl && !fimEl.value) fimEl.value = padraoFim;

  return {
    dataInicio: inicioEl?.value || padraoInicio,
    dataFim: fimEl?.value || padraoFim
  };
}

function mudarSubAbaTesouraria(subAba) {
  subAbaTesourariaAtual = subAba;
  document.querySelectorAll('.btn-subaba-tesouraria').forEach(btn => btn.classList.remove('active'));
  const btnAtivo = document.getElementById(`btn-subaba-tesouraria-${subAba}`);
  if (btnAtivo) btnAtivo.classList.add('active');
  carregarTesourariaAdmin();
}

async function carregarTesourariaAdmin() {
  const container = document.getElementById('tesouraria-conteudo-dinamico');
  if (!container) return;

  if (typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel !== 'admin') {
    container.innerHTML = `
      <div style="padding:24px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b; text-align:center;">
        <i class="fa-solid fa-lock fa-2x" style="margin-bottom:8px;"></i>
        <p style="margin:0; font-weight:700;">Acesso Restrito ao Administrador</p>
        <p style="margin:4px 0 0; font-size:12px;">Saldos bancários, fluxo de caixa e conciliação são informações exclusivas da gestão.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="text-align:center; padding:36px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:10px;"></i>
      <p style="margin:0; font-size:13px; font-weight:600;">Carregando Tesouraria & Fluxo de Caixa...</p>
    </div>
  `;

  try {
    if (subAbaTesourariaAtual === 'posicao') {
      await renderizarSubAbaPosicaoTesouraria(container);
    } else if (subAbaTesourariaAtual === 'fluxo') {
      await renderizarSubAbaFluxoCaixa(container);
    } else if (subAbaTesourariaAtual === 'recebiveis') {
      await renderizarSubAbaRecebimentosPrevistos(container);
    } else if (subAbaTesourariaAtual === 'pagaveis') {
      await renderizarSubAbaContasPagarPeriodo(container);
    } else if (subAbaTesourariaAtual === 'conciliacao') {
      await renderizarSubAbaConciliacaoFinanceira(container);
    }
  } catch (err) {
    console.error('[Tesouraria] Erro:', err);
    container.innerHTML = `
      <div style="padding:20px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b;">
        <strong>Erro ao carregar Tesouraria:</strong> ${escTesouraria(err.message || 'Falha na comunicação com o servidor')}
      </div>
    `;
  }
}

async function renderizarSubAbaPosicaoTesouraria(container) {
  const { data, error } = await supabaseClient.rpc('obter_posicao_tesouraria_admin', {
    p_horizonte_dias: 30
  });
  if (error) throw error;
  if (!data || !data.success) throw new Error(data?.error || 'Não foi possível obter a posição de tesouraria.');

  cachePosicaoTesouraria = data;
  const contas = data.contas_financeiras || [];

  container.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:18px;">
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Caixa Realizado Atual</div>
        <div style="font-size:22px; font-weight:800; color:${Number(data.saldo_caixa_realizado_atual) >= 0 ? '#0f172a' : '#dc2626'}; margin:6px 0;">
          ${formatarMoedaTesouraria(data.saldo_caixa_realizado_atual)}
        </div>
        <div style="font-size:11px; color:#64748b;">Saldo efetivo (Caixa + Bancos + Gateways)</div>
      </div>

      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Recebimentos Previstos (30d)</div>
        <div style="font-size:22px; font-weight:800; color:#15803d; margin:6px 0;">
          ${formatarMoedaTesouraria(data.recebimentos_previstos_horizonte)}
        </div>
        <div style="font-size:11px; color:#b45309;">Vencidos: ${formatarMoedaTesouraria(data.recebimentos_vencidos)}</div>
      </div>

      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Contas a Pagar (30d)</div>
        <div style="font-size:22px; font-weight:800; color:#b91c1c; margin:6px 0;">
          ${formatarMoedaTesouraria(data.contas_pagar_previstas_horizonte)}
        </div>
        <div style="font-size:11px; color:#dc2626;">Vencidas: ${formatarMoedaTesouraria(data.contas_pagar_vencidas)}</div>
      </div>

      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Saldo Projetado (30d)</div>
        <div style="font-size:22px; font-weight:800; color:${Number(data.saldo_caixa_projetado) >= 0 ? '#0369a1' : '#dc2626'}; margin:6px 0;">
          ${formatarMoedaTesouraria(data.saldo_caixa_projetado)}
        </div>
        <div style="font-size:11px; color:#64748b;">Necessidade de Caixa: <strong>${formatarMoedaTesouraria(data.necessidade_caixa)}</strong></div>
      </div>

      <div style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:12px; padding:14px;">
        <div style="font-size:11px; font-weight:700; color:#475569; text-transform:uppercase;">Passivo Créditos Clientes</div>
        <div style="font-size:22px; font-weight:800; color:#6d28d9; margin:6px 0;">
          ${formatarMoedaTesouraria(data.passivo_creditos_clientes)}
        </div>
        <div style="font-size:11px; color:#64748b;">Carteira interna (não soma no caixa bancário)</div>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
        <h4 style="margin:0; font-size:15px; color:#1e293b;">
          <i class="fa-solid fa-building-columns" style="color:var(--primary);"></i> Contas Financeiras & Carteiras
        </h4>
        <button onclick="abrirModalAjusteTesouraria()" class="btn-primary" style="padding:6px 12px; font-size:12px; border-radius:8px;">
          <i class="fa-solid fa-scale-balanced"></i> Registrar Ajuste de Tesouraria
        </button>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#f8fafc; text-align:left; border-bottom:1px solid #e2e8f0;">
              <th style="padding:10px;">Conta</th>
              <th style="padding:10px;">Tipo / Instituição</th>
              <th style="padding:10px;">Método Padrão</th>
              <th style="padding:10px; text-align:right;">Saldo Inicial</th>
              <th style="padding:10px; text-align:right;">Saldo Estimado Atual</th>
            </tr>
          </thead>
          <tbody>
            ${contas.map(c => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:10px; font-weight:700; color:#1e293b;">${escTesouraria(c.nome)} <span style="font-size:11px; color:#64748b; font-weight:400;">(${escTesouraria(c.codigo)})</span></td>
                <td style="padding:10px;">${escTesouraria(c.tipo)} • ${escTesouraria(c.instituicao || '-')}</td>
                <td style="padding:10px;"><span style="background:#f1f5f9; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600;">${escTesouraria(c.padrao_metodo || '-')}</span></td>
                <td style="padding:10px; text-align:right;">${formatarMoedaTesouraria(c.saldo_inicial)}</td>
                <td style="padding:10px; text-align:right; font-weight:800; color:${Number(c.saldo_estimado_atual) >= 0 ? '#0f172a' : '#dc2626'};">${formatarMoedaTesouraria(c.saldo_estimado_atual)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderizarSubAbaFluxoCaixa(container) {
  const { dataInicio, dataFim } = obterDatasPadraoTesouraria();
  const { data, error } = await supabaseClient.rpc('obter_fluxo_caixa_admin', {
    p_data_inicio: dataInicio,
    p_data_fim: dataFim
  });
  if (error) throw error;
  if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar fluxo de caixa.');

  const r = data.resumo || {};
  const diario = data.diario || [];

  container.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:12px; margin-bottom:16px;">
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">
        <div style="font-size:11px; color:#64748b; font-weight:700;">ENTRADAS LÍQUIDAS REALIZADAS</div>
        <div style="font-size:18px; font-weight:800; color:#15803d; margin-top:4px;">${formatarMoedaTesouraria(r.entradas_liquidas_realizadas)}</div>
        <div style="font-size:11px; color:#64748b;">Bruto: ${formatarMoedaTesouraria(r.entradas_brutas_realizadas)} | Estornos: ${formatarMoedaTesouraria(r.estornos_realizados)}</div>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">
        <div style="font-size:11px; color:#64748b; font-weight:700;">SAÍDAS OPERACIONAIS REALIZADAS</div>
        <div style="font-size:18px; font-weight:800; color:#b91c1c; margin-top:4px;">${formatarMoedaTesouraria(r.saidas_operacionais_realizadas)}</div>
        <div style="font-size:11px; color:#64748b;">Líquido Realizado: <strong>${formatarMoedaTesouraria(r.liquido_realizado)}</strong></div>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">
        <div style="font-size:11px; color:#64748b; font-weight:700;">PROJETADO NO PERÍODO</div>
        <div style="font-size:18px; font-weight:800; color:#0369a1; margin-top:4px;">${formatarMoedaTesouraria(r.liquido_projetado)}</div>
        <div style="font-size:11px; color:#64748b;">A Receber: ${formatarMoedaTesouraria(Number(r.entradas_previstas) + Number(r.entradas_vencidas))} | A Pagar: ${formatarMoedaTesouraria(Number(r.saidas_previstas) + Number(r.saidas_vencidas))}</div>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:12px;">
        <div style="font-size:11px; color:#64748b; font-weight:700;">SALDO FINAL PROJETADO</div>
        <div style="font-size:18px; font-weight:800; color:${Number(r.saldo_final_projetado) >= 0 ? '#0f172a' : '#dc2626'}; margin-top:4px;">${formatarMoedaTesouraria(r.saldo_final_projetado)}</div>
        <div style="font-size:11px; color:#6d28d9;">Crédito Cliente usado: ${formatarMoedaTesouraria(r.credito_cliente_utilizado_periodo)}</div>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; text-align:right;">
            <th style="padding:8px; text-align:left;">Data</th>
            <th style="padding:8px;">Entradas Realiz.</th>
            <th style="padding:8px;">Saídas Realiz.</th>
            <th style="padding:8px;">Líquido Realiz.</th>
            <th style="padding:8px;">Saldo Acum. Realiz.</th>
            <th style="padding:8px;">Entradas Prev.</th>
            <th style="padding:8px;">Saídas Prev.</th>
            <th style="padding:8px;">Saldo Acum. Projetado</th>
          </tr>
        </thead>
        <tbody>
          ${diario.map(d => `
            <tr style="border-bottom:1px solid #f1f5f9; text-align:right;">
              <td style="padding:8px; text-align:left; font-weight:700;">${formatarDataBrTesouraria(d.data)}</td>
              <td style="padding:8px; color:#15803d;">${formatarMoedaTesouraria(d.entradas_realizadas)}</td>
              <td style="padding:8px; color:#b91c1c;">${formatarMoedaTesouraria(d.saidas_realizadas)}</td>
              <td style="padding:8px; font-weight:700; color:${Number(d.liquido_realizado) >= 0 ? '#15803d' : '#b91c1c'};">${formatarMoedaTesouraria(d.liquido_realizado)}</td>
              <td style="padding:8px; font-weight:700;">${formatarMoedaTesouraria(d.saldo_acumulado_realizado)}</td>
              <td style="padding:8px; color:#0284c7;">${formatarMoedaTesouraria(Number(d.entradas_previstas) + Number(d.entradas_vencidas))}</td>
              <td style="padding:8px; color:#d97706;">${formatarMoedaTesouraria(Number(d.saidas_previstas) + Number(d.saidas_vencidas))}</td>
              <td style="padding:8px; font-weight:800; color:${Number(d.saldo_acumulado_projetado) >= 0 ? '#0f172a' : '#dc2626'};">${formatarMoedaTesouraria(d.saldo_acumulado_projetado)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function renderizarSubAbaRecebimentosPrevistos(container) {
  const { dataInicio, dataFim } = obterDatasPadraoTesouraria();
  const { data, error } = await supabaseClient.rpc('obter_recebimentos_previstos_admin', {
    p_data_inicio: dataInicio,
    p_data_fim: dataFim
  });
  if (error) throw error;
  if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar recebimentos previstos.');

  const lista = data.recebiveis || [];
  const res = data.resumo || {};

  container.innerHTML = `
    <div style="display:flex; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#166534; font-weight:700;">PREVISTO NO PRAZO:</span>
        <strong style="font-size:16px; color:#15803d; margin-left:6px;">${formatarMoedaTesouraria(res.total_previsto)}</strong>
      </div>
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#991b1b; font-weight:700;">VENCIDO:</span>
        <strong style="font-size:16px; color:#dc2626; margin-left:6px;">${formatarMoedaTesouraria(res.total_vencido)}</strong>
      </div>
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#334155; font-weight:700;">TOTAL A RECEBER (CONFIRMADOS):</span>
        <strong style="font-size:16px; color:#0f172a; margin-left:6px;">${formatarMoedaTesouraria(res.total_a_receber)}</strong>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">
      ${lista.length === 0 ? `<p style="text-align:center; color:#64748b; padding:20px;">Nenhum saldo previsto de encomenda confirmada neste período.</p>` : `
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; text-align:left;">
              <th style="padding:8px;">Pedido</th>
              <th style="padding:8px;">Cliente</th>
              <th style="padding:8px;">Data Prevista</th>
              <th style="padding:8px;">Classificação</th>
              <th style="padding:8px; text-align:right;">Total Pedido</th>
              <th style="padding:8px; text-align:right;">Já Pago</th>
              <th style="padding:8px; text-align:right;">Saldo Previsto</th>
            </tr>
          </thead>
          <tbody>
            ${lista.map(item => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px; font-weight:700;">#${item.pedido_id}</td>
                <td style="padding:8px;">${escTesouraria(item.nome_cliente)}</td>
                <td style="padding:8px;">${formatarDataBrTesouraria(item.data_prevista)}</td>
                <td style="padding:8px;">
                  <span style="padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:${item.classificacao_temporal === 'vencido' ? '#fef2f2' : '#e0f2fe'}; color:${item.classificacao_temporal === 'vencido' ? '#dc2626' : '#0369a1'};">
                    ${escTesouraria(item.classificacao_temporal.toUpperCase())}
                  </span>
                </td>
                <td style="padding:8px; text-align:right;">${formatarMoedaTesouraria(item.valor_total_pedido)}</td>
                <td style="padding:8px; text-align:right; color:#15803d;">${formatarMoedaTesouraria(item.valor_pago)}</td>
                <td style="padding:8px; text-align:right; font-weight:800; color:#b45309;">${formatarMoedaTesouraria(item.saldo_previsto)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

async function renderizarSubAbaContasPagarPeriodo(container) {
  const { dataInicio, dataFim } = obterDatasPadraoTesouraria();
  const { data, error } = await supabaseClient.rpc('obter_contas_pagar_periodo_admin', {
    p_data_inicio: dataInicio,
    p_data_fim: dataFim,
    p_status: null
  });
  if (error) throw error;
  if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar contas a pagar.');

  const contas = data.contas || [];
  const res = data.resumo || {};

  container.innerHTML = `
    <div style="display:flex; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#92400e; font-weight:700;">A VENCER (PREVISTO):</span>
        <strong style="font-size:16px; color:#b45309; margin-left:6px;">${formatarMoedaTesouraria(res.total_previsto)}</strong>
      </div>
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#991b1b; font-weight:700;">VENCIDO:</span>
        <strong style="font-size:16px; color:#dc2626; margin-left:6px;">${formatarMoedaTesouraria(res.total_vencido)}</strong>
      </div>
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px 16px;">
        <span style="font-size:11px; color:#166534; font-weight:700;">PAGO NO PERÍODO:</span>
        <strong style="font-size:16px; color:#15803d; margin-left:6px;">${formatarMoedaTesouraria(res.total_pago)}</strong>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">
      ${contas.length === 0 ? `<p style="text-align:center; color:#64748b; padding:20px;">Nenhuma conta a pagar no período selecionado.</p>` : `
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; text-align:left;">
              <th style="padding:8px;">Descrição / Fornecedor</th>
              <th style="padding:8px;">Vencimento</th>
              <th style="padding:8px;">Classificação</th>
              <th style="padding:8px; text-align:right;">Total</th>
              <th style="padding:8px; text-align:right;">Pago</th>
              <th style="padding:8px; text-align:right;">Saldo Aberto</th>
            </tr>
          </thead>
          <tbody>
            ${contas.map(c => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px;">
                  <strong>${escTesouraria(c.descricao)}</strong>
                  <div style="font-size:11px; color:#64748b;">${escTesouraria(c.fornecedor_nome || 'Fornecedor')}</div>
                </td>
                <td style="padding:8px;">${formatarDataBrTesouraria(c.data_vencimento)}</td>
                <td style="padding:8px;">
                  <span style="padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:${c.classificacao_temporal === 'vencido' ? '#fef2f2' : c.classificacao_temporal === 'realizado' ? '#dcfce7' : '#fef3c7'}; color:${c.classificacao_temporal === 'vencido' ? '#dc2626' : c.classificacao_temporal === 'realizado' ? '#166534' : '#92400e'};">
                    ${escTesouraria(c.classificacao_temporal.toUpperCase())}
                  </span>
                </td>
                <td style="padding:8px; text-align:right;">${formatarMoedaTesouraria(c.valor_total)}</td>
                <td style="padding:8px; text-align:right; color:#15803d;">${formatarMoedaTesouraria(c.valor_pago)}</td>
                <td style="padding:8px; text-align:right; font-weight:800; color:#b91c1c;">${formatarMoedaTesouraria(c.saldo_aberto)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

async function renderizarSubAbaConciliacaoFinanceira(container) {
  const { dataInicio, dataFim } = obterDatasPadraoTesouraria();
  const { data, error } = await supabaseClient.rpc('obter_conciliacao_financeira_admin', {
    p_data_inicio: dataInicio,
    p_data_fim: dataFim,
    p_status: null
  });
  if (error) throw error;
  if (!data || !data.success) throw new Error(data?.error || 'Erro ao carregar conciliação financeira.');

  const itens = data.itens || [];
  const res = data.resumo || {};

  container.innerHTML = `
    <div style="display:flex; gap:12px; margin-bottom:14px; flex-wrap:wrap;">
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:10px 14px;">
        <span style="font-size:11px; color:#92400e; font-weight:700;">PENDENTES:</span>
        <strong style="font-size:16px; color:#b45309; margin-left:6px;">${res.pendente || 0}</strong>
      </div>
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:10px 14px;">
        <span style="font-size:11px; color:#166534; font-weight:700;">CONCILIADOS:</span>
        <strong style="font-size:16px; color:#15803d; margin-left:6px;">${res.conciliado || 0}</strong>
      </div>
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:10px 14px;">
        <span style="font-size:11px; color:#991b1b; font-weight:700;">DIVERGENTES:</span>
        <strong style="font-size:16px; color:#dc2626; margin-left:6px;">${res.divergente || 0}</strong>
      </div>
    </div>

    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">
      ${itens.length === 0 ? `<p style="text-align:center; color:#64748b; padding:20px;">Nenhum lançamento no período para conciliação.</p>` : `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; text-align:left;">
              <th style="padding:8px;">Data</th>
              <th style="padding:8px;">Descrição / Categoria</th>
              <th style="padding:8px;">Método</th>
              <th style="padding:8px; text-align:right;">Valor Interno</th>
              <th style="padding:8px;">Status Conciliação</th>
              <th style="padding:8px; text-align:right;">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${itens.map(item => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px;">${formatarDataBrTesouraria(item.data_efetiva)}</td>
                <td style="padding:8px;">
                  <strong>${escTesouraria(item.descricao)}</strong>
                  <div style="font-size:11px; color:#64748b;">${escTesouraria(item.categoria)} (${escTesouraria(item.natureza)})</div>
                </td>
                <td style="padding:8px;">${escTesouraria(item.forma_pagamento || '-')}</td>
                <td style="padding:8px; text-align:right; font-weight:700; color:${item.natureza === 'receita' ? '#15803d' : '#b91c1c'};">
                  ${formatarMoedaTesouraria(item.valor_interno)}
                </td>
                <td style="padding:8px;">
                  <span style="padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:${item.status_conciliacao === 'conciliado' ? '#dcfce7' : item.status_conciliacao === 'divergente' ? '#fef2f2' : '#f1f5f9'}; color:${item.status_conciliacao === 'conciliado' ? '#166534' : item.status_conciliacao === 'divergente' ? '#dc2626' : '#475569'};">
                    ${escTesouraria(item.status_conciliacao.toUpperCase())}
                  </span>
                </td>
                <td style="padding:8px; text-align:right;">
                  <button onclick="conciliarRapidoLancamento('${item.origem_tipo}', ${item.origem_id}, ${Number(item.valor_interno)})" class="btn-outline" style="padding:4px 8px; font-size:11px; border-radius:6px;">
                    <i class="fa-solid fa-check"></i> Conciliar
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

async function conciliarRapidoLancamento(origemTipo, origemId, valorInterno) {
  try {
    const { data, error } = await supabaseClient.rpc('registrar_conciliacao_financeira_admin', {
      p_origem_tipo: origemTipo,
      p_origem_id: Number(origemId),
      p_status: 'conciliado',
      p_valor_extrato: Number(valorInterno),
      p_referencia_externa: 'CONC-PAINEL',
      p_motivo: 'Conciliação confirmada pelo painel administrativo',
      p_idempotency_key: `ui_conc_${origemTipo}_${origemId}_${valorInterno}`
    });
    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Falha ao conciliar lançamento.');

    if (typeof mostrarToast === 'function') {
      mostrarToast('Lançamento conciliado com sucesso!', 'sucesso');
    }
    await carregarTesourariaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') {
      mostrarToast(err.message || 'Erro ao conciliar', 'erro');
    }
  }
}

async function abrirModalAjusteTesouraria() {
  const contas = cachePosicaoTesouraria?.contas_financeiras || [];
  if (contas.length === 0) {
    if (typeof mostrarToast === 'function') mostrarToast('Carregue a posição de tesouraria primeiro.', 'aviso');
    return;
  }

  const tipo = prompt('Tipo de ajuste (digite "entrada" ou "saida"):', 'saida');
  if (!tipo || !['entrada', 'saida'].includes(tipo.trim().toLowerCase())) return;

  const valorStr = prompt('Valor do ajuste (R$):', '0.00');
  const valor = Number(String(valorStr || '').replace(',', '.'));
  if (!valor || valor <= 0) return;

  const motivo = prompt('Motivo auditável do ajuste (mínimo 5 caracteres):', '');
  if (!motivo || motivo.trim().length < 5) {
    if (typeof mostrarToast === 'function') mostrarToast('Informe um motivo com pelo menos 5 caracteres.', 'aviso');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('registrar_ajuste_tesouraria_admin', {
      p_conta_financeira_id: contas[0].id,
      p_tipo: tipo.trim().toLowerCase(),
      p_valor: valor,
      p_motivo: motivo.trim(),
      p_idempotency_key: `ui_aj_${Date.now()}`
    });
    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Erro ao registrar ajuste.');

    if (typeof mostrarToast === 'function') mostrarToast('Ajuste de tesouraria registrado com sucesso!', 'sucesso');
    await carregarTesourariaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message || 'Erro ao registrar ajuste', 'erro');
  }
}

window.mudarSubAbaTesouraria = mudarSubAbaTesouraria;
window.carregarTesourariaAdmin = carregarTesourariaAdmin;
window.conciliarRapidoLancamento = conciliarRapidoLancamento;
window.abrirModalAjusteTesouraria = abrirModalAjusteTesouraria;
