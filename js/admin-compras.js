// ==============================================================================
// LUNOCA - COMPRAS, FORNECEDORES, INSUMOS E CMV REAL (FRENTE G - MIGRATION 022)
// ==============================================================================
// Integra o ciclo completo de abastecimento:
// - Fornecedores (salvar_fornecedor_admin, listar_fornecedores_admin)
// - Pedidos de Compra e Recebimento (criar_compra, receber_compra, cancelar_compra)
// - Contas a Pagar de Insumos (registrar_pagamento_fornecedor)
// - Reposição Inteligente com Demanda da Agenda (obter_necessidade_reposicao)
// - CMV Real vs Custo Teórico (obter_cmv_real_produto)
// - Perdas e Ajustes Auditados (registrar_perda_insumo, ajustar_estoque_insumo_admin)
// ==============================================================================

let fornecedoresCache = [];
let comprasCache = [];
let contasPagarCache = [];
let reposicaoCache = [];
let cmvRealCache = [];
let lotesValidadeCache = { resumo: {}, lotes: [] };
let filtroEstadoLoteAtual = null;
let abaComprasInternaAtual = 'reposicao';

function formatarMoedaCompras(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarQtdInsumo(val, unidade = 'g') {
  const num = Number(val) || 0;
  return `${num.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unidade}`;
}

async function carregarComprasInsumosAdmin() {
  const container = document.getElementById('compras-conteudo-dinamico');
  if (!container) return;

  container.innerHTML = `
    <div style="text-align:center; padding:45px 20px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:12px; display:block;"></i>
      <div style="font-weight:600; font-size:14px;">Sincronizando abastecimento, lotes FEFO, saldos e custos reais...</div>
    </div>
  `;

  try {
    const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';

    // 1. Necessidade de reposição (permitido para Admin e Operador)
    const { data: repData, error: repErr } = await supabaseClient.rpc('obter_necessidade_reposicao', {
      p_dias_horizonte: 7
    });
    if (repErr) throw repErr;
    reposicaoCache = repData?.itens || [];

    // 2. Painel de Lotes e Validade FEFO (permitido para Admin e Operador - sanitizado para Operador)
    const { data: lotesData } = await supabaseClient.rpc('obter_painel_lotes_validade', {
      p_ingrediente_id: null,
      p_filtro_estado: filtroEstadoLoteAtual
    });
    if (lotesData && lotesData.success) {
      lotesValidadeCache = {
        resumo: lotesData.resumo || {},
        lotes: lotesData.lotes || []
      };
    }

    // 3. Fornecedores (leitura permitida para Admin e Operador)
    const { data: fornData } = await supabaseClient.rpc('listar_fornecedores_admin', {
      p_apenas_ativos: false
    });
    fornecedoresCache = fornData?.fornecedores || [];

    if (!isOperador) {
      // 4. CMV Real vs Teórico (exclusivo Admin)
      const { data: cmvData } = await supabaseClient.rpc('obter_cmv_real_produto');
      cmvRealCache = cmvData?.produtos || [];

      // 5. Compras e Contas a Pagar
      const { data: compRows } = await supabaseClient
        .from('compras')
        .select('*')
        .order('id', { ascending: false })
        .limit(50);
      comprasCache = compRows || [];

      const { data: cpRows } = await supabaseClient
        .from('contas_pagar')
        .select('*')
        .order('data_vencimento', { ascending: true })
        .limit(50);
      contasPagarCache = cpRows || [];
    }

    renderizarPainelComprasInsumos();
  } catch (err) {
    console.error('[Compras & Insumos] Erro:', err);
    container.innerHTML = `
      <div style="padding:20px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b; text-align:center;">
        <i class="fa-solid fa-triangle-exclamation"></i> Falha ao carregar módulo de abastecimento: ${err.message || 'Erro inesperado'}
      </div>
    `;
  }
}

function mudarSubAbaCompras(subAba) {
  abaComprasInternaAtual = subAba;
  document.querySelectorAll('.btn-subaba-compras').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`btn-subaba-compras-${subAba}`);
  if (btn) btn.classList.add('active');
  renderizarPainelComprasInsumos();
}

