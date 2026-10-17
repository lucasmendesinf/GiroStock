// Simulador local da API do iFood (so desenvolvimento/testes). Imita o necessario do fluxo real:
// vinculo da loja (userCode -> autorizar -> token), lojas, eventos por polling + ACK, detalhe do pedido,
// confirmar / iniciar preparo / pronto / despachar, motivos e pedido de cancelamento, negociacao (disputa).
//
// Uso:
//   npm run ifood:simulador                        # porta 4999 (SIM_PORT muda)
//   no backend/.env:  IFOOD_API_URL=http://localhost:4999  IFOOD_CLIENT_ID=sim  IFOOD_CLIENT_SECRET=sim
//
// Controle do simulador (fazer de conta que um cliente pediu no app):
//   POST /_sim/pedidos {"merchantId":"sim-loja-1","itens":[{"nome":"X-Burguer","codigo":"PRD-0004","quantidade":1,"preco":25}]}
//   GET  /_sim/autorizar?userCode=XXXX      -> mostra o codigo de autorizacao (o "Portal do Parceiro")
//   POST /_sim/pedidos/{id}/cancelar-cliente | /disputa | /concluir
//   GET  /_sim/acoes                         -> o que o GiroStock chamou (confirm, startPreparation...)
import http from 'node:http';
import crypto from 'node:crypto';

const PORTA = Number(process.env.SIM_PORT || 4999);
const BASE = `http://localhost:${PORTA}`;
const LOJAS = Number(process.env.SIM_LOJAS || 1) > 1
  ? [{ id: 'sim-loja-1', name: 'Lanchonete Simulada (Centro)' }, { id: 'sim-loja-2', name: 'Lanchonete Simulada (Bairro)' }]
  : [{ id: 'sim-loja-1', name: 'Lanchonete Simulada' }];

const id = () => crypto.randomUUID();
const codigos = new Map(); // userCode -> { verificador, autorizacao }
const autorizacoes = new Map(); // authorizationCode -> verificador
const tokens = new Set();
const refreshs = new Set();
const pedidos = new Map(); // id -> payload
let eventos = []; // { id, code, fullCode, orderId, merchantId, createdAt, metadata }
const acoes = [];
const disputas = new Map(); // disputeId -> orderId
let display = 1000;

const FULL = { PLC: 'PLACED', CFM: 'CONFIRMED', RTP: 'READY_TO_PICKUP', DSP: 'DISPATCHED', CON: 'CONCLUDED', CAN: 'CANCELLED', HSD: 'HANDSHAKE_DISPUTE', HSS: 'HANDSHAKE_SETTLEMENT' };
function evento(code, pedido, metadata) {
  eventos.push({ id: id(), code, fullCode: FULL[code] || code, orderId: pedido.id, merchantId: pedido.merchant.id, createdAt: new Date().toISOString(), salesChannel: 'IFOOD', metadata });
}
function emitirTokens() {
  const accessToken = 'sim-at-' + crypto.randomBytes(12).toString('hex');
  const refreshToken = 'sim-rt-' + crypto.randomBytes(12).toString('hex');
  tokens.add(accessToken); refreshs.add(refreshToken);
  return { accessToken, refreshToken, type: 'bearer', expiresIn: Number(process.env.SIM_EXPIRA || 21600) };
}

