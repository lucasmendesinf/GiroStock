// Financeiro: calculos sobre contas a pagar/receber (fin_titulos) e sobre as VENDAS, que nao viram titulos:
// cada venda "cai" na data da venda + prazo da forma de pagamento, descontada a taxa (fin_formas_recebimento).
// Datas sempre no fuso de Sao Paulo e devolvidas como texto AAAA-MM-DD.
const { FUSO } = require('../utils/query');

const HOJE = `(now() AT TIME ZONE '${FUSO}')::date`;
const SITUACAO = `CASE WHEN t.cancelado_em IS NOT NULL THEN 'cancelado' WHEN t.pago_em IS NOT NULL THEN 'pago'
                       WHEN t.vencimento < ${HOJE} THEN 'vencido' ELSE 'aberto' END`;

// Formas de recebimento das vendas. "online" (pago no app) e separado por plataforma pelo pedido de origem.
const FORMAS = [
  { forma: 'dinheiro', nome: 'Dinheiro', prazo_dias: 0, taxa_pct: 0 },
  { forma: 'pix', nome: 'Pix', prazo_dias: 0, taxa_pct: 0 },
  { forma: 'cartao_debito', nome: 'Cartão de débito', prazo_dias: 1, taxa_pct: 1.99 },
  { forma: 'cartao_credito', nome: 'Cartão de crédito', prazo_dias: 30, taxa_pct: 3.49 },
  { forma: 'ifood', nome: 'Pago online no iFood', prazo_dias: 30, taxa_pct: 0 },
  { forma: '99food', nome: 'Pago online na 99Food', prazo_dias: 30, taxa_pct: 0 },
];
const NOME_FORMA = Object.fromEntries(FORMAS.map((f) => [f.forma, f.nome]));

const CATEGORIAS_PADRAO = [
  ['despesa', 'Compra de mercadorias', false],
  ['despesa', 'Aluguel', true],
  ['despesa', 'Energia, água e gás', true],
  ['despesa', 'Internet e telefone', true],
  ['despesa', 'Salários e encargos', true],
  ['despesa', 'Impostos', true],
  ['despesa', 'Taxas e tarifas', true],
  ['despesa', 'Manutenção', true],
  ['despesa', 'Marketing', true],
  ['despesa', 'Outras despesas', true],
  ['receita', 'Vendas a prazo / fiado', true],
  ['receita', 'Eventos e serviços', true],
  ['receita', 'Outras receitas', true],
];

// Cria categorias e formas padrao na primeira vez que a empresa abre o financeiro (idempotente).
async function garantirPadroes(db, tenantId) {
  const tem = await db.query(`SELECT (SELECT count(*) FROM fin_categorias WHERE tenant_id = $1) AS c, (SELECT count(*) FROM fin_formas_recebimento WHERE tenant_id = $1) AS f`, [tenantId]);
  if (Number(tem.rows[0].c) === 0) {
    for (const [tipo, nome, entra] of CATEGORIAS_PADRAO) {
      await db.query(`INSERT INTO fin_categorias (tenant_id, tipo, nome, entra_no_resultado) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [tenantId, tipo, nome, entra]);
    }
  }
  if (Number(tem.rows[0].f) < FORMAS.length) {
    for (const f of FORMAS) {
      await db.query(`INSERT INTO fin_formas_recebimento (tenant_id, forma, prazo_dias, taxa_pct) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [tenantId, f.forma, f.prazo_dias, f.taxa_pct]);
    }
  }
}

async function hoje(db) {
  return (await db.query(`SELECT ${HOJE}::text AS d`)).rows[0].d;
}

