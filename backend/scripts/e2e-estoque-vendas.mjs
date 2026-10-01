// Teste ponta a ponta de fornecedores, produtos, estoque por loja, transferencias e vendas.
//
// Uso (banco recem-criado, com migrations e seed aplicados, e a API rodando):
//   npm run migrate && npm run seed && npm start      # em outro terminal
//   npm run test:e2e                                  # API_URL padrao: http://localhost:3000
//
// O script cria uma segunda empresa ("Empresa B") direto no banco para testar o isolamento
// entre empresas. Use somente em banco de desenvolvimento/teste.
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const B = process.env.API_URL || 'http://localhost:3000';

{
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const existe = await db.query("SELECT 1 FROM users WHERE email = 'b@b.com'");
  if (existe.rows.length === 0) {
    const t = (await db.query("INSERT INTO tenants (nome) VALUES ('Empresa B (teste)') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO locations (tenant_id, nome) VALUES ($1, 'Loja B')", [t]);
    await db.query("INSERT INTO users (tenant_id, nome, email, senha_hash, perfil) VALUES ($1, 'Admin B', 'b@b.com', $2, 'Administrador')",
      [t, bcrypt.hashSync('123456', 10)]);
  }
  await db.end();
}
let pass = 0, fail = 0;
const falhas = [];
async function r(method, path, body, tok) {
  try {
    const res = await fetch(B + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { await new Promise((ok) => setTimeout(ok, 2000)); return { s: 'CAIU', j: e.message }; }
}
function check(nome, cond, info) {
  if (cond) { pass++; console.log(`  ok   ${nome}`); }
  else { fail++; falhas.push(nome); console.log(`  FALHA ${nome} -> ${JSON.stringify(info).slice(0, 300)}`); }
}
const st = (x, s) => x.s === s;
const login = async (email, senha) => (await r('POST', '/auth/login', { email, senha })).j.token;

const A = await login('admin@girostock.local', 'admin123');
const L = Object.fromEntries((await r('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const terms = (await r('GET', '/terminals', null, A)).j;
const PDV1 = terms.find((t) => t.nome === 'PDV 01').id;
const PDVL = terms.find((t) => t.nome === 'PDV Lanchonete').id;
const catBeb = (await r('GET', '/categories', null, A)).j.find((c) => c.nome === 'Bebidas').id;
const UUID0 = '00000000-0000-0000-0000-000000000000';

console.log('\n# 1. Servidor nao cai com dados invalidos');
check('produto com fornecedor inexistente -> 404', st(await r('POST', '/products', { nome: 'Teste FK', categoria_id: catBeb, supplier_id: UUID0, barcode: '7891149100999', unidade: 'UN', preco_custo: 3, preco_venda: 5, location_id: L.Distribuidora }, A), 404));
check('movimento com product_id nao-uuid -> 400', st(await r('POST', '/stock-movements', { product_id: 'abc', tipo: 'entrada', quantidade: 1, location_destino_id: L.Distribuidora, motivo: 'x' }, A), 400));
check('venda com product_id nao-uuid -> 400', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: 'xyz', quantidade: 1 }], forma_pagamento: 'pix' }, A), 400));
check('GET /products/nao-uuid -> 400', st(await r('GET', '/products/nao-uuid', null, A), 400));
check('remover insumo da ficha com id invalido -> 400', st(await r('DELETE', '/products/abc/ingredients/def', null, A), 400));
const jsonRuim = await fetch(B + '/api/suppliers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A }, body: '{oops' });
check('JSON malformado -> 400', jsonRuim.status === 400);

console.log('\n# 2. Fornecedor');
const sup = await r('POST', '/suppliers', { nome: 'Ambev Teste', documento: '07.526.557/0001-00', telefone: '(41) 99999-0000', categoria: 'Bebidas' }, A);
check('aceita documento com mascara e salva so digitos', st(sup, 201) && sup.j.documento === '07526557000100', sup);
check('rejeita CNPJ com digito invalido', st(await r('POST', '/suppliers', { nome: 'Z', documento: '11111111111111', telefone: '4199990000', categoria: 'Bebidas' }, A), 400));
check('rejeita CPF invalido', st(await r('POST', '/suppliers', { nome: 'Z', documento: '529.982.247-24', telefone: '4199990000', categoria: 'Bebidas' }, A), 400));
check('aceita CPF valido', st(await r('POST', '/suppliers', { nome: 'Produtor Rural', documento: '529.982.247-25', telefone: '4199990000', categoria: 'Outros' }, A), 201));
check('documento duplicado -> 409', st(await r('POST', '/suppliers', { nome: 'X', documento: '07526557000100', telefone: '4199990000', categoria: 'Bebidas' }, A), 409));
const sup2 = await r('POST', '/suppliers', { nome: 'Coca Teste', documento: '45.997.418/0001-53', telefone: '4133332222', categoria: 'Bebidas' }, A);
check('cria segundo fornecedor', st(sup2, 201), sup2);
const ed = await r('PUT', `/suppliers/${sup.j.id}`, { nome: 'Ambev Editada', documento: '07526557000100', telefone: '4199990001', categoria: 'Bebidas', email: 'compras@ambev.com', prazo_medio_dias: 28 }, A);
check('edita fornecedor', st(ed, 200) && ed.j.nome === 'Ambev Editada' && ed.j.prazo_medio_dias === 28, ed);
check('editar para documento de outro -> 409', st(await r('PUT', `/suppliers/${sup.j.id}`, { nome: 'A', documento: '45997418000153', telefone: '4199990001', categoria: 'Bebidas' }, A), 409));

console.log('\n# 3. Produto x fornecedor');
const prod = await r('POST', '/products', { nome: 'Cerveja Lata', categoria_id: catBeb, supplier_id: sup.j.id, supplier_ids: [sup2.j.id], barcode: '7891149100101', unidade: 'UN', preco_custo: 3, preco_venda: 5, location_id: L.Distribuidora, estoque_inicial: 100 }, A);
check('cria produto com 2 fornecedores', st(prod, 201) && prod.j.fornecedores.length === 2, prod);
const P = prod.j.id;
let det = (await r('GET', `/products/${P}`, null, A)).j;
check('detalhe mostra fornecedor principal + adicional', det.fornecedores.length === 2 && det.fornecedores[0].principal && det.fornecedores[0].id === sup.j.id, det.fornecedores);
const supDet = (await r('GET', `/suppliers/${sup2.j.id}`, null, A)).j;
check('fornecedor lista seus produtos', supDet.produtos.some((p) => p.id === P), supDet);
check('estoque inicial UN fracionado -> 400', st(await r('POST', '/products', { nome: 'Fracao', categoria_id: catBeb, barcode: '7891149100200', unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: L.Distribuidora, estoque_inicial: 1.5 }, A), 400));
const pe = await r('PUT', `/products/${P}`, { preco_venda: 6, nome: 'Cerveja Lata 350ml', supplier_ids: [sup.j.id] }, A);
check('edita produto (preco, nome, remove fornecedor)', st(pe, 200) && Number(pe.j.preco_venda) === 6, pe);
det = (await r('GET', `/products/${P}`, null, A)).j;
check('fornecedor removido do vinculo', det.fornecedores.length === 1, det.fornecedores);
check('editar com venda <= custo -> 400', st(await r('PUT', `/products/${P}`, { preco_venda: 2 }, A), 400));
check('editar barcode para um existente -> 409', st(await r('PUT', `/products/${P}`, { barcode: '7891000100103' }, A), 409));
await r('PATCH', `/suppliers/${sup2.j.id}/status`, { ativo: false }, A);
check('nao vincula fornecedor inativo', st(await r('PUT', `/products/${P}`, { supplier_ids: [sup.j.id, sup2.j.id] }, A), 400));
await r('PATCH', `/suppliers/${sup2.j.id}/status`, { ativo: true }, A);
const conc = await Promise.all([1, 2, 3, 4, 5].map((i) => r('POST', '/products', { nome: `Concorrente ${i}`, categoria_id: catBeb, barcode: `78900000000${10 + i}`, unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: L.Distribuidora }, A)));
const codigos = conc.map((c) => c.j.codigo_interno);
check('5 cadastros simultaneos geram codigos distintos', conc.every((c) => c.s === 201) && new Set(codigos).size === 5, codigos);

console.log('\n# 4. Entrada com fornecedor, custo e NF');
const ent = await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 100, location_destino_id: L.Distribuidora, motivo: 'compra', supplier_id: sup2.j.id, custo_unitario: 4, documento_fiscal: 'NF 1234' }, A);
check('entrada com fornecedor/custo/NF', st(ent, 201) && ent.j.documento_fiscal === 'NF 1234', ent);
check('custo medio atualizado (100x3 + 100x4)/200 = 3.50', ent.j.preco_custo_atualizado === 3.5, ent.j);
det = (await r('GET', `/products/${P}`, null, A)).j;
check('compra vincula o fornecedor ao produto', det.fornecedores.some((f) => f.id === sup2.j.id), det.fornecedores);
check('entrada com custo >= preco de venda -> 400', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 1000, location_destino_id: L.Distribuidora, motivo: 'x', custo_unitario: 9 }, A), 400));
check('entrada fracionada em produto UN -> 400', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 0.5, location_destino_id: L.Distribuidora, motivo: 'x' }, A), 400));
const entradasSup = (await r('GET', `/suppliers/${sup2.j.id}`, null, A)).j.entradas;
check('historico de compras do fornecedor', entradasSup.length === 1 && entradasSup[0].documento_fiscal === 'NF 1234', entradasSup);
const movs = (await r('GET', `/stock-movements?product_id=${P}`, null, A)).j;
check('historico mostra fornecedor e usuario', movs[0].supplier_nome === 'Coca Teste' && movs[0].usuario_nome === 'Administrador', movs[0]);

