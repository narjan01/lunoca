// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE LOGÍSTICA, ROTAS E ENTREGAS (FRENTE K)
// ==============================================================================
// Regras de Arquitetura:
// 1. Consome exclusivamente as RPCs canônicas da Migration 026:
//    - obter_painel_logistica
//    - criar_rota_entrega_admin
//    - atribuir_entrega_rota
//    - reordenar_rota_entrega
//    - despachar_pedido_entrega
//    - registrar_falha_entrega
//    - reagendar_entrega
//    - confirmar_entrega_pedido
//    - registrar_comprovante_entrega
// 2. WhatsApp reutiliza estritamente a trilha canônica da Frente B
//    (window.abrirFluxoWhatsAppComunicacao), sem montar link wa.me manual.
// ==============================================================================

var estadoLogisticaAdmin = {
  subAbaAtual: 'expedicao',
  dataReferencia: new Date().toISOString().slice(0, 10),
  painel: null
};

function escLog(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mudarSubAbaLogistica(subAba) {
  estadoLogisticaAdmin.subAbaAtual = subAba || 'expedicao';
  document.querySelectorAll('.btn-subaba-logistica').forEach((btn) => {
    btn.classList.remove('active');
  });
  const btnAtivo = document.getElementById('btn-subaba-logistica-' + estadoLogisticaAdmin.subAbaAtual);
  if (btnAtivo) btnAtivo.classList.add('active');
  renderizarPainelLogisticaAdmin();
}

async function carregarLogisticaAdmin() {
  const container = document.getElementById('logistica-conteudo-dinamico');
  if (!container) return;

  const inputData = document.getElementById('logistica-data-ref');
  if (inputData && inputData.value) {
    estadoLogisticaAdmin.dataReferencia = inputData.value;
  } else if (inputData && !inputData.value) {
    inputData.value = estadoLogisticaAdmin.dataReferencia;
  }

  container.innerHTML = `
    <div style="text-align:center; padding:36px; color:#64748b; background:#fff; border-radius:14px; border:1px solid #e2e8f0;">
      <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:10px;"></i>
      <div>Carregando painel de logística, rotas e expedição...</div>
    </div>
  `;

  try {
    const { data, error } = await supabaseClient.rpc('obter_painel_logistica', {
      p_data: estadoLogisticaAdmin.dataReferencia || null
    });

    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Não foi possível carregar o painel de logística.');
    }

    estadoLogisticaAdmin.painel = data;
    renderizarPainelLogisticaAdmin();
  } catch (err) {
    console.error('[Logística Admin] Erro:', err);
    container.innerHTML = `
      <div style="padding:24px; background:#fef2f2; border:1px solid #fecaca; border-radius:12px; color:#991b1b;">
        <strong>Erro ao carregar logística:</strong> ${escLog(err.message)}
      </div>
    `;
  }
}

