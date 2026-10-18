// Financeiro: contas a pagar/receber, contas financeiras, prazos/taxas das formas de pagamento, fluxo de caixa,
// resultado do mes e resumo. Modulo "financeiro" e area Financeiro obrigatorios.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { getOwned, isUuid } = require('../utils/tenant');
const { logAudit } = require('../utils/audit');
const fin = require('../services/financeiro');

const router = express.Router();
router.use('/financeiro', requireModulo('financeiro'), requireArea('Financeiro'), async (req, res, next) => {
  try { await fin.garantirPadroes(pool, req.user.tenantId); next(); } catch (err) { next(err); }
});

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MES_RE = /^\d{4}-\d{2}$/;
const texto = (v, max = 300) => { const t = String(v === undefined || v === null ? '' : v).trim(); return t ? t.slice(0, max) : null; };
function data(v, campo, obrigatoria = true) {
  if (v === undefined || v === null || v === '') { if (obrigatoria) throw new HttpError(400, `${campo} é obrigatório(a)`); return null; }
  if (!DATA_RE.test(String(v)) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw new HttpError(400, `${campo} inválido(a): use AAAA-MM-DD`);
  return String(v);
}
function valor(v, campo = 'valor') {
  const n = typeof v === 'string' ? Number(v.replace(/\./g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${campo} deve ser maior que zero`);
  if (n > 99999999) throw new HttpError(400, `${campo} muito alto`);
  return Math.round(n * 100) / 100;
}
// Soma meses mantendo o dia (31/01 + 1 mes = 28/02).
function maisMeses(dataTxt, meses) {
  const [a, m, d] = dataTxt.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}
const FORMAS_BAIXA = ['dinheiro', 'pix', 'boleto', 'transferencia', 'cartao_debito', 'cartao_credito', 'cheque', 'outro'];

const SELECT_TITULO = `
  SELECT t.id, t.tipo, t.descricao, t.categoria_id, c.nome AS categoria_nome, t.supplier_id, s.nome AS supplier_nome,
         t.customer_id, cu.nome AS customer_nome, t.location_id, l.nome AS location_nome,
         t.valor, t.vencimento::text, t.competencia::text, t.documento, t.observacao, t.parcela, t.parcelas, t.grupo_id, t.origem,
         t.pago_em::text, t.valor_pago, t.conta_id, ct.nome AS conta_nome, t.forma_pagamento, t.cancelado_em, t.motivo_cancelamento,
         t.criado_em, ${fin.SITUACAO} AS situacao, (t.vencimento - ${fin.HOJE}) AS dias_para_vencer
  FROM fin_titulos t
  LEFT JOIN fin_categorias c ON c.id = t.categoria_id
  LEFT JOIN suppliers s ON s.id = t.supplier_id
  LEFT JOIN customers cu ON cu.id = t.customer_id
  LEFT JOIN locations l ON l.id = t.location_id
  LEFT JOIN fin_contas ct ON ct.id = t.conta_id`;

async function titulo(db, tenantId, id) {
  if (!isUuid(id)) throw new HttpError(400, 'identificador inválido');
  const { rows } = await db.query(`${SELECT_TITULO} WHERE t.id = $1 AND t.tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'lançamento não encontrado');
  return rows[0];
}

async function validarVinculos(db, tenantId, tipo, b) {
  const r = {};
  if (b.categoria_id) {
    const c = await getOwned(db, 'fin_categorias', b.categoria_id, tenantId, { columns: 'id, tipo' });
    if (c.tipo !== (tipo === 'pagar' ? 'despesa' : 'receita')) throw new HttpError(400, `a categoria precisa ser de ${tipo === 'pagar' ? 'despesa' : 'receita'}`);
    r.categoria_id = c.id;
  } else r.categoria_id = null;
  r.supplier_id = b.supplier_id ? (await getOwned(db, 'suppliers', b.supplier_id, tenantId, { columns: 'id' })).id : null;
  r.customer_id = b.customer_id ? (await getOwned(db, 'customers', b.customer_id, tenantId, { columns: 'id' })).id : null;
  r.location_id = b.location_id ? (await getOwned(db, 'locations', b.location_id, tenantId, { columns: 'id' })).id : null;
  return r;
}

async function validarBaixa(db, tenantId, b, valorPadrao) {
  const conta = b.conta_id ? (await getOwned(db, 'fin_contas', b.conta_id, tenantId, { columns: 'id, ativo' })) : null;
  if (conta && !conta.ativo) throw new HttpError(400, 'esta conta está desativada');
  const forma = texto(b.forma_pagamento, 30);
  if (forma && !FORMAS_BAIXA.includes(forma)) throw new HttpError(400, 'forma de pagamento inválida');
  return {
    pago_em: data(b.pago_em || (await fin.hoje(db)), 'data do pagamento'),
    valor_pago: b.valor_pago === undefined || b.valor_pago === null || b.valor_pago === '' ? valorPadrao : valor(b.valor_pago, 'valor pago'),
    conta_id: conta ? conta.id : null,
    forma_pagamento: forma,
  };
}

// ---------------------------------------------------------------- contas a pagar / receber
// Filtros: tipo (pagar|receber), situacao (aberto|vencido|pago|cancelado|pendente = aberto+vencido), de/ate (vencimento),
// q (descricao/documento/fornecedor/cliente), categoria_id, supplier_id, customer_id, location_id.
router.get('/financeiro/titulos', async (req, res) => {
  const q = req.query;
  const p = [req.user.tenantId];
  let w = 't.tenant_id = $1';
  if (q.tipo) { if (!['pagar', 'receber'].includes(q.tipo)) throw new HttpError(400, 'tipo inválido'); p.push(q.tipo); w += ` AND t.tipo = $${p.length}`; }
  if (q.de) { p.push(data(q.de, 'de')); w += ` AND t.vencimento >= $${p.length}::date`; }
  if (q.ate) { p.push(data(q.ate, 'até')); w += ` AND t.vencimento <= $${p.length}::date`; }
  for (const k of ['categoria_id', 'supplier_id', 'customer_id', 'location_id']) {
    if (q[k]) { if (!isUuid(q[k])) throw new HttpError(400, `${k} inválido`); p.push(q[k]); w += ` AND t.${k} = $${p.length}`; }
  }
  if (q.q) { p.push(`%${String(q.q).trim()}%`); w += ` AND (t.descricao ILIKE $${p.length} OR t.documento ILIKE $${p.length} OR s.nome ILIKE $${p.length} OR cu.nome ILIKE $${p.length})`; }
  let filtroSit = '';
  if (q.situacao) {
    const sits = q.situacao === 'pendente' ? ['aberto', 'vencido'] : String(q.situacao).split(',');
    if (sits.some((x) => !['aberto', 'vencido', 'pago', 'cancelado'].includes(x))) throw new HttpError(400, 'situação inválida');
    p.push(sits);
    filtroSit = ` WHERE situacao = ANY($${p.length}::text[])`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM (${SELECT_TITULO} WHERE ${w}) x${filtroSit} ORDER BY (situacao IN ('pago', 'cancelado')), vencimento, descricao LIMIT 1000`, p
  );
  const soma = (sit) => Number(rows.filter((r) => sit.includes(r.situacao)).reduce((s, r) => s + Number(sit.includes('pago') ? r.valor_pago : r.valor), 0).toFixed(2));
  res.json({ titulos: rows, totais: { pendente: soma(['aberto', 'vencido']), vencido: soma(['vencido']), pago: soma(['pago']) } });
});

router.get('/financeiro/titulos/:id', async (req, res) => {
  const t = await titulo(pool, req.user.tenantId, req.params.id);
  const grupo = t.grupo_id ? (await pool.query(`${SELECT_TITULO} WHERE t.grupo_id = $1 AND t.tenant_id = $2 ORDER BY t.parcela`, [t.grupo_id, req.user.tenantId])).rows : [t];
  res.json({ ...t, grupo });
});

// Novo lancamento. Uma parcela, ou:
//   repetir: { modo: 'parcelas', quantidade }  -> o valor e dividido em N parcelas mensais (centavos na 1a)
//   repetir: { modo: 'mensal', quantidade }    -> o mesmo valor repetido N meses (ex.: aluguel)
//   parcelas_informadas: [{ vencimento, valor, numero? }] -> parcelas prontas (ex.: duplicatas da NF-e)
// pago: { pago_em, conta_id, forma_pagamento } -> ja lanca como pago (so lancamento de uma parcela).
router.post('/financeiro/titulos', async (req, res) => {
  const b = req.body || {};
  const tipo = b.tipo;
  if (!['pagar', 'receber'].includes(tipo)) throw new HttpError(400, 'tipo deve ser pagar ou receber');
  const descricao = texto(b.descricao, 200);
  if (!descricao || descricao.length < 2) throw new HttpError(400, 'descrição é obrigatória');
  const vinc = await validarVinculos(pool, req.user.tenantId, tipo, b);
  const documento = texto(b.documento, 60);
  const observacao = texto(b.observacao, 500);
  const origem = b.origem === 'nota' ? 'nota' : 'manual';

  let parcelas;
  if (Array.isArray(b.parcelas_informadas) && b.parcelas_informadas.length > 0) {
    if (b.parcelas_informadas.length > 120) throw new HttpError(400, 'no máximo 120 parcelas');
    parcelas = b.parcelas_informadas.map((x, i) => ({ vencimento: data(x.vencimento, `vencimento da parcela ${i + 1}`), valor: valor(x.valor, `valor da parcela ${i + 1}`), documento: texto(x.numero, 60) }));
  } else {
    const total = valor(b.valor);
    const venc = data(b.vencimento, 'vencimento');
    const rep = b.repetir || {};
    const n = rep.modo ? Number(rep.quantidade) : 1;
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new HttpError(400, 'quantidade de parcelas/meses entre 1 e 120');
    if (rep.modo && !['parcelas', 'mensal'].includes(rep.modo)) throw new HttpError(400, 'repetição inválida');
    if (rep.modo === 'parcelas') {
      const base = Math.floor((total / n) * 100) / 100;
      const resto = Math.round((total - base * n) * 100) / 100;
      parcelas = Array.from({ length: n }, (_, i) => ({ vencimento: maisMeses(venc, i), valor: Math.round((base + (i === 0 ? resto : 0)) * 100) / 100 }));
    } else {
      parcelas = Array.from({ length: n }, (_, i) => ({ vencimento: maisMeses(venc, i), valor: total }));
    }
  }
  // competencia: informada (vale para a 1a; as seguintes andam um mes) ou o vencimento de cada parcela
  const compBase = b.competencia ? data(b.competencia, 'competência') : null;
  const pago = b.pago && parcelas.length === 1 ? await validarBaixa(pool, req.user.tenantId, b.pago, parcelas[0].valor) : null;
  const grupo = parcelas.length > 1 ? crypto.randomUUID() : null;

  const client = await pool.connect();
  const ids = [];
  try {
    await client.query('BEGIN');
    for (const [i, x] of parcelas.entries()) {
      // mensal (ex.: aluguel): cada mes e de uma competencia; parcelas de uma compra: todas na competencia informada
      const comp = !compBase ? x.vencimento : (b.repetir && b.repetir.modo === 'mensal' ? maisMeses(compBase, i) : compBase);
      const desc = parcelas.length > 1 && !(b.repetir && b.repetir.modo === 'mensal') ? `${descricao} (${i + 1}/${parcelas.length})` : descricao;
      const { rows } = await client.query(
        `INSERT INTO fin_titulos (tenant_id, tipo, descricao, categoria_id, supplier_id, customer_id, location_id, valor, vencimento, competencia,
                                  documento, observacao, parcela, parcelas, grupo_id, origem, pago_em, valor_pago, conta_id, forma_pagamento, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [req.user.tenantId, tipo, desc, vinc.categoria_id, vinc.supplier_id, vinc.customer_id, vinc.location_id, x.valor, x.vencimento, comp,
          x.documento || documento, observacao, i + 1, parcelas.length, grupo, origem,
          pago ? pago.pago_em : null, pago ? pago.valor_pago : null, pago ? pago.conta_id : null, pago ? pago.forma_pagamento : null, req.user.id]
      );
      ids.push(rows[0].id);
    }
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: tipo === 'pagar' ? 'fin_conta_pagar_criar' : 'fin_conta_receber_criar', recurso: 'fin_titulos', recursoId: ids[0],
      detalhes: { descricao, parcelas: parcelas.length, total: Number(parcelas.reduce((s, x) => s + x.valor, 0).toFixed(2)), origem, documento } });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const criados = (await pool.query(`${SELECT_TITULO} WHERE t.id = ANY($1::uuid[]) ORDER BY t.parcela`, [ids])).rows;
  res.status(201).json(criados);
});

