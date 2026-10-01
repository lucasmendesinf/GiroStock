import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { rotaInicial } from '../utils/permissions.js';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro(null);
    setLoading(true);
    try {
      const usuario = await login(email.trim(), senha);
      navigate(rotaInicial(usuario));
    } catch (err) {
      setErro(err.status === 401 ? 'E-mail ou senha incorretos.' : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="theme-toggle-corner"><ThemeToggle /></div>
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>GiroStock</h1>
        <label>
          E-mail
          <input type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Senha
          <input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </label>
        {erro && <p className="error" role="alert">{erro}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  );
}
