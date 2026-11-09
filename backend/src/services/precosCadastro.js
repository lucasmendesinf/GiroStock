// Cadastro de preco por loja e faixas de quantidade de um produto (leitura e gravacao em bloco, dentro de uma transacao).
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const { cent, reais, precoDaFaixaEmCentavos, validarFaixasDaLoja } = require('./precos');

const MODOS = ['unitario', 'kit', 'percentual'];

// O que a tela de cadastro mostra: precos por loja (proprio ou herdado), faixas (por loja + gerais) com as colunas calculadas.
async function lerPrecos(db, tenantId, productId) {
  const p = (await db.query(`SELECT preco_venda, preco_custo FROM products WHERE id = $1 AND tenant_id = $2`, [productId, tenantId])).rows[0];
  if (!p) throw new HttpError(404, 'produto não encontrado');
  const vendaCent = cent(p.preco_venda);
  const custoCent = cent(p.preco_custo);
  const lojas = (await db.query(`SELECT id, nome, ativo FROM locations WHERE tenant_id = $1 ORDER BY nome`, [tenantId])).rows;
  const proprios = new Map((await db.query(`SELECT location_id, preco_venda, vende FROM produto_precos WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId])).rows.map((r) => [r.location_id, r]));
  const faixasRows = (await db.query(
    `SELECT id, location_id, rotulo, quantidade_minima, preco_unitario, modo_cadastro, valor_cadastro, automatica, ean_pack
       FROM produto_faixas WHERE tenant_id = $1 AND product_id = $2 AND ativo ORDER BY location_id NULLS FIRST, quantidade_minima`,
    [tenantId, productId]
  )).rows;
  const margem = (venda) => (venda > 0 ? Number((((venda - custoCent) / venda) * 100).toFixed(1)) : null);
  const precosLojas = lojas.map((l) => {
    const r = proprios.get(l.id);
    const efetivo = r && r.preco_venda !== null ? cent(r.preco_venda) : vendaCent;
    return {
      location_id: l.id, location_nome: l.nome, ativo: l.ativo,
      preco_venda: r && r.preco_venda !== null ? reais(cent(r.preco_venda)) : null, // null = herda o padrao
      preco_efetivo: reais(efetivo), vende: !r || r.vende !== false,
      margem_pct: margem(efetivo), lucro_unitario: reais(efetivo - custoCent),
    };
  });
  const faixas = faixasRows.map((f) => {
    const loja = f.location_id ? precosLojas.find((l) => l.location_id === f.location_id) : null;
    const tabela = loja ? cent(loja.preco_efetivo) : vendaCent;
    const pc = cent(f.preco_unitario);
    return {
      id: f.id, location_id: f.location_id, rotulo: f.rotulo, quantidade_minima: f.quantidade_minima, preco_unitario: reais(pc),
      modo_cadastro: f.modo_cadastro, valor_cadastro: f.valor_cadastro === null ? null : Number(f.valor_cadastro), automatica: f.automatica, ean_pack: f.ean_pack,
      kit: reais(pc * f.quantidade_minima), desconto_pct: tabela > 0 ? Number((((tabela - pc) / tabela) * 100).toFixed(1)) : null, margem_pct: margem(pc),
    };
  });
  return { preco_venda_padrao: reais(vendaCent), preco_custo: reais(custoCent), precos_lojas: precosLojas, faixas };
}

// Grava precos por loja e/ou faixas (o que vier no corpo; undefined = nao mexe). client ja em BEGIN.
// body: { precos_lojas: [{ location_id, preco_venda|null, vende }], faixas: [{ location_id|null, rotulo, quantidade_minima, modo_cadastro, valor_cadastro, automatica, ean_pack }] }
// Devolve { antes, depois, avisos } para a auditoria.
async function gravarPrecos(client, user, productId, body) {
  const tenantId = user.tenantId;
  const temPrecos = body.precos_lojas !== undefined;
  const temFaixas = body.faixas !== undefined;
  if (!temPrecos && !temFaixas) return null;
  const antes = await lerPrecos(client, tenantId, productId);
  const prod = (await client.query(`SELECT preco_venda, preco_custo FROM products WHERE id = $1 AND tenant_id = $2`, [productId, tenantId])).rows[0];
  const vendaCent = cent(prod.preco_venda);
  const custoCent = cent(prod.preco_custo);
  const lojas = new Map((await client.query(`SELECT id, nome FROM locations WHERE tenant_id = $1`, [tenantId])).rows.map((l) => [l.id, l.nome]));
  const avisos = [];

  // ---- precos por loja ----
  let precosFinais; // Map(location_id -> { preco_cent|null, vende })
  if (temPrecos) {
    if (!Array.isArray(body.precos_lojas)) throw new HttpError(400, 'precos_lojas deve ser uma lista');
    precosFinais = new Map();
    for (const r of body.precos_lojas) {
      if (!r || !isUuid(r.location_id) || !lojas.has(r.location_id)) throw new HttpError(400, 'loja inválida em precos_lojas');
      if (precosFinais.has(r.location_id)) throw new HttpError(400, `a loja "${lojas.get(r.location_id)}" aparece duas vezes nos preços`);
      let pc = null;
      if (r.preco_venda !== null && r.preco_venda !== undefined && r.preco_venda !== '') {
        const v = Number(r.preco_venda);
        if (!(v > 0) || v > 9999999) throw new HttpError(400, `preço de venda inválido para "${lojas.get(r.location_id)}"`);
        pc = cent(v);
        if (custoCent > 0 && pc <= custoCent) avisos.push(`O preço em "${lojas.get(r.location_id)}" (R$ ${(pc / 100).toFixed(2).replace('.', ',')}) está no custo ou abaixo dele.`);
      }
      precosFinais.set(r.location_id, { preco_cent: pc, vende: r.vende !== false });
    }
  } else {
    precosFinais = new Map(antes.precos_lojas.filter((l) => l.preco_venda !== null || !l.vende).map((l) => [l.location_id, { preco_cent: l.preco_venda === null ? null : cent(l.preco_venda), vende: l.vende }]));
  }
  const precoDaLoja = (id) => { const r = precosFinais.get(id); return r && r.preco_cent !== null ? r.preco_cent : vendaCent; };

  // ---- faixas ----
  let faixasFinais; // [{ location_id, rotulo, quantidade_minima, preco_cent, modo, valor, automatica, ean }]
  if (temFaixas) {
    if (!Array.isArray(body.faixas)) throw new HttpError(400, 'faixas deve ser uma lista');
    if (body.faixas.length > 0) {
      if ((await client.query(`SELECT 1 FROM combo_itens WHERE combo_id = $1 LIMIT 1`, [productId])).rows.length > 0) {
        throw new HttpError(400, 'combos não têm desconto por quantidade');
      }
    }
    faixasFinais = body.faixas.map((f) => {
      if (!f) throw new HttpError(400, 'faixa inválida');
      const locationId = f.location_id === null || f.location_id === undefined || f.location_id === '' ? null : f.location_id;
      if (locationId !== null && (!isUuid(locationId) || !lojas.has(locationId))) throw new HttpError(400, 'loja inválida em faixas');
      const qtd = Number(f.quantidade_minima);
      if (!Number.isInteger(qtd) || qtd < 2) throw new HttpError(400, 'a quantidade mínima da faixa precisa ser um número inteiro a partir de 2');
      const modo = f.modo_cadastro || 'unitario';
      if (!MODOS.includes(modo)) throw new HttpError(400, 'modo da faixa inválido (unitario, kit ou percentual)');
      const base = locationId ? precoDaLoja(locationId) : vendaCent;
      const preco = precoDaFaixaEmCentavos({ modo, valor: f.valor_cadastro, quantidade_minima: qtd }, base);
      const ean = f.ean_pack === undefined || f.ean_pack === null || String(f.ean_pack).trim() === '' ? null : String(f.ean_pack).trim();
      if (ean !== null && !/^\d{8,14}$/.test(ean)) throw new HttpError(400, 'o código de barras do pack precisa ter de 8 a 14 números');
      return { location_id: locationId, rotulo: String(f.rotulo || '').trim().slice(0, 40) || `Pack ${qtd}`, quantidade_minima: qtd, preco_cent: preco, modo, valor: Number(f.valor_cadastro), automatica: f.automatica !== false, ean };
    });
  } else {
    faixasFinais = antes.faixas.map((f) => ({ location_id: f.location_id, rotulo: f.rotulo, quantidade_minima: f.quantidade_minima, preco_cent: cent(f.preco_unitario), modo: f.modo_cadastro, valor: f.valor_cadastro, automatica: f.automatica, ean: f.ean_pack }));
  }
  if (temFaixas || temPrecos) {
    // grupos: uma lista por loja com faixas proprias + as gerais
    const grupos = new Map();
    for (const f of faixasFinais) { const k = f.location_id || 'gerais'; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(f); }
    for (const [k, lista] of grupos) {
      let unit;
      let nomeLoja = '';
      if (k === 'gerais') {
        // as gerais valem para as lojas sem faixas proprias: o preco unitario aplicavel e o menor entre o padrao e o dessas lojas
        unit = vendaCent;
        for (const [lid] of lojas) if (!grupos.has(lid)) unit = Math.min(unit, precoDaLoja(lid));
      } else { unit = precoDaLoja(k); nomeLoja = lojas.get(k); }
      avisos.push(...validarFaixasDaLoja(lista.map((f) => ({ quantidade_minima: f.quantidade_minima, preco_cent: f.preco_cent, rotulo: f.rotulo })), { precoUnitarioCent: unit, custoCent, nomeLoja }));
    }
  }
  // EAN do pack: unico na empresa, diferente de qualquer codigo de barras de produto e de outro pack
  const eans = faixasFinais.filter((f) => f.ean).map((f) => f.ean);
  if (new Set(eans).size !== eans.length) throw new HttpError(409, 'o mesmo código de barras de pack foi usado em duas faixas');
  if (eans.length > 0) {
    const bar = await client.query(`SELECT nome, barcode FROM products WHERE tenant_id = $1 AND barcode = ANY($2::text[]) LIMIT 1`, [tenantId, eans]);
    if (bar.rows.length) throw new HttpError(409, `o código ${bar.rows[0].barcode} já é o código de barras do produto "${bar.rows[0].nome}"`);
    const outro = await client.query(`SELECT ean_pack FROM produto_faixas WHERE tenant_id = $1 AND ativo AND product_id <> $2 AND ean_pack = ANY($3::text[]) LIMIT 1`, [tenantId, productId, eans]);
    if (outro.rows.length) throw new HttpError(409, `o código de barras de pack ${outro.rows[0].ean_pack} já é usado em outro produto`);
  }

  // ---- grava (substitui o conjunto do produto) ----
  if (temPrecos) {
    await client.query(`DELETE FROM produto_precos WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
    for (const [lid, r] of precosFinais) {
      if (r.preco_cent === null && r.vende) continue; // igual ao padrao: sem linha
      await client.query(
        `INSERT INTO produto_precos (tenant_id, product_id, location_id, preco_venda, vende) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, productId, lid, r.preco_cent === null ? null : reais(r.preco_cent), r.vende]
      );
    }
  }
  if (temFaixas) {
    await client.query(`DELETE FROM produto_faixas WHERE tenant_id = $1 AND product_id = $2`, [tenantId, productId]);
    for (const f of faixasFinais) {
      await client.query(
        `INSERT INTO produto_faixas (tenant_id, product_id, location_id, rotulo, quantidade_minima, preco_unitario, modo_cadastro, valor_cadastro, automatica, ean_pack)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [tenantId, productId, f.location_id, f.rotulo, f.quantidade_minima, reais(f.preco_cent), f.modo, Number.isFinite(f.valor) ? f.valor : null, f.automatica, f.ean]
      );
    }
  }
  const depois = await lerPrecos(client, tenantId, productId);
  return { antes, depois, avisos };
}

// Quando o preco padrao muda: reconfere as faixas guardadas (percentual acompanha o preco; as demais precisam continuar abaixo dele).
async function revalidarFaixas(client, user, productId) {
  const atual = await lerPrecos(client, user.tenantId, productId);
  if (atual.faixas.length === 0) return null;
  return gravarPrecos(client, user, productId, {
    faixas: atual.faixas.map((f) => ({ location_id: f.location_id, rotulo: f.rotulo, quantidade_minima: f.quantidade_minima, modo_cadastro: f.modo_cadastro, valor_cadastro: f.valor_cadastro, automatica: f.automatica, ean_pack: f.ean_pack })),
  });
}

module.exports = { lerPrecos, gravarPrecos, revalidarFaixas };
