// Teste ponta a ponta dos relatorios avancados: comparativos (loja, operador, canal, categoria, produto, hora,
// dia da semana), indicadores com periodo anterior, e relatorio de estoque (posicao, minimo, parados, curva ABC).
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed):
//   API_URL=http://localhost:3000 npm run test:e2e:relatorios
import 'dotenv/config';
import pg from 'pg';

const B = process.env.API_URL || 'http://localhost:3000';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 500)}`); }
};
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const hoje = (await db.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
const P = `data_inicio=${hoje}&data_fim=${hoje}`;

// ---------- preparo: vendas em duas lojas, dois operadores, um pedido por telefone ----------
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
const tenant = (await db.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const T = Object.fromEntries((await api('GET', '/terminals', null, A)).j.map((t) => [t.nome, t.id]));
const prods = (await api('GET', '/products', null, A)).j;
const REFRI = prods.find((p) => p.codigo_interno === 'PRD-0001');
const XB = prods.find((p) => p.codigo_interno === 'PRD-0002');
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'e2e relatorios' }, A);
const email = `caixa.rel.${Date.now()}@girostock.local`;
await api('POST', '/users', { nome: 'Caixa Relatorio', email, senha: 'Senha123!', perfil: 'Caixa/Operador', location_id: L.Lanchonete }, A);
const C = (await api('POST', '/auth/login', { email, senha: 'Senha123!' })).j.token;
await api('POST', '/cash-sessions', { terminal_id: T['PDV 01'], valor_inicial: 0 }, A);
await api('POST', '/cash-sessions', { terminal_id: T['PDV Lanchonete'], valor_inicial: 0 }, C);
const vendas = [];
vendas.push(await api('POST', '/sales', { terminal_id: T['PDV 01'], itens: [{ product_id: REFRI.id, quantidade: 5 }], forma_pagamento: 'pix' }, A));
vendas.push(await api('POST', '/sales', { terminal_id: T['PDV 01'], itens: [{ product_id: REFRI.id, quantidade: 2 }], forma_pagamento: 'cartao_credito' }, A));
vendas.push(await api('POST', '/sales', { terminal_id: T['PDV Lanchonete'], itens: [{ product_id: XB.id, quantidade: 2 }, { product_id: REFRI.id, quantidade: 1 }], forma_pagamento: 'dinheiro', valor_recebido: 100 }, C));
const canc = await api('POST', '/sales', { terminal_id: T['PDV 01'], itens: [{ product_id: REFRI.id, quantidade: 1 }], forma_pagamento: 'pix' }, A);
await api('POST', `/sales/${canc.j.id}/cancel`, { motivo: 'teste relatorio' }, A);
// pedido por telefone na Lanchonete, finalizado no caixa
await db.query(`UPDATE locations SET usa_pedidos = true WHERE id = $1`, [L.Lanchonete]);
const ped = await api('POST', '/orders', { location_id: L.Lanchonete, origem: 'telefone', cliente_nome: 'Ana', tipo: 'retirada', itens: [{ product_id: REFRI.id, quantidade: 3 }] }, A);
for (const para of ['em_preparo', 'pronto', 'finalizado']) await api('POST', `/orders/${ped.j.id}/status`, { para, ...(para === 'finalizado' ? { forma_pagamento: 'pix', terminal_id: T['PDV Lanchonete'] } : {}) }, A);
const vendaPedido = (await db.query(`SELECT sale_id FROM orders WHERE id = $1`, [ped.j.id])).rows[0].sale_id;
check('preparo: 3 vendas no PDV, 1 cancelada e 1 pedido por telefone finalizado', vendas.every((v) => v.s === 201) && !!vendaPedido, vendas.map((v) => v.s));
const totalDb = Number((await db.query(`SELECT SUM(total) AS t FROM sales WHERE tenant_id = $1 AND status = 'concluida'`, [tenant])).rows[0].t);
const resumo = (await api('GET', `/reports/sales-summary?${P}`, null, A)).j;

console.log('\n# 1. Comparativos');
const porLoja = await api('GET', `/reports/comparativo?por=loja&${P}`, null, A);
check('por loja: soma igual ao total vendido', porLoja.s === 200 && igual(porLoja.j.total, totalDb) && igual(porLoja.j.total, resumo.total_vendido), { comp: porLoja.j.total, db: totalDb });
check('por loja: Distribuidora e Lanchonete, participacao soma 100%', porLoja.j.linhas.length === 2 && Math.abs(porLoja.j.linhas.reduce((s, l) => s + l.participacao, 0) - 100) < 0.2, porLoja.j.linhas);
const lanch = porLoja.j.linhas.find((l) => l.nome === 'Lanchonete');
check('por loja: ticket medio e margem calculados', lanch && igual(lanch.ticket, lanch.total / lanch.vendas) && lanch.margem > 0, lanch);
const distr = porLoja.j.linhas.find((l) => l.nome === 'Distribuidora');
check('por loja: cancelada contada na loja certa (Distribuidora)', distr && distr.canceladas === 1 && lanch.canceladas === 0, { distr, lanch });
const porOp = await api('GET', `/reports/comparativo?por=operador&${P}`, null, A);
check('por operador: Administrador e Caixa Relatorio', porOp.j.linhas.some((l) => l.nome === 'Administrador') && porOp.j.linhas.some((l) => l.nome === 'Caixa Relatorio' && l.vendas === 1), porOp.j.linhas);
const porCanal = await api('GET', `/reports/comparativo?por=canal&${P}`, null, A);
const tel = porCanal.j.linhas.find((l) => l.chave === 'telefone');
const valPed = Number((await db.query(`SELECT total FROM sales WHERE id = $1`, [vendaPedido])).rows[0].total);
check('por canal: PDV e pedido por telefone separados', porCanal.j.linhas.some((l) => l.chave === 'pdv' && l.nome === 'Venda no caixa (PDV)') && tel && tel.nome === 'Pedido por telefone' && igual(tel.total, valPed) && tel.vendas === 1, porCanal.j.linhas);
const porCat = await api('GET', `/reports/comparativo?por=categoria&${P}`, null, A);
const subtot = Number((await db.query(`SELECT SUM(si.subtotal) AS t FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.tenant_id = $1 AND s.status = 'concluida'`, [tenant])).rows[0].t);
check('por categoria: Bebidas e Lanches, soma = subtotal dos itens', porCat.j.linhas.some((l) => /Bebidas/.test(l.nome)) && porCat.j.linhas.some((l) => /Lanches/.test(l.nome)) && igual(porCat.j.total, subtot), { linhas: porCat.j.linhas, subtot });
const porProd = await api('GET', `/reports/comparativo?por=produto&${P}`, null, A);
const refriQtd = Number((await db.query(`SELECT SUM(si.quantidade) AS q FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = $1 AND s.status = 'concluida'`, [REFRI.id])).rows[0].q);
check('por produto: quantidade do refrigerante confere', porProd.j.linhas.some((l) => l.chave === REFRI.id && igual(l.itens, refriQtd)), porProd.j.linhas);
const porHora = await api('GET', `/reports/comparativo?por=hora&${P}`, null, A);
const porDia = await api('GET', `/reports/comparativo?por=dia_semana&${P}`, null, A);
check('por hora e dia da semana', porHora.s === 200 && /^\d{2}h$/.test(porHora.j.linhas[0].nome) && porDia.s === 200 && ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'].includes(porDia.j.linhas[0].nome), { h: porHora.j.linhas, d: porDia.j.linhas });
check('filtro de loja vale no comparativo', igual((await api('GET', `/reports/comparativo?por=canal&location_id=${L.Distribuidora}&${P}`, null, A)).j.total, distr.total));
check('agrupamento invalido -> 400', (await api('GET', `/reports/comparativo?por=xyz&${P}`, null, A)).s === 400);
check('caixa sem a area Relatorios -> 403', (await api('GET', `/reports/comparativo?por=loja&${P}`, null, C)).s === 403);

console.log('\n# 2. Indicadores');
const ind = await api('GET', `/reports/indicadores?${P}`, null, A);
check('indicadores: faturamento, vendas e ticket do periodo', ind.s === 200 && igual(ind.j.atual.faturamento, totalDb) && ind.j.atual.vendas === resumo.numero_vendas && igual(ind.j.atual.ticket_medio, totalDb / resumo.numero_vendas), ind.j.atual);
check('indicadores: cancelamento % e itens por venda', ind.j.atual.canceladas === 1 && igual(ind.j.atual.cancelamento_pct, Math.round((1 / (resumo.numero_vendas + 1)) * 1000) / 10) && ind.j.atual.itens_por_venda > 0, ind.j.atual);
check('indicadores: periodo anterior (ontem) sem vendas -> variacao vazia', ind.j.anterior.vendas === 0 && ind.j.variacao.faturamento === null && ind.j.anterior.ate < hoje && ind.j.variacao.margem === null, ind.j.anterior);
check('indicadores: hora de pico e melhor dia', /^\d{2}h$/.test(ind.j.atual.hora_pico) && !!ind.j.atual.melhor_dia_semana);
// venda de "ontem": compara
await db.query(`UPDATE sales SET criado_em = criado_em - interval '1 day' WHERE id = $1`, [vendas[0].j.id]);
const ind2 = (await api('GET', `/reports/indicadores?${P}`, null, A)).j;
check('indicadores: com venda ontem, variacao do faturamento calculada', ind2.anterior.vendas === 1 && ind2.variacao.faturamento !== null && igual(ind2.variacao.faturamento, ((ind2.atual.faturamento - ind2.anterior.faturamento) / ind2.anterior.faturamento) * 100), { a: ind2.atual.faturamento, b: ind2.anterior.faturamento, v: ind2.variacao.faturamento });
check('indicadores: periodo invalido -> 400', (await api('GET', `/reports/indicadores?data_inicio=${hoje}&data_fim=2000-01-01`, null, A)).s === 400);

console.log('\n# 3. Estoque');
await db.query(`UPDATE stock_balances SET estoque_minimo = 100 WHERE product_id = $1 AND location_id = $2`, [REFRI.id, L.Lanchonete]);
const est = await api('GET', `/reports/estoque?${P}`, null, A);
const valorDb = Number((await db.query(`SELECT SUM(sb.saldo * p.preco_custo) AS v FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN locations l ON l.id = sb.location_id WHERE sb.tenant_id = $1 AND sb.saldo > 0 AND p.ativo AND l.ativo`, [tenant])).rows[0].v);
check('estoque: valor a custo confere com o banco', est.s === 200 && igual(est.j.totais.valor_custo, valorDb), { rel: est.j.totais.valor_custo, db: valorDb });
check('estoque: valor a preco de venda maior que a custo', est.j.totais.valor_venda > est.j.totais.valor_custo);
check('estoque: refrigerante abaixo do minimo na Lanchonete', est.j.abaixo_minimo.some((x) => x.id === REFRI.id && x.loja === 'Lanchonete' && Number(x.falta) > 0), est.j.abaixo_minimo);
const novo = await api('POST', '/products', { nome: 'Produto Parado E2E', categoria_id: (await api('GET', '/categories', null, A)).j[0].id, barcode: '7891999000017', unidade: 'UN', preco_custo: 10, preco_venda: 15, location_id: L.Distribuidora, estoque_inicial: 7 }, A);
const est2 = (await api('GET', `/reports/estoque?${P}`, null, A)).j;
check('estoque: produto com saldo e sem venda no periodo aparece como parado (R$ 70 a custo)', novo.s === 201 && est2.parados.some((x) => x.id === novo.j.id && igual(x.valor_parado, 70)), est2.parados);
check('estoque: refrigerante vendido nao esta parado na Lanchonete', !est2.parados.some((x) => x.id === REFRI.id && x.loja === 'Lanchonete'));
check('curva ABC: 1o produto e classe A e o acumulado chega a 100%', est2.abc.length > 0 && est2.abc[0].classe === 'A' && igual(est2.abc[est2.abc.length - 1].acumulado, 100), est2.abc);
check('curva ABC: resumo por classe soma o faturamento dos itens', igual(est2.resumo_abc.reduce((s, c) => s + c.faturamento, 0), est2.abc.reduce((s, x) => s + x.faturamento, 0)));
check('estoque: filtro por loja', (await api('GET', `/reports/estoque?location_id=${L.Lanchonete}&${P}`, null, A)).j.posicao.every((x) => x.nome === 'Lanchonete'));

await db.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
