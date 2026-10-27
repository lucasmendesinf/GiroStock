// Criacao de usuario compartilhada entre a tela da empresa (POST /api/users) e o painel Master (POST /api/master/usuarios).
// As validacoes ficam em um lugar so. `db` deve ser um client DENTRO de uma transacao (quem chama faz BEGIN/COMMIT).
const bcrypt = require('bcryptjs');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const { checarLimite } = require('../utils/limites');
const { areasEfetivas } = require('../middleware/permissions');

// Zera o 2FA do usuario (segredo, estado, bloqueio e codigos de recuperacao). A exigencia (totp_exigido) nao muda.
async function resetarDoisFatores(db, userId) {
  await db.query(
    `UPDATE users SET totp_ativo = false, totp_segredo_cript = NULL, totp_ativado_em = NULL, totp_ultimo_passo = NULL, totp_falhas = 0, totp_bloqueado_ate = NULL WHERE id = $1`,
    [userId]
  );
  await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
}

// Valida e normaliza um novo e-mail de acesso (unico no sistema todo, sem diferenciar maiusculas). Devolve o e-mail aparado.
async function validarNovoEmail(db, userId, email) {
  const novo = String(email || '').trim();
  if (!novo) throw new HttpError(400, 'informe o novo e-mail');
  if (novo.length > 120 || !isValidEmail(novo)) throw new HttpError(400, 'email inválido');
  const { rows } = await db.query(`SELECT id FROM users WHERE lower(email::text) = lower($1) AND id <> $2`, [novo, userId]);
  if (rows.length > 0) throw new HttpError(409, 'já existe um usuário com este email');
  return novo;
}

// ---------------------------------------------------------------- anti-escalada de acesso
// Regras da gestao de usuarios (tela da empresa; o painel Master tambem respeita a do ultimo Administrador):
//  1. ninguem concede o que nao tem: as areas efetivas do alvo (perfil + ajustes) devem caber nas de quem age (o Administrador concede
//     qualquer coisa a OUTRAS pessoas, mas ninguem amplia o PROPRIO acesso);
//  2. so Administrador cria/promove/edita/desativa/redefine senha de Administrador;
//  3. a empresa nunca fica sem Administrador ativo (garantirOutroAdmin, com lock).
// ator: req.user; alvo: { id, perfil, permissoes } ANTES da mudanca (null ao criar); novo: { perfil, permissoes } DEPOIS.
function checarEscalada(ator, alvo, novo) {
  const ehAdmin = ator.perfil === 'Administrador';
  if ((novo.perfil === 'Administrador' || (alvo && alvo.perfil === 'Administrador')) && !ehAdmin) {
    throw new HttpError(403, 'só um Administrador pode criar, promover ou alterar um Administrador');
  }
  const depois = areasEfetivas(novo.perfil, novo.permissoes);
  const proprio = !!alvo && alvo.id === ator.id;
  if (proprio) {
    const antes = areasEfetivas(alvo.perfil, alvo.permissoes);
    const ampliou = Object.keys(depois).filter((k) => k !== 'Master' && depois[k] && !antes[k]);
    if (ampliou.length > 0) throw new HttpError(403, `você não pode ampliar o seu próprio acesso: ${ampliou.join(', ')}`);
    return;
  }
  if (ehAdmin) return;
  const faltam = Object.keys(depois).filter((k) => k !== 'Master' && depois[k] && !(ator.areas && ator.areas[k]));
  // so o que o alvo GANHA em relacao ao que ja tinha conta como concessao (manter o que ele ja tinha nao e escalada)
  const antes = alvo ? areasEfetivas(alvo.perfil, alvo.permissoes) : {};
  const novas = faltam.filter((k) => !antes[k]);
  if (novas.length > 0) throw new HttpError(403, `você não pode conceder permissões que não tem: ${novas.join(', ')}`);
}

// A empresa precisa de ao menos UM Administrador ativo alem de `alvoId`. Trava os administradores ativos (FOR UPDATE) dentro da
// transacao do chamador: dois pedidos simultaneos que tirariam os dois ultimos nao passam juntos.
async function garantirOutroAdmin(client, tenantId, alvoId) {
  const { rows } = await client.query(`SELECT id FROM users WHERE tenant_id = $1 AND perfil = 'Administrador' AND ativo ORDER BY id FOR UPDATE`, [tenantId]);
  if (!rows.some((r) => r.id !== alvoId)) throw new HttpError(400, 'a empresa precisa ter ao menos um Administrador ativo');
}

const PERFIS = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro', 'Garçom'];

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

// opcoes: { tenantId, nome, email, senha, perfil, location_id, location_ids, permissoes (ja normalizadas),
//           deveTrocarSenha, exigirLoja (perfis que nao sao Administrador precisam de ao menos uma loja),
//           auditoria: { tenantId, usuarioId, acao, detalhes } }
async function criarUsuario(db, opcoes) {
  const { tenantId, nome, email, senha, perfil, location_id: locationId, permissoes, deveTrocarSenha, exigirLoja, auditoria, totpExigido } = opcoes;
  if (perfil === 'Master') throw new HttpError(403, 'o perfil Master só pode ser criado por script');
  if (!nome || !email || !senha || !perfil) throw new HttpError(400, 'nome, email, senha e perfil são obrigatórios');
  if (!isValidEmail(email)) throw new HttpError(400, 'email inválido');
  if (String(senha).length < 6) throw new HttpError(400, 'senha deve ter no mínimo 6 caracteres');
  if (!PERFIS.includes(perfil)) throw new HttpError(400, 'perfil inválido');

  if (locationId) await getOwnedLocation(db, locationId, tenantId);
  const extras = (await lojasAdicionais(db, tenantId, opcoes.location_ids, locationId || null)) || [];
  if (extras.length > 0 && !locationId) throw new HttpError(400, 'escolha a loja principal antes de adicionar outras lojas');
  if (perfil === 'Garçom' && !locationId) throw new HttpError(400, 'o garçom precisa de uma loja principal');
  if (exigirLoja && perfil !== 'Administrador' && !locationId) throw new HttpError(400, 'este perfil precisa de ao menos uma loja');

  // E-mail e unico no sistema todo: o login nao informa a empresa.
  const existing = await db.query(`SELECT 1 FROM users WHERE lower(email::text) = lower($1)`, [email]);
  if (existing.rows.length > 0) throw new HttpError(409, 'já existe um usuário com este email');

  await checarLimite(db, tenantId, 'usuarios');

  const senhaHash = await bcrypt.hash(String(senha), 10);
  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, nome, email, senha_hash, perfil, location_id, permissoes, deve_trocar_senha, totp_exigido)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, nome, email, perfil, location_id, ativo, permissoes`,
    [tenantId, nome, email, senhaHash, perfil, locationId || null, permissoes ? JSON.stringify(permissoes) : null, !!deveTrocarSenha, !!totpExigido]
  );
  await gravarLojasAdicionais(db, tenantId, rows[0].id, extras);
  const a = auditoria || { tenantId, usuarioId: null, acao: 'criar' };
  await logAudit(db, {
    tenantId: a.tenantId, usuarioId: a.usuarioId, acao: a.acao, recurso: 'users', recursoId: rows[0].id,
    detalhes: a.detalhes || { perfil, permissoes },
  });
  return { ...rows[0], location_ids: extras };
}

module.exports = { checarEscalada, garantirOutroAdmin, PERFIS, validarNovoEmail, criarUsuario, lojasAdicionais, gravarLojasAdicionais, resetarDoisFatores };
