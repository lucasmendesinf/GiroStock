// Teste ponta a ponta de combos e complementos (adicionais): cadastro, regras dos grupos, preco, baixa de
// estoque/insumos, falta de estoque, estorno no cancelamento, reserva e finalizacao de pedido.
//
// Uso (banco de DESENVOLVIMENTO recem-criado: npm run migrate && npm run seed; API rodando):
//   API_URL=http://localhost:3000 npm run test:e2e:combos
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
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 400)}`); }
};
async function api(method, rota, body, tok) {
  try {
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
const L = Object.fromEntries((await api('GET', '/locations', null, A)).j.map((l) => [l.nome, l.id]));
const produtos = (await api('GET', '/products', null, A)).j;
const REFRI = produtos.find((p) => p.codigo_interno === 'PRD-0001');
const XB = produtos.find((p) => p.codigo_interno === 'PRD-0002');
const insumos = Object.fromEntries((await api('GET', '/ingredients', null, A)).j.map((i) => [i.nome, i]));
const PDVL = (await api('GET', '/terminals', null, A)).j.find((t) => t.nome === 'PDV Lanchonete').id;
await api('POST', '/stock-movements', { product_id: REFRI.id, tipo: 'transferencia', quantidade: 20, location_origem_id: L.Distribuidora, location_destino_id: L.Lanchonete, motivo: 'abastecer e2e combos' }, A);
await api('POST', '/cash-sessions', { terminal_id: PDVL, valor_inicial: 0 }, A);
const saldoIns = async (nome) => Number((await prod.query(`SELECT saldo FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2`, [insumos[nome].id, L.Lanchonete])).rows[0].saldo);
const saldoProd = async (id) => Number(((await prod.query(`SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2`, [id, L.Lanchonete])).rows[0] || { saldo: 0 }).saldo);
const venda = (itens) => api('POST', '/sales', { terminal_id: PDVL, itens, forma_pagamento: 'pix' }, A);

console.log('\n# 1. Grupos e complementos');
check('máximo menor que o mínimo -> 400', (await api('POST', '/complement-groups', { nome: 'Ruim', minimo: 2, maximo: 1 }, A)).s === 400);
const gAd = await api('POST', '/complement-groups', { nome: 'Adicionais', minimo: 0, maximo: 3 }, A);
check('cria grupo "Adicionais" (0 a 3)', gAd.s === 201 && gAd.j.minimo === 0 && gAd.j.maximo === 3, gAd);
check('nome de grupo repetido -> 409', (await api('POST', '/complement-groups', { nome: 'adicionais' }, A)).s === 409);
check('complemento com insumo sem quantidade -> 400', (await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Bacon extra', preco: 3, ingredient_id: insumos.Bacon.id }, A)).s === 400);
const bacon = await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Bacon extra', preco: 3, ingredient_id: insumos.Bacon.id, quantidade_insumo: 30, codigo: 'adc-bacon' }, A);
const BACON = bacon.j.opcoes.find((o) => o.nome === 'Bacon extra');
check('cria "Bacon extra" (R$ 3, baixa 30 g de bacon, código ADC-BACON)', bacon.s === 201 && BACON && Number(BACON.quantidade_insumo) === 30 && BACON.codigo === 'ADC-BACON', bacon);
const ched = await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Cheddar', preco: 2 }, A);
const CHED = ched.j.opcoes.find((o) => o.nome === 'Cheddar');
check('cria "Cheddar" (R$ 2, sem baixa)', ched.s === 201 && !!CHED);
check('código de complemento repetido -> 409', (await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Outro', codigo: 'ADC-BACON' }, A)).s === 409);
const gBeb = await api('POST', '/complement-groups', { nome: 'Bebida do combo', minimo: 1, maximo: 1 }, A);
const beb = await api('POST', `/complement-groups/${gBeb.j.id}/options`, { nome: 'Refri lata', preco: 0, product_id: REFRI.id, quantidade_produto: 1, codigo: 'CMB-REFRI' }, A);
const BEB = beb.j.opcoes[0];
check('cria grupo obrigatório "Bebida do combo" com o refri (baixa o produto)', gBeb.s === 201 && beb.s === 201 && BEB.product_id === REFRI.id, beb);
check('liga "Adicionais" ao X-Burguer', (await api('PUT', `/products/${XB.id}/complement-groups`, { grupos: [gAd.j.id] }, A)).s === 200);

console.log('\n# 2. Combo');
const catLanche = XB.categoria_id;
const bar = () => '789' + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 10));
const combo = await api('POST', '/products', { nome: 'Combo X-Burguer', categoria_id: catLanche, barcode: bar(), unidade: 'UN', preco_custo: 0.01, preco_venda: 30, combo: [{ product_id: XB.id, quantidade: 1 }], grupos: [gBeb.j.id] }, A);
check('cria o combo (X-Burguer + bebida obrigatória)', combo.s === 201, combo);
const det = (await api('GET', `/products/${combo.j.id}`, null, A)).j;
check('detalhe: é combo, componentes, grupo da bebida e custo = soma dos componentes', det.e_combo && det.combo.length === 1 && det.grupos[0].id === gBeb.j.id && Math.abs(Number(det.preco_custo) - Number(XB.preco_custo)) < 0.01, det);
check('combo dentro de combo -> 400', (await api('PUT', `/products/${XB.id}/combo`, { itens: [{ product_id: combo.j.id, quantidade: 1 }] }, A)).s === 400);
check('combo contendo ele mesmo -> 400', (await api('PUT', `/products/${combo.j.id}/combo`, { itens: [{ product_id: combo.j.id, quantidade: 1 }] }, A)).s === 400);
check('produto com estoque não vira combo -> 400', (await api('PUT', `/products/${REFRI.id}/combo`, { itens: [{ product_id: XB.id, quantidade: 1 }] }, A)).s === 400);
check('entrada de estoque no combo -> 400 (não tem estoque próprio)', (await api('POST', '/stock-movements', { product_id: combo.j.id, tipo: 'entrada', quantidade: 1, location_destino_id: L.Lanchonete, motivo: 'x' }, A)).s === 400);
const busca = (await api('GET', `/products/search?ids=${XB.id},${combo.j.id}&terminal_id=${PDVL}`, null, A)).j;
const bXB = busca.find((p) => p.id === XB.id);
const bCombo = busca.find((p) => p.id === combo.j.id);
check('busca do PDV: X-Burguer traz os adicionais; combo marcado e com disponibilidade', bXB.grupos.length === 1 && bXB.grupos[0].opcoes.length === 2 && bCombo.e_combo && Number(bCombo.saldo) > 0, { bXB, bCombo });

console.log('\n# 3. Venda com adicionais');
const bacon0 = await saldoIns('Bacon');
const v1 = await venda([{ product_id: XB.id, quantidade: 1, complementos: [{ id: BACON.id, quantidade: 2 }, { id: CHED.id }], observacao: 'bem passado' }]);
check('X-Burguer + 2 bacon + cheddar = 18 + 6 + 2 = 26', v1.s === 201 && v1.j.total === 26, v1);
check('baixa o bacon da ficha (30 g) + 2 adicionais (60 g)', bacon0 - (await saldoIns('Bacon')) === 90, { antes: bacon0, depois: await saldoIns('Bacon') });
const dv1 = (await api('GET', `/sales/${v1.j.id}`, null, A)).j;
check('item da venda guarda os complementos e a observação', dv1.itens[0].complementos.length === 2 && dv1.itens[0].observacao === 'bem passado', dv1.itens[0]);
check('custo do item inclui o bacon extra', Number(dv1.itens[0].custo_unitario) > Number(XB.preco_custo), dv1.itens[0]);
check('mais adicionais que o máximo (4 em 3) -> 400', (await venda([{ product_id: XB.id, quantidade: 1, complementos: [{ id: BACON.id, quantidade: 4 }] }])).s === 400);
check('complemento que não é do produto -> 400', (await venda([{ product_id: XB.id, quantidade: 1, complementos: [{ id: BEB.id }] }])).s === 400);
check('preço do complemento vem do cadastro (o PDV não manda preço)', (await venda([{ product_id: REFRI.id, quantidade: 1 }])).j.total === 6);

console.log('\n# 4. Combo na venda');
check('combo sem escolher a bebida obrigatória -> 400', (await venda([{ product_id: combo.j.id, quantidade: 1 }])).s === 400);
const refri0 = await saldoProd(REFRI.id);
const pao0 = await saldoIns('Pao');
const v2 = await venda([{ product_id: combo.j.id, quantidade: 1, complementos: [{ id: BEB.id }] }]);
check('combo com bebida: R$ 30', v2.s === 201 && v2.j.total === 30, v2);
check('combo baixa os insumos do X-Burguer e o refri (estoque)', pao0 - (await saldoIns('Pao')) === 1 && refri0 - (await saldoProd(REFRI.id)) === 1, { pao: [pao0, await saldoIns('Pao')], refri: [refri0, await saldoProd(REFRI.id)] });

console.log('\n# 5. Falta de insumo e estorno no cancelamento');
const baconAgora = await saldoIns('Bacon');
const muito = Math.ceil(baconAgora / 30) + 1;
const falta = await venda([{ product_id: XB.id, quantidade: 1, complementos: [{ id: BACON.id, quantidade: 3 }] }, { product_id: XB.id, quantidade: muito }]);
check('sem bacon suficiente (lanches + adicionais) -> 400 citando o Bacon', falta.s === 400 && /Bacon/.test(falta.j.erro), falta);
const antesCanc = await saldoIns('Bacon');
const canc = await api('POST', `/sales/${v1.j.id}/cancel`, { motivo: 'teste de estorno' }, A);
check('cancelar a venda devolve o bacon da ficha e dos adicionais (90 g)', canc.s === 200 && (await saldoIns('Bacon')) - antesCanc === 90, { antes: antesCanc, depois: await saldoIns('Bacon') });
const antesC2 = await saldoProd(REFRI.id);
await api('POST', `/sales/${v2.j.id}/cancel`, { motivo: 'teste de estorno do combo' }, A);
check('cancelar o combo devolve o refri ao estoque', (await saldoProd(REFRI.id)) - antesC2 === 1);

console.log('\n# 6. Pedido: reserva e finalização');
await api('PATCH', `/locations/${L.Lanchonete}`, { usa_pedidos: true }, A);
const disp0 = Number((await api('GET', `/products/search?ids=${REFRI.id}&terminal_id=${PDVL}`, null, A)).j[0].saldo);
check('pedido sem a bebida obrigatória -> 400', (await api('POST', '/orders', { location_id: L.Lanchonete, itens: [{ product_id: combo.j.id, quantidade: 1 }] }, A)).s === 400);
const ped = await api('POST', '/orders', { location_id: L.Lanchonete, itens: [{ product_id: combo.j.id, quantidade: 2, complementos: [{ id: BEB.id }] }, { product_id: XB.id, quantidade: 1, complementos: [{ id: CHED.id }] }] }, A);
check('pedido com combo (x2) + X-Burguer com cheddar: total 2x30 + 20 = 80', ped.s === 201 && Number(ped.j.total) === 80, ped);
const disp1 = Number((await api('GET', `/products/search?ids=${REFRI.id}&terminal_id=${PDVL}`, null, A)).j[0].saldo);
check('o pedido reserva as 2 bebidas do combo (disponível do refri cai 2)', disp0 - disp1 === 2, { disp0, disp1 });
check('itens do pedido mostram os complementos', ped.j.itens.some((i) => i.complementos.some((c) => c.nome === 'Refri lata')));
for (const para of ['em_preparo', 'pronto']) await api('POST', `/orders/${ped.j.id}/status`, { para }, A);
const fin = await api('POST', `/orders/${ped.j.id}/status`, { para: 'finalizado', forma_pagamento: 'pix' }, A);
const vped = fin.s === 200 ? (await api('GET', `/sales/${fin.j.sale_id}`, null, A)).j : null;
check('finalizar vira venda de 80 com os complementos', !!vped && Number(vped.total) === 80 && vped.itens.some((i) => i.complementos.length > 0), fin.s === 200 ? vped : fin);
const disp2 = Number((await api('GET', `/products/search?ids=${REFRI.id}&terminal_id=${PDVL}`, null, A)).j[0].saldo);
check('depois de finalizar, a reserva vira baixa (disponível igual)', disp2 === disp1, { disp1, disp2 });

console.log('\n# 7. Excluir x desativar; sem o módulo Lanchonete');
check('excluir complemento já vendido -> 409', (await api('DELETE', `/complements/${BACON.id}`, null, A)).s === 409);
check('desativar complemento', (await api('PATCH', `/complements/${CHED.id}`, { ativo: false }, A)).s === 200);
check('vender com complemento desativado -> 400', (await venda([{ product_id: XB.id, quantidade: 1, complementos: [{ id: CHED.id }] }])).s === 400);
const novo = await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Ovo', preco: 2 }, A);
const OVO = novo.j.opcoes.find((o) => o.nome === 'Ovo');
check('excluir complemento nunca usado -> 204', (await api('DELETE', `/complements/${OVO.id}`, null, A)).s === 204);
const SENHA = crypto.randomBytes(9).toString('base64url');
spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: 'e2e.combos.master@girostock.local', MASTER_PASSWORD: SENHA, MASTER_NOME: 'E2E Combos Master' } });
const MAS = await tokenDoMasterComDoisFatores(B, 'e2e.combos.master@girostock.local', SENHA);
const emp = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
await api('PATCH', `/master/empresas/${emp}`, { recursos: { lanchonete: false } }, MAS);
const semMod = await venda([{ product_id: combo.j.id, quantidade: 1, complementos: [{ id: BEB.id }] }]);
check('sem o módulo Lanchonete: combo com lanche -> 403', semMod.s === 403, semMod);
const semMod2 = await venda([{ product_id: REFRI.id, quantidade: 1 }]);
check('sem o módulo Lanchonete: refri segue vendendo', semMod2.s === 201, semMod2);
check('sem o módulo Lanchonete: complemento com insumo não pode ser cadastrado -> 403', (await api('POST', `/complement-groups/${gAd.j.id}/options`, { nome: 'Mais bacon', ingredient_id: insumos.Bacon.id, quantidade_insumo: 10 }, A)).s === 403);
await api('PATCH', `/master/empresas/${emp}`, { recursos: { lanchonete: null } }, MAS);

await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
