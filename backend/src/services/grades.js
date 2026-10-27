// Grades de variacoes: cada combinacao dos atributos (ex.: Cor x Tamanho) vira um produto comum ligado a grade, com
// codigo interno, codigo de barras (o informado ou um EAN-13 interno com prefixo 2), preco e estoque proprios. Assim o
// PDV, o estoque, as vendas, as reservas do site e os relatorios funcionam sem nada especial para variacao.
// No site, a grade aparece como um produto so (services/lojaVirtual.js) e os dados dela (lv_grades) sao copiados para
// o produto de cada variacao (lv_produtos) por sincronizarSite().
const { HttpError } = require('../utils/http');
const { isValidBarcode, isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { getOwned, getOwnedLocation } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');

const UNIDADES = ['UN', 'KG', 'L', 'CX'];
const MAX_ATRIBUTOS = 3;
const MAX_VALORES = 30;
const MAX_VARIACOES = 200;
const n2 = (v) => Number(Number(v || 0).toFixed(2));
const texto = (v, max) => String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// [{ nome, valores: [...] }] -> validado (nomes e valores sem repetir, ate 3 atributos).
function normalizarAtributos(lista) {
  if (!Array.isArray(lista) || lista.length === 0) throw new HttpError(400, 'informe ao menos um atributo (ex.: Cor) com os valores');
  if (lista.length > MAX_ATRIBUTOS) throw new HttpError(400, `no máximo ${MAX_ATRIBUTOS} atributos por grade (ex.: Cor, Tamanho e Voltagem)`);
  const nomes = new Set();
  return lista.map((a) => {
    const nome = texto(a && a.nome, 30);
    if (nome.length < 2) throw new HttpError(400, 'nome do atributo inválido (ex.: Cor, Tamanho)');
    if (nomes.has(semAcento(nome))) throw new HttpError(400, `atributo repetido: ${nome}`);
    nomes.add(semAcento(nome));
    const vistos = new Set();
    const valores = (Array.isArray(a.valores) ? a.valores : []).map((v) => texto(v, 30)).filter((v) => {
      if (!v || vistos.has(semAcento(v))) return false;
      vistos.add(semAcento(v));
      return true;
    });
    if (valores.length === 0) throw new HttpError(400, `informe os valores de ${nome}`);
    if (valores.length > MAX_VALORES) throw new HttpError(400, `${nome}: no máximo ${MAX_VALORES} valores`);
    return { nome, valores };
  });
}

// Todas as combinacoes: [{ Cor: 'Preta', Tamanho: 'P' }, ...] na ordem dos valores.
function combinacoes(atributos) {
  let r = [{}];
  for (const a of atributos) r = r.flatMap((c) => a.valores.map((v) => ({ ...c, [a.nome]: v })));
  return r;
}
const chave = (v) => JSON.stringify(Object.keys(v).sort().map((k) => [semAcento(k), semAcento(v[k])]));
const nomeVariacao = (nome, atributos, v) => `${nome} - ${atributos.map((a) => v[a.nome]).join(' - ')}`.slice(0, 200);

// EAN-13 interno (prefixo 2 = uso dentro da loja), unico na empresa.
function digitoEan(d12) {
  const s = d12.split('').reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0);
  return String((10 - (s % 10)) % 10);
}
async function gerarEan(client, tenantId) {
  for (let i = 0; i < 20; i++) {
    const base = `2${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
    const ean = base + digitoEan(base);
    const ex = await client.query(`SELECT 1 FROM products WHERE tenant_id = $1 AND barcode = $2`, [tenantId, ean]);
    if (ex.rows.length === 0) return ean;
  }
  throw new HttpError(500, 'não foi possível gerar o código de barras');
}

async function proximoCodigo(client, tenantId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('products:' || $1::text))`, [tenantId]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(codigo_interno FROM '^PRD-([0-9]+)$')::int), 0) + 1 AS proximo FROM products WHERE tenant_id = $1`,
    [tenantId]
  );
  return `PRD-${String(rows[0].proximo).padStart(4, '0')}`;
}

function precos(custo, venda) {
  const c = Number(custo);
  const v = Number(venda);
  if (!(c > 0)) throw new HttpError(400, 'preço de custo deve ser maior que zero');
  if (!(v > 0)) throw new HttpError(400, 'preço de venda deve ser maior que zero');
  if (!(v > c)) throw new HttpError(400, 'preço de venda deve ser maior que o custo');
  return { custo: n2(c), venda: n2(v) };
}

// Cria o produto de uma variacao (dentro da transacao). d: { variacao, barcode, preco_custo, preco_venda, estoque_inicial }
async function criarVariacao(client, user, grade, base, d, local) {
  const barcode = d.barcode ? String(d.barcode).trim() : await gerarEan(client, user.tenantId);
  if (!isValidBarcode(barcode)) throw new HttpError(400, `código de barras inválido (${barcode}): use 8 a 14 números`);
  const dup = await client.query(`SELECT nome FROM products WHERE tenant_id = $1 AND barcode = $2`, [user.tenantId, barcode]);
  if (dup.rows.length) throw new HttpError(409, `o código de barras ${barcode} já é de "${dup.rows[0].nome}"`);
  const { custo, venda } = precos(d.preco_custo !== undefined && d.preco_custo !== null && d.preco_custo !== '' ? d.preco_custo : base.preco_custo,
    d.preco_venda !== undefined && d.preco_venda !== null && d.preco_venda !== '' ? d.preco_venda : base.preco_venda);
  const codigo = await proximoCodigo(client, user.tenantId);
  const { rows } = await client.query(
    `INSERT INTO products (tenant_id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda, grade_id, variacao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, codigo_interno, nome, barcode, preco_custo, preco_venda, variacao`,
    [user.tenantId, codigo, nomeVariacao(grade.nome, grade.atributos, d.variacao), grade.categoria_id, base.supplier_id || null, barcode, base.unidade,
      custo, venda, grade.id, JSON.stringify(d.variacao)]
  );
  const p = rows[0];
  if (base.supplier_id) {
    await client.query(`INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [user.tenantId, p.id, base.supplier_id]);
  }
  const qtd = Number(d.estoque_inicial || 0);
  if (local) {
    if (!(qtd >= 0) || !isQuantidadeValidaParaUnidade(qtd, base.unidade)) throw new HttpError(400, `estoque inicial inválido em ${p.nome}`);
    await client.query(`INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)`, [p.id, local, user.tenantId, qtd]);
    if (qtd > 0) {
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, supplier_id, custo_unitario)
         VALUES ($1, $2, 'entrada', $3, NULL, $4, 'Estoque inicial no cadastro da grade', $5, $6, $7)`,
        [user.tenantId, p.id, qtd, local, user.id, base.supplier_id || null, custo]
      );
    }
  } else if (qtd > 0) {
    throw new HttpError(400, 'informe a loja do estoque inicial');
  }
  return p;
}

// Nova grade. b: { nome, categoria_id, unidade, preco_custo, preco_venda, supplier_id, atributos, location_id,
//                  variacoes: [{ variacao: { Cor: 'Preta', ... }, barcode, preco_custo, preco_venda, estoque_inicial, criar }] }
// Sem "variacoes", cria todas as combinacoes. Com "variacoes", so as marcadas (criar !== false).
async function criarGrade(client, user, b) {
  const nome = texto(b.nome, 120);
  if (nome.length < 3) throw new HttpError(400, 'nome da grade deve ter no mínimo 3 caracteres');
  if (!b.categoria_id) throw new HttpError(400, 'categoria é obrigatória');
  await getOwned(client, 'categories', b.categoria_id, user.tenantId);
  if (!UNIDADES.includes(b.unidade || 'UN')) throw new HttpError(400, 'unidade inválida');
  const atributos = normalizarAtributos(b.atributos);
  const base = { ...precos(b.preco_custo, b.preco_venda), unidade: b.unidade || 'UN', supplier_id: b.supplier_id || null };
  base.preco_custo = base.custo; base.preco_venda = base.venda;
  if (base.supplier_id) await getOwned(client, 'suppliers', base.supplier_id, user.tenantId, { ativo: true, columns: 'id, ativo' });
  let local = null;
  if (b.location_id) {
    await getOwnedLocation(client, b.location_id, user.tenantId);
    assertLocationAccess(user, b.location_id, 'lançar estoque neste local');
    local = b.location_id;
  }
  const todas = combinacoes(atributos);
  if (todas.length > MAX_VARIACOES) throw new HttpError(400, `essa grade daria ${todas.length} variações: o máximo é ${MAX_VARIACOES}`);
  const porChave = new Map((Array.isArray(b.variacoes) ? b.variacoes : []).map((v) => [chave(v.variacao || {}), v]));
  const escolhidas = todas.map((v) => ({ ...(porChave.get(chave(v)) || {}), variacao: v })).filter((v) => !b.variacoes || (porChave.has(chave(v.variacao)) && v.criar !== false));
  if (escolhidas.length === 0) throw new HttpError(400, 'escolha ao menos uma variação');
  const { rows } = await client.query(
    `INSERT INTO produto_grades (tenant_id, nome, categoria_id, atributos) VALUES ($1, $2, $3, $4) RETURNING *`,
    [user.tenantId, nome, b.categoria_id, JSON.stringify(atributos)]
  );
  const grade = rows[0];
  const criadas = [];
  for (const v of escolhidas) criadas.push(await criarVariacao(client, user, grade, base, v, local));
  return { grade, variacoes: criadas };
}

async function gradeDaEmpresa(db, tenantId, id, travar = false) {
  const g = (await db.query(`SELECT * FROM produto_grades WHERE id = $1 AND tenant_id = $2${travar ? ' FOR UPDATE' : ''}`, [id, tenantId])).rows[0];
  if (!g) throw new HttpError(404, 'grade não encontrada');
  return g;
}

// Grade com as variacoes (saldo total e por local).
async function detalhe(db, tenantId, id) {
  const g = await gradeDaEmpresa(db, tenantId, id);
  const { rows } = await db.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.barcode, p.unidade, p.preco_custo, p.preco_venda, p.ativo, p.variacao,
            COALESCE((SELECT SUM(sb.saldo) FROM stock_balances sb WHERE sb.product_id = p.id), 0) AS saldo_total
     FROM products p WHERE p.grade_id = $1 AND p.tenant_id = $2 ORDER BY p.criado_em, p.codigo_interno`,
    [id, tenantId]
  );
  // na ordem dos valores de cada atributo (Preta P, Preta M, ..., Branca P...)
  const posicao = (v) => g.atributos.map((a) => a.valores.indexOf(v[a.nome]));
  const comparar = (x, y) => { const a = posicao(x.variacao); const b = posicao(y.variacao); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  return { ...g, variacoes: rows.map((r) => ({ ...r, preco_custo: n2(r.preco_custo), preco_venda: n2(r.preco_venda), saldo_total: Number(r.saldo_total) })).sort(comparar) };
}