function renderizarPainelComprasInsumos() {
  const container = document.getElementById('compras-conteudo-dinamico');
  if (!container) return;

  const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';

  // Resumo rápido no topo
  const qtdRepor = reposicaoCache.filter(i => i.precisa_repor).length;
  const custoEstRepor = reposicaoCache.reduce((acc, i) => acc + (Number(i.custo_estimado_reposicao) || 0), 0);
  const contasAbertasTotal = contasPagarCache
    .filter(c => c.status === 'aberta' || c.status === 'parcial')
    .reduce((acc, c) => acc + (Number(c.saldo_aberto) || 0), 0);
  const qtdLotesAlerta = (Number(lotesValidadeCache.resumo?.vencidos) || 0) + (Number(lotesValidadeCache.resumo?.vencem_em_breve) || 0);

  let htmlTopo = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; margin-bottom:18px;">
      <div class="metric-card-nooty" style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:14px; border-left:4px solid #f59e0b;">
        <div style="font-size:11px; font-weight:700; color:#d97706; text-transform:uppercase;">Insumos para Repor (7 dias)</div>
        <div style="font-size:22px; font-weight:800; color:#1e293b; margin:4px 0;">${qtdRepor} itens</div>
        <div style="font-size:11px; color:#64748b;">Estoque mínimo + agenda confirmada</div>
      </div>
      <div class="metric-card-nooty" style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:14px; border-left:4px solid #dc2626;">
        <div style="font-size:11px; font-weight:700; color:#dc2626; text-transform:uppercase;">Alertas de Lote / Validade</div>
        <div style="font-size:22px; font-weight:800; color:#1e293b; margin:4px 0;">${qtdLotesAlerta} lotes</div>
        <div style="font-size:11px; color:#64748b;">Vencidos ou vencendo em breve (FEFO)</div>
      </div>
  `;

  if (!isOperador) {
    htmlTopo += `
      <div class="metric-card-nooty" style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:14px; border-left:4px solid #3b82f6;">
        <div style="font-size:11px; font-weight:700; color:#2563eb; text-transform:uppercase;">Orçamento Est. Reposição</div>
        <div style="font-size:22px; font-weight:800; color:#1e293b; margin:4px 0;">${formatarMoedaCompras(custoEstRepor)}</div>
        <div style="font-size:11px; color:#64748b;">Valorizado pelo Custo Médio Real</div>
      </div>
      <div class="metric-card-nooty" style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:14px; border-left:4px solid #ef4444;">
        <div style="font-size:11px; font-weight:700; color:#dc2626; text-transform:uppercase;">Contas a Pagar em Aberto</div>
        <div style="font-size:22px; font-weight:800; color:#b91c1c; margin:4px 0;">${formatarMoedaCompras(contasAbertasTotal)}</div>
        <div style="font-size:11px; color:#64748b;">Fornecedores de insumos</div>
      </div>
    `;
  }
  htmlTopo += `</div>`;

  let htmlCorpo = '';
  if (abaComprasInternaAtual === 'lotes') {
    htmlCorpo = renderizarSubAbaLotesValidade();
  } else if (abaComprasInternaAtual === 'reposicao' || isOperador) {
    htmlCorpo = renderizarSubAbaReposicao();
  } else if (abaComprasInternaAtual === 'compras') {
    htmlCorpo = renderizarSubAbaComprasLista();
  } else if (abaComprasInternaAtual === 'contas') {
    htmlCorpo = renderizarSubAbaContasPagar();
  } else if (abaComprasInternaAtual === 'cmv') {
    htmlCorpo = renderizarSubAbaCmvReal();
  } else if (abaComprasInternaAtual === 'fornecedores') {
    htmlCorpo = renderizarSubAbaFornecedores();
  }

  container.innerHTML = htmlTopo + htmlCorpo;
}

function renderizarSubAbaReposicao() {
  if (reposicaoCache.length === 0) {
    return `<div style="padding:30px; text-align:center; color:#64748b; background:#fff; border-radius:12px;">Nenhum ingrediente ativo cadastrado.</div>`;
  }

  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <h4 style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">
        <i class="fa-solid fa-boxes-Compare" style="color:var(--primary);"></i> Sugestão de Compra & Necessidade de Reposição (Horizonte 7 dias)
      </h4>
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
            <th style="padding:10px;">Ingrediente</th>
            <th style="padding:10px;">Saldo Atual</th>
            <th style="padding:10px;">Estoque Mínimo</th>
            <th style="padding:10px;">Consumo Previsto (7d)</th>
            <th style="padding:10px;">Sugestão de Compra</th>
            <th style="padding:10px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${reposicaoCache.map(item => `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:10px; font-weight:600; color:#1e293b;">${item.nome}</td>
              <td style="padding:10px;">${formatarQtdInsumo(item.saldo_atual, item.unidade)}</td>
              <td style="padding:10px;">${formatarQtdInsumo(item.estoque_minimo, item.unidade)}</td>
              <td style="padding:10px; color:#0284c7; font-weight:600;">${formatarQtdInsumo(item.consumo_previsto, item.unidade)}</td>
              <td style="padding:10px; font-weight:700; color:${item.precisa_repor ? '#dc2626' : '#059669'};">
                ${formatarQtdInsumo(item.sugestao_compra, item.unidade)}
              </td>
              <td style="padding:10px;">
                ${item.precisa_repor
                  ? '<span style="background:#fef2f2; color:#dc2626; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">Repor Estoque</span>'
                  : '<span style="background:#ecfdf5; color:#059669; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">Abastecido</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderizarSubAbaCmvReal() {
  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <h4 style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">
        <i class="fa-solid fa-scale-unbalanced-flip" style="color:var(--primary);"></i> Comparativo: Custo Teórico de Receita vs CMV Real (Custo Médio Ponderado)
      </h4>
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
            <th style="padding:10px;">Produto</th>
            <th style="padding:10px;">Preço Venda</th>
            <th style="padding:10px;">Custo Teórico (Ref)</th>
            <th style="padding:10px;">CMV Real (CMP)</th>
            <th style="padding:10px;">Margem Teórica</th>
            <th style="padding:10px;">Margem Real</th>
            <th style="padding:10px;">Lucro Bruto Real</th>
          </tr>
        </thead>
        <tbody>
          ${cmvRealCache.map(p => `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:10px; font-weight:600; color:#1e293b;">${p.produto_nome}</td>
              <td style="padding:10px;">${formatarMoedaCompras(p.preco_venda)}</td>
              <td style="padding:10px; color:#64748b;">${formatarMoedaCompras(p.custo_teorico_receita)}</td>
              <td style="padding:10px; font-weight:700; color:#0f172a;">${formatarMoedaCompras(p.cmv_real)}</td>
              <td style="padding:10px; color:#64748b;">${Number(p.margem_teorica_pct || 0).toFixed(1)}%</td>
              <td style="padding:10px; font-weight:700; color:${Number(p.margem_real_pct) >= 50 ? '#059669' : '#d97706'};">
                ${Number(p.margem_real_pct || 0).toFixed(1)}%
              </td>
              <td style="padding:10px; font-weight:700; color:#047857;">${formatarMoedaCompras(p.lucro_bruto_real)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderizarSubAbaComprasLista() {
  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <h4 style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">Histórico de Pedidos de Compra</h4>
      ${comprasCache.length === 0 ? '<p style="color:#64748b; font-size:12px;">Nenhuma compra registrada até o momento.</p>' : `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
              <th style="padding:10px;">#ID</th>
              <th style="padding:10px;">NF</th>
              <th style="padding:10px;">Data</th>
              <th style="padding:10px;">Total</th>
              <th style="padding:10px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${comprasCache.map(c => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:10px; font-weight:700;">#${c.id}</td>
                <td style="padding:10px;">${c.numero_nota || '-'}</td>
                <td style="padding:10px;">${c.data_compra}</td>
                <td style="padding:10px; font-weight:700;">${formatarMoedaCompras(c.valor_total)}</td>
                <td style="padding:10px;">${c.status.toUpperCase()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

function renderizarSubAbaContasPagar() {
  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <h4 style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">Contas a Pagar (Fornecedores)</h4>
      ${contasPagarCache.length === 0 ? '<p style="color:#64748b; font-size:12px;">Nenhuma conta a pagar registrada.</p>' : `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
              <th style="padding:10px;">Descrição</th>
              <th style="padding:10px;">Vencimento</th>
              <th style="padding:10px;">Total</th>
              <th style="padding:10px;">Pago</th>
              <th style="padding:10px;">Saldo Aberto</th>
              <th style="padding:10px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${contasPagarCache.map(cp => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:10px; font-weight:600;">${cp.descricao}</td>
                <td style="padding:10px;">${cp.data_vencimento}</td>
                <td style="padding:10px;">${formatarMoedaCompras(cp.valor_total)}</td>
                <td style="padding:10px; color:#059669;">${formatarMoedaCompras(cp.valor_pago)}</td>
                <td style="padding:10px; font-weight:700; color:#dc2626;">${formatarMoedaCompras(cp.saldo_aberto)}</td>
                <td style="padding:10px;">${cp.status.toUpperCase()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

function renderizarSubAbaFornecedores() {
  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <h4 style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">Catálogo de Fornecedores</h4>
      ${fornecedoresCache.length === 0 ? '<p style="color:#64748b; font-size:12px;">Nenhum fornecedor cadastrado.</p>' : `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
              <th style="padding:10px;">Nome</th>
              <th style="padding:10px;">Documento</th>
              <th style="padding:10px;">Telefone</th>
              <th style="padding:10px;">Contato</th>
            </tr>
          </thead>
          <tbody>
            ${fornecedoresCache.map(f => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:10px; font-weight:600;">${f.nome}</td>
                <td style="padding:10px;">${f.documento || '-'}</td>
                <td style="padding:10px;">${f.telefone || '-'}</td>
                <td style="padding:10px;">${f.contato_nome || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// ==============================================================================
// FRENTE L - LOTES, VALIDADE FEFO E RASTREABILIDADE (MIGRATION 027)
// ==============================================================================

function renderizarSubAbaLotesValidade() {
  const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';
  const resumo = lotesValidadeCache.resumo || {};
  const lotes = lotesValidadeCache.lotes || [];

  const badgeEstado = (est) => {
    switch (est) {
      case 'vencido':
        return '<span style="background:#fef2f2; color:#dc2626; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">🔴 Vencido</span>';
      case 'vence_em_breve':
        return '<span style="background:#fffbeb; color:#d97706; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">🟠 Vence em Breve</span>';
      case 'bloqueado':
        return '<span style="background:#f1f5f9; color:#0f172a; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">⚫ Bloqueado Qualidade</span>';
      case 'esgotado':
        return '<span style="background:#f8fafc; color:#94a3b8; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">⚪ Esgotado</span>';
      default:
        return '<span style="background:#ecfdf5; color:#059669; padding:3px 8px; border-radius:10px; font-weight:700; font-size:11px;">🟢 Regular (FEFO)</span>';
    }
  };

  return `
    <div style="background:#fff; border-radius:12px; border:1px solid #e2e8f0; padding:16px; overflow-x:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
        <h4 style="margin:0; font-size:14px; color:#1e293b;">
          <i class="fa-solid fa-boxes-stacked" style="color:var(--primary);"></i> Rastreabilidade de Lotes & Validade FEFO (First Expired, First Out)
        </h4>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button onclick="filtrarEstadoLotePainelUI('')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px;">
            Todos (${resumo.total_lotes_ativos || 0})
          </button>
          <button onclick="filtrarEstadoLotePainelUI('vencido')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px; color:#dc2626; border-color:#fecaca;">
            🔴 Vencidos (${resumo.vencidos || 0})
          </button>
          <button onclick="filtrarEstadoLotePainelUI('vence_em_breve')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px; color:#d97706; border-color:#fde68a;">
            🟠 Vencem em Breve (${resumo.vencem_em_breve || 0})
          </button>
          <button onclick="filtrarEstadoLotePainelUI('valido')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px; color:#059669; border-color:#a7f3d0;">
            🟢 Regulares (${resumo.regulares || 0})
          </button>
          <button onclick="filtrarEstadoLotePainelUI('bloqueado')" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px; color:#334155; border-color:#cbd5e1;">
            ⚫ Bloqueados (${resumo.bloqueados || 0})
          </button>
        </div>
      </div>

      ${lotes.length === 0 ? '<p style="color:#64748b; font-size:12px; padding:16px 0; text-align:center;">Nenhum lote encontrado para o filtro selecionado.</p>' : `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="background:#f8fafc; color:#475569; text-align:left; border-bottom:1px solid #e2e8f0;">
              <th style="padding:10px;">Código Lote</th>
              <th style="padding:10px;">Ingrediente</th>
              <th style="padding:10px;">Saldo Lote</th>
              <th style="padding:10px;">Validade</th>
              <th style="padding:10px;">Estado Derivado</th>
              ${!isOperador ? '<th style="padding:10px;">Custo Unit.</th>' : ''}
              <th style="padding:10px;">Ações / Recall</th>
            </tr>
          </thead>
          <tbody>
            ${lotes.map(l => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:10px; font-weight:700; color:#0f172a;">
                  ${l.codigo_lote}
                  ${l.fornecedor_nome ? `<div style="font-size:10px; color:#64748b;">Forn: ${l.fornecedor_nome}</div>` : ''}
                </td>
                <td style="padding:10px; font-weight:600;">${l.ingrediente_nome}</td>
                <td style="padding:10px; font-weight:700;">${formatarQtdInsumo(l.quantidade_atual, l.unidade)}</td>
                <td style="padding:10px;">
                  ${l.data_validade || 'Sem validade'}
                  ${l.dias_para_vencer !== null && l.dias_para_vencer !== undefined ? `<div style="font-size:10px; color:#64748b;">(${l.dias_para_vencer} dias)</div>` : ''}
                </td>
                <td style="padding:10px;">${badgeEstado(l.estado_validade)}</td>
                ${!isOperador ? `<td style="padding:10px;">${formatarMoedaCompras(l.custo_unitario_lote)}</td>` : ''}
                <td style="padding:10px; display:flex; gap:6px; flex-wrap:wrap;">
                  <button onclick="rastrearLoteIngredienteUI(${l.lote_id})" class="btn-outline" style="padding:3px 8px; font-size:11px; border-radius:6px;">
                    <i class="fa-solid fa-magnifying-glass-chart"></i> Recall
                  </button>
                  <button onclick="registrarBaixaLoteUI(${l.lote_id}, '${l.codigo_lote}', ${l.quantidade_atual})" class="btn-outline" style="padding:3px 8px; font-size:11px; border-radius:6px; color:#dc2626; border-color:#fecaca;">
                    <i class="fa-solid fa-trash-can"></i> Baixa
                  </button>
                  <button onclick="alterarBloqueioLoteUI(${l.lote_id}, ${!l.bloqueado_qualidade})" class="btn-outline" style="padding:3px 8px; font-size:11px; border-radius:6px;">
                    ${l.bloqueado_qualidade ? 'Desbloquear' : 'Bloquear'}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
      <div id="painel-recall-lote-resultado" style="margin-top:16px;"></div>
    </div>
  `;
}

async function filtrarEstadoLotePainelUI(estado) {
  filtroEstadoLoteAtual = estado || null;
  await carregarComprasInsumosAdmin();
}

async function rastrearLoteIngredienteUI(loteId) {
  const box = document.getElementById('painel-recall-lote-resultado');
  if (!box) return;
  box.innerHTML = `<div style="padding:12px; font-size:12px; color:#64748b;">Rastreando lote #${loteId}...</div>`;
  try {
    const { data, error } = await supabaseClient.rpc('rastrear_lote_ingrediente_admin', {
      p_lote_id: loteId
    });
    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Falha ao rastrear lote.');

    const pedidos = data.pedidos_afetados || [];
    box.innerHTML = `
      <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:10px; padding:14px;">
        <h5 style="margin:0 0 8px 0; font-size:13px; color:#0f172a;">
          <i class="fa-solid fa-shield-halved" style="color:var(--primary);"></i> Relatório de Recall & Rastreabilidade — Lote ${data.lote?.codigo_lote} (${data.lote?.ingrediente_nome})
        </h5>
        <div style="font-size:12px; color:#334155; margin-bottom:8px;">
          Fornecedor: <strong>${data.lote?.fornecedor_nome || 'Não vinculado'}</strong> •
          Recebimento: <strong>${data.lote?.data_recebimento || '-'}</strong> •
          Validade: <strong>${data.lote?.data_validade || 'N/A'}</strong> •
          Pedidos impactados: <strong>${data.total_pedidos_afetados || 0}</strong>
        </div>
        ${pedidos.length === 0 ? '<div style="font-size:12px; color:#059669; font-weight:600;">Nenhum pedido consumiu este lote até o momento.</div>' : `
          <ul style="margin:0; padding-left:18px; font-size:12px; color:#1e293b;">
            ${pedidos.map(p => `
              <li>
                <strong>Pedido #${p.pedido_id}</strong> — ${p.nome_cliente} (${p.telefone_cliente || 'sem tel'}) •
                Entrega: ${p.data_entrega} • Status: ${p.status_operacional} •
                Consumido: ${p.quantidade_consumida}
              </li>
            `).join('')}
          </ul>
        `}
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div style="padding:10px; color:#dc2626; font-size:12px;">Erro no recall: ${err.message}</div>`;
  }
}

async function registrarBaixaLoteUI(loteId, codigoLote, saldoAtual) {
  const qtdStr = prompt(`Quantidade a baixar do lote ${codigoLote} (Saldo atual: ${saldoAtual}):`, String(saldoAtual));
  if (!qtdStr) return;
  const qtd = Number(qtdStr.replace(',', '.'));
  if (!Number.isFinite(qtd) || qtd <= 0) return;

  const tipo = prompt('Tipo de baixa (VENCIMENTO, PERDA ou DEVOLUCAO):', 'VENCIMENTO');
  if (!tipo) return;
  const motivo = prompt('Motivo auditável da baixa:', 'Descarte sanitário por vencimento / avaria');
  if (!motivo) return;

  try {
    const { data, error } = await supabaseClient.rpc('registrar_baixa_lote_insumo', {
      p_lote_id: loteId,
      p_tipo_evento: tipo.trim().toUpperCase(),
      p_quantidade: qtd,
      p_motivo: motivo.trim()
    });
    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Erro ao baixar lote.');
    if (typeof mostrarToast === 'function') mostrarToast(`Baixa registrada no lote ${codigoLote}.`, 'sucesso');
    await carregarComprasInsumosAdmin();
  } catch (err) {
    alert(err.message || 'Erro ao registrar baixa de lote.');
  }
}

async function alterarBloqueioLoteUI(loteId, bloquear) {
  const motivo = prompt(
    bloquear ? 'Informe o motivo do bloqueio de qualidade do lote:' : 'Informe a justificativa para liberar o lote:',
    bloquear ? 'Suspeita sensorial / inspeção de qualidade' : 'Reinspeção aprovada'
  );
  if (!motivo) return;

  try {
    const { data, error } = await supabaseClient.rpc('alterar_bloqueio_qualidade_lote', {
      p_lote_id: loteId,
      p_bloquear: Boolean(bloquear),
      p_motivo: motivo.trim()
    });
    if (error) throw error;
    if (!data || !data.success) throw new Error(data?.error || 'Erro ao alterar bloqueio.');
    if (typeof mostrarToast === 'function') mostrarToast('Status de qualidade do lote atualizado!', 'sucesso');
    await carregarComprasInsumosAdmin();
  } catch (err) {
    alert(err.message || 'Erro ao alterar bloqueio do lote.');
  }
}

window.carregarComprasInsumosAdmin = carregarComprasInsumosAdmin;
window.mudarSubAbaCompras = mudarSubAbaCompras;
window.filtrarEstadoLotePainelUI = filtrarEstadoLotePainelUI;
window.rastrearLoteIngredienteUI = rastrearLoteIngredienteUI;
window.registrarBaixaLoteUI = registrarBaixaLoteUI;
window.alterarBloqueioLoteUI = alterarBloqueioLoteUI;

