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
const catalogo = new Map(); // merchantId -> Map(externalCode -> { status, em })
const categoriasSim = new Map(); // merchantId -> [{ id, name, status, template }]
const itensSim = new Map(); // merchantId -> Map(externalCode -> { itemId, productId, nome, preco, status, categoryId, imagem })
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let display = 1000;

const FULL = { PLC: 'PLACED', CFM: 'CONFIRMED', RTP: 'READY_TO_PICKUP', DSP: 'DISPATCHED', CON: 'CONCLUDED', CAN: 'CANCELLED', HSD: 'HANDSHAKE_DISPUTE', HSS: 'HANDSHAKE_SETTLEMENT' };
function evento(code, pedido, metadata) {
  eventos.push({ id: id(), code, fullCode: FULL[code] || code, orderId: pedido.id, merchantId: pedido.merchant.id, createdAt: new Date().toISOString(), salesChannel: 'IFOOD', metadata });
}
// ---------- Shipping (Entrega Facil / Sob Demanda) ----------
// Loja simulada na Praca da Se (SP). Cotacao: R$ 5,00 + R$ 1,50 por km; acima de 10 km -> DeliveryDistanceTooHigh.
const LOJA_PONTO = { lat: -23.55052, lng: -46.633308 };
const cotacoesSim = new Map(); // quoteId -> { merchantId, lat, lng, valor }
const entregasSim = new Map(); // id -> { merchantId, corpo, status, rastreio }
let shippingDesligado = false;
const CURTO = { REQUEST_DRIVER: 'RDR', ASSIGN_DRIVER: 'ADR', REQUEST_DRIVER_SUCCESS: 'RDS', REQUEST_DRIVER_FAILED: 'RDF', GOING_TO_ORIGIN: 'GTO', ARRIVED_AT_ORIGIN: 'AAO',
  COLLECTED: 'CLT', DELIVERY_IN_TRANSIT: 'DIT', ARRIVED_AT_DESTINATION: 'AAD', DELIVERY_DROP_CODE_REQUESTED: 'DDCR', DELIVERY_CONCLUDED: 'CON', CANCELLATION_REQUESTED: 'CAR', CANCELLED: 'CAN' };
