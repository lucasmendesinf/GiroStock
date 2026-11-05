import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../components/ui.jsx';
import { brl, dataHora, FORMA_PAGAMENTO, parseNumero } from '../utils/format';

// Casa de shows e eventos: agenda (lista e calendario), cadastro, abrir/encerrar/cancelar e o resumo de vendas do evento.
// Enquanto o evento esta aberto, toda venda do setor dele (PDV, comanda de pista, pedido) fica ligada ao evento.
const NOME_STATUS = { agendado: 'Agendado', aberto: 'Em andamento', encerrado: 'Encerrado', cancelado: 'Cancelado' };
const COR_STATUS = { agendado: 'info', aberto: 'ok', encerrado: '', cancelado: 'err' };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Data/hora no horario de Brasilia para os campos datetime-local ("2026-12-05T21:00").
function paraCampo(v) {
  if (!v) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const diaDe = (v) => paraCampo(v).slice(0, 10);
const hora = (v) => new Date(v).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const quando = (e) => {
  const d = new Date(e.inicio);
  const dia = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: 'short' });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return `${dia} · ${hora}${e.fim ? ` às ${new Date(e.fim).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}` : ''}`;
};

export default function Eventos() {
  const toast = useToast();
  const [aba, setAba] = useState('proximos');
  const [lista, setLista] = useState(null);
  const [locais, setLocais] = useState([]);
  const [form, setForm] = useState(null); // evento em edicao ({} = novo)
  const [abertoId, setAbertoId] = useState(null);
  const carregar = useCallback(async () => {
    try { setLista(await api.get('/eventos')); } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); api.get('/locations').then((l) => setLocais(l.filter((x) => x.ativo))).catch(() => {}); }, [carregar]);

  const emAndamento = (lista || []).find((e) => e.status === 'aberto');
  const proximos = (lista || []).filter((e) => e.status === 'agendado');
  const passados = (lista || []).filter((e) => e.status === 'encerrado' || e.status === 'cancelado').reverse();

  return (
    <div className="page">
      <div className="page-header">
        <h2>Eventos</h2>
        <button type="button" className="btn-primario" onClick={() => setForm({})}>+ Novo evento</button>
      </div>
      {emAndamento && (
        <button type="button" className="card ev-andamento" onClick={() => setAbertoId(emAndamento.id)}>
          <span className="ped-pill ok">Em andamento</span>
          <b>{emAndamento.nome}</b>
          <span className="cl-sub">{emAndamento.location_nome} · aberto às {hora(emAndamento.aberto_em)}</span>
          <span className="ev-andamento-total"><small>vendido até agora</small>{brl(emAndamento.faturamento)} <small>({emAndamento.vendas} vendas)</small></span>
        </button>
      )}
      <div className="ped-bar" role="tablist">
        {[['proximos', `Próximos (${proximos.length})`], ['calendario', 'Calendário'], ['passados', 'Encerrados e cancelados']].map(([k, n]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={`btn-link ${aba === k ? 'ativo' : ''}`} onClick={() => setAba(k)}>{n}</button>
        ))}
      </div>
      {!lista ? <p className="muted">Carregando…</p> : (
        <>
          {aba === 'proximos' && <ListaEventos itens={proximos} vazio="Nenhum evento agendado. Clique em “+ Novo evento”." onAbrir={setAbertoId} />}
          {aba === 'passados' && <ListaEventos itens={passados} vazio="Nenhum evento encerrado ainda." onAbrir={setAbertoId} />}
          {aba === 'calendario' && <Calendario eventos={lista} onAbrir={setAbertoId} onNovo={(dia) => setForm({ inicio: `${dia}T21:00` })} />}
        </>
      )}
      {form && <FormEvento evento={form} locais={locais} onClose={() => setForm(null)} onSalvo={async (e) => { setForm(null); await carregar(); setAbertoId(e.id); }} />}
      {abertoId && <DetalheEvento id={abertoId} onClose={() => setAbertoId(null)} onEditar={(e) => { setAbertoId(null); setForm(e); }} onMudou={carregar} />}
    </div>
  );
}

