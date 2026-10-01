const express = require('express');
const pool = require('../db/pool');
const { requirePermission, temPermissao } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess, restrictedLocation } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { filtroPeriodo, paginacao } = require('../utils/query');

const router = express.Router();

async function ensureBalanceRow(client, tenantId, productId, locationId) {
  await client.query(
    `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (product_id, location_id) DO NOTHING`,
    [productId, locationId, tenantId]
  );
}

// Trava os saldos envolvidos sempre na mesma ordem (por location_id) para que
// transferencias simultaneas em sentidos opostos (A->B e B->A) nao gerem deadlock.
async function lockBalances(client, tenantId, productId, locationIds) {
  const { rows } = await client.query(
    `SELECT location_id, saldo FROM stock_balances
     WHERE product_id = $1 AND tenant_id = $2 AND location_id = ANY($3::uuid[])
     ORDER BY location_id
     FOR UPDATE`,
    [productId, tenantId, locationIds]
  );
  return new Map(rows.map((r) => [r.location_id, Number(r.saldo)]));
}

function textoOpcional(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
}

// Valida um movimento (fora da transacao) e devolve os dados normalizados.
// Usado pela movimentacao avulsa e pela entrada por nota (varios itens).
async function prepararMovimento(db, user, dados) {
  const { product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo } = dados || {};
  const qtd = Number(quantidade);

  if (!product_id || !tipo || !(qtd > 0) || !motivo) {
    throw new HttpError(400, 'product_id, tipo, quantidade (>0) e motivo são obrigatórios');
  }
  if (!['entrada', 'saida', 'transferencia'].includes(tipo)) throw new HttpError(400, 'tipo inválido');
  if (tipo === 'entrada' && !location_destino_id) throw new HttpError(400, 'location_destino_id é obrigatório para entrada');
  if (tipo === 'saida' && !location_origem_id) throw new HttpError(400, 'location_origem_id é obrigatório para saída');
  if (tipo === 'transferencia') {
    if (!location_origem_id || !location_destino_id) {
      throw new HttpError(400, 'location_origem_id e location_destino_id são obrigatórios para transferência');
    }
    if (location_origem_id === location_destino_id) {
      throw new HttpError(400, 'local de origem deve ser diferente do local de destino');
    }
  }
  const origemId = tipo === 'entrada' ? null : location_origem_id;
  const destinoId = tipo === 'saida' ? null : location_destino_id;

  // Produto e locais precisam ser da empresa do usuario (e os locais, ativos).
  const product = await getOwned(db, 'products', product_id, user.tenantId, {
    columns: 'id, nome, unidade, ativo, supplier_id, preco_custo, preco_venda',
  });
  if (tipo === 'entrada' && !product.ativo) throw new HttpError(400, `"${product.nome}" está inativo e não recebe entradas; reative-o antes`);
  if (!isQuantidadeValidaParaUnidade(qtd, product.unidade)) {
    throw new HttpError(400, `"${product.nome}" e controlado em ${product.unidade} e so aceita quantidade inteira`);
  }
  const ficha = await db.query(
    `SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`,
    [product_id, user.tenantId]
  );
  if (ficha.rows.length > 0) {
    throw new HttpError(400, `"${product.nome}" tem ficha técnica e não tem estoque próprio; movimente os insumos dele`);
  }
  if (origemId) await getOwnedLocation(db, origemId, user.tenantId);
  if (destinoId) await getOwnedLocation(db, destinoId, user.tenantId);

  // Usuario vinculado a um local so movimenta o proprio local
  // (na transferencia, ele envia a partir do local dele).
  if (tipo === 'entrada') assertLocationAccess(user, destinoId, 'lançar entrada neste local');
  else assertLocationAccess(user, origemId, 'movimentar estoque deste local');

  // Dados da compra (somente entrada): fornecedor, custo unitario e nota fiscal.
  let supplierId = null;
  let custoUnitario = null;
  let documentoFiscal = null;
  if (tipo === 'entrada') {
    if (dados.supplier_id) {
      await getOwned(db, 'suppliers', dados.supplier_id, user.tenantId, { ativo: true, columns: 'id, ativo' });
      supplierId = dados.supplier_id;
    }
    const custoInformado = dados.custo_unitario;
    if (custoInformado !== undefined && custoInformado !== null && custoInformado !== '') {
      custoUnitario = Number(custoInformado);
      if (!(custoUnitario > 0)) throw new HttpError(400, `custo unitário de "${product.nome}" deve ser maior que zero`);
    }
    documentoFiscal = textoOpcional(dados.documento_fiscal);
  }

  return { product, tipo, qtd, origemId, destinoId, motivo, supplierId, custoUnitario, documentoFiscal };
}

