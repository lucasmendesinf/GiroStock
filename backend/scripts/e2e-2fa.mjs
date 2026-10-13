// Teste ponta a ponta do 2FA (TOTP / Google Authenticator).
//
// Uso (API rodando em http://localhost:3000, banco migrado ate a 019, DATABASE_URL_TESTE configurada):
//   npm run test:e2e:2fa        # API_URL padrao: http://localhost:3000
//
// Cria um Master e2e (script npm run master, senha aleatoria so em memoria) e uma empresa "E2E 2FA ..." com usuarios pela
// API do Master. Use somente em banco de DESENVOLVIMENTO. No fim a empresa fica suspensa e os usuarios e2e inativos.
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const totp = require('../src/services/totp.js');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const SENHA_MASTER = rnd();
const EMAIL_MASTER = 'e2e.2fa.master@girostock.local';
const email = (q) => `e2e.2fa.${q}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rota, body, tok) {
  try {
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j, texto: t };
  } catch (e) { return { s: 'CAIU', j: e.message, texto: '' }; }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
// Gerador TOTP INDEPENDENTE do servidor (outra implementacao: base32 por tabela de busca e HMAC por Buffer), so para conferir.
function totpIndependente(base32, delta = 0, agora = Date.now() / 1000) {
  const tabela = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'].map((c, i) => [c, i]));
  let acc = 0; let bits = 0; const bytes = [];
  for (const c of base32.toUpperCase().replace(/=+$/, '')) { acc = (acc << 5) | tabela.get(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); acc &= (1 << bits) - 1; } }
  const contador = Math.floor(agora / 30) + delta;
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(contador / 2 ** 32), 0); msg.writeUInt32BE(contador >>> 0, 4);
  const mac = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const off = mac[mac.length - 1] & 0xf;
  const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(num % 1000000).padStart(6, '0');
}
const liberaReuso = (userId) => prod.query(`UPDATE users SET totp_ultimo_passo = NULL WHERE id = $1`, [userId]);
const limpaBloqueio = (userId) => prod.query(`UPDATE users SET totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $1`, [userId]);

// ---------- 1. Nucleo TOTP ----------
console.log('\n# 1. Nucleo TOTP (RFC 6238) e base32');
const chaveRfc = Buffer.from('12345678901234567890');
const vetores = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
for (const [t, esperado] of vetores) check(`vetor RFC 6238 t=${t} -> ${esperado}`, totp.hotp(chaveRfc, totp.passo(t), 8) === esperado, totp.hotp(chaveRfc, totp.passo(t), 8));
const seg0 = totp.gerarSegredo();
check('base32 ida e volta', totp.b32dec(totp.b32enc(chaveRfc)).equals(chaveRfc) && totp.b32enc(totp.b32dec(seg0)) === seg0);
check('gerador independente concorda com o do servidor (6 digitos)', totpIndependente(seg0, 0, 1700000000) === totp.hotp(totp.b32dec(seg0), totp.passo(1700000000)));

// ---------- 2. Janela e reuso ----------
console.log('\n# 2. Janela de tolerancia e reuso');
const agora = 1700000000;
const p0 = totp.passo(agora);
const cod = (d) => totp.hotp(totp.b32dec(seg0), p0 + d);
check('codigo do passo atual aceito', totp.verificar(seg0, cod(0), null, agora) === p0);
check('codigo do passo anterior aceito (+-1)', totp.verificar(seg0, cod(-1), null, agora) === p0 - 1);
check('codigo do passo seguinte aceito (+-1)', totp.verificar(seg0, cod(1), null, agora) === p0 + 1);
check('dois passos de distancia recusados', totp.verificar(seg0, cod(2), null, agora) === null && totp.verificar(seg0, cod(-2), null, agora) === null);
check('mesmo codigo duas vezes recusado (passo <= ultimo)', totp.verificar(seg0, cod(0), p0, agora) === null);
check('codigo com letras/tamanho errado recusado', totp.verificar(seg0, '12345a', null, agora) === null && totp.verificar(seg0, '12345', null, agora) === null);

// ---------- preparo ----------
console.log('\n# preparo: Master e2e, empresa e usuarios');
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E 2FA Master' }, encoding: 'utf8' });
check('Master e2e criado por script', mk.status === 0, mk.stderr);
const masterId = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [EMAIL_MASTER])).rows[0].id;
// Master e2e pode estar com 2FA de uma execucao anterior: zera pelo script de emergencia (tambem testa o script).
const rs0 = spawnSync('node', ['scripts/resetar-2fa.js'], { cwd: raiz, env: { ...process.env, RESET_EMAIL: EMAIL_MASTER }, encoding: 'utf8' });
check('npm run resetar-2fa funciona (imprime so nome e e-mail)', rs0.status === 0 && /^2FA resetado para E2E 2FA Master <e2e\.2fa\.master@girostock\.local>/.test(rs0.stdout) && !/senha|segredo/i.test(rs0.stdout), rs0.stdout + rs0.stderr);

// ---------- 6a. Master e forcado a configurar ----------
console.log('\n# 6a. Master sem 2FA e forcado a configurar (e o token_mfa nao abre nada)');
const lgM = await login(EMAIL_MASTER, SENHA_MASTER);
check('login do Master devolve mfa=configurar e NAO devolve token completo', lgM.s === 200 && lgM.j.mfa === 'configurar' && lgM.j.token_mfa && !lgM.j.token, lgM.j);
const TMFA_M = lgM.j.token_mfa;
check('token_mfa(configurar) NAO abre rota de negocio nem do Master', (await api('GET', '/master/empresas', null, TMFA_M)).s === 401 && (await api('GET', '/products', null, TMFA_M)).s === 401 && (await api('GET', '/auth/me', null, TMFA_M)).s === 401);
check('token_mfa(configurar) nao serve em /2fa/verificar nem desativar', (await api('POST', '/auth/2fa/desativar', { senha: 'x', codigo: '000000' }, TMFA_M)).s === 401);
const prepM = await api('POST', '/auth/2fa/preparar', null, TMFA_M);
check('preparar com token_mfa(configurar) devolve QR (PNG), chave e URI', prepM.s === 200 && prepM.j.qr.startsWith('data:image/png;base64,') && /^[A-Z2-7]{32}$/.test(prepM.j.chave) && prepM.j.uri.startsWith('otpauth://totp/GiroStock:'), prepM.s);
const uri = new URL(prepM.j.uri);
check('URI no formato Google Authenticator (issuer, SHA1, 6 digitos, 30 s, segredo sem padding)', uri.searchParams.get('secret') === prepM.j.chave && uri.searchParams.get('issuer') === 'GiroStock' && uri.searchParams.get('algorithm') === 'SHA1' && uri.searchParams.get('digits') === '6' && uri.searchParams.get('period') === '30' && decodeURIComponent(uri.pathname).includes(EMAIL_MASTER), prepM.j.uri.replace(prepM.j.chave, '<chave>'));
const ativErr = await api('POST', '/auth/2fa/ativar', { codigo: '000000' }, TMFA_M);
check('ativar com codigo errado -> 400', ativErr.s === 400, ativErr);
// o codigo vem do GERADOR INDEPENDENTE (seccao 10): se o servidor aceita, o QR/URI produz o mesmo codigo de um app autenticador
const ativM = await api('POST', '/auth/2fa/ativar', { codigo: totpIndependente(prepM.j.chave) }, TMFA_M);
check('ativar com codigo do gerador independente: 200, 10 codigos de recuperacao e login concluido', ativM.s === 200 && ativM.j.codigos_recuperacao.length === 10 && ativM.j.token && ativM.j.usuario.doisFatores.ativo === true, ativM.s);
const TM = ativM.j.token;
const CHAVE_M = prepM.j.chave;
check('formato dos codigos de recuperacao (xxxxx-xxxxx) e todos diferentes', ativM.j.codigos_recuperacao.every((c) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(c)) && new Set(ativM.j.codigos_recuperacao).size === 10);
check('Master com token completo acessa o painel', (await api('GET', '/master/empresas', null, TM)).s === 200);
check('Master NAO consegue desativar o 2FA (403)', (await api('POST', '/auth/2fa/desativar', { senha: SENHA_MASTER, codigo: totpIndependente(CHAVE_M, 1) }, TM)).s === 403);

// empresa + usuarios pela API do Master
const emp = await api('POST', '/master/empresas', { nome: 'E2E 2FA Empresa ' + SUF, plano: 'completo', loja_nome: 'Loja 2FA', admin: { nome: 'Admin 2FA', email: email('adm'), senha: 'Temp' + SUF } }, TM);
check('Master cria empresa de teste', emp.s === 201, emp);
const EMP = emp.j.empresa;
const lojaId = (await prod.query(`SELECT id FROM locations WHERE tenant_id = $1`, [EMP.id])).rows[0].id;
const SENHA_G = rnd();
const g = await api('POST', '/master/usuarios', { empresa_id: EMP.id, nome: 'Gerente 2FA', email: email('ger'), perfil: 'Gerente', location_id: lojaId, senha: SENHA_G }, TM);
check('Master cria usuario comum (Gerente)', g.s === 201, g);
const gId = g.j.usuario.id;
const ADM = (await login(email('adm'), 'Temp' + SUF)).j.token;
check('Administrador da empresa entra normalmente (sem 2FA)', !!ADM);

// ---------- 3. Fluxo completo com usuario comum ----------
console.log('\n# 3. Fluxo completo com usuario comum');
const lgG0 = await login(email('ger'), SENHA_G);
check('usuario sem 2FA: login inalterado (token + usuario, sem mfa)', lgG0.s === 200 && lgG0.j.token && !lgG0.j.mfa && lgG0.j.usuario.doisFatores.ativo === false && lgG0.j.usuario.doisFatores.exigido === false, lgG0.j);
let TG = lgG0.j.token;
const prepG = await api('POST', '/auth/2fa/preparar', null, TG);
check('preparar (token completo) devolve QR e chave', prepG.s === 200 && prepG.j.chave && prepG.j.qr, prepG.s);
const prepG2 = await api('POST', '/auth/2fa/preparar', null, TG);
check('preparar de novo gera outra chave enquanto nao ativado', prepG2.s === 200 && prepG2.j.chave !== prepG.j.chave);
const CHAVE_G = prepG2.j.chave;
const ativG = await api('POST', '/auth/2fa/ativar', { codigo: totpIndependente(CHAVE_G) }, TG);
check('ativar -> 200 com 10 codigos de recuperacao (so desta vez)', ativG.s === 200 && ativG.j.codigos_recuperacao.length === 10, ativG.s);
let CODIGOS_G = ativG.j.codigos_recuperacao;
check('preparar/ativar com 2FA ja ativo -> 409', (await api('POST', '/auth/2fa/preparar', null, TG)).s === 409 && (await api('POST', '/auth/2fa/ativar', { codigo: totpIndependente(CHAVE_G) }, TG)).s === 409);
const meG = await api('GET', '/auth/me', null, TG);
check('/auth/me: doisFatores ativo, 10 codigos restantes, sem segredo', meG.j.doisFatores.ativo === true && meG.j.doisFatores.codigosRestantes === 10 && !meG.texto.includes(CHAVE_G) && !JSON.stringify(meG.j).match(/segredo|totp_/), meG.j.doisFatores);

const lg2 = await login(email('ger'), SENHA_G);
check('depois de ativar, o login pede o codigo (mfa=pendente, SEM token completo)', lg2.s === 200 && lg2.j.mfa === 'pendente' && lg2.j.token_mfa && !lg2.j.token && !lg2.j.usuario, lg2.j);
const TP = lg2.j.token_mfa;
check('token_mfa(pendente) NAO abre rotas de negocio (401)', (await api('GET', '/products', null, TP)).s === 401 && (await api('GET', '/users', null, TP)).s === 401 && (await api('GET', '/auth/me', null, TP)).s === 401);
check('token_mfa(pendente) nao serve em preparar/ativar (401)', (await api('POST', '/auth/2fa/preparar', null, TP)).s === 401);
await liberaReuso(gId);
const ok1 = await api('POST', '/auth/2fa/verificar', { token_mfa: TP, codigo: totpIndependente(CHAVE_G) });
check('codigo correto: entra (token + usuario)', ok1.s === 200 && ok1.j.token && ok1.j.usuario.email === email('ger'), ok1.s);
check('token completo do 2o passo abre as rotas', (await api('GET', '/auth/me', null, ok1.j.token)).s === 200);
const reuso = await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: totpIndependente(CHAVE_G) });
check('o MESMO codigo nao vale duas vezes (400)', reuso.s === 400, reuso);
await limpaBloqueio(gId);
const erros = [];
for (let i = 0; i < 5; i++) erros.push((await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: '000000' })).s);
check('4 erros -> 400 e a 5a -> 429 (bloqueio)', erros.slice(0, 4).every((s) => s === 400) && erros[4] === 429, erros);
await liberaReuso(gId);
const durante = await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: totpIndependente(CHAVE_G, 1) });
check('durante o bloqueio ate o codigo correto -> 429', durante.s === 429 && /tente novamente em/i.test(durante.j.erro), durante);
const blq = (await prod.query(`SELECT totp_bloqueado_ate FROM users WHERE id = $1`, [gId])).rows[0].totp_bloqueado_ate;
check('bloqueio de ~15 minutos gravado', blq && (new Date(blq) - new Date()) > 13 * 60000 && (new Date(blq) - new Date()) <= 15 * 60000 + 5000, blq);
await limpaBloqueio(gId);
check('erro generico (nao revela se a senha/codigo...)', /código inválido/.test((await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: '111111' })).j.erro));
check('token_mfa invalido/expirado -> 401', (await api('POST', '/auth/2fa/verificar', { token_mfa: 'abc', codigo: '123456' })).s === 401);
check('token completo NAO serve como token_mfa (401)', (await api('POST', '/auth/2fa/verificar', { token_mfa: ok1.j.token, codigo: '123456' })).s === 401);

// ---------- 5. Codigos de recuperacao ----------
console.log('\n# 5. Codigos de recuperacao');
await limpaBloqueio(gId);
const rec1 = await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: CODIGOS_G[0] });
check('codigo de recuperacao entra (e avisa quantos restam)', rec1.s === 200 && rec1.j.token && rec1.j.usuario.doisFatores.codigosRestantes === 9 && /9/.test(rec1.j.aviso), rec1.j.aviso);
const rec2 = await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: CODIGOS_G[0] });
check('o mesmo codigo de recuperacao NAO vale duas vezes (400)', rec2.s === 400, rec2);
await limpaBloqueio(gId);
check('codigo de recuperacao digitado sem hifen/maiusculo tambem vale', (await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: CODIGOS_G[1].replace('-', '').toUpperCase() })).s === 200);
const meRec = await api('GET', '/auth/me', null, rec1.j.token);
check('restantes diminuem (8)', meRec.j.doisFatores.codigosRestantes === 8, meRec.j.doisFatores);
await liberaReuso(gId);
const novos = await api('POST', '/auth/2fa/codigos-recuperacao', { senha: SENHA_G, codigo: totpIndependente(CHAVE_G) }, rec1.j.token);
check('gerar novos codigos (senha + codigo atual) -> 10 novos', novos.s === 200 && novos.j.codigos_recuperacao.length === 10, novos.s);
await limpaBloqueio(gId);
const velho = await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: CODIGOS_G[2] });
check('codigo do conjunto antigo deixa de valer', velho.s === 400, velho);
check('senha errada ao gerar novos codigos -> 400', (await api('POST', '/auth/2fa/codigos-recuperacao', { senha: 'errada', codigo: totpIndependente(CHAVE_G, 1) }, rec1.j.token)).s === 400);
CODIGOS_G = novos.j.codigos_recuperacao;

// ---------- 6b. Desativar / reset / exigido ----------
console.log('\n# 6b. Desativar, resetar e exigir');
await liberaReuso(gId); await limpaBloqueio(gId);
const TGo = (await api('POST', '/auth/2fa/verificar', { token_mfa: (await login(email('ger'), SENHA_G)).j.token_mfa, codigo: totpIndependente(CHAVE_G, 1) })).j.token;
check('desativar sem senha/codigo -> 400', (await api('POST', '/auth/2fa/desativar', {}, TGo)).s === 400);
await liberaReuso(gId);
const des = await api('POST', '/auth/2fa/desativar', { senha: SENHA_G, codigo: totpIndependente(CHAVE_G) }, TGo);
check('usuario comum desativa com senha + codigo (200)', des.s === 200 && des.j.ativo === false, des);
const lgSem = await login(email('ger'), SENHA_G);
check('sem 2FA o login volta ao normal', lgSem.s === 200 && lgSem.j.token && !lgSem.j.mfa);
check('desativar apagou codigos de recuperacao', Number((await prod.query(`SELECT count(*) AS n FROM user_recovery_codes WHERE user_id = $1`, [gId])).rows[0].n) === 0);

const exig = await api('PATCH', `/users/${gId}`, { totp_exigido: true }, ADM);
check('Administrador da empresa exige 2FA do usuario', exig.s === 200, exig);
const lgEx = await login(email('ger'), SENHA_G);
check('usuario com 2FA exigido e sem ativar -> mfa=configurar', lgEx.j.mfa === 'configurar' && !lgEx.j.token, lgEx.j);
const prepEx = await api('POST', '/auth/2fa/preparar', null, lgEx.j.token_mfa);
const ativEx = await api('POST', '/auth/2fa/ativar', { codigo: totpIndependente(prepEx.j.chave) }, lgEx.j.token_mfa);
check('ele ativa pelo fluxo forcado e ja sai logado', ativEx.s === 200 && ativEx.j.token && ativEx.j.codigos_recuperacao.length === 10, ativEx.s);
await liberaReuso(gId);
check('exigido nao consegue desativar (403)', (await api('POST', '/auth/2fa/desativar', { senha: SENHA_G, codigo: totpIndependente(prepEx.j.chave) }, ativEx.j.token)).s === 403);
check('lista de usuarios mostra 2FA ativo/exigido', (await api('GET', '/users', null, ADM)).j.find((u) => u.id === gId).totp_ativo === true);

const rAdm = await api('POST', `/users/${gId}/2fa/resetar`, null, ADM);
check('Administrador reseta o 2FA de usuario da propria empresa', rAdm.s === 200 && (await prod.query(`SELECT totp_ativo, totp_segredo_cript FROM users WHERE id = $1`, [gId])).rows[0].totp_ativo === false);
check('Administrador NAO reseta o Master (403)', (await api('POST', `/users/${masterId}/2fa/resetar`, null, ADM)).s === 403);
check('Administrador NAO reseta usuario de outra empresa (404)', (await api('POST', `/users/${(await prod.query(`SELECT id FROM users WHERE tenant_id <> $1 AND perfil = 'Administrador' LIMIT 1`, [EMP.id])).rows[0].id}/2fa/resetar`, null, ADM)).s === 404);
check('sem token a rota de reset responde 401', (await api('POST', `/users/${gId}/2fa/resetar`, null, (await login(email('ger'), SENHA_G)).j.token_mfa ? null : null)).s === 401);
// Master reseta qualquer um
const lgEx2 = await login(email('ger'), SENHA_G);
const prepEx2 = await api('POST', '/auth/2fa/preparar', null, lgEx2.j.token_mfa);
await api('POST', '/auth/2fa/ativar', { codigo: totpIndependente(prepEx2.j.chave) }, lgEx2.j.token_mfa);
const rMas = await api('POST', `/master/usuarios/${gId}/2fa/resetar`, null, TM);
check('Master reseta o 2FA de qualquer usuario', rMas.s === 200 && (await prod.query(`SELECT totp_ativo FROM users WHERE id = $1`, [gId])).rows[0].totp_ativo === false);
await api('PATCH', `/users/${gId}`, { totp_exigido: false }, ADM);

// ---------- 7. Segredo cifrado, sem vazamento, auditoria ----------
console.log('\n# 7. Segredo cifrado e auditoria sem conteudo sensivel');
const linhaM = (await prod.query(`SELECT totp_segredo_cript, totp_ativo FROM users WHERE id = $1`, [masterId])).rows[0];
check('segredo no banco esta cifrado (iv:tag:cifrado em base64), nunca o base32 puro', linhaM.totp_ativo && linhaM.totp_segredo_cript.split(':').length === 3 && !linhaM.totp_segredo_cript.includes(CHAVE_M) && totp.decifrar(linhaM.totp_segredo_cript) === CHAVE_M, linhaM.totp_segredo_cript && linhaM.totp_segredo_cript.slice(0, 20));
const hashes = (await prod.query(`SELECT codigo_hash FROM user_recovery_codes WHERE user_id = $1`, [masterId])).rows;
check('codigos de recuperacao guardados so como hash (bcrypt)', hashes.length === 10 && hashes.every((h) => h.codigo_hash.startsWith('$2')) && ativM.j.codigos_recuperacao.every((c) => !hashes.some((h) => h.codigo_hash.includes(c.replace('-', '')))));
const aud = await prod.query(`SELECT acao, detalhes FROM audit_logs WHERE acao IN ('ativar_2fa','desativar_2fa','resetar_2fa','login_codigo_recuperacao','bloquear_2fa','gerar_codigos_recuperacao_2fa','exigir_2fa') AND (usuario_id IN ($1, $2) OR recurso_id = $2)`, [masterId, gId]);
const acoes = new Set(aud.rows.map((r) => r.acao));
check('auditoria registra ativar, desativar, resetar, uso de codigo de recuperacao, bloqueio e novos codigos', ['ativar_2fa', 'desativar_2fa', 'resetar_2fa', 'login_codigo_recuperacao', 'bloquear_2fa', 'gerar_codigos_recuperacao_2fa'].every((a) => acoes.has(a)), [...acoes]);
const todo = JSON.stringify(aud.rows) + JSON.stringify((await prod.query(`SELECT detalhes FROM audit_logs ORDER BY criado_em DESC LIMIT 400`)).rows);
const segredosConhecidos = [CHAVE_M, CHAVE_G, prepG.j.chave, ...ativM.j.codigos_recuperacao, ...CODIGOS_G];
check('auditoria nao contem segredos nem codigos de recuperacao', segredosConhecidos.every((s) => !todo.includes(s)));
const respostasPublicas = [JSON.stringify((await api('GET', '/auth/me', null, TM)).j), JSON.stringify((await api('GET', '/users', null, ADM)).j), JSON.stringify((await api('GET', '/master/usuarios', null, TM)).j)].join('');
check('/auth/me, /users e /master/usuarios nao vazam segredo/codigos', !/segredo_cript|codigo_hash|codigos_recuperacao/.test(respostasPublicas) && !respostasPublicas.includes(CHAVE_M));

// ---------- 8. Copia producao -> teste ----------
console.log('\n# 8. Copia producao -> teste nao leva segredos');
const cp = await api('POST', '/master/modo-teste/copiar-producao', { confirmacao: 'COPIAR', anonimizar: true }, TM);
check('Master copia a producao para o teste', cp.s === 200, cp);
const teste = new pg.Client({ connectionString: process.env.DATABASE_URL_TESTE });
await teste.connect();
const tSeg = (await teste.query(`SELECT count(*)::int AS n FROM users WHERE totp_segredo_cript IS NOT NULL OR totp_ativo OR totp_ultimo_passo IS NOT NULL`)).rows[0].n;
const tRec = (await teste.query(`SELECT count(*)::int AS n FROM user_recovery_codes`)).rows[0].n;
const pRec = (await prod.query(`SELECT count(*)::int AS n FROM user_recovery_codes`)).rows[0].n;
check('banco de teste: nenhum segredo TOTP, nenhum usuario com 2FA ativo, zero codigos de recuperacao', tSeg === 0 && tRec === 0 && pRec > 0, { tSeg, tRec, pRec });
const mt = await api('POST', '/auth/modo-teste', { ativo: true, empresa_id: EMP.id }, TM);
check('Master liga o modo teste e o usuario no teste fica sem 2FA', mt.s === 200 && (await teste.query(`SELECT totp_segredo_cript FROM users WHERE id = $1`, [masterId])).rows[0].totp_segredo_cript === null, mt.s);
await api('POST', '/auth/modo-teste', { ativo: false }, mt.j.token);
await teste.end();

// ---------- 9. Regressao ----------
console.log('\n# 9. Regressao');
const lgReg = await login(email('ger'), SENHA_G);
check('login de usuario SEM 2FA continua igual', lgReg.s === 200 && lgReg.j.token && !lgReg.j.mfa);
const novaSenha = rnd();
check('troca de senha continua funcionando', (await api('POST', '/auth/change-password', { senha_atual: SENHA_G, nova_senha: novaSenha }, lgReg.j.token)).s === 204 && (await login(email('ger'), novaSenha)).s === 200);
check('Master volta a exigir o codigo ao logar de novo', (await login(EMAIL_MASTER, SENHA_MASTER)).j.mfa === 'pendente');
// script de emergencia para o Master
const rs1 = spawnSync('node', ['scripts/resetar-2fa.js'], { cwd: raiz, env: { ...process.env, RESET_EMAIL: EMAIL_MASTER }, encoding: 'utf8' });
const lgM2 = await login(EMAIL_MASTER, SENHA_MASTER);
check('script resetar-2fa zera o Master: proximo login pede para configurar de novo', rs1.status === 0 && lgM2.j.mfa === 'configurar', { out: rs1.stdout, mfa: lgM2.j.mfa });
check('script sem RESET_EMAIL falha com mensagem', spawnSync('node', ['scripts/resetar-2fa.js'], { cwd: raiz, env: { ...process.env, RESET_EMAIL: '' }, encoding: 'utf8' }).status !== 0);

// ---------- limpeza ----------
await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.2fa.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E 2FA %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
