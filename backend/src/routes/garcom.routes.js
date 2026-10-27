// Garcom, Fase 1: comandas de mesa e de pista com varias rodadas, app do garcom (/garcom/*) e fechamento no caixa (/comandas/*).
// Cada rodada e um pedido (orders.comanda_id): cozinha, reserva de estoque e impressao reaproveitam o que ja existe. A venda UNICA
// so nasce no fechamento da comanda; ate la a rodada (inclusive "entregue") continua apenas reservando estoque.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo, areasEfetivas } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess, canAccessLocation, filtroLocais } = require('../utils/access');
const { HttpError } = require('../utils/http');
const { FUSO } = require('../utils/query');
const { criarPedido } = require('../services/pedidos');
const recebimentos = require('../services/recebimentos');

const router = express.Router();
const ABERTAS = ['aberta', 'fechamento_solicitado'];

const doGarcom = [requireArea('Garcom'), requireModulo('garcom')];
const doCaixa = [requireArea('Vendas'), requireModulo('garcom')];
router.use('/garcom', doGarcom);
router.use('/comandas', doCaixa);

// Gerencia e caixa veem todas as comandas da(s) loja(s) deles; o garcom so as que atende.
const veTodas = (user) => !!(user.areas && (user.areas.Pedidos || user.areas.Vendas));

const SELECT_COMANDA = `
  SELECT c.id, c.numero, c.location_id, l.nome AS location_nome, c.tipo, c.identificador, c.cliente_nome, c.modo_pagamento, c.status,
         c.aberta_por, ua.nome AS aberta_por_nome, c.aberta_em, c.fechamento_solicitado_em, c.fechada_em, c.fechada_por, c.sale_id,
         c.observacao, c.motivo_cancelamento,
         COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.comanda_id = c.id AND o.status <> 'cancelado'), 0) AS total,
         COALESCE((SELECT SUM(cp.valor_produtos) FROM comanda_pagamentos cp WHERE cp.comanda_id = c.id AND cp.status = 'confirmado'), 0) AS pago_produtos,
         COALESCE((SELECT SUM(cp.taxa_servico) FROM comanda_pagamentos cp WHERE cp.comanda_id = c.id AND cp.status = 'confirmado'), 0) AS taxa_paga,
         (SELECT COUNT(*)::int FROM orders o WHERE o.comanda_id = c.id AND o.status <> 'cancelado') AS rodadas,
         (SELECT COUNT(*)::int FROM orders o WHERE o.comanda_id = c.id AND o.status IN ('novo', 'em_preparo')) AS rodadas_na_cozinha,
         (SELECT COUNT(*)::int FROM orders o WHERE o.comanda_id = c.id AND o.status = 'pronto') AS rodadas_prontas,
         COALESCE((SELECT json_agg(json_build_object('id', g.user_id, 'nome', gu.nome) ORDER BY g.desde)
                   FROM comanda_garcons g JOIN users gu ON gu.id = g.user_id WHERE g.comanda_id = c.id), '[]') AS garcons
  FROM comandas c
  JOIN locations l ON l.id = c.location_id
  LEFT JOIN users ua ON ua.id = c.aberta_por`;

// A comanda e do garcom quando ele a abriu, atende nela (comanda_garcons) ou lancou itens nela.
const SQL_MINHA = `(c.aberta_por = $USER OR EXISTS (SELECT 1 FROM comanda_garcons cg WHERE cg.comanda_id = c.id AND cg.user_id = $USER)
                    OR EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.comanda_id = c.id AND oi.garcom_id = $USER))`;

