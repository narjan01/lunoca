# Walkthrough - Implementação do Sistema Operacional da Confeitaria Lunoca

Este documento registra a evolução arquitetural e técnica da Lunoca Doceria, desde o hardening de segurança da loja até a transformação em um **Sistema Operacional Completo de Confeitaria** (estilo Nooty).

---

## 🎂 ETAPA 1: Fundação da Encomenda & Confectionery OS Core `[AUDITADA E ENCERRADA ✅]`

### 1. Modelagem Tridimensional do Ciclo de Vida do Pedido
- **Tabela `public.pedidos` expandida e protegida**:
  - `status_comercial`: `'aguardando_confirmacao'`, `'confirmado'`, `'cancelado'`, `'concluido'`.
  - `status_financeiro`: `'nao_pago'`, `'parcialmente_pago'`, `'pago'`, `'estornado'`.
  - `status_operacional`: `'aguardando_producao'`, `'em_producao'`, `'pronto'`, `'saiu_para_entrega'`, `'entregue'`, `'retirado'`, `'cancelado'`.
  - `canal`: `'loja_online'`, `'whatsapp'`, `'balcao'`, `'telefone'`.
  - Campos financeiros atômicos: `subtotal`, `desconto`, `valor_pago`, `saldo`, `sinal_minimo`, `saldo_vencimento`.
  - Campos operacionais: `hora_entrega`, `observacoes_cliente`, `observacoes_internas`.
  - **Flag de Estorno Parcial (`possui_estorno`)**: adicionada coluna `possui_estorno BOOLEAN NOT NULL DEFAULT false` com índice `idx_pedidos_possui_estorno`. Permite à gestão identificar visualmente pedidos com histórico de devolução financeira mesmo quando o status financeiro permanece `'parcialmente_pago'` ou outro.

### 2. Núcleo Canônico de Itens, Catálogo de Opções & Validação Fail-Closed
- **Expansão de `public.pedido_itens`**:
  - `unidade` (ex: `un`, `kg`, `cento`), `preco_base_snapshot`, `preco_adicionais`, `cmv_unitario_snapshot`, `cmv_total_snapshot`, `observacoes`.
- **Catálogo Mestre `public.produto_opcoes`**:
  - Catálogo relacional de opções e adicionais da confeitaria: massas, recheios, tamanhos, decorações (`categoria`, `nome`, `preco_adicional`).
  - Constraint de unicidade: `CONSTRAINT uq_produto_opcao UNIQUE (produto_id, nome)`.
  - RLS configurado: visualização pública para itens ativos e gestão restrita a administradores.
- **Tabela de Snapshots `public.pedido_item_opcoes`**:
  - Vincula opções ao item do pedido: `tipo`, `opcao_nome`, `preco_adicional`.
  - `REVOKE ALL ON public.pedido_item_opcoes FROM PUBLIC, anon, authenticated;` — impede manipulação direta via client-side.
- **Validação Fail-Closed Anti-Spoofing em `criar_pedido()`**:
  - **Pré-validação estrita antes da criação do pedido**: antes de gravar o pedido ou reservar estoque, todas as opções enviadas são verificadas contra o catálogo oficial `produto_opcoes` (e variantes legadas).
  - Caso uma opção seja inválida ou pertença a outro produto, o checkout é imediatamente interrompido com erro estruturado:
    ```json
    {
      "success": false,
      "code": "INVALID_PRODUCT_OPTION",
      "error": "A opção \"...\" não é válida para o item \"...\". Por favor, selecione as opções disponíveis no cardápio.",
      "produto_id": 123,
      "opcao": "..."
    }
    ```
  - Na gravação de `pedido_item_opcoes`, opções não pertencentes disparam `RAISE EXCEPTION 'Opção % não é válida para o produto %'`.
  - O preço adicional da opção é lido **estritamente do banco de dados**, eliminando adulteração de preços pelo navegador.

### 3. Múltiplos Pagamentos (`public.pedido_pagamentos`), Gateway e Índice Limpo
- **Tabela `public.pedido_pagamentos`**:
  - Suporte a múltiplos pagamentos por pedido: sinal/entrada, quitação na entrega ou parcelamento: `valor`, `metodo IN ('pix', 'cartao', 'dinheiro', 'transferencia', 'outro')`, `provider IN ('mercadopago', 'manual', 'caixa')`, `status IN ('pendente', 'aprovado', 'estornado')`, `pago_em`, `registrado_por`, `comprovante_url`.
