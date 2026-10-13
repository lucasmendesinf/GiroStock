// Teste ponta a ponta do Painel Master, fase 1: empresas e usuarios atrelados a empresa.
//
// Uso (API rodando em http://localhost:3000, banco migrado ate a 018):
//   npm run test:e2e:master-fase1        # API_URL padrao: http://localhost:3000
//
// Cria empresas "E2E M1 ..." e usuarios com e-mails e2e.m1.* pela propria API do Master (senhas aleatorias, so em memoria,
// nunca impressas). Use somente em banco de DESENVOLVIMENTO. No fim, as empresas ficam suspensas e os usuarios inativos.
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
const SENHA_MASTER = rnd();
const EMAIL_MASTER = `e2e.m1.master@girostock.local`;
const email = (quem) => `e2e.m1.${quem}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rota, body, tok) {
  try {
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- preparo: Master e2e ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E M1 Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_MASTER, SENHA_MASTER); // o Master exige 2FA
check('login do Master', !!MAS);

// ---------- 1. Criar empresa = empresa + loja + administrador ----------
console.log('\n# 1. Nova empresa cria empresa + loja + administrador juntos');
const empsAntes = Number((await prod.query(`SELECT count(*) AS n FROM tenants`)).rows[0].n);
const dados = { nome: 'E2E M1 Alfa ' + SUF, documento: '45.997.418/0001-53', plano: 'completo', loja_nome: 'Loja Alfa', admin: { nome: 'Admin Alfa', email: email('alfa') } };
const cA = await api('POST', '/master/empresas', dados, MAS);
check('POST /master/empresas -> 201 com senha temporaria gerada', cA.s === 201 && cA.j.senha_temporaria && cA.j.senha_temporaria.length >= 8 && cA.j.administrador.email === email('alfa'), cA.s);
const A = cA.j.empresa;
const SENHA_A = cA.j.senha_temporaria;
const lojasA = await prod.query(`SELECT nome FROM locations WHERE tenant_id = $1`, [A.id]);
const admA = (await prod.query(`SELECT perfil, location_id, deve_trocar_senha FROM users WHERE tenant_id = $1`, [A.id])).rows;
check('banco: 1 loja e 1 administrador (sem loja principal, troca obrigatoria)', lojasA.rows.length === 1 && lojasA.rows[0].nome === 'Loja Alfa' && admA.length === 1 && admA[0].perfil === 'Administrador' && admA[0].location_id === null && admA[0].deve_trocar_senha === true, { lojasA: lojasA.rows, admA });
const dup = await api('POST', '/master/empresas', { ...dados, nome: 'E2E M1 Duplicada ' + SUF }, MAS);
const empsDepois = Number((await prod.query(`SELECT count(*) AS n FROM tenants`)).rows[0].n);
check('e-mail duplicado -> 409 e NADA criado', dup.s === 409 && empsDepois === empsAntes + 1 && (await prod.query(`SELECT 1 FROM tenants WHERE nome = $1`, ['E2E M1 Duplicada ' + SUF])).rows.length === 0, { s: dup.s, empsAntes, empsDepois });
check('CNPJ invalido -> 400', (await api('POST', '/master/empresas', { ...dados, nome: 'E2E M1 X ' + SUF, documento: '11111111111111', admin: { nome: 'Z', email: email('x') } }, MAS)).s === 400);
const lgA = await login(email('alfa'), SENHA_A);
check('administrador entra e vem com deveTrocarSenha=true', lgA.s === 200 && lgA.j.usuario.deveTrocarSenha === true, lgA.j);
let TA = lgA.j.token;
const NOVA_A = rnd();
const troca = await api('POST', '/auth/change-password', { senha_atual: SENHA_A, nova_senha: NOVA_A }, TA);
const meA = await api('GET', '/auth/me', null, TA);
check('troca de senha limpa o flag', troca.s === 204 && meA.j.deveTrocarSenha === false, { troca: troca.s, me: meA.j });
const locsA = await api('GET', '/locations', null, TA);
check('administrador ve todas as lojas da empresa', locsA.s === 200 && locsA.j.length === 1, locsA.j);

// segunda empresa (plano Basico)
const cB = await api('POST', '/master/empresas', { nome: 'E2E M1 Beta ' + SUF, plano: 'basico', loja_nome: 'Loja Beta', admin: { nome: 'Admin Beta', email: email('beta'), senha: 'SenhaTemp' + SUF } }, MAS);
check('cria empresa Beta (plano Basico) com senha informada', cB.s === 201 && cB.j.senha_temporaria === 'SenhaTemp' + SUF, cB.s);
const Bemp = cB.j.empresa;
let TB = (await login(email('beta'), 'SenhaTemp' + SUF)).j.token;

// ---------- 2. Isolamento ----------
console.log('\n# 2. Isolamento entre empresas e acesso as rotas Master');
const usersA = await api('GET', '/users', null, TA);
check('administrador de Alfa so ve usuarios de Alfa', usersA.s === 200 && usersA.j.length === 1 && usersA.j[0].email === email('alfa'), usersA.j.map && usersA.j.map((u) => u.email));
const rotasMaster = ['/master/empresas', `/master/empresas/${A.id}`, '/master/usuarios', '/master/modo-teste/status'];
const negadas = [];
for (const r of rotasMaster) negadas.push((await api('GET', r, null, TA)).s);
check('rotas /api/master/* respondem 403 para administrador de empresa', negadas.every((s) => s === 403), negadas);
check('POST /master/empresas e /master/usuarios tambem 403 para quem nao e Master', (await api('POST', '/master/empresas', dados, TA)).s === 403 && (await api('POST', '/master/usuarios', { empresa_id: A.id }, TA)).s === 403);
const lista = await api('GET', '/master/empresas', null, MAS);
check('lista Master traz as empresas (sem Plataforma) e o resumo', lista.s === 200 && lista.j.empresas.some((e) => e.id === A.id) && !lista.j.empresas.some((e) => e.nome === 'Plataforma') && lista.j.resumo.empresas === lista.j.empresas.length, lista.j.resumo);

// ---------- 3. Suspender / reativar ----------
console.log('\n# 3. Suspender e reativar');
check('suspender sem motivo -> 400', (await api('POST', `/master/empresas/${A.id}/suspender`, {}, MAS)).s === 400);
const susp = await api('POST', `/master/empresas/${A.id}/suspender`, { motivo: 'e2e: teste de suspensao' }, MAS);
check('Master suspende a empresa', susp.s === 200, susp);
const lgS = await login(email('alfa'), NOVA_A);
check('login de usuario de empresa suspensa -> 403 "empresa suspensa"', lgS.s === 403 && /suspensa/.test(lgS.j.erro), lgS);
const sessaoAberta = await api('GET', '/auth/me', null, TA);
check('sessao ja aberta cai na proxima requisicao (403)', sessaoAberta.s === 403 && sessaoAberta.j.empresaSuspensa === true, sessaoAberta);
check('Master nunca e afetado', (await api('GET', '/auth/me', null, MAS)).s === 200);
const fichaS = await api('GET', `/master/empresas/${A.id}`, null, MAS);
check('ficha mostra situacao suspensa e o motivo', fichaS.j.status === 'suspensa' && /suspensao/.test(fichaS.j.suspenso_motivo), fichaS.j.status);
check('Master reativa', (await api('POST', `/master/empresas/${A.id}/reativar`, null, MAS)).s === 200);
const lgR = await login(email('alfa'), NOVA_A);
check('usuarios voltam a entrar apos reativar', lgR.s === 200, lgR.j);
TA = lgR.j.token;

// ---------- 4. Recursos por plano / override ----------
console.log('\n# 4. Plano Basico: Pedidos e Clientes indisponiveis; override libera');
const meB = await api('GET', '/auth/me', null, TB);
check('Basico: areas Pedidos/Clientes false para o Administrador', meB.j.areas.Pedidos === false && meB.j.areas.Clientes === false && meB.j.areas.Vendas === true, meB.j.areas);
check('Basico: rotas de Pedidos e Clientes -> 403', (await api('GET', '/orders', null, TB)).s === 403 && (await api('GET', '/customers', null, TB)).s === 403);
await api('PATCH', `/master/empresas/${Bemp.id}`, { recursos: { pedidos: true, clientes: true } }, MAS);
const meB2 = await api('GET', '/auth/me', null, TB);
check('override liga os recursos (sessao aberta ja reflete)', meB2.j.areas.Pedidos === true && meB2.j.areas.Clientes === true && (await api('GET', '/customers', null, TB)).s === 200, meB2.j.areas);
const ficha1 = await api('GET', `/master/empresas/${Bemp.id}`, null, MAS);
check('ficha informa que o recurso vem de override da empresa', ficha1.j.recursos.origem.pedidos === 'empresa', ficha1.j.recursos);
await api('PATCH', `/master/empresas/${Bemp.id}`, { recursos: { pedidos: false } }, MAS);
const meB3 = await api('GET', '/auth/me', null, TB);
check('override desligando bloqueia de novo', meB3.j.areas.Pedidos === false && (await api('GET', '/orders', null, TB)).s === 403, meB3.j.areas);
await api('PATCH', `/master/empresas/${Bemp.id}`, { recursos: null }, MAS);
const antigas = await prod.query(`SELECT count(*)::int AS n FROM tenants WHERE nome <> 'Plataforma' AND nome NOT LIKE 'E2E %' AND (plano <> 'completo' OR status <> 'ativa' OR limites IS NOT NULL OR recursos IS NOT NULL)`);
check('empresas existentes continuam completo/ativa/sem overrides', antigas.rows[0].n === 0, antigas.rows);
check('PATCH com recurso invalido -> 400', (await api('PATCH', `/master/empresas/${Bemp.id}`, { recursos: { foo: true } }, MAS)).s === 400);

// ---------- 5. Limites do plano ----------
console.log('\n# 5. Limites do plano (Basico: 1 loja, 3 usuarios, 1 PDV)');
const lojaB = (await api('GET', '/locations', null, TB)).j[0];
const u2 = await api('POST', '/users', { nome: 'Caixa B1', email: email('b1'), senha: 'abcdef1', perfil: 'Caixa/Operador', location_id: lojaB.id }, TB);
const u3 = await api('POST', '/users', { nome: 'Caixa B2', email: email('b2'), senha: 'abcdef1', perfil: 'Caixa/Operador', location_id: lojaB.id }, TB);
check('cria usuarios ate o limite (3 de 3)', u2.s === 201 && u3.s === 201, [u2.s, u3.s]);
const u4 = await api('POST', '/users', { nome: 'Caixa B3', email: email('b3'), senha: 'abcdef1', perfil: 'Caixa/Operador', location_id: lojaB.id }, TB);
check('rota da empresa: usuario alem do limite -> 409', u4.s === 409 && /limite de usuários/.test(u4.j.erro), u4);
const u5 = await api('POST', '/master/usuarios', { empresa_id: Bemp.id, nome: 'Master B3', email: email('b3m'), perfil: 'Caixa/Operador', location_id: lojaB.id }, MAS);
check('rota Master: usuario alem do limite -> 409', u5.s === 409 && /limite de usuários/.test(u5.j.erro), u5);
const l2 = await api('POST', '/locations', { nome: 'Segunda loja' }, TB);
check('loja alem do limite -> 409', l2.s === 409 && /limite de lojas/.test(l2.j.erro), l2);
const t1 = await api('POST', '/terminals', { nome: 'PDV B1', location_id: lojaB.id }, TB);
const t2 = await api('POST', '/terminals', { nome: 'PDV B2', location_id: lojaB.id }, TB);
check('1o PDV ok e 2o PDV alem do limite -> 409', t1.s === 201 && t2.s === 409 && /limite de PDVs/.test(t2.j.erro), [t1.s, t2.j]);
const fichaB = await api('GET', `/master/empresas/${Bemp.id}`, null, MAS);
check('ficha: limites efetivos x usados (usuarios 3 de 3)', fichaB.j.limites.find((l) => l.chave === 'usuarios').usado === 3 && fichaB.j.limites.find((l) => l.chave === 'usuarios').limite === 3, fichaB.j.limites);
await api('PATCH', `/master/empresas/${Bemp.id}`, { limites: { usuarios: 5 } }, MAS);
check('override de limite libera mais usuarios', (await api('POST', '/users', { nome: 'Caixa B3', email: email('b3'), senha: 'abcdef1', perfil: 'Caixa/Operador', location_id: lojaB.id }, TB)).s === 201);
await api('PATCH', `/master/empresas/${Bemp.id}`, { limites: null }, MAS);

// ---------- 6. Novo usuario pelo Master: empresa obrigatoria ----------
console.log('\n# 6. POST /master/usuarios');
check('sem empresa_id -> 400', (await api('POST', '/master/usuarios', { nome: 'X', email: email('x1'), perfil: 'Gerente' }, MAS)).s === 400);
check('perfil Master -> 403', (await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'X', email: email('x2'), perfil: 'Master' }, MAS)).s === 403);
const lojaA = locsA.j[0];
check('empresa inexistente -> 404', (await api('POST', '/master/usuarios', { empresa_id: '00000000-0000-0000-0000-000000000000', nome: 'X', email: email('x3'), perfil: 'Gerente', location_id: lojaA.id }, MAS)).s === 404);
const plat = (await prod.query(`SELECT id FROM tenants WHERE nome = 'Plataforma'`)).rows[0];
check('empresa Plataforma -> 404', (await api('POST', '/master/usuarios', { empresa_id: plat.id, nome: 'X', email: email('x4'), perfil: 'Administrador' }, MAS)).s === 404);
const lojaOutra = await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'X', email: email('x5'), perfil: 'Gerente', location_id: lojaB.id }, MAS);
check('loja de outra empresa -> 404', lojaOutra.s === 404, lojaOutra);
check('perfil nao-Administrador exige loja -> 400', (await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'X', email: email('x6'), perfil: 'Gerente' }, MAS)).s === 400);
const novoAdm = await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'Segundo Admin', email: email('adm2'), perfil: 'Administrador' }, MAS);
check('Administrador sem loja principal (todas as lojas) criado com senha temporaria unica', novoAdm.s === 201 && novoAdm.j.senha_temporaria && novoAdm.j.usuario.location_id === null, novoAdm.s);
const novoGer = await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'Gerente A', email: email('ger'), perfil: 'Gerente', location_id: lojaA.id }, MAS);
check('Gerente com loja da empresa criado (deve trocar senha)', novoGer.s === 201 && (await prod.query(`SELECT deve_trocar_senha FROM users WHERE id = $1`, [novoGer.j.usuario.id])).rows[0].deve_trocar_senha === true, novoGer.s);
check('e-mail ja usado em outra empresa -> 409', (await api('POST', '/master/usuarios', { empresa_id: Bemp.id, nome: 'X', email: email('ger'), perfil: 'Administrador' }, MAS)).s === 409);
const lu = await api('GET', '/master/usuarios', null, MAS);
check('lista de usuarios do Master nao traz Master e traz empresa/perfil/ultimo login/falhas', lu.s === 200 && !lu.j.usuarios.some((u) => u.perfil === 'Master') && lu.j.usuarios.every((u) => 'empresa_nome' in u && 'falhas_login' in u && 'ultimo_login' in u && 'modo_teste' in u), lu.s);
const filtro = await api('GET', `/master/usuarios?empresa_id=${A.id}&q=gerente`, null, MAS);
check('filtro por empresa e busca', filtro.j.usuarios.length === 1 && filtro.j.usuarios[0].email === email('ger'), filtro.j.usuarios && filtro.j.usuarios.map((u) => u.email));

// ---------- 7. Seguranca de usuarios ----------
console.log('\n# 7. Forcar troca, encerrar sessoes, desativar/reativar, permissao Modo teste');
const gerSenha = novoGer.j.senha_temporaria;
let TG = (await login(email('ger'), gerSenha)).j.token;
check('forcar troca de senha marca o flag', (await api('POST', `/master/usuarios/${novoGer.j.usuario.id}/forcar-troca-senha`, null, MAS)).s === 200 && (await api('GET', '/auth/me', null, TG)).j.deveTrocarSenha === true);
await espera(1200);
const enc = await api('POST', `/master/usuarios/${novoGer.j.usuario.id}/encerrar-sessoes`, null, MAS);
check('encerrar sessoes -> token antigo deixa de valer (401)', enc.s === 200 && (await api('GET', '/auth/me', null, TG)).s === 401);
const lgNovo = await login(email('ger'), gerSenha);
check('novo login funciona depois de encerrar', lgNovo.s === 200 && (await api('GET', '/auth/me', null, lgNovo.j.token)).s === 200, lgNovo.s);
TG = lgNovo.j.token;
await api('PATCH', `/master/usuarios/${novoGer.j.usuario.id}/status`, { ativo: false }, MAS);
check('desativado: login 401 e sessao aberta 401', (await login(email('ger'), gerSenha)).s === 401 && (await api('GET', '/auth/me', null, TG)).s === 401);
await api('PATCH', `/master/usuarios/${novoGer.j.usuario.id}/status`, { ativo: true }, MAS);
const lgG2 = await login(email('ger'), gerSenha);
check('reativado: volta a entrar', lgG2.s === 200);
TG = lgG2.j.token;
check('sem permissao: Modo teste negado', (await api('POST', '/auth/modo-teste', { ativo: false }, TG)).s === 403);
await api('PATCH', `/master/usuarios/${novoGer.j.usuario.id}/permissoes`, { ModoTeste: true }, MAS);
const gerMe = await api('GET', '/auth/me', null, TG);
const luMT = (await api('GET', `/master/usuarios?empresa_id=${A.id}`, null, MAS)).j.usuarios.find((u) => u.email === email('ger'));
check('Master concede ModoTeste (areas e lista refletem)', gerMe.j.areas.ModoTeste === true && luMT.modo_teste === true, { areas: gerMe.j.areas.ModoTeste, luMT: luMT.modo_teste });
await api('PATCH', `/master/usuarios/${novoGer.j.usuario.id}/permissoes`, { ModoTeste: false }, MAS);
check('Master retira ModoTeste', (await api('GET', '/auth/me', null, TG)).j.areas.ModoTeste === false);
const masterId = (await prod.query(`SELECT id FROM users WHERE perfil = 'Master' AND lower(email::text) = $1`, [EMAIL_MASTER])).rows[0].id;
check('acoes de seguranca em Master -> 403', (await api('POST', `/master/usuarios/${masterId}/encerrar-sessoes`, null, MAS)).s === 403 && (await api('PATCH', `/master/usuarios/${masterId}/status`, { ativo: false }, MAS)).s === 403);

// ---------- 8. Falhas de login ----------
console.log('\n# 8. Contagem de falhas de login');
await login(email('adm2'), 'errada-1');
await login(email('adm2'), 'errada-2');
const f1 = (await api('GET', `/master/usuarios?empresa_id=${A.id}&q=adm2`, null, MAS)).j.usuarios[0];
check('falhas incrementam (2)', f1.falhas_login === 2, f1.falhas_login);
const lgOk = await login(email('adm2'), novoAdm.j.senha_temporaria);
const f2 = (await api('GET', `/master/usuarios?empresa_id=${A.id}&q=adm2`, null, MAS)).j.usuarios[0];
check('login correto zera as falhas e grava ultimo_login', lgOk.s === 200 && f2.falhas_login === 0 && f2.ultimo_login, f2);
const resumo = (await api('GET', '/master/usuarios', null, MAS)).j.resumo;
check('resumo traz ativos, falhas 24h e sem login 30+ dias', ['ativos', 'total', 'falhas_24h', 'usuarios_3_falhas', 'sem_login_30d'].every((k) => typeof resumo[k] === 'number'), resumo);

// ---------- 9. Nada de dados de negocio ----------
console.log('\n# 9. Master nao ve vendas, pedidos, clientes nem produtos');
const proibidas = /"(vendas|faturamento|sales|orders|products|produtos|customers|total_vendas|receita)"/i;
const respostas = [JSON.stringify(lista.j), JSON.stringify(fichaB.j), JSON.stringify(lu.j), JSON.stringify((await api('GET', `/master/empresas/${A.id}`, null, MAS)).j)];
check('respostas /api/master/empresas* e /usuarios sem chaves de vendas/pedidos/clientes/produtos', respostas.every((r) => !proibidas.test(r)), respostas.map((r) => (r.match(proibidas) || [])[0]));
check('Master em producao nao le dados de empresas (GET /categories -> 403)', (await api('GET', '/categories', null, MAS)).s === 403);

// ---------- 10. Regressao basica ----------
console.log('\n# 10. Regressao');
const tok = (await login(email('adm2'), novoAdm.j.senha_temporaria)).j.token;
check('administrador de empresa: /users, /locations, /products continuam respondendo', (await api('GET', '/users', null, tok)).s === 200 && (await api('GET', '/locations', null, tok)).s === 200 && (await api('GET', '/products', null, tok)).s === 200);
check('/auth/me do Master em producao: master=true e so area Master/ModoTeste', (await api('GET', '/auth/me', null, MAS)).j.areas.Master === true);

// ---------- limpeza: empresas suspensas e usuarios inativos ----------
await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.m1.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E M1 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