// Aplica um movimento ja validado dentro de uma transacao aberta.
async function aplicarMovimento(client, user, mov) {
  const { product, tipo, qtd, origemId, destinoId, motivo, supplierId, custoUnitario, documentoFiscal } = mov;
  const productId = product.id;

  // Ordem de travas igual a da venda (produto -> saldos), evitando deadlock entre as duas.
  const travado = await client.query(
    `SELECT p.preco_custo, p.preco_venda, p.supplier_id,
            (SELECT COALESCE(SUM(saldo), 0) FROM stock_balances WHERE product_id = p.id AND tenant_id = p.tenant_id) AS saldo_total
     FROM products p WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p`,
    [productId, user.tenantId]
  );
  const atual = travado.rows[0];

  if (destinoId) await ensureBalanceRow(client, user.tenantId, productId, destinoId);
  const saldos = await lockBalances(client, user.tenantId, productId, [origemId, destinoId].filter(Boolean));

  if (origemId) {
    const saldoOrigem = saldos.has(origemId) ? saldos.get(origemId) : 0;
    if (saldoOrigem < qtd) {
      throw new HttpError(400, `saldo insuficiente de "${product.nome}" no local de origem (disponível: ${saldoOrigem}, solicitado: ${qtd})`);
    }
  }

  let custoMedio = null;
  if (tipo === 'entrada' && custoUnitario !== null) {
    // Custo medio ponderado: (saldo atual x custo atual + entrada x custo da entrada) / saldo final.
    const saldoTotal = Math.max(0, Number(atual.saldo_total));
    const custoAtual = Number(atual.preco_custo);
    custoMedio = Number(((saldoTotal * custoAtual + qtd * custoUnitario) / (saldoTotal + qtd)).toFixed(2));
    const precoVenda = Number(atual.preco_venda);
    if (custoMedio >= precoVenda) {
      throw new HttpError(400,
        `com esta entrada o custo médio de "${product.nome}" ficaria R$ ${custoMedio.toFixed(2).replace('.', ',')}, maior ou igual ao preço de venda (R$ ${precoVenda.toFixed(2).replace('.', ',')}). Atualize o preço de venda do produto antes.`);
    }
    await client.query(`UPDATE products SET preco_custo = $1 WHERE id = $2 AND tenant_id = $3`, [custoMedio, productId, user.tenantId]);
  }

  if (origemId) {
    await client.query(
      `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, productId, origemId, user.tenantId]
    );
  }
  if (destinoId) {
    await client.query(
      `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, productId, destinoId, user.tenantId]
    );
  }

  // Comprar de um fornecedor ja o vincula ao produto.
  if (supplierId) {
    await client.query(
      `INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, supplier_id) DO NOTHING`,
      [user.tenantId, productId, supplierId]
    );
    if (!atual.supplier_id) {
      await client.query(`UPDATE products SET supplier_id = $1 WHERE id = $2 AND tenant_id = $3`, [supplierId, productId, user.tenantId]);
    }
  }

  const { rows } = await client.query(
    `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id,
                                  supplier_id, custo_unitario, documento_fiscal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, supplier_id, custo_unitario, documento_fiscal, criado_em`,
    [user.tenantId, productId, tipo, qtd, origemId, destinoId, motivo, user.id, supplierId, custoUnitario, documentoFiscal]
  );

  await logAudit(client, {
    tenantId: user.tenantId,
    usuarioId: user.id,
    acao: tipo,
    recurso: 'stock_movements',
    recursoId: rows[0].id,
    detalhes: {
      product_id: productId, quantidade: qtd, supplier_id: supplierId, custo_unitario: custoUnitario,
      documento_fiscal: documentoFiscal,
      ...(custoMedio !== null ? { preco_custo_anterior: Number(atual.preco_custo), preco_custo_novo: custoMedio } : {}),
    },
  });

  return { ...rows[0], preco_custo_atualizado: custoMedio };
}

