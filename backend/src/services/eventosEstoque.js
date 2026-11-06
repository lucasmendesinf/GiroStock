// Casa de shows e eventos, Fase 2: estoque do evento (o setor e um estoque temporario do evento).
// carga (deposito -> setor, pode ter reforco), perdas durante o evento (classificadas), fechamento com contagem
// (diferenca vira perda/sobra) e devolucao da sobra ao deposito. Todo movimento leva o evento (stock_movements.evento_id).
const { HttpError } = require('../utils/http');
const { getOwnedLocation, isUuid } = require('../utils/tenant');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { eventoDaEmpresa } = require('./eventos');

const TIPOS_PERDA = { quebra: 'Quebra', vencido: 'Vencido', cortesia: 'Cortesia', consumo_interno: 'Consumo interno', furto: 'Furto/desvio', outro: 'Outro' };
const n3 = (v) => Number(Number(v || 0).toFixed(3));
const n2 = (v) => Number(Number(v || 0).toFixed(2));

// Produtos com estoque proprio (sem ficha tecnica e sem combo), travados na ordem de id (mesma ordem da venda).
async function produtosSimples(client, tenantId, ids) {
  if (ids.some((id) => !isUuid(id))) throw new HttpError(404, 'produto não encontrado');
  const { rows } = await client.query(
    `SELECT p.id, p.nome, p.unidade, p.preco_custo, p.ativo,
            EXISTS(SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id) AS ficha,
            EXISTS(SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id) AS combo
     FROM products p WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) ORDER BY p.id FOR UPDATE OF p`,
    [tenantId, ids]
  );
  const porId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const p = porId.get(id);
    if (!p) throw new HttpError(404, 'produto não encontrado');
    if (p.ficha || p.combo) throw new HttpError(400, `"${p.nome}" não tem estoque próprio (${p.ficha ? 'ficha técnica' : 'combo'}): leve os produtos/insumos dele`);
  }
  return porId;
}

async function saldo(client, tenantId, productId, locationId, travar = true) {
  await client.query(
    `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`, [productId, locationId, tenantId]
  );
  const { rows } = await client.query(
    `SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND tenant_id = $3${travar ? ' FOR UPDATE' : ''}`, [productId, locationId, tenantId]
  );
  return Number(rows[0].saldo);
}

