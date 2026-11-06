// Casa de shows e eventos (modulo "eventos"). Fase 1: cadastro, agenda, abrir/encerrar e as vendas do evento.
// O evento acontece num setor (location) com os PDVs dele. Enquanto o evento esta aberto, registrarVenda (services/vendas.js)
// marca com o evento toda venda daquele setor: PDV, fechamento de comanda de pista e pedido finalizado.
const { HttpError } = require('../utils/http');
const { getOwnedLocation } = require('../utils/tenant');
const { FUSO } = require('../utils/query');

const STATUS = ['agendado', 'aberto', 'encerrado', 'cancelado'];
const n2 = (v) => Number(Number(v || 0).toFixed(2));
const texto = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/; // hora local da empresa (sem fuso)

// "2026-11-20T21:00" (horario de Brasilia) ou ISO com fuso -> texto que o Postgres le como timestamptz.
async function dataHora(db, v, nome, { nulo = false } = {}) {
  if ((v === undefined || v === null || v === '') && nulo) return null;
  const s = String(v || '');
  if (DATA_HORA.test(s)) return (await db.query(`SELECT ($1::timestamp AT TIME ZONE '${FUSO}') AS t`, [s])).rows[0].t;
  const d = new Date(s);
  if (!s || Number.isNaN(d.getTime())) throw new HttpError(400, `${nome}: data e hora inválidas`);
  return d;
}

function linkOpcional(v) {
  const s = texto(v, 500);
  if (!s) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new HttpError(400, 'link do ingresso deve começar com http:// ou https://');
  return s;
}

function precoOpcional(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!(n >= 0)) throw new HttpError(400, 'preço do ingresso inválido');
  return n2(n);
}

async function eventoDaEmpresa(db, tenantId, id, travar = false) {
  const { rows } = await db.query(`SELECT * FROM eventos WHERE id = $1 AND tenant_id = $2${travar ? ' FOR UPDATE' : ''}`, [id, tenantId]);
  if (!rows.length) throw new HttpError(404, 'evento não encontrado');
  return rows[0];
}

// Campos do cadastro (criar e editar). atual: o evento ja gravado (na edicao).
async function campos(db, user, b, atual = null) {
  const v = (k) => (b[k] === undefined && atual ? atual[k] : b[k]);
  const nome = texto(v('nome'), 120);
  if (nome.length < 3) throw new HttpError(400, 'nome do evento deve ter no mínimo 3 caracteres');
  const inicio = b.inicio === undefined && atual ? atual.inicio : await dataHora(db, b.inicio, 'início');
  const fim = b.fim === undefined && atual ? atual.fim : await dataHora(db, b.fim, 'fim', { nulo: true });
  if (fim && new Date(fim) <= new Date(inicio)) throw new HttpError(400, 'o fim do evento deve ser depois do início');
  const locationId = v('location_id');
  if (!locationId) throw new HttpError(400, 'escolha o setor do evento (local do estoque e dos PDVs)');
  const local = await getOwnedLocation(db, locationId, user.tenantId);
  if (local.ativo === false) throw new HttpError(400, 'o setor escolhido está inativo');
  const depositoId = v('deposito_id') || null;
  if (depositoId) {
    if (depositoId === locationId) throw new HttpError(400, 'o depósito deve ser diferente do setor do evento');
    await getOwnedLocation(db, depositoId, user.tenantId);
  }
  let imagemId = b.imagem_id === undefined && atual ? atual.imagem_id : b.imagem_id || null;
  if (imagemId && b.imagem_id !== undefined) {
    const ok = (await db.query(`SELECT 1 FROM lv_imagens WHERE id = $1 AND tenant_id = $2`, [imagemId, user.tenantId])).rows.length;
    if (!ok) throw new HttpError(400, 'foto do evento não encontrada');
  }
  return {
    imagem_id: imagemId, nome, descricao: texto(v('descricao'), 4000), atracoes: texto(v('atracoes'), 1000), inicio, fim, location_id: locationId, deposito_id: depositoId,
    preco_ingresso: b.preco_ingresso === undefined && atual ? atual.preco_ingresso : precoOpcional(b.preco_ingresso),
    link_ingresso: b.link_ingresso === undefined && atual ? atual.link_ingresso : linkOpcional(b.link_ingresso),
    publicado_site: !!v('publicado_site'),
  };
}

