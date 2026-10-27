// e2e do Garcom, Fase 3: comissoes (calculo por item em centavos, gatilhos, estornos, bonus por meta, acertos + Financeiro, extrato do
// garcom, permissoes, periodos). npm run test:e2e:garcom-fase3   (API em http://localhost:3000)
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
const EMAIL_M = 'e2e.gf3.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 600)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const uuid = () => crypto.randomUUID();
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0049;
const n1 = async (sql, p) => Number((await prod.query(sql, p)).rows[0].n);

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E GF3 Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.gf3.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E GF3 ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Casa', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId, permissoes) {
  const email = `e2e.gf3.${nome.toLowerCase()}.${SUF}@girostock.local`;
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
await api('PUT', `/locations/${L1}/recebimento-garcom`, { garcom_recebe: true, taxa_servico_pct: 10, garcom_formas: { pix: true, cartao: true, dinheiro: true } }, E.token);
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, E.token)).j.id;
check('abre o caixa', (await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 100 }, E.token)).s === 201);
await api('POST', '/categories', { nome: 'Bar' }, E.token);
await api('POST', '/categories', { nome: 'Comida' }, E.token);
const cats = Object.fromEntries((await api('GET', '/categories', null, E.token)).j.map((c) => [c.nome, c.id]));
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const produto = async (nome, venda, cat, custo = 0.01) => (await api('POST', '/products', { nome, categoria_id: cats[cat], barcode: bc(), unidade: 'UN', preco_custo: custo, preco_venda: venda, location_id: L1, estoque_inicial: 500 }, E.token)).j.id;
const CERV = await produto('Cerveja F3', 8, 'Bar');
const PETI = await produto('Petisco F3', 25, 'Comida');
const INGR = await produto('Ingresso F3', 30, 'Bar');
const BALA = await produto('Bala F3', 0.33, 'Bar');
const BAL2 = await produto('Bala2 F3', 1.35, 'Bar');
check('produto "fora da comissão" (PATCH)', (await api('PATCH', `/products/${INGR}`, { fora_da_comissao: true }, E.token)).s === 200);
check('PATCH de produto exige boolean (400) e a área Estoque', (await api('PATCH', `/products/${INGR}`, { fora_da_comissao: 'sim' }, E.token)).s === 400);
const G1 = await usuario(E, 'GarcomA', 'Garçom', L1, { ReceberNoApp: true });
const G2 = await usuario(E, 'GarcomB', 'Garçom', L1, { ReceberNoApp: true });
const GN = await usuario(E, 'GarcomN', 'Garçom', L1);
const CX = await usuario(E, 'CaixaX', 'Caixa/Operador', L1);
const GER = await usuario(E, 'GerenteX', 'Gerente', L1);
check('usuários criados', [G1, G2, GN, CX, GER].every((u) => u.status === 201));
check('Comissoes: Administrador/Gerente sim, Garçom e Caixa não', GER.usuario.areas.Comissoes === true && G1.usuario.areas.Comissoes === false && CX.usuario.areas.Comissoes === false);
check('override de comissão por garçom (PATCH /users, só gerência com Configurações)', (await api('PATCH', `/users/${G2.id}`, { comissao_pct: 12 }, E.token)).s === 200 && (await api('PATCH', `/users/${G2.id}`, { comissao_pct: 120 }, E.token)).s === 400 && (await api('PATCH', `/users/${G2.id}`, { comissao_pct: 3 }, GER.token)).s === 403);
const regras0 = await api('PUT', '/comissoes/regras', { pct_padrao: 5, por_categoria: { [cats.Comida]: 10 }, taxa_servico_repasse_pct: 100, base: 'liquida' }, E.token);
check('regras: padrão 5%, Comida 10%, taxa 100%, base líquida', regras0.s === 200 && regras0.j.pct_padrao === 5 && regras0.j.por_categoria[cats.Comida] === 10 && regras0.j.base === 'liquida', regras0.j);

