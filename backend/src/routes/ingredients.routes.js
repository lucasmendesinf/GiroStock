const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess, filtroLocais } = require('../utils/access');
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

// Edita o cadastro do insumo: nome, custo por unidade, ativo e (so com saldo zerado) a unidade.
router.put('/ingredients/:id', requireArea('Estoque'), async (req, res) => {
  const atual = await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId, { columns: 'id, nome, unidade, custo_unitario, ativo' });
  const body = req.body || {};
  const nome = body.nome === undefined ? atual.nome : String(body.nome).trim();
  if (nome.length < 2) throw new HttpError(400, 'nome precisa ter pelo menos 2 caracteres');
  const custo = body.custo_unitario === undefined || body.custo_unitario === '' ? Number(atual.custo_unitario) : Number(body.custo_unitario);
  if (!(custo >= 0)) throw new HttpError(400, 'custo por unidade deve ser 0 ou mais');
  const ativo = body.ativo === undefined ? atual.ativo : !!body.ativo;
  const unidade = body.unidade === undefined ? atual.unidade : String(body.unidade);
  // Trocar a unidade exige estoque zerado em todas as lojas. Estar em receitas NAO impede: os produtos afetados voltam na resposta.
  let produtosAfetados = [];
  if (unidade !== atual.unidade) {
    const uso = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM ingredient_balances WHERE ingredient_id = $1 AND tenant_id = $2 AND saldo <> 0) AS com_saldo`,
      [req.params.id, req.user.tenantId]
    );
    if (uso.rows[0].com_saldo) {
      throw new HttpError(400, 'não dá para trocar a unidade com estoque: zere o saldo do insumo em todas as lojas (Movimentar > Balanço) e tente de novo');
    }
    produtosAfetados = (await pool.query(
      `SELECT DISTINCT p.nome FROM product_ingredients pi JOIN products p ON p.id = pi.product_id
        WHERE pi.ingredient_id = $1 AND pi.tenant_id = $2 ORDER BY p.nome`,
      [req.params.id, req.user.tenantId]
    )).rows.map((r) => r.nome);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ingredients SET nome = $1, unidade = $2, custo_unitario = $3, ativo = $4 WHERE id = $5 AND tenant_id = $6`,
      [nome, unidade, custo, ativo, req.params.id, req.user.tenantId]
    );
    const acimaVenda = await recalcularCustoProdutos(client, req.user.tenantId, req.params.id);
    await logAudit(client, {
      tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_insumo', recurso: 'ingredients', recursoId: req.params.id,
      detalhes: { antes: { nome: atual.nome, unidade: atual.unidade, custo_unitario: Number(atual.custo_unitario), ativo: atual.ativo }, depois: { nome, unidade, custo_unitario: custo, ativo } },
    });
    await client.query('COMMIT');
    res.json({ ...(await carregarInsumo(pool, req.user.tenantId, req.params.id)), produtos_custo_acima_venda: acimaVenda, produtos_afetados: produtosAfetados });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Exclui o insumo so se nunca teve movimentacao e nao esta em nenhuma receita; senao, so desativar.
router.delete('/ingredients/:id', requireArea('Estoque'), async (req, res) => {
  const atual = await getOwned(pool, 'ingredients', req.params.id, req.user.tenantId, { columns: 'id, nome' });
  const { rows } = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM product_ingredients WHERE ingredient_id = $1 AND tenant_id = $2) AS em_receita,
       EXISTS(SELECT 1 FROM ingredient_balances WHERE ingredient_id = $1 AND tenant_id = $2 AND saldo <> 0) AS com_saldo,
       EXISTS(SELECT 1 FROM ingredient_consumptions WHERE ingredient_id = $1) AS consumido,
       EXISTS(SELECT 1 FROM audit_logs WHERE tenant_id = $2 AND recurso = 'ingredients' AND recurso_id = $1
              AND acao IN ('entrada_estoque', 'saida_estoque', 'transferencia', 'balanco_estoque')) AS movimentado`,
    [req.params.id, req.user.tenantId]
  );
  const r = rows[0];
  if (r.em_receita) throw new HttpError(409, 'este insumo está em receitas de produtos; remova-o das receitas ou apenas desative');
  if (r.com_saldo || r.consumido || r.movimentado) throw new HttpError(409, 'este insumo já tem movimentação de estoque, então só pode ser desativado');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ingredient_balances WHERE ingredient_id = $1 AND tenant_id = $2', [req.params.id, req.user.tenantId]);
    await client.query('DELETE FROM ingredients WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user.tenantId]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'excluir', recurso: 'ingredients', recursoId: req.params.id, detalhes: { nome: atual.nome } });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') throw new HttpError(409, 'este insumo já tem movimentação, então só pode ser desativado');
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
    // O custo do insumo e o da ultima entrada informada (custo total / quantidade). Sem custo na entrada, mantem o atual.
    void estoqueTotal;
    const novoCustoUnitario = custoTotalEntrada === null || !(custoTotalEntrada > 0)
      ? custoUnitarioAtual
      : custoTotalEntrada / qtd;

    await client.query(`UPDATE ingredients SET custo_unitario = $1 WHERE id = $2 AND tenant_id = $3`,
      [novoCustoUnitario, req.params.id, req.user.tenantId]);
    const acimaVenda = await recalcularCustoProdutos(client, req.user.tenantId, req.params.id);
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
      detalhes: { quantidade: qtd, custo_total: custoTotalEntrada, location_id, documento_fiscal: req.body.documento_fiscal || null, supplier_id: req.body.supplier_id || null },
    });
    await client.query('COMMIT');
    res.json({ ...(await carregarInsumo(pool, req.user.tenantId, req.params.id)), produtos_custo_acima_venda: acimaVenda });
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
    const acimaVenda = await recalcularCustoProdutos(client, req.user.tenantId, req.params.id);

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
    res.json({ ...(await carregarInsumo(pool, req.user.tenantId, req.params.id)), produtos_custo_acima_venda: acimaVenda });
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
  const locais = filtroLocais(req.user, null);
  if (locais) {
    params.push(locais);
    filtro = ` AND ic.location_id = ANY($${params.length}::uuid[])`;
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
