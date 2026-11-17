// Metodo de custo PEPS (primeiro que entra, primeiro que sai): lotes por produto e por loja.
// So e usado quando tenants.metodo_custo = 'peps'; no custo medio nada disto roda (o comportamento antigo segue igual).
// Toda baixa consome o lote mais antigo da LOJA e devolve o custo real do que saiu (base do CMV). Se faltar lote (saldo antigo, correcao
// manual), o que sobrar da baixa e custeado pelo custo atual do produto: a baixa nunca falha por causa dos lotes.
const n3 = (v) => Number(Number(v).toFixed(3));
const n4 = (v) => Number(Number(v).toFixed(4));

async function metodoDoTenant(db, tenantId) {
  const { rows } = await db.query(`SELECT metodo_custo FROM tenants WHERE id = $1`, [tenantId]);
  return rows[0] ? rows[0].metodo_custo : 'medio';
}
const usaPeps = async (db, tenantId) => (await metodoDoTenant(db, tenantId)) === 'peps';

// Nova entrada de estoque = novo lote (no fim da fila, ou na data informada).
async function entrar(client, { tenantId, productId, locationId, qtd, custo, data = null, origem = 'entrada', movimentoId = null }) {
  if (!(Number(qtd) > 0)) return null;
  const { rows } = await client.query(
    `INSERT INTO stock_lotes (tenant_id, product_id, location_id, entrada_em, quantidade_inicial, saldo, custo_unitario, origem, movimento_id)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $5, $6, $7, $8) RETURNING id`,
    [tenantId, productId, locationId, data, n3(qtd), n4(custo), origem, movimentoId]
  );
  return rows[0].id;
}

// Consome qtd dos lotes mais antigos da loja. Devolve { custoTotal, custoUnitario, consumidos: [{ saldo, custo, entrada_em, qtd }], semLote, referencia }
// referencia = qtd x custo ATUAL do produto (o que o custo medio/atual teria dado), para ajustar o custo do item vendido.
async function baixar(client, { tenantId, productId, locationId, qtd, custoFallback = null }) {
  let falta = n3(qtd);
  const consumidos = [];
  let custoTotal = 0;
  const { rows: lotes } = await client.query(
    `SELECT id, saldo, custo_unitario, entrada_em FROM stock_lotes
     WHERE tenant_id = $1 AND product_id = $2 AND location_id = $3 AND saldo > 0
     ORDER BY entrada_em, criado_em, id FOR UPDATE`,
    [tenantId, productId, locationId]
  );
  for (const l of lotes) {
    if (falta <= 0) break;
    const tira = Math.min(Number(l.saldo), falta);
    await client.query(`UPDATE stock_lotes SET saldo = saldo - $1 WHERE id = $2`, [tira, l.id]);
    consumidos.push({ lote_id: l.id, qtd: n3(tira), custo: Number(l.custo_unitario), entrada_em: l.entrada_em });
    custoTotal += tira * Number(l.custo_unitario);
    falta = n3(falta - tira);
  }
  const atual = Number((await client.query(`SELECT preco_custo FROM products WHERE id = $1 AND tenant_id = $2`, [productId, tenantId])).rows[0]?.preco_custo || 0);
  const semLote = falta > 0 ? falta : 0;
  if (semLote > 0) custoTotal += semLote * (custoFallback !== null && custoFallback !== undefined ? Number(custoFallback) : atual);
  return {
    custoTotal: Number(custoTotal.toFixed(4)), custoUnitario: qtd > 0 ? Number((custoTotal / qtd).toFixed(4)) : 0,
    consumidos, semLote, referencia: Number((qtd * atual).toFixed(4)),
  };
}