// Acrescenta valores a atributos (atributo novo nao: mudaria todas as variacoes) e cria as combinacoes com os valores novos.
// b: { valores: { Cor: ['Azul'] }, preco_custo, preco_venda, location_id }
async function adicionarValores(client, user, id, b) {
  const g = await gradeDaEmpresa(client, user.tenantId, id, true);
  const novos = b.valores && typeof b.valores === 'object' ? b.valores : {};
  const atributos = g.atributos.map((a) => ({ ...a, valores: [...a.valores] }));
  let mudou = false;
  const adicionados = new Map(); // atributo -> valores novos
  for (const [nomeAttr, lista] of Object.entries(novos)) {
    const a = atributos.find((x) => semAcento(x.nome) === semAcento(nomeAttr));
    if (!a) throw new HttpError(400, `atributo "${nomeAttr}" não existe nesta grade`);
    for (const v of (Array.isArray(lista) ? lista : [lista]).map((x) => texto(x, 30)).filter(Boolean)) {
      if (!a.valores.some((x) => semAcento(x) === semAcento(v))) {
        a.valores.push(v);
        mudou = true;
        if (!adicionados.has(a.nome)) adicionados.set(a.nome, new Set());
        adicionados.get(a.nome).add(v);
      }
    }
    if (a.valores.length > MAX_VALORES) throw new HttpError(400, `${a.nome}: no máximo ${MAX_VALORES} valores`);
  }
  if (!mudou) throw new HttpError(400, 'nenhum valor novo');
  const existentes = new Set((await client.query(`SELECT variacao FROM products WHERE grade_id = $1`, [g.id])).rows.map((r) => chave(r.variacao)));
  // so as combinacoes com algum valor novo (as que o lojista deixou de fora no cadastro continuam de fora)
  const faltam = combinacoes(atributos).filter((v) => !existentes.has(chave(v)) && [...adicionados].some(([attr, vs]) => vs.has(v[attr])));
  if (existentes.size + faltam.length > MAX_VARIACOES) throw new HttpError(400, `a grade passaria de ${MAX_VARIACOES} variações`);
  const ref = (await client.query(`SELECT unidade, preco_custo, preco_venda, supplier_id FROM products WHERE grade_id = $1 ORDER BY criado_em LIMIT 1`, [g.id])).rows[0];
  const base = { unidade: ref.unidade, supplier_id: ref.supplier_id, preco_custo: b.preco_custo || ref.preco_custo, preco_venda: b.preco_venda || ref.preco_venda };
  let local = null;
  if (b.location_id) { await getOwnedLocation(client, b.location_id, user.tenantId); assertLocationAccess(user, b.location_id, 'lançar estoque neste local'); local = b.location_id; }
  await client.query(`UPDATE produto_grades SET atributos = $2, atualizado_em = now() WHERE id = $1`, [g.id, JSON.stringify(atributos)]);
  const grade = { ...g, atributos };
  const criadas = [];
  for (const v of faltam) criadas.push(await criarVariacao(client, user, grade, base, { variacao: v, estoque_inicial: 0 }, local));
  await sincronizarSite(client, user.tenantId, g.id);
  return criadas;
}