- **Índice Simplificado e Deduplicação Limpa**:
  - Índice canônico:
    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagamentos_provider_unique 
      ON public.pedido_pagamentos(provider, provider_payment_id) 
      WHERE provider_payment_id IS NOT NULL;
    ```
  - **Pagamentos Manuais**: em `registrar_pagamento_pedido()` e `confirmar_pagamento_pedido(admin_manual)`, o campo `provider_payment_id` é gravado explicitamente como `NULL`. No PostgreSQL, valores `NULL` são considerados distintos entre si para fins de unicidade por padrão, permitindo múltiplos registros com `provider_payment_id = NULL` sem nunca gerarem colisão entre si.
  - **Pagamentos de Gateway**: utilizam o ID real do Mercado Pago e a inferência de conflito limpa:
    ```sql
    ON CONFLICT (provider, provider_payment_id) 
    WHERE provider_payment_id IS NOT NULL 
    DO NOTHING;
    ```
    Isso substitui o predicado frágil anterior (`NOT LIKE 'manual_%'`), garantindo total correspondência com o índice parcial do PostgreSQL.

### 4. Idempotência Estrutural no DRE / `public.financeiro_lancamentos`
- **Modelagem de Rastreabilidade Contábil**:
  - Adicionadas as colunas `origem_tipo TEXT DEFAULT 'manual'`, `origem_id BIGINT` e `evento TEXT` em `public.financeiro_lancamentos`.
  - Índice de unicidade parcial:
    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS uq_financeiro_origem_evento
      ON public.financeiro_lancamentos(origem_tipo, origem_id, evento)
      WHERE origem_id IS NOT NULL AND evento IS NOT NULL;
    ```
- **Lançamento Compensatório no Estorno**:
  - Quando um pagamento aprovado passa para `'estornado'`, o trigger `recalcular_financeiro_pedido()` grava um lançamento de despesa (`tipo = 'despesa'`, `categoria = 'Estornos'`, `origem_tipo = 'pedido_pagamento'`, `origem_id = NEW.id`, `evento = 'estorno'`) com:
    ```sql
    ON CONFLICT (origem_tipo, origem_id, evento) 
    WHERE origem_id IS NOT NULL AND evento IS NOT NULL 
    DO NOTHING;
    ```
- **Lançamento de Recebimento no Gateway e Manual**:
  - Tanto na confirmação de gateway (`confirmar_pagamento_pedido()`) quanto no registro manual (`registrar_pagamento_pedido()`), a receita é inserida com `origem_tipo = 'pedido_pagamento'`, `origem_id = ...`, `evento = 'recebimento'` e `ON CONFLICT (origem_tipo, origem_id, evento) ... DO NOTHING;`.
  - **Dupla Camada de Proteção**: verificação lógica + restrição estrutural física no banco de dados, prevenindo duplicidades em retries simultâneos de webhooks.

### 5. Ciclo de Vida Financeiro Determinístico & Recálculo Atômico
- **Trigger `recalcular_financeiro_pedido()`**:
  - A tabela `pedido_pagamentos` é a **única fonte da verdade financeira**.
  - Soma estritamente pagamentos aprovados (`status = 'aprovado'`) para definir `valor_pago`.
  - Transições de `status_financeiro`:
    - Se `tem_estorno AND valor_pago <= 0` $\to$ `'estornado'`.
    - Se `valor_pago <= 0` $\to$ `'nao_pago'`.
    - Se `saldo <= 0` $\to$ `'pago'`.
    - Caso contrário $\to$ `'parcialmente_pago'`.
  - Atualiza atômica e simultaneamente `valor_pago`, `saldo`, `status_financeiro` e a flag `possui_estorno = v_tem_estorno`.
  - Registra alterações de estado financeiro no histórico auditável `pedido_status_historico`.

### 6. Retrocompatibilidade Legada Somente-Leitura e Lockdown de `UPDATE`
- **Garantia Técnica de Imutabilidade**:
  - `REVOKE INSERT, UPDATE ON public.pedidos FROM PUBLIC, anon, authenticated;`. Nem clientes nem operadores possuem permissão de mutação direta sobre a tabela `pedidos`.
- **Trigger `sincronizar_status_legado_pedido()`**:
  - Executa `BEFORE INSERT OR UPDATE ON public.pedidos FOR EACH ROW`.
  - A coluna legada `status` é estritamente derivada a partir da tríade `(status_comercial, status_financeiro, status_operacional)`. Qualquer valor atribuído manualmente por scripts é sumariamente descartado e sobrescrito.
  - Sincroniza também as colunas legadas `status_pagamento` e `status_producao`.

---

