const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { isValidBarcode } = require('../utils/validators');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const UNIDADES = ['UN', 'KG', 'L', 'CX'];

router.get('/categories', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, parent_id FROM categories WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/categories', requireArea('Estoque'), async (req, res) => {
  const { nome, parent_id } = req.body || {};
  if (!nome) return res.status(400).json({ erro: 'nome e obrigatorio' });
  if (parent_id) {
    const parent = await pool.query(
      `SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`,
      [parent_id, req.user.tenantId]
    );
    if (parent.rows.length === 0) return res.status(400).json({ erro: 'categoria pai nao encontrada' });
  }
  const { rows } = await pool.query(
    `INSERT INTO categories (tenant_id, nome, parent_id) VALUES ($1, $2, $3) RETURNING id, nome, parent_id`,
    [req.user.tenantId, nome, parent_id || null]
  );
  res.status(201).json(rows[0]);
});

router.get('/products', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.categoria_id, c.nome AS categoria_nome,
            p.supplier_id, s.nome AS supplier_nome, p.barcode,
            p.unidade, p.preco_custo, p.preco_venda, p.ativo,
            COALESCE(SUM(sb.saldo), 0) AS saldo_total,
            COALESCE(
              json_agg(
                json_build_object('location_id', l.id, 'location_nome', l.nome, 'saldo', sb.saldo)
              ) FILTER (WHERE l.id IS NOT NULL),
              '[]'
            ) AS saldos_por_local,
            EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id) AS tem_ficha_tecnica,
            (SELECT COUNT(*)::int FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id) AS insumo_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.categoria_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.tenant_id = p.tenant_id
     LEFT JOIN locations l ON l.id = sb.location_id
     WHERE p.tenant_id = $1
     GROUP BY p.id, c.nome, s.nome
     ORDER BY p.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.get('/products/search', async (req, res) => {
  const { q, barcode } = req.query;
  if (barcode) {
    const { rows } = await pool.query(
      `SELECT id, nome, barcode, preco_venda, unidade FROM products
       WHERE tenant_id = $1 AND barcode = $2 AND ativo = true`,
      [req.user.tenantId, barcode]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query(
    `SELECT id, nome, barcode, preco_venda, unidade FROM products
     WHERE tenant_id = $1 AND ativo = true AND nome ILIKE $2
     ORDER BY nome LIMIT 30`,
    [req.user.tenantId, `%${q || ''}%`]
  );
  res.json(rows);
});

router.get('/products/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade,
            preco_custo, preco_venda, ativo
     FROM products WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'produto nao encontrado' });

  const saldos = await pool.query(
    `SELECT sb.location_id, l.nome AS location_nome, sb.saldo
     FROM stock_balances sb JOIN locations l ON l.id = sb.location_id
     WHERE sb.product_id = $1 AND sb.tenant_id = $2
     ORDER BY l.nome`,
    [req.params.id, req.user.tenantId]
  );

  const ficha = await pool.query(
    `SELECT pi.id, pi.ingredient_id, i.nome AS ingredient_nome, i.unidade, pi.quantidade_por_unidade,
            i.custo_unitario, (i.custo_unitario * pi.quantidade_por_unidade) AS custo_fracionado
     FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
     WHERE pi.product_id = $1 AND pi.tenant_id = $2
     ORDER BY i.nome`,
    [req.params.id, req.user.tenantId]
  );

  res.json({ ...rows[0], saldos_por_local: saldos.rows, ficha_tecnica: ficha.rows });
});

