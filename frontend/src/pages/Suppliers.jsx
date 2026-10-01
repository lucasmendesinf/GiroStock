import { useEffect, useState } from 'react';
import { api } from '../api/client';

const CATEGORIAS = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];
const FORM_VAZIO = { nome: '', documento: '', telefone: '', email: '', categoria: CATEGORIAS[0], prazo_medio_dias: '' };

function formatarDocumento(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState(FORM_VAZIO);
  const [editandoId, setEditandoId] = useState(null);
  const [detalhe, setDetalhe] = useState(null);
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);

  async function reload() {
    setSuppliers(await api.get('/suppliers'));
  }
  useEffect(() => { reload(); }, []);

  function avisar(msg) { setOk(msg); setErro(null); setTimeout(() => setOk(null), 4000); }

  async function salvar(e) {
    e.preventDefault();
    setErro(null);
    const payload = {
      ...form,
      prazo_medio_dias: form.prazo_medio_dias === '' ? null : Number(form.prazo_medio_dias),
    };
    try {
      if (editandoId) {
        await api.put(`/suppliers/${editandoId}`, payload);
        avisar('Fornecedor atualizado.');
      } else {
        await api.post('/suppliers', payload);
        avisar('Fornecedor cadastrado.');
      }
      cancelarEdicao();
      reload();
    } catch (err) { setErro(err.message); }
  }

  function editar(s) {
    setEditandoId(s.id);
    setForm({
      nome: s.nome, documento: formatarDocumento(s.documento), telefone: s.telefone || '', email: s.email || '',
      categoria: s.categoria, prazo_medio_dias: s.prazo_medio_dias ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelarEdicao() {
    setEditandoId(null);
    setForm(FORM_VAZIO);
  }

  async function alternarStatus(s) {
    try {
      await api.patch(`/suppliers/${s.id}/status`, { ativo: !s.ativo });
      avisar(s.ativo ? 'Fornecedor desativado.' : 'Fornecedor reativado.');
      reload();
    } catch (err) { setErro(err.message); }
  }

  async function abrirDetalhe(s) {
    try {
      setDetalhe(await api.get(`/suppliers/${s.id}`));
    } catch (err) { setErro(err.message); }
  }

  return (
    <div className="page">
      <h2>Fornecedores</h2>
      {erro && <p className="error">{erro}</p>}
      {ok && <p className="toast-ok">{ok}</p>}

      <div className="card">
        <h3>{editandoId ? 'Editar fornecedor' : 'Cadastrar fornecedor'}</h3>
        <form onSubmit={salvar}>
          <input placeholder="Nome / razão social *" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />
          <input placeholder="CPF ou CNPJ * (pode digitar com pontuação)" value={form.documento} onChange={(e) => setForm({ ...form, documento: e.target.value })} required />
          <input placeholder="Telefone * (mín. 10 dígitos)" value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} required />
          <input placeholder="E-mail (opcional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
            {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="number" min="0" step="1" placeholder="Prazo médio de pagamento (dias, opcional)" value={form.prazo_medio_dias} onChange={(e) => setForm({ ...form, prazo_medio_dias: e.target.value })} />
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="submit">{editandoId ? 'Salvar alterações' : 'Cadastrar'}</button>
            {editandoId && <button type="button" className="btn-link" onClick={cancelarEdicao}>Cancelar</button>}
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Fornecedores cadastrados</h3>
        <table>
          <thead><tr><th>Nome</th><th>Documento</th><th>Telefone</th><th>Categoria</th><th>Produtos</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id} className={s.ativo ? '' : 'row-inativa'}>
                <td>{s.nome}</td>
                <td>{formatarDocumento(s.documento)}</td>
                <td>{s.telefone}</td>
                <td>{s.categoria}</td>
                <td>{s.produto_count}</td>
                <td>{s.ativo ? 'Ativo' : <span className="badge-inativo">Inativo</span>}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn-link" onClick={() => abrirDetalhe(s)}>Produtos e compras</button>
                    <button className="btn-link" onClick={() => editar(s)}>Editar</button>
                    <button className={`btn-link ${s.ativo ? 'perigo' : ''}`} onClick={() => alternarStatus(s)}>{s.ativo ? 'Desativar' : 'Reativar'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detalhe && (
        <div className="modal">
          <div className="modal-content wide">
            <h3>{detalhe.nome}</h3>
            <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {formatarDocumento(detalhe.documento)} · {detalhe.categoria}
              {detalhe.prazo_medio_dias !== null ? ` · prazo médio ${detalhe.prazo_medio_dias} dias` : ''}
            </span>

            <div className="detail-section">
              <span className="detail-section-title">Produtos fornecidos ({detalhe.produtos.length})</span>
              {detalhe.produtos.length === 0 && <span className="form-hint">Nenhum produto vinculado.</span>}
              {detalhe.produtos.map((p) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                  <span>{p.codigo_interno} · {p.nome} {p.principal && <span className="chip principal">principal</span>} {!p.ativo && <span className="badge-inativo">inativo</span>}</span>
                  <span style={{ color: 'var(--muted)' }}>custo R$ {Number(p.preco_custo).toFixed(2)}</span>
                </div>
              ))}
            </div>

            <div className="detail-section">
              <span className="detail-section-title">Últimas compras (entradas de estoque)</span>
              {detalhe.entradas.length === 0 && <span className="form-hint">Nenhuma entrada registrada com este fornecedor.</span>}
              {detalhe.entradas.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
                  <span>{new Date(m.criado_em).toLocaleDateString('pt-BR')} · {m.product_nome} · {Number(m.quantidade)} un → {m.location_nome}</span>
                  <span style={{ color: 'var(--muted)' }}>
                    {m.custo_unitario ? `R$ ${Number(m.custo_unitario).toFixed(2)}/un` : 'sem custo'}{m.documento_fiscal ? ` · ${m.documento_fiscal}` : ''}
                  </span>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button onClick={() => setDetalhe(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
