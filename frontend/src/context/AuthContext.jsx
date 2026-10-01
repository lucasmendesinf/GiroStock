import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, saveSession, clearSession, getCurrentUser, updateStoredUser } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getCurrentUser());

  const login = useCallback(async (email, senha) => {
    const data = await api.post('/auth/login', { email, senha });
    saveSession(data.token, data.usuario);
    setUser(data.usuario);
    return data.usuario;
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
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
