// WhatsApp (modulo "whatsapp"): conexao do numero (cadastro incorporado da Meta), avisos do pedido, teste e historico.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const wa = require('../integracoes/whatsapp');
const campanhas = require('../integracoes/whatsappCampanhas');

const router = express.Router();
router.use('/whatsapp', requireModulo('whatsapp'));

router.get('/whatsapp', requireArea('Configuracoes'), async (req, res) => {
  res.json(wa.publica(await wa.contaDa(pool, req.user.tenantId)));
});

router.post('/whatsapp/conectar', requireArea('Configuracoes'), async (req, res) => {
  const r = await wa.conectar(req.user, req.body || {});
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'whatsapp_conectar', recurso: 'whatsapp_contas', recursoId: null, detalhes: { numero: r.numero, nome: r.nome } });
  res.json(r);
});

router.post('/whatsapp/desconectar', requireArea('Configuracoes'), async (req, res) => {
  const r = await wa.desconectar(req.user);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'whatsapp_desconectar', recurso: 'whatsapp_contas', recursoId: null, detalhes: {} });
  res.json(r);
});

router.put('/whatsapp/avisos', requireArea('Configuracoes'), async (req, res) => {
  res.json(await wa.salvarAvisos(req.user, (req.body || {}).avisos));
});

router.post('/whatsapp/modelos/conferir', requireArea('Configuracoes'), async (req, res) => {
  await wa.conferirModelos(req.user.tenantId);
  res.json(wa.publica(await wa.contaDa(pool, req.user.tenantId)));
});

// Resposta automatica com o link do cardapio
router.get('/whatsapp/resposta', requireArea('Configuracoes'), async (req, res) => { res.json(await wa.respostaPublica(req.user.tenantId)); });
router.put('/whatsapp/resposta', requireArea('Configuracoes'), async (req, res) => {
  const r = await wa.salvarResposta(req.user, req.body || {});
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'whatsapp_resposta_auto', recurso: 'whatsapp_contas', recursoId: null, detalhes: { ativo: r.ativo, intervalo_horas: r.intervalo_horas } });
  res.json(r);
});

router.post('/whatsapp/teste', requireArea('Configuracoes'), async (req, res) => {
  res.json(await wa.enviarTeste(req.user, (req.body || {}).telefone));
});

// ---------- campanhas (etapa 2): area Clientes ----------
const clientes = requireArea('Clientes');
router.get('/whatsapp/campanhas', clientes, async (req, res) => {
  const c = await wa.contaDa(pool, req.user.tenantId);
  const conectado = !!(c && c.status === 'conectado');
  res.json({
    conectado, status: c ? c.status : 'desconectado', dias_entre_campanhas: campanhas.DIAS_ENTRE_CAMPANHAS,
    modelos: conectado ? await campanhas.modelos(req.user.tenantId) : [], campanhas: await campanhas.lista(req.user.tenantId),
  });
});
router.post('/whatsapp/campanhas/previa', clientes, async (req, res) => { res.json(await campanhas.previa(req.user, req.body || {})); });
router.post('/whatsapp/campanhas', clientes, async (req, res) => { res.status(201).json(await campanhas.criar(req.user, req.body || {})); });
// campanhas automaticas (cliente sumido, aniversariante)
router.get('/whatsapp/automacoes', clientes, async (req, res) => { res.json(await campanhas.listaAutomacoes(req.user.tenantId)); });
router.put('/whatsapp/automacoes/:tipo', clientes, async (req, res) => { res.json(await campanhas.salvarAutomacao(req.user, req.params.tipo, req.body || {})); });
// "Enviar hoje agora": roda a automacao ja (sem esperar o horario); manda so para quem ainda nao recebeu
router.post('/whatsapp/automacoes/:tipo/rodar', clientes, async (req, res) => {
  const feitas = await campanhas.rodarAutomacoes({ forcar: true, tenantId: req.user.tenantId, tipo: req.params.tipo });
  if (!feitas.length) throw new HttpError(409, 'ligue a automação antes de enviar');
  res.json(feitas[0]);
});
router.get('/whatsapp/campanhas/:id', clientes, async (req, res) => { res.json(await campanhas.detalhe(req.user.tenantId, req.params.id)); });
router.post('/whatsapp/campanhas/:id/cancelar', clientes, async (req, res) => { res.json(await campanhas.cancelar(req.user, req.params.id)); });

// ---------- so no modo teste (WhatsApp simulado): mensagens que "teriam saido" e resposta do cliente ----------
const testeAcoes = require('../integracoes/testeAcoes');
router.get('/whatsapp/teste/caixa', async (req, res) => {
  const a = req.user.areas || {};
  if (!a.Configuracoes && !a.Clientes) return res.status(403).json({ erro: 'sem acesso' });
  res.json(await testeAcoes.caixaWhatsapp(req.user));
});
router.post('/whatsapp/teste/responder', async (req, res) => {
  const a = req.user.areas || {};
  if (!a.Configuracoes && !a.Clientes) return res.status(403).json({ erro: 'sem acesso' });
  res.json(await testeAcoes.responderWhatsapp(req.user, req.body || {}));
});

// Historico: da empresa (Configuracoes) ou de um pedido (tela Pedidos).
router.get('/whatsapp/mensagens', async (req, res) => {
  const a = req.user.areas || {};
  const params = [req.user.tenantId];
  let where = 'm.tenant_id = $1 AND m.situacao <> \'ignorada\'';
  if (isUuid(req.query.order_id)) {
    if (!a.Pedidos && !a.Configuracoes) return res.status(403).json({ erro: 'sem acesso' });
    params.push(req.query.order_id);
    where += ` AND m.order_id = $${params.length}`;
  } else if (!a.Configuracoes) {
    return res.status(403).json({ erro: 'sem acesso' });
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.order_id, o.numero AS pedido_numero, m.evento, m.telefone, m.situacao, m.motivo, m.criado_em, m.atualizado_em
     FROM whatsapp_mensagens m LEFT JOIN orders o ON o.id = m.order_id WHERE ${where} ORDER BY m.criado_em DESC LIMIT 100`, params
  );
  res.json(rows);
});

module.exports = router;
