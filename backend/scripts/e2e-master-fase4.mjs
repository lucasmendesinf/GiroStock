// Teste ponta a ponta do Painel Master, fase 4: "Entrar como suporte".
//
// Uso (API rodando em http://localhost:3000, banco migrado ate a 022):
//   npm run test:e2e:master-fase4
//
// Cria empresas "E2E M4 ..." e usuarios e2e.m4.* pela API do Master (senhas aleatorias, so em memoria, nunca impressas).
// Use somente em banco de DESENVOLVIMENTO. `npm run limpar-e2e` remove tudo no fim, se quiser.
import 'dotenv/config';
import { createRequire } from 'node:module';
import { masterComSegredo, totpIndependente } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const SENHA_MASTER = rnd();
const EMAIL_MASTER = 'e2e.m4.master@girostock.local';
const email = (q) => `e2e.m4.${q}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rotaOriginal, body, tok) {
  try {
    const rota = method === 'GET' && /^\/master\/(empresas|usuarios|auditoria|uso)/.test(rotaOriginal) ? rotaOriginal + (rotaOriginal.includes('?') ? '&' : '?') + 'teste=1' : rotaOriginal; // dados E2E ficam ocultos por padrao
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
const decodificar = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());

// ---------- preparo ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E M4 Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
let { token: MAS, segredo } = await masterComSegredo(B, EMAIL_MASTER, SENHA_MASTER);
check('login do Master (com 2FA)', !!MAS);
const master = (await prod.query(`SELECT id, tenant_id FROM users WHERE lower(email::text) = $1`, [EMAIL_MASTER])).rows[0];
// Cada inicio de suporte exige um codigo TOTP novo: zera o "ultimo passo" para poder reutilizar o passo atual nos testes.
const codigo = async () => { await prod.query(`UPDATE users SET totp_ultimo_passo = NULL, totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $1`, [master.id]); return totpIndependente(segredo); };
const fecharAbertas = () => prod.query(`UPDATE sessoes_suporte SET encerrada_em = now(), encerrada_por = 'sistema' WHERE master_id = $1 AND encerrada_em IS NULL`, [master.id]);

async function novaEmpresa(rotulo, extra = {}) {
  const r = await api('POST', '/master/empresas', { nome: `E2E M4 ${rotulo} ${SUF}`, plano: 'completo', loja_nome: `Loja ${rotulo}`, admin: { nome: `Admin ${rotulo}`, email: email(rotulo.toLowerCase()) }, ...extra }, MAS);
  if (r.s !== 201) throw new Error('empresa nao criada: ' + JSON.stringify(r.j));
  const lg = await login(email(rotulo.toLowerCase()), r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, nome: r.j.empresa.nome, token: lg.j.token, senha: nova, email: email(rotulo.toLowerCase()) };
}
const A = await novaEmpresa('Alfa');
const Bm = await novaEmpresa('Beta');
const C = await novaEmpresa('Gama');
// A empresa Alfa passa a ter 2FA ativo (so a marca: o codigo exigido e o do Master); Beta e Gama nao tem.
await prod.query(`UPDATE users SET totp_ativo = true WHERE lower(email::text) = $1`, [email('alfa')]);
const lojaA = (await prod.query(`SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1`, [A.id])).rows[0].id;
// gerente da empresa A (nao administrador)
const ger = await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'Gerente A', email: email('gerente'), perfil: 'Gerente', location_id: lojaA }, MAS);
const lgGer = await login(email('gerente'), ger.j.senha_temporaria);
check('gerente da empresa A criado', ger.s === 201 && lgGer.s === 200, ger);
// produtos: um em A, outro em B
const categoria = async (tenant) => (await prod.query(`INSERT INTO categories (tenant_id, nome) VALUES ($1, 'Categoria E2E') RETURNING id`, [tenant])).rows[0].id;
const produto = async (tenant, nome) => (await prod.query(`INSERT INTO products (tenant_id, categoria_id, codigo_interno, nome, barcode, unidade, preco_custo, preco_venda) VALUES ($1, $5, $2, $3, $4, 'UN', 1, 2) RETURNING id`, [tenant, 'E2E' + rnd().slice(0, 6), nome, String(Date.now()).slice(-10) + String(Math.floor(Math.random() * 1000)).padStart(3, '0'), await categoria(tenant)])).rows[0].id;
const prodA = await produto(A.id, `Produto Alfa ${SUF}`);
const prodB = await produto(Bm.id, `Produto Beta ${SUF}`);

async function iniciar(empresaId, opcoes = {}) {
  return api('POST', `/master/empresas/${empresaId}/suporte`, { motivo: 'Chamado 123: ajustar cadastro de produto (e2e)', edicao: false, avisar: true, codigo: await codigo(), ...opcoes }, MAS);
}

// ---------- 1. Iniciar ----------
console.log('\n# 1. Só o Master inicia, com motivo, 2FA e empresa ativa');
await fecharAbertas();
check('administrador de empresa -> 403', (await api('POST', `/master/empresas/${A.id}/suporte`, { motivo: 'tentando entrar sem ser Master', codigo: '000000' }, A.token)).s === 403);
check('sem motivo -> 400', (await iniciar(A.id, { motivo: '' })).s === 400);
check('motivo curto (< 10) -> 400', (await iniciar(A.id, { motivo: 'curto' })).s === 400);
check('motivo longo demais (> 300) -> 400', (await iniciar(A.id, { motivo: 'x'.repeat(301) })).s === 400);
check('empresa COM 2FA: sem o código -> 400', (await iniciar(A.id, { codigo: undefined })).s === 400);
const semDois = await api('POST', `/master/empresas/${Bm.id}/suporte`, { motivo: 'Chamado 321: empresa sem 2FA (e2e)', avisar: false }, MAS);
check('empresa SEM 2FA: entra sem pedir código (201)', semDois.s === 201, semDois);
await api('POST', '/master/suporte/encerrar', null, semDois.j.token);
check('a lista de empresas informa quem usa 2FA (cliente_2fa)', (await api('GET', '/master/empresas', null, MAS)).j.empresas.filter((e) => [A.id, Bm.id].includes(e.id)).every((e) => e.cliente_2fa === (e.id === A.id)));
const errado = await iniciar(A.id, { codigo: '000000' });
check('código do 2FA errado -> 400 (e nenhuma sessão aberta)', errado.s === 400 && Number((await prod.query(`SELECT count(*) AS n FROM sessoes_suporte WHERE master_id = $1 AND encerrada_em IS NULL`, [master.id])).rows[0].n) === 0, errado);
check('empresa inexistente -> 404', (await iniciar(crypto.randomUUID())).s === 404);
const plat = (await prod.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' LIMIT 1`)).rows[0].id;
check('empresa Plataforma -> 404', (await iniciar(plat)).s === 404);
await api('POST', `/master/empresas/${C.id}/suspender`, { motivo: 'e2e: suporte em empresa suspensa' }, MAS);
check('empresa suspensa -> 409', (await iniciar(C.id)).s === 409);
const sv = require('../src/services/suporte');
let errTeste = null;
try { await sv.iniciar({ master: { id: master.id }, empresaId: A.id, motivo: 'tentativa com modo teste ativo', codigo: '123456', reautenticar: async () => {}, modoTesteAtivo: true }); } catch (e) { errTeste = e; }
check('com modo teste ativo -> 409', errTeste && errTeste.status === 409, errTeste && errTeste.message);

