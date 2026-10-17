// Simulador local da OpenAPI da 99Food (so desenvolvimento/testes). Imita o necessario do fluxo real:
// autorizacao da loja pelo app_shop_id, token da loja (get/refresh), webhooks assinados (md5(corpo + app_secret) no header
// didi-header-sign, reenvio enquanto a resposta nao for errno 0), ids de pedido de 64 bits, e as acoes da loja
// (aceitar, pronto, despachar entrega propria, cancelar, detalhe).
//
// Uso:
//   npm run food99:simulador                       # porta 4998 (SIM_PORT muda); webhook em SIM_WEBHOOK
//   no backend/.env:  FOOD99_API_URL=http://localhost:4998/v1  FOOD99_APP_ID=sim  FOOD99_APP_SECRET=sim-segredo
//
// Controle do simulador:
//   GET  /_sim/autorizar?app_shop_id=GS...   -> a loja "autoriza o app" no portal da 99Food
//   POST /_sim/pedidos {"app_shop_id":"GS...","itens":[{"nome":"X-Burguer","codigo":"PRD-0002","quantidade":1,"preco":2500}]}  (centavos)
//   POST /_sim/pedidos/{id}/cancelar-cliente | /concluir | /parcial | /reenviar
//   POST /_sim/expirar?app_shop_id=GS...     -> o proximo token da loja responde 10102 (expirado)
//   GET  /_sim/acoes | /_sim/webhooks
import http from 'node:http';
import crypto from 'node:crypto';

const PORTA = Number(process.env.SIM_PORT || 4998);
const WEBHOOK = process.env.SIM_WEBHOOK || 'http://localhost:3000/api/webhooks/99food';
const APP_ID = process.env.SIM_APP_ID || 'sim';
const APP_SECRET = process.env.SIM_APP_SECRET || 'sim-segredo';

const autorizadas = new Set();
const expiradas = new Set();
const tokens = new Map(); // token -> app_shop_id
const pedidos = new Map(); // order_id (texto) -> order_info
const acoes = [];
const entregas = []; // webhooks enviados { tipo, order_id, tentativas, resposta }
let indice = 0;

// Id de 64 bits (maior que Number.MAX_SAFE_INTEGER, como os da 99Food).
const novoId = () => (5764607523034234880n + BigInt(Math.floor(Math.random() * 1e15))).toString();
// JSON com os ids de 64 bits como numero (sem aspas), do jeito que a 99Food manda.
const jsonCom64 = (obj) => JSON.stringify(obj).replace(/"(order_id|shop_id)":"(\d{16,})"/g, '"$1":$2');
const lerJson64 = (t) => JSON.parse(t.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
const assinar = (corpo) => crypto.createHash('md5').update(corpo + APP_SECRET).digest('hex');

function enviarWebhook(tipo, info, extra = {}, tentativa = 1, registro = null) {
  const corpo = jsonCom64({ type: tipo, app_id: APP_ID, app_shop_id: info.shop.app_shop_id, timestamp: Math.floor(Date.now() / 1000), data: { order_id: info.order_id, ...(tipo === 'orderNew' ? { order_info: info } : {}), ...extra } });
  const reg = registro || { tipo, order_id: info.order_id, tentativas: 0, resposta: null };
  if (!registro) entregas.push(reg);
  reg.tentativas = tentativa;
  return new Promise((ok) => {
    const url = new URL(WEBHOOK);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'didi-header-sign': process.env.SIM_ASSINATURA_ERRADA ? 'errada' : assinar(corpo), 'content-length': Buffer.byteLength(corpo) }, timeout: 6000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const t = Buffer.concat(partes).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch { /* nada */ }
        reg.resposta = { status: res.statusCode, corpo: j || t };
        // Sem errno 0: a 99Food reenvia (aqui, a cada 2 s, ate 30 vezes).
        if (!j || j.errno !== 0) { if (tentativa < 30) setTimeout(() => enviarWebhook(tipo, info, extra, tentativa + 1, reg), 2000); }
        ok(reg);
      });
    });
    req.on('error', (e) => { reg.resposta = { erro: e.message }; if (tentativa < 30) setTimeout(() => enviarWebhook(tipo, info, extra, tentativa + 1, reg), 2000); ok(reg); });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 6 s')));
    req.end(corpo);
  });
}

