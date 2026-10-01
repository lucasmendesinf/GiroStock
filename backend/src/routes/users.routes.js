const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requirePermission, ehAdmin, PERMISSOES, validarPermissoes } = require('../middleware/permissions');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation, isUuid } = require('../utils/tenant');
const { HttpError } = require('../utils/http');

const router = express.Router();

// ---------- Helpers ----------

// Nivel informado por id (access_level_id) ou pelo nome (campo "perfil", compatibilidade).
async function resolverNivel(db, tenantId, { access_level_id, perfil }) {
  let rows;
  if (access_level_id) {
    if (!isUuid(access_level_id)) throw new HttpError(400, 'nível de acesso inválido');
    ({ rows } = await db.query(`SELECT id, nome, permissoes FROM access_levels WHERE id = $1 AND tenant_id = $2`, [access_level_id, tenantId]));
  } else if (perfil) {
    ({ rows } = await db.query(`SELECT id, nome, permissoes FROM access_levels WHERE lower(nome) = lower($1) AND tenant_id = $2`, [String(perfil), tenantId]));
  } else {
    throw new HttpError(400, 'nível de acesso é obrigatório');
  }
  if (rows.length === 0) throw new HttpError(404, 'nível de acesso não encontrado');
  return rows[0];
}

function validarExtras(lista) {
  if (lista === undefined || lista === null) return [];
  const r = validarPermissoes(lista);
  if (!r.ok) throw new HttpError(400, r.erro);
  return r.permissoes;
}

// Quem nao e Administrador so concede permissoes que ele mesmo tem (sem escalar acesso).
function assertPodeConceder(quem, nivel, extras) {
  if (ehAdmin(quem)) return;
  if (nivel.permissoes.includes('*')) throw new HttpError(403, 'somente um Administrador pode atribuir o nível Administrador');
  const faltando = [...nivel.permissoes, ...extras].filter((p) => !quem.permissoes.includes(p));
  if (faltando.length) {
    throw new HttpError(403, `você não pode conceder permissões que não tem: ${[...new Set(faltando)].join(', ')}`);
  }
}

async function carregarAlvo(db, id, tenantId) {
  if (!isUuid(id)) throw new HttpError(400, 'usuário inválido');
  const { rows } = await db.query(
    `SELECT u.id, u.nome, u.location_id, u.ativo, u.access_level_id, u.permissoes_extra, al.nome AS nivel, al.permissoes AS permissoes_nivel
     FROM users u JOIN access_levels al ON al.id = u.access_level_id
     WHERE u.id = $1 AND u.tenant_id = $2`,
    [id, tenantId]
  );
  if (rows.length === 0) throw new HttpError(404, 'usuário não encontrado');
  const alvo = rows[0];
  alvo.admin = alvo.permissoes_nivel.includes('*');
  return alvo;
}

function assertPodeMexerEm(quem, alvo) {
  if (alvo.admin && !ehAdmin(quem)) throw new HttpError(403, 'somente um Administrador pode alterar outro Administrador');
}

