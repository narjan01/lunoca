// ==============================================================================
// LUNOCA DOCERIA - MÓDULO ADMINISTRATIVO DE PDV RÁPIDO & PRONTA ENTREGA (FRENTE Q)
// ==============================================================================
// Operação ágil de balcão: catálogo de pronta entrega com saldo em tempo real,
// carrinho rápido, baixa FEFO atômica de lotes de produtos prontos, checkout
// em transação única com canal canônico 'balcao' e quitação integrada (Migration 032).
// ==============================================================================

import { supabase } from './supabase.js';

let pdvProdutos = [];
let pdvCarrinho = [];
let pdvClientes = [];
let pdvClienteSelecionado = null;
let pdvAbaAtiva = 'caixa'; // 'caixa' ou 'estoque'
let pdvLotesEstoque = [];

export async function carregarPdvAdmin() {
  const container = document.getElementById('admin-tab-pdv');
  if (!container) return;

  container.innerHTML = `
    <div class="pdv-admin-header" style="margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h2 style="margin: 0; font-size: 1.5rem; color: #2c1810; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-solid fa-bolt" style="color: #f59e0b;"></i> PDV Rápido & Pronta Entrega
        </h2>
        <p style="margin: 0.25rem 0 0; color: #666; font-size: 0.9rem;">
          Venda ágil de balcão, alocação FEFO automática de lotes prontos e quitação canônica instantânea.
        </p>
      </div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
        <button id="btn-pdv-aba-caixa" class="btn ${pdvAbaAtiva === 'caixa' ? 'btn-primary' : 'btn-outline'}" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer;">
          <i class="fa-solid fa-cash-register"></i> Frente de Caixa
        </button>
        <button id="btn-pdv-aba-estoque" class="btn ${pdvAbaAtiva === 'estoque' ? 'btn-primary' : 'btn-outline'}" style="padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer;">
          <i class="fa-solid fa-boxes-stacked"></i> Estoque Pronta Entrega
        </button>
        <button id="btn-pdv-recarregar" class="btn btn-outline" style="padding: 0.5rem 0.8rem; border-radius: 8px; cursor: pointer;" title="Recarregar catálogo">
          <i class="fa-solid fa-rotate-right"></i>
        </button>
      </div>
    </div>

    <!-- CONTEÚDO DAS ABAS -->
    <div id="pdv-conteudo-caixa" style="${pdvAbaAtiva === 'caixa' ? 'display: block;' : 'display: none;'}">
      <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 1.5rem; align-items: start;">
        
        <!-- COLUNA DA ESQUERDA: CATÁLOGO DE PRODUTOS -->
        <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;">
            <div style="position: relative; flex: 1; min-width: 200px;">
              <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 12px; top: 11px; color: #94a3b8; font-size: 0.85rem;"></i>
              <input type="text" id="pdv-busca-produto" placeholder="Buscar por nome ou código..." style="width: 100%; padding: 0.5rem 0.75rem 0.5rem 2.2rem; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 0.9rem; box-sizing: border-box;">
            </div>
            <select id="pdv-filtro-categoria" style="padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
              <option value="todas">Todas as categorias</option>
            </select>
          </div>

          <!-- GRID DE PRODUTOS -->
          <div id="pdv-grid-produtos" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; max-height: 560px; overflow-y: auto; padding-right: 4px;">
            <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: #64748b;">
              <i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem;"></i> Carregando catálogo...
            </div>
          </div>
        </div>

        <!-- COLUNA DA DIREITA: CARRINHO E CHECKOUT -->
        <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04); display: flex; flex-direction: column;">
          
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <h3 style="margin: 0; font-size: 1.15rem; color: #1e293b; display: flex; align-items: center; gap: 0.5rem;">
              <i class="fa-solid fa-cart-shopping" style="color: var(--primary, #6b2d5c);"></i> Carrinho de Balcão
            </h3>
            <button id="btn-limpar-carrinho-pdv" class="btn btn-outline" style="font-size: 0.75rem; padding: 0.25rem 0.6rem; border-radius: 6px; color: #ef4444; border-color: #fca5a5;">
              <i class="fa-solid fa-trash"></i> Limpar
            </button>
          </div>

          <!-- IDENTIFICAÇÃO DO CLIENTE -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
              <span style="font-size: 0.8rem; font-weight: 600; color: #475569;">Cliente</span>
              <button id="btn-toggle-cliente-pdv" style="background: none; border: none; color: #0284c7; font-size: 0.75rem; cursor: pointer; text-decoration: underline;">
                Identificar Cliente
              </button>
            </div>
            <div id="pdv-cliente-info" style="font-size: 0.85rem; color: #334155;">
              <span class="badge" style="background: #e2e8f0; color: #475569; padding: 2px 6px; border-radius: 4px;">Consumidor Avulso</span>
            </div>
            <div id="pdv-cliente-busca-container" style="display: none; margin-top: 0.5rem;">
              <input type="text" id="pdv-busca-cliente-input" placeholder="Buscar cliente por nome ou telefone..." style="width: 100%; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.85rem; box-sizing: border-box;">
              <div id="pdv-cliente-sugestoes" style="max-height: 120px; overflow-y: auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 4px; display: none;"></div>
            </div>
            <div style="margin-top: 0.4rem;">
              <input type="text" id="pdv-cpf-na-nota" placeholder="CPF na Nota (opcional)" maxlength="14" style="width: 100%; padding: 0.35rem 0.6rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.8rem; box-sizing: border-box;">
            </div>
          </div>

          <!-- LISTA DE ITENS DO CARRINHO -->
          <div id="pdv-itens-carrinho" style="min-height: 140px; max-height: 240px; overflow-y: auto; margin-bottom: 0.75rem; border: 1px dashed #e2e8f0; border-radius: 8px; padding: 0.5rem;">
            <div style="text-align: center; color: #94a3b8; font-size: 0.85rem; padding: 2rem 0;">
              Carrinho vazio. Clique nos produtos para adicionar.
            </div>
          </div>

          <!-- DESCONTO E AJUSTES -->
          <div style="background: #fdf6ec; border: 1px solid #faeccb; border-radius: 8px; padding: 0.6rem 0.75rem; margin-bottom: 0.75rem;">
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.35rem;">
              <label style="font-size: 0.8rem; font-weight: 600; color: #b45309; min-width: 90px;">Desconto R$:</label>
              <input type="number" id="pdv-input-desconto" step="0.01" min="0" value="0.00" style="width: 80px; padding: 0.3rem 0.5rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.85rem;">
              <span id="pdv-desconto-percentual-aviso" style="font-size: 0.75rem; color: #78350f;">(máx 10% operador)</span>
            </div>
            <div id="pdv-motivo-desconto-container" style="display: none;">
              <input type="text" id="pdv-motivo-desconto" placeholder="Justificativa do desconto (obrigatória)..." style="width: 100%; padding: 0.3rem 0.5rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.8rem; box-sizing: border-box;">
            </div>
          </div>

          <!-- FORMA DE PAGAMENTO -->
          <div style="margin-bottom: 0.75rem;">
            <label style="font-size: 0.8rem; font-weight: 600; color: #475569; display: block; margin-bottom: 0.35rem;">Forma de Pagamento</label>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.4rem;">
              <button class="btn btn-outline pdv-forma-pgto-btn active" data-forma="pix" style="padding: 0.45rem; font-size: 0.8rem; border-radius: 6px; text-align: center;">
                <i class="fa-brands fa-pix" style="color: #059669;"></i> PIX
              </button>
              <button class="btn btn-outline pdv-forma-pgto-btn" data-forma="cartao" style="padding: 0.45rem; font-size: 0.8rem; border-radius: 6px; text-align: center;">
                <i class="fa-solid fa-credit-card" style="color: #0284c7;"></i> Cartão
              </button>
              <button class="btn btn-outline pdv-forma-pgto-btn" data-forma="dinheiro" style="padding: 0.45rem; font-size: 0.8rem; border-radius: 6px; text-align: center;">
                <i class="fa-solid fa-money-bill-wave" style="color: #d97706;"></i> Dinheiro
              </button>
            </div>
            <!-- TROCO SE DINHEIRO -->
            <div id="pdv-dinheiro-troco-container" style="display: none; margin-top: 0.5rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 0.5rem;">
              <div style="display: flex; gap: 0.5rem; align-items: center; justify-content: space-between;">
                <span style="font-size: 0.8rem; color: #166534;">Valor Entregue:</span>
                <input type="number" id="pdv-dinheiro-recebido" step="0.50" min="0" placeholder="0.00" style="width: 80px; padding: 0.25rem 0.5rem; border-radius: 6px; border: 1px solid #86efac; font-size: 0.85rem;">
                <span style="font-size: 0.8rem; font-weight: 700; color: #15803d;" id="pdv-dinheiro-troco-texto">Troco: R$ 0,00</span>
              </div>
            </div>
          </div>

          <!-- TOTAIS E BOTÃO DE FINALIZAÇÃO -->
          <div style="border-top: 2px solid #f1f5f9; padding-top: 0.75rem; margin-top: auto;">
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #64748b; margin-bottom: 0.25rem;">
              <span>Subtotal:</span>
              <span id="pdv-resumo-subtotal">R$ 0,00</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #dc2626; margin-bottom: 0.35rem;">
              <span>Desconto:</span>
              <span id="pdv-resumo-desconto">- R$ 0,00</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 1.3rem; font-weight: 800; color: #1e293b; margin-bottom: 1rem;">
              <span>Total a Pagar:</span>
              <span id="pdv-resumo-total" style="color: #059669;">R$ 0,00</span>
            </div>
            <button id="btn-finalizar-venda-pdv" class="btn btn-primary" style="width: 100%; padding: 0.75rem; font-size: 1rem; font-weight: 700; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem; background: #059669; border-color: #059669;">
              <i class="fa-solid fa-check"></i> Finalizar Venda (PDV)
            </button>
          </div>

        </div>
      </div>
    </div>

    <!-- ABA: ESTOQUE DE PRODUTO PRONTO -->
    <div id="pdv-conteudo-estoque" style="${pdvAbaAtiva === 'estoque' ? 'display: block;' : 'display: none;'}">
      <div style="background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem;">
          <h3 style="margin: 0; font-size: 1.2rem; color: #1e293b;">
            <i class="fa-solid fa-boxes-stacked" style="color: #6366f1;"></i> Lotes de Produtos Prontos em Estoque
          </h3>
          <span style="font-size: 0.85rem; color: #64748b;">
            Ordem de consumo FEFO: Lotes com menor validade são alocados primeiro no caixa.
          </span>
        </div>
        <div id="pdv-tabela-lotes-container" style="overflow-x: auto;">
          <div style="text-align: center; padding: 2rem; color: #64748b;">
            <i class="fa-solid fa-spinner fa-spin"></i> Carregando lotes...
          </div>
        </div>
      </div>
    </div>

    <!-- MODAL DE SUCESSO / COMPROVANTE -->
    <div id="modal-sucesso-pdv" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center; padding: 1rem;">
      <div style="background: #fff; border-radius: 14px; max-width: 450px; width: 100%; padding: 1.5rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2);">
        <div style="text-align: center; margin-bottom: 1rem;">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: #d1fae5; color: #059669; display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.5rem;">
            <i class="fa-solid fa-check"></i>
          </div>
          <h3 style="margin: 0; color: #065f46; font-size: 1.25rem;">Venda Concluída!</h3>
          <p id="pdv-sucesso-numero" style="margin: 0.25rem 0 0; font-weight: 700; color: #1e293b; font-size: 1.1rem;">Pedido #---</p>
        </div>
        <div id="pdv-sucesso-detalhes" style="background: #f8fafc; border-radius: 8px; padding: 0.75rem; font-size: 0.85rem; color: #334155; margin-bottom: 1rem; line-height: 1.5;"></div>
        <div style="display: flex; gap: 0.5rem;">
          <button id="btn-pdv-imprimir-recibo" class="btn btn-outline" style="flex: 1; padding: 0.6rem; border-radius: 8px;">
            <i class="fa-solid fa-print"></i> Imprimir Recibo
          </button>
          <button id="btn-pdv-nova-venda" class="btn btn-primary" style="flex: 1; padding: 0.6rem; border-radius: 8px; background: #059669; border-color: #059669;">
            <i class="fa-solid fa-plus"></i> Nova Venda
          </button>
        </div>
      </div>
    </div>
  `;

  vincularEventosPdv();
  await carregarCatalogoPdv();
}

