import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

const FORMA_LABEL = { pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', dinheiro: 'Dinheiro' };
const brl = (v) => `R$ ${Number(v).toFixed(2)}`;

export default function Reports() {
  const [locations, setLocations] = useState([]);
  const [users, setUsers] = useState([]);
  const [filtros, setFiltros] = useState({ location_id: '', operador_id: '', forma_pagamento: '', status: '' });
  const [resumo, setResumo] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [venda, setVenda] = useState(null);
  const [motivoCancelamento, setMotivoCancelamento] = useState('');
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);

  useEffect(() => {
    api.get('/locations').then(setLocations);
    api.get('/users').catch(() => []).then((u) => setUsers(u || []));
  }, []);

  const carregar = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v) params.set(k, v);
    const qs = params.toString();
    const [r, h] = await Promise.all([
      api.get(`/reports/sales-summary${qs ? `?${qs}` : ''}`),
      api.get(`/reports/sales-history${qs ? `?${qs}` : ''}`),
    ]);
    setResumo(r); setHistorico(h);
  }, [filtros]);

  useEffect(() => { carregar(); }, [carregar]);

  async function abrirVenda(id) {
    setErro(null);
    setMotivoCancelamento('');
    try {
      setVenda(await api.get(`/sales/${id}`));
    } catch (err) { setErro(err.message); }
  }

  async function cancelarVenda(e) {
    e.preventDefault();
    setErro(null);
    try {
      await api.post(`/sales/${venda.id}/cancel`, { motivo: motivoCancelamento });
      setOk('Venda cancelada e estoque devolvido.');
      setTimeout(() => setOk(null), 4000);
      setVenda(null);
      carregar();
    } catch (err) { setErro(err.message); }
  }

  return (
    <div className="page">
      <h2>Relatórios</h2>
      {ok && <p className="toast-ok">{ok}</p>}
      {erro && !venda && <p className="error">{erro}</p>}

      <div className="card filtros">
        <select value={filtros.location_id} onChange={(e) => setFiltros({ ...filtros, location_id: e.target.value })}>
          <option value="">Todos os locais</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
        <select value={filtros.operador_id} onChange={(e) => setFiltros({ ...filtros, operador_id: e.target.value })}>
          <option value="">Todos os operadores</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
        <select value={filtros.forma_pagamento} onChange={(e) => setFiltros({ ...filtros, forma_pagamento: e.target.value })}>
          <option value="">Todas as formas</option>
          {Object.entries(FORMA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filtros.status} onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}>
          <option value="">Histórico: todas</option>
          <option value="concluida">Só concluídas</option>
          <option value="cancelada">Só canceladas</option>
        </select>
      </div>

      {resumo && (
        <div className="cards-resumo">
          <div className="card"><h4>Total vendido</h4><p>{brl(resumo.total_vendido)}</p></div>
          <div className="card"><h4>Número de vendas</h4><p>{resumo.numero_vendas}</p></div>
          <div className="card"><h4>Ticket médio</h4><p>{brl(resumo.ticket_medio)}</p></div>
          <div className="card"><h4>Forma mais usada</h4><p>{FORMA_LABEL[resumo.forma_pagamento_mais_usada] || '-'}</p></div>
          <div className="card"><h4>Custo das mercadorias</h4><p>{brl(resumo.custo_total)}</p></div>
          <div className="card"><h4>Lucro bruto</h4><p>{brl(resumo.lucro_bruto)}</p></div>
          <div className="card"><h4>Margem</h4><p>{resumo.margem_percentual}%</p></div>
          <div className="card"><h4>Canceladas</h4><p>{resumo.vendas_canceladas} · {brl(resumo.total_cancelado)}</p></div>
        </div>
      )}

      {resumo && (
        <div className="card">
          <h3>Quebra por forma de pagamento</h3>
          <table>
            <thead><tr><th>Forma</th><th>Total</th><th>Qtd</th><th>%</th></tr></thead>
            <tbody>
              {resumo.quebra_por_forma_pagamento.map((r) => (
                <tr key={r.forma_pagamento}>
                  <td>{FORMA_LABEL[r.forma_pagamento] || r.forma_pagamento}</td>
                  <td>{brl(r.total)}</td>
                  <td>{r.quantidade}</td>
                  <td>{r.percentual}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3>Histórico de vendas</h3>
        <table>
          <thead><tr><th>Data/Hora</th><th>Operador</th><th>Terminal</th><th>Local</th><th>Forma</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {historico.map((h) => (
              <tr key={h.id} className={h.status === 'cancelada' ? 'row-inativa' : ''}>
                <td>{new Date(h.criado_em).toLocaleString('pt-BR')}</td>
                <td>{h.operador_nome}</td>
                <td>{h.terminal_nome}</td>
                <td>{h.location_nome}</td>
                <td>{FORMA_LABEL[h.forma_pagamento] || h.forma_pagamento}</td>
                <td>{brl(h.total)}</td>
                <td>{h.status === 'cancelada' ? <span className="badge-cancelada" title={h.motivo_cancelamento || ''}>Cancelada</span> : 'Concluída'}</td>
                <td><button className="btn-link" onClick={() => abrirVenda(h.id)}>Ver itens</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {venda && (
        <div className="modal">
          <div className="modal-content wide">
            <h3>Venda de {new Date(venda.criado_em).toLocaleString('pt-BR')}</h3>
            <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {venda.location_nome} · {venda.terminal_nome} · {venda.operador_nome} · {FORMA_LABEL[venda.forma_pagamento]}
            </span>

            <table>
              <thead><tr><th>Produto</th><th>Qtd</th><th>Preço</th><th>Custo</th><th>Subtotal</th></tr></thead>
              <tbody>
                {venda.itens.map((i) => (
                  <tr key={i.id}>
                    <td>{i.product_nome}</td>
                    <td>{Number(i.quantidade)}</td>
                    <td>{brl(i.preco_unitario)}</td>
                    <td>{i.custo_unitario !== null ? brl(i.custo_unitario) : '-'}</td>
                    <td>{brl(i.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ textAlign: 'right', fontWeight: 800, color: 'var(--gold-light)' }}>
              Total {brl(venda.total)}{venda.troco !== null ? ` · recebido ${brl(venda.valor_recebido)} · troco ${brl(venda.troco)}` : ''}
            </div>

            {venda.status === 'cancelada' && (
              <p className="error">
                Cancelada em {new Date(venda.cancelado_em).toLocaleString('pt-BR')} por {venda.cancelado_por_nome}: {venda.motivo_cancelamento}
              </p>
            )}

            {venda.pode_cancelar && (
              <form onSubmit={cancelarVenda} className="detail-section">
                <span className="detail-section-title">Cancelar venda</span>
                <span className="form-hint">O estoque (produtos e insumos) volta para {venda.location_nome} e o valor sai do caixa ainda aberto.</span>
                <input placeholder="Motivo do cancelamento *" value={motivoCancelamento} onChange={(e) => setMotivoCancelamento(e.target.value)} required minLength={3} />
                <button type="submit" className="btn-link perigo">Confirmar cancelamento</button>
              </form>
            )}
            {venda.status === 'concluida' && !venda.caixa_aberto && (
              <span className="form-hint">O caixa desta venda já foi fechado, então ela não pode mais ser cancelada.</span>
            )}

            {erro && <p className="error">{erro}</p>}
            <div className="modal-actions">
              <button onClick={() => { setVenda(null); setErro(null); }}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
