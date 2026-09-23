const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const PERFIS = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro'];

router.get('/users', requireArea('Configuracoes'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, email, perfil, location_id, ativo, criado_em
     FROM users WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/users', requireArea('Configuracoes'), async (req, res) => {
  const { nome, email, senha, perfil, location_id } = req.body || {};

  if (!nome || !email || !senha || !perfil) {
    return res.status(400).json({ erro: 'nome, email, senha e perfil sao obrigatorios' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ erro: 'email invalido' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'senha deve ter no minimo 6 caracteres' });
  }
  if (!PERFIS.includes(perfil)) {
    return res.status(400).json({ erro: 'perfil invalido' });
  }

  const existing = await pool.query(
    `SELECT 1 FROM users WHERE tenant_id = $1 AND email = $2`,
    [req.user.tenantId, email]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ erro: 'ja existe um usuario com este email' });
  }

  const senhaHash = await bcrypt.hash(senha, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, perfil, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, email, perfil, location_id, ativo`,
      [req.user.tenantId, nome, email, senhaHash, perfil, location_id || null]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'criar',
      recurso: 'users',
      recursoId: rows[0].id,
      detalhes: { perfil },
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

router.patch('/users/:id/status', requireArea('Configuracoes'), async (req, res) => {
  const { ativo } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, ativo`,
      [!!ativo, req.params.id, req.user.tenantId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'usuario nao encontrado' });
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: ativo ? 'ativar' : 'desativar',
      recurso: 'users',
      recursoId: req.params.id,
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

module.exports = router;
