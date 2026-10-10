# Lunoca - Shared Interface Specification

## Project Directory
`C:\Users\narjan.andrade\.gemini\antigravity\scratch\lunoca`

## Script Load Order (in index.html)
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="js/supabase.js"></script>
<script src="js/app.js"></script>
<script src="js/auth.js"></script>
<script src="js/carrinho.js"></script>
<script src="js/produtos.js"></script>
<script src="js/pedidos.js"></script>
<script src="js/admin.js"></script>
```

## Global Variables (ALL declared in app.js)
```js
var produtos = [];           // Array of product objects from DB
var carrinho = [];           // Array of cart items (in-memory + localStorage)
var pedidosGlobal = [];      // Array of all orders (admin use)
var usuarioAtual = { nivel: 'visitante', nome: '', email: '', id: null };
var modoCadastro = false;    // Toggle: login form vs register form
var dataCalendario = new Date(); // Current month for admin calendar
var produtoSendoVisto = null;    // Product object being viewed in modal
```

## Functions by Module

### app.js
- `mostrarTela(telaId)` - Show a SPA screen by id, hide others. Also handles cart button visibility and triggers admin data loading.
- `configurarRegraData()` - Sets min date on #data-pedido to 2 days from now.
- Overrides `window.alert` with a styled toast notification (bottom center, purple, 3s auto-dismiss).
- `window.onload` - Calls: `carregarProdutosServidor()`, `configurarRegraData()`, `atualizarInterfaceUsuario()`, `carregarCarrinhoLocal()`, `carregarSessaoAtual()`.
- Click-outside handler to close `.user-dropdown`.

### auth.js
- `toggleUserMenu()` - If visitante, go to login. If logged in, show/hide dropdown with options.
- `alternarModoAuth()` - Toggle between login and register form mode.
- `processarAutenticacao()` (async) - Login via `supabaseClient.auth.signInWithPassword` or register via `supabaseClient.auth.signUp` with `options: { data: { nome } }`.
- `fazerLogout()` (async) - `supabaseClient.auth.signOut()`, reset state, go to menu.
- `atualizarInterfaceUsuario()` - Update #user-greeting text based on usuarioAtual.
- `carregarSessaoAtual()` (async) - Check `supabaseClient.auth.getSession()` for existing session, load profile if found.
- `carregarPerfilUsuario(authUser)` (async) - Query profiles table by id, populate usuarioAtual with all fields.
- `abrirMinhaConta()` - Populate profile form fields from usuarioAtual, show conta-section.
- `salvarPerfilUsuario()` (async) - Update profiles table via supabase, then update local usuarioAtual.
- `mudarTabConta(tab)` - Switch between 'pessoal' and 'endereco' tabs.
- `buscarCepViaAPI()` - Fetch from viacep.com.br/ws/{cep}/json/, fill address fields.

### carrinho.js
- `atualizarBotaoCarrinho()` - Update cart count and total in #btn-ver-carrinho.
- `irParaCheckout()` - Show checkout-section with cart items summary.
- `salvarCarrinhoLocal()` - Save carrinho to localStorage('lunoca_carrinho').
- `carregarCarrinhoLocal()` - Load carrinho from localStorage.

### produtos.js
- `carregarProdutosServidor()` (async) - Query `supabaseClient.from('produtos').select('*').eq('ativo', true).order('created_at')`, store in `produtos`.
- `renderizarProdutosApp()` - Build HTML cards for #produtos-lista from `produtos` array.
- `abrirModalProduto(id)` - If visitante, alert and go to login. Otherwise show modal with product details and variations.
- `fecharModalProduto()` - Hide #modal-produto.
- `confirmarAdicaoCarrinho()` - Add selected product (with chosen variation) to `carrinho`, update cart button, close modal. Call `salvarCarrinhoLocal()`.
- `editarProduto(id)` - Fill admin product form with product data for editing.
- `salvarProdutoAdmin()` (async) - Upsert product to DB. If prod-id is empty, insert new. If set, update existing. Use `supabaseClient.from('produtos').upsert({...})`.
- `renderizarProdutosAdmin()` - Build HTML list for #lista-produtos-admin.
- `limparFormProduto()` - Clear all product form fields.
- `prepararUpload(input)` - Upload image to ImgBB API, set #prod-img hidden input with returned URL.

### pedidos.js
- `enviarPedido()` (async) - Validate fields, insert order into `pedidos` table via supabase. Clear cart. Show success alert.
- `carregarPedidosAdmin()` (async) - Query all orders from supabase, ordered by data_entrega DESC. Store in pedidosGlobal. Render HTML in #lista-pedidos-admin.
- `renderizarCalendario()` - Build calendar table for current month. Mark days with orders.
- `mudarMes(delta)` - Change dataCalendario month and re-render calendar.
- `mostrarPedidosDia(data)` - Show orders for a specific date in #detalhes-dia-calendario.

### admin.js
- `mudarTabAdmin(tab)` - Switch between admin tabs (pedidos, calendario, produtos, usuarios).
- `carregarUsuariosAdmin()` (async) - Query all profiles from supabase. Render in #lista-usuarios-admin.
- `prepararEdicaoUsuario(id, nome, nivel)` - Show user edit form with name and level fields pre-filled. NOTE: only nome and nivel are editable (email/password managed by Supabase Auth).
- `fecharFormUsuario()` - Hide user edit form.
- `salvarFormUsuario()` (async) - Update profile in supabase (nome and nivel only).
- `excluirUser(id)` (async) - Delete profile from supabase. Double-click confirmation pattern.

## Database Tables (Supabase PostgreSQL)

### profiles
| Column | Type | Notes |
|---|---|---|
| id | UUID | PK, references auth.users(id) |
| nome | TEXT | |
| email | TEXT | UNIQUE |
| cpf | TEXT | |
| telefone | TEXT | |
| cep | TEXT | |
| endereco | TEXT | |
| numero | TEXT | |
| complemento | TEXT | |
| nivel | TEXT | 'cliente' or 'admin' |
| ativo | BOOLEAN | default true |
| created_at | TIMESTAMPTZ | |

### produtos
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL | PK |
| nome | TEXT | |
| preco | DECIMAL(10,2) | |
| descricao | TEXT | |
| opcoes | TEXT | comma-separated variations |
| img_url | TEXT | |
| ativo | BOOLEAN | default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### pedidos
| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL | PK |
| cliente_id | UUID | FK to profiles |
| nome_cliente | TEXT | |
| email_cliente | TEXT | |
| data_pedido | DATE | |
| data_entrega | DATE | |
| total | DECIMAL(10,2) | |
| pagamento | TEXT | 'pix' or 'cartao' |
| status | TEXT | Pendente, Confirmado, etc. |
| itens | TEXT | items joined with ' + ' |
| endereco_entrega | TEXT | |
| created_at | TIMESTAMPTZ | |

## Supabase Query Patterns
```js
// SELECT
const { data, error } = await supabaseClient.from('table').select('*');
const { data, error } = await supabaseClient.from('table').select('*').eq('col', val);
const { data, error } = await supabaseClient.from('table').select('*').order('col', { ascending: false });

