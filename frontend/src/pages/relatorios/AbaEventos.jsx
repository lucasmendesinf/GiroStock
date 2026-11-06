import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Vazio } from '../../components/ui.jsx';
import { brl } from '../../utils/format';
import { baixarCsv, numeroCsv } from '../../utils/csv';

// Casa de shows: os eventos do periodo lado a lado (faturamento, ticket, margem, quebra do estoque do evento) e a variacao
// para o evento anterior. Imprimir/PDF e CSV.
const quando = (v) => new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const varia = (v) => (v === null ? <span className="muted">—</span> : <span style={{ color: v > 0 ? 'var(--ok)' : v < 0 ? 'var(--err)' : 'var(--muted)', fontWeight: 700 }}>{v > 0 ? '▲' : v < 0 ? '▼' : '='} {Math.abs(v).toLocaleString('pt-BR')}%</span>);
const pctTxt = (v) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR')}%`);

export default function AbaEventos({ query }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    const q = new URLSearchParams();
    for (const k of ['location_id', 'data_inicio', 'data_fim']) if (query.get(k)) q.set(k, query.get(k));
    api.get(`/reports/eventos?${q}`).then(setD).catch((err) => toast.erro(err));
  }, [query, toast]);
  if (!d) return <p className="muted">Calculando…</p>;
  const t = d.totais;
  const periodo = `${query.get('data_inicio') ? query.get('data_inicio').split('-').reverse().join('/') : 'início'} a ${query.get('data_fim') ? query.get('data_fim').split('-').reverse().join('/') : 'hoje'}`;

  function exportar() {
    baixarCsv(`eventos_${query.get('data_inicio') || 'inicio'}_a_${query.get('data_fim') || 'hoje'}.csv`,
      ['Evento', 'Data', 'Setor', 'Vendas', 'Faturamento', 'Ticket médio', 'Custo', 'Lucro bruto', 'Margem %', 'Canceladas', 'Enviado ao setor (custo)', 'Quebra (R$)', 'Quebra %', 'Variação %'],
      d.linhas.map((l) => [l.nome, quando(l.inicio), l.setor, l.vendas, numeroCsv(l.total), numeroCsv(l.ticket), numeroCsv(l.custo), numeroCsv(l.lucro), numeroCsv(l.margem), l.canceladas, numeroCsv(l.enviado_custo), numeroCsv(l.quebra), l.quebra_pct === null ? '' : numeroCsv(l.quebra_pct), l.variacao_pct === null ? '' : numeroCsv(l.variacao_pct)]));
  }
  function imprimir() {
    const w = window.open('', '_blank', 'width=1100,height=900');
    if (!w) return toast.erro('Libere as janelas (pop-up) do navegador para imprimir');
    const esc = (x) => String(x === null || x === undefined ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const vtxt = (v) => (v === null ? '—' : `${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(v).toLocaleString('pt-BR')}%`);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Relatório por evento</title><style>
      body{font:12px system-ui,sans-serif;margin:24px;color:#111} h1{font-size:19px;margin:0 0 2px} .sub{color:#555;margin-bottom:10px}
      .caixa{display:flex;gap:24px;flex-wrap:wrap;margin:8px 0} .caixa div b{display:block;font-size:15px}
      table{width:100%;border-collapse:collapse;margin-top:10px} td,th{border-bottom:1px solid #ccc;padding:5px 4px;text-align:left} th{font-size:10px;text-transform:uppercase;color:#444}
      .n{text-align:right;white-space:nowrap} .tot td{font-weight:700;border-top:2px solid #333} @page{margin:12mm;size:landscape}</style></head><body>
      <h1>Relatório por evento</h1><div class="sub">${esc(periodo)} · ${t.eventos} evento(s)</div>
      <div class="caixa"><div>Faturamento<b>${brl(t.total)}</b></div><div>Média por evento<b>${brl(t.media_por_evento)}</b></div><div>Ticket médio<b>${brl(t.ticket)}</b></div><div>Margem bruta<b>${pctTxt(t.margem)}</b></div><div>Quebra e perdas<b>${brl(t.quebra)} (${pctTxt(t.quebra_pct)})</b></div></div>
      <table><tr><th>Evento</th><th>Data</th><th class="n">Vendas</th><th class="n">Faturamento</th><th class="n">Ticket</th><th class="n">Lucro bruto</th><th class="n">Margem</th><th class="n">Quebra</th><th class="n">Quebra %</th><th class="n">vs. anterior</th></tr>
      ${d.linhas.map((l) => `<tr><td><b>${esc(l.nome)}</b><br><small>${esc(l.setor)}</small></td><td>${esc(quando(l.inicio))}</td><td class="n">${l.vendas}</td><td class="n"><b>${brl(l.total)}</b></td><td class="n">${brl(l.ticket)}</td><td class="n">${brl(l.lucro)}</td><td class="n">${pctTxt(l.margem)}</td><td class="n">${brl(l.quebra)}</td><td class="n">${pctTxt(l.quebra_pct)}</td><td class="n">${vtxt(l.variacao_pct)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="2">Total</td><td class="n">${t.vendas}</td><td class="n">${brl(t.total)}</td><td class="n">${brl(t.ticket)}</td><td class="n">${brl(t.lucro)}</td><td class="n">${pctTxt(t.margem)}</td><td class="n">${brl(t.quebra)}</td><td class="n">${pctTxt(t.quebra_pct)}</td><td></td></tr></table>
      <script>window.print()</script></body></html>`);
    w.document.close();
  }

  const maior = Math.max(1, ...d.linhas.map((l) => l.total));
  return (
    <div className="form-stack">
      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <div className="ped-kpi hero"><small>Faturamento dos eventos</small><b>{brl(t.total)}</b><span className="cl-sub">{t.eventos} evento(s) · {t.vendas} venda(s)</span></div>
        <div className="ped-kpi"><small>Média por evento</small><b>{brl(t.media_por_evento)}</b><span className="cl-sub">ticket médio {brl(t.ticket)}</span></div>
        <div className="ped-kpi"><small>Margem bruta</small><b>{pctTxt(t.margem)}</b><span className="cl-sub">lucro {brl(t.lucro)}</span></div>
        <div className="ped-kpi"><small>Quebra e perdas</small><b style={t.quebra > 0 ? { color: 'var(--err)' } : undefined}>{brl(t.quebra)}</b><span className="cl-sub">{t.quebra_pct === null ? 'sem estoque enviado' : `${pctTxt(t.quebra_pct)} do enviado`}</span></div>
        <div className="ped-kpi"><small>Melhor evento</small><b style={{ fontSize: 15 }}>{d.melhor ? d.melhor.nome : '—'}</b><span className="cl-sub">{d.melhor ? brl(d.melhor.total) : ''}</span></div>
      </div>
      <div className="card">
        <div className="ped-head" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Eventos no período</h3>
          {d.linhas.length > 0 && <span className="lv-acoes"><button type="button" className="btn-link" onClick={imprimir}>Imprimir / PDF</button><button type="button" className="btn-link" onClick={exportar}>Exportar CSV</button></span>}
        </div>
        {d.linhas.length === 0 ? <Vazio>Nenhum evento aberto ou encerrado no período. Ajuste o período no topo (ex.: “Este mês”).</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Evento</th><th className="num">Vendas</th><th className="num">Faturamento</th><th className="num">Ticket</th><th className="num">Margem</th><th className="num">Quebra</th><th className="num">vs. anterior</th></tr></thead>
              <tbody>
                {d.linhas.map((l) => (
                  <tr key={l.id}>
                    <td><b>{l.nome}</b>{l.status === 'aberto' && <span className="ped-pill ok" style={{ marginLeft: 6 }}>em andamento</span>}<div className="celula-sub">{quando(l.inicio)} · {l.setor}</div>
                      <div className="rel-barra"><i style={{ width: `${(l.total / maior) * 100}%` }} /></div></td>
                    <td className="num">{l.vendas}{l.canceladas ? <div className="celula-sub">{l.canceladas} cancelada(s)</div> : null}</td>
                    <td className="num"><b>{brl(l.total)}</b></td>
                    <td className="num">{brl(l.ticket)}</td>
                    <td className="num">{pctTxt(l.margem)}<div className="celula-sub">{brl(l.lucro)}</div></td>
                    <td className="num">{l.enviado_custo > 0 ? <><b style={l.quebra > 0 ? { color: 'var(--err)' } : undefined}>{brl(l.quebra)}</b><div className="celula-sub">{pctTxt(l.quebra_pct)}{l.contagem_feita ? '' : ' · sem contagem'}</div></> : '—'}</td>
                    <td className="num">{varia(l.variacao_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="form-hint">Quebra = perdas lançadas no evento + falta na contagem − sobras, a preço de custo. Os detalhes de cada evento (produto a produto) ficam em Eventos → evento → Estoque do evento.</p>
      </div>
    </div>
  );
}
