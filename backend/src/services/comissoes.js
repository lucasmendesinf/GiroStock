// Comissoes do garcom (Fase 3): calculo por item, estornos, bonus por meta e acertos.
//
// REGRAS DE CALCULO (tudo em CENTAVOS inteiros; arredonda por item, meio centavo para cima, e soma):
//  - A comissao NASCE quando o dinheiro entra: no recebimento confirmado no app (origem 'recebimento') ou no fechamento da comanda
//    (origem 'fechamento', so das rodadas que o app ainda nao tinha cobrado). Comanda aberta/cancelada nao gera.
//  - Um lancamento por ITEM (order_items.garcom_id = quem lancou). Transferir a comanda nao muda o dono do item.
//  - base_valor = subtotal do item (base "liquida": menos a parte do desconto do fechamento rateada entre os itens do fechamento,
//    por maior resto, proporcional ao subtotal; base "bruta": sem desconto).
//  - pct = users.comissao_pct do garcom; senao a regra da categoria do produto (ou da categoria-mae); senao o percentual padrao.
//  - comissao dos produtos = base * pct / 100.
//  - taxa de servico do recebimento/fechamento e rateada entre TODOS os itens do lote (maior resto, proporcional ao subtotal);
//    cada item que comissiona recebe a sua parte x repasse% (a parte dos itens "fora da comissao" nao e paga a ninguem).
//  - Item de produto "fora da comissao", de valor zero ou sem garcom nao gera lancamento.
//  - Idempotencia: UNIQUE(order_item_id) enquanto o lancamento nao foi estornado.
//  - Estorno (recebimento estornado ou venda cancelada): lancamento pendente vira 'estornada'; lancamento ja PAGO em acerto continua pago
//    e, se a regra "estorno desconta" estiver ligada, gera um lancamento NEGATIVO pendente que desconta no proximo acerto.
//  - Bonus por meta: ao fechar o acerto, para cada periodo (noite/semana/mes, no dia comercial com corte configuravel) em que a base do
//    garcom bateu a meta, um lancamento 'bonus' (meta_bonus_pct sobre a base do periodo), UMA vez por garcom e periodo.
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { FUSO } = require('../utils/query');

const centavos = (v) => Math.round(Number(v) * 100);
const reais = (c) => Number((c / 100).toFixed(2));
const hundredths = (pct) => Math.round(Number(pct) * 100);
// meio centavo para cima, com aritmetica inteira (sem erro de ponto flutuante): base em centavos x pct em centesimos / 10000
const pctDe = (baseCents, pctH) => Math.floor((baseCents * pctH + 5000) / 10000);

// Divide totalCents entre os pesos (inteiros >= 0) pelo metodo do maior resto: a soma das partes e EXATAMENTE totalCents.
function ratear(totalCents, pesos) {
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (totalCents <= 0 || soma <= 0) return pesos.map(() => 0);
  const partes = pesos.map((p) => Math.floor((totalCents * p) / soma));
  let resto = totalCents - partes.reduce((s, p) => s + p, 0);
  const ordem = pesos.map((p, i) => ({ i, r: (totalCents * p) % soma })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; resto > 0 && k < ordem.length; k++, resto--) partes[ordem[k].i] += 1;
  return partes;
}

const REGRA_PADRAO = {
  pct_padrao: 5, por_categoria: {}, taxa_servico_repasse_pct: 100, base: 'liquida', meta_valor: null, meta_bonus_pct: null,
  meta_periodo: 'noite', estorno_desconta: true, corte_hora: 6,
};

async function carregarRegra(db, tenantId) {
  const { rows } = await db.query(`SELECT * FROM comissao_regras WHERE tenant_id = $1 AND location_id IS NULL`, [tenantId]);
  const r = rows[0];
  if (!r) return { ...REGRA_PADRAO, persistida: false };
  return {
    persistida: true, pct_padrao: Number(r.pct_padrao), por_categoria: r.por_categoria || {}, taxa_servico_repasse_pct: Number(r.taxa_servico_repasse_pct), base: r.base,
    meta_valor: r.meta_valor === null ? null : Number(r.meta_valor), meta_bonus_pct: r.meta_bonus_pct === null ? null : Number(r.meta_bonus_pct),
    meta_periodo: r.meta_periodo, estorno_desconta: r.estorno_desconta, corte_hora: Number(r.corte_hora), atualizado_em: r.atualizado_em,
  };
}

