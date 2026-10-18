// Simulador local da API de pagamentos do Mercado Pago (so desenvolvimento/testes). Imita o necessario da loja virtual:
// conferir a conta (/users/me), criar pagamento Pix (QR code pendente) e cartao (resultado pelo token do cartao),
// consultar, cancelar Pix pendente, estornar e mandar o aviso (webhook) assinado como o Mercado Pago
// (x-signature "ts=...,v1=HMAC-SHA256(segredo, 'id:<id>;request-id:<x-request-id>;ts:<ts>;')").
//
// Uso:
//   npm run mp:simulador                         # porta 4997 (SIM_PORT muda)
//   no backend/.env:  MP_API_URL=http://localhost:4997
//   Credenciais aceitas: qualquer access token "TEST-..."/"APP_USR-..." (com "invalido" no texto = recusado).
//   Segredo das assinaturas: SIM_WEBHOOK_SECRET (padrao "sim-segredo-webhook").
//
// Token do cartao (o site manda o que o Mercado Pago JS gerou; aqui o texto decide o resultado):
//   "cartao-aprovado" -> approved | "cartao-recusado" -> rejected (saldo insuficiente) | "cartao-analise" -> in_process
//
// Controle do simulador:
//   POST /_sim/pagamentos/{id}/aprovar | /recusar   (?sem_aviso=1 muda sem mandar o aviso)
//   POST /_sim/pagamentos/{id}/reenviar              -> manda o aviso de novo
//   GET  /_sim/pagamentos | /_sim/avisos
import http from 'node:http';
import crypto from 'node:crypto';

const PORTA = Number(process.env.SIM_PORT || 4997);
const SEGREDO = process.env.SIM_WEBHOOK_SECRET || 'sim-segredo-webhook';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const pagamentos = new Map(); // id -> pagamento
const porIdempotencia = new Map(); // token+chave -> id
const avisos = [];
let seq = 1000000;

const tokenValido = (req) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return /^(TEST|APP_USR)-/.test(t) && !t.includes('invalido') ? t : null;
};

function responder(res, status, corpo) {
  const txt = corpo === undefined ? '' : JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(txt);
}

function ler(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const t = Buffer.concat(partes).toString('utf8');
      try { resolve(t ? JSON.parse(t) : {}); } catch { resolve(null); }
    });
  });
}

function enviarAviso(p) {
  if (!p.notification_url) return;
  const corpo = JSON.stringify({ action: 'payment.updated', api_version: 'v1', type: 'payment', data: { id: String(p.id) }, date_created: new Date().toISOString(), live_mode: false });
  const ts = String(Math.floor(Date.now() / 1000));
  const reqId = crypto.randomUUID();
  const v1 = crypto.createHmac('sha256', SEGREDO).update(`id:${p.id};request-id:${reqId};ts:${ts};`).digest('hex');
  const url = new URL(p.notification_url);
  const r = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo), 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': reqId } }, (res) => {
    let t = '';
    res.on('data', (c) => { t += c; });
    res.on('end', () => avisos.push({ id: p.id, status: p.status, resposta: res.statusCode, corpo: t.slice(0, 200), em: new Date().toISOString() }));
  });
  r.on('error', (err) => avisos.push({ id: p.id, status: p.status, erro: err.message, em: new Date().toISOString() }));
  r.end(corpo);
}

