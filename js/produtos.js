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
      img: p.img_url
    }));
    
    renderizarProdutosApp();
    if (usuarioAtual.nivel === 'admin') {
      if (typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
    }
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    document.getElementById('produtos-lista').innerHTML = "<p style='text-align:center;'>Erro ao carregar cardápio.</p>";
  }
}

function renderizarProdutosApp() {
  const defaultImg = 'https://via.placeholder.com/150/fbf9ff/c496f2?text=Doce';
  let html = '';
  for (let i = 0; i < produtos.length; i++) {
    let p = produtos[i];
    let imagemUrl = p.img ? escapeHTML(p.img) : defaultImg;
    let nomeEsc = escapeHTML(p.nome);
    let descFormatada = p.desc ? escapeHTML(p.desc).replace(/\n/g, '<br>') : '';
    let precoFormatado = parseFloat(p.preco || 0).toFixed(2);
    html += '<div class="produto-card"><div class="produto-header"><img src="' + imagemUrl + '" class="produto-img" alt="' + nomeEsc + '"><div class="produto-info"><h3>' + nomeEsc + '</h3></div></div><div class="produto-desc">' + descFormatada + '</div><div class="produto-footer"><div class="preco">R$ ' + precoFormatado + '</div><button class="btn-adicionar" onclick="abrirModalProduto(\'' + p.id + '\')"><i class="fa-solid fa-plus"></i></button></div></div>';
  }
  if (html === '') {
    html = "<p style='text-align:center;'>Cardápio em atualização.</p>";
  }
  document.getElementById('produtos-lista').innerHTML = html;
}

function abrirModalProduto(id) {
  if (usuarioAtual.nivel === 'visitante') {
    alert("Acesse ou crie uma conta para fazer o seu pedido!");
    return mostrarTela('login-section');
  }
  
  let p = produtos.filter(function(prod) { return prod.id == id; })[0];
  if (!p) return;
  
  produtoSendoVisto = p;
  document.getElementById('modal-img').src = p.img || 'https://via.placeholder.com/150/fbf9ff/c496f2?text=Doce';
  document.getElementById('modal-nome').innerText = p.nome;
  document.getElementById('modal-preco').innerText = "R$ " + parseFloat(p.preco).toFixed(2);
  let mDesc = document.getElementById('modal-desc');
  if (mDesc) {
    mDesc.textContent = p.desc || '';
    mDesc.style.whiteSpace = 'pre-line';
  }
  
  let containerOpcoes = document.getElementById('modal-opcoes-container');
  let listaOpcoes = document.getElementById('modal-opcoes-lista');
  
  if (p.opcoes && p.opcoes.trim() !== "") {
    containerOpcoes.style.display = 'block';
    let arrayOpcoes = p.opcoes.split(',');
    let htmlOpcoes = '';
    for (let i = 0; i < arrayOpcoes.length; i++) {
      let opcaoTexto = arrayOpcoes[i].trim();
      htmlOpcoes += '<label class="variation-item"><input type="radio" name="sabor_escolhido" value="' + opcaoTexto + '">' + opcaoTexto + '</label>';
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
}

function confirmarAdicaoCarrinho() {
  if (!produtoSendoVisto) return;
  
  let itemCarrinho = Object.assign({}, produtoSendoVisto);
  
  if (itemCarrinho.opcoes && itemCarrinho.opcoes.trim() !== "") {
    let selecionado = document.querySelector('input[name="sabor_escolhido"]:checked');
    if (!selecionado) {
      alert("Por favor, escolha um sabor para continuar.");
      return;
    }
    itemCarrinho.nome = itemCarrinho.nome + " (" + selecionado.value + ")";
  }
  
  carrinho.push(itemCarrinho);
  atualizarBotaoCarrinho();
  salvarCarrinhoLocal();
  fecharModalProduto();
  document.getElementById('btn-ver-carrinho').style.display = 'flex';
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
          img_url: img
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
          img_url: img
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
}

async async function prepararUpload(input) {
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