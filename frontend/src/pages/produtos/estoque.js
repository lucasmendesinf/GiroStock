// Situacao de estoque dos produtos (lista de produtos e modal de estoque).

// Quantas unidades de um produto composto (lanche/receita) ainda dá para vender:
// o menor "disponivel do insumo / qtd por unidade" entre os insumos da receita.
export function darPara(ficha, insumosPorId) {
  if (!ficha || ficha.length === 0) return 0;
  let menor = Infinity;
  for (const item of ficha) {
    const insumo = insumosPorId.get(item.ingredient_id);
    const disponivel = insumo ? Number(insumo.saldo_total) : 0;
    const q = Number(item.quantidade_por_unidade);
    menor = Math.min(menor, q > 0 ? Math.floor(disponivel / q) : 0);
  }
  return Number.isFinite(menor) ? menor : 0;
}

export function totalDoProduto(p) {
  return Number(p.saldo_total) || 0;
}

export function saldoNaLoja(p, locationId) {
  const s = (p.saldos_por_local || []).find((x) => x.location_id === locationId);
  return s ? Number(s.saldo) : 0;
}

export function minimoNaLoja(p, locationId) {
  const s = (p.saldos_por_local || []).find((x) => x.location_id === locationId);
  return s ? Number(s.estoque_minimo) : 0;
}

// { cls: 'ok' | 'warn' | 'err', txt, dara }  (dara = so para produto composto)
export function situacaoProduto(p, insumosPorId) {
  if (p.tem_ficha_tecnica) {
    const dara = darPara(p.ficha, insumosPorId);
    if (dara === 0) return { cls: 'err', txt: 'falta insumo', dara };
    return { cls: dara <= 5 ? 'warn' : 'ok', txt: `dá para ${dara}`, dara };
  }
  if (totalDoProduto(p) === 0) return { cls: 'err', txt: 'sem estoque' };
  if ((p.saldos_por_local || []).some((s) => s.abaixo_minimo)) return { cls: 'warn', txt: 'baixo' };
  return { cls: 'ok', txt: 'ok' };
}

// Situacao de uma loja especifica (aba "Saldo por loja" do modal de estoque).
export function situacaoNaLoja(p, locationId) {
  const s = (p.saldos_por_local || []).find((x) => x.location_id === locationId);
  const saldo = s ? Number(s.saldo) : 0;
  if (saldo === 0) return { cls: 'err', txt: 'sem estoque' };
  if (s && s.abaixo_minimo) return { cls: 'warn', txt: 'abaixo do mínimo' };
  return { cls: 'ok', txt: 'ok' };
}