console.log('\n# 5. Lojas e terminais');
const loja = await r('POST', '/locations', { nome: 'Loja Centro' }, A);
check('cria loja', st(loja, 201));
const LC = loja.j.id;
const tc = await r('POST', '/terminals', { nome: 'PDV Centro', location_id: LC }, A);
check('cria terminal na loja', st(tc, 201));
const TC = tc.j.id;
check('renomeia loja', (await r('PATCH', `/locations/${LC}`, { nome: 'Loja Centro 1' }, A)).j.nome === 'Loja Centro 1');
await r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: LC, motivo: 'abastecer' }, A);
check('nao desativa loja com estoque', st(await r('PATCH', `/locations/${LC}`, { ativo: false }, A), 400));
const lojaVazia = (await r('POST', '/locations', { nome: 'Loja Vazia' }, A)).j.id;
const tv = (await r('POST', '/terminals', { nome: 'PDV Vazio', location_id: lojaVazia }, A)).j.id;
check('desativa loja sem estoque', (await r('PATCH', `/locations/${lojaVazia}`, { ativo: false }, A)).j.ativo === false);
check('terminal da loja desativada fica inativo', (await r('GET', '/terminals', null, A)).j.find((t) => t.id === tv).ativo === false);
check('nao cria terminal em loja inativa', st(await r('POST', '/terminals', { nome: 'X', location_id: lojaVazia }, A), 400));
check('nao movimenta para loja inativa', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 1, location_destino_id: lojaVazia, motivo: 'x' }, A), 400));
check('nao abre caixa em terminal inativo', st(await r('POST', '/cash-sessions', { terminal_id: tv, valor_inicial: 0 }, A), 400));