// Calculo puro (sem banco): itens = [{ id, garcom_id, subtotal (reais), fora, categoria_id, categoria_pai_id }].
// opcoes: { descontoCents, taxaCents, pctGarcom: Map<garcom_id, pct|null> }. Devolve uma linha por item com os valores em centavos.
function calcularItens(regra, itens, { descontoCents = 0, taxaCents = 0, pctGarcom = new Map() } = {}) {
  const sub = itens.map((i) => centavos(i.subtotal));
  const descPartes = regra.base === 'liquida' ? ratear(descontoCents, sub) : sub.map(() => 0);
  const taxaPartes = ratear(taxaCents, sub);
  const repasseH = hundredths(regra.taxa_servico_repasse_pct);
  return itens.map((i, k) => {
    const elegivel = !!i.garcom_id && !i.fora && sub[k] > 0;
    if (!elegivel) return { item: i, elegivel: false, base: sub[k], pct: null, produtos: 0, servico: 0 };
    const base = sub[k] - descPartes[k];
    const override = pctGarcom.get(i.garcom_id);
    const porCat = regra.por_categoria || {};
    const pct = override !== null && override !== undefined ? Number(override)
      : porCat[i.categoria_id] !== undefined ? Number(porCat[i.categoria_id])
        : i.categoria_pai_id && porCat[i.categoria_pai_id] !== undefined ? Number(porCat[i.categoria_pai_id]) : Number(regra.pct_padrao);
    const origemPct = override !== null && override !== undefined ? 'garcom' : porCat[i.categoria_id] !== undefined ? 'categoria' : i.categoria_pai_id && porCat[i.categoria_pai_id] !== undefined ? 'categoria' : 'padrao';
    return { item: i, elegivel: true, base, pct, origemPct, produtos: pctDe(base, hundredths(pct)), servico: pctDe(taxaPartes[k], repasseH) };
  });
}

const snapshotDaRegra = (regra) => ({
  pct_padrao: regra.pct_padrao, taxa_servico_repasse_pct: regra.taxa_servico_repasse_pct, base: regra.base, estorno_desconta: regra.estorno_desconta,
});

// Itens (de rodadas) com os dados que o calculo precisa.
async function itensDasRodadas(db, orderIds) {
  const { rows } = await db.query(
    `SELECT oi.id, oi.order_id, oi.garcom_id, oi.subtotal, oi.product_id, p.nome AS produto, p.fora_da_comissao AS fora, p.categoria_id, c.parent_id AS categoria_pai_id
     FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.categoria_id
     WHERE oi.order_id = ANY($1::uuid[]) ORDER BY o.rodada, oi.id`,
    [orderIds]
  );
  return rows;
}

async function pctsDosGarcons(db, ids) {
  const { rows } = await db.query(`SELECT id, comissao_pct FROM users WHERE id = ANY($1::uuid[])`, [[...new Set(ids.filter(Boolean))]]);
  return new Map(rows.map((r) => [r.id, r.comissao_pct === null ? null : Number(r.comissao_pct)]));
}

