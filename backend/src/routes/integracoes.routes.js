// Integracoes de delivery (iFood e 99Food). Modulo "iFood e 99Food" (delivery_apps) obrigatorio.
// Conectar/desconectar: area Configuracoes. Pedidos (aceitar, vincular itens, cancelar, disputa): area Pedidos.
// No modo teste nada aqui funciona: o teste nunca fala com as plataformas de verdade.
// Os pedidos da 99Food chegam por webhook (routes/webhooks.routes.js), fora do login.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const { assertLocationAccess } = require('../utils/access');
const ifood = require('../integracoes/ifood/servico');
const api = require('../integracoes/ifood/api');
const api99 = require('../integracoes/food99/api');
const comum = require('../integracoes/comum');

const router = express.Router();
router.use('/integracoes', requireModulo('delivery_apps'), (req, res, next) => {
  if (req.user.modoTeste) return next(new HttpError(409, 'integrações de delivery não funcionam no modo teste'));
  next();
});
const db = pool.producao;
const configuracoes = requireArea('Configuracoes');
const pedidos = requireArea('Pedidos');

const STATUS_PUBLICO = 'id, location_id, plataforma, status, merchant_id, merchant_nome, aceite_automatico, codigo_vinculo, codigo_vinculo_expira_em, lojas_disponiveis, ultimo_polling_em, ultimo_erro, ultimo_erro_em, criado_em';

// ---------- conexoes por loja ----------
router.get('/integracoes', configuracoes, async (req, res) => {
  const { rows } = await db.query(`SELECT ${STATUS_PUBLICO} FROM integracoes_delivery WHERE tenant_id = $1 ORDER BY criado_em`, [req.user.tenantId]);
  res.json({ ifood_configurado: api.configurado(), food99_configurado: api99.configurado(), integracoes: rows });
});

router.post('/integracoes/:plataforma(ifood|99food)/conectar', configuracoes, async (req, res) => {
  const locationId = (req.body || {}).location_id;
  if (!isUuid(locationId)) throw new HttpError(400, 'escolha a loja');
  assertLocationAccess(req.user, locationId, `conectar o ${comum.NOME[req.params.plataforma]} nesta loja`);
  res.status(201).json(await comum.plataforma(req.params.plataforma).iniciarConexao(req.user, locationId));
});

// iFood: cola o codigo de autorizacao do Portal do Parceiro. 99Food: confere se a loja ja autorizou o app.
router.post('/integracoes/:id/concluir', configuracoes, async (req, res) => {
  const integ = await comum.integracao(req.params.id, req.user.tenantId);
  res.json(await comum.plataforma(integ.plataforma).concluirConexao(req.user, req.params.id, (req.body || {}).codigo));
});

router.post('/integracoes/:id/loja', configuracoes, async (req, res) => {
  res.json(await ifood.escolherLoja(req.user, req.params.id, String((req.body || {}).merchant_id || '')));
});

router.patch('/integracoes/:id', configuracoes, async (req, res) => {
  await comum.integracao(req.params.id, req.user.tenantId);
  const b = req.body || {};
  if (typeof b.aceite_automatico !== 'boolean') throw new HttpError(400, 'nada para alterar');
  await db.query(`UPDATE integracoes_delivery SET aceite_automatico = $2, atualizado_em = now() WHERE id = $1`, [req.params.id, b.aceite_automatico]);
  res.json({ ok: true });
});

router.delete('/integracoes/:id', configuracoes, async (req, res) => {
  const integ = await comum.integracao(req.params.id, req.user.tenantId);
  await comum.plataforma(integ.plataforma).desconectar(req.user, req.params.id);
  res.status(204).end();
});

// iFood: buscar pedidos agora (alem do automatico a cada 30 s). 99Food: testar a conexao (os pedidos chegam sozinhos).
router.post('/integracoes/:id/sincronizar', pedidos, async (req, res) => {
  const integ = await comum.integracao(req.params.id, req.user.tenantId);
  if (integ.status !== 'conectado') throw new HttpError(409, `o ${comum.NOME[integ.plataforma]} não está conectado nesta loja`);
  try {
    res.json(await comum.plataforma(integ.plataforma).sincronizar(integ));
  } catch (err) {
    if (err.corpo !== undefined && err.status !== undefined && !(err instanceof HttpError)) throw new HttpError(502, `${comum.NOME[integ.plataforma]}: ${err.message}`);
    throw err;
  }
});

// Disponibilidade no cardapio: so o iFood por enquanto (a da 99Food sera ligada na homologacao).
async function integracaoIfood(req) {
  const integ = await ifood.integracao(req.params.id, req.user.tenantId);
  if (integ.plataforma !== 'ifood') throw new HttpError(409, 'a disponibilidade automática no cardápio ainda é só do iFood');
  if (integ.status !== 'conectado') throw new HttpError(409, 'o iFood não está conectado nesta loja');
  return integ;
}

