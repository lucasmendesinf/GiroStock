// Complementos (adicionais) e combos.
// - Grupo de complementos: "Adicionais" (min 0 / max 3), "Escolha a bebida" (min 1 / max 1)...
// - Complemento: opcao do grupo, com preco; pode baixar um insumo (Bacon extra = 30 g) ou um produto (Coca lata).
// - Produto escolhe os grupos que oferece. Combo: produto feito de outros produtos (baixa os componentes).
// Cadastro: area Estoque. Complemento que baixa insumo exige o modulo Lanchonete.
const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { getOwned, isUuid } = require('../utils/tenant');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const estoque = requireArea('Estoque');
const texto = (v, max = 80) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// ---------- grupos ----------
async function listarGrupos(tenantId, somenteId = null) {
  const { rows } = await pool.query(
    `SELECT g.id, g.nome, g.minimo, g.maximo, g.ativo,
            (SELECT COUNT(*)::int FROM produto_grupos pg WHERE pg.grupo_id = g.id) AS produtos,
            COALESCE((SELECT json_agg(json_build_object(
                'id', c.id, 'nome', c.nome, 'preco', c.preco, 'codigo', c.codigo, 'ativo', c.ativo, 'ordem', c.ordem,
                'ingredient_id', c.ingredient_id, 'quantidade_insumo', c.quantidade_insumo, 'insumo_nome', i.nome, 'insumo_unidade', i.unidade,
                'product_id', c.product_id, 'quantidade_produto', c.quantidade_produto, 'produto_nome', p.nome) ORDER BY c.ordem, c.nome)
              FROM complementos c LEFT JOIN ingredients i ON i.id = c.ingredient_id LEFT JOIN products p ON p.id = c.product_id
              WHERE c.grupo_id = g.id), '[]') AS opcoes
     FROM grupos_complementos g WHERE g.tenant_id = $1 AND ($2::uuid IS NULL OR g.id = $2::uuid)
     ORDER BY g.ativo DESC, g.nome`,
    [tenantId, somenteId]
  );
  return rows;
}

function limitesDoGrupo(b, atual = {}) {
  const minimo = b.minimo === undefined ? (atual.minimo ?? 0) : Number(b.minimo);
  const maximo = b.maximo === undefined ? (atual.maximo ?? 1) : Number(b.maximo);
  if (!Number.isInteger(minimo) || minimo < 0) throw new HttpError(400, 'mínimo inválido: use um número inteiro de 0 em diante');
  if (!Number.isInteger(maximo) || maximo < 1) throw new HttpError(400, 'máximo inválido: use um número inteiro de 1 em diante');
  if (maximo < minimo) throw new HttpError(400, 'o máximo não pode ser menor que o mínimo');
  return { minimo, maximo };
}

router.get('/complement-groups', async (req, res) => {
  res.json(await listarGrupos(req.user.tenantId));
});

