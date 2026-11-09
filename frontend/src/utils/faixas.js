// Desconto por quantidade (pack/atacado) no lado do cliente: so a PREVIA do preco. O servidor recalcula e e a verdade
// (services/precos.js): faixa automatica de maior quantidade atingida, somando o MESMO produto dentro de UM documento
// (venda, pedido ou rodada), e todas as unidades pagam o preco da faixa.

export function faixaAutomatica(faixas, quantidade) {
  let melhor = null;
  for (const f of faixas || []) {
    if (f.automatica && quantidade >= f.quantidade_minima && (!melhor || f.quantidade_minima > melhor.quantidade_minima)) melhor = f;
  }
  return melhor;
}

export function totaisPorProduto(itens, chave = 'product_id') {
  const t = {};
  for (const i of itens) t[i[chave]] = (t[i[chave]] || 0) + Number(i.quantidade);
  return t;
}

const somaComplementos = (lista) => Number((lista || []).reduce((s, c) => s + Number(c.preco || 0) * Number(c.quantidade || 1), 0).toFixed(2));

// item: { preco (preco da loja + complementos), faixas, complementos }. Devolve { unit, tabela, faixa }.
export function precoComFaixa(item, totais, chave = 'product_id') {
  const faixa = item.faixas && item.faixas.length ? faixaAutomatica(item.faixas, totais[item[chave]] || 0) : null;
  if (!faixa) return { unit: Number(item.preco), tabela: Number(item.preco), faixa: null };
  return { unit: Number((Number(faixa.preco_unitario) + somaComplementos(item.complementos)).toFixed(2)), tabela: Number(item.preco), faixa };
}
