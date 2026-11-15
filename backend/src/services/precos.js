// Preco de venda por loja e desconto por quantidade (pack/atacado). Servico unico usado por TODOS os caminhos de venda
// (PDV, pedidos, rodadas de comanda): quem cobra pergunta aqui, nunca le products.preco_venda direto.
//
// Regras (decididas com o cliente):
//  - O custo e um so por produto (products.preco_custo); so o preco de venda varia por loja (produto_precos).
//  - Sem linha em produto_precos = herda o preco padrao e vende. vende=false = a loja nao vende o produto.
//  - Faixa de quantidade vale so para o MESMO produto, dentro de UM documento (venda, pedido ou rodada); nunca entre rodadas.
//  - Se a loja tem faixas proprias, elas substituem as gerais (location_id NULL) naquela loja.
//  - Faixa automatica: vale a de maior quantidade_minima atingida. Manual: so com faixa_id. Automatica + manual elegiveis:
//    vale a de menor preco unitario (nunca empilha). Aplicada a faixa, TODAS as unidades pagam o preco da faixa ("atacado").
//  - Faixa "kit" (pack fechado, ex.: 12 un por R$ 50,00): cada pack fechado sai pelo valor do pack e o que sobra sai pelo
//    preco normal da unidade (13 = 1 pack + 1 avulsa; 24 = 2 packs). Varios packs: do maior para o menor. Se a regra de
//    atacado de outra faixa ficar mais barata, vale a mais barata. O valor do pack e cobrado exato (sem exigir divisao).
//  - Loja com "preco por quantidade" desligado (locations.aplica_preco_quantidade = false, ex.: lanchonete, casa de eventos):
//    nenhuma faixa vale la (pack nem atacado); o EAN do pack ainda lanca a quantidade, pelo preco da unidade.
//  - Dinheiro sempre em centavos inteiros.
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');

const cent = (v) => { const n = Number(v); return Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7)); };
const reais = (c) => Number((c / 100).toFixed(2));
const brl = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;

// ---------- regras puras (testadas em scripts/teste-precos.mjs) ----------

// Preco unitario (em centavos) de uma faixa a partir de como o usuario a informou.
//  unitario: valor = preco por unidade; kit: valor = preco do kit fechado (precisa dividir em centavos exatos);
//  percentual: valor = % de desconto sobre o preco da loja.
function precoDaFaixaEmCentavos({ modo, valor, quantidade_minima }, precoLojaCent) {
  const v = Number(valor);
  if (!(v > 0)) throw new HttpError(400, 'informe um valor maior que zero para a faixa');
  if (modo === 'kit') return Math.round(cent(v) / quantidade_minima); // preco medio por unidade (so para mostrar e validar)
  if (modo === 'percentual') {
    if (!(v < 100)) throw new HttpError(400, 'o desconto em % precisa ser menor que 100');
    return Math.round(precoLojaCent * (1 - v / 100));
  }
  return cent(v);
}

