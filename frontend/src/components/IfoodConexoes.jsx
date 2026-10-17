import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

const ROTULO = {
  aguardando_codigo: ['warn', 'Aguardando autorização'], escolher_loja: ['warn', 'Escolher a loja do iFood'],
  conectado: ['ok', 'Conectado'], reautorizar: ['err', 'Reconectar'], desconectado: ['', 'Desconectado'],
};
const quando = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca');

// iFood por loja (Lojas & PDVs): conectar (codigo de vinculo -> Portal do Parceiro -> codigo de autorizacao),
// aceite automatico, buscar agora e desconectar.
export default function IfoodConexoes({ lojas }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [dados, setDados] = useState(null);
  const [conectando, setConectando] = useState(null); // { loja, id, codigo, link } ou { loja, id, lojas } (escolher)
  const [cardapio, setCardapio] = useState(null); // { integ, loja }

  const carregar = useCallback(() => api.get('/integracoes').then(setDados).catch((err) => toast.erro(err)), [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!dados) return null;

  const porLoja = Object.fromEntries(dados.integracoes.filter((i) => i.plataforma === 'ifood').map((i) => [i.location_id, i]));
  async function conectar(loja) {
    try { const r = await api.post('/integracoes/ifood/conectar', { location_id: loja.id }); setConectando({ loja, ...r }); carregar(); } catch (err) { toast.erro(err); }
  }
  async function alternarAceite(i) {
    try { await api.patch(`/integracoes/${i.id}`, { aceite_automatico: !i.aceite_automatico }); toast.sucesso(!i.aceite_automatico ? 'Aceite automático ligado' : 'Aceite automático desligado'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function buscar(i) {
    try { const r = await api.post(`/integracoes/${i.id}/sincronizar`); toast.sucesso(r.eventos ? `${r.eventos} novidade(s) do iFood recebida(s)` : 'Nenhuma novidade no iFood agora'); carregar(); } catch (err) { toast.erro(err); }
  }
  async function desconectar(i, loja) {
    if (!(await confirmar({ titulo: `Desconectar o iFood da loja ${loja.nome}?`, mensagem: 'Os pedidos do iFood deixam de entrar no GiroStock. Para voltar, é preciso conectar de novo.', confirmar: 'Desconectar', perigo: true }))) return;
    try { await api.del(`/integracoes/${i.id}`); toast.sucesso('iFood desconectado'); carregar(); } catch (err) { toast.erro(err); }
  }

  return (
    <div className="card ifood-card">
      <div className="ped-head" style={{ margin: '0 0 6px' }}><h3 style={{ margin: 0 }}><span className="ped-tag ifood">iFood</span> Receber pedidos do iFood</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>Os pedidos do iFood entram sozinhos na tela <b>Pedidos</b> da loja conectada (verificação a cada 30 segundos), reservam o estoque e o aceite, o preparo, a entrega e os cancelamentos ficam sincronizados com o iFood.</p>
      {!dados.ifood_configurado && <div className="ped-nota" style={{ borderColor: 'var(--warn)' }}>A integração ainda não foi ativada no servidor (aguardando as credenciais do app no Portal do Desenvolvedor iFood).</div>}
      {lojas.filter((l) => l.ativo).map((l) => {
        const i = porLoja[l.id];
        const [cor, rot] = ROTULO[i ? i.status : 'desconectado'];
        const ligado = i && i.status === 'conectado';
        return (
          <div key={l.id} className="ifood-loja">
            <div>
              <b>{l.nome}</b> <span className={`ped-pill ${cor}`}>{rot}</span>
              {ligado && <div className="form-hint" style={{ margin: '2px 0 0' }}>Loja no iFood: <b>{i.merchant_nome}</b> · última verificação {quando(i.ultimo_polling_em)}</div>}
              {i && i.ultimo_erro && i.status !== 'desconectado' && <div className="form-hint" style={{ margin: '2px 0 0', color: 'var(--err)' }}>Último problema ({quando(i.ultimo_erro_em)}): {i.ultimo_erro}</div>}
            </div>
            <div className="row-actions" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              {ligado && (
                <label className="check" title="Aceita no iFood assim que o pedido chega, se todos os itens estão vinculados e há estoque">
                  <input type="checkbox" checked={i.aceite_automatico} onChange={() => alternarAceite(i)} /> Aceitar automaticamente
                </label>
              )}
              {ligado && <button type="button" className="btn-link" onClick={() => setCardapio({ integ: i, loja: l })}>Cardápio no iFood</button>}
              {ligado && <button type="button" className="btn-link" onClick={() => buscar(i)}>Buscar agora</button>}
              {ligado && <button type="button" className="btn-link perigo" onClick={() => desconectar(i, l)}>Desconectar</button>}
              {!ligado && i && i.status === 'aguardando_codigo' && i.codigo_vinculo && (
                <button type="button" className="btn-link" onClick={() => setConectando({ loja: l, id: i.id, codigo: i.codigo_vinculo, link: null })}>Continuar conexão</button>
              )}
              {!ligado && i && i.status === 'escolher_loja' && (
                <button type="button" className="btn-link" onClick={() => setConectando({ loja: l, id: i.id, lojas: i.lojas_disponiveis })}>Escolher a loja do iFood</button>
              )}
              {!ligado && dados.ifood_configurado && <button type="button" className="btn-primario" onClick={() => conectar(l)}>{i && i.status === 'reautorizar' ? 'Reconectar iFood' : 'Conectar iFood'}</button>}
            </div>
          </div>
        );
      })}
      {cardapio && <CardapioModal {...cardapio} onClose={() => setCardapio(null)} />}
      {conectando && <ConectarModal estado={conectando} onClose={() => { setConectando(null); carregar(); }} />}
    </div>
  );
}

function ConectarModal({ estado, onClose }) {
  const toast = useToast();
  const [codigo, setCodigo] = useState('');
  const [lojas, setLojas] = useState(estado.lojas || null);
  const [escolha, setEscolha] = useState(estado.lojas && estado.lojas[0] ? estado.lojas[0].id : '');
  const [salvando, setSalvando] = useState(false);
  async function concluir(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const r = await api.post(`/integracoes/${estado.id}/concluir`, { codigo });
      if (r.status === 'escolher_loja') { setLojas(r.lojas); setEscolha(r.lojas[0] ? r.lojas[0].id : ''); }
      else { toast.sucesso(`iFood conectado: ${r.merchant_nome}`); onClose(); }
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  async function escolher(e) {
    e.preventDefault();
    setSalvando(true);
    try { const r = await api.post(`/integracoes/${estado.id}/loja`, { merchant_id: escolha }); toast.sucesso(`iFood conectado: ${r.merchant_nome}`); onClose(); } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo={`Conectar o iFood · ${estado.loja.nome}`} onClose={onClose} largura="larga">
      {lojas ? (
        <form className="form-stack" onSubmit={escolher}>
          <p>Sua conta do iFood tem mais de uma loja. Qual delas é a <b>{estado.loja.nome}</b>?</p>
          <Field label="Loja no iFood"><select value={escolha} onChange={(e) => setEscolha(e.target.value)} autoFocus>{lojas.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select></Field>
          <div className="modal-actions"><button type="button" onClick={onClose}>Depois</button><button type="submit" disabled={!escolha || salvando}>Conectar esta loja</button></div>
        </form>
      ) : (
        <form className="form-stack" onSubmit={concluir}>
          <ol className="ifood-passos">
            <li>Abra o <b>Portal do Parceiro iFood</b> com o login da loja{estado.link ? <> — <a href={estado.link} target="_blank" rel="noreferrer">abrir o portal com o código</a></> : ' (Aplicativos → Vincular aplicativo)'}.</li>
            <li>Informe o código de vínculo: <span className="ifood-codigo">{estado.codigo}</span> <span className="muted">(vale por 10 minutos)</span></li>
            <li>Autorize o <b>GiroStock</b>. O portal mostra um <b>código de autorização</b>.</li>
            <li>Cole o código de autorização aqui:</li>
          </ol>
          <Field label="Código de autorização"><input autoFocus value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="Cole aqui o código do Portal do Parceiro" /></Field>
          <div className="modal-actions"><button type="button" onClick={onClose}>Depois</button><button type="submit" disabled={codigo.trim().length < 4 || salvando}>{salvando ? 'Conectando…' : 'Concluir conexão'}</button></div>
        </form>
      )}
    </Modal>
  );
}

// Disponibilidade no cardapio do iFood: produtos marcados "Vender no iFood" e complementos com codigo.
// O GiroStock pausa o que acabou e reativa o que voltou sozinho (a cada 30 s); "Enviar agora" manda tudo de novo.
function CardapioModal({ integ, loja, onClose }) {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const carregar = useCallback(() => api.get(`/integracoes/${integ.id}/disponibilidade`).then(setLista).catch((err) => { toast.erro(err); setLista([]); }), [integ, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  async function enviar() {
    setEnviando(true);
    try { const r = await api.post(`/integracoes/${integ.id}/disponibilidade/enviar`, { tudo: true }); toast.sucesso(`${r.enviados} item(ns) enviados ao iFood`); carregar(); } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  const pausados = (lista || []).filter((x) => x.status === 'UNAVAILABLE').length;
  return (
    <Modal titulo={`Cardápio no iFood · ${loja.nome}`} subtitulo="O GiroStock pausa no iFood o que acabou (estoque ou insumo da receita) e reativa quando volta." onClose={onClose} largura="larga">
      <div className="form-stack">
        {lista === null ? <p className="muted">Calculando…</p> : lista.length === 0 ? (
          <p className="muted">Nenhum produto marcado para o iFood. No cadastro do produto, marque <b>"Vender no iFood"</b>; nos complementos, informe o <b>código PDV no iFood</b>.</p>
        ) : (
          <>
            <div className="muted">{lista.length - pausados} à venda · {pausados} pausado(s)</div>
            <div className="tabela-wrap">
              <table className="compacta">
                <thead><tr><th>Item</th><th>Código PDV</th><th>Situação</th><th>No iFood</th></tr></thead>
                <tbody>
                  {lista.map((x) => (
                    <tr key={`${x.tipo}:${x.codigo}`}>
                      <td>{x.nome}{x.tipo === 'complemento' && <span className="celula-sub"> complemento</span>}</td>
                      <td>{x.codigo}</td>
                      <td><span className={`ped-pill ${x.status === 'AVAILABLE' ? 'ok' : 'err'}`}>{x.status === 'AVAILABLE' ? 'À venda' : 'Pausado'}</span>{x.motivo && <span className="celula-sub"> {x.motivo}</span>}</td>
                      <td className="muted">{x.no_ifood ? (x.no_ifood === x.status ? 'atualizado' : 'enviando…') : 'ainda não enviado'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          <button type="button" className="btn-primario" disabled={enviando || !lista || lista.length === 0} onClick={enviar}>{enviando ? 'Enviando…' : 'Enviar tudo ao iFood agora'}</button>
        </div>
      </div>
    </Modal>
  );
}