// A empresa nunca pode ficar sem um Administrador ativo.
async function assertRestaOutroAdmin(db, tenantId, alvoId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM users u JOIN access_levels al ON al.id = u.access_level_id
     WHERE u.tenant_id = $1 AND u.ativo AND u.id <> $2 AND '*' = ANY(al.permissoes)`,
    [tenantId, alvoId]
  );
  if (rows[0].total === 0) throw new HttpError(400, 'a empresa precisa ter ao menos um Administrador ativo');
}

const SELECT_LISTA = `SELECT u.id, u.nome, u.email, u.location_id, u.ativo, u.criado_em, u.access_level_id,
         u.permissoes_extra, al.nome AS nivel, al.nome AS perfil, ('*' = ANY(al.permissoes)) AS admin
  FROM users u JOIN access_levels al ON al.id = u.access_level_id`;

// ---------- Usuarios ----------

router.get('/users', requirePermission('usuarios.gerenciar', 'relatorios.ver'), async (req, res) => {
  const { rows } = await pool.query(`${SELECT_LISTA} WHERE u.tenant_id = $1 ORDER BY u.nome`, [req.user.tenantId]);
  res.json(rows);
});

router.post('/users', requirePermission('usuarios.gerenciar'), async (req, res) => {
  const { nome, email, senha, location_id } = req.body || {};
  if (!nome || !email || !senha) throw new HttpError(400, 'nome, email e senha são obrigatórios');
  if (!isValidEmail(email)) throw new HttpError(400, 'email inválido');
  if (String(senha).length < 6) throw new HttpError(400, 'senha deve ter no mínimo 6 caracteres');

  const nivel = await resolverNivel(pool, req.user.tenantId, req.body);
  const extras = validarExtras(req.body.permissoes_extra);
  assertPodeConceder(req.user, nivel, extras);
  if (location_id) await getOwnedLocation(pool, location_id, req.user.tenantId);

  // E-mail e unico no sistema todo: o login nao informa a empresa.
  const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) throw new HttpError(409, 'já existe um usuário com este email');

  const senhaHash = await bcrypt.hash(String(senha), 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, access_level_id, permissoes_extra, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.tenantId, String(nome).trim(), email, senhaHash, nivel.id, extras, location_id || null]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar', recurso: 'users', recursoId: rows[0].id,
      detalhes: { nivel: nivel.nome, permissoes_extra: extras },
    });
    await client.query('COMMIT');
    const criado = await pool.query(`${SELECT_LISTA} WHERE u.id = $1`, [rows[0].id]);
    res.status(201).json(criado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Altera nome, nivel de acesso, permissoes extras e/ou local de atuacao (null = todos os locais).
router.patch('/users/:id', requirePermission('usuarios.gerenciar'), async (req, res) => {
  const body = req.body || {};
  const alvo = await carregarAlvo(pool, req.params.id, req.user.tenantId);
  assertPodeMexerEm(req.user, alvo);

  const nome = body.nome !== undefined ? String(body.nome).trim() : alvo.nome;
  if (nome.length < 2) throw new HttpError(400, 'nome deve ter no mínimo 2 caracteres');

  const nivel = (body.access_level_id !== undefined || body.perfil !== undefined)
    ? await resolverNivel(pool, req.user.tenantId, body)
    : { id: alvo.access_level_id, nome: alvo.nivel, permissoes: alvo.permissoes_nivel };
  const extras = body.permissoes_extra !== undefined ? validarExtras(body.permissoes_extra) : alvo.permissoes_extra;
  const mudouAcesso = nivel.id !== alvo.access_level_id || JSON.stringify([...extras].sort()) !== JSON.stringify([...alvo.permissoes_extra].sort());
  if (mudouAcesso) assertPodeConceder(req.user, nivel, extras);

  const continuaAdmin = nivel.permissoes.includes('*');
  if (alvo.admin && !continuaAdmin) {
    if (alvo.id === req.user.id) throw new HttpError(400, 'você não pode remover o seu próprio nível de Administrador');
    await assertRestaOutroAdmin(pool, req.user.tenantId, alvo.id);
  }

  let locationId = alvo.location_id;
  if (body.location_id !== undefined) {
    locationId = body.location_id || null;
    if (locationId) await getOwnedLocation(pool, locationId, req.user.tenantId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET nome = $1, access_level_id = $2, permissoes_extra = $3, location_id = $4 WHERE id = $5 AND tenant_id = $6`,
      [nome, nivel.id, extras, locationId, alvo.id, req.user.tenantId]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'alterar_permissao', recurso: 'users', recursoId: alvo.id,
      detalhes: {
        nivel_anterior: alvo.nivel, nivel: nivel.nome,
        extras_anteriores: alvo.permissoes_extra, permissoes_extra: extras,
        location_anterior: alvo.location_id, location_id: locationId,
      },
    });
    await client.query('COMMIT');
    const atualizado = await pool.query(`${SELECT_LISTA} WHERE u.id = $1`, [alvo.id]);
    res.json(atualizado.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Define uma nova senha para o usuario (ex: esqueceu a senha).
router.patch('/users/:id/password', requirePermission('usuarios.gerenciar'), async (req, res) => {
  const { senha } = req.body || {};
  if (!senha || String(senha).length < 6) throw new HttpError(400, 'a senha deve ter no mínimo 6 caracteres');
  const alvo = await carregarAlvo(pool, req.params.id, req.user.tenantId);
  assertPodeMexerEm(req.user, alvo);
  const hash = await bcrypt.hash(String(senha), 10);
  await pool.query(`UPDATE users SET senha_hash = $1 WHERE id = $2 AND tenant_id = $3`, [hash, alvo.id, req.user.tenantId]);
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'redefinir_senha', recurso: 'users', recursoId: alvo.id,
  });
  res.status(204).send();
});

router.patch('/users/:id/status', requirePermission('usuarios.gerenciar'), async (req, res) => {
  const ativo = !!(req.body && req.body.ativo);
  if (req.params.id === req.user.id && !ativo) throw new HttpError(400, 'você não pode desativar o seu próprio usuário');
  const alvo = await carregarAlvo(pool, req.params.id, req.user.tenantId);
  assertPodeMexerEm(req.user, alvo);
  if (alvo.admin && !ativo) await assertRestaOutroAdmin(pool, req.user.tenantId, alvo.id);
  const { rows } = await pool.query(
    `UPDATE users SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, ativo`,
    [ativo, alvo.id, req.user.tenantId]
  );
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: ativo ? 'ativar' : 'desativar', recurso: 'users', recursoId: alvo.id,
  });
  res.json(rows[0]);
});

// ---------- Niveis de acesso ----------

// Catalogo de permissoes (para montar a tela de niveis).
router.get('/permissions', (req, res) => {
  res.json(PERMISSOES);
});

