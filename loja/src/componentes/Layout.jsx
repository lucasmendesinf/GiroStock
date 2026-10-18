import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLoja } from '../estado.jsx';
import { api, EH_PREVIA } from '../api';
import { brl, DIAS, fmtTel, soDigitos } from '../util';

// Cabecalho (logo, busca, conta, carrinho), faixas de aviso/fechada, conteudo e rodape com contato e horarios.
export default function Layout() {
  const { loja, erroLoja, quantidadeCarrinho, totalCarrinho, conta, avisos, avisar } = useLoja();
  const { pathname } = useLocation();
  const navegar = useNavigate();
  const [busca, setBusca] = useState('');
  const [menu, setMenu] = useState(false);
  const [categorias, setCategorias] = useState([]);
  const fecharMenu = useCallback(() => setMenu(false), []);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const varejo = !!loja && loja.tipo !== 'cardapio';
  useEffect(() => { if (varejo) api.get('/categorias').then(setCategorias).catch(() => {}); }, [varejo]);

  if (erroLoja) {
    return (
      <div className="tela-cheia">
        <h1>{erroLoja.status === 404 ? 'Loja não encontrada' : 'Loja indisponível'}</h1>
        <p>{erroLoja.status === 404 ? 'Confira o endereço digitado.' : erroLoja.message}</p>
      </div>
    );
  }
  if (!loja) return <div className="tela-cheia"><div className="carregando" aria-label="Carregando" /></div>;
  if (!loja.no_ar && !EH_PREVIA) {
    return (
      <div className="tela-cheia">
        {loja.logo && <img className="logo-grande" src={loja.logo} alt={loja.nome} />}
        <h1>{loja.nome}</h1>
        <p>A loja está fora do ar no momento. Volte em breve!</p>
        {loja.contato.whatsapp && <a className="botao" href={`https://wa.me/55${soDigitos(loja.contato.whatsapp)}`}>Falar no WhatsApp</a>}
      </div>
    );
  }
  const noCarrinho = ['/carrinho', '/finalizar'].includes(pathname);
  const raizes = categorias.filter((c) => !c.pai_id || !categorias.some((x) => x.id === c.pai_id));
  const cardapio = loja.tipo === 'cardapio';
  function buscar(e) {
    e.preventDefault();
    navegar(`/produtos?busca=${encodeURIComponent(busca.trim())}`);
  }
  const faixas = (
    <>
      {EH_PREVIA && <div className="faixa faixa-previa">Pré-visualização{loja.no_ar ? '' : ' · a loja ainda está fora do ar'}</div>}
      {loja.aviso && <div className="faixa">{loja.aviso}</div>}
    </>
  );
  const fechada = loja.no_ar && !loja.recebendo_pedidos
    ? <div className="faixa faixa-fechada">{loja.motivo_fechada ? primeiraMaiuscula(loja.motivo_fechada) : 'Loja fechada no momento'}</div> : null;
  const barra = quantidadeCarrinho > 0 && !noCarrinho && (
    <Link to="/carrinho" className={`barra-carrinho ${cardapio ? 'sobre-menu' : ''}`}>
      <span>🛒 {quantidadeCarrinho} {quantidadeCarrinho === 1 ? 'item' : 'itens'}</span><b>Ver carrinho · {brl(totalCarrinho)}</b>
    </Link>
  );
  const avisosTela = <div className="avisos" aria-live="polite">{avisos.map((a) => <div key={a.id} className={`aviso aviso-${a.tipo}`}>{a.texto}</div>)}</div>;

  // Cardapio digital (delivery): cabecalho na cor da loja, pedido minimo/entrega, menu inferior Inicio/Pedidos/Conta.
  if (cardapio) {
    const taxas = loja.entrega.aceita ? [...loja.entrega.bairros.map((b) => b.taxa), ...(loja.entrega.outros_bairros ? [loja.entrega.outros_bairros.taxa] : [])] : [];
    const menorTaxa = taxas.length ? Math.min(...taxas) : null;
    return (
      <div className="app-cardapio">
        {faixas}
        <header className="topo-cardapio">
          <Link to="/" className="marca" aria-label={`${loja.nome} – início`}>
            {loja.logo ? <img src={loja.logo} alt="" /> : <span className="marca-inicial">{loja.nome.slice(0, 1)}</span>}
            <span className="marca-nome">{loja.nome}</span>
          </Link>
          <Link to="/produtos" className="icone-redondo" aria-label="Buscar">🔍</Link>
          <button type="button" className="icone-redondo" onClick={() => compartilhar(loja, avisar)} aria-label="Compartilhar a loja">⤴</button>
        </header>
        {fechada}
        <div className="info-cardapio">
          <span>
            {loja.pedido_minimo > 0 && <>Pedido mín. {brl(loja.pedido_minimo)}</>}
            {menorTaxa !== null && <>{loja.pedido_minimo > 0 ? ' · ' : ''}Entrega {menorTaxa === 0 ? 'grátis' : `a partir de ${brl(menorTaxa)}`}</>}
            {loja.entrega.aceita && loja.entrega.tempo_estimado_min ? ` · ~${loja.entrega.tempo_estimado_min} min` : ''}
          </span>
          <Link to="/perfil">Perfil da loja</Link>
        </div>
        <main className="conteudo"><Outlet /></main>
        {barra}
        <nav className="menu-inferior" aria-label="Menu">
          <NavLink to="/" end><span aria-hidden="true">🏠</span>Início</NavLink>
          <NavLink to="/pedidos"><span aria-hidden="true">🧾</span>Pedidos</NavLink>
          <NavLink to={conta ? '/conta' : '/entrar'}><span aria-hidden="true">👤</span>{conta ? 'Conta' : 'Entrar'}</NavLink>
        </nav>
        {avisosTela}
      </div>
    );
  }

  return (
    <>
      {faixas}
      {fechada}
      <header className="topo">
        <div className="topo-linha">
          <button type="button" className="topo-icone menu-botao" onClick={() => setMenu(true)} aria-label="Abrir menu" aria-expanded={menu}><span aria-hidden="true">☰</span></button>
          <Link to="/" className="marca" aria-label={`${loja.nome} – início`}>
            {loja.logo ? <img src={loja.logo} alt="" /> : <span className="marca-inicial">{loja.nome.slice(0, 1)}</span>}
            <span className="marca-nome">{loja.nome}</span>
          </Link>
          <form className="busca busca-topo" onSubmit={buscar} role="search">
            <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="O que você está buscando?" aria-label="Buscar produtos" />
            <button type="submit" aria-label="Buscar">⌕</button>
          </form>
          <nav className="topo-acoes">
            <NavLink to={conta ? '/conta' : '/entrar'} className="topo-icone" aria-label={conta ? 'Minha conta' : 'Entrar'}>
              <span aria-hidden="true">👤</span><span className="topo-rotulo">{conta ? `Olá, ${conta.nome.split(' ')[0]}` : 'Entrar'}</span>
            </NavLink>
            <NavLink to="/carrinho" className="topo-icone" aria-label={`Carrinho, ${quantidadeCarrinho} item(ns)`}>
              <span aria-hidden="true">🛒</span><span className="contador">{quantidadeCarrinho}</span><span className="topo-rotulo">Carrinho</span>
            </NavLink>
          </nav>
        </div>
        <form className="busca busca-celular" onSubmit={buscar} role="search">
          <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="O que você está buscando?" aria-label="Buscar produtos" />
          <button type="submit" aria-label="Buscar">⌕</button>
        </form>
        {categorias.length > 0 && (
          <nav className="topo-categorias" aria-label="Categorias">
            <div>
              {raizes.slice(0, 8).map((c) => <Link key={c.id} to={`/produtos?categoria=${c.id}`}>{c.nome}</Link>)}
              {categorias.some((c) => c.tem_promocao) && <Link to="/produtos?promocao=1" className="oferta">Ofertas</Link>}
            </div>
          </nav>
        )}
      </header>
      {menu && <Gaveta loja={loja} conta={conta} categorias={categorias} fechar={fecharMenu} compartilhar={() => compartilhar(loja, avisar)} />}
      <main className="conteudo"><Outlet /></main>
      <Rodape loja={loja} />
      {barra}
      {loja.contato.whatsapp && !noCarrinho && !pathname.startsWith('/produto/') && (
        <a className={`whatsapp-flutuante ${barra ? 'com-barra' : ''}`} href={`https://wa.me/55${soDigitos(loja.contato.whatsapp)}`} target="_blank" rel="noreferrer" aria-label="Falar no WhatsApp">
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.5-5.7-1.6l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-1-2.2-1-.3-.2-.5-.2-.7.1l-1 1.2c-.2.2-.4.3-.7.1a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.9.4 3.7 3.7 0 0 0-1.1 2.7 6.5 6.5 0 0 0 1.4 3.4 14.7 14.7 0 0 0 5.6 5c2.1.9 2.9 1 4 .8.6-.1 1.9-.8 2.2-1.5.3-.7.3-1.4.2-1.5l-.6-.3z" /></svg>
        </a>
      )}
      {avisosTela}
    </>
  );
}

