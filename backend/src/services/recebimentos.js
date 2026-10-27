// Garcom, Fase 2: recebimentos feitos pelo garcom no app, fechamento da comanda com pagamentos parciais/divididos e prestacao de
// contas do dinheiro. Tudo roda dentro da transacao do chamador (client ja em BEGIN) e com a comanda travada (FOR UPDATE).
//
// Dinheiro e caixa: o dinheiro que o garcom recebe NAO entra no caixa da venda (sale_payments.entra_no_caixa = false). Ele so passa
// a contar quando o garcom presta contas no caixa: a prestacao cria um SUPRIMENTO na sessao aberta (cash_movements) pelo valor
// conferido. Assim o "caixa esperado" = inicial + dinheiro que entrou no caixa (venda) + suprimentos (inclui prestacoes) - sangrias.
//
// Ponto de extensao para maquininha/Pix: confirmarRecebimento() e a unica porta de entrada de um recebimento. Hoje o garcom
// confirma na mao (provider 'manual'); no futuro um provedor (ex.: 'mercadopago_point', 'pix_psp') chama a mesma funcao ao
// receber a confirmacao automatica, informando provider e provider_ref.
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const { logAudit } = require('../utils/audit');
const { registrarVenda } = require('./vendas');

const FORMAS_APP = ['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'];
const chaveDaForma = (forma) => (String(forma).startsWith('cartao') ? 'cartao' : forma);
const centavos = (v) => Math.round(Number(v) * 100);
const dinheiro = (v) => Number(Number(v).toFixed(2));

async function configDaLoja(db, locationId) {
  const { rows } = await db.query(`SELECT taxa_servico_pct, garcom_recebe, garcom_formas, terminal_comandas_id FROM locations WHERE id = $1`, [locationId]);
  const l = rows[0] || {};
  const f = l.garcom_formas || {};
  return {
    taxa_servico_pct: Number(l.taxa_servico_pct === undefined ? 10 : l.taxa_servico_pct),
    garcom_recebe: !!l.garcom_recebe,
    formas: { pix: f.pix !== false, cartao: f.cartao !== false, dinheiro: f.dinheiro !== false },
    terminal_comandas_id: l.terminal_comandas_id || null,
  };
}

// Rodadas ativas (nao canceladas) da comanda com o total de cada uma e o recebimento que a quitou (se houver).
async function rodadasDaComanda(db, comandaId, { travar = false } = {}) {
  if (travar) await db.query(`SELECT id FROM orders WHERE comanda_id = $1 AND status <> 'cancelado' ORDER BY id FOR UPDATE`, [comandaId]);
  const { rows } = await db.query(
    `SELECT o.id, o.rodada, o.status, COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS total, r.pagamento_id
     FROM orders o LEFT JOIN comanda_pagamento_rodadas r ON r.order_id = o.id
     WHERE o.comanda_id = $1 AND o.status <> 'cancelado' ORDER BY o.rodada`,
    [comandaId]
  );
  return rows.map((r) => ({ ...r, total: dinheiro(r.total) }));
}

