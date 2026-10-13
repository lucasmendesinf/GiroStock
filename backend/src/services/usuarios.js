// Criacao de usuario compartilhada entre a tela da empresa (POST /api/users) e o painel Master (POST /api/master/usuarios).
// As validacoes ficam em um lugar so. `db` deve ser um client DENTRO de uma transacao (quem chama faz BEGIN/COMMIT).
const bcrypt = require('bcryptjs');
const { isValidEmail } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const { checarLimite } = require('../utils/limites');

const PERFIS = ['Administrador', 'Gerente', 'Caixa/Operador', 'Estoque', 'Lanchonete/Cozinha', 'Financeiro'];

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
  const { tenantId, nome, email, senha, perfil, location_id: locationId, permissoes, deveTrocarSenha, exigirLoja, auditoria } = opcoes;
  if (perfil === 'Master') throw new HttpError(403, 'o perfil Master só pode ser criado por script');
  if (!nome || !email || !senha || !perfil) throw new HttpError(400, 'nome, email, senha e perfil são obrigatórios');
  if (!isValidEmail(email)) throw new HttpError(400, 'email inválido');
  if (String(senha).length < 6) throw new HttpError(400, 'senha deve ter no mínimo 6 caracteres');
  if (!PERFIS.includes(perfil)) throw new HttpError(400, 'perfil inválido');

  if (locationId) await getOwnedLocation(db, locationId, tenantId);
  const extras = (await lojasAdicionais(db, tenantId, opcoes.location_ids, locationId || null)) || [];
  if (extras.length > 0 && !locationId) throw new HttpError(400, 'escolha a loja principal antes de adicionar outras lojas');
  if (exigirLoja && perfil !== 'Administrador' && !locationId) throw new HttpError(400, 'este perfil precisa de ao menos uma loja');

  // E-mail e unico no sistema todo: o login nao informa a empresa.
  const existing = await db.query(`SELECT 1 FROM users WHERE lower(email::text) = lower($1)`, [email]);
  if (existing.rows.length > 0) throw new HttpError(409, 'já existe um usuário com este email');

  await checarLimite(db, tenantId, 'usuarios');

  const senhaHash = await bcrypt.hash(String(senha), 10);
  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, nome, email, senha_hash, perfil, location_id, permissoes, deve_trocar_senha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, nome, email, perfil, location_id, ativo, permissoes`,
    [tenantId, nome, email, senhaHash, perfil, locationId || null, permissoes ? JSON.stringify(permissoes) : null, !!deveTrocarSenha]
  );
  await gravarLojasAdicionais(db, tenantId, rows[0].id, extras);
  const a = auditoria || { tenantId, usuarioId: null, acao: 'criar' };
  await logAudit(db, {
    tenantId: a.tenantId, usuarioId: a.usuarioId, acao: a.acao, recurso: 'users', recursoId: rows[0].id,
    detalhes: a.detalhes || { perfil, permissoes },
  });
  return { ...rows[0], location_ids: extras };
}

module.exports = { PERFIS, criarUsuario, lojasAdicionais, gravarLojasAdicionais };
