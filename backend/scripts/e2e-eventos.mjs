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

console.log('\n# 8. Estoque do evento: carga, reforço, perdas, contagem e devolução');
const GELO = await produto('Gelo 5kg', 8, DEP, 50);
const REFRI = await produto('Refrigerante Lata', 6, DEP, 40);
const saldoEm = async (pid, loc) => Number(((await prod.query('SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2', [pid, loc])).rows[0] || { saldo: 0 }).saldo);
check('carga sem depósito no evento -> 400', (await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: GELO, quantidade: 1 }] }, E.token)).s === 400);
await api('PUT', `/eventos/${ev2.id}`, { deposito_id: DEP }, E.token);
check('carga vazia -> 400; acima do saldo do depósito -> 400; quantidade fracionada em UN -> 400',
  (await api('POST', `/eventos/${ev2.id}/carga`, { itens: [] }, E.token)).s === 400
  && (await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: GELO, quantidade: 999 }] }, E.token)).s === 400
  && (await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: GELO, quantidade: 1.5 }] }, E.token)).s === 400);
const cg = await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: GELO, quantidade: 20 }, { product_id: REFRI, quantidade: 30 }] }, GER.token);
const item = (est, pid) => est.itens.find((i) => i.product_id === pid);
check('carga: depósito -> setor, aparece como enviado', cg.s === 201 && item(cg.j, GELO).enviado === 20 && item(cg.j, REFRI).enviado === 30 && await saldoEm(REFRI, DEP) === 10 && await saldoEm(REFRI, BAR) === 30, cg.j.itens);
const rf = await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: REFRI, quantidade: 5 }] }, E.token);
check('reforço soma no enviado (motivo "Reforço")', rf.s === 201 && item(rf.j, REFRI).enviado === 35 && Number((await prod.query(`SELECT COUNT(*) AS n FROM stock_movements WHERE evento_id = $1 AND motivo LIKE 'Reforço%'`, [ev2.id])).rows[0].n) === 1);
const vr = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: REFRI, quantidade: 10 }], forma_pagamento: 'pix' }, CX.token);
const vc = await api('POST', '/sales', { terminal_id: TBAR, itens: [{ product_id: REFRI, quantidade: 2 }], forma_pagamento: 'pix' }, CX.token);
await api('POST', `/sales/${vc.j.id}/cancel`, { motivo: 'erro de digitação' }, E.token);
check('perda com tipo inválido -> 400', (await api('POST', `/eventos/${ev2.id}/perdas`, { product_id: REFRI, quantidade: 1, tipo: 'sumiu' }, E.token)).s === 400);
const pd = await api('POST', `/eventos/${ev2.id}/perdas`, { product_id: REFRI, quantidade: 2, tipo: 'cortesia', observacao: 'banda' }, E.token);
const est1 = pd.j;
check('vendido (sem a cancelada) e perda de cortesia', pd.s === 201 && item(est1, REFRI).vendido === 10 && item(est1, REFRI).perdas === 2 && item(est1, REFRI).saldo_setor === 23, item(est1, REFRI));
const evAg = (await api('POST', '/eventos', { nome: 'Evento Futuro', location_id: BAR, deposito_id: DEP, inicio: '2027-01-10T20:00' }, E.token)).j;
check('perda em evento ainda agendado -> 409', (await api('POST', `/eventos/${evAg.id}/perdas`, { product_id: REFRI, quantidade: 1, tipo: 'quebra' }, E.token)).s === 409);
check('fechar estoque com o evento aberto -> 409', (await api('POST', `/eventos/${ev2.id}/fechar-estoque`, { itens: [] }, E.token)).s === 409);
check('encerra o evento', (await api('POST', `/eventos/${ev2.id}/encerrar`, {}, E.token)).s === 200);
check('carga depois de encerrado -> 409', (await api('POST', `/eventos/${ev2.id}/carga`, { itens: [{ product_id: GELO, quantidade: 1 }] }, E.token)).s === 409);
const antesF = (await api('GET', `/eventos/${ev2.id}/estoque`, null, E.token)).j;
const cervSetor = item(antesF, CERVEJA).saldo_setor;
check('contagem faltando produto com saldo -> 400', (await api('POST', `/eventos/${ev2.id}/fechar-estoque`, { itens: [{ product_id: REFRI, contado: 21 }] }, E.token)).s === 400);
const aguaSetor = item(antesF, AGUA) ? item(antesF, AGUA).saldo_setor : 0;
const contagem = [{ product_id: REFRI, contado: 21 }, { product_id: GELO, contado: 20 }, { product_id: CERVEJA, contado: cervSetor + 1 }, ...(aguaSetor > 0 ? [{ product_id: AGUA, contado: aguaSetor }] : [])];
const fe = await api('POST', `/eventos/${ev2.id}/fechar-estoque`, { itens: contagem, devolver: true }, GER.token);
const rr = item(fe.j, REFRI);
check('fecha: falta de 2 refrigerantes vira diferença na contagem', fe.s === 200 && rr.diferenca === -2 && rr.contado === 21 && rr.saldo_sistema === 23, rr);
check('quebra total do refrigerante = cortesia 2 + falta 2 (valor a custo)', rr.quebra_total === 4 && Math.abs(rr.valor_quebra - 4 * rr.custo_unitario) < 0.011, rr);
check('sobra de 1 cerveja na contagem entra como sobra (quebra negativa)', item(fe.j, CERVEJA).diferenca === 1 && item(fe.j, CERVEJA).quebra_total === -1, item(fe.j, CERVEJA));
check('sobra devolvida ao depósito; setor zerado', rr.devolvido === 21 && await saldoEm(REFRI, DEP) === 26 && await saldoEm(REFRI, BAR) === 0 && await saldoEm(GELO, BAR) === 0 && await saldoEm(GELO, DEP) === 50, { dep: await saldoEm(REFRI, DEP) });
check('perdas por tipo: cortesia e diferença na contagem', ['cortesia', 'diferenca_contagem'].every((t) => fe.j.perdas_por_tipo.some((p) => p.tipo === t)), fe.j.perdas_por_tipo);
check('totais em R$ (enviado, vendido, quebra, devolvido)', fe.j.totais.enviado_custo > 0 && fe.j.totais.valor_quebra > 0 && fe.j.totais.devolvido_custo > 0, fe.j.totais);
check('fechar de novo -> 409; perda depois de fechado -> 409', (await api('POST', `/eventos/${ev2.id}/fechar-estoque`, { itens: contagem }, E.token)).s === 409 && (await api('POST', `/eventos/${ev2.id}/perdas`, { product_id: GELO, quantidade: 1, tipo: 'quebra' }, E.token)).s === 409);
check('detalhe do evento mostra o estoque fechado', !!(await api('GET', `/eventos/${ev2.id}`, null, E.token)).j.estoque_fechado_em);
check('outra empresa não vê o estoque do evento (404)', (await api('GET', `/eventos/${ev2.id}/estoque`, null, F.token)).s === 404);

