// e2e: preço de venda por loja, desconto por quantidade (pack/atacado) e produto que vira insumo na transferência.
//   npm run test:e2e:precos   (API em http://localhost:3000; banco com migrations e seed)
// Cria empresas novas pelo Master (isoladas) e usa apenas dados dela.
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
const EMAIL_M = 'e2e.precos.master@girostock.local';
const SENHA_M = rnd();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 500)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const uuid = () => crypto.randomUUID();
const num = (x) => Number(x);

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E Precos Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.precos.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E Precos ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Distribuidora', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId) {
  const email = `e2e.precos.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j.token, status: r.s };
}

console.log('\n# Preparo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true } }, MAS);
const L1 = (await db.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
await api('PATCH', `/locations/${L1}`, { usa_pedidos: true }, E.token);
const L2 = (await api('POST', '/locations', { nome: 'Casa de show', usa_pedidos: true }, E.token)).j.id;
const L3 = (await api('POST', '/locations', { nome: 'Bar fechado' }, E.token)).j.id;
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, E.token)).j.id;
const T2 = (await api('POST', '/terminals', { location_id: L2, nome: 'Caixa show' }, E.token)).j.id;
const T3 = (await api('POST', '/terminals', { location_id: L3, nome: 'Caixa bar' }, E.token)).j.id;
for (const t of [T1, T2, T3]) await api('POST', '/cash-sessions', { terminal_id: t, valor_inicial: 100 }, E.token);
await api('POST', '/categories', { nome: 'Bebidas' }, E.token);
const cat = (await api('GET', '/categories', null, E.token)).j[0].id;
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const entrada = (pid, loja, qtd) => api('POST', '/stock-movements', { product_id: pid, tipo: 'entrada', quantidade: qtd, location_destino_id: loja, motivo: 'e2e' }, E.token);
async function produto(nome, custo, venda, { unidade = 'UN', estoque = 200, extra = {} } = {}) {
  const r = await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade, preco_custo: custo, preco_venda: venda, ...extra }, E.token);
  if (r.s !== 201) return { id: null, r };
  for (const l of [L1, L2, L3]) if (estoque) await entrada(r.j.id, l, estoque);
  return { id: r.j.id, barcode: r.j.barcode, r };
}
const venda = (terminal, itens, extra = {}) => api('POST', '/sales', { terminal_id: terminal, itens, forma_pagamento: 'pix', ...extra }, E.token);
const itensDb = async (saleId) => (await db.query('SELECT product_id, quantidade, preco_unitario, preco_tabela, faixa_rotulo, subtotal FROM sale_items WHERE sale_id = $1 ORDER BY id', [saleId])).rows;
const busca = (tok, query) => api('GET', `/products/search?${query}`, null, tok);

const MONSTER = await produto('Monster E2E', 5, 9.5);
check('produto de teste criado (custo 5, venda 9,50)', !!MONSTER.id, MONSTER.r);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 1. Preço por loja');
const pl1 = await api('PUT', `/products/${MONSTER.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 11 }, { location_id: L3, vende: false }] }, E.token);
check('grava preço da Casa de show (11,00) e "não vende" no Bar', pl1.s === 200, pl1);
const ficha = await api('GET', `/products/${MONSTER.id}`, null, E.token);
const pl = Object.fromEntries((ficha.j.precos_lojas || []).map((l) => [l.location_id, l]));
check('Distribuidora herda o preço padrão (9,50); Casa de show tem 11,00; Bar não vende', pl[L1] && pl[L1].preco_venda === null && pl[L1].preco_efetivo === 9.5 && pl[L2].preco_efetivo === 11 && pl[L3].vende === false, ficha.j.precos_lojas);
check('margem por loja com custo único (47,4% e 54,5%)', pl[L1].margem_pct === 47.4 && pl[L2].margem_pct === 54.5 && pl[L2].lucro_unitario === 6, [pl[L1].margem_pct, pl[L2].margem_pct]);
const b1 = await busca(E.token, `terminal_id=${T1}&q=Monster E2E`);
const b2 = await busca(E.token, `terminal_id=${T2}&q=Monster E2E`);
const b3 = await busca(E.token, `terminal_id=${T3}&q=Monster E2E`);
check('busca do PDV: Distribuidora 9,50 / Casa de show 11,00', b1.j[0] && num(b1.j[0].preco_venda) === 9.5 && b2.j[0] && num(b2.j[0].preco_venda) === 11, [b1.j, b2.j]);
check('produto que a loja não vende NÃO aparece (busca por nome e por código de barras)', b3.s === 200 && b3.j.length === 0 && (await busca(E.token, `terminal_id=${T3}&barcode=${MONSTER.barcode}`)).j.length === 0, b3.j);
const v1 = await venda(T1, [{ product_id: MONSTER.id, quantidade: 1 }]);
const v2 = await venda(T2, [{ product_id: MONSTER.id, quantidade: 1 }]);
check('venda cobra o preço da loja do terminal (9,50 e 11,00)', v1.s === 201 && num(v1.j.total) === 9.5 && v2.s === 201 && num(v2.j.total) === 11, [v1.j, v2.j]);
check('o preço enviado pelo cliente é ignorado (servidor é a verdade)', num((await venda(T1, [{ product_id: MONSTER.id, quantidade: 1, preco_unitario: 0.01 }])).j.total) === 9.5);
const vN = await venda(T3, [{ product_id: MONSTER.id, quantidade: 1 }]);
check('venda direta pela API de produto "não vende" na loja -> 400', vN.s === 400 && /não é vendido/.test(JSON.stringify(vN.j)), vN);
const pedN = await api('POST', '/orders', { location_id: L3, origem: 'balcao', tipo: 'retirada', itens: [{ product_id: MONSTER.id, quantidade: 1 }] }, E.token);
check('pedido de produto "não vende" na loja -> 400', pedN.s === 400, pedN);
check('preço de loja inválido (0 ou texto) -> 400', (await api('PUT', `/products/${MONSTER.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 0 }] }, E.token)).s === 400 && (await api('PUT', `/products/${MONSTER.id}`, { precos_lojas: [{ location_id: uuid(), preco_venda: 5 }] }, E.token)).s === 400);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 2. Faixa automática (pack/atacado, gerais)');
const fx = await api('PUT', `/products/${MONSTER.id}`, { faixas: [
  { rotulo: 'Pack 6', quantidade_minima: 6, modo_cadastro: 'kit', valor_cadastro: 48, automatica: true },
  { rotulo: 'Caixa 24', quantidade_minima: 24, modo_cadastro: 'unitario', valor_cadastro: 7.2, automatica: true },
] }, E.token);
check('grava faixas (kit R$ 48,00 por 6 un = 8,00 cada; 24 un a 7,20)', fx.s === 200, fx);
const f2 = (await api('GET', `/products/${MONSTER.id}`, null, E.token)).j.faixas;
check('a tela recebe por unidade, kit, desconto % e margem de cada faixa', f2.length === 2 && f2[0].preco_unitario === 8 && f2[0].kit === 48 && f2[0].desconto_pct === 15.8 && f2[0].margem_pct === 37.5 && f2[0].modo_cadastro === 'kit' && f2[0].valor_cadastro === 48, f2);
const q = {};
for (const n of [1, 5, 6, 8, 24]) q[n] = await venda(T1, [{ product_id: MONSTER.id, quantidade: n }], n === 8 ? { forma_pagamento: 'dinheiro', valor_recebido: 100 } : {});
check('1 un = preço da loja (9,50); 5 un = 47,50 (sem faixa)', num(q[1].j.total) === 9.5 && num(q[5].j.total) === 47.5, [q[1].j.total, q[5].j.total]);
check('6 un = 6 × 8,00 = 48,00', num(q[6].j.total) === 48, q[6].j);
check('8 un = 8 × 8,00 = 64,00 (NÃO "6 no pack + 2 avulsas") e o troco de R$ 100 é 36,00', num(q[8].j.total) === 64 && num(q[8].j.troco) === 36, q[8].j);
check('24 un = faixa maior: 24 × 7,20 = 172,80', num(q[24].j.total) === 172.8, q[24].j);
const i8 = (await itensDb(q[8].j.id))[0];
const i1 = (await itensDb(q[1].j.id))[0];
check('sale_items guarda preço cobrado (8,00), preço de tabela (9,50) e o rótulo da faixa', num(i8.preco_unitario) === 8 && num(i8.preco_tabela) === 9.5 && i8.faixa_rotulo === 'Pack 6' && num(i8.subtotal) === 64, i8);
check('venda sem faixa: preco_tabela e faixa_rotulo nulos', i1.preco_tabela === null && i1.faixa_rotulo === null, i1);
check('baixa o estoque da quantidade vendida (8 un)', num((await busca(E.token, `terminal_id=${T1}&q=Monster E2E`)).j[0].saldo) === 200 - 1 - 1 - 1 - 5 - 6 - 8 - 24, null);
const vCx = await db.query(`SELECT COALESCE(SUM(s.total), 0) AS t FROM sales s WHERE s.tenant_id = $1 AND s.terminal_id = $2 AND s.status = 'concluida'`, [E.id, T1]);
check('total do caixa = soma das vendas (9,50 ×3 + 47,50 + 48 + 64 + 172,80)', num(vCx.rows[0].t) === 9.5 * 3 + 47.5 + 48 + 64 + 172.8, vCx.rows[0]);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 3. Faixa manual');
const ATAC = await produto('Atacado E2E', 5, 10);
const fm = await api('PUT', `/products/${ATAC.id}`, { faixas: [
  { rotulo: 'Pack 6', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 8, automatica: true },
  { rotulo: 'Atacado 12', quantidade_minima: 12, modo_cadastro: 'unitario', valor_cadastro: 7, automatica: false },
] }, E.token);
check('grava uma automática (6 un) e uma manual (12 un)', fm.s === 200, fm);
const fxAt = (await api('GET', `/products/${ATAC.id}`, null, E.token)).j.faixas;
const fidManual = fxAt.find((f) => f.automatica === false).id;
check('busca do PDV traz as faixas elegíveis (rótulo, mínimo, preço, kit, automática)', (await busca(E.token, `terminal_id=${T1}&q=Atacado E2E`)).j[0].faixas.length === 2);
check('12 un SEM faixa_id: a manual não se aplica (fica a automática: 12 × 8,00 = 96,00)', num((await venda(T1, [{ product_id: ATAC.id, quantidade: 12 }])).j.total) === 96);
const mm = await venda(T1, [{ product_id: ATAC.id, quantidade: 12, faixa_id: fidManual }]);
check('12 un COM faixa_id: automática (8,00) e manual (7,00) elegíveis -> vale a de menor preço, sem empilhar: 84,00', num(mm.j.total) === 84, mm.j);
check('rótulo gravado é o da faixa que valeu', (await itensDb(mm.j.id))[0].faixa_rotulo === 'Atacado 12');
const mq = await venda(T1, [{ product_id: ATAC.id, quantidade: 8, faixa_id: fidManual }]);
check('faixa manual com quantidade abaixo do mínimo (8 < 12) -> 400', mq.s === 400 && /exige no mínimo 12/.test(JSON.stringify(mq.j)), mq);
check('faixa_id de outro produto/inexistente -> 400', (await venda(T1, [{ product_id: ATAC.id, quantidade: 12, faixa_id: uuid() }])).s === 400);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 4. Lojas diferentes, regras diferentes');
const GL = await produto('Regras E2E', 5, 10);
const fl = await api('PUT', `/products/${GL.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 12 }], faixas: [
  { rotulo: 'Pack 6', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 8, automatica: true },
  { location_id: L2, rotulo: 'Show 4', quantidade_minima: 4, modo_cadastro: 'unitario', valor_cadastro: 9.5, automatica: false },
] }, E.token);
check('geral automática (6 un) + faixa própria manual na Casa de show (4 un)', fl.s === 200, fl);
check('Distribuidora (sem faixas próprias) herda as gerais: 6 un × 8,00 = 48,00', num((await venda(T1, [{ product_id: GL.id, quantidade: 6 }])).j.total) === 48);
check('Casa de show tem faixa própria: as gerais NÃO valem lá (6 un × 12,00 = 72,00)', num((await venda(T2, [{ product_id: GL.id, quantidade: 6 }])).j.total) === 72);
const fidShow = (await api('GET', `/products/${GL.id}`, null, E.token)).j.faixas.find((f) => f.location_id === L2).id;
check('Casa de show com a faixa manual: 6 un × 9,50 = 57,00', num((await venda(T2, [{ product_id: GL.id, quantidade: 6, faixa_id: fidShow }])).j.total) === 57);
check('faixa da Casa de show não vale na Distribuidora (faixa_id -> 400)', (await venda(T1, [{ product_id: GL.id, quantidade: 6, faixa_id: fidShow }])).s === 400);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 5. Mesmo produto soma; produtos diferentes não');
const R1 = await produto('Refri E2E', 3, 6);
const soma = await venda(T1, [{ product_id: MONSTER.id, quantidade: 4, observacao: 'sem gelo' }, { product_id: MONSTER.id, quantidade: 2, observacao: 'com gelo' }]);
check('duas linhas do mesmo produto (4 + 2) somam 6 -> 6 × 8,00 = 48,00', num(soma.j.total) === 48, soma.j);
const mist = await venda(T1, [{ product_id: MONSTER.id, quantidade: 3 }, { product_id: R1.id, quantidade: 3 }]);
check('produtos diferentes NÃO somam (3 × 9,50 + 3 × 6,00 = 46,50)', num(mist.j.total) === 46.5, mist.j);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 6. Pedido, rodadas e comanda');
const ped = await api('POST', '/orders', { location_id: L1, origem: 'balcao', tipo: 'retirada', itens: [{ product_id: MONSTER.id, quantidade: 6 }] }, E.token);
check('pedido com 6 un recebe a faixa (6 × 8,00)', ped.s === 201 && num(ped.j.total) === 48, ped.j);
await api('PUT', `/products/${MONSTER.id}`, { preco_venda: 12 }, E.token);
check('mudar o preço padrão (para 12,00) reconfere as faixas e não quebra (todas < 12)', (await api('GET', `/products/${MONSTER.id}`, null, E.token)).j.faixas.length === 2);
await api('POST', `/orders/${ped.j.id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${ped.j.id}/status`, { para: 'pronto' }, E.token);
const fin = await api('POST', `/orders/${ped.j.id}/status`, { para: 'finalizado', forma_pagamento: 'pix' }, E.token);
const saleDoPedido = fin.s === 200 ? (await db.query('SELECT sale_id FROM orders WHERE id = $1', [ped.j.id])).rows[0].sale_id : null;
const itPed = saleDoPedido ? (await itensDb(saleDoPedido))[0] : null;
check('ao finalizar, a venda mantém o preço do pedido (8,00 e faixa Pack 6), mesmo com o preço padrão mudado', itPed && num(itPed.preco_unitario) === 8 && itPed.faixa_rotulo === 'Pack 6' && num(itPed.preco_tabela) === 9.5, [fin.s, itPed]);
await api('PUT', `/products/${MONSTER.id}`, { preco_venda: 9.5 }, E.token);

