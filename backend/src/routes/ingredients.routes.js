const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.get('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, unidade, estoque_atual, ativo FROM ingredients
     WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { nome, unidade, estoque_atual } = req.body || {};
  if (!nome || !unidade) {
    return res.status(400).json({ erro: 'nome e unidade sao obrigatorios' });
  }
  const inicial = Number(estoque_atual ?? 0);
  if (inicial < 0) return res.status(400).json({ erro: 'estoque atual nao pode ser negativo' });

  const { rows } = await pool.query(
    `INSERT INTO ingredients (tenant_id, nome, unidade, estoque_atual)
     VALUES ($1, $2, $3, $4)
     RETURNING id, nome, unidade, estoque_atual, ativo`,
    [req.user.tenantId, nome, unidade, inicial]
  );
  res.status(201).json(rows[0]);
});

router.post('/ingredients/:id/stock-entries', requireArea('Estoque'), async (req, res) => {
  const { quantidade } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE ingredients SET estoque_atual = estoque_atual + $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, nome, unidade, estoque_atual`,
      [qtd, req.params.id, req.user.tenantId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'insumo nao encontrado' });
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'entrada_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd },
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

router.get('/ingredients/:id/consumption-history', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.quantidade_consumida, ic.criado_em,
            si.quantidade AS quantidade_vendida, p.nome AS product_nome
     FROM ingredient_consumptions ic
     JOIN sale_items si ON si.id = ic.sale_item_id
     JOIN products p ON p.id = si.product_id
     WHERE ic.ingredient_id = $1 AND ic.tenant_id = $2
     ORDER BY ic.criado_em DESC LIMIT 100`,
    [req.params.id, req.user.tenantId]
  );
  res.json(rows);
});

module.exports = router;
