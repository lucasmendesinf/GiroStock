import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Empresas from './master/Empresas.jsx';
import Usuarios from './master/Usuarios.jsx';
import ModoTeste from './master/ModoTeste.jsx';
import VisaoGeral from './master/VisaoGeral.jsx';
import Auditoria from './master/Auditoria.jsx';
import Backups from './master/Backups.jsx';
import Config from './master/Config.jsx';

// Painel Master: navegacao por abas.
const ABAS = [
  { to: '/master/visao-geral', label: 'Visão geral' },
  { to: '/master/empresas', label: 'Empresas' },
  { to: '/master/usuarios', label: 'Usuários & segurança' },
  { to: '/master/modo-teste', label: 'Modo teste' },
  { to: '/master/backups', label: 'Backups & dados' },
  { to: '/master/auditoria', label: 'Auditoria' },
  { to: '/master/config', label: 'Configurações globais' },
];

export default function Master() {
  return (
    <div className="page">
      <div className="ped-head"><h2>Painel Master</h2></div>
      <nav className="mt-abas" aria-label="Seções do painel Master">
        {ABAS.map((a) => <NavLink key={a.to} to={a.to}>{a.label}</NavLink>)}
      </nav>
      <Routes>
        <Route path="visao-geral" element={<VisaoGeral />} />
        <Route path="empresas" element={<Empresas />} />
        <Route path="usuarios" element={<Usuarios />} />
        <Route path="modo-teste" element={<ModoTeste />} />
        <Route path="auditoria" element={<Auditoria />} />
        <Route path="backups" element={<Backups />} />
        <Route path="config" element={<Config />} />
        <Route path="*" element={<Navigate to="/master/visao-geral" replace />} />
      </Routes>
    </div>
  );
}
