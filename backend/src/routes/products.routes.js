const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { reservadosDaLoja } = require('../utils/reservas');
const { unidadesDisponiveis } = require('../services/consumo');
const { salvarCombo } = require('./complementos.routes');
const { isValidBarcode, UNIDADES_INTEIRAS, isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation, isUuid } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const { HttpError } = require('../utils/http');

const router = express.Router();
const UNIDADES = ['UN', 'KG', 'L', 'CX'];

router.get('/categories', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.parent_id,
            (SELECT COUNT(*)::int FROM products p WHERE p.categoria_id = c.id AND p.tenant_id = c.tenant_id) AS produto_count,
            (SELECT COUNT(*)::int FROM categories sub WHERE sub.parent_id = c.id AND sub.tenant_id = c.tenant_id) AS subcategoria_count
     FROM categories c WHERE c.tenant_id = $1 ORDER BY c.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/categories', requireArea('Estoque'), async (req, res) => {
  const { nome, parent_id } = req.body || {};
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  if (parent_id) {
    const parent = await pool.query(
      `SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`,
      [parent_id, req.user.tenantId]
    );
    if (parent.rows.length === 0) return res.status(400).json({ erro: 'categoria pai não encontrada' });
  }
  const { rows } = await pool.query(
    `INSERT INTO categories (tenant_id, nome, parent_id) VALUES ($1, $2, $3) RETURNING id, nome, parent_id`,
    [req.user.tenantId, nome, parent_id || null]
  );
  res.status(201).json(rows[0]);
});

router.delete('/categories/:id', requireArea('Estoque'), async (req, res) => {
  const categoria = await pool.query(
    `SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (categoria.rows.length === 0) return res.status(404).json({ erro: 'categoria não encontrada' });

  const produtos = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products WHERE categoria_id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (produtos.rows[0].total > 0) {
    return res.status(400).json({ erro: `não e possível remover: existem ${produtos.rows[0].total} produto(s) vinculados a esta categoria` });
  }

  const subcategorias = await pool.query(
    `SELECT COUNT(*)::int AS total FROM categories WHERE parent_id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (subcategorias.rows[0].total > 0) {
    return res.status(400).json({ erro: `não e possível remover: existem ${subcategorias.rows[0].total} subcategoria(s) vinculadas a esta categoria` });
  }

  await pool.query(`DELETE FROM categories WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  res.status(204).send();
});

// ---------- Helpers de produto ----------

// Monta a lista de fornecedores do produto. supplier_id e o fornecedor principal;
// supplier_ids sao todos os fornecedores (o principal e incluido automaticamente).
// Fornecedores novos no vinculo precisam estar ativos e ser da mesma empresa.
async function resolverFornecedores(db, tenantId, body, jaVinculados = new Set()) {
  const principal = body.supplier_id || null;
  const lista = Array.isArray(body.supplier_ids) ? body.supplier_ids.filter(Boolean) : [];
  const ids = [...new Set(principal ? [principal, ...lista] : lista)];
  for (const id of ids) {
    await getOwned(db, 'suppliers', id, tenantId, { ativo: !jaVinculados.has(id), columns: 'id, ativo' });
  }
  return { principal: principal || ids[0] || null, ids };
}

async function sincronizarFornecedores(client, tenantId, productId, ids) {
  await client.query(
    `DELETE FROM product_suppliers WHERE product_id = $1 AND tenant_id = $2 AND NOT (supplier_id = ANY($3::uuid[]))`,
    [productId, tenantId, ids]
  );
  for (const supplierId of ids) {
    await client.query(
      `INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, supplier_id) DO NOTHING`,
      [tenantId, productId, supplierId]
    );
  }
}

function validarPrecos(precoCusto, precoVenda) {
  const custo = Number(precoCusto);
  const venda = Number(precoVenda);
  if (!(custo > 0)) throw new HttpError(400, 'preço de custo deve ser maior que zero');
  if (!(venda > 0)) throw new HttpError(400, 'preço de venda deve ser maior que zero');
  if (!(venda > custo)) throw new HttpError(400, 'preço de venda deve ser maior que o custo');
  return { custo, venda };
}

async function assertBarcodeLivre(db, tenantId, barcode, ignorarId = null) {
  const { rows } = await db.query(
    `SELECT 1 FROM products WHERE tenant_id = $1 AND barcode = $2 AND ($3::uuid IS NULL OR id <> $3)`,
    [tenantId, barcode, ignorarId]
  );
  if (rows.length > 0) throw new HttpError(409, 'já existe produto com este código de barras');
}

// Proximo codigo PRD-XXXX da empresa. O lock de transacao serializa cadastros
// simultaneos (antes, COUNT+1 gerava codigo repetido e erro).
async function proximoCodigoInterno(client, tenantId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('products:' || $1::text))`, [tenantId]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(codigo_interno FROM '^PRD-([0-9]+)$')::int), 0) + 1 AS proximo
     FROM products WHERE tenant_id = $1`,
    [tenantId]
  );
  return `PRD-${String(rows[0].proximo).padStart(4, '0')}`;
}

const SQL_FORNECEDORES = `
  COALESCE((SELECT json_agg(json_build_object('id', s2.id, 'nome', s2.nome, 'ativo', s2.ativo,
                                              'principal', s2.id = p.supplier_id) ORDER BY s2.id = p.supplier_id DESC, s2.nome)
            FROM product_suppliers ps2 JOIN suppliers s2 ON s2.id = ps2.supplier_id
            WHERE ps2.product_id = p.id AND ps2.tenant_id = p.tenant_id), '[]') AS fornecedores`;

// iFood: "vender no iFood" e o codigo PDV usado no cardapio do iFood (vazio = codigo interno).
async function camposIfood(db, tenantId, body, atual, productId = null) {
  const vende = typeof body.vende_ifood === 'boolean' ? body.vende_ifood : !!atual.vende_ifood;
  let codigo = body.codigo_ifood === undefined ? (atual.codigo_ifood || null) : (String(body.codigo_ifood || '').trim().slice(0, 60).toUpperCase() || null);
  if (codigo) {
    const dup = await db.query(
      `SELECT nome FROM products WHERE tenant_id = $1 AND (codigo_ifood = $2 OR (codigo_ifood IS NULL AND upper(codigo_interno) = $2)) AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
      [tenantId, codigo, productId]
    );
    if (dup.rows.length) throw new HttpError(409, `o código do iFood ${codigo} já é usado por "${dup.rows[0].nome}"`);
  }
  return { vende_ifood: vende, codigo_ifood: codigo };
}

