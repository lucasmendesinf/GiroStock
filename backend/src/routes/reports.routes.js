const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { filtroLocais } = require('../utils/access');
const { filtroPeriodo, paginacao, FUSO } = require('../utils/query');
const { HttpError } = require('../utils/http');

const router = express.Router();

// Filtros comuns: local, operador, forma de pagamento e periodo (data_inicio/data_fim).
// Usuario vinculado a um local so ve os numeros do proprio local.
function filtros(req, { incluirStatus }) {
  const { location_id, operador_id, forma_pagamento, status } = req.query;
  const params = [req.user.tenantId];
  let where = 's.tenant_id = $1';
  if (incluirStatus) {
    if (status === 'cancelada' || status === 'concluida') {
      params.push(status);
      where += ` AND s.status = $${params.length}`;
    }
  } else {
    where += ` AND s.status = 'concluida'`;
  }
  const locais = filtroLocais(req.user, location_id);
  if (locais) {
    params.push(locais);
    where += ` AND s.location_id = ANY($${params.length}::uuid[])`;
  }
  if (operador_id) {
    params.push(operador_id);
    where += ` AND s.operador_id = $${params.length}`;
  }
  if (forma_pagamento) {
    params.push(forma_pagamento);
    where += ` AND EXISTS (SELECT 1 FROM v_sale_pagamentos vp WHERE vp.sale_id = s.id AND vp.forma::text = $${params.length})`;
  }
  where += filtroPeriodo('s.criado_em', req.query, params);
  return { params, where };
}

router.get('/reports/sales-summary', requireArea('Relatorios'), async (req, res) => {
  const { params, where } = filtros(req, { incluirStatus: false });

  const resumo = await pool.query(
    `SELECT COALESCE(SUM(s.total), 0) AS total_vendido, COALESCE(SUM(s.desconto), 0) AS total_descontos,
            COUNT(*)::int AS numero_vendas
     FROM sales s WHERE ${where}`,
    params
  );

  // Custo gravado no item no momento da venda (vendas antigas usam o custo atual do produto).
  const custo = await pool.query(
    `SELECT COALESCE(SUM(si.quantidade * COALESCE(si.custo_unitario, p.preco_custo)), 0) AS custo_total
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE ${where}`,
    params
  );

  const porForma = await pool.query(
    `SELECT vp.forma AS forma_pagamento, COALESCE(SUM(vp.valor), 0) AS total, COUNT(*)::int AS quantidade
     FROM sales s JOIN v_sale_pagamentos vp ON vp.sale_id = s.id WHERE ${where}
     GROUP BY vp.forma`,
    params
  );

  const cancelamentos = filtros(req, { incluirStatus: true });
  cancelamentos.params.push('cancelada');
  const canceladas = await pool.query(
    `SELECT COUNT(*)::int AS quantidade, COALESCE(SUM(s.total), 0) AS total
     FROM sales s WHERE ${cancelamentos.where} AND s.status = $${cancelamentos.params.length}`,
    cancelamentos.params
  );

  const totalVendido = Number(resumo.rows[0].total_vendido);
  const numeroVendas = resumo.rows[0].numero_vendas;
  const ticketMedio = numeroVendas > 0 ? Number((totalVendido / numeroVendas).toFixed(2)) : 0;
  const custoTotal = Number(Number(custo.rows[0].custo_total).toFixed(2));
  const lucroBruto = Number((totalVendido - custoTotal).toFixed(2));

  let formaMaisUsada = null;
  let maxQtd = 0;
  const quebra = porForma.rows.map((r) => {
    const pct = totalVendido > 0 ? Number(((Number(r.total) / totalVendido) * 100).toFixed(1)) : 0;
    if (r.quantidade > maxQtd) {
      maxQtd = r.quantidade;
      formaMaisUsada = r.forma_pagamento;
    }
    return { forma_pagamento: r.forma_pagamento, total: Number(r.total), quantidade: r.quantidade, percentual: pct };
  });

  res.json({
    total_vendido: totalVendido,
    numero_vendas: numeroVendas,
    ticket_medio: ticketMedio,
    total_descontos: Number(resumo.rows[0].total_descontos),
    custo_total: custoTotal,
    lucro_bruto: lucroBruto,
    margem_percentual: totalVendido > 0 ? Number(((lucroBruto / totalVendido) * 100).toFixed(1)) : 0,
    vendas_canceladas: canceladas.rows[0].quantidade,
    total_cancelado: Number(canceladas.rows[0].total),
    forma_pagamento_mais_usada: formaMaisUsada,
    quebra_por_forma_pagamento: quebra,
  });
});

