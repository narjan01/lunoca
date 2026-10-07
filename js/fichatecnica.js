// ==========================================================================
// LUNOCA DOCERIA - Módulo de Ficha Técnica, Insumos e CMV (Fase 6)
// ==========================================================================

let ingredientesGlobal = [];
let produtoCmvGlobal = [];
let produtoSelecionadoFicha = null;
let fichaTecnicaItens = [];

/**
 * Carrega a tela e dados de Ficha Técnica e Insumos
 */
async function carregarFichaTecnicaAdmin() {
  const container = document.getElementById('admin-tab-fichatecnica');
  if (!container) return;

  const lista = document.getElementById('lista-ingredientes-admin');
  if (lista) {
    lista.innerHTML = "<p style='text-align:center; color:#888;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando ingredientes e custos...</p>";
  }

  try {
    // 1. Busca ingredientes
    const { data: ings, error: errIngs } = await supabaseClient
      .from('ingredientes')
      .select('*')
      .order('nome');

    if (errIngs) throw errIngs;
    ingredientesGlobal = ings || [];

    // 2. Busca CMV dos produtos
    const { data: cmvs, error: errCmvs } = await supabaseClient
      .from('view_produto_cmv')
      .select('*')
      .order('produto_nome');

    if (!errCmvs && cmvs) {
      produtoCmvGlobal = cmvs;
    }

    // 3. Renderiza métricas superiores
    atualizarCardsFichaTecnica();

    // 4. Renderiza tabela de insumos/ingredientes
    renderizarTabelaIngredientes();

    // 5. Renderiza visão geral de CMV por produto
    renderizarTabelaCmvProdutos();

  } catch (err) {
    console.error('[Ficha Técnica] Erro ao carregar dados:', err);
    if (lista) {
      lista.innerHTML = `
        <div style="padding:15px; background:#fff1f2; color:#be123c; border-radius:10px; border:1px solid #fecdd3; font-size:13px;">
          <i class="fa-solid fa-triangle-exclamation"></i> <strong>Não foi possível carregar a Ficha Técnica:</strong> ${escapeHTML(err.message)}<br>
          <small style="margin-top:5px; display:block; color:#9f1239;">Certifique-se de executar a migração <code>005_ficha_tecnica_cmv_insumos.sql</code> no SQL Editor do Supabase.</small>
        </div>
      `;
    }
  }
}

/**
 * Atualiza cards de resumo no topo da aba de Ficha Técnica
 */
function atualizarCardsFichaTecnica() {
  const totalIng = ingredientesGlobal.length;
  let criticos = 0;
  let valorTotalInsumos = 0;

  for (let i = 0; i < ingredientesGlobal.length; i++) {
    const ing = ingredientesGlobal[i];
    const qtd = parseFloat(ing.estoque_qtd) || 0;
    const min = parseFloat(ing.estoque_minimo) || 0;
    const custo = parseFloat(ing.custo_unitario) || 0;

    valorTotalInsumos += (qtd * custo);
    if (qtd <= min) {
      criticos++;
    }
  }

  // Calcula margem média dos produtos que têm receita cadastrada
  let somaMargem = 0;
  let prodsComReceita = 0;
  for (let j = 0; j < produtoCmvGlobal.length; j++) {
    const p = produtoCmvGlobal[j];
    if (p.total_ingredientes > 0 && p.preco_venda > 0) {
      somaMargem += parseFloat(p.margem_bruta_pct) || 0;
      prodsComReceita++;
    }
  }
  const margemMedia = prodsComReceita > 0 ? (somaMargem / prodsComReceita).toFixed(1) : '0.0';

  const elTotal = document.getElementById('card-ft-total-ingredientes');
  const elCriticos = document.getElementById('card-ft-estoque-critico');
  const elValor = document.getElementById('card-ft-valor-estoque');
  const elMargem = document.getElementById('card-ft-margem-media');

  if (elTotal) elTotal.innerText = totalIng;
  if (elCriticos) {
    elCriticos.innerText = criticos;
    elCriticos.style.color = criticos > 0 ? '#dc2626' : '#059669';
  }
  if (elValor) elValor.innerText = formatarBRL(valorTotalInsumos);
  if (elMargem) elMargem.innerText = margemMedia + '%';
}

/**
 * Renderiza tabela de insumos e matérias-primas
 */