// ---------------------------------------------------------------- receber
// opcoes: { order_ids, forma, cobrar_taxa, valor_recebido, provider, provider_ref }
async function confirmarRecebimento(client, user, comanda, opcoes) {
  const { order_ids: ids, forma, cobrar_taxa: cobrarTaxa, valor_recebido: recebidoInformado } = opcoes;
  const provider = opcoes.provider || 'manual';
  if (!['aberta', 'fechamento_solicitado'].includes(comanda.status)) throw new HttpError(409, 'esta comanda está encerrada');
  if (!FORMAS_APP.includes(forma)) throw new HttpError(400, 'forma de pagamento inválida: use pix, cartao_credito, cartao_debito ou dinheiro');
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => !isUuid(i))) throw new HttpError(400, 'escolha as rodadas que serão pagas');
  const cfg = await configDaLoja(client, comanda.location_id);
  if (!cfg.garcom_recebe) throw new HttpError(403, 'esta loja não permite o garçom receber no app');
  if (!cfg.formas[chaveDaForma(forma)]) throw new HttpError(403, `esta loja não libera o recebimento em ${forma === 'dinheiro' ? 'dinheiro' : forma === 'pix' ? 'Pix' : 'cartão'} no app`);

  const rodadas = await rodadasDaComanda(client, comanda.id, { travar: true });
  const unicos = [...new Set(ids)];
  const escolhidas = unicos.map((id) => rodadas.find((r) => r.id === id));
  if (escolhidas.some((r) => !r)) throw new HttpError(400, 'alguma rodada não pertence a esta comanda (ou foi cancelada)');
  const jaPaga = escolhidas.find((r) => r.pagamento_id);
  if (jaPaga) throw new HttpError(409, `a rodada ${jaPaga.rodada} já foi paga`);
  const valorProdutos = dinheiro(escolhidas.reduce((s, r) => s + r.total, 0));
  if (!(valorProdutos > 0)) throw new HttpError(400, 'as rodadas escolhidas não têm valor a receber');
  const taxa = cobrarTaxa ? dinheiro(valorProdutos * cfg.taxa_servico_pct / 100) : 0;
  const total = dinheiro(valorProdutos + taxa);

  let recebido = null;
  let troco = null;
  if (forma === 'dinheiro') {
    recebido = recebidoInformado === undefined || recebidoInformado === null || recebidoInformado === '' ? total : Number(recebidoInformado);
    if (!(recebido >= total)) throw new HttpError(400, `valor recebido (${recebido}) deve ser maior ou igual ao total (${total.toFixed(2)})`);
    recebido = dinheiro(recebido);
    troco = dinheiro(recebido - total);
  }
  const { rows } = await client.query(
    `INSERT INTO comanda_pagamentos (tenant_id, comanda_id, location_id, valor_produtos, taxa_servico, forma, valor_recebido, troco, recebido_por, provider, provider_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [user.tenantId, comanda.id, comanda.location_id, valorProdutos, taxa, forma, recebido, troco, user.id, provider, opcoes.provider_ref || null]
  );
  const pag = rows[0];
  for (const r of escolhidas) {
    // UNIQUE(order_id): se outra requisicao quitou a mesma rodada ao mesmo tempo, esta falha (23505 -> 409 no chamador).
    await client.query(`INSERT INTO comanda_pagamento_rodadas (pagamento_id, order_id) VALUES ($1, $2)`, [pag.id, r.id]);
  }
  await logAudit(client, {
    tenantId: user.tenantId, usuarioId: user.id, acao: 'receber_comanda', recurso: 'comandas', recursoId: comanda.id,
    detalhes: { pagamento_id: pag.id, forma, valor_produtos: valorProdutos, taxa_servico: taxa, total, rodadas: escolhidas.map((r) => r.rodada), provider },
  });
  return { ...pag, valor_produtos: valorProdutos, taxa_servico: taxa, total, troco };
}

async function estornarRecebimento(client, user, comanda, pagamentoId, motivo) {
  const texto = String(motivo || '').trim();
  if (texto.length < 3) throw new HttpError(400, 'informe o motivo do estorno (mínimo 3 caracteres)');
  if (!isUuid(pagamentoId)) throw new HttpError(404, 'recebimento não encontrado');
  if (!['aberta', 'fechamento_solicitado'].includes(comanda.status)) throw new HttpError(409, 'a comanda já foi encerrada: cancele a venda para estornar');
  const { rows } = await client.query(`SELECT * FROM comanda_pagamentos WHERE id = $1 AND comanda_id = $2 AND tenant_id = $3 FOR UPDATE`, [pagamentoId, comanda.id, user.tenantId]);
  const p = rows[0];
  if (!p) throw new HttpError(404, 'recebimento não encontrado');
  if (p.status === 'estornado') throw new HttpError(409, 'este recebimento já foi estornado');
  if (p.forma === 'dinheiro' && p.prestado_em) throw new HttpError(409, 'o dinheiro deste recebimento já foi entregue ao caixa (prestação de contas): não dá para estornar por aqui');
  await client.query(`UPDATE comanda_pagamentos SET status = 'estornado', estornado_por = $1, estornado_em = now(), motivo_estorno = $2 WHERE id = $3`, [user.id, texto, p.id]);
  await client.query(`DELETE FROM comanda_pagamento_rodadas WHERE pagamento_id = $1`, [p.id]); // libera as rodadas
  await logAudit(client, {
    tenantId: user.tenantId, usuarioId: user.id, acao: 'estornar_recebimento_comanda', recurso: 'comandas', recursoId: comanda.id,
    detalhes: { pagamento_id: p.id, forma: p.forma, valor: dinheiro(Number(p.valor_produtos) + Number(p.taxa_servico)), motivo: texto },
  });
  return { ...p, status: 'estornado' };
}

// ---------------------------------------------------------------- fechar / encerrar
// Cobra o RESTANTE da comanda (rodadas nao quitadas no app) e gera UMA venda com todos os itens; os recebimentos do app viram
// partes pagas da venda (sale_payments). opcoes: { terminalId, pagamentos [{ forma, valor, valor_recebido? }] | forma_pagamento (+ valor_recebido),
// desconto, cobrar_taxa }. Regras:
//  - desconto so vale sobre o restante (o que o app ja cobrou nao muda); sem restante, desconto > 0 e recusado;
//  - taxa de servico opcional sobre o restante (apos o desconto), na % da loja; a taxa ja cobrada no app entra no total;
//  - total da venda = itens de todas as rodadas - desconto + taxa (app + restante).
async function fecharComanda(client, user, comanda, opcoes) {
  if (!['aberta', 'fechamento_solicitado'].includes(comanda.status)) throw new HttpError(409, comanda.status === 'paga' ? 'esta comanda já foi paga' : 'esta comanda está cancelada');
  const rodadas = await rodadasDaComanda(client, comanda.id, { travar: true });
  if (rodadas.length === 0) throw new HttpError(409, 'a comanda não tem pedidos para cobrar: cancele-a');
  const cfg = await configDaLoja(client, comanda.location_id);
  const app = (await client.query(`SELECT * FROM comanda_pagamentos WHERE comanda_id = $1 AND status = 'confirmado' ORDER BY recebido_em FOR UPDATE`, [comanda.id])).rows;
  const restante = dinheiro(rodadas.filter((r) => !r.pagamento_id).reduce((s, r) => s + r.total, 0));
  const desconto = dinheiro(opcoes.desconto || 0);
  if (!(desconto >= 0)) throw new HttpError(400, 'desconto deve ser um valor em reais (0 ou mais)');
  if (desconto > 0 && !(restante > 0)) throw new HttpError(400, 'não há o que descontar: tudo já foi pago no app');
  if (desconto > 0 && desconto >= restante) throw new HttpError(400, `desconto (${desconto}) deve ser menor que o restante da comanda (${restante})`);
  const taxaRestante = opcoes.cobrar_taxa && restante > 0 ? dinheiro((restante - desconto) * cfg.taxa_servico_pct / 100) : 0;
  const aCobrar = dinheiro(restante - desconto + taxaRestante);
  const taxaApp = dinheiro(app.reduce((s, p) => s + Number(p.taxa_servico), 0));

  // Terminal e caixa aberto (a venda entra na sessao dele).
  if (!isUuid(opcoes.terminalId)) throw new HttpError(400, 'escolha o terminal (caixa) da venda');
  const term = (await client.query(`SELECT id, location_id, ativo FROM terminals WHERE id = $1 AND tenant_id = $2`, [opcoes.terminalId, user.tenantId])).rows[0];
  if (!term) throw new HttpError(404, 'terminal não encontrado');
  if (term.location_id !== comanda.location_id) throw new HttpError(409, 'este terminal é de outra loja: escolha um caixa da loja da comanda');
  const cx = await client.query(
    `SELECT 1 FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE cr.terminal_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL`, [term.id, user.tenantId]
  );
  if (cx.rows.length === 0) throw new HttpError(409, opcoes.origem === 'garcom' ? 'abra o caixa para encerrar a comanda: o recebimento já feito não se perde' : 'caixa fechado neste terminal: abra o caixa no PDV para receber a comanda');

  // Pagamentos do caixa (so o restante).
  let pagCaixa = [];
  if (aCobrar > 0) {
    if (Array.isArray(opcoes.pagamentos) && opcoes.pagamentos.length > 0) {
      pagCaixa = opcoes.pagamentos.map((p) => ({ forma: p && p.forma, valor: dinheiro(p && p.valor), valor_recebido: p ? p.valor_recebido : undefined, entra_no_caixa: true }));
    } else if (opcoes.forma_pagamento) {
      pagCaixa = [{ forma: opcoes.forma_pagamento, valor: aCobrar, valor_recebido: opcoes.valor_recebido, entra_no_caixa: true }];
    } else {
      throw new HttpError(400, `informe como o restante (${aCobrar.toFixed(2)}) será pago`);
    }
    if (pagCaixa.some((p) => p.forma === 'online')) throw new HttpError(400, 'forma de pagamento inválida');
    if (pagCaixa.reduce((s, p) => s + centavos(p.valor), 0) !== centavos(aCobrar)) throw new HttpError(400, `a soma dos pagamentos deve ser igual ao restante a cobrar (${aCobrar.toFixed(2)})`);
  } else if (Array.isArray(opcoes.pagamentos) && opcoes.pagamentos.length > 0) {
    throw new HttpError(400, 'nada a cobrar no caixa: a comanda já está toda paga');
  }

  const itens = (await client.query(
    `SELECT oi.product_id, oi.quantidade, oi.observacao, oi.complementos, oi.garcom_id, oi.preco_unitario
     FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.comanda_id = $1 AND o.status <> 'cancelado' ORDER BY o.rodada, oi.id`, [comanda.id]
  )).rows;
  const pagamentos = [
    ...app.map((p) => ({ forma: p.forma, valor: dinheiro(Number(p.valor_produtos) + Number(p.taxa_servico)), comanda_pagamento_id: p.id, recebido_por: p.recebido_por, entra_no_caixa: false })),
    ...pagCaixa,
  ];
  const venda = await registrarVenda(client, user, {
    terminal_id: term.id,
    // Preco de cada item = o do pedido (o que o cliente viu e o que o app ja pode ter cobrado): a conta nao muda se o cadastro mudou.
    itens: itens.map((i) => ({ product_id: i.product_id, quantidade: Number(i.quantidade), observacao: i.observacao, preco_unitario: Number(i.preco_unitario), complementos: Array.isArray(i.complementos) ? i.complementos : [], garcom_id: i.garcom_id })),
    precos_informados: true,
    desconto, taxa_servico: dinheiro(taxaApp + taxaRestante), pagamentos,
    numero_pedido: comanda.numero, ignorar_pedidos_ids: rodadas.map((r) => r.id), comanda_id: comanda.id,
  });
  for (const r of rodadas) {
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'finalizado', $3)`, [r.id, r.status, user.id]);
  }
  await client.query(`UPDATE orders SET status = 'finalizado', sale_id = $1, pago = true, finalizado_em = now(), atualizado_em = now() WHERE id = ANY($2::uuid[])`, [venda.id, rodadas.map((r) => r.id)]);
  await client.query(`UPDATE comandas SET status = 'paga', sale_id = $1, fechada_em = now(), fechada_por = $2 WHERE id = $3`, [venda.id, user.id, comanda.id]);
  await logAudit(client, {
    tenantId: user.tenantId, usuarioId: user.id, acao: 'fechar_comanda', recurso: 'comandas', recursoId: comanda.id,
    detalhes: { identificador: comanda.identificador, sale_id: venda.id, total: venda.total, rodadas: rodadas.length, pago_no_app: app.length, restante: aCobrar, desconto, taxa_servico: dinheiro(taxaApp + taxaRestante), por: opcoes.origem || 'caixa', formas: pagamentos.map((p) => `${p.forma}:${p.valor}`) },
  });
  return venda;
}

