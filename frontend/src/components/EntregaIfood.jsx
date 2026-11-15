import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api/client';
import { useConfirm, useToast } from '../context/UiContext.jsx';
import { Field, Modal } from './ui.jsx';
import { brl, dataHora } from '../utils/format';

// Entregador do iFood (Entrega Facil / Sob Demanda) para pedido de outro canal: cotacao, chamar, acompanhar no mapa e cancelar.
// O endereco e as coordenadas vao para o app do entregador; o cliente acompanha pelo link do iFood.
export const STATUS_ENTREGA = {
  solicitada: ['Pedido enviado ao iFood', 'warn'], buscando: ['Buscando entregador', 'warn'], alocado: ['Entregador a caminho da loja', 'ok'],
  indo_loja: ['Entregador a caminho da loja', 'ok'], na_loja: ['Entregador na loja', 'ok'], em_rota: ['Saiu para entrega', 'ok'],
  no_destino: ['Entregador chegou no cliente', 'ok'], entregue: ['Entregue pelo iFood', 'ok'], cancelada: ['Entrega cancelada', 'err'], falhou: ['Sem entregador', 'err'],
};
const ATIVAS = ['solicitada', 'buscando', 'alocado', 'indo_loja', 'na_loja', 'em_rota', 'no_destino'];
export const entregaIfoodAtiva = (p) => !!(p && p.entrega_ifood && ATIVAS.includes(p.entrega_ifood.status));
export const podeChamarIfood = (p) => p.tipo === 'entrega' && !['ifood', '99food'].includes(p.origem) && !p.comanda_id && ['novo', 'em_preparo', 'pronto'].includes(p.status) && !entregaIfoodAtiva(p);

// Etiqueta do cartao no quadro de pedidos
export function EtiquetaEntregaIfood({ p }) {
  if (!p.entrega_ifood) return null;
  const [nome, cor] = STATUS_ENTREGA[p.entrega_ifood.status] || [p.entrega_ifood.status, ''];
  return <span className={`ped-pill ${cor}`} title="Entregador do iFood">🛵 iFood: {nome}</span>;
}

function useMapa(ref, cfg) {
  const mapa = useRef(null);
  useEffect(() => {
    if (!ref.current || !cfg || mapa.current) return undefined;
    const m = L.map(ref.current, { zoomControl: true, attributionControl: true }).setView([-23.55, -46.63], 14);
    L.tileLayer(cfg.tiles_url, { maxZoom: 19, attribution: cfg.atribuicao, referrerPolicy: 'origin' }).addTo(m);
    mapa.current = m;
    setTimeout(() => m.invalidateSize(), 50);
    return () => { m.remove(); mapa.current = null; };
  }, [ref, cfg]);
  return mapa;
}
const pino = (emoji) => L.divIcon({ className: 'rz-pino', html: `<span>${emoji}</span>`, iconSize: [34, 34], iconAnchor: [17, 30] });