// ---------- 2. Somente leitura ----------
console.log('\n# 2. Sessão somente leitura');
const s1 = await iniciar(A.id);
check('iniciar -> 201 com token e prazo', s1.s === 201 && s1.j.token && s1.j.sessao.empresa === A.nome && s1.j.sessao.edicao === false, s1);
const T1 = s1.j.token;
const dec = decodificar(T1);
check('o token tem no máximo 30 minutos de validade (sem renovação)', dec.exp - dec.iat <= 1800 && dec.suporte && dec.suporte.sessaoId === s1.j.sessao.id, { dur: dec.exp - dec.iat });
check('segunda sessão ao mesmo tempo -> 409', (await iniciar(A.id)).s === 409);
const me1 = await api('GET', '/auth/me', null, T1);
check('/auth/me: Administrador da empresa acessada, com o estado do suporte (somente leitura)', me1.s === 200 && me1.j.perfil === 'Administrador' && me1.j.empresaNome === A.nome && me1.j.suporte && me1.j.suporte.empresa === A.nome && me1.j.suporte.edicao === false && me1.j.areas.Estoque && !me1.j.areas.Master, me1.j);
const prods = await api('GET', '/products', null, T1);
const nomes = JSON.stringify(prods.j);
check('lê produtos da empresa A e NÃO enxerga os da B', prods.s === 200 && nomes.includes(`Produto Alfa ${SUF}`) && !nomes.includes(`Produto Beta ${SUF}`), prods.s);
check('lê outras listas da empresa (lojas, usuários, relatórios)', (await api('GET', '/locations', null, T1)).s === 200 && (await api('GET', '/users', null, T1)).s === 200);
const escritas = [
  await api('POST', '/products', { nome: 'x' }, T1),
  await api('PUT', `/products/${prodA}`, { nome: 'Alterado' }, T1),
  await api('POST', '/sales', {}, T1),
];
check('qualquer escrita -> 403 "somente leitura"', escritas.every((r) => r.s === 403 && /somente leitura/i.test(r.j.erro) && r.j.suporte === true), escritas.map((r) => r.s));
check('o produto não foi alterado', (await prod.query(`SELECT nome FROM products WHERE id = $1`, [prodA])).rows[0].nome === `Produto Alfa ${SUF}`);
check('painel Master indisponível no suporte (GET /master/empresas -> 403)', (await api('GET', '/master/empresas', null, T1)).s === 403);
const bloqueadoLeituraB = await api('GET', `/products/${prodB}`, null, T1);
check('GET de um produto da empresa B durante o suporte em A -> 404', bloqueadoLeituraB.s === 404, bloqueadoLeituraB.s);
check('sessão de outro usuário da empresa segue normal (isolamento)', (await api('GET', '/locations', null, A.token)).s === 200);
const usuariosA = JSON.stringify((await api('GET', '/users', null, A.token)).j);
check('usuários da empresa NÃO veem o Master na lista deles', !usuariosA.includes(EMAIL_MASTER) && !usuariosA.includes('E2E M4 Master'));

