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

  // Recarrega o usuario (ex.: depois da troca obrigatoria de senha).
  const recarregarUsuario = useCallback(async () => {
    const u = await api.get('/auth/me');
    updateStoredUser(u);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  // Recarrega perfil/loja/areas ao abrir o sistema (podem ter mudado desde o login).
  useEffect(() => {
    if (!getCurrentUser()) return;
    api.get('/auth/me')
      .then((u) => { updateStoredUser(u); setUser(u); })
      .catch((err) => { if (err.status === 401) logout(); });
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, login, concluirLogin, logout, alternarModoTeste, recarregarUsuario }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
