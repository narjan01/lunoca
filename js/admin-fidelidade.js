// ==============================================================================
// LUNOCA DOCERIA — MÓDULO ADMINISTRATIVO: FIDELIDADE, RECOMPRA E CAMPANHAS (FRENTE I)
// ==============================================================================
// Consome exclusivamente as RPCs canônicas da Migration 024:
// - obter_painel_fidelidade_campanhas_admin
// - ajustar_pontos_fidelidade_admin
// - resgatar_pontos_fidelidade
// - expirar_pontos_fidelidade
// - salvar_cupom_promocional_admin
// - salvar_campanha_admin
// - avaliar_publico_campanha
// - disparar_campanha_marketing
// - registrar_consentimento_marketing
// ==============================================================================

var subAbaFidelidadeAtual = 'pontos';
var dadosPainelFidelidadeCache = null;

function formatarMoedaFid(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeFid(str) {
  if (typeof escapeHTML === 'function') return escapeHTML(String(str ?? ''));
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mudarSubAbaFidelidade(aba) {
  subAbaFidelidadeAtual = aba;
  document.querySelectorAll('.btn-subaba-fidelidade').forEach(function (b) {
    b.classList.remove('active');
  });
  var btn = document.getElementById('btn-subaba-fidelidade-' + aba);
  if (btn) btn.classList.add('active');
  renderizarConteudoFidelidadeAdmin();
}

async function carregarFidelidadeCampanhasAdmin() {
  var container = document.getElementById('fidelidade-conteudo-dinamico');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center; padding:32px; color:#64748b;"><i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:10px; display:block;"></i>Carregando Clube de Fidelidade, Cupons e Campanhas...</div>';

  try {
    var resp = await supabaseClient.rpc('obter_painel_fidelidade_campanhas_admin');
    if (resp.error) throw resp.error;
    var data = resp.data;
    if (!data || !data.success) {
      throw new Error((data && data.error) || 'Falha ao carregar painel de fidelidade.');
    }
    dadosPainelFidelidadeCache = data;
    renderizarConteudoFidelidadeAdmin();
  } catch (err) {
    console.error('[Fidelidade Admin] Erro:', err);
    container.innerHTML = '<div style="padding:18px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b; font-size:13px;">' + escapeFid(err.message || 'Erro ao consultar fidelidade.') + '</div>';
  }
}

function renderizarConteudoFidelidadeAdmin() {
  var container = document.getElementById('fidelidade-conteudo-dinamico');
  if (!container || !dadosPainelFidelidadeCache) return;

  var r = dadosPainelFidelidadeCache.resumo || {};
  var prog = dadosPainelFidelidadeCache.programa || {};
  var isAdm = typeof usuarioAtual !== 'undefined' && usuarioAtual && usuarioAtual.nivel === 'admin';

  var kpiHtml = ''
    + '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(185px, 1fr)); gap:12px; margin-bottom:16px;">'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">'
    + '    <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Pontos em Circulação</div>'
    + '    <div style="font-size:22px; font-weight:800; color:#7c3aed; margin-top:4px;">' + Number(r.saldo_pontos_circulacao || 0) + ' pts</div>'
    + '    <div style="font-size:11px; color:#64748b;">' + Number(r.clientes_com_pontos || 0) + ' clientes c/ saldo</div>'
    + '  </div>'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">'
    + '    <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Pontos Resgatados</div>'
    + '    <div style="font-size:22px; font-weight:800; color:#059669; margin-top:4px;">' + Number(r.pontos_resgatados_total || 0) + ' pts</div>'
    + '    <div style="font-size:11px; color:#64748b;">Expirados: ' + Number(r.pontos_expirados_total || 0) + ' pts</div>'
    + '  </div>'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">'
    + '    <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Cupons Ativos</div>'
    + '    <div style="font-size:22px; font-weight:800; color:#0284c7; margin-top:4px;">' + Number(r.cupons_ativos || 0) + '</div>'
    + '    <div style="font-size:11px; color:#64748b;">Regra: 1 pt = ' + formatarMoedaFid(prog.valor_por_ponto_resgate || 0.05) + '</div>'
    + '  </div>'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px;">'
    + '    <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Opt-in WhatsApp Mkt</div>'
    + '    <div style="font-size:22px; font-weight:800; color:#16a34a; margin-top:4px;">' + Number(r.clientes_opt_in_whatsapp || 0) + '</div>'
    + '    <div style="font-size:11px; color:#64748b;">Campanhas: ' + Number(r.campanhas_registradas || 0) + '</div>'
    + '  </div>'
    + '</div>';

  if (subAbaFidelidadeAtual === 'pontos') {
    container.innerHTML = kpiHtml + renderizarSubAbaPontosFid(isAdm);
  } else if (subAbaFidelidadeAtual === 'cupons') {
    container.innerHTML = kpiHtml + renderizarSubAbaCuponsFid(isAdm);
  } else if (subAbaFidelidadeAtual === 'campanhas') {
    container.innerHTML = kpiHtml + renderizarSubAbaCampanhasFid(isAdm);
  } else if (subAbaFidelidadeAtual === 'consentimento') {
    container.innerHTML = kpiHtml + renderizarSubAbaConsentimentoFid();
  }
}

function renderizarSubAbaPontosFid(isAdm) {
  var clientes = dadosPainelFidelidadeCache.clientes_pontos || [];
  var movs = dadosPainelFidelidadeCache.movimentacoes_recentes || [];

  var formAdminHtml = '';
  if (isAdm) {
    formAdminHtml = ''
      + '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; margin-bottom:14px;">'
      + '  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">'
      + '    <h4 style="margin:0; font-size:14px; color:#0f172a;"><i class="fa-solid fa-sliders" style="color:var(--primary);"></i> Ajuste Auditável de Pontos (Apenas Admin)</h4>'
      + '    <button type="button" onclick="executarExpiracaoPontosUI()" class="btn-outline" style="padding:5px 12px; font-size:12px; border-radius:8px;"><i class="fa-solid fa-hourglass-end"></i> Processar Expiração de Lotes Vencidos</button>'
      + '  </div>'
      + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; align-items:end;">'
      + '    <div><label style="font-size:11px; font-weight:600;">ID do Cliente</label><input type="number" id="fid-aj-cliente-id" placeholder="Ex: 12" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Natureza</label><select id="fid-aj-natureza" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"><option value="credito">Crédito (+ Pontos)</option><option value="debito">Débito (- Pontos)</option></select></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Pontos</label><input type="number" id="fid-aj-pontos" min="1" placeholder="Ex: 50" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Motivo Auditável (mín. 5 chars)</label><input type="text" id="fid-aj-motivo" placeholder="Ex: Bonificação aniversário" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <button type="button" onclick="submeterAjustePontosAdminUI()" class="btn-primary" style="padding:8px 14px; font-size:12px; border-radius:8px;">Aplicar Ajuste</button>'
      + '  </div>'
      + '</div>';
  }

  var rowsCli = clientes.map(function (c) {
    var badgeConsent = c.consentimento_whatsapp === 'opt_in'
      ? '<span style="background:#dcfce7; color:#166534; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700;">Opt-In</span>'
      : '<span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700;">' + escapeFid(c.consentimento_whatsapp) + '</span>';
    return '<tr style="border-bottom:1px solid #f1f5f9;">'
      + '<td style="padding:8px;">#' + Number(c.cliente_id) + ' - <strong>' + escapeFid(c.cliente_nome) + '</strong></td>'
      + '<td style="padding:8px;">' + escapeFid(c.telefone || '-') + '</td>'
      + '<td style="padding:8px; font-weight:800; color:#7c3aed;">' + Number(c.saldo_pontos) + ' pts</td>'
      + '<td style="padding:8px;">' + Number(c.pontos_acumulados_total) + ' / ' + Number(c.pontos_resgatados_total) + '</td>'
      + '<td style="padding:8px;">' + badgeConsent + '</td>'
      + '</tr>';
  }).join('');

  var rowsMov = movs.map(function (m) {
    var cor = m.natureza === 'credito' ? '#16a34a' : '#dc2626';
    var sinal = m.natureza === 'credito' ? '+' : '-';
    return '<tr style="border-bottom:1px solid #f1f5f9;">'
      + '<td style="padding:8px;">#' + Number(m.id) + '</td>'
      + '<td style="padding:8px;">' + escapeFid(m.cliente_nome) + '</td>'
      + '<td style="padding:8px;"><span style="font-size:11px; font-weight:700;">' + escapeFid(m.tipo) + '</span></td>'
      + '<td style="padding:8px; font-weight:800; color:' + cor + ';">' + sinal + Number(m.pontos) + ' pts</td>'
      + '<td style="padding:8px;">' + Number(m.saldo_posterior) + ' pts</td>'
      + '<td style="padding:8px; font-size:12px; color:#475569;">' + escapeFid(m.motivo) + '</td>'
      + '</tr>';
  }).join('');

  return formAdminHtml
    + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">'
    + '    <h4 style="margin:0 0 10px 0; font-size:14px;">Saldos de Pontos por Cliente</h4>'
    + '    <table style="width:100%; border-collapse:collapse; font-size:12px;">'
    + '      <thead><tr style="background:#f8fafc; text-align:left;"><th style="padding:8px;">Cliente</th><th style="padding:8px;">Telefone</th><th style="padding:8px;">Saldo</th><th style="padding:8px;">Acum/Resg</th><th style="padding:8px;">Mkt</th></tr></thead>'
    + '      <tbody>' + (rowsCli || '<tr><td colspan="5" style="padding:14px; text-align:center; color:#94a3b8;">Nenhum saldo de pontos registrado.</td></tr>') + '</tbody>'
    + '    </table>'
    + '  </div>'
    + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">'
    + '    <h4 style="margin:0 0 10px 0; font-size:14px;">Livro-Razão de Pontos (Append-Only)</h4>'
    + '    <table style="width:100%; border-collapse:collapse; font-size:12px;">'
    + '      <thead><tr style="background:#f8fafc; text-align:left;"><th style="padding:8px;">ID</th><th style="padding:8px;">Cliente</th><th style="padding:8px;">Evento</th><th style="padding:8px;">Pts</th><th style="padding:8px;">Saldo</th><th style="padding:8px;">Motivo</th></tr></thead>'
    + '      <tbody>' + (rowsMov || '<tr><td colspan="6" style="padding:14px; text-align:center; color:#94a3b8;">Nenhuma movimentação registrada.</td></tr>') + '</tbody>'
    + '    </table>'
    + '  </div>'
    + '</div>';
}

function renderizarSubAbaCuponsFid(isAdm) {
  var cupons = dadosPainelFidelidadeCache.cupons || [];
  var formHtml = '';
  if (isAdm) {
    formHtml = ''
      + '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; margin-bottom:14px;">'
      + '  <h4 style="margin:0 0 10px 0; font-size:14px;"><i class="fa-solid fa-ticket" style="color:var(--primary);"></i> Criar / Atualizar Cupom Promocional</h4>'
      + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px; align-items:end;">'
      + '    <div><label style="font-size:11px; font-weight:600;">Código</label><input type="text" id="fid-cupom-codigo" placeholder="Ex: ANIV10" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px; text-transform:uppercase;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Tipo</label><select id="fid-cupom-tipo" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"><option value="percentual">Percentual (%)</option><option value="valor_fixo">Valor Fixo (R$)</option></select></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Valor</label><input type="number" step="0.01" id="fid-cupom-valor" placeholder="10.00" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Pedido Mínimo (R$)</label><input type="number" step="0.01" id="fid-cupom-minimo" value="50.00" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Validade Fim</label><input type="date" id="fid-cupom-validade" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <button type="button" onclick="salvarCupomPromocionalUI()" class="btn-primary" style="padding:8px 14px; font-size:12px; border-radius:8px;">Salvar Cupom</button>'
      + '  </div>'
      + '</div>';
  }

  var rows = cupons.map(function (c) {
    var valFmt = c.tipo === 'percentual' ? Number(c.valor) + '%' : formatarMoedaFid(c.valor);
    return '<tr style="border-bottom:1px solid #f1f5f9;">'
      + '<td style="padding:8px; font-weight:800; color:#0284c7;">' + escapeFid(c.codigo) + '</td>'
      + '<td style="padding:8px;">' + escapeFid(c.tipo) + ' (' + valFmt + ')</td>'
      + '<td style="padding:8px;">' + formatarMoedaFid(c.pedido_minimo) + '</td>'
      + '<td style="padding:8px;">' + Number(c.total_usos || 0) + ' / ' + (c.uso_maximo_global || '∞') + ' (máx/cli: ' + Number(c.uso_maximo_cliente) + ')</td>'
      + '<td style="padding:8px;">' + escapeFid(String(c.validade_fim || '').slice(0, 10)) + '</td>'
      + '<td style="padding:8px;">' + (c.ativo ? 'Ativo' : 'Inativo') + '</td>'
      + '</tr>';
  }).join('');

  return formHtml
    + '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">'
    + '  <h4 style="margin:0 0 10px 0; font-size:14px;">Cupons Promocionais Cadastrados</h4>'
    + '  <table style="width:100%; border-collapse:collapse; font-size:12px;">'
    + '    <thead><tr style="background:#f8fafc; text-align:left;"><th style="padding:8px;">Código</th><th style="padding:8px;">Benefício</th><th style="padding:8px;">Pedido Mín.</th><th style="padding:8px;">Usos</th><th style="padding:8px;">Validade</th><th style="padding:8px;">Status</th></tr></thead>'
    + '    <tbody>' + (rows || '<tr><td colspan="6" style="padding:14px; text-align:center; color:#94a3b8;">Nenhum cupom cadastrado.</td></tr>') + '</tbody>'
    + '  </table>'
    + '</div>';
}

function renderizarSubAbaCampanhasFid(isAdm) {
  var campanhas = dadosPainelFidelidadeCache.campanhas || [];
  var formHtml = '';
  if (isAdm) {
    formHtml = ''
      + '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; margin-bottom:14px;">'
      + '  <h4 style="margin:0 0 10px 0; font-size:14px;"><i class="fa-solid fa-bullhorn" style="color:var(--primary);"></i> Nova Campanha de Recompra / Relacionamento</h4>'
      + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:8px; margin-bottom:8px;">'
      + '    <div><label style="font-size:11px; font-weight:600;">Código</label><input type="text" id="fid-camp-codigo" placeholder="Ex: RECOMPRA_OUT" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px; text-transform:uppercase;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Nome</label><input type="text" id="fid-camp-nome" placeholder="Ex: Clientes Inativos 30d" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Template</label><select id="fid-camp-template" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;">'
      + '      <option value="VOLTE_A_COMPRAR">VOLTE_A_COMPRAR</option>'
      + '      <option value="CUPOM_ANIVERSARIO">CUPOM_ANIVERSARIO</option>'
      + '      <option value="CAMPANHA_PASCOA">CAMPANHA_PASCOA</option>'
      + '      <option value="CAMPANHA_PROMOCIONAL">CAMPANHA_PROMOCIONAL</option>'
      + '      <option value="LEMBRETE_PONTOS_EXPIRANDO">LEMBRETE_PONTOS_EXPIRANDO</option>'
      + '    </select></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Segmento Dinâmico</label><select id="fid-camp-segmento" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;">'
      + '      <option value="recorrentes">Clientes Recorrentes (2+ pedidos)</option>'
      + '      <option value="inativos">Inativos há 30+ dias</option>'
      + '      <option value="aniversariantes">Aniversariantes do Mês</option>'
      + '      <option value="alto_ticket">Alto Ticket (>= R$ 150)</option>'
      + '      <option value="orcamento_nao_convertido">Orçamento Não Convertido</option>'
      + '      <option value="pontos_expirando">Saldo de Pontos Expirando</option>'
      + '      <option value="todos">Todos os Clientes</option>'
      + '    </select></div>'
      + '    <div><label style="font-size:11px; font-weight:600;">Bônus de Pontos</label><input type="number" id="fid-camp-bonus" value="0" min="0" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '  </div>'
      + '  <div style="display:flex; gap:8px; align-items:end;">'
      + '    <div style="flex:1;"><label style="font-size:11px; font-weight:600;">Mensagem (variáveis: {{nome}}, {{pontos}}, {{cupom}})</label><input type="text" id="fid-camp-msg" placeholder="Olá {{nome}}! Você possui {{pontos}} pontos no Clube Lunoca!" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
      + '    <button type="button" onclick="salvarCampanhaAdminUI()" class="btn-primary" style="padding:8px 16px; font-size:12px; border-radius:8px;">Salvar Campanha</button>'
      + '  </div>'
      + '</div>';
  }

  var rows = campanhas.map(function (ca) {
    var seg = (ca.regra_segmentacao && ca.regra_segmentacao.segmento) || 'todos';
    var btnDisparo = isAdm
      ? '<button type="button" onclick="dispararCampanhaMarketingUI(' + Number(ca.id) + ')" class="btn-primary" style="padding:4px 10px; font-size:11px; border-radius:6px;"><i class="fa-brands fa-whatsapp"></i> Disparar p/ Opt-In</button>'
      : '-';
    return '<tr style="border-bottom:1px solid #f1f5f9;">'
      + '<td style="padding:8px;"><strong>' + escapeFid(ca.codigo) + '</strong><br><span style="font-size:11px; color:#64748b;">' + escapeFid(ca.nome) + '</span></td>'
      + '<td style="padding:8px;">' + escapeFid(ca.tipo_template) + '</td>'
      + '<td style="padding:8px;">' + escapeFid(seg) + '</td>'
      + '<td style="padding:8px; color:#16a34a; font-weight:700;">' + Number(ca.total_disparados || 0) + '</td>'
      + '<td style="padding:8px; color:#dc2626;">' + Number(ca.total_bloqueados || 0) + '</td>'
      + '<td style="padding:8px;">' + escapeFid(ca.status) + '</td>'
      + '<td style="padding:8px;">' + btnDisparo + '</td>'
      + '</tr>';
  }).join('');

  return formHtml
    + '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px; overflow-x:auto;">'
    + '  <h4 style="margin:0 0 10px 0; font-size:14px;">Campanhas & Auditoria de Audiência</h4>'
    + '  <table style="width:100%; border-collapse:collapse; font-size:12px;">'
    + '    <thead><tr style="background:#f8fafc; text-align:left;"><th style="padding:8px;">Campanha</th><th style="padding:8px;">Template</th><th style="padding:8px;">Segmento</th><th style="padding:8px;">Disparados (Opt-In)</th><th style="padding:8px;">Bloqueados (Sem Opt-In)</th><th style="padding:8px;">Status</th><th style="padding:8px;">Ação</th></tr></thead>'
    + '    <tbody>' + (rows || '<tr><td colspan="7" style="padding:14px; text-align:center; color:#94a3b8;">Nenhuma campanha registrada.</td></tr>') + '</tbody>'
    + '  </table>'
    + '</div>';
}

function renderizarSubAbaConsentimentoFid() {
  return ''
    + '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">'
    + '  <h4 style="margin:0 0 8px 0; font-size:14px;"><i class="fa-solid fa-user-shield" style="color:var(--primary);"></i> Registrar Consentimento de Marketing (LGPD Opt-In / Opt-Out)</h4>'
    + '  <p style="margin:0 0 12px 0; font-size:12px; color:#64748b;">O consentimento promocional é estritamente separado das mensagens operacionais (Pedido Pronto, Sinal Confirmado e Orçamento).</p>'
    + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; align-items:end;">'
    + '    <div><label style="font-size:11px; font-weight:600;">ID do Cliente</label><input type="number" id="fid-cons-cliente-id" placeholder="Ex: 12" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
    + '    <div><label style="font-size:11px; font-weight:600;">Canal</label><select id="fid-cons-canal" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"><option value="whatsapp_marketing">WhatsApp Marketing</option><option value="email_marketing">E-mail Marketing</option><option value="sms_marketing">SMS Marketing</option></select></div>'
    + '    <div><label style="font-size:11px; font-weight:600;">Decisão do Cliente</label><select id="fid-cons-status" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"><option value="opt_in">Opt-In (Autorizado)</option><option value="opt_out">Opt-Out (Revogado)</option></select></div>'
    + '    <div><label style="font-size:11px; font-weight:600;">Origem</label><input type="text" id="fid-cons-origem" value="whatsapp_atendimento" style="width:100%; padding:7px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;"></div>'
    + '    <button type="button" onclick="registrarConsentimentoMarketingUI()" class="btn-primary" style="padding:8px 14px; font-size:12px; border-radius:8px;">Registrar Consentimento</button>'
    + '  </div>'
    + '</div>';
}

async function submeterAjustePontosAdminUI() {
  var cliId = Number((document.getElementById('fid-aj-cliente-id') || {}).value || 0);
  var natureza = (document.getElementById('fid-aj-natureza') || {}).value || 'credito';
  var pontos = Number((document.getElementById('fid-aj-pontos') || {}).value || 0);
  var motivo = ((document.getElementById('fid-aj-motivo') || {}).value || '').trim();

  var resp = await supabaseClient.rpc('ajustar_pontos_fidelidade_admin', {
    p_cliente_id: cliId,
    p_natureza: natureza,
    p_pontos: pontos,
    p_motivo: motivo
  });
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast((resp.data && resp.data.error) || (resp.error && resp.error.message) || 'Erro ao ajustar pontos.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') mostrarToast('Ajuste de pontos registrado com sucesso!', 'sucesso', 3000);
  await carregarFidelidadeCampanhasAdmin();
}

async function executarExpiracaoPontosUI() {
  var resp = await supabaseClient.rpc('expirar_pontos_fidelidade', {});
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast('Erro ao processar expiração de pontos.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') mostrarToast('Expiração concluída: ' + Number(resp.data.pontos_expirados || 0) + ' pontos expirados.', 'sucesso', 3500);
  await carregarFidelidadeCampanhasAdmin();
}

async function salvarCupomPromocionalUI() {
  var codigo = ((document.getElementById('fid-cupom-codigo') || {}).value || '').trim();
  var tipo = (document.getElementById('fid-cupom-tipo') || {}).value || 'percentual';
  var valor = Number((document.getElementById('fid-cupom-valor') || {}).value || 0);
  var minimo = Number((document.getElementById('fid-cupom-minimo') || {}).value || 0);
  var validade = (document.getElementById('fid-cupom-validade') || {}).value;

  if (!validade) {
    if (typeof mostrarToast === 'function') mostrarToast('Informe a data de validade do cupom.', 'aviso', 3000);
    return;
  }

  var resp = await supabaseClient.rpc('salvar_cupom_promocional_admin', {
    p_codigo: codigo,
    p_tipo: tipo,
    p_valor: valor,
    p_validade_fim: validade + 'T23:59:59-03:00',
    p_pedido_minimo: minimo
  });
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast((resp.data && resp.data.error) || 'Erro ao salvar cupom.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') mostrarToast('Cupom ' + resp.data.codigo + ' salvo com sucesso!', 'sucesso', 3000);
  await carregarFidelidadeCampanhasAdmin();
}

async function salvarCampanhaAdminUI() {
  var codigo = ((document.getElementById('fid-camp-codigo') || {}).value || '').trim();
  var nome = ((document.getElementById('fid-camp-nome') || {}).value || '').trim();
  var template = (document.getElementById('fid-camp-template') || {}).value || 'VOLTE_A_COMPRAR';
  var segmento = (document.getElementById('fid-camp-segmento') || {}).value || 'todos';
  var bonus = Number((document.getElementById('fid-camp-bonus') || {}).value || 0);
  var msg = ((document.getElementById('fid-camp-msg') || {}).value || '').trim();

  var resp = await supabaseClient.rpc('salvar_campanha_admin', {
    p_codigo: codigo,
    p_nome: nome,
    p_tipo_template: template,
    p_mensagem_template: msg,
    p_regra_segmentacao: { segmento: segmento },
    p_bonus_pontos: bonus
  });
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast((resp.data && resp.data.error) || 'Erro ao salvar campanha.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') mostrarToast('Campanha ' + resp.data.codigo + ' criada com sucesso!', 'sucesso', 3000);
  await carregarFidelidadeCampanhasAdmin();
}

async function dispararCampanhaMarketingUI(campanhaId) {
  var resp = await supabaseClient.rpc('disparar_campanha_marketing', {
    p_campanha_id: campanhaId,
    p_canal_envio: 'whatsapp_link'
  });
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast((resp.data && resp.data.error) || 'Erro ao disparar campanha.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') {
    mostrarToast(
      'Campanha processada: ' + Number(resp.data.disparados || 0) + ' enviados (Opt-In) e ' + Number(resp.data.bloqueados_sem_consentimento || 0) + ' bloqueados sem Opt-In.',
      'sucesso',
      4500
    );
  }
  await carregarFidelidadeCampanhasAdmin();
}

async function registrarConsentimentoMarketingUI() {
  var cliId = Number((document.getElementById('fid-cons-cliente-id') || {}).value || 0);
  var canal = (document.getElementById('fid-cons-canal') || {}).value || 'whatsapp_marketing';
  var status = (document.getElementById('fid-cons-status') || {}).value || 'opt_in';
  var origem = ((document.getElementById('fid-cons-origem') || {}).value || 'painel_admin').trim();

  var resp = await supabaseClient.rpc('registrar_consentimento_marketing', {
    p_cliente_id: cliId,
    p_canal: canal,
    p_status: status,
    p_origem: origem,
    p_versao_termo: 'v1.0'
  });
  if (resp.error || !resp.data || !resp.data.success) {
    if (typeof mostrarToast === 'function') mostrarToast((resp.data && resp.data.error) || 'Erro ao registrar consentimento.', 'erro', 4000);
    return;
  }
  if (typeof mostrarToast === 'function') mostrarToast('Consentimento (' + status + ') registrado com sucesso!', 'sucesso', 3000);
  await carregarFidelidadeCampanhasAdmin();
}

window.carregarFidelidadeCampanhasAdmin = carregarFidelidadeCampanhasAdmin;
window.mudarSubAbaFidelidade = mudarSubAbaFidelidade;
window.submeterAjustePontosAdminUI = submeterAjustePontosAdminUI;
window.executarExpiracaoPontosUI = executarExpiracaoPontosUI;
window.salvarCupomPromocionalUI = salvarCupomPromocionalUI;
window.salvarCampanhaAdminUI = salvarCampanhaAdminUI;
window.dispararCampanhaMarketingUI = dispararCampanhaMarketingUI;
window.registrarConsentimentoMarketingUI = registrarConsentimentoMarketingUI;
