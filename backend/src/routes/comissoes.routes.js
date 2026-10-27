// Comissoes do garcom (Fase 3): regras, resumo por garcom, extrato por comanda, ajustes, acertos (com lancamento no Financeiro) e
// simulacao. Area "Comissoes" + modulo "garcom". O garcom ve o PROPRIO extrato em /garcom/extrato (area Garcom), nunca estas rotas.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { filtroLocais } = require('../utils/access');
const { HttpError } = require('../utils/http');
const comissoes = require('../services/comissoes');
const fin = require('../services/financeiro');

const router = express.Router();
router.use('/comissoes', requireArea('Comissoes'), requireModulo('garcom'));

const { centavos, reais } = comissoes;
const FORMAS_BAIXA = ['dinheiro', 'pix', 'boleto', 'transferencia', 'cartao_debito', 'cartao_credito', 'cheque', 'outro'];
const REC_FECH = `origem IN ('recebimento', 'fechamento')`;
const n2 = (v) => Number(Number(v || 0).toFixed(2));

function pct(v, nome, { nulo = false } = {}) {
  if ((v === null || v === undefined || v === '') && nulo) return null;
  const n = Number(v);
  if (!(n >= 0 && n <= 100)) throw new HttpError(400, `${nome}: informe um percentual de 0 a 100`);
  return Number(n.toFixed(2));
}

// ---------------------------------------------------------------- regras
async function respostaDeRegras(tenantId) {
  const regra = await comissoes.carregarRegra(pool, tenantId);
  const categorias = (await pool.query(
    `SELECT c.id, c.nome, c.parent_id, pc.nome AS parent_nome FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id WHERE c.tenant_id = $1 ORDER BY COALESCE(pc.nome, c.nome), c.parent_id NULLS FIRST, c.nome`, [tenantId]
  )).rows;
  const garcons = (await pool.query(`SELECT id, nome, perfil, comissao_pct, ativo FROM users WHERE tenant_id = $1 AND perfil <> 'Master' ORDER BY ativo DESC, nome`, [tenantId])).rows;
  return { ...regra, categorias, garcons };
}

router.get('/comissoes/regras', async (req, res) => {
  res.json(await respostaDeRegras(req.user.tenantId));
});