// ---------- 3. Avisos ----------
console.log('\n# 3. Aviso aos administradores');
const avA = await api('GET', '/avisos-empresa', null, A.token);
const textoAviso = avA.j.avisos && avA.j.avisos[0] && avA.j.avisos[0].mensagem;
check('administrador da empresa recebe o aviso com o motivo', avA.s === 200 && avA.j.avisos.length === 1 && /equipe de suporte da plataforma acessou sua conta em \d\d\/\d\d \d\d:\d\d/.test(textoAviso) && textoAviso.includes('Chamado 123'), textoAviso);
check('o aviso NÃO traz o nome pessoal do Master', !/E2E M4 Master|e2e\.m4\.master/i.test(JSON.stringify(avA.j)));
check('gerente (não administrador) não vê o aviso', (await api('GET', '/avisos-empresa', null, lgGer.j.token)).j.avisos.length === 0);
check('administrador de OUTRA empresa não vê', (await api('GET', '/avisos-empresa', null, Bm.token)).j.avisos.length === 0);
check('o Master em suporte não recebe o aviso dele mesmo', (await api('GET', '/avisos-empresa', null, T1)).j.avisos.length === 0);
const disp = await api('POST', `/avisos-empresa/${avA.j.avisos[0].id}/dispensar`, null, A.token);
check('administrador dispensa o aviso', disp.s === 204 && (await api('GET', '/avisos-empresa', null, A.token)).j.avisos.length === 0);

