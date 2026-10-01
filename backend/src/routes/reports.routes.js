const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { restrictedLocation } = require('../utils/access');
const { filtroPeriodo, paginacao } = require('../utils/query');

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
  const local = restrictedLocation(req.user) || location_id;
  if (local) {
    params.push(local);
    where += ` AND s.location_id = $${params.length}`;
  }
  if (operador_id) {
    params.push(operador_id);
    where += ` AND s.operador_id = $${params.length}`;
  }
  if (forma_pagamento) {
    params.push(forma_pagamento);
    where += ` AND s.forma_pagamento = $${params.length}`;
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
    `SELECT s.forma_pagamento, COALESCE(SUM(s.total), 0) AS total, COUNT(*)::int AS quantidade
     FROM sales s WHERE ${where}
     GROUP BY s.forma_pagamento`,
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
    `SELECT s.id, s.numero, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
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
  const local = restrictedLocation(req.user) || req.query.location_id;
  if (local) {
    params.push(local);
    where += ` AND t.location_id = $${params.length}`;
  }
  where += filtroPeriodo('cs.aberto_em', req.query, params);
  const { limit, offset } = paginacao(req.query, 30, 200);

  const { rows } = await pool.query(
    `SELECT cs.id, cs.aberto_em, cs.fechado_em, cs.valor_inicial,
            cs.valor_esperado_fechamento, cs.valor_informado_fechamento, cs.diferenca,
            t.nome AS terminal_nome, l.nome AS location_nome, u.nome AS aberto_por,
            COALESCE(v.vendas, 0)::int AS vendas,
            COALESCE(v.total, 0) AS total_vendido,
            COALESCE(v.dinheiro, 0) AS dinheiro, COALESCE(v.pix, 0) AS pix,
            COALESCE(v.credito, 0) AS cartao_credito, COALESCE(v.debito, 0) AS cartao_debito,
            COALESCE(m.sangrias, 0) AS sangrias, COALESCE(m.suprimentos, 0) AS suprimentos
     FROM cash_sessions cs
     JOIN cash_registers cr ON cr.id = cs.cash_register_id
     JOIN terminals t ON t.id = cr.terminal_id
     JOIN locations l ON l.id = t.location_id
     JOIN users u ON u.id = cs.usuario_abertura_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS vendas, SUM(total) AS total,
              SUM(total) FILTER (WHERE forma_pagamento = 'dinheiro') AS dinheiro,
              SUM(total) FILTER (WHERE forma_pagamento = 'pix') AS pix,
              SUM(total) FILTER (WHERE forma_pagamento = 'cartao_credito') AS credito,
              SUM(total) FILTER (WHERE forma_pagamento = 'cartao_debito') AS debito
       FROM sales WHERE cash_session_id = cs.id AND status = 'concluida'
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

module.exports = router;
