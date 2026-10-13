import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, saveSession, clearSession, getCurrentUser, updateStoredUser } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getCurrentUser());

  const login = useCallback(async (email, senha) => {
    const data = await api.post('/auth/login', { email, senha });
    // 2FA: ainda nao ha sessao; o token_mfa fica so na memoria do componente de login.
    if (data.mfa) return { mfa: data.mfa, tokenMfa: data.token_mfa };
    saveSession(data.token, data.usuario);
    setUser(data.usuario);
    return data.usuario;
  }, []);

  // Conclui o login com a resposta que traz token + usuario (2FA verificado ou ativado no fluxo "configurar").
  const concluirLogin = useCallback((data) => {
    saveSession(data.token, data.usuario);
    setUser(data.usuario);
    return data.usuario;
  }, []);

  // Liga/desliga o modo teste da sessao: o servidor devolve um novo token; depois recarrega o usuario (/auth/me).
  const alternarModoTeste = useCallback(async (ativo, extra = {}) => {
    const { token } = await api.post('/auth/modo-teste', { ativo, ...extra });
    localStorage.setItem('girostock_token', token);
    const u = await api.get('/auth/me');
    updateStoredUser(u);
    setUser(u);
    return u;
  }, []);

  // ---- Suporte do Master: guarda o token do Master para voltar (a sessao de suporte e curta e nao renova) ----
  const entrarSuporte = useCallback(async ({ empresaId, motivo, codigo, avisar, edicao }) => {
    const r = await api.post(`/master/empresas/${empresaId}/suporte`, { motivo, codigo, avisar, edicao });
    localStorage.setItem('girostock_master_token', localStorage.getItem('girostock_token'));
    localStorage.setItem('girostock_master_user', localStorage.getItem('girostock_user') || '');
    localStorage.setItem('girostock_token', r.token);
    const u = await api.get('/auth/me');
    updateStoredUser(u);
    setUser(u);
    return u;
  }, []);

  // Troca o token de suporte pelo do Master guardado (sem chamar a API: serve tambem quando a sessao ja expirou).
  const voltarAoMasterLocal = useCallback((aviso) => {
    const tokenMaster = localStorage.getItem('girostock_master_token');
    if (!tokenMaster) { clearSession(); window.location.assign('/login'); return; }
    localStorage.setItem('girostock_token', tokenMaster);
    localStorage.setItem('girostock_user', localStorage.getItem('girostock_master_user') || '');
    localStorage.removeItem('girostock_master_token');
    localStorage.removeItem('girostock_master_user');
    if (aviso) { try { sessionStorage.setItem('girostock_aviso', aviso); } catch { /* sem armazenamento */ } }
    window.location.assign('/master/empresas');
  }, []);

  const encerrarSuporte = useCallback(async () => {
    const r = await api.post('/master/suporte/encerrar');
    localStorage.setItem('girostock_token', r.token);
    localStorage.setItem('girostock_user', localStorage.getItem('girostock_master_user') || '');
    localStorage.removeItem('girostock_master_token');
    localStorage.removeItem('girostock_master_user');
  }, []);

  // Recarrega o usuario (ex.: depois da troca obrigatoria de senha).
  const recarregarUsuario = useCallback(async () => {
    const u = await api.get('/auth/me');
    updateStoredUser(u);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('girostock_master_token');
    localStorage.removeItem('girostock_master_user');
    clearSession();
    setUser(null);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('suporte-leitura', !!(user && user.suporte && !user.suporte.edicao));
  }, [user]);

  // Recarrega perfil/loja/areas ao abrir o sistema (podem ter mudado desde o login).
  useEffect(() => {
    if (!getCurrentUser()) return;
    api.get('/auth/me')
      .then((u) => { updateStoredUser(u); setUser(u); })
      .catch((err) => { if (err.status === 401) logout(); });
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, login, concluirLogin, entrarSuporte, encerrarSuporte, voltarAoMasterLocal, logout, alternarModoTeste, recarregarUsuario }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
