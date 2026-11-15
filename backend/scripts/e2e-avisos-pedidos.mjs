// e2e do aviso de pedido novo (cartao lateral + som em qualquer tela): GET /api/avisos/pedidos.
// npm run test:e2e:avisos   (API em http://localhost:3000)
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
const EMAIL_M = 'e2e.avisos.master@girostock.local';
const SENHA_M = rnd();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E Avisos Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);
async function novaEmpresa(rotulo) {
  const email = `e2e.avisos.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E AVISOS ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Delivery Centro', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: rnd() }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId) {
  const email = `e2e.avisos.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId }, emp.token);
  return (await login(email, senha)).j.token;
}
let numero = 1000;
async function pedido(emp, loc, origem, extra = {}) {
  numero += 1;
  const o = { lv_fluxo: null, pagamento_online: null, pagamento_status: null, status: 'novo', criado_em: null, ...extra };
  const id = (await db.query(
    `INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, tipo, status, codigo_externo, lv_fluxo, pagamento_online, pagamento_status, taxa_entrega, criado_em)
     VALUES ($1, $2, $3, $4, 'Cliente Teste', 'entrega', $5, $6, $7, $8, $9, 5, COALESCE($10::timestamptz, now())) RETURNING id`,
    [emp.id, loc, numero, origem, o.status, origem === 'ifood' || origem === '99food' ? `EXT${numero}` : null, o.lv_fluxo, o.pagamento_online, o.pagamento_status, o.criado_em]
  )).rows[0].id;
  const prod = (await db.query(`SELECT id FROM products WHERE tenant_id = $1 LIMIT 1`, [emp.id])).rows[0].id;
  await db.query(`INSERT INTO order_items (order_id, product_id, quantidade, preco_unitario, subtotal) VALUES ($1, $2, 2, 10, 20)`, [id, prod]);
  return id;
}

console.log('\n# Aviso de pedido novo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, loja_virtual: true, delivery_apps: true } }, MAS);
const A = (await db.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
const Bl = (await api('POST', '/locations', { nome: 'Delivery Bairro', usa_pedidos: true }, E.token)).j.id;
await api('POST', '/categories', { nome: 'Lanches' }, E.token);
const CAT = (await api('GET', '/categories', null, E.token)).j[0].id;
await api('POST', '/products', { nome: 'Lanche', categoria_id: CAT, barcode: String(Date.now()).slice(-12), unidade: 'UN', preco_custo: 2, preco_venda: 10, location_id: A, estoque_inicial: 50 }, E.token);
check('sem pedido novo: lista vazia', (await api('GET', '/avisos/pedidos', null, E.token)).j.pedidos.length === 0);
const pIfood = await pedido(E, A, 'ifood');
const p99 = await pedido(E, A, '99food');
const pCard = await pedido(E, A, 'loja_virtual', { lv_fluxo: 'cardapio' });
const pSite = await pedido(E, Bl, 'loja_virtual', { lv_fluxo: 'ecommerce' });
const pPix = await pedido(E, A, 'loja_virtual', { lv_fluxo: 'cardapio', pagamento_online: 'pix', pagamento_status: 'pendente' });
const pBalcao = await pedido(E, A, 'balcao');
const pAceito = await pedido(E, A, 'ifood', { status: 'em_preparo' });
const pVelho = await pedido(E, A, 'ifood', { criado_em: new Date(Date.now() - 13 * 3600e3).toISOString() });
const adm = (await api('GET', '/avisos/pedidos', null, E.token)).j.pedidos;
const ids = adm.map((p) => p.id);
check('admin vê iFood, 99Food, cardápio e loja online (site)', [pIfood, p99, pCard, pSite].every((id) => ids.includes(id)) && adm.length === 4, adm.map((p) => [p.origem, p.do_site]));
check('não avisa: pedido pago no site aguardando pagamento, de balcão, já aceito, ou de mais de 12 h', ![pPix, pBalcao, pAceito, pVelho].some((id) => ids.includes(id)));
const ifo = adm.find((p) => p.id === pIfood);
check('dados do cartão: origem, código externo, loja, cliente, itens e total (itens + taxa)', ifo.origem === 'ifood' && ifo.codigo_externo && ifo.location_nome === 'Delivery Centro' && ifo.cliente_nome === 'Cliente Teste' && ifo.itens === 2 && ifo.total === 25 && ifo.do_site === false, ifo);
check('loja online marcada como do site (abre em Loja virtual → Pedidos do site)', adm.find((p) => p.id === pSite).do_site === true);
check('ordem de chegada (mais antigo primeiro)', ids.indexOf(pIfood) < ids.indexOf(p99));
await db.query(`UPDATE orders SET pagamento_status = 'aprovado' WHERE id = $1`, [pPix]);
check('pagamento aprovado: passa a avisar', (await api('GET', '/avisos/pedidos', null, E.token)).j.pedidos.some((p) => p.id === pPix));
await db.query(`UPDATE orders SET status = 'em_preparo' WHERE id = $1`, [pIfood]);
check('pedido aceito some do aviso (o som para)', !(await api('GET', '/avisos/pedidos', null, E.token)).j.pedidos.some((p) => p.id === pIfood));
const CX = await usuario(E, 'CaixaCentro', 'Caixa/Operador', A);
const cx = (await api('GET', '/avisos/pedidos', null, CX)).j.pedidos;
check('caixa (só a loja dele, sem Loja virtual): vê os da loja dele, não vê a loja online', cx.length > 0 && cx.every((p) => !p.do_site) && !cx.some((p) => p.id === pSite), cx.map((p) => p.origem));
const CXB = await usuario(E, 'CaixaBairro', 'Caixa/Operador', Bl);
const cxb = await api('GET', '/avisos/pedidos', null, CXB);
check('caixa de outra loja não vê pedidos da loja Centro', cxb.s === 200 && cxb.j.pedidos.length === 0, cxb.j);
const EST = await usuario(E, 'Estoquista', 'Estoque', A);
check('perfil sem Pedidos nem Loja virtual: nada', (await api('GET', '/avisos/pedidos', null, EST)).j.pedidos.length === 0);
const F = await novaEmpresa('b');
check('outra empresa não vê os pedidos', (await api('GET', '/avisos/pedidos', null, F.token)).j.pedidos.length === 0);
check('sem login -> 401', (await api('GET', '/avisos/pedidos')).s === 401);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await db.end();
process.exit(fail ? 1 : 0);
