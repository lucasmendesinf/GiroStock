// Teste ponta a ponta da loja virtual: gerenciamento no sistema (modulo, permissao, configuracao, chave da API,
// produtos com foto e promocao, bairros, cupons, Mercado Pago) e a API publica usada pelo site (catalogo, conta do
// cliente, enderecos, carrinho, pedido na entrega, Pix, cartao, aviso do Mercado Pago, estorno, expiracao do Pix,
// recuperacao de senha, bloqueio e exclusao da conta).
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed), com o simulador do Mercado Pago:
//   npm run mp:simulador            (outro terminal; no .env: MP_API_URL=http://localhost:4997 e LOJA_VARREDURA_SEGUNDOS=2)
//   API_URL=http://localhost:3000 npm run test:e2e:loja-virtual
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const SIM = process.env.MP_SIM_URL || 'http://localhost:4997';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
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
const loja = (m, r, b, tok, h = {}) => req(m, `${B}/api/loja/v1${r}`, b, { ...(CHAVE ? { 'x-loja-chave': CHAVE } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...h });
const sim = (m, r, b) => req(m, `${SIM}${r}`, b);
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, ms = 12000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { const v = await fn(); if (v) return v; await esperar(300); }
  return null;
}
const hoje = (await prod.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
const dia = (n) => new Date(Date.parse(`${hoje}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const IP = () => ({ 'x-teste-ip': `e2e-${crypto.randomUUID()}` });

// ---------- preparo ----------
const SENHA_MASTER = crypto.randomBytes(9).toString('base64url');
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.lv.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E LV Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.lv.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const produtos = (await api('GET', '/products', null, A)).j;
const REFRI = produtos.find((p) => p.codigo_interno === 'PRD-0001');
const XB = produtos.find((p) => p.codigo_interno === 'PRD-0002');
const PDVL = (await api('GET', '/terminals', null, A)).j.find((t) => t.nome === 'PDV Lanchonete').id;
const BACON = (await api('GET', '/ingredients', null, A)).j.find((i) => i.nome === 'Bacon');
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'abastecer e2e loja virtual' }, A);
const grupo = (await api('POST', '/complement-groups', { nome: 'Adicionais LV', minimo: 0, maximo: 2 }, A)).j;
const g2 = (await api('POST', `/complement-groups/${grupo.id}/options`, { nome: 'Bacon extra', preco: 3, ingredient_id: BACON.id, quantidade_insumo: 30 }, A)).j;
const OPC_BACON = g2.opcoes.find((o) => o.nome === 'Bacon extra').id;
await api('PUT', `/products/${XB.id}/complement-groups`, { grupos: [grupo.id] }, A);

console.log('\n# 1. Modulo e permissao');
check('sem o modulo Loja virtual: 403', (await api('GET', '/loja-virtual', null, A)).s === 403);
const semPedidos = await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: true, pedidos: false } }, MAS);
check('Loja virtual (loja online) nao depende do modulo Pedidos', semPedidos.s === 200 && (await api('GET', '/loja-virtual', null, A)).s === 200, semPedidos);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
const pendCard = (await api('GET', '/loja-virtual', null, A)).j;
check('loja cardapio sem o modulo Pedidos: aparece a pendencia explicando', pendCard.pendencias.some((x) => /cardápio.*Pedidos/.test(x)), pendCard.pendencias);
check('Master libera Pedidos + Loja virtual', (await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: true, pedidos: true } }, MAS)).s === 200);
const ger = await api('POST', '/users', { nome: 'Gerente LV', email: `ger.lv.${Date.now()}@girostock.local`, senha: 'Senha123!', perfil: 'Gerente' }, A);
const G = ger.s === 201 ? (await api('POST', '/auth/login', { email: ger.j.email, senha: 'Senha123!' })).j.token : null;
check('Gerente (sem a permissao Loja virtual) nao acessa: 403', !!G && (await api('GET', '/loja-virtual', null, G)).s === 403, ger);
let cfg = await api('GET', '/loja-virtual', null, A);
check('primeira abertura cria a configuracao com o nome da empresa e lista o que falta', cfg.s === 200 && cfg.j.config.publicada === false && cfg.j.pendencias.length >= 3 && cfg.j.config.nome, cfg.j);

console.log('\n# 2. Configuracao e chave da API');
const semPed = await api('PUT', '/loja-virtual', { location_id: L.Distribuidora }, A);
check('cardapio: estabelecimento sem "usa pedidos" -> 400 explicando', semPed.s === 400 && /usa pedidos/.test(semPed.j.erro), semPed);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'varejo' }, MAS);
check('loja online: estabelecimento sem "usa pedidos" e aceito', (await api('PUT', '/loja-virtual', { location_id: L.Distribuidora }, A)).s === 200);
// Os passos seguintes testam o cardapio digital (pedidos na tela de Pedidos); a loja online e testada no fim.
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
await api('PATCH', `/locations/${L.Lanchonete}`, { usa_pedidos: true }, A);
const put1 = await api('PUT', '/loja-virtual', {
  location_id: L.Lanchonete, nome: 'Lanchonete JA', descricao: 'Lanches e bebidas geladas', whatsapp: '11999990000', pedido_minimo: 0,
  tempo_preparo_min: 20, tempo_entrega_min: 30, taxa_outros_bairros: null,
  pagamentos: { pix_online: true, cartao_online: true, na_entrega: ['dinheiro', 'pix'] }, parcelas_max: 3,
}, A);
check('salva a configuracao', put1.s === 200 && put1.j.location_id === L.Lanchonete && put1.j.nome === 'Lanchonete JA', put1);
check('loja criada com subdominio sugerido pelo nome da empresa', /^[a-z0-9-]{3,}$/.test(put1.j.subdominio || '') && put1.j.url_previa && put1.j.url_previa.endsWith(`/loja-previa/${put1.j.subdominio}/`), put1.j);
check('horario invalido -> 400', (await api('PUT', '/loja-virtual', { horarios: { 1: [{ de: '25:00', ate: '10:00' }] } }, A)).s === 400);
const k = await api('POST', '/loja-virtual/chave', null, A);
check('gera a chave da API (mostrada uma vez)', k.s === 201 && /^lv_[0-9a-f]{48}$/.test(k.j.chave), k);
const bancoK = (await prod.query(`SELECT api_chave_hash, api_chave_prefixo FROM lv_lojas WHERE tenant_id = $1`, [empresa])).rows[0];
check('no banco fica so o hash da chave', bancoK.api_chave_hash && bancoK.api_chave_hash !== k.j.chave && k.j.chave.startsWith(bancoK.api_chave_prefixo));
check('GET /loja-virtual mostra so o prefixo da chave', JSON.stringify((await api('GET', '/loja-virtual', null, A)).j).indexOf(k.j.chave) === -1);
check('API publica sem chave num endereco que nao e de loja -> 404', (await loja('GET', '/loja')).s === 404);
CHAVE = 'lv_' + '0'.repeat(48);
check('API publica com chave errada -> 401', (await loja('GET', '/loja')).s === 401);
CHAVE = k.j.chave;
let pub = await loja('GET', '/loja');
check('loja ainda nao publicada: dados ok, mas fora do ar e sem receber pedidos', pub.s === 200 && pub.j.nome === 'Lanchonete JA' && pub.j.no_ar === false && pub.j.recebendo_pedidos === false, pub.j);
check('sem Mercado Pago: Pix/cartao online nao aparecem para o site', pub.j.pagamentos.pix_online === false && pub.j.pagamentos.cartao_online === false && pub.j.pagamentos.na_entrega.join() === 'dinheiro,pix', pub.j.pagamentos);
const nova = await api('POST', '/loja-virtual/chave', null, A);
check('gerar nova chave desativa a anterior', (await loja('GET', '/loja')).s === 401);
CHAVE = nova.j.chave;
check('nova chave funciona', (await loja('GET', '/loja')).s === 200);
check('publicar a loja', (await api('PUT', '/loja-virtual', { publicada: true }, A)).s === 200);

console.log('\n# 3. Horario de funcionamento');
const agoraSP = new Date(Date.now() - 3 * 3600000);
const diaSemana = agoraSP.getUTCDay();
const hh = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
const hAgora = agoraSP.getUTCHours();
await api('PUT', '/loja-virtual', { horarios: { [diaSemana]: [{ de: hh(hAgora + 2), ate: hh(hAgora + 3) }] } }, A);
pub = await loja('GET', '/loja');
check('fora do horario: fechada, com a proxima abertura', pub.j.recebendo_pedidos === false && pub.j.horario.aberta === false && pub.j.horario.proxima_abertura && /fechada/.test(pub.j.motivo_fechada), pub.j.horario);
await api('PUT', '/loja-virtual', { horarios: { [diaSemana]: [{ de: hh(hAgora), ate: hh(hAgora + 1) }] } }, A);
pub = await loja('GET', '/loja');
check('dentro do horario: aberta e recebendo pedidos', pub.j.recebendo_pedidos === true && pub.j.horario.aberta === true, pub.j.horario);
await api('PUT', '/loja-virtual', { horarios: {} }, A);
check('sem horario cadastrado = sempre aberta', (await loja('GET', '/loja')).j.horario.sempre_aberta === true);

console.log('\n# 4. Produtos no site (fotos, promocao, complementos, disponibilidade)');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const up = await api('POST', '/loja-virtual/imagens', png, A, { 'content-type': 'image/png' });
check('envia foto (PNG)', up.s === 201 && up.j.id && /\/api\/loja\/v1\/imagens\//.test(up.j.url), up);
const upRuim = await api('POST', '/loja-virtual/imagens', Buffer.from('nao sou imagem'), A, { 'content-type': 'image/png' });
check('arquivo que nao e imagem -> 400', upRuim.s === 400, upRuim);
const img = await req('GET', up.j.url);
check('foto publica para o site (cache longo, liberada para outro dominio)', img.s === 200 && img.h.get('content-type') === 'image/png' && /immutable/.test(img.h.get('cache-control')) && img.h.get('cross-origin-resource-policy') === 'cross-origin');
const promoRuim = await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { publicado: true, preco_promocional: 6 }, A);
check('promocao maior ou igual ao preco de venda -> 400', promoRuim.s === 400, promoRuim);
const pr = await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { publicado: true, nome_site: 'Refrigerante lata gelado', descricao: 'Lata 350 ml', imagens: [up.j.id], preco_promocional: 5, promo_inicio: dia(-1), promo_fim: dia(5), destaque: true }, A);
check('publica o refrigerante com foto e promocao', pr.s === 200 && pr.j.publicado && pr.j.imagens.length === 1 && pr.j.promo_fim === dia(5), pr);
check('publica varios de uma vez', (await api('POST', '/loja-virtual/produtos/publicar', { ids: [XB.id], publicado: true }, A)).s === 200);
await api('PUT', `/loja-virtual/produtos/${XB.id}`, { descricao: 'Pão, carne e queijo' }, A);
const adm = await api('GET', '/loja-virtual/produtos?situacao=publicados', null, A);
check('lista do gerenciamento: publicados, preco no site e disponivel no estabelecimento', adm.s === 200 && adm.j.total === 2 && adm.j.itens.find((p) => p.id === REFRI.id).preco_site.preco === 5 && adm.j.itens.find((p) => p.id === REFRI.id).disponivel === 20, adm.j);
let cat = await loja('GET', '/produtos');
const pRefri = cat.j.produtos && cat.j.produtos.find((p) => p.id === REFRI.id);
const pXb = cat.j.produtos && cat.j.produtos.find((p) => p.id === XB.id);
check('catalogo do site: so os publicados, destaque primeiro', cat.s === 200 && cat.j.total === 2 && cat.j.produtos[0].id === REFRI.id, cat.j);
check('preco promocional com o preco "de" e a validade', pRefri && pRefri.preco === 5 && pRefri.preco_original === 6 && pRefri.promocao_ate === dia(5) && pRefri.nome === 'Refrigerante lata gelado', pRefri);
check('foto com endereco completo', pRefri && /^https?:\/\/.+\/api\/loja\/v1\/imagens\//.test(pRefri.imagens[0]), pRefri && pRefri.imagens);
check('disponibilidade pelo estoque do estabelecimento (20 latas)', pRefri && pRefri.disponivel && pRefri.quantidade_maxima === 20, pRefri);
check('lanche com ficha: disponivel pelos insumos e com os complementos', pXb && pXb.disponivel && pXb.complementos.length === 1 && pXb.complementos[0].opcoes[0].preco === 3 && pXb.complementos[0].maximo === 2, pXb);
check('busca no catalogo', (await loja('GET', '/produtos?busca=burg')).j.total === 1);
const cats = (await loja('GET', '/categorias')).j;
check('categorias com produto publicado (e a categoria pai, somando as filhas)', Array.isArray(cats) && cats.length === 3 && cats.every((c) => c.produtos === 1) && cats.find((c) => c.nome === 'Lanches').pai_id === cats.find((c) => c.nome === 'Lanchonete').id, cats);
check('produto por id', (await loja('GET', `/produtos/${XB.id}`)).j.nome === 'X-Burguer');

console.log('\n# 5. Bairros e cupons');
const reg = await api('POST', '/loja-virtual/regioes', { nomes: 'Centro\nJardim América', taxa: 5 }, A);
check('cadastra varios bairros de uma vez', reg.s === 201 && reg.j.criados === 2, reg);
check('bairro repetido (sem diferenciar maiusculas) -> 409', (await api('POST', '/loja-virtual/regioes', { nome: 'centro', taxa: 9 }, A)).s === 409);
check('na lista de varios, os repetidos sao pulados', (await api('POST', '/loja-virtual/regioes', { nomes: 'CENTRO\nJardim América', taxa: 9 }, A)).j.criados === 0);
check('bairro com pedido minimo proprio', (await api('POST', '/loja-virtual/regioes', { nome: 'Vila Rica', taxa: 8, pedido_minimo: 30, tempo_extra_min: 15 }, A)).s === 201);
check('cupom com codigo invalido -> 400', (await api('POST', '/loja-virtual/cupons', { codigo: 'com espaco', tipo: 'valor', valor: 5 }, A)).s === 400);
check('cupom PROMO10 (10%, 1 uso por cliente)', (await api('POST', '/loja-virtual/cupons', { codigo: 'promo10', tipo: 'percentual', valor: 10, descricao: '10% off' }, A)).s === 201);
check('cupom repetido -> 409', (await api('POST', '/loja-virtual/cupons', { codigo: 'PROMO10', tipo: 'valor', valor: 1 }, A)).s === 409);
await api('POST', '/loja-virtual/cupons', { codigo: 'FRETEGRATIS', tipo: 'frete_gratis', limite_por_cliente: null }, A);
await api('POST', '/loja-virtual/cupons', { codigo: 'BEMVINDO5', tipo: 'valor', valor: 5, primeira_compra: true }, A);
await api('POST', '/loja-virtual/cupons', { codigo: 'VENCIDO', tipo: 'valor', valor: 5, fim: dia(-1) }, A);
pub = await loja('GET', '/loja');
check('site recebe os bairros com taxa e prazo', pub.j.entrega.bairros.length === 3 && pub.j.entrega.bairros.find((b) => b.nome === 'Vila Rica').tempo_estimado_min === 65 && pub.j.entrega.outros_bairros === null, pub.j.entrega);

console.log('\n# 6. Conta do cliente');
check('senha fraca -> 400', (await loja('POST', '/conta/cadastro', { nome: 'Maria Silva', email: 'maria@teste.com', telefone: '11988887777', senha: 'abc' }, null, IP())).s === 400);
check('CPF invalido -> 400', (await loja('POST', '/conta/cadastro', { nome: 'Maria Silva', email: 'maria@teste.com', telefone: '11988887777', senha: 'Senha1234', cpf: '111.111.111-11' }, null, IP())).s === 400);
const cad = await loja('POST', '/conta/cadastro', { nome: 'Maria Silva', email: 'Maria@Teste.com', telefone: '(11) 98888-7777', senha: 'Senha1234', cpf: '529.982.247-25', aceita_mensagens: true }, null, IP());
check('cadastro: conta criada e ja logada', cad.s === 201 && cad.j.token && cad.j.conta.email === 'maria@teste.com' && cad.j.conta.cpf === '52998224725', cad);
let TM = cad.j.token;
const cli = (await prod.query(`SELECT c.nome, c.telefone, c.aceita_mensagens FROM lv_contas a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1`, [cad.j.conta.id])).rows[0];
check('conta ligada ao cadastro de Clientes do sistema (pelo telefone)', cli && cli.telefone === '11988887777' && cli.aceita_mensagens === true, cli);
check('e-mail repetido -> 409', (await loja('POST', '/conta/cadastro', { nome: 'Outra Maria', email: 'maria@teste.com', telefone: '11977776666', senha: 'Senha1234' }, null, IP())).s === 409);
check('senha errada -> 401', (await loja('POST', '/conta/login', { email: 'maria@teste.com', senha: 'errada123' }, null, IP())).s === 401);
const lg = await loja('POST', '/conta/login', { email: 'MARIA@teste.com', senha: 'Senha1234' }, null, IP());
check('login (e-mail sem diferenciar maiusculas)', lg.s === 200 && lg.j.token, lg);
check('GET /conta com o token', (await loja('GET', '/conta', null, TM)).j.nome === 'Maria Silva');
check('token do sistema nao vale na loja', (await loja('GET', '/conta', null, A)).s === 401);
check('token da loja nao vale no sistema', (await api('GET', '/auth/me', null, TM)).s === 401);
const e1 = await loja('POST', '/conta/enderecos', { rotulo: 'Casa', cep: '01310-100', logradouro: 'Rua das Flores', numero: '100', complemento: 'apto 12', bairro: 'jardim america', cidade: 'São Paulo', uf: 'sp', referencia: 'portão azul' }, TM);
check('endereco criado (primeiro = padrao)', e1.s === 201 && e1.j.padrao === true && e1.j.uf === 'SP' && e1.j.cep === '01310100', e1);
const e2 = (await loja('POST', '/conta/enderecos', { rotulo: 'Trabalho', logradouro: 'Av. Brasil', numero: '9', bairro: 'Vila Rica' }, TM)).j;
const e3 = (await loja('POST', '/conta/enderecos', { rotulo: 'Sítio', logradouro: 'Estrada Velha', numero: 's/n', bairro: 'Zona Rural' }, TM)).j;
check('lista de enderecos', (await loja('GET', '/conta/enderecos', null, TM)).j.length === 3);
check('endereco sem bairro -> 400', (await loja('POST', '/conta/enderecos', { logradouro: 'Rua X', numero: '1' }, TM)).s === 400);

console.log('\n# 7. Carrinho (precos, taxa por bairro, cupons, minimo, estoque)');
const ITENS = [
  { product_id: REFRI.id, quantidade: 2 },
  { product_id: XB.id, quantidade: 1, complementos: [{ id: OPC_BACON, quantidade: 2 }], observacao: 'sem cebola' },
];
let c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', endereco_id: e1.j.id, cupom: 'promo10' }, TM);
check('carrinho: promocao + complementos (2x5 + 18+2x3 = 34)', c.s === 200 && igual(c.j.subtotal, 34) && igual(c.j.itens[1].preco_unitario, 24), c.j);
check('taxa pelo bairro do endereco (sem acento/maiuscula): Jardim America R$ 5', igual(c.j.taxa_entrega, 5) && c.j.entrega.bairro === 'Jardim América' && c.j.entrega.tempo_estimado_min === 50, c.j.entrega);
check('cupom 10%: desconto 3,40 e total 35,60', c.j.cupom && c.j.cupom.valido && igual(c.j.desconto, 3.4) && igual(c.j.total, 35.6) && c.j.pode_finalizar === true, c.j);
c = await loja('POST', '/carrinho', { itens: [{ product_id: XB.id, quantidade: 1, complementos: [{ id: OPC_BACON, quantidade: 3 }] }], tipo: 'retirada' });
check('passou do maximo do grupo de complementos -> 422', c.s === 422 && /máximo 2/.test(c.j.erro), c);
c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', bairro: 'Bairro Longe' });
check('bairro fora da lista: aviso "nao fazemos entrega"', c.s === 200 && c.j.pode_finalizar === false && c.j.avisos.some((a) => /não fazemos entrega/.test(a)), c.j);
c = await loja('POST', '/carrinho', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'entrega', endereco_id: e2.id }, TM);
check('pedido minimo do bairro (Vila Rica R$ 30)', c.j.pode_finalizar === false && c.j.avisos.some((a) => /pedido mínimo de R\$ 30,00/.test(a)) && igual(c.j.taxa_entrega, 8), c.j);
c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada', cupom: 'VENCIDO' }, TM);
check('cupom vencido: invalido com motivo (carrinho continua)', c.j.cupom && c.j.cupom.valido === false && /expirou/.test(c.j.cupom.motivo) && igual(c.j.desconto, 0), c.j.cupom);
c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada', cupom: 'FRETEGRATIS' }, TM);
check('frete gratis na retirada: invalido', c.j.cupom && c.j.cupom.valido === false && /entrega/.test(c.j.cupom.motivo), c.j.cupom);
c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'entrega', endereco_id: e1.j.id, cupom: 'FRETEGRATIS' }, TM);
check('frete gratis na entrega: desconto = taxa', c.j.cupom.valido && igual(c.j.desconto, 5), c.j);
c = await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada', cupom: 'PROMO10' });
check('cupom com limite por cliente exige login', c.j.cupom.valido === false && /entre na sua conta/.test(c.j.cupom.motivo), c.j.cupom);
c = await loja('POST', '/carrinho', { itens: [{ product_id: REFRI.id, quantidade: 25 }], tipo: 'retirada' });
check('mais do que o estoque: aviso de estoque', c.j.pode_finalizar === false && c.j.avisos.some((a) => /estoque/.test(a)), c.j.avisos);

console.log('\n# 8. Mercado Pago (conta do lojista)');
const mpRuim = await api('PUT', '/loja-virtual/mercadopago', { access_token: 'TEST-invalido-123', public_key: 'TEST-pk-123' }, A);
check('access token recusado pelo Mercado Pago -> 422 com explicacao', mpRuim.s === 422 && /recusou/.test(mpRuim.j.erro), mpRuim);
check('token de teste com public key de producao -> 400', (await api('PUT', '/loja-virtual/mercadopago', { access_token: 'TEST-abc', public_key: 'APP_USR-abc' }, A)).s === 400);
const mpOk = await api('PUT', '/loja-virtual/mercadopago', { access_token: 'TEST-1234567890-loja', public_key: 'TEST-pk-loja', webhook_secret: 'sim-segredo-webhook' }, A);
check('conecta a conta (conferida na API do Mercado Pago)', mpOk.s === 200 && mpOk.j.mercadopago.conectado && /LOJA_SIMULADA/.test(mpOk.j.mercadopago.conta) && mpOk.j.mercadopago.webhook_secret === true, mpOk.j);
const cript = (await prod.query(`SELECT mp_access_token_cript FROM lv_lojas WHERE tenant_id = $1`, [empresa])).rows[0].mp_access_token_cript;
check('access token guardado cifrado e nunca devolvido', cript && !cript.includes('TEST-1234567890') && !JSON.stringify(mpOk.j).includes('TEST-1234567890'));
pub = await loja('GET', '/loja');
check('site passa a ver Pix e cartao online com a public key', pub.j.pagamentos.pix_online && pub.j.pagamentos.cartao_online && pub.j.pagamentos.mercadopago_public_key === 'TEST-pk-loja' && pub.j.pagamentos.parcelas_max === 3, pub.j.pagamentos);

console.log('\n# 9. Pedido com pagamento na entrega (dinheiro e troco)');
check('pedido sem login -> 401', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } })).s === 401);
check('forma na entrega nao aceita pela loja -> 422', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'cartao' } }, TM)).s === 422);
check('troco menor que o total -> 400', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', endereco_id: e1.j.id, cupom: 'PROMO10', pagamento: { metodo: 'na_entrega', forma: 'dinheiro', troco_para: 20 } }, TM)).s === 400);
const p1 = await loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', endereco_id: e1.j.id, cupom: 'PROMO10', observacao: 'tocar o interfone', pagamento: { metodo: 'na_entrega', forma: 'dinheiro', troco_para: 50 } }, TM);
check('pedido criado: recebido, total 35,60, pagamento na entrega com troco', p1.s === 201 && p1.j.etapa === 'recebido' && igual(p1.j.total, 35.6) && p1.j.pagamento.tipo === 'na_entrega' && igual(p1.j.pagamento.troco_para, 50) && p1.j.previsao_min === 50, p1.j);
check('endereco completo no pedido', p1.j.endereco === 'Rua das Flores, 100 - apto 12 - jardim america, São Paulo/SP (Ref.: portão azul)', p1.j.endereco);
const o1 = (await api('GET', `/orders/${p1.j.id}`, null, A)).j;
check('aparece na tela de Pedidos: canal loja virtual, cupom, troco e observacao', o1.origem === 'loja_virtual' && o1.cupom_codigo === 'PROMO10' && igual(o1.troco_para, 50) && /tocar o interfone · Troco para R\$ 50,00/.test(o1.observacao) && igual(o1.total, 35.6) && o1.cliente_telefone === '11988887777', o1);
check('pedido ligado ao cliente do sistema', (await prod.query(`SELECT o.customer_id = a.customer_id AS ok FROM orders o JOIN lv_contas a ON a.id = o.lv_conta_id WHERE o.id = $1`, [p1.j.id])).rows[0].ok === true);
check('estoque reservado: 18 latas disponiveis no site', (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima === 18);
check('cupom de 1 uso por cliente nao vale de novo', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', cupom: 'PROMO10', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TM)).s === 422);
await api('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 50 }, A);
const ent = (await api('POST', '/couriers', { nome: 'Motoboy LV' }, A)).j;
for (const para of ['em_preparo', 'pronto']) await api('POST', `/orders/${p1.j.id}/status`, { para }, A);
await api('POST', `/orders/${p1.j.id}/status`, { para: 'saiu_entrega', entregador_id: ent.id }, A);
let v1 = await loja('GET', `/pedidos/${p1.j.id}`, null, TM);
check('cliente acompanha: saiu para entrega, com historico', v1.j.etapa === 'saiu_entrega' && v1.j.historico.map((h) => h.etapa).join() === 'recebido,em_preparo,pronto,saiu_entrega', v1.j);
const fin = await api('POST', `/orders/${p1.j.id}/status`, { para: 'finalizado', forma_pagamento: 'dinheiro', valor_recebido: 50 }, A);
const venda1 = fin.s === 200 ? (await prod.query(`SELECT total, desconto, taxa_entrega, forma_pagamento FROM sales WHERE id = $1`, [fin.j.sale_id])).rows[0] : null;
check('finalizar gera a venda com o preco promocional, o desconto do cupom e a taxa', venda1 && igual(venda1.total, 35.6) && igual(venda1.desconto, 3.4) && igual(venda1.taxa_entrega, 5), { fin: fin.j, venda1 });
v1 = await loja('GET', `/pedidos/${p1.j.id}`, null, TM);
check('cliente ve "entregue"', v1.j.etapa === 'entregue' && v1.j.pode_cancelar === false);

console.log('\n# 10. Pix pelo site (aviso do Mercado Pago)');
const p2 = await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 2 }], tipo: 'retirada', pagamento: { metodo: 'pix' } }, TM);
check('pedido Pix: aguardando pagamento, com copia e cola e QR code', p2.s === 201 && p2.j.etapa === 'aguardando_pagamento' && p2.j.pagamento.detalhe.pix.copia_e_cola && p2.j.pagamento.detalhe.pix.qr_code_base64 && p2.j.pode_pagar, p2.j);
const prep = await api('POST', `/orders/${p2.j.id}/status`, { para: 'em_preparo' }, A);
check('equipe nao prepara antes do pagamento -> 409', prep.s === 409 && /pagamento online/.test(prep.j.erro), prep);
const mp2 = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === p2.j.id);
check('cobranca no Mercado Pago com o valor e o aviso apontando para esta loja', mp2 && igual(mp2.transaction_amount, 10) && /\/api\/webhooks\/mercadopago\//.test(mp2.notification_url) && mp2.payer.email === 'maria@teste.com', mp2);
const avisoFalso = await req('POST', mp2.notification_url, { type: 'payment', data: { id: String(mp2.id) } }, { 'x-signature': 'ts=1,v1=abc', 'x-request-id': 'x' });
check('aviso com assinatura invalida -> 401', avisoFalso.s === 401, avisoFalso);
await sim('POST', `/_sim/pagamentos/${mp2.id}/aprovar`);
const pago2 = await ate(async () => { const r = await loja('GET', `/pedidos/${p2.j.id}`, null, TM); return r.j.pagamento && r.j.pagamento.situacao === 'aprovado' ? r.j : null; });
check('aviso assinado do Mercado Pago aprova o pedido', pago2 && pago2.etapa === 'recebido' && pago2.pagamento.detalhe.situacao === 'aprovado', pago2);
const o2 = (await api('GET', `/orders/${p2.j.id}`, null, A)).j;
check('na tela de Pedidos: pago, forma online', o2.pago === true && o2.forma_pagamento_prevista === 'online' && o2.pagamento_status === 'aprovado', o2);
check('agora a equipe pode preparar', (await api('POST', `/orders/${p2.j.id}/status`, { para: 'em_preparo' }, A)).s === 200);
const avisoDesconhecido = await req('POST', mp2.notification_url.replace(/[0-9a-f-]{36}$/, crypto.randomUUID()), { type: 'payment', data: { id: '1' } });
check('aviso de loja desconhecida -> 200 (ignorado, sem reenvio)', avisoDesconhecido.s === 200);

console.log('\n# 11. Cartao recusado, nova tentativa e parcelas');
const p3 = await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'cartao', cartao: { token: 'cartao-recusado', payment_method_id: 'master', parcelas: 1 } } }, TM);
check('cartao recusado: pedido aguardando pagamento com o motivo', p3.s === 201 && p3.j.etapa === 'aguardando_pagamento' && p3.j.pagamento.situacao === 'recusado' && /saldo ou limite/.test(p3.j.pagamento.detalhe.motivo_recusa), p3.j);
check('parcelas acima do maximo -> 400', (await loja('POST', `/pedidos/${p3.j.id}/pagamento`, { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 6 } }, TM)).s === 400);
const p3b = await loja('POST', `/pedidos/${p3.j.id}/pagamento`, { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 3 } }, TM);
check('nova tentativa com outro cartao: aprovado na hora', p3b.s === 200 && p3b.j.pagamento.situacao === 'aprovado' && p3b.j.pagamento.detalhe.parcelas === 3 && p3b.j.pagamento.detalhe.final_cartao === '4242' && p3b.j.pode_pagar === false, p3b.j);
check('pedido pago nao aceita outro pagamento -> 409', (await loja('POST', `/pedidos/${p3.j.id}/pagamento`, { metodo: 'pix' }, TM)).s === 409);

console.log('\n# 12. Cancelamento com estorno');
const disp0 = (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima;
const c3 = await loja('POST', `/pedidos/${p3.j.id}/cancelar`, { motivo: 'desisti' }, TM);
const mp3 = (await sim('GET', '/_sim/pagamentos')).j.filter((x) => x.external_reference === p3.j.id);
check('cliente cancela pedido pago (ainda nao preparado): estorno no Mercado Pago', c3.s === 200 && c3.j.etapa === 'cancelado' && c3.j.pagamento.situacao === 'estornado' && mp3.some((x) => x.status === 'refunded'), { c3: c3.j, mp3 });
check('cancelar devolve a reserva do estoque', (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima === disp0 + 1);
check('cliente nao cancela pedido em preparo -> 409', (await loja('POST', `/pedidos/${p2.j.id}/cancelar`, {}, TM)).s === 409);
const c2 = await api('POST', `/orders/${p2.j.id}/cancel`, { motivo: 'acabou o produto' }, A);
check('loja cancela pedido pago em preparo: estorna e cancela', c2.s === 200 && c2.j.status === 'cancelado' && c2.j.pagamento_status === 'estornado' && (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.id === mp2.id).status === 'refunded', c2.j);

console.log('\n# 13. Pix nao pago no prazo, aviso perdido e pagamento depois do cancelamento');
const p4 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'pix' } }, TM)).j;
await prod.query(`UPDATE lv_pagamentos SET expira_em = now() - interval '5 minutes' WHERE order_id = $1`, [p4.id]);
const exp = await ate(async () => { const r = await loja('GET', `/pedidos/${p4.id}`, null, TM); return r.j.etapa === 'cancelado' ? r.j : null; });
const mp4 = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === p4.id);
check('Pix vencido: pedido cancelado sozinho e cobranca cancelada no Mercado Pago', exp && exp.pagamento.situacao === 'expirado' && /prazo/.test(exp.motivo_cancelamento) && mp4.status === 'cancelled', { exp, mp4 });
await sim('POST', `/_sim/pagamentos/${mp4.id}/aprovar`);
const est = await ate(async () => ((await sim('GET', '/_sim/pagamentos')).j.find((x) => x.id === mp4.id).status === 'refunded'));
check('Pix pago depois do cancelamento: estornado automaticamente', !!est && (await prod.query(`SELECT pagamento_status FROM orders WHERE id = $1`, [p4.id])).rows[0].pagamento_status === 'estornado');
const p5 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'pix' } }, TM)).j;
const mp5 = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === p5.id);
await sim('POST', `/_sim/pagamentos/${mp5.id}/aprovar?sem_aviso=1`);
const rec = await ate(async () => (await loja('GET', `/pedidos/${p5.id}`, null, TM)).j.pagamento.situacao === 'aprovado');
check('aviso perdido: a conferencia periodica encontra o Pix pago', !!rec);

console.log('\n# 14. Loja pausada, minimo e cupom de primeira compra');
await api('PUT', '/loja-virtual', { pausada: true }, A);
const pausa = await loja('POST', '/pedidos', { itens: ITENS, tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'pix' } }, TM);
check('loja pausada: nao aceita pedido (409)', pausa.s === 409 && /não está recebendo/.test(pausa.j.erro), pausa);
await api('PUT', '/loja-virtual', { pausada: false }, A);
check('pedido abaixo do minimo do bairro -> 422', (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'entrega', endereco_id: e2.id, pagamento: { metodo: 'na_entrega', forma: 'pix' } }, TM)).s === 422);
check('bairro sem entrega -> 422', (await loja('POST', '/pedidos', { itens: ITENS, tipo: 'entrega', endereco_id: e3.id, pagamento: { metodo: 'na_entrega', forma: 'pix' } }, TM)).s === 422);
check('cupom de primeira compra nao vale para quem ja comprou', /primeira compra/.test((await loja('POST', '/carrinho', { itens: ITENS, tipo: 'retirada', cupom: 'BEMVINDO5' }, TM)).j.cupom.motivo));
const cups = (await api('GET', '/loja-virtual/cupons', null, A)).j;
check('gerenciamento mostra usos e desconto dado por cupom', cups.find((x) => x.codigo === 'PROMO10').usos === 1 && igual(cups.find((x) => x.codigo === 'PROMO10').desconto_total, 3.4), cups);
const pags = (await api('GET', '/loja-virtual/pagamentos', null, A)).j;
check('gerenciamento lista os pagamentos online', pags.length >= 5 && pags.some((x) => x.situacao === 'estornado') && pags.some((x) => x.situacao === 'recusado'), pags.map((x) => x.situacao));
const resumo = (await api('GET', '/loja-virtual', null, A)).j;
check('resumo: produtos publicados, clientes e pedidos de hoje', resumo.resumo.produtos_publicados === 2 && resumo.resumo.clientes === 1 && resumo.resumo.pedidos_hoje >= 2, resumo.resumo);

console.log('\n# 15. Senha: recuperacao por e-mail e troca');
const dirEmails = path.join(raiz, 'tmp', 'emails');
const antes = fs.existsSync(dirEmails) ? fs.readdirSync(dirEmails).length : 0;
const esq = await loja('POST', '/conta/esqueci-senha', { email: 'maria@teste.com' }, null, IP());
const esqNao = await loja('POST', '/conta/esqueci-senha', { email: 'ninguem@teste.com' }, null, IP());
check('esqueci a senha: mesma resposta exista ou nao a conta', esq.s === 202 && esqNao.s === 202 && esq.j.mensagem === esqNao.j.mensagem);
const arqs = fs.readdirSync(dirEmails).sort();
const mail = JSON.parse(fs.readFileSync(path.join(dirEmails, arqs[arqs.length - 1]), 'utf8'));
check('e-mail com o codigo enviado (so para a conta que existe)', arqs.length === antes + 1 && mail.para === 'maria@teste.com' && /\d{6}/.test(mail.texto) && /Lanchonete JA/.test(mail.assunto), mail);
check('codigo errado -> 400', (await loja('POST', '/conta/redefinir-senha', { email: 'maria@teste.com', codigo: '000000', senha: 'NovaSenha99' }, null, IP())).s === 400);
const red = await loja('POST', '/conta/redefinir-senha', { email: 'maria@teste.com', codigo: mail.codigo, senha: 'NovaSenha99' }, null, IP());
check('codigo certo: nova senha e ja entra', red.s === 200 && red.j.token, red);
check('sessoes antigas encerradas', (await loja('GET', '/conta', null, TM)).s === 401);
TM = red.j.token;
check('codigo nao vale duas vezes', (await loja('POST', '/conta/redefinir-senha', { email: 'maria@teste.com', codigo: mail.codigo, senha: 'OutraSenha99' }, null, IP())).s === 400);
const troca = await loja('PUT', '/conta/senha', { senha_atual: 'NovaSenha99', nova_senha: 'Trocada123' }, TM);
check('troca de senha devolve token novo', troca.s === 200 && troca.j.token && (await loja('GET', '/conta', null, troca.j.token)).s === 200, troca);
TM = troca.j.token;
const ipFixo = IP();
let ultimo = null;
for (let i = 0; i < 21; i++) ultimo = await loja('POST', '/conta/login', { email: 'maria@teste.com', senha: 'errada' }, null, ipFixo);
check('muitas tentativas de login do mesmo IP -> 429', ultimo.s === 429, ultimo);

console.log('\n# 16. Bloqueio e exclusao da conta');
const contas = (await api('GET', '/loja-virtual/clientes', null, A)).j;
const maria = contas.find((x) => x.email === 'maria@teste.com');
check('gerenciamento lista os clientes do site com pedidos e total', maria && maria.pedidos >= 1 && maria.total_gasto > 0, maria);
await api('PATCH', `/loja-virtual/clientes/${maria.id}`, { ativo: false }, A);
check('conta bloqueada: token para de valer e login recusado', (await loja('GET', '/conta', null, TM)).s === 401 && (await loja('POST', '/conta/login', { email: 'maria@teste.com', senha: 'Trocada123' }, null, IP())).s === 401);
await api('PATCH', `/loja-virtual/clientes/${maria.id}`, { ativo: true }, A);
TM = (await loja('POST', '/conta/login', { email: 'maria@teste.com', senha: 'Trocada123' }, null, IP())).j.token;
check('desbloqueada: entra de novo', !!TM);
check('excluir conta exige a senha', (await loja('DELETE', '/conta', { senha: 'errada' }, TM)).s === 400);
check('excluir conta (LGPD)', (await loja('DELETE', '/conta', { senha: 'Trocada123' }, TM)).s === 204);
const exc = (await prod.query(`SELECT nome, email, ativo, (SELECT COUNT(*) FROM lv_enderecos WHERE conta_id = $1)::int AS ends, (SELECT COUNT(*) FROM orders WHERE lv_conta_id = $1)::int AS peds FROM lv_contas WHERE id = $1`, [maria.id])).rows[0];
check('dados pessoais apagados, pedidos mantidos no historico da loja', exc.ativo === false && exc.nome === 'Conta excluída' && exc.ends === 0 && exc.peds >= 4, exc);
check('o mesmo e-mail pode criar conta nova', (await loja('POST', '/conta/cadastro', { nome: 'Maria Silva', email: 'maria@teste.com', telefone: '11988887777', senha: 'Senha1234' }, null, IP())).s === 201);

console.log('\n# 17. Modulo desligado');
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: false } }, MAS);
check('modulo desligado: API publica responde 403 ao site', (await loja('GET', '/loja')).s === 403);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { loja_virtual: true } }, MAS);
check('religado: volta a funcionar', (await loja('GET', '/loja')).s === 200);

console.log('\n# 18. Endereco da loja (Master), dominio proprio, subdominio e tema');
// Requisicao com outro Host (como se o navegador abrisse o dominio da loja).
const comHost = (host, caminho, headers = {}) => new Promise((resolve) => {
  const u = new URL(B);
  const r = http.request({ hostname: u.hostname, port: u.port, path: caminho, method: 'GET', headers: { host, ...headers } }, (res) => {
    let t = '';
    res.on('data', (c) => { t += c; });
    res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* html */ } resolve({ s: res.statusCode, t, j }); });
  });
  r.on('error', (e) => resolve({ s: 'CAIU', t: e.message }));
  r.end();
});
const BASE_SUB = process.env.LOJA_DOMINIO_BASE || '';
check('cliente (Administrador) nao mexe no endereco: rota do Master -> 403', (await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { subdominio: 'x-loja' }, A)).s === 403);
check('subdominio reservado -> 400', (await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { subdominio: 'www' }, MAS)).s === 400);
check('dominio invalido -> 400', (await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { dominios: 'nao e dominio' }, MAS)).s === 400);
const end = await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { subdominio: 'LanchoneteJA', dominios: 'https://WWW.LanchoneteJA.com.br/\nlanchoneteja.com.br' }, MAS);
check('Master define subdominio e dominios (normalizados)', end.s === 200 && end.j.subdominio === 'lanchoneteja' && end.j.dominios.join() === 'www.lanchoneteja.com.br,lanchoneteja.com.br' && end.j.modulo_ligado === true, end);
const outra = (await prod.query(`INSERT INTO tenants (nome) VALUES ('Outra Empresa E2E') RETURNING id`)).rows[0].id;
check('outra empresa ganha loja com subdominio proprio', (await api('GET', `/master/empresas/${outra}/loja-virtual`, null, MAS)).j.subdominio === 'outra-empresa-e2e');
check('o mesmo dominio em outra empresa -> 409', (await api('PUT', `/master/empresas/${outra}/loja-virtual`, { dominios: 'www.lanchoneteja.com.br' }, MAS)).s === 409);
check('o mesmo subdominio em outra empresa -> 409', (await api('PUT', `/master/empresas/${outra}/loja-virtual`, { subdominio: 'lanchoneteja' }, MAS)).s === 409);
const cfgEnd = (await api('GET', '/loja-virtual', null, A)).j.config;
check('painel do cliente mostra os enderecos da loja (sem poder editar)', cfgEnd.dominios.length === 2 && cfgEnd.urls_dominios[0] === 'https://www.lanchoneteja.com.br', cfgEnd);
check('dns: consulta responde para cada dominio', (await api('GET', `/master/empresas/${empresa}/loja-virtual/dns`, null, MAS)).j.dominios.length === 2);
const pagLoja = await comHost('www.lanchoneteja.com.br', '/');
check('dominio proprio abre o site da loja (nao o sistema)', pagLoja.s === 200 && pagLoja.t.includes('/loja-assets/'), pagLoja.t.slice(0, 200));
check('sem o www tambem abre a loja', (await comHost('lanchoneteja.com.br', '/produto/qualquer')).t.includes('/loja-assets/'));
if (BASE_SUB) check('subdominio da plataforma abre a loja', (await comHost(`lanchoneteja.${BASE_SUB}`, '/')).t.includes('/loja-assets/'));
const pagSistema = await comHost(new URL(B).host, '/login');
check('o endereco do sistema continua abrindo o sistema', pagSistema.s === 200 && !pagSistema.t.includes('/loja-assets/'), pagSistema.t.slice(0, 200));
check('pre-visualizacao pelo endereco do sistema', (await comHost(new URL(B).host, '/loja-previa/lanchoneteja/')).t.includes('/loja-assets/'));
const apiHost = await comHost('www.lanchoneteja.com.br', '/api/loja/v1/loja');
check('API da loja pelo dominio, sem chave', apiHost.s === 200 && apiHost.j.nome === 'Lanchonete JA', apiHost.t.slice(0, 200));
check('API da loja pela pre-visualizacao (subdominio no cabecalho)', (await comHost(new URL(B).host, '/api/loja/v1/loja', { 'x-loja-subdominio': 'lanchoneteja' })).j.nome === 'Lanchonete JA');
check('dominio desconhecido -> 404', (await comHost('www.naoexiste.com.br', '/api/loja/v1/loja')).s === 404);
check('link no endereco do sistema (/loja/<subdominio>) abre a loja', (await comHost(new URL(B).host, '/loja/lanchoneteja/produto/x')).t.includes('/loja-assets/'));
check('painel mostra o link principal para compartilhar', cfgEnd.link_principal === 'https://www.lanchoneteja.com.br' && cfgEnd.url_link.endsWith('/loja/lanchoneteja'), cfgEnd);
const qr = await api('GET', `/loja-virtual/qrcode?url=${encodeURIComponent(cfgEnd.link_principal)}`, null, A);
check('QR code do link da loja', qr.s === 200 && qr.j.qr.startsWith('data:image/png;base64,'), qr.s);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'varejo' }, MAS);
check('modelo de cardapio nao vale em loja de varejo -> 400', (await api('PUT', '/loja-virtual', { tema: { modelo: 'cardapio' } }, A)).s === 400);
check('tipo de loja invalido -> 400', (await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'mercado' }, MAS)).s === 400);
const cardap = await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'cardapio' }, MAS);
const lojaCard = (await comHost('www.lanchoneteja.com.br', '/api/loja/v1/loja')).j;
check('Master muda para cardapio digital: o site recebe o tipo e o modelo do cardapio', cardap.s === 200 && cardap.j.tipo === 'cardapio' && lojaCard.tipo === 'cardapio' && lojaCard.tema.modelo === 'cardapio', { s: cardap.s, tipo: lojaCard.tipo, modelo: lojaCard.tema.modelo });
const catsAdm = (await api('GET', '/loja-virtual/categorias', null, A)).j;
const bebidas = catsAdm.find((c) => c.nome === 'Bebidas');
check('painel lista as categorias com quantos produtos estao no site', bebidas && bebidas.produtos_no_site >= 1, catsAdm);
const fotoCat = await api('POST', '/loja-virtual/imagens', png, A, { 'content-type': 'image/png' });
check('foto da categoria', (await api('PUT', `/loja-virtual/categorias/${bebidas.id}`, { imagem_id: fotoCat.j.id }, A)).s === 200);
let catsSite = (await comHost('www.lanchoneteja.com.br', '/api/loja/v1/categorias')).j;
const bebSite = catsSite.find((c) => c.id === bebidas.id);
check('site recebe a foto da categoria e o selo de promocao', bebSite && bebSite.imagem && bebSite.imagem.includes(fotoCat.j.id) && bebSite.tem_promocao === true, bebSite);
const outrasCats = catsSite.filter((c) => c.id !== bebidas.id).map((c) => c.id);
await api('PUT', '/loja-virtual/categorias-ordem', { ids: [...outrasCats, bebidas.id] }, A);
catsSite = (await comHost('www.lanchoneteja.com.br', '/api/loja/v1/categorias')).j;
check('ordem das categorias definida no painel', catsSite[catsSite.length - 1].id === bebidas.id, catsSite.map((c) => c.nome));
await api('PUT', `/loja-virtual/categorias/${bebidas.id}`, { oculta: true }, A);
check('categoria oculta some do site', !(await comHost('www.lanchoneteja.com.br', '/api/loja/v1/categorias')).j.some((c) => c.id === bebidas.id));
await api('PUT', `/loja-virtual/categorias/${bebidas.id}`, { oculta: false }, A);
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'varejo' }, MAS);
check('cor invalida no tema -> 400', (await api('PUT', '/loja-virtual', { tema: { cor_primaria: 'vermelho' } }, A)).s === 400);
const tema = await api('PUT', '/loja-virtual', { tema: { modelo: 'lista', cor_primaria: '#123456', exclusivo: 'invasao', blocos: [{ tipo: 'produtos', ativo: true, titulo: 'Cardápio' }, { tipo: 'banners', ativo: false }] } }, A);
check('salva o tema (modelo, cor, ordem dos blocos)', tema.s === 200 && tema.j.tema.modelo === 'lista' && tema.j.tema.blocos[0].tipo === 'produtos' && tema.j.tema.blocos[0].titulo === 'Cardápio' && tema.j.tema.blocos.find((b) => b.tipo === 'banners').ativo === false, tema.j && tema.j.tema);
const temaSite = (await comHost('www.lanchoneteja.com.br', '/api/loja/v1/loja')).j.tema;
check('site recebe o tema; o cliente nao define tema exclusivo', temaSite.cor_primaria === '#123456' && temaSite.exclusivo === null && temaSite.blocos.length === 5, temaSite);

console.log('\n# 19. Loja online (varejo): pedidos do site sem a tela de Pedidos');
await api('PUT', `/master/empresas/${empresa}/loja-virtual`, { tipo: 'varejo' }, MAS);
await api('PUT', '/loja-virtual', { pausada: false, pedido_minimo: 0, horarios: {} }, A);
const cadJ = await loja('POST', '/conta/cadastro', { nome: 'João Souza', email: 'joao@teste.com', telefone: '11955554444', senha: 'Senha1234' }, null, IP());
const TJ = cadJ.j.token;
const endJ = (await loja('POST', '/conta/enderecos', { rotulo: 'Casa', cep: '01310-100', logradouro: 'Rua A', numero: '1', bairro: 'jardim america', cidade: 'São Paulo', uf: 'SP' }, TJ)).j;
check('cliente novo com endereco', !!TJ && !!endJ.id, cadJ);
const site = (r) => api('GET', `/loja-virtual/pedidos${r || ''}`, null, A);
const avancar = (id, b) => api('POST', `/loja-virtual/pedidos/${id}/avancar`, b, A);
const ver = async (id) => (await loja('GET', `/pedidos/${id}`, null, TJ)).j;
const ultimoEmail = () => { const a = fs.readdirSync(dirEmails).sort(); return JSON.parse(fs.readFileSync(path.join(dirEmails, a[a.length - 1]), 'utf8')); };

// Retirada paga com Pix
const r1 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 2 }], tipo: 'retirada', pagamento: { metodo: 'pix' } }, TJ, IP())).j;
check('pedido da loja online fica fora da tela de Pedidos', !(await api('GET', '/orders', null, A)).j.some((o) => o.id === r1.id) && (await api('GET', `/orders/${r1.id}`, null, A)).s === 404);
check('tela de Pedidos nao mexe nele -> 409', (await api('POST', `/orders/${r1.id}/status`, { para: 'em_preparo' }, A)).s === 409);
let lista = (await site('?situacao=aguardando_pagamento')).j;
check('aba Pedidos do site: aguardando pagamento', lista.pedidos.some((x) => x.id === r1.id && x.situacao === 'aguardando_pagamento' && x.proxima === null) && lista.contagem.aguardando_pagamento >= 1, lista);
check('nao separa antes do pagamento -> 409', (await avancar(r1.id, { para: 'em_preparo' })).s === 409);
const mpR1 = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === r1.id);
await sim('POST', `/_sim/pagamentos/${mpR1.id}/aprovar`);
const pagoR1 = await ate(async () => { const v = await ver(r1.id); return v.etapa === 'pagamento_aprovado' ? v : null; });
check('pago: cliente ve "Pagamento aprovado" (fluxo loja online)', pagoR1 && pagoR1.fluxo === 'loja_online' && pagoR1.previsao_min === null, pagoR1);
lista = (await site()).j;
const itemR1 = lista.pedidos.find((x) => x.id === r1.id);
check('aba: a preparar, proxima etapa = separacao', itemR1 && itemR1.situacao === 'a_preparar' && itemR1.proxima === 'em_preparo', itemR1);
check('pular etapa -> 409', (await avancar(r1.id, { para: 'finalizado' })).s === 409);
let a1 = await avancar(r1.id, { para: 'em_preparo' });
check('iniciar separacao', a1.s === 200 && a1.j.situacao === 'em_separacao' && (await ver(r1.id)).etapa === 'em_separacao', a1.j);
const qtdEmails = fs.readdirSync(dirEmails).length;
a1 = await avancar(r1.id, { para: 'pronto' });
check('pronto para retirada (cliente ve e recebe e-mail)', a1.s === 200 && a1.j.situacao === 'pronto_retirada' && (await ver(r1.id)).etapa === 'pronto_retirada', a1.j);
const mailPronto = await ate(async () => (fs.readdirSync(dirEmails).length > qtdEmails ? ultimoEmail() : null), 4000);
check('e-mail "pronto para retirada" para o cliente', mailPronto && mailPronto.para === 'joao@teste.com' && /pronto para retirada/.test(mailPronto.assunto), mailPronto);
const dispAntes = (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima;
a1 = await avancar(r1.id, { para: 'finalizado' });
const vendaR1 = a1.s === 200 ? (await prod.query(`SELECT s.terminal_id, s.cash_session_id, s.forma_pagamento, s.total FROM sales s JOIN orders o ON o.sale_id = s.id WHERE o.id = $1`, [r1.id])).rows[0] : null;
check('cliente retirou: vira venda paga online, sem caixa', a1.j.situacao === 'retirado' && vendaR1 && vendaR1.terminal_id === null && vendaR1.cash_session_id === null && vendaR1.forma_pagamento === 'online' && igual(vendaR1.total, 10), { a: a1.j, vendaR1 });
check('estoque: a reserva vira baixa (disponivel nao muda)', (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima === dispAntes);
check('cliente ve "Retirado"', (await ver(r1.id)).etapa === 'retirado');
const vendaDet = (await api('GET', `/sales/${a1.j.venda_numero ? (await prod.query(`SELECT sale_id FROM orders WHERE id = $1`, [r1.id])).rows[0].sale_id : ''}`, null, A)).j;
check('venda do site aparece em Vendas como "Loja virtual (site)"', vendaDet.terminal_nome === 'Loja virtual (site)' && vendaDet.caixa_aberto === true, vendaDet);

// Envio pago no cartao
const r2 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 3 }], tipo: 'entrega', endereco_id: endJ.id, pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 2 } } }, TJ, IP())).j;
check('pedido de envio pago no cartao', r2.pagamento && r2.pagamento.situacao === 'aprovado', r2);
await avancar(r2.id, { para: 'em_preparo' });
a1 = await avancar(r2.id, { para: 'pronto' });
check('embalado, aguardando envio', a1.j.situacao === 'aguardando_envio' && (await ver(r2.id)).etapa === 'aguardando_envio', a1.j);
check('enviar sem transportadora -> 400', (await avancar(r2.id, { para: 'saiu_entrega' })).s === 400);
check('link de rastreio invalido -> 400', (await avancar(r2.id, { para: 'saiu_entrega', transportadora: 'Correios', rastreio_url: 'javascript:alert(1)' })).s === 400);
const disp2 = (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima;
const qtd2 = fs.readdirSync(dirEmails).length;
a1 = await avancar(r2.id, { para: 'saiu_entrega', transportadora: 'Correios', rastreio_codigo: 'AA123456789BR', rastreio_url: 'https://rastreamento.correios.com.br/' });
const venda2 = (await prod.query(`SELECT s.cash_session_id, s.forma_pagamento, o.status FROM orders o JOIN sales s ON s.id = o.sale_id WHERE o.id = $1`, [r2.id])).rows[0];
check('enviado com rastreio: vira venda na saida (sem caixa), pedido segue "enviado"', a1.s === 200 && a1.j.situacao === 'enviado' && a1.j.rastreio.codigo === 'AA123456789BR' && venda2 && venda2.cash_session_id === null && venda2.status === 'saiu_entrega', { a: a1.j, venda2 });
check('estoque nao conta duas vezes (vendido sai da reserva)', (await loja('GET', `/produtos/${REFRI.id}`)).j.quantidade_maxima === disp2);
const v2 = await ver(r2.id);
check('cliente ve "Enviado" com transportadora, codigo e link', v2.etapa === 'enviado' && v2.rastreio.transportadora === 'Correios' && v2.rastreio.codigo === 'AA123456789BR' && v2.rastreio.url, v2);
const mailEnv = await ate(async () => (fs.readdirSync(dirEmails).length > qtd2 ? ultimoEmail() : null), 4000);
check('e-mail "enviado" com o codigo de rastreio', mailEnv && /enviado/.test(mailEnv.assunto) && /AA123456789BR/.test(mailEnv.texto), mailEnv);
check('pedido enviado nao pode ser cancelado -> 409', (await api('POST', `/loja-virtual/pedidos/${r2.id}/cancelar`, { motivo: 'teste' }, A)).s === 409);
check('corrigir o rastreio', (await api('PUT', `/loja-virtual/pedidos/${r2.id}/rastreio`, { transportadora: 'Correios', rastreio_codigo: 'BB987654321BR' }, A)).j.rastreio.codigo === 'BB987654321BR');
a1 = await avancar(r2.id, { para: 'finalizado' });
check('marcar como entregue (cliente ve "Entregue")', a1.j.situacao === 'entregue' && (await ver(r2.id)).etapa === 'entregue', a1.j);
check('busca pelo codigo de rastreio', (await site('?situacao=todos&busca=BB98765')).j.pedidos.some((x) => x.id === r2.id));

// Pagar na retirada (dinheiro): vira venda no caixa ao finalizar
const r3 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP())).j;
for (const para of ['em_preparo', 'pronto']) await avancar(r3.id, { para });
const cxAberto = (await prod.query(`SELECT COUNT(*)::int AS n FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE cr.terminal_id = $1 AND cs.fechado_em IS NULL`, [PDVL])).rows[0].n;
if (!cxAberto) await api('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 0 }, A);
a1 = await avancar(r3.id, { para: 'finalizado' });
const venda3 = a1.s === 200 ? (await prod.query(`SELECT s.cash_session_id, s.forma_pagamento FROM orders o JOIN sales s ON s.id = o.sale_id WHERE o.id = $1`, [r3.id])).rows[0] : null;
check('a pagar na retirada: venda em dinheiro no caixa aberto', venda3 && venda3.cash_session_id !== null && venda3.forma_pagamento === 'dinheiro', { a: a1.j, venda3 });

// Cancelar pedido pago antes de enviar: estorna
const r4 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
await avancar(r4.id, { para: 'em_preparo' });
check('cancelar sem motivo -> 400', (await api('POST', `/loja-virtual/pedidos/${r4.id}/cancelar`, {}, A)).s === 400);
const c4 = await api('POST', `/loja-virtual/pedidos/${r4.id}/cancelar`, { motivo: 'sem estoque fisico' }, A);
check('loja cancela pedido pago em separacao: estorna no Mercado Pago', c4.s === 200 && c4.j.situacao === 'cancelado' && c4.j.pagamento.situacao === 'estornado', c4.j);
check('detalhe com itens, historico e cliente', (await api('GET', `/loja-virtual/pedidos/${r2.id}`, null, A)).j.historico.map((h) => h.para).join() === 'novo,em_preparo,pronto,saiu_entrega,finalizado');

// Sem o modulo Pedidos a loja online continua funcionando
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { pedidos: false } }, MAS);
const r5 = await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP());
check('sem o modulo Pedidos: site recebe e a aba gerencia', r5.s === 201 && (await avancar(r5.j.id, { para: 'em_preparo' })).s === 200 && (await api('GET', '/orders', null, A)).s === 403, r5.j);
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { pedidos: true } }, MAS);
const vendaSite = (await prod.query(`SELECT id FROM sales WHERE id = (SELECT sale_id FROM orders WHERE id = $1)`, [r1.id])).rows[0];
check('venda do site (sem caixa) pode ser cancelada em Vendas', (await api('POST', `/sales/${vendaSite.id}/cancel`, { motivo: 'devolucao teste' }, A)).s === 200);


console.log('\n# 20. Frete por transportadora (Melhor Envio)');
const MESIM = process.env.ME_SIM_URL || 'http://localhost:4996';
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'entrada', quantidade: 30, location_destino_id: L.Lanchonete, motivo: 'abastecer e2e frete' }, A);
const mesim = (m, r) => req(m, `${MESIM}${r}`);
const envioAtivoSemConta = await api('PUT', '/loja-virtual/envio', { ativo: true }, A);
check('ligar o envio sem conta conectada -> 422', envioAtivoSemConta.s === 422, envioAtivoSemConta);
check('token invalido -> 422 explicando', (await api('PUT', '/loja-virtual/envio/conta', { token: 'token-invalido-0000000000' }, A)).s === 422);
const con = await api('PUT', '/loja-virtual/envio/conta', { token: `token-simulado-e2e-${crypto.randomUUID()}`, sandbox: true }, A);
check('conecta a conta do Melhor Envio (conta e saldo)', con.s === 200 && /Loja Simulada/.test(con.j.conta) && con.j.saldo === 500, con);
check('token guardado cifrado (nao aparece no banco nem na tela)', !(await prod.query(`SELECT me_token_cript FROM lv_lojas WHERE tenant_id = $1`, [empresa])).rows[0].me_token_cript.includes('token-simulado') && !JSON.stringify((await api('GET', '/loja-virtual', null, A)).j).includes('token-simulado'));
const servs = await api('GET', '/loja-virtual/envio/servicos', null, A);
check('lista os servicos da conta', servs.s === 200 && servs.j.servicos.length === 4 && servs.j.servicos.some((x) => x.id === 1 && x.transportadora === 'Correios'), servs.j);
check('ligar sem CEP de origem -> 422', (await api('PUT', '/loja-virtual/envio', { ativo: true }, A)).s === 422);
check('CPF/CNPJ do remetente invalido -> 400', (await api('PUT', '/loja-virtual/envio', { remetente: { documento: '123' } }, A)).s === 400);
const REMET = { nome: 'Lanchonete JA LTDA', telefone: '11999990000', email: 'contato@ja.com', documento: '11.222.333/0001-81', cep: '01310-100', logradouro: 'Av. Paulista', numero: '1000', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'sp' };
const cfgEnv = await api('PUT', '/loja-virtual/envio', { ativo: true, remetente: REMET, servicos: [1, 2, 3], dias_extra: 2, acrescimo: 3, gratis_acima: null, declaracao: true, padrao: { peso_kg: 0.3, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 } }, A);
check('configura o envio (remetente, servicos, prazo extra, acrescimo)', cfgEnv.s === 200 && cfgEnv.j.disponivel === true && cfgEnv.j.remetente.uf === 'SP' && cfgEnv.j.remetente.documento === '11222333000181' && cfgEnv.j.servicos.join() === '1,2,3', cfgEnv.j);
const simu = await api('POST', '/loja-virtual/envio/simular', { cep: '20040-002' }, A);
check('simular no painel: servicos escolhidos, custo e preco com acrescimo', simu.s === 200 && simu.j.opcoes.length === 3 && simu.j.opcoes.every((o) => igual(o.preco, o.custo + 3)), simu.j);
check('peso do produto invalido -> 400', (await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { peso_kg: 99 }, A)).s === 400);
const med = await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { peso_kg: 0.4, altura_cm: 12, largura_cm: 7, comprimento_cm: 7 }, A);
check('peso e medidas do produto no site', med.s === 200 && Number(med.j.peso_kg) === 0.4 && Number(med.j.altura_cm) === 12, med.j);
const pubEnv = (await loja('GET', '/loja')).j.entrega;
check('site sabe que ha envio por transportadora (e onde vale a entrega da loja)', pubEnv.aceita && pubEnv.transportadora && pubEnv.transportadora.cidade_entrega_local === 'São Paulo', pubEnv);
const ITREFRI = [{ product_id: REFRI.id, quantidade: 2 }];
const fr = await loja('POST', '/frete', { cep: '20040-002', itens: ITREFRI });
const cotRio = (await mesim('GET', '/_sim/cotacoes')).j.slice(-1)[0];
check('calcular frete pelo CEP: opcoes do mais barato ao mais caro, prazo com os dias de separacao', fr.s === 200 && fr.j.opcoes.length === 3 && fr.j.opcoes[0].preco <= fr.j.opcoes[1].preco && fr.j.opcoes.every((o) => o.prazo_dias >= 4) && cotRio.servicos === '1,2,3', { fr: fr.j, cotRio });
check('custo da transportadora nao vai para o site', fr.j.opcoes.every((o) => o.custo === undefined && o.pacotes === undefined));
const frAm = await loja('POST', '/frete', { cep: '69000-000', itens: ITREFRI });
check('servico que nao atende o CEP fica de fora', frAm.j.opcoes.length === 2 && !frAm.j.opcoes.some((o) => o.id === 3), frAm.j);
check('CEP invalido -> 400', (await loja('POST', '/frete', { cep: '123', itens: ITREFRI })).s === 400);
const endRio = (await loja('POST', '/conta/enderecos', { rotulo: 'Rio', cep: '20040-002', logradouro: 'Rua do Ouvidor', numero: '50', bairro: 'Centro', cidade: 'Rio de Janeiro', uf: 'RJ' }, TJ)).j;
let car = (await loja('POST', '/carrinho', { itens: ITREFRI, tipo: 'entrega', endereco_id: endRio.id }, TJ)).j;
check('outra cidade: entrega da loja indisponivel, transportadoras oferecidas, precisa escolher', car.envio.local && car.envio.local.disponivel === false && /só em São Paulo/.test(car.envio.local.motivo) && car.envio.opcoes.length === 3 && !car.pode_finalizar && car.avisos.some((a) => /escolha uma opção de frete/.test(a)), car);
const pac = car.envio.opcoes.find((o) => o.id === 1);
car = (await loja('POST', '/carrinho', { itens: ITREFRI, tipo: 'entrega', endereco_id: endRio.id, frete_servico: 1 }, TJ)).j;
check('escolhe o PAC: frete no total', car.pode_finalizar && igual(car.taxa_entrega, pac.preco) && car.entrega.servico.id === 1 && igual(car.total, car.subtotal + pac.preco), car);
const carSP = (await loja('POST', '/carrinho', { itens: ITREFRI, tipo: 'entrega', endereco_id: endJ.id }, TJ)).j;
check('mesma cidade da loja: entrega da loja pelo bairro continua (e as transportadoras tambem)', carSP.envio.local.disponivel === true && carSP.envio.opcoes.length >= 1 && carSP.pode_finalizar && carSP.entrega.bairro, carSP);
await api('PUT', '/loja-virtual/envio', { gratis_acima: 9 }, A);
const carGratis = (await loja('POST', '/frete', { cep: '20040002', itens: ITREFRI })).j;
check('frete gratis a partir do valor: o mais barato sai gratis', carGratis.opcoes[0].gratis === true && carGratis.opcoes[0].preco === 0 && carGratis.opcoes[1].preco > 0, carGratis);
await api('PUT', '/loja-virtual/envio', { gratis_acima: null }, A);
check('pagar na entrega nao vale para transportadora -> 422', (await loja('POST', '/pedidos', { itens: ITREFRI, tipo: 'entrega', endereco_id: endRio.id, frete_servico: 1, pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP())).s === 422);
check('servico que nao atende o CEP -> 422', (await loja('POST', '/pedidos', { itens: ITREFRI, tipo: 'entrega', endereco_id: endRio.id, frete_servico: 17, pagamento: { metodo: 'pix' } }, TJ, IP())).s === 422);

// Pedido com SEDEX (Correios: codigo de rastreio sai na geracao da etiqueta)
const f1 = (await loja('POST', '/pedidos', { itens: ITREFRI, tipo: 'entrega', endereco_id: endRio.id, frete_servico: 2, pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
const sedex = car.envio.opcoes.find((o) => o.id === 2);
check('pedido com SEDEX: cliente ve o servico e o prazo', f1.frete && f1.frete.servico === 'Correios SEDEX' && f1.frete.prazo_dias === sedex.prazo_dias && igual(f1.taxa_entrega, sedex.preco), f1);
const dbF1 = (await prod.query(`SELECT frete_servico_id, frete_custo, frete_cep, frete_destino, frete_volumes FROM orders WHERE id = $1`, [f1.id])).rows[0];
check('pedido guarda servico, custo cotado, destinatario e pacote para a etiqueta', dbF1.frete_servico_id === 2 && igual(dbF1.frete_custo, sedex.preco - 3) && dbF1.frete_cep === '20040002' && dbF1.frete_destino.cidade === 'Rio de Janeiro' && dbF1.frete_destino.uf === 'RJ' && dbF1.frete_volumes.length === 1, dbF1);
check('etiqueta antes da separacao -> 409', (await api('POST', `/loja-virtual/pedidos/${f1.id}/etiqueta`, {}, A)).s === 409);
await avancar(f1.id, { para: 'em_preparo' });
const et1 = await api('POST', `/loja-virtual/pedidos/${f1.id}/etiqueta`, {}, A);
const simEt1 = (await mesim('GET', '/_sim/envios')).j.find((x) => x.id === (et1.j.frete && et1.j.frete.etiqueta && et1.j.frete.etiqueta.id));
check('compra a etiqueta (remetente, destinatario, volume, declaracao de conteudo)', et1.s === 200 && et1.j.frete.etiqueta.status === 'released' && simEt1 && simEt1.service_id === 2 && simEt1.from.company_document === '11222333000181' && simEt1.to.city === 'Rio de Janeiro' && simEt1.options.non_commercial === true && simEt1.volumes.length === 1, { et: et1.j, simEt1 });
check('saldo do Melhor Envio debitado', (await api('GET', '/loja-virtual/envio/servicos', null, A)).j.saldo < 500);
check('etiqueta repetida -> 409', (await api('POST', `/loja-virtual/pedidos/${f1.id}/etiqueta`, {}, A)).s === 409);
const pdf = await api('GET', `/loja-virtual/pedidos/${f1.id}/etiqueta`, null, A);
check('link para imprimir a etiqueta', pdf.s === 200 && /\/imprimir\//.test(pdf.j.url), pdf.j);
check('cliente ainda nao ve rastreio (nao foi enviado)', (await ver(f1.id)).rastreio === null);
await avancar(f1.id, { para: 'pronto' });
const env1 = await avancar(f1.id, { para: 'saiu_entrega' });
check('enviar com etiqueta: transportadora e codigo vem da etiqueta', env1.s === 200 && env1.j.rastreio.transportadora === 'Correios SEDEX' && /^SM\d+BR$/.test(env1.j.rastreio.codigo) && /melhorrastreio/.test(env1.j.rastreio.url), env1.j);
const v1c = await ver(f1.id);
check('cliente ve "Enviado" com o codigo de rastreio', v1c.etapa === 'enviado' && v1c.rastreio.codigo === env1.j.rastreio.codigo, v1c);
await mesim('POST', `/_sim/envios/${simEt1.id}/postar`);
await mesim('POST', `/_sim/envios/${simEt1.id}/entregar`);
const entregue = await ate(async () => { const v = await ver(f1.id); return v.etapa === 'entregue' ? v : null; }, 15000);
check('transportadora entregou: pedido vira "Entregue" sozinho', !!entregue, await ver(f1.id));

// Jadlog: codigo so depois da postagem
const f2 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'entrega', endereco_id: endRio.id, frete_servico: 3, pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
await avancar(f2.id, { para: 'em_preparo' });
const et2 = (await api('POST', `/loja-virtual/pedidos/${f2.id}/etiqueta`, {}, A)).j;
check('Jadlog: etiqueta sem codigo ainda', et2.frete.etiqueta && !et2.rastreio, et2);
await mesim('POST', `/_sim/envios/${et2.frete.etiqueta.id}/postar`);
const comCodigo = await ate(async () => { const d = (await api('GET', `/loja-virtual/pedidos/${f2.id}`, null, A)).j; return d.rastreio && /^JD/.test(d.rastreio.codigo) ? d : null; }, 15000);
check('postado: o codigo de rastreio entra sozinho no pedido', comCodigo && comCodigo.frete.etiqueta.status === 'posted', comCodigo);

// Cancelar pedido com etiqueta nao postada: cancela a etiqueta (saldo volta) e estorna o pagamento
const f3 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'entrega', endereco_id: endRio.id, frete_servico: 1, pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
await avancar(f3.id, { para: 'em_preparo' });
const et3 = (await api('POST', `/loja-virtual/pedidos/${f3.id}/etiqueta`, {}, A)).j;
const saldoAntes = (await api('GET', '/loja-virtual/envio/servicos', null, A)).j.saldo;
const c3e = await api('POST', `/loja-virtual/pedidos/${f3.id}/cancelar`, { motivo: 'cliente desistiu' }, A);
const simEt3 = (await mesim('GET', '/_sim/envios')).j.find((x) => x.id === et3.frete.etiqueta.id);
check('cancelar pedido: cancela a etiqueta no Melhor Envio (saldo volta) e estorna o pagamento', c3e.s === 200 && c3e.j.situacao === 'cancelado' && c3e.j.pagamento.situacao === 'estornado' && simEt3.status === 'canceled' && (await api('GET', '/loja-virtual/envio/servicos', null, A)).j.saldo > saldoAntes, { c: c3e.j, simEt3 });
check('pedido com etiqueta postada nao cancela -> 409', (await api('POST', `/loja-virtual/pedidos/${f2.id}/cancelar`, { motivo: 'teste' }, A)).s === 409);

// Conta sem saldo e NF-e obrigatoria
await api('PUT', '/loja-virtual/envio/conta', { token: `token-semsaldo-e2e-${crypto.randomUUID()}`, sandbox: true }, A);
await api('PUT', '/loja-virtual/envio', { declaracao: false }, A);
const f4 = (await loja('POST', '/pedidos', { itens: [{ product_id: REFRI.id, quantidade: 1 }], tipo: 'entrega', endereco_id: endRio.id, frete_servico: 1, pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
await avancar(f4.id, { para: 'em_preparo' });
check('sem declaracao de conteudo: pede a chave da NF-e -> 400', (await api('POST', `/loja-virtual/pedidos/${f4.id}/etiqueta`, {}, A)).s === 400);
const semSaldo = await api('POST', `/loja-virtual/pedidos/${f4.id}/etiqueta`, { nfe: '3'.repeat(44) }, A);
check('sem saldo no Melhor Envio: recusa explicando', semSaldo.s === 422 && /[Ss]aldo/.test(semSaldo.j.erro), semSaldo);
await api('POST', `/loja-virtual/pedidos/${f4.id}/cancelar`, { motivo: 'teste' }, A);
check('desconectar desliga o envio no site', (await api('DELETE', '/loja-virtual/envio/conta', null, A)).s === 204 && (await loja('GET', '/loja')).j.entrega.transportadora === null);


console.log('\n# 21. Desconto no Pix, produtos +18 e so retirada');
check('desconto no Pix acima de 30% -> 400', (await api('PUT', '/loja-virtual', { pix_desconto_pct: 31 }, A)).s === 400);
check('salva 5% de desconto no Pix', (await api('PUT', '/loja-virtual', { pix_desconto_pct: 5 }, A)).j.pix_desconto_pct === 5);
check('site recebe o % do Pix', (await loja('GET', '/loja')).j.pagamentos.pix_desconto_pct === 5);
const IT2 = [{ product_id: REFRI.id, quantidade: 2 }];
const semPix = (await loja('POST', '/carrinho', { itens: IT2, tipo: 'retirada' }, TJ)).j;
check('carrinho mostra o total no Pix sem aplicar', semPix.pix && semPix.pix.aplicado === false && igual(semPix.pix.desconto, semPix.subtotal * 0.05) && igual(semPix.total, semPix.subtotal) && igual(semPix.pix.total_pix, semPix.subtotal * 0.95), semPix);
const comPix = (await loja('POST', '/carrinho', { itens: IT2, tipo: 'retirada', pagamento: 'pix' }, TJ)).j;
check('pagando com Pix: desconto no total', comPix.pix.aplicado === true && igual(comPix.total, comPix.subtotal * 0.95), comPix);
const px = (await loja('POST', '/pedidos', { itens: IT2, tipo: 'retirada', pagamento: { metodo: 'pix' } }, TJ, IP())).j;
const mpPx = (await sim('GET', '/_sim/pagamentos')).j.find((x) => x.external_reference === px.id);
check('pedido no Pix: desconto gravado e cobranca com o valor com desconto', igual(px.desconto_pix, comPix.pix.desconto) && igual(px.total, comPix.total) && mpPx && igual(mpPx.transaction_amount, comPix.total), { px, mpPx });
check('pedido com desconto do Pix nao pode ser pago no cartao -> 409', (await loja('POST', `/pedidos/${px.id}/pagamento`, { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } }, TJ)).s === 409);
await sim('POST', `/_sim/pagamentos/${mpPx.id}/aprovar`);
await ate(async () => ((await ver(px.id)).etapa === 'pagamento_aprovado'));
for (const para of ['em_preparo', 'pronto', 'finalizado']) await avancar(px.id, { para });
const vPx = (await prod.query(`SELECT s.desconto, s.total FROM orders o JOIN sales s ON s.id = o.sale_id WHERE o.id = $1`, [px.id])).rows[0];
check('venda leva o desconto do Pix', vPx && igual(vPx.desconto, comPix.pix.desconto) && igual(vPx.total, comPix.total), vPx);
const cartaoSemDesc = (await loja('POST', '/pedidos', { itens: IT2, tipo: 'retirada', pagamento: { metodo: 'cartao', cartao: { token: 'cartao-aprovado', payment_method_id: 'master', parcelas: 1 } } }, TJ, IP())).j;
check('no cartao nao tem desconto do Pix', cartaoSemDesc.desconto_pix === 0 && igual(cartaoSemDesc.total, comPix.subtotal), cartaoSemDesc);
await api('POST', `/loja-virtual/pedidos/${cartaoSemDesc.id}/cancelar`, { motivo: 'teste' }, A);
await api('PUT', '/loja-virtual', { pix_desconto_pct: 0 }, A);

await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { maior_idade: true }, A);
check('produto +18 no site', (await loja('GET', `/produtos/${REFRI.id}`)).j.maior_idade === true);
const c18 = (await loja('POST', '/carrinho', { itens: IT2, tipo: 'retirada' }, TJ)).j;
check('carrinho avisa que ha produto +18', c18.maior_idade === true);
check('pedido +18 sem declarar a idade -> 422', (await loja('POST', '/pedidos', { itens: IT2, tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP())).s === 422);
const p18 = await loja('POST', '/pedidos', { itens: IT2, tipo: 'retirada', maior_idade: true, pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP());
check('declarando 18+: pedido aceito e declaracao registrada (painel mostra)', p18.s === 201 && !!(await api('GET', `/loja-virtual/pedidos/${p18.j.id}`, null, A)).j.maior_idade_declarada_em, p18.j);
await api('POST', `/loja-virtual/pedidos/${p18.j.id}/cancelar`, { motivo: 'teste' }, A);
await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { maior_idade: false, so_retirada: true }, A);
check('produto so retirada no site', (await loja('GET', `/produtos/${REFRI.id}`)).j.so_retirada === true);
const cRet = (await loja('POST', '/carrinho', { itens: IT2, tipo: 'entrega', endereco_id: endJ.id }, TJ)).j;
check('so retirada: entrega bloqueada com o motivo', cRet.so_retirada === true && cRet.pode_finalizar === false && cRet.avisos.some((a) => /só retirada/.test(a)), cRet);
check('pedido de entrega com produto so retirada -> 422', (await loja('POST', '/pedidos', { itens: IT2, tipo: 'entrega', endereco_id: endJ.id, pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP())).s === 422);
const pRet = await loja('POST', '/pedidos', { itens: IT2, tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP());
check('retirada continua valendo', pRet.s === 201, pRet.j);
await api('POST', `/loja-virtual/pedidos/${pRet.j.id}/cancelar`, { motivo: 'teste' }, A);
await api('PUT', `/loja-virtual/produtos/${REFRI.id}`, { so_retirada: false }, A);
check('site para maiores de 18: aviso de idade na entrada', (await api('PUT', '/loja-virtual', { site_maior_idade: true }, A)).j.site_maior_idade === true && (await loja('GET', '/loja')).j.maior_idade === true);
await api('PUT', '/loja-virtual', { site_maior_idade: false }, A);


console.log('\n# 22. Grades de variacoes (cor, tamanho): sistema e site');
const catRoupas = (await api('POST', '/categories', { nome: 'Roupas' }, A)).j;
check('mais de 3 atributos -> 400', (await api('POST', '/grades', { nome: 'Teste', categoria_id: catRoupas.id, preco_custo: 10, preco_venda: 20, atributos: [{ nome: 'A', valores: ['1'] }, { nome: 'B', valores: ['1'] }, { nome: 'C', valores: ['1'] }, { nome: 'D', valores: ['1'] }] }, A)).s === 400);
check('atributo repetido -> 400', (await api('POST', '/grades', { nome: 'Teste', categoria_id: catRoupas.id, preco_custo: 10, preco_venda: 20, atributos: [{ nome: 'Cor', valores: ['Azul'] }, { nome: 'cor', valores: ['Verde'] }] }, A)).s === 400);
check('codigo de barras ja usado -> 409', (await api('POST', '/grades', { nome: 'Teste', categoria_id: catRoupas.id, preco_custo: 10, preco_venda: 20, atributos: [{ nome: 'Cor', valores: ['Azul'] }], variacoes: [{ variacao: { Cor: 'Azul' }, barcode: REFRI.barcode }] }, A)).s === 409);
const gr = await api('POST', '/grades', {
  nome: 'Camiseta Básica', categoria_id: catRoupas.id, unidade: 'UN', preco_custo: 20, preco_venda: 49.9, location_id: L.Lanchonete,
  atributos: [{ nome: 'Cor', valores: ['Preta', 'Branca'] }, { nome: 'Tamanho', valores: ['P', 'M'] }],
  variacoes: [
    { variacao: { Cor: 'Preta', Tamanho: 'P' }, estoque_inicial: 2 }, { variacao: { Cor: 'Preta', Tamanho: 'M' }, estoque_inicial: 0, barcode: '7890000000017' },
    { variacao: { Cor: 'Branca', Tamanho: 'P' }, estoque_inicial: 5 }, { variacao: { Cor: 'Branca', Tamanho: 'M' }, estoque_inicial: 1, preco_venda: 59.9 },
  ],
}, A);
const VAR = (cor, tam) => gr.j.variacoes.find((v) => v.variacao.Cor === cor && v.variacao.Tamanho === tam);
const eanOk = (e) => { const d = e.split('').map(Number); const s = d.slice(0, 12).reduce((t, x, i) => t + x * (i % 2 ? 3 : 1), 0); return (10 - (s % 10)) % 10 === d[12]; };
check('cria a grade: 4 variacoes como produtos, com estoque, preco e nome proprios', gr.s === 201 && gr.j.variacoes.length === 4 && VAR('Preta', 'P').nome === 'Camiseta Básica - Preta - P' && VAR('Preta', 'P').saldo_total === 2 && VAR('Branca', 'M').preco_venda === 59.9 && VAR('Preta', 'M').barcode === '7890000000017', gr.j);
check('codigo de barras interno gerado (EAN-13 com prefixo 2, digito valido)', /^2\d{12}$/.test(VAR('Preta', 'P').barcode) && eanOk(VAR('Preta', 'P').barcode), VAR('Preta', 'P').barcode);
const listaProd = (await api('GET', '/products', null, A)).j.filter((p) => p.grade_id === gr.j.id);
check('variacoes na lista de produtos com a grade', listaProd.length === 4 && listaProd.every((p) => p.grade_nome === 'Camiseta Básica' && p.variacao.Cor), listaProd.length);
const pdv = (await api('GET', `/products/search?barcode=${VAR('Branca', 'P').barcode}&location_id=${L.Lanchonete}`, null, A)).j;
check('PDV acha a variacao pelo codigo de barras, com o saldo dela', JSON.stringify(pdv).includes(VAR('Branca', 'P').id) && JSON.stringify(pdv).includes('Branca - P'), pdv);
check('grade fora do site ainda', (await loja('GET', '/produtos?busca=camiseta')).j.total === 0);
const imgG = (await api('POST', '/loja-virtual/imagens', png, A, { 'content-type': 'image/png' })).j;
const imgPreta = (await api('POST', '/loja-virtual/imagens', png, A, { 'content-type': 'image/png' })).j;
check('foto de valor que nao existe -> 400', (await api('PUT', `/loja-virtual/grades/${gr.j.id}`, { atributo_foto: 'Cor', fotos_por_valor: { Roxa: [imgG.id] } }, A)).s === 400);
const pubG = await api('PUT', `/loja-virtual/grades/${gr.j.id}`, { publicado: true, descricao: '100% algodão', imagens: [imgG.id], atributo_foto: 'Cor', fotos_por_valor: { Preta: [imgPreta.id] }, promo_pct: 10 }, A);
check('publica a grade no site (fotos gerais, por cor e promocao em %)', pubG.s === 200, pubG.j);
const admG = (await api('GET', '/loja-virtual/grades', null, A)).j.find((x) => x.id === gr.j.id);
check('painel lista a grade (no site, faixa de preco)', admG && admG.publicado && admG.preco_min === 49.9 && admG.preco_max === 59.9 && admG.fotos_por_valor.Preta.length === 1, admG);
check('variacoes nao aparecem soltas em Produtos no site', !(await api('GET', '/loja-virtual/produtos?busca=Camiseta', null, A)).j.itens.length);
const siteG = (await loja('GET', '/produtos?busca=camiseta')).j;
const cam = siteG.produtos[0];
check('site: um produto so para a grade, "a partir de" com a promocao', siteG.total === 1 && cam.grade && cam.grade.variacoes.length === 4 && cam.preco_varia === true && igual(cam.preco, 44.91) && cam.disponivel === true && cam.nome === 'Camiseta Básica', siteG);
const vPretaM = cam.grade.variacoes.find((v) => v.variacao.Cor === 'Preta' && v.variacao.Tamanho === 'M');
const vPretaP = cam.grade.variacoes.find((v) => v.variacao.Cor === 'Preta' && v.variacao.Tamanho === 'P');
const vBrancaP = cam.grade.variacoes.find((v) => v.variacao.Cor === 'Branca' && v.variacao.Tamanho === 'P');
check('variacao sem estoque aparece indisponivel; atributos e foto por cor', vPretaM.disponivel === false && vPretaP.disponivel === true && vPretaP.quantidade_maxima === 2 && cam.grade.atributo_foto === 'Cor' && vPretaP.imagens[0].includes(imgPreta.id) && vBrancaP.imagens[0].includes(imgG.id) && cam.grade.atributos.map((a) => a.nome).join() === 'Cor,Tamanho', cam.grade);
check('busca por um valor da variacao acha a grade', (await loja('GET', '/produtos?busca=branca')).j.produtos.some((p) => p.grade && p.grade.id === gr.j.id));
check('categoria conta a grade uma vez', (await loja('GET', '/categorias')).j.find((c) => c.id === catRoupas.id).produtos === 1);
const pBM = (await loja('GET', `/produtos/${VAR('Branca', 'M').id}`)).j;
check('abrir uma variacao traz a grade com ela selecionada', pBM.grade && pBM.grade.selecionada === VAR('Branca', 'M').id, pBM.grade && pBM.grade.selecionada);
const carG = (await loja('POST', '/carrinho', { itens: [{ product_id: VAR('Branca', 'M').id, quantidade: 1 }], tipo: 'retirada' }, TJ)).j;
check('carrinho com a variacao: preco dela com a promocao e o nome completo', igual(carG.itens[0].preco_unitario, 53.91) && /Branca - M/.test(carG.itens[0].nome), carG.itens[0]);
const pedG = await loja('POST', '/pedidos', { itens: [{ product_id: VAR('Branca', 'M').id, quantidade: 1 }], tipo: 'retirada', pagamento: { metodo: 'na_entrega', forma: 'dinheiro' } }, TJ, IP());
const depois = (await loja('GET', `/produtos/${cam.id}`)).j.grade.variacoes.find((v) => v.id === VAR('Branca', 'M').id);
check('pedido reserva o estoque da variacao (Branca M esgota)', pedG.s === 201 && depois.disponivel === false, { s: pedG.s, depois });
await api('POST', `/loja-virtual/pedidos/${pedG.j.id}/cancelar`, { motivo: 'teste' }, A);
const lote = await api('PUT', `/grades/${gr.j.id}`, { preco_venda: 55 }, A);
check('preco em lote nas variacoes; promocao do site acompanha', lote.j.variacoes.every((v) => v.preco_venda === 55) && igual((await loja('GET', `/produtos/${cam.id}`)).j.preco, 49.5), lote.j.variacoes.map((v) => v.preco_venda));
const ren = await api('PUT', `/grades/${gr.j.id}`, { nome: 'Camiseta Algodão' }, A);
check('renomear a grade renomeia as variacoes', ren.j.variacoes.every((v) => v.nome.startsWith('Camiseta Algodão - ')));
const novosV = await api('POST', `/grades/${gr.j.id}/valores`, { valores: { Cor: ['Azul'] } }, A);
check('novo valor (Azul): cria so as combinacoes com Azul', novosV.s === 200 && novosV.j.variacoes.length === 6 && novosV.j.variacoes.filter((v) => v.variacao.Cor === 'Azul').length === 2, novosV.j.variacoes && novosV.j.variacoes.length);
const azulP = novosV.j.variacoes.find((v) => v.variacao.Cor === 'Azul' && v.variacao.Tamanho === 'P');
check('variacao nova ja vai para o site (sem estoque)', (await loja('GET', `/produtos/${cam.id}`)).j.grade.variacoes.some((v) => v.id === azulP.id && v.disponivel === false));
await api('PATCH', `/products/${azulP.id}/status`, { ativo: false }, A);
check('variacao desativada sai do site', !(await loja('GET', `/produtos/${cam.id}`)).j.grade.variacoes.some((v) => v.id === azulP.id));
await api('PUT', `/loja-virtual/grades/${gr.j.id}`, { publicado: false }, A);
check('tirar a grade do site', (await loja('GET', '/produtos?busca=camiseta')).j.total === 0);

console.log('\n# 23. Produtos ja cadastrados viram uma grade');
const ean = () => `78${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
const novoProd = async (nome, qtd, extra = {}) => (await api('POST', '/products', { nome, categoria_id: catRoupas.id, barcode: ean(), unidade: 'UN', preco_custo: 15, preco_venda: 39.9, location_id: L.Lanchonete, estoque_inicial: qtd, ...extra }, A)).j;
const bPreto = await novoProd('Boné Aba Curva Preto', 3);
const bVerm = await novoProd('Boné Aba Curva Vermelho', 0);
const bAzul = await novoProd('Boné Aba Curva Azul', 4);
const bKg = await novoProd('Boné Aba Curva Granel', 1, { unidade: 'KG' });
const fotoPreto = (await api('POST', '/loja-virtual/imagens', png, A, { 'content-type': 'image/png' })).j;
await api('PUT', `/loja-virtual/produtos/${bPreto.id}`, { publicado: true, descricao: 'Aba curva, regulagem atrás', imagens: [fotoPreto.id], destaque: true }, A);
await api('PUT', `/loja-virtual/produtos/${bAzul.id}`, { publicado: true }, A);
const conv = (produtos, extra = {}) => api('POST', '/grades/converter', { nome: 'Boné Aba Curva', atributos: [{ nome: 'Cor' }], produtos, ...extra }, A);
const P = (p, Cor) => ({ product_id: p.id, variacao: { Cor } });
check('converter: menos de 2 produtos -> 400', (await conv([P(bPreto, 'Preto')])).s === 400);
check('converter: combo/ficha tecnica -> 400', (await conv([P(bPreto, 'Preto'), P(XB, 'X')])).s === 400);
check('converter: produto que ja esta em grade -> 409', (await conv([P(bPreto, 'Preto'), P(VAR('Preta', 'P'), 'Y')])).s === 409);
check('converter: unidades diferentes -> 400', (await conv([P(bPreto, 'Preto'), P(bKg, 'Granel')])).s === 400);
check('converter: dois produtos com a mesma variacao -> 400', (await conv([P(bPreto, 'Preto'), P(bVerm, 'preto')])).s === 400);
check('converter: valor em branco -> 400', (await conv([P(bPreto, 'Preto'), P(bVerm, ' ')])).s === 400);
check('converter: produto de outra empresa/inexistente -> 404', (await conv([P(bPreto, 'Preto'), { product_id: '00000000-0000-0000-0000-000000000000', variacao: { Cor: 'Z' } }])).s === 404);
const cv = await conv([P(bPreto, 'Preto'), P(bVerm, 'Vermelho'), P(bAzul, 'Azul')]);
const cvV = (cor) => cv.j.variacoes.find((v) => v.variacao.Cor === cor);
check('converte: os mesmos produtos (id, codigo, codigo de barras, estoque) viram as variacoes',
  cv.s === 201 && cv.j.variacoes.length === 3 && cvV('Preto').id === bPreto.id && cvV('Preto').barcode === bPreto.barcode && cvV('Preto').codigo_interno === bPreto.codigo_interno
  && cvV('Preto').saldo_total === 3 && cvV('Azul').saldo_total === 4 && cvV('Preto').nome === 'Boné Aba Curva - Preto' && cv.j.atributos[0].valores.join() === 'Preto,Vermelho,Azul', cv.j);
check('converte: produtos que estavam no site deixam a grade publicada', cv.j.site_publicado === true);
const admB = (await api('GET', '/loja-virtual/grades', null, A)).j.find((x) => x.id === cv.j.id);
check('site: foto do produto vira a foto do valor (Preto) e a descricao passa para a grade', admB.publicado && admB.atributo_foto === 'Cor' && admB.fotos_por_valor.Preto[0].id === fotoPreto.id && admB.descricao === 'Aba curva, regulagem atrás' && admB.destaque, admB);
const siteB = (await loja('GET', '/produtos?busca=aba curva')).j;
check('site: os 3 bonés viram um produto so com seletor de cor', siteB.total === 1 && siteB.produtos[0].grade.variacoes.length === 3 && siteB.produtos[0].grade.variacoes.find((v) => v.id === bPreto.id).imagens[0].includes(fotoPreto.id), siteB);
check('incluir: unidade diferente -> 400; valor que ja existe -> 409', (await api('POST', `/grades/${cv.j.id}/produtos`, { product_id: bKg.id, variacao: { Cor: 'Verde' } }, A)).s === 400
  && (await api('POST', `/grades/${cv.j.id}/produtos`, { product_id: (await novoProd('Boné Aba Curva Preto 2', 0)).id, variacao: { Cor: 'preto' } }, A)).s === 409);
const bVerde = await novoProd('Boné Aba Curva Verde', 2);
const inc = await api('POST', `/grades/${cv.j.id}/produtos`, { product_id: bVerde.id, variacao: { Cor: 'Verde' } }, A);
check('incluir produto ja cadastrado numa grade existente (valor novo entra na grade)', inc.s === 200 && inc.j.variacoes.length === 4 && inc.j.atributos[0].valores.includes('Verde') && inc.j.variacoes.find((v) => v.id === bVerde.id).nome === 'Boné Aba Curva - Verde', inc.j);
check('incluido ja aparece no site', (await loja('GET', `/produtos/${bPreto.id}`)).j.grade.variacoes.some((v) => v.id === bVerde.id && v.disponivel));
const ret = await api('DELETE', `/grades/${cv.j.id}/produtos/${bVerde.id}`, null, A);
const verdeDepois = (await api('GET', '/products', null, A)).j.find((p) => p.id === bVerde.id);
check('tirar da grade: volta a ser avulso com o mesmo estoque', ret.s === 200 && ret.j.variacoes.length === 3 && verdeDepois.grade_id === null && verdeDepois.variacao === null && verdeDepois.saldos_por_local.some((s) => Number(s.saldo) === 2), verdeDepois);
const desf = await api('DELETE', `/grades/${cv.j.id}`, null, A);
const avulsosB = (await api('GET', '/products', null, A)).j.filter((p) => [bPreto.id, bVerm.id, bAzul.id].includes(p.id));
check('desfazer a grade: os produtos voltam a ser avulsos', desf.s === 200 && desf.j.produtos === 3 && avulsosB.every((p) => !p.grade_id) && (await api('GET', `/grades/${cv.j.id}`, null, A)).s === 404, desf.j);
check('desfeita: no site cada um aparece separado, com a propria foto', (await loja('GET', `/produtos/${bPreto.id}`)).j.imagens[0].includes(fotoPreto.id) && !(await loja('GET', `/produtos/${bPreto.id}`)).j.grade);

await prod.query(`DELETE FROM lv_lojas WHERE tenant_id = $1`, [outra]).catch(() => {});
await prod.query(`DELETE FROM tenants WHERE id = $1`, [outra]).catch(() => {}); // pode ficar se houver auditoria

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
process.exit(fail ? 1 : 0);
