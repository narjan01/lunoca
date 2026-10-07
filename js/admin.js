// C:\Users\narjan.andrade\.gemini\antigravity\scratch\lunoca\js\admin.js

var clickExcluir = null;
var listaUsuariosAdminCache = [];
var filtroUsuariosAdminAtual = 'todos';
var termoBuscaUsuariosAdmin = '';

// ==========================================================================
// Controle de Permissões e Abas por Nível de Acesso (Admin vs Operador)
// ==========================================================================
function configurarAcessoAdminPorNivel() {
    const isOperador = usuarioAtual && usuarioAtual.nivel === 'operador';
    const isAdm = usuarioAtual && usuarioAtual.nivel === 'admin';

    // Abas restritas a administradores
    const abasRestritas = [
        'tab-btn-pedidos',
        'tab-btn-calendario',
        'tab-btn-financeiro',
        'tab-btn-usuarios',
        'tab-btn-pagamentos',
        'tab-btn-whatsapp'
    ];

    const tituloAdmin = document.querySelector('#admin-section h2');

    if (isOperador) {
        // Oculta abas confidenciais
        abasRestritas.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = 'none';
        });

        // Garante exibição de Produtos, Estoque e Ficha Técnica
        const btnProd = document.getElementById('tab-btn-produtos');
        const btnEstoque = document.getElementById('tab-btn-estoque');
        const btnFicha = document.getElementById('tab-btn-fichatecnica');
        if (btnProd) btnProd.style.display = 'inline-flex';
        if (btnEstoque) btnEstoque.style.display = 'inline-flex';
        if (btnFicha) btnFicha.style.display = 'inline-flex';

        if (tituloAdmin) {
            tituloAdmin.innerHTML = '<i class="fa-solid fa-boxes-packing" style="color:var(--primary)"></i> Painel do Operador <span style="font-size:12px; background:#e0f2fe; color:#0369a1; padding:3px 10px; border-radius:12px; font-weight:700; margin-left:6px;">Produtos</span>';
        }

        // Abre direto a aba de produtos
        mudarTabAdmin('produtos');
    } else {
        // Administrador tem acesso a todas as abas
        abasRestritas.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = 'inline-flex';
        });

        const btnProd = document.getElementById('tab-btn-produtos');
        const btnEstoque = document.getElementById('tab-btn-estoque');
        const btnFicha = document.getElementById('tab-btn-fichatecnica');
        if (btnProd) btnProd.style.display = 'inline-flex';
        if (btnEstoque) btnEstoque.style.display = 'inline-flex';
        if (btnFicha) btnFicha.style.display = 'inline-flex';

        if (tituloAdmin) {
            tituloAdmin.innerHTML = '<i class="fa-solid fa-screwdriver-wrench" style="color:var(--primary)"></i> Painel de Controle <span style="font-size:12px; background:#fef3c7; color:#b45309; padding:3px 10px; border-radius:12px; font-weight:700; margin-left:6px;">Admin</span>';
        }
    }
}

function mudarTabAdmin(tab) {
    // Bloqueio de segurança no frontend para Operadores
    if (usuarioAtual && usuarioAtual.nivel === 'operador' && tab !== 'produtos' && tab !== 'estoque' && tab !== 'fichatecnica') {
        mostrarToast('Acesso restrito ao Administrador.', 'aviso', 3000);
        return;
    }

    document.querySelectorAll('.admin-nav button').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-tab').forEach(function(t) { t.classList.remove('active'); });
    
    const targetBtn = document.getElementById('tab-btn-' + tab);
    const targetTab = document.getElementById('admin-tab-' + tab);
    if (targetBtn) targetBtn.classList.add('active');
    if (targetTab) targetTab.classList.add('active');
    
    if(tab === 'pedidos') carregarPedidosAdmin();
    if(tab === 'calendario') renderizarCalendario();
    if(tab === 'produtos' && typeof renderizarProdutosAdmin === 'function') renderizarProdutosAdmin();
    if(tab === 'usuarios') carregarUsuariosAdmin();
    if(tab === 'pagamentos') carregarConfigMercadoPagoAdmin();
    if(tab === 'whatsapp') carregarConfigWhatsAppAdmin();
    if(tab === 'estoque' && typeof carregarEstoqueAdmin === 'function') carregarEstoqueAdmin();
    if(tab === 'fichatecnica' && typeof carregarFichaTecnicaAdmin === 'function') carregarFichaTecnicaAdmin();
    if(tab === 'financeiro' && typeof carregarFinanceiroAdmin === 'function') carregarFinanceiroAdmin();
}

// ==========================================================================
// Gestão de Usuários & Níveis de Acesso (Cliente, Operador, Admin)
// ==========================================================================
async function carregarUsuariosAdmin() {
    const listaEl = document.getElementById('lista-usuarios-admin');
    if (!listaEl) return;

    listaEl.innerHTML = `
      <div style="text-align:center; padding:30px; color:#888;">
        <i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--primary); margin-bottom:10px; display:block;"></i>
        Carregando lista de contas...
      </div>
    `;
    
    try {
        const { data: users, error } = await supabaseClient
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        
        listaUsuariosAdminCache = users || [];
        atualizarMetricasUsuarios(listaUsuariosAdminCache);
        renderizarUsuariosAdminNaTela();
        
    } catch (err) {
        console.error('Erro ao carregar usuários:', err);
        listaEl.innerHTML = `
          <div style="text-align:center; padding:30px; color:#e11d48;">
            <i class="fa-solid fa-triangle-exclamation fa-2x" style="margin-bottom:8px; display:block;"></i>
            Erro ao carregar lista de usuários. Verifique sua conexão ou privilégios de Admin.
          </div>
        `;
    }
}

