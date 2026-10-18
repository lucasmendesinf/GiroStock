const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const { logAudit } = require('../utils/audit');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { reservadosDaLoja } = require('../utils/reservas');
const {
  carregarComposicao, consumoDaLinha, consumoDasLinhas, custoUnitario, validarComplementos, precoDosComplementos,
  idsDeComplementos, saldosDaLoja, faltasDoConsumo,
} = require('./consumo');

// 'online' = pago na plataforma (iFood...): so por pedido de plataforma; nao entra no dinheiro do caixa.
const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro', 'online'];

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
// baixa o estoque / consome os insumos (ficha tecnica, combos e complementos: services/consumo.js), numera a comanda e audita.
// dados: { terminal_id, itens: [{ product_id, quantidade, observacao, complementos: [{ id, quantidade }] }], forma_pagamento,
//          valor_recebido, desconto, taxa_entrega, numero_pedido (fixo, vindo de um pedido), ignorar_pedido_id (pedido cuja
//          reserva vira baixa), precos_informados (pedido de plataforma: cada item traz preco_unitario, o preco cobrado pela
//          plataforma, e os complementos ja vem com o preco dela; a regra de minimo/maximo dos grupos nao se aplica),
//          sem_caixa + location_id (pedido pago no site: a venda nao passa pelo caixa; so com forma 'online') }
async function registrarVenda(client, user, dados) {
  const { terminal_id, itens, forma_pagamento, valor_recebido } = dados;
  const descontoInformado = Number(dados.desconto || 0);
  const taxaEntrega = Number(dados.taxa_entrega || 0);
  if (!(descontoInformado >= 0)) throw new HttpError(400, 'desconto deve ser um valor em reais (0 ou mais)');
  const semCaixa = !!dados.sem_caixa;
  if (semCaixa && forma_pagamento !== 'online') throw new HttpError(400, 'venda sem caixa só para pedido pago online');
  if ((!terminal_id && !semCaixa) || !Array.isArray(itens) || itens.length === 0 || !forma_pagamento) {
    throw new HttpError(400, 'terminal_id, itens (não vazio) e forma_pagamento são obrigatórios');
  }
  if (!FORMAS_PAGAMENTO.includes(forma_pagamento)) throw new HttpError(400, 'forma_pagamento inválida');
  if (forma_pagamento === 'online' && !dados.precos_informados) throw new HttpError(400, 'forma_pagamento inválida');
  const itensAgrupados = agruparItens(itens);
  // Linhas como vieram do PDV (mesmo produto com observacoes ou complementos diferentes vira linhas separadas).
  const linhas = itens.map((i) => ({
    product_id: i.product_id, quantidade: Number(i.quantidade), observacao: String(i.observacao || '').trim().slice(0, 200),
    preco_informado: dados.precos_informados && Number.isFinite(Number(i.preco_unitario)) ? Number(i.preco_unitario) : null,
    complementos_pedidos: Array.isArray(i.complementos) ? i.complementos : [],
  }));

  let locationId;
  let cashSessionId = null;
  if (semCaixa) {
    const local = await getOwned(client, 'locations', dados.location_id, user.tenantId, { columns: 'id, ativo' });
    if (!local.ativo) throw new HttpError(400, 'este local está inativo');
    locationId = local.id;
    assertLocationAccess(user, locationId, 'vender neste local');
  } else {
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
    locationId = terminal.location_id;
    assertLocationAccess(user, locationId, 'vender neste terminal');

    // Nao e possivel registrar venda com o caixa fechado
    const session = await client.query(
      `SELECT id FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL FOR UPDATE`,
      [register.rows[0].id, user.tenantId]
    );
    if (session.rows.length === 0) {
      throw new HttpError(400, 'caixa fechado: abra o caixa antes de registrar vendas');
    }
    cashSessionId = session.rows[0].id;
  }

  // Carrega e trava os produtos vendidos (sempre em ordem de id, como nas movimentacoes de estoque)
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

  // Composicao (fichas, combos, complementos) e complementos validados de cada linha.
  const comp = await carregarComposicao(client, user.tenantId, productIds, idsDeComplementos(linhas.map((l) => ({ complementos: l.complementos_pedidos }))));
  for (const l of linhas) {
    l.complementos = validarComplementos(comp, l.product_id, l.complementos_pedidos, { validarGrupos: !dados.precos_informados && !dados.ignorar_pedido_id });
    // Preco do complemento que veio da plataforma (o do iFood pode ser diferente do cadastro).
    if (dados.precos_informados) {
      for (const c of l.complementos) {
        const vindo = l.complementos_pedidos.find((x) => x.id === c.id);
        if (vindo && Number.isFinite(Number(vindo.preco))) c.preco = Number(vindo.preco);
      }
    }
  }

  // Preco: o cadastrado + complementos (ou o informado pela plataforma, que ja inclui os complementos).
  const linhasComPreco = linhas.map((l) => {
    const produto = productMap.get(l.product_id);
    const preco = l.preco_informado !== null ? l.preco_informado : Number((Number(produto.preco_venda) + precoDosComplementos(l.complementos)).toFixed(2));
    return { ...l, preco_unitario: preco, custo_unitario: custoUnitario(comp, l.product_id, l.complementos), subtotal: Number((preco * l.quantidade).toFixed(2)) };
  });
  const subtotalVenda = Number(linhasComPreco.reduce((s, l) => s + l.subtotal, 0).toFixed(2));
  const desconto = Number(descontoInformado.toFixed(2));
  if (desconto >= subtotalVenda) {
    throw new HttpError(400, `desconto (${desconto}) deve ser menor que o subtotal da venda (${subtotalVenda})`);
  }
  const total = Number((subtotalVenda - desconto + taxaEntrega).toFixed(2));

  let troco = null;
  let valorRecebidoFinal = null;
  if (forma_pagamento === 'dinheiro') {
    // Pedido de plataforma cobrado em dinheiro sem "troco para": o cliente paga o valor exato.
    const semValor = valor_recebido === undefined || valor_recebido === null || valor_recebido === '';
    const recebido = dados.precos_informados && semValor ? total : Number(valor_recebido);
    if (!(recebido >= total)) {
      throw new HttpError(400, `valor recebido (${recebido}) deve ser maior ou igual ao total (${total})`);
    }
    valorRecebidoFinal = recebido;
    troco = Number((recebido - total).toFixed(2));
  }

  // Consumo total da venda (produtos com estoque proprio e insumos), validado contra o disponivel DA LOJA do terminal:
  // saldo menos o reservado por pedidos em aberto (a reserva do pedido que esta sendo finalizado vira baixa).
  const consumoPorLinha = linhasComPreco.map((l) => consumoDaLinha(comp, l));
  const consumoTotal = consumoDasLinhas(comp, linhasComPreco);
  if (!dados.ignorar_pedido_id && user.modulos && user.modulos.lanchonete === false && consumoTotal.insumos.size > 0) {
    throw new HttpError(403, 'há item que consome insumos (lanche, combo ou adicional) e o módulo Lanchonete e cozinha não faz parte do plano da sua empresa');
  }
  const reservados = await reservadosDaLoja(client, user.tenantId, locationId, dados.ignorar_pedido_id || null);
  const disponivel = await saldosDaLoja(client, user.tenantId, locationId, consumoTotal, reservados, true);
  const faltas = await faltasDoConsumo(client, user.tenantId, consumoTotal, disponivel, comp);
  if (faltas.length > 0) {
    const f = faltas[0];
    throw new HttpError(400, f.tipo === 'produto'
      ? `estoque insuficiente de "${f.nome}" nesta loja (disponível: ${f.disponivel}, necessário: ${f.necessario})`
      : `${f.nome}: necessário ${f.necessario}${f.unidade}, disponível nesta loja ${f.disponivel}${f.unidade}`);
  }

  // Tudo validado: grava a venda com o proximo numero sequencial da empresa
  // (o lock de transacao serializa vendas simultaneas so na hora de numerar).
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('sales:' || $1::text))`, [user.tenantId]);
  const proximo = await client.query(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM sales WHERE tenant_id = $1`,
    [user.tenantId]
  );
  const numero = proximo.rows[0].numero;
  // Numero do pedido (comanda) da loja: so quando a loja usa comanda e a venda tem preparo (consome insumos: lanche,
  // combo com lanche ou adicional). O UPSERT trava a linha do contador e serializa pedidos simultaneos; o contador
  // reinicia na abertura do caixa de um novo turno.
  let numeroPedido = null;
  const lojaComanda = await client.query(`SELECT usa_comanda FROM locations WHERE id = $1`, [locationId]);
  if (dados.numero_pedido) {
    numeroPedido = Number(dados.numero_pedido);
  } else if (lojaComanda.rows[0] && lojaComanda.rows[0].usa_comanda && consumoTotal.insumos.size > 0) {
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
    [user.tenantId, numero, locationId, semCaixa ? null : terminal_id, cashSessionId, user.id, forma_pagamento,
      valorRecebidoFinal, troco, subtotalVenda, desconto, total, numeroPedido, taxaEntrega]
  );
  const saleId = sale.rows[0].id;

  for (let k = 0; k < linhasComPreco.length; k++) {
    const item = linhasComPreco[k];
    const consumo = consumoPorLinha[k];
    // Observacao: itens com preparo (consomem insumos) ou com complementos; e os de plataforma.
    const guardaObs = consumo.insumos.size > 0 || item.complementos.length > 0 || comp.combos.has(item.product_id) || dados.precos_informados;
    const saleItem = await client.query(
      `INSERT INTO sale_items (tenant_id, sale_id, product_id, quantidade, preco_unitario, custo_unitario, subtotal, observacao, complementos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [user.tenantId, saleId, item.product_id, item.quantidade, item.preco_unitario, item.custo_unitario, item.subtotal,
        guardaObs && item.observacao ? item.observacao : null, item.complementos.length ? JSON.stringify(item.complementos) : null]
    );
    // Produtos com estoque proprio (o vendido, os componentes do combo, os complementos que sao produto).
    for (const [productId, q] of consumo.produtos) {
      await client.query(
        `UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [q, productId, locationId, user.tenantId]
      );
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, sale_id)
         VALUES ($1, $2, 'saida', $3, $4, NULL, $5, $6, $7)`,
        [user.tenantId, productId, q, locationId, productId === item.product_id ? `Venda nº ${numero}` : `Venda nº ${numero} (${productMap.get(item.product_id).nome})`, user.id, saleId]
      );
    }
    // Insumos (ficha tecnica do lanche, dos componentes do combo e dos adicionais), ligados ao item da venda.
    for (const [ingredientId, consumido] of consumo.insumos) {
      await client.query(
        `UPDATE ingredient_balances SET saldo = saldo - $1 WHERE ingredient_id = $2 AND location_id = $3 AND tenant_id = $4`,
        [consumido, ingredientId, locationId, user.tenantId]
      );
      await client.query(
        `INSERT INTO ingredient_consumptions (tenant_id, sale_item_id, ingredient_id, quantidade_consumida, location_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.tenantId, saleItem.rows[0].id, ingredientId, consumido, locationId]
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

module.exports = { registrarVenda, agruparItens, assertReceitasPermitidas, FORMAS_PAGAMENTO };