// Grupos de complementos do produto (substitui a lista, na ordem informada).
async function salvarGruposDoProduto(client, tenantId, productId, grupos) {
  const ids = [...new Set(grupos)];
  if (ids.some((id) => !isUuid(id))) throw new HttpError(400, 'grupo de complementos inválido');
  if (ids.length) {
    const ok = await client.query(`SELECT id FROM grupos_complementos WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
    if (ok.rows.length !== ids.length) throw new HttpError(400, 'grupo de complementos inválido');
  }
  await client.query(`DELETE FROM produto_grupos WHERE product_id = $1`, [productId]);
  for (let i = 0; i < ids.length; i++) await client.query(`INSERT INTO produto_grupos (tenant_id, product_id, grupo_id, ordem) VALUES ($1, $2, $3, $4)`, [tenantId, productId, ids[i], i]);
}

// ---------- Rotas de produto ----------

router.get('/products', async (req, res) => {
  const params = [req.user.tenantId];
  let filtro = '';
  if (req.query.ativo === 'true' || req.query.ativo === 'false') {
    params.push(req.query.ativo === 'true');
    filtro = ` AND p.ativo = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.categoria_id, c.nome AS categoria_nome,
            p.supplier_id, s.nome AS supplier_nome, p.barcode,
            p.unidade, p.preco_custo, p.preco_venda, p.ativo, p.vende_ifood, p.codigo_ifood,
            p.grade_id, p.variacao, (SELECT g.nome FROM produto_grades g WHERE g.id = p.grade_id) AS grade_nome,
            ${SQL_FORNECEDORES},
            COALESCE((SELECT json_agg(json_build_object('product_id', ci.product_id, 'quantidade', ci.quantidade))
                      FROM combo_itens ci WHERE ci.combo_id = p.id), '[]') AS combo,
            COALESCE((SELECT json_agg(pg.grupo_id ORDER BY pg.ordem) FROM produto_grupos pg WHERE pg.product_id = p.id), '[]') AS grupos,
            COALESCE(SUM(sb.saldo), 0) AS saldo_total,
            COALESCE(
              json_agg(
                json_build_object('location_id', l.id, 'location_nome', l.nome, 'saldo', sb.saldo,
                                  'estoque_minimo', sb.estoque_minimo,
                                  'abaixo_minimo', sb.estoque_minimo > 0 AND sb.saldo <= sb.estoque_minimo)
              ) FILTER (WHERE l.id IS NOT NULL),
              '[]'
            ) AS saldos_por_local,
            EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id) AS tem_ficha_tecnica,
            (SELECT COUNT(*)::int FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id) AS insumo_count,
            COALESCE((SELECT json_agg(json_build_object('ingredient_id', pi.ingredient_id, 'quantidade_por_unidade', pi.quantidade_por_unidade))
                      FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id), '[]') AS ficha
     FROM products p
     LEFT JOIN categories c ON c.id = p.categoria_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.tenant_id = p.tenant_id
     LEFT JOIN locations l ON l.id = sb.location_id
     WHERE p.tenant_id = $1${filtro}
     GROUP BY p.id, c.nome, s.nome
     ORDER BY p.ativo DESC, p.nome`,
    params
  );
  res.json(rows.map((r) => ({ ...r, e_combo: r.combo.length > 0 })));
});

// Busca do PDV. Com terminal_id (ou location_id) retorna o saldo daquele local:
// na busca por nome, so aparecem produtos com saldo no local (ou com ficha tecnica);
// na busca por codigo de barras, o produto volta mesmo sem saldo para o PDV avisar.
router.get('/products/search', async (req, res) => {
  const { q, barcode, terminal_id } = req.query;
  const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const deslocamento = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  let locationId = req.query.location_id || null;
  if (terminal_id) {
    const terminal = await getOwned(pool, 'terminals', terminal_id, req.user.tenantId, { columns: 'id, location_id' });
    locationId = terminal.location_id;
  } else if (locationId) {
    await getOwned(pool, 'locations', locationId, req.user.tenantId);
  }
  if (locationId) assertLocationAccess(req.user, locationId, 'consultar este local');

  const params = [req.user.tenantId, locationId];
  let where = 'p.tenant_id = $1 AND p.ativo = true';
  // Sem o modulo Lanchonete, lanche com ficha tecnica nao aparece na busca do PDV/pedidos (nao pode ser vendido).
  if (req.user.modulos && req.user.modulos.lanchonete === false) {
    where += ' AND NOT EXISTS (SELECT 1 FROM product_ingredients pix WHERE pix.product_id = p.id AND pix.tenant_id = p.tenant_id)';
  }
  if (req.query.ids) {
    const lista = String(req.query.ids).split(',').filter(isUuid);
    params.push(lista);
    where += ` AND p.id = ANY($${params.length}::uuid[])`;
  } else if (barcode) {
    params.push(barcode);
    where += ` AND p.barcode = $${params.length}`;
  } else {
    params.push(`%${q || ''}%`);
    where += ` AND p.nome ILIKE $${params.length}`;
  }

  // Disponivel = saldo da loja menos o que esta reservado por pedidos em aberto (produto simples: itens; receita: insumos).
  const { rows } = await pool.query(
    `WITH res_prod AS (
       SELECT oi.product_id, SUM(oi.quantidade) AS q
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = $1 AND o.location_id = $2::uuid AND o.status NOT IN ('finalizado', 'cancelado')
         AND NOT EXISTS (SELECT 1 FROM product_ingredients pi0 WHERE pi0.product_id = oi.product_id)
       GROUP BY oi.product_id
     ), res_ing AS (
       SELECT pi.ingredient_id, SUM(pi.quantidade_por_unidade * oi.quantidade) AS q
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN product_ingredients pi ON pi.product_id = oi.product_id
       WHERE o.tenant_id = $1 AND o.location_id = $2::uuid AND o.status NOT IN ('finalizado', 'cancelado')
       GROUP BY pi.ingredient_id
     )
     SELECT * FROM (
       SELECT p.id, p.nome, p.barcode, p.codigo_interno, p.preco_venda, p.unidade,
              (SELECT c.nome FROM categories c WHERE c.id = p.categoria_id) AS categoria,
              EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id) AS tem_ficha_tecnica,
              CASE WHEN $2::uuid IS NULL THEN NULL
                   WHEN EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id)
                     THEN (SELECT MIN(FLOOR((COALESCE(ib.saldo, 0) - COALESCE(ri.q, 0)) / pi.quantidade_por_unidade))
                           FROM product_ingredients pi
                           LEFT JOIN ingredient_balances ib ON ib.ingredient_id = pi.ingredient_id AND ib.location_id = $2::uuid AND ib.tenant_id = pi.tenant_id
                           LEFT JOIN res_ing ri ON ri.ingredient_id = pi.ingredient_id
                           WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id)
                   ELSE COALESCE((SELECT sb.saldo FROM stock_balances sb
                                  WHERE sb.product_id = p.id AND sb.location_id = $2::uuid AND sb.tenant_id = p.tenant_id), 0)
                        - COALESCE((SELECT rp.q FROM res_prod rp WHERE rp.product_id = p.id), 0)
              END AS saldo,
              (SELECT i.nome FROM product_ingredients pi
               JOIN ingredients i ON i.id = pi.ingredient_id
               LEFT JOIN ingredient_balances ib ON ib.ingredient_id = pi.ingredient_id AND ib.location_id = $2::uuid AND ib.tenant_id = pi.tenant_id
               LEFT JOIN res_ing ri ON ri.ingredient_id = pi.ingredient_id
               WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id AND $2::uuid IS NOT NULL
               ORDER BY FLOOR((COALESCE(ib.saldo, 0) - COALESCE(ri.q, 0)) / pi.quantidade_por_unidade), i.nome LIMIT 1) AS insumo_limitante,
              EXISTS(SELECT 1 FROM stock_balances sb2
                     WHERE sb2.product_id = p.id AND sb2.tenant_id = p.tenant_id AND sb2.saldo > 0
                       AND ($2::uuid IS NULL OR sb2.location_id <> $2::uuid)) AS em_outras_lojas
       FROM products p
       WHERE ${where}
     ) x
     ORDER BY (COALESCE(x.saldo, 1) > 0) DESC, x.nome, x.id LIMIT ${limite} OFFSET ${deslocamento}`,
    params
  );
  if (rows.length === 0) return res.json(rows);
  const ids = rows.map((r) => r.id);
  // Combos e grupos de complementos de cada produto (o PDV abre a escolha dos complementos ao adicionar).
  const extras = await pool.query(
    `SELECT p.id,
            EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id) AS e_combo,
            COALESCE((SELECT json_agg(json_build_object('id', g.id, 'nome', g.nome, 'minimo', g.minimo, 'maximo', g.maximo,
                        'opcoes', (SELECT COALESCE(json_agg(json_build_object('id', c.id, 'nome', c.nome, 'preco', c.preco) ORDER BY c.ordem, c.nome), '[]')
                                   FROM complementos c WHERE c.grupo_id = g.id AND c.ativo)) ORDER BY pg.ordem, g.nome)
                      FROM produto_grupos pg JOIN grupos_complementos g ON g.id = pg.grupo_id WHERE pg.product_id = p.id AND g.ativo), '[]') AS grupos
     FROM products p WHERE p.id = ANY($1::uuid[]) AND p.tenant_id = $2`,
    [ids, req.user.tenantId]
  );
  const extraDe = new Map(extras.rows.map((r) => [r.id, r]));
  // Disponibilidade pela mesma regra da venda (ficha, combo e reservas de pedidos com complementos).
  let disp = null;
  if (locationId) {
    const reservados = await reservadosDaLoja(pool, req.user.tenantId, locationId);
    disp = (await unidadesDisponiveis(pool, req.user.tenantId, locationId, ids, [], reservados)).produtos;
  }
  res.json(rows.map((r) => {
    const e = extraDe.get(r.id) || {};
    const d = disp && disp.get(r.id);
    const composto = r.tem_ficha_tecnica || e.e_combo;
    return {
      ...r, e_combo: !!e.e_combo, grupos: e.grupos || [],
      ...(d && d.unidades !== null ? { saldo: d.unidades, insumo_limitante: composto ? d.limitante : r.insumo_limitante } : {}),
      // "preparo": item que pode ter observacao para a cozinha (lanche, combo ou com complementos).
      tem_ficha_tecnica: r.tem_ficha_tecnica || !!e.e_combo || (e.grupos || []).length > 0,
    };
  }));
});

router.get('/products/:id', async (req, res) => {
  const product = await getOwned(pool, 'products', req.params.id, req.user.tenantId, {
    columns: 'id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, ativo, vende_ifood, codigo_ifood',
  });

  const fornecedores = await pool.query(
    `SELECT s.id, s.nome, s.ativo, (s.id = $3::uuid) AS principal
     FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
     WHERE ps.product_id = $1 AND ps.tenant_id = $2
     ORDER BY (s.id = $3::uuid) DESC, s.nome`,
    [req.params.id, req.user.tenantId, product.supplier_id]
  );

  const saldos = await pool.query(
    `SELECT sb.location_id, l.nome AS location_nome, sb.saldo, sb.estoque_minimo,
            (sb.estoque_minimo > 0 AND sb.saldo <= sb.estoque_minimo) AS abaixo_minimo
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

  const combo = await pool.query(
    `SELECT ci.product_id, p.nome, p.codigo_interno, p.unidade, ci.quantidade, p.preco_custo, p.preco_venda
     FROM combo_itens ci JOIN products p ON p.id = ci.product_id WHERE ci.combo_id = $1 AND ci.tenant_id = $2 ORDER BY p.nome`,
    [req.params.id, req.user.tenantId]
  );
  const grupos = await pool.query(
    `SELECT g.id, g.nome, g.minimo, g.maximo FROM produto_grupos pg JOIN grupos_complementos g ON g.id = pg.grupo_id
     WHERE pg.product_id = $1 AND pg.tenant_id = $2 ORDER BY pg.ordem`,
    [req.params.id, req.user.tenantId]
  );
  res.json({ ...product, fornecedores: fornecedores.rows, saldos_por_local: saldos.rows, ficha_tecnica: ficha.rows, combo: combo.rows, e_combo: combo.rows.length > 0, grupos: grupos.rows });
});

