import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { Grade, Prateleira } from '../componentes/CartaoProduto.jsx';

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
          if (raiz.length > 0 && loja.tipo === 'cardapio') {
            return (
              <section key="categorias" className="bloco">
                {b.titulo && <h2>{b.titulo}</h2>}
                <div className="cartoes-categoria">
                  {raiz.map((c) => (
                    <Link key={c.id} to={`/produtos?categoria=${c.id}`} className="cartao-categoria">
                      {c.imagem ? <img src={c.imagem} alt="" loading="lazy" /> : <span className="sem-foto" aria-hidden="true">🍽</span>}
                      {c.tem_promocao && <span className="fita">Promoção</span>}
                      <span className="cartao-categoria-nome">{c.nome}</span>
                    </Link>
                  ))}
                </div>
              </section>
            );
          }
          // Varejo: categorias em bolinhas com foto, lado a lado com rolagem.
          return raiz.length > 0 ? (
            <section key="categorias" className="bloco">
              <h2 className="titulo-secao">{titulo}</h2>
              <div className="bolinhas">
                {raiz.map((c) => (
                  <Link key={c.id} to={`/produtos?categoria=${c.id}`} className="bolinha">
                    <span className="bolinha-foto">{c.imagem ? <img src={c.imagem} alt="" loading="lazy" /> : <b aria-hidden="true">{c.nome.slice(0, 1)}</b>}</span>
                    <span>{c.nome}</span>
                  </Link>
                ))}
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
              <h2 className="titulo-secao">{titulo}</h2>
              {(b.tipo !== 'produtos' || lista.total > lista.produtos.length) && <Link to={`/produtos${filtro ? `?${filtro}` : ''}`} className="ver-todos">Ver {loja.tipo === 'cardapio' ? 'todos' : 'mais'}</Link>}
            </div>
            {loja.tipo !== 'cardapio' && b.tipo !== 'produtos' ? <Prateleira produtos={lista.produtos} /> : <Grade produtos={lista.produtos} />}
          </section>
        );
      })}
      {dados.produtos.total === 0 && <p className="vazio">Em breve, produtos por aqui.</p>}
    </>
  );
}

// Banners em carrossel: passa sozinho a cada 5 s, com bolinhas para escolher.
function Banners({ banners }) {
  const trilho = useRef(null);
  const [atual, setAtual] = useState(0);
  useEffect(() => {
    if (banners.length < 2) return undefined;
    const t = setInterval(() => {
      const el = trilho.current;
      if (!el || document.hidden) return;
      const prox = (Math.round(el.scrollLeft / el.clientWidth) + 1) % banners.length;
      el.scrollTo({ left: prox * el.clientWidth, behavior: 'smooth' });
    }, 5000);
    return () => clearInterval(t);
  }, [banners.length]);
  const ir = (i) => trilho.current.scrollTo({ left: i * trilho.current.clientWidth, behavior: 'smooth' });
  return (
    <div className="carrossel">
      <div className="banners" ref={trilho} aria-label="Destaques da loja" onScroll={(e) => setAtual(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}>
        {banners.map((b, i) => {
          const img = <img src={b.imagem} alt={b.titulo || `Banner ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'} />;
          return <div key={b.imagem} className="banner">{b.link ? <a href={b.link}>{img}</a> : img}{b.titulo && <span className="banner-titulo">{b.titulo}</span>}</div>;
        })}
      </div>
      {banners.length > 1 && (
        <div className="pontos">{banners.map((b, i) => <button key={b.imagem} type="button" className={i === atual ? 'on' : ''} onClick={() => ir(i)} aria-label={`Banner ${i + 1}`} />)}</div>
      )}
    </div>
  );
}
