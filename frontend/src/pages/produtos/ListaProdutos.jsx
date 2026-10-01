import { useMemo, useState } from 'react';
import { brl, qtd, pct } from '../../utils/format';
import { Paginacao, Vazio } from '../../components/ui.jsx';
import FormProduto from './FormProduto.jsx';
import DetalheProduto from './DetalheProduto.jsx';
import Categorias from './Categorias.jsx';

const POR_PAGINA = 25;

function normalizar(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export default function ListaProdutos(props) {
  const { products, categories, suppliers, carregado } = props;
  const [busca, setBusca] = useState('');
  const [categoria, setCategoria] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [situacao, setSituacao] = useState('ativos');
  const [soAlerta, setSoAlerta] = useState(false);
  const [offset, setOffset] = useState(0);
  const [novo, setNovo] = useState(false);
  const [detalheId, setDetalheId] = useState(null);
  const [categoriasAberto, setCategoriasAberto] = useState(false);

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

  const filtrados = useMemo(() => {
    const t = normalizar(busca.trim());
    return products.filter((p) => {
      if (situacao === 'ativos' && !p.ativo) return false;
      if (situacao === 'inativos' && p.ativo) return false;
      if (categoriasFiltro && !categoriasFiltro.has(p.categoria_id)) return false;
      if (fornecedor && !p.fornecedores.some((f) => f.id === fornecedor)) return false;
      if (soAlerta && !p.saldos_por_local.some((s) => s.abaixo_minimo)) return false;
      if (t && !(normalizar(p.nome).includes(t) || p.barcode.includes(busca.trim()) || normalizar(p.codigo_interno).includes(t))) return false;
      return true;
    });
  }, [products, busca, situacao, categoriasFiltro, fornecedor, soAlerta]);

  const pagina = filtrados.slice(offset, offset + POR_PAGINA);
  const mudarFiltro = (fn) => (e) => { fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value); setOffset(0); };

  return (
    <>
      <div className="toolbar">
        <input className="toolbar-busca" placeholder="Buscar por nome, código PRD ou EAN" value={busca} onChange={mudarFiltro(setBusca)} aria-label="Buscar produto" />
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

      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead>
              <tr>
                <th>Produto</th><th className="col-opcional">Categoria</th><th className="col-opcional">Fornecedor</th>
                <th className="num">Venda</th><th className="num col-opcional">Custo</th><th className="num col-opcional">Margem</th><th className="num">Estoque</th>
              </tr>
            </thead>
            <tbody>
              {pagina.map((p) => {
                const margem = Number(p.preco_venda) > 0 ? ((Number(p.preco_venda) - Number(p.preco_custo)) / Number(p.preco_venda)) * 100 : 0;
                const alerta = p.saldos_por_local.some((s) => s.abaixo_minimo);
                const principal = p.fornecedores.find((f) => f.principal) || p.fornecedores[0];
                return (
                  <tr key={p.id} className={`clicavel ${p.ativo ? '' : 'row-inativa'}`} onClick={() => setDetalheId(p.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setDetalheId(p.id); }}>
                    <td>
                      <div className="celula-principal">{p.nome} {!p.ativo && <span className="badge-inativo">inativo</span>}</div>
                      <div className="celula-sub">{p.codigo_interno} · EAN {p.barcode} · {p.unidade}</div>
                    </td>
                    <td className="col-opcional">{p.categoria_nome || '—'}</td>
                    <td className="col-opcional">{principal ? principal.nome : <span className="muted">—</span>}{p.fornecedores.length > 1 ? <span className="muted"> +{p.fornecedores.length - 1}</span> : ''}</td>
                    <td className="num">{brl(p.preco_venda)}</td>
                    <td className="num muted col-opcional">{brl(p.preco_custo)}</td>
                    <td className="num col-opcional">{pct(margem.toFixed(1))}</td>
                    <td className="num">
                      {p.tem_ficha_tecnica
                        ? <span className="muted">insumos</span>
                        : <span className={alerta ? 'texto-alerta' : ''} title={alerta ? 'No mínimo ou abaixo em algum local' : ''}>{qtd(p.saldo_total, p.unidade)}{alerta ? ' ⚠' : ''}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {carregado && filtrados.length === 0 && (
          <Vazio>{products.length === 0 ? 'Nenhum produto cadastrado ainda. Clique em "+ Novo produto".' : 'Nenhum produto encontrado com esses filtros.'}</Vazio>
        )}
        <Paginacao total={filtrados.length} limit={POR_PAGINA} offset={offset} onChange={setOffset} />
      </div>

      {novo && <FormProduto {...props} onClose={() => setNovo(false)} onSalvo={(id) => { setNovo(false); setDetalheId(id); }} />}
      {detalheId && <DetalheProduto {...props} productId={detalheId} onClose={() => setDetalheId(null)} />}
      {categoriasAberto && <Categorias {...props} onClose={() => setCategoriasAberto(false)} />}
    </>
  );
}
