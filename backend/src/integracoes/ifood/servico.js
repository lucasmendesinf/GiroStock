// iFood no GiroStock: conexao da loja, recebimento de pedidos (polling), importacao, vinculo de itens e
// sincronizacao de status. Roda SEMPRE no banco de producao (o modo teste nao recebe pedidos reais).
const pool = require('../../db/pool');
const api = require('./api');
const { pedidoDoIfood } = require('./mapear');
const { cifrar, decifrar } = require('../../services/totp');
const { criarPedido } = require('../../services/pedidos');
const { dadosDaEmpresa, efetivos, aplicarRecursos } = require('../../utils/limites');
const { MATRIX } = require('../../middleware/permissions');
const { logAudit } = require('../../utils/audit');
const { HttpError } = require('../../utils/http');
const { ErroPlataforma } = require('../http');

const db = () => pool.producao;
const PLATAFORMA = 'ifood';
const MARGEM_RENOVACAO_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- token
async function tokenDa(integ) {
  if (!integ.access_token_cript) throw new HttpError(409, 'iFood não conectado nesta loja');
  const expira = integ.token_expira_em ? new Date(integ.token_expira_em).getTime() : 0;
  if (expira - Date.now() > MARGEM_RENOVACAO_MS) return decifrar(integ.access_token_cript);
  if (!integ.refresh_token_cript) return decifrar(integ.access_token_cript);
  try {
    const t = await api.renovarToken(decifrar(integ.refresh_token_cript));
    await salvarTokens(integ.id, t);
    integ.access_token_cript = cifrar(t.accessToken);
    integ.token_expira_em = new Date(Date.now() + Number(t.expiresIn || 21600) * 1000);
    return t.accessToken;
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      await db().query(`UPDATE integracoes_delivery SET status = 'reautorizar', ultimo_erro = $2, ultimo_erro_em = now(), atualizado_em = now() WHERE id = $1`, [integ.id, 'autorização expirada: conecte o iFood de novo']);
    }
    throw err;
  }
}

async function salvarTokens(id, t) {
  await db().query(
    `UPDATE integracoes_delivery SET access_token_cript = $2, refresh_token_cript = COALESCE($3, refresh_token_cript),
            token_expira_em = now() + ($4 || ' seconds')::interval, atualizado_em = now() WHERE id = $1`,
    [id, cifrar(t.accessToken), t.refreshToken ? cifrar(t.refreshToken) : null, String(Number(t.expiresIn || 21600))]
  );
}

async function integracao(id, tenantId) {
  const { rows } = await db().query(`SELECT * FROM integracoes_delivery WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2)`, [id, tenantId || null]);
  if (rows.length === 0) throw new HttpError(404, 'integração não encontrada');
  return rows[0];
}

// Usuario "sistema" da empresa (pedidos que chegam sozinhos): Administrador com os modulos da empresa.
async function usuarioSistema(tenantId) {
  const emp = await dadosDaEmpresa(db(), tenantId);
  const modulos = emp ? efetivos(emp).recursos : null;
  return { id: null, tenantId, perfil: 'Administrador', locationId: null, locationIds: [], modulos, areas: aplicarRecursos({ ...MATRIX.Administrador }, modulos) };
}

