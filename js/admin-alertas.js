// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE ALERTAS, AUDITORIA & SAÚDE GLOBAL (FRENTE N)
// ==============================================================================

let alertasCache = [];
let configuracoesAlertasCache = null;

export async function carregarAlertasAdmin() {
  const container = document.getElementById('admin-tab-alertas');
  if (!container) return;

  const usuarioAtual = JSON.parse(sessionStorage.getItem('lunoca_usuario') || '{}');
  if (usuarioAtual.nivel === 'operador') {
    renderizarVisaoOperador(container);
    return;
  }

  container.innerHTML = `
    <div class="alertas-admin-header" style="margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h2 style="margin: 0; font-size: 1.5rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
          <span>🚨</span> Central de Alertas & Saúde Global
        </h2>
        <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.9rem;">
          Monitoramento proativo de validade FEFO, rupturas, atrasos, margens críticas e diagnóstico sistêmico.
        </p>
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button id="btn-atualizar-alertas" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">
          🔄 Atualizar
        </button>
        <button id="btn-executar-healthcheck" class="btn btn-primary" style="padding: 0.5rem 1rem; border-radius: 6px; background: #6b2d5c; color: #fff; border: none; cursor: pointer;">
          🩺 Executar Health-Check
        </button>
      </div>
    </div>

    <!-- CARDS DE MÉTRICAS -->
    <div id="alertas-metricas-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
      <div style="background: #fff; padding: 1rem; border-radius: 8px; border-left: 4px solid #dc3545; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 0.8rem; color: #666; font-weight: 600;">CRÍTICOS</div>
        <div id="metrica-criticos" style="font-size: 1.8rem; font-weight: 700; color: #dc3545;">-</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 8px; border-left: 4px solid #ffc107; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 0.8rem; color: #666; font-weight: 600;">ATENÇÃO</div>
        <div id="metrica-atencao" style="font-size: 1.8rem; font-weight: 700; color: #d39e00;">-</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 8px; border-left: 4px solid #17a2b8; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 0.8rem; color: #666; font-weight: 600;">OPERACIONAIS</div>
        <div id="metrica-operacionais" style="font-size: 1.8rem; font-weight: 700; color: #17a2b8;">-</div>
      </div>
      <div style="background: #fff; padding: 1rem; border-radius: 8px; border-left: 4px solid #28a745; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <div style="font-size: 0.8rem; color: #666; font-weight: 600;">SAÚDE SISTÊMICA</div>
        <div id="metrica-saude" style="font-size: 1.2rem; font-weight: 700; color: #28a745; margin-top: 0.4rem;">OK</div>
      </div>
    </div>

    <!-- ABAS INTERNAS: ALERTAS, HEALTH-CHECK, AUDITORIA, CONFIGURAÇÕES -->
    <div style="display: flex; gap: 0.5rem; border-bottom: 2px solid #e9ecef; margin-bottom: 1.5rem;">
      <button id="subtab-alertas-btn" class="subtab-btn active" style="padding: 0.6rem 1.2rem; background: none; border: none; border-bottom: 2px solid #6b2d5c; font-weight: 600; cursor: pointer; color: #6b2d5c;">
        ⚠️ Alertas Pendentes
      </button>
      <button id="subtab-healthcheck-btn" class="subtab-btn" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #666;">
        🩺 Health-Check
      </button>
      <button id="subtab-auditoria-btn" class="subtab-btn" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #666;">
        📜 Trilha de Auditoria
      </button>
      <button id="subtab-config-btn" class="subtab-btn" style="padding: 0.6rem 1.2rem; background: none; border: none; font-weight: 600; cursor: pointer; color: #666;">
        ⚙️ Configurações
      </button>
    </div>

    <!-- CONTEÚDO SUB-ABA 1: ALERTAS -->
    <div id="subtab-alertas-content">
      <div style="margin-bottom: 1rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <label style="font-size: 0.85rem; font-weight: 600;">Filtrar Nível:</label>
        <select id="filtro-alerta-nivel" style="padding: 0.4rem 0.8rem; border-radius: 4px; border: 1px solid #ced4da;">
          <option value="">Todos os Níveis</option>
          <option value="CRITICO">🔴 Crítico</option>
          <option value="ATENCAO">🟠 Atenção</option>
          <option value="OPERACIONAL">🟡 Operacional</option>
        </select>
        <label style="font-size: 0.85rem; font-weight: 600; margin-left: 0.5rem;">Filtrar Tipo:</label>
        <select id="filtro-alerta-tipo" style="padding: 0.4rem 0.8rem; border-radius: 4px; border: 1px solid #ced4da;">
          <option value="">Todos os Tipos</option>
          <option value="RUPTURA_ESTOQUE">Ruptura de Insumo</option>
          <option value="LOTE_VENCIDO">Lote Vencido</option>
          <option value="LOTE_VENCIMENTO">Validade FEFO Próxima</option>
          <option value="ATRASO_PEDIDO">Risco de Atraso</option>
          <option value="MARGEM_CRITICA">Margem Crítica</option>
          <option value="QUALIDADE_RETIDA">Qualidade Retida</option>
        </select>
      </div>
      <div id="alertas-lista-container">Carregando alertas operacionais...</div>
    </div>

    <!-- CONTEÚDO SUB-ABA 2: HEALTH-CHECK -->
    <div id="subtab-healthcheck-content" style="display: none;">
      <div id="healthcheck-container">Clique em "Executar Health-Check" para iniciar o diagnóstico completo.</div>
    </div>

    <!-- CONTEÚDO SUB-ABA 3: AUDITORIA -->
    <div id="subtab-auditoria-content" style="display: none;">
      <div id="auditoria-container">Carregando trilha de auditoria...</div>
    </div>

    <!-- CONTEÚDO SUB-ABA 4: CONFIGURAÇÕES -->
    <div id="subtab-config-content" style="display: none;">
      <div style="max-width: 600px; background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        <h3 style="margin-top: 0; color: #2c1810; font-size: 1.1rem;">Limiares de Alertas Operacionais</h3>
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem;">
            Aviso de Validade FEFO (dias de antecedência):
          </label>
          <input type="number" id="cfg-dias-validade" min="1" max="90" style="width: 100%; padding: 0.5rem; border-radius: 4px; border: 1px solid #ced4da;">
        </div>
        <div style="margin-bottom: 1rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem;">
            Margem de Contribuição Mínima de Segurança (%):
          </label>
          <input type="number" id="cfg-margem-minima" min="0" max="100" step="0.5" style="width: 100%; padding: 0.5rem; border-radius: 4px; border: 1px solid #ced4da;">
        </div>
        <div style="margin-bottom: 1.5rem;">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.25rem;">
            Antecedência de Aviso de Atraso de Pedidos (minutos):
          </label>
          <input type="number" id="cfg-antecedencia-atraso" min="15" max="1440" step="15" style="width: 100%; padding: 0.5rem; border-radius: 4px; border: 1px solid #ced4da;">
        </div>
        <button id="btn-salvar-config-alertas" class="btn btn-primary" style="padding: 0.6rem 1.2rem; background: #6b2d5c; color: #fff; border: none; border-radius: 6px; cursor: pointer;">
          Salvar Configurações
        </button>
      </div>
    </div>
  `;

  vincularEventosSubabas();
  vincularBotoesPrincipais();
  await recarregarAlertas();
}

