import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { Marca } from '../components/Logo.jsx';

// Tela mostrada aos usuarios das empresas enquanto o Master mantem o sistema em manutencao.
export default function Manutencao() {
  const navigate = useNavigate();
  const [verificando, setVerificando] = useState(false);
  let mensagem = '';
  try { mensagem = sessionStorage.getItem('girostock_manutencao') || ''; } catch { /* sem armazenamento */ }

  async function tentar() {
    setVerificando(true);
    try {
      const me = await api.get('/auth/me');
      if (!me.manutencao) { try { sessionStorage.removeItem('girostock_manutencao'); } catch { /* ok */ } navigate('/'); return; }
    } catch { /* continua em manutencao */ }
    setVerificando(false);
  }
  return (
    <div className="login-screen">
      <div className="theme-toggle-corner"><ThemeToggle /></div>
      <div className="login-card login-card-larga" style={{ textAlign: 'center' }}>
        <div className="login-marca"><Marca tamanho={48} /></div>
        <h1>Em manutenção</h1>
        <p className="login-sub">{mensagem || 'O sistema está em manutenção. Voltamos em instantes.'}</p>
        <button type="button" onClick={tentar} disabled={verificando}>{verificando ? 'Verificando...' : 'Tentar novamente'}</button>
      </div>
    </div>
  );
}
