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

    const imgbbKey = env.IMGBB_API_KEY || '97dfa8989e6adbbc6faebb4b505686fe';

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

    // Encaminha para o ImgBB de forma segura no backend
    const outFormData = new FormData();
    outFormData.append('image', imageFile);

    const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbKey)}`, {
      method: 'POST',
      body: outFormData
    });

    const imgbbData = await imgbbRes.json();

    if (!imgbbRes.ok || !imgbbData.success) {
      return new Response(JSON.stringify({
        success: false,
        error: imgbbData?.error?.message || 'Falha no processamento da imagem pelo provedor de hospedagem.'
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      url: imgbbData.data.url,
      display_url: imgbbData.data.display_url,
      thumb: imgbbData.data.thumb?.url || null
    }), {
      status: 200,
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
