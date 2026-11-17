// e2e: metodo de custo do estoque por empresa (custo medio x PEPS). Baixa pelo lote mais antigo e CMV (custo gravado na venda).
//   node scripts/e2e-peps.mjs   (API em http://localhost:3000; banco com migrations e seed)
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
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 500)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const igual = (a, b, tol = 0.0005) => Math.abs(Number(a) - Number(b)) <= tol;
const EMAIL_M = 'e2e.peps.master@girostock.local';
const SENHA_M = rnd();
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E PEPS Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo, metodo) {
  const email = `e2e.peps.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E PEPS ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Loja 1', metodo_custo: metodo, admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await api('POST', '/auth/login', { email, senha: r.j.senha_temporaria });
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  const tok = (await api('POST', '/auth/login', { email, senha: nova })).j.token;
  const L1 = (await db.query('SELECT id FROM locations WHERE tenant_id = $1', [r.j.empresa.id])).rows[0].id;
  const L2 = (await api('POST', '/locations', { nome: 'Loja 2' }, tok)).j.id;
  const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, tok)).j.id;
  await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 100 }, tok);
  await api('POST', '/categories', { nome: 'Bebidas' }, tok);
  const cat = (await api('GET', '/categories', null, tok)).j[0].id;
  return { id: r.j.empresa.id, tok, L1, L2, T1, cat, resp: r };
}
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
async function produto(E, nome, custo = 5, venda = 30) {
  const r = await api('POST', '/products', { nome, categoria_id: E.cat, barcode: bc(), unidade: 'UN', preco_custo: custo, preco_venda: venda }, E.tok);
  return r.j.id;
}
const entrada = (E, pid, loja, qtd, custo) => api('POST', '/stock-movements', { product_id: pid, tipo: 'entrada', quantidade: qtd, location_destino_id: loja, motivo: 'compra', custo_unitario: custo }, E.tok);
const vender = (E, pid, qtd) => api('POST', '/sales', { terminal_id: E.T1, itens: [{ product_id: pid, quantidade: qtd }], forma_pagamento: 'pix' }, E.tok);
const custoItem = async (saleId) => Number((await db.query('SELECT custo_unitario FROM sale_items WHERE sale_id = $1', [saleId])).rows[0].custo_unitario);
const lotes = async (pid, loja) => (await db.query('SELECT saldo, custo_unitario FROM stock_lotes WHERE product_id = $1 AND location_id = $2 AND saldo > 0 ORDER BY entrada_em, criado_em', [pid, loja])).rows.map((r) => [Number(r.saldo), Number(r.custo_unitario)]);
const saldo = async (pid, loja) => Number((await db.query('SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2', [pid, loja])).rows[0]?.saldo || 0);

console.log('\n# Preparo');
const P = await novaEmpresa('peps', 'peps');
const M = await novaEmpresa('medio', 'medio');
check('empresas criadas com o metodo escolhido na criacao (PEPS e custo medio)',
  (await db.query('SELECT metodo_custo FROM tenants WHERE id = $1', [P.id])).rows[0].metodo_custo === 'peps' && (await db.query('SELECT metodo_custo FROM tenants WHERE id = $1', [M.id])).rows[0].metodo_custo === 'medio');
check('metodo invalido na criacao -> 400', (await api('POST', '/master/empresas', { nome: 'Invalida ' + SUF, plano: 'completo', metodo_custo: 'lifo', admin: { nome: 'x', email: `x.${SUF}@girostock.local` } }, MAS)).s === 400);
check('o metodo aparece na ficha da empresa no Master e em /empresa', (await api('GET', `/master/empresas/${P.id}`, null, MAS)).j.metodo_custo === 'peps' && (await api('GET', '/empresa', null, P.tok)).j.metodo_custo === 'peps');

// ---------------------------------------------------------------------------------------------------
console.log('\n# 1. Exemplo: 50 un a R$ 10 + 40 un a R$ 12, venda de 70 un');
const A = await produto(P, 'Produto A PEPS');
await entrada(P, A, P.L1, 50, 10);
await entrada(P, A, P.L1, 40, 12);
check('cada entrada vira um lote (50 a 10,00 e 40 a 12,00)', JSON.stringify(await lotes(A, P.L1)) === '[[50,10],[40,12]]', await lotes(A, P.L1));
const vA = await vender(P, A, 70);
check('venda de 70 un: 201', vA.s === 201, vA);
check('CMV = 50 x 10 + 20 x 12 = R$ 740,00 (custo por unidade 10,5714 gravado no item)', igual(await custoItem(vA.j.id) * 70, 740, 0.01), await custoItem(vA.j.id));
check('sobram 20 un a R$ 12,00 (lote e saldo)', JSON.stringify(await lotes(A, P.L1)) === '[[20,12]]' && (await saldo(A, P.L1)) === 20, await lotes(A, P.L1));
const mv = (await db.query(`SELECT custo_unitario FROM stock_movements WHERE sale_id = $1 AND tipo = 'saida'`, [vA.j.id])).rows[0];
check('o movimento de saida da venda guarda o custo medio da baixa', igual(mv.custo_unitario, 10.5714, 0.0002), mv);

console.log('\n# 2. Venda 1, 10, 11 e 15 (10 un a R$ 10 + 10 un a R$ 12)');
const Q = await produto(P, 'Produto Q PEPS');
await entrada(P, Q, P.L1, 10, 10);
await entrada(P, Q, P.L1, 10, 12);
const custos = []; const ids = [];
for (let i = 1; i <= 15; i++) { const v = await vender(P, Q, 1); ids.push(v.j.id); custos.push(await custoItem(v.j.id)); }
check('vendas 1 a 10 saem a R$ 10,00 (lote mais antigo)', custos.slice(0, 10).every((c) => igual(c, 10)), custos);
check('vendas 11 a 15 saem a R$ 12,00 (o primeiro lote acabou)', custos.slice(10).every((c) => igual(c, 12)), custos);
check('restam 5 un a R$ 12,00', JSON.stringify(await lotes(Q, P.L1)) === '[[5,12]]');
const v16 = await vender(P, Q, 6);
check('venda maior que o saldo e recusada e nao mexe nos lotes', v16.s === 400 && JSON.stringify(await lotes(Q, P.L1)) === '[[5,12]]', v16);

console.log('\n# 3. Cancelamento devolve o lote com o custo da baixa');
const canc = await api('POST', `/sales/${ids[0]}/cancel`, { motivo: 'cliente desistiu' }, P.tok);
check('cancelar a 1a venda (custo 10,00): 200', canc.s === 200, canc);
check('o estorno volta como lote de 1 un a R$ 10,00, na frente da fila', JSON.stringify(await lotes(Q, P.L1)) === '[[1,10],[5,12]]', await lotes(Q, P.L1));
const vN = await vender(P, Q, 1);
check('a proxima venda sai a R$ 10,00 de novo', igual(await custoItem(vN.j.id), 10), await custoItem(vN.j.id));

console.log('\n# 4. Transferencia entre lojas leva os lotes (custo e idade)');
const R = await produto(P, 'Produto R PEPS');
await entrada(P, R, P.L1, 5, 10);
await entrada(P, R, P.L1, 5, 12);
const tr = await api('POST', '/stock-movements', { product_id: R, tipo: 'transferencia', quantidade: 7, location_origem_id: P.L1, location_destino_id: P.L2, motivo: 'abastecer' }, P.tok);
check('transferencia de 7 un: 201', tr.s === 201, tr);
check('origem fica com 3 un a R$ 12,00; destino recebe 5 a 10,00 e 2 a 12,00', JSON.stringify(await lotes(R, P.L1)) === '[[3,12]]' && JSON.stringify(await lotes(R, P.L2)) === '[[5,10],[2,12]]', [await lotes(R, P.L1), await lotes(R, P.L2)]);
const saidaPerda = await api('POST', '/stock-movements', { product_id: R, tipo: 'saida', quantidade: 6, location_origem_id: P.L2, motivo: 'perda' }, P.tok);
check('saida/perda consome do mais antigo da loja (5 a 10 + 1 a 12) e guarda o custo medio', saidaPerda.s === 201 && igual(saidaPerda.j.custo_unitario, (5 * 10 + 12) / 6, 0.001) && JSON.stringify(await lotes(R, P.L2)) === '[[1,12]]', [saidaPerda.j.custo_unitario, await lotes(R, P.L2)]);

console.log('\n# 5. Contagem (balanco)');
const aj1 = await api('POST', `/products/${R}/stock-adjustment`, { location_id: P.L1, novo_saldo: 5, motivo: 'contagem a mais' }, P.tok);
check('contagem a mais (+2): entra lote ao custo do ultimo lote (R$ 12,00)', aj1.s === 201 && JSON.stringify(await lotes(R, P.L1)) === '[[3,12],[2,12]]', [aj1.s, await lotes(R, P.L1)]);
const aj2 = await api('POST', `/products/${R}/stock-adjustment`, { location_id: P.L1, novo_saldo: 1, motivo: 'contagem a menos' }, P.tok);
check('contagem a menos (-4): consome do mais antigo', aj2.s === 201 && (await lotes(R, P.L1)).reduce((s, l) => s + l[0], 0) === 1, await lotes(R, P.L1));

console.log('\n# 6. Entrada sem custo, produto novo e preco de custo do produto');
const S = await produto(P, 'Produto S PEPS', 7);
const eSem = await entrada(P, S, P.L1, 4, undefined);
check('entrada sem custo informado: lote ao custo atual do produto (R$ 7,00)', eSem.s === 201 && JSON.stringify(await lotes(S, P.L1)) === '[[4,7]]', await lotes(S, P.L1));
await entrada(P, S, P.L1, 4, 9);
check('PEPS: o custo do produto passa a ser o da ultima entrada (9,00), nao a media', igual((await db.query('SELECT preco_custo FROM products WHERE id = $1', [S])).rows[0].preco_custo, 9, 0.001));
const vS = await vender(P, S, 5);
check('venda de 5: 4 a 7 + 1 a 9 = R$ 37,00', igual((await custoItem(vS.j.id)) * 5, 37, 0.01), await custoItem(vS.j.id));

console.log('\n# 7. Custo medio (empresa B) continua como antes');
const C = await produto(M, 'Produto C Medio');
await entrada(M, C, M.L1, 10, 10);
await entrada(M, C, M.L1, 10, 12);
check('custo medio ponderado = R$ 11,00 e nenhum lote e criado', igual((await db.query('SELECT preco_custo FROM products WHERE id = $1', [C])).rows[0].preco_custo, 11, 0.001) && (await lotes(C, M.L1)).length === 0);
const vC1 = await vender(M, C, 1); const vC15 = await vender(M, C, 9);
check('vendas saem todas a R$ 11,00 (como antes)', igual(await custoItem(vC1.j.id), 11) && igual(await custoItem(vC15.j.id), 11));
check('saida e movimento do custo medio nao guardam custo (como antes)', (await db.query(`SELECT custo_unitario FROM stock_movements WHERE sale_id = $1 AND tipo = 'saida'`, [vC1.j.id])).rows[0].custo_unitario === null);

console.log('\n# 8. Trocar o metodo da empresa (Master)');
check('metodo invalido -> 400', (await api('PATCH', `/master/empresas/${M.id}`, { metodo_custo: 'ueps' }, MAS)).s === 400);
check('sem alteracao real (mesmo metodo) -> 400 "nada para alterar"', (await api('PATCH', `/master/empresas/${M.id}`, { metodo_custo: 'medio' }, MAS)).s === 400);
const sw = await api('PATCH', `/master/empresas/${M.id}`, { metodo_custo: 'peps' }, MAS);
check('trocar B para PEPS: 200', sw.s === 200, sw);
check('o estoque que existia vira UM lote por produto/loja ao custo atual (1 un... saldo 10 a R$ 11,00)', JSON.stringify(await lotes(C, M.L1)) === '[[10,11]]', await lotes(C, M.L1));
await entrada(M, C, M.L1, 10, 14);
const vC2 = await vender(M, C, 12);
check('depois da troca a venda ja segue o PEPS: 10 a 11 + 2 a 14 = R$ 138,00', igual((await custoItem(vC2.j.id)) * 12, 138, 0.01), await custoItem(vC2.j.id));
check('as vendas anteriores a troca nao mudaram (R$ 11,00)', igual(await custoItem(vC1.j.id), 11));
check('auditoria registra a troca (de/para)', Number((await db.query(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND acao = 'master_alterar_empresa' AND detalhes::text LIKE '%metodo_custo%'`, [M.id])).rows[0].n) === 1);
const sw2 = await api('PATCH', `/master/empresas/${M.id}`, { metodo_custo: 'medio' }, MAS);
check('voltar ao custo medio: 200 e os lotes saem', sw2.s === 200 && (await lotes(C, M.L1)).length === 0);
check('so o Master altera o metodo (admin da empresa -> 403/404 na rota do Master)', [403, 404].includes((await api('PATCH', `/master/empresas/${M.id}`, { metodo_custo: 'peps' }, P.tok)).s));

console.log('\n# 9. Isolamento e relatorio (CMV)');
check('empresa A nao tem lotes da empresa B e vice-versa', Number((await db.query('SELECT count(*) AS n FROM stock_lotes WHERE tenant_id = $1 AND product_id = $2', [P.id, C])).rows[0].n) === 0);
const cmvA = Number((await db.query(`SELECT SUM(si.quantidade * si.custo_unitario) AS c FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.tenant_id = $1 AND si.product_id = $2 AND s.status = 'concluida'`, [P.id, A])).rows[0].c);
check('CMV do produto A no banco = R$ 740,00 (a fonte dos relatorios)', igual(cmvA, 740, 0.01), cmvA);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await db.end();
process.exit(fail ? 1 : 0);
