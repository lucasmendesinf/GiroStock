// Parte comum das plataformas de delivery (iFood, 99Food): pedido externo guardado como veio -> pedido do GiroStock,
// vinculo de itens a produtos, cancelamento local. Roda SEMPRE no banco de producao (o modo teste nao recebe pedidos reais).
const pool = require('../db/pool');
const { criarPedido } = require('../services/pedidos');
const { dadosDaEmpresa, efetivos, aplicarRecursos } = require('../utils/limites');
const { MATRIX } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');

const db = () => pool.producao;
const NOME = { ifood: 'iFood', '99food': '99Food' };

// Cada plataforma: mapear(payload) -> dados do pedido; aceiteAutomatico(integ, pe). Carregado sob demanda (evita ciclo).
function plataforma(chave) {
  if (chave === 'ifood') return require('./ifood/servico');
  if (chave === '99food') return require('./food99/servico');
  throw new HttpError(400, `plataforma desconhecida: ${chave}`);
}

async function integracao(id, tenantId) {
  const { rows } = await db().query(`SELECT * FROM integracoes_delivery WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2)`, [id, tenantId || null]);
  if (rows.length === 0) throw new HttpError(404, 'integração não encontrada');
  return rows[0];
}

async function registrarErro(id, msg) {
  await db().query(`UPDATE integracoes_delivery SET ultimo_erro = $2, ultimo_erro_em = now() WHERE id = $1`, [id, String(msg).slice(0, 300)]);
}

// Modulo "iFood e 99Food" ligado para a empresa (empresa ativa).
async function moduloLigado(tenantId) {
  const emp = await dadosDaEmpresa(db(), tenantId);
  return !!(emp && emp.status === 'ativa' && efetivos(emp).recursos.delivery_apps);
}

// Usuario "sistema" da empresa (pedidos que chegam sozinhos): Administrador com os modulos da empresa.
async function usuarioSistema(tenantId) {
  const emp = await dadosDaEmpresa(db(), tenantId);
  const modulos = emp ? efetivos(emp).recursos : null;
  return { id: null, tenantId, perfil: 'Administrador', locationId: null, locationIds: [], modulos, areas: aplicarRecursos({ ...MATRIX.Administrador }, modulos) };
}

// Produto do item: vinculo lembrado -> codigo PDV igual ao codigo da plataforma, ao codigo interno ou ao codigo de barras -> EAN.
async function produtosDosItens(client, tenantId, itens, plataformaChave = 'ifood') {
  const r = new Map();
  const chaves = itens.map((i) => i.chave);
  const lembrados = await client.query(
    `SELECT ii.chave, ii.product_id FROM integracao_itens ii JOIN products p ON p.id = ii.product_id
     WHERE ii.tenant_id = $1 AND ii.plataforma = $2 AND ii.chave = ANY($3::text[]) AND p.ativo`,
    [tenantId, plataformaChave, chaves]
  );
  for (const l of lembrados.rows) r.set(l.chave, l.product_id);
  for (const i of itens) {
    if (r.has(i.chave)) continue;
    const codigos = [i.codigo_externo, i.ean].filter(Boolean);
    if (codigos.length === 0) continue;
    const maiusc = codigos.map((c) => String(c).toUpperCase());
    const p = await client.query(
      `SELECT id FROM products WHERE tenant_id = $1 AND ativo
         AND (upper(codigo_ifood) = ANY($3::text[]) OR upper(codigo_interno) = ANY($3::text[]) OR barcode = ANY($2::text[]))
       ORDER BY (upper(codigo_ifood) = ANY($3::text[])) DESC, (upper(codigo_interno) = ANY($3::text[])) DESC LIMIT 1`,
      [tenantId, codigos, maiusc]
    );
    if (p.rows[0]) r.set(i.chave, p.rows[0].id);
  }
  return r;
}

// Guarda o pedido como veio (idempotente: mesmo pedido = mesma linha). Devolve o id novo, ou null se ja existia.
async function guardarPedido(integ, dados, statusExterno, payload) {
  const { rows } = await db().query(
    `INSERT INTO pedidos_externos (tenant_id, location_id, integracao_id, plataforma, externo_id, codigo_externo, status_externo, entrega_pela_plataforma, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (plataforma, externo_id) DO NOTHING RETURNING id`,
    [integ.tenant_id, integ.location_id, integ.id, integ.plataforma, dados.externo_id, dados.codigo_externo, statusExterno, dados.entrega_pela_plataforma, JSON.stringify(payload)]
  );
  return rows.length ? rows[0].id : null;
}

