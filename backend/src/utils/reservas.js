// Reserva de estoque por pedidos em aberto (status diferente de finalizado/cancelado), por loja.
// Produto simples: soma das quantidades dos itens. Produto com receita: soma dos insumos (qtd por unidade x quantidade).
// disponivel = saldo - reservado. Nada e gravado nos saldos: a reserva e sempre calculada, entao cancelar libera sozinho.
async function reservadosDaLoja(db, tenantId, locationId, ignorarPedidoId = null) {
  const prod = await db.query(
    `SELECT oi.product_id, SUM(oi.quantidade) AS q
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.tenant_id = $1 AND o.location_id = $2 AND o.status NOT IN ('finalizado', 'cancelado')
       AND ($3::uuid IS NULL OR o.id <> $3::uuid)
       AND NOT EXISTS (SELECT 1 FROM product_ingredients pi WHERE pi.product_id = oi.product_id)
     GROUP BY oi.product_id`,
    [tenantId, locationId, ignorarPedidoId]
  );
  const ins = await db.query(
    `SELECT pi.ingredient_id, SUM(pi.quantidade_por_unidade * oi.quantidade) AS q
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     JOIN product_ingredients pi ON pi.product_id = oi.product_id
     WHERE o.tenant_id = $1 AND o.location_id = $2 AND o.status NOT IN ('finalizado', 'cancelado')
       AND ($3::uuid IS NULL OR o.id <> $3::uuid)
     GROUP BY pi.ingredient_id`,
    [tenantId, locationId, ignorarPedidoId]
  );
  return {
    produtos: new Map(prod.rows.map((r) => [r.product_id, Number(r.q)])),
    insumos: new Map(ins.rows.map((r) => [r.ingredient_id, Number(r.q)])),
  };
}

module.exports = { reservadosDaLoja };
