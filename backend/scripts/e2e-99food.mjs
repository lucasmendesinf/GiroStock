// Teste ponta a ponta da integracao com a 99Food, contra o SIMULADOR (scripts/food99-simulador.mjs).
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed):
//   1) npm run food99:simulador                      (porta 4998; webhook em http://localhost:3000/api/webhooks/99food)
//   2) API com FOOD99_API_URL=http://localhost:4998/v1 FOOD99_APP_ID=sim FOOD99_APP_SECRET=sim-segredo
//   3) API_URL=http://localhost:3000 npm run test:e2e:99food
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const SIM = (process.env.FOOD99_API_URL || 'http://localhost:4998/v1').replace(/\/v1\/?$/, '');
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 400)}`); }
};
async function api(method, rota, body, tok, base = B + '/api', headers = {}) {
  try {
    const res = await fetch(base + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers }, body: body === undefined || body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), signal: AbortSignal.timeout(30000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const sim = (method, rota, body) => api(method, rota, body, null, SIM);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function ate(fn, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { const r = await fn(); if (r) return r; await espera(400); }
  return null;
}

// ---------- preparo ----------
const SENHA_MASTER = crypto.randomBytes(9).toString('base64url');
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.99food.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E 99Food Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.99food.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador do seed', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const produtos = (await api('GET', '/products', null, A)).j;
const REFRI = produtos.find((p) => p.codigo_interno === 'PRD-0001');
const XB = produtos.find((p) => p.codigo_interno === 'PRD-0002');
const PDVL = (await api('GET', '/terminals', null, A)).j.find((t) => t.nome === 'PDV Lanchonete').id;
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'abastecer e2e 99food' }, A);
await api('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 50 }, A);

console.log('\n# 1. Modulo e conexao da loja (app_shop_id)');
check('sem o modulo: /integracoes -> 403', (await api('GET', '/integracoes', null, A)).s === 403);
check('Master libera o modulo para a empresa', (await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: true } }, MAS)).s === 200);
const lista0 = await api('GET', '/integracoes', null, A);
check('GET /integracoes: app da 99Food configurado no servidor', lista0.s === 200 && lista0.j.food99_configurado === true, lista0);
const ini = await api('POST', '/integracoes/99food/conectar', { location_id: L.Lanchonete }, A);
check('conectar: gera o codigo da loja (app_shop_id)', ini.s === 201 && /^GS[0-9A-F]{12}$/.test(ini.j.codigo), ini);
const SHOP = ini.j.codigo;
const INTEG = ini.j.id;
const cedo = await api('POST', `/integracoes/${INTEG}/concluir`, {}, A);
check('conferir antes de autorizar no portal -> 400 com o codigo', cedo.s === 400 && cedo.j.erro.includes(SHOP), cedo);
await sim('GET', `/_sim/autorizar?app_shop_id=${SHOP}`);
const fim = await api('POST', `/integracoes/${INTEG}/concluir`, {}, A);
check('autorizado no portal -> conectado', fim.s === 200 && fim.j.status === 'conectado' && fim.j.merchant_id === SHOP, fim);
const banco = (await prod.query(`SELECT access_token_cript, token_expira_em FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0];
check('token guardado cifrado, com validade', banco.access_token_cript && !banco.access_token_cript.startsWith('sim99-') && !!banco.token_expira_em);
check('a loja passou a usar pedidos', (await prod.query(`SELECT usa_pedidos FROM locations WHERE id = $1`, [L.Lanchonete])).rows[0].usa_pedidos === true);
check('GET /integracoes nao expoe token', !JSON.stringify((await api('GET', '/integracoes', null, A)).j).includes('token_cript'));
check('conectar de novo a mesma loja -> 409', (await api('POST', '/integracoes/99food/conectar', { location_id: L.Lanchonete }, A)).s === 409);
check('disponibilidade no cardapio ainda e so do iFood -> 409', (await api('GET', `/integracoes/${INTEG}/disponibilidade`, null, A)).s === 409);

