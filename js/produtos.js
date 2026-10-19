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
      pronta_entrega: p.pronta_entrega === true,
      requer_aprovacao_personalizacao: p.requer_aprovacao_personalizacao === true
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

async function abrirModalProduto(id) {
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

  // Personalização dinâmica & Briefing de Produção (Frente 043)
  const containerPz = document.getElementById('modal-personalizacao-container');
  const listaPz = document.getElementById('modal-personalizacao-campos');
  const badgePz = document.getElementById('modal-personalizacao-badge');
  window.personalizacaoCamposAtivos = [];
  window.personalizacaoRespostasAtuais = {};

  if (containerPz) containerPz.style.display = 'none';
  if (listaPz) listaPz.innerHTML = '';

  try {
    const { data: pzData, error: pzErr } = await supabaseClient
      .rpc('obter_personalizacao_produto', { p_produto_id: p.id });

    if (!pzErr && pzData && pzData.success && Array.isArray(pzData.campos) && pzData.campos.length > 0) {
      window.personalizacaoCamposAtivos = pzData.campos;
      if (badgePz) {
        badgePz.textContent = pzData.requer_aprovacao ? 'Revisão manual da confeitaria' : 'Briefing de produção';
      }
      renderizarCamposPersonalizacaoCliente(pzData.campos);
      if (containerPz) containerPz.style.display = 'block';
    }
  } catch (errPz) {
    console.warn('[Personalizacao] Erro ao carregar campos:', errPz);
  }
  
  document.getElementById('modal-produto').style.display = 'flex';
}