function renderizarTabelaIngredientes() {
  const lista = document.getElementById('lista-ingredientes-admin');
  if (!lista) return;

  if (ingredientesGlobal.length === 0) {
    lista.innerHTML = `
      <div style="text-align:center; padding:30px; color:#888;">
        <i class="fa-solid fa-mortar-pestle" style="font-size:32px; color:#cbd5e1; margin-bottom:10px;"></i>
        <p>Nenhum ingrediente cadastrado ainda. Clique em "+ Novo Ingrediente" para começar.</p>
      </div>
    `;
    return;
  }

  let html = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
        <thead>
          <tr style="border-bottom:2px solid #e2e8f0; color:#475569; font-weight:700;">
            <th style="padding:10px 8px;">Ingrediente</th>
            <th style="padding:10px 8px;">Unidade</th>
            <th style="padding:10px 8px;">Custo Unitário</th>
            <th style="padding:10px 8px;">Estoque Atual</th>
            <th style="padding:10px 8px;">Estoque Mínimo</th>
            <th style="padding:10px 8px; text-align:right;">Ações</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (let i = 0; i < ingredientesGlobal.length; i++) {
    const ing = ingredientesGlobal[i];
    const qtd = parseFloat(ing.estoque_qtd) || 0;
    const min = parseFloat(ing.estoque_minimo) || 0;
    const custo = parseFloat(ing.custo_unitario) || 0;
    const isCritico = qtd <= min;

    let custoFormatado = '';
    if (ing.unidade === 'g') {
      custoFormatado = `R$ ${custo.toFixed(4).replace('.', ',')} / g <small style="color:#64748b;">(R$ ${(custo * 1000).toFixed(2).replace('.', ',')}/kg)</small>`;
    } else if (ing.unidade === 'ml') {
      custoFormatado = `R$ ${custo.toFixed(4).replace('.', ',')} / ml <small style="color:#64748b;">(R$ ${(custo * 1000).toFixed(2).replace('.', ',')}/L)</small>`;
    } else {
      custoFormatado = `R$ ${custo.toFixed(2).replace('.', ',')} / ${ing.unidade}`;
    }

    const badgeEstoque = isCritico
      ? `<span style="background:#fee2e2; color:#dc2626; padding:3px 8px; border-radius:12px; font-weight:700; font-size:11px;"><i class="fa-solid fa-triangle-exclamation"></i> ${qtd} ${ing.unidade} (Baixo)</span>`
      : `<span style="background:#dcfce7; color:#15803d; padding:3px 8px; border-radius:12px; font-weight:700; font-size:11px;"><i class="fa-solid fa-check"></i> ${qtd} ${ing.unidade}</span>`;

    html += `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:12px 8px; font-weight:600; color:var(--text-dark);">${escapeHTML(ing.nome)}</td>
        <td style="padding:12px 8px; color:#64748b;">${escapeHTML(ing.unidade)}</td>
        <td style="padding:12px 8px; color:#334155;">${custoFormatado}</td>
        <td style="padding:12px 8px;">${badgeEstoque}</td>
        <td style="padding:12px 8px; color:#64748b;">${min} ${ing.unidade}</td>
        <td style="padding:12px 8px; text-align:right;">
          <button onclick="abrirModalEditarIngrediente(${ing.id})" class="btn-outline" style="padding:5px 9px; font-size:11px; margin-right:4px;" title="Editar Ingrediente">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button onclick="excluirIngrediente(${ing.id})" class="btn-outline" style="padding:5px 9px; font-size:11px; color:#dc2626; border-color:#fca5a5;" title="Excluir">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  lista.innerHTML = html;
}

/**
 * Renderiza a visão geral de CMV por produto
 */
function renderizarTabelaCmvProdutos() {
  const container = document.getElementById('lista-cmv-produtos-admin');
  if (!container) return;

  if (produtoCmvGlobal.length === 0) {
    container.innerHTML = "<p style='color:#888; font-size:13px;'>Nenhum produto cadastrado.</p>";
    return;
  }

  let html = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
        <thead>
          <tr style="border-bottom:2px solid #e2e8f0; color:#475569; font-weight:700;">
            <th style="padding:10px 8px;">Doce / Produto</th>
            <th style="padding:10px 8px;">Preço de Venda</th>
            <th style="padding:10px 8px;">CMV Estimado</th>
            <th style="padding:10px 8px;">Lucro Bruto Unitário</th>
            <th style="padding:10px 8px;">Margem Bruta</th>
            <th style="padding:10px 8px; text-align:right;">Ficha Técnica</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (let i = 0; i < produtoCmvGlobal.length; i++) {
    const p = produtoCmvGlobal[i];
    const preco = parseFloat(p.preco_venda) || 0;
    const cmv = parseFloat(p.cmv_estimado) || 0;
    const lucro = parseFloat(p.lucro_bruto_unitario) || 0;
    const margem = parseFloat(p.margem_bruta_pct) || 0;
    const temFicha = p.total_ingredientes > 0;

    let badgeMargem = '';
    if (!temFicha) {
      badgeMargem = `<span style="background:#f1f5f9; color:#64748b; padding:3px 8px; border-radius:12px; font-size:11px;">Sem receita</span>`;
    } else if (margem >= 60) {
      badgeMargem = `<span style="background:#dcfce7; color:#15803d; padding:3px 8px; border-radius:12px; font-weight:700; font-size:11px;">${margem.toFixed(1)}% (Excelente)</span>`;
    } else if (margem >= 40) {
      badgeMargem = `<span style="background:#fef3c7; color:#b45309; padding:3px 8px; border-radius:12px; font-weight:700; font-size:11px;">${margem.toFixed(1)}% (Saudável)</span>`;
    } else {
      badgeMargem = `<span style="background:#fee2e2; color:#dc2626; padding:3px 8px; border-radius:12px; font-weight:700; font-size:11px;">${margem.toFixed(1)}% (Baixa)</span>`;
    }

    html += `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:12px 8px; font-weight:600; color:var(--text-dark);">${escapeHTML(p.produto_nome)}</td>
        <td style="padding:12px 8px; font-weight:600; color:#0f172a;">${formatarBRL(preco)}</td>
        <td style="padding:12px 8px; color:${temFicha ? '#b91c1c' : '#94a3b8'}; font-weight:600;">${temFicha ? formatarBRL(cmv) : 'R$ 0,00'}</td>
        <td style="padding:12px 8px; color:${temFicha ? '#15803d' : '#94a3b8'}; font-weight:600;">${temFicha ? formatarBRL(lucro) : '-'}</td>
        <td style="padding:12px 8px;">${badgeMargem}</td>
        <td style="padding:12px 8px; text-align:right;">
          <button onclick="abrirModalFichaTecnica(${p.produto_id})" class="btn-primary" style="padding:6px 12px; font-size:11px; border-radius:8px;">
            <i class="fa-solid fa-mortar-pestle"></i> ${temFicha ? 'Editar Receita (' + p.total_ingredientes + ')' : '+ Montar Receita'}
          </button>
        </td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

/**
 * Modal para criação ou edição de Ingrediente
 */
function abrirModalNovoIngrediente() {
  document.getElementById('ing-modal-titulo').innerText = 'Novo Ingrediente';
  document.getElementById('ing-modal-id').value = '';
  document.getElementById('ing-modal-nome').value = '';
  document.getElementById('ing-modal-unidade').value = 'g';
  document.getElementById('ing-modal-custo').value = '';
  document.getElementById('ing-modal-estoque').value = '';
  document.getElementById('ing-modal-minimo').value = '';
  atualizarDicaUnidadeCusto();

  const modal = document.getElementById('modal-editar-ingrediente');
  if (modal) modal.style.display = 'flex';
}

function abrirModalEditarIngrediente(id) {
  const ing = ingredientesGlobal.find(i => i.id === id);
  if (!ing) return;

  document.getElementById('ing-modal-titulo').innerText = 'Editar Ingrediente';
  document.getElementById('ing-modal-id').value = ing.id;
  document.getElementById('ing-modal-nome').value = ing.nome;
  document.getElementById('ing-modal-unidade').value = ing.unidade;
  document.getElementById('ing-modal-custo').value = ing.custo_unitario;
  document.getElementById('ing-modal-estoque').value = ing.estoque_qtd;
  document.getElementById('ing-modal-minimo').value = ing.estoque_minimo;
  atualizarDicaUnidadeCusto();

  const modal = document.getElementById('modal-editar-ingrediente');
  if (modal) modal.style.display = 'flex';
}

function fecharModalIngrediente() {
  const modal = document.getElementById('modal-editar-ingrediente');
  if (modal) modal.style.display = 'none';
}

function atualizarDicaUnidadeCusto() {
  const un = document.getElementById('ing-modal-unidade')?.value || 'g';
  const dica = document.getElementById('ing-modal-dica-custo');
  if (!dica) return;

  if (un === 'g') {
    dica.innerText = 'Informe o custo por grama. Ex: se 1kg custa R$ 55, informe 0.055';
  } else if (un === 'ml') {
    dica.innerText = 'Informe o custo por ml. Ex: se 1 litro custa R$ 16, informe 0.016';
  } else {
    dica.innerText = `Informe o custo por ${un}. Ex: R$ 1.20 por unidade.`;
  }
}

async function salvarIngrediente() {
  const id = document.getElementById('ing-modal-id').value;
  const nome = document.getElementById('ing-modal-nome').value.trim();
  const unidade = document.getElementById('ing-modal-unidade').value;
  const custo = parseFloat(document.getElementById('ing-modal-custo').value);
  const estoque = parseFloat(document.getElementById('ing-modal-estoque').value) || 0;
  const minimo = parseFloat(document.getElementById('ing-modal-minimo').value) || 0;

  if (!nome || isNaN(custo) || custo < 0) {
    mostrarToast('Preencha o nome e um custo unitário válido.', 'aviso');
    return;
  }

  const payload = {
    nome,
    unidade,
    custo_unitario: custo,
    estoque_qtd: estoque,
    estoque_minimo: minimo,
    updated_at: new Date().toISOString()
  };

  try {
    if (id) {
      const { error } = await supabaseClient.from('ingredientes').update(payload).eq('id', id);
      if (error) throw error;
      mostrarToast('Ingrediente atualizado com sucesso!', 'sucesso');
    } else {
      const { error } = await supabaseClient.from('ingredientes').insert(payload);
      if (error) throw error;
      mostrarToast('Ingrediente cadastrado com sucesso!', 'sucesso');
    }

    fecharModalIngrediente();
    await carregarFichaTecnicaAdmin();
  } catch (err) {
    console.error('Erro ao salvar ingrediente:', err);
    mostrarToast('Falha ao salvar ingrediente: ' + err.message, 'erro');
  }
}

async function excluirIngrediente(id) {
  if (!confirm('Deseja realmente excluir este ingrediente? Se estiver em alguma ficha técnica, ele será removido da receita.')) {
    return;
  }

  try {
    const { error } = await supabaseClient.from('ingredientes').delete().eq('id', id);
    if (error) throw error;
    mostrarToast('Ingrediente removido com sucesso.', 'sucesso');
    await carregarFichaTecnicaAdmin();
  } catch (err) {
    mostrarToast('Erro ao excluir: ' + err.message, 'erro');
  }
}

/**
 * Modal de Ficha Técnica / Receita por Produto
 */
async function abrirModalFichaTecnica(produtoId) {
  produtoSelecionadoFicha = produtos.find(p => p.id == produtoId) || { id: produtoId, nome: 'Produto #' + produtoId, preco: 0 };
  
  const tituloEl = document.getElementById('ft-produto-titulo');
  const precoEl = document.getElementById('ft-produto-preco-venda');
  if (tituloEl) tituloEl.innerText = produtoSelecionadoFicha.nome;
  if (precoEl) precoEl.innerText = formatarBRL(produtoSelecionadoFicha.preco || 0);

  // Preenche dropdown de ingredientes disponíveis
  const selectIng = document.getElementById('ft-novo-ingrediente-select');
  if (selectIng) {
    selectIng.innerHTML = '<option value="">-- Selecione o insumo --</option>' +
      ingredientesGlobal.map(i => `<option value="${i.id}">${escapeHTML(i.nome)} (${i.unidade})</option>`).join('');
  }

  // Busca itens da ficha técnica desse produto no banco
  await recarregarItensFichaTecnica(produtoId);

  const modal = document.getElementById('modal-ficha-tecnica-produto');
  if (modal) modal.style.display = 'flex';
}

function fecharModalFichaTecnica() {
  const modal = document.getElementById('modal-ficha-tecnica-produto');
  if (modal) modal.style.display = 'none';
  produtoSelecionadoFicha = null;
}

async function recarregarItensFichaTecnica(produtoId) {
  const listaEl = document.getElementById('ft-lista-itens-receita');
  if (listaEl) {
    listaEl.innerHTML = "<p style='color:#888; text-align:center;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando receita...</p>";
  }

  const { data: itens, error } = await supabaseClient
    .from('produto_ingredientes')
    .select('id, produto_id, ingrediente_id, quantidade, ingredientes(id, nome, unidade, custo_unitario)')
    .eq('produto_id', produtoId);

  if (error) {
    console.error('Erro ao carregar itens da ficha técnica:', error);
    if (listaEl) listaEl.innerHTML = `<p style="color:#dc2626;">Erro: ${escapeHTML(error.message)}</p>`;
    return;
  }

  fichaTecnicaItens = itens || [];
  renderizarItensReceitaNaTela();
}

function renderizarItensReceitaNaTela() {
  const listaEl = document.getElementById('ft-lista-itens-receita');
  if (!listaEl) return;

  let cmvTotal = 0;
  const precoVenda = parseFloat(produtoSelecionadoFicha?.preco) || 0;

  if (fichaTecnicaItens.length === 0) {
    listaEl.innerHTML = `
      <div style="padding:15px; background:#f8fafc; border-radius:10px; color:#64748b; text-align:center; font-size:12px;">
        Nenhum ingrediente adicionado à receita deste doce ainda.
      </div>
    `;
  } else {
    let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

    for (let i = 0; i < fichaTecnicaItens.length; i++) {
      const item = fichaTecnicaItens[i];
      const ing = item.ingredientes || {};
      const qtd = parseFloat(item.quantidade) || 0;
      const custoUnit = parseFloat(ing.custo_unitario) || 0;
      const custoItem = qtd * custoUnit;
      cmvTotal += custoItem;

      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; border:1px solid #e2e8f0; border-radius:10px; padding:8px 12px; font-size:13px;">
          <div>
            <strong>${escapeHTML(ing.nome || 'Ingrediente')}</strong>
            <span style="color:#64748b; font-size:12px; margin-left:6px;">(${qtd} ${ing.unidade || ''})</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <span style="font-weight:700; color:#b91c1c;">${formatarBRL(custoItem)}</span>
            <button onclick="removerIngredienteDaReceita(${item.id})" class="btn-outline" style="border:none; color:#dc2626; cursor:pointer; padding:4px;" title="Remover da receita">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      `;
    }

    html += '</div>';
    listaEl.innerHTML = html;
  }

  // Atualiza rodapé com CMV, Lucro e Margem
  const lucroBruto = precoVenda > 0 ? precoVenda - cmvTotal : 0;
  const margemBruta = precoVenda > 0 ? (lucroBruto / precoVenda * 100).toFixed(1) : '0.0';

  const cmvEl = document.getElementById('ft-total-cmv-calc');
  const lucroEl = document.getElementById('ft-total-lucro-calc');
  const margemEl = document.getElementById('ft-total-margem-calc');

  if (cmvEl) cmvEl.innerText = formatarBRL(cmvTotal);
  if (lucroEl) lucroEl.innerText = formatarBRL(lucroBruto);
  if (margemEl) margemEl.innerText = margemBruta + '%';
}

async function adicionarIngredienteNaReceita() {
  if (!produtoSelecionadoFicha) return;

  const ingId = document.getElementById('ft-novo-ingrediente-select').value;
  const qtd = parseFloat(document.getElementById('ft-novo-ingrediente-qtd').value);

  if (!ingId || isNaN(qtd) || qtd <= 0) {
    mostrarToast('Selecione um insumo e informe a quantidade consumida.', 'aviso');
    return;
  }

  try {
    const { error } = await supabaseClient
      .from('produto_ingredientes')
      .upsert({
        produto_id: produtoSelecionadoFicha.id,
        ingrediente_id: parseInt(ingId, 10),
        quantidade: qtd
      }, { onConflict: 'produto_id,ingrediente_id' });

    if (error) throw error;

    document.getElementById('ft-novo-ingrediente-qtd').value = '';
    mostrarToast('Ingrediente adicionado à receita!', 'sucesso');

    await recarregarItensFichaTecnica(produtoSelecionadoFicha.id);
    await carregarFichaTecnicaAdmin();
  } catch (err) {
    mostrarToast('Erro ao adicionar insumo: ' + err.message, 'erro');
  }
}

async function removerIngredienteDaReceita(fichaId) {
  try {
    const { error } = await supabaseClient
      .from('produto_ingredientes')
      .delete()
      .eq('id', fichaId);

    if (error) throw error;

    mostrarToast('Ingrediente removido da receita.', 'sucesso');
    if (produtoSelecionadoFicha) {
      await recarregarItensFichaTecnica(produtoSelecionadoFicha.id);
    }
    await carregarFichaTecnicaAdmin();
  } catch (err) {
    mostrarToast('Erro ao remover: ' + err.message, 'erro');
  }
}