// ---------------------------------------------------------------- conexao da loja
async function iniciarConexao(user, locationId) {
  if (!api.configurado()) throw new HttpError(503, 'integração com o iFood ainda não configurada no servidor (IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET)');
  const loja = await db().query(`SELECT id, nome, ativo FROM locations WHERE id = $1 AND tenant_id = $2`, [locationId, user.tenantId]);
  if (loja.rows.length === 0) throw new HttpError(404, 'loja não encontrada');
  if (!loja.rows[0].ativo) throw new HttpError(400, 'esta loja está inativa');
  const atual = await db().query(`SELECT id, status FROM integracoes_delivery WHERE location_id = $1 AND plataforma = $2`, [locationId, PLATAFORMA]);
  if (atual.rows[0] && atual.rows[0].status === 'conectado') throw new HttpError(409, 'o iFood já está conectado nesta loja');
  const c = await api.gerarCodigoVinculo();
  const valores = [user.tenantId, locationId, c.userCode, cifrar(c.authorizationCodeVerifier), String(Number(c.expiresIn || 600)), user.id];
  const { rows } = atual.rows[0]
    ? await db().query(
      `UPDATE integracoes_delivery SET status = 'aguardando_codigo', codigo_vinculo = $3, verificador_token_cript = $4,
              codigo_vinculo_expira_em = now() + ($5 || ' seconds')::interval, criado_por = $6, ultimo_erro = NULL, atualizado_em = now()
       WHERE id = $7 RETURNING id`, [...valores, atual.rows[0].id])
    : await db().query(
      `INSERT INTO integracoes_delivery (tenant_id, location_id, plataforma, status, codigo_vinculo, verificador_token_cript, codigo_vinculo_expira_em, criado_por)
       VALUES ($1, $2, 'ifood', 'aguardando_codigo', $3, $4, now() + ($5 || ' seconds')::interval, $6) RETURNING id`, valores);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_conectar_iniciar', recurso: 'integracoes_delivery', recursoId: rows[0].id, detalhes: { loja: loja.rows[0].nome } });
  return { id: rows[0].id, codigo: c.userCode, link: c.verificationUrlComplete || c.verificationUrl, expira_em_segundos: Number(c.expiresIn || 600) };
}

// A loja autorizou no Portal do Parceiro e colou o codigo de autorizacao: troca por tokens e descobre a loja do iFood.
async function concluirConexao(user, id, codigoAutorizacao) {
  const integ = await integracao(id, user.tenantId);
  if (integ.status !== 'aguardando_codigo') throw new HttpError(409, 'gere um novo código de vínculo para conectar');
  const codigo = String(codigoAutorizacao || '').trim();
  if (codigo.length < 4) throw new HttpError(400, 'cole o código de autorização que o Portal do Parceiro mostrou');
  let t;
  try {
    t = await api.tokenPorCodigo(codigo, decifrar(integ.verificador_token_cript));
  } catch (err) {
    if (err.status >= 400 && err.status < 500) throw new HttpError(400, 'código de autorização inválido ou expirado: gere um novo vínculo e tente de novo');
    throw err;
  }
  await salvarTokens(id, t);
  const lojas = await api.lojas(t.accessToken);
  if (lojas.length === 1) return escolherLoja(user, id, lojas[0].id, lojas);
  await db().query(`UPDATE integracoes_delivery SET status = 'escolher_loja', lojas_disponiveis = $2, codigo_vinculo = NULL, atualizado_em = now() WHERE id = $1`, [id, JSON.stringify(lojas)]);
  return { status: 'escolher_loja', lojas };
}

async function escolherLoja(user, id, merchantId, lojasConhecidas) {
  const integ = await integracao(id, user.tenantId);
  const lojas = lojasConhecidas || integ.lojas_disponiveis || [];
  const m = lojas.find((x) => x.id === merchantId);
  if (!m) throw new HttpError(400, 'escolha uma das lojas da sua conta iFood');
  const dup = await db().query(`SELECT 1 FROM integracoes_delivery WHERE plataforma = 'ifood' AND merchant_id = $1 AND status <> 'desconectado' AND id <> $2`, [merchantId, id]);
  if (dup.rows.length > 0) throw new HttpError(409, 'esta loja do iFood já está conectada a outra loja do GiroStock');
  await db().query(
    `UPDATE integracoes_delivery SET status = 'conectado', merchant_id = $2, merchant_nome = $3, codigo_vinculo = NULL, verificador_token_cript = NULL,
            lojas_disponiveis = NULL, ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`,
    [id, merchantId, m.nome]
  );
  // Pedidos do iFood entram na tela de Pedidos: a loja passa a usar pedidos.
  await db().query(`UPDATE locations SET usa_pedidos = true WHERE id = $1 AND tenant_id = $2`, [integ.location_id, user.tenantId]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_conectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { merchant_id: merchantId, merchant_nome: m.nome } });
  return { status: 'conectado', merchant_id: merchantId, merchant_nome: m.nome };
}

async function desconectar(user, id) {
  const integ = await integracao(id, user.tenantId);
  await db().query(
    `UPDATE integracoes_delivery SET status = 'desconectado', access_token_cript = NULL, refresh_token_cript = NULL, verificador_token_cript = NULL,
            token_expira_em = NULL, codigo_vinculo = NULL, atualizado_em = now() WHERE id = $1`, [id]
  );
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_desconectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { merchant_id: integ.merchant_id } });
}