// ---------- disponibilidade no cardapio do iFood ----------
// O que esta a venda/pausado (calculado agora) e o ultimo status enviado. "enviar" manda tudo de novo agora.
router.get('/integracoes/:id/disponibilidade', configuracoes, async (req, res) => {
  const integ = await integracaoIfood(req);
  res.json(await ifood.listaDisponibilidade(integ));
});
router.post('/integracoes/:id/disponibilidade/enviar', configuracoes, async (req, res) => {
  const integ = await integracaoIfood(req);
  try {
    res.json(await ifood.atualizarDisponibilidade(integ, { forcar: !!(req.body || {}).tudo }));
  } catch (err) {
    if (err.status && err.status < 600 && err.corpo !== undefined) throw new HttpError(502, `o iFood não aceitou a atualização do cardápio: ${err.message}`);
    throw err;
  }
});

// ---------- pedidos das plataformas que precisam de atencao ----------
// Aguardando vinculo de itens ou com erro: a equipe vincula os itens (ou recusa na plataforma).
router.get('/integracoes/pendencias', pedidos, async (req, res) => {
  const { rows } = await db.query(
    `SELECT pe.id, pe.location_id, l.nome AS location_nome, pe.plataforma, pe.externo_id, pe.codigo_externo, pe.situacao, pe.status_externo,
            pe.erro, pe.payload, pe.criado_em
     FROM pedidos_externos pe JOIN locations l ON l.id = pe.location_id
     WHERE pe.tenant_id = $1 AND pe.situacao IN ('aguardando_vinculo', 'erro') AND COALESCE(pe.status_externo, '') <> 'CANCELLED'
     ORDER BY pe.criado_em`,
    [req.user.tenantId]
  );
  const lista = [];
  for (const r of rows) {
    const dados = comum.plataforma(r.plataforma).mapear(r.payload);
    const client = await db.connect();
    let produtos;
    try { produtos = await comum.produtosDosItens(client, req.user.tenantId, dados.itens, r.plataforma); } finally { client.release(); }
    lista.push({
      id: r.id, location_id: r.location_id, location_nome: r.location_nome, plataforma: r.plataforma, codigo_externo: r.codigo_externo,
      situacao: r.situacao, erro: r.erro, criado_em: r.criado_em, cliente_nome: dados.cliente_nome, tipo: dados.tipo,
      total: Number(dados.itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0).toFixed(2)),
      itens: dados.itens.map((i) => ({ chave: i.chave, nome: i.nome, codigo_externo: i.codigo_externo, quantidade: i.quantidade, preco_unitario: i.preco_unitario, observacao: i.observacao, product_id: produtos.get(i.chave) || null })),
    });
  }
  res.json(lista);
});

router.post('/integracoes/pedidos/:id/vincular', pedidos, async (req, res) => {
  const pe = await comum.pedidoExterno(req.user.tenantId, req.params.id);
  assertLocationAccess(req.user, pe.location_id, 'tratar pedidos desta loja');
  const r = await comum.vincular(req.user, pe, (req.body || {}).itens);
  res.json({ situacao: r.situacao, order_id: r.order_id || null, erro: r.erro || null, faltas_estoque: r.faltas_estoque || null });
});

router.post('/integracoes/pedidos/:id/aceitar', pedidos, async (req, res) => {
  const pe = await comum.pedidoExterno(req.user.tenantId, req.params.id);
  assertLocationAccess(req.user, pe.location_id, 'tratar pedidos desta loja');
  await comum.plataforma(pe.plataforma).aceitar(req.user, pe);
  res.json({ ok: true });
});

router.get('/integracoes/pedidos/:id/motivos-cancelamento', pedidos, async (req, res) => {
  const pe = await comum.pedidoExterno(req.user.tenantId, req.params.id);
  res.json(await comum.plataforma(pe.plataforma).motivos(req.user, pe));
});

router.post('/integracoes/pedidos/:id/cancelar', pedidos, async (req, res) => {
  const pe = await comum.pedidoExterno(req.user.tenantId, req.params.id);
  assertLocationAccess(req.user, pe.location_id, 'cancelar pedidos desta loja');
  const b = req.body || {};
  await comum.plataforma(pe.plataforma).solicitarCancelamento(req.user, pe, b.codigo, b.motivo);
  res.json({ ok: true, status_externo: (await comum.pedidoExterno(req.user.tenantId, pe.id)).status_externo });
});

// Cliente pediu para cancelar depois de confirmado (negociacao do iFood): aceitar ou recusar. A 99Food nao tem.
router.post('/integracoes/pedidos/:id/disputa', pedidos, async (req, res) => {
  const pe = await comum.pedidoExterno(req.user.tenantId, req.params.id);
  assertLocationAccess(req.user, pe.location_id, 'tratar pedidos desta loja');
  if (typeof (req.body || {}).aceitar !== 'boolean') throw new HttpError(400, 'informe se aceita ou recusa o cancelamento');
  await comum.plataforma(pe.plataforma).responderDisputa(req.user, pe, req.body.aceitar);
  res.json({ ok: true });
});

module.exports = router;
