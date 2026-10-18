// Pedidos do site no fluxo de loja online (varejo, lv_fluxo = 'ecommerce'): gerenciados na Loja virtual (aba Pedidos do
// site), sem o modulo Pedidos. Usa as mesmas colunas do pedido:
//   novo (pago / a confirmar) -> em_preparo (em separacao) -> pronto (embalado | pronto para retirada)
//   -> saiu_entrega (enviado, com transportadora e rastreio) -> finalizado (entregue | retirado).
// Venda: pedido pago no site vira venda ao sair (enviado ou retirado), sem passar pelo caixa (forma 'online').
// Pedido a pagar na retirada/entrega vira venda ao finalizar, no caixa aberto da loja (como no balcao).
// pool: o banco da requisicao (producao ou o do modo teste).
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { registrarVenda } = require('./vendas');
const email = require('./email');
const frete = require('./frete');
const me = require('../integracoes/melhorenvio');

const n2 = (v) => Number(Number(v || 0).toFixed(2));
const FUSO = 'America/Sao_Paulo';

// Situacao para a tela (e os filtros).
const SITUACOES = {
  aguardando_pagamento: 'Aguardando pagamento',
  a_preparar: 'A preparar',
  em_separacao: 'Em separação',
  aguardando_envio: 'Embalado, aguardando envio',
  pronto_retirada: 'Pronto para retirada',
  enviado: 'Enviado',
  entregue: 'Entregue',
  retirado: 'Retirado',
  cancelado: 'Cancelado',
};
function situacao(o) {
  if (o.status === 'novo') return o.pagamento_online && o.pagamento_status !== 'aprovado' ? 'aguardando_pagamento' : 'a_preparar';
  if (o.status === 'em_preparo') return 'em_separacao';
  if (o.status === 'pronto') return o.tipo === 'entrega' ? 'aguardando_envio' : 'pronto_retirada';
  if (o.status === 'saiu_entrega') return 'enviado';
  if (o.status === 'finalizado') return o.tipo === 'entrega' ? 'entregue' : 'retirado';
  return 'cancelado';
}
// Filtro da lista -> SQL (sobre o alias o).
const FILTROS = {
  abertos: `o.status NOT IN ('finalizado', 'cancelado')`,
  aguardando_pagamento: `o.status = 'novo' AND o.pagamento_online IS NOT NULL AND o.pagamento_status IS DISTINCT FROM 'aprovado'`,
  a_preparar: `o.status = 'novo' AND (o.pagamento_online IS NULL OR o.pagamento_status = 'aprovado')`,
  em_separacao: `o.status = 'em_preparo'`,
  prontos: `o.status = 'pronto'`,
  enviados: `o.status = 'saiu_entrega'`,
  concluidos: `o.status = 'finalizado'`,
  cancelados: `o.status = 'cancelado'`,
  todos: 'true',
};

// Proxima etapa permitida (uma so, o fluxo e linear).
function proxima(o) {
  if (o.status === 'novo') return 'em_preparo';
  if (o.status === 'em_preparo') return 'pronto';
  if (o.status === 'pronto') return o.tipo === 'entrega' ? 'saiu_entrega' : 'finalizado';
  if (o.status === 'saiu_entrega') return 'finalizado';
  return null;
}
const ETIQUETA = { pending: 'no carrinho', released: 'paga, pronta para imprimir', posted: 'postada', delivered: 'entregue', canceled: 'cancelada', expired: 'expirada' };
const pagoNoSite = (o) => !!o.pagamento_online && o.pagamento_status === 'aprovado';