// Editar (so lancamento em aberto; pago: estorne antes).
router.put('/financeiro/titulos/:id', async (req, res) => {
  const t = await titulo(pool, req.user.tenantId, req.params.id);
  if (t.situacao === 'cancelado') throw new HttpError(409, 'lançamento cancelado não pode ser alterado');
  if (t.situacao === 'pago') throw new HttpError(409, 'lançamento já pago: estorne o pagamento para alterar');
  const b = req.body || {};
  const descricao = b.descricao !== undefined ? texto(b.descricao, 200) : t.descricao;
  if (!descricao || descricao.length < 2) throw new HttpError(400, 'descrição é obrigatória');
  const vinc = await validarVinculos(pool, req.user.tenantId, t.tipo, {
    categoria_id: b.categoria_id !== undefined ? b.categoria_id : t.categoria_id,
    supplier_id: b.supplier_id !== undefined ? b.supplier_id : t.supplier_id,
    customer_id: b.customer_id !== undefined ? b.customer_id : t.customer_id,
    location_id: b.location_id !== undefined ? b.location_id : t.location_id,
  });
  const v = b.valor !== undefined ? valor(b.valor) : Number(t.valor);
  const venc = b.vencimento !== undefined ? data(b.vencimento, 'vencimento') : t.vencimento;
  const comp = b.competencia !== undefined ? data(b.competencia, 'competência') : t.competencia;
  await pool.query(
    `UPDATE fin_titulos SET descricao = $3, categoria_id = $4, supplier_id = $5, customer_id = $6, location_id = $7, valor = $8, vencimento = $9,
            competencia = $10, documento = $11, observacao = $12, atualizado_em = now() WHERE id = $1 AND tenant_id = $2`,
    [t.id, req.user.tenantId, descricao, vinc.categoria_id, vinc.supplier_id, vinc.customer_id, vinc.location_id, v, venc, comp,
      b.documento !== undefined ? texto(b.documento, 60) : t.documento, b.observacao !== undefined ? texto(b.observacao, 500) : t.observacao]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_titulo_editar', recurso: 'fin_titulos', recursoId: t.id, detalhes: { descricao, valor: v, vencimento: venc } });
  res.json(await titulo(pool, req.user.tenantId, t.id));
});

// Pagar (conta a pagar) / receber (conta a receber).
router.post('/financeiro/titulos/:id/baixar', async (req, res) => {
  const t = await titulo(pool, req.user.tenantId, req.params.id);
  if (t.situacao === 'cancelado') throw new HttpError(409, 'lançamento cancelado');
  if (t.situacao === 'pago') throw new HttpError(409, t.tipo === 'pagar' ? 'esta conta já foi paga' : 'esta conta já foi recebida');
  const bx = await validarBaixa(pool, req.user.tenantId, req.body || {}, Number(t.valor));
  await pool.query(`UPDATE fin_titulos SET pago_em = $3, valor_pago = $4, conta_id = $5, forma_pagamento = $6, atualizado_em = now() WHERE id = $1 AND tenant_id = $2`,
    [t.id, req.user.tenantId, bx.pago_em, bx.valor_pago, bx.conta_id, bx.forma_pagamento]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: t.tipo === 'pagar' ? 'fin_conta_paga' : 'fin_conta_recebida', recurso: 'fin_titulos', recursoId: t.id,
    detalhes: { descricao: t.descricao, valor: bx.valor_pago, data: bx.pago_em } });
  res.json(await titulo(pool, req.user.tenantId, t.id));
});

