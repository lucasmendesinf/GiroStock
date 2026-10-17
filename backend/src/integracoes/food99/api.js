// Cliente da OpenAPI da 99Food. Todos os caminhos ficam aqui: se a homologacao apontar diferenca, o ajuste e neste arquivo.
//
// Credenciais do app (da Calutec, uma para todas as empresas): FOOD99_APP_ID / FOOD99_APP_SECRET.
// FOOD99_API_URL troca o endereco base (ex.: o simulador local, scripts/food99-simulador.mjs).
// Vinculo da loja: o GiroStock da a cada loja um "app_shop_id" (nosso codigo da loja); a loja autoriza o app da
// Calutec no portal da 99Food informando esse codigo. Depois disso o token da loja sai direto pelo app_id/app_secret.
// Respostas: { errno, errmsg, data } (errno 0 = ok). Ids de pedido sao inteiros de 64 bits: lidos como texto.
const { requisicao, ErroPlataforma } = require('../http');

const base = () => (process.env.FOOD99_API_URL || 'https://openapi.99food.com/v1').replace(/\/+$/, '');
const credenciais = () => ({ appId: process.env.FOOD99_APP_ID || '', appSecret: process.env.FOOD99_APP_SECRET || '' });
const configurado = () => !!(process.env.FOOD99_APP_ID && process.env.FOOD99_APP_SECRET);

const CAMINHOS = {
  token: '/auth/authtoken/get',
  renovar: '/auth/authtoken/refresh',
  detalhe: '/order/order/detail',
  pronto: '/order/order/ready',
  despachar: '/order/selfdelivery/dispatch',
  // A CONFIRMAR NA HOMOLOGACAO (nao achados em fonte publica): aceitar e cancelar pela loja.
  // No modo "B-App & OpenAPI" a loja tambem pode aceitar/cancelar no app da 99Food; o GiroStock recebe o evento.
  confirmar: '/order/order/confirm',
  cancelar: '/order/order/cancel',
};

// A CONFIRMAR NA HOMOLOGACAO: codigos de motivo de cancelamento aceitos pela 99Food.
const MOTIVOS_CANCELAMENTO = [
  { codigo: '1', descricao: 'Item indisponível' },
  { codigo: '2', descricao: 'Loja fechada / sem atendimento' },
  { codigo: '3', descricao: 'Endereço fora da área de entrega' },
  { codigo: '4', descricao: 'Pedido duplicado ou suspeito' },
  { codigo: '5', descricao: 'Outro motivo' },
];

const ERRO_TOKEN_EXPIRADO = 10102;

// JSON com ids de 64 bits: numeros com 16+ digitos viram texto antes do parse (senao perdem precisao).
function jsonSeguro(texto) {
  return JSON.parse(String(texto).replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}
// Corpo de saida: order_id vai como numero (sem aspas), do jeito que a 99Food espera.
function corpoComIds(obj) {
  return JSON.stringify(obj).replace(/"order_id":"(-?\d+)"/g, '"order_id":$1');
}

function mensagemDe(corpo) {
  if (!corpo) return '';
  if (typeof corpo === 'string') return corpo.slice(0, 200);
  return String(corpo.errmsg || corpo.message || JSON.stringify(corpo)).slice(0, 200);
}

async function chamar(metodo, caminho, opcoes = {}) {
  const r = await requisicao(metodo, base() + caminho, { ...opcoes, interpretar: jsonSeguro });
  const corpo = r.corpo && typeof r.corpo === 'object' ? r.corpo : null;
  if (r.status >= 400 || !corpo || Number(corpo.errno) !== 0) {
    const erro = new ErroPlataforma(r.status >= 400 ? r.status : 422, `99Food respondeu ${corpo ? `erro ${corpo.errno}` : r.status}${mensagemDe(r.corpo) ? `: ${mensagemDe(r.corpo)}` : ''}`, r.corpo);
    erro.errno = corpo ? Number(corpo.errno) : null;
    throw erro;
  }
  return corpo.data;
}

// ---------- token da loja ----------
// { token, expira_em (Date) }. Vencido: renova e busca de novo.
async function tokenDaLoja(appShopId) {
  const { appId, appSecret } = credenciais();
  const query = `?${new URLSearchParams({ app_id: appId, app_secret: appSecret, app_shop_id: appShopId })}`;
  let d;
  try {
    d = await chamar('GET', CAMINHOS.token + query);
  } catch (err) {
    if (err.errno !== ERRO_TOKEN_EXPIRADO) throw err;
    await chamar('GET', CAMINHOS.renovar + query);
    d = await chamar('GET', CAMINHOS.token + query);
  }
  if (!d || !d.auth_token) throw new ErroPlataforma(422, '99Food não devolveu o token da loja', d);
  const exp = Number(d.token_expiration_time);
  return { token: String(d.auth_token), expira_em: new Date(exp > 0 ? exp * 1000 : Date.now() + 3600e3) };
}

// ---------- pedido ----------
const acao = (caminho) => (token, orderId, extra) => chamar('POST', caminho, { jsonTexto: corpoComIds({ auth_token: token, order_id: String(orderId), ...(extra || {}) }) });
const detalhe = acao(CAMINHOS.detalhe);
const confirmar = acao(CAMINHOS.confirmar);
const pronto = acao(CAMINHOS.pronto);

// Entrega feita pela loja: avisa que saiu, com o entregador e os horarios previstos (unix, segundos).
function despachar(token, orderId, entregador) {
  const nome = String(entregador.nome || 'Entregador').trim();
  const [primeiro, ...resto] = nome.split(/\s+/);
  const agora = Math.floor(Date.now() / 1000);
  return acao(CAMINHOS.despachar)(token, orderId, {
    courier_info: {
      courier_name: nome, courier_first_name: primeiro, courier_last_name: resto.join(' ') || primeiro,
      courier_phone_code: '+55', courier_phone: String(entregador.telefone || '').replace(/\D/g, ''),
    },
    limit_time: { pickup_time: agora, delivery_time: agora + 40 * 60 },
  });
}

function cancelar(token, orderId, codigo, motivo) {
  return acao(CAMINHOS.cancelar)(token, orderId, { reason_id: Number(codigo) || codigo, reason: motivo });
}

module.exports = { configurado, credenciais, tokenDaLoja, detalhe, confirmar, pronto, despachar, cancelar, jsonSeguro, corpoComIds, CAMINHOS, MOTIVOS_CANCELAMENTO };
