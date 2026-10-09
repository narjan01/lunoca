# Arquitetura — Etapa 2: Fechamento Definitivo & Concorrência Completa

Este documento registra as **decisões arquiteturais vinculantes** da Etapa 2 (migration `011_etapa2_fechamento_concorrencia.sql`). Qualquer fluxo novo que toque pedidos, capacidade ou estoque deve obedecer às regras abaixo.

---

## 1. Decisões consolidadas

| Tema | Decisão |
|---|---|
| **Reserva de estoque** | **Opção A.** `criar_encomenda_admin()` reserva estoque para itens com `produtos.controlar_estoque = true`, como `criar_pedido()` (loja). A fonte da verdade da reserva é `pedido_itens.reserva_estoque_ativa`. **Liberação e recriação só acontecem através dessa flag** (helpers `reservar_estoque_itens_pedido` / `liberar_estoque_itens_pedido`). |
| **Expiração** | **Pipeline único**: `expirar_pedidos_e_holds()` trata PIX da loja (`expires_at`) e holds de encomenda (`confirmacao_expires_at`). `liberar_pedidos_expirados()` é apenas um wrapper de compatibilidade. Endpoint único: `/api/cron/expire-orders` (fail-closed, `CRON_SECRET` obrigatório). |
| **Estorno** | Reutiliza `estornar_pagamento_pedido()` (idempotente; o trigger financeiro gera o lançamento compensatório no DRE). |
| **Override administrativo** | Admin pode forçar **capacidade** (`CONFIRMAR_COM_OVERRIDE`, `p_forcar_encaixe`). **Nunca** estoque inexistente: `INSUFFICIENT_STOCK` é terminal até reposição. |
| **Governança do sinal** | Sinal mínimo padrão = `ROUND(total × sinal_percentual_padrao / 100, 2)` (`configuracoes_operacao`). **Operador nunca reduz** (só aumenta); `p_sinal_minimo` NULL/0 = "não informado" → padrão. **Admin** reduz apenas com justificativa (`p_motivo_confirmacao_sem_sinal`, senão `SIGNAL_REDUCTION_REQUIRES_REASON`); dispensar por completo só via `p_forcar_confirmacao_sem_sinal` (admin + motivo). |
| **Reserva agregada** | `reservar_estoque_itens_pedido` valida **`SUM(quantidade)` por produto** (linhas distintas do mesmo produto não burlam o estoque). As linhas do pedido são preservadas (cada linha = produto + conjunto de opções). |
| **Checkout da loja (`criar_pedido`)** | Mesma modelagem da encomenda: lock de produtos `ORDER BY id` numa única consulta → INSERT pedido → `pedido_itens` por linha com `pontos_producao_snapshot` → `pedido_item_opcoes` com `produto_opcao_id` + `pontos_producao_adicionais_snapshot` → reserva pelo helper. Hold PIX = `hold_pix_loja_minutos` (única fonte). |
| **Cancelamento com valor pago** | Apenas `RETENCAO_CANCELAMENTO` nesta etapa. `CREDITO_CLIENTE` (tabela `creditos_cliente`) fica para migration própria. |
| **SQL** | `supabase/migrations/` é a fonte canônica. `sql/install.sql` e `sql/schema.sql` são **gerados** por `npm run build:sql` a partir de `sql/baseline/` + migrations `> 010`. Nunca edite os gerados. |
| **Testes** | `test-hardening.js` continua como teste **estrutural**. Garantias de concorrência/idempotência são provadas por `npm run test:integration` (PostgreSQL real). |
| **RLS de produtos** | **Não** restringida a admin nesta etapa (operadores têm a aba Produtos). Decisão explícita, pendente de avaliação de produto. |

---

## 2. Ordem global de locks (regra arquitetural)

```
pedido  →  capacidade/data  →  produtos (id ASC)  →  itens/reservas  →  pagamentos/efeitos financeiros
```

- **Fluxos onde o pedido ainda não existe** (criação): `capacidade/data → produtos (id ASC) → INSERT pedido → itens → reserva → pagamentos`.
- `travar_capacidade_data(data)` faz `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` (inicialização concorrente segura).
- Duas datas (reagendamento): `LEAST/GREATEST` antes de travar (anti-deadlock bidirecional).
- Os helpers de reserva travam `produtos` com `ORDER BY id FOR UPDATE` e são reentrantes (re-travar o pedido na mesma transação é seguro).
- O **cron** processa lotes com `ORDER BY id FOR UPDATE OF p SKIP LOCKED LIMIT n` — vários workers podem rodar em paralelo sem colidir.
- O **trigger financeiro** (`recalcular_financeiro_pedido`, disparado por `pedido_pagamentos`) trava o pedido **primeiro**; por isso um webhook que chega durante a expiração do mesmo pedido espera e, ao prosseguir, enxerga `requer_revisao_financeira = true` e entra no caminho de pagamento tardio.

Aplicado em: `criar_pedido` (produtos → pedido, único fluxo "sem pedido" além da encomenda), `criar_encomenda_admin`, `reagendar_encomenda_admin`, `expirar_pedidos_e_holds`, `recalcular_financeiro_pedido`, `resolver_revisao_encomenda_admin`, `trg_liberar_reserva_ao_cancelar`.

---

## 3. Máquina de estados do hold