// Gera os lancamentos de um lote (dentro da transacao do chamador). comanda = linha de comandas; opcoes: { origem ('recebimento'|'fechamento'), orderIds,
// descontoCents, taxaCents, comandaPagamentoId, saleId }. Devolve { lancamentos, total (centavos) }.
async function gerarLancamentos(client, user, comanda, opcoes) {
  const { origem, orderIds } = opcoes;
  if (!orderIds || orderIds.length === 0) return { lancamentos: 0, total: 0 };
  const regra = await carregarRegra(client, comanda.tenant_id);
  const itens = await itensDasRodadas(client, orderIds);
  const pctGarcom = await pctsDosGarcons(client, itens.map((i) => i.garcom_id));
  const calc = calcularItens(regra, itens, { descontoCents: opcoes.descontoCents || 0, taxaCents: opcoes.taxaCents || 0, pctGarcom });
  let n = 0; let total = 0;
  for (const c of calc) {
    if (!c.elegivel) continue;
    const r = await client.query(
      `INSERT INTO comissoes (tenant_id, location_id, garcom_id, comanda_id, sale_id, comanda_pagamento_id, order_item_id, origem, base_valor, pct_aplicado, valor_produtos, valor_servico, regra_snapshot, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (order_item_id) WHERE origem IN ('recebimento', 'fechamento') AND estornado_em IS NULL DO NOTHING`,
      [comanda.tenant_id, comanda.location_id, c.item.garcom_id, comanda.id, opcoes.saleId || null, opcoes.comandaPagamentoId || null, c.item.id, origem,
        reais(c.base), c.pct, reais(c.produtos), reais(c.servico), JSON.stringify({ ...snapshotDaRegra(regra), pct_origem: c.origemPct, categoria_id: c.item.categoria_id }), user ? user.id : null]
    );
    if (r.rowCount > 0) { n += 1; total += c.produtos + c.servico; }
  }
  return { lancamentos: n, total };
}

// Anula lancamentos (recebimento/fechamento) que casam com o filtro: pendente -> estornada; paga -> continua paga e, se a regra manda,
// gera um lancamento negativo pendente (desconta no proximo acerto).
async function anular(client, user, tenantId, filtroSql, params, motivo) {
  const regra = await carregarRegra(client, tenantId);
  const { rows } = await client.query(
    `SELECT * FROM comissoes WHERE tenant_id = $1 AND estornado_em IS NULL AND origem IN ('recebimento', 'fechamento') AND (${filtroSql}) ORDER BY id FOR UPDATE`,
    [tenantId, ...params]
  );
  let negativos = 0; let estornadas = 0;
  for (const r of rows) {
    await client.query(`UPDATE comissoes SET estornado_em = now(), status = CASE WHEN status = 'pendente' THEN 'estornada' ELSE status END, motivo = COALESCE(motivo, $2) WHERE id = $1`, [r.id, motivo]);
    if (r.status === 'pendente') { estornadas += 1; continue; }
    if (regra.estorno_desconta) {
      await client.query(
        `INSERT INTO comissoes (tenant_id, location_id, garcom_id, comanda_id, sale_id, comanda_pagamento_id, order_item_id, origem, base_valor, pct_aplicado, valor_produtos, valor_servico, estorno_de, motivo, regra_snapshot, criado_por)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'ajuste', $7, $8, $9, $10, $11, $12, $13, $14)`,
        [r.tenant_id, r.location_id, r.garcom_id, r.comanda_id, r.sale_id, r.comanda_pagamento_id, -Number(r.base_valor), r.pct_aplicado, -Number(r.valor_produtos), -Number(r.valor_servico), r.id,
          `Estorno de comissão já paga: ${motivo}`, JSON.stringify({ estorno_de: r.id }), user ? user.id : null]
      );
      negativos += 1;
    }
  }
  if (rows.length > 0) {
    await logAudit(client, { tenantId, usuarioId: user ? user.id : null, acao: 'comissao_estorno', recurso: 'comissoes', recursoId: rows[0].id, detalhes: { lancamentos: rows.length, estornadas, negativos, motivo } });
  }
  return { lancamentos: rows.length, estornadas, negativos };
}

const estornarPorPagamento = (client, user, tenantId, pagamentoId, motivo) => anular(client, user, tenantId, 'comanda_pagamento_id = $2', [pagamentoId], motivo);
// A venda cancelada anula tudo que ficou ligado a ela (fechamento + recebimentos que ela absorveu).
const estornarPorVenda = (client, user, tenantId, saleId, motivo) => anular(client, user, tenantId, 'sale_id = $2', [saleId], motivo);

// ---------------------------------------------------------------- periodos e bonus
// Dia comercial: a "noite" vai do corte (padrao 06:00) ate o corte do dia seguinte; o dia comercial de um instante e a data
// de (instante no fuso - corte horas).
const dataComercial = (col, corte) => `((${col} AT TIME ZONE '${FUSO}') - make_interval(hours => ${Number(corte) | 0}))::date`;
const chaveDoPeriodo = (periodo, bd) => (periodo === 'semana' ? `date_trunc('week', ${bd})::date::text` : periodo === 'mes' ? `to_char(${bd}, 'YYYY-MM')` : `(${bd})::text`);