// Terminal para encerrar uma comanda toda paga (sem passar pelo caixa): o terminal de comandas da loja ou, se nao houver,
// um terminal da loja com caixa aberto.
async function terminalParaEncerrar(client, user, comanda) {
  const cfg = await configDaLoja(client, comanda.location_id);
  if (cfg.terminal_comandas_id) {
    const t = (await client.query(`SELECT id FROM terminals WHERE id = $1 AND tenant_id = $2 AND location_id = $3 AND ativo`, [cfg.terminal_comandas_id, user.tenantId, comanda.location_id])).rows[0];
    if (t) return t.id;
  }
  const t = (await client.query(
    `SELECT t.id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id JOIN terminals t ON t.id = cr.terminal_id
     WHERE t.location_id = $1 AND t.tenant_id = $2 AND t.ativo AND cs.fechado_em IS NULL ORDER BY cs.aberto_em DESC LIMIT 1`, [comanda.location_id, user.tenantId]
  )).rows[0];
  if (!t) throw new HttpError(409, 'abra o caixa para encerrar a comanda: o recebimento já feito não se perde, a comanda fica quitada aguardando encerrar');
  return t.id;
}

// ---------------------------------------------------------------- prestacao de contas
// Dinheiro recebido pelo garcom e ainda nao entregue ao caixa, por garcom (so recebimentos confirmados).
async function pendenciasDeDinheiro(db, tenantId, { garcomId = null, locais = null } = {}) {
  const { rows } = await db.query(
    `SELECT p.id, p.comanda_id, c.numero AS comanda_numero, c.identificador, c.status AS comanda_status, p.recebido_por AS garcom_id, u.nome AS garcom_nome,
            p.recebido_em, p.valor_produtos, p.taxa_servico, (p.valor_produtos + p.taxa_servico) AS total, p.valor_recebido, p.troco
     FROM comanda_pagamentos p JOIN comandas c ON c.id = p.comanda_id JOIN users u ON u.id = p.recebido_por
     WHERE p.tenant_id = $1 AND p.forma = 'dinheiro' AND p.status = 'confirmado' AND p.prestado_em IS NULL
       AND ($2::uuid IS NULL OR p.recebido_por = $2::uuid) AND ($3::uuid[] IS NULL OR p.location_id = ANY($3::uuid[]))
     ORDER BY u.nome, p.recebido_em`,
    [tenantId, garcomId, locais]
  );
  return rows.map((r) => ({ ...r, total: dinheiro(r.total) }));
}

