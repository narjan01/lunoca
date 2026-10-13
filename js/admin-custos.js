// ==============================================================================
// LUNOCA - ENGENHARIA DE CUSTOS, PRECIFICAÇÃO E MARGENS (FRENTE M - MIGRATION 028)
// ==============================================================================
// Módulo de administração fabril e financeira para controle de margens:
// - Simulação de Preço e Break-even (simular_preco_produto_admin)
// - Auditoria e Consolidação de Custo Real por Pedido (calcular_custo_real_pedido_admin, obter_margem_pedido_admin)
// - Margens Consolidadas do Catálogo (obter_margens_produtos_admin)
// - Engenharia de Recursos Fabris e Tempos (recursos_producao, produto_tempos_producao)
// - Embalagens e Custos Adicionais (produto_custos_adicionais)
// - Políticas de Precificação e Deduções (politicas_precificacao)
// - Dashboard Executivo de Margens de Contribuição (obter_dashboard_margens_admin)
// ==============================================================================

let custosDashboardCache = null;
let margensProdutosCache = [];
let recursosProducaoCache = [];
let politicasPrecificacaoCache = [];
let subAbaCustosAtual = 'dashboard';

function formatarMoedaCustos(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarPercentualCustos(val) {
  const num = Number(val) || 0;
  return `${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function mudarSubAbaCustos(aba) {
  subAbaCustosAtual = aba;
  document.querySelectorAll('.btn-subaba-custos').forEach(btn => btn.classList.remove('active'));
  const btnAtivo = document.getElementById(`btn-subaba-custos-${aba}`);
  if (btnAtivo) btnAtivo.classList.add('active');

  const container = document.getElementById('custos-conteudo-dinamico');
  if (!container) return;

  switch (aba) {
    case 'dashboard':
      renderizarDashboardMargens(container);
      break;
    case 'produtos':
      renderizarMargensProdutos(container);
      break;
    case 'simulador':
      renderizarSimuladorPreco(container);
      break;
    case 'recursos':
      renderizarRecursosETempos(container);
      break;
    case 'politicas':
      renderizarPoliticasPrecificacao(container);
      break;
    default:
      renderizarDashboardMargens(container);
  }
}

async function carregarCustosAdmin() {
  const container = document.getElementById('custos-conteudo-dinamico');
  if (!container) return;

  if (typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'operador') {
    container.innerHTML = `
      <div style="background:#fff1f2; border:1px solid #fecdd3; border-radius:12px; padding:24px; text-align:center; color:#9f1239;">
        <i class="fa-solid fa-lock fa-2x" style="margin-bottom:8px; display:block;"></i>
        <h4 style="margin:0 0 4px; font-size:16px;">Acesso Restrito à Gestão</h4>
        <p style="margin:0; font-size:13px;">O módulo de Engenharia de Custos, Precificação e Margens é confidencial e exclusivo para Administradores.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="text-align:center; padding:40px 20px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:12px; display:block;"></i>
      <div style="font-weight:600; font-size:14px;">Carregando métricas de custos, margens e políticas fabris...</div>
    </div>
  `;

  try {
    const dataInicioInput = document.getElementById('custos-data-inicio');
    const dataFimInput = document.getElementById('custos-data-fim');
    const dtInicio = dataInicioInput ? dataInicioInput.value : null;
    const dtFim = dataFimInput ? dataFimInput.value : null;

    // 1. Dashboard de margens
    const { data: dashData, error: dashErr } = await supabaseClient.rpc('obter_dashboard_margens_admin', {
      p_data_inicio: dtInicio || null,
      p_data_fim: dtFim || null
    });
    if (dashErr) throw dashErr;
    custosDashboardCache = dashData;

    // 2. Margens consolidadas do catálogo
    const { data: prodData } = await supabaseClient.rpc('obter_margens_produtos_admin', {
      p_limite: 100
    });
    margensProdutosCache = prodData?.produtos || [];

    // 3. Recursos de produção
    const { data: recData } = await supabaseClient
      .from('recursos_producao')
      .select('*')
      .order('id', { ascending: true });
    recursosProducaoCache = recData || [];

    // 4. Políticas de precificação
    const { data: polData } = await supabaseClient
      .from('politicas_precificacao')
      .select('*')
      .order('id', { ascending: true });
    politicasPrecificacaoCache = polData || [];

    mudarSubAbaCustos(subAbaCustosAtual);
  } catch (err) {
    console.error('Erro ao carregar custos admin:', err);
    container.innerHTML = `
      <div style="background:#fee2e2; border:1px solid #fca5a5; border-radius:12px; padding:20px; color:#991b1b; text-align:center;">
        <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom:8px; display:block;"></i>
        <strong>Erro ao carregar dados de custos:</strong> ${err.message || 'Falha de comunicação com o servidor.'}
      </div>
    `;
  }
}

// ------------------------------------------------------------------------------
// SUB-ABA 1: DASHBOARD DE MARGENS
// ------------------------------------------------------------------------------
function renderizarDashboardMargens(container) {
  const resumo = custosDashboardCache?.resumo || {};
  const alertas = custosDashboardCache?.pedidos_alerta || [];

  container.innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-bottom:20px;">
      <div style="background:#ffffff; padding:16px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size:12px; color:#64748b; font-weight:600; text-transform:uppercase;">Receita Líquida (Vendas)</div>
        <div style="font-size:22px; font-weight:700; color:#0f172a; margin-top:4px;">${formatarMoedaCustos(resumo.receita_liquida_total)}</div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">${resumo.total_pedidos_calculados || 0} pedidos calculados</div>
      </div>
      <div style="background:#ffffff; padding:16px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size:12px; color:#64748b; font-weight:600; text-transform:uppercase;">Custos Atribuíveis Totais</div>
        <div style="font-size:22px; font-weight:700; color:#dc2626; margin-top:4px;">${formatarMoedaCustos(resumo.custo_atribuivel_total)}</div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">Insumos, MO, embalagem, indiretos</div>
      </div>
      <div style="background:#ffffff; padding:16px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size:12px; color:#64748b; font-weight:600; text-transform:uppercase;">Margem de Contribuição (R$)</div>
        <div style="font-size:22px; font-weight:700; color:#16a34a; margin-top:4px;">${formatarMoedaCustos(resumo.margem_contribuicao_total)}</div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">Lucro bruto pós-custos diretos</div>
      </div>
      <div style="background:#ffffff; padding:16px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-size:12px; color:#64748b; font-weight:600; text-transform:uppercase;">Margem Média Efetiva</div>
        <div style="font-size:22px; font-weight:700; color:#2563eb; margin-top:4px;">${formatarPercentualCustos(resumo.margem_media_percentual)}</div>
        <div style="font-size:11px; color:#64748b; margin-top:4px;">Meta da política: 40.00%</div>
      </div>
    </div>

    <!-- Alertas de Margem Baixa ou Negativa -->
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px; margin-bottom:20px;">
      <h4 style="margin:0 0 12px; font-size:15px; color:#0f172a; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-triangle-exclamation" style="color:#d97706;"></i> Pedidos com Margem Crítica ou Negativa (< 20%)
      </h4>
      ${alertas.length === 0 ? `
        <div style="color:#64748b; font-size:13px; text-align:center; padding:18px;">
          <i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:18px; margin-bottom:6px; display:block;"></i>
          Nenhum pedido com margem crítica registrado no período analisado.
        </div>
      ` : `
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead>
              <tr style="border-bottom:2px solid #e2e8f0; text-align:left; color:#64748b; font-size:12px;">
                <th style="padding:8px;">Pedido</th>
                <th style="padding:8px;">Cliente</th>
                <th style="padding:8px;">Receita Líq.</th>
                <th style="padding:8px;">Custo Real</th>
                <th style="padding:8px;">Margem (R$)</th>
                <th style="padding:8px;">Margem (%)</th>
                <th style="padding:8px; text-align:center;">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${alertas.map(a => `
                <tr style="border-bottom:1px solid #f1f5f9; background:${a.margem_valor < 0 ? '#fff1f2' : 'transparent'};">
                  <td style="padding:8px; font-weight:700;">#${a.pedido_id}</td>
                  <td style="padding:8px;">${a.cliente_nome || 'Cliente'}</td>
                  <td style="padding:8px;">${formatarMoedaCustos(a.receita_liquida)}</td>
                  <td style="padding:8px; color:#dc2626;">${formatarMoedaCustos(a.custo_total)}</td>
                  <td style="padding:8px; font-weight:700; color:${a.margem_valor < 0 ? '#b91c1c' : '#b45309'};">
                    ${formatarMoedaCustos(a.margem_valor)}
                  </td>
                  <td style="padding:8px; font-weight:700; color:${a.margem_pct < 0 ? '#b91c1c' : '#b45309'};">
                    ${formatarPercentualCustos(a.margem_pct)}
                  </td>
                  <td style="padding:8px; text-align:center;">
                    <button class="btn-outline" style="padding:4px 8px; font-size:11px;" onclick="abrirModalAuditoriaCustoPedido(${a.pedido_id})">
                      <i class="fa-solid fa-magnifying-glass"></i> Auditar
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

// ------------------------------------------------------------------------------
// SUB-ABA 2: MARGENS DO CATÁLOGO DE PRODUTOS
// ------------------------------------------------------------------------------
function renderizarMargensProdutos(container) {
  container.innerHTML = `
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
        <div>
          <h4 style="margin:0; font-size:16px; color:#0f172a;">Margem Direta Estimada por Produto</h4>
          <p style="margin:2px 0 0; font-size:12px; color:#64748b;">Com base no CMP atual de insumos + tempos padrão + custos adicionais cadastrados.</p>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #e2e8f0; text-align:left; color:#64748b; font-size:12px;">
              <th style="padding:8px;">Produto</th>
              <th style="padding:8px;">Preço Catálogo</th>
              <th style="padding:8px;">Insumos (CMP)</th>
              <th style="padding:8px;">Mão de Obra</th>
              <th style="padding:8px;">Embalagem/Adic.</th>
              <th style="padding:8px;">Custo Direto</th>
              <th style="padding:8px;">Margem Bruta</th>
              <th style="padding:8px;">Margem %</th>
              <th style="padding:8px; text-align:center;">Simulação</th>
            </tr>
          </thead>
          <tbody>
            ${margensProdutosCache.map(p => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px; font-weight:600; color:#0f172a;">${p.produto_nome}</td>
                <td style="padding:8px; font-weight:700;">${formatarMoedaCustos(p.preco_venda)}</td>
                <td style="padding:8px;">${formatarMoedaCustos(p.custo_insumos_cmp)}</td>
                <td style="padding:8px;">${formatarMoedaCustos(p.custo_mao_obra)}</td>
                <td style="padding:8px;">${formatarMoedaCustos(p.custo_embalagens_adicionais)}</td>
                <td style="padding:8px; color:#dc2626; font-weight:600;">${formatarMoedaCustos(p.custo_direto_total)}</td>
                <td style="padding:8px; color:#16a34a; font-weight:700;">${formatarMoedaCustos(p.margem_bruta_valor)}</td>
                <td style="padding:8px; font-weight:700; color:${p.margem_percentual < 35 ? '#b45309' : '#16a34a'};">
                  ${formatarPercentualCustos(p.margem_percentual)}
                </td>
                <td style="padding:8px; text-align:center;">
                  <button class="btn-outline" style="padding:4px 10px; font-size:11px;" onclick="iniciarSimulacaoProduto(${p.produto_id})">
                    <i class="fa-solid fa-calculator"></i> Simular
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------------
// SUB-ABA 3: SIMULADOR DE PREÇOS
// ------------------------------------------------------------------------------
function renderizarSimuladorPreco(container) {
  container.innerHTML = `
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:20px; max-width:800px; margin:0 auto;">
      <h4 style="margin:0 0 12px; font-size:16px; color:#0f172a; display:flex; align-items:center; gap:8px;">
        <i class="fa-solid fa-calculator" style="color:var(--primary);"></i> Simulador Avançado de Formação de Preço
      </h4>
      <p style="margin:0 0 18px; font-size:13px; color:#64748b;">
        Projeta o preço ideal considerando custos de insumos (CMP), mão de obra, embalagens, impostos e taxas.
        <strong>Nota:</strong> A simulação não altera automaticamente o preço do catálogo.
      </p>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:16px;">
        <div>
          <label style="display:block; font-size:12px; font-weight:600; color:#334155; margin-bottom:4px;">Selecione o Produto:</label>
          <select id="simulador-produto-id" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; font-size:13px;">
            <option value="">Selecione um produto...</option>
            ${margensProdutosCache.map(p => `
              <option value="${p.produto_id}">${p.produto_nome} (Preço Atual: ${formatarMoedaCustos(p.preco_venda)})</option>
            `).join('')}
          </select>
        </div>
        <div>
          <label style="display:block; font-size:12px; font-weight:600; color:#334155; margin-bottom:4px;">Margem Alvo Desejada (%):</label>
          <input type="number" id="simulador-margem-alvo" value="40" step="1" min="0" max="95" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; font-size:13px;">
        </div>
      </div>

      <div style="text-align:right; margin-bottom:20px;">
        <button class="btn-primary" onclick="executarSimulacaoPreco()" style="padding:8px 18px; font-size:13px;">
          <i class="fa-solid fa-play"></i> Calcular Simulação
        </button>
      </div>

      <div id="simulador-resultado-container"></div>
    </div>
  `;
}

async function iniciarSimulacaoProduto(produtoId) {
  mudarSubAbaCustos('simulador');
  setTimeout(() => {
    const sel = document.getElementById('simulador-produto-id');
    if (sel) {
      sel.value = String(produtoId);
      executarSimulacaoPreco();
    }
  }, 100);
}

async function executarSimulacaoPreco() {
  const sel = document.getElementById('simulador-produto-id');
  const margemInput = document.getElementById('simulador-margem-alvo');
  const resContainer = document.getElementById('simulador-resultado-container');
  if (!sel || !sel.value || !resContainer) return;

  const produtoId = Number(sel.value);
  const margemAlvo = Number(margemInput?.value) || 40;

  resContainer.innerHTML = `
    <div style="text-align:center; padding:20px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin"></i> Calculando estrutura industrial do produto...
    </div>
  `;

  try {
    const { data, error } = await supabaseClient.rpc('simular_preco_produto_admin', {
      p_produto_id: produtoId,
      p_margem_alvo: margemAlvo
    });
    if (error) throw error;
    if (!data.success) throw new Error(data.error || 'Erro na simulação.');

    resContainer.innerHTML = `
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:18px;">
        <h5 style="margin:0 0 12px; font-size:15px; color:#0f172a;">Resultado da Simulação: ${data.produto_nome}</h5>

        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:16px;">
          <div style="background:#ffffff; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-size:11px; color:#64748b;">Custo Direto Total</div>
            <div style="font-size:18px; font-weight:700; color:#dc2626;">${formatarMoedaCustos(data.custo_direto_total)}</div>
            <div style="font-size:10px; color:#64748b;">Insumos: ${formatarMoedaCustos(data.custo_insumos_cmp)} | MO: ${formatarMoedaCustos(data.custo_mao_de_obra)}</div>
          </div>
          <div style="background:#ffffff; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-size:11px; color:#64748b;">Preço de Equilíbrio (Break-even)</div>
            <div style="font-size:18px; font-weight:700; color:#0f172a;">${formatarMoedaCustos(data.preco_equilibrio_breakeven)}</div>
            <div style="font-size:10px; color:#64748b;">Margem 0% (cobre custos e taxas)</div>
          </div>
          <div style="background:#eff6ff; padding:12px; border-radius:8px; border:1px solid #bfdbfe;">
            <div style="font-size:11px; color:#1d4ed8; font-weight:600;">Preço Sugerido (Alvo ${margemAlvo}%)</div>
            <div style="font-size:18px; font-weight:700; color:#1d4ed8;">${formatarMoedaCustos(data.preco_sugerido_margem_alvo)}</div>
            <div style="font-size:10px; color:#1d4ed8;">Preço atual: ${formatarMoedaCustos(data.preco_atual_catalogo)}</div>
          </div>
        </div>

        <div style="background:#ffffff; padding:12px; border-radius:8px; border:1px solid #e2e8f0; font-size:12px; color:#475569;">
          <strong>Parâmetros aplicados:</strong> Impostos: ${data.parametros_politica.impostos_pct}% |
          Taxa Cartão: ${data.parametros_politica.taxa_cartao_pct}% |
          Custos Indiretos: ${data.parametros_politica.custo_indireto_pct}%
        </div>
      </div>
    `;
  } catch (err) {
    resContainer.innerHTML = `
      <div style="background:#fee2e2; padding:12px; border-radius:8px; color:#991b1b; font-size:12px;">
        ${err.message}
      </div>
    `;
  }
}

// ------------------------------------------------------------------------------
// SUB-ABA 4: RECURSOS E TEMPOS DE PRODUÇÃO
// ------------------------------------------------------------------------------
function renderizarRecursosETempos(container) {
  container.innerHTML = `
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
      <h4 style="margin:0 0 12px; font-size:16px; color:#0f172a;">Recursos de Produção Cadastrados</h4>
      <p style="margin:0 0 16px; font-size:12px; color:#64748b;">Custos por hora aplicados nas etapas de fabricação dos produtos.</p>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #e2e8f0; text-align:left; color:#64748b; font-size:12px;">
              <th style="padding:8px;">ID</th>
              <th style="padding:8px;">Recurso</th>
              <th style="padding:8px;">Tipo</th>
              <th style="padding:8px;">Custo / Hora</th>
              <th style="padding:8px;">Descrição</th>
              <th style="padding:8px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${recursosProducaoCache.map(r => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px; color:#64748b;">#${r.id}</td>
                <td style="padding:8px; font-weight:600; color:#0f172a;">${r.nome}</td>
                <td style="padding:8px; text-transform:capitalize;">${r.tipo.replace('_', ' ')}</td>
                <td style="padding:8px; font-weight:700; color:#2563eb;">${formatarMoedaCustos(r.custo_hora)}/h</td>
                <td style="padding:8px; color:#64748b;">${r.descricao || '-'}</td>
                <td style="padding:8px;">
                  <span style="font-size:11px; padding:2px 8px; border-radius:10px; background:${r.ativo ? '#dcfce7' : '#f1f5f9'}; color:${r.ativo ? '#166534' : '#64748b'};">
                    ${r.ativo ? 'Ativo' : 'Inativo'}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------------
// SUB-ABA 5: POLÍTICAS DE PRECIFICAÇÃO
// ------------------------------------------------------------------------------
function renderizarPoliticasPrecificacao(container) {
  container.innerHTML = `
    <div style="background:#ffffff; border-radius:14px; border:1px solid #e2e8f0; padding:18px;">
      <h4 style="margin:0 0 12px; font-size:16px; color:#0f172a;">Políticas de Precificação e Deduções</h4>
      <p style="margin:0 0 16px; font-size:12px; color:#64748b;">Parâmetros globais de margem alvo, impostos, taxas financeiras e rateio indireto.</p>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #e2e8f0; text-align:left; color:#64748b; font-size:12px;">
              <th style="padding:8px;">Política</th>
              <th style="padding:8px;">Margem Alvo</th>
              <th style="padding:8px;">Impostos</th>
              <th style="padding:8px;">Taxa Cartão</th>
              <th style="padding:8px;">Custo Indireto</th>
              <th style="padding:8px;">Padrão</th>
            </tr>
          </thead>
          <tbody>
            ${politicasPrecificacaoCache.map(p => `
              <tr style="border-bottom:1px solid #f1f5f9;">
                <td style="padding:8px; font-weight:600; color:#0f172a;">${p.nome}</td>
                <td style="padding:8px; font-weight:700; color:#16a34a;">${formatarPercentualCustos(p.margem_alvo_padrao_percentual)}</td>
                <td style="padding:8px;">${formatarPercentualCustos(p.impostos_padrao_percentual)}</td>
                <td style="padding:8px;">${formatarPercentualCustos(p.taxa_cartao_padrao_percentual)}</td>
                <td style="padding:8px;">${formatarPercentualCustos(p.custo_indireto_padrao_percentual)}</td>
                <td style="padding:8px;">
                  <span style="font-size:11px; padding:2px 8px; border-radius:10px; background:${p.padrao ? '#dbeafe' : '#f1f5f9'}; color:${p.padrao ? '#1e40af' : '#64748b'};">
                    ${p.padrao ? 'Sim' : 'Não'}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------------
// MODAL DE AUDITORIA DE CUSTO REAL DO PEDIDO
// ------------------------------------------------------------------------------
async function abrirModalAuditoriaCustoPedido(pedidoId) {
  let modal = document.getElementById('modal-auditoria-custo-pedido');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-auditoria-custo-pedido';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:700px; padding:24px; border-radius:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h3 style="margin:0; font-size:17px; color:#0f172a;" id="modal-auditoria-titulo">Auditoria de Custo do Pedido</h3>
          <button onclick="fecharModalAuditoriaCustoPedido()" class="btn-close" style="background:none; border:none; font-size:18px; cursor:pointer;">&times;</button>
        </div>
        <div id="modal-auditoria-corpo"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const corpo = document.getElementById('modal-auditoria-corpo');
  corpo.innerHTML = '<div style="text-align:center; padding:30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div>';
  modal.style.display = 'flex';

  try {
    const { data, error } = await supabaseClient.rpc('obter_margem_pedido_admin', {
      p_pedido_id: pedidoId
    });
    if (error) throw error;
    if (!data.success) throw new Error(data.error);

    corpo.innerHTML = `
      <div style="margin-bottom:16px;">
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:14px;">
          <div style="background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-size:11px; color:#64748b;">Receita Líquida</div>
            <div style="font-size:16px; font-weight:700; color:#0f172a;">${formatarMoedaCustos(data.receita_liquida)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-size:11px; color:#64748b;">Custo Atribuível Total</div>
            <div style="font-size:16px; font-weight:700; color:#dc2626;">${formatarMoedaCustos(data.custo_atribuivel_total)}</div>
          </div>
          <div style="background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;">
            <div style="font-size:11px; color:#64748b;">Margem Contribuição</div>
            <div style="font-size:16px; font-weight:700; color:${data.margem_contribuicao_valor < 0 ? '#b91c1c' : '#16a34a'};">
              ${formatarMoedaCustos(data.margem_contribuicao_valor)} (${formatarPercentualCustos(data.margem_contribuicao_percentual)})
            </div>
          </div>
        </div>

        <h5 style="margin:12px 0 6px; font-size:13px; color:#334155;">Componentes do Custo Realizado:</h5>
        <div style="max-height:260px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px;">
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
              <tr style="background:#f8fafc; border-bottom:1px solid #e2e8f0; text-align:left; color:#64748b;">
                <th style="padding:6px;">Tipo</th>
                <th style="padding:6px;">Descrição</th>
                <th style="padding:6px;">Qtd</th>
                <th style="padding:6px;">Custo Unit.</th>
                <th style="padding:6px; text-align:right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${(data.componentes || []).map(c => `
                <tr style="border-bottom:1px solid #f1f5f9;">
                  <td style="padding:6px; text-transform:capitalize;">${c.tipo}</td>
                  <td style="padding:6px; font-weight:600;">${c.descricao}</td>
                  <td style="padding:6px;">${c.quantidade} ${c.unidade}</td>
                  <td style="padding:6px;">${formatarMoedaCustos(c.custo_unitario_snapshot)}</td>
                  <td style="padding:6px; text-align:right; font-weight:700;">${formatarMoedaCustos(c.valor_total)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    corpo.innerHTML = `
      <div style="background:#fee2e2; padding:12px; border-radius:8px; color:#991b1b; font-size:13px;">
        ${err.message}
      </div>
    `;
  }
}

function fecharModalAuditoriaCustoPedido() {
  const modal = document.getElementById('modal-auditoria-custo-pedido');
  if (modal) modal.style.display = 'none';
}
