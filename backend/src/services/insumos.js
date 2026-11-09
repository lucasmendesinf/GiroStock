// Rotinas de insumo compartilhadas (entrada de insumo, transferencia com conversao de produto em insumo).

async function ensureIngredientBalance(client, tenantId, ingredientId, locationId) {
  await client.query(
    `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (ingredient_id, location_id) DO NOTHING`,
    [ingredientId, locationId, tenantId]
  );
}

// Mantem o custo dos produtos com ficha tecnica = soma (qtd por unidade x custo unitario do insumo).
// So atualiza quando o custo novo e maior que zero e menor que o preco de venda (respeita as restricoes da tabela).
async function recalcularCustoProdutos(client, tenantId, ingredientId) {
  const { rows } = await client.query(
    `UPDATE products p SET preco_custo = c.custo
     FROM (SELECT pi.product_id, ROUND(SUM(pi.quantidade_por_unidade * i.custo_unitario), 2) AS custo
           FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
           WHERE pi.tenant_id = $1 AND pi.product_id IN (SELECT product_id FROM product_ingredients WHERE ingredient_id = $2 AND tenant_id = $1)
           GROUP BY pi.product_id) c
     WHERE p.id = c.product_id AND p.tenant_id = $1 AND c.custo > 0
     RETURNING p.nome, p.preco_custo, p.preco_venda`,
    [tenantId, ingredientId]
  );
  // Produtos que ficaram com custo igual/acima do preco de venda: a tela mostra um aviso.
  return rows.filter((r) => Number(r.preco_custo) >= Number(r.preco_venda))
    .map((r) => ({ nome: r.nome, preco_custo: Number(r.preco_custo), preco_venda: Number(r.preco_venda) }));
}

module.exports = { ensureIngredientBalance, recalcularCustoProdutos };
