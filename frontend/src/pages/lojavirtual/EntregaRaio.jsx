import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../../api/client';
import { useToast } from '../../context/UiContext.jsx';
import { Field } from '../../components/ui.jsx';
import { brl, parseNumero } from '../../utils/format';

// Entrega por raio: local da loja (pino arrastavel), raio com circulo no mapa, faixas de taxa por distancia (circulos concentricos),
// margem "perto do limite" (linhas tracejadas) e simulador do cliente (clicar no mapa chama o SERVIDOR: mesma funcao do pedido).
const CORES = ['#5fc48a', '#d4ae4a', '#f0a05a', '#ec7a72', '#a78bfa', '#60a5fa'];
const CENTRO_PADRAO = [-23.55052, -46.633308];
const virgula = (v) => String(v ?? '').replace('.', ',');
const km1 = (v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

// Mudou o raio: descarta as faixas que passam do novo raio e a ultima termina nele (mesma regra do servidor).
function ajustarFaixas(raio, faixas) {
  if (!(raio > 0) || faixas.length === 0) return faixas;
  const lista = [...faixas].sort((a, b) => parseNumero(a.ate) - parseNumero(b.ate));
  const alvo = lista.find((f) => parseNumero(f.ate) >= raio);
  const dentro = alvo ? lista.filter((f) => parseNumero(f.ate) < raio) : lista.slice(0, -1);
  const resto = alvo || lista[lista.length - 1];
  return [...dentro, { ...resto, ate: virgula(raio) }];
}

const estadoDe = (d) => ({
  lat: d.loja.lat, lng: d.loja.lng, raio: virgula(d.raio_km ?? 5), usaFaixas: d.usa_faixas, taxaUnica: virgula(d.taxa_unica ?? 0), margem: String(d.margem_pino_m ?? 500),
  faixas: d.faixas.length ? d.faixas.map((f) => ({ ate: virgula(f.ate_km), taxa: virgula(f.taxa.toFixed(2)), extra: String(f.tempo_extra_min || 0) }))
    : [{ ate: virgula(d.raio_km ?? 5), taxa: '0,00', extra: '0' }],
});

export default function EntregaRaio({ config, dados, onMudou }) {
  const toast = useToast();
  const [d] = useState(dados);
  const [e, setE] = useState(() => estadoDe(dados));
  const [busca, setBusca] = useState(dados.loja.endereco || '');
  const [buscando, setBuscando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [sim, setSim] = useState({ origem: 'pino', localizado: true, ponto: null, resultado: null });
  const mapaRef = useRef(null);
  const mapa = useRef(null);
  const camadas = useRef({ grupo: null, loja: null, sim: null });
  const raioNum = parseNumero(e.raio);
  const margemNum = Math.max(0, Math.min(5000, Math.round(parseNumero(e.margem) || 0)));

  const faixasNum = useMemo(() => e.faixas.map((f) => ({ ate_km: parseNumero(f.ate), taxa: parseNumero(f.taxa), tempo_extra_min: Math.round(parseNumero(f.extra) || 0) })), [e.faixas]);
  const configSim = useMemo(() => ({ loja_lat: e.lat, loja_lng: e.lng, raio_km: raioNum, raio_usa_faixas: e.usaFaixas, raio_taxa_unica: parseNumero(e.taxaUnica), raio_margem_pino_m: margemNum, faixas: faixasNum }), [e, raioNum, margemNum, faixasNum]);

  // ---- mapa ----
  useEffect(() => {
    if (!mapaRef.current || mapa.current) return undefined;
    const centro = e.lat !== null ? [e.lat, e.lng] : CENTRO_PADRAO;
    const m = L.map(mapaRef.current, { zoomControl: true }).setView(centro, 12);
    L.tileLayer(d.mapa.tiles_url, { maxZoom: 19, attribution: d.mapa.atribuicao }).addTo(m);
    mapa.current = m;
    camadas.current.grupo = L.layerGroup().addTo(m);
    const t = setTimeout(() => { try { m.invalidateSize(); } catch { /* mapa ja removido */ } }, 50);
    return () => { clearTimeout(t); m.remove(); mapa.current = null; camadas.current = { grupo: null, loja: null, sim: null }; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const simular = useCallback(async (lat, lng) => {
    setSim((s) => ({ ...s, ponto: { lat, lng }, resultado: { carregando: true } }));
    try {
      const r = await api.post('/loja-virtual/raio/simular', { lat, lng, origem: sim.origem, localizado: sim.localizado, config: configSim });
      setSim((s) => ({ ...s, resultado: r }));
    } catch (err) { setSim((s) => ({ ...s, resultado: { erro: err.message } })); }
  }, [sim.origem, sim.localizado, configSim]);

  // clique no mapa = cliente simulado (ou define o local da loja quando ainda nao ha pino)
  const aoClicar = useRef(null);
  aoClicar.current = (ev) => {
    if (e.lat === null) { setE((x) => ({ ...x, lat: Number(ev.latlng.lat.toFixed(6)), lng: Number(ev.latlng.lng.toFixed(6)) })); return; }
    simular(ev.latlng.lat, ev.latlng.lng);
  };
  useEffect(() => {
    const m = mapa.current;
    if (!m) return undefined;
    const h = (ev) => aoClicar.current(ev);
    m.on('click', h);
    return () => m.off('click', h);
  }, []);

  // pino da loja
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (camadas.current.loja) { m.removeLayer(camadas.current.loja); camadas.current.loja = null; }
    if (e.lat === null) return;
    const icone = L.divIcon({ className: 'rz-pino', html: '<span>🏪</span>', iconSize: [34, 34], iconAnchor: [17, 30] });
    const mk = L.marker([e.lat, e.lng], { draggable: true, icon: icone, title: 'Local da loja (arraste)', zIndexOffset: 1000 }).addTo(m);
    mk.on('dragend', () => { const p = mk.getLatLng(); setE((x) => ({ ...x, lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })); });
    camadas.current.loja = mk;
  }, [e.lat, e.lng]);

  // circulos: faixas (concentricos), raio e linhas tracejadas de "perto do limite"
  useEffect(() => {
    const m = mapa.current;
    const g = camadas.current.grupo;
    if (!m || !g) return;
    g.clearLayers();
    if (e.lat === null || !(raioNum > 0)) return;
    const c = [e.lat, e.lng];
    if (e.usaFaixas) {
      [...faixasNum].map((f, i) => ({ ...f, i })).filter((f) => f.ate_km > 0).sort((a, b) => b.ate_km - a.ate_km).forEach((f) => {
        L.circle(c, { radius: f.ate_km * 1000, color: CORES[f.i % CORES.length], weight: 2, fillColor: CORES[f.i % CORES.length], fillOpacity: 0.1, interactive: false }).addTo(g);
      });
    }
    L.circle(c, { radius: raioNum * 1000, color: '#d4ae4a', weight: 3, fill: !e.usaFaixas, fillOpacity: 0.12, interactive: false }).addTo(g);
    if (margemNum > 0) {
      L.circle(c, { radius: raioNum * 1000 + margemNum, color: '#f0a05a', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(g);
      if (raioNum * 1000 - margemNum > 0) L.circle(c, { radius: raioNum * 1000 - margemNum, color: '#f0a05a', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(g);
    }
  }, [e.lat, e.lng, raioNum, margemNum, e.usaFaixas, faixasNum]);

  // enquadra o circulo quando o raio ou o local mudam
  useEffect(() => {
    const m = mapa.current;
    if (!m || e.lat === null || !(raioNum > 0)) return;
    m.fitBounds(L.latLng(e.lat, e.lng).toBounds(raioNum * 2000), { padding: [30, 30], animate: false });
  }, [raioNum, e.lat === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ponto simulado
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (camadas.current.sim) { m.removeLayer(camadas.current.sim); camadas.current.sim = null; }
    if (!sim.ponto) return;
    camadas.current.sim = L.circleMarker([sim.ponto.lat, sim.ponto.lng], { radius: 9, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1 }).addTo(m);
  }, [sim.ponto]);
  // refaz a simulacao quando a configuracao ou a origem mudam
  useEffect(() => { if (sim.ponto) simular(sim.ponto.lat, sim.ponto.lng); }, [configSim, sim.origem, sim.localizado]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => setE((x) => ({ ...x, [k]: v }));
  function mudaRaio(v) {
    setE((x) => {
      const r = parseNumero(v);
      return { ...x, raio: v, faixas: r > 0 && x.usaFaixas ? ajustarFaixas(r, x.faixas) : x.faixas };
    });
  }
  const setFaixa = (i, k, v) => setE((x) => ({ ...x, faixas: x.faixas.map((f, j) => (j === i ? { ...f, [k]: v } : f)) }));
  function addFaixa() {
    setE((x) => {
      if (x.faixas.length >= 8) return x;
      const ult = x.faixas[x.faixas.length - 1];
      const ate = Math.max(0.5, Math.round(((parseNumero(x.faixas[x.faixas.length - 2]?.ate) || 0) + parseNumero(ult.ate)) * 5) / 10);
      const novas = [...x.faixas.slice(0, -1), { ate: virgula(Math.min(ate, parseNumero(ult.ate) - 0.1) > 0 ? Math.min(ate, Math.round((parseNumero(ult.ate) - 0.1) * 10) / 10) : 0.5), taxa: ult.taxa, extra: ult.extra }, ult];
      return { ...x, faixas: novas };
    });
  }
  const delFaixa = (i) => setE((x) => (x.faixas.length <= 1 ? x : { ...x, faixas: x.faixas.filter((_, j) => j !== i) }));

  async function buscarEndereco() {
    if (busca.trim().length < 5) return toast.erro(new Error('Digite o endereço ou o CEP da loja.'));
    setBuscando(true);
    try {
      const r = await api.get(`/loja-virtual/geocodificar?q=${encodeURIComponent(busca.trim())}`);
      if (r.localizado) { set('lat', Number(r.lat.toFixed(6))); setE((x) => ({ ...x, lng: Number(r.lng.toFixed(6)) })); mapa.current && mapa.current.setView([r.lat, r.lng], 13); toast.sucesso('Local encontrado. Arraste o pino para ajustar.'); }
      else toast.erro(new Error(r.geocodificador && !r.geocodificador.configurado ? `Busca de endereço indisponível (${r.geocodificador.motivo}). Clique no mapa para marcar o local.` : 'Não encontramos esse endereço. Clique no mapa para marcar o local da loja.'));
    } catch (err) { toast.erro(err); } finally { setBuscando(false); }
  }

  const erros = useMemo(() => {
    const out = [];
    if (e.lat === null) out.push('Marque o local da loja (busque o endereço ou clique no mapa).');
    if (!(raioNum >= 0.5 && raioNum <= 60)) out.push('O raio deve ser de 0,5 a 60 km.');
    if (e.usaFaixas) {
      faixasNum.forEach((f, i) => {
        if (!(f.ate_km > 0)) out.push(`Faixa ${i + 1}: informe "até (km)" maior que zero.`);
        if (!(f.taxa >= 0)) out.push(`Faixa ${i + 1}: a taxa deve ser zero ou mais.`);
        if (i > 0 && !(f.ate_km > faixasNum[i - 1].ate_km)) out.push(`Faixa ${i + 1}: deve ir além de ${km1(faixasNum[i - 1].ate_km)} km (ordem crescente, sem repetir).`);
      });
    }
    return [...new Set(out)];
  }, [e.lat, raioNum, e.usaFaixas, faixasNum]);

  async function salvar(modo) {
    if (erros.length) return toast.erro(new Error(erros[0]));
    setSalvando(true);
    try {
      await api.put('/loja-virtual/raio', {
        entrega_modo: modo, loja_lat: e.lat, loja_lng: e.lng, raio_km: raioNum, raio_usa_faixas: e.usaFaixas, raio_taxa_unica: parseNumero(e.taxaUnica) || 0, raio_margem_pino_m: margemNum,
        faixas: e.usaFaixas ? faixasNum : undefined,
      });
      toast.sucesso(modo === 'raio' ? 'Entrega por raio ativada.' : 'Configuração do raio salva.');
      await onMudou();
    } catch (err) { toast.erro(err); } finally { setSalvando(false); }
  }

  const area = raioNum > 0 ? Math.PI * raioNum * raioNum : 0;
  const resumo = (() => {
    if (!(raioNum > 0)) return '';
    if (!e.usaFaixas) return `Entregamos até ${km1(raioNum)} km da loja com taxa única de ${brl(parseNumero(e.taxaUnica) || 0)}. Fora disso, só retirada.`;
    const partes = faixasNum.map((f, i) => `${i === 0 ? 'até' : `de ${km1(faixasNum[i - 1].ate_km)} a`} ${km1(f.ate_km)} km ${f.taxa > 0 ? brl(f.taxa) : 'grátis'}${f.tempo_extra_min ? ` (+${f.tempo_extra_min} min)` : ''}`);
    return `Entregamos até ${km1(raioNum)} km da loja: ${partes.join('; ')}. Fora disso, só retirada.`;
  })();
  const r = sim.resultado;

  return (
    <div className="rz-layout">
      <div className="rz-mapa-wrap">
        <div ref={mapaRef} className="rz-mapa" role="application" aria-label="Mapa da cobertura de entrega" />
        <div className="rz-dica">{e.lat === null ? 'Clique no mapa para marcar o local da loja' : 'Clique no mapa para simular o endereço de um cliente'}</div>
        {r && (
          <div className="rz-res" role="status">
            {r.carregando ? <span className="muted">Consultando o servidor…</span> : r.erro ? <span className="err-t">{r.erro}</span> : (
              <>
                <b className={r.status === 'atende' ? 'rz-ok' : r.status === 'fora' ? 'rz-fora' : 'rz-aviso'}>
                  {r.status === 'atende' ? '✔ Entregamos aqui' : r.status === 'fora' ? '✖ Fora da área de entrega' : r.status === 'confirmar_pino' ? '⚠ Perto do limite' : '⚠ Endereço não localizado'}
                </b>
                {r.distancia_km !== null && <div>Distância em linha reta: <b>{km1(r.distancia_km)} km</b></div>}
                {r.status === 'atende' && <div>Taxa <b>{brl(r.taxa)}</b>{r.faixa_ate_km ? <> · faixa até {km1(r.faixa_ate_km)} km</> : null}{r.tempo_extra_min ? <> · +{r.tempo_extra_min} min</> : null}</div>}
                {r.status === 'confirmar_pino' && <div>O site pede para o cliente <b>confirmar o pino</b> no mapa{r.taxa !== null ? <> (previsto: {brl(r.taxa)})</> : ' (está um pouco fora do raio)'}.</div>}
                {r.status === 'pedir_pino' && <div>O site pede para o cliente <b>marcar o pino</b> no mapa.</div>}
                {r.status === 'fora' && <div>O cliente vê "fora da área" e a opção de retirar na loja.</div>}
              </>
            )}
          </div>
        )}
      </div>

      <div className="rz-painel">
        <div className="card form-stack">
          <h3 style={{ margin: 0 }}>Local da loja</h3>
          <div className="rz-linha">
            <input value={busca} onChange={(ev) => setBusca(ev.target.value)} placeholder="Endereço ou CEP da loja" aria-label="Endereço ou CEP da loja" onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); buscarEndereco(); } }} />
            <button type="button" className="btn-link" disabled={buscando} onClick={buscarEndereco}>{buscando ? 'Buscando…' : 'Buscar'}</button>
          </div>
          <p className="form-hint" style={{ margin: 0 }}>{e.lat === null ? 'Sem local definido: busque o endereço ou clique no mapa.' : <>Arraste o pino 🏪 para ajustar · {e.lat.toFixed(5)}, {e.lng.toFixed(5)}</>}</p>
          {d.geocodificador && !d.geocodificador.configurado && <p className="form-hint" style={{ margin: 0 }}>A busca por endereço está indisponível ({d.geocodificador.motivo}); marque o local clicando no mapa.</p>}
        </div>

        <div className="card form-stack">
          <h3 style={{ margin: 0 }}>Raio de entrega</h3>
          <div className="rz-linha">
            <input type="range" min="0.5" max="30" step="0.5" value={Math.min(30, raioNum || 0.5)} onChange={(ev) => mudaRaio(virgula(ev.target.value))} aria-label="Raio em km (barra)" />
            <input className="rz-curto" inputMode="decimal" value={e.raio} onChange={(ev) => mudaRaio(ev.target.value)} aria-label="Raio em km" /> <span className="muted">km</span>
          </div>
          <p className="form-hint" style={{ margin: 0 }}>De 0,5 a 60 km em linha reta a partir da loja{area > 0 ? ` · área de cerca de ${Math.round(area).toLocaleString('pt-BR')} km²` : ''}. A última faixa sempre termina no raio.</p>
        </div>

        <div className="card form-stack">
          <h3 style={{ margin: 0 }}>Taxa de entrega</h3>
          <div className="rz-seg" role="group" aria-label="Como cobrar a taxa">
            <button type="button" className={e.usaFaixas ? 'on' : ''} onClick={() => set('usaFaixas', true)}>Por faixa de distância</button>
            <button type="button" className={!e.usaFaixas ? 'on' : ''} onClick={() => set('usaFaixas', false)}>Taxa única</button>
          </div>
          {e.usaFaixas ? (
            <>
              <div className="tabela-wrap rz-faixas"><table className="compacta">
                <thead><tr><th /><th>Até (km)</th><th>Taxa (R$)</th><th>+ min</th><th /></tr></thead>
                <tbody>
                  {e.faixas.map((f, i) => {
                    const ultima = i === e.faixas.length - 1;
                    return (
                      <tr key={i}>
                        <td><span className="rz-bolinha" style={{ background: CORES[i % CORES.length] }} /></td>
                        <td><input inputMode="decimal" value={f.ate} disabled={ultima} title={ultima ? 'A última faixa termina no raio' : ''} onChange={(ev) => setFaixa(i, 'ate', ev.target.value)} aria-label={`Faixa ${i + 1}: até quantos km`} /></td>
                        <td><input inputMode="decimal" value={f.taxa} onChange={(ev) => setFaixa(i, 'taxa', ev.target.value)} aria-label={`Faixa ${i + 1}: taxa`} /></td>
                        <td><input inputMode="numeric" value={f.extra} onChange={(ev) => setFaixa(i, 'extra', ev.target.value)} aria-label={`Faixa ${i + 1}: minutos a mais`} /></td>
                        <td>{e.faixas.length > 1 && <button type="button" className="btn-link perigo" onClick={() => delFaixa(i)} aria-label={`Remover faixa ${i + 1}`}>×</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
              <div><button type="button" className="btn-link" onClick={addFaixa} disabled={e.faixas.length >= 8}>+ Faixa</button></div>
            </>
          ) : (
            <Field label="Taxa única (R$)"><input inputMode="decimal" value={e.taxaUnica} onChange={(ev) => set('taxaUnica', ev.target.value)} /></Field>
          )}
        </div>

        <div className="card form-stack">
          <h3 style={{ margin: 0 }}>Perto do limite, pedir o pino</h3>
          <div className="rz-linha"><input className="rz-curto" inputMode="numeric" value={e.margem} onChange={(ev) => set('margem', ev.target.value.replace(/\D/g, ''))} aria-label="Margem em metros" /> <span className="muted">metros</span></div>
          <p className="form-hint" style={{ margin: 0 }}>Endereços a menos de {margemNum} m do limite (dentro ou fora) pedem que o cliente confirme o local no mapa. Linhas tracejadas. 0 desliga.</p>
        </div>

        <div className="card form-stack">
          <h3 style={{ margin: 0 }}>Simulador do cliente</h3>
          <div className="rz-seg" role="group" aria-label="Como o endereço foi localizado">
            <button type="button" className={sim.localizado ? 'on' : ''} onClick={() => setSim((s) => ({ ...s, localizado: true, origem: 'cep' }))}>Localizado pelo CEP</button>
            <button type="button" className={!sim.localizado ? 'on' : ''} onClick={() => setSim((s) => ({ ...s, localizado: false, origem: 'pino' }))}>Não localizado (cliente marca o pino)</button>
          </div>
          <p className="form-hint" style={{ margin: 0 }}>Clique no mapa: a resposta vem do servidor, a mesma regra do pedido.</p>
        </div>

        {resumo && <div className="ped-nota">{resumo}</div>}
        {erros.length > 0 && <div className="es-erro" role="alert">{erros[0]}</div>}
        <div className="rz-acoes">
          <button type="button" disabled={salvando || erros.length > 0} onClick={() => salvar('raio')}>{salvando ? 'Salvando…' : config.entrega_modo === 'raio' || d.modo === 'raio' ? 'Salvar' : 'Salvar e ativar entrega por raio'}</button>
        </div>
      </div>
    </div>
  );
}