// ---------- bloco na gaveta do pedido ----------
export function BlocoEntregaIfood({ pedido: p, onMudou }) {
  const toast = useToast();
  const [chamar, setChamar] = useState(false);
  const [cancelar, setCancelar] = useState(false);
  const [dados, setDados] = useState(null); // rastreio + mapa
  const e = p.entrega_ifood;
  const ativa = entregaIfoodAtiva(p);
  const carregar = useCallback(async () => {
    try {
      const prep = await api.get(`/integracoes/entregas/pedidos/${p.id}`);
      const rast = prep.entrega && ['alocado', 'indo_loja', 'na_loja', 'em_rota', 'no_destino'].includes(prep.entrega.status) ? await api.get(`/integracoes/entregas/pedidos/${p.id}/rastreio`) : prep.entrega;
      setDados({ mapa: prep.mapa, entrega: rast, pode: prep.pode, motivo: prep.motivo });
    } catch { setDados(null); }
  }, [p.id]);
  const mostra = !!e || podeChamarIfood(p);
  const chaveEstado = `${e ? e.status : ''}|${e ? e.atualizado_em : ''}|${p.status}`;
  useEffect(() => {
    if (!mostra) return undefined;
    carregar();
    if (!ativa) return undefined;
    const t = setInterval(carregar, 30000);
    return () => clearInterval(t);
  }, [carregar, ativa, mostra, chaveEstado]);
  if (!e && !podeChamarIfood(p)) return null;
  const ent = dados && dados.entrega;
  const [nomeSt, cor] = e ? STATUS_ENTREGA[e.status] || [e.status, ''] : ['', ''];
  const textoCliente = e && e.tracking_url ? `Olá${p.cliente_nome ? `, ${p.cliente_nome.split(' ')[0]}` : ''}! Seu pedido nº ${p.numero} vai com um entregador do iFood. Acompanhe aqui: ${e.tracking_url}${e.codigo_entrega ? ` · Código para receber: ${e.codigo_entrega}` : ' · O entregador vai pedir os 4 últimos dígitos do seu celular.'}` : '';
  const telCliente = String(p.cliente_telefone || '').replace(/\D/g, '');
  return (
    <div className="ped-sec ent-ifood">
      <div className="ped-rotulo">Entregador iFood</div>
      {!e || !ativa ? (
        <>
          {e && <div className="ped-linha"><span>{nomeSt}{e.erro ? ` · ${e.erro}` : ''}</span><span className={`ped-pill ${cor}`}>{e.status === 'entregue' ? 'Entregue' : 'Encerrada'}</span></div>}
          {podeChamarIfood(p) && (
            dados && !dados.pode && dados.motivo ? <p className="form-hint" style={{ margin: 0 }}>{dados.motivo}</p>
              : <button type="button" className="ent-botao" onClick={() => setChamar(true)}>🛵 Chamar entregador iFood</button>
          )}
        </>
      ) : (
        <>
          <div className="ped-linha"><b>{nomeSt}</b><span className={`ped-pill ${cor}`}>{e.entregador_nome || 'iFood'}</span></div>
          <div className="ped-linha"><span>Entrega pelo iFood</span><span>{e.valor !== null && e.valor !== undefined ? brl(e.valor) : '—'}{e.tempo_min ? ` · ${e.tempo_min}–${e.tempo_max} min` : ''}</span></div>
          {ent && ent.previsao_entrega && <div className="ped-linha"><span>Previsão de entrega</span><span>{dataHora(ent.previsao_entrega).slice(-5)}</span></div>}
          {e.codigo_entrega && <div className="ped-linha"><span>Código para o cliente</span><b>{e.codigo_entrega}</b></div>}
          {e.erro && <div className="form-hint" style={{ color: 'var(--warn)' }}>{e.erro}</div>}
          {dados && ent && <MapaEntrega mapa={dados.mapa} entrega={ent} />}
          <div className="ent-acoes">
            {e.tracking_url && <a className="btn-link" href={e.tracking_url} target="_blank" rel="noreferrer">Abrir acompanhamento</a>}
            {e.tracking_url && telCliente && <a className="btn-link" href={`https://wa.me/55${telCliente.replace(/^55(?=\d{10,11}$)/, '')}?text=${encodeURIComponent(textoCliente)}`} target="_blank" rel="noreferrer">Mandar link ao cliente (WhatsApp)</a>}
            {e.tracking_url && <button type="button" className="btn-link" onClick={() => navigator.clipboard.writeText(e.tracking_url).then(() => toast.sucesso('Link copiado'), () => {})}>Copiar link</button>}
            {['solicitada', 'buscando', 'alocado', 'indo_loja', 'na_loja'].includes(e.status) && <button type="button" className="btn-link perigo" onClick={() => setCancelar(true)}>Cancelar entregador</button>}
          </div>
        </>
      )}
      {chamar && <ChamarEntregadorModal pedido={p} onClose={() => setChamar(false)} onChamado={() => { setChamar(false); onMudou(); setTimeout(carregar, 300); }} />}
      {cancelar && <CancelarEntregaModal pedido={p} onClose={() => setCancelar(false)} onFeito={() => { setCancelar(false); onMudou(); }} />}
    </div>
  );
}

