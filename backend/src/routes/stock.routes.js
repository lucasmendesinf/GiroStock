const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess, restrictedLocation } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');

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

router.post('/stock-movements', requireArea('Estoque'), async (req, res) => {
  const { product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo } = req.body || {};
  const qtd = Number(quantidade);

  if (!product_id || !tipo || !(qtd > 0) || !motivo) {
    return res.status(400).json({ erro: 'product_id, tipo, quantidade (>0) e motivo sao obrigatorios' });
  }
  if (!['entrada', 'saida', 'transferencia'].includes(tipo)) {
    return res.status(400).json({ erro: 'tipo invalido' });
  }
  if (tipo === 'entrada' && !location_destino_id) {
    return res.status(400).json({ erro: 'location_destino_id e obrigatorio para entrada' });
  }
  if (tipo === 'saida' && !location_origem_id) {
    return res.status(400).json({ erro: 'location_origem_id e obrigatorio para saida' });
  }
  if (tipo === 'transferencia') {
    if (!location_origem_id || !location_destino_id) {
      return res.status(400).json({ erro: 'location_origem_id e location_destino_id sao obrigatorios para transferencia' });
    }
    if (location_origem_id === location_destino_id) {
      return res.status(400).json({ erro: 'local de origem deve ser diferente do local de destino' });
    }
  }
  const origemId = tipo === 'entrada' ? null : location_origem_id;
  const destinoId = tipo === 'saida' ? null : location_destino_id;

  // Produto e locais precisam ser da empresa do usuario (e os locais, ativos).
  const product = await getOwned(pool, 'products', product_id, req.user.tenantId, {
    columns: 'id, nome, unidade, ativo, supplier_id, preco_custo, preco_venda',
  });
  if (tipo === 'entrada' && !product.ativo) throw new HttpError(400, 'produto inativo nao recebe entradas; reative-o antes');
  if (!isQuantidadeValidaParaUnidade(qtd, product.unidade)) {
    throw new HttpError(400, `produto em ${product.unidade} so aceita quantidade inteira`);
  }
  const ficha = await pool.query(
    `SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`,
    [product_id, req.user.tenantId]
  );
  if (ficha.rows.length > 0) {
    throw new HttpError(400, 'produto com ficha tecnica nao tem estoque proprio; movimente os insumos dele');
  }
  if (origemId) await getOwnedLocation(pool, origemId, req.user.tenantId);
  if (destinoId) await getOwnedLocation(pool, destinoId, req.user.tenantId);

  // Usuario vinculado a um local so movimenta o proprio local
  // (na transferencia, ele envia a partir do local dele).
  if (tipo === 'entrada') assertLocationAccess(req.user, destinoId, 'lancar entrada neste local');
  else assertLocationAccess(req.user, origemId, 'movimentar estoque deste local');

  // Dados da compra (somente entrada): fornecedor, custo unitario e nota fiscal.
  let supplierId = null;
  let custoUnitario = null;
  let documentoFiscal = null;
  if (tipo === 'entrada') {
    if (req.body.supplier_id) {
      await getOwned(pool, 'suppliers', req.body.supplier_id, req.user.tenantId, { ativo: true, columns: 'id, ativo' });
      supplierId = req.body.supplier_id;
    }
    const custoInformado = req.body.custo_unitario;
    if (custoInformado !== undefined && custoInformado !== null && custoInformado !== '') {
      custoUnitario = Number(custoInformado);
      if (!(custoUnitario > 0)) throw new HttpError(400, 'custo unitario deve ser maior que zero');
    }
    documentoFiscal = textoOpcional(req.body.documento_fiscal);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ordem de travas igual a da venda (produto -> saldos), evitando deadlock entre as duas.
    const travado = await client.query(
      `SELECT p.preco_custo, p.preco_venda,
              (SELECT COALESCE(SUM(saldo), 0) FROM stock_balances WHERE product_id = p.id AND tenant_id = p.tenant_id) AS saldo_total
       FROM products p WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p`,
      [product_id, req.user.tenantId]
    );

    if (destinoId) await ensureBalanceRow(client, req.user.tenantId, product_id, destinoId);
    const saldos = await lockBalances(client, req.user.tenantId, product_id, [origemId, destinoId].filter(Boolean));

    if (origemId) {
      const saldoOrigem = saldos.has(origemId) ? saldos.get(origemId) : 0;
      if (saldoOrigem < qtd) {
        throw new HttpError(400, `saldo insuficiente no local de origem (disponivel: ${saldoOrigem}, solicitado: ${qtd})`);
      }
    }

    let custoMedio = null;
    if (tipo === 'entrada' && custoUnitario !== null) {
      // Custo medio ponderado: (saldo atual x custo atual + entrada x custo da entrada) / saldo final.
      const atual = travado;
      const saldoTotal = Math.max(0, Number(atual.rows[0].saldo_total));
      const custoAtual = Number(atual.rows[0].preco_custo);
      custoMedio = Number(((saldoTotal * custoAtual + qtd * custoUnitario) / (saldoTotal + qtd)).toFixed(2));
      const precoVenda = Number(atual.rows[0].preco_venda);
      if (custoMedio >= precoVenda) {
        throw new HttpError(400,
          `com esta entrada o custo medio ficaria R$ ${custoMedio.toFixed(2)}, maior ou igual ao preco de venda (R$ ${precoVenda.toFixed(2)}). Atualize o preco de venda do produto antes.`);
      }
      await client.query(
        `UPDATE products SET preco_custo = $1 WHERE id = $2 AND tenant_id = $3`,
        [custoMedio, product_id, req.user.tenantId]
      );
    }

    if (origemId) {
      await client.query(
        `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [qtd, product_id, origemId, req.user.tenantId]
      );
    }
    if (destinoId) {
      await client.query(
        `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [qtd, product_id, destinoId, req.user.tenantId]
      );
    }

    // Comprar de um fornecedor ja o vincula ao produto.
    if (supplierId) {
      await client.query(
        `INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3)
         ON CONFLICT (product_id, supplier_id) DO NOTHING`,
        [req.user.tenantId, product_id, supplierId]
      );
      if (!product.supplier_id) {
        await client.query(`UPDATE products SET supplier_id = $1 WHERE id = $2 AND tenant_id = $3`, [supplierId, product_id, req.user.tenantId]);
      }
    }

    const { rows } = await client.query(
      `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id,
                                    supplier_id, custo_unitario, documento_fiscal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, tipo, quantidade, location_origem_id, location_destino_id, motivo, supplier_id, custo_unitario, documento_fiscal, criado_em`,
      [req.user.tenantId, product_id, tipo, qtd, origemId, destinoId, motivo, req.user.id, supplierId, custoUnitario, documentoFiscal]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: tipo,
      recurso: 'stock_movements',
      recursoId: rows[0].id,
      detalhes: {
        product_id, quantidade: qtd, supplier_id: supplierId, custo_unitario: custoUnitario,
        documento_fiscal: documentoFiscal,
        ...(custoMedio !== null ? { preco_custo_anterior: Number(product.preco_custo), preco_custo_novo: custoMedio } : {}),
      },
    });

    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], preco_custo_atualizado: custoMedio });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/stock-movements', requireArea('Estoque'), async (req, res) => {
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
  const { rows } = await pool.query(
    `SELECT sm.id, sm.product_id, p.nome AS product_nome, sm.tipo, sm.quantidade,
            sm.location_origem_id, lo.nome AS location_origem_nome,
            sm.location_destino_id, ld.nome AS location_destino_nome,
            sm.motivo, sm.usuario_id, u.nome AS usuario_nome,
            sm.supplier_id, s.nome AS supplier_nome, sm.custo_unitario, sm.documento_fiscal, sm.sale_id,
            sm.criado_em
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     LEFT JOIN users u ON u.id = sm.usuario_id
     LEFT JOIN suppliers s ON s.id = sm.supplier_id
     LEFT JOIN locations lo ON lo.id = sm.location_origem_id
     LEFT JOIN locations ld ON ld.id = sm.location_destino_id
     WHERE ${where} ORDER BY sm.criado_em DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// Itens (produtos e insumos) com saldo no minimo ou abaixo dele, por local.
router.get('/stock/alerts', requireArea('Estoque'), async (req, res) => {
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
