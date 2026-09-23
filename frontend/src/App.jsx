import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Login from './pages/Login.jsx';
import PDV from './pages/PDV.jsx';
import Products from './pages/Products.jsx';
import Ingredients from './pages/Ingredients.jsx';
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
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">GiroStock</div>
        <nav>
          <NavLink to="/pdv">PDV</NavLink>
          <NavLink to="/produtos">Produtos &amp; Estoque</NavLink>
          <NavLink to="/insumos">Insumos</NavLink>
          <NavLink to="/fornecedores">Fornecedores</NavLink>
          <NavLink to="/usuarios">Usuários</NavLink>
          <NavLink to="/relatorios">Relatórios</NavLink>
        </nav>
        <div className="user-box">
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
      <Route path="/insumos" element={<Private><Layout><Ingredients /></Layout></Private>} />
      <Route path="/fornecedores" element={<Private><Layout><Suppliers /></Layout></Private>} />
      <Route path="/usuarios" element={<Private><Layout><Users /></Layout></Private>} />
      <Route path="/relatorios" element={<Private><Layout><Reports /></Layout></Private>} />
      <Route path="*" element={<Navigate to="/pdv" replace />} />
    </Routes>
  );
}
