// ==========================================================================
// LUNOCA DOCERIA - MÓDULO DE PRODUTOS & CATÁLOGO CHARMOSO
// ==========================================================================

var categoriaAtiva = 'todos';
var qtdModalAtual = 1;

async function carregarProdutosServidor() {
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
      estoque_minimo: p.estoque_minimo,
      controlar_estoque: p.controlar_estoque
    }));
    
    renderizarProdutosApp();
    if (usuarioAtual.nivel === 'admin') {
      if (typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
    }
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    document.getElementById('produtos-lista').innerHTML = "<p style='text-align:center; padding:30px; color:#846d62;'><i class='fa-solid fa-cake-candles'></i> Nosso cardápio está em atualização com novas delícias!</p>";
  }
}

function filtrarCategoriaCardapio(categoria, btn) {
  categoriaAtiva = categoria;
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderizarProdutosApp();
}

function identificarCategoria(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('bolo') || n.includes('fatia') || n.includes('torta')) return 'bolos';
  if (n.includes('brigadeiro')) return 'brigadeiros';
  if (n.includes('brownie')) return 'brownies';
  if (n.includes('cento') || n.includes('festa')) return 'cento';
  return 'outros';
}

function renderizarProdutosApp() {
  const defaultImg = 'img/logo.jpg';
  let html = '';
  
  const listaFiltrada = produtos.filter(p => {
    if (categoriaAtiva === 'todos') return true;
    return identificarCategoria(p.nome) === categoriaAtiva;
  });

  for (let i = 0; i < listaFiltrada.length; i++) {
    let p = listaFiltrada[i];
    let imagemUrl = p.img ? escapeHTML(p.img) : defaultImg;
    let nomeEsc = escapeHTML(p.nome);
    let descFormatada = p.desc ? escapeHTML(p.desc).replace(/\n/g, '<br>') : '';
    let precoFloat = parseFloat(p.preco || 0);
    let precoFormatado = precoFloat.toFixed(2).replace('.', ',');
    
    // Status de estoque
    let badgeEstoque = '';
    let desabilitado = false;
    if (p.controlar_estoque && p.estoque_qtd !== undefined && p.estoque_qtd !== null) {
      if (p.estoque_qtd <= 0) {
        badgeEstoque = '<span style="font-size:9.5px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; padding:2px 8px; border-radius:10px; font-weight:700;">Esgotado</span>';
        desabilitado = true;
      } else if (p.estoque_qtd <= (p.estoque_minimo || 3)) {
        badgeEstoque = '<span style="font-size:9.5px; background:#fffbeb; color:#d97706; border:1px solid #fef3c7; padding:2px 8px; border-radius:10px; font-weight:700;">Restam ' + p.estoque_qtd + ' un</span>';
      }
    }

    let botaoTexto = desabilitado 
      ? '<button class="btn-adicionar" disabled style="opacity:0.6; cursor:not-allowed; background:#aaa; box-shadow:none;"><i class="fa-solid fa-ban"></i> Esgotado</button>'
      : '<button class="btn-adicionar" onclick="abrirModalProduto(\'' + p.id + '\')"><i class="fa-solid fa-cart-plus"></i> <span>Pedir</span></button>';

    html += `
      <div class="produto-card">
        <div class="produto-header">
          <div class="produto-img-wrapper">
            <img src="${imagemUrl}" class="produto-img" alt="${nomeEsc}" loading="lazy">
            <span class="badge-artesanal"><i class="fa-solid fa-sparkles"></i> Artesanal</span>
          </div>
          <div class="produto-info">
            <h3>${nomeEsc}</h3>
            ${badgeEstoque ? `<div>${badgeEstoque}</div>` : ''}
            ${p.opcoes ? `<span class="produto-tag-sabor"><i class="fa-solid fa-heart"></i> Opções de sabores</span>` : ''}
          </div>
        </div>
        <div class="produto-desc">${descFormatada}</div>
        <div class="produto-footer">
          <div class="preco-container">
            <span class="preco-label">Valor</span>
            <div class="preco">
              <span class="preco-simbolo">R$</span> ${precoFormatado}
            </div>
          </div>
          ${botaoTexto}
        </div>
      </div>
    `;
  }
  
  if (html === '') {
    html = `
      <div style="text-align:center; padding: 40px 20px; background:var(--white); border-radius:var(--radius-lg); border:1px dashed var(--border-gold); margin:20px 0;">
        <i class="fa-solid fa-cookie-bite fa-3x" style="color:var(--primary); opacity:0.6; margin-bottom:12px;"></i>
        <h4 style="margin:0 0 6px; font-family:'Playfair Display', serif;">Nenhum doce nesta categoria no momento</h4>
        <p style="margin:0; font-size:13.5px; color:var(--text-light);">Confira todas as outras delícias disponíveis em nosso cardápio!</p>
        <button class="btn-outline" onclick="filtrarCategoriaCardapio('todos', document.querySelector('.cat-pill'))" style="margin:16px auto 0; padding:8px 18px; font-size:12.5px;">
          Ver Todos os Doces
        </button>
      </div>
    `;
  }
  
  document.getElementById('produtos-lista').innerHTML = html;
}

