import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLoja } from '../estado.jsx';
import { SUBDOMINIO_PREVIA } from '../api';
import { brl, DIAS, fmtTel, soDigitos } from '../util';

// Cabecalho (logo, busca, conta, carrinho), faixas de aviso/fechada, conteudo e rodape com contato e horarios.
export default function Layout() {
  const { loja, erroLoja, quantidadeCarrinho, totalCarrinho, conta, avisos } = useLoja();
  const { pathname } = useLocation();
  const navegar = useNavigate();
  const [busca, setBusca] = useState('');
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  if (erroLoja) {
    return (
      <div className="tela-cheia">
        <h1>{erroLoja.status === 404 ? 'Loja não encontrada' : 'Loja indisponível'}</h1>
        <p>{erroLoja.status === 404 ? 'Confira o endereço digitado.' : erroLoja.message}</p>
      </div>
    );
  }
  if (!loja) return <div className="tela-cheia"><div className="carregando" aria-label="Carregando" /></div>;
  if (!loja.no_ar && !SUBDOMINIO_PREVIA) {
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
  function buscar(e) {
    e.preventDefault();
    navegar(`/produtos?busca=${encodeURIComponent(busca.trim())}`);
  }
  return (
    <>
      {SUBDOMINIO_PREVIA && <div className="faixa faixa-previa">Pré-visualização{loja.no_ar ? '' : ' · a loja ainda está fora do ar'}</div>}
      {loja.aviso && <div className="faixa">{loja.aviso}</div>}
      {loja.no_ar && !loja.recebendo_pedidos && <div className="faixa faixa-fechada">{loja.motivo_fechada ? primeiraMaiuscula(loja.motivo_fechada) : 'Loja fechada no momento'} · você pode ver os produtos</div>}
      <header className="topo">
        <div className="topo-linha">
          <Link to="/" className="marca" aria-label={`${loja.nome} – início`}>
            {loja.logo ? <img src={loja.logo} alt="" /> : <span className="marca-inicial">{loja.nome.slice(0, 1)}</span>}
            <span className="marca-nome">{loja.nome}</span>
          </Link>
          <form className="busca busca-topo" onSubmit={buscar} role="search">
            <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produtos" aria-label="Buscar produtos" />
          </form>
          <nav className="topo-acoes">
            <NavLink to={conta ? '/conta' : '/entrar'} className="topo-icone" aria-label={conta ? 'Minha conta' : 'Entrar'}>
              <span aria-hidden="true">👤</span><span className="topo-rotulo">{conta ? conta.nome.split(' ')[0] : 'Entrar'}</span>
            </NavLink>
            <NavLink to="/carrinho" className="topo-icone" aria-label={`Carrinho, ${quantidadeCarrinho} item(ns)`}>
              <span aria-hidden="true">🛒</span>{quantidadeCarrinho > 0 && <span className="contador">{quantidadeCarrinho}</span>}<span className="topo-rotulo">Carrinho</span>
            </NavLink>
          </nav>
        </div>
        <form className="busca busca-celular" onSubmit={buscar} role="search">
          <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produtos" aria-label="Buscar produtos" />
        </form>
      </header>
      <main className="conteudo"><Outlet /></main>
      <Rodape loja={loja} />
      {quantidadeCarrinho > 0 && !noCarrinho && (
        <Link to="/carrinho" className="barra-carrinho">
          <span>🛒 {quantidadeCarrinho} {quantidadeCarrinho === 1 ? 'item' : 'itens'}</span><b>Ver carrinho · {brl(totalCarrinho)}</b>
        </Link>
      )}
      <div className="avisos" aria-live="polite">{avisos.map((a) => <div key={a.id} className={`aviso aviso-${a.tipo}`}>{a.texto}</div>)}</div>
    </>
  );
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
      <p className="rodape-fim">{loja.retirada.aceita ? 'Retirada na loja' : ''}{loja.retirada.aceita && loja.entrega.aceita ? ' · ' : ''}{loja.entrega.aceita ? 'Entrega' : ''}</p>
    </footer>
  );
}
