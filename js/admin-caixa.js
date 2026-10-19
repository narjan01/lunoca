// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE SESSÕES DE CAIXA (FRENTE R)
// ==============================================================================
// Gestão operacional de custódia física da gaveta de dinheiro: abertura de turno,
// aporte de troco (suprimento), sangrias para cofre, conferência cega no servidor,
// cálculo de quebra/sobra com justificativa obrigatória e auditoria gerencial (Migration 034).
// ==============================================================================

const supabase = typeof window !== 'undefined' ? (window.supabaseClient || window.supabase) : null;

let caixaSessaoAtual = null;
let caixaHistorico = [];
let caixaIsAdmin = false;

export async function carregarCaixaAdmin() {
  const container = document.getElementById('admin-tab-caixa');
  if (!container) return;

  container.innerHTML = `
    <div class="caixa-admin-header" style="margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h2 style="margin: 0; font-size: 1.5rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-solid fa-cash-register" style="color: #10b981;"></i> Sessões de Caixa & Gaveta PDV
        </h2>
        <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.9rem;">
          Custódia física de dinheiro, suprimentos, sangrias e fechamento cego de turno.
        </p>
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
        <button id="btn-caixa-recarregar" class="btn btn-outline" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff;">
          <i class="fa-solid fa-rotate-right"></i> Atualizar
        </button>
      </div>
    </div>

    <!-- PAINEL DA SESSÃO ATUAL -->
    <div id="caixa-painel-sessao-atual" style="margin-bottom: 2rem;">
      <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <i class="fa-solid fa-spinner fa-spin"></i> Verificando status da sessão de caixa...
      </div>
    </div>

    <!-- HISTÓRICO DE SESSÕES ANTERIORES -->
    <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
        <h3 style="margin: 0; font-size: 1.15rem; color: #1e293b; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-solid fa-clock-rotate-left" style="color: #6366f1;"></i> Histórico de Turnos e Fechamentos
        </h3>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <select id="filtro-caixa-status" style="padding: 0.4rem 0.75rem; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
            <option value="">Todos os status</option>
            <option value="ABERTA">Abertas</option>
            <option value="FECHADA">Fechadas</option>
          </select>
        </div>
      </div>
      <div id="caixa-tabela-historico" style="overflow-x: auto;">
        <p style="color: #64748b; font-size: 0.9rem;">Carregando histórico...</p>
      </div>
    </div>

    <!-- MODAL DE ABERTURA DE CAIXA -->
    <div id="modal-abrir-caixa" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
      <div style="background:#fff; border-radius:12px; max-width:440px; width:90%; padding:1.5rem; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <h3 style="margin-top:0; color:#1e293b; display:flex; align-items:center; gap:0.5rem;">
          <i class="fa-solid fa-key" style="color:#10b981;"></i> Abertura de Sessão de Caixa
        </h3>
        <p style="color:#64748b; font-size:0.85rem; margin-bottom:1rem;">
          Informe o fundo de troco inicial presente na gaveta física para iniciar o turno de atendimento.
        </p>
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Fundo de Troco Inicial (R$)</label>
          <input type="number" id="input-abrir-fundo-troco" step="0.01" min="0" placeholder="0,00" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid #cbd5e1; font-size:1.1rem; font-weight:700; box-sizing:border-box;">
        </div>
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Identificação do Terminal</label>
          <input type="text" id="input-abrir-terminal" value="PRINCIPAL" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid #cbd5e1; font-size:0.9rem; box-sizing:border-box;">
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Observações de Abertura (Opcional)</label>
          <textarea id="input-abrir-obs" rows="2" placeholder="Ex: Cédulas miúdas e moedas conferidas" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid #cbd5e1; font-size:0.85rem; box-sizing:border-box;"></textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button id="btn-cancelar-abrir-caixa" class="btn btn-outline" style="padding:0.5rem 1rem; border-radius:8px; cursor:pointer;">Cancelar</button>
          <button id="btn-confirmar-abrir-caixa" class="btn btn-primary" style="padding:0.5rem 1.25rem; border-radius:8px; cursor:pointer; background:#10b981; border-color:#10b981; color:#fff; font-weight:600;">
            <i class="fa-solid fa-lock-open"></i> Abrir Caixa
          </button>
        </div>
      </div>
    </div>

    <!-- MODAL DE MOVIMENTAÇÃO (SUPRIMENTO / SANGRIA) -->
    <div id="modal-mov-caixa" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
      <div style="background:#fff; border-radius:12px; max-width:440px; width:90%; padding:1.5rem; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <h3 id="modal-mov-titulo" style="margin-top:0; color:#1e293b; display:flex; align-items:center; gap:0.5rem;">
          Movimentação de Caixa
        </h3>
        <p id="modal-mov-subtitulo" style="color:#64748b; font-size:0.85rem; margin-bottom:1rem;"></p>
        <input type="hidden" id="input-mov-tipo" value="SUPRIMENTO">
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Valor (R$)</label>
          <input type="number" id="input-mov-valor" step="0.01" min="0.01" placeholder="0,00" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid #cbd5e1; font-size:1.1rem; font-weight:700; box-sizing:border-box;">
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Motivo / Justificativa (Obrigatório)</label>
          <textarea id="input-mov-motivo" rows="2" placeholder="Ex: Troco adicional para notas de 50 ou Recolhimento para cofre" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid #cbd5e1; font-size:0.85rem; box-sizing:border-box;"></textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button id="btn-cancelar-mov-caixa" class="btn btn-outline" style="padding:0.5rem 1rem; border-radius:8px; cursor:pointer;">Cancelar</button>
          <button id="btn-confirmar-mov-caixa" class="btn btn-primary" style="padding:0.5rem 1.25rem; border-radius:8px; cursor:pointer; font-weight:600;">
            Confirmar
          </button>
        </div>
      </div>
    </div>

    <!-- MODAL DE FECHAMENTO CEGO DE CAIXA -->
    <div id="modal-fechar-caixa" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
      <div style="background:#fff; border-radius:12px; max-width:480px; width:90%; padding:1.5rem; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
        <h3 style="margin-top:0; color:#b91c1c; display:flex; align-items:center; gap:0.5rem;">
          <i class="fa-solid fa-lock"></i> Fechamento Cego de Turno
        </h3>
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:0.75rem; margin-bottom:1rem; font-size:0.85rem; color:#991b1b;">
          <i class="fa-solid fa-shield-halved"></i> <strong>Conferência Cega Server-Side:</strong><br>
          Conte fisicamente todas as cédulas e moedas presentes na gaveta. O sistema fará a conferência matemática dos lançamentos canônicos e registrará os snapshots definitivos.
        </div>
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.9rem; font-weight:700; color:#1e293b; margin-bottom:0.25rem;">Valor Total Contado em Dinheiro (R$)</label>
          <input type="number" id="input-fechar-valor-contado" step="0.01" min="0" placeholder="0,00" style="width:100%; padding:0.65rem; border-radius:8px; border:1px solid #cbd5e1; font-size:1.25rem; font-weight:700; color:#0f172a; box-sizing:border-box;">
        </div>
        <div id="container-fechar-justificativa" style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Justificativa de Divergência (se houver quebra/sobra)</label>
          <textarea id="input-fechar-justificativa" rows="2" placeholder="Obrigatório caso o valor contado divirja do apurado pelo sistema" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid #cbd5e1; font-size:0.85rem; box-sizing:border-box;"></textarea>
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block; font-size:0.85rem; font-weight:600; color:#475569; margin-bottom:0.25rem;">Observações Finais de Encerramento (Opcional)</label>
          <textarea id="input-fechar-obs" rows="2" placeholder="Observações do operador para a gerência" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid #cbd5e1; font-size:0.85rem; box-sizing:border-box;"></textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button id="btn-cancelar-fechar-caixa" class="btn btn-outline" style="padding:0.5rem 1rem; border-radius:8px; cursor:pointer;">Cancelar</button>
          <button id="btn-confirmar-fechar-caixa" class="btn btn-primary" style="padding:0.5rem 1.25rem; border-radius:8px; cursor:pointer; background:#dc2626; border-color:#dc2626; color:#fff; font-weight:600;">
            <i class="fa-solid fa-lock"></i> Encerrar Turno
          </button>
        </div>
      </div>
    </div>
  `;

  vincularEventosCaixa();
  await atualizarPainelCaixa();
}

