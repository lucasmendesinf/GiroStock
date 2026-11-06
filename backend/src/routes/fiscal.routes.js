// Nota fiscal (modulo "nota_fiscal"): configuracao fiscal por loja (Configuracoes), perfis fiscais (Estoque), emissao da NFC-e
// de uma venda (Vendas), lista de notas, XML, reenvio e cancelamento (CancelarVendas).
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation, isUuid } = require('../utils/tenant');
const { filtroLocais, assertLocationAccess } = require('../utils/access');
const { filtroPeriodo } = require('../utils/query');
const { HttpError } = require('../utils/http');
const fiscal = require('../services/fiscal');

const router = express.Router();
router.use('/fiscal', requireModulo('nota_fiscal'));
// "simular" (rejeitar / sem_conexao) so vale com o simulador ligado (testes)
const simular = (b) => (process.env.FISCAL_SIMULADOR === '1' && b && b.simular ? String(b.simular) : undefined);

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
const idValido = (id, msg = 'nota não encontrada') => { if (!isUuid(id)) throw new HttpError(404, msg); return id; };

// ---------- configuracao por loja ----------
router.get('/fiscal/lojas', requireArea('Configuracoes'), async (req, res) => {
  const lojas = (await pool.query(`SELECT id, nome FROM locations WHERE tenant_id = $1 AND ativo ORDER BY nome`, [req.user.tenantId])).rows;
  const out = [];
  for (const l of lojas) {
    const c = await fiscal.configDaLoja(pool, req.user.tenantId, l.id);
    out.push({ ...fiscal.publica(c, l), pendencias: c ? fiscal.pendencias(c) : [] });
  }
  res.json({ lojas: out, simulador: process.env.FISCAL_SIMULADOR === '1' });
});

