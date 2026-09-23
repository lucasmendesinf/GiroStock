const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];

router.post('/sales', requireArea('Vendas'), async (req, res) => {
  const { terminal_id, itens, forma_pagamento, valor_recebido } = req.body || {};

  if (!terminal_id || !Array.isArray(itens) || itens.length === 0 || !forma_pagamento) {
    return res.status(400).json({ erro: 'terminal_id, itens (nao vazio) e forma_pagamento sao obrigatorios' });
  }
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) {
    return res.status(400).json({ erro: 'forma_pagamento invalida' });
  }
  for (const item of itens) {
    if (!item.product_id || !(Number(item.quantidade) > 0)) {
      return res.status(400).json({ erro: 'cada item precisa de product_id e quantidade (>0)' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const terminal = await client.query(
      `SELECT t.id, t.location_id, cr.id AS cash_register_id
       FROM terminals t JOIN cash_registers cr ON cr.terminal_id = t.id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [terminal_id, req.user.tenantId]
    );
    if (terminal.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'terminal nao encontrado ou sem caixa configurado' });
    }
    const { location_id: locationId, cash_register_id: cashRegisterId } = terminal.rows[0];

    // Nao e possivel registrar venda com o caixa fechado
    const session = await client.query(
      `SELECT id FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL FOR UPDATE`,
      [cashRegisterId, req.user.tenantId]
    );
    if (session.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'caixa fechado: abra o caixa antes de registrar vendas' });
    }
    const cashSessionId = session.rows[0].id;

    // Carrega produtos e calcula totais
    const productIds = itens.map((i) => i.product_id);
    const products = await client.query(
      `SELECT id, nome, preco_venda, ativo FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 FOR UPDATE`,
      [productIds, req.user.tenantId]
    );
    const productMap = new Map(products.rows.map((p) => [p.id, p]));
    for (const item of itens) {
      if (!productMap.has(item.product_id) || !productMap.get(item.product_id).ativo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: `produto ${item.product_id} nao encontrado ou inativo` });
      }
    }

    let total = 0;
    const itemsComPreco = itens.map((item) => {
      const produto = productMap.get(item.product_id);
      const qtd = Number(item.quantidade);
      const precoUnitario = Number(produto.preco_venda);
      const subtotal = Number((precoUnitario * qtd).toFixed(2));
      total += subtotal;
      return { ...item, quantidade: qtd, preco_unitario: precoUnitario, subtotal };
    });
    total = Number(total.toFixed(2));

    let troco = null;
    let valorRecebidoFinal = null;
    if (forma_pagamento === 'dinheiro') {
      const recebido = Number(valor_recebido);
      if (!(recebido >= total)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: `valor recebido (${recebido}) deve ser maior ou igual ao total (${total})` });
      }
      valorRecebidoFinal = recebido;
      troco = Number((recebido - total).toFixed(2));
    }

    // Produtos com ficha tecnica (lanches montados a partir de insumos) nao tem estoque proprio:
    // a disponibilidade e controlada inteiramente pelos insumos da receita.
    const produtosComFicha = await client.query(
      `SELECT DISTINCT product_id FROM product_ingredients WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`,
      [req.user.tenantId, productIds]
    );
    const temFichaTecnica = new Set(produtosComFicha.rows.map((r) => r.product_id));

    // Verifica saldo de produto no local do terminal (somente para itens sem ficha tecnica)
    for (const item of itemsComPreco) {
      if (temFichaTecnica.has(item.product_id)) continue;
      const saldo = await client.query(
        `SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND tenant_id = $3 FOR UPDATE`,
        [item.product_id, locationId, req.user.tenantId]
      );
      const disponivel = saldo.rows[0] ? Number(saldo.rows[0].saldo) : 0;
      if (disponivel < item.quantidade) {
        await client.query('ROLLBACK');
        const nome = productMap.get(item.product_id).nome;
        return res.status(400).json({
          erro: `estoque insuficiente de "${nome}" (disponivel: ${disponivel}, necessario: ${item.quantidade})`,
        });
      }
    }

    // Ficha tecnica: agrega necessidade de insumos de todos os itens e valida ANTES de debitar qualquer coisa
    const necessidadePorInsumo = new Map(); // ingredient_id -> { nome, unidade, necessario, disponivel }
    for (const item of itemsComPreco) {
      const ficha = await client.query(
        `SELECT pi.ingredient_id, i.nome, i.unidade, i.estoque_atual, pi.quantidade_por_unidade
         FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
         WHERE pi.product_id = $1 AND pi.tenant_id = $2
         FOR UPDATE OF i`,
        [item.product_id, req.user.tenantId]
      );
      for (const row of ficha.rows) {
        const necessario = Number(row.quantidade_por_unidade) * item.quantidade;
        const atual = necessidadePorInsumo.get(row.ingredient_id) || {
          nome: row.nome,
          unidade: row.unidade,
          necessario: 0,
          disponivel: Number(row.estoque_atual),
        };
        atual.necessario += necessario;
        necessidadePorInsumo.set(row.ingredient_id, atual);
      }
    }
    for (const [, info] of necessidadePorInsumo) {
      if (info.disponivel < info.necessario) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          erro: `${info.nome}: necessario ${info.necessario}${info.unidade}, disponivel ${info.disponivel}${info.unidade}`,
        });
      }
    }

    // Tudo validado: grava a venda
    const sale = await client.query(
      `INSERT INTO sales (tenant_id, location_id, terminal_id, cash_session_id, operador_id, forma_pagamento, valor_recebido, troco, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'concluida')
       RETURNING id, total, troco, forma_pagamento, criado_em`,
      [req.user.tenantId, locationId, terminal_id, cashSessionId, req.user.id, forma_pagamento, valorRecebidoFinal, troco, total]
    );
    const saleId = sale.rows[0].id;

    for (const item of itemsComPreco) {
      const saleItem = await client.query(
        `INSERT INTO sale_items (tenant_id, sale_id, product_id, quantidade, preco_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.tenantId, saleId, item.product_id, item.quantidade, item.preco_unitario, item.subtotal]
      );

      if (!temFichaTecnica.has(item.product_id)) {
        await client.query(
          `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [item.quantidade, item.product_id, locationId, req.user.tenantId]
        );
        await client.query(
          `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id)
           VALUES ($1, $2, 'saida', $3, $4, NULL, $5, $6)`,
          [req.user.tenantId, item.product_id, item.quantidade, locationId, `Venda ${saleId}`, req.user.id]
        );
      }

      const ficha = await client.query(
        `SELECT ingredient_id, quantidade_por_unidade FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2`,
        [item.product_id, req.user.tenantId]
      );
      for (const row of ficha.rows) {
        const consumido = Number(row.quantidade_por_unidade) * item.quantidade;
        await client.query(
          `UPDATE ingredients SET estoque_atual = estoque_atual - $1 WHERE id = $2 AND tenant_id = $3`,
          [consumido, row.ingredient_id, req.user.tenantId]
        );
        await client.query(
          `INSERT INTO ingredient_consumptions (tenant_id, sale_item_id, ingredient_id, quantidade_consumida)
           VALUES ($1, $2, $3, $4)`,
          [req.user.tenantId, saleItem.rows[0].id, row.ingredient_id, consumido]
        );
      }
    }

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'venda',
      recurso: 'sales',
      recursoId: saleId,
      detalhes: { total, forma_pagamento },
    });

    await client.query('COMMIT');
    res.status(201).json({
      id: saleId,
      total,
      troco,
      forma_pagamento,
      criado_em: sale.rows[0].criado_em,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/sales', requireArea('Vendas'), async (req, res) => {
  const { location_id, operador_id, forma_pagamento } = req.query;
  const params = [req.user.tenantId];
  let where = 's.tenant_id = $1';
  if (location_id) {
    params.push(location_id);
    where += ` AND s.location_id = $${params.length}`;
  }
  if (operador_id) {
    params.push(operador_id);
    where += ` AND s.operador_id = $${params.length}`;
  }
  if (forma_pagamento) {
    params.push(forma_pagamento);
    where += ` AND s.forma_pagamento = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.total
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     JOIN terminals t ON t.id = s.terminal_id
     JOIN locations l ON l.id = s.location_id
     WHERE ${where} AND s.status = 'concluida'
     ORDER BY s.criado_em DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

module.exports = router;
