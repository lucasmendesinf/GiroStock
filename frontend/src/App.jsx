import { useLocation } from 'react-router-dom';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from './context/AuthContext.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { requestFullscreen, exitFullscreen } from './utils/fullscreen.js';
import Login from './pages/Login.jsx';
import PDV from './pages/PDV.jsx';
import Products from './pages/Products.jsx';
import Users from './pages/Users.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Reports from './pages/Reports.jsx';

function Private({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (location.pathname !== '/pdv') exitFullscreen();
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">GiroStock</div>
        <nav>
          <NavLink to="/pdv" onClick={requestFullscreen}>PDV</NavLink>
          <NavLink to="/produtos">Produtos &amp; Estoque</NavLink>
          <NavLink to="/fornecedores">Fornecedores</NavLink>
          <NavLink to="/usuarios">Usuários</NavLink>
          <NavLink to="/relatorios">Relatórios</NavLink>
        </nav>
        <div className="user-box">
          <ThemeToggle />
          <span>{user?.nome} ({user?.perfil})</span>
          <button onClick={logout}>Sair</button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/pdv" element={<Private><Layout><PDV /></Layout></Private>} />
      <Route path="/produtos" element={<Private><Layout><Products /></Layout></Private>} />
      <Route path="/insumos" element={<Navigate to="/produtos" replace />} />
      <Route path="/fornecedores" element={<Private><Layout><Suppliers /></Layout></Private>} />
      <Route path="/usuarios" element={<Private><Layout><Users /></Layout></Private>} />
      <Route path="/relatorios" element={<Private><Layout><Reports /></Layout></Private>} />
      <Route path="*" element={<Navigate to="/pdv" replace />} />
    </Routes>
  );
}
