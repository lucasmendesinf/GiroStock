// Reserva de estoque por pedidos em aberto (status diferente de finalizado/cancelado), por loja.
// O consumo de cada item segue a mesma regra da venda (services/consumo.js): produto simples, ficha tecnica,
// combo e complementos escolhidos. disponivel = saldo - reservado. Nada e gravado nos saldos: a reserva e sempre
// calculada, entao cancelar libera sozinho.
// ignorarPedidos: id de um pedido (ou lista de ids) cuja reserva NAO conta (o que esta virando venda).
async function reservadosDaLoja(db, tenantId, locationId, ignorarPedidos = null) {
  const ignorar = ignorarPedidos ? [].concat(ignorarPedidos) : [];
  // require tardio: consumo.js nao depende deste arquivo, mas evita ciclo se um dia depender.
  const { carregarComposicao, consumoDasLinhas, idsDeComplementos } = require('../services/consumo');
  const { rows } = await db.query(
    `SELECT oi.product_id, oi.quantidade, oi.complementos
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.tenant_id = $1 AND o.location_id = $2 AND o.status NOT IN ('finalizado', 'cancelado')
       AND o.id <> ALL($3::uuid[])`,
    [tenantId, locationId, ignorar]
  );
  if (rows.length === 0) return { produtos: new Map(), insumos: new Map() };
  const linhas = rows.map((r) => ({ product_id: r.product_id, quantidade: Number(r.quantidade), complementos: Array.isArray(r.complementos) ? r.complementos : [] }));
  const comp = await carregarComposicao(db, tenantId, [...new Set(linhas.map((l) => l.product_id))], idsDeComplementos(linhas));
  return consumoDasLinhas(comp, linhas);
}

module.exports = { reservadosDaLoja };
