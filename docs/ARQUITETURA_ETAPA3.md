# Arquitetura — Etapa 3: Orçamentos Comerciais, Espelho de Impressão, Proposta Pública & Conversão Transacional

Este documento formaliza as **decisões arquiteturais vinculantes** da Etapa 3 (migrations `012_hardening_politicas_e_nucleo.sql` e `013_etapa3_orcamentos_conversao_comercial.sql`). Todo fluxo relacionado a propostas comerciais, orçamentos, aprovação pública pelo cliente e conversão em encomendas deve obedecer rigorosamente às diretrizes abaixo.

---

## 1. Decisões Consolidadas

| Tema | Decisão |
|---|---|
| **Isolamento de Domínio** | Orçamentos são propostas comerciais pré-pedido. **NÃO reservam estoque nem capacidade produtiva** enquanto estiverem em rascunho, enviado ou aprovado. |
| **Isolamento da Loja Online** | O fluxo de checkout e compra imediata da loja (`criar_pedido`) permanece **100% isolado**. Possui ciclo financeiro curto, geração de PIX e hold temporário próprio. |
| **Núcleo Canônico de Encomendas** | `nucleo_criar_encomenda()` é a função privada central que governa reserva de estoque, locks de capacidade, ledger e criação física do pedido, consumida tanto por `criar_encomenda_admin` quanto por `converter_orcamento_em_pedido_admin`. |
| **Eliminação de Parâmetros de Autorização** | **Nenhuma** RPC pública ou compartilhada aceita parâmetros de bypass como `p_is_admin`. Autorizações e papéis são inspecionados estritamente via contexto de sessão (`auth.uid()`, RBAC em `perfis`) ou chaves de serviço. |
| **Snapshots de Preço e Produção** | Na criação do orçamento, os preços, adicionais e pontos de produção são capturados em snapshots imutáveis (`orcamento_itens`, `orcamento_item_opcoes`). A conversão utiliza **estritamente esses snapshots**, nunca recorrendo aos preços atuais do catálogo. |
| **Unicidade Bidirecional** | Relação 1:1 estrita entre orçamento e pedido: `orcamentos.pedido_id` possui constraint `UNIQUE`, e `pedidos.orcamento_origem_id` possui constraint `UNIQUE`. Um orçamento gera no máximo um pedido, e um pedido referencia no máximo um orçamento. |
| **Aprovação Pública Sem Autenticação** | O cliente acessa a proposta via link único com token seguro UUID v4 (`/orcamento.html?t=<token>`). A aprovação é realizada via RPC dedicada `aprovar_orcamento_publico`, idempotente e com validação de termos. |
| **Janela de Conversão vs. Validade** | `validade_ate`: prazo para o cliente aceitar a proposta. Ao aceitar, o orçamento passa a `aprovado` e recebe `janela_conversao_limite` (padrão 24h) para o operador processar a conversão antes da necessidade de revalidação de agenda/insumos. |
| **Expiração Unificada no Cron** | O cron job (`/api/cron/expire-orders`) executa de forma transacional `expirar_pedidos_e_holds()` e `expirar_orcamentos()`, utilizando `FOR UPDATE SKIP LOCKED`. |
| **Fichas e Impressão Governança** | Suporte a `@media print` para Espelho Comercial (valores, sinal, chave Pix, regras) e Ficha de Bancada (estritamente operacional, sem valores financeiros). Sinal reflete a política configurada, nunca valor fixo de 50%. |

---

## 2. Modelagem de Dados

### Tabelas Criadas (Migration `013`)

1. **`orcamentos`**:
   - `id UUID PRIMARY KEY`, `codigo TEXT NOT NULL UNIQUE`, `versao INT NOT NULL DEFAULT 1`
   - `cliente_id UUID REFERENCES clientes(id)`, `cliente_nome`, `cliente_telefone`, `cliente_email`
   - `tipo_evento TEXT`, `data_evento DATE NOT NULL`, `hora_evento TIME`
   - `tipo_entrega TEXT CHECK (tipo_entrega IN ('retirada', 'entrega'))`
   - `endereco_entrega JSONB`, `cep_entrega TEXT`, `bairro_entrega TEXT`, `cidade_entrega TEXT`
   - `valor_subtotal NUMERIC(10,2)`, `valor_frete_base NUMERIC(10,2)`, `valor_frete_cobrado NUMERIC(10,2)`, `desconto_frete NUMERIC(10,2)`
   - `valor_desconto NUMERIC(10,2)`, `valor_total NUMERIC(10,2)`
   - `sinal_percentual_aplicado NUMERIC(5,2)`, `valor_sinal_exigido NUMERIC(10,2)`
   - `status TEXT CHECK (status IN ('rascunho', 'enviado', 'aprovado', 'convertido', 'recusado', 'cancelado', 'expirado'))`
   - `token_publico UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()`
   - `validade_ate TIMESTAMPTZ NOT NULL`, `janela_conversao_limite TIMESTAMPTZ`
   - `aprovado_em TIMESTAMPTZ`, `cliente_observacoes TEXT`, `termos_aceitos BOOLEAN`
   - `pedido_id UUID UNIQUE REFERENCES pedidos(id)`
   - `origem_canal TEXT`, `notas_internas TEXT`, `criado_por UUID`, `atualizado_por UUID`

