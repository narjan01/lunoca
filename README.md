# Lunoca - App de Pedidos para Doceria

Uma aplicação web Single Page Application (SPA) para docerias gerenciarem produtos, clientes e pedidos. Construída com HTML/CSS/JS puro no frontend e Supabase (PostgreSQL + Auth) no backend.

## Pré-requisitos
- Conta no [Supabase](https://supabase.com)
- Conta no [GitHub](https://github.com) (para hospedagem via GitHub Pages)

## Passo a Passo para Configuração

### 1. Criar o Projeto no Supabase
1. Acesse o Supabase e crie um novo projeto.
2. Anote sua URL do Projeto e a chave `anon` nas configurações de API.

### 2. Configurar o Banco de Dados
1. No painel do Supabase, vá até a aba **SQL Editor**.
2. Copie o conteúdo do arquivo `sql/schema.sql` deste projeto.
3. Cole no editor e clique em **Run** para criar as tabelas, políticas RLS, e triggers.

### 3. Configurar a Autenticação (Auth)
1. Vá até a seção **Authentication** no Supabase.
2. Na aba **Providers** (sob Configuration), selecione **Email**.
3. **Desative** a opção "Confirm email" para simplificar os testes iniciais e clique em Save.

### 4. Configurar as Chaves no Aplicativo
1. Abra o arquivo `js/supabase.js`.
2. Substitua `SUA_SUPABASE_URL_AQUI` pela URL do seu projeto Supabase.
3. Substitua `SUA_SUPABASE_ANON_KEY_AQUI` pela sua chave `anon`.

### 5. Promover o Primeiro Usuário a Admin
1. Abra a aplicação e faça o cadastro do seu primeiro usuário através da interface (Login > Cadastre-se).
2. Volte ao SQL Editor no Supabase.
3. Execute o seguinte comando para dar permissões de administrador a essa conta:
```sql
UPDATE public.profiles SET nivel = 'admin' WHERE email = 'seu_email@exemplo.com';
```

### 6. Hospedagem
Você pode hospedar o frontend de forma simples via GitHub Pages ou Cloudflare Pages:
1. Suba os arquivos do projeto para um repositório no GitHub.
2. Nas configurações do repositório, vá em **Pages** e selecione a branch `main`.

## Configuração de DNS (Exemplo Umbler)
Se você possui um domínio próprio e utiliza serviços como Umbler:
1. Vá até o painel de configuração de DNS.
2. Adicione um registro **CNAME**.
3. Aponta seu subdomínio ou domínio principal para o endereço gerado pelo GitHub Pages (ex: `seu-usuario.github.io`).

## Migração de Dados (Google Sheets para Supabase)
Se você tem dados antigos em uma planilha, pode migrá-los para o Supabase:
1. Exporte sua planilha (Produtos ou Usuários) como CSV.
2. No Supabase, vá na seção **Table Editor**.
3. Selecione a tabela destino (ex: `produtos`).
4. Clique em **Insert > Import data from CSV** e siga os passos na tela.

## Solução de Problemas
- **Produtos não aparecem?** Verifique se o RLS de `produtos` permite visualização pública e se há dados na tabela.
- **Não consigo logar?** Confirme se desativou a confirmação de e-mail ou verifique a tabela `auth.users` no Supabase.
- **Upload de fotos falha?** Verifique se a chave do ImgBB no arquivo `supabase.js` é válida e está sem aspas extras.