function ListaEventos({ itens, vazio, onAbrir }) {
  if (!itens.length) return <Vazio>{vazio}</Vazio>;
  return (
    <div className="ev-lista">
      {itens.map((e) => {
        const d = new Date(e.inicio);
        return (
          <button key={e.id} type="button" className="card ev-item" onClick={() => onAbrir(e.id)}>
            <span className="ev-data">
              <b>{d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit' })}</b>
              <small>{d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'short' }).replace('.', '')}</small>
            </span>
            <span className="ev-info">
              <b>{e.nome}</b>
              <span className="cl-sub">{quando(e)} · {e.location_nome}</span>
              {e.atracoes && <span className="cl-sub">{e.atracoes}</span>}
            </span>
            <span className="ev-lado">
              <span className={`ped-pill ${COR_STATUS[e.status]}`}>{NOME_STATUS[e.status]}</span>
              {e.status === 'encerrado' && <b>{brl(e.faturamento)}</b>}
              {e.publicado_site && e.status === 'agendado' && <small className="cl-sub">no site</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Calendario({ eventos, onAbrir, onNovo }) {
  const hoje = new Date();
  const [mes, setMes] = useState({ a: hoje.getFullYear(), m: hoje.getMonth() });
  const porDia = useMemo(() => {
    const r = {};
    for (const e of eventos) (r[diaDe(e.inicio)] = r[diaDe(e.inicio)] || []).push(e);
    return r;
  }, [eventos]);
  const primeiro = new Date(mes.a, mes.m, 1);
  const dias = new Date(mes.a, mes.m + 1, 0).getDate();
  const celulas = [...Array(primeiro.getDay()).fill(null), ...Array.from({ length: dias }, (_, i) => i + 1)];
  const chave = (d) => `${mes.a}-${String(mes.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const mudar = (n) => setMes(({ a, m }) => ({ a: m + n < 0 ? a - 1 : m + n > 11 ? a + 1 : a, m: (m + n + 12) % 12 }));
  const hojeK = paraCampo(hoje).slice(0, 10);
  return (
    <div className="card">
      <div className="ev-cal-topo">
        <button type="button" onClick={() => mudar(-1)} aria-label="Mês anterior">‹</button>
        <b>{MESES[mes.m][0].toUpperCase() + MESES[mes.m].slice(1)} de {mes.a}</b>
        <button type="button" onClick={() => mudar(1)} aria-label="Próximo mês">›</button>
      </div>
      <div className="ev-cal">
        {SEMANA.map((s) => <span key={s} className="ev-cal-sem">{s}</span>)}
        {celulas.map((d, i) => (d === null ? <span key={`v${i}`} /> : (
          <div key={d} className={`ev-cal-dia ${chave(d) === hojeK ? 'hoje' : ''}`}>
            <button type="button" className="ev-cal-num" onClick={() => onNovo(chave(d))} title="Novo evento neste dia">{d}</button>
            {(porDia[chave(d)] || []).map((e) => (
              <button key={e.id} type="button" className={`ev-cal-ev ${e.status}`} onClick={() => onAbrir(e.id)} title={e.nome}>
                {new Date(e.inicio).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })} {e.nome}
              </button>
            ))}
          </div>
        )))}
      </div>
    </div>
  );
}

function FormEvento({ evento, locais, onClose, onSalvo }) {
  const toast = useToast();
  const editando = !!evento.id;
  const [f, setF] = useState({
    nome: evento.nome || '', inicio: evento.id ? paraCampo(evento.inicio) : evento.inicio || '', fim: paraCampo(evento.fim),
    location_id: evento.location_id || '', deposito_id: evento.deposito_id || '', atracoes: evento.atracoes || '', descricao: evento.descricao || '',
    preco_ingresso: evento.preco_ingresso === null || evento.preco_ingresso === undefined ? '' : String(evento.preco_ingresso).replace('.', ','),
    link_ingresso: evento.link_ingresso || '', publicado_site: !!evento.publicado_site,
  });
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const travado = editando && evento.status !== 'agendado';
  const so = (k) => (v) => setF({ ...f, [k]: v.target.type === 'checkbox' ? v.target.checked : v.target.value });

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    if (f.nome.trim().length < 3) return setErro('Informe o nome do evento.');
    if (!f.inicio) return setErro('Informe a data e a hora de início.');
    if (!f.location_id) return setErro('Escolha o setor do evento.');
    const corpo = { ...f, fim: f.fim || null, deposito_id: f.deposito_id || null, preco_ingresso: f.preco_ingresso.trim() ? parseNumero(f.preco_ingresso) : null, link_ingresso: f.link_ingresso.trim() || null };
    if (editando && evento.status === 'encerrado') { for (const k of ['nome', 'inicio', 'fim', 'location_id', 'deposito_id']) delete corpo[k]; }
    if (editando && evento.status === 'aberto') delete corpo.location_id;
    setSalvando(true);
    try {
      const r = editando ? await api.put(`/eventos/${evento.id}`, corpo) : await api.post('/eventos', corpo);
      toast.sucesso(editando ? 'Evento salvo' : 'Evento agendado');
      onSalvo(r);
    } catch (err) { setErro(err.message); toast.erro(err); } finally { setSalvando(false); }
  }

  const encerrado = editando && evento.status === 'encerrado';
  return (
    <Modal titulo={editando ? `Editar: ${evento.nome}` : 'Novo evento'} subtitulo="Enquanto o evento estiver aberto, as vendas do setor escolhido ficam ligadas a ele." onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar} noValidate>
        <div className="form-grid">
          <Field label="Nome do evento *" style={{ flexBasis: '100%' }}><input autoFocus value={f.nome} onChange={so('nome')} maxLength={120} placeholder="Ex.: Show de Sábado – Banda X" disabled={encerrado} /></Field>
          <Field label="Início (abertura da casa) *"><input type="datetime-local" value={f.inicio} onChange={so('inicio')} disabled={encerrado} /></Field>
          <Field label="Fim previsto"><input type="datetime-local" value={f.fim} onChange={so('fim')} disabled={encerrado} /></Field>
          <Field label="Setor do evento *" hint="Local do estoque e dos PDVs do evento (ex.: Bar do Show)">
            <select value={f.location_id} onChange={so('location_id')} disabled={travado}>
              <option value="">Escolha...</option>
              {locais.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
          <Field label="Depósito" hint="De onde sai a carga do evento e para onde volta a sobra">
            <select value={f.deposito_id} onChange={so('deposito_id')} disabled={encerrado}>
              <option value="">—</option>
              {locais.filter((l) => l.id !== f.location_id).map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
          <Field label="Atrações" style={{ flexBasis: '100%' }}><input value={f.atracoes} onChange={so('atracoes')} maxLength={1000} placeholder="Ex.: Banda X, DJ Y" /></Field>
          <Field label="Descrição" style={{ flexBasis: '100%' }}><textarea rows={3} value={f.descricao} onChange={so('descricao')} maxLength={4000} /></Field>
          <Field label="Preço do ingresso (R$)" hint="Só informativo"><input inputMode="decimal" value={f.preco_ingresso} onChange={so('preco_ingresso')} placeholder="0,00" /></Field>
          <Field label="Link de venda do ingresso"><input value={f.link_ingresso} onChange={so('link_ingresso')} placeholder="https://..." /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.publicado_site} onChange={so('publicado_site')} /> Divulgar no site da casa</label>
        {erro && <div className="es-erro">{erro}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={salvando}>{salvando ? 'Salvando...' : editando ? 'Salvar' : 'Agendar evento'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DetalheEvento({ id, onClose, onEditar, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [e, setE] = useState(null);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const carregar = useCallback(() => api.get(`/eventos/${id}`).then(setE).catch((err) => { toast.erro(err); onClose(); }), [id, toast, onClose]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!e) return <Modal titulo="Evento" onClose={onClose}><p className="muted">Carregando…</p></Modal>;

  async function acao(rota, msg, corpo) {
    setOcupado(true);
    try { setE(await api.post(`/eventos/${e.id}/${rota}`, corpo || {})); toast.sucesso(msg); onMudou(); setCancelando(false); } catch (err) { toast.erro(err); } finally { setOcupado(false); }
  }
  async function abrir() {
    if (!(await confirmar({ titulo: `Abrir "${e.nome}"?`, mensagem: `A partir de agora, as vendas do setor ${e.location_nome} (PDV, comandas e pedidos) ficam ligadas a este evento.`, confirmar: 'Abrir evento' }))) return;
    acao('abrir', 'Evento aberto: as vendas do setor já contam para ele');
  }
  async function encerrar() {
    if (!(await confirmar({ titulo: `Encerrar "${e.nome}"?`, mensagem: 'As próximas vendas do setor não contam mais para o evento.', confirmar: 'Encerrar evento' }))) return;
    acao('encerrar', 'Evento encerrado');
  }
  const r = e.resumo;
  const pend = e.pendencias && (e.pendencias.comandas || e.pendencias.pedidos);
  return (
    <Modal titulo={e.nome} subtitulo={`${quando(e)} · ${e.location_nome}`} onClose={onClose} largura="extra">
      <div className="form-stack">
        <div className="ev-det-topo">
          <span className={`ped-pill ${COR_STATUS[e.status]}`}>{NOME_STATUS[e.status]}</span>
          {e.aberto_em && <span className="cl-sub">aberto {dataHora(e.aberto_em)}{e.aberto_por_nome ? ` por ${e.aberto_por_nome}` : ''}</span>}
          {e.encerrado_em && <span className="cl-sub">· encerrado {dataHora(e.encerrado_em)}{e.encerrado_por_nome ? ` por ${e.encerrado_por_nome}` : ''}</span>}
          {e.status === 'cancelado' && <span className="cl-sub">motivo: {e.motivo_cancelamento}</span>}
        </div>
        {(e.atracoes || e.descricao) && (
          <div className="ev-texto">
            {e.atracoes && <p><b>Atrações:</b> {e.atracoes}</p>}
            {e.descricao && <p>{e.descricao}</p>}
            <p className="cl-sub">{e.preco_ingresso !== null ? `Ingresso ${brl(e.preco_ingresso)}` : 'Ingresso: —'}{e.link_ingresso ? <> · <a href={e.link_ingresso} target="_blank" rel="noreferrer">link de venda</a></> : null} · {e.publicado_site ? 'divulgado no site' : 'fora do site'}{e.deposito_nome ? ` · depósito: ${e.deposito_nome}` : ''}</p>
          </div>
        )}
        {e.status === 'aberto' && pend ? (
          <div className="es-erro">Para encerrar, feche ou cancele no setor: {[e.pendencias.comandas && `${e.pendencias.comandas} comanda(s) aberta(s)`, e.pendencias.pedidos && `${e.pendencias.pedidos} pedido(s) em aberto`].filter(Boolean).join(' e ')}.</div>
        ) : null}

        {(e.status === 'aberto' || e.status === 'encerrado') && (
          <>
            <div className="ped-kpis ev-kpis">
              <div className="ped-kpi hero"><small>Faturamento</small><b>{brl(r.faturamento)}</b><span className="cl-sub">{r.vendas} venda(s)</span></div>
              <div className="ped-kpi"><small>Ticket médio</small><b>{brl(r.ticket_medio)}</b></div>
              <div className="ped-kpi"><small>Canceladas</small><b>{r.canceladas}</b><span className="cl-sub">{brl(r.valor_cancelado)}</span></div>
              <div className="ped-kpi"><small>Vendas</small><b style={{ fontSize: 15 }}>{r.primeira_venda ? `${hora(r.primeira_venda)} às ${hora(r.ultima_venda)}` : '—'}</b><span className="cl-sub">primeira e última</span></div>
            </div>
            {r.vendas > 0 && (
              <div className="ev-resumo">
                <TabelaResumo titulo="Por operador" linhas={r.por_operador} nome={(x) => x.nome} />
                <TabelaResumo titulo="Por PDV" linhas={r.por_pdv} nome={(x) => x.nome} />
                <TabelaResumo titulo="Por forma de pagamento" linhas={r.por_forma} nome={(x) => FORMA_PAGAMENTO[x.forma] || x.forma} />
              </div>
            )}
          </>
        )}

        {cancelando && (
          <div className="card form-stack" style={{ margin: 0 }}>
            <Field label="Motivo do cancelamento"><input autoFocus value={motivo} onChange={(ev) => setMotivo(ev.target.value)} maxLength={300} placeholder="Ex.: chuva forte" /></Field>
            <div className="modal-actions">
              <button type="button" onClick={() => setCancelando(false)}>Voltar</button>
              <button type="button" className="perigo" disabled={ocupado || motivo.trim().length < 3} onClick={() => acao('cancelar', 'Evento cancelado', { motivo })}>Cancelar evento</button>
            </div>
          </div>
        )}

        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
          <span>
            {e.status === 'agendado' && !cancelando && <button type="button" className="btn-link perigo" onClick={() => setCancelando(true)}>Cancelar evento</button>}
          </span>
          <span className="lv-acoes">
            {e.status !== 'cancelado' && <button type="button" onClick={() => onEditar(e)}>Editar</button>}
            {e.status === 'agendado' && <button type="button" className="btn-primario" disabled={ocupado} onClick={abrir}>Abrir evento</button>}
            {e.status === 'aberto' && <button type="button" className="btn-primario" disabled={ocupado || !!pend} onClick={encerrar}>Encerrar evento</button>}
          </span>
        </div>
      </div>
    </Modal>
  );
}

function TabelaResumo({ titulo, linhas, nome }) {
  return (
    <div>
      <h4>{titulo}</h4>
      <table className="tabela-cartoes">
        <tbody>{linhas.map((x, i) => <tr key={i}><td>{nome(x)}</td><td className="num">{x.vendas !== undefined ? `${x.vendas} · ` : ''}<b>{brl(x.total)}</b></td></tr>)}</tbody>
      </table>
    </div>
  );
}
