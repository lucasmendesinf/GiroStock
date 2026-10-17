// Criacao de pedido (lanchonete/delivery), usada pela tela de Pedidos/PDV e pelas integracoes (iFood).
// Reserva o estoque: o saldo disponivel desconta os pedidos em aberto; a baixa definitiva acontece ao finalizar (venda).
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { HttpError } = require('../utils/http');
const { reservadosDaLoja } = require('../utils/reservas');
const { assertReceitasPermitidas } = require('./vendas');

const ORIGENS = ['balcao', 'telefone', 'whatsapp', 'ifood', '99food'];
const FORMAS_PREVISTAS = ['dinheiro', 'cartao', 'cartao_debito', 'cartao_credito', 'pix'];
const FORMAS_EXTERNAS = [...FORMAS_PREVISTAS, 'online']; // 'online' = pago na plataforma

// Pedido numerado por loja com o mesmo contador da comanda (recomeca quando um caixa abre num novo turno).
async function proximoNumero(client, tenantId, locationId) {
  const { rows } = await client.query(
    `INSERT INTO location_order_counters (location_id, tenant_id, ultimo) VALUES ($1, $2, 1)
     ON CONFLICT (location_id) DO UPDATE SET ultimo = location_order_counters.ultimo + 1 RETURNING ultimo`,
    [locationId, tenantId]
  );
  return rows[0].ultimo;
}

