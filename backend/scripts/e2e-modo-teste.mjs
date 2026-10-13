// Teste ponta a ponta do perfil Master + Modo teste (banco de teste separado).
//
// Uso (API rodando em http://localhost:3000, com DATABASE_URL e DATABASE_URL_TESTE de bancos diferentes, ja migrados):
//   npm run test:e2e:modo-teste        # API_URL padrao: http://localhost:3000
//
// O script cria uma empresa "E2E Modo Teste" e usuarios e2e.* (senhas aleatorias, so em memoria, nunca impressas) direto
// na producao do ambiente de DESENVOLVIMENTO. Use somente em banco de desenvolvimento. No fim, os usuarios e2e.* ficam inativos.
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const senha = () => crypto.randomBytes(9).toString('base64url');
const SENHAS = { admin: senha(), gerente: senha(), caixa: senha(), master: senha() };
const EMAIL = { admin: 'e2e.admin@girostock.local', gerente: 'e2e.gerente@girostock.local', caixa: 'e2e.caixa@girostock.local', master: 'e2e.master@girostock.local' };

if (!process.env.DATABASE_URL_TESTE || process.env.DATABASE_URL_TESTE === process.env.DATABASE_URL) {
  console.error('configure DATABASE_URL_TESTE (outro banco) antes de rodar este teste');
  process.exit(1);
}
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
const teste = new pg.Client({ connectionString: process.env.DATABASE_URL_TESTE });
await prod.connect();
await teste.connect();

let pass = 0;
let fail = 0;
function check(nome, cond, info) {
  if (cond) { pass++; console.log(`  ok   ${nome}`); }
  else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
}
async function api(method, rota, body, tok, base = B) {
  try {
    const res = await fetch(base + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const login = async (quem) => (await api('POST', '/auth/login', { email: EMAIL[quem], senha: SENHAS[quem] })).j.token;
const TABELAS = ['sales', 'products', 'customers', 'suppliers', 'orders', 'users'];
async function contar(db) {
  const r = {};
  for (const t of TABELAS) r[t] = Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return r;
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- preparo ----------
let tenant = (await prod.query(`SELECT id FROM tenants WHERE nome = 'E2E Modo Teste'`)).rows[0];
if (!tenant) tenant = (await prod.query(`INSERT INTO tenants (nome) VALUES ('E2E Modo Teste') RETURNING id`)).rows[0];
const perfis = { admin: 'Administrador', gerente: 'Gerente', caixa: 'Caixa/Operador' };
for (const [quem, perfil] of Object.entries(perfis)) {
  const hash = bcrypt.hashSync(SENHAS[quem], 10);
  const ex = await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [EMAIL[quem]]);
  if (ex.rows.length) await prod.query(`UPDATE users SET senha_hash = $1, ativo = true, perfil = $2, permissoes = NULL, tenant_id = $3 WHERE id = $4`, [hash, perfil, tenant.id, ex.rows[0].id]);
  else await prod.query(`INSERT INTO users (tenant_id, nome, email, senha_hash, perfil) VALUES ($1, $2, $3, $4, $5)`, [tenant.id, `E2E ${perfil}`, EMAIL[quem], hash, perfil]);
}
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL.master, MASTER_PASSWORD: SENHAS.master, MASTER_NOME: 'E2E Master' }, encoding: 'utf8' });
console.log('# preparo:', mk.status === 0 ? mk.stdout.trim().replace(EMAIL.master, '<email e2e>') : 'FALHOU ' + mk.stderr);
check('npm run master cria o Master', mk.status === 0 && /master (criado|atualizado)/.test(mk.stdout), mk.stderr);
const mk2 = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL.master, MASTER_PASSWORD: SENHAS.master }, encoding: 'utf8' });
check('master e idempotente (segunda execucao atualiza)', mk2.status === 0 && /atualizado/.test(mk2.stdout), mk2.stderr);
const mk3 = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL.master, MASTER_PASSWORD: '123' }, encoding: 'utf8' });
check('master recusa senha curta (<8)', mk3.status !== 0, mk3.stdout);

const ADM = await login('admin');
const GER0 = await login('gerente');
const CAI = await login('caixa');
const MAS = await login('master');
check('logins de admin, gerente, caixa e master', [ADM, GER0, CAI, MAS].every(Boolean), { ADM: !!ADM, GER0: !!GER0, CAI: !!CAI, MAS: !!MAS });

