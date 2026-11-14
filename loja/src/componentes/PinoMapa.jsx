import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Folha from './Folha.jsx';

// Folha "Confirme o local da entrega" (carregada SOB DEMANDA: chunk separado, o site so baixa o mapa quando precisa).
// Pino arrastavel ja posicionado onde o sistema localizou (ou no centro da loja se nao localizou), circulo discreto do raio da
// loja para o cliente entender o limite. Os campos de endereco continuam funcionando sem o mapa; os botoes de ajuste fino
// (50 m) servem teclado e leitor de tela.
const PASSO_M = 50;
export default function PinoMapa({ inicial, loja, raioKm, mapa, aoConfirmar, aoFechar }) {
  const alvo = useRef(null);
  const m = useRef(null);
  const pino = useRef(null);
  const [pos, setPos] = useState(() => ({ lat: inicial ? inicial.lat : loja.lat, lng: inicial ? inicial.lng : loja.lng }));
  const [anuncio, setAnuncio] = useState('');

  useEffect(() => {
    if (!alvo.current) return undefined;
    const mapaL = L.map(alvo.current, { zoomControl: true, attributionControl: true }).setView([pos.lat, pos.lng], 14);
    L.tileLayer(mapa.tiles_url, { maxZoom: 19, attribution: mapa.atribuicao, referrerPolicy: 'origin' }).addTo(mapaL);
    if (raioKm > 0) L.circle([loja.lat, loja.lng], { radius: raioKm * 1000, color: '#888', weight: 2, dashArray: '6 6', fillOpacity: 0.04, interactive: false }).addTo(mapaL);
    const icone = L.divIcon({ className: 'pino-entrega', html: '<span>📍</span>', iconSize: [36, 36], iconAnchor: [18, 32] });
    const mk = L.marker([pos.lat, pos.lng], { draggable: true, icon: icone, keyboard: true, title: 'Local da entrega (arraste)' }).addTo(mapaL);
    mk.on('dragend', () => { const p = mk.getLatLng(); setPos({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) }); });
    mapaL.on('click', (ev) => { mk.setLatLng(ev.latlng); setPos({ lat: Number(ev.latlng.lat.toFixed(6)), lng: Number(ev.latlng.lng.toFixed(6)) }); });
    m.current = mapaL; pino.current = mk;
    const t = setTimeout(() => { try { mapaL.invalidateSize(); } catch { /* fechado */ } }, 60);
    return () => { clearTimeout(t); mapaL.remove(); m.current = null; pino.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function empurrar(dLat, dLng) {
    const metrosPorGrau = 111195;
    const novo = { lat: Number((pos.lat + (dLat * PASSO_M) / metrosPorGrau).toFixed(6)), lng: Number((pos.lng + (dLng * PASSO_M) / (metrosPorGrau * Math.cos((pos.lat * Math.PI) / 180))).toFixed(6)) };
    setPos(novo);
    if (pino.current) pino.current.setLatLng([novo.lat, novo.lng]);
    if (m.current) m.current.panTo([novo.lat, novo.lng]);
    setAnuncio(`Pino movido ${PASSO_M} metros`);
  }

  return (
    <Folha
      titulo="Confirme o local da entrega"
      aoFechar={aoFechar}
      larga
      rodape={<button type="button" className="botao largo" onClick={() => aoConfirmar(pos.lat, pos.lng)}>Confirmar local</button>}
    >
      <p className="dica" style={{ margin: 0 }}>Arraste o pino até o local exato (ou toque no mapa). O círculo tracejado é a área de entrega da loja.</p>
      <div ref={alvo} className="pino-mapa" role="application" aria-label="Mapa para marcar o local da entrega" />
      <div className="pino-ajuste" role="group" aria-label="Ajuste fino do pino">
        <button type="button" className="botao botao-claro" onClick={() => empurrar(1, 0)} aria-label="Mover o pino 50 metros para o norte">↑</button>
        <button type="button" className="botao botao-claro" onClick={() => empurrar(-1, 0)} aria-label="Mover o pino 50 metros para o sul">↓</button>
        <button type="button" className="botao botao-claro" onClick={() => empurrar(0, -1)} aria-label="Mover o pino 50 metros para o oeste">←</button>
        <button type="button" className="botao botao-claro" onClick={() => empurrar(0, 1)} aria-label="Mover o pino 50 metros para o leste">→</button>
      </div>
      <p className="visualmente-oculto" role="status" aria-live="polite">{anuncio}</p>
    </Folha>
  );
}