function vincularEventosPdv() {
  const btnAbaCaixa = document.getElementById('btn-pdv-aba-caixa');
  const btnAbaEstoque = document.getElementById('btn-pdv-aba-estoque');
  const btnRecarregar = document.getElementById('btn-pdv-recarregar');
  const buscaProd = document.getElementById('pdv-busca-produto');
  const filtroCat = document.getElementById('pdv-filtro-categoria');
  const btnLimpar = document.getElementById('btn-limpar-carrinho-pdv');
  const inputDesc = document.getElementById('pdv-input-desconto');
  const inputDinheiro = document.getElementById('pdv-dinheiro-recebido');
  const btnFinalizar = document.getElementById('btn-finalizar-venda-pdv');
  const btnToggleCli = document.getElementById('btn-toggle-cliente-pdv');
  const inputBuscaCli = document.getElementById('pdv-busca-cliente-input');
  const btnNovaVenda = document.getElementById('btn-pdv-nova-venda');
  const btnImprimir = document.getElementById('btn-pdv-imprimir-recibo');

  if (btnAbaCaixa) {
    btnAbaCaixa.onclick = () => alternarAba('caixa');
  }
  if (btnAbaEstoque) {
    btnAbaEstoque.onclick = () => alternarAba('estoque');
  }
  if (btnRecarregar) {
    btnRecarregar.onclick = async () => {
      if (pdvAbaAtiva === 'caixa') await carregarCatalogoPdv();
      else await carregarEstoqueLotesPdv();
    };
  }

  if (buscaProd) {
    buscaProd.oninput = () => renderizarCatalogoPdv();
  }
  if (filtroCat) {
    filtroCat.onchange = () => renderizarCatalogoPdv();
  }
  if (btnLimpar) {
    btnLimpar.onclick = () => {
      pdvCarrinho = [];
      renderizarCarrinhoPdv();
    };
  }

  if (inputDesc) {
    inputDesc.oninput = () => {
      const valor = parseFloat(inputDesc.value) || 0;
      const motivoContainer = document.getElementById('pdv-motivo-desconto-container');
      if (motivoContainer) {
        motivoContainer.style.display = valor > 0 ? 'block' : 'none';
      }
      atualizarTotaisPdv();
    };
  }

  if (inputDinheiro) {
    inputDinheiro.oninput = () => calcularTrocoPdv();
  }

  // Formas de pagamento
  document.querySelectorAll('.pdv-forma-pgto-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.pdv-forma-pgto-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const forma = btn.getAttribute('data-forma');
      const trocoContainer = document.getElementById('pdv-dinheiro-troco-container');
      if (trocoContainer) {
        trocoContainer.style.display = forma === 'dinheiro' ? 'block' : 'none';
      }
    };
  });

  // Toggle e busca cliente
  if (btnToggleCli) {
    btnToggleCli.onclick = () => {
      const container = document.getElementById('pdv-cliente-busca-container');
      if (container) {
        const aberto = container.style.display !== 'none';
        container.style.display = aberto ? 'none' : 'block';
        if (!aberto && inputBuscaCli) {
          inputBuscaCli.focus();
        }
      }
    };
  }

  if (inputBuscaCli) {
    inputBuscaCli.oninput = async () => {
      const termo = inputBuscaCli.value.trim();
      const sugestoes = document.getElementById('pdv-cliente-sugestoes');
      if (termo.length < 2) {
        if (sugestoes) sugestoes.style.display = 'none';
        return;
      }
      try {
        const { data, error } = await supabase
          .from('clientes')
          .select('id, nome, telefone, email')
          .or(`nome.ilike.%${termo}%,telefone.ilike.%${termo}%`)
          .limit(5);

        if (!error && data && data.length > 0 && sugestoes) {
          sugestoes.innerHTML = data
            .map(
              (c) => `
              <div class="pdv-cliente-item" style="padding: 0.4rem 0.6rem; cursor: pointer; border-bottom: 1px solid #f1f5f9; font-size: 0.8rem;" data-id="${c.id}" data-nome="${c.nome}">
                <strong>${c.nome}</strong> (${c.telefone || 'Sem telefone'})
              </div>
            `
            )
            .join('');
          sugestoes.style.display = 'block';

          sugestoes.querySelectorAll('.pdv-cliente-item').forEach((item) => {
            item.onclick = () => {
              const id = Number(item.getAttribute('data-id'));
              const nome = item.getAttribute('data-nome');
              selecionarCliente(id, nome);
            };
          });
        } else if (sugestoes) {
          sugestoes.style.display = 'none';
        }
      } catch (e) {
        console.error('Erro ao buscar clientes:', e);
      }
    };
  }

  if (btnFinalizar) {
    btnFinalizar.onclick = () => executarCheckoutPdv();
  }

  if (btnNovaVenda) {
    btnNovaVenda.onclick = () => {
      const modal = document.getElementById('modal-sucesso-pdv');
      if (modal) modal.style.display = 'none';
      pdvCarrinho = [];
      selecionarCliente(null, null);
      const descInput = document.getElementById('pdv-input-desconto');
      if (descInput) descInput.value = '0.00';
      const motivoInput = document.getElementById('pdv-motivo-desconto');
      if (motivoInput) motivoInput.value = '';
      const motivoContainer = document.getElementById('pdv-motivo-desconto-container');
      if (motivoContainer) motivoContainer.style.display = 'none';
      renderizarCarrinhoPdv();
      carregarCatalogoPdv();
    };
  }

  if (btnImprimir) {
    btnImprimir.onclick = () => window.print();
  }
}