// Mapa do acompanhamento: destino (casa) e o entregador (moto), atualizado a cada 30 s.
function MapaEntrega({ mapa: cfg, entrega }) {
  const ref = useRef(null);
  const mapa = useMapa(ref, cfg);
  const camadas = useRef(null);
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (camadas.current) camadas.current.remove();
    const g = L.layerGroup().addTo(m);
    camadas.current = g;
    const pontos = [[entrega.lat, entrega.lng]];
    L.marker([entrega.lat, entrega.lng], { icon: pino('🏠'), title: 'Cliente' }).addTo(g);
    if (entrega.entregador) {
      L.marker([entrega.entregador.lat, entrega.entregador.lng], { icon: pino('🛵'), title: 'Entregador', zIndexOffset: 500 }).addTo(g);
      pontos.push([entrega.entregador.lat, entrega.entregador.lng]);
    }
    if (pontos.length > 1) m.fitBounds(pontos, { padding: [30, 30], maxZoom: 16, animate: false });
    else m.setView(pontos[0], 15, { animate: false });
  }, [mapa, entrega]);
  return (
    <div>
      <div ref={ref} className="ent-mapa" role="img" aria-label="Mapa da entrega" />
      <div className="celula-sub">{entrega.entregador ? `🛵 posição do entregador às ${dataHora(entrega.entregador.em).slice(-5)} · 🏠 cliente` : 'A posição do entregador aparece quando o iFood atribuir um entregador.'}</div>
    </div>
  );
}