function eventoEntrega(fullCode, idEntrega, metadata) {
  const e = entregasSim.get(idEntrega);
  eventos.push({ id: id(), code: CURTO[fullCode] || fullCode, fullCode, orderId: idEntrega, merchantId: e.merchantId, createdAt: new Date().toISOString(), salesChannel: 'POS', metadata });
}
function distanciaKm(a, b) {
  const r = 6371; const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
const erroShip = (res, code, msg) => responder(res, 400, { error: { code, message: msg || code } });

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
    if (c === '/_sim/entregas' && req.method === 'GET') return responder(res, 200, Object.fromEntries(entregasSim));
    if (c === '/_sim/entregas/config' && req.method === 'POST') { shippingDesligado = !!b.desligado; return responder(res, 200, { desligado: shippingDesligado }); }
    let me = c.match(/^\/_sim\/entregas\/([^/]+)\/([a-z_]+)$/);
    if (me && req.method === 'POST') {
      const e = entregasSim.get(me[1]);
      if (!e) return responder(res, 404, { error: { message: 'entrega não encontrada' } });
      const passo = me[2];
      const tel = e.corpo.customer.phone || {};
      const mapa = {
        alocar: () => { e.status = 'alocado'; e.rastreio = { lat: LOJA_PONTO.lat + 0.004, lng: LOJA_PONTO.lng }; eventoEntrega('ASSIGN_DRIVER', me[1], { workerName: 'Carlos Entregador' }); },
        a_caminho: () => { e.status = 'indo_loja'; eventoEntrega('GOING_TO_ORIGIN', me[1], {}); },
        na_loja: () => { e.status = 'na_loja'; e.rastreio = { ...LOJA_PONTO }; eventoEntrega('ARRIVED_AT_ORIGIN', me[1], {}); },
        coletar: () => { e.status = 'em_rota'; const d = e.corpo.delivery.deliveryAddress.coordinates; e.rastreio = { lat: (LOJA_PONTO.lat + d.latitude) / 2, lng: (LOJA_PONTO.lng + d.longitude) / 2 }; eventoEntrega('COLLECTED', me[1], {}); },
        codigo: () => { eventoEntrega('DELIVERY_DROP_CODE_REQUESTED', me[1], { CODE: String(tel.number || '').slice(-4) }); },
        no_destino: () => { e.status = 'no_destino'; const d = e.corpo.delivery.deliveryAddress.coordinates; e.rastreio = { lat: d.latitude, lng: d.longitude }; eventoEntrega('ARRIVED_AT_DESTINATION', me[1], {}); },
        concluir: () => { e.status = 'entregue'; eventoEntrega('DELIVERY_CONCLUDED', me[1], {}); },
        falhar: () => { e.status = 'falhou'; eventoEntrega('REQUEST_DRIVER_FAILED', me[1], { reason: 'sem entregadores na região' }); },
      };
      if (!mapa[passo]) return responder(res, 400, { error: { message: 'passo inválido' } });
      mapa[passo]();
      return responder(res, 200, { ok: true, status: e.status });
    }
    if (c === '/_sim/eventos') return responder(res, 200, eventos);
    if (c === '/_sim/cardapio') return responder(res, 200, Object.fromEntries([...itensSim].map(([mm, mapa]) => [mm, { categorias: categoriasSim.get(mm) || [], itens: Object.fromEntries(mapa) }])));
    if (c === '/_sim/catalogo') return responder(res, 200, Object.fromEntries([...catalogo].map(([m, mapa]) => [m, Object.fromEntries(mapa)])));
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

    // ---------- shipping (Sob Demanda) ----------
    let ms = c.match(/^\/shipping\/v1\.0\/merchants\/([^/]+)\/deliveryAvailabilities$/);
    if (ms && req.method === 'GET') {
      const lat = Number(url.searchParams.get('latitude')); const lng = Number(url.searchParams.get('longitude'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return erroShip(res, 'BadRequest');
      const km = distanciaKm(LOJA_PONTO, { lat, lng });
      if (km > 10) return erroShip(res, 'DeliveryDistanceTooHigh');
      const valor = Math.round((5 + 1.5 * km) * 100) / 100;
      const qid = crypto.randomUUID();
      cotacoesSim.set(qid, { merchantId: ms[1], lat, lng, valor });
      return responder(res, 200, {
        id: qid, expirationAt: new Date(Date.now() + 86400e3).toISOString(), createdAt: new Date().toISOString(), distance: Math.round(km * 1000), preparationTime: 600,
        quote: { grossValue: valor, discount: 0, raise: 0, netValue: valor }, deliveryTime: { min: 1200, max: 1800 }, hasPaymentMethods: true,
        paymentMethods: [{ id: id(), brand: 'Visa', liability: 'IFOOD', paymentType: 'OFFLINE', method: 'CREDIT' }, { id: id(), brand: 'Mastercard', liability: 'IFOOD', paymentType: 'OFFLINE', method: 'DEBIT' }, { id: id(), liability: 'IFOOD', paymentType: 'OFFLINE', method: 'CASH' }],
      });
    }
    ms = c.match(/^\/shipping\/v1\.0\/merchants\/([^/]+)\/orders$/);
    if (ms && req.method === 'POST') {
      if (shippingDesligado) return erroShip(res, 'MerchantEasyDeliveryDisabled');
      const cu = b.customer || {}; const d = b.delivery || {}; const a = d.deliveryAddress || {}; const co = a.coordinates || {};
      if (!cu.name || !cu.phone || !/^\d{2}$/.test(cu.phone.areaCode || '') || !/^\d{7,9}$/.test(cu.phone.number || '')) return erroShip(res, 'BadRequestCustomer');
      if (!/^\d{8}$/.test(a.postalCode || '') || !a.streetName || !a.streetNumber || !a.neighborhood || !a.city || !/^[A-Z]{2}$/.test(a.state || '') || a.country !== 'BR') return erroShip(res, 'BadRequest', 'endereço incompleto');
      if (!Number.isFinite(co.latitude) || !Number.isFinite(co.longitude)) return erroShip(res, 'BadRequest', 'sem coordenadas');
      if (typeof d.merchantFee !== 'number') return erroShip(res, 'BadRequest', 'merchantFee');
      if (!cotacoesSim.has(d.quoteId)) return erroShip(res, 'BadRequest', 'quoteId inválido');
      const its = Array.isArray(b.items) ? b.items : [];
      if (!its.length || its.some((i) => !i.id || !i.name || !(Number.isInteger(i.quantity) && i.quantity > 0) || Math.abs(i.price - i.quantity * i.unitPrice) > 0.05 || Math.abs(i.totalPrice - i.price - i.optionsPrice) > 0.001)) return erroShip(res, 'BadRequest', 'itens inválidos');
      const totalItens = its.reduce((s, i) => s + i.totalPrice, 0) + d.merchantFee;
      if (b.payments) {
        const ps = b.payments.methods || [];
        if (ps.some((p) => !['CREDIT', 'DEBIT', 'CASH'].includes(p.method) || p.type !== 'OFFLINE' || ((p.method === 'CREDIT' || p.method === 'DEBIT') && !(p.card && p.card.brand)) || (p.method === 'CASH' && !(p.cash && p.cash.changeFor >= p.value)))) return erroShip(res, 'PaymentMethodNotFound');
        if (Math.abs(ps.reduce((s, p) => s + p.value, 0) - totalItens) > 0.01) return erroShip(res, 'PaymentTotalInvalid');
      }
      const novo = crypto.randomUUID();
      entregasSim.set(novo, { merchantId: ms[1], corpo: b, status: 'solicitada', rastreio: null });
      eventoEntrega('REQUEST_DRIVER', novo, {});
      acoes.push({ acao: 'entrega_criar', entrega: novo, corpo: b, em: new Date().toISOString() });
      return responder(res, 202, { id: novo, trackingUrl: `https://meupedido.ifood.com.br/${novo}` });
    }
    ms = c.match(/^\/shipping\/v1\.0\/orders\/([^/]+)\/(tracking|cancellationReasons|cancel)$/);
    if (ms) {
      const e = entregasSim.get(ms[1]);
      if (!e) return responder(res, 404, { error: { code: 'OrderNotFound' } });
      if (ms[2] === 'tracking') {
        if (!e.rastreio) return responder(res, 404, { error: { code: 'NotFound' } });
        return responder(res, 200, { latitude: e.rastreio.lat, longitude: e.rastreio.lng, expectedDelivery: new Date(Date.now() + 900e3).toISOString(), pickupEtaStart: 120, deliveryEtaEnd: 900, trackDate: new Date().toISOString() });
      }
      const podeCancelar = ['solicitada', 'alocado', 'indo_loja', 'na_loja'].includes(e.status);
      if (ms[2] === 'cancellationReasons') return podeCancelar ? responder(res, 200, [{ cancelCodeId: '817', description: 'O cliente cancelou o pedido' }, { cancelCodeId: '818', description: 'Impossível preparar o pedido' }]) : responder(res, 204);
      if (req.method !== 'POST' || !b.reason || !Number.isInteger(b.cancellationCode)) return erroShip(res, 'BadRequest');
      if (!podeCancelar) return erroShip(res, 'BadRequest', 'não pode mais cancelar');
      e.status = 'cancelada';
      acoes.push({ acao: 'entrega_cancelar', entrega: ms[1], corpo: b, em: new Date().toISOString() });
      eventoEntrega('CANCELLATION_REQUESTED', ms[1], {});
      eventoEntrega('CANCELLED', ms[1], {});
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
    // ---------- cardapio: catalogos, categorias, itens e precos (Catalog API v2) ----------
    m = c.match(/^\/catalog\/v2\.0\/merchants\/([^/]+)\/(catalogs|categories|items|products\/price)$/);
    if (m) {
      if (!LOJAS.some((l) => l.id === m[1])) return responder(res, 403, { error: { message: 'loja não autorizada' } });
      const mer = m[1];
      if (!categoriasSim.has(mer)) categoriasSim.set(mer, []);
      if (!itensSim.has(mer)) itensSim.set(mer, new Map());
      if (m[2] === 'catalogs' && req.method === 'GET') return responder(res, 200, [{ catalogId: `cat-${mer}`, context: ['DEFAULT'], status: 'AVAILABLE' }]);
      if (m[2] === 'categories' && req.method === 'GET') {
        const comItens = url.searchParams.get('include_items') === 'true';
        return responder(res, 200, categoriasSim.get(mer).map((cat) => (comItens ? { ...cat, items: [...itensSim.get(mer)].filter(([, i]) => i.categoryId === cat.id).map(([codigo, i]) => ({ id: i.itemId, externalCode: codigo, productId: i.productId, status: i.status, price: { value: i.preco } })) } : cat)));
      }
      if (m[2] === 'categories' && req.method === 'POST') {
        if (!b.name || b.template !== 'DEFAULT') return responder(res, 400, { error: { message: 'name e template obrigatórios' } });
        const cat = { id: id(), name: b.name, status: b.status || 'AVAILABLE', template: b.template };
        categoriasSim.get(mer).push(cat);
        return responder(res, 201, cat);
      }
      if (m[2] === 'items' && req.method === 'PUT') {
        const it = b.item || {};
        const prod = (b.products || [])[0] || {};
        if (!UUID4.test(it.id || '') || !UUID4.test(prod.id || '')) return responder(res, 404, { error: { message: 'id inválido (precisa ser UUID v4)' } });
        if (!Array.isArray(b.optionGroups) || !Array.isArray(b.options)) return responder(res, 400, { error: { message: 'optionGroups e options obrigatórios' } });
        if (it.type !== 'DEFAULT' || !['AVAILABLE', 'UNAVAILABLE'].includes(it.status) || !(Number(it.price && it.price.value) > 0) || !it.externalCode || !prod.name) {
          return responder(res, 400, { error: { message: 'item incompleto' } });
        }
        if (!categoriasSim.get(mer).some((x) => x.id === it.categoryId)) return responder(res, 400, { error: { message: 'categoria inexistente' } });
        const dono = itensSim.get(mer).get(it.externalCode);
        if (dono && dono.itemId !== it.id) return responder(res, 409, { error: { message: 'externalCode já usado por outro item' } });
        itensSim.get(mer).set(it.externalCode, { itemId: it.id, productId: prod.id, nome: prod.name, preco: Number(it.price.value), status: it.status, categoryId: it.categoryId, imagem: !!prod.image });
        acoes.push({ acao: 'cardapio_item', codigo: it.externalCode, em: new Date().toISOString() });
        return responder(res, 200, { ok: true });
      }
      if (m[2] === 'products/price' && req.method === 'PATCH') {
        if (!Array.isArray(b) || b.some((x) => !x.externalCode || !(Number(x.price && x.price.value) > 0))) return responder(res, 400, { error: { message: 'corpo inválido' } });
        for (const x of b) { const i = itensSim.get(mer).get(x.externalCode); if (i) i.preco = Number(x.price.value); }
        acoes.push({ acao: 'precos', corpo: b, em: new Date().toISOString() });
        return responder(res, 202, { batchId: id() });
      }
    }
    // ---------- cardapio: status por codigo PDV ----------
    m = c.match(/^\/catalog\/v2\.0\/merchants\/([^/]+)\/products\/status$/);
    if (m && req.method === 'PATCH') {
      if (!LOJAS.some((l) => l.id === m[1])) return responder(res, 403, { error: { message: 'loja não autorizada' } });
      if (!Array.isArray(b) || b.some((x) => !x.externalCode || !['AVAILABLE', 'UNAVAILABLE'].includes(x.status))) return responder(res, 400, { error: { message: 'corpo inválido' } });
      if (!catalogo.has(m[1])) catalogo.set(m[1], new Map());
      for (const x of b) catalogo.get(m[1]).set(x.externalCode, { status: x.status, em: new Date().toISOString() });
      acoes.push({ acao: 'disponibilidade', corpo: b, em: new Date().toISOString() });
      return responder(res, 202, { batchId: id() });
    }
    return responder(res, 404, { error: { message: `rota não simulada: ${req.method} ${c}` } });
  } catch (err) {
    return responder(res, 500, { error: { message: err.message } });
  }
});

servidor.listen(PORTA, () => console.log(`Simulador do iFood em ${BASE} (lojas: ${LOJAS.map((l) => l.id).join(', ')})`));
