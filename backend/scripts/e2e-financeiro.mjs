// Teste ponta a ponta do Financeiro: contas a pagar/receber, parcelas, baixa/estorno/cancelamento, contas financeiras,
// prazos e taxas das vendas, fluxo de caixa, resultado do mes, resumo e permissoes.
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed):
//   API_URL=http://localhost:3000 npm run test:e2e:financeiro
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 500)}`); }
};
async function api(method, rota, body, tok) {
  try {
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const hoje = (await prod.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
const dia = (n) => new Date(Date.parse(`${hoje}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mes = hoje.slice(0, 7);

// ---------- preparo ----------
const SENHA_MASTER = crypto.randomBytes(9).toString('base64url');
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.fin.master@girostock.local', MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E Fin Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.fin.master@girostock.local', SENHA_MASTER);
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
check('login do Master e do administrador', !!MAS && !!A);
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const produtos = (await api('GET', '/products', null, A)).j;
const REFRI = produtos.find((p) => p.codigo_interno === 'PRD-0001');
const sup = (await api('GET', '/suppliers', null, A)).j[0];
const PDV1 = (await api('GET', '/terminals', null, A)).j.find((t) => t.nome === 'PDV 01').id;

console.log('\n# 1. Modulo e permissao');
check('sem o modulo Financeiro: 403', (await api('GET', '/financeiro/resumo', null, A)).s === 403);
check('Master libera o modulo', (await api('PATCH', `/master/empresas/${empresa}`, { recursos: { financeiro: true } }, MAS)).s === 200);
const ger = await api('POST', '/users', { nome: 'Gerente Fin', email: `ger.fin.${Date.now()}@girostock.local`, senha: 'Senha123!', perfil: 'Gerente' }, A);
const G = ger.s === 201 ? (await api('POST', '/auth/login', { email: ger.j.email, senha: 'Senha123!' })).j.token : null;
check('Gerente (sem a permissao Financeiro) nao acessa: 403', !!G && (await api('GET', '/financeiro/resumo', null, G)).s === 403, ger);
const cats = (await api('GET', '/financeiro/categorias', null, A)).j;
check('categorias padrao criadas (despesas e receitas)', cats.length >= 13 && cats.some((c) => c.nome === 'Aluguel' && c.tipo === 'despesa') && cats.some((c) => c.nome === 'Outras receitas'), cats.length);
const CAT = Object.fromEntries(cats.map((c) => [c.nome, c]));
check('"Compra de mercadorias" fica fora do resultado (o custo entra pelo CMV)', CAT['Compra de mercadorias'].entra_no_resultado === false);
const formas = (await api('GET', '/financeiro/formas', null, A)).j;
check('formas de recebimento padrao (credito 30 dias, iFood e 99Food)', formas.length === 6 && formas.find((f) => f.forma === 'cartao_credito').prazo_dias === 30, formas);

console.log('\n# 2. Contas financeiras');
const banco = await api('POST', '/financeiro/contas', { nome: 'Banco do Brasil', tipo: 'banco', saldo_inicial: '1.000,00', saldo_inicial_em: hoje }, A);
check('conta Banco com saldo inicial 1.000,00', banco.s === 201 && igual(banco.j.saldo, 1000), banco);
const cofre = await api('POST', '/financeiro/contas', { nome: 'Cofre da loja', tipo: 'caixa', saldo_inicial: 0 }, A);
check('conta Cofre', cofre.s === 201);
check('nome de conta repetido -> 409', (await api('POST', '/financeiro/contas', { nome: 'banco do brasil' }, A)).s === 409);