// ---------- chamar ----------
function ChamarEntregadorModal({ pedido: p, onClose, onChamado }) {
  const toast = useToast();
  const confirmar = useConfirm();
  const [prep, setPrep] = useState(null);
  const [end, setEnd] = useState(null);
  const [cot, setCot] = useState(null);
  const [cotando, setCotando] = useState(false);
  const [erro, setErro] = useState('');
  const [pag, setPag] = useState({ tipo: '', bandeira: '', troco_para: '' });
  const [alocar, setAlocar] = useState('10');
  const [enviando, setEnviando] = useState(false);
  const fechar = useRef(onClose);
  fechar.current = onClose;
  useEffect(() => {
    api.get(`/integracoes/entregas/pedidos/${p.id}`).then((r) => {
      setPrep(r);
      setEnd({ ...r.endereco, cep: r.endereco.cep ? String(r.endereco.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2') : '' });
      const prev = r.forma_prevista;
      setPag({ tipo: r.pago ? 'pago' : prev === 'dinheiro' ? 'dinheiro' : prev === 'cartao_debito' ? 'debito' : ['cartao', 'cartao_credito'].includes(prev) ? 'credito' : '', bandeira: '', troco_para: r.troco_para ? String(r.troco_para) : '' });
    }).catch((err) => { toast.erro(err); fechar.current(); });
  }, [p.id, toast]);
  const set = (k) => (ev) => { setEnd((x) => ({ ...x, [k]: ev.target.value })); setCot(null); };
  async function buscarCep() {
    const cep = String(end.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) return;
    try {
      const r = await api.get(`/integracoes/entregas/cep/${cep}`);
      if (r.encontrado) setEnd((x) => ({ ...x, logradouro: x.logradouro || r.logradouro, bairro: x.bairro || r.bairro, cidade: r.cidade || x.cidade, uf: r.uf || x.uf }));
    } catch { /* segue manual */ }
  }
  async function cotar(ponto) {
    setCotando(true); setErro('');
    try {
      const r = await api.post(`/integracoes/entregas/pedidos/${p.id}/cotar`, { endereco: { ...end, lat: ponto ? ponto.lat : null, lng: ponto ? ponto.lng : null } });
      setCot(r);
      if (r.preparo_sugerido_min !== null && !ponto) setAlocar(String(Math.min(30, Math.max(0, r.preparo_sugerido_min))));
    } catch (err) { setCot(null); setErro(err.message); } finally { setCotando(false); }
  }
  async function chamar() {
    if (!cot) return;
    const ok = await confirmar({
      titulo: `Chamar entregador do iFood por ${brl(cot.valor)}?`,
      mensagem: `O iFood cobra ${brl(cot.valor)} da loja por esta entrega. O entregador recebe o endereço no app e pede ao cliente os 4 últimos dígitos do celular para entregar.`,
      confirmar: 'Chamar entregador',
    });
    if (!ok) return;
    setEnviando(true);
    try {
      await api.post(`/integracoes/entregas/pedidos/${p.id}/chamar`, {
        endereco: { ...end, lat: cot.lat, lng: cot.lng }, cotacao_id: cot.cotacao_id, cotacao: cot, alocar_em_min: Number(alocar) || 0,
        pagamento: { tipo: pag.tipo, bandeira: pag.bandeira, troco_para: pag.troco_para === '' ? undefined : Number(String(pag.troco_para).replace(',', '.')) },
      });
      toast.sucesso('Entregador do iFood chamado');
      onChamado();
    } catch (err) { toast.erro(err); setEnviando(false); }
  }
  if (!prep || !end) return <Modal titulo="Chamar entregador iFood" onClose={onClose}><p className="muted">Carregando…</p></Modal>;
  const bandeiras = cot ? [...new Set(cot.formas.filter((f) => (pag.tipo === 'credito' ? f.metodo === 'CREDIT' : f.metodo === 'DEBIT')).map((f) => f.bandeira).filter(Boolean))] : [];
  const pagOk = pag.tipo === 'pago' || pag.tipo === 'dinheiro' || ((pag.tipo === 'credito' || pag.tipo === 'debito') && pag.bandeira);
  return (
    <Modal titulo={`Chamar entregador iFood · pedido #${p.numero}`} subtitulo="O endereço e o ponto no mapa vão para o app do entregador do iFood." onClose={onClose} largura="larga">
      <div className="form-stack">
        {prep.endereco_texto && <div className="ped-nota">Endereço no pedido: <b>{prep.endereco_texto}</b></div>}
        <div className="form-grid">
          <Field label="CEP"><input value={end.cep || ''} onChange={set('cep')} onBlur={buscarCep} inputMode="numeric" placeholder="00000-000" /></Field>
          <Field label="Rua"><input value={end.logradouro || ''} onChange={set('logradouro')} maxLength={50} /></Field>
          <Field label="Número"><input value={end.numero || ''} onChange={set('numero')} maxLength={10} /></Field>
          <Field label="Complemento"><input value={end.complemento || ''} onChange={set('complemento')} maxLength={50} /></Field>
          <Field label="Bairro"><input value={end.bairro || ''} onChange={set('bairro')} maxLength={50} /></Field>
          <Field label="Cidade"><input value={end.cidade || ''} onChange={set('cidade')} maxLength={50} /></Field>
          <Field label="UF"><input value={end.uf || ''} onChange={set('uf')} maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Referência"><input value={end.referencia || ''} onChange={set('referencia')} maxLength={70} /></Field>
        </div>
        {!cot && <button type="button" className="btn-primario" disabled={cotando} onClick={() => cotar(end.lat !== null && end.lat !== undefined && end.lng !== null ? { lat: end.lat, lng: end.lng } : null)}>{cotando ? 'Consultando o iFood…' : 'Ver valor e tempo'}</button>}
        {erro && <p className="error">{erro}</p>}
        {cot && (
          <>
            <div className="wa-previa-numeros wa-numeros-linha">
              <div className="wa-numero"><b>{brl(cot.valor)}</b><span>cobrado pelo iFood</span></div>
              <div className="wa-numero"><b>{(cot.distancia_m / 1000).toFixed(1).replace('.', ',')} km</b><span>distância</span></div>
              <div className="wa-numero"><b>{cot.tempo_min}–{cot.tempo_max} min</b><span>tempo de entrega</span></div>
            </div>
            <PinoEntrega mapa={prep.mapa} ponto={{ lat: cot.lat, lng: cot.lng }} onMover={(pt) => cotar(pt)} />
            <div className="form-grid">
              <Field label="Como o cliente paga">
                <select value={pag.tipo} onChange={(ev) => setPag((x) => ({ ...x, tipo: ev.target.value, bandeira: '' }))}>
                  <option value="">Escolha…</option>
                  <option value="pago">Já está pago</option>
                  <option value="dinheiro">Dinheiro na entrega</option>
                  <option value="credito">Crédito na entrega (maquininha do entregador)</option>
                  <option value="debito">Débito na entrega (maquininha do entregador)</option>
                </select>
              </Field>
              {pag.tipo === 'dinheiro' && <Field label="Troco para (R$)" hint={`Total do pedido: ${brl(prep.total)}`}><input value={pag.troco_para} onChange={(ev) => setPag((x) => ({ ...x, troco_para: ev.target.value }))} inputMode="decimal" placeholder="sem troco" /></Field>}
              {(pag.tipo === 'credito' || pag.tipo === 'debito') && (
                <Field label="Bandeira">
                  <select value={pag.bandeira} onChange={(ev) => setPag((x) => ({ ...x, bandeira: ev.target.value }))}>
                    <option value="">Escolha…</option>
                    {(bandeiras.length ? bandeiras : ['Visa', 'Mastercard', 'Elo']).map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Quando o iFood manda o entregador" hint="Para ele chegar quando o pedido estiver pronto.">
                <select value={alocar} onChange={(ev) => setAlocar(ev.target.value)}>
                  {['0', '5', '10', '15', '20', '30'].map((m) => <option key={m} value={m}>{m === '0' ? 'Agora' : `Daqui a ${m} min`}</option>)}
                </select>
              </Field>
            </div>
            <p className="form-hint" style={{ margin: 0 }}>O entregador pede ao cliente os <b>4 últimos dígitos do celular</b> ({String(prep.telefone || '').replace(/\D/g, '').slice(-4) || '—'}) para entregar. Avise o cliente.</p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          {cot && <button type="button" className="btn-primario" disabled={enviando || cotando || !pagOk} onClick={chamar}>{enviando ? 'Chamando…' : `Chamar entregador (${brl(cot.valor)})`}</button>}
        </div>
      </div>
    </Modal>
  );
}

// Ponto da entrega no mapa: arrastar ajusta onde o entregador vai (e refaz a cotacao).
function PinoEntrega({ mapa: cfg, ponto, onMover }) {
  const ref = useRef(null);
  const mapa = useMapa(ref, cfg);
  const marca = useRef(null);
  const mover = useRef(onMover);
  mover.current = onMover;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (!marca.current) {
      marca.current = L.marker([ponto.lat, ponto.lng], { draggable: true, icon: pino('🏠'), title: 'Arraste para o ponto exato da entrega' }).addTo(m);
      marca.current.on('dragend', () => { const ll = marca.current.getLatLng(); mover.current({ lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) }); });
    } else marca.current.setLatLng([ponto.lat, ponto.lng]);
    m.setView([ponto.lat, ponto.lng], 16, { animate: false });
  }, [mapa, ponto]);
  return (
    <div>
      <div ref={ref} className="ent-mapa" role="img" aria-label="Ponto da entrega no mapa" />
      <div className="celula-sub">Confira o ponto 🏠: é para onde o entregador vai. Se estiver errado, arraste até a casa do cliente.</div>
    </div>
  );
}

// ---------- cancelar ----------
function CancelarEntregaModal({ pedido: p, onClose, onFeito }) {
  const toast = useToast();
  const [motivos, setMotivos] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const fechar = useRef(onClose);
  fechar.current = onClose;
  useEffect(() => {
    api.get(`/integracoes/entregas/pedidos/${p.id}/motivos`).then((l) => { setMotivos(l); if (l[0]) setCodigo(l[0].codigo); }).catch((err) => { toast.erro(err); fechar.current(); });
  }, [p.id, toast]);
  async function enviar() {
    setEnviando(true);
    try { await api.post(`/integracoes/entregas/pedidos/${p.id}/cancelar`, { codigo }); toast.sucesso('Cancelamento pedido ao iFood'); onFeito(); } catch (err) { toast.erro(err); setEnviando(false); }
  }
  return (
    <Modal titulo="Cancelar o entregador do iFood" onClose={onClose}>
      {motivos === null ? <p className="muted">Carregando…</p> : motivos.length === 0 ? <p>O iFood não permite mais cancelar esta entrega (o entregador pode já ter saído com o pedido).</p> : (
        <div className="form-stack">
          <Field label="Motivo"><select value={codigo} onChange={(ev) => setCodigo(ev.target.value)}>{motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.descricao}</option>)}</select></Field>
          <p className="form-hint" style={{ margin: 0 }}>O pedido continua aqui; depois dá para chamar outro entregador ou usar o seu.</p>
          <div className="modal-actions"><button type="button" onClick={onClose}>Voltar</button><button type="button" className="perigo" disabled={enviando || !codigo} onClick={enviar}>Cancelar entregador</button></div>
        </div>
      )}
      {motivos && motivos.length === 0 && <div className="modal-actions"><button type="button" onClick={onClose}>Fechar</button></div>}
    </Modal>
  );
}
