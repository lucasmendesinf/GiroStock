// WhatsApp (API oficial da Meta: WhatsApp Cloud API), etapa 1.
// - Conexao: a empresa clica em "Conectar WhatsApp" (cadastro incorporado da Meta: login no Facebook, escolhe a empresa e o
//   numero; com a coexistencia, le um QR Code no WhatsApp Business do celular e o numero continua funcionando la).
//   O navegador devolve um "code" + ids da conta (WABA) e do numero; aqui o code vira o token de acesso da empresa.
// - Modelos de mensagem (categoria utilidade, pt_BR) criados na conta da empresa ao conectar; a Meta aprova em minutos.
// - Avisos do pedido: a varredura le o historico de status dos pedidos (order_status_log) e manda o modelo da etapa
//   (recebido, em preparo, pronto para retirada, saiu para entrega, entregue, cancelado). Cada mudanca avisa uma vez so.
// - Webhook: a Meta informa entregue/lida/falhou de cada mensagem (assinatura X-Hub-Signature-256 com o segredo do app).
// Configuracao (servidor): WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, WHATSAPP_CONFIG_ID (configuracao do cadastro incorporado),
// WHATSAPP_VERIFY_TOKEN (verificacao do webhook). Testes: WHATSAPP_SIMULADOR=1 e WHATSAPP_GRAPH_URL (simulador local).
const crypto = require('crypto');
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { cifrar, decifrar } = require('../services/totp');
const { dadosDaEmpresa, efetivos } = require('../utils/limites');
const { requisicao } = require('./http');
const { logAudit } = require('../utils/audit');

const GRAPH = () => (process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '');
const VERSAO = () => process.env.WHATSAPP_GRAPH_VERSAO || 'v23.0';
const meta = () => ({
  appId: process.env.WHATSAPP_APP_ID || '', appSecret: process.env.WHATSAPP_APP_SECRET || '', configId: process.env.WHATSAPP_CONFIG_ID || '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
});
const simulador = () => process.env.WHATSAPP_SIMULADOR === '1';
const disponivel = () => { const m = meta(); return !!(m.appId && m.appSecret && m.configId); };

const brl = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

// Modelos (templates) de utilidade. Regras da Meta: nao comecar nem terminar com variavel; exemplo para cada variavel.
const MODELOS = [
  { evento: 'recebido', nome: 'girostock_pedido_recebido', titulo: 'Pedido recebido',
    texto: 'Olá, {{1}}! Recebemos o seu pedido nº {{2}} na {{3}}. Total: {{4}}. Vamos avisar por aqui cada etapa do pedido.',
    exemplo: ['Maria', '123', 'J&A Conveniência', 'R$ 45,90'], params: (p) => [p.nome, p.numero, p.loja, brl(p.total)] },
  { evento: 'em_preparo', nome: 'girostock_pedido_em_preparo', titulo: 'Em preparo',
    texto: 'Olá, {{1}}! O seu pedido nº {{2}} na {{3}} já está em preparo.',
    exemplo: ['Maria', '123', 'J&A Conveniência'], params: (p) => [p.nome, p.numero, p.loja] },
  { evento: 'pronto_retirada', nome: 'girostock_pedido_pronto_retirada', titulo: 'Pronto para retirar',
    texto: 'Olá, {{1}}! O seu pedido nº {{2}} está pronto para retirada na {{3}}. Até já!',
    exemplo: ['Maria', '123', 'J&A Conveniência'], params: (p) => [p.nome, p.numero, p.loja] },
  { evento: 'saiu_entrega', nome: 'girostock_pedido_saiu_entrega', titulo: 'Saiu para entrega',
    texto: 'Olá, {{1}}! O seu pedido nº {{2}} da {{3}} saiu para entrega com {{4}}. Logo chega aí.',
    exemplo: ['Maria', '123', 'J&A Conveniência', 'João'], params: (p) => [p.nome, p.numero, p.loja, p.entregador || 'o nosso entregador'] },
  { evento: 'entregue', nome: 'girostock_pedido_entregue', titulo: 'Entregue',
    texto: 'Olá, {{1}}! O seu pedido nº {{2}} da {{3}} foi entregue. Obrigado pela preferência!',
    exemplo: ['Maria', '123', 'J&A Conveniência'], params: (p) => [p.nome, p.numero, p.loja] },
  { evento: 'cancelado', nome: 'girostock_pedido_cancelado', titulo: 'Cancelado',
    texto: 'Olá, {{1}}. O seu pedido nº {{2}} na {{3}} foi cancelado. Se tiver alguma dúvida, é só responder esta mensagem.',
    exemplo: ['Maria', '123', 'J&A Conveniência'], params: (p) => [p.nome, p.numero, p.loja] },
];
const MODELO_DO_EVENTO = Object.fromEntries(MODELOS.map((m) => [m.evento, m]));