## 🍰 ETAPA 2: Operação Diária & Experiência de Gestão (Confectionery OS Core - Nooty Style) `[AUDITADA E CONCLUÍDA ✅]`

### 1. Desacoplamento da Identidade de Clientes (`public.clientes`)
- **Tabela Canônica de Clientes**:
  - Desacoplada totalmente de `auth.users` e `profiles`: clientes de balcão, WhatsApp e telefone podem ser cadastrados sem conta no Supabase Auth.
  - Vínculo opcional `auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`.
  - Unicidade por telefone normalizado: `uq_clientes_telefone_normalizado ON public.clientes(telefone_normalizado) WHERE telefone_normalizado IS NOT NULL AND telefone_normalizado <> ''`.
  - RLS estrito: equipes gerenciam todos os clientes (`is_admin_or_operator()`); clientes autenticados só visualizam/editam seu próprio registro. `anon` não possui acesso.
  - Vínculo comercial canônico em pedidos: `pedidos.cliente_id_rel BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL` com backfill idempotente a partir de `profiles`.

### 2. Gestão Concorrente de Capacidade & Snapshots Imutáveis de Pontos
- **Imutabilidade Histórica de Carga Produtiva**:
  - `pedido_itens.pontos_producao_snapshot NUMERIC(6,2) NOT NULL DEFAULT 1.00;`
  - `pedido_item_opcoes.pontos_producao_adicionais_snapshot NUMERIC(6,2) NOT NULL DEFAULT 0.00;`
  - `pedido_item_opcoes.produto_opcao_id BIGINT REFERENCES public.produto_opcoes(id) ON DELETE SET NULL;`
  - Congela o peso de produção de massas, recheios e tamanhos no instante do pedido, eliminando alteração retrospectiva caso o produto mude no catálogo.
- **Tabela `public.capacidade_producao` & Anti-Overbooking**:
  - `data DATE NOT NULL UNIQUE`, `capacidade_maxima_pontos NUMERIC(8,2) NOT NULL DEFAULT 30.00`, `bloqueado BOOLEAN NOT NULL DEFAULT false`, `motivo_bloqueio TEXT`.
  - **Inicialização Concorrente**: `INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos) VALUES (...) ON CONFLICT (data) DO NOTHING;`.
  - **Lock Pessimista Serializável**: `SELECT * FROM public.capacidade_producao WHERE data = ... FOR UPDATE;`.
  - **Carga Ocupada Derivada Sem Drift**: calculada em tempo real diretamente da soma de `pontos_producao_snapshot` e adicionais dos itens de pedidos ativos (`status_comercial <> 'cancelado'`). Não há coluna totalizadora mutável em pedidos, prevenindo divergência contábil.
  - Encaixe extraordinário de produção permitido **apenas a administradores** com justificativa obrigatória (`p_forcar_encaixe = true`).

### 3. Reagendamento com Ordenação Anti-Deadlock (`reagendar_encomenda_admin`)
- **Prevenção Concorrente de Deadlocks Bidirecionais**:
  - Ao reagendar uma encomenda da data A para a data B, as datas são travadas em ordem determinística usando:
    ```sql
    v_primeira_data := LEAST(v_data_antiga, p_nova_data);
    v_segunda_data := GREATEST(v_data_antiga, p_nova_data);
    ```
  - Inicialização concorrente atômica das duas datas antes dos locks:
    ```sql
    INSERT INTO public.capacidade_producao (data, capacidade_maxima_pontos)
    VALUES (v_primeira_data, 30.00), (v_segunda_data, 30.00)
    ON CONFLICT (data) DO NOTHING;
    ```
  - Locks pessimistas ordenados sequencialmente:
    ```sql
    PERFORM 1 FROM public.capacidade_producao WHERE data = v_primeira_data FOR UPDATE;
    PERFORM 1 FROM public.capacidade_producao WHERE data = v_segunda_data FOR UPDATE;
    ```
  - Se dois operadores reagendarem encomendas simultaneamente em sentidos opostos (dia 10 $\to$ 11 e dia 11 $\to$ 10), o PostgreSQL aguarda ordenadamente na mesma fila sem nunca disparar erro de deadlock transacional.

### 4. Governança Comercial de Descontos e Validação de Frete
- **Teto para Operadores**: descontos concedidos por operadores são limitados a no máximo **10%** do subtotal dos produtos.
- **Controle de Administrador**: descontos acima de 10% requerem perfil de administrador e preenchimento de justificativa auditável obrigatória (`p_motivo_desconto`).
- **Validação Estrita de Modalidade**:
  - Retirada no balcão zera automaticamente a taxa de entrega (`v_taxa := 0.00`).
  - Entrega em domicílio exige endereço completo preenchido (`p_endereco_entrega`).

