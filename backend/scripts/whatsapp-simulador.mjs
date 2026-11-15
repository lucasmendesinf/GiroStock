// Simulador da API do WhatsApp (Meta Graph API) para testes: troca do code pelo token, dados do numero, assinatura do app,
// modelos de mensagem (criados como PENDING; aprovados na primeira consulta, a nao ser que /__sim/modelos diga outra coisa),
// envio de mensagens (telefone terminado em 0000 = falha) e webhook assinado de entregue/lida.
// node scripts/whatsapp-simulador.mjs   (porta SIM_PORTA ou 4994; SIM_WEBHOOK = endereco do webhook do GiroStock;
// SIM_APP_SECRET = segredo do app, igual ao WHATSAPP_APP_SECRET do servidor)
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const { criarSimulador } = createRequire(import.meta.url)('../src/integracoes/simulados/whatsapp.js');
const PORTA = Number(process.env.SIM_PORTA || 4994);
const WEBHOOK = process.env.SIM_WEBHOOK || 'http://localhost:3000/api/webhooks/whatsapp';
const SEGREDO = process.env.SIM_APP_SECRET || 'segredo-simulador';

async function webhook(value) {
  const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...value } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', SEGREDO).update(corpo).digest('hex')}`;
  try { return await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: corpo }); } catch { return { ok: false, status: 0 }; }
}
const sim = criarSimulador({ aoStatus: (statuses) => webhook({ statuses }) });

async function corpoDe(req) { const p = []; for await (const c of req) p.push(c); const t = Buffer.concat(p).toString(); try { return t ? JSON.parse(t) : {}; } catch { return {}; } }
const enviar = (res, status, corpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(corpo)); };

http.createServer(async (req, res) => {
  const b = await corpoDe(req);
  // cliente responde no WhatsApp: { from, texto, phone_number_id }
  if (req.url === '/__sim/receber' && req.method === 'POST') {
    const r = await webhook({
      metadata: { phone_number_id: String(b.phone_number_id) }, contacts: [{ wa_id: b.from, profile: { name: 'Cliente' } }],
      messages: [{ from: b.from, id: `wamid.IN${crypto.randomBytes(6).toString('hex')}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: b.texto } }],
    });
    return enviar(res, 200, { ok: r.ok, status: r.status });
  }
  const r = await sim.atender(req.method, req.url, req.headers, b);
  enviar(res, r.status, r.corpo);
}).listen(PORTA, () => console.log(`simulador WhatsApp na porta ${PORTA}`));
