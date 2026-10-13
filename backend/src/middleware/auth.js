const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { areasEfetivas, MATRIX } = require('./permissions');
const modoTeste = require('../services/modoTeste');
const { marcarAcesso } = require('../services/monitoramento');
const config = require('../services/config');
const suporte = require('../services/suporte');
const contextoSuporte = require('../utils/contextoSuporte');
const { verificar: verificarSuporte } = require('../config/suporteBloqueios');
const { dadosDaEmpresa, efetivos, aplicarRecursos } = require('../utils/limites');

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
  // Token de 2FA pendente/configurar (emitido so depois da senha) NAO abre nenhuma rota de negocio.
  if (payload.mfa) {
    return res.status(401).json({ erro: 'Verificação em duas etapas pendente' });
  }

  const prod = pool.producao;
  const { rows } = await prod.query(
    `SELECT id, tenant_id, perfil, location_id, ativo, permissoes, sessoes_validas_desde FROM users WHERE id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.ativo || user.tenant_id !== payload.tenantId) {
    return res.status(401).json({ erro: 'Usuário inativo ou inexistente' });
  }
  marcarAcesso(user.id); // ultimo acesso (no maximo 1x/min por usuario; nao bloqueia)
  // Encerrar sessoes: tokens emitidos antes de sessoes_validas_desde deixam de valer (comparacao em segundos inteiros).
  if (user.sessoes_validas_desde && payload.iat < Math.floor(new Date(user.sessoes_validas_desde).getTime() / 1000)) {
    return res.status(401).json({ erro: 'Sessão encerrada: entre novamente' });
  }
  // Empresa suspensa: cai na hora, tambem para sessoes ja abertas (o Master nunca e bloqueado).
  const master = user.perfil === 'Master';
  const empresa = master ? null : await dadosDaEmpresa(prod, user.tenant_id);
  if (empresa && empresa.status === 'suspensa') {
    return res.status(403).json({ erro: 'empresa suspensa', empresaSuspensa: true, motivo: empresa.suspenso_motivo || null });
  }
  // Modo manutencao: so o Master passa (e /auth/me, para o front descobrir o estado e a mensagem).
  if (!master && !req.originalUrl.startsWith('/api/auth/me')) {
    const manut = await config.obter('manutencao');
    if (manut.ativo) return res.status(503).json({ erro: manut.mensagem || 'Sistema em manutenção. Tente novamente em instantes.', manutencao: true });
  }
  const extras = await prod.query(`SELECT location_id FROM user_locations WHERE user_id = $1`, [user.id]);
  const locationIds = [user.location_id, ...extras.rows.map((r) => r.location_id)].filter(Boolean);
  // Recursos da empresa (Pedidos/Clientes) valem para todos os usuarios dela, num ponto so.
  const areasProd = aplicarRecursos(areasEfetivas(user.perfil, user.permissoes), empresa ? efetivos(empresa).recursos : null);
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

  // ---- Sessao de suporte: o Master age como Administrador da empresa acessada (so por tempo curto, a cada requisicao conferido no banco) ----
  if (payload.suporte) {
    if (!master || payload.modo) return res.status(401).json({ erro: 'Sessão de suporte inválida' });
    let ativa;
    try { ativa = await suporte.validarSessao(prod, payload.suporte.sessaoId, user, dadosDaEmpresa); } catch (err) { return res.status(err.status || 401).json({ erro: err.message, suporteEncerrado: true }); }
    const { sessao, empresa: emp } = ativa;
    const caminho = req.originalUrl.split('?')[0].replace(/^\/api/, '');
    const bloqueio = verificarSuporte(req.method, caminho, sessao.edicao);
    if (bloqueio) return res.status(403).json({ erro: bloqueio, suporte: true });
    req.user = {
      ...req.user,
      tenantId: sessao.tenant_id,
      perfil: 'Administrador',
      locationId: null,
      locationIds: [],
      areas: aplicarRecursos({ ...MATRIX.Administrador, ModoTeste: false, Master: false }, efetivos(emp).recursos),
      master: true,
      suporte: { sessaoId: sessao.id, edicao: sessao.edicao, expiraEm: sessao.expira_em, empresaNome: emp.nome, empresaId: sessao.tenant_id },
    };
    return contextoSuporte.executar({ sessaoId: sessao.id, masterId: user.id }, () => next());
  }

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
    // Simula a empresa escolhida: os recursos dela (Pedidos/Clientes) tambem valem.
    const empTeste = await dadosDaEmpresa(prod, payload.empresaTeste);
    req.user.areas = aplicarRecursos({ ...MATRIX.Administrador, ModoTeste: true, Master: true }, empTeste ? efetivos(empTeste).recursos : null);
  }
  return pool.executarEmTeste(() => next());
}

// Rotas de ativacao do 2FA: aceitam o token completo OU o token_mfa de "configurar" (Master/exigido ainda sem 2FA).
async function authOuMfaConfigurar(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token de autenticação ausente' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
  if (!payload.mfa) return authRequired(req, res, next);
  if (payload.mfa !== 'configurar') return res.status(401).json({ erro: 'Token de verificação não vale para esta rota' });
  const { rows } = await pool.producao.query(`SELECT id, tenant_id, perfil, ativo FROM users WHERE id = $1`, [payload.sub]);
  const user = rows[0];
  if (!user || !user.ativo || user.tenant_id !== payload.tenantId) return res.status(401).json({ erro: 'Usuário inativo ou inexistente' });
  req.user = { id: user.id, tenantId: user.tenant_id, perfil: user.perfil, master: user.perfil === 'Master', areas: {} };
  req.mfaConfigurar = true;
  return next();
}

module.exports = { authRequired, authOuMfaConfigurar };
