# Guia de Integração e Automação Supabase — Lunoca Doceria

Este documento descreve a arquitetura de integração contínua com o **Supabase**, cobrindo o pipeline de **verificações automáticas de saúde/schema** e os **upgrades automáticos de migrações**.

---

## 1. Arquitetura da Integração

```
┌────────────────────────────────────────────────────────┐
│                   Repositório Lunoca                   │
│  supabase/migrations/ (001 a 013)                      │
└──────────────┬─────────────────────────┬───────────────┘
               │                         │
               ▼                         ▼
   ┌───────────────────────┐ ┌───────────────────────┐
   │ scripts/              │ │ scripts/              │
   │ supabase-verify.mjs   │ │ supabase-upgrade.mjs  │
   └───────────┬───────────┘ └───────────┬───────────┘
               │                         │
               │ (Health check & Schema) │ (Transações ACID)
               ▼                         ▼
┌────────────────────────────────────────────────────────┐
│                 Supabase PostgreSQL                   │
│  • REST API (PostgREST)                                │
│  • Auth / GoTrue                                       │
│  • schema_migrations (Controle de versões)             │
│  • Confectionery OS Core, RLS Fail-Closed & RPCs       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Comandos Disponíveis via npm

| Comando | Descrição |
|---|---|
| `npm run db:verify` | Executa a **suíte de verificação automática**: ping de latência, saúde do Auth, detecção de tabelas core, validação de RPCs e status de migrações. |
| `npm run db:upgrade` | Executa o **upgrade automático**: conecta ao PostgreSQL, verifica migrações pendentes e aplica-as sequencialmente dentro de blocos transacionais com rollback de segurança. |
| `npm run db:upgrade:dry` | Simula o plano de execução de upgrades sem alterar o banco de dados (**Dry-Run**). |
| `npm run db:status` | Exibe o status de cada migração (aplicada vs. pendente) e respectivo hash SHA-256. |
| `npm run db:check` | Executa verificação de paridade SQL do compilador (`scripts/build-sql.mjs --check`) somada à verificação de integridade do Supabase. |

---

## 3. Configuração de Credenciais (`.env`)

Copie o modelo gerado em `.env.example`:

```bash
cp .env.example .env
```

Preencha as variáveis correspondentes:

```ini
# URL e Chaves da API
SUPABASE_URL=https://xdnlkvbfaacrrhhuaxao.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key

# Conexão Direta ao PostgreSQL (necessária para npm run db:upgrade)
# Disponível no painel: Project Settings > Database > Connection string (Pooler)
SUPABASE_DB_URL=postgresql://postgres.xdnlkvbfaacrrhhuaxao:[SUA_SENHA]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
```

---

## 4. Pipeline de Verificações Automáticas (`db:verify`)

O verificador inspeciona cinco camadas de integridade:
1. **Conectividade & Latência**: Envia requisições assinadas para a API REST e mede o tempo de resposta do cluster.
2. **Módulo de Autenticação**: Valida a resposta do serviço GoTrue.
3. **Integridade de Tabelas**: Checa a existência e o isolamento por RLS de todas as 16 tabelas essenciais (pedidos, orçamentos, produtos, lançamentos, etc.).
4. **RPCs Críticas**: Valida o registro das 9 funções centrais da Etapa 2 e Etapa 3 (`nucleo_criar_encomenda`, `converter_orcamento_em_pedido_admin`, `politica_desconto`, `politica_sinal`, etc.).
5. **Catálogo de Migrações**: Audita as 13 migrações versionadas, seus hashes SHA-256 e a paridade de compilação em `sql/install.sql` e `sql/schema.sql`.

---

## 5. Pipeline de Upgrades Automáticos (`db:upgrade`)

Quando executado com `SUPABASE_DB_URL`:
1. Cria (se inexistente) o esquema de auditoria `supabase_migrations.schema_migrations`.
2. Identifica com exatidão quais migrações ainda não foram processadas.
3. Para cada migração pendente:
   - Inicia uma transação PostgreSQL (`BEGIN`).
   - Executa as instruções SQL da migração.
   - Registra o hash SHA-256 e o timestamp de aplicação.
   - Confirma a transação (`COMMIT`).
   - **Garantia de Rollback**: Caso ocorra qualquer exceção, a transação da migração é revertida imediatamente (`ROLLBACK`) e o runner é interrompido com diagnóstico detalhado.

Se `SUPABASE_DB_URL` não for informada no ambiente, o runner gera automaticamente o script transacional consolidado em `supabase/pending-upgrade.sql`, pronto para execução com 1 clique no **Supabase SQL Editor**.

---

## 6. Integração Contínua (GitHub Actions)

O repositório inclui o workflow [`.github/workflows/supabase-ci.yml`](file:///.github/workflows/supabase-ci.yml):
- **Pull Requests e Pushes**: Executa lint de sintaxe, checagem de compilação SQL, testes estruturais e testes de integração com PostgreSQL real.
- **Deploy Automático na `main`**: Caso os segredos de repositório `SUPABASE_DB_URL` estejam configurados, aplica automaticamente os upgrades pendentes no cluster Supabase em produção.
