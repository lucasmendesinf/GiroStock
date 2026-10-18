// Simulador local da API do Melhor Envio (so desenvolvimento/testes). Imita o necessario da loja online: conta e saldo,
// servicos, cotacao por produtos, carrinho, compra com o saldo, geracao, impressao, rastreio e cancelamento de etiqueta.
//
// Uso:
//   npm run me:simulador                       # porta 4996 (SIM_PORT muda)
//   no backend/.env:  ME_API_URL=http://localhost:4996
//   Token aceito: qualquer texto com 20+ caracteres ("invalido" no texto = 401; "semsaldo" = conta sem saldo).
//
// Servicos: 1 Correios PAC, 2 Correios SEDEX, 3 Jadlog .Package, 17 Correios Mini Envios (ate 300 g).
// Jadlog nao atende CEP comecando com 69 (Amazonas), para testar servico indisponivel.
//
// Controle do simulador:
//   POST /_sim/envios/{id}/postar   -> status posted (e codigo de rastreio, se ainda nao tinha)
//   POST /_sim/envios/{id}/entregar -> status delivered
//   GET  /_sim/envios | /_sim/cotacoes
import http from 'node:http';

const PORTA = Number(process.env.SIM_PORT || 4996);
const SERVICOS = [
  { id: 1, name: 'PAC', company: { id: 1, name: 'Correios', picture: 'https://www.melhorenvio.com.br/images/shipping-companies/correios.png' }, base: 15, kg: 6, dias: 6 },
  { id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios', picture: 'https://www.melhorenvio.com.br/images/shipping-companies/correios.png' }, base: 22, kg: 10, dias: 2 },
  { id: 3, name: '.Package', company: { id: 2, name: 'Jadlog', picture: 'https://www.melhorenvio.com.br/images/shipping-companies/jadlog.png' }, base: 14, kg: 7, dias: 5 },
  { id: 17, name: 'Mini Envios', company: { id: 1, name: 'Correios', picture: 'https://www.melhorenvio.com.br/images/shipping-companies/correios.png' }, base: 9, kg: 4, dias: 8 },
];
const envios = new Map(); // id -> envio
const cotacoes = [];
const saldos = new Map(); // token -> saldo
let seq = 1;

const tokenDe = (req) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return t.length >= 20 && !t.includes('invalido') ? t : null;
};
const saldoDe = (t) => { if (!saldos.has(t)) saldos.set(t, t.includes('semsaldo') ? 0 : 500); return saldos.get(t); };

function responder(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(corpo === undefined ? '' : JSON.stringify(corpo));
}
function ler(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => { const t = Buffer.concat(partes).toString('utf8'); try { resolve(t ? JSON.parse(t) : {}); } catch { resolve(null); } });
  });
}
const r2 = (v) => Math.round(v * 100) / 100;
const cep = (v) => String(v || '').replace(/\D/g, '');

function cotar(b) {
  const de = cep(b.from && b.from.postal_code);
  const para = cep(b.to && b.to.postal_code);
  const produtos = Array.isArray(b.products) ? b.products : [];
  if (de.length !== 8 || para.length !== 8) return { erro: 'CEP inválido' };
  if (!produtos.length) return { erro: 'informe os produtos' };
  const peso = produtos.reduce((s, p) => s + Number(p.weight) * Number(p.quantity || 1), 0);
  const altura = produtos.reduce((s, p) => s + Number(p.height) * Number(p.quantity || 1), 0);
  const largura = Math.max(...produtos.map((p) => Number(p.width)));
  const comprimento = Math.max(...produtos.map((p) => Number(p.length)));
  const valor = produtos.reduce((s, p) => s + Number(p.insurance_value || 0) * Number(p.quantity || 1), 0);
  const dist = Math.abs(Number(de.slice(0, 2)) - Number(para.slice(0, 2)));
  const pedidos = b.services ? String(b.services).split(',').map(Number) : SERVICOS.map((s) => s.id);
  return SERVICOS.filter((s) => pedidos.includes(s.id)).map((s) => {
    const base = { id: s.id, name: s.name, company: s.company, currency: 'R$' };
    if (s.id === 3 && para.startsWith('69')) return { ...base, error: 'Transportadora não atende este trecho.' };
    if (s.id === 17 && peso > 0.3) return { ...base, error: 'Peso acima do permitido para o serviço.' };
    const preco = r2(s.base + s.kg * peso + dist * 0.25 + valor * 0.005);
    const dias = s.dias + Math.round(dist / 10);
    return {
      ...base, price: preco.toFixed(2), custom_price: preco.toFixed(2), discount: '0.00',
      delivery_time: dias, custom_delivery_time: dias, delivery_range: { min: dias - 1, max: dias + 1 },
      packages: [{ price: preco.toFixed(2), format: 'box', weight: r2(peso).toFixed(2), insurance_value: r2(valor).toFixed(2), dimensions: { height: Math.ceil(altura), width: Math.ceil(largura), length: Math.ceil(comprimento) } }],
    };
  });
}