const GA = await usuario(E, 'GarcomA', 'Garçom', L1);
const CX = await usuario(E, 'CaixaX', 'Caixa/Operador', L1);
check('cria garçom e caixa', GA.status === 201 && CX.status === 201, [GA.status, CX.status]);
const mesa = await api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: '7' }, GA.token);
const ra = await api('POST', `/garcom/comandas/${mesa.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: MONSTER.id, quantidade: 3 }] }, GA.token);
const rb = await api('POST', `/garcom/comandas/${mesa.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: MONSTER.id, quantidade: 3 }] }, GA.token);
check('duas rodadas de 3 un NÃO atingem a faixa de 6 (cada rodada é isolada): 3 × 9,50 cada', ra.s === 201 && rb.s === 201 && num(rb.j.total) === 57, [ra.s, rb.s, rb.j.total]);
const fe = await api('POST', `/comandas/${mesa.j.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix' }, CX.token);
check('o fechamento da comanda REPETE os preços das rodadas (57,00, não 48,00)', fe.s === 200 && num(fe.j.total ?? fe.j.venda?.total) === 57, fe.j);
const saleCom = (await db.query('SELECT s.id FROM sales s WHERE s.comanda_id = $1', [mesa.j.id])).rows[0];
check('a venda da comanda guarda 9,50 por unidade e nenhuma faixa', saleCom && (await itensDb(saleCom.id)).every((i) => num(i.preco_unitario) === 9.5 && i.faixa_rotulo === null));
const rc = await api('POST', `/garcom/comandas`, { tipo: 'mesa', identificador: '8' }, GA.token);
const rpack = await api('POST', `/garcom/comandas/${rc.j.id}/rodadas`, { client_id: uuid(), itens: [{ product_id: MONSTER.id, quantidade: 6 }] }, GA.token);
check('uma rodada com 6 un de uma vez recebe a faixa (6 × 8,00 = 48,00)', rpack.s === 201 && num(rpack.j.total) === 48, rpack.j.total);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 7. EAN do pack');
const EAN = '7891000' + String(Date.now()).slice(-6);
const ep = await api('PUT', `/products/${R1.id}`, { faixas: [{ rotulo: 'Fardo 6', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 5, automatica: true, ean_pack: EAN }] }, E.token);
check('grava faixa com código de barras do pack', ep.s === 200, ep);
const lido = await busca(E.token, `terminal_id=${T1}&barcode=${EAN}`);
check('ler o EAN do pack devolve o produto com a quantidade da faixa (6) e a faixa marcada', lido.j.length === 1 && lido.j[0].id === R1.id && lido.j[0].quantidade_pack === 6 && !!lido.j[0].faixa_pack_id, lido.j);
check('EAN do pack já usado em outro produto -> 409', (await api('PUT', `/products/${ATAC.id}`, { faixas: [{ rotulo: 'X', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 8, ean_pack: EAN }] }, E.token)).s === 409);
check('EAN do pack igual ao código de barras de um produto -> 409', (await api('PUT', `/products/${R1.id}`, { faixas: [{ rotulo: 'X', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 5, ean_pack: MONSTER.barcode }] }, E.token)).s === 409);
check('EAN do pack com menos de 8 números -> 400', (await api('PUT', `/products/${R1.id}`, { faixas: [{ rotulo: 'X', quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 5, ean_pack: '123' }] }, E.token)).s === 400);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 8. Validações das faixas');
const V = await produto('Validacao E2E', 5, 10, { estoque: 0 });
const put = (faixas) => api('PUT', `/products/${V.id}`, { faixas }, E.token);
check('faixa com preço >= preço unitário -> 400', (await put([{ quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 10 }])).s === 400);
check('quantidades repetidas -> 400', (await put([{ quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 8 }, { quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 7 }])).s === 400);
check('preços que não diminuem com a quantidade -> 400', (await put([{ quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 8 }, { quantidade_minima: 12, modo_cadastro: 'unitario', valor_cadastro: 9 }])).s === 400);
const kitRuim = await put([{ quantidade_minima: 6, modo_cadastro: 'kit', valor_cadastro: 50 }]);
check('kit que não divide em centavos (R$ 50,00 ÷ 6) -> 400 pedindo outro valor', kitRuim.s === 400 && /não divide em centavos/.test(JSON.stringify(kitRuim.j)), kitRuim.j);
check('quantidade mínima 1 ou fracionada -> 400', (await put([{ quantidade_minima: 1, modo_cadastro: 'unitario', valor_cadastro: 8 }])).s === 400 && (await put([{ quantidade_minima: 2.5, modo_cadastro: 'unitario', valor_cadastro: 8 }])).s === 400);
const pct = await put([{ quantidade_minima: 6, modo_cadastro: 'percentual', valor_cadastro: 15 }]);
check('percentual (15% de 10,00) vira 8,50 por unidade', pct.s === 200 && (await api('GET', `/products/${V.id}`, null, E.token)).j.faixas[0].preco_unitario === 8.5, pct);
const baixo = await put([{ quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 4.5 }]);
check('preço da faixa abaixo do custo: PERMITE, mas avisa', baixo.s === 200 && Array.isArray(baixo.j.avisos_precos) && baixo.j.avisos_precos.length >= 1 && /custo/.test(baixo.j.avisos_precos[0]), baixo.j);
const combo = await api('POST', '/products', { nome: 'Combo E2E', categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 8, preco_venda: 20, combo: [{ product_id: R1.id, quantidade: 1 }, { product_id: MONSTER.id, quantidade: 1 }] }, E.token);
check('cria um combo', combo.s === 201, combo);
check('faixa em combo é recusada (400)', (await api('PUT', `/products/${combo.j.id}`, { faixas: [{ quantidade_minima: 6, modo_cadastro: 'unitario', valor_cadastro: 15 }] }, E.token)).s === 400);
check('combo aceita preço por loja', (await api('PUT', `/products/${combo.j.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 25 }] }, E.token)).s === 200);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 9. Produto que vira insumo na transferência');
const OLEO = await produto('Oleo E2E', 8, 15, { unidade: 'L', estoque: 0 });
await entrada(OLEO.id, L1, 10);
const insumo = async (id) => (await api('GET', '/ingredients', null, E.token)).j.find((i) => i.id === id) || {};
const insumoSaldo = async (id, loja) => { const x = await insumo(id); return num(((x.saldos_por_local || []).find((s) => s.location_id === loja) || {}).saldo || 0); };
const produtoSaldo = async (id, loja) => { const x = (await api('GET', `/products/${id}`, null, E.token)).j; return num(((x.saldos_por_local || []).find((s) => s.location_id === loja) || {}).saldo || 0); };
const cv0 = await api('PUT', `/products/${OLEO.id}`, { conversao: { criar_insumo: { nome: 'Oleo (ml) E2E', unidade: 'ML' }, fator: 1000, modo: 'perguntar', lojas: [L2] } }, E.token);
check('configura a conversão: 1 L = 1.000 ML, cria o insumo a partir do produto, só na Casa de show', cv0.s === 200, cv0);
const cfg = (await api('GET', `/products/${OLEO.id}`, null, E.token)).j.conversao;
check('o cadastro devolve a conversão (insumo, fator, modo, lojas, custo calculado 0,008 por ML)', cfg && cfg.fator === 1000 && cfg.modo === 'perguntar' && cfg.lojas.length === 1 && cfg.lojas[0] === L2 && cfg.ingredient_unidade === 'ML' && cfg.custo_calculado === 0.008, cfg);
const INS = cfg.ingredient_id;
const tr = (corpo) => api('POST', '/stock-movements', { product_id: OLEO.id, tipo: 'transferencia', location_origem_id: L1, location_destino_id: L2, motivo: 'para a lanchonete', ...corpo }, E.token);
const prev = await api('GET', `/stock-movements/conversao?product_id=${OLEO.id}&location_destino_id=${L2}&quantidade=3`, null, E.token);
check('prévia da conversão: 3 L viram +3.000 ML (saldo do insumo 0 -> 3.000)', prev.s === 200 && prev.j.aplica === true && prev.j.quantidade_insumo === 3000 && prev.j.saldo_insumo_antes === 0 && prev.j.saldo_insumo_depois === 3000, prev.j);
check('prévia para um destino sem conversão: aplica = false', (await api('GET', `/stock-movements/conversao?product_id=${OLEO.id}&location_destino_id=${L3}&quantidade=3`, null, E.token)).j.aplica === false);
const semResp = await tr({ quantidade: 3 });
check('modo "perguntar" sem converter_em_insumo -> 400 "informe se converte em insumo"', semResp.s === 400 && /informe se converte/.test(JSON.stringify(semResp.j)), semResp);
const manter = await tr({ quantidade: 1, converter_em_insumo: false });
check('converter_em_insumo: false mantém como produto (1 L chega à Casa de show; insumo não muda)', manter.s === 201 && (await produtoSaldo(OLEO.id, L2)) === 1 && (await produtoSaldo(OLEO.id, L1)) === 9 && (await insumoSaldo(INS, L2)) === 0, manter);
await api('PUT', `/products/${OLEO.id}`, { preco_custo: 9, preco_venda: 15 }, E.token);
const conv = await tr({ quantidade: 3, converter_em_insumo: true });
check('transferir 3 L convertendo: origem −3 L, produto NÃO chega ao destino, insumo +3.000 ML', conv.s === 201 && (await produtoSaldo(OLEO.id, L1)) === 6 && (await produtoSaldo(OLEO.id, L2)) === 1 && (await insumoSaldo(INS, L2)) === 3000, conv);
check('a resposta traz o que entrou no insumo (3.000 ML, saldo 0 -> 3.000)', conv.j.convertido_em_insumo && conv.j.convertido_em_insumo.quantidade === 3000 && conv.j.convertido_em_insumo.saldo_novo === 3000, conv.j);
const insAp = await insumo(INS);
check('custo do insumo = custo do produto ÷ fator (9,00 ÷ 1000 = 0,009 por ML)', num(insAp.custo_unitario) === 0.009, insAp.custo_unitario);
const hist = (await api('GET', `/stock-movements?limit=100`, null, E.token)).j;
const linhas = hist.movimentos || hist.itens || hist.rows || hist;
const hProd = (Array.isArray(linhas) ? linhas : []).find((m) => m.origem === 'produto' && num(m.quantidade) === 3 && /conversão em insumo/.test(m.motivo));
const hIns = (Array.isArray(linhas) ? linhas : []).find((m) => m.origem === 'insumo' && num(m.quantidade) === 3000 && /conversão em insumo/.test(m.motivo));
check('histórico: os dois lados aparecem como "Transferência com conversão em insumo"', !!hProd && !!hIns, { hProd: !!hProd, hIns: !!hIns, amostra: Array.isArray(linhas) ? linhas.slice(0, 2) : linhas });
const ligado = (await db.query(`SELECT sm.id, sm.conversao_ingredient_id, sm.conversao_quantidade, al.detalhes->>'stock_movement_id' AS ligado FROM stock_movements sm
  JOIN audit_logs al ON al.acao = 'entrada_conversao' AND al.detalhes->>'stock_movement_id' = sm.id::text WHERE sm.tenant_id = $1 AND sm.conversao_ingredient_id IS NOT NULL`, [E.id])).rows;
