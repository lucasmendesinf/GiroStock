const { HttpError } = require('./http');

// Usuario com local de atuacao definido so opera naquele local.
// Administrador sempre tem acesso a todos os locais.
// Lojas permitidas: a principal (users.location_id) + as adicionais (user_locations).
function restrictedLocations(user) {
  if (!user || user.perfil === 'Administrador') return null;
  const ids = (user.locationIds && user.locationIds.length ? user.locationIds : (user.locationId ? [user.locationId] : []));
  return ids.length ? ids : null;
}

// Lista de lojas para filtrar consultas (null = sem filtro). Se o usuario pediu uma loja
// especifica, vale so ela (desde que ele possa ver); senao, todas as que ele pode ver.
function filtroLocais(user, pedido) {
  const permitidas = restrictedLocations(user);
  if (!permitidas) return pedido ? [pedido] : null;
  if (pedido) return permitidas.includes(pedido) ? [pedido] : ['00000000-0000-0000-0000-000000000000'];
  return permitidas;
}

function canAccessLocation(user, locationId) {
  const restritas = restrictedLocations(user);
  return !restritas || restritas.includes(locationId);
}

function assertLocationAccess(user, locationId, acao = 'operar neste local') {
  if (!canAccessLocation(user, locationId)) {
    throw new HttpError(403, `seu usuário está vinculado a outro local e não pode ${acao}`);
  }
}

// Usuarios com a permissao CancelarVendas (padrao: Administrador e Gerente) (estorno de estoque e de caixa).
function canCancelSales(user) {
  return !!(user && user.areas && user.areas.CancelarVendas);
}

module.exports = { restrictedLocations, filtroLocais, canAccessLocation, assertLocationAccess, canCancelSales };
