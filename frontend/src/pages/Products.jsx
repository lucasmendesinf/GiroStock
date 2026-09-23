import { useEffect, useState } from 'react';
import { api } from '../api/client';

function ordenarCategoriasHierarquia(categories) {
  const porPai = new Map();
  categories.forEach((c) => {
    const key = c.parent_id || null;
    if (!porPai.has(key)) porPai.set(key, []);
    porPai.get(key).push(c);
  });
  const resultado = [];
  function visitar(parentId, nivel) {
    const filhos = (porPai.get(parentId) || []).sort((a, b) => a.nome.localeCompare(b.nome));
    for (const c of filhos) {
      resultado.push({ ...c, nivel });
      visitar(c.id, nivel + 1);
    }
  }
  visitar(null, 0);
  return resultado;
}

export default function Products() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);

  const [form, setForm] = useState({
    nome: '', categoria_id: '', supplier_id: '', barcode: '', unidade: 'UN',
    preco_custo: '', preco_venda: '', location_id: '', estoque_inicial: '0',
  });
  const [fichaNovoProduto, setFichaNovoProduto] = useState([]);
  const [novoFichaItem, setNovoFichaItem] = useState({ ingredient_id: '', quantidade_por_unidade: '' });

  const [novaCategoria, setNovaCategoria] = useState({ nome: '', parent_id: '' });

  const [movForm, setMovForm] = useState({ product_id: '', tipo: 'entrada', quantidade: '', location_origem_id: '', location_destino_id: '', motivo: '' });

  const [detalhe, setDetalhe] = useState(null);
  const [fichaForm, setFichaForm] = useState({ ingredient_id: '', quantidade_por_unidade: '' });

  async function reload() {
    const [p, c, l, s, i] = await Promise.all([
      api.get('/products'), api.get('/categories'), api.get('/locations'), api.get('/suppliers'), api.get('/ingredients'),
    ]);
    setProducts(p); setCategories(c); setLocations(l); setSuppliers(s); setIngredients(i);
  }

  useEffect(() => { reload(); }, []);

  const categoriasHierarquia = ordenarCategoriasHierarquia(categories);

  function categoriaSelecionadaEhLanche() {
    const cat = categories.find((c) => c.id === form.categoria_id);
    if (!cat) return false;
    if (cat.nome.toLowerCase() === 'lanches') return true;
    const pai = categories.find((c) => c.id === cat.parent_id);
    return pai ? pai.nome.toLowerCase() === 'lanchonete' : false;
  }

  async function criarCategoria(e) {
    e.preventDefault();
    setErro(null); setOk(null);
    try {
      await api.post('/categories', { nome: novaCategoria.nome, parent_id: novaCategoria.parent_id || null });
      setNovaCategoria({ nome: '', parent_id: '' });
      setOk('Categoria criada com sucesso');
      reload();
    } catch (err) {
      setErro(err.message);
    }
  }

  function adicionarInsumoAoNovoProduto() {
    if (!novoFichaItem.ingredient_id || !(Number(novoFichaItem.quantidade_por_unidade) > 0)) return;
    if (fichaNovoProduto.some((f) => f.ingredient_id === novoFichaItem.ingredient_id)) return;
    setFichaNovoProduto([...fichaNovoProduto, { ...novoFichaItem, quantidade_por_unidade: Number(novoFichaItem.quantidade_por_unidade) }]);
    setNovoFichaItem({ ingredient_id: '', quantidade_por_unidade: '' });
  }

  function removerInsumoDoNovoProduto(ingredientId) {
    setFichaNovoProduto(fichaNovoProduto.filter((f) => f.ingredient_id !== ingredientId));
  }

  async function criarProduto(e) {
    e.preventDefault();
    setErro(null); setOk(null);
    try {
      await api.post('/products', {
        ...form,
        preco_custo: Number(form.preco_custo),
        preco_venda: Number(form.preco_venda),
        estoque_inicial: Number(form.estoque_inicial),
        ficha_tecnica: fichaNovoProduto,
      });
      setOk('Produto cadastrado com sucesso');
      setForm({ nome: '', categoria_id: '', supplier_id: '', barcode: '', unidade: 'UN', preco_custo: '', preco_venda: '', location_id: '', estoque_inicial: '0' });
      setFichaNovoProduto([]);
      reload();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function criarMovimento(e) {
    e.preventDefault();
    setErro(null); setOk(null);
    try {
      await api.post('/stock-movements', { ...movForm, quantidade: Number(movForm.quantidade) });
      setOk('Movimentacao registrada');
      setMovForm({ product_id: '', tipo: 'entrada', quantidade: '', location_origem_id: '', location_destino_id: '', motivo: '' });
      reload();
      if (detalhe) abrirDetalhe(detalhe.id);
    } catch (err) {
      setErro(err.message);
    }
  }

  async function abrirDetalhe(id) {
    const d = await api.get(`/products/${id}`);
    setDetalhe(d);
  }

  async function adicionarIngrediente(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post(`/products/${detalhe.id}/ingredients`, {
        ingredient_id: fichaForm.ingredient_id,
        quantidade_por_unidade: Number(fichaForm.quantidade_por_unidade),
      });
      setFichaForm({ ingredient_id: '', quantidade_por_unidade: '' });
      abrirDetalhe(detalhe.id);
    } catch (err) {
      setErro(err.message);
    }
  }

  async function removerIngrediente(ingredientId) {
    await api.del(`/products/${detalhe.id}/ingredients/${ingredientId}`);
    abrirDetalhe(detalhe.id);
  }

  return (
    <div className="page">
      <h2>Produtos &amp; Estoque</h2>
      {erro && <p className="error">{erro}</p>}
      {ok && <p className="success">{ok}</p>}

      <div className="grid-2">
        <div className="card">
          <h3>Nova categoria / subcategoria</h3>
          <form onSubmit={criarCategoria} className="inline-form">
            <input placeholder="Nome (ex: Lanchonete, ou Lanches)" value={novaCategoria.nome} onChange={(e) => setNovaCategoria({ ...novaCategoria, nome: e.target.value })} required />
            <select value={novaCategoria.parent_id} onChange={(e) => setNovaCategoria({ ...novaCategoria, parent_id: e.target.value })}>
              <option value="">Categoria principal (sem pai)</option>
              {categoriasHierarquia.filter((c) => !c.parent_id).map((c) => (
                <option key={c.id} value={c.id}>Subcategoria de: {c.nome}</option>
              ))}
            </select>
            <button type="submit">Criar</button>
          </form>
        </div>

        <div className="card">
          <h3>Movimentacao de estoque</h3>
          <form onSubmit={criarMovimento}>
            <select value={movForm.product_id} onChange={(e) => setMovForm({ ...movForm, product_id: e.target.value })} required>
              <option value="">Produto...</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
            <select value={movForm.tipo} onChange={(e) => setMovForm({ ...movForm, tipo: e.target.value })}>
              <option value="entrada">Entrada</option>
              <option value="saida">Saida</option>
              <option value="transferencia">Transferencia</option>
            </select>
            <input type="number" step="0.001" placeholder="Quantidade" value={movForm.quantidade} onChange={(e) => setMovForm({ ...movForm, quantidade: e.target.value })} required />
            {movForm.tipo !== 'entrada' && (
              <select value={movForm.location_origem_id} onChange={(e) => setMovForm({ ...movForm, location_origem_id: e.target.value })} required>
                <option value="">Local de origem...</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            )}
            {movForm.tipo !== 'saida' && (
              <select value={movForm.location_destino_id} onChange={(e) => setMovForm({ ...movForm, location_destino_id: e.target.value })} required>
                <option value="">Local de destino...</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            )}
            <input placeholder="Motivo" value={movForm.motivo} onChange={(e) => setMovForm({ ...movForm, motivo: e.target.value })} required />
            <button type="submit">Registrar</button>
          </form>
        </div>
      </div>

      <div className="card">
        <h3>Cadastrar produto</h3>
        <div className="grid-2">
          <form onSubmit={criarProduto}>
            <input placeholder="Nome (min. 3 caracteres)" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />
            <select value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })} required>
              <option value="">Categoria...</option>
              {categoriasHierarquia.map((c) => (
                <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>
              ))}
            </select>
            <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">Fornecedor (opcional)...</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
            <input placeholder="Codigo de barras (8-14 digitos)" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} required />
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
              {['UN', 'KG', 'L', 'CX'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <input type="number" step="0.01" placeholder="Preco de custo" value={form.preco_custo} onChange={(e) => setForm({ ...form, preco_custo: e.target.value })} required />
            <input type="number" step="0.01" placeholder="Preco de venda" value={form.preco_venda} onChange={(e) => setForm({ ...form, preco_venda: e.target.value })} required />
            {fichaNovoProduto.length === 0 && (
              <>
                <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })} required={fichaNovoProduto.length === 0}>
                  <option value="">Local do estoque inicial...</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                </select>
                <input type="number" step="0.001" placeholder="Estoque inicial" value={form.estoque_inicial} onChange={(e) => setForm({ ...form, estoque_inicial: e.target.value })} />
              </>
            )}
            {fichaNovoProduto.length > 0 && (
              <p style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Este item tem insumos vinculados: o estoque e controlado pelos insumos (ao lado), sem necessidade de estoque proprio.
              </p>
            )}
            <button type="submit">Cadastrar</button>
          </form>

          <div>
            <h4>Insumos do lanche (ficha tecnica)</h4>
            <p style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 0 }}>
              {categoriaSelecionadaEhLanche()
                ? 'Categoria de lanche selecionada: informe os insumos que compoem este item. Ao vender, o estoque de cada insumo sera debitado fracionado (ex: 150g de um bacon de 1kg), e a venda e bloqueada se qualquer insumo faltar.'
                : 'Opcional para qualquer produto: vincule insumos que sao consumidos (fracionados) a cada unidade vendida.'}
            </p>

            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
              {fichaNovoProduto.map((f) => {
                const ing = ingredients.find((i) => i.id === f.ingredient_id);
                return (
                  <li key={f.ingredient_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>{ing ? ing.nome : f.ingredient_id}: {f.quantidade_por_unidade}{ing ? ing.unidade : ''}</span>
                    <button type="button" onClick={() => removerInsumoDoNovoProduto(f.ingredient_id)}>remover</button>
                  </li>
                );
              })}
              {fichaNovoProduto.length === 0 && <li style={{ color: 'var(--muted)', fontSize: '13px' }}>Nenhum insumo adicionado ainda.</li>}
            </ul>

            <div className="inline-form">
              <select value={novoFichaItem.ingredient_id} onChange={(e) => setNovoFichaItem({ ...novoFichaItem, ingredient_id: e.target.value })}>
                <option value="">Insumo...</option>
                {ingredients.map((i) => <option key={i.id} value={i.id}>{i.nome} (saldo: {i.estoque_atual}{i.unidade})</option>)}
              </select>
              <input type="number" step="0.001" placeholder="Qtd por unidade vendida" value={novoFichaItem.quantidade_por_unidade} onChange={(e) => setNovoFichaItem({ ...novoFichaItem, quantidade_por_unidade: e.target.value })} />
              <button type="button" onClick={adicionarInsumoAoNovoProduto}>Adicionar insumo</button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Produtos cadastrados</h3>
        <table>
          <thead><tr><th>Codigo</th><th>Nome</th><th>Custo</th><th>Venda</th><th>Saldo total</th><th></th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.codigo_interno}</td>
                <td>{p.nome}</td>
                <td>R$ {Number(p.preco_custo).toFixed(2)}</td>
                <td>R$ {Number(p.preco_venda).toFixed(2)}</td>
                <td>{p.tem_ficha_tecnica ? <span className="badge">controlado por insumos</span> : p.saldo_total}</td>
                <td><button onClick={() => abrirDetalhe(p.id)}>Detalhe</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detalhe && (
        <div className="modal">
          <div className="modal-content wide">
            <h3>{detalhe.nome}</h3>
            <h4>Saldo por local</h4>
            <ul>
              {detalhe.saldos_por_local.map((s) => <li key={s.location_id}>{s.location_nome}: {s.saldo}</li>)}
            </ul>

            <h4>Ficha tecnica</h4>
            <ul>
              {detalhe.ficha_tecnica.map((f) => (
                <li key={f.id}>
                  {f.ingredient_nome}: {f.quantidade_por_unidade}{f.unidade}
                  <button onClick={() => removerIngrediente(f.ingredient_id)}>remover</button>
                </li>
              ))}
            </ul>
            <form onSubmit={adicionarIngrediente} className="inline-form">
              <select value={fichaForm.ingredient_id} onChange={(e) => setFichaForm({ ...fichaForm, ingredient_id: e.target.value })} required>
                <option value="">Insumo...</option>
                {ingredients.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
              </select>
              <input type="number" step="0.001" placeholder="Qtd por unidade vendida" value={fichaForm.quantidade_por_unidade} onChange={(e) => setFichaForm({ ...fichaForm, quantidade_por_unidade: e.target.value })} required />
              <button type="submit">Adicionar</button>
            </form>

            <div className="modal-actions">
              <button onClick={() => setDetalhe(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