// ---------------------------------------------------------------- vinculo de itens
// Produto do item: vinculo lembrado -> codigo PDV (externalCode) igual ao codigo interno ou ao codigo de barras -> EAN.
async function produtosDosItens(client, tenantId, itens) {
  const r = new Map();
  const chaves = itens.map((i) => i.chave);
  const lembrados = await client.query(
    `SELECT ii.chave, ii.product_id FROM integracao_itens ii JOIN products p ON p.id = ii.product_id
     WHERE ii.tenant_id = $1 AND ii.plataforma = $2 AND ii.chave = ANY($3::text[]) AND p.ativo`,
    [tenantId, PLATAFORMA, chaves]
  );
  for (const l of lembrados.rows) r.set(l.chave, l.product_id);
  for (const i of itens) {
    if (r.has(i.chave)) continue;
    const codigos = [i.codigo_externo, i.ean].filter(Boolean);
    if (codigos.length === 0) continue;
    const p = await client.query(
      `SELECT id FROM products WHERE tenant_id = $1 AND ativo AND (codigo_interno = ANY($2::text[]) OR barcode = ANY($2::text[])) ORDER BY (codigo_interno = ANY($2::text[])) DESC LIMIT 1`,
      [tenantId, codigos]
    );
    if (p.rows[0]) r.set(i.chave, p.rows[0].id);
  }
  return r;
}

// ---------------------------------------------------------------- importacao
// Guarda o pedido como veio e tenta transformar em pedido do GiroStock. Idempotente (mesmo pedido = mesma linha).
async function receberPedido(integ, externoId) {
  const token = await tokenDa(integ);
  const payload = await api.pedido(token, externoId);
  const dados = pedidoDoIfood(payload);
  const { rows } = await db().query(
    `INSERT INTO pedidos_externos (tenant_id, location_id, integracao_id, plataforma, externo_id, codigo_externo, status_externo, entrega_pela_plataforma, payload)
     VALUES ($1, $2, $3, 'ifood', $4, $5, 'PLACED', $6, $7)
     ON CONFLICT (plataforma, externo_id) DO NOTHING RETURNING id`,
    [integ.tenant_id, integ.location_id, integ.id, dados.externo_id, dados.codigo_externo, dados.entrega_pela_plataforma, JSON.stringify(payload)]
  );
  if (rows.length === 0) return null; // ja recebido
  return importar(rows[0].id);
}

