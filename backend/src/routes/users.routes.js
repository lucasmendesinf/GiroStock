const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation } = require('../utils/tenant');
const { HttpError } = require('../utils/http');

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
    return res.status(400).json({ erro: 'nome, email, senha e perfil são obrigatórios' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ erro: 'email inválido' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'senha deve ter no mínimo 6 caracteres' });
  }
  if (!PERFIS.includes(perfil)) {
    return res.status(400).json({ erro: 'perfil inválido' });
  }

  if (location_id) await getOwnedLocation(pool, location_id, req.user.tenantId);

  // E-mail e unico no sistema todo: o login nao informa a empresa.
  const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ erro: 'já existe um usuário com este email' });
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

// Altera perfil e/ou local de atuacao (location_id null = todos os locais).
router.patch('/users/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  const alvo = await pool.query(
    `SELECT id, perfil, location_id FROM users WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (alvo.rows.length === 0) return res.status(404).json({ erro: 'usuário não encontrado' });
  const atual = alvo.rows[0];

  const nome = body.nome !== undefined ? String(body.nome).trim() : null;
  if (nome !== null && nome.length < 2) throw new HttpError(400, 'nome deve ter no mínimo 2 caracteres');
  const perfil = body.perfil !== undefined ? body.perfil : atual.perfil;
  if (!PERFIS.includes(perfil)) throw new HttpError(400, 'perfil inválido');
  let locationId = atual.location_id;
  if (body.location_id !== undefined) {
    locationId = body.location_id || null;
    if (locationId) await getOwnedLocation(pool, locationId, req.user.tenantId);
  }
  if (req.params.id === req.user.id && perfil !== 'Administrador' && atual.perfil === 'Administrador') {
    throw new HttpError(400, 'você não pode remover o seu próprio perfil de Administrador');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET perfil = $1, location_id = $2, nome = COALESCE($5, nome) WHERE id = $3 AND tenant_id = $4
       RETURNING id, nome, email, perfil, location_id, ativo`,
      [perfil, locationId, req.params.id, req.user.tenantId, nome]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'alterar_permissao',
      recurso: 'users',
      recursoId: req.params.id,
      detalhes: { perfil_anterior: atual.perfil, perfil, location_anterior: atual.location_id, location_id: locationId },
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

// Administrador define uma nova senha para o usuario (ex: esqueceu a senha).
router.patch('/users/:id/password', requireArea('Configuracoes'), async (req, res) => {
  const { senha } = req.body || {};
  if (!senha || String(senha).length < 6) throw new HttpError(400, 'a senha deve ter no mínimo 6 caracteres');
  const alvo = await pool.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  if (alvo.rows.length === 0) return res.status(404).json({ erro: 'usuário não encontrado' });
  const hash = await bcrypt.hash(String(senha), 10);
  await pool.query(`UPDATE users SET senha_hash = $1 WHERE id = $2 AND tenant_id = $3`, [hash, req.params.id, req.user.tenantId]);
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'redefinir_senha', recurso: 'users', recursoId: req.params.id,
  });
  res.status(204).send();
});

router.patch('/users/:id/status', requireArea('Configuracoes'), async (req, res) => {
  const { ativo } = req.body || {};
  if (req.params.id === req.user.id && !ativo) {
    return res.status(400).json({ erro: 'você não pode desativar o seu próprio usuário' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, ativo`,
      [!!ativo, req.params.id, req.user.tenantId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'usuário não encontrado' });
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