const rastreio = (e) => ({
  id: e.id, protocol: e.protocol, status: e.status, tracking: e.tracking, melhorenvio_tracking: e.me_tracking,
  created_at: e.criado, paid_at: e.pago, generated_at: e.gerado, posted_at: e.postado, delivered_at: e.entregue, canceled_at: e.cancelado, expired_at: null,
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const p = url.pathname;
  // controle
  if (p === '/_sim/envios') return responder(res, 200, [...envios.values()]);
  if (p === '/_sim/cotacoes') return responder(res, 200, cotacoes);
  let m = /^\/_sim\/envios\/([^/]+)\/(postar|entregar)$/.exec(p);
  if (m && req.method === 'POST') {
    const e = envios.get(m[1]);
    if (!e) return responder(res, 404, { error: 'não encontrado' });
    if (m[2] === 'postar') { e.status = 'posted'; e.postado = new Date().toISOString(); if (!e.tracking) e.tracking = `JD${String(seq++).padStart(12, '0')}`; }
    else { e.status = 'delivered'; e.entregue = new Date().toISOString(); }
    return responder(res, 200, e);
  }
  if (!p.startsWith('/api/v2/')) return responder(res, 404, { message: 'rota desconhecida' });
  const token = tokenDe(req);
  if (!token) return responder(res, 401, { message: 'Unauthenticated.' });
  if (!req.headers['user-agent'] || !/@/.test(req.headers['user-agent'])) return responder(res, 400, { message: 'User-Agent com e-mail de contato é obrigatório' });
  const rota = p.slice('/api/v2'.length);
  const b = ['POST', 'PUT'].includes(req.method) ? await ler(req) : {};
  if (b === null) return responder(res, 400, { message: 'JSON inválido' });

  if (req.method === 'GET' && rota === '/me') return responder(res, 200, { id: 'sim-1', firstname: 'Loja', lastname: 'Simulada', email: 'loja@simulada.com' });
  if (req.method === 'GET' && rota === '/me/balance') return responder(res, 200, { balance: saldoDe(token), reserved: 0, debts: 0 });
  if (req.method === 'GET' && rota === '/me/shipment/services') return responder(res, 200, SERVICOS.map(({ id, name, company }) => ({ id, name, company, type: 'normal' })));
  if (req.method === 'POST' && rota === '/me/shipment/calculate') {
    const r = cotar(b);
    if (r.erro) return responder(res, 422, { message: 'The given data was invalid.', errors: { 'to.postal_code': [r.erro] } });
    cotacoes.push({ em: new Date().toISOString(), de: b.from.postal_code, para: b.to.postal_code, servicos: b.services || null });
    return responder(res, 200, r);
  }
  if (req.method === 'POST' && rota === '/me/cart') {
    const s = SERVICOS.find((x) => x.id === Number(b.service));
    const faltando = ['name', 'address', 'district', 'city', 'postal_code'].filter((k) => !(b.from && b.from[k]) || !(b.to && b.to[k]));
    if (!s || faltando.length || !Array.isArray(b.volumes) || !b.volumes.length) {
      return responder(res, 422, { message: 'The given data was invalid.', errors: { dados: [`dados incompletos para a etiqueta${faltando.length ? `: ${faltando.join(', ')}` : ''}`] } });
    }
    if (!(b.from.document || b.from.company_document)) return responder(res, 422, { message: 'The given data was invalid.', errors: { 'from.document': ['CPF ou CNPJ do remetente é obrigatório'] } });
    const peso = b.volumes.reduce((x, v) => x + Number(v.weight), 0);
    const id = `9a${String(seq++).padStart(6, '0')}-sim`;
    const preco = r2(s.base + s.kg * peso);
    envios.set(id, { id, protocol: `ORD-${id}`, service_id: s.id, price: preco, status: 'pending', tracking: null, me_tracking: null, from: b.from, to: b.to, products: b.products, volumes: b.volumes, options: b.options, token, criado: new Date().toISOString() });
    return responder(res, 201, { id, protocol: `ORD-${id}`, service_id: s.id, price: preco, status: 'pending' });
  }
  m = /^\/me\/cart\/([^/]+)$/.exec(rota);
  if (m && req.method === 'DELETE') { envios.delete(m[1]); return responder(res, 204); }
  const daConta = (ids) => (Array.isArray(ids) ? ids : []).map((id) => envios.get(id)).filter((e) => e && e.token === token);
  if (req.method === 'POST' && rota === '/me/shipment/checkout') {
    const lista = daConta(b.orders);
    if (!lista.length) return responder(res, 422, { message: 'Nenhuma etiqueta encontrada' });
    const total = lista.reduce((x, e) => x + e.price, 0);
    if (saldoDe(token) < total) return responder(res, 422, { message: 'Saldo insuficiente para a compra.', errors: { saldo: ['Saldo insuficiente. Adicione saldo na sua carteira do Melhor Envio.'] } });
    saldos.set(token, r2(saldoDe(token) - total));
    for (const e of lista) { e.status = 'released'; e.pago = new Date().toISOString(); }
    return responder(res, 200, { purchase: { id: `compra-${seq++}`, total, status: 'paid', orders: lista.map((e) => ({ id: e.id, status: e.status })) } });
  }
  if (req.method === 'POST' && rota === '/me/shipment/generate') {
    const out = {};
    for (const e of daConta(b.orders)) {
      if (e.status !== 'released') { out[e.id] = { status: false, message: 'etiqueta não paga' }; continue; }
      e.gerado = new Date().toISOString();
      e.me_tracking = `ME${String(seq++).padStart(9, '0')}`;
      if (e.service_id !== 3) e.tracking = `SM${String(seq++).padStart(9, '0')}BR`; // Correios: codigo na geracao; Jadlog: so na postagem
      out[e.id] = { status: true, message: 'Envio gerado com sucesso' };
    }
    return responder(res, 200, out);
  }
  if (req.method === 'POST' && rota === '/me/shipment/print') {
    const lista = daConta(b.orders);
    if (!lista.length) return responder(res, 422, { message: 'Nenhuma etiqueta encontrada' });
    return responder(res, 200, { url: `http://localhost:${PORTA}/imprimir/${lista.map((e) => e.id).join(',')}` });
  }
  if (req.method === 'POST' && rota === '/me/shipment/tracking') {
    const out = {};
    for (const e of daConta(b.orders)) out[e.id] = rastreio(e);
    return responder(res, 200, out);
  }
  if (req.method === 'POST' && rota === '/me/shipment/cancel') {
    const e = daConta([b.order && b.order.id])[0];
    if (!e) return responder(res, 422, { message: 'Etiqueta não encontrada' });
    if (['posted', 'delivered'].includes(e.status)) return responder(res, 422, { message: 'Etiqueta já postada não pode ser cancelada' });
    if (e.status === 'released') saldos.set(token, r2(saldoDe(token) + e.price));
    e.status = 'canceled';
    e.cancelado = new Date().toISOString();
    return responder(res, 200, { [e.id]: { canceled: true } });
  }
  return responder(res, 404, { message: 'rota desconhecida' });
});

servidor.listen(PORTA, () => console.log(`Simulador do Melhor Envio em http://localhost:${PORTA}`));
