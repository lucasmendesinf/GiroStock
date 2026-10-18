import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Vazio } from '../../components/ui.jsx';
import { brl, pct } from '../../utils/format';
import { Barras, diaBR, diaCurto, maisDias, MESES_LONGOS, quandoVence } from './util.jsx';

// Visao geral: saldo, o que vence, resultado do mes, saldo projetado e proximos vencimentos.
export default function Resumo({ versao }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [fluxo, setFluxo] = useState(null);
  useEffect(() => {
    api.get('/financeiro/resumo').then((x) => {
      setR(x);
      return api.get(`/financeiro/fluxo?de=${x.hoje}&ate=${maisDias(x.hoje, 30)}`).then(setFluxo);
    }).catch((err) => toast.erro(err));
  }, [toast, versao]);
  if (!r) return <p className="muted">Carregando…</p>;
  const nomeMes = MESES_LONGOS[Number(r.mes.mes.slice(5, 7)) - 1];
  const semConta = r.contas.length === 0;
  return (
    <div className="form-stack fin-resumo">
      <div className="ped-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ped-kpi hero"><small>Saldo hoje</small><b>{brl(r.saldo)}</b><span className="cl-sub">{semConta ? 'cadastre suas contas' : `${r.contas.filter((c) => c.ativo).length} conta(s)`}</span></div>
        <div className="ped-kpi" style={r.pagar.vencido > 0 ? { borderColor: 'var(--err)' } : undefined}>
          <small>A pagar</small><b style={r.pagar.vencido > 0 ? { color: 'var(--err)' } : undefined}>{brl(r.pagar.vencido + r.pagar.hoje + r.pagar.semana)}</b>
          <span className="cl-sub">{r.pagar.n_vencido > 0 ? `${brl(r.pagar.vencido)} vencido · ` : ''}{brl(r.pagar.hoje)} hoje · {brl(r.pagar.semana)} em 7 dias</span>
        </div>
        <div className="ped-kpi"><small>A receber em 7 dias</small><b>{brl(r.receber.vencido + r.receber.hoje + r.receber.semana + r.vendas_a_cair_7dias)}</b><span className="cl-sub">contas {brl(r.receber.vencido + r.receber.hoje + r.receber.semana)} · cartão/apps {brl(r.vendas_a_cair_7dias)}</span></div>
        <div className="ped-kpi"><small>Resultado de {nomeMes}</small><b style={{ color: r.mes.resultado < 0 ? 'var(--err)' : 'var(--ok)' }}>{brl(r.mes.resultado)}</b><span className="cl-sub">vendas {brl(r.mes.receita)} · margem {pct(r.mes.margem_liquida)}</span></div>
      </div>

      {semConta && (
        <div className="ped-nota">Comece cadastrando suas contas (banco, cofre da loja) com o saldo de hoje em <Link to="/financeiro/cadastros">Cadastros</Link>, e diga em qual conta cai cada forma de pagamento das vendas. Assim o saldo e o fluxo de caixa ficam certos.</div>
      )}

      {fluxo && (
        <div className="card">
          <div className="ped-head" style={{ marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>Saldo previsto — próximos 30 dias</h3>
            <Link className="btn-link" to="/financeiro/fluxo">Ver fluxo de caixa</Link>
          </div>
          <p className="form-hint" style={{ marginTop: 0 }}>
            Em 30 dias: <b>{brl(fluxo.saldo_final)}</b>
            {fluxo.menor_saldo && fluxo.menor_saldo.saldo < fluxo.saldo_hoje ? <> · menor saldo <b style={{ color: fluxo.menor_saldo.saldo < 0 ? 'var(--err)' : undefined }}>{brl(fluxo.menor_saldo.saldo)}</b> em {diaBR(fluxo.menor_saldo.data)}</> : null}
          </p>
          <Barras titulo="Saldo previsto por dia" dados={fluxo.dias.map((d) => ({ chave: d.data, valor: d.saldo, data: d.data }))} rotulo={(d) => diaCurto(d.data)} />
        </div>
      )}

      <div className="card">
        <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Vencendo (atrasadas, hoje e próximos 7 dias)</h3></div>
        {r.proximos.length === 0 ? <Vazio>Nada vencendo nos próximos 7 dias.</Vazio> : (
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Descrição</th><th>Tipo</th><th>Vencimento</th><th className="num">Valor</th></tr></thead>
              <tbody>
                {r.proximos.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.descricao}</b><div className="celula-sub">{[t.categoria_nome, t.supplier_nome || t.customer_nome].filter(Boolean).join(' · ')}</div></td>
                    <td><span className={`ped-pill ${t.tipo === 'pagar' ? '' : 'ok'}`}>{t.tipo === 'pagar' ? 'A pagar' : 'A receber'}</span></td>
                    <td>{diaBR(t.vencimento)}<div className={`celula-sub ${t.situacao === 'vencido' ? 'fin-atraso' : ''}`}>{quandoVence(t)}</div></td>
                    <td className="num"><b>{brl(t.valor)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {r.contas.length > 0 && (
        <div className="card">
          <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Saldo por conta</h3></div>
          <div className="tabela-wrap">
            <table className="tabela-cartoes">
              <thead><tr><th>Conta</th><th>Tipo</th><th className="num">Saldo</th></tr></thead>
              <tbody>{r.contas.filter((c) => c.ativo).map((c) => <tr key={c.id}><td><b>{c.nome}</b></td><td>{{ banco: 'Banco', caixa: 'Caixa / cofre', carteira: 'Carteira digital' }[c.tipo]}</td><td className="num"><b style={{ color: c.saldo < 0 ? 'var(--err)' : undefined }}>{brl(c.saldo)}</b></td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