function alternarAba(aba) {
  pdvAbaAtiva = aba;
  const caixa = document.getElementById('pdv-conteudo-caixa');
  const estoque = document.getElementById('pdv-conteudo-estoque');
  const btnCaixa = document.getElementById('btn-pdv-aba-caixa');
  const btnEstoque = document.getElementById('btn-pdv-aba-estoque');

  if (aba === 'caixa') {
    if (caixa) caixa.style.display = 'block';
    if (estoque) estoque.style.display = 'none';
    if (btnCaixa) btnCaixa.className = 'btn btn-primary';
    if (btnEstoque) btnEstoque.className = 'btn btn-outline';
    carregarCatalogoPdv();
  } else {
    if (caixa) caixa.style.display = 'none';
    if (estoque) estoque.style.display = 'block';
    if (btnCaixa) btnCaixa.className = 'btn btn-outline';
    if (btnEstoque) btnEstoque.className = 'btn btn-primary';
    carregarEstoqueLotesPdv();
  }
}

function selecionarCliente(id, nome) {
  pdvClienteSelecionado = id ? { id, nome } : null;
  const info = document.getElementById('pdv-cliente-info');
  const containerBusca = document.getElementById('pdv-cliente-busca-container');
  const sugestoes = document.getElementById('pdv-cliente-sugestoes');

  if (info) {
    if (pdvClienteSelecionado) {
      info.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 700; color: #0284c7;"><i class="fa-solid fa-user-check"></i> ${nome}</span>
          <button id="btn-remover-cliente-pdv" style="background: none; border: none; color: #ef4444; font-size: 0.75rem; cursor: pointer;">
            Remover
          </button>
        </div>
      `;
      const btnRemover = document.getElementById('btn-remover-cliente-pdv');
      if (btnRemover) {
        btnRemover.onclick = () => selecionarCliente(null, null);
      }
    } else {
      info.innerHTML = `<span class="badge" style="background: #e2e8f0; color: #475569; padding: 2px 6px; border-radius: 4px;">Consumidor Avulso</span>`;
    }
  }

  if (containerBusca) containerBusca.style.display = 'none';
  if (sugestoes) sugestoes.style.display = 'none';
}

async function carregarCatalogoPdv() {
  const grid = document.getElementById('pdv-grid-produtos');
  if (!grid) return;

  try {
    const { data, error } = await supabase.rpc('listar_catalogo_pdv');
    if (error) throw error;

    const lista = (data && data.produtos) ? data.produtos : (Array.isArray(data) ? data : []);
    pdvProdutos = lista.map((p) => ({
      ...p,
      id: p.produto_id || p.id,
      saldo_disponivel: Number(p.estoque_pronto_disponivel ?? p.saldo_disponivel ?? 0)
    }));
    popularCategoriasFiltro();
    renderizarCatalogoPdv();
  } catch (e) {
    console.error('Erro ao carregar catálogo PDV:', e);
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: #ef4444;">
        <i class="fa-solid fa-triangle-exclamation"></i> Erro ao carregar produtos do PDV.
      </div>
    `;
  }
}

function popularCategoriasFiltro() {
  const select = document.getElementById('pdv-filtro-categoria');
  if (!select) return;

  const categorias = Array.from(new Set(pdvProdutos.map((p) => p.categoria).filter(Boolean)));
  select.innerHTML = '<option value="todas">Todas as categorias</option>' +
    categorias.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function renderizarCatalogoPdv() {
  const grid = document.getElementById('pdv-grid-produtos');
  const busca = (document.getElementById('pdv-busca-produto')?.value || '').toLowerCase().trim();
  const cat = document.getElementById('pdv-filtro-categoria')?.value || 'todas';

  if (!grid) return;

  const filtrados = pdvProdutos.filter((p) => {
    const matchNome = !busca || p.nome.toLowerCase().includes(busca);
    const matchCat = cat === 'todas' || p.categoria === cat;
    return matchNome && matchCat;
  });

  if (filtrados.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 2rem; color: #64748b;">
        Nenhum produto pronto encontrado com os filtros atuais.
      </div>
    `;
    return;
  }

  grid.innerHTML = filtrados
    .map((p) => {
      const preco = Number(p.preco || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const saldo = Number(p.saldo_disponivel || 0);
      const semEstoque = saldo <= 0;

      return `
        <div class="pdv-card-produto ${semEstoque ? 'sem-estoque' : ''}" 
             data-id="${p.id}"
             style="border: 1px solid ${semEstoque ? '#f1f5f9' : '#e2e8f0'}; border-radius: 10px; padding: 0.75rem; background: ${semEstoque ? '#f8fafc' : '#fff'}; cursor: ${semEstoque ? 'not-allowed' : 'pointer'}; opacity: ${semEstoque ? '0.6' : '1'}; transition: all 0.15s ease; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.4rem;">
              <span style="font-size: 0.7rem; font-weight: 600; color: #64748b; text-transform: uppercase;">${p.categoria || 'Geral'}</span>
              <span class="badge" style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: ${saldo > 5 ? '#dcfce7' : saldo > 0 ? '#fef3c7' : '#fee2e2'}; color: ${saldo > 5 ? '#166534' : saldo > 0 ? '#92400e' : '#991b1b'};">
                ${saldo} disp
              </span>
            </div>
            <div style="font-weight: 700; color: #1e293b; font-size: 0.9rem; line-height: 1.25; margin-bottom: 0.5rem;">
              ${p.nome}
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; border-top: 1px dashed #e2e8f0; padding-top: 0.4rem;">
            <span style="font-size: 1rem; font-weight: 800; color: #059669;">${preco}</span>
            <button class="btn btn-sm btn-primary pdv-btn-add-item" data-id="${p.id}" ${semEstoque ? 'disabled' : ''} style="padding: 0.25rem 0.5rem; font-size: 0.75rem; border-radius: 6px; background: #6b2d5c; border-color: #6b2d5c;">
              <i class="fa-solid fa-plus"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.pdv-card-produto:not(.sem-estoque)').forEach((card) => {
    card.onclick = (e) => {
      const btn = e.target.closest('.pdv-btn-add-item');
      const id = Number(card.getAttribute('data-id'));
      adicionarAoCarrinho(id);
    };
  });
}

function adicionarAoCarrinho(produtoId) {
  const prod = pdvProdutos.find((p) => p.id === produtoId);
  if (!prod) return;

  const saldoDisponivel = Number(prod.saldo_disponivel || 0);
  const itemExistente = pdvCarrinho.find((i) => i.produto_id === produtoId);

  if (itemExistente) {
    if (itemExistente.quantidade + 1 > saldoDisponivel) {
      alert(`Estoque insuficiente! Apenas ${saldoDisponivel} unidade(s) de pronta entrega disponíveis.`);
      return;
    }
    itemExistente.quantidade += 1;
  } else {
    if (saldoDisponivel < 1) {
      alert('Produto sem estoque de pronta entrega no momento.');
      return;
    }
    pdvCarrinho.push({
      produto_id: prod.id,
      nome: prod.nome,
      preco_unitario: Number(prod.preco || 0),
      quantidade: 1,
      saldo_max: saldoDisponivel
    });
  }

  renderizarCarrinhoPdv();
}

function alterarQtdCarrinho(produtoId, delta) {
  const item = pdvCarrinho.find((i) => i.produto_id === produtoId);
  if (!item) return;

  const novaQtd = item.quantidade + delta;
  if (novaQtd <= 0) {
    pdvCarrinho = pdvCarrinho.filter((i) => i.produto_id !== produtoId);
  } else if (novaQtd > item.saldo_max) {
    alert(`Limite de pronta entrega atingido (${item.saldo_max} disp).`);
    return;
  } else {
    item.quantidade = novaQtd;
  }

  renderizarCarrinhoPdv();
}

function removerDoCarrinho(produtoId) {
  pdvCarrinho = pdvCarrinho.filter((i) => i.produto_id !== produtoId);
  renderizarCarrinhoPdv();
}

function renderizarCarrinhoPdv() {
  const container = document.getElementById('pdv-itens-carrinho');
  if (!container) return;

  if (pdvCarrinho.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: #94a3b8; font-size: 0.85rem; padding: 2rem 0;">
        Carrinho vazio. Clique nos produtos para adicionar.
      </div>
    `;
    atualizarTotaisPdv();
    return;
  }

  container.innerHTML = pdvCarrinho
    .map((item) => {
      const subtotal = item.quantidade * item.preco_unitario;
      const subtotalFormat = subtotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const unitFormat = item.preco_unitario.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0; border-bottom: 1px solid #f1f5f9; gap: 0.5rem;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 0.85rem; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${item.nome}
            </div>
            <div style="font-size: 0.75rem; color: #64748b;">${unitFormat} un</div>
          </div>
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <button class="btn btn-sm btn-outline pdv-btn-menos" data-id="${item.produto_id}" style="padding: 1px 6px; font-size: 0.75rem; border-radius: 4px;">-</button>
            <span style="font-size: 0.85rem; font-weight: 700; min-width: 20px; text-align: center;">${item.quantidade}</span>
            <button class="btn btn-sm btn-outline pdv-btn-mais" data-id="${item.produto_id}" style="padding: 1px 6px; font-size: 0.75rem; border-radius: 4px;">+</button>
          </div>
          <div style="font-weight: 700; font-size: 0.85rem; color: #0f172a; min-width: 65px; text-align: right;">
            ${subtotalFormat}
          </div>
          <button class="btn btn-sm pdv-btn-remove" data-id="${item.produto_id}" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 2px;">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.pdv-btn-menos').forEach((b) => {
    b.onclick = () => alterarQtdCarrinho(Number(b.getAttribute('data-id')), -1);
  });
  container.querySelectorAll('.pdv-btn-mais').forEach((b) => {
    b.onclick = () => alterarQtdCarrinho(Number(b.getAttribute('data-id')), 1);
  });
  container.querySelectorAll('.pdv-btn-remove').forEach((b) => {
    b.onclick = () => removerDoCarrinho(Number(b.getAttribute('data-id')));
  });

  atualizarTotaisPdv();
}

function atualizarTotaisPdv() {
  const subtotal = pdvCarrinho.reduce((acc, i) => acc + i.quantidade * i.preco_unitario, 0);
  const inputDesc = document.getElementById('pdv-input-desconto');
  let desconto = parseFloat(inputDesc?.value) || 0;

  if (desconto > subtotal) {
    desconto = subtotal;
    if (inputDesc) inputDesc.value = subtotal.toFixed(2);
  }

  const total = Math.max(0, subtotal - desconto);

  const subtotalEl = document.getElementById('pdv-resumo-subtotal');
  const descontoEl = document.getElementById('pdv-resumo-desconto');
  const totalEl = document.getElementById('pdv-resumo-total');

  if (subtotalEl) subtotalEl.textContent = subtotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  if (descontoEl) descontoEl.textContent = `- ${desconto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  if (totalEl) totalEl.textContent = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  calcularTrocoPdv();
}

function calcularTrocoPdv() {
  const subtotal = pdvCarrinho.reduce((acc, i) => acc + i.quantidade * i.preco_unitario, 0);
  const desconto = parseFloat(document.getElementById('pdv-input-desconto')?.value) || 0;
  const total = Math.max(0, subtotal - desconto);

  const recebido = parseFloat(document.getElementById('pdv-dinheiro-recebido')?.value) || 0;
  const trocoTexto = document.getElementById('pdv-dinheiro-troco-texto');

  if (trocoTexto) {
    if (recebido >= total && total > 0) {
      const troco = recebido - total;
      trocoTexto.textContent = `Troco: ${troco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
      trocoTexto.style.color = '#15803d';
    } else {
      trocoTexto.textContent = 'Troco: R$ 0,00';
      trocoTexto.style.color = '#b91c1c';
    }
  }
}

async function executarCheckoutPdv() {
  if (pdvCarrinho.length === 0) {
    alert('Adicione pelo menos um item ao carrinho.');
    return;
  }

  const subtotal = pdvCarrinho.reduce((acc, i) => acc + i.quantidade * i.preco_unitario, 0);
  const desconto = parseFloat(document.getElementById('pdv-input-desconto')?.value) || 0;
  const motivoDesconto = document.getElementById('pdv-motivo-desconto')?.value?.trim() || null;

  if (desconto > 0 && !motivoDesconto) {
    alert('Justificativa de desconto é obrigatória para concessão de descontos no balcão.');
    document.getElementById('pdv-motivo-desconto')?.focus();
    return;
  }

  const formaBtn = document.querySelector('.pdv-forma-pgto-btn.active');
  const formaPagamento = formaBtn?.getAttribute('data-forma') || 'pix';
  const cpfNota = document.getElementById('pdv-cpf-na-nota')?.value?.trim() || null;

  const btnFinalizar = document.getElementById('btn-finalizar-venda-pdv');
  if (btnFinalizar) {
    btnFinalizar.disabled = true;
    btnFinalizar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando venda...';
  }

  const chaveIdempotencia = 'pdv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  const itensPayload = pdvCarrinho.map((i) => ({
    produto_id: i.produto_id,
    quantidade: i.quantidade
  }));

  try {
    const { data, error } = await supabase.rpc('finalizar_venda_pdv', {
      p_itens: itensPayload,
      p_cliente_id_rel: pdvClienteSelecionado ? pdvClienteSelecionado.id : null,
      p_forma_pagamento: formaPagamento,
      p_desconto: desconto,
      p_motivo_desconto: motivoDesconto,
      p_chave_idempotencia: chaveIdempotencia,
      p_observacoes: cpfNota ? ('CPF na nota: ' + cpfNota) : null
    });

    if (!data || !data.success) {
      if (data?.code === 'CASH_SESSION_REQUIRED') {
        if (confirm('Atenção: Nenhuma sessão de caixa aberta para este operador.\n\nDeseja abrir o caixa agora na aba Sessões de Caixa?')) {
          if (typeof window.mudarTabAdmin === 'function') {
            window.mudarTabAdmin('caixa');
          }
        }
        return;
      }
      throw new Error(data?.error || 'Falha ao concluir venda no PDV.');
    }

    exibirSucessoPdv(data);
  } catch (e) {
    console.error('Erro na venda PDV:', e);
    alert('Erro ao finalizar venda: ' + (e.message || 'Verifique o console.'));
  } finally {
    if (btnFinalizar) {
      btnFinalizar.disabled = false;
      btnFinalizar.innerHTML = '<i class="fa-solid fa-check"></i> Finalizar Venda (PDV)';
    }
  }
}

function exibirSucessoPdv(res) {
  const modal = document.getElementById('modal-sucesso-pdv');
  const numEl = document.getElementById('pdv-sucesso-numero');
  const detEl = document.getElementById('pdv-sucesso-detalhes');

  if (numEl) numEl.textContent = `Pedido #${res.pedido_id}`;

  const lotesInfo = (res.consumos_lotes || [])
    .map((c) => `<li>${c.quantidade}x lote <strong>${c.lote_codigo}</strong> (val: ${c.data_validade})</li>`)
    .join('');

  if (detEl) {
    detEl.innerHTML = `
      <div><strong>Status:</strong> ${res.status_operacional?.toUpperCase()} / ${res.status_financeiro?.toUpperCase()}</div>
      <div><strong>Total Pago:</strong> ${Number(res.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</div>
      <div><strong>Forma:</strong> ${res.forma_pagamento?.toUpperCase()}</div>
      ${res.desconto > 0 ? `<div><strong>Desconto:</strong> ${Number(res.desconto).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</div>` : ''}
      <div style="margin-top: 0.5rem; border-top: 1px dashed #cbd5e1; padding-top: 0.4rem;">
        <strong>Rastreabilidade FEFO Alocada:</strong>
        <ul style="margin: 0.25rem 0 0; padding-left: 1.25rem;">${lotesInfo || '<li>Sem consumo direto de lote</li>'}</ul>
      </div>
    `;
  }

  if (modal) modal.style.display = 'flex';
}

async function carregarEstoqueLotesPdv() {
  const container = document.getElementById('pdv-tabela-lotes-container');
  if (!container) return;

  try {
    const { data, error } = await supabase.rpc('obter_estoque_produto_pronto_admin');
    if (error) throw error;

    pdvLotesEstoque = (data && data.lotes) ? data.lotes : [];
    renderizarTabelaLotesPdv();
  } catch (e) {
    console.error('Erro ao carregar estoque de produto pronto:', e);
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #ef4444;">
        <i class="fa-solid fa-triangle-exclamation"></i> Erro ao consultar estoque de produtos prontos.
      </div>
    `;
  }
}

function renderizarTabelaLotesPdv() {
  const container = document.getElementById('pdv-tabela-lotes-container');
  if (!container) return;

  if (pdvLotesEstoque.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #64748b;">
        Nenhum lote de produto pronto ativo no momento.
      </div>
    `;
    return;
  }

  const hoje = new Date().toISOString().slice(0, 10);

  container.innerHTML = `
    <table class="table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
      <thead>
        <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0; text-align: left; color: #475569;">
          <th style="padding: 0.6rem 0.75rem;">Lote</th>
          <th style="padding: 0.6rem 0.75rem;">Produto</th>
          <th style="padding: 0.6rem 0.75rem;">Validade (FEFO)</th>
          <th style="padding: 0.6rem 0.75rem; text-align: center;">Qtd Inicial</th>
          <th style="padding: 0.6rem 0.75rem; text-align: center;">Disponível</th>
          <th style="padding: 0.6rem 0.75rem; text-align: center;">Qualidade</th>
        </tr>
      </thead>
      <tbody>
        ${pdvLotesEstoque
          .map((lote) => {
            const vencido = lote.data_validade < hoje;
            const disponivel = Number(lote.quantidade_disponivel || 0);
            const bloqueado = Boolean(lote.bloqueado_qualidade);
            return `
              <tr style="border-bottom: 1px solid #f1f5f9; ${vencido || bloqueado ? 'background: #fff1f2;' : ''}">
                <td style="padding: 0.6rem 0.75rem; font-family: monospace; font-weight: 700; color: #0284c7;">
                  ${lote.codigo_lote}
                </td>
                <td style="padding: 0.6rem 0.75rem; font-weight: 600; color: #1e293b;">
                  ${lote.produto_nome}
                </td>
                <td style="padding: 0.6rem 0.75rem; color: ${vencido ? '#e11d48' : '#059669'}; font-weight: ${vencido ? '700' : '500'};">
                  ${lote.data_validade} ${vencido ? '<span class="badge" style="background:#fee2e2; color:#991b1b; padding:1px 4px; font-size:0.7rem; border-radius:4px;">VENCIDO</span>' : ''}
                </td>
                <td style="padding: 0.6rem 0.75rem; text-align: center; font-weight: 700;">
                  ${lote.quantidade_inicial}
                </td>
                <td style="padding: 0.6rem 0.75rem; text-align: center; font-weight: 800; color: ${disponivel > 0 ? '#059669' : '#dc2626'};">
                  ${disponivel}
                </td>
                <td style="padding: 0.6rem 0.75rem; text-align: center;">
                  <span class="badge" style="padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; background: ${bloqueado ? '#fee2e2' : '#dcfce7'}; color: ${bloqueado ? '#991b1b' : '#166534'};">
                    ${bloqueado ? 'BLOQUEADO' : 'LIBERADO'}
                  </span>
                </td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

if (typeof window !== 'undefined') {
  window.carregarPdvAdmin = carregarPdvAdmin;
}
