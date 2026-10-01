const { HttpError } = require('./http');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tabelas que podem ser verificadas (nome nunca vem do cliente).
const LABELS = {
  products: 'produto',
  locations: 'local',
  suppliers: 'fornecedor',
  categories: 'categoria',
  ingredients: 'insumo',
  terminals: 'terminal',
  users: 'usuário',
  sales: 'venda',
};

function isUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// Garante que o registro existe E pertence a empresa do usuario logado.
// Sem isso, uma empresa conseguia mexer em produtos/locais de outra informando o id.
// Opcoes: ativo (exige ativo = true), columns (colunas extras a retornar), lock (FOR UPDATE).
async function getOwned(db, table, id, tenantId, { ativo = false, columns = 'id', lock = false } = {}) {
  const label = LABELS[table];
  if (!label) throw new Error(`tabela nao permitida: ${table}`);
  if (!isUuid(id)) throw new HttpError(400, `${label} inválido`);
  const { rows } = await db.query(
    `SELECT ${columns} FROM ${table} WHERE id = $1 AND tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, tenantId]
  );
  if (rows.length === 0) throw new HttpError(404, `${label} não encontrado`);
  if (ativo && rows[0].ativo === false) throw new HttpError(400, `${label} está inativo`);
  return rows[0];
}

// Versao para locais: sempre exige local ativo e retorna { id, nome, ativo }.
async function getOwnedLocation(db, id, tenantId) {
  return getOwned(db, 'locations', id, tenantId, { ativo: true, columns: 'id, nome, ativo' });
}

module.exports = { isUuid, getOwned, getOwnedLocation };
