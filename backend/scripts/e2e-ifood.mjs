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
import { createRequire } from 'node:module';

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

console.log('\n# 6b. Adicionais do iFood baixam insumo; codigo iFood do produto; disponibilidade automatica no cardapio');
const gAd = await api('POST', '/complement-groups', { nome: 'Adicionais iFood', minimo: 0, maximo: 3 }, A);
const ins = Object.fromEntries((await api('GET', '/ingredients', null, A)).j.map((i) => [i.nome, i]));
await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Bacon extra', preco: 3, ingredient_id: ins.Bacon.id, quantidade_insumo: 30, codigo: 'ADC-BACON' }, A);
await api('PUT', `/products/${XB.id}/complement-groups`, { grupos: [gAd.j.id] }, A);
check('marca X-Burguer para vender no iFood', (await api('PUT', `/products/${XB.id}`, { vende_ifood: true }, A)).j.vende_ifood === true);
check('refri com código próprio no iFood (REFRI-LATA)', (await api('PUT', `/products/${REFRI.id}`, { vende_ifood: true, codigo_ifood: 'refri-lata' }, A)).j.codigo_ifood === 'REFRI-LATA');
check('código do iFood repetido -> 409', (await api('PUT', `/products/${XB.id}`, { codigo_ifood: 'REFRI-LATA' }, A)).s === 409);
const pe10 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'X-Burguer', codigo: 'PRD-0002', quantidade: 1, preco: 25, opcoes: [{ nome: 'Bacon extra', codigo: 'ADC-BACON', preco: 3 }] }, { nome: 'Refri', codigo: 'REFRI-LATA', quantidade: 1, preco: 8 }] });
const o10 = await pedidoDoIfood(pe10.j.id);
const d10 = o10 ? (await api('GET', `/orders/${o10.id}`, null, A)).j : null;
const l10 = d10 && d10.itens.find((i) => i.product_id === XB.id);
check('adicional do iFood com código vira complemento (baixa 30 g de bacon) com o preço do iFood', !!l10 && l10.complementos.some((c) => c.nome === 'Bacon extra' && Number(c.preco) === 3) && Number(l10.preco_unitario) === 28, d10 && d10.itens);
check('item do iFood ligado pelo código iFood do produto (REFRI-LATA)', !!d10 && d10.itens.some((i) => i.product_id === REFRI.id));
const env = await api('POST', `/integracoes/${INTEG}/disponibilidade/enviar`, { tudo: true }, A);
const cat0 = (await sim('GET', '/_sim/catalogo')).j['sim-loja-1'] || {};
check('cardápio: X-Burguer, refri e bacon extra disponíveis no iFood', env.s === 200 && cat0['PRD-0002'].status === 'AVAILABLE' && cat0['REFRI-LATA'].status === 'AVAILABLE' && cat0['ADC-BACON'].status === 'AVAILABLE', { env, cat0 });
await api('POST', `/products/${REFRI.id}/stock-adjustment`, { location_id: L.Lanchonete, novo_saldo: 0, motivo: 'acabou o refri' }, A);
const pausado = await ate(async () => { const c = ((await sim('GET', '/_sim/catalogo')).j['sim-loja-1'] || {})['REFRI-LATA']; return c && c.status === 'UNAVAILABLE'; });
check('refri acabou na loja: pausado sozinho no iFood (próximo ciclo)', !!pausado);
const lista = await api('GET', `/integracoes/${INTEG}/disponibilidade`, null, A);
const lr = lista.j.find((x) => x.codigo === 'REFRI-LATA');
check('tela mostra o motivo da pausa', lr && lr.status === 'UNAVAILABLE' && /sem estoque/.test(lr.motivo) && lr.no_ifood === 'UNAVAILABLE', lr);
await api('POST', `/products/${REFRI.id}/stock-adjustment`, { location_id: L.Lanchonete, novo_saldo: 10, motivo: 'chegou refri' }, A);
check('refri voltou: reativado sozinho no iFood', !!(await ate(async () => (((await sim('GET', '/_sim/catalogo')).j['sim-loja-1'] || {})['REFRI-LATA'] || {}).status === 'AVAILABLE')));
const bac = await prod.query(`SELECT id FROM complementos WHERE codigo = 'ADC-BACON'`);
await api('PATCH', `/complements/${bac.rows[0].id}`, { ativo: false }, A);
check('complemento desativado: pausado no iFood', !!(await ate(async () => (((await sim('GET', '/_sim/catalogo')).j['sim-loja-1'] || {})['ADC-BACON'] || {}).status === 'UNAVAILABLE')));
await api('PATCH', `/complements/${bac.rows[0].id}`, { ativo: true }, A);
await api('POST', `/orders/${o10.id}/cancel`, { motivo: 'Item indisponível', codigo_motivo: '503' }, A);