// Valida o conjunto de faixas de UMA loja (ou das gerais) contra o preco unitario aplicavel.
// faixas: [{ quantidade_minima, preco_cent, rotulo }]. Lanca 400 nos erros; devolve avisos (nao bloqueiam).
function validarFaixasDaLoja(faixas, { precoUnitarioCent, custoCent, nomeLoja }) {
  const onde = nomeLoja ? ` (${nomeLoja})` : '';
  const avisos = [];
  const vistas = new Set();
  for (const f of faixas) {
    if (!Number.isInteger(f.quantidade_minima) || f.quantidade_minima < 2) throw new HttpError(400, `a quantidade mínima da faixa${onde} precisa ser um número inteiro a partir de 2`);
    if (!(f.preco_cent > 0)) throw new HttpError(400, `o preço da faixa${onde} precisa ser maior que zero`);
    if (f.preco_cent >= precoUnitarioCent) throw new HttpError(400, `o preço da faixa "${f.rotulo || f.quantidade_minima + ' un'}"${onde} (${brl(f.preco_cent)}) precisa ser menor que o preço unitário (${brl(precoUnitarioCent)})`);
    if (vistas.has(f.quantidade_minima)) throw new HttpError(400, `há duas faixas${onde} com a mesma quantidade mínima (${f.quantidade_minima} un)`);
    vistas.add(f.quantidade_minima);
  }
  const ordenadas = [...faixas].sort((a, b) => a.quantidade_minima - b.quantidade_minima);
  for (let i = 1; i < ordenadas.length; i++) {
    if (ordenadas[i].preco_cent >= ordenadas[i - 1].preco_cent) {
      throw new HttpError(400, `os preços das faixas${onde} precisam diminuir conforme a quantidade aumenta (${ordenadas[i].quantidade_minima} un não pode custar ${brl(ordenadas[i].preco_cent)} se ${ordenadas[i - 1].quantidade_minima} un custa ${brl(ordenadas[i - 1].preco_cent)})`);
    }
  }
  for (const f of ordenadas) {
    const nome = f.rotulo || `${f.quantidade_minima} un`;
    if (custoCent > 0 && f.preco_cent <= custoCent) avisos.push(`A faixa "${nome}"${onde} (${brl(f.preco_cent)}) está no custo ou abaixo dele (${brl(custoCent)}).`);
    else if (custoCent > 0 && (f.preco_cent - custoCent) / f.preco_cent < 0.10) avisos.push(`A faixa "${nome}"${onde} deixa menos de 10% de margem.`);
  }
  return avisos;
}

// Qual faixa vale para uma quantidade. faixas: [{ id, quantidade_minima, preco_cent, automatica, rotulo }].
// Devolve a faixa ou null. Lanca 400 se uma faixa manual pedida nao e elegivel.
function escolherFaixa(faixas, quantidade, faixaId) {
  const q = Number(quantidade);
  const autos = faixas.filter((f) => f.automatica && q >= f.quantidade_minima);
  let auto = null;
  for (const f of autos) if (!auto || f.quantidade_minima > auto.quantidade_minima) auto = f;
  let manual = null;
  if (faixaId) {
    manual = faixas.find((f) => f.id === faixaId);
    if (!manual) throw new HttpError(400, 'faixa de preço inválida para este produto nesta loja');
    if (q < manual.quantidade_minima) throw new HttpError(400, `a faixa "${manual.rotulo || manual.quantidade_minima + ' un'}" exige no mínimo ${manual.quantidade_minima} un`);
  }
  if (auto && manual) return manual.preco_cent < auto.preco_cent ? manual : auto;
  return manual || auto;
}

// Total (centavos) de uma quantidade do produto: tabela, atacado (faixas por unidade/%) ou pack fechado + avulsas (faixas kit).
// faixas: [{ id, quantidade_minima, preco_cent, automatica, rotulo, modo_cadastro, kit_cent }]. Vale o menor total.
// Devolve { total_cent, faixa (a que valeu ou o maior pack usado), packs: [{ faixa, vezes }], avulsas, pack: bool }.
function calcularTotal(faixas, quantidade, tabelaCent, faixaId) {
  const q = Number(quantidade);
  const lista = faixas || [];
  const ehKit = (f) => f.modo_cadastro === 'kit' && f.kit_cent > 0;
  // manual pedida: valida (existe e a quantidade alcanca)
  if (faixaId) escolherFaixa(lista, q, faixaId);
  const atacado = escolherFaixa(lista.filter((f) => !ehKit(f) && (f.automatica || f.id === faixaId)), q, lista.some((f) => !ehKit(f) && f.id === faixaId) ? faixaId : null);
  let melhor = { total_cent: Math.round(q * tabelaCent), faixa: null, packs: [], avulsas: q, pack: false };
  if (atacado) {
    const t = Math.round(q * atacado.preco_cent);
    if (t < melhor.total_cent) melhor = { total_cent: t, faixa: atacado, packs: [], avulsas: 0, pack: false };
  }
  // pack fechado: so quantidade inteira forma pack
  if (Number.isInteger(q)) {
    const kits = lista.filter((f) => ehKit(f) && (f.automatica || f.id === faixaId)).sort((a, b) => b.quantidade_minima - a.quantidade_minima);
    let resto = q;
    let total = 0;
    const packs = [];
    for (const k of kits) {
      const vezes = Math.floor(resto / k.quantidade_minima);
      if (vezes > 0) { packs.push({ faixa: k, vezes }); total += vezes * k.kit_cent; resto -= vezes * k.quantidade_minima; }
    }
    if (packs.length) {
      total += resto * tabelaCent;
      if (total < melhor.total_cent) melhor = { total_cent: total, faixa: packs[0].faixa, packs, avulsas: resto, pack: true };
    }
  }
  return melhor;
}

