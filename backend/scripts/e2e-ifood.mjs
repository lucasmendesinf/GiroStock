// Teste ponta a ponta da integracao com o iFood, contra o SIMULADOR (scripts/ifood-simulador.mjs).
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed):
//   1) npm run ifood:simulador                       (porta 4999)
//   2) API com IFOOD_API_URL=http://localhost:4999 IFOOD_CLIENT_ID=sim IFOOD_CLIENT_SECRET=sim IFOOD_POLLING_SEGUNDOS=2
//   3) API_URL=http://localhost:3000 npm run test:e2e:ifood
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const SIM = process.env.IFOOD_API_URL || 'http://localhost:4999';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 400)}`); }
};
async function api(method, rota, body, tok, base = B + '/api') {
  try {
    const res = await fetch(base + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
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
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.ifood.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E iFood Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.ifood.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador do seed', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const produtos = (await api('GET', '/products', null, A)).j;
const REFRI = produtos.find((p) => p.codigo_interno === 'PRD-0001');
const XB = produtos.find((p) => p.codigo_interno === 'PRD-0002');
const PDVL = (await api('GET', '/terminals', null, A)).j.find((t) => t.nome === 'PDV Lanchonete').id;
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'abastecer e2e ifood' }, A);
await api('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 50 }, A);

console.log('\n# 1. Modulo e conexao da loja');
check('sem o modulo "iFood e 99Food": /integracoes -> 403', (await api('GET', '/integracoes', null, A)).s === 403);
check('Master libera o modulo para a empresa', (await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: true } }, MAS)).s === 200);
const lista0 = await api('GET', '/integracoes', null, A);
check('GET /integracoes: app do iFood configurado no servidor', lista0.s === 200 && lista0.j.ifood_configurado === true, lista0);
const ini = await api('POST', '/integracoes/ifood/conectar', { location_id: L.Lanchonete }, A);
check('conectar: gera codigo de vinculo e link do Portal do Parceiro', ini.s === 201 && ini.j.codigo && /autorizar/.test(ini.j.link), ini);
const ruim = await api('POST', `/integracoes/${ini.j.id}/concluir`, { codigo: 'CODIGO-ERRADO' }, A);
check('codigo de autorizacao errado -> 400 com explicacao', ruim.s === 400 && /inválido/.test(ruim.j.erro), ruim);
const portal = await api('GET', `/_sim/autorizar?userCode=${ini.j.codigo}`, null, null, SIM);
const fim = await api('POST', `/integracoes/${ini.j.id}/concluir`, { codigo: portal.j.authorizationCode }, A);
check('codigo do portal -> conectado na loja do iFood', fim.s === 200 && fim.j.status === 'conectado' && fim.j.merchant_id === 'sim-loja-1', fim);
const INTEG = ini.j.id;
const banco = (await prod.query(`SELECT access_token_cript, refresh_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0];
check('tokens guardados cifrados (nunca em texto puro)', banco.access_token_cript && !banco.access_token_cript.startsWith('sim-at-') && banco.refresh_token_cript && !banco.refresh_token_cript.startsWith('sim-rt-'));
check('a loja passou a usar pedidos', (await prod.query(`SELECT usa_pedidos FROM locations WHERE id = $1`, [L.Lanchonete])).rows[0].usa_pedidos === true);
const lista1 = await api('GET', '/integracoes', null, A);
check('GET /integracoes nao expoe tokens', !JSON.stringify(lista1.j).includes('token_cript') && !JSON.stringify(lista1.j).includes('sim-at-'), lista1.j);
const dupIni = await api('POST', '/integracoes/ifood/conectar', { location_id: L.Distribuidora }, A);
const dupPortal = await api('GET', `/_sim/autorizar?userCode=${dupIni.j.codigo}`, null, null, SIM);
const dup = await api('POST', `/integracoes/${dupIni.j.id}/concluir`, { codigo: dupPortal.j.authorizationCode }, A);
check('a mesma loja do iFood em outra loja do GiroStock -> 409', dup.s === 409, dup);
await api('DELETE', `/integracoes/${dupIni.j.id}`, null, A);

const pedidoDoIfood = async (ifoodId) => ate(async () => {
  const r = await api('GET', '/orders', null, A);
  return Array.isArray(r.j) ? r.j.find((o) => o.origem_externa_id === ifoodId) : null;
});
const acoes = async () => (await sim('GET', '/_sim/acoes')).j;

