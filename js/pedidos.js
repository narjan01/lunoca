// ==========================================================================
// LUNOCA DOCERIA - Módulo de Pedidos e Integração Mercado Pago
// ==========================================================================

async function enviarPedido() {
    let data = document.getElementById('data-pedido').value;
    let end = document.getElementById('endereco-checkout').value;
    let formaPagamento = document.getElementById('pagamento').value;
        
    if (!data || !end) {
        return alert("Preencha a data e verifique o endereço de entrega!");
    }

    if (!carrinho || carrinho.length === 0) {
        return alert("Seu carrinho está vazio!");
    }
        
    let nomesItens = [];
    let itensParaValidar = [];
        
    for (let i = 0; i < carrinho.length; i++) {
        nomesItens.push(carrinho[i].nome);
        itensParaValidar.push({
            id: carrinho[i].id || null,
            nome: carrinho[i].nome,
            preco: carrinho[i].preco
        });
    }

    try {
        // Validação server-side: recalcula o total com preços reais do banco
        let total = 0;
        let itensParaMP = itensParaValidar;
        try {
            const valRes = await fetch('/api/validate-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itens: itensParaValidar })
            });
            const valData = await valRes.json();
            if (valRes.ok && valData.success) {
                total = valData.totalValidado;
                itensParaMP = valData.itensValidados;
            } else {
                // Fallback: calcula localmente se a validação falhar
                console.warn('Validação server-side indisponível, usando total local:', valData.error);
                for (let i = 0; i < carrinho.length; i++) {
                    total += parseFloat(carrinho[i].preco);
                }
            }
        } catch (valErr) {
            // Fallback: calcula localmente se o endpoint estiver offline
            console.warn('Endpoint de validação offline, usando total local:', valErr.message);
            for (let i = 0; i < carrinho.length; i++) {
                total += parseFloat(carrinho[i].preco);
            }
        }

        const { data: inserted, error } = await supabaseClient.from('pedidos').insert({
            cliente_id: usuarioAtual.id,
            nome_cliente: usuarioAtual.nome,
            email_cliente: usuarioAtual.email,
            data_pedido: new Date().toISOString().split('T')[0],
            data_entrega: data,
            total: total,
            pagamento: formaPagamento,
            status: 'Pendente',
            itens: nomesItens.join(' + '),
            endereco_entrega: end
        }).select();

        if (error) throw error;

        const pedidoId = (inserted && inserted[0]) ? inserted[0].id : Date.now();
        // Baixa automática no estoque para os doces vendidos
        if (typeof darBaixaEstoqueAposPedido === 'function') {
            darBaixaEstoqueAposPedido(itensParaMP, pedidoId);
        }

        // Limpar carrinho após confirmação
        carrinho = [];
        salvarCarrinhoLocal();
        atualizarBotaoCarrinho();

        // Iniciar fluxo de pagamento Mercado Pago (Pix ou Cartão)
        if (typeof iniciarPagamentoMercadoPago === 'function') {
            await iniciarPagamentoMercadoPago(pedidoId, total, itensParaMP, formaPagamento);
        } else {
            alert("Pedido Confirmado! A Lunoca agradece a preferência.");
            mostrarTela('menu-section');
        }
    } catch (err) {
        console.error(err);
        alert("Erro ao enviar pedido: " + (err.message || 'Verifique sua conexão.'));
    }
}

async function carregarPedidosAdmin() {
    const lista = document.getElementById('lista-pedidos-admin');
    if (!lista) return;

    lista.innerHTML = "<p style='text-align:center;'><i class='fa-solid fa-spinner fa-spin'></i> Buscando pedidos...</p>";

    try {
        const { data: pedidos, error } = await supabaseClient.from('pedidos').select('*').order('data_entrega', { ascending: false });
        if (error) throw error;
                
        pedidosGlobal = pedidos || [];
        if (pedidosGlobal.length === 0) {
            lista.innerHTML = "<p style='text-align:center; color:#888;'>Nenhum pedido encontrado.</p>";
            return;
        }

        const STATUS_OPTIONS = ['Pendente', 'Confirmado', 'Em Preparo', 'Pronto', 'Entregue', 'Cancelado'];
                
        let html = '';
        for (let i = 0; i < pedidosGlobal.length; i++) {
            let p = pedidosGlobal[i];
            let dtaStr = p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : "Data Indefinida";
            let statusAtual = p.status || 'Pendente';

            let selectStatus = '<select onchange="atualizarStatusPedido(\'' + p.id + '\', this.value)" style="font-size:12px; font-weight:bold; padding:4px 8px; border-radius:6px; border:1px solid #ccc; background:#fff; cursor:pointer;">';
            for (let s = 0; s < STATUS_OPTIONS.length; s++) {
                let opt = STATUS_OPTIONS[s];
                selectStatus += '<option value="' + opt + '" ' + (opt === statusAtual ? 'selected' : '') + '>' + opt + '</option>';
            }
            selectStatus += '</select>';

            let tipoBadge = p.pagamento === 'pix' 
                ? '<span style="background:#e6fffa; color:#0d9488; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;"><i class="fa-brands fa-pix"></i> PIX</span>'
                : '<span style="background:#eff6ff; color:#2563eb; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;"><i class="fa-solid fa-credit-card"></i> Cartão</span>';

            let linkMPBtn = p.mercado_pago_link 
                ? `<a href="${p.mercado_pago_link}" target="_blank" rel="noopener" style="margin-left:8px; text-decoration:none;">
                    <button style="padding:3px 8px; font-size:11px; background:#009ee3; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> Link Mercado Pago
                    </button>
                   </a>`
                : '';

            html += '<div class="admin-item-card">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">' +
                    '<h4 style="margin:0; color:var(--primary); font-size: 16px;"><i class="fa-regular fa-calendar-check"></i> Entrega: ' + dtaStr + '</h4>' +
                    '<div style="display:flex; align-items:center; gap:6px;">' +
                        tipoBadge +
                        '<span style="font-size:12px; font-weight:bold; color:#555; margin-left:6px;">Status:</span> ' + selectStatus +
                    '</div>' +
                '</div>' +
                '<div style="margin-top: 10px; font-size:13px; color: #555;">' +
                    '<p style="margin:4px 0;"><strong>Cliente:</strong> ' + escapeHTML(p.nome_cliente) + '</p>' +
                    '<p style="margin:4px 0;"><strong>Contato:</strong> ' + escapeHTML(p.email_cliente) + '</p>' +
                    '<p style="margin:4px 0;"><strong>Valor:</strong> R$ ' + parseFloat(p.total).toFixed(2) + ' | <strong>Endereço:</strong> ' + escapeHTML(p.endereco_entrega || 'Balcão') + linkMPBtn + '</p>' +
                    '<p style="margin:8px 0 0 0; padding:8px; background:#f9f9f9; border-radius:6px; border:1px solid #eee;"><strong>Cesta:</strong> ' + escapeHTML(p.itens) + '</p>' +
                '</div>' +
            '</div>';
        }
        lista.innerHTML = html;
    } catch (err) {
        console.error(err);
        lista.innerHTML = "<p style='color:red; text-align:center;'>Erro ao carregar pedidos.</p>";
    }
}