// Renomear / mudar categoria (repete nas variacoes) e preco em lote. b: { nome, categoria_id, preco_custo, preco_venda }
async function editar(client, user, id, b) {
  const g = await gradeDaEmpresa(client, user.tenantId, id, true);
  const nome = b.nome !== undefined ? texto(b.nome, 120) : g.nome;
  if (nome.length < 3) throw new HttpError(400, 'nome da grade deve ter no mínimo 3 caracteres');
  let categoria = g.categoria_id;
  if (b.categoria_id !== undefined && b.categoria_id !== g.categoria_id) { await getOwned(client, 'categories', b.categoria_id, user.tenantId); categoria = b.categoria_id; }
  await client.query(`UPDATE produto_grades SET nome = $2, categoria_id = $3, atualizado_em = now() WHERE id = $1`, [g.id, nome, categoria]);
  const vars = (await client.query(`SELECT id, variacao, preco_custo, preco_venda FROM products WHERE grade_id = $1`, [g.id])).rows;
  const emLote = b.preco_venda !== undefined || b.preco_custo !== undefined;
  for (const v of vars) {
    const pr = emLote ? precos(b.preco_custo !== undefined ? b.preco_custo : v.preco_custo, b.preco_venda !== undefined ? b.preco_venda : v.preco_venda) : null;
    await client.query(
      `UPDATE products SET nome = $2, categoria_id = $3, preco_custo = COALESCE($4, preco_custo), preco_venda = COALESCE($5, preco_venda) WHERE id = $1`,
      [v.id, nomeVariacao(nome, g.atributos, v.variacao), categoria, pr ? pr.custo : null, pr ? pr.venda : null]
    );
  }
  await sincronizarSite(client, user.tenantId, g.id);
  return { antes: { nome: g.nome }, depois: { nome, preco_em_lote: emLote ? { custo: b.preco_custo, venda: b.preco_venda } : null } };
}