console.log('\n# 3. Contas a pagar: unica, mensal, parcelada, validacoes');
const alu = await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'Aluguel loja', categoria_id: CAT.Aluguel.id, valor: 1500, vencimento: dia(5), competencia: `${mes}-01`, repetir: { modo: 'mensal', quantidade: 3 } }, A);
check('aluguel mensal 3x: 3 lancamentos de 1.500 em meses seguidos', alu.s === 201 && alu.j.length === 3 && alu.j.every((t) => igual(t.valor, 1500)) && alu.j[1].competencia.slice(0, 7) !== alu.j[0].competencia.slice(0, 7), alu.j);
check('aluguel: competencia do 1o e o mes atual', alu.s === 201 && alu.j[0].competencia === `${mes}-01`, alu.j && alu.j[0]);
const comp = await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'Compra fornecedor', categoria_id: CAT['Compra de mercadorias'].id, supplier_id: sup.id, valor: 1000, vencimento: dia(10), competencia: hoje, repetir: { modo: 'parcelas', quantidade: 3 } }, A);
check('compra 1.000 em 3x: 333,34 + 333,33 + 333,33 (soma exata)', comp.s === 201 && comp.j.length === 3 && igual(comp.j[0].valor, 333.34) && igual(comp.j[1].valor, 333.33) && igual(comp.j.reduce((s, t) => s + Number(t.valor), 0), 1000), comp.j);
check('parcelas com "(1/3)" na descricao, mesmo grupo e fornecedor', comp.s === 201 && /\(1\/3\)/.test(comp.j[0].descricao) && comp.j.every((t) => t.grupo_id === comp.j[0].grupo_id && t.supplier_nome === sup.nome));
check('categoria de receita numa conta a pagar -> 400', (await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'X', categoria_id: CAT['Outras receitas'].id, valor: 10, vencimento: hoje }, A)).s === 400);
check('valor zero -> 400', (await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'X', valor: 0, vencimento: hoje }, A)).s === 400);
check('data invalida -> 400', (await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'X', valor: 5, vencimento: '31/12/2026' }, A)).s === 400);
const luz = await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'Conta de luz', categoria_id: CAT['Energia, água e gás'].id, valor: '320,50', vencimento: dia(-2), competencia: hoje }, A);
check('conta vencida aparece como "vencido"', luz.s === 201 && luz.j[0].situacao === 'vencido' && Number(luz.j[0].dias_para_vencer) === -2, luz.j);
const notaDup = await api('POST', '/financeiro/titulos', { tipo: 'pagar', descricao: 'NF-e 1234 - Distribuidora', origem: 'nota', supplier_id: sup.id, documento: '1234', categoria_id: CAT['Compra de mercadorias'].id, competencia: hoje,
  parcelas_informadas: [{ numero: '001', vencimento: dia(30), valor: 250 }, { numero: '002', vencimento: dia(60), valor: 250 }] }, A);
check('duplicatas da nota viram 2 contas a pagar (origem nota)', notaDup.s === 201 && notaDup.j.length === 2 && notaDup.j.every((t) => t.origem === 'nota') && notaDup.j[1].documento === '002', notaDup.j);

console.log('\n# 4. Pagar, estornar, receber');
const pagou = await api('POST', `/financeiro/titulos/${luz.j[0].id}/baixar`, { pago_em: hoje, conta_id: banco.j.id, forma_pagamento: 'pix' }, A);
check('pagar a conta de luz pelo Banco', pagou.s === 200 && pagou.j.situacao === 'pago' && igual(pagou.j.valor_pago, 320.5) && pagou.j.conta_nome === 'Banco do Brasil', pagou);
check('pagar de novo -> 409', (await api('POST', `/financeiro/titulos/${luz.j[0].id}/baixar`, {}, A)).s === 409);
const saldo1 = (await api('GET', '/financeiro/contas', null, A)).j.find((c) => c.id === banco.j.id);
check('saldo do Banco: 1.000 - 320,50 = 679,50', igual(saldo1.saldo, 679.5), saldo1);
check('editar conta paga -> 409 (estorne antes)', (await api('PUT', `/financeiro/titulos/${luz.j[0].id}`, { valor: 10 }, A)).s === 409);
const est = await api('POST', `/financeiro/titulos/${luz.j[0].id}/estornar`, null, A);
check('estornar volta para vencido e devolve o saldo', est.s === 200 && est.j.situacao === 'vencido' && igual((await api('GET', '/financeiro/contas', null, A)).j.find((c) => c.id === banco.j.id).saldo, 1000), est);
await api('POST', `/financeiro/titulos/${luz.j[0].id}/baixar`, { pago_em: hoje, conta_id: banco.j.id, valor_pago: '325,00', forma_pagamento: 'boleto' }, A);
check('pagar com juros (valor pago 325,00)', igual((await api('GET', `/financeiro/titulos/${luz.j[0].id}`, null, A)).j.valor_pago, 325));
const rec = await api('POST', '/financeiro/titulos', { tipo: 'receber', descricao: 'Evento fechado (sinal)', categoria_id: CAT['Eventos e serviços'].id, valor: 200, vencimento: hoje, competencia: hoje,
  pago: { pago_em: hoje, conta_id: banco.j.id, forma_pagamento: 'pix' } }, A);
check('conta a receber ja lancada como recebida', rec.s === 201 && rec.j[0].situacao === 'pago' && igual(rec.j[0].valor_pago, 200), rec);
check('saldo do Banco: 1.000 - 325 + 200 = 875', igual((await api('GET', '/financeiro/contas', null, A)).j.find((c) => c.id === banco.j.id).saldo, 875));
const ed = await api('PUT', `/financeiro/titulos/${comp.j[2].id}`, { vencimento: dia(40), observacao: 'combinado com o fornecedor' }, A);
check('editar vencimento de uma parcela em aberto', ed.s === 200 && ed.j.vencimento === dia(40) && ed.j.observacao === 'combinado com o fornecedor', ed);