async function janela(db, regra, { periodo = 'noite', de, ate } = {}) {
  const hoje = (await db.query(`SELECT ((now() AT TIME ZONE '${FUSO}') - make_interval(hours => $1))::date::text AS d`, [regra.corte_hora])).rows[0].d;
  const RE = /^\d{4}-\d{2}-\d{2}$/;
  if (periodo === 'personalizado') {
    if (!RE.test(String(de || '')) || !RE.test(String(ate || '')) || ate < de) throw new HttpError(400, 'período personalizado inválido: informe de e ate (AAAA-MM-DD)');
    return { periodo, de, ate, hoje };
  }
  if (periodo === 'semana') {
    const r = (await db.query(`SELECT date_trunc('week', $1::date)::date::text AS ini, (date_trunc('week', $1::date)::date + 6)::text AS fim`, [hoje])).rows[0];
    return { periodo, de: r.ini, ate: r.fim, hoje };
  }
  if (periodo === 'mes') {
    const r = (await db.query(`SELECT date_trunc('month', $1::date)::date::text AS ini, (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS fim`, [hoje])).rows[0];
    return { periodo, de: r.ini, ate: r.fim, hoje };
  }
  return { periodo: 'noite', de: hoje, ate: hoje, hoje };
}

// Bonus devido (e ainda nao lancado) por garcom/periodo, olhando lancamentos cujo dia comercial cai em [de, ate].
async function bonusDevido(db, tenantId, regra, { garcomIds = null, de, ate }) {
  if (!(regra.meta_valor > 0) || !(regra.meta_bonus_pct > 0)) return [];
  const bd = dataComercial('criado_em', regra.corte_hora);
  const chave = chaveDoPeriodo(regra.meta_periodo, bd);
  const { rows } = await db.query(
    `SELECT garcom_id, ${chave} AS chave, SUM(base_valor) AS base
     FROM comissoes WHERE tenant_id = $1 AND origem IN ('recebimento', 'fechamento') AND estornado_em IS NULL AND base_valor > 0 AND ($2::uuid[] IS NULL OR garcom_id = ANY($2::uuid[]))
     GROUP BY garcom_id, ${chave}
     HAVING SUM(base_valor) >= $3 AND bool_or(${bd} BETWEEN $4::date AND $5::date)`,
    [tenantId, garcomIds, regra.meta_valor, de, ate]
  );
  const feitos = (await db.query(`SELECT garcom_id, periodo_ref FROM comissoes WHERE tenant_id = $1 AND origem = 'bonus' AND estornado_em IS NULL`, [tenantId])).rows;
  const jaTem = new Set(feitos.map((f) => `${f.garcom_id}|${f.periodo_ref}`));
  return rows.filter((r) => !jaTem.has(`${r.garcom_id}|${regra.meta_periodo}:${r.chave}`)).map((r) => ({
    garcom_id: r.garcom_id, periodo_ref: `${regra.meta_periodo}:${r.chave}`, base: Number(r.base),
    valor: reais(pctDe(centavos(r.base), hundredths(regra.meta_bonus_pct))),
  }));
}

