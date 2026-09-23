const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.get('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, unidade, estoque_atual, custo_unitario, ativo FROM ingredients
     WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { nome, unidade, estoque_atual, custo_total } = req.body || {};
  if (!nome || !unidade) {
    return res.status(400).json({ erro: 'nome e unidade sao obrigatorios' });
  }
  const inicial = Number(estoque_atual ?? 0);
  if (inicial < 0) return res.status(400).json({ erro: 'estoque atual nao pode ser negativo' });
  const custoTotal = Number(custo_total ?? 0);
  if (custoTotal < 0) return res.status(400).json({ erro: 'custo total nao pode ser negativo' });
  const custoUnitario = inicial > 0 ? custoTotal / inicial : 0;

  const { rows } = await pool.query(
    `INSERT INTO ingredients (tenant_id, nome, unidade, estoque_atual, custo_unitario)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nome, unidade, estoque_atual, custo_unitario, ativo`,
    [req.user.tenantId, nome, unidade, inicial, custoUnitario]
  );
  res.status(201).json(rows[0]);
});

router.post('/ingredients/:id/stock-entries', requireArea('Estoque'), async (req, res) => {
  const { quantidade, custo_total } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });
  const custoTotalEntrada = custo_total === undefined || custo_total === null || custo_total === '' ? null : Number(custo_total);
  if (custoTotalEntrada !== null && custoTotalEntrada < 0) {
    return res.status(400).json({ erro: 'custo total nao pode ser negativo' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      `SELECT estoque_atual, custo_unitario FROM ingredients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    );
    if (atual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'insumo nao encontrado' });
    }

    const estoqueAtual = Number(atual.rows[0].estoque_atual);
    const custoUnitarioAtual = Number(atual.rows[0].custo_unitario);
    // Media ponderada: mistura o valor ja em estoque com o custo desta nova entrada.
    const novoCustoUnitario = custoTotalEntrada === null
      ? custoUnitarioAtual
      : (estoqueAtual * custoUnitarioAtual + custoTotalEntrada) / (estoqueAtual + qtd);

    const { rows } = await client.query(
      `UPDATE ingredients SET estoque_atual = estoque_atual + $1, custo_unitario = $2
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, nome, unidade, estoque_atual, custo_unitario`,
      [qtd, novoCustoUnitario, req.params.id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'entrada_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd, custo_total: custoTotalEntrada },
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

router.post('/ingredients/:id/stock-exits', requireArea('Estoque'), async (req, res) => {
  const { quantidade, motivo } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });
  if (!motivo || motivo.trim().length < 3) {
    return res.status(400).json({ erro: 'motivo e obrigatorio (minimo 3 caracteres)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      `SELECT estoque_atual FROM ingredients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    );
    if (atual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'insumo nao encontrado' });
    }
    const estoqueAtual = Number(atual.rows[0].estoque_atual);
    if (qtd > estoqueAtual) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: `saldo insuficiente (disponivel: ${estoqueAtual}, solicitado: ${qtd})` });
    }

    const { rows } = await client.query(
      `UPDATE ingredients SET estoque_atual = estoque_atual - $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, nome, unidade, estoque_atual, custo_unitario`,
      [qtd, req.params.id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'saida_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd, motivo: motivo.trim() },
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

router.post('/ingredients/:id/stock-adjustment', requireArea('Estoque'), async (req, res) => {
  const { novo_saldo, motivo } = req.body || {};
  const novoSaldo = Number(novo_saldo);
  if (novo_saldo === undefined || novo_saldo === null || novo_saldo === '' || isNaN(novoSaldo) || novoSaldo < 0) {
    return res.status(400).json({ erro: 'novo_saldo deve ser um numero valido (0 ou mais)' });
  }
  if (!motivo || motivo.trim().length < 3) {
    return res.status(400).json({ erro: 'motivo e obrigatorio (minimo 3 caracteres)' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      `SELECT estoque_atual FROM ingredients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    );
    if (atual.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'insumo nao encontrado' });
    }
    const saldoAnterior = Number(atual.rows[0].estoque_atual);

    const { rows } = await client.query(
      `UPDATE ingredients SET estoque_atual = $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, nome, unidade, estoque_atual, custo_unitario`,
      [novoSaldo, req.params.id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'balanco_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { saldo_anterior: saldoAnterior, saldo_novo: novoSaldo, diferenca: novoSaldo - saldoAnterior, motivo: motivo.trim() },
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

router.get('/ingredients/:id/consumption-history', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.quantidade_consumida, ic.criado_em,
            si.quantidade AS quantidade_vendida, p.nome AS product_nome
     FROM ingredient_consumptions ic
     JOIN sale_items si ON si.id = ic.sale_item_id
     JOIN products p ON p.id = si.product_id
     WHERE ic.ingredient_id = $1 AND ic.tenant_id = $2
     ORDER BY ic.criado_em DESC LIMIT 100`,
    [req.params.id, req.user.tenantId]
  );
  res.json(rows);
});

router.get('/consumption-feed', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT si.id AS sale_item_id, si.quantidade AS quantidade_vendida, p.nome AS product_nome,
            MIN(ic.criado_em) AS criado_em,
            json_agg(json_build_object('nome', i.nome, 'quantidade', ic.quantidade_consumida, 'unidade', i.unidade) ORDER BY i.nome) AS insumos
     FROM ingredient_consumptions ic
     JOIN sale_items si ON si.id = ic.sale_item_id
     JOIN products p ON p.id = si.product_id
     JOIN ingredients i ON i.id = ic.ingredient_id
     WHERE ic.tenant_id = $1
     GROUP BY si.id, si.quantidade, p.nome
     ORDER BY MIN(ic.criado_em) DESC
     LIMIT 30`,
    [req.user.tenantId]
  );
  res.json(rows);
});

module.exports = router;
