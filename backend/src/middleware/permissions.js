const { POR_CHAVE } = require('../config/modulos');

// Permissoes: cada perfil tem um padrao (MATRIX) e cada usuario pode ter ajustes
// individuais (users.permissoes) que liberam ou bloqueiam permissoes especificas.
const MATRIX = {
  'Administrador':        { Vendas: true,  Estoque: true,  Financeiro: true,  Relatorios: true,  Configuracoes: true,  CancelarVendas: true,  SangriaSuprimento: true,  Desconto: true,  FecharCaixa: true,  Pedidos: true, Clientes: true, ModoTeste: false, Master: false },
  'Gerente':              { Vendas: true,  Estoque: true,  Financeiro: false, Relatorios: true,  Configuracoes: false, CancelarVendas: true,  SangriaSuprimento: true,  Desconto: true,  FecharCaixa: true,  Pedidos: true, Clientes: true, ModoTeste: false, Master: false },
  'Caixa/Operador':       { Vendas: true,  Estoque: false, Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false, SangriaSuprimento: false, Desconto: false, FecharCaixa: true,  Pedidos: true, Clientes: false, ModoTeste: false, Master: false },
  'Estoque':              { Vendas: false, Estoque: true,  Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false, SangriaSuprimento: false, Desconto: false, FecharCaixa: false, Pedidos: false, Clientes: false, ModoTeste: false, Master: false },
  'Lanchonete/Cozinha':   { Vendas: true,  Estoque: true,  Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false, SangriaSuprimento: false, Desconto: false, FecharCaixa: true,  Pedidos: true, Clientes: false, ModoTeste: false, Master: false },
  'Financeiro':           { Vendas: false, Estoque: false, Financeiro: true,  Relatorios: true,  Configuracoes: false, CancelarVendas: false, SangriaSuprimento: false, Desconto: false, FecharCaixa: false, Pedidos: false, Clientes: false, ModoTeste: false, Master: false },
  // Dono da plataforma: nenhuma area de empresa; so o painel Master e o modo teste.
  'Master':               { Vendas: false, Estoque: false, Financeiro: false, Relatorios: false, Configuracoes: false, CancelarVendas: false, SangriaSuprimento: false, Desconto: false, FecharCaixa: false, Pedidos: false, Clientes: false, ModoTeste: true,  Master: true },
};

// Permissoes que podem ser ajustadas por usuario. 'Master' nao entra aqui:
// o perfil Master so existe por script e nao pode ser concedido por ajuste individual.
const PERMISSOES = {
  Vendas: 'PDV: abrir o caixa e vender',
  SangriaSuprimento: 'PDV: fazer sangria e suprimento',
  Desconto: 'PDV: dar desconto na venda',
  FecharCaixa: 'PDV: fechar o caixa',
  Pedidos: 'Pedidos da lanchonete: gerar no PDV, acompanhar e finalizar',
  Clientes: 'Clientes: base de clientes, segmentos e mensagens',
  ModoTeste: 'Modo teste: trabalhar em um banco de teste separado da produção',
  Estoque: 'Produtos, fornecedores, insumos, entradas e transferências',
  Relatorios: 'Relatórios e histórico de vendas',
  Financeiro: 'Financeiro: contas a pagar e a receber, fluxo de caixa e resultado',
  Configuracoes: 'Usuários, lojas e PDVs',
  CancelarVendas: 'Cancelar vendas (estorna estoque e caixa)',
};

// Padrao do perfil + ajustes do usuario.
function areasEfetivas(perfil, overrides) {
  const base = { ...(MATRIX[perfil] || {}) };
  for (const [chave, valor] of Object.entries(overrides || {})) {
    if (chave !== 'Master' && chave in base && typeof valor === 'boolean') base[chave] = valor;
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
    // Chaves do padrao do perfil que nao sao ajustaveis (ex.: Financeiro) sao ignoradas.
    if (!(chave in PERMISSOES)) { if (chave in padrao && typeof valor === 'boolean') continue; return false; }
    if (typeof valor !== 'boolean') return false;
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

// Modulo contratado pela empresa (plano/liberacao do Master). Vale para todos os usuarios dela, inclusive o Administrador.
function requireModulo(chave) {
  return (req, res, next) => {
    if (!req.user || !req.user.modulos || !req.user.modulos[chave]) {
      const nome = POR_CHAVE[chave] ? POR_CHAVE[chave].nome : chave;
      return res.status(403).json({ erro: `O módulo ${nome} não faz parte do plano da sua empresa`, modulo: chave });
    }
    next();
  };
}

module.exports = { requireArea, requireModulo, MATRIX, PERMISSOES, areasEfetivas, normalizarOverrides };