// Modelos de MARKETING (campanhas com cupom). A Meta cobra mais caro e exige consentimento do cliente; o rodape
// avisa como sair (quem responde SAIR perde o consentimento automaticamente: receberWebhook).
const RODAPE_MARKETING = 'Responda SAIR para não receber mais ofertas.';
const MODELOS_MARKETING = [
  { chave: 'volta', nome: 'girostock_cupom_volta', titulo: 'Volte com cupom', cupom: true,
    texto: 'Oi, {{1}}! Sentimos sua falta na {{2}}. Para você voltar, preparamos um cupom de {{3}}: use o código {{4}} até {{5}} no nosso cardápio online.',
    exemplo: ['Maria', 'J&A Conveniência', '10% de desconto', 'VOLTA-7K2QX', '30/11'] },
  { chave: 'aniversario', nome: 'girostock_cupom_aniversario', titulo: 'Aniversário com cupom', cupom: true,
    texto: 'Feliz aniversário, {{1}}! A {{2}} preparou um presente para você: cupom de {{3}} com o código {{4}}, válido até {{5}}. Aproveite!',
    exemplo: ['Maria', 'J&A Conveniência', '15% de desconto', 'NIVER-7K2QX', '30/11'] },
  { chave: 'oferta_cupom', nome: 'girostock_oferta_cupom', titulo: 'Oferta com cupom', cupom: true, oferta: true,
    texto: 'Oi, {{1}}! A {{2}} tem uma oferta para você: {{3}}. Use o cupom {{4}} até {{5}} no nosso cardápio online.',
    exemplo: ['Maria', 'J&A Conveniência', 'X-Tudo + refri com 20% de desconto', 'OFERTA-7K2QX', '30/11'] },
  { chave: 'oferta', nome: 'girostock_oferta', titulo: 'Oferta sem cupom', cupom: false, oferta: true,
    texto: 'Oi, {{1}}! Novidade na {{2}}: {{3}}. Peça pelo nosso cardápio online.',
    exemplo: ['Maria', 'J&A Conveniência', 'chegou o novo X-Bacon duplo'] },
].map((m) => ({ ...m, categoria: 'MARKETING', rodape: RODAPE_MARKETING }));
const TODOS_MODELOS = [...MODELOS.map((m) => ({ ...m, categoria: 'UTILITY' })), ...MODELOS_MARKETING];
const EVENTOS = MODELOS.map((m) => m.evento);

// Telefone do cliente no formato da API (55 + DDD + numero). null se nao der para usar.
function telefoneWhatsapp(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return d;
}