// ---------------------------------------------------------------- acerto
// Fecha o acerto dos garcons informados no periodo [de, ate] (dias comerciais): bonus devido + lancamentos pendentes (inclusive negativos)
// viram 'paga'. Garcom com total <= 0 fica de fora (o saldo negativo segue para o proximo acerto). Trava os lancamentos (FOR UPDATE):
// dois acertos simultaneos nao pagam o mesmo lancamento duas vezes.
async function fecharAcerto(client, user, { garcomIds, de, ate, formaPagamento, observacao }) {
  const tenantId = user.tenantId;
  const regra = await carregarRegra(client, tenantId);
  // bonus devido entra como lancamento pendente (e e lancado uma unica vez por garcom/periodo)
  for (const b of await bonusDevido(client, tenantId, regra, { garcomIds, de, ate })) {
    const loja = (await client.query(`SELECT location_id FROM comissoes WHERE tenant_id = $1 AND garcom_id = $2 ORDER BY criado_em DESC LIMIT 1`, [tenantId, b.garcom_id])).rows[0];
    if (!loja) continue;
    await client.query(
      `INSERT INTO comissoes (tenant_id, location_id, garcom_id, origem, base_valor, pct_aplicado, valor_produtos, valor_servico, periodo_ref, regra_snapshot, criado_por, motivo)
       VALUES ($1, $2, $3, 'bonus', $4, $5, $6, 0, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
      [tenantId, loja.location_id, b.garcom_id, b.base, regra.meta_bonus_pct, b.valor, b.periodo_ref, JSON.stringify({ meta_valor: regra.meta_valor, meta_periodo: regra.meta_periodo }), user.id, `Bônus por meta (${b.periodo_ref})`]
    );
  }
  const bd = dataComercial('criado_em', regra.corte_hora);
  const pend = (await client.query(
    `SELECT id, garcom_id, valor_produtos, valor_servico FROM comissoes
     WHERE tenant_id = $1 AND garcom_id = ANY($2::uuid[]) AND status = 'pendente' AND acerto_id IS NULL
       AND (${bd} BETWEEN $3::date AND $4::date OR origem IN ('ajuste', 'bonus')) -- ajustes e bonus pendentes entram no proximo acerto, seja qual for a data
     ORDER BY garcom_id, criado_em, id FOR UPDATE`,
    [tenantId, garcomIds, de, ate]
  )).rows;
  const porGarcom = new Map();
  for (const p of pend) {
    const g = porGarcom.get(p.garcom_id) || { cents: 0, ids: [] };
    g.cents += centavos(p.valor_produtos) + centavos(p.valor_servico);
    g.ids.push(p.id);
    porGarcom.set(p.garcom_id, g);
  }
  const incluidos = [...porGarcom.entries()].filter(([, g]) => g.cents > 0);
  const totalCents = incluidos.reduce((s, [, g]) => s + g.cents, 0);
  if (totalCents <= 0) throw new HttpError(409, 'não há comissão a acertar neste período (total zero ou já pago)');
  const numero = (await client.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM comissao_acertos WHERE tenant_id = $1`, [tenantId])).rows[0].n;
  const hoje = (await client.query(`SELECT (now() AT TIME ZONE '${FUSO}')::date::text AS d`)).rows[0].d;
  const acerto = (await client.query(
    `INSERT INTO comissao_acertos (tenant_id, numero, periodo_inicio, periodo_fim, total, forma_pagamento, pago_em, pago_por, observacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, numero, periodo_inicio::text AS periodo_inicio, periodo_fim::text AS periodo_fim, total, forma_pagamento, pago_em::text AS pago_em, pago_por, titulo_id, observacao, criado_em`,
    [tenantId, numero, de, ate, reais(totalCents), formaPagamento || null, hoje, user.id, observacao || null]
  )).rows[0];
  for (const [garcomId, g] of incluidos) {
    await client.query(`INSERT INTO comissao_acerto_itens (acerto_id, garcom_id, valor, lancamentos) VALUES ($1, $2, $3, $4)`, [acerto.id, garcomId, reais(g.cents), g.ids.length]);
    await client.query(`UPDATE comissoes SET status = 'paga', acerto_id = $1 WHERE id = ANY($2::uuid[])`, [acerto.id, g.ids]);
  }
  await logAudit(client, { tenantId, usuarioId: user.id, acao: 'comissao_acerto', recurso: 'comissao_acertos', recursoId: acerto.id, detalhes: { numero, periodo: [de, ate], total: reais(totalCents), garcons: incluidos.length, lancamentos: incluidos.reduce((s, [, g]) => s + g.ids.length, 0) } });
  return { acerto, totalCents, garcons: incluidos.map(([id, g]) => ({ garcom_id: id, valor: reais(g.cents), lancamentos: g.ids.length })) };
}