// Menu lateral (celular): categorias e atalhos da conta.
function Gaveta({ loja, conta, categorias, fechar, compartilhar: aoCompartilhar }) {
  const { pathname, search } = useLocation();
  const inicio = useRef(pathname + search);
  useEffect(() => { if (pathname + search !== inicio.current) fechar(); }, [pathname, search, fechar]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', esc);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = ''; };
  }, [fechar]);
  const raiz = categorias.filter((c) => !c.pai_id || !categorias.some((x) => x.id === c.pai_id));
  return (
    <div className="gaveta-fundo" onClick={fechar} role="presentation">
      <aside className="gaveta" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Menu">
        <div className="gaveta-topo">
          <b>{conta ? `Olá, ${conta.nome.split(' ')[0]}` : 'Bem-vindo(a)!'}</b>
          <button type="button" onClick={fechar} aria-label="Fechar menu">×</button>
        </div>
        {!conta && <Link to="/entrar" className="botao largo">Entrar ou cadastrar</Link>}
        <nav className="gaveta-lista">
          <Link to="/">Início</Link>
          <Link to="/produtos">Todos os produtos</Link>
          <Link to="/produtos?promocao=1">Ofertas</Link>
        </nav>
        {raiz.length > 0 && (
          <>
            <p className="gaveta-titulo">Categorias</p>
            <nav className="gaveta-lista">
              {raiz.map((c) => <Link key={c.id} to={`/produtos?categoria=${c.id}`}>{c.nome}</Link>)}
            </nav>
          </>
        )}
        <p className="gaveta-titulo">Minha conta</p>
        <nav className="gaveta-lista">
          <Link to="/pedidos">Meus pedidos</Link>
          {conta && <Link to="/conta">Meus dados e endereços</Link>}
          <Link to="/perfil">Sobre a loja</Link>
          {loja.contato.whatsapp && <a href={`https://wa.me/55${soDigitos(loja.contato.whatsapp)}`} target="_blank" rel="noreferrer">Atendimento pelo WhatsApp</a>}
          <button type="button" onClick={aoCompartilhar}>Compartilhar a loja</button>
        </nav>
      </aside>
    </div>
  );
}