// ---------- 4. Encerrar manualmente ----------
console.log('\n# 4. Encerrar manualmente');
const enc = await api('POST', '/master/suporte/encerrar', null, T1);
check('encerrar devolve um token de Master puro', enc.s === 200 && enc.j.token && !decodificar(enc.j.token).suporte, enc);
const meMaster = await api('GET', '/auth/me', null, enc.j.token);
check('com o token novo o Master volta ao painel (master=true, sem suporte, área Master)', meMaster.s === 200 && meMaster.j.master === true && meMaster.j.suporte === null && meMaster.j.areas.Master === true, meMaster.j);
check('o token de suporte antigo deixa de valer (401)', (await api('GET', '/products', null, T1)).s === 401);
const sessao1 = (await prod.query(`SELECT encerrada_por, encerrada_em FROM sessoes_suporte WHERE id = $1`, [s1.j.sessao.id])).rows[0];
check('sessão consta como encerrada pelo "master"', sessao1.encerrada_por === 'master' && !!sessao1.encerrada_em, sessao1);
check('encerrar sem sessão de suporte -> 409', (await api('POST', '/master/suporte/encerrar', null, MAS)).s === 409);

// ---------- 5. Edicao liberada ----------
console.log('\n# 5. Edição liberada (cadastros sim; ações sensíveis nunca)');
const s2 = await iniciar(A.id, { edicao: true, avisar: false });
const T2 = s2.j.token;
check('iniciar com edição -> 201', s2.s === 201 && s2.j.sessao.edicao === true, s2);
const edit = await api('PUT', `/products/${prodA}`, { nome: `Produto Alfa ${SUF} (suporte)`, preco_venda: 3, categoria_id: (await prod.query(`SELECT categoria_id FROM products WHERE id = $1`, [prodA])).rows[0].categoria_id }, T2);
check('editar um produto funciona', edit.s === 200, edit);
const aud = (await prod.query(`SELECT usuario_id, tenant_id, detalhes FROM audit_logs WHERE recurso = 'products' AND recurso_id = $1 ORDER BY criado_em DESC LIMIT 1`, [prodA])).rows[0];
check('auditoria: autor = Master, empresa = A, marcada com suporte/sessão/master_id', aud && aud.usuario_id === master.id && aud.tenant_id === A.id && aud.detalhes.suporte === true && aud.detalhes.sessao_suporte_id === s2.j.sessao.id && aud.detalhes.master_id === master.id, aud);
const alvoUser = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [email('alfa')])).rows[0].id;
const uuid = crypto.randomUUID();
const sempre = [
  ['criar usuário', await api('POST', '/users', { nome: 'X', email: email('x'), senha: 'abcdef', perfil: 'Gerente' }, T2)],
  ['desativar usuário', await api('PATCH', `/users/${alvoUser}/status`, { ativo: false }, T2)],
  ['redefinir senha', await api('PATCH', `/users/${alvoUser}/password`, { senha: 'novaSenha1' }, T2)],
  ['alterar permissões', await api('PATCH', `/users/${alvoUser}`, { perfil: 'Gerente' }, T2)],
  ['resetar 2FA', await api('POST', `/users/${alvoUser}/2fa/resetar`, null, T2)],
  ['trocar a senha do Master', await api('POST', '/auth/change-password', { senha_atual: SENHA_MASTER, nova_senha: 'outraSenha1' }, T2)],
  ['desativar 2FA', await api('POST', '/auth/2fa/desativar', { senha: SENHA_MASTER, codigo: '123456' }, T2)],
  ['modo teste', await api('POST', '/auth/modo-teste', { ativo: true }, T2)],
  ['exportar dados', await api('POST', `/master/empresas/${A.id}/exportar`, null, T2)],
  ['gerar backup', await api('POST', '/master/backups', null, T2)],
  ['restaurar backup', await api('POST', `/master/backups/${uuid}/restaurar-teste`, { confirmacao: 'RESTAURAR' }, T2)],
  ['suspender empresa', await api('POST', `/master/empresas/${A.id}/suspender`, { motivo: 'tentativa de suspender pelo suporte' }, T2)],
  ['alterar plano', await api('PUT', '/master/planos/completo', { max_usuarios: 1 }, T2)],
  ['ler painel Master (GET)', await api('GET', '/master/usuarios', null, T2)],
  ['cancelar venda', await api('POST', `/sales/${uuid}/cancel`, {}, T2)],
  ['cancelar pedido', await api('POST', `/orders/${uuid}/cancel`, {}, T2)],
  ['excluir produto', await api('DELETE', `/products/${prodA}/ingredients/${uuid}`, null, T2)],
  ['vender no PDV', await api('POST', '/sales', {}, T2)],
];
check('ações sensíveis ficam bloqueadas (403) mesmo com edição: ' + sempre.map((x) => x[0]).join(', '), sempre.every(([, r]) => r.s === 403 && r.j.suporte === true), sempre.filter(([, r]) => r.s !== 403).map(([n, r]) => `${n}:${r.s}`));
check('a empresa e o Master continuam intactos após as tentativas', (await prod.query(`SELECT status FROM tenants WHERE id = $1`, [A.id])).rows[0].status === 'ativa' && Number((await prod.query(`SELECT max_usuarios FROM planos WHERE codigo = 'completo'`)).rows[0].max_usuarios) === 10 && (await prod.query(`SELECT ativo FROM users WHERE id = $1`, [alvoUser])).rows[0].ativo === true);
const usoEscrita = await api('POST', '/suppliers', { nome: `Fornecedor suporte ${SUF}`, documento: '07.526.557/0001-00', telefone: '11999999999', categoria: 'Outros' }, T2);
check('cadastros de apoio (fornecedor) podem ser criados com edição liberada', usoEscrita.s === 201, usoEscrita);