async function carregarComanda(db, user, id, { travar = false } = {}) {
  if (!isUuid(id)) throw new HttpError(404, 'comanda não encontrada');
  const { rows } = await db.query(`SELECT * FROM comandas WHERE id = $1 AND tenant_id = $2 ${travar ? 'FOR UPDATE' : ''}`, [id, user.tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'comanda não encontrada');
  const c = rows[0];
  if (!canAccessLocation(user, c.location_id)) throw new HttpError(404, 'comanda não encontrada');
  if (!veTodas(user)) {
    const meu = await db.query(
      `SELECT 1 FROM comandas c WHERE c.id = $1 AND ${SQL_MINHA.replace(/\$USER/g, '$2')}`, [c.id, user.id]
    );
    if (meu.rows.length === 0) throw new HttpError(404, 'comanda não encontrada');
  }
  return c;
}

async function detalhe(db, user, id) {
  const { rows } = await db.query(`${SELECT_COMANDA} WHERE c.id = $1 AND c.tenant_id = $2`, [id, user.tenantId]);
  const comanda = rows[0];
  const rod = await db.query(
    `SELECT o.id, o.numero AS pedido_numero, o.rodada, o.status, o.observacao, o.criado_em, o.atualizado_em, o.motivo_cancelamento,
            COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS total, r.pagamento_id, cp.forma AS pago_forma
     FROM orders o LEFT JOIN comanda_pagamento_rodadas r ON r.order_id = o.id LEFT JOIN comanda_pagamentos cp ON cp.id = r.pagamento_id
     WHERE o.comanda_id = $1 ORDER BY o.rodada`,
    [id]
  );
  const itens = rod.rows.length === 0 ? { rows: [] } : await db.query(
    `SELECT oi.id, oi.order_id, oi.product_id, p.nome AS product_nome, p.unidade, oi.quantidade, oi.preco_unitario, oi.subtotal, oi.observacao,
            COALESCE(oi.complementos, '[]'::jsonb) AS complementos, oi.garcom_id, gu.nome AS garcom_nome
     FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN users gu ON gu.id = oi.garcom_id
     WHERE oi.order_id = ANY($1::uuid[]) ORDER BY p.nome, oi.id`,
    [rod.rows.map((r) => r.id)]
  );
  const pag = await db.query(
    `SELECT cp.id, cp.forma, cp.valor_produtos, cp.taxa_servico, cp.valor_recebido, cp.troco, cp.recebido_por, u.nome AS recebido_por_nome, cp.recebido_em,
            cp.status, cp.prestado_em, cp.motivo_estorno,
            COALESCE((SELECT json_agg(o.rodada ORDER BY o.rodada) FROM comanda_pagamento_rodadas r JOIN orders o ON o.id = r.order_id WHERE r.pagamento_id = cp.id), '[]') AS rodadas
     FROM comanda_pagamentos cp JOIN users u ON u.id = cp.recebido_por WHERE cp.comanda_id = $1 ORDER BY cp.recebido_em`,
    [id]
  );
  const cfg = await recebimentos.configDaLoja(db, comanda.location_id);
  const receber = { permitido: cfg.garcom_recebe && !!(user.areas && user.areas.ReceberNoApp), loja_permite: cfg.garcom_recebe, formas: cfg.formas, taxa_servico_pct: cfg.taxa_servico_pct };
  const ativas = rod.rows.filter((r) => r.status !== 'cancelado');
  const falta = Number(ativas.filter((r) => !r.pagamento_id).reduce((x, r) => x + Number(r.total), 0).toFixed(2));
  return { ...comanda, falta_produtos: falta, receber, pagamentos: pag.rows, rodadas_lista: rod.rows.map((r) => ({ ...r, itens: itens.rows.filter((i) => i.order_id === r.id) })) };
}

// Identificador legivel: "Mesa 7" / "Pulseira 118". So numeros viram "Mesa N" / "Pulseira N"; texto livre fica como foi digitado.
function normalizarIdentificador(tipo, bruto) {
  const t = String(bruto === undefined || bruto === null ? '' : bruto).trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!t) throw new HttpError(400, tipo === 'mesa' ? 'informe a mesa' : 'informe o número da pulseira ou do cartão');
  if (/^\d+$/.test(t)) return `${tipo === 'mesa' ? 'Mesa' : 'Pulseira'} ${Number(t)}`;
  return t;
}

// Loja da comanda: a informada (se o usuario puder) ou a principal dele; varias lojas sem principal -> exige escolher.
async function lojaDaComanda(db, user, locationId) {
  let id = locationId || user.locationId || null;
  if (!id) {
    const lojas = filtroLocais(user, null);
    if (lojas && lojas.length === 1) id = lojas[0];
  }
  if (!isUuid(id)) throw new HttpError(400, 'escolha a loja da comanda');
  const loja = await getOwned(db, 'locations', id, user.tenantId, { columns: 'id, nome, ativo, usa_pedidos' });
  if (!loja.ativo) throw new HttpError(400, 'esta loja está inativa');
  if (!loja.usa_pedidos) throw new HttpError(400, 'esta loja não usa pedidos: ative "usa pedidos" em Lojas & PDVs para trabalhar com comandas');
  assertLocationAccess(user, id, 'abrir comandas nesta loja');
  return loja;
}

// ================================================================= app do garcom
router.get('/garcom/lojas', async (req, res) => {
  const lojas = filtroLocais(req.user, null);
  const { rows } = await pool.query(
    `SELECT id, nome, garcom_recebe FROM locations WHERE tenant_id = $1 AND ativo AND usa_pedidos AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY nome`,
    [req.user.tenantId, lojas]
  );
  res.json(rows);
});