function vincularEventosSubabas() {
  const tabs = [
    { btn: 'subtab-alertas-btn', content: 'subtab-alertas-content' },
    { btn: 'subtab-healthcheck-btn', content: 'subtab-healthcheck-content', onOpen: executarHealthcheckUI },
    { btn: 'subtab-auditoria-btn', content: 'subtab-auditoria-content', onOpen: carregarAuditoriaUI },
    { btn: 'subtab-config-btn', content: 'subtab-config-content' },
  ];

  tabs.forEach((t) => {
    const elBtn = document.getElementById(t.btn);
    if (!elBtn) return;
    elBtn.addEventListener('click', () => {
      tabs.forEach((other) => {
        const b = document.getElementById(other.btn);
        const c = document.getElementById(other.content);
        if (b) {
          b.classList.remove('active');
          b.style.borderBottom = 'none';
          b.style.color = '#666';
        }
        if (c) c.style.display = 'none';
      });
      elBtn.classList.add('active');
      elBtn.style.borderBottom = '2px solid #6b2d5c';
      elBtn.style.color = '#6b2d5c';
      const targetContent = document.getElementById(t.content);
      if (targetContent) targetContent.style.display = 'block';
      if (t.onOpen) t.onOpen();
    });
  });
}

function vincularBotoesPrincipais() {
  const btnAtualizar = document.getElementById('btn-atualizar-alertas');
  if (btnAtualizar) btnAtualizar.addEventListener('click', recarregarAlertas);

  const btnHealthcheck = document.getElementById('btn-executar-healthcheck');
  if (btnHealthcheck) {
    btnHealthcheck.addEventListener('click', () => {
      const hcTab = document.getElementById('subtab-healthcheck-btn');
      if (hcTab) hcTab.click();
    });
  }

  const filtroNivel = document.getElementById('filtro-alerta-nivel');
  const filtroTipo = document.getElementById('filtro-alerta-tipo');
  if (filtroNivel) filtroNivel.addEventListener('change', renderizarListaAlertas);
  if (filtroTipo) filtroTipo.addEventListener('change', renderizarListaAlertas);

  const btnSalvarCfg = document.getElementById('btn-salvar-config-alertas');
  if (btnSalvarCfg) btnSalvarCfg.addEventListener('click', salvarConfiguracoesUI);
}

