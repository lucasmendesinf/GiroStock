const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess, restrictedLocation } = require('../utils/access');
const { HttpError } = require('../utils/http');

const router = express.Router();

// Insumos tem saldo por local (ingredient_balances), como os produtos.
// O custo por unidade continua unico por insumo (media ponderada de todas as entradas).

function exigirMotivo(motivo) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw new HttpError(400, 'motivo é obrigatório (mínimo 3 caracteres)');
  }
  return String(motivo).trim();
}

// Local valido, ativo, da empresa e acessivel ao usuario.
async function localDoUsuario(db, locationId, user, acao) {
  if (!locationId) throw new HttpError(400, 'location_id (local do estoque) é obrigatório');
  await getOwnedLocation(db, locationId, user.tenantId);
  assertLocationAccess(user, locationId, acao);
}

async function ensureIngredientBalance(client, tenantId, ingredientId, locationId) {
  await client.query(
    `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (ingredient_id, location_id) DO NOTHING`,
    [ingredientId, locationId, tenantId]
  );
}

async function lockIngredientBalances(client, tenantId, ingredientId, locationIds) {
  const { rows } = await client.query(
    `SELECT location_id, saldo FROM ingredient_balances
     WHERE ingredient_id = $1 AND tenant_id = $2 AND location_id = ANY($3::uuid[])
     ORDER BY location_id FOR UPDATE`,
    [ingredientId, tenantId, locationIds]
  );
  return new Map(rows.map((r) => [r.location_id, Number(r.saldo)]));
}

async function carregarInsumo(db, tenantId, ingredientId) {
  const { rows } = await db.query(
    `SELECT i.id, i.nome, i.unidade, i.custo_unitario, i.ativo,
            COALESCE((SELECT SUM(ib.saldo) FROM ingredient_balances ib WHERE ib.ingredient_id = i.id AND ib.tenant_id = i.tenant_id), 0) AS saldo_total,
            COALESCE((SELECT json_agg(json_build_object('location_id', l.id, 'location_nome', l.nome, 'saldo', ib.saldo,
                                                        'estoque_minimo', ib.estoque_minimo,
                                                        'abaixo_minimo', ib.estoque_minimo > 0 AND ib.saldo <= ib.estoque_minimo)
                                      ORDER BY l.nome)
                      FROM ingredient_balances ib JOIN locations l ON l.id = ib.location_id
                      WHERE ib.ingredient_id = i.id AND ib.tenant_id = i.tenant_id), '[]') AS saldos_por_local
     FROM ingredients i WHERE i.id = $1 AND i.tenant_id = $2`,
    [ingredientId, tenantId]
  );
  return rows[0];
}

