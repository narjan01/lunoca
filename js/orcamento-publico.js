// ==========================================================================
// LUNOCA DOCERIA - Módulo Público: Visualização & Aprovação de Orçamento (Etapa 3)
// ==========================================================================

let tokenPublicoAtual = null;
let orcamentoPublicoCache = null;

function extrairTokenDaUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  let token = urlParams.get('t') || urlParams.get('token');
  if (!token && window.location.hash) {
    const hash = window.location.hash.replace('#', '').trim();
    if (hash.length >= 32) token = hash;
  }
  return token;
}

async function inicializarPaginaOrcamentoPublico() {
  const loading = document.getElementById('orcamento-loading');
  const erroBox = document.getElementById('orcamento-erro');
  const conteudo = document.getElementById('orcamento-conteudo');

  tokenPublicoAtual = extrairTokenDaUrl();

  if (!tokenPublicoAtual) {
    loading.style.display = 'none';
    erroBox.style.display = 'block';
    document.getElementById('orcamento-erro-msg').innerText = 'Link inválido ou token de orçamento não informado na URL.';
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('obter_orcamento_publico', { p_token: tokenPublicoAtual });

    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error(data?.error || 'Orçamento não encontrado ou link expirado.');
    }

    orcamentoPublicoCache = data;
    renderizarDadosOrcamentoPublico(data);

    loading.style.display = 'none';
    conteudo.style.display = 'block';

  } catch (err) {
    console.error('[Orçamento Público] Erro ao carregar:', err);
    loading.style.display = 'none';
    erroBox.style.display = 'block';
    document.getElementById('orcamento-erro-msg').innerText = err.message || 'Erro ao carregar a proposta comercial.';
  }
}

function renderizarDadosOrcamentoPublico(orc) {
  document.getElementById('orc-numero').innerText = `${orc.numero} ${orc.versao > 1 ? '(v' + orc.versao + ')' : ''}`;
  document.getElementById('orc-cliente-nome').innerText = orc.cliente_nome;
  document.getElementById('orc-cliente-tel').innerText = orc.cliente_telefone || 'Sem telefone';

  const dataFmt = formatarDataPtBr(orc.data_evento);
  const horaFmt = orc.hora_evento ? orc.hora_evento.slice(0, 5) : '12:00';
  document.getElementById('orc-data-evento').innerText = `${dataFmt} às ${horaFmt}`;

  const validadeFmt = formatarDataHoraRelativa(orc.validade_ate);
  document.getElementById('orc-validade-info').innerText = `Validade: até ${validadeFmt}`;

  document.getElementById('orc-tipo-entrega').innerText = orc.tipo_entrega === 'entrega' ? 'Entrega em Domicílio' : 'Retirada no Balcão';
  document.getElementById('orc-endereco-entrega').innerText = orc.tipo_entrega === 'entrega'
    ? (orc.endereco_entrega || 'Endereço a combinar')
    : 'Retirada na loja física da Lunoca';

  // Badge de Status
  const badgeContainer = document.getElementById('orc-status-badge');
  badgeContainer.innerHTML = obterBadgeStatusPublico(orc.status, orc.expirado);

  // Banners de Estado
  const bannerAprovado = document.getElementById('orc-banner-aprovado');
  const bannerExpirado = document.getElementById('orc-banner-expirado');
  const btnAprovar = document.getElementById('btn-aprovar-orcamento');

  if (orc.status === 'aprovado' || orc.status === 'convertido') {
    bannerAprovado.style.display = 'block';
    bannerExpirado.style.display = 'none';
    if (btnAprovar) btnAprovar.style.display = 'none';
  } else if (orc.expirado || orc.status === 'expirado') {
    bannerAprovado.style.display = 'none';
    bannerExpirado.style.display = 'block';
    if (btnAprovar) btnAprovar.style.display = 'none';
  } else if (orc.status === 'enviado') {
    bannerAprovado.style.display = 'none';
    bannerExpirado.style.display = 'none';
    if (btnAprovar) btnAprovar.style.display = 'inline-flex';
  } else {
    bannerAprovado.style.display = 'none';
    bannerExpirado.style.display = 'none';
    if (btnAprovar) btnAprovar.style.display = 'none';
  }

  // Tabela de Itens
  const tbody = document.getElementById('orc-itens-tbody');
  tbody.innerHTML = '';

  (orc.itens || []).forEach(it => {
    const tr = document.createElement('tr');
    const opcoesTxt = (it.opcoes || []).map(o => o.opcao_nome).join(', ');

    tr.innerHTML = `
      <td>
        <div style="font-weight:700; color:var(--text-main);">${escapeHtml(it.produto_nome)}</div>
        ${it.produto_descricao ? `<div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${escapeHtml(it.produto_descricao)}</div>` : ''}
        ${opcoesTxt ? `<div style="font-size:12px; color:#4338ca; margin-top:3px;"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(opcoesTxt)}</div>` : ''}
        ${it.observacoes ? `<div style="font-size:12px; color:#92400e; font-style:italic; margin-top:3px;">Obs: ${escapeHtml(it.observacoes)}</div>` : ''}
      </td>
      <td style="text-align:center; font-weight:700;">${it.quantidade}</td>
      <td style="text-align:right; color:var(--text-muted);">${formatarMoedaReal(it.preco_unitario)}</td>
      <td style="text-align:right; font-weight:700; color:var(--text-main);">${formatarMoedaReal(it.subtotal)}</td>
    `;
    tbody.appendChild(tr);
  });

  // Totais
  document.getElementById('orc-subtotal-val').innerText = formatarMoedaReal(orc.subtotal);

  const descLinha = document.getElementById('orc-desconto-linha');
  if (orc.desconto_produtos > 0) {
    descLinha.style.display = 'flex';
    document.getElementById('orc-desconto-val').innerText = `- ${formatarMoedaReal(orc.desconto_produtos)}`;
  } else {
    descLinha.style.display = 'none';
  }

  document.getElementById('orc-frete-val').innerText = formatarMoedaReal(orc.taxa_entrega);
  document.getElementById('orc-total-val').innerText = formatarMoedaReal(orc.total);

  // Sinal Sugerido
  const pctSinal = orc.total > 0 ? Math.round((orc.sinal_sugerido / orc.total) * 100) : 50;
  document.getElementById('orc-sinal-val').innerText = formatarMoedaReal(orc.sinal_sugerido);
  document.getElementById('orc-sinal-pct').innerText = `${pctSinal}%`;
  document.getElementById('orc-saldo-val').innerText = formatarMoedaReal(orc.total - orc.sinal_sugerido);

  // Observações do Cliente
  const obsContainer = document.getElementById('orc-obs-cliente-container');
  if (orc.observacoes_cliente) {
    obsContainer.style.display = 'block';
    document.getElementById('orc-obs-cliente-txt').innerText = orc.observacoes_cliente;
  } else {
    obsContainer.style.display = 'none';
  }

  // Link do WhatsApp
  const btnZap = document.getElementById('btn-contato-zap');
  if (btnZap) {
    const zapMsg = encodeURIComponent(`Olá, Lunoca Doceria! Estou visualizando a proposta comercial ${orc.numero} e gostaria de tirar uma dúvida.`);
    btnZap.href = `https://wa.me/5588999999999?text=${zapMsg}`;
  }
}

