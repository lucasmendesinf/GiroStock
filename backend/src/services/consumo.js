// O que cada item vendido consome do estoque. Um lugar so para: venda (baixa), pedido (reserva), reserva
// dos pedidos em aberto, disponibilidade do PDV e disponibilidade no iFood.
//
// - Produto simples (revenda): baixa o proprio estoque.
// - Produto com ficha tecnica (lanche): baixa os insumos da receita.
// - Combo: baixa cada componente (que por sua vez e simples ou tem ficha). Combo dentro de combo nao existe.
// - Complemento escolhido (adicional): baixa o insumo ou o produto ligado a ele, por unidade do item.
const { HttpError } = require('../utils/http');

const n = (v) => Number(v || 0);

// Carrega tudo o que e preciso para expandir os itens (uma consulta por tabela).
async function carregarComposicao(db, tenantId, productIds, complementoIds = []) {
  const comps = complementoIds.length === 0 ? [] : (await db.query(
    `SELECT c.id, c.grupo_id, c.nome, c.preco, c.codigo, c.ingredient_id, c.quantidade_insumo, c.product_id, c.quantidade_produto, c.ativo,
            g.ativo AS grupo_ativo, i.custo_unitario AS insumo_custo, i.nome AS insumo_nome
     FROM complementos c JOIN grupos_complementos g ON g.id = c.grupo_id LEFT JOIN ingredients i ON i.id = c.ingredient_id
     WHERE c.tenant_id = $1 AND c.id = ANY($2::uuid[])`,
    [tenantId, complementoIds]
  )).rows;
  const todos = new Set(productIds);
  for (const c of comps) if (c.product_id) todos.add(c.product_id);
  const combos = new Map();
  const ci = todos.size === 0 ? [] : (await db.query(
    `SELECT combo_id, product_id, quantidade FROM combo_itens WHERE tenant_id = $1 AND combo_id = ANY($2::uuid[])`,
    [tenantId, [...todos]]
  )).rows;
  for (const r of ci) {
    if (!combos.has(r.combo_id)) combos.set(r.combo_id, []);
    combos.get(r.combo_id).push({ product_id: r.product_id, quantidade: n(r.quantidade) });
    todos.add(r.product_id);
  }
  const lista = [...todos];
  const fichas = new Map();
  const fr = lista.length === 0 ? [] : (await db.query(
    `SELECT pi.product_id, pi.ingredient_id, pi.quantidade_por_unidade, i.nome, i.unidade, i.custo_unitario
     FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
     WHERE pi.tenant_id = $1 AND pi.product_id = ANY($2::uuid[])`,
    [tenantId, lista]
  )).rows;
  for (const r of fr) {
    if (!fichas.has(r.product_id)) fichas.set(r.product_id, []);
    fichas.get(r.product_id).push(r);
  }
  const produtos = new Map((lista.length === 0 ? [] : (await db.query(
    `SELECT id, nome, unidade, preco_venda, preco_custo, ativo FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, lista]
  )).rows).map((p) => [p.id, p]));
  const grupos = new Map(); // product_id -> [{ id, nome, minimo, maximo }]
  const gr = productIds.length === 0 ? [] : (await db.query(
    `SELECT pg.product_id, g.id, g.nome, g.minimo, g.maximo FROM produto_grupos pg JOIN grupos_complementos g ON g.id = pg.grupo_id
     WHERE pg.tenant_id = $1 AND pg.product_id = ANY($2::uuid[]) AND g.ativo ORDER BY pg.ordem, g.nome`,
    [tenantId, productIds]
  )).rows;
  for (const r of gr) {
    if (!grupos.has(r.product_id)) grupos.set(r.product_id, []);
    grupos.get(r.product_id).push({ id: r.id, nome: r.nome, minimo: r.minimo, maximo: r.maximo });
  }
  return { produtos, fichas, combos, grupos, complementos: new Map(comps.map((c) => [c.id, c])) };
}

function novoAcumulador() {
  return { produtos: new Map(), insumos: new Map() };
}
function somar(mapa, chave, q) { mapa.set(chave, (mapa.get(chave) || 0) + q); }

// Produto base (sem combo): ficha -> insumos; senao -> estoque proprio.
function somarBase(comp, acc, productId, q) {
  const ficha = comp.fichas.get(productId);
  if (ficha) { for (const r of ficha) somar(acc.insumos, r.ingredient_id, n(r.quantidade_por_unidade) * q); return; }
  somar(acc.produtos, productId, q);
}
function somarProduto(comp, acc, productId, q) {
  const itens = comp.combos.get(productId);
  if (itens) { for (const c of itens) somarBase(comp, acc, c.product_id, c.quantidade * q); return; }
  somarBase(comp, acc, productId, q);
}

// Consumo de uma linha: { product_id, quantidade, complementos: [{ id, quantidade (por unidade) }] }.
function consumoDaLinha(comp, linha, acc = novoAcumulador()) {
  const q = n(linha.quantidade);
  somarProduto(comp, acc, linha.product_id, q);
  for (const e of linha.complementos || []) {
    const c = comp.complementos.get(e.id);
    if (!c) continue;
    const vezes = n(e.quantidade || 1) * q;
    if (c.ingredient_id) somar(acc.insumos, c.ingredient_id, n(c.quantidade_insumo) * vezes);
    if (c.product_id) somarProduto(comp, acc, c.product_id, n(c.quantidade_produto) * vezes);
  }
  return acc;
}
function consumoDasLinhas(comp, linhas) {
  const acc = novoAcumulador();
  for (const l of linhas) consumoDaLinha(comp, l, acc);
  return acc;
}

// Custo de uma unidade: produto (combo = soma dos componentes) + complementos escolhidos.
function custoUnitario(comp, productId, complementos = []) {
  const custoBase = (id) => {
    const ficha = comp.fichas.get(id);
    if (ficha) return ficha.reduce((s, r) => s + n(r.quantidade_por_unidade) * n(r.custo_unitario), 0);
    return n((comp.produtos.get(id) || {}).preco_custo);
  };
  const custoProduto = (id) => (comp.combos.has(id) ? comp.combos.get(id).reduce((s, c) => s + custoBase(c.product_id) * c.quantidade, 0) : n((comp.produtos.get(id) || {}).preco_custo));
  let custo = custoProduto(productId);
  for (const e of complementos) {
    const c = comp.complementos.get(e.id);
    if (!c) continue;
    if (c.ingredient_id) custo += n(c.insumo_custo) * n(c.quantidade_insumo) * n(e.quantidade || 1);
    if (c.product_id) custo += custoProduto(c.product_id) * n(c.quantidade_produto) * n(e.quantidade || 1);
  }
  return Number(custo.toFixed(4));
}

// Normaliza e valida os complementos escolhidos para um produto (PDV e pedidos da loja; o iFood ja validou os dele).
// Devolve [{ id, nome, quantidade, preco }] (por unidade do item).
function validarComplementos(comp, productId, escolhidos, { validarGrupos = true } = {}) {
  const lista = [];
  for (const e of escolhidos || []) {
    const c = comp.complementos.get(e && e.id);
    if (!c) throw new HttpError(400, 'complemento não encontrado');
    if (!c.ativo || !c.grupo_ativo) throw new HttpError(400, `o complemento "${c.nome}" está desativado`);
    const q = Number(e.quantidade || 1);
    if (!Number.isInteger(q) || q < 1) throw new HttpError(400, `quantidade inválida do complemento "${c.nome}"`);
    const ja = lista.find((x) => x.id === c.id);
    if (ja) ja.quantidade += q; else lista.push({ id: c.id, nome: c.nome, quantidade: q, preco: n(c.preco), grupo_id: c.grupo_id });
  }
  if (validarGrupos) {
    const grupos = comp.grupos.get(productId) || [];
    const nome = (comp.produtos.get(productId) || {}).nome || 'produto';
    for (const x of lista) {
      if (!grupos.some((g) => g.id === x.grupo_id)) throw new HttpError(400, `"${x.nome}" não é um complemento de "${nome}"`);
    }
    for (const g of grupos) {
      const total = lista.filter((x) => x.grupo_id === g.id).reduce((s, x) => s + x.quantidade, 0);
      if (total < g.minimo) throw new HttpError(400, `"${nome}": escolha ${g.minimo === g.maximo ? g.minimo : `ao menos ${g.minimo}`} em "${g.nome}"`);
      if (total > g.maximo) throw new HttpError(400, `"${nome}": no máximo ${g.maximo} em "${g.nome}"`);
    }
  }
  return lista.map(({ grupo_id, ...resto }) => resto); // eslint-disable-line no-unused-vars
}

const precoDosComplementos = (lista) => Number((lista || []).reduce((s, c) => s + n(c.preco) * n(c.quantidade), 0).toFixed(2));

// Ids de complementos citados em linhas (para carregar a composicao).
const idsDeComplementos = (linhas) => [...new Set(linhas.flatMap((l) => (l.complementos || []).map((c) => c && c.id)).filter(Boolean))];

// Saldos disponiveis numa loja (saldo - reservado por pedidos em aberto). Trava as linhas quando `travar`.
async function saldosDaLoja(db, tenantId, locationId, consumo, reservados, travar = false) {
  const prodIds = [...consumo.produtos.keys()].sort();
  const insIds = [...consumo.insumos.keys()].sort();
  const lock = travar ? ' FOR UPDATE' : '';
  const sp = prodIds.length === 0 ? [] : (await db.query(
    `SELECT product_id, saldo FROM stock_balances WHERE product_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY product_id${lock}`,
    [prodIds, locationId, tenantId]
  )).rows;
  const si = insIds.length === 0 ? [] : (await db.query(
    `SELECT ingredient_id, saldo FROM ingredient_balances WHERE ingredient_id = ANY($1::uuid[]) AND location_id = $2 AND tenant_id = $3 ORDER BY ingredient_id${lock}`,
    [insIds, locationId, tenantId]
  )).rows;
  const produtos = new Map(prodIds.map((id) => [id, 0]));
  const insumos = new Map(insIds.map((id) => [id, 0]));
  for (const r of sp) produtos.set(r.product_id, n(r.saldo));
  for (const r of si) insumos.set(r.ingredient_id, n(r.saldo));
  for (const [id, q] of reservados.produtos) if (produtos.has(id)) produtos.set(id, produtos.get(id) - q);
  for (const [id, q] of reservados.insumos) if (insumos.has(id)) insumos.set(id, insumos.get(id) - q);
  return { produtos, insumos };
}

// Lista do que falta (vazia = tudo disponivel), com nomes legiveis.
async function faltasDoConsumo(db, tenantId, consumo, disponivel, comp) {
  const faltas = [];
  for (const [id, q] of consumo.produtos) {
    const d = disponivel.produtos.get(id) || 0;
    if (d + 1e-9 < q) faltas.push({ tipo: 'produto', id, nome: (comp.produtos.get(id) || {}).nome || 'produto', necessario: q, disponivel: d });
  }
  const insIds = [...consumo.insumos.keys()];
  const nomes = insIds.length === 0 ? new Map() : new Map((await db.query(`SELECT id, nome, unidade FROM ingredients WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, insIds])).rows.map((r) => [r.id, r]));
  for (const [id, q] of consumo.insumos) {
    const d = disponivel.insumos.get(id) || 0;
    if (d + 1e-9 < q) { const i = nomes.get(id) || {}; faltas.push({ tipo: 'insumo', id, nome: i.nome || 'insumo', unidade: i.unidade || '', necessario: Number(q.toFixed(3)), disponivel: Number(d.toFixed(3)) }); }
  }
  return faltas;
}