function atualizarMetricasUsuarios(users) {
    const totalEl = document.getElementById('metric-users-total');
    const opEl = document.getElementById('metric-users-operadores');
    const admEl = document.getElementById('metric-users-admins');
    const cliEl = document.getElementById('metric-users-clientes');

    const total = users.length;
    const operadores = users.filter(u => u.nivel === 'operador').length;
    const admins = users.filter(u => u.nivel === 'admin').length;
    const clientes = users.filter(u => u.nivel === 'cliente' || !u.nivel).length;

    if (totalEl) totalEl.innerText = total;
    if (opEl) opEl.innerText = operadores;
    if (admEl) admEl.innerText = admins;
    if (cliEl) cliEl.innerText = clientes;
}

function selecionarFiltroUsuariosAdmin(filtro, btn) {
    filtroUsuariosAdminAtual = filtro;
    document.querySelectorAll('#admin-user-filter-chips .category-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderizarUsuariosAdminNaTela();
}

function filtrarUsuariosAdminNaTela() {
    const input = document.getElementById('admin-user-search-input');
    const btnClear = document.getElementById('admin-user-search-clear');
    termoBuscaUsuariosAdmin = (input?.value || '').trim().toLowerCase();

    if (btnClear) {
        btnClear.style.display = termoBuscaUsuariosAdmin.length > 0 ? 'block' : 'none';
    }

    renderizarUsuariosAdminNaTela();
}

function limparBuscaUsuariosAdmin() {
    const input = document.getElementById('admin-user-search-input');
    const btnClear = document.getElementById('admin-user-search-clear');
    if (input) input.value = '';
    if (btnClear) btnClear.style.display = 'none';
    termoBuscaUsuariosAdmin = '';
    renderizarUsuariosAdminNaTela();
}

function renderizarUsuariosAdminNaTela() {
    const listaEl = document.getElementById('lista-usuarios-admin');
    if (!listaEl) return;

    const filtrados = listaUsuariosAdminCache.filter(u => {
        // Filtro por Nível ou Status
        if (filtroUsuariosAdminAtual === 'inativo') {
            if (u.ativo !== false) return false;
        } else if (filtroUsuariosAdminAtual !== 'todos') {
            const nivelU = u.nivel || 'cliente';
            if (nivelU !== filtroUsuariosAdminAtual) return false;
        }

        // Filtro por Busca de Texto
        if (termoBuscaUsuariosAdmin) {
            const termo = termoBuscaUsuariosAdmin;
            const nome = (u.nome || '').toLowerCase();
            const email = (u.email || '').toLowerCase();
            const cpf = (u.cpf || '').replace(/\D/g, '');
            const tel = (u.telefone || '').replace(/\D/g, '');

            if (!nome.includes(termo) && !email.includes(termo) && !cpf.includes(termo) && !tel.includes(termo)) {
                return false;
            }
        }

        return true;
    });

    if (filtrados.length === 0) {
        listaEl.innerHTML = `
          <div style="text-align:center; padding:35px 15px; color:#887a77; background:#ffffff; border-radius:18px; border:1px dashed #ebdcf7;">
            <i class="fa-solid fa-user-xmark" style="font-size:32px; color:var(--primary); margin-bottom:10px; display:block; opacity:0.6;"></i>
            <h4 style="margin:0 0 4px; color:var(--text-dark);">Nenhum usuário encontrado</h4>
            <p style="margin:0; font-size:12.5px;">Tente ajustar os filtros ou o termo de pesquisa.</p>
          </div>
        `;
        return;
    }

    let html = '';
    for (let i = 0; i < filtrados.length; i++) {
        const u = filtrados[i];
        const nomeLimpo = escapeHTML(u.nome || 'Sem Nome');
        const emailLimpo = escapeHTML(u.email || 'Sem e-mail');
        const nivel = u.nivel || 'cliente';
        const isSelf = usuarioAtual && u.id === usuarioAtual.id;
        const isAtivo = u.ativo !== false;

        // Iniciais para o avatar
        const iniciais = (u.nome ? u.nome.split(' ').map(n => n[0]).slice(0, 2).join('') : 'U').toUpperCase();

        // Configurações do Badge por Nível
        let badgeHtml = '';
        let avatarClass = 'cliente';
        if (nivel === 'admin') {
            badgeHtml = '<span class="badge-nivel admin"><i class="fa-solid fa-crown" style="color:#d97706;"></i> Administrador</span>';
            avatarClass = 'admin';
        } else if (nivel === 'operador') {
            badgeHtml = '<span class="badge-nivel operador"><i class="fa-solid fa-user-gear"></i> Operador (Produtos)</span>';
            avatarClass = 'operador';
        } else {
            badgeHtml = '<span class="badge-nivel cliente"><i class="fa-solid fa-user"></i> Cliente</span>';
            avatarClass = 'cliente';
        }

        // WhatsApp Link
        const telLimpo = (u.telefone || '').replace(/\D/g, '');
        const telFmt = u.telefone ? escapeHTML(u.telefone) : 'Não informado';
        const whatsLink = telLimpo.length >= 10 
            ? `<a href="https://wa.me/55${telLimpo}" target="_blank" style="color:#16a34a; font-weight:600; text-decoration:none;"><i class="fa-brands fa-whatsapp"></i> ${telFmt}</a>`
            : `<span><i class="fa-solid fa-phone"></i> ${telFmt}</span>`;

        // CPF
        const cpfFmt = u.cpf ? escapeHTML(u.cpf) : 'Não informado';

        // Endereço
        let endCompleto = 'Não cadastrado';
        if (u.endereco) {
            endCompleto = `${escapeHTML(u.endereco)}${u.numero ? ', ' + escapeHTML(u.numero) : ''}${u.complemento ? ' (' + escapeHTML(u.complemento) + ')' : ''}${u.cep ? ' - CEP: ' + escapeHTML(u.cep) : ''}`;
        }

        // Data de cadastro
        const dataCadastro = u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR') : '--';

        html += `
          <div class="user-card-admin" style="${!isAtivo ? 'opacity: 0.7; background: #fafafa;' : ''}">
            <div class="user-card-header">
              <div class="user-card-avatar-wrap">
                <div class="user-card-avatar ${avatarClass}">${iniciais}</div>
                <div>
                  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <strong style="font-size:15px; color:var(--text-dark);">${nomeLimpo}</strong>
                    ${isSelf ? '<span style="font-size:10.5px; font-weight:800; color:var(--primary-dark); background:#f7effe; padding:2px 8px; border-radius:10px;">VOCÊ</span>' : ''}
                    ${!isAtivo ? '<span style="font-size:10.5px; font-weight:800; color:#b91c1c; background:#fee2e2; padding:2px 8px; border-radius:10px;">DESATIVADO</span>' : ''}
                  </div>
                  <div style="font-size:12.5px; color:#64748b; margin-top:2px;">
                    <i class="fa-regular fa-envelope" style="font-size:11px;"></i> ${emailLimpo}
                  </div>
                </div>
              </div>
              <div>${badgeHtml}</div>
            </div>

            <div class="user-card-info-grid">
              <div class="user-card-info-item" title="WhatsApp">${whatsLink}</div>
              <div class="user-card-info-item" title="CPF"><i class="fa-solid fa-id-card"></i> CPF: ${cpfFmt}</div>
              <div class="user-card-info-item" title="Endereço" style="grid-column: 1 / -1;"><i class="fa-solid fa-location-dot"></i> ${endCompleto}</div>
              <div class="user-card-info-item" title="Cadastrado em"><i class="fa-regular fa-calendar"></i> Cadastrado em: ${dataCadastro}</div>
            </div>

            <div class="user-card-actions">
              <button type="button" class="btn-outline" onclick="prepararEdicaoUsuarioById('${u.id}')" style="padding:6px 12px; font-size:12px; border-radius:8px;">
                <i class="fa-solid fa-user-pen"></i> Editar Informações & Nível
              </button>
              ${!isSelf ? `
                <button type="button" class="${isAtivo ? 'btn-danger' : 'btn-outline'}" onclick="alternarStatusUsuario('${u.id}', ${isAtivo})" style="padding:6px 12px; font-size:12px; border-radius:8px;">
                  <i class="fa-solid ${isAtivo ? 'fa-user-slash' : 'fa-user-check'}"></i> ${isAtivo ? 'Desativar' : 'Reativar'}
                </button>
              ` : ''}
            </div>
          </div>
        `;
    }

    listaEl.innerHTML = html;
}

function prepararEdicaoUsuarioById(id) {
    const user = listaUsuariosAdminCache.find(u => u.id === id);
    if (!user) return;

    const form = document.getElementById('form-user-admin');
    if (!form) return;

    form.style.display = 'flex';
    document.getElementById('admin-user-id').value = user.id;
    document.getElementById('admin-user-nome').value = user.nome || '';
    document.getElementById('admin-user-email').value = user.email || '';
    document.getElementById('admin-user-nivel').value = user.nivel || 'cliente';
    document.getElementById('admin-user-telefone').value = user.telefone || '';
    document.getElementById('admin-user-cpf').value = user.cpf || '';
    document.getElementById('admin-user-cep').value = user.cep || '';
    document.getElementById('admin-user-endereco').value = user.endereco || '';
    document.getElementById('admin-user-numero').value = user.numero || '';
    document.getElementById('admin-user-complemento').value = user.complemento || '';
    document.getElementById('admin-user-ativo').checked = user.ativo !== false;
    const senhaInput = document.getElementById('admin-user-nova-senha');
    if (senhaInput) senhaInput.value = '';

    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fecharFormUsuario() {
    const form = document.getElementById('form-user-admin');
    if (form) form.style.display = 'none';
}

function buscarCepAdminUsuario() {
    const cepInput = document.getElementById('admin-user-cep');
    if (!cepInput) return;
    const cep = cepInput.value.replace(/\D/g, '');
    if (cep.length === 8) {
        const ruaInput = document.getElementById('admin-user-endereco');
        if (ruaInput) ruaInput.placeholder = "Buscando logradouro...";
        fetch(`https://viacep.com.br/ws/${cep}/json/`)
            .then(res => res.json())
            .then(data => {
                if (!data.erro) {
                    if (ruaInput) ruaInput.value = `${data.logradouro}, ${data.bairro} - ${data.localidade}/${data.uf}`;
                    const numInput = document.getElementById('admin-user-numero');
                    if (numInput) numInput.focus();
                } else {
                    mostrarToast('CEP não encontrado.', 'aviso');
                }
            })
            .catch(() => {});
    }
}

async function salvarFormUsuario() {
    const btn = document.getElementById('btn-salvar-user-admin');
    const txtOriginal = btn ? btn.innerHTML : '';

    const id = document.getElementById('admin-user-id').value;
    const nome = (document.getElementById('admin-user-nome')?.value || '').trim();
    const nivel = document.getElementById('admin-user-nivel')?.value || 'cliente';
    const telefone = (document.getElementById('admin-user-telefone')?.value || '').trim();
    const cpf = (document.getElementById('admin-user-cpf')?.value || '').trim();
    const cep = (document.getElementById('admin-user-cep')?.value || '').trim();
    const endereco = (document.getElementById('admin-user-endereco')?.value || '').trim();
    const numero = (document.getElementById('admin-user-numero')?.value || '').trim();
    const complemento = (document.getElementById('admin-user-complemento')?.value || '').trim();
    const ativo = document.getElementById('admin-user-ativo')?.checked !== false;

    if (!nome) {
        return mostrarToast('Informe o nome completo do usuário.', 'aviso');
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando dados...';
    }

    try {
        const payload = {
            nome: nome,
            nivel: nivel,
            telefone: telefone,
            cpf: cpf,
            cep: cep,
            endereco: endereco,
            numero: numero,
            complemento: complemento,
            ativo: ativo
        };

        const { error } = await supabaseClient
            .from('profiles')
            .update(payload)
            .eq('id', id);

        if (error) throw error;

        // Atualiza cache local
        const idx = listaUsuariosAdminCache.findIndex(u => u.id === id);
        if (idx !== -1) {
            Object.assign(listaUsuariosAdminCache[idx], payload);
        }

        // Se o admin editou o próprio perfil, atualiza usuarioAtual
        if (usuarioAtual && usuarioAtual.id === id) {
            Object.assign(usuarioAtual, payload);
            if (typeof atualizarInterfaceUsuario === 'function') atualizarInterfaceUsuario();
        }

        mostrarToast(`✅ Usuário "${nome}" atualizado com sucesso! Nível: ${nivel.toUpperCase()}`, 'sucesso');
        fecharFormUsuario();
        atualizarMetricasUsuarios(listaUsuariosAdminCache);
        renderizarUsuariosAdminNaTela();

    } catch (err) {
        console.error('Erro ao atualizar usuário:', err);
        mostrarToast('Erro ao atualizar perfil do usuário: ' + (err.message || 'Verifique sua conexão.'), 'erro');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = txtOriginal;
        }
    }
}

async function alternarStatusUsuario(id, statusAtual) {
    const user = listaUsuariosAdminCache.find(u => u.id === id);
    const nome = user ? user.nome : 'o usuário';
    const novoStatus = !statusAtual;
    const acao = novoStatus ? 'reativar' : 'desativar';

    if (!confirm(`Deseja realmente ${acao} o acesso de ${nome}?`)) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('profiles')
            .update({ ativo: novoStatus })
            .eq('id', id);

        if (error) throw error;

        if (user) user.ativo = novoStatus;
        mostrarToast(`Conta de "${nome}" foi ${novoStatus ? 'reativada' : 'desativada'} com sucesso!`, 'sucesso');
        atualizarMetricasUsuarios(listaUsuariosAdminCache);
        renderizarUsuariosAdminNaTela();

    } catch (err) {
        console.error('Erro ao alternar status do usuário:', err);
        mostrarToast('Erro ao alterar status: ' + err.message, 'erro');
    }
}

