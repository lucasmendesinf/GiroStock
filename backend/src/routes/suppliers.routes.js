const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { onlyDigits, isValidDocumento, isValidEmail, isValidTelefone } = require('../utils/validators');
const { logAudit } = require('../utils/audit');
const { getOwned } = require('../utils/tenant');
const { HttpError } = require('../utils/http');

const router = express.Router();
const CATEGORIAS = ['Bebidas', 'Cigarros e Tabacaria', 'Alimentos e Insumos', 'Embalagens', 'Outros'];
const COLUNAS = 'id, nome, documento, telefone, email, categoria, prazo_medio_dias, ativo';

// Valida e normaliza os dados do fornecedor. O documento aceita mascara
// (ex: 07.526.557/0001-00) e e salvo so com digitos.
function validarFornecedor(body) {
  const { nome, telefone, email, categoria, prazo_medio_dias } = body || {};
  const documento = onlyDigits(body && body.documento);

  if (!nome || !documento || !telefone || !categoria) {
    throw new HttpError(400, 'nome, documento, telefone e categoria são obrigatórios');
  }
  if (!isValidDocumento(documento)) {
    throw new HttpError(400, 'CPF ou CNPJ inválido (confira os dígitos)');
  }
  if (!isValidTelefone(telefone)) throw new HttpError(400, 'telefone deve ter no mínimo 10 dígitos');
  if (email && !isValidEmail(email)) throw new HttpError(400, 'email inválido');
  if (!CATEGORIAS.includes(categoria)) throw new HttpError(400, 'categoria inválida');

  let prazo = null;
  if (prazo_medio_dias !== undefined && prazo_medio_dias !== null && prazo_medio_dias !== '') {
    prazo = Number(prazo_medio_dias);
    if (!Number.isInteger(prazo) || prazo < 0) throw new HttpError(400, 'prazo médio deve ser um número inteiro de dias (0 ou mais)');
  }
  return { nome: nome.trim(), documento, telefone, email: email || null, categoria, prazo_medio_dias: prazo };
}

async function assertDocumentoLivre(tenantId, documento, ignorarId = null) {
  const { rows } = await pool.query(
    `SELECT 1 FROM suppliers WHERE tenant_id = $1 AND documento = $2 AND ($3::uuid IS NULL OR id <> $3)`,
    [tenantId, documento, ignorarId]
  );
  if (rows.length > 0) throw new HttpError(409, 'já existe fornecedor com este documento');
}

router.get('/suppliers', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.nome, s.documento, s.telefone, s.email, s.categoria, s.prazo_medio_dias, s.ativo,
            (SELECT COUNT(*)::int FROM product_suppliers ps WHERE ps.supplier_id = s.id AND ps.tenant_id = s.tenant_id) AS produto_count
     FROM suppliers s WHERE s.tenant_id = $1 ORDER BY s.ativo DESC, s.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

// Fornecedor + produtos vinculados + ultimas entradas de estoque feitas por ele.
router.get('/suppliers/:id', requireArea('Estoque'), async (req, res) => {
  const supplier = await getOwned(pool, 'suppliers', req.params.id, req.user.tenantId, { columns: COLUNAS });

  const produtos = await pool.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.preco_custo, p.preco_venda, p.ativo,
            (p.supplier_id = ps.supplier_id) AS principal
     FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
     WHERE ps.supplier_id = $1 AND ps.tenant_id = $2
     ORDER BY p.nome`,
    [req.params.id, req.user.tenantId]
  );
  const entradas = await pool.query(
    `SELECT sm.id, sm.criado_em, p.nome AS product_nome, sm.quantidade, sm.custo_unitario,
            sm.documento_fiscal, l.nome AS location_nome
     FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     LEFT JOIN locations l ON l.id = sm.location_destino_id
     WHERE sm.supplier_id = $1 AND sm.tenant_id = $2
     ORDER BY sm.criado_em DESC LIMIT 50`,
    [req.params.id, req.user.tenantId]
  );
  res.json({ ...supplier, produtos: produtos.rows, entradas: entradas.rows });
});

router.post('/suppliers', requireArea('Estoque'), async (req, res) => {
  const dados = validarFornecedor(req.body);
  await assertDocumentoLivre(req.user.tenantId, dados.documento);

  const { rows } = await pool.query(
    `INSERT INTO suppliers (tenant_id, nome, documento, telefone, email, categoria, prazo_medio_dias)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUNAS}`,
    [req.user.tenantId, dados.nome, dados.documento, dados.telefone, dados.email, dados.categoria, dados.prazo_medio_dias]
  );
  res.status(201).json(rows[0]);
});

router.put('/suppliers/:id', requireArea('Estoque'), async (req, res) => {
  const anterior = await getOwned(pool, 'suppliers', req.params.id, req.user.tenantId, { columns: COLUNAS });
  const dados = validarFornecedor(req.body);
  await assertDocumentoLivre(req.user.tenantId, dados.documento, req.params.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE suppliers SET nome = $1, documento = $2, telefone = $3, email = $4, categoria = $5, prazo_medio_dias = $6
       WHERE id = $7 AND tenant_id = $8
       RETURNING ${COLUNAS}`,
      [dados.nome, dados.documento, dados.telefone, dados.email, dados.categoria, dados.prazo_medio_dias, req.params.id, req.user.tenantId]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'editar',
      recurso: 'suppliers',
      recursoId: req.params.id,
      detalhes: { antes: anterior, depois: rows[0] },
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Desativar mantem o historico (produtos e entradas continuam apontando para ele),
// mas o fornecedor deixa de aparecer para novos vinculos e novas entradas.
router.patch('/suppliers/:id/status', requireArea('Estoque'), async (req, res) => {
  const ativo = !!(req.body && req.body.ativo);
  await getOwned(pool, 'suppliers', req.params.id, req.user.tenantId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE suppliers SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING ${COLUNAS}`,
      [ativo, req.params.id, req.user.tenantId]
    );
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: ativo ? 'ativar' : 'desativar',
      recurso: 'suppliers',
      recursoId: req.params.id,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
