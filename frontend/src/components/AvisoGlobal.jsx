import { useEffect, useState } from 'react';
import { api } from '../api/client';

const CHAVE = 'girostock_aviso_dispensado';

function dispensado(id) {
  try { return localStorage.getItem(CHAVE) === id; } catch { return false; }
}

// Faixa discreta no topo com o aviso global do Master. Cada usuario pode dispensar; a dispensa vale ate o proximo aviso
// (guardada no navegador por id do aviso). Falha ao buscar nunca atrapalha a tela.
export default function AvisoGlobal() {
  const [aviso, setAviso] = useState(null);
  useEffect(() => {
    let vivo = true;
    const buscar = () => api.get('/aviso-global').then((r) => { if (vivo) setAviso(r.aviso && !dispensado(r.aviso.id) ? r.aviso : null); }).catch(() => {});
    buscar();
    const t = setInterval(buscar, 5 * 60 * 1000);
    return () => { vivo = false; clearInterval(t); };
  }, []);
  if (!aviso) return null;
  function dispensar() {
    try { localStorage.setItem(CHAVE, aviso.id); } catch { /* sem armazenamento */ }
    setAviso(null);
  }
  return (
    <div className="aviso-faixa" role="status">
      <span>📢 {aviso.mensagem}</span>
      <button type="button" className="aviso-fechar" aria-label="Dispensar aviso" onClick={dispensar}>×</button>
    </div>
  );
}
