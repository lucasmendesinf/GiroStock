import { lazy, Suspense } from 'react';
import { brl } from '../util';

// Entrega por raio no site: resultado da localizacao do endereco (taxa e tempo, fora da area, confirmar no mapa) e a folha do pino.
// O mapa (Leaflet) fica em outro arquivo carregado sob demanda: so baixa quando o cliente precisa marcar o pino.
const PinoMapa = lazy(() => import('./PinoMapa.jsx'));
export function FolhaPino(props) {
  return <Suspense fallback={null}><PinoMapa {...props} /></Suspense>;
}

const km = (v) => String(Number(v)).replace('.', ',');

// r: { status, distancia_km, taxa, tempo_estimado_min, faixa_ate_km } (resposta de /entrega/localizar ou "raio" do carrinho)
export function StatusRaio({ r, aoPino, aoRetirada, retiradaAceita, tempoBase }) {
  if (!r) return null;
  if (r.status === 'atende') {
    const min = r.tempo_estimado_min || (tempoBase !== undefined && tempoBase !== null ? tempoBase + (r.tempo_extra_min || 0) : null);
    return (
      <p className="raio-status ok" role="status">
        ✔ Entregamos no seu endereço{r.distancia_km !== null && r.distancia_km !== undefined ? ` (${km(r.distancia_km)} km da loja)` : ''} · taxa <b>{r.taxa > 0 ? brl(r.taxa) : 'grátis'}</b>{min ? ` · cerca de ${min} min` : ''}
      </p>
    );
  }
  if (r.status === 'confirmar_pino') {
    return (
      <div className="raio-status aviso" role="status">
        <p>⚠ Seu endereço está perto do limite da nossa área de entrega. <b>Confirme o local no mapa</b> para calcularmos a taxa.</p>
        <button type="button" className="botao botao-claro" onClick={aoPino}>Confirmar o local no mapa</button>
      </div>
    );
  }
  if (r.status === 'pedir_pino') {
    return (
      <div className="raio-status aviso" role="status">
        <p>Não encontramos o seu endereço pelo CEP. <b>Marque o local da entrega no mapa</b>.</p>
        <button type="button" className="botao botao-claro" onClick={aoPino}>Marcar no mapa</button>
      </div>
    );
  }
  if (r.status === 'fora') {
    return (
      <div className="raio-status erro" role="status">
        <p>✖ Esse endereço está fora da nossa área de entrega{r.distancia_km ? ` (${km(r.distancia_km)} km da loja)` : ''}.{retiradaAceita ? ' Você pode retirar o pedido na loja.' : ''}</p>
        {retiradaAceita && aoRetirada && <button type="button" className="botao botao-claro" onClick={aoRetirada}>Trocar para retirada</button>}
        {aoPino && <button type="button" className="link" onClick={aoPino}>Marcar outro local no mapa</button>}
      </div>
    );
  }
  return null;
}