console.log('\n# 6. Transferencias');
const t1 = await r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 30, location_origem_id: L.Distribuidora, location_destino_id: L.Tabacaria, motivo: 'abastecer' }, A);
check('transfere Distribuidora -> Tabacaria', st(t1, 201));
check('transferir acima do saldo -> 400', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 9999, location_origem_id: L.Distribuidora, location_destino_id: L.Tabacaria, motivo: 'x' }, A), 400));
const ida = Array.from({ length: 6 }, (_, i) => r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 1, location_origem_id: i % 2 ? L.Distribuidora : L.Tabacaria, location_destino_id: i % 2 ? L.Tabacaria : L.Distribuidora, motivo: 'vai-e-vem' }, A));
const idaRes = await Promise.all(ida);
check('transferencias simultaneas em sentidos opostos sem erro', idaRes.every((x) => x.s === 201), idaRes.map((x) => x.s));
det = (await r('GET', `/products/${P}`, null, A)).j;
const saldo = (nome) => Number((det.saldos_por_local.find((s) => s.location_nome === nome) || { saldo: 0 }).saldo);
check('saldos conferem (Distrib 150, Tabacaria 30, Centro 20)', saldo('Distribuidora') === 150 && saldo('Tabacaria') === 30 && saldo('Loja Centro 1') === 20, det.saldos_por_local);

