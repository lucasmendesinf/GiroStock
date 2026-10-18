// Comunicacao com a API publica da loja (/api/loja/v1). A loja e reconhecida pelo endereco do site (subdominio ou
// dominio proprio). Pelo link no endereco do sistema (/loja/<subdominio>/) ou na pre-visualizacao
// (/loja-previa/<subdominio>/), o subdominio vai no cabecalho X-Loja-Subdominio.
const caminho = /^\/(loja|loja-previa)\/([a-z0-9-]+)/.exec(window.location.pathname);
export const SUBDOMINIO = caminho ? caminho[2] : null;
export const EH_PREVIA = !!caminho && caminho[1] === 'loja-previa';
export const BASE_ROTAS = caminho ? `/${caminho[1]}/${caminho[2]}` : '';

let token = null;
let aoExpirar = () => {};
export function definirSessao(t, callbackExpirou) {
  token = t;
  if (callbackExpirou) aoExpirar = callbackExpirou;
}

export class ErroApi extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

async function chamar(metodo, caminho, corpo) {
  const headers = { 'Content-Type': 'application/json' };
  if (SUBDOMINIO) headers['X-Loja-Subdominio'] = SUBDOMINIO;
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`/api/loja/v1${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  } catch {
    throw new ErroApi(0, 'Sem conexão com a internet. Tente de novo.');
  }
  if (res.status === 204) return null;
  const dados = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !caminho.startsWith('/conta/login')) aoExpirar();
    throw new ErroApi(res.status, (dados && dados.erro) || `Erro ${res.status}`);
  }
  return dados;
}

export const api = {
  get: (c) => chamar('GET', c),
  post: (c, b) => chamar('POST', c, b || {}),
  put: (c, b) => chamar('PUT', c, b || {}),
  del: (c, b) => chamar('DELETE', c, b),
};
