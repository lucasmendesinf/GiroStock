// 99Food no GiroStock: vinculo da loja (app_shop_id), recebimento de pedidos por webhook (a 99Food empurra cada evento),
// importacao (parte comum em ../comum.js) e sincronizacao de status. Roda SEMPRE no banco de producao.
const crypto = require('crypto');
const api = require('./api');
const { pedidoDo99 } = require('./mapear');
const { cifrar, decifrar } = require('../../services/totp');
const comum = require('../comum');
const { logAudit } = require('../../utils/audit');
const { HttpError } = require('../../utils/http');
const { ErroPlataforma } = require('../http');

const { db, integracao, registrarErro, importar, cancelarLocal } = comum;
const PLATAFORMA = '99food';
const MARGEM_RENOVACAO_MS = 10 * 60 * 1000;

// Nosso codigo da loja na 99Food (app_shop_id): fixo por loja do GiroStock, informado pela loja ao autorizar o app.
const appShopIdDa = (locationId) => `GS${String(locationId).replace(/-/g, '').slice(0, 12).toUpperCase()}`;

// ---------------------------------------------------------------- token
async function tokenDa(integ, { forcar = false } = {}) {
  const expira = integ.token_expira_em ? new Date(integ.token_expira_em).getTime() : 0;
  if (!forcar && integ.access_token_cript && expira - Date.now() > MARGEM_RENOVACAO_MS) return decifrar(integ.access_token_cript);
  try {
    const t = await api.tokenDaLoja(integ.merchant_id);
    await db().query(`UPDATE integracoes_delivery SET access_token_cript = $2, token_expira_em = $3, atualizado_em = now() WHERE id = $1`, [integ.id, cifrar(t.token), t.expira_em]);
    integ.access_token_cript = cifrar(t.token);
    integ.token_expira_em = t.expira_em;
    return t.token;
  } catch (err) {
    // A 99Food recusou (loja tirou a autorizacao do app): precisa autorizar de novo.
    if (err instanceof ErroPlataforma && err.errno !== null && err.errno !== undefined && integ.status === 'conectado') {
      await db().query(`UPDATE integracoes_delivery SET status = 'reautorizar', ultimo_erro = $2, ultimo_erro_em = now(), atualizado_em = now() WHERE id = $1`, [integ.id, `a 99Food recusou o acesso: ${err.message}`]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- conexao da loja
async function iniciarConexao(user, locationId) {
  if (!api.configurado()) throw new HttpError(503, 'integração com a 99Food ainda não configurada no servidor (FOOD99_APP_ID/FOOD99_APP_SECRET)');
  const loja = await db().query(`SELECT id, nome, ativo FROM locations WHERE id = $1 AND tenant_id = $2`, [locationId, user.tenantId]);
  if (loja.rows.length === 0) throw new HttpError(404, 'loja não encontrada');
  if (!loja.rows[0].ativo) throw new HttpError(400, 'esta loja está inativa');
  const atual = await db().query(`SELECT id, status FROM integracoes_delivery WHERE location_id = $1 AND plataforma = $2`, [locationId, PLATAFORMA]);
  if (atual.rows[0] && atual.rows[0].status === 'conectado') throw new HttpError(409, 'a 99Food já está conectada nesta loja');
  const appShopId = appShopIdDa(locationId);
  const { rows } = atual.rows[0]
    ? await db().query(
      `UPDATE integracoes_delivery SET status = 'aguardando_codigo', merchant_id = $2, codigo_vinculo = $2, criado_por = $3, ultimo_erro = NULL, atualizado_em = now()
       WHERE id = $1 RETURNING id`, [atual.rows[0].id, appShopId, user.id])
    : await db().query(
      `INSERT INTO integracoes_delivery (tenant_id, location_id, plataforma, status, merchant_id, codigo_vinculo, criado_por)
       VALUES ($1, $2, '99food', 'aguardando_codigo', $3, $3, $4) RETURNING id`, [user.tenantId, locationId, appShopId, user.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: '99food_conectar_iniciar', recurso: 'integracoes_delivery', recursoId: rows[0].id, detalhes: { loja: loja.rows[0].nome, app_shop_id: appShopId } });
  return { id: rows[0].id, plataforma: PLATAFORMA, codigo: appShopId };
}

// A loja autorizou o app no portal da 99Food com o codigo: confere pedindo o token da loja.
async function concluirConexao(user, id) {
  const integ = await integracao(id, user.tenantId);
  if (!['aguardando_codigo', 'reautorizar'].includes(integ.status)) throw new HttpError(409, 'gere o código da loja para conectar');
  try {
    await tokenDa({ ...integ, status: 'aguardando_codigo' }, { forcar: true });
  } catch (err) {
    if (err instanceof ErroPlataforma && err.status !== 0) throw new HttpError(400, `a 99Food ainda não liberou esta loja: autorize o app no portal da 99Food com o código ${integ.merchant_id} e tente de novo (${err.message})`);
    throw err;
  }
  await db().query(`UPDATE integracoes_delivery SET status = 'conectado', codigo_vinculo = NULL, ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`, [id]);
  // Pedidos da 99Food entram na tela de Pedidos: a loja passa a usar pedidos.
  await db().query(`UPDATE locations SET usa_pedidos = true WHERE id = $1 AND tenant_id = $2`, [integ.location_id, user.tenantId]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: '99food_conectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { app_shop_id: integ.merchant_id } });
  return { status: 'conectado', merchant_id: integ.merchant_id, merchant_nome: integ.merchant_nome };
}

async function desconectar(user, id) {
  const integ = await integracao(id, user.tenantId);
  await db().query(
    `UPDATE integracoes_delivery SET status = 'desconectado', access_token_cript = NULL, token_expira_em = NULL, codigo_vinculo = NULL, atualizado_em = now() WHERE id = $1`, [id]
  );
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: '99food_desconectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { app_shop_id: integ.merchant_id } });
}

// "Testar conexao": pede um token novo (a 99Food empurra os pedidos; nao ha o que buscar).
async function sincronizar(integ) {
  await tokenDa(integ, { forcar: true });
  await db().query(`UPDATE integracoes_delivery SET ultimo_erro = NULL WHERE id = $1`, [integ.id]);
  return { eventos: 0, tratados: 0, falhas: 0, conexao: 'ok' };
}

// ---------------------------------------------------------------- webhook
// Assinatura: header didi-header-sign = md5(corpo bruto + app_secret), em hexadecimal.
function assinaturaValida(corpoBruto, assinatura) {
  const { appSecret } = api.credenciais();
  if (!appSecret || !assinatura) return false;
  const esperado = crypto.createHash('md5').update(Buffer.concat([Buffer.from(corpoBruto), Buffer.from(appSecret)])).digest('hex');
  const a = Buffer.from(String(assinatura).trim().toLowerCase());
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Le o evento de forma defensiva (o envelope exato e A CONFIRMAR na homologacao).
function lerEvento(corpo) {
  const data = corpo.data && typeof corpo.data === 'object' ? corpo.data : corpo;
  const info = data.order_info || (Array.isArray(data.order_items) ? data : null);
  return {
    tipo: String(corpo.type || corpo.event_type || corpo.msg_type || data.type || ''),
    data,
    info,
    orderId: data.order_id || (info && info.order_id) || corpo.order_id || null,
    appShopId: corpo.app_shop_id || data.app_shop_id || (info && info.shop && info.shop.app_shop_id) || (data.shop && data.shop.app_shop_id) || null,
  };
}

// Um evento da 99Food. Devolve { ok, motivo? }. Falha (excecao) = responder erro, e a 99Food manda de novo.
async function receberWebhook(corpoBruto, assinatura) {
  if (!api.configurado()) throw new HttpError(503, '99Food não configurada no servidor');
  if (!assinaturaValida(corpoBruto, assinatura)) throw new HttpError(401, 'assinatura inválida');
  const ev = lerEvento(api.jsonSeguro(Buffer.from(corpoBruto).toString('utf8')));
  let integ = null;
  if (ev.appShopId) {
    integ = (await db().query(`SELECT * FROM integracoes_delivery WHERE plataforma = '99food' AND merchant_id = $1 AND status <> 'desconectado'`, [String(ev.appShopId)])).rows[0];
  }
  if (!integ && ev.orderId) {
    integ = (await db().query(
      `SELECT i.* FROM pedidos_externos pe JOIN integracoes_delivery i ON i.id = pe.integracao_id WHERE pe.plataforma = '99food' AND pe.externo_id = $1`, [String(ev.orderId)]
    )).rows[0];
  }
  if (!integ || integ.status === 'desconectado') return { ok: true, motivo: 'loja não conectada no GiroStock' };
  // Modulo desligado: recusa (a 99Food reenvia; se ligar de novo a tempo, o pedido entra).
  if (!(await comum.moduloLigado(integ.tenant_id))) throw new HttpError(409, 'módulo iFood e 99Food desligado para esta empresa');
  try {
    await tratarEvento(integ, ev);
  } catch (err) {
    await registrarErro(integ.id, `evento ${ev.tipo} do pedido ${ev.orderId || ''}: ${err.message}`).catch(() => {});
    throw err;
  }
  await db().query(`UPDATE integracoes_delivery SET ultimo_polling_em = now() WHERE id = $1`, [integ.id]);
  return { ok: true };
}

const texto = (v) => String(v || '').trim().slice(0, 120);
const STATUS = { orderConfirm: 'CONFIRMED', orderReady: 'READY_TO_PICKUP', orderFinish: 'CONCLUDED', orderCancel: 'CANCELLED' };

async function receberPedido(integ, ev) {
  let info = ev.info;
  if (!info) {
    const d = await api.detalhe(await tokenDa(integ), ev.orderId);
    info = (d && d.order_info) || d;
  }
  if (!info || !info.order_id) throw new Error('evento sem os dados do pedido');
  const dados = pedidoDo99(info);
  if (!integ.merchant_nome && info.shop && info.shop.shop_name) {
    await db().query(`UPDATE integracoes_delivery SET merchant_nome = $2 WHERE id = $1`, [integ.id, texto(info.shop.shop_name)]);
  }
  const novo = await comum.guardarPedido(integ, dados, 'PLACED', info);
  if (!novo) return null; // ja recebido (a 99Food reenvia ate receber errno 0)
  return importar(novo);
}

async function tratarEvento(integ, ev) {
  if (ev.tipo === 'orderNew') { await receberPedido(integ, ev); return; }
  if (!ev.orderId) return;
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE plataforma = '99food' AND externo_id = $1`, [String(ev.orderId)])).rows[0];
  if (!pe) {
    // Evento de pedido que ainda nao temos (o orderNew se perdeu): busca o pedido inteiro.
    if (ev.tipo !== 'orderCancel' && ev.tipo !== 'orderFinish') await receberPedido(integ, { ...ev, info: null });
    return;
  }
  if (ev.tipo === 'orderPartialCancel') {
    if (pe.order_id) await db().query(`UPDATE orders SET observacao = left(observacao || ' · ATENÇÃO: cancelamento parcial na 99Food, confira os itens no app', 500), atualizado_em = now() WHERE id = $1`, [pe.order_id]);
    return;
  }
  const status = STATUS[ev.tipo];
  if (!status) return; // deliveryStatus e outros: so reconhece
  await db().query(`UPDATE pedidos_externos SET status_externo = $2, confirmado = confirmado OR $2 <> 'PLACED', atualizado_em = now() WHERE id = $1`, [pe.id, status]);
  if (status === 'CANCELLED') await cancelarLocal(pe, 'Cancelado na 99Food');
}

// ---------------------------------------------------------------- acoes vindas do GiroStock
async function confirmarPedido(integ, pe) {
  if (pe.confirmado) return;
  await api.confirmar(await tokenDa(integ), pe.externo_id);
  await db().query(`UPDATE pedidos_externos SET confirmado = true, status_externo = CASE WHEN status_externo = 'PLACED' THEN 'CONFIRMED' ELSE status_externo END, atualizado_em = now() WHERE id = $1`, [pe.id]);
}

// Chamado pela tela de Pedidos ANTES de gravar a mudanca: se a 99Food recusar, nada muda aqui.
async function aoMudarStatus(order, para) {
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE order_id = $1`, [order.id])).rows[0];
  if (!pe || !pe.integracao_id) return;
  const integ = await integracao(pe.integracao_id);
  if (integ.status !== 'conectado') throw new HttpError(409, 'a 99Food desta loja está desconectada: reconecte em Lojas & PDVs');
  try {
    if (para === 'em_preparo') {
      if (!pe.confirmado) await confirmarPedido(integ, pe);
    } else if (para === 'pronto') {
      // Pronto: chama o entregador da 99Food / avisa o cliente da retirada.
      await api.pronto(await tokenDa(integ), pe.externo_id);
    } else if (para === 'saiu_entrega' && !pe.entrega_pela_plataforma) {
      const ent = order.entregador_id ? (await db().query(`SELECT nome, telefone FROM couriers WHERE id = $1`, [order.entregador_id])).rows[0] : null;
      await api.despachar(await tokenDa(integ), pe.externo_id, ent || {});
    }
  } catch (err) {
    if (err instanceof ErroPlataforma) throw new HttpError(502, `a 99Food não aceitou a mudança: ${err.message}`);
    throw err;
  }
}

async function aceitar(user, pe) {
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await confirmarPedido(integ, pe); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `a 99Food não aceitou: ${err.message}`); throw err; }
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: '99food_aceitar_pedido', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo: pe.codigo_externo } });
}

