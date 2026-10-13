// Teste ponta a ponta de "Esqueci minha senha" (tela de login): so para contas com 2FA ativo, provado pelo codigo do app.
//   npm run test:e2e:redefinir-senha      (API em http://localhost:3000)
// Usa o Master e2e (e2e.rs.master@girostock.local) e uma empresa "E2E RS ..." sem 2FA; senhas aleatorias so em memoria.
import 'dotenv/config';
import { masterComSegredo, totpIndependente } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL = 'e2e.rs.master@girostock.local';
const SENHA = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 300)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL, MASTER_PASSWORD: SENHA, MASTER_NOME: 'E2E RS Master' }, encoding: 'utf8' });
const { token: MAS, segredo } = await masterComSegredo(B, EMAIL, SENHA);
const liberar = () => prod.query(`UPDATE users SET totp_ultimo_passo = NULL, totp_falhas = 0, totp_bloqueado_ate = NULL WHERE lower(email::text) = $1`, [EMAIL]);
const NOVA = rnd();

console.log('\n# Esqueci minha senha (2FA)');
check('campos faltando -> 400', (await api('POST', '/auth/redefinir-senha', { email: EMAIL })).s === 400);
check('senha curta -> 400', (await api('POST', '/auth/redefinir-senha', { email: EMAIL, codigo: '123456', nova_senha: '123' })).s === 400);
const inexistente = await api('POST', '/auth/redefinir-senha', { email: `nao.existe.${SUF}@girostock.local`, codigo: '123456', nova_senha: NOVA });
const errado = await api('POST', '/auth/redefinir-senha', { email: EMAIL, codigo: '000000', nova_senha: NOVA });
check('e-mail inexistente e código errado dão a MESMA resposta genérica (não revela nada)', inexistente.s === 400 && errado.s === 400 && inexistente.j.erro === errado.j.erro, { a: inexistente.j, b: errado.j });
check('a senha antiga continua valendo depois do código errado', (await api('POST', '/auth/login', { email: EMAIL, senha: SENHA })).s === 200);

await liberar();
const ok = await api('POST', '/auth/redefinir-senha', { email: EMAIL, codigo: totpIndependente(segredo), nova_senha: NOVA });
check('código certo -> 204', ok.s === 204, ok);
check('senha antiga deixa de valer (401)', (await api('POST', '/auth/login', { email: EMAIL, senha: SENHA })).s === 401);
const lg = await api('POST', '/auth/login', { email: EMAIL, senha: NOVA });
check('senha nova vale (segue para o passo do 2FA)', lg.s === 200 && lg.j.mfa === 'pendente', lg);
await new Promise((r) => setTimeout(r, 1200));
check('sessões abertas caem (token antigo -> 401)', (await api('GET', '/auth/me', null, MAS)).s === 401);
const reuso = await api('POST', '/auth/redefinir-senha', { email: EMAIL, codigo: totpIndependente(segredo), nova_senha: rnd() });
check('o mesmo código não vale duas vezes (400)', reuso.s === 400, reuso);
check('a redefinição ficou auditada (sem senha nem código)', (await prod.query(`SELECT detalhes::text AS d FROM audit_logs WHERE acao = 'redefinir_senha_2fa' ORDER BY criado_em DESC LIMIT 1`)).rows.every((r) => !r.d.includes(NOVA)));

// bloqueio: 5 erros seguidos bloqueiam por 15 min (429)
await liberar();
let ultimo;
for (let i = 0; i < 5; i++) ultimo = await api('POST', '/auth/redefinir-senha', { email: EMAIL, codigo: String(100000 + i), nova_senha: rnd() });
check('5 códigos errados seguidos bloqueiam (429)', ultimo.s === 429, ultimo);
await liberar();

// conta sem 2FA: resposta genérica, nada muda
const emp = await prod.query(`SELECT u.email FROM users u WHERE u.perfil = 'Administrador' AND NOT u.totp_ativo AND u.ativo LIMIT 1`);
if (emp.rows[0]) {
  const r = await api('POST', '/auth/redefinir-senha', { email: emp.rows[0].email, codigo: '123456', nova_senha: rnd() });
  check('conta SEM 2FA não redefine (400 genérico)', r.s === 400 && r.j.erro === errado.j.erro, r);
}

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) = $1`, [EMAIL]);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