function novoPedido(b) {
  const merchant = LOJAS.find((l) => l.id === (b.merchantId || 'sim-loja-1')) || LOJAS[0];
  const itens = (b.itens || [{ nome: 'X-Burguer', codigo: 'PRD-0004', quantidade: 1, preco: 25 }]).map((it, i) => {
    const opcoes = (it.opcoes || []).map((o, j) => ({ index: j, id: id(), name: o.nome, externalCode: o.codigo || null, quantity: o.quantidade || 1, unitPrice: o.preco || 0, price: (o.preco || 0) * (o.quantidade || 1) }));
    const opPreco = opcoes.reduce((s, o) => s + o.price, 0);
    const q = it.quantidade || 1;
    return {
      index: i, id: it.idCatalogo || id(), uniqueId: id(), name: it.nome, externalCode: it.codigo || null, ean: it.ean || null, unit: 'UN', quantity: q,
      unitPrice: it.preco, optionsPrice: opPreco, totalPrice: Number(((it.preco + opPreco) * q).toFixed(2)), price: it.preco * q, observations: it.observacao || null, options: opcoes,
    };
  });
  const subTotal = Number(itens.reduce((s, i) => s + i.totalPrice, 0).toFixed(2));
  const tipo = b.tipo || 'DELIVERY';
  const entregaIfood = b.entrega_ifood !== false;
  const taxa = tipo === 'DELIVERY' ? (b.taxa ?? 7) : 0;
  const desconto = b.desconto_loja || 0;
  const online = b.pago_online !== false;
  const total = Number((subTotal + taxa - desconto).toFixed(2));
  const p = {
    id: id(), displayId: String(++display), orderType: tipo, orderTiming: 'IMMEDIATE', salesChannel: 'IFOOD', category: 'FOOD', createdAt: new Date().toISOString(), isTest: true,
    merchant: { id: merchant.id, name: merchant.name },
    customer: { id: id(), name: b.cliente || 'Maria Cliente', documentNumber: null, phone: { number: '0800 705 0050', localizer: '12345678', localizerExpiration: new Date(Date.now() + 3 * 3600e3).toISOString() } },
    items: itens,
    benefits: desconto ? [{ value: desconto, target: 'CART', sponsorshipValues: [{ name: 'MERCHANT', value: desconto }, { name: 'IFOOD', value: 0 }] }] : [],
    total: { subTotal, deliveryFee: taxa, benefits: desconto, orderAmount: total, additionalFees: 0 },
    payments: online
      ? { prepaid: total, pending: 0, methods: [{ value: total, currency: 'BRL', method: 'CREDIT', type: 'ONLINE', card: { brand: 'VISA' } }] }
      : { prepaid: 0, pending: total, methods: [{ value: total, currency: 'BRL', method: b.metodo || 'CASH', type: 'OFFLINE', ...(b.troco_para ? { cash: { changeFor: b.troco_para } } : {}) }] },
    ...(tipo === 'DELIVERY' ? { delivery: { mode: 'DEFAULT', deliveredBy: entregaIfood ? 'IFOOD' : 'MERCHANT', deliveryDateTime: new Date(Date.now() + 45 * 60e3).toISOString(), pickupCode: '4321', observations: b.obs_entrega || null,
      deliveryAddress: { streetName: 'Rua XV de Novembro', streetNumber: '700', formattedAddress: 'Rua XV de Novembro, 700', neighborhood: 'Centro', complement: 'Apto 12', reference: 'Perto da praça', postalCode: '80020310', city: 'Curitiba', state: 'PR', country: 'BR' } } } : {}),
    ...(tipo === 'TAKEOUT' ? { takeout: { mode: 'DEFAULT', takeoutDateTime: new Date(Date.now() + 30 * 60e3).toISOString() } } : {}),
  };
  pedidos.set(p.id, p);
  evento('PLC', p);
  return p;
}

