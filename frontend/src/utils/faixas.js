// Desconto por quantidade (pack/atacado) no lado do cliente: so a PREVIA do preco. O servidor recalcula e e a verdade
// (services/precos.js), somando o MESMO produto dentro de UM documento (venda, pedido ou rodada):
//  - atacado (faixa por unidade/%): a partir da quantidade, todas as unidades pagam o preco da faixa;
//  - pack (faixa "kit fechado"): cada pack fechado sai pelo valor do pack e o resto pelo preco normal (13 = 1 pack + 1 avulsa).
// Vale o menor total.

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

// Preco BASE por unidade (sem complementos) para a quantidade q: { unit, total, faixa, pack, packs, avulsas, rotulo }.
// faixas vindas do servidor: { id, quantidade_minima, preco_unitario, automatica, modo: 'pack'|'atacado', kit, rotulo }.
export function calcularPreco(faixas, q, base, manualId = null) {
  const lista = faixas || [];
  const ok = (f) => f.automatica || f.id === manualId;
  let melhor = { total: q * base, faixa: null, pack: false, packs: [], avulsas: q };
  let atac = null;
  for (const f of lista) if (f.modo !== 'pack' && ok(f) && q >= f.quantidade_minima && (!atac || Number(f.preco_unitario) < Number(atac.preco_unitario))) atac = f;
  if (atac && q * Number(atac.preco_unitario) < melhor.total) melhor = { total: q * Number(atac.preco_unitario), faixa: atac, pack: false, packs: [], avulsas: 0 };
  if (Number.isInteger(q)) {
    let resto = q; let total = 0; const packs = [];
    for (const k of lista.filter((f) => f.modo === 'pack' && ok(f)).sort((a, b) => b.quantidade_minima - a.quantidade_minima)) {
      const vezes = Math.floor(resto / k.quantidade_minima);
      if (vezes > 0) { packs.push({ faixa: k, vezes }); total += vezes * Number(k.kit); resto -= vezes * k.quantidade_minima; }
    }
    if (packs.length) {
      total += resto * base;
      if (total < melhor.total - 0.001) melhor = { total, faixa: packs[0].faixa, pack: true, packs, avulsas: resto };
    }
  }
  const rotulo = !melhor.faixa ? null : !melhor.pack ? (melhor.faixa.rotulo || `${melhor.faixa.quantidade_minima} un`)
    : [...melhor.packs.map((p) => `${p.faixa.rotulo || `Pack ${p.faixa.quantidade_minima}`}${p.vezes > 1 ? ` ×${p.vezes}` : ''}`), ...(melhor.avulsas ? [`${melhor.avulsas} avulsa${melhor.avulsas > 1 ? 's' : ''}`] : [])].join(' + ');
  return { ...melhor, total: Number(melhor.total.toFixed(2)), unit: q > 0 ? melhor.total / q : base, rotulo };
}

// item: { preco (preco da loja + complementos), faixas, complementos }. Devolve { unit, tabela, faixa, rotulo, pack }.
export function precoComFaixa(item, totais, chave = 'product_id') {
  const compl = somaComplementos(item.complementos);
  const q = totais[item[chave]] || 0;
  if (!item.faixas || !item.faixas.length) return { unit: Number(item.preco), tabela: Number(item.preco), faixa: null };
  const c = calcularPreco(item.faixas, q, Number(item.preco) - compl);
  if (!c.faixa) return { unit: Number(item.preco), tabela: Number(item.preco), faixa: null };
  return { unit: c.unit + compl, tabela: Number(item.preco), faixa: c.faixa, rotulo: c.rotulo, pack: c.pack };
}