// ---------- 1. Master na API de usuarios ----------
console.log('\n# 1. Master fora da tela/API de usuarios');
const lista = await api('GET', '/users', null, ADM);
check('GET /users nao lista Master', lista.s === 200 && !lista.j.some((u) => u.perfil === 'Master'), lista.j);
const masterId = (await prod.query(`SELECT id FROM users WHERE perfil = 'Master' AND lower(email::text) = $1`, [EMAIL.master])).rows[0].id;
check('POST /users com perfil Master -> 403', (await api('POST', '/users', { nome: 'X', email: 'x.master@girostock.local', senha: 'abcdef1', perfil: 'Master' }, ADM)).s === 403);
const gerId = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [EMAIL.gerente])).rows[0].id;
check('PATCH /users promovendo a Master -> 403', (await api('PATCH', `/users/${gerId}`, { perfil: 'Master' }, ADM)).s === 403);
const permAj = await api('PATCH', `/users/${gerId}`, { permissoes: { Master: true } }, ADM);
const gAreas = (await api('GET', '/auth/me', null, GER0)).j.areas;
check('ajuste individual nao concede Master', gAreas.Master === false, { s: permAj.s, areas: gAreas });
const meM = await api('GET', '/auth/me', null, MAS);
check('/auth/me do Master: master=true, modoTeste=false, so area Master/ModoTeste', meM.j.master === true && meM.j.modoTeste === false && meM.j.areas.Master && meM.j.areas.ModoTeste && !meM.j.areas.Vendas && !meM.j.areas.Estoque, meM.j);
check('Master em producao nao opera dados de empresas (GET /categories -> 403)', (await api('GET', '/categories', null, MAS)).s === 403);
check('Master nao troca para outra empresa via /users (403)', (await api('GET', '/users', null, MAS)).s === 403);

// ---------- 2. Permissao ModoTeste ----------
console.log('\n# 2. Permissao ModoTeste');
check('sem a permissao: POST /auth/modo-teste -> 403', (await api('POST', '/auth/modo-teste', { ativo: true }, GER0)).s === 403);
const conc = await api('PATCH', `/users/${gerId}`, { permissoes: { ModoTeste: true } }, ADM);
check('admin concede ModoTeste ao usuario', conc.s === 200 && conc.j.permissoes && conc.j.permissoes.ModoTeste === true, conc);

// ---------- 8a. regressao em producao (antes) ----------
console.log('\n# 8a. Producao funciona (login, PDV, venda direta)');
// Reaproveita loja, PDV e categoria das execucoes anteriores (os limites do plano impedem criar sempre novos).
const locsAdm = (await api('GET', '/locations', null, ADM)).j;
const loja = locsAdm.find((l) => l.nome.startsWith('Loja E2E')) || (await api('POST', '/locations', { nome: 'Loja E2E' }, ADM)).j;
const termsAdm = (await api('GET', '/terminals', null, ADM)).j;
const term = termsAdm.find((t) => t.location_id === loja.id && t.ativo) || (await api('POST', '/terminals', { nome: 'PDV E2E', location_id: loja.id }, ADM)).j;
const catsAdm = (await api('GET', '/categories', null, ADM)).j;
const cat = catsAdm.find((x) => x.nome === 'E2E MT') || (await api('POST', '/categories', { nome: 'E2E MT' }, ADM)).j;
const prodA = await api('POST', '/products', { nome: 'Produto E2E', categoria_id: cat.id, barcode: String(7890000000000 + (Date.now() % 100000000)), unidade: 'UN', preco_custo: 2, preco_venda: 5, location_id: loja.id, estoque_inicial: 50 }, ADM);
check('cria produto em producao', prodA.s === 201, prodA);
const aberto = (await api('GET', `/cash-sessions/current?terminal_id=${term.id}`, null, ADM)).j;
const caixa = aberto ? { s: 201 } : await api('POST', '/cash-sessions', { terminal_id: term.id, valor_inicial: 10 }, ADM);
check('caixa aberto', caixa.s === 201, caixa);
const venda = await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.j.id, quantidade: 2 }], forma_pagamento: 'pix' }, ADM);
check('venda direta em producao', venda.s === 201, venda);
const me1 = await api('GET', '/auth/me', null, ADM);
check('/auth/me do admin: master=false, modoTeste=false', me1.s === 200 && me1.j.master === false && me1.j.modoTeste === false, me1.j);