router.get('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.nome, i.unidade, i.custo_unitario, i.ativo,
            COALESCE((SELECT SUM(ib.saldo) FROM ingredient_balances ib WHERE ib.ingredient_id = i.id AND ib.tenant_id = i.tenant_id), 0) AS saldo_total,
            COALESCE((SELECT json_agg(json_build_object('location_id', l.id, 'location_nome', l.nome, 'saldo', ib.saldo,
                                                        'estoque_minimo', ib.estoque_minimo,
                                                        'abaixo_minimo', ib.estoque_minimo > 0 AND ib.saldo <= ib.estoque_minimo)
                                      ORDER BY l.nome)
                      FROM ingredient_balances ib JOIN locations l ON l.id = ib.location_id
                      WHERE ib.ingredient_id = i.id AND ib.tenant_id = i.tenant_id), '[]') AS saldos_por_local
     FROM ingredients i
     WHERE i.tenant_id = $1 ORDER BY i.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/ingredients', requireArea('Estoque'), async (req, res) => {
  const { nome, unidade, location_id, custo_total } = req.body || {};
  if (!nome || !unidade) {
    return res.status(400).json({ erro: 'nome e unidade são obrigatórios' });
  }
  // "estoque_inicial" (aceita o nome antigo "estoque_atual")
  const inicialInformado = req.body.estoque_inicial ?? req.body.estoque_atual ?? 0;
  const inicial = Number(inicialInformado);
  if (!(inicial >= 0)) return res.status(400).json({ erro: 'estoque inicial não pode ser negativo' });
  const custoTotal = Number(custo_total ?? 0);
  if (!(custoTotal >= 0)) return res.status(400).json({ erro: 'custo total não pode ser negativo' });
  const custoUnitario = inicial > 0 ? custoTotal / inicial : 0;
  if (inicial > 0) await localDoUsuario(pool, location_id, req.user, 'lançar estoque neste local');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO ingredients (tenant_id, nome, unidade, custo_unitario)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.tenantId, nome.trim(), unidade, custoUnitario]
    );
    if (inicial > 0) {
      await client.query(
        `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, location_id, req.user.tenantId, inicial]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(await carregarInsumo(pool, req.user.tenantId, rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/ingredients/:id/stock-entries', requireArea('Estoque'), async (req, res) => {
  const { quantidade, custo_total, location_id } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });
  const custoTotalEntrada = custo_total === undefined || custo_total === null || custo_total === '' ? null : Number(custo_total);
  if (custoTotalEntrada !== null && !(custoTotalEntrada >= 0)) {
    return res.status(400).json({ erro: 'custo total não pode ser negativo' });
  }
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  await localDoUsuario(pool, location_id, req.user, 'lançar entrada neste local');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      `SELECT i.custo_unitario,
              COALESCE((SELECT SUM(saldo) FROM ingredient_balances WHERE ingredient_id = i.id AND tenant_id = i.tenant_id), 0) AS saldo_total
       FROM ingredients i WHERE i.id = $1 AND i.tenant_id = $2 FOR UPDATE OF i`,
      [req.params.id, req.user.tenantId]
    );
    const estoqueTotal = Number(atual.rows[0].saldo_total);
    const custoUnitarioAtual = Number(atual.rows[0].custo_unitario);
    // Media ponderada: mistura o valor ja em estoque (todos os locais) com o custo desta nova entrada.
    const novoCustoUnitario = custoTotalEntrada === null
      ? custoUnitarioAtual
      : (estoqueTotal * custoUnitarioAtual + custoTotalEntrada) / (estoqueTotal + qtd);

    await client.query(`UPDATE ingredients SET custo_unitario = $1 WHERE id = $2 AND tenant_id = $3`,
      [novoCustoUnitario, req.params.id, req.user.tenantId]);
    await ensureIngredientBalance(client, req.user.tenantId, req.params.id, location_id);
    await client.query(
      `UPDATE ingredient_balances SET saldo = saldo + $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, req.params.id, location_id, req.user.tenantId]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'entrada_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd, custo_total: custoTotalEntrada, location_id },
    });
    await client.query('COMMIT');
    res.json(await carregarInsumo(pool, req.user.tenantId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/ingredients/:id/stock-exits', requireArea('Estoque'), async (req, res) => {
  const { quantidade, location_id } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });
  const motivo = exigirMotivo(req.body && req.body.motivo);
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  await localDoUsuario(pool, location_id, req.user, 'dar saída neste local');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saldos = await lockIngredientBalances(client, req.user.tenantId, req.params.id, [location_id]);
    const disponivel = saldos.get(location_id) || 0;
    if (qtd > disponivel) {
      throw new HttpError(400, `saldo insuficiente neste local (disponível: ${disponivel}, solicitado: ${qtd})`);
    }
    await client.query(
      `UPDATE ingredient_balances SET saldo = saldo - $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, req.params.id, location_id, req.user.tenantId]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'saida_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd, motivo, location_id },
    });
    await client.query('COMMIT');
    res.json(await carregarInsumo(pool, req.user.tenantId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Transferencia de insumo entre locais (ex: estoque central -> lanchonete, ou -> evento).
router.post('/ingredients/:id/transfers', requireArea('Estoque'), async (req, res) => {
  const { quantidade, location_origem_id, location_destino_id } = req.body || {};
  const qtd = Number(quantidade);
  if (!(qtd > 0)) return res.status(400).json({ erro: 'quantidade deve ser maior que zero' });
  const motivo = exigirMotivo(req.body && req.body.motivo);
  if (!location_origem_id || !location_destino_id) {
    throw new HttpError(400, 'location_origem_id e location_destino_id são obrigatórios');
  }
  if (location_origem_id === location_destino_id) {
    throw new HttpError(400, 'local de origem deve ser diferente do local de destino');
  }
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  await localDoUsuario(pool, location_origem_id, req.user, 'transferir a partir deste local');
  await getOwnedLocation(pool, location_destino_id, req.user.tenantId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureIngredientBalance(client, req.user.tenantId, req.params.id, location_destino_id);
    const saldos = await lockIngredientBalances(client, req.user.tenantId, req.params.id, [location_origem_id, location_destino_id]);
    const disponivel = saldos.get(location_origem_id) || 0;
    if (qtd > disponivel) {
      throw new HttpError(400, `saldo insuficiente no local de origem (disponível: ${disponivel}, solicitado: ${qtd})`);
    }
    await client.query(
      `UPDATE ingredient_balances SET saldo = saldo - $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, req.params.id, location_origem_id, req.user.tenantId]
    );
    await client.query(
      `UPDATE ingredient_balances SET saldo = saldo + $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, req.params.id, location_destino_id, req.user.tenantId]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'transferencia',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: { quantidade: qtd, motivo, location_origem_id, location_destino_id },
    });
    await client.query('COMMIT');
    res.json(await carregarInsumo(pool, req.user.tenantId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Balanco (contagem): sobrescreve o saldo do insumo em um local e, opcionalmente, o custo.
router.post('/ingredients/:id/stock-adjustment', requireArea('Estoque'), async (req, res) => {
  const { novo_saldo, novo_custo_unitario, location_id } = req.body || {};
  const novoSaldo = Number(novo_saldo);
  if (novo_saldo === undefined || novo_saldo === null || novo_saldo === '' || isNaN(novoSaldo) || novoSaldo < 0) {
    return res.status(400).json({ erro: 'novo_saldo deve ser um número válido (0 ou mais)' });
  }
  const sobrescreverCusto = novo_custo_unitario !== undefined && novo_custo_unitario !== null && novo_custo_unitario !== '';
  const novoCustoUnitario = sobrescreverCusto ? Number(novo_custo_unitario) : null;
  if (sobrescreverCusto && (isNaN(novoCustoUnitario) || novoCustoUnitario < 0)) {
    return res.status(400).json({ erro: 'novo_custo_unitario deve ser um número válido (0 ou mais)' });
  }
  const motivo = exigirMotivo(req.body && req.body.motivo);
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  await localDoUsuario(pool, location_id, req.user, 'fazer balanço neste local');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const atual = await client.query(
      `SELECT custo_unitario FROM ingredients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    );
    await ensureIngredientBalance(client, req.user.tenantId, req.params.id, location_id);
    const saldos = await lockIngredientBalances(client, req.user.tenantId, req.params.id, [location_id]);
    const saldoAnterior = saldos.get(location_id) || 0;
    const custoAnterior = Number(atual.rows[0].custo_unitario);
    const custoFinal = sobrescreverCusto ? novoCustoUnitario : custoAnterior;

    await client.query(
      `UPDATE ingredient_balances SET saldo = $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [novoSaldo, req.params.id, location_id, req.user.tenantId]
    );
    await client.query(`UPDATE ingredients SET custo_unitario = $1 WHERE id = $2 AND tenant_id = $3`,
      [custoFinal, req.params.id, req.user.tenantId]);

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'balanco_estoque',
      recurso: 'ingredients',
      recursoId: req.params.id,
      detalhes: {
        location_id,
        saldo_anterior: saldoAnterior, saldo_novo: novoSaldo, diferenca: novoSaldo - saldoAnterior,
        custo_anterior: custoAnterior, custo_novo: custoFinal, motivo,
      },
    });
    await client.query('COMMIT');
    res.json(await carregarInsumo(pool, req.user.tenantId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Estoque minimo do insumo em um local (0 = sem alerta).
router.put('/ingredients/:id/minimum', requireArea('Estoque'), async (req, res) => {
  const { location_id, estoque_minimo } = req.body || {};
  const minimo = Number(estoque_minimo);
  if (!(minimo >= 0)) throw new HttpError(400, 'estoque_minimo deve ser 0 ou mais');
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  await localDoUsuario(pool, location_id, req.user, 'configurar este local');
  const { rows } = await pool.query(
    `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo, estoque_minimo)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (ingredient_id, location_id) DO UPDATE SET estoque_minimo = EXCLUDED.estoque_minimo
     RETURNING ingredient_id, location_id, saldo, estoque_minimo`,
    [req.params.id, location_id, req.user.tenantId, minimo]
  );
  res.json(rows[0]);
});

router.get('/ingredients/:id/consumption-history', requireArea('Estoque'), async (req, res) => {
  await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId);
  const { rows } = await pool.query(
    `SELECT ic.id, ic.quantidade_consumida, ic.criado_em, l.nome AS location_nome,
            si.quantidade AS quantidade_vendida, p.nome AS product_nome
     FROM ingredient_consumptions ic
     JOIN sale_items si ON si.id = ic.sale_item_id
     JOIN products p ON p.id = si.product_id
     LEFT JOIN locations l ON l.id = ic.location_id
     WHERE ic.ingredient_id = $1 AND ic.tenant_id = $2
     ORDER BY ic.criado_em DESC LIMIT 100`,
    [req.params.id, req.user.tenantId]
  );
  res.json(rows);
});

router.get('/consumption-feed', requireArea('Estoque'), async (req, res) => {
  const params = [req.user.tenantId];
  let filtro = '';
  const local = restrictedLocation(req.user);
  if (local) {
    params.push(local);
    filtro = ` AND ic.location_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT si.id AS sale_item_id, si.quantidade AS quantidade_vendida, p.nome AS product_nome,
            MIN(l.nome) AS location_nome, MIN(ic.criado_em) AS criado_em,
            json_agg(json_build_object('nome', i.nome, 'quantidade', ic.quantidade_consumida, 'unidade', i.unidade) ORDER BY i.nome) AS insumos
     FROM ingredient_consumptions ic
     JOIN sale_items si ON si.id = ic.sale_item_id
     JOIN products p ON p.id = si.product_id
     JOIN ingredients i ON i.id = ic.ingredient_id
     LEFT JOIN locations l ON l.id = ic.location_id
     WHERE ic.tenant_id = $1${filtro}
     GROUP BY si.id, si.quantidade, p.nome
     ORDER BY MIN(ic.criado_em) DESC
     LIMIT 30`,
    params
  );
  res.json(rows);
});

module.exports = router;
