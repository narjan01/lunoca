// C:\Users\narjan.andrade\.gemini\antigravity\scratch\lunoca\js\admin.js

var clickExcluir = null;

function mudarTabAdmin(tab) {
    document.querySelectorAll('.admin-nav button').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-tab').forEach(function(t) { t.classList.remove('active'); });
    
    document.getElementById('tab-btn-' + tab).classList.add('active');
    document.getElementById('admin-tab-' + tab).classList.add('active');
    
    if(tab === 'calendario') renderizarCalendario();
    if(tab === 'usuarios') carregarUsuariosAdmin();
    if(tab === 'pagamentos') carregarConfigMercadoPagoAdmin();
    if(tab === 'whatsapp') carregarConfigWhatsAppAdmin();
    if(tab === 'estoque' && typeof carregarEstoqueAdmin === 'function') carregarEstoqueAdmin();
    if(tab === 'financeiro' && typeof carregarFinanceiroAdmin === 'function') carregarFinanceiroAdmin();
}

async function carregarUsuariosAdmin() {
    document.getElementById('lista-usuarios-admin').innerHTML = "<p style='text-align:center;'><i class='fa-solid fa-spinner fa-spin'></i> Carregando...</p>";
    
    try {
        const { data: users, error } = await supabaseClient.from('profiles').select('*').order('created_at');
        if (error) throw error;
        
        let html = '';
        for(let i = 0; i < users.length; i++){
            let u = users[i];
            let nomeLimpo = escapeHTML(u.nome || 'Sem Nome'); let emailLimpo = escapeHTML(u.email || ''); let statusInativo = u.ativo === false ? ' <span style="color:#e74c3c; font-size:11px;">(Desativado)</span>' : ''; html += '<div class="user-list-item"><div><strong style="color:var(--text-dark);">' + nomeLimpo + '</strong> ' + (u.nivel === 'admin' ? '<i class="fa-solid fa-crown" style="color:gold;" title="Admin"></i>' : '') + statusInativo + '<br><span style="font-size:13px; color:#666;">' + emailLimpo + '</span></div>';
            
            if (u.id === usuarioAtual.id) {
                html += '<span style="font-size:12px; font-weight:bold; color:var(--primary); background:#f0e6ff; padding:4px 8px; border-radius:12px;">VOCÊ</span>';
            } else {
                html += '<div style="display:flex; gap:5px;"><button class="btn-outline" onclick="prepararEdicaoUsuario(\'' + u.id + '\', \'' + (u.nome || '') + '\', \'' + u.nivel + '\')" style="padding:6px 10px; font-size:12px;"><i class="fa-solid fa-pen"></i></button>';
                html += '<button class="btn-danger" onclick="excluirUser(\'' + u.id + '\')" style="padding:6px 10px; font-size:12px;"><i class="fa-solid fa-trash"></i></button></div>';
            }
            html += '</div>';
        }
        document.getElementById('lista-usuarios-admin').innerHTML = html || "Nenhum usuário encontrado.";
        
    } catch (err) {
        console.error(err);
        document.getElementById('lista-usuarios-admin').innerHTML = "Erro ao carregar usuários.";
    }
}

function prepararEdicaoUsuario(id, nome, nivel) {
    document.getElementById('form-user-admin').style.display = 'flex';
    document.getElementById('admin-user-id').value = id;
    document.getElementById('admin-user-nome').value = nome;
    document.getElementById('admin-user-nivel').value = nivel || 'cliente';
    document.getElementById('form-user-admin').scrollIntoView({ behavior: 'smooth' });
}

function fecharFormUsuario() {
    document.getElementById('form-user-admin').style.display = 'none';
}

async function salvarFormUsuario() {
    let id = document.getElementById('admin-user-id').value;
    let nome = document.getElementById('admin-user-nome').value;
    let nivel = document.getElementById('admin-user-nivel').value;
    
    try {
        const { error } = await supabaseClient.from('profiles').update({ nome, nivel }).eq('id', id);
        if (error) throw error;
        
        alert("Usuário atualizado com sucesso!");
        fecharFormUsuario();
        carregarUsuariosAdmin();
    } catch (err) {
        console.error(err);
        alert("Erro ao atualizar usuário.");
    }
}