// Historico paginado; inclui canceladas (filtravel por ?status=concluida|cancelada).
router.get('/reports/sales-history', requireArea('Relatorios'), async (req, res) => {
  const { params, where } = filtros(req, { incluirStatus: true });
  const { limit, offset } = paginacao(req.query, 50, 500);

  const total = await pool.query(`SELECT COUNT(*)::int AS total FROM sales s WHERE ${where}`, params);
  const { rows } = await pool.query(
    `SELECT s.id, s.numero, s.numero_pedido, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.desconto, s.total, s.status, s.motivo_cancelamento
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     JOIN terminals t ON t.id = s.terminal_id
     JOIN locations l ON l.id = s.location_id
     WHERE ${where}
     ORDER BY s.criado_em DESC, s.numero DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: total.rows[0].total, limit, offset, itens: rows });
});

// Produtos mais vendidos no periodo (quantidade, faturamento e lucro).
router.get('/reports/top-products', requireArea('Relatorios'), async (req, res) => {
  const { params, where } = filtros(req, { incluirStatus: false });
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.unidade,
            SUM(si.quantidade) AS quantidade,
            SUM(si.subtotal) AS faturamento,
            SUM(si.subtotal - si.quantidade * COALESCE(si.custo_unitario, p.preco_custo)) AS lucro
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     JOIN products p ON p.id = si.product_id
     WHERE ${where}
     GROUP BY p.id, p.nome, p.unidade
     ORDER BY SUM(si.subtotal) DESC
     LIMIT 10`,
    params
  );
  res.json(rows);
});