async function criar(client, user, b) {
  const c = await campos(client, user, b);
  const { rows } = await client.query(
    `INSERT INTO eventos (tenant_id, nome, descricao, atracoes, inicio, fim, location_id, deposito_id, preco_ingresso, link_ingresso, publicado_site, imagem_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [user.tenantId, c.nome, c.descricao, c.atracoes, c.inicio, c.fim, c.location_id, c.deposito_id, c.preco_ingresso, c.link_ingresso, c.publicado_site, c.imagem_id]
  );
  return rows[0];
}

// Agendado: tudo. Aberto: tudo menos o setor (as vendas ja estao caindo nele). Encerrado: so textos do site. Cancelado: nada.
async function editar(client, user, id, b) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  if (e.status === 'cancelado') throw new HttpError(409, 'evento cancelado não pode ser alterado');
  if (e.status !== 'agendado' && b.location_id !== undefined && b.location_id !== e.location_id) {
    throw new HttpError(409, 'o setor só pode mudar enquanto o evento está agendado');
  }
  if (e.status === 'encerrado' && ['nome', 'inicio', 'fim', 'deposito_id'].some((k) => b[k] !== undefined && String(b[k]) !== String(e[k]))) {
    throw new HttpError(409, 'evento encerrado: só a descrição, as atrações e a divulgação podem mudar');
  }
  const c = await campos(client, user, b, e);
  const { rows } = await client.query(
    `UPDATE eventos SET nome = $2, descricao = $3, atracoes = $4, inicio = $5, fim = $6, location_id = $7, deposito_id = $8, preco_ingresso = $9,
            link_ingresso = $10, publicado_site = $11, imagem_id = $12, atualizado_em = now() WHERE id = $1 RETURNING *`,
    [e.id, c.nome, c.descricao, c.atracoes, c.inicio, c.fim, c.location_id, c.deposito_id, c.preco_ingresso, c.link_ingresso, c.publicado_site, c.imagem_id]
  );
  return { antes: e, depois: rows[0] };
}

async function abrir(client, user, id) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  if (e.status !== 'agendado') throw new HttpError(409, e.status === 'aberto' ? 'o evento já está aberto' : `evento ${e.status} não pode ser aberto`);
  const outro = (await client.query(`SELECT nome FROM eventos WHERE tenant_id = $1 AND status = 'aberto'`, [user.tenantId])).rows[0];
  if (outro) throw new HttpError(409, `já há um evento aberto ("${outro.nome}"): encerre-o antes de abrir outro`);
  const local = await getOwnedLocation(client, e.location_id, user.tenantId);
  if (local.ativo === false) throw new HttpError(400, 'o setor do evento está inativo');
  const { rows } = await client.query(
    `UPDATE eventos SET status = 'aberto', aberto_em = now(), aberto_por = $2, atualizado_em = now() WHERE id = $1 RETURNING *`, [e.id, user.id]
  );
  return rows[0];
}

// Pendencias do setor que impedem encerrar: venda depois do encerramento ficaria fora do evento.
async function pendencias(db, tenantId, locationId) {
  const comandas = Number((await db.query(
    `SELECT COUNT(*) AS n FROM comandas WHERE tenant_id = $1 AND location_id = $2 AND status IN ('aberta', 'fechamento_solicitado')`, [tenantId, locationId]
  )).rows[0].n);
  const pedidos = Number((await db.query(
    `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = $1 AND location_id = $2 AND comanda_id IS NULL AND sale_id IS NULL
       AND status NOT IN ('finalizado', 'cancelado')`, [tenantId, locationId]
  )).rows[0].n);
  return { comandas, pedidos };
}

async function encerrar(client, user, id) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  if (e.status !== 'aberto') throw new HttpError(409, 'só um evento aberto pode ser encerrado');
  const p = await pendencias(client, user.tenantId, e.location_id);
  if (p.comandas || p.pedidos) {
    const partes = [p.comandas && `${p.comandas} comanda(s) aberta(s)`, p.pedidos && `${p.pedidos} pedido(s) em aberto`].filter(Boolean).join(' e ');
    throw new HttpError(409, `ainda há ${partes} no setor do evento: feche ou cancele antes de encerrar`);
  }
  const { rows } = await client.query(
    `UPDATE eventos SET status = 'encerrado', encerrado_em = now(), encerrado_por = $2, atualizado_em = now() WHERE id = $1 RETURNING *`, [e.id, user.id]
  );
  return rows[0];
}

async function cancelar(client, user, id, motivo) {
  const e = await eventoDaEmpresa(client, user.tenantId, id, true);
  if (e.status !== 'agendado') throw new HttpError(409, 'só um evento agendado (que ainda não abriu) pode ser cancelado');
  const m = texto(motivo, 300);
  if (m.length < 3) throw new HttpError(400, 'informe o motivo do cancelamento');
  const { rows } = await client.query(
    `UPDATE eventos SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $2, publicado_site = false, atualizado_em = now()
     WHERE id = $1 RETURNING *`, [e.id, m]
  );
  return rows[0];
}

// Evento aberto no setor (para marcar a venda).
async function abertoNoLocal(db, tenantId, locationId) {
  const { rows } = await db.query(`SELECT id, nome FROM eventos WHERE tenant_id = $1 AND location_id = $2 AND status = 'aberto'`, [tenantId, locationId]);
  return rows[0] || null;
}

// Numeros do evento: vendas concluidas, por operador, por PDV e por forma de pagamento.
async function resumo(db, tenantId, eventoId) {
  const tot = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'concluida')::int AS vendas, COALESCE(SUM(total) FILTER (WHERE status = 'concluida'), 0) AS faturamento,
            COUNT(*) FILTER (WHERE status = 'cancelada')::int AS canceladas, COALESCE(SUM(total) FILTER (WHERE status = 'cancelada'), 0) AS valor_cancelado,
            MIN(criado_em) FILTER (WHERE status = 'concluida') AS primeira, MAX(criado_em) FILTER (WHERE status = 'concluida') AS ultima
     FROM sales WHERE tenant_id = $1 AND evento_id = $2`, [tenantId, eventoId]
  )).rows[0];
  const operadores = (await db.query(
    `SELECT u.id, u.nome, COUNT(*)::int AS vendas, SUM(s.total) AS total
     FROM sales s JOIN users u ON u.id = s.operador_id
     WHERE s.tenant_id = $1 AND s.evento_id = $2 AND s.status = 'concluida' GROUP BY u.id, u.nome ORDER BY SUM(s.total) DESC`, [tenantId, eventoId]
  )).rows;
  const pdvs = (await db.query(
    `SELECT t.id, COALESCE(t.nome, 'Sem PDV') AS nome, COUNT(*)::int AS vendas, SUM(s.total) AS total
     FROM sales s LEFT JOIN terminals t ON t.id = s.terminal_id
     WHERE s.tenant_id = $1 AND s.evento_id = $2 AND s.status = 'concluida' GROUP BY t.id, t.nome ORDER BY SUM(s.total) DESC`, [tenantId, eventoId]
  )).rows;
  const formas = (await db.query(
    `SELECT vp.forma::text AS forma, SUM(vp.valor) AS total
     FROM sales s JOIN v_sale_pagamentos vp ON vp.sale_id = s.id
     WHERE s.tenant_id = $1 AND s.evento_id = $2 AND s.status = 'concluida' GROUP BY vp.forma ORDER BY SUM(vp.valor) DESC`, [tenantId, eventoId]
  )).rows;
  const vendas = tot.vendas;
  const faturamento = n2(tot.faturamento);
  return {
    vendas, faturamento, ticket_medio: vendas ? n2(faturamento / vendas) : 0, canceladas: tot.canceladas, valor_cancelado: n2(tot.valor_cancelado),
    primeira_venda: tot.primeira, ultima_venda: tot.ultima,
    por_operador: operadores.map((r) => ({ ...r, total: n2(r.total) })),
    por_pdv: pdvs.map((r) => ({ ...r, total: n2(r.total) })),
    por_forma: formas.map((r) => ({ ...r, total: n2(r.total) })),
  };
}

module.exports = { STATUS, eventoDaEmpresa, criar, editar, abrir, encerrar, cancelar, pendencias, abertoNoLocal, resumo };
