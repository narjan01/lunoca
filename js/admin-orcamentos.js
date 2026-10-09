// ==========================================================================
// LUNOCA DOCERIA - Módulo Administrativo: Orçamentos & Conversão Comercial (Etapa 3)
// ==========================================================================

var orcamentosCache = [];
var orcamentoAtualEmEdicao = null;
var orcamentoAtualEspelho = null;
var filtroStatusOrcamentoAtual = 'todos';
var termoBuscaOrcamentoAtual = '';

/**
 * Inicialização / Carregamento da Central de Orçamentos
 */
async function carregarOrcamentosAdmin(statusFiltro = null, termoBusca = null) {
  const container = document.getElementById('orcamentos-lista-container');
  if (!container) return;

  if (statusFiltro !== null) filtroStatusOrcamentoAtual = statusFiltro;
  if (termoBusca !== null) termoBuscaOrcamentoAtual = termoBusca;

  container.innerHTML = `
    <div style="text-align:center; padding:30px; color:#64748b;">
      <i class="fa-solid fa-spinner fa-spin fa-2x"></i>
      <p style="margin-top:10px; font-size:13px;">Carregando propostas e orçamentos...</p>
    </div>
  `;

  try {
    const params = {
      p_busca: termoBuscaOrcamentoAtual || null,
      p_status: filtroStatusOrcamentoAtual === 'todos' ? null : filtroStatusOrcamentoAtual,
      p_limite: 100,
      p_offset: 0
    };

    const { data, error } = await supabaseClient.rpc('buscar_orcamentos_admin', params);

    if (error) throw error;

    orcamentosCache = data?.orcamentos || [];
    renderizarListaOrcamentos(orcamentosCache, data?.total || 0);
  } catch (err) {
    console.error('[Admin Orçamentos] Erro ao carregar orçamentos:', err);
    container.innerHTML = `
      <div style="text-align:center; padding:30px; color:#b91c1c; background:#fef2f2; border-radius:12px; border:1px solid #fecaca;">
        <i class="fa-solid fa-triangle-exclamation fa-2x"></i>
        <p style="margin-top:10px; font-weight:600;">Falha ao carregar orçamentos</p>
        <p style="font-size:12px; color:#7f1d1d;">${err.message || 'Erro inesperado'}</p>
        <button onclick="carregarOrcamentosAdmin()" class="btn-outline" style="margin-top:10px; padding:6px 14px; font-size:12px;">Tentar novamente</button>
      </div>
    `;
  }
}

/**
 * Renderiza os orçamentos na tela
 */
