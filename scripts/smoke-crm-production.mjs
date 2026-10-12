import { query } from './supabase-client.mjs';

const ADMIN_UID = 'a0000000-0000-0000-0000-000000000001';

async function adminQuery(sql) {
  const fullSql = `SET LOCAL "request.jwt.claim.role" = 'service_role';\n${sql}`;
  return query(fullSql);
}

async function main() {
  console.log('--- INICIANDO SMOKE TEST DO CRM NO SUPABASE DE PRODUÇÃO ---');

  // 1. Busca rápida
  const busca = await adminQuery(`SELECT public.buscar_clientes_crm('', 5) AS r;`);
  console.log('1. buscar_clientes_crm retornou:', busca[0]?.r?.clientes?.length, 'clientes');

  // Cria cliente temporário para validar mutações
  const cli = await query(`
    INSERT INTO public.clientes (nome, telefone, telefone_normalizado, email, cpf)
    VALUES ('SMOKE TEST CRM', '85999990000', '5585999990000', 'smoke_crm@lunoca.local', '11122233344')
    RETURNING id;
  `);
  const cid = cli[0].id;
  console.log('2. Cliente temporário criado com ID:', cid);

  try {
    // 3. Obter ficha 360 como admin
    const ficha = await adminQuery(`SELECT public.obter_cliente_360_admin(${cid}) AS r;`);
    console.log('3. obter_cliente_360_admin sucesso:', ficha[0]?.r?.success, '| CPF:', ficha[0]?.r?.cliente?.cpf);

    // 4. Adicionar nota
    const nota = await adminQuery(`SELECT public.adicionar_nota_cliente(${cid}, 'Nota de teste smoke') AS r;`);
    console.log('4. adicionar_nota_cliente sucesso:', nota[0]?.r?.success);
    const notaId = nota[0]?.r?.nota_id;

    // 5. Arquivar nota
    const arqNota = await adminQuery(`SELECT public.arquivar_nota_cliente(${notaId}) AS r;`);
    console.log('5. arquivar_nota_cliente sucesso:', arqNota[0]?.r?.success);

    // 6. Adicionar tag
    const tag = await adminQuery(`SELECT public.adicionar_tag_cliente(${cid}, 'VIP') AS r;`);
    console.log('6. adicionar_tag_cliente sucesso:', tag[0]?.r?.success);

    // 7. Remover tag
    const remTag = await adminQuery(`SELECT public.remover_tag_cliente(${cid}, 'VIP') AS r;`);
    console.log('7. remover_tag_cliente sucesso:', remTag[0]?.r?.success);

    // 8. Definir preferência
    const pref = await adminQuery(`SELECT public.definir_preferencia_cliente(${cid}, 'sabor', 'Red Velvet', 'Extra recheio') AS r;`);
    console.log('8. definir_preferencia_cliente sucesso:', pref[0]?.r?.success);
    const prefId = pref[0]?.r?.preferencia_id;

    // 9. Arquivar preferência
    const arqPref = await adminQuery(`SELECT public.arquivar_preferencia_cliente(${prefId}) AS r;`);
    console.log('9. arquivar_preferencia_cliente sucesso:', arqPref[0]?.r?.success);

    console.log('--- TODOS OS PASSOS DO SMOKE TEST DO CRM CONCLUÍDOS COM SUCESSO! ---');
  } finally {
    await query(`DELETE FROM public.cliente_preferencias WHERE cliente_id = ${cid};`);
    await query(`DELETE FROM public.cliente_tags WHERE cliente_id = ${cid};`);
    await query(`DELETE FROM public.cliente_notas WHERE cliente_id = ${cid};`);
    await query(`DELETE FROM public.clientes WHERE id = ${cid};`);
    console.log('Limpeza de dados do smoke test concluída.');
  }
}

main().catch(err => {
  console.error('Falha no smoke test:', err);
  process.exit(1);
});