// --------------------------------------------------------------------------
// Utilitários de Senha e Modal de Novo Usuário (Admin)
// --------------------------------------------------------------------------

function toggleVisibilidadeInput(inputId, btnEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    if (btnEl) {
        const icon = btnEl.querySelector('i');
        if (icon) {
            icon.className = isPass ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
        }
    }
}

function gerarSenhaParaInput(inputId) {
    const charsMaiusc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const charsMinusc = 'abcdefghjkmnpqrstuvwxyz';
    const charsNum = '23456789';
    const charsEsp = '!@#$';

    let pass = '';
    pass += charsMaiusc.charAt(Math.floor(Math.random() * charsMaiusc.length));
    pass += charsMinusc.charAt(Math.floor(Math.random() * charsMinusc.length));
    pass += charsMinusc.charAt(Math.floor(Math.random() * charsMinusc.length));
    pass += charsNum.charAt(Math.floor(Math.random() * charsNum.length));
    pass += charsNum.charAt(Math.floor(Math.random() * charsNum.length));
    pass += charsEsp.charAt(Math.floor(Math.random() * charsEsp.length));

    const todos = charsMaiusc + charsMinusc + charsNum;
    for (let i = 0; i < 2; i++) {
        pass += todos.charAt(Math.floor(Math.random() * todos.length));
    }

    pass = pass.split('').sort(() => 0.5 - Math.random()).join('');

    const el = document.getElementById(inputId);
    if (el) {
        el.value = pass;
        el.type = 'text';
        const parent = el.parentElement;
        if (parent) {
            const icon = parent.querySelector('i');
            if (icon) icon.className = 'fa-regular fa-eye-slash';
        }
        mostrarToast(`Senha forte gerada: ${pass}`, 'info');
    }
}

