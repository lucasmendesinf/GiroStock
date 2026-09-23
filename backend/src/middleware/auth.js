const jwt = require('jsonwebtoken');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ erro: 'Token de autenticacao ausente' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.sub,
      tenantId: payload.tenantId,
      perfil: payload.perfil,
      locationId: payload.locationId,
    };
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }
}

module.exports = { authRequired };
