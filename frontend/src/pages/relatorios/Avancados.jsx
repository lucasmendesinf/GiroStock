import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Vazio } from '../../components/ui.jsx';
import { brl, qtd } from '../../utils/format';
import { baixarCsv, numeroCsv } from '../../utils/csv';
import { Barras } from '../financeiro/util.jsx';

const AGRUPAMENTOS = [
  ['loja', 'Por loja'], ['operador', 'Por operador'], ['canal', 'Por canal de venda'], ['categoria', 'Por categoria'],
  ['produto', 'Por produto'], ['pagamento', 'Por forma de pagamento'], ['dia_semana', 'Por dia da semana'], ['hora', 'Por horário'], ['dia', 'Por dia'],
];
const PAGAMENTO = { pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', dinheiro: 'Dinheiro', online: 'Pago online (apps)' };
const diaBR = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
// Subir e bom (verde) na maioria; em descontos e cancelamentos (ruim = true) subir e ruim.
const variacao = (v, pp = false, ruim = false) => {
  if (v === null || v === undefined) return <span className="muted">sem comparação</span>;
  const melhor = ruim ? v < 0 : v > 0;
  const cor = v === 0 ? 'var(--muted)' : melhor ? 'var(--ok)' : 'var(--err)';
  return <span style={{ color: cor, fontWeight: 700 }}>{v > 0 ? '▲' : v < 0 ? '▼' : '='} {Math.abs(v).toLocaleString('pt-BR')}{pp ? ' p.p.' : '%'}</span>;
};
const nomeArq = (base, query) => `${base}_${query.get('data_inicio') || 'inicio'}_a_${query.get('data_fim') || 'hoje'}.csv`;

// Vendas comparadas por loja, operador, canal, categoria, produto, forma, dia da semana, horario ou dia.
export function AbaComparativos({ query }) {
  const toast = useToast();
  const [por, setPor] = useState('loja');
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    const q = new URLSearchParams(query);
    q.set('por', por);
    api.get(`/reports/comparativo?${q}`).then(setD).catch((err) => toast.erro(err));
  }, [query, por, toast]);
  const nome = (l) => (por === 'pagamento' ? PAGAMENTO[l.nome] || l.nome : por === 'dia' ? diaBR(l.nome) : l.nome);
  const porItem = por === 'categoria' || por === 'produto';
  const serie = por === 'hora' || por === 'dia_semana' || por === 'dia';
  function exportar() {
    baixarCsv(nomeArq(`vendas_${por}`, query),
      ['Grupo', 'Vendas', porItem ? 'Quantidade' : 'Itens', 'Total', 'Participação %', 'Custo', 'Lucro bruto', 'Margem %', ...(porItem ? [] : ['Ticket médio', 'Descontos', 'Canceladas'])],
      d.linhas.map((l) => [nome(l), l.vendas, numeroCsv(l.itens), numeroCsv(l.total), numeroCsv(l.participacao), numeroCsv(l.custo), numeroCsv(l.lucro), numeroCsv(l.margem), ...(porItem ? [] : [numeroCsv(l.ticket), numeroCsv(l.descontos), l.canceladas])]));
  }
  return (
    <div className="form-stack">
      <div className="es-chips" role="group" aria-label="Agrupar por">
        {AGRUPAMENTOS.map(([id, n]) => <button key={id} type="button" className={`es-chip ${por === id ? 'on' : ''}`} aria-pressed={por === id} onClick={() => setPor(id)}>{n}</button>)}
      </div>
      <div className="card">
        {!d ? <p className="muted">Calculando…</p> : d.linhas.length === 0 ? <Vazio>Sem vendas no período.</Vazio> : (
          <>
            <div className="ped-head" style={{ marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>{AGRUPAMENTOS.find((a) => a[0] === por)[1]} · {brl(d.total)}</h3>
              <button type="button" className="btn-link" onClick={exportar}>Exportar CSV</button>
            </div>
            {porItem && <p className="form-hint" style={{ marginTop: 0 }}>Valor dos itens, antes do desconto dado na venda inteira.</p>}
            {serie && d.linhas.length > 1 && (
              <Barras titulo="Total vendido" altura={120} dados={d.linhas.map((l) => ({ chave: l.chave, valor: l.total, nome: nome(l) }))} rotulo={(x) => x.nome} />
            )}
            <div className="tabela-wrap">
              <table className="tabela-cartoes rel-comp">
                <thead>
                  <tr>
                    <th>{AGRUPAMENTOS.find((a) => a[0] === por)[1].replace('Por ', '').replace(/^./, (c) => c.toUpperCase())}</th>
                    <th className="num">Vendas</th><th className="num">{porItem ? 'Quantidade' : 'Itens'}</th><th className="num">Total</th><th>Participação</th>
                    {!porItem && <th className="num">Ticket médio</th>}<th className="num">Lucro bruto</th><th className="num">Margem</th>
                    {!porItem && <th className="num">Canceladas</th>}
                  </tr>
                </thead>
                <tbody>
                  {d.linhas.map((l) => (
                    <tr key={l.chave}>
                      <td><b>{nome(l)}</b></td>
                      <td className="num">{l.vendas}</td>
                      <td className="num">{qtd(l.itens)}</td>
                      <td className="num"><b>{brl(l.total)}</b></td>
                      <td><div className="rel-part" title={`${l.participacao}%`}><span className="rel-trilha"><i style={{ width: `${Math.min(100, l.participacao)}%` }} /></span><span>{l.participacao.toLocaleString('pt-BR')}%</span></div></td>
                      {!porItem && <td className="num">{brl(l.ticket)}</td>}
                      <td className="num">{brl(l.lucro)}</td>
                      <td className="num">{l.margem.toLocaleString('pt-BR')}%</td>
                      {!porItem && <td className="num">{l.canceladas ? <span style={{ color: 'var(--err)' }}>{l.canceladas} ({brl(l.total_cancelado)})</span> : '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Indicadores do periodo x periodo anterior de mesmo tamanho.
export function AbaIndicadores({ query }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); api.get(`/reports/indicadores?${query}`).then(setD).catch((err) => toast.erro(err)); }, [query, toast]);
  if (!d) return <p className="muted">Calculando…</p>;
  const { atual: a, anterior: b, variacao: v } = d;
  const K = ({ t, val, ant, vari, pp, ruim, hero }) => (
    <div className={`ped-kpi ${hero ? 'hero' : ''}`}>
      <small>{t}</small><b>{val}</b>
      <span className="cl-sub">{variacao(vari, pp, ruim)} · antes {ant}</span>
    </div>
  );
  return (
    <div className="form-stack">
      <p className="form-hint" style={{ margin: 0 }}>Período {diaBR(a.de)} a {diaBR(a.ate)} ({a.dias} dia{a.dias > 1 ? 's' : ''}) comparado com {diaBR(b.de)} a {diaBR(b.ate)}.</p>
      <div className="ped-kpis rel-ind" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <K hero t="Faturamento" val={brl(a.faturamento)} ant={brl(b.faturamento)} vari={v.faturamento} />
        <K t="Vendas" val={a.vendas} ant={b.vendas} vari={v.vendas} />
        <K t="Ticket médio" val={brl(a.ticket_medio)} ant={brl(b.ticket_medio)} vari={v.ticket_medio} />
        <K t="Lucro bruto" val={brl(a.lucro_bruto)} ant={brl(b.lucro_bruto)} vari={v.lucro_bruto} />
        <K t="Margem bruta" val={`${a.margem.toLocaleString('pt-BR')}%`} ant={`${b.margem.toLocaleString('pt-BR')}%`} vari={v.margem} pp />
        <K t="Itens por venda" val={a.itens_por_venda.toLocaleString('pt-BR')} ant={b.itens_por_venda.toLocaleString('pt-BR')} vari={v.itens_por_venda} />
        <K t="Média por dia" val={brl(a.media_por_dia)} ant={brl(b.media_por_dia)} vari={v.media_por_dia} />
        <K t="Descontos" val={`${brl(a.descontos)} (${a.desconto_pct.toLocaleString('pt-BR')}%)`} ant={brl(b.descontos)} vari={v.desconto_pct} pp ruim />
        <K t="Cancelamentos" val={`${a.canceladas} (${a.cancelamento_pct.toLocaleString('pt-BR')}%)`} ant={b.canceladas} vari={v.cancelamento_pct} pp ruim />
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Destaques do período</h3>
        <div className="ped-linha"><span>Dias com venda</span><b>{a.dias_com_venda} de {a.dias}</b></div>
        <div className="ped-linha"><span>Horário de pico (maior faturamento)</span><b>{a.hora_pico || '—'}</b></div>
        <div className="ped-linha"><span>Melhor dia da semana</span><b>{a.melhor_dia_semana || '—'}</b></div>
        <div className="ped-linha"><span>Custo das mercadorias vendidas</span><b>{brl(a.custo)}</b></div>
        <div className="ped-linha"><span>Total cancelado</span><b>{brl(a.total_cancelado)}</b></div>
        <p className="form-hint">Margem, descontos e cancelamentos comparam em pontos percentuais (p.p.). Para ver por loja ou operador, use os filtros acima.</p>
      </div>
    </div>
  );
}

// Estoque: valor parado em cada loja, abaixo do minimo, produtos sem venda no periodo e curva ABC.
export function AbaEstoque({ query }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [ver, setVer] = useState('abc');
  useEffect(() => {
    setD(null);
    const q = new URLSearchParams();
    for (const k of ['location_id', 'data_inicio', 'data_fim']) if (query.get(k)) q.set(k, query.get(k));
    api.get(`/reports/estoque?${q}`).then(setD).catch((err) => toast.erro(err));
  }, [query, toast]);
  if (!d) return <p className="muted">Calculando…</p>;
  function exportar() {
    if (ver === 'abc') baixarCsv(nomeArq('curva_abc', query), ['Classe', 'Produto', 'Código', 'Quantidade', 'Faturamento', 'Participação %', 'Acumulado %'], d.abc.map((x) => [x.classe, x.nome, x.codigo_interno, numeroCsv(x.quantidade), numeroCsv(x.faturamento), numeroCsv(x.participacao), numeroCsv(x.acumulado)]));
    if (ver === 'parados') baixarCsv(nomeArq('estoque_parado', query), ['Produto', 'Código', 'Loja', 'Saldo', 'Valor a custo', 'Última venda'], d.parados.map((x) => [x.nome, x.codigo_interno, x.loja, numeroCsv(x.saldo), numeroCsv(x.valor_parado), x.ultima_venda ? new Date(x.ultima_venda).toLocaleDateString('pt-BR') : 'nunca']));
    if (ver === 'minimo') baixarCsv('abaixo_do_minimo.csv', ['Produto', 'Código', 'Loja', 'Saldo', 'Mínimo', 'Falta'], d.abaixo_minimo.map((x) => [x.nome, x.codigo_interno, x.loja, numeroCsv(x.saldo), numeroCsv(x.estoque_minimo), numeroCsv(x.falta)]));
  }
  const corClasse = { A: 'ok', B: 'warn', C: '' };
  return (
    <div className="form-stack">
      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ped-kpi hero"><small>Estoque a preço de custo</small><b>{brl(d.totais.valor_custo)}</b><span className="cl-sub">a preço de venda {brl(d.totais.valor_venda)}</span></div>
        <div className="ped-kpi"><small>Abaixo do mínimo</small><b style={d.totais.abaixo_minimo ? { color: 'var(--warn)' } : undefined}>{d.totais.abaixo_minimo}</b><span className="cl-sub">produto(s) por loja</span></div>
        <div className="ped-kpi"><small>Sem venda no período</small><b>{d.totais.parados}</b><span className="cl-sub">{brl(d.totais.valor_parado)} parado</span></div>
        <div className="ped-kpi"><small>Curva A</small><b>{(d.resumo_abc.find((c) => c.classe === 'A') || {}).produtos || 0}</b><span className="cl-sub">produtos que fazem 80% das vendas</span></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Estoque por loja</h3>
        <div className="tabela-wrap">
          <table className="tabela-cartoes">
            <thead><tr><th>Loja</th><th className="num">Produtos com saldo</th><th className="num">A preço de custo</th><th className="num">A preço de venda</th><th className="num">Abaixo do mínimo</th></tr></thead>
            <tbody>{d.posicao.map((l) => <tr key={l.id}><td><b>{l.nome}</b></td><td className="num">{l.produtos}</td><td className="num"><b>{brl(l.valor_custo)}</b></td><td className="num">{brl(l.valor_venda)}</td><td className="num">{l.abaixo_minimo || '—'}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="form-hint">Produtos de revenda (lanches com ficha técnica e combos não têm estoque próprio; os insumos ficam em Produtos & Estoque → Insumos).</p>
      </div>
      <div className="card">
        <div className="ped-head" style={{ marginBottom: 6 }}>
          <div className="es-chips" role="group" aria-label="Lista" style={{ margin: 0 }}>
            {[['abc', 'Curva ABC'], ['parados', `Sem venda (${d.parados.length})`], ['minimo', `Abaixo do mínimo (${d.abaixo_minimo.length})`]].map(([id, n]) => <button key={id} type="button" className={`es-chip ${ver === id ? 'on' : ''}`} aria-pressed={ver === id} onClick={() => setVer(id)}>{n}</button>)}
          </div>
          <button type="button" className="btn-link" onClick={exportar}>Exportar CSV</button>
        </div>
        {ver === 'abc' && (d.abc.length === 0 ? <Vazio>Sem vendas no período.</Vazio> : (
          <>
            <p className="form-hint" style={{ marginTop: 0 }}>Pelo faturamento do período: <b>A</b> = os que somam 80% das vendas (nunca podem faltar), <b>B</b> = os próximos 15%, <b>C</b> = o restante.</p>
            <div className="tabela-wrap">
              <table className="tabela-cartoes">
                <thead><tr><th>Produto</th><th>Classe</th><th className="num">Quantidade</th><th className="num">Faturamento</th><th className="num">Participação</th><th className="num">Acumulado</th></tr></thead>
                <tbody>{d.abc.map((x) => <tr key={x.id}><td><b>{x.nome}</b><div className="celula-sub">{x.codigo_interno}</div></td><td><span className={`ped-pill ${corClasse[x.classe]}`}>{x.classe}</span></td><td className="num">{qtd(x.quantidade, x.unidade)}</td><td className="num"><b>{brl(x.faturamento)}</b></td><td className="num">{x.participacao.toLocaleString('pt-BR')}%</td><td className="num">{x.acumulado.toLocaleString('pt-BR')}%</td></tr>)}</tbody>
              </table>
            </div>
          </>
        ))}
        {ver === 'parados' && (d.parados.length === 0 ? <Vazio>Todos os produtos com saldo venderam no período.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Produto</th><th>Loja</th><th className="num">Saldo</th><th className="num">Valor parado (custo)</th><th>Última venda</th></tr></thead>
              <tbody>{d.parados.map((x) => <tr key={`${x.id}-${x.loja}`}><td><b>{x.nome}</b><div className="celula-sub">{x.codigo_interno}</div></td><td>{x.loja}</td><td className="num">{qtd(x.saldo, x.unidade)}</td><td className="num"><b>{brl(x.valor_parado)}</b></td><td>{x.ultima_venda ? new Date(x.ultima_venda).toLocaleDateString('pt-BR') : 'nunca vendeu'}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
        {ver === 'minimo' && (d.abaixo_minimo.length === 0 ? <Vazio>Nenhum produto abaixo do estoque mínimo.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Produto</th><th>Loja</th><th className="num">Saldo</th><th className="num">Mínimo</th><th className="num">Falta</th></tr></thead>
              <tbody>{d.abaixo_minimo.map((x) => <tr key={`${x.id}-${x.loja}`}><td><b>{x.nome}</b><div className="celula-sub">{x.codigo_interno}</div></td><td>{x.loja}</td><td className="num">{qtd(x.saldo, x.unidade)}</td><td className="num">{qtd(x.estoque_minimo, x.unidade)}</td><td className="num"><b style={{ color: 'var(--warn)' }}>{qtd(x.falta, x.unidade)}</b></td></tr>)}</tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
