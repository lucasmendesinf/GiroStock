import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

const TABS = { CADASTRO: 'cadastro', ESTOQUE: 'estoque', INSUMOS: 'insumos' };
const UNIDADES_PRODUTO = ['UN', 'KG', 'L', 'CX'];
const UNIDADES_INSUMO = ['G', 'KG', 'ML', 'L', 'UN', 'Fatia'];
const TIPO_LABEL = { entrada: 'Entrada', saida: 'Saída', transferencia: 'Transferência' };
const TIPO_COR = { entrada: 'var(--ok)', saida: 'var(--err)', transferencia: 'var(--gold-light)' };

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

const FORM_VAZIO = {
  nome: '', categoria_id: '', supplier_id: '', barcode: '', unidade: 'UN',
  preco_custo: '', preco_venda: '', location_id: '', estoque_inicial: '0',
};

export default function Products() {
  const [tab, setTab] = useState(TABS.CADASTRO);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [movements, setMovements] = useState([]);
  const [consumptionFeed, setConsumptionFeed] = useState([]);
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);

  const reload = useCallback(async () => {
    const [p, c, l, s, i, m, cf] = await Promise.all([
      api.get('/products'), api.get('/categories'), api.get('/locations'), api.get('/suppliers'),
      api.get('/ingredients'), api.get('/stock-movements'), api.get('/consumption-feed'),
    ]);
    setProducts(p); setCategories(c); setLocations(l); setSuppliers(s);
    setIngredients(i); setMovements(m); setConsumptionFeed(cf);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function avisar(msg) { setOk(msg); setErro(null); setTimeout(() => setOk(null), 4000); }
  function falhar(err) { setErro(err.message); setOk(null); }

  const categoriasHierarquia = ordenarCategoriasHierarquia(categories);

  // ---------- ABA: CADASTRAR PRODUTO ----------
  const [form, setForm] = useState(FORM_VAZIO);
  const [fichaNovoProduto, setFichaNovoProduto] = useState([]);
  const [novoFichaItem, setNovoFichaItem] = useState({ ingredient_id: '', quantidade_por_unidade: '' });
  const [novaCategoriaAberta, setNovaCategoriaAberta] = useState(false);
  const [novaCategoria, setNovaCategoria] = useState({ nome: '', parent_id: '' });

  function categoriaSelecionadaEhLanche() {
    const cat = categories.find((c) => c.id === form.categoria_id);
    if (!cat) return false;
    if (cat.nome.toLowerCase().includes('lanche')) return true;
    const pai = categories.find((c) => c.id === cat.parent_id);
    return pai ? pai.nome.toLowerCase().includes('lanche') : false;
  }

  async function criarCategoria(e) {
    e.preventDefault();
    try {
      await api.post('/categories', { nome: novaCategoria.nome, parent_id: novaCategoria.parent_id || null });
      setNovaCategoria({ nome: '', parent_id: '' });
      setNovaCategoriaAberta(false);
      avisar('Categoria criada.');
      reload();
    } catch (err) { falhar(err); }
  }

  async function removerCategoria(categoria) {
    try {
      await api.del(`/categories/${categoria.id}`);
      avisar('Categoria removida.');
      reload();
    } catch (err) { falhar(err); }
  }

  function custoFracionado(ingredientId, quantidade) {
    const ing = ingredients.find((i) => i.id === ingredientId);
    return ing ? Number(ing.custo_unitario) * Number(quantidade) : 0;
  }

  function custoTotalFicha(lista) {
    return lista.reduce((soma, f) => soma + custoFracionado(f.ingredient_id, f.quantidade_por_unidade), 0);
  }

  function adicionarInsumoAoNovoProduto() {
    if (!novoFichaItem.ingredient_id || !(Number(novoFichaItem.quantidade_por_unidade) > 0)) return;
    if (fichaNovoProduto.some((f) => f.ingredient_id === novoFichaItem.ingredient_id)) return;
    const proxima = [...fichaNovoProduto, { ...novoFichaItem, quantidade_por_unidade: Number(novoFichaItem.quantidade_por_unidade) }];
    setFichaNovoProduto(proxima);
    setForm((prev) => ({ ...prev, preco_custo: custoTotalFicha(proxima).toFixed(2) }));
    setNovoFichaItem({ ingredient_id: '', quantidade_por_unidade: '' });
  }

  function removerInsumoDoNovoProduto(ingredientId) {
    const proxima = fichaNovoProduto.filter((f) => f.ingredient_id !== ingredientId);
    setFichaNovoProduto(proxima);
    setForm((prev) => ({ ...prev, preco_custo: proxima.length > 0 ? custoTotalFicha(proxima).toFixed(2) : prev.preco_custo }));
  }

  async function criarProduto(e) {
    e.preventDefault();
    try {
      await api.post('/products', {
        ...form,
        preco_custo: Number(form.preco_custo),
        preco_venda: Number(form.preco_venda),
        estoque_inicial: Number(form.estoque_inicial),
        ficha_tecnica: fichaNovoProduto,
      });
      avisar('Produto cadastrado com sucesso.');
      setForm(FORM_VAZIO);
      setFichaNovoProduto([]);
      reload();
    } catch (err) { falhar(err); }
  }

  // ---------- ABA: ESTOQUE & MOVIMENTAÇÕES ----------
  const [moveForm, setMoveForm] = useState({ tipo: 'entrada', product_id: '', quantidade: '', location_origem_id: '', location_destino_id: '', motivo: '' });

  async function registrarMovimento(e) {
    e.preventDefault();
    try {
      const payload = { product_id: moveForm.product_id, tipo: moveForm.tipo, quantidade: Number(moveForm.quantidade), motivo: moveForm.motivo };
      if (moveForm.tipo !== 'entrada') payload.location_origem_id = moveForm.location_origem_id;
      if (moveForm.tipo !== 'saida') payload.location_destino_id = moveForm.location_destino_id;
      await api.post('/stock-movements', payload);
      avisar('Movimentação registrada.');
      setMoveForm({ tipo: moveForm.tipo, product_id: '', quantidade: '', location_origem_id: '', location_destino_id: '', motivo: '' });
      reload();
    } catch (err) { falhar(err); }
  }

  // ---------- ABA: INSUMOS ----------
  const [insumoForm, setInsumoForm] = useState({ nome: '', unidade: 'G', estoque_atual: '0', custo_total: '' });
  const [quickQty, setQuickQty] = useState({});
  const [quickCusto, setQuickCusto] = useState({});

  async function criarInsumo(e) {
    e.preventDefault();
    try {
      await api.post('/ingredients', {
        ...insumoForm,
        estoque_atual: Number(insumoForm.estoque_atual),
        custo_total: insumoForm.custo_total === '' ? 0 : Number(insumoForm.custo_total),
      });
      avisar('Insumo cadastrado.');
      setInsumoForm({ nome: '', unidade: 'G', estoque_atual: '0', custo_total: '' });
      reload();
    } catch (err) { falhar(err); }
  }

  async function lancarEntradaInsumo(id) {
    const quantidade = Number(quickQty[id]);
    if (!(quantidade > 0)) return;
    try {
      const custoTotal = quickCusto[id];
      const payload = { quantidade };
      if (custoTotal !== undefined && custoTotal !== '') payload.custo_total = Number(custoTotal);
      await api.post(`/ingredients/${id}/stock-entries`, payload);
      setQuickQty({ ...quickQty, [id]: '' });
      setQuickCusto({ ...quickCusto, [id]: '' });
      avisar('Estoque de insumo atualizado.');
      reload();
    } catch (err) { falhar(err); }
  }

  const [ajusteAberto, setAjusteAberto] = useState({});
  const [ajusteTipo, setAjusteTipo] = useState({});
  const [ajusteValor, setAjusteValor] = useState({});
  const [ajusteCusto, setAjusteCusto] = useState({});
  const [ajusteMotivo, setAjusteMotivo] = useState({});

  function abrirAjuste(id, tipo, valorInicial, custoInicial) {
    setAjusteAberto({ ...ajusteAberto, [id]: true });
    setAjusteTipo({ ...ajusteTipo, [id]: tipo });
    setAjusteValor({ ...ajusteValor, [id]: valorInicial ?? '' });
    setAjusteCusto({ ...ajusteCusto, [id]: custoInicial ?? '' });
    setAjusteMotivo({ ...ajusteMotivo, [id]: '' });
  }

  function fecharAjuste(id) {
    setAjusteAberto({ ...ajusteAberto, [id]: false });
  }

  async function confirmarAjusteInsumo(id) {
    const tipo = ajusteTipo[id];
    const motivo = (ajusteMotivo[id] || '').trim();
    if (motivo.length < 3) { setErro('Informe o motivo (minimo 3 caracteres).'); return; }
    try {
      if (tipo === 'saida') {
        const quantidade = Number(ajusteValor[id]);
        if (!(quantidade > 0)) { setErro('Informe uma quantidade valida (maior que zero).'); return; }
        await api.post(`/ingredients/${id}/stock-exits`, { quantidade, motivo });
        avisar('Saida de insumo registrada.');
      } else {
        const novoSaldo = Number(ajusteValor[id]);
        if (isNaN(novoSaldo) || novoSaldo < 0) { setErro('Informe um saldo valido (0 ou mais).'); return; }
        const payload = { novo_saldo: novoSaldo, motivo };
        const custoInformado = ajusteCusto[id];
        if (custoInformado !== undefined && custoInformado !== '') {
          const novoCusto = Number(custoInformado);
          if (isNaN(novoCusto) || novoCusto < 0) { setErro('Informe um custo por unidade valido (0 ou mais).'); return; }
          payload.novo_custo_unitario = novoCusto;
        }
        await api.post(`/ingredients/${id}/stock-adjustment`, payload);
        avisar('Balanco de estoque registrado.');
      }
      fecharAjuste(id);
      reload();
    } catch (err) { falhar(err); }
  }

  // ---------- DETALHE DO PRODUTO ----------
  const [detalhe, setDetalhe] = useState(null);
  const [fichaForm, setFichaForm] = useState({ ingredient_id: '', quantidade_por_unidade: '' });
  const [addStockForm, setAddStockForm] = useState({ quantidade: '', location_id: '', motivo: '' });

  async function abrirDetalhe(id) {
    const d = await api.get(`/products/${id}`);
    setDetalhe(d);
    setFichaForm({ ingredient_id: '', quantidade_por_unidade: '' });
    setAddStockForm({ quantidade: '', location_id: '', motivo: '' });
  }

  async function adicionarEstoqueDetalhe(e) {
    e.preventDefault();
    try {
      await api.post('/stock-movements', {
        product_id: detalhe.id,
        tipo: 'entrada',
        quantidade: Number(addStockForm.quantidade),
        location_destino_id: addStockForm.location_id,
        motivo: addStockForm.motivo,
      });
      avisar('Estoque adicionado.');
      setAddStockForm({ quantidade: '', location_id: '', motivo: '' });
      abrirDetalhe(detalhe.id);
      reload();
    } catch (err) { falhar(err); }
  }

  async function adicionarIngrediente(e) {
    e.preventDefault();
    try {
      await api.post(`/products/${detalhe.id}/ingredients`, {
        ingredient_id: fichaForm.ingredient_id,
        quantidade_por_unidade: Number(fichaForm.quantidade_por_unidade),
      });
      setFichaForm({ ingredient_id: '', quantidade_por_unidade: '' });
      abrirDetalhe(detalhe.id);
      reload();
    } catch (err) { falhar(err); }
  }

  async function removerIngrediente(ingredientId) {
    await api.del(`/products/${detalhe.id}/ingredients/${ingredientId}`);
    abrirDetalhe(detalhe.id);
    reload();
  }

  function saldoPorLocal(product, locationId) {
    const item = (product.saldos_por_local || []).find((s) => s.location_id === locationId);
    return item ? Number(item.saldo) : 0;
  }

  return (
    <div className="page">
      <h2>Produtos &amp; Estoque</h2>

      <div className="pe-tabs">
        <button className={`pe-tab ${tab === TABS.CADASTRO ? 'active' : ''}`} onClick={() => setTab(TABS.CADASTRO)}>Cadastrar Produto</button>
        <button className={`pe-tab ${tab === TABS.ESTOQUE ? 'active' : ''}`} onClick={() => setTab(TABS.ESTOQUE)}>Estoque &amp; Movimentações</button>
        <button className={`pe-tab ${tab === TABS.INSUMOS ? 'active' : ''}`} onClick={() => setTab(TABS.INSUMOS)}>Insumos (Matéria-prima)</button>
      </div>

      <div className="pe-tabpanel">
        {erro && <p className="error">{erro}</p>}
        {ok && <p className="toast-ok">{ok}</p>}

        {tab === TABS.CADASTRO && (
          <div className="pe-layout">
            <div className="pe-sidebar card">
              <span style={{ fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>
                Novo produto — PRD-{String(products.length + 1).padStart(4, '0')}
              </span>
              <form onSubmit={criarProduto} style={{ marginTop: '12px' }}>
                <input placeholder="Nome do produto *" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required />

                <div style={{ display: 'flex', gap: '10px' }}>
                  <select style={{ flexGrow: 1, minWidth: 0 }} value={form.categoria_id} onChange={(e) => setForm({ ...form, categoria_id: e.target.value })} required>
                    <option value="">Categoria *</option>
                    {categoriasHierarquia.map((c) => (
                      <option key={c.id} value={c.id}>{'— '.repeat(c.nivel)}{c.nome}</option>
                    ))}
                  </select>
                  <select style={{ width: '90px' }} value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value })}>
                    {UNIDADES_PRODUTO.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <button type="button" onClick={() => setNovaCategoriaAberta(!novaCategoriaAberta)} style={{ background: 'none', border: 'none', color: 'var(--gold-light)', fontSize: '12px', padding: 0, textAlign: 'left', textTransform: 'none', letterSpacing: 0 }}>
                  {novaCategoriaAberta ? 'cancelar' : '+ nova categoria / subcategoria'}
                </button>
                {novaCategoriaAberta && (
                  <>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <input style={{ flex: 1, minWidth: '120px' }} placeholder="Nome" value={novaCategoria.nome} onChange={(e) => setNovaCategoria({ ...novaCategoria, nome: e.target.value })} />
                      <select style={{ flex: 1, minWidth: '140px' }} value={novaCategoria.parent_id} onChange={(e) => setNovaCategoria({ ...novaCategoria, parent_id: e.target.value })}>
                        <option value="">Sem pai</option>
                        {categoriasHierarquia.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>Sub de: {c.nome}</option>)}
                      </select>
                      <button type="button" onClick={criarCategoria}>Criar</button>
                    </div>
                    <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0' }}>
                      {categoriasHierarquia.map((c) => {
                        const podeRemover = c.produto_count === 0 && c.subcategoria_count === 0;
                        return (
                          <li key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: '12px', borderBottom: '1px solid var(--line)' }}>
                            <span>{'— '.repeat(c.nivel)}{c.nome}
                              {(c.produto_count > 0 || c.subcategoria_count > 0) && (
                                <span style={{ color: 'var(--muted)' }}> ({c.produto_count} produto(s){c.subcategoria_count > 0 ? `, ${c.subcategoria_count} subcategoria(s)` : ''})</span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => removerCategoria(c)}
                              disabled={!podeRemover}
                              title={podeRemover ? 'Remover categoria' : 'Só é possível remover categorias sem produtos ou subcategorias vinculadas'}
                              style={{ background: 'none', border: 'none', color: podeRemover ? 'var(--err)' : 'var(--muted)', cursor: podeRemover ? 'pointer' : 'not-allowed', fontSize: '11px', opacity: podeRemover ? 1 : 0.5 }}
                            >
                              remover
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
                  <option value="">Fornecedor (opcional)</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                </select>

                <input placeholder="Código de barras / EAN *" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} required />

                <div className="form-row">
                  <input type="number" step="0.01" placeholder="Preço de custo *" value={form.preco_custo} onChange={(e) => setForm({ ...form, preco_custo: e.target.value })} required />
                  <input type="number" step="0.01" placeholder="Preço de venda *" value={form.preco_venda} onChange={(e) => setForm({ ...form, preco_venda: e.target.value })} required />
                </div>

                {fichaNovoProduto.length === 0 && (
                  <div className="form-row">
                    <input type="number" step="0.001" placeholder="Estoque inicial *" value={form.estoque_inicial} onChange={(e) => setForm({ ...form, estoque_inicial: e.target.value })} />
                    <select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })} required={fichaNovoProduto.length === 0}>
                      <option value="">Local do estoque *</option>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                    </select>
                  </div>
                )}

                <button type="submit">Salvar produto</button>
              </form>

              <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--line)' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ivory)' }}>Insumos do lanche (ficha técnica)</span>
                <p style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {categoriaSelecionadaEhLanche()
                    ? 'Categoria de lanche selecionada: informe os insumos que compõem este item. O estoque de cada insumo é debitado fracionado a cada venda, e a venda é bloqueada se qualquer insumo faltar — sem precisar de estoque próprio.'
                    : 'Opcional: vincule insumos consumidos (fracionados) a cada unidade vendida.'}
                </p>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
                  {fichaNovoProduto.map((f) => {
                    const ing = ingredients.find((i) => i.id === f.ingredient_id);
                    return (
                      <li key={f.ingredient_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: '13px' }}>
                        <span>{ing ? ing.nome : f.ingredient_id}: {f.quantidade_por_unidade}{ing ? ing.unidade : ''}</span>
                        <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                          <span style={{ color: 'var(--gold-light)' }}>R$ {custoFracionado(f.ingredient_id, f.quantidade_por_unidade).toFixed(2)}</span>
                          <button type="button" onClick={() => removerInsumoDoNovoProduto(f.ingredient_id)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>remover</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {fichaNovoProduto.length > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700, padding: '4px 0 12px' }}>
                    <span>Custo dos insumos (somado ao Preço de custo)</span>
                    <span style={{ color: 'var(--gold-light)' }}>R$ {custoTotalFicha(fichaNovoProduto).toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <select style={{ flexGrow: 1, minWidth: 0, maxWidth: '100%' }} value={novoFichaItem.ingredient_id} onChange={(e) => setNovoFichaItem({ ...novoFichaItem, ingredient_id: e.target.value })}>
                    <option value="">Insumo...</option>
                    {ingredients.map((i) => <option key={i.id} value={i.id}>{i.nome} (saldo: {i.estoque_atual}{i.unidade} · R$ {Number(i.custo_unitario).toFixed(4)}/{i.unidade})</option>)}
                  </select>
                  <input style={{ width: '90px' }} type="number" step="0.001" placeholder="Qtd/un" value={novoFichaItem.quantidade_por_unidade} onChange={(e) => setNovoFichaItem({ ...novoFichaItem, quantidade_por_unidade: e.target.value })} />
                  <button type="button" onClick={adicionarInsumoAoNovoProduto}>+ Insumo</button>
                </div>
              </div>
            </div>

            <div className="pe-main">
              <div className="pe-list-header">
                <h2>Produtos cadastrados</h2>
                <span>{products.length} produtos</span>
              </div>

              {products.map((p) => (
                <div className="product-card" key={p.id}>
                  <div className="product-card-top">
                    <div>
                      <span className="nome">{p.nome}</span>
                      <div className="meta">{p.codigo_interno} • {p.categoria_nome || '—'} • {p.supplier_nome || 'sem fornecedor'} • EAN {p.barcode}</div>
                    </div>
                    <div className="preco">
                      <div className="venda">R$ {Number(p.preco_venda).toFixed(2)}</div>
                      <div className="custo">custo R$ {Number(p.preco_custo).toFixed(2)}</div>
                    </div>
                  </div>
                  <div className="product-card-badges">
                    {p.tem_ficha_tecnica ? (
                      <span className="badge-total">controlado por insumos</span>
                    ) : (
                      <>
                        {locations.map((l) => (
                          <span className="badge-local" key={l.id}>{l.nome}: {saldoPorLocal(p, l.id)}</span>
                        ))}
                        <span className="badge-total">Total: {p.saldo_total}</span>
                      </>
                    )}
                  </div>
                  <div className="product-card-footer">
                    <button className="pe-detail-btn" onClick={() => abrirDetalhe(p.id)}>Ver detalhes • {p.insumo_count} insumos</button>
                  </div>
                </div>
              ))}

              {products.length === 0 && <div className="empty-state">Nenhum produto cadastrado ainda.</div>}
            </div>
          </div>
        )}

        {tab === TABS.ESTOQUE && (
          <div>
            <div className="card">
              <div className="pe-mov-types">
                {['entrada', 'saida', 'transferencia'].map((t) => (
                  <button key={t} type="button" className={`pe-mov-type-btn ${moveForm.tipo === t ? 'active' : ''}`}
                    onClick={() => setMoveForm({ ...moveForm, tipo: t })}>
                    {TIPO_LABEL[t]}
                  </button>
                ))}
              </div>
              <form onSubmit={registrarMovimento} className="inline-form">
                <select style={{ minWidth: '240px' }} value={moveForm.product_id} onChange={(e) => setMoveForm({ ...moveForm, product_id: e.target.value })} required>
                  <option value="">Produto *</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
                <input style={{ width: '110px' }} type="number" step="0.001" placeholder="Quantidade *" value={moveForm.quantidade} onChange={(e) => setMoveForm({ ...moveForm, quantidade: e.target.value })} required />
                {moveForm.tipo !== 'entrada' && (
                  <select value={moveForm.location_origem_id} onChange={(e) => setMoveForm({ ...moveForm, location_origem_id: e.target.value })} required>
                    <option value="">{moveForm.tipo === 'transferencia' ? 'Local de origem *' : 'Local *'}</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                )}
                {moveForm.tipo !== 'saida' && (
                  <select value={moveForm.location_destino_id} onChange={(e) => setMoveForm({ ...moveForm, location_destino_id: e.target.value })} required>
                    <option value="">{moveForm.tipo === 'transferencia' ? 'Local de destino *' : 'Local *'}</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                )}
                <input style={{ minWidth: '220px', flexGrow: 1 }} placeholder="Motivo *" value={moveForm.motivo} onChange={(e) => setMoveForm({ ...moveForm, motivo: e.target.value })} required />
                <button type="submit">Registrar</button>
              </form>
            </div>

            <div className="pe-layout">
              <div className="pe-main">
                <h2 style={{ fontSize: '16px', marginBottom: '14px' }}>Saldo por local</h2>
                <div className="saldo-table" style={{ '--n-locations': locations.length }}>
                  <div className="saldo-row header">
                    <span>Produto</span>
                    {locations.map((l) => <span key={l.id}>{l.nome}</span>)}
                    <span>Total</span><span></span>
                  </div>
                  {products.map((p) => (
                    <div className="saldo-row" key={p.id}>
                      <span style={{ fontWeight: 600 }}>{p.nome}</span>
                      {locations.map((l) => <span key={l.id}>{p.tem_ficha_tecnica ? '—' : saldoPorLocal(p, l.id)}</span>)}
                      <span className="total">{p.tem_ficha_tecnica ? '—' : p.saldo_total}</span>
                      <button className="pe-detail-btn" onClick={() => abrirDetalhe(p.id)}>Detalhes</button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pe-sidebar">
                <h2 style={{ fontSize: '16px', marginBottom: '14px' }}>Histórico de movimentações</h2>
                {movements.map((m) => (
                  <div className="mov-card" key={m.id}>
                    <div className="cabecalho">
                      <span className="tipo" style={{ color: TIPO_COR[m.tipo] }}>{TIPO_LABEL[m.tipo]}</span>
                      <span className="qtd">Qtd {m.quantidade}</span>
                    </div>
                    <span className="produto">{m.product_nome}</span>
                    <span className="locais">
                      {m.location_origem_nome ? `De: ${m.location_origem_nome}` : ''}
                      {m.location_origem_nome && m.location_destino_nome ? ' → ' : ''}
                      {m.location_destino_nome ? `${m.location_origem_nome ? '' : 'Para: '}${m.location_destino_nome}` : ''}
                    </span>
                    <span className="motivo">{m.motivo}</span>
                  </div>
                ))}
                {movements.length === 0 && <div className="empty-state">Nenhuma movimentação registrada.</div>}
              </div>
            </div>
          </div>
        )}

        {tab === TABS.INSUMOS && (
          <div className="pe-layout">
            <div className="pe-sidebar card">
              <span style={{ fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Novo insumo (matéria-prima)</span>
              <form onSubmit={criarInsumo} style={{ marginTop: '12px' }}>
                <input placeholder="Nome do insumo *" value={insumoForm.nome} onChange={(e) => setInsumoForm({ ...insumoForm, nome: e.target.value })} required />
                <div className="form-row">
                  <select style={{ width: '110px' }} value={insumoForm.unidade} onChange={(e) => setInsumoForm({ ...insumoForm, unidade: e.target.value })}>
                    {UNIDADES_INSUMO.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <input style={{ flexGrow: 1, minWidth: 0 }} type="number" step="0.001" placeholder="Estoque atual *" value={insumoForm.estoque_atual} onChange={(e) => setInsumoForm({ ...insumoForm, estoque_atual: e.target.value })} />
                </div>
                <input type="number" step="0.01" placeholder="Custo total desta compra (R$, opcional)" value={insumoForm.custo_total} onChange={(e) => setInsumoForm({ ...insumoForm, custo_total: e.target.value })} />
                <button type="submit">Cadastrar insumo</button>
              </form>
              <p style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6, marginTop: '10px' }}>
                Informe o custo total pago pela quantidade cadastrada (ex: R$ 50,00 por 1kg de queijo) para o sistema calcular o custo por unidade — usado para somar automaticamente o custo dos insumos no cadastro de produtos com ficha técnica. Ao vincular um insumo à ficha técnica, a venda do produto baixa automaticamente a quantidade correspondente aqui.
              </p>
            </div>

            <div className="pe-main">
              <h2 style={{ fontSize: '18px', marginBottom: '14px' }}>Estoque de insumos</h2>
              {ingredients.map((i) => (
                <div className="insumo-card" key={i.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                    <div>
                      <span className="nome">{i.nome}</span>
                      <div className="saldo">Saldo atual: {i.estoque_atual} {i.unidade} · custo R$ {Number(i.custo_unitario).toFixed(4)}/{i.unidade}</div>
                    </div>
                    <div className="acoes">
                      <input type="number" step="0.001" placeholder="Qtd" value={quickQty[i.id] || ''} onChange={(e) => setQuickQty({ ...quickQty, [i.id]: e.target.value })} />
                      <input type="number" step="0.01" placeholder="Custo R$" value={quickCusto[i.id] || ''} onChange={(e) => setQuickCusto({ ...quickCusto, [i.id]: e.target.value })} />
                      <button onClick={() => lancarEntradaInsumo(i.id)}>+ estoque</button>
                      <button onClick={() => abrirAjuste(i.id, 'saida', '')} style={{ padding: '9px 14px', borderRadius: '8px', border: '1px solid var(--line)', background: 'none', color: 'var(--ivory)', fontSize: '12px', fontWeight: 700 }}>Saída</button>
                      <button onClick={() => abrirAjuste(i.id, 'balanco', String(i.estoque_atual), String(i.custo_unitario))} style={{ padding: '9px 14px', borderRadius: '8px', border: '1px solid var(--line)', background: 'none', color: 'var(--ivory)', fontSize: '12px', fontWeight: 700 }}>Balanço</button>
                      <button onClick={() => abrirAjuste(i.id, 'balanco', '0', String(i.custo_unitario))} style={{ padding: '9px 14px', borderRadius: '8px', border: '1px solid var(--err)', background: 'none', color: 'var(--err)', fontSize: '12px', fontWeight: 700 }}>Zerar</button>
                    </div>
                  </div>

                  {ajusteAberto[i.id] && (
                    <div style={{ background: 'var(--panel-alt)', border: '1px solid var(--line)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => setAjusteTipo({ ...ajusteTipo, [i.id]: 'saida' })}
                          style={{ padding: '8px 16px', borderRadius: '999px', border: `1.5px solid ${ajusteTipo[i.id] === 'saida' ? 'var(--gold-light)' : 'var(--line)'}`, background: ajusteTipo[i.id] === 'saida' ? 'rgba(205,164,63,0.14)' : 'none', color: ajusteTipo[i.id] === 'saida' ? 'var(--gold-light)' : 'var(--ivory)', fontSize: '12px', fontWeight: 700 }}
                        >Saída (baixa manual)</button>
                        <button
                          onClick={() => setAjusteTipo({ ...ajusteTipo, [i.id]: 'balanco' })}
                          style={{ padding: '8px 16px', borderRadius: '999px', border: `1.5px solid ${ajusteTipo[i.id] === 'balanco' ? 'var(--gold-light)' : 'var(--line)'}`, background: ajusteTipo[i.id] === 'balanco' ? 'rgba(205,164,63,0.14)' : 'none', color: ajusteTipo[i.id] === 'balanco' ? 'var(--gold-light)' : 'var(--ivory)', fontSize: '12px', fontWeight: 700 }}
                        >Balanço (corrigir/zerar)</button>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          style={{ width: '120px' }}
                          type="number" step="0.001"
                          placeholder={ajusteTipo[i.id] === 'saida' ? 'Quantidade a retirar' : 'Novo saldo'}
                          value={ajusteValor[i.id] ?? ''}
                          onChange={(e) => setAjusteValor({ ...ajusteValor, [i.id]: e.target.value })}
                        />
                        {ajusteTipo[i.id] === 'balanco' && (
                          <input
                            style={{ width: '140px' }}
                            type="number" step="0.0001"
                            placeholder="Novo custo/un (R$)"
                            value={ajusteCusto[i.id] ?? ''}
                            onChange={(e) => setAjusteCusto({ ...ajusteCusto, [i.id]: e.target.value })}
                          />
                        )}
                        <input
                          style={{ flexGrow: 1, minWidth: '160px' }}
                          placeholder="Motivo * (ex: perda, validade vencida, contagem de estoque...)"
                          value={ajusteMotivo[i.id] || ''}
                          onChange={(e) => setAjusteMotivo({ ...ajusteMotivo, [i.id]: e.target.value })}
                        />
                        <button onClick={() => confirmarAjusteInsumo(i.id)}>Confirmar</button>
                        <button type="button" onClick={() => fecharAjuste(i.id)} style={{ background: 'none', border: '1px solid var(--line)', color: 'var(--ivory)', borderRadius: '10px', padding: '12px 18px' }}>Cancelar</button>
                      </div>
                      {ajusteTipo[i.id] === 'balanco' && (
                        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                          {ajusteValor[i.id] !== '' && !isNaN(Number(ajusteValor[i.id])) && (
                            <>Diferença de saldo: {(Number(ajusteValor[i.id]) - Number(i.estoque_atual)) >= 0 ? '+' : ''}{(Number(ajusteValor[i.id]) - Number(i.estoque_atual)).toFixed(3)} {i.unidade}</>
                          )}
                          {ajusteCusto[i.id] !== '' && !isNaN(Number(ajusteCusto[i.id])) && Number(ajusteCusto[i.id]) !== Number(i.custo_unitario) && (
                            <> · custo por unidade sera sobrescrito para R$ {Number(ajusteCusto[i.id]).toFixed(4)}/{i.unidade}</>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {ingredients.length === 0 && <div className="empty-state">Nenhum insumo cadastrado ainda.</div>}
            </div>

            <div className="pe-sidebar">
              <h2 style={{ fontSize: '16px', marginBottom: '14px' }}>Consumo por vendas</h2>
              {consumptionFeed.map((c) => (
                <div className="consumo-card" key={c.sale_item_id}>
                  <span className="titulo">{c.quantidade_vendida}x {c.product_nome}</span>
                  <span className="insumos">{c.insumos.map((ins) => `${ins.nome} ${ins.quantidade}${ins.unidade}`).join(', ')}</span>
                </div>
              ))}
              {consumptionFeed.length === 0 && <div className="empty-state">Nenhum consumo registrado ainda.</div>}
            </div>
          </div>
        )}
      </div>

      {detalhe && (
        <div className="modal">
          <div className="modal-content wide">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3>{detalhe.nome}</h3>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{detalhe.codigo_interno}</span>
              </div>
              <button onClick={() => setDetalhe(null)} aria-label="Fechar" style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: '18px', cursor: 'pointer' }}>×</button>
            </div>

            <div className="detail-grid">
              <div><span className="label">EAN</span><span className="valor">{detalhe.barcode}</span></div>
              <div><span className="label">Unidade</span><span className="valor">{detalhe.unidade}</span></div>
              <div><span className="label">Custo</span><span className="valor destaque">R$ {Number(detalhe.preco_custo).toFixed(2)}</span></div>
              <div><span className="label">Venda</span><span className="valor destaque">R$ {Number(detalhe.preco_venda).toFixed(2)}</span></div>
            </div>

            {detalhe.saldos_por_local.length > 0 && (
              <div>
                <span style={{ fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Saldo por local</span>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                  {detalhe.saldos_por_local.map((s) => <span className="badge-local" key={s.location_id}>{s.location_nome}: {s.saldo}</span>)}
                </div>
              </div>
            )}

            {detalhe.saldos_por_local.length > 0 && (
              <div className="detail-section">
                <span className="detail-section-title">Adicionar estoque a este produto</span>
                <form onSubmit={adicionarEstoqueDetalhe} className="inline-form">
                  <input style={{ width: '100px' }} type="number" step="0.001" placeholder="Quantidade *" value={addStockForm.quantidade} onChange={(e) => setAddStockForm({ ...addStockForm, quantidade: e.target.value })} required />
                  <select value={addStockForm.location_id} onChange={(e) => setAddStockForm({ ...addStockForm, location_id: e.target.value })} required>
                    <option value="">Local *</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                  <input style={{ flexGrow: 1, minWidth: '160px' }} placeholder="Motivo *" value={addStockForm.motivo} onChange={(e) => setAddStockForm({ ...addStockForm, motivo: e.target.value })} required />
                  <button type="submit">Adicionar</button>
                </form>
              </div>
            )}

            <div>
              <span className="detail-section-title">Insumos (ficha técnica)</span>
              <div style={{ fontSize: '12px', color: 'var(--muted)', margin: '2px 0 10px' }}>Use para produtos compostos, como lanches e combos.</div>
              {detalhe.ficha_tecnica.length > 0 ? (
                <>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {detalhe.ficha_tecnica.map((f) => (
                      <li key={f.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--panel-alt)', border: '1px solid var(--line)', borderRadius: '10px', marginBottom: '8px', fontSize: '13px' }}>
                        <span>{f.ingredient_nome}</span>
                        <span style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                          <span style={{ color: 'var(--muted)' }}>{f.quantidade_por_unidade} {f.unidade}</span>
                          <span style={{ color: 'var(--gold-light)', fontWeight: 700 }}>R$ {Number(f.custo_fracionado).toFixed(2)}</span>
                          <button onClick={() => removerIngrediente(f.ingredient_id)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>remover</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700, padding: '8px 14px' }}>
                    <span>Custo total dos insumos</span>
                    <span style={{ color: 'var(--gold-light)' }}>R$ {detalhe.ficha_tecnica.reduce((s, f) => s + Number(f.custo_fracionado), 0).toFixed(2)}</span>
                  </div>
                </>
              ) : (
                <div className="empty-state" style={{ border: '1px dashed var(--line)', borderRadius: '10px', background: 'var(--panel-alt)' }}>Nenhum insumo cadastrado para este produto.</div>
              )}
              <form onSubmit={adicionarIngrediente} className="inline-form" style={{ marginTop: '10px' }}>
                <select style={{ flexGrow: 1, minWidth: 0 }} value={fichaForm.ingredient_id} onChange={(e) => setFichaForm({ ...fichaForm, ingredient_id: e.target.value })} required>
                  <option value="">Insumo (do catálogo) *</option>
                  {ingredients.map((i) => <option key={i.id} value={i.id}>{i.nome} ({i.unidade})</option>)}
                </select>
                <input style={{ width: '100px' }} type="number" step="0.001" placeholder="Qtd/un *" value={fichaForm.quantidade_por_unidade} onChange={(e) => setFichaForm({ ...fichaForm, quantidade_por_unidade: e.target.value })} required />
                <button type="submit">+ Adicionar</button>
              </form>
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
