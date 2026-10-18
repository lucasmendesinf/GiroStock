import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Field, Modal, Vazio } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';
import { diaBR, FORMAS_BAIXA, hojeISO, maisDias, quandoVence, Situacao } from './util.jsx';

const FILTROS = [['pendente', 'Pendentes'], ['vencido', 'Vencidos'], ['pago', 'Pagos'], ['cancelado', 'Cancelados'], ['', 'Todos']];

// Contas a pagar (tipo=pagar) ou a receber (tipo=receber). A receber mostra tambem as vendas no cartao/apps a cair.
export default function Titulos({ tipo, opcoes, onMudou }) {
  const toast = useToast();
  const pagar = tipo === 'pagar';
  const [situacao, setSituacao] = useState('pendente');
  const [busca, setBusca] = useState('');
  const [periodo, setPeriodo] = useState({ de: '', ate: '' });
  const [dados, setDados] = useState(null);
  const [novo, setNovo] = useState(false);
  const [aberto, setAberto] = useState(null); // id do lancamento na janela de detalhe
  const [baixando, setBaixando] = useState(null);

  const carregar = useCallback(async () => {
    const q = new URLSearchParams({ tipo, ...(situacao ? { situacao } : {}), ...(busca.trim() ? { q: busca.trim() } : {}), ...(periodo.de ? { de: periodo.de } : {}), ...(periodo.ate ? { ate: periodo.ate } : {}) });
    try { setDados(await api.get(`/financeiro/titulos?${q}`)); } catch (err) { toast.erro(err); }
  }, [tipo, situacao, busca, periodo, toast]);
  useEffect(() => { const t = setTimeout(carregar, busca ? 300 : 0); return () => clearTimeout(t); }, [carregar, busca]);
  const mudou = async () => { await carregar(); if (onMudou) onMudou(); };

  return (
    <div className="fin-titulos">
      <div className="ped-head">
        <h3 style={{ margin: 0 }}>{pagar ? 'Contas a pagar' : 'Contas a receber'}</h3>
        <button type="button" className="btn-primario" onClick={() => setNovo(true)}>+ {pagar ? 'Nova conta a pagar' : 'Nova conta a receber'}</button>
      </div>
      {dados && (
        <div className="ped-kpis" style={{ gridTemplateColumns: `repeat(${situacao === 'pago' || situacao === '' ? 3 : 2}, 1fr)` }}>
          <div className="ped-kpi"><small>{pagar ? 'A pagar (pendente)' : 'A receber (pendente)'}</small><b>{brl(dados.totais.pendente)}</b></div>
          <div className="ped-kpi" style={dados.totais.vencido > 0 ? { borderColor: 'var(--err)' } : undefined}><small>Vencido</small><b style={dados.totais.vencido > 0 ? { color: 'var(--err)' } : undefined}>{brl(dados.totais.vencido)}</b></div>
          {(situacao === 'pago' || situacao === '') && <div className="ped-kpi"><small>{pagar ? 'Pago (no filtro)' : 'Recebido (no filtro)'}</small><b>{brl(dados.totais.pago)}</b></div>}
        </div>
      )}
      <div className="es-chips" role="group" aria-label="Situação">
        {FILTROS.map(([id, nome]) => <button key={id || 'todos'} type="button" className={`es-chip ${situacao === id ? 'on' : ''}`} aria-pressed={situacao === id} onClick={() => setSituacao(id)}>{nome}</button>)}
      </div>
      <div className="ped-bar">
        <input className="ped-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={pagar ? 'Buscar descrição, fornecedor ou documento' : 'Buscar descrição, cliente ou documento'} aria-label="Buscar" />
        <input type="date" value={periodo.de} onChange={(e) => setPeriodo({ ...periodo, de: e.target.value })} aria-label="Vencimento de" title="Vencimento de" />
        <input type="date" value={periodo.ate} onChange={(e) => setPeriodo({ ...periodo, ate: e.target.value })} aria-label="Vencimento até" title="Vencimento até" />
        {(periodo.de || periodo.ate) && <button type="button" className="btn-link" onClick={() => setPeriodo({ de: '', ate: '' })}>Limpar datas</button>}
      </div>
      <div className="card">
        {!dados ? <p className="muted">Carregando…</p> : dados.titulos.length === 0 ? (
          <Vazio>{situacao === 'pendente' ? `Nenhuma conta ${pagar ? 'a pagar' : 'a receber'} pendente.` : 'Nada encontrado com estes filtros.'}</Vazio>
        ) : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes fin-tabela">
              <thead><tr><th>Descrição</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th /></tr></thead>
              <tbody>
                {dados.titulos.map((t) => (
                  <tr key={t.id} className={`fin-linha ${t.situacao}`}>
                    <td>
                      <button type="button" className="es-nome" onClick={() => setAberto(t.id)}>{t.descricao}</button>
                      <div className="celula-sub">{[t.categoria_nome, t.supplier_nome || t.customer_nome, t.documento ? `doc. ${t.documento}` : '', t.origem === 'nota' ? 'da nota fiscal' : ''].filter(Boolean).join(' · ') || 'Sem categoria'}</div>
                    </td>
                    <td>{diaBR(t.vencimento)}<div className={`celula-sub ${t.situacao === 'vencido' ? 'fin-atraso' : ''}`}>{quandoVence(t)}</div></td>
                    <td className="num"><b>{brl(t.situacao === 'pago' ? t.valor_pago : t.valor)}</b></td>
                    <td><Situacao t={t} /></td>
                    <td className="num">
                      {(t.situacao === 'aberto' || t.situacao === 'vencido') && <button type="button" className="btn-primario fin-btn-baixa" onClick={() => setBaixando(t)}>{pagar ? 'Pagar' : 'Receber'}</button>}
                      {(t.situacao === 'pago' || t.situacao === 'cancelado') && <button type="button" className="btn-link" onClick={() => setAberto(t.id)}>Detalhes</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!pagar && <VendasAReceber />}
      {novo && <NovoTitulo tipo={tipo} opcoes={opcoes} onClose={() => setNovo(false)} onCriado={async () => { setNovo(false); await mudou(); }} />}
      {baixando && <Baixa titulo={baixando} opcoes={opcoes} onClose={() => setBaixando(null)} onFeito={async () => { setBaixando(null); await mudou(); }} />}
      {aberto && <Detalhe id={aberto} opcoes={opcoes} onClose={() => setAberto(null)} onMudou={mudou} />}
    </div>
  );
}

// Vendas no cartao e nos apps que ainda vao cair (calculadas pelo prazo e taxa de cada forma).
function VendasAReceber() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/financeiro/vendas-a-receber?de=${maisDias(hojeISO(), 1)}`).then(setD).catch(() => setD({ linhas: [], totais: {} })); }, []);
  if (!d || d.linhas.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Vendas a cair (cartão e apps)</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>Vendas já feitas que a operadora ou a plataforma ainda vai depositar, pelo prazo e taxa de cada forma (ajuste em <b>Cadastros</b>).</p>
      <div className="tabela-wrap">
        <table className="tabela-cartoes">
          <thead><tr><th>Cai em</th><th>Forma</th><th className="num">Vendas</th><th className="num">Bruto</th><th className="num">Taxa</th><th className="num">Líquido</th></tr></thead>
          <tbody>
            {d.linhas.map((l) => (
              <tr key={`${l.data}-${l.forma}`}><td>{diaBR(l.data)}</td><td>{l.nome}</td><td className="num">{l.vendas}</td><td className="num">{brl(l.bruto)}</td><td className="num">{brl(l.taxa)}</td><td className="num"><b>{brl(l.liquido)}</b></td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3}><b>Total</b></td><td className="num">{brl(d.totais.bruto)}</td><td className="num">{brl(d.totais.taxa)}</td><td className="num"><b>{brl(d.totais.liquido)}</b></td></tr></tfoot>
        </table>
      </div>
    </div>
  );
}

// Nova conta: unica, parcelada (divide o valor) ou repetida todo mes (mesmo valor). Pode ja lancar como paga.
export function NovoTitulo({ tipo, opcoes, inicial = {}, onClose, onCriado }) {
  const toast = useToast();
  const pagar = tipo === 'pagar';
  const hoje = opcoes.hoje || hojeISO();
  const cats = opcoes.categorias.filter((c) => c.tipo === (pagar ? 'despesa' : 'receita'));
  const [f, setF] = useState({
    descricao: '', categoria_id: '', pessoa_id: '', location_id: '', valor: '', vencimento: hoje, competencia: '', documento: '', observacao: '',
    modo: 'unica', quantidade: '2', jaPago: false, conta_id: opcoes.contas[0] ? opcoes.contas[0].id : '', forma_pagamento: 'pix', ...inicial,
  });
  const [salvando, setSalvando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const valorNum = parseNumero(f.valor);
  const n = Number(f.quantidade);
  const previa = useMemo(() => {
    if (f.modo === 'unica' || !(valorNum > 0) || !(n >= 2)) return null;
    if (f.modo === 'parcelas') return `${n}× de ${brl(Math.floor((valorNum / n) * 100) / 100)} (total ${brl(valorNum)})`;
    return `${n} meses de ${brl(valorNum)} (total ${brl(valorNum * n)})`;
  }, [f.modo, valorNum, n]);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const corpo = {
        tipo, descricao: f.descricao, categoria_id: f.categoria_id || null, location_id: f.location_id || null,
        [pagar ? 'supplier_id' : 'customer_id']: f.pessoa_id || null,
        valor: f.valor, vencimento: f.vencimento, competencia: f.competencia ? `${f.competencia}-01` : null, documento: f.documento, observacao: f.observacao,
        ...(f.modo !== 'unica' ? { repetir: { modo: f.modo, quantidade: n } } : {}),
        ...(f.modo === 'unica' && f.jaPago ? { pago: { pago_em: hoje, conta_id: f.conta_id || null, forma_pagamento: f.forma_pagamento } } : {}),
      };
      const r = await api.post('/financeiro/titulos', corpo);
      toast.sucesso(r.length > 1 ? `${r.length} lançamentos criados` : 'Lançamento criado');
      await onCriado(r);
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  return (
    <Modal titulo={pagar ? 'Nova conta a pagar' : 'Nova conta a receber'} onClose={onClose} largura="larga">
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Descrição *"><input autoFocus value={f.descricao} onChange={mudar('descricao')} placeholder={pagar ? 'Ex.: Aluguel, conta de luz, boleto do fornecedor' : 'Ex.: Evento fechado, venda fiado'} maxLength={200} /></Field>
        <div className="form-grid">
          <Field label="Valor (R$) *"><input inputMode="decimal" value={f.valor} onChange={mudar('valor')} placeholder="0,00" /></Field>
          <Field label={f.modo === 'unica' ? 'Vencimento *' : '1º vencimento *'}><input type="date" value={f.vencimento} onChange={mudar('vencimento')} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Categoria">
            <select value={f.categoria_id} onChange={mudar('categoria_id')}>
              <option value="">Sem categoria</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.entra_no_resultado ? '' : ' (fora do resultado)'}</option>)}
            </select>
          </Field>
          <Field label={pagar ? 'Fornecedor' : 'Cliente'}>
            <select value={f.pessoa_id} onChange={mudar('pessoa_id')}>
              <option value="">—</option>
              {(pagar ? opcoes.fornecedores : opcoes.clientes).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Repetição">
          <div className="ped-seg2">
            {[['unica', 'Uma vez'], ['parcelas', 'Parcelado'], ['mensal', 'Todo mês']].map(([id, nome]) => (
              <button key={id} type="button" className={f.modo === id ? 'on' : ''} onClick={() => setF({ ...f, modo: id })}>{nome}</button>
            ))}
          </div>
        </Field>
        {f.modo !== 'unica' && (
          <Field label={f.modo === 'parcelas' ? 'Número de parcelas' : 'Quantos meses'} hint={previa || ''}>
            <input inputMode="numeric" value={f.quantidade} onChange={mudar('quantidade')} />
          </Field>
        )}
        <div className="form-grid">
          <Field label="Competência (mês do resultado)" hint="Vazio = o mês do vencimento">
            <input type="month" value={f.competencia} onChange={mudar('competencia')} />
          </Field>
          <Field label="Loja">
            <select value={f.location_id} onChange={mudar('location_id')}>
              <option value="">Empresa toda</option>
              {opcoes.lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Documento"><input value={f.documento} onChange={mudar('documento')} placeholder="Nº do boleto, nota..." maxLength={60} /></Field>
          <Field label="Observação"><input value={f.observacao} onChange={mudar('observacao')} maxLength={500} /></Field>
        </div>
        {f.modo === 'unica' && (
          <label className="check"><input type="checkbox" checked={f.jaPago} onChange={mudar('jaPago')} /> {pagar ? 'Já está paga (hoje)' : 'Já foi recebida (hoje)'}</label>
        )}
        {f.modo === 'unica' && f.jaPago && (
          <div className="form-grid">
            <Field label="Conta">
              <select value={f.conta_id} onChange={mudar('conta_id')}>
                <option value="">Sem conta</option>
                {opcoes.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Field>
            <Field label="Forma"><select value={f.forma_pagamento} onChange={mudar('forma_pagamento')}>{FORMAS_BAIXA.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn-primario" disabled={salvando || f.descricao.trim().length < 2 || !(valorNum > 0) || !f.vencimento}>{salvando ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Pagar / receber: data, valor (com juros ou desconto), conta e forma.
function Baixa({ titulo, opcoes, onClose, onFeito }) {
  const toast = useToast();
  const pagar = titulo.tipo === 'pagar';
  const [f, setF] = useState({ pago_em: opcoes.hoje || hojeISO(), valor_pago: String(Number(titulo.valor).toFixed(2)).replace('.', ','), conta_id: opcoes.contas[0] ? opcoes.contas[0].id : '', forma_pagamento: 'pix' });
  const [salvando, setSalvando] = useState(false);
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const v = parseNumero(f.valor_pago);
  const dif = v - Number(titulo.valor);
  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post(`/financeiro/titulos/${titulo.id}/baixar`, { ...f, conta_id: f.conta_id || null });
      toast.sucesso(pagar ? 'Conta paga' : 'Conta recebida');
      await onFeito();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo={pagar ? 'Pagar conta' : 'Receber conta'} subtitulo={`${titulo.descricao} · vence ${diaBR(titulo.vencimento)} · ${brl(titulo.valor)}`} onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <div className="form-grid">
          <Field label={pagar ? 'Pago em' : 'Recebido em'}><input type="date" value={f.pago_em} onChange={mudar('pago_em')} /></Field>
          <Field label="Valor (R$)" hint={Number.isFinite(dif) && Math.abs(dif) >= 0.01 ? (dif > 0 ? `${brl(dif)} a mais (juros/multa)` : `${brl(-dif)} a menos (desconto)`) : ''}>
            <input inputMode="decimal" value={f.valor_pago} onChange={mudar('valor_pago')} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label={pagar ? 'Saiu da conta' : 'Entrou na conta'}>
            <select value={f.conta_id} onChange={mudar('conta_id')}>
              <option value="">Sem conta</option>
              {opcoes.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Field>
          <Field label="Forma"><select value={f.forma_pagamento} onChange={mudar('forma_pagamento')}>{FORMAS_BAIXA.map(([k, nome]) => <option key={k} value={k}>{nome}</option>)}</select></Field>
        </div>
        {opcoes.contas.length === 0 && <p className="form-hint">Cadastre suas contas (banco, cofre) em <b>Cadastros</b> para acompanhar o saldo de cada uma.</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="btn-primario" disabled={salvando || !(v > 0)}>{salvando ? 'Salvando…' : pagar ? 'Confirmar pagamento' : 'Confirmar recebimento'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Detalhe: dados, parcelas do grupo, e acoes (pagar, estornar, editar, cancelar).
function Detalhe({ id, opcoes, onClose, onMudou }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [t, setT] = useState(null);
  const [editando, setEditando] = useState(false);
  const [baixando, setBaixando] = useState(null);
  const [cancelando, setCancelando] = useState(false);
  const carregar = useCallback(() => api.get(`/financeiro/titulos/${id}`).then(setT).catch((err) => toast.erro(err)), [id, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!t) return null;
  const pagar = t.tipo === 'pagar';
  const pendente = t.situacao === 'aberto' || t.situacao === 'vencido';
  async function estornar() {
    if (!(await confirmar({ titulo: 'Estornar o pagamento?', mensagem: 'O lançamento volta a ficar em aberto e o valor sai do saldo da conta.', confirmar: 'Estornar', perigo: true }))) return;
    try { await api.post(`/financeiro/titulos/${t.id}/estornar`); toast.sucesso('Pagamento estornado'); await carregar(); await onMudou(); } catch (err) { toast.erro(err); }
  }
  const linha = (rot, val) => (val ? <div className="ped-linha"><span>{rot}</span><span>{val}</span></div> : null);
  return (
    <Modal titulo={t.descricao} subtitulo={pagar ? 'Conta a pagar' : 'Conta a receber'} onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="ped-sec">
          <div className="ped-linha"><span>Situação</span><Situacao t={t} /></div>
          {linha('Valor', brl(t.valor))}
          {linha('Vencimento', `${diaBR(t.vencimento)} (${quandoVence(t)})`)}
          {linha('Competência', t.competencia ? diaBR(t.competencia).slice(3) : '')}
          {linha('Categoria', t.categoria_nome)}
          {linha(pagar ? 'Fornecedor' : 'Cliente', t.supplier_nome || t.customer_nome)}
          {linha('Loja', t.location_nome)}
          {linha('Documento', t.documento)}
          {linha('Observação', t.observacao)}
          {t.situacao === 'pago' && linha(pagar ? 'Pago' : 'Recebido', `${diaBR(t.pago_em)} · ${brl(t.valor_pago)}${t.conta_nome ? ` · ${t.conta_nome}` : ''}${t.forma_pagamento ? ` · ${(FORMAS_BAIXA.find((x) => x[0] === t.forma_pagamento) || [0, t.forma_pagamento])[1]}` : ''}`)}
          {t.situacao === 'cancelado' && linha('Cancelado', t.motivo_cancelamento)}
        </div>
        {t.grupo && t.grupo.length > 1 && (
          <div className="ped-sec"><span className="ped-rotulo">Parcelas ({t.grupo.length})</span>
            {t.grupo.map((g) => (
              <div key={g.id} className="ped-linha" style={g.id === t.id ? { fontWeight: 700 } : undefined}>
                <span>{g.parcela}/{g.parcelas} · {diaBR(g.vencimento)}</span>
                <span>{brl(g.situacao === 'pago' ? g.valor_pago : g.valor)} <Situacao t={g} /></span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          {pendente && <button type="button" className="perigo" onClick={() => setCancelando(true)}>Cancelar lançamento</button>}
          {pendente && <button type="button" onClick={() => setEditando(true)}>Editar</button>}
          {t.situacao === 'pago' && <button type="button" onClick={estornar}>Estornar pagamento</button>}
          {pendente && <button type="button" className="btn-primario" onClick={() => setBaixando(t)}>{pagar ? 'Pagar' : 'Receber'}</button>}
        </div>
      </div>
      {editando && <Editar t={t} opcoes={opcoes} onClose={() => setEditando(false)} onFeito={async () => { setEditando(false); await carregar(); await onMudou(); }} />}
      {baixando && <Baixa titulo={baixando} opcoes={opcoes} onClose={() => setBaixando(null)} onFeito={async () => { setBaixando(null); await carregar(); await onMudou(); }} />}
      {cancelando && <Cancelar t={t} onClose={() => setCancelando(false)} onFeito={async () => { setCancelando(false); await onMudou(); onClose(); }} />}
    </Modal>
  );
}

function Editar({ t, opcoes, onClose, onFeito }) {
  const toast = useToast();
  const pagar = t.tipo === 'pagar';
  const cats = opcoes.categorias.filter((c) => c.tipo === (pagar ? 'despesa' : 'receita'));
  const [f, setF] = useState({ descricao: t.descricao, valor: String(Number(t.valor).toFixed(2)).replace('.', ','), vencimento: t.vencimento, competencia: (t.competencia || '').slice(0, 7), categoria_id: t.categoria_id || '', pessoa_id: (pagar ? t.supplier_id : t.customer_id) || '', documento: t.documento || '', observacao: t.observacao || '' });
  const mudar = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function salvar(e) {
    e.preventDefault();
    try {
      await api.put(`/financeiro/titulos/${t.id}`, { descricao: f.descricao, valor: f.valor, vencimento: f.vencimento, competencia: f.competencia ? `${f.competencia}-01` : t.vencimento, categoria_id: f.categoria_id || null, [pagar ? 'supplier_id' : 'customer_id']: f.pessoa_id || null, documento: f.documento, observacao: f.observacao });
      toast.sucesso('Lançamento atualizado');
      await onFeito();
    } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Editar lançamento" onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Descrição"><input value={f.descricao} onChange={mudar('descricao')} maxLength={200} /></Field>
        <div className="form-grid">
          <Field label="Valor (R$)"><input inputMode="decimal" value={f.valor} onChange={mudar('valor')} /></Field>
          <Field label="Vencimento"><input type="date" value={f.vencimento} onChange={mudar('vencimento')} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Categoria"><select value={f.categoria_id} onChange={mudar('categoria_id')}><option value="">Sem categoria</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
          <Field label="Competência"><input type="month" value={f.competencia} onChange={mudar('competencia')} /></Field>
        </div>
        <Field label={pagar ? 'Fornecedor' : 'Cliente'}>
          <select value={f.pessoa_id} onChange={mudar('pessoa_id')}><option value="">—</option>{(pagar ? opcoes.fornecedores : opcoes.clientes).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
        </Field>
        <div className="form-grid">
          <Field label="Documento"><input value={f.documento} onChange={mudar('documento')} maxLength={60} /></Field>
          <Field label="Observação"><input value={f.observacao} onChange={mudar('observacao')} maxLength={500} /></Field>
        </div>
        <div className="modal-actions"><button type="button" onClick={onClose}>Voltar</button><button type="submit" className="btn-primario">Salvar</button></div>
      </form>
    </Modal>
  );
}

function Cancelar({ t, onClose, onFeito }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [todas, setTodas] = useState(false);
  const temSeguintes = t.grupo && t.grupo.some((g) => g.parcela > t.parcela && (g.situacao === 'aberto' || g.situacao === 'vencido'));
  async function salvar(e) {
    e.preventDefault();
    try { const r = await api.post(`/financeiro/titulos/${t.id}/cancelar`, { motivo, todas_do_grupo: todas }); toast.sucesso(r.cancelados > 1 ? `${r.cancelados} lançamentos cancelados` : 'Lançamento cancelado'); await onFeito(); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo="Cancelar lançamento?" subtitulo="Ele não some: fica no histórico como cancelado." onClose={onClose}>
      <form className="form-stack" onSubmit={salvar}>
        <Field label="Motivo *"><input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: lançado em duplicidade" maxLength={200} /></Field>
        {temSeguintes && <label className="check"><input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} /> Cancelar também as parcelas/meses seguintes</label>}
        <div className="modal-actions"><button type="button" onClick={onClose}>Voltar</button><button type="submit" className="perigo" disabled={motivo.trim().length < 3}>Cancelar lançamento</button></div>
      </form>
    </Modal>
  );
}
