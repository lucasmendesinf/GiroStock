// Webhooks das plataformas de delivery (sem login: a autenticidade vem da assinatura).
// Montado ANTES do express.json: a assinatura da 99Food e calculada sobre o corpo bruto.
const express = require('express');
const food99 = require('../integracoes/food99/servico');
const lojaVirtual = require('../services/lojaVirtual');
const monitoramento = require('../services/monitoramento');

const router = express.Router();

// 99Food: um evento por POST. Responder { errno: 0 } em ate 6 s; qualquer outra resposta faz a 99Food reenviar.
router.post('/99food', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  try {
    const r = await food99.receberWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), req.get('didi-header-sign'));
    res.json({ errno: 0, errmsg: r.motivo || 'ok' });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) { console.error(err); monitoramento.registrarErro(req, status, err); }
    res.status(status).json({ errno: status, errmsg: status >= 500 ? 'erro interno' : err.message });
  }
});

// Mercado Pago (loja virtual): aviso de pagamento. A situacao e sempre conferida na API do Mercado Pago com o token do
// lojista; com o segredo do webhook configurado, a assinatura (x-signature) tambem e exigida. Responder 2xx para
// nao haver reenvio (inclusive quando o aviso nao e de um pagamento nosso).
router.post('/mercadopago/:lojaId', express.json({ limit: '200kb' }), async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.lojaId)) return res.status(200).json({ ok: true });
    const r = await lojaVirtual.receberAvisoMp(req.params.lojaId, req.body || {}, req.query || {}, {
      'x-signature': req.get('x-signature'), 'x-request-id': req.get('x-request-id'),
    });
    res.status(200).json(r);
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) { console.error(err); monitoramento.registrarErro(req, status, err); }
    res.status(status).json({ erro: status >= 500 ? 'erro interno' : err.message });
  }
});

module.exports = router;
