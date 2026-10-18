import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { brl } from '../../utils/format';
import { Barras, diaBR, diaCurto, hojeISO, maisDias } from './util.jsx';

const PERIODOS = [
  ['prox30', 'Próximos 30 dias', (h) => [h, maisDias(h, 30)]],
  ['prox90', 'Próximos 90 dias', (h) => [h, maisDias(h, 90)]],
  ['mes', 'Este mês', (h) => [`${h.slice(0, 8)}01`, fimDoMes(h)]],
  ['ult30', 'Últimos 30 dias', (h) => [maisDias(h, -30), h]],
];
function fimDoMes(iso) {
  const [a, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

// Fluxo de caixa por dia: realizado (ate hoje) e previsto (vendas a cair + contas a receber - contas a pagar).
export default function Fluxo({ versao }) {
  const toast = useToast();
  const hoje = hojeISO();
  const [periodo, setPeriodo] = useState('prox30');
  const [custom, setCustom] = useState({ de: hoje, ate: maisDias(hoje, 30) });
  const [todosDias, setTodosDias] = useState(false);
  const [f, setF] = useState(null);
  const [de, ate] = periodo === 'custom' ? [custom.de, custom.ate] : PERIODOS.find((p) => p[0] === periodo)[2](hoje);
  useEffect(() => {
    if (!de || !ate || ate < de) return;
    setF(null);
    api.get(`/financeiro/fluxo?de=${de}&ate=${ate}`).then(setF).catch((err) => toast.erro(err));
  }, [de, ate, toast, versao]);
  const dias = f ? (todosDias ? f.dias : f.dias.filter((d) => d.entradas || d.saidas || d.data === f.hoje)) : [];
  return (
    <div className="form-stack">
      <div className="es-chips" role="group" aria-label="Período">
        {PERIODOS.map(([id, nome]) => <button key={id} type="button" className={`es-chip ${periodo === id ? 'on' : ''}`} aria-pressed={periodo === id} onClick={() => setPeriodo(id)}>{nome}</button>)}
        <button type="button" className={`es-chip ${periodo === 'custom' ? 'on' : ''}`} aria-pressed={periodo === 'custom'} onClick={() => setPeriodo('custom')}>Escolher datas</button>
      </div>
      {periodo === 'custom' && (
        <div className="ped-bar">
          <input type="date" value={custom.de} onChange={(e) => setCustom({ ...custom, de: e.target.value })} aria-label="De" />
          <input type="date" value={custom.ate} onChange={(e) => setCustom({ ...custom, ate: e.target.value })} aria-label="Até" />
        </div>
      )}
      {!f ? <p className="muted">Calculando…</p> : (
        <>
          <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="ped-kpi"><small>Entradas</small><b style={{ color: 'var(--ok)' }}>{brl(f.totais.vendas + f.totais.recebido + f.totais.a_receber)}</b><span className="cl-sub">vendas {brl(f.totais.vendas)} · contas {brl(f.totais.recebido + f.totais.a_receber)}</span></div>
            <div className="ped-kpi"><small>Saídas</small><b style={{ color: 'var(--err)' }}>{brl(f.totais.pago + f.totais.a_pagar)}</b><span className="cl-sub">pagas {brl(f.totais.pago)} · a pagar {brl(f.totais.a_pagar)}</span></div>
            <div className="ped-kpi hero"><small>Saldo no fim ({diaBR(ate)})</small><b>{brl(f.saldo_final)}</b><span className="cl-sub">hoje {brl(f.saldo_hoje)}</span></div>
            <div className="ped-kpi" style={f.menor_saldo && f.menor_saldo.saldo < 0 ? { borderColor: 'var(--err)' } : undefined}><small>Menor saldo</small><b style={f.menor_saldo && f.menor_saldo.saldo < 0 ? { color: 'var(--err)' } : undefined}>{f.menor_saldo ? brl(f.menor_saldo.saldo) : '—'}</b><span className="cl-sub">{f.menor_saldo ? `em ${diaBR(f.menor_saldo.data)}` : ''}</span></div>
          </div>
          {f.totais.taxas > 0 && <p className="form-hint" style={{ margin: 0 }}>As vendas entram pelo valor líquido: {brl(f.totais.taxas)} de taxas de cartão/apps já descontadas.</p>}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Saldo no fim de cada dia</h3>
            <Barras titulo="Saldo no fim de cada dia" dados={f.dias.map((d) => ({ chave: d.data, valor: d.saldo, data: d.data }))} rotulo={(d) => diaCurto(d.data)} destaque={(d) => d.data === f.hoje} />
          </div>
          <div className="card">
            <div className="ped-head" style={{ marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Dia a dia</h3>
              <label className="check"><input type="checkbox" checked={todosDias} onChange={(e) => setTodosDias(e.target.checked)} /> Mostrar dias sem movimento</label>
            </div>
            <div className="tabela-wrap">
              <table className="tabela-cartoes fin-fluxo">
                <thead><tr><th>Dia</th><th className="num">Vendas</th><th className="num">Contas a receber</th><th className="num">Contas a pagar</th><th className="num">Saldo</th></tr></thead>
                <tbody>
                  {dias.map((d) => (
                    <tr key={d.data} className={`${d.realizado ? '' : 'previsto'} ${d.data === f.hoje ? 'hoje' : ''}`}>
                      <td><b>{diaBR(d.data)}</b> {d.data === f.hoje ? <span className="ped-pill">hoje</span> : !d.realizado ? <span className="celula-sub"> previsto</span> : null}{d.atrasados ? <div className="celula-sub fin-atraso">inclui contas atrasadas</div> : null}</td>
                      <td className="num">{d.vendas ? brl(d.vendas) : '—'}</td>
                      <td className="num">{d.recebido + d.a_receber ? brl(d.recebido + d.a_receber) : '—'}</td>
                      <td className="num">{d.pago + d.a_pagar ? <span style={{ color: 'var(--err)' }}>−{brl(d.pago + d.a_pagar)}</span> : '—'}</td>
                      <td className="num"><b style={{ color: d.saldo < 0 ? 'var(--err)' : undefined }}>{brl(d.saldo)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="form-hint">Até hoje: o que aconteceu (vendas que já caíram e contas pagas/recebidas). Depois de hoje: o previsto (vendas no cartão/apps a cair e contas em aberto pelo vencimento). Contas atrasadas entram em hoje.</p>
          </div>
        </>
      )}
    </div>
  );
}
