import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import CartaoMercadoPago from '../componentes/CartaoMercadoPago.jsx';
import { brl, dataHora, soDigitos } from '../util';

const PASSOS_ENTREGA = [['recebido', 'Recebido'], ['em_preparo', 'Em preparo'], ['pronto', 'Pronto'], ['saiu_entrega', 'Saiu para entrega'], ['entregue', 'Entregue']];
const PASSOS_RETIRADA = [['recebido', 'Recebido'], ['em_preparo', 'Em preparo'], ['pronto_retirada', 'Pronto para retirar'], ['retirado', 'Retirado']];
const NA_ENTREGA = { dinheiro: 'Dinheiro', pix: 'Pix', cartao: 'Cartão' };

// Acompanhamento do pedido: atualiza sozinho; Pix com QR code e copia e cola; nova tentativa de pagamento; cancelar.
export default function Pedido() {
  const { id } = useParams();
  const { loja, conta, avisar } = useLoja();
  const [p, setP] = useState(null);
  const [erro, setErro] = useState(null);
  const [pagarCom, setPagarCom] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const carregar = useCallback(() => api.get(`/pedidos/${id}`).then(setP).catch(setErro), [id]);
  useEffect(() => {
    if (!conta) return undefined;
    carregar();
    const t = setInterval(carregar, 8000);
    return () => clearInterval(t);
  }, [carregar, conta]);
  if (!conta) return <Navigate to={`/entrar?depois=/pedidos/${id}`} replace />;
  if (erro) return <p className="vazio">Pedido não encontrado. <Link to="/pedidos">Meus pedidos</Link></p>;
  if (!p) return <div className="carregando" aria-label="Carregando" />;

  const passos = p.tipo === 'entrega' ? PASSOS_ENTREGA : PASSOS_RETIRADA;
  const atual = passos.findIndex(([k]) => k === p.etapa);
  const quando = (k) => { const h = p.historico.find((x) => x.etapa === k || (k === 'pronto_retirada' && x.etapa === 'pronto') || ((k === 'entregue' || k === 'retirado') && x.etapa === 'finalizado')); return h ? dataHora(h.em).slice(-5) : ''; };
  const pix = p.pagamento.detalhe && p.pagamento.detalhe.pix;
  const pg = loja.pagamentos;

  async function copiar(t) {
    try { await navigator.clipboard.writeText(t); avisar('Código Pix copiado'); } catch { avisar('Selecione o código e copie', 'erro'); }
  }
  async function novoPagamento(metodo, cartao) {
    setEnviando(true);
    try { setP(await api.post(`/pedidos/${p.id}/pagamento`, { metodo, cartao })); setPagarCom(null); } catch (err) { avisar(err.message, 'erro'); } finally { setEnviando(false); }
  }
  async function cancelar() {
    if (!window.confirm(p.pagamento.situacao === 'aprovado' ? 'Cancelar o pedido? O valor pago volta para você pelo Mercado Pago.' : 'Cancelar o pedido?')) return;
    try { setP(await api.post(`/pedidos/${p.id}/cancelar`, { motivo: 'desisti da compra' })); avisar('Pedido cancelado'); } catch (err) { avisar(err.message, 'erro'); }
  }

  return (
    <section className="bloco pedido">
      <div className="bloco-topo"><h1>Pedido #{p.numero}</h1><span className={`etiqueta etapa-${p.etapa}`}>{p.etapa_nome}</span></div>
      <p className="dica">Feito em {dataHora(p.criado_em)}{p.previsao_min && p.etapa !== 'aguardando_pagamento' ? ` · previsão de ${p.previsao_min} min` : ''}</p>

      {p.etapa === 'cancelado' && <div className="painel alerta">Pedido cancelado{p.motivo_cancelamento ? `: ${p.motivo_cancelamento}` : ''}.{p.pagamento.situacao === 'estornado' ? ' O valor pago foi devolvido pelo Mercado Pago.' : ''}</div>}

      {p.etapa === 'aguardando_pagamento' && (
        <div className="painel destaque-pagamento">
          {pix && p.pagamento.situacao === 'pendente' ? (
            <>
              <h2>Pague com Pix para confirmar</h2>
              {pix.qr_code_base64 && <img className="qr" src={`data:image/png;base64,${pix.qr_code_base64}`} alt="QR code do Pix" />}
              <p className="dica">Abra o app do banco, escolha Pix &gt; Pix Copia e Cola e cole o código.{pix.expira_em ? ` Válido até ${dataHora(pix.expira_em).slice(-5)}.` : ''}</p>
              <div className="copia-cola"><code>{pix.copia_e_cola}</code><button type="button" className="botao" onClick={() => copiar(pix.copia_e_cola)}>Copiar código</button></div>
              <p className="dica">Assim que o pagamento cair, esta página atualiza sozinha.</p>
            </>
          ) : (
            <>
              <h2>Pagamento não concluído</h2>
              <p>{p.pagamento.detalhe && p.pagamento.detalhe.motivo_recusa ? `Cartão recusado: ${p.pagamento.detalhe.motivo_recusa}.` : p.pagamento.situacao === 'expirado' ? 'O Pix expirou.' : 'Aguardando o pagamento.'} Tente de novo:</p>
            </>
          )}
          {p.pode_pagar && (p.pagamento.situacao !== 'pendente' || !pix) && (
            <div className="botoes">
              {pg.pix_online && <button type="button" className="botao" disabled={enviando} onClick={() => novoPagamento('pix')}>Pagar com Pix</button>}
              {pg.cartao_online && <button type="button" className="botao botao-claro" onClick={() => setPagarCom('cartao')}>Pagar com cartão</button>}
            </div>
          )}
          {pagarCom === 'cartao' && <CartaoMercadoPago publicKey={pg.mercadopago_public_key} valor={p.total} email={conta.email} parcelasMax={pg.parcelas_max} onPagar={(c) => novoPagamento('cartao', c)} />}
        </div>
      )}

      {p.etapa !== 'cancelado' && p.etapa !== 'aguardando_pagamento' && (
        <ol className="linha-tempo">
          {passos.map(([k, nome], i) => (
            <li key={k} className={i < atual ? 'feito' : i === atual ? 'atual' : ''}><span className="ponto" /><span>{nome}</span><small>{i <= atual ? quando(k) : ''}</small></li>
          ))}
        </ol>
      )}

      <div className="painel">
        <h2>{p.tipo === 'entrega' ? 'Entrega' : 'Retirada'}</h2>
        <p>{p.tipo === 'entrega' ? p.endereco : (loja.contato.endereco || 'Retirar na loja')}</p>
      </div>

      <div className="painel">
        <h2>Itens</h2>
        <ul className="itens-pedido">
          {p.itens.map((i, n) => (
            <li key={n}>
              <span>{Number(i.quantidade).toLocaleString('pt-BR')}× {i.nome}{i.complementos.length > 0 && <small>{i.complementos.map((c) => `${c.quantidade > 1 ? `${c.quantidade}x ` : ''}${c.nome}`).join(', ')}</small>}{i.observacao && <small>Obs.: {i.observacao}</small>}</span>
              <span>{brl(i.subtotal)}</span>
            </li>
          ))}
        </ul>
        <div className="resumo">
          <div><span>Produtos</span><span>{brl(p.subtotal)}</span></div>
          {p.tipo === 'entrega' && <div><span>Entrega</span><span>{p.taxa_entrega > 0 ? brl(p.taxa_entrega) : 'Grátis'}</span></div>}
          {p.desconto > 0 && <div className="ok-texto"><span>Desconto{p.cupom ? ` (${p.cupom})` : ''}</span><span>− {brl(p.desconto)}</span></div>}
          <div className="resumo-total"><span>Total</span><b>{brl(p.total)}</b></div>
          <div className="dica"><span>
            {p.pagamento.tipo === 'online'
              ? `${p.pagamento.metodo === 'pix' ? 'Pix' : 'Cartão'} pelo site · ${{ aprovado: 'pago', pendente: 'aguardando', recusado: 'recusado', expirado: 'expirado', estornado: 'devolvido' }[p.pagamento.situacao] || p.pagamento.situacao}`
              : `Pagar na ${p.tipo === 'entrega' ? 'entrega' : 'retirada'}: ${NA_ENTREGA[p.pagamento.forma] || p.pagamento.forma}${p.pagamento.troco_para ? ` (troco para ${brl(p.pagamento.troco_para)})` : ''}`}
          </span></div>
        </div>
      </div>

      <div className="botoes">
        {loja.contato.whatsapp && <a className="botao botao-claro" href={`https://wa.me/55${soDigitos(loja.contato.whatsapp)}?text=${encodeURIComponent(`Olá! Sobre o meu pedido #${p.numero}`)}`} target="_blank" rel="noreferrer">Falar com a loja</a>}
        {p.pode_cancelar && <button type="button" className="botao botao-perigo" onClick={cancelar}>Cancelar pedido</button>}
      </div>
      <Link to="/pedidos" className="link centro">Meus pedidos</Link>
    </section>
  );
}