router.post('/financeiro/titulos/:id/estornar', async (req, res) => {
  const t = await titulo(pool, req.user.tenantId, req.params.id);
  if (t.situacao !== 'pago') throw new HttpError(409, 'só dá para estornar um lançamento pago');
  await pool.query(`UPDATE fin_titulos SET pago_em = NULL, valor_pago = NULL, conta_id = NULL, forma_pagamento = NULL, atualizado_em = now() WHERE id = $1 AND tenant_id = $2`, [t.id, req.user.tenantId]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_estorno', recurso: 'fin_titulos', recursoId: t.id, detalhes: { descricao: t.descricao, valor: t.valor_pago, data: t.pago_em } });
  res.json(await titulo(pool, req.user.tenantId, t.id));
});

// Cancelar (nao apaga: fica no historico). todas_do_grupo = cancela tambem as parcelas seguintes ainda em aberto.
router.post('/financeiro/titulos/:id/cancelar', async (req, res) => {
  const t = await titulo(pool, req.user.tenantId, req.params.id);
  if (t.situacao === 'cancelado') throw new HttpError(409, 'este lançamento já está cancelado');
  if (t.situacao === 'pago') throw new HttpError(409, 'lançamento pago: estorne o pagamento antes de cancelar');
  const motivo = texto((req.body || {}).motivo, 200);
  if (!motivo || motivo.length < 3) throw new HttpError(400, 'informe o motivo do cancelamento');
  const todas = !!(req.body || {}).todas_do_grupo && t.grupo_id;
  const { rowCount } = await pool.query(
    `UPDATE fin_titulos SET cancelado_em = now(), motivo_cancelamento = $3, atualizado_em = now()
     WHERE tenant_id = $1 AND cancelado_em IS NULL AND pago_em IS NULL AND (id = $2 OR ($4::uuid IS NOT NULL AND grupo_id = $4 AND parcela > $5))`,
    [req.user.tenantId, t.id, motivo, todas ? t.grupo_id : null, t.parcela]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_titulo_cancelar', recurso: 'fin_titulos', recursoId: t.id, detalhes: { descricao: t.descricao, motivo, cancelados: rowCount } });
  res.json({ cancelados: rowCount });
});

// ---------------------------------------------------------------- vendas a receber (cartao, iFood...)
router.get('/financeiro/vendas-a-receber', async (req, res) => {
  const d = await fin.hoje(pool);
  const de = req.query.de ? data(req.query.de, 'de') : d;
  const ate = req.query.ate ? data(req.query.ate, 'até') : maisMeses(d, 2);
  const linhas = (await fin.vendasRecebiveis(pool, req.user.tenantId, { de, ate })).filter((v) => v.forma !== 'dinheiro' && v.forma !== 'pix');
  const total = (k) => Number(linhas.reduce((s, v) => s + v[k], 0).toFixed(2));
  res.json({ de, ate, linhas, totais: { bruto: total('bruto'), taxa: total('taxa'), liquido: total('liquido') } });
});

// ---------------------------------------------------------------- fluxo, resultado, resumo
router.get('/financeiro/fluxo', async (req, res) => {
  const d = await fin.hoje(pool);
  const de = req.query.de ? data(req.query.de, 'de') : d;
  const ate = req.query.ate ? data(req.query.ate, 'até') : maisMeses(d, 1);
  if (ate < de) throw new HttpError(400, 'o fim do período é antes do início');
  if ((Date.parse(ate) - Date.parse(de)) / 86400000 > 400) throw new HttpError(400, 'período de no máximo 400 dias');
  res.json(await fin.fluxo(pool, req.user.tenantId, { de, ate }));
});

router.get('/financeiro/resultado', async (req, res) => {
  const d = await fin.hoje(pool);
  const mes = req.query.mes || d.slice(0, 7);
  if (!MES_RE.test(mes)) throw new HttpError(400, 'mês inválido: use AAAA-MM');
  const loc = req.query.location_id || null;
  if (loc && !isUuid(loc)) throw new HttpError(400, 'loja inválida');
  const atual = await fin.resultado(pool, req.user.tenantId, mes, { locationId: loc });
  // evolucao dos ultimos 6 meses (receita, lucro bruto, despesas, resultado)
  const serie = [];
  for (let i = 5; i >= 0; i--) {
    const m = maisMeses(`${mes}-01`, -i).slice(0, 7);
    const r = i === 0 ? atual : await fin.resultado(pool, req.user.tenantId, m, { locationId: loc });
    serie.push({ mes: m, receita: r.receita, lucro_bruto: r.lucro_bruto, despesas: r.total_despesas, resultado: r.resultado });
  }
  res.json({ ...atual, serie });
});

router.get('/financeiro/resumo', async (req, res) => {
  const t = req.user.tenantId;
  const d = await fin.hoje(pool);
  const maisDias = (n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const em7 = maisDias(7);
  const grupo = async (tipo) => (await pool.query(
    `SELECT COALESCE(SUM(valor) FILTER (WHERE vencimento < ${fin.HOJE}), 0) AS vencido, COUNT(*) FILTER (WHERE vencimento < ${fin.HOJE})::int AS n_vencido,
            COALESCE(SUM(valor) FILTER (WHERE vencimento = ${fin.HOJE}), 0) AS hoje, COUNT(*) FILTER (WHERE vencimento = ${fin.HOJE})::int AS n_hoje,
            COALESCE(SUM(valor) FILTER (WHERE vencimento > ${fin.HOJE} AND vencimento <= $3::date), 0) AS semana, COUNT(*) FILTER (WHERE vencimento > ${fin.HOJE} AND vencimento <= $3::date)::int AS n_semana
     FROM fin_titulos WHERE tenant_id = $1 AND tipo = $2 AND pago_em IS NULL AND cancelado_em IS NULL`, [t, tipo, em7]
  )).rows[0];
  const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  const pagar = num(await grupo('pagar'));
  const receber = num(await grupo('receber'));
  const vendas7 = (await fin.vendasRecebiveis(pool, t, { de: maisDias(1), ate: em7 })).reduce((s, v) => s + v.liquido, 0);
  const fl = await fin.fluxo(pool, t, { de: d, ate: maisDias(30) });
  const res30 = await fin.resultado(pool, t, d.slice(0, 7));
  const proximos = (await pool.query(`${SELECT_TITULO} WHERE t.tenant_id = $1 AND t.pago_em IS NULL AND t.cancelado_em IS NULL AND t.vencimento <= $2::date ORDER BY t.vencimento, t.tipo LIMIT 12`, [t, em7])).rows;
  res.json({
    hoje: d, saldo: fl.saldo_hoje, contas: fl.contas, pagar, receber, vendas_a_cair_7dias: Number(vendas7.toFixed(2)),
    saldo_em_30_dias: fl.saldo_final, menor_saldo_30_dias: fl.menor_saldo ? { data: fl.menor_saldo.data, saldo: fl.menor_saldo.saldo } : null,
    mes: { mes: res30.mes, receita: res30.receita, lucro_bruto: res30.lucro_bruto, despesas: res30.total_despesas, resultado: res30.resultado, margem_liquida: res30.margem_liquida },
    proximos,
  });
});

// Listas para os formularios (o perfil Financeiro nao tem acesso as telas de estoque/clientes).
router.get('/financeiro/opcoes', async (req, res) => {
  const t = req.user.tenantId;
  const [categorias, contas, fornecedores, clientes, lojas] = await Promise.all([
    pool.query(`SELECT id, tipo, nome, entra_no_resultado FROM fin_categorias WHERE tenant_id = $1 AND ativo ORDER BY nome`, [t]),
    pool.query(`SELECT id, nome, tipo FROM fin_contas WHERE tenant_id = $1 AND ativo ORDER BY nome`, [t]),
    pool.query(`SELECT id, nome, documento FROM suppliers WHERE tenant_id = $1 AND ativo ORDER BY nome`, [t]),
    pool.query(`SELECT id, nome, telefone FROM customers WHERE tenant_id = $1 AND ativo ORDER BY nome LIMIT 2000`, [t]),
    pool.query(`SELECT id, nome FROM locations WHERE tenant_id = $1 AND ativo ORDER BY nome`, [t]),
  ]);
  res.json({ categorias: categorias.rows, contas: contas.rows, fornecedores: fornecedores.rows, clientes: clientes.rows, lojas: lojas.rows, hoje: await fin.hoje(pool) });
});

// ---------------------------------------------------------------- cadastros
router.get('/financeiro/categorias', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.nome, c.entra_no_resultado, c.ativo, (SELECT count(*)::int FROM fin_titulos t WHERE t.categoria_id = c.id) AS lancamentos
     FROM fin_categorias c WHERE c.tenant_id = $1 ORDER BY c.tipo, c.ativo DESC, c.nome`, [req.user.tenantId]);
  res.json(rows);
});
router.post('/financeiro/categorias', async (req, res) => {
  const b = req.body || {};
  if (!['receita', 'despesa'].includes(b.tipo)) throw new HttpError(400, 'tipo deve ser receita ou despesa');
  const nome = texto(b.nome, 80);
  if (!nome || nome.length < 2) throw new HttpError(400, 'nome da categoria é obrigatório');
  const { rows } = await pool.query(`INSERT INTO fin_categorias (tenant_id, tipo, nome, entra_no_resultado) VALUES ($1, $2, $3, $4) RETURNING id, tipo, nome, entra_no_resultado, ativo`,
    [req.user.tenantId, b.tipo, nome, b.entra_no_resultado !== false]);
  res.status(201).json(rows[0]);
});
router.patch('/financeiro/categorias/:id', async (req, res) => {
  const c = await getOwned(pool, 'fin_categorias', req.params.id, req.user.tenantId, { columns: 'id, nome, entra_no_resultado, ativo' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? texto(b.nome, 80) : c.nome;
  if (!nome || nome.length < 2) throw new HttpError(400, 'nome da categoria é obrigatório');
  const { rows } = await pool.query(`UPDATE fin_categorias SET nome = $2, entra_no_resultado = $3, ativo = $4 WHERE id = $1 RETURNING id, tipo, nome, entra_no_resultado, ativo`,
    [c.id, nome, b.entra_no_resultado !== undefined ? !!b.entra_no_resultado : c.entra_no_resultado, b.ativo !== undefined ? !!b.ativo : c.ativo]);
  res.json(rows[0]);
});

router.get('/financeiro/contas', async (req, res) => {
  res.json(await fin.saldosDasContas(pool, req.user.tenantId));
});
router.post('/financeiro/contas', async (req, res) => {
  const b = req.body || {};
  const nome = texto(b.nome, 80);
  if (!nome || nome.length < 2) throw new HttpError(400, 'nome da conta é obrigatório');
  if (b.tipo && !['banco', 'caixa', 'carteira'].includes(b.tipo)) throw new HttpError(400, 'tipo de conta inválido');
  const saldo = b.saldo_inicial === undefined || b.saldo_inicial === '' ? 0 : Number(String(b.saldo_inicial).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(saldo)) throw new HttpError(400, 'saldo inicial inválido');
  const em = data(b.saldo_inicial_em || (await fin.hoje(pool)), 'data do saldo inicial');
  const { rows } = await pool.query(`INSERT INTO fin_contas (tenant_id, nome, tipo, saldo_inicial, saldo_inicial_em) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.user.tenantId, nome, b.tipo || 'banco', saldo, em]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_conta_criar', recurso: 'fin_contas', recursoId: rows[0].id, detalhes: { nome, saldo_inicial: saldo } });
  res.status(201).json((await fin.saldosDasContas(pool, req.user.tenantId)).find((c) => c.id === rows[0].id));
});
router.patch('/financeiro/contas/:id', async (req, res) => {
  const c = await getOwned(pool, 'fin_contas', req.params.id, req.user.tenantId, { columns: 'id, nome, tipo, saldo_inicial, saldo_inicial_em::text, ativo' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? texto(b.nome, 80) : c.nome;
  if (!nome || nome.length < 2) throw new HttpError(400, 'nome da conta é obrigatório');
  const saldo = b.saldo_inicial !== undefined ? Number(String(b.saldo_inicial).replace(/\./g, '').replace(',', '.')) : Number(c.saldo_inicial);
  if (!Number.isFinite(saldo)) throw new HttpError(400, 'saldo inicial inválido');
  await pool.query(`UPDATE fin_contas SET nome = $2, tipo = $3, saldo_inicial = $4, saldo_inicial_em = $5, ativo = $6 WHERE id = $1`,
    [c.id, nome, b.tipo && ['banco', 'caixa', 'carteira'].includes(b.tipo) ? b.tipo : c.tipo, saldo,
      b.saldo_inicial_em !== undefined ? data(b.saldo_inicial_em, 'data do saldo inicial') : c.saldo_inicial_em, b.ativo !== undefined ? !!b.ativo : c.ativo]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_conta_editar', recurso: 'fin_contas', recursoId: c.id, detalhes: { nome, saldo_inicial: saldo } });
  res.json((await fin.saldosDasContas(pool, req.user.tenantId)).find((x) => x.id === c.id));
});

router.get('/financeiro/formas', async (req, res) => {
  const { rows } = await pool.query(`SELECT forma, prazo_dias, taxa_pct, conta_id FROM fin_formas_recebimento WHERE tenant_id = $1`, [req.user.tenantId]);
  const por = Object.fromEntries(rows.map((r) => [r.forma, r]));
  res.json(fin.FORMAS.map((f) => ({ forma: f.forma, nome: f.nome, prazo_dias: por[f.forma] ? por[f.forma].prazo_dias : f.prazo_dias, taxa_pct: Number(por[f.forma] ? por[f.forma].taxa_pct : f.taxa_pct), conta_id: por[f.forma] ? por[f.forma].conta_id : null })));
});
router.put('/financeiro/formas/:forma', async (req, res) => {
  const f = fin.FORMAS.find((x) => x.forma === req.params.forma);
  if (!f) throw new HttpError(404, 'forma de pagamento desconhecida');
  const b = req.body || {};
  const prazo = Number(b.prazo_dias);
  const taxa = Number(String(b.taxa_pct === undefined ? 0 : b.taxa_pct).replace(',', '.'));
  if (!Number.isInteger(prazo) || prazo < 0 || prazo > 365) throw new HttpError(400, 'prazo em dias entre 0 e 365');
  if (!Number.isFinite(taxa) || taxa < 0 || taxa >= 100) throw new HttpError(400, 'taxa entre 0 e 99,99%');
  const conta = b.conta_id ? (await getOwned(pool, 'fin_contas', b.conta_id, req.user.tenantId, { columns: 'id' })).id : null;
  await pool.query(
    `INSERT INTO fin_formas_recebimento (tenant_id, forma, prazo_dias, taxa_pct, conta_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, forma) DO UPDATE SET prazo_dias = EXCLUDED.prazo_dias, taxa_pct = EXCLUDED.taxa_pct, conta_id = EXCLUDED.conta_id`,
    [req.user.tenantId, f.forma, prazo, taxa, conta]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fin_forma_editar', recurso: 'fin_formas_recebimento', recursoId: null, detalhes: { forma: f.forma, prazo_dias: prazo, taxa_pct: taxa } });
  res.json({ forma: f.forma, nome: f.nome, prazo_dias: prazo, taxa_pct: taxa, conta_id: conta });
});

module.exports = router;
