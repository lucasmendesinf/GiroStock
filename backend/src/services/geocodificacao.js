// Geocodificacao de enderecos (CEP/endereco -> latitude e longitude) para a entrega por raio, com provedor plugavel por ambiente:
//   GEOCODER=simulado  tabela fixa de CEPs/enderecos de teste, sem rede (padrao em desenvolvimento; RECUSADO em producao)
//   GEOCODER=publico   BrasilAPI CEP v2 (coordenadas, quando existirem) + Nominatim/OpenStreetMap por endereco.
//                      Politica de uso do Nominatim: User-Agent que identifique a aplicacao e um contato (GEOCODER_USER_AGENT,
//                      OBRIGATORIA: sem ela o provedor fica desativado, nunca com agente generico), no maximo 1 requisicao por segundo
//                      no total (fila global) e cache de 30 dias. Sem consultas em massa.
//   GEOCODER=http      provedor pago generico (Google, Mapbox, OpenCage...): GEOCODER_URL com {q} e/ou {cep}, GEOCODER_HEADER
//                      ("Nome: valor"), GEOCODER_LAT_PATH e GEOCODER_LNG_PATH (caminho no JSON, ex.: results.0.geometry.lat).
// Falha, limite ou endereco nao encontrado NUNCA derruba o pedido: devolve { localizado: false } e o site pede o pino.
// O ambiente e lido a cada chamada (os testes trocam as variaveis).
const crypto = require('crypto');

const DIAS_CACHE = 30;
const HORAS_CACHE_NEGATIVO = 24;
const TIMEOUT_MS = 6000;

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// ---- tabela do provedor simulado (coordenadas aproximadas de pontos conhecidos de Sao Paulo e Rio) ----
const SIMULADO_CEPS = {
  '01001000': { lat: -23.55052, lng: -46.633308 }, // Praca da Se
  '01310100': { lat: -23.5614, lng: -46.6559 }, // Av. Paulista
  '04538133': { lat: -23.5845, lng: -46.6842 }, // Itaim Bibi
  '05001000': { lat: -23.5275, lng: -46.6788 }, // Perdizes/Barra Funda
  '03047000': { lat: -23.5444, lng: -46.6071 }, // Bras
  '20040020': { lat: -22.9035, lng: -43.1729 }, // Centro do Rio (bem longe)
};
const SIMULADO_ENDERECOS = {
  'rua teste|sao paulo': { lat: -23.5489, lng: -46.6388 },
};