2. **`orcamento_itens`**:
   - `orcamento_id UUID REFERENCES orcamentos(id) ON DELETE CASCADE`
   - `produto_id UUID REFERENCES produtos(id)`, `produto_nome TEXT`, `quantidade NUMERIC(10,2)`
   - `preco_unitario_snapshot NUMERIC(10,2)`, `pontos_producao_snapshot NUMERIC(10,2)`, `subtotal_snapshot NUMERIC(10,2)`
   - `observacoes TEXT`

3. **`orcamento_item_opcoes`**:
   - `orcamento_item_id UUID REFERENCES orcamento_itens(id) ON DELETE CASCADE`
   - `produto_opcao_id UUID REFERENCES produto_opcoes(id)`
   - `opcao_nome TEXT`, `grupo_nome TEXT`
   - `preco_adicional_snapshot NUMERIC(10,2)`, `pontos_producao_adicionais_snapshot NUMERIC(10,2)`

4. **`orcamento_autorizacoes`**:
   - Registro de exceções comerciais autorizadas (descontos acima da alçada, frete bonificado, conversão fora da janela, etc.)
   - `autorizado_por UUID REFERENCES perfis(id)`, `motivo TEXT NOT NULL`, `tipo_excecao TEXT NOT NULL`

5. **`orcamento_status_historico`**:
   - Auditoria de transições de status (`status_anterior`, `status_novo`, `alterado_por`, `motivo`)

6. **`orcamento_comunicacoes`**:
   - Log de mensagens WhatsApp, envio de links, cópia de espelhos (`canal`, `destinatario`, `template_nome`, `payload`)

### Alteração em `pedidos`
- Adição da coluna `orcamento_origem_id UUID UNIQUE REFERENCES orcamentos(id)`.

---

## 3. Segurança & RLS (Fail-Closed)

Todas as 6 tabelas de orçamentos possuem Row Level Security (RLS) habilitado:
- **Tabelas internas**: políticas restritas a usuários autenticados (`authenticated`) com verificação de papéis autorizados ou serviço (`service_role`).
- **Nenhum acesso anônimo (`anon`) direto**: usuários públicos não possuem privilégios de `SELECT`, `INSERT`, `UPDATE` ou `DELETE` nas tabelas.
- **Acesso Público via RPCs com `SECURITY DEFINER`**:
  - `obter_orcamento_publico(p_token UUID)`:
    - Retorna apenas propostas nos status `'enviado'`, `'aprovado'`, `'convertido'`.
    - **Sanitização estrita**: omite margens, custos, notas internas (`notas_internas`), histórico de exceções e metadados confidenciais.
  - `aprovar_orcamento_publico(p_token UUID, p_aceite_termos BOOLEAN, p_observacoes_cliente TEXT)`:
    - Validação de expiração comercial (`validade_ate >= NOW()`).
    - Idempotência: caso já esteja `aprovado`, retorna confirmação sem duplicar transições.
    - Transição atômica para `aprovado` e definição da `janela_conversao_limite`.

---

## 4. Ciclo de Vida do Orçamento e Conversão

```
[Rascunho]
    │
    ▼ (Enviar ao Cliente)
[Enviado] ─── (Vence validade_ate) ───► [Expirado]
    │                                         │
    ▼ (Cliente aprova via link)               │ (Revalidação comercial)
[Aprovado]                                    ▼
    │ ─── (Vence janela_conversao_limite) ──► [Expirado / Reaberto]
    │
    ▼ (converter_orcamento_em_pedido_admin)
[Convertido] ───► Gera Pedido via nucleo_criar_encomenda()
                  ├── Reserva Estoque (para produtos com controle)
                  ├── Lock e Alocação de Capacidade Produtiva
                  └── Criação do Ledger Financeiro
```

