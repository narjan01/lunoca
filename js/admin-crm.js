// ==========================================================================
// LUNOCA DOCERIA - Módulo Administrativo: CRM & Histórico 360° do Cliente (Frente D)
// ==========================================================================

var crmClienteSelecionadoId = null;
var crmDadosClienteCache = null;
var crmDebounceTimer = null;

/**
 * Inicialização da aba CRM
 */
function carregarCRMAdmin() {
  const inputBusca = document.getElementById('crm-busca-input');
  if (inputBusca && inputBusca.value.trim().length >= 2) {
    executarBuscaCRM();
  } else if (!crmClienteSelecionadoId) {
    // Busca inicial rápida dos clientes mais recentes
    executarBuscaCRM('');
  }
}

/**
 * Handler de digitação com debounce
 */
function onBuscarClienteCRMKeyup(event) {
  if (event.key === 'Enter') {
    clearTimeout(crmDebounceTimer);
    executarBuscaCRM();
    return;
  }
  clearTimeout(crmDebounceTimer);
  crmDebounceTimer = setTimeout(() => {
    executarBuscaCRM();
  }, 350);
}

/**
 * Executa busca rápida de clientes chamando a RPC buscar_clientes_crm
 */
async function executarBuscaCRM(termoForcado = null) {
  const container = document.getElementById('crm-busca-resultados');
  const inputBusca = document.getElementById('crm-busca-input');
  if (!container) return;

  const termo = termoForcado !== null ? termoForcado : (inputBusca ? inputBusca.value.trim() : '');

  container.innerHTML = `
    <div style="text-align:center; padding:20px; color:#64748b; font-size:13px;">
      <i class="fa-solid fa-spinner fa-spin" style="color:var(--primary); margin-right:8px;"></i>
      Buscando clientes...
    </div>
  `;

  try {
    const { data, error } = await supabaseClient.rpc('buscar_clientes_crm', {
      p_termo: termo || null,
      p_limite: 20
    });

    if (error) throw error;

    const clientes = data?.clientes || [];
    renderizarResultadosBuscaCRM(clientes, termo);
  } catch (err) {
    console.error('[CRM] Erro ao buscar clientes:', err);
    container.innerHTML = `
      <div style="padding:14px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px; color:#991b1b; font-size:13px;">
        <i class="fa-solid fa-circle-exclamation" style="margin-right:6px;"></i>
        Erro ao buscar clientes: ${escapeHtml(err.message || 'Falha na comunicação')}
      </div>
    `;
  }
}

/**
 * Renderiza resultados da busca de clientes
 */