console.log('\n# 2. Pedido pago online, entrega do iFood, com complemento e desconto da loja');
const pa = await sim('POST', '/_sim/pedidos', {
  itens: [{ nome: 'X-Burguer da casa', codigo: 'PRD-0002', quantidade: 2, preco: 25, opcoes: [{ nome: 'Bacon extra', preco: 3 }], observacao: 'sem cebola' },
    { nome: 'Refri lata', codigo: '7891000100103', quantidade: 1, preco: 8 }],
  desconto_loja: 5, pago_online: true, entrega_ifood: true,
});
const oa = await pedidoDoIfood(pa.j.id);
check('pedido chega sozinho (polling) na tela de Pedidos', !!oa && oa.origem === 'ifood' && oa.codigo_externo === pa.j.displayId, oa);
const da = (await api('GET', `/orders/${oa.id}`, null, A)).j;
const lx = da.itens.find((i) => i.product_id === XB.id);
check('itens vinculados pelo codigo PDV (codigo interno e codigo de barras)', da.itens.length === 2 && !!lx && da.itens.some((i) => i.product_id === REFRI.id), da.itens);
check('preco do iFood com complemento (25 + 3) e observacao com o complemento', Number(lx.preco_unitario) === 28 && /Bacon extra/.test(lx.observacao) && /sem cebola/.test(lx.observacao), lx);
check('total = itens - desconto da loja, sem taxa (entrega do iFood): 59', Number(da.total) === 59 && Number(da.desconto) === 5 && Number(da.taxa_entrega) === 0, { total: da.total, desconto: da.desconto, taxa: da.taxa_entrega });
check('pago online, cliente do iFood, nao confirmado ainda', da.pago === true && da.forma_pagamento_prevista === 'online' && da.cliente_nome === 'Maria Cliente' && da.externo && da.externo.confirmado === false, da);
check('nao cadastra o cliente (telefone e 0800 do iFood)', da.customer_id === null);
const peA = da.externo.id;
check('aceitar -> confirm no iFood', (await api('POST', `/integracoes/pedidos/${peA}/aceitar`, null, A)).s === 200 && (await acoes()).some((x) => x.acao === 'confirm' && x.pedido === pa.j.id));
await api('POST', `/integracoes/${INTEG}/sincronizar`, null, A);
check('evento de confirmacao do iFood registrado', (await api('GET', `/orders/${oa.id}`, null, A)).j.externo.status_externo === 'CONFIRMED');
check('em preparo -> startPreparation no iFood', (await api('POST', `/orders/${oa.id}/status`, { para: 'em_preparo' }, A)).s === 200 && (await acoes()).some((x) => x.acao === 'startPreparation' && x.pedido === pa.j.id));
check('pronto -> readyToPickup no iFood (entregador do iFood)', (await api('POST', `/orders/${oa.id}/status`, { para: 'pronto' }, A)).s === 200 && (await acoes()).some((x) => x.acao === 'readyToPickup' && x.pedido === pa.j.id));
const finA = await api('POST', `/orders/${oa.id}/status`, { para: 'finalizado' }, A);
check('entrega do iFood: de pronto vai direto a finalizado (sem entregador da loja)', finA.s === 200 && finA.j.status === 'finalizado', finA);
check('nao despacha pedido entregue pelo iFood', !(await acoes()).some((x) => x.acao === 'dispatch' && x.pedido === pa.j.id));
const vendaA = (await api('GET', `/sales/${finA.j.sale_id}`, null, A)).j;
check('venda: forma "online", precos do iFood, desconto 5, total 59', vendaA.forma_pagamento === 'online' && Number(vendaA.total) === 59 && Number(vendaA.desconto) === 5, vendaA);
const caixa = (await api('GET', `/cash-sessions/current?terminal_id=${PDVL}`, null, A)).j;
const vendasDinheiro = (await prod.query(`SELECT COALESCE(SUM(total), 0) AS t FROM sales WHERE cash_session_id = $1 AND forma_pagamento = 'dinheiro'`, [caixa.id])).rows[0].t;
check('pago online nao entra no dinheiro do caixa', Number(vendasDinheiro) === 0, vendasDinheiro);