### 5. Ciclo de Confirmação Automática por Sinal e Guarda de Produção em Estornos
- **Confirmação Automática por Sinal Posterior**:
  - Quando os pagamentos acumulados atingem o `sinal_minimo` exigido, o trigger `recalcular_financeiro_pedido` avança automaticamente o `status_comercial` de `'aguardando_confirmacao'` para `'confirmado'`, notificando a cozinha e gravando auditoria.
  - Confirmação sem sinal no ato da encomenda (`p_forcar_confirmacao_sem_sinal`) é privilégio exclusivo de administradores com justificativa registrada.
- **Guarda de Produção em Estornos Financeiros**:
  - Se um sinal sofrer estorno (parcial ou total) reduzindo o valor pago abaixo do mínimo:
    - Se a encomenda ainda estiver na fila de espera (`status_operacional = 'aguardando_producao'`), o status comercial reverte para `'aguardando_confirmacao'`.
    - Se a produção **já tiver sido iniciada** (`'em_producao'`, `'pronto'`, `'saiu_para_entrega'`, `'entregue'`, `'retirado'`) ou se o pedido estiver `'concluido'`, o status comercial **NÃO regride**, preservando a integridade do trabalho já realizado na cozinha e acionando o badge de alerta financeiro.

### 6. Timezone Canônico & Métricas de Caixa pelo Ledger Contábil DRE
- **Fuso Horário Oficial**:
  - Operação e datas ancoradas estritamente em `'America/Fortaleza'`:
    ```sql
    v_hoje DATE := (NOW() AT TIME ZONE 'America/Fortaleza')::DATE;
    ```
- **Métricas do Caixa Diário via DRE**:
  - `obter_resumo_operacao_hoje` consulta o histórico real de lançamentos contábeis em `public.financeiro_lancamentos`:
    - Recebimentos do dia: soma de `tipo = 'receita'`.
    - Estornos do dia: soma de `tipo = 'despesa' AND categoria = 'Estornos'`.
    - Caixa Líquido: `recebimento - estornos`.
  - Garante total fidelidade histórica ao DRE mesmo se pagamentos forem alterados em datas posteriores.

### 7. Interface Operacional Nooty-Style (`admin.html` + `js/admin-operacao.js`)
- **Tela "Hoje" (`#admin-tab-hoje`)**:
  - 4 Cards de métricas operacionais em tempo real: *Encomendas Hoje*, *Total Agendado Hoje*, *Saldo a Receber*, *Caixa Líquido Hoje* (com split de recebimentos e estornos).
  - Alerta operacional para encomendas aguardando confirmação de sinal.
  - Linha do tempo de encomendas ordenada por horário com ações rápidas contextuais.
- **Central de Encomendas Tridimensional (`#admin-tab-pedidos`)**:
  - Barra de busca universal (nome, telefone, nº do pedido, produto).
  - Filtros pills instantâneos: *Todas*, *Hoje*, *Amanhã*, *Pendentes de Sinal*, *Em Produção*, *Prontos*, *Concluídos*.
  - Cards visuais com badges tridimensionais, tags de canal, modalidade de entrega e alerta de estorno.
- **Modal "+ Nova Encomenda Rápida" (`#modal-nova-encomenda`)**:
  - Autocomplete inteligente de clientes cadastrados via RPC `buscar_clientes_admin`.
  - Seleção de canal (Balcão, WhatsApp, Telefone) e modalidade (Retirada vs Entrega).
  - Seleção de produtos do catálogo com opções dinâmicas do banco.
  - Cálculo de subtotal, frete, desconto com validação de perfil e sinal mínimo sugerido (50%).
  - Entrada/sinal gravado diretamente via RPC transacional `criar_encomenda_admin`.
- **Modal "Registrar Pagamento de Saldo" (`#modal-registrar-pagamento`)**:
  - Quitação de saldo com seleção de método (PIX, Dinheiro, Cartão) e recálculo atômico imediato.
- **Modal "Reagendar Encomenda" (`#modal-reagendar-encomenda`)**:
  - Reagendamento com validação de capacidade da nova data e justificativa obrigatória.
- **WhatsApp 1-Clique**:
  - Geração de mensagem formatada completa com resumo da encomenda, itens, data, horário e situação financeira para envio direto ao cliente.