// Vendas concluidas por data em que o dinheiro cai (dia da venda + prazo da forma), com bruto, taxa e liquido.
// opcoes: { de, ate } (data prevista), locationId, porDiaDaVenda (agrupa pelo dia da venda, para o resultado).
async function vendasRecebiveis(db, tenantId, { de, ate, locationId = null }) {
  const { rows } = await db.query(
    `WITH v AS (
       SELECT s.total, (s.criado_em AT TIME ZONE '${FUSO}')::date AS dia,
              CASE WHEN s.forma_pagamento = 'online'
                   THEN COALESCE((SELECT CASE WHEN o.origem = '99food' THEN '99food' ELSE 'ifood' END FROM orders o WHERE o.sale_id = s.id LIMIT 1), 'ifood')
                   ELSE s.forma_pagamento::text END AS forma
       FROM sales s
       WHERE s.tenant_id = $1 AND s.status = 'concluida' AND ($4::uuid IS NULL OR s.location_id = $4)
         AND s.criado_em >= (($2::date - 366)::timestamp AT TIME ZONE '${FUSO}')
         AND s.criado_em < (($3::date + 1)::timestamp AT TIME ZONE '${FUSO}')
     )
     SELECT (v.dia + COALESCE(f.prazo_dias, 0))::text AS data, v.forma, f.conta_id,
            SUM(v.total)::numeric(14,2) AS bruto,
            SUM(round(v.total * COALESCE(f.taxa_pct, 0) / 100, 2))::numeric(14,2) AS taxa,
            COUNT(*)::int AS vendas
     FROM v LEFT JOIN fin_formas_recebimento f ON f.tenant_id = $1 AND f.forma = v.forma
     WHERE v.dia + COALESCE(f.prazo_dias, 0) BETWEEN $2::date AND $3::date
     GROUP BY 1, 2, 3 ORDER BY 1, 2`,
    [tenantId, de, ate, locationId]
  );
  return rows.map((r) => ({ ...r, bruto: Number(r.bruto), taxa: Number(r.taxa), liquido: Number((Number(r.bruto) - Number(r.taxa)).toFixed(2)), nome: NOME_FORMA[r.forma] || r.forma }));
}

