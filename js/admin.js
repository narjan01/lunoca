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

    if (tokenInput) tokenInput.value = cfg.accessToken || '';
    if (keyInput) keyInput.value = cfg.publicKey || '';
    if (pixInput) pixInput.value = cfg.chavePixFallback || 'lunocadoceria@gmail.com';
}

function salvarConfigMPAdmin() {
    const token = (document.getElementById('mp-access-token')?.value || '').trim();
    const key = (document.getElementById('mp-public-key')?.value || '').trim();
    const pix = (document.getElementById('mp-chave-pix')?.value || '').trim();

    if (typeof salvarMercadoPagoConfig === 'function') {
        salvarMercadoPagoConfig({
            accessToken: token,
            publicKey: key,
            chavePixFallback: pix || 'lunocadoceria@gmail.com'
        });
        alert('Configurações do Mercado Pago salvas com sucesso!');
    }
}

async function testarConexaoMP() {
    const token = (document.getElementById('mp-access-token')?.value || '').trim();
    const statusDiv = document.getElementById('mp-status-teste');
    if (!statusDiv) return;

    if (!token) {
        statusDiv.innerHTML = '<div style="padding:10px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px; border:1px solid #fecdd3;"><i class="fa-solid fa-circle-exclamation"></i> Por favor, insira o Access Token para testar a conexão.</div>';
        return;
    }

    statusDiv.innerHTML = '<div style="padding:10px; background:#f0f9ff; color:#0369a1; border-radius:8px; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> Testando credencial no Mercado Pago...</div>';

    try {
        const res = await fetch('https://api.mercadopago.com/users/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();

        if (res.ok && data.id) {
            statusDiv.innerHTML = '<div style="padding:12px; background:#ecfdf5; color:#065f46; border-radius:8px; font-size:12px; border:1px solid #a7f3d0;"><i class="fa-solid fa-circle-check"></i> <strong>Conexão Aprovada!</strong><br>Conta: <strong>' + escapeHTML(data.nickname || data.first_name || 'Vendedor Mercado Pago') + '</strong> (ID: ' + data.id + ')<br>Status: Ativo e pronto para receber PIX e Cartão.</div>';
        } else {
            statusDiv.innerHTML = '<div style="padding:12px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px; border:1px solid #fecdd3;"><i class="fa-solid fa-circle-xmark"></i> <strong>Falha na autenticação:</strong> ' + escapeHTML(data.message || 'Access Token inválido ou expirado.') + '</div>';
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