async function recarregarAlertas() {
  const container = document.getElementById('alertas-lista-container');
  if (!container) return;
  container.innerHTML = '<p style="color: #666;">Sincronizando e atualizando alertas...</p>';

  try {
    const res = await window.supabase.rpc('obter_alertas_operacionais_admin', {});
    if (!res.data || !res.data.success) {
      container.innerHTML = `<p style="color: #dc3545;">Erro ao obter alertas: ${res.error?.message || res.data?.error || 'Falha na requisição'}</p>`;
      return;
    }

    const { metricas, configuracoes, alertas } = res.data;
    alertasCache = alertas || [];
    configuracoesAlertasCache = configuracoes || {};

    // Atualizar métricas
    const elCrit = document.getElementById('metrica-criticos');
    const elAten = document.getElementById('metrica-atencao');
    const elOper = document.getElementById('metrica-operacionais');
    if (elCrit) elCrit.textContent = metricas.criticos || 0;
    if (elAten) elAten.textContent = metricas.atencao || 0;
    if (elOper) elOper.textContent = metricas.operacionais || 0;

    // Preencher campos de configuração
    if (configuracoes) {
      const elDias = document.getElementById('cfg-dias-validade');
      const elMargem = document.getElementById('cfg-margem-minima');
      const elAtraso = document.getElementById('cfg-antecedencia-atraso');
      if (elDias) elDias.value = configuracoes.dias_aviso_validade || 7;
      if (elMargem) elMargem.value = configuracoes.margem_minima_alvo || 30.00;
      if (elAtraso) elAtraso.value = configuracoes.antecedencia_atraso_minutos || 120;
    }

    renderizarListaAlertas();
  } catch (err) {
    console.error('Erro em recarregarAlertas:', err);
    container.innerHTML = `<p style="color: #dc3545;">Erro inesperado: ${err.message}</p>`;
  }
}

function renderizarListaAlertas() {
  const container = document.getElementById('alertas-lista-container');
  if (!container) return;

  const filtroNivel = document.getElementById('filtro-alerta-nivel')?.value || '';
  const filtroTipo = document.getElementById('filtro-alerta-tipo')?.value || '';

  const filtrados = alertasCache.filter((a) => {
    if (filtroNivel && a.nivel !== filtroNivel) return false;
    if (filtroTipo && a.tipo_alerta !== filtroTipo) return false;
    return true;
  });

  if (filtrados.length === 0) {
    container.innerHTML = `
      <div style="background: #e8f5e9; border: 1px solid #c8e6c9; padding: 1.5rem; border-radius: 8px; text-align: center; color: #2e7d32;">
        <strong>🎉 Nenhum alerta pendente!</strong> Todos os indicadores operacionais e insumos estão dentro dos parâmetros.
      </div>
    `;
    return;
  }

  let html = '<div style="display: flex; flex-direction: column; gap: 0.75rem;">';
  filtrados.forEach((alerta) => {
    const corNivel = alerta.nivel === 'CRITICO' ? '#dc3545' : alerta.nivel === 'ATENCAO' ? '#ffc107' : '#17a2b8';
    const bgNivel = alerta.nivel === 'CRITICO' ? '#fff5f5' : alerta.nivel === 'ATENCAO' ? '#fffdf0' : '#f0f9ff';

    const reconhecido = alerta.reconhecido_por && alerta.reconhecido_por.length > 0;
    const txtReconhecido = reconhecido
      ? `<span style="font-size: 0.75rem; background: #e2e3e5; color: #383d41; padding: 2px 6px; border-radius: 4px;">👁️ Reconhecido por ${alerta.reconhecido_por[0].usuario_nome}</span>`
      : `<button class="btn-reconhecer-alerta" data-id="${alerta.id}" style="padding: 0.3rem 0.6rem; font-size: 0.8rem; background: #fff; border: 1px solid #ced4da; border-radius: 4px; cursor: pointer;">Reconhecer</button>`;

    html += `
      <div style="background: ${bgNivel}; border: 1px solid #e9ecef; border-left: 4px solid ${corNivel}; border-radius: 6px; padding: 1rem; display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
        <div style="flex: 1;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <span style="font-size: 0.75rem; font-weight: 700; color: #fff; background: ${corNivel}; padding: 2px 6px; border-radius: 4px;">${alerta.nivel}</span>
            <span style="font-size: 0.75rem; font-weight: 600; color: #666;">${alerta.tipo_alerta}</span>
            <span style="font-size: 0.75rem; color: #999;">${new Date(alerta.criado_em).toLocaleString('pt-BR')}</span>
          </div>
          <h4 style="margin: 0 0 0.25rem; font-size: 1rem; color: #2c1810;">${alerta.titulo}</h4>
          <p style="margin: 0; font-size: 0.85rem; color: #555;">${alerta.descricao}</p>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${txtReconhecido}
        </div>
      </div>
    `;
  });
  html += '</div>';

  container.innerHTML = html;

  container.querySelectorAll('.btn-reconhecer-alerta').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const alertaId = e.target.getAttribute('data-id');
      const motivo = prompt('Observação do reconhecimento (opcional):', 'Ciente do alerta operacional');
      if (motivo === null) return;
      try {
        const res = await window.supabase.rpc('reconhecer_alerta_operacional', {
          p_alerta_id: Number(alertaId),
          p_motivo: motivo || 'Ciente do alerta'
        });
        if (res.data && res.data.success) {
          recarregarAlertas();
        } else {
          alert('Erro ao reconhecer alerta: ' + (res.error?.message || res.data?.error));
        }
      } catch (err) {
        alert('Erro ao reconhecer: ' + err.message);
      }
    });
  });
}