// ---------- conversao de produtos ja cadastrados ----------
// Os produtos continuam os mesmos (codigo, codigo de barras, preco, estoque, vendas e historico): so ganham a grade e a variacao.

// Produtos avulsos da empresa, prontos para entrar numa grade (travados ate o fim da transacao).
async function produtosAvulsos(client, tenantId, ids) {
  const { rows } = await client.query(
    `SELECT p.id, p.nome, p.unidade, p.categoria_id, p.grade_id,
            EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id) AS e_combo,
            EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id) AS tem_ficha
     FROM products p WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) FOR UPDATE OF p`,
    [tenantId, ids]
  );
  const porId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const p = porId.get(id);
    if (!p) throw new HttpError(404, 'produto não encontrado');
    if (p.grade_id) throw new HttpError(409, `"${p.nome}" já está em uma grade`);
    if (p.e_combo) throw new HttpError(400, `"${p.nome}" é um combo: combo não entra em grade`);
    if (p.tem_ficha) throw new HttpError(400, `"${p.nome}" tem ficha técnica (insumos): não entra em grade`);
    return p;
  });
}

// Variacao informada para um produto -> { Atributo: valor } com todos os atributos da grade.
function variacaoDoProduto(atributos, v, nomeProduto) {
  const r = {};
  for (const a of atributos) {
    const k = Object.keys(v || {}).find((x) => semAcento(x) === semAcento(a.nome));
    const valor = texto(k === undefined ? '' : v[k], 30);
    if (!valor) throw new HttpError(400, `informe ${a.nome} de "${nomeProduto}"`);
    // mesmo valor escrito de outro jeito (preta/Preta) vira o ja usado na grade
    r[a.nome] = a.valores.find((x) => semAcento(x) === semAcento(valor)) || valor;
  }
  return r;
}