function vincularEventosCaixa() {
  document.getElementById('btn-caixa-recarregar')?.addEventListener('click', atualizarPainelCaixa);
  document.getElementById('filtro-caixa-status')?.addEventListener('change', carregarHistoricoCaixa);

  // Modais
  document.getElementById('btn-cancelar-abrir-caixa')?.addEventListener('click', () => {
    document.getElementById('modal-abrir-caixa').style.display = 'none';
  });
  document.getElementById('btn-confirmar-abrir-caixa')?.addEventListener('click', executarAberturaCaixa);

  document.getElementById('btn-cancelar-mov-caixa')?.addEventListener('click', () => {
    document.getElementById('modal-mov-caixa').style.display = 'none';
  });
  document.getElementById('btn-confirmar-mov-caixa')?.addEventListener('click', executarMovimentacaoCaixa);

  document.getElementById('btn-cancelar-fechar-caixa')?.addEventListener('click', () => {
    document.getElementById('modal-fechar-caixa').style.display = 'none';
  });
  document.getElementById('btn-confirmar-fechar-caixa')?.addEventListener('click', executarFechamentoCaixa);
}

export async function atualizarPainelCaixa() {
  const painel = document.getElementById('caixa-painel-sessao-atual');
  if (!painel) return;

  try {
    const { data, error } = await supabase.rpc('consultar_sessao_caixa_atual');
    if (error) throw error;

    if (!data || !data.sessao_aberta) {
      caixaSessaoAtual = null;
      painel.innerHTML = `
        <div style="background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; padding: 2rem; text-align: center;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; background: #fee2e2; color: #dc2626; font-size: 1.75rem; margin-bottom: 1rem;">
            <i class="fa-solid fa-cash-register"></i>
          </div>
          <h3 style="margin: 0 0 0.5rem; color: #1e293b; font-size: 1.25rem;">Caixa Fechado</h3>
          <p style="color: #64748b; font-size: 0.9rem; max-width: 440px; margin: 0 auto 1.5rem;">
            Nenhuma sessão aberta para este operador. Abra o caixa informando o fundo de troco para liberar as vendas no PDV.
          </p>
          <button id="btn-abrir-caixa-acao" class="btn btn-primary" style="padding: 0.65rem 1.5rem; border-radius: 8px; cursor: pointer; background: #10b981; border-color: #10b981; font-weight: 600; font-size: 0.95rem;">
            <i class="fa-solid fa-key"></i> Abrir Caixa Agora
          </button>
        </div>
      `;
      document.getElementById('btn-abrir-caixa-acao')?.addEventListener('click', () => {
        document.getElementById('input-abrir-fundo-troco').value = '100.00';
        document.getElementById('modal-abrir-caixa').style.display = 'flex';
      });
    } else {
      caixaSessaoAtual = data.sessao;
      painel.innerHTML = `
        <div style="background: #fff; border-radius: 12px; border: 1px solid #10b981; padding: 1.5rem; box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.1);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid #f1f5f9; padding-bottom: 1rem; margin-bottom: 1.25rem;">
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span style="background: #ecfdf5; color: #059669; font-weight: 700; font-size: 0.8rem; padding: 0.35rem 0.75rem; border-radius: 9999px; display: inline-flex; align-items: center; gap: 0.35rem;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block;"></span> SESSÃO ATIVA
              </span>
              <span style="font-weight: 700; color: #1e293b; font-size: 1.1rem;">Sessão #${caixaSessaoAtual.id}</span>
              <span style="color: #64748b; font-size: 0.85rem;">Terminal: <strong>${caixaSessaoAtual.terminal_id}</strong></span>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button id="btn-caixa-suprimento" class="btn btn-outline" style="padding: 0.45rem 0.9rem; border-radius: 8px; cursor: pointer; border: 1px solid #10b981; color: #059669; font-weight: 600;">
                <i class="fa-solid fa-plus"></i> Suprimento
              </button>
              <button id="btn-caixa-sangria" class="btn btn-outline" style="padding: 0.45rem 0.9rem; border-radius: 8px; cursor: pointer; border: 1px solid #f59e0b; color: #d97706; font-weight: 600;">
                <i class="fa-solid fa-minus"></i> Sangria
              </button>
              <button id="btn-caixa-fechar" class="btn btn-primary" style="padding: 0.45rem 1rem; border-radius: 8px; cursor: pointer; background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 600;">
                <i class="fa-solid fa-lock"></i> Fechar Caixa
              </button>
            </div>
          </div>

          <!-- CARDS OPERACIONAIS CEGOS (SEM SALDO ESPERADO ANTES DA CONTAGEM) -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem;">
            <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; border: 1px solid #e2e8f0;">
              <div style="font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase;">Fundo Inicial</div>
              <div style="font-size: 1.4rem; font-weight: 700; color: #0f172a; margin-top: 4px;">R$ ${Number(caixaSessaoAtual.fundo_troco_inicial || 0).toFixed(2).replace('.', ',')}</div>
              <div style="font-size: 0.75rem; color: #64748b;">Troco de abertura</div>
            </div>
            <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; border: 1px solid #e2e8f0;">
              <div style="font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase;">Vendas PDV</div>
              <div style="font-size: 1.4rem; font-weight: 700; color: #2563eb; margin-top: 4px;">${caixaSessaoAtual.total_transacoes || 0}</div>
              <div style="font-size: 0.75rem; color: #64748b;">Pagamentos custodiados</div>
            </div>
            <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; border: 1px solid #e2e8f0;">
              <div style="font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase;">Movimentações</div>
              <div style="font-size: 1.4rem; font-weight: 700; color: #7c3aed; margin-top: 4px;">${caixaSessaoAtual.total_movimentacoes || 0}</div>
              <div style="font-size: 0.75rem; color: #64748b;">Suprimentos / Sangrias</div>
            </div>
            <div style="background: #f8fafc; border-radius: 8px; padding: 1rem; border: 1px solid #e2e8f0;">
              <div style="font-size: 0.75rem; font-weight: 600; color: #64748b; text-transform: uppercase;">Abertura</div>
              <div style="font-size: 1rem; font-weight: 700; color: #334155; margin-top: 6px;">${new Date(caixaSessaoAtual.aberta_em).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
              <div style="font-size: 0.75rem; color: #64748b;">${new Date(caixaSessaoAtual.aberta_em).toLocaleDateString()}</div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('btn-caixa-suprimento')?.addEventListener('click', () => abrirModalMovimentacao('SUPRIMENTO'));
      document.getElementById('btn-caixa-sangria')?.addEventListener('click', abrirModalMovimentacao('SANGRIA'));
      document.getElementById('btn-caixa-fechar')?.addEventListener('click', abrirModalFechamento);
    }
  } catch (err) {
    painel.innerHTML = `<p style="color:#dc2626;">Erro ao carregar sessão de caixa: ${err.message}</p>`;
  }

  await carregarHistoricoCaixa();
}

function abrirModalMovimentacao(tipo) {
  const modal = document.getElementById('modal-mov-caixa');
  const titulo = document.getElementById('modal-mov-titulo');
  const sub = document.getElementById('modal-mov-subtitulo');
  const inputTipo = document.getElementById('input-mov-tipo');

  inputTipo.value = tipo;
  if (tipo === 'SUPRIMENTO') {
    titulo.innerHTML = '<i class="fa-solid fa-plus-circle" style="color:#10b981;"></i> Registrar Suprimento (Troco)';
    sub.textContent = 'Adiciona dinheiro físico à gaveta. Não gera receita no DRE.';
  } else {
    titulo.innerHTML = '<i class="fa-solid fa-minus-circle" style="color:#f59e0b;"></i> Registrar Sangria (Retirada)';
    sub.textContent = 'Recolhe dinheiro físico da gaveta para o cofre. Não gera despesa no DRE.';
  }

  document.getElementById('input-mov-valor').value = '';
  document.getElementById('input-mov-motivo').value = '';
  modal.style.display = 'flex';
}

function abrirModalFechamento() {
  document.getElementById('input-fechar-valor-contado').value = '';
  document.getElementById('input-fechar-justificativa').value = '';
  document.getElementById('input-fechar-obs').value = '';
  document.getElementById('modal-fechar-caixa').style.display = 'flex';
}

async function executarAberturaCaixa() {
  const fundo = parseFloat(document.getElementById('input-abrir-fundo-troco').value);
  const terminal = document.getElementById('input-abrir-terminal').value.trim();
  const obs = document.getElementById('input-abrir-obs').value.trim();

  if (isNaN(fundo) || fundo < 0) {
    alert('Informe um fundo de troco inicial válido (maior ou igual a zero).');
    return;
  }

  try {
    const { data, error } = await supabase.rpc('abrir_sessao_caixa', {
      p_fundo_troco: fundo,
      p_terminal: terminal || 'PRINCIPAL',
      p_observacoes: obs || null
    });

    if (error) throw error;
    if (!data.success) {
      alert('Falha ao abrir caixa: ' + data.error);
      return;
    }

    document.getElementById('modal-abrir-caixa').style.display = 'none';
    alert('Sessão de caixa #' + data.sessao_id + ' aberta com sucesso!');
    await atualizarPainelCaixa();
  } catch (err) {
    alert('Erro ao abrir caixa: ' + err.message);
  }
}

async function executarMovimentacaoCaixa() {
  const tipo = document.getElementById('input-mov-tipo').value;
  const valor = parseFloat(document.getElementById('input-mov-valor').value);
  const motivo = document.getElementById('input-mov-motivo').value.trim();

  if (isNaN(valor) || valor <= 0) {
    alert('Informe um valor válido maior que zero.');
    return;
  }
  if (motivo.length < 3) {
    alert('O motivo da movimentação deve ter no mínimo 3 caracteres.');
    return;
  }

  const idempKey = 'mov_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  try {
    const { data, error } = await supabase.rpc('registrar_movimentacao_caixa', {
      p_tipo: tipo,
      p_valor: valor,
      p_motivo: motivo,
      p_idempotency_key: idempKey,
      p_sessao_id: caixaSessaoAtual ? caixaSessaoAtual.id : null
    });

    if (error) throw error;
    if (!data.success) {
      alert('Falha na movimentação: ' + data.error);
      return;
    }

    document.getElementById('modal-mov-caixa').style.display = 'none';
    alert(tipo + ' de R$ ' + valor.toFixed(2) + ' registrado com sucesso!');
    await atualizarPainelCaixa();
  } catch (err) {
    alert('Erro ao registrar movimentação: ' + err.message);
  }
}

async function executarFechamentoCaixa() {
  const valorContado = parseFloat(document.getElementById('input-fechar-valor-contado').value);
  const justificativa = document.getElementById('input-fechar-justificativa').value.trim();
  const obs = document.getElementById('input-fechar-obs').value.trim();

  if (isNaN(valorContado) || valorContado < 0) {
    alert('Informe o valor físico contado na gaveta (maior ou igual a zero).');
    return;
  }

  const idempKey = 'close_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  try {
    const { data, error } = await supabase.rpc('fechar_sessao_caixa', {
      p_valor_contado_dinheiro: valorContado,
      p_justificativa: justificativa || null,
      p_observacoes: obs || null,
      p_sessao_id: caixaSessaoAtual ? caixaSessaoAtual.id : null,
      p_idempotency_key: idempKey
    });

    if (error) throw error;
    if (!data.success) {
      if (data.code === 'DIVERGENCE_JUSTIFICATION_REQUIRED') {
        alert('Divergência identificada (' + (data.diferenca > 0 ? '+R$ ' : '-R$ ') + Math.abs(data.diferenca).toFixed(2) + ')! Preencha obrigatoriamente a justificativa para encerrar.');
        document.getElementById('input-fechar-justificativa').focus();
        return;
      }
      alert('Falha ao fechar caixa: ' + data.error);
      return;
    }

    document.getElementById('modal-fechar-caixa').style.display = 'none';
    alert('Turno encerrado com sucesso!\nEsperado: R$ ' + Number(data.saldo_esperado_dinheiro).toFixed(2) + '\nContado: R$ ' + Number(data.valor_contado_dinheiro).toFixed(2) + '\nDiferença: R$ ' + Number(data.diferenca_caixa).toFixed(2));
    await atualizarPainelCaixa();
  } catch (err) {
    alert('Erro ao fechar caixa: ' + err.message);
  }
}

async function carregarHistoricoCaixa() {
  const container = document.getElementById('caixa-tabela-historico');
  if (!container) return;

  const status = document.getElementById('filtro-caixa-status')?.value || null;

  try {
    const { data, error } = await supabase.rpc('listar_sessoes_caixa_admin', {
      p_data_inicio: null,
      p_data_fim: null,
      p_status: status,
      p_limite: 20,
      p_offset: 0
    });

    if (error) throw error;
    caixaHistorico = (data && data.sessoes) || [];

    if (caixaHistorico.length === 0) {
      container.innerHTML = `<p style="color: #64748b; font-size: 0.9rem; text-align: center; padding: 1rem;">Nenhuma sessão de caixa encontrada.</p>`;
      return;
    }

    container.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
        <thead>
          <tr style="border-bottom: 2px solid #e2e8f0; color: #475569;">
            <th style="padding: 0.6rem 0.5rem;"># ID</th>
            <th style="padding: 0.6rem 0.5rem;">Operador</th>
            <th style="padding: 0.6rem 0.5rem;">Terminal</th>
            <th style="padding: 0.6rem 0.5rem;">Abertura</th>
            <th style="padding: 0.6rem 0.5rem;">Fechamento</th>
            <th style="padding: 0.6rem 0.5rem; text-align: right;">Fundo Troco</th>
            <th style="padding: 0.6rem 0.5rem; text-align: right;">Dinheiro Esperado</th>
            <th style="padding: 0.6rem 0.5rem; text-align: right;">Contado</th>
            <th style="padding: 0.6rem 0.5rem; text-align: right;">Diferença</th>
            <th style="padding: 0.6rem 0.5rem; text-align: center;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${caixaHistorico.map(s => {
            const isFechada = s.status === 'FECHADA';
            const dif = s.diferenca_caixa ? Number(s.diferenca_caixa) : 0;
            const difCor = dif === 0 ? '#10b981' : dif > 0 ? '#2563eb' : '#dc2626';

            return `
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 0.6rem 0.5rem; font-weight: 700;">#${s.id}</td>
                <td style="padding: 0.6rem 0.5rem;">${s.colaborador_nome || s.operador_nome || 'Operador'}</td>
                <td style="padding: 0.6rem 0.5rem;"><span style="background: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; font-weight: 600;">${s.terminal_id}</span></td>
                <td style="padding: 0.6rem 0.5rem;">${new Date(s.aberta_em).toLocaleDateString()} ${new Date(s.aberta_em).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
                <td style="padding: 0.6rem 0.5rem;">${s.fechada_em ? new Date(s.fechada_em).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '<span style="color:#059669; font-weight:600;">Em andamento</span>'}</td>
                <td style="padding: 0.6rem 0.5rem; text-align: right;">R$ ${Number(s.fundo_troco_inicial || 0).toFixed(2).replace('.', ',')}</td>
                <td style="padding: 0.6rem 0.5rem; text-align: right;">${isFechada ? 'R$ ' + Number(s.saldo_esperado_dinheiro_snapshot || 0).toFixed(2).replace('.', ',') : '—'}</td>
                <td style="padding: 0.6rem 0.5rem; text-align: right;">${isFechada ? 'R$ ' + Number(s.valor_contado_dinheiro || 0).toFixed(2).replace('.', ',') : '—'}</td>
                <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; color: ${difCor};">${isFechada ? (dif > 0 ? '+R$ ' : 'R$ ') + dif.toFixed(2).replace('.', ',') : '—'}</td>
                <td style="padding: 0.6rem 0.5rem; text-align: center;">
                  <span style="display: inline-block; padding: 0.2rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; background: ${isFechada ? '#f1f5f9' : '#ecfdf5'}; color: ${isFechada ? '#475569' : '#059669'};">
                    ${s.status}
                  </span>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<p style="color:#dc2626;">Erro ao carregar histórico: ${err.message}</p>`;
  }
}

// Expõe globalmente
if (typeof window !== 'undefined') {
  window.carregarCaixaAdmin = carregarCaixaAdmin;
}
