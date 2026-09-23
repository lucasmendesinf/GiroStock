const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();

async function getSaldo(client, tenantId, productId, locationId) {
  const { rows } = await client.query(
    `SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND tenant_id = $3 FOR UPDATE`,
    [productId, locationId, tenantId]
  );
  return rows[0] ? Number(rows[0].saldo) : null;
}

async function ensureBalanceRow(client, tenantId, productId, locationId) {
  await client.query(
    `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (product_id, location_id) DO NOTHING`,
    [productId, locationId, tenantId]
  );
}

router.post('/stock-movements', requireArea('Estoque'), async (req, res) => {
  const { product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo } = req.body || {};
  const qtd = Number(quantidade);

  if (!product_id || !tipo || !(qtd > 0) || !motivo) {
    return res.status(400).json({ erro: 'product_id, tipo, quantidade (>0) e motivo sao obrigatorios' });
  }
  if (!['entrada', 'saida', 'transferencia'].includes(tipo)) {
    return res.status(400).json({ erro: 'tipo invalido' });
  }
  if (tipo === 'entrada' && !location_destino_id) {
    return res.status(400).json({ erro: 'location_destino_id e obrigatorio para entrada' });
  }
  if (tipo === 'saida' && !location_origem_id) {
    return res.status(400).json({ erro: 'location_origem_id e obrigatorio para saida' });
  }
  if (tipo === 'transferencia') {
    if (!location_origem_id || !location_destino_id) {
      return res.status(400).json({ erro: 'location_origem_id e location_destino_id sao obrigatorios para transferencia' });
    }
    if (location_origem_id === location_destino_id) {
      return res.status(400).json({ erro: 'local de origem deve ser diferente do local de destino' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (tipo === 'entrada') {
      await ensureBalanceRow(client, req.user.tenantId, product_id, location_destino_id);
      await client.query(
        `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [qtd, product_id, location_destino_id, req.user.tenantId]
      );
    } else {
      const saldoOrigem = await getSaldo(client, req.user.tenantId, product_id, location_origem_id);
      if (saldoOrigem === null || saldoOrigem < qtd) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          erro: `saldo insuficiente no local de origem (disponivel: ${saldoOrigem ?? 0}, solicitado: ${qtd})`,
        });
      }
      await client.query(
        `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [qtd, product_id, location_origem_id, req.user.tenantId]
      );
      if (tipo === 'transferencia') {
        await ensureBalanceRow(client, req.user.tenantId, product_id, location_destino_id);
        await client.query(
          `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [qtd, product_id, location_destino_id, req.user.tenantId]
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, tipo, quantidade, location_origem_id, location_destino_id, motivo, criado_em`,
      [req.user.tenantId, product_id, tipo, qtd, location_origem_id || null, location_destino_id || null, motivo, req.user.id]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: tipo,
      recurso: 'stock_movements',
      recursoId: rows[0].id,
      detalhes: { product_id, quantidade: qtd },
    });

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/stock-movements', requireArea('Estoque'), async (req, res) => {
  const { product_id } = req.query;
  const params = [req.user.tenantId];
  let where = 'sm.tenant_id = $1';
  if (product_id) {
    params.push(product_id);
    where += ` AND sm.product_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT sm.id, sm.product_id, p.nome AS product_nome, sm.tipo, sm.quantidade,
            sm.location_origem_id, lo.nome AS location_origem_nome,
            sm.location_destino_id, ld.nome AS location_destino_nome,
            sm.motivo, sm.usuario_id, sm.criado_em
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     LEFT JOIN locations lo ON lo.id = sm.location_origem_id
     LEFT JOIN locations ld ON ld.id = sm.location_destino_id
     WHERE ${where} ORDER BY sm.criado_em DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

module.exports = router;
