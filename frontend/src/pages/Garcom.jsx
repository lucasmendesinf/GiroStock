import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import EscolherComplementos, { assinatura, precoComplementos, textoComplementos } from '../components/EscolherComplementos.jsx';
import { brl } from '../utils/format';

// App do garcom (celular): minhas comandas, nova comanda (mesa/pista), comanda com rodadas e extrato.
// O carrinho da rodada ainda nao enviada fica no aparelho (localStorage) por comanda; o envio usa um client_id que o servidor
// reconhece, entao tentar de novo apos queda de sinal nao duplica o pedido.

const MESAS = Array.from({ length: 30 }, (_, i) => i + 1);
const INTERVALO_MS = 12000;
const NOME_RODADA = { novo: 'Na cozinha', em_preparo: 'Em preparo', pronto: 'Pronta p/ entregar', entregue: 'Entregue', finalizado: 'Paga', cancelado: 'Cancelada' };
const CLASSE_RODADA = { novo: 'warn', em_preparo: 'warn', pronto: 'ok', entregue: '', finalizado: '', cancelado: 'err' };
// UUID v4 (crypto.randomUUID so existe em HTTPS/localhost; no celular pela rede local usamos getRandomValues).
function novoUuid() {
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const NOME_FORMA = { pix: 'Pix', cartao_credito: 'Cartão crédito', cartao_debito: 'Cartão débito', dinheiro: 'Dinheiro' };
const SIMBOLO_FORMA = { pix: '💠', cartao_credito: '💳', cartao_debito: '💳', dinheiro: '💵' };
const arred = (v) => Math.round(Number(v) * 100) / 100;
const semRede = (err) => !err || err.status === undefined; // queda de sinal: o pedido pode ou nao ter chegado

// ---------- rascunho local ----------
const chaveRascunho = (id) => `gs_gc_rascunho_${id}`;
const VAZIO = { itens: [], observacao: '', pendente: null };
function lerRascunho(id) {
  try { return { ...VAZIO, ...(JSON.parse(localStorage.getItem(chaveRascunho(id)) || 'null') || {}) }; } catch { return { ...VAZIO }; }
}
function gravarRascunho(id, r) {
  try {
    if (r.itens.length === 0 && !r.observacao && !r.pendente) localStorage.removeItem(chaveRascunho(id));
    else localStorage.setItem(chaveRascunho(id), JSON.stringify(r));
  } catch { /* sem armazenamento: o carrinho vale so nesta tela */ }
}
const qtdNaoEnviada = (id) => { const r = lerRascunho(id); return r.itens.reduce((s, i) => s + Number(i.quantidade), 0); };

function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true); const b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

// Recarrega de tempos em tempos (so com a aba visivel).
function useAtualizar(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) ref.current(); }, INTERVALO_MS);
    const vis = () => { if (!document.hidden) ref.current(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);
}

function AvisoRede() {
  const on = useOnline();
  if (on) return null;
  return <div className="gc-aviso" role="alert">Sem conexão. O que você montar fica no celular; envie quando o sinal voltar.</div>;
}

export default function Garcom() {
  return (
    <div className="gc">
      <AvisoRede />
      <Routes>
        <Route index element={<Inicio />} />
        <Route path="nova" element={<NovaComanda />} />
        <Route path="comanda/:id" element={<Comanda />} />
        <Route path="extrato" element={<Extrato />} />
        <Route path="*" element={<Inicio />} />
      </Routes>
    </div>
  );
}

function CabecaTela({ titulo, sub, voltar = '/garcom', direita }) {
  return (
    <div className="gc-head">
      <Link to={voltar} className="gc-voltar" aria-label="Voltar">←</Link>
      <div className="gc-head-t"><b>{titulo}</b>{sub && <div className="gc-sub">{sub}</div>}</div>
      {direita}
    </div>
  );
}

