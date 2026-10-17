import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';
import ProdutoPicker from './ProdutoPicker.jsx';
import { brl, qtd } from '../utils/format';

// Situacao do pedido na plataforma (eventos do iFood), em portugues.
export const STATUS_IFOOD = {
  PLACED: 'Aguardando aceite', CONFIRMED: 'Aceito no iFood', SEPARATION_STARTED: 'Em separação', SEPARATION_ENDED: 'Separado',
  READY_TO_PICKUP: 'Pronto no iFood', DISPATCHED: 'Despachado', CONCLUDED: 'Concluído no iFood', CANCELLED: 'Cancelado no iFood',
  CANCELLATION_REQUESTED: 'Cancelamento solicitado',
};

// Aviso sonoro curto (sem arquivo de audio): dois bipes.
export function bipe() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.25].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
    });
  } catch { /* sem audio */ }
}

// Etiquetas do cartao do pedido (aceite pendente, negociacao, falta de estoque).
export function EtiquetasIfood({ p }) {
  const e = p.externo;
  if (!e) return null;
  return (
    <>
      {e.disputa && <span className="ped-pill err">Cliente pediu cancelamento</span>}
      {!e.confirmado && p.status === 'novo' && !e.disputa && <span className="ped-pill warn">Aceitar no iFood</span>}
      {e.status_externo === 'CANCELLATION_REQUESTED' && <span className="ped-pill warn">Cancelamento solicitado</span>}
      {e.faltas_estoque && p.status !== 'finalizado' && p.status !== 'cancelado' && <span className="ped-pill err" title={e.faltas_estoque}>Falta estoque</span>}
    </>
  );
}

// Bloco do iFood na gaveta do pedido: situacao, aceite e resposta a pedido de cancelamento do cliente.
export function BlocoIfood({ p, onFeito }) {
  const toast = useToast();
  const e = p.externo;
  const [ocupado, setOcupado] = useState(false);
  if (!e) return null;
  async function acao(promessa, msg) {
    setOcupado(true);
    try { await promessa; toast.sucesso(msg); await onFeito(); } catch (err) { toast.erro(err); } finally { setOcupado(false); }
  }
  return (
    <div className="ped-sec ifood-bloco"><span className="ped-rotulo">iFood</span>
      <div className="ped-linha"><span>Pedido no iFood</span><b>#{p.codigo_externo || '—'}</b></div>
      <div className="ped-linha"><span>Situação no iFood</span><span className="ped-tag">{STATUS_IFOOD[e.status_externo] || e.status_externo || '—'}</span></div>
      <div className="ped-linha"><span>Entrega</span><span>{p.tipo !== 'entrega' ? '—' : e.entrega_pela_plataforma ? 'Entregador do iFood' : 'Entregador da loja'}</span></div>
      {e.faltas_estoque && <div className="ped-nota" style={{ borderColor: 'var(--err)' }}><b>Falta estoque:</b> {e.faltas_estoque}. Dê entrada no estoque antes de finalizar, ou cancele no iFood.</div>}
      {e.disputa && (
        <div className="ped-nota" style={{ borderColor: 'var(--err)' }}>
          <b>O cliente pediu para cancelar.</b> {e.disputa.message || ''} Responda antes de {e.disputa.expiresAt ? new Date(e.disputa.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'o prazo do iFood'}
          {e.disputa.timeoutAction === 'ACCEPT_CANCELLATION' ? ' (sem resposta, o iFood cancela)' : ''}.
          <div className="ped-botoes" style={{ marginTop: 8 }}>
            <button type="button" className="perigo" disabled={ocupado} onClick={() => acao(api.post(`/integracoes/pedidos/${e.id}/disputa`, { aceitar: true }), 'Cancelamento aceito: pedido cancelado')}>Aceitar cancelamento</button>
            <button type="button" disabled={ocupado} onClick={() => acao(api.post(`/integracoes/pedidos/${e.id}/disputa`, { aceitar: false }), 'Cancelamento recusado: o pedido segue')}>Recusar</button>
          </div>
        </div>
      )}
      {!e.confirmado && p.status === 'novo' && !e.disputa && (
        <button type="button" className="btn-primario" style={{ width: '100%', marginTop: 8 }} disabled={ocupado}
          onClick={() => acao(api.post(`/integracoes/pedidos/${e.id}/aceitar`), `Pedido iFood #${p.codigo_externo} aceito`)}>Aceitar no iFood</button>
      )}
    </div>
  );
}

// Cancelar pedido do iFood: o motivo precisa ser um da lista do iFood.
export function CancelarIfoodModal({ pedido, onClose, onConfirmar }) {
  const toast = useToast();
  const [motivos, setMotivos] = useState(null);
  const [codigo, setCodigo] = useState('');
  useEffect(() => {
    api.get(`/integracoes/pedidos/${pedido.externo.id}/motivos-cancelamento`).then((m) => { setMotivos(m); setCodigo(m[0] ? m[0].codigo : ''); })
      .catch((err) => { toast.erro(err); setMotivos([]); });
  }, [pedido, toast]);
  const escolhido = (motivos || []).find((m) => m.codigo === codigo);
  return (
    <Modal titulo={`Cancelar pedido iFood #${pedido.codigo_externo || pedido.numero}?`} subtitulo="O cancelamento é pedido ao iFood; o pedido daqui é cancelado (e a reserva liberada) assim que o iFood confirmar." onClose={onClose}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (escolhido) onConfirmar({ motivo: escolhido.descricao, codigo_motivo: escolhido.codigo }); }}>
        {motivos === null ? <p className="muted">Buscando os motivos no iFood…</p> : (
          <Field label="Motivo (lista do iFood) *">
            <select autoFocus value={codigo} onChange={(e) => setCodigo(e.target.value)}>
              {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.descricao}</option>)}
            </select>
          </Field>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="perigo" disabled={!escolhido}>Pedir cancelamento ao iFood</button>
        </div>
      </form>
    </Modal>
  );
}