console.log('\n# 9. Agenda no site do cliente (foto, pop-up, chave no Master)');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const up = await fetch(B + '/api/eventos-imagens', { method: 'POST', headers: { 'content-type': 'image/png', authorization: 'Bearer ' + E.token }, body: png });
const foto = await up.json();
check('envia a foto do evento', up.status === 201 && /^[0-9a-f-]{36}$/.test(foto.id), foto);
check('arquivo que não é imagem -> 400', (await fetch(B + '/api/eventos-imagens', { method: 'POST', headers: { 'content-type': 'image/png', authorization: 'Bearer ' + E.token }, body: Buffer.from('nada aqui') })).status === 400);
const hojeSP = (await prod.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d`)).rows[0].d;
const diaSP = (n) => { const d = new Date(hojeSP); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const base = { nome: 'Show no Site', location_id: BAR, inicio: '2027-02-13T21:30', fim: '2027-02-14T03:00', atracoes: 'Banda Site', descricao: 'Linha 1', preco_ingresso: 0, link_ingresso: 'https://ingressos.exemplo/site' };
check('pop-up sem foto -> 400; sem "Divulgar no site" -> 400',
  (await api('POST', '/eventos', { ...base, publicado_site: true, popup_site: true }, E.token)).s === 400
  && (await api('POST', '/eventos', { ...base, imagem_id: foto.id, popup_site: true }, E.token)).s === 400);
check('pop-up com período invertido -> 400', (await api('POST', '/eventos', { ...base, publicado_site: true, imagem_id: foto.id, popup_site: true, popup_inicio: diaSP(5), popup_fim: diaSP(1) }, E.token)).s === 400);
const pubR = await api('POST', '/eventos', { ...base, publicado_site: true, imagem_id: foto.id, popup_site: true }, E.token);
const pub = pubR.j;
check('pop-up ligado: período padrão de hoje até o dia do evento', pubR.s === 201 && pub.popup_site && pub.popup_inicio === diaSP(0) && pub.popup_fim === '2027-02-13', { s: pubR.s, i: pub.popup_inicio, f: pub.popup_fim });
const naoPub = (await api('POST', '/eventos', { nome: 'Show Fechado', location_id: BAR, inicio: '2027-02-20T21:00' }, E.token)).j;
check('foto de outra empresa -> 400', (await api('PUT', `/eventos/${naoPub.id}`, { imagem_id: '00000000-0000-0000-0000-000000000000' }, E.token)).s === 400);
check('painel do cliente não tem mais código para colar (sem /eventos-agenda e sem /agenda.js)', (await api('GET', '/eventos-agenda', null, E.token)).s === 404 && (await fetch(B + '/agenda.js')).headers.get('content-type').includes('text/html'));
const cfg = await api('GET', `/master/empresas/${E.id}/agenda-site`, null, MAS);
check('Master vê a chave da agenda na ficha da empresa', cfg.s === 200 && /^ag_[0-9a-f]{32}$/.test(cfg.j.chave) && cfg.j.ativa && cfg.j.modulo_ligado && cfg.j.url_api.includes(cfg.j.chave), cfg.j);
check('a empresa não acessa a rota do Master (403)', (await api('GET', `/master/empresas/${E.id}/agenda-site`, null, E.token)).s === 403);
const pubApi = async (q, h = {}) => { const r = await fetch(B + '/api/agenda/v1/eventos' + q, { headers: h }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers }; };
check('API pública sem chave ou com chave errada -> 401', (await pubApi('')).s === 401 && (await pubApi('?chave=ag_00000000000000000000000000000000')).s === 401);
const lista = await pubApi(`?chave=${cfg.j.chave}`, { origin: 'https://jaconveniencia.com.br' });
const noSite = lista.j && lista.j.eventos.find((x) => x.id === pub.id);
check('lista só os eventos marcados para o site (nem encerrado, nem cancelado, nem não marcado)', lista.s === 200 && noSite && !lista.j.eventos.some((x) => [naoPub.id, ev1.j.id, ev3.id].includes(x.id)), lista.j);
check('dados prontos para o site: data, dia da semana, hora, foto e ingresso', noSite.data === '13/02/2027' && noSite.dia === '13' && noSite.mes === 'fev' && noSite.dia_semana === 'sábado' && noSite.hora === '21:30' && noSite.hora_fim === '03:00' && noSite.preco_ingresso === 0 && noSite.link_ingresso === 'https://ingressos.exemplo/site' && noSite.imagem && noSite.imagem.endsWith(foto.id), noSite);
check('pop-up do dia vem junto com a agenda', lista.j.popup && lista.j.popup.id === pub.id && lista.j.popup.imagem.endsWith(foto.id), lista.j.popup);
check('API pode ser lida pelo site (CORS e CORP)', lista.h.get('access-control-allow-origin') && lista.h.get('cross-origin-resource-policy') === 'cross-origin');
const img = await fetch(noSite.imagem.replace(/^https?:\/\/[^/]+/, B));
check('foto do evento abre sem login', img.status === 200 && img.headers.get('content-type') === 'image/png');
await api('PUT', `/eventos/${pub.id}`, { popup_inicio: diaSP(2), popup_fim: diaSP(4) }, E.token);
check('pop-up programado para daqui a 2 dias: hoje não aparece', (await (await fetch(B + `/api/agenda/v1/popup?chave=${cfg.j.chave}`)).json()).popup === null);
await api('PUT', `/eventos/${pub.id}`, { popup_inicio: diaSP(-1), popup_fim: diaSP(0) }, E.token);
check('pop-up de ontem até hoje: aparece', ((await (await fetch(B + `/api/agenda/v1/popup?chave=${cfg.j.chave}`)).json()).popup || {}).id === pub.id);
const sem = await api('PUT', `/eventos/${pub.id}`, { popup_site: false }, E.token);
check('desmarcar o pop-up: some do site (o evento continua na agenda)', sem.j.popup_site === false && sem.j.popup_inicio === null && (await pubApi(`?chave=${cfg.j.chave}`)).j.popup === null && (await pubApi(`?chave=${cfg.j.chave}`)).j.eventos.some((x) => x.id === pub.id));
check('detalhe público do evento; não publicado -> 404', (await fetch(B + `/api/agenda/v1/eventos/${pub.id}?chave=${cfg.j.chave}`)).status === 200 && (await fetch(B + `/api/agenda/v1/eventos/${naoPub.id}?chave=${cfg.j.chave}`)).status === 404);
await api('PUT', `/master/empresas/${E.id}/agenda-site`, { ativa: false }, MAS);
check('Master desliga a agenda -> 403 no site', (await pubApi(`?chave=${cfg.j.chave}`)).s === 403);
await api('PUT', `/master/empresas/${E.id}/agenda-site`, { ativa: true }, MAS);
const nova = (await api('POST', `/master/empresas/${E.id}/agenda-site/chave`, {}, MAS)).j;
check('chave nova: a antiga para de funcionar', nova.chave !== cfg.j.chave && (await pubApi(`?chave=${cfg.j.chave}`)).s === 401 && (await pubApi(`?chave=${nova.chave}`)).s === 200);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: false } }, MAS);
check('sem o módulo de eventos, a agenda pública some (403)', (await pubApi(`?chave=${nova.chave}`)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: true } }, MAS);

console.log('\n# 10. Relatório por evento');
const rel = await api('GET', '/reports/eventos?data_inicio=2026-12-01&data_fim=2026-12-31', null, E.token);
const rEv1 = rel.j.linhas && rel.j.linhas.find((l) => l.id === ev1.j.id);
const rEv2 = rel.j.linhas && rel.j.linhas.find((l) => l.id === ev2.id);
check('relatório lista os eventos abertos/encerrados do período (cancelado fora)', rel.s === 200 && rEv1 && rEv2 && !rel.j.linhas.some((l) => l.id === ev3.id), rel.j);
check('evento 1: faturamento, vendas, ticket, canceladas e margem', igual(rEv1.total, 100) && rEv1.vendas === 3 && igual(rEv1.ticket, 100 / 3) && rEv1.canceladas === 1 && rEv1.margem > 0, rEv1);
check('evento 2: quebra = cortesia + falta na contagem − sobra, a custo (e % do enviado)', igual(rEv2.quebra, 6) && igual(rEv2.enviado_custo, 110) && rEv2.quebra_pct === 5.5 && rEv2.contagem_feita, rEv2);
check('variação para o evento anterior', rEv1.variacao_pct === null && rEv2.variacao_pct === -40, [rEv1.variacao_pct, rEv2.variacao_pct]);
check('totais e melhor evento', igual(rel.j.totais.total, rEv1.total + rEv2.total) && rel.j.totais.eventos === rel.j.linhas.length && rel.j.melhor.id === ev1.j.id, rel.j.totais);
const comp = await api('GET', '/reports/comparativo?por=evento&data_inicio=2026-01-01&data_fim=2030-12-31', null, E.token);
const somaEv = Number((await prod.query(`SELECT COALESCE(SUM(total), 0) AS t FROM sales WHERE tenant_id = $1 AND evento_id IS NOT NULL AND status = 'concluida'`, [E.id])).rows[0].t);
check('comparativo "por evento": só vendas de evento, soma confere', comp.s === 200 && igual(comp.j.total, somaEv) && comp.j.linhas.some((l) => l.nome === 'Show de Sábado' && igual(l.total, 100)), comp.j);
check('caixa (sem Relatórios) não vê o relatório (403)', (await api('GET', '/reports/eventos', null, CX.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: false } }, MAS);
check('sem o módulo de eventos: relatório e agrupamento recusados (403)', (await api('GET', '/reports/eventos', null, E.token)).s === 403 && (await api('GET', '/reports/comparativo?por=evento', null, E.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, eventos: true } }, MAS);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
process.exit(fail ? 1 : 0);
