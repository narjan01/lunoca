// ==========================================================================
// LUNOCA DOCERIA - Módulo de Gestão de Estoque
// ==========================================================================

let estoqueFiltroAtual = 'todos';
let estoqueTermoBusca = '';
let produtoSelecionadoAjuste = null;

/**
 * Carrega a visão de estoque do painel administrativo
 */
async function carregarEstoqueAdmin() {
  const container = document.getElementById('admin-tab-estoque');
  if (!container) return;

  const lista = document.getElementById('lista-estoque-admin');
  if (lista) {
    lista.innerHTML = "<p style='text-align:center; color:#888;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando estoque...</p>";
  }

  try {
    // 1. Busca produtos atualizados do Supabase
    const { data: prods, error } = await supabaseClient
      .from('produtos')
      .select('*')
      .order('nome');

    if (error) throw error;
    produtos = prods || [];

    // 2. Atualiza os cards de indicadores de estoque
    atualizarCardsResumoEstoque(produtos);

    // 3. Renderiza a tabela de itens do estoque
    renderizarTabelaEstoque(produtos);

    // 4. Carrega histórico de movimentações recentes
    carregarMovimentacoesEstoque();

  } catch (err) {
    console.error('Erro ao carregar estoque:', err);
    if (lista) {
      lista.innerHTML = `
        <div style="padding: 15px; background: #fff1f2; color: #be123c; border-radius: 10px; border: 1px solid #fecdd3; font-size: 13px;">
          <i class="fa-solid fa-triangle-exclamation"></i> <strong>Não foi possível carregar o estoque:</strong> ${escapeHTML(err.message)}<br>
          <small style="margin-top:5px; display:block; color:#9f1239;">Certifique-se de executar o script <code>sql/estoque_financeiro.sql</code> no SQL Editor do Supabase.</small>
        </div>
      `;
    }
  }
}

/**
 * Atualiza os 4 cards de indicadores no topo da aba Estoque
 */
function atualizarCardsResumoEstoque(prods) {
  let totalUnidades = 0;
  let valorTotalEstoque = 0;
  let itensBaixos = 0;
  let itensEsgotados = 0;

  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    const qtd = p.estoque_qtd !== undefined && p.estoque_qtd !== null ? parseInt(p.estoque_qtd, 10) : 10;
    const min = p.estoque_minimo !== undefined && p.estoque_minimo !== null ? parseInt(p.estoque_minimo, 10) : 3;
    const preco = parseFloat(p.preco) || 0;
    const controla = p.controlar_estoque !== false;

    if (controla) {
      totalUnidades += qtd;
      valorTotalEstoque += qtd * preco;

      if (qtd <= 0) {
        itensEsgotados++;
      } else if (qtd <= min) {
        itensBaixos++;
      }
    }
  }

  const elTotal = document.getElementById('card-estoque-total-unidades');
  const elValor = document.getElementById('card-estoque-valor-total');
  const elBaixo = document.getElementById('card-estoque-itens-baixos');
  const elEsgotado = document.getElementById('card-estoque-itens-esgotados');

  if (elTotal) elTotal.innerText = totalUnidades + ' un';
  if (elValor) elValor.innerText = 'R$ ' + valorTotalEstoque.toFixed(2).replace('.', ',');
  if (elBaixo) elBaixo.innerText = itensBaixos;
  if (elEsgotado) elEsgotado.innerText = itensEsgotados;
}

/**
 * Renderiza a lista de produtos com status e controles rápidos
 */
