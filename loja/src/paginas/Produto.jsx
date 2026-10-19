import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { Preco } from '../componentes/CartaoProduto.jsx';
import { brl } from '../util';
import CalcularFrete from '../componentes/CalcularFrete.jsx';

// Pagina do produto: fotos, descricao, complementos (respeitando minimo/maximo de cada grupo), quantidade.
export default function Produto() {
  const { id } = useParams();
  const { loja, adicionar, avisar } = useLoja();
  const navegar = useNavigate();
  const [p, setP] = useState(null);
  const [erro, setErro] = useState(null);
  const [foto, setFoto] = useState(0);
  const [qtd, setQtd] = useState(1);
  const [escolhas, setEscolhas] = useState({}); // id da opcao -> quantidade
  const [obs, setObs] = useState('');
  const [selId, setSelId] = useState(null); // variacao escolhida (produto de grade)
  useEffect(() => {
    setP(null); setFoto(0); setQtd(1); setEscolhas({}); setObs(''); setSelId(null);
    api.get(`/produtos/${id}`).then((x) => {
      setP(x);
      if (x.grade) setSelId(x.grade.selecionada || (x.grade.variacoes.find((v) => v.disponivel) || x.grade.variacoes[0]).id);
    }).catch(setErro);
  }, [id]);
  if (erro) return <p className="vazio">Produto não encontrado. <Link to="/produtos">Ver produtos</Link></p>;
  if (!p) return <div className="carregando" aria-label="Carregando" />;

  // Grade: o produto efetivo e a variacao escolhida (preco, estoque e fotos dela).
  const g = p.grade;
  const v = g ? g.variacoes.find((x) => x.id === selId) || g.variacoes[0] : null;
  const prod = v ? { ...p, id: v.id, preco: v.preco, preco_original: v.preco_original, disponivel: v.disponivel, quantidade_maxima: v.quantidade_maxima, imagens: v.imagens.length ? v.imagens : p.imagens } : p;
  const rotulo = v ? g.atributos.map((a) => v.variacao[a.nome]).join(' / ') : '';
  function escolher(atributo, valor) {
    const igual = (x) => g.atributos.every((a) => (a.nome === atributo ? x.variacao[a.nome] === valor : x.variacao[a.nome] === v.variacao[a.nome]));
    const alvo = g.variacoes.find(igual) || g.variacoes.find((x) => x.variacao[atributo] === valor && x.disponivel) || g.variacoes.find((x) => x.variacao[atributo] === valor);
    if (alvo) { setSelId(alvo.id); setFoto(0); setQtd(1); }
  }
  // valor esgotado (ou inexistente) com as outras escolhas atuais: aparece riscado
  const valorDisponivel = (atributo, valor) => g.variacoes.some((x) => x.disponivel && g.atributos.every((a) => (a.nome === atributo ? x.variacao[a.nome] === valor : x.variacao[a.nome] === v.variacao[a.nome])));
  const fotoDoValor = (atributo, valor) => { const x = g.variacoes.find((y) => y.variacao[atributo] === valor && y.imagens.length); return x ? x.imagens[0] : null; };
  const noGrupo = (g) => g.opcoes.reduce((s, o) => s + (escolhas[o.id] || 0), 0);
  const faltando = p.complementos.find((g) => noGrupo(g) < g.minimo);
  const extra = p.complementos.reduce((s, g) => s + g.opcoes.reduce((t, o) => t + (escolhas[o.id] || 0) * o.preco, 0), 0);
  const unitario = prod.preco + extra;
  function mudarOpcao(g, o, delta) {
    const atual = escolhas[o.id] || 0;
    if (g.maximo === 1 && delta > 0) {
      const novo = { ...escolhas };
      for (const x of g.opcoes) delete novo[x.id];
      novo[o.id] = 1;
      return setEscolhas(novo);
    }
    if (delta > 0 && noGrupo(g) >= g.maximo) return;
    setEscolhas({ ...escolhas, [o.id]: Math.max(0, atual + delta) });
  }
  function colocar() {
    if (faltando) return avisar(`Escolha ${faltando.minimo === faltando.maximo ? faltando.minimo : `ao menos ${faltando.minimo}`} em “${faltando.nome}”`, 'erro');
    const complementos = p.complementos.flatMap((g) => g.opcoes.filter((o) => escolhas[o.id] > 0).map((o) => ({ id: o.id, nome: o.nome, preco: o.preco, quantidade: escolhas[o.id] })));
    adicionar({
      product_id: prod.id, nome: rotulo ? `${p.nome} - ${rotulo}` : p.nome, imagem: prod.imagens[0] || null, preco_unitario: unitario, quantidade: qtd, unidade: p.unidade,
      complementos, observacao: obs.trim(), maximo: prod.quantidade_maxima,
    });
    avisar(`${p.nome}${rotulo ? ` (${rotulo})` : ''} no carrinho`);
    // volta para onde o cliente estava (ou para o inicio, se abriu o produto direto por um link)
    if (window.history.state && window.history.state.idx > 0) navegar(-1); else navegar('/');
  }
  const inteiro = ['UN', 'CX'].includes(p.unidade);
  return (
    <article className="produto">
      <div className="produto-fotos">
        <div className="produto-foto">{prod.imagens.length ? <img src={prod.imagens[Math.min(foto, prod.imagens.length - 1)]} alt={p.nome} /> : <span className="sem-foto grande" aria-hidden="true">🛍</span>}</div>
        {prod.imagens.length > 1 && (
          <div className="miniaturas">
            {prod.imagens.map((u, i) => <button key={u} type="button" className={i === foto ? 'on' : ''} onClick={() => setFoto(i)} aria-label={`Foto ${i + 1}`}><img src={u} alt="" /></button>)}
          </div>
        )}
      </div>
      <div className="produto-info">
        {p.categoria && <Link className="migalha" to={`/produtos?categoria=${p.categoria.id}`}>{p.categoria.pai ? `${p.categoria.pai.nome} › ` : ''}{p.categoria.nome}</Link>}
        <h1>{p.nome}</h1>
        {(p.maior_idade || p.so_retirada) && (
          <div className="selos-produto">
            {p.maior_idade && <span className="selo-linha selo-18">+18 · venda para maiores de 18 anos</span>}
            {p.so_retirada && <span className="selo-linha">🛍 Somente retirada na loja</span>}
          </div>
        )}
        <Preco p={prod} />
        {g && (
          <div className="seletores">
            {g.atributos.map((a) => (
              <div key={a.nome} className="seletor" role="radiogroup" aria-label={a.nome}>
                <span className="seletor-nome">{a.nome}: <b>{v.variacao[a.nome]}</b></span>
                <div className="seletor-valores">
                  {a.valores.map((x) => {
                    const foto2 = a.nome === g.atributo_foto ? fotoDoValor(a.nome, x) : null;
                    return (
                      <button key={x} type="button" role="radio" aria-checked={v.variacao[a.nome] === x}
                        className={`valor ${v.variacao[a.nome] === x ? 'on' : ''} ${valorDisponivel(a.nome, x) ? '' : 'sem-estoque'} ${foto2 ? 'com-foto' : ''}`}
                        onClick={() => escolher(a.nome, x)} title={valorDisponivel(a.nome, x) ? x : `${x} (esgotado)`}>
                        {foto2 ? <img src={foto2} alt="" /> : null}<span>{x}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {p.promocao_ate && <p className="dica">Promoção válida até {p.promocao_ate.split('-').reverse().join('/')}</p>}
        {p.descricao && <p className="produto-desc">{p.descricao}</p>}
        {p.complementos.map((g) => (
          <fieldset key={g.id} className="grupo">
            <legend>{g.nome} <small>{g.minimo > 0 ? `obrigatório · ` : ''}{g.maximo === 1 ? 'escolha 1' : `até ${g.maximo}`}</small></legend>
            {g.opcoes.map((o) => (
              <div key={o.id} className="opcao">
                <span>{o.nome}{o.preco > 0 && <small> + {brl(o.preco)}</small>}</span>
                {g.maximo === 1 ? (
                  <input type="radio" name={g.id} checked={!!escolhas[o.id]} onChange={() => mudarOpcao(g, o, 1)} aria-label={o.nome} />
                ) : (
                  <span className="contador-qtd">
                    <button type="button" onClick={() => mudarOpcao(g, o, -1)} disabled={!escolhas[o.id]} aria-label={`Menos ${o.nome}`}>−</button>
                    <b>{escolhas[o.id] || 0}</b>
                    <button type="button" onClick={() => mudarOpcao(g, o, 1)} disabled={noGrupo(g) >= g.maximo} aria-label={`Mais ${o.nome}`}>+</button>
                  </span>
                )}
              </div>
            ))}
          </fieldset>
        ))}
        {p.complementos.length > 0 && (
          <label className="campo"><span>Observação</span><input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={200} placeholder="Ex.: sem cebola" /></label>
        )}
        {prod.disponivel ? (
          <div className="comprar">
            <span className="contador-qtd grande">
              <button type="button" onClick={() => setQtd(Math.max(inteiro ? 1 : 0.1, +(qtd - (inteiro ? 1 : 0.5)).toFixed(3)))} aria-label="Diminuir quantidade">−</button>
              <b>{qtd.toLocaleString('pt-BR')}{inteiro ? '' : ` ${p.unidade.toLowerCase()}`}</b>
              <button type="button" onClick={() => setQtd(Math.min(prod.quantidade_maxima, +(qtd + (inteiro ? 1 : 0.5)).toFixed(3)))} disabled={qtd >= prod.quantidade_maxima} aria-label="Aumentar quantidade">+</button>
            </span>
            <button type="button" className="botao largo" onClick={colocar}>{loja.tipo === 'cardapio' ? `Adicionar · ${brl(unitario * qtd)}` : 'Comprar'}</button>
          </div>
        ) : <p className="esgotado-aviso">{g ? `${rotulo}: esgotado no momento. Escolha outra opção.` : 'Produto esgotado no momento.'}</p>}
        {prod.disponivel && p.complementos.length === 0 && !p.so_retirada && <CalcularFrete itens={[{ product_id: prod.id, quantidade: qtd }]} />}
      </div>
    </article>
  );
}
