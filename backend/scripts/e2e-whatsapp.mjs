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

console.log('\n# 5b. Campanhas de marketing com cupom individual (etapa 2)');
const cli = async (nome, tel, aceita) => (await db.query(
  `INSERT INTO customers (tenant_id, nome, telefone, aceita_mensagens, consentimento_em, consentimento_origem) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'teste' END) RETURNING id`,
  [E.id, nome, tel, aceita])).rows[0].id;
const C1 = await cli('Ana Lima', '41981111111', true);
const C2 = await cli('Bruno Reis', '41981112222', false);
const C3 = await cli('Carla Dias', null, true);
const C4 = await cli('Diego Melo', '41981113333', true);
const camp0 = await api('GET', '/whatsapp/campanhas', null, E.token);
check('modelos de marketing: 4, aprovados pela Meta (criados ao conectar, com rodapé "SAIR")', camp0.s === 200 && camp0.j.modelos.length === 4 && camp0.j.modelos.every((m) => m.status === 'APPROVED' && /SAIR/.test(m.rodape)), camp0.j);
const base = { nome: 'Volta 10%', modelo: 'volta', customer_ids: [C1, C2, C3, C4], cupom: { tipo: 'percentual', valor: 10, validade_dias: 7, pedido_minimo: 30 } };
check('modelo inválido -> 400', (await api('POST', '/whatsapp/campanhas/previa', { ...base, modelo: 'x' }, E.token)).s === 400);
check('oferta sem texto -> 400', (await api('POST', '/whatsapp/campanhas/previa', { ...base, modelo: 'oferta_cupom' }, E.token)).s === 400);
check('desconto acima de 90% -> 400', (await api('POST', '/whatsapp/campanhas/previa', { ...base, cupom: { ...base.cupom, valor: 95 } }, E.token)).s === 400);
const pv = await api('POST', '/whatsapp/campanhas/previa', base, E.token);
check('prévia: 2 aptos, 1 sem consentimento, 1 sem celular, custo estimado e exemplo com cupom e validade',
  pv.s === 200 && pv.j.total === 2 && pv.j.sem_consentimento === 1 && pv.j.sem_celular === 1 && pv.j.custo_estimado > 0
  && /Sentimos sua falta na J&A Conveniência/.test(pv.j.exemplo.texto) && /10% de desconto/.test(pv.j.exemplo.texto) && /VOLTA-[A-Z0-9]{5}/.test(pv.j.exemplo.texto), pv.j);
const cr = await api('POST', '/whatsapp/campanhas', base, E.token);
check('campanha criada para 2 clientes', cr.s === 201 && cr.j.total === 2, cr.j);
const mA = await aguardar(async () => (await paraTel('5541981111111')).find((m) => m.modelo === 'girostock_cupom_volta'));
const mD = await aguardar(async () => (await paraTel('5541981113333')).find((m) => m.modelo === 'girostock_cupom_volta'));
check('mensagem de marketing sai pela API: nome, empresa, desconto, código próprio e validade', mA && mA.categoria === 'MARKETING' && mA.params[0] === 'Ana' && mA.params[1] === 'J&A Conveniência'
  && mA.params[2] === '10% de desconto' && /^VOLTA-[A-Z0-9]{5}$/.test(mA.params[3]) && /^\d{2}\/\d{2}$/.test(mA.params[4]), mA);
