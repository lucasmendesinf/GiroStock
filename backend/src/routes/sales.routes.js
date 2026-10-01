const express = require('express');
const pool = require('../db/pool');
const { requirePermission, temPermissao } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess, restrictedLocation, canCancelSales } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');

const router = express.Router();
const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];

// Junta linhas repetidas do mesmo produto (ex: 4 + 4) numa so. Antes, cada linha
// era validada contra o saldo separadamente e a venda passava do estoque.
function agruparItens(itens) {
  const porProduto = new Map();
  for (const item of itens) {
    if (!item || !isUuid(item.product_id) || !(Number(item.quantidade) > 0)) {
      throw new HttpError(400, 'cada item precisa de product_id válido e quantidade (>0)');
    }
    porProduto.set(item.product_id, (porProduto.get(item.product_id) || 0) + Number(item.quantidade));
  }
  return [...porProduto.entries()].map(([product_id, quantidade]) => ({ product_id, quantidade }));
}

router.post('/sales', requirePermission('vendas.pdv'), async (req, res) => {
  const { terminal_id, itens, forma_pagamento, valor_recebido } = req.body || {};
  const descontoInformado = Number((req.body && req.body.desconto) || 0);
  if (!(descontoInformado >= 0)) {
    return res.status(400).json({ erro: 'desconto deve ser um valor em reais (0 ou mais)' });
  }
  if (descontoInformado > 0 && !temPermissao(req.user, 'vendas.desconto')) {
    return res.status(403).json({ erro: 'seu nível de acesso não permite dar desconto' });
  }

  if (!terminal_id || !Array.isArray(itens) || itens.length === 0 || !forma_pagamento) {
    return res.status(400).json({ erro: 'terminal_id, itens (não vazio) e forma_pagamento são obrigatórios' });
  }
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) {
    return res.status(400).json({ erro: 'forma_pagamento inválida' });
  }
  const itensAgrupados = agruparItens(itens);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const terminal = await getOwned(client, 'terminals', terminal_id, req.user.tenantId, { columns: 'id, location_id, ativo' });
    if (!terminal.ativo) throw new HttpError(400, 'terminal inativo');
    const register = await client.query(
      `SELECT cr.id, l.ativo AS location_ativo
       FROM cash_registers cr JOIN locations l ON l.id = $3
       WHERE cr.terminal_id = $1 AND cr.tenant_id = $2`,
      [terminal_id, req.user.tenantId, terminal.location_id]
    );
    if (register.rows.length === 0) throw new HttpError(404, 'terminal sem caixa configurado');
    if (!register.rows[0].location_ativo) throw new HttpError(400, 'o local deste terminal está inativo');
    const locationId = terminal.location_id;
    const cashRegisterId = register.rows[0].id;
    assertLocationAccess(req.user, locationId, 'vender neste terminal');

    // Nao e possivel registrar venda com o caixa fechado
    const session = await client.query(
      `SELECT id FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL FOR UPDATE`,
      [cashRegisterId, req.user.tenantId]
    );
    if (session.rows.length === 0) {
      throw new HttpError(400, 'caixa fechado: abra o caixa antes de registrar vendas');
    }
    const cashSessionId = session.rows[0].id;

    // Carrega e trava os produtos (sempre em ordem de id, como nas movimentacoes de estoque)
    const productIds = itensAgrupados.map((i) => i.product_id);
    const products = await client.query(
      `SELECT id, nome, unidade, preco_venda, preco_custo, ativo FROM products
       WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id FOR UPDATE`,
      [productIds, req.user.tenantId]
    );
    const productMap = new Map(products.rows.map((p) => [p.id, p]));
    for (const item of itensAgrupados) {
      const produto = productMap.get(item.product_id);
      if (!produto || !produto.ativo) {
        throw new HttpError(400, `produto ${item.product_id} não encontrado ou inativo`);
      }
      if (!isQuantidadeValidaParaUnidade(item.quantidade, produto.unidade)) {
        throw new HttpError(400, `"${produto.nome}" e vendido em ${produto.unidade} e so aceita quantidade inteira`);
      }
    }

    let subtotalVenda = 0;
    const itemsComPreco = itensAgrupados.map((item) => {
      const produto = productMap.get(item.product_id);
      const precoUnitario = Number(produto.preco_venda);
      const subtotal = Number((precoUnitario * item.quantidade).toFixed(2));
      subtotalVenda += subtotal;
      return { ...item, preco_unitario: precoUnitario, custo_unitario: Number(produto.preco_custo), subtotal };
    });
    subtotalVenda = Number(subtotalVenda.toFixed(2));
    const desconto = Number(descontoInformado.toFixed(2));
    if (desconto >= subtotalVenda) {
      throw new HttpError(400, `desconto (${desconto}) deve ser menor que o subtotal da venda (${subtotalVenda})`);
    }
    const total = Number((subtotalVenda - desconto).toFixed(2));

    let troco = null;
    let valorRecebidoFinal = null;
    if (forma_pagamento === 'dinheiro') {
      const recebido = Number(valor_recebido);
      if (!(recebido >= total)) {
        throw new HttpError(400, `valor recebido (${recebido}) deve ser maior ou igual ao total (${total})`);
      }
      valorRecebidoFinal = recebido;
      troco = Number((recebido - total).toFixed(2));
    }

    // Produtos com ficha tecnica (lanches montados a partir de insumos) nao tem estoque proprio:
    // a disponibilidade e controlada inteiramente pelos insumos da receita.
    const fichas = await client.query(
      `SELECT pi.product_id, pi.ingredient_id, pi.quantidade_por_unidade, i.nome, i.unidade
       FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
       WHERE pi.tenant_id = $1 AND pi.product_id = ANY($2::uuid[])`,
      [req.user.tenantId, productIds]
    );
    const fichaPorProduto = new Map();
    for (const row of fichas.rows) {
      if (!fichaPorProduto.has(row.product_id)) fichaPorProduto.set(row.product_id, []);
      fichaPorProduto.get(row.product_id).push(row);
    }

    // Verifica saldo de produto no local do terminal (somente para itens sem ficha tecnica)
    const semFicha = itemsComPreco.filter((i) => !fichaPorProduto.has(i.product_id));
    if (semFicha.length > 0) {
      const saldos = await client.query(
        `SELECT product_id, saldo FROM stock_balances
         WHERE product_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3
         ORDER BY product_id FOR UPDATE`,
        [semFicha.map((i) => i.product_id), locationId, req.user.tenantId]
      );
      const saldoMap = new Map(saldos.rows.map((r) => [r.product_id, Number(r.saldo)]));
      for (const item of semFicha) {
        const disponivel = saldoMap.get(item.product_id) || 0;
        if (disponivel < item.quantidade) {
          const nome = productMap.get(item.product_id).nome;
          throw new HttpError(400, `estoque insuficiente de "${nome}" nesta loja (disponível: ${disponivel}, necessário: ${item.quantidade})`);
        }
      }
    }

    // Ficha tecnica: agrega a necessidade de insumos de todos os itens e valida contra
    // o saldo de insumos DO LOCAL do terminal antes de debitar qualquer coisa.
    const necessidadePorInsumo = new Map(); // ingredient_id -> { nome, unidade, necessario }
    for (const item of itemsComPreco) {
      for (const row of fichaPorProduto.get(item.product_id) || []) {
        const atual = necessidadePorInsumo.get(row.ingredient_id) || { nome: row.nome, unidade: row.unidade, necessario: 0 };
        atual.necessario += Number(row.quantidade_por_unidade) * item.quantidade;
        necessidadePorInsumo.set(row.ingredient_id, atual);
      }
    }
    if (necessidadePorInsumo.size > 0) {
      const saldosInsumo = await client.query(
        `SELECT ingredient_id, saldo FROM ingredient_balances
         WHERE ingredient_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3
         ORDER BY ingredient_id FOR UPDATE`,
        [[...necessidadePorInsumo.keys()], locationId, req.user.tenantId]
      );
      const saldoInsumoMap = new Map(saldosInsumo.rows.map((r) => [r.ingredient_id, Number(r.saldo)]));
      for (const [ingredientId, info] of necessidadePorInsumo) {
        const disponivel = saldoInsumoMap.get(ingredientId) || 0;
        if (disponivel < info.necessario) {
          throw new HttpError(400, `${info.nome}: necessário ${info.necessario}${info.unidade}, disponível nesta loja ${disponivel}${info.unidade}`);
        }
      }
    }

    // Tudo validado: grava a venda com o proximo numero sequencial da empresa
    // (o lock de transacao serializa vendas simultaneas so na hora de numerar).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sales:' || $1::text))`, [req.user.tenantId]);
    const proximo = await client.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM sales WHERE tenant_id = $1`,
      [req.user.tenantId]
    );
    const numero = proximo.rows[0].numero;
    const sale = await client.query(
      `INSERT INTO sales (tenant_id, numero, location_id, terminal_id, cash_session_id, operador_id, forma_pagamento,
                          valor_recebido, troco, subtotal, desconto, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'concluida')
       RETURNING id, numero, subtotal, desconto, total, troco, forma_pagamento, criado_em`,
      [req.user.tenantId, numero, locationId, terminal_id, cashSessionId, req.user.id, forma_pagamento,
        valorRecebidoFinal, troco, subtotalVenda, desconto, total]
    );
    const saleId = sale.rows[0].id;

    for (const item of itemsComPreco) {
      const saleItem = await client.query(
        `INSERT INTO sale_items (tenant_id, sale_id, product_id, quantidade, preco_unitario, custo_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.user.tenantId, saleId, item.product_id, item.quantidade, item.preco_unitario, item.custo_unitario, item.subtotal]
      );

      const ficha = fichaPorProduto.get(item.product_id);
      if (!ficha) {
        await client.query(
          `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [item.quantidade, item.product_id, locationId, req.user.tenantId]
        );
        await client.query(
          `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, sale_id)
           VALUES ($1, $2, 'saida', $3, $4, NULL, $5, $6, $7)`,
          [req.user.tenantId, item.product_id, item.quantidade, locationId, `Venda nº ${numero}`, req.user.id, saleId]
        );
        continue;
      }

      for (const row of ficha) {
        const consumido = Number(row.quantidade_por_unidade) * item.quantidade;
        await client.query(
          `UPDATE ingredient_balances SET saldo = saldo - $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [consumido, row.ingredient_id, locationId, req.user.tenantId]
        );
        await client.query(
          `INSERT INTO ingredient_consumptions (tenant_id, sale_item_id, ingredient_id, quantidade_consumida, location_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.tenantId, saleItem.rows[0].id, row.ingredient_id, consumido, locationId]
        );
      }
    }

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'venda',
      recurso: 'sales',
      recursoId: saleId,
      detalhes: { numero, subtotal: subtotalVenda, desconto, total, forma_pagamento },
    });

    await client.query('COMMIT');
    res.status(201).json({
      id: saleId,
      numero,
      subtotal: subtotalVenda,
      desconto,
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

// Cancela uma venda devolvendo o estoque (produtos e insumos) ao local da venda.
// So enquanto o caixa da venda estiver aberto, para nao alterar um fechamento ja conferido.
router.post('/sales/:id/cancel', requirePermission('vendas.cancelar'), async (req, res) => {
  if (!canCancelSales(req.user)) {
    throw new HttpError(403, 'seu nível de acesso não permite cancelar vendas');
  }
  const motivo = String((req.body && req.body.motivo) || '').trim();
  if (motivo.length < 3) throw new HttpError(400, 'motivo do cancelamento é obrigatório (mínimo 3 caracteres)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sale = await getOwned(client, 'sales', req.params.id, req.user.tenantId, {
      columns: 'id, numero, status, location_id, cash_session_id, total',
      lock: true,
    });
    if (sale.status !== 'concluida') throw new HttpError(400, 'esta venda já foi cancelada');
    assertLocationAccess(req.user, sale.location_id, 'cancelar vendas deste local');

    const session = await client.query(
      `SELECT fechado_em FROM cash_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [sale.cash_session_id, req.user.tenantId]
    );
    if (session.rows[0].fechado_em) {
      throw new HttpError(400, 'o caixa desta venda já foi fechado; não e possível cancelá-la');
    }

    const itens = await client.query(
      `SELECT si.id, si.product_id, si.quantidade FROM sale_items si
       WHERE si.sale_id = $1 AND si.tenant_id = $2`,
      [sale.id, req.user.tenantId]
    );
    // Mesma ordem de travas da venda: produtos -> saldos.
    await client.query(
      `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id FOR UPDATE`,
      [itens.rows.map((i) => i.product_id), req.user.tenantId]
    );

    // Produtos com estoque proprio: estorna exatamente as saidas feitas pela venda.
    const saidas = await client.query(
      `SELECT product_id, location_origem_id, SUM(quantidade) AS quantidade
       FROM stock_movements
       WHERE sale_id = $1 AND tenant_id = $2 AND tipo = 'saida'
       GROUP BY product_id, location_origem_id
       ORDER BY product_id`,
      [sale.id, req.user.tenantId]
    );
    for (const saida of saidas.rows) {
      await client.query(
        `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, 0)
         ON CONFLICT (product_id, location_id) DO NOTHING`,
        [saida.product_id, saida.location_origem_id, req.user.tenantId]
      );
      await client.query(
        `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [saida.quantidade, saida.product_id, saida.location_origem_id, req.user.tenantId]
      );
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, sale_id)
         VALUES ($1, $2, 'entrada', $3, NULL, $4, $5, $6, $7)`,
        [req.user.tenantId, saida.product_id, saida.quantidade, saida.location_origem_id,
          `Estorno do cancelamento da venda nº ${sale.numero}: ${motivo}`, req.user.id, sale.id]
      );
    }

    // Insumos consumidos pela ficha tecnica voltam para o local onde foram consumidos.
    const consumos = await client.query(
      `SELECT ic.ingredient_id, COALESCE(ic.location_id, $3::uuid) AS location_id, SUM(ic.quantidade_consumida) AS quantidade
       FROM ingredient_consumptions ic
       WHERE ic.sale_item_id = ANY($1::uuid[]) AND ic.tenant_id = $2
       GROUP BY ic.ingredient_id, COALESCE(ic.location_id, $3::uuid)
       ORDER BY ic.ingredient_id`,
      [itens.rows.map((i) => i.id), req.user.tenantId, sale.location_id]
    );
    for (const consumo of consumos.rows) {
      await client.query(
        `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)
         ON CONFLICT (ingredient_id, location_id) DO UPDATE SET saldo = ingredient_balances.saldo + EXCLUDED.saldo`,
        [consumo.ingredient_id, consumo.location_id, req.user.tenantId, consumo.quantidade]
      );
    }

    const { rows } = await client.query(
      `UPDATE sales SET status = 'cancelada', cancelado_em = now(), cancelado_por = $1, motivo_cancelamento = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, status, cancelado_em, motivo_cancelamento, total`,
      [req.user.id, motivo, sale.id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'cancelar_venda',
      recurso: 'sales',
      recursoId: sale.id,
      detalhes: {
        motivo,
        total: Number(sale.total),
        estorno_produtos: saidas.rows.length,
        estorno_insumos: consumos.rows.length,
      },
    });

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

