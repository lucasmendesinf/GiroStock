import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useConfirm, useToast } from '../../context/UiContext.jsx';
import { Vazio } from '../../components/ui.jsx';
import { brl, dataHora, fmtTel } from '../../utils/format';

// Contas criadas no site (login por e-mail e senha). Cada uma fica ligada ao cadastro de Clientes pelo telefone.
export default function Clientes() {
  const toast = useToast();
  const confirmar = useConfirm();
  const [busca, setBusca] = useState('');
  const [lista, setLista] = useState(null);
  const carregar = useCallback(() => api.get(`/loja-virtual/clientes${busca.trim() ? `?busca=${encodeURIComponent(busca.trim())}` : ''}`).then(setLista).catch((err) => toast.erro(err)), [busca, toast]);
  useEffect(() => { const t = setTimeout(carregar, 250); return () => clearTimeout(t); }, [carregar]);
  async function alternar(c) {
    if (c.ativo && !(await confirmar({ titulo: `Bloquear ${c.nome}?`, mensagem: 'A conta sai do site na hora e não consegue entrar nem comprar até ser desbloqueada.', confirmar: 'Bloquear', perigo: true }))) return;
    try { await api.patch(`/loja-virtual/clientes/${c.id}`, { ativo: !c.ativo }); toast.sucesso(c.ativo ? 'Conta bloqueada' : 'Conta desbloqueada'); await carregar(); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="card">
      <div className="ped-head" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Clientes do site</h3></div>
      <p className="form-hint" style={{ marginTop: 0 }}>Quem criou conta no site. Os dados de compra também aparecem em <b>Clientes</b> (pelo telefone).</p>
      <input type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome, e-mail ou telefone" aria-label="Buscar cliente" style={{ width: '100%' }} />
      {!lista ? <p className="muted">Carregando…</p> : lista.length === 0 ? <Vazio>Nenhuma conta {busca ? 'encontrada' : 'criada no site ainda'}.</Vazio> : (
        <div className="tabela-wrap" style={{ marginTop: 10 }}>
          <table className="tabela-cartoes">
            <thead><tr><th>Cliente</th><th>Contato</th><th className="num">Pedidos</th><th className="num">Total gasto</th><th>Último pedido</th><th /></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} style={{ opacity: c.ativo ? 1 : 0.55 }}>
                  <td><b>{c.nome}</b>{!c.ativo && <span className="badge-inativo"> bloqueada</span>}<div className="celula-sub">desde {new Date(c.criado_em).toLocaleDateString('pt-BR')}{c.aceita_mensagens ? ' · aceita mensagens' : ''}</div></td>
                  <td>{c.email}<div className="celula-sub">{fmtTel(c.telefone)}</div></td>
                  <td className="num">{c.pedidos}</td>
                  <td className="num">{brl(c.total_gasto)}</td>
                  <td>{c.ultimo_pedido ? dataHora(c.ultimo_pedido) : '—'}</td>
                  <td className="num"><button type="button" className={`btn-link ${c.ativo ? 'perigo' : ''}`} onClick={() => alternar(c)}>{c.ativo ? 'Bloquear' : 'Desbloquear'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
