// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Function: Gestão Administrativa de Usuários
// Permite criação de usuários com email/senha e redefinição direta de senhas
// ==========================================================================

import { getCorsHeaders } from '../_cors.js';
import { verifyAuth } from '../_auth.js';

export async function onRequestOptions(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request, env);

  try {
    const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

    // 1. Validação estrita de autorização via helper centralizado (Fail-Closed)
    const authResult = await verifyAuth(request, env, ['admin']);
    if (!authResult.authorized) {
      return new Response(JSON.stringify({
        error: authResult.error || 'Acesso negado: apenas Administradores podem gerenciar usuários e senhas.'
      }), {
        status: authResult.status || 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (!serviceKey) {
      return new Response(JSON.stringify({
        error: 'SUPABASE_SERVICE_ROLE_KEY não configurada no Cloudflare Pages.',
        needServiceRole: true
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.json();
    const action = body.action || 'create';

    // ========================================================================
    // AÇÃO 1: CRIAR NOVO USUÁRIO COM EMAIL E SENHA (PRIMEIRO ACESSO)
    // ========================================================================
    if (action === 'create') {
      const { email, password, nome, nivel, telefone, cpf, cep, endereco, numero, complemento } = body;

      if (!email || !password) {
        return new Response(JSON.stringify({ error: 'Email e senha são obrigatórios.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (password.length < 6) {
        return new Response(JSON.stringify({ error: 'A senha deve ter no mínimo 6 caracteres.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 1. Cria o usuário no Supabase Auth via Admin API
      const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password: password,
          email_confirm: true,
          user_metadata: {
            nome: nome || ''
          }
        })
      });

      const newAuthData = await createRes.json();
      if (!createRes.ok || !newAuthData.id) {
        const msg = newAuthData.message || newAuthData.msg || 'Erro ao criar usuário no Supabase Auth.';
        return new Response(JSON.stringify({ error: msg }), {
          status: createRes.status || 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const newUserId = newAuthData.id;

      // 2. Atualiza ou insere o perfil correspondente na tabela profiles
      const profilePayload = {
        id: newUserId,
        nome: nome || email.split('@')[0],
        email: email.trim().toLowerCase(),
        nivel: nivel || 'cliente',
        telefone: telefone || '',
        cpf: cpf || '',
        cep: cep || '',
        endereco: endereco || '',
        numero: numero || '',
        complemento: complemento || '',
        ativo: true
      };

      const upsertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(profilePayload)
      });

      const savedProfile = await upsertRes.json();

      return new Response(JSON.stringify({
        success: true,
        message: 'Usuário cadastrado com sucesso!',
        user: {
          id: newUserId,
          email: profilePayload.email,
          nome: profilePayload.nome,
          nivel: profilePayload.nivel
        }
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ========================================================================
    // AÇÃO 2: ATUALIZAR SENHA DE UM USUÁRIO EXISTENTE
    // ========================================================================
    if (action === 'update-password') {
      const { userId, newPassword } = body;

      if (!userId || !newPassword) {
        return new Response(JSON.stringify({ error: 'ID do usuário e nova senha são obrigatórios.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (newPassword.length < 6) {
        return new Response(JSON.stringify({ error: 'A nova senha deve ter no mínimo 6 caracteres.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Atualiza a senha do usuário via Admin API
      const updateRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: newPassword
        })
      });

      const updateData = await updateRes.json();
      if (!updateRes.ok) {
        const msg = updateData.message || updateData.msg || 'Erro ao alterar a senha do usuário.';
        return new Response(JSON.stringify({ error: msg }), {
          status: updateRes.status || 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Senha alterada com sucesso!'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: 'Ação não suportada.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    console.error('[API Admin Users] Erro interno:', err);
    return new Response(JSON.stringify({ error: 'Erro interno ao processar requisição: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