router.post('/complement-groups', estoque, async (req, res) => {
  const b = req.body || {};
  const nome = texto(b.nome);
  if (nome.length < 2) throw new HttpError(400, 'informe o nome do grupo (ex.: Adicionais)');
  const { minimo, maximo } = limitesDoGrupo(b);
  const dup = await pool.query(`SELECT 1 FROM grupos_complementos WHERE tenant_id = $1 AND lower(nome) = lower($2)`, [req.user.tenantId, nome]);
  if (dup.rows.length) throw new HttpError(409, 'já existe um grupo com este nome');
  const { rows } = await pool.query(
    `INSERT INTO grupos_complementos (tenant_id, nome, minimo, maximo) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.user.tenantId, nome, minimo, maximo]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_grupo_complementos', recurso: 'grupos_complementos', recursoId: rows[0].id, detalhes: { nome, minimo, maximo } });
  res.status(201).json((await listarGrupos(req.user.tenantId, rows[0].id))[0]);
});

router.patch('/complement-groups/:id', estoque, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'grupo inválido');
  const atual = (await pool.query(`SELECT * FROM grupos_complementos WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!atual) throw new HttpError(404, 'grupo não encontrado');
  const b = req.body || {};
  const nome = b.nome === undefined ? atual.nome : texto(b.nome);
  if (nome.length < 2) throw new HttpError(400, 'informe o nome do grupo');
  if (nome.toLowerCase() !== atual.nome.toLowerCase()) {
    const dup = await pool.query(`SELECT 1 FROM grupos_complementos WHERE tenant_id = $1 AND lower(nome) = lower($2) AND id <> $3`, [req.user.tenantId, nome, atual.id]);
    if (dup.rows.length) throw new HttpError(409, 'já existe um grupo com este nome');
  }
  const { minimo, maximo } = limitesDoGrupo(b, atual);
  const ativo = typeof b.ativo === 'boolean' ? b.ativo : atual.ativo;
  await pool.query(`UPDATE grupos_complementos SET nome = $2, minimo = $3, maximo = $4, ativo = $5 WHERE id = $1`, [atual.id, nome, minimo, maximo, ativo]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_grupo_complementos', recurso: 'grupos_complementos', recursoId: atual.id, detalhes: { nome, minimo, maximo, ativo } });
  res.json((await listarGrupos(req.user.tenantId, atual.id))[0]);
});

// Usado em algum pedido/venda? (os itens guardam os complementos escolhidos) -> so desativar.
async function complementoUsado(ids) {
  if (ids.length === 0) return false;
  const filtro = ids.map((id) => JSON.stringify([{ id }]));
  const { rows } = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM order_items WHERE complementos @> ANY($1::jsonb[]))
         OR EXISTS(SELECT 1 FROM sale_items WHERE complementos @> ANY($1::jsonb[])) AS usado`,
    [filtro]
  );
  return rows[0].usado;
}

router.delete('/complement-groups/:id', estoque, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'grupo inválido');
  const g = (await pool.query(`SELECT id, nome FROM grupos_complementos WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!g) throw new HttpError(404, 'grupo não encontrado');
  const ids = (await pool.query(`SELECT id FROM complementos WHERE grupo_id = $1`, [g.id])).rows.map((r) => r.id);
  if (await complementoUsado(ids)) throw new HttpError(409, 'este grupo já foi usado em vendas ou pedidos: desative em vez de excluir');
  await pool.query(`DELETE FROM grupos_complementos WHERE id = $1`, [g.id]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'excluir_grupo_complementos', recurso: 'grupos_complementos', recursoId: g.id, detalhes: { nome: g.nome } });
  res.status(204).end();
});

// ---------- opcoes (complementos) ----------
// Valida a origem da baixa: insumo (com quantidade) OU produto (com quantidade) OU nenhuma.
async function camposDoComplemento(req, b, atual = {}) {
  const nome = b.nome === undefined ? atual.nome : texto(b.nome);
  if (!nome || nome.length < 1) throw new HttpError(400, 'informe o nome do complemento (ex.: Bacon extra)');
  const preco = b.preco === undefined ? Number(atual.preco || 0) : Number(b.preco);
  if (!(preco >= 0)) throw new HttpError(400, 'preço inválido');
  let codigo = b.codigo === undefined ? (atual.codigo || null) : (texto(b.codigo, 60) || null);
  if (codigo) codigo = codigo.toUpperCase();
  const ordem = b.ordem === undefined ? (atual.ordem || 0) : Number(b.ordem) || 0;
  let ingredientId = b.ingredient_id === undefined ? atual.ingredient_id || null : b.ingredient_id || null;
  let productId = b.product_id === undefined ? atual.product_id || null : b.product_id || null;
  if (b.ingredient_id) productId = null;
  if (b.product_id) ingredientId = null;
  let qIns = null;
  let qProd = null;
  if (ingredientId) {
    if (!(req.user.modulos && req.user.modulos.lanchonete)) throw new HttpError(403, 'complemento que baixa insumo precisa do módulo Lanchonete e cozinha');
    await getOwned(pool, 'ingredients', ingredientId, req.user.tenantId, { ativo: true });
    qIns = Number(b.quantidade_insumo === undefined ? atual.quantidade_insumo : b.quantidade_insumo);
    if (!(qIns > 0)) throw new HttpError(400, 'informe quanto do insumo o complemento usa (ex.: 30 g)');
  }
  if (productId) {
    const p = await getOwned(pool, 'products', productId, req.user.tenantId, { ativo: true, columns: 'id, ativo' });
    if ((await pool.query(`SELECT 1 FROM combo_itens WHERE combo_id = $1 LIMIT 1`, [p.id])).rows.length) throw new HttpError(400, 'um combo não pode ser complemento');
    qProd = Number(b.quantidade_produto === undefined ? (atual.quantidade_produto || 1) : b.quantidade_produto);
    if (!(qProd > 0)) throw new HttpError(400, 'quantidade do produto inválida');
  }
  if (codigo) {
    const dup = await pool.query(`SELECT 1 FROM complementos WHERE tenant_id = $1 AND codigo = $2 AND id <> $3`, [req.user.tenantId, codigo, atual.id || '00000000-0000-0000-0000-000000000000']);
    if (dup.rows.length) throw new HttpError(409, `o código ${codigo} já é de outro complemento`);
  }
  return { nome, preco, codigo, ordem, ingredientId, productId, qIns, qProd };
}

