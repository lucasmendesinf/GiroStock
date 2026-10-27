import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import { temModulo } from '../utils/permissions.js';
import { baixarCsv, numeroCsv } from '../utils/csv.js';
import { brl, dataHora, parseNumero } from '../utils/format';

// Comissoes do garcom (gestao): resumo por garcom, extrato por comanda, ajustes, acertos (com recibo e lancamento no Financeiro) e regras.
// A comissao nasce quando o dinheiro entra (recebimento no app ou fechamento no caixa); calculo em centavos, por item.
const PERIODOS = [['noite', 'Noite (dia comercial)'], ['semana', 'Semana'], ['mes', 'Mês'], ['personalizado', 'Personalizado']];
const FORMAS_ACERTO = [['pix', 'Pix'], ['dinheiro', 'Dinheiro'], ['transferencia', 'Transferência'], ['outro', 'Outro']];
const NOME_STATUS = { pendente: 'a pagar', paga: 'paga', estornada: 'estornada' };
const dia = (d) => (d ? d.split('-').reverse().join('/') : '');
const arred = (v) => Math.round(Number(v) * 100) / 100;

export default function Comissoes() {
  const [aba, setAba] = useState('comissoes');
  return (
    <div className="page">
      <div className="page-header"><h2>Comissões</h2></div>
      <div className="ped-bar" role="tablist">
        {[['comissoes', 'Comissões'], ['acertos', 'Acertos'], ['regras', 'Regras e perfil']].map(([k, n]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={`btn-link ${aba === k ? 'ativo' : ''}`} onClick={() => setAba(k)}>{n}</button>
        ))}
      </div>
      {aba === 'comissoes' && <Resumo />}
      {aba === 'acertos' && <Acertos />}
      {aba === 'regras' && <Regras />}
    </div>
  );
}