- **Acesso Operacional Expandido**:
  - Operadores agora acessam as abas operacionais do dia a dia: `Hoje`, `Pedidos`, `Calendário`, `Produtos`, `Estoque` e `Ficha Técnica`.
  - Abas sensíveis e de credenciais (`Financeiro`, `Usuários`, `Mercado Pago`, `WhatsApp`) permanecem restritas exclusivamente a Administradores.

### 8. Fechamento Definitivo & Concorrência Completa (Migration 011 - PR #1 Merge ✅)
- **Tabela Singleton `public.configuracoes_operacao`**:
  - Centraliza `timezone` (`America/Fortaleza`), `hold_horas_padrao` (24h), `antecedencia_confirmacao_horas` (2h), `hold_pix_loja_minutos` (30 min), `capacidade_padrao_pontos` (30 pts) e `sinal_percentual_padrao` (50%).
  - Função segura `obter_config_operacao()` com fallback defensivo.
- **Reserva de Estoque Granular por Item (`Opção A`)**:
  - Colunas `reserva_estoque_ativa BOOLEAN` e `reserva_ciclo INT` em `public.pedido_itens`.
  - Helpers atômicos `reservar_estoque_itens_pedido()` e `liberar_estoque_itens_pedido()`.
  - Invariante rigorosa mantida em todo o ciclo:
    $$\text{produtos.estoque\_reservado} = \sum \text{pedido\_itens.quantidade (onde reserva\_estoque\_ativa = true)}$$
  - Validação agregada por produto (`SUM(quantidade)`) prevenindo bypass por divisão em múltiplas linhas.
- **Pipeline Unificado de Expiração & Cloudflare Worker**:
  - RPC canônica `expirar_pedidos_e_holds()` com processamento em lote via `ORDER BY id FOR UPDATE SKIP LOCKED`.
  - Diferenciação precisa de cenários:
    - `valor_pago <= 0`: cancelamento comercial imediato (`cancelado_por_expiracao = true`) e liberação total de estoque e capacidade.
    - `valor_pago > 0`: liberação de estoque e capacidade da cozinha, sem cancelamento destrutivo, sinalizando `requer_revisao_financeira = true`.
  - Worker dedicado `workers/cron-expire-orders/` com acionamento periódico via Cloudflare Cron Triggers (`scheduled()`) e endpoint seguro `/api/cron/expire-orders` (autenticação Bearer `CRON_SECRET` fail-closed).
- **Pagamento Tardio & Revalidação Dupla**:
  - Quando um pagamento compensa após a expiração do hold, o trigger `recalcular_financeiro_pedido()` executa bloqueio pessimista ordenado:
    $$\text{pedido} \longrightarrow \text{capacidade\_producao} \longrightarrow \text{produtos (ORDER BY id ASC)}$$
  - Caso haja capacidade e estoque, a encomenda é confirmada e as reservas são recriadas com novo ciclo (`reserva_ciclo + 1`).
  - Caso falte capacidade ou estoque físico, o pedido permanece em `aguardando_confirmacao`, sendo sinalizado com `bloqueado_por_overbooking_tardio = true` e `requer_revisao_financeira = true`.
- **Resolução Administrativa de Revisão (`resolver_revisao_encomenda_admin`)**:
  - Exclusiva para administradores com justificativa obrigatória ($\ge 5$ caracteres).
  - Ações suportadas:
    - `ESTENDER_HOLD`: revalida estoque e capacidade e estabelece novo prazo.
    - `CONFIRMAR_COM_OVERRIDE`: permite override estritamente sobre capacidade operacional; estoque físico insuficiente é estritamente bloqueado.
    - `ESTORNAR_E_CANCELAR`: invoca o fluxo canônico de estornos com lançamento compensatório no DRE e cancela o pedido.
    - `CANCELAR`: efetua cancelamento com retenção explícita de valores (`RETENCAO_CANCELAMENTO`).
- **Governança Server-Side do Sinal Mínimo**:
  - Operadores não conseguem reduzir o sinal abaixo do percentual configurado.
  - Reduções de sinal ou confirmações sem sinal exigem privilégio de administrador e motivo auditado no servidor.
  - Encomendas para entrega imediata cuja antecedência já foi ultrapassada exigem pagamento integral no ato (`IMMEDIATE_CONFIRMATION_REQUIRED`).
- **Loja Online Alinhada**:
  - `criar_pedido()` grava snapshots de pontos de produção no item e em `pedido_item_opcoes` (`produto_opcao_id` + `pontos_producao_adicionais_snapshot`).
  - Frontend da loja deriva o prazo de pagamento estritamente de `expires_at` retornado pelo backend, com timer visual e expiração confirmada pelo servidor.