// Fotos dos produtos no site viram as fotos de cada valor (ex.: a foto da camiseta preta vira a foto da cor Preta).
function fotosPorValor(atributoFoto, itens, site) {
  const r = {};
  if (!atributoFoto) return r;
  for (const it of itens) {
    const lp = site.get(it.id);
    const valor = it.variacao[atributoFoto];
    if (lp && lp.imagens && lp.imagens.length && !r[valor]) r[valor] = lp.imagens.slice(0, 8);
  }
  return r;
}
const atributoDeFoto = (atributos) => (atributos.find((a) => /^(cor|cores|estampa)$/.test(semAcento(a.nome))) || atributos[0]).nome;

// Agrupa produtos avulsos numa grade nova.
// b: { nome, categoria_id, atributos: [{ nome }], produtos: [{ product_id, variacao: { Cor: 'Preta', ... } }], renomear }
async function converterEmGrade(client, user, b) {
  const nome = texto(b.nome, 120);
  if (nome.length < 3) throw new HttpError(400, 'nome da grade deve ter no mínimo 3 caracteres');
  const lista = Array.isArray(b.produtos) ? b.produtos : [];
  if (lista.length < 2) throw new HttpError(400, 'escolha ao menos 2 produtos para agrupar');
  if (lista.length > MAX_VARIACOES) throw new HttpError(400, `no máximo ${MAX_VARIACOES} variações por grade`);
  const ids = lista.map((x) => x && x.product_id);
  if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new HttpError(404, 'produto não encontrado');
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'produto repetido na lista');
  const produtos = await produtosAvulsos(client, user.tenantId, ids);
  if (new Set(produtos.map((p) => p.unidade)).size > 1) throw new HttpError(400, 'os produtos de uma grade precisam ter a mesma unidade (UN, KG...)');
  // atributos: os nomes informados; os valores saem dos produtos, na ordem em que aparecem
  const nomes = normalizarAtributos((Array.isArray(b.atributos) ? b.atributos : []).map((a) => ({ nome: a && a.nome, valores: ['-'] }))).map((a) => ({ nome: a.nome, valores: [] }));
  const itens = produtos.map((p, i) => {
    const variacao = variacaoDoProduto(nomes, lista[i].variacao, p.nome);
    for (const a of nomes) if (!a.valores.includes(variacao[a.nome])) a.valores.push(variacao[a.nome]);
    return { ...p, variacao };
  });
  const atributos = normalizarAtributos(nomes);
  const vistas = new Map();
  for (const it of itens) {
    const k = chave(it.variacao);
    if (vistas.has(k)) throw new HttpError(400, `"${vistas.get(k)}" e "${it.nome}" ficaram com a mesma variação (${atributos.map((a) => it.variacao[a.nome]).join(' / ')})`);
    vistas.set(k, it.nome);
  }
  const categoria = b.categoria_id || itens[0].categoria_id;
  if (!categoria) throw new HttpError(400, 'categoria é obrigatória');
  await getOwned(client, 'categories', categoria, user.tenantId);
  const { rows } = await client.query(
    `INSERT INTO produto_grades (tenant_id, nome, categoria_id, atributos) VALUES ($1, $2, $3, $4) RETURNING *`,
    [user.tenantId, nome, categoria, JSON.stringify(atributos)]
  );
  const grade = rows[0];
  const renomear = b.renomear !== false;
  for (const it of itens) {
    await client.query(
      `UPDATE products SET grade_id = $2, variacao = $3, categoria_id = $4, nome = COALESCE($5, nome) WHERE id = $1`,
      [it.id, grade.id, JSON.stringify(it.variacao), categoria, renomear ? nomeVariacao(nome, atributos, it.variacao) : null]
    );
  }
  // Site: se algum produto ja estava na loja virtual, a grade entra configurada com os dados deles.
  const site = new Map((await client.query(`SELECT * FROM lv_produtos WHERE product_id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.product_id, r]));
  let publicada = false;
  if (site.size) {
    const lps = itens.map((it) => site.get(it.id)).filter(Boolean);
    const atributoFoto = atributoDeFoto(atributos);
    const porValor = fotosPorValor(atributoFoto, itens, site);
    const comMedida = lps.find((x) => x.peso_kg) || {};
    publicada = lps.some((x) => x.publicado);
    await client.query(
      `INSERT INTO lv_grades (grade_id, tenant_id, publicado, descricao, imagens, atributo_foto, fotos_por_valor, destaque, ordem, maior_idade, so_retirada,
                              peso_kg, altura_cm, largura_cm, comprimento_cm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [grade.id, user.tenantId, publicada, (lps.find((x) => x.descricao) || {}).descricao || '',
        // sem foto por valor, as fotos do primeiro produto com foto valem para a grade toda
        Object.keys(porValor).length ? [] : ((lps.find((x) => x.imagens && x.imagens.length) || {}).imagens || []),
        Object.keys(porValor).length ? atributoFoto : null, JSON.stringify(porValor), lps.some((x) => x.destaque), Math.min(...lps.map((x) => x.ordem || 0)),
        lps.some((x) => x.maior_idade), lps.some((x) => x.so_retirada), comMedida.peso_kg || null, comMedida.altura_cm || null, comMedida.largura_cm || null,
        comMedida.comprimento_cm || null]
    );
    await sincronizarSite(client, user.tenantId, grade.id);
  }
  return { grade, produtos: itens.map((it) => ({ id: it.id, antes: it.nome, variacao: it.variacao })), publicada };
}

// Inclui um produto avulso numa grade que ja existe (valor novo entra nos atributos). b: { product_id, variacao }
async function incluirProduto(client, user, id, b) {
  const g = await gradeDaEmpresa(client, user.tenantId, id, true);
  if (typeof b.product_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.product_id)) throw new HttpError(404, 'produto não encontrado');
  const [p] = await produtosAvulsos(client, user.tenantId, [b.product_id]);
  const ref = (await client.query(`SELECT unidade FROM products WHERE grade_id = $1 LIMIT 1`, [g.id])).rows[0];
  if (ref && ref.unidade !== p.unidade) throw new HttpError(400, `a grade é em ${ref.unidade} e o produto em ${p.unidade}`);
  const atributos = g.atributos.map((a) => ({ ...a, valores: [...a.valores] }));
  const variacao = variacaoDoProduto(atributos, b.variacao, p.nome);
  for (const a of atributos) if (!a.valores.includes(variacao[a.nome])) a.valores.push(variacao[a.nome]);
  normalizarAtributos(atributos);
  const existentes = (await client.query(`SELECT nome, variacao FROM products WHERE grade_id = $1`, [g.id])).rows;
  if (existentes.length >= MAX_VARIACOES) throw new HttpError(400, `a grade já tem ${MAX_VARIACOES} variações`);
  const igual = existentes.find((x) => chave(x.variacao) === chave(variacao));
  if (igual) throw new HttpError(409, `a variação ${atributos.map((a) => variacao[a.nome]).join(' / ')} já existe nesta grade ("${igual.nome}")`);
  await client.query(`UPDATE produto_grades SET atributos = $2, atualizado_em = now() WHERE id = $1`, [g.id, JSON.stringify(atributos)]);
  await client.query(
    `UPDATE products SET grade_id = $2, variacao = $3, categoria_id = $4, nome = COALESCE($5, nome) WHERE id = $1`,
    [p.id, g.id, JSON.stringify(variacao), g.categoria_id, b.renomear === false ? null : nomeVariacao(g.nome, atributos, variacao)]
  );
  // foto do produto no site vira a foto do valor, se o valor ainda nao tiver
  const lg = (await client.query(`SELECT atributo_foto, fotos_por_valor FROM lv_grades WHERE grade_id = $1`, [g.id])).rows[0];
  const lp = (await client.query(`SELECT imagens FROM lv_produtos WHERE product_id = $1`, [p.id])).rows[0];
  if (lg && lg.atributo_foto && lp && lp.imagens.length && !(lg.fotos_por_valor || {})[variacao[lg.atributo_foto]]) {
    await client.query(`UPDATE lv_grades SET fotos_por_valor = fotos_por_valor || $2::jsonb, atualizado_em = now() WHERE grade_id = $1`,
      [g.id, JSON.stringify({ [variacao[lg.atributo_foto]]: lp.imagens.slice(0, 8) })]);
  }
  await sincronizarSite(client, user.tenantId, g.id);
  return { produto: p.nome, variacao };
}

