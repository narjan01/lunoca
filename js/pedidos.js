// ==========================================================================
// LUNOCA DOCERIA - Módulo de Pedidos e Integração Mercado Pago
// ==========================================================================

let modalidadePedidoAtual = 'entrega';

function selecionarModalidade(tipo) {
    modalidadePedidoAtual = tipo === 'retirada' ? 'retirada' : 'entrega';
    
    const btnEntrega = document.getElementById('btn-modalidade-entrega');
    const btnRetirada = document.getElementById('btn-modalidade-retirada');
    const containerEnd = document.getElementById('campo-endereco-container');
    const avisoRetirada = document.getElementById('aviso-retirada-balcao');
    const labelData = document.getElementById('label-data-pedido');

    if (modalidadePedidoAtual === 'retirada') {
        if (btnRetirada) btnRetirada.classList.add('active');
        if (btnEntrega) btnEntrega.classList.remove('active');
        if (containerEnd) containerEnd.style.display = 'none';
        if (avisoRetirada) avisoRetirada.style.display = 'block';
        if (labelData) labelData.innerHTML = '<i class="fa-regular fa-calendar"></i> Data de Retirada no Balcão (Mínimo 2 dias úteis)';
    } else {
        if (btnEntrega) btnEntrega.classList.add('active');
        if (btnRetirada) btnRetirada.classList.remove('active');
        if (containerEnd) containerEnd.style.display = 'block';
        if (avisoRetirada) avisoRetirada.style.display = 'none';
        if (labelData) labelData.innerHTML = '<i class="fa-regular fa-calendar"></i> Data de Entrega (Mínimo 2 dias úteis)';
    }
}

function mascaraCPF(input) {
    let v = String(input.value || '').replace(/\D/g, '');
    if (v.length > 9) {
        input.value = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
    } else if (v.length > 6) {
        input.value = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
    } else if (v.length > 3) {
        input.value = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
    } else {
        input.value = v;
    }
}

