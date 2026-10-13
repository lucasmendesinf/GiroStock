import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Faixa fixa durante o suporte do Master (nao pode ser escondida): empresa, modo, contagem regressiva e "Encerrar suporte".
export default function SuporteFaixa() {
  const { user, encerrarSuporte, voltarAoMasterLocal } = useAuth();
  const toast = useToast();
  const fim = user && user.suporte ? new Date(user.suporte.expiraEm).getTime() : null;
  const [restante, setRestante] = useState(fim ? fim - Date.now() : 0);

  useEffect(() => {
    if (!fim) return undefined;
    const t = setInterval(() => {
      const r = fim - Date.now();
      setRestante(r);
      if (r <= 0) { clearInterval(t); voltarAoMasterLocal('A sessão de suporte expirou (30 minutos).'); }
    }, 1000);
    return () => clearInterval(t);
  }, [fim, voltarAoMasterLocal]);

  if (!user || !user.suporte) return null;
  async function encerrar() {
    try { await encerrarSuporte(); window.location.assign('/master/empresas'); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="faixa-suporte" role="alert">
      <span>SUPORTE — acessando <b>{user.suporte.empresa}</b> como administrador · {user.suporte.edicao ? 'edição liberada' : 'somente leitura'} · expira em <b>{mmss(restante)}</b></span>
      <button type="button" onClick={encerrar}>Encerrar suporte</button>
    </div>
  );
}