// Saldo de cada conta: saldo inicial + o que entrou e saiu nela desde a data do saldo inicial ate hoje
// (contas recebidas/pagas nela e vendas das formas ligadas a ela que ja cairam).
async function saldosDasContas(db, tenantId) {
  const d = await hoje(db);
  const contas = (await db.query(`SELECT id, nome, tipo, saldo_inicial, saldo_inicial_em::text, ativo FROM fin_contas WHERE tenant_id = $1 ORDER BY ativo DESC, nome`, [tenantId])).rows;
  const r = [];
  for (const c of contas) {
    const t = (await db.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'receber' THEN valor_pago ELSE -valor_pago END), 0) AS mov
       FROM fin_titulos WHERE tenant_id = $1 AND conta_id = $2 AND pago_em IS NOT NULL AND cancelado_em IS NULL AND pago_em BETWEEN $3::date AND $4::date`,
      [tenantId, c.id, c.saldo_inicial_em, d]
    )).rows[0];
    const vendas = c.saldo_inicial_em <= d ? (await vendasRecebiveis(db, tenantId, { de: c.saldo_inicial_em, ate: d })).filter((v) => v.conta_id === c.id) : [];
    const vendasLiq = vendas.reduce((s, v) => s + v.liquido, 0);
    r.push({ ...c, saldo_inicial: Number(c.saldo_inicial), saldo: Number((Number(c.saldo_inicial) + Number(t.mov) + vendasLiq).toFixed(2)) });
  }
  return r;
}

// Fluxo de caixa por dia: o que ja aconteceu (realizado) ate hoje e o previsto daqui para frente.
// Contas em atraso (vencidas e nao pagas) entram no previsto de hoje. O saldo parte do saldo atual das contas:
// saldo no fim de hoje = saldo atual + previsto de hoje; dias seguintes somam o previsto; dias anteriores desfazem o realizado.
async function fluxo(db, tenantId, { de, ate }) {
  const d = await hoje(db);
  const ini = de < d ? de : d;
  const fim = ate > d ? ate : d;
  const vendas = await vendasRecebiveis(db, tenantId, { de: ini, ate: fim });
  const pagos = (await db.query(
    `SELECT pago_em::text AS data, tipo, SUM(valor_pago)::numeric(14,2) AS v FROM fin_titulos
     WHERE tenant_id = $1 AND pago_em IS NOT NULL AND cancelado_em IS NULL AND pago_em BETWEEN $2::date AND $3::date GROUP BY 1, 2`,
    [tenantId, ini, fim]
  )).rows;
  const abertos = (await db.query(
    `SELECT GREATEST(vencimento, ${HOJE})::text AS data, tipo, SUM(valor)::numeric(14,2) AS v, bool_or(vencimento < ${HOJE}) AS atrasado FROM fin_titulos
     WHERE tenant_id = $1 AND pago_em IS NULL AND cancelado_em IS NULL AND GREATEST(vencimento, ${HOJE}) <= $2::date GROUP BY 1, 2`,
    [tenantId, fim]
  )).rows;
  const dias = new Map();
  for (let t = new Date(`${ini}T12:00:00Z`); t <= new Date(`${fim}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1)) {
    const data = t.toISOString().slice(0, 10);
    dias.set(data, { data, vendas: 0, taxas: 0, recebido: 0, pago: 0, a_receber: 0, a_pagar: 0, atrasados: false });
  }
  for (const v of vendas) { const x = dias.get(v.data); if (x) { x.vendas += v.liquido; x.taxas += v.taxa; } }
  for (const p of pagos) { const x = dias.get(p.data); if (x) { if (p.tipo === 'receber') x.recebido += Number(p.v); else x.pago += Number(p.v); } }
  for (const a of abertos) { const x = dias.get(a.data); if (x) { if (a.tipo === 'receber') x.a_receber += Number(a.v); else x.a_pagar += Number(a.v); if (a.atrasado) x.atrasados = true; } }
  const lista = [...dias.values()];
  for (const x of lista) {
    for (const k of ['vendas', 'taxas', 'recebido', 'pago', 'a_receber', 'a_pagar']) x[k] = Number(x[k].toFixed(2));
    x.realizado = x.data <= d;
    // venda de hoje ja conta como realizada; venda que cai depois de hoje e prevista
    x.mov_realizado = x.realizado ? Number((x.vendas + x.recebido - x.pago).toFixed(2)) : 0;
    x.mov_previsto = Number(((x.realizado ? 0 : x.vendas) + x.a_receber - x.a_pagar).toFixed(2));
    x.entradas = Number((x.vendas + x.recebido + x.a_receber).toFixed(2));
    x.saidas = Number((x.pago + x.a_pagar).toFixed(2));
  }
  const contas = await saldosDasContas(db, tenantId);
  const saldoHoje = Number(contas.filter((c) => c.ativo).reduce((s, c) => s + c.saldo, 0).toFixed(2));
  const iH = lista.findIndex((x) => x.data === d);
  lista[iH].saldo = Number((saldoHoje + lista[iH].mov_previsto).toFixed(2));
  let antes = saldoHoje; // saldo no fim do dia anterior = saldo atual - realizado do dia seguinte...
  for (let i = iH - 1; i >= 0; i--) { antes = Number((antes - lista[i + 1].mov_realizado).toFixed(2)); lista[i].saldo = antes; }
  for (let i = iH + 1; i < lista.length; i++) lista[i].saldo = Number((lista[i - 1].saldo + lista[i].mov_previsto).toFixed(2));
  const periodo = lista.filter((x) => x.data >= de && x.data <= ate);
  const tot = (k) => Number(periodo.reduce((s, x) => s + x[k], 0).toFixed(2));
  return {
    hoje: d, saldo_hoje: saldoHoje, contas,
    totais: { vendas: tot('vendas'), taxas: tot('taxas'), recebido: tot('recebido'), pago: tot('pago'), a_receber: tot('a_receber'), a_pagar: tot('a_pagar') },
    saldo_final: periodo.length ? periodo[periodo.length - 1].saldo : saldoHoje,
    menor_saldo: periodo.length ? periodo.reduce((m, x) => (x.saldo < m.saldo ? x : m), periodo[0]) : null,
    dias: periodo,
  };
}