// Recebe a prestacao: valor conferido (o que o garcom entregou) vs esperado. Cria um SUPRIMENTO na sessao de caixa aberta do
// terminal (so se o valor conferido for > 0) e grava a diferenca (sobra/falta) por recebimento, proporcional ao valor.
async function receberPrestacao(client, user, { garcomId, valorConferido, terminalId, pagamentoIds, locais }) {
  if (!isUuid(garcomId)) throw new HttpError(400, 'escolha o garçom');
  const conferido = dinheiro(valorConferido);
  if (!(conferido >= 0) || Number.isNaN(Number(valorConferido))) throw new HttpError(400, 'informe o valor conferido (0 ou mais)');
  if (!isUuid(terminalId)) throw new HttpError(400, 'escolha o terminal (caixa) que recebe o dinheiro');
  const term = (await client.query(`SELECT id, location_id FROM terminals WHERE id = $1 AND tenant_id = $2`, [terminalId, user.tenantId])).rows[0];
  if (!term) throw new HttpError(404, 'terminal não encontrado');
  if (locais && !locais.includes(term.location_id)) throw new HttpError(403, 'seu usuário está vinculado a outra loja');
  const sessao = (await client.query(
    `SELECT cs.id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id WHERE cr.terminal_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL FOR UPDATE OF cs`, [term.id, user.tenantId]
  )).rows[0];
  if (!sessao) throw new HttpError(409, 'caixa fechado neste terminal: abra o caixa para receber a prestação de contas');

  // Trava e pega os recebimentos pendentes desse garcom (so da loja do terminal).
  const trava = await client.query(
    `SELECT p.id, p.valor_produtos, p.taxa_servico FROM comanda_pagamentos p
     WHERE p.tenant_id = $1 AND p.recebido_por = $2 AND p.forma = 'dinheiro' AND p.status = 'confirmado' AND p.prestado_em IS NULL AND p.location_id = $3
       AND ($4::uuid[] IS NULL OR p.id = ANY($4::uuid[])) ORDER BY p.recebido_em FOR UPDATE`,
    [user.tenantId, garcomId, term.location_id, Array.isArray(pagamentoIds) && pagamentoIds.length ? pagamentoIds : null]
  );
  const itens = trava.rows.map((r) => ({ id: r.id, total: dinheiro(Number(r.valor_produtos) + Number(r.taxa_servico)) }));
  if (itens.length === 0) throw new HttpError(409, 'não há dinheiro pendente deste garçom nesta loja');
  const esperado = dinheiro(itens.reduce((s, i) => s + i.total, 0));
  const diferenca = dinheiro(conferido - esperado);
  let movimentoId = null;
  if (conferido > 0) {
    const mov = await client.query(
      `INSERT INTO cash_movements (tenant_id, cash_session_id, tipo, valor, motivo, usuario_id)
       VALUES ($1, $2, 'suprimento', $3, $4, $5) RETURNING id`,
      [user.tenantId, sessao.id, conferido, `Prestação de contas do garçom (${itens.length} recebimento(s) em dinheiro)`, user.id]
    );
    movimentoId = mov.rows[0].id;
  }
  // diferenca proporcional ao valor de cada recebimento; o ultimo leva o arredondamento
  let restanteDif = centavos(diferenca);
  for (let i = 0; i < itens.length; i++) {
    const parte = i === itens.length - 1 ? restanteDif : Math.round(centavos(diferenca) * (itens[i].total / esperado));
    restanteDif -= parte;
    await client.query(
      `UPDATE comanda_pagamentos SET prestado_em = now(), prestado_por = $1, cash_session_id = $2, cash_movement_id = $3, diferenca_prestacao = $4 WHERE id = $5`,
      [user.id, sessao.id, movimentoId, parte / 100, itens[i].id]
    );
  }
  await logAudit(client, {
    tenantId: user.tenantId, usuarioId: user.id, acao: 'prestacao_contas_garcom', recurso: 'comanda_pagamentos', recursoId: itens[0].id,
    detalhes: { garcom_id: garcomId, esperado, conferido, diferenca, recebimentos: itens.length, cash_session_id: sessao.id },
  });
  return { esperado, conferido, diferenca, recebimentos: itens.length, cash_session_id: sessao.id, cash_movement_id: movimentoId };
}