console.log('\n# 3. Item sem vinculo: a equipe vincula uma vez e o sistema lembra');
const pb = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Coca 2L', codigo: 'COCA-2L', quantidade: 1, preco: 15 }] });
const pend = await ate(async () => { const r = await api('GET', '/integracoes/pendencias', null, A); return Array.isArray(r.j) ? r.j.find((p) => p.codigo_externo === pb.j.displayId) : null; });
check('pedido com item desconhecido fica em pendencias (sem virar pedido)', !!pend && pend.itens[0].product_id === null && pend.itens[0].nome === 'Coca 2L', pend);
const vin = await api('POST', `/integracoes/pedidos/${pend.id}/vincular`, { itens: [{ chave: pend.itens[0].chave, product_id: REFRI.id }] }, A);
check('vincular -> pedido importado', vin.s === 200 && vin.j.situacao === 'importado' && !!vin.j.order_id, vin);
const pc = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Coca 2L', codigo: 'COCA-2L', quantidade: 2, preco: 15 }] });
check('proximo pedido com o mesmo item entra sozinho (vinculo lembrado)', !!(await pedidoDoIfood(pc.j.id)));

console.log('\n# 4. Entrega da loja, dinheiro com troco e aceite automatico');
check('liga o aceite automatico', (await api('PATCH', `/integracoes/${INTEG}`, { aceite_automatico: true }, A)).s === 200);
const pd = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri lata', codigo: 'PRD-0001', quantidade: 2, preco: 8 }], entrega_ifood: false, pago_online: false, metodo: 'CASH', troco_para: 50, taxa: 6 });
const od = await pedidoDoIfood(pd.j.id);
check('pedido da loja: taxa de entrega 6 (a loja entrega), a cobrar em dinheiro', !!od && Number(od.taxa_entrega) === 6 && od.pago === false && od.forma_pagamento_prevista === 'dinheiro' && Number(od.valor_recebido) === 50, od);
check('aceite automatico confirmou no iFood', !!(await ate(async () => (await acoes()).some((x) => x.acao === 'confirm' && x.pedido === pd.j.id))));
const ent = await api('POST', '/couriers', { nome: 'Zé Entregas' }, A);
await api('POST', `/orders/${od.id}/status`, { para: 'em_preparo' }, A);
await api('POST', `/orders/${od.id}/status`, { para: 'pronto' }, A);
check('entrega da loja: pronto nao chama readyToPickup', !(await acoes()).some((x) => x.acao === 'readyToPickup' && x.pedido === pd.j.id));
check('saiu para entrega -> dispatch no iFood', (await api('POST', `/orders/${od.id}/status`, { para: 'saiu_entrega', entregador_id: ent.j.id }, A)).s === 200 && (await acoes()).some((x) => x.acao === 'dispatch' && x.pedido === pd.j.id));
const finD = await api('POST', `/orders/${od.id}/status`, { para: 'finalizado' }, A);
const vendaD = finD.s === 200 ? (await api('GET', `/sales/${finD.j.sale_id}`, null, A)).j : null;
check('finalizar: venda em dinheiro, total 22, troco de 50 = 28', vendaD && vendaD.forma_pagamento === 'dinheiro' && Number(vendaD.total) === 22 && Number(vendaD.troco) === 28, finD.s === 200 ? vendaD : finD);