console.log('\n# 2. Webhook: assinatura');
const corpoFalso = JSON.stringify({ type: 'orderNew', app_shop_id: SHOP, data: { order_id: 1, order_info: { order_id: 1, order_items: [] } } });
const semAss = await api('POST', '/webhooks/99food', corpoFalso, null, B + '/api');
check('sem assinatura -> 401 e errno diferente de 0', semAss.s === 401 && semAss.j.errno !== 0, semAss);
const assErrada = await api('POST', '/webhooks/99food', corpoFalso, null, B + '/api', { 'didi-header-sign': crypto.createHash('md5').update(corpoFalso + 'outro-segredo').digest('hex') });
check('assinatura com outro segredo -> 401', assErrada.s === 401, assErrada);
const outraLoja = JSON.stringify({ type: 'orderFinish', app_shop_id: 'GSDESCONHECIDA', data: { order_id: 99 } });
const desc = await api('POST', '/webhooks/99food', outraLoja, null, B + '/api', { 'didi-header-sign': crypto.createHash('md5').update(outraLoja + 'sim-segredo').digest('hex') });
check('loja nao conectada: errno 0 (para de reenviar) sem gravar nada', desc.s === 200 && desc.j.errno === 0, desc);

const pedidoDa99 = async (id) => ate(async () => {
  const r = await api('GET', '/orders', null, A);
  return Array.isArray(r.j) ? r.j.find((o) => o.origem_externa_id === id) : null;
});
const acoes = async () => (await sim('GET', '/_sim/acoes')).j;