router.put('/comissoes/regras', async (req, res) => {
  const b = req.body || {};
  const atual = await comissoes.carregarRegra(pool, req.user.tenantId);
  const padrao = pct(b.pct_padrao === undefined ? atual.pct_padrao : b.pct_padrao, 'percentual padrão');
  const repasse = pct(b.taxa_servico_repasse_pct === undefined ? atual.taxa_servico_repasse_pct : b.taxa_servico_repasse_pct, 'taxa de serviço repassada');
  const base = b.base === undefined ? atual.base : b.base;
  if (!['liquida', 'bruta'].includes(base)) throw new HttpError(400, 'base: liquida (depois do desconto) ou bruta');
  const periodo = b.meta_periodo === undefined ? atual.meta_periodo : b.meta_periodo;
  if (!['noite', 'semana', 'mes'].includes(periodo)) throw new HttpError(400, 'período da meta: noite, semana ou mes');
  const metaValor = b.meta_valor === undefined ? atual.meta_valor : (b.meta_valor === null || b.meta_valor === '' ? null : Number(b.meta_valor));
  if (metaValor !== null && !(metaValor >= 0)) throw new HttpError(400, 'meta: informe um valor de 0 em diante');
  const metaBonus = b.meta_bonus_pct === undefined ? atual.meta_bonus_pct : pct(b.meta_bonus_pct, 'bônus da meta', { nulo: true });
  if ((metaValor > 0) !== (metaBonus > 0)) throw new HttpError(400, 'bônus por meta: informe a meta (valor) e o percentual do bônus, ou deixe os dois vazios');
  const estornoDesconta = b.estorno_desconta === undefined ? atual.estorno_desconta : !!b.estorno_desconta;
  const corte = b.corte_hora === undefined ? atual.corte_hora : Number(b.corte_hora);
  if (!Number.isInteger(corte) || corte < 0 || corte > 23) throw new HttpError(400, 'corte da noite: hora de 0 a 23');
  let porCategoria = atual.por_categoria || {};
  if (b.por_categoria !== undefined) {
    if (!b.por_categoria || typeof b.por_categoria !== 'object' || Array.isArray(b.por_categoria)) throw new HttpError(400, 'por_categoria deve ser { categoria_id: percentual }');
    const ids = Object.keys(b.por_categoria);
    if (ids.some((i) => !isUuid(i))) throw new HttpError(400, 'categoria inválida');
    if (ids.length) {
      const ok = await pool.query(`SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tenantId, ids]);
      if (ok.rows.length !== ids.length) throw new HttpError(400, 'categoria inválida');
    }
    porCategoria = Object.fromEntries(ids.map((i) => [i, pct(b.por_categoria[i], 'percentual da categoria')]));
  }
  await pool.query(
    `INSERT INTO comissao_regras (tenant_id, pct_padrao, por_categoria, taxa_servico_repasse_pct, base, meta_valor, meta_bonus_pct, meta_periodo, estorno_desconta, corte_hora, atualizado_por, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (tenant_id) WHERE location_id IS NULL DO UPDATE SET pct_padrao = EXCLUDED.pct_padrao, por_categoria = EXCLUDED.por_categoria, taxa_servico_repasse_pct = EXCLUDED.taxa_servico_repasse_pct,
       base = EXCLUDED.base, meta_valor = EXCLUDED.meta_valor, meta_bonus_pct = EXCLUDED.meta_bonus_pct, meta_periodo = EXCLUDED.meta_periodo, estorno_desconta = EXCLUDED.estorno_desconta,
       corte_hora = EXCLUDED.corte_hora, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
    [req.user.tenantId, padrao, JSON.stringify(porCategoria), repasse, base, metaValor, metaBonus, periodo, estornoDesconta, corte, req.user.id]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'comissao_regras', recurso: 'comissao_regras', detalhes: {
    antes: { pct_padrao: atual.pct_padrao, repasse: atual.taxa_servico_repasse_pct, base: atual.base, meta_valor: atual.meta_valor, meta_bonus_pct: atual.meta_bonus_pct, meta_periodo: atual.meta_periodo, estorno_desconta: atual.estorno_desconta, categorias: Object.keys(atual.por_categoria || {}).length },
    depois: { pct_padrao: padrao, repasse, base, meta_valor: metaValor, meta_bonus_pct: metaBonus, meta_periodo: periodo, estorno_desconta: estornoDesconta, categorias: Object.keys(porCategoria).length, corte_hora: corte },
  } });
  res.json(await respostaDeRegras(req.user.tenantId));
});

// ---------------------------------------------------------------- resumo e extrato
// Filtros comuns: janela (dia comercial) e lojas.
async function filtrosDeLancamentos(req, regra, { alias = 'c' } = {}) {
  const j = await comissoes.janela(pool, regra, { periodo: req.query.periodo || 'noite', de: req.query.de, ate: req.query.ate });
  const bd = comissoes.dataComercial(`${alias}.criado_em`, regra.corte_hora);
  const params = [req.user.tenantId, j.de, j.ate];
  let where = `${alias}.tenant_id = $1 AND ${bd} BETWEEN $2::date AND $3::date`;
  const lojas = filtroLocais(req.user, req.query.location_id);
  if (lojas) { params.push(lojas); where += ` AND ${alias}.location_id = ANY($${params.length}::uuid[])`; }
  if (req.query.garcom_id) {
    if (!isUuid(req.query.garcom_id)) throw new HttpError(400, 'garçom inválido');
    params.push(req.query.garcom_id);
    where += ` AND ${alias}.garcom_id = $${params.length}`;
  }
  return { janela: j, where, params, bd };
}

router.get('/comissoes/resumo', async (req, res) => {
  const regra = await comissoes.carregarRegra(pool, req.user.tenantId);
  const f = await filtrosDeLancamentos(req, regra);
  const { rows } = await pool.query(
    `SELECT c.garcom_id, u.nome AS garcom_nome, u.ativo,
            COUNT(DISTINCT c.comanda_id) FILTER (WHERE c.${REC_FECH} AND c.estornado_em IS NULL)::int AS comandas,
            COALESCE(SUM(c.base_valor) FILTER (WHERE c.${REC_FECH} AND c.estornado_em IS NULL), 0) AS vendas_base,
            COALESCE(SUM(c.valor_produtos) FILTER (WHERE c.${REC_FECH} AND c.estornado_em IS NULL), 0) AS comissao_produtos,
            COALESCE(SUM(c.valor_servico) FILTER (WHERE c.${REC_FECH} AND c.estornado_em IS NULL), 0) AS taxa_servico,
            COALESCE(SUM(c.valor_produtos) FILTER (WHERE c.origem = 'bonus'), 0) AS bonus,
            COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.origem = 'ajuste'), 0) AS ajustes,
            COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.status = 'pendente'), 0) AS a_pagar,
            COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.status = 'paga'), 0) AS pago,
            COALESCE(SUM(c.valor_produtos + c.valor_servico) FILTER (WHERE c.estornado_em IS NOT NULL AND c.${REC_FECH}), 0) AS estornos
     FROM comissoes c JOIN users u ON u.id = c.garcom_id WHERE ${f.where}
     GROUP BY c.garcom_id, u.nome, u.ativo ORDER BY u.nome`,
    f.params
  );
  // pendentes de periodos anteriores (ajustes, bonus e comissoes ainda nao acertadas) tambem compoem o "a pagar" total do garcom
  const previsto = await comissoes.bonusDevido(pool, req.user.tenantId, regra, { de: f.janela.de, ate: f.janela.ate });
  const prevPor = new Map();
  for (const b of previsto) prevPor.set(b.garcom_id, n2((prevPor.get(b.garcom_id) || 0) + b.valor));
  const garcons = rows.map((r) => {
    const total = n2(Number(r.comissao_produtos) + Number(r.taxa_servico) + Number(r.bonus) + Number(r.ajustes));
    return {
      garcom_id: r.garcom_id, garcom_nome: r.garcom_nome, comandas: r.comandas, vendas_base: n2(r.vendas_base), comissao_produtos: n2(r.comissao_produtos), taxa_servico: n2(r.taxa_servico),
      bonus: n2(r.bonus), bonus_previsto: prevPor.get(r.garcom_id) || 0, ajustes: n2(r.ajustes), total, a_pagar: n2(r.a_pagar), pago: n2(r.pago), estornos: n2(r.estornos),
      situacao: n2(r.a_pagar) > 0 ? 'a_pagar' : n2(r.pago) > 0 ? 'pago' : 'sem_comissao',
    };
  });
  const soma = (k) => n2(garcons.reduce((s, g) => s + g[k], 0));
  res.json({
    janela: f.janela, corte_hora: regra.corte_hora, garcons,
    totais: { a_pagar: soma('a_pagar'), comissao_periodo: n2(garcons.reduce((s, g) => s + g.total, 0)), vendas_base: soma('vendas_base'), estornos: soma('estornos'), pago: soma('pago'), bonus_previsto: soma('bonus_previsto') },
  });
});

// Extrato de um garcom por comanda: lancamentos, regra aplicada e situacao (+ diferencas de prestacao, so informativas).
async function extratoDoGarcom(db, tenantId, garcomId, { where, params }) {
  const { rows } = await db.query(
    `SELECT c.id, c.comanda_id, c.sale_id, c.order_item_id, c.origem, c.base_valor, c.pct_aplicado, c.valor_produtos, c.valor_servico, c.status, c.estornado_em, c.periodo_ref, c.motivo, c.criado_em,
            c.regra_snapshot, cm.numero AS comanda_numero, cm.identificador, cm.tipo, p.nome AS produto, oi.quantidade
     FROM comissoes c LEFT JOIN comandas cm ON cm.id = c.comanda_id LEFT JOIN order_items oi ON oi.id = c.order_item_id LEFT JOIN products p ON p.id = oi.product_id
     WHERE ${where} ORDER BY c.criado_em DESC, c.id LIMIT 1000`,
    params
  );
  const porComanda = new Map();
  const avulsos = [];
  for (const r of rows) {
    const item = {
      id: r.id, origem: r.origem, produto: r.produto, quantidade: r.quantidade === null ? null : Number(r.quantidade), base: n2(r.base_valor), pct: r.pct_aplicado === null ? null : Number(r.pct_aplicado),
      comissao_produtos: n2(r.valor_produtos), taxa_servico: n2(r.valor_servico), total: n2(Number(r.valor_produtos) + Number(r.valor_servico)), status: r.estornado_em && r.status === 'estornada' ? 'estornada' : r.status,
      estornado: !!r.estornado_em, regra: r.regra_snapshot, motivo: r.motivo, periodo_ref: r.periodo_ref, criado_em: r.criado_em,
    };
    if (!r.comanda_id) { avulsos.push(item); continue; }
    if (!porComanda.has(r.comanda_id)) porComanda.set(r.comanda_id, { comanda_id: r.comanda_id, numero: r.comanda_numero, identificador: r.identificador, tipo: r.tipo, hora: r.criado_em, total: 0, itens: [] });
    const c = porComanda.get(r.comanda_id);
    c.itens.push(item);
    if (!item.estornado || item.origem === 'ajuste') c.total = n2(c.total + item.total);
  }
  const prestacoes = (await db.query(
    `SELECT p.id, c.numero AS comanda_numero, c.identificador, p.valor_produtos + p.taxa_servico AS valor, p.diferenca_prestacao, p.prestado_em
     FROM comanda_pagamentos p JOIN comandas c ON c.id = p.comanda_id
     WHERE p.tenant_id = $1 AND p.recebido_por = $2 AND p.forma = 'dinheiro' AND p.status = 'confirmado' AND p.diferenca_prestacao IS NOT NULL AND p.diferenca_prestacao <> 0
     ORDER BY p.prestado_em DESC LIMIT 50`, [tenantId, garcomId]
  )).rows.map((p) => ({ ...p, valor: n2(p.valor), diferenca_prestacao: n2(p.diferenca_prestacao) }));
  return { comandas: [...porComanda.values()], avulsos, prestacoes_diferenca: prestacoes };
}

router.get('/comissoes/garcons/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'garçom não encontrado');
  const g = (await pool.query(`SELECT id, nome, comissao_pct FROM users WHERE id = $1 AND tenant_id = $2 AND perfil <> 'Master'`, [req.params.id, req.user.tenantId])).rows[0];
  if (!g) throw new HttpError(404, 'garçom não encontrado');
  const regra = await comissoes.carregarRegra(pool, req.user.tenantId);
  req.query.garcom_id = g.id;
  const f = await filtrosDeLancamentos(req, regra);
  const ext = await extratoDoGarcom(pool, req.user.tenantId, g.id, f);
  res.json({ garcom: g, janela: f.janela, ...ext });
});

// ---------------------------------------------------------------- ajustes manuais
router.post('/comissoes/ajustes', async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.garcom_id)) throw new HttpError(400, 'escolha o garçom');
  const valor = Number(b.valor);
  if (!Number.isFinite(valor) || valor === 0 || Math.abs(valor) > 1000000) throw new HttpError(400, 'informe o valor do ajuste (positivo ou negativo, diferente de zero)');
  const motivo = String(b.motivo || '').trim();
  if (motivo.length < 3) throw new HttpError(400, 'informe o motivo do ajuste (mínimo 3 caracteres)');
  const g = (await pool.query(`SELECT id, nome, location_id FROM users WHERE id = $1 AND tenant_id = $2 AND perfil <> 'Master'`, [b.garcom_id, req.user.tenantId])).rows[0];
  if (!g) throw new HttpError(404, 'garçom não encontrado');
  const loja = g.location_id || (await pool.query(`SELECT id FROM locations WHERE tenant_id = $1 ORDER BY ativo DESC, nome LIMIT 1`, [req.user.tenantId])).rows[0].id;
  const cents = centavos(valor);
  const { rows } = await pool.query(
    `INSERT INTO comissoes (tenant_id, location_id, garcom_id, origem, valor_produtos, valor_servico, motivo, regra_snapshot, criado_por)
     VALUES ($1, $2, $3, 'ajuste', $4, 0, $5, $6, $7) RETURNING id, valor_produtos, status, criado_em`,
    [req.user.tenantId, loja, g.id, reais(cents), motivo.slice(0, 200), JSON.stringify({ manual: true }), req.user.id]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'comissao_ajuste', recurso: 'comissoes', recursoId: rows[0].id, detalhes: { garcom_id: g.id, valor: reais(cents), motivo: motivo.slice(0, 200) } });
  res.status(201).json(rows[0]);
});

