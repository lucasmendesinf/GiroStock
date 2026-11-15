// e2e do WhatsApp (API oficial, etapa 1): modulo, conexao (cadastro incorporado), modelos, teste, avisos de cada etapa do
// pedido, webhook (entregue/lida/falhou, assinatura), regras (plataforma, sem celular, cancelado), desconectar, permissoes.
// Precisa do servidor com WHATSAPP_SIMULADOR=1, WHATSAPP_GRAPH_URL=http://localhost:4994, WHATSAPP_APP_ID, WHATSAPP_APP_SECRET
// (= SIM_APP_SECRET do simulador), WHATSAPP_CONFIG_ID, WHATSAPP_VERIFY_TOKEN e WHATSAPP_VARREDURA_SEGUNDOS=2, e do
// simulador rodando: node scripts/whatsapp-simulador.mjs
// npm run test:e2e:whatsapp
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const SIM = process.env.WHATSAPP_GRAPH_URL || 'http://localhost:4994';
const SEGREDO = process.env.WHATSAPP_APP_SECRET || 'segredo-simulador';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.wa.master@girostock.local';
const SENHA_M = rnd();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const sim = async (rota, body) => (await fetch(SIM + rota, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E WA Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);
async function novaEmpresa(rotulo) {
  const email = `e2e.wa.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E WA ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Lanchonete Centro', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: rnd() }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
// mensagens que o simulador recebeu para um telefone
const paraTel = async (tel) => (await sim('/__sim/mensagens')).enviadas.filter((m) => m.to === tel);
const aguardar = async (fn, ms = 9000) => { const fim = Date.now() + ms; let v; while (Date.now() < fim) { v = await fn(); if (v) return v; await espera(400); } return v; };

await sim('/__sim/limpar');
console.log('\n# 1. Módulo e conexão');
const E = await novaEmpresa('a');
check('sem o módulo: /whatsapp -> 403', (await api('GET', '/whatsapp', null, E.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, whatsapp: true } }, MAS);
const ini = await api('GET', '/whatsapp', null, E.token);
check('com o módulo: ainda não conectado, integração da Meta disponível', ini.s === 200 && ini.j.conectado === false && ini.j.meta.disponivel === true && ini.j.meta.config_id, ini.j);
check('conexão incompleta -> 400', (await api('POST', '/whatsapp/conectar', { code: 'abc' }, E.token)).s === 400);
check('code recusado pela Meta -> 422', (await api('POST', '/whatsapp/conectar', { code: 'invalido', waba_id: '111', phone_number_id: '222' }, E.token)).s === 422);
await sim('/__sim/modelos', { status: 'PENDING' });
const con = await api('POST', '/whatsapp/conectar', { code: 'code-ok', waba_id: '1110001', phone_number_id: '2220001' }, E.token);
check('conecta: número, nome e coexistência (continua no celular)', con.s === 200 && con.j.conectado && con.j.numero === '+55 41 99520-9684' && con.j.nome === 'J&A Conveniência' && con.j.coexistencia === true, con.j);
check('cria os 6 modelos de mensagem (em análise na Meta)', con.j.modelos.length === 6 && con.j.modelos.every((m) => m.status === 'PENDING'), con.j.modelos);
check('token fica cifrado no banco', !(await db.query(`SELECT token_cript FROM whatsapp_contas WHERE tenant_id = $1`, [E.id])).rows[0].token_cript.includes('EAASIM'));
check('teste antes da aprovação do modelo -> 409', (await api('POST', '/whatsapp/teste', { telefone: '41 99999-1111' }, E.token)).s === 409);

console.log('\n# 2. Pedido com modelo ainda em análise');
const L = (await db.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
await db.query(`UPDATE locations SET usa_pedidos = true WHERE id = $1`, [L]);
await api('POST', '/categories', { nome: 'Lanches' }, E.token);
const CAT = (await api('GET', '/categories', null, E.token)).j[0].id;
const PROD = (await api('POST', '/products', { nome: 'X-Salada', categoria_id: CAT, barcode: String(Date.now()).slice(-12), unidade: 'UN', preco_custo: 5, preco_venda: 20, location_id: L, estoque_inicial: 100 }, E.token)).j.id;
const pedido = (tel, tipo = 'entrega', extra = {}) => api('POST', '/orders', { location_id: L, origem: 'whatsapp', tipo, cliente_nome: 'Maria Souza', cliente_telefone: tel, endereco: tipo === 'entrega' ? 'Rua A, 10' : '', taxa_entrega: tipo === 'entrega' ? 5 : 0, itens: [{ product_id: PROD, quantidade: 2 }], ...extra }, E.token);
const p0 = await pedido('(41) 98888-0001');
await aguardar(async () => (await db.query(`SELECT 1 FROM whatsapp_mensagens WHERE order_id = $1`, [p0.j.id])).rows.length);
const ign = (await db.query(`SELECT situacao, motivo FROM whatsapp_mensagens WHERE order_id = $1`, [p0.j.id])).rows[0];
check('modelo não aprovado: o aviso não sai (fica registrado o motivo)', ign && ign.situacao === 'ignorada' && /não aprovado/.test(ign.motivo) && !(await paraTel('5541988880001')).length, ign);
await sim('/__sim/modelos', { status: null });
const conf = await api('POST', '/whatsapp/modelos/conferir', {}, E.token);
check('atualizar modelos: aprovados', conf.j.modelos.every((m) => m.status === 'APPROVED'), conf.j.modelos);

console.log('\n# 3. Teste e webhook');
check('teste: telefone inválido -> 400', (await api('POST', '/whatsapp/teste', { telefone: '123' }, E.token)).s === 400);
const t1 = await api('POST', '/whatsapp/teste', { telefone: '(41) 99999-1111' }, E.token);
check('teste enviado (55 + DDD + número)', t1.s === 200 && t1.j.telefone === '5541999991111' && t1.j.wamid, t1.j);
const lida = await aguardar(async () => (await api('GET', '/whatsapp/mensagens', null, E.token)).j.find((m) => m.evento === 'teste' && m.situacao === 'lida'));
check('webhook da Meta: a mensagem passa a "lida"', !!lida, (await api('GET', '/whatsapp/mensagens', null, E.token)).j);
const tf = await api('POST', '/whatsapp/teste', { telefone: '(41) 99999-0000' }, E.token);
check('número que a Meta não entrega: erro com o motivo e registro "falhou"', tf.s === 422 && /undeliverable/.test(tf.j.erro) && (await api('GET', '/whatsapp/mensagens', null, E.token)).j.some((m) => m.situacao === 'falhou'), tf.j);
const corpo = JSON.stringify({ entry: [] });
const ass = (s) => `sha256=${crypto.createHmac('sha256', s).update(corpo).digest('hex')}`;
check('webhook com assinatura errada -> 401', (await fetch(`${B}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': ass('outro') }, body: corpo })).status === 401);
check('webhook com assinatura certa -> 200', (await fetch(`${B}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'x-hub-signature-256': ass(SEGREDO) }, body: corpo })).status === 200);
const vt = process.env.WHATSAPP_VERIFY_TOKEN;
check('verificação do webhook pela Meta (hub.challenge)', (await (await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=987`)).text()) === '987');
check('verificação com token errado -> 403', (await fetch(`${B}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status === 403);

console.log('\n# 4. Avisos de cada etapa do pedido (entrega)');
const TEL = '5541977771111';
const p1 = (await pedido('(41) 97777-1111')).j;
const m1 = await aguardar(async () => (await paraTel(TEL)).find((m) => m.modelo === 'girostock_pedido_recebido'));
check('pedido recebido: nome, nº do pedido, loja e total (itens + taxa)', m1 && m1.params[0] === 'Maria' && m1.params[1] === String(p1.numero) && m1.params[2] === 'Lanchonete Centro' && m1.params[3] === 'R$ 45,00', m1);
await api('POST', `/orders/${p1.id}/status`, { para: 'em_preparo' }, E.token);
check('em preparo: avisa', !!(await aguardar(async () => (await paraTel(TEL)).find((m) => m.modelo === 'girostock_pedido_em_preparo'))));
await api('POST', `/orders/${p1.id}/status`, { para: 'pronto' }, E.token);
const ENT = (await api('POST', '/couriers', { nome: 'João Motoboy', telefone: '(41) 98888-7777' }, E.token)).j.id;
await api('POST', `/orders/${p1.id}/status`, { para: 'saiu_entrega', entregador_id: ENT }, E.token);
const m3 = await aguardar(async () => (await paraTel(TEL)).find((m) => m.modelo === 'girostock_pedido_saiu_entrega'));
check('saiu para entrega: com o nome do entregador', m3 && m3.params[3] === 'João Motoboy', m3);
check('"pronto" de pedido de entrega não manda aviso', !(await paraTel(TEL)).some((m) => m.modelo === 'girostock_pedido_pronto_retirada'));
const T = (await api('POST', '/terminals', { location_id: L, nome: 'Caixa 1' }, E.token)).j.id;
await api('POST', '/cash-sessions', { terminal_id: T, valor_inicial: 0 }, E.token);
await api('POST', `/orders/${p1.id}/status`, { para: 'finalizado', forma_pagamento: 'pix' }, E.token);
await espera(3500);
check('entregue: desligado por padrão (não manda)', !(await paraTel(TEL)).some((m) => m.modelo === 'girostock_pedido_entregue'));
const hist = (await api('GET', `/whatsapp/mensagens?order_id=${p1.id}`, null, E.token)).j;
check('histórico do pedido: 3 avisos, com situação da Meta', hist.length === 3 && hist.every((m) => ['enviada', 'entregue', 'lida'].includes(m.situacao)), hist.map((m) => [m.evento, m.situacao]));
check('cada mudança avisa uma vez só', (await paraTel(TEL)).length === 3);

console.log('\n# 5. Configuração dos avisos e outras regras');
const av = await api('PUT', '/whatsapp/avisos', { avisos: { entregue: true, em_preparo: false, invalido: true } }, E.token);
check('liga "entregue" e desliga "em preparo"', av.j.avisos.entregue === true && av.j.avisos.em_preparo === false && av.j.avisos.invalido === undefined, av.j.avisos);
const TEL2 = '5541966661111';
const p2 = (await pedido('41966661111', 'retirada')).j;
await aguardar(async () => (await paraTel(TEL2)).length);
await api('POST', `/orders/${p2.id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${p2.id}/status`, { para: 'pronto' }, E.token);
const m5 = await aguardar(async () => (await paraTel(TEL2)).find((m) => m.modelo === 'girostock_pedido_pronto_retirada'));
check('retirada: "pronto para retirar" avisa; "em preparo" desligado não', !!m5 && !(await paraTel(TEL2)).some((m) => m.modelo === 'girostock_pedido_em_preparo'));
await api('POST', `/orders/${p2.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
check('cancelado: avisa quem já tinha recebido aviso', !!(await aguardar(async () => (await paraTel(TEL2)).find((m) => m.modelo === 'girostock_pedido_cancelado'))));
await api('PUT', '/whatsapp/avisos', { avisos: { recebido: false } }, E.token);
const TEL3 = '5541955551111';
const p3 = (await pedido('41955551111')).j;
await api('POST', `/orders/${p3.id}/cancel`, { motivo: 'teste' }, E.token);
await espera(3500);
check('cancelado sem aviso anterior: não manda', !(await paraTel(TEL3)).length);
await api('PUT', '/whatsapp/avisos', { avisos: { recebido: true } }, E.token);
const p4 = (await pedido('')).j;
await espera(3000);
check('pedido sem celular: não manda (registra o motivo)', /sem celular/.test(((await db.query(`SELECT motivo FROM whatsapp_mensagens WHERE order_id = $1`, [p4.id])).rows[0] || {}).motivo || ''));
// pedido do iFood (entra pela integracao): a plataforma avisa o cliente
const pi = (await db.query(`INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, cliente_telefone, tipo) VALUES ($1, $2, 99001, 'ifood', 'Cliente iFood', '41944441111', 'entrega') RETURNING id`, [E.id, L])).rows[0].id;
await db.query(`INSERT INTO order_status_log (order_id, de, para) VALUES ($1, NULL, 'novo')`, [pi]);
await espera(3000);
check('pedido do iFood: não manda (a plataforma avisa)', !(await paraTel('5541944441111')).length);

console.log('\n# 6. Permissões, isolamento e desconectar');
const emailCx = `e2e.wa.caixa.${SUF}@girostock.local`; const sCx = rnd();
await api('POST', '/users', { nome: 'Caixa', email: emailCx, senha: sCx, perfil: 'Caixa/Operador', location_id: L }, E.token);
const CX = (await login(emailCx, sCx)).j.token;
check('caixa não vê nem mexe na configuração (403)', (await api('GET', '/whatsapp', null, CX)).s === 403 && (await api('POST', '/whatsapp/desconectar', {}, CX)).s === 403);
check('caixa vê os avisos de um pedido (tela Pedidos)', (await api('GET', `/whatsapp/mensagens?order_id=${p1.id}`, null, CX)).j.length === 3);
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { pedidos: true, whatsapp: true } }, MAS);
check('outra empresa: não vê mensagens nem a conexão', (await api('GET', `/whatsapp/mensagens?order_id=${p1.id}`, null, F.token)).j.length === 0 && (await api('GET', '/whatsapp', null, F.token)).j.conectado === false);
check('mesmo número em outra empresa -> 409', (await api('POST', '/whatsapp/conectar', { code: 'code-ok', waba_id: '1110001', phone_number_id: '2220001' }, F.token)).s === 409);
check('erro de entrega de um número não derruba a conexão', (await api('GET', '/whatsapp', null, E.token)).j.status === 'conectado');
const { cifrar } = createRequire(import.meta.url)('../src/services/totp');
const tokenBom = (await db.query(`SELECT token_cript FROM whatsapp_contas WHERE tenant_id = $1`, [E.id])).rows[0].token_cript;
await db.query(`UPDATE whatsapp_contas SET token_cript = $2 WHERE tenant_id = $1`, [E.id, cifrar('TOKEN-REVOGADO')]);
const tr = await api('POST', '/whatsapp/teste', { telefone: '(41) 99999-1111' }, E.token);
const st = (await api('GET', '/whatsapp', null, E.token)).j;
check('token revogado na Meta (código 190): conexão fica "erro" pedindo para reconectar', tr.s === 422 && st.status === 'erro' && /reconecte/.test(st.ultimo_erro), st);
await db.query(`UPDATE whatsapp_contas SET token_cript = $2, status = 'conectado' WHERE tenant_id = $1`, [E.id, tokenBom]);
const des = await api('POST', '/whatsapp/desconectar', {}, E.token);
check('desconectar', des.j.conectado === false, des.j);
const TEL6 = '5541933331111';
await pedido('41933331111');
await espera(3500);
check('desconectado: pedidos novos não mandam aviso', !(await paraTel(TEL6)).length);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await db.end();
process.exit(fail ? 1 : 0);
