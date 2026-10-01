import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';
import { podeAcessar } from '../utils/permissions.js';
import { brl, dataHora, isoLocal, qtd, FORMA_PAGAMENTO } from '../utils/format.js';
import { Vazio } from '../components/ui.jsx';

// Painel inicial: vendas de hoje, alertas de estoque, caixas abertos e ultimas vendas.
export default function Home() {
  const { user } = useAuth();
  const veRelatorios = podeAcessar(user, 'Relatorios');
  const veEstoque = podeAcessar(user, 'Estoque');
  const [resumo, setResumo] = useState(null);
  const [ultimas, setUltimas] = useState([]);
  const [alertas, setAlertas] = useState([]);
  const [terminais, setTerminais] = useState([]);

  useEffect(() => {
    const hoje = isoLocal(new Date());
    if (veRelatorios) {
      api.get(`/reports/sales-summary?data_inicio=${hoje}&data_fim=${hoje}`).then(setResumo).catch(() => {});
      api.get(`/reports/sales-history?data_inicio=${hoje}&data_fim=${hoje}&limit=6`).then((r) => setUltimas(r.itens)).catch(() => {});
    }
    if (veEstoque) api.get('/stock/alerts').then(setAlertas).catch(() => {});
    api.get('/terminals').then(setTerminais).catch(() => {});
  }, [veRelatorios, veEstoque]);

  const abertos = terminais.filter((t) => t.caixa_aberto);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Olá, {user.nome.split(' ')[0]}</h2>
        <div className="row-actions">
          {podeAcessar(user, 'Vendas') && <Link className="btn-primario" to="/pdv">Abrir PDV</Link>}
          {veEstoque && <Link className="btn-link" to="/produtos?aba=nota">Entrada de nota</Link>}
          {veRelatorios && <Link className="btn-link" to="/relatorios">Relatórios</Link>}
        </div>
      </div>

      {veRelatorios && resumo && (
        <div className="cards-resumo">
          <div className="card"><h4>Vendido hoje</h4><p>{brl(resumo.total_vendido)}</p></div>
          <div className="card"><h4>Vendas hoje</h4><p>{resumo.numero_vendas}</p></div>
          <div className="card"><h4>Ticket médio</h4><p>{brl(resumo.ticket_medio)}</p></div>
          <div className="card"><h4>Lucro bruto hoje</h4><p>{brl(resumo.lucro_bruto)}</p></div>
        </div>
      )}

      <div className="grid-2">
        {veEstoque && (
          <div className={`card ${alertas.length ? 'alertas-card' : ''}`}>
            <h3>Estoque mínimo</h3>
            {alertas.length === 0 && <Vazio>Nenhum item abaixo do mínimo.</Vazio>}
            <ul className="lista-simples">
              {alertas.slice(0, 8).map((a) => (
                <li key={`${a.tipo}-${a.id}-${a.location_id}`}>
                  <span><span className="badge-alerta">{a.tipo}</span> {a.nome}</span>
                  <span className="muted">{a.location_nome}: {qtd(a.saldo, a.unidade)} / mín. {qtd(a.estoque_minimo, a.unidade)}</span>
                </li>
              ))}
            </ul>
            {alertas.length > 8 && <Link className="btn-link" to="/produtos?aba=estoque">Ver todos ({alertas.length})</Link>}
          </div>
        )}

        <div className="card">
          <h3>Caixas abertos</h3>
          {abertos.length === 0 && <Vazio>Nenhum caixa aberto agora.</Vazio>}
          <ul className="lista-simples">
            {abertos.map((t) => <li key={t.id}><span>{t.nome}</span><span className="muted">{t.location_nome}</span></li>)}
          </ul>
        </div>

        {veRelatorios && (
          <div className="card">
            <h3>Últimas vendas de hoje</h3>
            {ultimas.length === 0 && <Vazio>Nenhuma venda hoje ainda.</Vazio>}
            <ul className="lista-simples">
              {ultimas.map((v) => (
                <li key={v.id}>
                  <span>Venda nº {v.numero} · {FORMA_PAGAMENTO[v.forma_pagamento]}{v.status === 'cancelada' ? ' · cancelada' : ''}</span>
                  <span className="muted">{dataHora(v.criado_em).slice(-5)} · {brl(v.total)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
