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
  async function alterarTeste(i, mudanca) {
    try {
      await api.patch(`/integracoes/${i.id}`, mudanca);
      if ('modo_teste' in mudanca) toast.sucesso(mudanca.modo_teste ? 'Modo teste ligado' : 'Modo teste desligado');
      else toast.sucesso('Produto de teste salvo');
      carregar();
    } catch (err) { toast.erro(err); }
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
            {ligado && <ModoTeste integ={i} onChange={(m) => alterarTeste(i, m)} />}
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

// Modo teste (conta de teste do iFood): o pedido de teste vem com itens de codigo aleatorio, que nunca batem com o
// cadastro. Ligado, o item que o GiroStock nao reconhece entra como o "produto de teste" escolhido, e o pedido segue
// sozinho (aceite automatico, estoque, preparo) como um pedido real. Desligue antes de vender de verdade.
function ModoTeste({ integ, onChange }) {
  const [produtos, setProdutos] = useState(null);
  useEffect(() => {
    if (!integ.modo_teste) return;
    api.get('/products?limit=500&ativo=true').then((r) => setProdutos(Array.isArray(r) ? r : r.items || r.produtos || [])).catch(() => setProdutos([]));
  }, [integ.modo_teste]);
  return (
    <div className="ifood-teste">
      <label className="check" title="Só para a conta de teste do iFood: itens que o GiroStock não reconhece entram como o produto de teste">
        <input type="checkbox" checked={!!integ.modo_teste} onChange={() => onChange({ modo_teste: !integ.modo_teste })} /> Modo teste (conta de teste do iFood)
      </label>
      {integ.modo_teste && (
        <div className="ifood-teste-corpo">
          <Field label="Produto de teste" hint="Item do pedido que o GiroStock não reconhece entra como este produto (sem pedir vínculo).">
            <select value={integ.produto_teste_id || ''} onChange={(e) => onChange({ produto_teste_id: e.target.value || null })}>
              <option value="">— escolha um produto —</option>
              {(produtos || []).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </Field>
          {!integ.produto_teste_id && <div className="form-hint" style={{ color: 'var(--warn)' }}>Escolha o produto de teste para os pedidos de teste entrarem sozinhos.</div>}
          <div className="form-hint">Desligue o modo teste antes de começar a vender de verdade no iFood.</div>
        </div>
      )}
    </div>
  );
}

const brl = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

// Cardapio do iFood: aba "Produtos" (enviar os produtos do GiroStock para o cardapio do iFood: nome, descricao,
// preco da loja, categoria, foto, com o codigo do produto como codigo PDV) e aba "Disponibilidade" (pausa o que
// acabou e reativa o que voltou, sozinho a cada 30 s).
function CardapioModal({ integ, loja, onClose }) {
  const [aba, setAba] = useState('produtos');
  return (
    <Modal titulo={`Cardápio no iFood · ${loja.nome}`} subtitulo="Envie seus produtos para o iFood. Depois, preço e disponibilidade são atualizados sozinhos." onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="segmentado" role="tablist">
          <button type="button" role="tab" aria-selected={aba === 'produtos'} className={aba === 'produtos' ? 'ativo' : ''} onClick={() => setAba('produtos')}>Produtos</button>
          <button type="button" role="tab" aria-selected={aba === 'disponibilidade'} className={aba === 'disponibilidade' ? 'ativo' : ''} onClick={() => setAba('disponibilidade')}>Disponibilidade</button>
        </div>
        {aba === 'produtos' ? <EnviarProdutos integ={integ} onClose={onClose} /> : <Disponibilidade integ={integ} onClose={onClose} />}
      </div>
    </Modal>
  );
}

function EnviarProdutos({ integ, onClose }) {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [marcados, setMarcados] = useState(new Set());
  const [busca, setBusca] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [falhas, setFalhas] = useState([]);
  const carregar = useCallback(() => api.get(`/integracoes/${integ.id}/cardapio`).then((r) => {
    setLista(r.produtos);
    setMarcados((m) => (m.size ? m : new Set(r.produtos.filter((p) => p.vende_ifood).map((p) => p.id))));
  }).catch((err) => { toast.erro(err); setLista([]); }), [integ, toast]);
  useEffect(() => { carregar(); }, [carregar]);

  const termo = busca.trim().toLowerCase();
  const visiveis = (lista || []).filter((p) => !termo || p.nome.toLowerCase().includes(termo) || (p.codigo || '').toLowerCase().includes(termo) || (p.categoria || '').toLowerCase().includes(termo));
  const todosMarcados = visiveis.length > 0 && visiveis.every((p) => marcados.has(p.id));
  function alternar(id) { const m = new Set(marcados); if (m.has(id)) m.delete(id); else m.add(id); setMarcados(m); }
  function alternarTodos() {
    const m = new Set(marcados);
    visiveis.forEach((p) => (todosMarcados ? m.delete(p.id) : m.add(p.id)));
    setMarcados(m);
  }
  async function enviar() {
    setEnviando(true);
    setFalhas([]);
    try {
      const r = await api.post(`/integracoes/${integ.id}/cardapio/enviar`, { product_ids: [...marcados] });
      if (r.erros) { toast.erro(`${r.enviados} enviado(s), ${r.erros} com problema`); setFalhas(r.itens.filter((x) => !x.ok)); }
      else toast.sucesso(`${r.enviados} produto(s) no cardápio do iFood`);
      carregar();
    } catch (err) { toast.erro(err); } finally { setEnviando(false); }
  }
  const noIfood = (lista || []).filter((p) => p.no_ifood).length;
  return (
    <>
      <p className="form-hint" style={{ margin: 0 }}>
        Marque os produtos e clique em <b>Enviar ao iFood</b>. Vão o nome, a descrição, o preço desta loja, a categoria e a foto, com o <b>código do produto</b> como código PDV — assim o pedido do iFood já entra vinculado. Se o produto já existe no iFood com o mesmo código, ele é atualizado (não duplica).
      </p>
      {lista === null ? <p className="muted">Carregando…</p> : lista.length === 0 ? <p className="muted">Nenhum produto ativo cadastrado.</p> : (
        <>
          <div className="ifood-card-barra">
            <input type="search" placeholder="Buscar produto, código ou categoria" value={busca} onChange={(e) => setBusca(e.target.value)} />
            <span className="muted">{marcados.size} marcado(s) · {noIfood} no iFood</span>
          </div>
          {falhas.length > 0 && (
            <div className="ped-nota" style={{ borderColor: 'var(--err)' }}>
              {falhas.map((f) => <div key={f.id}><b>{f.nome}</b>: {f.erro}</div>)}
            </div>
          )}
          <div className="tabela-wrap ifood-card-tabela">
            <table className="compacta">
              <thead><tr>
                <th style={{ width: 32 }}><input type="checkbox" aria-label="Marcar todos" checked={todosMarcados} onChange={alternarTodos} /></th>
                <th>Produto</th><th>Código PDV</th><th>Preço</th><th>No iFood</th>
              </tr></thead>
              <tbody>
                {visiveis.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" aria-label={`Enviar ${p.nome}`} checked={marcados.has(p.id)} onChange={() => alternar(p.id)} /></td>
                    <td>{p.nome}<span className="celula-sub"> {p.categoria || 'Sem categoria'}{!p.tem_foto && ' · sem foto'}</span></td>
                    <td>{p.codigo || <span className="muted">sem código</span>}</td>
                    <td>{brl(p.preco)}</td>
                    <td>
                      {p.erro ? <span className="ped-pill err" title={p.erro}>Erro</span>
                        : p.no_ifood ? (p.desatualizado ? <span className="ped-pill warn" title={`No iFood: ${brl(p.preco_no_ifood)}`}>Atualizando preço</span> : <span className="ped-pill ok">Enviado</span>)
                        : <span className="muted">não enviado</span>}
                      {p.erro && <div className="celula-sub" style={{ color: 'var(--err)' }}>{p.erro}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Fechar</button>
        <button type="button" className="btn-primario" disabled={enviando || marcados.size === 0} onClick={enviar}>{enviando ? 'Enviando…' : `Enviar ao iFood (${marcados.size})`}</button>
      </div>
    </>
  );
}

// Disponibilidade no cardapio do iFood: produtos marcados "Vender no iFood" e complementos com codigo.
// O GiroStock pausa o que acabou e reativa o que voltou sozinho (a cada 30 s); "Enviar agora" manda tudo de novo.
function Disponibilidade({ integ, onClose }) {
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
    <>
      <p className="form-hint" style={{ margin: 0 }}>O GiroStock pausa no iFood o que acabou (estoque ou insumo da receita) e reativa quando volta.</p>
      {lista === null ? <p className="muted">Calculando…</p> : lista.length === 0 ? (
        <p className="muted">Nenhum produto no iFood ainda. Envie os produtos na aba <b>Produtos</b>; nos complementos, informe o <b>código PDV no iFood</b>.</p>
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
        <button type="button" className="btn-primario" disabled={enviando || !lista || lista.length === 0} onClick={enviar}>{enviando ? 'Enviando…' : 'Enviar disponibilidade agora'}</button>
      </div>
    </>
  );
}
