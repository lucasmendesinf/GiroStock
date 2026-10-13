import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Empresas from './master/Empresas.jsx';
import Usuarios from './master/Usuarios.jsx';
import ModoTeste from './master/ModoTeste.jsx';

// Painel Master: navegacao por abas. As abas marcadas "em breve" entram nas fases seguintes.
const ABAS = [
  { to: '/master/empresas', label: 'Empresas' },
  { to: '/master/usuarios', label: 'Usuários & segurança' },
  { to: '/master/modo-teste', label: 'Modo teste' },
];
const EM_BREVE = ['Visão geral', 'Backups & dados', 'Auditoria', 'Configurações globais'];

export default function Master() {
  return (
    <div className="page">
      <div className="ped-head"><h2>Painel Master</h2></div>
      <nav className="mt-abas" aria-label="Seções do painel Master">
        {ABAS.map((a) => <NavLink key={a.to} to={a.to}>{a.label}</NavLink>)}
        {EM_BREVE.map((l) => <span key={l} className="mt-breve" title="Em breve" aria-disabled="true">{l} <small>em breve</small></span>)}
      </nav>
      <Routes>
        <Route path="empresas" element={<Empresas />} />
        <Route path="usuarios" element={<Usuarios />} />
        <Route path="modo-teste" element={<ModoTeste />} />
        <Route path="*" element={<Navigate to="/master/empresas" replace />} />
      </Routes>
    </div>
  );
}
