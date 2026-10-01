import { useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { ordenarCategoriasHierarquia } from './comum.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { pode } from '../../utils/permissions.js';

// Gerenciar categorias e subcategorias (remover so quando nao ha vinculos).
export default function Categorias({ categories, reload, onClose, onCriada }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const podeCriar = pode(user, 'produtos.criar');
  const podeEditar = pode(user, 'produtos.editar');
  const [form, setForm] = useState({ nome: '', parent_id: '' });
  const [renomeando, setRenomeando] = useState({});
  const arvore = ordenarCategoriasHierarquia(categories);

  async function criar(e) {
    e.preventDefault();
    try {
      const nova = await api.post('/categories', { nome: form.nome, parent_id: form.parent_id || null });
      toast.sucesso(`Categoria "${nova.nome}" criada.`);
      setForm({ nome: '', parent_id: '' });
      await reload();
      if (onCriada) onCriada(nova);
    } catch (err) { toast.erro(err); }
  }

  async function renomear(c) {
    const nome = (renomeando[c.id] || '').trim();
    if (!nome) return;
    try {
      await api.patch(`/categories/${c.id}`, { nome });
      toast.sucesso('Categoria renomeada.');
      setRenomeando((r) => ({ ...r, [c.id]: undefined }));
      reload();
    } catch (err) { toast.erro(err); }
  }

  async function remover(c) {
    if (!(await confirmar({ titulo: `Remover a categoria "${c.nome}"?`, confirmar: 'Remover', perigo: true }))) return;
    try {
      await api.del(`/categories/${c.id}`);
      toast.sucesso('Categoria removida.');
      reload();
    } catch (err) { toast.erro(err); }
  }

  return (
    <Modal titulo="Categorias" onClose={onClose} largura="larga">
      {podeCriar && <form onSubmit={criar} className="form-grid">
        <Field label="Nova categoria"><input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Cervejas" required /></Field>
        <Field label="Dentro de (opcional)">
          <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
            <option value="">É uma categoria principal</option>
            {arvore.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>Subcategoria de {c.nome}</option>)}
          </select>
        </Field>
        <button type="submit" className="btn-primario">Criar</button>
      </form>}
      <ul className="lista-simples">
        {arvore.map((c) => {
          const podeRemover = c.produto_count === 0 && c.subcategoria_count === 0;
          return (
            <li key={c.id}>
              {renomeando[c.id] !== undefined ? (
                <span className="row-actions" style={{ paddingLeft: `${c.nivel * 18}px`, alignItems: 'center' }}>
                  <input className="input-curto" style={{ width: '220px' }} autoFocus value={renomeando[c.id]} aria-label="Novo nome"
                    onChange={(e) => setRenomeando({ ...renomeando, [c.id]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); renomear(c); } }} />
                  <button type="button" className="btn-link" onClick={() => renomear(c)}>Salvar</button>
                  <button type="button" className="btn-link" onClick={() => setRenomeando({ ...renomeando, [c.id]: undefined })}>Cancelar</button>
                </span>
              ) : (
                <span style={{ paddingLeft: `${c.nivel * 18}px` }}>{c.nivel > 0 ? '↳ ' : ''}{c.nome}
                  <span className="muted"> · {c.produto_count} produto(s){c.subcategoria_count > 0 ? ` · ${c.subcategoria_count} sub` : ''}</span>
                </span>
              )}
              {podeEditar && renomeando[c.id] === undefined && (
                <span className="row-actions">
                  <button type="button" className="btn-link" onClick={() => setRenomeando({ ...renomeando, [c.id]: c.nome })}>Renomear</button>
                  <button type="button" className="btn-link perigo" disabled={!podeRemover} onClick={() => remover(c)}
                    title={podeRemover ? 'Remover categoria' : 'Só é possível remover categorias sem produtos ou subcategorias'}>Remover</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