// ---------- 5. Trava de seguranca ----------
console.log('\n# 5. Trava: DATABASE_URL_TESTE ausente/igual -> modo teste indisponivel');
async function subirServidor(porta, extra) {
  const p = spawn('node', ['src/server.js'], { cwd: raiz, env: { ...process.env, PORT: String(porta), ...extra }, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`http://localhost:${porta}/health`)).ok) return p; } catch { /* aguarda */ }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  p.kill();
  throw new Error('servidor auxiliar nao subiu');
}
for (const [rotulo, extra] of [['ausente', { DATABASE_URL_TESTE: '' }], ['igual a producao', { DATABASE_URL_TESTE: process.env.DATABASE_URL }]]) {
  const porta = 3100 + Math.floor(Math.random() * 400);
  const srv = await subirServidor(porta, extra);
  const G = await api('POST', '/auth/login', { email: EMAIL.gerente, senha: SENHAS.gerente }, null, `http://localhost:${porta}`);
  const r = await api('POST', '/auth/modo-teste', { ativo: true }, G.j.token, `http://localhost:${porta}`);
  check(`DATABASE_URL_TESTE ${rotulo}: ativar -> 409 "modo teste nao configurado"`, r.s === 409 && /não configurado/.test(r.j.erro || ''), r);
  const st = await api('GET', '/master/modo-teste/status', null, (await api('POST', '/auth/login', { email: EMAIL.master, senha: SENHAS.master }, null, `http://localhost:${porta}`)).j.token, `http://localhost:${porta}`);
  check(`DATABASE_URL_TESTE ${rotulo}: status informa configurado=false`, st.s === 200 && st.j.configurado === false, st);
  srv.kill();
}
check('producao intacta apos tentativas sem configuracao', (await api('GET', '/auth/me', null, ADM)).s === 200);

// ---------- 3. Primeira ativacao + isolamento ----------
console.log('\n# 3. Primeira ativacao (copia) e isolamento');
const semCopia = await api('POST', '/auth/modo-teste', { ativo: true }, GER0);
const jaCopiado = semCopia.s === 200;
if (!jaCopiado) check('primeira ativacao pede confirmacao da copia (409 precisa_copia)', semCopia.s === 409 && semCopia.j.precisa_copia === true, semCopia);
const ativ = jaCopiado ? semCopia : await api('POST', '/auth/modo-teste', { ativo: true, confirmar_copia: true, anonimizar: true }, GER0);
check('usuario com permissao liga o modo teste (200 + token)', ativ.s === 200 && ativ.j.token, ativ);
const GT = ativ.j.token;
// Se o teste ja tinha uma copia antiga (execucoes anteriores), sincroniza antes de comparar as contagens.
if (jaCopiado) await api('POST', '/master/modo-teste/copiar-producao', { confirmacao: 'COPIAR', anonimizar: true }, MAS);
const meT = await api('GET', '/auth/me', null, GT);
check('/auth/me em modo teste: modoTeste=true', meT.s === 200 && meT.j.modoTeste === true && meT.j.master === false, meT.j);
const antesProd = await contar(prod);
const antesTeste = await contar(teste);
check('copia inicial: contagens de produtos/clientes/vendas iguais (teste = producao)', igual(
  { sales: antesProd.sales, products: antesProd.products, customers: antesProd.customers, suppliers: antesProd.suppliers, orders: antesProd.orders },
  { sales: antesTeste.sales, products: antesTeste.products, customers: antesTeste.customers, suppliers: antesTeste.suppliers, orders: antesTeste.orders }), { antesProd, antesTeste });
const lojasT = await api('GET', '/locations', null, GT);
check('usuario comum em modo teste so ve a propria empresa', lojasT.s === 200 && lojasT.j.length > 0 && lojasT.j.every((l) => ['Loja E2E'].some((n) => l.nome.startsWith(n))), lojasT.j && lojasT.j.map((l) => l.nome));