const SELECT = `
  SELECT o.id, o.numero, o.status, o.tipo, o.endereco, o.taxa_entrega, o.desconto, o.observacao, o.cliente_nome, o.cliente_telefone,
         o.forma_pagamento_prevista, o.troco_para, o.pago, o.pagamento_online, o.pagamento_status, o.cupom_codigo, o.sale_id, o.location_id,
         o.transportadora, o.rastreio_codigo, o.rastreio_url, o.enviado_em, o.criado_em, o.finalizado_em, o.cancelado_em, o.motivo_cancelamento,
         o.desconto_pix, o.maior_idade_declarada_em,
         o.frete_servico_id, o.frete_servico_nome, o.frete_prazo_dias, o.frete_custo, o.frete_destino, o.frete_volumes, o.me_envio_id, o.me_status, o.me_etiqueta_em,
         a.email AS cliente_email, s.numero AS venda_numero,
         COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS subtotal,
         (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS qtd_itens
  FROM orders o
  LEFT JOIN lv_contas a ON a.id = o.lv_conta_id
  LEFT JOIN sales s ON s.id = o.sale_id`;

function resumo(o) {
  const sit = situacao(o);
  return {
    id: o.id, numero: o.numero, situacao: sit, situacao_nome: SITUACOES[sit], status: o.status, tipo: o.tipo,
    cliente_nome: o.cliente_nome, cliente_telefone: o.cliente_telefone, cliente_email: o.cliente_email || null,
    itens: o.qtd_itens, subtotal: n2(o.subtotal), taxa_entrega: n2(o.taxa_entrega), desconto: n2(o.desconto),
    total: n2(Number(o.subtotal) + Number(o.taxa_entrega) - Number(o.desconto)),
    pagamento: o.pagamento_online
      ? { tipo: 'online', metodo: o.pagamento_online, situacao: o.pagamento_status }
      : { tipo: o.tipo === 'entrega' ? 'na_entrega' : 'na_retirada', forma: o.forma_pagamento_prevista, troco_para: o.troco_para === null ? null : n2(o.troco_para), pago: o.pago },
    rastreio: o.rastreio_codigo || o.transportadora ? { transportadora: o.transportadora, codigo: o.rastreio_codigo, url: o.rastreio_url } : null,
    // envio por transportadora (Melhor Envio): servico escolhido pelo cliente e a etiqueta
    frete: o.frete_servico_id ? {
      servico_id: o.frete_servico_id, servico: o.frete_servico_nome, prazo_dias: o.frete_prazo_dias, custo: o.frete_custo === null ? null : n2(o.frete_custo),
      etiqueta: o.me_envio_id && o.me_status !== 'canceled' ? { id: o.me_envio_id, status: o.me_status, nome_status: ETIQUETA[o.me_status] || o.me_status, comprada_em: o.me_etiqueta_em } : null,
    } : null,
    desconto_pix: n2(o.desconto_pix), // ja somado em desconto
    maior_idade_declarada_em: o.maior_idade_declarada_em || null,
    venda_numero: o.venda_numero || null,
    criado_em: o.criado_em, enviado_em: o.enviado_em, finalizado_em: o.finalizado_em, cancelado_em: o.cancelado_em,
    proxima: ['aguardando_pagamento', 'cancelado'].includes(sit) ? null : proxima(o),
    pode_cancelar: !['finalizado', 'cancelado'].includes(o.status) && !o.sale_id,
  };
}

async function listar(pool, tenantId, q = {}) {
  const filtro = FILTROS[q.situacao] ? q.situacao : 'abertos';
  const params = [tenantId];
  let where = `o.tenant_id = $1 AND o.lv_fluxo = 'ecommerce'`;
  if (q.busca && String(q.busca).trim()) {
    params.push(`%${String(q.busca).trim()}%`);
    where += ` AND (o.numero::text ILIKE $2 OR o.cliente_nome ILIKE $2 OR o.cliente_telefone ILIKE $2 OR o.rastreio_codigo ILIKE $2)`;
  }
  const pagina = Math.max(Number(q.pagina) || 1, 1);
  const { rows } = await pool.query(
    `${SELECT} WHERE ${where} AND ${FILTROS[filtro]}
     ORDER BY CASE WHEN o.status IN ('finalizado', 'cancelado') THEN 1 ELSE 0 END, o.criado_em ${filtro === 'abertos' ? 'ASC' : 'DESC'}
     LIMIT 50 OFFSET ${(pagina - 1) * 50}`,
    params
  );
  // Contadores dos filtros (sem a busca)
  const cont = (await pool.query(
    `SELECT ${Object.entries(FILTROS).map(([k, f]) => `COUNT(*) FILTER (WHERE ${f})::int AS ${k}`).join(', ')}
     FROM orders o WHERE o.tenant_id = $1 AND o.lv_fluxo = 'ecommerce'`,
    [tenantId]
  )).rows[0];
  return { situacao: filtro, pagina, contagem: cont, pedidos: rows.map(resumo) };
}

