const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { areasEfetivas, MATRIX } = require('./permissions');
const modoTeste = require('../services/modoTeste');

// Valida o token e recarrega o usuario do banco a cada requisicao: assim um usuario
// desativado perde o acesso na hora, e mudancas de perfil/local valem sem novo login.
// O usuario e SEMPRE lido da PRODUCAO (fonte de verdade de login, ativo/inativo e permissoes), mesmo em modo teste;
// so depois o banco de negocio da requisicao e escolhido (token com `modo: 'teste'` -> banco de teste).
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

  const prod = pool.producao;
  const { rows } = await prod.query(
    `SELECT id, tenant_id, perfil, location_id, ativo, permissoes FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.ativo || user.tenant_id !== payload.tenantId) {
    return res.status(401).json({ erro: 'Usuário inativo ou inexistente' });
  }
  const extras = await prod.query(`SELECT location_id FROM user_locations WHERE user_id = $1`, [user.id]);
  const locationIds = [user.location_id, ...extras.rows.map((r) => r.location_id)].filter(Boolean);
  const areasProd = areasEfetivas(user.perfil, user.permissoes);
  req.user = {
    id: user.id,
    tenantId: user.tenant_id,
    perfil: user.perfil,
    locationId: user.location_id,
    locationIds,
    areas: areasProd,
    areasProd,
    master: user.perfil === 'Master',
    modoTeste: false,
  };

  if (payload.modo !== 'teste') return next();

  // ---- Modo teste: a permissao e revalidada a cada requisicao (retirada = volta para producao) ----
  if (!areasProd.ModoTeste) {
    return res.status(403).json({ erro: 'Seu usuário não tem mais acesso ao modo teste', modoTesteRevogado: true });
  }
  if (!pool.testeConfigurado()) {
    return res.status(409).json({ erro: 'modo teste não configurado', modoTesteRevogado: true });
  }
  if (modoTeste.estaCopiando()) {
    return res.status(503).json({ erro: 'cópia da produção em andamento: aguarde alguns instantes' });
  }
  req.user.modoTeste = true;
  if (req.user.master) {
    // Master nao tem dados de empresa: testa "como Administrador" da empresa escolhida (so no banco de teste).
    if (!payload.empresaTeste) {
      return res.status(403).json({ erro: 'escolha a empresa a testar', modoTesteRevogado: true });
    }
    req.user.empresaTeste = payload.empresaTeste;
    req.user.tenantId = payload.empresaTeste;
    req.user.perfil = 'Administrador';
    req.user.locationId = null;
    req.user.locationIds = [];
    req.user.areas = { ...MATRIX.Administrador, ModoTeste: true, Master: true };
  }
  return pool.executarEmTeste(() => next());
}

module.exports = { authRequired };
