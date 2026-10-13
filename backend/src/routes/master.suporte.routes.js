const express = require('express');
const jwt = require('jsonwebtoken');
const { requireArea } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const pool = require('../db/pool');
const suporte = require('../services/suporte');

// Suporte do Master (fase 4). `authRequired` ja foi aplicado no app.js.
const router = express.Router();
const db = pool.producao;

// Encerrar precisa funcionar DENTRO da sessao de suporte (onde a area Master nao existe): fica antes do requireArea.
router.post('/master/suporte/encerrar', async (req, res) => {
  if (!req.user.suporte) throw new HttpError(409, 'não há sessão de suporte aberta');
  const s = await suporte.encerrar(db, req.user.suporte.sessaoId, 'master');
  if (s) await logAudit(db, { tenantId: s.tenant_id, usuarioId: req.user.id, acao: 'master_suporte_encerrar', recurso: 'sessoes_suporte', recursoId: s.id, detalhes: { sessao_id: s.id } });
  const u = (await db.query(`SELECT id, tenant_id FROM users WHERE id = $1`, [req.user.id])).rows[0];
  // Token de Master puro (sem a claim de suporte).
  const token = jwt.sign({ sub: u.id, tenantId: u.tenant_id, perfil: 'Master' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.json({ token });
});

// ---- Avisos para os administradores da empresa (nunca mostram o nome do Master) ----
router.get('/avisos-empresa', async (req, res) => {
  if (req.user.suporte || req.user.perfil !== 'Administrador') return res.json({ avisos: [] });
  const { rows } = await db.query(
    `SELECT id, tipo, mensagem, criado_em FROM avisos_empresa
      WHERE tenant_id = $1 AND NOT (lido_por @> to_jsonb($2::text)) AND criado_em > now() - interval '30 days' ORDER BY criado_em DESC LIMIT 10`,
    [req.user.tenantId, req.user.id]
  );
  res.json({ avisos: rows });
});
router.post('/avisos-empresa/:id/dispensar', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'aviso inválido');
  const r = await db.query(
    `UPDATE avisos_empresa SET lido_por = lido_por || to_jsonb($3::text) WHERE id = $1 AND tenant_id = $2 AND NOT (lido_por @> to_jsonb($3::text)) RETURNING id`,
    [req.params.id, req.user.tenantId, req.user.id]
  );
  res.status(r.rowCount ? 204 : 404).end();
});

// ---- Daqui para baixo, so Master (fora de suporte) ----
router.use('/master', requireArea('Master'));

router.post('/master/empresas/:id/suporte', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'empresa inválida');
  const b = req.body || {};
  const authRoutes = require('./auth.routes');
  const r = await suporte.iniciar({
    master: req.user,
    empresaId: req.params.id,
    motivo: b.motivo,
    edicao: b.edicao === true,
    avisar: b.avisar !== false,
    codigo: b.codigo,
    ip: req.ip,
    reautenticar: authRoutes.reautenticarTotp,
    modoTesteAtivo: req.user.modoTeste,
  });
  res.status(201).json(r);
});

router.get('/master/empresas/:id/suporte', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'empresa inválida');
  await suporte.encerrarVencidas(db);
  const { rows } = await db.query(
    `SELECT s.id, s.motivo, s.edicao, s.avisou_admins, s.iniciada_em, s.expira_em, s.encerrada_em, s.encerrada_por, u.nome AS master_nome
       FROM sessoes_suporte s JOIN users u ON u.id = s.master_id WHERE s.tenant_id = $1 ORDER BY s.iniciada_em DESC LIMIT 50`,
    [req.params.id]
  );
  res.json({ sessoes: rows });
});

module.exports = router;
