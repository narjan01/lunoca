// ==========================================================================
// LUNOCA DOCERIA - Autenticação & Autorização Server-Side para Functions
// Valida o token JWT do Supabase e garante verificação de papéis e status ativo.
// Implementa modelo Fail-Closed rigoroso sem fallbacks inseguros.
// ==========================================================================

export async function verifyAuth(request, env, requiredRoles = []) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      authorized: false,
      status: 401,
      error: 'Autenticação obrigatória. Header Authorization Bearer ausente.'
    };
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
  const anonKey = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmxrdmJmYWFjcnJoaHVheGFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDM0MjcsImV4cCI6MjEwNTMxOTQyN30.gq0g8APuVEvVA5_mLAYVLtDabot-x_PsSbdU3u6s13g';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail-Closed: Operações com verificação de papéis exigem obrigatoriamente a service role key
  if (requiredRoles.length > 0 && !serviceKey) {
    console.error('[Auth Helper] Falha Crítica: SUPABASE_SERVICE_ROLE_KEY ausente para rota protegida por papéis.');
    return {
      authorized: false,
      status: 500,
      error: 'Configuração de segurança incompleta no servidor (SUPABASE_SERVICE_ROLE_KEY ausente).'
    };
  }

  try {
    // 1. Valida o token JWT com o endpoint oficial do Supabase Auth
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!userRes.ok) {
      return {
        authorized: false,
        status: 401,
        error: 'Sessão expirada ou token de acesso inválido.'
      };
    }

    const authUser = await userRes.json();
    if (!authUser || !authUser.id) {
      return {
        authorized: false,
        status: 401,
        error: 'Identificação de usuário não reconhecida.'
      };
    }

    // 2. Consulta perfil no banco usando service role para validar ativo e nivel com precisão
    const queryKey = serviceKey || anonKey;
    const authQueryHeader = serviceKey ? `Bearer ${serviceKey}` : `Bearer ${token}`;

    const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${authUser.id}&select=id,nome,email,nivel,ativo`, {
      headers: {
        'apikey': queryKey,
        'Authorization': authQueryHeader
      }
    });

    const profiles = await profileRes.json();
    const profile = profiles && profiles[0] ? profiles[0] : null;

    if (!profile) {
      return {
        authorized: false,
        status: 403,
        error: 'Perfil de usuário não cadastrado no sistema.'
      };
    }

    // 3. Regra Crítica: Usuário desativado é bloqueado imediatamente
    if (profile.ativo === false) {
      return {
        authorized: false,
        status: 403,
        error: 'Sua conta foi desativada pelo administrador.'
      };
    }

    // 4. Verificação estrita de papéis (ex: ['admin'] ou ['admin', 'operador'])
    if (requiredRoles.length > 0 && !requiredRoles.includes(profile.nivel)) {
      return {
        authorized: false,
        status: 403,
        error: `Acesso negado. Nível '${profile.nivel}' não possui privilégio para esta operação.`
      };
    }

    return {
      authorized: true,
      user: {
        id: authUser.id,
        email: authUser.email,
        nome: profile.nome,
        nivel: profile.nivel,
        ativo: profile.ativo
      }
    };
  } catch (err) {
    console.error('[Auth Helper] Erro na validação de sessão:', err);
    return {
      authorized: false,
      status: 500,
      error: 'Erro interno ao validar permissões do usuário.'
    };
  }
}