async function excluirUser(id) {
    if (clickExcluir === id) {
        try {
            // Desativa o usuário em vez de excluir fisicamente para não quebrar integridade
            const { error } = await supabaseClient.from('profiles').update({ ativo: false }).eq('id', id);
            if (error) throw error;
            
            alert("Usuário desativado com sucesso!");
            clickExcluir = null;
            carregarUsuariosAdmin();
        } catch (err) {
            console.error(err);
            alert("Erro ao desativar usuário.");
        }
    } else {
        clickExcluir = id;
        alert("Clique novamente na lixeira para confirmar a desativação deste usuário.");
        setTimeout(() => { clickExcluir = null; }, 3000);
    }
}
// ==========================================================================
// Configurações do Mercado Pago no Painel Admin
// ==========================================================================
function carregarConfigMercadoPagoAdmin() {
    const cfg = typeof getMercadoPagoConfig === 'function' ? getMercadoPagoConfig() : {};
    const tokenInput = document.getElementById('mp-access-token');
    const keyInput = document.getElementById('mp-public-key');
    const pixInput = document.getElementById('mp-chave-pix');

    if (tokenInput) {
        tokenInput.value = '••••••••••••••••••••';
        tokenInput.setAttribute('disabled', 'disabled');
        tokenInput.setAttribute('title', 'Access Token protegido no servidor (Cloudflare env).');
    }
    if (keyInput) keyInput.value = cfg.publicKey || '';
    if (pixInput) pixInput.value = cfg.chavePixFallback || 'lunocadoceria@gmail.com';
}

function salvarConfigMPAdmin() {
    const key = (document.getElementById('mp-public-key')?.value || '').trim();
    const pix = (document.getElementById('mp-chave-pix')?.value || '').trim();

    if (typeof salvarMercadoPagoConfig === 'function') {
        salvarMercadoPagoConfig({
            publicKey: key,
            chavePixFallback: pix || 'lunocadoceria@gmail.com'
        });
        alert('Configurações salvas. Access Token fica protegido apenas no servidor.');
    }
}

async function testarConexaoMP() {
    const statusDiv = document.getElementById('mp-status-teste');
    if (!statusDiv) return;

    statusDiv.innerHTML = '<div style="padding:10px; background:#f0f9ff; color:#0369a1; border-radius:8px; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> Testando credencial do servidor no Mercado Pago...</div>';

    try {
        const res = await fetch('/api/mercadopago/test-connection');
        const data = await res.json();

        if (res.ok && data.success && data.account?.id) {
            statusDiv.innerHTML = '<div style="padding:12px; background:#ecfdf5; color:#065f46; border-radius:8px; font-size:12px; border:1px solid #a7f3d0;"><i class="fa-solid fa-circle-check"></i> <strong>Conexão Aprovada!</strong><br>Conta: <strong>' + escapeHTML(data.account.nickname || 'Vendedor Mercado Pago') + '</strong> (ID: ' + data.account.id + ')<br>Status: Token seguro no servidor e pronto para receber pagamentos.</div>';
        } else {
            statusDiv.innerHTML = '<div style="padding:12px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px; border:1px solid #fecdd3;"><i class="fa-solid fa-circle-xmark"></i> <strong>Falha na autenticação:</strong> ' + escapeHTML(data.error || 'Não foi possível validar o token do servidor.') + '</div>';
        }
    } catch (err) {
        statusDiv.innerHTML = '<div style="padding:10px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px;"><i class="fa-solid fa-triangle-exclamation"></i> Erro de rede ao testar: ' + escapeHTML(err.message) + '</div>';
    }
}

function toggleVisibilidadeTokenMP() {
    const input = document.getElementById('mp-access-token');
    const icon = document.getElementById('icon-eye-mp');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        if (icon) {
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        }
    } else {
        input.type = 'password';
        if (icon) {
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }
}

// ==========================================================================
// Conector WhatsApp Oficial da Loja & Notificações de Status
// ==========================================================================

const WHATSAPP_STORAGE_KEY = 'lunoca_whatsapp_config';
const WHATSAPP_TEMPLATES_KEY = 'lunoca_whatsapp_templates';

