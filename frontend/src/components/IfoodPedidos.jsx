import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';
import ProdutoPicker from './ProdutoPicker.jsx';
import { brl, qtd } from '../utils/format';

// Plataformas de delivery (modulo "iFood e 99Food").
export const NOME_PLATAFORMA = { ifood: 'iFood', '99food': '99Food' };
export const nomePlataforma = (chave) => NOME_PLATAFORMA[chave] || chave;
// Classe da etiqueta colorida da plataforma (iFood vermelho, 99Food amarelo).
export const classePlataforma = (chave) => (chave === 'ifood' ? 'ifood' : chave === '99food' ? 'food99' : chave === 'loja_virtual' ? 'lojav' : '');
// "no iFood" / "na 99Food"
const naPlataforma = (chave) => `${chave === '99food' ? 'na' : 'no'} ${nomePlataforma(chave)}`;

// Situacao do pedido na plataforma (eventos), em portugues.
const STATUS_EXTERNO = {
  PLACED: () => 'Aguardando aceite', CONFIRMED: (n) => `Aceito ${n}`, SEPARATION_STARTED: () => 'Em separação', SEPARATION_ENDED: () => 'Separado',
  READY_TO_PICKUP: (n) => `Pronto ${n}`, DISPATCHED: () => 'Despachado', CONCLUDED: (n) => `Concluído ${n}`, CANCELLED: (n) => `Cancelado ${n}`,
  CANCELLATION_REQUESTED: () => 'Cancelamento solicitado',
};
export const statusExterno = (e) => (STATUS_EXTERNO[e.status_externo] ? STATUS_EXTERNO[e.status_externo](naPlataforma(e.plataforma)) : e.status_externo || '—');

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
      {!e.confirmado && p.status === 'novo' && !e.disputa && <span className="ped-pill warn">Aceitar {naPlataforma(e.plataforma)}</span>}
      {e.status_externo === 'CANCELLATION_REQUESTED' && <span className="ped-pill warn">Cancelamento solicitado</span>}
      {e.faltas_estoque && p.status !== 'finalizado' && p.status !== 'cancelado' && <span className="ped-pill err" title={e.faltas_estoque}>Falta estoque</span>}
    </>
  );
}

// Bloco da plataforma na gaveta do pedido: situacao, aceite e resposta a pedido de cancelamento do cliente (iFood).
export function BlocoIfood({ p, onFeito }) {
  const toast = useToast();
  const e = p.externo;
  const [ocupado, setOcupado] = useState(false);
  if (!e) return null;
  const nome = nomePlataforma(e.plataforma);
  const na = naPlataforma(e.plataforma);
  async function acao(promessa, msg) {
    setOcupado(true);
    try { await promessa; toast.sucesso(msg); await onFeito(); } catch (err) { toast.erro(err); } finally { setOcupado(false); }
  }
  return (
    <div className={`ped-sec ifood-bloco ${e.plataforma === '99food' ? 'food99' : ''}`}><span className="ped-rotulo">{nome}</span>
      <div className="ped-linha"><span>Pedido {na}</span><b>#{p.codigo_externo || '—'}</b></div>
      <div className="ped-linha"><span>Situação {na}</span><span className="ped-tag">{statusExterno(e)}</span></div>
      <div className="ped-linha"><span>Entrega</span><span>{p.tipo !== 'entrega' ? '—' : e.entrega_pela_plataforma ? `Entregador ${e.plataforma === '99food' ? 'da' : 'do'} ${nome}` : 'Entregador da loja'}</span></div>
      {e.faltas_estoque && <div className="ped-nota" style={{ borderColor: 'var(--err)' }}><b>Falta estoque:</b> {e.faltas_estoque}. Dê entrada no estoque antes de finalizar, ou cancele {na}.</div>}
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
          onClick={() => acao(api.post(`/integracoes/pedidos/${e.id}/aceitar`), `Pedido ${nome} #${p.codigo_externo} aceito`)}>Aceitar {na}</button>
      )}
    </div>
  );
}