// Extrato do PROPRIO garcom (nunca de outro): comissao da noite e do mes e, na noite, uma linha por comanda.
async function extratoProprio(db, tenantId, garcomId) {
  const regra = await carregarRegra(db, tenantId);
  const bd = dataComercial('c.criado_em', regra.corte_hora);
  const noite = await janela(db, regra, { periodo: 'noite' });
  const mes = await janela(db, regra, { periodo: 'mes' });
  const soma = async (j) => {
    const r = (await db.query(
      `SELECT COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.estornado_em IS NULL OR c.origem = 'ajuste'), 0) AS total,
              COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.status = 'pendente'), 0) AS a_pagar,
              COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.status = 'paga'), 0) AS pago,
              COALESCE(SUM(c.valor_servico) FILTER (WHERE c.estornado_em IS NULL), 0) AS taxa_servico,
              COALESCE(SUM(c.valor_produtos) FILTER (WHERE c.origem = 'bonus'), 0) AS bonus,
              COUNT(*) FILTER (WHERE c.estornado_em IS NOT NULL AND c.origem IN ('recebimento', 'fechamento'))::int AS estornadas
       FROM comissoes c WHERE c.tenant_id = $1 AND c.garcom_id = $2 AND ${bd} BETWEEN $3::date AND $4::date`, [tenantId, garcomId, j.de, j.ate]
    )).rows[0];
    return { de: j.de, ate: j.ate, total: reais(centavos(r.total)), a_pagar: reais(centavos(r.a_pagar)), pago: reais(centavos(r.pago)), taxa_servico: reais(centavos(r.taxa_servico)), bonus: reais(centavos(r.bonus)), estornadas: r.estornadas };
  };
  const porComanda = (await db.query(
    `SELECT c.comanda_id, cm.numero, cm.identificador, cm.tipo, MIN(c.criado_em) AS hora,
            COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.estornado_em IS NULL), 0) AS comissao,
            COALESCE(SUM(c.valor_servico) FILTER (WHERE c.estornado_em IS NULL), 0) AS taxa_servico,
            COALESCE(SUM(c.base_valor) FILTER (WHERE c.estornado_em IS NULL), 0) AS vendido,
            BOOL_AND(c.status = 'paga') FILTER (WHERE c.estornado_em IS NULL) AS tudo_pago,
            COUNT(*) FILTER (WHERE c.estornado_em IS NOT NULL)::int AS estornadas
     FROM comissoes c JOIN comandas cm ON cm.id = c.comanda_id
     WHERE c.tenant_id = $1 AND c.garcom_id = $2 AND c.origem IN ('recebimento', 'fechamento') AND ${bd} BETWEEN $3::date AND $4::date
     GROUP BY c.comanda_id, cm.numero, cm.identificador, cm.tipo ORDER BY MIN(c.criado_em) DESC`, [tenantId, garcomId, noite.de, noite.ate]
  )).rows.map((r) => ({ comanda_id: r.comanda_id, numero: r.numero, identificador: r.identificador, tipo: r.tipo, hora: r.hora, comissao: Number(Number(r.comissao).toFixed(2)), taxa_servico: Number(Number(r.taxa_servico).toFixed(2)), vendido: Number(Number(r.vendido).toFixed(2)),
    situacao: r.estornadas > 0 && Number(r.comissao) === 0 ? 'estornada' : r.tudo_pago ? 'paga' : 'a_pagar', estornadas: r.estornadas }));
  const ajustes = (await db.query(
    `SELECT c.id, c.valor_produtos + c.valor_servico AS valor, c.origem, c.motivo, c.status, c.criado_em FROM comissoes c
     WHERE c.tenant_id = $1 AND c.garcom_id = $2 AND c.origem IN ('ajuste', 'bonus') AND (c.status = 'pendente' OR ${bd} BETWEEN $3::date AND $4::date) ORDER BY c.criado_em DESC LIMIT 30`, [tenantId, garcomId, noite.de, noite.ate]
  )).rows.map((a) => ({ ...a, valor: Number(Number(a.valor).toFixed(2)) }));
  return { noite: await soma(noite), mes: await soma(mes), por_comanda: porComanda, ajustes_e_bonus: ajustes, corte_hora: regra.corte_hora };
}

module.exports = {
  extratoProprio, centavos, reais, pctDe, ratear, REGRA_PADRAO, carregarRegra, calcularItens, itensDasRodadas, pctsDosGarcons, gerarLancamentos,
  estornarPorPagamento, estornarPorVenda, dataComercial, chaveDoPeriodo, janela, bonusDevido, fecharAcerto,
};