// ---------------------------------------------------------------- acertos
function validarGarcons(b) {
  if (!Array.isArray(b.garcom_ids) || b.garcom_ids.length === 0 || b.garcom_ids.some((i) => !isUuid(i))) throw new HttpError(400, 'escolha ao menos um garçom');
  return [...new Set(b.garcom_ids)];
}

router.post('/comissoes/acertos', async (req, res) => {
  const b = req.body || {};
  const garcomIds = validarGarcons(b);
  const forma = b.forma_pagamento ? String(b.forma_pagamento) : null;
  if (forma && !FORMAS_BAIXA.includes(forma)) throw new HttpError(400, 'forma de pagamento inválida');
  const lancar = !!b.lancar_financeiro;
  if (lancar && !(req.user.modulos && req.user.modulos.financeiro)) throw new HttpError(403, 'o módulo Financeiro não faz parte do plano da sua empresa: faça o acerto sem lançar no Financeiro');
  const regra = await comissoes.carregarRegra(pool, req.user.tenantId);
  const j = await comissoes.janela(pool, regra, { periodo: b.periodo || 'noite', de: b.de, ate: b.ate });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = await client.query(`SELECT id FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tenantId, garcomIds]);
    if (ok.rows.length !== garcomIds.length) throw new HttpError(400, 'garçom inválido');
    const r = await comissoes.fecharAcerto(client, req.user, { garcomIds, de: j.de, ate: j.ate, formaPagamento: forma, observacao: String(b.observacao || '').trim().slice(0, 300) });
    let titulo = null;
    if (lancar) {
      let contaId = null;
      if (b.conta_id) {
        const conta = await getOwned(client, 'fin_contas', b.conta_id, req.user.tenantId, { columns: 'id, ativo' });
        if (!conta.ativo) throw new HttpError(400, 'esta conta financeira está desativada');
        contaId = conta.id;
      }
      await fin.garantirPadroes(client, req.user.tenantId);
      let cat = (await client.query(`SELECT id FROM fin_categorias WHERE tenant_id = $1 AND tipo = 'despesa' AND lower(nome) = lower('Comissões')`, [req.user.tenantId])).rows[0];
      if (!cat) cat = (await client.query(`INSERT INTO fin_categorias (tenant_id, tipo, nome, entra_no_resultado) VALUES ($1, 'despesa', 'Comissões', true) RETURNING id`, [req.user.tenantId])).rows[0];
      const hoje = r.acerto.pago_em instanceof Date ? r.acerto.pago_em.toISOString().slice(0, 10) : String(r.acerto.pago_em).slice(0, 10);
      titulo = (await client.query(
        `INSERT INTO fin_titulos (tenant_id, tipo, descricao, categoria_id, valor, vencimento, competencia, documento, observacao, origem, pago_em, valor_pago, conta_id, forma_pagamento, criado_por)
         VALUES ($1, 'pagar', $2, $3, $4, $5, $6, $7, $8, 'manual', $5, $4, $9, $10, $11) RETURNING id`,
        [req.user.tenantId, `Comissões de garçons — acerto nº ${r.acerto.numero} (${j.de} a ${j.ate})`, cat.id, r.acerto.total, hoje, j.ate, `ACERTO-${r.acerto.numero}`, String(b.observacao || '').trim().slice(0, 300) || null, contaId, forma, req.user.id]
      )).rows[0];
      await client.query(`UPDATE comissao_acertos SET titulo_id = $1 WHERE id = $2`, [titulo.id, r.acerto.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ acerto: { ...r.acerto, total: n2(r.acerto.total), titulo_id: titulo ? titulo.id : null }, garcons: r.garcons });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/comissoes/acertos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.numero, a.periodo_inicio::text AS periodo_inicio, a.periodo_fim::text AS periodo_fim, a.total, a.forma_pagamento, a.pago_em::text AS pago_em, a.titulo_id, a.observacao, u.nome AS pago_por_nome,
            COALESCE((SELECT json_agg(json_build_object('garcom_id', i.garcom_id, 'garcom_nome', g.nome, 'valor', i.valor) ORDER BY g.nome) FROM comissao_acerto_itens i JOIN users g ON g.id = i.garcom_id WHERE i.acerto_id = a.id), '[]') AS garcons
     FROM comissao_acertos a LEFT JOIN users u ON u.id = a.pago_por WHERE a.tenant_id = $1 ORDER BY a.numero DESC LIMIT 100`,
    [req.user.tenantId]
  );
  res.json(rows.map((a) => ({ ...a, total: n2(a.total) })));
});