console.log('\n# 7. Isolamento entre empresas');
check('token invalido -> 401', st(await r('POST', '/locations', { nome: 'nao usado' }, 'token-invalido'), 401));
const BT = await login('b@b.com', '123456');
const LB = (await r('GET', '/locations', null, BT)).j[0].id;
check('B nao lanca entrada em produto da A (local de B)', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 999, location_destino_id: LB, motivo: 'invasao' }, BT), 404));
check('B nao lanca entrada em produto da A (local da A)', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 999, location_destino_id: L.Distribuidora, motivo: 'invasao' }, BT), 404));
await r('POST', '/categories', { nome: 'Cat B' }, BT);
const catB = (await r('GET', '/categories', null, BT)).j[0].id;
check('B nao usa fornecedor da A', st(await r('POST', '/products', { nome: 'Produto B', categoria_id: catB, supplier_id: sup.j.id, barcode: '7890000000017', unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: LB }, BT), 404));
check('B nao usa local da A', st(await r('POST', '/products', { nome: 'Produto B2', categoria_id: catB, barcode: '7890000000024', unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: L.Distribuidora, estoque_inicial: 5 }, BT), 404));
check('B nao usa categoria da A', st(await r('POST', '/products', { nome: 'Produto B3', categoria_id: catBeb, barcode: '7890000000031', unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: LB }, BT), 404));
check('B nao ve detalhe de produto da A', st(await r('GET', `/products/${P}`, null, BT), 404));
check('B nao edita fornecedor da A', st(await r('PUT', `/suppliers/${sup.j.id}`, { nome: 'hack', documento: '07526557000100', telefone: '4199990000', categoria: 'Bebidas' }, BT), 404));
check('B nao cria terminal em loja da A', st(await r('POST', '/terminals', { nome: 'x', location_id: L.Distribuidora }, BT), 404));
check('B nao abre caixa em terminal da A', st(await r('POST', '/cash-sessions', { terminal_id: PDV1, valor_inicial: 0 }, BT), 404));
check('mesmo e-mail em outra empresa -> 409', st(await r('POST', '/users', { nome: 'Dup', email: 'admin@girostock.local', senha: '123456', perfil: 'Caixa/Operador' }, BT), 409));