// Pedido externo -> pedido do GiroStock (quando todos os itens tem produto). Devolve a linha atualizada.
async function importar(pedidoExternoId) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM pedidos_externos WHERE id = $1 FOR UPDATE`, [pedidoExternoId]);
    const pe = rows[0];
    if (!pe || pe.situacao !== 'aguardando_vinculo') { await client.query('ROLLBACK'); return pe; }
    const plat = plataforma(pe.plataforma);
    const dados = plat.mapear(pe.payload);
    const produtos = await produtosDosItens(client, pe.tenant_id, dados.itens, pe.plataforma);
    if (dados.itens.some((i) => !produtos.has(i.chave))) { await client.query('COMMIT'); return pe; }
    const user = await usuarioSistema(pe.tenant_id);
    // Complementos da plataforma com codigo PDV igual ao codigo de um complemento do GiroStock: baixam o insumo/produto dele.
    const codigos = [...new Set(dados.itens.flatMap((i) => i.opcoes.map((o) => o.codigo)).filter(Boolean))];
    const compPorCodigo = new Map(codigos.length === 0 ? [] : (await client.query(
      `SELECT c.id, c.codigo FROM complementos c JOIN grupos_complementos g ON g.id = c.grupo_id
       WHERE c.tenant_id = $1 AND c.codigo = ANY($2::text[]) AND c.ativo AND g.ativo`, [pe.tenant_id, codigos]
    )).rows.map((r) => [r.codigo, r.id]));
    let r;
    try {
      r = await criarPedido(client, user, {
        ...dados, location_id: pe.location_id, origem: pe.plataforma,
        itens: dados.itens.map((i) => ({
          product_id: produtos.get(i.chave), quantidade: i.quantidade, observacao: i.observacao, preco_unitario: i.preco_unitario,
          complementos: i.opcoes.filter((o) => o.codigo && compPorCodigo.has(o.codigo)).map((o) => ({ id: compPorCodigo.get(o.codigo), quantidade: Math.max(1, Math.round(o.quantidade)), preco: o.preco })),
        })),
      }, { externo: { externo_id: pe.externo_id, codigo_externo: pe.codigo_externo } });
    } catch (err) {
      await client.query('ROLLBACK');
      await db().query(`UPDATE pedidos_externos SET situacao = 'erro', erro = $2, atualizado_em = now() WHERE id = $1`, [pe.id, String(err.message).slice(0, 300)]);
      return { ...pe, situacao: 'erro', erro: err.message };
    }
    const atualizado = await client.query(
      `UPDATE pedidos_externos SET situacao = 'importado', order_id = $2, faltas_estoque = $3, erro = NULL, atualizado_em = now() WHERE id = $1 RETURNING *`,
      [pe.id, r.orderId, r.faltas.length ? r.faltas.join(' · ') : null]
    );
    await client.query('COMMIT');
    const linha = atualizado.rows[0];
    // Aceite automatico: so quando tudo ok (sem falta de estoque) e o pedido ainda nao foi cancelado.
    const integ = linha.integracao_id ? (await db().query(`SELECT * FROM integracoes_delivery WHERE id = $1`, [linha.integracao_id])).rows[0] : null;
    if (integ && integ.aceite_automatico && !linha.faltas_estoque && linha.status_externo !== 'CANCELLED' && !linha.confirmado) {
      try { await plat.confirmarPedido(integ, linha); } catch (err) { await registrarErro(integ.id, `aceite automático falhou: ${err.message}`); }
    }
    return linha;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ja encerrada */ }
    throw err;
  } finally {
    client.release();
  }
}

// Cancelado na plataforma: cancela o pedido do GiroStock (libera a reserva). Ja finalizado: fica o aviso.
async function cancelarLocal(pe, motivo) {
  await db().query(`UPDATE pedidos_externos SET situacao = CASE WHEN situacao = 'aguardando_vinculo' OR situacao = 'erro' THEN 'cancelado' ELSE situacao END, disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
  if (!pe.order_id) return;
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT id, numero, status, tenant_id FROM orders WHERE id = $1 FOR UPDATE`, [pe.order_id])).rows[0];
    if (o && !['cancelado', 'finalizado'].includes(o.status)) {
      await client.query(`UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $2, atualizado_em = now() WHERE id = $1`, [o.id, motivo]);
      await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', NULL)`, [o.id, o.status]);
      await logAudit(client, { tenantId: o.tenant_id, usuarioId: null, acao: 'cancelar_pedido', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, motivo, origem: pe.plataforma } });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function pedidoExternoDoPedido(tenantId, orderId) {
  const { rows } = await db().query(`SELECT * FROM pedidos_externos WHERE order_id = $1 AND tenant_id = $2`, [orderId, tenantId]);
  return rows[0] || null;
}
async function pedidoExterno(tenantId, id) {
  const { rows } = await db().query(`SELECT * FROM pedidos_externos WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) throw new HttpError(404, 'pedido da plataforma não encontrado');
  return rows[0];
}

// Vincula itens sem produto e tenta importar de novo. O vinculo fica lembrado para os proximos pedidos.
async function vincular(user, pe, vinculos) {
  if (pe.situacao !== 'aguardando_vinculo' && pe.situacao !== 'erro') throw new HttpError(409, 'este pedido não está aguardando vínculo');
  const dados = plataforma(pe.plataforma).mapear(pe.payload);
  for (const v of vinculos || []) {
    const item = dados.itens.find((i) => i.chave === v.chave);
    if (!item || !v.product_id) continue;
    const p = await db().query(`SELECT id FROM products WHERE id = $1 AND tenant_id = $2 AND ativo`, [v.product_id, user.tenantId]);
    if (p.rows.length === 0) throw new HttpError(400, 'produto inválido para o vínculo');
    await db().query(
      `INSERT INTO integracao_itens (tenant_id, plataforma, chave, nome_externo, product_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, plataforma, chave) DO UPDATE SET product_id = EXCLUDED.product_id, nome_externo = EXCLUDED.nome_externo`,
      [user.tenantId, pe.plataforma, v.chave, item.nome, v.product_id]
    );
  }
  if (pe.situacao === 'erro') await db().query(`UPDATE pedidos_externos SET situacao = 'aguardando_vinculo', erro = NULL WHERE id = $1`, [pe.id]);
  const r = await importar(pe.id);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: `${pe.plataforma}_vincular_itens`, recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { itens: (vinculos || []).length, situacao: r.situacao } });
  return r;
}

module.exports = {
  db, NOME, plataforma, integracao, registrarErro, moduloLigado, usuarioSistema, produtosDosItens, guardarPedido, importar, cancelarLocal,
  pedidoExternoDoPedido, pedidoExterno, vincular,
};
