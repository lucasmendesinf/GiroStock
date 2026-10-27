import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import Folha from '../componentes/Folha.jsx';
import LoginTelefone from '../componentes/LoginTelefone.jsx';
import ProdutoFolha from '../componentes/ProdutoFolha.jsx';
import SacolaFolha from '../componentes/SacolaFolha.jsx';
import { brl, DIAS, fmtTel, soDigitos } from '../util';

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const reduzido = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const NOME_ENTREGA = { dinheiro: 'Dinheiro', pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito' };

// Cartao do produto. memo: so redesenha se o proprio item ou o estilo mudar (a rolagem so troca a categoria ativa).
const Item = memo(function Item({ p, selo, aoAdicionar, aoAbrir }) {
  const indisponivel = !p.disponivel;
  return (
    <li className={`cd-item ${indisponivel ? 'indisp' : ''}`}>
      <button type="button" className="cd-item-corpo" onClick={() => aoAbrir(p)} aria-label={`${p.nome}, ${brl(p.preco)}${indisponivel ? ', indisponível' : ''}`}>
        <span className="cd-foto">
          {p.imagem ? <img src={p.imagem} alt="" loading="lazy" decoding="async" /> : <span aria-hidden="true">🍽</span>}
          {selo && p.off > 0 && <span className="cd-off">{p.off}% OFF</span>}
        </span>
        <span className="cd-info">
          <b>{p.nome}</b>
          {p.descricao && <span className="cd-desc">{p.descricao}</span>}
          <span className="cd-preco">
            {p.preco_original && <s>{brl(p.preco_original)}</s>}
            <strong>{p.preco_varia ? 'a partir de ' : ''}{brl(p.preco)}</strong>
          </span>
          {indisponivel && <span className="cd-aviso-indisp">Indisponível no momento</span>}
          {p.maior_idade && <span className="cd-aviso-indisp">+18</span>}
        </span>
      </button>
      <button type="button" className="cd-mais" onClick={() => aoAdicionar(p)} disabled={indisponivel} aria-label={`Adicionar ${p.nome}`}>+</button>
    </li>
  );
});

const Secoes = memo(function Secoes({ secoes, selo, aoAdicionar, aoAbrir }) {
  return secoes.map((s) => (
    <section key={s.id} id={`cd-sec-${s.id}`} className="cd-sec" aria-labelledby={`cd-tit-${s.id}`}>
      <h2 id={`cd-tit-${s.id}`}>{s.promocoes ? '🔥 ' : ''}{s.nome}<small>{s.produtos.length} {s.produtos.length === 1 ? 'item' : 'itens'}</small></h2>
      <ul className="cd-lista">
        {s.produtos.map((p) => <Item key={`${s.id}-${p.id}`} p={p} selo={selo} aoAdicionar={aoAdicionar} aoAbrir={aoAbrir} />)}
      </ul>
    </section>
  ));
});

// Cardapio digital em pagina unica: capa e perfil da loja, barra de categorias fixa que acompanha a rolagem e todos os produtos
// numa lista continua. Mesa/garcom nao fazem parte deste modelo.
export default function Cardapio() {
  const { loja, conta, carrinho, quantidadeCarrinho, totalCarrinho, adicionar, avisar } = useLoja();
  const navegar = useNavigate();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [filtro, setFiltro] = useState({ promo: false, destaque: false });
  const [ativa, setAtiva] = useState(null);
  const [folha, setFolha] = useState(null); // 'sobre' | 'entrega' | 'contato' | 'categorias' | 'filtros' | 'menu' | 'sacola' | 'login'
  const [produtoAberto, setProdutoAberto] = useState(null);
  const [depoisLogin, setDepoisLogin] = useState(null); // o que fazer assim que o cliente entrar: 'finalizar' | 'pedidos'
  const [tipo, setTipoEstado] = useState(() => { try { return sessionStorage.getItem('lv_tipo') || (loja.entrega.aceita ? 'entrega' : 'retirada'); } catch { return 'entrega'; } });
  const [bairro, setBairroEstado] = useState(() => { try { return sessionStorage.getItem('lv_bairro') || ''; } catch { return ''; } });
  const barraRef = useRef(null);
  const chipsRef = useRef(null);
  const travado = useRef(0);
  const calcular = useRef(() => {});

  const setTipo = useCallback((t) => { setTipoEstado(t); try { sessionStorage.setItem('lv_tipo', t); } catch { /* */ } }, []);
  const setBairro = useCallback((b) => { setBairroEstado(b); try { sessionStorage.setItem('lv_bairro', b); } catch { /* */ } }, []);
  // so retirada ou so entrega: o tipo acompanha o que a loja aceita
  useEffect(() => {
    if (tipo === 'entrega' && !loja.entrega.aceita) setTipo('retirada');
    else if (tipo === 'retirada' && !loja.retirada.aceita && loja.entrega.aceita) setTipo('entrega');
  }, [tipo, loja.entrega.aceita, loja.retirada.aceita, setTipo]);

  useEffect(() => {
    let vivo = true;
    const carregar = () => api.get('/cardapio').then((d) => { if (vivo) setDados(d); }).catch((e) => { if (vivo) setErro((x) => x || e.message); });
    carregar();
    const t = setInterval(carregar, 120000); // estoque e promocoes atualizados
    return () => { vivo = false; clearInterval(t); };
  }, []);

  const tema = loja.tema;
  const estilo = tema.cartao_estilo || 'esquerda';

  const secoes = useMemo(() => {
    if (!dados) return [];
    const q = semAcento(busca.trim());
    return dados.secoes.map((s) => ({
      ...s,
      produtos: s.produtos.filter((p) => (!q || semAcento(`${p.nome} ${p.descricao}`).includes(q)) && (!filtro.promo || p.preco_original) && (!filtro.destaque || p.destaque)),
    })).filter((s) => s.produtos.length > 0);
  }, [dados, busca, filtro]);
  const ids = secoes.map((s) => s.id).join('|');
  const temDestaque = !!dados && dados.secoes.some((s) => s.produtos.some((p) => p.destaque));

  // categoria ativa acompanha a rolagem (um unico ouvinte, throttle por requestAnimationFrame; so o estado da categoria muda)
  useEffect(() => {
    const lista = ids ? ids.split('|') : [];
    if (lista.length === 0) { setAtiva(null); return undefined; }
    let raf = 0;
    let tm = 0;
    let agendado = false;
    const calc = () => {
      if (performance.now() < travado.current) return;
      const h = barraRef.current ? barraRef.current.getBoundingClientRect().bottom : 0;
      let atual = lista[0];
      for (const id of lista) {
        const el = document.getElementById(`cd-sec-${id}`);
        if (el && el.getBoundingClientRect().top <= h + 12) atual = id; else break;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) atual = lista[lista.length - 1];
      setAtiva((a) => (a === atual ? a : atual));
    };
    // um calculo por quadro; o timer cobre abas/paineis em segundo plano, onde o requestAnimationFrame nao dispara
    const rodar = () => {
      if (!agendado) return;
      agendado = false;
      cancelAnimationFrame(raf);
      clearTimeout(tm);
      calc();
    };
    const aoRolar = () => {
      if (agendado) return;
      agendado = true;
      raf = requestAnimationFrame(rodar);
      tm = setTimeout(rodar, 80);
    };
    calcular.current = calc;
    window.addEventListener('scroll', aoRolar, { passive: true });
    window.addEventListener('resize', aoRolar);
    calc();
    return () => { window.removeEventListener('scroll', aoRolar); window.removeEventListener('resize', aoRolar); cancelAnimationFrame(raf); clearTimeout(tm); };
  }, [ids]);

  // o chip ativo fica no centro da barra
  useEffect(() => {
    const c = chipsRef.current;
    const el = c && ativa ? c.querySelector(`[data-sec="${ativa}"]`) : null;
    if (!el) return;
    c.scrollTo({ left: el.offsetLeft - (c.clientWidth - el.offsetWidth) / 2, behavior: reduzido() ? 'auto' : 'smooth' });
  }, [ativa]);

  const irPara = useCallback((id) => {
    const el = document.getElementById(`cd-sec-${id}`);
    if (!el) return;
    const h = barraRef.current ? barraRef.current.offsetHeight : 0;
    setAtiva(id);
    travado.current = performance.now() + 900;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - h - 4, behavior: reduzido() ? 'auto' : 'smooth' });
    setTimeout(() => calcular.current(), 960);
  }, []);

  const abrir = useCallback((p) => {
    if (p.grade) navegar(`/produto/${p.id}`); else setProdutoAberto(p.id);
  }, [navegar]);
  const adicionarDireto = useCallback((p) => {
    if (!p.disponivel) return;
    if (p.adicionais_obrigatorios || p.grade) { abrir(p); return; }
    adicionar({ product_id: p.id, nome: p.nome, imagem: p.imagem, preco_unitario: p.preco, quantidade: 1, unidade: p.unidade, complementos: [], observacao: '', maximo: p.quantidade_maxima });
    avisar(`${p.nome} na sacola`);
  }, [abrir, adicionar, avisar]);

  // finalizar e historico pedem login; depois de entrar, a acao pedida continua sozinha
  const destino = (alvo) => (alvo === 'finalizar' ? '/finalizar' : '/pedidos');
  const exigirLogin = (alvo) => {
    if (conta) { navegar(destino(alvo)); return; }
    setDepoisLogin(alvo);
    setFolha('login');
  };
  function aposLogin() {
    const alvo = depoisLogin;
    setFolha(null);
    setDepoisLogin(null);
    if (alvo) navegar(destino(alvo));
  }

  if (erro && !dados) return <p className="vazio">Não foi possível carregar o cardápio. {erro}</p>;
  if (!dados) return <div className="carregando" aria-label="Carregando o cardápio" />;

  const horario = loja.horario || {};
  const aberta = loja.recebendo_pedidos;
  const status = aberta
    ? <><b className="cd-aberto">Aberto</b>{horario.fecha_as ? ` · fecha às ${horario.fecha_as}` : ''}</>
    : <><b className="cd-fechado">Fechado</b>{loja.motivo_fechada ? ` · ${loja.motivo_fechada.replace(/^a loja está fechada: /, '')}` : ''}</>;
  const tempo = loja.entrega.aceita && loja.entrega.tempo_estimado_min ? `${loja.entrega.tempo_estimado_min} min` : loja.retirada.aceita && loja.retirada.tempo_estimado_min ? `${loja.retirada.tempo_estimado_min} min` : null;
  const taxas = loja.entrega.aceita ? [...loja.entrega.bairros.map((b) => b.taxa), ...(loja.entrega.outros_bairros ? [loja.entrega.outros_bairros.taxa] : [])] : [];
  const menorTaxa = taxas.length ? Math.min(...taxas) : null;
  const c = loja.contato;
  const pag = loja.pagamentos;
  const total = dados.secoes.reduce((s, x) => s + (x.promocoes ? 0 : x.produtos.length), 0);

  return (
    <div className={`cd cd-estilo-${estilo}`}>
      <header className="cd-capa" style={loja.capa ? { backgroundImage: `url(${loja.capa})` } : undefined}>
        <div className="cd-topo">
          <button type="button" className="cd-ib" onClick={() => setFolha('menu')} aria-label="Menu">☰</button>
          <span className="cd-topo-dir">
            <button type="button" className="cd-ib" onClick={() => { setBuscando((b) => !b); window.scrollTo({ top: 0, behavior: 'auto' }); }} aria-label="Buscar no cardápio" aria-pressed={buscando}>🔍</button>
            <button type="button" className="cd-ib" onClick={() => (conta ? navegar('/conta') : setFolha('login'))} aria-label={conta ? 'Minha conta' : 'Entrar'}>👤</button>
          </span>
        </div>
      </header>
      <section className="cd-perfil" aria-label="Sobre a loja">
        <div className="cd-logo">{loja.logo ? <img src={loja.logo} alt="" /> : <span aria-hidden="true">{loja.nome.slice(0, 1)}</span>}</div>
        <h1>{loja.nome}</h1>
        <p className="cd-status">{status}{tempo ? ` · ${tempo}` : ''}</p>
        {(loja.pedido_minimo > 0 || menorTaxa !== null) && (
          <p className="cd-status">
            {loja.pedido_minimo > 0 ? `Pedido mín. ${brl(loja.pedido_minimo)}` : ''}
            {loja.pedido_minimo > 0 && menorTaxa !== null ? ' · ' : ''}
            {menorTaxa !== null ? `Entrega ${menorTaxa === 0 ? 'grátis' : `a partir de ${brl(menorTaxa)}`}` : ''}
          </p>
        )}
        <nav className="cd-acoes" aria-label="Informações da loja">
          <button type="button" onClick={() => setFolha('sobre')}><span aria-hidden="true">ℹ️</span>Sobre</button>
          <button type="button" onClick={() => setFolha('entrega')}><span aria-hidden="true">🛵</span>Entrega</button>
          <button type="button" onClick={() => exigirLogin('pedidos')}><span aria-hidden="true">🧾</span>Histórico</button>
          <button type="button" onClick={() => setFolha('contato')}><span aria-hidden="true">💬</span>Contato</button>
        </nav>
        {loja.aviso && <p className="cd-aviso">{loja.aviso}</p>}
      </section>

      <div className="cd-barra" ref={barraRef}>
        <button type="button" className="cd-menu" onClick={() => setFolha('categorias')} aria-label="Lista de categorias">☰</button>
        {(temDestaque || dados.secoes.some((s) => s.promocoes)) && (
          <button type="button" className={`cd-filtro ${filtro.promo || filtro.destaque ? 'on' : ''}`} onClick={() => setFolha('filtros')}>
            Filtros{filtro.promo || filtro.destaque ? ` (${Number(filtro.promo) + Number(filtro.destaque)})` : ''}
          </button>
        )}
        <div className="cd-chips" ref={chipsRef} role="tablist" aria-label="Categorias">
          {secoes.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={ativa === s.id} data-sec={s.id} className={ativa === s.id ? 'on' : ''} onClick={() => irPara(s.id)}>
              {s.promocoes ? '🔥 ' : ''}{s.nome}
            </button>
          ))}
        </div>
      </div>
      {(buscando || busca) && (
        <div className="cd-busca">
          <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar no cardápio" aria-label="Buscar no cardápio" autoFocus={buscando} />
        </div>
      )}

      <main className="cd-lista-geral">
        {secoes.length === 0 ? (
          <p className="vazio">{busca || filtro.promo || filtro.destaque ? 'Nada encontrado com esse filtro.' : 'O cardápio ainda não tem produtos.'}</p>
        ) : <Secoes secoes={secoes} selo={tema.selo_off !== false} aoAdicionar={adicionarDireto} aoAbrir={abrir} />}
        <p className="cd-rodape">{loja.nome} · {total} {total === 1 ? 'item' : 'itens'} no cardápio</p>
      </main>

      {quantidadeCarrinho > 0 && (
        <button type="button" className="cd-sacola" onClick={() => setFolha('sacola')}>
          <span>🛍 Ver sacola · {quantidadeCarrinho} {quantidadeCarrinho === 1 ? 'item' : 'itens'}</span><b>{brl(totalCarrinho)}</b>
        </button>
      )}

      {produtoAberto && <ProdutoFolha id={produtoAberto} aoFechar={() => setProdutoAberto(null)} />}
      {folha === 'sacola' && (
        <SacolaFolha tipo={tipo} setTipo={setTipo} bairro={bairro} setBairro={setBairro} aoFechar={() => setFolha(null)}
          aoContinuar={() => { setFolha(null); exigirLogin('finalizar'); }} />
      )}
      {folha === 'login' && <Folha titulo="Entrar" aoFechar={() => { setFolha(null); setDepoisLogin(null); }}><LoginTelefone aoEntrar={aposLogin} /></Folha>}
      {folha === 'categorias' && (
        <Folha titulo="Categorias" aoFechar={() => setFolha(null)}>
          <ul className="cd-cats">
            {secoes.map((s) => <li key={s.id}><button type="button" onClick={() => { setFolha(null); setTimeout(() => irPara(s.id), 60); }}>{s.promocoes ? '🔥 ' : ''}{s.nome}<small>{s.produtos.length}</small></button></li>)}
          </ul>
        </Folha>
      )}
      {folha === 'filtros' && (
        <Folha titulo="Filtros" aoFechar={() => setFolha(null)}>
          <label className="marcar cd-marcar"><input type="checkbox" checked={filtro.promo} onChange={(e) => setFiltro({ ...filtro, promo: e.target.checked })} /> Só promoções</label>
          {temDestaque && <label className="marcar cd-marcar"><input type="checkbox" checked={filtro.destaque} onChange={(e) => setFiltro({ ...filtro, destaque: e.target.checked })} /> Mais pedidos</label>}
          <div className="botoes">
            <button type="button" className="botao botao-claro" onClick={() => setFiltro({ promo: false, destaque: false })}>Limpar</button>
            <button type="button" className="botao" onClick={() => setFolha(null)}>Ver resultados</button>
          </div>
        </Folha>
      )}
      {folha === 'menu' && (
        <Folha titulo={loja.nome} aoFechar={() => setFolha(null)}>
          <nav className="cd-menu-lista">
            <button type="button" onClick={() => { setFolha(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>🏠 Início</button>
            <button type="button" onClick={() => { setFolha(null); exigirLogin('pedidos'); }}>🧾 Meus pedidos</button>
            <button type="button" onClick={() => { if (conta) { setFolha(null); navegar('/conta'); } else setFolha('login'); }}>👤 {conta ? `Conta de ${conta.nome.split(' ')[0]}` : 'Entrar'}</button>
            <button type="button" onClick={() => setFolha('sobre')}>ℹ️ Sobre a loja</button>
          </nav>
        </Folha>
      )}
      {folha === 'sobre' && (
        <Folha titulo="Sobre a loja" aoFechar={() => setFolha(null)}>
          {loja.descricao && <p>{loja.descricao}</p>}
          {c.endereco && <p>📍 {c.endereco}</p>}
          <h3>Horários</h3>
          {Object.keys(loja.horarios || {}).length === 0 ? <p>Todos os dias.</p> : DIAS.map((nome, d) => (
            <p key={nome} className="horario-linha"><span>{nome}</span><span>{(loja.horarios[d] || []).length ? loja.horarios[d].map((f) => `${f.de}–${f.ate}`).join(', ') : 'fechado'}</span></p>
          ))}
          <h3>Formas de pagamento</h3>
          <ul className="cd-ul">
            {(pag.pix_online || pag.cartao_online) && <li>Pagando pelo site: {[pag.pix_online && 'Pix', pag.cartao_online && 'cartão de crédito'].filter(Boolean).join(', ')}</li>}
            {pag.na_entrega.length > 0 && <li>Na entrega ou retirada: {pag.na_entrega.map((f) => NOME_ENTREGA[f] || f).join(', ')}</li>}
          </ul>
          <h3>Como receber</h3>
          <ul className="cd-ul">
            {loja.entrega.aceita && <li>Entrega{loja.entrega.tempo_estimado_min ? ` em cerca de ${loja.entrega.tempo_estimado_min} min` : ''}</li>}
            {loja.retirada.aceita && <li>Retirada na loja{loja.retirada.tempo_estimado_min ? ` em cerca de ${loja.retirada.tempo_estimado_min} min` : ''}</li>}
          </ul>
        </Folha>
      )}
      {folha === 'entrega' && (
        <Folha titulo="Entrega e retirada" aoFechar={() => setFolha(null)}>
          {loja.entrega.aceita && loja.retirada.aceita && (
            <div className="opcoes-2" role="radiogroup" aria-label="Como receber">
              <button type="button" role="radio" aria-checked={tipo === 'entrega'} className={`opcao-grande ${tipo === 'entrega' ? 'on' : ''}`} onClick={() => setTipo('entrega')}><b>🛵 Entrega</b></button>
              <button type="button" role="radio" aria-checked={tipo === 'retirada'} className={`opcao-grande ${tipo === 'retirada' ? 'on' : ''}`} onClick={() => setTipo('retirada')}><b>🛍 Retirada</b></button>
            </div>
          )}
          {loja.pedido_minimo > 0 && <p>Pedido mínimo: <b>{brl(loja.pedido_minimo)}</b></p>}
          {tipo === 'retirada' || !loja.entrega.aceita ? (
            <p>{c.endereco ? `Retire em: ${c.endereco}` : 'Retire o pedido na loja.'}{loja.retirada.tempo_estimado_min ? ` Pronto em cerca de ${loja.retirada.tempo_estimado_min} min.` : ''}</p>
          ) : (
            <>
              <p>Taxa por bairro{loja.entrega.tempo_estimado_min ? ` · cerca de ${loja.entrega.tempo_estimado_min} min` : ''}:</p>
              <ul className="cd-ul">
                {loja.entrega.bairros.map((b) => (
                  <li key={b.id}><button type="button" className={`cd-bairro ${bairro === b.nome ? 'on' : ''}`} onClick={() => setBairro(b.nome)}>{b.nome}<b>{b.taxa > 0 ? brl(b.taxa) : 'Grátis'}</b></button></li>
                ))}
                {loja.entrega.outros_bairros && <li><button type="button" className={`cd-bairro ${bairro === 'Outros bairros' ? 'on' : ''}`} onClick={() => setBairro('Outros bairros')}>Outros bairros<b>{loja.entrega.outros_bairros.taxa > 0 ? brl(loja.entrega.outros_bairros.taxa) : 'Grátis'}</b></button></li>}
              </ul>
            </>
          )}
        </Folha>
      )}
      {folha === 'contato' && (
        <Folha titulo="Contato" aoFechar={() => setFolha(null)}>
          <ul className="cd-menu-lista">
            {c.whatsapp && <li><a href={`https://wa.me/55${soDigitos(c.whatsapp)}`} target="_blank" rel="noreferrer">💬 WhatsApp {fmtTel(c.whatsapp)}</a></li>}
            {c.telefone && <li><a href={`tel:${soDigitos(c.telefone)}`}>📞 {fmtTel(c.telefone)}</a></li>}
            {c.instagram && <li><a href={`https://instagram.com/${c.instagram.replace('@', '')}`} target="_blank" rel="noreferrer">📷 {c.instagram.startsWith('@') ? c.instagram : `@${c.instagram}`}</a></li>}
            {c.email && <li><a href={`mailto:${c.email}`}>✉️ {c.email}</a></li>}
            {!c.whatsapp && !c.telefone && !c.instagram && !c.email && <li className="vazio">A loja ainda não informou contatos.</li>}
          </ul>
        </Folha>
      )}
    </div>
  );
}