const abrir = (tok, id) => api('POST', '/garcom/comandas', { tipo: 'mesa', identificador: String(id) }, tok);
const rodada = async (tok, comandaId, itens) => (await api('POST', `/garcom/comandas/${comandaId}/rodadas`, { client_id: uuid(), itens }, tok)).j.rodada_id;
const fechar = (comandaId, corpo = {}) => api('POST', `/comandas/${comandaId}/fechar`, { terminal_id: T1, forma_pagamento: 'pix', ...corpo }, GER.token);
const receber = (tok, comandaId, ids, extra = {}) => api('POST', `/garcom/comandas/${comandaId}/receber`, { order_ids: ids, forma: 'pix', ...extra }, tok);
const lanc = async (comandaId) => (await prod.query(`SELECT c.*, p.nome AS produto FROM comissoes c LEFT JOIN order_items oi ON oi.id = c.order_item_id LEFT JOIN products p ON p.id = oi.product_id WHERE c.comanda_id = $1 ORDER BY c.criado_em, c.id`, [comandaId])).rows;
const resumo = async (tok = E.token, qs = 'periodo=noite') => (await api('GET', `/comissoes/resumo?${qs}`, null, tok)).j;
const doGarcom = (r, id) => r.garcons.find((g) => g.garcom_id === id) || {};

console.log('\n# 1. Cálculo: duas categorias, desconto, taxa de serviço e produto fora da comissão');
const mA = (await abrir(G1.token, 1)).j;
await rodada(G1.token, mA.id, [{ product_id: CERV, quantidade: 3 }, { product_id: PETI, quantidade: 2 }, { product_id: INGR, quantidade: 1 }]);
check('comanda aberta (sem dinheiro entrando) NÃO gera comissão', (await lanc(mA.id)).length === 0 && igual(doGarcom(await resumo(), G1.id).a_pagar || 0, 0));
// conta: itens 24,00 (Bar 5%) + 50,00 (Comida 10%) + 30,00 (fora) = 104,00; desconto 10,40 (10%), taxa 10% de (104,00 − 10,40) = 9,36
// rateio do desconto (10.40) nos itens: 2,40 / 5,00 / 3,00 -> bases 21,60 / 45,00 / 27,00(fora)
// comissão: cerveja 5% de 21,60 = 1,08; petisco 10% de 45,00 = 4,50 (soma 5,58)
// taxa 9,36 rateada: 2,16 / 4,50 / 2,70(fora, não paga a ninguém) -> serviço do garçom = 2,16 + 4,50 = 6,66; total = 12,24
const fA = await fechar(mA.id, { desconto: 10.4, cobrar_taxa: true });
check('fecha a comanda: 104,00 − 10,40 + taxa 9,36 = 102,96', fA.s === 200 && igual(fA.j.venda.total, 102.96) && igual(fA.j.venda.taxa_servico, 9.36), fA.j);
const lA = await lanc(mA.id);
const por = (nome) => lA.find((l) => l.produto === nome);
check('3 itens, 2 lançamentos (ingresso fora da comissão não gera)', lA.length === 2 && !por('Ingresso F3') && lA.every((l) => l.origem === 'fechamento'), lA.map((l) => l.produto));
check('cerveja: base 21,60 × 5% = 1,08 (+ serviço 2,16)', igual(por('Cerveja F3').base_valor, 21.6) && igual(por('Cerveja F3').valor_produtos, 1.08) && igual(por('Cerveja F3').valor_servico, 2.16) && Number(por('Cerveja F3').pct_aplicado) === 5, por('Cerveja F3'));
check('petisco: base 45,00 × 10% (categoria Comida) = 4,50 (+ serviço 4,50)', igual(por('Petisco F3').base_valor, 45) && igual(por('Petisco F3').valor_produtos, 4.5) && igual(por('Petisco F3').valor_servico, 4.5) && Number(por('Petisco F3').pct_aplicado) === 10, por('Petisco F3'));
const rs1 = await resumo();
const g1 = doGarcom(rs1, G1.id);
check('resumo: vendas-base 66,60; comissão 5,58; serviço 6,66; total 12,24; a pagar 12,24', igual(g1.vendas_base, 66.6) && igual(g1.comissao_produtos, 5.58) && igual(g1.taxa_servico, 6.66) && igual(g1.total, 12.24) && igual(g1.a_pagar, 12.24) && g1.comandas === 1, g1);
check('a regra aplicada fica gravada em cada lançamento (snapshot)', lA.every((l) => l.regra_snapshot && l.regra_snapshot.base === 'liquida' && Number(l.regra_snapshot.pct_padrao) === 5));

