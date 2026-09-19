// C:\Users\narjan.andrade\.gemini\antigravity\scratch\lunoca\js\admin.js

var clickExcluir = null;

function mudarTabAdmin(tab) {
    document.querySelectorAll('.admin-nav button').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-tab').forEach(function(t) { t.classList.remove('active'); });
    
    document.getElementById('tab-btn-' + tab).classList.add('active');
    document.getElementById('admin-tab-' + tab).classList.add('active');
    
    if(tab === 'calendario') renderizarCalendario();
    if(tab === 'usuarios') carregarUsuariosAdmin();
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