// Pedido externo -> pedido do GiroStock (quando todos os itens tem produto). Devolve a linha atualizada.
async function importar(pedidoExternoId) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM pedidos_externos WHERE id = $1 FOR UPDATE`, [pedidoExternoId]);
    const pe = rows[0];
    if (!pe || pe.situacao !== 'aguardando_vinculo') { await client.query('ROLLBACK'); return pe; }
    const dados = pedidoDoIfood(pe.payload);
    const produtos = await produtosDosItens(client, pe.tenant_id, dados.itens);
    if (dados.itens.some((i) => !produtos.has(i.chave))) { await client.query('COMMIT'); return pe; }
    const user = await usuarioSistema(pe.tenant_id);
    let r;
    try {
      r = await criarPedido(client, user, {
        ...dados, location_id: pe.location_id, origem: 'ifood',
        itens: dados.itens.map((i) => ({ product_id: produtos.get(i.chave), quantidade: i.quantidade, observacao: i.observacao, preco_unitario: i.preco_unitario })),
      }, { externo: { externo_id: pe.externo_id, codigo_externo: pe.codigo_externo } });
    } catch (err) {
      await client.query('ROLLBACK');
      await db().query(`UPDATE pedidos_externos SET situacao = 'erro', erro = $2, atualizado_em = now() WHERE id = $1`, [pe.id, String(err.message).slice(0, 300)]);
      return { ...pe, situacao: 'erro', erro: err.message };
    }
    const atualizado = await client.query(
      `UPDATE pedidos_externos SET situacao = 'importado', order_id = $2, faltas_estoque = $3, erro = NULL, atualizado_em = now() WHERE id = $1 RETURNING *`,
      [pe.id, r.orderId, r.faltas.length ? r.faltas.join(' · ') : null]
    );
    await client.query('COMMIT');
    const linha = atualizado.rows[0];
    // Aceite automatico: so quando tudo ok (sem falta de estoque) e o pedido ainda nao foi cancelado.
    const integ = linha.integracao_id ? (await db().query(`SELECT * FROM integracoes_delivery WHERE id = $1`, [linha.integracao_id])).rows[0] : null;
    if (integ && integ.aceite_automatico && !linha.faltas_estoque && linha.status_externo !== 'CANCELLED') {
      try { await confirmarNoIfood(integ, linha); } catch (err) { await registrarErro(integ.id, `aceite automático falhou: ${err.message}`); }
    }
    return linha;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ja encerrada */ }
    throw err;
  } finally {
    client.release();
  }
}

async function confirmarNoIfood(integ, pe) {
  if (pe.confirmado) return;
  await api.confirmar(await tokenDa(integ), pe.externo_id);
  await db().query(`UPDATE pedidos_externos SET confirmado = true, atualizado_em = now() WHERE id = $1`, [pe.id]);
}

async function registrarErro(id, msg) {
  await db().query(`UPDATE integracoes_delivery SET ultimo_erro = $2, ultimo_erro_em = now() WHERE id = $1`, [id, String(msg).slice(0, 300)]);
}

// ---------------------------------------------------------------- eventos
const STATUS_POR_CODIGO = { PLC: 'PLACED', CFM: 'CONFIRMED', SPS: 'SEPARATION_STARTED', SPE: 'SEPARATION_ENDED', RTP: 'READY_TO_PICKUP', DSP: 'DISPATCHED', CON: 'CONCLUDED', CAN: 'CANCELLED' };

async function tratarEvento(integ, ev) {
  const codigo = ev.code || '';
  const cheio = ev.fullCode || STATUS_POR_CODIGO[codigo] || codigo;
  if (codigo === 'PLC' || cheio === 'PLACED') { await receberPedido(integ, ev.orderId); return; }
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE plataforma = 'ifood' AND externo_id = $1`, [ev.orderId])).rows[0];
  if (!pe) {
    // Evento de pedido que ainda nao temos (ex.: chegou antes do PLC): busca o pedido inteiro.
    if (cheio !== 'CANCELLED' && cheio !== 'CONCLUDED') await receberPedido(integ, ev.orderId);
    return;
  }
  if (codigo === 'HSD' || cheio === 'HANDSHAKE_DISPUTE') {
    await db().query(`UPDATE pedidos_externos SET disputa = $2, atualizado_em = now() WHERE id = $1`, [pe.id, JSON.stringify({ ...(ev.metadata || {}), recebida_em: new Date().toISOString() })]);
    return;
  }
  if (codigo === 'HSS' || cheio === 'HANDSHAKE_SETTLEMENT') {
    await db().query(`UPDATE pedidos_externos SET disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
    return;
  }
  if (!STATUS_POR_CODIGO[codigo] && !Object.values(STATUS_POR_CODIGO).includes(cheio)) return; // outros grupos: so reconhece
  await db().query(`UPDATE pedidos_externos SET status_externo = $2, confirmado = confirmado OR $2 <> 'PLACED', atualizado_em = now() WHERE id = $1`, [pe.id, cheio]);
  if (cheio === 'CANCELLED') await cancelarLocal(pe, 'Cancelado no iFood');
}

// Cancelado na plataforma: cancela o pedido do GiroStock (libera a reserva). Ja finalizado: fica o aviso.
async function cancelarLocal(pe, motivo) {
  await db().query(`UPDATE pedidos_externos SET situacao = CASE WHEN situacao = 'aguardando_vinculo' OR situacao = 'erro' THEN 'cancelado' ELSE situacao END, disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
  if (!pe.order_id) return;
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT id, numero, status, tenant_id FROM orders WHERE id = $1 FOR UPDATE`, [pe.order_id])).rows[0];
    if (o && !['cancelado', 'finalizado'].includes(o.status)) {
      await client.query(`UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $2, atualizado_em = now() WHERE id = $1`, [o.id, motivo]);
      await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', NULL)`, [o.id, o.status]);
      await logAudit(client, { tenantId: o.tenant_id, usuarioId: null, acao: 'cancelar_pedido', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, motivo, origem: 'ifood' } });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Um ciclo de polling de uma conexao: busca eventos, trata e so entao confirma o recebimento (ACK).
