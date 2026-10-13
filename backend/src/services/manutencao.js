// Manutencao segura do banco. Nada aqui apaga dados.
//  - verificarSaldos: compara stock_balances com a soma de stock_movements por (produto, loja) e SO RELATA divergencias.
//    Saldo esperado = saldo_novo do ULTIMO balanco (contagem fisica) + entradas, saidas e transferencias POSTERIORES a ele
//    (sem balanco, a soma de todos os movimentos). Assim a correcao (que grava um balanco) fecha a divergencia de vez.
//    Insumos (ingredients) nao tem tabela de movimentos (so a auditoria), entao nao entram nesta verificacao.
//    Produtos com saldo inicial sem movimento de entrada (ex.: dados de exemplo) aparecem como divergencia: e esperado.
//  - corrigirSaldos: grava, por divergencia, um movimento tipo 'balanco' (saldo_anterior -> saldo esperado) e a auditoria.
//    Divergencias cujo esperado seria negativo nao sao corrigidas (o banco nao aceita saldo < 0): ficam so no relatorio.
//  - otimizar: ANALYZE (rapido, nao bloqueia leituras/escritas). Nao usa VACUUM FULL nem REINDEX.
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');

const SQL_ESPERADO = `
  WITH ult AS (
    SELECT DISTINCT ON (product_id, location_origem_id) tenant_id, product_id, location_origem_id AS location_id, saldo_novo, criado_em
      FROM stock_movements WHERE tipo = 'balanco' ORDER BY product_id, location_origem_id, criado_em DESC, id DESC
  ), mov AS (
    SELECT tenant_id, product_id, location_destino_id AS loja, quantidade AS q, criado_em FROM stock_movements WHERE tipo = 'entrada'
    UNION ALL SELECT tenant_id, product_id, location_origem_id, -quantidade, criado_em FROM stock_movements WHERE tipo = 'saida'
    UNION ALL SELECT tenant_id, product_id, location_origem_id, -quantidade, criado_em FROM stock_movements WHERE tipo = 'transferencia'
    UNION ALL SELECT tenant_id, product_id, location_destino_id, quantidade, criado_em FROM stock_movements WHERE tipo = 'transferencia'
  ), soma AS (
    SELECT m.tenant_id, m.product_id, m.loja AS location_id, SUM(m.q) AS s
      FROM mov m LEFT JOIN ult u ON u.product_id = m.product_id AND u.location_id = m.loja
     WHERE m.loja IS NOT NULL AND (u.criado_em IS NULL OR m.criado_em > u.criado_em) GROUP BY 1, 2, 3
  ), chaves AS (
    SELECT tenant_id, product_id, location_id FROM soma UNION SELECT tenant_id, product_id, location_id FROM ult
  ), esperado AS (
    SELECT k.tenant_id, k.product_id, k.location_id, COALESCE(u.saldo_novo, 0) + COALESCE(s.s, 0) AS esperado
      FROM chaves k LEFT JOIN ult u ON u.product_id = k.product_id AND u.location_id = k.location_id
      LEFT JOIN soma s ON s.product_id = k.product_id AND s.location_id = k.location_id
  )
  SELECT COALESCE(sb.tenant_id, e.tenant_id) AS tenant_id, COALESCE(sb.product_id, e.product_id) AS product_id,
         COALESCE(sb.location_id, e.location_id) AS location_id, COALESCE(sb.saldo, 0) AS saldo, COALESCE(e.esperado, 0) AS esperado
    FROM stock_balances sb FULL JOIN esperado e ON e.product_id = sb.product_id AND e.location_id = sb.location_id`;

async function divergencias(db, empresaId) {
  const { rows } = await db.query(
    `SELECT d.*, t.nome AS empresa_nome, p.nome AS produto_nome, l.nome AS loja_nome
       FROM (${SQL_ESPERADO}) d
       JOIN tenants t ON t.id = d.tenant_id JOIN products p ON p.id = d.product_id JOIN locations l ON l.id = d.location_id
      WHERE d.saldo <> d.esperado ${empresaId ? 'AND d.tenant_id = $1' : ''}
      ORDER BY t.nome, p.nome, l.nome LIMIT 1000`,
    empresaId ? [empresaId] : []
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id, empresa: r.empresa_nome, product_id: r.product_id, produto: r.produto_nome, location_id: r.location_id, loja: r.loja_nome,
    saldo: Number(r.saldo), esperado: Number(r.esperado), diferenca: Number((Number(r.saldo) - Number(r.esperado)).toFixed(3)),
  }));
}

async function verificarSaldos(db, { empresaId } = {}) {
  const itens = await divergencias(db, empresaId);
  return { total: itens.length, itens, insumos: 'não verificados (sem histórico de movimentos)' };
}

async function corrigirSaldos(db, { empresaId, usuarioId, tenantAuditoria }) {
  if (!empresaId) throw new HttpError(400, 'escolha a empresa');
  const itens = await divergencias(db, empresaId);
  const client = await db.connect();
  let corrigidos = 0;
  const ignorados = [];
  try {
    await client.query('BEGIN');
    for (const d of itens) {
      if (d.esperado < 0) { ignorados.push({ produto: d.produto, loja: d.loja, motivo: 'esperado negativo' }); continue; }
      // trava o saldo e confere de novo (pode ter mudado desde o relatorio)
      const atual = await client.query(`SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND tenant_id = $3 FOR UPDATE`, [d.product_id, d.location_id, d.tenant_id]);
      const saldoAtual = atual.rows[0] ? Number(atual.rows[0].saldo) : null;
      if (saldoAtual === null) { ignorados.push({ produto: d.produto, loja: d.loja, motivo: 'sem linha de saldo' }); continue; }
      if (saldoAtual === d.esperado) continue;
      await client.query(`UPDATE stock_balances SET saldo = $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`, [d.esperado, d.product_id, d.location_id, d.tenant_id]);
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, saldo_anterior, saldo_novo)
         VALUES ($1, $2, 'balanco', $3, $4, $4, $5, $6, $7, $8)`,
        [d.tenant_id, d.product_id, Math.abs(saldoAtual - d.esperado), d.location_id, 'Correção de divergência de saldo (Master)', usuarioId, saldoAtual, d.esperado]
      );
      corrigidos += 1;
    }
    await logAudit(client, { tenantId: tenantAuditoria, usuarioId, acao: 'master_corrigir_saldos', recurso: 'stock_balances', detalhes: { empresa_id: empresaId, corrigidos, ignorados: ignorados.length } });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { corrigidos, ignorados };
}

async function otimizar(db) {
  const t0 = Date.now();
  await db.query('ANALYZE');
  return { duracao_ms: Date.now() - t0 };
}

module.exports = { verificarSaldos, corrigirSaldos, otimizar };