```
criar_encomenda_admin (sinal_minimo > 0 e sinal < mínimo)
  └─ status_comercial = aguardando_confirmacao
     confirmacao_expires_at = LEAST(now + hold_horas, entrega − antecedência)
     (se já <= now → IMMEDIATE_CONFIRMATION_REQUIRED, salvo sinal integral ou override admin)

expirar_pedidos_e_holds()
  ├─ valor_pago = 0  → cancelado + cancelado_por_expiracao; trigger libera reservas; capacidade livre
  └─ valor_pago > 0  → requer_revisao_financeira = true; reservas liberadas; capacidade livre
                       (hold vencido NÃO ocupa capacidade: pedido_ocupa_capacidade())

pagamento atinge sinal_minimo (trigger)
  ├─ hold vigente        → confirmado (reserva já estava ativa)
  └─ hold vencido/revisão → lock capacidade → verifica capacidade → reservar_estoque(validar)
       ├─ OK            → confirmado, reserva recriada (reserva_ciclo + 1)
       └─ falta algo    → aguardando_confirmacao + bloqueado_por_overbooking_tardio + motivo

resolver_revisao_encomenda_admin (admin, motivo ≥ 5 chars)
  ├─ ESTENDER_HOLD          → revalida capacidade E estoque; novo prazo
  ├─ CONFIRMAR_COM_OVERRIDE → ignora capacidade; estoque obrigatório
  ├─ ESTORNAR_E_CANCELAR    → estornar_pagamento_pedido() em loop → cancelado
  └─ CANCELAR               → exige p_destino_valor = RETENCAO_CANCELAMENTO se houver valor pago

estorno derruba valor abaixo do mínimo antes da produção
  ├─ novo hold = MIN(now + hold_horas, entrega − antecedência)  → aguardando_confirmacao
  └─ se esse limite já passou → requer_revisao_financeira = true, reservas liberadas (sem hold viável)
```

---

## 4. Invariante auditável

Para todo produto com `controlar_estoque = true`:

```
produtos.estoque_reservado == Σ pedido_itens.quantidade WHERE reserva_estoque_ativa = true
```

O teste de integração verifica essa igualdade após cada cenário. Qualquer novo fluxo que toque `estoque_reservado` **deve** passar pelos helpers para preservá-la. Pedidos legados sem `pedido_itens` (apenas `itens_json`) usam um fallback one-shot dentro do cancelamento por expiração.

---

## 5. Configuração operacional (`configuracoes_operacao`, singleton `id = 1`)

| Coluna | Default | Uso |
|---|---|---|
| `timezone` | `America/Fortaleza` | Todas as conversões de data operacional (`AT TIME ZONE v_cfg.timezone`) |
| `hold_horas_padrao` | 24 | Prazo máximo do hold de encomenda |
| `antecedencia_confirmacao_horas` | 2 | O hold nunca ultrapassa `entrega − antecedência` |
| `hold_pix_loja_minutos` | 30 | Tolerância do PIX da loja sem `expires_at` |
| `capacidade_padrao_pontos` | 30 | Capacidade criada automaticamente para datas novas |
| `sinal_percentual_padrao` | 50 | Sugestão de sinal na UI |

Leitura via `obter_config_operacao()` (fail-safe: timezone inválido cai para `America/Fortaleza`).

---

## 6. Agendamento no Cloudflare

Pages Functions são rotas HTTP; **Cron Triggers só existem em Workers** (`scheduled()`).
Arquitetura adotada — **Opção B**: Worker mínimo em `workers/cron-expire-orders/` chama `POST /api/cron/expire-orders` com `Authorization: Bearer <CRON_SECRET>` a cada 5 min.

Endpoint (fail-closed):

| Situação | Resposta |
|---|---|
| `CRON_SECRET` ausente/curto (< 16) | `503` — rota desabilitada |
| Bearer ausente/inválido | `401` |
| Segredo via query string | `400` (rejeitado mesmo se correto) |
| Sem `SUPABASE_SERVICE_ROLE_KEY` | `500` |

---

## 7. Prazo de pagamento na loja (UI)

`criar_pedido` devolve `expires_at`; o frontend (`js/pedidos.js` → `js/mercadopago.js` → `js/mercadopago-plugin.js`) o usa como **única fonte**: "Conclua o pagamento até HH:MM • restam N min" (contador a cada 15s, "menos de 1 minuto" abaixo de 60s). O contador é **apenas visual**: a expiração real é confirmada pelo servidor (polling lê `cancelado_por_expiracao`/`status_comercial` e troca para "Prazo de pagamento expirado"). Sem `expires_at`, exibe texto neutro — nunca um número fixo de minutos. Ao reabrir um PIX, o prazo é relido do servidor (fallback: valor salvo no checkout).

## 8. Artefato de instalação

`sql/install.sql` (= `sql/schema.sql`) é **executado inteiro, do zero, em um PostgreSQL vazio** no início de `npm run test:integration` e **reexecutado** (junto com a migration 011) no teste `R2-1` — zero erros é condição de aprovação. Todas as `CREATE POLICY` do baseline são precedidas de `DROP POLICY IF EXISTS` para que o artefato seja reaplicável. Para um banco já existente, aplique só as migrations novas.

## 9. Como estender

1. Crie `supabase/migrations/NNN_*.sql` (idempotente).
2. `npm run build:sql` (regenera `install.sql`/`schema.sql`).
3. Adicione cenários em `tests/integration/` se tocar pedidos/estoque/capacidade.
4. `npm test` (paridade SQL + estrutural + integração).