const catT = (await api('GET', '/categories', null, GT)).j[0];
const supT = await api('POST', '/suppliers', { nome: 'Fornecedor so no teste', documento: '45.997.418/0001-53', telefone: '4133332222', categoria: 'Bebidas' }, GT);
const cliT = await api('POST', '/customers', { nome: 'Cliente so no teste', telefone: '11955554444' }, GT);
const prodT = await api('POST', '/products', { nome: 'Produto so no teste', categoria_id: catT.id, barcode: String(7891110000000 + (Date.now() % 100000000)), unidade: 'UN', preco_custo: 1, preco_venda: 2, location_id: lojasT.j[0].id, estoque_inicial: 5 }, GT);
check('cria fornecedor, produto e cliente em modo teste', supT.s === 201 && prodT.s === 201 && (cliT.s === 201 || cliT.s === 403), { sup: supT, prod: prodT, cli: cliT });
const depProd = await contar(prod);
const depTeste = await contar(teste);
check('producao INALTERADA pelas gravacoes do teste', igual(depProd, antesProd), { antesProd, depProd });
check('teste recebeu os novos registros', depTeste.suppliers === antesTeste.suppliers + 1 && depTeste.products === antesTeste.products + 1, { antesTeste, depTeste });
const supP = await api('POST', '/suppliers', { nome: 'Fornecedor so na producao', documento: '07.526.557/0001-00', telefone: '4133332222', categoria: 'Bebidas' }, ADM);
const ap = await contar(prod);
const at = await contar(teste);
check('producao recebe novo fornecedor e o teste NAO muda ate copiar', (supP.s === 201 || supP.s === 409) && at.suppliers === depTeste.suppliers && (supP.s === 409 || ap.suppliers === depProd.suppliers + 1), { supP: supP.s, ap, at });

// ---------- 4. Permissao retirada ----------
console.log('\n# 4. Permissao retirada com o token de teste ja emitido');
await api('PATCH', `/users/${gerId}`, { permissoes: { ModoTeste: false } }, ADM);
const antes4 = await contar(teste);
const r4 = await api('POST', '/suppliers', { nome: 'Nao deve gravar', documento: '11.222.333/0001-81', telefone: '4133332222', categoria: 'Bebidas' }, GT);
check('token de teste sem a permissao: 403 e modoTesteRevogado', r4.s === 403 && r4.j.modoTesteRevogado === true, r4);
check('nada foi gravado no teste nem na producao', igual(await contar(teste), antes4) && igual(await contar(prod), ap), {});
check('usuario ainda entra normalmente em producao (token comum)', (await api('GET', '/auth/me', null, GER0)).j.modoTeste === false);
await api('PATCH', `/users/${gerId}`, { permissoes: { ModoTeste: true } }, ADM);

// ---------- 6. Copia da producao ----------
console.log('\n# 6. Copia da producao para o teste');
const errCopiaGer = await api('POST', '/master/modo-teste/copiar-producao', { confirmacao: 'COPIAR' }, GER0);
check('usuario comum nao copia (403)', errCopiaGer.s === 403, errCopiaGer);
const errCopiaMasterSemTxt = await api('POST', '/master/modo-teste/copiar-producao', { confirmacao: 'copiar' }, MAS);
check('Master sem digitar COPIAR (400)', errCopiaMasterSemTxt.s === 400, errCopiaMasterSemTxt);
const stAntes = await api('GET', '/master/modo-teste/status', null, MAS);
check('status traz contagens producao x teste', stAntes.s === 200 && stAntes.j.configurado && stAntes.j.tabelas.length > 20 && stAntes.j.tabelas.some((t) => t.tabela === 'sales'), stAntes.s);
// falha simulada no meio: ROLLBACK, teste anterior preservado
const { copiarProducao } = require('../src/services/copiaProducao.js');
const marcador = await teste.query(`SELECT count(*) AS n FROM suppliers WHERE nome = 'Fornecedor so no teste'`);
let falhou = false;
try { await copiarProducao({ usuarioId: masterId, tenantId: tenant.id, falharNaTabela: 'sales' }); } catch (e) { falhou = /simulada/.test(e.message); }
const marcador2 = await teste.query(`SELECT count(*) AS n FROM suppliers WHERE nome = 'Fornecedor so no teste'`);
check('falha no meio da copia -> ROLLBACK (dados do teste preservados)', falhou && marcador.rows[0].n === marcador2.rows[0].n && Number(marcador2.rows[0].n) >= 1, { falhou, a: marcador.rows[0].n, b: marcador2.rows[0].n });
const auditoriaAntes = Number((await prod.query(`SELECT count(*) AS n FROM audit_logs WHERE acao = 'copiar_producao_para_teste'`)).rows[0].n);
const cp = await api('POST', '/master/modo-teste/copiar-producao', { confirmacao: 'COPIAR', anonimizar: true }, MAS);
check('Master copia a producao (200)', cp.s === 200 && cp.j.contagens, cp);
const pP = await contar(prod);
const pT = await contar(teste);
check('apos a copia: contagens do teste = producao', igual(
  { sales: pP.sales, products: pP.products, customers: pP.customers, suppliers: pP.suppliers, orders: pP.orders },
  { sales: pT.sales, products: pT.products, customers: pT.customers, suppliers: pT.suppliers, orders: pT.orders }), { pP, pT });
