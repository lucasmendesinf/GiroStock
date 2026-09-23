const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');

const router = express.Router();

router.get('/reports/sales-summary', requireArea('Relatorios'), async (req, res) => {
  const { location_id, operador_id, forma_pagamento } = req.query;
  const params = [req.user.tenantId];
  let where = 'tenant_id = $1 AND status = \'concluida\'';
  if (location_id) {
    params.push(location_id);
    where += ` AND location_id = $${params.length}`;
  }
  if (operador_id) {
    params.push(operador_id);
    where += ` AND operador_id = $${params.length}`;
  }
  if (forma_pagamento) {
    params.push(forma_pagamento);
    where += ` AND forma_pagamento = $${params.length}`;
  }

  const resumo = await pool.query(
    `SELECT COALESCE(SUM(total), 0) AS total_vendido, COUNT(*)::int AS numero_vendas
     FROM sales WHERE ${where}`,
    params
  );

  const porForma = await pool.query(
    `SELECT forma_pagamento, COALESCE(SUM(total), 0) AS total, COUNT(*)::int AS quantidade
     FROM sales WHERE ${where}
     GROUP BY forma_pagamento`,
    params
  );

  const totalVendido = Number(resumo.rows[0].total_vendido);
  const numeroVendas = resumo.rows[0].numero_vendas;
  const ticketMedio = numeroVendas > 0 ? Number((totalVendido / numeroVendas).toFixed(2)) : 0;

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
    forma_pagamento_mais_usada: formaMaisUsada,
    quebra_por_forma_pagamento: quebra,
  });
});

router.get('/reports/sales-history', requireArea('Relatorios'), async (req, res) => {
  const { location_id, operador_id, forma_pagamento } = req.query;
  const params = [req.user.tenantId];
  let where = 's.tenant_id = $1 AND s.status = \'concluida\'';
  if (location_id) {
    params.push(location_id);
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

  const { rows } = await pool.query(
    `SELECT s.id, s.criado_em, u.nome AS operador_nome, t.nome AS terminal_nome, l.nome AS location_nome,
            s.forma_pagamento, s.total
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