// Cancelar pedido da plataforma: o motivo precisa ser um da lista dela. iFood confirma depois (evento); 99Food cancela na hora.
export function CancelarIfoodModal({ pedido, onClose, onConfirmar }) {
  const toast = useToast();
  const [motivos, setMotivos] = useState(null);
  const [codigo, setCodigo] = useState('');
  useEffect(() => {
    api.get(`/integracoes/pedidos/${pedido.externo.id}/motivos-cancelamento`).then((m) => { setMotivos(m); setCodigo(m[0] ? m[0].codigo : ''); })
      .catch((err) => { toast.erro(err); setMotivos([]); });
  }, [pedido, toast]);
  const escolhido = (motivos || []).find((m) => m.codigo === codigo);
  const plat = pedido.externo.plataforma;
  const nome = nomePlataforma(plat);
  const subtitulo = plat === '99food'
    ? 'O pedido é cancelado na 99Food e aqui na hora (a reserva de estoque é liberada).'
    : 'O cancelamento é pedido ao iFood; o pedido daqui é cancelado (e a reserva liberada) assim que o iFood confirmar.';
  return (
    <Modal titulo={`Cancelar pedido ${nome} #${pedido.codigo_externo || pedido.numero}?`} subtitulo={subtitulo} onClose={onClose}>
      <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (escolhido) onConfirmar({ motivo: escolhido.descricao, codigo_motivo: escolhido.codigo }); }}>
        {motivos === null ? <p className="muted">Buscando os motivos {naPlataforma(plat)}…</p> : (
          <Field label={`Motivo (lista ${plat === '99food' ? 'da' : 'do'} ${nome}) *`}>
            <select autoFocus value={codigo} onChange={(e) => setCodigo(e.target.value)}>
              {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.descricao}</option>)}
            </select>
          </Field>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Voltar</button>
          <button type="submit" className="perigo" disabled={!escolhido}>{plat === '99food' ? 'Cancelar na 99Food' : 'Pedir cancelamento ao iFood'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Pedidos das plataformas com item que o sistema nao reconheceu: aviso no topo + tela de vinculo.
export function PendenciasIfood({ pendencias, onMudou }) {
  const [aberto, setAberto] = useState(null);
  if (!pendencias || pendencias.length === 0) return null;
  return (
    <>
      <div className="ifood-aviso" role="status">
        <b>{pendencias.length} pedido{pendencias.length > 1 ? 's' : ''} {[...new Set(pendencias.map((p) => p.plataforma))].length > 1 ? 'do iFood e da 99Food' : pendencias[0].plataforma === '99food' ? 'da 99Food' : 'do iFood'} aguardando vínculo de itens</b>
        <span className="muted"> · a plataforma espera o aceite em poucos minutos</span>
        <div className="ifood-aviso-lista">
          {pendencias.map((p) => (
            <button key={p.id} type="button" onClick={() => setAberto(p)}>{nomePlataforma(p.plataforma)} #{p.codigo_externo} · {p.cliente_nome} · {brl(p.total)}{p.situacao === 'erro' ? ' · erro' : ''}</button>
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
  const nome = nomePlataforma(pendencia.plataforma);
  async function salvar() {
    setSalvando(true);
    try {
      const r = await api.post(`/integracoes/pedidos/${pendencia.id}/vincular`, { itens: pendencia.itens.filter((i) => !i.product_id).map((i) => ({ chave: i.chave, product_id: escolhas[i.chave] })) });
      if (r.situacao === 'importado') toast.sucesso(`Pedido ${nome} #${pendencia.codigo_externo} entrou na fila${r.faltas_estoque ? ' (com falta de estoque)' : ''}`);
      else toast.erro(r.erro || 'Ainda há itens sem produto');
      await onFeito();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }
  return (
    <Modal titulo={`Vincular itens · ${nome} #${pendencia.codigo_externo}`} subtitulo={`Diga qual produto do GiroStock é cada item do cardápio ${pendencia.plataforma === '99food' ? 'da' : 'do'} ${nome}. O vínculo fica guardado para os próximos pedidos.`} onClose={onClose} largura="larga">
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
        <p className="form-hint">Dica: cadastre no cardápio {pendencia.plataforma === '99food' ? 'da' : 'do'} {nome} o <b>código PDV</b> de cada item igual ao código do produto aqui (ex.: PRD-0002) ou ao código de barras; assim o vínculo é automático.</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Depois</button>
          <button type="button" className="btn-primario" disabled={faltam > 0 || salvando} onClick={salvar}>{faltam > 0 ? `Faltam ${faltam} item(ns)` : salvando ? 'Salvando…' : 'Vincular e criar o pedido'}</button>
        </div>
      </div>
    </Modal>
  );
}
