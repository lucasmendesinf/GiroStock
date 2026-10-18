// Areas do sistema por tela. O backend envia em user.areas o que o perfil acessa
// (mesma matriz de backend/src/middleware/permissions.js).
export const TELAS = [
  { path: '/master', label: 'Master', area: 'Master' },
  { path: '/inicio', label: 'Início', area: null, paraPerfis: ['Administrador', 'Gerente', 'Financeiro', 'Estoque', 'Lanchonete/Cozinha'] },
  { path: '/pdv', label: 'PDV', area: 'Vendas' },
  { path: '/pedidos', label: 'Pedidos', area: 'Pedidos', requer: 'usaPedidos' },
  { path: '/clientes', label: 'Clientes', area: 'Clientes' },
  { path: '/produtos', label: 'Produtos & Estoque', area: 'Estoque' },
  { path: '/fornecedores', label: 'Fornecedores', area: 'Estoque' },
  { path: '/lojas', label: 'Lojas & PDVs', area: 'Configuracoes' },
  { path: '/usuarios', label: 'Usuários', area: 'Configuracoes' },
  { path: '/relatorios', label: 'Relatórios', area: 'Relatorios' },
  { path: '/financeiro', label: 'Financeiro', area: 'Financeiro' },
  { path: '/loja-virtual', label: 'Loja virtual', area: 'LojaVirtual' },
];

// Modulo contratado pela empresa (PDV, Lanchonete, Pedidos...). Sessao antiga sem `modulos` = tudo liberado (o servidor confere de novo).
export function temModulo(user, chave) {
  return !!user && (!user.modulos || user.modulos[chave] !== false);
}

export function podeAcessar(user, area) {
  if (!user) return false;
  if (!area) return true;
  return !!(user.areas && user.areas[area]);
}

export function telasDoUsuario(user) {
  return TELAS.filter((t) => podeAcessar(user, t.area) && (!t.requer || user[t.requer]) && (!t.paraPerfis || t.paraPerfis.includes(user.perfil)));
}

// Tela inicial apos o login: caixa vai direto ao PDV, estoque aos produtos, etc.
export function rotaInicial(user) {
  if (!user) return '/login';
  if (user.perfil === 'Caixa/Operador' && podeAcessar(user, 'Vendas')) return '/pdv';
  const telas = telasDoUsuario(user);
  return telas.length > 0 ? telas[0].path : '/inicio';
}
