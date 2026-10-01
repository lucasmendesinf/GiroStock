const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { restrictedLocation } = require('../utils/access');
const { HttpError } = require('../utils/http');

const router = express.Router();

router.get('/locations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.nome, l.ativo,
            (SELECT COUNT(*)::int FROM terminals t WHERE t.location_id = l.id AND t.tenant_id = l.tenant_id) AS terminal_count
     FROM locations l WHERE l.tenant_id = $1 ORDER BY l.ativo DESC, l.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/locations', requireArea('Configuracoes'), async (req, res) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  const { rows } = await pool.query(
    `INSERT INTO locations (tenant_id, nome) VALUES ($1, $2) RETURNING id, nome, ativo`,
    [req.user.tenantId, nome]
  );
  res.status(201).json(rows[0]);
});

// Renomear e/ou ativar/desativar um local. Para desativar, o local nao pode ter
// saldo de produtos/insumos nem caixa aberto (transfira o estoque antes).
router.patch('/locations/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  const atual = await getOwned(pool, 'locations', req.params.id, req.user.tenantId, { columns: 'id, nome, ativo' });
  const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
  if (!nome) throw new HttpError(400, 'nome é obrigatório');
  const ativo = body.ativo !== undefined ? !!body.ativo : atual.ativo;

  if (atual.ativo && !ativo) {
    const saldo = await pool.query(
      `SELECT (SELECT COALESCE(SUM(saldo), 0) FROM stock_balances WHERE location_id = $1 AND tenant_id = $2) AS produtos,
              (SELECT COALESCE(SUM(saldo), 0) FROM ingredient_balances WHERE location_id = $1 AND tenant_id = $2) AS insumos`,
      [req.params.id, req.user.tenantId]
    );
    if (Number(saldo.rows[0].produtos) > 0 || Number(saldo.rows[0].insumos) > 0) {
      throw new HttpError(400, 'este local ainda tem estoque; transfira ou de saída do saldo antes de desativar');
    }
    const caixa = await pool.query(
      `SELECT 1 FROM cash_sessions cs
       JOIN cash_registers cr ON cr.id = cs.cash_register_id
       JOIN terminals t ON t.id = cr.terminal_id
       WHERE t.location_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );
    if (caixa.rows.length > 0) throw new HttpError(400, 'ha caixa aberto em um terminal deste local; feche-o antes de desativar');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE locations SET nome = $1, ativo = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, ativo`,
      [nome, ativo, req.params.id, req.user.tenantId]
    );
    if (atual.ativo && !ativo) {
      await client.query(`UPDATE terminals SET ativo = false WHERE location_id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'editar',
      recurso: 'locations',
      recursoId: req.params.id,
      detalhes: { antes: atual, depois: rows[0] },
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

// Usuario vinculado a um local so enxerga os terminais (PDVs) daquele local.
router.get('/terminals', async (req, res) => {
  const params = [req.user.tenantId];
  let where = 't.tenant_id = $1';
  const local = restrictedLocation(req.user);
  if (local) {
    params.push(local);
    where += ` AND t.location_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.nome, t.location_id, l.nome AS location_nome, t.ativo,
            EXISTS(SELECT 1 FROM cash_registers cr JOIN cash_sessions cs ON cs.cash_register_id = cr.id
                   WHERE cr.terminal_id = t.id AND cs.fechado_em IS NULL) AS caixa_aberto
     FROM terminals t JOIN locations l ON l.id = t.location_id
     WHERE ${where} ORDER BY l.nome, t.nome`,
    params
  );
  res.json(rows);
});

router.post('/terminals', requireArea('Configuracoes'), async (req, res) => {
  const { location_id } = req.body || {};
  const nome = String((req.body && req.body.nome) || '').trim();
  if (!nome || !location_id) return res.status(400).json({ erro: 'nome e location_id são obrigatórios' });
  await getOwnedLocation(pool, location_id, req.user.tenantId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO terminals (tenant_id, location_id, nome) VALUES ($1, $2, $3) RETURNING id, nome, location_id, ativo`,
      [req.user.tenantId, location_id, nome]
    );
    await client.query(
      `INSERT INTO cash_registers (tenant_id, terminal_id) VALUES ($1, $2)`,
      [req.user.tenantId, rows[0].id]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/terminals/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  const atual = await getOwned(pool, 'terminals', req.params.id, req.user.tenantId, { columns: 'id, nome, location_id, ativo' });
  const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
  if (!nome) throw new HttpError(400, 'nome é obrigatório');
  const ativo = body.ativo !== undefined ? !!body.ativo : atual.ativo;

  if (ativo && !atual.ativo) {
    await getOwnedLocation(pool, atual.location_id, req.user.tenantId);
  }
  if (!ativo && atual.ativo) {
    const caixa = await pool.query(
      `SELECT 1 FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
       WHERE cr.terminal_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );
    if (caixa.rows.length > 0) throw new HttpError(400, 'este terminal está com o caixa aberto; feche-o antes de desativar');
  }

  const { rows } = await pool.query(
    `UPDATE terminals SET nome = $1, ativo = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, location_id, ativo`,
    [nome, ativo, req.params.id, req.user.tenantId]
  );
  res.json(rows[0]);
});

module.exports = router;