// Compartilhar o link da loja (no celular abre o menu do sistema: WhatsApp, Instagram...; no computador copia).
async function compartilhar(loja, avisar) {
  const url = window.location.origin + (window.location.pathname.match(/^\/loja\/[a-z0-9-]+/) || [''])[0];
  try {
    if (navigator.share) { await navigator.share({ title: loja.nome, text: `Peça pela loja ${loja.nome}`, url }); return; }
    await navigator.clipboard.writeText(url);
    avisar('Link da loja copiado');
  } catch { /* cancelado */ }
}

const primeiraMaiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function Rodape({ loja }) {
  const c = loja.contato;
  const dias = Object.keys(loja.horarios || {});
  return (
    <footer className="rodape">
      <div className="rodape-grade">
        <div>
          <b>{loja.nome}</b>
          {loja.descricao && <p>{loja.descricao}</p>}
          {c.endereco && <p>📍 {c.endereco}</p>}
        </div>
        <div>
          <b>Atendimento</b>
          {c.whatsapp && <p><a href={`https://wa.me/55${soDigitos(c.whatsapp)}`} target="_blank" rel="noreferrer">WhatsApp {fmtTel(c.whatsapp)}</a></p>}
          {c.telefone && <p>Telefone {fmtTel(c.telefone)}</p>}
          {c.email && <p><a href={`mailto:${c.email}`}>{c.email}</a></p>}
          {c.instagram && <p><a href={`https://instagram.com/${c.instagram.replace('@', '')}`} target="_blank" rel="noreferrer">Instagram {c.instagram.startsWith('@') ? c.instagram : `@${c.instagram}`}</a></p>}
        </div>
        <div>
          <b>Horários</b>
          {dias.length === 0 ? <p>Todos os dias</p> : DIAS.map((nome, d) => (
            <p key={nome} className="horario-linha"><span>{nome}</span><span>{(loja.horarios[d] || []).length ? loja.horarios[d].map((f) => `${f.de}–${f.ate}`).join(', ') : 'fechado'}</span></p>
          ))}
        </div>
      </div>
      <p className="rodape-fim"><Link to="/perfil">Perfil da loja</Link> · {loja.retirada.aceita ? 'Retirada na loja' : ''}{loja.retirada.aceita && loja.entrega.aceita ? ' · ' : ''}{loja.entrega.aceita ? 'Entrega' : ''}</p>
    </footer>
  );
}