check('cada cliente recebe um código diferente', mD && mD.params[3] !== mA.params[3], [mA && mA.params, mD && mD.params]);
check('quem não aceitou mensagens não recebe', !(await paraTel('5541981112222')).length);
const cupA = (await db.query(`SELECT * FROM lv_cupons WHERE tenant_id = $1 AND upper(codigo) = $2`, [E.id, mA.params[3]])).rows[0];
check('cupom individual: do cliente, uso único, pedido mínimo e validade', cupA && cupA.customer_id === C1 && cupA.limite_total === 1 && cupA.limite_por_cliente === 1 && Number(cupA.pedido_minimo) === 30 && Number(cupA.valor) === 10 && cupA.fim, cupA);
const det = await aguardar(async () => { const r = (await api('GET', `/whatsapp/campanhas/${cr.j.id}`, null, E.token)).j; return r.status === 'concluida' && r.entregues === 2 ? r : null; });
check('resultado da campanha: concluída, 2 enviadas e entregues, códigos na lista', det && det.enviadas === 2 && det.mensagens.length === 2 && det.mensagens.every((m) => /^VOLTA-/.test(m.cupom)), det);
const lv = createRequire(import.meta.url)('../src/services/lojaVirtual');
const loja = { tenant_id: E.id };
const tentar = async (conta) => { try { await lv.validarCupom(db, loja, mA.params[3], conta, 50, 'retirada'); return 'ok'; } catch (e) { return e.message; } };
check('cupom vale para o dono (conta ligada ao cadastro)', (await tentar({ id: crypto.randomUUID(), customer_id: C1, telefone: '41981111111' })) === 'ok');
check('cupom vale para o dono pelo celular da conta', (await tentar({ id: crypto.randomUUID(), customer_id: null, telefone: '(41) 98111-1111' })) === 'ok');
check('outro cliente não usa o cupom pessoal', /outro cliente/.test(await tentar({ id: crypto.randomUUID(), customer_id: C4, telefone: '41981113333' })));
check('sem conta: pede para entrar', /entre na sua conta/.test(await tentar(null)));
await db.query(`INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, tipo, cupom_id, desconto) VALUES ($1, $2, 99501, 'loja_virtual', 'Ana Lima', 'retirada', $3, 5)`, [E.id, L, cupA.id]);
const lst = (await api('GET', '/whatsapp/campanhas', null, E.token)).j.campanhas.find((c) => c.id === cr.j.id);
check('lista de campanhas: cupom usado aparece no resultado', lst && lst.cupons_usados === 1 && lst.lidas >= 0, lst);
check('cupons individuais não aparecem na lista de cupons da loja', (await db.query(`SELECT count(*)::int AS n FROM lv_cupons WHERE tenant_id = $1 AND customer_id IS NULL`, [E.id])).rows[0].n === 0);
const pv2 = await api('POST', '/whatsapp/campanhas/previa', base, E.token);
check('quem recebeu campanha nos últimos 7 dias fica de fora', pv2.j.total === 0 && pv2.j.recentes === 2, pv2.j);
check('campanha sem ninguém apto -> 400', (await api('POST', '/whatsapp/campanhas', base, E.token)).s === 400);
check('cancelar campanha já concluída -> 409', (await api('POST', `/whatsapp/campanhas/${cr.j.id}/cancelar`, {}, E.token)).s === 409);
// cliente responde SAIR (a Meta manda o celular brasileiro sem o 9: 55 41 8111-1111)
const rs = await sim('/__sim/receber', { from: '554181111111', texto: 'Sair', phone_number_id: '2220001' });
const saiu = await aguardar(async () => { const r = (await db.query(`SELECT aceita_mensagens, consentimento_origem FROM customers WHERE id = $1`, [C1])).rows[0]; return r.aceita_mensagens === false ? r : null; });
check('cliente respondeu SAIR: perde o consentimento (origem registrada)', rs.ok && saiu && /SAIR/.test(saiu.consentimento_origem), [rs, saiu]);
check('SAIR: o cliente recebe a confirmação', !!(await aguardar(async () => (await paraTel('554181111111')).find((m) => /não vai mais receber ofertas/.test(m.texto || '')))));
check('outra mensagem do cliente não tira o consentimento', (await sim('/__sim/receber', { from: '5541981113333', texto: 'quero sair mais cedo hoje', phone_number_id: '2220001' })).ok
  && (await espera(800), (await db.query(`SELECT aceita_mensagens FROM customers WHERE id = $1`, [C4])).rows[0].aceita_mensagens === true));