// ---------- Graph API ----------
async function graph(metodo, caminho, { token, json, query } = {}) {
  const q = query ? `?${new URLSearchParams(query).toString()}` : '';
  let r;
  try {
    r = await requisicao(metodo, `${GRAPH()}/${VERSAO()}${caminho}${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, json, timeoutMs: 20000 });
  } catch (err) {
    throw new HttpError(502, `sem resposta da Meta (WhatsApp): ${err.message}`);
  }
  if (r.status >= 400 || (r.corpo && r.corpo.error)) {
    const e = (r.corpo && r.corpo.error) || {};
    const erro = new HttpError(r.status >= 500 ? 502 : 422, `Meta: ${e.error_user_msg || e.message || `erro ${r.status}`}`);
    erro.meta = e;
    throw erro;
  }
  return r.corpo || {};
}

async function contaDa(db, tenantId) {
  return (await db.query(`SELECT * FROM whatsapp_contas WHERE tenant_id = $1`, [tenantId])).rows[0] || null;
}

function publica(c) {
  const m = meta();
  const base = { meta: { disponivel: disponivel(), simulador: simulador(), app_id: m.appId || null, config_id: m.configId || null, versao: VERSAO() } };
  if (!c || c.status === 'desconectado') return { ...base, conectado: false, avisos: c ? c.avisos : null };
  return {
    ...base, conectado: c.status === 'conectado', status: c.status, numero: c.numero_exibicao, nome: c.nome_verificado, coexistencia: c.coexistencia,
    avisos: c.avisos, ultimo_erro: c.ultimo_erro, conectado_em: c.conectado_em,
    modelos: MODELOS.map((x) => ({ evento: x.evento, nome: x.nome, titulo: x.titulo, texto: x.texto, status: (c.modelos || {})[x.nome] || 'NAO_CRIADO' })),
  };
}

// Cria os modelos na conta da empresa (os que ja existem sao mantidos) e le a situacao de cada um.
async function criarModelos(c, token, lista = TODOS_MODELOS) {
  for (const m of lista) {
    try {
      const components = [{ type: 'BODY', text: m.texto, example: { body_text: [m.exemplo] } }];
      if (m.rodape) components.push({ type: 'FOOTER', text: m.rodape });
      await graph('POST', `/${c.waba_id}/message_templates`, {
        token,
        json: { name: m.nome, language: 'pt_BR', category: m.categoria, components },
      });
    } catch (err) {
      if (!/exist|já existe|duplicate/i.test(err.message)) throw err;
    }
  }
}
async function conferirModelos(tenantId) {
  const c = await contaDa(pool, tenantId);
  if (!c || c.status === 'desconectado') return null;
  const token = decifrar(c.token_cript);
  const r = await graph('GET', `/${c.waba_id}/message_templates`, { token, query: { fields: 'name,status,language', limit: '200' } });
  const st = {};
  for (const t of r.data || []) if (t.language === 'pt_BR' && TODOS_MODELOS.some((m) => m.nome === t.name)) st[t.name] = t.status;
  await pool.query(`UPDATE whatsapp_contas SET modelos = $2, modelos_conferidos_em = now(), atualizado_em = now() WHERE tenant_id = $1`, [tenantId, JSON.stringify(st)]);
  return st;
}

// Conexao pelo cadastro incorporado: { code, waba_id, phone_number_id, coexistencia }
async function conectar(user, b) {
  const code = String(b.code || '').trim();
  const waba = String(b.waba_id || '').replace(/\D/g, '');
  const phone = String(b.phone_number_id || '').replace(/\D/g, '');
  if (!code || !waba || !phone) throw new HttpError(400, 'conexão incompleta: refaça o "Conectar WhatsApp" até o fim');
  if (!disponivel() && !simulador()) throw new HttpError(409, 'a integração com a Meta ainda não foi configurada no servidor');
  const m = meta();
  const tk = await graph('GET', '/oauth/access_token', { query: { client_id: m.appId, client_secret: m.appSecret, code } });
  const token = tk.access_token;
  if (!token) throw new HttpError(422, 'a Meta não devolveu o acesso: refaça a conexão');
  const num = await graph('GET', `/${phone}`, { token, query: { fields: 'display_phone_number,verified_name' } });
  await graph('POST', `/${waba}/subscribed_apps`, { token });
  const outra = (await pool.query(`SELECT tenant_id FROM whatsapp_contas WHERE phone_number_id = $1 AND status = 'conectado' AND tenant_id <> $2`, [phone, user.tenantId])).rows[0];
  if (outra) throw new HttpError(409, 'este número já está conectado em outra empresa');
  await pool.query(
    `INSERT INTO whatsapp_contas (tenant_id, status, waba_id, phone_number_id, numero_exibicao, nome_verificado, coexistencia, token_cript, conectado_em, conectado_por, ultimo_erro)
     VALUES ($1, 'conectado', $2, $3, $4, $5, $6, $7, now(), $8, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET status = 'conectado', waba_id = $2, phone_number_id = $3, numero_exibicao = $4, nome_verificado = $5,
       coexistencia = $6, token_cript = $7, conectado_em = now(), conectado_por = $8, ultimo_erro = NULL, modelos = '{}', atualizado_em = now()`,
    [user.tenantId, waba, phone, num.display_phone_number || null, num.verified_name || null, b.coexistencia !== false, cifrar(token), user.id]
  );
  const c = await contaDa(pool, user.tenantId);
  try {
    await criarModelos(c, token);
    await conferirModelos(user.tenantId);
  } catch (err) {
    await pool.query(`UPDATE whatsapp_contas SET ultimo_erro = $2 WHERE tenant_id = $1`, [user.tenantId, `modelos de mensagem: ${err.message}`]);
  }
  return publica(await contaDa(pool, user.tenantId));
}

// Conta conectada antes das campanhas: cria os modelos de marketing que faltam.
async function garantirModelosMarketing(tenantId) {
  const c = await contaDa(pool, tenantId);
  if (!c || c.status !== 'conectado') return;
  const faltam = MODELOS_MARKETING.filter((m) => !(c.modelos || {})[m.nome]);
  if (faltam.length === 0) return;
  try {
    await criarModelos(c, decifrar(c.token_cript), faltam);
    await conferirModelos(tenantId);
  } catch (err) {
    await pool.query(`UPDATE whatsapp_contas SET ultimo_erro = $2 WHERE tenant_id = $1`, [tenantId, `modelos de marketing: ${err.message}`]);
  }
}

async function desconectar(user) {
  const c = await contaDa(pool, user.tenantId);
  if (!c || c.status === 'desconectado') return publica(c);
  try { await graph('DELETE', `/${c.waba_id}/subscribed_apps`, { token: decifrar(c.token_cript) }); } catch { /* segue desconectando aqui */ }
  await pool.query(`UPDATE whatsapp_contas SET status = 'desconectado', atualizado_em = now() WHERE tenant_id = $1`, [user.tenantId]);
  return publica(await contaDa(pool, user.tenantId));
}

async function salvarAvisos(user, avisos) {
  const c = await contaDa(pool, user.tenantId);
  if (!c) throw new HttpError(409, 'conecte o WhatsApp primeiro');
  const novo = { ...c.avisos };
  for (const ev of EVENTOS) if (avisos && typeof avisos[ev] === 'boolean') novo[ev] = avisos[ev];
  await pool.query(`UPDATE whatsapp_contas SET avisos = $2, atualizado_em = now() WHERE tenant_id = $1`, [user.tenantId, JSON.stringify(novo)]);
  return publica(await contaDa(pool, user.tenantId));
}

// Envia um modelo. Devolve { wamid } ou lanca HttpError (com .meta).
async function enviarModelo(c, telefone, modelo, params) {
  const r = await graph('POST', `/${c.phone_number_id}/messages`, {
    token: decifrar(c.token_cript),
    json: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: telefone, type: 'template',
      template: { name: modelo.nome, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 200) })) }] },
    },
  });
  return { wamid: r.messages && r.messages[0] ? r.messages[0].id : null };
}

async function registrar(tenantId, dados) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_mensagens (tenant_id, order_id, log_id, evento, telefone, modelo, wamid, situacao, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (log_id) WHERE log_id IS NOT NULL DO NOTHING RETURNING id`,
    [tenantId, dados.order_id || null, dados.log_id || null, dados.evento, dados.telefone || '', dados.modelo || null, dados.wamid || null, dados.situacao, dados.motivo || null]
  );
  return rows[0] ? rows[0].id : null;
}

// Erro de token (expirado/revogado): a conexao fica "erro" ate reconectar.
async function marcarErroConta(tenantId, err) {
  // so o codigo 190 (token invalido/expirado/revogado); a Meta usa o tipo OAuthException em quase todos os erros
  if (err.meta && Number(err.meta.code) === 190) {
    await pool.query(`UPDATE whatsapp_contas SET status = 'erro', ultimo_erro = $2, atualizado_em = now() WHERE tenant_id = $1`, [tenantId, `acesso à Meta expirado ou revogado: reconecte o WhatsApp (${err.message})`]);
  }
}

async function enviarTeste(user, telefone) {
  const c = await contaDa(pool, user.tenantId);
  if (!c || c.status !== 'conectado') throw new HttpError(409, 'conecte o WhatsApp primeiro');
  const tel = telefoneWhatsapp(telefone);
  if (!tel) throw new HttpError(400, 'telefone inválido: use DDD + número (ex.: 41 99999-9999)');
  const m = MODELO_DO_EVENTO.recebido;
  if ((c.modelos || {})[m.nome] !== 'APPROVED') throw new HttpError(409, 'o modelo "Pedido recebido" ainda não foi aprovado pela Meta: aguarde alguns minutos e clique em "Atualizar modelos"');
  try {
    const r = await enviarModelo(c, tel, m, m.exemplo);
    await registrar(user.tenantId, { evento: 'teste', telefone: tel, modelo: m.nome, wamid: r.wamid, situacao: 'enviada' });
    return { ok: true, telefone: tel, wamid: r.wamid };
  } catch (err) {
    await registrar(user.tenantId, { evento: 'teste', telefone: tel, modelo: m.nome, situacao: 'falhou', motivo: err.message });
    await marcarErroConta(user.tenantId, err);
    throw err;
  }
}

// ---------- avisos do pedido (varredura) ----------
function eventoDoStatus(para, o) {
  if (para === 'novo') return 'recebido';
  if (para === 'em_preparo') return 'em_preparo';
  if (para === 'pronto') return o.tipo === 'retirada' ? 'pronto_retirada' : null;
  if (para === 'saiu_entrega') return 'saiu_entrega';
  if (para === 'finalizado') return o.tipo === 'entrega' ? 'entregue' : null;
  if (para === 'cancelado') return 'cancelado';
  return null;
}

const moduloCache = new Map();
async function moduloLigado(tenantId) {
  const c = moduloCache.get(tenantId);
  if (c && Date.now() - c.em < 60000) return c.ok;
  let ok = false;
  try { const e = await dadosDaEmpresa(pool, tenantId); ok = !!(e && efetivos(e).recursos.whatsapp); } catch { ok = false; }
  moduloCache.set(tenantId, { ok, em: Date.now() });
  return ok;
}

async function processar(l) {
  const ignorar = (motivo, evento = l.evento || 'recebido') => registrar(l.tenant_id, { order_id: l.order_id, log_id: l.log_id, evento, telefone: l.cliente_telefone, situacao: 'ignorada', motivo });
  if (!(await moduloLigado(l.tenant_id))) return ignorar('módulo WhatsApp desligado');
  const evento = eventoDoStatus(l.para, l);
  if (!evento) return ignorar('etapa sem aviso', l.para);
  if (l.origem === 'ifood' || l.origem === '99food') return ignorar('pedido de plataforma (a própria plataforma avisa o cliente)', evento);
  if (l.comanda_id || l.tipo === 'mesa') return ignorar('pedido de mesa/comanda', evento);
  // pago no site: "recebido" so depois do pagamento aprovado (ate la, a varredura tenta de novo)
  if (evento === 'recebido' && l.pagamento_online && l.pagamento_status !== 'aprovado') {
    if (l.status_atual === 'cancelado' || Date.now() - new Date(l.criado_em).getTime() > 2 * 3600e3) return ignorar('pagamento não aprovado', evento);
    return null;
  }
  if (!(l.avisos || {})[evento]) return ignorar('aviso desligado na configuração', evento);
  const tel = telefoneWhatsapp(l.cliente_telefone);
  if (!tel) return ignorar('pedido sem celular do cliente', evento);
  if (evento === 'cancelado') {
    const antes = (await pool.query(`SELECT 1 FROM whatsapp_mensagens WHERE order_id = $1 AND situacao IN ('enviada', 'entregue', 'lida') AND evento <> 'cancelado' LIMIT 1`, [l.order_id])).rows.length;
    if (!antes) return ignorar('cliente não tinha recebido aviso deste pedido', evento);
  }
  const modelo = MODELO_DO_EVENTO[evento];
  if ((l.modelos || {})[modelo.nome] !== 'APPROVED') return ignorar('modelo de mensagem ainda não aprovado pela Meta', evento);
  // reserva o aviso (cada mudanca de status avisa uma vez so) e envia
  const id = await registrar(l.tenant_id, { order_id: l.order_id, log_id: l.log_id, evento, telefone: tel, modelo: modelo.nome, situacao: 'enviada', motivo: 'enviando' });
  if (!id) return null;
  const primeiroNome = String(l.cliente_nome || '').trim().split(/\s+/)[0] || 'cliente';
  try {
    const r = await enviarModelo(l, tel, modelo, modelo.params({ nome: primeiroNome, numero: l.numero, loja: l.loja_nome, total: l.total, entregador: l.entregador_nome }));
    await pool.query(`UPDATE whatsapp_mensagens SET wamid = $2, motivo = NULL, atualizado_em = now() WHERE id = $1`, [id, r.wamid]);
  } catch (err) {
    await pool.query(`UPDATE whatsapp_mensagens SET situacao = 'falhou', motivo = $2, atualizado_em = now() WHERE id = $1`, [id, String(err.message).slice(0, 500)]);
    await marcarErroConta(l.tenant_id, err);
  }
  return id;
}

let varrendo = false;
async function varrer() {
  if (varrendo) return;
  varrendo = true;
  try {
    // modelos ainda em analise: confere a cada 10 min
    const pend = (await pool.query(
      `SELECT tenant_id FROM whatsapp_contas WHERE status = 'conectado' AND (modelos_conferidos_em IS NULL OR modelos_conferidos_em < now() - interval '10 minutes')
         AND EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN modelos = '{}'::jsonb THEN '{"x":"PENDING"}'::jsonb ELSE modelos END) m WHERE m.value <> 'APPROVED')`
    )).rows;
    for (const p of pend) { try { await conferirModelos(p.tenant_id); } catch { /* tenta depois */ } }
    const { rows } = await pool.query(
      `SELECT l.id AS log_id, l.para, l.criado_em, o.id AS order_id, o.tenant_id, o.numero, o.origem, o.tipo, o.comanda_id, o.status AS status_atual,
              o.cliente_nome, o.cliente_telefone, o.pagamento_online, o.pagamento_status, loc.nome AS loja_nome,
              COALESCE(cr.nome, (SELECT 'o entregador do iFood' FROM entregas_ifood ei WHERE ei.order_id = o.id AND ei.status NOT IN ('cancelada', 'falhou') LIMIT 1)) AS entregador_nome,
              COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega - o.desconto - COALESCE(o.desconto_pix, 0) AS total,
              w.phone_number_id, w.token_cript, w.avisos, w.modelos
       FROM order_status_log l JOIN orders o ON o.id = l.order_id JOIN locations loc ON loc.id = o.location_id
       JOIN whatsapp_contas w ON w.tenant_id = o.tenant_id AND w.status = 'conectado'
       LEFT JOIN couriers cr ON cr.id = o.entregador_id
       WHERE l.criado_em >= w.conectado_em AND l.criado_em > now() - interval '3 hours'
         AND NOT EXISTS (SELECT 1 FROM whatsapp_mensagens m WHERE m.log_id = l.id)
       ORDER BY l.criado_em LIMIT 50`
    );
    for (const l of rows) {
      try { await processar({ ...l, total: Number(l.total) }); } catch (err) { console.error('whatsapp aviso', err.message); }
    }
  } finally {
    varrendo = false;
  }
}
function iniciarVarredura() {
  const seg = Number(process.env.WHATSAPP_VARREDURA_SEGUNDOS) || 10;
  const t = setInterval(() => { varrer().catch(() => {}); }, seg * 1000);
  if (t.unref) t.unref();
}

// ---------- webhook ----------
function assinaturaValida(bruto, assinatura) {
  const segredo = meta().appSecret;
  if (!segredo || !assinatura || !/^sha256=/.test(assinatura)) return false;
  const esperado = `sha256=${crypto.createHmac('sha256', segredo).update(bruto).digest('hex')}`;
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(assinatura));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ORDEM = { enviada: 1, entregue: 2, lida: 3 };

// "SAIR" (ou parar/pare/stop/cancelar/descadastrar, ou o botao de parar promocoes): o cliente deixa de receber campanhas.
// Os avisos do pedido continuam (sao mensagens de servico, nao de oferta).
const PEDIDO_SAIR = /^(sair|parar|pare|stop|cancelar|descadastrar|parar promo[cç][oõ]es|n[aã]o quero (mais )?receber)[.!]*$/i;
// Telefone do cliente comparado pelo DDD + 8 ultimos digitos (a Meta pode devolver o celular brasileiro sem o 9).
function chaveTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return null;
  return `${d.slice(0, 2)}:${d.slice(-8)}`;
}
async function descadastrar(phoneNumberId, de) {
  const c = phoneNumberId ? (await pool.query(`SELECT * FROM whatsapp_contas WHERE phone_number_id = $1 AND status = 'conectado'`, [String(phoneNumberId)])).rows[0] : null;
  if (!c) return { removidos: 0 };
  const chave = chaveTelefone(de);
  if (!chave) return { removidos: 0 };
  const fim8 = chave.slice(3);
  const cand = (await pool.query(`SELECT id, telefone FROM customers WHERE tenant_id = $1 AND right(regexp_replace(COALESCE(telefone, ''), '[^0-9]', '', 'g'), 8) = $2`, [c.tenant_id, fim8])).rows
    .filter((x) => chaveTelefone(x.telefone) === chave);
  const ids = cand.map((x) => x.id);
  if (ids.length) {
    await pool.query(
      `UPDATE customers SET aceita_mensagens = false, consentimento_em = now(), consentimento_origem = 'WhatsApp: respondeu SAIR' WHERE id = ANY($1::uuid[])`, [ids]
    );
    await pool.query(`UPDATE lv_contas SET aceita_mensagens = false WHERE tenant_id = $1 AND customer_id = ANY($2::uuid[])`, [c.tenant_id, ids]);
    // o que ainda estava na fila de campanha para este cliente nao sai mais
    await pool.query(`UPDATE whatsapp_mensagens SET situacao = 'ignorada', motivo = 'cliente pediu para sair', atualizado_em = now() WHERE customer_id = ANY($1::uuid[]) AND situacao = 'na_fila'`, [ids]);
  }
  await logAudit(pool, { tenantId: c.tenant_id, usuarioId: null, acao: 'whatsapp_cliente_saiu', recurso: 'customers', recursoId: null, detalhes: { clientes: ids.length } }).catch(() => {});
  // confirma para o cliente (dentro da janela de 24 h aberta pela mensagem dele: texto livre, sem modelo)
  try {
    const nome = c.nome_verificado || 'loja';
    const r = await graph('POST', `/${c.phone_number_id}/messages`, {
      token: decifrar(c.token_cript),
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(de).replace(/\D/g, ''), type: 'text', text: { body: `Pronto! Você não vai mais receber ofertas da ${nome} por aqui. Os avisos dos seus pedidos continuam normalmente.` } },
    });
    await registrar(c.tenant_id, { evento: 'saiu', telefone: String(de).replace(/\D/g, ''), wamid: r.messages && r.messages[0] ? r.messages[0].id : null, situacao: 'enviada' });
  } catch { /* a confirmacao e cortesia */ }
  return { removidos: ids.length };
}
const SITUACAO = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
async function receberWebhook(bruto, assinatura) {
  if (!assinaturaValida(bruto, assinatura)) throw new HttpError(401, 'assinatura inválida');
  let corpo;
  try { corpo = JSON.parse(bruto.toString('utf8')); } catch { throw new HttpError(400, 'corpo inválido'); }
  let n = 0;
  for (const ent of corpo.entry || []) {
    for (const ch of ent.changes || []) {
      for (const msg of (ch.value && ch.value.messages) || []) {
        const texto = (msg.text && msg.text.body) || (msg.button && msg.button.text) || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) || '';
        if (PEDIDO_SAIR.test(texto.trim()) && msg.from) {
          try { await descadastrar((ch.value.metadata || {}).phone_number_id, msg.from); } catch (err) { console.error('whatsapp sair', err.message); }
        }
      }
      for (const st of (ch.value && ch.value.statuses) || []) {
        const nova = SITUACAO[st.status];
        if (!nova || !st.id) continue;
        const m = (await pool.query(`SELECT id, situacao FROM whatsapp_mensagens WHERE wamid = $1`, [st.id])).rows[0];
        if (!m) continue;
        if (nova !== 'falhou' && (ORDEM[nova] || 0) <= (ORDEM[m.situacao] || 0)) continue; // nao volta (lida -> entregue)
        const erro = nova === 'falhou' && st.errors && st.errors[0] ? `${st.errors[0].title || ''}${st.errors[0].message ? `: ${st.errors[0].message}` : ''}`.slice(0, 500) : null;
        await pool.query(`UPDATE whatsapp_mensagens SET situacao = $2, motivo = COALESCE($3, motivo), atualizado_em = now() WHERE id = $1`, [m.id, nova, erro]);
        n += 1;
      }
    }
  }
  return { ok: true, atualizadas: n };
}

module.exports = {
  MODELOS, MODELOS_MARKETING, TODOS_MODELOS, EVENTOS, graph, enviarModelo, registrar, marcarErroConta, moduloLigado, garantirModelosMarketing, descadastrar, chaveTelefone, telefoneWhatsapp, contaDa, publica, conectar, desconectar, salvarAvisos, conferirModelos, enviarTeste,
  varrer, iniciarVarredura, receberWebhook, assinaturaValida, eventoDoStatus, meta, disponivel, simulador,
};