// ---- fila global: no maximo 1 requisicao externa por segundo (intervalo minimo entre chamadas) ----
let ultimaChamada = 0;
let fila = Promise.resolve();
function intervaloMs() {
  const v = Number(process.env.GEOCODER_INTERVALO_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 1000; // nunca abaixo de 1 s (politica do Nominatim)
}
function naFila(fn) {
  const rodar = async () => {
    const espera = ultimaChamada + intervaloMs() - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimaChamada = Date.now();
    return fn();
  };
  const p = fila.then(rodar, rodar);
  fila = p.catch(() => {});
  return p;
}

async function buscarJson(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function caminho(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function provedorAtual() {
  const producao = process.env.NODE_ENV === 'production';
  let nome = String(process.env.GEOCODER || '').trim().toLowerCase();
  if (!nome) nome = producao ? 'nenhum' : 'simulado';
  return { nome, producao };
}

// Estado do provedor (sem segredos): { provedor, configurado, motivo }
function status() {
  const { nome, producao } = provedorAtual();
  if (nome === 'nenhum') return { provedor: 'nenhum', configurado: false, motivo: 'GEOCODER não configurado: o site pede o pino do cliente' };
  if (nome === 'simulado') return producao ? { provedor: 'simulado', configurado: false, motivo: 'o provedor simulado não é permitido em produção' } : { provedor: 'simulado', configurado: true, motivo: 'tabela fixa de testes (sem rede)' };
  if (nome === 'publico') {
    if (!String(process.env.GEOCODER_USER_AGENT || '').trim()) return { provedor: 'publico', configurado: false, motivo: 'GEOCODER_USER_AGENT ausente: obrigatório pela política do Nominatim (identifique a aplicação e um contato)' };
    return { provedor: 'publico', configurado: true, motivo: 'BrasilAPI + Nominatim (1 requisição por segundo, cache de 30 dias)' };
  }
  if (nome === 'http') {
    if (!process.env.GEOCODER_URL || !process.env.GEOCODER_LAT_PATH || !process.env.GEOCODER_LNG_PATH) return { provedor: 'http', configurado: false, motivo: 'GEOCODER_URL, GEOCODER_LAT_PATH e GEOCODER_LNG_PATH são obrigatórios' };
    return { provedor: 'http', configurado: true, motivo: 'provedor HTTP configurado' };
  }
  return { provedor: nome, configurado: false, motivo: `GEOCODER inválido: ${nome} (use simulado, publico ou http)` };
}

// Mapa de fundo (tiles) para o site e a gestao: o padrao e o do OpenStreetMap (so para desenvolvimento e baixo trafego).
function configMapa() {
  const url = String(process.env.MAPA_TILES_URL || '').trim() || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const atribuicao = String(process.env.MAPA_ATRIBUICAO || '').trim() || '© colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  return { tiles_url: url, atribuicao, padrao: !String(process.env.MAPA_TILES_URL || '').trim() };
}

// ---- consulta ao provedor (sem cache) ----
async function consultarProvedor(q) {
  const { nome } = provedorAtual();
  if (nome === 'simulado') {
    if (q.cep && SIMULADO_CEPS[q.cep]) return { ...SIMULADO_CEPS[q.cep], origem: 'cep', precisao: 'cep' };
    const digitos = soDigitos(q.texto);
    if (q.texto && digitos.length === 8 && SIMULADO_CEPS[digitos]) return { ...SIMULADO_CEPS[digitos], origem: 'cep', precisao: 'cep' };
    const chave = q.texto ? Object.keys(SIMULADO_ENDERECOS).find((k) => semAcento(q.texto).includes(k.split('|')[0]) && semAcento(q.texto).includes(k.split('|')[1])) : `${semAcento(q.logradouro)}|${semAcento(q.cidade)}`;
    if (chave && SIMULADO_ENDERECOS[chave]) return { ...SIMULADO_ENDERECOS[chave], origem: 'endereco', precisao: 'endereco' };
    return null;
  }
  if (nome === 'publico') {
    const ua = String(process.env.GEOCODER_USER_AGENT || '').trim();
    if (q.cep) {
      const base = process.env.GEOCODER_BRASILAPI_URL || 'https://brasilapi.com.br/api/cep/v2';
      const j = await naFila(() => buscarJson(`${base}/${q.cep}`, { 'user-agent': ua }));
      const c = j && j.location && j.location.coordinates;
      if (c && Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude))) return { lat: Number(c.latitude), lng: Number(c.longitude), origem: 'cep', precisao: 'cep' };
    }
    if ((q.logradouro && q.cidade) || q.texto) {
      const base = process.env.GEOCODER_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
      const texto = q.texto || [q.logradouro, q.numero, q.bairro, q.cidade, q.uf, 'Brasil'].filter(Boolean).join(', ');
      const j = await naFila(() => buscarJson(`${base}?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(texto)}`, { 'user-agent': ua }));
      const r = Array.isArray(j) ? j[0] : null;
      if (r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))) return { lat: Number(r.lat), lng: Number(r.lon), origem: 'endereco', precisao: 'endereco' };
    }
    return null;
  }
  if (nome === 'http') {
    const texto = q.texto || [q.logradouro, q.numero, q.bairro, q.cidade, q.uf, q.cep].filter(Boolean).join(', ');
    const url = String(process.env.GEOCODER_URL).replace('{q}', encodeURIComponent(texto)).replace('{cep}', encodeURIComponent(q.cep || ''));
    const cab = {};
    const h = String(process.env.GEOCODER_HEADER || '');
    const i = h.indexOf(':');
    if (i > 0) cab[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    const j = await naFila(() => buscarJson(url, cab));
    const lat = Number(caminho(j, process.env.GEOCODER_LAT_PATH));
    const lng = Number(caminho(j, process.env.GEOCODER_LNG_PATH));
    if (j && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, origem: q.logradouro ? 'endereco' : 'cep', precisao: 'provedor' };
    return null;
  }
  return null;
}