// ---------------------------------------------------------------- resumo por garcom
function Resumo() {
  const toast = useToast();
  const [periodo, setPeriodo] = useState('noite');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [loja, setLoja] = useState('');
  const [lojas, setLojas] = useState([]);
  const [dados, setDados] = useState(null);
  const [gaveta, setGaveta] = useState(null); // garcom aberto
  const [acertando, setAcertando] = useState(false);
  const [recibo, setRecibo] = useState(null);

  useEffect(() => { api.get('/locations').then((l) => setLojas(l.filter((x) => x.ativo))).catch(() => {}); }, []);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ periodo });
    if (periodo === 'personalizado' && de && ate) { p.set('de', de); p.set('ate', ate); }
    if (loja) p.set('location_id', loja);
    return p.toString();
  }, [periodo, de, ate, loja]);
  const carregar = useCallback(async () => {
    if (periodo === 'personalizado' && !(de && ate)) return;
    try { setDados(await api.get(`/comissoes/resumo?${qs}`)); } catch (err) { toast.erro(err); }
  }, [qs, periodo, de, ate, toast]);
  useEffect(() => { carregar(); }, [carregar]);

  const t = dados ? dados.totais : { a_pagar: 0, comissao_periodo: 0, vendas_base: 0, estornos: 0 };
  function exportar() {
    if (!dados) return;
    baixarCsv(`comissoes-${dados.janela.de}-${dados.janela.ate}.csv`,
      ['Garçom', 'Comandas', 'Vendas-base', 'Comissão', 'Taxa de serviço', 'Bônus', 'Ajustes', 'Total', 'A pagar', 'Pago', 'Estornos'],
      dados.garcons.map((g) => [g.garcom_nome, g.comandas, numeroCsv(g.vendas_base), numeroCsv(g.comissao_produtos), numeroCsv(g.taxa_servico), numeroCsv(g.bonus), numeroCsv(g.ajustes), numeroCsv(g.total), numeroCsv(g.a_pagar), numeroCsv(g.pago), numeroCsv(g.estornos)]));
  }

  return (
    <div>
      <div className="ped-bar">
        <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} aria-label="Período" style={{ width: 'auto' }}>{PERIODOS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        {periodo === 'personalizado' && <><input type="date" value={de} onChange={(e) => setDe(e.target.value)} aria-label="De" style={{ width: 'auto' }} /><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} aria-label="Até" style={{ width: 'auto' }} /></>}
        {lojas.length > 1 && <select value={loja} onChange={(e) => setLoja(e.target.value)} aria-label="Loja" style={{ width: 'auto' }}><option value="">Todas as lojas</option>{lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}</select>}
        {dados && <span className="cl-sub">{dia(dados.janela.de)}{dados.janela.de !== dados.janela.ate ? ` a ${dia(dados.janela.ate)}` : ''} · a noite vira às {String(dados.corte_hora).padStart(2, '0')}h</span>}
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn-link" onClick={exportar} disabled={!dados || dados.garcons.length === 0}>Exportar</button>
        <button type="button" className="btn-primario" onClick={() => setAcertando(true)}>Fechar acerto…</button>
      </div>
      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ped-kpi" style={t.a_pagar > 0 ? { borderColor: 'var(--warn)' } : undefined}><small>Comissão a pagar</small><b style={{ color: 'var(--warn)' }}>{brl(t.a_pagar)}</b></div>
        <div className="ped-kpi"><small>Comissão do período</small><b>{brl(t.comissao_periodo)}</b></div>
        <div className="ped-kpi"><small>Vendas-base</small><b>{brl(t.vendas_base)}</b></div>
        <div className="ped-kpi"><small>Estornos</small><b>{brl(t.estornos)}</b></div>
      </div>
      <div className="card">
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Garçom</th><th>Comandas</th><th>Vendas-base</th><th>Comissão</th><th>Taxa de serviço</th><th>Bônus</th><th>Total</th><th>Situação</th></tr></thead>
            <tbody>
              {(dados ? dados.garcons : []).map((g) => (
                <tr key={g.garcom_id} onClick={() => setGaveta(g)} style={{ cursor: 'pointer' }}>
                  <td><b>{g.garcom_nome}</b></td><td>{g.comandas}</td><td>{brl(g.vendas_base)}</td><td>{brl(g.comissao_produtos)}</td><td>{brl(g.taxa_servico)}</td>
                  <td>{brl(g.bonus)}{g.bonus_previsto > 0 && <span className="cl-sub"> +{brl(g.bonus_previsto)} previsto</span>}</td>
                  <td><b>{brl(g.total)}</b></td>
                  <td>{g.a_pagar > 0 ? <span className="ped-pill warn">a pagar {brl(g.a_pagar)}</span> : g.pago > 0 ? <span className="ped-pill ok">pago</span> : <span className="cl-sub">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dados && dados.garcons.length === 0 && <div className="ped-vazio">Nenhuma comissão neste período. A comissão nasce quando o dinheiro entra (recebimento no app ou fechamento da comanda).</div>}
      </div>
      <p className="form-hint">Comandas abertas, canceladas e recebimentos estornados não geram comissão. Estorno de comissão já paga vira um lançamento negativo no próximo acerto.</p>
      {gaveta && <ExtratoDoGarcom garcom={gaveta} qs={qs} onClose={() => setGaveta(null)} onMudou={carregar} />}
      {acertando && <FecharAcerto dados={dados} periodo={periodo} de={de} ate={ate} onClose={() => setAcertando(false)} onFeito={(a) => { setAcertando(false); carregar(); setRecibo(a.acerto.id); }} />}
      {recibo && <Recibo id={recibo} onClose={() => setRecibo(null)} />}
    </div>
  );
}

function ExtratoDoGarcom({ garcom, qs, onClose, onMudou }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [ajuste, setAjuste] = useState(false);
  const [transferir, setTransferir] = useState(null);
  const carregar = useCallback(async () => { try { setD(await api.get(`/comissoes/garcons/${garcom.garcom_id}?${qs}`)); } catch (err) { toast.erro(err); } }, [garcom.garcom_id, qs, toast]);
  useEffect(() => { carregar(); }, [carregar]);
  return (
    <div className="ped-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="ped-drawer" role="dialog" aria-label={`Extrato de ${garcom.garcom_nome}`}>
        <button type="button" className="modal-close" style={{ float: 'right' }} aria-label="Fechar" onClick={onClose}>×</button>
        <h3>{garcom.garcom_nome}</h3>
        <div className="cl-sub">Total do período {brl(garcom.total)} · a pagar {brl(garcom.a_pagar)} · pago {brl(garcom.pago)}</div>
        <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 10 }}>
          <button type="button" onClick={() => setAjuste(true)}>Ajuste manual…</button>
        </div>
        {!d && <p className="cl-sub">Carregando…</p>}
        {d && d.comandas.length === 0 && d.avulsos.length === 0 && <div className="ped-vazio">Sem lançamentos no período</div>}
        {d && d.comandas.map((c) => (
          <div key={c.comanda_id} className="card" style={{ padding: 12, marginTop: 10 }}>
            <div className="ped-linha"><b>{c.tipo === 'pista' ? '🎫' : '🍽'} {c.identificador} <span className="cl-sub">#{c.numero} · {dataHora(c.hora)}</span></b><b>{brl(c.total)}</b></div>
            {c.itens.map((i) => (
              <div key={i.id} className="ped-linha" style={{ opacity: i.estornado && i.origem !== 'ajuste' ? 0.55 : 1 }}>
                <span className="cl-sub">{i.origem === 'ajuste' ? `Ajuste: ${i.motivo || ''}` : `${i.quantidade ? `${i.quantidade}× ` : ''}${i.produto}`}{i.pct !== null && i.origem !== 'ajuste' ? ` · ${i.pct}% de ${brl(i.base)}` : ''}{i.taxa_servico > 0 ? ` + serviço ${brl(i.taxa_servico)}` : ''}</span>
                <span>{brl(i.total)} <span className={`ped-pill ${i.status === 'paga' ? 'ok' : i.status === 'estornada' ? 'err' : 'warn'}`}>{i.estornado && i.status === 'paga' ? 'paga · estornada' : NOME_STATUS[i.status]}</span></span>
              </div>
            ))}
            <button type="button" className="btn-link" onClick={() => setTransferir(c)}>Transferir comanda…</button>
          </div>
        ))}
        {d && d.avulsos.length > 0 && (
          <div className="card" style={{ padding: 12, marginTop: 10 }}>
            <div className="cl-sub"><b>Ajustes e bônus</b></div>
            {d.avulsos.map((i) => <div key={i.id} className="ped-linha"><span className="cl-sub">{i.origem === 'bonus' ? `Bônus por meta (${i.periodo_ref})` : `Ajuste: ${i.motivo || ''}`}</span><span>{brl(i.total)} <span className={`ped-pill ${i.status === 'paga' ? 'ok' : 'warn'}`}>{NOME_STATUS[i.status]}</span></span></div>)}
          </div>
        )}
        {d && d.prestacoes_diferenca.length > 0 && (
          <div className="cl-sub" style={{ marginTop: 10 }}>
            <b>Diferenças de prestação de contas (só informativo):</b>
            {d.prestacoes_diferenca.map((p) => <div key={p.id}>{p.identificador} #{p.comanda_numero}: {brl(p.diferenca_prestacao)} de {brl(p.valor)}</div>)}
          </div>
        )}
      </aside>
      {ajuste && <AjusteManual garcom={garcom} onClose={() => setAjuste(false)} onFeito={() => { setAjuste(false); carregar(); onMudou(); }} />}
      {transferir && <TransferirComanda comanda={transferir} onClose={() => setTransferir(null)} onFeito={() => { setTransferir(null); toast.sucesso('Comanda transferida (os itens já lançados continuam do garçom original).'); }} />}
    </div>
  );
}

function AjusteManual({ garcom, onClose, onFeito }) {
  const toast = useToast();
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try { await api.post('/comissoes/ajustes', { garcom_id: garcom.garcom_id, valor: parseNumero(valor), motivo: motivo.trim() }); toast.sucesso('Ajuste lançado: entra no próximo acerto.'); onFeito(); } catch (err) { toast.erro(err); setSalvando(false); }
  }
  return (
    <Modal titulo={`Ajuste manual · ${garcom.garcom_nome}`} subtitulo="Valor positivo soma e negativo desconta. Entra no próximo acerto (nunca altera um acerto já pago)." onClose={onClose}>
      <form onSubmit={salvar} className="form-stack">
        <Field label="Valor (R$)" hint="Ex.: -10,00 para descontar; 10,00 para somar (dividir a comissão de uma mesa entre dois garçons)"><input autoFocus inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} required /></Field>
        <Field label="Motivo"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} minLength={3} maxLength={200} required /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={salvando}>Lançar ajuste</button></div>
      </form>
    </Modal>
  );
}

