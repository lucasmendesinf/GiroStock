import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { useToast } from './context/UiContext.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { Field, Modal } from './components/ui.jsx';
import { api } from './api/client';
import { exitFullscreen } from './utils/fullscreen.js';
import { podeAcessar, rotaInicial, telasDoUsuario } from './utils/permissions.js';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import PDV from './pages/PDV.jsx';
import Products from './pages/Products.jsx';
import Users from './pages/Users.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Reports from './pages/Reports.jsx';
import Locations from './pages/Locations.jsx';

// Tela protegida: exige login e, se informada, acesso a area do perfil.
function Private({ permissoes, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!podeAcessar(user, permissoes)) return <Layout><SemAcesso /></Layout>;
  return <Layout>{children}</Layout>;
}

function SemAcesso() {
  const { user } = useAuth();
  return (
    <div className="page">
      <div className="card sem-acesso">
        <h3>Você não tem acesso a esta área</h3>
        <p>Seu nível de acesso (<strong>{user.nivel || user.perfil}</strong>) não permite abrir esta tela. Se precisar, peça a um administrador para liberar a permissão.</p>
        <NavLink className="btn-link" to={rotaInicial(user)}>Ir para a minha tela inicial</NavLink>
      </div>
    </div>
  );
}

function TrocarSenha({ onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ senha_atual: '', nova_senha: '', confirmar: '' });
  async function salvar(e) {
    e.preventDefault();
    if (form.nova_senha !== form.confirmar) { toast.erro('A confirmação não confere com a nova senha.'); return; }
    try {
      await api.post('/auth/change-password', { senha_atual: form.senha_atual, nova_senha: form.nova_senha });
      toast.sucesso('Senha alterada.');
      onClose();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Alterar minha senha" onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="Senha atual"><input type="password" autoComplete="current-password" value={form.senha_atual} onChange={(e) => setForm({ ...form, senha_atual: e.target.value })} required /></Field>
        <Field label="Nova senha" hint="Mínimo de 6 caracteres"><input type="password" autoComplete="new-password" minLength={6} value={form.nova_senha} onChange={(e) => setForm({ ...form, nova_senha: e.target.value })} required /></Field>
        <Field label="Confirmar nova senha"><input type="password" autoComplete="new-password" value={form.confirmar} onChange={(e) => setForm({ ...form, confirmar: e.target.value })} required /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Salvar senha</button>
        </div>
      </form>
    </Modal>
  );
}

function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuAberto, setMenuAberto] = useState(false);
  const [contaAberta, setContaAberta] = useState(false);
  const [trocandoSenha, setTrocandoSenha] = useState(false);
  const noPdv = location.pathname === '/pdv';
  const telas = telasDoUsuario(user);

  useEffect(() => {
    if (!noPdv) exitFullscreen();
    setMenuAberto(false);
    setContaAberta(false);
  }, [location.pathname, noPdv]);

  function sair() {
    exitFullscreen();
    logout();
    navigate('/login');
  }

  // No PDV a barra e compacta: o operador nao sai da venda por engano.
  if (noPdv) {
    const outrasTelas = telas.filter((t) => t.path !== '/pdv');
    return (
      <div className="app-shell pdv-mode">
        <header className="topbar topbar-pdv">
          <div className="brand">GiroStock</div>
          <span className="pdv-mode-user">{user?.nome}{user?.locationNome ? ` · ${user.locationNome}` : ''}</span>
          <div className="user-box">
            <ThemeToggle />
            {outrasTelas.length > 0 && <NavLink className="btn-link" to={outrasTelas[0].path}>Sair do PDV</NavLink>}
            <button onClick={sair}>Sair</button>
          </div>
        </header>
        <main>{children}</main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">GiroStock</div>
        <button type="button" className="menu-toggle" aria-label="Abrir menu" aria-expanded={menuAberto} onClick={() => setMenuAberto(!menuAberto)}>☰</button>
        <nav className={menuAberto ? 'aberto' : ''}>
          {telas.map((t) => <NavLink key={t.path} to={t.path}>{t.label}</NavLink>)}
        </nav>
        <div className="user-box">
          <ThemeToggle />
          <div className="conta">
            <button type="button" className="conta-botao" aria-expanded={contaAberta} onClick={() => setContaAberta(!contaAberta)}>
              <span className="conta-nome">{user?.nome}</span>
              <span className="conta-perfil">{user?.nivel || user?.perfil}{user?.locationNome ? ` · ${user.locationNome}` : ''}</span>
            </button>
            {contaAberta && (
              <div className="conta-menu">
                {user?.empresaNome && <div className="conta-empresa">{user.empresaNome}</div>}
                <button type="button" onClick={() => { setContaAberta(false); setTrocandoSenha(true); }}>Alterar minha senha</button>
                <button type="button" onClick={sair}>Sair</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      {trocandoSenha && <TrocarSenha onClose={() => setTrocandoSenha(false)} />}
    </div>
  );
}

function Inicial() {
  const { user } = useAuth();
  return <Navigate to={rotaInicial(user)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/inicio" element={<Private><Home /></Private>} />
      <Route path="/pdv" element={<Private permissoes={['vendas.pdv']}><PDV /></Private>} />
      <Route path="/produtos" element={<Private permissoes={['estoque.ver']}><Products /></Private>} />
      <Route path="/insumos" element={<Navigate to="/produtos" replace />} />
      <Route path="/fornecedores" element={<Private permissoes={['estoque.ver']}><Suppliers /></Private>} />
      <Route path="/lojas" element={<Private permissoes={['lojas.gerenciar']}><Locations /></Private>} />
      <Route path="/usuarios" element={<Private permissoes={['usuarios.gerenciar']}><Users /></Private>} />
      <Route path="/relatorios" element={<Private permissoes={['relatorios.ver']}><Reports /></Private>} />
      <Route path="*" element={<Inicial />} />
    </Routes>
  );
}