function mudar(p, status, detalhe, aviso = true) {
  p.status = status;
  p.status_detail = detalhe;
  if (status === 'approved' && !p.date_approved) p.date_approved = new Date().toISOString();
  p.date_last_updated = new Date().toISOString();
  if (aviso) setTimeout(() => enviarAviso(p), 50);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const caminho = url.pathname;
  const corpo = ['POST', 'PUT'].includes(req.method) ? await ler(req) : {};
  if (corpo === null) return responder(res, 400, { message: 'JSON inválido' });

  // ----- controle -----
  if (caminho === '/_sim/pagamentos' && req.method === 'GET') return responder(res, 200, [...pagamentos.values()]);
  if (caminho === '/_sim/avisos' && req.method === 'GET') return responder(res, 200, avisos);
  let m = /^\/_sim\/pagamentos\/(\d+)\/(aprovar|recusar|reenviar)$/.exec(caminho);
  if (m && req.method === 'POST') {
    const p = pagamentos.get(m[1]);
    if (!p) return responder(res, 404, { message: 'pagamento não encontrado' });
    const aviso = url.searchParams.get('sem_aviso') !== '1';
    if (m[2] === 'aprovar') mudar(p, 'approved', 'accredited', aviso);
    else if (m[2] === 'recusar') mudar(p, 'rejected', 'cc_rejected_other_reason', aviso);
    else enviarAviso(p);
    return responder(res, 200, p);
  }

  // ----- API -----
  const token = tokenValido(req);
  if (!token) return responder(res, 401, { message: 'invalid access token', error: 'unauthorized', status: 401 });

  if (caminho === '/users/me' && req.method === 'GET') return responder(res, 200, { id: 123456789, nickname: 'LOJA_SIMULADA', email: 'loja@simulador.mp', site_id: 'MLB' });

  if (caminho === '/v1/payments' && req.method === 'POST') {
    const chave = `${token}:${req.headers['x-idempotency-key'] || crypto.randomUUID()}`;
    if (porIdempotencia.has(chave)) return responder(res, 200, pagamentos.get(porIdempotencia.get(chave)));
    if (!(Number(corpo.transaction_amount) > 0)) return responder(res, 400, { message: 'transaction_amount inválido', cause: [{ code: 4037, description: 'Invalid transaction_amount' }] });
    if (!corpo.payer || !corpo.payer.email) return responder(res, 400, { message: 'payer.email é obrigatório', cause: [{ code: 4050, description: 'payer.email must be a valid email' }] });
    const id = String(++seq);
    const base = {
      id: Number(id), date_created: new Date().toISOString(), date_last_updated: new Date().toISOString(), date_approved: null,
      transaction_amount: Number(corpo.transaction_amount), description: corpo.description, external_reference: corpo.external_reference,
      notification_url: corpo.notification_url, payment_method_id: corpo.payment_method_id, installments: corpo.installments || 1, metadata: corpo.metadata || {},
      payer: { email: corpo.payer.email }, live_mode: false,
    };
    let p;
    if (corpo.payment_method_id === 'pix') {
      p = {
        ...base, payment_type_id: 'bank_transfer', status: 'pending', status_detail: 'pending_waiting_transfer',
        date_of_expiration: corpo.date_of_expiration || new Date(Date.now() + 30 * 60000).toISOString(),
        point_of_interaction: { type: 'PIX', transaction_data: { qr_code: `00020126580014br.gov.bcb.pix0136sim-${id}5204000053039865406${Number(corpo.transaction_amount).toFixed(2)}5802BR6304SIM`, qr_code_base64: PNG, ticket_url: `http://localhost:${PORTA}/pix/${id}` } },
      };
    } else {
      if (!corpo.token) return responder(res, 400, { message: 'token do cartão é obrigatório', cause: [{ code: 2006, description: 'Card Token not found' }] });
      const resultado = String(corpo.token).includes('recusado') ? ['rejected', 'cc_rejected_insufficient_amount'] : String(corpo.token).includes('analise') ? ['in_process', 'pending_contingency'] : ['approved', 'accredited'];
      p = { ...base, payment_type_id: 'credit_card', status: resultado[0], status_detail: resultado[1], date_approved: resultado[0] === 'approved' ? new Date().toISOString() : null, card: { last_four_digits: '4242', first_six_digits: '503143' } };
    }
    pagamentos.set(id, p);
    porIdempotencia.set(chave, id);
    return responder(res, 201, p);
  }

  m = /^\/v1\/payments\/(\d+)$/.exec(caminho);
  if (m) {
    const p = pagamentos.get(m[1]);
    if (!p) return responder(res, 404, { message: 'Payment not found', status: 404 });
    if (req.method === 'GET') return responder(res, 200, p);
    if (req.method === 'PUT') {
      if (corpo.status === 'cancelled') {
        if (!['pending', 'in_process'].includes(p.status)) return responder(res, 400, { message: 'só pagamento pendente pode ser cancelado' });
        mudar(p, 'cancelled', 'by_collector', false);
      }
      return responder(res, 200, p);
    }
  }
  m = /^\/v1\/payments\/(\d+)\/refunds$/.exec(caminho);
  if (m && req.method === 'POST') {
    const p = pagamentos.get(m[1]);
    if (!p) return responder(res, 404, { message: 'Payment not found', status: 404 });
    if (p.status !== 'approved') return responder(res, 400, { message: 'Payment not refundable', cause: [{ code: 2063, description: 'the action requested is not valid for the current payment state' }] });
    mudar(p, 'refunded', 'refunded', false);
    return responder(res, 201, { id: Number(++seq), payment_id: p.id, amount: p.transaction_amount, status: 'approved' });
  }
  return responder(res, 404, { message: `rota não simulada: ${req.method} ${caminho}` });
});

servidor.listen(PORTA, () => console.log(`Simulador do Mercado Pago na porta ${PORTA} (segredo dos avisos: ${SEGREDO})`));