// Quantas unidades de cada produto (sem complementos) ainda da para vender na loja, com o item que limita.
// Usado na busca do PDV e na disponibilidade do iFood. alvo: [{ chave, product_id?, complemento_id? }]
async function unidadesDisponiveis(db, tenantId, locationId, productIds, complementoIds = [], reservados) {
  const comp = await carregarComposicao(db, tenantId, productIds, complementoIds);
  const porProduto = new Map(productIds.map((id) => [id, consumoDaLinha(comp, { product_id: id, quantidade: 1 })]));
  const porComplemento = new Map(complementoIds.map((id) => {
    const c = comp.complementos.get(id);
    const acc = novoAcumulador();
    if (c && c.ingredient_id) somar(acc.insumos, c.ingredient_id, n(c.quantidade_insumo));
    if (c && c.product_id) somarProduto(comp, acc, c.product_id, n(c.quantidade_produto));
    return [id, acc];
  }));
  const tudo = novoAcumulador();
  for (const acc of [...porProduto.values(), ...porComplemento.values()]) {
    for (const k of acc.produtos.keys()) tudo.produtos.set(k, 1);
    for (const k of acc.insumos.keys()) tudo.insumos.set(k, 1);
  }
  const disp = await saldosDaLoja(db, tenantId, locationId, tudo, reservados);
  const insNomes = tudo.insumos.size === 0 ? new Map() : new Map((await db.query(`SELECT id, nome FROM ingredients WHERE id = ANY($1::uuid[])`, [[...tudo.insumos.keys()]])).rows.map((r) => [r.id, r.nome]));
  const calcular = (acc) => {
    let min = Infinity;
    let limitante = null;
    for (const [id, q] of acc.produtos) { const u = Math.floor((disp.produtos.get(id) || 0) / q + 1e-9); if (u < min) { min = u; limitante = (comp.produtos.get(id) || {}).nome || null; } }
    for (const [id, q] of acc.insumos) { const u = Math.floor((disp.insumos.get(id) || 0) / q + 1e-9); if (u < min) { min = u; limitante = insNomes.get(id) || null; } }
    return { unidades: min === Infinity ? null : Math.max(min, 0), limitante };
  };
  return {
    produtos: new Map([...porProduto].map(([id, acc]) => [id, calcular(acc)])),
    complementos: new Map([...porComplemento].map(([id, acc]) => [id, calcular(acc)])),
    comp,
  };
}

module.exports = {
  carregarComposicao, consumoDaLinha, consumoDasLinhas, custoUnitario, validarComplementos, precoDosComplementos,
  idsDeComplementos, saldosDaLoja, faltasDoConsumo, unidadesDisponiveis, novoAcumulador,
};