function renderizarTabelaEstoque(prods) {
  const lista = document.getElementById('lista-estoque-admin');
  if (!lista) return;

  const prodsFiltrados = prods.filter(p => {
    const qtd = p.estoque_qtd !== undefined && p.estoque_qtd !== null ? parseInt(p.estoque_qtd, 10) : 10;
    const min = p.estoque_minimo !== undefined && p.estoque_minimo !== null ? parseInt(p.estoque_minimo, 10) : 3;
    const controla = p.controlar_estoque !== false;

    // Filtro por termo de busca
    if (estoqueTermoBusca && !p.nome.toLowerCase().includes(estoqueTermoBusca.toLowerCase())) {
      return false;
    }

    // Filtros de status
    if (estoqueFiltroAtual === 'em_estoque') {
      return controla ? qtd > min : true;
    }
    if (estoqueFiltroAtual === 'baixo') {
      return controla && qtd > 0 && qtd <= min;
    }
    if (estoqueFiltroAtual === 'esgotado') {
      return controla && qtd <= 0;
    }
    return true;
  });

  if (prodsFiltrados.length === 0) {
    lista.innerHTML = "<p style='text-align:center; color:#888; padding: 20px;'>Nenhum doce encontrado com o filtro selecionado.</p>";
    return;
  }

  let html = '<div style="display: flex; flex-direction: column; gap: 10px;">';

  for (let i = 0; i < prodsFiltrados.length; i++) {
    const p = prodsFiltrados[i];
    const qtd = p.estoque_qtd !== undefined && p.estoque_qtd !== null ? parseInt(p.estoque_qtd, 10) : 10;
    const min = p.estoque_minimo !== undefined && p.estoque_minimo !== null ? parseInt(p.estoque_minimo, 10) : 3;
    const controla = p.controlar_estoque !== false;
    const preco = parseFloat(p.preco) || 0;

    let badgeStatus = '';
    let corBorda = '#e5e7eb';

    if (!controla) {
      badgeStatus = '<span style="background: #f3f4f6; color: #4b5563; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold;"><i class="fa-solid fa-infinity"></i> Sob Encomenda</span>';
    } else if (qtd <= 0) {
      badgeStatus = '<span style="background: #fee2e2; color: #dc2626; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold;"><i class="fa-solid fa-circle-xmark"></i> Esgotado</span>';
      corBorda = '#fca5a5';
    } else if (qtd <= min) {
      badgeStatus = `<span style="background: #fef3c7; color: #d97706; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold;"><i class="fa-solid fa-triangle-exclamation"></i> Baixo (${qtd} un)</span>`;
      corBorda = '#fcd34d';
    } else {
      badgeStatus = `<span style="background: #d1fae5; color: #059669; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold;"><i class="fa-solid fa-circle-check"></i> Em Estoque (${qtd} un)</span>`;
      corBorda = '#a7f3d0';
    }

    const imgUrl = p.img_url || p.img || 'https://via.placeholder.com/60/fbf9ff/c496f2?text=Doce';

    html += `
      <div class="user-list-item" style="border-left: 4px solid ${corBorda}; background: #fff; padding: 12px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px;">
          <img src="${escapeHTML(imgUrl)}" alt="${escapeHTML(p.nome)}" style="width: 50px; height: 50px; border-radius: 8px; object-fit: cover; border: 1px solid #eee;">
          <div>
            <strong style="color: var(--text-dark); font-size: 14px;">${escapeHTML(p.nome)}</strong>
            <div style="font-size: 12px; color: #666; margin-top: 2px;">
              R$ ${preco.toFixed(2).replace('.', ',')} &bull; Mínimo alerta: ${min} un
            </div>
            <div style="margin-top: 4px;">${badgeStatus}</div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <button onclick="ajustarEstoqueRapido(${p.id}, -1)" class="btn-outline" style="padding: 6px 10px; border: none; border-right: 1px solid #e2e8f0; font-size: 12px; background: transparent; cursor: pointer;" title="Reduzir 1 unidade">
              <i class="fa-solid fa-minus"></i>
            </button>
            <span id="qtd-estoque-display-${p.id}" style="padding: 0 12px; font-weight: bold; font-size: 14px; color: var(--text-dark); min-width: 32px; text-align: center;">
              ${qtd}
            </span>
            <button onclick="ajustarEstoqueRapido(${p.id}, 1)" class="btn-outline" style="padding: 6px 10px; border: none; border-left: 1px solid #e2e8f0; font-size: 12px; background: transparent; cursor: pointer;" title="Adicionar 1 unidade">
              <i class="fa-solid fa-plus"></i>
            </button>
          </div>

          <button onclick="abrirModalAjusteEstoque(${p.id})" class="btn-outline" style="padding: 6px 12px; font-size: 12px; border-radius: 8px; display: flex; align-items: center; gap: 5px; cursor: pointer;" title="Ajuste com motivo">
            <i class="fa-solid fa-sliders"></i> Ajustar
          </button>
        </div>
      </div>
    `;
  }

  html += '</div>';
  lista.innerHTML = html;
}

/**
 * Ajuste rápido de quantidade (+1 ou -1)
 */
