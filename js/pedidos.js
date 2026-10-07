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

    const btnConfirmar = document.getElementById('btn-confirmar-checkout');
    const textoOriginalBtn = btnConfirmar ? btnConfirmar.innerHTML : '';

    if (btnConfirmar) {
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando Pedido...';
    }

    // Coleta dos dados do formulário
    let nomeInput = (document.getElementById('checkout-nome')?.value || usuarioAtual.nome || '').trim();
    let whatsappInput = (document.getElementById('checkout-whatsapp')?.value || usuarioAtual.telefone || '').trim();
    let cpfInput = (document.getElementById('checkout-cpf')?.value || usuarioAtual.cpf || '').replace(/\D/g, '');
    let cepInput = (document.getElementById('checkout-cep')?.value || usuarioAtual.cep || '').trim();
    let ruaInput = (document.getElementById('checkout-rua')?.value || usuarioAtual.endereco || '').trim();
    let numeroInput = (document.getElementById('checkout-numero')?.value || usuarioAtual.numero || '').trim();
    let complementoInput = (document.getElementById('checkout-complemento')?.value || usuarioAtual.complemento || '').trim();

    let data = document.getElementById('data-pedido').value;
    let formaPagamento = document.getElementById('pagamento').value;
    let modalidade = modalidadePedidoAtual || 'entrega';
    let end = '';

    // Validações
    if (!nomeInput) {
        if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
        return alert("Por favor, informe seu nome completo!");
    }

    const foneLimpo = whatsappInput.replace(/\D/g, '');
    if (foneLimpo.length < 10 || foneLimpo.length > 11) {
        if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
        return alert("Por favor, informe um WhatsApp válido com DDD (ex: (21) 98765-4321) para acompanhar seu pedido!");
    }

    if (!validarCPF(cpfInput)) {
        if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
        return alert("Por favor, digite um CPF válido e com dígitos verificadores corretos para o pagamento.");
    }

    if (modalidade === 'retirada') {
        end = 'Retirada no Balcão (Loja Lunoca)';
    } else {
        if (ruaInput) {
            end = ruaInput + (numeroInput ? ', ' + numeroInput : '') + (complementoInput ? ' - ' + complementoInput : '') + (cepInput ? ' (CEP: ' + cepInput + ')' : '');
        } else {
            end = (document.getElementById('endereco-checkout')?.value || '').trim();
        }
        if (!end) {
            if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
            return alert("Por favor, informe o endereço completo de entrega!");
        }
    }

    if (!data) {
        if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
        return alert("Por favor, selecione a data agendada para " + (modalidade === 'retirada' ? 'a retirada!' : 'a entrega!'));
    }

    if (!carrinho || carrinho.length === 0) {
        if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.innerHTML = textoOriginalBtn; }
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

    try {
        // Validação server-side de preços e totais
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
                for (let i = 0; i < carrinho.length; i++) {
                    const qtd = Math.max(1, parseInt(carrinho[i].quantidade || 1, 10));
                    total += parseFloat(carrinho[i].preco) * qtd;
                }
            }
        } catch (valErr) {
            for (let i = 0; i < carrinho.length; i++) {
                const qtd = Math.max(1, parseInt(carrinho[i].quantidade || 1, 10));
                total += parseFloat(carrinho[i].preco) * qtd;
            }
        }

        // =====================================================================
        // Sincronização Automática dos Dados da Compra no Perfil do Cliente
        // =====================================================================
        if (usuarioAtual && usuarioAtual.id) {
            const dadosAtualizados = {
                nome: nomeInput,
                cpf: cpfInput,
                telefone: whatsappInput,
                cep: cepInput,
                endereco: ruaInput || end,
                numero: numeroInput,
                complemento: complementoInput
            };

            try {
                await supabaseClient.from('profiles').update(dadosAtualizados).eq('id', usuarioAtual.id);
                Object.assign(usuarioAtual, dadosAtualizados);
                if (typeof atualizarInterfaceUsuario === 'function') atualizarInterfaceUsuario();
            } catch (errPerfil) {
                console.warn('Aviso: Perfil não atualizou no Supabase:', errPerfil);
            }
        }

        // =====================================================================
        // Criação Transacional do Pedido Server-Side (Anti-Fraude de Total)
        // O servidor valida produtos, estoque e calcula o total matematicamente
        // =====================================================================
        let pedidoId = null;
        let totalFinal = 0;

        try {
            const { data: rpcRes, error: rpcErr } = await supabaseClient.rpc('criar_pedido', {
                p_itens: itensParaMP,
                p_data_entrega: data,
                p_pagamento: formaPagamento,
                p_endereco_entrega: end,
                p_telefone_cliente: whatsappInput,
                p_nome_cliente: nomeInput
            });

            if (rpcErr) throw rpcErr;

            if (rpcRes && rpcRes.success) {
                pedidoId = rpcRes.pedido_id;
                totalFinal = parseFloat(rpcRes.total);
            } else if (rpcRes && rpcRes.error) {
                throw new Error(rpcRes.error);
            } else {
                throw new Error('Falha inesperada ao processar pedido no servidor.');
            }
        } catch (rpcError) {
            console.warn('[Lunoca] RPC criar_pedido falhou ou pendente de migração, aplicando fallback com trigger:', rpcError);
            
            // Fallback seguro: O banco possui a trigger trigger_validar_recalcular_total_pedido que recalcula o total
            const payloadFallback = {
                cliente_id: usuarioAtual.id,
                nome_cliente: nomeInput,
                email_cliente: usuarioAtual.email,
                telefone_cliente: whatsappInput,
                data_pedido: new Date().toISOString().split('T')[0],
                data_entrega: data,
                total: total, // A trigger sobrescreverá se divergente
                pagamento: formaPagamento,
                status: 'Pendente',
                itens: nomesItens.join(' + '),
                itens_json: itensParaMP,
                endereco_entrega: end
            };

            const resInsert = await supabaseClient.from('pedidos').insert(payloadFallback).select();
            if (resInsert.error) {
                // Fallback simplificado sem colunas estendidas caso schema antigo
                delete payloadFallback.itens_json;
                delete payloadFallback.telefone_cliente;
                payloadFallback.endereco_entrega = `${end} [WhatsApp: ${whatsappInput}]`;
                const resFallback = await supabaseClient.from('pedidos').insert(payloadFallback).select();
                if (resFallback.error) throw resFallback.error;
                pedidoId = resFallback.data[0].id;
                totalFinal = parseFloat(resFallback.data[0].total);
            } else {
                pedidoId = resInsert.data[0].id;
                totalFinal = parseFloat(resInsert.data[0].total);
            }
        }

        try {
            localStorage.setItem('lunoca_ultimo_pedido_id', String(pedidoId));
        } catch (e) {}

        // ATENÇÃO: A baixa de estoque NÃO ocorre mais aqui de forma prematura.
        // O estoque só é baixado pelo servidor/webhook quando o pagamento for APROVADO.

        // Dados do pagador com WhatsApp e CPF
        const clienteDados = {
            nome: nomeInput || 'Cliente Lunoca',
            email: usuarioAtual.email || 'cliente@lunocadoceria.com.br',
            cpf: cpfInput,
            telefone: whatsappInput
        };

        // Iniciar fluxo de pagamento Mercado Pago (PIX com QR Code ou Cartão)
        if (typeof iniciarPagamentoMercadoPago === 'function') {
            await iniciarPagamentoMercadoPago(pedidoId, totalFinal, itensParaMP, formaPagamento, clienteDados);
        } else {
            alert("Pedido Criado com Sucesso! A Lunoca agradece a preferência.");
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

function obterTelefonePedido(p) {
    if (!p) return '';
    if (p.telefone_cliente) return p.telefone_cliente;
    if (p.endereco_entrega) {
        const match = p.endereco_entrega.match(/\[WhatsApp:\s*([0-9()\-\s]+)\]/i);
        if (match && match[1]) return match[1].trim();
    }
    return '';
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
            let telCliente = obterTelefonePedido(p);

            let selectStatus = '<select onchange="atualizarStatusPedido(\'' + p.id + '\', this.value)" style="font-size:12px; font-weight:bold; padding:5px 8px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer;">';
            for (let s = 0; s < STATUS_OPTIONS.length; s++) {
                let opt = STATUS_OPTIONS[s];
                selectStatus += '<option value="' + opt + '" ' + (opt === statusAtual ? 'selected' : '') + '>' + opt + '</option>';
            }
            selectStatus += '</select>';

            let tipoBadge = p.pagamento === 'pix' 
                ? '<span style="background:#e6fffa; color:#0d9488; padding:3px 8px; border-radius:10px; font-size:11px; font-weight:bold;"><i class="fa-brands fa-pix"></i> PIX</span>'
                : '<span style="background:#eff6ff; color:#2563eb; padding:3px 8px; border-radius:10px; font-size:11px; font-weight:bold;"><i class="fa-solid fa-credit-card"></i> Cartão</span>';

            let linkMPBtn = p.mercado_pago_link 
                ? `<a href="${p.mercado_pago_link}" target="_blank" rel="noopener" style="margin-left:8px; text-decoration:none;">
                    <button style="padding:4px 9px; font-size:11px; background:#009ee3; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> Mercado Pago
                    </button>
                   </a>`
                : '';

            let waBtn = `<button type="button" onclick="abrirNotificacaoWhatsAppDireta('${p.id}', '${statusAtual}')" class="btn-whatsapp-sm" style="margin-left:8px;" title="Disparar WhatsApp para o cliente">
                <i class="fa-brands fa-whatsapp"></i> Notificar Cliente
            </button>`;

            let telDisplay = telCliente 
                ? `<span style="display:inline-flex; align-items:center; gap:4px; color:#128c7e; font-weight:600; margin-left:8px; font-size:12px;">
                    <i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> ${escapeHTML(telCliente)}
                   </span>`
                : '';

            html += '<div class="admin-item-card" style="border-left: 5px solid var(--primary);">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">' +
                    '<h4 style="margin:0; color:var(--primary-dark); font-size: 15px;"><i class="fa-regular fa-calendar-check"></i> Entrega: ' + dtaStr + '</h4>' +
                    '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">' +
                        tipoBadge +
                        '<span style="font-size:12px; font-weight:bold; color:#555; margin-left:6px;">Status:</span> ' + selectStatus +
                        waBtn +
                    '</div>' +
                '</div>' +
                '<div style="margin-top: 10px; font-size:13px; color: #555;">' +
                    '<p style="margin:4px 0;"><strong>Cliente:</strong> ' + escapeHTML(p.nome_cliente) + telDisplay + '</p>' +
                    '<p style="margin:4px 0;"><strong>Contato:</strong> ' + escapeHTML(p.email_cliente) + '</p>' +
                    '<p style="margin:4px 0;"><strong>Valor:</strong> R$ ' + parseFloat(p.total).toFixed(2) + ' | <strong>Endereço:</strong> ' + escapeHTML(p.endereco_entrega || 'Balcão') + linkMPBtn + '</p>' +
                    '<p style="margin:8px 0 0 0; padding:8px; background:#f9f9f9; border-radius:8px; border:1px solid #eee;"><strong>Cesta:</strong> ' + escapeHTML(p.itens) + '</p>' +
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
        if (novoStatus === 'Confirmado') {
            const { data: { session } } = await supabaseClient.auth.getSession();
            const token = session?.access_token;
            if (!token) {
                throw new Error('Sessão expirada. Faça login novamente como administrador.');
            }

            const adminPayRes = await fetch('/api/admin/orders/payment', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ pedidoId: pedidoId, status: 'approved' })
            });

            const adminPayData = await adminPayRes.json();
            if (!adminPayRes.ok || !adminPayData.success) {
                throw new Error(adminPayData.error || 'Erro ao confirmar pagamento administrativamente.');
            }
        } else {
            const { error } = await supabaseClient.from('pedidos').update({ status: novoStatus }).eq('id', pedidoId);
            if (error) throw error;
        }
        
        let ped = pedidosGlobal.find(p => String(p.id) === String(pedidoId));
        if (ped) ped.status = novoStatus;
        if (typeof renderizarCalendario === 'function') renderizarCalendario();

        // Notificação automática via WhatsApp
        await notificarStatusPedidoWhatsApp(pedidoId, novoStatus);

    } catch (err) {
        console.error('[Atualizar Status Pedido]:', err);
        alert("Erro ao atualizar status do pedido: " + (err.message || err));
    }
}

