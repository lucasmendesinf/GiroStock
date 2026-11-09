// Produto que vira insumo na transferencia: o oleo de 1 L vendido inteiro na distribuidora vira 1.000 ML de insumo
// ao ser transferido para a lanchonete (onde e usado por medida nas receitas).
// 1 <unidade do produto> = <fator> <unidade do insumo>. So a TRANSFERENCIA converte (nao ha "desconverter": correcao por balanco).
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const { logAudit } = require('../utils/audit');
const { ensureIngredientBalance, recalcularCustoProdutos } = require('./insumos');

const UNIDADES_INSUMO = ['G', 'KG', 'ML', 'L', 'UN', 'Fatia'];
// Compatibilidade basica produto -> insumo (UN e CX exigem fator explicito: o sistema nao adivinha o conteudo).
const COMPATIVEIS = { L: ['ML', 'L'], KG: ['G', 'KG'], UN: ['UN', 'Fatia', 'G', 'ML'], CX: ['UN', 'Fatia', 'G', 'ML', 'KG', 'L'] };
const MODOS = ['perguntar', 'sempre'];

async function lerConversao(db, tenantId, productId) {
  const { rows } = await db.query(
    `SELECT c.ingredient_id, c.fator, c.modo, c.ativo, i.nome AS ingredient_nome, i.unidade AS ingredient_unidade, i.custo_unitario,
            p.preco_custo
       FROM produto_conversoes c
       JOIN ingredients i ON i.id = c.ingredient_id
       JOIN products p ON p.id = c.product_id
      WHERE c.tenant_id = $1 AND c.product_id = $2`,
    [tenantId, productId]
  );
  if (rows.length === 0) return null;
  const c = rows[0];
  const lojas = (await db.query(`SELECT location_id FROM produto_conversao_lojas WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId])).rows.map((r) => r.location_id);
  const fator = Number(c.fator);
  return {
    ativo: c.ativo, ingredient_id: c.ingredient_id, ingredient_nome: c.ingredient_nome, ingredient_unidade: c.ingredient_unidade,
    fator, modo: c.modo, lojas,
    custo_unitario_insumo: Number(c.custo_unitario),
    custo_calculado: fator > 0 ? Number((Number(c.preco_custo) / fator).toFixed(6)) : null, // custo do produto ÷ fator
  };
}

// Grava (ou remove, com c === null) a conversao do produto. client ja em BEGIN. Devolve { antes, depois } para a auditoria.
// c: { ativo?, ingredient_id | criar_insumo: { nome, unidade }, fator, modo, lojas: [location_id] }
async function gravarConversao(client, user, productId, c) {
  const tenantId = user.tenantId;
  const antes = await lerConversao(client, tenantId, productId);
  if (c === null) {
    await client.query(`DELETE FROM produto_conversao_lojas WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
    await client.query(`DELETE FROM produto_conversoes WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
    return { antes, depois: null };
  }
  if (typeof c !== 'object') throw new HttpError(400, 'conversão inválida');
  if (user.modulos && user.modulos.lanchonete === false) {
    throw new HttpError(403, 'O módulo Lanchonete e cozinha não faz parte do plano da sua empresa: sem insumos, o produto não pode virar insumo');
  }
  const prod = (await client.query(`SELECT id, nome, unidade, preco_custo FROM products WHERE id = $1 AND tenant_id = $2`, [productId, tenantId])).rows[0];
  if (!prod) throw new HttpError(404, 'produto não encontrado');
  if ((await client.query(`SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`, [productId, tenantId])).rows.length) {
    throw new HttpError(400, `"${prod.nome}" tem ficha técnica e não tem estoque próprio para converter`);
  }
  if ((await client.query(`SELECT 1 FROM combo_itens WHERE combo_id = $1 LIMIT 1`, [productId])).rows.length) {
    throw new HttpError(400, `"${prod.nome}" é um combo e não tem estoque próprio para converter`);
  }
  const fator = Number(c.fator);
  if (!(fator > 0) || fator > 1e7) throw new HttpError(400, 'informe o fator (quanto de insumo vale 1 unidade do produto), maior que zero');
  if (Math.round(fator * 10000) / 10000 !== fator) throw new HttpError(400, 'o fator aceita até 4 casas decimais');
  const modo = c.modo === undefined ? 'perguntar' : c.modo;
  if (!MODOS.includes(modo)) throw new HttpError(400, 'modo inválido (perguntar ou sempre)');
  if (!Array.isArray(c.lojas) || c.lojas.length === 0) throw new HttpError(400, 'marque ao menos uma loja em que o produto vira insumo');
  const lojas = [...new Set(c.lojas)];
  for (const l of lojas) if (!isUuid(l)) throw new HttpError(400, 'loja inválida');
  const donas = await client.query(`SELECT id FROM locations WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, lojas]);
  if (donas.rows.length !== lojas.length) throw new HttpError(400, 'uma das lojas não foi encontrada');

  // insumo: existente ou criado a partir do produto
  let ingredientId = c.ingredient_id;
  let insumo;
  if (!ingredientId && c.criar_insumo) {
    const nome = String(c.criar_insumo.nome || prod.nome).trim();
    const unidade = String(c.criar_insumo.unidade || '');
    if (nome.length < 3) throw new HttpError(400, 'nome do insumo deve ter no mínimo 3 caracteres');
    if (!UNIDADES_INSUMO.includes(unidade)) throw new HttpError(400, 'unidade do insumo inválida');
    if (!(COMPATIVEIS[prod.unidade] || []).includes(unidade)) throw new HttpError(400, `um produto em ${prod.unidade} não vira insumo em ${unidade}`);
    const custoUn = Number((Number(prod.preco_custo) / fator).toFixed(6));
    const novo = await client.query(
      `INSERT INTO ingredients (tenant_id, nome, unidade, custo_unitario) VALUES ($1, $2, $3, $4) RETURNING id, nome, unidade`,
      [tenantId, nome, unidade, custoUn]
    );
    ingredientId = novo.rows[0].id;
    insumo = novo.rows[0];
  } else {
    if (!isUuid(ingredientId)) throw new HttpError(400, 'escolha o insumo ou peça para criá-lo a partir do produto');
    insumo = (await client.query(`SELECT id, nome, unidade, ativo FROM ingredients WHERE id = $1 AND tenant_id = $2`, [ingredientId, tenantId])).rows[0];
    if (!insumo) throw new HttpError(404, 'insumo não encontrado');
    if (!insumo.ativo) throw new HttpError(400, `o insumo "${insumo.nome}" está desativado`);
    if (!(COMPATIVEIS[prod.unidade] || []).includes(insumo.unidade)) {
      throw new HttpError(400, `um produto em ${prod.unidade} não vira insumo em ${insumo.unidade} (use: ${(COMPATIVEIS[prod.unidade] || []).join(', ')})`);
    }
  }
  // sem ciclo: o insumo nao pode estar na ficha do proprio produto
  if ((await client.query(`SELECT 1 FROM product_ingredients WHERE product_id = $1 AND ingredient_id = $2`, [productId, ingredientId])).rows.length) {
    throw new HttpError(400, 'o insumo não pode fazer parte da ficha técnica do próprio produto');
  }

  await client.query(
    `INSERT INTO produto_conversoes (tenant_id, product_id, ingredient_id, fator, modo, ativo, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (product_id) DO UPDATE SET ingredient_id = EXCLUDED.ingredient_id, fator = EXCLUDED.fator, modo = EXCLUDED.modo, ativo = EXCLUDED.ativo, atualizado_em = now()`,
    [tenantId, productId, ingredientId, fator, modo, c.ativo !== false]
  );
  await client.query(`DELETE FROM produto_conversao_lojas WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
  for (const l of lojas) {
    await client.query(`INSERT INTO produto_conversao_lojas (product_id, location_id, tenant_id) VALUES ($1, $2, $3)`, [productId, l, tenantId]);
  }
  return { antes, depois: await lerConversao(client, tenantId, productId) };
}

// Na transferencia: devolve a conversao a aplicar ({ ...conversao, ingredient_id... }) ou null (transferencia comum).
// converter: o valor de converter_em_insumo do corpo (true | false | undefined).
async function conversaoDaTransferencia(db, user, productId, destinoId, converter) {
  const semModulo = user.modulos && user.modulos.lanchonete === false;
  const { rows } = semModulo ? { rows: [] } : await db.query(
    `SELECT c.ingredient_id, c.fator, c.modo, i.nome AS ingredient_nome, i.unidade AS ingredient_unidade
       FROM produto_conversoes c
       JOIN produto_conversao_lojas l ON l.product_id = c.product_id AND l.location_id = $3
       JOIN ingredients i ON i.id = c.ingredient_id AND i.ativo
      WHERE c.tenant_id = $1 AND c.product_id = $2 AND c.ativo`,
    [user.tenantId, productId, destinoId]
  );
  if (rows.length === 0) {
    if (converter === true) throw new HttpError(400, 'este produto não vira insumo neste destino: remova converter_em_insumo ou escolha outra loja');
    return null;
  }
  const c = { ...rows[0], fator: Number(rows[0].fator) };
  if (c.modo === 'perguntar') {
    if (typeof converter !== 'boolean') throw new HttpError(400, 'informe se converte em insumo (converter_em_insumo: true ou false)');
    return converter ? c : null;
  }
  if (converter === false) throw new HttpError(400, 'neste destino o produto sempre vira insumo (conversão obrigatória)');
  return c;
}

// Aplica a conversao dentro da transacao da transferencia: soma qtd x fator no insumo do destino e atualiza o custo
// (mesma regra da entrada de insumo: o custo do insumo passa a ser o da entrada = custo do produto ÷ fator).
async function aplicarConversao(client, user, { conv, productId, productNome, qtd, destinoId, movimentoId, custoProduto }) {
  const tenantId = user.tenantId;
  const qtdInsumo = Number((qtd * conv.fator).toFixed(3));
  if (!(qtdInsumo > 0)) throw new HttpError(400, 'a quantidade é pequena demais para converter em insumo');
  const atual = (await client.query(`SELECT custo_unitario FROM ingredients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [conv.ingredient_id, tenantId])).rows[0];
  await ensureIngredientBalance(client, tenantId, conv.ingredient_id, destinoId);
  const antes = Number((await client.query(
    `SELECT saldo FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2 AND tenant_id = $3 FOR UPDATE`, [conv.ingredient_id, destinoId, tenantId]
  )).rows[0].saldo);
  await client.query(`UPDATE ingredient_balances SET saldo = saldo + $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`, [qtdInsumo, conv.ingredient_id, destinoId, tenantId]);
  const custoAtual = Number(atual.custo_unitario);
  const novoCusto = Number(custoProduto) > 0 ? Number((Number(custoProduto) / conv.fator).toFixed(6)) : custoAtual;
  if (novoCusto !== custoAtual) {
    await client.query(`UPDATE ingredients SET custo_unitario = $1 WHERE id = $2 AND tenant_id = $3`, [novoCusto, conv.ingredient_id, tenantId]);
  }
  const acimaVenda = await recalcularCustoProdutos(client, tenantId, conv.ingredient_id);
  await logAudit(client, {
    tenantId, usuarioId: user.id, acao: 'entrada_conversao', recurso: 'ingredients', recursoId: conv.ingredient_id,
    detalhes: {
      quantidade: qtdInsumo, location_id: destinoId, product_id: productId, produto_nome: productNome, produto_quantidade: qtd, fator: conv.fator,
      stock_movement_id: movimentoId, custo_unitario_anterior: custoAtual, custo_unitario_novo: novoCusto,
      motivo: `Transferência com conversão em insumo (${productNome})`, saldo_anterior: antes, saldo_novo: Number((antes + qtdInsumo).toFixed(3)),
    },
  });
  return { ingredient_id: conv.ingredient_id, ingredient_nome: conv.ingredient_nome, unidade: conv.ingredient_unidade, quantidade: qtdInsumo, saldo_anterior: antes, saldo_novo: Number((antes + qtdInsumo).toFixed(3)), custo_unitario: novoCusto, produtos_custo_acima_venda: acimaVenda };
}

