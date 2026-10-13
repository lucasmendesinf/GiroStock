const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const { areasEfetivas } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const modoTeste = require('../services/modoTeste');
const { dadosDaEmpresa, efetivos, aplicarRecursos } = require('../utils/limites');

const router = express.Router();
// Login, /me, troca de senha e ativacao do modo teste usam SEMPRE a producao (usuarios e permissoes moram la).
const db = pool.producao;

// A loja do usuario (ou qualquer loja, para quem nao e restrito) usa pedidos? Controla o item Pedidos do menu.
async function usaPedidos(tenantId, locationIds, perfil) {
  const restrito = perfil !== 'Administrador' && locationIds.length > 0;
  const { rows } = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM locations WHERE tenant_id = $1 AND ativo AND usa_pedidos AND ($2::boolean = false OR id = ANY($3::uuid[]))) AS ok`,
    [tenantId, restrito, locationIds]
  );
  return rows[0].ok;
}

// Lojas adicionais do usuario (alem da principal), com nome.
async function lojasExtras(userId) {
  const { rows } = await db.query(
    `SELECT l.id, l.nome FROM user_locations ul JOIN locations l ON l.id = ul.location_id WHERE ul.user_id = $1 ORDER BY l.nome`,
    [userId]
  );
  return rows;
}

router.post('/login', async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'email e senha são obrigatórios' });
  }

  const { rows } = await db.query(
    `SELECT u.id, u.tenant_id, u.nome, u.email, u.senha_hash, u.perfil, u.location_id, u.ativo, u.permissoes, u.deve_trocar_senha,
            t.nome AS empresa_nome, l.nome AS location_nome
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN locations l ON l.id = u.location_id
     WHERE lower(u.email::text) = lower($1)`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.ativo) {
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    // Contagem de falhas (painel Master > Usuarios & seguranca): zera no login correto.
    await db.query(`UPDATE users SET falhas_login = falhas_login + 1, ultima_falha_em = now() WHERE id = $1`, [user.id]);
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }
  // Empresa suspensa: nao entra (o Master nunca e bloqueado).
  const empresa = user.perfil === 'Master' ? null : await dadosDaEmpresa(db, user.tenant_id);
  if (empresa && empresa.status === 'suspensa') {
    return res.status(403).json({ erro: 'empresa suspensa', empresaSuspensa: true, motivo: empresa.suspenso_motivo || null });
  }
  await db.query(`UPDATE users SET ultimo_login = now(), falhas_login = 0 WHERE id = $1`, [user.id]);
  user.areasEfetivas = aplicarRecursos(areasEfetivas(user.perfil, user.permissoes), empresa ? efetivos(empresa).recursos : null);

  const token = jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenant_id,
      perfil: user.perfil,
      locationId: user.location_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  user.extras = await lojasExtras(user.id);
  user.usa_pedidos = await usaPedidos(user.tenant_id, [user.location_id, ...user.extras.map((e) => e.id)].filter(Boolean), user.perfil);
  res.json({
    token,
    usuario: dadosDoUsuario(user),
  });
});

// Dados publicos do usuario logado, incluindo as areas que o perfil acessa
// (o frontend monta o menu a partir disso).
function dadosDoUsuario(user) {
  const master = user.perfil === 'Master';
  return {
    deveTrocarSenha: !!user.deve_trocar_senha,
    master,
    modoTeste: !!user.modoTeste,
    empresaTeste: user.empresaTeste || null,
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: user.perfil,
    locationId: user.location_id,
    locationIds: [user.location_id, ...(user.extras || []).map((e) => e.id)].filter(Boolean),
    usaPedidos: !!user.usa_pedidos,
    locationNome: [user.location_nome, ...(user.extras || []).map((e) => e.nome)].filter(Boolean).join(', ') || null,
    empresaNome: user.empresa_nome,
    areas: user.areasEfetivas || areasEfetivas(user.perfil, user.permissoes),
  };
}

// Recarrega o usuario logado (perfil/loja podem ter mudado desde o login).
router.get('/me', authRequired, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.location_id, u.permissoes, u.deve_trocar_senha, t.nome AS empresa_nome, l.nome AS location_nome
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN locations l ON l.id = u.location_id
     WHERE u.id = $1`,
    [req.user.id]
  );
  rows[0].extras = await lojasExtras(req.user.id);
  // Em modo teste, o menu (Pedidos etc.) reflete o banco de teste: `pool` acompanha o contexto da requisicao.
  rows[0].usa_pedidos = await usaPedidos(req.user.tenantId, req.user.locationIds, req.user.perfil);
  rows[0].modoTeste = req.user.modoTeste;
  rows[0].areasEfetivas = req.user.areas;
  if (req.user.modoTeste) {
    if (req.user.master) {
      const emp = await pool.query(`SELECT id, nome FROM tenants WHERE id = $1`, [req.user.empresaTeste]);
      rows[0].empresaTeste = emp.rows[0] || null;
    }
  }
  res.json(dadosDoUsuario(rows[0]));
});

