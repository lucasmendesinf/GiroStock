const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { isValidEmail } = require('../utils/validators');
const { HttpError } = require('../utils/http');

// Dados de contato da PROPRIA empresa (e-mail, telefone, responsavel). Informativos: nao alteram nenhuma regra do sistema.
const router = express.Router();

const COLUNAS = 'id, nome, documento, email_contato, telefone, responsavel, combo_margem_pct, combo_preco_final_90';

const saida = (r) => ({ ...r, combo_margem_pct: Number(r.combo_margem_pct) });

router.get('/empresa', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUNAS} FROM tenants WHERE id = $1`, [req.user.tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'empresa não encontrada');
  res.json(saida(rows[0]));
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
  // Combos (opcionais no corpo: quem nao os envia nao os altera). Margem 0 a menos de 95, com 2 casas; ",90" booleano.
  let margem = null;
  if (b.combo_margem_pct !== undefined) {
    const m = Number(String(b.combo_margem_pct).replace(',', '.'));
    if (!Number.isFinite(m) || m < 0 || m >= 95) throw new HttpError(400, 'a margem padrão dos combos deve ser de 0 a menos de 95%');
    margem = Math.round(m * 100) / 100;
  }
  if (b.combo_preco_final_90 !== undefined && typeof b.combo_preco_final_90 !== 'boolean') throw new HttpError(400, 'combo_preco_final_90 deve ser verdadeiro ou falso');
  const final90 = typeof b.combo_preco_final_90 === 'boolean' ? b.combo_preco_final_90 : null;
  const antes = (await pool.query(`SELECT combo_margem_pct, combo_preco_final_90 FROM tenants WHERE id = $1`, [req.user.tenantId])).rows[0];
  const { rows } = await pool.query(
    `UPDATE tenants SET email_contato = NULLIF($2, ''), telefone = NULLIF($3, ''), responsavel = NULLIF($4, ''),
            combo_margem_pct = COALESCE($5::numeric, combo_margem_pct), combo_preco_final_90 = COALESCE($6::boolean, combo_preco_final_90)
      WHERE id = $1 RETURNING ${COLUNAS}`,
    [req.user.tenantId, email, telefone, responsavel, margem, final90]
  );
  const detalhes = { campos: ['email_contato', 'telefone', 'responsavel'] };
  if (margem !== null || final90 !== null) detalhes.combos = { antes: { margem_pct: Number(antes.combo_margem_pct), final_90: antes.combo_preco_final_90 }, depois: { margem_pct: Number(rows[0].combo_margem_pct), final_90: rows[0].combo_preco_final_90 } };
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_dados_empresa', recurso: 'tenants', recursoId: req.user.tenantId, detalhes });
  res.json(saida(rows[0]));
});

module.exports = router;
