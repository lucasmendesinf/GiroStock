const { HttpError } = require('./http');
const { temPermissao, ehAdmin } = require('../middleware/permissions');

// Usuario com local de atuacao definido so opera naquele local.
// Quem tem o nivel Administrador sempre tem acesso a todos os locais.
function restrictedLocation(user) {
  if (!user || ehAdmin(user)) return null;
  return user.locationId || null;
}

function canAccessLocation(user, locationId) {
  const restrito = restrictedLocation(user);
  return !restrito || restrito === locationId;
}

function assertLocationAccess(user, locationId, acao = 'operar neste local') {
  if (!canAccessLocation(user, locationId)) {
    throw new HttpError(403, `seu usuário está vinculado a outro local e não pode ${acao}`);
  }
}

function canCancelSales(user) {
  return temPermissao(user, 'vendas.cancelar');
}

module.exports = { restrictedLocation, canAccessLocation, assertLocationAccess, canCancelSales };