const TEMPLATES_PADRAO_WA = {
    confirmado: "🧁 *Lunoca Doceria* - Olá {cliente}!\n\nSeu pedido *#{pedido}* foi *CONFIRMADO* com sucesso!\n📦 *Itens:* {itens}\n💰 *Total:* R$ {total}\n📅 *Data Agendada:* {data}\n\nJá estamos organizando tudo para adoçar o seu dia! Qualquer dúvida estamos à disposição. ❤️",
    preparo: "👩‍🍳 *Lunoca Doceria* - Olá {cliente}!\n\nSeu pedido *#{pedido}* já está *EM PREPARO* em nossa cozinha artesanal!\nNossas confeiteiras estão cuidando de cada detalhe com muito amor. Em breve avisaremos quando estiver pronto!",
    pronto: "🎁 *Lunoca Doceria* - Olá {cliente}!\n\nSeu pedido *#{pedido}* está *PRONTO*!\nSe você optou por retirada no balcão, já pode vir nos visitar. Se escolheu entrega em domicílio, seu pedido logo sairá com nosso entregador!\n\nTe esperamos com muita doçura! 🍰",
    entregue: "🎉 *Lunoca Doceria* - Olá {cliente}!\n\nSeu pedido *#{pedido}* foi *ENTREGUE*!\nEsperamos que você ame cada mordida! Fique à vontade para nos marcar no Instagram @lunocadoceria.\n\nMuito obrigado pelo carinho e preferência! ❤️🧁",
    cancelado: "Olá {cliente}! Informamos que seu pedido *#{pedido}* na Lunoca Doceria foi alterado para *CANCELADO*. Caso tenha qualquer dúvida, estamos à disposição por este número."
};

