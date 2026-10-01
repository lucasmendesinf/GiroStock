const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Valida o token e recarrega o usuario do banco a cada requisicao: assim um usuario
// desativado perde o acesso na hora, e mudancas de nivel/permissoes/loja valem sem novo login.
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ erro: 'Token de autenticação ausente' });
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.tenant_id, u.location_id, u.ativo, u.access_level_id, u.permissoes_extra,
            al.nome AS nivel, al.permissoes AS permissoes_nivel
     FROM users u JOIN access_levels al ON al.id = u.access_level_id
     WHERE u.id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.ativo || user.tenant_id !== payload.tenantId) {
    return res.status(401).json({ erro: 'Usuário inativo ou inexistente' });
  }
  req.user = {
    id: user.id,
    tenantId: user.tenant_id,
    nivel: user.nivel,
    accessLevelId: user.access_level_id,
    permissoes: [...new Set([...(user.permissoes_nivel || []), ...(user.permissoes_extra || [])])],
    locationId: user.location_id,
  };
  next();
}

module.exports = { authRequired };