// cancelar: campanha com mensagem na fila
const C5 = await cli('Elisa Prado', '41981114444', true);
const cpz = (await db.query(`INSERT INTO whatsapp_campanhas (tenant_id, nome, modelo, total) VALUES ($1, 'Cancelar', 'oferta', 1) RETURNING id`, [E.id])).rows[0].id;
const cupz = (await db.query(`INSERT INTO lv_cupons (tenant_id, codigo, tipo, valor, customer_id, campanha_id) VALUES ($1, 'CANC-${SUF}', 'valor', 5, $2, $3) RETURNING id`, [E.id, C5, cpz])).rows[0].id;
await db.query(`INSERT INTO whatsapp_mensagens (tenant_id, evento, telefone, modelo, situacao, campanha_id, customer_id, cupom_id, parametros) VALUES ($1, 'campanha', '5541981114444', 'girostock_oferta', 'na_fila', $2, $3, $4, '["Elisa","J&A","x"]')`, [E.id, cpz, C5, cupz]);
const cc = await api('POST', `/whatsapp/campanhas/${cpz}/cancelar`, {}, E.token);
check('cancelar: o que estava na fila não sai e o cupom é desativado', cc.s === 200 && cc.j.nao_enviadas === 1 && (await db.query(`SELECT ativo FROM lv_cupons WHERE id = $1`, [cupz])).rows[0].ativo === false, cc.j);
const emailCx0 = `e2e.wa.caixa0.${SUF}@girostock.local`; const sCx0 = rnd();
await api('POST', '/users', { nome: 'Caixa0', email: emailCx0, senha: sCx0, perfil: 'Caixa/Operador', location_id: L }, E.token);
const CX0 = (await login(emailCx0, sCx0)).j.token;
check('caixa (sem a área Clientes) não cria campanha (403)', (await api('POST', '/whatsapp/campanhas', base, CX0)).s === 403);

console.log('\n# 5c. Resposta automática com o link do cardápio');
const r0 = await api('GET', '/whatsapp/resposta', null, E.token);
check('resposta automática começa desligada, com texto padrão', r0.s === 200 && r0.j.ativo === false && r0.j.padrao === true && /\{link\}/.test(r0.j.texto), r0.j);
check('ligar sem endereço do cardápio (loja virtual sem endereço) -> 400', (await api('PUT', '/whatsapp/resposta', { ativo: true }, E.token)).s === 400);
check('texto sem {link} -> 400', (await api('PUT', '/whatsapp/resposta', { texto: 'Olá!' }, E.token)).s === 400);
check('endereço inválido -> 400', (await api('PUT', '/whatsapp/resposta', { link: 'cardapio' }, E.token)).s === 400);
const r1 = await api('PUT', '/whatsapp/resposta', { ativo: true, link: 'https://cardapio.exemplo.com.br', intervalo_horas: 12 }, E.token);
check('liga a resposta automática com o endereço do cardápio', r1.s === 200 && r1.j.ativo && r1.j.link === 'https://cardapio.exemplo.com.br' && /cardapio\.exemplo\.com\.br/.test(r1.j.exemplo) && /J&A Conveniência/.test(r1.j.exemplo), r1.j);
const TELR = '5541955557777';
await sim('/__sim/receber', { from: TELR, texto: 'Oi, boa noite', phone_number_id: '2220001' });
const resp = await aguardar(async () => (await paraTel(TELR)).find((m) => /cardapio\.exemplo\.com\.br/.test(m.texto || '')));
check('cliente manda "oi": recebe o link do cardápio', !!resp, await paraTel(TELR));
await sim('/__sim/receber', { from: TELR, texto: 'quero um x-salada', phone_number_id: '2220001' });
await espera(1500);
check('segunda mensagem do mesmo cliente no intervalo: não responde de novo', (await paraTel(TELR)).filter((m) => /cardapio/.test(m.texto || '')).length === 1);
check('resposta registrada no histórico', (await db.query(`SELECT count(*)::int AS n FROM whatsapp_mensagens WHERE tenant_id = $1 AND evento = 'resposta_auto' AND telefone = $2`, [E.id, TELR])).rows[0].n === 1);
await api('PUT', '/whatsapp/resposta', { ativo: false }, E.token);
await sim('/__sim/receber', { from: '5541955558888', texto: 'Oi', phone_number_id: '2220001' });
await espera(1500);
check('desligada: não responde', !(await paraTel('5541955558888')).length);