router.put('/fiscal/lojas/:id', requireArea('Configuracoes'), async (req, res) => {
  const loja = await getOwnedLocation(pool, idValido(req.params.id, 'loja não encontrada'), req.user.tenantId);
  assertLocationAccess(req.user, loja.id, 'configurar a nota fiscal desta loja');
  await emTransacao(async (client) => {
    const d = await fiscal.salvarConfig(client, req.user, loja.id, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fiscal_config', recurso: 'locations', recursoId: loja.id, detalhes: d });
  });
  const c = await fiscal.configDaLoja(pool, req.user.tenantId, loja.id);
  res.json({ ...fiscal.publica(c, loja), pendencias: fiscal.pendencias(c) });
});

router.post('/fiscal/lojas/:id/certificado', requireArea('Configuracoes'), async (req, res) => {
  const loja = await getOwnedLocation(pool, idValido(req.params.id, 'loja não encontrada'), req.user.tenantId);
  const d = await emTransacao(async (client) => {
    const x = await fiscal.salvarCertificado(client, req.user, loja.id, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fiscal_certificado', recurso: 'locations', recursoId: loja.id, detalhes: x });
    return x;
  });
  res.json(d);
});

// Testa a comunicacao com a SEFAZ (status do servico) com o certificado da loja.
router.post('/fiscal/lojas/:id/testar', requireArea('Configuracoes'), async (req, res) => {
  const loja = await getOwnedLocation(pool, idValido(req.params.id, 'loja não encontrada'), req.user.tenantId);
  const c = await fiscal.configDaLoja(pool, req.user.tenantId, loja.id);
  if (!c || !c.cert_cript) throw new HttpError(400, 'envie o certificado antes de testar');
  const r = await fiscal.chamarMotor({ acao: 'status', config: fiscal.configMotor(c) });
  res.json({ ok: !!r.ok, motivo: r.motivo, cStat: r.cStat || null });
});

// Modo do PDV para o terminal (o caixa ve "cupom fiscal / so cupom").
router.get('/fiscal/pdv', requireArea('Vendas'), async (req, res) => {
  const locId = req.query.location_id;
  if (!isUuid(locId)) return res.json({ modo_pdv: 'desligado' });
  const c = await fiscal.configDaLoja(pool, req.user.tenantId, locId);
  if (!c) return res.json({ modo_pdv: 'desligado' });
  res.json({ modo_pdv: c.modo_pdv, ambiente: c.ambiente, pronta: fiscal.pendencias(c).length === 0, pendencias: fiscal.pendencias(c) });
});

// ---------- perfis fiscais ----------
const CSOSN = ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'];
function perfilDoCorpo(b) {
  const nome = String(b.nome || '').trim().slice(0, 60);
  if (nome.length < 2) throw new HttpError(400, 'dê um nome ao perfil (ex.: Bebida com ST)');
  const cfop = String(b.cfop || '').replace(/\D/g, '');
  if (!/^[5][0-9]{3}$/.test(cfop)) throw new HttpError(400, 'CFOP de venda dentro do estado começa com 5 (ex.: 5102, 5405)');
  if (!CSOSN.includes(String(b.csosn))) throw new HttpError(400, 'CSOSN inválido');
  const origem = Number(b.origem || 0);
  if (!(origem >= 0 && origem <= 8)) throw new HttpError(400, 'origem inválida');
  const cst = (v) => (/^[0-9]{2}$/.test(String(v || '')) ? String(v) : '49');
  return { nome, cfop, csosn: String(b.csosn), origem, cst_pis: cst(b.cst_pis), cst_cofins: cst(b.cst_cofins), padrao: !!b.padrao };
}
router.get('/fiscal/perfis', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pf.*, (SELECT COUNT(*) FROM products p WHERE p.perfil_fiscal_id = pf.id)::int AS produtos,
            (SELECT COUNT(*) FROM categories c WHERE c.perfil_fiscal_id = pf.id)::int AS categorias
     FROM perfis_fiscais pf WHERE pf.tenant_id = $1 ORDER BY pf.padrao DESC, pf.nome`, [req.user.tenantId]
  );
  res.json(rows);
});
router.post('/fiscal/perfis', requireArea('Estoque'), async (req, res) => {
  const p = perfilDoCorpo(req.body || {});
  const r = await emTransacao(async (client) => {
    if (p.padrao) await client.query(`UPDATE perfis_fiscais SET padrao = false WHERE tenant_id = $1`, [req.user.tenantId]);
    const dup = (await client.query(`SELECT 1 FROM perfis_fiscais WHERE tenant_id = $1 AND lower(nome) = lower($2)`, [req.user.tenantId, p.nome])).rows.length;
    if (dup) throw new HttpError(409, 'já existe um perfil com este nome');
    return (await client.query(
      `INSERT INTO perfis_fiscais (tenant_id, nome, cfop, csosn, origem, cst_pis, cst_cofins, padrao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.tenantId, p.nome, p.cfop, p.csosn, p.origem, p.cst_pis, p.cst_cofins, p.padrao]
    )).rows[0];
  });
  res.status(201).json(r);
});
router.put('/fiscal/perfis/:id', requireArea('Estoque'), async (req, res) => {
  const id = idValido(req.params.id, 'perfil não encontrado');
  const p = perfilDoCorpo(req.body || {});
  const r = await emTransacao(async (client) => {
    if (p.padrao) await client.query(`UPDATE perfis_fiscais SET padrao = false WHERE tenant_id = $1 AND id <> $2`, [req.user.tenantId, id]);
    const { rows } = await client.query(
      `UPDATE perfis_fiscais SET nome = $3, cfop = $4, csosn = $5, origem = $6, cst_pis = $7, cst_cofins = $8, padrao = $9 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, req.user.tenantId, p.nome, p.cfop, p.csosn, p.origem, p.cst_pis, p.cst_cofins, p.padrao]
    );
    if (!rows.length) throw new HttpError(404, 'perfil não encontrado');
    return rows[0];
  });
  res.json(r);
});
router.delete('/fiscal/perfis/:id', requireArea('Estoque'), async (req, res) => {
  const id = idValido(req.params.id, 'perfil não encontrado');
  const uso = (await pool.query(`SELECT (SELECT COUNT(*) FROM products WHERE perfil_fiscal_id = $1) + (SELECT COUNT(*) FROM categories WHERE perfil_fiscal_id = $1) AS n`, [id])).rows[0].n;
  if (Number(uso) > 0) throw new HttpError(409, 'perfil em uso por produtos ou categorias: troque o perfil deles antes');
  const r = await pool.query(`DELETE FROM perfis_fiscais WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId]);
  if (!r.rowCount) throw new HttpError(404, 'perfil não encontrado');
  res.status(204).end();
});

// ---------- dados fiscais dos produtos e das categorias ----------
const NCM_RE = /^[0-9]{8}$/;
const CEST_RE = /^[0-9]{7}$/;
async function perfilDaEmpresa(db, tenantId, id) {
  if (id === null || id === '' || id === undefined) return null;
  if (!isUuid(id) || !(await db.query(`SELECT 1 FROM perfis_fiscais WHERE id = $1 AND tenant_id = $2`, [id, tenantId])).rows.length) throw new HttpError(400, 'perfil fiscal não encontrado');
  return id;
}
// Produtos com estoque proprio e lanches (ficha/combo tambem vao para a nota). ?pendentes=1 = sem NCM ou sem perfil.
router.get('/fiscal/produtos', requireArea('Estoque'), async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'p.tenant_id = $1 AND p.ativo';
  if (req.query.busca) { params.push(`%${String(req.query.busca).trim().slice(0, 60)}%`); where += ` AND (p.nome ILIKE $${params.length} OR p.codigo_interno ILIKE $${params.length} OR p.barcode LIKE $${params.length})`; }
  if (req.query.pendentes === '1') where += ` AND (p.ncm IS NULL OR COALESCE(p.perfil_fiscal_id, c.perfil_fiscal_id, (SELECT id FROM perfis_fiscais WHERE tenant_id = p.tenant_id AND padrao)) IS NULL)`;
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.barcode, p.ncm, p.cest, p.perfil_fiscal_id, c.nome AS categoria_nome, c.perfil_fiscal_id AS perfil_categoria_id,
            COALESCE(pf.nome, cf.nome, df.nome) AS perfil_efetivo, CASE WHEN pf.id IS NOT NULL THEN 'produto' WHEN cf.id IS NOT NULL THEN 'categoria' WHEN df.id IS NOT NULL THEN 'padrão' END AS perfil_origem
     FROM products p LEFT JOIN categories c ON c.id = p.categoria_id LEFT JOIN perfis_fiscais pf ON pf.id = p.perfil_fiscal_id
     LEFT JOIN perfis_fiscais cf ON cf.id = c.perfil_fiscal_id LEFT JOIN perfis_fiscais df ON df.tenant_id = p.tenant_id AND df.padrao
     WHERE ${where} ORDER BY (p.ncm IS NULL) DESC, p.nome LIMIT 1000`, params
  );
  res.json(rows);
});
router.put('/fiscal/produtos/:id', requireArea('Estoque'), async (req, res) => {
  const id = idValido(req.params.id, 'produto não encontrado');
  const b = req.body || {};
  const ncm = b.ncm === undefined ? undefined : String(b.ncm || '').replace(/\D/g, '') || null;
  if (ncm && !NCM_RE.test(ncm)) throw new HttpError(400, 'NCM tem 8 números (ex.: 22021000)');
  const cest = b.cest === undefined ? undefined : String(b.cest || '').replace(/\D/g, '') || null;
  if (cest && !CEST_RE.test(cest)) throw new HttpError(400, 'CEST tem 7 números (ex.: 0300700)');
  const perfil = b.perfil_fiscal_id === undefined ? undefined : await perfilDaEmpresa(pool, req.user.tenantId, b.perfil_fiscal_id);
  const { rows } = await pool.query(
    `UPDATE products SET ncm = CASE WHEN $3 THEN $4 ELSE ncm END, cest = CASE WHEN $5 THEN $6 ELSE cest END,
            perfil_fiscal_id = CASE WHEN $7 THEN $8::uuid ELSE perfil_fiscal_id END
     WHERE id = $1 AND tenant_id = $2 RETURNING id, ncm, cest, perfil_fiscal_id`,
    [id, req.user.tenantId, ncm !== undefined, ncm || null, cest !== undefined, cest || null, perfil !== undefined, perfil || null]
  );
  if (!rows.length) throw new HttpError(404, 'produto não encontrado');
  res.json(rows[0]);
});
// Varios produtos de uma vez: { ids: [...], perfil_fiscal_id }
router.post('/fiscal/produtos/lote', requireArea('Estoque'), async (req, res) => {
  const b = req.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).filter(isUuid).slice(0, 2000);
  if (!ids.length) throw new HttpError(400, 'escolha os produtos');
  const perfil = await perfilDaEmpresa(pool, req.user.tenantId, b.perfil_fiscal_id);
  const r = await pool.query(`UPDATE products SET perfil_fiscal_id = $3 WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tenantId, ids, perfil]);
  res.json({ atualizados: r.rowCount });
});
// NCM/CEST vindos do XML da nota de compra: so preenche quem ainda nao tem (nunca sobrescreve).
router.post('/fiscal/produtos/ncm-da-nota', requireArea('Estoque'), async (req, res) => {
  let n = 0;
  for (const it of (Array.isArray(req.body && req.body.itens) ? req.body.itens : []).slice(0, 500)) {
    const ncm = String(it.ncm || '').replace(/\D/g, '');
    const cest = String(it.cest || '').replace(/\D/g, '');
    if (!isUuid(it.product_id) || !NCM_RE.test(ncm)) continue;
    const r = await pool.query(
      `UPDATE products SET ncm = COALESCE(ncm, $3), cest = COALESCE(cest, $4) WHERE id = $1 AND tenant_id = $2 AND (ncm IS NULL OR (cest IS NULL AND $4::text IS NOT NULL))`,
      [it.product_id, req.user.tenantId, ncm, CEST_RE.test(cest) ? cest : null]
    );
    n += r.rowCount;
  }
  res.json({ atualizados: n });
});
router.get('/fiscal/categorias', requireArea('Estoque'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.parent_id, c.perfil_fiscal_id, (SELECT COUNT(*) FROM products p WHERE p.categoria_id = c.id AND p.ativo)::int AS produtos
     FROM categories c WHERE c.tenant_id = $1 ORDER BY c.nome`, [req.user.tenantId]
  );
  res.json(rows);
});
router.put('/fiscal/categorias/:id', requireArea('Estoque'), async (req, res) => {
  const id = idValido(req.params.id, 'categoria não encontrada');
  const perfil = await perfilDaEmpresa(pool, req.user.tenantId, (req.body || {}).perfil_fiscal_id);
  const r = await pool.query(`UPDATE categories SET perfil_fiscal_id = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, perfil_fiscal_id`, [id, req.user.tenantId, perfil]);
  if (!r.rows.length) throw new HttpError(404, 'categoria não encontrada');
  res.json(r.rows[0]);
});

// ---------- emissao ----------
router.post('/fiscal/nfce', requireArea('Vendas'), async (req, res) => {
  const b = req.body || {};
  const saleId = idValido(b.sale_id, 'venda não encontrada');
  const venda = (await pool.query(`SELECT location_id FROM sales WHERE id = $1 AND tenant_id = $2`, [saleId, req.user.tenantId])).rows[0];
  if (!venda) throw new HttpError(404, 'venda não encontrada');
  assertLocationAccess(req.user, venda.location_id, 'emitir nota desta loja');
  const nota = await fiscal.emitirNFCe(req.user, saleId, { cpf: b.cpf, simular: simular(b) });
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'nfce_emitir', recurso: 'notas_fiscais', recursoId: nota.id, detalhes: { venda: nota.venda_numero, numero: nota.numero, situacao: nota.situacao, ambiente: nota.ambiente } });
  res.status(201).json(nota);
});

router.get('/fiscal/notas', requireArea('Vendas'), async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'n.tenant_id = $1';
  const locais = filtroLocais(req.user, isUuid(req.query.location_id) ? req.query.location_id : null);
  if (locais) { params.push(locais); where += ` AND n.location_id = ANY($${params.length}::uuid[])`; }
  if (req.query.situacao) { params.push(String(req.query.situacao).split(',')); where += ` AND n.situacao = ANY($${params.length}::text[])`; }
  if (req.query.ambiente) { params.push(String(req.query.ambiente)); where += ` AND n.ambiente = $${params.length}`; }
  if (isUuid(req.query.sale_id)) { params.push(req.query.sale_id); where += ` AND n.sale_id = $${params.length}`; }
  where += filtroPeriodo('n.emitida_em', req.query, params);
  const { rows } = await pool.query(`${fiscal.SELECT_NOTA} WHERE ${where} ORDER BY n.emitida_em DESC LIMIT 500`, params);
  res.json(rows.map((r) => ({ ...r, valor: Number(r.valor), teste: r.ambiente === 'homologacao' })));
});

router.get('/fiscal/notas/:id', requireArea('Vendas'), async (req, res) => {
  res.json(await fiscal.notaPorId(pool, req.user.tenantId, idValido(req.params.id)));
});

router.get('/fiscal/notas/:id/xml', requireArea('Vendas'), async (req, res) => {
  const id = idValido(req.params.id);
  const n = (await pool.query(`SELECT chave, xml FROM notas_fiscais WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenantId])).rows[0];
  if (!n || !n.xml) throw new HttpError(404, 'XML não encontrado');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${n.chave || id}-nfce.xml"`);
  res.send(n.xml);
});

router.post('/fiscal/notas/:id/reenviar', requireArea('Vendas'), async (req, res) => {
  res.json(await fiscal.reenviar(req.user, idValido(req.params.id), { simular: simular(req.body) }));
});

router.post('/fiscal/notas/:id/cancelar', requireArea('CancelarVendas'), async (req, res) => {
  const id = idValido(req.params.id);
  const n = await fiscal.cancelar(req.user, id, req.body && req.body.justificativa, { simular: simular(req.body) });
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'nfce_cancelar', recurso: 'notas_fiscais', recursoId: id, detalhes: { numero: n.numero, justificativa: n.cancel_justificativa } });
  res.json(n);
});

module.exports = router;