console.log('\n# 8. Vendas');
await r('POST', '/cash-sessions', { terminal_id: PDV1, valor_inicial: 100 }, A);
const refri = (await r('GET', '/products', null, A)).j.find((p) => p.nome.startsWith('Refrigerante')).id;
// deixa 5 cervejas na Distribuidora para testar linhas repetidas
await r('POST', '/stock-movements', { product_id: P, tipo: 'saida', quantidade: 145, location_origem_id: L.Distribuidora, motivo: 'ajuste teste' }, A);
check('mesmo produto em 2 linhas (4+4, saldo 5) -> 400 sem cair', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: P, quantidade: 4 }, { product_id: P, quantidade: 4 }], forma_pagamento: 'pix' }, A), 400));
const v1 = await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: P, quantidade: 2 }, { product_id: P, quantidade: 2 }, { product_id: refri, quantidade: 1 }], forma_pagamento: 'dinheiro', valor_recebido: 50 }, A);
check('linhas repetidas (2+2) somadas numa venda', st(v1, 201) && v1.j.total === 30, v1);
const dv = (await r('GET', `/sales/${v1.j.id}`, null, A)).j;
check('detalhe da venda: 2 itens, cerveja qtd 4, com custo', dv.itens.length === 2 && Number(dv.itens.find((i) => i.product_id === P).quantidade) === 4 && Number(dv.itens.find((i) => i.product_id === P).custo_unitario) === 3.5, dv.itens);
check('quantidade fracionada em produto UN -> 400', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: P, quantidade: 0.5 }], forma_pagamento: 'pix' }, A), 400));
check('venda acima do saldo -> 400', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: P, quantidade: 2 }], forma_pagamento: 'pix' }, A), 400));

const buscaNome = (await r('GET', `/products/search?q=cerveja&terminal_id=${PDV1}`, null, A)).j;
check('PDV: busca por nome mostra cerveja (saldo 1) com saldo', buscaNome.length === 1 && Number(buscaNome[0].saldo) === 1, buscaNome);
const buscaCentro = (await r('GET', `/products/search?q=refri&terminal_id=${TC}`, null, A)).j;
check('PDV: produto sem saldo na loja nao aparece na busca por nome', buscaCentro.length === 0, buscaCentro);
const buscaBarra = (await r('GET', `/products/search?barcode=7891000100103&terminal_id=${TC}`, null, A)).j;
check('PDV: busca por codigo de barras retorna saldo 0 na loja', buscaBarra.length === 1 && Number(buscaBarra[0].saldo) === 0, buscaBarra);

console.log('\n# 9. Cancelamento de venda');
await r('POST', '/users', { nome: 'Caixa Distrib', email: 'cx@d.com', senha: '123456', perfil: 'Caixa/Operador', location_id: L.Distribuidora }, A);
await r('POST', '/users', { nome: 'Gerente', email: 'ger@d.com', senha: '123456', perfil: 'Gerente' }, A);
const CX = await login('cx@d.com', '123456');
const GER = await login('ger@d.com', '123456');
check('caixa nao cancela venda -> 403', st(await r('POST', `/sales/${v1.j.id}/cancel`, { motivo: 'cliente desistiu' }, CX), 403));
check('cancelar sem motivo -> 400', st(await r('POST', `/sales/${v1.j.id}/cancel`, {}, GER), 400));
const antes = (await r('GET', `/cash-sessions/current?terminal_id=${PDV1}`, null, A)).j;
const canc = await r('POST', `/sales/${v1.j.id}/cancel`, { motivo: 'cliente desistiu' }, GER);
check('gerente cancela venda', st(canc, 200) && canc.j.status === 'cancelada', canc);
det = (await r('GET', `/products/${P}`, null, A)).j;
check('estoque da cerveja voltou (1 + 4 = 5)', saldo('Distribuidora') === 5, det.saldos_por_local);
check('cancelar de novo -> 400', st(await r('POST', `/sales/${v1.j.id}/cancel`, { motivo: 'de novo' }, GER), 400));
const estorno = (await r('GET', `/stock-movements?product_id=${P}`, null, A)).j[0];
check('movimento de estorno registrado', estorno.tipo === 'entrada' && estorno.motivo.startsWith('Estorno'), estorno);
const fech = await r('POST', `/cash-sessions/${antes.id}/close`, { valor_informado: 100 }, A);
check('caixa esperado ignora venda cancelada (100)', Number(fech.j.valor_esperado_fechamento) === 100, fech.j);
await r('POST', '/cash-sessions', { terminal_id: PDV1, valor_inicial: 0 }, A);
const v2 = await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: refri, quantidade: 1 }], forma_pagamento: 'pix' }, A);
const sess2 = (await r('GET', `/cash-sessions/current?terminal_id=${PDV1}`, null, A)).j;
await r('POST', `/cash-sessions/${sess2.id}/close`, { valor_informado: 0 }, A);
check('nao cancela venda de caixa ja fechado', st(await r('POST', `/sales/${v2.j.id}/cancel`, { motivo: 'tarde demais' }, A), 400));
const resumo = (await r('GET', '/reports/sales-summary', null, A)).j;
check('relatorio: custo, lucro e canceladas', resumo.total_vendido === 6 && resumo.custo_total === 3.5 && resumo.lucro_bruto === 2.5 && resumo.vendas_canceladas === 1, resumo);
const hist = (await r('GET', '/reports/sales-history', null, A)).j;
check('historico mostra venda cancelada com status', hist.some((h) => h.status === 'cancelada'), hist.map((h) => h.status));