async function executarHealthcheckUI() {
  const container = document.getElementById('healthcheck-container');
  if (!container) return;
  container.innerHTML = '<p style="color: #666;">Executando diagnóstico global do sistema...</p>';

  try {
    const res = await window.supabase.rpc('executar_healthcheck_global_admin', {});
    if (!res.data || !res.data.success) {
      container.innerHTML = `<p style="color: #dc3545;">Erro ao executar health-check: ${res.error?.message || res.data?.error}</p>`;
      return;
    }

    const { status, executado_em, checks } = res.data;
    const elSaude = document.getElementById('metrica-saude');
    if (elSaude) {
      elSaude.textContent = status;
      elSaude.style.color = status === 'OK' ? '#28a745' : status === 'DEGRADED' ? '#ffc107' : '#dc3545';
    }

    let html = `
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: #fff; border-radius: 6px; border: 1px solid #ced4da;">
        <strong>Diagnóstico Realizado em:</strong> ${new Date(executado_em).toLocaleString('pt-BR')} &nbsp;|&nbsp;
        <strong>Status Consolidado:</strong> <span style="font-weight: 700; color: ${status === 'OK' ? '#28a745' : '#dc3545'}">${status}</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
    `;

    checks.forEach((c) => {
      const ok = c.status === 'OK';
      html += `
        <div style="background: #fff; border: 1px solid #ced4da; border-left: 4px solid ${ok ? '#28a745' : '#dc3545'}; border-radius: 6px; padding: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
            <strong style="color: #2c1810;">${c.nome}</strong>
            <span style="font-size: 0.8rem; font-weight: 700; color: #fff; background: ${ok ? '#28a745' : '#dc3545'}; padding: 2px 8px; border-radius: 4px;">${c.status}</span>
          </div>
          <div style="font-size: 0.85rem; color: #666;">
            Divergências detectadas: <strong>${c.divergencias}</strong>
          </div>
        </div>
      `;
    });
    html += '</div>';

    container.innerHTML = html;
  } catch (err) {
    console.error('Erro em executarHealthcheckUI:', err);
    container.innerHTML = `<p style="color: #dc3545;">Erro inesperado: ${err.message}</p>`;
  }
}

