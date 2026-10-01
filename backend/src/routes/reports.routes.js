const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { restrictedLocation } = require('../utils/access');

const router = express.Router();

// Filtros comuns. Usuario vinculado a um local so ve os numeros do proprio local.
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
  return { params, where };
}

router.get('/reports/sales-summary', requireArea('Relatorios'), async (req, res) => {
  const { params, where } = filtros(req, { incluirStatus: false });

  const resumo = await pool.query(
    `SELECT COALESCE(SUM(s.total), 0) AS total_vendido, COUNT(*)::int AS numero_vendas
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
    custo_total: custoTotal,
    lucro_bruto: lucroBruto,
    margem_percentual: totalVendido > 0 ? Number(((lucroBruto / totalVendido) * 100).toFixed(1)) : 0,
    vendas_canceladas: canceladas.rows[0].quantidade,
    total_cancelado: Number(canceladas.rows[0].total),
    forma_pagamento_mais_usada: formaMaisUsada,
    quebra_por_forma_pagamento: quebra,
  });
});

// Historico inclui vendas canceladas (com status), filtravel por ?status=concluida|cancelada.
router.get('/reports/sales-history', requireArea('Relatorios'), async (req, res) => {
  const { params, where } = filtros(req, { incluirStatus: true });

  const { rows } = await pool.query(
    `SELECT s.id, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.total, s.status, s.motivo_cancelamento
     FROM sales s
     JOIN users u ON u.id = s.operador_id
     JOIN terminals t ON t.id = s.terminal_id
     JOIN locations l ON l.id = s.location_id
     WHERE ${where}
     ORDER BY s.criado_em DESC LIMIT 500`,
    params
  );
  res.json(rows);
});

module.exports = router;
