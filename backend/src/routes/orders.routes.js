const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess, filtroLocais } = require('../utils/access');
const { HttpError } = require('../utils/http');
const { configEfetiva } = require('../utils/cupom');
const { registrarVenda } = require('../services/vendas');
const { criarPedido, ORIGENS } = require('../services/pedidos');
const comum = require('../integracoes/comum');
const { FUSO } = require('../utils/query');
const { inserirCliente } = require('./customers.routes');

const router = express.Router();
router.use(['/orders', '/couriers'], requireArea('Pedidos'));

const FLUXO = {
  novo: ['em_preparo'],
  em_preparo: ['pronto'],
  pronto: ['saiu_entrega', 'finalizado'], // retirada vai direto a finalizado; entrega passa por saiu_entrega
  saiu_entrega: ['finalizado'],
};

const SELECT_PEDIDO = `
  SELECT o.id, o.numero, o.location_id, l.nome AS location_nome, o.origem, o.origem_externa_id, o.codigo_externo, o.desconto, o.cliente_nome, o.cliente_telefone,
         o.comanda_id, o.rodada, cm.numero AS comanda_numero, cm.tipo AS comanda_tipo,
         (SELECT gu.nome FROM order_items oi2 JOIN users gu ON gu.id = oi2.garcom_id WHERE oi2.order_id = o.id LIMIT 1) AS garcom_nome,
         o.tipo, o.endereco, o.taxa_entrega, o.observacao, o.forma_pagamento_prevista, o.pago, o.status,
         o.entregador_id, c.nome AS entregador_nome, o.sale_id, o.criado_por, u.nome AS criado_por_nome, o.customer_id, o.valor_recebido,
         o.criado_em, o.atualizado_em, o.finalizado_em, o.cancelado_em, o.motivo_cancelamento,
         COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega - o.desconto AS total,
         (SELECT json_build_object('id', pe.id, 'plataforma', pe.plataforma, 'confirmado', pe.confirmado, 'status_externo', pe.status_externo,
                 'entrega_pela_plataforma', pe.entrega_pela_plataforma, 'faltas_estoque', pe.faltas_estoque, 'disputa', pe.disputa)
            FROM pedidos_externos pe WHERE pe.order_id = o.id LIMIT 1) AS externo,
         COALESCE((SELECT MAX(sl.criado_em) FROM order_status_log sl WHERE sl.order_id = o.id), o.criado_em) AS etapa_desde,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE((SELECT MAX(sl.criado_em) FROM order_status_log sl WHERE sl.order_id = o.id), o.criado_em))) / 60))::int AS minutos_etapa
  FROM orders o
  JOIN locations l ON l.id = o.location_id
  LEFT JOIN couriers c ON c.id = o.entregador_id
  LEFT JOIN comandas cm ON cm.id = o.comanda_id
  LEFT JOIN users u ON u.id = o.criado_por`;

async function itensDoPedido(db, orderId) {
  const { rows } = await db.query(
    `SELECT oi.id, oi.product_id, p.nome AS product_nome, p.codigo_interno, p.unidade, oi.quantidade, oi.preco_unitario, oi.subtotal, oi.observacao,
            COALESCE(oi.complementos, '[]'::jsonb) AS complementos,
            (EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id) OR EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id)
              OR oi.complementos IS NOT NULL) AS preparo
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY p.nome, oi.id`,
    [orderId]
  );
  return rows;
}