router.get('/garcom/comandas', async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'c.tenant_id = $1';
  const lojas = filtroLocais(req.user, req.query.location_id);
  if (lojas) { params.push(lojas); where += ` AND c.location_id = ANY($${params.length}::uuid[])`; }
  const status = String(req.query.status || 'abertas');
  if (status === 'abertas') where += ` AND c.status IN ('aberta', 'fechamento_solicitado')`;
  else if (['aberta', 'fechamento_solicitado', 'paga', 'cancelada'].includes(status)) { params.push(status); where += ` AND c.status = $${params.length}`; }
  if (!veTodas(req.user)) { params.push(req.user.id); where += ` AND ${SQL_MINHA.replace(/\$USER/g, `$${params.length}`)}`; }
  const { rows } = await pool.query(`${SELECT_COMANDA} WHERE ${where} ORDER BY c.aberta_em DESC LIMIT 200`, params);
  res.json(rows);
});

// Abre (ou entra na) comanda. Mesa ja aberta -> devolve a existente e o garcom passa a atende-la tambem.
router.post('/garcom/comandas', async (req, res) => {
  const b = req.body || {};
  if (!['mesa', 'pista'].includes(b.tipo)) throw new HttpError(400, 'tipo da comanda: mesa ou pista');
  const modo = b.modo_pagamento === undefined ? 'conta' : b.modo_pagamento;
  if (!['conta', 'hora'].includes(modo)) throw new HttpError(400, 'modo de pagamento: conta (paga no fechamento) ou hora (paga a cada rodada)');
  const identificador = normalizarIdentificador(b.tipo, b.identificador);
  const clienteNome = String(b.cliente_nome || '').trim().slice(0, 80);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loja = await lojaDaComanda(client, req.user, b.location_id);
    if (modo === 'hora') {
      const cfg = await recebimentos.configDaLoja(client, loja.id);
      if (!(req.user.areas && req.user.areas.ReceberNoApp) || !cfg.garcom_recebe) throw new HttpError(403, 'receber "na hora" não está liberado para você nesta loja');
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('comanda:' || $1::text))`, [loja.id]);
    let existente = (await client.query(
      `SELECT id FROM comandas WHERE tenant_id = $1 AND location_id = $2 AND lower(identificador) = lower($3) AND status IN ('aberta', 'fechamento_solicitado')`,
      [req.user.tenantId, loja.id, identificador]
    )).rows[0];
    let criada = false;
    if (!existente) {
      const numero = (await client.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM comandas WHERE tenant_id = $1 AND location_id = $2`, [req.user.tenantId, loja.id])).rows[0].n;
      existente = (await client.query(
        `INSERT INTO comandas (tenant_id, location_id, numero, tipo, identificador, cliente_nome, aberta_por, modo_pagamento) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.user.tenantId, loja.id, numero, b.tipo, identificador, clienteNome, req.user.id, modo]
      )).rows[0];
      criada = true;
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'abrir_comanda', recurso: 'comandas', recursoId: existente.id, detalhes: { tipo: b.tipo, identificador, numero } });
    } else {
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'entrar_comanda', recurso: 'comandas', recursoId: existente.id, detalhes: { identificador } });
    }
    await client.query(`INSERT INTO comanda_garcons (comanda_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [existente.id, req.user.id]);
    await client.query('COMMIT');
    res.status(criada ? 201 : 200).json({ ...(await detalhe(pool, req.user, existente.id)), existente: !criada });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/garcom/comandas/:id', async (req, res) => {
  const c = await carregarComanda(pool, req.user, req.params.id);
  res.json(await detalhe(pool, req.user, c.id));
});

