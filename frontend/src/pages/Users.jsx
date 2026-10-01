import { useEffect, useState } from 'react';
import { api } from '../api/client';

const PERFIS = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro'];

export default function Users() {
  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState({ nome: '', email: '', senha: '', confirmarSenha: '', perfil: PERFIS[0], location_id: '' });
  const [erro, setErro] = useState(null);

  async function reload() {
    const [u, l] = await Promise.all([api.get('/users'), api.get('/locations')]);
    setUsers(u); setLocations(l);
  }
  useEffect(() => { reload(); }, []);

  async function criar(e) {
    e.preventDefault();
    setErro(null);
    if (form.senha !== form.confirmarSenha) {
      setErro('As senhas nao coincidem');
      return;
    }
    try {
      await api.post('/users', {
        nome: form.nome, email: form.email, senha: form.senha, perfil: form.perfil,
        location_id: form.location_id || null,
      });
      setForm({ nome: '', email: '', senha: '', confirmarSenha: '', perfil: PERFIS[0], location_id: '' });
      reload();
    } catch (err) { setErro(err.message); }
  }

  async function alternarStatus(u) {
    setErro(null);
    try {
      await api.patch(`/users/${u.id}/status`, { ativo: !u.ativo });
      reload();
    } catch (err) { setErro(err.message); }
  }

  // Perfil e loja de atuacao podem ser trocados a qualquer momento (vale sem novo login).
  async function alterar(u, campos) {
    setErro(null);
    try {
      await api.patch(`/users/${u.id}`, campos);
      reload();
    } catch (err) { setErro(err.message); }
  }

  const locaisAtivos = locations.filter((l) => l.ativo);

  return (
    <div className="page">
      <h2>Usuários</h2>
      {erro && <p className="error">{erro}</p>}

      <div className="card">
        <h3>Cadastrar usuário</h3>
        <form onSubmit={criar}>
          <input placeholder="Nome" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />
          <input type="email" placeholder="E-mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <select value={form.perfil} onChange={(e) => setForm({ ...form, perfil: e.target.value })}>
            {PERFIS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
            <option value="">Local de atuacao (todos)</option>
            {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
          </select>
          <p className="form-hint">Com uma loja definida, o usuário só vende, movimenta estoque e vê relatórios dessa loja. Administradores sempre têm acesso a todas.</p>
          <input type="password" placeholder="Senha (min. 6)" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} required />
          <input type="password" placeholder="Confirmar senha" value={form.confirmarSenha} onChange={(e) => setForm({ ...form, confirmarSenha: e.target.value })} required />
          <button type="submit">Cadastrar</button>
        </form>
      </div>

      <div className="card">
        <h3>Usuários cadastrados</h3>
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Loja de atuação</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.nome}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.perfil} onChange={(e) => alterar(u, { perfil: e.target.value })}>
                    {PERFIS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td>
                  <select value={u.location_id || ''} onChange={(e) => alterar(u, { location_id: e.target.value || null })}>
                    <option value="">Todas as lojas</option>
                    {locations.filter((l) => l.ativo || l.id === u.location_id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                </td>
                <td>{u.ativo ? 'Ativo' : 'Inativo'}</td>
                <td><button onClick={() => alternarStatus(u)}>{u.ativo ? 'Desativar' : 'Ativar'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