async function carregarAuditoriaUI() {
  const container = document.getElementById('auditoria-container');
  if (!container) return;
  container.innerHTML = '<p style="color: #666;">Carregando trilha de auditoria...</p>';

  try {
    const res = await window.supabase.rpc('listar_auditoria_operacional_admin', { p_limite: 30, p_offset: 0 });
    if (!res.data || !res.data.success) {
      container.innerHTML = `<p style="color: #dc3545;">Erro ao obter auditoria: ${res.error?.message || res.data?.error}</p>`;
      return;
    }

    const { eventos } = res.data;
    if (eventos.length === 0) {
      container.innerHTML = '<p style="color: #666;">Nenhum evento registrado na trilha de auditoria recente.</p>';
      return;
    }

    let html = `
      <table style="width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); font-size: 0.85rem;">
        <thead>
          <tr style="background: #f8f9fa; border-bottom: 2px solid #dee2e6; text-align: left;">
            <th style="padding: 0.75rem;">Data/Hora</th>
            <th style="padding: 0.75rem;">Evento</th>
            <th style="padding: 0.75rem;">Entidade</th>
            <th style="padding: 0.75rem;">Responsável</th>
            <th style="padding: 0.75rem;">Detalhes</th>
          </tr>
        </thead>
        <tbody>
    `;

    eventos.forEach((ev) => {
      html += `
        <tr style="border-bottom: 1px solid #dee2e6;">
          <td style="padding: 0.6rem 0.75rem; white-space: nowrap;">${new Date(ev.created_at).toLocaleString('pt-BR')}</td>
          <td style="padding: 0.6rem 0.75rem; font-weight: 600; color: #2c1810;">${ev.evento_tipo}</td>
          <td style="padding: 0.6rem 0.75rem;">${ev.entidade} #${ev.entidade_id}</td>
          <td style="padding: 0.6rem 0.75rem;">${ev.usuario_nome}</td>
          <td style="padding: 0.6rem 0.75rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 0.75rem;">
            ${JSON.stringify(ev.depois || {})}
          </td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    console.error('Erro em carregarAuditoriaUI:', err);
    container.innerHTML = `<p style="color: #dc3545;">Erro inesperado: ${err.message}</p>`;
  }
}

async function salvarConfiguracoesUI() {
  const elDias = document.getElementById('cfg-dias-validade');
  const elMargem = document.getElementById('cfg-margem-minima');
  const elAtraso = document.getElementById('cfg-antecedencia-atraso');

  const dias = elDias ? parseInt(elDias.value, 10) : 7;
  const margem = elMargem ? parseFloat(elMargem.value) : 30.00;
  const atraso = elAtraso ? parseInt(elAtraso.value, 10) : 120;

  try {
    const res = await window.supabase.rpc('salvar_configuracoes_alertas_admin', {
      p_dias_aviso_validade: dias,
      p_margem_minima_alvo: margem,
      p_antecedencia_atraso_minutos: atraso
    });

    if (res.data && res.data.success) {
      alert('Configurações salvas com sucesso!');
      recarregarAlertas();
    } else {
      alert('Erro ao salvar configurações: ' + (res.error?.message || res.data?.error));
    }
  } catch (err) {
    alert('Erro ao salvar: ' + err.message);
  }
}

function renderizarVisaoOperador(container) {
  container.innerHTML = `
    <div style="margin-bottom: 1rem;">
      <h2 style="margin: 0; font-size: 1.3rem; color: #2c1810;">⚠️ Alertas de Produção & Bancada</h2>
      <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.85rem;">Alertas operacionais imediatos para atenção da equipe.</p>
    </div>
    <div id="operador-alertas-lista">Carregando alertas...</div>
  `;

  window.supabase.rpc('obter_alertas_operacionais_operador', {}).then((res) => {
    const lista = document.getElementById('operador-alertas-lista');
    if (!lista) return;

    if (!res.data || !res.data.success || !res.data.alertas || res.data.alertas.length === 0) {
      lista.innerHTML = `
        <div style="background: #e8f5e9; border: 1px solid #c8e6c9; padding: 1.5rem; border-radius: 8px; text-align: center; color: #2e7d32;">
          <strong>🎉 Nenhum alerta pendente na bancada!</strong>
        </div>
      `;
      return;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 0.75rem;">';
    res.data.alertas.forEach((a) => {
      const cor = a.nivel === 'CRITICO' ? '#dc3545' : '#ffc107';
      html += `
        <div style="background: #fff; border-left: 4px solid ${cor}; border: 1px solid #dee2e6; border-radius: 6px; padding: 0.75rem 1rem;">
          <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.25rem;">
            <span style="font-size: 0.75rem; font-weight: 700; color: #fff; background: ${cor}; padding: 2px 6px; border-radius: 4px;">${a.nivel}</span>
            <span style="font-size: 0.75rem; font-weight: 600; color: #555;">${a.tipo_alerta}</span>
          </div>
          <strong style="color: #2c1810;">${a.titulo}</strong>
          <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #666;">${a.descricao}</p>
        </div>
      `;
    });
    html += '</div>';
    lista.innerHTML = html;
  });
}
