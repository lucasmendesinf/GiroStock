// Cliente da API do iFood (Merchant API). Todos os caminhos ficam aqui: se a homologacao apontar diferenca,
// o ajuste e neste arquivo.
//
// Credenciais do app (da Calutec, uma para todas as empresas): IFOOD_CLIENT_ID / IFOOD_CLIENT_SECRET.
// IFOOD_API_URL troca o endereco base (ex.: o simulador local, scripts/ifood-simulador.mjs).
// Fluxo do app distribuido: userCode -> a loja autoriza no Portal do Parceiro -> authorizationCode -> tokens.
const { requisicao, ErroPlataforma } = require('../http');

const base = () => (process.env.IFOOD_API_URL || 'https://merchant-api.ifood.com.br').replace(/\/+$/, '');
const credenciais = () => ({ clientId: process.env.IFOOD_CLIENT_ID || '', clientSecret: process.env.IFOOD_CLIENT_SECRET || '' });
const configurado = () => !!(process.env.IFOOD_CLIENT_ID && process.env.IFOOD_CLIENT_SECRET);

const CAMINHOS = {
  userCode: '/authentication/v1.0/oauth/userCode',
  token: '/authentication/v1.0/oauth/token',
  merchants: '/merchant/v1.0/merchants',
  polling: '/events/v1.0/events:polling',
  ack: '/events/v1.0/events/acknowledgment',
  pedido: (id) => `/order/v1.0/orders/${encodeURIComponent(id)}`,
  acao: (id, acao) => `/order/v1.0/orders/${encodeURIComponent(id)}/${acao}`,
  disputa: (id, acao) => `/order/v1.0/disputes/${encodeURIComponent(id)}/${acao}`,
};

function mensagemDe(corpo) {
  if (!corpo) return '';
  if (typeof corpo === 'string') return corpo.slice(0, 200);
  const e = corpo.error || corpo;
  return String(e.message || e.description || e.code || JSON.stringify(corpo)).slice(0, 200);
}

async function chamar(metodo, caminho, { token, ...opcoes } = {}) {
  const headers = { ...(opcoes.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await requisicao(metodo, base() + caminho, { ...opcoes, headers });
  if (r.status >= 400) throw new ErroPlataforma(r.status, `iFood respondeu ${r.status}${mensagemDe(r.corpo) ? `: ${mensagemDe(r.corpo)}` : ''}`, r.corpo);
  return r;
}

// ---------- autenticacao ----------
async function gerarCodigoVinculo() {
  const { clientId } = credenciais();
  const r = await chamar('POST', CAMINHOS.userCode, { form: { clientId } });
  return r.corpo; // { userCode, authorizationCodeVerifier, verificationUrl, verificationUrlComplete, expiresIn }
}

async function tokenPorCodigo(authorizationCode, authorizationCodeVerifier) {
  const { clientId, clientSecret } = credenciais();
  const r = await chamar('POST', CAMINHOS.token, { form: { grantType: 'authorization_code', clientId, clientSecret, authorizationCode, authorizationCodeVerifier } });
  return r.corpo; // { accessToken, refreshToken, expiresIn, type }
}

async function renovarToken(refreshToken) {
  const { clientId, clientSecret } = credenciais();
  const r = await chamar('POST', CAMINHOS.token, { form: { grantType: 'refresh_token', clientId, clientSecret, refreshToken } });
  return r.corpo;
}

// ---------- lojas da conta ----------
async function lojas(token) {
  const r = await chamar('GET', CAMINHOS.merchants, { token });
  return Array.isArray(r.corpo) ? r.corpo.map((m) => ({ id: m.id, nome: m.name || m.corporateName || m.id })) : [];
}

// ---------- eventos (polling a cada 30 s; ACK so depois de gravar) ----------
async function eventos(token, merchantIds) {
  const r = await chamar('GET', CAMINHOS.polling, { token, headers: { 'x-polling-merchants': merchantIds.join(',') } });
  return r.status === 204 || !Array.isArray(r.corpo) ? [] : r.corpo;
}
async function confirmarRecebimento(token, ids) {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 1000) {
    await chamar('POST', CAMINHOS.ack, { token, json: ids.slice(i, i + 1000).map((id) => ({ id })) });
  }
}

// ---------- pedido ----------
async function pedido(token, id) {
  return (await chamar('GET', CAMINHOS.pedido(id), { token })).corpo;
}
// Acoes respondem 202 (aceito); o resultado chega depois como evento (CFM, RTP, DSP, CAN...).
const acao = (nome) => (token, id, corpo) => chamar('POST', CAMINHOS.acao(id, nome), { token, json: corpo === undefined ? undefined : corpo });
const confirmar = acao('confirm');
const iniciarPreparo = acao('startPreparation');
const prontoParaRetirada = acao('readyToPickup');
const despachar = acao('dispatch');
async function motivosCancelamento(token, id) {
  const r = await chamar('GET', CAMINHOS.acao(id, 'cancellationReasons'), { token });
  return Array.isArray(r.corpo) ? r.corpo.map((m) => ({ codigo: String(m.cancelCodeId || m.code || m.cancellationCode), descricao: m.description || m.reason || '' })) : [];
}
async function solicitarCancelamento(token, id, codigo, motivo) {
  return chamar('POST', CAMINHOS.acao(id, 'requestCancellation'), { token, json: { reason: motivo, cancellationCode: codigo } });
}
// Plataforma de negociacao (o cliente pediu cancelamento depois de confirmado): aceitar ou recusar.
async function responderDisputa(token, disputaId, aceitar, motivo) {
  return chamar('POST', CAMINHOS.disputa(disputaId, aceitar ? 'accept' : 'reject'), { token, json: motivo ? { reason: motivo } : {} });
}

module.exports = {
  configurado, gerarCodigoVinculo, tokenPorCodigo, renovarToken, lojas, eventos, confirmarRecebimento, pedido,
  confirmar, iniciarPreparo, prontoParaRetirada, despachar, motivosCancelamento, solicitarCancelamento, responderDisputa, CAMINHOS,
};
