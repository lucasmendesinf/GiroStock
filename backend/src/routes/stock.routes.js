const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess, restrictedLocation } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { filtroPeriodo, paginacao } = require('../utils/query');

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

// Valida um movimento (fora da transacao) e devolve os dados normalizados.
// Usado pela movimentacao avulsa e pela entrada por nota (varios itens).
async function prepararMovimento(db, user, dados) {
  const { product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo } = dados || {};
  const qtd = Number(quantidade);

  if (!product_id || !tipo || !(qtd > 0) || !motivo) {
    throw new HttpError(400, 'product_id, tipo, quantidade (>0) e motivo são obrigatórios');
  }
  if (!['entrada', 'saida', 'transferencia'].includes(tipo)) throw new HttpError(400, 'tipo inválido');
  if (tipo === 'entrada' && !location_destino_id) throw new HttpError(400, 'location_destino_id é obrigatório para entrada');
  if (tipo === 'saida' && !location_origem_id) throw new HttpError(400, 'location_origem_id é obrigatório para saída');
  if (tipo === 'transferencia') {
    if (!location_origem_id || !location_destino_id) {
      throw new HttpError(400, 'location_origem_id e location_destino_id são obrigatórios para transferência');
    }
    if (location_origem_id === location_destino_id) {
      throw new HttpError(400, 'local de origem deve ser diferente do local de destino');
    }
  }
  const origemId = tipo === 'entrada' ? null : location_origem_id;
  const destinoId = tipo === 'saida' ? null : location_destino_id;

  // Produto e locais precisam ser da empresa do usuario (e os locais, ativos).
  const product = await getOwned(db, 'products', product_id, user.tenantId, {
    columns: 'id, nome, unidade, ativo, supplier_id, preco_custo, preco_venda',
  });
  if (tipo === 'entrada' && !product.ativo) throw new HttpError(400, `"${product.nome}" está inativo e não recebe entradas; reative-o antes`);
  if (!isQuantidadeValidaParaUnidade(qtd, product.unidade)) {
    throw new HttpError(400, `"${product.nome}" e controlado em ${product.unidade} e so aceita quantidade inteira`);
  }
  const ficha = await db.query(
    `SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`,
    [product_id, user.tenantId]
  );
  if (ficha.rows.length > 0) {
    throw new HttpError(400, `"${product.nome}" tem ficha técnica e não tem estoque próprio; movimente os insumos dele`);
  }
  if (origemId) await getOwnedLocation(db, origemId, user.tenantId);
  if (destinoId) await getOwnedLocation(db, destinoId, user.tenantId);

  // Usuario vinculado a um local so movimenta o proprio local
  // (na transferencia, ele envia a partir do local dele).
  if (tipo === 'entrada') assertLocationAccess(user, destinoId, 'lançar entrada neste local');
  else assertLocationAccess(user, origemId, 'movimentar estoque deste local');

  // Dados da compra (somente entrada): fornecedor, custo unitario e nota fiscal.
  let supplierId = null;
  let custoUnitario = null;
  let documentoFiscal = null;
  if (tipo === 'entrada') {
    if (dados.supplier_id) {
      await getOwned(db, 'suppliers', dados.supplier_id, user.tenantId, { ativo: true, columns: 'id, ativo' });
      supplierId = dados.supplier_id;
    }
    const custoInformado = dados.custo_unitario;
    if (custoInformado !== undefined && custoInformado !== null && custoInformado !== '') {
      custoUnitario = Number(custoInformado);
      if (!(custoUnitario > 0)) throw new HttpError(400, `custo unitário de "${product.nome}" deve ser maior que zero`);
    }
    documentoFiscal = textoOpcional(dados.documento_fiscal);
  }

  return { product, tipo, qtd, origemId, destinoId, motivo, supplierId, custoUnitario, documentoFiscal };
}