console.log('\n# 2. Arredondamento em centavos (por item, meio centavo para cima)');
// itens 0,99 (3 × 0,33) e 1,35; recebimento em Pix com taxa de 10% de 2,34 = 0,23; rateio da taxa (maior resto): 0,10 / 0,13
// comissão: 5% de 0,99 = 0,0495 -> 0,05; 5% de 1,35 = 0,0675 -> 0,07; serviço 0,10 e 0,13 -> total 0,35
const mB = (await abrir(G1.token, 2)).j;
const rB = await rodada(G1.token, mB.id, [{ product_id: BALA, quantidade: 3 }, { product_id: BAL2, quantidade: 1 }]);
const pB = await receber(G1.token, mB.id, [rB], { cobrar_taxa: true });
check('recebimento de 2,34 com taxa 0,23', pB.s === 201 && igual(pB.j.pagamento.valor_produtos, 2.34) && igual(pB.j.pagamento.taxa_servico, 0.23), pB.j);
const lB = await lanc(mB.id);
const bala = lB.find((l) => l.produto === 'Bala F3'); const bal2 = lB.find((l) => l.produto === 'Bala2 F3');
check('bala: 0,05 + serviço 0,10; bala2: 0,07 + serviço 0,13 (a soma da taxa fecha 0,23)', igual(bala.valor_produtos, 0.05) && igual(bala.valor_servico, 0.1) && igual(bal2.valor_produtos, 0.07) && igual(bal2.valor_servico, 0.13) && igual(Number(bala.valor_servico) + Number(bal2.valor_servico), 0.23), lB.map((l) => [l.produto, l.valor_produtos, l.valor_servico]));
check('origem do lançamento: recebimento (gerado na hora, com o pagamento)', lB.every((l) => l.origem === 'recebimento' && l.comanda_pagamento_id === pB.j.pagamento.id));
check('o total do extrato da comanda bate com a soma dos itens (0,35)', await (async () => {
  const ext = (await api('GET', `/comissoes/garcons/${G1.id}`, null, GER.token)).j;
  const c = ext.comandas.find((x) => x.comanda_id === mB.id);
  return c && igual(c.total, 0.35) && c.itens.length === 2;
})());
// fecha a comanda B no caixa: tudo pago no app -> nenhum lançamento novo
const nAntes = (await lanc(mB.id)).length;
const fB = await fechar(mB.id);
check('fechar comanda já paga no app NÃO duplica a comissão', fB.s === 200 && (await lanc(mB.id)).length === nAntes && nAntes === 2, nAntes);

console.log('\n# 3. Gatilhos: recebimento (só as rodadas quitadas) e fechamento (só o restante); override do garçom');
const mC = (await abrir(G2.token, 3)).j;
const c1 = await rodada(G2.token, mC.id, [{ product_id: CERV, quantidade: 1 }]);
const c2 = await rodada(G2.token, mC.id, [{ product_id: PETI, quantidade: 1 }]);
await receber(G2.token, mC.id, [c1]);
const lC1 = await lanc(mC.id);
check('recebimento da rodada 1 gera comissão IMEDIATA só dela: 12% (override) × 8,00 = 0,96', lC1.length === 1 && lC1[0].produto === 'Cerveja F3' && igual(lC1[0].valor_produtos, 0.96) && Number(lC1[0].pct_aplicado) === 12, lC1);
const fC = await fechar(mC.id);
const lC2 = await lanc(mC.id);
check('o fechamento gera só o restante: petisco 12% (override vence a categoria) × 25,00 = 3,00', fC.s === 200 && lC2.length === 2 && igual(lC2.find((l) => l.produto === 'Petisco F3').valor_produtos, 3) && lC2.find((l) => l.produto === 'Petisco F3').origem === 'fechamento', lC2);
check('nada duplica: os 2 itens têm 1 lançamento cada', new Set(lC2.map((l) => l.order_item_id)).size === 2);
check('o banco impede o 2º lançamento do mesmo item (índice único)', await (async () => { try { await prod.query(`INSERT INTO comissoes (tenant_id, location_id, garcom_id, order_item_id, origem, valor_produtos) VALUES ($1, $2, $3, $4, 'fechamento', 1)`, [E.id, L1, G2.id, lC2[0].order_item_id]); return false; } catch (e) { return e.code === '23505'; } })());
check('fechar de novo -> 409 e continua 2 lançamentos', (await fechar(mC.id)).s === 409 && (await lanc(mC.id)).length === 2);

