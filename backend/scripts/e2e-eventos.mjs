// e2e da Casa de shows e eventos, Fase 1: modulo, cadastro e agenda, abrir/encerrar/cancelar, vendas do setor ligadas ao evento
// (PDV e comanda de pista), faixa do evento em andamento, resumo por operador/PDV/forma e isolamento.
// npm run test:e2e:eventos   (API em http://localhost:3000)
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.ev.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E Eventos Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);
async function novaEmpresa(rotulo) {
  const email = `e2e.ev.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E EV ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Casa', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId) {
  const email = `e2e.ev.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j.token, status: r.s };
}

console.log('\n# 1. Modulo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: false } }, MAS);
check('sem o modulo: /eventos e a faixa do evento -> 403', (await api('GET', '/eventos', null, E.token)).s === 403 && (await api('GET', '/evento-em-andamento', null, E.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: true } }, MAS);
check('com o modulo: agenda vazia', (await api('GET', '/eventos', null, E.token)).j.length === 0);

console.log('\n# 2. Preparo: setor do bar, deposito, PDVs, produtos');
const CASA = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
const BAR = (await api('POST', '/locations', { nome: 'Bar do Show', usa_pedidos: true }, E.token)).j.id;
const DEP = (await api('POST', '/locations', { nome: 'Depósito' }, E.token)).j.id;
const TBAR = (await api('POST', '/terminals', { location_id: BAR, nome: 'PDV Bar 1' }, E.token)).j.id;
const TBAR2 = (await api('POST', '/terminals', { location_id: BAR, nome: 'PDV Bar 2' }, E.token)).j.id;
const TCASA = (await api('POST', '/terminals', { location_id: CASA, nome: 'PDV Casa' }, E.token)).j.id;
await api('POST', '/categories', { nome: 'Bebidas' }, E.token);
const cat = (await api('GET', '/categories', null, E.token)).j[0].id;
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const produto = async (nome, venda, local, qtd) => (await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 2, preco_venda: venda, location_id: local, estoque_inicial: qtd }, E.token)).j.id;
const CERVEJA = await produto('Cerveja Lata', 10, BAR, 100);
const AGUA = await produto('Água', 5, CASA, 50);
await api('POST', '/stock-movements', { product_id: AGUA, tipo: 'transferencia', quantidade: 20, location_origem_id: CASA, location_destino_id: BAR, motivo: 'e2e' }, E.token);
const CX = await usuario(E, 'CaixaBar', 'Caixa/Operador', BAR);
const GER = await usuario(E, 'GerenteBar', 'Gerente', BAR);
check('usuários do bar criados', CX.status === 201 && GER.status === 201, [CX.status, GER.status]);
for (const [t, tok] of [[TBAR, CX.token], [TBAR2, E.token], [TCASA, E.token]]) await api('POST', '/cash-sessions', { terminal_id: t, valor_inicial: 0 }, tok);

console.log('\n# 3. Cadastro e agenda');
const novo = (b) => api('POST', '/eventos', { nome: 'Show de Sábado', location_id: BAR, inicio: '2026-12-05T21:00', ...b }, E.token);
check('nome curto -> 400', (await novo({ nome: 'X' })).s === 400);
check('sem setor -> 400', (await novo({ location_id: null })).s === 400);
check('fim antes do início -> 400', (await novo({ fim: '2026-12-05T20:00' })).s === 400);
check('data inválida -> 400', (await novo({ inicio: 'amanhã' })).s === 400);
check('link do ingresso sem http -> 400', (await novo({ link_ingresso: 'ingresso.com' })).s === 400);
check('depósito igual ao setor -> 400', (await novo({ deposito_id: BAR })).s === 400);
check('setor de outra empresa -> 404', (await novo({ location_id: '00000000-0000-0000-0000-000000000000' })).s === 404);
const ev1 = await novo({ fim: '2026-12-06T04:00', deposito_id: DEP, atracoes: 'Banda X, DJ Y', descricao: 'Noite de rock', preco_ingresso: 40, link_ingresso: 'https://ingressos.exemplo/show' });
check('cria o evento (agendado), horário de Brasília', ev1.s === 201 && ev1.j.status === 'agendado' && new Date(ev1.j.inicio).toISOString() === '2026-12-06T00:00:00.000Z' && ev1.j.location_nome === 'Bar do Show' && ev1.j.deposito_nome === 'Depósito' && ev1.j.preco_ingresso === 40, ev1.j);
const ev2 = (await api('POST', '/eventos', { nome: 'Pagode de Domingo', location_id: BAR, inicio: '2026-12-06T18:00' }, E.token)).j;
const ev3 = (await api('POST', '/eventos', { nome: 'Festa Cancelada', location_id: BAR, inicio: '2026-12-20T22:00' }, E.token)).j;
const dez = (await api('GET', '/eventos?de=2026-12-05&ate=2026-12-05', null, E.token)).j;
check('agenda por período (dia em Brasília): só o show de sábado', dez.length === 1 && dez[0].id === ev1.j.id, dez.map((e) => e.nome));
check('agenda por situação', (await api('GET', '/eventos?status=agendado', null, E.token)).j.length === 3);
check('período inválido -> 400', (await api('GET', '/eventos?de=05/12/2026', null, E.token)).s === 400);
check('caixa (sem a área Eventos) não acessa a agenda -> 403', (await api('GET', '/eventos', null, CX.token)).s === 403);
const ed = await api('PUT', `/eventos/${ev1.j.id}`, { descricao: 'Noite de rock nacional', publicado_site: true }, E.token);
check('edita o evento agendado (mantém o resto)', ed.s === 200 && ed.j.descricao === 'Noite de rock nacional' && ed.j.publicado_site === true && ed.j.atracoes === 'Banda X, DJ Y' && ed.j.deposito_id === DEP, ed.j);