### Regras da Conversão:
1. **Status Elegível**: Apenas orçamentos em status `'aprovado'` podem ser convertidos (ou com override explícito auditado em `orcamento_autorizacoes`).
2. **Janela Operacional**: A conversão deve ocorrer antes de `janela_conversao_limite`. Se ultrapassada, o sistema exige revalidação (`CONVERSION_WINDOW_EXPIRED`).
3. **Reserva Imediata**: A conversão invoca `nucleo_criar_encomenda()`, garantindo que capacidade e estoque sejam alocados no instante exato da conversão.
4. **Imutabilidade**: Se o preço de um insumo subiu após a emissão do orçamento, o pedido gerado honra integralmente o preço cotado constante nos snapshots do orçamento.
5. **Fluxo Financeiro & Contábil no DRE**: Quando um sinal é informado na conversão, o pagamento é registrado com comprovante e método em `pedido_pagamentos`, disparando o trigger `recalcular_financeiro_pedido()` para atualização do saldo e status, e gravando com idempotência estrutural o lançamento de receita (`evento = 'recebimento'`) no DRE (`financeiro_lancamentos`). Em caso de estorno futuro, o fluxo compensatório já encontra a contrapartida contábil exata.

---

## 5. Fichas de Impressão (`@media print`)

O sistema define duas folhas padronizadas no frontend:
1. **Espelho Comercial (`.espelho-comercial`)**:
   - Apresentação elegante e visualmente limpa para o cliente.
   - Cabeçalho institucional Lunoca Confeitaria.
   - Detalhamento de itens, valores unitários, opcionais e subtotais.
   - Frete discriminado (base, cobrado e desconto de frete).
   - Condições de pagamento, valor de sinal exigido, saldo na entrega e chave PIX para depósito.
   - Termos e prazos de validade da proposta.
2. **Ficha de Bancada (`.ficha-bancada`)**:
   - Destinada exclusivamente à linha de produção / cozinha.
   - **Oculta completamente valores monetários, preços e dados de cobrança**.
   - Destaca data e hora da entrega/retirada, tipo de entrega, observações e restrições.
   - Detalhamento minucioso dos produtos, massas, recheios, personalizações e pontos de produção calculados.

---

---

## 7. Reconciliação Arquitetural e Governança

Esta seção documenta formalmente as decisões arquiteturais adotadas no fechamento da Etapa 3 e o alinhamento com a auditoria de segurança:

### 7.1 Defesa em Profundidade no Rate Limit Público (Edge + Database)
- **Camada Edge/WAF (Cloudflare Pages)**: Protege a infraestrutura contra ataques volumétricos e scraping automatizado no endpoint público `/orcamento.html`.
- **Camada Stateful no Banco (`public.orcamento_rate_limits`)**: A RPC `obter_orcamento_publico()` implementa limitação em janela deslizante de 1 minuto diretamente no PostgreSQL (teto de 5 leituras por minuto por token). Tentativas que excedem a janela resultam em bloqueio temporal (`bloqueado_ate = NOW() + INTERVAL '5 minutes'`). Isso assegura resiliência de fail-closed mesmo se a requisição alcançar o banco diretamente ou via ambiente de preview.

### 7.2 Governança de Descontos, Frete e Sinal (D3 / S3 / S3b)
- **Motivo Obrigatório ($\ge 5$ caracteres)**: As funções `politica_desconto()`, `politica_sinal()` e `validar_modalidade_frete()` exigem justificativa com comprimento mínimo de 5 caracteres para concessão de qualquer desconto financeiro, abatimento de taxa de entrega ou dispensa/redução de sinal padrão.
- **Hardening In-Place em `alterar_status_pedido()`**:
  - Em vez de depreciar imediatamente o ramo comercial da RPC genérica em favor de portas isoladas (`cancelar_pedido_equipe()` e `gerenciar_confirmacao_pedido_admin()`), optou-se por **endurecer o ramo comercial diretamente no endpoint existente** para manter compatibilidade com as telas de pedidos e encomendas em produção.
  - **S3**: Operadores são estritamente impedidos de transitar para `confirmado` se `valor_pago < sinal_minimo`. Apenas administradores podem fazê-lo, exigindo motivo auditável ($\ge 5$ caracteres).
  - **S3b**: Operadores são estritamente impedidos de transitar para `cancelado` se `valor_pago > 0` sem estorno financeiro prévio ou definição explícita de `destino_valor = RETENCAO_CANCELAMENTO`.

### 7.3 Estoque de Catálogo e Isolamento de Políticas (Seção 3.4)
- **Proteção Imediata via Trigger (`fn_proteger_estoque_produtos`)**: A Migration 012 implementou barreira no PostgreSQL que impede a mutação de `estoque_reservado` fora de helpers autorizados e bloqueia a alteração de `estoque_fisico` por operadores não-administradores.
- **Roadmap de Catálogo**: A refatoração completa de `js/produtos.js` (remoção do envio de `estoque_qtd`/`controlar_estoque` na edição de dados cadastrais) e a criação de RPC atômica de movimentação (`ajustar_estoque_admin`) ficam desacopladas para a rodada de modernização de Catálogo e Estoque, evitando quebras na edição operacional atual.

