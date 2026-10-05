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
      controlar_estoque: p.controlar_estoque
    }));
    
    renderizarProdutosApp();
    if (usuarioAtual && usuarioAtual.nivel === 'admin') {
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
  if (usuarioAtual.nivel === 'visitante') {
    alert("Acesse ou crie uma conta para fazer o seu pedido!");
    return mostrarTela('login-section');
  }
  
  const p = produtos.find(prod => String(prod.id) === String(id));
  if (!p) return;
  
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
  modalQtdAtual = Math.max(1, modalQtdAtual + delta);
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
  
  if (!nome || !preco) return alert("Preencha Nome e Preço.");
  
  const btn = document.getElementById('btn-salvar-produto');
  const textOriginal = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
  
  try {
    let error;
    if (id) {
      const res = await supabaseClient
        .from('produtos')
        .update({
          nome: nome,
          preco: preco,
          descricao: desc,
          opcoes: opcoes,
          img_url: img,
          estoque_qtd: estoqueQtd,
          estoque_minimo: estoqueMinimo,
          controlar_estoque: controlarEstoque
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
          controlar_estoque: controlarEstoque
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
  for (let i = 0; i < produtos.length; i++) {
    let p = produtos[i];
    html += '<div class="user-list-item"><div><strong style="color:var(--text-dark);">' + p.nome + '</strong><br><span style="font-size:13px; color:var(--primary); font-weight:600;">R$ ' + parseFloat(p.preco).toFixed(2) + '</span></div><button class="btn-outline" onclick="editarProduto(\'' + p.id + '\')" style="padding:6px 12px; font-size:12px;"><i class="fa-solid fa-pen"></i> Editar</button></div>';
  }
  document.getElementById('lista-produtos-admin').innerHTML = html;
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
}

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

      // 2. Fallback ImgBB caso o bucket ainda não esteja configurado
      const IMGBB_API_KEY = (typeof window.IMGBB_API_KEY !== 'undefined') ? window.IMGBB_API_KEY : '97dfa8989e6adbbc6faebb4b505686fe';
      let formData = new FormData();
      formData.append("image", file);

      const resp = await fetch("https://api.imgbb.com/1/upload?key=" + IMGBB_API_KEY, { method: "POST", body: formData });
      const data = await resp.json();
      if (data.success) {
        document.getElementById('upload-status').innerText = "✅ Foto hospedada!";
        document.getElementById('upload-status').style.color = "green";
        document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-check'></i> " + escapeHTML(file.name);
        document.getElementById('prod-img').value = data.data.url;
        document.getElementById('btn-salvar-produto').disabled = false;
      } else {
        throw new Error("Falha no upload.");
      }
    } catch (err) {
      console.error(err);
      document.getElementById('upload-status').innerText = "❌ Erro ao enviar.";
      document.getElementById('upload-status').style.color = "red";
      document.getElementById('btn-salvar-produto').disabled = false;
    }
  }
}