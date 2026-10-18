const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess, filtroLocais, canCancelSales } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { configEfetiva } = require('../utils/cupom');
const { registrarVenda } = require('../services/vendas');

const router = express.Router();
const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];


router.post('/sales', requireArea('Vendas'), async (req, res) => {
  const body = req.body || {};
  const descontoInformado = Number(body.desconto || 0);
  if (descontoInformado > 0 && !(req.user.areas && req.user.areas.Desconto)) {
    return res.status(403).json({ erro: 'Seu usuário não tem permissão para dar desconto' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const venda = await registrarVenda(client, req.user, {
      terminal_id: body.terminal_id, itens: body.itens, forma_pagamento: body.forma_pagamento,
      valor_recebido: body.valor_recebido, desconto: descontoInformado,
    });
    await client.query('COMMIT');
    res.status(201).json(venda);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Cancela uma venda devolvendo o estoque (produtos e insumos) ao local da venda.
// So enquanto o caixa da venda estiver aberto, para nao alterar um fechamento ja conferido.
router.post('/sales/:id/cancel', requireArea('Vendas'), async (req, res) => {
  if (!canCancelSales(req.user)) {
    throw new HttpError(403, 'somente Administrador ou Gerente podem cancelar vendas');
  }
  const motivo = String((req.body && req.body.motivo) || '').trim();
  if (motivo.length < 3) throw new HttpError(400, 'motivo do cancelamento é obrigatório (mínimo 3 caracteres)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sale = await getOwned(client, 'sales', req.params.id, req.user.tenantId, {
      columns: 'id, numero, status, location_id, cash_session_id, total',
      lock: true,
    });
    if (sale.status !== 'concluida') throw new HttpError(400, 'esta venda já foi cancelada');
    assertLocationAccess(req.user, sale.location_id, 'cancelar vendas deste local');

    // Venda de pedido pago no site nao tem caixa (sem fechamento a proteger).
    const session = sale.cash_session_id ? await client.query(
      `SELECT fechado_em FROM cash_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [sale.cash_session_id, req.user.tenantId]
    ) : { rows: [{ fechado_em: null }] };
    if (session.rows[0].fechado_em) {
      throw new HttpError(400, 'o caixa desta venda já foi fechado; não e possível cancelá-la');
    }

    const itens = await client.query(
      `SELECT si.id, si.product_id, si.quantidade FROM sale_items si
       WHERE si.sale_id = $1 AND si.tenant_id = $2`,
      [sale.id, req.user.tenantId]
    );
    // Mesma ordem de travas da venda: produtos -> saldos.
    await client.query(
      `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id FOR UPDATE`,
      [itens.rows.map((i) => i.product_id), req.user.tenantId]
    );

    // Produtos com estoque proprio: estorna exatamente as saidas feitas pela venda.
    const saidas = await client.query(
      `SELECT product_id, location_origem_id, SUM(quantidade) AS quantidade
       FROM stock_movements
       WHERE sale_id = $1 AND tenant_id = $2 AND tipo = 'saida'
       GROUP BY product_id, location_origem_id
       ORDER BY product_id`,
      [sale.id, req.user.tenantId]
    );
    for (const saida of saidas.rows) {
      await client.query(
        `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, 0)
         ON CONFLICT (product_id, location_id) DO NOTHING`,
        [saida.product_id, saida.location_origem_id, req.user.tenantId]
      );
      await client.query(
        `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [saida.quantidade, saida.product_id, saida.location_origem_id, req.user.tenantId]
      );
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, sale_id)
         VALUES ($1, $2, 'entrada', $3, NULL, $4, $5, $6, $7)`,
        [req.user.tenantId, saida.product_id, saida.quantidade, saida.location_origem_id,
          `Estorno do cancelamento da venda nº ${sale.numero}: ${motivo}`, req.user.id, sale.id]
      );
    }

    // Insumos consumidos pela ficha tecnica voltam para o local onde foram consumidos.
    const consumos = await client.query(
      `SELECT ic.ingredient_id, COALESCE(ic.location_id, $3::uuid) AS location_id, SUM(ic.quantidade_consumida) AS quantidade
       FROM ingredient_consumptions ic
       WHERE ic.sale_item_id = ANY($1::uuid[]) AND ic.tenant_id = $2
       GROUP BY ic.ingredient_id, COALESCE(ic.location_id, $3::uuid)
       ORDER BY ic.ingredient_id`,
      [itens.rows.map((i) => i.id), req.user.tenantId, sale.location_id]
    );
    for (const consumo of consumos.rows) {
      await client.query(
        `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)
         ON CONFLICT (ingredient_id, location_id) DO UPDATE SET saldo = ingredient_balances.saldo + EXCLUDED.saldo`,
        [consumo.ingredient_id, consumo.location_id, req.user.tenantId, consumo.quantidade]
      );
    }

    const { rows } = await client.query(
      `UPDATE sales SET status = 'cancelada', cancelado_em = now(), cancelado_por = $1, motivo_cancelamento = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, status, cancelado_em, motivo_cancelamento, total`,
      [req.user.id, motivo, sale.id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'cancelar_venda',
      recurso: 'sales',
      recursoId: sale.id,
      detalhes: {
        motivo,
        total: Number(sale.total),
        estorno_produtos: saidas.rows.length,
        estorno_insumos: consumos.rows.length,
      },
    });

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

function filtrosVendas(req) {
  const { location_id, operador_id, forma_pagamento, status } = req.query;
  const params = [req.user.tenantId];
  let where = 's.tenant_id = $1';
  const locais = filtroLocais(req.user, location_id);
  if (locais) {
    params.push(locais);
    where += ` AND s.location_id = ANY($${params.length}::uuid[])`;
  }
  if (operador_id) {
    params.push(operador_id);
    where += ` AND s.operador_id = $${params.length}`;
  }
  if (forma_pagamento) {
    params.push(forma_pagamento);
    where += ` AND s.forma_pagamento = $${params.length}`;
  }
  if (status !== 'todas') {
    params.push(status === 'cancelada' ? 'cancelada' : 'concluida');
    where += ` AND s.status = $${params.length}`;
  }
  return { params, where };
}

router.get('/sales', requireArea('Vendas'), async (req, res) => {
  const { params, where } = filtrosVendas(req);
  const { rows } = await pool.query(
    `SELECT s.id, s.numero, s.criado_em, u.nome AS operador_nome, COALESCE(t.nome, 'Loja virtual (site)') AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.subtotal, s.desconto, s.total, s.status
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     LEFT JOIN terminals t ON t.id = s.terminal_id
     JOIN locations l ON l.id = s.location_id
     WHERE ${where}
     ORDER BY s.criado_em DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

// Detalhe da venda com os itens (aberto para quem vende e para quem ve relatorios).
router.get('/sales/:id', async (req, res) => {
  if (!req.user.areas.Vendas && !req.user.areas.Relatorios) {
    throw new HttpError(403, 'Seu usuário não tem acesso a vendas');
  }
  await getOwned(pool, 'sales', req.params.id, req.user.tenantId);
  const venda = await pool.query(
    `SELECT s.id, s.numero, s.numero_pedido, s.criado_em, s.status, s.forma_pagamento, s.valor_recebido, s.troco, s.subtotal, s.desconto, s.taxa_entrega, s.total,
            tn.nome AS empresa_nome, l.usa_comanda, l.cupom_config,
            s.location_id, l.nome AS location_nome, COALESCE(t.nome, 'Loja virtual (site)') AS terminal_nome, u.nome AS operador_nome,
            s.cash_session_id, (s.cash_session_id IS NULL OR cs.fechado_em IS NULL) AS caixa_aberto,
            s.cancelado_em, s.motivo_cancelamento, uc.nome AS cancelado_por_nome
     FROM sales s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN terminals t ON t.id = s.terminal_id
     JOIN users u ON u.id = s.operador_id
     LEFT JOIN cash_sessions cs ON cs.id = s.cash_session_id
     JOIN tenants tn ON tn.id = s.tenant_id
     LEFT JOIN users uc ON uc.id = s.cancelado_por
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  const v = venda.rows[0];
  assertLocationAccess(req.user, v.location_id, 'ver vendas deste local');

  const itens = await pool.query(
    `SELECT si.id, si.product_id, p.nome AS product_nome, p.codigo_interno, si.quantidade,
            p.unidade, si.preco_unitario, si.custo_unitario, si.subtotal, si.observacao, COALESCE(si.complementos, '[]'::jsonb) AS complementos,
            (EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id)
              OR EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id) OR si.complementos IS NOT NULL) AS preparo
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1 AND si.tenant_id = $2
     ORDER BY p.nome, si.id`,
    [req.params.id, req.user.tenantId]
  );
  const { cupom_config: cfgSalva, ...resto } = v;
  res.json({ ...resto, cupom_config: configEfetiva(cfgSalva), pode_cancelar: v.status === 'concluida' && v.caixa_aberto && canCancelSales(req.user), itens: itens.rows });
});

module.exports = router;
