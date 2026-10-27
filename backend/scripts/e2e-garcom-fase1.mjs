// e2e do Garcom, Fase 1: perfil, comandas de mesa e pista, rodadas (reserva de estoque), cozinha, fechamento no caixa, transferencia,
// cancelamentos, modulo desligado e isolamento. npm run test:e2e:garcom-fase1   (API em http://localhost:3000)
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.gf1.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const uuid = () => crypto.randomUUID();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E GF1 Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.gf1.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E GF1 ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Casa', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId) {
  const email = `e2e.gf1.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j.token, usuario: lg.j.usuario, status: r.s };
}
const saldoProduto = async (tok, loja, nome) => ((await api('GET', `/products/search?location_id=${loja}&q=${encodeURIComponent(nome)}&limit=50`, null, tok)).j.find((p) => p.nome === nome) || {}).saldo;
const contar = async (sql, p) => Number((await prod.query(sql, p)).rows[0].n);

console.log('\n# Preparo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true } }, MAS);
const L1 = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
check('loja usa pedidos', (await api('PATCH', `/locations/${L1}`, { usa_pedidos: true }, E.token)).s === 200);
const L2 = (await api('POST', '/locations', { nome: 'Casa 2', usa_pedidos: true }, E.token)).j.id;
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, E.token)).j.id;
const T2 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 2' }, E.token)).j.id;
check('abre o caixa 1', (await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 100 }, E.token)).s === 201);
await api('POST', '/categories', { nome: 'Bar' }, E.token);
const cat = (await api('GET', '/categories', null, E.token)).j[0].id;
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const produto = async (nome, venda, estoque) => (await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 1, preco_venda: venda, ...(estoque ? { location_id: L1, estoque_inicial: estoque } : {}) }, E.token)).j.id;
const REFRI = await produto('Refri E2E', 6, 5);
const ULTIMO = await produto('Ultimo E2E', 10, 1);
const LANCHE = await produto('Lanche E2E', 20, 0);
const AGUA = await produto('Agua E2E', 4, 5);
const PAO = (await api('POST', '/ingredients', { nome: 'Pao E2E', unidade: 'UN', estoque_inicial: 10, custo_total: 10, location_id: L1 }, E.token)).j.id;
check('lanche com ficha tecnica (2 pães)', (await api('POST', `/products/${LANCHE}/ingredients`, { ingredient_id: PAO, quantidade_por_unidade: 2 }, E.token)).s < 300);
const GA = await usuario(E, 'GarcomA', 'Garçom', L1);
const GB = await usuario(E, 'GarcomB', 'Garçom', L1);
const CX = await usuario(E, 'CaixaX', 'Caixa/Operador', L1);
const GER = await usuario(E, 'GerenteX', 'Gerente', L1);
check('cria usuários Garçom/Caixa/Gerente', [GA, GB, CX, GER].every((u) => u.status === 201), [GA.status, GB.status, CX.status, GER.status]);
check('garçom sem loja é recusado (400)', (await api('POST', '/users', { nome: 'SemLoja', email: `e2e.gf1.sl.${SUF}@girostock.local`, senha: rnd(), perfil: 'Garçom' }, E.token)).s === 400);

console.log('\n# 1. Perfil Garçom');
check('login do garçom: perfil e só a área Garcom', GA.usuario.perfil === 'Garçom' && GA.usuario.areas.Garcom === true && !GA.usuario.areas.Vendas && !GA.usuario.areas.Pedidos && !GA.usuario.areas.Estoque, GA.usuario.areas);
const proibidas = ['/products', '/users', '/locations', '/terminals', '/orders', '/sales', '/reports/vendas', '/customers', '/cash-sessions/current?terminal_id=' + T1, '/empresa', '/categories', '/comandas'];
const respProib = await Promise.all(proibidas.map((p) => api('GET', p, null, GA.token)));
check('garçom recebe 403 em cadastros, vendas, caixa, relatórios, usuários e comandas do caixa', respProib.every((r) => r.s === 403), respProib.map((r, i) => `${proibidas[i]}:${r.s}`));
check('garçom usa a busca do cardápio (sem custo)', (await api('GET', `/products/search?location_id=${L1}&q=Refri`, null, GA.token)).s === 200 && !('preco_custo' in ((await api('GET', `/products/search?location_id=${L1}&q=Refri`, null, GA.token)).j[0] || {})));
check('garçom não escreve em cadastros (POST /products 403)', (await api('POST', '/products', { nome: 'x' }, GA.token)).s === 403);

console.log('\n# 2. Abrir mesa e pista');
const m7 = await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '7' }, GA.token);
check('abre a Mesa 7', m7.s === 201 && m7.j.identificador === 'Mesa 7' && m7.j.status === 'aberta' && m7.j.numero === 1, m7.j);
const m7b = await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: 'Mesa 7' }, GA.token);
check('abrir a mesma mesa devolve a existente', m7b.s === 200 && m7b.j.id === m7.j.id && m7b.j.existente === true, m7b.j);
check('pista sem identificador -> 400', (await api('POST', '/garcom/comandas', { tipo: 'pista' }, GA.token)).s === 400);
const p118 = await api('POST', '/garcom/comandas', { tipo: 'pista', identificador: '118', cliente_nome: 'Joana' }, GA.token);
check('abre a pista com pulseira 118 e nome opcional', p118.s === 201 && p118.j.identificador === 'Pulseira 118' && p118.j.cliente_nome === 'Joana' && p118.j.numero === 2, p118.j);
const p119 = await api('POST', '/garcom/comandas', { tipo: 'pista', identificador: '119' }, GA.token);
check('pista sem nome também abre', p119.s === 201 && p119.j.cliente_nome === '');
check('tipo inválido -> 400 e pagamento na hora fica para a Fase 2', (await api('POST', '/garcom/comandas', { tipo: 'balcao', identificador: '1' }, GA.token)).s === 400 && (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '5', modo_pagamento: 'hora' }, GA.token)).s === 400);
const bVe = await api('GET', '/garcom/comandas', null, GB.token);
check('outro garçom não vê a comanda do A (lista vazia e 404 no detalhe)', bVe.s === 200 && bVe.j.length === 0 && (await api('GET', `/garcom/comandas/${m7.j.id}`, null, GB.token)).s === 404);
check('o A vê as suas 3 comandas', (await api('GET', '/garcom/comandas', null, GA.token)).j.length === 3);
const l2 = await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '1', location_id: L2 }, E.token);
check('administrador abre comanda em outra loja', l2.s === 201);
check('garçom da loja 1 não abre nem vê comanda da loja 2', (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '2', location_id: L2 }, GA.token)).s === 403 && (await api('GET', `/garcom/comandas/${l2.j.id}`, null, GA.token)).s === 404);

console.log('\n# 3. Rodadas e reserva de estoque');
const vendasAntes = await contar('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id]);
check('saldos iniciais: refri 5, lanche 5 (10 pães / 2)', (await saldoProduto(GA.token, L1, 'Refri E2E')) === 5 && (await saldoProduto(GA.token, L1, 'Lanche E2E')) === 5);
const cid = uuid();
const r1 = await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: cid, itens: [{ product_id: REFRI, quantidade: 2 }, { product_id: LANCHE, quantidade: 1, observacao: 'sem cebola' }], observacao: 'rápido' }, GA.token);
check('rodada 1 enviada (201, rodada nº 1, total 6×2 + 20)', r1.s === 201 && r1.j.rodadas === 1 && Number(r1.j.total) === 32 && r1.j.rodadas_lista[0].rodada === 1, r1.j);
check('a rodada reservou estoque: refri 3, lanche 4', (await saldoProduto(GA.token, L1, 'Refri E2E')) === 3 && (await saldoProduto(GA.token, L1, 'Lanche E2E')) === 4);
const r1b = await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: cid, itens: [{ product_id: REFRI, quantidade: 2 }, { product_id: LANCHE, quantidade: 1 }] }, GA.token);
check('reenvio com o mesmo client_id NÃO duplica', r1b.s === 200 && r1b.j.repetida === true && r1b.j.rodadas === 1 && (await saldoProduto(GA.token, L1, 'Refri E2E')) === 3, r1b.j);
const ped1 = r1.j.rodadas_lista[0];
check('item guarda o garçom que lançou', ped1.itens.every((i) => i.garcom_id === GA.id && i.garcom_nome === 'GarcomA'), ped1.itens);
check('observação do item (bar ou cozinha) é preservada', ped1.itens.some((i) => i.observacao === 'sem cebola'));
const m8 = await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '8' }, GB.token);
const u1 = await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: ULTIMO, quantidade: 1 }] }, GA.token);
const u2 = await api('POST', `/garcom/comandas/${m8.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: ULTIMO, quantidade: 1 }] }, GB.token);
check('dois garçons, último item: o primeiro leva, o segundo recebe 409', u1.s === 201 && u2.s === 409 && /Sem estoque/.test(u2.j.erro), [u1.s, u2.s, u2.j]);
const disputa = await Promise.all([GA, GB].map((g, i) => api('POST', `/garcom/comandas/${i === 0 ? p118.j.id : m8.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: REFRI, quantidade: 3 }] }, g.token)));
check('pedidos simultâneos do mesmo estoque: só um passa (refri 3 disponíveis)', disputa.filter((r) => r.s === 201).length === 1 && disputa.filter((r) => r.s === 409).length === 1, disputa.map((r) => r.s));
const cancelaRefri = disputa.find((r) => r.s === 201).j;
check('rodada sem itens -> 400', (await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: uuid(), itens: [] }, GA.token)).s === 400);
check('outro garçom não lança na comanda alheia (404)', (await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: REFRI, quantidade: 1 }] }, GB.token)).s === 404);

console.log('\n# 4. Cozinha e invariantes');
const quadro = (await api('GET', '/orders', null, E.token)).j;
const noQuadro = quadro.find((o) => o.id === ped1.id);
check('rodada aparece no quadro de Pedidos com mesa, rodada e garçom', !!noQuadro && noQuadro.comanda_id === m7.j.id && noQuadro.rodada === 1 && noQuadro.garcom_nome === 'GarcomA' && noQuadro.endereco === 'Mesa 7' && noQuadro.tipo === 'mesa', noQuadro);
check('rodada NÃO pode ser finalizada pelo quadro (não gera venda)', (await api('POST', `/orders/${ped1.id}/status`, { para: 'finalizado', forma_pagamento: 'pix' }, E.token)).s === 409);
check('garçom não marca entregue antes de pronto (409)', (await api('POST', `/garcom/rodadas/${ped1.id}/status`, { para: 'entregue' }, GA.token)).s === 409);
check('cozinha: novo -> em_preparo -> pronto', (await api('POST', `/orders/${ped1.id}/status`, { para: 'em_preparo' }, E.token)).s === 200 && (await api('POST', `/orders/${ped1.id}/status`, { para: 'pronto' }, E.token)).s === 200);
check('o outro garçom não marca entregue na rodada alheia (404)', (await api('POST', `/garcom/rodadas/${ped1.id}/status`, { para: 'entregue' }, GB.token)).s === 404);
const ent = await api('POST', `/garcom/rodadas/${ped1.id}/status`, { para: 'entregue' }, GA.token);
check('garçom marca a rodada como entregue', ent.s === 200 && ent.j.rodadas_lista[0].status === 'entregue', ent.j);
check('entregue CONTINUA reservando o lanche (disponível segue 4)', (await saldoProduto(GA.token, L1, 'Lanche E2E')) === 4);
const refriAposEntregue = await saldoProduto(GA.token, L1, 'Refri E2E');
check('refri segue reservado (nenhuma baixa ainda)', refriAposEntregue === 0 && (await contar('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [REFRI, L1])) === 5);
check('rodada de comanda NÃO gerou venda sozinha', (await contar('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id])) === vendasAntes);
check('o quadro não destrói o destino da rodada (409 ao mudar para entrega)', (await api('PUT', `/orders/${ped1.id}/destino`, { tipo: 'entrega', endereco: 'Rua 1' }, E.token)).s === 409);

console.log('\n# 5. Cancelar rodada');
const m9 = (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '9' }, GA.token)).j;
const dispAntes = await saldoProduto(GA.token, L1, 'Lanche E2E');
const rc = await api('POST', `/garcom/comandas/${m9.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GA.token);
check('lanche reservado (4 -> 3)', (await saldoProduto(GA.token, L1, 'Lanche E2E')) === dispAntes - 1, rc.j);
const cr = await api('POST', `/garcom/rodadas/${rc.j.rodada_id}/cancelar`, {}, GA.token);
check('garçom cancela antes do preparo e a reserva (insumos) volta', cr.s === 200 && (await saldoProduto(GA.token, L1, 'Lanche E2E')) === dispAntes, cr.j);
const rc2 = await api('POST', `/garcom/comandas/${m9.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GA.token);
await api('POST', `/orders/${rc2.j.rodada_id}/status`, { para: 'em_preparo' }, E.token);
check('depois do preparo o garçom NÃO cancela (403)', (await api('POST', `/garcom/rodadas/${rc2.j.rodada_id}/cancelar`, { motivo: 'desistiu' }, GA.token)).s === 403);
check('gerente cancela com motivo (e sem motivo é recusado)', (await api('POST', `/garcom/rodadas/${rc2.j.rodada_id}/cancelar`, {}, GER.token)).s === 400 && (await api('POST', `/garcom/rodadas/${rc2.j.rodada_id}/cancelar`, { motivo: 'cliente saiu' }, GER.token)).s === 200);
check('comanda vazia: o garçom a cancela e a mesa é liberada', (await api('POST', `/garcom/comandas/${m9.id}/cancelar`, {}, GA.token)).s === 200 && (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '9' }, GA.token)).s === 201);

console.log('\n# 6. Transferir comanda');
const m10 = (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '10' }, GA.token)).j;
await api('POST', `/garcom/comandas/${m10.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GA.token);
check('só o dono (ou gerente) transfere: B não consegue (404)', (await api('POST', `/garcom/comandas/${m10.id}/transferir`, { para_user_id: GB.id }, GB.token)).s === 404);
check('não transfere a quem não é garçom (caixa)', (await api('POST', `/garcom/comandas/${m10.id}/transferir`, { para_user_id: CX.id }, GA.token)).s === 400);
const colegas = await api('GET', `/garcom/colegas?location_id=${L1}`, null, GA.token);
check('lista de colegas traz só garçons', colegas.s === 200 && colegas.j.some((u) => u.id === GB.id) && !colegas.j.some((u) => u.id === CX.id), colegas.j);
const tr = await api('POST', `/garcom/comandas/${m10.id}/transferir`, { para_user_id: GB.id }, GA.token);
check('transfere a comanda para o B', tr.s === 200 && tr.j.aberta_por === GB.id, tr.j);
const rb = await api('POST', `/garcom/comandas/${m10.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: REFRI, quantidade: 0.5 }] }, GB.token);
check('quantidade fracionada de UN -> 400', rb.s === 400);
await api('POST', `/garcom/comandas/${m10.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GB.token);
const donos = (await prod.query(`SELECT u.nome FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN users u ON u.id = oi.garcom_id WHERE o.comanda_id = $1 ORDER BY o.rodada`, [m10.id])).rows.map((r) => r.nome);
check('itens antigos continuam do A; o novo é do B', donos.join(',') === 'GarcomA,GarcomB', donos);
check('B vê a comanda transferida e A continua vendo (tem itens nela)', (await api('GET', `/garcom/comandas/${m10.id}`, null, GB.token)).s === 200 && (await api('GET', `/garcom/comandas/${m10.id}`, null, GA.token)).s === 200);

console.log('\n# 7. Pedir fechamento e reabrir');
const pf = await api('POST', `/garcom/comandas/${m7.j.id}/pedir-fechamento`, null, GA.token);
check('pede fechamento (avisa que há rodada não entregue? aqui as duas rodadas ainda não)', pf.s === 200 && pf.j.status === 'fechamento_solicitado' && Array.isArray(pf.j.avisos), pf.j);
check('não lança nova rodada depois de pedir fechamento (409)', (await api('POST', `/garcom/comandas/${m7.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GA.token)).s === 409);
const lista = await api('GET', '/comandas', null, CX.token);
check('caixa vê a comanda com fechamento solicitado destacada (primeira da lista)', lista.s === 200 && lista.j[0].id === m7.j.id && lista.j[0].status === 'fechamento_solicitado', lista.j.map((c) => `${c.identificador}:${c.status}`));
check('busca por mesa no caixa', (await api('GET', '/comandas?q=Mesa%207', null, CX.token)).j.length === 1);
check('garçom não reabre (403); gerente reabre', (await api('POST', `/garcom/comandas/${m7.j.id}/reabrir`, null, GA.token)).s === 403 && (await api('POST', `/garcom/comandas/${m7.j.id}/reabrir`, null, GER.token)).s === 200);
await api('POST', `/garcom/comandas/${m7.j.id}/pedir-fechamento`, null, GA.token);

console.log('\n# 8. Fechar no caixa');
check('sem caixa aberto no terminal -> 409', (await api('POST', `/comandas/${m7.j.id}/fechar`, { terminal_id: T2, forma_pagamento: 'pix' }, CX.token)).s === 409);
check('desconto exige permissão (caixa sem Desconto -> 403)', (await api('POST', `/comandas/${m7.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix', desconto: 1 }, CX.token)).s === 403);
check('dinheiro com valor menor que o total -> 400 e nada muda', (await api('POST', `/comandas/${m7.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'dinheiro', valor_recebido: 5 }, CX.token)).s === 400 && (await contar('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id])) === vendasAntes);
const fe = await api('POST', `/comandas/${m7.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'dinheiro', valor_recebido: 100 }, CX.token);
check('fecha: comanda paga com uma venda', fe.s === 200 && fe.j.comanda.status === 'paga' && !!fe.j.venda.id, fe.j);
const total7 = Number(fe.j.comanda.total);
check('total da venda = itens das rodadas (2 refri + 1 lanche + 1 último = 6×2+20+10 = 42)', Number(fe.j.venda.total) === 42 && total7 === 42, fe.j.venda);
check('exatamente UMA venda nova, com os itens', (await contar('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id])) === vendasAntes + 1 && (await contar('SELECT count(*) AS n FROM sale_items WHERE sale_id = $1', [fe.j.venda.id])) === 3);
check('itens da venda guardam o garçom', (await contar('SELECT count(*) AS n FROM sale_items WHERE sale_id = $1 AND garcom_id = $2', [fe.j.venda.id, GA.id])) === 3);
check('estoque baixado UMA vez: refri 5→3, último 1→0, pães 10→8', (await contar('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [REFRI, L1])) === 3
  && (await contar('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [ULTIMO, L1])) === 0
  && (await contar('SELECT saldo AS n FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2', [PAO, L1])) === 8);
const rodSt = (await prod.query(`SELECT DISTINCT status, sale_id FROM orders WHERE comanda_id = $1`, [m7.j.id])).rows;
check('rodadas ficam finalizadas e ligadas à venda', rodSt.length === 1 && rodSt[0].status === 'finalizado' && rodSt[0].sale_id === fe.j.venda.id, rodSt);
check('dinheiro entra no caixa aberto (venda ligada à sessão do caixa 1)', (await contar(`SELECT count(*) AS n FROM sales s JOIN cash_sessions cs ON cs.id = s.cash_session_id JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE s.id = $1 AND cr.terminal_id = $2 AND s.forma_pagamento = 'dinheiro'`, [fe.j.venda.id, T1])) === 1);
check('fechar de novo -> 409', (await api('POST', `/comandas/${m7.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix' }, CX.token)).s === 409);
const ext = await api('GET', '/garcom/extrato', null, GA.token);
check('extrato do garçom lista a comanda paga com o total dele (sem comissão)', ext.s === 200 && ext.j.pagas.some((p) => p.id === m7.j.id && Number(p.meu_total) === 42) && Number(ext.j.total_vendido) === 42 && !('comissao' in ext.j), ext.j);
check('comanda sem pedidos não fecha; vazia cancela pelo caixa/gerente', (await api('POST', `/comandas/${p119.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix' }, CX.token)).s === 409 && (await api('POST', `/garcom/comandas/${p119.j.id}/cancelar`, {}, GER.token)).s === 200);

console.log('\n# 9. Módulo desligado, isolamento e regressão');
check('comanda com pedidos: garçom não cancela (403); gerente exige motivo (400) e depois cancela', (await api('POST', `/garcom/comandas/${m10.id}/cancelar`, { motivo: 'teste' }, GA.token)).s === 403 && (await api('POST', `/garcom/comandas/${m10.id}/cancelar`, {}, GER.token)).s === 400);
const dispAntesCancelar = await saldoProduto(GER.token, L1, 'Lanche E2E');
check('gerente cancela a comanda inteira e a reserva dos pedidos volta', (await api('POST', `/garcom/comandas/${m10.id}/cancelar`, { motivo: 'cliente desistiu' }, GER.token)).s === 200 && (await saldoProduto(GER.token, L1, 'Lanche E2E')) === dispAntesCancelar + 2, dispAntesCancelar);
const m11 = (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '11' }, GA.token)).j;
const r11 = await api('POST', `/garcom/comandas/${m11.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1 }] }, GA.token);
await api('POST', `/orders/${r11.j.rodada_id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${r11.j.rodada_id}/status`, { para: 'pronto' }, E.token);
await api('POST', `/garcom/rodadas/${r11.j.rodada_id}/status`, { para: 'entregue' }, GA.token);
check('comanda com rodada ENTREGUE não cancela: precisa fechar no caixa (409)', (await api('POST', `/garcom/comandas/${m11.id}/cancelar`, { motivo: 'teste' }, GER.token)).s === 409);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: false } }, MAS);
check('módulo desligado: garçom 403 e sem a área no /me', (await api('GET', '/garcom/comandas', null, GA.token)).s === 403 && (await api('GET', '/auth/me', null, GA.token)).j.areas.Garcom === false);
check('módulo desligado: caixa não acessa /comandas (403)', (await api('GET', '/comandas', null, CX.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: true } }, MAS);
check('módulo religado: volta a funcionar', (await api('GET', '/garcom/comandas', null, GA.token)).s === 200);
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { pedidos: true, garcom: true } }, MAS);
const LF = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [F.id])).rows[0].id;
await api('PATCH', `/locations/${LF}`, { usa_pedidos: true }, F.token);
const GF = await usuario(F, 'GarcomF', 'Garçom', LF);
check('outra empresa não vê comandas da primeira (404) e a lista é só dela', (await api('GET', `/garcom/comandas/${m10.id}`, null, GF.token)).s === 404 && (await api('GET', '/garcom/comandas', null, GF.token)).j.length === 0);
check('outra empresa não usa o terminal/produto da primeira (404/400)', (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '1', location_id: L1 }, GF.token)).s >= 400);
const pm = await api('POST', '/orders', { location_id: L1, tipo: 'mesa', endereco: 'Mesa 20', itens: [{ product_id: LANCHE, quantidade: 1 }] }, E.token);
check('regressão: pedido de mesa comum continua (201) e finaliza gerando venda', pm.s === 201 && pm.j.comanda_id === null);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'pronto' }, E.token);
check('regressão: pedido comum vai a finalizado com venda', (await api('POST', `/orders/${pm.j.id}/status`, { para: 'finalizado', forma_pagamento: 'pix', terminal_id: T1 }, E.token)).s === 200);
const vd = await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: AGUA, quantidade: 1 }], forma_pagamento: 'pix' }, E.token);
check('regressão: venda direta no PDV (201)', vd.s === 201, vd.j);

console.log('\n# 10. Complementos na rodada e no fechamento');
const grp = (await api('POST', '/complement-groups', { nome: 'Extras E2E', minimo: 0, maximo: 2 }, E.token)).j;
const grpOp = (await api('POST', `/complement-groups/${grp.id}/options`, { nome: 'Pao extra', preco: 3, ingredient_id: PAO, quantidade_insumo: 1 }, E.token)).j;
const COMP = grpOp.opcoes[0].id;
await api('PUT', `/products/${LANCHE}/complement-groups`, { grupos: [grp.id] }, E.token);
const busca = (await api('GET', `/products/search?location_id=${L1}&q=Lanche%20E2E`, null, GA.token)).j[0];
check('a busca do garçom traz os grupos de complementos do lanche', busca && busca.grupos.length === 1 && busca.grupos[0].opcoes.length === 1, busca);
const m12 = (await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '12' }, GA.token)).j;
const paoAntes = await contar('SELECT saldo AS n FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2', [PAO, L1]);
const dispLancheAntes = await saldoProduto(GA.token, L1, 'Lanche E2E');
const rc12 = await api('POST', `/garcom/comandas/${m12.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: LANCHE, quantidade: 1, complementos: [{ id: COMP, quantidade: 2 }] }] }, GA.token);
check('rodada com complemento: preço = 20 + 2×3 = 26', rc12.s === 201 && Number(rc12.j.total) === 26, rc12.j);
check('o complemento reserva insumo (pães: 2 da ficha + 2 do extra)', (await saldoProduto(GA.token, L1, 'Lanche E2E')) < dispLancheAntes, [dispLancheAntes, await saldoProduto(GA.token, L1, 'Lanche E2E')]);
await api('POST', `/garcom/comandas/${m12.id}/pedir-fechamento`, null, GA.token);
const fe12 = await api('POST', `/comandas/${m12.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix' }, CX.token);
check('fecha com o complemento: venda de 26', fe12.s === 200 && Number(fe12.j.venda.total) === 26, fe12.j);
check('insumos baixados na venda: 2 da ficha + 2 do complemento = 4 pães', (await contar('SELECT saldo AS n FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2', [PAO, L1])) === paoAntes - 4);

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.gf1.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E GF1 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