router.post('/products', requireArea('Estoque'), async (req, res) => {
  const body = req.body || {};
  const { nome, categoria_id, barcode, unidade, location_id, estoque_inicial, ficha_tecnica } = body;

  if (!nome || nome.trim().length < 3) {
    return res.status(400).json({ erro: 'nome deve ter no mínimo 3 caracteres' });
  }
  if (!categoria_id) return res.status(400).json({ erro: 'categoria é obrigatória' });
  if (!barcode || !isValidBarcode(barcode)) {
    return res.status(400).json({ erro: 'código de barras deve ter 8 a 14 dígitos numéricos' });
  }
  if (!UNIDADES.includes(unidade)) {
    return res.status(400).json({ erro: 'unidade inválida' });
  }
  const { custo, venda } = validarPrecos(body.preco_custo, body.preco_venda);

  const fichaItems = Array.isArray(ficha_tecnica) ? ficha_tecnica : [];
  const comboItems = Array.isArray(body.combo) ? body.combo : [];
  if (fichaItems.length > 0 && comboItems.length > 0) return res.status(400).json({ erro: 'o produto é lanche (ficha técnica) ou combo, não os dois' });
  const ifood = await camposIfood(pool, req.user.tenantId, body, {});
  if (fichaItems.length > 0 && !(req.user.modulos && req.user.modulos.lanchonete)) {
    return res.status(403).json({ erro: 'O módulo Lanchonete e cozinha não faz parte do plano da sua empresa: produto com ficha técnica indisponível', modulo: 'lanchonete' });
  }
  for (const item of fichaItems) {
    if (!item.ingredient_id || !(Number(item.quantidade_por_unidade) > 0)) {
      return res.status(400).json({ erro: 'cada insumo da ficha técnica precisa de ingredient_id e quantidade_por_unidade (>0)' });
    }
  }

  // Produtos com ficha tecnica (lanches) nao tem estoque proprio: a disponibilidade
  // e controlada pelos insumos da receita, entao local/estoque inicial nao se aplicam.
  const temFicha = fichaItems.length > 0 || comboItems.length > 0; // combo tambem nao tem estoque proprio
  // O saldo nao precisa ser cadastrado junto com o produto: o estoque e tratado depois,
  // pelo modal de estoque. Se vier local, o estoque inicial continua sendo lancado (compatibilidade).
  const saldoInicial = Number(estoque_inicial ?? 0);
  const lancaEstoque = !temFicha && !!location_id;
  if (!temFicha && !lancaEstoque && saldoInicial > 0) {
    return res.status(400).json({ erro: 'informe a loja do estoque inicial' });
  }
  if (lancaEstoque) {
    if (!(saldoInicial >= 0)) return res.status(400).json({ erro: 'estoque inicial não pode ser negativo' });
    if (!isQuantidadeValidaParaUnidade(saldoInicial, unidade)) {
      return res.status(400).json({ erro: `produto vendido em ${unidade} so aceita estoque em quantidade inteira` });
    }
  }

  // Tudo que vem por id precisa ser da empresa do usuario logado.
  await getOwned(pool, 'categories', categoria_id, req.user.tenantId);
  const fornecedores = await resolverFornecedores(pool, req.user.tenantId, body);
  if (lancaEstoque) {
    await getOwnedLocation(pool, location_id, req.user.tenantId);
    assertLocationAccess(req.user, location_id, 'lançar estoque neste local');
  }
  await assertBarcodeLivre(pool, req.user.tenantId, barcode);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const codigoInterno = await proximoCodigoInterno(client, req.user.tenantId);

    const { rows } = await client.query(
      `INSERT INTO products (tenant_id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, vende_ifood, codigo_ifood)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, ativo, vende_ifood, codigo_ifood`,
      [req.user.tenantId, codigoInterno, nome.trim(), categoria_id, fornecedores.principal, barcode, unidade, custo, venda, ifood.vende_ifood, ifood.codigo_ifood]
    );
    const product = rows[0];
    await sincronizarFornecedores(client, req.user.tenantId, product.id, fornecedores.ids);

    if (lancaEstoque) {
      await client.query(
        `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)`,
        [product.id, location_id, req.user.tenantId, saldoInicial]
      );

      if (saldoInicial > 0) {
        await client.query(
          `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, supplier_id, custo_unitario)
           VALUES ($1, $2, 'entrada', $3, NULL, $4, 'Estoque inicial no cadastro do produto', $5, $6, $7)`,
          [req.user.tenantId, product.id, saldoInicial, location_id, req.user.id, fornecedores.principal, custo]
        );
      }
    }

    let ficha = [];
    if (fichaItems.length > 0) {
      const ingredientIds = fichaItems.map((i) => i.ingredient_id);
      const validIngredients = await client.query(
        `SELECT id FROM ingredients WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND ativo = true`,
        [ingredientIds, req.user.tenantId]
      );
      if (validIngredients.rows.length !== new Set(ingredientIds).size) {
        throw new HttpError(400, 'um ou mais insumos da ficha técnica não foram encontrados ou estão desativados');
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

    if (comboItems.length > 0) await salvarCombo(client, req.user, product.id, comboItems);
    if (Array.isArray(body.grupos) && body.grupos.length > 0) await salvarGruposDoProduto(client, req.user.tenantId, product.id, body.grupos);

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'criar',
      recurso: 'products',
      recursoId: product.id,
      detalhes: { preco_custo: custo, preco_venda: venda, fornecedores: fornecedores.ids },
    });

    await client.query('COMMIT');
    res.status(201).json({ ...product, fornecedores: fornecedores.ids, ficha_tecnica: ficha });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Edicao do produto. Campos omitidos mantem o valor atual.
router.put('/products/:id', requireArea('Estoque'), async (req, res) => {
  const body = req.body || {};
  const atual = await getOwned(pool, 'products', req.params.id, req.user.tenantId, {
    columns: 'id, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, vende_ifood, codigo_ifood',
  });
  const ifood = await camposIfood(pool, req.user.tenantId, body, atual, req.params.id);

  const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
  if (nome.length < 3) throw new HttpError(400, 'nome deve ter no mínimo 3 caracteres');

  const categoriaId = body.categoria_id !== undefined ? body.categoria_id : atual.categoria_id;
  if (!categoriaId) throw new HttpError(400, 'categoria é obrigatória');
  if (categoriaId !== atual.categoria_id) await getOwned(pool, 'categories', categoriaId, req.user.tenantId);

  const barcode = body.barcode !== undefined ? String(body.barcode) : atual.barcode;
  if (!isValidBarcode(barcode)) throw new HttpError(400, 'código de barras deve ter 8 a 14 dígitos numéricos');
  if (barcode !== atual.barcode) await assertBarcodeLivre(pool, req.user.tenantId, barcode, req.params.id);

  const unidade = body.unidade !== undefined ? body.unidade : atual.unidade;
  if (!UNIDADES.includes(unidade)) throw new HttpError(400, 'unidade inválida');
  if (unidade !== atual.unidade && UNIDADES_INTEIRAS.includes(unidade)) {
    const fracionado = await pool.query(
      `SELECT 1 FROM stock_balances WHERE product_id = $1 AND tenant_id = $2 AND saldo <> trunc(saldo) LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );
    if (fracionado.rows.length > 0) {
      throw new HttpError(400, `ha saldo fracionado deste produto; ajuste o estoque antes de mudar a unidade para ${unidade}`);
    }
  }

  const { custo, venda } = validarPrecos(
    body.preco_custo !== undefined ? body.preco_custo : atual.preco_custo,
    body.preco_venda !== undefined ? body.preco_venda : atual.preco_venda
  );

  let fornecedores = null;
  if (body.supplier_id !== undefined || body.supplier_ids !== undefined) {
    const vinculados = await pool.query(
      `SELECT supplier_id FROM product_suppliers WHERE product_id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    );
    fornecedores = await resolverFornecedores(pool, req.user.tenantId, body, new Set(vinculados.rows.map((r) => r.supplier_id)));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE products SET nome = $1, categoria_id = $2, barcode = $3, unidade = $4, preco_custo = $5, preco_venda = $6,
              supplier_id = $7, vende_ifood = $10, codigo_ifood = $11
       WHERE id = $8 AND tenant_id = $9
       RETURNING id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, ativo, vende_ifood, codigo_ifood`,
      [nome, categoriaId, barcode, unidade, custo, venda,
        fornecedores ? fornecedores.principal : atual.supplier_id, req.params.id, req.user.tenantId, ifood.vende_ifood, ifood.codigo_ifood]
    );
    if (body.combo !== undefined) await salvarCombo(client, req.user, req.params.id, body.combo);
    if (Array.isArray(body.grupos)) await salvarGruposDoProduto(client, req.user.tenantId, req.params.id, body.grupos);
    if (fornecedores) await sincronizarFornecedores(client, req.user.tenantId, req.params.id, fornecedores.ids);
    // variacao de grade: o preco promocional do site (% da grade) acompanha o novo preco
    const gradeId = (await client.query(`SELECT grade_id FROM products WHERE id = $1`, [req.params.id])).rows[0].grade_id;
    if (gradeId) await require('../services/grades').sincronizarSite(client, req.user.tenantId, gradeId);

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'editar',
      recurso: 'products',
      recursoId: req.params.id,
      detalhes: {
        antes: { nome: atual.nome, barcode: atual.barcode, unidade: atual.unidade, preco_custo: atual.preco_custo, preco_venda: atual.preco_venda },
        depois: { nome, barcode, unidade, preco_custo: custo, preco_venda: venda },
        fornecedores: fornecedores ? fornecedores.ids : undefined,
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

// Produto inativo some do PDV e nao recebe novas entradas, mas o historico e o saldo
// continuam (ainda e possivel transferir ou dar saida do que sobrou).
router.patch('/products/:id/status', requireArea('Estoque'), async (req, res) => {
  const ativo = !!(req.body && req.body.ativo);
  await getOwned(pool, 'products', req.params.id, req.user.tenantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE products SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, nome, ativo, grade_id`,
      [ativo, req.params.id, req.user.tenantId]
    );
    // variacao desligada sai do site junto
    if (rows[0].grade_id) await require('../services/grades').sincronizarSite(client, req.user.tenantId, rows[0].grade_id);
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: ativo ? 'ativar' : 'desativar',
      recurso: 'products',
      recursoId: req.params.id,
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

// Estoque minimo do produto em um local (0 = sem alerta).
router.put('/products/:id/minimum', requireArea('Estoque'), async (req, res) => {
  const { location_id, estoque_minimo } = req.body || {};
  const minimo = Number(estoque_minimo);
  if (!location_id || !(minimo >= 0)) throw new HttpError(400, 'location_id e estoque_minimo (0 ou mais) são obrigatórios');
  await getOwned(pool, 'products', req.params.id, req.user.tenantId);
  await getOwnedLocation(pool, location_id, req.user.tenantId);
  assertLocationAccess(req.user, location_id, 'configurar este local');
  const ficha = await pool.query(
    `SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`,
    [req.params.id, req.user.tenantId]
  );
  if (ficha.rows.length > 0) throw new HttpError(400, 'produto com ficha técnica não tem estoque próprio; defina o mínimo nos insumos');

  const { rows } = await pool.query(
    `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo, estoque_minimo)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (product_id, location_id) DO UPDATE SET estoque_minimo = EXCLUDED.estoque_minimo
     RETURNING product_id, location_id, saldo, estoque_minimo`,
    [req.params.id, location_id, req.user.tenantId, minimo]
  );
  res.json(rows[0]);
});

// Ficha tecnica
router.post('/products/:id/ingredients', requireArea('Estoque'), requireModulo('lanchonete'), async (req, res) => {
  const { ingredient_id, quantidade_por_unidade } = req.body || {};
  const qtd = Number(quantidade_por_unidade);
  if (!ingredient_id || !(qtd > 0)) {
    return res.status(400).json({ erro: 'ingredient_id e quantidade_por_unidade (>0) são obrigatórios' });
  }
  await getOwned(pool, 'products', req.params.id, req.user.tenantId);
  const insumo = await getOwned(pool, 'ingredients', ingredient_id, req.user.tenantId, { columns: 'id, ativo' });
  if (!insumo.ativo) {
    const jaNaReceita = await pool.query(`SELECT 1 FROM product_ingredients WHERE product_id = $1 AND ingredient_id = $2 AND tenant_id = $3`, [req.params.id, ingredient_id, req.user.tenantId]);
    if (jaNaReceita.rows.length === 0) throw new HttpError(400, 'insumo desativado: reative-o para usar em um produto');
  }

  // Ao ganhar ficha tecnica o produto passa a ser controlado pelos insumos e o
  // saldo proprio seria ignorado; exige zerar/transferir esse saldo antes.
  const saldoProprio = await pool.query(
    `SELECT COALESCE(SUM(saldo), 0) AS total FROM stock_balances WHERE product_id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (Number(saldoProprio.rows[0].total) > 0) {
    throw new HttpError(400, `este produto tem ${Number(saldoProprio.rows[0].total)} em estoque próprio; de saída desse saldo antes de vincular insumos`);
  }

  const { rows } = await pool.query(
    `INSERT INTO product_ingredients (tenant_id, product_id, ingredient_id, quantidade_por_unidade)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, ingredient_id) DO UPDATE SET quantidade_por_unidade = EXCLUDED.quantidade_por_unidade
     RETURNING id, ingredient_id, quantidade_por_unidade`,
    [req.user.tenantId, req.params.id, ingredient_id, qtd]
  );
  res.status(201).json(rows[0]);
});

router.delete('/products/:id/ingredients/:ingredientId', requireArea('Estoque'), requireModulo('lanchonete'), async (req, res) => {
  await pool.query(
    `DELETE FROM product_ingredients WHERE product_id = $1 AND ingredient_id = $2 AND tenant_id = $3`,
    [req.params.id, req.params.ingredientId, req.user.tenantId]
  );
  res.status(204).send();
});

module.exports = router;