console.log('\n# 10. Usuario restrito a sua loja');
await r('POST', '/cash-sessions', { terminal_id: PDV1, valor_inicial: 0 }, A);
await r('POST', '/users', { nome: 'Caixa Tabacaria', email: 'cx@t.com', senha: '123456', perfil: 'Caixa/Operador', location_id: L.Tabacaria }, A);
const CXT = await login('cx@t.com', '123456');
check('caixa da Tabacaria nao vende no PDV da Distribuidora -> 403', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: refri, quantidade: 1 }], forma_pagamento: 'pix' }, CXT), 403));
check('caixa da Tabacaria so ve terminais da Tabacaria', (await r('GET', '/terminals', null, CXT)).j.length === 0);
check('caixa da Distribuidora vende no PDV 01', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: refri, quantidade: 1 }], forma_pagamento: 'pix' }, CX), 201));
await r('POST', '/users', { nome: 'Estoque Tab', email: 'est@t.com', senha: '123456', perfil: 'Estoque', location_id: L.Tabacaria }, A);
const EST = await login('est@t.com', '123456');
check('estoquista da Tabacaria nao lanca entrada na Distribuidora', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'entrada', quantidade: 1, location_destino_id: L.Distribuidora, motivo: 'x' }, EST), 403));
check('estoquista da Tabacaria nao puxa estoque da Distribuidora', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 1, location_origem_id: L.Distribuidora, location_destino_id: L.Tabacaria, motivo: 'x' }, EST), 403));
check('estoquista da Tabacaria envia da Tabacaria para outra loja', st(await r('POST', '/stock-movements', { product_id: P, tipo: 'transferencia', quantidade: 1, location_origem_id: L.Tabacaria, location_destino_id: L.Distribuidora, motivo: 'devolucao' }, EST), 201));
const usersAll = (await r('GET', '/users', null, A)).j;
const cxtId = usersAll.find((u) => u.email === 'cx@t.com').id;
await r('PATCH', `/users/${cxtId}`, { location_id: L.Distribuidora }, A);
check('mudar loja do usuario vale sem novo login', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: refri, quantidade: 1 }], forma_pagamento: 'pix' }, CXT), 201));
await r('PATCH', `/users/${cxtId}/status`, { ativo: false }, A);
check('usuario desativado perde acesso na hora', st(await r('GET', '/products', null, CXT), 401));

