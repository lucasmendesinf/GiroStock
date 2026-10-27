import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import Folha from './Folha.jsx';
import { brl } from '../util';

// Folha do produto no cardapio: foto grande, descricao, grupos de adicionais (obrigatorio/opcional, ate N), observacao e quantidade.
// O servidor confere minimo, maximo e preco dos adicionais de novo ao fazer o pedido.
export default function ProdutoFolha({ id, aoFechar }) {
  const { adicionar, avisar } = useLoja();
  const [p, setP] = useState(null);
  const [erro, setErro] = useState(null);
  const [qtd, setQtd] = useState(1);
  const [escolhas, setEscolhas] = useState({});
  const [obs, setObs] = useState('');
  useEffect(() => {
    setP(null); setErro(null); setQtd(1); setEscolhas({}); setObs('');
    api.get(`/produtos/${id}`).then(setP).catch((e) => setErro(e.message));
  }, [id]);

  if (erro) return <Folha titulo="Produto" aoFechar={aoFechar}><p className="erro-texto">{erro}</p></Folha>;
  if (!p) return <Folha titulo="Produto" aoFechar={aoFechar}><div className="carregando" aria-label="Carregando" /></Folha>;

  const noGrupo = (g) => g.opcoes.reduce((s, o) => s + (escolhas[o.id] || 0), 0);
  const faltando = p.complementos.find((g) => noGrupo(g) < g.minimo);
  const extra = p.complementos.reduce((s, g) => s + g.opcoes.reduce((t, o) => t + (escolhas[o.id] || 0) * o.preco, 0), 0);
  const unitario = p.preco + extra;
  const inteiro = ['UN', 'CX'].includes(p.unidade);
  function mudarOpcao(g, o, delta) {
    const atual = escolhas[o.id] || 0;
    if (g.maximo === 1 && delta > 0) {
      const novo = { ...escolhas };
      for (const x of g.opcoes) delete novo[x.id];
      novo[o.id] = 1;
      return setEscolhas(novo);
    }
    if (delta > 0 && noGrupo(g) >= g.maximo) return undefined;
    return setEscolhas({ ...escolhas, [o.id]: Math.max(0, atual + delta) });
  }
  function colocar() {
    if (faltando) return avisar(`Escolha ${faltando.minimo === faltando.maximo ? faltando.minimo : `ao menos ${faltando.minimo}`} em “${faltando.nome}”`, 'erro');
    const complementos = p.complementos.flatMap((g) => g.opcoes.filter((o) => escolhas[o.id] > 0).map((o) => ({ id: o.id, nome: o.nome, preco: o.preco, quantidade: escolhas[o.id] })));
    adicionar({
      product_id: p.id, nome: p.nome, imagem: p.imagens[0] || null, preco_unitario: unitario, quantidade: qtd, unidade: p.unidade,
      complementos, observacao: obs.trim(), maximo: p.quantidade_maxima,
    });
    avisar(`${p.nome} na sacola`);
    return aoFechar();
  }
  return (
    <Folha
      titulo={p.nome}
      aoFechar={aoFechar}
      rodape={p.disponivel ? (
        <div className="cd-add">
          <span className="contador-qtd grande">
            <button type="button" onClick={() => setQtd(Math.max(inteiro ? 1 : 0.5, +(qtd - (inteiro ? 1 : 0.5)).toFixed(3)))} aria-label="Diminuir quantidade">−</button>
            <b>{qtd.toLocaleString('pt-BR')}{inteiro ? '' : ` ${p.unidade.toLowerCase()}`}</b>
            <button type="button" onClick={() => setQtd(Math.min(p.quantidade_maxima, +(qtd + (inteiro ? 1 : 0.5)).toFixed(3)))} disabled={qtd >= p.quantidade_maxima} aria-label="Aumentar quantidade">+</button>
          </span>
          <button type="button" className="botao largo" onClick={colocar}>Adicionar · {brl(unitario * qtd)}</button>
        </div>
      ) : <p className="esgotado-aviso">Produto indisponível no momento.</p>}
    >
      {p.imagens[0] && <img className="cd-produto-foto" src={p.imagens[0]} alt="" />}
      <div className="cd-produto-preco">
        {p.preco_original && <s>{brl(p.preco_original)}</s>}
        <b>{brl(p.preco)}</b>
      </div>
      {p.descricao && <p className="cd-produto-desc">{p.descricao}</p>}
      {(p.maior_idade || p.so_retirada) && (
        <div className="selos-produto">
          {p.maior_idade && <span className="selo-linha selo-18">+18 · venda para maiores de 18 anos</span>}
          {p.so_retirada && <span className="selo-linha">🛍 Somente retirada na loja</span>}
        </div>
      )}
      {p.complementos.map((g) => (
        <fieldset key={g.id} className="grupo">
          <legend>{g.nome} <small>{g.minimo > 0 ? 'obrigatório · ' : 'opcional · '}{g.maximo === 1 ? 'escolha 1' : `até ${g.maximo}`}</small></legend>
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
      <label className="campo cd-obs"><span>Observação</span><input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={200} placeholder="Ex.: sem cebola" /></label>
    </Folha>
  );
}
