// e2e: "Dados da empresa" (e-mail, telefone, responsavel). npm run test:e2e:dados-empresa  (API em http://localhost:3000)
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
const EMAIL_M = 'e2e.de.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 300)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E DE Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);
async function empresa(rotulo) {
  const r = await api('POST', '/master/empresas', { nome: `E2E DE ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Loja', admin: { nome: `Admin ${rotulo}`, email: `e2e.de.${rotulo}.${SUF}@girostock.local` } }, MAS);
  const lg = await login(`e2e.de.${rotulo}.${SUF}@girostock.local`, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}
const A = await empresa('a');
const Bm = await empresa('b');
const loja = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1', [A.id])).rows[0].id;
const ger = await api('POST', '/master/usuarios', { empresa_id: A.id, nome: 'Gerente', email: `e2e.de.g.${SUF}@girostock.local`, perfil: 'Gerente', location_id: loja }, MAS);
const tokGer = (await login(`e2e.de.g.${SUF}@girostock.local`, ger.j.senha_temporaria)).j.token;

console.log('\n# Dados da empresa');
const vazio = await api('GET', '/empresa', null, A.token);
check('GET /empresa traz nome, documento e contato (vazio no começo)', vazio.s === 200 && vazio.j.id === A.id && vazio.j.email_contato === null && vazio.j.telefone === null, vazio);
const ok = await api('PUT', '/empresa', { email_contato: 'contato@exemplo.com.br', telefone: '(11) 99999-0000', responsavel: 'Maria da Silva' }, A.token);
check('administrador salva e-mail, telefone e responsável', ok.s === 200 && ok.j.responsavel === 'Maria da Silva' && ok.j.email_contato === 'contato@exemplo.com.br', ok);
check('valores persistem', (await api('GET', '/empresa', null, A.token)).j.telefone === '(11) 99999-0000');
check('e-mail inválido -> 400', (await api('PUT', '/empresa', { email_contato: 'nao-e-email' }, A.token)).s === 400);
check('telefone inválido -> 400', (await api('PUT', '/empresa', { telefone: 'abc' }, A.token)).s === 400 && (await api('PUT', '/empresa', { telefone: '123' }, A.token)).s === 400);
check('campo longo demais -> 400', (await api('PUT', '/empresa', { responsavel: 'x'.repeat(101) }, A.token)).s === 400);
const limpa = await api('PUT', '/empresa', { email_contato: '', telefone: '', responsavel: '' }, A.token);
check('campos vazios apagam os valores (NULL)', limpa.s === 200 && limpa.j.email_contato === null && limpa.j.responsavel === null, limpa);
await api('PUT', '/empresa', { email_contato: 'contato@exemplo.com.br', telefone: '(11) 99999-0000', responsavel: 'Maria da Silva' }, A.token);
check('gerente (sem Configurações) lê, mas não edita (403)', (await api('GET', '/empresa', null, tokGer)).s === 200 && (await api('PUT', '/empresa', { responsavel: 'Invasor' }, tokGer)).s === 403);
check('cada empresa vê só os próprios dados (B não vê os de A)', (await api('GET', '/empresa', null, Bm.token)).j.responsavel === null);
check('empresa B não consegue alterar a A (PUT só mexe na própria)', (await api('PUT', '/empresa', { responsavel: 'Joana' }, Bm.token)).s === 200 && (await api('GET', '/empresa', null, A.token)).j.responsavel === 'Maria da Silva');
const ficha = await api('GET', `/master/empresas/${A.id}?teste=1`, null, MAS);
check('Master vê o contato na ficha da empresa', ficha.s === 200 && ficha.j.contato.responsavel === 'Maria da Silva' && ficha.j.contato.telefone === '(11) 99999-0000', ficha.j && ficha.j.contato);
check('editar fica auditado (editar_dados_empresa)', (await prod.query(`SELECT 1 FROM audit_logs WHERE acao = 'editar_dados_empresa' AND tenant_id = $1`, [A.id])).rows.length >= 1);
check('o Master não edita dados de empresa por esta rota (sem empresa própria)', (await api('PUT', '/empresa', { responsavel: 'x' }, MAS)).s === 403);

await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.de.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E DE %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