function filtrosVendas(req) {
  const { location_id, operador_id, forma_pagamento, status } = req.query;
  const params = [req.user.tenantId];
  let where = 's.tenant_id = $1';
  const local = restrictedLocation(req.user) || location_id;
  if (local) {
    params.push(local);
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
  if (status !== 'todas') {
    params.push(status === 'cancelada' ? 'cancelada' : 'concluida');
    where += ` AND s.status = $${params.length}`;
  }
  return { params, where };
}

router.get('/sales', requirePermission('vendas.pdv', 'relatorios.ver'), async (req, res) => {
  const { params, where } = filtrosVendas(req);
  const { rows } = await pool.query(
    `SELECT s.id, s.numero, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.subtotal, s.desconto, s.total, s.status
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     JOIN terminals t ON t.id = s.terminal_id
     JOIN locations l ON l.id = s.location_id
     WHERE ${where}
     ORDER BY s.criado_em DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

// Detalhe da venda com os itens (aberto para quem vende e para quem ve relatorios).
router.get('/sales/:id', async (req, res) => {
  if (!temPermissao(req.user, 'vendas.pdv') && !temPermissao(req.user, 'relatorios.ver')) {
    throw new HttpError(403, 'seu nível de acesso não permite ver vendas');
  }
  await getOwned(pool, 'sales', req.params.id, req.user.tenantId);
  const venda = await pool.query(
    `SELECT s.id, s.numero, s.criado_em, s.status, s.forma_pagamento, s.valor_recebido, s.troco, s.subtotal, s.desconto, s.total,
            tn.nome AS empresa_nome,
            s.location_id, l.nome AS location_nome, t.nome AS terminal_nome, u.nome AS operador_nome,
            s.cash_session_id, cs.fechado_em IS NULL AS caixa_aberto,
            s.cancelado_em, s.motivo_cancelamento, uc.nome AS cancelado_por_nome
     FROM sales s
     JOIN locations l ON l.id = s.location_id
     JOIN terminals t ON t.id = s.terminal_id
     JOIN users u ON u.id = s.operador_id
     JOIN cash_sessions cs ON cs.id = s.cash_session_id
     JOIN tenants tn ON tn.id = s.tenant_id
     LEFT JOIN users uc ON uc.id = s.cancelado_por
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  const v = venda.rows[0];
  assertLocationAccess(req.user, v.location_id, 'ver vendas deste local');

  const itens = await pool.query(
    `SELECT si.id, si.product_id, p.nome AS product_nome, p.codigo_interno, si.quantidade,
            p.unidade, si.preco_unitario, si.custo_unitario, si.subtotal
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1 AND si.tenant_id = $2
     ORDER BY p.nome`,
    [req.params.id, req.user.tenantId]
  );
  res.json({ ...v, pode_cancelar: v.status === 'concluida' && v.caixa_aberto && canCancelSales(req.user), itens: itens.rows });
});

module.exports = router;