function getWhatsAppConfig() {
    try {
        const raw = localStorage.getItem(WHATSAPP_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
        provedor: 'direct', // 'direct', 'evolution', 'z-api', 'webhook'
        instanciaUrl: '',
        instanciaNome: '',
        apiKey: '',
        numeroLoja: '',
        disparoAutomatico: true
    };
}

function getWhatsAppTemplates() {
    try {
        const raw = localStorage.getItem(WHATSAPP_TEMPLATES_KEY);
        if (raw) return { ...TEMPLATES_PADRAO_WA, ...JSON.parse(raw) };
    } catch (e) {}
    return { ...TEMPLATES_PADRAO_WA };
}

function alternarCamposProvedorWA() {
    const prov = document.getElementById('wa-provedor')?.value || 'direct';
    const camposDiv = document.getElementById('wa-campos-api');
    const rowEvo = document.getElementById('wa-row-evolution-extra');
    const lblUrl = document.getElementById('lbl-wa-url');
    const helpUrl = document.getElementById('help-wa-url');
    const dot = document.getElementById('whatsapp-dot-indicador');
    const txtStatus = document.getElementById('whatsapp-status-texto');

    if (camposDiv) {
        if (prov === 'direct') {
            camposDiv.style.display = 'none';
            if (dot) { dot.className = 'whatsapp-pulse-dot direct'; }
            if (txtStatus) txtStatus.textContent = 'Modo Direto 1-Clique Ativo (Sem Custos)';
        } else {
            camposDiv.style.display = 'block';
            if (dot) { dot.className = 'whatsapp-pulse-dot online'; }
            if (txtStatus) txtStatus.textContent = `Conector ${prov.toUpperCase()} Configurado`;
        }
    }

    if (prov === 'evolution') {
        if (rowEvo) rowEvo.style.display = 'flex';
        if (lblUrl) lblUrl.textContent = 'URL Base da Evolution API';
        if (helpUrl) helpUrl.textContent = 'Ex: https://api.meuzap.com (sem a rota final)';
    } else if (prov === 'z-api') {
        if (rowEvo) rowEvo.style.display = 'none';
        if (lblUrl) lblUrl.textContent = 'URL Completa do Endpoint Z-API';
        if (helpUrl) helpUrl.textContent = 'Ex: https://api.z-api.io/instances/SUA_INSTANCIA/token/SEU_TOKEN';
    } else if (prov === 'webhook') {
        if (rowEvo) rowEvo.style.display = 'none';
        if (lblUrl) lblUrl.textContent = 'URL do Webhook (n8n, Make ou Servidor)';
        if (helpUrl) helpUrl.textContent = 'Endpoint HTTP POST que receberá o payload da mensagem.';
    }
}

function carregarConfigWhatsAppAdmin() {
    const cfg = getWhatsAppConfig();
    const tpls = getWhatsAppTemplates();

    const provEl = document.getElementById('wa-provedor');
    const urlEl = document.getElementById('wa-instancia-url');
    const nomeEl = document.getElementById('wa-instancia-nome');
    const keyEl = document.getElementById('wa-api-key');
    const numEl = document.getElementById('wa-numero-loja');
    const autoEl = document.getElementById('wa-disparo-automatico');

    if (provEl) provEl.value = cfg.provedor || 'direct';
    if (urlEl) urlEl.value = cfg.instanciaUrl || '';
    if (nomeEl) nomeEl.value = cfg.instanciaNome || '';
    if (keyEl) keyEl.value = cfg.apiKey || '';
    if (numEl) numEl.value = cfg.numeroLoja || '';
    if (autoEl) autoEl.checked = cfg.disparoAutomatico !== false;

    // Preenche templates
    const tplConf = document.getElementById('wa-tpl-confirmado');
    const tplPrep = document.getElementById('wa-tpl-preparo');
    const tplPron = document.getElementById('wa-tpl-pronto');
    const tplEntr = document.getElementById('wa-tpl-entregue');
    const tplCanc = document.getElementById('wa-tpl-cancelado');

    if (tplConf) tplConf.value = tpls.confirmado || TEMPLATES_PADRAO_WA.confirmado;
    if (tplPrep) tplPrep.value = tpls.preparo || TEMPLATES_PADRAO_WA.preparo;
    if (tplPron) tplPron.value = tpls.pronto || TEMPLATES_PADRAO_WA.pronto;
    if (tplEntr) tplEntr.value = tpls.entregue || TEMPLATES_PADRAO_WA.entregue;
    if (tplCanc) tplCanc.value = tpls.cancelado || TEMPLATES_PADRAO_WA.cancelado;

    alternarCamposProvedorWA();
}

function salvarConfigWhatsAppAdmin() {
    const prov = document.getElementById('wa-provedor')?.value || 'direct';
    const url = (document.getElementById('wa-instancia-url')?.value || '').trim();
    const nome = (document.getElementById('wa-instancia-nome')?.value || '').trim();
    const key = (document.getElementById('wa-api-key')?.value || '').trim();
    const num = (document.getElementById('wa-numero-loja')?.value || '').trim();
    const auto = document.getElementById('wa-disparo-automatico')?.checked !== false;

    const novaCfg = {
        provedor: prov,
        instanciaUrl: url,
        instanciaNome: nome,
        apiKey: key,
        numeroLoja: num,
        disparoAutomatico: auto
    };

    try {
        localStorage.setItem(WHATSAPP_STORAGE_KEY, JSON.stringify(novaCfg));
        alert('Configurações do WhatsApp salvas com sucesso!');
        alternarCamposProvedorWA();
    } catch (e) {
        alert('Erro ao salvar configurações do WhatsApp: ' + e.message);
    }
}

function salvarTemplatesWhatsAppAdmin() {
    const tpls = {
        confirmado: document.getElementById('wa-tpl-confirmado')?.value || TEMPLATES_PADRAO_WA.confirmado,
        preparo: document.getElementById('wa-tpl-preparo')?.value || TEMPLATES_PADRAO_WA.preparo,
        pronto: document.getElementById('wa-tpl-pronto')?.value || TEMPLATES_PADRAO_WA.pronto,
        entregue: document.getElementById('wa-tpl-entregue')?.value || TEMPLATES_PADRAO_WA.entregue,
        cancelado: document.getElementById('wa-tpl-cancelado')?.value || TEMPLATES_PADRAO_WA.cancelado
    };

    try {
        localStorage.setItem(WHATSAPP_TEMPLATES_KEY, JSON.stringify(tpls));
        alert('Modelos de mensagem do WhatsApp atualizados com sucesso!');
    } catch (e) {
        alert('Erro ao salvar modelos: ' + e.message);
    }
}

function restaurarTemplatesWhatsAppPadrao() {
    if (confirm('Deseja restaurar todos os modelos de mensagem para os padrões da Lunoca Doceria?')) {
        try {
            localStorage.setItem(WHATSAPP_TEMPLATES_KEY, JSON.stringify(TEMPLATES_PADRAO_WA));
            carregarConfigWhatsAppAdmin();
            alert('Modelos padrão restaurados!');
        } catch (e) {}
    }
}

async function testarConexaoWhatsApp() {
    const statusDiv = document.getElementById('wa-status-teste');
    if (!statusDiv) return;

    const cfg = getWhatsAppConfig();
    const foneLoja = (document.getElementById('wa-numero-loja')?.value || cfg.numeroLoja || '').replace(/\D/g, '');

    if (!foneLoja) {
        return alert('Por favor, informe o WhatsApp da Loja no campo acima para receber o teste!');
    }

    statusDiv.innerHTML = '<div style="padding:10px; background:#f0fdf4; color:#166534; border-radius:8px; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> Disparando mensagem de teste para ' + foneLoja + '...</div>';

    try {
        const msgTeste = "🍰 *Lunoca Doceria* - Teste de Conexão WhatsApp realizado com sucesso! Sua loja está pronta para notificar clientes automaticamente.";
        
        if (cfg.provedor === 'direct' || !cfg.instanciaUrl) {
            statusDiv.innerHTML = `<div style="padding:12px; background:#fffbeb; color:#92400e; border-radius:8px; font-size:12px; border:1px solid #fde68a;">
                <i class="fa-solid fa-circle-info"></i> <strong>Modo Direto 1-Clique Ativo:</strong> Sem gateway externo configurado.<br>
                <a href="https://api.whatsapp.com/send?phone=55${foneLoja}&text=${encodeURIComponent(msgTeste)}" target="_blank" class="btn-whatsapp-sm" style="margin-top:8px;">
                    <i class="fa-brands fa-whatsapp"></i> Testar no WhatsApp Web / App
                </a>
            </div>`;
            return;
        }

        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telefone: foneLoja,
                mensagem: msgTeste,
                provedor: cfg.provedor,
                instanciaUrl: cfg.instanciaUrl,
                apiKey: cfg.apiKey,
                instanciaNome: cfg.instanciaNome
            })
        });

        const data = await res.json();
        if (res.ok && data.success) {
            statusDiv.innerHTML = '<div style="padding:12px; background:#ecfdf5; color:#065f46; border-radius:8px; font-size:12px; border:1px solid #a7f3d0;"><i class="fa-solid fa-circle-check"></i> <strong>Mensagem enviada com sucesso!</strong> Verifique seu WhatsApp (' + foneLoja + ').</div>';
        } else {
            statusDiv.innerHTML = '<div style="padding:12px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px; border:1px solid #fecdd3;"><i class="fa-solid fa-circle-xmark"></i> <strong>Falha no envio:</strong> ' + escapeHTML(data.error || 'Erro no gateway WhatsApp.') + '</div>';
        }
    } catch (err) {
        statusDiv.innerHTML = '<div style="padding:10px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px;"><i class="fa-solid fa-triangle-exclamation"></i> Erro de rede ao testar: ' + escapeHTML(err.message) + '</div>';
    }
}

function formatarMensagemWhatsApp(template, dados) {
    if (!template) return '';
    let msg = template;
    msg = msg.replace(/{cliente}/g, dados.cliente || 'Cliente');
    msg = msg.replace(/{pedido}/g, dados.pedido || '');
    msg = msg.replace(/{status}/g, dados.status || '');
    msg = msg.replace(/{total}/g, Number(dados.total || 0).toFixed(2));
    msg = msg.replace(/{data}/g, dados.data || 'A combinar');
    msg = msg.replace(/{itens}/g, dados.itens || '');
    msg = msg.replace(/{loja}/g, 'Lunoca Doceria');
    return msg;
}