console.log('\n# 11. Insumos por loja');
const xb = (await r('GET', '/products', null, A)).j.find((p) => p.nome === 'X-Burguer').id;
check('X-Burguer no PDV da Distribuidora (sem insumos la) -> 400', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: xb, quantidade: 1 }], forma_pagamento: 'pix' }, A), 400));
await r('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 0 }, A);
const vx = await r('POST', '/sales', { terminal_id: PDVL, itens: [{ product_id: xb, quantidade: 2 }], forma_pagamento: 'pix' }, A);
check('X-Burguer no PDV da Lanchonete', st(vx, 201), vx);
let ings = (await r('GET', '/ingredients', null, A)).j;
const ing = (n) => ings.find((i) => i.nome === n);
const saldoIng = (n, loc) => Number((ing(n).saldos_por_local.find((s) => s.location_nome === loc) || { saldo: 0 }).saldo);
check('baixa de insumos na Lanchonete (Pao 38, Carne 4700)', saldoIng('Pao', 'Lanchonete') === 38 && saldoIng('Carne', 'Lanchonete') === 4700, ing('Pao'));
const tr = await r('POST', `/ingredients/${ing('Pao').id}/transfers`, { quantidade: 10, location_origem_id: L.Lanchonete, location_destino_id: L.Distribuidora, motivo: 'abastecer' }, A);
check('transfere insumo entre lojas', st(tr, 200), tr);
await r('POST', `/ingredients/${ing('Carne').id}/transfers`, { quantidade: 1000, location_origem_id: L.Lanchonete, location_destino_id: L.Distribuidora, motivo: 'abastecer' }, A);
await r('POST', `/ingredients/${ing('Bacon').id}/transfers`, { quantidade: 60, location_origem_id: L.Lanchonete, location_destino_id: L.Distribuidora, motivo: 'abastecer' }, A);
check('agora vende X-Burguer na Distribuidora', st(await r('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: xb, quantidade: 1 }], forma_pagamento: 'pix' }, A), 201));
const cx = await r('POST', `/sales/${vx.j.id}/cancel`, { motivo: 'pedido errado' }, A);
ings = (await r('GET', '/ingredients', null, A)).j;
check('cancelar lanche devolve insumos a Lanchonete (Pao 28+2=30)', st(cx, 200) && saldoIng('Pao', 'Lanchonete') === 30, ing('Pao').saldos_por_local);
check('insumo sem local -> 400', st(await r('POST', `/ingredients/${ing('Pao').id}/stock-entries`, { quantidade: 1 }, A), 400));
check('entrada de insumo por local', st(await r('POST', `/ingredients/${ing('Pao').id}/stock-entries`, { quantidade: 10, custo_total: 10, location_id: L.Lanchonete }, A), 200));
check('vincular insumo a produto com estoque proprio -> 400', st(await r('POST', `/products/${P}/ingredients`, { ingredient_id: ing('Pao').id, quantidade_por_unidade: 1 }, A), 400));
check('movimentar estoque de produto com ficha -> 400', st(await r('POST', '/stock-movements', { product_id: xb, tipo: 'entrada', quantidade: 1, location_destino_id: L.Lanchonete, motivo: 'x' }, A), 400));

console.log('\n# 12. Estoque minimo e alertas');
check('define minimo do produto', st(await r('PUT', `/products/${P}/minimum`, { location_id: L.Distribuidora, estoque_minimo: 10 }, A), 200));
check('define minimo do insumo', st(await r('PUT', `/ingredients/${ing('Bacon').id}/minimum`, { location_id: L.Distribuidora, estoque_minimo: 100 }, A), 200));
const alertas = (await r('GET', '/stock/alerts', null, A)).j;
check('alertas listam produto e insumo abaixo do minimo', alertas.some((a) => a.tipo === 'produto' && a.id === P) && alertas.some((a) => a.tipo === 'insumo' && a.nome === 'Bacon'), alertas);

console.log('\n# 13. Produto inativo');
await r('PATCH', `/products/${refri}/status`, { ativo: false }, A);
check('produto inativo some da busca do PDV', (await r('GET', `/products/search?q=refri&terminal_id=${PDV1}`, null, A)).j.length === 0);
check('produto inativo nao recebe entrada', st(await r('POST', '/stock-movements', { product_id: refri, tipo: 'entrada', quantidade: 1, location_destino_id: L.Distribuidora, motivo: 'x' }, A), 400));
check('produto inativo ainda pode ser transferido', st(await r('POST', '/stock-movements', { product_id: refri, tipo: 'transferencia', quantidade: 1, location_origem_id: L.Distribuidora, location_destino_id: L.Tabacaria, motivo: 'x' }, A), 201));

console.log(`\nRESULTADO: ${pass} ok, ${fail} falhas`);
if (fail) {
  console.log('Falhas:', falhas);
  process.exit(1);
}