function normalizarConsulta(e) {
  return {
    cep: soDigitos(e.cep).slice(0, 8),
    numero: String(e.numero || '').trim().slice(0, 20),
    logradouro: String(e.logradouro || '').trim().slice(0, 120),
    bairro: String(e.bairro || '').trim().slice(0, 80),
    cidade: String(e.cidade || '').trim().slice(0, 80),
    uf: String(e.uf || '').trim().slice(0, 2).toUpperCase(),
    texto: String(e.texto || '').trim().slice(0, 200), // busca livre (gestao: "Rua X, 100, Cidade")
  };
}

// Localiza um endereco. db: pool/cliente do PostgreSQL (cache). Devolve { localizado, lat, lng, origem, precisao, cache }.
// Nunca lanca por falha do provedor.
async function geocodificar(db, entrada) {
  const nao = { localizado: false, lat: null, lng: null, origem: null, precisao: null, cache: false };
  const q = normalizarConsulta(entrada || {});
  if (q.cep.length !== 8 && !(q.logradouro && q.cidade) && q.texto.length < 5) return nao;
  if (q.texto && soDigitos(q.texto).length === 8 && !q.cep) q.cep = soDigitos(q.texto);
  const st = status();
  if (!st.configurado) return nao;
  const consulta = [q.cep, q.numero, semAcento(q.logradouro), semAcento(q.bairro), semAcento(q.cidade), q.uf.toLowerCase(), semAcento(q.texto)].join('|');
  const chave = crypto.createHash('sha256').update(`${st.provedor}:${consulta}`).digest('hex');
  try {
    const c = (await db.query(
      `SELECT lat, lng, precisao, criado_em FROM geo_cache WHERE chave_hash = $1 AND criado_em > now() - make_interval(hours => CASE WHEN lat IS NULL THEN $2 ELSE $3 END)`,
      [chave, HORAS_CACHE_NEGATIVO, DIAS_CACHE * 24]
    )).rows[0];
    if (c) return c.lat === null ? { ...nao, cache: true } : { localizado: true, lat: Number(c.lat), lng: Number(c.lng), origem: c.precisao === 'cep' ? 'cep' : 'endereco', precisao: c.precisao, cache: true };
  } catch { /* cache indisponivel: segue sem ele */ }
  let r = null;
  try { r = await consultarProvedor(q); } catch { r = null; }
  try {
    await db.query(
      `INSERT INTO geo_cache (chave_hash, consulta, lat, lng, precisao, provedor) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chave_hash) DO UPDATE SET lat = $3, lng = $4, precisao = $5, provedor = $6, criado_em = now()`,
      [chave, consulta.slice(0, 300), r ? r.lat : null, r ? r.lng : null, r ? r.precisao : null, st.provedor]
    );
  } catch { /* idem */ }
  return r ? { localizado: true, lat: r.lat, lng: r.lng, origem: r.origem, precisao: r.precisao, cache: false } : nao;
}

// Limpa o cache vencido (chamada periodica barata; nao ha dados pessoais alem do texto do endereco).
async function limparCache(db) {
  const r = await db.query(`DELETE FROM geo_cache WHERE (lat IS NOT NULL AND criado_em < now() - make_interval(days => $1)) OR (lat IS NULL AND criado_em < now() - make_interval(hours => $2))`, [DIAS_CACHE, HORAS_CACHE_NEGATIVO]);
  return r.rowCount;
}

module.exports = { geocodificar, status, configMapa, limparCache, normalizarConsulta, SIMULADO_CEPS };