console.log('\n# 4. Abrir e vender');
const antes = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: CERVEJA, quantidade: 1 }], forma_pagamento: 'pix' }, CX.token);
check('venda no bar antes de abrir: sem evento', antes.s === 201 && (await prod.query('SELECT evento_id FROM sales WHERE id = $1', [antes.j.id])).rows[0].evento_id === null);
check('sem evento aberto: faixa vazia', (await api('GET', '/evento-em-andamento', null, CX.token)).j === null);
const ab = await api('POST', `/eventos/${ev1.j.id}/abrir`, {}, GER.token);
check('gerente abre o evento', ab.s === 200 && ab.j.status === 'aberto' && ab.j.aberto_por_nome === 'GerenteBar' && ab.j.pendencias && ab.j.pendencias.comandas === 0, ab.j);
check('abrir de novo -> 409; outro evento ao mesmo tempo -> 409', (await api('POST', `/eventos/${ev1.j.id}/abrir`, {}, E.token)).s === 409 && (await api('POST', `/eventos/${ev2.id}/abrir`, {}, E.token)).s === 409);
check('setor não muda com o evento aberto -> 409', (await api('PUT', `/eventos/${ev1.j.id}`, { location_id: CASA }, E.token)).s === 409);
const faixa = await api('GET', '/evento-em-andamento', null, CX.token);
check('faixa do evento em andamento (caixa, sem a área Eventos)', faixa.s === 200 && faixa.j && faixa.j.id === ev1.j.id && faixa.j.location_nome === 'Bar do Show', faixa.j);
check('faixa filtrada por outro setor: vazia', (await api('GET', `/evento-em-andamento?location_id=${CASA}`, null, E.token)).j === null);
const v1 = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: CERVEJA, quantidade: 3 }], forma_pagamento: 'pix' }, CX.token);
const v2 = await api('POST', '/sales', { terminal_id: TBAR2, itens: [{ product_id: CERVEJA, quantidade: 2 }, { product_id: AGUA, quantidade: 2 }], forma_pagamento: 'dinheiro', valor_recebido: 50 }, E.token);
const v3 = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: AGUA, quantidade: 1 }], forma_pagamento: 'pix' }, CX.token);
await api('POST', `/sales/${v3.j.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
const fora = await api('POST', '/sales', { terminal_id: TCASA, itens: [{ product_id: AGUA, quantidade: 1 }], forma_pagamento: 'pix' }, E.token);
const evDe = async (id) => (await prod.query('SELECT evento_id FROM sales WHERE id = $1', [id])).rows[0].evento_id;
check('vendas do bar ligadas ao evento; venda em outro setor não', [v1, v2, v3, fora].every((v) => v.s === 201) && await evDe(v1.j.id) === ev1.j.id && await evDe(v2.j.id) === ev1.j.id && await evDe(fora.j.id) === null, [v1.s, v2.s, v3.s, fora.s]);

// comanda de pista no bar, fechada no caixa durante o evento
const cmd = await api('POST', '/garcom/comandas', { tipo: 'pista', identificador: '501', location_id: BAR }, E.token);
const rod = await api('POST', `/garcom/comandas/${cmd.j.id}/rodadas`, { client_id: crypto.randomUUID(), itens: [{ product_id: CERVEJA, quantidade: 4 }] }, E.token);
const vazia = await api('POST', '/garcom/comandas', { tipo: 'pista', identificador: '502', location_id: BAR }, E.token);
const enc1 = await api('POST', `/eventos/${ev1.j.id}/encerrar`, {}, E.token);
check('com comandas abertas no setor, não encerra (409)', cmd.s === 201 && rod.s === 201 && vazia.s === 201 && enc1.s === 409 && /2 comanda/.test(enc1.j.erro), { cmd: cmd.s, rod: rod.s, enc: enc1.j });
const det = await api('GET', `/eventos/${ev1.j.id}`, null, E.token);
check('detalhe mostra as pendências do setor', det.j.pendencias.comandas === 2, det.j.pendencias);
for (const o of (await prod.query(`SELECT id FROM orders WHERE comanda_id = $1`, [cmd.j.id])).rows) {
  for (const para of ['em_preparo', 'pronto', 'entregue']) await api('POST', `/orders/${o.id}/status`, { para }, E.token);
}
const fech = await api('POST', `/comandas/${cmd.j.id}/fechar`, { terminal_id: TBAR2, forma_pagamento: 'cartao_debito' }, E.token);
const vendaCmd = (await prod.query('SELECT sale_id FROM comandas WHERE id = $1', [cmd.j.id])).rows[0].sale_id;
check('comanda de pista fechada no caixa: venda ligada ao evento', fech.s === 200 && vendaCmd && await evDe(vendaCmd) === ev1.j.id, fech.j);
check('comanda vazia cancelada', (await api('POST', `/garcom/comandas/${vazia.j.id}/cancelar`, {}, E.token)).s === 200);

console.log('\n# 5. Encerrar e resumo');
const enc = await api('POST', `/eventos/${ev1.j.id}/encerrar`, {}, GER.token);
const totalEv = 30 + (20 + 10) + 40; // v1 + v2 + comanda (v3 cancelada)
check('encerra o evento', enc.s === 200 && enc.j.status === 'encerrado' && enc.j.encerrado_por_nome === 'GerenteBar', enc.j);
const r = enc.j.resumo;
check('resumo: 3 vendas, faturamento e ticket médio', r.vendas === 3 && igual(r.faturamento, totalEv) && igual(r.ticket_medio, totalEv / 3) && igual(enc.j.faturamento, totalEv), r);
check('resumo: venda cancelada à parte', r.canceladas === 1 && igual(r.valor_cancelado, 5), r);
check('resumo por operador (caixa e admin)', r.por_operador.length === 2 && r.por_operador.some((o) => o.nome === 'CaixaBar' && igual(o.total, 30)), r.por_operador);
check('resumo por PDV', r.por_pdv.some((p) => p.nome === 'PDV Bar 1' && igual(p.total, 30)) && r.por_pdv.some((p) => p.nome === 'PDV Bar 2' && igual(p.total, 70)), r.por_pdv);
check('resumo por forma de pagamento', ['pix', 'dinheiro', 'cartao_debito'].every((f) => r.por_forma.some((x) => x.forma === f)) && igual(r.por_forma.reduce((s, x) => s + x.total, 0), totalEv), r.por_forma);
const depois = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: CERVEJA, quantidade: 1 }], forma_pagamento: 'pix' }, CX.token);
check('venda depois do encerramento: sem evento', depois.s === 201 && await evDe(depois.j.id) === null);
check('encerrado: nome não muda (409), descrição muda', (await api('PUT', `/eventos/${ev1.j.id}`, { nome: 'Outro nome' }, E.token)).s === 409 && (await api('PUT', `/eventos/${ev1.j.id}`, { descricao: 'Foi ótimo' }, E.token)).j.descricao === 'Foi ótimo');
check('encerrar de novo e cancelar encerrado -> 409', (await api('POST', `/eventos/${ev1.j.id}/encerrar`, {}, E.token)).s === 409 && (await api('POST', `/eventos/${ev1.j.id}/cancelar`, { motivo: 'teste' }, E.token)).s === 409);
check('agora o próximo evento pode abrir', (await api('POST', `/eventos/${ev2.id}/abrir`, {}, E.token)).s === 200);

console.log('\n# 6. Cancelar');
check('cancelar sem motivo -> 400', (await api('POST', `/eventos/${ev3.id}/cancelar`, {}, E.token)).s === 400);
const can = await api('POST', `/eventos/${ev3.id}/cancelar`, { motivo: 'chuva forte' }, E.token);
check('cancela o agendado (sai do site)', can.s === 200 && can.j.status === 'cancelado' && can.j.motivo_cancelamento === 'chuva forte' && can.j.publicado_site === false, can.j);
check('cancelado não abre nem é editado (409)', (await api('POST', `/eventos/${ev3.id}/abrir`, {}, E.token)).s === 409 && (await api('PUT', `/eventos/${ev3.id}`, { descricao: 'x' }, E.token)).s === 409);
check('auditoria registra abrir/encerrar/cancelar', Number((await prod.query(`SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = $1 AND acao IN ('abrir_evento', 'encerrar_evento', 'cancelar_evento')`, [E.id])).rows[0].n) === 4);

console.log('\n# 7. Isolamento');
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { eventos: true } }, MAS);
check('outra empresa não vê nem mexe no evento (404)', (await api('GET', `/eventos/${ev1.j.id}`, null, F.token)).s === 404 && (await api('POST', `/eventos/${ev2.id}/encerrar`, {}, F.token)).s === 404 && (await api('GET', '/eventos', null, F.token)).j.length === 0);
check('id inválido -> 404', (await api('GET', '/eventos/abc', null, E.token)).s === 404);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
process.exit(fail ? 1 : 0);
