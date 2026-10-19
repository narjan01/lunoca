let categoriaSelecionada = 'todos';
let termoBuscaCardapio = '';
let modalQtdAtual = 1;

async function carregarProdutosServidor() {
  const container = document.getElementById('produtos-lista');
  if (container && (!produtos || produtos.length === 0)) {
    container.innerHTML = `
      <div class="skeleton-card skeleton-box"></div>
      <div class="skeleton-card skeleton-box"></div>
      <div class="skeleton-card skeleton-box"></div>
    `;
  }

  try {
    const { data, error } = await supabaseClient
      .from('produtos')
      .select('*')
      .eq('ativo', true)
      .order('created_at');
      
    if (error) throw error;
    
    produtos = (data || []).map(p => ({
      id: p.id,
      nome: p.nome,
      preco: p.preco,
      desc: p.descricao,
      opcoes: p.opcoes,
      img: p.img_url,
      estoque_qtd: p.estoque_qtd,
      estoque_fisico: p.estoque_fisico,
      estoque_reservado: p.estoque_reservado,
      controlar_estoque: p.controlar_estoque,
      pronta_entrega: p.pronta_entrega === true
    }));
    
    renderizarProdutosApp();
    if (usuarioAtual && (usuarioAtual.nivel === 'admin' || usuarioAtual.nivel === 'operador')) {
      try {
        const { data: etapasData } = await supabaseClient
          .from('produto_etapas_kds')
          .select('id, produto_id, ordem, praca, sla_minutos, obrigatoria')
          .order('ordem', { ascending: true });
        window.produtoEtapasKdsGlobal = etapasData || [];
      } catch (_) {
        window.produtoEtapasKdsGlobal = [];
      }
      if (typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
    }
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    if (container) {
      container.innerHTML = `
        <div style="text-align:center; padding: 30px; color:#888;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; color: #f59e0b; margin-bottom: 10px; display: block;"></i>
          <p style="margin: 0 0 10px;">Não foi possível carregar o cardápio no momento.</p>
          <button class="btn-outline" onclick="carregarProdutosServidor()" style="margin: 0 auto; padding: 6px 14px; font-size: 12px;">
            <i class="fa-solid fa-rotate-right"></i> Tentar Novamente
          </button>
        </div>
      `;
    }
  }
}

function identificarCategoriaProduto(p) {
  const texto = ((p.nome || '') + ' ' + (p.desc || '')).toLowerCase();
  if (texto.includes('bolo') || texto.includes('fatia')) return 'bolos';
  if (texto.includes('brigadeiro')) return 'brigadeiros';
  if (texto.includes('brownie')) return 'brownies';
  if (texto.includes('cento') || texto.includes('festa') || texto.includes('caixa')) return 'festas';
  return 'outros';
}

function renderizarProdutosApp() {
  const container = document.getElementById('produtos-lista');
  const countEl = document.getElementById('store-items-count');
  if (!container) return;

  const defaultImg = 'img/logo.jpg';
  
  // Filtragem combinada: Categoria + Termo de Busca
  const produtosFiltrados = produtos.filter(p => {
    // Filtro por Categoria
    if (categoriaSelecionada !== 'todos') {
      const cat = identificarCategoriaProduto(p);
      if (cat !== categoriaSelecionada) return false;
    }
    // Filtro por Busca
    if (termoBuscaCardapio) {
      const termo = termoBuscaCardapio.toLowerCase().trim();
      const matchNome = (p.nome || '').toLowerCase().includes(termo);
      const matchDesc = (p.desc || '').toLowerCase().includes(termo);
      const matchOpcoes = (p.opcoes || '').toLowerCase().includes(termo);
      if (!matchNome && !matchDesc && !matchOpcoes) return false;
    }
    return true;
  });

  if (countEl) {
    countEl.innerText = `${produtosFiltrados.length} ${produtosFiltrados.length === 1 ? 'delícia' : 'delícias'}`;
  }

  if (produtosFiltrados.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 45px 15px; color: #887a77; background: #ffffff; border-radius: 20px; border: 1.5px dashed #ebdcf7;">
        <i class="fa-solid fa-cookie-bite" style="font-size: 38px; color: var(--primary); margin-bottom: 12px; display: block; opacity: 0.7;"></i>
        <h3 style="margin: 0 0 6px; font-size: 16px; color: var(--text-dark);">Nenhum doce encontrado</h3>
        <p style="margin: 0 0 16px; font-size: 13px;">Tente buscar por outro termo ou explore todas as categorias.</p>
        <button class="btn-outline" onclick="limparBuscaProdutos(true)" style="margin: 0 auto; font-size: 12px; padding: 8px 16px;">
          <i class="fa-solid fa-sparkles"></i> Ver Todo o Cardápio
        </button>
      </div>
    `;
    return;
  }

  let html = '';
  for (let i = 0; i < produtosFiltrados.length; i++) {
    const p = produtosFiltrados[i];
    const imagemUrl = p.img ? escapeHTML(p.img) : defaultImg;
    const nomeEsc = escapeHTML(p.nome);
    const descFormatada = p.desc ? escapeHTML(p.desc) : '';
    const precoFormatado = typeof formatarBRL === 'function' ? formatarBRL(p.preco) : `R$ ${parseFloat(p.preco || 0).toFixed(2)}`;

    // Badges dinâmicos
    let badgeTag = '<span class="produto-badge-tag"><i class="fa-solid fa-heart" style="color:var(--primary);"></i> Artesanal</span>';
    if (p.controlar_estoque && p.estoque_qtd !== null && p.estoque_qtd <= 0) {
      badgeTag = '<span class="produto-badge-tag" style="color:#b91c1c; background:#fee2e2;"><i class="fa-solid fa-circle-xmark"></i> Esgotado</span>';
    } else if (p.opcoes && p.opcoes.includes(',')) {
      badgeTag = '<span class="produto-badge-tag"><i class="fa-solid fa-sliders"></i> Sabores</span>';
    }

    // Pré-visualização de sabores
    let previewSaboresHtml = '';
    if (p.opcoes && p.opcoes.trim() !== '') {
      const arr = p.opcoes.split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length > 0) {
        const primeiros = arr.slice(0, 2);
        previewSaboresHtml = '<div class="produto-sabores-preview">';
        for (const s of primeiros) {
          previewSaboresHtml += `<span class="sabor-mini-pill">${escapeHTML(s)}</span>`;
        }
        if (arr.length > 2) {
          previewSaboresHtml += `<span class="sabor-mini-pill more">+${arr.length - 2} opções</span>`;
        }
        previewSaboresHtml += '</div>';
      }
    }

    html += `
      <div class="produto-card-boutique" onclick="abrirModalProduto('${p.id}')">
        <div class="produto-thumb-wrap">
          <img src="${imagemUrl}" alt="${nomeEsc}" loading="lazy" width="125" height="125">
          ${badgeTag}
        </div>
        <div class="produto-body">
          <div class="produto-title-wrap">
            <h3 class="produto-nome-boutique">${nomeEsc}</h3>
            <p class="produto-desc-boutique">${descFormatada}</p>
            ${previewSaboresHtml}
          </div>
          <div class="produto-bottom-bar">
            <div class="preco-boutique">
              ${precoFormatado}
              <small>por unidade</small>
            </div>
            <button type="button" class="btn-comprar-boutique" onclick="event.stopPropagation(); abrirModalProduto('${p.id}')" aria-label="Pedir ${nomeEsc}">
              <i class="fa-solid fa-plus"></i> Pedir
            </button>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function selecionarCategoriaCardapio(cat, btn) {
  categoriaSelecionada = cat;
  document.querySelectorAll('.category-chip').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderizarProdutosApp();
}

function filtrarProdutosPorBuscaECategoria() {
  const input = document.getElementById('store-search-input');
  const btnClear = document.getElementById('store-search-clear');
  termoBuscaCardapio = (input?.value || '').trim();

  if (btnClear) {
    btnClear.style.display = termoBuscaCardapio.length > 0 ? 'block' : 'none';
  }

  renderizarProdutosApp();
}

function limparBuscaProdutos(resetarCategoria = false) {
  const input = document.getElementById('store-search-input');
  const btnClear = document.getElementById('store-search-clear');
  if (input) input.value = '';
  if (btnClear) btnClear.style.display = 'none';
  termoBuscaCardapio = '';

  if (resetarCategoria) {
    categoriaSelecionada = 'todos';
    document.querySelectorAll('.category-chip').forEach(b => {
      b.classList.toggle('active', b.dataset.categoria === 'todos');
    });
  }

  renderizarProdutosApp();
}

function abrirModalProduto(id) {
  const p = produtos.find(prod => String(prod.id) === String(id));
  if (!p) return;

  // Se o doce tiver controle de estoque e estiver zerado/esgotado
  if (p.controlar_estoque !== false && p.estoque_qtd != null && p.estoque_qtd <= 0) {
    alert(`O doce "${p.nome}" está temporariamente esgotado.`);
    return;
  }
  
  produtoSendoVisto = p;
  modalQtdAtual = 1;

  const precoFormatado = typeof formatarBRL === 'function' ? formatarBRL(p.preco) : `R$ ${parseFloat(p.preco).toFixed(2)}`;

  document.getElementById('modal-img').src = p.img || 'img/logo.jpg';
  document.getElementById('modal-nome').innerText = p.nome;
  document.getElementById('modal-preco').innerText = precoFormatado;
  
  const mDesc = document.getElementById('modal-desc');
  if (mDesc) {
    mDesc.textContent = p.desc || '';
    mDesc.style.whiteSpace = 'pre-line';
  }

  const elQtd = document.getElementById('modal-qtd-display');
  if (elQtd) elQtd.innerText = '1';

  atualizarSubtotalModal();
  
  const containerOpcoes = document.getElementById('modal-opcoes-container');
  const listaOpcoes = document.getElementById('modal-opcoes-lista');
  
  if (p.opcoes && p.opcoes.trim() !== "") {
    containerOpcoes.style.display = 'block';
    const arrayOpcoes = p.opcoes.split(',').map(s => s.trim()).filter(Boolean);
    let htmlOpcoes = '';

    for (let i = 0; i < arrayOpcoes.length; i++) {
      const opcaoTexto = escapeHTML(arrayOpcoes[i]);
      const checkedAttr = i === 0 ? 'checked' : '';
      htmlOpcoes += `
        <label class="sabor-chip-label">
          <input type="radio" name="sabor_escolhido" value="${opcaoTexto}" ${checkedAttr}>
          <span class="sabor-indicator"><i class="fa-solid fa-check"></i></span>
          <span>${opcaoTexto}</span>
        </label>
      `;
    }
    listaOpcoes.innerHTML = htmlOpcoes;
  } else {
    containerOpcoes.style.display = 'none';
  }
  
  document.getElementById('modal-produto').style.display = 'flex';
}

function alterarQtdModalProduto(delta) {
  if (!produtoSendoVisto) return;
  const maxDisponivel = (produtoSendoVisto.controlar_estoque !== false && produtoSendoVisto.estoque_qtd != null)
    ? produtoSendoVisto.estoque_qtd
    : 999;

  const novaQtd = modalQtdAtual + delta;
  if (delta > 0 && novaQtd > maxDisponivel) {
    alert(`Apenas ${maxDisponivel} unidade(s) disponível(is) no momento para este doce.`);
    return;
  }

  modalQtdAtual = Math.max(1, novaQtd);
  const elQtd = document.getElementById('modal-qtd-display');
  if (elQtd) elQtd.innerText = modalQtdAtual;
  atualizarSubtotalModal();
}

function atualizarSubtotalModal() {
  if (!produtoSendoVisto) return;
  const precoUnit = parseFloat(produtoSendoVisto.preco || 0);
  const subtotal = precoUnit * modalQtdAtual;
  const subtotalFmt = typeof formatarBRL === 'function' ? formatarBRL(subtotal) : `R$ ${subtotal.toFixed(2)}`;

  const displayEl = document.getElementById('modal-subtotal-display');
  if (displayEl) {
    displayEl.innerText = `${modalQtdAtual}x por ${subtotalFmt}`;
  }

  const btnTxt = document.getElementById('btn-adicionar-txt');
  if (btnTxt) {
    btnTxt.innerText = `Adicionar ${modalQtdAtual} ${modalQtdAtual === 1 ? 'item' : 'itens'} • ${subtotalFmt}`;
  }
}

function fecharModalProduto() {
  document.getElementById('modal-produto').style.display = 'none';
  produtoSendoVisto = null;
  modalQtdAtual = 1;
}

function confirmarAdicaoCarrinho() {
  if (!produtoSendoVisto) return;
  
  let itemCarrinho = Object.assign({}, produtoSendoVisto);
  let saborEscolhido = '';
  
  if (itemCarrinho.opcoes && itemCarrinho.opcoes.trim() !== "") {
    const selecionado = document.querySelector('input[name="sabor_escolhido"]:checked');
    if (!selecionado) {
      alert("Por favor, escolha um sabor para continuar.");
      return;
    }
    saborEscolhido = selecionado.value;
    itemCarrinho.nome = itemCarrinho.nome + " (" + saborEscolhido + ")";
    itemCarrinho.sabor = saborEscolhido;
  }
  
  if (!Array.isArray(carrinho)) carrinho = [];

  const qtdAdicionar = Math.max(1, parseInt(modalQtdAtual || 1, 10));

  // Validação preventiva de estoque considerando itens já na sacola
  if (itemCarrinho.controlar_estoque !== false && itemCarrinho.estoque_qtd != null) {
    const qtdJaNoCarrinho = carrinho
      .filter(it => String(it.id) === String(itemCarrinho.id))
      .reduce((s, it) => s + (parseInt(it.quantidade, 10) || 1), 0);

    if (qtdJaNoCarrinho + qtdAdicionar > itemCarrinho.estoque_qtd) {
      const restante = Math.max(0, itemCarrinho.estoque_qtd - qtdJaNoCarrinho);
      alert(`Estoque insuficiente para "${itemCarrinho.nome}". Você já tem ${qtdJaNoCarrinho} na sacola e restam apenas ${restante} disponível(is).`);
      return;
    }
  }

  // Agrupa se já existir produto idêntico (mesmo ID e sabor)
  const itemExistente = carrinho.find(it => 
    String(it.id) === String(itemCarrinho.id) && 
    (it.sabor || '') === (itemCarrinho.sabor || '')
  );

  if (itemExistente) {
    itemExistente.quantidade = (parseInt(itemExistente.quantidade, 10) || 1) + qtdAdicionar;
  } else {
    itemCarrinho.quantidade = qtdAdicionar;
    carrinho.push(itemCarrinho);
  }
  
  atualizarBotaoCarrinho();
  salvarCarrinhoLocal();
  fecharModalProduto();
  
  // Feedback com Toast gourmet
  const nomeDoce = itemCarrinho.nome.split(' (')[0];
  mostrarToast(`✨ ${qtdAdicionar}x "${nomeDoce}" adicionado ao carrinho!`, 'sucesso', 3500);

  const btnCarrinho = document.getElementById('btn-ver-carrinho');
  if (btnCarrinho) btnCarrinho.style.display = 'flex';
}

function editarProduto(id) {
  let p = produtos.filter(function(prod) { return prod.id == id; })[0];
  if (!p) return;
  
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-nome').value = p.nome;
  document.getElementById('prod-preco').value = p.preco;
  document.getElementById('prod-desc').value = p.desc;
  document.getElementById('prod-opcoes').value = p.opcoes || "";
  document.getElementById('prod-img').value = p.img || "";
  if (document.getElementById('prod-estoque-qtd')) document.getElementById('prod-estoque-qtd').value = (p.estoque_qtd !== undefined && p.estoque_qtd !== null) ? p.estoque_qtd : 10;
  if (document.getElementById('prod-estoque-minimo')) document.getElementById('prod-estoque-minimo').value = (p.estoque_minimo !== undefined && p.estoque_minimo !== null) ? p.estoque_minimo : 3;
  if (document.getElementById('prod-controlar-estoque')) document.getElementById('prod-controlar-estoque').checked = p.controlar_estoque !== false;
  if (document.getElementById('prod-pronta-entrega')) document.getElementById('prod-pronta-entrega').checked = p.pronta_entrega === true;
  document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-image'></i> Foto Selecionada";
  document.getElementById('upload-status').innerText = "";
  window.scrollTo(0, 0);
}

async function salvarProdutoAdmin() {
  let id = document.getElementById('prod-id').value;
  let nome = document.getElementById('prod-nome').value;
  let preco = document.getElementById('prod-preco').value;
  let desc = document.getElementById('prod-desc').value;
  let opcoes = document.getElementById('prod-opcoes').value;
  let img = document.getElementById('prod-img').value;
  let estoqueQtd = parseInt(document.getElementById('prod-estoque-qtd')?.value || 10, 10);
  let estoqueMinimo = parseInt(document.getElementById('prod-estoque-minimo')?.value || 3, 10);
  let controlarEstoque = document.getElementById('prod-controlar-estoque') ? document.getElementById('prod-controlar-estoque').checked : true;
  let prontaEntrega = document.getElementById('prod-pronta-entrega') ? document.getElementById('prod-pronta-entrega').checked : false;
  
  if (!nome || !preco) return alert("Preencha Nome e Preço.");
  
  const btn = document.getElementById('btn-salvar-produto');
  const textOriginal = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
  
  try {
    let error;
    if (id) {
      // Edição de Catálogo: preserva integridade e atualiza pronta_entrega
      const res = await supabaseClient
        .from('produtos')
        .update({
          nome: nome,
          preco: preco,
          descricao: desc,
          opcoes: opcoes,
          img_url: img,
          pronta_entrega: prontaEntrega
        })
        .eq('id', id);
      error = res.error;
    } else {
      const res = await supabaseClient
        .from('produtos')
        .insert({
          nome: nome,
          preco: preco,
          descricao: desc,
          opcoes: opcoes,
          img_url: img,
          estoque_qtd: estoqueQtd,
          estoque_minimo: estoqueMinimo,
          controlar_estoque: controlarEstoque,
          pronta_entrega: prontaEntrega
        });
      error = res.error;
    }
    
    if (error) throw error;
    
    alert("✅ Produto atualizado!");
    limparFormProduto();
    await carregarProdutosServidor();
  } catch (error) {
    alert("Erro ao salvar produto: " + error.message);
  } finally {
    btn.innerHTML = textOriginal;
  }
}

function renderizarProdutosAdmin() {
  let html = '';
  const etapasGlobais = window.produtoEtapasKdsGlobal || [];

  for (let i = 0; i < produtos.length; i++) {
    let p = produtos[i];
    let cmvInfo = '';
    if (typeof produtoCmvGlobal !== 'undefined' && Array.isArray(produtoCmvGlobal)) {
      const match = produtoCmvGlobal.find(c => c.produto_id == p.id);
      if (match && match.total_ingredientes > 0) {
        cmvInfo = ` <span style="font-size:11px; color:#64748b; font-weight:normal; margin-left:8px;">(CMV: <strong>R$ ${parseFloat(match.cmv_estimado).toFixed(2).replace('.', ',')}</strong> | Margem: <strong>${match.margem_bruta_pct}%</strong>)</span>`;
      }
    }

    // Gestão visual de rota KDS / Pronta Entrega (Frente 042)
    let kdsBadge = '';
    let btnRotaHtml = '';
    if (p.pronta_entrega) {
      kdsBadge = `<span style="font-size:11px; background:#dcfce7; color:#166534; padding:2px 8px; border-radius:6px; font-weight:600; margin-left:6px;"><i class="fa-solid fa-box"></i> Pronta Entrega</span>`;
    } else {
      const etapasProd = etapasGlobais.filter(e => e.produto_id == p.id);
      if (etapasProd.length === 0) {
        kdsBadge = `<span style="font-size:11px; background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:6px; font-weight:700; margin-left:6px;" title="Produto sem rota KDS: vendas não poderão entrar na cozinha!"><i class="fa-solid fa-triangle-exclamation"></i> Sem rota KDS</span>`;
        btnRotaHtml = `
          <button class="btn-outline" onclick="abrirModalRotaKds(${p.id}, '${escapeHTML(p.nome)}')" style="padding:6px 12px; font-size:12px; border-radius:8px; border-color:#ef4444; color:#b91c1c; font-weight:700; background:#fef2f2;" title="Configurar rota de produção no KDS">
            <i class="fa-solid fa-triangle-exclamation"></i> Configurar rota
          </button>
        `;
      } else {
        kdsBadge = `<span style="font-size:11px; background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:6px; font-weight:600; margin-left:6px;" title="${etapasProd.length} etapas no KDS"><i class="fa-solid fa-fire-burner"></i> KDS (${etapasProd.length} etapas)</span>`;
        btnRotaHtml = `
          <button class="btn-outline" onclick="abrirModalRotaKds(${p.id}, '${escapeHTML(p.nome)}')" style="padding:6px 12px; font-size:12px; border-radius:8px;" title="Ver ou editar rota do KDS">
            <i class="fa-solid fa-kitchen-set"></i> Rota KDS
          </button>
        `;
      }
    }

    html += `
      <div class="user-list-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid #f1f5f9; flex-wrap:wrap; gap:8px;">
        <div>
          <strong style="color:var(--text-dark);">${escapeHTML(p.nome)}</strong>
          ${kdsBadge}
          ${cmvInfo}
          <br>
          <span style="font-size:13px; color:var(--primary); font-weight:600;">R$ ${parseFloat(p.preco).toFixed(2).replace('.', ',')}</span>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${btnRotaHtml}
          <button class="btn-outline" onclick="abrirModalFichaTecnica(${p.id})" style="padding:6px 12px; font-size:12px; border-radius:8px;" title="Ver/Editar Receita e Insumos">
            <i class="fa-solid fa-mortar-pestle"></i> Ficha Técnica
          </button>
          <button class="btn-outline" onclick="editarProduto('${p.id}')" style="padding:6px 12px; font-size:12px; border-radius:8px;">
            <i class="fa-solid fa-pen"></i> Editar
          </button>
        </div>
      </div>
    `;
  }
  const el = document.getElementById('lista-produtos-admin');
  if (el) el.innerHTML = html;
}

function limparFormProduto() {
  let ids = ['prod-id', 'prod-nome', 'prod-preco', 'prod-desc', 'prod-opcoes', 'prod-img'];
  for (let i = 0; i < ids.length; i++) {
    document.getElementById(ids[i]).value = "";
  }
  document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-cloud-arrow-up'></i> Escolher foto...";
  document.getElementById('upload-status').innerText = "";
  document.getElementById('prod-file').value = "";
  if (document.getElementById('prod-estoque-qtd')) document.getElementById('prod-estoque-qtd').value = "10";
  if (document.getElementById('prod-estoque-minimo')) document.getElementById('prod-estoque-minimo').value = "3";
  if (document.getElementById('prod-controlar-estoque')) document.getElementById('prod-controlar-estoque').checked = true;
  if (document.getElementById('prod-pronta-entrega')) document.getElementById('prod-pronta-entrega').checked = false;
}

// ------------------------------------------------------------------------------
// GESTÃO DA ROTA KDS POR PRODUTO (FRENTE 038 / 042)
// ------------------------------------------------------------------------------
let produtoKdsAtual = null;

async function abrirModalRotaKds(produtoId, nomeProduto) {
  produtoKdsAtual = { id: produtoId, nome: nomeProduto };
  const titEl = document.getElementById('kds-rota-produto-titulo');
  if (titEl) titEl.textContent = nomeProduto;

  await recarregarEtapasKds(produtoId);

  const modal = document.getElementById('modal-rota-kds-produto');
  if (modal) modal.style.display = 'flex';
}

function fecharModalRotaKds() {
  const modal = document.getElementById('modal-rota-kds-produto');
  if (modal) modal.style.display = 'none';
  produtoKdsAtual = null;
  carregarProdutosServidor();
}

async function recarregarEtapasKds(produtoId) {
  const listaEl = document.getElementById('kds-lista-etapas-rota');
  const alertaSemRota = document.getElementById('kds-alerta-sem-rota');
  const tempoTotalEl = document.getElementById('kds-tempo-total-rota');
  if (listaEl) listaEl.innerHTML = '<p style="color:#64748b; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando etapas...</p>';

  try {
    const { data: etapas, error } = await supabaseClient
      .from('produto_etapas_kds')
      .select('id, ordem, praca, sla_minutos, obrigatoria')
      .eq('produto_id', produtoId)
      .order('ordem', { ascending: true });

    if (error) throw error;

    if (!etapas || etapas.length === 0) {
      if (alertaSemRota) alertaSemRota.style.display = 'block';
      if (listaEl) listaEl.innerHTML = '<p style="color:#94a3b8; font-size:12px; font-style:italic;">Nenhuma etapa configurada ainda.</p>';
      if (tempoTotalEl) tempoTotalEl.textContent = 'SLA Total: 0 min';
      return;
    }

    if (alertaSemRota) alertaSemRota.style.display = 'none';

    let totalSla = 0;
    let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

    etapas.forEach(et => {
      totalSla += Number(et.sla_minutos || 0);
      const pracaIcones = {
        MASSA: 'fa-bowl-rice',
        FORNO: 'fa-temperature-high',
        RECHEIO: 'fa-layer-group',
        DECORACAO: 'fa-wand-magic-sparkles',
        EMBALAGEM: 'fa-box-open'
      };
      const icone = pracaIcones[et.praca] || 'fa-utensils';

      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:10px 14px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-weight:700; background:var(--primary); color:white; width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12px;">${et.ordem}</span>
            <div>
              <strong style="color:#1e293b; font-size:13px;"><i class="fa-solid ${icone}" style="color:var(--primary); margin-right:4px;"></i> Praça: ${escapeHTML(et.praca)}</strong>
              <span style="color:#64748b; font-size:12px; margin-left:8px;">(SLA: <strong>${et.sla_minutos} min</strong>)</span>
            </div>
          </div>
          <button onclick="removerEtapaKds(${et.id})" class="btn-outline" style="padding:4px 8px; font-size:11px; color:#ef4444; border-color:#fca5a5; border-radius:6px;" title="Remover etapa">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      `;
    });

    html += '</div>';
    if (listaEl) listaEl.innerHTML = html;
    if (tempoTotalEl) tempoTotalEl.textContent = `SLA Total: ${totalSla} min`;
  } catch (err) {
    if (listaEl) listaEl.innerHTML = `<p style="color:#ef4444; font-size:12px;">Erro ao carregar etapas: ${escapeHTML(err.message)}</p>`;
  }
}

async function adicionarEtapaKds() {
  if (!produtoKdsAtual || !produtoKdsAtual.id) return;
  const pracaEl = document.getElementById('kds-nova-etapa-praca');
  const slaEl = document.getElementById('kds-nova-etapa-sla');

  const praca = pracaEl?.value;
  const sla = parseInt(slaEl?.value || '15', 10);

  if (!praca || isNaN(sla) || sla <= 0) {
    return alert('Selecione a praça e informe um SLA válido em minutos.');
  }

  try {
    // Busca a próxima ordem disponível
    const { data: etapasExistentes } = await supabaseClient
      .from('produto_etapas_kds')
      .select('ordem, praca')
      .eq('produto_id', produtoKdsAtual.id);

    if (etapasExistentes && etapasExistentes.some(e => e.praca === praca)) {
      return alert(`A praça "${praca}" já está cadastrada nesta rota. Cada praça pode constar uma única vez.`);
    }

    const maxOrdem = (etapasExistentes && etapasExistentes.length > 0)
      ? Math.max(...etapasExistentes.map(e => e.ordem || 0))
      : 0;

    const { error } = await supabaseClient
      .from('produto_etapas_kds')
      .insert({
        produto_id: produtoKdsAtual.id,
        ordem: maxOrdem + 1,
        praca: praca,
        sla_minutos: sla,
        obrigatoria: true
      });

    if (error) throw error;

    await recarregarEtapasKds(produtoKdsAtual.id);
  } catch (err) {
    alert('Erro ao adicionar etapa na rota: ' + err.message);
  }
}

async function removerEtapaKds(etapaId) {
  if (!produtoKdsAtual || !etapaId) return;
  if (!confirm('Deseja realmente remover esta etapa da rota produtiva?')) return;

  try {
    const { error } = await supabaseClient
      .from('produto_etapas_kds')
      .delete()
      .eq('id', etapaId);

    if (error) throw error;

    // Reordena etapas restantes
    const { data: restantes } = await supabaseClient
      .from('produto_etapas_kds')
      .select('id, ordem')
      .eq('produto_id', produtoKdsAtual.id)
      .order('ordem', { ascending: true });

    if (restantes && restantes.length > 0) {
      for (let i = 0; i < restantes.length; i++) {
        await supabaseClient
          .from('produto_etapas_kds')
          .update({ ordem: i + 1 })
          .eq('id', restantes[i].id);
      }
    }

    await recarregarEtapasKds(produtoKdsAtual.id);
  } catch (err) {
    alert('Erro ao remover etapa: ' + err.message);
  }
}

window.abrirModalRotaKds = abrirModalRotaKds;
window.fecharModalRotaKds = fecharModalRotaKds;
window.adicionarEtapaKds = adicionarEtapaKds;
window.removerEtapaKds = removerEtapaKds;

async function prepararUpload(input) {
  if (input.files && input.files[0]) {
    var file = input.files[0];
    document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-spinner fa-spin'></i> Processando...";
    document.getElementById('upload-status').innerText = "Enviando imagem...";
    document.getElementById('btn-salvar-produto').disabled = true;

    try {
      // 1. Tenta upload no bucket 'produtos' do Supabase Storage
      const fileExt = file.name.split('.').pop();
      const fileName = Date.now() + '_' + Math.random().toString(36).substring(7) + '.' + fileExt;
      const filePath = 'itens/' + fileName;

      const { data: storageData, error: storageError } = await supabaseClient.storage
        .from('produtos')
        .upload(filePath, file, { cacheControl: '3600', upsert: false });

      if (!storageError && storageData) {
        const { data: publicUrlData } = supabaseClient.storage
          .from('produtos')
          .getPublicUrl(filePath);

        document.getElementById('upload-status').innerText = "✅ Foto hospedada no Supabase!";
        document.getElementById('upload-status').style.color = "green";
        document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-check'></i> " + escapeHTML(file.name);
        document.getElementById('prod-img').value = publicUrlData.publicUrl;
        document.getElementById('btn-salvar-produto').disabled = false;
        return;
      }

      // 2. Fallback seguro via Cloudflare Functions (/api/upload-image)
      let formData = new FormData();
      formData.append("image", file);

      const session = (await window.supabaseClient?.auth?.getSession())?.data?.session;
      const token = session?.access_token || '';

      const resp = await fetch("/api/upload-image", {
        method: "POST",
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
        body: formData
      });
      const data = await resp.json();
      if (resp.ok && data.success && data.url) {
        document.getElementById('upload-status').innerText = "✅ Foto hospedada!";
        document.getElementById('upload-status').style.color = "green";
        document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-check'></i> " + escapeHTML(file.name);
        document.getElementById('prod-img').value = data.url;
        document.getElementById('btn-salvar-produto').disabled = false;
      } else {
        throw new Error(data.error || "Falha no upload.");
      }
    } catch (err) {
      console.error(err);
      document.getElementById('upload-status').innerText = "❌ Erro ao enviar.";
      document.getElementById('upload-status').style.color = "red";
      document.getElementById('btn-salvar-produto').disabled = false;
    }
  }
}