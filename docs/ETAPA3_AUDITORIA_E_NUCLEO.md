# Etapa 3 — Passo 0: auditoria e contrato do núcleo canônico

Status: **somente leitura e desenho. Nenhum código transacional foi alterado.**
Baseline do código auditado: `main` @ `0343058` (merge do PR #1, Etapa 2 pós-merge, migration 011 presente).

> **Gate de implementação.** Nenhuma alteração em `criar_encomenda_admin`,
> `reservar_estoque_itens_pedido`, `recalcular_financeiro_pedido`, locks/capacidade ou
> `pedido_pagamentos` (nem a migration `012_orcamentos_conversao_comercial.sql`) começa antes de
> `npm ci && npm test` verde em ambiente limpo, com a integração PostgreSQL real.
> O `npm` do sandbox usado nesta auditoria falhou ("Exit handler never called"), então a
> integração **não foi executada** aqui. Tudo abaixo vem de leitura de código; itens marcados
> **[provar]** precisam de teste real antes de virar premissa.

Notação de severidade: **ALTA** = permite contornar regra financeira/operacional por chamada de API;
**MÉDIA** = regra incompleta ou inconsistente; **BAIXA/OBS** = decisão de negócio ou higiene.

---

## 1. Auditoria de governança — sinal

| # | Resultado | Evidência | Observação |
|---|---|---|---|
| S1 | OK | `011:690` (`GREATEST(v_sinal_padrao, p_sinal_minimo)` para operador); `011:699-702` (`p_forcar_confirmacao_sem_sinal` negado a não-admin); teste `R2-2` | Operador não reduz o sinal por parâmetro manipulado. O frontend envia `null` para operador (`js/admin-operacao.js:714`), mas o servidor não depende disso. |
| S2 | OK com ressalva | `011:679-688` (`SIGNAL_REDUCTION_REQUIRES_REASON`), `011:703` | Redução administrativa exige justificativa, porém: (a) mínimo de **3** caracteres, enquanto `resolver_revisao_encomenda_admin` exige 5 (`011:1317`); (b) o motivo trafega no parâmetro `p_motivo_confirmacao_sem_sinal`, nome que sugere outra coisa, e só fica em `metadata` do histórico (`011:880`), sem campo próprio. |
| S3 | **ALTA** | `009:431-559` (`alterar_status_pedido`, ramo `comercial`), `GRANT ... TO authenticated` em `009:562`; único trigger em `pedidos` é o de cancelamento (`011:396`) | Operador pode chamar `alterar_status_pedido(id,'comercial','confirmado')` em pedido `aguardando_confirmacao` **sem checar sinal, hold, capacidade nem revisão financeira**. Consequência adicional: pedidos com `requer_revisao_financeira` ou `bloqueado_por_overbooking_tardio`, que só o admin resolve (`011:1305-1306`), podem ser confirmados pelo operador. A UI atual só usa a dimensão `operacional` (`js/admin-operacao.js:884`), logo é uma brecha de **API**, não de tela. **[provar]** |
| S3b | **ALTA** | mesmo ramo `comercial` → `cancelado` | Operador cancela pedido com `valor_pago > 0` sem destino do valor, enquanto `resolver_revisao_encomenda_admin` exige `DESTINO_VALOR_OBRIGATORIO` (`011:1445`). O trigger de cancelamento libera a reserva, mas o dinheiro fica sem decisão. **[provar]** |
| S4 | MÉDIA | `009:713-730` (`estornar_pagamento_pedido`), `p_motivo DEFAULT NULL` | Operador estorna qualquer pagamento aprovado, com motivo opcional. Relevante para o desenho de `CREDITO_CLIENTE`. |
| S5 | OBS (negócio) | `p_sinal_comprovante` opcional; `registrar_pagamento_pedido` com `p_comprovante_url` opcional (`009:565`) | Operador pode declarar sinal pago sem evidência e com isso confirmar o pedido. Definir se `pix`/`transferencia` exigem comprovante. |

## 2. Auditoria de governança — desconto

| # | Resultado | Evidência | Observação |
|---|---|---|---|
| D1 | OK | `011:657` | Teto de 10% do subtotal para não-admin, calculado no servidor com preços do banco. |
| D2 | MÉDIA | `011:657`, `011:660` | `0.10` está **hardcoded**. O orçamento precisa da mesma regra; duplicar o literal cria a "rota alternativa de bypass" quando alguém mudar um lado só. Mover para `configuracoes_operacao` e consumir por função compartilhada. |
| D3 | MÉDIA | `011:664` (`... AND public.is_admin()`) | Justificativa de desconto é exigida **só do admin**; o operador concede até 10% sem motivo. Provavelmente invertido em relação à intenção. Exigir motivo para qualquer desconto > 0, em qualquer papel. |
| D4 | MÉDIA | `011:535` (`v_taxa := GREATEST(0, p_taxa_entrega)`) | Taxa de entrega é livre. Operador zera o frete = desconto fora do teto. Opções: taxa derivada de tabela no servidor, ou tratar `(taxa de tabela − taxa informada)` como desconto sujeito ao teto. Decisão de negócio. |
| D5 | OBS | `is_admin()` retorna `true` para `service_role` (`009:402-410`) | Qualquer chamada via `service_role` (worker, função serverless) passa como admin. O núcleo nunca deve receber o papel do chamador por parâmetro; deve derivá-lo de `auth` e tratar `service_role` explicitamente. |

## 3. Mapa de escritas em `public.produtos`

Política atual: operador **e** admin fazem INSERT/UPDATE (`sql/install.sql:1585`, `:1590`); só admin faz DELETE (`:1595`).

### 3.1 Escritas diretas pelo navegador (as únicas afetadas por endurecer o RLS)

| Origem | Campos | Categoria | Problema |
|---|---|---|---|
| `js/produtos.js:403` (UPDATE) | `nome, preco, descricao, opcoes, img_url` **+** `estoque_qtd, estoque_minimo, controlar_estoque` | **mista** | Ver P1 e P3. |
| `js/produtos.js:418` (INSERT) | idem + estoque inicial | **mista** | Estoque inicial entra sem movimentação. |
| `js/estoque.js:216` `ajustarEstoqueRapido` | `estoque_qtd` | estoque | Valor absoluto calculado no cliente a partir de dado possivelmente velho (P1); movimentação gravada em seguida pelo cliente (P2). |
| `js/estoque.js:300` ajuste de inventário | `estoque_qtd, estoque_minimo, controlar_estoque` | estoque | Idem; `controlar_estoque` é chave de **política** (P3). |
| `js/estoque.js:466` `darBaixaEstoqueAposPedido` | `estoque_qtd` | estoque | **Código morto**: nenhum chamador em `js/`, `admin.html`, `index.html` ou `functions/`. Remover. |

Não encontrei na UI escrita de `ativo`, nem DELETE de produto. `produto_opcoes` só é lida pelo frontend (`js/admin-operacao.js:464`); a policy `FOR ALL` para operador (`009:106-108`) **não é usada por nenhuma tela** e pode ser fechada sem quebrar nada. `ingredientes` e `produto_ingredientes` já são admin-only (`005:284-293`) e saem da lista de endurecimento.

### 3.2 Escritas dentro do banco (não afetadas por RLS)

Funções `SECURITY DEFINER` e triggers: `reservar_estoque_itens_pedido` (`011:280`), `liberar_estoque_itens_pedido` (`011:347`), `expirar_pedidos_e_holds` (`011:994`), `confirmar_pagamento_pedido` (`009:1406`), `sincronizar_estoque_produto` (trigger, `003:19-36`). **[provar]** que continuam funcionando com a tabela fechada para `authenticated` (dono da função contorna RLS, salvo `FORCE ROW LEVEL SECURITY`).

### 3.3 Achados

- **P1 — ALTA — corrupção de estoque físico por escrita obsoleta.** O trigger (`003:23-25`) interpreta `UPDATE` de `estoque_qtd` com `estoque_fisico` inalterado como "ajuste manual" e faz `estoque_fisico := estoque_qtd + estoque_reservado`. O formulário de produto sempre reenvia `estoque_qtd` (`js/produtos.js:389,403`). Exemplo: painel carregado com `estoque_qtd = 10` (físico 10, reservado 0); uma encomenda reserva 3 (qtd 7); o admin salva só um novo preço com o campo ainda em 10 → `estoque_fisico` vira 13. Editar **catálogo** passa a inflar estoque. **[provar]**
- **P2 — MÉDIA — trilha de estoque feita pelo cliente e provavelmente perdida.** `estoque.js:223` e `:311` gravam `estoque_movimentacoes` pelo navegador, com `usuario_nome` livre e `saldo_resultante` calculado no cliente, em duas chamadas não atômicas. Em `install.sql` a tabela tem RLS ligado e **só** policy de SELECT (`install.sql:1536`, `:2074`), sem policy de INSERT; o resultado do insert não é verificado. Se confirmado, o ajuste de estoque acontece **sem movimentação gravada**. **[provar]**
- **P3 — MÉDIA — operador desliga o controle de estoque.** `controlar_estoque` é editável por operador (`estoque.js:300`, `produtos.js:403`). Como a reserva só vale para `controlar_estoque = true`, desligar a chave contorna a reserva e o `INSUFFICIENT_STOCK`.

### 3.4 Caminho recomendado (ordem obrigatória, para não quebrar a operação)

1. **RPC `ajustar_estoque_admin`** (`SECURITY DEFINER`, admin ou operador): trava a linha do produto (`FOR UPDATE`); opera por **delta** sobre `estoque_fisico` (`entrada`, `saida`, `perda`) ou por contagem (`ajuste_contagem`, saldo físico absoluto, com retorno do valor anterior); rejeita `estoque_fisico < estoque_reservado` (`RESERVED_STOCK_CONFLICT`); grava a movimentação **no servidor**, na mesma transação, com `auth.uid()` e o nome do perfil; `estoque_minimo` por operador ou admin; alternar `controlar_estoque` **somente admin**, com motivo, e bloqueado se houver reserva ativa.
2. **Frontend:** `estoque.js` passa a chamar a RPC; `produtos.js` **para de enviar** `estoque_qtd/minimo/controlar_estoque` no salvamento de catálogo (estoque inicial de produto novo também via RPC); remover `darBaixaEstoqueAposPedido`.
3. **Só então** a migration de RLS: INSERT/UPDATE/DELETE de `produtos` e escrita de `produto_opcoes` somente admin; SELECT permanece como está.
4. **Testes reais:** operador não faz UPDATE direto em `produtos`; admin faz; operador ajusta estoque pela RPC; invariante `estoque_fisico >= estoque_reservado`; invariante final de reservas (`etapa2.integration.test.mjs:847`) segue verde; RPCs de reserva continuam funcionando com a tabela fechada.

---

## 4. Contrato do núcleo canônico de criação de encomenda

### 4.1 Forma

```
criar_encomenda_admin(...)                 converter_orcamento_em_encomenda(...)
   (assinatura atual preservada)              (RBAC, lock do orçamento, idempotência)
              \                                       /
               →  public.nucleo_criar_encomenda(p_in JSONB)  ←
                  (interna: REVOKE de PUBLIC/anon/authenticated;
                   chamada só por funções SECURITY DEFINER do mesmo dono)
```

- O núcleo **deriva o ator de `auth.uid()`/`is_admin()`**; nunca recebe papel, usuário ou preço "pronto" do chamador.
- Os dois chamadores só fazem o que é específico deles (RBAC de entrada, resolução de entrada, vínculo com orçamento) e entregam um `p_in` já normalizado.
- `criar_pedido` (loja online) **fica fora**: regras de guest, hold de PIX e snapshot de carrinho são outras. Compartilha apenas `reservar_estoque_itens_pedido`.

### 4.2 Pipeline (ordem fixa)

```
 1  entrada estruturada validada        (sem lock, sem escrita)
 2  cliente resolvido/cadastrado        (única escrita antes dos locks; ver 4.5)
 3  produtos/opções carregados          preço pelo modo (4.3), pontos, subtotal
 4  política de desconto                função compartilhada (4.4)
 5  política de sinal                   função compartilhada (4.4)
 6  hold / entrega imediata             mesmo cálculo de 011:714-731
 7  LOCKS, ordem global                 orçamento → capacidade(data) → produtos(id ASC)
 8  capacidade                          ou encaixe admin justificado
 9  pedido + itens + opções             snapshots; invariante soma(itens)=subtotal
10  reserva de estoque                  fail-closed; RAISE desfaz tudo
11  sinal → pedido_pagamentos           trigger recalcula; DRE idempotente
12  auditoria                           histórico com origem (admin | orçamento #)
```

Regra de falha: **antes da primeira escrita** (passos 1–8) o núcleo devolve `{success:false, code, ...}`; **depois dela** (passos 9–12) qualquer falha é `RAISE EXCEPTION`, para que a transação inteira desfaça. É o padrão que `criar_encomenda_admin` já usa no passo de reserva.

### 4.3 Preço: modo explícito

`preco_modo ∈ { 'catalogo_atual', 'snapshot_orcamento' }`.

- `catalogo_atual`: preço base e adicional lidos de `produtos`/`produto_opcoes` agora (comportamento atual).
- `snapshot_orcamento`: o núcleo recebe **apenas o `orcamento_id`** e relê `orcamento_itens`/`orcamento_item_opcoes` ele mesmo. O JSON do chamador nunca carrega preço. Viabilidade (produto ativo, opção válida, estoque, capacidade) continua sendo avaliada no **estado atual**.

### 4.4 Políticas compartilhadas (a regra existe uma vez)

- `politica_desconto(subtotal, desconto, motivo)`: teto de operador vindo de `configuracoes_operacao` (hoje `0.10` literal), motivo obrigatório para qualquer desconto > 0 (se aprovado o item D3).
- `politica_sinal(total, minimo_solicitado, forcar_sem_sinal, motivo)`: devolve `{sinal_minimo, sinal_padrao, reduzido}`; operador nunca abaixo do padrão; redução só admin com motivo (mínimo 5).
- **`criar_orcamento_admin` e `revisar_orcamento_admin` chamam as mesmas duas funções.** Assim não existe rota de orçamento que conceda mais que a encomenda direta.
- **Conversão:** as políticas são reaplicadas com o papel de **quem converte**. Para um operador converter um orçamento que um admin criou com desconto > 10% ou sinal reduzido, o orçamento guarda `desconto_aprovado_por` / `sinal_reducao_aprovada_por` (+ motivo), preenchidos **somente** pelo caminho admin. O núcleo honra a exceção só se esse registro existir no orçamento (lido pelo próprio núcleo); caso contrário, aplica `max(snapshot, padrão vigente)`.

### 4.5 Locks e consistência

- Ordem global única: **orçamento → capacidade da data → produtos (id crescente, sem duplicar) → pedido**. É a mesma ordem documentada em `011:431-432` e usada em `011:735-737`; qualquer RPC nova que trave mais de um recurso segue esta ordem.
- Cliente: o `INSERT` em `clientes` hoje acontece antes dos locks; se a transação falhar depois, o rollback desfaz. Aceitável, mas o núcleo recebe `cliente_id` já resolvido pelo chamador para não cadastrar cliente dentro de região travada.
- Conversão chama o núcleo dentro de um bloco `BEGIN ... EXCEPTION`: um `RAISE` do núcleo desfaz pedido/itens/reserva (subtransação) e o conversor devolve `QUOTE_CONVERSION_BLOCKED` com o orçamento **intacto** em `aprovado`.

### 4.6 Contratos do conversor (decisões já tomadas + o que proponho)

| Tema | Contrato |
|---|---|
| Idempotência | `SELECT ... FROM orcamentos WHERE id = $1 FOR UPDATE`; se `pedido_id IS NOT NULL` devolve o pedido existente (`idempotente:true`). `UNIQUE(orcamentos.pedido_id)` como segunda barreira. |
| Estado de entrada | só `aprovado`. `convertido` → idempotente; demais → `QUOTE_NOT_CONVERTIBLE`. |
| Aprovação após `validade_ate` | `QUOTE_EXPIRED` (decidido). |
| Conversão de orçamento já aprovado, depois da validade | **Proposta:** vale a data de `aprovado_em` (se `aprovado_em <= validade_ate`, converte); adicionar teto opcional em `configuracoes_comerciais` (`conversao_max_horas_apos_aprovacao`). Depende da sua confirmação. |
| `visualizado` | telemetria apenas; nunca habilita nem bloqueia aprovação/conversão. |
| Falha de viabilidade | `{success:false, code:'QUOTE_CONVERSION_BLOCKED', reasons:[...]}` com razões vindas do núcleo (`INSUFFICIENT_STOCK`, `PRODUCTION_CAPACITY_EXCEEDED`, `INVALID_PRODUCT_OPTION`, `PRODUCT_UNAVAILABLE`, `IMMEDIATE_CONFIRMATION_REQUIRED`); orçamento permanece `aprovado`. |
| Sinal | `sinal_minimo` vem do snapshot do orçamento, sujeito a 4.4. Sinal pago no ato segue o fluxo canônico (`pedido_pagamentos`). |

### 4.7 Refatoração sem mudança de comportamento (primeiro commit transacional)

- Extrair o núcleo mantendo `criar_encomenda_admin` com **a mesma assinatura e as mesmas respostas JSON**; os testes `R2-*` e os de Opção A devem passar **sem edição**.
- Já na extração, **separar os acumuladores**: hoje `v_pts_opt_total` guarda pontos na validação (`011:608,634,643`) e é reutilizado como acumulador de **R$** na gravação dos itens (`011:819`, com o comentário "reutilizado aqui como acumulador de R$"). No núcleo: `v_preco_adicionais_linha` (R$) e `v_pontos_opcoes_linha` (pts), nomes distintos.
- **Mudanças de política vão em commits separados** do refactor puro, para que "verde antes = verde depois" prove a equivalência do refactor: (i) teto de desconto configurável; (ii) motivo de desconto para qualquer papel; (iii) correção do S3/S3b; (iv) RPC de estoque e RLS de `produtos` (seção 3.4).

### 4.8 Testes exigidos antes de aceitar o núcleo (PostgreSQL real)

1. Caracterização: todos os `R2-*` e Opção A inalterados após a extração.
2. Os dois chamadores produzem pedido **estruturalmente idêntico** para a mesma entrada (itens, snapshots, pontos, reserva, sinal, histórico).
3. `soma(pedido_itens.subtotal) = pedidos.subtotal` em encomendas com opções.
4. Operador não reduz sinal nem ultrapassa desconto, **via encomenda direta, via orçamento e via conversão**.
5. Conversão dupla simultânea → um único pedido, mesma resposta.
6. Conversão × venda da loja disputando o último item → nunca `estoque_reservado > estoque_fisico`.
7. Falha de estoque/capacidade na conversão → nada persiste e o orçamento continua `aprovado`.
8. `S3`/`S3b`: operador não confirma sem sinal nem cancela com valor pago sem destino.
9. Preço do orçamento preservado após mudança de preço no catálogo; viabilidade reavaliada.
10. Reaplicação da migration e do `install.sql` idempotentes.

---

## 5. Decisões que dependem de você

1. **D3:** exigir justificativa também do operador em qualquer desconto? (recomendo sim)
2. **D4:** frete livre pelo operador — tabela de taxa no servidor, ou tratar a diferença como desconto sujeito ao teto?
3. **S5:** exigir comprovante para `pix`/`transferencia` no sinal?
4. **S4:** estorno por operador — manter, exigir motivo, ou restringir a admin?
5. **4.6:** conversão depois da validade quando a aprovação foi dentro do prazo (proposta acima).
6. **4.4:** operador pode converter orçamento com exceção previamente aprovada por admin (proposta acima)?

## 6. O que ainda não foi verificado

- Execução real de qualquer teste de integração (ambiente do sandbox falhou).
- **[provar]** S3, S3b, P1, P2 e o item 3.2.
- `criar_pedido` da loja não foi auditado quanto a sinal/desconto (fora do escopo do núcleo).
- Existência e conteúdo de `docs/ARQUITETURA_ETAPA2.md` não foram cruzados com este documento.