console.log('\n# 5. Vendas no fluxo: prazo, taxa e conta de cada forma');
check('credito: 30 dias, 3,5%, cai no Banco', (await api('PUT', '/financeiro/formas/cartao_credito', { prazo_dias: 30, taxa_pct: '3,5', conta_id: banco.j.id }, A)).s === 200);
check('pix: na hora, sem taxa, cai no Banco', (await api('PUT', '/financeiro/formas/pix', { prazo_dias: 0, taxa_pct: 0, conta_id: banco.j.id }, A)).s === 200);
check('dinheiro: cai no Cofre', (await api('PUT', '/financeiro/formas/dinheiro', { prazo_dias: 0, taxa_pct: 0, conta_id: cofre.j.id }, A)).s === 200);
check('taxa invalida -> 400', (await api('PUT', '/financeiro/formas/pix', { prazo_dias: 0, taxa_pct: 120 }, A)).s === 400);
await api('POST', '/cash-sessions', { terminal_id: PDV1, valor_inicial: 0 }, A);
const vPix = await api('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: REFRI.id, quantidade: 2 }], forma_pagamento: 'pix' }, A);
const vCred = await api('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: REFRI.id, quantidade: 10 }], forma_pagamento: 'cartao_credito' }, A);
const vDin = await api('POST', '/sales', { terminal_id: PDV1, itens: [{ product_id: REFRI.id, quantidade: 1 }], forma_pagamento: 'dinheiro', valor_recebido: 50 }, A);
check('vendas feitas no PDV (pix, credito, dinheiro)', vPix.s === 201 && vCred.s === 201 && vDin.s === 201, [vPix.s, vCred.s, vDin.s]);
const pPix = Number(vPix.j.total); const pCred = Number(vCred.j.total); const pDin = Number(vDin.j.total);
const contas2 = (await api('GET', '/financeiro/contas', null, A)).j;
check('venda no pix entra hoje no saldo do Banco', igual(contas2.find((c) => c.id === banco.j.id).saldo, 875 + pPix), { saldo: contas2.find((c) => c.id === banco.j.id).saldo, esperado: 875 + pPix });
check('venda em dinheiro entra no Cofre', igual(contas2.find((c) => c.id === cofre.j.id).saldo, pDin), contas2);
const var_ = await api('GET', `/financeiro/vendas-a-receber?de=${hoje}&ate=${dia(40)}`, null, A);
const lc = var_.j.linhas.find((l) => l.forma === 'cartao_credito');
check('venda no credito: a receber em 30 dias, com taxa de 3,5%', !!lc && lc.data === dia(30) && igual(lc.bruto, pCred) && igual(lc.taxa, Math.round(pCred * 3.5) / 100) && igual(lc.liquido, pCred - Math.round(pCred * 3.5) / 100), var_.j);
check('vendas a receber nao listam pix nem dinheiro', var_.j.linhas.every((l) => !['pix', 'dinheiro'].includes(l.forma)));

console.log('\n# 6. Fluxo de caixa');
const fl = await api('GET', `/financeiro/fluxo?de=${dia(-3)}&ate=${dia(35)}`, null, A);
const fh = fl.j.dias.find((x) => x.data === hoje);
check('fluxo: saldo de hoje = soma das contas', fl.s === 200 && igual(fl.j.saldo_hoje, 875 + pPix + pDin), { saldo_hoje: fl.j.saldo_hoje });
check('fluxo: vendas de hoje (pix + dinheiro) realizadas hoje', igual(fh.vendas, pPix + pDin) && fh.realizado, fh);
const d30 = fl.j.dias.find((x) => x.data === dia(30));
check('fluxo: credito previsto em 30 dias (liquido) + duplicata da nota (a pagar 250)', igual(d30.vendas, lc.liquido) && igual(d30.a_pagar, 250) && !d30.realizado, d30);
const d5 = fl.j.dias.find((x) => x.data === dia(5));
check('fluxo: aluguel previsto no dia 5', igual(d5.a_pagar, 1500), d5);
// o saldo encadeia: saldo(d) = saldo(d-1) + previsto(d) depois de hoje
const iH = fl.j.dias.findIndex((x) => x.data === hoje);
const coerente = fl.j.dias.slice(iH + 1).every((x, i) => igual(x.saldo, fl.j.dias[iH + i].saldo + x.mov_previsto));
check('fluxo: saldo projetado encadeado dia a dia', coerente);
check('fluxo: dia anterior desfaz o realizado de hoje', igual(fl.j.dias[iH - 1].saldo, fl.j.saldo_hoje - fh.mov_realizado), { ontem: fl.j.dias[iH - 1].saldo, hoje: fl.j.saldo_hoje, real: fh.mov_realizado });
check('fluxo: menor saldo no periodo informado', !!fl.j.menor_saldo && fl.j.menor_saldo.saldo <= fl.j.saldo_hoje);

console.log('\n# 7. Resultado do mes');
const custo = (await prod.query(`SELECT COALESCE(SUM(si.quantidade * si.custo_unitario), 0) AS c FROM sale_items si WHERE si.sale_id = ANY($1::uuid[])`, [[vPix.j.id, vCred.j.id, vDin.j.id]])).rows[0].c;
const r = await api('GET', `/financeiro/resultado?mes=${mes}`, null, A);
const taxaCred = Math.round(pCred * 3.5) / 100;
check('resultado: receita = vendas do mes', r.s === 200 && igual(r.j.receita, pPix + pCred + pDin), r.j);
check('resultado: taxas do cartao e custo das mercadorias', igual(r.j.taxas, taxaCred) && igual(r.j.cmv, custo), { taxas: r.j.taxas, cmv: r.j.cmv, custo });
check('resultado: lucro bruto = receita - taxas - CMV', igual(r.j.lucro_bruto, r.j.receita - r.j.taxas - r.j.cmv));
check('resultado: aluguel e luz nas despesas; compra de mercadoria fora', r.j.despesas.some((d) => d.categoria === 'Aluguel' && igual(d.valor, 1500)) && r.j.despesas.some((d) => d.categoria === 'Energia, água e gás' && igual(d.valor, 325)) && !r.j.despesas.some((d) => d.categoria === 'Compra de mercadorias') && r.j.fora_do_resultado.some((d) => d.categoria === 'Compra de mercadorias'), r.j.despesas);
check('resultado: evento nas outras receitas', r.j.outras_receitas.some((d) => d.categoria === 'Eventos e serviços' && igual(d.valor, 200)));
check('resultado = lucro bruto - despesas + outras receitas', igual(r.j.resultado, r.j.lucro_bruto - r.j.total_despesas + r.j.total_outras_receitas));
check('resultado: serie dos ultimos 6 meses', Array.isArray(r.j.serie) && r.j.serie.length === 6 && r.j.serie[5].mes === mes);

console.log('\n# 8. Resumo, listas e cancelamento');
const rs = await api('GET', '/financeiro/resumo', null, A);
check('resumo: saldo, a pagar na semana (aluguel), resultado do mes', rs.s === 200 && igual(rs.j.saldo, fl.j.saldo_hoje) && igual(rs.j.pagar.semana, 1500) && igual(rs.j.mes.resultado, r.j.resultado), rs.j);
check('resumo: proximos vencimentos', Array.isArray(rs.j.proximos) && rs.j.proximos.some((t) => t.descricao === 'Aluguel loja'));
const lp = await api('GET', '/financeiro/titulos?tipo=pagar&situacao=pendente', null, A);
check('lista a pagar pendentes (sem a luz paga) com total', lp.s === 200 && !lp.j.titulos.some((t) => t.id === luz.j[0].id) && igual(lp.j.totais.pendente, 1500 * 3 + 1000 + 500), lp.j.totais);
check('busca por fornecedor', (await api('GET', `/financeiro/titulos?q=${encodeURIComponent(sup.nome.slice(0, 5))}`, null, A)).j.titulos.length >= 5);
check('cancelar sem motivo -> 400', (await api('POST', `/financeiro/titulos/${alu.j[1].id}/cancelar`, {}, A)).s === 400);
const canc = await api('POST', `/financeiro/titulos/${alu.j[1].id}/cancelar`, { motivo: 'Mudou de ponto', todas_do_grupo: true }, A);
check('cancelar o 2o aluguel e os seguintes (fica o 1o)', canc.s === 200 && canc.j.cancelados === 2 && (await api('GET', `/financeiro/titulos/${alu.j[0].id}`, null, A)).j.situacao === 'aberto', canc);
check('cancelar conta paga -> 409', (await api('POST', `/financeiro/titulos/${luz.j[0].id}/cancelar`, { motivo: 'teste' }, A)).s === 409);
const aud = (await prod.query(`SELECT acao FROM audit_logs WHERE tenant_id = $1 AND acao LIKE 'fin_%'`, [empresa])).rows.map((x) => x.acao);
check('auditoria registra criar, pagar, estornar e cancelar', ['fin_conta_pagar_criar', 'fin_conta_paga', 'fin_estorno', 'fin_titulo_cancelar'].every((a) => aud.includes(a)), [...new Set(aud)]);

console.log('\n# 9. Modulo desligado');
await api('PATCH', `/master/empresas/${empresa}`, { recursos: { financeiro: null } }, MAS);
check('modulo desligado: 403', (await api('GET', '/financeiro/titulos', null, A)).s === 403);

await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
