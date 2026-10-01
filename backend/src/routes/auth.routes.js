const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { PERMISSOES } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');

const router = express.Router();

const SELECT_USUARIO = `SELECT u.id, u.tenant_id, u.nome, u.email, u.location_id, u.access_level_id, u.permissoes_extra,
            al.nome AS nivel, al.permissoes AS permissoes_nivel,
            t.nome AS empresa_nome, l.nome AS location_nome`;
const FROM_USUARIO = `FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     JOIN access_levels al ON al.id = u.access_level_id
     LEFT JOIN locations l ON l.id = u.location_id`;

router.post('/login', async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'email e senha são obrigatórios' });
  }

  const { rows } = await pool.query(
    `${SELECT_USUARIO}, u.senha_hash, u.ativo
     ${FROM_USUARIO}
     WHERE u.email = $1`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.ativo) {
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  }

  const token = jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenant_id,
      nivel: user.nivel,
      locationId: user.location_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({
    token,
    usuario: dadosDoUsuario(user),
  });
});

// Dados publicos do usuario logado, incluindo o nivel e as permissoes efetivas
// (nivel + extras); o frontend monta o menu e os botoes a partir disso.
function dadosDoUsuario(user) {
  const permissoes = [...new Set([...(user.permissoes_nivel || []), ...(user.permissoes_extra || [])])];
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    nivel: user.nivel,
    perfil: user.nivel,
    accessLevelId: user.access_level_id,
    permissoes: permissoes.includes('*') ? ['*', ...PERMISSOES.map((p) => p.chave)] : permissoes,
    admin: permissoes.includes('*'),
    locationId: user.location_id,
    locationNome: user.location_nome || null,
    empresaNome: user.empresa_nome,
  };
}

// Recarrega o usuario logado (perfil/loja podem ter mudado desde o login).
router.get('/me', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `${SELECT_USUARIO} ${FROM_USUARIO} WHERE u.id = $1`,
    [req.user.id]
  );
  res.json(dadosDoUsuario(rows[0]));
});

// Troca da propria senha (exige a senha atual).
router.post('/change-password', authRequired, async (req, res) => {
  const { senha_atual, nova_senha } = req.body || {};
  if (!senha_atual || !nova_senha) throw new HttpError(400, 'senha atual e nova senha são obrigatórias');
  if (String(nova_senha).length < 6) throw new HttpError(400, 'a nova senha deve ter no mínimo 6 caracteres');
  const { rows } = await pool.query(`SELECT senha_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!(await bcrypt.compare(String(senha_atual), rows[0].senha_hash))) {
    throw new HttpError(400, 'senha atual incorreta');
  }
  const hash = await bcrypt.hash(String(nova_senha), 10);
  await pool.query(`UPDATE users SET senha_hash = $1 WHERE id = $2`, [hash, req.user.id]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'trocar_senha', recurso: 'users', recursoId: req.user.id });
  res.status(204).send();
});

module.exports = router;
