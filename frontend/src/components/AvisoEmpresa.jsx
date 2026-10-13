import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// Aviso aos ADMINISTRADORES da empresa de que a equipe de suporte da plataforma acessou a conta (nunca mostra quem).
export default function AvisoEmpresa() {
  const { user } = useAuth();
  const [avisos, setAvisos] = useState([]);
  const admin = user && user.perfil === 'Administrador' && !user.suporte && !user.master;
  useEffect(() => {
    if (!admin) return;
    api.get('/avisos-empresa').then((r) => setAvisos(r.avisos)).catch(() => {});
  }, [admin]);
  if (!admin || avisos.length === 0) return null;
  async function dispensar(id) {
    setAvisos((a) => a.filter((x) => x.id !== id));
    try { await api.post(`/avisos-empresa/${id}/dispensar`); } catch { /* o aviso volta no proximo carregamento */ }
  }
  return (
    <>
      {avisos.map((a) => (
        <div key={a.id} className="aviso-faixa" role="status">
          <span>🛡 {a.mensagem}</span>
          <button type="button" className="aviso-fechar" aria-label="Dispensar aviso" onClick={() => dispensar(a.id)}>×</button>
        </div>
      ))}
    </>
  );
}