function novoPedido(b) {
  const shopId = b.app_shop_id;
  const entrega = b.entrega || 'plataforma'; // plataforma | loja | retirada
  const itens = (b.itens || [{ nome: 'X-Burguer', codigo: 'PRD-0002', quantidade: 1, preco: 2500 }]).map((it) => {
    const q = it.quantidade || 1;
    const subs = (it.opcoes || []).map((o) => ({ name: o.nome, app_item_id: o.codigo || undefined, amount: (o.quantidade || 1) * q, sku_price: o.preco || 0, total_price: (o.preco || 0) * (o.quantidade || 1) * q, sub_item_list: [] }));
    return { name: it.nome, app_item_id: it.codigo || undefined, amount: q, sku_price: it.preco, total_price: it.preco * q + subs.reduce((s, x) => s + x.total_price, 0), remark: it.observacao || '', sub_item_list: subs };
  });
  const totalItens = itens.reduce((s, i) => s + i.total_price, 0);
  const taxa = entrega === 'retirada' ? 0 : (b.taxa ?? 700);
  const online = b.pago_online !== false;
  const info = {
    order_id: novoId(), order_index: ++indice, status: 100, remark: b.observacao || '',
    pay_type: online ? 1 : 2, pay_method: online ? 1 : 2, pay_channel: online ? 150 : (b.canal || 153),
    delivery_type: entrega === 'plataforma' ? 1 : entrega === 'loja' ? 2 : 0, fulfillment_mode: entrega === 'retirada' ? 1 : 0,
    create_time: Math.floor(Date.now() / 1000),
    price: { order_price: totalItens, real_price: totalItens + taxa, real_pay_price: totalItens + taxa, delivery_price: taxa, customer_need_paying_money: online ? 0 : totalItens + taxa },
    shop: { shop_id: novoId(), app_shop_id: shopId, shop_name: 'Lanchonete na 99 (simulada)' },
    receive_address: entrega === 'retirada' ? { name: b.cliente || 'João Cliente', phone: '41999990000' } : {
      name: b.cliente || 'João Cliente', first_name: 'João', last_name: 'Cliente', phone: '41999990000', virtual_phone_number: '', city: 'Curitiba',
      poi_address: 'Rua das Flores, 100', street_name: 'Rua das Flores', street_number: '100', district: 'Centro', postalCode: '80010000', complement: 'Casa 2', poi_lat: 0, poi_lng: 0,
    },
    order_items: itens,
  };
  pedidos.set(info.order_id, info);
  return info;
}