check('registro so do teste sumiu (teste substituido)', Number((await teste.query(`SELECT count(*) AS n FROM suppliers WHERE nome = 'Fornecedor so no teste'`)).rows[0].n) === 0);
const auditoriaDepois = Number((await prod.query(`SELECT count(*) AS n FROM audit_logs WHERE acao = 'copiar_producao_para_teste'`)).rows[0].n);
check('auditoria da copia gravada na PRODUCAO', auditoriaDepois === auditoriaAntes + 1, { auditoriaAntes, auditoriaDepois });
const anonim = await teste.query(`SELECT count(*) AS n FROM customers WHERE nome NOT LIKE 'Cliente %'`);
check('anonimizacao: nenhum cliente real no teste', Number(anonim.rows[0].n) === 0, anonim.rows);

// ---------- 7. Master em modo teste ----------
console.log('\n# 7. Master em modo teste (como Administrador da empresa escolhida)');
const emp = (await api('GET', '/master/modo-teste/status', null, MAS)).j.empresas;
check('lista de empresas do teste nao inclui Plataforma', emp.length > 0 && !emp.some((e) => e.nome === 'Plataforma'), emp.map((e) => e.nome));
const semEmpresa = await api('POST', '/auth/modo-teste', { ativo: true }, MAS);
check('Master precisa escolher a empresa (400)', semEmpresa.s === 400, semEmpresa);
const mt = await api('POST', '/auth/modo-teste', { ativo: true, empresa_id: tenant.id }, MAS);
check('Master liga o modo teste escolhendo a empresa', mt.s === 200 && mt.j.token, mt);
const meMT = await api('GET', '/auth/me', null, mt.j.token);
check('Master em teste: modoTeste=true e areas de Administrador', meMT.j.modoTeste === true && meMT.j.master === true && meMT.j.areas.Vendas && meMT.j.areas.Configuracoes, meMT.j);
const lojasM = await api('GET', '/locations', null, mt.j.token);
check('Master em teste ve as lojas da empresa escolhida', lojasM.s === 200 && lojasM.j.length > 0 && lojasM.j.every((l) => l.nome.startsWith('Loja E2E')), lojasM.j);
const off = await api('POST', '/auth/modo-teste', { ativo: false }, mt.j.token);
check('Master volta a producao (token sem modo teste)', off.s === 200 && off.j.token, off);
const meOff = await api('GET', '/auth/me', null, off.j.token);
check('de volta a producao: Master puro, sem acesso a dados de empresas', meOff.j.modoTeste === false && !meOff.j.areas.Vendas && (await api('GET', '/categories', null, off.j.token)).s === 403, meOff.j);

// ---------- 8b. regressao em producao (depois) ----------
console.log('\n# 8b. Producao continua funcionando');
const venda2 = await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.j.id, quantidade: 1 }], forma_pagamento: 'dinheiro', valor_recebido: 10 }, ADM);
check('venda direta em producao depois do modo teste', venda2.s === 201, venda2);
check('relatorio de vendas em producao', (await api('GET', '/sales', null, ADM)).s === 200);
check('clientes e pedidos em producao respondem', (await api('GET', '/customers', null, ADM)).s === 200 && (await api('GET', '/orders', null, ADM)).s === 200);

// ---------- limpeza: usuarios e2e inativos ----------
await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.%@girostock.local'`);
await prod.end();
await teste.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
