// Grades de variacoes (cor, tamanho, voltagem): cada variacao e um produto comum (services/grades.js).
const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const grades = require('../services/grades');

const router = express.Router();
router.use('/grades', requireArea('Estoque'));

async function emTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
const idValido = (id) => { if (!isUuid(id)) throw new HttpError(404, 'grade não encontrada'); return id; };

router.get('/grades', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.id, g.nome, g.categoria_id, c.nome AS categoria_nome, g.atributos,
            COUNT(p.id)::int AS variacoes, COUNT(p.id) FILTER (WHERE p.ativo)::int AS ativas,
            MIN(p.preco_venda) AS preco_min, MAX(p.preco_venda) AS preco_max
     FROM produto_grades g LEFT JOIN categories c ON c.id = g.categoria_id LEFT JOIN products p ON p.grade_id = g.id
     WHERE g.tenant_id = $1 GROUP BY g.id, c.nome ORDER BY g.nome`,
    [req.user.tenantId]
  );
  res.json(rows.map((r) => ({ ...r, preco_min: Number(r.preco_min), preco_max: Number(r.preco_max) })));
});

router.get('/grades/:id', async (req, res) => {
  res.json(await grades.detalhe(pool, req.user.tenantId, idValido(req.params.id)));
});

router.post('/grades', async (req, res) => {
  const r = await emTransacao(async (client) => {
    const g = await grades.criarGrade(client, req.user, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_grade', recurso: 'produto_grades', recursoId: g.grade.id, detalhes: { nome: g.grade.nome, variacoes: g.variacoes.length } });
    return g;
  });
  res.status(201).json(await grades.detalhe(pool, req.user.tenantId, r.grade.id));
});

router.put('/grades/:id', async (req, res) => {
  const id = idValido(req.params.id);
  await emTransacao(async (client) => {
    const d = await grades.editar(client, req.user, id, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_grade', recurso: 'produto_grades', recursoId: id, detalhes: d });
  });
  res.json(await grades.detalhe(pool, req.user.tenantId, id));
});

// Novos valores (ex.: cor Azul): cria as combinacoes que faltam.
router.post('/grades/:id/valores', async (req, res) => {
  const id = idValido(req.params.id);
  await emTransacao(async (client) => {
    const criadas = await grades.adicionarValores(client, req.user, id, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'grade_novos_valores', recurso: 'produto_grades', recursoId: id, detalhes: { criadas: criadas.map((p) => p.nome) } });
  });
  res.json(await grades.detalhe(pool, req.user.tenantId, id));
});

module.exports = router;
