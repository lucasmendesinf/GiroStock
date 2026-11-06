import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { temModulo } from '../utils/permissions';

// Faixa "Evento em andamento" (PDV e Comandas): as vendas deste setor estao contando para o evento aberto.
// Sem locationId: o evento aberto em qualquer setor que o usuario acessa.
export default function FaixaEvento({ locationId }) {
  const { user } = useAuth();
  const [evento, setEvento] = useState(null);
  const ligado = temModulo(user, 'eventos');
  useEffect(() => {
    if (!ligado) { setEvento(null); return undefined; }
    let vivo = true;
    const buscar = () => api.get(`/evento-em-andamento${locationId ? `?location_id=${locationId}` : ''}`).then((e) => vivo && setEvento(e)).catch(() => {});
    buscar();
    const t = setInterval(buscar, 60000);
    return () => { vivo = false; clearInterval(t); };
  }, [ligado, locationId]);
  if (!evento) return null;
  return <span className="faixa-evento" title="As vendas deste setor estão contando para o evento">🎤 Evento: <b>{evento.nome}</b></span>;
}
