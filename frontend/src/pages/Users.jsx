import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Modal, Vazio } from '../components/ui.jsx';

// Agrupa o catalogo de permissoes por grupo (Vendas, Estoque, Cadastros, Gestao).
function agrupar(catalogo) {
  const grupos = new Map();
  for (const p of catalogo) {
    if (!grupos.has(p.grupo)) grupos.set(p.grupo, []);
    grupos.get(p.grupo).push(p);
  }
  return [...grupos.entries()];
}

// Quem nao e Administrador so pode atribuir niveis/permissoes que ele mesmo tem.
function podeConceder(eu, permissoes) {
  if (eu.admin || (eu.permissoes || []).includes('*')) return true;
  return permissoes.every((p) => p !== '*' && eu.permissoes.includes(p));
}

export default function Users() {
  const toast = useToast();
  const { user: eu } = useAuth();
  const [aba, setAba] = useState('usuarios');
  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [niveis, setNiveis] = useState([]);
  const [catalogo, setCatalogo] = useState([]);

  const reload = useCallback(async () => {
    try {
      const [u, l, n, c] = await Promise.all([api.get('/users'), api.get('/locations'), api.get('/access-levels'), api.get('/permissions')]);
      setUsers(u); setLocations(l); setNiveis(n); setCatalogo(c);
    } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  const props = { eu, users, locations, niveis, catalogo, reload };
  return (
    <div className="page">
      <div className="page-header">
        <h2>Usuários</h2>
        <div className="segmentado">
          <button type="button" className={aba === 'usuarios' ? 'ativo' : ''} onClick={() => setAba('usuarios')}>Usuários</button>
          <button type="button" className={aba === 'niveis' ? 'ativo' : ''} onClick={() => setAba('niveis')}>Níveis de acesso</button>
        </div>
      </div>
      {aba === 'usuarios' ? <AbaUsuarios {...props} /> : <AbaNiveis {...props} />}
    </div>
  );
}

// ======================= Usuarios =======================

function AbaUsuarios({ eu, users, locations, niveis, catalogo, reload }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [form, setForm] = useState(null); // null | 'novo' | usuario
  const [senhaDe, setSenhaDe] = useState(null);
  const nomeLocal = (id) => (locations.find((l) => l.id === id) || {}).nome;
  const euAdmin = !!eu.admin;

  async function alternarStatus(u) {
    if (u.ativo && !(await confirmar({ titulo: `Desativar ${u.nome}?`, mensagem: 'O usuário perde o acesso imediatamente.', confirmar: 'Desativar', perigo: true }))) return;
    try {
      await api.patch(`/users/${u.id}/status`, { ativo: !u.ativo });
      toast.sucesso(u.ativo ? 'Usuário desativado.' : 'Usuário reativado.');
      reload();
    } catch (err) { toast.erro(err); }
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted">Cada usuário tem um nível de acesso e, se precisar, permissões adicionais só para ele.</span>
        <span className="toolbar-espaco" />
        <button type="button" className="btn-primario" onClick={() => setForm('novo')}>+ Novo usuário</button>
      </div>
      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Usuário</th><th>Nível de acesso</th><th className="col-opcional">Loja de atuação</th><th className="col-opcional">Situação</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const protegido = u.admin && !euAdmin;
                return (
                  <tr key={u.id} className={u.ativo ? '' : 'row-inativa'}>
                    <td><div className="celula-principal">{u.nome}{u.id === eu.id ? ' (você)' : ''}</div><div className="celula-sub">{u.email}</div></td>
                    <td>
                      <span className={`badge ${u.admin ? 'badge-admin' : ''}`}>{u.nivel}</span>
                      {u.permissoes_extra.length > 0 && <span className="chip" title={u.permissoes_extra.join(', ')} style={{ marginLeft: '6px' }}>+{u.permissoes_extra.length} extra</span>}
                    </td>
                    <td className="col-opcional">{u.location_id ? nomeLocal(u.location_id) : <span className="muted">Todas as lojas</span>}</td>
                    <td className="col-opcional">{u.ativo ? 'Ativo' : <span className="badge-inativo">Inativo</span>}</td>
                    <td>
                      {protegido ? <span className="muted">somente Administrador</span> : (
                        <div className="row-actions">
                          <button className="btn-link" onClick={() => setForm(u)}>Editar</button>
                          <button className="btn-link" onClick={() => setSenhaDe(u)}>Redefinir senha</button>
                          {u.id !== eu.id && <button className={`btn-link ${u.ativo ? 'perigo' : ''}`} onClick={() => alternarStatus(u)}>{u.ativo ? 'Desativar' : 'Reativar'}</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {users.length === 0 && <Vazio>Nenhum usuário.</Vazio>}
      </div>

      {form && (
        <FormUsuario usuario={form === 'novo' ? null : form} eu={eu} niveis={niveis} catalogo={catalogo} locations={locations}
          onClose={() => setForm(null)} onSalvo={() => { setForm(null); reload(); }} />
      )}
      {senhaDe && <RedefinirSenha usuario={senhaDe} onClose={() => setSenhaDe(null)} />}
    </>
  );
}

function FormUsuario({ usuario, eu, niveis, catalogo, locations, onClose, onSalvo }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const niveisPermitidos = niveis.filter((n) => podeConceder(eu, n.permissoes));
  const nivelPadrao = (niveisPermitidos.find((n) => n.nome === 'Caixa/Operador') || niveisPermitidos.find((n) => !n.admin) || niveisPermitidos[0] || {}).id || '';
  const [form, setForm] = useState(usuario ? {
    nome: usuario.nome, access_level_id: usuario.access_level_id, permissoes_extra: usuario.permissoes_extra, location_id: usuario.location_id || '',
  } : { nome: '', email: '', senha: '', confirmarSenha: '', access_level_id: nivelPadrao, permissoes_extra: [], location_id: '' });
  const nivel = niveis.find((n) => n.id === form.access_level_id);
  const doNivel = new Set(nivel ? nivel.permissoes : []);
  const nivelEhAdmin = nivel && nivel.admin;

  function alternarExtra(chave) {
    setForm((f) => ({ ...f, permissoes_extra: f.permissoes_extra.includes(chave) ? f.permissoes_extra.filter((c) => c !== chave) : [...f.permissoes_extra, chave] }));
  }

  async function salvar(e) {
    e.preventDefault();
    // Extras que o novo nivel ja cobre nao precisam ficar salvos.
    const extras = nivelEhAdmin ? [] : form.permissoes_extra.filter((c) => !doNivel.has(c));
    try {
      if (usuario) {
        const mudouNivel = form.access_level_id !== usuario.access_level_id;
        const mudouExtras = JSON.stringify([...extras].sort()) !== JSON.stringify([...usuario.permissoes_extra].sort());
        const mudouLoja = (form.location_id || null) !== (usuario.location_id || null);
        if ((mudouNivel || mudouExtras || mudouLoja) && !(await confirmar({
          titulo: 'Confirmar mudança de acesso?',
          mensagem: `${usuario.nome} passa a ter o nível "${nivel ? nivel.nome : ''}"${extras.length ? ` com ${extras.length} permissão(ões) extra` : ''}${form.location_id ? ', restrito a uma loja' : ', em todas as lojas'}. Vale imediatamente.`,
          confirmar: 'Confirmar',
        }))) return;
        await api.patch(`/users/${usuario.id}`, { nome: form.nome, access_level_id: form.access_level_id, permissoes_extra: extras, location_id: form.location_id || null });
        toast.sucesso('Usuário atualizado.');
      } else {
        if (form.senha !== form.confirmarSenha) { toast.erro('As senhas não conferem.'); return; }
        if (nivelEhAdmin && !(await confirmar({ titulo: 'Criar um Administrador?', mensagem: 'Administradores têm acesso total ao sistema, inclusive usuários e níveis.', confirmar: 'Criar administrador' }))) return;
        await api.post('/users', {
          nome: form.nome, email: form.email, senha: form.senha, access_level_id: form.access_level_id,
          permissoes_extra: extras, location_id: form.location_id || null,
        });
        toast.sucesso('Usuário cadastrado.');
      }
      onSalvo();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={usuario ? `Editar ${usuario.nome}` : 'Novo usuário'} subtitulo={usuario ? usuario.email : undefined} onClose={onClose} largura="extra">
      <form onSubmit={salvar} className="form-stack">
        <div className="form-grid">
          <Field label="Nome *"><input autoFocus value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required minLength={2} /></Field>
          {!usuario && <Field label="E-mail (login) *"><input type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>}
        </div>
        <div className="form-grid">
          <Field label="Nível de acesso *" hint={nivel ? (nivel.admin ? 'Acesso total ao sistema.' : `${nivel.permissoes.length} permissão(ões) neste nível.`) : undefined}>
            <select value={form.access_level_id} onChange={(e) => setForm({ ...form, access_level_id: e.target.value })} required>
              {niveisPermitidos.map((n) => <option key={n.id} value={n.id}>{n.nome}</option>)}
              {usuario && !niveisPermitidos.some((n) => n.id === usuario.access_level_id) && <option value={usuario.access_level_id} disabled>{usuario.nivel}</option>}
            </select>
          </Field>
          <Field label="Loja de atuação" hint="Com uma loja, o usuário só vende, movimenta estoque e vê relatórios dela.">
            <select value={form.location_id || ''} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>
              <option value="">Todas as lojas</option>
              {locations.filter((l) => l.ativo || l.id === form.location_id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
        </div>

        {!nivelEhAdmin && (
          <div className="detail-section">
            <span className="detail-section-title">Permissões deste usuário</span>
            <span className="form-hint">As marcadas e travadas vêm do nível. Marque outras para liberar só para esta pessoa.</span>
            <MatrizPermissoes catalogo={catalogo} marcadas={new Set([...doNivel, ...form.permissoes_extra])} travadas={doNivel}
              desabilitar={(c) => !podeConceder(eu, [c])} onAlternar={alternarExtra} />
          </div>
        )}

        {!usuario && (
          <div className="form-grid">
            <Field label="Senha *" hint="Mínimo de 6 caracteres"><input type="password" autoComplete="new-password" minLength={6} value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} required /></Field>
            <Field label="Confirmar senha *"><input type="password" autoComplete="new-password" value={form.confirmarSenha} onChange={(e) => setForm({ ...form, confirmarSenha: e.target.value })} required /></Field>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">{usuario ? 'Salvar' : 'Cadastrar'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Lista de permissoes agrupadas com caixas de selecao.
function MatrizPermissoes({ catalogo, marcadas, travadas = new Set(), desabilitar = () => false, onAlternar }) {
  return (
    <div className="matriz-permissoes">
      {agrupar(catalogo).map(([grupo, itens]) => (
        <div key={grupo} className="matriz-grupo">
          <span className="matriz-titulo">{grupo}</span>
          {itens.map((p) => {
            const travada = travadas.has(p.chave);
            const off = travada || desabilitar(p.chave);
            return (
              <label key={p.chave} className={`check-permissao ${off ? 'off' : ''}`} title={travada ? 'Vem do nível de acesso' : (desabilitar(p.chave) ? 'Você não tem esta permissão para conceder' : '')}>
                <input type="checkbox" checked={marcadas.has(p.chave)} disabled={off} onChange={() => onAlternar(p.chave)} />
                <span>{p.descricao}{travada ? <span className="muted"> · do nível</span> : ''}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
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

// ======================= Niveis de acesso =======================

function AbaNiveis({ eu, niveis, catalogo, reload }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [editando, setEditando] = useState(null); // null | 'novo' | nivel
  const euAdmin = !!eu.admin;
  const descricao = useMemo(() => Object.fromEntries(catalogo.map((p) => [p.chave, p.descricao])), [catalogo]);

  async function remover(n) {
    if (!(await confirmar({ titulo: `Remover o nível "${n.nome}"?`, confirmar: 'Remover', perigo: true }))) return;
    try {
      await api.del(`/access-levels/${n.id}`);
      toast.sucesso('Nível removido.');
      reload();
    } catch (err) { toast.erro(err); }
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted">{euAdmin ? 'Crie níveis e escolha o que cada um pode fazer. As mudanças valem na hora para todos os usuários do nível.' : 'Somente um Administrador pode configurar níveis.'}</span>
        <span className="toolbar-espaco" />
        {euAdmin && <button type="button" className="btn-primario" onClick={() => setEditando('novo')}>+ Novo nível</button>}
      </div>
      <div className="niveis-grid">
        {niveis.map((n) => (
          <div key={n.id} className="card nivel-card">
            <div className="nivel-topo">
              <div>
                <h3>{n.nome}</h3>
                <span className="muted">{n.usuarios} usuário(s){n.sistema ? ' · nível padrão' : ' · personalizado'}</span>
              </div>
              {euAdmin && !n.admin && (
                <div className="row-actions">
                  <button className="btn-link" onClick={() => setEditando(n)}>Editar</button>
                  {!n.sistema && <button className="btn-link perigo" disabled={n.usuarios > 0} title={n.usuarios > 0 ? 'Mude os usuários de nível antes' : ''} onClick={() => remover(n)}>Remover</button>}
                </div>
              )}
            </div>
            {n.admin ? <p className="form-hint">Todas as permissões. Não pode ser alterado.</p> : (
              n.permissoes.length === 0 ? <p className="form-hint">Nenhuma permissão.</p> : (
                <ul className="lista-permissoes">
                  {n.permissoes.map((c) => <li key={c}>{descricao[c] || c}</li>)}
                </ul>
              )
            )}
          </div>
        ))}
      </div>
      {editando && (
        <FormNivel nivel={editando === 'novo' ? null : editando} catalogo={catalogo}
          onClose={() => setEditando(null)} onSalvo={() => { setEditando(null); reload(); }} />
      )}
    </>
  );
}

function FormNivel({ nivel, catalogo, onClose, onSalvo }) {
  const toast = useToast();
  const [nome, setNome] = useState(nivel ? nivel.nome : '');
  const [marcadas, setMarcadas] = useState(new Set(nivel ? nivel.permissoes : []));

  function alternar(chave) {
    setMarcadas((m) => { const n = new Set(m); if (n.has(chave)) n.delete(chave); else n.add(chave); return n; });
  }

  async function salvar(e) {
    e.preventDefault();
    try {
      const payload = { permissoes: [...marcadas] };
      if (!nivel || !nivel.sistema) payload.nome = nome;
      if (nivel) await api.put(`/access-levels/${nivel.id}`, payload);
      else await api.post('/access-levels', payload);
      toast.sucesso(nivel ? 'Nível atualizado. Vale na hora para os usuários dele.' : 'Nível criado.');
      onSalvo();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo={nivel ? `Editar nível "${nivel.nome}"` : 'Novo nível de acesso'} onClose={onClose} largura="extra">
      <form onSubmit={salvar} className="form-stack">
        <Field label="Nome do nível *" hint={nivel && nivel.sistema ? 'Os níveis padrão não podem ser renomeados.' : 'Ex: Supervisor, Conferente, Caixa sem desconto'}>
          <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} disabled={nivel && nivel.sistema} required minLength={2} />
        </Field>
        <div className="detail-section">
          <span className="detail-section-title">O que este nível pode fazer</span>
          <MatrizPermissoes catalogo={catalogo} marcadas={marcadas} onAlternar={alternar} />
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit">{nivel ? 'Salvar nível' : 'Criar nível'}</button>
        </div>
      </form>
    </Modal>
  );
}