// Tira um produto da grade: volta a ser avulso (nome, estoque e historico ficam). Grade vazia e apagada.
async function retirarProduto(client, user, id, productId) {
  const g = await gradeDaEmpresa(client, user.tenantId, id, true);
  const { rows } = await client.query(`UPDATE products SET grade_id = NULL, variacao = NULL WHERE id = $1 AND grade_id = $2 AND tenant_id = $3 RETURNING nome`,
    [productId, g.id, user.tenantId]);
  if (!rows.length) throw new HttpError(404, 'produto não está nesta grade');
  const resto = (await client.query(`SELECT COUNT(*)::int AS n FROM products WHERE grade_id = $1`, [g.id])).rows[0].n;
  if (resto === 0) await client.query(`DELETE FROM produto_grades WHERE id = $1`, [g.id]);
  return { produto: rows[0].nome, grade_apagada: resto === 0 };
}

// Desfaz a grade: todas as variacoes voltam a ser produtos avulsos (no site, cada uma fica com as fotos que ja tinha).
async function desfazerGrade(client, user, id) {
  const g = await gradeDaEmpresa(client, user.tenantId, id, true);
  const { rows } = await client.query(`UPDATE products SET grade_id = NULL, variacao = NULL WHERE grade_id = $1 RETURNING id`, [g.id]);
  await client.query(`DELETE FROM produto_grades WHERE id = $1`, [g.id]);
  return { nome: g.nome, produtos: rows.length };
}

