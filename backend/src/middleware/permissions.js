// Matriz de permissoes por perfil (Etapa 2 — enum fixo, sem tabela dinamica ainda)
const MATRIX = {
  'Administrador':        { Vendas: true,  Estoque: true,  Financeiro: true,  Relatorios: true,  Configuracoes: true },
  'Gerente':               { Vendas: true,  Estoque: true,  Financeiro: false, Relatorios: true,  Configuracoes: false },
  'Caixa/Operador':        { Vendas: true,  Estoque: false, Financeiro: false, Relatorios: false, Configuracoes: false },
  'Estoque':               { Vendas: false, Estoque: true,  Financeiro: false, Relatorios: false, Configuracoes: false },
  'Lanchonete/Cozinha':     { Vendas: false, Estoque: false, Financeiro: false, Relatorios: false, Configuracoes: false },
  'Financeiro':             { Vendas: false, Estoque: false, Financeiro: true,  Relatorios: true,  Configuracoes: false },
};

function requireArea(area) {
  return (req, res, next) => {
    const perfil = req.user && req.user.perfil;
    const permitido = MATRIX[perfil] && MATRIX[perfil][area];
    if (!permitido) {
      return res.status(403).json({ erro: `Perfil ${perfil} nao tem acesso a area ${area}` });
    }
    next();
  };
}

module.exports = { requireArea, MATRIX };