router.post('/complement-groups/:id/options', estoque, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'grupo inválido');
  const g = (await pool.query(`SELECT id FROM grupos_complementos WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!g) throw new HttpError(404, 'grupo não encontrado');
  const c = await camposDoComplemento(req, req.body || {});
  const { rows } = await pool.query(
    `INSERT INTO complementos (tenant_id, grupo_id, nome, preco, codigo, ingredient_id, quantidade_insumo, product_id, quantidade_produto, ordem)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [req.user.tenantId, g.id, c.nome, c.preco, c.codigo, c.ingredientId, c.qIns, c.productId, c.qProd, c.ordem]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_complemento', recurso: 'complementos', recursoId: rows[0].id, detalhes: { nome: c.nome, preco: c.preco } });
  res.status(201).json((await listarGrupos(req.user.tenantId, g.id))[0]);
});

router.patch('/complements/:id', estoque, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'complemento inválido');
  const atual = (await pool.query(`SELECT * FROM complementos WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!atual) throw new HttpError(404, 'complemento não encontrado');
  const b = req.body || {};
  const c = await camposDoComplemento(req, b, atual);
  const ativo = typeof b.ativo === 'boolean' ? b.ativo : atual.ativo;
  await pool.query(
    `UPDATE complementos SET nome = $2, preco = $3, codigo = $4, ingredient_id = $5, quantidade_insumo = $6, product_id = $7, quantidade_produto = $8, ordem = $9, ativo = $10 WHERE id = $1`,
    [atual.id, c.nome, c.preco, c.codigo, c.ingredientId, c.qIns, c.productId, c.qProd, c.ordem, ativo]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_complemento', recurso: 'complementos', recursoId: atual.id, detalhes: { nome: c.nome, preco: c.preco, ativo } });
  res.json((await listarGrupos(req.user.tenantId, atual.grupo_id))[0]);
});

router.delete('/complements/:id', estoque, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'complemento inválido');
  const c = (await pool.query(`SELECT id, nome, grupo_id FROM complementos WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!c) throw new HttpError(404, 'complemento não encontrado');
  if (await complementoUsado([c.id])) throw new HttpError(409, 'este complemento já foi usado em vendas ou pedidos: desative em vez de excluir');
  await pool.query(`DELETE FROM complementos WHERE id = $1`, [c.id]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'excluir_complemento', recurso: 'complementos', recursoId: c.id, detalhes: { nome: c.nome } });
  res.status(204).end();
});

// ---------- grupos de um produto ----------
router.put('/products/:id/complement-groups', estoque, async (req, res) => {
  const p = await getOwned(pool, 'products', req.params.id, req.user.tenantId, { columns: 'id, nome' });
  const ids = Array.isArray((req.body || {}).grupos) ? [...new Set(req.body.grupos)] : null;
  if (!ids || ids.some((id) => !isUuid(id))) throw new HttpError(400, 'informe a lista de grupos');
  if (ids.length) {
    const ok = await pool.query(`SELECT id FROM grupos_complementos WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tenantId, ids]);
    if (ok.rows.length !== ids.length) throw new HttpError(400, 'grupo de complementos inválido');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM produto_grupos WHERE product_id = $1`, [p.id]);
    for (let i = 0; i < ids.length; i++) {
      await client.query(`INSERT INTO produto_grupos (tenant_id, product_id, grupo_id, ordem) VALUES ($1, $2, $3, $4)`, [req.user.tenantId, p.id, ids[i], i]);
    }
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'grupos_do_produto', recurso: 'products', recursoId: p.id, detalhes: { grupos: ids.length } });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, grupos: ids });
});

