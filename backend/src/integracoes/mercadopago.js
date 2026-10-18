// Mercado Pago (pagamentos online da loja virtual). Cada empresa usa a PROPRIA conta (access token do lojista): o
// dinheiro cai direto para ela. API de pagamentos: Pix (QR code) e cartao (o site tokeniza o cartao com a public key
// no navegador; aqui so chega o token, nunca o numero do cartao).
// MP_API_URL troca o endereco (simulador local: npm run mp:simulador).
const crypto = require('crypto');
const { requisicao, ErroPlataforma } = require('./http');

const base = () => (process.env.MP_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');

function cabecalhos(token, idempotencia) {
  const h = { authorization: `Bearer ${token}` };
  if (idempotencia) h['x-idempotency-key'] = idempotencia;
  return h;
}

// Mensagem legivel do erro do Mercado Pago (ele responde { message, cause: [{ description }] }).
function erroMp(r, contexto) {
  const c = r.corpo || {};
  const causa = Array.isArray(c.cause) && c.cause[0] ? c.cause[0].description || c.cause[0].code : null;
  const msg = causa || c.message || c.error || `HTTP ${r.status}`;
  return new ErroPlataforma(r.status, `Mercado Pago (${contexto}): ${msg}`, c);
}

async function chamar(metodo, caminho, token, opcoes = {}) {
  const r = await requisicao(metodo, `${base()}${caminho}`, { headers: cabecalhos(token, opcoes.idempotencia), json: opcoes.json, timeoutMs: 20000 });
  if (r.status >= 200 && r.status < 300) return r.corpo;
  throw erroMp(r, opcoes.contexto || caminho);
}

// Confere o access token: devolve a conta (id, apelido, e-mail).
async function conta(token) {
  const c = await chamar('GET', '/users/me', token, { contexto: 'conferir a conta' });
  return { id: c.id, nickname: c.nickname || '', email: c.email || '' };
}

// Data no formato que o Mercado Pago aceita (com fuso): 2026-10-18T15:30:00.000-03:00
function dataMp(d) {
  const sp = new Date(d.getTime() - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
  return sp;
}

function pagador(p) {
  const r = { email: p.email };
  if (p.nome) {
    const partes = String(p.nome).trim().split(/\s+/);
    r.first_name = partes[0];
    if (partes.length > 1) r.last_name = partes.slice(1).join(' ');
  }
  if (p.cpf) r.identification = { type: 'CPF', number: String(p.cpf).replace(/\D/g, '') };
  return r;
}

// Pix: devolve o pagamento com o "copia e cola" e o QR code em base64.
async function criarPix(token, d) {
  return chamar('POST', '/v1/payments', token, {
    contexto: 'gerar o Pix',
    idempotencia: d.idempotencia,
    json: {
      transaction_amount: d.valor,
      description: d.descricao,
      payment_method_id: 'pix',
      payer: pagador(d.pagador),
      external_reference: d.referencia,
      notification_url: d.notificacao || undefined,
      date_of_expiration: dataMp(d.expira_em),
      metadata: d.metadata,
    },
  });
}

// Cartao: o token vem do site (Mercado Pago JS / Card Payment Brick com a public key do lojista).
async function criarCartao(token, d) {
  return chamar('POST', '/v1/payments', token, {
    contexto: 'pagar com cartão',
    idempotencia: d.idempotencia,
    json: {
      transaction_amount: d.valor,
      description: d.descricao,
      token: d.cartao.token,
      payment_method_id: d.cartao.payment_method_id,
      issuer_id: d.cartao.issuer_id || undefined,
      installments: d.cartao.parcelas || 1,
      payer: { ...pagador(d.pagador), ...(d.cartao.identificacao ? { identification: { type: d.cartao.identificacao.tipo || 'CPF', number: String(d.cartao.identificacao.numero || '').replace(/\D/g, '') } } : {}) },
      external_reference: d.referencia,
      notification_url: d.notificacao || undefined,
      statement_descriptor: d.fatura ? String(d.fatura).slice(0, 13) : undefined,
      metadata: d.metadata,
    },
  });
}

const consultar = (token, id) => chamar('GET', `/v1/payments/${encodeURIComponent(id)}`, token, { contexto: 'consultar o pagamento' });

// Estorno total (pagamento aprovado).
const estornar = (token, id, idempotencia) => chamar('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, token, { contexto: 'estornar o pagamento', idempotencia, json: {} });

// Cancela um pagamento ainda pendente (Pix nao pago).
const cancelar = (token, id) => chamar('PUT', `/v1/payments/${encodeURIComponent(id)}`, token, { contexto: 'cancelar o pagamento', json: { status: 'cancelled' } });

// Assinatura do aviso (webhook): x-signature "ts=...,v1=..." = HMAC-SHA256(segredo, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;").
function assinaturaValida(segredo, xSignature, xRequestId, dataId) {
  if (!segredo || !xSignature) return false;
  const partes = Object.fromEntries(String(xSignature).split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2));
  if (!partes.ts || !partes.v1) return false;
  let manifesto = '';
  if (dataId) manifesto += `id:${/^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId};`;
  if (xRequestId) manifesto += `request-id:${xRequestId};`;
  manifesto += `ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', segredo).update(manifesto).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(partes.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { conta, criarPix, criarCartao, consultar, estornar, cancelar, assinaturaValida, ErroPlataforma };
