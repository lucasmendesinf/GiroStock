// Converte o detalhe de um pedido do iFood (GET /order/v1.0/orders/{id}) nos dados de um pedido do GiroStock.
// Funcao pura (sem banco, sem rede). Le o payload de forma defensiva: campo ausente nao derruba a importacao.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dinheiro = (v) => Number(num(v).toFixed(2));
const texto = (v, max = 300) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// Chave do item para o vinculo com o produto: o "código PDV" (externalCode) cadastrado no cardapio do iFood;
// sem ele, o id do item no catalogo do iFood.
function chaveDoItem(item) {
  if (item.externalCode) return `ext:${texto(item.externalCode, 120)}`;
  if (item.id) return `id:${texto(item.id, 120)}`;
  return `nome:${texto(item.name, 120).toLowerCase()}`;
}

function enderecoDe(d) {
  const a = (d && d.deliveryAddress) || {};
  const base = a.formattedAddress || [a.streetName, a.streetNumber].filter(Boolean).join(', ');
  return [base, a.complement, a.neighborhood, a.reference ? `Ref.: ${a.reference}` : ''].filter(Boolean).join(' · ');
}

const FORMA_OFFLINE = { CASH: 'dinheiro', CREDIT: 'cartao_credito', DEBIT: 'cartao_debito', PIX: 'pix', MEAL_VOUCHER: 'cartao_credito', FOOD_VOUCHER: 'cartao_credito' };
const NOME_METODO = { MEAL_VOUCHER: 'vale-refeição', FOOD_VOUCHER: 'vale-alimentação' };

function pagamentoDe(p) {
  const pag = p || {};
  const metodos = Array.isArray(pag.methods) ? pag.methods : [];
  const pendente = num(pag.pending);
  const online = metodos.length > 0 ? metodos.every((m) => m.type === 'ONLINE') : pendente === 0;
  if (online && pendente === 0) return { pago: true, forma: 'online', valorRecebido: null, nota: 'Pago online no iFood' };
  const m = metodos.find((x) => x.type !== 'ONLINE') || metodos[0] || {};
  const forma = FORMA_OFFLINE[m.method] || 'cartao_credito';
  const troco = m.cash && num(m.cash.changeFor) > 0 ? dinheiro(m.cash.changeFor) : null;
  const bandeira = m.card && m.card.brand ? ` ${m.card.brand}` : '';
  const nota = `Cobrar na entrega: ${NOME_METODO[m.method] || forma.replace('_', ' ')}${bandeira}${troco ? ` (troco para R$ ${troco.toFixed(2).replace('.', ',')})` : ''}`;
  return { pago: false, forma, valorRecebido: troco, nota };
}

// Desconto bancado pela loja (o que o iFood banca ele mesmo repassa, entao nao reduz a receita da loja).
function descontoDaLoja(pedido) {
  const beneficios = Array.isArray(pedido.benefits) ? pedido.benefits : [];
  let comPatrocinio = false;
  let loja = 0;
  for (const b of beneficios) {
    if (Array.isArray(b.sponsorshipValues) && b.sponsorshipValues.length) {
      comPatrocinio = true;
      for (const s of b.sponsorshipValues) if (s.name === 'MERCHANT' || s.name === 'CHAIN') loja += num(s.value);
    }
  }
  if (comPatrocinio) return dinheiro(loja);
  return dinheiro((pedido.total && pedido.total.benefits) || 0);
}