router.post('/stock-movements', requirePermission('estoque.movimentar'), async (req, res) => {
  const mov = await prepararMovimento(pool, req.user, req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await aplicarMovimento(client, req.user, mov);
    await client.query('COMMIT');
    res.status(201).json(resultado);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Entrada por nota: varios produtos de uma compra lancados de uma vez (tudo ou nada).
// Corpo: { location_id, supplier_id?, documento_fiscal?, motivo?, itens: [{ product_id, quantidade, custo_unitario? }] }
router.post('/stock-entries', requirePermission('estoque.movimentar'), async (req, res) => {
  const { location_id, supplier_id, documento_fiscal, itens } = req.body || {};
  if (!location_id) throw new HttpError(400, 'location_id (local que recebe a mercadoria) é obrigatório');
  if (!Array.isArray(itens) || itens.length === 0) throw new HttpError(400, 'informe ao menos um item na nota');
  if (itens.length > 300) throw new HttpError(400, 'uma nota pode ter no máximo 300 itens');
  const doc = textoOpcional(documento_fiscal);
  const motivo = textoOpcional(req.body.motivo) || (doc ? `Entrada da nota ${doc}` : 'Entrada por nota');

  const preparados = [];
  for (const [i, item] of itens.entries()) {
    try {
      preparados.push(await prepararMovimento(pool, req.user, {
        tipo: 'entrada',
        product_id: item && item.product_id,
        quantidade: item && item.quantidade,
        custo_unitario: item && item.custo_unitario,
        location_destino_id: location_id,
        supplier_id,
        documento_fiscal: doc,
        motivo,
      }));
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, `item ${i + 1}: ${err.message}`);
      throw err;
    }
  }
  // Mesma ordem de travas das vendas (por produto), evitando deadlock.
  preparados.sort((a, b) => (a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movimentos = [];
    for (const mov of preparados) movimentos.push(await aplicarMovimento(client, req.user, mov));
    await client.query('COMMIT');
    const valorTotal = preparados.reduce((soma, m) => soma + (m.custoUnitario || 0) * m.qtd, 0);
    res.status(201).json({ itens: movimentos.length, valor_total: Number(valorTotal.toFixed(2)), movimentos });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Historico de movimentacoes com filtros e paginacao.
// Filtros: product_id, location_id, supplier_id, tipo, data_inicio, data_fim (AAAA-MM-DD), limit, offset.
router.get('/stock-movements', requirePermission('estoque.ver'), async (req, res) => {
  const { product_id, location_id, supplier_id, tipo } = req.query;
  const params = [req.user.tenantId];
  let where = 'sm.tenant_id = $1';
  if (product_id) {
    params.push(product_id);
    where += ` AND sm.product_id = $${params.length}`;
  }
  if (supplier_id) {
    params.push(supplier_id);
    where += ` AND sm.supplier_id = $${params.length}`;
  }
  if (tipo) {
    params.push(tipo);
    where += ` AND sm.tipo = $${params.length}`;
  }
  // Usuario vinculado a um local so ve as movimentacoes que tocam o local dele.
  const local = restrictedLocation(req.user) || location_id;
  if (local) {
    params.push(local);
    where += ` AND (sm.location_origem_id = $${params.length} OR sm.location_destino_id = $${params.length})`;
  }
  where += filtroPeriodo('sm.criado_em', req.query, params);
  const { limit, offset } = paginacao(req.query, 50, 500);

  const total = await pool.query(`SELECT COUNT(*)::int AS total FROM stock_movements sm WHERE ${where}`, params);
  const { rows } = await pool.query(
    `SELECT sm.id, sm.product_id, p.nome AS product_nome, p.unidade, sm.tipo, sm.quantidade,
            sm.location_origem_id, lo.nome AS location_origem_nome,
            sm.location_destino_id, ld.nome AS location_destino_nome,
            sm.motivo, sm.usuario_id, u.nome AS usuario_nome,
            sm.supplier_id, s.nome AS supplier_nome, sm.custo_unitario, sm.documento_fiscal,
            sm.sale_id, sa.numero AS sale_numero,
            sm.criado_em
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     LEFT JOIN users u ON u.id = sm.usuario_id
     LEFT JOIN suppliers s ON s.id = sm.supplier_id
     LEFT JOIN sales sa ON sa.id = sm.sale_id
     LEFT JOIN locations lo ON lo.id = sm.location_origem_id
     LEFT JOIN locations ld ON ld.id = sm.location_destino_id
     WHERE ${where} ORDER BY sm.criado_em DESC, sm.id
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: total.rows[0].total, limit, offset, itens: rows });
});

// Itens (produtos e insumos) com saldo no minimo ou abaixo dele, por local.
router.get('/stock/alerts', requirePermission('estoque.ver'), async (req, res) => {
  const params = [req.user.tenantId];
  let filtroProduto = '';
  let filtroInsumo = '';
  const local = restrictedLocation(req.user) || req.query.location_id;
  if (local) {
    params.push(local);
    filtroProduto = ` AND sb.location_id = $${params.length}`;
    filtroInsumo = ` AND ib.location_id = $${params.length}`;
  }
  const produtos = await pool.query(
    `SELECT 'produto' AS tipo, p.id, p.nome, p.unidade, l.id AS location_id, l.nome AS location_nome,
            sb.saldo, sb.estoque_minimo
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     JOIN locations l ON l.id = sb.location_id
     WHERE sb.tenant_id = $1 AND p.ativo AND l.ativo AND sb.estoque_minimo > 0 AND sb.saldo <= sb.estoque_minimo${filtroProduto}
     ORDER BY (sb.saldo / sb.estoque_minimo), p.nome`,
    params
  );
  const insumos = await pool.query(
    `SELECT 'insumo' AS tipo, i.id, i.nome, i.unidade, l.id AS location_id, l.nome AS location_nome,
            ib.saldo, ib.estoque_minimo
     FROM ingredient_balances ib
     JOIN ingredients i ON i.id = ib.ingredient_id
     JOIN locations l ON l.id = ib.location_id
     WHERE ib.tenant_id = $1 AND i.ativo AND l.ativo AND ib.estoque_minimo > 0 AND ib.saldo <= ib.estoque_minimo${filtroInsumo}
     ORDER BY (ib.saldo / ib.estoque_minimo), i.nome`,
    params
  );
  res.json([...produtos.rows, ...insumos.rows]);
});

module.exports = router;