// ---------- combo ----------
// Salva os componentes do combo (lista vazia = deixa de ser combo). Usado pela rota e pelo cadastro do produto.
async function salvarCombo(client, user, productId, itens) {
  const lista = (Array.isArray(itens) ? itens : []).map((i) => ({ product_id: i && i.product_id, quantidade: Number(i && i.quantidade) }));
  const p = (await client.query(`SELECT id, nome FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [productId, user.tenantId])).rows[0];
  if (!p) throw new HttpError(404, 'produto não encontrado');
  if (lista.length > 0) {
    if ((await client.query(`SELECT 1 FROM product_ingredients WHERE product_id = $1 LIMIT 1`, [p.id])).rows.length) {
      throw new HttpError(400, 'este produto tem ficha técnica (lanche): um combo é feito de produtos, não de insumos');
    }
    const saldo = (await client.query(`SELECT COALESCE(SUM(saldo), 0) AS s FROM stock_balances WHERE product_id = $1`, [p.id])).rows[0].s;
    if (Number(saldo) !== 0) throw new HttpError(400, 'zere o estoque deste produto antes de transformá-lo em combo (o combo não tem estoque próprio)');
    const ids = new Set();
    for (const i of lista) {
      if (!isUuid(i.product_id) || !(i.quantidade > 0)) throw new HttpError(400, 'cada item do combo precisa de produto e quantidade (>0)');
      if (i.product_id === p.id) throw new HttpError(400, 'o combo não pode conter ele mesmo');
      if (ids.has(i.product_id)) throw new HttpError(400, 'produto repetido no combo: ajuste a quantidade');
      ids.add(i.product_id);
    }
    const comps = await client.query(
      `SELECT p.id, p.nome, p.ativo, p.unidade, p.preco_custo, EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id) AS e_combo
       FROM products p WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
      [user.tenantId, [...ids]]
    );
    if (comps.rows.length !== ids.size) throw new HttpError(400, 'produto do combo não encontrado');
    for (const c of comps.rows) {
      if (!c.ativo) throw new HttpError(400, `"${c.nome}" está inativo`);
      if (c.e_combo) throw new HttpError(400, `"${c.nome}" já é um combo: combo dentro de combo não é permitido`);
    }
    // Um produto que ja e componente de outro combo nao pode virar combo.
    if ((await client.query(`SELECT 1 FROM combo_itens WHERE product_id = $1 LIMIT 1`, [p.id])).rows.length) {
      throw new HttpError(400, 'este produto faz parte de outro combo e não pode virar combo');
    }
    await client.query(`DELETE FROM combo_itens WHERE combo_id = $1`, [p.id]);
    for (const i of lista) await client.query(`INSERT INTO combo_itens (tenant_id, combo_id, product_id, quantidade) VALUES ($1, $2, $3, $4)`, [user.tenantId, p.id, i.product_id, i.quantidade]);
    // Custo do combo = soma dos custos dos componentes.
    const custo = lista.reduce((s, i) => s + Number(comps.rows.find((c) => c.id === i.product_id).preco_custo) * i.quantidade, 0);
    await client.query(`UPDATE products SET preco_custo = $2 WHERE id = $1`, [p.id, Number(custo.toFixed(4))]);
  } else {
    await client.query(`DELETE FROM combo_itens WHERE combo_id = $1`, [p.id]);
  }
  await logAudit(client, { tenantId: user.tenantId, usuarioId: user.id, acao: 'combo_do_produto', recurso: 'products', recursoId: p.id, detalhes: { itens: lista.length } });
  return lista;
}

router.put('/products/:id/combo', estoque, async (req, res) => {
  await getOwned(pool, 'products', req.params.id, req.user.tenantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itens = await salvarCombo(client, req.user, req.params.id, (req.body || {}).itens);
    await client.query('COMMIT');
    res.json({ ok: true, itens });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = { router, salvarCombo };
