import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { useToast } from './context/UiContext.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { Field, Modal } from './components/ui.jsx';
import SegurancaModal from './components/DoisFatores.jsx';
import { api } from './api/client';
import { exitFullscreen } from './utils/fullscreen.js';
import { podeAcessar, rotaInicial, telasDoUsuario } from './utils/permissions.js';
import Login from './pages/Login.jsx';
import Manutencao from './pages/Manutencao.jsx';
import AvisoGlobal from './components/AvisoGlobal.jsx';
import AvisoEmpresa from './components/AvisoEmpresa.jsx';
import SuporteFaixa from './components/SuporteFaixa.jsx';
import { Logo } from './components/Logo.jsx';
import Home from './pages/Home.jsx';
import PDV from './pages/PDV.jsx';
import Pedidos from './pages/Pedidos.jsx';
import Clientes from './pages/Clientes.jsx';
import Products from './pages/Products.jsx';
import Users from './pages/Users.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Reports from './pages/Reports.jsx';
import Locations from './pages/Locations.jsx';
import Master from './pages/Master.jsx';
import TrocaObrigatoria from './pages/TrocaObrigatoria.jsx';
import ModoTesteModal from './components/ModoTesteModal.jsx';

// Tela protegida: exige login e, se informada, acesso a area do perfil.
function Private({ area, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Troca obrigatoria de senha (usuario criado pelo Master ou com troca forcada): nada abre antes dela.
  if (user.deveTrocarSenha) return <TrocaObrigatoria />;
  if (!podeAcessar(user, area)) return <Layout><SemAcesso /></Layout>;
  return <Layout>{children}</Layout>;
}

function SemAcesso() {
  const { user } = useAuth();
  return (
    <div className="page">
      <div className="card sem-acesso">
        <h3>Você não tem acesso a esta área</h3>
        <p>O perfil <strong>{user.perfil}</strong> não pode abrir esta tela. Se precisar, peça a um administrador para ajustar o seu perfil.</p>
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

// Faixa fixa em todas as telas enquanto o modo teste estiver ligado (nao pode ser escondida).
function FaixaTeste() {
  const { user, alternarModoTeste } = useAuth();
  const toast = useToast();
  if (!user || !user.modoTeste) return null;
  async function voltar() {
    try { await alternarModoTeste(false); window.location.assign('/'); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="faixa-teste" role="alert">
      <span>MODO TESTE — nada aqui afeta a produção</span>
      <button type="button" onClick={voltar}>Voltar à produção</button>
    </div>
  );
}

function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuAberto, setMenuAberto] = useState(false);
  const [contaAberta, setContaAberta] = useState(false);
  const [trocandoSenha, setTrocandoSenha] = useState(false);
  const [segurancaAberta, setSegurancaAberta] = useState(false);
  const [modoTesteAberto, setModoTesteAberto] = useState(false);
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
        <SuporteFaixa />
        <FaixaTeste />
        <header className="topbar topbar-pdv">
          <div className="brand"><Logo tamanho={36} /></div>
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
      <SuporteFaixa />
      <AvisoGlobal />
      <AvisoEmpresa />
      <FaixaTeste />
      <header className="topbar">
        <div className="brand"><NavLink to={rotaInicial(user)} className="brand-link" aria-label="GiroStock - ir para a tela inicial"><Logo tamanho={36} /></NavLink></div>
        <button type="button" className="menu-toggle" aria-label="Abrir menu" aria-expanded={menuAberto} onClick={() => setMenuAberto(!menuAberto)}>☰</button>
        <nav className={menuAberto ? 'aberto' : ''}>
          {telas.map((t) => <NavLink key={t.path} to={t.path}>{t.label}</NavLink>)}
        </nav>
        <div className="user-box">
          <ThemeToggle />
          <div className="conta">
            <button type="button" className="conta-botao" aria-expanded={contaAberta} onClick={() => setContaAberta(!contaAberta)}>
              <span className="conta-nome">{user?.nome}</span>
              <span className="conta-perfil">{user?.perfil}{user?.locationNome ? ` · ${user.locationNome}` : ''}</span>
            </button>
            {contaAberta && (
              <div className="conta-menu">
                {user?.empresaNome && <div className="conta-empresa">{user.empresaNome}</div>}
                {user?.areas?.ModoTeste && !user.master && !user.modoTeste && !user.suporte && (
                  <button type="button" onClick={() => { setContaAberta(false); setModoTesteAberto(true); }}>Modo teste</button>
                )}
                {!user?.suporte && <button type="button" onClick={() => { setContaAberta(false); setTrocandoSenha(true); }}>Alterar minha senha</button>}
                {!user?.suporte && <button type="button" onClick={() => { setContaAberta(false); setSegurancaAberta(true); }}>Verificação em duas etapas</button>}
                <button type="button" onClick={sair}>Sair</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
      {trocandoSenha && <TrocarSenha onClose={() => setTrocandoSenha(false)} />}
      {segurancaAberta && <SegurancaModal onClose={() => setSegurancaAberta(false)} />}
      {modoTesteAberto && <ModoTesteModal onClose={() => setModoTesteAberto(false)} />}
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
      <Route path="/manutencao" element={<Manutencao />} />
      <Route path="/master/*" element={<Private area="Master"><Master /></Private>} />
      <Route path="/inicio" element={<Private><Home /></Private>} />
      <Route path="/pdv" element={<Private area="Vendas"><PDV /></Private>} />
      <Route path="/pedidos" element={<Private area="Pedidos"><Pedidos /></Private>} />
      <Route path="/clientes" element={<Private area="Clientes"><Clientes /></Private>} />
      <Route path="/produtos" element={<Private area="Estoque"><Products /></Private>} />
      <Route path="/insumos" element={<Navigate to="/produtos" replace />} />
      <Route path="/fornecedores" element={<Private area="Estoque"><Suppliers /></Private>} />
      <Route path="/lojas" element={<Private area="Configuracoes"><Locations /></Private>} />
      <Route path="/usuarios" element={<Private area="Configuracoes"><Users /></Private>} />
      <Route path="/relatorios" element={<Private area="Relatorios"><Reports /></Private>} />
      <Route path="*" element={<Inicial />} />
    </Routes>
  );
}