// Previa para a tela de transferencia (nao grava): o que acontece ao converter.
async function previaDaConversao(db, user, productId, destinoId, quantidade) {
  const semModulo = user.modulos && user.modulos.lanchonete === false;
  if (semModulo) return { aplica: false };
  const { rows } = await db.query(
    `SELECT c.ingredient_id, c.fator, c.modo, i.nome AS ingredient_nome, i.unidade AS ingredient_unidade, i.custo_unitario, p.preco_custo
       FROM produto_conversoes c
       JOIN produto_conversao_lojas l ON l.product_id = c.product_id AND l.location_id = $3
       JOIN ingredients i ON i.id = c.ingredient_id AND i.ativo
       JOIN products p ON p.id = c.product_id
      WHERE c.tenant_id = $1 AND c.product_id = $2 AND c.ativo`,
    [user.tenantId, productId, destinoId]
  );
  if (rows.length === 0) return { aplica: false };
  const c = rows[0];
  const fator = Number(c.fator);
  const saldo = (await db.query(`SELECT saldo FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2 AND tenant_id = $3`, [c.ingredient_id, destinoId, user.tenantId])).rows[0];
  const antes = saldo ? Number(saldo.saldo) : 0;
  const q = Number(quantidade);
  const qtdInsumo = q > 0 ? Number((q * fator).toFixed(3)) : 0;
  return {
    aplica: true, modo: c.modo, ingredient_id: c.ingredient_id, ingredient_nome: c.ingredient_nome, unidade: c.ingredient_unidade, fator,
    quantidade_insumo: qtdInsumo, saldo_insumo_antes: antes, saldo_insumo_depois: Number((antes + qtdInsumo).toFixed(3)),
    custo_unitario_antes: Number(c.custo_unitario), custo_unitario_depois: Number(c.preco_custo) > 0 ? Number((Number(c.preco_custo) / fator).toFixed(6)) : Number(c.custo_unitario),
  };
}

module.exports = { lerConversao, gravarConversao, conversaoDaTransferencia, aplicarConversao, previaDaConversao, COMPATIVEIS, UNIDADES_INSUMO };