// Resumo por sessao de caixa (abertura/fechamento): vendas por forma, sangrias,
// suprimentos, valor esperado em dinheiro, valor informado e diferenca.
router.get('/reports/cash-sessions', requireArea('Relatorios'), async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'cs.tenant_id = $1';
  const locais = filtroLocais(req.user, req.query.location_id);
  if (locais) {
    params.push(locais);
    where += ` AND t.location_id = ANY($${params.length}::uuid[])`;
  }
  where += filtroPeriodo('cs.aberto_em', req.query, params);
  const { limit, offset } = paginacao(req.query, 30, 200);

  const { rows } = await pool.query(
    `SELECT cs.id, cs.aberto_em, cs.fechado_em, cs.valor_inicial,
            cs.valor_esperado_fechamento, cs.valor_informado_fechamento, cs.diferenca,
            t.nome AS terminal_nome, l.nome AS location_nome, u.nome AS aberto_por,
            COALESCE(v.vendas, 0)::int AS vendas,
            COALESCE(v.total, 0) AS total_vendido,
            COALESCE(v.dinheiro, 0) AS dinheiro, COALESCE(v.dinheiro_garcom, 0) AS dinheiro_garcom, COALESCE(v.pix, 0) AS pix,
            COALESCE(v.credito, 0) AS cartao_credito, COALESCE(v.debito, 0) AS cartao_debito,
            COALESCE(m.sangrias, 0) AS sangrias, COALESCE(m.suprimentos, 0) AS suprimentos
     FROM cash_sessions cs
     JOIN cash_registers cr ON cr.id = cs.cash_register_id
     JOIN terminals t ON t.id = cr.terminal_id
     JOIN locations l ON l.id = t.location_id
     JOIN users u ON u.id = cs.usuario_abertura_id
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT s.id) AS vendas,
              (SELECT COALESCE(SUM(s2.total), 0) FROM sales s2 WHERE s2.cash_session_id = cs.id AND s2.status = 'concluida') AS total,
              SUM(vp.valor) FILTER (WHERE vp.forma = 'dinheiro') AS dinheiro,
              SUM(vp.valor) FILTER (WHERE vp.forma = 'dinheiro' AND NOT vp.entra_no_caixa) AS dinheiro_garcom,
              SUM(vp.valor) FILTER (WHERE vp.forma = 'pix') AS pix,
              SUM(vp.valor) FILTER (WHERE vp.forma = 'cartao_credito') AS credito,
              SUM(vp.valor) FILTER (WHERE vp.forma = 'cartao_debito') AS debito
       FROM sales s JOIN v_sale_pagamentos vp ON vp.sale_id = s.id WHERE s.cash_session_id = cs.id AND s.status = 'concluida'
     ) v ON true
     LEFT JOIN LATERAL (
       SELECT SUM(valor) FILTER (WHERE tipo = 'sangria') AS sangrias,
              SUM(valor) FILTER (WHERE tipo = 'suprimento') AS suprimentos
       FROM cash_movements WHERE cash_session_id = cs.id
     ) m ON true
     WHERE ${where}
     ORDER BY cs.aberto_em DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json(rows);
});

// ---------------------------------------------------------------- relatorios avancados
// Canal de venda: venda que veio de um pedido leva a origem do pedido; venda direta no caixa = "pdv".
const CANAL = `COALESCE((SELECT o.origem FROM orders o WHERE o.sale_id = s.id LIMIT 1), 'pdv')`;
const CUSTO_DA_VENDA = `(SELECT COALESCE(SUM(si.quantidade * COALESCE(si.custo_unitario, p.preco_custo)), 0) FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id)`;
const ITENS_DA_VENDA = `(SELECT COALESCE(SUM(si.quantidade), 0) FROM sale_items si WHERE si.sale_id = s.id)`;
const NOME_CANAL = { pdv: 'Venda no caixa (PDV)', balcao: 'Pedido no balcão', telefone: 'Pedido por telefone', whatsapp: 'Pedido por WhatsApp', ifood: 'iFood', '99food': '99Food' };
const DIAS = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const n2 = (v) => Number(Number(v || 0).toFixed(2));

// Agrupamentos por venda (loja, operador, canal, dia, dia da semana, hora) e por item (categoria, produto).
const AGRUPAR = {
  loja: { chave: 's.location_id::text', nome: '(SELECT nome FROM locations WHERE id = s.location_id)' },
  operador: { chave: 's.operador_id::text', nome: '(SELECT nome FROM users WHERE id = s.operador_id)' },
  canal: { chave: CANAL, nome: CANAL },
  // venda dividida em varias formas: cada forma recebe a parte proporcional (peso = valor pago / total da venda); a soma bate com o total
  pagamento: { chave: 'vp.forma::text', nome: 'vp.forma::text', pagamentos: true },
  dia: { chave: `((s.criado_em AT TIME ZONE '${FUSO}')::date)::text`, nome: `((s.criado_em AT TIME ZONE '${FUSO}')::date)::text`, ordem: 'chave' },
  dia_semana: { chave: `EXTRACT(ISODOW FROM s.criado_em AT TIME ZONE '${FUSO}')::int::text`, nome: `EXTRACT(ISODOW FROM s.criado_em AT TIME ZONE '${FUSO}')::int::text`, ordem: 'chave' },
  hora: { chave: `lpad(EXTRACT(HOUR FROM s.criado_em AT TIME ZONE '${FUSO}')::int::text, 2, '0')`, nome: `lpad(EXTRACT(HOUR FROM s.criado_em AT TIME ZONE '${FUSO}')::int::text, 2, '0')`, ordem: 'chave' },
};

router.get('/reports/comparativo', requireArea('Relatorios'), async (req, res) => {
  const por = String(req.query.por || 'loja');
  const { params, where } = filtros(req, { incluirStatus: false });
  let linhas;
  if (por === 'categoria' || por === 'produto') {
    // por item: faturamento = subtotal dos itens (sem o desconto da venda, que e da venda inteira)
    const chave = por === 'categoria' ? `COALESCE(c.id::text, 'sem')` : 'p.id::text';
    const nome = por === 'categoria' ? `COALESCE(CASE WHEN pc.nome IS NOT NULL THEN pc.nome || ' › ' || c.nome ELSE c.nome END, 'Sem categoria')` : 'p.nome';
    linhas = (await pool.query(
      `SELECT ${chave} AS chave, ${nome} AS nome, COUNT(DISTINCT s.id)::int AS vendas, SUM(si.quantidade) AS itens,
              SUM(si.subtotal) AS total, 0 AS descontos, SUM(si.quantidade * COALESCE(si.custo_unitario, p.preco_custo)) AS custo
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
       LEFT JOIN categories c ON c.id = p.categoria_id LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE ${where} GROUP BY 1, 2 ORDER BY SUM(si.subtotal) DESC LIMIT 200`, params
    )).rows;
  } else {
    const g = AGRUPAR[por];
    if (!g) throw new HttpError(400, 'agrupamento inválido');
    const peso = g.pagamentos ? '(vp.valor / NULLIF(s.total, 0))' : '1';
    const de = g.pagamentos ? 'sales s JOIN v_sale_pagamentos vp ON vp.sale_id = s.id' : 'sales s';
    linhas = (await pool.query(
      `SELECT ${g.chave} AS chave, ${g.nome} AS nome, COUNT(DISTINCT s.id)::int AS vendas, SUM(${ITENS_DA_VENDA} * ${peso}) AS itens,
              SUM(s.total * ${peso}) AS total, SUM(s.desconto * ${peso}) AS descontos, SUM(${CUSTO_DA_VENDA} * ${peso}) AS custo
       FROM ${de} WHERE ${where} GROUP BY 1, 2 ORDER BY ${g.ordem === 'chave' ? '1' : `SUM(s.total * ${peso}) DESC`}`, params
    )).rows;
    // cancelamentos no mesmo agrupamento
    const c = filtros(req, { incluirStatus: true });
    const canc = (await pool.query(
      `SELECT ${g.chave} AS chave, COUNT(DISTINCT s.id)::int AS n, SUM(s.total * ${peso}) AS total FROM ${de} WHERE ${c.where} AND s.status = 'cancelada' GROUP BY 1`, c.params
    )).rows;
    const porChave = Object.fromEntries(canc.map((r) => [r.chave, r]));
    linhas = linhas.map((l) => ({ ...l, canceladas: porChave[l.chave] ? porChave[l.chave].n : 0, total_cancelado: porChave[l.chave] ? n2(porChave[l.chave].total) : 0 }));
  }
  const totalGeral = linhas.reduce((t, l) => t + Number(l.total), 0);
  const rotulo = (l) => {
    if (por === 'canal') return NOME_CANAL[l.nome] || l.nome;
    if (por === 'dia_semana') return DIAS[Number(l.nome)] || l.nome;
    if (por === 'hora') return `${l.nome}h`;
    return l.nome || '—';
  };
  res.json({
    por, total: n2(totalGeral),
    linhas: linhas.map((l) => {
      const total = n2(l.total);
      const custo = n2(l.custo);
      const lucro = n2(total - custo);
      return {
        chave: l.chave, nome: rotulo(l), vendas: l.vendas, itens: Number(Number(l.itens || 0).toFixed(3)), total, descontos: n2(l.descontos), custo, lucro,
        margem: total > 0 ? Number(((lucro / total) * 100).toFixed(1)) : 0,
        ticket: l.vendas > 0 && por !== 'categoria' && por !== 'produto' ? n2(total / l.vendas) : null,
        participacao: totalGeral > 0 ? Number(((total / totalGeral) * 100).toFixed(1)) : 0,
        canceladas: l.canceladas, total_cancelado: l.total_cancelado,
      };
    }),
  });
});

// Indicadores do periodo comparados com o periodo anterior de mesmo tamanho.
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
async function metricas(req, de, ate) {
  const r = { user: req.user, query: { ...req.query, data_inicio: de, data_fim: ate } };
  const { params, where } = filtros(r, { incluirStatus: false });
  const v = (await pool.query(
    `SELECT COUNT(*)::int AS vendas, COALESCE(SUM(s.total), 0) AS total, COALESCE(SUM(s.desconto), 0) AS descontos,
            COALESCE(SUM(s.subtotal), 0) AS subtotal, COALESCE(SUM(${CUSTO_DA_VENDA}), 0) AS custo, COALESCE(SUM(${ITENS_DA_VENDA}), 0) AS itens,
            COUNT(DISTINCT (s.criado_em AT TIME ZONE '${FUSO}')::date)::int AS dias_com_venda
     FROM sales s WHERE ${where}`, params
  )).rows[0];
  const c = filtros(r, { incluirStatus: true });
  const canc = (await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(s.total), 0) AS total FROM sales s WHERE ${c.where} AND s.status = 'cancelada'`, c.params)).rows[0];
  const pico = (await pool.query(
    `SELECT EXTRACT(HOUR FROM s.criado_em AT TIME ZONE '${FUSO}')::int AS h, SUM(s.total) AS t FROM sales s WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, params
  )).rows[0];
  const melhorDia = (await pool.query(
    `SELECT EXTRACT(ISODOW FROM s.criado_em AT TIME ZONE '${FUSO}')::int AS d, SUM(s.total) AS t FROM sales s WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, params
  )).rows[0];
  const total = n2(v.total);
  const lucro = n2(total - Number(v.custo));
  const dias = Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000) + 1;
  return {
    de, ate, dias, vendas: v.vendas, faturamento: total, custo: n2(v.custo), lucro_bruto: lucro,
    margem: total > 0 ? Number(((lucro / total) * 100).toFixed(1)) : 0,
    ticket_medio: v.vendas > 0 ? n2(total / v.vendas) : 0,
    itens_por_venda: v.vendas > 0 ? Number((Number(v.itens) / v.vendas).toFixed(2)) : 0,
    descontos: n2(v.descontos), desconto_pct: Number(v.subtotal) > 0 ? Number(((Number(v.descontos) / Number(v.subtotal)) * 100).toFixed(1)) : 0,
    canceladas: canc.n, total_cancelado: n2(canc.total), cancelamento_pct: v.vendas + canc.n > 0 ? Number(((canc.n / (v.vendas + canc.n)) * 100).toFixed(1)) : 0,
    media_por_dia: n2(total / dias), dias_com_venda: v.dias_com_venda,
    hora_pico: pico ? `${String(pico.h).padStart(2, '0')}h` : null, melhor_dia_semana: melhorDia ? DIAS[melhorDia.d] : null,
  };
}