function abrirModalNovoUsuarioAdmin() {
    const modal = document.getElementById('modal-novo-usuario-admin');
    if (!modal) return;

    document.getElementById('novo-user-nome').value = '';
    document.getElementById('novo-user-email').value = '';
    document.getElementById('novo-user-senha').value = '';
    document.getElementById('novo-user-nivel').value = 'cliente';
    document.getElementById('novo-user-telefone').value = '';
    document.getElementById('novo-user-cpf').value = '';
    document.getElementById('novo-user-cep').value = '';
    document.getElementById('novo-user-endereco').value = '';
    document.getElementById('novo-user-numero').value = '';
    document.getElementById('novo-user-complemento').value = '';

    modal.classList.add('active');
    setTimeout(() => {
        const inputNome = document.getElementById('novo-user-nome');
        if (inputNome) inputNome.focus();
    }, 150);
}

function fecharModalNovoUsuarioAdmin() {
    const modal = document.getElementById('modal-novo-usuario-admin');
    if (modal) modal.classList.remove('active');
}

function buscarCepNovoUsuarioAdmin() {
    const cepInput = document.getElementById('novo-user-cep');
    if (!cepInput) return;
    const cep = cepInput.value.replace(/\D/g, '');
    if (cep.length === 8) {
        const ruaInput = document.getElementById('novo-user-endereco');
        if (ruaInput) ruaInput.placeholder = "Buscando logradouro...";
        fetch(`https://viacep.com.br/ws/${cep}/json/`)
            .then(res => res.json())
            .then(data => {
                if (!data.erro) {
                    if (ruaInput) ruaInput.value = `${data.logradouro}, ${data.bairro} - ${data.localidade}/${data.uf}`;
                    const numInput = document.getElementById('novo-user-numero');
                    if (numInput) numInput.focus();
                } else {
                    mostrarToast('CEP não encontrado.', 'aviso');
                }
            })
            .catch(() => {});
    }
}

