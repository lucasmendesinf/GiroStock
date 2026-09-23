import { createContext, useContext, useState, useCallback } from 'react';
import { api, saveSession, clearSession, getCurrentUser } from '../api/client';

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

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
