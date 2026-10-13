const BASE_URL = '/api';

function getToken() {
  return localStorage.getItem('girostock_token');
}

// opcoes.token: token explicito (o token_mfa do 2FA, que nunca vai para o localStorage); nesse caso erros 401 nao derrubam a sessao.
async function request(path, { method = 'GET', body, token: tokenExplicito } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = tokenExplicito || getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Sessao expirada/usuario desativado: volta para o login.
    if (res.status === 401 && token && !tokenExplicito && !path.startsWith('/auth/login')) {
      clearSession();
      window.location.assign('/login');
    }
    // Permissao do modo teste retirada (ou modo teste indisponivel): o token de teste nao serve mais; volta ao login (producao).
    // Empresa suspensa pelo Master: a sessao cai na hora; o login mostra o aviso.
    if (data && data.empresaSuspensa && token) {
      try { sessionStorage.setItem('girostock_aviso', data.motivo ? `Empresa suspensa: ${data.motivo}` : 'Empresa suspensa. Fale com o suporte.'); } catch { /* sem armazenamento */ }
      clearSession();
      window.location.assign('/login');
    }
    // Modo manutencao: o servidor responde 503 com a mensagem; a tela de manutencao assume (o Master nunca recebe isso).
    if (res.status === 503 && data && data.manutencao && token && !path.startsWith('/auth/')) {
      try { sessionStorage.setItem('girostock_manutencao', data.erro || ''); } catch { /* sem armazenamento */ }
      window.location.assign('/manutencao');
    }
    if (data && data.modoTesteRevogado && token) {
      clearSession();
      window.location.assign('/login');
    }
    const erro = new Error((data && data.erro) || `Erro ${res.status}`);
    erro.status = res.status;
    erro.dados = data;
    throw erro;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body, opcoes) => request(path, { method: 'POST', body, ...opcoes }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

export function saveSession(token, usuario) {
  localStorage.setItem('girostock_token', token);
  localStorage.setItem('girostock_user', JSON.stringify(usuario));
}

export function updateStoredUser(usuario) {
  localStorage.setItem('girostock_user', JSON.stringify(usuario));
}

export function clearSession() {
  localStorage.removeItem('girostock_token');
  localStorage.removeItem('girostock_user');
}

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem('girostock_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
