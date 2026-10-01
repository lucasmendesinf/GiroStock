import { useState } from 'react';
import { api } from '../../api/client';
import { useToast, useConfirm } from '../../context/UiContext.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { ordenarCategoriasHierarquia } from './comum.jsx';

// Gerenciar categorias e subcategorias (remover so quando nao ha vinculos).
export default function Categorias({ categories, reload, onClose, onCriada }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [form, setForm] = useState({ nome: '', parent_id: '' });
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
      <form onSubmit={criar} className="form-grid">
        <Field label="Nova categoria"><input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Cervejas" required /></Field>
        <Field label="Dentro de (opcional)">
          <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
            <option value="">É uma categoria principal</option>
            {arvore.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>Subcategoria de {c.nome}</option>)}
          </select>
        </Field>
        <button type="submit" className="btn-primario">Criar</button>
      </form>
      <ul className="lista-simples">
        {arvore.map((c) => {
          const podeRemover = c.produto_count === 0 && c.subcategoria_count === 0;
          return (
            <li key={c.id}>
              <span style={{ paddingLeft: `${c.nivel * 18}px` }}>{c.nivel > 0 ? '↳ ' : ''}{c.nome}
                <span className="muted"> · {c.produto_count} produto(s){c.subcategoria_count > 0 ? ` · ${c.subcategoria_count} sub` : ''}</span>
              </span>
              <button type="button" className="btn-link perigo" disabled={!podeRemover} onClick={() => remover(c)}
                title={podeRemover ? 'Remover categoria' : 'Só é possível remover categorias sem produtos ou subcategorias'}>Remover</button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
