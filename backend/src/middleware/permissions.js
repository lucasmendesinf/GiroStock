// Catalogo de permissoes. Os niveis de acesso (tabela access_levels) guardam listas
// destas chaves; '*' (nivel Administrador) concede todas.
const PERMISSOES = [
  { chave: 'vendas.pdv', grupo: 'Vendas', descricao: 'Usar o PDV: vender, abrir e fechar caixa, sangria e suprimento' },
  { chave: 'vendas.desconto', grupo: 'Vendas', descricao: 'Dar desconto nas vendas' },
  { chave: 'vendas.cancelar', grupo: 'Vendas', descricao: 'Cancelar vendas (estorna estoque e caixa)' },
  { chave: 'estoque.ver', grupo: 'Estoque', descricao: 'Ver produtos, estoque, fornecedores e insumos' },
  { chave: 'estoque.movimentar', grupo: 'Estoque', descricao: 'Lançar entradas, saídas, transferências, notas e balanço de insumos' },
  { chave: 'produtos.criar', grupo: 'Cadastros', descricao: 'Cadastrar produtos e categorias' },
  { chave: 'produtos.editar', grupo: 'Cadastros', descricao: 'Editar produtos e categorias: nome, descrição, preços, código de barras, fornecedores, ficha técnica, estoque mínimo, desativar' },
  { chave: 'fornecedores.criar', grupo: 'Cadastros', descricao: 'Cadastrar fornecedores' },
  { chave: 'fornecedores.editar', grupo: 'Cadastros', descricao: 'Editar fornecedores (nome, documento, contato, prazo) e desativar' },
  { chave: 'insumos.criar', grupo: 'Cadastros', descricao: 'Cadastrar insumos' },
  { chave: 'insumos.editar', grupo: 'Cadastros', descricao: 'Editar insumos (nome, unidade, custo, estoque mínimo) e desativar' },
  { chave: 'relatorios.ver', grupo: 'Gestão', descricao: 'Ver relatórios e fechamentos de caixa' },
  { chave: 'lojas.gerenciar', grupo: 'Gestão', descricao: 'Criar, renomear e desativar lojas e PDVs' },
  { chave: 'usuarios.gerenciar', grupo: 'Gestão', descricao: 'Cadastrar e editar usuários (só pode conceder permissões que ele mesmo tem)' },
];
const CHAVES = new Set(PERMISSOES.map((p) => p.chave));

function temPermissao(user, chave) {
  const lista = (user && user.permissoes) || [];
  return lista.includes('*') || lista.includes(chave);
}

function ehAdmin(user) {
  return !!(user && user.permissoes && user.permissoes.includes('*'));
}

// Exige ao menos uma das permissoes informadas.
function requirePermission(...chaves) {
  return (req, res, next) => {
    if (chaves.some((c) => temPermissao(req.user, c))) return next();
    const nomes = chaves.map((c) => (PERMISSOES.find((p) => p.chave === c) || { descricao: c }).descricao.toLowerCase());
    return res.status(403).json({ erro: `seu nível de acesso (${req.user && req.user.nivel}) não permite: ${nomes.join(' / ')}` });
  };
}

// Normaliza e valida uma lista de permissoes vinda do cliente.
function validarPermissoes(lista) {
  if (!Array.isArray(lista)) return { ok: false, erro: 'permissoes deve ser uma lista' };
  const unicas = [...new Set(lista.map(String))];
  const invalidas = unicas.filter((c) => !CHAVES.has(c));
  if (invalidas.length) return { ok: false, erro: `permissão desconhecida: ${invalidas.join(', ')}` };
  return { ok: true, permissoes: unicas };
}

module.exports = { PERMISSOES, temPermissao, ehAdmin, requirePermission, validarPermissoes };
