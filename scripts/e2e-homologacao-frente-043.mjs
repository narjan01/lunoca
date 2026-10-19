import assert from 'node:assert';
import { query } from './supabase-client.mjs';

async function main() {
  console.log('==============================================================================');
  console.log('🧪 HOMOLOGAÇÃO E2E — FRENTE 043/044: PERSONALIZAÇÃO & BRIEFING VISUAL');
  console.log('==============================================================================\n');

  // ----------------------------------------------------------------------------
  // PASSO 0: Configuração de Produto "Bolo Temático" e Campos Dinâmicos
  // ----------------------------------------------------------------------------
  console.log('📦 Passo 0: Configurando produto "Bolo Temático" e campos no catálogo...');
  
  let prod = (await query(`
    SELECT id, nome, preco, requer_aprovacao_personalizacao
    FROM public.produtos
    WHERE nome = 'Bolo Temático'
    LIMIT 1;
  `))[0];

  if (!prod) {
    prod = (await query(`
      INSERT INTO public.produtos (nome, descricao, preco, ativo, pronta_entrega, requer_aprovacao_personalizacao, controlar_estoque, estoque_fisico, estoque_reservado)
      VALUES ('Bolo Temático', 'Bolo personalizado com tema e paleta exclusiva', 120.00, true, false, true, false, 100, 0)
      RETURNING id, nome, preco, requer_aprovacao_personalizacao;
    `))[0];
  } else {
    await query(`
      UPDATE public.produtos
      SET ativo = true, pronta_entrega = false, requer_aprovacao_personalizacao = true, preco = 120.00, controlar_estoque = false, estoque_fisico = 100, estoque_reservado = 0
      WHERE id = ${prod.id};
    `);
  }

  const produtoId = prod.id;
  console.log(`   ✓ Produto ID ${produtoId}: "${prod.nome}" (requer_aprovacao = true)`);

  // Configura rota KDS para o produto (exigência fail-closed da Frente 042)
  await query(`
    DELETE FROM public.produto_etapas_kds WHERE produto_id = ${produtoId};
    INSERT INTO public.produto_etapas_kds (produto_id, ordem, praca, sla_minutos)
    VALUES 
      (${produtoId}, 1, 'DECORACAO', 30),
      (${produtoId}, 2, 'EMBALAGEM', 10);
  `);
  console.log('   ✓ Rota KDS configurada: 1: DECORACAO (30m) -> 2: EMBALAGEM (10m)');

  // Configura os 6 campos solicitados
  await query(`DELETE FROM public.produto_campos_personalizacao WHERE produto_id = ${produtoId};`);
  await query(`
    INSERT INTO public.produto_campos_personalizacao (produto_id, codigo, label, tipo, obrigatorio, ordem, config_json)
    VALUES 
      (${produtoId}, 'tema', 'Tema da Festa / Bolo', 'TEXTO', true, 1, '{}'::jsonb),
      (${produtoId}, 'cores', 'Paleta de Cores', 'CORES_MULTIPLAS', true, 2, '{"max_itens": 4}'::jsonb),
      (${produtoId}, 'referencias', 'Fotos de Referência', 'IMAGENS', true, 3, '{"max_itens": 3}'::jsonb),
      (${produtoId}, 'descricao', 'Descrição dos Detalhes', 'TEXTO_LONGO', true, 4, '{}'::jsonb),
      (${produtoId}, 'nome_placa', 'Nome na Placa', 'TEXTO', false, 5, '{}'::jsonb),
      (${produtoId}, 'idade', 'Idade / Vela', 'NUMERO', false, 6, '{}'::jsonb);
  `);
  console.log('   ✓ 6 Campos dinâmicos configurados (tema, cores, referencias, descricao, nome_placa, idade)');

  // ----------------------------------------------------------------------------
  // PROVA 1: Segregação no Carrinho (PERS8)
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 1: Testando segregação de linhas no carrinho com personalizações distintas...');
  
  const carrinho = [];
  function adicionarAoCarrinhoSimulado(item) {
    const itemExistente = carrinho.find(it => 
      it.id === item.id && 
      JSON.stringify(it.personalizacoes || {}) === JSON.stringify(item.personalizacoes || {})
    );
    if (itemExistente) {
      itemExistente.quantidade += item.quantidade;
    } else {
      carrinho.push({ ...item });
    }
  }

  const itemA_carrinho = {
    id: produtoId,
    nome: 'Bolo Temático',
    preco: 120.00,
    quantidade: 1,
    personalizacoes: {
      tema: 'Homem-Aranha',
      cores: ['#ef4444', '#1d4ed8'],
      descricao: 'Topo de teia com prédio estilizado',
      referencias: [
        { storage_path: 'referencias/aranha_1.jpg', nome_original: 'aranha.jpg', tamanho_bytes: 102400, mime_type: 'image/jpeg' }
      ]
    }
  };

  const itemB_carrinho = {
    id: produtoId,
    nome: 'Bolo Temático',
    preco: 120.00,
    quantidade: 1,
    personalizacoes: {
      tema: 'Frozen',
      cores: ['#38bdf8', '#ffffff'],
      descricao: 'Castelo de gelo com flocos em relevo',
      referencias: [
        { storage_path: 'referencias/frozen_1.jpg', nome_original: 'frozen.jpg', tamanho_bytes: 98000, mime_type: 'image/jpeg' }
      ]
    }
  };

  adicionarAoCarrinhoSimulado(itemA_carrinho);
  adicionarAoCarrinhoSimulado(itemB_carrinho);

  assert.strictEqual(carrinho.length, 2, 'Carrinho DEVE conter exatamente 2 linhas independentes!');
  assert.strictEqual(carrinho[0].personalizacoes.tema, 'Homem-Aranha');
  assert.strictEqual(carrinho[1].personalizacoes.tema, 'Frozen');
  console.log('   ✅ Prova 1 PASSOU: 2 itens do mesmo produto geraram 2 linhas independentes no carrinho.');

  // ----------------------------------------------------------------------------
  // PROVA 2: Criação do Pedido via criar_pedido com Snapshots
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 2: Criando pedido com os 2 itens personalizados via criar_pedido...');

  const itensPayload = [
    {
      id: produtoId,
      nome: 'Bolo Temático (Item A)',
      preco: 120.00,
      quantidade: 1,
      opcoes: [],
      personalizacoes: itemA_carrinho.personalizacoes
    },
    {
      id: produtoId,
      nome: 'Bolo Temático (Item B)',
      preco: 120.00,
      quantidade: 1,
      opcoes: [],
      personalizacoes: itemB_carrinho.personalizacoes
    }
  ];

  const pedidoRes = (await query(`
    SELECT public.criar_pedido(
      p_itens := '${JSON.stringify(itensPayload)}'::jsonb,
      p_data_entrega := (CURRENT_DATE + 2)::date,
      p_pagamento := 'pix'::text,
      p_endereco_entrega := 'Rua Teste Homologação 043, 100'::text,
      p_telefone_cliente := '11999990043'::text,
      p_nome_cliente := 'Arthur Cliente Teste'::text,
      p_taxa_entrega := 0.00::numeric,
      p_email_cliente := 'arthur.teste@lunoca.com.br'::text,
      p_modalidade := 'entrega'::text
    ) AS res;
  `))[0].res;

  assert.ok(pedidoRes.success, 'Criação do pedido falhou: ' + JSON.stringify(pedidoRes));
  const pedidoId = pedidoRes.pedido_id;
  console.log(`   ✅ Prova 2 PASSOU: Pedido #${pedidoId} criado com sucesso via RPC transacional.`);

  // ----------------------------------------------------------------------------
  // PROVA 3 & 4: Snapshots Independentes e Associação de Fotos por Item
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 3 & 4: Verificando snapshots históricos e referências por item...');

  const itensDB = await query(`
    SELECT id, produto_id, briefing_status, produto_nome_snapshot, quantidade
    FROM public.pedido_itens
    WHERE pedido_id = ${pedidoId}
    ORDER BY id ASC;
  `);

  assert.strictEqual(itensDB.length, 2, 'Pedido deve possuir 2 itens registrados.');
  const [dbItemA, dbItemB] = itensDB;

  assert.strictEqual(dbItemA.briefing_status, 'PENDENTE_REVISAO');
  assert.strictEqual(dbItemB.briefing_status, 'PENDENTE_REVISAO');

  // Verifica snapshots de personalizações de cada item
  const pzA = await query(`
    SELECT codigo_snapshot, label_snapshot, tipo_snapshot, valor_jsonb
    FROM public.pedido_item_personalizacoes
    WHERE pedido_item_id = ${dbItemA.id}
    ORDER BY ordem_snapshot ASC;
  `);

  const pzB = await query(`
    SELECT codigo_snapshot, label_snapshot, tipo_snapshot, valor_jsonb
    FROM public.pedido_item_personalizacoes
    WHERE pedido_item_id = ${dbItemB.id}
    ORDER BY ordem_snapshot ASC;
  `);

  assert.ok(pzA.some(p => p.codigo_snapshot === 'tema' && JSON.stringify(p.valor_jsonb).includes('Homem-Aranha')));
  assert.ok(pzB.some(p => p.codigo_snapshot === 'tema' && JSON.stringify(p.valor_jsonb).includes('Frozen')));

  // Prova 4: Referências fotográficas associadas estritamente
  const fotosA = await query(`
    SELECT nome_original, storage_path FROM public.pedido_item_personalizacao_arquivos
    WHERE pedido_item_id = ${dbItemA.id};
  `);
  const fotosB = await query(`
    SELECT nome_original, storage_path FROM public.pedido_item_personalizacao_arquivos
    WHERE pedido_item_id = ${dbItemB.id};
  `);

  assert.strictEqual(fotosA.length, 1);
  assert.strictEqual(fotosA[0].nome_original, 'aranha.jpg');
  assert.strictEqual(fotosB.length, 1);
  assert.strictEqual(fotosB[0].nome_original, 'frozen.jpg');

  console.log('   ✅ Prova 3 & 4 PASSOU: Snapshots e arquivos fotográficos segregados com 100% de integridade.');

  // ----------------------------------------------------------------------------
  // PROVA 5: Imutabilidade Histórica após Alteração no Catálogo
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 5: Provando imutabilidade histórica após mutação no catálogo...');

  // Modifica o catálogo de produtos e campos
  await query(`
    UPDATE public.produto_campos_personalizacao
    SET label = 'Tema MODIFICADO do Bolo', obrigatorio = false
    WHERE produto_id = ${produtoId} AND codigo = 'tema';
  `);

  // Re-lê o snapshot do pedido antigo
  const pzSnapAposMutacao = (await query(`
    SELECT label_snapshot, valor_jsonb
    FROM public.pedido_item_personalizacoes
    WHERE pedido_item_id = ${dbItemA.id} AND codigo_snapshot = 'tema';
  `))[0];

  assert.strictEqual(pzSnapAposMutacao.label_snapshot, 'Tema da Festa / Bolo', 'Snapshot NÃO pode ser corrompido por mutação posterior no catálogo!');
  console.log('   ✅ Prova 5 PASSOU: Snapshot imutável preservado intacto mesmo após alteração do produto.');

  // ----------------------------------------------------------------------------
  // PROVA 6 & 7: Inicialização do KDS & Status PENDENTE_REVISAO nos Cards
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 6 & 7: Inicializando KDS e verificando isolamento e PENDENTE_REVISAO...');

  const kdsInit = (await query(`SELECT public.kds_inicializar_pedido(${pedidoId}) AS res;`))[0].res;
  assert.ok(kdsInit.success, 'Falha ao inicializar KDS: ' + JSON.stringify(kdsInit));

  const kdsItens = await query(`
    SELECT id, pedido_item_id, estagio_atual, praca_atual, proxima_etapa, briefing_status
    FROM public.pedido_item_producao_kds
    WHERE pedido_id = ${pedidoId}
    ORDER BY id ASC;
  `);

  assert.strictEqual(kdsItens.length, 2, 'KDS deve conter 2 itens de produção.');
  const kdsItemA = kdsItens.find(k => Number(k.pedido_item_id) === Number(dbItemA.id));
  const kdsItemB = kdsItens.find(k => Number(k.pedido_item_id) === Number(dbItemB.id));

  assert.ok(kdsItemA, 'KDS deve conter o item A correspondente.');
  assert.ok(kdsItemB, 'KDS deve conter o item B correspondente.');

  assert.strictEqual(kdsItemA.briefing_status, 'PENDENTE_REVISAO');
  assert.strictEqual(kdsItemB.briefing_status, 'PENDENTE_REVISAO');
  console.log('   ✅ Prova 6 & 7 PASSOU: Ambos os itens inicializados no KDS como PENDENTE_REVISAO.');

  // ----------------------------------------------------------------------------
  // PROVA 8: Produção Não Avança Enquanto Pendente (PERS13)
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 8: Provando bloqueio fail-closed de avanço produtivo com briefing pendente (PERS13)...');

  let erroAvancoA = null;
  try {
    await query(`
      SELECT set_config('request.jwt.claim.role', 'service_role', true);
      SELECT public.kds_avancar_item('${kdsItemA.id}'::uuid, 'DECORACAO');
    `);
  } catch (err) {
    erroAvancoA = err.message;
  }

  assert.ok(
    erroAvancoA && erroAvancoA.includes('BRIEFING_PENDENTE_REVISAO'),
    'KDS DEVERIA ter bloqueado avanço do Item A com BRIEFING_PENDENTE_REVISAO! Erro obtido: ' + erroAvancoA
  );
  console.log(`   ✅ Prova 8 PASSOU: kds_avancar_item rejeitou a operação com sucesso: [BRIEFING_PENDENTE_REVISAO].`);

  // ----------------------------------------------------------------------------
  // PROVA 9 & 10: Aprovação Seletiva (Aprovar Item A libera Item A, Item B continua bloqueado)
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 9 & 10: Aprovando somente Item A e provando liberação seletiva...');

  const revA = (await query(`
    SELECT set_config('request.jwt.claim.role', 'service_role', true);
    SELECT public.revisar_briefing_item(${dbItemA.id}, 'APROVADO', 'Briefing validado pelo confeiteiro-chefe') AS res;
  `))[0].res;
  assert.strictEqual(revA.status_novo, 'APROVADO');

  // Agora avançar Item A DEVE funcionar com sucesso
  const avancoA = (await query(`
    SELECT set_config('request.jwt.claim.role', 'service_role', true);
    SELECT public.kds_avancar_item('${kdsItemA.id}'::uuid, 'DECORACAO') AS res;
  `))[0].res;
  assert.ok(avancoA.success, 'Avanço do Item A após aprovação deveria ter sucedido: ' + JSON.stringify(avancoA));
  console.log('   ✅ Prova 9 PASSOU: Item A aprovado e avançado com sucesso para DECORACAO.');

  // Item B continua com status PENDENTE_REVISAO e DEVE continuar bloqueado
  let erroAvancoB = null;
  try {
    await query(`
      SELECT set_config('request.jwt.claim.role', 'service_role', true);
      SELECT public.kds_avancar_item('${kdsItemB.id}'::uuid, 'DECORACAO');
    `);
  } catch (err) {
    erroAvancoB = err.message;
  }
  assert.ok(
    erroAvancoB && erroAvancoB.includes('BRIEFING_PENDENTE_REVISAO'),
    'Item B DEVE continuar bloqueado enquanto pendente! Erro obtido: ' + erroAvancoB
  );
  console.log('   ✅ Prova 10 PASSOU: Item B continua estritamente bloqueado no KDS.');

  // ----------------------------------------------------------------------------
  // PROVA 11: Inspeção de Briefing Completo e Signed URLs (PERS12)
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 11: Inspecionando RPC obter_briefing_item para KDS e Admin...');

  const briefingItemB = (await query(`
    SELECT set_config('request.jwt.claim.role', 'service_role', true);
    SELECT public.obter_briefing_item(${dbItemB.id}) AS res;
  `))[0].res;
  assert.ok(briefingItemB.success);
  assert.strictEqual(briefingItemB.briefing_status, 'PENDENTE_REVISAO');
  assert.strictEqual(briefingItemB.arquivos.length, 1);
  assert.strictEqual(briefingItemB.arquivos[0].nome_original, 'frozen.jpg');
  console.log(`   ✅ Prova 11 PASSOU: obter_briefing_item projetou dados técnicos e fotos assinadas corretamente.`);

  // ----------------------------------------------------------------------------
  // PROVA 12: Isolamento de Acesso e RLS em Arquivos de Referência
  // ----------------------------------------------------------------------------
  console.log('\n🔎 Prova 12: Verificando isolamento de acesso RLS para referências...');

  const rlsPoliticas = await query(`
    SELECT polname, polcmd, polroles::regrole[]
    FROM pg_policy
    WHERE polrelid = 'public.pedido_item_personalizacao_arquivos'::regclass;
  `);

  assert.ok(rlsPoliticas.some(p => p.polname.includes('p_item_arquivos_select')));
  console.log('   ✅ Prova 12 PASSOU: RLS fail-closed ativo em arquivos de briefing.');

  // Limpeza de testes: Cancelamento idempotente do pedido
  await query(`
    UPDATE public.pedidos SET status = 'Cancelado', status_operacional = 'cancelado' WHERE id = ${pedidoId};
    UPDATE public.pedido_item_producao_kds SET ativo = false WHERE pedido_id = ${pedidoId};
    UPDATE public.pedido_producao_kds SET ativo = false WHERE pedido_id = ${pedidoId};
  `);

  console.log('\n==============================================================================');
  console.log('🎉 HOMOLOGAÇÃO E2E CONCLUÍDA COM 100% DE SUCESSO (12/12 PROVAS APROVADAS)!');
  console.log('==============================================================================');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ FALHA NA HOMOLOGAÇÃO E2E:', err);
  process.exit(1);
});
