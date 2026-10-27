const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { filtroLocais } = require('../utils/access');
const { HttpError } = require('../utils/http');
const { configEfetiva } = require('../utils/cupom');
const { checarLimite } = require('../utils/limites');

const router = express.Router();

router.get('/locations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.nome, l.ativo, l.usa_comanda, l.usa_pedidos, l.cupom_config, l.taxa_servico_pct, l.garcom_recebe, l.garcom_formas, l.terminal_comandas_id,
            (SELECT COUNT(*)::int FROM terminals t WHERE t.location_id = l.id AND t.tenant_id = l.tenant_id) AS terminal_count
     FROM locations l WHERE l.tenant_id = $1 ORDER BY l.ativo DESC, l.nome`,
    [req.user.tenantId]
  );
  res.json(rows.map((l) => ({ ...l, cupom_config: configEfetiva(l.cupom_config) })));
});

router.post('/locations', requireArea('Configuracoes'), async (req, res) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  await checarLimite(pool, req.user.tenantId, 'lojas');
  const { rows } = await pool.query(
    `INSERT INTO locations (tenant_id, nome, usa_comanda, usa_pedidos) VALUES ($1, $2, $3, $4) RETURNING id, nome, ativo, usa_comanda, usa_pedidos`,
    [req.user.tenantId, nome, !!(req.body && req.body.usa_comanda), !!(req.body && req.body.usa_pedidos)]
  );
  res.status(201).json(rows[0]);
});

// Renomear e/ou ativar/desativar um local. Para desativar, o local nao pode ter
// saldo de produtos/insumos nem caixa aberto (transfira o estoque antes).
router.patch('/locations/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  const atual = await getOwned(pool, 'locations', req.params.id, req.user.tenantId, { columns: 'id, nome, ativo, usa_comanda, usa_pedidos, cupom_config' });
  const usaComanda = body.usa_comanda !== undefined ? !!body.usa_comanda : atual.usa_comanda;
  const usaPedidos = body.usa_pedidos !== undefined ? !!body.usa_pedidos : atual.usa_pedidos;
  const cupomConfig = body.cupom_config !== undefined ? configEfetiva(body.cupom_config) : atual.cupom_config;
  const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
  if (!nome) throw new HttpError(400, 'nome é obrigatório');
  const ativo = body.ativo !== undefined ? !!body.ativo : atual.ativo;

  if (atual.ativo && !ativo) {
    const saldo = await pool.query(
      `SELECT (SELECT COALESCE(SUM(saldo), 0) FROM stock_balances WHERE location_id = $1 AND tenant_id = $2) AS produtos,
              (SELECT COALESCE(SUM(saldo), 0) FROM ingredient_balances WHERE location_id = $1 AND tenant_id = $2) AS insumos`,
      [req.params.id, req.user.tenantId]
    );
    if (Number(saldo.rows[0].produtos) > 0 || Number(saldo.rows[0].insumos) > 0) {
      throw new HttpError(400, 'este local ainda tem estoque; transfira ou de saída do saldo antes de desativar');
    }
    const caixa = await pool.query(
      `SELECT 1 FROM cash_sessions cs
       JOIN cash_registers cr ON cr.id = cs.cash_register_id
       JOIN terminals t ON t.id = cr.terminal_id
       WHERE t.location_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );
    if (caixa.rows.length > 0) throw new HttpError(400, 'ha caixa aberto em um terminal deste local; feche-o antes de desativar');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE locations SET nome = $1, ativo = $2, usa_comanda = $5, cupom_config = $6, usa_pedidos = $7 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, ativo, usa_comanda, usa_pedidos, cupom_config`,
      [nome, ativo, req.params.id, req.user.tenantId, usaComanda, cupomConfig ? JSON.stringify(cupomConfig) : null, usaPedidos]
    );
    if (atual.ativo && !ativo) {
      await client.query(`UPDATE terminals SET ativo = false WHERE location_id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'editar',
      recurso: 'locations',
      recursoId: req.params.id,
      detalhes: { antes: { nome: atual.nome, ativo: atual.ativo, usa_comanda: atual.usa_comanda }, depois: { nome: rows[0].nome, ativo: rows[0].ativo, usa_comanda: rows[0].usa_comanda, usa_pedidos: rows[0].usa_pedidos } },
    });
    await client.query('COMMIT');
    res.json({ ...rows[0], cupom_config: configEfetiva(rows[0].cupom_config) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Recebimento pelo garcom (modulo Garcom e comandas): liga/desliga, formas liberadas, taxa de servico e terminal de comandas.
router.put('/locations/:id/recebimento-garcom', requireArea('Configuracoes'), requireModulo('garcom'), async (req, res) => {
  const b = req.body || {};
  const atual = await getOwned(pool, 'locations', req.params.id, req.user.tenantId, { columns: 'id, nome, taxa_servico_pct, garcom_recebe, garcom_formas, terminal_comandas_id' });
  const recebe = b.garcom_recebe === undefined ? atual.garcom_recebe : !!b.garcom_recebe;
  const f = b.garcom_formas === undefined ? atual.garcom_formas : b.garcom_formas;
  if (!f || typeof f !== 'object' || Array.isArray(f) || ['pix', 'cartao', 'dinheiro'].some((k) => typeof f[k] !== 'boolean')) throw new HttpError(400, 'formas liberadas: informe pix, cartao e dinheiro (true/false)');
  const pct = b.taxa_servico_pct === undefined ? Number(atual.taxa_servico_pct) : Number(b.taxa_servico_pct);
  if (!(pct >= 0 && pct <= 100)) throw new HttpError(400, 'taxa de serviço: de 0 a 100%');
  let terminalId = b.terminal_comandas_id === undefined ? atual.terminal_comandas_id : (b.terminal_comandas_id || null);
  if (terminalId) {
    const t = (await pool.query(`SELECT id FROM terminals WHERE id = $1 AND tenant_id = $2 AND location_id = $3 AND ativo`, [terminalId, req.user.tenantId, atual.id])).rows[0];
    if (!t) throw new HttpError(400, 'o terminal de comandas precisa ser um PDV ativo desta loja');
  } else terminalId = null;
  const { rows } = await pool.query(
    `UPDATE locations SET garcom_recebe = $1, garcom_formas = $2, taxa_servico_pct = $3, terminal_comandas_id = $4 WHERE id = $5 AND tenant_id = $6
     RETURNING id, nome, taxa_servico_pct, garcom_recebe, garcom_formas, terminal_comandas_id`,
    [recebe, JSON.stringify({ pix: f.pix, cartao: f.cartao, dinheiro: f.dinheiro }), pct, terminalId, atual.id, req.user.tenantId]
  );
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'config_recebimento_garcom', recurso: 'locations', recursoId: atual.id,
    detalhes: { antes: { garcom_recebe: atual.garcom_recebe, formas: atual.garcom_formas, taxa_servico_pct: Number(atual.taxa_servico_pct), terminal_comandas_id: atual.terminal_comandas_id }, depois: { garcom_recebe: recebe, formas: f, taxa_servico_pct: pct, terminal_comandas_id: terminalId } },
  });
  res.json(rows[0]);
});

