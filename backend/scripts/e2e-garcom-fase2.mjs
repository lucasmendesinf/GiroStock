// e2e do Garcom, Fase 2: receber na hora (Pix/cartao/dinheiro), pagamento dividido, taxa de servico, prestacao de contas e a PROVA do
// caixa esperado. npm run test:e2e:garcom-fase2   (API em http://localhost:3000)
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
const EMAIL_M = 'e2e.gf2.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 500)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const uuid = () => crypto.randomUUID();
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const n1 = async (sql, p) => Number((await prod.query(sql, p)).rows[0].n);

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E GF2 Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.gf2.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E GF2 ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Casa', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId, permissoes) {
  const email = `e2e.gf2.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId, ...(permissoes ? { permissoes } : {}) }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j.token, usuario: lg.j.usuario, status: r.s };
}

console.log('\n# Preparo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { pedidos: true, garcom: true, financeiro: true } }, MAS);
const L1 = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
await api('PATCH', `/locations/${L1}`, { usa_pedidos: true }, E.token);
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, E.token)).j.id;
await api('POST', '/categories', { nome: 'Bar' }, E.token);
const cat = (await api('GET', '/categories', null, E.token)).j[0].id;
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const produto = async (nome, venda, estoque) => (await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 1, preco_venda: venda, location_id: L1, estoque_inicial: estoque }, E.token)).j.id;
const AGUA = await produto('Agua F2', 4, 100);
const REFRI = await produto('Refri F2', 6, 100);
const GA = await usuario(E, 'GarcomA', 'Garçom', L1);
const GR = await usuario(E, 'GarcomR', 'Garçom', L1, { ReceberNoApp: true });
const CX = await usuario(E, 'CaixaX', 'Caixa/Operador', L1);
const GER = await usuario(E, 'GerenteX', 'Gerente', L1);
check('usuários criados (garçom sem e com ReceberNoApp, caixa, gerente)', [GA, GR, CX, GER].every((u) => u.status === 201), [GA.status, GR.status, CX.status, GER.status]);
check('ReceberNoApp: padrão do Garçom é desligado, e ajustável por usuário', GA.usuario.areas.ReceberNoApp === false && GR.usuario.areas.ReceberNoApp === true && GER.usuario.areas.ReceberNoApp === true);

const abrir = (tok, id, extra = {}) => api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: String(id), ...extra }, tok);
const rodada = async (tok, comandaId, itens) => (await api('POST', `/garcom/comandas/${comandaId}/rodadas`, { client_id: uuid(), itens }, tok)).j.rodada_id;
const detalhe = async (tok, id) => (await api('GET', `/garcom/comandas/${id}`, null, tok)).j;
async function disponivelCaixa(sessionId) {
  const r = await api('POST', `/cash-sessions/${sessionId}/movements`, { tipo: 'sangria', valor: 99999999, motivo: 'consulta do esperado' }, E.token);
  const m = /disponível: ([\d.]+)/.exec(JSON.stringify(r.j));
  return m ? Number(m[1]) : null;
}

console.log('\n# 1. Permissão e configuração da loja');
const m1 = (await abrir(GR.token, 1)).j;
const rM1 = await rodada(GR.token, m1.id, [{ product_id: AGUA, quantidade: 2 }]);
check('sem ReceberNoApp: receber -> 403', (await api('POST', `/garcom/comandas/${(await abrir(GA.token, 90)).j.id}/receber`, { order_ids: [rM1], forma: 'pix' }, GA.token)).s === 403);
check('loja com recebimento desligado: receber -> 403', (await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [rM1], forma: 'pix' }, GR.token)).s === 403);
check('"Na hora" indisponível com a loja desligada (403)', (await abrir(GR.token, 91, { modo_pagamento: 'hora' })).s === 403);
check('só Configurações altera a loja (garçom/gerente 403)', (await api('PUT', `/locations/${L1}/recebimento-garcom`, { garcom_recebe: true }, GER.token)).s === 403);
const cfgRuim = await api('PUT', `/locations/${L1}/recebimento-garcom`, { taxa_servico_pct: 150 }, E.token);
check('taxa de serviço fora de 0–100 -> 400', cfgRuim.s === 400);
check('terminal de outra loja/inexistente -> 400', (await api('PUT', `/locations/${L1}/recebimento-garcom`, { terminal_comandas_id: uuid() }, E.token)).s === 400);
const cfg = await api('PUT', `/locations/${L1}/recebimento-garcom`, { garcom_recebe: true, taxa_servico_pct: 10, garcom_formas: { pix: true, cartao: true, dinheiro: true } }, E.token);
check('administrador liga o recebimento (10%, todas as formas)', cfg.s === 200 && cfg.j.garcom_recebe === true && Number(cfg.j.taxa_servico_pct) === 10, cfg.j);
const hora = await abrir(GR.token, 92, { modo_pagamento: 'hora' });
check('"Na hora" abre para quem tem a permissão', hora.s === 201 && hora.j.modo_pagamento === 'hora', hora.j);
check('"Na hora" continua negado a quem não tem a permissão (403)', (await abrir(GA.token, 93, { modo_pagamento: 'hora' })).s === 403);
const dv1 = await detalhe(GR.token, m1.id);
check('detalhe informa se o app pode receber, as formas e a taxa', dv1.receber.permitido === true && Number(dv1.receber.taxa_servico_pct) === 10 && dv1.receber.formas.dinheiro === true, dv1.receber);
check('garçom sem a permissão vê receber.permitido = false', (await detalhe(GA.token, (await abrir(GA.token, 90)).j.id)).receber.permitido === false);

console.log('\n# 2. Receber rodadas: Pix, cartão e conta');
const r2 = await rodada(GR.token, m1.id, [{ product_id: REFRI, quantidade: 1 }]);
const r3 = await rodada(GR.token, m1.id, [{ product_id: AGUA, quantidade: 1 }]);
const pix = await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [rM1], forma: 'pix' }, GR.token);
check('rodada 1 recebida em Pix (8,00, sem taxa)', pix.s === 201 && igual(pix.j.pagamento.valor_produtos, 8) && igual(pix.j.pagamento.taxa_servico, 0), pix.j);
check('cabeçalho: pago 8,00 / falta 10,00; rodada marcada como paga (pix)', igual(pix.j.comanda.pago_produtos, 8) && igual(pix.j.comanda.falta_produtos, 10) && pix.j.comanda.rodadas_lista[0].pago_forma === 'pix', pix.j.comanda);
check('a mesma rodada não paga duas vezes (409)', (await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [rM1], forma: 'pix' }, GR.token)).s === 409);
const disputa = await Promise.all(['pix', 'cartao_credito'].map((forma) => api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [r2], forma }, GR.token)));
check('dois recebimentos simultâneos da mesma rodada: um passa e o outro 409', disputa.filter((r) => r.s === 201).length === 1 && disputa.filter((r) => r.s === 409).length === 1, disputa.map((r) => r.s));
const dv2 = await detalhe(GR.token, m1.id);
check('rodada 3 segue na conta (falta 4,00) e há 2 recebimentos confirmados', igual(dv2.falta_produtos, 4) && dv2.pagamentos.filter((p) => p.status === 'confirmado').length === 2, dv2.pagamentos);
check('rodada de outra comanda não é aceita (400)', (await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [uuid()], forma: 'pix' }, GR.token)).s === 400);
check('forma inválida -> 400', (await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [r3], forma: 'cheque' }, GR.token)).s === 400);

console.log('\n# 3. Dinheiro: troco e "com o garçom"');
check('dinheiro com valor menor que o total -> 400', (await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [r3], forma: 'dinheiro', valor_recebido: 3 }, GR.token)).s === 400);
const din = await api('POST', `/garcom/comandas/${m1.id}/receber`, { order_ids: [r3], forma: 'dinheiro', valor_recebido: 5 }, GR.token);
check('dinheiro de 4,00 com 5,00 recebidos: troco 1,00', din.s === 201 && igual(din.j.pagamento.troco, 1) && igual(din.j.pagamento.valor_recebido, 5), din.j);
const prest0 = await api('GET', '/comandas/prestacao', null, CX.token);
check('o dinheiro aparece como "com o garçom" na prestação de contas', prest0.s === 200 && igual(prest0.j.dinheiro_com_garcons, 4) && prest0.j.garcons[0].garcom_nome === 'GarcomR', prest0.j);
const ext0 = await api('GET', '/garcom/extrato', null, GR.token);
check('extrato do garçom: recebido na hora e dinheiro com ele', ext0.s === 200 && ext0.j.recebidos_na_hora.length === 3 && igual(ext0.j.dinheiro_comigo, 4), ext0.j);
check('garçom não acessa a prestação de contas (403)', (await api('GET', '/comandas/prestacao', null, GR.token)).s === 403);

console.log('\n# 4. Encerrar a comanda toda paga (sem passar pelo caixa)');
const vendasAntes = await n1('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id]);
const sem = await api('POST', `/garcom/comandas/${m1.id}/encerrar`, null, GR.token);
check('sem caixa aberto: 409 e o recebimento não se perde', sem.s === 409 && /abra o caixa/i.test(sem.j.erro) && (await detalhe(GR.token, m1.id)).pagamentos.filter((p) => p.status === 'confirmado').length === 3, sem.j);
const abre = await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 100 }, E.token);
const SESSAO = abre.j.id;
check('abre o caixa com 100,00', abre.s === 201 && !!SESSAO);
const enc = await api('POST', `/garcom/comandas/${m1.id}/encerrar`, null, GR.token);
check('encerra: comanda paga com UMA venda de 18,00', enc.s === 200 && enc.j.comanda.status === 'paga' && igual(enc.j.venda.total, 18) && (await n1('SELECT count(*) AS n FROM sales WHERE tenant_id = $1', [E.id])) === vendasAntes + 1, enc.j);
const sp = (await prod.query(`SELECT forma, valor, entra_no_caixa, comanda_pagamento_id IS NOT NULL AS ligado FROM sale_payments WHERE sale_id = $1 ORDER BY valor DESC`, [enc.j.venda.id])).rows;
check('sale_payments espelham os recebimentos (pix 8 / 6 em Pix ou crédito / dinheiro 4) e a soma fecha o total', sp.length === 3 && igual(sp.reduce((s, p) => s + Number(p.valor), 0), 18) && sp.every((p) => p.ligado) && sp.find((p) => p.forma === 'dinheiro').entra_no_caixa === false, sp);
check('estoque baixado UMA vez (água 100→97, refri 100→99)', (await n1('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [AGUA, L1])) === 97 && (await n1('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [REFRI, L1])) === 99);
check('encerrar de novo -> 409', (await api('POST', `/garcom/comandas/${m1.id}/encerrar`, null, GR.token)).s === 409);
const vd = (await api('GET', `/sales/${enc.j.venda.id}`, null, CX.token)).j;
check('detalhe da venda traz as partes pagas', vd.pagamentos.length === 3 && igual(vd.total, 18), vd.pagamentos);
check('comanda com rodada não paga: encerrar pelo app -> 409', (await (async () => { const m = (await abrir(GR.token, 20)).j; await rodada(GR.token, m.id, [{ product_id: AGUA, quantidade: 1 }]); return api('POST', `/garcom/comandas/${m.id}/encerrar`, null, GR.token); })()).s === 409);

console.log('\n# 5. Caixa esperado: dinheiro do garçom só conta depois da prestação');
const base = await disponivelCaixa(SESSAO);
check('caixa esperado antes da prestação = 100,00 (dinheiro do garçom ainda NÃO conta)', igual(base, 100), base);
const rotulo = await api('POST', '/comandas/prestacao', { garcom_id: GR.id, valor_conferido: 3, terminal_id: T1 }, CX.token);
check('prestação: esperado 4,00, conferido 3,00, falta 1,00', rotulo.s === 200 && igual(rotulo.j.esperado, 4) && igual(rotulo.j.conferido, 3) && igual(rotulo.j.diferenca, -1), rotulo.j);
check('o conferido vira SUPRIMENTO: esperado = 103,00', igual(await disponivelCaixa(SESSAO), 103));
const pr = (await prod.query(`SELECT prestado_em IS NOT NULL AS ok, diferenca_prestacao, cash_movement_id IS NOT NULL AS mov FROM comanda_pagamentos WHERE comanda_id = $1 AND forma = 'dinheiro'`, [m1.id])).rows[0];
check('a diferença fica registrada no recebimento', pr.ok && igual(pr.diferenca_prestacao, -1) && pr.mov, pr);
check('depois de prestado não há mais dinheiro com o garçom (409 ao repetir)', igual((await api('GET', '/comandas/prestacao', null, CX.token)).j.dinheiro_com_garcons, 0) && (await api('POST', '/comandas/prestacao', { garcom_id: GR.id, valor_conferido: 1, terminal_id: T1 }, CX.token)).s === 409);
check('sem caixa aberto no terminal informado a prestação é recusada (409)', (await (async () => { const T9 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 9' }, E.token)).j.id; return api('POST', '/comandas/prestacao', { garcom_id: GR.id, valor_conferido: 1, terminal_id: T9 }, CX.token); })()).s === 409);

console.log('\n# 6. Fechar no caixa com recebimento parcial, desconto, taxa e duas formas');
const m2 = (await abrir(GR.token, 2)).j;
const a1 = await rodada(GR.token, m2.id, [{ product_id: AGUA, quantidade: 5 }]);
const a2 = await rodada(GR.token, m2.id, [{ product_id: REFRI, quantidade: 2 }]);
const taxaApp = await api('POST', `/garcom/comandas/${m2.id}/receber`, { order_ids: [a1], forma: 'pix', cobrar_taxa: true }, GR.token);
check('taxa de serviço opcional: 20,00 + 10% = 22,00', taxaApp.s === 201 && igual(taxaApp.j.pagamento.taxa_servico, 2) && igual(taxaApp.j.pagamento.total, 22), taxaApp.j.pagamento);
check('caixa sem permissão de desconto: 403', (await api('POST', `/comandas/${m2.id}/fechar`, { terminal_id: T1, forma_pagamento: 'pix', desconto: 2 }, CX.token)).s === 403);
check('soma dos pagamentos diferente do restante -> 400 (nada muda)', (await api('POST', `/comandas/${m2.id}/fechar`, { terminal_id: T1, desconto: 2, cobrar_taxa: true, pagamentos: [{ forma: 'dinheiro', valor: 5, valor_recebido: 5 }, { forma: 'cartao_debito', valor: 5 }] }, GER.token)).s === 400);
check('desconto maior que o restante -> 400', (await api('POST', `/comandas/${m2.id}/fechar`, { terminal_id: T1, desconto: 12, forma_pagamento: 'pix' }, GER.token)).s === 400);
const dispAntes = await disponivelCaixa(SESSAO);
const f2 = await api('POST', `/comandas/${m2.id}/fechar`, { terminal_id: T1, desconto: 2, cobrar_taxa: true, pagamentos: [{ forma: 'dinheiro', valor: 5, valor_recebido: 10 }, { forma: 'cartao_debito', valor: 6 }] }, GER.token);
check('fecha só o restante: total 32 − 2 + taxa (2 + 1) = 33,00 em 3 partes', f2.s === 200 && igual(f2.j.venda.total, 33) && igual(f2.j.venda.taxa_servico, 3) && f2.j.venda.pagamentos.length === 3, f2.j);
const vd2 = (await api('GET', `/sales/${f2.j.venda.id}`, null, GER.token)).j;
check('venda: desconto 2, taxa de serviço 3, subtotal 32; partes 22 (Pix) + 5 + 6', igual(vd2.desconto, 2) && igual(vd2.taxa_servico, 3) && igual(vd2.subtotal, 32) && igual(vd2.pagamentos.reduce((s, p) => s + Number(p.valor), 0), 33), vd2);
check('troco do dinheiro no caixa = 5,00; valor recebido 10,00', igual(vd2.troco, 5) && igual(vd2.valor_recebido, 10), [vd2.troco, vd2.valor_recebido]);
check('o dinheiro do caixa (5,00) entra no esperado: 103 → 108', igual(await disponivelCaixa(SESSAO), dispAntes + 5), [dispAntes, await disponivelCaixa(SESSAO)]);
const somaPartes = await n1(`SELECT COALESCE(SUM(vp.valor), 0) AS n FROM v_sale_pagamentos vp JOIN sales s ON s.id = vp.sale_id WHERE s.tenant_id = $1 AND s.status = 'concluida'`, [E.id]);
const somaVendas = await n1(`SELECT COALESCE(SUM(total), 0) AS n FROM sales WHERE tenant_id = $1 AND status = 'concluida'`, [E.id]);
check('soma das partes pagas = soma das vendas (banco)', igual(somaPartes, somaVendas), [somaPartes, somaVendas]);
const resumo = (await api('GET', `/reports/sales-summary?location_id=${L1}`, null, E.token)).j;
check('relatório por forma: soma da quebra = total vendido (e cartão de débito = 6,00)', igual(resumo.quebra_por_forma_pagamento.reduce((s, q) => s + q.total, 0), resumo.total_vendido) && igual((resumo.quebra_por_forma_pagamento.find((q) => q.forma_pagamento === 'cartao_debito') || {}).total, 6), resumo.quebra_por_forma_pagamento);
const comp = (await api('GET', `/reports/comparativo?por=pagamento&location_id=${L1}`, null, E.token)).j;
check('comparativo por pagamento: soma = total e participações fecham 100%', igual(comp.linhas.reduce((s, l) => s + l.total, 0), comp.total) && Math.abs(comp.linhas.reduce((s, l) => s + l.participacao, 0) - 100) < 0.5, comp);
const filtro = await api('GET', `/reports/sales-history?location_id=${L1}&forma_pagamento=cartao_debito`, null, E.token);
check('filtro por forma encontra a venda dividida (alguma parte em débito)', filtro.s === 200 && filtro.j.itens.some((v) => v.id === f2.j.venda.id), filtro.j.itens && filtro.j.itens.length);
const fin = await api('GET', `/financeiro/resultado?mes=${new Date().toISOString().slice(0, 7)}`, null, E.token);
check('Financeiro: resultado do mês inclui a taxa de serviço na receita bruta', fin.s === 200 && Number(fin.j.receita_bruta) >= 18 + 35, fin.j && { rb: fin.j.receita_bruta, rec: fin.j.receita });

console.log('\n# 7. Estorno de recebimento e cancelamento de venda');
const m3 = (await abrir(GR.token, 3)).j;
const s1 = await rodada(GR.token, m3.id, [{ product_id: AGUA, quantidade: 1 }]);
const pgS = (await api('POST', `/garcom/comandas/${m3.id}/receber`, { order_ids: [s1], forma: 'pix' }, GR.token)).j.pagamento;
check('garçom não estorna (403)', (await api('POST', `/garcom/comandas/${m3.id}/receber/${pgS.id}/estornar`, { motivo: 'engano' }, GR.token)).s === 403);
check('estorno exige motivo (400)', (await api('POST', `/garcom/comandas/${m3.id}/receber/${pgS.id}/estornar`, {}, GER.token)).s === 400);
const est = await api('POST', `/garcom/comandas/${m3.id}/receber/${pgS.id}/estornar`, { motivo: 'cliente trocou a forma' }, GER.token);
check('gerente estorna e a rodada volta a ficar na conta (falta 4,00)', est.s === 200 && igual(est.j.falta_produtos, 4) && est.j.pagamentos[0].status === 'estornado', est.j);
check('estornar de novo -> 409', (await api('POST', `/garcom/comandas/${m3.id}/receber/${pgS.id}/estornar`, { motivo: 'outra vez' }, GER.token)).s === 409);
check('rodada paga no app não cancela (409); estornada, cancela', await (async () => {
  const dinS = await api('POST', `/garcom/comandas/${m3.id}/receber`, { order_ids: [s1], forma: 'dinheiro', valor_recebido: 4 }, GR.token);
  const blq = (await api('POST', `/garcom/rodadas/${s1}/cancelar`, { motivo: 'teste' }, GER.token)).s === 409;
  const blq2 = (await api('POST', `/orders/${s1}/cancel`, { motivo: 'teste' }, GER.token)).s === 409;
  return dinS.s === 201 && blq && blq2;
})());
check('comanda com recebimento não cancela (409)', (await api('POST', `/garcom/comandas/${m3.id}/cancelar`, { motivo: 'teste' }, GER.token)).s === 409);
const pestes = await api('POST', '/comandas/prestacao', { garcom_id: GR.id, valor_conferido: 4, terminal_id: T1 }, CX.token);
check('prestação do dinheiro de 4,00 (sem diferença)', pestes.s === 200 && igual(pestes.j.diferenca, 0), pestes.j);
const dinPg = (await prod.query(`SELECT id FROM comanda_pagamentos WHERE comanda_id = $1 AND status = 'confirmado'`, [m3.id])).rows[0].id;
check('depois da prestação o estorno é recusado (409)', (await api('POST', `/garcom/comandas/${m3.id}/receber/${dinPg}/estornar`, { motivo: 'tarde demais' }, GER.token)).s === 409);
const dispPre = await disponivelCaixa(SESSAO);
const encS = await api('POST', `/garcom/comandas/${m3.id}/encerrar`, null, GR.token);
check('comanda quitada é encerrada (venda de 4,00)', encS.s === 200 && igual(encS.j.venda.total, 4), encS.j);
check('comanda paga: estorno do recebimento é recusado (409)', (await api('POST', `/garcom/comandas/${m3.id}/receber/${dinPg}/estornar`, { motivo: 'já paga' }, GER.token)).s === 409);
check('no caixa o esperado não mudou com o encerramento (o dinheiro já tinha entrado pela prestação)', igual(await disponivelCaixa(SESSAO), dispPre), [dispPre, await disponivelCaixa(SESSAO)]);
const canc = await api('POST', `/sales/${encS.j.venda.id}/cancel`, { motivo: 'cliente devolveu' }, GER.token);
check('cancelar a venda: 200', canc.s === 200, canc.j);
check('recebimentos da venda viram estornados e saem da prestação', (await n1(`SELECT count(*) AS n FROM comanda_pagamentos WHERE comanda_id = $1 AND status = 'estornado' AND forma = 'dinheiro'`, [m3.id])) === 1);
check('dinheiro que o garçom tinha entregue volta ao cliente por sangria: esperado cai 4,00', igual(await disponivelCaixa(SESSAO), dispPre - 4), [dispPre, await disponivelCaixa(SESSAO)]);
check('estoque devolvido pelo cancelamento (água +1)', (await n1('SELECT saldo AS n FROM stock_balances WHERE product_id = $1 AND location_id = $2', [AGUA, L1])) === 97 - 5 - 1 + 1);

console.log('\n# 8. Taxa e formas por loja');
const m4 = (await abrir(GR.token, 4)).j;
const t4 = await rodada(GR.token, m4.id, [{ product_id: REFRI, quantidade: 1 }]);
await api('PUT', `/locations/${L1}/recebimento-garcom`, { taxa_servico_pct: 12.5, garcom_formas: { pix: true, cartao: true, dinheiro: false } }, E.token);
check('forma desligada na loja (dinheiro) -> 403', (await api('POST', `/garcom/comandas/${m4.id}/receber`, { order_ids: [t4], forma: 'dinheiro', valor_recebido: 10 }, GR.token)).s === 403);
const c125 = await api('POST', `/garcom/comandas/${m4.id}/receber`, { order_ids: [t4], forma: 'cartao_credito', cobrar_taxa: true }, GR.token);
check('taxa da loja em 12,5%: 6,00 → 0,75', c125.s === 201 && igual(c125.j.pagamento.taxa_servico, 0.75) && igual(c125.j.pagamento.total, 6.75), c125.j.pagamento);
await api('PUT', `/locations/${L1}/recebimento-garcom`, { taxa_servico_pct: 10, garcom_formas: { pix: true, cartao: true, dinheiro: true } }, E.token);

console.log('\n# 9. Fechamento do caixa: esperado = inicial + dinheiro das vendas + suprimentos − sangrias');
const esperadoSql = await (async () => {
  const ini = await n1('SELECT valor_inicial AS n FROM cash_sessions WHERE id = $1', [SESSAO]);
  const din = await n1(`SELECT COALESCE(SUM(vp.valor), 0) AS n FROM sales s JOIN v_sale_pagamentos vp ON vp.sale_id = s.id WHERE s.cash_session_id = $1 AND s.status = 'concluida' AND vp.forma = 'dinheiro' AND vp.entra_no_caixa`, [SESSAO]);
  const sup = await n1(`SELECT COALESCE(SUM(valor), 0) AS n FROM cash_movements WHERE cash_session_id = $1 AND tipo = 'suprimento'`, [SESSAO]);
  const san = await n1(`SELECT COALESCE(SUM(valor), 0) AS n FROM cash_movements WHERE cash_session_id = $1 AND tipo = 'sangria'`, [SESSAO]);
  return { ini, din, sup, san, esperado: ini + din + sup - san };
})();
check('contas do banco: 100 + 5 (dinheiro no caixa) + 7 (prestações 3 + 4) − 4 (estorno) = 108', igual(esperadoSql.esperado, 108), esperadoSql);
const sess = (await api('GET', `/reports/cash-sessions?location_id=${L1}`, null, E.token)).j.find((x) => x.id === SESSAO);
check('relatório do caixa mostra o dinheiro que ficou com garçom (sem entrar no caixa)', sess && igual(sess.dinheiro_garcom, 4) , sess);
const fecha = await api('POST', `/cash-sessions/${SESSAO}/close`, { valor_informado: 108 }, E.token);
check('fecha o caixa: valor esperado do sistema = 108,00 e diferença 0', fecha.s === 200 && igual(fecha.j.valor_esperado_fechamento, 108) && igual(fecha.j.diferenca, 0), fecha.j);

console.log('\n# 10. Auditoria, módulo e isolamento');
const acoes = (await prod.query(`SELECT DISTINCT acao FROM audit_logs WHERE tenant_id = $1`, [E.id])).rows.map((r) => r.acao);
check('auditoria: receber, estornar, fechar, prestação e configuração', ['receber_comanda', 'estornar_recebimento_comanda', 'fechar_comanda', 'prestacao_contas_garcom', 'config_recebimento_garcom'].every((a) => acoes.includes(a)), acoes);
const aud = (await prod.query(`SELECT detalhes::text AS d FROM audit_logs WHERE tenant_id = $1 AND acao = 'receber_comanda' LIMIT 1`, [E.id])).rows[0].d;
check('auditoria do recebimento sem dados desnecessários (sem valor recebido/troco)', !/troco|valor_recebido/.test(aud), aud);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: false } }, MAS);
check('módulo desligado: receber, prestação e configuração indisponíveis (403)', (await api('POST', `/garcom/comandas/${m4.id}/receber`, { order_ids: [t4], forma: 'pix' }, GR.token)).s === 403 && (await api('GET', '/comandas/prestacao', null, CX.token)).s === 403 && (await api('PUT', `/locations/${L1}/recebimento-garcom`, { garcom_recebe: false }, E.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: true } }, MAS);
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { pedidos: true, garcom: true } }, MAS);
const LF = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [F.id])).rows[0].id;
await api('PATCH', `/locations/${LF}`, { usa_pedidos: true }, F.token);
const GF = await usuario(F, 'GarcomF', 'Garçom', LF, { ReceberNoApp: true });
check('outra empresa não recebe nem estorna na comanda alheia (404)', (await api('POST', `/garcom/comandas/${m4.id}/receber`, { order_ids: [t4], forma: 'pix' }, GF.token)).s === 404 && (await api('POST', `/garcom/comandas/${m3.id}/receber/${dinPg}/estornar`, { motivo: 'invasor' }, F.token)).s === 404);

console.log('\n# 11. Regressão');
const T2 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 2' }, E.token)).j.id;
const ab2 = await api('POST', '/cash-sessions', { terminal_id: T2, valor_inicial: 0 }, E.token);
const venda = await api('POST', '/sales', { terminal_id: T2, itens: [{ product_id: AGUA, quantidade: 2 }], forma_pagamento: 'dinheiro', valor_recebido: 20 }, E.token);
check('venda direta no PDV (uma forma, com troco) continua igual', ab2.s === 201 && venda.s === 201 && igual(venda.j.total, 8) && igual(venda.j.troco, 12) && venda.j.forma_pagamento === 'dinheiro', venda.j);
check('e grava uma parte paga (sale_payments) com entra_no_caixa', (await n1('SELECT count(*) AS n FROM sale_payments WHERE sale_id = $1 AND forma = \'dinheiro\' AND entra_no_caixa AND valor = 8', [venda.j.id])) === 1);
await prod.query('DELETE FROM sale_payments WHERE sale_id = $1', [venda.j.id]);
check('venda antiga (sem partes) vale como uma forma só, com o total', (await n1(`SELECT COALESCE(SUM(valor), 0) AS n FROM v_sale_pagamentos WHERE sale_id = $1 AND forma = 'dinheiro'`, [venda.j.id])) === 8);
const vendaSemForma = await api('POST', '/sales', { terminal_id: T2, itens: [{ product_id: AGUA, quantidade: 1 }] }, E.token);
check('venda sem forma de pagamento continua recusada (400)', vendaSemForma.s === 400);
const pm = await api('POST', '/orders', { location_id: L1, tipo: 'mesa', endereco: 'Mesa 50', itens: [{ product_id: REFRI, quantidade: 1 }] }, E.token);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'pronto' }, E.token);
check('pedido comum finaliza com venda e pagamento', (await api('POST', `/orders/${pm.j.id}/status`, { para: 'finalizado', forma_pagamento: 'pix', terminal_id: T2 }, E.token)).s === 200);

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.gf2.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E GF2 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
