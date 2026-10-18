import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import { brl, chaveItem } from '../util';

export const itensParaApi = (carrinho) => carrinho.map((i) => ({
  product_id: i.product_id, quantidade: i.quantidade, observacao: i.observacao || undefined,
  complementos: (i.complementos || []).map((c) => ({ id: c.id, quantidade: c.quantidade })),
}));

// Carrinho: itens, quantidades, cupom e a previa do servidor (precos atuais, estoque, minimo).
export default function Carrinho() {
  const { loja, carrinho, mudarQuantidade, esvaziar, conta } = useLoja();
  const navegar = useNavigate();
  const [cupom, setCupom] = useState(() => sessionStorage.getItem('lv_cupom') || '');
  const [cupomAplicado, setCupomAplicado] = useState(() => sessionStorage.getItem('lv_cupom') || '');
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState(null);
  useEffect(() => {
    if (carrinho.length === 0) { setPrevia(null); return; }
    setErro(null);
    api.post('/carrinho', { itens: itensParaApi(carrinho), tipo: loja.retirada.aceita ? 'retirada' : 'entrega', cupom: cupomAplicado || undefined })
      .then(setPrevia).catch((e) => { setPrevia(null); setErro(e.message); });
  }, [carrinho, cupomAplicado, loja]);
  useEffect(() => { try { if (cupomAplicado) sessionStorage.setItem('lv_cupom', cupomAplicado); else sessionStorage.removeItem('lv_cupom'); } catch { /* */ } }, [cupomAplicado]);

  if (carrinho.length === 0) {
    return (
      <section className="bloco vazio-grande">
        <h1>Seu carrinho está vazio</h1>
        <Link to="/" className="botao">Ver produtos</Link>
      </section>
    );
  }
  // avisos que nao dependem do endereco (estoque, minimo, loja fechada)
  const avisos = previa ? previa.avisos : [];
  return (
    <section className="bloco carrinho">
      <div className="bloco-topo"><h1>Carrinho</h1><button type="button" className="link" onClick={esvaziar}>Esvaziar</button></div>
      <ul className="itens">
        {carrinho.map((i) => {
          const k = chaveItem(i);
          const inteiro = ['UN', 'CX'].includes(i.unidade || 'UN');
          const passo = inteiro ? 1 : 0.5;
          return (
            <li key={k} className="item">
              <span className="item-foto">{i.imagem ? <img src={i.imagem} alt="" /> : <span aria-hidden="true">🛍</span>}</span>
              <span className="item-info">
                <Link to={`/produto/${i.product_id}`} className="item-nome">{i.nome}</Link>
                {i.complementos && i.complementos.length > 0 && <small>{i.complementos.map((c) => `${c.quantidade > 1 ? `${c.quantidade}x ` : ''}${c.nome}`).join(', ')}</small>}
                {i.observacao && <small>Obs.: {i.observacao}</small>}
                <span className="item-linha">
                  <span className="contador-qtd">
                    <button type="button" onClick={() => mudarQuantidade(k, +(i.quantidade - passo).toFixed(3))} aria-label={`Diminuir ${i.nome}`}>−</button>
                    <b>{i.quantidade.toLocaleString('pt-BR')}</b>
                    <button type="button" onClick={() => mudarQuantidade(k, Math.min(i.maximo || 99, +(i.quantidade + passo).toFixed(3)))} aria-label={`Aumentar ${i.nome}`}>+</button>
                  </span>
                  <b>{brl(i.preco_unitario * i.quantidade)}</b>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <form className="cupom" onSubmit={(e) => { e.preventDefault(); setCupomAplicado(cupom.trim().toUpperCase()); }}>
        <input value={cupom} onChange={(e) => setCupom(e.target.value.toUpperCase())} placeholder="Cupom de desconto" aria-label="Cupom de desconto" />
        <button type="submit" className="botao botao-claro">Aplicar</button>
      </form>
      {previa && previa.cupom && (
        <p className={previa.cupom.valido ? 'ok-texto' : 'erro-texto'}>
          {previa.cupom.valido ? `Cupom ${previa.cupom.codigo} aplicado` : `Cupom ${previa.cupom.codigo}: ${previa.cupom.motivo}`}
          {' '}<button type="button" className="link" onClick={() => { setCupom(''); setCupomAplicado(''); }}>remover</button>
        </p>
      )}
      {erro && <p className="erro-texto">{erro}</p>}
      {avisos.map((a) => <p key={a} className="erro-texto">⚠ {a}</p>)}
      {previa && (
        <div className="resumo">
          <div><span>Subtotal</span><span>{brl(previa.subtotal)}</span></div>
          {previa.desconto > 0 && <div className="ok-texto"><span>Desconto</span><span>− {brl(previa.desconto)}</span></div>}
          <div className="dica"><span>{loja.entrega.aceita ? 'Entrega calculada na próxima etapa' : 'Retirada na loja'}</span></div>
          <div className="resumo-total"><span>Total</span><b>{brl(previa.total)}</b></div>
        </div>
      )}
      <button type="button" className="botao largo" disabled={!previa || !loja.recebendo_pedidos}
        onClick={() => navegar(conta ? '/finalizar' : '/entrar?depois=/finalizar')}>
        {loja.recebendo_pedidos ? 'Continuar' : 'Loja fechada no momento'}
      </button>
      <Link to="/" className="link centro">Continuar comprando</Link>
    </section>
  );
}