// Evento que falhou nao recebe ACK: o iFood entrega de novo no proximo ciclo.
async function sincronizar(integ) {
  const token = await tokenDa(integ);
  const evs = await api.eventos(token, [integ.merchant_id]);
  const ok = [];
  let falhas = 0;
  for (const ev of evs) {
    if (!ev || !ev.id) continue;
    try { await tratarEvento(integ, ev); ok.push(ev.id); } catch (err) { falhas += 1; await registrarErro(integ.id, `evento ${ev.code || ''} do pedido ${ev.orderId || ''}: ${err.message}`); }
  }
  await api.confirmarRecebimento(token, ok);
  await db().query(`UPDATE integracoes_delivery SET ultimo_polling_em = now(), ultimo_erro = CASE WHEN $2 THEN NULL ELSE ultimo_erro END WHERE id = $1`, [integ.id, falhas === 0]);
  return { eventos: evs.length, tratados: ok.length, falhas };
}

// Ciclo de todas as conexoes ativas de empresas com o modulo "iFood e 99Food" ligado.
let rodando = false;
async function cicloGeral() {
  if (rodando || !api.configurado()) return;
  rodando = true;
  try {
    const { rows } = await db().query(`SELECT i.* FROM integracoes_delivery i JOIN tenants t ON t.id = i.tenant_id WHERE i.plataforma = 'ifood' AND i.status = 'conectado' AND t.status = 'ativa'`);
    for (const integ of rows) {
      try {
        const emp = await dadosDaEmpresa(db(), integ.tenant_id);
        if (!emp || !efetivos(emp).recursos.delivery_apps) continue;
        await sincronizar(integ);
      } catch (err) {
        await registrarErro(integ.id, err.message).catch(() => {});
      }
    }
  } finally {
    rodando = false;
  }
}

let timer = null;
function iniciarPolling() {
  if (timer || process.env.IFOOD_POLLING === 'desligado') return;
  // O iFood pede polling a cada 30 s (homologacao). Menor que isso so para o simulador local.
  const seg = Math.max(Number(process.env.IFOOD_POLLING_SEGUNDOS) || 30, process.env.IFOOD_API_URL ? 2 : 30);
  timer = setInterval(() => { cicloGeral().catch(() => {}); }, seg * 1000);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------- acoes vindas do GiroStock
// Chamado pela tela de Pedidos ao mudar o status de um pedido do iFood, ANTES de gravar a mudanca:
// se o iFood recusar, a mudanca nao acontece (as duas pontas ficam iguais).
async function aoMudarStatus(order, para) {
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE order_id = $1`, [order.id])).rows[0];
  if (!pe || !pe.integracao_id) return;
  const integ = await integracao(pe.integracao_id);
  if (integ.status !== 'conectado') throw new HttpError(409, 'o iFood desta loja está desconectado: reconecte em Lojas & PDVs');
  const token = await tokenDa(integ);
  try {
    if (para === 'em_preparo') {
      if (!pe.confirmado) await confirmarNoIfood(integ, pe);
      await api.iniciarPreparo(token, pe.externo_id);
    } else if (para === 'pronto') {
      // Pronto: obrigatorio na retirada/consumo no local; na entrega do iFood avisa o entregador. Entrega da loja: so o despacho.
      if (pe.payload.orderType !== 'DELIVERY' || pe.entrega_pela_plataforma) await api.prontoParaRetirada(token, pe.externo_id);
    } else if (para === 'saiu_entrega') {
      if (!pe.entrega_pela_plataforma) await api.despachar(token, pe.externo_id);
    }
  } catch (err) {
    if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou a mudança: ${err.message}`);
    throw err;
  }
}

async function pedidoExternoDoPedido(tenantId, orderId) {
  const { rows } = await db().query(`SELECT * FROM pedidos_externos WHERE order_id = $1 AND tenant_id = $2`, [orderId, tenantId]);
  return rows[0] || null;
}
async function pedidoExterno(tenantId, id) {
  const { rows } = await db().query(`SELECT * FROM pedidos_externos WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'pedido do iFood não encontrado');
  return rows[0];
}

async function aceitar(user, pe) {
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await confirmarNoIfood(integ, pe); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou: ${err.message}`); throw err; }
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_aceitar_pedido', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo: pe.codigo_externo } });
}

