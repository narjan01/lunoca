/**
 * Configurações e Inicialização do Supabase
 *
 * PASSO A PASSO PARA CONFIGURAR:
 * 1. Crie uma conta no Supabase (https://supabase.com) e um novo projeto.
 * 2. Copie a URL do Projeto e a chave de API (anon key) nas configurações de API do Supabase e substitua as constantes abaixo.
 * 3. No SQL Editor do Supabase, cole e execute o conteúdo do arquivo `sql/schema.sql`.
 * 4. Vá em Authentication > Providers e desabilite a confirmação de email para simplificar os testes iniciais.
 */

const SUPABASE_URL = 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmxrdmJmYWFjcnJoaHVheGFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDM0MjcsImV4cCI6MjEwNTMxOTQyN30.gq0g8APuVEvVA5_mLAYVLtDabot-x_PsSbdU3u6s13g';

// Inicializa o cliente do Supabase
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Chave da API do ImgBB para upload de imagens
const IMGBB_API_KEY = '97dfa8989e6adbbc6faebb4b505686fe';
