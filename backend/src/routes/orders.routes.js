const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess, filtroLocais } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { configEfetiva } = require('../utils/cupom');
const { reservadosDaLoja } = require('../utils/reservas');
const { registrarVenda } = require('../services/vendas');
const { FUSO } = require('../utils/query');
const { inserirCliente, apenasDigitos } = require('./customers.routes');

const router = express.Router();
router.use(['/orders', '/couriers'], requireArea('Pedidos'));

const ORIGENS = ['balcao', 'telefone', 'whatsapp', 'ifood', '99food'];
const FORMAS_PREVISTAS = ['dinheiro', 'cartao', 'cartao_debito', 'cartao_credito', 'pix'];
const FLUXO = {
  novo: ['em_preparo'],
  em_preparo: ['pronto'],
  pronto: ['saiu_entrega', 'finalizado'], // retirada vai direto a finalizado; entrega passa por saiu_entrega
  saiu_entrega: ['finalizado'],
};

// Pedido numerado por loja com o mesmo contador da comanda (recomeca quando um caixa abre num novo turno).
async function proximoNumero(client, tenantId, locationId) {
  const { rows } = await client.query(
    `INSERT INTO location_order_counters (location_id, tenant_id, ultimo) VALUES ($1, $2, 1)
     ON CONFLICT (location_id) DO UPDATE SET ultimo = location_order_counters.ultimo + 1 RETURNING ultimo`,
    [locationId, tenantId]
  );
  return rows[0].ultimo;
}

const SELECT_PEDIDO = `
  SELECT o.id, o.numero, o.location_id, l.nome AS location_nome, o.origem, o.origem_externa_id, o.cliente_nome, o.cliente_telefone,
         o.tipo, o.endereco, o.taxa_entrega, o.observacao, o.forma_pagamento_prevista, o.pago, o.status,
         o.entregador_id, c.nome AS entregador_nome, o.sale_id, o.criado_por, u.nome AS criado_por_nome, o.customer_id, o.valor_recebido,
         o.criado_em, o.atualizado_em, o.finalizado_em, o.cancelado_em, o.motivo_cancelamento,
         COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega AS total,
         COALESCE((SELECT MAX(sl.criado_em) FROM order_status_log sl WHERE sl.order_id = o.id), o.criado_em) AS etapa_desde,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE((SELECT MAX(sl.criado_em) FROM order_status_log sl WHERE sl.order_id = o.id), o.criado_em))) / 60))::int AS minutos_etapa
  FROM orders o
  JOIN locations l ON l.id = o.location_id
  LEFT JOIN couriers c ON c.id = o.entregador_id
  LEFT JOIN users u ON u.id = o.criado_por`;

