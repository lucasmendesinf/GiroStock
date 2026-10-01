const { HttpError } = require('./http');

// Usuario com local de atuacao definido so opera naquele local.
// Administrador sempre tem acesso a todos os locais.
function restrictedLocation(user) {
  if (!user || user.perfil === 'Administrador') return null;
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

// Perfis que podem cancelar vendas (estorno de estoque e de caixa).
function canCancelSales(user) {
  return user && (user.perfil === 'Administrador' || user.perfil === 'Gerente');
}

module.exports = { restrictedLocation, canAccessLocation, assertLocationAccess, canCancelSales };