// Nova rodada: vai ao bar/cozinha (pedido), reserva estoque e grava o garcom em cada item. `client_id` (UUID do celular) torna o reenvio seguro.
router.post('/garcom/comandas/:id/rodadas', async (req, res) => {
  const b = req.body || {};
  const clientId = b.client_id === undefined || b.client_id === null ? null : String(b.client_id);
  if (clientId !== null && !isUuid(clientId)) throw new HttpError(400, 'client_id inválido');
  const previa = await carregarComanda(pool, req.user, req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Um pedido de cada vez por loja: duas rodadas simultaneas nao reservam o mesmo ultimo item.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('reserva:' || $1::text))`, [previa.location_id]);
    const c = await carregarComanda(client, req.user, previa.id, { travar: true });
    if (clientId) {
      const rep = await client.query(`SELECT id, rodada FROM orders WHERE comanda_id = $1 AND client_id = $2`, [c.id, clientId]);
      if (rep.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(200).json({ ...(await detalhe(pool, req.user, c.id)), rodada_id: rep.rows[0].id, repetida: true });
      }
    }
    if (c.status !== 'aberta') {
      throw new HttpError(409, c.status === 'fechamento_solicitado' ? 'esta comanda já pediu fechamento: peça ao gerente para reabri-la' : 'esta comanda está encerrada');
    }
    await client.query(`INSERT INTO comanda_garcons (comanda_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [c.id, req.user.id]);
    const rodada = (await client.query(`SELECT COALESCE(MAX(rodada), 0) + 1 AS n FROM orders WHERE comanda_id = $1`, [c.id])).rows[0].n;
    const r = await criarPedido(client, req.user, {
      location_id: c.location_id, origem: 'balcao', tipo: c.tipo, endereco: c.identificador, cliente_nome: c.cliente_nome,
      observacao: b.observacao, itens: b.itens,
    }, { comanda: { id: c.id, rodada, clientId, garcomId: req.user.id } });
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'rodada_comanda', recurso: 'comandas', recursoId: c.id, detalhes: { rodada, pedido: r.numero, itens: (b.itens || []).length } });
    await client.query('COMMIT');
    res.status(201).json({ ...(await detalhe(pool, req.user, c.id)), rodada_id: r.orderId, repetida: false });
  } catch (err) {
    await client.query('ROLLBACK');
    // Reenvio simultaneo com o mesmo client_id: a outra requisicao ganhou; devolve o resultado dela.
    if (err.code === '23505' && clientId) {
      const rep = await pool.query(`SELECT id FROM orders WHERE comanda_id = $1 AND client_id = $2`, [previa.id, clientId]);
      if (rep.rows.length > 0) return res.status(200).json({ ...(await detalhe(pool, req.user, previa.id)), rodada_id: rep.rows[0].id, repetida: true });
    }
    throw err;
  } finally {
    client.release();
  }
});

