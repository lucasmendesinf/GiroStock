// WhatsApp (modulo "whatsapp"): conexao do numero (cadastro incorporado da Meta), avisos do pedido, teste e historico.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const wa = require('../integracoes/whatsapp');

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

router.post('/whatsapp/teste', requireArea('Configuracoes'), async (req, res) => {
  res.json(await wa.enviarTeste(req.user, (req.body || {}).telefone));
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