// Transferencia entre lojas: os lotes viajam com o custo e a data de entrada de origem (a fila do destino respeita a idade real).
async function transferir(client, { tenantId, productId, origemId, destinoId, qtd, movimentoId = null }) {
  const r = await baixar(client, { tenantId, productId, locationId: origemId, qtd });
  for (const c of r.consumidos) {
    await entrar(client, { tenantId, productId, locationId: destinoId, qtd: c.qtd, custo: c.custo, data: c.entrada_em, origem: 'transferencia', movimentoId });
  }
  if (r.semLote > 0) {
    const atual = r.referencia / qtd;
    await entrar(client, { tenantId, productId, locationId: destinoId, qtd: r.semLote, custo: atual, origem: 'transferencia', movimentoId });
  }
  return r;
}

// Estorno: a unidade devolvida volta para a posicao do lote de onde saiu (o mais antigo com o mesmo custo; sem ele, a data da venda).
async function dataDoLoteComCusto(client, tenantId, productId, locationId, custo, padrao = null) {
  const { rows } = await client.query(
    `SELECT MIN(entrada_em) AS d FROM stock_lotes WHERE tenant_id = $1 AND product_id = $2 AND location_id = $3 AND round(custo_unitario, 2) = round($4::numeric, 2)`,
    [tenantId, productId, locationId, custo]
  );
  return rows[0] && rows[0].d ? rows[0].d : padrao;
}

// Custo do ultimo lote (ajuste positivo de contagem entra por ele; sem lote, pelo custo atual do produto).
async function custoDoUltimoLote(client, tenantId, productId, locationId) {
  const { rows } = await client.query(
    `SELECT custo_unitario FROM stock_lotes WHERE tenant_id = $1 AND product_id = $2 AND location_id = $3 ORDER BY entrada_em DESC, criado_em DESC LIMIT 1`,
    [tenantId, productId, locationId]
  );
  if (rows[0]) return Number(rows[0].custo_unitario);
  return Number((await client.query(`SELECT preco_custo FROM products WHERE id = $1 AND tenant_id = $2`, [productId, tenantId])).rows[0]?.preco_custo || 0);
}

// Troca de metodo na empresa. Para PEPS, o estoque que ja existe vira UM lote por produto e loja ao custo atual (saldo inicial);
// para custo medio, os lotes saem (o custo atual do produto continua valendo). Vendas passadas nao mudam (o custo ja esta gravado nelas).
async function trocarMetodo(client, tenantId, metodo) {
  await client.query(`DELETE FROM stock_lotes WHERE tenant_id = $1`, [tenantId]);
  if (metodo === 'peps') {
    await client.query(
      `INSERT INTO stock_lotes (tenant_id, product_id, location_id, entrada_em, quantidade_inicial, saldo, custo_unitario, origem)
       SELECT sb.tenant_id, sb.product_id, sb.location_id, now(), sb.saldo, sb.saldo, p.preco_custo, 'saldo_inicial'
       FROM stock_balances sb JOIN products p ON p.id = sb.product_id WHERE sb.tenant_id = $1 AND sb.saldo > 0`,
      [tenantId]
    );
  }
  await client.query(`UPDATE tenants SET metodo_custo = $2 WHERE id = $1`, [tenantId, metodo]);
}

// Lotes abertos de um produto (consulta na tela de estoque / relatorio).
async function lotesAbertos(db, tenantId, productId, locationId = null) {
  const { rows } = await db.query(
    `SELECT l.id, l.location_id, lo.nome AS location_nome, l.entrada_em, l.quantidade_inicial, l.saldo, l.custo_unitario, l.origem
     FROM stock_lotes l JOIN locations lo ON lo.id = l.location_id
     WHERE l.tenant_id = $1 AND l.product_id = $2 AND l.saldo > 0 AND ($3::uuid IS NULL OR l.location_id = $3)
     ORDER BY l.entrada_em, l.criado_em`,
    [tenantId, productId, locationId]
  );
  return rows.map((r) => ({ ...r, quantidade_inicial: Number(r.quantidade_inicial), saldo: Number(r.saldo), custo_unitario: Number(r.custo_unitario) }));
}

module.exports = { dataDoLoteComCusto, metodoDoTenant, usaPeps, entrar, baixar, transferir, custoDoUltimoLote, trocarMetodo, lotesAbertos };
