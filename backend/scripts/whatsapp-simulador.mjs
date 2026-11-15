// Simulador da API do WhatsApp (Meta Graph API) para testes: troca do code pelo token, dados do numero, assinatura do app,
// modelos de mensagem (criados como PENDING; aprovados na primeira consulta, a nao ser que /__sim/modelos diga outra coisa),
// envio de mensagens (telefone terminado em 0000 = falha) e webhook assinado de entregue/lida.
// node scripts/whatsapp-simulador.mjs   (porta SIM_PORTA ou 4994; SIM_WEBHOOK = endereco do webhook do GiroStock;
// SIM_APP_SECRET = segredo do app, igual ao WHATSAPP_APP_SECRET do servidor)
import http from 'node:http';
import crypto from 'node:crypto';

const PORTA = Number(process.env.SIM_PORTA || 4994);
const WEBHOOK = process.env.SIM_WEBHOOK || 'http://localhost:3000/api/webhooks/whatsapp';
const SEGREDO = process.env.SIM_APP_SECRET || 'segredo-simulador';
const modelos = new Map(); // waba -> Map(nome -> {status})
let statusForcado = null; // null = aprova; 'PENDING' | 'REJECTED'
const enviadas = [];
let assinados = 0;

function modelosPorNome(nome) { for (const m of modelos.values()) if (m.has(nome)) return m.get(nome); return null; }
function responder(res, status, corpo) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(corpo)); }
const erro = (res, status, message, code = 100) => responder(res, status, { error: { message, type: 'OAuthException', code } });
async function corpoDe(req) { const p = []; for await (const c of req) p.push(c); const t = Buffer.concat(p).toString(); try { return t ? JSON.parse(t) : {}; } catch { return {}; } }

async function webhook(statuses) {
  const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', SEGREDO).update(corpo).digest('hex')}`;
  try { await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: corpo }); } catch { /* servidor fora */ }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const partes = url.pathname.split('/').filter(Boolean); // [versao, ...]
  const auth = req.headers.authorization || '';
  if (url.pathname === '/__sim/modelos' && req.method === 'POST') { statusForcado = (await corpoDe(req)).status || null; return responder(res, 200, { ok: true, status: statusForcado }); }
  if (url.pathname === '/__sim/mensagens') return responder(res, 200, { enviadas, assinados });
  // cliente responde no WhatsApp: { from, texto, phone_number_id }
  if (url.pathname === '/__sim/receber' && req.method === 'POST') {
    const b = await corpoDe(req);
    const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: String(b.phone_number_id) },
      contacts: [{ wa_id: b.from, profile: { name: 'Cliente' } }],
      messages: [{ from: b.from, id: `wamid.IN${crypto.randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: b.texto } }],
    } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', SEGREDO).update(corpo).digest('hex')}`;
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: corpo });
    return responder(res, 200, { ok: r.ok, status: r.status });
  }
  if (url.pathname === '/__sim/limpar') { enviadas.length = 0; modelos.clear(); statusForcado = null; return responder(res, 200, { ok: true }); }
  if (partes[1] === 'oauth' && partes[2] === 'access_token') {
    const code = url.searchParams.get('code');
    if (!code || code === 'invalido') return erro(res, 400, 'Invalid verification code format.');
    if (!url.searchParams.get('client_secret')) return erro(res, 400, 'Missing client secret');
    return responder(res, 200, { access_token: `EAASIM${crypto.randomBytes(8).toString('hex')}`, token_type: 'bearer' });
  }
  if (!/^Bearer EAASIM/.test(auth)) return erro(res, 401, 'Invalid OAuth access token.', 190);
  const [, id, recurso] = partes;
  if (!recurso && req.method === 'GET') return responder(res, 200, { id, display_phone_number: '+55 41 99520-9684', verified_name: 'J&A Conveniência' });
  if (recurso === 'subscribed_apps') return responder(res, 200, { success: true });
  if (recurso === 'message_templates') {
    if (!modelos.has(id)) modelos.set(id, new Map());
    const m = modelos.get(id);
    if (req.method === 'POST') {
      const b = await corpoDe(req);
      const txt = (b.components || [])[0] && b.components[0].text;
      if (!b.name || !['UTILITY', 'MARKETING'].includes(b.category) || !txt) return erro(res, 400, 'Invalid parameter');
      const rodape = (b.components || []).find((c) => c.type === 'FOOTER');
      if (rodape && (!rodape.text || rodape.text.length > 60)) return erro(res, 400, 'Invalid footer');
      if (/^\{\{|\}\}$/.test(txt.trim())) return erro(res, 400, 'Template cannot start or end with a variable');
      if (m.has(b.name)) return erro(res, 400, `Content in this language already exists for ${b.name}`, 100);
      m.set(b.name, { status: 'PENDING', categoria: b.category, rodape: rodape ? rodape.text : null });
      return responder(res, 200, { id: crypto.randomUUID(), status: 'PENDING', category: b.category });
    }
    for (const v of m.values()) v.status = statusForcado || 'APPROVED';
    return responder(res, 200, { data: [...m.entries()].map(([name, v]) => ({ name, status: v.status, language: 'pt_BR' })) });
  }
  if (recurso === 'messages' && req.method === 'POST') {
    const b = await corpoDe(req);
    if (b.messaging_product !== 'whatsapp' || !['template', 'text'].includes(b.type) || !b.to) return erro(res, 400, 'Invalid parameter');
    if (b.type === 'text') {
      if (!b.text || !b.text.body) return erro(res, 400, 'Invalid parameter');
      const wamid = `wamid.SIM${crypto.randomBytes(10).toString('hex')}`;
      enviadas.push({ wamid, to: b.to, texto: b.text.body });
      return responder(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: wamid }] });
    }
    if (/0000$/.test(b.to)) return erro(res, 400, '(#131026) Message undeliverable', 131026);
    const wamid = `wamid.SIM${crypto.randomBytes(10).toString('hex')}`;
    enviadas.push({ wamid, to: b.to, modelo: b.template.name, categoria: (modelosPorNome(b.template.name) || {}).categoria, params: ((b.template.components || [])[0] || {}).parameters.map((p) => p.text) });
    setTimeout(() => webhook([{ id: wamid, status: 'sent', recipient_id: b.to }]), 150);
    setTimeout(() => webhook([{ id: wamid, status: 'delivered', recipient_id: b.to }]), 300);
    if (/1111$/.test(b.to)) setTimeout(() => webhook([{ id: wamid, status: 'read', recipient_id: b.to }]), 450);
    return responder(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: wamid }] });
  }
  return erro(res, 404, `Unknown path ${url.pathname}`);
}).listen(PORTA, () => console.log(`simulador WhatsApp na porta ${PORTA}`));