// INSERT
const { data, error } = await supabaseClient.from('table').insert({ col1: val1, col2: val2 });

// UPDATE
const { data, error } = await supabaseClient.from('table').update({ col1: val1 }).eq('id', id);

// UPSERT (insert or update)
const { data, error } = await supabaseClient.from('table').upsert({ id: existingId, col1: val1 });

// DELETE
const { data, error } = await supabaseClient.from('table').delete().eq('id', id);

// AUTH
const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { data: { nome } } });
const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
const { error } = await supabaseClient.auth.signOut();
const { data: { session } } = await supabaseClient.auth.getSession();
```

## HTML Element IDs (referenced by JS)
### Screens
- login-section, menu-section, conta-section, checkout-section, admin-section

### Auth
- auth-title, auth-email, auth-senha, reg-nome, cadastro-fields, btn-auth-action, user-greeting, user-dropdown, btn-header-auth

### Profile
- perfil-nome, perfil-email, perfil-cpf, perfil-telefone, perfil-cep, perfil-endereco, perfil-numero, perfil-complemento, btn-salvar-perfil
- tab-conta-pessoal, tab-conta-endereco, conta-tab-pessoal, conta-tab-endereco

### Products
- produtos-lista, modal-produto, modal-img, modal-nome, modal-preco, modal-desc, modal-opcoes-container, modal-opcoes-lista

### Cart/Checkout
- btn-ver-carrinho, qtd-carrinho, valor-btn-carrinho, total-carrinho, itens-carrinho
- data-pedido, endereco-checkout, pagamento

### Admin
- tab-btn-pedidos, tab-btn-calendario, tab-btn-produtos, tab-btn-usuarios
- admin-tab-pedidos, admin-tab-calendario, admin-tab-produtos, admin-tab-usuarios
- lista-pedidos-admin, lista-produtos-admin, lista-usuarios-admin
- mes-ano-atual, calendario-corpo, detalhes-dia-calendario
- prod-id, prod-nome, prod-preco, prod-desc, prod-opcoes, prod-img, prod-file, lbl-upload, upload-status, btn-salvar-produto
- form-user-admin, admin-user-nome, admin-user-email, admin-user-nivel, admin-user-id

## Design Constants
- Primary color: #c496f2 (lilac)
- Secondary: #ffb6c1 (pink)
- Text: #5c4033 (brown)
- Background: #fbf9ff (light purple)
- Logo URL: https://i.ibb.co/nsxb8S8B/logo.jpg
- Font: Poppins + Great Vibes (cursive for logo)
- Default product image: https://via.placeholder.com/150/fbf9ff/c496f2?text=Doce