function alterarQtdModal(delta) {
  qtdModalAtual += delta;
  if (qtdModalAtual < 1) qtdModalAtual = 1;
  
  // Limite pelo estoque se controlado
  if (produtoSendoVisto && produtoSendoVisto.controlar_estoque && produtoSendoVisto.estoque_qtd !== undefined && produtoSendoVisto.estoque_qtd !== null) {
    if (qtdModalAtual > produtoSendoVisto.estoque_qtd) {
      qtdModalAtual = produtoSendoVisto.estoque_qtd;
      alert("A quantidade máxima disponível em estoque para este doce é de " + produtoSendoVisto.estoque_qtd + " un.");
    }
  }

  const valEl = document.getElementById('modal-qtd-val');
  if (valEl) valEl.innerText = qtdModalAtual;
  
  if (produtoSendoVisto) {
    const subtotal = (parseFloat(produtoSendoVisto.preco || 0) * qtdModalAtual).toFixed(2).replace('.', ',');
    const txtEl = document.getElementById('btn-confirmar-add-txt');
    if (txtEl) txtEl.innerText = `Adicionar ao Pedido • R$ ${subtotal}`;
  }
}

function abrirModalProduto(id) {
  if (usuarioAtual.nivel === 'visitante') {
    alert("Bem-vindo(a)! Faça seu login ou cadastre-se para saborear nossas delícias.");
    return mostrarTela('login-section');
  }
  
  let p = produtos.filter(function(prod) { return prod.id == id; })[0];
  if (!p) return;
  
  // Verifica se está esgotado
  if (p.controlar_estoque && p.estoque_qtd !== undefined && p.estoque_qtd !== null && p.estoque_qtd <= 0) {
    alert("Este produto está temporariamente esgotado. Em breve teremos uma nova fornada!");
    return;
  }
  
  produtoSendoVisto = p;
  qtdModalAtual = 1;
  
  document.getElementById('modal-img').src = p.img || 'img/logo.jpg';
  document.getElementById('modal-nome').innerText = p.nome;
  document.getElementById('modal-preco').innerText = "R$ " + parseFloat(p.preco).toFixed(2).replace('.', ',');
  
  const valEl = document.getElementById('modal-qtd-val');
  if (valEl) valEl.innerText = '1';
  
  const txtEl = document.getElementById('btn-confirmar-add-txt');
  if (txtEl) txtEl.innerText = `Adicionar ao Pedido • R$ ${parseFloat(p.preco).toFixed(2).replace('.', ',')}`;
  
  let mDesc = document.getElementById('modal-desc');
  if (mDesc) {
    mDesc.textContent = p.desc || '';
    mDesc.style.whiteSpace = 'pre-line';
  }
  
  let containerOpcoes = document.getElementById('modal-opcoes-container');
  let listaOpcoes = document.getElementById('modal-opcoes-lista');
  
  if (p.opcoes && p.opcoes.trim() !== "") {
    containerOpcoes.style.display = 'block';
    let opcoesArray = p.opcoes.split(',');
    let htmlOpcoes = '';
    
    for (let i = 0; i < opcoesArray.length; i++) {
      let opcaoTexto = escapeHTML(opcoesArray[i].trim());
      let checkedAttr = (i === 0) ? 'checked' : '';
      htmlOpcoes += `
        <label class="variation-item">
          <input type="radio" name="sabor_escolhido" value="${opcaoTexto}" ${checkedAttr}>
          <span style="font-weight:500; font-size:13.5px; color:var(--text-dark);">${opcaoTexto}</span>
        </label>
      `;
    }
    listaOpcoes.innerHTML = htmlOpcoes;
  } else {
    containerOpcoes.style.display = 'none';
  }
  
  document.getElementById('modal-produto').style.display = 'flex';
}

