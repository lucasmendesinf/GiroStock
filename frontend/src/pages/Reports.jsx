import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

export default function Reports() {
  const [locations, setLocations] = useState([]);
  const [users, setUsers] = useState([]);
  const [filtros, setFiltros] = useState({ location_id: '', operador_id: '', forma_pagamento: '' });
  const [resumo, setResumo] = useState(null);
  const [historico, setHistorico] = useState([]);

  useEffect(() => {
    api.get('/locations').then(setLocations);
    api.get('/users').catch(() => []).then((u) => setUsers(u || []));
  }, []);

  const carregar = useCallback(async () => {
    const params = new URLSearchParams();
    if (filtros.location_id) params.set('location_id', filtros.location_id);
    if (filtros.operador_id) params.set('operador_id', filtros.operador_id);
    if (filtros.forma_pagamento) params.set('forma_pagamento', filtros.forma_pagamento);
    const qs = params.toString();
    const [r, h] = await Promise.all([
      api.get(`/reports/sales-summary${qs ? `?${qs}` : ''}`),
      api.get(`/reports/sales-history${qs ? `?${qs}` : ''}`),
    ]);
    setResumo(r); setHistorico(h);
  }, [filtros]);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <div className="page">
      <h2>Relatórios</h2>

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
          <option value="pix">Pix</option>
          <option value="cartao_credito">Cartao de Credito</option>
          <option value="cartao_debito">Cartao de Debito</option>
          <option value="dinheiro">Dinheiro</option>
        </select>
      </div>

      {resumo && (
        <div className="cards-resumo">
          <div className="card"><h4>Total vendido</h4><p>R$ {Number(resumo.total_vendido).toFixed(2)}</p></div>
          <div className="card"><h4>Numero de vendas</h4><p>{resumo.numero_vendas}</p></div>
          <div className="card"><h4>Ticket medio</h4><p>R$ {Number(resumo.ticket_medio).toFixed(2)}</p></div>
          <div className="card"><h4>Forma mais usada</h4><p>{resumo.forma_pagamento_mais_usada || '-'}</p></div>
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
                  <td>{r.forma_pagamento}</td>
                  <td>R$ {r.total.toFixed(2)}</td>
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
          <thead><tr><th>Data/Hora</th><th>Operador</th><th>Terminal</th><th>Local</th><th>Forma</th><th>Total</th></tr></thead>
          <tbody>
            {historico.map((h) => (
              <tr key={h.id}>
                <td>{new Date(h.criado_em).toLocaleString('pt-BR')}</td>
                <td>{h.operador_nome}</td>
                <td>{h.terminal_nome}</td>
                <td>{h.location_nome}</td>
                <td>{h.forma_pagamento}</td>
                <td>R$ {Number(h.total).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
