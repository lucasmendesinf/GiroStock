import { useMemo, useState } from 'react';
import { brl, qtd } from '../../utils/format';
import { Vazio } from '../../components/ui.jsx';
import FormProduto from './FormProduto.jsx';
import EditarProduto from './EditarProduto.jsx';
import EstoqueProduto from './EstoqueProduto.jsx';
import Categorias from './Categorias.jsx';
import { situacaoProduto, saldoNaLoja, totalDoProduto } from './estoque.js';

const POR_PAGINA = 10;
const CHIPS = [
  ['todos', 'Todos'],
  ['baixo', 'Estoque baixo'],
  ['zerado', 'Sem estoque'],
  ['insumos', 'Controlados por insumos'],
];

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function IconeCaixa() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
}
function IconeLapis() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>;
}
function IconeImagem() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>;
}

export default function ListaProdutos(props) {
  const { products, categories, suppliers, locations, ingredients, carregado, lanchonete = true } = props;
  const [busca, setBusca] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [categoria, setCategoria] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [situacao, setSituacao] = useState('ativos');
  const [soAlerta, setSoAlerta] = useState(false);
  const [chip, setChip] = useState('todos');
  const [visiveis, setVisiveis] = useState(POR_PAGINA);
  const [novo, setNovo] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [estoqueId, setEstoqueId] = useState(null);
  const [categoriasAberto, setCategoriasAberto] = useState(false);

  const locaisAtivos = locations.filter((l) => l.ativo);
  const lojaFiltrada = locaisAtivos.find((l) => l.id === lojaId);
  const insumosPorId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);

  // Categoria escolhida inclui as subcategorias.
  const categoriasFiltro = useMemo(() => {
    if (!categoria) return null;
    const ids = new Set([categoria]);
    let cresceu = true;
    while (cresceu) {
      cresceu = false;
      for (const c of categories) {
        if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); cresceu = true; }
      }
    }
    return ids;
  }, [categoria, categories]);

  const linhas = useMemo(() => {
    const t = normalizar(busca.trim());
    return products
      .map((p) => ({ p, st: situacaoProduto(p, insumosPorId) }))
      .filter(({ p, st }) => {
        if (situacao === 'ativos' && !p.ativo) return false;
        if (situacao === 'inativos' && p.ativo) return false;
        if (categoriasFiltro && !categoriasFiltro.has(p.categoria_id)) return false;
        if (fornecedor && !p.fornecedores.some((f) => f.id === fornecedor)) return false;
        if (soAlerta && !p.saldos_por_local.some((s) => s.abaixo_minimo)) return false;
        if (t && !(normalizar(p.nome).includes(t) || p.barcode.includes(busca.trim()) || normalizar(p.codigo_interno).includes(t))) return false;
        if (chip === 'baixo' && st.cls !== 'warn') return false;
        if (chip === 'zerado' && st.cls !== 'err') return false;
        if (chip === 'insumos' && !p.tem_ficha_tecnica) return false;
        return true;
      });
  }, [products, busca, situacao, categoriasFiltro, fornecedor, soAlerta, chip, insumosPorId]);

  const pagina = linhas.slice(0, visiveis);
  const mudarFiltro = (fn) => (e) => { fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value); setVisiveis(POR_PAGINA); };
  const produtoEstoque = products.find((p) => p.id === estoqueId);

  function abrirEstoque(p) {
    // Produto composto nao tem estoque proprio: a caixa abre a edicao ja na receita.
    if (p.tem_ficha_tecnica || p.e_combo) setEditandoId(p.id); else setEstoqueId(p.id);
  }

  return (
    <>
      <div className="toolbar">
        <input className="toolbar-busca" placeholder="Pesquisar por código, descrição ou EAN" value={busca} onChange={mudarFiltro(setBusca)} aria-label="Buscar produto" />
        <select value={lojaId} onChange={mudarFiltro(setLojaId)} aria-label="Loja">
          <option value="">Todas as lojas</option>
          {locaisAtivos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
        <select value={categoria} onChange={mudarFiltro(setCategoria)} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {categories.slice().sort((a, b) => a.nome.localeCompare(b.nome)).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
        <select value={fornecedor} onChange={mudarFiltro(setFornecedor)} aria-label="Fornecedor">
          <option value="">Todos os fornecedores</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
        </select>
        <select value={situacao} onChange={mudarFiltro(setSituacao)} aria-label="Situação">
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
          <option value="todos">Todos</option>
        </select>
        <label className="check"><input type="checkbox" checked={soAlerta} onChange={mudarFiltro(setSoAlerta)} /> Só abaixo do mínimo</label>
        <span className="toolbar-espaco" />
        <button type="button" className="btn-link" onClick={() => setCategoriasAberto(true)}>Categorias</button>
        <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ Novo produto</button>
      </div>

      <div className="es-chips" role="group" aria-label="Situação do estoque">
        {CHIPS.filter(([id]) => id !== 'insumos' || lanchonete).map(([id, nome]) => (
          <button key={id} type="button" className={`es-chip ${chip === id ? 'on' : ''}`} aria-pressed={chip === id}
            onClick={() => { setChip(id); setVisiveis(POR_PAGINA); }}>{nome}</button>
        ))}
      </div>

      <div className="es-legenda">
        <span><i style={{ background: 'var(--ok)' }} />Estoque ok</span>
        <span><i style={{ background: 'var(--warn)' }} />Estoque baixo (abaixo do mínimo da loja)</span>
        <span><i style={{ background: 'var(--err)' }} />Sem estoque</span>
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table className="es-tabela">
            <thead>
              <tr>
                <th style={{ width: 64 }} />
                <th>Descrição</th>
                <th className="col-opcional">Código</th>
                <th className="col-opcional">Un.</th>
                <th className="num">Preço</th>
                <th className="num">{lojaFiltrada ? `Estoque (${lojaFiltrada.nome})` : 'Estoque (todas as lojas)'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pagina.map(({ p, st }) => {
                const saldo = lojaFiltrada ? saldoNaLoja(p, lojaFiltrada.id) : totalDoProduto(p);
                const tip = p.tem_ficha_tecnica ? 'Controlar insumos' : p.e_combo ? 'Produtos do combo' : 'Tratar estoque';
                return (
                  <tr key={p.id} className={`es-row-${st.cls} ${p.ativo ? '' : 'row-inativa'}`}>
                    <td><div className="es-foto"><IconeImagem /></div></td>
                    <td>
                      <button type="button" className="es-nome" title="Editar produto" onClick={() => setEditandoId(p.id)}>{p.nome}</button>
                      {!p.ativo && <> <span className="badge-inativo">inativo</span></>}
                      <div className="celula-sub">{p.categoria_nome || 'Sem categoria'} · EAN {p.barcode}</div>
                    </td>
                    <td className="col-opcional">{p.codigo_interno}</td>
                    <td className="col-opcional">{p.unidade}</td>
                    <td className="num es-preco">{brl(p.preco_venda)}</td>
                    <td className="num">
                      {p.e_combo
                        ? <span className="es-pill info">combo</span>
                        : p.tem_ficha_tecnica
                        ? <><span className="es-pill info" style={{ marginRight: 6 }}>por insumos</span><span className={`es-pill ${st.cls}`}>{st.txt}</span></>
                        : <><b className="es-qtd">{qtd(saldo, p.unidade)}</b> <span className={`es-pill ${st.cls}`}>{st.txt}</span></>}
                    </td>
                    <td>
                      <div className="es-acoes">
                        <button type="button" className="es-ico" title="Editar produto" aria-label="Editar produto" onClick={() => setEditandoId(p.id)}><IconeLapis /></button>
                        <button type="button" className={`es-ico estoque ${st.cls === 'ok' ? '' : st.cls}`} data-tip={tip} title={tip} aria-label={tip} onClick={() => abrirEstoque(p)}><IconeCaixa /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {carregado && linhas.length === 0 && (
          <Vazio>{products.length === 0 ? 'Nenhum produto cadastrado ainda. Clique em "+ Novo produto".' : 'Nenhum produto encontrado.'}</Vazio>
        )}
        {linhas.length > 0 && (
          <div className="paginacao">
            <span>Mostrando {pagina.length} de {linhas.length} produto(s)</span>
            {linhas.length > visiveis && <button type="button" className="btn-link" onClick={() => setVisiveis(visiveis + POR_PAGINA)}>Mostrar mais</button>}
            {visiveis > POR_PAGINA && pagina.length >= linhas.length && <button type="button" className="btn-link" onClick={() => setVisiveis(POR_PAGINA)}>Mostrar menos</button>}
          </div>
        )}
      </div>

      {novo && <FormProduto {...props} onClose={() => setNovo(false)} onSalvo={() => setNovo(false)} />}
      {editandoId && (
        <EditarProduto {...props} productId={editandoId} onClose={() => setEditandoId(null)}
          onTratarEstoque={(id) => { setEditandoId(null); setEstoqueId(id); }} />
      )}
      {produtoEstoque && <EstoqueProduto {...props} produto={produtoEstoque} onClose={() => setEstoqueId(null)} />}
      {categoriasAberto && <Categorias {...props} onClose={() => setCategoriasAberto(false)} />}
    </>
  );
}