// Uma loja so pode ser excluida se nunca teve movimentacao: sem saldo, sem entradas/saidas/transferencias
// (produtos e insumos), sem vendas, sem caixa e sem usuarios vinculados. Caso contrario, so desativar.
async function motivoParaNaoExcluir(db, id, tenantId) {
  const { rows } = await db.query(
    `SELECT
       EXISTS(SELECT 1 FROM stock_movements WHERE tenant_id = $2 AND (location_origem_id = $1 OR location_destino_id = $1)) AS mov_produtos,
       EXISTS(SELECT 1 FROM stock_balances WHERE tenant_id = $2 AND location_id = $1 AND saldo <> 0) AS saldo_produtos,
       EXISTS(SELECT 1 FROM ingredient_balances WHERE tenant_id = $2 AND location_id = $1 AND saldo <> 0) AS saldo_insumos,
       EXISTS(SELECT 1 FROM audit_logs WHERE tenant_id = $2 AND recurso = 'ingredients' AND detalhes::text LIKE '%' || $1::text || '%') AS mov_insumos,
       EXISTS(SELECT 1 FROM ingredient_consumptions WHERE location_id = $1) AS consumo_insumos,
       EXISTS(SELECT 1 FROM sales WHERE tenant_id = $2 AND location_id = $1) AS vendas,
       EXISTS(SELECT 1 FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
              JOIN terminals t ON t.id = cr.terminal_id WHERE t.location_id = $1 AND cs.tenant_id = $2) AS caixas,
       EXISTS(SELECT 1 FROM users WHERE tenant_id = $2 AND location_id = $1) AS usuarios`,
    [id, tenantId]
  );
  const r = rows[0];
  if (r.usuarios) return 'há usuários vinculados a esta loja; mude a loja deles antes de excluir';
  if (r.saldo_produtos || r.saldo_insumos) return 'esta loja ainda tem estoque; só é possível desativar depois de zerar';
  if (r.mov_produtos || r.mov_insumos || r.consumo_insumos || r.vendas || r.caixas) return 'esta loja já tem movimentação (estoque, vendas ou caixa), então só pode ser desativada';
  return null;
}