// Pedidos do iFood com item que o sistema nao reconheceu: aviso no topo + tela de vinculo.
export function PendenciasIfood({ pendencias, onMudou }) {
  const [aberto, setAberto] = useState(null);
  if (!pendencias || pendencias.length === 0) return null;
  return (
    <>
      <div className="ifood-aviso" role="status">
        <b>{pendencias.length} pedido{pendencias.length > 1 ? 's' : ''} do iFood aguardando vínculo de itens</b>
        <span className="muted"> · o iFood espera o aceite em até 8 minutos</span>
        <div className="ifood-aviso-lista">
          {pendencias.map((p) => (
            <button key={p.id} type="button" onClick={() => setAberto(p)}>#{p.codigo_externo} · {p.cliente_nome} · {brl(p.total)}{p.situacao === 'erro' ? ' · erro' : ''}</button>
          ))}
        </div>
      </div>
      {aberto && <VincularModal pendencia={aberto} onClose={() => setAberto(null)} onFeito={async () => { setAberto(null); await onMudou(); }} />}
    </>
  );
}

function VincularModal({ pendencia, onClose, onFeito }) {
  const toast = useToast();
  const [produtos, setProdutos] = useState([]);
  const [escolhas, setEscolhas] = useState(() => Object.fromEntries(pendencia.itens.map((i) => [i.chave, i.product_id])));
  const [salvando, setSalvando] = useState(false);
  const montado = useRef(true);
  useEffect(() => { api.get('/products').then((l) => { if (montado.current) setProdutos(l.filter((p) => p.ativo)); }).catch((err) => toast.erro(err)); return () => { montado.current = false; }; }, [toast]);
  const faltam = pendencia.itens.filter((i) => !escolhas[i.chave]).length;
  async function salvar() {
    setSalvando(true);
    try {
      const r = await api.post(`/integracoes/pedidos/${pendencia.id}/vincular`, { itens: pendencia.itens.filter((i) => !i.product_id).map((i) => ({ chave: i.chave, product_id: escolhas[i.chave] })) });
      if (r.situacao === 'importado') toast.sucesso(`Pedido iFood #${pendencia.codigo_externo} entrou na fila${r.faltas_estoque ? ' (com falta de estoque)' : ''}`);
      else toast.erro(r.erro || 'Ainda há itens sem produto');
      await onFeito();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo={`Vincular itens · iFood #${pendencia.codigo_externo}`} subtitulo="Diga qual produto do GiroStock é cada item do cardápio do iFood. O vínculo fica guardado para os próximos pedidos." onClose={onClose} largura="larga">
      <div className="form-stack">
        <div className="muted">{pendencia.location_nome} · {pendencia.cliente_nome} · {brl(pendencia.total)}</div>
        {pendencia.erro && <div className="ped-nota" style={{ borderColor: 'var(--err)' }}><b>Não deu para criar o pedido:</b> {pendencia.erro}</div>}
        {pendencia.itens.map((i) => (
          <div key={i.chave} className="ifood-vinculo">
            <div><b>{qtd(i.quantidade)}× {i.nome}</b>{i.codigo_externo && <span className="ped-tag" style={{ marginLeft: 6 }}>cód. {i.codigo_externo}</span>}
              {i.observacao && <div className="ped-item-obsv">» {i.observacao}</div>}</div>
            {i.product_id
              ? <span className="ped-pill ok">{(produtos.find((p) => p.id === i.product_id) || {}).nome || 'vinculado'}</span>
              : <ProdutoPicker produtos={produtos} valor={escolhas[i.chave]} onSelecionar={(p) => setEscolhas({ ...escolhas, [i.chave]: p.id })} placeholder="Qual produto é este item?" />}
          </div>
        ))}
        <p className="form-hint">Dica: cadastre no cardápio do iFood o <b>código PDV</b> de cada item igual ao código do produto aqui (ex.: PRD-0002) ou ao código de barras; assim o vínculo é automático.</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Depois</button>
          <button type="button" className="btn-primario" disabled={faltam > 0 || salvando} onClick={salvar}>{faltam > 0 ? `Faltam ${faltam} item(ns)` : salvando ? 'Salvando…' : 'Vincular e criar o pedido'}</button>
        </div>
      </div>
    </Modal>
  );
}