async function criarNovoUsuarioAdmin() {
    const btn = document.getElementById('btn-criar-usuario-admin');
    const txtOriginal = btn ? btn.innerHTML : '';

    const nome = (document.getElementById('novo-user-nome')?.value || '').trim();
    const email = (document.getElementById('novo-user-email')?.value || '').trim();
    const password = (document.getElementById('novo-user-senha')?.value || '').trim();
    const nivel = document.getElementById('novo-user-nivel')?.value || 'cliente';
    const telefone = (document.getElementById('novo-user-telefone')?.value || '').trim();
    const cpf = (document.getElementById('novo-user-cpf')?.value || '').trim();
    const cep = (document.getElementById('novo-user-cep')?.value || '').trim();
    const endereco = (document.getElementById('novo-user-endereco')?.value || '').trim();
    const numero = (document.getElementById('novo-user-numero')?.value || '').trim();
    const complemento = (document.getElementById('novo-user-complemento')?.value || '').trim();

    if (!nome) {
        return mostrarToast('Informe o nome completo do usuário.', 'aviso');
    }
    if (!email || !email.includes('@')) {
        return mostrarToast('Informe um e-mail válido.', 'aviso');
    }
    if (!password || password.length < 6) {
        return mostrarToast('A senha deve ter no mínimo 6 caracteres.', 'aviso');
    }

    const { data: sessionData, error: sessionErr } = await supabaseClient.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) {
        return mostrarToast('Sua sessão expirou. Faça login novamente como administrador.', 'erro');
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cadastrando...';
    }

    try {
        const response = await fetch('/api/admin/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                action: 'create',
                nome,
                email,
                password,
                nivel,
                telefone,
                cpf,
                cep,
                endereco,
                numero,
                complemento
            })
        });

        const resData = await response.json();

        if (!response.ok) {
            if (resData.needServiceRole) {
                throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada no Cloudflare Pages. Por favor adicione a chave nas variáveis de ambiente do Cloudflare.');
            }
            throw new Error(resData.error || 'Erro ao criar usuário.');
        }

        mostrarToast(`✅ Usuário "${nome}" cadastrado com sucesso! Nível: ${nivel.toUpperCase()}`, 'sucesso');
        fecharModalNovoUsuarioAdmin();
        await carregarUsuariosAdmin();

    } catch (err) {
        console.error('Erro ao cadastrar usuário:', err);
        mostrarToast('Erro: ' + (err.message || 'Falha ao processar requisição.'), 'erro');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = txtOriginal;
        }
    }
}

