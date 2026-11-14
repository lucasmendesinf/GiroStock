// e2e: combo com codigo de barras automatico, custos por produto e preco sugerido (margem configuravel por empresa).
//   node scripts/e2e-combo-codigo-preco.mjs   (API em http://localhost:3000; banco com migrations e seed)
// Cria uma empresa nova pelo Master (isolada) e usa apenas dados dela.
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { novoCodigoInterno, eanValido, digitoEan13 } = require('../src/services/codigoBarras.js');
const preco = await import('../../frontend/src/utils/precoCombo.js');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.combocod.master@girostock.local';
const SENHA_M = rnd();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 500)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E Combo Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.combocod.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E Combo ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Loja', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
async function usuario(emp, nome, perfil, locationId) {
  const email = `e2e.combocod.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, location_id: locationId }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j.token, status: r.s };
}

console.log('\n# Preparo');
const E = await novaEmpresa('a');
const F = await novaEmpresa('b'); // outra empresa: o codigo e unico POR empresa
const L1 = (await db.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
await api('POST', '/categories', { nome: 'Combos' }, E.token);
const cat = (await api('GET', '/categories', null, E.token)).j[0].id;
const GER = await usuario(E, 'Ger', 'Gerente', L1);
const CAIXA = await usuario(E, 'Caixa', 'Caixa/Operador', L1);
check('usuarios de teste (gerente sem EditarProdutos, caixa sem Configuracoes)', GER.status === 201 && CAIXA.status === 201 && GER.token && CAIXA.token, [GER.status, CAIXA.status]);
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
async function produto(nome, custo, venda, extra = {}) {
  const r = await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: custo, preco_venda: venda, ...extra }, E.token);
  return { id: r.j.id, barcode: r.j.barcode, r };
}
const A = await produto('Hamburguer E2E', 11.4, 29.9);
const Bp = await produto('Batata E2E', 9.8, 32);
const C = await produto('Refri E2E', 3.1, 7);
check('3 produtos de teste criados', !!(A.id && Bp.id && C.id), [A.r, Bp.r, C.r]);
const comboItens = [{ product_id: A.id, quantidade: 2 }, { product_id: Bp.id, quantidade: 1 }, { product_id: C.id, quantidade: 2 }];
const corpoCombo = (extra = {}) => ({ nome: 'Combo E2E ' + crypto.randomBytes(3).toString('hex'), categoria_id: cat, unidade: 'UN', preco_custo: 38.8, preco_venda: 55.9, combo: comboItens, ...extra });

// ---------------------------------------------------------------------------------------------------
console.log('\n# 1. Gerador de codigo de barras interno');
const codigos = Array.from({ length: 1000 }, () => novoCodigoInterno());
check('1.000 codigos: 13 digitos, prefixo 2', codigos.every((c) => /^2[0-9]{12}$/.test(c)));
check('1.000 codigos: digito verificador EAN-13 valido (pesos 1 e 3)', codigos.every((c) => eanValido(c) && digitoEan13(c.slice(0, 12)) === Number(c[12])));
check('1.000 codigos sem repeticao', new Set(codigos).size === 1000);
check('o verificador confere com um EAN real conhecido (789100010010 -> 3) e rejeita erro', eanValido('7891000100103') && !eanValido('7891000100104'));
const colide = (await db.query(`SELECT 1 FROM products WHERE barcode = ANY($1::text[]) UNION ALL SELECT 1 FROM produto_faixas WHERE ean_pack = ANY($1::text[]) LIMIT 1`, [codigos])).rows.length;
check('nenhum dos 1.000 coincide com barcode de produto nem ean_pack existentes', colide === 0);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 2. GET /products/codigo-barras-livre');
const s1 = await api('GET', '/products/codigo-barras-livre', null, E.token);
check('devolve um codigo EAN-13 interno valido', s1.s === 200 && eanValido(s1.j.codigo) && s1.j.codigo[0] === '2', s1);
check('exige a area Estoque (caixa -> 403; sem token -> 401)', (await api('GET', '/products/codigo-barras-livre', null, CAIXA.token)).s === 403 && (await api('GET', '/products/codigo-barras-livre', null)).s === 401);
// ocupa um codigo (produto) e um codigo de pack e confere que o servidor nao os sugere nem os aceita
const OCUP = (await produto('Ocupa Codigo', 2, 5, { barcode: s1.j.codigo }));
check('ocupar o codigo sugerido com um produto funciona', OCUP.r.s === 201, OCUP.r);
const livres = []; for (let i = 0; i < 40; i++) livres.push((await api('GET', '/products/codigo-barras-livre', null, E.token)).j.codigo);
check('depois de ocupado, o servidor nao o sugere de novo (40 chamadas)', !livres.includes(s1.j.codigo) && livres.every(eanValido));
const eanPack = '2' + String(Date.now()).slice(-9) + '01';
await db.query(`INSERT INTO produto_faixas (tenant_id, product_id, rotulo, quantidade_minima, preco_unitario, modo_cadastro, valor_cadastro, automatica, ean_pack) VALUES ($1, $2, 'Pack E2E', 6, 5, 'unitario', 5, false, $3)`, [E.id, A.id, eanPack]);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 3. Criar combo');
const c1 = await api('POST', '/products', corpoCombo(), E.token);
check('combo SEM codigo -> 201 e o servidor gera EAN-13 interno valido', c1.s === 201 && eanValido(c1.j.barcode) && c1.j.barcode[0] === '2' && c1.j.codigo_barras_automatico === true, c1);
check('o codigo gerado ficou gravado em products.barcode', (await db.query('SELECT barcode FROM products WHERE id = $1', [c1.j.id])).rows[0].barcode === c1.j.barcode);
const [c2, c3, c4, c5] = await Promise.all([1, 2, 3, 4].map(() => api('POST', '/products', corpoCombo(), E.token)));
const gerados = [c2, c3, c4, c5].map((r) => r.j.barcode);
check('4 combos criados AO MESMO TEMPO: todos 201 e codigos diferentes', [c2, c3, c4, c5].every((r) => r.s === 201) && new Set([...gerados, c1.j.barcode]).size === 5, [c2.s, c3.s, c4.s, c5.s, gerados]);
const digitado = '2' + String(Date.now()).slice(-9) + '02';
const cd = await api('POST', '/products', corpoCombo({ barcode: digitado }), E.token);
check('combo COM codigo digitado -> aceita e grava o digitado', cd.s === 201 && cd.j.barcode === digitado && cd.j.codigo_barras_automatico === false, cd);
check('codigo digitado ja usado por PRODUTO -> 409', (await api('POST', '/products', corpoCombo({ barcode: A.barcode }), E.token)).s === 409);
check('codigo digitado ja usado por PACK -> 409', (await api('POST', '/products', corpoCombo({ barcode: eanPack }), E.token)).s === 409);
check('codigo digitado invalido (curto) -> 400', (await api('POST', '/products', corpoCombo({ barcode: '123' }), E.token)).s === 400);
const outra = await api('POST', '/products', { ...corpoCombo({ barcode: digitado }), categoria_id: (await api('POST', '/categories', { nome: 'Cat B' }, F.token)).j.id, combo: [] , preco_custo: 1, preco_venda: 2 }, F.token);
check('o codigo e unico POR empresa: outra empresa pode usar o mesmo numero (produto comum)', outra.s === 201, outra);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 4. Produto comum nunca recebe codigo automatico');
const pc = { nome: 'Comum sem codigo', categoria_id: cat, unidade: 'UN', preco_custo: 1, preco_venda: 2 };
check('produto comum sem codigo -> 400', (await api('POST', '/products', pc, E.token)).s === 400);
check('produto comum com codigo vazio -> 400', (await api('POST', '/products', { ...pc, barcode: '' }, E.token)).s === 400);
check('lanche (ficha tecnica) sem codigo tambem -> 400 (so combo e automatico)', (await api('POST', '/products', { ...pc, ficha_tecnica: [{ ingredient_id: crypto.randomUUID(), quantidade_por_unidade: 1 }] }, E.token)).s === 400);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 5. Editar combo');
const antes = c1.j.barcode;
const e1 = await api('PUT', `/products/${c1.j.id}`, { nome: 'Combo renomeado', preco_venda: 59.9 }, E.token);
check('editar (sem mandar o codigo) NAO muda o codigo', e1.s === 200 && (await db.query('SELECT barcode FROM products WHERE id = $1', [c1.j.id])).rows[0].barcode === antes, e1);
const novoManual = '2' + String(Date.now()).slice(-9) + '03';
check('trocar o codigo manualmente funciona (com permissao)', (await api('PUT', `/products/${c1.j.id}`, { barcode: novoManual }, E.token)).s === 200 && (await db.query('SELECT barcode FROM products WHERE id = $1', [c1.j.id])).rows[0].barcode === novoManual);
check('trocar para codigo de outro PRODUTO -> 409', (await api('PUT', `/products/${c1.j.id}`, { barcode: A.barcode }, E.token)).s === 409);
check('trocar para codigo de PACK -> 409', (await api('PUT', `/products/${c1.j.id}`, { barcode: eanPack }, E.token)).s === 409);
check('sem permissao de editar produtos (gerente) -> 403', (await api('PUT', `/products/${c1.j.id}`, { barcode: '2' + String(Date.now()).slice(-9) + '04' }, GER.token)).s === 403);
const ficha = await api('GET', `/products/${c1.j.id}`, null, E.token);
check('o combo editado continua com seus 3 produtos', ficha.j.e_combo === true && ficha.j.combo.length === 3, ficha.j.combo);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 6. Preco sugerido (funcao pura, em centavos)');
const p = preco.precoSugeridoCent;
check('custo 46,30 @30% com ,90 -> 66,90 (bruto 66,14)', p(4630, 30, true) === 6690);
check('custo 46,87 @30% com ,90 -> 67,90 (bruto 66,96)', p(4687, 30, true) === 6790);
check('bruto 66,95 (custo 66,95 @0%) -> 67,90', p(6695, 0, true) === 6790);
check('bruto exatamente 66,90 (custo 66,90 @0%) fica em 66,90', p(6690, 0, true) === 6690);
check('custo 10,00 @0% com ,90 -> 10,90', p(1000, 0, true) === 1090);
check('desligado: arredonda em centavos (46,30 @30% -> 66,14)', p(4630, 30, false) === 6614);
check('desligado: custo 10,00 @0% -> 10,00', p(1000, 0, false) === 1000);
check('margem 94,99% sem ,90: 10,00 / 0,0501 = 199,60', p(1000, 94.99, false) === 19960);
check('margem 95 ou mais -> sem sugestao; custo 0 -> sem sugestao; margem negativa -> sem sugestao', p(1000, 95, true) === null && p(0, 30, true) === null && p(1000, -1, true) === null && p(1000, 99, false) === null);
check('margem decimal 32,5% (custo 10,00 -> 14,81 sem ,90; 14,90 com)', p(1000, 32.5, false) === 1481 && p(1000, 32.5, true) === 1490);
const linhas = preco.linhasDoCombo([{ product_id: 'x', quantidade: 0.5 }, { product_id: 'y', quantidade: 3 }], [{ id: 'x', preco_custo: '3.33', preco_venda: '7.01' }, { id: 'y', preco_custo: 0.1, preco_venda: 0.2 }]);
check('linhas: quantidade fracionada arredonda por linha em centavos (3,33 x 0,5 = 1,67; 0,1 x 3 = 0,30 sem erro de float)', linhas[0].custoCent === 167 && linhas[1].custoCent === 30 && linhas[1].avulsoCent === 60, linhas);
const ind = preco.indicadoresCombo({ custoCent: 4630, precoCent: 6690, avulsoCent: 9000 });
check('indicadores: lucro 20,60, margem 30,8%, markup 44,5%, desconto 25,7%', ind.lucroCent === 2060 && Math.abs(ind.margemPct - 30.79) < 0.01 && Math.abs(ind.markupPct - 44.49) < 0.01 && Math.abs(ind.descontoPct - 25.67) < 0.01, ind);
check('nivel da margem: ok >= desejada (tolerancia 0,05), atencao abaixo, ruim < 15% ou preco <= custo', preco.nivelDaMargem(29.96, 30, 6690, 4630) === 'ok' && preco.nivelDaMargem(25, 30, 6690, 4630) === 'atencao' && preco.nivelDaMargem(10, 30, 6690, 4630) === 'ruim' && preco.nivelDaMargem(0, 30, 4630, 4630) === 'ruim');

// ---------------------------------------------------------------------------------------------------
console.log('\n# 7. Configuracao da empresa (margem padrao e ,90)');
const g0 = await api('GET', '/empresa', null, E.token);
check('padrao: 30% e ,90 ligado', g0.s === 200 && g0.j.combo_margem_pct === 30 && g0.j.combo_preco_final_90 === true, g0.j);
const pu = await api('PUT', '/empresa', { combo_margem_pct: 40, combo_preco_final_90: false }, E.token);
check('PUT /empresa altera margem (40) e ,90 (desligado)', pu.s === 200 && pu.j.combo_margem_pct === 40 && pu.j.combo_preco_final_90 === false, pu);
const g1 = await api('GET', '/empresa', null, E.token);
check('GET /empresa devolve os novos valores', g1.j.combo_margem_pct === 40 && g1.j.combo_preco_final_90 === false, g1.j);
check('margem 95 -> 400; negativa -> 400; texto -> 400; ,90 nao booleano -> 400', (await api('PUT', '/empresa', { combo_margem_pct: 95 }, E.token)).s === 400 && (await api('PUT', '/empresa', { combo_margem_pct: -1 }, E.token)).s === 400 && (await api('PUT', '/empresa', { combo_margem_pct: 'abc' }, E.token)).s === 400 && (await api('PUT', '/empresa', { combo_preco_final_90: 'sim' }, E.token)).s === 400);
check('margem com 2 casas (32,5) e virgula decimal (\'27,25\')', (await api('PUT', '/empresa', { combo_margem_pct: 32.5 }, E.token)).j.combo_margem_pct === 32.5 && (await api('PUT', '/empresa', { combo_margem_pct: '27,25' }, E.token)).j.combo_margem_pct === 27.25);
check('94,99 aceito (limite)', (await api('PUT', '/empresa', { combo_margem_pct: 94.99 }, E.token)).s === 200);
check('sem a area Configuracoes (caixa) NAO edita -> 403, mas LE os valores (200)', (await api('PUT', '/empresa', { combo_margem_pct: 10 }, CAIXA.token)).s === 403 && (await api('GET', '/empresa', null, CAIXA.token)).j.combo_margem_pct === 94.99);
check('combos existentes nao mudam ao mudar a configuracao', (await db.query('SELECT barcode, preco_venda FROM products WHERE id = $1', [c2.j.id])).rows[0].barcode === c2.j.barcode);
const aud = (await db.query(`SELECT detalhes FROM audit_logs WHERE tenant_id = $1 AND acao = 'editar_dados_empresa' AND detalhes ? 'combos' ORDER BY criado_em DESC LIMIT 1`, [E.id])).rows[0];
check('auditoria registra antes e depois da configuracao de combos', !!aud && aud.detalhes.combos.antes && aud.detalhes.combos.depois && aud.detalhes.combos.depois.margem_pct === 94.99, aud);
check('outra empresa nao e afetada (continua 30%)', (await api('GET', '/empresa', null, F.token)).j.combo_margem_pct === 30);

// ---------------------------------------------------------------------------------------------------
console.log('\n# 8. Combo ja existente segue funcionando (venda e baixa de estoque)');
await api('PATCH', `/locations/${L1}`, { usa_pedidos: false }, E.token);
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, E.token)).j.id;
await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 50 }, E.token);
for (const pid of [A.id, Bp.id, C.id]) await api('POST', '/stock-movements', { product_id: pid, tipo: 'entrada', quantidade: 50, location_destino_id: L1, motivo: 'e2e' }, E.token);
const v = await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: c2.j.id, quantidade: 1 }], forma_pagamento: 'pix' }, E.token);
check('vender um combo criado com codigo automatico', v.s === 201 && Number(v.j.total) === 55.9, v);
const sA = Number((await db.query('SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2', [A.id, L1])).rows[0].saldo);
check('a venda baixou os produtos do combo (hamburguer 50 - 2 = 48)', sA === 48, sA);
const b = await api('GET', `/products/search?terminal_id=${T1}&barcode=${c2.j.barcode}`, null, E.token);
check('o leitor encontra o combo pelo codigo automatico', b.s === 200 && b.j.length === 1 && b.j[0].id === c2.j.id, b.j);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await db.end();
process.exit(fail ? 1 : 0);