async function ajustarEstoqueRapido(produtoId, delta) {
  const p = produtos.find(item => item.id == produtoId);
  if (!p) return;

  const qtdAtual = parseInt(p.estoque_qtd !== undefined && p.estoque_qtd !== null ? p.estoque_qtd : 10, 10);
  const novaQtd = Math.max(0, qtdAtual + delta);
  const motivo = delta > 0 ? 'Entrada rápida (+1 un)' : 'Ajuste / Saída manual (-1 un)';
  const tipo = delta > 0 ? 'entrada' : 'saida';

  // Atualização otimista na tela
  p.estoque_qtd = novaQtd;
  const displayEl = document.getElementById(`qtd-estoque-display-${produtoId}`);
  if (displayEl) displayEl.innerText = novaQtd;
  atualizarCardsResumoEstoque(produtos);

  try {
    const { error: errUpdate } = await supabaseClient
      .from('produtos')
      .update({ estoque_qtd: novaQtd })
      .eq('id', produtoId);

    if (errUpdate) throw errUpdate;

    // Registra movimentação no histórico
    await supabaseClient.from('estoque_movimentacoes').insert({
      produto_id: produtoId,
      produto_nome: p.nome,
      tipo: tipo,
      quantidade: Math.abs(delta),
      saldo_resultante: novaQtd,
      motivo: motivo,
      usuario_nome: (typeof usuarioAtual !== 'undefined' && usuarioAtual?.nome) ? usuarioAtual.nome : 'Administrador'
    });

    carregarMovimentacoesEstoque();
  } catch (err) {
    console.warn('Erro ao atualizar estoque no Supabase:', err.message);
    // Reverte em caso de erro
    p.estoque_qtd = qtdAtual;
    if (displayEl) displayEl.innerText = qtdAtual;
    atualizarCardsResumoEstoque(produtos);
    alert('Erro ao salvar alteração de estoque: ' + err.message);
  }
}

/**
 * Abre modal para ajuste detalhado (entrada de lote, perda, etc.)
 */
function abrirModalAjusteEstoque(produtoId) {
  const p = produtos.find(item => item.id == produtoId);
  if (!p) return;

  produtoSelecionadoAjuste = p;
  const modal = document.getElementById('modal-ajuste-estoque');
  if (!modal) return;

  const qtdAtual = parseInt(p.estoque_qtd !== undefined && p.estoque_qtd !== null ? p.estoque_qtd : 10, 10);
  const minAtual = parseInt(p.estoque_minimo !== undefined && p.estoque_minimo !== null ? p.estoque_minimo : 3, 10);

  document.getElementById('ajuste-prod-nome').innerText = p.nome;
  document.getElementById('ajuste-prod-atual').innerText = qtdAtual;
  document.getElementById('ajuste-prod-nova-qtd').value = qtdAtual;
  document.getElementById('ajuste-prod-minimo').value = minAtual;
  document.getElementById('ajuste-prod-controlar').checked = p.controlar_estoque !== false;
  document.getElementById('ajuste-prod-motivo').value = 'Fornada / Produção concluída';

  modal.style.display = 'flex';
}

function fecharModalAjusteEstoque() {
  const modal = document.getElementById('modal-ajuste-estoque');
  if (modal) modal.style.display = 'none';
  produtoSelecionadoAjuste = null;
}

/**
 * Salva o ajuste detalhado vindo do modal
 */
async function salvarAjusteEstoqueModal() {
  if (!produtoSelecionadoAjuste) return;

  const btn = document.getElementById('btn-salvar-ajuste-estoque');
  const txtOriginal = btn ? btn.innerHTML : 'Salvar';
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gravando...';

  const p = produtoSelecionadoAjuste;
  const qtdAntiga = parseInt(p.estoque_qtd !== undefined && p.estoque_qtd !== null ? p.estoque_qtd : 10, 10);
  const novaQtd = Math.max(0, parseInt(document.getElementById('ajuste-prod-nova-qtd').value, 10) || 0);
  const novoMinimo = Math.max(1, parseInt(document.getElementById('ajuste-prod-minimo').value, 10) || 3);
  const controlar = document.getElementById('ajuste-prod-controlar').checked;
  const tipoMov = document.getElementById('ajuste-prod-tipo').value;
  const motivo = document.getElementById('ajuste-prod-motivo').value.trim() || 'Ajuste de inventário';

  const delta = novaQtd - qtdAntiga;

  try {
    const { error: errUpdate } = await supabaseClient
      .from('produtos')
      .update({
        estoque_qtd: novaQtd,
        estoque_minimo: novoMinimo,
        controlar_estoque: controlar
      })
      .eq('id', p.id);

    if (errUpdate) throw errUpdate;

    // Registra movimentação
    await supabaseClient.from('estoque_movimentacoes').insert({
      produto_id: p.id,
      produto_nome: p.nome,
      tipo: tipoMov,
      quantidade: Math.abs(delta),
      saldo_resultante: novaQtd,
      motivo: motivo,
      usuario_nome: (typeof usuarioAtual !== 'undefined' && usuarioAtual?.nome) ? usuarioAtual.nome : 'Administrador'
    });

    p.estoque_qtd = novaQtd;
    p.estoque_minimo = novoMinimo;
    p.controlar_estoque = controlar;

    fecharModalAjusteEstoque();
    atualizarCardsResumoEstoque(produtos);
    renderizarTabelaEstoque(produtos);
    carregarMovimentacoesEstoque();

    alert('✅ Estoque de "' + p.nome + '" atualizado com sucesso!');
  } catch (err) {
    console.error('Erro ao salvar ajuste:', err);
    alert('Erro ao atualizar estoque: ' + err.message);
  } finally {
    if (btn) btn.innerHTML = txtOriginal;
  }
}