async function carregar(db, tenantId, id, travar = false) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new HttpError(404, 'pedido não encontrado');
  if (travar) await db.query(`SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tenantId]);
  const { rows } = await db.query(`${SELECT} WHERE o.id = $1 AND o.tenant_id = $2 AND o.lv_fluxo = 'ecommerce'`, [id, tenantId]);
  if (!rows[0]) throw new HttpError(404, 'pedido não encontrado');
  return rows[0];
}

async function detalhe(pool, tenantId, id) {
  const o = await carregar(pool, tenantId, id);
  const itens = (await pool.query(
    `SELECT oi.product_id, COALESCE(lp.nome_site, p.nome) AS nome, p.codigo_interno, p.barcode, oi.quantidade, p.unidade, oi.preco_unitario, oi.subtotal, oi.observacao,
            COALESCE(oi.complementos, '[]'::jsonb) AS complementos
     FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN lv_produtos lp ON lp.product_id = oi.product_id
     WHERE oi.order_id = $1 ORDER BY p.nome, oi.id`,
    [o.id]
  )).rows;
  const log = (await pool.query(
    `SELECT sl.de, sl.para, sl.criado_em, u.nome AS usuario_nome FROM order_status_log sl LEFT JOIN users u ON u.id = sl.usuario_id
     WHERE sl.order_id = $1 ORDER BY sl.criado_em, sl.id`,
    [o.id]
  )).rows;
  const pag = (await pool.query(
    `SELECT metodo, status, valor, parcelas, bandeira, final_cartao, aprovado_em, estornado_em FROM lv_pagamentos WHERE order_id = $1 AND status <> 'criando' ORDER BY criado_em DESC LIMIT 1`,
    [o.id]
  )).rows[0];
  const r = resumo(o);
  return {
    ...r,
    endereco: o.tipo === 'entrega' ? o.endereco : null,
    observacao: o.observacao, cupom: o.cupom_codigo, motivo_cancelamento: o.motivo_cancelamento,
    itens: itens.map((i) => ({
      product_id: i.product_id, nome: i.nome, codigo: i.codigo_interno || i.barcode || null, quantidade: Number(i.quantidade), unidade: i.unidade,
      preco_unitario: n2(i.preco_unitario), subtotal: n2(i.subtotal), observacao: i.observacao,
      complementos: (i.complementos || []).map((c) => ({ nome: c.nome, quantidade: c.quantidade })),
    })),
    pagamento: { ...r.pagamento, detalhe: pag ? { status: pag.status, valor: n2(pag.valor), parcelas: pag.parcelas, bandeira: pag.bandeira, final_cartao: pag.final_cartao, aprovado_em: pag.aprovado_em, estornado_em: pag.estornado_em } : null },
    historico: log.map((l) => ({ para: l.para, nome: l.para === 'cancelado' ? 'Cancelado' : SITUACOES[situacao({ ...o, status: l.para, pagamento_status: 'aprovado' })], em: l.criado_em, por: l.usuario_nome })),
  };
}

// Rastreio: transportadora (texto), codigo e link (http/https). Tudo opcional, mas ao menos a transportadora.
function dadosRastreio(b) {
  const transportadora = String(b.transportadora || '').trim().slice(0, 60);
  const codigo = String(b.rastreio_codigo || '').trim().slice(0, 60);
  const url = String(b.rastreio_url || '').trim().slice(0, 300);
  if (!transportadora) throw new HttpError(400, 'informe a transportadora (ex.: Correios, entrega própria)');
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, 'link de rastreio inválido (comece com https://)');
  return { transportadora, codigo: codigo || null, url: url || null };
}

// Gera a venda do pedido (dentro da transacao). Pago no site: sem caixa. Senao: caixa aberto da loja e a forma recebida.
async function vender(client, user, o, b) {
  const itens = (await client.query(`SELECT product_id, quantidade, observacao, preco_unitario, complementos FROM order_items WHERE order_id = $1`, [o.id])).rows;
  const online = pagoNoSite(o);
  let terminalId = null;
  let forma = 'online';
  if (!online) {
    terminalId = b.terminal_id || null;
    if (!terminalId) {
      const cx = await client.query(
        `SELECT t.id FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id JOIN terminals t ON t.id = cr.terminal_id
         WHERE t.location_id = $1 AND t.tenant_id = $2 AND t.ativo AND cs.fechado_em IS NULL
         ORDER BY (cs.usuario_abertura_id = $3) DESC, cs.aberto_em DESC LIMIT 1`,
        [o.location_id, user.tenantId, user.id]
      );
      if (cx.rows.length === 0) throw new HttpError(400, 'pedido a receber na loja: abra o caixa no PDV para registrar o pagamento');
      terminalId = cx.rows[0].id;
    }
    const prev = o.forma_pagamento_prevista;
    forma = b.forma_pagamento || (prev === 'cartao' ? null : prev);
    if (!forma) throw new HttpError(400, 'informe a forma de pagamento recebida (crédito ou débito)');
  }
  return registrarVenda(client, user, {
    ...(online ? { sem_caixa: true, location_id: o.location_id } : { terminal_id: terminalId }),
    itens: itens.map((i) => ({ product_id: i.product_id, quantidade: Number(i.quantidade), observacao: i.observacao, complementos: Array.isArray(i.complementos) ? i.complementos : [], preco_unitario: Number(i.preco_unitario) })),
    forma_pagamento: forma,
    valor_recebido: forma === 'dinheiro' ? (b.valor_recebido !== undefined ? b.valor_recebido : (o.troco_para === null ? undefined : Number(o.troco_para))) : undefined,
    desconto: Number(o.desconto || 0),
    precos_informados: true,
    taxa_entrega: Number(o.taxa_entrega),
    numero_pedido: o.numero,
    ignorar_pedido_id: o.id,
  });
}

// Avanca uma etapa. b: { para, transportadora, rastreio_codigo, rastreio_url, forma_pagamento, terminal_id, valor_recebido }
async function avancar(pool, user, id, b = {}) {
  const client = await pool.connect();
  let o;
  try {
    await client.query('BEGIN');
    o = await carregar(client, user.tenantId, id, true);
    const para = proxima(o);
    if (!para || b.para !== para) throw new HttpError(409, `não é possível ir de "${SITUACOES[situacao(o)]}" para "${b.para}" neste pedido`);
    if (o.pagamento_online && o.pagamento_status !== 'aprovado') throw new HttpError(409, 'aguardando o pagamento do cliente no site');
    let rastreio = null;
    if (para === 'saiu_entrega') {
      // etiqueta do Melhor Envio: transportadora e codigo ja vem da etiqueta (o lojista pode corrigir)
      if (o.me_envio_id && o.me_status !== 'canceled' && !b.transportadora) {
        const codigo = b.rastreio_codigo || o.rastreio_codigo || null;
        b = { ...b, transportadora: o.frete_servico_nome || 'Transportadora', rastreio_codigo: codigo, rastreio_url: b.rastreio_url || me.urlRastreio(codigo) };
      }
      rastreio = dadosRastreio(b);
    }
    let saleId = o.sale_id;
    // Vira venda quando a mercadoria sai: pago no site ao enviar/retirar; a pagar, ao finalizar (recebido).
    if (!saleId && (para === 'finalizado' || (para === 'saiu_entrega' && pagoNoSite(o)))) {
      saleId = (await vender(client, user, o, b)).id;
    }
    await client.query(
      `UPDATE orders SET status = $2, sale_id = $3, pago = CASE WHEN $3::uuid IS NOT NULL THEN true ELSE pago END, atualizado_em = now(),
              transportadora = COALESCE($4, transportadora), rastreio_codigo = CASE WHEN $4 IS NOT NULL THEN $5 ELSE rastreio_codigo END,
              rastreio_url = CASE WHEN $4 IS NOT NULL THEN $6 ELSE rastreio_url END,
              enviado_em = CASE WHEN $2 = 'saiu_entrega' THEN now() ELSE enviado_em END,
              finalizado_em = CASE WHEN $2 = 'finalizado' THEN now() ELSE finalizado_em END
       WHERE id = $1`,
      [o.id, para, saleId, rastreio ? rastreio.transportadora : null, rastreio ? rastreio.codigo : null, rastreio ? rastreio.url : null]
    );
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, $3, $4)`, [o.id, o.status, para, user.id]);
    await logAudit(client, {
      tenantId: user.tenantId, usuarioId: user.id, acao: 'pedido_site_etapa', recurso: 'orders', recursoId: o.id,
      detalhes: { numero: o.numero, de: o.status, para, sale_id: saleId, ...(rastreio ? { rastreio } : {}) },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const atual = await detalhe(pool, user.tenantId, id);
  if (!user.modoTeste) avisarCliente(pool, user.tenantId, atual).catch((err) => console.error('loja virtual: e-mail do pedido', err.message));
  return atual;
}

// Corrige transportadora/rastreio de pedido ja enviado.
async function atualizarRastreio(pool, user, id, b = {}) {
  const o = await carregar(pool, user.tenantId, id);
  if (!['saiu_entrega', 'finalizado'].includes(o.status) || o.tipo !== 'entrega') throw new HttpError(409, 'o rastreio é informado ao enviar o pedido');
  const r = dadosRastreio(b);
  await pool.query(`UPDATE orders SET transportadora = $2, rastreio_codigo = $3, rastreio_url = $4, atualizado_em = now() WHERE id = $1`, [o.id, r.transportadora, r.codigo, r.url]);
  await logAudit(pool, { tenantId: user.tenantId, usuarioId: user.id, acao: 'pedido_site_rastreio', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, ...r } });
  const atual = await detalhe(pool, user.tenantId, id);
  if (!user.modoTeste && b.avisar_cliente) avisarCliente(pool, user.tenantId, atual, true).catch((err) => console.error('loja virtual: e-mail do pedido', err.message));
  return atual;
}