console.log('\n# 4. Comanda cancelada e transferência');
const mD = (await abrir(G1.token, 4)).j;
const d1 = await rodada(G1.token, mD.id, [{ product_id: CERV, quantidade: 1 }]);
check('rodada só enviada não gera comissão', (await lanc(mD.id)).length === 0);
await api('POST', `/garcom/rodadas/${d1}/cancelar`, {}, G1.token);
check('comanda cancelada sem consumo: nenhum lançamento', (await api('POST', `/garcom/comandas/${mD.id}/cancelar`, {}, G1.token)).s === 200 && (await lanc(mD.id)).length === 0);
const mE = (await abrir(G1.token, 5)).j;
await rodada(G1.token, mE.id, [{ product_id: CERV, quantidade: 1 }]);
check('transferência para o G2', (await api('POST', `/garcom/comandas/${mE.id}/transferir`, { para_user_id: G2.id }, G1.token)).s === 200);
await rodada(G2.token, mE.id, [{ product_id: PETI, quantidade: 1 }]);
const fE = await fechar(mE.id);
const lE = await lanc(mE.id);
check('G1 fica com os itens dele (cerveja 5% × 8,00 = 0,40) e G2 só com os dele (petisco 12% × 25,00 = 3,00)', fE.s === 200 && lE.length === 2 && igual(lE.find((l) => l.garcom_id === G1.id).valor_produtos, 0.4) && igual(lE.find((l) => l.garcom_id === G2.id).valor_produtos, 3), lE.map((l) => [l.garcom_id === G1.id ? 'G1' : 'G2', l.produto, l.valor_produtos]));

console.log('\n# 5. Estornos: pendente vira estornada; já paga gera lançamento negativo');
const mF = (await abrir(G1.token, 6)).j;
const f1 = await rodada(G1.token, mF.id, [{ product_id: CERV, quantidade: 1 }]);
const pF = (await receber(G1.token, mF.id, [f1])).j.pagamento;
const est1 = await api('POST', `/garcom/comandas/${mF.id}/receber/${pF.id}/estornar`, { motivo: 'forma errada' }, GER.token);
const lF1 = await lanc(mF.id);
check('estorno do recebimento: lançamento pendente fica "estornada" (nada apagado)', est1.s === 200 && lF1.length === 1 && lF1[0].status === 'estornada' && lF1[0].estornado_em, lF1);
const pF2 = await receber(G1.token, mF.id, [f1]);
const lF2 = await lanc(mF.id);
check('receber de novo gera um lançamento novo (o antigo segue estornado)', pF2.s === 201 && lF2.length === 2 && lF2.filter((l) => !l.estornado_em).length === 1);
const mG = (await abrir(G1.token, 7)).j;
const g1r = await rodada(G1.token, mG.id, [{ product_id: CERV, quantidade: 1 }]);
const fG = await fechar(mG.id);
const lG = await lanc(mG.id);
check('fechamento da comanda G gera 0,40', fG.s === 200 && lG.length === 1 && igual(lG[0].valor_produtos, 0.4));
const canc = await api('POST', `/sales/${fG.j.venda.id}/cancel`, { motivo: 'cliente devolveu' }, GER.token);
const lG2 = await lanc(mG.id);
check('cancelar a venda estorna o lançamento pendente', canc.s === 200 && lG2.length === 1 && lG2[0].status === 'estornada', lG2);
void g1r;