console.log('\n# 3. Pedido pago online, entrega da 99Food, com adicional (valores em centavos)');
const pa = await sim('POST', '/_sim/pedidos', {
  app_shop_id: SHOP,
  itens: [{ nome: 'X-Burguer 99', codigo: 'PRD-0002', quantidade: 2, preco: 2500, opcoes: [{ nome: 'Bacon extra', preco: 300 }], observacao: 'sem cebola' },
    { nome: 'Refri lata', codigo: 'PRD-0001', quantidade: 1, preco: 800 }],
});
check('webhook respondido com errno 0', pa.s === 201 && pa.j.webhook && pa.j.webhook.corpo.errno === 0, pa);
check('id do pedido tem 64 bits (maior que o inteiro seguro do JS)', BigInt(pa.j.order_id) > BigInt(Number.MAX_SAFE_INTEGER));
const oa = await pedidoDa99(pa.j.order_id);
check('pedido entra na tela de Pedidos com o id exato (sem perder digitos)', !!oa && oa.origem === '99food' && oa.origem_externa_id === pa.j.order_id && oa.codigo_externo === String(pa.j.order_index), oa);
const da = (await api('GET', `/orders/${oa.id}`, null, A)).j;
const lx = da.itens.find((i) => i.product_id === XB.id);
check('itens vinculados pelo codigo PDV', da.itens.length === 2 && !!lx && da.itens.some((i) => i.product_id === REFRI.id), da.itens);
check('preco em reais com o adicional (25 + 3) e observacao', Number(lx.preco_unitario) === 28 && /Bacon extra/.test(lx.observacao) && /sem cebola/.test(lx.observacao), lx);
check('total 64 sem taxa (entrega da 99Food)', Number(da.total) === 64 && Number(da.taxa_entrega) === 0, { total: da.total, taxa: da.taxa_entrega });
check('pago online, cliente da 99Food, nao confirmado', da.pago === true && da.forma_pagamento_prevista === 'online' && da.cliente_nome === 'João Cliente' && da.externo.confirmado === false && da.externo.plataforma === '99food', da);
check('nome da loja na 99Food guardado do primeiro pedido', (await prod.query(`SELECT merchant_nome FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0].merchant_nome === 'Lanchonete na 99 (simulada)');
const reenv = await sim('POST', `/_sim/pedidos/${pa.j.order_id}/reenviar`);
check('99Food reenviou o mesmo pedido: errno 0 e nao duplica', reenv.j.webhook.corpo.errno === 0 && (await prod.query(`SELECT count(*)::int AS n FROM orders WHERE origem_externa_id = $1`, [pa.j.order_id])).rows[0].n === 1, reenv);
const peA = da.externo.id;
const ac = await api('POST', `/integracoes/pedidos/${peA}/aceitar`, null, A);
check('aceitar -> confirm na 99Food com order_id numerico', ac.s === 200 && (await acoes()).some((x) => x.acao === 'confirm' && x.order_id === pa.j.order_id), ac);
check('evento orderConfirm registrado', !!(await ate(async () => (await api('GET', `/orders/${oa.id}`, null, A)).j.externo.status_externo === 'CONFIRMED')));
check('em preparo (ja aceito: nada a mais na 99Food)', (await api('POST', `/orders/${oa.id}/status`, { para: 'em_preparo' }, A)).s === 200 && (await acoes()).filter((x) => x.order_id === pa.j.order_id).length === 1);
check('pronto -> ready na 99Food (chama o entregador)', (await api('POST', `/orders/${oa.id}/status`, { para: 'pronto' }, A)).s === 200 && (await acoes()).some((x) => x.acao === 'ready' && x.order_id === pa.j.order_id));
const finA = await api('POST', `/orders/${oa.id}/status`, { para: 'finalizado' }, A);
check('entrega da 99Food: de pronto vai direto a finalizado', finA.s === 200 && finA.j.status === 'finalizado', finA);
const vendaA = (await api('GET', `/sales/${finA.j.sale_id}`, null, A)).j;
check('venda: forma "online", total 64', vendaA.forma_pagamento === 'online' && Number(vendaA.total) === 64, vendaA);

console.log('\n# 4. Item sem vinculo: vincula uma vez e o sistema lembra');
const pb = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Guaraná 2L', quantidade: 1, preco: 1200 }] });
const pend = await ate(async () => { const r = await api('GET', '/integracoes/pendencias', null, A); return Array.isArray(r.j) ? r.j.find((p) => p.codigo_externo === String(pb.j.order_index) && p.plataforma === '99food') : null; });
check('item sem codigo fica em pendencias', !!pend && pend.itens[0].product_id === null && pend.itens[0].nome === 'Guaraná 2L' && pend.total === 12, pend);
const vin = await api('POST', `/integracoes/pedidos/${pend.id}/vincular`, { itens: [{ chave: pend.itens[0].chave, product_id: REFRI.id }] }, A);
check('vincular -> pedido importado', vin.s === 200 && vin.j.situacao === 'importado', vin);
const pc = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Guaraná 2L', quantidade: 1, preco: 1200 }] });
const oc = await pedidoDa99(pc.j.order_id);
check('proximo pedido com o mesmo item entra sozinho', !!oc);
check('vinculo da 99Food separado do iFood', (await prod.query(`SELECT plataforma FROM integracao_itens WHERE chave = $1`, [pend.itens[0].chave])).rows.every((r) => r.plataforma === '99food'));

console.log('\n# 5. Entrega da loja, dinheiro, aceite automatico, despacho com o entregador');
check('liga o aceite automatico', (await api('PATCH', `/integracoes/${INTEG}`, { aceite_automatico: true }, A)).s === 200);
const pd = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri lata', codigo: 'PRD-0001', quantidade: 2, preco: 800 }], entrega: 'loja', pago_online: false, canal: 153, taxa: 600 });
const od = await pedidoDa99(pd.j.order_id);
check('entrega da loja: taxa 6, a cobrar em dinheiro, endereco', !!od && Number(od.taxa_entrega) === 6 && od.pago === false && od.forma_pagamento_prevista === 'dinheiro' && /Rua das Flores, 100/.test(od.endereco), od);
check('aceite automatico confirmou na 99Food', !!(await ate(async () => (await acoes()).some((x) => x.acao === 'confirm' && x.order_id === pd.j.order_id))));
check('telefone do entregador invalido -> 400', (await api('POST', '/couriers', { nome: 'Fulano', telefone: '123' }, A)).s === 400);
const ent = await api('POST', '/couriers', { nome: 'Zé da Moto', telefone: '(41) 98888-7777' }, A);
check('entregador com telefone', ent.s === 201 && ent.j.telefone === '41988887777', ent);
await api('POST', `/orders/${od.id}/status`, { para: 'em_preparo' }, A);
await api('POST', `/orders/${od.id}/status`, { para: 'pronto' }, A);
const saiu = await api('POST', `/orders/${od.id}/status`, { para: 'saiu_entrega', entregador_id: ent.j.id }, A);
const disp = (await acoes()).find((x) => x.acao === 'dispatch' && x.order_id === pd.j.order_id);
check('saiu para entrega -> dispatch com nome e telefone do entregador', saiu.s === 200 && !!disp && disp.corpo.courier_info.courier_name === 'Zé da Moto' && disp.corpo.courier_info.courier_phone === '41988887777' && disp.corpo.courier_info.courier_first_name === 'Zé', disp || saiu);
const finD = await api('POST', `/orders/${od.id}/status`, { para: 'finalizado' }, A);
const vendaD = finD.s === 200 ? (await api('GET', `/sales/${finD.j.sale_id}`, null, A)).j : null;
check('finalizar: venda em dinheiro, total 22', vendaD && vendaD.forma_pagamento === 'dinheiro' && Number(vendaD.total) === 22, finD.s === 200 ? vendaD : finD);

console.log('\n# 6. Cancelamentos e avisos');
const p6 = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 800 }] });
const o6 = await pedidoDa99(p6.j.order_id);
const mot = await api('GET', `/integracoes/pedidos/${o6.externo.id}/motivos-cancelamento`, null, A);
check('motivos de cancelamento da 99Food', mot.s === 200 && mot.j.some((m) => m.codigo === '1'), mot);
check('cancelar sem o motivo da lista -> 400', (await api('POST', `/orders/${o6.id}/cancel`, { motivo: 'Cliente ligou' }, A)).s === 400);
const c6 = await api('POST', `/orders/${o6.id}/cancel`, { motivo: 'Acabou o refri', codigo_motivo: '1' }, A);
check('cancelar com motivo -> cancelado na 99Food e aqui na hora', c6.s === 200 && c6.j.status === 'cancelado' && (await acoes()).some((x) => x.acao === 'cancel' && x.order_id === p6.j.order_id && x.corpo.reason_id === 1), c6);
const p7 = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 800 }] });
const o7 = await pedidoDa99(p7.j.order_id);
await sim('POST', `/_sim/pedidos/${p7.j.order_id}/cancelar-cliente`);
const c7 = await ate(async () => { const o = (await api('GET', `/orders/${o7.id}`, null, A)).j; return o.status === 'cancelado' ? o : null; });
check('cliente cancelou na 99Food -> cancelado aqui', !!c7 && /99Food/.test(c7.motivo_cancelamento), c7);
const p8 = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 2, preco: 800 }] });
const o8 = await pedidoDa99(p8.j.order_id);
await sim('POST', `/_sim/pedidos/${p8.j.order_id}/parcial`);
check('cancelamento parcial -> aviso no pedido', !!(await ate(async () => /cancelamento parcial na 99Food/.test((await api('GET', `/orders/${o8.id}`, null, A)).j.observacao))));
check('negociacao (disputa) nao existe na 99Food -> 409', (await api('POST', `/integracoes/pedidos/${o8.externo.id}/disputa`, { aceitar: true }, A)).s === 409);
await api('POST', `/orders/${o8.id}/cancel`, { motivo: 'teste', codigo_motivo: '5' }, A);

console.log('\n# 7. Token, modulo desligado, autorizacao retirada, desconectar');
const antes = (await prod.query(`SELECT access_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0].access_token_cript;
await sim('POST', `/_sim/expirar?app_shop_id=${SHOP}`);
const t1 = await api('POST', `/integracoes/${INTEG}/sincronizar`, null, A);
const depois = (await prod.query(`SELECT access_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0].access_token_cript;
check('testar conexao com token expirado: renova sozinho (10102 -> refresh)', t1.s === 200 && t1.j.conexao === 'ok' && depois !== antes, t1);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: null } }, MAS);
const p9 = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 800 }] });
check('modulo desligado: webhook recusado (a 99Food reenvia)', p9.j.webhook.corpo.errno !== 0 && !(await prod.query(`SELECT 1 FROM pedidos_externos WHERE externo_id = $1`, [p9.j.order_id])).rows.length, p9.j);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: true } }, MAS);
check('modulo ligado de novo: o reenvio da 99Food faz o pedido entrar', !!(await pedidoDa99(p9.j.order_id)));
await sim('GET', `/_sim/desautorizar?app_shop_id=${SHOP}`);
const t2 = await api('POST', `/integracoes/${INTEG}/sincronizar`, null, A);
check('loja tirou a autorizacao: 502 e a conexao pede nova autorizacao', t2.s === 502 && (await prod.query(`SELECT status FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0].status === 'reautorizar', t2);
await sim('GET', `/_sim/autorizar?app_shop_id=${SHOP}`);
check('autorizou de novo: conferir reconecta', (await api('POST', `/integracoes/${INTEG}/concluir`, {}, A)).j.status === 'conectado');
check('desconectar', (await api('DELETE', `/integracoes/${INTEG}`, null, A)).s === 204);
const off = (await prod.query(`SELECT status, access_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0];
check('desconectado apaga o token', off.status === 'desconectado' && off.access_token_cript === null, off);
const p10 = await sim('POST', '/_sim/pedidos', { app_shop_id: SHOP, itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 800 }] });
check('desconectado: webhook respondido (errno 0) e ignorado', p10.j.webhook.corpo.errno === 0 && !(await prod.query(`SELECT 1 FROM pedidos_externos WHERE externo_id = $1`, [p10.j.order_id])).rows.length, p10.j);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: null } }, MAS);

await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