function renderizarCamposPersonalizacaoCliente(campos) {
  const listaPz = document.getElementById('modal-personalizacao-campos');
  if (!listaPz) return;

  window.personalizacaoRespostasAtuais = {};
  let html = '';

  for (const c of campos) {
    const labelEsc = escapeHTML(c.label);
    const obgMarker = c.obrigatorio ? '<span style="color:#e11d48; margin-left:2px;">*</span>' : '';
    const placeholderEsc = c.placeholder ? escapeHTML(c.placeholder) : '';
    const ajudaEsc = c.texto_ajuda ? `<div style="font-size:11px; color:#64748b; margin-top:2px;">${escapeHTML(c.texto_ajuda)}</div>` : '';
    const cfg = c.config_json || {};

    if (c.tipo === 'TEXTO') {
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <input type="text" id="pz-input-${c.codigo}" placeholder="${placeholderEsc}" style="width:100%; font-size:13px; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px;">
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'TEXTO_LONGO') {
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <textarea id="pz-input-${c.codigo}" rows="2" placeholder="${placeholderEsc}" style="width:100%; font-size:13px; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px; resize:vertical;"></textarea>
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'COR') {
      window.personalizacaoRespostasAtuais[c.codigo] = '#be185d';
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="color" id="pz-input-${c.codigo}" value="#be185d" onchange="document.getElementById('pz-hex-${c.codigo}').value = this.value; window.personalizacaoRespostasAtuais['${c.codigo}'] = this.value;" style="width:38px; height:34px; border:none; border-radius:6px; cursor:pointer;">
            <input type="text" id="pz-hex-${c.codigo}" value="#be185d" maxlength="7" oninput="if(this.value.startsWith('#') && this.value.length === 7) { document.getElementById('pz-input-${c.codigo}').value = this.value; window.personalizacaoRespostasAtuais['${c.codigo}'] = this.value; }" style="width:80px; font-size:12px; padding:6px; border:1px solid #cbd5e1; border-radius:6px;">
          </div>
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'CORES_MULTIPLAS') {
      const maxCores = cfg.max_cores || 4;
      window.personalizacaoRespostasAtuais[c.codigo] = ['#be185d'];
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} (Máx: ${maxCores}) ${obgMarker}</label>
          <div id="pz-paleta-${c.codigo}" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
            <span style="display:inline-flex; align-items:center; gap:4px; background:#fff; border:1px solid #cbd5e1; border-radius:16px; padding:2px 8px; font-size:11px;">
              <span style="width:14px; height:14px; border-radius:50%; background:#be185d; display:inline-block;"></span>
              #be185d
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <input type="color" id="pz-picker-${c.codigo}" value="#3b82f6" style="width:34px; height:30px; border:none; border-radius:6px; cursor:pointer;">
            <button type="button" class="btn-outline" onclick="adicionarCorPaleta('${c.codigo}', ${maxCores})" style="font-size:11px; padding:4px 10px; border-radius:6px;">
              <i class="fa-solid fa-plus"></i> Adicionar Cor
            </button>
          </div>
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'SELECT') {
      const opcoes = Array.isArray(cfg.opcoes) ? cfg.opcoes : [];
      let optsHtml = `<option value="">Selecione uma opção...</option>`;
      for (const op of opcoes) {
        optsHtml += `<option value="${escapeHTML(op)}">${escapeHTML(op)}</option>`;
      }
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <select id="pz-input-${c.codigo}" style="width:100%; font-size:13px; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px;">
            ${optsHtml}
          </select>
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'NUMERO') {
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <input type="number" id="pz-input-${c.codigo}" placeholder="${placeholderEsc}" style="width:100%; font-size:13px; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px;">
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'DATA') {
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${obgMarker}</label>
          <input type="date" id="pz-input-${c.codigo}" style="width:100%; font-size:13px; padding:7px 10px; border:1px solid #cbd5e1; border-radius:8px;">
          ${ajudaEsc}
        </div>
      `;
    } else if (c.tipo === 'IMAGEM' || c.tipo === 'IMAGENS') {
      const isMulti = c.tipo === 'IMAGENS';
      const maxImg = isMulti ? (cfg.max_imagens || 5) : 1;
      window.personalizacaoRespostasAtuais[c.codigo] = [];
      html += `
        <div>
          <label style="font-size:12px; font-weight:600; color:#334155; display:block; margin-bottom:3px;">${labelEsc} ${isMulti ? `(Até ${maxImg} fotos)` : ''} ${obgMarker}</label>
          <input type="file" id="pz-file-${c.codigo}" accept="image/*" ${isMulti ? 'multiple' : ''} onchange="uploadReferenciasCliente(this, '${c.codigo}', '${c.tipo}', ${maxImg})" style="font-size:12px; margin-bottom:4px;">
          <div id="pz-status-${c.codigo}" style="font-size:11px; color:#64748b;"></div>
          <div id="pz-previews-${c.codigo}" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:4px;"></div>
          ${ajudaEsc}
        </div>
      `;
    }
  }

  listaPz.innerHTML = html;
}

function adicionarCorPaleta(codigo, maxCores) {
  const picker = document.getElementById(`pz-picker-${codigo}`);
  if (!picker) return;
  const novaCor = picker.value;
  if (!Array.isArray(window.personalizacaoRespostasAtuais[codigo])) {
    window.personalizacaoRespostasAtuais[codigo] = [];
  }
  const lista = window.personalizacaoRespostasAtuais[codigo];
  if (lista.length >= maxCores) {
    alert(`Você já selecionou o limite máximo de ${maxCores} cores.`);
    return;
  }
  lista.push(novaCor);
  renderizarPaletaPills(codigo, maxCores);
}

function removerCorPaleta(codigo, index, maxCores) {
  const lista = window.personalizacaoRespostasAtuais[codigo];
  if (Array.isArray(lista)) {
    lista.splice(index, 1);
    renderizarPaletaPills(codigo, maxCores);
  }
}

function renderizarPaletaPills(codigo, maxCores) {
  const container = document.getElementById(`pz-paleta-${codigo}`);
  if (!container) return;
  const lista = window.personalizacaoRespostasAtuais[codigo] || [];
  container.innerHTML = lista.map((cor, idx) => `
    <span style="display:inline-flex; align-items:center; gap:4px; background:#fff; border:1px solid #cbd5e1; border-radius:16px; padding:2px 8px; font-size:11px;">
      <span style="width:14px; height:14px; border-radius:50%; background:${escapeHTML(cor)}; display:inline-block;"></span>
      ${escapeHTML(cor)}
      <span role="button" onclick="removerCorPaleta('${codigo}', ${idx}, ${maxCores})" style="cursor:pointer; color:#ef4444; font-weight:700; margin-left:4px;">&times;</span>
    </span>
  `).join('');
}

async function uploadReferenciasCliente(input, codigo, tipo, maxImagens) {
  const files = Array.from(input.files || []);
  if (files.length === 0) return;

  const statusEl = document.getElementById(`pz-status-${codigo}`);
  const previewEl = document.getElementById(`pz-previews-${codigo}`);
  if (!Array.isArray(window.personalizacaoRespostasAtuais[codigo])) {
    window.personalizacaoRespostasAtuais[codigo] = [];
  }
  const lista = window.personalizacaoRespostasAtuais[codigo];

  if (lista.length + files.length > maxImagens) {
    alert(`Limite de ${maxImagens} foto(s) excedido para este campo.`);
    input.value = '';
    return;
  }

  if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando imagem(ns)...';

  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      alert(`O arquivo "${file.name}" excede o limite máximo de 10MB.`);
      continue;
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `referencias/${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${safeName}`;

    try {
      const { data, error } = await supabaseClient.storage
        .from('pedido-referencias')
        .upload(storagePath, file, { upsert: false });

      if (error) throw error;

      lista.push({
        storage_path: data.path,
        nome_original: file.name,
        tamanho_bytes: file.size,
        mime_type: file.type || 'image/jpeg'
      });
    } catch (err) {
      console.error('[Upload Referencia] Erro:', err);
      alert(`Falha ao enviar "${file.name}": ${err.message}`);
    }
  }

  if (statusEl) statusEl.innerHTML = `✅ ${lista.length} foto(s) anexada(s)`;
  if (previewEl) {
    previewEl.innerHTML = lista.map((arq, idx) => `
      <div style="position:relative; width:48px; height:48px; border:1px solid #cbd5e1; border-radius:6px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; overflow:hidden;" title="${escapeHTML(arq.nome_original)}">
        <i class="fa-solid fa-image" style="color:var(--primary);"></i>
        <button type="button" onclick="removerFotoReferencia('${codigo}', ${idx}, ${maxImagens})" style="position:absolute; top:0; right:0; background:rgba(220,38,38,0.85); color:#fff; border:none; width:16px; height:16px; font-size:10px; cursor:pointer; line-height:16px; text-align:center;">&times;</button>
      </div>
    `).join('');
  }
  input.value = '';
}

function removerFotoReferencia(codigo, idx, maxImagens) {
  const lista = window.personalizacaoRespostasAtuais[codigo];
  if (Array.isArray(lista)) {
    lista.splice(idx, 1);
    const statusEl = document.getElementById(`pz-status-${codigo}`);
    const previewEl = document.getElementById(`pz-previews-${codigo}`);
    if (statusEl) statusEl.innerHTML = lista.length > 0 ? `✅ ${lista.length} foto(s) anexada(s)` : '';
    if (previewEl) {
      previewEl.innerHTML = lista.map((arq, i) => `
        <div style="position:relative; width:48px; height:48px; border:1px solid #cbd5e1; border-radius:6px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; overflow:hidden;" title="${escapeHTML(arq.nome_original)}">
          <i class="fa-solid fa-image" style="color:var(--primary);"></i>
          <button type="button" onclick="removerFotoReferencia('${codigo}', ${i}, ${maxImagens})" style="position:absolute; top:0; right:0; background:rgba(220,38,38,0.85); color:#fff; border:none; width:16px; height:16px; font-size:10px; cursor:pointer; line-height:16px; text-align:center;">&times;</button>
        </div>
      `).join('');
    }
  }
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

  // Validação e captura de Personalizações (Frente 043)
  const respostasPz = {};
  if (Array.isArray(window.personalizacaoCamposAtivos) && window.personalizacaoCamposAtivos.length > 0) {
    for (const campo of window.personalizacaoCamposAtivos) {
      let val = null;
      if (campo.tipo === 'TEXTO' || campo.tipo === 'TEXTO_LONGO' || campo.tipo === 'SELECT' || campo.tipo === 'DATA') {
        const inp = document.getElementById(`pz-input-${campo.codigo}`);
        val = inp ? inp.value.trim() : '';
      } else if (campo.tipo === 'NUMERO') {
        const inp = document.getElementById(`pz-input-${campo.codigo}`);
        val = (inp && inp.value !== '') ? Number(inp.value) : null;
      } else if (campo.tipo === 'COR') {
        val = window.personalizacaoRespostasAtuais[campo.codigo] || '#be185d';
      } else if (campo.tipo === 'CORES_MULTIPLAS') {
        val = window.personalizacaoRespostasAtuais[campo.codigo] || [];
      } else if (campo.tipo === 'IMAGEM' || campo.tipo === 'IMAGENS') {
        val = window.personalizacaoRespostasAtuais[campo.codigo] || [];
      }

      // Validação de obrigatoriedade
      if (campo.obrigatorio) {
        let vazio = false;
        if (val === null || val === undefined || val === '') vazio = true;
        if (Array.isArray(val) && val.length === 0) vazio = true;

        if (vazio) {
          alert(`Por favor, preencha o campo obrigatório: "${campo.label}"`);
          return;
        }
      }

      if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
        respostasPz[campo.codigo] = val;
      }
    }
  }
  itemCarrinho.personalizacoes = respostasPz;
  
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

  // Agrupa se já existir produto idêntico (mesmo ID, sabor E personalizações idênticas - PERS8)
  const itemExistente = carrinho.find(it => 
    String(it.id) === String(itemCarrinho.id) && 
    (it.sabor || '') === (itemCarrinho.sabor || '') &&
    JSON.stringify(it.personalizacoes || {}) === JSON.stringify(itemCarrinho.personalizacoes || {})
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
          <button class="btn-outline" onclick="abrirModalConfigPersonalizacao(${p.id}, '${escapeHTML(p.nome)}', ${p.requer_aprovacao_personalizacao === true})" style="padding:6px 12px; font-size:12px; border-radius:8px;" title="Configurar Briefing e Personalização">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Personalização
          </button>
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

// ------------------------------------------------------------------------------
// CONFIGURAÇÃO DE PERSONALIZAÇÃO & BRIEFING POR PRODUTO (FRENTE 043 - ADMIN)
// ------------------------------------------------------------------------------
let produtoConfigPzAtual = null;

async function abrirModalConfigPersonalizacao(produtoId, nomeProduto, requerAprovacao) {
  produtoConfigPzAtual = { id: produtoId, nome: nomeProduto };
  const titEl = document.getElementById('pz-modal-produto-titulo');
  if (titEl) titEl.textContent = nomeProduto;

  const toggle = document.getElementById('pz-toggle-requer-aprovacao');
  if (toggle) toggle.checked = requerAprovacao === true;

  await recarregarCamposPersonalizacaoAdmin(produtoId);

  const modal = document.getElementById('modal-config-personalizacao-produto');
  if (modal) modal.style.display = 'flex';
}

function fecharModalConfigPersonalizacao() {
  const modal = document.getElementById('modal-config-personalizacao-produto');
  if (modal) modal.style.display = 'none';
  produtoConfigPzAtual = null;
  carregarProdutosServidor();
}

async function alternarRequerAprovacaoProduto(checked) {
  if (!produtoConfigPzAtual) return;
  try {
    const { error } = await supabaseClient
      .from('produtos')
      .update({ requer_aprovacao_personalizacao: checked })
      .eq('id', produtoConfigPzAtual.id);
    if (error) throw error;
  } catch (err) {
    alert('Erro ao atualizar configuração de aprovação: ' + err.message);
  }
}

function alternarCamposConfigExtra(tipo) {
  const extraBloco = document.getElementById('pz-bloco-config-extra');
  const inputExtra = document.getElementById('pz-novo-extra');
  if (!extraBloco) return;

  if (tipo === 'SELECT' || tipo === 'CORES_MULTIPLAS' || tipo === 'IMAGENS') {
    extraBloco.style.display = 'block';
    if (tipo === 'SELECT') {
      inputExtra.placeholder = 'Opção 1, Opção 2, Opção 3';
    } else if (tipo === 'CORES_MULTIPLAS') {
      inputExtra.placeholder = 'Máx cores: 4';
    } else {
      inputExtra.placeholder = 'Máx imagens: 5';
    }
  } else {
    extraBloco.style.display = 'none';
  }
}

async function recarregarCamposPersonalizacaoAdmin(produtoId) {
  const listaEl = document.getElementById('pz-lista-campos-config');
  if (!listaEl) return;
  listaEl.innerHTML = '<p style="color:#64748b; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando campos...</p>';

  try {
    const { data: campos, error } = await supabaseClient
      .from('produto_campos_personalizacao')
      .select('*')
      .eq('produto_id', produtoId)
      .eq('ativo', true)
      .order('ordem', { ascending: true });

    if (error) throw error;

    if (!campos || campos.length === 0) {
      listaEl.innerHTML = '<p style="color:#94a3b8; font-size:12px; font-style:italic;">Nenhum campo de personalização configurado para este produto.</p>';
      return;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
    for (const c of campos) {
      const badgeObg = c.obrigatorio 
        ? '<span style="background:#fef2f2; color:#b91c1c; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;">Obrigatório</span>'
        : '<span style="background:#f8fafc; color:#64748b; font-size:10px; padding:2px 6px; border-radius:4px;">Opcional</span>';

      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:10px 14px;">
          <div>
            <strong style="color:#1e293b; font-size:13px;">${escapeHTML(c.label)}</strong>
            <span style="color:#64748b; font-size:11px; margin-left:6px; font-family:monospace;">(${escapeHTML(c.codigo)})</span>
            <span style="background:#e0e7ff; color:#3730a3; font-size:10px; font-weight:600; padding:2px 6px; border-radius:4px; margin-left:6px;">${escapeHTML(c.tipo)}</span>
            ${badgeObg}
          </div>
          <div>
            <button type="button" class="btn-outline" onclick="removerCampoPersonalizacaoAdmin(${c.id})" style="color:#dc2626; border-color:#fca5a5; padding:4px 8px; font-size:11px; border-radius:6px;" title="Remover Campo">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
      `;
    }
    html += '</div>';
    listaEl.innerHTML = html;
  } catch (err) {
    listaEl.innerHTML = `<p style="color:#dc2626; font-size:12px;">Erro: ${escapeHTML(err.message)}</p>`;
  }
}

