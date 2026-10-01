// Permissoes vem do backend em user.permissoes (nivel de acesso + permissoes extras).
// '*' = Administrador (tudo). Mesmo catalogo de backend/src/middleware/permissions.js.

export function pode(user, ...chaves) {
  if (!user || !Array.isArray(user.permissoes)) return false;
  if (user.permissoes.includes('*')) return true;
  return chaves.some((c) => user.permissoes.includes(c));
}

export const TELAS = [
  { path: '/inicio', label: 'Início', permissoes: null },
  { path: '/pdv', label: 'PDV', permissoes: ['vendas.pdv'] },
  { path: '/produtos', label: 'Produtos & Estoque', permissoes: ['estoque.ver'] },
  { path: '/fornecedores', label: 'Fornecedores', permissoes: ['estoque.ver'] },
  { path: '/lojas', label: 'Lojas & PDVs', permissoes: ['lojas.gerenciar'] },
  { path: '/usuarios', label: 'Usuários', permissoes: ['usuarios.gerenciar'] },
  { path: '/relatorios', label: 'Relatórios', permissoes: ['relatorios.ver'] },
];

export function podeAcessar(user, permissoes) {
  if (!user) return false;
  if (!permissoes || permissoes.length === 0) return true;
  return pode(user, ...permissoes);
}

export function telasDoUsuario(user) {
  const telas = TELAS.filter((t) => podeAcessar(user, t.permissoes));
  // Quem so vende nao precisa da tela Inicio: o menu fica so com o PDV.
  const outras = telas.filter((t) => t.path !== '/inicio');
  if (outras.length === 1 && outras[0].path === '/pdv') return outras;
  return telas;
}

// Tela inicial apos o login: quem so vende vai direto ao PDV; os demais ao Inicio.
export function rotaInicial(user) {
  if (!user) return '/login';
  const telas = telasDoUsuario(user).filter((t) => t.path !== '/inicio');
  if (telas.length === 1 && telas[0].path === '/pdv') return '/pdv';
  return '/inicio';
}