async function rodadaOuErro(db, user, orderId) {
  if (!isUuid(orderId)) throw new HttpError(404, 'rodada não encontrada');
  const { rows } = await db.query(`SELECT id, numero, comanda_id, rodada, status, location_id FROM orders WHERE id = $1 AND tenant_id = $2 AND comanda_id IS NOT NULL FOR UPDATE`, [orderId, user.tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'rodada não encontrada');
  await carregarComanda(db, user, rows[0].comanda_id);
  return rows[0];
}

// O garcom marca "entregue" na propria rodada quando a cozinha/bar a deixou pronta.
router.post('/garcom/rodadas/:orderId/status', async (req, res) => {
  if ((req.body || {}).para !== 'entregue') throw new HttpError(400, 'o garçom só marca a rodada como "entregue"');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await rodadaOuErro(client, req.user, req.params.orderId);
    if (o.status !== 'pronto') throw new HttpError(409, o.status === 'entregue' ? 'esta rodada já foi entregue' : `a rodada está "${o.status}": só dá para marcar entregue quando estiver pronta`);
    await client.query(`UPDATE orders SET status = 'entregue', atualizado_em = now() WHERE id = $1`, [o.id]);
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, 'pronto', 'entregue', $2)`, [o.id, req.user.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'pedido_status', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, de: 'pronto', para: 'entregue', comanda_id: o.comanda_id } });
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, o.comanda_id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Cancelar rodada: o proprio garcom, so antes de entrar em preparo; depois so quem pode cancelar vendas (gerente), com motivo.
router.post('/garcom/rodadas/:orderId/cancelar', async (req, res) => {
  const motivo = String((req.body || {}).motivo || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await rodadaOuErro(client, req.user, req.params.orderId);
    if (['finalizado', 'cancelado'].includes(o.status)) throw new HttpError(409, o.status === 'cancelado' ? 'esta rodada já foi cancelada' : 'a rodada já foi cobrada no caixa');
    if ((await client.query(`SELECT 1 FROM comanda_pagamento_rodadas WHERE order_id = $1`, [o.id])).rows.length > 0) throw new HttpError(409, 'esta rodada já foi paga: estorne o recebimento antes de cancelá-la');
    const gerente = !!(req.user.areas && req.user.areas.CancelarVendas);
    if (o.status !== 'novo' && !gerente) throw new HttpError(403, 'a rodada já está em preparo: só o gerente pode cancelar');
    if (o.status !== 'novo' && motivo.length < 3) throw new HttpError(400, 'informe o motivo do cancelamento (mínimo 3 caracteres)');
    const texto = motivo.length >= 3 ? motivo : 'cancelada pelo garçom antes do preparo';
    await client.query(`UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $1, atualizado_em = now() WHERE id = $2`, [texto, o.id]);
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', $3)`, [o.id, o.status, req.user.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'cancelar_pedido', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, motivo: texto, comanda_id: o.comanda_id, rodada: o.rodada } });
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, o.comanda_id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/garcom/comandas/:id/pedir-fechamento', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    if (c.status === 'fechamento_solicitado') throw new HttpError(409, 'o fechamento já foi pedido: o caixa já está avisado');
    if (c.status !== 'aberta') throw new HttpError(409, 'esta comanda está encerrada');
    const resumo = (await client.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'cancelado')::int AS ativas, COUNT(*) FILTER (WHERE status IN ('novo', 'em_preparo', 'pronto'))::int AS nao_entregues FROM orders WHERE comanda_id = $1`, [c.id]
    )).rows[0];
    if (resumo.ativas === 0) throw new HttpError(409, 'a comanda não tem pedidos: cancele a comanda em vez de pedir o fechamento');
    await client.query(`UPDATE comandas SET status = 'fechamento_solicitado', fechamento_solicitado_em = now() WHERE id = $1`, [c.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'pedir_fechamento_comanda', recurso: 'comandas', recursoId: c.id, detalhes: { identificador: c.identificador } });
    await client.query('COMMIT');
    const avisos = resumo.nao_entregues > 0 ? [`${resumo.nao_entregues} rodada(s) ainda não foram entregues ao cliente`] : [];
    res.json({ ...(await detalhe(pool, req.user, c.id)), avisos });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Transferir a comanda a outro garcom da mesma loja. O garcom de cada item ja lancado NAO muda (comissao de quem vendeu).
router.post('/garcom/comandas/:id/transferir', async (req, res) => {
  const paraId = (req.body || {}).para_user_id;
  if (!isUuid(paraId)) throw new HttpError(400, 'escolha o garçom que vai receber a comanda');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    if (!ABERTAS.includes(c.status)) throw new HttpError(409, 'só dá para transferir uma comanda aberta');
    if (c.aberta_por !== req.user.id && !(req.user.areas && req.user.areas.CancelarVendas)) throw new HttpError(403, 'só quem abriu a comanda (ou o gerente) pode transferi-la');
    const alvo = (await client.query(`SELECT id, nome, perfil, permissoes, location_id, ativo FROM users WHERE id = $1 AND tenant_id = $2`, [paraId, req.user.tenantId])).rows[0];
    if (!alvo || !alvo.ativo || alvo.perfil === 'Master') throw new HttpError(404, 'garçom não encontrado');
    const extras = (await client.query(`SELECT location_id FROM user_locations WHERE user_id = $1`, [alvo.id])).rows.map((r) => r.location_id);
    const alvoUser = { perfil: alvo.perfil, locationId: alvo.location_id, locationIds: [alvo.location_id, ...extras].filter(Boolean) };
    if (!areasEfetivas(alvo.perfil, alvo.permissoes).Garcom || !canAccessLocation(alvoUser, c.location_id)) throw new HttpError(400, 'este usuário não atende garçom nesta loja');
    if (alvo.id === c.aberta_por) throw new HttpError(409, 'a comanda já é deste garçom');
    await client.query(`UPDATE comandas SET aberta_por = $1 WHERE id = $2`, [alvo.id, c.id]);
    await client.query(`INSERT INTO comanda_garcons (comanda_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [c.id, alvo.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'transferir_comanda', recurso: 'comandas', recursoId: c.id, detalhes: { de: c.aberta_por, para: alvo.id, identificador: c.identificador } });
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, c.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Garcons para quem a comanda pode ser transferida (mesma loja, area Garcom).
router.get('/garcom/colegas', async (req, res) => {
  const lojas = filtroLocais(req.user, req.query.location_id);
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.perfil, u.permissoes, u.location_id,
            COALESCE((SELECT json_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id), '[]') AS extras
     FROM users u WHERE u.tenant_id = $1 AND u.ativo AND u.perfil <> 'Master' AND u.id <> $2 ORDER BY u.nome`,
    [req.user.tenantId, req.user.id]
  );
  const loja = req.query.location_id && isUuid(req.query.location_id) ? req.query.location_id : null;
  res.json(rows.filter((u) => areasEfetivas(u.perfil, u.permissoes).Garcom
    && (!loja || canAccessLocation({ perfil: u.perfil, locationIds: [u.location_id, ...u.extras].filter(Boolean) }, loja))).map((u) => ({ id: u.id, nome: u.nome, perfil: u.perfil })));
});

// Cancelar comanda sem consumo: o garcom que a abriu cancela uma comanda vazia; com pedidos servidos, so o caixa fecha.
router.post('/garcom/comandas/:id/cancelar', async (req, res) => {
  const motivo = String((req.body || {}).motivo || '').trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    if (!ABERTAS.includes(c.status)) throw new HttpError(409, 'esta comanda já está encerrada');
    const rod = (await client.query(`SELECT id, status FROM orders WHERE comanda_id = $1 AND status <> 'cancelado' FOR UPDATE`, [c.id])).rows;
    if ((await client.query(`SELECT 1 FROM comanda_pagamentos WHERE comanda_id = $1 AND status = 'confirmado'`, [c.id])).rows.length > 0) throw new HttpError(409, 'a comanda tem recebimentos: estorne-os antes de cancelar');
    if (rod.some((r) => r.status === 'entregue')) throw new HttpError(409, 'há pedidos entregues nesta comanda: ela precisa ser fechada no caixa');
    const gerente = !!(req.user.areas && req.user.areas.CancelarVendas);
    if (rod.length > 0 && !gerente) throw new HttpError(403, 'a comanda já tem pedidos: só o gerente pode cancelá-la');
    if (rod.length > 0 && motivo.length < 3) throw new HttpError(400, 'informe o motivo do cancelamento (mínimo 3 caracteres)');
    const texto = motivo.length >= 3 ? motivo : 'comanda aberta sem pedidos';
    for (const r of rod) {
      await client.query(`UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $1, atualizado_em = now() WHERE id = $2`, [texto, r.id]);
      await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', $3)`, [r.id, r.status, req.user.id]);
    }
    await client.query(`UPDATE comandas SET status = 'cancelada', motivo_cancelamento = $1, fechada_em = now(), fechada_por = $2 WHERE id = $3`, [texto, req.user.id, c.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'cancelar_comanda', recurso: 'comandas', recursoId: c.id, detalhes: { identificador: c.identificador, motivo: texto, rodadas_canceladas: rod.length } });
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, c.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Gerente volta a comanda de "fechamento solicitado" para aberta (o garcom pode lancar mais pedidos).
router.post('/garcom/comandas/:id/reabrir', requireArea('CancelarVendas'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    if (c.status !== 'fechamento_solicitado') throw new HttpError(409, 'só uma comanda que pediu fechamento pode ser reaberta');
    await client.query(`UPDATE comandas SET status = 'aberta', fechamento_solicitado_em = NULL WHERE id = $1`, [c.id]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'reabrir_comanda', recurso: 'comandas', recursoId: c.id, detalhes: { identificador: c.identificador } });
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, c.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ================================================================= receber no app (Fase 2)
// Recebe uma ou mais rodadas (inteiras) em Pix, cartao ou dinheiro. Exige a permissao ReceberNoApp, a loja liberada e a forma liberada.
router.post('/garcom/comandas/:id/receber', requireArea('ReceberNoApp'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    const pagamento = await recebimentos.confirmarRecebimento(client, req.user, c, req.body || {});
    await client.query('COMMIT');
    res.status(201).json({ pagamento, comanda: await detalhe(pool, req.user, c.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new HttpError(409, 'alguma dessas rodadas acabou de ser paga: atualize a comanda');
    throw err;
  } finally {
    client.release();
  }
});

// Estorno de um recebimento: so a gerencia, com motivo, enquanto a comanda nao esta paga e (dinheiro) antes da prestacao de contas.
router.post('/garcom/comandas/:id/receber/:pagamentoId/estornar', requireArea('CancelarVendas'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    await recebimentos.estornarRecebimento(client, req.user, c, req.params.pagamentoId, (req.body || {}).motivo);
    await client.query('COMMIT');
    res.json(await detalhe(pool, req.user, c.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Encerra a comanda TODA paga no app: uma venda (com as partes pagas) sem passar pelo caixa, no terminal de comandas da loja.
router.post('/garcom/comandas/:id/encerrar', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    if (!ABERTAS.includes(c.status)) throw new HttpError(409, c.status === 'paga' ? 'esta comanda já foi encerrada' : 'esta comanda está cancelada');
    const rodadas = await recebimentos.rodadasDaComanda(client, c.id, { travar: true });
    if (rodadas.length === 0) throw new HttpError(409, 'a comanda não tem pedidos: cancele-a');
    if (rodadas.some((r) => !r.pagamento_id)) throw new HttpError(409, 'ainda há rodadas não pagas: receba-as ou peça o fechamento no caixa');
    const terminalId = await recebimentos.terminalParaEncerrar(client, req.user, c);
    const venda = await recebimentos.fecharComanda(client, req.user, c, { terminalId, origem: 'garcom' });
    await client.query('COMMIT');
    res.json({ comanda: await detalhe(pool, req.user, c.id), venda });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// "Meu extrato": comandas fechadas (pagas) em que o garcom vendeu itens, com o total dele (sem comissao: Fase 3).
router.get('/garcom/extrato', async (req, res) => {
  const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de || '')) ? req.query.de : null;
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate || '')) ? req.query.ate : null;
  const { rows } = await pool.query(
    `SELECT c.id, c.numero, c.tipo, c.identificador, c.cliente_nome, c.fechada_em, s.total AS total_comanda,
            COALESCE(SUM(si.subtotal) FILTER (WHERE si.garcom_id = $2), 0) AS meu_total
     FROM comandas c JOIN sales s ON s.id = c.sale_id JOIN sale_items si ON si.sale_id = s.id
     WHERE c.tenant_id = $1 AND c.status = 'paga'
       AND (c.fechada_em AT TIME ZONE '${FUSO}')::date >= COALESCE($3::date, (now() AT TIME ZONE '${FUSO}')::date)
       AND (c.fechada_em AT TIME ZONE '${FUSO}')::date <= COALESCE($4::date, (now() AT TIME ZONE '${FUSO}')::date)
     GROUP BY c.id, s.total
     HAVING COALESCE(SUM(si.subtotal) FILTER (WHERE si.garcom_id = $2), 0) > 0
     ORDER BY c.fechada_em DESC`,
    [req.user.tenantId, req.user.id, de, ate]
  );
  const ab = await pool.query(
    `SELECT COALESCE(SUM(oi.subtotal), 0) AS total, COUNT(DISTINCT o.comanda_id)::int AS comandas
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN comandas c ON c.id = o.comanda_id
     WHERE c.tenant_id = $1 AND c.status IN ('aberta', 'fechamento_solicitado') AND o.status <> 'cancelado' AND oi.garcom_id = $2`,
    [req.user.tenantId, req.user.id]
  );
  const recebidos = (await pool.query(
    `SELECT cp.id, cp.comanda_id, c.numero AS comanda_numero, c.identificador, cp.forma, cp.valor_produtos, cp.taxa_servico, cp.recebido_em, cp.status,
            cp.prestado_em, cp.diferenca_prestacao
     FROM comanda_pagamentos cp JOIN comandas c ON c.id = cp.comanda_id
     WHERE cp.tenant_id = $1 AND cp.recebido_por = $2 AND cp.status = 'confirmado'
       AND (cp.recebido_em AT TIME ZONE '${FUSO}')::date >= COALESCE($3::date, (now() AT TIME ZONE '${FUSO}')::date)
       AND (cp.recebido_em AT TIME ZONE '${FUSO}')::date <= COALESCE($4::date, (now() AT TIME ZONE '${FUSO}')::date)
     ORDER BY cp.recebido_em DESC`,
    [req.user.tenantId, req.user.id, de, ate]
  )).rows;
  // Dinheiro que ainda esta com o garcom (de qualquer dia): recebimentos em dinheiro confirmados e nao entregues ao caixa.
  const comigo = await recebimentos.pendenciasDeDinheiro(pool, req.user.tenantId, { garcomId: req.user.id });
  res.json({
    pagas: rows,
    total_vendido: rows.reduce((s, r) => s + Number(r.meu_total), 0),
    em_aberto: { total: Number(ab.rows[0].total), comandas: ab.rows[0].comandas },
    recebidos_na_hora: recebidos.map((r) => ({ ...r, total: Number((Number(r.valor_produtos) + Number(r.taxa_servico)).toFixed(2)) })),
    dinheiro_comigo: Number(comigo.reduce((s, p) => s + p.total, 0).toFixed(2)),
  });
});

// ================================================================= caixa: comandas
router.get('/comandas', async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'c.tenant_id = $1';
  const lojas = filtroLocais(req.user, req.query.location_id);
  if (lojas) { params.push(lojas); where += ` AND c.location_id = ANY($${params.length}::uuid[])`; }
  const status = String(req.query.status || 'abertas');
  if (status === 'abertas') where += ` AND c.status IN ('aberta', 'fechamento_solicitado')`;
  else if (['aberta', 'fechamento_solicitado', 'paga', 'cancelada'].includes(status)) { params.push(status); where += ` AND c.status = $${params.length}`; }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where += ` AND (c.identificador ILIKE $${params.length} OR c.cliente_nome ILIKE $${params.length} OR c.numero::text ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(
    `${SELECT_COMANDA} WHERE ${where} ORDER BY (c.status = 'fechamento_solicitado') DESC, COALESCE(c.fechamento_solicitado_em, c.aberta_em) DESC LIMIT 200`, params
  );
  res.json(rows);
});

// ---------- prestacao de contas do dinheiro que ficou com os garcons (caixa/gerencia, area Vendas)
// Fica sob /comandas (area Vendas) e nao sob /garcom: quem presta contas e recebido pelo caixa, que nao tem a area Garcom.
router.get('/comandas/prestacao', async (req, res) => {
  const lojas = filtroLocais(req.user, req.query.location_id);
  const pend = await recebimentos.pendenciasDeDinheiro(pool, req.user.tenantId, { locais: lojas });
  const porGarcom = new Map();
  for (const p of pend) {
    if (!porGarcom.has(p.garcom_id)) porGarcom.set(p.garcom_id, { garcom_id: p.garcom_id, garcom_nome: p.garcom_nome, total: 0, recebimentos: [] });
    const g = porGarcom.get(p.garcom_id);
    g.total = Number((g.total + p.total).toFixed(2));
    g.recebimentos.push(p);
  }
  // Recebido na hora hoje, por forma (Pix e cartao ja estao no sistema; dinheiro entra ao prestar contas).
  const hoje = (await pool.query(
    `SELECT cp.forma, COUNT(*)::int AS recebimentos, COALESCE(SUM(cp.valor_produtos + cp.taxa_servico), 0) AS total,
            COALESCE(SUM(cp.valor_produtos + cp.taxa_servico) FILTER (WHERE cp.prestado_em IS NULL), 0) AS pendente
     FROM comanda_pagamentos cp
     WHERE cp.tenant_id = $1 AND cp.status = 'confirmado' AND ($2::uuid[] IS NULL OR cp.location_id = ANY($2::uuid[]))
       AND (cp.recebido_em AT TIME ZONE '${FUSO}')::date = (now() AT TIME ZONE '${FUSO}')::date
     GROUP BY cp.forma`,
    [req.user.tenantId, lojas]
  )).rows.map((r) => ({ ...r, total: Number(r.total), pendente: Number(r.pendente) }));
  const recentes = (await pool.query(
    `SELECT cp.id, cp.comanda_id, c.numero AS comanda_numero, c.identificador, cp.forma, (cp.valor_produtos + cp.taxa_servico) AS total, cp.recebido_em, cp.status,
            cp.prestado_em, cp.diferenca_prestacao, u.nome AS garcom_nome
     FROM comanda_pagamentos cp JOIN comandas c ON c.id = cp.comanda_id JOIN users u ON u.id = cp.recebido_por
     WHERE cp.tenant_id = $1 AND ($2::uuid[] IS NULL OR cp.location_id = ANY($2::uuid[])) AND cp.recebido_em > now() - interval '3 days'
     ORDER BY cp.recebido_em DESC LIMIT 100`,
    [req.user.tenantId, lojas]
  )).rows.map((r) => ({ ...r, total: Number(r.total) }));
  res.json({
    garcons: [...porGarcom.values()],
    dinheiro_com_garcons: Number(pend.reduce((s, p) => s + p.total, 0).toFixed(2)),
    hoje, recebimentos: recentes,
  });
});

router.post('/comandas/prestacao', async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await recebimentos.receberPrestacao(client, req.user, {
      garcomId: b.garcom_id, valorConferido: b.valor_conferido, terminalId: b.terminal_id, pagamentoIds: b.pagamento_ids, locais: filtroLocais(req.user, null),
    });
    await client.query('COMMIT');
    res.json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/comandas/:id', async (req, res) => {
  const c = await carregarComanda(pool, req.user, req.params.id);
  res.json(await detalhe(pool, req.user, c.id));
});

// Fecha a comanda no caixa: UMA venda com todos os itens das rodadas nao canceladas. Cobra so o RESTANTE (o que o garcom ja recebeu
// no app entra como parte paga), aceita uma forma (forma_pagamento) ou varias (pagamentos: [{ forma, valor, valor_recebido? }]),
// desconto so sobre o restante e taxa de servico opcional (cobrar_taxa). A reserva das rodadas vira baixa definitiva.
router.post('/comandas/:id/fechar', async (req, res) => {
  const b = req.body || {};
  const desconto = Number(b.desconto || 0);
  if (!(desconto >= 0)) throw new HttpError(400, 'desconto deve ser um valor em reais (0 ou mais)');
  if (desconto > 0 && !(req.user.areas && req.user.areas.Desconto)) throw new HttpError(403, 'seu usuário não tem permissão para dar desconto');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await carregarComanda(client, req.user, req.params.id, { travar: true });
    assertLocationAccess(req.user, c.location_id, 'fechar comandas desta loja');
    const venda = await recebimentos.fecharComanda(client, req.user, c, {
      terminalId: b.terminal_id, forma_pagamento: b.forma_pagamento, valor_recebido: b.valor_recebido, pagamentos: b.pagamentos, desconto, cobrar_taxa: !!b.cobrar_taxa,
    });
    await client.query('COMMIT');
    res.json({ comanda: await detalhe(pool, req.user, c.id), venda });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
