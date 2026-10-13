// ==============================================================================
// LUNOCA DOCERIA - PORTAL DO CLIENTE / MINHA CONTA (FRENTE J - MIGRATION 025)
// ==============================================================================
// Regras Invariantes:
// 1. Máquina de estados determinística:
//    loading -> getSession() -> sem sessão: login -> sessão: resolver vínculo
//    via obter_painel_minha_conta_cliente() -> vínculo válido: portal ->
//    sem vínculo (CLIENT_LINK_REQUIRED): estado explicativo -> erro de rede: retry.
// 2. Nenhuma chamada envia p_cliente_id vindo do navegador.
// 3. Nenhum token_publico de orçamento é lido, exibido ou transportado;
//    aprovação usa aprovar_meu_orcamento(p_orcamento_id, p_versao_esperada).
// 4. Separação explícita entre Crédito Financeiro (R$) e Pontos de Fidelidade (pts).
// ==============================================================================

var estadoPortalCliente = {
  painel: null,
  secaoAtiva: 'resumo'
};

function escPortal(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function moedaPortal(valor) {
  var n = Number(valor || 0);
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dataPortal(valor) {
  if (!valor) return '—';
  try {
    return new Date(valor).toLocaleDateString('pt-BR');
  } catch (_) {
    return String(valor);
  }
}

function labelEtapaCliente(etapa) {
  var mapa = {
    aguardando_preparo: 'Aguardando preparo',
    em_preparo: 'Em preparo na confeitaria',
    pronto_para_retirada: 'Pronto para retirada na loja',
    pronto_para_entrega: 'Pronto para sair para entrega',
    saiu_para_entrega: 'Saiu para entrega',
    entregue: 'Pedido entregue',
    retirado: 'Pedido retirado',
    cancelado: 'Cancelado'
  };
  return mapa[etapa] || etapa || 'Em processamento';
}

function definirEstadoTelaPortal(estado, mensagemErro) {
  var ids = {
    loading: 'portal-state-loading',
    login: 'portal-state-login',
    unlinked: 'portal-state-unlinked',
    error: 'portal-state-error',
    portal: 'portal-main-content'
  };

  Object.keys(ids).forEach(function (chave) {
    var el = document.getElementById(ids[chave]);
    if (el) el.style.display = (chave === estado) ? 'block' : 'none';
  });

  var userBar = document.getElementById('portal-user-bar');
  if (userBar) {
    userBar.style.display = (estado === 'portal' || estado === 'unlinked') ? 'flex' : 'none';
  }

  if (estado === 'error' && mensagemErro) {
    var errEl = document.getElementById('portal-error-msg');
    if (errEl) errEl.textContent = mensagemErro;
  }
}

async function inicializarPortalMinhaConta() {
  definirEstadoTelaPortal('loading');

  if (typeof supabaseClient === 'undefined' || !supabaseClient) {
    definirEstadoTelaPortal('error', 'Cliente de comunicação indisponível. Verifique sua conexão.');
    return;
  }

  try {
    var sessResp = await supabaseClient.auth.getSession();
    if (sessResp.error) {
      definirEstadoTelaPortal('error', 'Não foi possível validar sua sessão. Tente novamente.');
      return;
    }

    var session = sessResp.data && sessResp.data.session;
    if (!session || !session.user) {
      definirEstadoTelaPortal('login');
      return;
    }

    var resp = await supabaseClient.rpc('obter_painel_minha_conta_cliente');
    if (resp.error) {
      definirEstadoTelaPortal('error', 'Falha temporária ao sincronizar seus dados.');
      return;
    }

    var dados = resp.data;
    if (!dados || !dados.success) {
      if (dados && dados.code === 'UNAUTHENTICATED') {
        definirEstadoTelaPortal('login');
        return;
      }
      if (dados && (dados.code === 'CLIENT_LINK_REQUIRED' || dados.code === 'AMBIGUOUS_CLIENT_LINK')) {
        definirEstadoTelaPortal('unlinked');
        return;
      }
      definirEstadoTelaPortal('error', (dados && dados.error) || 'Não foi possível carregar sua conta.');
      return;
    }

    estadoPortalCliente.painel = dados;
    renderizarResumoPortalCliente(dados);
    definirEstadoTelaPortal('portal');
  } catch (e) {
    console.error('[MinhaConta] Erro na inicialização:', e);
    definirEstadoTelaPortal('error', 'Erro de rede ao conectar ao servidor.');
  }
}

async function realizarLoginPortalCliente(event) {
  if (event) event.preventDefault();
  var emailEl = document.getElementById('portal-login-email');
  var senhaEl = document.getElementById('portal-login-senha');
  var erroEl = document.getElementById('portal-login-erro');
  var btnEl = document.getElementById('portal-login-btn');

  if (erroEl) erroEl.style.display = 'none';
  if (btnEl) btnEl.disabled = true;

  try {
    var resp = await supabaseClient.auth.signInWithPassword({
      email: (emailEl && emailEl.value || '').trim(),
      password: senhaEl && senhaEl.value || ''
    });

    if (resp.error) {
      if (erroEl) {
        erroEl.textContent = 'E-mail ou senha inválidos.';
        erroEl.style.display = 'block';
      }
      return;
    }

    await inicializarPortalMinhaConta();
  } catch (e) {
    if (erroEl) {
      erroEl.textContent = 'Erro de conexão ao realizar login.';
      erroEl.style.display = 'block';
    }
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function sairPortalMinhaConta() {
  try {
    await supabaseClient.auth.signOut();
  } catch (_) {}
  estadoPortalCliente.painel = null;
  definirEstadoTelaPortal('login');
}

function renderizarResumoPortalCliente(dados) {
  var perfil = dados.perfil || {};
  var cred = dados.meu_credito || {};
  var pts = dados.meus_pontos || {};
  var cont = dados.resumo_contadores || {};

  var nameEl = document.getElementById('portal-user-name');
  if (nameEl) nameEl.textContent = perfil.nome || perfil.email || 'Minha Conta';

  var credEl = document.getElementById('portal-resumo-credito');
  if (credEl) credEl.textContent = moedaPortal(cred.saldo_reais || 0);

  var ptsEl = document.getElementById('portal-resumo-pontos');
  if (ptsEl) ptsEl.textContent = Number(pts.saldo_pontos || 0) + ' pts';

  var ptsSub = document.getElementById('portal-resumo-pontos-sub');
  if (ptsSub) {
    var exp = Number(pts.pontos_expirando_30d || 0);
    ptsSub.textContent = exp > 0
      ? ('Atenção: ' + exp + ' pts expiram nos próximos 30 dias. Resgate mínimo: ' + Number(pts.resgate_minimo_pontos || 20) + ' pts.')
      : ('Programa: ' + (pts.programa_nome || 'Clube Lunoca') + ' • Resgate mínimo: ' + Number(pts.resgate_minimo_pontos || 20) + ' pts.');
  }

  // Pedidos recentes no resumo
  var pedLista = document.getElementById('portal-resumo-pedidos-lista');
  if (pedLista) {
    var peds = dados.pedidos_recentes || [];
    if (peds.length === 0) {
      pedLista.innerHTML = '<p style="color:#6b7280; font-size:0.88rem;">Nenhum pedido registrado ainda.</p>';
    } else {
      pedLista.innerHTML = peds.map(function (p) {
        return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0; display:flex; justify-content:space-between; align-items:center;">' +
          '<div>' +
            '<strong>Pedido #' + Number(p.pedido_id) + '</strong> • ' + escPortal(labelEtapaCliente(p.etapa_cliente)) +
            '<div style="font-size:0.8rem; color:#6b7280;">Entrega/Retirada: ' + dataPortal(p.data_entrega) + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-weight:700;">' + moedaPortal(p.total) + '</div>' +
            (Number(p.saldo_a_pagar || 0) > 0
              ? '<span style="font-size:0.75rem; color:#b45309;">A pagar: ' + moedaPortal(p.saldo_a_pagar) + '</span>'
              : '<span style="font-size:0.75rem; color:#059669;">Quitado</span>') +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

  // Orçamentos recentes no resumo
  var orcLista = document.getElementById('portal-resumo-orcamentos-lista');
  if (orcLista) {
    var orcs = dados.orcamentos_recentes || [];
    if (orcs.length === 0) {
      orcLista.innerHTML = '<p style="color:#6b7280; font-size:0.88rem;">Nenhum orçamento registrado ainda.</p>';
    } else {
      orcLista.innerHTML = orcs.map(function (o) {
        return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0; display:flex; justify-content:space-between; align-items:center;">' +
          '<div>' +
            '<strong>' + escPortal(o.numero) + ' (v' + Number(o.versao) + ')</strong>' +
            '<div style="font-size:0.8rem; color:#6b7280;">Status: ' + escPortal(o.status) + ' • Evento: ' + dataPortal(o.data_evento) + '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-weight:700;">' + moedaPortal(o.total) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

  // Preferências no estado inicial
  renderizarListaPreferenciasPortal(dados.preferencias_declaradas || []);

  // Consentimento atual
  var consBox = document.getElementById('portal-consentimento-status-box');
  if (consBox) {
    var st = cont.consentimento_whatsapp_marketing || 'sem_registro';
    consBox.innerHTML = 'Status atual no WhatsApp Marketing: <span class="portal-badge" style="background:' +
      (st === 'opt_in' ? '#d1fae5; color:#065f46;' : '#fee2e2; color:#991b1b;') + '">' +
      escPortal(st.toUpperCase()) + '</span>';
  }
}

async function mudarSecaoPortalCliente(secao) {
  estadoPortalCliente.secaoAtiva = secao;
  document.querySelectorAll('.portal-nav-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sec') === secao);
  });
  document.querySelectorAll('.portal-section').forEach(function (sec) {
    sec.classList.toggle('active', sec.id === 'portal-sec-' + secao);
  });

  if (secao === 'pedidos') await carregarMeusPedidosPortalUI();
  if (secao === 'orcamentos') await carregarMeusOrcamentosPortalUI();
  if (secao === 'credito') await carregarMeuExtratoCreditoPortalUI();
  if (secao === 'pontos-cupons') await carregarMeusPontosECuponsPortalUI();
  if (secao === 'privacidade') await carregarMinhasComunicacoesPortalUI();
}

async function carregarMeusPedidosPortalUI() {
  var box = document.getElementById('portal-pedidos-lista');
  if (!box) return;
  box.innerHTML = '<p style="color:#6b7280;">Carregando seus pedidos...</p>';

  var resp = await supabaseClient.rpc('listar_meus_pedidos', { p_limite: 20, p_offset: 0 });
  if (resp.error || !resp.data || !resp.data.success) {
    box.innerHTML = '<p style="color:#dc2626;">Não foi possível carregar seus pedidos.</p>';
    return;
  }

  var peds = resp.data.pedidos || [];
  if (peds.length === 0) {
    box.innerHTML = '<p style="color:#6b7280;">Você ainda não possui pedidos.</p>';
    return;
  }

  box.innerHTML = peds.map(function (p) {
    var itensHtml = (p.itens || []).map(function (it) {
      return '<li>' + Number(it.quantidade) + 'x ' + escPortal(it.nome) + ' (' + moedaPortal(it.preco_unitario) + ')</li>';
    }).join('');

    return '<div style="border:1px solid #e5e7eb; border-radius:12px; padding:14px; margin-bottom:12px;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">' +
        '<div><strong>Pedido #' + Number(p.pedido_id) + '</strong> • Modalidade: ' + escPortal(p.modalidade) + '</div>' +
        '<span class="portal-badge" style="background:#f3e8ff; color:#6b21a8;">' + escPortal(labelEtapaCliente(p.etapa_cliente)) + '</span>' +
      '</div>' +
      '<div style="font-size:0.84rem; color:#4b5563; margin-top:6px;">Data programada: ' + dataPortal(p.data_entrega) + ' • Total: <strong>' + moedaPortal(p.total) + '</strong> • Saldo a pagar: <strong>' + moedaPortal(p.saldo_a_pagar) + '</strong></div>' +
      '<ul style="margin:8px 0 0 18px; padding:0; font-size:0.85rem; color:#374151;">' + itensHtml + '</ul>' +
    '</div>';
  }).join('');
}

async function carregarMeusOrcamentosPortalUI() {
  var box = document.getElementById('portal-orcamentos-lista');
  if (!box) return;
  box.innerHTML = '<p style="color:#6b7280;">Carregando seus orçamentos...</p>';

  var resp = await supabaseClient.rpc('listar_meus_orcamentos', { p_limite: 20, p_offset: 0 });
  if (resp.error || !resp.data || !resp.data.success) {
    box.innerHTML = '<p style="color:#dc2626;">Não foi possível carregar seus orçamentos.</p>';
    return;
  }

  var orcs = resp.data.orcamentos || [];
  if (orcs.length === 0) {
    box.innerHTML = '<p style="color:#6b7280;">Você não possui propostas de orçamento registradas.</p>';
    return;
  }

  box.innerHTML = orcs.map(function (o) {
    var podeAprovar = o.status === 'enviado';
    return '<div style="border:1px solid #e5e7eb; border-radius:12px; padding:14px; margin-bottom:12px;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">' +
        '<div><strong>' + escPortal(o.numero) + '</strong> • Versão v' + Number(o.versao) + ' • Status: <strong>' + escPortal(o.status) + '</strong></div>' +
        '<div style="font-weight:800; color:#6b21a8;">' + moedaPortal(o.total) + '</div>' +
      '</div>' +
      '<div style="font-size:0.84rem; color:#4b5563; margin-top:6px;">Evento: ' + dataPortal(o.data_evento) + ' • Validade: ' + dataPortal(o.validade_ate) + '</div>' +
      (podeAprovar
        ? '<div style="margin-top:10px;"><button type="button" class="portal-btn" onclick="aprovarMeuOrcamentoPortalUI(' + Number(o.orcamento_id) + ', ' + Number(o.versao) + ')">Aprovar Proposta (v' + Number(o.versao) + ')</button></div>'
        : '') +
    '</div>';
  }).join('');
}

async function aprovarMeuOrcamentoPortalUI(orcamentoId, versaoEsperada) {
  var resp = await supabaseClient.rpc('aprovar_meu_orcamento', {
    p_orcamento_id: Number(orcamentoId),
    p_versao_esperada: Number(versaoEsperada)
  });

  if (resp.error || !resp.data || !resp.data.success) {
    alert((resp.data && resp.data.error) || 'Não foi possível aprovar o orçamento.');
    return;
  }

  await inicializarPortalMinhaConta();
  await carregarMeusOrcamentosPortalUI();
}

async function carregarMeuExtratoCreditoPortalUI() {
  var box = document.getElementById('portal-extrato-credito-lista');
  if (!box) return;
  box.innerHTML = '<p style="color:#6b7280;">Carregando extrato financeiro...</p>';

  var resp = await supabaseClient.rpc('listar_meu_extrato_credito', { p_limite: 25, p_offset: 0 });
  if (resp.error || !resp.data || !resp.data.success) {
    box.innerHTML = '<p style="color:#dc2626;">Erro ao carregar extrato de crédito.</p>';
    return;
  }

  var movs = resp.data.movimentacoes || [];
  if (movs.length === 0) {
    box.innerHTML = '<p style="color:#6b7280;">Nenhuma movimentação de crédito financeiro encontrada.</p>';
    return;
  }

  box.innerHTML = movs.map(function (m) {
    var sinal = m.natureza === 'credito' ? '+' : '-';
    var cor = m.natureza === 'credito' ? '#059669' : '#dc2626';
    return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0; display:flex; justify-content:space-between;">' +
      '<div>' +
        '<strong>' + escPortal(m.tipo) + '</strong>' +
        '<div style="font-size:0.82rem; color:#6b7280;">' + escPortal(m.motivo || '') + ' • ' + dataPortal(m.created_at) + '</div>' +
      '</div>' +
      '<div style="text-align:right; font-weight:700; color:' + cor + ';">' +
        sinal + ' ' + moedaPortal(m.valor) +
        '<div style="font-size:0.75rem; color:#6b7280;">Saldo: ' + moedaPortal(m.saldo_posterior) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function carregarMeusPontosECuponsPortalUI() {
  var boxCupons = document.getElementById('portal-cupons-disponiveis-lista');
  var boxPontos = document.getElementById('portal-extrato-pontos-lista');

  var [rCupons, rPontos] = await Promise.all([
    supabaseClient.rpc('listar_meus_cupons'),
    supabaseClient.rpc('listar_meu_extrato_pontos', { p_limite: 25, p_offset: 0 })
  ]);

  if (boxCupons) {
    var cupons = (rCupons.data && rCupons.data.cupons_disponiveis) || [];
    if (cupons.length === 0) {
      boxCupons.innerHTML = '<p style="color:#6b7280;">Nenhum cupom disponível no momento.</p>';
    } else {
      boxCupons.innerHTML = cupons.map(function (c) {
        var beneficio = c.tipo === 'percentual' ? (Number(c.valor) + '% OFF') : (moedaPortal(c.valor) + ' OFF');
        return '<div style="border:1px dashed #d97706; border-radius:10px; padding:12px; margin-bottom:10px; background:#fffbeb;">' +
          '<div style="display:flex; justify-content:space-between;"><strong>' + escPortal(c.codigo) + '</strong><span style="font-weight:700; color:#b45309;">' + beneficio + '</span></div>' +
          '<div style="font-size:0.8rem; color:#6b7280; margin-top:4px;">Pedido mín.: ' + moedaPortal(c.pedido_minimo) + ' • Válido até: ' + dataPortal(c.validade_fim) + '</div>' +
        '</div>';
      }).join('');
    }
  }

  if (boxPontos) {
    var movs = (rPontos.data && rPontos.data.movimentacoes) || [];
    if (movs.length === 0) {
      boxPontos.innerHTML = '<p style="color:#6b7280;">Nenhuma movimentação de pontos registrada.</p>';
    } else {
      boxPontos.innerHTML = movs.map(function (m) {
        var sinal = m.natureza === 'credito' ? '+' : '-';
        var cor = m.natureza === 'credito' ? '#7c3aed' : '#dc2626';
        return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0; display:flex; justify-content:space-between;">' +
          '<div>' +
            '<strong>' + escPortal(m.tipo) + '</strong>' +
            '<div style="font-size:0.8rem; color:#6b7280;">' + escPortal(m.motivo || '') + ' • ' + dataPortal(m.created_at) + '</div>' +
          '</div>' +
          '<div style="text-align:right; font-weight:700; color:' + cor + ';">' +
            sinal + Number(m.pontos) + ' pts' +
            '<div style="font-size:0.75rem; color:#6b7280;">Saldo: ' + Number(m.saldo_posterior) + ' pts</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }
}

function renderizarListaPreferenciasPortal(prefs) {
  var box = document.getElementById('portal-preferencias-lista');
  if (!box) return;
  if (!prefs || prefs.length === 0) {
    box.innerHTML = '<p style="color:#6b7280;">Nenhuma preferência declarada até o momento.</p>';
    return;
  }
  box.innerHTML = prefs.map(function (pr) {
    return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0;">' +
      '<span class="portal-badge" style="background:#f3e8ff; color:#6b21a8;">' + escPortal(pr.categoria) + '</span> ' +
      '<strong style="margin-left:6px;">' + escPortal(pr.valor) + '</strong>' +
      (pr.observacao ? '<div style="font-size:0.8rem; color:#6b7280; margin-top:4px;">' + escPortal(pr.observacao) + '</div>' : '') +
    '</div>';
  }).join('');
}

async function salvarMinhaPreferenciaPortalUI() {
  var cat = (document.getElementById('portal-pref-categoria') || {}).value || 'sabor';
  var val = ((document.getElementById('portal-pref-valor') || {}).value || '').trim();
  var obs = ((document.getElementById('portal-pref-obs') || {}).value || '').trim();

  var resp = await supabaseClient.rpc('atualizar_minhas_preferencias_cliente', {
    p_categoria: cat,
    p_valor: val,
    p_observacao: obs || null
  });

  if (resp.error || !resp.data || !resp.data.success) {
    alert((resp.data && resp.data.error) || 'Não foi possível salvar sua preferência.');
    return;
  }

  var valInput = document.getElementById('portal-pref-valor');
  if (valInput) valInput.value = '';
  await inicializarPortalMinhaConta();
  mudarSecaoPortalCliente('preferencias');
}

async function atualizarMeuConsentimentoPortalUI(novoStatus) {
  var resp = await supabaseClient.rpc('atualizar_meu_consentimento_marketing', {
    p_canal: 'whatsapp_marketing',
    p_status: novoStatus,
    p_versao_termo: 'v1.0-portal'
  });

  if (resp.error || !resp.data || !resp.data.success) {
    alert((resp.data && resp.data.error) || 'Não foi possível atualizar sua preferência de privacidade.');
    return;
  }

  await inicializarPortalMinhaConta();
  await mudarSecaoPortalCliente('privacidade');
}

async function carregarMinhasComunicacoesPortalUI() {
  var box = document.getElementById('portal-comunicacoes-lista');
  if (!box) return;
  box.innerHTML = '<p style="color:#6b7280;">Carregando histórico de avisos...</p>';

  var resp = await supabaseClient.rpc('listar_minhas_comunicacoes', { p_limite: 20, p_offset: 0 });
  if (resp.error || !resp.data || !resp.data.success) {
    box.innerHTML = '<p style="color:#dc2626;">Erro ao carregar comunicações.</p>';
    return;
  }

  var lista = resp.data.comunicacoes || [];
  if (lista.length === 0) {
    box.innerHTML = '<p style="color:#6b7280;">Nenhuma comunicação registrada até o momento.</p>';
    return;
  }

  box.innerHTML = lista.map(function (c) {
    return '<div style="border-bottom:1px solid #f3f4f6; padding:10px 0; display:flex; justify-content:space-between; align-items:center;">' +
      '<div>' +
        '<strong>' + escPortal(c.descricao || c.tipo) + '</strong>' +
        '<div style="font-size:0.8rem; color:#6b7280;">Canal: ' + escPortal(c.canal) + ' • ' + dataPortal(c.data) + '</div>' +
      '</div>' +
      '<span class="portal-badge" style="background:#f3f4f6; color:#374151;">' + escPortal(c.status_publico) + '</span>' +
    '</div>';
  }).join('');
}

window.inicializarPortalMinhaConta = inicializarPortalMinhaConta;
window.realizarLoginPortalCliente = realizarLoginPortalCliente;
window.sairPortalMinhaConta = sairPortalMinhaConta;
window.mudarSecaoPortalCliente = mudarSecaoPortalCliente;
window.aprovarMeuOrcamentoPortalUI = aprovarMeuOrcamentoPortalUI;
window.salvarMinhaPreferenciaPortalUI = salvarMinhaPreferenciaPortalUI;
window.atualizarMeuConsentimentoPortalUI = atualizarMeuConsentimentoPortalUI;

document.addEventListener('DOMContentLoaded', inicializarPortalMinhaConta);
