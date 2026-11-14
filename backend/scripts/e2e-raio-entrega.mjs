// e2e: entrega por raio na loja virtual (mapa, faixas de taxa por distancia, pino do cliente, geocodificacao com cache e limite).
//   node scripts/e2e-raio-entrega.mjs   (API em http://localhost:3000 com GEOCODER=simulado; banco NOVO: npm run migrate && npm run seed)
// Usa a empresa do seed (admin@girostock.local) e uma empresa extra para o isolamento.
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raizBackend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const raio = require('../src/services/raio.js');
const B = process.env.API_URL || 'http://localhost:3000';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 500)}`); } };
async function req(method, url, body, headers = {}) {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined || body === null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const api = (m, r, b, tok) => req(m, `${B}/api${r}`, b, tok ? { authorization: `Bearer ${tok}` } : {});
let CHAVE = null;
const IP = () => ({ 'x-teste-ip': `e2e-${crypto.randomUUID()}` });
const loja = (m, r, b, tok) => req(m, `${B}/api/loja/v1${r}`, b, { ...(CHAVE ? { 'x-loja-chave': CHAVE } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...IP() });
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SE = { lat: -23.55052, lng: -46.633308 }; // loja de teste: Praca da Se
const kmLat = 111.19508;
const ponto = (km, origem = 'pino') => ({ lat: Number((SE.lat + km / kmLat).toFixed(6)), lng: SE.lng, origem });

// ---------------------------------------------------------------------------------------------------
console.log('\n# 1. Haversine e decisao (funcao pura)');
const lojaT = { loja_lat: SE.lat, loja_lng: SE.lng, raio_km: 5, raio_usa_faixas: true, raio_taxa_unica: 6, raio_margem_pino_m: 500 };
const fx = [{ ate_km: 2, taxa: 4, tempo_extra_min: 0 }, { ate_km: 5, taxa: 8, tempo_extra_min: 10 }];
check('1 km norte = 1.000 m; 5 km = 5.000 m (metros inteiros, sem erro de ponto flutuante)', raio.distanciaMetros(SE, ponto(1)) === 1000 && raio.distanciaMetros(SE, ponto(5)) === 5000 && raio.distanciaMetros(SE, SE) === 0);
check('distancia real conhecida: Se -> Paulista ~2,6 km (Haversine)', Math.abs(raio.distanciaMetros(SE, { lat: -23.5614, lng: -46.6559 }) - 2601) <= 1);
const a = (km, o, loj = lojaT, f = fx) => raio.avaliarRaio(loj, f, ponto(km, o));
check('pino: exatamente 5.000 m ATENDE (borda inclusiva) e 5.001 m = fora', a(5, 'pino').status === 'atende' && raio.avaliarRaio(lojaT, fx, { lat: SE.lat + 5001 / 111195.08, lng: SE.lng, origem: 'pino' }).status === 'fora');
check('CEP: 5.000 m dentro da margem -> confirmar_pino; 5.200 m -> confirmar_pino; 5.600 m -> fora', a(5, 'cep').status === 'confirmar_pino' && a(5.2, 'cep').status === 'confirmar_pino' && a(5.6, 'cep').status === 'fora');
check('CEP: 4.400 m (fora da margem) atende; 4.500 m (borda da margem) pede pino', a(4.4, 'cep').status === 'atende' && a(4.5, 'cep').status === 'confirmar_pino');
check('faixas: 1 km -> ate 2 (R$ 4,00); 3 km -> ate 5 (R$ 8,00, +10 min); 2 km exatos -> faixa 1 (borda inclusiva)', a(1, 'cep').taxa === 4 && a(1, 'cep').faixa_ate_km === 2 && a(3, 'cep').taxa === 8 && a(3, 'cep').tempo_extra_min === 10 && a(2, 'cep').faixa_ate_km === 2);
check('sem faixas (taxa unica): usa raio_taxa_unica', a(3, 'cep', { ...lojaT, raio_usa_faixas: false }).taxa === 6 && a(3, 'cep', lojaT, []).taxa === 6);
check('margem 0 desliga o "perto do limite": 4.999 m atende, 5.001 m fora, 5.000 m atende', a(4.999, 'cep', { ...lojaT, raio_margem_pino_m: 0 }).status === 'atende' && a(5, 'cep', { ...lojaT, raio_margem_pino_m: 0 }).status === 'atende' && a(5.001, 'cep', { ...lojaT, raio_margem_pino_m: 0 }).status === 'fora');
check('sem coordenadas (nao localizado) -> pedir_pino', raio.avaliarRaio(lojaT, fx, { lat: null, lng: null }).status === 'pedir_pino' && raio.avaliarRaio(lojaT, fx, null).status === 'pedir_pino');
const invalida = (lat, lng) => { try { raio.avaliarRaio(lojaT, fx, { lat, lng, origem: 'pino' }); return null; } catch (e) { return e.status; } };
check('coordenadas fora do Brasil -> 400 (Lisboa, polo, texto)', invalida(38.7, -9.1) === 400 && invalida(-23.5, 10) === 400 && invalida('abc', 'x') === 400);
check('validarFaixas: crescentes, ultima = raio, taxa >= 0, repetida -> 409', (() => {
  const ok = raio.validarFaixas(5, fx).length === 2;
  const err = (f, r = 5) => { try { raio.validarFaixas(r, f); return null; } catch (e) { return e.status; } };
  return ok && err([{ ate_km: 2, taxa: 4 }, { ate_km: 4, taxa: 8 }]) === 400 && err([{ ate_km: 5, taxa: 4 }, { ate_km: 2, taxa: 8 }]) === 400 && err([{ ate_km: 2, taxa: -1 }, { ate_km: 5, taxa: 8 }]) === 400
    && err([{ ate_km: 2, taxa: 4 }, { ate_km: 2, taxa: 5 }, { ate_km: 5, taxa: 8 }]) === 409 && err([{ ate_km: 0, taxa: 4 }, { ate_km: 5, taxa: 8 }]) === 400 && err([]) === 400;
})());
check('ajustar faixas ao raio: encolher (3 km) e crescer (8 km)', JSON.stringify(raio.ajustarFaixasAoRaio(3, fx).map((f) => f.ate_km)) === '[2,3]' && JSON.stringify(raio.ajustarFaixasAoRaio(8, fx).map((f) => f.ate_km)) === '[2,8]');

// ---------------------------------------------------------------------------------------------------
console.log('\n# Preparo');
const SENHA_MASTER = rnd();
spawnSync('node', ['scripts/master.js'], { cwd: raizBackend, env: { ...process.env, MASTER_EMAIL: 'e2e.raio.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E Raio Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.raio.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const REFRI = (await api('GET', '/products', null, A)).j.find((p) => p.codigo_interno === 'PRD-0001');
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: true, pedidos: true } }, MAS);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
await api('PATCH', `/locations/${L.Lanchonete}`, { usa_pedidos: true }, A);
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 40, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'e2e raio' }, A);
const cfgBase = await api('PUT', '/loja-virtual', { location_id: L.Lanchonete, nome: 'Lanchonete Raio', aceita_entrega: true, aceita_retirada: true, tempo_preparo_min: 20, tempo_entrega_min: 30, pagamentos: { pix_online: false, cartao_online: false, na_entrega: ['dinheiro', 'pix'] }, horarios: {}, endereco: 'Praca da Se, Sao Paulo' }, A);
check('configuracao base da loja (entrega e retirada)', cfgBase.s === 200, cfgBase);
await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { publicado: true }, A);
const k = await api('POST', '/loja-virtual/chave', null, A);
CHAVE = k.j.chave;
check('publica a loja e gera a chave da API', (await api('PUT', '/loja-virtual', { publicada: true }, A)).s === 200 && !!CHAVE);
const cad = await loja('POST', '/conta/cadastro', { nome: 'Cliente Raio', email: `raio.${Date.now()}@teste.com`, telefone: '11955550001', senha: 'Senha1234' });
const TM = cad.j.token;
check('conta de cliente criada', cad.s === 201 && !!TM, cad);
const ITENS = [{ product_id: REFRI.id, quantidade: 2 }];
const PAG = { quando: 'entrega', forma: 'dinheiro' };

// ---------------------------------------------------------------------------------------------------
console.log('\n# 2. Configuracao (gestao)');
const g0 = await api('GET', '/loja-virtual/raio', null, A);
check('padrao: modo bairro, sem local, mapa com atribuicao e provedor simulado', g0.s === 200 && g0.j.modo === 'bairro' && g0.j.loja.lat === null && /openstreetmap/i.test(g0.j.mapa.atribuicao) && g0.j.geocodificador.provedor === 'simulado', g0.j);
check('sem coordenadas da loja NAO ativa o modo raio (400)', (await api('PUT', '/loja-virtual/raio', { entrega_modo: 'raio', raio_km: 5 }, A)).s === 400);
check('so quem tem a area LojaVirtual: gerente -> 403; sem token -> 401', await (async () => {
  const em = `ger.raio.${Date.now()}@girostock.local`; const r = await api('POST', '/users', { nome: 'Gerente Raio', email: em, senha: 'Senha123!', perfil: 'Gerente' }, A);
  const G = (await api('POST', '/auth/login', { email: em, senha: 'Senha123!' })).j.token;
  return r.s === 201 && (await api('GET', '/loja-virtual/raio', null, G)).s === 403 && (await api('PUT', '/loja-virtual/raio', { raio_km: 3 }, G)).s === 403 && (await api('GET', '/loja-virtual/raio')).s === 401;
})());
check('coordenadas fora do Brasil -> 400', (await api('PUT', '/loja-virtual/raio', { loja_lat: 38.7, loja_lng: -9.1 }, A)).s === 400);
check('raio 0, 61 e texto -> 400', (await api('PUT', '/loja-virtual/raio', { raio_km: 0 }, A)).s === 400 && (await api('PUT', '/loja-virtual/raio', { raio_km: 61 }, A)).s === 400 && (await api('PUT', '/loja-virtual/raio', { raio_km: 'x' }, A)).s === 400);
check('faixas invalidas: ultima diferente do raio (400), decrescentes (400), taxa negativa (400), ate_km repetido (409)', await (async () => {
  const p = (f) => api('PUT', '/loja-virtual/raio', { loja_lat: SE.lat, loja_lng: SE.lng, raio_km: 5, faixas: f }, A);
  return (await p([{ ate_km: 2, taxa: 4 }, { ate_km: 4, taxa: 8 }])).s === 400 && (await p([{ ate_km: 5, taxa: 4 }, { ate_km: 2, taxa: 8 }])).s === 400
    && (await p([{ ate_km: 2, taxa: -1 }, { ate_km: 5, taxa: 8 }])).s === 400 && (await p([{ ate_km: 2, taxa: 4 }, { ate_km: 2, taxa: 5 }, { ate_km: 5, taxa: 8 }])).s === 409;
})());
const s1 = await api('PUT', '/loja-virtual/raio', { entrega_modo: 'raio', loja_lat: SE.lat, loja_lng: SE.lng, raio_km: 5, raio_margem_pino_m: 500, raio_usa_faixas: true, faixas: [{ ate_km: 2, taxa: 4, tempo_extra_min: 0 }, { ate_km: 5, taxa: 8, tempo_extra_min: 10 }] }, A);
check('salva modo raio, local, raio 5 km, margem 500 m e 2 faixas', s1.s === 200 && s1.j.modo === 'raio' && s1.j.raio_km === 5 && s1.j.faixas.length === 2 && s1.j.faixas[1].ate_km === 5 && s1.j.margem_pino_m === 500, s1);
const s2 = await api('PUT', '/loja-virtual/raio', { raio_km: 3 }, A);
check('mudar o raio (sem mandar faixas) REAJUSTA a ultima faixa (5 -> 3 km)', s2.s === 200 && s2.j.faixas.map((f) => f.ate_km).join() === '2,3' && s2.j.faixas[1].taxa === 8, s2.j.faixas);
const s3 = await api('PUT', '/loja-virtual/raio', { raio_km: 5, faixas: [{ ate_km: 2, taxa: 4, tempo_extra_min: 0 }, { ate_km: 5, taxa: 8, tempo_extra_min: 10 }] }, A);
check('volta para 5 km com as duas faixas', s3.s === 200 && s3.j.faixas.map((f) => f.ate_km).join() === '2,5');
const aud = (await prod.query(`SELECT detalhes FROM audit_logs WHERE tenant_id = $1 AND acao = 'loja_virtual_raio' ORDER BY criado_em DESC LIMIT 1`, [empresa])).rows[0];
check('auditoria registra antes e depois', !!aud && aud.detalhes.antes && aud.detalhes.depois && aud.detalhes.depois.raio_km === 5 && aud.detalhes.depois.faixas.length === 2, aud);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 3. API publica: loja, localizar e previa do carrinho');
const pub = await loja('GET', '/loja');
check('GET /loja no modo raio: modo, raio, faixas com tempo estimado, margem, posicao da loja e mapa (sem bairros)', pub.s === 200 && pub.j.entrega.modo === 'raio' && pub.j.entrega.raio_km === 5 && pub.j.entrega.faixas.length === 2 && pub.j.entrega.faixas[1].tempo_estimado_min === 60 && pub.j.entrega.margem_pino_m === 500
  && Math.abs(pub.j.entrega.loja.lat - SE.lat) < 1e-6 && pub.j.entrega.mapa.tiles_url && pub.j.entrega.mapa.atribuicao && pub.j.entrega.bairros.length === 0, pub.j.entrega);
const loc = (b) => loja('POST', '/entrega/localizar', b);
const l1 = await loc({ cep: '01002-000', numero: '10' });
check('CEP a 1 km: localizado, atende, faixa ate 2 km, taxa 4,00', l1.s === 200 && l1.j.localizado && l1.j.status === 'atende' && l1.j.taxa === 4 && l1.j.faixa_ate_km === 2 && l1.j.origem === 'cep' && l1.j.distancia_km === 1, l1);
const l2 = await loc({ cep: '01310100', numero: '1000' });
check('CEP a 2,6 km: faixa ate 5 km, taxa 8,00 e +10 min (60 min)', l2.j.status === 'atende' && l2.j.taxa === 8 && l2.j.tempo_estimado_min === 60, l2.j);
const l3 = await loc({ cep: '02001000' });
check('CEP a 4,8 km (perto do limite): status confirmar_pino', l3.j.status === 'confirmar_pino' && l3.j.localizado === true, l3.j);
const l4 = await loc({ cep: '02003000' });
check('CEP a 8 km: fora da area', l4.j.status === 'fora' && l4.j.taxa === null, l4.j);
const l5 = await loc({ cep: '99999-999' });
check('CEP desconhecido: nao localizado -> pedir_pino', l5.j.localizado === false && l5.j.status === 'pedir_pino', l5.j);
check('CEP invalido -> 400; loja em modo bairro -> 409 (verificado adiante)', (await loc({ cep: '123' })).s === 400);
const lim = []; for (let i = 0; i < 45; i++) lim.push((await req('POST', `${B}/api/loja/v1/entrega/localizar`, { cep: '01002000' }, { 'x-loja-chave': CHAVE, 'x-teste-ip': 'ip-fixo-e2e' })).s);
check('limite de requisicoes por IP no localizar (429 depois de 40)', lim.slice(0, 40).every((s) => s === 200) && lim.slice(40).some((s) => s === 429), lim.join());
const cp1 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '01002000', entrega: { lat: ponto(1).lat, lng: ponto(1).lng, origem: 'cep' } });
check('previa do carrinho: taxa 4,00 pela faixa 1 (subtotal + taxa = total)', cp1.s === 200 && cp1.j.taxa_entrega === 4 && cp1.j.raio.status === 'atende' && Math.abs(cp1.j.total - (cp1.j.subtotal + 4)) < 0.005, cp1.j);
const cp2 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '01002000', taxa_entrega: 0, entrega: { lat: ponto(3).lat, lng: ponto(3).lng, origem: 'cep', taxa: 0, faixa_ate_km: 2, distancia_km: 0.1 }, taxa: 0 });
check('SERVIDOR E A VERDADE: taxa/faixa/distancia adulteradas no corpo sao ignoradas (3 km = faixa 5 km, R$ 8,00)', cp2.j.taxa_entrega === 8 && cp2.j.raio.faixa_ate_km === 5 && cp2.j.raio.distancia_km === 3, cp2.j);
const cp3 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '02003000', entrega: { lat: ponto(8).lat, lng: ponto(8).lng, origem: 'cep' } });
check('previa fora da area: aviso e nao pode finalizar', cp3.j.pode_finalizar === false && cp3.j.avisos.some((x) => /fora da área/.test(x)) && cp3.j.raio.status === 'fora', cp3.j);
const cp4 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '02001000', entrega: { lat: ponto(4.8).lat, lng: ponto(4.8).lng, origem: 'cep' } });
check('previa perto do limite com origem CEP: pede o pino (nao finaliza)', cp4.j.pode_finalizar === false && cp4.j.raio.status === 'confirmar_pino' && cp4.j.avisos.some((x) => /confirme o local/.test(x)), cp4.j);
check('previa com o pino confirmado (4,8 km): atende, taxa 8,00', (await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '02001000', entrega: { ...ponto(4.8), origem: 'pino' } })).j.taxa_entrega === 8);
check('coordenadas invalidas na previa -> 400', (await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', cep: '02001000', entrega: { lat: 38.7, lng: -9.1, origem: 'pino' } })).s === 400);
check('retirada nunca depende do raio (mesmo com ponto fora)', (await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada', entrega: { lat: ponto(30).lat, lng: ponto(30).lng, origem: 'pino' } })).j.pode_finalizar === true);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 4. Pedido ponta a ponta');
const endereco = (b) => loja('POST', '/conta/enderecos', { rotulo: 'Casa', logradouro: 'Rua Qualquer', numero: '10', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP', ...b }, TM);
const E1 = (await endereco({ cep: '01002-000' })).j;
check('endereco salvo guarda as coordenadas geocodificadas (origem cep)', E1.lat !== null && E1.coord_origem === 'cep' && Math.abs(Number(E1.lat) - ponto(1).lat) < 1e-4, E1);
const pedido = (b) => loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', pagamento: PAG, ...b }, TM);
const p1 = await pedido({ endereco_id: E1.id, taxa_entrega: 0, entrega_faixa_ate_km: 99 });
check('dentro da faixa 1 (1 km): 201, taxa 4,00 (taxa/faixa adulteradas ignoradas)', p1.s === 201 && p1.j.taxa_entrega === 4, p1);
const o1 = (await prod.query(`SELECT taxa_entrega, entrega_lat, entrega_lng, entrega_distancia_km, entrega_faixa_ate_km, entrega_coord_origem, entrega_aviso, origem FROM orders WHERE id = $1`, [p1.j.id])).rows[0];
check('o pedido grava distancia 1,00 km, faixa 2 km, origem cep, taxa 4,00 e sem aviso', Number(o1.entrega_distancia_km) === 1 && Number(o1.entrega_faixa_ate_km) === 2 && o1.entrega_coord_origem === 'cep' && Number(o1.taxa_entrega) === 4 && o1.entrega_aviso === null && o1.entrega_lat !== null, o1);
const E2 = (await endereco({ cep: '01310100', numero: '1000' })).j;
const p2 = await pedido({ endereco_id: E2.id });
check('dentro da faixa 2 (2,6 km): taxa 8,00 e faixa 5 km gravadas', p2.s === 201 && p2.j.taxa_entrega === 8 && Number((await prod.query(`SELECT entrega_faixa_ate_km FROM orders WHERE id = $1`, [p2.j.id])).rows[0].entrega_faixa_ate_km) === 5, p2);
const E3 = (await endereco({ cep: '02001000' })).j;
const p3 = await pedido({ endereco_id: E3.id });
check('perto do limite (CEP, 4,8 km) sem pino -> 422 com status confirmar_pino', p3.s === 422 && p3.j.status === 'confirmar_pino', p3);
const p4 = await pedido({ endereco_id: E3.id, entrega: { ...ponto(4.8), origem: 'pino' } });
check('perto do limite -> pino dentro (4,8 km): atende, origem pino', p4.s === 201 && p4.j.taxa_entrega === 8 && (await prod.query(`SELECT entrega_coord_origem FROM orders WHERE id = $1`, [p4.j.id])).rows[0].entrega_coord_origem === 'pino', p4);
const E3b = (await loja('GET', '/conta/enderecos', null, TM)).j.find((e) => e.id === E3.id);
check('o pino confirmado fica no endereco salvo (cliente recorrente nao marca de novo)', E3b.coord_origem === 'pino' && Math.abs(Number(E3b.lat) - ponto(4.8).lat) < 1e-4, E3b);
const p4b = await pedido({ endereco_id: E3.id });
check('segundo pedido no mesmo endereco usa o pino salvo (201, sem pedir de novo)', p4b.s === 201, p4b);
const E4 = (await endereco({ cep: '02002000' })).j;
const p5 = await pedido({ endereco_id: E4.id, entrega: { ...ponto(5.3), origem: 'pino' } });
check('perto do limite -> pino FORA do raio (5,3 km): 422 fora da area (sugere retirada)', p5.s === 422 && /fora da área/.test(p5.j.erro) && p5.j.status === 'fora', p5);
const E5 = (await endereco({ cep: '02003000' })).j;
const p6 = await pedido({ endereco_id: E5.id });
check('CEP a 8 km: 422 fora da area', p6.s === 422 && p6.j.status === 'fora', p6);
const E6 = (await endereco({ cep: '99999-999' })).j;
const p7 = await pedido({ endereco_id: E6.id });
check('endereco nao localizado sem pino: 422 pedir_pino', p7.s === 422 && p7.j.status === 'pedir_pino', p7);
const p8 = await pedido({ endereco_id: E6.id, entrega: { ...ponto(2), origem: 'pino' } });
check('endereco nao localizado + pino dentro (2 km): atende; sem referencia do endereco, sem aviso', p8.s === 201 && (await prod.query(`SELECT entrega_aviso, entrega_coord_origem FROM orders WHERE id = $1`, [p8.j.id])).rows[0].entrega_aviso === null, p8);
// antifraude: coordenadas "de CEP" adulteradas para dentro do raio nao valem como CEP
const E7 = (await endereco({ cep: '02003000', logradouro: 'Rua Longe' })).j; // geocodifica a 8 km
const p9 = await pedido({ endereco_id: E7.id, entrega: { ...ponto(1), origem: 'cep' } });
check('coordenadas adulteradas com origem "cep" (1 km) para um endereco a 8 km: valem so como PINO e gravam aviso', p9.s === 201, p9);
const o9 = (await prod.query(`SELECT entrega_coord_origem, entrega_aviso FROM orders WHERE id = $1`, [p9.j.id])).rows[0];
check('origem gravada = pino e entrega_aviso informa a distancia (> 3 km) do endereco informado', o9.entrega_coord_origem === 'pino' && /pino distante do endereço informado \(7[,.]0 km\)/.test(o9.entrega_aviso || ''), o9);
const p10 = await pedido({ endereco_id: E1.id, entrega: { lat: 38.7, lng: -9.1, origem: 'pino' } });
check('coordenadas invalidas no pedido -> 400', p10.s === 400, p10);
const p11 = await pedido({ endereco_id: E1.id, entrega: { ...ponto(1), origem: 'pino' } });
check('pino bem perto do endereco (sem aviso) e aceito', p11.s === 201 && (await prod.query(`SELECT entrega_aviso FROM orders WHERE id = $1`, [p11.j.id])).rows[0].entrega_aviso === null, p11);
const ret = await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: PAG, entrega: { ...ponto(40), origem: 'pino' } }, TM);
check('retirada nao depende do raio (201)', ret.s === 201, ret);
const ped = await prod.query(`SELECT o.taxa_entrega, o.origem FROM orders o WHERE o.id = $1`, [p2.j.id]);
check('a taxa da entrega por raio esta no pedido (vai para a venda/relatorios como taxa_entrega)', Number(ped.rows[0].taxa_entrega) === 8 && ped.rows[0].origem === 'loja_virtual');
const lst = await api('GET', '/orders?origem=loja_virtual', null, A);
const itemPedido = Array.isArray(lst.j) ? lst.j.find((o) => o.id === p9.j.id) : null;
check('Pedidos (operador): linha de entrega com distancia, faixa, origem, aviso e link do mapa', !!itemPedido && itemPedido.entrega_distancia_km !== undefined && /pino/.test(String(itemPedido.entrega_coord_origem)) && !!itemPedido.entrega_aviso, itemPedido);
const e1p = await loja('PUT', `/conta/enderecos/${E1.id}`, { cep: '02002-000' }, TM);
check('editar o endereco recalcula as coordenadas (CEP novo a 5,3 km)', e1p.s === 200 && e1p.j.coord_origem === 'cep' && Math.abs(Number(e1p.j.lat) - ponto(5.3).lat) < 1e-4, e1p);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 5. Geocodificacao (cache, limite de 1 req/s, User-Agent, simulado em producao)');
const geo = require('../src/services/geocodificacao.js');
const amb = { ...process.env };
const restaurar = () => { for (const k of ['GEOCODER', 'GEOCODER_USER_AGENT', 'GEOCODER_URL', 'GEOCODER_HEADER', 'GEOCODER_LAT_PATH', 'GEOCODER_LNG_PATH', 'GEOCODER_BRASILAPI_URL', 'GEOCODER_NOMINATIM_URL', 'NODE_ENV']) { if (amb[k] === undefined) delete process.env[k]; else process.env[k] = amb[k]; } };
const chamadas = []; let modoFalha = false;
const srv = http.createServer((rq, rs) => {
  chamadas.push({ t: Date.now(), url: rq.url, ua: rq.headers['user-agent'] || null, auth: rq.headers.authorization || null });
  if (modoFalha) { rs.statusCode = 500; return rs.end('erro'); }
  const u = new URL(rq.url, 'http://x');
  rs.setHeader('content-type', 'application/json');
  if (u.pathname.startsWith('/brasilapi/')) return rs.end(JSON.stringify({ cep: u.pathname.split('/').pop(), location: { coordinates: { latitude: '-23.5489', longitude: '-46.6388' } } }));
  if (u.pathname === '/nominatim') return rs.end(JSON.stringify([{ lat: '-23.55', lon: '-46.63' }]));
  return rs.end(JSON.stringify({ results: [{ geometry: { lat: -23.56, lng: -46.65 } }] }));
});
await new Promise((r) => srv.listen(0, r));
const PORTA = srv.address().port;
const novaConsulta = () => ({ cep: String(Math.floor(10000000 + Math.random() * 89999999)) });
process.env.GEOCODER = 'http'; process.env.GEOCODER_URL = `http://127.0.0.1:${PORTA}/geo?q={q}&cep={cep}`; process.env.GEOCODER_HEADER = 'Authorization: Bearer segredo-do-teste'; process.env.GEOCODER_LAT_PATH = 'results.0.geometry.lat'; process.env.GEOCODER_LNG_PATH = 'results.0.geometry.lng';
const st = geo.status();
check('provedor http configurado: status sem segredos', st.configurado && st.provedor === 'http' && !JSON.stringify(st).includes('segredo-do-teste'), st);
const ini = Date.now();
const rajada = await Promise.all([1, 2, 3, 4].map(() => geo.geocodificar(prod, novaConsulta())));
const ts = chamadas.filter((c) => c.url.startsWith('/geo')).map((c) => c.t).sort((x, y) => x - y);
check('rajada de 4 consultas: todas localizadas e NUNCA mais de 1 requisicao por segundo ao provedor', rajada.every((r) => r.localizado && !r.cache) && ts.length === 4 && ts.slice(1).every((t, i) => t - ts[i] >= 980), ts.slice(1).map((t, i) => t - ts[i]));
check('cabecalho do provedor pago (Authorization) enviado so pelo servidor', chamadas[0].auth === 'Bearer segredo-do-teste');
const q1 = novaConsulta();
const antes = chamadas.length;
const r1 = await geo.geocodificar(prod, q1); const r2 = await geo.geocodificar(prod, q1);
check('CACHE: a segunda consulta igual nao chama o provedor', chamadas.length === antes + 1 && r1.cache === false && r2.cache === true && r2.localizado && Math.abs(r2.lat - r1.lat) < 1e-9, [chamadas.length - antes, r1.cache, r2.cache]);
const nCache = Number((await prod.query(`SELECT count(*) AS n FROM geo_cache WHERE lat IS NOT NULL`)).rows[0].n);
check('cache em geo_cache guarda so o texto consultado (sem tenant nem dados pessoais)', nCache >= 5 && (await prod.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'geo_cache'`)).rows.every((c) => !/tenant|conta|cliente|nome|telefone/.test(c.column_name)));
modoFalha = true;
const rf = await geo.geocodificar(prod, novaConsulta());
check('falha do provedor (HTTP 500): devolve nao localizado, sem lancar (o site pede o pino)', rf.localizado === false);
modoFalha = false;
process.env.GEOCODER = 'publico'; delete process.env.GEOCODER_USER_AGENT;
const stp = geo.status(); const antesUa = chamadas.length;
const rsem = await geo.geocodificar(prod, novaConsulta());
check('GEOCODER=publico SEM GEOCODER_USER_AGENT: desativado com status claro e NENHUMA chamada', !stp.configurado && /GEOCODER_USER_AGENT/.test(stp.motivo) && rsem.localizado === false && chamadas.length === antesUa, stp);
process.env.GEOCODER_USER_AGENT = 'GiroStock-Entrega/1.0 (contato@exemplo.com.br)'; process.env.GEOCODER_BRASILAPI_URL = `http://127.0.0.1:${PORTA}/brasilapi`; process.env.GEOCODER_NOMINATIM_URL = `http://127.0.0.1:${PORTA}/nominatim`;
const rp = await geo.geocodificar(prod, novaConsulta());
const cUa = chamadas[chamadas.length - 1];
check('GEOCODER=publico com User-Agent identificado: BrasilAPI responde e o User-Agent vai na requisicao (nunca generico)', geo.status().configurado && rp.localizado && cUa.ua === 'GiroStock-Entrega/1.0 (contato@exemplo.com.br)', [geo.status(), cUa]);
const rn = await geo.geocodificar(prod, { logradouro: 'Rua Sem CEP', cidade: 'Sao Paulo', uf: 'SP', numero: String(Date.now()).slice(-5) });
check('publico: por endereco usa o Nominatim (origem endereco) com o mesmo User-Agent', rn.localizado && rn.origem === 'endereco' && chamadas[chamadas.length - 1].url.startsWith('/nominatim') && chamadas[chamadas.length - 1].ua.startsWith('GiroStock-Entrega'), [rn, chamadas[chamadas.length - 1]]);
process.env.GEOCODER = 'simulado'; process.env.NODE_ENV = 'production';
const stProd = geo.status(); const rProd = await geo.geocodificar(prod, { cep: '01001000' });
check('provedor simulado RECUSADO com NODE_ENV=production', !stProd.configurado && /produção/.test(stProd.motivo) && rProd.localizado === false, stProd);
delete process.env.GEOCODER; process.env.NODE_ENV = 'production';
check('em producao sem GEOCODER: nenhum provedor (site pede o pino)', geo.status().provedor === 'nenhum' && geo.status().configurado === false);
restaurar();
srv.close();

// ---------------------------------------------------------------------------------------------------
console.log('\n# 6. Compatibilidade: modo bairro identico, retirada, cupom, pedido minimo');
await api('PUT', '/loja-virtual/raio', { entrega_modo: 'bairro' }, A);
check('voltar para bairro mantem a configuracao do raio salva', (await api('GET', '/loja-virtual/raio', null, A)).j.raio_km === 5);
const bPub = await loja('GET', '/loja');
check('GET /loja em modo bairro: entrega.modo = bairro, bairros e outros_bairros como antes', bPub.j.entrega.modo === 'bairro' && Array.isArray(bPub.j.entrega.bairros) && bPub.j.entrega.faixas === undefined && bPub.j.entrega.loja === undefined, bPub.j.entrega);
await api('POST', '/loja-virtual/regioes', { nome: 'Centro', taxa: 6, tempo_extra_min: 5, pedido_minimo: 10 }, A);
const cb = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', bairro: 'Centro', cidade: 'Sao Paulo' });
check('bairro cadastrado: taxa 6,00 e pedido minimo do bairro (como antes)', cb.j.taxa_entrega === 6 && cb.j.entrega.bairro === 'Centro' && cb.j.raio === null, cb.j);
const cb2 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', bairro: 'Lugar Nenhum' });
check('bairro nao atendido: aviso "nao fazemos entrega no bairro" (como antes)', cb2.j.pode_finalizar === false && cb2.j.avisos.some((x) => /não fazemos entrega no bairro/.test(x)), cb2.j);
check('em modo bairro o /entrega/localizar responde 409', (await loc({ cep: '01002000' })).s === 409);
const eB = (await endereco({ cep: '01002-000', bairro: 'Centro' })).j;
check('em modo bairro o endereco salvo nao e geocodificado (sem coordenadas)', eB.lat === null);
const pB = await loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', endereco_id: eB.id, pagamento: PAG }, TM);
check('pedido por bairro funciona como antes (taxa 6,00) e nao grava dados de raio', pB.s === 201 && pB.j.taxa_entrega === 6 && (await prod.query(`SELECT entrega_distancia_km, entrega_coord_origem FROM orders WHERE id = $1`, [pB.j.id])).rows[0].entrega_distancia_km === null, pB);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 7. Isolamento entre empresas e simulador da gestao');
const emB = `e2e.raio.b.${Date.now()}@girostock.local`;
const rb = await api('POST', '/master/empresas', { nome: `E2E Raio B ${Date.now().toString(36)}`, plano: 'completo', loja_nome: 'Loja B', admin: { nome: 'Admin B', email: emB } }, MAS);
const lgB = await api('POST', '/auth/login', { email: emB, senha: rb.j.senha_temporaria });
const novaB = rnd();
await api('POST', '/auth/change-password', { senha_atual: rb.j.senha_temporaria, nova_senha: novaB }, lgB.j.token);
await api('PATCH', `/master/empresas/${rb.j.empresa.id}`, { recursos: { loja_virtual: true, pedidos: true } }, MAS);
const TB = (await api('POST', '/auth/login', { email: emB, senha: novaB })).j.token;
check('outra empresa: configuracao de raio propria (modo bairro, sem local), nunca a da empresa A', (await api('GET', '/loja-virtual/raio', null, TB)).j.loja.lat === null && (await api('GET', '/loja-virtual/raio', null, TB)).j.raio_km === null);
const gB = await api('GET', '/loja-virtual/geocodificar?q=01002000', null, TB);
check('geocodificar na gestao devolve so coordenadas (nunca consultas de outro tenant)', gB.s === 200 && gB.j.localizado === true && Object.keys(gB.j).every((k2) => ['localizado', 'lat', 'lng', 'origem', 'geocodificador'].includes(k2)), gB.j);
check('gestao: texto curto -> 400', (await api('GET', '/loja-virtual/geocodificar?q=ab', null, A)).s === 400);
await api('PUT', '/loja-virtual/raio', { entrega_modo: 'raio' }, A);
const sm = await api('POST', '/loja-virtual/raio/simular', { ...ponto(3), origem: 'pino' }, A);
check('simulador usa a MESMA funcao: 3 km -> atende faixa 5 km, R$ 8,00, +10 min', sm.s === 200 && sm.j.status === 'atende' && sm.j.taxa === 8 && sm.j.faixa_ate_km === 5 && sm.j.distancia_km === 3, sm.j);
const sm2 = await api('POST', '/loja-virtual/raio/simular', { ...ponto(5.2), origem: 'cep' }, A);
check('simulador: 5,2 km pelo CEP -> perto do limite (confirmar pino)', sm2.j.status === 'confirmar_pino', sm2.j);
const sm3 = await api('POST', '/loja-virtual/raio/simular', { ...ponto(9), origem: 'pino' }, A);
check('simulador: 9 km -> fora', sm3.j.status === 'fora', sm3.j);
const sm4 = await api('POST', '/loja-virtual/raio/simular', { localizado: false }, A);
check('simulador: endereco nao localizado -> pedir_pino', sm4.j.status === 'pedir_pino', sm4.j);
const sm5 = await api('POST', '/loja-virtual/raio/simular', { ...ponto(3), origem: 'pino', config: { raio_km: 2, faixas: [{ ate_km: 2, taxa: 3, tempo_extra_min: 0 }], raio_margem_pino_m: 0 } }, A);
check('simulador com a configuracao ainda nao salva (raio 2 km): 3 km -> fora', sm5.j.status === 'fora', sm5.j);
check('simulador: coordenadas fora do Brasil -> 400', (await api('POST', '/loja-virtual/raio/simular', { lat: 38.7, lng: -9.1, origem: 'pino' }, A)).s === 400);
const intg = await api('GET', '/master/config/integracoes', null, MAS);
check('Master > Integracoes mostra geocodificacao e mapa (sem segredos)', intg.s === 200 && intg.j.integracoes.some((i) => i.id === 'geocodificacao') && intg.j.integracoes.some((i) => i.id === 'mapa_tiles') && !/segredo/.test(JSON.stringify(intg.j)), intg.j.integracoes.filter((i) => /geo|mapa/.test(i.id)));

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
process.exit(fail ? 1 : 0);