- **Pipeline de Build SQL Automatizado**:
  - Script determinístico `scripts/build-sql.mjs` que consolida `sql/baseline/` e as migrations em `sql/install.sql` e `sql/schema.sql`.

---

## 📜 ETAPA 3: Orçamentos Formais, Espelho de Impressão, Proposta Pública & Conversão Transacional `[AUDITADA E CONCLUÍDA ✅]`

### 1. Isolamento Rigoroso da Loja Online & Desacoplamento de Capacidade/Estoque
- **Isolamento da Loja Online**:
  - O fluxo da loja (`criar_pedido`) continua desacoplado com checkout imediato, pagamento PIX e hold temporário de minutos.
  - A criação administrativa e a conversão de orçamentos convergem no núcleo `nucleo_criar_encomenda()`.
- **Orçamento sem Consumo Prematuro de Recursos**:
  - Propostas em `rascunho`, `enviado` ou `aprovado` **NUNCA reservam capacidade produtiva ou estoque de insumos**.
  - A alocação só acontece de forma transacional e atômica no momento exato em que o operador clica em "Converter em Encomenda" (`converter_orcamento_em_pedido_admin`).
- **Eliminação de `p_is_admin`**:
  - Todas as funções e políticas comerciais inspecionam o papel diretamente via token JWT autenticado (`auth.uid()`) ou perfil cadastrado, impedindo bypass por injeção de parâmetros.

### 2. Modelagem Relacional & Snapshots Imutáveis (Migration `013`)
- **Tabela `public.orcamentos`**:
  - Gestão de ciclo de vida: `rascunho`, `enviado`, `aprovado`, `convertido`, `recusado`, `cancelado`, `expirado`.
  - Governança de prazos: `validade_ate` (prazo do cliente aceitar a proposta) e `janela_conversao_limite` (prazo após o aceite para o operador converter).
  - Unicidade bidirecional estrita com pedidos: `orcamentos.pedido_id UNIQUE REFERENCES pedidos(id)` e `pedidos.orcamento_origem_id UNIQUE REFERENCES orcamentos(id)`.
  - Token público de aprovação: `token_publico UUID UNIQUE NOT NULL DEFAULT gen_random_uuid()`.
  - Snapshots financeiros: `valor_subtotal`, `valor_frete_base`, `valor_frete_cobrado`, `desconto_frete`, `valor_desconto`, `valor_total`, `sinal_percentual_aplicado`, `valor_sinal_exigido`.
- **Tabelas de Itens e Opções com Snapshots**:
  - `orcamento_itens`: `quantidade`, `preco_unitario_snapshot`, `pontos_producao_snapshot`, `subtotal_snapshot`.
  - `orcamento_item_opcoes`: `preco_adicional_snapshot`, `pontos_producao_adicionais_snapshot`, `produto_opcao_id`.
  - **Garantia de Preço Travado**: na conversão para pedido, os valores cobrados são estritamente os snapshots do orçamento, independentemente de reajustes futuros no catálogo.
- **Tabelas de Apoio & Auditoria**:
  - `orcamento_autorizacoes`: auditoria de exceções comerciais autorizadas por gerência.
  - `orcamento_status_historico`: rastreamento imutável de transições de status.
  - `orcamento_comunicacoes`: log de envio de mensagens no WhatsApp e links gerados.

### 3. RLS Fail-Closed & RPCs Públicas Sanitizadas
- **RLS Rigoroso**:
  - Todas as 6 tabelas de orçamentos com RLS ativo. Acesso direto negado a usuários públicos (`anon`).
- **RPC `obter_orcamento_publico(p_token)`**:
  - Execução `SECURITY DEFINER` com `search_path = public, auth`.
  - Retorna dados higienizados para o cliente: oculta notas internas, custos, margens e dados técnicos.
- **RPC `aprovar_orcamento_publico(p_token, p_aceite_termos, p_observacoes_cliente)`**:
  - Valida data de validade (`validade_ate >= NOW()`).
  - Idempotente: se já estiver aprovado, retorna sucesso sem duplicar eventos.
  - Transiciona para `aprovado`, grava `cliente_aceite_em = NOW()` e estabelece `janela_conversao_limite` (24 horas).

### 4. Conversão Transacional para Pedido (`converter_orcamento_em_pedido_admin`)
- **Regras de Negócio**:
  - Valida status `aprovado` e vigência de `janela_conversao_limite`.
  - Transfere snapshots para a invocação de `nucleo_criar_encomenda()`.
  - Aloca capacidade produtiva (`travar_capacidade_data`), reserva estoque para produtos controlados e inicializa o pedido.
  - Transiciona atomicamente o orçamento para `convertido` vinculando `pedido_id` e `orcamento_origem_id`.