// ---------------------------------------------------------------- início
function Inicio() {
  const { user } = useAuth();
  const toast = useToast();
  const [lista, setLista] = useState(null);

  const carregar = useCallback(async () => {
    try { setLista(await api.get('/garcom/comandas')); } catch (err) { if (!semRede(err)) toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useAtualizar(carregar);

  const totalAberto = (lista || []).reduce((s, c) => s + Number(c.total), 0);
  return (
    <>
      <div className="gc-head">
        <div className="gc-head-t"><div className="gc-sub">Olá,</div><b>{user?.nome}</b></div>
        <Link to="/garcom/extrato" className="gc-icone" aria-label="Meu extrato" title="Meu extrato">💰</Link>
      </div>
      <div className="gc-body">
        <div className="gc-destaque">
          <div className="gc-sub">Em aberto nas minhas comandas</div>
          <div className="gc-valor">{brl(totalAberto)}</div>
          <div className="gc-sub">{lista ? `${lista.length} comanda(s) aberta(s)` : 'carregando…'}</div>
        </div>
        <div className="gc-rod">Minhas comandas</div>
        {lista && lista.length === 0 && <div className="gc-vazio">Nenhuma comanda aberta. Toque em “Nova comanda”.</div>}
        {(lista || []).map((c) => {
          const naoEnv = qtdNaoEnviada(c.id);
          return (
            <Link key={c.id} to={`/garcom/comanda/${c.id}`} className={`gc-card ${c.status === 'fechamento_solicitado' ? 'fechando' : ''}`}>
              <div className="gc-linha">
                <span className="gc-nome">{c.tipo === 'pista' ? '🎫' : '🍽'} {c.identificador}</span>
                <span className="gc-tag">#{c.numero}</span>
                {c.modo_pagamento === 'hora' && <span className="gc-tag">na hora</span>}
                {c.cliente_nome && <span className="gc-tag">{c.cliente_nome}</span>}
                <span className="gc-total">{brl(c.total)}</span>
              </div>
              <div className="gc-linha gc-sub">
                <span>{c.rodadas} rodada(s)</span>
                {c.rodadas_prontas > 0 && <span className="gc-pill ok">{c.rodadas_prontas} pronta(s) p/ entregar</span>}
                {c.rodadas_na_cozinha > 0 && <span className="gc-pill warn">{c.rodadas_na_cozinha} na cozinha</span>}
                {Number(c.pago_produtos) > 0 && <span className="gc-pill ok">pago {brl(Number(c.pago_produtos) + Number(c.taxa_paga))}</span>}
                {c.status === 'fechamento_solicitado' && <span className="gc-pill warn">fechamento pedido</span>}
                {naoEnv > 0 && <span className="gc-pill warn">{naoEnv} item(ns) não enviado(s)</span>}
              </div>
            </Link>
          );
        })}
      </div>
      <div className="gc-rodape"><Link to="/garcom/nova" className="gc-grande">+ Nova comanda</Link></div>
    </>
  );
}

// ---------------------------------------------------------------- nova comanda
function NovaComanda() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [lojas, setLojas] = useState([]);
  const [lojaId, setLojaId] = useState(user?.locationId || '');
  const [abertas, setAbertas] = useState([]);
  const [mesa, setMesa] = useState('');
  const [pulseira, setPulseira] = useState('');
  const [nome, setNome] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [modo, setModo] = useState('conta');

  useEffect(() => {
    api.get('/garcom/lojas').then((l) => { setLojas(l); if (!lojaId && l.length === 1) setLojaId(l[0].id); }).catch((e) => toast.erro(e));
    api.get('/garcom/comandas').then(setAbertas).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lojaAtual = lojas.find((l) => l.id === lojaId);
  const podeHora = !!(user?.areas?.ReceberNoApp && lojaAtual && lojaAtual.garcom_recebe);
  const ocupadas = new Set(abertas.filter((c) => c.tipo === 'mesa' && (!lojaId || c.location_id === lojaId)).map((c) => c.identificador.toLowerCase()));

  async function abrir(corpo) {
    if (enviando) return;
    if (!lojaId) { toast.erro('Escolha a loja da comanda.'); return; }
    setEnviando(true);
    try {
      const c = await api.post('/garcom/comandas', { ...corpo, location_id: lojaId, modo_pagamento: podeHora && modo === 'hora' ? 'hora' : 'conta' });
      if (c.existente) toast.sucesso(`${c.identificador} já estava aberta: você entrou nela.`);
      navigate(`/garcom/comanda/${c.id}`, { replace: true });
    } catch (err) { toast.erro(err); setEnviando(false); }
  }

  return (
    <>
      <CabecaTela titulo="Nova comanda" />
      <div className="gc-body">
        {lojas.length > 1 && (
          <Field label="Loja"><select value={lojaId} onChange={(e) => setLojaId(e.target.value)}><option value="">Escolha…</option>{lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select></Field>
        )}
        <div className="gc-rod" style={{ marginTop: 0 }}>Como o cliente vai pagar?</div>
        <div className="gc-seg">
          <button type="button" className={modo === 'conta' ? 'on' : ''} onClick={() => setModo('conta')}>Conta aberta<span>paga no fechamento</span></button>
          <button type="button" className={modo === 'hora' && podeHora ? 'on' : ''} disabled={!podeHora} onClick={() => setModo('hora')}>Na hora<span>paga a cada pedido</span></button>
        </div>
        {!podeHora && <div className="gc-sub">{user?.areas?.ReceberNoApp ? 'Esta loja não liberou o recebimento no app.' : 'Seu perfil não recebe pagamentos no app. Peça liberação ao gerente.'}</div>}
        <div className="gc-rod">Mesa</div>
        <div className="gc-mesas">
          {MESAS.map((n) => (
            <button key={n} type="button" className={ocupadas.has(`mesa ${n}`) ? 'oc' : ''} disabled={enviando} onClick={() => abrir({ tipo: 'mesa', identificador: String(n) })}>{n}</button>
          ))}
        </div>
        <form className="gc-linha-form" onSubmit={(e) => { e.preventDefault(); if (mesa.trim()) abrir({ tipo: 'mesa', identificador: mesa.trim() }); }}>
          <input value={mesa} onChange={(e) => setMesa(e.target.value)} placeholder="Outra mesa (nome ou número)" maxLength={40} aria-label="Outra mesa" />
          <button type="submit" disabled={enviando || !mesa.trim()}>Abrir</button>
        </form>
        <div className="gc-sub">Mesas em dourado já têm comanda aberta: ao tocar você entra nela.</div>

        <div className="gc-rod" style={{ marginTop: 22 }}>Pista (cliente avulso)</div>
        <form className="gc-form" onSubmit={(e) => { e.preventDefault(); abrir({ tipo: 'pista', identificador: pulseira.trim(), cliente_nome: nome.trim() }); }}>
          <input value={pulseira} onChange={(e) => setPulseira(e.target.value)} inputMode="numeric" placeholder="Nº da pulseira / cartão" maxLength={40} aria-label="Número da pulseira ou cartão" />
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome (opcional)" maxLength={80} aria-label="Nome do cliente" />
          <button type="submit" className="gc-grande" disabled={enviando || !pulseira.trim()}>Abrir comanda da pista</button>
        </form>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- comanda
function Comanda() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const online = useOnline();
  const [c, setC] = useState(null);
  const [erroCarga, setErroCarga] = useState('');
  const [rasc, setRasc] = useState(() => lerRascunho(id));
  const [produtos, setProdutos] = useState([]);
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [escolhendo, setEscolhendo] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [menu, setMenu] = useState(false);
  const [transferindo, setTransferindo] = useState(false);
  const [cancelandoRodada, setCancelandoRodada] = useState(null);
  const [recebendo, setRecebendo] = useState(null); // { ids } rodadas a receber (folha "Receber agora")

  const carregar = useCallback(async () => {
    try { const d = await api.get(`/garcom/comandas/${id}`); setC(d); setErroCarga(''); } catch (err) { if (err.status === 404) setErroCarga('Comanda não encontrada ou sem acesso.'); else if (!semRede(err)) toast.erro(err); }
  }, [id, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  useAtualizar(carregar);

  // Cardapio da loja da comanda (todas as paginas de 100).
  useEffect(() => {
    if (!c || produtos.length > 0) return;
    let vivo = true;
    (async () => {
      let todos = []; let off = 0;
      try {
        for (let i = 0; i < 6; i++) {
          const pag = await api.get(`/products/search?location_id=${c.location_id}&q=&limit=100&offset=${off}`);
          todos = todos.concat(pag);
          if (pag.length < 100) break;
          off += 100;
        }
        if (vivo) setProdutos(todos);
      } catch (err) { if (!semRede(err)) toast.erro(err); }
    })();
    return () => { vivo = false; };
  }, [c && c.location_id]); // eslint-disable-line react-hooks/exhaustive-deps

  function mudarRascunho(fn) {
    setRasc((r) => { const novo = fn(r); gravarRascunho(id, novo); return novo; });
  }

  const categorias = useMemo(() => [...new Set(produtos.map((p) => p.categoria).filter(Boolean))].sort(), [produtos]);
  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return produtos.filter((p) => (q ? p.nome.toLowerCase().includes(q) : !cat || p.categoria === cat));
  }, [produtos, busca, cat]);

  function adicionar(p, complementos = []) {
    const preco = Number(p.preco_venda) + precoComplementos(complementos);
    mudarRascunho((r) => {
      const ass = assinatura(complementos);
      const ix = r.itens.findIndex((i) => i.product_id === p.id && !i.observacao && assinatura(i.complementos) === ass);
      const itens = ix >= 0 ? r.itens.map((i, k) => (k === ix ? { ...i, quantidade: i.quantidade + 1 } : i))
        : [...r.itens, { key: `${Date.now()}-${Math.random()}`, product_id: p.id, nome: p.nome, preco, quantidade: 1, observacao: '', complementos }];
      return { ...r, itens };
    });
  }
  function tocar(p) {
    if (p.saldo !== null && p.saldo !== undefined && Number(p.saldo) <= 0) { toast.erro(`${p.nome}: sem estoque disponível.`); return; }
    if ((p.grupos || []).length > 0) setEscolhendo(p); else adicionar(p);
  }
  const mudarQtd = (key, d) => mudarRascunho((r) => ({ ...r, itens: r.itens.map((i) => (i.key === key ? { ...i, quantidade: i.quantidade + d } : i)).filter((i) => i.quantidade > 0) }));
  const mudarObs = (key, obs) => mudarRascunho((r) => ({ ...r, itens: r.itens.map((i) => (i.key === key ? { ...i, observacao: obs } : i)) }));

  const totalRascunho = rasc.itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
  const qtdRascunho = rasc.itens.reduce((s, i) => s + i.quantidade, 0);

  async function enviar(repetir = false) {
    if (enviando) return;
    const pend = repetir ? rasc.pendente : { client_id: novoUuid(), itens: rasc.itens, observacao: rasc.observacao };
    if (!pend || pend.itens.length === 0) return;
    if (!repetir && !(await confirmar({ titulo: 'Enviar pedido ao bar/cozinha?', mensagem: `${qtdRascunho} item(ns) · ${brl(totalRascunho)}`, confirmar: 'Enviar' }))) return;
    setEnviando(true);
    // Guarda o envio ANTES de tentar: se o sinal cair, o mesmo client_id e reenviado e o servidor nao duplica.
    mudarRascunho((r) => ({ ...r, pendente: pend, itens: repetir ? r.itens : [], observacao: repetir ? r.observacao : '' }));
    try {
      const novo = await api.post(`/garcom/comandas/${id}/rodadas`, {
        client_id: pend.client_id, observacao: pend.observacao,
        itens: pend.itens.map((i) => ({ product_id: i.product_id, quantidade: i.quantidade, observacao: i.observacao, complementos: i.complementos.map((x) => ({ id: x.id, quantidade: x.quantidade })) })),
      });
      mudarRascunho((r) => ({ ...r, pendente: null }));
      setC(novo);
      toast.sucesso(novo.repetida ? 'Esse pedido já tinha chegado.' : `Rodada ${novo.rodadas} enviada ao bar/cozinha.`);
      if (!novo.repetida && novo.modo_pagamento === 'hora' && novo.receber && novo.receber.permitido && novo.rodada_id) setRecebendo({ ids: [novo.rodada_id] });
    } catch (err) {
      if (semRede(err)) {
        toast.erro('Sem conexão: o pedido NÃO foi confirmado. Toque em “Tentar de novo” quando o sinal voltar.');
      } else {
        // Recusa definitiva (ex.: sem estoque): o pedido volta ao carrinho para ajustar.
        mudarRascunho((r) => ({ ...r, pendente: null, itens: repetir ? r.itens : pend.itens, observacao: repetir ? r.observacao : pend.observacao }));
        toast.erro(err);
      }
    }
    setEnviando(false);
  }

  async function descartarPendente() {
    if (!(await confirmar({ titulo: 'Descartar o pedido não confirmado?', mensagem: 'Confira a lista de rodadas antes: ele pode ter chegado ao bar/cozinha mesmo sem a confirmação.', confirmar: 'Devolver ao carrinho', perigo: true }))) return;
    await carregar();
    mudarRascunho((r) => ({ ...r, pendente: null, itens: [...r.pendente.itens, ...r.itens], observacao: r.pendente.observacao || r.observacao }));
  }

  async function acao(promessa, msg) {
    try { const r = await promessa; if (r && r.id) setC(r); if (msg) toast.sucesso(msg); return r; } catch (err) { toast.erro(err); return null; }
  }
  async function pedirFechamento() {
    if (rasc.itens.length > 0 && !(await confirmar({ titulo: 'Há itens não enviados', mensagem: 'Eles não serão cobrados. Envie a rodada antes ou descarte o carrinho.', confirmar: 'Pedir fechamento mesmo assim' }))) return;
    if (!(await confirmar({ titulo: 'Pedir fechamento?', mensagem: 'O caixa é avisado e você não lança mais pedidos nesta comanda (o gerente pode reabrir).', confirmar: 'Pedir fechamento' }))) return;
    const r = await acao(api.post(`/garcom/comandas/${id}/pedir-fechamento`), 'Fechamento pedido: o caixa foi avisado.');
    if (r && r.avisos && r.avisos.length) toast.erro(r.avisos[0]);
  }
  async function cancelarComanda() {
    setMenu(false);
    if (!(await confirmar({ titulo: 'Cancelar esta comanda?', mensagem: 'Só vale para comanda sem pedidos. A mesa/pulseira é liberada.', confirmar: 'Cancelar comanda', perigo: true }))) return;
    const r = await acao(api.post(`/garcom/comandas/${id}/cancelar`, {}), 'Comanda cancelada.');
    if (r) { gravarRascunho(id, { ...VAZIO }); navigate('/garcom', { replace: true }); }
  }
  async function estornar(pagamentoId) {
    const motivo = window.prompt('Motivo do estorno do recebimento:');
    if (!motivo || motivo.trim().length < 3) return;
    await acao(api.post(`/garcom/comandas/${id}/receber/${pagamentoId}/estornar`, { motivo: motivo.trim() }), 'Recebimento estornado: a rodada voltou para a conta.');
  }
  async function encerrar() {
    if (!(await confirmar({ titulo: 'Encerrar a comanda?', mensagem: 'Tudo está pago. A venda é gerada agora e o estoque é baixado.', confirmar: 'Encerrar comanda' }))) return;
    try {
      const r = await api.post(`/garcom/comandas/${id}/encerrar`);
      toast.sucesso('Comanda encerrada.');
      gravarRascunho(id, { ...VAZIO });
      setC(r.comanda);
    } catch (err) { toast.erro(err); }
  }
  async function entregue(rod) {
    await acao(api.post(`/garcom/rodadas/${rod.id}/status`, { para: 'entregue' }), `Rodada ${rod.rodada} entregue.`);
  }
  async function cancelarRodada(rod) {
    if (rod.status === 'novo') {
      if (!(await confirmar({ titulo: `Cancelar a rodada ${rod.rodada}?`, mensagem: 'Ainda não entrou em preparo: a reserva de estoque é liberada.', confirmar: 'Cancelar rodada', perigo: true }))) return;
      await acao(api.post(`/garcom/rodadas/${rod.id}/cancelar`, {}), `Rodada ${rod.rodada} cancelada.`);
    } else setCancelandoRodada(rod);
  }

  if (erroCarga) return (<><CabecaTela titulo="Comanda" /><div className="gc-body"><div className="gc-vazio">{erroCarga}</div></div></>);
  if (!c) return (<><CabecaTela titulo="Comanda" /><div className="gc-body"><div className="gc-vazio">Carregando…</div></div></>);

  const aberta = c.status === 'aberta';
  const encerrada = ['paga', 'cancelada'].includes(c.status);
  const gerente = !!user?.areas?.CancelarVendas;
  const semItensAtivos = c.rodadas === 0;
  const rec = c.receber || {};
  const faltaProdutos = Number(c.falta_produtos || 0);
  const podeReceber = !!rec.permitido && ['aberta', 'fechamento_solicitado'].includes(c.status);
  const naoPagas = c.rodadas_lista.filter((r) => r.status !== 'cancelado' && !r.pagamento_id);
  const tudoPago = c.rodadas > 0 && naoPagas.length === 0 && ['aberta', 'fechamento_solicitado'].includes(c.status);
  const pagoTotal = Number(c.pago_produtos) + Number(c.taxa_paga);
  const limitada = !online ? ' (sem conexão)' : '';

  return (
    <>
      <CabecaTela titulo={`${c.tipo === 'pista' ? '🎫' : '🍽'} ${c.identificador}`} sub={pagoTotal > 0 ? `pago ${brl(pagoTotal)} · falta ${brl(faltaProdutos)}` : `#${c.numero}${c.cliente_nome ? ` · ${c.cliente_nome}` : ''} · ${c.location_nome}`}
        direita={<div className="gc-head-d"><b className="gc-total">{brl(Number(c.total) + totalRascunho)}</b><button type="button" className="gc-icone" aria-label="Mais opções" onClick={() => setMenu(true)}>⋯</button></div>} />
      <div className="gc-body gc-com">
        {c.status === 'fechamento_solicitado' && <div className="gc-aviso gc-aviso-warn">Fechamento pedido: o caixa já foi avisado. {gerente ? <button type="button" className="gc-link" onClick={() => acao(api.post(`/garcom/comandas/${id}/reabrir`), 'Comanda reaberta.')}>Reabrir</button> : 'Para lançar mais, peça ao gerente para reabrir.'}</div>}
        {c.status === 'paga' && <div className="gc-aviso gc-aviso-ok">Comanda paga no caixa.</div>}
        {c.status === 'cancelada' && <div className="gc-aviso gc-aviso-warn">Comanda cancelada{c.motivo_cancelamento ? `: ${c.motivo_cancelamento}` : ''}.</div>}

        {rasc.pendente && (
          <div className="gc-aviso gc-aviso-warn" role="alert">
            <b>Pedido não confirmado</b> ({rasc.pendente.itens.reduce((s, i) => s + i.quantidade, 0)} item(ns)). Pode não ter chegado ao bar/cozinha.
            <div className="gc-acoes">
              <button type="button" className="gc-btn" disabled={enviando} onClick={() => enviar(true)}>Tentar de novo{limitada}</button>
              <button type="button" className="gc-btn gc-btn-sec" disabled={enviando} onClick={descartarPendente}>Conferir e descartar</button>
            </div>
          </div>
        )}

        {rasc.itens.length > 0 && (
          <>
            <div className="gc-rod gc-rod-novo">Nova rodada · ainda não enviada</div>
            {rasc.itens.map((i) => (
              <div key={i.key} className="gc-item gc-item-col">
                <div className="gc-item-top">
                  <div className="gc-item-l"><span className="gc-nome">{i.nome}</span>{i.complementos.length > 0 && <span className="gc-sub">{textoComplementos(i.complementos)}</span>}</div>
                  <b className="gc-item-v">{brl(i.preco * i.quantidade)}</b>
                </div>
                <div className="gc-item-bot">
                  <input value={i.observacao} onChange={(e) => mudarObs(i.key, e.target.value)} placeholder="Observação (ex.: sem gelo)" maxLength={200} aria-label={`Observação de ${i.nome}`} />
                  <div className="gc-qtd">
                    <button type="button" onClick={() => mudarQtd(i.key, -1)} aria-label="Diminuir">−</button>
                    <b>{i.quantidade}</b>
                    <button type="button" onClick={() => mudarQtd(i.key, 1)} aria-label="Aumentar">+</button>
                  </div>
                </div>
              </div>
            ))}
            <input className="gc-busca" value={rasc.observacao} onChange={(e) => mudarRascunho((r) => ({ ...r, observacao: e.target.value }))} placeholder="Observação geral da rodada" maxLength={300} aria-label="Observação geral" />
          </>
        )}

        {aberta && (
          <>
            <input className="gc-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto…" aria-label="Buscar produto" />
            {!busca && categorias.length > 0 && (
              <div className="gc-cats">
                <button type="button" className={!cat ? 'on' : ''} onClick={() => setCat('')}>Todos</button>
                {categorias.map((n) => <button key={n} type="button" className={cat === n ? 'on' : ''} onClick={() => setCat(n)}>{n}</button>)}
              </div>
            )}
            <div className="gc-prods">
              {visiveis.map((p) => {
                const sem = p.saldo !== null && p.saldo !== undefined && Number(p.saldo) <= 0;
                return (
                  <button key={p.id} type="button" className={sem ? 'sem' : ''} aria-disabled={sem} onClick={() => tocar(p)}>
                    <b>{p.nome}</b><span>{brl(p.preco_venda)}</span>{sem && <em>sem estoque</em>}
                  </button>
                );
              })}
              {produtos.length > 0 && visiveis.length === 0 && <div className="gc-vazio">Nenhum produto encontrado.</div>}
              {produtos.length === 0 && <div className="gc-vazio">Carregando cardápio…</div>}
            </div>
          </>
        )}

        {c.rodadas_lista.map((r) => (
          <div key={r.id} className={`gc-rodada ${r.status === 'cancelado' ? 'cancelada' : ''}`}>
            <div className="gc-rod">
              Rodada {r.rodada} · {new Date(r.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              <span className={`gc-pill ${CLASSE_RODADA[r.status]}`}>{NOME_RODADA[r.status] || r.status}</span>
              {r.status !== 'cancelado' && (r.pagamento_id ? <span className="gc-pill ok">pago · {NOME_FORMA[r.pago_forma] || r.pago_forma}</span> : <span className="gc-pill warn">na conta</span>)}
            </div>
            {r.itens.map((i) => (
              <div key={i.id} className="gc-item gc-item-env">
                <span className="gc-item-l"><span>{Number(i.quantidade)}× {i.product_nome}</span>{i.complementos.length > 0 && <span className="gc-sub">{textoComplementos(i.complementos)}</span>}{i.observacao && <span className="gc-sub">“{i.observacao}”</span>}{i.garcom_nome && c.garcons.length > 1 && <span className="gc-sub">{i.garcom_nome}</span>}</span>
                <span>{brl(i.subtotal)}</span>
              </div>
            ))}
            {r.status === 'cancelado' && r.motivo_cancelamento && <div className="gc-sub">Motivo: {r.motivo_cancelamento}</div>}
            {!encerrada && (
              <div className="gc-acoes">
                {r.status === 'pronto' && <button type="button" className="gc-btn" onClick={() => entregue(r)}>Marcar entregue</button>}
                {podeReceber && r.status !== 'cancelado' && !r.pagamento_id && <button type="button" className="gc-btn" onClick={() => setRecebendo({ ids: [r.id] })}>Receber {brl(r.total)}</button>}
                {gerente && r.pagamento_id && <button type="button" className="gc-btn gc-btn-sec" onClick={() => estornar(r.pagamento_id)}>Estornar recebimento</button>}
                {(r.status === 'novo' || (gerente && ['em_preparo', 'pronto', 'entregue'].includes(r.status))) && <button type="button" className="gc-btn gc-btn-sec" onClick={() => cancelarRodada(r)}>Cancelar rodada</button>}
              </div>
            )}
          </div>
        ))}
        {c.rodadas_lista.length === 0 && rasc.itens.length === 0 && aberta && <div className="gc-sub" style={{ textAlign: 'center' }}>Toque nos produtos para montar a primeira rodada.</div>}
      </div>

      {(aberta || (podeReceber && !encerrada)) && (
        <div className="gc-rodape">
          {aberta && (
            <button type="button" className="gc-grande" disabled={rasc.itens.length === 0 || enviando || !!rasc.pendente} onClick={() => enviar(false)}>
              {rasc.pendente ? 'Resolva o pedido não confirmado' : `${c.modo_pagamento === 'hora' && podeReceber ? 'Enviar e receber agora' : 'Enviar pedido ao bar/cozinha'}${qtdRascunho ? ` (${qtdRascunho})` : ''}`}
            </button>
          )}
          {podeReceber && naoPagas.length > 0 && (
            <button type="button" className="gc-grande gc-sec" onClick={() => setRecebendo({ ids: naoPagas.map((r) => r.id) })}>Receber agora · {brl(faltaProdutos)}</button>
          )}
          {tudoPago ? (
            <button type="button" className="gc-grande gc-sec" onClick={encerrar}>Encerrar comanda (tudo pago)</button>
          ) : aberta && (
            <button type="button" className="gc-grande gc-sec" disabled={semItensAtivos} onClick={pedirFechamento}>Pedir fechamento (chamar caixa)</button>
          )}
        </div>
      )}

      {menu && (
        <Modal titulo="Opções da comanda" onClose={() => setMenu(false)}>
          <div className="gc-menu">
            {!encerrada && (c.aberta_por === user?.id || gerente) && <button type="button" onClick={() => { setMenu(false); setTransferindo(true); }}>Transferir para outro garçom</button>}
            {!encerrada && <button type="button" onClick={carregar}>Atualizar agora</button>}
            {!encerrada && semItensAtivos && <button type="button" className="perigo" onClick={cancelarComanda}>Cancelar comanda (sem pedidos)</button>}
            {!encerrada && !semItensAtivos && gerente && <button type="button" className="perigo" onClick={() => { setMenu(false); setCancelandoRodada({ comanda: true }); }}>Cancelar comanda (gerente)</button>}
            <div className="gc-sub">Garçons nesta comanda: {c.garcons.map((g) => g.nome).join(', ') || '—'}</div>
          </div>
        </Modal>
      )}
      {transferindo && <Transferir comanda={c} onClose={() => setTransferindo(false)} onFeito={(novo) => { setTransferindo(false); setC(novo); toast.sucesso('Comanda transferida.'); }} />}
      {cancelandoRodada && <MotivoModal titulo={cancelandoRodada.comanda ? 'Cancelar a comanda' : `Cancelar a rodada ${cancelandoRodada.rodada}`} onClose={() => setCancelandoRodada(null)}
        onConfirmar={async (motivo) => {
          const alvo = cancelandoRodada;
          const r = await acao(alvo.comanda ? api.post(`/garcom/comandas/${id}/cancelar`, { motivo }) : api.post(`/garcom/rodadas/${alvo.id}/cancelar`, { motivo }), alvo.comanda ? 'Comanda cancelada.' : `Rodada ${alvo.rodada} cancelada.`);
          if (r) { setCancelandoRodada(null); if (alvo.comanda) navigate('/garcom', { replace: true }); }
        }} />}
      {recebendo && <ReceberAgora comanda={c} ids={recebendo.ids} onClose={() => setRecebendo(null)} onFeito={(novo) => { setRecebendo(null); setC(novo); }} />}
      {escolhendo && <EscolherComplementos produto={escolhendo} onClose={() => setEscolhendo(null)} onConfirmar={(comps) => { const p = escolhendo; setEscolhendo(null); adicionar(p, comps); }} />}
    </>
  );
}

// Folha "Receber agora": Pix, cartao ou dinheiro, taxa de servico opcional e troco. Sem integracao com maquininha/banco: o garcom
// CONFIRMA o recebimento (Pix caiu / cartao aprovado). O dinheiro fica com ele ate a prestacao de contas no caixa.
function ReceberAgora({ comanda, ids, onClose, onFeito }) {
  const toast = useToast();
  const rec = comanda.receber || {};
  const base = arred(comanda.rodadas_lista.filter((r) => ids.includes(r.id)).reduce((s, r) => s + Number(r.total), 0));
  const formasLiberadas = [['pix', rec.formas && rec.formas.pix], ['cartao_credito', rec.formas && rec.formas.cartao], ['cartao_debito', rec.formas && rec.formas.cartao], ['dinheiro', rec.formas && rec.formas.dinheiro]].filter(([, ok]) => ok).map(([k]) => k);
  const [forma, setForma] = useState('');
  const [taxa, setTaxa] = useState(Number(rec.taxa_servico_pct) > 0);
  const [recebido, setRecebido] = useState('');
  const [salvando, setSalvando] = useState(false);
  const pct = Number(rec.taxa_servico_pct || 0);
  const valorTaxa = taxa ? arred(base * pct / 100) : 0;
  const total = arred(base + valorTaxa);
  const recebidoNum = Number(String(recebido).replace(',', '.'));
  const troco = forma === 'dinheiro' && recebido && recebidoNum >= total ? arred(recebidoNum - total) : null;
  const falta = forma === 'dinheiro' && recebido && recebidoNum < total ? arred(total - recebidoNum) : null;

  async function confirmar() {
    if (!forma) { toast.erro('Escolha a forma de pagamento.'); return; }
    setSalvando(true);
    try {
      const r = await api.post(`/garcom/comandas/${comanda.id}/receber`, { order_ids: ids, forma, cobrar_taxa: taxa, ...(forma === 'dinheiro' ? { valor_recebido: recebido ? recebidoNum : total } : {}) });
      toast.sucesso(forma === 'dinheiro' && r.pagamento.troco > 0 ? `Recebido. Troco: ${brl(r.pagamento.troco)}` : 'Recebimento confirmado.');
      onFeito(r.comanda);
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Receber agora" subtitulo={`${comanda.identificador} · produtos ${brl(base)}`} onClose={onClose}>
      <div className="gc-formas">
        {formasLiberadas.map((k) => <button key={k} type="button" className={forma === k ? 'on' : ''} onClick={() => setForma(k)}><span>{SIMBOLO_FORMA[k]}</span>{NOME_FORMA[k]}</button>)}
      </div>
      {formasLiberadas.length === 0 && <div className="gc-sub">Nenhuma forma de pagamento liberada nesta loja.</div>}
      <label className="gc-switch"><input type="checkbox" checked={taxa} onChange={(e) => setTaxa(e.target.checked)} /> Cobrar taxa de serviço ({pct}%) · {brl(arred(base * pct / 100))}</label>
      {forma === 'dinheiro' && (
        <>
          <input inputMode="decimal" value={recebido} onChange={(e) => setRecebido(e.target.value)} placeholder="Valor recebido (para o troco)" aria-label="Valor recebido" />
          {troco !== null && <div className="gc-sub">Troco: <b>{brl(troco)}</b></div>}
          {falta !== null && <div className="gc-sub" style={{ color: 'var(--err)' }}>Faltam {brl(falta)}</div>}
          <div className="gc-sub" style={{ color: 'var(--warn)' }}>O dinheiro fica com você até a prestação de contas no caixa.</div>
        </>
      )}
      {forma === 'pix' && <div className="gc-sub">Mostre o QR/chave do estabelecimento e confirme quando o Pix cair.</div>}
      {(forma === 'cartao_credito' || forma === 'cartao_debito') && <div className="gc-sub">Passe na maquininha e confirme quando for aprovado.</div>}
      <div className="gc-linha" style={{ fontSize: 18, marginTop: 8 }}><b>Total</b><b className="gc-total">{brl(total)}</b></div>
      <div className="gc-acoes" style={{ flexDirection: 'column' }}>
        <button type="button" className="gc-grande" disabled={salvando || !forma || (forma === 'dinheiro' && recebido && recebidoNum < total)} onClick={confirmar}>{salvando ? 'Confirmando…' : 'Confirmar recebimento'}</button>
        <button type="button" className="gc-grande gc-sec" onClick={onClose}>Deixar na conta</button>
      </div>
    </Modal>
  );
}

function Transferir({ comanda, onClose, onFeito }) {
  const toast = useToast();
  const [colegas, setColegas] = useState(null);
  useEffect(() => { api.get(`/garcom/colegas?location_id=${comanda.location_id}`).then(setColegas).catch((e) => { toast.erro(e); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function transferir(g) {
    try { onFeito(await api.post(`/garcom/comandas/${comanda.id}/transferir`, { para_user_id: g.id })); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Transferir comanda" subtitulo="Os itens já lançados continuam sendo de quem lançou." onClose={onClose}>
      <div className="gc-menu">
        {!colegas && <div className="gc-sub">Carregando…</div>}
        {colegas && colegas.length === 0 && <div className="gc-sub">Nenhum outro garçom nesta loja.</div>}
        {(colegas || []).map((g) => <button key={g.id} type="button" onClick={() => transferir(g)}>{g.nome}</button>)}
      </div>
    </Modal>
  );
}

function MotivoModal({ titulo, onClose, onConfirmar }) {
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  return (
    <Modal titulo={titulo} subtitulo="Informe o motivo (fica registrado)." onClose={onClose}>
      <form className="form-stack" onSubmit={async (e) => { e.preventDefault(); setSalvando(true); await onConfirmar(motivo.trim()); setSalvando(false); }}>
        <Field label="Motivo"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} minLength={3} maxLength={200} required /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Voltar</button><button type="submit" disabled={salvando || motivo.trim().length < 3}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- extrato
function Extrato() {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/garcom/extrato').then(setD).catch((e) => toast.erro(e)); }, [toast]);
  return (
    <>
      <CabecaTela titulo="Meu extrato" sub="Hoje" />
      <div className="gc-body">
        <div className="gc-destaque">
          <div className="gc-sub">Vendido por mim, comandas já pagas hoje</div>
          <div className="gc-valor">{brl(d ? d.total_vendido : 0)}</div>
          <div className="gc-sub">Em aberto agora: {brl(d ? d.em_aberto.total : 0)} em {d ? d.em_aberto.comandas : 0} comanda(s)</div>
        </div>
        {d && Number(d.dinheiro_comigo) > 0 && (
          <div className="gc-card" style={{ borderColor: 'var(--warn)' }}>
            <div className="gc-sub">Dinheiro que está com você</div>
            <div className="gc-valor" style={{ color: 'var(--warn)' }}>{brl(d.dinheiro_comigo)}</div>
            <div className="gc-sub">Entregue ao caixa para a prestação de contas.</div>
          </div>
        )}
        <div className="gc-rod">Recebido por mim na hora</div>
        {d && d.recebidos_na_hora.length === 0 && <div className="gc-vazio">Nada recebido na hora hoje.</div>}
        {(d ? d.recebidos_na_hora : []).map((p) => (
          <div key={p.id} className="gc-card">
            <div className="gc-linha"><span className="gc-nome">{p.identificador}</span><span className="gc-tag">{NOME_FORMA[p.forma] || p.forma}</span><span className="gc-total">{brl(p.total)}</span></div>
            <div className="gc-sub">{new Date(p.recebido_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{p.forma === 'dinheiro' ? (p.prestado_em ? ' · entregue ao caixa' : ' · com você') : ''}{p.diferenca_prestacao && Number(p.diferenca_prestacao) !== 0 ? ` · diferença ${brl(p.diferenca_prestacao)}` : ''}</div>
          </div>
        ))}
        <div className="gc-rod">Comandas fechadas no caixa</div>
        {d && d.pagas.length === 0 && <div className="gc-vazio">Nenhuma comanda paga hoje.</div>}
        {(d ? d.pagas : []).map((p) => (
          <div key={p.id} className="gc-card">
            <div className="gc-linha"><span className="gc-nome">{p.tipo === 'pista' ? '🎫' : '🍽'} {p.identificador}</span><span className="gc-tag">#{p.numero}</span><span className="gc-total">{brl(p.meu_total)}</span></div>
            <div className="gc-sub">{new Date(p.fechada_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · total da comanda {brl(p.total_comanda)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
