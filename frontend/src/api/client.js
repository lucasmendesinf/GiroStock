const BASE_URL = '/api';

function getToken() {
  return localStorage.getItem('girostock_token');
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
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
    if (res.status === 401 && token && !path.startsWith('/auth/login')) {
      clearSession();
      window.location.assign('/login');
    }
    const erro = new Error((data && data.erro) || `Erro ${res.status}`);
    erro.status = res.status;
    throw erro;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
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
