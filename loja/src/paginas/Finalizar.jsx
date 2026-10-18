import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLoja } from '../estado.jsx';
import FormEndereco from '../componentes/Endereco.jsx';
import CartaoMercadoPago from '../componentes/CartaoMercadoPago.jsx';
import { itensParaApi } from './Carrinho.jsx';
import { brl, parseValor } from '../util';

const NA_ENTREGA = { dinheiro: 'Dinheiro', pix: 'Pix na entrega', cartao: 'Cartão na maquininha' };

// Checkout: retirada ou entrega (endereco), forma de pagamento, observacao e resumo com os valores do servidor.
export default function Finalizar() {
  const { loja, conta, carrinho, esvaziar, carregarLoja, avisar } = useLoja();
  const navegar = useNavigate();
  const pag = loja.pagamentos;
  const [tipo, setTipo] = useState(loja.entrega.aceita ? 'entrega' : 'retirada');
  const [enderecos, setEnderecos] = useState(null);
  const [enderecoId, setEnderecoId] = useState(null);
  const [novoEndereco, setNovoEndereco] = useState(false);
  const formas = [
    ...(pag.pix_online ? [['pix', 'Pix (pague agora)']] : []),
    ...(pag.cartao_online ? [['cartao', 'Cartão de crédito']] : []),
    ...(pag.na_entrega.length ? [['na_entrega', tipo === 'entrega' ? 'Pagar na entrega' : 'Pagar na retirada']] : []),
  ];
  const [metodo, setMetodo] = useState(formas[0] ? formas[0][0] : null);
  const [formaEntrega, setFormaEntrega] = useState(pag.na_entrega[0] || 'dinheiro');
  const [troco, setTroco] = useState('');
  const [obs, setObs] = useState('');
  const [previa, setPrevia] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const cupom = (() => { try { return sessionStorage.getItem('lv_cupom') || undefined; } catch { return undefined; } })();

  useEffect(() => {
    if (!conta) return;
    api.get('/conta/enderecos').then((l) => {
      setEnderecos(l);
      const padrao = l.find((e) => e.padrao) || l[0];
      if (padrao) setEnderecoId(padrao.id); else setNovoEndereco(true);
    }).catch(() => setEnderecos([]));
  }, [conta]);
  const atualizarPrevia = useCallback(() => {
    if (carrinho.length === 0) return;
    api.post('/carrinho', { itens: itensParaApi(carrinho), tipo, endereco_id: tipo === 'entrega' ? enderecoId || undefined : undefined, cupom })
      .then(setPrevia).catch((e) => setErro(e.message));
  }, [carrinho, tipo, enderecoId, cupom]);
  useEffect(() => { atualizarPrevia(); }, [atualizarPrevia]);

  if (!conta) return <Navigate to="/entrar?depois=/finalizar" replace />;
  if (carrinho.length === 0) return <Navigate to="/carrinho" replace />;

  const semEndereco = tipo === 'entrega' && !enderecoId;
  const avisos = previa ? previa.avisos.filter((a) => !(semEndereco && /bairro|endereço/.test(a))) : [];
  const podePedir = previa && previa.pode_finalizar && !semEndereco && metodo && !enviando;

  async function pedir(cartao) {
    setErro(null);
    setEnviando(true);
    try {
      const pagamento = metodo === 'na_entrega'
        ? { metodo, forma: formaEntrega, troco_para: formaEntrega === 'dinheiro' && troco.trim() ? parseValor(troco) : undefined }
        : { metodo, cartao };
      const p = await api.post('/pedidos', { itens: itensParaApi(carrinho), tipo, endereco_id: tipo === 'entrega' ? enderecoId : undefined, cupom, observacao: obs.trim() || undefined, pagamento });
      esvaziar();
      try { sessionStorage.removeItem('lv_cupom'); } catch { /* */ }
      navegar(`/pedidos/${p.id}`, { replace: true });
    } catch (err) {
      setErro(err.message);
      if (err.status === 409) carregarLoja().catch(() => {});
      avisar(err.message, 'erro');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="bloco checkout">
      <h1>Finalizar pedido</h1>

      {loja.retirada.aceita && loja.entrega.aceita && (
        <div className="opcoes-2" role="radiogroup" aria-label="Como receber">
          <button type="button" role="radio" aria-checked={tipo === 'entrega'} className={`opcao-grande ${tipo === 'entrega' ? 'on' : ''}`} onClick={() => setTipo('entrega')}>
            <b>🛵 Entrega</b><small>{loja.entrega.tempo_estimado_min ? `cerca de ${loja.entrega.tempo_estimado_min} min` : ''}</small>
          </button>
          <button type="button" role="radio" aria-checked={tipo === 'retirada'} className={`opcao-grande ${tipo === 'retirada' ? 'on' : ''}`} onClick={() => setTipo('retirada')}>
            <b>🛍 Retirar na loja</b><small>{loja.retirada.tempo_estimado_min ? `pronto em ~${loja.retirada.tempo_estimado_min} min` : ''}</small>
          </button>
        </div>
      )}

      {tipo === 'entrega' ? (
        <div className="painel">
          <h2>Endereço de entrega</h2>
          {enderecos === null ? <div className="carregando pequeno" /> : (
            <>
              {enderecos.map((e) => (
                <label key={e.id} className={`endereco-opcao ${enderecoId === e.id ? 'on' : ''}`}>
                  <input type="radio" name="endereco" checked={enderecoId === e.id} onChange={() => { setEnderecoId(e.id); setNovoEndereco(false); }} />
                  <span><b>{e.rotulo}</b><br />{e.logradouro}, {e.numero}{e.complemento ? ` - ${e.complemento}` : ''} – {e.bairro}{e.cidade ? `, ${e.cidade}` : ''}</span>
                </label>
              ))}
              {novoEndereco ? (
                <FormEndereco onSalvo={(e) => { setEnderecos([...(enderecos || []), e]); setEnderecoId(e.id); setNovoEndereco(false); }} onCancelar={enderecos.length ? () => setNovoEndereco(false) : null} />
              ) : <button type="button" className="link" onClick={() => setNovoEndereco(true)}>+ Novo endereço</button>}
            </>
          )}
        </div>
      ) : (
        <div className="painel"><h2>Retirada</h2><p>{loja.contato.endereco || 'Retire o pedido na loja.'}</p></div>
      )}

      <div className="painel">
        <h2>Pagamento</h2>
        {formas.length === 0 && <p className="erro-texto">A loja ainda não configurou formas de pagamento.</p>}
        {formas.map(([k, nome]) => (
          <label key={k} className={`endereco-opcao ${metodo === k ? 'on' : ''}`}>
            <input type="radio" name="pagamento" checked={metodo === k} onChange={() => setMetodo(k)} />
            <span><b>{nome}</b>{k === 'pix' && <><br /><small>QR code na próxima tela; o pedido vai para a loja assim que o Pix é pago.</small></>}</span>
          </label>
        ))}
        {metodo === 'na_entrega' && (
          <div className="sub-opcoes">
            {pag.na_entrega.map((f) => (
              <label key={f} className="marcar"><input type="radio" name="forma" checked={formaEntrega === f} onChange={() => setFormaEntrega(f)} /> {NA_ENTREGA[f]}</label>
            ))}
            {formaEntrega === 'dinheiro' && <label className="campo"><span>Troco para quanto? (opcional)</span><input value={troco} onChange={(e) => setTroco(e.target.value)} inputMode="decimal" placeholder="Ex.: 50,00" /></label>}
          </div>
        )}
      </div>

      <label className="campo"><span>Observação para a loja (opcional)</span><textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} maxLength={250} /></label>

      {previa && (
        <div className="resumo">
          <div><span>Produtos</span><span>{brl(previa.subtotal)}</span></div>
          {tipo === 'entrega' && <div><span>Entrega{previa.entrega.bairro ? ` (${previa.entrega.bairro})` : ''}</span><span>{semEndereco ? '—' : previa.taxa_entrega > 0 ? brl(previa.taxa_entrega) : 'Grátis'}</span></div>}
          {previa.desconto > 0 && <div className="ok-texto"><span>Desconto{previa.cupom && previa.cupom.valido ? ` (${previa.cupom.codigo})` : ''}</span><span>− {brl(previa.desconto)}</span></div>}
          <div className="resumo-total"><span>Total</span><b>{brl(previa.total)}</b></div>
          {!semEndereco && <div className="dica"><span>Previsão: cerca de {previa.entrega.tempo_estimado_min} min</span></div>}
        </div>
      )}
      {avisos.map((a) => <p key={a} className="erro-texto">⚠ {a}</p>)}
      {erro && <p className="erro-texto">{erro}</p>}

      {metodo === 'cartao' && podePedir ? (
        <div className="painel">
          <h2>Dados do cartão</h2>
          <CartaoMercadoPago publicKey={pag.mercadopago_public_key} valor={previa.total} email={conta.email} parcelasMax={pag.parcelas_max} onPagar={(c) => pedir(c)} />
        </div>
      ) : (
        <button type="button" className="botao largo" disabled={!podePedir} onClick={() => pedir()}>
          {enviando ? 'Enviando…' : metodo === 'pix' ? 'Fazer pedido e pagar com Pix' : 'Fazer pedido'}
        </button>
      )}
      <Link to="/carrinho" className="link centro">Voltar ao carrinho</Link>
    </section>
  );
}
