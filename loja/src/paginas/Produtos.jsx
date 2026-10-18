import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Grade } from '../componentes/CartaoProduto.jsx';

// Listagem: categoria, busca, destaques ou promocoes, com ordem e "carregar mais".
export default function Produtos() {
  const [params, setParams] = useSearchParams();
  const [categorias, setCategorias] = useState([]);
  const [lista, setLista] = useState(null);
  const [pagina, setPagina] = useState(1);
  const chave = params.toString();
  useEffect(() => { api.get('/categorias').then(setCategorias).catch(() => {}); }, []);
  useEffect(() => {
    setLista(null);
    setPagina(1);
    api.get(`/produtos?${chave}&por_pagina=24`).then(setLista).catch(() => setLista({ produtos: [], total: 0, paginas: 0 }));
  }, [chave]);
  async function mais() {
    const r = await api.get(`/produtos?${chave}&por_pagina=24&pagina=${pagina + 1}`);
    setLista((l) => ({ ...r, produtos: [...l.produtos, ...r.produtos] }));
    setPagina(pagina + 1);
  }
  const cat = categorias.find((c) => c.id === params.get('categoria'));
  const titulo = params.get('busca') ? `Busca: “${params.get('busca')}”` : cat ? cat.nome : params.get('promocao') ? 'Promoções' : params.get('destaque') ? 'Destaques' : 'Todos os produtos';
  const filhas = cat ? categorias.filter((c) => c.pai_id === cat.id) : categorias.filter((c) => !c.pai_id);
  const mudar = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  return (
    <section className="bloco">
      <div className="bloco-topo">
        <h1>{titulo}</h1>
        <select className="ordem" value={params.get('ordem') || ''} onChange={(e) => mudar('ordem', e.target.value)} aria-label="Ordenar">
          <option value="">Relevância</option>
          <option value="menor_preco">Menor preço</option>
          <option value="maior_preco">Maior preço</option>
          <option value="nome">Nome (A–Z)</option>
        </select>
      </div>
      {filhas.length > 0 && (
        <div className="chips-rolagem">
          {cat && <Link to={cat.pai_id ? `/produtos?categoria=${cat.pai_id}` : '/produtos'} className="chip">‹ Voltar</Link>}
          {filhas.map((c) => <Link key={c.id} to={`/produtos?categoria=${c.id}`} className={`chip ${params.get('categoria') === c.id ? 'on' : ''}`}>{c.nome}</Link>)}
        </div>
      )}
      {!lista ? <div className="carregando" aria-label="Carregando" /> : lista.produtos.length === 0 ? (
        <p className="vazio">Nenhum produto encontrado.{params.get('busca') && <> <Link to="/produtos">Ver todos</Link></>}</p>
      ) : (
        <>
          <p className="contagem">{lista.total} produto(s)</p>
          <Grade produtos={lista.produtos} />
          {pagina < lista.paginas && <button type="button" className="botao botao-claro largo" onClick={mais}>Carregar mais</button>}
        </>
      )}
    </section>
  );
}