check('os dois movimentos são ligados pelo id (movimento do produto <-> auditoria do insumo)', ligado.length === 1 && num(ligado[0].conversao_quantidade) === 3000 && ligado[0].conversao_ingredient_id === INS, ligado);
const dest3 = await api('POST', '/stock-movements', { product_id: OLEO.id, tipo: 'transferencia', location_origem_id: L1, location_destino_id: L3, quantidade: 1, motivo: 'para o bar' }, E.token);
check('destino NÃO marcado: transferência comum (o produto chega ao Bar)', dest3.s === 201 && (await produtoSaldo(OLEO.id, L3)) === 1 && !dest3.j.convertido_em_insumo, dest3);
check('converter_em_insumo: true para destino não marcado -> 400', (await api('POST', '/stock-movements', { product_id: OLEO.id, tipo: 'transferencia', location_origem_id: L1, location_destino_id: L3, quantidade: 1, motivo: 'x', converter_em_insumo: true }, E.token)).s === 400);
const sem = await tr({ quantidade: 500, converter_em_insumo: true });
check('saldo insuficiente na origem -> recusado (400) e o insumo não muda', sem.s === 400 && (await insumoSaldo(INS, L2)) === 3000, sem);
await api('PUT', `/products/${OLEO.id}`, { conversao: { ingredient_id: INS, fator: 1000, modo: 'sempre', lojas: [L2] } }, E.token);
const semFlag = await tr({ quantidade: 1 });
check('modo "sempre": converte sem perguntar (+1.000 ML)', semFlag.s === 201 && (await insumoSaldo(INS, L2)) === 4000, semFlag);
check('modo "sempre": converter_em_insumo: false é recusado (400)', (await tr({ quantidade: 1, converter_em_insumo: false })).s === 400);
const incompat = await api('PUT', `/products/${OLEO.id}`, { conversao: { criar_insumo: { nome: 'Oleo em KG E2E', unidade: 'KG' }, fator: 1, modo: 'perguntar', lojas: [L2] } }, E.token);
check('unidades incompatíveis (L -> KG) -> 400', incompat.s === 400, incompat);
const lanche = await produto('Lanche E2E', 5, 20, { estoque: 0 });
await api('POST', `/products/${lanche.id}/ingredients`, { ingredient_id: INS, quantidade_por_unidade: 50 }, E.token);
const cLanche = await api('PUT', `/products/${lanche.id}`, { conversao: { ingredient_id: INS, fator: 1, modo: 'perguntar', lojas: [L2] } }, E.token);
check('produto com ficha técnica (sem estoque próprio) não vira insumo -> 400', cLanche.s === 400, cLanche);
check('combo não vira insumo -> 400', (await api('PUT', `/products/${combo.j.id}`, { conversao: { ingredient_id: INS, fator: 1, modo: 'perguntar', lojas: [L2] } }, E.token)).s === 400);
check('mudar a unidade de um produto com conversão é recusado (400)', (await api('PUT', `/products/${OLEO.id}`, { unidade: 'KG' }, E.token)).s === 400);
const rem = await api('PUT', `/products/${OLEO.id}`, { conversao: null }, E.token);
check('remover a conversão: volta a transferência comum', rem.s === 200 && (await api('GET', `/products/${OLEO.id}`, null, E.token)).j.conversao === null);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 9b. Relatórios');
const resumo = await api('GET', '/reports/sales-summary', null, E.token);
const dq = (await db.query(`SELECT COALESCE(SUM((si.preco_tabela - si.preco_unitario) * si.quantidade), 0) AS d, COUNT(*)::int AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.tenant_id = $1 AND s.status = 'concluida' AND si.faixa_rotulo IS NOT NULL`, [E.id])).rows[0];
check('resumo de vendas mostra o desconto por quantidade (soma de (tabela - cobrado) x quantidade)', resumo.s === 200 && resumo.j.desconto_por_quantidade > 0 && Math.abs(resumo.j.desconto_por_quantidade - num(dq.d)) < 0.005 && resumo.j.itens_com_desconto_por_quantidade === dq.n, [resumo.j.desconto_por_quantidade, dq]);
check('desconto por faixa: Pack 6 aparece no detalhamento', (resumo.j.desconto_por_quantidade_por_faixa || []).some((f) => f.faixa === 'Pack 6' && f.desconto > 0), resumo.j.desconto_por_quantidade_por_faixa);
const relEst = await api('GET', '/reports/estoque', null, E.token);
const vv = (await db.query(`SELECT sb.location_id, COALESCE(SUM(sb.saldo * COALESCE(pp.preco_venda, p.preco_venda)), 0) AS v FROM stock_balances sb JOIN products p ON p.id = sb.product_id LEFT JOIN produto_precos pp ON pp.product_id = sb.product_id AND pp.location_id = sb.location_id WHERE sb.tenant_id = $1 AND sb.saldo > 0 AND p.ativo GROUP BY sb.location_id`, [E.id])).rows;
const vL2 = relEst.s === 200 ? (relEst.j.posicao || relEst.j.por_loja || []).find((x) => x.id === L2) : null;
check('valor do estoque a preço de venda usa o preço DA LOJA do saldo', !!vL2 && Math.abs(vL2.valor_venda - num(vv.find((x) => x.location_id === L2).v)) < 0.01, [vL2, Object.keys(relEst.j || {})]);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 10. Permissões, isolamento e auditoria');
check('caixa (sem EditarProdutos) não altera preços/faixas/conversão (403)', (await api('PUT', `/products/${MONSTER.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 20 }] }, CX.token)).s === 403);
check('caixa não cria produto com preço por loja (403)', (await api('POST', '/products', { nome: 'Sem Permissao', categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 1, preco_venda: 2, precos_lojas: [{ location_id: L2, preco_venda: 3 }] }, CX.token)).s === 403);
const venCx = await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: MONSTER.id, quantidade: 1 }], forma_pagamento: 'pix' }, CX.token);
check('o caixa vende normalmente (o preço da loja vale)', venCx.s === 201 && num(venCx.j.total) === 9.5, venCx);
const EB = await novaEmpresa('b');
check('outra empresa não enxerga o produto nem consegue mexer nos preços (404)', (await api('GET', `/products/${MONSTER.id}`, null, EB.token)).s === 404 && (await api('PUT', `/products/${MONSTER.id}`, { precos_lojas: [{ location_id: L2, preco_venda: 1 }] }, EB.token)).s === 404);
const aud = (await db.query(`SELECT detalhes FROM audit_logs WHERE tenant_id = $1 AND acao = 'editar' AND recurso_id = $2 AND detalhes ? 'precos' ORDER BY criado_em DESC LIMIT 1`, [E.id, MONSTER.id])).rows[0];
check('auditoria registra antes e depois dos preços/faixas', aud && aud.detalhes.precos && aud.detalhes.precos.antes && aud.detalhes.precos.depois, aud);
const audC = (await db.query(`SELECT detalhes FROM audit_logs WHERE tenant_id = $1 AND acao = 'editar' AND recurso_id = $2 AND detalhes ? 'conversao' LIMIT 1`, [E.id, OLEO.id])).rows[0];
check('auditoria registra a conversão (antes/depois)', !!audC, audC);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await db.end();
process.exit(fail ? 1 : 0);
