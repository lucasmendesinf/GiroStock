// e2e das permissoes de edicao (EditarProdutos, EditarFornecedores, EditarInsumos) e da protecao anti-escalada / ultimo Administrador.
// npm run test:e2e:permissoes-edicao   (API em http://localhost:3000)
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.pe.master@girostock.local';
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

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E PE Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);

async function novaEmpresa(rotulo) {
  const email = `e2e.pe.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E PE ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Casa', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token, adminId: lg.j.usuario.id };
}
async function usuario(emp, nome, perfil, extra = {}) {
  const email = `e2e.pe.${nome.toLowerCase()}.${SUF}@girostock.local`;
  const senha = rnd();
  const r = await api('POST', '/users', { nome, email, senha, perfil, ...extra }, emp.token);
  const lg = await login(email, senha);
  return { id: r.j.id, token: lg.j && lg.j.token, usuario: lg.j && lg.j.usuario, status: r.s, email, senha };
}
// CNPJ valido (digitos verificadores calculados) para cadastrar fornecedores nos testes
function cnpj(n) {
  const base = String(n).padStart(8, '0').slice(-8) + '0001';
  const dv = (d) => { let p = d.length - 7; let s = 0; for (const c of d) { s += Number(c) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base); const d2 = dv(base + d1);
  return base + d1 + d2;
}
const fornecedor = (nome, n) => ({ nome, documento: cnpj(n), telefone: '11999990000', categoria: 'Outros' });
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');

console.log('\n# Preparo');
const E = await novaEmpresa('a');
await api('PATCH', `/master/empresas/${E.id}`, { limites: { usuarios: 100 } }, MAS); // o teste cria muitos usuarios
const L1 = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
await api('POST', '/categories', { nome: 'Geral' }, E.token);
const catId = (await api('GET', '/categories', null, E.token)).j[0].id;
const prodAdmin = async (nome) => (await api('POST', '/products', { nome, categoria_id: catId, barcode: bc(), unidade: 'UN', preco_custo: 1, preco_venda: 5, location_id: L1, estoque_inicial: 10 }, E.token)).j.id;
const P1 = await prodAdmin('Produto E2E 1');
const FORN_N = Date.now() % 1e8;
const FORN = (await api('POST', '/suppliers', fornecedor('Fornecedor E2E', FORN_N), E.token)).j.id;
const INS = (await api('POST', '/ingredients', { nome: 'Insumo E2E', unidade: 'G', estoque_inicial: 100, custo_total: 10, location_id: L1 }, E.token)).j.id;
check('base criada pelo administrador', !!P1 && !!FORN && !!INS);
const GER = await usuario(E, 'GerenteN', 'Gerente', { location_id: L1 });
const EST = await usuario(E, 'EstoqueN', 'Estoque', { location_id: L1 });
const CAI = await usuario(E, 'CaixaN', 'Caixa/Operador', { location_id: L1 });
check('usuários novos criados', [GER, EST, CAI].every((u) => u.status === 201));

console.log('\n# 1. Padrão novo: só o Administrador edita; os demais criam e movimentam');
check('as novas áreas chegam ao front (login): Administrador sim, Gerente e Estoque não', E.token && GER.usuario.areas.EditarProdutos === false && EST.usuario.areas.EditarInsumos === false && (await api('GET', '/auth/me', null, E.token)).j.areas.EditarFornecedores === true);
const edita = async (tok) => ({
  produto: (await api('PUT', `/products/${P1}`, { nome: 'Produto E2E 1 editado' }, tok)).s,
  produtoStatus: (await api('PATCH', `/products/${P1}/status`, { ativo: true }, tok)).s,
  fornecedor: (await api('PUT', `/suppliers/${FORN}`, fornecedor('Fornecedor E2E', FORN_N), tok)).s,
  insumo: (await api('PUT', `/ingredients/${INS}`, { nome: 'Insumo E2E' }, tok)).s,
});
for (const [nome, u] of [['Gerente', GER], ['Estoque', EST]]) {
  const r = await edita(u.token);
  check(`${nome} novo NÃO edita produto, fornecedor nem insumo (403)`, r.produto === 403 && r.produtoStatus === 403 && r.fornecedor === 403 && r.insumo === 403, r);
}
const msg = (await api('PUT', `/products/${P1}`, { nome: 'x' }, GER.token)).j;
check('o 403 diz qual permissão falta', /EditarProdutos/.test(msg.erro), msg);
const cria = await Promise.all([
  api('POST', '/products', { nome: 'Criado pelo Gerente', categoria_id: catId, barcode: bc(), unidade: 'UN', preco_custo: 1, preco_venda: 5, location_id: L1, estoque_inicial: 5 }, GER.token),
  api('POST', '/suppliers', fornecedor('Forn do Estoque', (Date.now() + 7) % 1e8), EST.token),
  api('POST', '/ingredients', { nome: 'Insumo do Estoque', unidade: 'G', estoque_inicial: 10, custo_total: 1, location_id: L1 }, EST.token),
  api('POST', '/categories', { nome: 'Cat do Gerente' }, GER.token),
]);
check('mas CRIAM produto, fornecedor, insumo e categoria (201)', cria.every((r) => r.s === 201), cria.map((r) => r.s));
check('e movimentam estoque (entrada de insumo, mínimo)', (await api('POST', `/ingredients/${INS}/stock-entries`, { quantidade: 5, custo_total: 1, location_id: L1 }, EST.token)).s === 200 && (await api('PUT', `/ingredients/${INS}/minimum`, { location_id: L1, estoque_minimo: 3 }, EST.token)).s === 200);
const ra = await edita(E.token);
check('Administrador edita tudo (200)', ra.produto === 200 && ra.produtoStatus === 200 && ra.fornecedor === 200 && ra.insumo === 200, ra);
check('renomear/excluir categoria exige EditarProdutos (403 sem; 200 com)', (await api('PATCH', `/categories/${catId}`, { nome: 'Geral 2' }, GER.token)).s === 403 && (await api('DELETE', `/categories/${cria[3].j.id}`, null, GER.token)).s === 403 && (await api('PATCH', `/categories/${catId}`, { nome: 'Geral 2' }, E.token)).s === 200);

console.log('\n# 2. Ajuste individual: cada permissão é independente');
const concede = (u, p) => api('PATCH', `/users/${u.id}`, { permissoes: p }, E.token);
check('administrador concede EditarProdutos ao Estoque', (await concede(EST, { EditarProdutos: true })).s === 200);
let r2 = await edita(EST.token);
check('Estoque edita produto, mas segue sem fornecedor e insumo', r2.produto === 200 && r2.produtoStatus === 200 && r2.fornecedor === 403 && r2.insumo === 403, r2);
check('ficha técnica (lanchonete) e complementos também são de EditarProdutos', (await api('POST', `/products/${P1}/ingredients`, { ingredient_id: INS, quantidade_por_unidade: 1 }, GER.token)).s === 403 && (await api('POST', '/complement-groups', { nome: 'Extras', minimo: 0, maximo: 2 }, EST.token)).s === 201);
const grp = (await api('GET', '/complement-groups', null, E.token)).j[0];
check('editar/excluir grupo de complementos: 403 sem EditarProdutos, 200 com', (await api('PATCH', `/complement-groups/${grp.id}`, { nome: 'Extras 2' }, GER.token)).s === 403 && (await api('PATCH', `/complement-groups/${grp.id}`, { nome: 'Extras 2' }, EST.token)).s === 200);
await concede(EST, { EditarFornecedores: true });
r2 = await edita(EST.token);
check('trocar para EditarFornecedores: só fornecedor edita', r2.produto === 403 && r2.fornecedor === 200 && r2.insumo === 403, r2);
await concede(EST, { EditarInsumos: true });
r2 = await edita(EST.token);
check('trocar para EditarInsumos: só insumo edita', r2.produto === 403 && r2.fornecedor === 403 && r2.insumo === 200, r2);
await concede(EST, {});
r2 = await edita(EST.token);
check('revogar tudo: volta a 403 nas três', r2.produto === 403 && r2.fornecedor === 403 && r2.insumo === 403, r2);

console.log('\n# 3. Migration preserva o que já existia');
const sqlMig = fs.readFileSync(path.join(raiz, 'src/db/migrations/043_permissoes_edicao.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').split(/;\s*\n/)[0];
const escopo = (sql) => sql.replace('WHERE perfil::text NOT IN', `WHERE tenant_id = '${E.id}' AND perfil::text NOT IN`);
check('o SQL da migration foi encontrado', /UPDATE users/.test(sqlMig), sqlMig.slice(0, 80));
// usuários "antigos": criados antes da migration (sem os ajustes novos), um com ajuste previo e um com Estoque revogado
const ANT1 = await usuario(E, 'AntigoGerente', 'Gerente', { location_id: L1 });
const ANT2 = await usuario(E, 'AntigoEstoque', 'Estoque', { location_id: L1, permissoes: { Desconto: true } });
const ANT3 = await usuario(E, 'AntigoSemEstoque', 'Gerente', { location_id: L1, permissoes: { Estoque: false } });
await prod.query(`UPDATE users SET permissoes = NULL WHERE id = $1`, [ANT1.id]); // gerente antigo, sem ajustes
await prod.query(`UPDATE users SET permissoes = '{"Desconto": true}'::jsonb WHERE id = $1`, [ANT2.id]); // estoque antigo com ajuste previo
await prod.query(`UPDATE users SET permissoes = '{"Estoque": false}'::jsonb WHERE id = $1`, [ANT3.id]); // gerente SEM estoque
const antesCx = (await prod.query(`SELECT permissoes FROM users WHERE id = $1`, [CAI.id])).rows[0].permissoes;
await prod.query(escopo(sqlMig));
const perm = async (id) => (await prod.query(`SELECT permissoes FROM users WHERE id = $1`, [id])).rows[0].permissoes;
const p1 = await perm(ANT1.id); const p2 = await perm(ANT2.id); const p3 = await perm(ANT3.id);
check('gerente antigo ganha os 3 ajustes', p1 && p1.EditarProdutos === true && p1.EditarFornecedores === true && p1.EditarInsumos === true, p1);
check('estoque antigo com ajuste prévio: mescla sem apagar (Desconto continua)', p2 && p2.Desconto === true && p2.EditarProdutos === true, p2);
check('quem não tinha Estoque (revogado) e o Caixa NÃO ganham', !(p3 && p3.EditarProdutos) && JSON.stringify(await perm(CAI.id)) === JSON.stringify(antesCx), [p3, await perm(CAI.id)]);
check('administrador não é tocado', (await perm(E.adminId)) === null || !(await perm(E.adminId)).EditarProdutos);
const ant1Login = await login(ANT1.email, ANT1.senha);
check('depois de migrar, o gerente antigo continua editando (e o login traz as áreas)', ant1Login.j.usuario.areas.EditarProdutos === true && (await api('PUT', `/products/${P1}`, { nome: 'editado pelo antigo' }, ant1Login.j.token)).s === 200);
const antesReexec = JSON.stringify([await perm(ANT1.id), await perm(ANT2.id), await perm(ANT3.id)]);
await prod.query(escopo(sqlMig));
check('reexecutar é idempotente (nada duplica nem muda)', JSON.stringify([await perm(ANT1.id), await perm(ANT2.id), await perm(ANT3.id)]) === antesReexec);
const NOVO = await usuario(E, 'GerenteDepois', 'Gerente', { location_id: L1 });
check('usuário criado DEPOIS segue o padrão novo (não edita)', (await api('PUT', `/products/${P1}`, { nome: 'x' }, NOVO.token)).s === 403 && (await perm(NOVO.id)) === null);

console.log('\n# 4. Anti-escalada');
const GC = await usuario(E, 'GerenteCfg', 'Gerente', { location_id: L1, permissoes: { Configuracoes: true, EditarFornecedores: true } });
check('gerente com Configurações para os testes', GC.status === 201 && GC.usuario.areas.Configuracoes === true && GC.usuario.areas.EditarProdutos === false);
const alvo = await usuario(E, 'AlvoEstoque', 'Estoque', { location_id: L1 });
const r41 = await api('PATCH', `/users/${alvo.id}`, { permissoes: { EditarProdutos: true } }, GC.token);
check('gerente NÃO concede o que não tem (EditarProdutos): 403 com a lista', r41.s === 403 && /conceder permiss/.test(r41.j.erro) && /EditarProdutos/.test(r41.j.erro), r41);
check('gerente concede o que TEM (EditarFornecedores): 200', (await api('PATCH', `/users/${alvo.id}`, { permissoes: { EditarFornecedores: true } }, GC.token)).s === 200);
check('criar usuário já com permissão que não tem: 403', (await api('POST', '/users', { nome: 'Ruim', email: `e2e.pe.ruim.${SUF}@girostock.local`, senha: rnd(), perfil: 'Estoque', location_id: L1, permissoes: { EditarInsumos: true } }, GC.token)).s === 403);
check('gerente não cria Administrador (403)', (await api('POST', '/users', { nome: 'Adm', email: `e2e.pe.adm.${SUF}@girostock.local`, senha: rnd(), perfil: 'Administrador' }, GC.token)).s === 403);
check('gerente não promove ninguém a Administrador (403)', (await api('PATCH', `/users/${alvo.id}`, { perfil: 'Administrador' }, GC.token)).s === 403);
const ADM2 = await usuario(E, 'AdminDois', 'Administrador');
check('administrador cria outro Administrador', ADM2.status === 201);
check('gerente não edita, desativa, redefine senha nem reseta 2FA de Administrador (403)', (await api('PATCH', `/users/${ADM2.id}`, { nome: 'Invasor' }, GC.token)).s === 403 && (await api('PATCH', `/users/${ADM2.id}/status`, { ativo: false }, GC.token)).s === 403 && (await api('PATCH', `/users/${ADM2.id}/password`, { senha: rnd() }, GC.token)).s === 403 && (await api('POST', `/users/${ADM2.id}/2fa/resetar`, null, GC.token)).s === 403);
check('ninguém amplia o próprio acesso (gerente tenta se dar EditarProdutos: 403)', (await api('PATCH', `/users/${GC.id}`, { permissoes: { EditarFornecedores: true, EditarProdutos: true, Configuracoes: true } }, GC.token)).s === 403);
check('administrador concede qualquer coisa a outra pessoa', (await api('PATCH', `/users/${alvo.id}`, { permissoes: { EditarProdutos: true, EditarInsumos: true, ModoTeste: true } }, E.token)).s === 200);
check('administrador não amplia o PRÓPRIO acesso (ex.: ModoTeste): 403', (await api('PATCH', `/users/${E.adminId}`, { permissoes: { ModoTeste: true } }, E.token)).s === 403);
check('mudanças de perfil/permissão ficam auditadas', (await prod.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND acao = 'alterar_permissao'`, [E.id])).rows[0].n >= 3);

