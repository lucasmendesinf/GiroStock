import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { AtivarDoisFatores, CampoCodigo } from '../components/DoisFatores.jsx';
import { rotaInicial } from '../utils/permissions.js';

export default function Login() {
  const { login, concluirLogin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(() => {
    try { const a = sessionStorage.getItem('girostock_aviso'); sessionStorage.removeItem('girostock_aviso'); return a; } catch { return null; }
  });
  const [loading, setLoading] = useState(false);
  // 2FA: o token_mfa fica so aqui (memoria), nunca no localStorage.
  const [mfa, setMfa] = useState(null); // { tipo: 'pendente' | 'configurar', tokenMfa }
  const [codigo, setCodigo] = useState('');
  const [usarRecuperacao, setUsarRecuperacao] = useState(false);

  function entrar(usuario, aviso) {
    if (aviso) toast.sucesso(aviso);
    navigate(rotaInicial(usuario));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErro(null);
    setLoading(true);
    try {
      const r = await login(email.trim(), senha);
      if (r.mfa) { setMfa({ tipo: r.mfa, tokenMfa: r.tokenMfa }); setCodigo(''); setUsarRecuperacao(false); setSenha(''); }
      else navigate(rotaInicial(r));
    } catch (err) {
      setErro(err.status === 401 ? 'E-mail ou senha incorretos.' : err.status === 403 && err.dados && err.dados.empresaSuspensa ? `Empresa suspensa${err.dados.motivo ? `: ${err.dados.motivo}` : '.'} Fale com o suporte.` : err.message);
    } finally {
      setLoading(false);
    }
  }

  async function verificar(valor) {
    const c = String(valor).trim();
    if (!c || loading) return;
    setErro(null);
    setLoading(true);
    try {
      const data = await api.post('/auth/2fa/verificar', { token_mfa: mfa.tokenMfa, codigo: c });
      entrar(concluirLogin(data), data.aviso);
    } catch (err) {
      if (err.status === 401) { voltar(); setErro('A verificação expirou. Entre novamente.'); }
      else if (err.status === 403 && err.dados && err.dados.empresaSuspensa) { voltar(); setErro(`Empresa suspensa${err.dados.motivo ? `: ${err.dados.motivo}` : '.'} Fale com o suporte.`); }
      else { setErro(err.message.charAt(0).toUpperCase() + err.message.slice(1)); setCodigo(''); }
    } finally {
      setLoading(false);
    }
  }

  function voltar() {
    setMfa(null); setCodigo(''); setUsarRecuperacao(false); setErro(null);
  }

  // Ativacao forcada (Master / usuario com 2FA exigido): tela cheia antes de entrar.
  if (mfa && mfa.tipo === 'configurar') {
    return (
      <div className="login-screen">
        <div className="theme-toggle-corner"><ThemeToggle /></div>
        <div className="login-card login-card-larga">
          <h1>Proteja sua conta</h1>
          <p className="login-sub">Sua conta exige verificação em duas etapas. Configure agora para continuar.</p>
          <AtivarDoisFatores
            tokenMfa={mfa.tokenMfa}
            onCancelar={voltar}
            onConcluido={(data) => entrar(concluirLogin(data))}
          />
        </div>
      </div>
    );
  }

  if (mfa) {
    return (
      <div className="login-screen">
        <div className="theme-toggle-corner"><ThemeToggle /></div>
        <form className="login-card" onSubmit={(e) => { e.preventDefault(); verificar(codigo); }}>
          <h1>Código de verificação</h1>
          <p className="login-sub">{usarRecuperacao ? 'Digite um dos seus códigos de recuperação.' : 'Digite o código de 6 dígitos do seu app autenticador.'}</p>
          {usarRecuperacao ? (
            <label>
              Código de recuperação
              <input autoFocus autoComplete="off" spellCheck={false} placeholder="xxxxx-xxxxx" value={codigo} onChange={(e) => setCodigo(e.target.value)} required />
            </label>
          ) : (
            <CampoCodigo valor={codigo} onChange={setCodigo} onCompleto={verificar} disabled={loading} />
          )}
          {erro && <p className="error" role="alert">{erro}</p>}
          <button type="submit" disabled={loading || !codigo}>{loading ? 'Verificando...' : 'Verificar'}</button>
          <button type="button" className="login-link" onClick={() => { setUsarRecuperacao(!usarRecuperacao); setCodigo(''); setErro(null); }}>
            {usarRecuperacao ? 'Usar o app autenticador' : 'Usar código de recuperação'}
          </button>
          <button type="button" className="login-link" onClick={voltar}>Voltar</button>
        </form>
      </div>
    );
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
