// Simulador da API do WhatsApp (Meta Graph API) reutilizavel: o script scripts/whatsapp-simulador.mjs (testes automaticos)
// e o MODO TESTE do GiroStock (WhatsApp de mentira dentro do servidor: as mensagens nao saem, ficam numa lista).
// Troca do code pelo token, dados do numero, assinatura do app, modelos (criados PENDING e aprovados na primeira consulta,
// a nao ser que forcarStatus diga outra coisa), envio de modelo e de texto (telefone terminado em 0000 = falha).
// aoStatus(statuses) recebe os status de entrega (sent/delivered/read), como o webhook da Meta.
'use strict';
const crypto = require('crypto');

function criarSimulador(opcoes = {}) {
  const aoStatus = opcoes.aoStatus || (() => {});
  const modelos = new Map(); // waba -> Map(nome -> { status, categoria, rodape, texto })
  let statusForcado = null;
  const enviadas = [];
  const numeros = new Map(); // phone_number_id -> { display, nome }

  const responder = (status, corpo) => ({ status, corpo });
  const erro = (status, message, code = 100) => responder(status, { error: { message, type: 'OAuthException', code } });
  function modeloPorNome(nome) { for (const m of modelos.values()) if (m.has(nome)) return m.get(nome); return null; }
  const agenda = (ms, statuses) => { const t = setTimeout(() => { Promise.resolve(aoStatus(statuses)).catch(() => {}); }, ms); if (t.unref) t.unref(); };

  async function atender(metodo, endereco, headers = {}, b = {}) {
    const url = new URL(endereco, 'http://simulador-whatsapp.local');
    const partes = url.pathname.split('/').filter(Boolean); // [versao, ...]
    const auth = headers.authorization || '';
    if (url.pathname === '/__sim/modelos' && metodo === 'POST') { statusForcado = b.status || null; return responder(200, { ok: true, status: statusForcado }); }
    if (url.pathname === '/__sim/mensagens') return responder(200, { enviadas });
    if (url.pathname === '/__sim/limpar') { enviadas.length = 0; modelos.clear(); statusForcado = null; return responder(200, { ok: true }); }
    if (partes[1] === 'oauth' && partes[2] === 'access_token') {
      const code = url.searchParams.get('code');
      if (!code || code === 'invalido') return erro(400, 'Invalid verification code format.');
      if (!url.searchParams.get('client_secret')) return erro(400, 'Missing client secret');
      return responder(200, { access_token: `EAASIM${crypto.randomBytes(8).toString('hex')}`, token_type: 'bearer' });
    }
    if (!/^Bearer EAASIM/.test(auth)) return erro(401, 'Invalid OAuth access token.', 190);
    const [, id, recurso] = partes;
    if (!recurso && metodo === 'GET') {
      const n = numeros.get(id) || { display: opcoes.numero || '+55 41 99520-9684', nome: opcoes.nome || 'J&A Conveniência' };
      return responder(200, { id, display_phone_number: n.display, verified_name: n.nome });
    }
    if (recurso === 'subscribed_apps') return responder(200, { success: true });
    if (recurso === 'message_templates') {
      if (!modelos.has(id)) modelos.set(id, new Map());
      const m = modelos.get(id);
      if (metodo === 'POST') {
        const corpo = (b.components || []).find((c) => c.type === 'BODY');
        const txt = corpo && corpo.text;
        if (!b.name || !['UTILITY', 'MARKETING'].includes(b.category) || !txt) return erro(400, 'Invalid parameter');
        const rodape = (b.components || []).find((c) => c.type === 'FOOTER');
        if (rodape && (!rodape.text || rodape.text.length > 60)) return erro(400, 'Invalid footer');
        if (/^\{\{|\}\}$/.test(txt.trim())) return erro(400, 'Template cannot start or end with a variable');
        if (m.has(b.name)) return erro(400, `Content in this language already exists for ${b.name}`, 100);
        m.set(b.name, { status: 'PENDING', categoria: b.category, rodape: rodape ? rodape.text : null, texto: txt });
        return responder(200, { id: crypto.randomUUID(), status: 'PENDING', category: b.category });
      }
      for (const v of m.values()) v.status = statusForcado || 'APPROVED';
      return responder(200, { data: [...m.entries()].map(([name, v]) => ({ name, status: v.status, language: 'pt_BR' })) });
    }
    if (recurso === 'messages' && metodo === 'POST') {
      if (b.messaging_product !== 'whatsapp' || !['template', 'text'].includes(b.type) || !b.to) return erro(400, 'Invalid parameter');
      const wamid = `wamid.SIM${crypto.randomBytes(10).toString('hex')}`;
      if (b.type === 'text') {
        if (!b.text || !b.text.body) return erro(400, 'Invalid parameter');
        enviadas.push({ wamid, de: id, to: b.to, texto: b.text.body, em: new Date().toISOString() });
        return responder(200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: wamid }] });
      }
      if (/0000$/.test(b.to)) return erro(400, '(#131026) Message undeliverable', 131026);
      const mod = modeloPorNome(b.template.name) || {};
      const params = ((b.template.components || [])[0] || {}).parameters.map((p) => p.text);
      const texto = mod.texto ? mod.texto.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '') : null;
      enviadas.push({ wamid, de: id, to: b.to, modelo: b.template.name, categoria: mod.categoria, params, texto, rodape: mod.rodape || null, em: new Date().toISOString() });
      agenda(opcoes.atrasoMs || 150, [{ id: wamid, status: 'sent', recipient_id: b.to }]);
      agenda((opcoes.atrasoMs || 150) * 2, [{ id: wamid, status: 'delivered', recipient_id: b.to }]);
      if (/1111$/.test(b.to) || opcoes.lerTudo) agenda((opcoes.atrasoMs || 150) * 3, [{ id: wamid, status: 'read', recipient_id: b.to }]);
      return responder(200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: wamid }] });
    }
    return erro(404, `Unknown path ${url.pathname}`);
  }

  return { atender, enviadas, modelos, numeros };
}

module.exports = { criarSimulador };
