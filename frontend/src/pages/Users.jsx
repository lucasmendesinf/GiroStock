import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Modal, Vazio } from '../components/ui.jsx';

const PERFIS = ['Caixa/Operador', 'Gerente', 'Estoque', 'Financeiro', 'Lanchonete/Cozinha', 'Administrador'];
const DESCRICAO_PERFIL = {
  'Administrador': 'Acesso total, inclusive usuários, lojas e configurações.',
  'Gerente': 'Vendas, estoque e relatórios. Pode cancelar vendas.',
  'Caixa/Operador': 'Somente o PDV (vendas, sangria e fechamento de caixa).',
  'Estoque': 'Produtos, fornecedores, entradas, transferências e insumos.',
  'Financeiro': 'Relatórios e financeiro.',
  'Lanchonete/Cozinha': 'PDV e estoque/insumos da lanchonete (ajuste abaixo se precisar).',
};
const FORM_VAZIO = { nome: '', email: '', senha: '', confirmarSenha: '', perfil: 'Caixa/Operador', location_id: '' };

export default function Users() {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user: eu } = useAuth();
  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [novo, setNovo] = useState(false);
  const [editando, setEditando] = useState(null);
  const [senhaDe, setSenhaDe] = useState(null);
  const [matriz, setMatriz] = useState(null); // { permissoes: {chave: descricao}, padrao: {perfil: {chave: bool}} }

  const reload = useCallback(async () => {
    try {
      const [u, l, m] = await Promise.all([api.get('/users'), api.get('/locations'), api.get('/users/permissoes')]);
      setUsers(u); setLocations(l); setMatriz(m);
    } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  const nomeLocal = (id) => (locations.find((l) => l.id === id) || {}).nome;

  async function alternarStatus(u) {
    if (u.ativo && !(await confirmar({ titulo: `Desativar ${u.nome}?`, mensagem: 'O usuário perde o acesso imediatamente.', confirmar: 'Desativar', perigo: true }))) return;
    try {
      await api.patch(`/users/${u.id}/status`, { ativo: !u.ativo });
      toast.sucesso(u.ativo ? 'Usuário desativado.' : 'Usuário reativado.');
      reload();
    } catch (err) { toast.erro(err); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Usuários</h2>
        <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ Novo usuário</button>
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Usuário</th><th>Perfil</th><th className="col-opcional">Loja de atuação</th><th className="col-opcional">Situação</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.ativo ? '' : 'row-inativa'}>
                  <td><div className="celula-principal">{u.nome}{u.id === eu.id ? ' (você)' : ''}</div><div className="celula-sub">{u.email}</div></td>
                  <td><span className="badge">{u.perfil}</span>{u.permissoes && Object.keys(u.permissoes).length > 0 && <span className="badge-inativo" title="Permissões ajustadas em relação ao padrão do perfil" style={{ marginLeft: 6 }}>personalizado</span>}</td>
                  <td className="col-opcional">{u.location_id ? nomeLocal(u.location_id) : <span className="muted">Todas as lojas</span>}</td>
                  <td className="col-opcional">{u.ativo ? 'Ativo' : <span className="badge-inativo">Inativo</span>}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn-link" onClick={() => setEditando(u)}>Editar</button>
                      <button className="btn-link" onClick={() => setSenhaDe(u)}>Redefinir senha</button>
                      {u.id !== eu.id && <button className={`btn-link ${u.ativo ? 'perigo' : ''}`} onClick={() => alternarStatus(u)}>{u.ativo ? 'Desativar' : 'Reativar'}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {users.length === 0 && <Vazio>Nenhum usuário.</Vazio>}
      </div>

      {novo && matriz && <NovoUsuario matriz={matriz} locations={locations} onClose={() => setNovo(false)} onSalvo={() => { setNovo(false); reload(); }} />}
      {editando && matriz && <EditarUsuario usuario={editando} matriz={matriz} locations={locations} souEu={editando.id === eu.id} onClose={() => setEditando(null)} onSalvo={() => { setEditando(null); reload(); }} />}
      {senhaDe && <RedefinirSenha usuario={senhaDe} onClose={() => setSenhaDe(null)} />}
    </div>
  );
}

// Permissoes efetivas de um usuario: padrao do perfil + ajustes individuais.
function efetivas(matriz, perfil, ajustes) {
  return { ...(matriz.padrao[perfil] || {}), ...(ajustes || {}) };
}

function CamposPerfilLoja({ form, setForm, locations, matriz }) {
  const padrao = matriz.padrao[form.perfil] || {};
  const ajustado = Object.keys(matriz.permissoes).some((k) => !!form.permissoes[k] !== !!padrao[k]);
  return (
    <>
      <Field label="Perfil" hint={DESCRICAO_PERFIL[form.perfil]}>
        <select value={form.perfil} onChange={(e) => setForm({ ...form, perfil: e.target.value, permissoes: { ...(matriz.padrao[e.target.value] || {}) } })}>
          {PERFIS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>
      <Field label="O que este usuário pode fazer" hint="Já vem marcado o padrão do perfil. Marque ou desmarque para dar acesso a mais ou a menos coisas só para este usuário.">
        <div className="permissoes-lista">
          {Object.entries(matriz.permissoes).map(([chave, descricao]) => {
            const diferente = !!form.permissoes[chave] !== !!padrao[chave];
            return (
              <label key={chave} className={`permissao-item ${diferente ? 'ajustada' : ''}`}>
                <input type="checkbox" checked={!!form.permissoes[chave]}
                  onChange={(e) => setForm({ ...form, permissoes: { ...form.permissoes, [chave]: e.target.checked } })} />
                <span>{descricao}{diferente && <em> (ajustado)</em>}</span>
              </label>
            );
          })}
        </div>
        {ajustado && <button type="button" className="btn-link" onClick={() => setForm({ ...form, permissoes: { ...padrao } })}>Restaurar o padrão do perfil</button>}
      </Field>
      <Field label="Loja de atuação" hint="Com uma loja, o usuário só vende, movimenta estoque e vê relatórios dela. Administradores veem todas.">
        <select value={form.location_id || ''} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
          <option value="">Todas as lojas</option>
          {locations.filter((l) => l.ativo || l.id === form.location_id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
      </Field>
    </>
  );
}

function NovoUsuario({ matriz, locations, onClose, onSalvo }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [form, setForm] = useState({ ...FORM_VAZIO, permissoes: { ...matriz.padrao[FORM_VAZIO.perfil] } });
  async function salvar(e) {
    e.preventDefault();
    if (form.senha !== form.confirmarSenha) { toast.erro('As senhas não conferem.'); return; }
    if (form.perfil === 'Administrador' && !(await confirmar({ titulo: 'Criar um Administrador?', mensagem: 'Administradores têm acesso total ao sistema.', confirmar: 'Criar administrador' }))) return;
    try {
      await api.post('/users', { nome: form.nome, email: form.email, senha: form.senha, perfil: form.perfil, location_id: form.location_id || null, permissoes: form.permissoes });
      toast.sucesso('Usuário cadastrado.');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Novo usuário" onClose={onClose} largura="larga">
      <form onSubmit={salvar} className="form-stack">
        <div className="form-grid">
          <Field label="Nome *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required /></Field>
          <Field label="E-mail (login) *"><input type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
        </div>
        <CamposPerfilLoja form={form} setForm={setForm} locations={locations} matriz={matriz} />
        <div className="form-grid">
          <Field label="Senha *" hint="Mínimo de 6 caracteres"><input type="password" autoComplete="new-password" minLength={6} value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} required /></Field>
          <Field label="Confirmar senha *"><input type="password" autoComplete="new-password" value={form.confirmarSenha} onChange={(e) => setForm({ ...form, confirmarSenha: e.target.value })} required /></Field>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Cadastrar</button>
        </div>
      </form>
    </Modal>
  );
}

function EditarUsuario({ usuario, matriz, locations, souEu, onClose, onSalvo }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const inicial = efetivas(matriz, usuario.perfil, usuario.permissoes);
  const [form, setForm] = useState({ nome: usuario.nome, perfil: usuario.perfil, location_id: usuario.location_id || '', permissoes: inicial });
  async function salvar(e) {
    e.preventDefault();
    const mudouPerfil = form.perfil !== usuario.perfil;
    const mudouLoja = (form.location_id || null) !== (usuario.location_id || null);
    const mudouPermissoes = Object.keys(matriz.permissoes).some((k) => !!form.permissoes[k] !== !!inicial[k]);
    if ((mudouPerfil || mudouLoja || mudouPermissoes) && !(await confirmar({
      titulo: 'Confirmar mudança de acesso?',
      mensagem: `${usuario.nome} passa a ter o perfil "${form.perfil}"${mudouPermissoes ? ' com permissões ajustadas' : ''}${form.location_id ? ', restrito a uma loja' : ', em todas as lojas'}. Vale imediatamente.`,
      confirmar: 'Confirmar',
    }))) return;
    try {
      await api.patch(`/users/${usuario.id}`, { nome: form.nome, perfil: form.perfil, location_id: form.location_id || null, permissoes: form.permissoes });
      toast.sucesso('Usuário atualizado.');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={`Editar ${usuario.nome}`} subtitulo={usuario.email} onClose={onClose} largura="larga">
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nome *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required minLength={2} /></Field>
        <CamposPerfilLoja form={form} setForm={setForm} locations={locations} matriz={matriz} />
        {souEu && <p className="form-hint">Você não pode remover o seu próprio perfil de Administrador.</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

function RedefinirSenha({ usuario, onClose }) {
  const toast = useToast();
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  async function salvar(e) {
    e.preventDefault();
    if (senha !== confirmacao) { toast.erro('As senhas não conferem.'); return; }
    try {
      await api.patch(`/users/${usuario.id}/password`, { senha });
      toast.sucesso(`Senha de ${usuario.nome} redefinida. Informe a nova senha ao usuário.`);
      onClose();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={`Redefinir senha de ${usuario.nome}`} onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nova senha" hint="Mínimo de 6 caracteres"><input type="password" autoComplete="new-password" autoFocus minLength={6} value={senha} onChange={(e) => setSenha(e.target.value)} required /></Field>
        <Field label="Confirmar nova senha"><input type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required /></Field>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">Redefinir</button>
        </div>
      </form>
    </Modal>
  );
}