async function aprovarPropostaPublica() {
  if (!tokenPublicoAtual) return;

  const orc = orcamentoPublicoCache;
  const totalFmt = orc ? formatarMoedaReal(orc.total) : '';

  const confirmado = confirm(`Deseja confirmar a aprovação da Proposta Comercial no valor de ${totalFmt}?\n\nApós a aprovação, nossa equipe entrará em contato para agendar o pagamento do sinal e reservar sua data.`);
  if (!confirmado) return;

  const btnAprovar = document.getElementById('btn-aprovar-orcamento');
  if (btnAprovar) {
    btnAprovar.disabled = true;
    btnAprovar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Confirmando Aprovação...';
  }

  try {
    const { data, error } = await supabaseClient.rpc('aprovar_orcamento_publico', { p_token: tokenPublicoAtual });

    if (error) throw error;
    if (!data || data.success === false) {
      if (data?.code === 'QUOTE_EXPIRED') {
        throw new Error('Esta proposta expirou e não pode mais ser aprovada.');
      }
      throw new Error(data?.error || 'Não foi possível aprovar a proposta.');
    }

    // Sucesso ou Idempotência
    alert('🎉 Proposta Comercial aprovada com sucesso! Entraremos em contato via WhatsApp para os próximos passos.');

    // Recarrega dados atualizados
    await inicializarPaginaOrcamentoPublico();

  } catch (err) {
    console.error('[Aprovar Orçamento] Erro:', err);
    alert('Erro ao aprovar proposta: ' + (err.message || 'Tente novamente'));
    if (btnAprovar) {
      btnAprovar.disabled = false;
      btnAprovar.innerHTML = '<i class="fa-solid fa-circle-check"></i> Aprovar Proposta';
    }
  }
}

function obterBadgeStatusPublico(status, expirado) {
  if (expirado || status === 'expirado') {
    return `<span class="status-badge status-expirado"><i class="fa-solid fa-clock"></i> Expirado</span>`;
  }
  switch (status) {
    case 'enviado':
      return `<span class="status-badge status-enviado"><i class="fa-solid fa-envelope-open-text"></i> Proposta Disponível</span>`;
    case 'aprovado':
      return `<span class="status-badge status-aprovado"><i class="fa-solid fa-circle-check"></i> Aprovado</span>`;
    case 'convertido':
      return `<span class="status-badge status-convertido"><i class="fa-solid fa-cake-candles"></i> Encomenda Confirmada</span>`;
    case 'recusado':
      return `<span class="status-badge status-recusado"><i class="fa-solid fa-ban"></i> Não Aprovado</span>`;
    default:
      return `<span class="status-badge" style="background:#f1f5f9; color:#475569;">${escapeHtml(status || 'Pendente')}</span>`;
  }
}

function formatarDataPtBr(dataStr) {
  if (!dataStr) return '-';
  const p = dataStr.split('-');
  if (p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
  return dataStr;
}

function formatarDataHoraRelativa(tsStr) {
  if (!tsStr) return '-';
  const d = new Date(tsStr);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatarMoedaReal(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeHtml(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', inicializarPaginaOrcamentoPublico);