// Um movimento do evento: atualiza os saldos e grava o historico.
async function mover(client, user, e, p, { tipo, qtd, origem = null, destino = null, motivo, perdaTipo = null }) {
  if (origem) {
    const s = await saldo(client, user.tenantId, p.id, origem);
    if (s < qtd - 1e-9) throw new HttpError(400, `saldo insuficiente de "${p.nome}" (disponível: ${s}, solicitado: ${qtd})`);
    await client.query(`UPDATE stock_balances SET saldo = saldo - $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`, [qtd, p.id, origem, user.tenantId]);
  }
  if (destino) {
    await saldo(client, user.tenantId, p.id, destino);
    await client.query(`UPDATE stock_balances SET saldo = saldo + $1 WHERE product_id = $2 AND location_id = $3 AND tenant_id = $4`, [qtd, p.id, destino, user.tenantId]);
  }
  await client.query(
    `INSERT INTO stock_movements (tenant_id, product_id, tipo, quantidade, location_origem_id, location_destino_id, motivo, usuario_id, custo_unitario, evento_id, perda_tipo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [user.tenantId, p.id, tipo, qtd, origem, destino, motivo, user.id, p.preco_custo, e.id, perdaTipo]
  );
}

function quantidade(v, p) {
  const q = Number(v);
  if (!(q > 0)) throw new HttpError(400, `quantidade inválida de "${p.nome}"`);
  if (!isQuantidadeValidaParaUnidade(q, p.unidade)) throw new HttpError(400, `"${p.nome}" é controlado em ${p.unidade} e só aceita quantidade inteira`);
  return n3(q);
}

function assertEstoqueAberto(e) {
  if (e.estoque_fechado_em) throw new HttpError(409, 'o estoque deste evento já foi fechado (contagem feita)');
  if (e.status === 'cancelado') throw new HttpError(409, 'evento cancelado');
}

// Carga (ou reforco): itens [{ product_id, quantidade }] do deposito (ou origem_id) para o setor do evento.
async function carga(client, user, id, b) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  assertEstoqueAberto(e);
  if (e.status === 'encerrado') throw new HttpError(409, 'evento encerrado: faça a contagem do que sobrou');
  const origem = b.origem_id || e.deposito_id;
  if (!origem) throw new HttpError(400, 'informe o depósito de onde sai a carga (cadastro do evento)');
  if (origem === e.location_id) throw new HttpError(400, 'a origem da carga deve ser diferente do setor do evento');
  await getOwnedLocation(client, origem, user.tenantId);
  const itens = Array.isArray(b.itens) ? b.itens.filter((i) => i && i.product_id) : [];
  if (!itens.length) throw new HttpError(400, 'informe os produtos e as quantidades da carga');
  const ids = [...new Set(itens.map((i) => i.product_id))];
  if (ids.length !== itens.length) throw new HttpError(400, 'produto repetido na carga');
  const prods = await produtosSimples(client, user.tenantId, ids);
  const reforco = (await client.query(`SELECT 1 FROM stock_movements WHERE evento_id = $1 AND tipo = 'transferencia' AND location_destino_id = $2 LIMIT 1`, [e.id, e.location_id])).rows.length > 0;
  const linhas = itens.map((i) => ({ p: prods.get(i.product_id), qtd: quantidade(i.quantidade, prods.get(i.product_id)) })).sort((a, z) => (a.p.id < z.p.id ? -1 : 1));
  for (const l of linhas) {
    await mover(client, user, e, l.p, { tipo: 'transferencia', qtd: l.qtd, origem, destino: e.location_id, motivo: `${reforco ? 'Reforço' : 'Carga'} do evento "${e.nome}"` });
  }
  return { evento: e, reforco, itens: linhas.map((l) => ({ produto: l.p.nome, quantidade: l.qtd })) };
}

// Perda durante o evento (cortesia, quebra...): saida do setor.
async function perda(client, user, id, b) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  assertEstoqueAberto(e);
  if (e.status === 'agendado') throw new HttpError(409, 'abra o evento antes de lançar perdas');
  if (!TIPOS_PERDA[b.tipo]) throw new HttpError(400, 'tipo de perda inválido');
  const obs = String(b.observacao || '').trim().slice(0, 200);
  const p = (await produtosSimples(client, user.tenantId, [b.product_id])).get(b.product_id);
  const qtd = quantidade(b.quantidade, p);
  await mover(client, user, e, p, { tipo: 'saida', qtd, origem: e.location_id, motivo: `${TIPOS_PERDA[b.tipo]} no evento "${e.nome}"${obs ? `: ${obs}` : ''}`, perdaTipo: b.tipo });
  return { evento: e, produto: p.nome, quantidade: qtd, tipo: b.tipo };
}

// Situacao do estoque do evento, produto a produto: enviado, vendido, perdas, saldo no setor, contagem e devolucao.
async function estoque(db, tenantId, id) {
  const e = await eventoDaEmpresa(db, tenantId, id);
  const { rows } = await db.query(
    `WITH mov AS (
       SELECT product_id,
              SUM(quantidade) FILTER (WHERE tipo = 'transferencia' AND location_destino_id = $3) AS enviado,
              SUM(quantidade) FILTER (WHERE tipo = 'transferencia' AND location_origem_id = $3) AS devolvido,
              SUM(quantidade) FILTER (WHERE tipo = 'saida' AND perda_tipo IS NOT NULL AND perda_tipo <> 'diferenca_contagem') AS perdas,
              SUM(quantidade) FILTER (WHERE tipo = 'saida' AND perda_tipo = 'diferenca_contagem') AS faltou,
              SUM(quantidade) FILTER (WHERE tipo = 'entrada' AND location_destino_id = $3) AS sobrou
       FROM stock_movements WHERE tenant_id = $1 AND evento_id = $2 GROUP BY product_id
     ), vend AS (
       SELECT sm.product_id,
              SUM(CASE WHEN sm.tipo = 'saida' THEN sm.quantidade ELSE -sm.quantidade END) AS vendido
       FROM stock_movements sm JOIN sales s ON s.id = sm.sale_id
       WHERE sm.tenant_id = $1 AND s.evento_id = $2 AND sm.tipo IN ('saida', 'entrada')   -- entrada = estorno de venda cancelada
       GROUP BY sm.product_id
     ), ids AS (
       SELECT product_id FROM mov UNION SELECT product_id FROM vend
       UNION SELECT product_id FROM stock_balances WHERE tenant_id = $1 AND location_id = $3 AND saldo <> 0
       UNION SELECT product_id FROM evento_contagens WHERE evento_id = $2
     )
     SELECT p.id, p.nome, p.codigo_interno, p.unidade, p.preco_custo, p.preco_venda,
            COALESCE(m.enviado, 0) AS enviado, COALESCE(v.vendido, 0) AS vendido, COALESCE(m.perdas, 0) AS perdas,
            COALESCE(m.faltou, 0) AS faltou, COALESCE(m.sobrou, 0) AS sobrou, COALESCE(m.devolvido, 0) AS devolvido,
            COALESCE(sb.saldo, 0) AS saldo_setor, c.contado, c.saldo_sistema, c.diferenca, c.custo_unitario AS custo_contagem
     FROM ids JOIN products p ON p.id = ids.product_id
     LEFT JOIN mov m ON m.product_id = p.id LEFT JOIN vend v ON v.product_id = p.id
     LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.location_id = $3
     LEFT JOIN evento_contagens c ON c.evento_id = $2 AND c.product_id = p.id
     WHERE NOT EXISTS (SELECT 1 FROM product_ingredients pi WHERE pi.product_id = p.id) AND NOT EXISTS (SELECT 1 FROM combo_itens ci WHERE ci.combo_id = p.id)
     ORDER BY p.nome`,
    [tenantId, e.id, e.location_id]
  );
  const perdasPorTipo = (await db.query(
    `SELECT sm.perda_tipo AS tipo, SUM(sm.quantidade * COALESCE(sm.custo_unitario, p.preco_custo)) AS valor, SUM(sm.quantidade) AS quantidade
     FROM stock_movements sm JOIN products p ON p.id = sm.product_id
     WHERE sm.tenant_id = $1 AND sm.evento_id = $2 AND sm.tipo = 'saida' AND sm.perda_tipo IS NOT NULL GROUP BY sm.perda_tipo ORDER BY 2 DESC`,
    [tenantId, e.id]
  )).rows.map((r) => ({ tipo: r.tipo, nome: r.tipo === 'diferenca_contagem' ? 'Diferença na contagem' : TIPOS_PERDA[r.tipo], quantidade: n3(r.quantidade), valor: n2(r.valor) }));
  const itens = rows.map((r) => {
    const custo = Number(r.custo_contagem || r.preco_custo);
    const perdido = n3(Number(r.perdas) + Number(r.faltou) - Number(r.sobrou));
    return {
      product_id: r.id, nome: r.nome, codigo_interno: r.codigo_interno, unidade: r.unidade, custo_unitario: n2(custo),
      enviado: n3(r.enviado), vendido: n3(r.vendido), perdas: n3(r.perdas), saldo_setor: n3(r.saldo_setor),
      contado: r.contado === null ? null : n3(r.contado), saldo_sistema: r.saldo_sistema === null ? null : n3(r.saldo_sistema),
      diferenca: r.diferenca === null ? null : n3(r.diferenca), devolvido: n3(r.devolvido),
      quebra_total: perdido, valor_quebra: n2(perdido * custo),
    };
  });
  return {
    evento: { id: e.id, nome: e.nome, status: e.status, location_id: e.location_id, deposito_id: e.deposito_id, estoque_fechado_em: e.estoque_fechado_em },
    itens, perdas_por_tipo: perdasPorTipo,
    totais: {
      enviado_custo: n2(itens.reduce((s, i) => s + i.enviado * i.custo_unitario, 0)),
      vendido_custo: n2(itens.reduce((s, i) => s + i.vendido * i.custo_unitario, 0)),
      valor_quebra: n2(itens.reduce((s, i) => s + i.valor_quebra, 0)),
      devolvido_custo: n2(itens.reduce((s, i) => s + i.devolvido * i.custo_unitario, 0)),
    },
    tipos_perda: TIPOS_PERDA,
  };
}

// Fechamento depois do evento: itens [{ product_id, contado }] para todo produto com saldo no setor; devolver = sobra volta ao deposito.
async function fechar(client, user, id, b) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  assertEstoqueAberto(e);
  if (e.status !== 'encerrado') throw new HttpError(409, 'encerre o evento antes de fechar o estoque (contagem)');
  const devolver = b.devolver !== false;
  if (devolver && !e.deposito_id) throw new HttpError(400, 'o evento não tem depósito para receber a sobra: informe no cadastro ou feche sem devolver');
  const atual = await estoque(client, user.tenantId, id);
  const contagem = new Map((Array.isArray(b.itens) ? b.itens : []).filter((i) => i && i.product_id).map((i) => [i.product_id, i.contado]));
  const faltando = atual.itens.filter((i) => i.saldo_setor > 0 && !contagem.has(i.product_id));
  if (faltando.length) throw new HttpError(400, `informe a contagem de: ${faltando.slice(0, 5).map((i) => i.nome).join(', ')}${faltando.length > 5 ? '…' : ''}`);
  const ids = [...new Set([...contagem.keys()])];
  if (!ids.length) throw new HttpError(400, 'nada para contar: o setor não tem saldo deste evento');
  const prods = await produtosSimples(client, user.tenantId, ids);
  const resumo = [];
  for (const pid of [...ids].sort()) {
    const p = prods.get(pid);
    const contado = Number(contagem.get(pid));
    if (!(contado >= 0) || (contado > 0 && !isQuantidadeValidaParaUnidade(contado, p.unidade))) throw new HttpError(400, `contagem inválida de "${p.nome}"`);
    const sistema = await saldo(client, user.tenantId, pid, e.location_id);
    const dif = n3(contado - sistema);
    if (dif < 0) await mover(client, user, e, p, { tipo: 'saida', qtd: -dif, origem: e.location_id, motivo: `Diferença na contagem do evento "${e.nome}" (faltou)`, perdaTipo: 'diferenca_contagem' });
    if (dif > 0) await mover(client, user, e, p, { tipo: 'entrada', qtd: dif, destino: e.location_id, motivo: `Diferença na contagem do evento "${e.nome}" (sobrou)` });
    const devolvido = devolver && contado > 0 ? n3(contado) : 0;
    if (devolvido > 0) await mover(client, user, e, p, { tipo: 'transferencia', qtd: devolvido, origem: e.location_id, destino: e.deposito_id, motivo: `Devolução da sobra do evento "${e.nome}"` });
    await client.query(
      `INSERT INTO evento_contagens (evento_id, product_id, tenant_id, saldo_sistema, contado, diferenca, devolvido, custo_unitario) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.id, pid, user.tenantId, sistema, contado, dif, devolvido, p.preco_custo]
    );
    resumo.push({ produto: p.nome, sistema, contado, diferenca: dif, devolvido });
  }
  await client.query(`UPDATE eventos SET estoque_fechado_em = now(), estoque_fechado_por = $2, atualizado_em = now() WHERE id = $1`, [e.id, user.id]);
  return { evento: e, itens: resumo, devolver };
}

module.exports = { TIPOS_PERDA, carga, perda, estoque, fechar };
