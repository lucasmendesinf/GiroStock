// Teste ponta a ponta do cardapio digital para o cliente final: GET /cardapio (secoes, Promocoes automatica, % off, indisponiveis,
// cache), login por telefone + codigo (limites, tentativas, expirado, reuso, resposta igual), navegar sem conta, pedido com
// entrega/retirada (taxa, minimo, loja pausada, estoque), adicionais validados no servidor, pagamento na entrega (dinheiro com troco,
// credito, debito, Pix) e pagamento online (Pix e cartao pelo simulador do Mercado Pago), tela Pedidos e compatibilidade com o varejo.
//
// Uso (API em desenvolvimento; o codigo de login vem na resposta porque o provedor padrao e o "simulado"):
//   npm run mp:simulador            (outro terminal; a API precisa de MP_API_URL=http://localhost:4997 e LOJA_VARREDURA_SEGUNDOS=2)
//   API_URL=http://localhost:3000 npm run test:e2e:cardapio
// Sem o simulador, os testes de pagamento online sao pulados (avisa no fim). CARDAPIO_E2E_GRANDE=1 deixa 200 itens publicados
// (para medir a rolagem no navegador); CARDAPIO_E2E_LIMPAR=1 despublica esses itens.
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const SIM = process.env.MP_SIM_URL || 'http://localhost:4997';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
let pulados = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 600)}`); }
};
async function req(method, url, body, headers = {}) {
  try {
    const bruto = Buffer.isBuffer(body);
    const res = await fetch(url, {
      method, headers: { ...(bruto ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined || body === null ? undefined : bruto ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j, h: res.headers };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const api = (m, r, b, tok, h = {}) => req(m, `${B}/api${r}`, b, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h });
let CHAVE = null;
const IP = () => ({ 'x-teste-ip': `e2e-${crypto.randomUUID()}` });
const loja = (m, r, b, tok, h) => req(m, `${B}/api/loja/v1${r}`, b, { ...(CHAVE ? { 'x-loja-chave': CHAVE } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(h || IP()) });
const sim = (m, r, b) => req(m, `${SIM}${r}`, b);
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, ms = 12000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { const v = await fn(); if (v) return v; await esperar(300); }
  return null;
}
const sufixo = crypto.randomBytes(3).toString('hex');
const telefone = () => `11${9}${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
const hoje = (await prod.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
const dia = (n) => new Date(Date.parse(`${hoje}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ---------- preparo ----------
const SENHA_MASTER = crypto.randomBytes(9).toString('base64url');
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.cardapio.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E Cardapio Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.cardapio.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const semearGrande = process.env.CARDAPIO_E2E_GRANDE === '1';

if (process.env.CARDAPIO_E2E_LIMPAR === '1') {
  const r = await prod.query(`UPDATE lv_produtos SET publicado = false FROM products p WHERE p.id = lv_produtos.product_id AND p.nome LIKE 'E2E Cardapio %' AND p.tenant_id = $1`, [empresa]);
  console.log(`${r.rowCount} itens de teste despublicados`);
  await prod.end();
  process.exit(0);
}

await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: true, pedidos: true } }, MAS);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
await api('PATCH', `/locations/${L.Lanchonete}`, { usa_pedidos: true }, A);
const cfg0 = await api('PUT', '/loja-virtual', {
  location_id: L.Lanchonete, nome: 'Lanchonete JA', publicada: true, pausada: false, horarios: {}, pedido_minimo: 0, aceita_entrega: true, aceita_retirada: true,
  tempo_preparo_min: 20, tempo_entrega_min: 30, whatsapp: '11999990000',
  pagamentos: { pix_online: true, cartao_online: true, na_entrega: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'] }, parcelas_max: 3,
  tema: { cartao_estilo: 'grade', selo_off: true, categoria_promocoes: true },
}, A);
check('configura a loja (cardapio, publicada) com as novas formas de pagamento e o estilo dos cartoes', cfg0.s === 200 && cfg0.j.pagamentos.na_entrega.join() === 'dinheiro,pix,cartao_credito,cartao_debito' && cfg0.j.tema.cartao_estilo === 'grade', cfg0);
const k = await api('POST', '/loja-virtual/chave', null, A);
CHAVE = k.j.chave;
check('tema invalido (estilo do cartao) -> 400', (await api('PUT', '/loja-virtual', { tema: { cartao_estilo: 'xyz' } }, A)).s === 400);
check('debito online ainda nao disponivel -> 400', (await api('PUT', '/loja-virtual', { pagamentos: { pix_online: true, cartao_online: true, debito_online: true, na_entrega: ['dinheiro'] } }, A)).s === 400);
await api('PUT', '/loja-virtual', { tema: { cartao_estilo: 'esquerda' } }, A);

// Mercado Pago (simulador): so se estiver no ar
const simOk = (await sim('GET', '/_sim/pagamentos')).s === 200;
let mpOk = false;
if (simOk) mpOk = (await api('PUT', '/loja-virtual/mercadopago', { access_token: 'TEST-1234567890-loja', public_key: 'TEST-pk-loja', webhook_secret: 'sim-segredo-webhook' }, A)).s === 200;
else console.log('  (simulador do Mercado Pago fora do ar: os testes de pagamento online serao pulados)');

console.log('\n# 1. Produtos de teste (categorias, promocao, adicionais, estoque)');
const cat = async (nome) => { const r = await api('POST', '/categories', { nome: `${nome} ${sufixo}` }, A); return r.j.id; };
const catPizza = await cat('E2E Pizzas');
const catBebida = await cat('E2E Bebidas');
let bc = 0;
const produto = async (nome, categoria_id, preco, estoque) => (await api('POST', '/products', {
  nome: `E2E Cardapio ${nome} ${sufixo}`, categoria_id, barcode: `${Date.now()}${bc++}`.slice(-13), unidade: 'UN', preco_custo: 1, preco_venda: preco,
  ...(estoque ? { location_id: L.Lanchonete, estoque_inicial: estoque } : {}),
}, A)).j.id;
const P1 = await produto('Pizza promo', catPizza, 40, 50); // 40 -> 30: 25% off
const P2 = await produto('Pizza com adicional', catPizza, 50, 50);
const P3 = await produto('Refri', catBebida, 7, 60); // 7 -> 5: 28,57% -> 29% off
const P4 = await produto('Suco sem estoque', catBebida, 9, 0);
const PX = await produto('Nao publicado', catBebida, 9, 5);
const grp = (await api('POST', '/complement-groups', { nome: `Borda ${sufixo}`, minimo: 1, maximo: 1 }, A)).j;
const og = (await api('POST', `/complement-groups/${grp.id}/options`, { nome: 'Catupiry', preco: 6 }, A)).j;
const og2 = (await api('POST', `/complement-groups/${grp.id}/options`, { nome: 'Cheddar', preco: 4 }, A)).j;
const OPC1 = og2.opcoes.find((o) => o.nome === 'Catupiry').id;
const OPC2 = og2.opcoes.find((o) => o.nome === 'Cheddar').id;
const grpOutro = (await api('POST', '/complement-groups', { nome: `Outro ${sufixo}`, minimo: 0, maximo: 1 }, A)).j;
const OPC_OUTRO = (await api('POST', `/complement-groups/${grpOutro.id}/options`, { nome: 'Alheia', preco: 1 }, A)).j.opcoes[0].id;
await api('PUT', `/products/${P2}/complement-groups`, { grupos: [grp.id] }, A);
check('opcao do grupo criada (Catupiry e Cheddar)', !!OPC1 && !!OPC2 && !!og, og2);
const pub = async (id, extra = {}) => api('PUT', `/loja-virtual/produtos/${id}`, { publicado: true, ...extra }, A);
check('publica os produtos (um com promocao e foto de teste)', [
  (await pub(P1, { nome_site: 'Pizza promo', descricao: 'Mussarela e tomate', preco_promocional: 30, promo_inicio: dia(-1), promo_fim: dia(5) })).s,
  (await pub(P2, { descricao: 'Com borda recheada' })).s, (await pub(P3, { preco_promocional: 5, promo_inicio: dia(-1), promo_fim: dia(5) })).s, (await pub(P4)).s,
].every((s) => s === 200));
check('configura a ordem: Pizzas antes de Bebidas', (await api('PUT', '/loja-virtual/categorias-ordem', { ids: [catPizza, catBebida] }, A)).s < 500);
if (semearGrande) {
  console.log('  semeando 200 itens para medir a rolagem no navegador...');
  const cats = [];
  for (let i = 0; i < 8; i++) cats.push(await cat(`E2E Grupo ${i + 1}`));
  for (let i = 0; i < 200; i++) {
    const id = await produto(`Item ${String(i + 1).padStart(3, '0')}`, cats[i % 8], 10 + (i % 17), 20);
    await pub(id, { descricao: 'Descrição de teste do item para medir a rolagem do cardápio em lista contínua.', ...(i % 9 === 0 ? { preco_promocional: 8, promo_inicio: dia(-1), promo_fim: dia(9) } : {}) });
  }
  await api('PUT', '/loja-virtual/categorias-ordem', { ids: [catPizza, catBebida, ...cats] }, A);
  console.log('  200 itens publicados (CARDAPIO_E2E_LIMPAR=1 para despublicar).');
}

console.log('\n# 2. GET /cardapio (pagina unica)');
const c1 = await loja('GET', '/cardapio');
const sec = (c1.j.secoes || []);
const itemDe = (id) => sec.flatMap((s) => s.produtos).find((p) => p.id === id);
check('devolve loja e secoes numa resposta so', c1.s === 200 && c1.j.loja && c1.j.loja.nome === 'Lanchonete JA' && Array.isArray(sec) && c1.j.total_produtos >= 4, c1.s);
check('"Promocoes" automatica no topo, so com itens em promocao (inclui os de teste)', sec[0] && sec[0].id === 'promocoes' && sec[0].produtos.every((p) => p.preco_original) && [P1, P3].every((id) => sec[0].produtos.some((p) => p.id === id)) && !sec[0].produtos.some((p) => p.id === P2), sec.map((s) => s.nome));
const sPizza = sec.find((s) => s.nome === `E2E Pizzas ${sufixo}`);
const sBebida = sec.find((s) => s.nome === `E2E Bebidas ${sufixo}`);
check('categorias na ordem do cadastro (Pizzas antes de Bebidas)', sPizza && sBebida && sec.indexOf(sPizza) < sec.indexOf(sBebida), sec.map((s) => s.nome));
check('% off calculado e arredondado (25% e 29%)', itemDe(P1).off === 25 && itemDe(P3).off === 29 && itemDe(P2).off === 0, [itemDe(P1).off, itemDe(P3).off]);
check('preco atual, preco antigo e descricao', itemDe(P1).preco === 30 && itemDe(P1).preco_original === 40 && itemDe(P1).descricao === 'Mussarela e tomate');
check('produto sem estoque aparece indisponivel; com estoque, disponivel', itemDe(P4).disponivel === false && itemDe(P3).disponivel === true);
check('indica adicionais e se ha obrigatorios', itemDe(P2).adicionais === true && itemDe(P2).adicionais_obrigatorios === true && itemDe(P1).adicionais === false);
check('produto nao publicado nao aparece', !itemDe(PX));
const outra = (await prod.query(`SELECT COUNT(*)::int AS n FROM products WHERE id = ANY($1::uuid[]) AND tenant_id <> $2`, [sec.flatMap((s) => s.produtos.map((p) => p.id)), empresa])).rows[0].n;
check('nada de outra empresa na resposta', outra === 0);
check('cache coerente: ETag + Cache-Control curto e Vary', !!c1.h.get('etag') && /max-age=\d+/.test(c1.h.get('cache-control')) && /X-Loja-Subdominio/i.test(c1.h.get('vary') || ''), [...c1.h.entries()]);
// (o fetch do Node acrescenta Cache-Control: no-cache quando ha If-None-Match; um navegador nao faz isso: usamos http puro)
const c304 = await new Promise((resolve) => {
  const u = new URL(`${B}/api/loja/v1/cardapio`);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'x-loja-chave': CHAVE, 'if-none-match': c1.h.get('etag'), ...IP() } }, (r) => { r.resume(); resolve({ s: r.statusCode, h: { get: (n) => r.headers[n] } }); });
});
check('mesmo ETag -> 304 (nada reenviado)', c304.s === 304, c304.s);
check('loja traz capa, formas de pagamento novas e tema do cardapio', 'capa' in c1.j.loja && c1.j.loja.pagamentos.debito_online === false && c1.j.loja.pagamentos.na_entrega.includes('cartao_debito') && c1.j.loja.tema.cartao_estilo === 'esquerda' && c1.j.loja.tema.selo_off === true, c1.j.loja.pagamentos);
await api('PUT', '/loja-virtual', { tema: { categoria_promocoes: false } }, A);
const c2 = await loja('GET', '/cardapio');
check('categoria Promocoes pode ser desligada na gestao', c2.j.secoes[0].id !== 'promocoes', c2.j.secoes.map((s) => s.id));
await api('PUT', '/loja-virtual', { tema: { categoria_promocoes: true } }, A);
const det = await loja('GET', `/produtos/${P2}`);
check('GET /produtos/:id inclui os grupos de adicionais (nome, minimo, maximo, opcoes com preco)', det.s === 200 && det.j.complementos[0].minimo === 1 && det.j.complementos[0].maximo === 1 && det.j.complementos[0].opcoes.length === 2 && det.j.complementos[0].opcoes.find((o) => o.nome === 'Catupiry').preco === 6, det.j.complementos);

console.log('\n# 3. Navegar e montar a sacola sem conta');
const ITENS = [{ product_id: P1, quantidade: 2 }, { product_id: P3, quantidade: 1 }]; // 60 + 5 = 65
const pre0 = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada' });
check('previa do carrinho sem login funciona', pre0.s === 200 && igual(pre0.j.subtotal, 65) && igual(pre0.j.total, 65) && pre0.j.pode_finalizar, pre0);
check('finalizar sem login -> 401', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'dinheiro' } })).s === 401);
check('historico sem login -> 401', (await loja('GET', '/pedidos')).s === 401);

console.log('\n# 4. Login por telefone e codigo');
const tel1 = telefone();
const ipA = { 'x-teste-ip': `e2e-A-${sufixo}` };
const ipB = { 'x-teste-ip': `e2e-B-${sufixo}` };
check('telefone invalido -> 400', (await loja('POST', '/conta/codigo', { telefone: '123' })).s === 400 && (await loja('POST', '/conta/codigo', { telefone: '1188887777' })).s !== 500);
const cod1 = await loja('POST', '/conta/codigo', { telefone: tel1 }, null, IP());
check('pede o codigo: 202, codigo fixo 12345678 (teste), validade 10 min', cod1.s === 202 && cod1.j.codigo_teste === '12345678' && cod1.j.validade_min === 10 && cod1.j.reenviar_em_s === 30, cod1);
const hashNoBanco = (await prod.query(`SELECT codigo_hash, enviado_via FROM lv_login_codigos WHERE tenant_id = $1 AND telefone = $2 ORDER BY criado_em DESC LIMIT 1`, [empresa, tel1])).rows[0];
check('no banco fica so o hash do codigo', hashNoBanco && hashNoBanco.codigo_hash.length === 64 && !hashNoBanco.codigo_hash.includes(cod1.j.codigo_teste) && hashNoBanco.enviado_via === 'simulado');
const sem = await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod1.j.codigo_teste }, null, IP());
check('cliente novo sem nome: precisa_nome e o codigo continua valendo', sem.s === 200 && sem.j.precisa_nome === true && !sem.j.token, sem);
const errado = await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod1.j.codigo_teste === '000000' ? '111111' : '000000', nome: 'Joao da Silva' }, null, IP());
check('codigo errado -> 400 com tentativas restantes', errado.s === 400 && /2 tentativa/.test(errado.j.erro), errado);
const novo = await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod1.j.codigo_teste, nome: 'Joao da Silva', aceita_mensagens: true }, null, IP());
check('cliente novo: cria a conta e entra (201)', novo.s === 201 && novo.j.token && novo.j.nova === true && novo.j.conta.telefone === tel1 && novo.j.conta.nome === 'Joao da Silva' && novo.j.conta.email === null, novo);
const TOK1 = novo.j.token;
const cli = (await prod.query(`SELECT c.nome, c.aceita_mensagens FROM lv_contas a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1`, [novo.j.conta.id])).rows[0];
check('conta ligada ao cadastro de Clientes pelo telefone', cli && cli.nome === 'Joao da Silva' && cli.aceita_mensagens === true, cli);
check('codigo e de uso unico (reuso falha)', (await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod1.j.codigo_teste, nome: 'Joao da Silva' }, null, IP())).s === 400);
check('token da conta funciona (GET /conta)', (await loja('GET', '/conta', null, TOK1)).j.telefone === tel1);
const cod2 = await loja('POST', '/conta/codigo', { telefone: tel1 }, null, IP());
const existente = await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod2.j.codigo_teste }, null, IP());
check('cliente que ja tem conta entra direto (200, sem criar outra)', existente.s === 200 && existente.j.nova === false && existente.j.conta.id === novo.j.conta.id && (await prod.query(`SELECT COUNT(*)::int AS n FROM lv_contas WHERE tenant_id = $1 AND telefone = $2`, [empresa, tel1])).rows[0].n === 1, existente);
// 3 tentativas erradas invalidam o codigo (mesmo o certo depois)
const cod3 = await loja('POST', '/conta/codigo', { telefone: tel1 }, null, IP());
const ruim = cod3.j.codigo_teste === '12345678' ? '87654321' : '123456';
for (let i = 0; i < 3; i++) await loja('POST', '/conta/entrar', { telefone: tel1, codigo: ruim }, null, IP());
check('3 erros invalidam o codigo: nem o certo entra mais', (await loja('POST', '/conta/entrar', { telefone: tel1, codigo: cod3.j.codigo_teste }, null, IP())).s === 400);
// expirado
const tel2 = telefone();
const cod4 = await loja('POST', '/conta/codigo', { telefone: tel2 }, null, IP());
await prod.query(`UPDATE lv_login_codigos SET expira_em = now() - interval '1 minute' WHERE tenant_id = $1 AND telefone = $2`, [empresa, tel2]);
check('codigo expirado -> 400', (await loja('POST', '/conta/entrar', { telefone: tel2, codigo: cod4.j.codigo_teste, nome: 'Maria Souza' }, null, IP())).s === 400);
// o ultimo codigo vale; o anterior deixa de valer
const tel3 = telefone();
const c5a = await loja('POST', '/conta/codigo', { telefone: tel3 }, null, IP());
const c5b = await loja('POST', '/conta/codigo', { telefone: tel3 }, null, IP());
check('pedir outro codigo invalida o anterior; o novo entra', c5a.j.codigo_teste === c5b.j.codigo_teste || (await loja('POST', '/conta/entrar', { telefone: tel3, codigo: c5a.j.codigo_teste, nome: 'Ana Paula' }, null, IP())).s === 400);
check('o codigo mais recente entra (cliente novo, com nome)', (await loja('POST', '/conta/entrar', { telefone: tel3, codigo: c5b.j.codigo_teste, nome: 'Ana Paula' }, null, IP())).s === 201);
// limite por telefone: 3 em 15 minutos
const tel4 = telefone();
const r4 = [];
for (let i = 0; i < 4; i++) r4.push((await loja('POST', '/conta/codigo', { telefone: tel4 }, null, IP())).s);
check('limite por telefone: o 4o codigo em 15 min -> 429', r4.slice(0, 3).every((s) => s === 202) && r4[3] === 429, r4);
// limite por IP: 10 por hora
const r5 = [];
for (let i = 0; i < 11; i++) r5.push((await loja('POST', '/conta/codigo', { telefone: telefone() }, null, ipA)).s);
check('limite por IP: o 11o pedido em 1 h -> 429', r5.slice(0, 10).every((s) => s === 202) && r5[10] === 429, r5);
// resposta igual para telefone existente e novo
const rNovo = await loja('POST', '/conta/codigo', { telefone: telefone() }, null, ipB);
const rExist = await loja('POST', '/conta/codigo', { telefone: tel3 }, null, ipB); // tel3 ja tem conta (Ana Paula)
const forma = (r) => JSON.stringify({ s: r.s, chaves: Object.keys(r.j).sort(), m: r.j.mensagem, v: r.j.validade_min, r: r.j.reenviar_em_s });
check('resposta de /conta/codigo identica para telefone existente e novo', forma(rNovo) === forma(rExist), [forma(rNovo), forma(rExist)]);
// producao: provedor simulado recusado e codigo fora dos logs
const prodTeste = spawnSync('node', ['-e', `
  const c = require('./src/services/codigoLogin');
  const s = c.status();
  c.enviar({ telefone: '11999990000', codigo: '482913', loja: 'X' }).then(() => console.log('ENVIOU')).catch((e) => console.log('RECUSOU ' + e.status));
  console.log(JSON.stringify(s));
`], { cwd: raiz, env: { ...process.env, NODE_ENV: 'production', CODIGO_LOGIN_PROVEDOR: 'simulado' }, encoding: 'utf8' });
check('em producao o provedor "simulado" e recusado (503) e o codigo nao aparece em log', /RECUSOU 503/.test(prodTeste.stdout) && /"configurado":false/.test(prodTeste.stdout) && !/482913/.test(prodTeste.stdout + prodTeste.stderr), prodTeste.stdout);
const semProv = spawnSync('node', ['-e', 'console.log(JSON.stringify(require("./src/services/codigoLogin").status()))'], { cwd: raiz, env: { ...process.env, NODE_ENV: 'production', CODIGO_LOGIN_PROVEDOR: '' }, encoding: 'utf8' });
check('producao sem provedor: login por codigo indisponivel (status no Master)', /"provedor":"nenhum"/.test(semProv.stdout), semProv.stdout);
const integ = await api('GET', '/master/config/integracoes', null, MAS);
const iLogin = integ.j.integracoes && integ.j.integracoes.find((i) => i.id === 'codigo_login');
check('painel Master mostra o provedor do codigo (so status, sem segredos)', iLogin && /simulado/.test(iLogin.detalhe) && !JSON.stringify(iLogin).match(/TOKEN|SECRET/), iLogin);

console.log('\n# 5. Bairros, entrega x retirada, pedido minimo, loja pausada, estoque');
await api('POST', '/loja-virtual/regioes', { nome: `Centro E2E ${sufixo}`, taxa: 6 }, A);
const TOK = TOK1;
const end = (await loja('POST', '/conta/enderecos', { rotulo: 'Casa', logradouro: 'Rua A', numero: '10', bairro: `Centro E2E ${sufixo}`, cidade: 'Sao Paulo', uf: 'SP' }, TOK)).j;
const endFora = (await loja('POST', '/conta/enderecos', { rotulo: 'Fora', logradouro: 'Rua B', numero: '20', bairro: 'Bairro Sem Entrega', cidade: 'Sao Paulo', uf: 'SP' }, TOK)).j;
const preEnt = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', bairro: `Centro E2E ${sufixo}` });
check('entrega: taxa do bairro somada ao total (65 + 6 = 71)', igual(preEnt.j.taxa_entrega, 6) && igual(preEnt.j.total, 71), preEnt.j);
check('retirada: sem taxa', igual(pre0.j.taxa_entrega, 0));
check('bairro sem entrega -> 422 no pedido', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', endereco_id: endFora.id, pagamento: { quando: 'entrega', forma: 'dinheiro' } }, TOK)).s === 422);
await api('PUT', '/loja-virtual', { pedido_minimo: 100 }, A);
const preMin = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada' });
check('pedido minimo: aviso na previa e recusado no servidor (422)', preMin.j.pode_finalizar === false && preMin.j.avisos.some((a) => /mínimo/.test(a)), preMin.j.avisos);
check('pedido abaixo do minimo -> 422', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'dinheiro' } }, TOK)).s === 422);
await api('PUT', '/loja-virtual', { pedido_minimo: 0, pausada: true }, A);
const pausa = await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'dinheiro' } }, TOK);
check('loja pausada bloqueia finalizar (409) e o cardapio avisa', pausa.s === 409 && (await loja('GET', '/cardapio')).j.loja.recebendo_pedidos === false, pausa);
await api('PUT', '/loja-virtual', { pausada: false }, A);
check('produto sem estoque nao entra no pedido (409/422)', [409, 422].includes((await loja('POST', '/pedidos', { itens: [{ product_id: P4, quantidade: 1 }], tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'dinheiro' } }, TOK)).s));
check('mais que o estoque -> recusado', [400, 409, 422].includes((await loja('POST', '/pedidos', { itens: [{ product_id: P3, quantidade: 99 }], tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'dinheiro' } }, TOK)).s));

console.log('\n# 6. Adicionais validados no servidor');
const ped = (itens, extra = {}) => loja('POST', '/pedidos', { itens, tipo: 'retirada', pagamento: { quando: 'entrega', forma: 'pix' }, ...extra }, TOK);
check('adicional obrigatorio ausente -> 422', (await ped([{ product_id: P2, quantidade: 1 }])).s === 422);
check('opcao inexistente/adulterada -> 422', (await ped([{ product_id: P2, quantidade: 1, complementos: [{ id: crypto.randomUUID(), quantidade: 1 }] }])).s === 422);
check('opcao de OUTRO grupo -> 422', (await ped([{ product_id: P2, quantidade: 1, complementos: [{ id: OPC_OUTRO, quantidade: 1 }] }])).s === 422);
check('acima do maximo do grupo (2 opcoes, max 1) -> 422', (await ped([{ product_id: P2, quantidade: 1, complementos: [{ id: OPC1, quantidade: 1 }, { id: OPC2, quantidade: 1 }] }])).s === 422);
const adOk = await ped([{ product_id: P2, quantidade: 2, complementos: [{ id: OPC1, quantidade: 1 }] }], { observacao: 'sem azeitona' });
check('pedido valido com adicional: preco somado (2 x (50 + 6) = 112)', adOk.s === 201 && igual(adOk.j.total, 112) && adOk.j.itens[0].complementos[0].nome === 'Catupiry' && igual(adOk.j.itens[0].preco_unitario, 56), adOk);
const itBanco = (await prod.query(`SELECT preco_unitario, complementos FROM order_items WHERE order_id = $1`, [adOk.j.id])).rows[0];
check('preco e adicionais gravados no item do pedido', itBanco && igual(itBanco.preco_unitario, 56) && itBanco.complementos[0].nome === 'Catupiry' && igual(itBanco.complementos[0].preco, 6), itBanco);

console.log('\n# 7. Pagamento na entrega/retirada (dinheiro, credito, debito, Pix)');
const total65 = 65;
const pDin = await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'dinheiro', troco_para: 100 } });
check('dinheiro com troco: pedido "recebido", a receber, troco gravado', pDin.s === 201 && pDin.j.etapa === 'recebido' && pDin.j.pagamento.tipo === 'na_entrega' && pDin.j.pagamento.forma === 'dinheiro' && igual(pDin.j.pagamento.troco_para, 100) && pDin.j.pagamento.situacao === 'a_pagar', pDin.j.pagamento);
check('troco menor que o total -> 400', (await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'dinheiro', troco_para: 20 } })).s === 400);
const pCred = await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'cartao_credito' } });
const pDeb = await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'cartao_debito' } });
const pPix = await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'pix' } });
check('credito, debito e Pix na entrega: forma gravada no pedido', pCred.j.pagamento.forma === 'cartao_credito' && pDeb.j.pagamento.forma === 'cartao_debito' && pPix.j.pagamento.forma === 'pix', [pCred.s, pDeb.s, pPix.s]);
const oDin = (await api('GET', `/orders/${pDin.j.id}`, null, A)).j;
check('tela Pedidos: a receber com a forma e o troco', oDin.forma_pagamento_prevista === 'dinheiro' && igual(oDin.troco_para, 100) && oDin.pago === false && oDin.origem === 'loja_virtual', oDin);
const fim = await api('POST', `/orders/${pDeb.j.id}/status`, { para: 'em_preparo' }, A);
check('equipe prepara o pedido a receber (nao depende de pagamento online)', fim.s === 200, fim);
const vendaDeb = await api('POST', `/orders/${pDeb.j.id}/status`, { para: 'pronto' }, A);
const finDeb = await api('POST', `/orders/${pDeb.j.id}/status`, { para: 'finalizado' }, A);
check('ao finalizar, a forma escolhida pelo cliente vem pre-selecionada (debito)', [200, 400].includes(finDeb.s) && (finDeb.s === 400 ? /caixa/.test(finDeb.j.erro) : true), [vendaDeb.s, finDeb]);
if (finDeb.s === 200) {
  const venda = (await prod.query(`SELECT forma_pagamento FROM sales WHERE id = (SELECT sale_id FROM orders WHERE id = $1)`, [pDeb.j.id])).rows[0];
  check('venda registrada com cartao_debito (sem o operador informar)', venda && venda.forma_pagamento === 'cartao_debito', venda);
}
await api('PUT', '/loja-virtual', { pagamentos: { pix_online: true, cartao_online: true, na_entrega: ['dinheiro', 'pix'] } }, A);
check('forma desligada pela loja e recusada (credito/debito)', (await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'cartao_debito' } })).s >= 400 && (await ped(ITENS, { pagamento: { quando: 'entrega', forma: 'cartao_credito' } })).s >= 400);
check('formato antigo ("cartao") sem a forma ligada tambem e recusado', (await ped(ITENS, { pagamento: { metodo: 'na_entrega', forma: 'cartao' } })).s === 422);
await api('PUT', '/loja-virtual', { pagamentos: { pix_online: true, cartao_online: true, na_entrega: ['dinheiro', 'pix', 'cartao'] } }, A);
const cfgLegado = (await api('GET', '/loja-virtual', null, A)).j.config.pagamentos;
check('lista antiga com "cartao" e guardada como credito + debito', cfgLegado.na_entrega.join() === 'dinheiro,pix,cartao_credito,cartao_debito', cfgLegado);
const pLegado = await ped(ITENS, { pagamento: { metodo: 'na_entrega', forma: 'cartao' } });
check('formato antigo { metodo, forma:"cartao" } continua funcionando (vira credito)', pLegado.s === 201 && pLegado.j.pagamento.forma === 'cartao_credito', pLegado);
check('debito pelo site (online) -> 422 explicando', (await ped(ITENS, { pagamento: { quando: 'online', forma: 'cartao_debito', cartao: { token: 'cartao-aprovado', payment_method_id: 'debmaster', parcelas: 1 } } })).s === 422);
check('forma de pagamento ausente -> 400', (await ped(ITENS, { pagamento: {} })).s === 400);

console.log('\n# 8. Pagamento online (Pix e cartao de credito, simulador do Mercado Pago)');
if (!simOk || !mpOk) {
  pulados++;
  console.log('  (pulado: simulador fora do ar ou API sem MP_API_URL)');
} else {
  const pPixOn = await ped(ITENS, { pagamento: { quando: 'online', forma: 'pix' } });
  check('Pix online: aguardando pagamento, com QR e copia e cola', pPixOn.s === 201 && pPixOn.j.etapa === 'aguardando_pagamento' && pPixOn.j.pagamento.tipo === 'online' && pPixOn.j.pagamento.detalhe.pix.copia_e_cola, pPixOn);
  const prep = await api('POST', `/orders/${pPixOn.j.id}/status`, { para: 'em_preparo' }, A);
  check('equipe nao prepara antes de aprovar o Pix -> 409', prep.s === 409 && /pagamento online/.test(prep.j.erro), prep);
  const mp = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === pPixOn.j.id);
  await sim('POST', `/_sim/pagamentos/${mp.id}/aprovar`);
  const aprovado = await ate(async () => { const r = await loja('GET', `/pedidos/${pPixOn.j.id}`, null, TOK); return r.j.pagamento.situacao === 'aprovado' ? r.j : null; });
  check('Pix aprovado: pedido liberado (recebido) e a equipe pode preparar', aprovado && aprovado.etapa === 'recebido' && (await api('POST', `/orders/${pPixOn.j.id}/status`, { para: 'em_preparo' }, A)).s === 200, aprovado);
  const oOn = (await api('GET', `/orders/${pPixOn.j.id}`, null, A)).j;
  check('pedido pago online: pago, forma online (vira venda sem caixa)', oOn.pago === true && oOn.forma_pagamento_prevista === 'online', oOn);
  const pRec = await ped(ITENS, { pagamento: { quando: 'online', forma: 'cartao_credito', cartao: { token: 'cartao-recusado', payment_method_id: 'master', parcelas: 1 } } });
  check('cartao de credito recusado: aguardando pagamento com o motivo', pRec.s === 201 && pRec.j.pagamento.situacao === 'recusado', pRec.j.pagamento);
  const pOk = await ped(ITENS, { pagamento: { quando: 'online', forma: 'cartao_credito', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 2 } } });
  check('cartao de credito aprovado na hora (2x)', pOk.s === 201 && pOk.j.pagamento.situacao === 'aprovado' && pOk.j.etapa === 'recebido' && pOk.j.pagamento.detalhe.parcelas === 2, pOk.j.pagamento);
  const canc = await api('POST', `/orders/${pOk.j.id}/cancel`, { motivo: 'teste e2e' }, A);
  check('cancelamento de pedido pago estorna', canc.s === 200 && canc.j.pagamento_status === 'estornado', canc);
}

console.log('\n# 9. Isolamento e compatibilidade com o varejo');
const antiga = await loja('POST', '/conta/cadastro', { nome: 'Cliente Antiga', email: `antiga.${sufixo}@teste.com`, telefone: telefone(), senha: 'Senha1234' }, null, IP());
check('cadastro por e-mail e senha continua funcionando', antiga.s === 201 && antiga.j.conta.email === `antiga.${sufixo}@teste.com`, antiga);
check('login por e-mail e senha continua funcionando', (await loja('POST', '/conta/login', { email: `ANTIGA.${sufixo}@teste.com`, senha: 'Senha1234' })).s === 200);
check('conta por telefone nao tem senha: e-mail/senha nao entra (401)', (await loja('POST', '/conta/login', { email: 'joao@x.com', senha: 'qualquer' })).s === 401);
check('telefone repetido no cadastro por e-mail -> 409 (um telefone, uma conta)', (await loja('POST', '/conta/cadastro', { nome: 'Outra Pessoa', email: `outra.${sufixo}@teste.com`, telefone: tel1, senha: 'Senha1234' }, null, IP())).s === 409);
const cod6 = await loja('POST', '/conta/codigo', { telefone: antiga.j.conta.telefone }, null, IP());
const antigaCod = await loja('POST', '/conta/entrar', { telefone: antiga.j.conta.telefone, codigo: cod6.j.codigo_teste }, null, IP());
check('conta antiga (com e-mail) tambem entra por codigo, sem criar outra', antigaCod.s === 200 && antigaCod.j.conta.id === antiga.j.conta.id && antigaCod.j.nova === false, antigaCod);
check('conta por telefone nao troca senha (409)', (await loja('PUT', '/conta/senha', { senha_atual: 'x', nova_senha: 'Senha12345' }, TOK)).s === 409);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'varejo' }, MAS);
const varejo = await loja('GET', '/loja');
check('loja de varejo: tipo e tema do varejo intactos (home por blocos)', varejo.j.tipo === 'varejo' && ['grade', 'vitrine', 'lista'].includes(varejo.j.tema.modelo) && varejo.j.tema.blocos.length === 5, varejo.j.tema);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
check('voltando para cardapio, o tema do cardapio volta', (await loja('GET', '/loja')).j.tema.modelo === 'cardapio');
// deixa a loja como estava (so Pix/dinheiro na entrega no dev)
await api('PUT', '/loja-virtual', { pagamentos: { pix_online: true, cartao_online: true, na_entrega: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito'] } }, A);

console.log(`\n${pass} ok, ${fail} falhas${pulados ? `, ${pulados} bloco(s) pulado(s)` : ''}`);
await prod.end();
process.exit(fail ? 1 : 0);