console.log('\n# 5. Nunca sem Administrador ativo');
const F = await novaEmpresa('b'); // uma empresa com UM administrador
check('Master NÃO desativa o único Administrador (400)', (await api('PATCH', `/master/usuarios/${F.adminId}/status`, { ativo: false }, MAS)).s === 400);
const F2 = await usuario(F, 'AdminB2', 'Administrador');
check('o administrador não se desativa nem se rebaixa (regras antigas, 400)', (await api('PATCH', `/users/${F.adminId}/status`, { ativo: false }, F.token)).s === 400 && (await api('PATCH', `/users/${F.adminId}`, { perfil: 'Gerente' }, F.token)).s === 400);
const corrida = await Promise.all([
  api('PATCH', `/users/${F2.id}/status`, { ativo: false }, F.token), // admin 1 desativa o 2
  api('PATCH', `/users/${F.adminId}/status`, { ativo: false }, F2.token), // admin 2 desativa o 1, ao mesmo tempo
]);
const ativos = (await prod.query(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND perfil = 'Administrador' AND ativo`, [F.id])).rows[0].n;
check('dois administradores tentando se desativar ao mesmo tempo: sobra UM ativo (um pedido é recusado: 400/401 ou 409 de concorrência)', ativos === 1 && corrida.filter((r) => r.s === 200).length === 1 && corrida.some((r) => [400, 401, 409].includes(r.s)), [corrida.map((r) => [r.s, r.j && r.j.erro]), ativos]);
const sobrou = (await prod.query(`SELECT id FROM users WHERE tenant_id = $1 AND perfil = 'Administrador' AND ativo`, [F.id])).rows[0].id;
check('depois da corrida o Master também recusa desativar o que sobrou (400)', (await api('PATCH', `/master/usuarios/${sobrou}/status`, { ativo: false }, MAS)).s === 400);
check('com um segundo Administrador ativo o Master desativa um (200)', await (async () => {
  const desativado = (await prod.query(`SELECT id FROM users WHERE tenant_id = $1 AND perfil = 'Administrador' AND NOT ativo`, [F.id])).rows[0].id;
  await api('PATCH', `/master/usuarios/${desativado}/status`, { ativo: true }, MAS);
  return (await api('PATCH', `/master/usuarios/${desativado}/status`, { ativo: false }, MAS)).s === 200;
})());
// rebaixar o outro administrador pelo PATCH de perfil
const G3 = await usuario(E, 'AdminTres', 'Administrador');
check('rebaixar um Administrador com outro ativo: 200; o último não: 400', (await api('PATCH', `/users/${G3.id}`, { perfil: 'Gerente' }, E.token)).s === 200 && (await api('PATCH', `/users/${E.adminId}`, { perfil: 'Gerente' }, ADM2.token)).s === 200 && (await api('PATCH', `/users/${ADM2.id}`, { perfil: 'Gerente' }, ADM2.token)).s === 400);

console.log('\n# 6. Descrição, categoria, insumo, balanço e PDV');
// GER e EST foram migrados na seção 3 (passaram a editar): aqui valem os criados DEPOIS, com o padrão novo
const ESTN = await usuario({ token: ADM2.token }, 'EstoqueDepois', 'Estoque', { location_id: L1 });
// o administrador original foi rebaixado na seção 5: segue o AdminDois
const ADMIN = { token: ADM2.token };
const d1 = await api('PUT', `/products/${P1}`, { descricao: '  Descrição de teste  ' }, ADMIN.token);
check('descrição do produto grava (sem espaços nas pontas) e aparece no detalhe', d1.s === 200 && (await api('GET', `/products/${P1}`, null, ADMIN.token)).j.descricao === 'Descrição de teste');
const dd = [(await api('PUT', `/products/${P1}`, { descricao: 'x' }, NOVO.token)).s, (await api('PUT', `/products/${P1}`, { descricao: 'x'.repeat(1001) }, ADMIN.token)).s];
check('descrição só com EditarProdutos (403) e limite de 1000 (400)', dd[0] === 403 && dd[1] === 400, dd);
const dm = await api('PUT', `/products/${P1}`, { nome: 'Produto E2E 1 outra vez' }, ADMIN.token);
check('editar o produto sem enviar descrição mantém a atual', dm.s === 200 && (await api('GET', `/products/${P1}`, null, ADMIN.token)).j.descricao === 'Descrição de teste', dm);
const cDup = await api('POST', '/categories', { nome: 'Outra' }, ADMIN.token);
check('renomear categoria para nome já usado -> 409 (também na criação)', (await api('PATCH', `/categories/${cDup.j.id}`, { nome: 'geral 2' }, ADMIN.token)).s === 409 && (await api('POST', '/categories', { nome: 'GERAL 2' }, ADMIN.token)).s === 409 && (await api('PATCH', `/categories/${cDup.j.id}`, { nome: 'Outra renomeada' }, ADMIN.token)).s === 200);
check('insumo: editar (nome/custo) e ativar/desativar com EditarInsumos', (await api('PUT', `/ingredients/${INS}`, { nome: 'Insumo editado', custo_unitario: 0.2 }, ADMIN.token)).s === 200 && (await api('PUT', `/ingredients/${INS}`, { ativo: false }, ADMIN.token)).s === 200 && (await api('PUT', `/ingredients/${INS}`, { ativo: true }, ADMIN.token)).s === 200);
const bal = (tok, extra) => api('POST', `/ingredients/${INS}/stock-adjustment`, { novo_saldo: 50, location_id: L1, motivo: 'contagem e2e', ...extra }, tok);
const b0 = await bal(ESTN.token, {});
check('balanço só do saldo: continua em Estoque (200)', b0.s === 200, b0);
check('balanço que ALTERA o custo: 403 sem EditarInsumos; com a permissão passa', (await bal(ESTN.token, { novo_custo_unitario: 9 })).s === 403 && (await api('PATCH', `/users/${ESTN.id}`, { permissoes: { EditarInsumos: true } }, ADMIN.token)).s === 200 && (await bal(ESTN.token, { novo_custo_unitario: 9 })).s === 200);
check('balanço repetindo o mesmo custo não exige a permissão', (await api('PATCH', `/users/${ESTN.id}`, { permissoes: {} }, ADMIN.token)).s === 200 && (await bal(ESTN.token, { novo_custo_unitario: 9 })).s === 200);
const T1 = (await api('POST', '/terminals', { location_id: L1, nome: 'Caixa 1' }, ADMIN.token)).j.id;
await api('POST', '/cash-sessions', { terminal_id: T1, valor_inicial: 0 }, ADMIN.token);
const caixaTok = (await login(CAI.email, CAI.senha)).j.token;
check('PDV: sem a permissão Desconto o servidor recusa (403); sem desconto vende', (await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: P1, quantidade: 1 }], forma_pagamento: 'pix', desconto: 1 }, caixaTok)).s === 403 && (await api('POST', '/sales', { terminal_id: T1, itens: [{ product_id: P1, quantidade: 1 }], forma_pagamento: 'pix' }, caixaTok)).s === 201);

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.pe.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E PE %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
