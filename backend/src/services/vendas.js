const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const { logAudit } = require('../utils/audit');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { reservadosDaLoja } = require('../utils/reservas');

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

// Sem o modulo Lanchonete (plano da empresa), lanche com ficha tecnica nao e vendido nem pedido: a receita baixaria
// insumos que a empresa nao gerencia mais. Produto de revenda segue normal.
async function assertReceitasPermitidas(db, user, productIds) {
  if (!user || !user.modulos || user.modulos.lanchonete !== false || productIds.length === 0) return;
  const { rows } = await db.query(
    `SELECT p.nome FROM products p WHERE p.id = ANY($1::uuid[]) AND p.tenant_id = $2
       AND EXISTS (SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id AND pi.tenant_id = p.tenant_id)
     ORDER BY p.nome LIMIT 1`,
    [productIds, user.tenantId]
  );
  if (rows.length > 0) {
    throw new HttpError(403, `"${rows[0].nome}" é um lanche com ficha técnica e o módulo Lanchonete e cozinha não faz parte do plano da sua empresa`);
  }
}

// Registra uma venda dentro da transacao do chamador (client ja em BEGIN; quem chama faz COMMIT/ROLLBACK).
// Faz tudo: valida estoque (descontando o que esta reservado por pedidos em aberto), grava a venda e os itens,
// baixa o estoque ou consome os insumos da receita, numera a comanda e audita.
// dados: { terminal_id, itens: [{ product_id, quantidade, observacao }], forma_pagamento, valor_recebido, desconto,
//          taxa_entrega, numero_pedido (fixo, vindo de um pedido), ignorar_pedido_id (pedido cuja reserva vira baixa) }
async function registrarVenda(client, user, dados) {
  const { terminal_id, itens, forma_pagamento, valor_recebido } = dados;
  const descontoInformado = Number(dados.desconto || 0);
  const taxaEntrega = Number(dados.taxa_entrega || 0);
  if (!(descontoInformado >= 0)) throw new HttpError(400, 'desconto deve ser um valor em reais (0 ou mais)');
  if (!terminal_id || !Array.isArray(itens) || itens.length === 0 || !forma_pagamento) {
    throw new HttpError(400, 'terminal_id, itens (não vazio) e forma_pagamento são obrigatórios');
  }
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) throw new HttpError(400, 'forma_pagamento inválida');
  const itensAgrupados = agruparItens(itens);
  // Linhas como vieram do PDV (mesmo produto com observacoes diferentes vira linhas separadas).
  const linhas = itens.map((i) => ({ product_id: i.product_id, quantidade: Number(i.quantidade), observacao: String(i.observacao || '').trim().slice(0, 200) }));

  {
    const terminal = await getOwned(client, 'terminals', terminal_id, user.tenantId, { columns: 'id, location_id, ativo' });
    if (!terminal.ativo) throw new HttpError(400, 'terminal inativo');
    const register = await client.query(
      `SELECT cr.id, l.ativo AS location_ativo
       FROM cash_registers cr JOIN locations l ON l.id = $3
       WHERE cr.terminal_id = $1 AND cr.tenant_id = $2`,
      [terminal_id, user.tenantId, terminal.location_id]
    );
    if (register.rows.length === 0) throw new HttpError(404, 'terminal sem caixa configurado');
    if (!register.rows[0].location_ativo) throw new HttpError(400, 'o local deste terminal está inativo');
    const locationId = terminal.location_id;
    const cashRegisterId = register.rows[0].id;
    assertLocationAccess(user, locationId, 'vender neste terminal');

    // Nao e possivel registrar venda com o caixa fechado
    const session = await client.query(
      `SELECT id FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL FOR UPDATE`,
      [cashRegisterId, user.tenantId]
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
      [productIds, user.tenantId]
    );
    const productMap = new Map(products.rows.map((p) => [p.id, p]));
    // Pedido ja aceito antes de o modulo ser desligado ainda pode ser finalizado (a reserva ja existe).
    if (!dados.ignorar_pedido_id) await assertReceitasPermitidas(client, user, productIds);
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
    // O subtotal e o gravado por linha (cada linha vira um item da venda, com a sua observacao).
    const linhasComPreco = linhas.map((l) => {
      const base = itemsComPreco.find((i) => i.product_id === l.product_id);
      return { ...l, preco_unitario: base.preco_unitario, custo_unitario: base.custo_unitario, subtotal: Number((base.preco_unitario * l.quantidade).toFixed(2)) };
    });
    subtotalVenda = Number(linhasComPreco.reduce((s, l) => s + l.subtotal, 0).toFixed(2));
    const desconto = Number(descontoInformado.toFixed(2));
    if (desconto >= subtotalVenda) {
      throw new HttpError(400, `desconto (${desconto}) deve ser menor que o subtotal da venda (${subtotalVenda})`);
    }
    const total = Number((subtotalVenda - desconto + taxaEntrega).toFixed(2));

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
      [user.tenantId, productIds]
    );
    const fichaPorProduto = new Map();
    for (const row of fichas.rows) {
      if (!fichaPorProduto.has(row.product_id)) fichaPorProduto.set(row.product_id, []);
      fichaPorProduto.get(row.product_id).push(row);
    }

    // O que esta reservado por pedidos em aberto nao pode ser vendido (a reserva do pedido que esta sendo finalizado vira baixa).
    const reservados = await reservadosDaLoja(client, user.tenantId, locationId, dados.ignorar_pedido_id || null);

    // Verifica saldo de produto no local do terminal (somente para itens sem ficha tecnica)
    const semFicha = itemsComPreco.filter((i) => !fichaPorProduto.has(i.product_id));
    if (semFicha.length > 0) {
      const saldos = await client.query(
        `SELECT product_id, saldo FROM stock_balances
         WHERE product_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3
         ORDER BY product_id FOR UPDATE`,
        [semFicha.map((i) => i.product_id), locationId, user.tenantId]
      );
      const saldoMap = new Map(saldos.rows.map((r) => [r.product_id, Number(r.saldo)]));
      for (const item of semFicha) {
        const disponivel = (saldoMap.get(item.product_id) || 0) - (reservados.produtos.get(item.product_id) || 0);
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
        [[...necessidadePorInsumo.keys()], locationId, user.tenantId]
      );
      const saldoInsumoMap = new Map(saldosInsumo.rows.map((r) => [r.ingredient_id, Number(r.saldo)]));
      for (const [ingredientId, info] of necessidadePorInsumo) {
        const disponivel = (saldoInsumoMap.get(ingredientId) || 0) - (reservados.insumos.get(ingredientId) || 0);
        if (disponivel < info.necessario) {
          throw new HttpError(400, `${info.nome}: necessário ${info.necessario}${info.unidade}, disponível nesta loja ${disponivel}${info.unidade}`);
        }
      }
    }

    // Tudo validado: grava a venda com o proximo numero sequencial da empresa
    // (o lock de transacao serializa vendas simultaneas so na hora de numerar).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sales:' || $1::text))`, [user.tenantId]);
    const proximo = await client.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM sales WHERE tenant_id = $1`,
      [user.tenantId]
    );
    const numero = proximo.rows[0].numero;
    // Numero do pedido (comanda) da loja: so quando a loja usa comanda e a venda tem produto com ficha tecnica (lanche). O UPSERT trava a linha do contador
    // e serializa pedidos simultaneos; o contador reinicia na abertura do caixa de um novo turno.
    let numeroPedido = null;
    const lojaComanda = await client.query(`SELECT usa_comanda FROM locations WHERE id = $1`, [locationId]);
    if (dados.numero_pedido) {
      numeroPedido = Number(dados.numero_pedido);
    } else if (lojaComanda.rows[0] && lojaComanda.rows[0].usa_comanda && fichaPorProduto.size > 0) {
      const cont = await client.query(
        `INSERT INTO location_order_counters (location_id, tenant_id, ultimo) VALUES ($1, $2, 1)
         ON CONFLICT (location_id) DO UPDATE SET ultimo = location_order_counters.ultimo + 1 RETURNING ultimo`,
        [locationId, user.tenantId]
      );
      numeroPedido = cont.rows[0].ultimo;
    }
    const sale = await client.query(
      `INSERT INTO sales (tenant_id, numero, location_id, terminal_id, cash_session_id, operador_id, forma_pagamento,
                          valor_recebido, troco, subtotal, desconto, total, status, numero_pedido, taxa_entrega)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'concluida', $13, $14)
       RETURNING id, numero, subtotal, desconto, total, troco, forma_pagamento, criado_em`,
      [user.tenantId, numero, locationId, terminal_id, cashSessionId, user.id, forma_pagamento,
        valorRecebidoFinal, troco, subtotalVenda, desconto, total, numeroPedido, taxaEntrega]
    );
    const saleId = sale.rows[0].id;

    for (const item of linhasComPreco) {
      const ficha = fichaPorProduto.get(item.product_id);
      // Observacao so existe para produto com receita (lanche).
      const saleItem = await client.query(
        `INSERT INTO sale_items (tenant_id, sale_id, product_id, quantidade, preco_unitario, custo_unitario, subtotal, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [user.tenantId, saleId, item.product_id, item.quantidade, item.preco_unitario, item.custo_unitario, item.subtotal, ficha && item.observacao ? item.observacao : null]
      );

      if (!ficha) {
        await client.query(
          `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [item.quantidade, item.product_id, locationId, user.tenantId]
        );
        await client.query(
          `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, sale_id)
           VALUES ($1, $2, 'saida', $3, $4, NULL, $5, $6, $7)`,
          [user.tenantId, item.product_id, item.quantidade, locationId, `Venda nº ${numero}`, user.id, saleId]
        );
        continue;
      }

      for (const row of ficha) {
        const consumido = Number(row.quantidade_por_unidade) * item.quantidade;
        await client.query(
          `UPDATE ingredient_balances SET saldo = saldo - $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
          [consumido, row.ingredient_id, locationId, user.tenantId]
        );
        await client.query(
          `INSERT INTO ingredient_consumptions (tenant_id, sale_item_id, ingredient_id, quantidade_consumida, location_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.tenantId, saleItem.rows[0].id, row.ingredient_id, consumido, locationId]
        );
      }
    }

    await logAudit(client, {
      tenantId: user.tenantId,
      usuarioId: user.id,
      acao: 'venda',
      recurso: 'sales',
      recursoId: saleId,
      detalhes: { numero, numero_pedido: numeroPedido, subtotal: subtotalVenda, desconto, total, forma_pagamento },
    });


    return {
      id: saleId,
      numero,
      numero_pedido: numeroPedido,
      subtotal: subtotalVenda,
      desconto,
      taxa_entrega: taxaEntrega,
      total,
      troco,
      forma_pagamento,
      criado_em: sale.rows[0].criado_em,
    };
  }
}

module.exports = { registrarVenda, agruparItens, assertReceitasPermitidas, FORMAS_PAGAMENTO };