router.delete('/locations/:id', requireArea('Configuracoes'), async (req, res) => {
  const atual = await getOwned(pool, 'locations', req.params.id, req.user.tenantId, { columns: 'id, nome, ativo' });
  const motivo = await motivoParaNaoExcluir(pool, req.params.id, req.user.tenantId);
  if (motivo) throw new HttpError(409, motivo);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM stock_balances WHERE location_id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    await client.query(`DELETE FROM ingredient_balances WHERE location_id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    await client.query(`DELETE FROM cash_registers WHERE tenant_id = $2 AND terminal_id IN (SELECT id FROM terminals WHERE location_id = $1)`, [req.params.id, req.user.tenantId]);
    await client.query(`DELETE FROM terminals WHERE location_id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    await client.query(`DELETE FROM locations WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'excluir', recurso: 'locations', recursoId: req.params.id, detalhes: { nome: atual.nome } });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') throw new HttpError(409, 'esta loja já tem movimentação, então só pode ser desativada');
    throw err;
  } finally {
    client.release();
  }
});

// Usuario vinculado a um local so enxerga os terminais (PDVs) daquele local.
router.get('/terminals', async (req, res) => {
  const params = [req.user.tenantId];
  let where = 't.tenant_id = $1';
  const locais = filtroLocais(req.user, null);
  if (locais) {
    params.push(locais);
    where += ` AND t.location_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.nome, t.location_id, l.nome AS location_nome, t.ativo,
            EXISTS(SELECT 1 FROM cash_registers cr JOIN cash_sessions cs ON cs.cash_register_id = cr.id
                   WHERE cr.terminal_id = t.id AND cs.fechado_em IS NULL) AS caixa_aberto
     FROM terminals t JOIN locations l ON l.id = t.location_id
     WHERE ${where} ORDER BY l.nome, t.nome`,
    params
  );
  res.json(rows);
});

router.post('/terminals', requireArea('Configuracoes'), async (req, res) => {
  const { location_id } = req.body || {};
  const nome = String((req.body && req.body.nome) || '').trim();
  if (!nome || !location_id) return res.status(400).json({ erro: 'nome e location_id são obrigatórios' });
  await getOwnedLocation(pool, location_id, req.user.tenantId);
  await checarLimite(pool, req.user.tenantId, 'pdvs');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO terminals (tenant_id, location_id, nome) VALUES ($1, $2, $3) RETURNING id, nome, location_id, ativo`,
      [req.user.tenantId, location_id, nome]
    );
    await client.query(
      `INSERT INTO cash_registers (tenant_id, terminal_id) VALUES ($1, $2)`,
      [req.user.tenantId, rows[0].id]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/terminals/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  const atual = await getOwned(pool, 'terminals', req.params.id, req.user.tenantId, { columns: 'id, nome, location_id, ativo' });
  const nome = body.nome !== undefined ? String(body.nome).trim() : atual.nome;
  if (!nome) throw new HttpError(400, 'nome é obrigatório');
  const ativo = body.ativo !== undefined ? !!body.ativo : atual.ativo;

  if (ativo && !atual.ativo) {
    await getOwnedLocation(pool, atual.location_id, req.user.tenantId);
  }
  if (!ativo && atual.ativo) {
    const caixa = await pool.query(
      `SELECT 1 FROM cash_sessions cs JOIN cash_registers cr ON cr.id = cs.cash_register_id
       WHERE cr.terminal_id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL LIMIT 1`,
      [req.params.id, req.user.tenantId]
    );
    if (caixa.rows.length > 0) throw new HttpError(400, 'este terminal está com o caixa aberto; feche-o antes de desativar');
  }

  const { rows } = await pool.query(
    `UPDATE terminals SET nome = $1, ativo = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id, nome, location_id, ativo`,
    [nome, ativo, req.params.id, req.user.tenantId]
  );
  res.json(rows[0]);
});

module.exports = router;