### 5. Expiração Unificada no Cron
- **Endpoint `/api/cron/expire-orders`**:
  - Protegido por `Bearer <CRON_SECRET>` fail-closed.
  - Invoca em bloco `expirar_pedidos_e_holds()` e `expirar_orcamentos()`.
  - `expirar_orcamentos()` utiliza `SELECT ... FOR UPDATE SKIP LOCKED` para orçamentos com `validade_ate < NOW()`, transicionando para `'expirado'` com registro no histórico.

### 6. Espelho Comercial e Ficha de Bancada (`@media print`)
- **Folhas de Impressão Especializadas**:
  - `.folha-impressao`: formatação A4 limpa e profissional com regras de quebra de página (`page-break-inside: avoid`).
  - `.espelho-comercial`: foco comercial para o cliente, contendo cabeçalho Lunoca, descrição de produtos, cálculo do sinal conforme a política configurada, saldo na entrega, dados de entrega e instruções PIX.
  - `.ficha-bancada`: foco exclusivamente técnico para a confeiteira/cozinha, detalhando massas, recheios, tema, pontos de produção, data e hora da festa, **sem qualquer menção a valores monetários ou dados de pagamento**.

### 7. Interface Web & Backoffice Administrativo
- **Página Pública do Cliente (`orcamento.html` + `js/orcamento-publico.js`)**:
  - Design visual doce e acolhedor (estética Lunoca em tons de lavanda, ameixa e ouro suave).
  - Resumo de itens, personalizações, frete e sinal.
  - Botão de aprovação instantânea com aceite de termos e campo para observações finais.
  - Alerta dinâmico de expiração com contagem de prazo restante.
- **Módulo de Orçamentos no Painel Admin (`admin.html` + `js/admin-orcamentos.js`)**:
  - Nova aba `Orçamentos` integrada ao RBAC de operadores.
  - Listagem com busca, filtros de status (*Rascunho, Enviado, Aprovado, Convertido, Expirado*).
  - Modal de elaboração de propostas com seleção dinâmica de produtos e opcionais.
  - Botão de envio rápido de link via WhatsApp com mensagem pré-formatada.
  - Modal de conversão para pedido com opções de pagamento de sinal e confirmação imediata.
  - Visualização e impressão direta de Espelho Comercial e Ficha de Bancada.

---

## 🧪 Verificação & Testes de Hardening

Execução do conjunto completo de testes automatizados:

```bash
npm run lint:syntax
npm run check:sql
npm run test:structural
python scripts/run-pg-test.py  # 47/47 testes de integração em PostgreSQL 18.4 real
```

### Resultados das Fases de Teste:
- **Fases 1–10**: 100% aprovadas (fundação de segurança, RBAC, auditoria, estornos, fail-closed).
- **Fases 11.1–11.12**: 100% aprovadas (clientes desacoplados, capacidade, anti-overbooking, reagendamento, DRE, UI Hoje).
- **Fases 11.13–11.21**: 100% aprovadas (reserva por item, pipeline único de expiração, revisão financeira, configurações centrais).
- **Fase 12**: 100% aprovada (paridade canônica de `sql/install.sql` e `sql/schema.sql` com migrations e baseline).
- **Fase 13: Etapa 3 - Orçamentos, Proposta Pública & Conversão Comercial**:
  - `13.1`: Tabelas `orcamentos`, `orcamento_itens`, `orcamento_item_opcoes`, constraints de unicidade bidirecional `[APROVADO ✅]`
  - `13.2`: RLS fail-closed nas tabelas de orçamentos sem acesso anônimo direto `[APROVADO ✅]`
  - `13.3`: RPCs de ciclo de vida, expiração e aprovação registradas `[APROVADO ✅]`
  - `13.4`: Isolamento e sanitização de `obter_orcamento_publico` e `aprovar_orcamento_publico` `[APROVADO ✅]`
  - `13.5`: `expirar_orcamentos` com concorrência segura via `FOR UPDATE SKIP LOCKED` `[APROVADO ✅]`
  - `13.6`: `converter_orcamento_em_pedido_admin` com snapshots imutáveis e núcleo compartilhado `[APROVADO ✅]`
  - `13.7`: Frontend, documentos e integração com cron unificado validados `[APROVADO ✅]`
  - `13.8`: Integridade contábil do sinal no núcleo e RLS público de orçamentos `[APROVADO ✅]`