async function itensDoPedido(db, orderId) {
  const { rows } = await db.query(
    `SELECT oi.id, oi.product_id, p.nome AS product_nome, p.codigo_interno, p.unidade, oi.quantidade, oi.preco_unitario, oi.subtotal, oi.observacao,
            EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id) AS preparo
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
  const b = req.body || {};
  const locationId = b.location_id;
  if (!isUuid(locationId)) throw new HttpError(400, 'location_id (loja) é obrigatório');
  const origem = b.origem || 'balcao';
  if (!ORIGENS.includes(origem)) throw new HttpError(400, 'origem inválida');
  const tipo = ['entrega', 'mesa'].includes(b.tipo) ? b.tipo : 'retirada';
  if (!Array.isArray(b.itens) || b.itens.length === 0) throw new HttpError(400, 'adicione ao menos um item ao pedido');
  const endereco = String(b.endereco || '').trim().slice(0, 300);
  if (tipo === 'entrega' && endereco.length < 3) throw new HttpError(400, 'informe o endereço da entrega');
  if (tipo === 'mesa' && endereco.length < 1) throw new HttpError(400, 'informe a mesa');
  const taxa = tipo === 'entrega' ? Number(b.taxa_entrega || 0) : 0;
  if (!(taxa >= 0)) throw new HttpError(400, 'taxa de entrega inválida');
  const forma = b.forma_pagamento_prevista === undefined || b.forma_pagamento_prevista === null ? null : String(b.forma_pagamento_prevista);
  if (forma !== null && !FORMAS_PREVISTAS.includes(forma)) throw new HttpError(400, 'forma de pagamento prevista inválida');
  const pago = !!b.pago;
  const valorRecebido = pago && forma === 'dinheiro' && b.valor_recebido !== undefined && b.valor_recebido !== null && b.valor_recebido !== '' ? Number(b.valor_recebido) : null;
  if (valorRecebido !== null && !(valorRecebido >= 0)) throw new HttpError(400, 'valor recebido inválido');

  const linhas = b.itens.map((i) => {
    if (!i || !isUuid(i.product_id) || !(Number(i.quantidade) > 0)) throw new HttpError(400, 'cada item precisa de product_id válido e quantidade (>0)');
    return { product_id: i.product_id, quantidade: Number(i.quantidade), observacao: String(i.observacao || '').trim().slice(0, 200) };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loja = await getOwned(client, 'locations', locationId, req.user.tenantId, { columns: 'id, nome, ativo, usa_pedidos' });
    if (!loja.ativo) throw new HttpError(400, 'esta loja está inativa');
    if (!loja.usa_pedidos) throw new HttpError(400, 'esta loja não usa pedidos (ative em Lojas & PDVs)');
    assertLocationAccess(req.user, locationId, 'criar pedidos nesta loja');

    const ids = [...new Set(linhas.map((l) => l.product_id))];
    const produtos = await client.query(
      `SELECT id, nome, unidade, preco_venda, ativo FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id`,
      [ids, req.user.tenantId]
    );
    const mapa = new Map(produtos.rows.map((p) => [p.id, p]));
    for (const l of linhas) {
      const p = mapa.get(l.product_id);
      if (!p || !p.ativo) throw new HttpError(400, 'produto não encontrado ou inativo');
      if (!isQuantidadeValidaParaUnidade(l.quantidade, p.unidade)) throw new HttpError(400, `"${p.nome}" é vendido em ${p.unidade} e só aceita quantidade inteira`);
    }

    const fichas = await client.query(
      `SELECT pi.product_id, pi.ingredient_id, pi.quantidade_por_unidade, i.nome AS insumo_nome
       FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.tenant_id = $1 AND pi.product_id = ANY($2::uuid[])`,
      [req.user.tenantId, ids]
    );
    const fichaPor = new Map();
    for (const r of fichas.rows) {
      if (!fichaPor.has(r.product_id)) fichaPor.set(r.product_id, []);
      fichaPor.get(r.product_id).push(r);
    }

    // Trava os saldos envolvidos (sempre em ordem) para que dois pedidos simultaneos nao reservem o mesmo estoque.
    const simples = ids.filter((id) => !fichaPor.has(id));
    const insumoIds = [...new Set(fichas.rows.map((r) => r.ingredient_id))];
    const saldoProd = simples.length === 0 ? { rows: [] } : await client.query(
      `SELECT product_id, saldo FROM stock_balances WHERE product_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY product_id FOR UPDATE`,
      [simples, locationId, req.user.tenantId]
    );
    const saldoIns = insumoIds.length === 0 ? { rows: [] } : await client.query(
      `SELECT ingredient_id, saldo FROM ingredient_balances WHERE ingredient_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY ingredient_id FOR UPDATE`,
      [insumoIds, locationId, req.user.tenantId]
    );
    const saldoProdMap = new Map(saldoProd.rows.map((r) => [r.product_id, Number(r.saldo)]));
    const saldoInsMap = new Map(saldoIns.rows.map((r) => [r.ingredient_id, Number(r.saldo)]));
    const reservados = await reservadosDaLoja(client, req.user.tenantId, locationId);

    const precisaProd = new Map();
    const precisaIns = new Map();
    for (const l of linhas) {
      const ficha = fichaPor.get(l.product_id);
      if (!ficha) {
        precisaProd.set(l.product_id, (precisaProd.get(l.product_id) || 0) + l.quantidade);
      } else {
        for (const r of ficha) precisaIns.set(r.ingredient_id, (precisaIns.get(r.ingredient_id) || 0) + Number(r.quantidade_por_unidade) * l.quantidade);
      }
    }
    for (const [pid, q] of precisaProd) {
      const disponivel = (saldoProdMap.get(pid) || 0) - (reservados.produtos.get(pid) || 0);
      if (disponivel < q) throw new HttpError(409, `Sem estoque disponível de ${mapa.get(pid).nome}`);
    }
    for (const [iid, q] of precisaIns) {
      const disponivel = (saldoInsMap.get(iid) || 0) - (reservados.insumos.get(iid) || 0);
      if (disponivel < q) {
        const dono = linhas.find((l) => (fichaPor.get(l.product_id) || []).some((r) => r.ingredient_id === iid));
        const insumoNome = fichas.rows.find((r) => r.ingredient_id === iid).insumo_nome;
        throw new HttpError(409, `Sem estoque disponível de ${dono ? mapa.get(dono.product_id).nome : 'produto'} (falta ${insumoNome})`);
      }
    }

    // Cliente: o telefone (so digitos) e a chave. Cadastrado -> vincula; novo -> cria quando "cadastrar_cliente" (padrao: sim).
    let customerId = null;
    let clienteNovo = false;
    const tel = apenasDigitos(b.cliente_telefone);
    if (tel.length >= 10) {
      const ex = await client.query(`SELECT id FROM customers WHERE tenant_id = $1 AND telefone = $2 AND ativo`, [req.user.tenantId, tel]);
      if (ex.rows.length > 0) {
        customerId = ex.rows[0].id;
      } else if (b.cadastrar_cliente !== false) {
        customerId = await inserirCliente(client, req.user.tenantId, {
          nome: String(b.cliente_nome || '').trim() || 'Cliente', telefone: tel, endereco: tipo === 'entrega' ? endereco : '', aceita_mensagens: false,
        });
        clienteNovo = true;
      }
    }

    const numero = await proximoNumero(client, req.user.tenantId, locationId);
    const pedido = await client.query(
      `INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, cliente_telefone, tipo, endereco, taxa_entrega,
                           observacao, forma_pagamento_prevista, pago, status, criado_por, customer_id, valor_recebido)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'novo', $13, $14, $15) RETURNING id`,
      [req.user.tenantId, locationId, numero, origem, String(b.cliente_nome || '').trim().slice(0, 120), String(b.cliente_telefone || '').trim().slice(0, 40),
        tipo, tipo === 'retirada' ? '' : endereco, taxa, String(b.observacao || '').trim().slice(0, 300), forma, pago, req.user.id, customerId, valorRecebido]
    );
    const orderId = pedido.rows[0].id;
    for (const l of linhas) {
      const preco = Number(mapa.get(l.product_id).preco_venda);
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantidade, preco_unitario, subtotal, observacao) VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, l.product_id, l.quantidade, preco, Number((preco * l.quantidade).toFixed(2)), fichaPor.has(l.product_id) && l.observacao ? l.observacao : null]
      );
    }
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, NULL, 'novo', $2)`, [orderId, req.user.id]);
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_pedido', recurso: 'orders', recursoId: orderId,
      detalhes: { numero, origem, tipo, itens: linhas.length, customer_id: customerId, cliente_novo: clienteNovo },
    });
    await client.query('COMMIT');
    res.status(201).json({ ...(await pedidoCompleto(pool, req.user.tenantId, orderId)), cliente_novo: clienteNovo });
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
  const pedido = await getOwned(pool, 'orders', req.params.id, req.user.tenantId, { columns: 'id, numero, location_id, status, tipo' });
  assertLocationAccess(req.user, pedido.location_id, 'alterar pedidos desta loja');
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
    const permitidos = (FLUXO[o.status] || []).filter((s) => {
      if (o.status === 'pronto') return o.tipo === 'entrega' ? s === 'saiu_entrega' : s === 'finalizado';
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
      const itens = await client.query(`SELECT product_id, quantidade, observacao FROM order_items WHERE order_id = $1`, [o.id]);
      let forma = b.forma_pagamento;
      if (o.pago) {
        const prev = o.forma_pagamento_prevista;
        forma = prev === 'dinheiro' ? 'dinheiro' : prev === 'cartao' ? (b.forma_pagamento || 'cartao_credito') : ['cartao_credito', 'cartao_debito'].includes(prev) ? prev : 'pix';
      }
      if (!forma) throw new HttpError(400, 'informe a forma de pagamento para finalizar');
      const venda = await registrarVenda(client, req.user, {
        terminal_id: terminalId,
        itens: itens.rows.map((i) => ({ product_id: i.product_id, quantidade: Number(i.quantidade), observacao: i.observacao })),
        forma_pagamento: forma,
        valor_recebido: o.pago && forma === 'dinheiro' ? (o.valor_recebido === null ? undefined : Number(o.valor_recebido)) : b.valor_recebido,
        desconto: 0,
        taxa_entrega: Number(o.taxa_entrega),
        numero_pedido: o.numero,
        ignorar_pedido_id: o.id,
      });
      saleId = venda.id;
      pago = true;
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
    `SELECT id, nome, ativo FROM couriers WHERE tenant_id = $1 ${req.query.todos ? '' : 'AND ativo'} ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/couriers', async (req, res) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  if (nome.length < 2) throw new HttpError(400, 'nome do entregador deve ter ao menos 2 caracteres');
  const { rows } = await pool.query(`INSERT INTO couriers (tenant_id, nome) VALUES ($1, $2) RETURNING id, nome, ativo`, [req.user.tenantId, nome.slice(0, 80)]);
  res.status(201).json(rows[0]);
});

router.patch('/couriers/:id', async (req, res) => {
  const atual = await getOwned(pool, 'couriers', req.params.id, req.user.tenantId, { columns: 'id, nome, ativo' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? String(b.nome).trim() : atual.nome;
  if (nome.length < 2) throw new HttpError(400, 'nome do entregador deve ter ao menos 2 caracteres');
  const ativo = b.ativo !== undefined ? !!b.ativo : atual.ativo;
  const { rows } = await pool.query(`UPDATE couriers SET nome = $1, ativo = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, ativo`, [nome.slice(0, 80), ativo, req.params.id, req.user.tenantId]);
  res.json(rows[0]);
});

module.exports = router;