console.log('\n# 6b. Cardápio: enviar produtos do GiroStock ao iFood; vínculo pelo nome; modo teste');
const card0 = await api('GET', `/integracoes/${INTEG}/cardapio`, null, A);
const lr0 = card0.j.produtos && card0.j.produtos.find((p) => p.id === REFRI.id);
check('lista do cardápio: produtos com o código PDV (código iFood do refri = REFRI-LATA) e o preço da loja', card0.s === 200 && lr0 && lr0.codigo === 'REFRI-LATA' && lr0.preco > 0, lr0);
const env1 = await api('POST', `/integracoes/${INTEG}/cardapio/enviar`, { product_ids: [REFRI.id, XB.id] }, A);
const simCard = async () => ((await sim('GET', '/_sim/cardapio')).j['sim-loja-1'] || { itens: {}, categorias: [] });
const sc1 = await simCard();
check('enviar ao iFood: 2 itens criados no cardápio com o código PDV, preço e categoria', env1.s === 200 && env1.j.enviados === 2 && sc1.itens['REFRI-LATA'] && sc1.itens['PRD-0002'] && sc1.itens['REFRI-LATA'].preco === lr0.preco && sc1.categorias.length >= 1, [env1.j, sc1]);
const idAntes = sc1.itens['REFRI-LATA'].itemId;
const env2 = await api('POST', `/integracoes/${INTEG}/cardapio/enviar`, { product_ids: [REFRI.id] }, A);
const sc2 = await simCard();
check('reenviar atualiza o mesmo item (mesmo id, sem duplicar categoria)', env2.j.enviados === 1 && sc2.itens['REFRI-LATA'].itemId === idAntes && sc2.categorias.length === sc1.categorias.length, sc2);
check('enviar marca "Vender no iFood" no produto', (await prod.query(`SELECT vende_ifood FROM products WHERE id = $1`, [REFRI.id])).rows[0].vende_ifood === true);
const precoNovo = Number((lr0.preco + 1).toFixed(2));
await prod.query(`UPDATE products SET preco_venda = $2 WHERE id = $1`, [REFRI.id, precoNovo]); // preço novo no cadastro
check('mudou o preço no GiroStock: atualiza sozinho no iFood (próximo ciclo)', !!(await ate(async () => ((await simCard()).itens['REFRI-LATA'] || {}).preco === precoNovo)), (await simCard()).itens['REFRI-LATA']);
const card1 = (await api('GET', `/integracoes/${INTEG}/cardapio`, null, A)).j.produtos.find((p) => p.id === REFRI.id);
check('tela mostra o produto no iFood com o preço em dia', card1.no_ifood && card1.preco_no_ifood === precoNovo && !card1.desatualizado, card1);
// pedido de TESTE do iFood com o item do cardapio enviado: chega com o codigo PDV e entra direto
const pcard = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Refri lata', codigo: 'REFRI-LATA', quantidade: 1, preco: precoNovo }] });
check('pedido com item do cardápio enviado entra direto (sem vincular) e o aceite automático confirma', !!(await pedidoDoIfood(pcard.j.id)) && !!(await ate(async () => (await acoes()).some((x) => x.acao === 'confirm' && x.pedido === pcard.j.id))));
// item sem codigo e com id novo a cada pedido (como os pedidos de teste): vincula uma vez, o nome fica lembrado
const pn1 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Coca Teste 350', quantidade: 1, preco: 6 }] });
const pend1 = await ate(async () => (await prod.query(`SELECT id, situacao FROM pedidos_externos WHERE externo_id = $1`, [pn1.j.id])).rows[0]);
check('item sem código e sem vínculo: aguardando vínculo', pend1 && pend1.situacao === 'aguardando_vinculo', pend1);
const chaveN = (await prod.query(`SELECT payload FROM pedidos_externos WHERE id = $1`, [pend1.id])).rows[0].payload.items[0].id;
const vinc = await api('POST', `/integracoes/pedidos/${pend1.id}/vincular`, { itens: [{ chave: `id:${chaveN}`, product_id: REFRI.id }] }, A);
check('vincular uma vez', vinc.s === 200 && vinc.j.situacao === 'importado', vinc.j);
const pn2 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: 'Coca  teste 350', quantidade: 2, preco: 6 }] });
check('próximo pedido com o mesmo item (id novo, mesmo nome): entra direto pelo nome lembrado', !!(await pedidoDoIfood(pn2.j.id)));
// modo teste: qualquer item desconhecido usa o produto padrao de teste
check('produto de teste inválido -> 400', (await api('PATCH', `/integracoes/${INTEG}`, { produto_teste_id: '00000000-0000-4000-8000-000000000000' }, A)).s === 400);
check('liga o modo teste com o produto padrão (X-Burguer)', (await api('PATCH', `/integracoes/${INTEG}`, { modo_teste: true, produto_teste_id: XB.id }, A)).s === 200);
const pt = await sim('POST', '/_sim/pedidos', { itens: [{ nome: `Item aleatorio ${Date.now()}`, quantidade: 1, preco: 10 }] });
const dpt = await pedidoDoIfood(pt.j.id);
check('modo teste: item aleatório entra como o produto de teste e o pedido é aceito sozinho', !!dpt && !!(await ate(async () => (await acoes()).some((x) => x.acao === 'confirm' && x.pedido === pt.j.id))));
const lista2 = (await api('GET', '/integracoes', null, A)).j.integracoes.find((i) => i.id === INTEG);
check('a conexão mostra modo teste e o produto de teste', lista2.modo_teste === true && lista2.produto_teste_id === XB.id, lista2);
await api('PATCH', `/integracoes/${INTEG}`, { modo_teste: false }, A);
const pt2 = await sim('POST', '/_sim/pedidos', { itens: [{ nome: `Outro aleatorio ${Date.now()}`, quantidade: 1, preco: 10 }] });
check('modo teste desligado: item desconhecido volta a pedir vínculo', (await ate(async () => (await prod.query(`SELECT situacao FROM pedidos_externos WHERE externo_id = $1`, [pt2.j.id])).rows[0]) || {}).situacao === 'aguardando_vinculo');

