const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authRequired, authOuMfaConfigurar } = require('../middleware/auth');
const totp = require('../services/totp');
const { areasEfetivas } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const config = require('../services/config');
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

const COLUNAS_LOGIN = `u.id, u.tenant_id, u.nome, u.email, u.senha_hash, u.perfil, u.location_id, u.ativo, u.permissoes, u.deve_trocar_senha,
            u.totp_ativo, u.totp_exigido, u.totp_segredo_cript, u.totp_ultimo_passo, u.totp_falhas, u.totp_bloqueado_ate,
            (SELECT COUNT(*)::int FROM user_recovery_codes rc WHERE rc.user_id = u.id AND rc.usado_em IS NULL) AS codigos_restantes,
            t.nome AS empresa_nome, l.nome AS location_nome`;
const DE_LOGIN = `FROM users u JOIN tenants t ON t.id = u.tenant_id LEFT JOIN locations l ON l.id = u.location_id`;

// Conclui o login (senha ok e, se houver, 2FA ok): grava ultimo acesso e devolve { token, usuario }.
async function concluirLogin(user, empresa) {
  await db.query(`UPDATE users SET ultimo_login = now(), falhas_login = 0 WHERE id = $1`, [user.id]);
  user.areasEfetivas = aplicarRecursos(areasEfetivas(user.perfil, user.permissoes), empresa ? efetivos(empresa).recursos : null);
  user.extras = await lojasExtras(user.id);
  user.usa_pedidos = await usaPedidos(user.tenant_id, [user.location_id, ...user.extras.map((e) => e.id)].filter(Boolean), user.perfil);
  return { token: assinar(user), usuario: { ...dadosDoUsuario(user), parametros: await config.parametrosPublicos() } };
}

// Token curto do 2FA (nao abre rotas de negocio): 'pendente' (5 min) ou 'configurar' (15 min).
function assinarMfa(user, tipo) {
  return jwt.sign({ sub: user.id, tenantId: user.tenant_id, mfa: tipo }, process.env.JWT_SECRET, { expiresIn: tipo === 'pendente' ? '5m' : '15m' });
}

// Auditoria de login com falha sem ruido: a partir da 3a falha seguida e depois a cada 5a (3, 5, 10, 15...).
function deveAuditarFalha(n) {
  return n === 3 || (n > 3 && n % 5 === 0);
}

