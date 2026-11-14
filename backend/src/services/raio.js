// Entrega por raio: distancia em linha reta (Haversine) da loja ao ponto de entrega e decisao (atende / fora / confirmar pino).
// Tudo em METROS INTEIROS para comparar nas bordas sem erro de ponto flutuante. Funcao pura (sem banco): a mesma usada pelo
// pedido, pela previa do carrinho e pelo simulador da gestao.
const { HttpError } = require('../utils/http');

const RAIO_TERRA_M = 6371000;
const rad = (g) => (g * Math.PI) / 180;

// Coordenadas do Brasil (lat -35..6, lng -75..-30). Fora disso: 400.
function validarCoordenadas(lat, lng) {
  const a = Number(lat);
  const o = Number(lng);
  if (lat === null || lat === undefined || lng === null || lng === undefined || !Number.isFinite(a) || !Number.isFinite(o) || a < -35 || a > 6 || o < -75 || o > -30) {
    throw new HttpError(400, 'coordenadas inválidas (fora do Brasil)');
  }
  return { lat: a, lng: o };
}

function distanciaMetros(a, b) {
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * RAIO_TERRA_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

const metros = (km) => Math.round(Number(km) * 1000);
const n2 = (v) => Number(Number(v || 0).toFixed(2));

// loja: { loja_lat, loja_lng, raio_km, raio_usa_faixas, raio_taxa_unica, raio_margem_pino_m }
// faixas: [{ ate_km, taxa, tempo_extra_min }] (qualquer ordem)
// ponto: { lat, lng, origem } — sem lat/lng (endereco nao localizado) => 'pedir_pino'
// Devolve { status, distancia_m, taxa, tempo_extra_min, faixa_ate_km } com status 'atende' | 'fora' | 'confirmar_pino' | 'pedir_pino'.
function avaliarRaio(loja, faixas, ponto) {
  const vazio = { distancia_m: null, taxa: null, tempo_extra_min: null, faixa_ate_km: null };
  if (!ponto || ponto.lat === null || ponto.lat === undefined || ponto.lng === null || ponto.lng === undefined || ponto.lat === '' || ponto.lng === '') return { status: 'pedir_pino', ...vazio };
  const { lat, lng } = validarCoordenadas(ponto.lat, ponto.lng);
  if (loja.loja_lat === null || loja.loja_lat === undefined || loja.loja_lng === null || loja.loja_lng === undefined || !(Number(loja.raio_km) > 0)) {
    throw new HttpError(422, 'a loja ainda não configurou a entrega por raio');
  }
  const d = distanciaMetros({ lat: Number(loja.loja_lat), lng: Number(loja.loja_lng) }, { lat, lng });
  const raio = metros(loja.raio_km);
  const margem = Number(loja.raio_margem_pino_m || 0);
  const pino = ponto.origem === 'pino';
  const base = { distancia_m: d, taxa: null, tempo_extra_min: null, faixa_ate_km: null };

  const cobranca = () => {
    const lista = [...(faixas || [])].sort((x, y) => Number(x.ate_km) - Number(y.ate_km));
    if (loja.raio_usa_faixas !== false && lista.length > 0) {
      const f = lista.find((x) => metros(x.ate_km) >= d) || lista[lista.length - 1]; // borda inclusiva
      return { taxa: n2(f.taxa), tempo_extra_min: Number(f.tempo_extra_min || 0), faixa_ate_km: Number(f.ate_km) };
    }
    return { taxa: n2(loja.raio_taxa_unica), tempo_extra_min: 0, faixa_ate_km: null };
  };

  if (pino) return d > raio ? { status: 'fora', ...base } : { status: 'atende', ...base, ...cobranca() };
  if (d > raio + margem) return { status: 'fora', ...base };
  if (margem > 0 && Math.abs(d - raio) <= margem) {
    // perto do limite (dentro ou fora): o cliente confirma o pino; a cobranca prevista so existe se estiver dentro
    return { status: 'confirmar_pino', ...base, ...(d <= raio ? cobranca() : {}) };
  }
  return { status: 'atende', ...base, ...cobranca() };
}

// Faixas validas para um raio: ate_km > 0, crescentes sem repeticao, taxa >= 0, tempo extra inteiro e a ULTIMA termina exatamente no raio.
function validarFaixas(raioKm, faixas) {
  if (!Array.isArray(faixas) || faixas.length === 0) throw new HttpError(400, 'informe ao menos uma faixa de taxa');
  if (faixas.length > 20) throw new HttpError(400, 'no máximo 20 faixas');
  const lista = faixas.map((f) => {
    const ate = Number(String(f && f.ate_km).replace(',', '.'));
    const taxa = Number(String(f && f.taxa).replace(',', '.'));
    const extra = f && f.tempo_extra_min !== undefined && f.tempo_extra_min !== null && f.tempo_extra_min !== '' ? Number(f.tempo_extra_min) : 0;
    if (!Number.isFinite(ate) || ate <= 0) throw new HttpError(400, 'cada faixa precisa de "até (km)" maior que zero');
    if (Math.round(ate * 10) / 10 !== ate) throw new HttpError(400, '"até (km)" aceita uma casa decimal (ex.: 2,5)');
    if (!Number.isFinite(taxa) || taxa < 0) throw new HttpError(400, 'a taxa de cada faixa deve ser zero ou mais');
    if (!Number.isInteger(extra) || extra < 0 || extra > 600) throw new HttpError(400, 'o tempo extra da faixa deve ser de 0 a 600 minutos');
    return { ate_km: ate, taxa: n2(taxa), tempo_extra_min: extra };
  });
  for (let i = 1; i < lista.length; i++) {
    if (lista[i].ate_km === lista[i - 1].ate_km) throw new HttpError(409, `a faixa até ${lista[i].ate_km} km está repetida`);
    if (lista[i].ate_km < lista[i - 1].ate_km) throw new HttpError(400, 'as faixas devem estar em ordem crescente de distância');
  }
  if (lista[lista.length - 1].ate_km !== Number(raioKm)) throw new HttpError(400, `a última faixa deve terminar exatamente no raio (${raioKm} km)`);
  return lista;
}

// Mudou o raio: descarta as faixas que passam do novo raio e a ultima passa a terminar nele (mantendo a taxa dela).
function ajustarFaixasAoRaio(raioKm, faixas) {
  const lista = [...faixas].sort((a, b) => Number(a.ate_km) - Number(b.ate_km));
  if (lista.length === 0) return [];
  const alvo = lista.find((f) => Number(f.ate_km) >= Number(raioKm));
  // raio maior que todas as faixas: a ultima se estende ate o novo raio; senao a primeira que alcanca o raio passa a terminar nele
  const dentro = alvo ? lista.filter((f) => Number(f.ate_km) < Number(raioKm)) : lista.slice(0, -1);
  const resto = alvo || lista[lista.length - 1];
  return [...dentro, { ...resto, ate_km: Number(raioKm) }];
}

module.exports = { distanciaMetros, avaliarRaio, validarCoordenadas, validarFaixas, ajustarFaixasAoRaio, metros };