async function pedidoCompleto(db, tenantId, id) {
  const { rows } = await db.query(`${SELECT_PEDIDO} WHERE o.id = $1 AND o.tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'pedido não encontrado');
  const pedido = rows[0];
  const log = await db.query(
    `SELECT sl.de, sl.para, sl.criado_em, u.nome AS usuario_nome FROM order_status_log sl
     LEFT JOIN users u ON u.id = sl.usuario_id WHERE sl.order_id = $1 ORDER BY sl.criado_em, sl.id`,
    [id]
  );
  const cfg = await db.query(
    `SELECT l.cupom_config, t.nome AS empresa_nome FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1`,
    [pedido.location_id]
  );
  return {
    ...pedido,
    itens: await itensDoPedido(db, id),
    log: log.rows,
    empresa_nome: cfg.rows[0].empresa_nome,
    cupom_config: configEfetiva(cfg.rows[0].cupom_config),
  };
}

// ---------- lista (quadro e lista) ----------
// Sem filtro de status/data: pedidos em aberto + finalizados hoje (o quadro). Com status ou periodo: o que foi pedido.
router.get('/orders', async (req, res) => {
  const { location_id, status, origem, q, de, ate } = req.query;
  const params = [req.user.tenantId];
  let where = 'o.tenant_id = $1';
  const locais = filtroLocais(req.user, location_id);
  if (locais) {
    params.push(locais);
    where += ` AND o.location_id = ANY($${params.length}::uuid[])`;
  }
  if (origem && ORIGENS.includes(origem)) {
    params.push(origem);
    where += ` AND o.origem = $${params.length}`;
  }
  if (q) {
    params.push(`%${String(q).trim()}%`);
    where += ` AND (o.numero::text ILIKE $${params.length} OR o.cliente_nome ILIKE $${params.length} OR o.cliente_telefone ILIKE $${params.length})`;
  }
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  if (de) {
    params.push(de);
    where += ` AND (o.criado_em AT TIME ZONE '${FUSO}')::date >= $${params.length}::date`;
  }
  if (ate) {
    params.push(ate);
    where += ` AND (o.criado_em AT TIME ZONE '${FUSO}')::date <= $${params.length}::date`;
  }
  if (!status && !de && !ate) {
    where += ` AND (o.status NOT IN ('finalizado', 'cancelado')
                 OR (o.status = 'finalizado' AND (o.finalizado_em AT TIME ZONE '${FUSO}')::date = (now() AT TIME ZONE '${FUSO}')::date))`;
  }
  const { rows } = await pool.query(
    `${SELECT_PEDIDO} WHERE ${where} ORDER BY o.criado_em DESC LIMIT 300`,
    params
  );
  const ids = rows.map((r) => r.id);
  const itens = ids.length === 0 ? { rows: [] } : await pool.query(
    `SELECT oi.order_id, p.nome AS product_nome, oi.quantidade, oi.observacao FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1::uuid[]) ORDER BY p.nome, oi.id`,
    [ids]
  );
  const porPedido = new Map();
  for (const it of itens.rows) {
    if (!porPedido.has(it.order_id)) porPedido.set(it.order_id, []);
    porPedido.get(it.order_id).push(it);
  }
  res.json(rows.map((r) => ({ ...r, itens: porPedido.get(r.id) || [] })));
});

router.get('/orders/:id', async (req, res) => {
  await getOwned(pool, 'orders', req.params.id, req.user.tenantId);
  const pedido = await pedidoCompleto(pool, req.user.tenantId, req.params.id);
  assertLocationAccess(req.user, pedido.location_id, 'ver pedidos desta loja');
  res.json(pedido);
});

// ---------- criar ----------
router.post('/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await criarPedido(client, req.user, req.body || {}, { inserirCliente });
    await client.query('COMMIT');
    res.status(201).json({ ...(await pedidoCompleto(pool, req.user.tenantId, r.orderId)), cliente_novo: r.clienteNovo });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------- entregador ----------
router.put('/orders/:id/entregador', async (req, res) => {
  const pedido = await getOwned(pool, 'orders', req.params.id, req.user.tenantId, { columns: 'id, location_id, status, tipo' });
  assertLocationAccess(req.user, pedido.location_id, 'alterar pedidos desta loja');
  if (pedido.tipo !== 'entrega') throw new HttpError(400, 'este pedido é de retirada');
  if (['finalizado', 'cancelado'].includes(pedido.status)) throw new HttpError(400, 'pedido encerrado');
  const entregadorId = req.body && req.body.entregador_id ? req.body.entregador_id : null;
  if (entregadorId) await getOwned(pool, 'couriers', entregadorId, req.user.tenantId, { columns: 'id, ativo' });
  await pool.query(`UPDATE orders SET entregador_id = $1, atualizado_em = now() WHERE id = $2 AND tenant_id = $3`, [entregadorId, req.params.id, req.user.tenantId]);
  res.json(await pedidoCompleto(pool, req.user.tenantId, req.params.id));
});

// ---------- destino (retirada / entrega / mesa) ----------
// O cliente pode mudar de ideia enquanto o pedido esta aberto. Entrega exige endereco; mesa exige a mesa.
router.put('/orders/:id/destino', async (req, res) => {
  const pedido = await getOwned(pool, 'orders', req.params.id, req.user.tenantId, { columns: 'id, numero, location_id, status, tipo, comanda_id' });
  assertLocationAccess(req.user, pedido.location_id, 'alterar pedidos desta loja');
  if (pedido.comanda_id) throw new HttpError(409, 'rodada de comanda: o destino é a mesa/pista da comanda e não muda por aqui');
  if (['finalizado', 'cancelado'].includes(pedido.status)) throw new HttpError(400, 'pedido encerrado: não dá mais para mudar o destino');
  if (pedido.status === 'saiu_entrega') throw new HttpError(400, 'o pedido já saiu para entrega');
  const b = req.body || {};
  const tipo = ['retirada', 'entrega', 'mesa'].includes(b.tipo) ? b.tipo : null;
  if (!tipo) throw new HttpError(400, 'destino inválido');
  const endereco = String(b.endereco || '').trim().slice(0, 300);
  if (tipo === 'entrega' && endereco.length < 3) throw new HttpError(400, 'informe o endereço da entrega');
  if (tipo === 'mesa' && endereco.length < 1) throw new HttpError(400, 'informe a mesa');
  const taxa = tipo === 'entrega' ? Number(b.taxa_entrega || 0) : 0;
  if (!(taxa >= 0)) throw new HttpError(400, 'taxa de entrega inválida');
  await pool.query(
    `UPDATE orders SET tipo = $1, endereco = $2, taxa_entrega = $3, entregador_id = CASE WHEN $1 = 'entrega' THEN entregador_id ELSE NULL END, atualizado_em = now()
     WHERE id = $4 AND tenant_id = $5`,
    [tipo, tipo === 'retirada' ? '' : endereco, taxa, req.params.id, req.user.tenantId]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'alterar_destino_pedido', recurso: 'orders', recursoId: req.params.id, detalhes: { numero: pedido.numero, de: pedido.tipo, para: tipo } });
  res.json(await pedidoCompleto(pool, req.user.tenantId, req.params.id));
});

// ---------- avancar status ----------
// novo -> em_preparo -> pronto -> (entrega: saiu_entrega -> finalizado | retirada: finalizado).
// Finalizar converte a reserva em baixa definitiva: gera a venda (estoque/insumos baixam, entra no caixa).
router.post('/orders/:id/status', async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    );
    if (rows.length === 0) throw new HttpError(404, 'pedido não encontrado');
    const o = rows[0];
    assertLocationAccess(req.user, o.location_id, 'alterar pedidos desta loja');
    const para = b.para;
    if (para === 'cancelado') throw new HttpError(400, 'use a rota de cancelamento');
    // Entrega feita pela plataforma (iFood/99Food): a loja nao despacha (sem entregador proprio); de pronto vai direto a finalizado.
    const entregaPlataforma = o.origem_externa_id
      ? !!(await client.query(`SELECT entrega_pela_plataforma FROM pedidos_externos WHERE order_id = $1`, [o.id])).rows.some((r) => r.entrega_pela_plataforma)
      : false;
    // Rodada de comanda: novo -> em_preparo -> pronto -> entregue. NUNCA gera venda (a venda unica nasce no fechamento da comanda).
    if (o.comanda_id && para === 'finalizado') throw new HttpError(409, 'rodada de comanda não é finalizada aqui: a comanda é fechada no caixa (Comandas)');
    const permitidos = (o.comanda_id ? ({ novo: ['em_preparo'], em_preparo: ['pronto'], pronto: ['entregue'] })[o.status] || [] : FLUXO[o.status] || []).filter((s) => {
      if (o.comanda_id) return true;
      if (o.status === 'pronto') return o.tipo === 'entrega' && !entregaPlataforma ? s === 'saiu_entrega' : s === 'finalizado';
      return true;
    });
    if (!permitidos.includes(para)) {
      throw new HttpError(409, `não é possível ir de "${o.status}" para "${para}" neste pedido`);
    }

    let entregadorId = o.entregador_id;
    if (para === 'saiu_entrega') {
      entregadorId = b.entregador_id || o.entregador_id;
      if (!entregadorId) throw new HttpError(400, 'escolha o entregador antes de sair para a entrega');
      await getOwned(client, 'couriers', entregadorId, req.user.tenantId, { columns: 'id, ativo' });
    }

    let saleId = o.sale_id;
    let pago = o.pago;
    if (para === 'finalizado') {
      // Caixa: o do usuario se ele tiver um aberto nesta loja; senao qualquer caixa aberto da loja.
      let terminalId = b.terminal_id || null;
      if (!terminalId) {
        const cx = await client.query(
          `SELECT t.id FROM cash_sessions cs
           JOIN cash_registers cr ON cr.id = cs.cash_register_id
           JOIN terminals t ON t.id = cr.terminal_id
           WHERE t.location_id = $1 AND t.tenant_id = $2 AND t.ativo AND cs.fechado_em IS NULL
           ORDER BY (cs.usuario_abertura_id = $3) DESC, cs.aberto_em DESC LIMIT 1`,
          [o.location_id, req.user.tenantId, req.user.id]
        );
        if (cx.rows.length === 0) throw new HttpError(400, 'nenhum caixa aberto nesta loja: abra o caixa no PDV para finalizar o pedido');
        terminalId = cx.rows[0].id;
      }
      const itens = await client.query(`SELECT product_id, quantidade, observacao, preco_unitario, complementos FROM order_items WHERE order_id = $1`, [o.id]);
      const externo = !!o.origem_externa_id; // pedido de plataforma: vale o preco e o desconto da plataforma
      let forma = b.forma_pagamento;
      if (o.pago) {
        const prev = o.forma_pagamento_prevista;
        forma = prev === 'online' ? 'online' : prev === 'dinheiro' ? 'dinheiro' : prev === 'cartao' ? (b.forma_pagamento || 'cartao_credito') : ['cartao_credito', 'cartao_debito'].includes(prev) ? prev : 'pix';
      } else if (!forma && externo && o.forma_pagamento_prevista && o.forma_pagamento_prevista !== 'cartao') {
        forma = o.forma_pagamento_prevista; // cobrado na entrega: a forma ja veio da plataforma
      }
      if (!forma) throw new HttpError(400, 'informe a forma de pagamento para finalizar');
      const venda = await registrarVenda(client, req.user, {
        terminal_id: terminalId,
        itens: itens.rows.map((i) => ({
          product_id: i.product_id, quantidade: Number(i.quantidade), observacao: i.observacao, complementos: Array.isArray(i.complementos) ? i.complementos : [],
          ...(externo ? { preco_unitario: Number(i.preco_unitario) } : {}),
        })),
        forma_pagamento: forma,
        valor_recebido: (o.pago || externo) && forma === 'dinheiro' && b.valor_recebido === undefined ? (o.valor_recebido === null ? undefined : Number(o.valor_recebido)) : b.valor_recebido,
        desconto: externo ? Number(o.desconto || 0) : 0,
        precos_informados: externo,
        taxa_entrega: Number(o.taxa_entrega),
        numero_pedido: o.numero,
        ignorar_pedido_id: o.id,
      });
      saleId = venda.id;
      pago = true;
    }

    // Pedido do iFood/99Food: avisa a plataforma ANTES de gravar (se ela recusar, nada muda aqui). Nunca no modo teste.
    if ((o.origem === 'ifood' || o.origem === '99food') && o.origem_externa_id && !req.user.modoTeste) {
      await comum.plataforma(o.origem).aoMudarStatus({ ...o, entregador_id: entregadorId }, para);
    }

    await client.query(
      `UPDATE orders SET status = $1, entregador_id = $2, sale_id = $3, pago = $4, atualizado_em = now(),
              finalizado_em = CASE WHEN $1 = 'finalizado' THEN now() ELSE finalizado_em END
       WHERE id = $5 AND tenant_id = $6`,
      [para, entregadorId, saleId, pago, o.id, req.user.tenantId]
    );
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, $3, $4)`, [o.id, o.status, para, req.user.id]);
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'pedido_status', recurso: 'orders', recursoId: o.id,
      detalhes: { numero: o.numero, de: o.status, para, sale_id: saleId },
    });
    await client.query('COMMIT');
    res.json(await pedidoCompleto(pool, req.user.tenantId, o.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------- cancelar ----------
router.post('/orders/:id/cancel', async (req, res) => {
  const motivo = String((req.body && req.body.motivo) || '').trim();
  if (motivo.length < 3) throw new HttpError(400, 'motivo do cancelamento é obrigatório (mínimo 3 caracteres)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id, numero, status, location_id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, req.user.tenantId]);
    if (rows.length === 0) throw new HttpError(404, 'pedido não encontrado');
    const o = rows[0];
    assertLocationAccess(req.user, o.location_id, 'cancelar pedidos desta loja');
    if (o.status === 'finalizado') throw new HttpError(409, 'o pedido já foi finalizado: cancele pela venda (Relatórios), que devolve o estoque');
    if (o.status === 'cancelado') throw new HttpError(400, 'este pedido já foi cancelado');
    if ((await client.query(`SELECT 1 FROM comanda_pagamento_rodadas WHERE order_id = $1`, [o.id])).rows.length > 0) throw new HttpError(409, 'esta rodada já foi paga no app: um gerente precisa estornar o recebimento antes (Comandas)');
    // Pedido do iFood/99Food com a loja conectada: o cancelamento e pedido a plataforma (motivo da lista dela); o pedido
    // daqui e cancelado quando ela confirmar, liberando a reserva de estoque.
    if (!req.user.modoTeste) {
      const pe = await comum.pedidoExternoDoPedido(req.user.tenantId, o.id);
      const integ = pe && pe.integracao_id ? (await client.query(`SELECT status FROM integracoes_delivery WHERE id = $1`, [pe.integracao_id])).rows[0] : null;
      if (pe && integ && integ.status === 'conectado' && pe.status_externo !== 'CANCELLED') {
        await client.query('ROLLBACK');
        await comum.plataforma(pe.plataforma).solicitarCancelamento(req.user, pe, (req.body || {}).codigo_motivo, motivo);
        return res.json(await pedidoCompleto(pool, req.user.tenantId, o.id));
      }
    }
    await client.query(
      `UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $1, atualizado_em = now() WHERE id = $2 AND tenant_id = $3`,
      [motivo, o.id, req.user.tenantId]
    );
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', $3)`, [o.id, o.status, req.user.id]);
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'cancelar_pedido', recurso: 'orders', recursoId: o.id,
      detalhes: { numero: o.numero, motivo },
    });
    await client.query('COMMIT');
    res.json(await pedidoCompleto(pool, req.user.tenantId, o.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------- entregadores ----------
router.get('/couriers', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, telefone, ativo FROM couriers WHERE tenant_id = $1 ${req.query.todos ? '' : 'AND ativo'} ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

// Telefone do entregador (opcional; a 99Food mostra ao cliente quando a loja entrega).
function telefoneDe(b) {
  const t = String((b && b.telefone) || '').replace(/\D/g, '');
  if (t && (t.length < 10 || t.length > 13)) throw new HttpError(400, 'telefone do entregador inválido (DDD + número)');
  return t || null;
}

router.post('/couriers', async (req, res) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  if (nome.length < 2) throw new HttpError(400, 'nome do entregador deve ter ao menos 2 caracteres');
  const { rows } = await pool.query(`INSERT INTO couriers (tenant_id, nome, telefone) VALUES ($1, $2, $3) RETURNING id, nome, telefone, ativo`, [req.user.tenantId, nome.slice(0, 80), telefoneDe(req.body)]);
  res.status(201).json(rows[0]);
});

router.patch('/couriers/:id', async (req, res) => {
  const atual = await getOwned(pool, 'couriers', req.params.id, req.user.tenantId, { columns: 'id, nome, telefone, ativo' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? String(b.nome).trim() : atual.nome;
  if (nome.length < 2) throw new HttpError(400, 'nome do entregador deve ter ao menos 2 caracteres');
  const ativo = b.ativo !== undefined ? !!b.ativo : atual.ativo;
  const telefone = b.telefone !== undefined ? telefoneDe(b) : atual.telefone;
  const { rows } = await pool.query(`UPDATE couriers SET nome = $1, ativo = $2, telefone = $5 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, telefone, ativo`, [nome.slice(0, 80), ativo, req.params.id, req.user.tenantId, telefone]);
  res.json(rows[0]);
});

module.exports = router;