// E-mail ao cliente quando o pedido fica pronto para retirada ou e enviado (com o rastreio).
async function avisarCliente(pool, tenantId, p, rastreioCorrigido = false) {
  if (!p.cliente_email || !email.disponivel()) return;
  if (!['enviado', 'pronto_retirada'].includes(p.situacao) && !rastreioCorrigido) return;
  const loja = (await pool.query(`SELECT nome, endereco, whatsapp FROM lv_lojas WHERE tenant_id = $1`, [tenantId])).rows[0];
  if (!loja) return;
  const linhas = [`Olá, ${String(p.cliente_nome || '').split(' ')[0] || 'cliente'}!`, ''];
  let assunto;
  if (p.situacao === 'pronto_retirada') {
    assunto = `Pedido nº ${p.numero} pronto para retirada`;
    linhas.push(`Seu pedido nº ${p.numero} está pronto para retirada${loja.endereco ? ` em ${loja.endereco}` : ''}.`);
  } else {
    assunto = rastreioCorrigido ? `Pedido nº ${p.numero}: rastreio atualizado` : `Pedido nº ${p.numero} enviado`;
    linhas.push(`Seu pedido nº ${p.numero} foi enviado${p.rastreio && p.rastreio.transportadora ? ` por ${p.rastreio.transportadora}` : ''}.`);
    if (p.rastreio && p.rastreio.codigo) linhas.push(`Código de rastreio: ${p.rastreio.codigo}`);
    if (p.rastreio && p.rastreio.url) linhas.push(`Acompanhe: ${p.rastreio.url}`);
  }
  linhas.push('', `Obrigado por comprar na ${loja.nome}!`);
  await email.enviar({ para: p.cliente_email, assunto, texto: linhas.join('\n'), nomeRemetente: loja.nome });
}