router.get('/reports/indicadores', requireArea('Relatorios'), async (req, res) => {
  const hoje = (await pool.query(`SELECT (now() AT TIME ZONE '${FUSO}')::date::text AS d`)).rows[0].d;
  const de = req.query.data_inicio || hoje;
  const ate = req.query.data_fim || hoje;
  if (!DATA_RE.test(de) || !DATA_RE.test(ate) || ate < de) throw new HttpError(400, 'período inválido');
  const dias = Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000) + 1;
  if (dias > 731) throw new HttpError(400, 'período de no máximo 2 anos');
  const desloca = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const atual = await metricas(req, de, ate);
  const anterior = await metricas(req, desloca(de, -dias), desloca(de, -1));
  const variacao = {};
  for (const k of ['vendas', 'faturamento', 'lucro_bruto', 'ticket_medio', 'itens_por_venda', 'media_por_dia', 'descontos', 'canceladas']) {
    variacao[k] = Number(anterior[k]) > 0 ? Number((((Number(atual[k]) - Number(anterior[k])) / Number(anterior[k])) * 100).toFixed(1)) : null;
  }
  // em pontos percentuais; sem venda no periodo anterior nao ha com o que comparar
  for (const k of ['margem', 'desconto_pct', 'cancelamento_pct']) variacao[k] = anterior.vendas + anterior.canceladas > 0 ? Number((atual[k] - anterior[k]).toFixed(1)) : null;
  res.json({ atual, anterior, variacao });
});