function TransferirComanda({ comanda, onClose, onFeito }) {
  const toast = useToast();
  const [colegas, setColegas] = useState(null);
  useEffect(() => { api.get('/garcom/colegas').then(setColegas).catch((e) => { toast.erro(e); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function transferir(g) {
    try { await api.post(`/garcom/comandas/${comanda.comanda_id}/transferir`, { para_user_id: g.id }); onFeito(); } catch (err) { toast.erro(err); }
  }
  return (
    <Modal titulo={`Transferir ${comanda.identificador}`} subtitulo="A comissão dos itens já lançados continua de quem lançou; o novo garçom ganha só o que lançar daqui para frente." onClose={onClose}>
      <div className="form-stack">
        {!colegas && <p className="cl-sub">Carregando…</p>}
        {colegas && colegas.length === 0 && <p className="cl-sub">Nenhum outro garçom.</p>}
        {(colegas || []).map((g) => <button key={g.id} type="button" onClick={() => transferir(g)}>{g.nome}</button>)}
      </div>
    </Modal>
  );
}

function FecharAcerto({ dados, periodo, de, ate, onClose, onFeito }) {
  const toast = useToast();
  const { user } = useAuth();
  const financeiro = temModulo(user, 'financeiro');
  const candidatos = (dados ? dados.garcons : []).filter((g) => g.a_pagar + g.bonus_previsto > 0 || g.a_pagar !== 0);
  const [sel, setSel] = useState(() => new Set(candidatos.filter((g) => g.a_pagar + g.bonus_previsto > 0).map((g) => g.garcom_id)));
  const [forma, setForma] = useState('pix');
  const [contas, setContas] = useState([]);
  const [contaId, setContaId] = useState('');
  const [lancar, setLancar] = useState(financeiro);
  const [obs, setObs] = useState('');
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { if (financeiro) api.get('/financeiro/contas').then((c) => setContas(c.filter((x) => x.ativo))).catch(() => {}); }, [financeiro]);
  const total = arred(candidatos.filter((g) => sel.has(g.garcom_id)).reduce((s, g) => s + g.a_pagar + g.bonus_previsto, 0));
  async function fechar(e) {
    e.preventDefault();
    setSalvando(true);
    try {
      const r = await api.post('/comissoes/acertos', { garcom_ids: [...sel], periodo, ...(periodo === 'personalizado' ? { de, ate } : {}), forma_pagamento: forma, lancar_financeiro: lancar, conta_id: contaId || undefined, observacao: obs });
      toast.sucesso(`Acerto nº ${r.acerto.numero} fechado: ${brl(r.acerto.total)}.`);
      onFeito(r);
    } catch (err) { toast.erro(err); setSalvando(false); }
  }
  return (
    <Modal titulo="Fechar acerto" subtitulo={dados ? `${dia(dados.janela.de)} a ${dia(dados.janela.ate)} · bônus por meta devido entra automaticamente` : ''} onClose={onClose}>
      <form onSubmit={fechar} className="form-stack">
        {candidatos.length === 0 && <p className="cl-sub">Nenhum garçom com comissão a pagar neste período.</p>}
        {candidatos.map((g) => (
          <label key={g.garcom_id} className="check-linha">
            <input type="checkbox" checked={sel.has(g.garcom_id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(g.garcom_id); else n.delete(g.garcom_id); setSel(n); }} />
            <span><b>{g.garcom_nome}</b> · {brl(arred(g.a_pagar + g.bonus_previsto))}{g.bonus_previsto > 0 ? ` (inclui bônus ${brl(g.bonus_previsto)})` : ''}{g.a_pagar + g.bonus_previsto <= 0 ? ' · saldo negativo: segue para o próximo acerto' : ''}</span>
          </label>
        ))}
        <div className="ped-linha" style={{ fontSize: 18 }}><b>Total do acerto</b><b>{brl(total)}</b></div>
        <Field label="Forma de pagamento"><select value={forma} onChange={(e) => setForma(e.target.value)}>{FORMAS_ACERTO.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Field>
        {financeiro && (
          <>
            <label className="check-linha"><input type="checkbox" checked={lancar} onChange={(e) => setLancar(e.target.checked)} /> Lançar no Financeiro (conta a pagar “Comissões”, já baixada)</label>
            {lancar && <Field label="Conta de onde sai o dinheiro" hint="Opcional"><select value={contaId} onChange={(e) => setContaId(e.target.value)}><option value="">Sem conta</option>{contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>}
          </>
        )}
        <Field label="Observação"><input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={300} /></Field>
        <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="submit" disabled={salvando || sel.size === 0 || total <= 0}>{salvando ? 'Fechando…' : 'Fechar acerto e gerar recibo'}</button></div>
      </form>
    </Modal>
  );
}

// Recibo para imprimir (ou salvar em PDF pelo navegador): um bloco por garcom, com linha de assinatura.
function Recibo({ id, onClose }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  useEffect(() => { api.get(`/comissoes/acertos/${id}`).then(setR).catch((e) => { toast.erro(e); onClose(); }); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal titulo={r ? `Recibo do acerto nº ${r.numero}` : 'Recibo'} subtitulo={r ? `${r.empresa_nome} · ${dia(r.periodo_inicio)} a ${dia(r.periodo_fim)}` : ''} onClose={onClose} largura="larga">
      {!r ? <p className="cl-sub">Carregando…</p> : (
        <div className="form-stack">
          <div className="recibo-impressao">
            {r.garcons.map((g) => (
              <div key={g.garcom_id} className="card recibo-bloco" style={{ padding: 14 }}>
                <h4 style={{ margin: '0 0 6px' }}>{r.empresa_nome} — Recibo de comissões</h4>
                <div className="cl-sub">Garçom: <b>{g.garcom_nome}</b> · Período {dia(r.periodo_inicio)} a {dia(r.periodo_fim)} · Pago em {dia(r.pago_em)}{r.forma_pagamento ? ` (${r.forma_pagamento})` : ''}</div>
                {g.linhas.map((l, i) => <div key={i} className="ped-linha"><span>{l.comanda_numero ? `${l.identificador} #${l.comanda_numero}` : l.origem === 'bonus' ? 'Bônus por meta' : `Ajuste: ${l.motivo || ''}`}</span><span>{brl(l.valor)}</span></div>)}
                <div className="ped-linha" style={{ fontSize: 18 }}><b>Total recebido</b><b>{brl(g.valor)}</b></div>
                <div style={{ marginTop: 28, borderTop: '1px solid currentColor', width: 260, paddingTop: 4 }} className="cl-sub">Assinatura de {g.garcom_nome}</div>
              </div>
            ))}
          </div>
          <div className="modal-actions"><button type="button" onClick={onClose}>Fechar</button><button type="button" onClick={() => window.print()}>Imprimir / salvar PDF</button></div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- acertos (historico)
function Acertos() {
  const toast = useToast();
  const [lista, setLista] = useState(null);
  const [recibo, setRecibo] = useState(null);
  useEffect(() => { api.get('/comissoes/acertos').then(setLista).catch((e) => toast.erro(e)); }, [toast]);
  return (
    <div className="card">
      <div className="tabela-wrap">
        <table className="tabela-cartoes">
          <thead><tr><th>Acerto</th><th>Período</th><th>Garçons</th><th>Forma</th><th>Total</th><th /></tr></thead>
          <tbody>
            {(lista || []).map((a) => (
              <tr key={a.id}>
                <td><b>nº {a.numero}</b><div className="cl-sub">pago em {dia(a.pago_em)}{a.titulo_id ? ' · lançado no Financeiro' : ''}</div></td>
                <td>{dia(a.periodo_inicio)} a {dia(a.periodo_fim)}</td>
                <td>{a.garcons.map((g) => `${g.garcom_nome} (${brl(g.valor)})`).join(', ')}</td>
                <td>{a.forma_pagamento || '—'}</td><td><b>{brl(a.total)}</b></td>
                <td style={{ textAlign: 'right' }}><button type="button" className="btn-link" onClick={() => setRecibo(a.id)}>Recibo</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lista && lista.length === 0 && <div className="ped-vazio">Nenhum acerto ainda</div>}
      {recibo && <Recibo id={recibo} onClose={() => setRecibo(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- regras e perfil
function Regras() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [sim, setSim] = useState(null);
  const carregar = useCallback(async () => {
    try {
      const r = await api.get('/comissoes/regras');
      setD(r);
      const v = (x) => (x === null || x === undefined ? '' : String(x).replace('.', ','));
      setF({
        pct_padrao: v(r.pct_padrao), taxa: v(r.taxa_servico_repasse_pct), base: r.base, meta_valor: v(r.meta_valor), meta_bonus_pct: v(r.meta_bonus_pct), meta_periodo: r.meta_periodo,
        estorno_desconta: r.estorno_desconta, corte_hora: String(r.corte_hora), cat: Object.fromEntries(Object.entries(r.por_categoria || {}).map(([k, p]) => [k, v(p)])),
      });
    } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { carregar(); }, [carregar]);
  if (!d || !f) return <p className="cl-sub">Carregando…</p>;

  const num = (x) => (String(x).trim() === '' ? null : parseNumero(x));
  const corpo = () => ({
    pct_padrao: num(f.pct_padrao), taxa_servico_repasse_pct: num(f.taxa), base: f.base, meta_valor: num(f.meta_valor), meta_bonus_pct: num(f.meta_bonus_pct), meta_periodo: f.meta_periodo,
    estorno_desconta: f.estorno_desconta, corte_hora: Number(f.corte_hora), por_categoria: Object.fromEntries(Object.entries(f.cat).filter(([, p]) => String(p).trim() !== '').map(([k, p]) => [k, parseNumero(p)])),
  });
  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    try { await api.put('/comissoes/regras', corpo()); toast.sucesso('Regras salvas. Valem para os próximos recebimentos e fechamentos (o que já foi lançado não muda).'); await carregar(); } catch (err) { toast.erro(err); }
    setSalvando(false);
  }
  async function simular() {
    try { setSim(await api.post('/comissoes/simulacao', { regras: { pct_padrao: num(f.pct_padrao), taxa_servico_repasse_pct: num(f.taxa), base: f.base, por_categoria: corpo().por_categoria } })); } catch (err) { toast.erro(err); }
  }
  void confirmar;
  const porCat = (id) => f.cat[id] !== undefined;
  return (
    <div className="grid-2">
      <form className="card form-stack" onSubmit={salvar}>
        <h4 style={{ margin: 0 }}>Regras de comissão</h4>
        <div className="form-grid">
          <Field label="Percentual padrão (%)"><input inputMode="decimal" value={f.pct_padrao} onChange={(e) => setF({ ...f, pct_padrao: e.target.value })} required /></Field>
          <Field label="Taxa de serviço repassada (%)" hint="Parte da taxa de serviço que vai ao garçom, proporcional aos itens dele"><input inputMode="decimal" value={f.taxa} onChange={(e) => setF({ ...f, taxa: e.target.value })} required /></Field>
        </div>
        <Field label="Base de cálculo"><select value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })}><option value="liquida">Líquida (depois do desconto)</option><option value="bruta">Bruta (preço dos itens)</option></select></Field>
        <Field label="Percentual por categoria" hint="Liga a categoria para usar um percentual próprio. O % definido para um garçom (Usuários) vale acima de tudo.">
          <div className="permissoes-lista">
            {d.categorias.map((c) => (
              <div key={c.id} className="permissao-item" style={{ alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={porCat(c.id)} onChange={(e) => { const cat = { ...f.cat }; if (e.target.checked) cat[c.id] = f.pct_padrao; else delete cat[c.id]; setF({ ...f, cat }); }} aria-label={`Percentual próprio para ${c.nome}`} />
                <span style={{ flex: 1 }}>{c.parent_nome ? `${c.parent_nome} › ` : ''}{c.nome}</span>
                {porCat(c.id) && <input style={{ width: 80 }} inputMode="decimal" value={f.cat[c.id]} onChange={(e) => setF({ ...f, cat: { ...f.cat, [c.id]: e.target.value } })} aria-label={`% de ${c.nome}`} />}
              </div>
            ))}
            {d.categorias.length === 0 && <span className="cl-sub">Nenhuma categoria cadastrada.</span>}
          </div>
        </Field>
        <div className="form-grid">
          <Field label="Meta (vendas-base, R$)" hint="Vazio = sem bônus"><input inputMode="decimal" value={f.meta_valor} onChange={(e) => setF({ ...f, meta_valor: e.target.value })} /></Field>
          <Field label="Bônus (%) sobre a base"><input inputMode="decimal" value={f.meta_bonus_pct} onChange={(e) => setF({ ...f, meta_bonus_pct: e.target.value })} /></Field>
          <Field label="Período da meta"><select value={f.meta_periodo} onChange={(e) => setF({ ...f, meta_periodo: e.target.value })}><option value="noite">Noite</option><option value="semana">Semana</option><option value="mes">Mês</option></select></Field>
        </div>
        <Field label="A noite vira às (hora)" hint="Vendas feitas de madrugada, antes desta hora, contam na noite anterior"><input type="number" min="0" max="23" value={f.corte_hora} onChange={(e) => setF({ ...f, corte_hora: e.target.value })} /></Field>
        <label className="check-linha"><input type="checkbox" checked={f.estorno_desconta} onChange={(e) => setF({ ...f, estorno_desconta: e.target.checked })} /> Estorno de comissão já paga desconta no próximo acerto</label>
        <div className="modal-actions"><button type="button" onClick={simular}>Simular com uma comanda recente</button><button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar regras'}</button></div>
        {sim && (
          <div className="card" style={{ padding: 12 }}>
            {!sim.comanda ? <p className="cl-sub">Ainda não há comanda paga para simular.</p> : (
              <>
                <div className="cl-sub"><b>{sim.comanda.identificador} #{sim.comanda.numero}</b> · desconto {brl(sim.desconto)} · taxa de serviço {brl(sim.taxa_servico)}</div>
                {sim.itens.map((i, k) => <div key={k} className="ped-linha"><span className="cl-sub">{i.produto}{i.elegivel ? ` · ${i.pct}% de ${brl(i.base)}` : ' · fora da comissão'}</span><span>{brl(i.total)}</span></div>)}
                <div className="ped-linha" style={{ fontSize: 16 }}><b>Comissão total</b><b>{brl(sim.total)}</b></div>
              </>
            )}
          </div>
        )}
      </form>
      <div className="card form-stack">
        <h4 style={{ margin: 0 }}>Perfil Garçom</h4>
        <div className="cl-sub"><b>Pode:</b> abrir comandas de mesa e pista, lançar rodadas, marcar entregue, pedir fechamento, transferir as próprias comandas, ver o próprio extrato e a própria comissão.</div>
        <div className="cl-sub"><b>Só com a permissão “Receber pagamentos no app”</b> (Usuários, por perfil ou por usuário, e a loja precisa liberar): receber em Pix, cartão e dinheiro, e encerrar comanda toda paga.</div>
        <div className="cl-sub"><b>Não pode:</b> caixa, sangria, descontos, cancelar vendas, relatórios, estoque, cadastros, usuários, comissões dos outros.</div>
        <div className="cl-sub">A comissão nasce quando o dinheiro entra. Cancelamentos e estornos não contam. Cálculo em centavos, por item (meio centavo para cima).</div>
        <h4 style={{ margin: '12px 0 0' }}>Percentual por garçom</h4>
        {d.garcons.filter((g) => g.perfil === 'Garçom').map((g) => <div key={g.id} className="ped-linha"><span>{g.nome}{!g.ativo ? ' (inativo)' : ''}</span><span>{g.comissao_pct === null ? <span className="cl-sub">regra da empresa</span> : <b>{Number(g.comissao_pct)}%</b>}</span></div>)}
        <p className="form-hint">Para definir o percentual de um garçom, edite o usuário em Usuários. Para tirar um produto da comissão (ingresso, couvert), marque “Fora da comissão” no cadastro do produto.</p>
      </div>
    </div>
  );
}
