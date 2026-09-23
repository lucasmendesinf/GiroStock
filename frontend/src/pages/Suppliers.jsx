import { useEffect, useState } from 'react';
import { api } from '../api/client';

const CATEGORIAS = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({ nome: '', documento: '', telefone: '', email: '', categoria: CATEGORIAS[0], prazo_medio_dias: '' });
  const [erro, setErro] = useState(null);

  async function reload() {
    setSuppliers(await api.get('/suppliers'));
  }
  useEffect(() => { reload(); }, []);

  async function criar(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post('/suppliers', {
        ...form,
        prazo_medio_dias: form.prazo_medio_dias ? Number(form.prazo_medio_dias) : null,
      });
      setForm({ nome: '', documento: '', telefone: '', email: '', categoria: CATEGORIAS[0], prazo_medio_dias: '' });
      reload();
    } catch (err) { setErro(err.message); }
  }

  return (
    <div className="page">
      <h2>Fornecedores</h2>
      {erro && <p className="error">{erro}</p>}

      <div className="card">
        <h3>Cadastrar fornecedor</h3>
        <form onSubmit={criar}>
          <input placeholder="Nome" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />
          <input placeholder="CPF (11) ou CNPJ (14) - somente digitos" value={form.documento} onChange={(e) => setForm({ ...form, documento: e.target.value })} required />
          <input placeholder="Telefone (min. 10 digitos)" value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} required />
          <input placeholder="E-mail (opcional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
            {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="number" placeholder="Prazo medio (dias, opcional)" value={form.prazo_medio_dias} onChange={(e) => setForm({ ...form, prazo_medio_dias: e.target.value })} />
          <button type="submit">Cadastrar</button>
        </form>
      </div>

      <div className="card">
        <h3>Fornecedores cadastrados</h3>
        <table>
          <thead><tr><th>Nome</th><th>Documento</th><th>Telefone</th><th>Categoria</th></tr></thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td>{s.nome}</td><td>{s.documento}</td><td>{s.telefone}</td><td>{s.categoria}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