function fecharModalProduto() {
  document.getElementById('modal-produto').style.display = 'none';
  produtoSendoVisto = null;
  qtdModalAtual = 1;
}

function confirmarAdicaoCarrinho() {
  if (!produtoSendoVisto) return;
  
  let saborEscolhido = "";
  if (produtoSendoVisto.opcoes && produtoSendoVisto.opcoes.trim() !== "") {
    let selecionado = document.querySelector('input[name="sabor_escolhido"]:checked');
    if (!selecionado) {
      alert("Por favor, selecione seu sabor favorito para continuar.");
      return;
    }
    saborEscolhido = " (" + selecionado.value + ")";
  }
  
  // Adiciona a quantidade selecionada ao carrinho
  for (let q = 0; q < qtdModalAtual; q++) {
    let itemCarrinho = Object.assign({}, produtoSendoVisto);
    if (saborEscolhido) {
      itemCarrinho.nome = itemCarrinho.nome + saborEscolhido;
    }
    carrinho.push(itemCarrinho);
  }
  
  atualizarBotaoCarrinho();
  salvarCarrinhoLocal();
  fecharModalProduto();
  
  document.getElementById('btn-ver-carrinho').style.display = 'flex';
  alert(`✨ ${qtdModalAtual}x ${produtoSendoVisto.nome} adicionado(s) com sucesso ao seu pedido!`);
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
  
  if (document.getElementById('prod-estoque-qtd')) {
    document.getElementById('prod-estoque-qtd').value = (p.estoque_qtd !== undefined && p.estoque_qtd !== null) ? p.estoque_qtd : 10;
  }
  if (document.getElementById('prod-estoque-minimo')) {
    document.getElementById('prod-estoque-minimo').value = (p.estoque_minimo !== undefined && p.estoque_minimo !== null) ? p.estoque_minimo : 3;
  }
  if (document.getElementById('prod-controlar-estoque')) {
    document.getElementById('prod-controlar-estoque').checked = p.controlar_estoque !== false;
  }
  
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
    
    alert("✅ Doce atualizado com sucesso!");
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
    html += `
      <div class="user-list-item">
        <div style="display:flex; align-items:center; gap:12px;">
          <img src="${p.img || 'img/logo.jpg'}" style="width:40px; height:40px; border-radius:8px; object-fit:cover;">
          <div>
            <strong style="color:var(--text-dark);">${escapeHTML(p.nome)}</strong><br>
            <span style="font-size:13px; color:var(--primary); font-weight:600;">R$ ${parseFloat(p.preco).toFixed(2)}</span>
          </div>
        </div>
        <button class="btn-outline" onclick="editarProduto('${p.id}')" style="padding:6px 12px; font-size:12px;">
          <i class="fa-solid fa-pen"></i> Editar
        </button>
      </div>
    `;
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

        document.getElementById('upload-status').innerText = "✅ Foto hospedada com sucesso!";
        document.getElementById('upload-status').style.color = "green";
        document.getElementById('lbl-upload').innerHTML = "<i class='fa-solid fa-check'></i> " + escapeHTML(file.name);
        document.getElementById('prod-img').value = publicUrlData.publicUrl;
        document.getElementById('btn-salvar-produto').disabled = false;
        return;
      }

      // Fallback ImgBB
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
        throw new Error("Falha no upload da foto.");
      }
    } catch (err) {
      console.error(err);
      document.getElementById('upload-status').innerText = "❌ Erro ao enviar a foto.";
      document.getElementById('upload-status').style.color = "red";
      document.getElementById('btn-salvar-produto').disabled = false;
    }
  }
}
