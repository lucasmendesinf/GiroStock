const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const { HttpError } = require('../utils/http');

const router = express.Router();

// Terminal da empresa e do local do usuario (usuario vinculado a um local so opera os caixas dele).
async function getTerminalDoUsuario(db, terminalId, user) {
  const terminal = await getOwned(db, 'terminals', terminalId, user.tenantId, { columns: 'id, location_id, ativo' });
  assertLocationAccess(user, terminal.location_id, 'operar o caixa deste terminal');
  return terminal;
}

// Sessao de caixa aberta da empresa, travada, conferindo o acesso ao local do terminal.
async function getSessaoAbertaDoUsuario(client, sessionId, user) {
  const { rows } = await client.query(
    `SELECT cs.id, t.location_id FROM cash_sessions cs
     JOIN cash_registers cr ON cr.id = cs.cash_register_id
     JOIN terminals t ON t.id = cr.terminal_id
     WHERE cs.id = $1 AND cs.tenant_id = $2 AND cs.fechado_em IS NULL
     FOR UPDATE OF cs`,
    [sessionId, user.tenantId]
  );
  if (rows.length === 0) throw new HttpError(404, 'sessao de caixa aberta nao encontrada');
  assertLocationAccess(user, rows[0].location_id, 'operar o caixa deste terminal');
  return rows[0];
}

async function computeSaldoDisponivel(client, tenantId, sessionId) {
  const session = await client.query(
    `SELECT valor_inicial FROM cash_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  );
  if (session.rows.length === 0) return null;

  const vendasDinheiro = await client.query(
    `SELECT COALESCE(SUM(total), 0) AS total FROM sales
     WHERE cash_session_id = $1 AND tenant_id = $2 AND forma_pagamento = 'dinheiro' AND status = 'concluida'`,
    [sessionId, tenantId]
  );
  const movimentos = await client.query(
    `SELECT tipo, COALESCE(SUM(valor), 0) AS total FROM cash_movements
     WHERE cash_session_id = $1 AND tenant_id = $2 GROUP BY tipo`,
    [sessionId, tenantId]
  );
  let sangrias = 0;
  let suprimentos = 0;
  for (const row of movimentos.rows) {
    if (row.tipo === 'sangria') sangrias = Number(row.total);
    if (row.tipo === 'suprimento') suprimentos = Number(row.total);
  }

  const inicial = Number(session.rows[0].valor_inicial);
  const dinheiro = Number(vendasDinheiro.rows[0].total);
  return inicial + dinheiro + suprimentos - sangrias;
}

router.get('/cash-sessions/current', requireArea('Vendas'), async (req, res) => {
  const { terminal_id } = req.query;
  if (!terminal_id) return res.status(400).json({ erro: 'terminal_id e obrigatorio' });
  await getTerminalDoUsuario(pool, terminal_id, req.user);

  const register = await pool.query(
    `SELECT id FROM cash_registers WHERE terminal_id = $1 AND tenant_id = $2`,
    [terminal_id, req.user.tenantId]
  );
  if (register.rows.length === 0) return res.status(404).json({ erro: 'caixa nao configurado para este terminal' });

  const { rows } = await pool.query(
    `SELECT id, cash_register_id, valor_inicial, aberto_em
     FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL`,
    [register.rows[0].id, req.user.tenantId]
  );
  res.json(rows[0] || null);
});

router.post('/cash-sessions', requireArea('Vendas'), async (req, res) => {
  const { terminal_id, valor_inicial } = req.body || {};
  const valor = Number(valor_inicial);
  if (!terminal_id || !(valor >= 0)) {
    return res.status(400).json({ erro: 'terminal_id e valor_inicial (>=0) sao obrigatorios' });
  }

  const terminal = await getTerminalDoUsuario(pool, terminal_id, req.user);
  if (!terminal.ativo) throw new HttpError(400, 'terminal inativo');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const register = await client.query(
      `SELECT id FROM cash_registers WHERE terminal_id = $1 AND tenant_id = $2`,
      [terminal_id, req.user.tenantId]
    );
    if (register.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'caixa nao configurado para este terminal' });
    }

    const existing = await client.query(
      `SELECT id FROM cash_sessions WHERE cash_register_id = $1 AND tenant_id = $2 AND fechado_em IS NULL`,
      [register.rows[0].id, req.user.tenantId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ erro: 'ja existe uma sessao de caixa aberta para este terminal' });
    }

    const { rows } = await client.query(
      `INSERT INTO cash_sessions (tenant_id, cash_register_id, usuario_abertura_id, valor_inicial)
       VALUES ($1, $2, $3, $4)
       RETURNING id, cash_register_id, valor_inicial, aberto_em`,
      [req.user.tenantId, register.rows[0].id, req.user.id, valor]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'abrir_caixa',
      recurso: 'cash_sessions',
      recursoId: rows[0].id,
      detalhes: { valor_inicial: valor },
    });

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/cash-sessions/:id/movements', requireArea('Vendas'), async (req, res) => {
  const { tipo, valor, motivo } = req.body || {};
  const val = Number(valor);
  if (!['sangria', 'suprimento'].includes(tipo) || !(val > 0) || !motivo) {
    return res.status(400).json({ erro: 'tipo (sangria/suprimento), valor (>0) e motivo sao obrigatorios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await getSessaoAbertaDoUsuario(client, req.params.id, req.user);

    if (tipo === 'sangria') {
      const saldoDisponivel = await computeSaldoDisponivel(client, req.user.tenantId, req.params.id);
      if (saldoDisponivel < val) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          erro: `sangria maior que o saldo disponivel em caixa (disponivel: ${saldoDisponivel.toFixed(2)})`,
        });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO cash_movements (tenant_id, cash_session_id, tipo, valor, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tipo, valor, motivo, criado_em`,
      [req.user.tenantId, req.params.id, tipo, val, motivo, req.user.id]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: tipo,
      recurso: 'cash_movements',
      recursoId: rows[0].id,
      detalhes: { valor: val },
    });

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/cash-sessions/:id/close', requireArea('Vendas'), async (req, res) => {
  const { valor_informado } = req.body || {};
  const informado = Number(valor_informado);
  if (!(informado >= 0)) return res.status(400).json({ erro: 'valor_informado (>=0) e obrigatorio' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await getSessaoAbertaDoUsuario(client, req.params.id, req.user);

    const esperado = await computeSaldoDisponivel(client, req.user.tenantId, req.params.id);
    const diferenca = informado - esperado;

    const { rows } = await client.query(
      `UPDATE cash_sessions
       SET fechado_em = now(), valor_informado_fechamento = $1, valor_esperado_fechamento = $2, diferenca = $3
       WHERE id = $4
       RETURNING id, fechado_em, valor_esperado_fechamento, valor_informado_fechamento, diferenca`,
      [informado, esperado, diferenca, req.params.id]
    );

    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'fechar_caixa',
      recurso: 'cash_sessions',
      recursoId: req.params.id,
      detalhes: { esperado, informado, diferenca },
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