// Cancelamento no modo teste (sem estorno real; o de producao passa pelo servico da loja, que estorna o pagamento).
async function cancelarTeste(pool, user, id, motivo) {
  const o = await carregar(pool, user.tenantId, id);
  if (['finalizado', 'cancelado'].includes(o.status) || o.sale_id) throw new HttpError(409, 'este pedido não pode mais ser cancelado');
  await pool.query(`UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $2, atualizado_em = now() WHERE id = $1`, [o.id, motivo]);
  await pool.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', $3)`, [o.id, o.status, user.id]);
}

// ---------- etiqueta (Melhor Envio) ----------
// Compra a etiqueta do servico que o cliente escolheu (saldo da conta do lojista). Depois de separado e pago.
async function comprarEtiqueta(pool, user, loja, id, b = {}) {
  const o = await carregar(pool, user.tenantId, id);
  if (!['em_preparo', 'pronto'].includes(o.status)) throw new HttpError(409, 'compre a etiqueta depois de iniciar a separação (e antes de enviar)');
  if (o.pagamento_online && o.pagamento_status !== 'aprovado') throw new HttpError(409, 'aguardando o pagamento do cliente');
  const r = await frete.comprarEtiqueta(pool, loja, o, { nfe: b.nfe });
  await pool.query(
    `UPDATE orders SET me_envio_id = $2, me_status = $3, me_etiqueta_em = now(), rastreio_codigo = COALESCE($4, rastreio_codigo), atualizado_em = now() WHERE id = $1`,
    [o.id, r.id, r.status || 'released', r.codigo || null]
  );
  await logAudit(pool, { tenantId: user.tenantId, usuarioId: user.id, acao: 'pedido_site_etiqueta', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, me_envio_id: r.id, servico: o.frete_servico_nome } });
  return detalhe(pool, user.tenantId, id);
}
async function linkEtiqueta(pool, user, loja, id) {
  const o = await carregar(pool, user.tenantId, id);
  if (!o.me_envio_id || o.me_status === 'canceled') throw new HttpError(404, 'este pedido não tem etiqueta');
  try {
    return await me.linkEtiqueta(frete.cfgMe(loja), o.me_envio_id);
  } catch (err) {
    throw new HttpError(502, err.message);
  }
}
// Cancela a etiqueta ainda nao postada (o valor volta para o saldo do Melhor Envio). Usado ao cancelar o pedido.
async function cancelarEtiqueta(pool, user, loja, id, motivo) {
  const o = await carregar(pool, user.tenantId, id);
  if (!o.me_envio_id || ['canceled'].includes(o.me_status)) return false;
  if (['posted', 'delivered'].includes(o.me_status)) throw new HttpError(409, 'a etiqueta já foi postada: não dá para cancelar o pedido aqui');
  try {
    await me.cancelarEtiqueta(frete.cfgMe(loja), o.me_envio_id, motivo);
  } catch (err) {
    throw new HttpError(502, `não foi possível cancelar a etiqueta no Melhor Envio: ${err.message}`);
  }
  await pool.query(`UPDATE orders SET me_status = 'canceled', rastreio_codigo = NULL, atualizado_em = now() WHERE id = $1`, [o.id]);
  return true;
}

module.exports = { listar, detalhe, avancar, atualizarRastreio, cancelarTeste, carregar, situacao, comprarEtiqueta, linkEtiqueta, cancelarEtiqueta, SITUACOES, ETIQUETA, FUSO };
