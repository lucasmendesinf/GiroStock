import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Modal } from '../components/ui.jsx';
import { brl, dataHora, fmtTel } from '../utils/format';

const SEGMENTOS = [
  ['todos', 'Todos'], ['novo', 'Novos'], ['recorrente', 'Recorrentes'], ['vip', 'VIP'], ['risco', 'Em risco'],
  ['inativo', 'Inativos'], ['aniversario', 'Aniversariantes'], ['sem_whatsapp', 'Sem WhatsApp'],
];
const NOME_SEG = Object.fromEntries(SEGMENTOS);

const diasTxt = (d) => (d === null || d === undefined ? '—' : d === 0 ? 'hoje' : `há ${d} dia${d === 1 ? '' : 's'}`);
const corDias = (d) => (d !== null && d >= 60 ? 'var(--err)' : d !== null && d >= 30 ? 'var(--warn)' : 'var(--muted)');
const podeMsg = (c) => c.aceita_mensagens && !!c.telefone;
const dataCurta = (v) => (v ? dataHora(v).slice(0, 10) : '');

export default function Clientes() {
  const toast = useToast();
  const navigate = useNavigate();
  const [lojas, setLojas] = useState([]);
  const [lojaId, setLojaId] = useState('');
  const [todos, setTodos] = useState([]);
  const [carregado, setCarregado] = useState(false);
  const [segmento, setSegmento] = useState('todos');
  const [busca, setBusca] = useState('');
  const [aberto, setAberto] = useState(null); // ficha do cliente na gaveta
  const [importar, setImportar] = useState(false);
  const [mensagem, setMensagem] = useState(null); // { segmento, cliente }
  const [novo, setNovo] = useState(false);
  const [sugestao, setSugestao] = useState({ novos: 0, duplicados: 0 });

  useEffect(() => { api.get('/locations').then((l) => setLojas(l.filter((x) => x.ativo !== false))).catch(() => {}); }, []);

  const carregar = useCallback(async () => {
    try {
      setTodos(await api.get(`/customers${lojaId ? `?location_id=${lojaId}` : ''}`));
      const prev = await api.get('/customers/import-preview');
      setSugestao({ novos: prev.novos, duplicados: prev.duplicados });
    } catch (err) { toast.erro(err); } finally { setCarregado(true); }
  }, [lojaId, toast]);
  useEffect(() => { carregar(); }, [carregar]);

  const contagem = useMemo(() => {
    const m = { todos: todos.length };
    SEGMENTOS.forEach(([k]) => { if (k !== 'todos') m[k] = todos.filter((c) => c.segmentos.includes(k)).length; });
    return m;
  }, [todos]);

  const lista = useMemo(() => {
    const t = busca.trim().toLowerCase();
    const d = busca.replace(/\D/g, '');
    return todos.filter((c) => (segmento === 'todos' || c.segmentos.includes(segmento))
      && (!t || c.nome.toLowerCase().includes(t) || (d && (c.telefone || '').includes(d)) || c.bairro.toLowerCase().includes(t)));
  }, [todos, segmento, busca]);

  const kpi = useMemo(() => {
    const pedidos = todos.reduce((s, c) => s + c.pedidos, 0);
    const gasto = todos.reduce((s, c) => s + c.total_gasto, 0);
    return {
      total: todos.length, aceitam: todos.filter(podeMsg).length,
      novos: contagem.novo || 0,
      ativos: todos.filter((c) => c.dias_ultimo !== null && c.dias_ultimo < 30).length,
      reativar: todos.filter((c) => c.segmentos.includes('risco') || c.segmentos.includes('inativo')).length,
      ticket: pedidos > 0 ? gasto / pedidos : 0, pedidos,
    };
  }, [todos, contagem]);

  async function abrirFicha(id) {
    try { setAberto(await api.get(`/customers/${id}`)); } catch (err) { toast.erro(err); }
  }
  async function recarregarFicha(id) {
    await carregar();
    if (id) setAberto(await api.get(`/customers/${id}`));
  }

  function novoPedido(c, repetir) {
    const ult = c.ultimos_pedidos[0];
    navigate('/pdv', { state: { repetir: { telefone: c.telefone ? fmtTel(c.telefone) : '', itens: repetir && ult ? ult.itens : [] } } });
  }

  return (
    <div className="page">
      <div className="ped-head">
        <h2>Clientes</h2>
        {lojas.length > 1 && (
          <select value={lojaId} onChange={(e) => setLojaId(e.target.value)} aria-label="Loja" style={{ width: 'auto' }}>
            <option value="">Todas as lojas</option>
            {lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
          </select>
        )}
        <button type="button" className="btn-link" onClick={() => setImportar(true)}>⇩ Gerar a partir dos pedidos</button>
        <button type="button" className="btn-link" onClick={() => setMensagem({ segmento: 'inativo', cliente: null })}>✉ Enviar mensagem</button>
        <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ Novo cliente</button>
      </div>

      {(sugestao.novos > 0 || sugestao.duplicados > 0) && (
        <div className="cl-banner">
          <span style={{ fontSize: 20 }}>💡</span>
          <div style={{ flex: 1 }}>
            Encontramos <b>{sugestao.novos} cliente{sugestao.novos === 1 ? '' : 's'} novo{sugestao.novos === 1 ? '' : 's'}</b> e{' '}
            <b>{sugestao.duplicados} possível{sugestao.duplicados === 1 ? '' : 'is'} duplicado{sugestao.duplicados === 1 ? '' : 's'}</b> nos seus pedidos que ainda não estão na base.
          </div>
          <button type="button" className="btn-primario" style={{ padding: '8px 14px' }} onClick={() => setImportar(true)}>Revisar e criar</button>
        </div>
      )}

      <div className="ped-kpis">
        <div className="ped-kpi"><small>Clientes</small><b>{kpi.total}</b><span className="cl-sub">{kpi.aceitam} aceitam mensagens</span></div>
        <div className="ped-kpi"><small>Novos (30 dias)</small><b>{kpi.novos}</b><span className="cl-sub">primeiro pedido recente</span></div>
        <div className="ped-kpi"><small>Ativos (30 dias)</small><b>{kpi.ativos}</b><span className="cl-sub">pediram no último mês</span></div>
        <div className="ped-kpi hero" style={{ cursor: 'pointer' }} onClick={() => setSegmento('risco')}><small>Para reativar</small><b>{kpi.reativar}</b><span className="cl-sub">em risco + inativos · clique para ver</span></div>
        <div className="ped-kpi"><small>Ticket médio</small><b>{brl(kpi.ticket)}</b><span className="cl-sub">{kpi.pedidos} pedidos</span></div>
      </div>

      <div className="ped-bar">
        {SEGMENTOS.map(([k, nome]) => (
          <button key={k} type="button" className={`ped-chip ${segmento === k ? 'on' : ''}`} onClick={() => setSegmento(k)}>{nome} <i className="cl-n">{contagem[k] || 0}</i></button>
        ))}
      </div>
      <div className="ped-bar">
        <input className="ped-busca" style={{ maxWidth: 360 }} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome, telefone ou bairro" aria-label="Buscar cliente" />
        <span className="cl-sub" style={{ marginLeft: 'auto' }}>{lista.length} cliente{lista.length === 1 ? '' : 's'}</span>
      </div>

      <div className="card">
        <div className="tabela-wrap">
          <table>
            <thead>
              <tr><th>Cliente</th><th>Bairro</th><th className="num">Pedidos</th><th className="num">Total gasto</th><th className="num">Ticket médio</th><th>Último pedido</th><th>Segmentos</th><th>Mensagens</th></tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} className="clicavel" tabIndex={0} onClick={() => abrirFicha(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') abrirFicha(c.id); }}>
                  <td><b>{c.nome}</b><div className="cl-sub">{c.telefone ? fmtTel(c.telefone) : 'sem telefone'}</div></td>
                  <td>{c.bairro || '—'}</td>
                  <td className="num">{c.pedidos}</td>
                  <td className="num"><b style={{ color: 'var(--gold-light)' }}>{brl(c.total_gasto)}</b></td>
                  <td className="num">{c.pedidos > 0 ? brl(c.ticket_medio) : '—'}</td>
                  <td style={{ color: corDias(c.dias_ultimo) }}>{diasTxt(c.dias_ultimo)}</td>
                  <td>{c.segmentos.map((s) => <span key={s} className="ped-tag" style={{ marginRight: 4 }}>{NOME_SEG[s]}</span>)}</td>
                  <td>{podeMsg(c) ? <span className="ped-pill ok">Aceita</span> : c.telefone ? <span className="ped-pill warn">Não aceita</span> : <span className="ped-pill err">Sem contato</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {carregado && lista.length === 0 && <div className="ped-vazio">Nenhum cliente neste filtro</div>}
      </div>

      {aberto && (
        <Gaveta c={aberto} onClose={() => setAberto(null)} onMudou={() => recarregarFicha(aberto.id)}
          onNovoPedido={() => novoPedido(aberto, false)} onRepetir={() => novoPedido(aberto, true)}
          onMensagem={() => setMensagem({ segmento: aberto.segmentos[0] || 'todos', cliente: aberto })} />
      )}
      {importar && <ModalImportar onClose={() => setImportar(false)} onFeito={() => { setImportar(false); carregar(); }} />}
      {mensagem && <ModalMensagem inicial={mensagem} onClose={() => setMensagem(null)} />}
      {novo && <ModalNovo onClose={() => setNovo(false)} onCriado={(c) => { setNovo(false); toast.sucesso('Cliente cadastrado'); carregar(); setAberto(c); }} />}
    </div>
  );
}

// ---------- gaveta de detalhe ----------
function Gaveta({ c, onClose, onMudou, onNovoPedido, onRepetir, onMensagem }) {
  const toast = useToast();
  const [obs, setObs] = useState(c.observacao || '');
  const [novoEnd, setNovoEnd] = useState(null); // { rotulo, endereco, bairro }
  useEffect(() => { setObs(c.observacao || ''); }, [c.id, c.observacao]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.modal')) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function salvar(dados, msg) {
    try { await api.patch(`/customers/${c.id}`, dados); if (msg) toast.sucesso(msg); await onMudou(); } catch (err) { toast.erro(err); }
  }
  async function salvarEndereco() {
    try { await api.post(`/customers/${c.id}/addresses`, novoEnd); setNovoEnd(null); await onMudou(); } catch (err) { toast.erro(err); }
  }

  return (
    <div className="ped-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ped-drawer" role="dialog" aria-label={`Cliente ${c.nome}`}>
        <button type="button" className="modal-close" style={{ float: 'right' }} aria-label="Fechar" onClick={onClose}>×</button>
        <h3>{c.nome}</h3>
        <div className="cl-sub">{c.telefone ? fmtTel(c.telefone) : 'Sem telefone'} · cliente há {c.dias_cadastro} dia{c.dias_cadastro === 1 ? '' : 's'}</div>
        <div style={{ marginTop: 8 }}>{c.segmentos.map((s) => <span key={s} className="ped-tag" style={{ marginRight: 4 }}>{NOME_SEG[s]}</span>)}</div>

        <div className="cl-stats">
          <div><small>Pedidos</small><b>{c.pedidos}</b></div>
          <div><small>Total gasto</small><b>{brl(c.total_gasto)}</b></div>
          <div><small>Ticket médio</small><b>{c.pedidos > 0 ? brl(c.ticket_medio) : '—'}</b></div>
        </div>
        <div className="ped-linha" style={{ marginTop: 10 }}><span className="cl-sub">Produto favorito</span><b>{c.produto_favorito ? `⭐ ${c.produto_favorito}` : '—'}</b></div>
        <div className="ped-linha"><span className="cl-sub">Último pedido</span><b>{diasTxt(c.dias_ultimo)}</b></div>
        {c.aniversario && <div className="ped-linha"><span className="cl-sub">Aniversário</span><b>{c.aniversario}</b></div>}

        <div className="ped-sec"><span className="ped-rotulo">Endereços</span>
          {c.enderecos.length === 0 && <div className="cl-sub">Nenhum endereço</div>}
          {c.enderecos.map((e) => (
            <div key={e.id} className="ped-linha"><span>🏠 {e.rotulo}: {e.endereco}{e.bairro ? ` · ${e.bairro}` : ''}</span>{e.padrao && <span className="ped-tag">padrão</span>}</div>
          ))}
          {novoEnd ? (
            <div className="cl-form-end">
              <input placeholder="Rótulo (Casa, Trabalho)" value={novoEnd.rotulo} onChange={(e) => setNovoEnd({ ...novoEnd, rotulo: e.target.value })} />
              <input placeholder="Rua, nº" value={novoEnd.endereco} onChange={(e) => setNovoEnd({ ...novoEnd, endereco: e.target.value })} />
              <input placeholder="Bairro" value={novoEnd.bairro} onChange={(e) => setNovoEnd({ ...novoEnd, bairro: e.target.value })} />
              <div className="cl-linha-btn"><button type="button" className="btn-link" onClick={() => setNovoEnd(null)}>Cancelar</button><button type="button" className="btn-primario" style={{ padding: '8px 14px' }} onClick={salvarEndereco}>Salvar</button></div>
            </div>
          ) : <button type="button" className="btn-link" onClick={() => setNovoEnd({ rotulo: 'Casa', endereco: '', bairro: '' })}>+ endereço</button>}
        </div>

        <div className="ped-sec"><span className="ped-rotulo">Últimos pedidos</span>
          {c.ultimos_pedidos.length === 0 && <div className="cl-sub">Sem pedidos</div>}
          {c.ultimos_pedidos.map((p) => (
            <div key={p.id} className="ped-linha">
              <span><b>#{p.numero}</b> · {dataCurta(p.criado_em)} · {p.itens.map((i) => `${Number(i.quantidade)}× ${i.nome}`).join(', ')}</span>
              <span>{brl(p.total)}</span>
            </div>
          ))}
        </div>

        <div className="ped-sec"><span className="ped-rotulo">Mensagens</span>
          <div className="cl-sw">
            <button type="button" role="switch" aria-checked={c.aceita_mensagens} className={c.aceita_mensagens ? 'on' : ''} disabled={!c.telefone}
              onClick={() => salvar({ aceita_mensagens: !c.aceita_mensagens, consentimento_origem: 'confirmado com o cliente' }, c.aceita_mensagens ? 'Consentimento retirado' : 'Consentimento registrado')} />
            <span>Aceita receber mensagens (WhatsApp)
              <div className="cl-sub">{!c.telefone ? 'Sem telefone: não dá para enviar mensagens' : c.aceita_mensagens
                ? `Consentimento registrado em ${dataCurta(c.consentimento_em)}${c.consentimento_origem ? ` · ${c.consentimento_origem}` : ''}` : 'Sem consentimento: não entra em campanhas'}</div>
            </span>
          </div>
          {c.mensagens.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {c.mensagens.slice(0, 3).map((m) => <div key={m.id} className="cl-sub">{dataCurta(m.criado_em)} · {m.status === 'aberto' ? 'aberta no WhatsApp' : 'na fila'}{m.enviado_por_nome ? ` · ${m.enviado_por_nome}` : ''}</div>)}
            </div>
          )}
        </div>

        <div className="ped-sec"><span className="ped-rotulo">Observações</span>
          <textarea rows={2} maxLength={500} value={obs} onChange={(e) => setObs(e.target.value)} onBlur={() => { if (obs !== (c.observacao || '')) salvar({ observacao: obs }, 'Observação salva'); }}
            placeholder="Ex.: alérgico a cebola, prefere pagar no Pix" style={{ width: '100%' }} />
        </div>

        <div className="cl-linha-btn" style={{ justifyContent: 'flex-start', marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="btn-primario" style={{ width: 'auto', padding: '10px 16px' }} onClick={onNovoPedido}>Novo pedido</button>
          <button type="button" className="btn-link" disabled={c.ultimos_pedidos.length === 0} onClick={onRepetir}>Repetir último pedido</button>
          <button type="button" className="btn-link" disabled={!podeMsg(c)} onClick={onMensagem}>✉ Mensagem</button>
        </div>
      </aside>
    </div>
  );
}

// ---------- gerar a partir dos pedidos ----------
function ModalImportar({ onClose, onFeito }) {
  const toast = useToast();
  const [cand, setCand] = useState(null);
  const [marcados, setMarcados] = useState({});
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    api.get('/customers/import-preview').then((r) => {
      setCand(r.candidatos);
      setMarcados(Object.fromEntries(r.candidatos.filter((c) => c.tipo === 'novo' || c.tipo === 'mesclar').map((c) => [c.telefone, true])));
    }).catch((err) => { toast.erro(err); onClose(); });
  }, [toast, onClose]);

  const nNovos = cand ? cand.filter((c) => c.tipo === 'novo' && marcados[c.telefone]).length : 0;
  const nMesclar = cand ? cand.filter((c) => c.tipo === 'mesclar' && marcados[c.telefone]).length : 0;

  async function confirmar() {
    setSalvando(true);
    try {
      const r = await api.post('/customers/import', { telefones: Object.keys(marcados).filter((t) => marcados[t]) });
      toast.sucesso(`${r.criados} cliente(s) criado(s) e ${r.mesclados} mesclado(s)`);
      onFeito();
    } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Gerar clientes a partir dos pedidos" subtitulo="Lemos nome, telefone e endereço dos pedidos já feitos. Telefone é a chave: pedidos do mesmo telefone viram um cliente só." onClose={onClose} largura="larga">
      {!cand ? <p className="muted">Carregando...</p> : (
        <>
          <div style={{ marginTop: 6 }}>
            {cand.length === 0 && <div className="ped-vazio">Todos os pedidos já estão ligados a clientes.</div>}
            {cand.map((c) => {
              const fixo = c.tipo === 'sem_telefone' || c.tipo === 'ja_cadastrado';
              return (
                <div key={c.telefone || 'balcao'} className="cl-row">
                  <input type="checkbox" checked={fixo ? false : !!marcados[c.telefone]} disabled={fixo} onChange={(e) => setMarcados({ ...marcados, [c.telefone]: e.target.checked })} />
                  <div style={{ flex: 1 }}>
                    <b>{c.nome}</b> <span className="cl-sub">{c.telefone ? fmtTel(c.telefone) : 'sem telefone'} · {c.pedidos} pedido{c.pedidos === 1 ? '' : 's'}</span>
                    <div className="cl-sub">{c.endereco || '—'}</div>
                  </div>
                  {c.tipo === 'novo' && <span className="ped-pill ok">Novo cliente</span>}
                  {c.tipo === 'mesclar' && <span className="ped-pill warn">Mesclar com {c.com}</span>}
                  {c.tipo === 'ja_cadastrado' && <span className="ped-pill">Já cadastrado</span>}
                  {c.tipo === 'sem_telefone' && <span className="ped-pill err">Sem telefone — ignorado</span>}
                </div>
              );
            })}
          </div>
          <div className="ped-nota">Consentimento: clientes criados desta forma entram como <b>"não aceita mensagens"</b> até alguém confirmar com o cliente (balcão/telefone). Assim a base fica certa para a LGPD.</div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="button" disabled={salvando || nNovos + nMesclar === 0} onClick={confirmar}>Criar {nNovos} · mesclar {nMesclar}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------- enviar mensagem ----------
function ModalMensagem({ inicial, onClose }) {
  const toast = useToast();
  const unico = inicial.cliente;
  const [modelos, setModelos] = useState([]);
  const [seg, setSeg] = useState(inicial.segmento);
  const [modelo, setModelo] = useState(inicial.segmento === 'aniversario' ? 'aniversario' : 'reativacao');
  const [texto, setTexto] = useState('');
  const [prev, setPrev] = useState(null);
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    api.get('/customers/campaigns/modelos').then((m) => {
      setModelos(m);
      const escolhido = m.find((x) => x.id === modelo) || m[0];
      if (escolhido) setTexto(escolhido.texto);
    }).catch((err) => toast.erro(err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!texto.trim()) { setPrev(null); return undefined; }
    const t = setTimeout(async () => {
      try { setPrev(await api.post('/customers/campaigns/preview', { texto, segmento: seg, customer_id: unico ? unico.id : undefined })); } catch (err) { toast.erro(err); }
    }, 300);
    return () => clearTimeout(t);
  }, [texto, seg, unico, toast]);

  function escolherModelo(id) {
    setModelo(id);
    const m = modelos.find((x) => x.id === id);
    if (m) setTexto(m.texto);
  }
  const corpo = { texto, segmento: seg, modelo, customer_id: unico ? unico.id : undefined };
  async function criarFila() {
    setCriando(true);
    try { const r = await api.post('/customers/campaigns/queue', corpo); toast.sucesso(`Fila criada com ${r.registradas} mensagem(ns) · registrada no histórico`); onClose(); } catch (err) { toast.erro(err); setCriando(false); }
  }
  // O link do WhatsApp abre sozinho (sem esperar o servidor); o registro vai em paralelo.
  function registrarAbertura(id) {
    api.post('/customers/campaigns/queue', { ...corpo, customer_id: id, status: 'aberto' }).catch(() => {});
  }
  const primeiro = prev && prev.destinatarios[0];

  return (
    <Modal titulo="Enviar mensagem" onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="form-grid">
          <label className="field"><span className="field-label">Para quem</span>
            <select value={seg} disabled={!!unico} onChange={(e) => setSeg(e.target.value)}>{SEGMENTOS.map(([k, nome]) => <option key={k} value={k}>{nome}</option>)}</select>
          </label>
          <label className="field"><span className="field-label">Modelo</span>
            <select value={modelo} onChange={(e) => escolherModelo(e.target.value)}>{modelos.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}</select>
          </label>
        </div>
        <label className="field"><span className="field-label">Mensagem (use {'{nome}'})</span>
          <textarea rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </label>
        <div className="field"><span className="field-label">Prévia</span>
          <div className="cl-msg">{primeiro ? primeiro.mensagem : texto.replace(/\{nome\}/g, 'Cliente')}</div>
        </div>
        <div className="ped-sec">
          <div className="ped-linha"><b>{prev ? prev.total : 0} destinatário{prev && prev.total === 1 ? '' : 's'}</b>
            <span className="cl-sub">{prev && prev.bloqueados > 0 ? `${prev.bloqueados} fora por não aceitar mensagens / sem telefone` : 'todos com consentimento'}</span></div>
          {prev && prev.destinatarios.slice(0, 6).map((d) => (
            <div key={d.id} className="cl-row">
              <div style={{ flex: 1 }}><b>{d.nome}</b> <span className="cl-sub">{fmtTel(d.telefone)}</span></div>
              <a className="btn-link" href={d.link} target="_blank" rel="noreferrer" onClick={() => registrarAbertura(d.id)}>Abrir no WhatsApp</a>
            </div>
          ))}
          {prev && prev.total > 6 && <div className="cl-sub" style={{ padding: '8px 4px' }}>… e mais {prev.total - 6}</div>}
        </div>
        <div className="ped-nota"><b>Como enviar:</b> nesta fase, o botão abre o WhatsApp do atendente com a mensagem pronta (1 clique por cliente, tudo registrado no histórico). Envio automático em lote exige a API oficial do WhatsApp — fica para a fase seguinte. Toda mensagem de campanha leva "Responda SAIR para não receber mais mensagens".</div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          <button type="button" disabled={criando || !prev || prev.total === 0} onClick={criarFila}>Criar fila de envio</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- novo cliente ----------
function ModalNovo({ onClose, onCriado }) {
  const toast = useToast();
  const [f, setF] = useState({ nome: '', telefone: '', endereco: '', bairro: '', aniversario: '', aceita_mensagens: false });
  const [salvando, setSalvando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function salvar(e) {
    e.preventDefault();
    if (f.nome.trim().length < 2) { toast.erro('Informe o nome'); return; }
    setSalvando(true);
    try { onCriado(await api.post('/customers', { ...f, telefone: f.telefone.replace(/\D/g, '') })); } catch (err) { toast.erro(err); setSalvando(false); }
  }

  return (
    <Modal titulo="Novo cliente" onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <div className="form-grid">
          <label className="field"><span className="field-label">Nome</span><input value={f.nome} onChange={mudar('nome')} autoFocus /></label>
          <label className="field"><span className="field-label">Telefone (WhatsApp)</span><input value={f.telefone} onChange={(e) => setF({ ...f, telefone: fmtTel(e.target.value) })} placeholder="(00) 00000-0000" inputMode="tel" /></label>
        </div>
        <div className="form-grid">
          <label className="field"><span className="field-label">Endereço</span><input value={f.endereco} onChange={mudar('endereco')} /></label>
          <label className="field"><span className="field-label">Bairro</span><input value={f.bairro} onChange={mudar('bairro')} /></label>
        </div>
        <div className="form-grid">
          <label className="field"><span className="field-label">Aniversário</span><input value={f.aniversario} onChange={mudar('aniversario')} placeholder="dd/mm" maxLength={5} /></label>
        </div>
        <label className="cli-check"><input type="checkbox" checked={f.aceita_mensagens} onChange={(e) => setF({ ...f, aceita_mensagens: e.target.checked })} /> Cliente aceitou receber mensagens</label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" disabled={salvando}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}