// Quando uma venda de comanda e cancelada: os recebimentos do garcom nela viram "estornado" (saem da prestacao); se o dinheiro ja
// tinha sido entregue ao caixa, o valor volta ao cliente pelo caixa: sangria na sessao aberta da venda.
async function estornarRecebimentosDaVenda(client, user, sale) {
  const { rows } = await client.query(
    `SELECT cp.id, cp.forma, cp.prestado_em, cp.valor_produtos, cp.taxa_servico
     FROM sale_payments sp JOIN comanda_pagamentos cp ON cp.id = sp.comanda_pagamento_id
     WHERE sp.sale_id = $1 AND sp.tenant_id = $2 AND cp.status = 'confirmado' FOR UPDATE OF cp`, [sale.id, user.tenantId]
  );
  if (rows.length === 0) return { recebimentos: 0, sangria: 0 };
  let sangria = 0;
  for (const p of rows) {
    if (p.forma === 'dinheiro' && p.prestado_em) sangria += Number(p.valor_produtos) + Number(p.taxa_servico);
    await client.query(`UPDATE comanda_pagamentos SET status = 'estornado', estornado_por = $1, estornado_em = now(), motivo_estorno = $2 WHERE id = $3`, [user.id, `venda nº ${sale.numero} cancelada`, p.id]);
  }
  sangria = dinheiro(sangria);
  if (sangria > 0) {
    await client.query(
      `INSERT INTO cash_movements (tenant_id, cash_session_id, tipo, valor, motivo, usuario_id) VALUES ($1, $2, 'sangria', $3, $4, $5)`,
      [user.tenantId, sale.cash_session_id, sangria, `Estorno da venda nº ${sale.numero}: dinheiro entregue pelo garçom devolvido ao cliente`, user.id]
    );
  }
  return { recebimentos: rows.length, sangria };
}

module.exports = {
  FORMAS_APP, chaveDaForma, configDaLoja, rodadasDaComanda, confirmarRecebimento, estornarRecebimento, fecharComanda, terminalParaEncerrar,
  pendenciasDeDinheiro, receberPrestacao, estornarRecebimentosDaVenda,
};