async function adicionarCampoPersonalizacaoAdmin() {
  if (!produtoConfigPzAtual) return;

  const codigo = (document.getElementById('pz-novo-codigo')?.value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = (document.getElementById('pz-novo-label')?.value || '').trim();
  const tipo = document.getElementById('pz-novo-tipo')?.value || 'TEXTO';
  const obrigatorio = document.getElementById('pz-novo-obrigatorio')?.checked === true;
  const extraVal = (document.getElementById('pz-novo-extra')?.value || '').trim();

  if (!codigo || !label) {
    alert('Código e Rótulo são obrigatórios.');
    return;
  }

  const configJson = {};
  if (tipo === 'SELECT') {
    configJson.opcoes = extraVal.split(',').map(s => s.trim()).filter(Boolean);
  } else if (tipo === 'CORES_MULTIPLAS') {
    const m = parseInt(extraVal.replace(/\D/g, ''), 10);
    configJson.max_cores = (!isNaN(m) && m > 0) ? m : 4;
  } else if (tipo === 'IMAGENS') {
    const m = parseInt(extraVal.replace(/\D/g, ''), 10);
    configJson.max_imagens = (!isNaN(m) && m > 0) ? m : 5;
  }

  try {
    const { error } = await supabaseClient
      .from('produto_campos_personalizacao')
      .insert({
        produto_id: produtoConfigPzAtual.id,
        codigo: codigo,
        label: label,
        tipo: tipo,
        obrigatorio: obrigatorio,
        config_json: configJson
      });

    if (error) throw error;

    document.getElementById('pz-novo-codigo').value = '';
    document.getElementById('pz-novo-label').value = '';
    document.getElementById('pz-novo-extra').value = '';
    document.getElementById('pz-novo-obrigatorio').checked = false;

    await recarregarCamposPersonalizacaoAdmin(produtoConfigPzAtual.id);
  } catch (err) {
    alert('Erro ao salvar campo: ' + err.message);
  }
}

async function removerCampoPersonalizacaoAdmin(campoId) {
  if (!produtoConfigPzAtual || !campoId) return;
  if (!confirm('Deseja realmente desativar este campo de personalização?')) return;

  try {
    const { error } = await supabaseClient
      .from('produto_campos_personalizacao')
      .update({ ativo: false })
      .eq('id', campoId);

    if (error) throw error;
    await recarregarCamposPersonalizacaoAdmin(produtoConfigPzAtual.id);
  } catch (err) {
    alert('Erro ao remover campo: ' + err.message);
  }
}

window.abrirModalConfigPersonalizacao = abrirModalConfigPersonalizacao;
window.fecharModalConfigPersonalizacao = fecharModalConfigPersonalizacao;
window.alternarRequerAprovacaoProduto = alternarRequerAprovacaoProduto;
window.alternarCamposConfigExtra = alternarCamposConfigExtra;
window.adicionarCampoPersonalizacaoAdmin = adicionarCampoPersonalizacaoAdmin;
window.removerCampoPersonalizacaoAdmin = removerCampoPersonalizacaoAdmin;
window.adicionarCorPaleta = adicionarCorPaleta;
window.removerCorPaleta = removerCorPaleta;
window.uploadReferenciasCliente = uploadReferenciasCliente;
window.removerFotoReferencia = removerFotoReferencia;

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