// Rotulo do que valeu: "Pack 12" | "Pack 12 ×2 + 1 avulsa" | rotulo da faixa de atacado.
function rotuloDoCalculo(c) {
  if (!c.faixa) return null;
  if (!c.pack) return c.faixa.rotulo || `${c.faixa.quantidade_minima} un`;
  const partes = c.packs.map((p) => `${p.faixa.rotulo || `Pack ${p.faixa.quantidade_minima}`}${p.vezes > 1 ? ` ×${p.vezes}` : ''}`);
  if (c.avulsas > 0) partes.push(`${c.avulsas} avulsa${c.avulsas > 1 ? 's' : ''}`);
  return partes.join(' + ').slice(0, 60);
}

// ---------- leitura em lote (venda, pedido, busca) ----------

// A loja aplica preco por quantidade (pack/atacado)? Loja inexistente ou sem a coluna: sim (comportamento de antes).
async function aplicaPrecoQuantidade(db, tenantId, locationId) {
  if (!locationId) return true;
  const r = (await db.query(`SELECT aplica_preco_quantidade FROM locations WHERE id = $1 AND tenant_id = $2`, [locationId, tenantId])).rows[0];
  return !r || r.aplica_preco_quantidade !== false;
}

// Faixas e precos da loja para varios produtos. Devolve { precos: Map(product_id -> { preco_cent|null, vende }), faixas: Map(product_id -> [...]) }.
async function carregarRegras(db, tenantId, locationId, productIds) {
  const precos = new Map();
  const faixas = new Map();
  if (productIds.length === 0) return { precos, faixas };
  const pr = await db.query(
    `SELECT product_id, preco_venda, vende FROM produto_precos WHERE tenant_id = $1 AND location_id = $2 AND product_id = ANY($3::uuid[])`,
    [tenantId, locationId, productIds]
  );
  for (const r of pr.rows) precos.set(r.product_id, { preco_cent: r.preco_venda === null ? null : cent(r.preco_venda), vende: r.vende });
  if (!(await aplicaPrecoQuantidade(db, tenantId, locationId))) return { precos, faixas };
  const fx = await db.query(
    `SELECT id, product_id, location_id, rotulo, quantidade_minima, preco_unitario, modo_cadastro, valor_cadastro, automatica, ean_pack
       FROM produto_faixas WHERE tenant_id = $1 AND ativo AND product_id = ANY($2::uuid[]) AND (location_id = $3 OR location_id IS NULL)
      ORDER BY quantidade_minima`,
    [tenantId, productIds, locationId]
  );
  const porProduto = new Map();
  for (const r of fx.rows) {
    if (!porProduto.has(r.product_id)) porProduto.set(r.product_id, { loja: [], gerais: [] });
    porProduto.get(r.product_id)[r.location_id ? 'loja' : 'gerais'].push({
      id: r.id, rotulo: r.rotulo, quantidade_minima: r.quantidade_minima, preco_cent: cent(r.preco_unitario),
      modo_cadastro: r.modo_cadastro, automatica: r.automatica, ean_pack: r.ean_pack,
      // pack fechado: o valor do pack exato (como foi cadastrado), nao o preco medio x quantidade
      kit_cent: r.modo_cadastro === 'kit' ? (r.valor_cadastro !== null ? cent(r.valor_cadastro) : cent(r.preco_unitario) * r.quantidade_minima) : null,
    });
  }
  // faixas proprias da loja substituem as gerais
  for (const [pid, g] of porProduto) faixas.set(pid, g.loja.length > 0 ? g.loja : g.gerais);
  return { precos, faixas };
}