async function notificarStatusPedidoWhatsApp(pedidoId, novoStatus) {
    try {
        let p = pedidosGlobal.find(item => String(item.id) === String(pedidoId));
        if (!p) {
            const { data } = await supabaseClient.from('pedidos').select('*').eq('id', pedidoId).single();
            p = data;
        }
        if (!p) return;

        let telefone = obterTelefonePedido(p);
        if (!telefone && p.cliente_id) {
            try {
                const { data: prof } = await supabaseClient.from('profiles').select('telefone').eq('id', p.cliente_id).single();
                if (prof && prof.telefone) telefone = prof.telefone;
            } catch (e) {}
        }

        if (!telefone) {
            alert(`Status atualizado para: ${novoStatus}. (Cliente sem WhatsApp cadastrado)`);
            return;
        }

        const cfg = typeof getWhatsAppConfig === 'function' ? getWhatsAppConfig() : { disparoAutomatico: true, provedor: 'direct' };
        if (cfg.disparoAutomatico === false) {
            alert(`Status atualizado para: ${novoStatus}. (Disparo automático desativado)`);
            return;
        }

        // Mapeia template correspondente
        let tplKey = 'confirmado';
        const st = (novoStatus || '').toLowerCase();
        if (st.includes('preparo')) tplKey = 'preparo';
        else if (st.includes('pronto')) tplKey = 'pronto';
        else if (st.includes('entregue')) tplKey = 'entregue';
        else if (st.includes('cancelado')) tplKey = 'cancelado';
        else if (st.includes('confirmado')) tplKey = 'confirmado';

        const tpls = typeof getWhatsAppTemplates === 'function' ? getWhatsAppTemplates() : (typeof TEMPLATES_PADRAO_WA !== 'undefined' ? TEMPLATES_PADRAO_WA : {});
        const template = (tpls && tpls[tplKey]) || (typeof TEMPLATES_PADRAO_WA !== 'undefined' ? TEMPLATES_PADRAO_WA[tplKey] : '');

        const dadosMsg = {
            cliente: p.nome_cliente || 'Cliente',
            pedido: String(p.id),
            status: novoStatus,
            total: p.total,
            data: p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '',
            itens: p.itens || ''
        };

        const mensagem = typeof formatarMensagemWhatsApp === 'function' 
            ? formatarMensagemWhatsApp(template, dadosMsg) 
            : `Olá ${p.nome_cliente}! O status do seu pedido #${p.id} na Lunoca Doceria mudou para: ${novoStatus}.`;
        
        const foneDigits = telefone.replace(/\D/g, '');

        if (cfg.provedor && cfg.provedor !== 'direct') {
            const session = (await window.supabaseClient?.auth?.getSession())?.data?.session;
            const token = session?.access_token || '';

            const res = await fetch('/api/whatsapp/send', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({
                    telefone: foneDigits,
                    mensagem: mensagem,
                    provedor: cfg.provedor,
                    instanciaNome: cfg.instanciaNome
                })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                alert(`✅ Status alterado para "${novoStatus}" e notificação enviada no WhatsApp do cliente!`);
            } else {
                console.warn('Aviso: Gateway WhatsApp indisponível:', data);
                alert(`ℹ️ Status alterado para "${novoStatus}". Use o botão verde do pedido para notificar via WhatsApp.`);
            }
        } else {
            alert(`ℹ️ Status alterado para "${novoStatus}". Clique no botão verde de WhatsApp do pedido para notificar o cliente!`);
        }
    } catch (err) {
        console.error('Erro ao notificar via WhatsApp:', err);
    }
}