function responder(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(corpo === undefined ? '' : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)));
}
const ok99 = (data) => jsonCom64({ errno: 0, errmsg: 'ok', data: data === undefined ? {} : data });
const erro99 = (errno, errmsg) => ({ errno, errmsg, data: {} });
function lerCorpo(req) {
  return new Promise((ok) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => { const t = Buffer.concat(partes).toString('utf8'); if (!t) return ok({ bruto: '', json: {} }); try { ok({ bruto: t, json: lerJson64(t) }); } catch { ok({ bruto: t, json: {} }); } });
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const c = url.pathname;
  const { bruto, json: b } = await lerCorpo(req);
  try {
    // ---------- controle do simulador ----------
    if (c === '/_sim/autorizar') { const s = url.searchParams.get('app_shop_id'); if (!s) return responder(res, 400, { erro: 'app_shop_id' }); autorizadas.add(s); return responder(res, 200, { ok: true, app_shop_id: s }); }
    if (c === '/_sim/desautorizar') { autorizadas.delete(url.searchParams.get('app_shop_id')); return responder(res, 200, { ok: true }); }
    if (c === '/_sim/expirar') { expiradas.add(url.searchParams.get('app_shop_id')); return responder(res, 200, { ok: true }); }
    if (c === '/_sim/acoes') return responder(res, 200, acoes);
    if (c === '/_sim/webhooks') return responder(res, 200, entregas);
    if (c === '/_sim/pedidos' && req.method === 'POST') {
      const info = novoPedido(b);
      const r = await enviarWebhook('orderNew', info);
      return responder(res, 201, { order_id: info.order_id, order_index: info.order_index, webhook: r.resposta });
    }
    let m = c.match(/^\/_sim\/pedidos\/(\d+)\/(cancelar-cliente|concluir|parcial|reenviar|pronto-99)$/);
    if (m && req.method === 'POST') {
      const info = pedidos.get(m[1]);
      if (!info) return responder(res, 404, {});
      const tipo = { 'cancelar-cliente': 'orderCancel', concluir: 'orderFinish', parcial: 'orderPartialCancel', reenviar: 'orderNew', 'pronto-99': 'orderReady' }[m[2]];
      const r = await enviarWebhook(tipo, info, m[2] === 'cancelar-cliente' ? { cancel_reason: 'Cliente desistiu' } : {});
      return responder(res, 200, { webhook: r.resposta });
    }

    // ---------- OpenAPI ----------
    if (!c.startsWith('/v1/')) return responder(res, 404, erro99(404, `rota não simulada: ${c}`));
    const rota = c.slice(3);
    if (rota === '/auth/authtoken/get' || rota === '/auth/authtoken/refresh') {
      const q = url.searchParams;
      if (q.get('app_id') !== APP_ID || q.get('app_secret') !== APP_SECRET) return responder(res, 200, erro99(10001, 'app_id/app_secret inválidos'));
      const s = q.get('app_shop_id');
      if (!autorizadas.has(s)) return responder(res, 200, erro99(10003, 'shop not authorized'));
      if (rota === '/auth/authtoken/refresh') { expiradas.delete(s); return responder(res, 200, ok99({})); }
      if (expiradas.has(s)) return responder(res, 200, erro99(10102, 'token expired'));
      const token = 'sim99-' + crypto.randomBytes(10).toString('hex');
      tokens.set(token, s);
      return responder(res, 200, ok99({ auth_token: token, token_expiration_time: Math.floor(Date.now() / 1000) + Number(process.env.SIM_EXPIRA || 7200) }));
    }
    if (req.method !== 'POST') return responder(res, 405, erro99(405, 'use POST'));
    const loja = tokens.get(b.auth_token);
    if (!loja || !autorizadas.has(loja)) return responder(res, 200, erro99(10101, 'auth_token inválido'));
    // order_id precisa vir como NUMERO no JSON (sem aspas), como na 99Food.
    if (!/"order_id"\s*:\s*\d/.test(bruto)) return responder(res, 200, erro99(10400, 'order_id deve ser número'));
    const info = pedidos.get(String(b.order_id));
    if (!info || info.shop.app_shop_id !== loja) return responder(res, 200, erro99(30001, 'pedido não encontrado'));
    const registrar = (acao) => acoes.push({ acao, order_id: info.order_id, order_index: info.order_index, corpo: { ...b, auth_token: undefined }, em: new Date().toISOString() });
    if (rota === '/order/order/detail') return responder(res, 200, ok99({ order_info: info }));
    if (rota === '/order/order/confirm') { registrar('confirm'); setTimeout(() => enviarWebhook('orderConfirm', info), 50); return responder(res, 200, ok99()); }
    if (rota === '/order/order/ready') { registrar('ready'); setTimeout(() => enviarWebhook('orderReady', info), 50); return responder(res, 200, ok99()); }
    if (rota === '/order/selfdelivery/dispatch') {
      if (info.delivery_type !== 2) return responder(res, 200, erro99(30010, 'pedido não é de entrega própria'));
      if (!b.courier_info || !b.courier_info.courier_name) return responder(res, 200, erro99(10400, 'courier_info obrigatório'));
      registrar('dispatch'); return responder(res, 200, ok99());
    }
    if (rota === '/order/order/cancel') {
      if (!b.reason_id) return responder(res, 200, erro99(10400, 'reason_id obrigatório'));
      registrar('cancel'); setTimeout(() => enviarWebhook('orderCancel', info, { cancel_reason: b.reason }), 50); return responder(res, 200, ok99());
    }
    return responder(res, 404, erro99(404, `rota não simulada: ${rota}`));
  } catch (err) {
    return responder(res, 500, erro99(500, err.message));
  }
});

servidor.listen(PORTA, () => console.log(`Simulador da 99Food em http://localhost:${PORTA}/v1 (webhook -> ${WEBHOOK})`));
