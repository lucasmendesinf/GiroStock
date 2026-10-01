import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { Field } from '../components/ui.jsx';

// Lojas/locais de estoque e os PDVs (terminais com caixa) de cada uma.
export default function Locations() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [locations, setLocations] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [novaLoja, setNovaLoja] = useState('');
  const [novoTerminal, setNovoTerminal] = useState({});
  const [renomeando, setRenomeando] = useState({});

  const reload = useCallback(async () => {
    try {
      const [l, t] = await Promise.all([api.get('/locations'), api.get('/terminals')]);
      setLocations(l); setTerminals(t);
    } catch (err) { toast.erro(err); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  async function executar(fn, msg) {
    try {
      await fn();
      toast.sucesso(msg);
      reload();
    } catch (err) { toast.erro(err); }
  }

  function criarLoja(e) {
    e.preventDefault();
    executar(async () => { await api.post('/locations', { nome: novaLoja }); setNovaLoja(''); }, 'Loja criada.');
  }

  function criarTerminal(locationId) {
    const nome = (novoTerminal[locationId] || '').trim();
    if (!nome) { toast.erro('Digite o nome do PDV.'); return; }
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

  async function alternarLoja(l) {
    if (l.ativo && !(await confirmar({
      titulo: `Desativar a loja "${l.nome}"?`,
      mensagem: 'Os PDVs dela também serão desativados. Só é possível sem estoque e sem caixa aberto.',
      confirmar: 'Desativar loja', perigo: true,
    }))) return;
    executar(() => api.patch(`/locations/${l.id}`, { ativo: !l.ativo }), l.ativo ? 'Loja desativada.' : 'Loja reativada.');
  }

  async function alternarTerminal(t) {
    if (t.ativo && !(await confirmar({ titulo: `Desativar o PDV "${t.nome}"?`, confirmar: 'Desativar PDV', perigo: true }))) return;
    executar(() => api.patch(`/terminals/${t.id}`, { ativo: !t.ativo }), t.ativo ? 'PDV desativado.' : 'PDV reativado.');
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
      <span className="row-actions" style={{ alignItems: 'center' }}>
        <input className="input-curto" style={{ width: '200px' }} autoFocus value={renomeando[item.id]} aria-label="Novo nome"
          onChange={(e) => setRenomeando({ ...renomeando, [item.id]: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') salvarNome(tipo, item.id); if (e.key === 'Escape') setRenomeando({ ...renomeando, [item.id]: undefined }); }} />
        <button className="btn-link" onClick={() => salvarNome(tipo, item.id)}>Salvar</button>
        <button className="btn-link" onClick={() => setRenomeando({ ...renomeando, [item.id]: undefined })}>Cancelar</button>
      </span>
    );
  }

  return (
    <div className="page">
      <h2>Lojas &amp; PDVs</h2>

      <div className="card">
        <form onSubmit={criarLoja} className="form-grid">
          <Field label="Nova loja / local de estoque" style={{ flex: '1 1 320px' }}>
            <input placeholder="Ex: Loja Centro, Depósito, Evento Sábado" value={novaLoja} onChange={(e) => setNovaLoja(e.target.value)} required />
          </Field>
          <button type="submit" className="btn-primario">Criar loja</button>
        </form>
        <p className="form-hint" style={{ marginTop: '10px' }}>
          Cada loja tem estoque próprio de produtos e insumos. Para vender numa loja, crie um PDV nela: a venda baixa o estoque da loja do PDV.
        </p>
      </div>

      {locations.map((l) => {
        const daLoja = terminals.filter((t) => t.location_id === l.id);
        return (
          <div className="loja-card" key={l.id} style={{ opacity: l.ativo ? 1 : 0.6 }}>
            <div className="loja-card-top">
              <span className="row-actions" style={{ alignItems: 'center' }}>
                {campoNome('locations', l)}
                {!l.ativo && <span className="badge-inativo">Inativa</span>}
              </span>
              <button className={`btn-link ${l.ativo ? 'perigo' : ''}`} onClick={() => alternarLoja(l)}>{l.ativo ? 'Desativar loja' : 'Reativar loja'}</button>
            </div>

            {daLoja.map((t) => (
              <div className="terminal-row" key={t.id}>
                <span className="row-actions" style={{ alignItems: 'center' }}>
                  {campoNome('terminals', t)}
                  {t.caixa_aberto && <span className="chip principal">caixa aberto</span>}
                  {!t.ativo && <span className="badge-inativo">Inativo</span>}
                </span>
                <button className={`btn-link ${t.ativo ? 'perigo' : ''}`} disabled={!l.ativo && !t.ativo} onClick={() => alternarTerminal(t)}>
                  {t.ativo ? 'Desativar PDV' : 'Reativar PDV'}
                </button>
              </div>
            ))}
            {daLoja.length === 0 && <span className="form-hint">Nenhum PDV nesta loja.</span>}

            {l.ativo && (
              <div className="form-grid">
                <Field label="Novo PDV nesta loja" style={{ flex: '1 1 240px' }}>
                  <input placeholder="Ex: Caixa 02" value={novoTerminal[l.id] || ''} onChange={(e) => setNovoTerminal({ ...novoTerminal, [l.id]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); criarTerminal(l.id); } }} />
                </Field>
                <button className="btn-link" onClick={() => criarTerminal(l.id)}>+ Adicionar PDV</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