function pedidoDoIfood(p) {
  const tipoIfood = p.orderType || 'DELIVERY';
  const entregaPelaPlataforma = tipoIfood === 'DELIVERY' && (!p.delivery || p.delivery.deliveredBy !== 'MERCHANT');
  const tipo = tipoIfood === 'DELIVERY' ? 'entrega' : (tipoIfood === 'DINE_IN' || tipoIfood === 'INDOOR') ? 'mesa' : 'retirada';
  const endereco = tipo === 'entrega' ? (enderecoDe(p.delivery) || 'Endereço no iFood') : tipo === 'mesa' ? texto((p.indoor && (p.indoor.table || p.indoor.place)) || 'Consumo no local (iFood)', 120) : '';
  const pag = pagamentoDe(p.payments);
  const cliente = p.customer || {};
  const fone = cliente.phone || {};
  const telefone = [fone.number, fone.localizer ? `ID ${fone.localizer}` : ''].filter(Boolean).join(' ');

  const itens = (Array.isArray(p.items) ? p.items : []).map((it) => {
    const quantidade = num(it.quantity) || 1;
    const opcoes = Array.isArray(it.options) ? it.options : [];
    const totalLinha = num(it.totalPrice) || (num(it.unitPrice) + opcoes.reduce((s, o) => s + num(o.price || num(o.unitPrice) * num(o.quantity || 1)), 0)) * quantidade;
    const extras = opcoes.map((o) => `${num(o.quantity) > 1 ? `${num(o.quantity)}x ` : ''}${texto(o.name, 60)}`).filter(Boolean);
    return {
      chave: chaveDoItem(it),
      nome: texto(it.name, 120) || 'Item do iFood',
      codigo_externo: it.externalCode ? texto(it.externalCode, 60) : null,
      ean: it.ean ? texto(it.ean, 20) : null,
      quantidade,
      preco_unitario: dinheiro(totalLinha / quantidade),
      observacao: texto([extras.length ? `+ ${extras.join(', ')}` : '', it.observations].filter(Boolean).join(' · '), 200),
      // Complementos com codigo PDV viram complementos do GiroStock (baixam insumo/produto); os demais ficam so na observacao.
      // Quantidade e preco por unidade do item.
      opcoes: opcoes.map((o) => ({
        codigo: o.externalCode ? texto(o.externalCode, 60).toUpperCase() : null,
        nome: texto(o.name, 60),
        quantidade: num(o.quantity) || 1,
        preco: dinheiro(num(o.unitPrice) || (num(o.price) / (num(o.quantity) || 1))),
      })),
    };
  });

  const observacao = [
    `iFood #${p.displayId || String(p.id || '').slice(0, 8)}`,
    entregaPelaPlataforma ? 'Entrega iFood' : tipo === 'entrega' ? 'Entrega da loja' : '',
    p.delivery && p.delivery.pickupCode ? `Código de coleta ${p.delivery.pickupCode}` : '',
    p.takeout && p.takeout.takeoutDateTime && p.orderTiming === 'SCHEDULED' ? `Agendado para ${p.takeout.takeoutDateTime}` : '',
    p.delivery && p.delivery.deliveryDateTime && p.orderTiming === 'SCHEDULED' ? `Agendado para ${p.delivery.deliveryDateTime}` : '',
    pag.nota,
    p.delivery && p.delivery.observations ? texto(p.delivery.observations, 120) : '',
    p.extraInfo ? texto(p.extraInfo, 120) : '',
  ].filter(Boolean).join(' · ');

  return {
    externo_id: String(p.id),
    codigo_externo: p.displayId ? texto(p.displayId, 20) : null,
    merchant_id: p.merchant && p.merchant.id ? String(p.merchant.id) : null,
    tipo,
    endereco: texto(endereco),
    entrega_pela_plataforma: entregaPelaPlataforma,
    // Entrega feita pelo iFood: a taxa e do iFood, nao da loja.
    taxa_entrega: entregaPelaPlataforma ? 0 : dinheiro(p.total && p.total.deliveryFee),
    desconto: descontoDaLoja(p),
    cliente_nome: texto(cliente.name, 120) || 'Cliente iFood',
    cliente_telefone: texto(telefone, 40),
    observacao: texto(observacao),
    pago: pag.pago,
    forma_pagamento_prevista: pag.forma,
    valor_recebido: pag.valorRecebido,
    itens,
  };
}

module.exports = { pedidoDoIfood, chaveDoItem };
