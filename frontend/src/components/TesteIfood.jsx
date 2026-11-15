import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';

// Modo teste (iFood simulado): gerar pedido de teste e simular o cliente. Nada vai para o iFood de verdade.
export function BotaoPedidoTesteIfood({ lojaId, onGerado }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button type="button" className="btn-link" onClick={() => setAberto(true)} title="Modo teste: iFood simulado">🧪 Pedido iFood de teste</button>
      {aberto && <GerarPedidoModal lojaId={lojaId} onClose={() => setAberto(false)} onGerado={(r) => { setAberto(false); onGerado(r); }} />}
    </>
  );
}

function GerarPedidoModal({ lojaId, onClose, onGerado }) {
  const toast = useToast();
  const [integ, setInteg] = useState(undefined);
  const [f, setF] = useState({ itens: 'cardapio', entrega: 'ifood', pagamento: 'online' });
  const [enviando, setEnviando] = useState(false);
  useEffect(() => {
    api.get('/integracoes').then((r) => setInteg(r.integracoes.find((i) => i.plataforma === 'ifood' && i.location_id === lojaId && i.status === 'conectado') || null)).catch(() => setInteg(null));
  }, [lojaId]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function gerar() {
    setEnviando(true);
    try {
      const r = await api.post(`/integracoes/${integ.id}/teste/pedido`, f);
      toast.sucesso(r.situacao === 'aguardando_vinculo' ? `Pedido iFood #${r.codigo} chegou aguardando vínculo do item` : `Pedido iFood #${r.codigo} chegou`);
      onGerado(r);
    } catch (err) { toast.erro(err); setEnviando(false); }
  }
  return (
    <Modal titulo="🧪 Gerar pedido do iFood de teste" subtitulo="Simula um cliente pedindo no app do iFood. Nada vai para o iFood de verdade." onClose={onClose}>
      {integ === undefined ? <p className="muted">Carregando…</p> : !integ ? (
        <p>Conecte o <b>iFood de teste</b> nesta loja primeiro: <b>Lojas &amp; PDVs → Receber pedidos do iFood → Conectar iFood de teste</b>.</p>
      ) : (
        <div className="form-stack">
          <Field label="Itens">
            <select value={f.itens} onChange={set('itens')}>
              <option value="cardapio">Produtos do GiroStock (entram direto)</option>
              <option value="desconhecido">Item desconhecido (testar vínculo / produto de teste)</option>
            </select>
          </Field>
          <Field label="Entrega">
            <select value={f.entrega} onChange={set('entrega')}>
              <option value="ifood">Entregador do iFood</option>
              <option value="loja">Entrega da loja</option>
              <option value="retirada">Retirada no balcão</option>
            </select>
          </Field>
          <Field label="Pagamento">
            <select value={f.pagamento} onChange={set('pagamento')}>
              <option value="online">Pago online no iFood</option>
              <option value="dinheiro">Dinheiro na entrega (troco para R$ 100)</option>
              <option value="cartao">Cartão na entrega</option>
            </select>
          </Field>
          <div className="modal-actions"><button type="button" onClick={onClose}>Cancelar</button><button type="button" className="btn-primario" disabled={enviando} onClick={gerar}>{enviando ? 'Gerando…' : 'Gerar pedido'}</button></div>
        </div>
      )}
    </Modal>
  );
}

// Na gaveta de um pedido do iFood (modo teste): o cliente cancela ou pede cancelamento.
export function AcoesClienteTeste({ pedido: p, onFeito }) {
  const toast = useToast();
  if (p.origem !== 'ifood' || ['finalizado', 'cancelado'].includes(p.status)) return null;
  async function acao(a) {
    try { await api.post(`/integracoes/teste/pedidos/${p.id}/cliente/${a}`, {}); toast.sucesso(a === 'cancelar' ? 'Cliente cancelou no iFood de teste' : 'Cliente pediu cancelamento no iFood de teste'); onFeito(); } catch (err) { toast.erro(err); }
  }
  return (
    <div className="ped-sec teste-acoes">
      <div className="ped-rotulo">🧪 Simular o cliente (teste)</div>
      <div className="ent-acoes">
        <button type="button" className="btn-link" onClick={() => acao('cancelar')}>Cliente cancela</button>
        <button type="button" className="btn-link" onClick={() => acao('disputa')}>Cliente pede cancelamento</button>
      </div>
    </div>
  );
}