function responder(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(corpo === undefined ? '' : JSON.stringify(corpo));
}
function lerCorpo(req) {
  return new Promise((ok) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const t = Buffer.concat(partes).toString('utf8');
      if (!t) return ok({});
      if ((req.headers['content-type'] || '').includes('x-www-form-urlencoded')) return ok(Object.fromEntries(new URLSearchParams(t)));
      try { ok(JSON.parse(t)); } catch { ok({}); }
    });
  });
}
const autorizado = (req) => tokens.has(String(req.headers.authorization || '').replace(/^Bearer /, ''));

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const c = url.pathname;
  const b = await lerCorpo(req);
  try {
    // ---------- controle do simulador ----------
    if (c === '/_sim/pedidos' && req.method === 'POST') { const p = novoPedido(b); return responder(res, 201, { id: p.id, displayId: p.displayId }); }
    if (c === '/_sim/autorizar') {
      const r = codigos.get(url.searchParams.get('userCode'));
      if (!r) return responder(res, 404, { error: { message: 'código de vínculo inválido' } });
      r.autorizacao = r.autorizacao || 'SIM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      autorizacoes.set(r.autorizacao, r.verificador);
      return responder(res, 200, { authorizationCode: r.autorizacao, mensagem: 'Cole este código de autorização no GiroStock' });
    }
    if (c === '/_sim/acoes') return responder(res, 200, acoes);
    if (c === '/_sim/eventos') return responder(res, 200, eventos);
    let m = c.match(/^\/_sim\/pedidos\/([^/]+)\/(cancelar-cliente|disputa|concluir)$/);
    if (m && req.method === 'POST') {
      const p = pedidos.get(m[1]);
      if (!p) return responder(res, 404, {});
      if (m[2] === 'cancelar-cliente') evento('CAN', p, { reason: 'Cliente desistiu' });
      if (m[2] === 'concluir') evento('CON', p);
      if (m[2] === 'disputa') { const disputeId = id(); disputas.set(disputeId, p.id); evento('HSD', p, { disputeId, action: 'CANCELLATION', message: 'Cliente pediu para cancelar', timeoutAction: 'ACCEPT_CANCELLATION', expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(), acceptCancellationReasons: ['CUSTOMER_REQUEST'] }); }
      return responder(res, 202, { ok: true });
    }

    // ---------- autenticacao ----------
    if (c === '/authentication/v1.0/oauth/userCode' && req.method === 'POST') {
      if (!b.clientId) return responder(res, 400, { error: { message: 'clientId obrigatório' } });
      const userCode = crypto.randomBytes(3).toString('hex').toUpperCase();
      const verificador = crypto.randomBytes(16).toString('hex');
      codigos.set(userCode, { verificador });
      return responder(res, 200, { userCode, authorizationCodeVerifier: verificador, verificationUrl: `${BASE}/_sim/autorizar`, verificationUrlComplete: `${BASE}/_sim/autorizar?userCode=${userCode}`, expiresIn: 600 });
    }
    if (c === '/authentication/v1.0/oauth/token' && req.method === 'POST') {
      if (!b.clientId || !b.clientSecret) return responder(res, 401, { error: { message: 'credenciais do app inválidas' } });
      if (b.grantType === 'authorization_code') {
        if (autorizacoes.get(b.authorizationCode) !== b.authorizationCodeVerifier) return responder(res, 400, { error: { message: 'authorizationCode inválido' } });
        autorizacoes.delete(b.authorizationCode);
        return responder(res, 200, emitirTokens());
      }
      if (b.grantType === 'refresh_token') {
        if (!refreshs.has(b.refreshToken)) return responder(res, 401, { error: { message: 'refreshToken inválido' } });
        refreshs.delete(b.refreshToken);
        return responder(res, 200, emitirTokens());
      }
      return responder(res, 400, { error: { message: 'grantType inválido' } });
    }

    if (!autorizado(req)) return responder(res, 401, { error: { message: 'token inválido' } });

    // ---------- lojas, eventos ----------
    if (c === '/merchant/v1.0/merchants') return responder(res, 200, LOJAS);
    if (c === '/events/v1.0/events:polling') {
      const lojas = String(req.headers['x-polling-merchants'] || '').split(',').filter(Boolean);
      const lista = eventos.filter((e) => lojas.length === 0 || lojas.includes(e.merchantId));
      return lista.length ? responder(res, 200, lista) : responder(res, 204);
    }
    if (c === '/events/v1.0/events/acknowledgment' && req.method === 'POST') {
      const ids = new Set((Array.isArray(b) ? b : []).map((x) => x.id));
      eventos = eventos.filter((e) => !ids.has(e.id));
      return responder(res, 202);
    }

    // ---------- pedido ----------
    m = c.match(/^\/order\/v1\.0\/orders\/([^/]+)(?:\/([A-Za-z]+))?$/);
    if (m) {
      const p = pedidos.get(m[1]);
      if (!p) return responder(res, 404, { error: { message: 'pedido não encontrado' } });
      const a = m[2];
      if (!a && req.method === 'GET') return responder(res, 200, p);
      if (a === 'cancellationReasons') return responder(res, 200, [{ cancelCodeId: '501', description: 'Problemas de sistema' }, { cancelCodeId: '503', description: 'Item indisponível' }, { cancelCodeId: '506', description: 'Loja fechada' }]);
      acoes.push({ acao: a, pedido: p.id, displayId: p.displayId, corpo: b, em: new Date().toISOString() });
      if (a === 'confirm') evento('CFM', p);
      else if (a === 'readyToPickup') evento('RTP', p);
      else if (a === 'dispatch') evento('DSP', p);
      else if (a === 'requestCancellation') { if (!b.cancellationCode) return responder(res, 400, { error: { message: 'cancellationCode obrigatório' } }); evento('CAN', p, { reason: b.reason }); }
      else if (a !== 'startPreparation') return responder(res, 404, {});
      return responder(res, 202, { status: 'ACCEPTED' });
    }
    m = c.match(/^\/order\/v1\.0\/disputes\/([^/]+)\/(accept|reject)$/);
    if (m && req.method === 'POST') {
      const p = pedidos.get(disputas.get(m[1]));
      if (!p) return responder(res, 404, { error: { message: 'disputa não encontrada' } });
      disputas.delete(m[1]);
      acoes.push({ acao: `disputa_${m[2]}`, disputa: m[1], corpo: b, em: new Date().toISOString() });
      evento('HSS', p);
      if (m[2] === 'accept') evento('CAN', p, { reason: 'Cancelamento aceito pela loja' });
      return responder(res, 202, { status: 'ACCEPTED' });
    }
    return responder(res, 404, { error: { message: `rota não simulada: ${req.method} ${c}` } });
  } catch (err) {
    return responder(res, 500, { error: { message: err.message } });
  }
});

servidor.listen(PORTA, () => console.log(`Simulador do iFood em ${BASE} (lojas: ${LOJAS.map((l) => l.id).join(', ')})`));
