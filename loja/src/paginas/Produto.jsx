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
  useEffect(() => {
    setP(null); setFoto(0); setQtd(1); setEscolhas({}); setObs('');
    api.get(`/produtos/${id}`).then(setP).catch(setErro);
  }, [id]);
  if (erro) return <p className="vazio">Produto não encontrado. <Link to="/produtos">Ver produtos</Link></p>;
  if (!p) return <div className="carregando" aria-label="Carregando" />;

  const noGrupo = (g) => g.opcoes.reduce((s, o) => s + (escolhas[o.id] || 0), 0);
  const faltando = p.complementos.find((g) => noGrupo(g) < g.minimo);
  const extra = p.complementos.reduce((s, g) => s + g.opcoes.reduce((t, o) => t + (escolhas[o.id] || 0) * o.preco, 0), 0);
  const unitario = p.preco + extra;
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
      product_id: p.id, nome: p.nome, imagem: p.imagens[0] || null, preco_unitario: unitario, quantidade: qtd, unidade: p.unidade,
      complementos, observacao: obs.trim(), maximo: p.quantidade_maxima,
    });
    avisar(`${p.nome} no carrinho`);
    // volta para onde o cliente estava (ou para o inicio, se abriu o produto direto por um link)
    if (window.history.state && window.history.state.idx > 0) navegar(-1); else navegar('/');
  }
  const inteiro = ['UN', 'CX'].includes(p.unidade);
  return (
    <article className="produto">
      <div className="produto-fotos">
        <div className="produto-foto">{p.imagens.length ? <img src={p.imagens[foto]} alt={p.nome} /> : <span className="sem-foto grande" aria-hidden="true">🛍</span>}</div>
        {p.imagens.length > 1 && (
          <div className="miniaturas">
            {p.imagens.map((u, i) => <button key={u} type="button" className={i === foto ? 'on' : ''} onClick={() => setFoto(i)} aria-label={`Foto ${i + 1}`}><img src={u} alt="" /></button>)}
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
        <Preco p={p} />
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
        {p.disponivel ? (
          <div className="comprar">
            <span className="contador-qtd grande">
              <button type="button" onClick={() => setQtd(Math.max(inteiro ? 1 : 0.1, +(qtd - (inteiro ? 1 : 0.5)).toFixed(3)))} aria-label="Diminuir quantidade">−</button>
              <b>{qtd.toLocaleString('pt-BR')}{inteiro ? '' : ` ${p.unidade.toLowerCase()}`}</b>
              <button type="button" onClick={() => setQtd(Math.min(p.quantidade_maxima, +(qtd + (inteiro ? 1 : 0.5)).toFixed(3)))} disabled={qtd >= p.quantidade_maxima} aria-label="Aumentar quantidade">+</button>
            </span>
            <button type="button" className="botao largo" onClick={colocar}>{loja.tipo === 'cardapio' ? `Adicionar · ${brl(unitario * qtd)}` : 'Comprar'}</button>
          </div>
        ) : <p className="esgotado-aviso">Produto esgotado no momento.</p>}
        {p.disponivel && p.complementos.length === 0 && !p.so_retirada && <CalcularFrete itens={[{ product_id: p.id, quantidade: qtd }]} />}
      </div>
    </article>
  );
}