async function enviarPedido() {
    if (!usuarioAtual || usuarioAtual.nivel === 'visitante') {
        alert("Por favor, faça login ou cadastre-se para finalizar seu pedido!");
        mostrarTela('login-section');
        return;
    }

    let data = document.getElementById('data-pedido').value;
    let formaPagamento = document.getElementById('pagamento').value;
    let modalidade = modalidadePedidoAtual || 'entrega';
    let end = '';

    if (modalidade === 'retirada') {
        end = 'Retirada no Balcão (Loja Lunoca)';
    } else {
        end = (document.getElementById('endereco-checkout')?.value || '').trim();
        if (!end) {
            return alert("Por favor, informe o endereço completo de entrega!");
        }
    }
        
    if (!data) {
        return alert("Por favor, selecione a data agendada para " + (modalidade === 'retirada' ? 'a retirada!' : 'a entrega!'));
    }

    // Validação estrita do CPF digitado no checkout
    let cpfInput = (document.getElementById('checkout-cpf')?.value || '').replace(/\D/g, '');
    if (cpfInput.length !== 11) {
        return alert("Por favor, digite um CPF válido com 11 dígitos para emissão do pagamento.");
    }

    if (!carrinho || carrinho.length === 0) {
        return alert("Seu carrinho está vazio!");
    }
        
    let nomesItens = [];
    let itensParaValidar = [];
        
    for (let i = 0; i < carrinho.length; i++) {
        const item = carrinho[i];
        const qtd = Math.max(1, parseInt(item.quantidade || 1, 10));
        const prefixoQtd = qtd > 1 ? `${qtd}x ` : '';
        nomesItens.push(prefixoQtd + item.nome);
        itensParaValidar.push({
            id: item.id || null,
            nome: item.nome,
            preco: item.preco,
            quantidade: qtd
        });
    }

    const btnConfirmar = document.getElementById('btn-confirmar-checkout');
    let textoOriginalBtn = '';
    if (btnConfirmar) {
        textoOriginalBtn = btnConfirmar.innerHTML;
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando Pedido...';
    }

    try {
        // Validação server-side: recalcula o total com preços reais do banco e quantidades
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
                console.warn('Validação server-side indisponível, usando total local:', valData.error);
                for (let i = 0; i < carrinho.length; i++) {
                    const qtd = Math.max(1, parseInt(carrinho[i].quantidade || 1, 10));
                    total += parseFloat(carrinho[i].preco) * qtd;
                }
            }
        } catch (valErr) {
            console.warn('Endpoint de validação offline, usando total local:', valErr.message);
            for (let i = 0; i < carrinho.length; i++) {
                const qtd = Math.max(1, parseInt(carrinho[i].quantidade || 1, 10));
                total += parseFloat(carrinho[i].preco) * qtd;
            }
        }

        // Salva/atualiza o CPF do cliente no perfil do Supabase de forma transparente
        if (usuarioAtual.id && usuarioAtual.cpf !== cpfInput) {
            usuarioAtual.cpf = cpfInput;
            supabaseClient.from('profiles').update({ cpf: cpfInput }).eq('id', usuarioAtual.id).catch(() => {});
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

        // Limpar carrinho após inserção do pedido
        carrinho = [];
        salvarCarrinhoLocal();
        atualizarBotaoCarrinho();

        // Dados completos do pagador com o CPF verificado
        const clienteDados = {
            nome: usuarioAtual.nome || 'Cliente Lunoca',
            email: usuarioAtual.email || 'cliente@lunocadoceria.com.br',
            cpf: cpfInput
        };

        // Iniciar fluxo de pagamento Mercado Pago (Pix ou Cartão)
        if (typeof iniciarPagamentoMercadoPago === 'function') {
            await iniciarPagamentoMercadoPago(pedidoId, total, itensParaMP, formaPagamento, clienteDados);
        } else {
            alert("Pedido Confirmado! A Lunoca agradece a preferência.");
            mostrarTela('menu-section');
        }
    } catch (err) {
        console.error(err);
        alert("Erro ao enviar pedido: " + (err.message || 'Verifique sua conexão.'));
    } finally {
        if (btnConfirmar) {
            btnConfirmar.disabled = false;
            btnConfirmar.innerHTML = textoOriginalBtn || '<i class="fa-solid fa-check"></i> Confirmar Pedido';
        }
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

async function carregarMeusPedidos() {
    const lista = document.getElementById('lista-meus-pedidos');
    if (!lista) return;

    if (!usuarioAtual || !usuarioAtual.id) {
        lista.innerHTML = "<p style='text-align:center; color:#888;'>Faça login para ver suas encomendas.</p>";
        return;
    }

    lista.innerHTML = "<p style='text-align:center; color:#888;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando suas encomendas...</p>";

    try {
        const { data: pedidos, error } = await supabaseClient
            .from('pedidos')
            .select('*')
            .eq('cliente_id', usuarioAtual.id)
            .order('data_pedido', { ascending: false });

        if (error) throw error;

        if (!pedidos || pedidos.length === 0) {
            lista.innerHTML = `
                <div style="text-align:center; padding: 30px 10px; color:#888;">
                    <i class="fa-solid fa-cake-candles" style="font-size:38px; color:#d8b4f8; margin-bottom:12px; display:block;"></i>
                    <p style="font-size:14px; margin:0 0 12px 0;">Você ainda não fez nenhuma encomenda conosco.</p>
                    <button class="btn-outline" onclick="mostrarTela('menu-section')" style="font-size:12px; padding:6px 14px;">
                        <i class="fa-solid fa-cake-candles"></i> Ver Cardápio de Doces
                    </button>
                </div>
            `;
            return;
        }

        let html = '';
        for (let i = 0; i < pedidos.length; i++) {
            const p = pedidos[i];
            const dataEntregaFormatada = p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : 'A combinar';
            const dataPedidoFormatada = p.data_pedido ? p.data_pedido.split('-').reverse().join('/') : '';
            const statusAtual = p.status || 'Pendente';
            const totalFormatado = parseFloat(p.total || 0).toFixed(2);
            const isRetirada = (p.endereco_entrega || '').toLowerCase().includes('retirada no balcão');

            let statusBadge = '';
            if (statusAtual === 'Pendente') {
                statusBadge = '<span class="status-badge status-pendente"><i class="fa-solid fa-clock"></i> Pendente</span>';
            } else if (statusAtual === 'Confirmado' || statusAtual === 'Em Preparo') {
                statusBadge = '<span class="status-badge status-preparo"><i class="fa-solid fa-fire-burner"></i> ' + statusAtual + '</span>';
            } else if (statusAtual === 'Pronto') {
                statusBadge = '<span class="status-badge status-pronto"><i class="fa-solid fa-gift"></i> Pronto</span>';
            } else if (statusAtual === 'Entregue') {
                statusBadge = '<span class="status-badge status-entregue"><i class="fa-solid fa-circle-check"></i> Entregue</span>';
            } else if (statusAtual === 'Cancelado') {
                statusBadge = '<span class="status-badge status-cancelado"><i class="fa-solid fa-circle-xmark"></i> Cancelado</span>';
            } else {
                statusBadge = '<span class="status-badge status-outro">' + escapeHTML(statusAtual) + '</span>';
            }

            const modalidadeBadge = isRetirada
                ? '<span style="font-size:11px; font-weight:700; color:#065f46; background:#d1fae5; padding:2px 8px; border-radius:12px;"><i class="fa-solid fa-store"></i> Retirada</span>'
                : '<span style="font-size:11px; font-weight:700; color:#0369a1; background:#e0f2fe; padding:2px 8px; border-radius:12px;"><i class="fa-solid fa-motorcycle"></i> Entrega</span>';

            let btnReabrirPix = '';
            if (statusAtual === 'Pendente' && p.pagamento === 'pix') {
                btnReabrirPix = `
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e2e8f0;">
                        <button onclick="reabrirPixPedido('${p.id}', ${p.total})" style="width:100%; padding:9px; background:#0284c7; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <i class="fa-brands fa-pix"></i> Pagar Agora / Ver QR Code Pix
                        </button>
                    </div>
                `;
            }

            html += `
                <div class="user-order-card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                        <div>
                            <strong style="color:var(--text-dark); font-size:15px;">Pedido #${p.id}</strong>
                            ${dataPedidoFormatada ? `<span style="font-size:11px; color:#888; margin-left:6px;">(${dataPedidoFormatada})</span>` : ''}
                        </div>
                        <div style="display:flex; gap:6px; align-items:center;">
                            ${modalidadeBadge}
                            ${statusBadge}
                        </div>
                    </div>
                    <div style="font-size:13px; color:#555; line-height:1.6;">
                        <div><strong>Data Agendada:</strong> ${dataEntregaFormatada}</div>
                        <div><strong>Total:</strong> <span style="color:var(--primary-dark); font-weight:700; font-size:14px;">R$ ${totalFormatado}</span> (${p.pagamento === 'pix' ? 'Pix' : 'Cartão'})</div>
                        <div style="margin-top:6px; padding:8px 10px; background:#f8fafc; border-radius:8px; border:1px solid #f1f5f9;">
                            <strong style="font-size:11px; text-transform:uppercase; color:#64748b; display:block;">Doces:</strong>
                            ${escapeHTML(p.itens || '')}
                        </div>
                        <div style="font-size:11px; color:#777; margin-top:6px;">
                            <i class="fa-solid fa-location-dot"></i> ${escapeHTML(p.endereco_entrega || 'Balcão')}
                        </div>
                    </div>
                    ${btnReabrirPix}
                </div>
            `;
        }

        lista.innerHTML = html;
    } catch (err) {
        console.error('Erro ao carregar meus pedidos:', err);
        lista.innerHTML = "<p style='text-align:center; color:#ef4444;'>Erro ao carregar seus pedidos. Tente novamente.</p>";
    }
}

async function reabrirPixPedido(pedidoId, total) {
    if (typeof iniciarPagamentoMercadoPago === 'function') {
        const clienteDados = {
            nome: usuarioAtual?.nome || 'Cliente Lunoca',
            email: usuarioAtual?.email || 'cliente@lunocadoceria.com.br',
            cpf: usuarioAtual?.cpf || '19119119100'
        };
        await iniciarPagamentoMercadoPago(pedidoId, total, [], 'pix', clienteDados);
    }
}