console.log('\n# 6c. Entregador do iFood (Entrega Fácil / Sob Demanda) para pedido de outro canal');
const novoPed = async (extra = {}) => (await api('POST', '/orders', { location_id: L.Lanchonete, origem: 'telefone', tipo: 'entrega', cliente_nome: 'Paula Cliente', cliente_telefone: '(41) 99876-5432',
  endereco: 'Avenida Paulista, 100 - Apto 12 - Bela Vista, São Paulo/SP (Ref.: perto do metrô)', taxa_entrega: 7, itens: [{ product_id: REFRI.id, quantidade: 2 }], ...extra }, A)).j;
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'entrada', quantidade: 30, location_destino_id: L.Lanchonete, motivo: 'e2e entrega ifood' }, A);
const PE = await novoPed();
const totalPE = Number(PE.total);
const prep = await api('GET', `/integracoes/entregas/pedidos/${PE.id}`, null, A);
check('preparar: pode chamar; endereço do texto do pedido separado em campos', prep.s === 200 && prep.j.pode === true && prep.j.endereco.logradouro === 'Avenida Paulista' && prep.j.endereco.numero === '100'
  && prep.j.endereco.complemento === 'Apto 12' && prep.j.endereco.bairro === 'Bela Vista' && prep.j.endereco.cidade === 'São Paulo' && prep.j.endereco.uf === 'SP' && prep.j.endereco.referencia === 'perto do metrô', prep.j);