console.log('\n# 5. Cancelamentos');
const pe5 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 8 }] });
const o5 = await pedidoDoIfood(pe5.j.id);
const semMotivo = await api('POST', `/orders/${o5.id}/cancel`, { motivo: 'Cliente ligou' }, A);
check('cancelar pedido do iFood sem o motivo da lista -> 400', semMotivo.s === 400 && /motivo/.test(semMotivo.j.erro), semMotivo);
const mot = await api('GET', `/integracoes/pedidos/${o5.externo.id}/motivos-cancelamento`, null, A);
check('motivos de cancelamento vem do iFood', mot.s === 200 && mot.j.some((m) => m.codigo === '503'), mot);
const canc = await api('POST', `/orders/${o5.id}/cancel`, { motivo: 'Item indisponível', codigo_motivo: '503' }, A);
check('cancelar com motivo -> pedido ao iFood, aqui fica "cancelamento solicitado"', canc.s === 200 && canc.j.status !== 'cancelado' && canc.j.externo.status_externo === 'CANCELLATION_REQUESTED' && (await acoes()).some((x) => x.acao === 'requestCancellation' && x.corpo.cancellationCode === '503'), canc);
check('iFood confirma -> pedido cancelado aqui (reserva liberada)', !!(await ate(async () => (await api('GET', `/orders/${o5.id}`, null, A)).j.status === 'cancelado')));
const pe6 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 8 }] });
const o6 = await pedidoDoIfood(pe6.j.id);
await sim('POST', `/_sim/pedidos/${pe6.j.id}/cancelar-cliente`);
const c6 = await ate(async () => { const o = (await api('GET', `/orders/${o6.id}`, null, A)).j; return o.status === 'cancelado' ? o : null; });
check('cliente cancelou no iFood -> cancelado aqui com o motivo', !!c6 && /iFood/.test(c6.motivo_cancelamento), c6);
const pe7 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 8 }] });
const o7 = await pedidoDoIfood(pe7.j.id);
await sim('POST', `/_sim/pedidos/${pe7.j.id}/disputa`);
const d7 = await ate(async () => { const o = (await api('GET', `/orders/${o7.id}`, null, A)).j; return o.externo && o.externo.disputa ? o : null; });
check('cliente pediu cancelamento depois de confirmado -> aparece a negociacao', !!d7 && !!d7.externo.disputa.disputeId, d7 && d7.externo);
const r7 = await api('POST', `/integracoes/pedidos/${o7.externo.id}/disputa`, { aceitar: true }, A);
check('aceitar a negociacao -> iFood avisado e pedido cancelado aqui', r7.s === 200 && (await acoes()).some((x) => x.acao === 'disputa_accept') && (await api('GET', `/orders/${o7.id}`, null, A)).j.status === 'cancelado', r7);

console.log('\n# 6. Falta de estoque: entra, mas nao e aceito sozinho');
const pe8 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'X-Burguer', codigo: 'PRD-0002', quantidade: 10, preco: 25 }] });
const o8 = await pedidoDoIfood(pe8.j.id);
const d8 = o8 ? (await api('GET', `/orders/${o8.id}`, null, A)).j : null;
check('pedido entra marcado com a falta (o pedido ja existe no iFood)', !!d8 && /falta/i.test(d8.externo.faltas_estoque || ''), d8 && d8.externo);
await espera(2500);
check('com falta de estoque o aceite automatico nao confirma', !(await acoes()).some((x) => x.acao === 'confirm' && x.pedido === pe8.j.id));
await api('POST', `/orders/${o8.id}/cancel`, { motivo: 'Item indisponível', codigo_motivo: '503' }, A);

console.log('\n# 7. Modulo desligado para de receber; token renovado sozinho; desconectar');
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: null } }, MAS);
check('modulo desligado: /integracoes -> 403', (await api('GET', '/integracoes', null, A)).s === 403);
const pe9 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri', codigo: 'PRD-0001', quantidade: 1, preco: 8 }] });
await espera(5000);
check('modulo desligado: pedido do iFood nao entra', !(await prod.query(`SELECT 1 FROM pedidos_externos WHERE externo_id = $1`, [pe9.j.id])).rows.length);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: true } }, MAS);
check('modulo ligado de novo: o pedido pendente entra', !!(await pedidoDoIfood(pe9.j.id)));
const antes = (await prod.query(`SELECT access_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0].access_token_cript;
await prod.query(`UPDATE integracoes_delivery SET token_expira_em = now() - interval '1 minute' WHERE id = $1`, [INTEG]);
const sinc = await api('POST', `/integracoes/${INTEG}/sincronizar`, null, A);
const depois = (await prod.query(`SELECT access_token_cript, token_expira_em > now() AS valido FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0];
check('token vencido e renovado sozinho (refresh)', sinc.s === 200 && depois.access_token_cript !== antes && depois.valido, sinc);
check('desconectar', (await api('DELETE', `/integracoes/${INTEG}`, null, A)).s === 204);
const off = (await prod.query(`SELECT status, access_token_cript, refresh_token_cript FROM integracoes_delivery WHERE id = $1`, [INTEG])).rows[0];
check('desconectado apaga os tokens', off.status === 'desconectado' && off.access_token_cript === null && off.refresh_token_cript === null, off);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: null } }, MAS);

await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