console.log('\n# 6. Períodos (noite com corte, semana, mês, personalizado)');
const hojeSP = (await prod.query(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo') - interval '6 hours')::date::text AS d`)).rows[0].d;
const sem = (await prod.query(`SELECT date_trunc('week', $1::date)::date::text AS ini, (date_trunc('week', $1::date)::date + 6)::text AS fim, date_trunc('month', $1::date)::date::text AS mi, (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS mf`, [hojeSP])).rows[0];
const rNoite = await resumo(E.token, 'periodo=noite');
check(`noite (corte 06:00): ${hojeSP}`, rNoite.janela.de === hojeSP && rNoite.janela.ate === hojeSP, rNoite.janela);
const rSem = await resumo(E.token, 'periodo=semana');
check(`semana: ${sem.ini} a ${sem.fim}`, rSem.janela.de === sem.ini && rSem.janela.ate === sem.fim);
const rMes = await resumo(E.token, 'periodo=mes');
check(`mês: ${sem.mi} a ${sem.mf}`, rMes.janela.de === sem.mi && rMes.janela.ate === sem.mf);
check('semana e mês incluem os lançamentos de hoje', igual(doGarcom(rSem, G1.id).total, doGarcom(rNoite, G1.id).total) && igual(doGarcom(rMes, G1.id).total, doGarcom(rNoite, G1.id).total));
const ontem = (await prod.query(`SELECT ($1::date - 1)::text AS d`, [hojeSP])).rows[0].d;
const rOntem = await resumo(E.token, `periodo=personalizado&de=${ontem}&ate=${ontem}`);
check('personalizado em outro dia: sem lançamentos de hoje', rOntem.garcons.length === 0 && (await api('GET', '/comissoes/resumo?periodo=personalizado&de=x&ate=y', null, E.token)).s === 400);
// o corte muda o dia comercial: com corte 23h, agora (antes das 23h) ainda e a "noite" de ontem; os lançamentos de agora caem nela
const horaSP = Number((await prod.query(`SELECT EXTRACT(HOUR FROM now() AT TIME ZONE 'America/Sao_Paulo')::int AS h`)).rows[0].h);
await api('PUT', '/comissoes/regras', { corte_hora: 23 }, E.token);
const ontem23 = (await prod.query(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo') - interval '23 hours')::date::text AS d`)).rows[0].d;
const rCorte = await resumo(E.token, 'periodo=noite');
check(`corte configurável (23h): a noite atual é ${ontem23} e os lançamentos de agora entram nela`, rCorte.janela.de === ontem23 && rCorte.garcons.length > 0 && rCorte.corte_hora === 23, [rCorte.janela, horaSP]);
await api('PUT', '/comissoes/regras', { corte_hora: 6 }, E.token);

console.log('\n# 7. Permissões e extrato do próprio garçom');
const ext1 = await api('GET', '/garcom/extrato', null, G1.token);
check('garçom vê a PRÓPRIA comissão da noite e por comanda', ext1.s === 200 && ext1.j.comissao && ext1.j.comissao.noite.total > 0 && ext1.j.comissao.por_comanda.length >= 3, ext1.j.comissao && ext1.j.comissao.noite);
const ext2 = await api('GET', '/garcom/extrato', null, G2.token);
check('o extrato de um não traz comandas do outro (G2 só tem as dele)', ext2.s === 200 && ext2.j.comissao.por_comanda.every((c) => [mC.id, mE.id].includes(c.comanda_id)), ext2.j.comissao.por_comanda.map((c) => c.numero));
check('garçom não acessa as rotas de gestão (403)', (await Promise.all(['/comissoes/regras', '/comissoes/resumo', `/comissoes/garcons/${G2.id}`, '/comissoes/acertos'].map((r) => api('GET', r, null, G1.token)))).every((r) => r.s === 403));
check('caixa sem a permissão Comissoes -> 403; gerente e administrador acessam', (await api('GET', '/comissoes/resumo', null, CX.token)).s === 403 && (await api('GET', '/comissoes/resumo', null, GER.token)).s === 200 && (await api('GET', '/comissoes/regras', null, E.token)).s === 200);
check('regras: percentual fora de 0–100 e meta sem bônus são recusados (400)', (await api('PUT', '/comissoes/regras', { pct_padrao: 120 }, GER.token)).s === 400 && (await api('PUT', '/comissoes/regras', { meta_valor: 100 }, GER.token)).s === 400);

console.log('\n# 8. Acerto, bônus por meta, estorno após o acerto e Financeiro');
const antes = await resumo();
const aPagarG1 = doGarcom(antes, G1.id).a_pagar; const aPagarG2 = doGarcom(antes, G2.id).a_pagar;
console.log(`       (a pagar antes do acerto: G1 ${aPagarG1} · G2 ${aPagarG2})`);
const mH = (await abrir(G1.token, 8)).j;
const h1 = await rodada(G1.token, mH.id, [{ product_id: CERV, quantidade: 2 }]);
const pH = (await receber(G1.token, mH.id, [h1])).j.pagamento; // recebimento de 16,00 -> 0,80 pendente
const conta = (await api('POST', '/financeiro/contas', { nome: 'Banco E2E F3', tipo: 'banco', saldo_inicial: 0 }, E.token)).j;
const baseG1 = await n1(`SELECT COALESCE(SUM(base_valor), 0) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND origem IN ('recebimento', 'fechamento') AND estornado_em IS NULL`, [E.id, G1.id]);
await api('PUT', '/comissoes/regras', { meta_valor: 1, meta_bonus_pct: 2, meta_periodo: 'noite' }, E.token);
const bonusEsperado = Math.floor((Math.round(baseG1 * 100) * 200 + 5000) / 10000) / 100;
const prevBonus = doGarcom(await resumo(), G1.id).bonus_previsto;
check('bônus previsto (meta batida: 2% sobre a base da noite) aparece no resumo', igual(prevBonus, bonusEsperado) && prevBonus > 0, [prevBonus, bonusEsperado, baseG1]);
const totAntes = doGarcom(await resumo(), G1.id).a_pagar;
const ac = await Promise.all([1, 2].map(() => api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite', forma_pagamento: 'pix', conta_id: conta.id, lancar_financeiro: true, observacao: 'acerto e2e' }, GER.token)));
check('dois acertos simultâneos do mesmo garçom: um fecha (201) e o outro é recusado (409)', ac.filter((r) => r.s === 201).length === 1 && ac.filter((r) => r.s === 409).length === 1, ac.map((r) => r.s));
const a1 = ac.find((r) => r.s === 201).j;
check(`acerto = a pagar (${totAntes}) + bônus (${bonusEsperado}) = ${Number((totAntes + bonusEsperado).toFixed(2))}`, igual(a1.acerto.total, totAntes + bonusEsperado), [a1.acerto.total, totAntes, bonusEsperado]);
check('lançamentos do garçom viram "paga" com o acerto; nada pendente (exceto o que não era da noite)', (await n1(`SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND status = 'pendente'`, [E.id, G1.id])) === 0 && (await n1(`SELECT count(*) AS n FROM comissoes WHERE acerto_id = $1`, [a1.acerto.id])) > 3);
check('bônus lançado UMA vez (origem bonus, ligado ao acerto)', (await n1(`SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND origem = 'bonus' AND acerto_id = $3`, [E.id, G1.id, a1.acerto.id])) === 1);
const tit = (await prod.query(`SELECT t.*, c.nome AS categoria FROM fin_titulos t JOIN fin_categorias c ON c.id = t.categoria_id WHERE t.id = $1`, [a1.acerto.titulo_id])).rows[0];
check('título "Comissões" a pagar criado e BAIXADO no Financeiro (conta escolhida, valor do acerto)', !!tit && tit.categoria === 'Comissões' && tit.tipo === 'pagar' && igual(tit.valor, a1.acerto.total) && igual(tit.valor_pago, a1.acerto.total) && tit.pago_em && tit.conta_id === conta.id, tit);
const res = (await api('GET', `/financeiro/resultado?mes=${hojeSP.slice(0, 7)}`, null, E.token)).j;
check('Financeiro: o resultado do mês lista a despesa Comissões com o valor do acerto', (res.despesas || []).some((d) => d.categoria === 'Comissões' && igual(d.valor, a1.acerto.total)), res.despesas);
const rec = (await api('GET', `/comissoes/acertos/${a1.acerto.id}`, null, GER.token)).j;
check('recibo: por garçom, com comandas e total igual ao acerto', rec.garcons.length === 1 && igual(rec.garcons[0].valor, a1.acerto.total) && igual(rec.garcons[0].linhas.reduce((s, l) => s + l.valor, 0), a1.acerto.total) && rec.empresa_nome, rec);
check('histórico de acertos lista o acerto', (await api('GET', '/comissoes/acertos', null, GER.token)).j.some((x) => x.id === a1.acerto.id));
check('acertar de novo o mesmo garçom: nada a acertar (409)', (await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite' }, GER.token)).s === 409);
check('bônus não se repete no mesmo período (sem lançamento novo)', (await n1(`SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND origem = 'bonus'`, [E.id, G1.id])) === 1 && igual(doGarcom(await resumo(), G1.id).bonus_previsto, 0));
// estorno DEPOIS do acerto: o lançamento pago continua pago e nasce um negativo pendente
const est2 = await api('POST', `/garcom/comandas/${mH.id}/receber/${pH.id}/estornar`, { motivo: 'cliente pediu estorno' }, GER.token);
const lH = await lanc(mH.id);
const neg = lH.find((l) => l.origem === 'ajuste');
check('estorno após o acerto: o pago segue pago e gera lançamento NEGATIVO pendente (−0,80)', est2.s === 200 && lH.some((l) => l.status === 'paga' && l.estornado_em) && neg && neg.status === 'pendente' && igual(neg.valor_produtos, -0.8) && neg.estorno_de, lH.map((l) => [l.origem, l.status, l.valor_produtos]));
const mI = (await abrir(G1.token, 9)).j;
const i1 = await rodada(G1.token, mI.id, [{ product_id: CERV, quantidade: 4 }]);
await receber(G1.token, mI.id, [i1]); // 32,00 -> 1,60
const aPagar2 = doGarcom(await resumo(), G1.id).a_pagar;
check('o próximo acerto desconta o negativo: 1,60 − 0,80 = 0,80', igual(aPagar2, 0.8), aPagar2);
const a2 = await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite', forma_pagamento: 'dinheiro', lancar_financeiro: false }, GER.token);
check('segundo acerto (sem Financeiro): 0,80, negativo quitado', a2.s === 201 && igual(a2.j.acerto.total, 0.8) && a2.j.acerto.titulo_id === null && (await n1(`SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND status = 'pendente'`, [E.id, G1.id])) === 0, a2.j);
const mJ = (await abrir(G1.token, 10)).j; // só para criar um negativo maior que o ganho
const j1 = await rodada(G1.token, mJ.id, [{ product_id: CERV, quantidade: 1 }]);
const pJ = (await receber(G1.token, mJ.id, [j1])).j.pagamento;
await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite' }, GER.token);
await api('POST', `/garcom/comandas/${mJ.id}/receber/${pJ.id}/estornar`, { motivo: 'teste de saldo negativo' }, GER.token);
check('saldo negativo no acerto: total ≤ 0 é recusado (409) e o negativo segue para o próximo', (await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite' }, GER.token)).s === 409 && (await n1(`SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 AND status = 'pendente' AND valor_produtos < 0`, [E.id, G1.id])) === 1);
const aj = await api('POST', '/comissoes/ajustes', { garcom_id: G2.id, valor: 5, motivo: 'divisão de mesa com o G1' }, GER.token);
const aj2 = await api('POST', '/comissoes/ajustes', { garcom_id: G1.id, valor: -5, motivo: 'divisão de mesa com o G2' }, GER.token);
check('ajuste manual (dividir comissão): +5,00 para um e −5,00 para outro, auditado', aj.s === 201 && aj2.s === 201 && (await api('POST', '/comissoes/ajustes', { garcom_id: G2.id, valor: 0, motivo: 'x' }, GER.token)).s === 400 && (await api('POST', '/comissoes/ajustes', { garcom_id: G2.id, valor: 1, motivo: '' }, GER.token)).s === 400);
const a3 = await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id, G2.id], periodo: 'noite', forma_pagamento: 'pix', lancar_financeiro: true }, GER.token);
const ps = await prod.query(`SELECT garcom_id, valor FROM comissao_acerto_itens WHERE acerto_id = $1`, [a3.j.acerto && a3.j.acerto.id]);
check('acerto de dois garçons: só quem tem total > 0 entra (G1 ficou negativo e segue pendente)', a3.s === 201 && ps.rows.length === 1 && ps.rows[0].garcom_id === G2.id && igual(a3.j.acerto.total, aPagarG2 + 5 + 1.16), [a3.s, ps.rows, a3.j, aPagarG2]);
check('acerto com "Lançar no Financeiro" cria o título: 6,96 + ajuste 5,00 + bônus da meta (2% de 58,00 = 1,16) = 13,12', !!a3.j.acerto && !!a3.j.acerto.titulo_id && igual(a3.j.acerto.total, 13.12), a3.j.acerto);
check('G2 não pode acertar G de outra empresa (garçom inválido -> 400)', (await api('POST', '/comissoes/acertos', { garcom_ids: [uuid()], periodo: 'noite' }, GER.token)).s === 400);

console.log('\n# 9. Simulação, módulo desligado e isolamento');
const sim = await api('POST', '/comissoes/simulacao', { regras: { pct_padrao: 10 } }, GER.token);
check('simulação com uma comanda real recente (sem gravar nada)', sim.s === 200 && sim.j.comanda && sim.j.itens.length > 0 && sim.j.total >= 0, sim.j);
const nLanc = await n1('SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1', [E.id]);
await api('POST', '/comissoes/simulacao', {}, GER.token);
check('simular não cria lançamentos', await n1('SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1', [E.id]) === nLanc);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: false } }, MAS);
check('módulo desligado: gestão e extrato indisponíveis (403)', (await api('GET', '/comissoes/resumo', null, GER.token)).s === 403 && (await api('GET', '/garcom/extrato', null, G1.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { garcom: true } }, MAS);
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { pedidos: true, garcom: true } }, MAS);
const rF = await api('GET', '/comissoes/resumo', null, F.token);
check('outra empresa não vê nada da primeira (resumo vazio, extrato 404, ajuste/acerto 404/400)', rF.s === 200 && rF.j.garcons.length === 0 && (await api('GET', `/comissoes/garcons/${G1.id}`, null, F.token)).s === 404 && (await api('POST', '/comissoes/ajustes', { garcom_id: G1.id, valor: 1, motivo: 'invasor' }, F.token)).s === 404 && (await api('POST', '/comissoes/acertos', { garcom_ids: [G1.id], periodo: 'noite' }, F.token)).s === 400);
const acoes = (await prod.query(`SELECT DISTINCT acao FROM audit_logs WHERE tenant_id = $1`, [E.id])).rows.map((r) => r.acao);
check('auditoria: regras, ajuste, acerto, estorno e % por garçom', ['comissao_regras', 'comissao_ajuste', 'comissao_acerto', 'comissao_estorno', 'comissao_pct_garcom', 'produto_fora_da_comissao'].every((a) => acoes.includes(a)), acoes);

console.log('\n# 10. Regressão');
const pm = await api('POST', '/orders', { location_id: L1, tipo: 'mesa', endereco: 'Mesa 90', itens: [{ product_id: CERV, quantidade: 1 }] }, E.token);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'em_preparo' }, E.token);
await api('POST', `/orders/${pm.j.id}/status`, { para: 'pronto' }, E.token);
check('pedido comum e venda direta seguem normais e NÃO geram comissão', (await api('POST', `/orders/${pm.j.id}/status`, { para: 'finalizado', forma_pagamento: 'pix', terminal_id: T1 }, E.token)).s === 200 && (await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: CERV, quantidade: 1 }], forma_pagamento: 'pix' }, E.token)).s === 201 && (await n1('SELECT count(*) AS n FROM comissoes WHERE tenant_id = $1', [E.id])) === nLanc);
const rcx = await api('GET', '/comissoes/regras', null, E.token);
check('regras gravadas continuam: bônus 2% por noite com meta 1,00', rcx.j.meta_valor === 1 && rcx.j.meta_bonus_pct === 2 && rcx.j.meta_periodo === 'noite');

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.gf3.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E GF3 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