const end = { ...prep.j.endereco, cep: '' };
check('cotar sem CEP -> 400', (await api('POST', `/integracoes/entregas/pedidos/${PE.id}/cotar`, { endereco: end }, A)).s === 400);
const cepr = await api('GET', '/integracoes/entregas/cep/01310100', null, A);
check('buscar CEP preenche rua, bairro e cidade', cepr.s === 200 && cepr.j.encontrado && cepr.j.cidade === 'São Paulo' && cepr.j.uf === 'SP', cepr.j);
const endOk = { ...end, cep: '01310-100', lat: null, lng: null };
const cot = await api('POST', `/integracoes/entregas/pedidos/${PE.id}/cotar`, { endereco: endOk }, A);
check('cotação: valor, distância, tempo e formas de pagamento; coordenadas do endereço', cot.s === 200 && cot.j.cotacao_id && cot.j.valor > 5 && cot.j.distancia_m > 1000 && cot.j.tempo_min === 20 && cot.j.tempo_max === 30
  && cot.j.formas.some((f) => f.metodo === 'CASH') && Math.abs(cot.j.lat - -23.5614) < 0.001 && cot.j.origem_coordenadas !== 'pino', cot.j);
const longe = await api('POST', `/integracoes/entregas/pedidos/${PE.id}/cotar`, { endereco: { ...endOk, cep: '20040020' } }, A);
check('endereço longe demais (> 10 km) -> 422 com o motivo em português', longe.s === 422 && /longe demais/.test(longe.j.erro), longe.j);
const pino = await api('POST', `/integracoes/entregas/pedidos/${PE.id}/cotar`, { endereco: { ...endOk, lat: -23.5600, lng: -46.6500 } }, A);
check('pino conferido no mapa: usa as coordenadas marcadas', pino.s === 200 && pino.j.origem_coordenadas === 'pino' && pino.j.lat === -23.56, pino.j);
const chamar = (corpo) => api('POST', `/integracoes/entregas/pedidos/${PE.id}/chamar`, { endereco: endOk, cotacao_id: cot.j.cotacao_id, cotacao: cot.j, alocar_em_min: 10, ...corpo }, A);
check('chamar sem dizer como o cliente paga -> 400', (await chamar({})).s === 400);
check('troco menor que o total -> 400', (await chamar({ pagamento: { tipo: 'dinheiro', troco_para: 1 } })).s === 400);
const ch = await chamar({ pagamento: { tipo: 'dinheiro', troco_para: 100 } });
check('entregador chamado: link de acompanhamento do iFood', ch.s === 201 && ch.j.status === 'solicitada' && /meupedido\.ifood\.com\.br/.test(ch.j.tracking_url) && ch.j.valor === cot.j.valor, ch.j);
const criada = (await acoes()).filter((x) => x.acao === 'entrega_criar').pop();
const corpoIf = criada && criada.corpo;
check('vai ao iFood: endereço completo com coordenadas (aparece no app do entregador), cliente e celular',
  corpoIf && corpoIf.delivery.deliveryAddress.streetName === 'Avenida Paulista' && corpoIf.delivery.deliveryAddress.postalCode === '01310100' && corpoIf.delivery.deliveryAddress.complement === 'Apto 12'
  && corpoIf.delivery.deliveryAddress.reference === 'perto do metrô' && typeof corpoIf.delivery.deliveryAddress.coordinates.latitude === 'number'
  && corpoIf.customer.phone.areaCode === '41' && corpoIf.customer.phone.number === '998765432' && corpoIf.delivery.preparationTime === 600, corpoIf);