// Aplica um movimento ja validado dentro de uma transacao aberta.
async function aplicarMovimento(client, user, mov) {
  const { product, tipo, qtd, origemId, destinoId, motivo, supplierId, custoUnitario, documentoFiscal } = mov;
  const productId = product.id;

  // Ordem de travas igual a da venda (produto -> saldos), evitando deadlock entre as duas.
  const travado = await client.query(
    `SELECT p.preco_custo, p.preco_venda, p.supplier_id,
            (SELECT COALESCE(SUM(saldo), 0) FROM stock_balances WHERE product_id = p.id AND tenant_id = p.tenant_id) AS saldo_total
     FROM products p WHERE p.id = $1 AND p.tenant_id = $2 FOR UPDATE OF p`,
    [productId, user.tenantId]
  );
  const atual = travado.rows[0];

  if (destinoId) await ensureBalanceRow(client, user.tenantId, productId, destinoId);
  const saldos = await lockBalances(client, user.tenantId, productId, [origemId, destinoId].filter(Boolean));

  if (origemId) {
    const saldoOrigem = saldos.has(origemId) ? saldos.get(origemId) : 0;
    if (saldoOrigem < qtd) {
      throw new HttpError(400, `saldo insuficiente de "${product.nome}" no local de origem (disponível: ${saldoOrigem}, solicitado: ${qtd})`);
    }
  }

  let custoMedio = null;
  if (tipo === 'entrada' && custoUnitario !== null) {
    // Custo medio ponderado: (saldo atual x custo atual + entrada x custo da entrada) / saldo final.
    const saldoTotal = Math.max(0, Number(atual.saldo_total));
    const custoAtual = Number(atual.preco_custo);
    custoMedio = Number(((saldoTotal * custoAtual + qtd * custoUnitario) / (saldoTotal + qtd)).toFixed(2));
    const precoVenda = Number(atual.preco_venda);
    if (custoMedio >= precoVenda) {
      throw new HttpError(400,
        `com esta entrada o custo médio de "${product.nome}" ficaria R$ ${custoMedio.toFixed(2).replace('.', ',')}, maior ou igual ao preço de venda (R$ ${precoVenda.toFixed(2).replace('.', ',')}). Atualize o preço de venda do produto antes.`);
    }
    await client.query(`UPDATE products SET preco_custo = $1 WHERE id = $2 AND tenant_id = $3`, [custoMedio, productId, user.tenantId]);
  }

  if (origemId) {
    await client.query(
      `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, productId, origemId, user.tenantId]
    );
  }
  if (destinoId) {
    await client.query(
      `UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [qtd, productId, destinoId, user.tenantId]
    );
  }

  // Comprar de um fornecedor ja o vincula ao produto.
  if (supplierId) {
    await client.query(
      `INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, supplier_id) DO NOTHING`,
      [user.tenantId, productId, supplierId]
    );
    if (!atual.supplier_id) {
      await client.query(`UPDATE products SET supplier_id = $1 WHERE id = $2 AND tenant_id = $3`, [supplierId, productId, user.tenantId]);
    }
  }

  const { rows } = await client.query(
    `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id,
                                  supplier_id, custo_unitario, documento_fiscal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, supplier_id, custo_unitario, documento_fiscal, criado_em`,
    [user.tenantId, productId, tipo, qtd, origemId, destinoId, motivo, user.id, supplierId, custoUnitario, documentoFiscal]
  );

  await logAudit(client, {
    tenantId: user.tenantId,
    usuarioId: user.id,
    acao: tipo,
    recurso: 'stock_movements',
    recursoId: rows[0].id,
    detalhes: {
      product_id: productId, quantidade: qtd, supplier_id: supplierId, custo_unitario: custoUnitario,
      documento_fiscal: documentoFiscal,
      ...(custoMedio !== null ? { preco_custo_anterior: Number(atual.preco_custo), preco_custo_novo: custoMedio } : {}),
    },
  });

  return { ...rows[0], preco_custo_atualizado: custoMedio };
}

