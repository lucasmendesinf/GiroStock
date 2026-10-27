// O perfil Garcom so usa o app de comandas (/api/garcom) e a busca de produtos do cardapio (sem custo, so preco de venda).
// Todo o resto da API (cadastros, lojas, terminais, clientes...) fica fechado para ele, mesmo as rotas que nao exigem uma area.
function soGarcom(req, res, next) {
  if (!req.user || req.user.perfil !== 'Garçom') return next();
  const caminho = req.path;
  if (caminho === '/garcom' || caminho.startsWith('/garcom/')) return next();
  if (req.method === 'GET' && caminho === '/products/search') return next();
  return res.status(403).json({ erro: 'O perfil Garçom só acessa o app de comandas' });
}

module.exports = { soGarcom };
