import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Modal, Paginacao, Vazio } from '../components/ui.jsx';
import Cupom, { imprimirCupom } from '../components/Cupom.jsx';
import { brl, dataHora, isoLocal, pct, qtd, FORMA_PAGAMENTO } from '../utils/format';

const LIMITE = 30;

// Periodos rapidos (datas locais, inclusivas).
function periodo(tipo) {
  const hoje = new Date();
  const d = (y, m, dia) => isoLocal(new Date(y, m, dia));
  const [y, m, dia] = [hoje.getFullYear(), hoje.getMonth(), hoje.getDate()];
  switch (tipo) {
    case 'hoje': return { data_inicio: d(y, m, dia), data_fim: d(y, m, dia) };
    case 'ontem': return { data_inicio: d(y, m, dia - 1), data_fim: d(y, m, dia - 1) };
    case '7dias': return { data_inicio: d(y, m, dia - 6), data_fim: d(y, m, dia) };
    case 'mes': return { data_inicio: d(y, m, 1), data_fim: d(y, m, dia) };
    case 'mes_passado': return { data_inicio: d(y, m - 1, 1), data_fim: d(y, m, 0) };
    default: return null;
  }
}
const PERIODOS = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7dias', '7 dias'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['personalizado', 'Período...']];

export default function Reports() {
  const toast = useToast();
  const [aba, setAba] = useState('vendas');
  const [locations, setLocations] = useState([]);
  const [users, setUsers] = useState([]);
  const [tipoPeriodo, setTipoPeriodo] = useState('hoje');
  const [datas, setDatas] = useState(periodo('hoje'));
  const [filtros, setFiltros] = useState({ location_id: '', operador_id: '', forma_pagamento: '', status: '' });
  const [vendaId, setVendaId] = useState(null);
  const [cupom, setCupom] = useState(null);

  useEffect(() => {
    api.get('/locations').then(setLocations).catch((err) => toast.erro(err));
    api.get('/users').then(setUsers).catch(() => setUsers([]));
  }, [toast]);

  function escolherPeriodo(tipo) {
    setTipoPeriodo(tipo);
    if (tipo !== 'personalizado') setDatas(periodo(tipo));
  }

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filtros, ...datas })) if (v) params.set(k, v);
    return params;
  }, [filtros, datas]);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Relatórios</h2>
        <div className="segmentado">
          <button type="button" className={aba === 'vendas' ? 'ativo' : ''} onClick={() => setAba('vendas')}>Vendas</button>
          <button type="button" className={aba === 'caixas' ? 'ativo' : ''} onClick={() => setAba('caixas')}>Fechamentos de caixa</button>
        </div>
      </div>

      <div className="card">
        <div className="periodo-rapido">
          {PERIODOS.map(([id, label]) => (
            <button key={id} type="button" className={`btn-link ${tipoPeriodo === id ? 'ativo' : ''}`} onClick={() => escolherPeriodo(id)}>{label}</button>
          ))}
        </div>
        <div className="filtros" style={{ marginTop: '12px' }}>
          {tipoPeriodo === 'personalizado' && (
            <>
              <Field label="De" style={{ flex: '0 0 170px' }}><input type="date" value={datas.data_inicio || ''} onChange={(e) => setDatas({ ...datas, data_inicio: e.target.value })} /></Field>
              <Field label="Até" style={{ flex: '0 0 170px' }}><input type="date" value={datas.data_fim || ''} onChange={(e) => setDatas({ ...datas, data_fim: e.target.value })} /></Field>
            </>
          )}
          <Field label="Loja" style={{ flex: '0 1 200px' }}>
            <select value={filtros.location_id} onChange={(e) => setFiltros({ ...filtros, location_id: e.target.value })}>
              <option value="">Todas</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
          {aba === 'vendas' && (
            <>
              {users.length > 0 && (
                <Field label="Operador" style={{ flex: '0 1 200px' }}>
                  <select value={filtros.operador_id} onChange={(e) => setFiltros({ ...filtros, operador_id: e.target.value })}>
                    <option value="">Todos</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Pagamento" style={{ flex: '0 1 200px' }}>
                <select value={filtros.forma_pagamento} onChange={(e) => setFiltros({ ...filtros, forma_pagamento: e.target.value })}>
                  <option value="">Todas</option>
                  {Object.entries(FORMA_PAGAMENTO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Situação" style={{ flex: '0 1 180px' }}>
                <select value={filtros.status} onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}>
                  <option value="">Todas</option>
                  <option value="concluida">Concluídas</option>
                  <option value="cancelada">Canceladas</option>
                </select>
              </Field>
            </>
          )}
        </div>
      </div>

      {aba === 'vendas' && <AbaVendas query={query} onAbrirVenda={setVendaId} />}
      {aba === 'caixas' && <AbaCaixas query={query} />}

      {vendaId && (
        <DetalheVenda id={vendaId} onClose={() => setVendaId(null)} onImprimir={(v) => imprimirCupom(setCupom, v)}
          onCancelada={() => { setVendaId(null); setFiltros({ ...filtros }); }} />
      )}
      {cupom && <Cupom venda={cupom} />}
    </div>
  );
}

function AbaVendas({ query, onAbrirVenda }) {
  const toast = useToast();
  const [resumo, setResumo] = useState(null);
  const [top, setTop] = useState([]);
  const [hist, setHist] = useState({ itens: [], total: 0, offset: 0 });

  const carregarHistorico = useCallback(async (offset = 0) => {
    const p = new URLSearchParams(query);
    p.set('limit', String(LIMITE));
    p.set('offset', String(offset));
    try {
      const r = await api.get(`/reports/sales-history?${p}`);
      setHist({ itens: r.itens, total: r.total, offset });
    } catch (err) { toast.erro(err); }
  }, [query, toast]);

  useEffect(() => {
    const qs = query.toString();
    Promise.all([api.get(`/reports/sales-summary?${qs}`), api.get(`/reports/top-products?${qs}`)])
      .then(([r, t]) => { setResumo(r); setTop(t); })
      .catch((err) => toast.erro(err));
    carregarHistorico(0);
  }, [query, carregarHistorico, toast]);

  return (
    <>
      {resumo && (
        <div className="cards-resumo">
          <div className="card"><h4>Total vendido</h4><p>{brl(resumo.total_vendido)}</p></div>
          <div className="card"><h4>Vendas</h4><p>{resumo.numero_vendas}</p></div>
          <div className="card"><h4>Ticket médio</h4><p>{brl(resumo.ticket_medio)}</p></div>
          <div className="card"><h4>Lucro bruto</h4><p>{brl(resumo.lucro_bruto)}</p><span className="muted">margem {pct(resumo.margem_percentual)}</span></div>
          <div className="card"><h4>Custo das mercadorias</h4><p>{brl(resumo.custo_total)}</p></div>
          <div className="card"><h4>Descontos</h4><p>{brl(resumo.total_descontos)}</p></div>
          <div className="card"><h4>Canceladas</h4><p>{resumo.vendas_canceladas}</p><span className="muted">{brl(resumo.total_cancelado)}</span></div>
          <div className="card"><h4>Forma mais usada</h4><p className="p-menor">{FORMA_PAGAMENTO[resumo.forma_pagamento_mais_usada] || '—'}</p></div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>Por forma de pagamento</h3>
          {resumo && resumo.quebra_por_forma_pagamento.length === 0 && <Vazio>Sem vendas no período.</Vazio>}
          <ul className="lista-simples">
            {resumo && resumo.quebra_por_forma_pagamento.map((r) => (
              <li key={r.forma_pagamento}>
                <span>{FORMA_PAGAMENTO[r.forma_pagamento]} <span className="muted">· {r.quantidade} venda(s)</span></span>
                <span><strong>{brl(r.total)}</strong> <span className="muted">{pct(r.percentual)}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>Produtos mais vendidos</h3>
          {top.length === 0 && <Vazio>Sem vendas no período.</Vazio>}
          <ul className="lista-simples">
            {top.map((t, i) => (
              <li key={t.id}>
                <span>{i + 1}. {t.nome} <span className="muted">· {qtd(t.quantidade, t.unidade)} {t.unidade}</span></span>
                <span><strong>{brl(t.faturamento)}</strong> <span className="muted">lucro {brl(t.lucro)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card">
        <h3>Histórico de vendas</h3>
        <div className="tabela-wrap">
          <table>
            <thead><tr><th>Nº</th><th>Data/hora</th><th className="col-opcional">Operador</th><th className="col-opcional">Loja / PDV</th><th className="col-opcional">Pagamento</th><th className="num">Total</th><th>Situação</th></tr></thead>
            <tbody>
              {hist.itens.map((h) => (
                <tr key={h.id} className={`clicavel ${h.status === 'cancelada' ? 'row-inativa' : ''}`} onClick={() => onAbrirVenda(h.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') onAbrirVenda(h.id); }}>
                  <td><strong>{h.numero}</strong></td>
                  <td>{dataHora(h.criado_em)}</td>
                  <td className="col-opcional">{h.operador_nome}</td>
                  <td className="col-opcional">{h.location_nome}<div className="celula-sub">{h.terminal_nome}</div></td>
                  <td className="col-opcional">{FORMA_PAGAMENTO[h.forma_pagamento]}</td>
                  <td className="num">{brl(h.total)}{Number(h.desconto) > 0 && <div className="celula-sub">desc. {brl(h.desconto)}</div>}</td>
                  <td>{h.status === 'cancelada' ? <span className="badge-cancelada" title={h.motivo_cancelamento || ''}>Cancelada</span> : 'Concluída'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hist.itens.length === 0 && <Vazio>Nenhuma venda no período.</Vazio>}
        <Paginacao total={hist.total} limit={LIMITE} offset={hist.offset} onChange={carregarHistorico} />
      </div>
    </>
  );
}

function AbaCaixas({ query }) {
  const toast = useToast();
  const [sessoes, setSessoes] = useState([]);
  useEffect(() => {
    const p = new URLSearchParams();
    for (const k of ['location_id', 'data_inicio', 'data_fim']) if (query.get(k)) p.set(k, query.get(k));
    api.get(`/reports/cash-sessions?${p}`).then(setSessoes).catch((err) => toast.erro(err));
  }, [query, toast]);

  return (
    <div className="card">
      <h3>Fechamentos de caixa</h3>
      <div className="tabela-wrap">
        <table>
          <thead>
            <tr>
              <th>Caixa</th><th>Abertura → fechamento</th><th className="num">Vendas</th>
              <th className="num">Dinheiro</th><th className="num">Pix</th><th className="num">Cartões</th>
              <th className="num">Sangria / Supr.</th><th className="num">Esperado</th><th className="num">Contado</th><th className="num">Diferença</th>
            </tr>
          </thead>
          <tbody>
            {sessoes.map((s) => {
              const dif = s.diferenca === null ? null : Number(s.diferenca);
              return (
                <tr key={s.id}>
                  <td>{s.terminal_nome}<div className="celula-sub">{s.location_nome} · {s.aberto_por}</div></td>
                  <td>{dataHora(s.aberto_em)}<div className="celula-sub">{s.fechado_em ? dataHora(s.fechado_em) : 'aberto'}</div></td>
                  <td className="num">{s.vendas}<div className="celula-sub">{brl(s.total_vendido)}</div></td>
                  <td className="num">{brl(s.dinheiro)}</td>
                  <td className="num">{brl(s.pix)}</td>
                  <td className="num">{brl(Number(s.cartao_credito) + Number(s.cartao_debito))}</td>
                  <td className="num">−{brl(s.sangrias)}<div className="celula-sub">+{brl(s.suprimentos)}</div></td>
                  <td className="num">{s.fechado_em ? brl(s.valor_esperado_fechamento) : '—'}</td>
                  <td className="num">{s.fechado_em ? brl(s.valor_informado_fechamento) : '—'}</td>
                  <td className={`num ${dif ? 'texto-alerta' : ''}`}>{dif === null ? '—' : `${dif > 0 ? '+' : ''}${brl(dif)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sessoes.length === 0 && <Vazio>Nenhum caixa aberto no período.</Vazio>}
      <p className="form-hint">Esperado = valor inicial + vendas em dinheiro + suprimentos − sangrias.</p>
    </div>
  );
}

function DetalheVenda({ id, onClose, onImprimir, onCancelada }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const { user } = useAuth();
  const [venda, setVenda] = useState(null);
  const [motivo, setMotivo] = useState('');

  useEffect(() => {
    api.get(`/sales/${id}`).then(setVenda).catch((err) => toast.erro(err));
  }, [id, toast]);

  async function cancelar(e) {
    e.preventDefault();
    if (!(await confirmar({
      titulo: `Cancelar a venda nº ${venda.numero}?`,
      mensagem: `O estoque volta para ${venda.location_nome} e ${brl(venda.total)} sai do caixa aberto. Não dá para desfazer.`,
      confirmar: 'Cancelar venda', perigo: true,
    }))) return;
    try {
      await api.post(`/sales/${venda.id}/cancel`, { motivo });
      toast.sucesso(`Venda nº ${venda.numero} cancelada e estoque devolvido.`);
      onCancelada();
    } catch (err) { toast.erro(err); }
  }

  if (!venda) return null;
  return (
    <Modal titulo={`Venda nº ${venda.numero}`} subtitulo={`${dataHora(venda.criado_em)} · ${venda.location_nome} · ${venda.terminal_nome} · ${venda.operador_nome}`} onClose={onClose} largura="larga">
      <div className="tabela-wrap">
        <table>
          <thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Preço</th><th className="num">Subtotal</th></tr></thead>
          <tbody>
            {venda.itens.map((i) => (
              <tr key={i.id}>
                <td>{i.product_nome}<div className="celula-sub">{i.codigo_interno}{i.custo_unitario !== null ? ` · custo ${brl(i.custo_unitario)}` : ''}</div></td>
                <td className="num">{qtd(i.quantidade, i.unidade)} {i.unidade}</td>
                <td className="num">{brl(i.preco_unitario)}</td>
                <td className="num">{brl(i.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagamento-resumo">
        <div><span>Subtotal</span><span>{brl(venda.subtotal)}</span></div>
        {Number(venda.desconto) > 0 && <div><span>Desconto</span><span>− {brl(venda.desconto)}</span></div>}
        <div className="pagamento-total"><span>Total · {FORMA_PAGAMENTO[venda.forma_pagamento]}</span><strong>{brl(venda.total)}</strong></div>
        {venda.troco !== null && <div><span>Recebido / troco</span><span>{brl(venda.valor_recebido)} / {brl(venda.troco)}</span></div>}
      </div>

      {venda.status === 'cancelada' && (
        <p className="error">Cancelada em {dataHora(venda.cancelado_em)} por {venda.cancelado_por_nome}: {venda.motivo_cancelamento}</p>
      )}

      {venda.pode_cancelar && (
        <form onSubmit={cancelar} className="detail-section">
          <span className="detail-section-title">Cancelar venda</span>
          <Field label="Motivo do cancelamento *"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex: cliente desistiu" required minLength={3} /></Field>
          <button type="submit" className="btn-link perigo">Cancelar esta venda</button>
        </form>
      )}
      {venda.status === 'concluida' && !venda.caixa_aberto && <span className="form-hint">O caixa desta venda já foi fechado; ela não pode mais ser cancelada.</span>}
      {venda.status === 'concluida' && venda.caixa_aberto && !venda.pode_cancelar && user && <span className="form-hint">Somente Administrador ou Gerente podem cancelar vendas.</span>}

      <div className="modal-actions">
        <button type="button" onClick={onClose}>Fechar</button>
        <button type="button" onClick={() => onImprimir(venda)}>Imprimir cupom</button>
      </div>
    </Modal>
  );
}