async function motivos(user, pe) {
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { return await api.motivosCancelamento(await tokenDa(integ), pe.externo_id); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `não foi possível buscar os motivos no iFood: ${err.message}`); throw err; }
}

// Cancelar pela loja: pede ao iFood (com o motivo da lista dele). O cancelamento local acontece quando o iFood
// confirmar (evento CAN); ate la o pedido fica marcado como "cancelamento solicitado".
async function solicitarCancelamento(user, pe, codigo, descricao) {
  if (!codigo) throw new HttpError(400, 'escolha o motivo do cancelamento (lista do iFood)');
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await api.solicitarCancelamento(await tokenDa(integ), pe.externo_id, String(codigo), String(descricao || '').slice(0, 250)); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou o cancelamento: ${err.message}`); throw err; }
  await db().query(`UPDATE pedidos_externos SET status_externo = 'CANCELLATION_REQUESTED', atualizado_em = now() WHERE id = $1`, [pe.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_solicitar_cancelamento', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo_motivo: codigo, motivo: descricao } });
}

async function responderDisputa(user, pe, aceitar) {
  if (!pe.disputa || !(pe.disputa.disputeId || pe.disputa.id)) throw new HttpError(409, 'não há pedido de cancelamento do cliente em aberto');
  const integ = await integracao(pe.integracao_id, user.tenantId);
  const motivo = aceitar && Array.isArray(pe.disputa.acceptCancellationReasons) && pe.disputa.acceptCancellationReasons[0] ? pe.disputa.acceptCancellationReasons[0] : undefined;
  try { await api.responderDisputa(await tokenDa(integ), pe.disputa.disputeId || pe.disputa.id, aceitar, motivo); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou a resposta: ${err.message}`); throw err; }
  await db().query(`UPDATE pedidos_externos SET disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: aceitar ? 'ifood_aceitar_cancelamento_cliente' : 'ifood_recusar_cancelamento_cliente', recurso: 'pedidos_externos', recursoId: pe.id });
  if (aceitar) await cancelarLocal(pe, 'Cancelamento pedido pelo cliente (aceito pela loja)');
}

// Vincula itens sem produto e tenta importar de novo. O vinculo fica lembrado para os proximos pedidos.
async function vincular(user, pe, vinculos) {
  if (pe.situacao !== 'aguardando_vinculo' && pe.situacao !== 'erro') throw new HttpError(409, 'este pedido não está aguardando vínculo');
  const dados = pedidoDoIfood(pe.payload);
  for (const v of vinculos || []) {
    const item = dados.itens.find((i) => i.chave === v.chave);
    if (!item || !v.product_id) continue;
    const p = await db().query(`SELECT id FROM products WHERE id = $1 AND tenant_id = $2 AND ativo`, [v.product_id, user.tenantId]);
    if (p.rows.length === 0) throw new HttpError(400, 'produto inválido para o vínculo');
    await db().query(
      `INSERT INTO integracao_itens (tenant_id, plataforma, chave, nome_externo, product_id) VALUES ($1, 'ifood', $2, $3, $4)
       ON CONFLICT (tenant_id, plataforma, chave) DO UPDATE SET product_id = EXCLUDED.product_id, nome_externo = EXCLUDED.nome_externo`,
      [user.tenantId, v.chave, item.nome, v.product_id]
    );
  }
  if (pe.situacao === 'erro') await db().query(`UPDATE pedidos_externos SET situacao = 'aguardando_vinculo', erro = NULL WHERE id = $1`, [pe.id]);
  const r = await importar(pe.id);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_vincular_itens', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { itens: (vinculos || []).length, situacao: r.situacao } });
  return r;
}

module.exports = {
  iniciarConexao, concluirConexao, escolherLoja, desconectar, sincronizar, cicloGeral, iniciarPolling, integracao,
  aoMudarStatus, pedidoExternoDoPedido, pedidoExterno, aceitar, motivos, solicitarCancelamento, responderDisputa, vincular,
  importar, produtosDosItens, PLATAFORMA,
};
