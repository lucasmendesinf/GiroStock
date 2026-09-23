const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { isValidDocumento, isValidEmail, isValidTelefone } = require('../utils/validators');

const router = express.Router();
const CATEGORIAS = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];

router.get('/suppliers', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, documento, telefone, email, categoria, prazo_medio_dias, ativo
     FROM suppliers WHERE tenant_id = $1 ORDER BY nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/suppliers', requireArea('Estoque'), async (req, res) => {
  const { nome, documento, telefone, email, categoria, prazo_medio_dias } = req.body || {};

  if (!nome || !documento || !telefone || !categoria) {
    return res.status(400).json({ erro: 'nome, documento, telefone e categoria sao obrigatorios' });
  }
  if (!isValidDocumento(documento)) {
    return res.status(400).json({ erro: 'documento deve ter 11 (CPF) ou 14 (CNPJ) digitos numericos' });
  }
  if (!isValidTelefone(telefone)) {
    return res.status(400).json({ erro: 'telefone deve ter no minimo 10 digitos' });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ erro: 'email invalido' });
  }
  if (!CATEGORIAS.includes(categoria)) {
    return res.status(400).json({ erro: 'categoria invalida' });
  }

  const existing = await pool.query(
    `SELECT 1 FROM suppliers WHERE tenant_id = $1 AND documento = $2`,
    [req.user.tenantId, documento]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ erro: 'ja existe fornecedor com este documento' });
  }

  const { rows } = await pool.query(
    `INSERT INTO suppliers (tenant_id, nome, documento, telefone, email, categoria, prazo_medio_dias)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, nome, documento, telefone, email, categoria, prazo_medio_dias, ativo`,
    [req.user.tenantId, nome, documento, telefone, email || null, categoria, prazo_medio_dias || null]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
