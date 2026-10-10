const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireArea, MATRIX, PERMISSOES, areasEfetivas, normalizarOverrides } = require('../middleware/permissions');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation } = require('../utils/tenant');
const { HttpError } = require('../utils/http');

const router = express.Router();
const PERFIS = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro'];

// Padrao de cada perfil e lista de permissoes ajustaveis (a tela de usuarios monta os checkboxes com isso).
router.get('/users/permissoes', requireArea('Configuracoes'), (req, res) => {
  res.json({ permissoes: PERMISSOES, padrao: MATRIX });
});

// Valida a lista de lojas adicionais (ids de lojas da empresa, sem repetir a principal).
async function lojasAdicionais(db, tenantId, ids, principal) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw new HttpError(400, 'location_ids deve ser uma lista');
  const unicos = [...new Set(ids.filter(Boolean))].filter((id) => id !== principal);
  for (const id of unicos) await getOwnedLocation(db, id, tenantId);
  return unicos;
}

async function gravarLojasAdicionais(client, tenantId, userId, ids) {
  await client.query(`DELETE FROM user_locations WHERE user_id = $1`, [userId]);
  for (const id of ids) {
    await client.query(`INSERT INTO user_locations (user_id, location_id, tenant_id) VALUES ($1, $2, $3)`, [userId, id, tenantId]);
  }
}

router.get('/users', requireArea('Configuracoes'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.location_id, u.ativo, u.criado_em, u.permissoes,
            COALESCE((SELECT json_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id), '[]') AS location_ids
     FROM users u WHERE u.tenant_id = $1 ORDER BY u.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/users', requireArea('Configuracoes'), async (req, res) => {
  const { nome, email, senha, perfil, location_id } = req.body || {};
  const permissoes = normalizarOverrides(perfil, (req.body || {}).permissoes);
  if (permissoes === false) throw new HttpError(400, 'permissões inválidas');

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
  const extras = (await lojasAdicionais(pool, req.user.tenantId, (req.body || {}).location_ids, location_id || null)) || [];
  if (extras.length > 0 && !location_id) throw new HttpError(400, 'escolha a loja principal antes de adicionar outras lojas');

  // E-mail e unico no sistema todo: o login nao informa a empresa.
  const existing = await pool.query(`SELECT 1 FROM users WHERE lower(email::text) = lower($1)`, [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ erro: 'já existe um usuário com este email' });
  }

  const senhaHash = await bcrypt.hash(senha, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, perfil, location_id, permissoes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, email, perfil, location_id, ativo, permissoes`,
      [req.user.tenantId, nome, email, senhaHash, perfil, location_id || null, permissoes ? JSON.stringify(permissoes) : null]
    );
    await gravarLojasAdicionais(client, req.user.tenantId, rows[0].id, extras);
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'criar',
      recurso: 'users',
      recursoId: rows[0].id,
      detalhes: { perfil, permissoes },
    });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], location_ids: extras });
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
    `SELECT id, perfil, location_id, permissoes FROM users WHERE id = $1 AND tenant_id = $2`,
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
  let extras = await lojasAdicionais(pool, req.user.tenantId, body.location_ids, locationId);
  // Sem loja principal (todas as lojas) nao existem lojas adicionais; mudar a principal tira ela da lista.
  if (!locationId) extras = [];
  if (extras === undefined && body.location_id !== undefined) {
    const ja = await pool.query(`SELECT location_id FROM user_locations WHERE user_id = $1`, [req.params.id]);
    extras = locationId ? ja.rows.map((r) => r.location_id).filter((id) => id !== locationId) : [];
  }
  // Ajustes individuais: se vierem no corpo, valem; se o perfil mudou sem ajustes, voltam ao padrao.
  let permissoes = atual.permissoes;
  if (body.permissoes !== undefined) {
    permissoes = normalizarOverrides(perfil, body.permissoes);
    if (permissoes === false) throw new HttpError(400, 'permissões inválidas');
  } else if (perfil !== atual.perfil) {
    permissoes = null;
  }
  if (req.params.id === req.user.id && !areasEfetivas(perfil, permissoes).Configuracoes) {
    throw new HttpError(400, 'você não pode tirar o seu próprio acesso a Configurações');
  }
  if (req.params.id === req.user.id && perfil !== 'Administrador' && atual.perfil === 'Administrador') {
    throw new HttpError(400, 'você não pode remover o seu próprio perfil de Administrador');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET perfil = $1, location_id = $2, nome = COALESCE($5, nome), permissoes = $6 WHERE id = $3 AND tenant_id = $4
       RETURNING id, nome, email, perfil, location_id, ativo, permissoes`,
      [perfil, locationId, req.params.id, req.user.tenantId, nome, permissoes ? JSON.stringify(permissoes) : null]
    );
    if (extras !== undefined) await gravarLojasAdicionais(client, req.user.tenantId, req.params.id, extras);
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'alterar_permissao',
      recurso: 'users',
      recursoId: req.params.id,
      detalhes: { perfil_anterior: atual.perfil, perfil, permissoes_anteriores: atual.permissoes, permissoes, location_anterior: atual.location_id, location_id: locationId, location_ids: extras },
    });
    await client.query('COMMIT');
    res.json({ ...rows[0], location_ids: extras });
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
