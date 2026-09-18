-- ========================================================
-- POVOAMENTO INICIAL DE PRODUTOS DA LUNOCA
-- Execute no SQL Editor do Supabase para carregar o catálogo
-- ========================================================

INSERT INTO public.produtos (nome, preco, descricao, opcoes, img_url, ativo)
VALUES 
(
  'Fatia de Bolo',
  10.00,
  'Uma fatia de pura felicidade! Nossa massa artesanal incrivelmente leve e molhadinha, intercalada com um recheio denso e aveludado que derrete na boca. Para completar, uma cobertura delicada e um brigadeiro perfeito no topo.',
  'Brigadeiro, Brigadeiro Branco',
  'img/fatia.jpg',
  true
),
(
  'Caixa Brigadeiro Gourmet 16un.',
  35.00,
  'Uma seleção irresistível e cuidadosamente preparada dos nossos brigadeiros gourmet artesanais.

Esta caixa exclusiva contém 16 unidades, oferecendo uma explosão de sabores e texturas. Desfrute da intensidade do clássico brigadeiro de chocolate ao leite com granulado belga, a doçura nostálgica do nosso ''Bicho de Pé'' rosa, a leveza cítrica do brigadeiro de limão siciliano e a cremosidade pura do brigadeiro branco.

Feitos com ingredientes nobres, cremosos por dentro e enrolados com todo carinho.

Apresentados em uma elegante caixa de madeira artesanal, prontos para presentear ou adoçar seu dia com sofisticação.',
  'Brigadeiro, Brigadeiro Branco, Beijinho',
  'img/brigadeiros-personalizados.jpg',
  true
),
(
  'Bolo de 1KG',
  90.00,
  'Nossa criação exclusiva de bolo artístico. Massa amanteigada leve e fofa com recheio cremoso e sabor delicado e refinado, coroado com o toque aveludado e suave. Decorado com rosas de papel artesanais e delicados toques dourados. Uma experiência visual e gustativa única.

Sabores de Recheio: Brigadeiro Branco, Brigadeiro Preto, Dois Amores, Prestígio.',
  'Brigadeiro Branco, Brigadeiro Preto, Dois Amores, Prestígio',
  'img/bolo-kilo.jpg',
  true
),
(
  'Brownie',
  6.00,
  '🍫 Brownie Premium | R$ 6,00

Nossa receita exclusiva de brownie premium. Textura densa e úmida (estilo fudgy) com sabor intenso de chocolate, coroado com o toque aveludado e suave da nossa cobertura. Uma experiência única! 🤤🤎

Escolha o seu recheio favorito:
✨ Brigadeiro Branco
✨ Brigadeiro Preto
✨ Dois Amores
✨ Prestígio',
  'Brigadeiro Branco, Brigadeiro Preto, Dois Amores, Prestígio',
  'img/brownie.jpg',
  true
),
(
  'Cento de Doces',
  100.00,
  '100 unidades do nosso clássico docinho de festa, feitos com carinho e ingredientes de qualidade. Perfeito para aniversários, casamentos, eventos corporativos ou simplesmente para adoçar a semana de quem você ama.

Tamanho: Aproximadamente 14g cada.',
  'Brigadeiro, Brigadeiro Branco, Prestígio',
  'img/cento-doces.jpg',
  true
);