// Copia os dados da grade no site (lv_grades) para o produto de cada variacao (lv_produtos).
async function sincronizarSite(client, tenantId, gradeId) {
  const lg = (await client.query(`SELECT * FROM lv_grades WHERE grade_id = $1 AND tenant_id = $2`, [gradeId, tenantId])).rows[0];
  if (!lg) return;
  const vars = (await client.query(`SELECT id, preco_venda, variacao, ativo FROM products WHERE grade_id = $1`, [gradeId])).rows;
  for (const v of vars) {
    const valorFoto = lg.atributo_foto ? (v.variacao || {})[lg.atributo_foto] : null;
    const proprias = valorFoto && lg.fotos_por_valor && Array.isArray(lg.fotos_por_valor[valorFoto]) ? lg.fotos_por_valor[valorFoto] : [];
    const imagens = [...proprias, ...(lg.imagens || []).filter((x) => !proprias.includes(x))].slice(0, 8);
    const promo = lg.promo_pct ? n2(Number(v.preco_venda) * (1 - Number(lg.promo_pct) / 100)) : null;
    await client.query(
      `INSERT INTO lv_produtos (product_id, tenant_id, publicado, nome_site, descricao, imagens, preco_promocional, promo_inicio, promo_fim, destaque, ordem,
                                maior_idade, so_retirada, peso_kg, altura_cm, largura_cm, comprimento_cm, atualizado_em)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
       ON CONFLICT (product_id) DO UPDATE SET publicado = $3, nome_site = NULL, descricao = $4, imagens = $5, preco_promocional = $6, promo_inicio = $7, promo_fim = $8,
         destaque = $9, ordem = $10, maior_idade = $11, so_retirada = $12, peso_kg = $13, altura_cm = $14, largura_cm = $15, comprimento_cm = $16, atualizado_em = now()`,
      [v.id, tenantId, lg.publicado && v.ativo, lg.descricao, imagens, promo && promo > 0 ? promo : null, promo ? lg.promo_inicio : null, promo ? lg.promo_fim : null,
        lg.destaque, lg.ordem, lg.maior_idade, lg.so_retirada, lg.peso_kg, lg.altura_cm, lg.largura_cm, lg.comprimento_cm]
    );
  }
}

module.exports = {
  normalizarAtributos, combinacoes, criarGrade, detalhe, adicionarValores, editar, sincronizarSite, gradeDaEmpresa, gerarEan, digitoEan, nomeVariacao, MAX_ATRIBUTOS,
  converterEmGrade, incluirProduto, retirarProduto, desfazerGrade,
};
