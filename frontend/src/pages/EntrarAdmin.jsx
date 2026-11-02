import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { rotaInicial } from '../utils/permissions.js';
import { Marca } from '../components/Logo.jsx';

// Entrada vinda do admin da Calutec (onde fica o painel Master): "Entrar como suporte" e "Ligar modo teste" abrem
// /entrar-admin#token=... . O token vem no fragmento (#), que o navegador nao envia ao servidor nem grava em log.
// O servidor confere o token a cada requisicao como sempre (sessao de suporte valida, modo teste permitido etc.).
export default function EntrarAdmin() {
  const { entrarComToken } = useAuth();
  const navigate = useNavigate();
  const [erro, setErro] = useState(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    window.history.replaceState(null, '', '/entrar-admin'); // tira o token da barra de endereco e do historico
    if (!token) { setErro('Link de acesso inválido. Abra de novo pelo admin.'); return; }
    entrarComToken(token)
      .then((u) => {
        if (!u.suporte && !u.modoTeste) throw new Error('Este link não abre uma sessão de suporte nem de modo teste.');
        // Modo teste: o Master usa o sistema como Administrador da empresa escolhida (o painel Master fica no admin)
        navigate(u.modoTeste ? '/inicio' : rotaInicial(u), { replace: true });
      })
      .catch((err) => setErro(err.message || 'Não foi possível entrar. Abra de novo pelo admin.'));
  }, [entrarComToken, navigate]);

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-marca"><Marca tamanho={40} /></div>
        {erro ? <p className="error" role="alert">{erro}</p> : <p className="login-sub">Entrando…</p>}
      </div>
    </div>
  );
}