async function alterarSenhaUsuarioAdmin() {
    const userId = document.getElementById('admin-user-id')?.value;
    const nome = (document.getElementById('admin-user-nome')?.value || 'Usuário').trim();
    const newPassword = (document.getElementById('admin-user-nova-senha')?.value || '').trim();
    const btn = document.getElementById('btn-alterar-senha-user');
    const txtOriginal = btn ? btn.innerHTML : '';

    if (!userId) {
        return mostrarToast('Nenhum usuário selecionado.', 'aviso');
    }

    if (!newPassword || newPassword.length < 6) {
        return mostrarToast('A nova senha deve ter no mínimo 6 caracteres.', 'aviso');
    }

    if (!confirm(`Confirma a alteração da senha de acesso de "${nome}"?`)) {
        return;
    }

    const { data: sessionData, error: sessionErr } = await supabaseClient.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) {
        return mostrarToast('Sua sessão expirou. Faça login novamente como administrador.', 'erro');
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Atualizando...';
    }

    try {
        const response = await fetch('/api/admin/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                action: 'update-password',
                userId,
                newPassword
            })
        });

        const resData = await response.json();

        if (!response.ok) {
            if (resData.needServiceRole) {
                throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada no Cloudflare Pages. Por favor adicione a chave nas variáveis de ambiente do Cloudflare.');
            }
            throw new Error(resData.error || 'Erro ao atualizar a senha do usuário.');
        }

        mostrarToast(`✅ Senha de "${nome}" atualizada com sucesso!`, 'sucesso');
        const senhaInput = document.getElementById('admin-user-nova-senha');
        if (senhaInput) senhaInput.value = '';

    } catch (err) {
        console.error('Erro ao alterar senha do usuário:', err);
        mostrarToast('Erro: ' + (err.message || 'Falha ao alterar senha.'), 'erro');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = txtOriginal;
        }
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
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.apiKey) {
                // Remove credencial sensível residual do armazenamento local
                delete parsed.apiKey;
                try { localStorage.setItem(WHATSAPP_STORAGE_KEY, JSON.stringify(parsed)); } catch (_) {}
            }
            return parsed;
        }
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
    const num = (document.getElementById('wa-numero-loja')?.value || '').trim();
    const auto = document.getElementById('wa-disparo-automatico')?.checked !== false;

    // Chaves de API sensíveis não são salvas no localStorage (ficam no backend do Cloudflare)
    const novaCfg = {
        provedor: prov,
        instanciaUrl: url,
        instanciaNome: nome,
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
        
        if (cfg.provedor === 'direct') {
            statusDiv.innerHTML = `<div style="padding:12px; background:#fffbeb; color:#92400e; border-radius:8px; font-size:12px; border:1px solid #fde68a;">
                <i class="fa-solid fa-circle-info"></i> <strong>Modo Direto 1-Clique Ativo:</strong> Sem gateway externo configurado.<br>
                <a href="https://api.whatsapp.com/send?phone=55${foneLoja}&text=${encodeURIComponent(msgTeste)}" target="_blank" class="btn-whatsapp-sm" style="margin-top:8px;">
                    <i class="fa-brands fa-whatsapp"></i> Testar no WhatsApp Web / App
                </a>
            </div>`;
            return;
        }

        const session = (await window.supabaseClient?.auth?.getSession())?.data?.session;
        const token = session?.access_token || '';

        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({
                telefone: foneLoja,
                mensagem: msgTeste,
                provedor: cfg.provedor,
                instanciaUrl: cfg.instanciaUrl,
                instanciaNome: cfg.instanciaNome
            })
        });

        const data = await res.json();
        if (res.ok && data.success) {
            statusDiv.innerHTML = '<div style="padding:12px; background:#ecfdf5; color:#065f46; border-radius:8px; font-size:12px; border:1px solid #a7f3d0;"><i class="fa-solid fa-circle-check"></i> <strong>Mensagem enviada com sucesso!</strong> Verifique seu WhatsApp (' + foneLoja + ').</div>';
        } else {
            const rawError = String(data.error || 'Erro no gateway WhatsApp.');
            let dicaAdicional = '';
            const mgrUrl = (cfg.instanciaUrl || 'https://lunoca-whatsapp.onrender.com').replace(/\/+$/, '') + '/manager/';

            if (rawError.toLowerCase().includes('not found') || data.status === 404) {
                dicaAdicional = `<div style="margin-top:8px; padding-top:8px; border-top:1px dashed #fca5a5; font-size:11.5px; color:#991b1b; line-height:1.5;">
                    💡 <strong>Instância "${escapeHTML(cfg.instanciaNome || 'lunoca-whatsapp')}" ainda não foi criada no WhatsApp:</strong><br>
                    Para conectar, acesse o painel do seu servidor: <a href="${mgrUrl}" target="_blank" style="color:#0284c7; font-weight:700; text-decoration:underline;">Abrir Evolution Manager <i class="fa-solid fa-arrow-up-right-from-square"></i></a>, faça login com sua API Key, clique em <strong>"Criar Instância"</strong> com o nome <code>${escapeHTML(cfg.instanciaNome || 'lunoca-whatsapp')}</code> e <strong>escaneie o QR Code</strong> no WhatsApp do seu celular.
                </div>`;
            } else if (rawError.toLowerCase().includes('unauthorized') || data.status === 401) {
                dicaAdicional = `<div style="margin-top:8px; padding-top:8px; border-top:1px dashed #fca5a5; font-size:11.5px; color:#991b1b; line-height:1.5;">
                    🔑 <strong>Chave API Incorreta:</strong> A chave informada em <em>API Key / Token Global</em> não coincide com a <code>AUTHENTICATION_API_KEY</code> definida no seu Render.
                </div>`;
            }

            statusDiv.innerHTML = '<div style="padding:12px; background:#fff1f2; color:#be123c; border-radius:8px; font-size:12px; border:1px solid #fecdd3;"><i class="fa-solid fa-circle-xmark"></i> <strong>Falha no envio:</strong> ' + escapeHTML(rawError) + dicaAdicional + '</div>';
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

// --------------------------------------------------------------------------
// Conexão e Leitura de QR Code Direta da Evolution API no Painel Admin
// --------------------------------------------------------------------------
let _waQrPollingTimer = null;

function pararPollingEvolutionQrCode() {
    if (_waQrPollingTimer) {
        clearInterval(_waQrPollingTimer);
        _waQrPollingTimer = null;
    }
}

async function conectarEvolutionQrCodeAdmin() {
    salvarConfigWhatsAppAdmin();
    const cfg = getWhatsAppConfig();
    const box = document.getElementById('wa-qrcode-box');
    const conteudo = document.getElementById('wa-qrcode-conteudo');
    const btn = document.getElementById('btn-conectar-evolution-qr');
    const txtOriginal = btn ? btn.innerHTML : '';

    if (!box || !conteudo) return;
    pararPollingEvolutionQrCode();

    box.style.display = 'block';
    conteudo.innerHTML = `
        <div style="padding: 15px; color: #1e293b;">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 26px; color: #2563eb; margin-bottom: 10px;"></i>
            <h4 style="margin: 0 0 6px;">Conectando com a Evolution API...</h4>
            <p style="margin: 0; font-size: 12.5px; color: #64748b;">Solicitando criação de sessão e QR Code no servidor.</p>
        </div>
    `;

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando QR Code...';
    }

    try {
        const session = (await window.supabaseClient?.auth?.getSession())?.data?.session;
        const token = session?.access_token || '';

        const res = await fetch('/api/whatsapp/instance', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({
                action: 'connect',
                instanciaUrl: cfg.instanciaUrl,
                instanciaNome: cfg.instanciaNome || 'lunoca-whatsapp'
            })
        });

        const data = await res.json();

        if (data.connected || data.state === 'open') {
            conteudo.innerHTML = `
                <div style="padding: 15px; background: #ecfdf5; border-radius: 12px; border: 1px solid #a7f3d0;">
                    <i class="fa-solid fa-circle-check" style="font-size: 32px; color: #16a34a; margin-bottom: 8px;"></i>
                    <h3 style="margin: 0 0 4px; color: #065f46; font-size: 16px;">WhatsApp 100% Conectado!</h3>
                    <p style="margin: 0 0 12px; font-size: 13px; color: #047857;">A instância <strong>${escapeHTML(cfg.instanciaNome || 'lunoca-whatsapp')}</strong> está ativa e pronta para enviar mensagens automáticas.</p>
                    <button type="button" class="btn-outline" onclick="fecharBoxQrCodeWhatsApp()" style="padding: 6px 14px; font-size: 12px;">Fechar Janela</button>
                </div>
            `;
            const dot = document.getElementById('wa-status-dot');
            if (dot) dot.className = 'whatsapp-pulse-dot online';
            return;
        }

        if (data.qrcode) {
            conteudo.innerHTML = `
                <div>
                    <h4 style="margin: 0 0 4px; color: var(--text-dark); font-size: 16px;">
                        <i class="fa-brands fa-whatsapp" style="color: #25d366;"></i> Escaneie o QR Code no seu WhatsApp
                    </h4>
                    <p style="margin: 0 0 12px; font-size: 12.5px; color: #64748b;">
                        1. Abra o WhatsApp no celular &bull; 2. Toque em <strong>Aparelhos Conectados</strong> &bull; 3. <strong>Conectar um Aparelho</strong>
                    </p>
                    <div style="display: inline-block; padding: 10px; background: #fff; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
                        <img src="${data.qrcode}" alt="QR Code WhatsApp" style="width: 240px; height: 240px; display: block; border-radius: 8px;">
                    </div>
                    ${data.pairingCode ? `<div style="margin-top: 10px; font-size: 13px; color: #1e293b;">Código de Pareamento: <strong style="font-family: monospace; background: #f1f5f9; padding: 4px 8px; border-radius: 6px;">${escapeHTML(data.pairingCode)}</strong></div>` : ''}
                    <div style="margin-top: 14px; font-size: 12px; color: #0284c7; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        <i class="fa-solid fa-spinner fa-spin"></i> Aguardando leitura do QR Code pelo celular...
                    </div>
                    <div style="margin-top: 12px; display: flex; justify-content: center; gap: 8px;">
                        <button type="button" class="btn-outline" onclick="conectarEvolutionQrCodeAdmin()" style="padding: 5px 12px; font-size: 11.5px;"><i class="fa-solid fa-rotate-right"></i> Atualizar QR Code</button>
                        <button type="button" class="btn-danger" onclick="resetarInstanciaEvolutionAdmin()" style="padding: 5px 12px; font-size: 11.5px;"><i class="fa-solid fa-trash-can"></i> Resetar Instância</button>
                        <button type="button" class="btn-outline" onclick="fecharBoxQrCodeWhatsApp()" style="padding: 5px 12px; font-size: 11.5px;">Fechar</button>
                    </div>
                </div>
            `;

            _waQrPollingTimer = setInterval(async () => {
                try {
                    const pollSession = (await window.supabaseClient?.auth?.getSession())?.data?.session;
                    const pollToken = pollSession?.access_token || '';

                    const stRes = await fetch('/api/whatsapp/instance', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            ...(pollToken ? { 'Authorization': `Bearer ${pollToken}` } : {})
                        },
                        body: JSON.stringify({
                            action: 'status',
                            instanciaUrl: cfg.instanciaUrl,
                            instanciaNome: cfg.instanciaNome || 'lunoca-whatsapp'
                        })
                    });
                    const stData = await stRes.json();
                    if (stData.connected || stData.state === 'open') {
                        pararPollingEvolutionQrCode();
                        conteudo.innerHTML = `
                            <div style="padding: 15px; background: #ecfdf5; border-radius: 12px; border: 1px solid #a7f3d0;">
                                <i class="fa-solid fa-circle-check" style="font-size: 32px; color: #16a34a; margin-bottom: 8px;"></i>
                                <h3 style="margin: 0 0 4px; color: #065f46; font-size: 16px;">WhatsApp Conectado com Sucesso!</h3>
                                <p style="margin: 0 0 12px; font-size: 13px; color: #047857;">Seu número já está vinculado e pronto para disparos.</p>
                                <button type="button" class="btn-primary" onclick="fecharBoxQrCodeWhatsApp()" style="padding: 6px 14px; font-size: 12px; background: #16a34a;">Concluir</button>
                            </div>
                        `;
                        const dot = document.getElementById('wa-status-dot');
                        if (dot) dot.className = 'whatsapp-pulse-dot online';
                    }
                } catch (pollErr) {}
            }, 3000);

            return;
        }

        conteudo.innerHTML = `
            <div style="padding: 14px; background: #fff1f2; border-radius: 12px; border: 1px solid #fecdd3; color: #991b1b;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 24px; margin-bottom: 6px;"></i>
                <h4 style="margin: 0 0 4px;">Não foi possível obter o QR Code</h4>
                <p style="margin: 0 0 10px; font-size: 12.5px;">${escapeHTML(data.error || 'A Evolution API não retornou o código de conexão.')}</p>
                <div style="display: flex; justify-content: center; gap: 8px;">
                    <button type="button" class="btn-primary" onclick="resetarInstanciaEvolutionAdmin()" style="padding: 6px 12px; font-size: 12px; background: #dc2626;"><i class="fa-solid fa-rotate"></i> Resetar e Tentar Novamente</button>
                    <button type="button" class="btn-outline" onclick="fecharBoxQrCodeWhatsApp()" style="padding: 6px 12px; font-size: 12px;">Fechar</button>
                </div>
            </div>
        `;

    } catch (err) {
        conteudo.innerHTML = `
            <div style="padding: 14px; background: #fff1f2; border-radius: 12px; border: 1px solid #fecdd3; color: #991b1b;">
                <i class="fa-solid fa-circle-exclamation" style="font-size: 24px; margin-bottom: 6px;"></i>
                <h4 style="margin: 0 0 4px;">Erro de conexão</h4>
                <p style="margin: 0; font-size: 12px;">${escapeHTML(err.message)}</p>
            </div>
        `;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = txtOriginal;
        }
    }
}

function fecharBoxQrCodeWhatsApp() {
    pararPollingEvolutionQrCode();
    const box = document.getElementById('wa-qrcode-box');
    if (box) box.style.display = 'none';
}

async function resetarInstanciaEvolutionAdmin() {
    if (!confirm('Deseja resetar a instância do WhatsApp para gerar um novo QR Code do zero?')) return;
    const cfg = getWhatsAppConfig();
    try {
        const session = (await window.supabaseClient?.auth?.getSession())?.data?.session;
        const token = session?.access_token || '';

        await fetch('/api/whatsapp/instance', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({
                action: 'delete',
                instanciaUrl: cfg.instanciaUrl,
                instanciaNome: cfg.instanciaNome || 'lunoca-whatsapp'
            })
        });
        mostrarToast('Instância resetada com sucesso! Gerando novo QR Code...', 'sucesso');
        setTimeout(() => conectarEvolutionQrCodeAdmin(), 800);
    } catch (e) {
        mostrarToast('Erro ao resetar: ' + e.message, 'erro');
    }
}