async function atualizarStatusPedido(pedidoId, novoStatus) {
    try {
        const { error } = await supabaseClient.from('pedidos').update({ status: novoStatus }).eq('id', pedidoId);
        if (error) throw error;
        alert("Status atualizado para: " + novoStatus);
        let ped = pedidosGlobal.find(p => String(p.id) === String(pedidoId));
        if (ped) ped.status = novoStatus;
        if (typeof renderizarCalendario === 'function') renderizarCalendario();
    } catch (err) {
        console.error(err);
        alert("Erro ao atualizar status do pedido.");
    }
}

function mudarMes(delta) {
    dataCalendario.setMonth(dataCalendario.getMonth() + delta);
    renderizarCalendario();
}

function renderizarCalendario() {
    if (!pedidosGlobal) pedidosGlobal = [];
    let ano = dataCalendario.getFullYear();
    let mes = dataCalendario.getMonth();
    const mesesStr = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        
    const mesEl = document.getElementById('mes-ano-atual');
    if (mesEl) mesEl.innerText = mesesStr[mes] + " " + ano;
        
    let primeiroDia = new Date(ano, mes, 1).getDay();
    let diasNoMes = new Date(ano, mes + 1, 0).getDate();
        
    let html = '<tr>';
    let diaAtual = 1;
        
    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 7; j++) {
            if ((i === 0 && j < primeiroDia) || diaAtual > diasNoMes) {
                html += '<td></td>';
            } else {
                let dataFormatada = ano + "-" + String(mes+1).padStart(2,'0') + "-" + String(diaAtual).padStart(2,'0');
                let pedidosDoDia = pedidosGlobal.filter(function(p) { return p.data_entrega === dataFormatada; });
                let classe = pedidosDoDia.length > 0 ? 'has-order' : '';
                html += '<td class="' + classe + '" onclick="mostrarPedidosDia(\'' + dataFormatada + '\')">' + diaAtual + (pedidosDoDia.length > 0 ? '<br><i class="fa-solid fa-gift" style="font-size:10px;"></i>' : '') + '</td>';
                diaAtual++;
            }
        }
        html += '</tr>';
        if (diaAtual > diasNoMes) break;
    }
    const corpo = document.getElementById('calendario-corpo');
    if (corpo) corpo.innerHTML = html;
}

function mostrarPedidosDia(data) {
    if (!pedidosGlobal) pedidosGlobal = [];
    let pedidosDoDia = pedidosGlobal.filter(function(p) { return p.data_entrega === data; });
    let div = document.getElementById('detalhes-dia-calendario');
    if (!div) return;
        
    if (pedidosDoDia.length === 0) {
        div.innerHTML = "<p style='text-align:center; color:#999;'>Nenhuma entrega para este dia.</p>";
        return;
    }
        
    let html = '<h4 style="margin-top:0; color:var(--primary);"><i class="fa-solid fa-list"></i> Entregas de ' + data.split('-').reverse().join('/') + '</h4>';
    for (let i = 0; i < pedidosDoDia.length; i++) {
        let p = pedidosDoDia[i];
        html += '<div style="background:#f9f9f9; padding:10px; border-radius:8px; margin-bottom:8px; border:1px solid #eee; font-size:13px;">';
        html += '<strong>' + escapeHTML(p.nome_cliente) + '</strong> - R$ ' + parseFloat(p.total).toFixed(2) + '<br>';
        html += '<span style="color:#666;">' + escapeHTML(p.itens) + '</span>';
        html += '</div>';
    }
    div.innerHTML = html;
}
