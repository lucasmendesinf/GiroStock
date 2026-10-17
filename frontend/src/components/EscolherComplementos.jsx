import { useMemo, useState } from 'react';
import { Modal } from './ui.jsx';
import { brl } from '../utils/format';

// Texto curto dos complementos de um item: "+ 2× Bacon extra, Cheddar".
export function textoComplementos(lista) {
  if (!lista || lista.length === 0) return '';
  return `+ ${lista.map((c) => `${Number(c.quantidade) > 1 ? `${Number(c.quantidade)}× ` : ''}${c.nome}`).join(', ')}`;
}
export const precoComplementos = (lista) => (lista || []).reduce((s, c) => s + Number(c.preco) * Number(c.quantidade), 0);
// Mesma escolha de complementos (para juntar linhas iguais no carrinho).
export const assinatura = (lista) => (lista || []).map((c) => `${c.id}:${c.quantidade}`).sort().join('|');

// Escolha dos complementos de um produto (grupos com minimo/maximo). Devolve [{ id, nome, quantidade, preco }].
export default function EscolherComplementos({ produto, onConfirmar, onClose }) {
  const grupos = produto.grupos || [];
  const [qtds, setQtds] = useState({}); // complemento_id -> quantidade
  const totalDo = (g) => g.opcoes.reduce((s, o) => s + (qtds[o.id] || 0), 0);
  const problemas = useMemo(() => grupos.filter((g) => totalDo(g) < g.minimo).map((g) => g.nome), [qtds, grupos]); // eslint-disable-line react-hooks/exhaustive-deps
  const escolhidos = grupos.flatMap((g) => g.opcoes.filter((o) => qtds[o.id] > 0).map((o) => ({ id: o.id, nome: o.nome, quantidade: qtds[o.id], preco: Number(o.preco) })));
  const preco = Number(produto.preco_venda) + precoComplementos(escolhidos);

  function mudar(g, o, delta) {
    const atual = qtds[o.id] || 0;
    if (g.maximo === 1) {
      // Escolha unica: marca esta e desmarca as outras do grupo (clicar de novo desmarca, se nao for obrigatorio).
      const novo = { ...qtds };
      for (const x of g.opcoes) delete novo[x.id];
      if (!(atual > 0 && g.minimo === 0)) novo[o.id] = 1;
      setQtds(novo);
      return;
    }
    const q = Math.max(0, atual + delta);
    if (delta > 0 && totalDo(g) >= g.maximo) return;
    setQtds({ ...qtds, [o.id]: q });
  }
  function confirmar(e) {
    if (e) e.preventDefault();
    if (problemas.length) return;
    onConfirmar(escolhidos);
  }

  return (
    <Modal titulo={produto.nome} subtitulo="Escolha os complementos" onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={confirmar}>
        {grupos.map((g) => (
          <div key={g.id} className="comp-escolha">
            <div className="comp-escolha-titulo">
              <b>{g.nome}</b>
              <span className={`ped-pill ${g.minimo > 0 ? (totalDo(g) >= g.minimo ? 'ok' : 'warn') : ''}`}>
                {g.minimo > 0 ? `obrigatório${g.maximo > 1 ? ` · ${g.minimo === g.maximo ? g.minimo : `${g.minimo} a ${g.maximo}`}` : ''}` : `opcional · até ${g.maximo}`}
              </span>
            </div>
            {g.opcoes.map((o) => {
              const q = qtds[o.id] || 0;
              return (
                <div key={o.id} className={`comp-opcao ${q > 0 ? 'on' : ''}`}>
                  {g.maximo === 1 ? (
                    <button type="button" className="comp-opcao-btn" onClick={() => mudar(g, o, 1)} aria-pressed={q > 0}>
                      <span className="comp-radio" />{o.nome}
                    </button>
                  ) : (
                    <span className="comp-opcao-btn">{o.nome}</span>
                  )}
                  <span className="muted">{Number(o.preco) > 0 ? `+ ${brl(o.preco)}` : 'grátis'}</span>
                  {g.maximo > 1 && (
                    <span className="carrinho-qtd">
                      <button type="button" aria-label={`Menos ${o.nome}`} onClick={() => mudar(g, o, -1)} disabled={q === 0}>−</button>
                      <span className="comp-q">{q}</span>
                      <button type="button" aria-label={`Mais ${o.nome}`} onClick={() => mudar(g, o, 1)} disabled={totalDo(g) >= g.maximo}>+</button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {problemas.length > 0 && <div className="form-hint">Falta escolher: {problemas.join(', ')}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={problemas.length > 0}>Adicionar · {brl(preco)}</button>
        </div>
      </form>
    </Modal>
  );
}