check('itens, taxa e pagamento em dinheiro com troco batendo com o total do pedido', corpoIf && corpoIf.items.length === 1 && corpoIf.items[0].quantity === 2 && corpoIf.delivery.merchantFee === 7
  && corpoIf.payments.methods[0].method === 'CASH' && Math.abs(corpoIf.payments.methods[0].value - totalPE) < 0.01 && corpoIf.payments.methods[0].cash.changeFor === 100, [corpoIf, totalPE]);
check('chamar de novo com entregador a caminho -> 409', (await chamar({ pagamento: { tipo: 'dinheiro', troco_para: 100 } })).s === 409);
check('cancelar o pedido com entregador do iFood a caminho -> 409', (await api('POST', `/orders/${PE.id}/cancel`, { motivo: 'teste de cancelamento' }, A)).s === 409);
const statusEnt = async (id = PE.id) => (await api('GET', `/orders/${id}`, null, A)).j;
check('evento do iFood: buscando entregador (sem virar pedido do iFood)', !!(await ate(async () => (await statusEnt()).entrega_ifood?.status === 'buscando'))
  && !(await prod.query(`SELECT 1 FROM pedidos_externos WHERE externo_id = $1`, [criada.entrega])).rows.length);
await sim('POST', `/_sim/entregas/${criada.entrega}/alocar`);
const aloc = await ate(async () => { const o = await statusEnt(); return o.entrega_ifood?.status === 'alocado' ? o : null; });
check('entregador alocado, com o nome', aloc && aloc.entrega_ifood.entregador_nome === 'Carlos Entregador', aloc && aloc.entrega_ifood);
const rast = await api('GET', `/integracoes/entregas/pedidos/${PE.id}/rastreio`, null, A);
check('rastreio: posição do entregador no mapa', rast.s === 200 && rast.j.entregador && Math.abs(rast.j.entregador.lat - -23.54652) < 0.0001 && rast.j.previsao_entrega, rast.j);
await sim('POST', `/_sim/entregas/${criada.entrega}/coletar`);
const saiu = await ate(async () => { const o = await statusEnt(); return o.status === 'saiu_entrega' && o.entrega_ifood?.status === 'em_rota' ? o : null; });
check('entregador coletou: o pedido vai sozinho para "Saiu p/ entrega"', !!saiu, await statusEnt());
await sim('POST', `/_sim/entregas/${criada.entrega}/codigo`);
check('código de entrega que o entregador pede ao cliente (4 últimos dígitos)', !!(await ate(async () => (await statusEnt()).entrega_ifood?.codigo_entrega === '5432')));
await sim('POST', `/_sim/entregas/${criada.entrega}/concluir`);
check('entrega concluída no iFood', !!(await ate(async () => (await statusEnt()).entrega_ifood?.status === 'entregue')));
const fin = await api('POST', `/orders/${PE.id}/status`, { para: 'finalizado', forma_pagamento: 'dinheiro', valor_recebido: 100 }, A);
check('finalizar o pedido entregue pelo iFood (gera a venda)', fin.s === 200 && fin.j.status === 'finalizado', fin.j);
// segundo pedido: cartão na entrega e cancelamento do entregador
const PE2 = await novoPed();
const cot2 = (await api('POST', `/integracoes/entregas/pedidos/${PE2.id}/cotar`, { endereco: endOk }, A)).j;
check('cartão sem bandeira -> 400', (await api('POST', `/integracoes/entregas/pedidos/${PE2.id}/chamar`, { endereco: endOk, cotacao_id: cot2.cotacao_id, pagamento: { tipo: 'credito' } }, A)).s === 400);
const ch2 = await api('POST', `/integracoes/entregas/pedidos/${PE2.id}/chamar`, { endereco: endOk, cotacao_id: cot2.cotacao_id, cotacao: cot2, pagamento: { tipo: 'credito', bandeira: 'Visa' } }, A);
const corpo2 = (await acoes()).filter((x) => x.acao === 'entrega_criar').pop().corpo;
check('cartão de crédito na entrega: bandeira vai ao iFood', ch2.s === 201 && corpo2.payments.methods[0].method === 'CREDIT' && corpo2.payments.methods[0].card.brand === 'Visa', corpo2.payments);
const motE = await api('GET', `/integracoes/entregas/pedidos/${PE2.id}/motivos`, null, A);
check('motivos de cancelamento vêm do iFood', motE.s === 200 && motE.j.some((x) => x.codigo === '817'), motE.j);
check('motivo inválido -> 409', (await api('POST', `/integracoes/entregas/pedidos/${PE2.id}/cancelar`, { codigo: '999' }, A)).s === 409);
check('cancelar o entregador', (await api('POST', `/integracoes/entregas/pedidos/${PE2.id}/cancelar`, { codigo: '817' }, A)).s === 200);
check('evento do iFood: entrega cancelada', !!(await ate(async () => (await statusEnt(PE2.id)).entrega_ifood?.status === 'cancelada')));
check('sem entregador ativo, o pedido pode ser cancelado', (await api('POST', `/orders/${PE2.id}/cancel`, { motivo: 'cliente desistiu' }, A)).s === 200);
// sem o servico contratado; retirada; pedido do site com endereço em campos
await sim('POST', '/_sim/entregas/config', { desligado: true });
const PE3 = await novoPed();
const cot3 = (await api('POST', `/integracoes/entregas/pedidos/${PE3.id}/cotar`, { endereco: endOk }, A)).j;
const sd = await api('POST', `/integracoes/entregas/pedidos/${PE3.id}/chamar`, { endereco: endOk, cotacao_id: cot3.cotacao_id, pagamento: { tipo: 'pago' } }, A);
check('serviço não contratado: explica como ativar no Portal do Parceiro', sd.s === 422 && /Portal do Parceiro/.test(sd.j.erro), sd.j);
await sim('POST', '/_sim/entregas/config', { desligado: false });
const PR = (await api('POST', '/orders', { location_id: L.Lanchonete, origem: 'balcao', tipo: 'retirada', itens: [{ product_id: REFRI.id, quantidade: 1 }] }, A)).j;
const prr = (await api('GET', `/integracoes/entregas/pedidos/${PR.id}`, null, A)).j;
check('pedido de retirada não chama entregador', prr.pode === false && /entrega/.test(prr.motivo), prr);
check('cotar pedido de retirada -> 409', (await api('POST', `/integracoes/entregas/pedidos/${PR.id}/cotar`, { endereco: endOk }, A)).s === 409);
const { enderecoDoTexto } = createRequire(import.meta.url)('../src/integracoes/ifood/entregas');
const et = enderecoDoTexto('Rua das Flores, 200 - Centro, Curitiba/PR');
check('endereço do texto: rua, número, bairro, cidade e UF', et.logradouro === 'Rua das Flores' && et.numero === '200' && et.bairro === 'Centro' && et.cidade === 'Curitiba' && et.uf === 'PR', et);

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
const re = await api('POST', '/integracoes/ifood/conectar', { location_id: L.Lanchonete }, A);
check('conectar de novo depois de desconectar: reaproveita a conexao e gera novo codigo', re.s === 201 && re.j.id === INTEG && !!re.j.codigo, re);
const rePortal = await api('GET', `/_sim/autorizar?userCode=${re.j.codigo}`, null, null, SIM);
const reFim = await api('POST', `/integracoes/${INTEG}/concluir`, { codigo: rePortal.j.authorizationCode }, A);
check('reconectado', reFim.s === 200 && reFim.j.status === 'conectado', reFim);
await api('DELETE', `/integracoes/${INTEG}`, null, A);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { delivery_apps: null } }, MAS);

await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
