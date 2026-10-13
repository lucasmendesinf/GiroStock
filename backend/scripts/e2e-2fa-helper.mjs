// Apoio dos testes e2e: o Master agora exige 2FA, entao os scripts precisam completar a configuracao dele.
// Faz o reset de emergencia (npm run resetar-2fa) e refaz o fluxo "configurar": login -> preparar -> ativar.
// O gerador TOTP aqui e independente do servidor (tabela base32 + HMAC por Buffer), so para os testes.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function totpIndependente(base32, delta = 0, agora = Date.now() / 1000) {
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

async function chamar(base, method, rota, body, tok) {
  const res = await fetch(base + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: res.status, j: await res.json().catch(() => null) };
}

// Devolve o token completo do Master (e2e), com o 2FA configurado do zero. Nunca imprime senha nem chave.
export async function tokenDoMasterComDoisFatores(base, emailMaster, senhaMaster) {
  const rs = spawnSync('node', ['scripts/resetar-2fa.js'], { cwd: raiz, env: { ...process.env, RESET_EMAIL: emailMaster }, encoding: 'utf8' });
  if (rs.status !== 0) throw new Error('resetar-2fa falhou: ' + rs.stderr);
  const lg = await chamar(base, 'POST', '/auth/login', { email: emailMaster, senha: senhaMaster });
  if (lg.j && lg.j.token) return lg.j.token;
  if (!lg.j || lg.j.mfa !== 'configurar') throw new Error('login do Master inesperado: ' + lg.s);
  const prep = await chamar(base, 'POST', '/auth/2fa/preparar', null, lg.j.token_mfa);
  const ativ = await chamar(base, 'POST', '/auth/2fa/ativar', { codigo: totpIndependente(prep.j.chave) }, lg.j.token_mfa);
  if (!ativ.j || !ativ.j.token) throw new Error('nao foi possivel ativar o 2FA do Master e2e: ' + ativ.s);
  return ativ.j.token;
}

// Como tokenDoMasterComDoisFatores, mas devolve tambem o segredo TOTP (so em memoria, para o teste gerar codigos).
export async function masterComSegredo(base, emailMaster, senhaMaster) {
  const rs = spawnSync('node', ['scripts/resetar-2fa.js'], { cwd: raiz, env: { ...process.env, RESET_EMAIL: emailMaster }, encoding: 'utf8' });
  if (rs.status !== 0) throw new Error('resetar-2fa falhou: ' + rs.stderr);
  const lg = await chamar(base, 'POST', '/auth/login', { email: emailMaster, senha: senhaMaster });
  if (!lg.j || lg.j.mfa !== 'configurar') throw new Error('login do Master inesperado: ' + lg.s);
  const prep = await chamar(base, 'POST', '/auth/2fa/preparar', null, lg.j.token_mfa);
  const ativ = await chamar(base, 'POST', '/auth/2fa/ativar', { codigo: totpIndependente(prep.j.chave) }, lg.j.token_mfa);
  if (!ativ.j || !ativ.j.token) throw new Error('nao foi possivel ativar o 2FA do Master e2e: ' + ativ.s);
  return { token: ativ.j.token, segredo: prep.j.chave };
}
