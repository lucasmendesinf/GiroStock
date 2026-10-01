import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

// Lojas/locais de estoque e os PDVs (terminais com caixa) de cada uma.
export default function Locations() {
  const [locations, setLocations] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [novaLoja, setNovaLoja] = useState('');
  const [novoTerminal, setNovoTerminal] = useState({});
  const [renomeando, setRenomeando] = useState({});
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);

  const reload = useCallback(async () => {
    const [l, t] = await Promise.all([api.get('/locations'), api.get('/terminals')]);
    setLocations(l); setTerminals(t);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  function avisar(msg) { setOk(msg); setErro(null); setTimeout(() => setOk(null), 4000); }
  async function executar(fn, msg) {
    try {
      await fn();
      avisar(msg);
      reload();
    } catch (err) { setErro(err.message); setOk(null); }
  }

  function criarLoja(e) {
    e.preventDefault();
    executar(async () => { await api.post('/locations', { nome: novaLoja }); setNovaLoja(''); }, 'Loja criada.');
  }

  function criarTerminal(locationId) {
    const nome = (novoTerminal[locationId] || '').trim();
    if (!nome) return;
    executar(async () => {
      await api.post('/terminals', { nome, location_id: locationId });
      setNovoTerminal({ ...novoTerminal, [locationId]: '' });
    }, 'PDV criado.');
  }

  function salvarNome(tipo, id) {
    const nome = (renomeando[id] || '').trim();
    if (!nome) return;
    executar(async () => {
      await api.patch(`/${tipo}/${id}`, { nome });
      setRenomeando({ ...renomeando, [id]: undefined });
    }, 'Nome atualizado.');
  }

  function campoNome(tipo, item) {
    if (renomeando[item.id] === undefined) {
      return (
        <>
          <span className={tipo === 'locations' ? 'nome' : ''}>{item.nome}</span>
          <button className="btn-link" onClick={() => setRenomeando({ ...renomeando, [item.id]: item.nome })}>Renomear</button>
        </>
      );
    }
    return (
      <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input value={renomeando[item.id]} onChange={(e) => setRenomeando({ ...renomeando, [item.id]: e.target.value })} style={{ padding: '6px 10px' }} />
        <button className="btn-link" onClick={() => salvarNome(tipo, item.id)}>Salvar</button>
        <button className="btn-link" onClick={() => setRenomeando({ ...renomeando, [item.id]: undefined })}>Cancelar</button>
      </span>
    );
  }

  return (
    <div className="page">
      <h2>Lojas &amp; PDVs</h2>
      {erro && <p className="error">{erro}</p>}
      {ok && <p className="toast-ok">{ok}</p>}

      <div className="card">
        <h3>Nova loja / local de estoque</h3>
        <form onSubmit={criarLoja} className="inline-form">
          <input style={{ flexGrow: 1, minWidth: '220px' }} placeholder="Nome (ex: Loja Centro, Depósito, Evento Sábado)" value={novaLoja} onChange={(e) => setNovaLoja(e.target.value)} required />
          <button type="submit">Criar loja</button>
        </form>
        <p className="form-hint" style={{ marginTop: '10px' }}>
          Cada loja tem estoque próprio de produtos e insumos. Para vender numa loja, crie um PDV nela: a venda baixa o estoque da loja do PDV.
          Uma loja só pode ser desativada sem estoque e sem caixa aberto.
        </p>
      </div>

      {locations.map((l) => {
        const daLoja = terminals.filter((t) => t.location_id === l.id);
        return (
          <div className="loja-card" key={l.id} style={{ opacity: l.ativo ? 1 : 0.6 }}>
            <div className="loja-card-top">
              <span style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                {campoNome('locations', l)}
                {!l.ativo && <span className="badge-inativo">Inativa</span>}
              </span>
              <button className={`btn-link ${l.ativo ? 'perigo' : ''}`}
                onClick={() => executar(() => api.patch(`/locations/${l.id}`, { ativo: !l.ativo }), l.ativo ? 'Loja desativada.' : 'Loja reativada.')}>
                {l.ativo ? 'Desativar loja' : 'Reativar loja'}
              </button>
            </div>

            {daLoja.map((t) => (
              <div className="terminal-row" key={t.id}>
                <span style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {campoNome('terminals', t)}
                  {t.caixa_aberto && <span className="chip principal">caixa aberto</span>}
                  {!t.ativo && <span className="badge-inativo">Inativo</span>}
                </span>
                <button className={`btn-link ${t.ativo ? 'perigo' : ''}`} disabled={!l.ativo && !t.ativo}
                  onClick={() => executar(() => api.patch(`/terminals/${t.id}`, { ativo: !t.ativo }), t.ativo ? 'PDV desativado.' : 'PDV reativado.')}>
                  {t.ativo ? 'Desativar PDV' : 'Reativar PDV'}
                </button>
              </div>
            ))}
            {daLoja.length === 0 && <span className="form-hint">Nenhum PDV nesta loja.</span>}

            {l.ativo && (
              <div className="inline-form" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <input style={{ flexGrow: 1, minWidth: '180px', padding: '8px 12px' }} placeholder="Nome do novo PDV (ex: Caixa 02)"
                  value={novoTerminal[l.id] || ''} onChange={(e) => setNovoTerminal({ ...novoTerminal, [l.id]: e.target.value })} />
                <button className="btn-link" onClick={() => criarTerminal(l.id)}>+ Adicionar PDV</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
