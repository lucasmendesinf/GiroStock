// Preco sugerido do combo (regra unica, em CENTAVOS inteiros; nada de ponto flutuante solto no dinheiro).
//   preco = custo / (1 - margem)  (margem sobre o preco de venda). Com ",90": o menor valor terminado em ,90 que seja >= ao bruto.

export const aCentavos = (reais) => Math.round(Number(reais || 0) * 100 + (Number(reais) < 0 ? -1e-9 : 1e-9));

// margemPct com ate 2 casas (30 ou 32,5). Devolve centavos ou null (sem custo, ou margem fora de 0 a < 95).
export function precoSugeridoCent(custoCent, margemPct, final90 = true) {
  const m100 = Math.round(Number(margemPct) * 100); // centesimos de ponto percentual, inteiro
  if (!(custoCent > 0) || !Number.isFinite(m100) || m100 < 0 || m100 >= 9500) return null;
  const num = custoCent * 10000;
  const den = 10000 - m100;
  if (!final90) return Math.floor((2 * num + den) / (2 * den)); // arredonda para centavos, meio para cima
  const c = Math.floor((num + den - 1) / den); // teto do bruto, em centavos
  let v = c - (c % 100) + 90;
  if (v < c) v += 100;
  return v;
}

// Indicadores de um preco (centavos) frente ao custo total e a soma dos precos avulsos.
export function indicadoresCombo({ custoCent, precoCent, avulsoCent }) {
  const lucro = precoCent - custoCent;
  return {
    lucroCent: lucro,
    margemPct: precoCent > 0 ? (lucro / precoCent) * 100 : null,
    markupPct: custoCent > 0 ? (lucro / custoCent) * 100 : null,
    descontoPct: avulsoCent > 0 ? ((avulsoCent - precoCent) / avulsoCent) * 100 : null,
  };
}

// Cor da margem: verde se >= desejada (tolerancia de 0,05 p.p. pelo arredondamento em centavos), laranja abaixo, vermelha < 15% ou preco <= custo.
export function nivelDaMargem(margemReal, desejada, precoCent, custoCent) {
  if (margemReal === null || !(precoCent > custoCent) || margemReal < 15) return 'ruim';
  return margemReal + 0.05 >= desejada ? 'ok' : 'atencao';
}

// Custo (e preco avulso) do combo por produto. Quantidade fracionada aceita; cada linha arredonda em centavos.
export function linhasDoCombo(itens, produtos) {
  return itens.map((i) => {
    const p = produtos.find((x) => x.id === i.product_id) || {};
    const q = Number(i.quantidade || 0);
    const custoUn = aCentavos(p.preco_custo);
    const vendaUn = aCentavos(p.preco_venda);
    const custoCent = Math.round(custoUn * q);
    const avulsoCent = Math.round(vendaUn * q);
    return { product_id: i.product_id, produto: p, quantidade: q, custoUn, vendaUn, custoCent, avulsoCent, margemAvulsa: vendaUn > 0 ? ((vendaUn - custoUn) / vendaUn) * 100 : null };
  });
}
