import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { brl, pct } from '../../utils/format';
import { Barras, hojeISO, maisMeses, mesBR, MESES_LONGOS } from './util.jsx';

// Resultado do mes (regime de competencia): vendas - taxas - custo das mercadorias - despesas + outras receitas.
export default function Resultado({ opcoes, versao }) {
  const toast = useToast();
  const [mes, setMes] = useState(hojeISO().slice(0, 7));
  const [loja, setLoja] = useState('');
  const [r, setR] = useState(null);
  useEffect(() => {
    setR(null);
    api.get(`/financeiro/resultado?mes=${mes}${loja ? `&location_id=${loja}` : ''}`).then(setR).catch((err) => toast.erro(err));
  }, [mes, loja, toast, versao]);
  const nome = `${MESES_LONGOS[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
  const L = ({ rot, v, forte, neg, sub, cls }) => (
    <div className={`fin-dre-linha ${forte ? 'forte' : ''} ${sub ? 'sub' : ''} ${cls || ''}`}>
      <span>{rot}</span><b style={neg && v ? { color: 'var(--err)' } : undefined}>{neg && v ? `−${brl(v)}` : brl(v)}</b>
    </div>
  );
  return (
    <div className="form-stack">
      <div className="ped-bar">
        <button type="button" onClick={() => setMes(maisMeses(`${mes}-01`, -1))} aria-label="Mês anterior">‹</button>
        <input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} aria-label="Mês" />
        <button type="button" onClick={() => setMes(maisMeses(`${mes}-01`, 1))} aria-label="Próximo mês">›</button>
        <select value={loja} onChange={(e) => setLoja(e.target.value)} aria-label="Loja">
          <option value="">Todas as lojas</option>
          {opcoes.lojas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
      </div>
      {!r ? <p className="muted">Calculando…</p> : (
        <>
          <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="ped-kpi"><small>Vendas</small><b>{brl(r.receita)}</b><span className="cl-sub">{r.vendas} venda(s)</span></div>
            <div className="ped-kpi"><small>Lucro bruto</small><b>{brl(r.lucro_bruto)}</b><span className="cl-sub">margem {pct(r.margem_bruta)}</span></div>
            <div className="ped-kpi"><small>Despesas</small><b>{brl(r.total_despesas)}</b></div>
            <div className="ped-kpi hero"><small>Resultado</small><b style={{ color: r.resultado < 0 ? 'var(--err)' : 'var(--ok)' }}>{brl(r.resultado)}</b><span className="cl-sub">margem {pct(r.margem_liquida)}</span></div>
          </div>
          <div className="card fin-dre">
            <h3 style={{ marginTop: 0 }}>Resultado de {nome}</h3>
            <L rot="Vendas brutas" v={r.receita_bruta} />
            {r.descontos > 0 && <L rot="(−) Descontos" v={r.descontos} neg sub />}
            <L rot="= Vendas" v={r.receita} forte />
            <L rot="(−) Taxas de cartão e apps" v={r.taxas} neg sub />
            <L rot="(−) Custo das mercadorias vendidas" v={r.cmv} neg sub />
            <L rot="= Lucro bruto" v={r.lucro_bruto} forte />
            {r.despesas.map((d) => <L key={d.categoria} rot={`(−) ${d.categoria}`} v={d.valor} neg sub />)}
            {r.despesas.length === 0 && <div className="fin-dre-linha sub muted"><span>Nenhuma despesa lançada no mês</span><b>—</b></div>}
            {r.outras_receitas.map((d) => <L key={d.categoria} rot={`(+) ${d.categoria}`} v={d.valor} sub />)}
            <L rot="= Resultado do mês" v={r.resultado} forte cls={r.resultado < 0 ? 'neg' : 'pos'} />
            {r.fora_do_resultado.length > 0 && (
              <p className="form-hint">Fora do resultado (o custo já entra pelo custo das mercadorias vendidas): {r.fora_do_resultado.map((x) => `${x.categoria} ${brl(x.valor)}`).join(' · ')}.</p>
            )}
            <p className="form-hint">Pelo mês de competência das contas e pela data das vendas (não pela data em que o dinheiro entra). O custo das mercadorias é o custo gravado em cada venda.</p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Resultado dos últimos 6 meses</h3>
            <Barras titulo="Resultado por mês" altura={120} dados={r.serie.map((s) => ({ chave: s.mes, valor: s.resultado, mes: s.mes }))} rotulo={(d) => mesBR(d.mes)} destaque={(d) => d.mes === mes} />
            <div className="tabela-wrap">
              <table className="tabela-cartoes">
                <thead><tr><th>Mês</th><th className="num">Vendas</th><th className="num">Lucro bruto</th><th className="num">Despesas</th><th className="num">Resultado</th></tr></thead>
                <tbody>{r.serie.map((s) => <tr key={s.mes}><td><b>{mesBR(s.mes)}</b></td><td className="num">{brl(s.receita)}</td><td className="num">{brl(s.lucro_bruto)}</td><td className="num">{brl(s.despesas)}</td><td className="num"><b style={{ color: s.resultado < 0 ? 'var(--err)' : undefined }}>{brl(s.resultado)}</b></td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