function renderizarPainelLogisticaAdmin() {
  const container = document.getElementById('logistica-conteudo-dinamico');
  if (!container || !estadoLogisticaAdmin.painel) return;

  const p = estadoLogisticaAdmin.painel;
  const res = p.resumo || {};
  const rotas = Array.isArray(p.rotas_do_dia) ? p.rotas_do_dia : [];

  const cardsResumoHtml = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px; margin-bottom:18px;">
      <div style="background:#fff; padding:14px; border-radius:12px; border:1px solid #e2e8f0; border-left:4px solid #f59e0b;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Expedição (Prontos)</div>
        <div style="font-size:22px; font-weight:800; color:#b45309; margin-top:4px;">${Number(res.prontos_expedicao || 0)}</div>
        <div style="font-size:11px; color:#64748b;">Aguardando saída</div>
      </div>
      <div style="background:#fff; padding:14px; border-radius:12px; border:1px solid #e2e8f0; border-left:4px solid #3b82f6;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Rotas do Dia</div>
        <div style="font-size:22px; font-weight:800; color:#1d4ed8; margin-top:4px;">${Number(res.rotas_no_dia || 0)}</div>
        <div style="font-size:11px; color:#64748b;">Manhã / Tarde / Noite</div>
      </div>
      <div style="background:#fff; padding:14px; border-radius:12px; border:1px solid #e2e8f0; border-left:4px solid #0284c7;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Em Rota</div>
        <div style="font-size:22px; font-weight:800; color:#0369a1; margin-top:4px;">${Number(res.em_rota || 0)}</div>
        <div style="font-size:11px; color:#64748b;">Saiu para entrega</div>
      </div>
      <div style="background:#fff; padding:14px; border-radius:12px; border:1px solid #e2e8f0; border-left:4px solid #ef4444;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Falhas / Reagendados</div>
        <div style="font-size:22px; font-weight:800; color:#b91c1c; margin-top:4px;">${Number(res.com_falha_ou_reagendados || 0)}</div>
        <div style="font-size:11px; color:#64748b;">Exigem nova tentativa</div>
      </div>
      <div style="background:#fff; padding:14px; border-radius:12px; border:1px solid #e2e8f0; border-left:4px solid #10b981;">
        <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">Entregues no Dia</div>
        <div style="font-size:22px; font-weight:800; color:#047857; margin-top:4px;">${Number(res.entregues_no_dia || 0)}</div>
        <div style="font-size:11px; color:#64748b;">Com comprovante</div>
      </div>
    </div>
  `;

  if (estadoLogisticaAdmin.subAbaAtual === 'expedicao') {
    container.innerHTML = cardsResumoHtml + renderizarSubAbaExpedicao(p.expedicao_aguardando || [], rotas);
  } else if (estadoLogisticaAdmin.subAbaAtual === 'rotas') {
    container.innerHTML = cardsResumoHtml + renderizarSubAbaRotas(rotas);
  } else {
    container.innerHTML = cardsResumoHtml + renderizarSubAbaEmRota(p.em_rota_e_ocorrencias || []);
  }
}

function renderizarSubAbaExpedicao(lista, rotas) {
  if (!lista.length) {
    return `
      <div style="background:#fff; padding:32px; border-radius:14px; border:1px solid #e2e8f0; text-align:center; color:#64748b;">
        <i class="fa-solid fa-box-open fa-2x" style="color:#94a3b8; margin-bottom:8px;"></i>
        <div>Nenhum pedido de entrega pronto aguardando expedição nesta data.</div>
        <small>Pedidos na modalidade retirada na loja permanecem no fluxo de balcão e não entram em rotas.</small>
      </div>
    `;
  }

  const opcoesRotas = rotas
    .filter((r) => r.status !== 'concluida' && r.status !== 'cancelada')
    .map((r) => `<option value="${Number(r.id)}">${escLog(r.codigo)} (${escLog(r.turno)} - ${escLog(r.responsavel_nome)})</option>`)
    .join('');

  return `
    <div style="background:#fff; padding:18px; border-radius:14px; border:1px solid #e2e8f0;">
      <h4 style="margin:0 0 12px; color:#0f172a;">Pedidos Prontos Aguardando Despacho (${lista.length})</h4>
      <div style="display:grid; gap:12px;">
        ${lista.map((item) => `
          <div style="padding:14px; border:1px solid #e2e8f0; border-radius:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div>
              <div style="font-weight:800; color:#0f172a; font-size:14px;">
                Pedido #${Number(item.pedido_id)} — ${escLog(item.nome_cliente)}
                ${item.rota_codigo ? `<span style="background:#dbeafe; color:#1e40af; padding:2px 8px; border-radius:999px; font-size:11px; margin-left:6px;">Rota: ${escLog(item.rota_codigo)} (#${Number(item.ordem_sequencia || 1)})</span>` : ''}
              </div>
              <div style="font-size:12px; color:#475569; margin-top:4px;">
                <i class="fa-solid fa-location-dot" style="color:#ef4444;"></i> ${escLog(item.endereco_entrega || 'Endereço conforme pedido')}
              </div>
              <div style="font-size:12px; color:#64748b; margin-top:2px;">
                Entrega prevista: ${escLog(item.data_entrega)} ${item.hora_entrega ? 'às ' + escLog(String(item.hora_entrega).slice(0, 5)) : ''}
              </div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              ${opcoesRotas ? `
                <select id="sel-rota-ped-${Number(item.pedido_id)}" style="padding:7px 10px; border-radius:8px; border:1px solid #cbd5e1; font-size:12px;">
                  <option value="">Selecionar rota...</option>
                  ${opcoesRotas}
                </select>
                <button type="button" class="btn-outline" style="padding:7px 12px; font-size:12px; border-radius:8px;" onclick="atribuirEntregaRotaAdmin(${Number(item.pedido_id)})">
                  <i class="fa-solid fa-route"></i> Atribuir à Rota
                </button>
              ` : ''}
              <button type="button" class="btn-primary" style="padding:8px 14px; font-size:12px; border-radius:8px; background:#0284c7; color:#fff; border:none; font-weight:700; cursor:pointer;" onclick="despacharPedidoLogisticaAdmin(${Number(item.pedido_id)})">
                <i class="fa-solid fa-truck-fast"></i> Despachar Entrega
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderizarSubAbaRotas(rotas) {
  return `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px;">
      <div style="background:#fff; padding:18px; border-radius:14px; border:1px solid #e2e8f0;">
        <h4 style="margin:0 0 12px; color:#0f172a;"><i class="fa-solid fa-plus-circle" style="color:var(--primary);"></i> Criar Nova Rota de Entrega</h4>
        <form onsubmit="criarRotaEntregaAdmin(event)">
          <div style="margin-bottom:10px;">
            <label style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Data da Rota *</label>
            <input type="date" id="nova-rota-data" value="${escLog(estadoLogisticaAdmin.dataReferencia)}" required style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Turno *</label>
            <select id="nova-rota-turno" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1;">
              <option value="manha">Manhã</option>
              <option value="tarde">Tarde</option>
              <option value="noite">Noite</option>
              <option value="personalizado">Personalizado</option>
            </select>
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Responsável / Entregador *</label>
            <input type="text" id="nova-rota-responsavel" placeholder="Nome do entregador" required style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Veículo / Identificação</label>
            <input type="text" id="nova-rota-veiculo" placeholder="Ex: Moto refrigerada / Carro 01" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block; font-size:12px; font-weight:700; color:#475569; margin-bottom:4px;">Observações Internas da Rota</label>
            <input type="text" id="nova-rota-obs" placeholder="Instruções de conservação/caixa térmica" style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid #cbd5e1; box-sizing:border-box;">
          </div>
          <button type="submit" class="btn-primary" style="width:100%; padding:10px; border-radius:8px; background:var(--primary); color:#fff; border:none; font-weight:700; cursor:pointer;">
            Salvar Rota de Entrega
          </button>
        </form>
      </div>

      <div style="background:#fff; padding:18px; border-radius:14px; border:1px solid #e2e8f0;">
        <h4 style="margin:0 0 12px; color:#0f172a;">Rotas Planejadas (${rotas.length})</h4>
        ${!rotas.length ? `<div style="color:#64748b; font-size:13px;">Nenhuma rota cadastrada para esta data.</div>` : rotas.map((r) => {
          const paradas = Array.isArray(r.paradas) ? r.paradas : [];
          return `
            <div style="padding:12px; border:1px solid #e2e8f0; border-radius:10px; margin-bottom:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="color:#0f172a; font-size:13px;">${escLog(r.codigo)} • Turno: ${escLog(r.turno)}</strong>
                <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; background:#f1f5f9; color:#334155;">${escLog(r.status)}</span>
              </div>
              <div style="font-size:12px; color:#475569; margin-top:4px;">
                Responsável: <strong>${escLog(r.responsavel_nome)}</strong> ${r.veiculo_identificacao ? `(${escLog(r.veiculo_identificacao)})` : ''}
              </div>
              <div style="margin-top:8px; border-top:1px dashed #e2e8f0; padding-top:8px;">
                ${!paradas.length ? `<small style="color:#94a3b8;">Nenhuma parada atribuída.</small>` : paradas.map((par) => `
                  <div style="font-size:12px; padding:4px 0; display:flex; justify-content:space-between; align-items:center;">
                    <span><strong>#${Number(par.ordem_sequencia)}</strong> — Pedido #${Number(par.pedido_id)} (${escLog(par.nome_cliente)})</span>
                    <span style="font-size:11px; color:#64748b;">${escLog(par.status_logistico)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderizarSubAbaEmRota(lista) {
  if (!lista.length) {
    return `
      <div style="background:#fff; padding:32px; border-radius:14px; border:1px solid #e2e8f0; text-align:center; color:#64748b;">
        Nenhuma entrega em rota, com ocorrência ou concluída para a data selecionada.
      </div>
    `;
  }

  return `
    <div style="background:#fff; padding:18px; border-radius:14px; border:1px solid #e2e8f0;">
      <h4 style="margin:0 0 12px; color:#0f172a;">Acompanhamento de Entregas em Rota, Falhas e Concluídas (${lista.length})</h4>
      <div style="display:grid; gap:12px;">
        ${lista.map((item) => {
          const comp = item.comprovante || null;
          const isEntregue = item.status_operacional === 'entregue' || item.status_logistico === 'entregue';
          return `
            <div style="padding:14px; border:1px solid #e2e8f0; border-radius:12px;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
                <div>
                  <div style="font-weight:800; font-size:14px; color:#0f172a;">
                    Pedido #${Number(item.pedido_id)} — ${escLog(item.nome_cliente)}
                    <span style="font-size:11px; padding:2px 8px; border-radius:999px; background:${isEntregue ? '#d1fae5' : item.status_logistico === 'falha_temporaria' ? '#fee2e2' : '#e0f2fe'}; color:${isEntregue ? '#065f46' : item.status_logistico === 'falha_temporaria' ? '#991b1b' : '#0369a1'}; margin-left:6px;">
                      ${escLog(item.status_logistico)} (Tentativas: ${Number(item.tentativas_count || 0)})
                    </span>
                  </div>
                  <div style="font-size:12px; color:#475569; margin-top:4px;">
                    Endereço: ${escLog(item.endereco_entrega)}
                  </div>
                  ${item.ultimo_motivo_falha ? `
                    <div style="font-size:12px; color:#b91c1c; margin-top:4px;">
                      Última ocorrência: <strong>${escLog(item.ultimo_motivo_falha)}</strong>
                      ${item.proxima_janela_data ? ` • Reagendado para ${escLog(item.proxima_janela_data)}` : ''}
                    </div>
                  ` : ''}
                  ${comp ? `
                    <div style="font-size:12px; color:#047857; margin-top:4px;">
                      <i class="fa-solid fa-file-shield"></i> Comprovante imutável: Recebido por <strong>${escLog(comp.recebido_por)}</strong> (${escLog(comp.tipo_comprovante)})
                    </div>
                  ` : ''}
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                  <button type="button" class="btn-outline" style="padding:6px 10px; font-size:12px; border-radius:8px; color:#15803d; border-color:#86efac;" onclick="notificarWhatsAppLogisticaAdmin(${Number(item.pedido_id)}, 'SAIU_PARA_ENTREGA')">
                    <i class="fa-brands fa-whatsapp"></i> Avisar Saída (Frente B)
                  </button>
                  ${!isEntregue ? `
                    ${item.status_logistico === 'falha_temporaria' || item.status_logistico === 'reagendada' ? `
                      <button type="button" class="btn-outline" style="padding:6px 10px; font-size:12px; border-radius:8px;" onclick="reagendarEntregaAdmin(${Number(item.pedido_id)})">
                        <i class="fa-regular fa-calendar"></i> Reagendar
                      </button>
                      <button type="button" class="btn-primary" style="padding:6px 12px; font-size:12px; border-radius:8px; background:#0284c7; color:#fff; border:none; cursor:pointer;" onclick="despacharPedidoLogisticaAdmin(${Number(item.pedido_id)})">
                        <i class="fa-solid fa-rotate-right"></i> Nova Tentativa
                      </button>
                    ` : `
                      <button type="button" class="btn-outline" style="padding:6px 10px; font-size:12px; border-radius:8px; color:#b91c1c; border-color:#fca5a5;" onclick="registrarFalhaEntregaAdmin(${Number(item.pedido_id)})">
                        <i class="fa-solid fa-triangle-exclamation"></i> Registrar Falha
                      </button>
                      <button type="button" class="btn-primary" style="padding:6px 12px; font-size:12px; border-radius:8px; background:#059669; color:#fff; border:none; font-weight:700; cursor:pointer;" onclick="confirmarEntregaComComprovanteAdmin(${Number(item.pedido_id)})">
                        <i class="fa-solid fa-check-double"></i> Confirmar Entrega
                      </button>
                    `}
                  ` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

async function criarRotaEntregaAdmin(event) {
  if (event) event.preventDefault();
  const dataRota = document.getElementById('nova-rota-data')?.value;
  const turno = document.getElementById('nova-rota-turno')?.value || 'manha';
  const responsavel = document.getElementById('nova-rota-responsavel')?.value || '';
  const veiculo = document.getElementById('nova-rota-veiculo')?.value || '';
  const obs = document.getElementById('nova-rota-obs')?.value || '';

  try {
    const { data, error } = await supabaseClient.rpc('criar_rota_entrega_admin', {
      p_data_rota: dataRota,
      p_turno: turno,
      p_responsavel_nome: responsavel,
      p_veiculo_identificacao: veiculo || null,
      p_observacoes_internas: obs || null
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Não foi possível criar a rota.');
    }
    if (typeof mostrarToast === 'function') mostrarToast('Rota criada com sucesso!', 'sucesso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function atribuirEntregaRotaAdmin(pedidoId) {
  const selectEl = document.getElementById('sel-rota-ped-' + Number(pedidoId));
  const rotaId = Number(selectEl?.value || 0);
  if (!rotaId) {
    if (typeof mostrarToast === 'function') mostrarToast('Selecione uma rota antes de atribuir.', 'aviso');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('atribuir_entrega_rota', {
      p_rota_id: rotaId,
      p_pedido_id: Number(pedidoId)
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Falha ao atribuir pedido à rota.');
    }
    if (typeof mostrarToast === 'function') mostrarToast(`Pedido #${pedidoId} atribuído à rota!`, 'sucesso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function despacharPedidoLogisticaAdmin(pedidoId) {
  try {
    const { data, error } = await supabaseClient.rpc('despachar_pedido_entrega', {
      p_pedido_id: Number(pedidoId),
      p_observacao: 'Despachado pelo painel administrativo de logística'
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Falha ao despachar pedido.');
    }
    if (typeof mostrarToast === 'function') mostrarToast(`Pedido #${pedidoId} saiu para entrega!`, 'sucesso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function registrarFalhaEntregaAdmin(pedidoId) {
  const motivo = window.prompt(
    'Informe o código do motivo da falha:\n- DESTINATARIO_AUSENTE\n- ENDERECO_NAO_LOCALIZADO\n- RECUSADO\n- PROBLEMA_TRANSPORTE\n- OUTRO',
    'DESTINATARIO_AUSENTE'
  );
  if (!motivo) return;
  const descricao = window.prompt('Descreva brevemente a ocorrência:', 'Tentativa realizada no local sem sucesso.');
  if (!descricao) return;

  try {
    const { data, error } = await supabaseClient.rpc('registrar_falha_entrega', {
      p_pedido_id: Number(pedidoId),
      p_motivo_falha: motivo.trim().toUpperCase(),
      p_descricao: descricao.trim()
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Falha ao registrar ocorrência.');
    }
    if (typeof mostrarToast === 'function') mostrarToast('Ocorrência de falha registrada no histórico.', 'aviso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function reagendarEntregaAdmin(pedidoId) {
  const novaData = window.prompt('Informe a nova data de entrega (AAAA-MM-DD):', estadoLogisticaAdmin.dataReferencia);
  if (!novaData) return;
  const novaHora = window.prompt('Informe o novo horário (HH:MM):', '15:00');
  const obs = window.prompt('Observação do reagendamento:', 'Reagendado após contato com o cliente');

  try {
    const { data, error } = await supabaseClient.rpc('reagendar_entrega', {
      p_pedido_id: Number(pedidoId),
      p_nova_data: novaData.trim(),
      p_nova_hora: novaHora ? novaHora.trim() : null,
      p_observacao: obs || null
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Não foi possível reagendar.');
    }
    if (typeof mostrarToast === 'function') mostrarToast('Entrega reagendada com sucesso!', 'sucesso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function confirmarEntregaComComprovanteAdmin(pedidoId) {
  const recebidoPor = window.prompt('Informe o nome de quem recebeu a encomenda:', '');
  if (!recebidoPor || recebidoPor.trim().length < 2) {
    if (typeof mostrarToast === 'function') mostrarToast('Informe o nome do recebedor (mínimo 2 caracteres).', 'aviso');
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc('confirmar_entrega_pedido', {
      p_pedido_id: Number(pedidoId),
      p_recebido_por: recebidoPor.trim(),
      p_tipo_comprovante: 'assinatura_recebedor'
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error((data && data.error) || 'Falha ao confirmar entrega.');
    }
    if (typeof mostrarToast === 'function') mostrarToast(`Entrega do pedido #${pedidoId} confirmada com comprovante!`, 'sucesso');
    await carregarLogisticaAdmin();
  } catch (err) {
    if (typeof mostrarToast === 'function') mostrarToast(err.message, 'erro');
  }
}

async function notificarWhatsAppLogisticaAdmin(pedidoId, tipoTemplate) {
  if (typeof window.abrirFluxoWhatsAppComunicacao === 'function') {
    await window.abrirFluxoWhatsAppComunicacao({
      tipo: tipoTemplate || 'SAIU_PARA_ENTREGA',
      pedidoId: Number(pedidoId)
    });
  } else if (typeof mostrarToast === 'function') {
    mostrarToast('Módulo canônico de comunicação WhatsApp (Frente B) não carregado.', 'erro');
  }
}

window.carregarLogisticaAdmin = carregarLogisticaAdmin;
window.mudarSubAbaLogistica = mudarSubAbaLogistica;
window.criarRotaEntregaAdmin = criarRotaEntregaAdmin;
window.atribuirEntregaRotaAdmin = atribuirEntregaRotaAdmin;
window.despacharPedidoLogisticaAdmin = despacharPedidoLogisticaAdmin;
window.registrarFalhaEntregaAdmin = registrarFalhaEntregaAdmin;
window.reagendarEntregaAdmin = reagendarEntregaAdmin;
window.confirmarEntregaComComprovanteAdmin = confirmarEntregaComComprovanteAdmin;
window.notificarWhatsAppLogisticaAdmin = notificarWhatsAppLogisticaAdmin;