// Resultado (regime de competencia) de um mes AAAA-MM: vendas - taxas - custo das mercadorias = lucro bruto;
// - despesas (por categoria) + outras receitas = resultado.
async function resultado(db, tenantId, mes, { locationId = null } = {}) {
  const ini = `${mes}-01`;
  const p = [tenantId, ini, locationId];
  const v = (await db.query(
    `SELECT COALESCE(SUM(s.subtotal + COALESCE(s.taxa_entrega, 0)), 0) AS bruto, COALESCE(SUM(s.desconto), 0) AS descontos, COALESCE(SUM(s.total), 0) AS receita, COUNT(*)::int AS vendas
     FROM sales s WHERE s.tenant_id = $1 AND s.status = 'concluida' AND ($3::uuid IS NULL OR s.location_id = $3)
       AND s.criado_em >= ($2::date::timestamp AT TIME ZONE '${FUSO}') AND s.criado_em < (($2::date + interval '1 month')::timestamp AT TIME ZONE '${FUSO}')`, p
  )).rows[0];
  const cmv = (await db.query(
    `SELECT COALESCE(SUM(si.quantidade * COALESCE(si.custo_unitario, 0)), 0) AS v FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.tenant_id = $1 AND s.status = 'concluida' AND ($3::uuid IS NULL OR s.location_id = $3)
       AND s.criado_em >= ($2::date::timestamp AT TIME ZONE '${FUSO}') AND s.criado_em < (($2::date + interval '1 month')::timestamp AT TIME ZONE '${FUSO}')`, p
  )).rows[0];
  // taxas das vendas do mes (pela data da venda)
  const taxas = (await db.query(
    `SELECT COALESCE(SUM(round(s.total * COALESCE(f.taxa_pct, 0) / 100, 2)), 0) AS v
     FROM sales s LEFT JOIN fin_formas_recebimento f ON f.tenant_id = s.tenant_id AND f.forma =
       CASE WHEN s.forma_pagamento = 'online' THEN COALESCE((SELECT CASE WHEN o.origem = '99food' THEN '99food' ELSE 'ifood' END FROM orders o WHERE o.sale_id = s.id LIMIT 1), 'ifood') ELSE s.forma_pagamento::text END
     WHERE s.tenant_id = $1 AND s.status = 'concluida' AND ($3::uuid IS NULL OR s.location_id = $3)
       AND s.criado_em >= ($2::date::timestamp AT TIME ZONE '${FUSO}') AND s.criado_em < (($2::date + interval '1 month')::timestamp AT TIME ZONE '${FUSO}')`, p
  )).rows[0];
  const cat = (await db.query(
    `SELECT t.tipo, COALESCE(c.nome, 'Sem categoria') AS categoria, COALESCE(c.entra_no_resultado, true) AS entra,
            SUM(COALESCE(t.valor_pago, t.valor))::numeric(14,2) AS v, COUNT(*)::int AS n
     FROM fin_titulos t LEFT JOIN fin_categorias c ON c.id = t.categoria_id
     WHERE t.tenant_id = $1 AND t.cancelado_em IS NULL AND ($3::uuid IS NULL OR t.location_id = $3)
       AND t.competencia >= $2::date AND t.competencia < ($2::date + interval '1 month')
     GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`, p
  )).rows.map((r) => ({ ...r, v: Number(r.v) }));
  const n = (x) => Number(Number(x).toFixed(2));
  const receita = n(v.receita);
  const lucroBruto = n(receita - Number(taxas.v) - Number(cmv.v));
  const despesas = cat.filter((c) => c.tipo === 'pagar' && c.entra);
  const outras = cat.filter((c) => c.tipo === 'receber' && c.entra);
  const totDesp = n(despesas.reduce((s, c) => s + c.v, 0));
  const totOutras = n(outras.reduce((s, c) => s + c.v, 0));
  const res = n(lucroBruto - totDesp + totOutras);
  return {
    mes, vendas: v.vendas, receita_bruta: n(v.bruto), descontos: n(v.descontos), receita, taxas: n(taxas.v), cmv: n(cmv.v), lucro_bruto: lucroBruto,
    margem_bruta: receita > 0 ? n((lucroBruto / receita) * 100) : 0,
    despesas: despesas.map((c) => ({ categoria: c.categoria, valor: c.v, lancamentos: c.n })), total_despesas: totDesp,
    outras_receitas: outras.map((c) => ({ categoria: c.categoria, valor: c.v, lancamentos: c.n })), total_outras_receitas: totOutras,
    fora_do_resultado: cat.filter((c) => !c.entra).map((c) => ({ tipo: c.tipo, categoria: c.categoria, valor: c.v })),
    resultado: res, margem_liquida: receita > 0 ? n((res / receita) * 100) : 0,
  };
}

module.exports = { HOJE, SITUACAO, FORMAS, NOME_FORMA, garantirPadroes, hoje, vendasRecebiveis, saldosDasContas, fluxo, resultado };