// Estoque: posicao valorizada por loja, abaixo do minimo, produtos parados (sem venda no periodo) e curva ABC.
router.get('/reports/estoque', requireArea('Relatorios'), async (req, res) => {
  const t = req.user.tenantId;
  const locais = filtroLocais(req.user, req.query.location_id);
  const hoje = (await pool.query(`SELECT (now() AT TIME ZONE '${FUSO}')::date::text AS d`)).rows[0].d;
  const de = req.query.data_inicio || new Date(Date.parse(`${hoje}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  const ate = req.query.data_fim || hoje;
  if (!DATA_RE.test(de) || !DATA_RE.test(ate)) throw new HttpError(400, 'período inválido');
  const pLoc = [t, locais];
  const filtroLoc = 'AND ($2::uuid[] IS NULL OR sb.location_id = ANY($2::uuid[]))';
  const posicao = (await pool.query(
    `SELECT l.id, l.nome, COUNT(*) FILTER (WHERE sb.saldo > 0)::int AS produtos, COALESCE(SUM(sb.saldo) FILTER (WHERE sb.saldo > 0), 0) AS unidades,
            COALESCE(SUM(sb.saldo * p.preco_custo) FILTER (WHERE sb.saldo > 0), 0) AS valor_custo,
            COALESCE(SUM(sb.saldo * p.preco_venda) FILTER (WHERE sb.saldo > 0), 0) AS valor_venda,
            COUNT(*) FILTER (WHERE sb.estoque_minimo > 0 AND sb.saldo < sb.estoque_minimo)::int AS abaixo_minimo,
            COUNT(*) FILTER (WHERE sb.saldo <= 0 AND sb.estoque_minimo > 0)::int AS zerados
     FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN locations l ON l.id = sb.location_id
     WHERE sb.tenant_id = $1 AND p.ativo AND l.ativo ${filtroLoc}
     GROUP BY l.id, l.nome ORDER BY l.nome`, pLoc
  )).rows.map((r) => ({ ...r, unidades: Number(r.unidades), valor_custo: n2(r.valor_custo), valor_venda: n2(r.valor_venda) }));
  const abaixo = (await pool.query(
    `SELECT p.id, p.nome, p.codigo_interno, p.unidade, l.nome AS loja, sb.saldo, sb.estoque_minimo, (sb.estoque_minimo - sb.saldo) AS falta, p.preco_custo
     FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN locations l ON l.id = sb.location_id
     WHERE sb.tenant_id = $1 AND p.ativo AND l.ativo AND sb.estoque_minimo > 0 AND sb.saldo < sb.estoque_minimo ${filtroLoc}
     ORDER BY (sb.saldo / NULLIF(sb.estoque_minimo, 0)), p.nome LIMIT 200`, pLoc
  )).rows;
  const vendidosSql = `SELECT si.product_id, s.location_id, SUM(si.quantidade) AS qtd, SUM(si.subtotal) AS fat
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.tenant_id = $1 AND s.status = 'concluida' AND ($2::uuid[] IS NULL OR s.location_id = ANY($2::uuid[]))
       AND s.criado_em >= ($3::date::timestamp AT TIME ZONE '${FUSO}') AND s.criado_em < (($4::date + 1)::timestamp AT TIME ZONE '${FUSO}')
     GROUP BY 1, 2`;
  const parados = (await pool.query(
    `WITH v AS (${vendidosSql})
     SELECT p.id, p.nome, p.codigo_interno, p.unidade, l.nome AS loja, sb.saldo, (sb.saldo * p.preco_custo) AS valor_parado,
            (SELECT max(s.criado_em) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = p.id AND s.location_id = sb.location_id AND s.status = 'concluida') AS ultima_venda
     FROM stock_balances sb JOIN products p ON p.id = sb.product_id JOIN locations l ON l.id = sb.location_id
     LEFT JOIN v ON v.product_id = sb.product_id AND v.location_id = sb.location_id
     WHERE sb.tenant_id = $1 AND p.ativo AND l.ativo AND sb.saldo > 0 AND v.product_id IS NULL ${filtroLoc}
     ORDER BY (sb.saldo * p.preco_custo) DESC, p.nome LIMIT 200`, [t, locais, de, ate]
  )).rows.map((r) => ({ ...r, valor_parado: n2(r.valor_parado) }));
  // Curva ABC pelo faturamento do periodo: A = ate 80% do faturamento acumulado, B = ate 95%, C = o resto.
  const vend = (await pool.query(
    `WITH v AS (${vendidosSql})
     SELECT p.id, p.nome, p.codigo_interno, p.unidade, SUM(v.qtd) AS quantidade, SUM(v.fat) AS faturamento
     FROM v JOIN products p ON p.id = v.product_id GROUP BY p.id, p.nome, p.codigo_interno, p.unidade ORDER BY SUM(v.fat) DESC`, [t, locais, de, ate]
  )).rows;
  const totalFat = vend.reduce((s, r) => s + Number(r.faturamento), 0);
  let acum = 0;
  const abc = vend.map((r) => {
    const fat = Number(r.faturamento);
    const antes = acum;
    acum += fat;
    const classe = totalFat === 0 ? 'C' : antes / totalFat < 0.8 ? 'A' : antes / totalFat < 0.95 ? 'B' : 'C';
    return { id: r.id, nome: r.nome, codigo_interno: r.codigo_interno, unidade: r.unidade, quantidade: Number(r.quantidade), faturamento: n2(fat), participacao: totalFat > 0 ? Number(((fat / totalFat) * 100).toFixed(1)) : 0, acumulado: totalFat > 0 ? Number(((acum / totalFat) * 100).toFixed(1)) : 0, classe };
  });
  const resumoAbc = ['A', 'B', 'C'].map((c) => ({ classe: c, produtos: abc.filter((x) => x.classe === c).length, faturamento: n2(abc.filter((x) => x.classe === c).reduce((s, x) => s + x.faturamento, 0)) }));
  res.json({
    de, ate,
    totais: { valor_custo: n2(posicao.reduce((s, x) => s + x.valor_custo, 0)), valor_venda: n2(posicao.reduce((s, x) => s + x.valor_venda, 0)), abaixo_minimo: abaixo.length, parados: parados.length, valor_parado: n2(parados.reduce((s, x) => s + x.valor_parado, 0)) },
    posicao, abaixo_minimo: abaixo, parados, abc: abc.slice(0, 300), resumo_abc: resumoAbc,
  });
});

module.exports = router;