function abrirNotificacaoWhatsAppDireta(pedidoId, statusAtual) {
    let p = pedidosGlobal.find(item => String(item.id) === String(pedidoId));
    if (!p) return alert('Pedido não encontrado.');

    let telefone = obterTelefonePedido(p);
    if (!telefone) {
        return alert('Telefone/WhatsApp do cliente não encontrado neste pedido.');
    }

    let tplKey = 'confirmado';
    const st = (statusAtual || '').toLowerCase();
    if (st.includes('preparo')) tplKey = 'preparo';
    else if (st.includes('pronto')) tplKey = 'pronto';
    else if (st.includes('entregue')) tplKey = 'entregue';
    else if (st.includes('cancelado')) tplKey = 'cancelado';
    else if (st.includes('confirmado')) tplKey = 'confirmado';

    const tpls = typeof getWhatsAppTemplates === 'function' ? getWhatsAppTemplates() : (typeof TEMPLATES_PADRAO_WA !== 'undefined' ? TEMPLATES_PADRAO_WA : {});
    const template = (tpls && tpls[tplKey]) || (typeof TEMPLATES_PADRAO_WA !== 'undefined' ? TEMPLATES_PADRAO_WA[tplKey] : '');

    const dadosMsg = {
        cliente: p.nome_cliente || 'Cliente',
        pedido: String(p.id),
        status: statusAtual,
        total: p.total,
        data: p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : '',
        itens: p.itens || ''
    };

    const mensagem = typeof formatarMensagemWhatsApp === 'function' 
        ? formatarMensagemWhatsApp(template, dadosMsg)
        : `Olá ${p.nome_cliente}! Seu pedido #${p.id} está com status: ${statusAtual}.`;

    let foneLimpo = telefone.replace(/\D/g, '');
    if (foneLimpo.length === 10 || foneLimpo.length === 11) {
        foneLimpo = '55' + foneLimpo;
    }

    const url = `https://api.whatsapp.com/send?phone=${foneLimpo}&text=${encodeURIComponent(mensagem)}`;
    window.open(url, '_blank');
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

async function carregarPedidosCliente() {
    const lista = document.getElementById('lista-pedidos-cliente');
    if (!lista) return;

    if (!usuarioAtual || !usuarioAtual.id || usuarioAtual.nivel === 'visitante') {
        lista.innerHTML = "<p style='text-align:center; color:#888;'>Faça login para ver seus pedidos.</p>";
        return;
    }

    lista.innerHTML = "<p style='text-align:center;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando seus pedidos...</p>";

    try {
        const { data: pedidos, error } = await supabaseClient
            .from('pedidos')
            .select('id,data_entrega,total,pagamento,status,itens,created_at')
            .eq('cliente_id', usuarioAtual.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!pedidos || pedidos.length === 0) {
            lista.innerHTML = "<p style='text-align:center; color:#888;'>Você ainda não fez pedidos.</p>";
            return;
        }

        let html = '';
        for (let i = 0; i < pedidos.length; i++) {
            const p = pedidos[i];
            const dataEntrega = p.data_entrega ? p.data_entrega.split('-').reverse().join('/') : 'A definir';
            const corStatus = p.status === 'Confirmado' ? '#065f46' : '#92400e';
            const bgStatus = p.status === 'Confirmado' ? '#ecfdf5' : '#fffbeb';

            html += '<div style="border:1px solid #e5e7eb; border-radius:12px; padding:12px; background:#fff;">';
            html += '<div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap;">';
            html += '<strong>Pedido #' + escapeHTML(String(p.id)) + '</strong>';
            html += '<span style="font-size:12px; background:' + bgStatus + '; color:' + corStatus + '; padding:3px 8px; border-radius:10px; font-weight:700;">' + escapeHTML(p.status || 'Pendente') + '</span>';
            html += '</div>';
            html += '<p style="margin:8px 0 4px 0; font-size:13px;"><strong>Entrega:</strong> ' + escapeHTML(dataEntrega) + '</p>';
            html += '<p style="margin:4px 0; font-size:13px;"><strong>Total:</strong> R$ ' + Number(p.total || 0).toFixed(2) + '</p>';
            html += '<p style="margin:4px 0; font-size:13px;"><strong>Pagamento:</strong> ' + escapeHTML(p.pagamento || '-') + ' · <strong>MP:</strong> ' + escapeHTML(statusPagamento) + '</p>';
            html += '<p style="margin:8px 0 0 0; font-size:12px; color:#6b7280;"><strong>Itens:</strong> ' + escapeHTML(p.itens || '') + '</p>';
            html += '</div>';
        }

        lista.innerHTML = html;
    } catch (err) {
        console.error(err);
        lista.innerHTML = "<p style='text-align:center; color:#b91c1c;'>Erro ao carregar seus pedidos.</p>";
    }
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
                        <button id="btn-reabrir-pix-${p.id}" onclick="reabrirPixPedido('${p.id}', '${p.total}')" style="width:100%; padding:10px; background:#0284c7; color:#fff; border:none; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; transition:all 0.2s; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.25);">
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

async function reabrirPixPedido(pedidoId, totalRaw) {
    console.log('[Lunoca] Solicitando abertura de Pix para o pedido:', pedidoId, 'Valor original:', totalRaw);
    const btn = document.getElementById(`btn-reabrir-pix-${pedidoId}`);
    let txtOriginal = '';
    if (btn) {
        txtOriginal = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Abrindo QR Code Pix...';
    }

    try {
        const total = parseFloat(String(totalRaw || '0').replace(',', '.')) || 0;
        const clienteDados = {
            nome: (window.usuarioAtual && window.usuarioAtual.nome) || 'Cliente Lunoca',
            email: (window.usuarioAtual && window.usuarioAtual.email) || 'cliente@lunocadoceria.com.br',
            cpf: (window.usuarioAtual && window.usuarioAtual.cpf) || '19119119100',
            telefone: (window.usuarioAtual && window.usuarioAtual.telefone) || ''
        };

        const orderData = {
            pedidoId: pedidoId,
            total: total,
            items: [],
            forma: 'pix',
            cliente: clienteDados
        };

        if (window.MercadoPagoPlugin && typeof window.MercadoPagoPlugin.iniciarCheckoutTransparente === 'function') {
            await window.MercadoPagoPlugin.iniciarCheckoutTransparente(orderData);
        } else if (typeof iniciarPagamentoMercadoPago === 'function') {
            await iniciarPagamentoMercadoPago(pedidoId, total, [], 'pix', clienteDados);
        } else {
            throw new Error('Módulo de pagamento Mercado Pago não encontrado no navegador.');
        }
    } catch (err) {
        console.error('[Lunoca] Erro ao reabrir Pix:', err);
        if (typeof mostrarToast === 'function') {
            mostrarToast('Erro ao abrir QR Code Pix: ' + (err.message || 'Tente novamente.'), 'erro');
        } else {
            alert('Erro ao abrir QR Code Pix: ' + (err.message || 'Tente novamente.'));
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = txtOriginal || '<i class="fa-brands fa-pix"></i> Pagar Agora / Ver QR Code Pix';
        }
    }
}
window.reabrirPixPedido = reabrirPixPedido;