console.log('\n# 5d. Campanhas automáticas (cliente sumido e aniversariante)');
const clienteCom = async (nome, tel, aceita, diasAtras, aniversario = null) => {
  const id = (await db.query(`INSERT INTO customers (tenant_id, nome, telefone, aceita_mensagens, consentimento_em, aniversario) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END, $5) RETURNING id`, [E.id, nome, tel, aceita, aniversario])).rows[0].id;
  if (diasAtras !== null) {
    await db.query(`INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, tipo, status, customer_id, criado_em, finalizado_em)
      VALUES ($1, $2, $3, 'whatsapp', $4, 'retirada', 'finalizado', $5, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval)`, [E.id, L, 98000 + Math.floor(Math.random() * 1000), nome, id, String(diasAtras)]);
  }
  return id;
};
const hojeSP = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
await clienteCom('Sumido Sim', '41966610001', true, 31);
await clienteCom('Recente Nao', '41966610002', true, 10);
await clienteCom('Sem Consentimento', '41966610003', false, 31);
await clienteCom('Aniversariante', '41966610004', true, null, `${hojeSP.slice(8, 10)}/${hojeSP.slice(5, 7)}`);
const au0 = await api('GET', '/whatsapp/automacoes', null, E.token);
check('automações: cliente sumido e aniversariante, desligadas por padrão', au0.s === 200 && au0.j.length === 2 && au0.j.every((a) => a.ativo === false) && au0.j.find((a) => a.tipo === 'sumido').dias === 30, au0.j);
check('dias sem pedir fora do limite -> 400', (await api('PUT', '/whatsapp/automacoes/sumido', { ativo: true, dias: 3 }, E.token)).s === 400);
check('horário fora do limite -> 400', (await api('PUT', '/whatsapp/automacoes/sumido', { ativo: true, hora: 23 }, E.token)).s === 400);
check('rodar automação desligada -> 409', (await api('POST', '/whatsapp/automacoes/sumido/rodar', {}, E.token)).s === 409);
const au1 = await api('PUT', '/whatsapp/automacoes/sumido', { ativo: true, dias: 30, hora: 10, cupom_tipo: 'percentual', cupom_valor: 15, cupom_validade_dias: 5 }, E.token);
check('liga "cliente sumido há 30 dias" com cupom de 15%', au1.s === 200 && au1.j.find((a) => a.tipo === 'sumido').ativo === true && au1.j.find((a) => a.tipo === 'sumido').cupom_valor === 15, au1.j);
const ro1 = await api('POST', '/whatsapp/automacoes/sumido/rodar', {}, E.token);
check('roda: só o cliente que sumiu há 30+ dias e aceitou mensagens recebe', ro1.s === 200 && ro1.j.total === 1, ro1.j);
const msgS = await aguardar(async () => (await paraTel('5541966610001')).find((m) => m.modelo === 'girostock_cupom_volta'));
check('mensagem "volte com cupom" com 15% e código próprio', msgS && msgS.params[2] === '15% de desconto' && /^VOLTA-/.test(msgS.params[3]), msgS);
check('recente e sem consentimento não recebem', !(await paraTel('5541966610002')).length && !(await paraTel('5541966610003')).length);
const ro2 = await api('POST', '/whatsapp/automacoes/sumido/rodar', {}, E.token);
check('rodar de novo: quem já recebeu desde o último pedido não recebe outra vez', ro2.s === 200 && ro2.j.total === 0 && /ninguém/.test(ro2.j.motivo), ro2.j);
await api('PUT', '/whatsapp/automacoes/aniversario', { ativo: true, cupom_tipo: 'valor', cupom_valor: 10 }, E.token);
const ro3 = await api('POST', '/whatsapp/automacoes/aniversario/rodar', {}, E.token);
const msgA = await aguardar(async () => (await paraTel('5541966610004')).find((m) => m.modelo === 'girostock_cupom_aniversario'));
check('aniversariante do dia recebe o cupom de aniversário (R$ 10)', ro3.j.total === 1 && msgA && msgA.params[2] === 'R$ 10,00 de desconto', [ro3.j, msgA]);
const au2 = (await api('GET', '/whatsapp/automacoes', null, E.token)).j;
check('a tela mostra quando rodou, quantos recebeu e o total enviado', au2.find((a) => a.tipo === 'aniversario').ultimo_total === 1 && au2.find((a) => a.tipo === 'aniversario').ultimo_dia === hojeSP && au2.find((a) => a.tipo === 'sumido').enviadas >= 1, au2);
check('a campanha automática aparece na lista de campanhas', (await api('GET', '/whatsapp/campanhas', null, E.token)).j.campanhas.some((c) => /Automática: aniversariante/.test(c.nome)));

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