router.post('/products', requireArea('Estoque'), async (req, res) => {
  const { nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, location_id, estoque_inicial, ficha_tecnica } = req.body || {};

  if (!nome || nome.length < 3) {
    return res.status(400).json({ erro: 'nome deve ter no minimo 3 caracteres' });
  }
  if (!categoria_id) return res.status(400).json({ erro: 'categoria e obrigatoria' });
  if (!barcode || !isValidBarcode(barcode)) {
    return res.status(400).json({ erro: 'codigo de barras deve ter 8 a 14 digitos numericos' });
  }
  if (!UNIDADES.includes(unidade)) {
    return res.status(400).json({ erro: 'unidade invalida' });
  }
  const custo = Number(preco_custo);
  const venda = Number(preco_venda);
  if (!(custo > 0)) return res.status(400).json({ erro: 'preco de custo deve ser maior que zero' });
  if (!(venda > 0)) return res.status(400).json({ erro: 'preco de venda deve ser maior que zero' });
  if (!(venda > custo)) return res.status(400).json({ erro: 'preco de venda deve ser maior que o custo' });

  const fichaItems = Array.isArray(ficha_tecnica) ? ficha_tecnica : [];
  for (const item of fichaItems) {
    if (!item.ingredient_id || !(Number(item.quantidade_por_unidade) > 0)) {
      return res.status(400).json({ erro: 'cada insumo da ficha tecnica precisa de ingredient_id e quantidade_por_unidade (>0)' });
    }
  }

  // Produtos com ficha tecnica (lanches) nao tem estoque proprio: a disponibilidade
  // e controlada pelos insumos da receita, entao local/estoque inicial nao se aplicam.
  const temFicha = fichaItems.length > 0;
  if (!temFicha && !location_id) {
    return res.status(400).json({ erro: 'local de estoque inicial e obrigatorio' });
  }
  const saldoInicial = Number(estoque_inicial ?? 0);
  if (!temFicha && saldoInicial < 0) {
    return res.status(400).json({ erro: 'estoque inicial nao pode ser negativo' });
  }

  const existingBarcode = await pool.query(
    `SELECT 1 FROM products WHERE tenant_id = $1 AND barcode = $2`,
    [req.user.tenantId, barcode]
  );
  if (existingBarcode.rows.length > 0) {
    return res.status(409).json({ erro: 'ja existe produto com este codigo de barras' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seq = await client.query(
      `SELECT COUNT(*)::int AS total FROM products WHERE tenant_id = $1`,
      [req.user.tenantId]
    );
    const codigoInterno = `PRD-${String(seq.rows[0].total + 1).padStart(4, '0')}`;

    const { rows } = await client.query(
      `INSERT INTO products (tenant_id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, ativo`,
      [req.user.tenantId, codigoInterno, nome, categoria_id, supplier_id || null, barcode, unidade, custo, venda]
    );
    const product = rows[0];

    if (!temFicha) {
      await client.query(
        `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)`,
        [product.id, location_id, req.user.tenantId, saldoInicial]
      );

      if (saldoInicial > 0) {
        await client.query(
          `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id)
           VALUES ($1, $2, 'entrada', $3, NULL, $4, 'Estoque inicial no cadastro do produto', $5)`,
          [req.user.tenantId, product.id, saldoInicial, location_id, req.user.id]
        );
      }
    }

    let ficha = [];
    if (fichaItems.length > 0) {
      const ingredientIds = fichaItems.map((i) => i.ingredient_id);
      const validIngredients = await client.query(
        `SELECT id FROM ingredients WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [ingredientIds, req.user.tenantId]
      );
      if (validIngredients.rows.length !== new Set(ingredientIds).size) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'um ou mais insumos da ficha tecnica nao foram encontrados' });
      }
      for (const item of fichaItems) {
        const inserted = await client.query(
          `INSERT INTO product_ingredients (tenant_id, product_id, ingredient_id, quantidade_por_unidade)
           VALUES ($1, $2, $3, $4)
           RETURNING id, ingredient_id, quantidade_por_unidade`,
          [req.user.tenantId, product.id, item.ingredient_id, Number(item.quantidade_por_unidade)]
        );
        ficha.push(inserted.rows[0]);
      }
    }

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'criar',
      recurso: 'products',
      recursoId: product.id,
      detalhes: { preco_custo: custo, preco_venda: venda },
    });

    await client.query('COMMIT');
    res.status(201).json({ ...product, ficha_tecnica: ficha });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Ficha tecnica
router.post('/products/:id/ingredients', requireArea('Estoque'), async (req, res) => {
  const { ingredient_id, quantidade_por_unidade } = req.body || {};
  const qtd = Number(quantidade_por_unidade);
  if (!ingredient_id || !(qtd > 0)) {
    return res.status(400).json({ erro: 'ingredient_id e quantidade_por_unidade (>0) sao obrigatorios' });
  }
  const product = await pool.query(
    `SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (product.rows.length === 0) return res.status(404).json({ erro: 'produto nao encontrado' });

  const { rows } = await pool.query(
    `INSERT INTO product_ingredients (tenant_id, product_id, ingredient_id, quantidade_por_unidade)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, ingredient_id) DO UPDATE SET quantidade_por_unidade = EXCLUDED.quantidade_por_unidade
     RETURNING id, ingredient_id, quantidade_por_unidade`,
    [req.user.tenantId, req.params.id, ingredient_id, qtd]
  );
  res.status(201).json(rows[0]);
});

router.delete('/products/:id/ingredients/:ingredientId', requireArea('Estoque'), async (req, res) => {
  await pool.query(
    `DELETE FROM product_ingredients WHERE product_id = $1 AND ingredient_id = $2 AND tenant_id = $3`,
    [req.params.id, req.params.ingredientId, req.user.tenantId]
  );
  res.status(204).send();
});

module.exports = router;
