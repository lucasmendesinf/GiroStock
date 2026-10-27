import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useToast, useConfirm } from '../context/UiContext.jsx';
import { Field } from '../components/ui.jsx';
import ConfigCupom from './ConfigCupom.jsx';
import ConfigRecebimentoGarcom from '../components/ConfigRecebimentoGarcom.jsx';
import IfoodConexoes from '../components/IfoodConexoes.jsx';
import Food99Conexoes from '../components/Food99Conexoes.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { temModulo } from '../utils/permissions.js';

// Lojas/locais de estoque e os PDVs (terminais com caixa) de cada uma.
export default function Locations() {
  const toast = useToast();
  const { user } = useAuth();
  const moduloPedidos = temModulo(user, 'pedidos');
  const moduloGarcom = temModulo(user, 'garcom');
  const moduloIfood = temModulo(user, 'delivery_apps') && !user.modoTeste; // o modo teste nao fala com o iFood nem com a 99Food
  const confirmar = useConfirm();
  const [locations, setLocations] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [novaLoja, setNovaLoja] = useState('');
  const [novaComanda, setNovaComanda] = useState(false);
  const [novaPedidos, setNovaPedidos] = useState(false);
  const [configurando, setConfigurando] = useState(null);
  const [recebimento, setRecebimento] = useState(null);
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
    executar(async () => { await api.post('/locations', { nome: novaLoja, usa_comanda: novaComanda, usa_pedidos: novaPedidos }); setNovaLoja(''); setNovaComanda(false); setNovaPedidos(false); }, 'Loja criada.');
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

  function alternarPedidos(l) {
    executar(() => api.patch(`/locations/${l.id}`, { usa_pedidos: !l.usa_pedidos }),
      l.usa_pedidos ? 'Pedidos desligados nesta loja.' : 'Pedidos ligados nesta loja: aparecem no menu Pedidos e no PDV.');
  }

  function alternarComanda(l) {
    executar(() => api.patch(`/locations/${l.id}`, { usa_comanda: !l.usa_comanda }),
      l.usa_comanda ? 'Número de pedido desligado nesta loja.' : 'Número de pedido ligado nesta loja.');
  }

  async function alternarLoja(l) {
    if (l.ativo && !(await confirmar({
      titulo: `Desativar a loja "${l.nome}"?`,
      mensagem: 'Os PDVs dela também serão desativados. Só é possível sem estoque e sem caixa aberto.',
      confirmar: 'Desativar loja', perigo: true,
    }))) return;
    executar(() => api.patch(`/locations/${l.id}`, { ativo: !l.ativo }), l.ativo ? 'Loja desativada.' : 'Loja reativada.');
  }

  async function excluirLoja(l) {
    if (!(await confirmar({
      titulo: `Excluir a loja "${l.nome}"?`,
      mensagem: 'Os PDVs dela também serão excluídos. Só é possível se a loja nunca teve movimentação de estoque, vendas ou caixa; se já teve, use Desativar.',
      confirmar: 'Excluir loja', perigo: true,
    }))) return;
    executar(() => api.del(`/locations/${l.id}`), 'Loja excluída.');
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
          <label className="check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={novaComanda} onChange={(e) => setNovaComanda(e.target.checked)} /> Usar número de pedido (comanda)
          </label>
          {moduloPedidos && (
            <label className="check" style={{ alignSelf: 'center' }}>
              <input type="checkbox" checked={novaPedidos} onChange={(e) => setNovaPedidos(e.target.checked)} /> Usar pedidos (lanchonete)
            </label>
          )}
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
              <span className="row-actions">
                <button className={`btn-link ${l.ativo ? 'perigo' : ''}`} onClick={() => alternarLoja(l)}>{l.ativo ? 'Desativar loja' : 'Reativar loja'}</button>
                <button className="btn-link perigo" onClick={() => excluirLoja(l)}>Excluir loja</button>
              </span>
            </div>

            <div className="loja-config-linha">
              <label className="check">
                <input type="checkbox" checked={!!l.usa_comanda} onChange={() => alternarComanda(l)} /> Usar número de pedido (comanda) — recomeça do 1 quando o caixa abre num novo turno
              </label>
              <button className="btn-link" onClick={() => setConfigurando(l)}>Configurar cupom e comanda</button>
            </div>
            {moduloPedidos && <div className="loja-config-linha">
              <label className="check">
                <input type="checkbox" checked={!!l.usa_pedidos} onChange={() => alternarPedidos(l)} /> Usar pedidos — o cliente pede, a cozinha prepara e só depois sai a venda (reserva o estoque ao gerar o pedido)
              </label>
            </div>}

            {moduloGarcom && l.usa_pedidos && <div className="loja-config-linha">
              <span className="form-hint" style={{ margin: 0 }}>Garçom: {l.garcom_recebe ? `recebe no app (taxa de serviço ${Number(l.taxa_servico_pct)}%)` : 'não recebe no app (só o caixa cobra)'}</span>
              <button className="btn-link" onClick={() => setRecebimento(l)}>Configurar recebimento do garçom</button>
            </div>}

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
      {moduloIfood && locations.length > 0 && <IfoodConexoes lojas={locations} />}
      {moduloIfood && locations.length > 0 && <Food99Conexoes lojas={locations} />}
      {recebimento && <ConfigRecebimentoGarcom loja={locations.find((x) => x.id === recebimento.id) || recebimento} terminais={terminals} onClose={() => setRecebimento(null)} onSalvo={() => { setRecebimento(null); reload(); }} />}
      {configurando && <ConfigCupom loja={locations.find((x) => x.id === configurando.id) || configurando} onClose={() => setConfigurando(null)} onSalvo={() => { setConfigurando(null); reload(); }} />}
    </div>
  );
}