// ---------- 6. Expiracao ----------
console.log('\n# 6. Expiração (30 min, sem renovação)');
await prod.query(`UPDATE sessoes_suporte SET expira_em = now() - interval '1 second' WHERE id = $1`, [s2.j.sessao.id]);
const venc = await api('GET', '/products', null, T2);
const sessao2 = (await prod.query(`SELECT encerrada_por FROM sessoes_suporte WHERE id = $1`, [s2.j.sessao.id])).rows[0];
check('sessão vencida: próxima requisição -> 401 e consta "expirou"', venc.s === 401 && /encerrada/.test(venc.j.erro) && sessao2.encerrada_por === 'expirou', { s: venc.s, sessao2 });
check('não há renovação: nenhuma rota devolve token novo para a sessão vencida', (await api('POST', '/master/suporte/encerrar', null, T2)).s === 401);
// varredura marca vencidas mesmo sem requisição
const s3 = await iniciar(A.id);
await prod.query(`UPDATE sessoes_suporte SET expira_em = now() - interval '1 second' WHERE id = $1`, [s3.j.sessao.id]);
const varridas = await sv.encerrarVencidas();
check('a varredura periódica marca vencidas como "expirou" e audita', varridas >= 1 && (await prod.query(`SELECT 1 FROM audit_logs WHERE acao = 'master_suporte_expirar' AND recurso_id = $1`, [s3.j.sessao.id])).rows.length === 1);

