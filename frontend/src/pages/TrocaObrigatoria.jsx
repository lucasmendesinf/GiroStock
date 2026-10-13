import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/UiContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

// Tela de troca obrigatoria de senha: aparece antes de liberar o sistema (senha temporaria / troca forcada pelo Master).
export default function TrocaObrigatoria() {
  const { user, logout, recarregarUsuario } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ atual: '', nova: '', confirmar: '' });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  async function salvar(e) {
    e.preventDefault();
    setErro(null);
    if (form.nova.length < 6) { setErro('A nova senha deve ter no mínimo 6 caracteres.'); return; }
    if (form.nova !== form.confirmar) { setErro('A confirmação não confere com a nova senha.'); return; }
    if (form.nova === form.atual) { setErro('Escolha uma senha diferente da temporária.'); return; }
    setSalvando(true);
    try {
      await api.post('/auth/change-password', { senha_atual: form.atual, nova_senha: form.nova });
      await recarregarUsuario();
      toast.sucesso('Senha alterada. Bem-vindo!');
    } catch (err) { setErro(err.message); setSalvando(false); }
  }

  return (
    <div className="login-screen">
      <div className="theme-toggle-corner"><ThemeToggle /></div>
      <form className="login-card" onSubmit={salvar}>
        <h1>GiroStock</h1>
        <p className="muted" style={{ margin: 0 }}>Olá, {user.nome}. Por segurança, defina uma <b>nova senha</b> antes de continuar.</p>
        <label>Senha atual (temporária)
          <input type="password" autoComplete="current-password" autoFocus value={form.atual} onChange={(e) => setForm({ ...form, atual: e.target.value })} required />
        </label>
        <label>Nova senha
          <input type="password" autoComplete="new-password" minLength={6} value={form.nova} onChange={(e) => setForm({ ...form, nova: e.target.value })} required />
        </label>
        <label>Confirmar nova senha
          <input type="password" autoComplete="new-password" value={form.confirmar} onChange={(e) => setForm({ ...form, confirmar: e.target.value })} required />
        </label>
        {erro && <p className="error" role="alert">{erro}</p>}
        <button type="submit" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar nova senha'}</button>
        <button type="button" className="btn-link" onClick={logout}>Sair</button>
      </form>
    </div>
  );
}
