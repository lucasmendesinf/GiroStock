import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function Ingredients() {
  const [ingredients, setIngredients] = useState([]);
  const [form, setForm] = useState({ nome: '', unidade: '', estoque_atual: '0' });
  const [entradas, setEntradas] = useState({});
  const [erro, setErro] = useState(null);
  const [historico, setHistorico] = useState(null);

  async function reload() {
    setIngredients(await api.get('/ingredients'));
  }
  useEffect(() => { reload(); }, []);

  async function criar(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post('/ingredients', { ...form, estoque_atual: Number(form.estoque_atual) });
      setForm({ nome: '', unidade: '', estoque_atual: '0' });
      reload();
    } catch (err) { setErro(err.message); }
  }

  async function lancarEntrada(id) {
    const quantidade = Number(entradas[id]);
    if (!(quantidade > 0)) return;
    try {
      await api.post(`/ingredients/${id}/stock-entries`, { quantidade });
      setEntradas({ ...entradas, [id]: '' });
      reload();
    } catch (err) { setErro(err.message); }
  }

  async function verHistorico(id) {
    const rows = await api.get(`/ingredients/${id}/consumption-history`);
    setHistorico(rows);
  }

  return (
    <div className="page">
      <h2>Insumos (matéria-prima)</h2>
      {erro && <p className="error">{erro}</p>}

      <div className="card">
        <h3>Cadastrar insumo</h3>
        <form onSubmit={criar} className="inline-form">
          <input placeholder="Nome" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />
          <input placeholder="Unidade (G/KG/ML/L/UN)" value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })} required />
          <input type="number" step="0.001" placeholder="Estoque atual" value={form.estoque_atual} onChange={(e) => setForm({ ...form, estoque_atual: e.target.value })} />
          <button type="submit">Cadastrar</button>
        </form>
      </div>

      <div className="card">
        <h3>Insumos cadastrados</h3>
        <table>
          <thead><tr><th>Nome</th><th>Unidade</th><th>Saldo</th><th>Entrada rapida</th><th></th></tr></thead>
          <tbody>
            {ingredients.map((i) => (
              <tr key={i.id}>
                <td>{i.nome}</td>
                <td>{i.unidade}</td>
                <td>{i.estoque_atual}</td>
                <td>
                  <input type="number" step="0.001" style={{ width: '80px' }}
                    value={entradas[i.id] || ''} onChange={(e) => setEntradas({ ...entradas, [i.id]: e.target.value })} />
                  <button onClick={() => lancarEntrada(i.id)}>+</button>
                </td>
                <td><button onClick={() => verHistorico(i.id)}>Historico</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {historico && (
        <div className="modal">
          <div className="modal-content wide">
            <h3>Historico de consumo</h3>
            <table>
              <thead><tr><th>Data</th><th>Produto</th><th>Qtd vendida</th><th>Consumido</th></tr></thead>
              <tbody>
                {historico.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.criado_em).toLocaleString('pt-BR')}</td>
                    <td>{h.product_nome}</td>
                    <td>{h.quantidade_vendida}</td>
                    <td>{h.quantidade_consumida}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions">
              <button onClick={() => setHistorico(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
