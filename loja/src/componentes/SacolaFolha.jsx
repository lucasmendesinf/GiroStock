import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import Folha from './Folha.jsx';
import { itensParaApi } from '../paginas/Carrinho.jsx';
import { brl, chaveItem } from '../util';

// Sacola do cardapio: itens (alterar/remover), entrega x retirada, bairro e o resumo calculado pelo servidor
// (taxa, pedido minimo, estoque). O pagamento e escolhido na etapa seguinte (Finalizar).
export default function SacolaFolha({ tipo, setTipo, bairro, setBairro, aoFechar, aoContinuar }) {
  const { loja, carrinho, mudarQuantidade, esvaziar } = useLoja();
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState(null);
  const aceitaEntrega = loja.entrega.aceita;
  const aceitaRetirada = loja.retirada.aceita;
  const bairros = loja.entrega.bairros;
  const comOutros = !!loja.entrega.outros_bairros;
  const noLocal = loja.entrega.local;

  useEffect(() => {
    if (carrinho.length === 0) { setPrevia(null); return; }
    setErro(null);
    api.post('/carrinho', { itens: itensParaApi(carrinho), tipo, bairro: tipo === 'entrega' && noLocal ? bairro || undefined : undefined })
      .then(setPrevia).catch((e) => { setPrevia(null); setErro(e.message); });
  }, [carrinho, tipo, bairro, noLocal]);

  if (carrinho.length === 0) {
    return <Folha titulo="Sacola" aoFechar={aoFechar}><p className="vazio">Sua sacola está vazia.</p></Folha>;
  }
  const falta = previa && previa.pedido_minimo > 0 && previa.subtotal < previa.pedido_minimo ? previa.pedido_minimo - previa.subtotal : 0;
  const avisos = previa ? previa.avisos.filter((a) => !/pedido mínimo/.test(a)) : [];
  const precisaBairro = tipo === 'entrega' && noLocal && !bairro && (bairros.length > 0 || comOutros);
  const fechada = !loja.recebendo_pedidos;
  const pode = previa && !falta && avisos.length === 0 && !fechada && !precisaBairro;
  return (
    <Folha
      titulo="Sua sacola"
      aoFechar={aoFechar}
      rodape={(
        <button type="button" className="botao largo" disabled={!pode} onClick={aoContinuar}>
          {fechada ? 'Loja fechada no momento' : falta ? `Faltam ${brl(falta)} para o pedido mínimo` : precisaBairro ? 'Escolha o bairro' : `Continuar · ${previa ? brl(previa.total) : ''}`}
        </button>
      )}
    >
      <ul className="itens cd-itens">
        {carrinho.map((i) => {
          const k = chaveItem(i);
          const inteiro = ['UN', 'CX'].includes(i.unidade || 'UN');
          const passo = inteiro ? 1 : 0.5;
          return (
            <li key={k} className="item">
              <span className="item-info">
                <b className="item-nome">{i.nome}</b>
                {i.complementos && i.complementos.length > 0 && <small>{i.complementos.map((c) => `${c.quantidade > 1 ? `${c.quantidade}x ` : ''}${c.nome}`).join(', ')}</small>}
                {i.observacao && <small>Obs.: {i.observacao}</small>}
                <span className="item-linha">
                  <span className="contador-qtd">
                    <button type="button" onClick={() => mudarQuantidade(k, +(i.quantidade - passo).toFixed(3))} aria-label={i.quantidade <= passo ? `Remover ${i.nome}` : `Diminuir ${i.nome}`}>{i.quantidade <= passo ? '🗑' : '−'}</button>
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
      <button type="button" className="link" onClick={() => { esvaziar(); aoFechar(); }}>Esvaziar sacola</button>

      {aceitaEntrega && aceitaRetirada && !(previa && previa.so_retirada) && (
        <div className="opcoes-2" role="radiogroup" aria-label="Como receber">
          <button type="button" role="radio" aria-checked={tipo === 'entrega'} className={`opcao-grande ${tipo === 'entrega' ? 'on' : ''}`} onClick={() => setTipo('entrega')}>
            <b>🛵 Entrega</b><small>{loja.entrega.tempo_estimado_min ? `~${loja.entrega.tempo_estimado_min} min` : ''}</small>
          </button>
          <button type="button" role="radio" aria-checked={tipo === 'retirada'} className={`opcao-grande ${tipo === 'retirada' ? 'on' : ''}`} onClick={() => setTipo('retirada')}>
            <b>🛍 Retirada</b><small>{loja.retirada.tempo_estimado_min ? `~${loja.retirada.tempo_estimado_min} min` : ''}</small>
          </button>
        </div>
      )}
      {previa && previa.so_retirada && <p className="dica">🛍 Há item só para retirada na loja.</p>}
      {tipo === 'entrega' && noLocal && (bairros.length > 0 || comOutros) && (
        <label className="campo"><span>Bairro da entrega</span>
          <select value={bairro} onChange={(e) => setBairro(e.target.value)}>
            <option value="">Escolha o bairro</option>
            {bairros.map((b) => <option key={b.id} value={b.nome}>{b.nome} · {b.taxa > 0 ? brl(b.taxa) : 'grátis'}</option>)}
            {comOutros && <option value="Outros bairros">Outros bairros · {loja.entrega.outros_bairros.taxa > 0 ? brl(loja.entrega.outros_bairros.taxa) : 'grátis'}</option>}
          </select>
        </label>
      )}

      {erro && <p className="erro-texto">{erro}</p>}
      {avisos.map((a) => <p key={a} className="erro-texto">⚠ {a}</p>)}
      {previa && (
        <div className="resumo">
          <div><span>Produtos</span><span>{brl(previa.subtotal)}</span></div>
          {tipo === 'entrega' && <div><span>Entrega{previa.entrega.bairro ? ` (${previa.entrega.bairro})` : ''}</span><span>{precisaBairro ? '—' : previa.taxa_entrega > 0 ? brl(previa.taxa_entrega) : 'Grátis'}</span></div>}
          {previa.desconto > 0 && <div className="ok-texto"><span>Desconto</span><span>− {brl(previa.desconto)}</span></div>}
          <div className="resumo-total"><span>Total</span><b>{brl(previa.total)}</b></div>
          {previa.pedido_minimo > 0 && <div className="dica"><span>Pedido mínimo {brl(previa.pedido_minimo)}</span></div>}
        </div>
      )}
    </Folha>
  );
}