// Troca da propria senha (exige a senha atual).
router.post('/change-password', authRequired, async (req, res) => {
  const { senha_atual, nova_senha } = req.body || {};
  if (!senha_atual || !nova_senha) throw new HttpError(400, 'senha atual e nova senha são obrigatórias');
  if (String(nova_senha).length < 6) throw new HttpError(400, 'a nova senha deve ter no mínimo 6 caracteres');
  const { rows } = await db.query(`SELECT senha_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!(await bcrypt.compare(String(senha_atual), rows[0].senha_hash))) {
    throw new HttpError(400, 'senha atual incorreta');
  }
  const hash = await bcrypt.hash(String(nova_senha), 10);
  await db.query(`UPDATE users SET senha_hash = $1, deve_trocar_senha = false WHERE id = $2`, [hash, req.user.id]);
  await logAudit(db, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'trocar_senha', recurso: 'users', recursoId: req.user.id });
  res.status(204).send();
});

function assinar(user, extra = {}) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenant_id, perfil: user.perfil, locationId: user.location_id, ...extra },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

// Liga/desliga o modo teste da SESSAO: devolve um novo token (com a claim `modo: 'teste'`) e o front troca de token.
// Exige a area ModoTeste (checada em producao a cada chamada). Master escolhe a empresa a testar (empresa_id).
// Na primeira vez (teste ainda sem copia) a copia completa da producao e feita aqui, com confirmacao (confirmar_copia).
router.post('/modo-teste', authRequired, async (req, res) => {
  const { ativo, empresa_id, confirmar_copia, anonimizar } = req.body || {};
  if (!req.user.areasProd.ModoTeste) throw new HttpError(403, 'Seu usuário não tem acesso ao modo teste');
  const { rows } = await db.query(`SELECT id, tenant_id, perfil, location_id FROM users WHERE id = $1`, [req.user.id]);
  const user = rows[0];
  const meuTenant = user.tenant_id;

  if (!ativo) {
    await logAudit(db, { tenantId: meuTenant, usuarioId: user.id, acao: 'desligar_modo_teste', recurso: 'modo_teste' });
    return res.json({ token: assinar(user) });
  }

  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
  await modoTeste.garantirBancoTeste();
  if (await modoTeste.precisaCopiar()) {
    if (!confirmar_copia) {
      return res.status(409).json({ erro: 'O banco de teste ainda não recebeu a cópia da produção. Confirme para copiar tudo agora.', precisa_copia: true });
    }
    const { copiarProducao } = require('../services/copiaProducao');
    await copiarProducao({ usuarioId: user.id, tenantId: meuTenant, anonimizar: anonimizar !== false, motivo: 'primeira ativação do modo teste' });
  }
  await modoTeste.garantirUsuarioNoTeste(user.id);

  let extra = { modo: 'teste' };
  if (user.perfil === 'Master') {
    const empresas = await modoTeste.empresasDoTeste();
    const escolhida = empresas.find((e) => e.id === empresa_id);
    if (!escolhida) throw new HttpError(400, 'escolha a empresa a testar');
    extra = { modo: 'teste', empresaTeste: escolhida.id };
  }
  await logAudit(db, { tenantId: meuTenant, usuarioId: user.id, acao: 'ligar_modo_teste', recurso: 'modo_teste', detalhes: { empresa_teste: extra.empresaTeste || null } });
  res.json({ token: assinar(user, extra) });
});

module.exports = router;
