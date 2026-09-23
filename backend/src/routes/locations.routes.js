const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');

const router = express.Router();

router.get('/locations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, ativo FROM locations WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/locations', requireArea('Configuracoes'), async (req, res) => {
  const { nome } = req.body || {};
  if (!nome) return res.status(400).json({ erro: 'nome e obrigatorio' });
  const { rows } = await pool.query(
    `INSERT INTO locations (tenant_id, nome) VALUES ($1, $2) RETURNING id, nome, ativo`,
    [req.user.tenantId, nome]
  );
  res.status(201).json(rows[0]);
});

router.get('/terminals', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, location_id, ativo FROM terminals WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/terminals', requireArea('Configuracoes'), async (req, res) => {
  const { nome, location_id } = req.body || {};
  if (!nome || !location_id) return res.status(400).json({ erro: 'nome e location_id sao obrigatorios' });
  const { rows } = await pool.query(
    `INSERT INTO terminals (tenant_id, location_id, nome) VALUES ($1, $2, $3) RETURNING id, nome, location_id, ativo`,
    [req.user.tenantId, location_id, nome]
  );
  await pool.query(
    `INSERT INTO cash_registers (tenant_id, terminal_id) VALUES ($1, $2)`,
    [req.user.tenantId, rows[0].id]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