/**
 * Carrega a tabela de histórico de movimentações
 */
async function carregarMovimentacoesEstoque() {
  const container = document.getElementById('lista-movimentacoes-estoque');
  if (!container) return;

  try {
    const { data: movs, error } = await supabaseClient
      .from('estoque_movimentacoes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(15);

    if (error) {
      // Se a tabela ainda não existir no Supabase, mostra mensagem orientativa
      container.innerHTML = "<p style='font-size:12px; color:#888; text-align:center;'>Nenhuma movimentação registrada recentemente.</p>";
      return;
    }

    if (!movs || movs.length === 0) {
      container.innerHTML = "<p style='font-size:12px; color:#888; text-align:center;'>Nenhuma movimentação registrada até o momento.</p>";
      return;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

    for (let i = 0; i < movs.length; i++) {
      const m = movs[i];
      const dataHora = m.created_at ? new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '--';

      let iconTipo = '<i class="fa-solid fa-arrow-down" style="color:#059669;"></i>';
      let badgeTipo = '<span style="color:#059669; font-weight:bold;">Entrada</span>';

      if (m.tipo === 'saida' || m.tipo === 'venda') {
        iconTipo = '<i class="fa-solid fa-arrow-up" style="color:#dc2626;"></i>';
        badgeTipo = '<span style="color:#dc2626; font-weight:bold;">Saída</span>';
      } else if (m.tipo === 'ajuste') {
        iconTipo = '<i class="fa-solid fa-rotate" style="color:#2563eb;"></i>';
        badgeTipo = '<span style="color:#2563eb; font-weight:bold;">Ajuste</span>';
      }

      html += `
        <div style="background:#f8fafc; padding:10px 12px; border-radius:8px; border:1px solid #e2e8f0; font-size:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
          <div style="display:flex; align-items:center; gap:8px;">
            ${iconTipo}
            <div>
              <strong>${escapeHTML(m.produto_nome || 'Doce')}</strong> &bull; ${badgeTipo} (${m.quantidade} un)
              <div style="color:#64748b; font-size:11px;">${escapeHTML(m.motivo || 'Sem descrição')}</div>
            </div>
          </div>
          <div style="text-align:right; font-size:11px; color:#64748b;">
            <div>Saldo: <strong>${m.saldo_resultante} un</strong></div>
            <div>${dataHora}</div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = "<p style='font-size:12px; color:#888; text-align:center;'>Histórico de estoque pronto.</p>";
  }
}

/**
 * Filtro da lista de estoque
 */
function filtrarEstoque(tipo) {
  estoqueFiltroAtual = tipo;
  document.querySelectorAll('.btn-filtro-estoque').forEach(b => b.classList.remove('active'));
  const btnAtivo = document.getElementById('btn-filtro-estoque-' + tipo);
  if (btnAtivo) btnAtivo.classList.add('active');
  renderizarTabelaEstoque(produtos);
}

function buscarEstoque(termo) {
  estoqueTermoBusca = termo || '';
  renderizarTabelaEstoque(produtos);
}

/**
 * Função de baixa automática no estoque após pedido confirmado
 */
async function darBaixaEstoqueAposPedido(carrinhoItens, pedidoId) {
  if (!carrinhoItens || carrinhoItens.length === 0) return;

  for (let i = 0; i < carrinhoItens.length; i++) {
    const item = carrinhoItens[i];
    if (!item.id) continue;

    try {
      // Chama a função SQL ou faz update direto
      const prodLocal = produtos.find(p => p.id == item.id);
      if (prodLocal && prodLocal.controlar_estoque !== false) {
        const saldoAtual = parseInt(prodLocal.estoque_qtd || 10, 10);
        const novoSaldo = Math.max(0, saldoAtual - 1);

        await supabaseClient
          .from('produtos')
          .update({ estoque_qtd: novoSaldo })
          .eq('id', item.id);

        await supabaseClient
          .from('estoque_movimentacoes')
          .insert({
            produto_id: item.id,
            produto_nome: item.nome,
            tipo: 'venda',
            quantidade: 1,
            saldo_resultante: novoSaldo,
            motivo: `Venda no Pedido #${pedidoId}`,
            pedido_id: pedidoId,
            usuario_nome: (typeof usuarioAtual !== 'undefined' && usuarioAtual?.nome) ? usuarioAtual.nome : 'Cliente'
          });

        prodLocal.estoque_qtd = novoSaldo;
      }
    } catch (e) {
      console.warn('Falha na baixa do item ' + item.id, e);
    }
  }
}
