// ==========================================================================
// LUNOCA DOCERIA - Cloudflare Pages Function: Validação de Pedido
// Recalcula o total do pedido a partir dos preços reais do banco de dados.
// Impede que um atacante manipule preços no frontend.
// ==========================================================================

import { getCorsHeaders, handleCorsOptions } from './_cors.js';

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const corsHeaders = getCorsHeaders(request, env);
    const body = await request.json();

    const { itens } = body;
    // itens: [{ id: 1, nome: "Brigadeiro", preco: 5.00 }, ...]

    if (!itens || !Array.isArray(itens) || itens.length === 0) {
      return new Response(JSON.stringify({ error: 'Nenhum item no pedido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({
        error: 'Configuração do Supabase não encontrada no servidor.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Buscar todos os produtos ativos do banco
    const produtosRes = await fetch(`${supabaseUrl}/rest/v1/produtos?ativo=eq.true&select=id,nome,preco`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!produtosRes.ok) {
      return new Response(JSON.stringify({ error: 'Erro ao consultar produtos no banco de dados.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const produtosDB = await produtosRes.json();
    const produtosMap = {};
    for (const p of produtosDB) {
      produtosMap[String(p.id)] = p;
      // Também indexa pelo nome (para itens que não têm id)
      produtosMap[p.nome.toLowerCase().trim()] = p;
    }

    let totalValidado = 0;
    const itensValidados = [];
    const erros = [];

    for (const item of itens) {
      // Tenta encontrar o produto pelo ID ou pelo nome
      let produtoDB = null;
      if (item.id) {
        produtoDB = produtosMap[String(item.id)];
      }
      if (!produtoDB && item.nome) {
        produtoDB = produtosMap[item.nome.toLowerCase().trim()];
      }

      if (!produtoDB) {
        erros.push(`Produto não encontrado: "${item.nome || item.id}"`);
        continue;
      }

      const precoReal = parseFloat(produtoDB.preco);
      const precoCliente = parseFloat(item.preco);

      // Detecta manipulação de preço
      if (Math.abs(precoReal - precoCliente) > 0.01) {
        console.warn(
          `[SEGURANÇA] Preço manipulado detectado! Produto "${produtoDB.nome}": ` +
          `cliente enviou R$${precoCliente.toFixed(2)}, preço real R$${precoReal.toFixed(2)}`
        );
      }

      totalValidado += precoReal;
      itensValidados.push({
        id: produtoDB.id,
        nome: produtoDB.nome,
        preco: precoReal
      });
    }

    if (erros.length > 0 && itensValidados.length === 0) {
      return new Response(JSON.stringify({
        error: 'Nenhum item válido encontrado no pedido.',
        detalhes: erros
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      totalValidado: parseFloat(totalValidado.toFixed(2)),
      itensValidados: itensValidados,
      avisos: erros.length > 0 ? erros : undefined
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    const corsHeaders = getCorsHeaders(context.request, context.env);
    return new Response(JSON.stringify({ error: err.message || 'Erro interno no servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function onRequestOptions(context) {
  return handleCorsOptions(context.request, context.env);
}