async function motivos() {
  return api.MOTIVOS_CANCELAMENTO;
}

// Cancelar pela loja: a 99Food cancela na hora (a resposta ja confirma); o pedido daqui e cancelado em seguida.
async function solicitarCancelamento(user, pe, codigo, descricao) {
  const motivo = api.MOTIVOS_CANCELAMENTO.find((m) => m.codigo === String(codigo || ''));
  if (!motivo) throw new HttpError(400, 'escolha o motivo do cancelamento (lista da 99Food)');
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await api.cancelar(await tokenDa(integ), pe.externo_id, motivo.codigo, String(descricao || motivo.descricao).slice(0, 250)); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `a 99Food não aceitou o cancelamento: ${err.message}`); throw err; }
  await db().query(`UPDATE pedidos_externos SET status_externo = 'CANCELLED', atualizado_em = now() WHERE id = $1`, [pe.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: '99food_cancelar_pedido', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo_motivo: motivo.codigo, motivo: descricao } });
  await cancelarLocal(pe, `Cancelado pela loja na 99Food: ${descricao || motivo.descricao}`);
}

async function responderDisputa() {
  throw new HttpError(409, 'a 99Food não usa negociação de cancelamento: o cliente fala com a loja pelo app da 99Food');
}

const mapear = pedidoDo99;

module.exports = {
  PLATAFORMA, mapear, confirmarPedido, appShopIdDa, assinaturaValida, receberWebhook,
  iniciarConexao, concluirConexao, desconectar, sincronizar, aoMudarStatus, aceitar, motivos, solicitarCancelamento, responderDisputa,
};