// E-mail que nao existe: conta em memoria (por e-mail) e audita na empresa "Plataforma" pela mesma regra, sem gravar o e-mail digitado.
const falhasDesconhecidas = new Map();
async function registrarFalhaDeUsuarioInexistente(email) {
  const chave = String(email).trim().toLowerCase();
  const n = (falhasDesconhecidas.get(chave) || 0) + 1;
  falhasDesconhecidas.set(chave, n);
  if (falhasDesconhecidas.size > 2000) falhasDesconhecidas.clear();
  if (!deveAuditarFalha(n)) return;
  try {
    const t = await db.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`);
    if (t.rows[0]) await logAudit(db, { tenantId: t.rows[0].id, usuarioId: null, acao: 'login_falha', recurso: 'users', detalhes: { motivo: 'usuario_inexistente', falhas_seguidas: n } });
  } catch (e) { /* auditoria nao pode derrubar o login */ }
}

router.post('/login', async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'email e senha são obrigatórios' });
  }

  const { rows } = await db.query(`SELECT ${COLUNAS_LOGIN} ${DE_LOGIN} WHERE lower(u.email::text) = lower($1)`, [email]);
  const user = rows[0];
  if (!user || !user.ativo) {
    if (!user) await registrarFalhaDeUsuarioInexistente(email);
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    // Contagem de falhas (painel Master > Usuarios & seguranca): zera no login correto.
    const { rows: f } = await db.query(`UPDATE users SET falhas_login = falhas_login + 1, ultima_falha_em = now() WHERE id = $1 RETURNING falhas_login`, [user.id]);
    if (deveAuditarFalha(f[0].falhas_login)) {
      // Nunca grava a senha tentada.
      await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'login_falha', recurso: 'users', recursoId: user.id, detalhes: { falhas_seguidas: f[0].falhas_login } }).catch(() => {});
    }
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }
  // Modo manutencao: so o Master entra.
  const manut = await config.obter('manutencao');
  if (manut.ativo && user.perfil !== 'Master') {
    return res.status(503).json({ erro: manut.mensagem || 'Sistema em manutenção. Tente novamente em instantes.', manutencao: true });
  }
  // Empresa suspensa: nao entra (o Master nunca e bloqueado).
  const empresa = user.perfil === 'Master' ? null : await dadosDaEmpresa(db, user.tenant_id);
  if (empresa && empresa.status === 'suspensa') {
    return res.status(403).json({ erro: 'empresa suspensa', empresaSuspensa: true, motivo: empresa.suspenso_motivo || null });
  }

  // Segundo fator: senha certa NAO devolve o token completo quando o usuario tem 2FA (ou e obrigado a ter).
  if (user.totp_ativo) {
    return res.json({ mfa: 'pendente', token_mfa: assinarMfa(user, 'pendente') });
  }
  if (user.perfil === 'Master' || user.totp_exigido) {
    if (!totp.disponivel()) {
      return res.status(503).json({ erro: 'Verificação em duas etapas indisponível: o servidor não tem a TOTP_ENC_KEY configurada.' });
    }
    return res.json({ mfa: 'configurar', token_mfa: assinarMfa(user, 'configurar') });
  }
  res.json(await concluirLogin(user, empresa));
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
    doisFatores: { ativo: !!user.totp_ativo, exigido: master || !!user.totp_exigido, codigosRestantes: user.codigos_restantes || 0 },
    areas: user.areasEfetivas || areasEfetivas(user.perfil, user.permissoes),
  };
}

// Recarrega o usuario logado (perfil/loja podem ter mudado desde o login).
router.get('/me', authRequired, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.location_id, u.permissoes, u.deve_trocar_senha, u.totp_ativo, u.totp_exigido,
            (SELECT COUNT(*)::int FROM user_recovery_codes rc WHERE rc.user_id = u.id AND rc.usado_em IS NULL) AS codigos_restantes,
            t.nome AS empresa_nome, l.nome AS location_nome
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
  const manut = await config.obter('manutencao');
  res.json({ ...dadosDoUsuario(rows[0]), parametros: await config.parametrosPublicos(), manutencao: manut.ativo && !req.user.master ? { ativo: true, mensagem: manut.mensagem || '' } : null });
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

// ================================================================ 2FA (TOTP)
const MAX_FALHAS_2FA = 5;
const BLOQUEIO_MIN = 15;

function exigir2faDisponivel() {
  if (!totp.disponivel()) throw new HttpError(503, 'Verificação em duas etapas indisponível: o servidor não tem a TOTP_ENC_KEY configurada.');
}

async function carregarUsuario2fa(id) {
  const { rows } = await db.query(`SELECT ${COLUNAS_LOGIN} ${DE_LOGIN} WHERE u.id = $1`, [id]);
  return rows[0];
}

function bloqueado(user) {
  if (user.totp_bloqueado_ate && new Date(user.totp_bloqueado_ate) > new Date()) {
    const min = Math.max(1, Math.ceil((new Date(user.totp_bloqueado_ate) - new Date()) / 60000));
    throw Object.assign(new HttpError(429, `Muitas tentativas. Tente novamente em ${min} min.`), { minutos: min });
  }
}

// Erro de codigo: conta a falha; a 5a bloqueia por 15 min (429). Mensagem generica.
async function falhaCodigo(user) {
  const { rows } = await db.query(`UPDATE users SET totp_falhas = totp_falhas + 1 WHERE id = $1 RETURNING totp_falhas`, [user.id]);
  if (rows[0].totp_falhas >= MAX_FALHAS_2FA) {
    await db.query(`UPDATE users SET totp_falhas = 0, totp_bloqueado_ate = now() + interval '${BLOQUEIO_MIN} minutes' WHERE id = $1`, [user.id]);
    await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'bloquear_2fa', recurso: 'users', recursoId: user.id, detalhes: { minutos: BLOQUEIO_MIN } });
    throw Object.assign(new HttpError(429, `Muitas tentativas. Tente novamente em ${BLOQUEIO_MIN} min.`), { minutos: BLOQUEIO_MIN });
  }
  throw new HttpError(400, 'código inválido');
}

// Confere TOTP (e, se permitido, codigo de recuperacao de uso unico). Devolve 'totp' | 'recuperacao' | null.
async function conferirCodigo(user, codigo, { recuperacao = false } = {}) {
  const segredo = totp.decifrar(user.totp_segredo_cript);
  const passo = totp.verificar(segredo, codigo, user.totp_ultimo_passo);
  if (passo !== null) {
    // O UPDATE condicional impede que o MESMO codigo valha duas vezes, mesmo em requisicoes simultaneas.
    const r = await db.query(`UPDATE users SET totp_ultimo_passo = $1 WHERE id = $2 AND (totp_ultimo_passo IS NULL OR totp_ultimo_passo < $1)`, [passo, user.id]);
    if (r.rowCount === 1) return 'totp';
    return null;
  }
  if (recuperacao && totp.pareceRecuperacao(codigo)) {
    const { rows } = await db.query(`SELECT id, codigo_hash FROM user_recovery_codes WHERE user_id = $1 AND usado_em IS NULL`, [user.id]);
    const norm = totp.normalizarRecuperacao(codigo);
    for (const c of rows) {
      if (await bcrypt.compare(norm, c.codigo_hash)) {
        const r = await db.query(`UPDATE user_recovery_codes SET usado_em = now() WHERE id = $1 AND usado_em IS NULL`, [c.id]);
        return r.rowCount === 1 ? 'recuperacao' : null;
      }
    }
  }
  return null;
}

async function novosCodigosRecuperacao(userId) {
  const codigos = totp.gerarCodigosRecuperacao(10);
  await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  for (const c of codigos) {
    await db.query(`INSERT INTO user_recovery_codes (user_id, codigo_hash) VALUES ($1, $2)`, [userId, await totp.hashRecuperacao(c)]);
  }
  return codigos;
}

function tokenMfa(req, tipo) {
  try {
    const p = jwt.verify(String((req.body || {}).token_mfa || ''), process.env.JWT_SECRET);
    if (p.mfa !== tipo) throw new Error('tipo');
    return p;
  } catch (err) {
    throw new HttpError(401, 'Sessão de verificação expirada: entre novamente.');
  }
}

// Segundo passo do login: codigo do app autenticador OU codigo de recuperacao.
router.post('/2fa/verificar', async (req, res) => {
  const p = tokenMfa(req, 'pendente');
  const codigo = String((req.body || {}).codigo || '').trim();
  if (!codigo) throw new HttpError(400, 'informe o código');
  exigir2faDisponivel();
  const user = await carregarUsuario2fa(p.sub);
  if (!user || !user.ativo || !user.totp_ativo) throw new HttpError(401, 'Sessão de verificação inválida: entre novamente.');
  bloqueado(user);
  const empresa = user.perfil === 'Master' ? null : await dadosDaEmpresa(db, user.tenant_id);
  if (empresa && empresa.status === 'suspensa') {
    return res.status(403).json({ erro: 'empresa suspensa', empresaSuspensa: true, motivo: empresa.suspenso_motivo || null });
  }
  const tipo = await conferirCodigo(user, codigo, { recuperacao: true });
  if (!tipo) await falhaCodigo(user);
  await db.query(`UPDATE users SET totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $1`, [user.id]);
  const resp = await concluirLogin(user, empresa);
  if (tipo === 'recuperacao') {
    const restantes = Number((await db.query(`SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = $1 AND usado_em IS NULL`, [user.id])).rows[0].n);
    await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'login_codigo_recuperacao', recurso: 'users', recursoId: user.id, detalhes: { restantes } });
    resp.usuario.doisFatores.codigosRestantes = restantes;
    resp.aviso = `Você entrou com um código de recuperação. Restam ${restantes}.`;
  }
  res.json(resp);
});

// Prepara a ativacao: segredo novo (ainda nao ativo), guardado CIFRADO; devolve QR (PNG), chave para digitar e URI.
router.post('/2fa/preparar', authOuMfaConfigurar, async (req, res) => {
  exigir2faDisponivel();
  const user = await carregarUsuario2fa(req.user.id);
  if (user.totp_ativo) throw new HttpError(409, 'a verificação em duas etapas já está ativa');
  const segredo = totp.gerarSegredo();
  await db.query(`UPDATE users SET totp_segredo_cript = $1, totp_ultimo_passo = NULL WHERE id = $2`, [totp.cifrar(segredo), user.id]);
  const uri = totp.uriOtpauth(user.email, segredo);
  res.json({ qr: await totp.qrDataUrl(uri), chave: segredo, uri });
});

// Confirma com um codigo do app, ativa e mostra os 10 codigos de recuperacao UMA unica vez.
router.post('/2fa/ativar', authOuMfaConfigurar, async (req, res) => {
  exigir2faDisponivel();
  const user = await carregarUsuario2fa(req.user.id);
  if (user.totp_ativo) throw new HttpError(409, 'a verificação em duas etapas já está ativa');
  if (!user.totp_segredo_cript) throw new HttpError(400, 'gere o QR code primeiro');
  const passo = totp.verificar(totp.decifrar(user.totp_segredo_cript), (req.body || {}).codigo, null);
  if (passo === null) throw new HttpError(400, 'código inválido');
  await db.query(`UPDATE users SET totp_ativo = true, totp_ativado_em = now(), totp_ultimo_passo = $1, totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $2`, [passo, user.id]);
  const codigos = await novosCodigosRecuperacao(user.id);
  await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'ativar_2fa', recurso: 'users', recursoId: user.id });
  const resp = { ativo: true, codigos_recuperacao: codigos };
  if (req.mfaConfigurar) {
    // Login concluido: Master/usuario com 2FA exigido ativou agora.
    const empresa = user.perfil === 'Master' ? null : await dadosDaEmpresa(db, user.tenant_id);
    const novo = await carregarUsuario2fa(user.id);
    Object.assign(resp, await concluirLogin(novo, empresa));
  }
  res.json(resp);
});

async function conferirSenhaECodigo(req) {
  exigir2faDisponivel();
  const { senha, codigo } = req.body || {};
  if (!senha || !codigo) throw new HttpError(400, 'informe a senha e o código atual');
  const user = await carregarUsuario2fa(req.user.id);
  if (!user.totp_ativo) throw new HttpError(409, 'a verificação em duas etapas não está ativa');
  bloqueado(user);
  if (!(await bcrypt.compare(String(senha), user.senha_hash))) throw new HttpError(400, 'senha incorreta');
  if (!(await conferirCodigo(user, codigo))) await falhaCodigo(user);
  return user;
}

router.post('/2fa/desativar', authRequired, async (req, res) => {
  const atual = await carregarUsuario2fa(req.user.id);
  if (atual.perfil === 'Master' || atual.totp_exigido) throw new HttpError(403, 'Este usuário é obrigado a manter a verificação em duas etapas.');
  const user = await conferirSenhaECodigo(req);
  await db.query(
    `UPDATE users SET totp_ativo = false, totp_segredo_cript = NULL, totp_ativado_em = NULL, totp_ultimo_passo = NULL, totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $1`,
    [user.id]
  );
  await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [user.id]);
  await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'desativar_2fa', recurso: 'users', recursoId: user.id });
  res.json({ ativo: false });
});

router.post('/2fa/codigos-recuperacao', authRequired, async (req, res) => {
  const user = await conferirSenhaECodigo(req);
  const codigos = await novosCodigosRecuperacao(user.id);
  await logAudit(db, { tenantId: user.tenant_id, usuarioId: user.id, acao: 'gerar_codigos_recuperacao_2fa', recurso: 'users', recursoId: user.id });
  res.json({ codigos_recuperacao: codigos });
});

module.exports = router;