// ---------- 7. Invalidacao ----------
console.log('\n# 7. Invalidação da sessão de suporte');
const s4 = await iniciar(A.id);
check('sessão aberta para o teste', s4.s === 201);
const hashAntigo = (await prod.query(`SELECT senha_hash FROM users WHERE id = $1`, [master.id])).rows[0].senha_hash;
const hashNovo = require('bcryptjs').hashSync(rnd(), 8);
await prod.query(`UPDATE users SET senha_hash = $1 WHERE id = $2`, [hashNovo, master.id]);
const trocou = await api('GET', '/products', null, s4.j.token);
check('trocar a senha do Master derruba o suporte (401, "sistema")', trocou.s === 401 && (await prod.query(`SELECT encerrada_por FROM sessoes_suporte WHERE id = $1`, [s4.j.sessao.id])).rows[0].encerrada_por === 'sistema', trocou);
await prod.query(`UPDATE users SET senha_hash = $1 WHERE id = $2`, [hashAntigo, master.id]);
const s5 = await iniciar(A.id);
await prod.query(`UPDATE users SET sessoes_validas_desde = now() + interval '5 seconds' WHERE id = $1`, [master.id]);
check('"encerrar sessões" do Master derruba o suporte (401)', (await api('GET', '/products', null, s5.j.token)).s === 401);
await new Promise((ok) => setTimeout(ok, 6500)); // passa o instante de "encerrar sessoes"
({ token: MAS, segredo } = await masterComSegredo(B, EMAIL_MASTER, SENHA_MASTER)); // "encerrar sessoes" derrubou o token antigo: o Master entra de novo
const s5b = await iniciar(A.id);
check('depois disso um novo suporte pode ser iniciado (linha antiga liberada)', s5b.s === 201, s5b);
await prod.query(`UPDATE users SET ativo = false WHERE id = $1`, [master.id]);
check('desativar o Master derruba o suporte (401)', (await api('GET', '/products', null, s5b.j.token)).s === 401);
await prod.query(`UPDATE users SET ativo = true WHERE id = $1`, [master.id]);
await fecharAbertas();
const s6 = await iniciar(A.id);
await api('POST', `/master/empresas/${A.id}/suspender`, { motivo: 'e2e: suspender durante o suporte' }, MAS);
const aposSusp = await api('GET', '/products', null, s6.j.token);
check('suspender a empresa durante o suporte encerra a sessão (401)', aposSusp.s === 401 && (await prod.query(`SELECT encerrada_por FROM sessoes_suporte WHERE id = $1`, [s6.j.sessao.id])).rows[0].encerrada_por === 'sistema', aposSusp);
await api('POST', `/master/empresas/${A.id}/reativar`, null, MAS);

// ---------- 8. Sem aviso / historico / auditoria ----------
console.log('\n# 8. Avisar desligado, histórico e auditoria global');
const avAntes = (await api('GET', '/avisos-empresa', null, Bm.token)).j.avisos.length;
const s7 = await iniciar(Bm.id, { avisar: false, motivo: 'Chamado 456: conferir cadastro da empresa Beta' });
check('com "avisar" desligado nenhum aviso é criado', s7.s === 201 && (await api('GET', '/avisos-empresa', null, Bm.token)).j.avisos.length === avAntes);
await api('POST', '/master/suporte/encerrar', null, s7.j.token);
const hist = await api('GET', `/master/empresas/${A.id}/suporte`, null, MAS);
const porMotivo = hist.j.sessoes.map((s) => ({ edicao: s.edicao, por: s.encerrada_por, avisou: s.avisou_admins }));
check('histórico da empresa lista as sessões (motivo, edição, início, fim, como encerrou, quem)', hist.s === 200 && hist.j.sessoes.length >= 5 && hist.j.sessoes.every((s) => s.motivo && s.iniciada_em && s.master_nome === 'E2E M4 Master') && porMotivo.some((x) => x.por === 'master') && porMotivo.some((x) => x.por === 'expirou') && porMotivo.some((x) => x.por === 'sistema') && porMotivo.some((x) => x.edicao === true), porMotivo);
const audSup = (await api('GET', `/master/auditoria?tipo=suporte&empresa_id=${A.id}`, null, MAS)).j;
const acoes = audSup.itens.map((i) => i.acao);
check('auditoria global (tipo "suporte") mostra início, fim e as escritas do suporte, com a empresa certa', ['master_suporte_iniciar', 'master_suporte_encerrar', 'master_suporte_expirar', 'editar'].every((a) => acoes.includes(a)) && audSup.itens.every((i) => i.empresa_nome === A.nome) && audSup.itens.find((i) => i.acao === 'editar').tipo === 'suporte', acoes);
check('o motivo e a sessão aparecem no início (auditado)', audSup.itens.some((i) => i.acao === 'master_suporte_iniciar' && i.detalhes.motivo.includes('Chamado 123') && i.detalhes.sessao_id));
const semSegredo = JSON.stringify(audSup);
check('nenhum JWT/segredo na auditoria do suporte', !/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(semSegredo) && !semSegredo.includes(SENHA_MASTER) && !semSegredo.includes(segredo));
check('administradores continuam entrando normalmente depois de tudo', (await login(A.email, A.senha)).s === 200 && (await login(Bm.email, Bm.senha)).s === 200);

// ---------- limpeza ----------
await fecharAbertas();
await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.m4.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E M4 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