// Preco de cada produto de um documento.
// itens: [{ product_id, quantidade (ja somada por produto), faixa_id? }]. Devolve Map(product_id -> resultado):
//   { preco_tabela, preco_unitario, faixa: { id, rotulo, quantidade_minima } | null, vende, nome }   (valores em reais)
// opc.ignorarVende: nao recusa produto que a loja nao vende (uso interno, ex.: relatorios).
async function precosDosProdutos(db, tenantId, locationId, itens, opc = {}) {
  const ids = [...new Set(itens.map((i) => i.product_id))];
  const out = new Map();
  if (ids.length === 0) return out;
  const prods = await db.query(`SELECT id, nome, preco_venda FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
  const combos = new Set((await db.query(`SELECT DISTINCT combo_id FROM combo_itens WHERE combo_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.combo_id));
  const { precos, faixas } = await carregarRegras(db, tenantId, locationId, ids);
  const info = new Map(prods.rows.map((p) => [p.id, p]));
  for (const it of itens) {
    const p = info.get(it.product_id);
    if (!p) continue; // quem chama ja valida a existencia do produto
    const regra = precos.get(it.product_id);
    const vende = !regra || regra.vende !== false;
    if (!vende && !opc.ignorarVende) throw new HttpError(400, `"${p.nome}" não é vendido nesta loja`);
    const tabelaCent = regra && regra.preco_cent !== null ? regra.preco_cent : cent(p.preco_venda);
    const c = combos.has(it.product_id) ? { total_cent: Math.round(Number(it.quantidade) * tabelaCent), faixa: null, pack: false, packs: [], avulsas: 0 }
      : calcularTotal(faixas.get(it.product_id) || [], it.quantidade, tabelaCent, it.faixa_id || null);
    const q = Number(it.quantidade);
    out.set(it.product_id, {
      nome: p.nome, vende, preco_tabela: reais(tabelaCent),
      // pack fechado: preco medio com 4 casas (12 por 50,00 = 4,1667); o total exato vai em total_cent (rateado nas linhas)
      preco_unitario: c.pack ? Number((c.total_cent / q / 100).toFixed(4)) : reais(c.faixa ? c.faixa.preco_cent : tabelaCent),
      total_cent: c.pack ? c.total_cent : null, quantidade: q,
      faixa: c.faixa ? { id: c.faixa.id, rotulo: rotuloDoCalculo(c), quantidade_minima: c.faixa.quantidade_minima, pack: c.pack } : null,
    });
  }
  return out;
}

// Pack fechado: reparte o total exato do produto (centavos) entre as linhas dele, pela quantidade (a ultima leva o resto).
// linhas: [{ product_id, quantidade, compl (reais por unidade) }] na ordem do documento. Devolve Map(indice -> { subtotal, preco_unitario }).
function ratearLinhas(linhas, regras) {
  const out = new Map();
  const grupos = new Map();
  linhas.forEach((l, i) => {
    const r = regras && regras.get(l.product_id);
    if (!r || r.total_cent === null || r.total_cent === undefined) return;
    if (!grupos.has(l.product_id)) grupos.set(l.product_id, []);
    grupos.get(l.product_id).push(i);
  });
  for (const [pid, idx] of grupos) {
    const r = regras.get(pid);
    let resto = r.total_cent;
    idx.forEach((i, k) => {
      const l = linhas[i];
      const q = Number(l.quantidade);
      const parte = k === idx.length - 1 ? resto : Math.round((r.total_cent * q) / r.quantidade);
      resto -= parte;
      const sub = parte + Math.round(cent(l.compl || 0) * q);
      out.set(i, { subtotal: reais(sub), preco_unitario: Number((sub / q / 100).toFixed(4)) });
    });
  }
  return out;
}

async function precoDoProduto(db, tenantId, productId, locationId, quantidade, { faixaId } = {}) {
  const m = await precosDosProdutos(db, tenantId, locationId, [{ product_id: productId, quantidade, faixa_id: faixaId }]);
  return m.get(productId) || null;
}