// Cria o pedido dentro da transacao do chamador (client ja em BEGIN). Devolve { orderId, numero, clienteNovo, faltas }.
// b: corpo do pedido (location_id, origem, tipo, itens [{product_id, quantidade, observacao, preco_unitario?}], cliente, pagamento...).
// opcoes.externo: pedido de plataforma ({ externo_id, codigo_externo }): usa os precos e o desconto da plataforma,
//   aceita a forma 'online', nao cadastra cliente (o telefone e um 0800 da plataforma) e, se faltar estoque,
//   NAO recusa (o pedido ja existe na plataforma): devolve as faltas para a equipe resolver.
// opcoes.inserirCliente: funcao de cadastro de cliente (vinda das rotas de clientes).
async function criarPedido(client, user, b, opcoes = {}) {
  const externo = opcoes.externo || null;
  const locationId = b.location_id;
  if (!isUuid(locationId)) throw new HttpError(400, 'location_id (loja) é obrigatório');
  const origem = b.origem || 'balcao';
  if (!ORIGENS.includes(origem)) throw new HttpError(400, 'origem inválida');
  const tipo = ['entrega', 'mesa'].includes(b.tipo) ? b.tipo : 'retirada';
  if (!Array.isArray(b.itens) || b.itens.length === 0) throw new HttpError(400, 'adicione ao menos um item ao pedido');
  const endereco = String(b.endereco || '').trim().slice(0, 300);
  if (tipo === 'entrega' && endereco.length < 3) throw new HttpError(400, 'informe o endereço da entrega');
  if (tipo === 'mesa' && endereco.length < 1) throw new HttpError(400, 'informe a mesa');
  const taxa = tipo === 'entrega' ? Number(b.taxa_entrega || 0) : 0;
  if (!(taxa >= 0)) throw new HttpError(400, 'taxa de entrega inválida');
  const forma = b.forma_pagamento_prevista === undefined || b.forma_pagamento_prevista === null ? null : String(b.forma_pagamento_prevista);
  if (forma !== null && !(externo ? FORMAS_EXTERNAS : FORMAS_PREVISTAS).includes(forma)) throw new HttpError(400, 'forma de pagamento prevista inválida');
  const pago = !!b.pago;
  const valorRecebido = (externo || pago) && forma === 'dinheiro' && b.valor_recebido !== undefined && b.valor_recebido !== null && b.valor_recebido !== '' ? Number(b.valor_recebido) : null;
  if (valorRecebido !== null && !(valorRecebido >= 0)) throw new HttpError(400, 'valor recebido inválido');
  const desconto = externo ? Number(Number(b.desconto || 0).toFixed(2)) : 0;
  if (!(desconto >= 0)) throw new HttpError(400, 'desconto inválido');

  const linhas = b.itens.map((i) => {
    if (!i || !isUuid(i.product_id) || !(Number(i.quantidade) > 0)) throw new HttpError(400, 'cada item precisa de product_id válido e quantidade (>0)');
    const linha = { product_id: i.product_id, quantidade: Number(i.quantidade), observacao: String(i.observacao || '').trim().slice(0, 200) };
    if (externo && i.preco_unitario !== undefined) {
      linha.preco_unitario = Number(i.preco_unitario);
      if (!(linha.preco_unitario >= 0)) throw new HttpError(400, 'preço do item inválido');
    }
    return linha;
  });

  const loja = await getOwned(client, 'locations', locationId, user.tenantId, { columns: 'id, nome, ativo, usa_pedidos' });
  if (!loja.ativo) throw new HttpError(400, 'esta loja está inativa');
  if (!loja.usa_pedidos) throw new HttpError(400, 'esta loja não usa pedidos (ative em Lojas & PDVs)');
  assertLocationAccess(user, locationId, 'criar pedidos nesta loja');

  const ids = [...new Set(linhas.map((l) => l.product_id))];
  const produtos = await client.query(
    `SELECT id, nome, unidade, preco_venda, ativo FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id`,
    [ids, user.tenantId]
  );
  const mapa = new Map(produtos.rows.map((p) => [p.id, p]));
  await assertReceitasPermitidas(client, user, ids);
  for (const l of linhas) {
    const p = mapa.get(l.product_id);
    if (!p || !p.ativo) throw new HttpError(400, 'produto não encontrado ou inativo');
    if (!isQuantidadeValidaParaUnidade(l.quantidade, p.unidade)) throw new HttpError(400, `"${p.nome}" é vendido em ${p.unidade} e só aceita quantidade inteira`);
  }

  const fichas = await client.query(
    `SELECT pi.product_id, pi.ingredient_id, pi.quantidade_por_unidade, i.nome AS insumo_nome
     FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
     WHERE pi.tenant_id = $1 AND pi.product_id = ANY($2::uuid[])`,
    [user.tenantId, ids]
  );
  const fichaPor = new Map();
  for (const r of fichas.rows) {
    if (!fichaPor.has(r.product_id)) fichaPor.set(r.product_id, []);
    fichaPor.get(r.product_id).push(r);
  }

  // Trava os saldos envolvidos (sempre em ordem) para que dois pedidos simultaneos nao reservem o mesmo estoque.
  const simples = ids.filter((id) => !fichaPor.has(id));
  const insumoIds = [...new Set(fichas.rows.map((r) => r.ingredient_id))];
  const saldoProd = simples.length === 0 ? { rows: [] } : await client.query(
    `SELECT product_id, saldo FROM stock_balances WHERE product_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY product_id FOR UPDATE`,
    [simples, locationId, user.tenantId]
  );
  const saldoIns = insumoIds.length === 0 ? { rows: [] } : await client.query(
    `SELECT ingredient_id, saldo FROM ingredient_balances WHERE ingredient_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY ingredient_id FOR UPDATE`,
    [insumoIds, locationId, user.tenantId]
  );
  const saldoProdMap = new Map(saldoProd.rows.map((r) => [r.product_id, Number(r.saldo)]));
  const saldoInsMap = new Map(saldoIns.rows.map((r) => [r.ingredient_id, Number(r.saldo)]));
  const reservados = await reservadosDaLoja(client, user.tenantId, locationId);

  const precisaProd = new Map();
  const precisaIns = new Map();
  for (const l of linhas) {
    const ficha = fichaPor.get(l.product_id);
    if (!ficha) {
      precisaProd.set(l.product_id, (precisaProd.get(l.product_id) || 0) + l.quantidade);
    } else {
      for (const r of ficha) precisaIns.set(r.ingredient_id, (precisaIns.get(r.ingredient_id) || 0) + Number(r.quantidade_por_unidade) * l.quantidade);
    }
  }
  const faltas = [];
  for (const [pid, q] of precisaProd) {
    const disponivel = (saldoProdMap.get(pid) || 0) - (reservados.produtos.get(pid) || 0);
    if (disponivel < q) faltas.push(`Sem estoque disponível de ${mapa.get(pid).nome}`);
  }
  for (const [iid, q] of precisaIns) {
    const disponivel = (saldoInsMap.get(iid) || 0) - (reservados.insumos.get(iid) || 0);
    if (disponivel < q) {
      const dono = linhas.find((l) => (fichaPor.get(l.product_id) || []).some((r) => r.ingredient_id === iid));
      const insumoNome = fichas.rows.find((r) => r.ingredient_id === iid).insumo_nome;
      faltas.push(`Sem estoque disponível de ${dono ? mapa.get(dono.product_id).nome : 'produto'} (falta ${insumoNome})`);
    }
  }
  if (faltas.length > 0 && !externo) throw new HttpError(409, faltas[0]);

  // Cliente: o telefone (so digitos) e a chave. Cadastrado -> vincula; novo -> cria quando "cadastrar_cliente" (padrao: sim).
  // Pedido de plataforma nao cadastra cliente: o telefone e um numero da plataforma, nao o do cliente.
  let customerId = null;
  let clienteNovo = false;
  const tel = String(b.cliente_telefone || '').replace(/\D/g, '');
  if (!externo && tel.length >= 10) {
    const ex = await client.query(`SELECT id FROM customers WHERE tenant_id = $1 AND telefone = $2 AND ativo`, [user.tenantId, tel]);
    if (ex.rows.length > 0) {
      customerId = ex.rows[0].id;
    } else if (b.cadastrar_cliente !== false && opcoes.inserirCliente) {
      customerId = await opcoes.inserirCliente(client, user.tenantId, {
        nome: String(b.cliente_nome || '').trim() || 'Cliente', telefone: tel, endereco: tipo === 'entrega' ? endereco : '', aceita_mensagens: false,
      });
      clienteNovo = true;
    }
  }

  const numero = await proximoNumero(client, user.tenantId, locationId);
  const pedido = await client.query(
    `INSERT INTO orders (tenant_id, location_id, numero, origem, cliente_nome, cliente_telefone, tipo, endereco, taxa_entrega,
                         observacao, forma_pagamento_prevista, pago, status, criado_por, customer_id, valor_recebido,
                         origem_externa_id, codigo_externo, desconto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'novo', $13, $14, $15, $16, $17, $18) RETURNING id`,
    [user.tenantId, locationId, numero, origem, String(b.cliente_nome || '').trim().slice(0, 120), String(b.cliente_telefone || '').trim().slice(0, 40),
      tipo, tipo === 'retirada' ? '' : endereco, taxa, String(b.observacao || '').trim().slice(0, 300), forma, pago, user.id || null, customerId, valorRecebido,
      externo ? externo.externo_id : null, externo ? externo.codigo_externo || null : null, desconto]
  );
  const orderId = pedido.rows[0].id;
  for (const l of linhas) {
    const preco = l.preco_unitario !== undefined ? l.preco_unitario : Number(mapa.get(l.product_id).preco_venda);
    // Observacao: lanches (preparo) sempre; de plataforma, em qualquer item (complementos e pedidos do cliente).
    const obs = (fichaPor.has(l.product_id) || externo) && l.observacao ? l.observacao : null;
    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantidade, preco_unitario, subtotal, observacao) VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, l.product_id, l.quantidade, preco, Number((preco * l.quantidade).toFixed(2)), obs]
    );
  }
  await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, NULL, 'novo', $2)`, [orderId, user.id || null]);
  await logAudit(client, {
    tenantId: user.tenantId, usuarioId: user.id || null, acao: 'criar_pedido', recurso: 'orders', recursoId: orderId,
    detalhes: { numero, origem, tipo, itens: linhas.length, customer_id: customerId, cliente_novo: clienteNovo, ...(externo ? { externo_id: externo.externo_id, faltas } : {}) },
  });
  return { orderId, numero, clienteNovo, faltas };
}

module.exports = { criarPedido, proximoNumero, ORIGENS, FORMAS_PREVISTAS };