router.get('/access-levels', requirePermission('usuarios.gerenciar'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT al.id, al.nome, al.permissoes, al.sistema, ('*' = ANY(al.permissoes)) AS admin,
            (SELECT COUNT(*)::int FROM users u WHERE u.access_level_id = al.id) AS usuarios
     FROM access_levels al WHERE al.tenant_id = $1
     ORDER BY ('*' = ANY(al.permissoes)) DESC, al.sistema DESC, al.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

// Criar/editar/remover niveis e exclusivo do Administrador.
function exigirAdmin(req) {
  if (!ehAdmin(req.user)) throw new HttpError(403, 'somente um Administrador pode configurar níveis de acesso');
}

function validarNomeNivel(nome) {
  const n = String(nome || '').trim();
  if (n.length < 2) throw new HttpError(400, 'nome do nível deve ter no mínimo 2 caracteres');
  return n;
}

router.post('/access-levels', requirePermission('usuarios.gerenciar'), async (req, res) => {
  exigirAdmin(req);
  const nome = validarNomeNivel(req.body && req.body.nome);
  const r = validarPermissoes((req.body && req.body.permissoes) || []);
  if (!r.ok) throw new HttpError(400, r.erro);
  const existe = await pool.query(`SELECT 1 FROM access_levels WHERE tenant_id = $1 AND lower(nome) = lower($2)`, [req.user.tenantId, nome]);
  if (existe.rows.length) throw new HttpError(409, 'já existe um nível com este nome');
  const { rows } = await pool.query(
    `INSERT INTO access_levels (tenant_id, nome, permissoes) VALUES ($1, $2, $3) RETURNING id, nome, permissoes, sistema`,
    [req.user.tenantId, nome, r.permissoes]
  );
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar', recurso: 'access_levels', recursoId: rows[0].id,
    detalhes: { nome, permissoes: r.permissoes },
  });
  res.status(201).json(rows[0]);
});

router.put('/access-levels/:id', requirePermission('usuarios.gerenciar'), async (req, res) => {
  exigirAdmin(req);
  if (!isUuid(req.params.id)) throw new HttpError(400, 'nível de acesso inválido');
  const { rows: achados } = await pool.query(
    `SELECT id, nome, permissoes, sistema FROM access_levels WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (achados.length === 0) throw new HttpError(404, 'nível de acesso não encontrado');
  const atual = achados[0];
  if (atual.permissoes.includes('*')) throw new HttpError(400, 'o nível Administrador tem todas as permissões e não pode ser alterado');

  let nome = atual.nome;
  if (req.body && req.body.nome !== undefined && String(req.body.nome).trim() !== atual.nome) {
    if (atual.sistema) throw new HttpError(400, 'os níveis padrão não podem ser renomeados (crie um nível novo)');
    nome = validarNomeNivel(req.body.nome);
    const existe = await pool.query(`SELECT 1 FROM access_levels WHERE tenant_id = $1 AND lower(nome) = lower($2) AND id <> $3`, [req.user.tenantId, nome, atual.id]);
    if (existe.rows.length) throw new HttpError(409, 'já existe um nível com este nome');
  }
  let permissoes = atual.permissoes;
  if (req.body && req.body.permissoes !== undefined) {
    const r = validarPermissoes(req.body.permissoes);
    if (!r.ok) throw new HttpError(400, r.erro);
    permissoes = r.permissoes;
  }
  const { rows } = await pool.query(
    `UPDATE access_levels SET nome = $1, permissoes = $2 WHERE id = $3 RETURNING id, nome, permissoes, sistema`,
    [nome, permissoes, atual.id]
  );
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar', recurso: 'access_levels', recursoId: atual.id,
    detalhes: { antes: { nome: atual.nome, permissoes: atual.permissoes }, depois: { nome, permissoes } },
  });
  res.json(rows[0]);
});

router.delete('/access-levels/:id', requirePermission('usuarios.gerenciar'), async (req, res) => {
  exigirAdmin(req);
  if (!isUuid(req.params.id)) throw new HttpError(400, 'nível de acesso inválido');
  const { rows } = await pool.query(
    `SELECT al.sistema, (SELECT COUNT(*)::int FROM users u WHERE u.access_level_id = al.id) AS usuarios
     FROM access_levels al WHERE al.id = $1 AND al.tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (rows.length === 0) throw new HttpError(404, 'nível de acesso não encontrado');
  if (rows[0].sistema) throw new HttpError(400, 'os níveis padrão não podem ser removidos');
  if (rows[0].usuarios > 0) throw new HttpError(400, `há ${rows[0].usuarios} usuário(s) neste nível; mude-os de nível antes de remover`);
  await pool.query(`DELETE FROM access_levels WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'remover', recurso: 'access_levels', recursoId: req.params.id,
  });
  res.status(204).send();
});

module.exports = router;