// Soma por produto + faixa pedida (a primeira linha do produto que trouxer faixa_id), no formato de precosDosProdutos.
function itensParaPreco(linhas) {
  const por = new Map();
  for (const l of linhas) {
    const a = por.get(l.product_id) || { product_id: l.product_id, quantidade: 0, faixa_id: null };
    a.quantidade += Number(l.quantidade);
    if (!a.faixa_id && isUuid(l.faixa_id)) a.faixa_id = l.faixa_id;
    por.set(l.product_id, a);
  }
  return [...por.values()];
}

// ---------- consulta para o PDV / pedidos / garcom ----------

// Dados de preco de uma lista de produtos numa loja: preco da loja, se vende e faixas elegiveis (para a tela).
async function infoDePrecoDaLoja(db, tenantId, locationId, produtos) {
  const ids = produtos.map((p) => p.id);
  const { precos, faixas } = await carregarRegras(db, tenantId, locationId, ids);
  const combos = ids.length ? new Set((await db.query(`SELECT DISTINCT combo_id FROM combo_itens WHERE combo_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.combo_id)) : new Set();
  const out = new Map();
  for (const p of produtos) {
    const regra = precos.get(p.id);
    const tabelaCent = regra && regra.preco_cent !== null ? regra.preco_cent : cent(p.preco_venda);
    const lista = combos.has(p.id) ? [] : (faixas.get(p.id) || []);
    out.set(p.id, {
      vende: !regra || regra.vende !== false,
      preco_venda: reais(tabelaCent),
      preco_diferente_da_padrao: !!(regra && regra.preco_cent !== null && regra.preco_cent !== cent(p.preco_venda)),
      faixas: lista.map((f) => ({
        id: f.id, rotulo: f.rotulo, quantidade_minima: f.quantidade_minima, preco_unitario: reais(f.preco_cent),
        modo: f.modo_cadastro === 'kit' ? 'pack' : 'atacado', // pack: pack fechado + avulsas; atacado: todas as unidades no preco da faixa
        kit: f.modo_cadastro === 'kit' && f.kit_cent ? reais(f.kit_cent) : reais(f.preco_cent * f.quantidade_minima), automatica: f.automatica, ean_pack: f.ean_pack || null,
        economia: reais(tabelaCent * f.quantidade_minima - (f.modo_cadastro === 'kit' && f.kit_cent ? f.kit_cent : f.preco_cent * f.quantidade_minima)),
      })),
    });
  }
  return out;
}

// Produto + faixa de um EAN de pack (na loja). Devolve { product_id, faixa } ou null.
async function buscarPorEanPack(db, tenantId, locationId, ean) {
  const { rows } = await db.query(
    `SELECT f.id, f.product_id, f.location_id FROM produto_faixas f
      WHERE f.tenant_id = $1 AND f.ativo AND f.ean_pack = $2 AND (f.location_id = $3 OR f.location_id IS NULL)
      ORDER BY (f.location_id IS NULL) LIMIT 1`,
    [tenantId, String(ean), locationId]
  );
  if (rows.length === 0) return null;
  const regra = (await carregarRegras(db, tenantId, locationId, [rows[0].product_id])).faixas.get(rows[0].product_id) || [];
  const faixa = regra.find((f) => f.id === rows[0].id);
  if (faixa) return { product_id: rows[0].product_id, faixa };
  // loja sem preco por quantidade: o codigo do fardo ainda lanca a quantidade do pack (pelo preco da unidade)
  const f = (await db.query(`SELECT id, quantidade_minima FROM produto_faixas WHERE id = $1`, [rows[0].id])).rows[0];
  return f && !(await aplicaPrecoQuantidade(db, tenantId, locationId)) ? { product_id: rows[0].product_id, faixa: { id: null, quantidade_minima: f.quantidade_minima } } : null;
}

module.exports = {
  cent, reais, brl, precoDaFaixaEmCentavos, validarFaixasDaLoja, escolherFaixa, calcularTotal, rotuloDoCalculo, ratearLinhas,
  carregarRegras, precosDosProdutos, precoDoProduto, itensParaPreco, infoDePrecoDaLoja, buscarPorEanPack,
};