router.post('/stock-movements', requireArea('Estoque'), async (req, res) => {
  const mov = await prepararMovimento(pool, req.user, req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await aplicarMovimento(client, req.user, mov);
    await client.query('COMMIT');
    res.status(201).json(resultado);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Balanco de produto: substitui o saldo de uma loja pela contagem fisica e guarda a diferenca
// no historico (movimento tipo 'balanco': quantidade = |diferenca|, com saldo anterior e novo).
// Corpo: { location_id, novo_saldo, motivo }
router.post('/products/:id/stock-adjustment', requireArea('Estoque'), async (req, res) => {
  const { location_id, novo_saldo } = req.body || {};
  const motivo = textoOpcional(req.body && req.body.motivo);
  if (!location_id) throw new HttpError(400, 'location_id é obrigatório');
  if (novo_saldo === undefined || novo_saldo === null || novo_saldo === '' || !(Number(novo_saldo) >= 0)) {
    throw new HttpError(400, 'novo_saldo deve ser um número válido (0 ou mais)');
  }
  if (!motivo || motivo.length < 3) throw new HttpError(400, 'motivo é obrigatório (mínimo 3 caracteres)');
  const novoSaldo = Number(novo_saldo);

  const product = await getOwned(pool, 'products', req.params.id, req.user.tenantId, { columns: 'id, nome, unidade' });
  if (!isQuantidadeValidaParaUnidade(novoSaldo, product.unidade)) {
    throw new HttpError(400, `"${product.nome}" é controlado em ${product.unidade} e só aceita quantidade inteira`);
  }
  const ficha = await pool.query(
    `SELECT 1 FROM product_ingredients WHERE product_id = $1 AND tenant_id = $2 LIMIT 1`,
    [product.id, req.user.tenantId]
  );
  if (ficha.rows.length > 0) {
    throw new HttpError(400, `"${product.nome}" tem ficha técnica e não tem estoque próprio; ajuste os insumos dele`);
  }
  await getOwnedLocation(pool, location_id, req.user.tenantId);
  assertLocationAccess(req.user, location_id, 'ajustar o estoque deste local');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Mesma ordem de travas das demais operacoes (produto -> saldos).
    await client.query(`SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [product.id, req.user.tenantId]);
    await ensureBalanceRow(client, req.user.tenantId, product.id, location_id);
    const saldos = await lockBalances(client, req.user.tenantId, product.id, [location_id]);
    const anterior = saldos.has(location_id) ? saldos.get(location_id) : 0;
    const diferenca = Number((novoSaldo - anterior).toFixed(3));
    if (diferenca === 0) throw new HttpError(400, 'a contagem é igual ao saldo atual; não há o que ajustar');

    await client.query(
      `UPDATE stock_balances SET saldo = $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
      [novoSaldo, product.id, location_id, req.user.tenantId]
    );
    const { rows } = await client.query(
      `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id,
                                    saldo_anterior, saldo_novo)
       VALUES ($1, $2, 'balanco', $3, $4, $4, $5, $6, $7, $8)
       RETURNING id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, saldo_anterior, saldo_novo, criado_em`,
      [req.user.tenantId, product.id, Math.abs(diferenca), location_id, motivo, req.user.id, anterior, novoSaldo]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'balanco',
      recurso: 'stock_movements',
      recursoId: rows[0].id,
      detalhes: { product_id: product.id, location_id, saldo_anterior: anterior, saldo_novo: novoSaldo, diferenca, motivo },
    });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], diferenca });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Nota ja lancada? Mesmo numero e (mesmo fornecedor, ou algum dos dois sem fornecedor informado).
async function notaJaLancada(db, tenantId, numero, supplierId) {
  const { rows } = await db.query(
    `SELECT pn.criado_em, s.nome AS supplier_nome FROM purchase_notes pn
     LEFT JOIN suppliers s ON s.id = pn.supplier_id
     WHERE pn.tenant_id = $1 AND lower(btrim(pn.numero)) = lower(btrim($2))
       AND (pn.supplier_id IS NULL OR $3::uuid IS NULL OR pn.supplier_id = $3::uuid)
     ORDER BY pn.criado_em LIMIT 1`,
    [tenantId, numero, supplierId || null]
  );
  return rows[0] || null;
}

function erroNotaDuplicada(numero, nota) {
  const quando = new Date(nota.criado_em).toLocaleDateString('pt-BR');
  return new HttpError(409, `a nota ${numero} já foi lançada no estoque em ${quando}${nota.supplier_nome ? ` (${nota.supplier_nome})` : ''}; não é possível lançar a mesma nota duas vezes`);
}

router.get('/purchase-notes/check', requireArea('Estoque'), async (req, res) => {
  const numero = textoOpcional(req.query.numero);
  if (!numero) return res.json({ duplicada: false });
  const nota = await notaJaLancada(pool, req.user.tenantId, numero, req.query.supplier_id || null);
  res.json(nota ? { duplicada: true, em: nota.criado_em, fornecedor: nota.supplier_nome } : { duplicada: false });
});

// Registra uma nota (usada quando a nota so tem insumos, que nao passam por /stock-entries).
router.post('/purchase-notes', requireArea('Estoque'), async (req, res) => {
  const numero = textoOpcional(req.body && req.body.numero);
  if (!numero) throw new HttpError(400, 'numero da nota é obrigatório');
  const supplierId = (req.body && req.body.supplier_id) || null;
  const nota = await notaJaLancada(pool, req.user.tenantId, numero, supplierId);
  if (nota) throw erroNotaDuplicada(numero, nota);
  await pool.query(`INSERT INTO purchase_notes (tenant_id, numero, supplier_id, usuario_id) VALUES ($1, $2, $3, $4)`,
    [req.user.tenantId, numero, supplierId, req.user.id]);
  res.status(201).json({ ok: true });
});

// Entrada por nota: varios produtos de uma compra lancados de uma vez (tudo ou nada).
// Corpo: { location_id, supplier_id?, documento_fiscal?, motivo?, itens: [{ product_id, quantidade, custo_unitario? }] }
router.post('/stock-entries', requireArea('Estoque'), async (req, res) => {
  const { location_id, supplier_id, documento_fiscal, itens } = req.body || {};
  if (!location_id) throw new HttpError(400, 'location_id (local que recebe a mercadoria) é obrigatório');
  if (!Array.isArray(itens) || itens.length === 0) throw new HttpError(400, 'informe ao menos um item na nota');
  if (itens.length > 300) throw new HttpError(400, 'uma nota pode ter no máximo 300 itens');
  const doc = textoOpcional(documento_fiscal);
  if (doc) {
    const jaLancada = await notaJaLancada(pool, req.user.tenantId, doc, supplier_id || null);
    if (jaLancada) throw erroNotaDuplicada(doc, jaLancada);
  }
  const motivo = textoOpcional(req.body.motivo) || (doc ? `Entrada da nota ${doc}` : 'Entrada por nota');

  const preparados = [];
  for (const [i, item] of itens.entries()) {
    try {
      preparados.push(await prepararMovimento(pool, req.user, {
        tipo: 'entrada',
        product_id: item && item.product_id,
        quantidade: item && item.quantidade,
        custo_unitario: item && item.custo_unitario,
        location_destino_id: location_id,
        supplier_id,
        documento_fiscal: doc,
        motivo,
      }));
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, `item ${i + 1}: ${err.message}`);
      throw err;
    }
  }
  // Mesma ordem de travas das vendas (por produto), evitando deadlock.
  preparados.sort((a, b) => (a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movimentos = [];
    for (const mov of preparados) movimentos.push(await aplicarMovimento(client, req.user, mov));
    if (doc) {
      await client.query(`INSERT INTO purchase_notes (tenant_id, numero, supplier_id, usuario_id) VALUES ($1, $2, $3, $4)`,
        [req.user.tenantId, doc, supplier_id || null, req.user.id]);
    }
    await client.query('COMMIT');
    const valorTotal = preparados.reduce((soma, m) => soma + (m.custoUnitario || 0) * m.qtd, 0);
    res.status(201).json({ itens: movimentos.length, valor_total: Number(valorTotal.toFixed(2)), movimentos });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Historico de movimentacoes com filtros e paginacao.
// Filtros: product_id, location_id, supplier_id, tipo, data_inicio, data_fim (AAAA-MM-DD), limit, offset.
router.get('/stock-movements', requireArea('Estoque'), async (req, res) => {
  const { product_id, location_id, supplier_id, tipo } = req.query;
  const params = [req.user.tenantId];
  let where = 'TRUE';
  if (product_id) {
    params.push(product_id);
    where += ` AND m.item_id = $${params.length}::text`;
  }
  if (supplier_id) {
    params.push(supplier_id);
    where += ` AND m.supplier_id = $${params.length}`;
  }
  if (tipo) {
    params.push(tipo);
    where += ` AND m.tipo = $${params.length}`;
  }
  // Usuario vinculado a um local so ve as movimentacoes que tocam o local dele.
  const local = restrictedLocation(req.user) || location_id;
  if (local) {
    params.push(local);
    where += ` AND (m.location_origem_id = $${params.length} OR m.location_destino_id = $${params.length})`;
  }
  where += filtroPeriodo('m.criado_em', req.query, params);
  const { limit, offset } = paginacao(req.query, 50, 500);

  // Movimentacoes de produtos (stock_movements) + de insumos (entradas/saidas/transferencias/balancos
  // gravados na auditoria e o consumo por vendas), numa lista unica.
  const base = `
    WITH m AS (
      SELECT sm.id::text AS id, 'produto' AS origem, sm.product_id::text AS item_id, p.nome AS item_nome, p.unidade,
             sm.tipo::text AS tipo, sm.quantidade, sm.location_origem_id, sm.location_destino_id, sm.motivo,
             sm.usuario_id, sm.supplier_id, sm.custo_unitario, sm.documento_fiscal, sm.sale_id,
             sm.saldo_anterior, sm.saldo_novo, sm.criado_em
      FROM stock_movements sm JOIN products p ON p.id = sm.product_id
      WHERE sm.tenant_id = $1
      UNION ALL
      SELECT al.id::text, 'insumo', al.recurso_id::text, i.nome, i.unidade,
             CASE al.acao WHEN 'entrada_estoque' THEN 'entrada' WHEN 'saida_estoque' THEN 'saida'
                          WHEN 'transferencia' THEN 'transferencia' ELSE 'balanco' END,
             CASE WHEN al.acao = 'balanco_estoque' THEN abs((al.detalhes->>'diferenca')::numeric)
                  ELSE (al.detalhes->>'quantidade')::numeric END,
             CASE al.acao WHEN 'saida_estoque' THEN NULLIF(al.detalhes->>'location_id', '')::uuid
                          WHEN 'transferencia' THEN NULLIF(al.detalhes->>'location_origem_id', '')::uuid END,
             CASE al.acao WHEN 'entrada_estoque' THEN NULLIF(al.detalhes->>'location_id', '')::uuid
                          WHEN 'balanco_estoque' THEN NULLIF(al.detalhes->>'location_id', '')::uuid
                          WHEN 'transferencia' THEN NULLIF(al.detalhes->>'location_destino_id', '')::uuid END,
             COALESCE(al.detalhes->>'motivo', CASE al.acao WHEN 'entrada_estoque' THEN 'Entrada de insumo' END),
             al.usuario_id, NULLIF(al.detalhes->>'supplier_id', '')::uuid,
             CASE WHEN al.acao = 'entrada_estoque' AND COALESCE((al.detalhes->>'custo_total')::numeric, 0) > 0
                  THEN (al.detalhes->>'custo_total')::numeric / NULLIF((al.detalhes->>'quantidade')::numeric, 0) END,
             NULLIF(al.detalhes->>'documento_fiscal', ''), NULL::uuid,
             (al.detalhes->>'saldo_anterior')::numeric, (al.detalhes->>'saldo_novo')::numeric, al.criado_em
      FROM audit_logs al JOIN ingredients i ON i.id = al.recurso_id
      WHERE al.tenant_id = $1 AND al.recurso = 'ingredients'
        AND al.acao IN ('entrada_estoque', 'saida_estoque', 'transferencia', 'balanco_estoque')
      UNION ALL
      SELECT ic.id::text, 'insumo', ic.ingredient_id::text, i.nome, i.unidade, 'saida', ic.quantidade_consumida,
             ic.location_id, NULL::uuid, 'Consumo em venda', sa.operador_id, NULL::uuid, NULL::numeric, NULL,
             sa.id, NULL::numeric, NULL::numeric, ic.criado_em
      FROM ingredient_consumptions ic
      JOIN ingredients i ON i.id = ic.ingredient_id
      JOIN sale_items si ON si.id = ic.sale_item_id
      JOIN sales sa ON sa.id = si.sale_id
      WHERE ic.tenant_id = $1
    )`;
  const total = await pool.query(`${base} SELECT COUNT(*)::int AS total FROM m WHERE ${where}`, params);
  const { rows } = await pool.query(
    `${base}
     SELECT m.id, m.origem, m.item_id AS product_id, m.item_nome AS product_nome, m.unidade, m.tipo, m.quantidade,
            m.location_origem_id, lo.nome AS location_origem_nome,
            m.location_destino_id, ld.nome AS location_destino_nome,
            m.motivo, m.usuario_id, u.nome AS usuario_nome,
            m.supplier_id, s.nome AS supplier_nome, m.custo_unitario, m.documento_fiscal,
            m.sale_id, sa.numero AS sale_numero,
            m.saldo_anterior, m.saldo_novo, m.criado_em
     FROM m
     LEFT JOIN users u ON u.id = m.usuario_id
     LEFT JOIN suppliers s ON s.id = m.supplier_id
     LEFT JOIN sales sa ON sa.id = m.sale_id
     LEFT JOIN locations lo ON lo.id = m.location_origem_id
     LEFT JOIN locations ld ON ld.id = m.location_destino_id
     WHERE ${where} ORDER BY m.criado_em DESC, m.id
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: total.rows[0].total, limit, offset, itens: rows });
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
