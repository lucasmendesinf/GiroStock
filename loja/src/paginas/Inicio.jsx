import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { Grade } from '../componentes/CartaoProduto.jsx';

const TITULOS = { categorias: 'Categorias', destaques: 'Destaques', promocoes: 'Promoções', produtos: 'Todos os produtos' };

// Pagina inicial: os blocos na ordem escolhida pela loja (Aparência no painel).
export default function Inicio() {
  const { loja } = useLoja();
  const [dados, setDados] = useState(null);
  useEffect(() => {
    Promise.all([
      api.get('/categorias'),
      api.get('/produtos?destaque=1&por_pagina=12'),
      api.get('/produtos?promocao=1&por_pagina=12'),
      api.get('/produtos?por_pagina=24'),
    ]).then(([categorias, destaques, promocoes, produtos]) => setDados({ categorias, destaques, promocoes, produtos }))
      .catch(() => setDados({ categorias: [], destaques: { produtos: [] }, promocoes: { produtos: [] }, produtos: { produtos: [], total: 0 } }));
  }, []);
  if (!dados) return <div className="carregando" aria-label="Carregando" />;
  const blocos = loja.tema.blocos.filter((b) => b.ativo);
  return (
    <>
      {blocos.map((b) => {
        const titulo = b.titulo || TITULOS[b.tipo];
        if (b.tipo === 'banners') return loja.banners.length > 0 ? <Banners key="banners" banners={loja.banners} /> : null;
        if (b.tipo === 'categorias') {
          const raiz = dados.categorias.filter((c) => !c.pai_id || !dados.categorias.some((x) => x.id === c.pai_id));
          return raiz.length > 0 ? (
            <section key="categorias" className="bloco">
              <h2>{titulo}</h2>
              <div className="chips-rolagem">
                {raiz.map((c) => <Link key={c.id} to={`/produtos?categoria=${c.id}`} className="chip">{c.nome}</Link>)}
              </div>
            </section>
          ) : null;
        }
        const lista = dados[b.tipo];
        if (!lista || lista.produtos.length === 0) return null;
        const filtro = { destaques: 'destaque=1', promocoes: 'promocao=1', produtos: '' }[b.tipo];
        return (
          <section key={b.tipo} className="bloco">
            <div className="bloco-topo">
              <h2>{titulo}</h2>
              {(b.tipo !== 'produtos' || lista.total > lista.produtos.length) && <Link to={`/produtos${filtro ? `?${filtro}` : ''}`} className="ver-todos">Ver todos</Link>}
            </div>
            <Grade produtos={lista.produtos} />
          </section>
        );
      })}
      {dados.produtos.total === 0 && <p className="vazio">Em breve, produtos por aqui.</p>}
    </>
  );
}

function Banners({ banners }) {
  return (
    <div className="banners" aria-label="Destaques da loja">
      {banners.map((b, i) => {
        const img = <img src={b.imagem} alt={b.titulo || `Banner ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'} />;
        return <div key={b.imagem} className="banner">{b.link ? <a href={b.link}>{img}</a> : img}{b.titulo && <span className="banner-titulo">{b.titulo}</span>}</div>;
      })}
    </div>
  );
}