function renderizarListaOrcamentos(orcamentos, total) {
  const container = document.getElementById('orcamentos-lista-container');
  const contadorTotal = document.getElementById('orcamentos-total-contador');
  if (contadorTotal) contadorTotal.innerText = `${total} proposta(s)`;

  if (!orcamentos || orcamentos.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:50px 20px; background:#f8fafc; border-radius:14px; border:1px dashed #cbd5e1;">
        <i class="fa-solid fa-file-circle-question fa-3x" style="color:#94a3b8; margin-bottom:12px;"></i>
        <h4 style="margin:0 0 6px 0; color:#334155; font-size:16px;">Nenhum orçamento encontrado</h4>
        <p style="margin:0; font-size:13px; color:#64748b;">Nenhuma proposta comercial corresponde aos filtros atuais.</p>
        <button onclick="abrirModalNovoOrcamento()" class="btn-primary" style="margin-top:16px; padding:8px 18px; font-size:13px; border-radius:8px;">
          <i class="fa-solid fa-plus"></i> Criar Novo Orçamento
        </button>
      </div>
    `;
    return;
  }

  let html = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
        <thead>
          <tr style="border-bottom:2px solid #e2e8f0; color:#475569; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">
            <th style="padding:12px 10px;">Número</th>
            <th style="padding:12px 10px;">Cliente</th>
            <th style="padding:12px 10px;">Evento</th>
            <th style="padding:12px 10px;">Entrega</th>
            <th style="padding:12px 10px;">Total</th>
            <th style="padding:12px 10px;">Status</th>
            <th style="padding:12px 10px;">Validade</th>
            <th style="padding:12px 10px; text-align:right;">Ações</th>
          </tr>
        </thead>
        <tbody>
  `;

  orcamentos.forEach(orc => {
    const badgeStatus = obterBadgeStatusOrcamento(orc.status);
    const dataEventoFmt = formatarDataSimples(orc.data_evento);
    const horaEventoFmt = orc.hora_evento ? orc.hora_evento.slice(0, 5) : '';
    const totalFmt = formatarMoedaReal(orc.total);
    const dataValidadeFmt = formatarDataHoraRelativa(orc.validade_ate);

    html += `
      <tr style="border-bottom:1px solid #f1f5f9; transition:background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
        <td style="padding:12px 10px; font-weight:700; color:#1e293b;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span>${orc.numero}</span>
            ${orc.versao > 1 ? `<span style="font-size:10px; background:#e2e8f0; color:#475569; padding:1px 5px; border-radius:4px;">v${orc.versao}</span>` : ''}
          </div>
        </td>
        <td style="padding:12px 10px;">
          <div style="font-weight:600; color:#1e293b;">${escapeHtml(orc.cliente_nome)}</div>
          <div style="font-size:11px; color:#64748b;">${escapeHtml(orc.cliente_telefone || 'Sem telefone')}</div>
        </td>
        <td style="padding:12px 10px; color:#334155;">
          <div><i class="fa-regular fa-calendar" style="color:#64748b; margin-right:4px;"></i>${dataEventoFmt}</div>
          ${horaEventoFmt ? `<div style="font-size:11px; color:#64748b;"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${horaEventoFmt}</div>` : ''}
        </td>
        <td style="padding:12px 10px;">
          <span style="font-size:11px; padding:3px 8px; border-radius:6px; font-weight:600; background:${orc.tipo_entrega === 'entrega' ? '#e0f2fe; color:#0369a1;' : '#f1f5f9; color:#475569;'}">
            ${orc.tipo_entrega === 'entrega' ? '<i class="fa-solid fa-truck"></i> Entrega' : '<i class="fa-solid fa-store"></i> Retirada'}
          </span>
        </td>
        <td style="padding:12px 10px; font-weight:700; color:#0f172a;">
          ${totalFmt}
        </td>
        <td style="padding:12px 10px;">
          ${badgeStatus}
        </td>
        <td style="padding:12px 10px; font-size:12px; color:#64748b;">
          ${dataValidadeFmt}
        </td>
        <td style="padding:12px 10px; text-align:right;">
          <div style="display:inline-flex; gap:6px; align-items:center;">
            ${orc.status === 'aprovado' ? `
              <button onclick="abrirModalConverterOrcamento(${orc.id})" class="btn-primary" style="padding:5px 10px; font-size:11px; border-radius:6px; background:#16a34a; border:none; color:#fff;" title="Converter em Encomenda">
                <i class="fa-solid fa-check-double"></i> Converter
              </button>
            ` : ''}

            ${orc.status === 'rascunho' ? `
              <button onclick="marcarComoEnviadoOrcamento(${orc.id})" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px; color:#2563eb; border-color:#bfdbfe;" title="Marcar como Enviado">
                <i class="fa-solid fa-paper-plane"></i> Enviar
              </button>
            ` : ''}

            <button onclick="abrirEspelhoOrcamento(${orc.id}, 'comercial')" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px;" title="Espelho da Proposta">
              <i class="fa-solid fa-file-lines"></i>
            </button>

            <button onclick="abrirEspelhoOrcamento(${orc.id}, 'bancada')" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px;" title="Ficha de Bancada (Cozinha)">
              <i class="fa-solid fa-utensils"></i>
            </button>

            <button onclick="copiarLinkPublicoOrcamento('${orc.token_publico}')" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px;" title="Copiar Link de Aprovação do Cliente">
              <i class="fa-solid fa-link"></i>
            </button>

            <button onclick="compartilharWhatsAppOrcamento(${orc.id})" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px; color:#15803d; border-color:#bbf7d0;" title="Enviar pelo WhatsApp">
              <i class="fa-brands fa-whatsapp"></i>
            </button>

            ${orc.status !== 'convertido' ? `
              <button onclick="abrirModalNovoOrcamento(${orc.id})" class="btn-outline" style="padding:5px 8px; font-size:11px; border-radius:6px;" title="Editar Orçamento">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
}

/**
 * Retorna badge visual de status do orçamento
 */
function obterBadgeStatusOrcamento(status) {
  switch (status) {
    case 'rascunho':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#f1f5f9; color:#475569;">Rascunho</span>`;
    case 'enviado':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#dbeafe; color:#1e40af;">Enviado</span>`;
    case 'aprovado':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#dcfce7; color:#15803d;">Aprovado</span>`;
    case 'recusado':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#fee2e2; color:#b91c1c;">Recusado</span>`;
    case 'expirado':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#fef3c7; color:#b45309;">Expirado</span>`;
    case 'convertido':
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#ecfdf5; color:#047857; border:1px solid #a7f3d0;"><i class="fa-solid fa-check"></i> Convertido</span>`;
    default:
      return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#f1f5f9; color:#475569;">${escapeHtml(status || 'Desconhecido')}</span>`;
  }
}

/**
 * Abertura do Modal de Criação ou Edição de Orçamento
 */
async function abrirModalNovoOrcamento(orcamentoId = null) {
  const modal = document.getElementById('modal-novo-orcamento');
  if (!modal) return;

  orcamentoAtualEmEdicao = orcamentoId;
  const form = document.getElementById('form-novo-orcamento');
  if (form) form.reset();

  const titulo = document.getElementById('modal-orcamento-titulo');
  if (titulo) {
    titulo.innerHTML = orcamentoId
      ? '<i class="fa-solid fa-pen-to-square" style="color:var(--primary);"></i> Editar Orçamento'
      : '<i class="fa-solid fa-file-circle-plus" style="color:var(--primary);"></i> Novo Orçamento Comercial';
  }

  // Preenche data mínima do evento (amanhã por padrão)
  const dataInput = document.getElementById('orc-data-evento');
  if (dataInput && !orcamentoId) {
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    dataInput.value = amanha.toISOString().slice(0, 10);
  }

  // Limpa lista de itens dinâmicos
  const itensContainer = document.getElementById('orc-itens-container');
  if (itensContainer) itensContainer.innerHTML = '';

  if (orcamentoId) {
    await preencherFormularioOrcamento(orcamentoId);
  } else {
    // Adiciona primeira linha de item vazia
    adicionarLinhaItemOrcamento();
  }

  modal.style.display = 'flex';
  recalcularTotaisOrcamentoForm();
}

function fecharModalNovoOrcamento() {
  const modal = document.getElementById('modal-novo-orcamento');
  if (modal) modal.style.display = 'none';
  orcamentoAtualEmEdicao = null;
}

/**
 * Adiciona uma linha de produto ao formulário de orçamento
 */
function adicionarLinhaItemOrcamento(itemData = null) {
  const container = document.getElementById('orc-itens-container');
  if (!container) return;

  const idx = container.children.length;
  const row = document.createElement('div');
  row.className = 'orc-item-row';
  row.style.cssText = 'display:grid; grid-template-columns:3fr 1fr 1.5fr 1.5fr 36px; gap:10px; align-items:center; margin-bottom:10px; background:#f8fafc; padding:10px; border-radius:8px; border:1px solid #e2e8f0;';

  // Monta opções de produtos do catálogo
  let optionsProdutos = '<option value="">Selecione o produto...</option>';
  if (Array.isArray(produtosGlobal)) {
    produtosGlobal.filter(p => p.ativo).forEach(p => {
      const selected = (itemData && String(itemData.produto_id) === String(p.id)) ? 'selected' : '';
      optionsProdutos += `<option value="${p.id}" data-preco="${p.preco}" ${selected}>${escapeHtml(p.nome)} (R$ ${Number(p.preco).toFixed(2)})</option>`;
    });
  }

  row.innerHTML = `
    <div>
      <select class="orc-item-produto" onchange="onProdutoOrcamentoChange(this)" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px;">
        ${optionsProdutos}
      </select>
      <input type="text" class="orc-item-obs" placeholder="Observações de sabor / personalização..." value="${escapeHtml(itemData?.observacoes || '')}" style="width:100%; margin-top:6px; padding:6px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1; box-sizing:border-box;">
    </div>
    <div>
      <input type="number" class="orc-item-qtd" min="1" value="${itemData?.quantidade || 1}" oninput="recalcularTotaisOrcamentoForm()" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px; box-sizing:border-box;">
    </div>
    <div>
      <input type="number" step="0.01" class="orc-item-preco" value="${itemData?.preco_unitario_snapshot || 0.00}" oninput="recalcularTotaisOrcamentoForm()" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px; box-sizing:border-box;" readonly>
    </div>
    <div>
      <input type="text" class="orc-item-subtotal" value="R$ 0,00" readonly style="width:100%; padding:8px; border-radius:6px; border:1px solid #e2e8f0; font-size:13px; font-weight:700; background:#f1f5f9; box-sizing:border-box;">
    </div>
    <div style="text-align:right;">
      <button type="button" onclick="removerLinhaItemOrcamento(this)" style="background:none; border:none; color:#ef4444; font-size:16px; cursor:pointer;" title="Remover item">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;

  container.appendChild(row);
  recalcularTotaisOrcamentoForm();
}

function removerLinhaItemOrcamento(btn) {
  const row = btn.closest('.orc-item-row');
  if (row) {
    row.remove();
    recalcularTotaisOrcamentoForm();
  }
}

function onProdutoOrcamentoChange(select) {
  const row = select.closest('.orc-item-row');
  const precoInput = row.querySelector('.orc-item-preco');
  const opt = select.options[select.selectedIndex];
  if (opt && opt.dataset.preco) {
    precoInput.value = Number(opt.dataset.preco).toFixed(2);
  }
  recalcularTotaisOrcamentoForm();
}

/**
 * Recalcula subtotais e total do orçamento no formulário
 */
function recalcularTotaisOrcamentoForm() {
  const rows = document.querySelectorAll('.orc-item-row');
  let subtotal = 0;

  rows.forEach(row => {
    const qtd = Math.max(1, parseInt(row.querySelector('.orc-item-qtd')?.value || 1, 10));
    const preco = Math.max(0, parseFloat(row.querySelector('.orc-item-preco')?.value || 0));
    const sub = qtd * preco;
    subtotal += sub;
    const subField = row.querySelector('.orc-item-subtotal');
    if (subField) subField.value = formatarMoedaReal(sub);
  });

  const descontoInput = document.getElementById('orc-desconto');
  const desconto = Math.max(0, parseFloat(descontoInput?.value || 0));

  const modalidade = document.getElementById('orc-modalidade')?.value || 'retirada';
  const taxaInput = document.getElementById('orc-taxa-entrega');
  const taxa = modalidade === 'entrega' ? Math.max(0, parseFloat(taxaInput?.value || 0)) : 0;

  const total = Math.max(0, (subtotal - desconto) + taxa);
  const sinalSugerido = Math.round((total * 0.50) * 100) / 100;

  const subLabel = document.getElementById('orc-form-subtotal');
  const totalLabel = document.getElementById('orc-form-total');
  const sinalLabel = document.getElementById('orc-form-sinal');

  if (subLabel) subLabel.innerText = formatarMoedaReal(subtotal);
  if (totalLabel) totalLabel.innerText = formatarMoedaReal(total);
  if (sinalLabel) sinalLabel.innerText = formatarMoedaReal(sinalSugerido);
}

/**
 * Submete o formulário de criação/edição do orçamento via RPC segura
 */
async function submeterOrcamentoAdmin() {
  const btn = document.getElementById('btn-salvar-orcamento');
  if (btn) btn.disabled = true;

  try {
    const clienteNome = document.getElementById('orc-cliente-nome')?.value?.trim();
    const clienteTel = document.getElementById('orc-cliente-tel')?.value?.trim();
    const clienteEmail = document.getElementById('orc-cliente-email')?.value?.trim();
    const dataEvento = document.getElementById('orc-data-evento')?.value;
    const horaEvento = document.getElementById('orc-hora-evento')?.value || '14:00';
    const modalidade = document.getElementById('orc-modalidade')?.value || 'retirada';
    const endereco = document.getElementById('orc-endereco')?.value?.trim();
    const taxaEntrega = parseFloat(document.getElementById('orc-taxa-entrega')?.value || 0);
    const desconto = parseFloat(document.getElementById('orc-desconto')?.value || 0);
    const motivoDesconto = document.getElementById('orc-motivo-desconto')?.value?.trim();
    const obsCliente = document.getElementById('orc-obs-cliente')?.value?.trim();
    const obsInternas = document.getElementById('orc-obs-internas')?.value?.trim();

    if (!clienteNome) throw new Error('Nome do cliente é obrigatório.');
    if (!dataEvento) throw new Error('Data do evento é obrigatória.');

    // Monta array de itens
    const rows = document.querySelectorAll('.orc-item-row');
    const itens = [];
    rows.forEach(row => {
      const prodId = row.querySelector('.orc-item-produto')?.value;
      const qtd = parseInt(row.querySelector('.orc-item-qtd')?.value || 1, 10);
      const obs = row.querySelector('.orc-item-obs')?.value?.trim();
      if (prodId) {
        itens.push({
          id: parseInt(prodId, 10),
          quantidade: qtd,
          observacoes: obs || null,
          opcoes: []
        });
      }
    });

    if (itens.length === 0) throw new Error('Adicione pelo menos um produto ao orçamento.');

    const payload = {
      id: orcamentoAtualEmEdicao || null,
      cliente_nome: clienteNome,
      cliente_telefone: clienteTel || null,
      cliente_email: clienteEmail || null,
      data_evento: dataEvento,
      hora_evento: horaEvento,
      tipo_entrega: modalidade,
      endereco_entrega: modalidade === 'entrega' ? endereco : null,
      taxa_entrega: modalidade === 'entrega' ? taxaEntrega : 0.00,
      desconto: desconto,
      motivo_desconto: motivoDesconto || null,
      observacoes_cliente: obsCliente || null,
      observacoes_internas: obsInternas || null,
      itens: itens
    };

    const { data, error } = await supabaseClient.rpc('criar_ou_atualizar_orcamento_admin', { p_dados: payload });

    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao salvar orçamento');

    mostrarToast('Orçamento salvo com sucesso!', 'sucesso');
    fecharModalNovoOrcamento();
    await carregarOrcamentosAdmin();

  } catch (err) {
    console.error('[Admin Orçamentos] Erro ao salvar orçamento:', err);
    mostrarToast(err.message || 'Erro ao processar orçamento.', 'erro');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Preenche o formulário ao editar orçamento existente
 */
async function preencherFormularioOrcamento(id) {
  try {
    const { data: orc, error } = await supabaseClient
      .from('orcamentos')
      .select('*, orcamento_itens(*)')
      .eq('id', id)
      .single();

    if (error) throw error;

    document.getElementById('orc-cliente-nome').value = orc.cliente_nome || '';
    document.getElementById('orc-cliente-tel').value = orc.cliente_telefone || '';
    document.getElementById('orc-cliente-email').value = orc.cliente_email || '';
    document.getElementById('orc-data-evento').value = orc.data_evento || '';
    document.getElementById('orc-hora-evento').value = orc.hora_evento ? orc.hora_evento.slice(0, 5) : '14:00';
    document.getElementById('orc-modalidade').value = orc.tipo_entrega || 'retirada';
    document.getElementById('orc-endereco').value = orc.endereco_entrega || '';
    document.getElementById('orc-taxa-entrega').value = orc.taxa_entrega_cobrada || '0.00';
    document.getElementById('orc-desconto').value = orc.desconto_produtos || '0.00';
    document.getElementById('orc-motivo-desconto').value = orc.motivo_desconto || '';
    document.getElementById('orc-obs-cliente').value = orc.observacoes_cliente || '';
    document.getElementById('orc-obs-internas').value = orc.observacoes_internas || '';

    toggleEnderecoEntregaOrcamento();

    const itensContainer = document.getElementById('orc-itens-container');
    if (itensContainer) itensContainer.innerHTML = '';

    if (Array.isArray(orc.orcamento_itens)) {
      orc.orcamento_itens.forEach(it => adicionarLinhaItemOrcamento(it));
    }

    recalcularTotaisOrcamentoForm();
  } catch (err) {
    console.error('[Admin Orçamentos] Erro ao preencher formulário:', err);
    mostrarToast('Falha ao carregar dados do orçamento: ' + err.message, 'erro');
  }
}

function toggleEnderecoEntregaOrcamento() {
  const mod = document.getElementById('orc-modalidade')?.value;
  const grupoEnd = document.getElementById('orc-grupo-endereco');
  const grupoTaxa = document.getElementById('orc-grupo-taxa');
  if (grupoEnd) grupoEnd.style.display = (mod === 'entrega') ? 'block' : 'none';
  if (grupoTaxa) grupoTaxa.style.display = (mod === 'entrega') ? 'block' : 'none';
  recalcularTotaisOrcamentoForm();
}

/**
 * Transição administrativa para 'enviado'
 */
async function marcarComoEnviadoOrcamento(id) {
  if (!confirm('Deseja marcar este orçamento como ENVIADO ao cliente?')) return;

  try {
    const { data, error } = await supabaseClient.rpc('alterar_status_orcamento_admin', {
      p_orcamento_id: id,
      p_novo_status: 'enviado',
      p_motivo: 'Envio formal da proposta ao cliente'
    });

    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao alterar status');

    mostrarToast('Orçamento marcado como Enviado!', 'sucesso');
    await carregarOrcamentosAdmin();
  } catch (err) {
    console.error('[Admin Orçamentos] Erro ao enviar orçamento:', err);
    mostrarToast(err.message || 'Erro ao alterar status.', 'erro');
  }
}

/**
 * Modal de Conversão de Orçamento em Encomenda
 */
async function abrirModalConverterOrcamento(id) {
  const modal = document.getElementById('modal-converter-orcamento');
  if (!modal) return;

  const orc = orcamentosCache.find(o => o.id === id);
  if (!orc) return;

  document.getElementById('conv-orcamento-id').value = id;
  document.getElementById('conv-resumo-numero').innerText = `${orc.numero} (v${orc.versao})`;
  document.getElementById('conv-resumo-cliente').innerText = orc.cliente_nome;
  document.getElementById('conv-resumo-evento').innerText = `${formatarDataSimples(orc.data_evento)} às ${orc.hora_evento ? orc.hora_evento.slice(0, 5) : '12:00'}`;
  document.getElementById('conv-resumo-total').innerText = formatarMoedaReal(orc.total);
  document.getElementById('conv-resumo-sinal').innerText = formatarMoedaReal(orc.sinal_sugerido);

  const sinalInput = document.getElementById('conv-sinal-valor');
  if (sinalInput) sinalInput.value = orc.sinal_sugerido || 0.00;

  modal.style.display = 'flex';
}

function fecharModalConverterOrcamento() {
  const modal = document.getElementById('modal-converter-orcamento');
  if (modal) modal.style.display = 'none';
}

/**
 * Confirmação da conversão atômica via RPC
 */
async function submeterConversaoOrcamento() {
  const btn = document.getElementById('btn-confirmar-conversao');
  if (btn) btn.disabled = true;

  try {
    const id = parseInt(document.getElementById('conv-orcamento-id')?.value, 10);
    const sinalValor = parseFloat(document.getElementById('conv-sinal-valor')?.value || 0);
    const sinalMetodo = document.getElementById('conv-sinal-metodo')?.value || 'pix';
    const forcarSemSinal = document.getElementById('conv-forcar-sem-sinal')?.checked || false;
    const motivoSemSinal = document.getElementById('conv-motivo-sem-sinal')?.value?.trim();
    const forcarEncaixe = document.getElementById('conv-forcar-encaixe')?.checked || false;
    const motivoEncaixe = document.getElementById('conv-motivo-encaixe')?.value?.trim();

    const complementares = {
      sinal_valor: sinalValor,
      sinal_metodo: sinalMetodo,
      forcar_confirmacao_sem_sinal: forcarSemSinal,
      motivo_confirmacao_sem_sinal: motivoSemSinal || null,
      forcar_encaixe: forcarEncaixe,
      motivo_encaixe: motivoEncaixe || null
    };

    const { data, error } = await supabaseClient.rpc('converter_orcamento_em_pedido_admin', {
      p_orcamento_id: id,
      p_dados_complementares: complementares
    });

    if (error) throw error;
    if (data?.success === false) {
      if (data.code === 'PRODUCTION_CAPACITY_EXCEEDED') {
        throw new Error(`Capacidade da data excedida (${data.error}). Para forçar o encaixe, um Administrador deve marcar a opção de encaixe com justificativa.`);
      }
      if (data.code === 'INSUFFICIENT_STOCK') {
        throw new Error(`Estoque insuficiente: ${data.error}`);
      }
      throw new Error(data.error || 'Erro na conversão comercial.');
    }

    fecharModalConverterOrcamento();
    mostrarToast(`Orçamento convertido com sucesso em Encomenda #${data.pedido_id}!`, 'sucesso', 5000);
    await carregarOrcamentosAdmin();

  } catch (err) {
    console.error('[Admin Orçamentos] Erro na conversão:', err);
    mostrarToast(err.message || 'Falha ao converter orçamento.', 'erro', 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Modal Espelho / Impressão (@media print)
 */
async function abrirEspelhoOrcamento(id, tipo = 'comercial') {
  const modal = document.getElementById('modal-espelho-orcamento');
  if (!modal) return;

  const container = document.getElementById('espelho-orcamento-conteudo');
  container.innerHTML = `<div style="text-align:center; padding:30px;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div>`;
  modal.style.display = 'flex';

  try {
    const { data: orc, error } = await supabaseClient
      .from('orcamentos')
      .select('*, orcamento_itens(*, orcamento_item_opcoes(*))')
      .eq('id', id)
      .single();

    if (error) throw error;

    orcamentoAtualEspelho = orc;
    renderizarEspelhoDocumento(orc, tipo);
  } catch (err) {
    console.error('[Admin Orçamentos] Erro ao carregar espelho:', err);
    container.innerHTML = `<div style="color:#b91c1c; padding:20px;">Falha ao carregar espelho: ${err.message}</div>`;
  }
}

function fecharModalEspelhoOrcamento() {
  const modal = document.getElementById('modal-espelho-orcamento');
  if (modal) modal.style.display = 'none';
  orcamentoAtualEspelho = null;
}

function alternarTipoEspelho(tipo) {
  if (orcamentoAtualEspelho) {
    renderizarEspelhoDocumento(orcamentoAtualEspelho, tipo);
  }
}

function renderizarEspelhoDocumento(orc, tipo) {
  const container = document.getElementById('espelho-orcamento-conteudo');
  const btnCom = document.getElementById('btn-espelho-tipo-comercial');
  const btnBan = document.getElementById('btn-espelho-tipo-bancada');

  if (btnCom) btnCom.className = tipo === 'comercial' ? 'btn-primary' : 'btn-outline';
  if (btnBan) btnBan.className = tipo === 'bancada' ? 'btn-primary' : 'btn-outline';

  const dataFmt = formatarDataSimples(orc.data_evento);
  const horaFmt = orc.hora_evento ? orc.hora_evento.slice(0, 5) : '12:00';
  const hojeFmt = new Date().toLocaleDateString('pt-BR');

  if (tipo === 'bancada') {
    // FICHA DE BANCADA (COZINHA/PRODUÇÃO) - SEM VALORES FINANCEIROS
    let html = `
      <div class="folha-impressao ficha-bancada" style="background:#fff; color:#0f172a; padding:20px; font-family:sans-serif;">
        <div style="border-bottom:2px solid #0f172a; padding-bottom:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:flex-end;">
          <div>
            <h1 style="margin:0; font-size:22px; text-transform:uppercase; letter-spacing:1px; font-weight:800;">FICHA DE BANCADA • PRODUÇÃO</h1>
            <div style="font-size:13px; color:#475569; margin-top:4px;">Lunoca Confeitaria Artesanal</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:20px; font-weight:800; color:#0f172a;">${orc.numero}</div>
            <div style="font-size:11px; color:#64748b;">Emissão: ${hojeFmt}</div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; padding:12px; margin-bottom:18px;">
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Data e Horário do Evento</div>
            <div style="font-size:16px; font-weight:800; color:#0f172a; margin-top:2px;">${dataFmt} às ${horaFmt}</div>
          </div>
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Modalidade</div>
            <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">
              ${orc.tipo_entrega === 'entrega' ? `ENTREGA: ${escapeHtml(orc.endereco_entrega || 'Endereço não informado')}` : 'RETIRADA NO BALCÃO'}
            </div>
          </div>
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Cliente</div>
            <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">${escapeHtml(orc.cliente_nome)}</div>
          </div>
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Telefone de Contato</div>
            <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">${escapeHtml(orc.cliente_telefone || 'Sem telefone')}</div>
          </div>
        </div>

        <h3 style="font-size:14px; text-transform:uppercase; border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin:16px 0 10px 0;">Itens a Confeccionar / Montar</h3>
        <table style="width:100%; border-collapse:collapse; margin-bottom:20px; font-size:13px;">
          <thead>
            <tr style="background:#f1f5f9; border-bottom:2px solid #cbd5e1; text-align:left;">
              <th style="padding:10px; width:70px; text-align:center;">QTD</th>
              <th style="padding:10px;">PRODUTO</th>
              <th style="padding:10px;">ESPECIFICAÇÕES / SABORES / OPÇÕES</th>
              <th style="padding:10px;">OBSERVAÇÕES</th>
            </tr>
          </thead>
          <tbody>
    `;

    (orc.orcamento_itens || []).forEach(it => {
      const prodNome = encontrarNomeProduto(it.produto_id);
      const opcoesTxt = (it.orcamento_item_opcoes || []).map(o => o.opcao_nome).join(', ') || 'Padrão';
      html += `
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:12px 10px; text-align:center; font-size:18px; font-weight:800; background:#f8fafc; border-right:1px solid #e2e8f0;">${it.quantidade}x</td>
          <td style="padding:12px 10px; font-weight:700; font-size:14px;">${escapeHtml(prodNome)}</td>
          <td style="padding:12px 10px; color:#334155;">${escapeHtml(opcoesTxt)}</td>
          <td style="padding:12px 10px; color:#475569; font-style:italic;">${escapeHtml(it.observacoes || '-')}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>

        ${orc.observacoes_cliente ? `
          <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px; margin-bottom:16px;">
            <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#b45309;">Observações do Cliente / Decoração</div>
            <div style="font-size:13px; color:#78350f; margin-top:4px;">${escapeHtml(orc.observacoes_cliente)}</div>
          </div>
        ` : ''}

        <div style="margin-top:30px; padding-top:10px; border-top:1px dashed #cbd5e1; display:flex; justify-content:space-between; font-size:11px; color:#64748b;">
          <div>Lunoca Confeitaria Artesanal • Ordem de Serviço de Bancada</div>
          <div>Conferido por: _____________________________ Data: ___/___/___</div>
        </div>
      </div>
    `;
    container.innerHTML = html;
  } else {
    // ESPELHO COMERCIAL / PROPOSTA FORMAL (COM VALORES, SINAL SUGERIDO E TERMOS)
    const subtotalFmt = formatarMoedaReal(orc.subtotal);
    const descontoFmt = formatarMoedaReal(orc.desconto_produtos);
    const freteFmt = formatarMoedaReal(orc.taxa_entrega_cobrada);
    const totalFmt = formatarMoedaReal(orc.total);
    const sinalFmt = formatarMoedaReal(orc.sinal_sugerido);
    const saldoFmt = formatarMoedaReal(orc.total - orc.sinal_sugerido);
    const pctSinal = orc.total > 0 ? Math.round((orc.sinal_sugerido / orc.total) * 100) : 50;

    let html = `
      <div class="folha-impressao espelho-comercial" style="background:#fff; color:#0f172a; padding:20px; font-family:sans-serif;">
        <div style="border-bottom:2px solid var(--primary); padding-bottom:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:flex-end;">
          <div>
            <h1 style="margin:0; font-size:24px; color:var(--primary); font-family:var(--font-title); font-weight:800;">Lunoca Doceria</h1>
            <div style="font-size:13px; color:#475569; margin-top:2px;">Proposta Comercial & Orçamento</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:18px; font-weight:800; color:#0f172a;">${orc.numero} <span style="font-size:12px; color:#64748b;">(v${orc.versao})</span></div>
            <div style="font-size:11px; color:#64748b;">Válido até: ${formatarDataHoraRelativa(orc.validade_ate)}</div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px; margin-bottom:18px;">
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Cliente</div>
            <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">${escapeHtml(orc.cliente_nome)}</div>
            <div style="font-size:12px; color:#64748b;">${escapeHtml(orc.cliente_telefone || '')}</div>
          </div>
          <div>
            <div style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">Data do Evento</div>
            <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">${dataFmt} às ${horaFmt}</div>
            <div style="font-size:12px; color:#64748b;">Modalidade: ${orc.tipo_entrega === 'entrega' ? 'Entrega em domicílio' : 'Retirada no balcão'}</div>
          </div>
        </div>

        <table style="width:100%; border-collapse:collapse; margin-bottom:20px; font-size:13px;">
          <thead>
            <tr style="background:#f1f5f9; border-bottom:2px solid #cbd5e1; text-align:left;">
              <th style="padding:10px;">Item</th>
              <th style="padding:10px; text-align:center;">Qtd</th>
              <th style="padding:10px; text-align:right;">Preço Unit.</th>
              <th style="padding:10px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
    `;

    (orc.orcamento_itens || []).forEach(it => {
      const prodNome = encontrarNomeProduto(it.produto_id);
      const opcoesTxt = (it.orcamento_item_opcoes || []).map(o => o.opcao_nome).join(', ');
      html += `
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:10px;">
            <div style="font-weight:700; color:#0f172a;">${escapeHtml(prodNome)}</div>
            ${opcoesTxt ? `<div style="font-size:11px; color:#64748b;">Opções: ${escapeHtml(opcoesTxt)}</div>` : ''}
            ${it.observacoes ? `<div style="font-size:11px; color:#64748b; font-style:italic;">Obs: ${escapeHtml(it.observacoes)}</div>` : ''}
          </td>
          <td style="padding:10px; text-align:center; font-weight:600;">${it.quantidade}</td>
          <td style="padding:10px; text-align:right; color:#475569;">${formatarMoedaReal(it.preco_unitario_snapshot)}</td>
          <td style="padding:10px; text-align:right; font-weight:700; color:#0f172a;">${formatarMoedaReal(it.subtotal)}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>

        <div style="display:flex; justify-content:flex-end; margin-bottom:20px;">
          <div style="width:280px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px; font-size:13px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#475569;">
              <span>Subtotal:</span>
              <span>${subtotalFmt}</span>
            </div>
            ${orc.desconto_produtos > 0 ? `
              <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#16a34a; font-weight:600;">
                <span>Desconto concedido:</span>
                <span>-${descontoFmt}</span>
              </div>
            ` : ''}
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#475569;">
              <span>Frete / Taxa de Entrega:</span>
              <span>${freteFmt}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding-top:8px; border-top:2px solid #cbd5e1; font-size:16px; font-weight:800; color:#0f172a;">
              <span>Total da Proposta:</span>
              <span style="color:var(--primary);">${totalFmt}</span>
            </div>
          </div>
        </div>

        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px; margin-bottom:20px; font-size:12px; color:#1e40af;">
          <div style="font-weight:700; margin-bottom:4px; text-transform:uppercase; font-size:11px;">Condições de Pagamento e Reserva de Data</div>
          <div>• <strong>Sinal de Confirmação:</strong> ${sinalFmt} (${pctSinal}% do valor total da encomenda) no ato da contratação.</div>
          <div>• <strong>Saldo Restante:</strong> ${saldoFmt} a ser quitado na entrega/retirada.</div>
          <div style="margin-top:4px; font-size:11px; color:#3b82f6;">* A reserva da data e o início da produção estão sujeitos à aprovação formal e confirmação do pagamento do sinal.</div>
        </div>

        <div style="font-size:11px; color:#64748b; line-height:1.5; border-top:1px solid #e2e8f0; padding-top:10px;">
          <strong>Lunoca Doceria Artesanal</strong> • Contato: (88) 99999-9999 • Juazeiro do Norte - CE<br>
          Esta proposta foi gerada eletronicamente e possui validade operacional limitada.
        </div>
      </div>
    `;
    container.innerHTML = html;
  }
}

function imprimirEspelhoAtual() {
  window.print();
}

/**
 * Copia link de aprovação pública do cliente
 */
function copiarLinkPublicoOrcamento(token) {
  if (!token) return;
  const url = `${window.location.origin}/orcamento.html?t=${token}`;
  navigator.clipboard.writeText(url).then(() => {
    mostrarToast('Link de aprovação copiado para a área de transferência!', 'sucesso');
  }).catch(() => {
    prompt('Copie o link abaixo:', url);
  });
}

/**
 * Envia proposta formatada pelo WhatsApp
 */
async function compartilharWhatsAppOrcamento(id) {
  const orc = orcamentosCache.find(o => o.id === id);
  if (!orc) return;

  const tel = (orc.cliente_telefone || '').replace(/\D/g, '');
  if (!tel) {
    alert('Cliente sem telefone cadastrado.');
    return;
  }

  const link = `${window.location.origin}/orcamento.html?t=${orc.token_publico}`;
  const totalFmt = formatarMoedaReal(orc.total);
  const dataFmt = formatarDataSimples(orc.data_evento);

  const msg = `Olá, *${orc.cliente_nome}*! Tudo bem? Aqui é da Lunoca Doceria 🍰\n\nPreparamos com muito carinho a sua proposta comercial (*${orc.numero}*):\n\n📅 *Data do Evento:* ${dataFmt}\n💰 *Valor Total:* ${totalFmt}\n\nVocê pode conferir todos os detalhes dos doces e aprovar sua proposta no link seguro abaixo:\n👉 ${link}\n\nFicamos à disposição para qualquer ajuste!`;

  try {
    await supabaseClient.rpc('registrar_comunicacao_orcamento_admin', {
      p_orcamento_id: id,
      p_canal: 'whatsapp_link',
      p_tipo: 'envio_proposta',
      p_destinatario: tel,
      p_mensagem: msg
    });
  } catch (e) {
    console.warn('[Admin Orçamentos] Falha ao registrar log de comunicação:', e);
  }

  const urlZap = `https://wa.me/55${tel}?text=${encodeURIComponent(msg)}`;
  window.open(urlZap, '_blank');
}

/**
 * Helpers utilitários
 */
function formatarDataSimples(dataStr) {
  if (!dataStr) return '-';
  const partes = dataStr.split('-');
  if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
  return dataStr;
}

function formatarDataHoraRelativa(tsStr) {
  if (!tsStr) return '-';
  const d = new Date(tsStr);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatarMoedaReal(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function encontrarNomeProduto(prodId) {
  if (Array.isArray(produtosGlobal)) {
    const p = produtosGlobal.find(x => String(x.id) === String(prodId));
    if (p) return p.nome;
  }
  return `Produto #${prodId}`;
}

function escapeHtml(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
