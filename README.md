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
2. Copie e execute o conteúdo do arquivo `sql/install.sql` (ou `sql/schema.sql`).
3. O script cria toda a estrutura unificada do sistema:
   - Tabelas de Usuários (`profiles`), `produtos`, `pedidos`, `estoque`, `financeiro_lancamentos`.
   - RPCs seguras: `criar_pedido`, `confirmar_pagamento_pedido`, `baixar_estoque_pedido_batch`.
   - Políticas RLS rigorosas bloqueando usuários desativados (`ativo = false`).
   - Trigger de proteção server-side para validação e recálculo de totais.

### 3. Configurar a Autenticação (Auth)
1. Vá até a seção **Authentication** no Supabase.
2. Na aba **Providers** (sob Configuration), selecione **Email**.
3. **Desative** a opção "Confirm email" para simplificar os testes iniciais e clique em Save.

### 4. Configurar as Chaves no Aplicativo
1. Abra o arquivo `js/supabase.js`.
2. Assegure que `SUPABASE_URL` e `SUPABASE_ANON_KEY` correspondam ao seu projeto.

### 5. Promover o Primeiro Usuário a Admin
1. Abra a aplicação e faça o cadastro do seu primeiro usuário através da interface (Login > Cadastre-se).
2. Volte ao SQL Editor no Supabase.
3. Execute o seguinte comando para dar permissões de administrador a essa conta:
```sql
UPDATE public.profiles SET nivel = 'admin' WHERE email = 'seu_email@exemplo.com';
```

### 6. Hospedagem & Funções Serverless (Cloudflare Pages)
> ⚠️ **Importante:** A aplicação utiliza funções serverless (`/functions/api/`) para o Checkout Transparente do Mercado Pago, Webhooks, envio seguro de WhatsApp e upload de imagens. Por isso, a hospedagem recomendada e suportada é o **Cloudflare Pages** (GitHub Pages estático não suporta rotas de API serverless).

1. Conecte seu repositório no [Cloudflare Pages](https://pages.cloudflare.com).
2. Deixe o diretório raiz como build output (`/`).
3. Em **Settings > Environment variables**, configure as variáveis de ambiente de produção:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MERCADO_PAGO_ACCESS_TOKEN`
   - `MERCADO_PAGO_WEBHOOK_SECRET`
   - `EVOLUTION_API_URL` (URL do seu servidor Evolution API no Render/Docker)
   - `EVOLUTION_API_KEY` (Chave secreta da Evolution API)
   - `IMGBB_API_KEY` (Opcional, para upload de fotos)
   - `APP_BASE_URL` (ex: `https://lunocadoceria.com.br`)

## Solução de Problemas
- **Produtos não aparecem?** Verifique se o RLS de `produtos` permite visualização pública e se há dados na tabela.
- **Não consigo logar?** Confirme se desativou a confirmação de e-mail ou se o usuário está ativo (`ativo = true`).
- **QR Code do Mercado Pago não gera?** Verifique se `MERCADO_PAGO_ACCESS_TOKEN` está configurado nas variáveis de ambiente do Cloudflare Pages.
- **WhatsApp não conecta?** Verifique se o serviço Evolution API está ativo no Render e se `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` estão configurados no Cloudflare Pages.