// Recibo: por garcom, com as comandas e os valores do acerto.
router.get('/comissoes/acertos/:id', async (req, res) => {
  const a = (await getOwned(pool, 'comissao_acertos', req.params.id, req.user.tenantId, { columns: 'id, numero, periodo_inicio::text AS periodo_inicio, periodo_fim::text AS periodo_fim, total, forma_pagamento, pago_em::text AS pago_em, titulo_id, observacao, pago_por' }));
  const emp = (await pool.query(`SELECT nome FROM tenants WHERE id = $1`, [req.user.tenantId])).rows[0];
  const itens = (await pool.query(`SELECT i.garcom_id, g.nome AS garcom_nome, i.valor, i.lancamentos FROM comissao_acerto_itens i JOIN users g ON g.id = i.garcom_id WHERE i.acerto_id = $1 ORDER BY g.nome`, [a.id])).rows;
  const lanc = (await pool.query(
    `SELECT c.garcom_id, c.comanda_id, cm.numero AS comanda_numero, cm.identificador, c.origem, c.motivo, SUM(c.valor_produtos + c.valor_servico) AS valor, SUM(c.base_valor) AS base
     FROM comissoes c LEFT JOIN comandas cm ON cm.id = c.comanda_id WHERE c.acerto_id = $1 GROUP BY c.garcom_id, c.comanda_id, cm.numero, cm.identificador, c.origem, c.motivo ORDER BY cm.numero NULLS LAST`, [a.id]
  )).rows;
  res.json({
    ...a, total: n2(a.total), empresa_nome: emp.nome,
    garcons: itens.map((i) => ({
      garcom_id: i.garcom_id, garcom_nome: i.garcom_nome, valor: n2(i.valor), lancamentos: i.lancamentos,
      linhas: lanc.filter((l) => l.garcom_id === i.garcom_id).map((l) => ({ comanda_numero: l.comanda_numero, identificador: l.identificador, origem: l.origem, motivo: l.motivo, base: n2(l.base), valor: n2(l.valor) })),
    })),
  });
});

