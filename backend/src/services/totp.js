// Verificacao em duas etapas: TOTP (RFC 6238, SHA-1, 6 digitos, 30 s), implementado so com o modulo `crypto`
// (roda no Node 14 do cPanel e no Node 20 do Docker). O QR e gerado aqui, no servidor, com o pacote `qrcode`.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIODO = 30;

// ---------- base32 ----------
function b32enc(buf) {
  let bits = '';
  let out = '';
  for (const x of buf) bits += x.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += ALFABETO[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32dec(s) {
  let bits = '';
  for (const c of String(s).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error('base32 inválido');
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

// ---------- HOTP / TOTP ----------
function hotp(chave, contador, digitos = 6) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', chave).update(b).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digitos).padStart(digitos, '0');
}
const passo = (t = Date.now() / 1000) => Math.floor(t / PERIODO);

function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Confere o codigo com tolerancia de +-1 passo (relogio), recusa passo <= ultimoPasso (mesmo codigo nao vale duas vezes)
// e devolve o passo aceito (ou null).
function verificar(segredoBase32, codigo, ultimoPasso = null, agora = Date.now() / 1000) {
  const c = String(codigo || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const chave = b32dec(segredoBase32);
  const atual = passo(agora);
  for (const delta of [0, -1, 1]) {
    const p = atual + delta;
    if (ultimoPasso !== null && ultimoPasso !== undefined && p <= Number(ultimoPasso)) continue;
    if (iguais(hotp(chave, p), c)) return p;
  }
  return null;
}

function gerarSegredo() {
  return b32enc(crypto.randomBytes(20)); // 160 bits
}

function uriOtpauth(email, segredoBase32) {
  const rotulo = `GiroStock:${encodeURIComponent(email)}`;
  return `otpauth://totp/${rotulo}?secret=${segredoBase32.replace(/=+$/, '')}&issuer=GiroStock&algorithm=SHA1&digits=6&period=${PERIODO}`;
}

function qrDataUrl(uri) {
  return QRCode.toDataURL(uri, { margin: 1, width: 240 });
}

// ---------- criptografia do segredo (AES-256-GCM) ----------
// Chave: TOTP_ENC_KEY (32 bytes em base64 ou 64 caracteres hexadecimais). Em producao, sem a variavel o 2FA fica
// indisponivel (nunca grava em texto puro). Fora de producao existe uma chave padrao so para desenvolvimento.
function chaveDeCifra() {
  const v = process.env.TOTP_ENC_KEY;
  if (v) {
    const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
    if (buf.length !== 32) return null;
    return buf;
  }
  if (process.env.NODE_ENV !== 'production') return crypto.createHash('sha256').update('girostock-chave-de-desenvolvimento-2fa').digest();
  return null;
}
const disponivel = () => chaveDeCifra() !== null;

function cifrar(texto) {
  const chave = chaveDeCifra();
  if (!chave) throw new Error('2FA indisponível: TOTP_ENC_KEY ausente ou inválida');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const enc = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}
function decifrar(valor) {
  const chave = chaveDeCifra();
  if (!chave) throw new Error('2FA indisponível: TOTP_ENC_KEY ausente ou inválida');
  const [iv, tag, enc] = String(valor).split(':').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', chave, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- codigos de recuperacao ----------
const LEGIVEL = 'abcdefghjkmnpqrstuvwxyz23456789';
function gerarCodigosRecuperacao(n = 10) {
  const codigos = [];
  const trecho = () => Array.from({ length: 5 }, () => LEGIVEL[crypto.randomInt(LEGIVEL.length)]).join('');
  while (codigos.length < n) codigos.push(`${trecho()}-${trecho()}`);
  return codigos;
}
const normalizarRecuperacao = (c) => String(c || '').toLowerCase().replace(/[\s-]/g, '');
const pareceRecuperacao = (c) => /^[a-z0-9]{10}$/.test(normalizarRecuperacao(c)) && !/^\d{6}$/.test(String(c).trim());
const hashRecuperacao = (c) => bcrypt.hash(normalizarRecuperacao(c), 8);

module.exports = {
  b32enc, b32dec, hotp, passo, verificar, gerarSegredo, uriOtpauth, qrDataUrl,
  disponivel, cifrar, decifrar,
  gerarCodigosRecuperacao, normalizarRecuperacao, pareceRecuperacao, hashRecuperacao,
};
