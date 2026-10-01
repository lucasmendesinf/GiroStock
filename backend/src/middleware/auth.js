const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Valida o token e recarrega o usuario do banco a cada requisicao: assim um usuario
// desativado perde o acesso na hora, e mudancas de perfil/local valem sem novo login.
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ erro: 'Token de autenticacao ausente' });
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }

  const { rows } = await pool.query(
    `SELECT id, tenant_id, perfil, location_id, ativo FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.ativo || user.tenant_id !== payload.tenantId) {
    return res.status(401).json({ erro: 'Usuario inativo ou inexistente' });
  }
  req.user = {
    id: user.id,
    tenantId: user.tenant_id,
    perfil: user.perfil,
    locationId: user.location_id,
  };
  next();
}

module.exports = { authRequired };