// ---------------------------------------------------------------- simulacao
// Mostra, sem gravar nada, quanto cada item de uma comanda real recente renderia com as regras (as gravadas ou as informadas no corpo).
router.post('/comissoes/simulacao', async (req, res) => {
  const b = req.body || {};
  const atual = await comissoes.carregarRegra(pool, req.user.tenantId);
  const regra = { ...atual, ...(b.regras && typeof b.regras === 'object' ? {
    pct_padrao: pct(b.regras.pct_padrao === undefined ? atual.pct_padrao : b.regras.pct_padrao, 'percentual padrão'),
    por_categoria: b.regras.por_categoria && typeof b.regras.por_categoria === 'object' ? b.regras.por_categoria : atual.por_categoria,
    taxa_servico_repasse_pct: pct(b.regras.taxa_servico_repasse_pct === undefined ? atual.taxa_servico_repasse_pct : b.regras.taxa_servico_repasse_pct, 'taxa repassada'),
    base: ['liquida', 'bruta'].includes(b.regras.base) ? b.regras.base : atual.base,
  } : {}) };
  let comanda;
  if (b.comanda_id) {
    if (!isUuid(b.comanda_id)) throw new HttpError(400, 'comanda inválida');
    comanda = (await pool.query(`SELECT id, numero, identificador, sale_id, status FROM comandas WHERE id = $1 AND tenant_id = $2`, [b.comanda_id, req.user.tenantId])).rows[0];
  } else {
    comanda = (await pool.query(`SELECT id, numero, identificador, sale_id, status FROM comandas WHERE tenant_id = $1 AND status = 'paga' AND sale_id IS NOT NULL ORDER BY fechada_em DESC LIMIT 1`, [req.user.tenantId])).rows[0];
  }
  if (!comanda) return res.json({ comanda: null, itens: [], total: 0 });
  const venda = comanda.sale_id ? (await pool.query(`SELECT desconto, taxa_servico FROM sales WHERE id = $1`, [comanda.sale_id])).rows[0] : { desconto: 0, taxa_servico: 0 };
  const orders = (await pool.query(`SELECT id FROM orders WHERE comanda_id = $1 AND status <> 'cancelado'`, [comanda.id])).rows.map((o) => o.id);
  const itens = await comissoes.itensDasRodadas(pool, orders);
  const pctGarcom = await comissoes.pctsDosGarcons(pool, itens.map((i) => i.garcom_id));
  const calc = comissoes.calcularItens(regra, itens, { descontoCents: centavos(venda.desconto), taxaCents: centavos(venda.taxa_servico), pctGarcom });
  const linhas = calc.map((c) => ({ produto: c.item.produto, subtotal: n2(c.item.subtotal), elegivel: c.elegivel, base: reais(c.base), pct: c.pct, pct_origem: c.origemPct || null, comissao_produtos: reais(c.produtos), taxa_servico: reais(c.servico), total: reais(c.produtos + c.servico) }));
  res.json({ comanda: { id: comanda.id, numero: comanda.numero, identificador: comanda.identificador }, desconto: n2(venda.desconto), taxa_servico: n2(venda.taxa_servico), itens: linhas, total: n2(linhas.reduce((s, l) => s + l.total, 0)) });
});

module.exports = router;
