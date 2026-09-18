function toggleUserMenu() {
  let dropdown = document.getElementById('user-dropdown');
  if (usuarioAtual.nivel === 'visitante') {
    mostrarTela('login-section');
    return;
  }
  
  if (dropdown.classList.contains('show')) {
    dropdown.classList.remove('show');
  } else {
    let html = '<button onclick="abrirMinhaConta()"><i class="fa-solid fa-id-card"></i> Minha Conta</button>';
    if (usuarioAtual.nivel === 'admin') {
      html += '<button onclick="mostrarTela(\'admin-section\')"><i class="fa-solid fa-screwdriver-wrench"></i> Painel Admin</button>';
    }
    html += '<button onclick="fazerLogout()"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sair</button>';
    dropdown.innerHTML = html;
    dropdown.classList.add('show');
  }
}

function alternarModoAuth() {
  modoCadastro = !modoCadastro;
  document.getElementById('auth-title').innerHTML = modoCadastro ? "<i class='fa-solid fa-user-plus'></i> Criar Conta" : "<i class='fa-solid fa-right-to-bracket'></i> Login";
  document.getElementById('btn-auth-action').innerText = modoCadastro ? "Concluir Cadastro" : "Entrar";
  document.getElementById('cadastro-fields').style.display = modoCadastro ? "block" : "none";
}

async function processarAutenticacao() {
  const email = document.getElementById('auth-email').value;
  const senha = document.getElementById('auth-senha').value;
  const btn = document.getElementById('btn-auth-action');
  
  if (!email || !senha) return alert("Preencha email e senha.");
  
  const textOriginal = btn.innerText;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aguarde...';

  try {
    if (modoCadastro) {
      const nome = document.getElementById('reg-nome').value;
      const { data, error } = await supabaseClient.auth.signUp({
        email: email,
        password: senha,
        options: { data: { nome: nome } }
      });
      if (error) throw error;
      alert("Cadastro realizado com sucesso! Faça login para continuar.");
      alternarModoAuth();
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: senha
      });
      if (error) throw new Error('Usuário ou senha incorretos.');
      if (data.user) {
        await carregarPerfilUsuario(data.user);
        atualizarInterfaceUsuario();
        mostrarTela('menu-section');
      }
    }
  } catch (error) {
    if (modoCadastro) {
      alert("Erro ao cadastrar: " + error.message);
    } else {
      alert(error.message);
    }
  } finally {
    btn.innerHTML = textOriginal;
  }
}

async function fazerLogout() {
  await supabaseClient.auth.signOut();
  usuarioAtual = { nivel: 'visitante', nome: '', email: '', id: null };
  carrinho = [];
  atualizarBotaoCarrinho();
  atualizarInterfaceUsuario();
  mostrarTela('menu-section');
}

function atualizarInterfaceUsuario() {
  const greeting = document.getElementById('user-greeting');
  if (usuarioAtual.nivel === 'visitante') {
    greeting.innerText = "Acompanhe nossos doces como Visitante";
  } else {
    greeting.innerText = "Olá, " + usuarioAtual.nome;
  }
}

async function carregarSessaoAtual() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    await carregarPerfilUsuario(session.user);
    atualizarInterfaceUsuario();
  }
}

async function carregarPerfilUsuario(authUser) {
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .single();
      
    if (error) throw error;
    
    if (data) {
      usuarioAtual = {
        id: data.id,
        nome: data.nome || authUser.user_metadata?.nome || '',
        email: data.email,
        cpf: data.cpf || '',
        telefone: data.telefone || '',
        cep: data.cep || '',
        endereco: data.endereco || '',
        numero: data.numero || '',
        complemento: data.complemento || '',
        nivel: data.nivel || 'cliente'
      };
    }
  } catch (error) {
    console.error("Erro ao carregar perfil:", error);
  }
}

function abrirMinhaConta() {
  document.getElementById('perfil-nome').value = usuarioAtual.nome || "";
  document.getElementById('perfil-email').value = usuarioAtual.email || "";
  document.getElementById('perfil-cpf').value = usuarioAtual.cpf || "";
  document.getElementById('perfil-telefone').value = usuarioAtual.telefone || "";
  document.getElementById('perfil-cep').value = usuarioAtual.cep || "";
  document.getElementById('perfil-endereco').value = usuarioAtual.endereco || "";
  document.getElementById('perfil-numero').value = usuarioAtual.numero || "";
  document.getElementById('perfil-complemento').value = usuarioAtual.complemento || "";
  mostrarTela('conta-section');
}

async function salvarPerfilUsuario() {
  const btn = document.getElementById('btn-salvar-perfil');
  const textOriginal = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
  
  const nome = document.getElementById('perfil-nome').value;
  const cpf = document.getElementById('perfil-cpf').value;
  const telefone = document.getElementById('perfil-telefone').value;
  const cep = document.getElementById('perfil-cep').value;
  const endereco = document.getElementById('perfil-endereco').value;
  const numero = document.getElementById('perfil-numero').value;
  const complemento = document.getElementById('perfil-complemento').value;
  
  try {
    const { error } = await supabaseClient
      .from('profiles')
      .update({
        nome: nome,
        cpf: cpf,
        telefone: telefone,
        cep: cep,
        endereco: endereco,
        numero: numero,
        complemento: complemento
      })
      .eq('id', usuarioAtual.id);
      
    if (error) throw error;
    
    usuarioAtual.nome = nome;
    usuarioAtual.cpf = cpf;
    usuarioAtual.telefone = telefone;
    usuarioAtual.cep = cep;
    usuarioAtual.endereco = endereco;
    usuarioAtual.numero = numero;
    usuarioAtual.complemento = complemento;
    
    atualizarInterfaceUsuario();
    alert("Perfil atualizado com sucesso!");
  } catch (error) {
    alert("Erro ao atualizar perfil: " + error.message);
  } finally {
    btn.innerHTML = textOriginal;
  }
}

function mudarTabConta(tab) {
  document.getElementById('tab-conta-pessoal').classList.remove('active');
  document.getElementById('tab-conta-endereco').classList.remove('active');
  document.getElementById('conta-tab-pessoal').classList.remove('active');
  document.getElementById('conta-tab-endereco').classList.remove('active');
  
  document.getElementById('tab-conta-' + tab).classList.add('active');
  document.getElementById('conta-tab-' + tab).classList.add('active');
}

function buscarCepViaAPI() {
  let cep = document.getElementById('perfil-cep').value.replace(/\D/g, '');
  if (cep.length === 8) {
    document.getElementById('perfil-endereco').value = "Buscando endereço...";
    fetch('https://viacep.com.br/ws/' + cep + '/json/')
      .then(res => res.json())
      .then(data => {
        if (!data.erro) {
          document.getElementById('perfil-endereco').value = data.logradouro + ", " + data.bairro + ", " + data.localidade + " - " + data.uf;
          document.getElementById('perfil-numero').focus();
        } else {
          document.getElementById('perfil-endereco').value = "";
          alert("CEP não encontrado.");
        }
      })
      .catch(err => {
        document.getElementById('perfil-endereco').value = "";
      });
  }
}