function renderizarResultadosBuscaCRM(clientes, termo) {
  const container = document.getElementById('crm-busca-resultados');
  if (!container) return;

  if (!clientes || clientes.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:24px; color:#64748b; background:#f8fafc; border-radius:12px; border:1px dashed #cbd5e1;">
        <i class="fa-solid fa-user-slash fa-2x" style="color:#94a3b8; margin-bottom:8px; display:block;"></i>
        <strong style="display:block; color:#334155;">Nenhum cliente encontrado</strong>
        <span style="font-size:12px;">Tente buscar por outro termo, nome, telefone ou e-mail.</span>
      </div>
    `;
    return;
  }

  let html = `
    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; margin-bottom:16px;">
  `;

  clientes.forEach(c => {
    const isAtivo = crmClienteSelecionadoId === c.id;
    const borderCor = isAtivo ? 'var(--primary)' : '#e2e8f0';
    const bgCor = isAtivo ? '#fffbf7' : '#ffffff';
    const telFormatado = c.telefone ? escapeHtml(c.telefone) : 'Sem telefone';
    const totalPeds = c.total_pedidos || 0;
    const ultPed = c.ultimo_pedido ? new Date(c.ultimo_pedido).toLocaleDateString('pt-BR') : 'Nenhum';

    html += `
      <div style="background:${bgCor}; border:1.5px solid ${borderCor}; border-radius:12px; padding:14px; box-shadow:0 1px 3px rgba(0,0,0,0.03); display:flex; flex-direction:column; justify-content:space-between; transition:all 0.15s ease;">
        <div>
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
            <strong style="color:#1e293b; font-size:14px;">${escapeHtml(c.nome)}</strong>
            <span style="font-size:11px; font-weight:700; background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:10px;">
              ${totalPeds} ped.
            </span>
          </div>
          <div style="font-size:12px; color:#64748b; margin-bottom:3px;">
            <i class="fa-solid fa-phone" style="font-size:10px; width:14px;"></i> ${telFormatado}
          </div>
          <div style="font-size:12px; color:#64748b; margin-bottom:6px;">
            <i class="fa-solid fa-envelope" style="font-size:10px; width:14px;"></i> ${escapeHtml(c.email || 'Sem e-mail')}
          </div>
          <div style="font-size:11px; color:#94a3b8;">
            Último pedido: <strong>${ultPed}</strong>
          </div>
        </div>
        <div style="margin-top:12px; display:flex; gap:6px;">
          <button onclick="abrirFicha360Cliente(${c.id})" class="btn-primary" style="flex:1; padding:7px 10px; font-size:12px; border-radius:8px; display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;">
            <i class="fa-solid fa-address-card"></i> Ver Ficha 360°
          </button>
          ${c.telefone ? `
            <button onclick="crmAbrirWhatsApp(${c.id}, '${escapeHtml(c.telefone || '')}', '${escapeHtml(c.nome || '')}')" class="btn-outline" style="padding:7px 10px; font-size:12px; border-radius:8px; color:#16a34a; border-color:#bbf7d0; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Conversar no WhatsApp">
              <i class="fa-brands fa-whatsapp"></i>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

/**
 * Carrega e exibe a Ficha 360° do Cliente via RPC obter_cliente_360_admin
 */
async function abrirFicha360Cliente(clienteId) {
  crmClienteSelecionadoId = clienteId;
  const containerFicha = document.getElementById('crm-ficha-360-container');
  if (!containerFicha) return;

  containerFicha.style.display = 'block';
  containerFicha.innerHTML = `
    <div style="text-align:center; padding:40px; color:#64748b; background:#fff; border-radius:16px; border:1px solid #e2e8f0;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:12px;"></i>
      <p style="font-size:14px; font-weight:600; color:#334155;">Carregando Ficha 360° do Cliente...</p>
    </div>
  `;

  // Rola suavemente até o container da ficha
  containerFicha.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const { data, error } = await supabaseClient.rpc('obter_cliente_360_admin', {
      p_cliente_id: clienteId,
      p_timeline_limite: 50,
      p_timeline_offset: 0
    });

    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao obter dados do cliente');

    crmDadosClienteCache = data;
    renderizarFicha360Completa(data);

    // Atualiza destaque na lista de busca
    if (document.getElementById('crm-busca-resultados')) {
      const inputBusca = document.getElementById('crm-busca-input');
      const termo = inputBusca ? inputBusca.value.trim() : '';
      if (termo) executarBuscaCRM(termo);
    }
  } catch (err) {
    console.error('[CRM] Erro ao abrir ficha 360°:', err);
    containerFicha.innerHTML = `
      <div style="padding:24px; background:#fef2f2; border:1px solid #fecaca; border-radius:14px; color:#991b1b;">
        <h4 style="margin:0 0 8px; font-size:16px;"><i class="fa-solid fa-triangle-exclamation"></i> Falha ao Carregar Ficha 360°</h4>
        <p style="margin:0 0 12px; font-size:13px;">${escapeHtml(err.message || 'Acesso negado ou erro interno')}</p>
        <button onclick="fecharFicha360Cliente()" class="btn-outline" style="padding:6px 14px; font-size:12px; border-radius:8px;">Voltar</button>
      </div>
    `;
  }
}

/**
 * Fecha a visualização da ficha 360°
 */
function fecharFicha360Cliente() {
  crmClienteSelecionadoId = null;
  crmDadosClienteCache = null;
  const containerFicha = document.getElementById('crm-ficha-360-container');
  if (containerFicha) containerFicha.style.display = 'none';
}

/**
 * Renderiza todo o conteúdo da Ficha 360°
 */
function renderizarFicha360Completa(res) {
  const container = document.getElementById('crm-ficha-360-container');
  if (!container) return;

  const c = res.cliente;
  const m = res.metricas;
  const tags = res.tags || [];
  const preferencias = res.preferencias || [];
  const notas = res.notas || [];
  const timeline = res.timeline || [];

  const telFormatado = c.telefone || 'Não informado';
  const telLink = c.telefone_normalizado || (c.telefone ? c.telefone.replace(/\D/g, '') : '');
  const cpfExibido = c.cpf || 'Não informado';
  const dataCadastro = c.created_at ? new Date(c.created_at).toLocaleDateString('pt-BR') : '--';

  // Formatação segura de moeda
  const fmtMoeda = val => 'R$ ' + Number(val || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let html = `
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:16px; padding:20px; box-shadow:0 4px 15px rgba(0,0,0,0.03); margin-bottom:24px;">
      
      <!-- Cabeçalho do Cliente -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:14px; border-bottom:1px solid #f1f5f9; padding-bottom:16px; margin-bottom:18px;">
        <div style="display:flex; align-items:center; gap:14px;">
          <div style="width:52px; height:52px; border-radius:50%; background:var(--primary); color:#fff; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700;">
            ${escapeHtml((c.nome || 'C').charAt(0).toUpperCase())}
          </div>
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <h3 style="margin:0; font-size:20px; font-weight:800; color:#1e293b;">${escapeHtml(c.nome)}</h3>
              <span style="font-size:11px; background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:12px; font-weight:700;">Cliente #${c.id}</span>
            </div>
            <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:4px; font-size:12px; color:#64748b;">
              <span><i class="fa-solid fa-phone" style="color:var(--primary);"></i> ${escapeHtml(telFormatado)}</span>
              <span><i class="fa-solid fa-envelope" style="color:var(--primary);"></i> ${escapeHtml(c.email || 'Sem e-mail')}</span>
              <span><i class="fa-solid fa-id-card" style="color:var(--primary);"></i> CPF: <strong>${escapeHtml(cpfExibido)}</strong></span>
              <span><i class="fa-regular fa-calendar" style="color:var(--primary);"></i> Desde: ${dataCadastro}</span>
            </div>
          </div>
        </div>

        <!-- Ações Rápidas no Cliente -->
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${telLink ? `
            <button onclick="crmAbrirWhatsApp(${c.id}, '${escapeHtml(c.telefone || '')}', '${escapeHtml(c.nome || '')}')" class="btn-primary" style="background:#25D366; border:none; padding:8px 14px; font-size:12px; border-radius:10px; display:inline-flex; align-items:center; gap:6px; color:#fff; cursor:pointer; font-weight:600;" title="Abrir comunicação WhatsApp com auditoria">
              <i class="fa-brands fa-whatsapp"></i> Conversar no WhatsApp
            </button>
          ` : ''}
          <button onclick="crmCriarEncomendaRapida(${c.id})" class="btn-primary" style="padding:8px 14px; font-size:12px; border-radius:10px; display:inline-flex; align-items:center; gap:6px; cursor:pointer;" title="Lançar pedido com dados deste cliente">
            <i class="fa-solid fa-plus"></i> Nova Encomenda
          </button>
          <button onclick="crmCriarOrcamentoRapido(${c.id})" class="btn-outline" style="padding:8px 14px; font-size:12px; border-radius:10px; display:inline-flex; align-items:center; gap:6px; cursor:pointer;" title="Lançar orçamento para este cliente">
            <i class="fa-solid fa-file-invoice-dollar"></i> Novo Orçamento
          </button>
          <button onclick="fecharFicha360Cliente()" class="btn-outline" style="padding:8px 12px; font-size:12px; border-radius:10px; color:#64748b;" title="Fechar ficha">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>

      <!-- Barra de Tags Ativas -->
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:18px; padding:10px 14px; background:#f8fafc; border-radius:10px; border:1px solid #e2e8f0;">
        <span style="font-size:12px; font-weight:700; color:#475569; display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-tags" style="color:var(--primary);"></i> Tags:
        </span>
        <div id="crm-tags-badge-list" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          ${renderizarTagsBadges(c.id, tags)}
        </div>
        <button onclick="crmExibirPromptNovaTag(${c.id})" class="btn-outline" style="padding:3px 10px; font-size:11px; border-radius:12px; border-style:dashed; color:#64748b; margin-left:auto; cursor:pointer;">
          <i class="fa-solid fa-plus"></i> Adicionar Tag
        </button>
      </div>

      <!-- Grid de Métricas Consolidadas 360° -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:24px;">
        
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; text-align:left;">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:0.5px; display:block;">LTV de Consumo</span>
          <strong style="font-size:20px; color:#0f172a; display:block; margin:4px 0 2px;">${fmtMoeda(m.valor_pedidos_concluidos)}</strong>
          <span style="font-size:11px; color:#10b981;"><i class="fa-solid fa-circle-check"></i> ${m.pedidos_concluidos || 0} pedidos concluídos</span>
        </div>

        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; text-align:left;">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:0.5px; display:block;">Ticket Médio</span>
          <strong style="font-size:20px; color:#0369a1; display:block; margin:4px 0 2px;">${fmtMoeda(m.ticket_medio)}</strong>
          <span style="font-size:11px; color:#64748b;">Máx: ${fmtMoeda(m.ticket_maximo)}</span>
        </div>

        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; text-align:left;">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:0.5px; display:block;">Caixa Real Efetivo</span>
          <strong style="font-size:20px; color:#059669; display:block; margin:4px 0 2px;">${fmtMoeda(m.valor_recebido_caixa)}</strong>
          <span style="font-size:11px; color:#64748b;">Sem duplicar crédito</span>
        </div>

        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:14px; text-align:left;">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:#92400e; letter-spacing:0.5px; display:block;">Carteira de Crédito</span>
          <strong style="font-size:20px; color:#b45309; display:block; margin:4px 0 2px;">${fmtMoeda(m.saldo_credito_atual)}</strong>
          <span style="font-size:11px; color:#b45309;">Saldo disponível (Frente C)</span>
        </div>

        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; text-align:left;">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:0.5px; display:block;">Conversão Orçamentos</span>
          <strong style="font-size:20px; color:#7c3aed; display:block; margin:4px 0 2px;">${Number(m.taxa_conversao_orcamentos || 0).toFixed(1)}%</strong>
          <span style="font-size:11px; color:#64748b;">${m.orcamentos_convertidos || 0} de ${m.total_orcamentos || 0} convertidos</span>
        </div>

      </div>

      <!-- Layout Dividido: Linha do Tempo (Esquerda) e Notas & Preferências (Direita) -->
      <div style="display:grid; grid-template-columns: 1.3fr 1fr; gap:20px; align-items:start;">
        
        <!-- COLUNA ESQUERDA: Timeline Unificada 360° -->
        <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:18px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid #f1f5f9; padding-bottom:10px;">
            <h4 style="margin:0; font-size:15px; color:#1e293b; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-timeline" style="color:var(--primary);"></i> Timeline Unificada 360°
            </h4>
            <span style="font-size:11px; color:#64748b;">${timeline.length} eventos registrados</span>
          </div>

          <div id="crm-timeline-list" style="max-height:550px; overflow-y:auto; padding-right:6px;">
            ${renderizarTimelineItens(timeline)}
          </div>
        </div>

        <!-- COLUNA DIREITA: Notas Internas e Preferências/Restrições -->
        <div style="display:flex; flex-direction:column; gap:20px;">
          
          <!-- Bloco: Notas Internas da Equipe -->
          <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:18px;">
            <h4 style="margin:0 0 12px; font-size:15px; color:#1e293b; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-note-sticky" style="color:#f59e0b;"></i> Notas Internas da Equipe
            </h4>
            
            <!-- Campo para adicionar nota -->
            <div style="margin-bottom:14px;">
              <textarea id="crm-nova-nota-input" placeholder="Adicionar observação sobre o cliente (visível apenas para equipe)..." style="width:100%; height:60px; padding:8px 10px; font-size:12px; border:1px solid #cbd5e1; border-radius:8px; box-sizing:border-box; resize:vertical;"></textarea>
              <div style="text-align:right; margin-top:6px;">
                <button onclick="crmSalvarNota(${c.id})" class="btn-primary" style="padding:6px 14px; font-size:12px; border-radius:8px; cursor:pointer;">
                  <i class="fa-solid fa-paper-plane"></i> Salvar Nota
                </button>
              </div>
            </div>

            <!-- Lista de notas ativas -->
            <div id="crm-notas-list" style="display:flex; flex-direction:column; gap:8px; max-height:220px; overflow-y:auto;">
              ${renderizarNotasList(c.id, notas)}
            </div>
          </div>

          <!-- Bloco: Preferências & Restrições Alimentares -->
          <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:18px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <h4 style="margin:0; font-size:15px; color:#1e293b; display:flex; align-items:center; gap:8px;">
                <i class="fa-solid fa-heart" style="color:#ec4899;"></i> Preferências & Restrições
              </h4>
              <button onclick="crmToggleFormPreferencia()" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:8px; cursor:pointer;">
                <i class="fa-solid fa-plus"></i> Nova
              </button>
            </div>

            <!-- Formulário expansível de preferência -->
            <div id="crm-form-preferencia" style="display:none; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:12px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
                <input type="text" id="crm-pref-categoria" placeholder="Categoria (ex: Sabor, Alergia)" style="padding:6px 8px; font-size:12px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
                <input type="text" id="crm-pref-valor" placeholder="Preferência (ex: Sem Nozes)" style="padding:6px 8px; font-size:12px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box;">
              </div>
              <input type="text" id="crm-pref-detalhes" placeholder="Detalhes (ex: Alergia severa, não pode traços)" style="width:100%; padding:6px 8px; font-size:12px; border:1px solid #cbd5e1; border-radius:6px; box-sizing:border-box; margin-bottom:8px;">
              <div style="display:flex; justify-content:flex-end; gap:6px;">
                <button onclick="crmToggleFormPreferencia(false)" class="btn-outline" style="padding:4px 10px; font-size:11px; border-radius:6px;">Cancelar</button>
                <button onclick="crmSalvarPreferencia(${c.id})" class="btn-primary" style="padding:4px 12px; font-size:11px; border-radius:6px;">Salvar</button>
              </div>
            </div>

            <!-- Lista de preferências -->
            <div id="crm-preferencias-list" style="display:flex; flex-direction:column; gap:8px; max-height:220px; overflow-y:auto;">
              ${renderizarPreferenciasList(c.id, preferencias)}
            </div>
          </div>

        </div>

      </div>

    </div>
  `;

  container.innerHTML = html;
}

/**
 * Renderiza badges de tags
 */
function renderizarTagsBadges(clienteId, tags) {
  if (!tags || tags.length === 0) {
    return `<span style="font-size:12px; color:#94a3b8; font-style:italic;">Nenhuma tag cadastrada.</span>`;
  }

  return tags.map(t => {
    const cor = t.cor || '#0284c7';
    return `
      <span style="display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; background:#f0f9ff; color:${cor}; border:1px solid #bae6fd; padding:3px 8px; border-radius:12px;">
        ${escapeHtml(t.tag)}
        <button onclick="crmRemoverTag(${clienteId}, '${escapeHtml(t.tag)}')" style="background:none; border:none; color:#94a3b8; cursor:pointer; padding:0; font-size:10px; line-height:1;" title="Remover tag">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </span>
    `;
  }).join('');
}

/**
 * Renderiza itens da Linha do Tempo Unificada
 */
function renderizarTimelineItens(timeline) {
  if (!timeline || timeline.length === 0) {
    return `
      <div style="text-align:center; padding:30px; color:#94a3b8; font-size:13px;">
        <i class="fa-solid fa-hourglass-empty fa-2x" style="display:block; margin-bottom:8px; color:#cbd5e1;"></i>
        Nenhum evento registrado no histórico do cliente.
      </div>
    `;
  }

  return timeline.map(ev => {
    let icone = 'fa-circle';
    let iconeCor = '#64748b';
    let bgBadge = '#f1f5f9';
    let titulo = ev.titulo || 'Evento';

    switch (ev.tipo) {
      case 'pedido':
        icone = 'fa-receipt';
        iconeCor = '#0284c7';
        bgBadge = '#e0f2fe';
        break;
      case 'orcamento':
        icone = 'fa-file-invoice-dollar';
        iconeCor = '#7c3aed';
        bgBadge = '#f3e8ff';
        break;
      case 'comunicacao':
        icone = 'fa-brands fa-whatsapp';
        iconeCor = '#16a34a';
        bgBadge = '#dcfce7';
        break;
      case 'credito':
        icone = 'fa-wallet';
        iconeCor = '#d97706';
        bgBadge = '#fef3c7';
        break;
      case 'nota':
        icone = 'fa-note-sticky';
        iconeCor = '#ea580c';
        bgBadge = '#ffedd5';
        break;
    }

    const dataHora = ev.ocorrido_em ? new Date(ev.ocorrido_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '--';

    return `
      <div style="display:flex; gap:12px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid #f8fafc; align-items:flex-start;">
        <div style="width:32px; height:32px; border-radius:50%; background:${bgBadge}; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
          <i class="fa-solid ${icone}" style="color:${iconeCor}; font-size:13px;"></i>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2px;">
            <strong style="font-size:13px; color:#1e293b;">${escapeHtml(titulo)}</strong>
            <span style="font-size:11px; color:#94a3b8; white-space:nowrap;">${dataHora}</span>
          </div>
          <p style="margin:0; font-size:12px; color:#475569; line-height:1.4;">${escapeHtml(ev.descricao || '')}</p>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Renderiza lista de notas ativas
 */
function renderizarNotasList(clienteId, notas) {
  if (!notas || notas.length === 0) {
    return `<div style="font-size:12px; color:#94a3b8; font-style:italic; padding:8px 0;">Nenhuma nota interna registrada.</div>`;
  }

  return notas.map(n => {
    const dataFmt = n.created_at ? new Date(n.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '--';
    const autor = n.autor_nome ? escapeHtml(n.autor_nome) : 'Equipe';

    return `
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px; font-size:12px; position:relative;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:11px; color:#64748b;">
          <strong><i class="fa-regular fa-user"></i> ${autor}</strong>
          <span>${dataFmt}</span>
        </div>
        <p style="margin:0 0 4px; color:#334155; line-height:1.4; white-space:pre-wrap;">${escapeHtml(n.nota)}</p>
        <div style="text-align:right;">
          <button onclick="crmArquivarNota(${clienteId}, ${n.id})" style="background:none; border:none; color:#dc2626; font-size:11px; cursor:pointer; padding:0;" title="Arquivar esta nota">
            <i class="fa-solid fa-box-archive"></i> Arquivar
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Renderiza lista de preferências
 */
function renderizarPreferenciasList(clienteId, preferencias) {
  if (!preferencias || preferencias.length === 0) {
    return `<div style="font-size:12px; color:#94a3b8; font-style:italic; padding:8px 0;">Nenhuma preferência cadastrada.</div>`;
  }

  return preferencias.map(p => {
    return `
      <div style="background:#fdf2f8; border:1px solid #fbcfe8; border-radius:8px; padding:10px; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <span style="font-size:10px; font-weight:700; text-transform:uppercase; color:#db2777; background:#fce7f3; padding:1px 6px; border-radius:6px;">${escapeHtml(p.categoria || 'Geral')}</span>
            <strong style="display:block; color:#831843; font-size:13px; margin-top:2px;">${escapeHtml(p.valor || p.preferencia || '')}</strong>
            ${(p.observacao || p.detalhes) ? `<span style="display:block; font-size:11px; color:#9d174d; margin-top:2px;">${escapeHtml(p.observacao || p.detalhes)}</span>` : ''}
          </div>
          <button onclick="crmArquivarPreferencia(${clienteId}, ${p.id})" style="background:none; border:none; color:#dc2626; font-size:11px; cursor:pointer; padding:0;" title="Arquivar preferência">
            <i class="fa-solid fa-box-archive"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Ações de mutação do CRM
 */
async function crmSalvarNota(clienteId) {
  const input = document.getElementById('crm-nova-nota-input');
  if (!input) return;
  const texto = input.value.trim();
  if (!texto) {
    mostrarToast('Digite o texto da nota.', 'aviso');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('adicionar_nota_cliente', {
      p_cliente_id: clienteId,
      p_nota: texto
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao salvar nota');

    mostrarToast('Nota interna adicionada com sucesso!', 'sucesso');
    input.value = '';
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao salvar nota:', err);
    mostrarToast(err.message || 'Erro ao registrar nota', 'erro');
  }
}

async function crmArquivarNota(clienteId, notaId) {
  if (!confirm('Deseja arquivar esta nota interna?')) return;

  try {
    const { data, error } = await supabaseClient.rpc('arquivar_nota_cliente', {
      p_nota_id: notaId
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao arquivar');

    mostrarToast('Nota arquivada!', 'sucesso');
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao arquivar nota:', err);
    mostrarToast(err.message || 'Erro ao arquivar nota', 'erro');
  }
}

async function crmExibirPromptNovaTag(clienteId) {
  const tagNome = prompt('Digite o nome da tag (ex: VIP, Vegano, Recorrente, Aniversariante):');
  if (!tagNome || !tagNome.trim()) return;

  try {
    const { data, error } = await supabaseClient.rpc('adicionar_tag_cliente', {
      p_cliente_id: clienteId,
      p_tag: tagNome.trim()
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao adicionar tag');

    mostrarToast(`Tag "${tagNome.trim()}" adicionada!`, 'sucesso');
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao adicionar tag:', err);
    mostrarToast(err.message || 'Erro ao vincular tag', 'erro');
  }
}

async function crmRemoverTag(clienteId, tag) {
  if (!confirm(`Remover a tag "${tag}" do cliente?`)) return;

  try {
    const { data, error } = await supabaseClient.rpc('remover_tag_cliente', {
      p_cliente_id: clienteId,
      p_tag: tag
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao remover tag');

    mostrarToast(`Tag "${tag}" removida!`, 'sucesso');
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao remover tag:', err);
    mostrarToast(err.message || 'Erro ao remover tag', 'erro');
  }
}

function crmToggleFormPreferencia(abrir = null) {
  const f = document.getElementById('crm-form-preferencia');
  if (!f) return;
  if (abrir === null) {
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  } else {
    f.style.display = abrir ? 'block' : 'none';
  }
}

async function crmSalvarPreferencia(clienteId) {
  const cat = document.getElementById('crm-pref-categoria')?.value?.trim() || 'Geral';
  const val = document.getElementById('crm-pref-valor')?.value?.trim();
  const det = document.getElementById('crm-pref-detalhes')?.value?.trim() || null;

  if (!val) {
    mostrarToast('Informe a preferência do cliente.', 'aviso');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('definir_preferencia_cliente', {
      p_cliente_id: clienteId,
      p_categoria: cat,
      p_valor: val,
      p_observacao: det
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao salvar preferência');

    mostrarToast('Preferência registrada!', 'sucesso');
    crmToggleFormPreferencia(false);
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao definir preferência:', err);
    mostrarToast(err.message || 'Erro ao salvar preferência', 'erro');
  }
}

async function crmArquivarPreferencia(clienteId, prefId) {
  if (!confirm('Deseja arquivar esta preferência?')) return;

  try {
    const { data, error } = await supabaseClient.rpc('arquivar_preferencia_cliente', {
      p_preferencia_id: prefId
    });
    if (error) throw error;
    if (data?.success === false) throw new Error(data.error || 'Erro ao arquivar preferência');

    mostrarToast('Preferência arquivada!', 'sucesso');
    await abrirFicha360Cliente(clienteId);
  } catch (err) {
    console.error('[CRM] Erro ao arquivar preferência:', err);
    mostrarToast(err.message || 'Erro ao arquivar preferência', 'erro');
  }
}

/**
 * Ações rápidas de criação a partir do cliente
 */
function crmCriarEncomendaRapida(clienteId) {
  if (!crmDadosClienteCache || !crmDadosClienteCache.cliente) return;
  const c = crmDadosClienteCache.cliente;

  if (typeof abrirModalNovaEncomenda === 'function') {
    abrirModalNovaEncomenda();
    // Pré-preenche os campos
    setTimeout(() => {
      const nomeInput = document.getElementById('nova-enc-cliente-nome');
      const telInput = document.getElementById('nova-enc-cliente-tel');
      const emailInput = document.getElementById('nova-enc-cliente-email');
      const clienteIdHidden = document.getElementById('nova-enc-cliente-id');
      if (nomeInput) nomeInput.value = c.nome || '';
      if (telInput) telInput.value = c.telefone || '';
      if (emailInput) emailInput.value = c.email || '';
      if (clienteIdHidden) clienteIdHidden.value = c.id;
    }, 100);
  } else {
    mostrarToast('Modal de nova encomenda não carregado.', 'aviso');
  }
}

function crmCriarOrcamentoRapido(clienteId) {
  if (!crmDadosClienteCache || !crmDadosClienteCache.cliente) return;
  const c = crmDadosClienteCache.cliente;

  if (typeof abrirModalNovoOrcamento === 'function') {
    abrirModalNovoOrcamento();
    setTimeout(() => {
      const nomeInput = document.getElementById('orc-cliente-nome');
      const telInput = document.getElementById('orc-cliente-tel');
      const emailInput = document.getElementById('orc-cliente-email');
      if (nomeInput) nomeInput.value = c.nome || '';
      if (telInput) telInput.value = c.telefone || '';
      if (emailInput) emailInput.value = c.email || '';
    }, 100);
  } else {
    mostrarToast('Modal de novo orçamento não carregado.', 'aviso');
  }
}

/**
 * Ação canônica de WhatsApp integrada à infraestrutura da Frente B
 */
function crmAbrirWhatsApp(clienteId, telefoneRaw, nomeCliente) {
  const norm = (typeof window.normalizarTelefoneE164 === 'function')
    ? window.normalizarTelefoneE164(telefoneRaw)
    : (telefoneRaw ? telefoneRaw.replace(/\D/g, '') : null);

  if (!norm) {
    mostrarToast('Telefone do cliente é inválido ou incompleto para WhatsApp.', 'aviso');
    return;
  }

  // Verifica se o cliente possui pedido ou orçamento na Ficha 360 ativa
  let ultimoPedidoId = null;
  let ultimoOrcamentoId = null;
  if (crmDadosClienteCache && Array.isArray(crmDadosClienteCache.timeline)) {
    const pedEv = crmDadosClienteCache.timeline.find(ev => ev.tipo === 'pedido' && ev.referencia_id);
    if (pedEv) ultimoPedidoId = pedEv.referencia_id;
    const orcEv = crmDadosClienteCache.timeline.find(ev => ev.tipo === 'orcamento' && ev.referencia_id);
    if (orcEv) ultimoOrcamentoId = orcEv.referencia_id;
  }

  // Se houver pedido ou orçamento vinculado e o helper da Frente B estiver presente,
  // aciona a trilha formal com preview server-side e registro de link_aberto
  if (typeof window.abrirModalComunicacaoWhatsApp === 'function' && (ultimoPedidoId || ultimoOrcamentoId)) {
    if (ultimoPedidoId) {
      window.abrirModalComunicacaoWhatsApp({ tipo: 'SINAL_CONFIRMADO', pedidoId: ultimoPedidoId });
      return;
    } else if (ultimoOrcamentoId) {
      window.abrirModalComunicacaoWhatsApp({ tipo: 'ORCAMENTO_PROPOSTA', orcamentoId: ultimoOrcamentoId });
      return;
    }
  }

  // Fallback seguro para contato geral: normalização E.164 canônica e abertura protegida
  const primeiroNome = (nomeCliente || 'Cliente').split(' ')[0];
  const msgPadrao = `Olá, ${primeiroNome}! Aqui é da Lunoca Doceria 🍰 Tudo bem?`;
  const url = (typeof window.gerarLinkWhatsApp === 'function')
    ? window.gerarLinkWhatsApp({ telefone: norm, mensagem: msgPadrao })
    : `https://wa.me/${norm}?text=${encodeURIComponent(msgPadrao)}`;

  window.open(url, '_blank', 'noopener,noreferrer');
}