### Suíte de Integração PostgreSQL Real (47/47 Verde):
- **Gate 1 (Etapa 2 - 27 Cenários)**: Concorrência, overbooking tardio, holds dinâmicos, resolução de revisão financeira, DRE contábil, isolamento de loja online `[27/27 PASSADOS ✅]`
- **Gate 2 (Etapa 3 - 20 Cenários E3-1 a E3-20)**: Desacoplamento pré-conversão, sanitização pública, aprovação idempotente, janela de 24h, corrida de estoque na conversão, invalidação de versões, rate limiting, RLS fail-closed, concorrência transacional `[20/20 PASSADOS ✅]`
- **Total**: `47 tests passed, 0 failed, exit code 0`

---

## 📋 Arquivos Criados e Modificados na Etapa 3

- [`supabase/migrations/011_etapa2_fechamento_concorrencia.sql`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/supabase/migrations/011_etapa2_fechamento_concorrencia.sql) `[AJUSTES DE RLS E CONCORRÊNCIA]`
- [`supabase/migrations/012_hardening_politicas_e_nucleo.sql`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/supabase/migrations/012_hardening_politicas_e_nucleo.sql) `[MIGRATION ETAPA 3 NÚCLEO & PROTEÇÃO DE ESTOQUE]`
- [`supabase/migrations/013_etapa3_orcamentos_conversao_comercial.sql`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/supabase/migrations/013_etapa3_orcamentos_conversao_comercial.sql) `[MIGRATION ETAPA 3 ORÇAMENTOS & RATE LIMITING]`
- [`sql/install.sql`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/sql/install.sql) `[RECOMPILADO CANÔNICO - 8000 LINHAS]`
- [`sql/schema.sql`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/sql/schema.sql) `[RECOMPILADO CANÔNICO - 8000 LINHAS]`
- [`functions/api/cron/expire-orders.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/functions/api/cron/expire-orders.js) `[CRON UNIFICADO PEDIDOS + ORÇAMENTOS]`
- [`orcamento.html`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/orcamento.html) `[PROPOSTA PÚBLICA DO CLIENTE]`
- [`js/orcamento-publico.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/js/orcamento-publico.js) `[CONTROLLER DA PROPOSTA PÚBLICA]`
- [`admin.html`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/admin.html) `[ABA ORÇAMENTOS, MODAIS DE CRIAÇÃO, CONVERSÃO E IMPRESSÃO]`
- [`js/admin-orcamentos.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/js/admin-orcamentos.js) `[CONTROLLER DE BACKOFFICE DE ORÇAMENTOS]`
- [`js/admin.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/js/admin.js) `[RBAC OPERACIONAL PARA ORÇAMENTOS]`
- [`js/admin-loader.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/js/admin-loader.js) `[LOADER DINÂMICO DE SCRIPTS]`
- [`css/style.css`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/css/style.css) `[FOLHAS DE ESTILO DE IMPRESSÃO A4]`
- [`docs/ARQUITETURA_ETAPA3.md`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/docs/ARQUITETURA_ETAPA3.md) `[DOCUMENTAÇÃO ARQUITETURAL VINCULANTE]`
- [`tests/integration/etapa2.integration.test.mjs`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/tests/integration/etapa2.integration.test.mjs) `[27 CENÁRIOS DE REGRESSÃO ETAPA 2]`
- [`tests/integration/etapa3.integration.test.mjs`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/tests/integration/etapa3.integration.test.mjs) `[20 CENÁRIOS DE INTEGRAÇÃO ETAPA 3]`
- [`scripts/run-pg-test.py`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/scripts/run-pg-test.py) `[RUNNER DESPRIVILEGIADO EM WINDOWS]`
- [`test-hardening.js`](file:///C:/Users/narjan.andrade/.gemini/antigravity/scratch/lunoca/test-hardening.js) `[FASE 13 INTEGRADA - 100% VERDE]`

---

## 🏆 Status Atual do Sistema

| Etapa | Descrição | Status |
|---|---|:---:|
| **Etapa 1** | Fundação Tridimensional, DRE Contábil, Catálogo de Opções & Anti-Spoofing | **AUDITADA E ENCERRADA ✅** |
| **Etapa 2** | Operação Diária (Tela Hoje, Encomendas Nooty, Capacidade, Hold & Concorrência) | **AUDITADA E CONCLUÍDA ✅** |
| **Etapa 3** | Orçamentos Formais, Espelho/Impressão, Proposta Pública & Conversão Transacional | **AUDITADA E CONCLUÍDA ✅** |
