// Converte o pedido da 99Food (order_info, do evento orderNew ou do /order/order/detail) nos dados de um pedido do
// GiroStock, no mesmo formato do iFood (integracoes/ifood/mapear.js). Funcao pura. Valores da 99Food vem em CENTAVOS.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const reais = (centavos) => Number((num(centavos) / 100).toFixed(2));
const texto = (v, max = 300) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// Codigo PDV do item cadastrado no cardapio da 99Food. A CONFIRMAR NA HOMOLOGACAO o nome exato do campo.
const codigoDo = (it) => it.app_item_id || it.app_external_id || it.external_id || it.app_sku_id || null;

function chaveDoItem(item) {
  const c = codigoDo(item);
  if (c) return `ext:${texto(c, 120)}`;
  if (item.item_id || item.sku_id) return `id:${texto(item.item_id || item.sku_id, 120)}`;
  return `nome:${texto(item.name, 120).toLowerCase()}`;
}

// pay_method 1 = pago online no app. pay_channel diz o meio (cobrar na entrega quando nao for online).
const CANAL = {
  150: 'cartao_credito', 262: 'cartao_credito', 263: 'cartao_debito', 153: 'dinheiro', 212: 'pix', 280: 'pix',
  257: 'cartao_credito', 258: 'cartao_credito', 259: 'cartao_credito', 260: 'cartao_credito', 264: 'cartao_credito',
};
const VALE = new Set([257, 258, 259, 260, 264]);

function pagamentoDe(o, total) {
  if (num(o.pay_method) === 1) return { pago: true, forma: 'online', valorRecebido: null, nota: 'Pago online na 99Food' };
  const canal = num(o.pay_channel);
  const forma = CANAL[canal] || 'dinheiro';
  const nomeForma = VALE.has(canal) ? 'vale-refeição' : forma.replace('_', ' ');
  const cobrar = num(o.price && o.price.customer_need_paying_money) > 0 ? reais(o.price.customer_need_paying_money) : total;
  // Troco: a 99Food manda o valor que o cliente vai entregar (A CONFIRMAR o nome do campo).
  const trocoPara = reais(o.change_for || (o.price && o.price.change_money) || 0);
  const nota = `Cobrar na entrega: ${nomeForma} R$ ${cobrar.toFixed(2).replace('.', ',')}${trocoPara > 0 ? ` (troco para R$ ${trocoPara.toFixed(2).replace('.', ',')})` : ''}`;
  return { pago: false, forma, valorRecebido: forma === 'dinheiro' && trocoPara > 0 ? trocoPara : null, nota };
}

function enderecoDe(a) {
  if (!a) return '';
  const base = a.poi_address || [a.street_name, a.street_number].filter(Boolean).join(', ');
  return [base, a.complement, a.district, a.city].filter(Boolean).join(' · ');
}

function pedidoDo99(o) {
  const a = o.receive_address || {};
  const retirada = num(o.fulfillment_mode) === 1 || (o.delivery_type !== undefined && num(o.delivery_type) === 0);
  const entregaPelaPlataforma = !retirada && num(o.delivery_type) !== 2;
  const tipo = retirada ? 'retirada' : 'entrega';
  const preco = o.price || {};

  const itens = (Array.isArray(o.order_items) ? o.order_items : []).map((it) => {
    const quantidade = num(it.amount) || 1;
    const subs = Array.isArray(it.sub_item_list) ? it.sub_item_list : [];
    const totalLinha = num(it.total_price) || (num(it.sku_price) * quantidade + subs.reduce((s, x) => s + num(x.total_price || num(x.sku_price) * (num(x.amount) || 1)), 0));
    const extras = subs.map((x) => `${num(x.amount) > 1 ? `${num(x.amount)}x ` : ''}${texto(x.name, 60)}`).filter(Boolean);
    const codigo = codigoDo(it);
    return {
      chave: chaveDoItem(it),
      nome: texto(it.name, 120) || 'Item da 99Food',
      codigo_externo: codigo ? texto(codigo, 60) : null,
      ean: null,
      quantidade,
      preco_unitario: Number((totalLinha / 100 / quantidade).toFixed(2)),
      observacao: texto([extras.length ? `+ ${extras.join(', ')}` : '', it.remark].filter(Boolean).join(' · '), 200),
      // Quantidade e preco por unidade do item (a 99Food manda o total do subitem na linha).
      opcoes: subs.map((x) => {
        const q = Math.max(1, Math.round((num(x.amount) || 1) / quantidade));
        const totalSub = num(x.total_price) || num(x.sku_price) * (num(x.amount) || 1);
        const c = codigoDo(x);
        return { codigo: c ? texto(c, 60).toUpperCase() : null, nome: texto(x.name, 60), quantidade: q, preco: Number((totalSub / 100 / quantidade / q).toFixed(2)) };
      }),
    };
  });

  const totalItens = itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0);
  const taxa = entregaPelaPlataforma ? 0 : reais(preco.delivery_price);
  const pag = pagamentoDe(o, Number((totalItens + taxa).toFixed(2)));
  const nome = texto(a.name || [a.first_name, a.last_name].filter(Boolean).join(' '), 120);
  const telefone = texto(a.phone || a.virtual_phone_number, 40);
  const codigo = o.order_index !== undefined && o.order_index !== null && o.order_index !== '' ? texto(o.order_index, 20) : String(o.order_id || '').slice(-6);

  const observacao = [
    `99Food #${codigo}`,
    entregaPelaPlataforma ? 'Entrega 99Food' : tipo === 'entrega' ? 'Entrega da loja' : 'Retirada na loja',
    pag.nota,
    o.remark ? texto(o.remark, 120) : '',
  ].filter(Boolean).join(' · ');

  return {
    externo_id: String(o.order_id),
    codigo_externo: codigo,
    merchant_id: o.shop && o.shop.app_shop_id ? String(o.shop.app_shop_id) : null,
    tipo,
    endereco: tipo === 'entrega' ? texto(enderecoDe(a) || 'Endereço na 99Food') : '',
    entrega_pela_plataforma: entregaPelaPlataforma,
    // Entrega feita pela 99Food: a taxa e da 99Food, nao da loja. Desconto da loja: A CONFIRMAR (campo nao identificado).
    taxa_entrega: taxa,
    desconto: 0,
    cliente_nome: nome || 'Cliente 99Food',
    cliente_telefone: telefone,
    observacao: texto(observacao),
    pago: pag.pago,
    forma_pagamento_prevista: pag.forma,
    valor_recebido: pag.valorRecebido,
    itens,
  };
}

module.exports = { pedidoDo99, chaveDoItem };
