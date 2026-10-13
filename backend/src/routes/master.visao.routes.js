const express = require('express');
const { requireArea } = require('../middleware/permissions');
const pool = require('../db/pool');
const { saude } = require('../services/saude');
const { requisicoesPorMinuto } = require('../services/monitoramento');
const { consultarAuditoria, exportarCsv, TIPOS } = require('../services/auditoria');

// Visao geral e auditoria global do painel Master (Fase 2). So le; nada aqui mostra vendas, pedidos ou clientes.
// Nao existe nenhuma rota que edite ou apague audit_logs.
const router = express.Router();
router.use('/master', requireArea('Master'));
const db = pool.producao;

router.get('/master/saude', async (req, res) => {
  res.json(await saude());
});

// Uso da plataforma hoje (sem vendas/pedidos): empresas ativas hoje (>= 1 login hoje), usuarios online (acesso nos ultimos 5 min).
router.get('/master/uso', async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(DISTINCT u.tenant_id)::int FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE t.nome <> 'Plataforma' AND u.ultimo_login >= date_trunc('day', now())) AS empresas_ativas_hoje,
       (SELECT COUNT(*)::int FROM users u WHERE u.ultimo_acesso > now() - interval '5 minutes') AS usuarios_online,
       (SELECT COUNT(*)::int FROM users u WHERE u.perfil <> 'Master') AS usuarios_cadastrados,
       (SELECT COUNT(*)::int FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE l.ativo AND t.nome <> 'Plataforma') AS lojas_ativas`
  );
  const r = requisicoesPorMinuto();
  res.json({ ...rows[0], requisicoes_por_min_pico: r.pico, requisicoes_ultimo_min: r.ultimoMinuto, requisicoes_serie: r.serie });
});

// Erros 5xx por hora (ultimas N horas, padrao 24) + os 20 mais recentes.
router.get('/master/erros', async (req, res) => {
  const horas = Math.min(72, Math.max(1, parseInt(req.query.horas, 10) || 24));
  const porHora = await db.query(
    `SELECT h.hora, COALESCE(c.n, 0)::int AS total
       FROM generate_series(date_trunc('hour', now()) - ($1::int - 1) * interval '1 hour', date_trunc('hour', now()), interval '1 hour') AS h(hora)
       LEFT JOIN (SELECT date_trunc('hour', criado_em) AS hora, COUNT(*) AS n FROM erros_sistema
                   WHERE criado_em >= date_trunc('hour', now()) - ($1::int - 1) * interval '1 hour' GROUP BY 1) c ON c.hora = h.hora
      ORDER BY h.hora`,
    [horas]
  );
  const ultimos = await db.query(
    `SELECT e.id, e.criado_em, e.metodo, e.rota, e.status, e.mensagem, t.nome AS empresa_nome
       FROM erros_sistema e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.criado_em DESC, e.id DESC LIMIT 20`
  );
  res.json({ horas, total: porHora.rows.reduce((s, r) => s + r.total, 0), por_hora: porHora.rows, ultimos: ultimos.rows });
});

router.get('/master/auditoria', async (req, res) => {
  res.json({ tipos: TIPOS.map((t) => ({ codigo: t.codigo, rotulo: t.rotulo })), ...(await consultarAuditoria(db, req.query)) });
});

router.get('/master/auditoria/exportar', async (req, res) => {
  const csv = await exportarCsv(db, req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="auditoria-girostock.csv"');
  res.send(csv);
});

module.exports = router;
