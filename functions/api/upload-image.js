import { getCorsHeaders, handleCorsOptions } from './_cors.js';
import { verifyAuth } from './_auth.js';

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);

    // Upload de imagens é restrito a administradores e operadores ativos
    const authResult = await verifyAuth(request, env, ['admin', 'operador']);
    if (!authResult.authorized) {
      return new Response(JSON.stringify({
        success: false,
        error: authResult.error || 'Acesso não autorizado para upload de imagens.'
      }), {
        status: authResult.status || 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const incomingFormData = await request.formData();
    const imageFile = incomingFormData.get('image');

    if (!imageFile) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Nenhuma imagem foi enviada no campo "image".'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const supabaseUrl = env.SUPABASE_URL || 'https://xdnlkvbfaacrrhhuaxao.supabase.co';
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

    // 1. Provedor Primário: Supabase Storage (Privado & Seguro via Service Role)
    if (supabaseUrl && serviceKey) {
      try {
        const fileExt = (imageFile.name || 'image.jpg').split('.').pop() || 'jpg';
        const fileName = `upload_${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const storageRes = await fetch(`${supabaseUrl}/storage/v1/object/produtos/itens/${fileName}`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': imageFile.type || 'image/jpeg'
          },
          body: imageFile
        });

        if (storageRes.ok) {
          const publicUrl = `${supabaseUrl}/storage/v1/object/public/produtos/itens/${fileName}`;
          return new Response(JSON.stringify({
            success: true,
            url: publicUrl,
            display_url: publicUrl,
            provider: 'supabase'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      } catch (storageErr) {
        console.warn('[Upload Image] Tentativa via Supabase Storage falhou:', storageErr.message);
      }
    }

    // 2. Provedor Secundário: ImgBB (Apenas se a chave IMGBB_API_KEY estiver explicitamente configurada)
    const imgbbKey = env.IMGBB_API_KEY;
    if (imgbbKey) {
      const outFormData = new FormData();
      outFormData.append('image', imageFile);

      const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbKey)}`, {
        method: 'POST',
        body: outFormData
      });

      const imgbbData = await imgbbRes.json();

      if (imgbbRes.ok && imgbbData.success) {
        return new Response(JSON.stringify({
          success: true,
          url: imgbbData.data.url,
          display_url: imgbbData.data.display_url,
          thumb: imgbbData.data.thumb?.url || null,
          provider: 'imgbb'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Nenhum provedor de armazenamento (Supabase Storage ou ImgBB) está configurado ou disponível no servidor.'
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({
      success: false,
      error: err.message || 'Erro interno no upload de imagem.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
