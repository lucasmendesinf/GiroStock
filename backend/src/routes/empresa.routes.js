const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { isValidEmail } = require('../utils/validators');
const { HttpError } = require('../utils/http');

// Dados de contato da PROPRIA empresa (e-mail, telefone, responsavel). Informativos: nao alteram nenhuma regra do sistema.
const router = express.Router();

const COLUNAS = 'id, nome, documento, email_contato, telefone, responsavel';

router.get('/empresa', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUNAS} FROM tenants WHERE id = $1`, [req.user.tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'empresa não encontrada');
  res.json(rows[0]);
});

router.put('/empresa', requireArea('Configuracoes'), async (req, res) => {
  const b = req.body || {};
  const limpar = (v, max) => { const t = String(v === undefined || v === null ? '' : v).trim(); return t.length > max ? null : t; };
  const email = limpar(b.email_contato, 120);
  const telefone = limpar(b.telefone, 30);
  const responsavel = limpar(b.responsavel, 100);
  if (email === null || telefone === null || responsavel === null) throw new HttpError(400, 'algum campo está longo demais');
  if (email && !isValidEmail(email)) throw new HttpError(400, 'e-mail inválido');
  if (telefone && (!/^[0-9()+\-.\s]+$/.test(telefone) || telefone.replace(/\D/g, '').length < 8)) throw new HttpError(400, 'telefone inválido: use só números, espaços, parênteses e traço (mínimo 8 dígitos)');
  const { rows } = await pool.query(
    `UPDATE tenants SET email_contato = NULLIF($2, ''), telefone = NULLIF($3, ''), responsavel = NULLIF($4, '') WHERE id = $1 RETURNING ${COLUNAS}`,
    [req.user.tenantId, email, telefone, responsavel]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_dados_empresa', recurso: 'tenants', recursoId: req.user.tenantId, detalhes: { campos: ['email_contato', 'telefone', 'responsavel'] } });
  res.json(rows[0]);
});

module.exports = router;
