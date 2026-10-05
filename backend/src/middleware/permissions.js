// Permissoes: cada perfil tem um padrao (MATRIX) e cada usuario pode ter ajustes
// individuais (users.permissoes) que liberam ou bloqueiam permissoes especificas.
const MATRIX = {
  'Administrador':        { Vendas: true,  Estoque: true,  Financeiro: true,  Relatorios: true,  Configuracoes: true,  CancelarVendas: true },
  'Gerente':              { Vendas: true,  Estoque: true,  Financeiro: false, Relatorios: true,  Configuracoes: false, CancelarVendas: true },
  'Caixa/Operador':       { Vendas: true,  Estoque: false, Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false },
  'Estoque':              { Vendas: false, Estoque: true,  Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false },
  'Lanchonete/Cozinha':   { Vendas: true,  Estoque: true,  Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false },
  'Financeiro':           { Vendas: false, Estoque: false, Financeiro: true,  Relatorios: true,  Configuracoes: false, CancelarVendas: false },
};

// Permissoes que podem ser ajustadas por usuario (Financeiro ainda nao tem tela).
const PERMISSOES = {
  Vendas: 'PDV: vender, sangria/suprimento e fechar caixa',
  Estoque: 'Produtos, fornecedores, insumos, entradas e transferências',
  Relatorios: 'Relatórios e histórico de vendas',
  Configuracoes: 'Usuários, lojas e PDVs',
  CancelarVendas: 'Cancelar vendas (estorna estoque e caixa)',
};

// Padrao do perfil + ajustes do usuario.
function areasEfetivas(perfil, overrides) {
  const base = { ...(MATRIX[perfil] || {}) };
  for (const [chave, valor] of Object.entries(overrides || {})) {
    if (chave in base && typeof valor === 'boolean') base[chave] = valor;
  }
  return base;
}

// Valida os ajustes recebidos e guarda so o que difere do padrao do perfil.
function normalizarOverrides(perfil, entrada) {
  if (entrada === undefined) return undefined;
  if (entrada === null) return null;
  if (typeof entrada !== 'object' || Array.isArray(entrada)) return false;
  const padrao = MATRIX[perfil] || {};
  const resultado = {};
  for (const [chave, valor] of Object.entries(entrada)) {
    if (!(chave in PERMISSOES) || typeof valor !== 'boolean') return false;
    if (padrao[chave] !== valor) resultado[chave] = valor;
  }
  return Object.keys(resultado).length > 0 ? resultado : null;
}

function requireArea(area) {
  return (req, res, next) => {
    const permitido = req.user && req.user.areas && req.user.areas[area];
    if (!permitido) {
      return res.status(403).json({ erro: `Seu usuário não tem acesso à área ${area}` });
    }
    next();
  };
}

module.exports = { requireArea, MATRIX, PERMISSOES, areasEfetivas, normalizarOverrides };
