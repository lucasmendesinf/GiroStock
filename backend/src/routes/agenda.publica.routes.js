// Agenda publica de eventos (sem login): ?chave=ag_... (ou cabecalho x-agenda-chave). So eventos marcados "Divulgar no site",
// agendados ou em andamento, e o pop-up do dia. Lida pelo site do cliente (ex.: PHP no servidor do site da J&A).
const express = require('express');
const pool = require('../db/pool');
const { isUuid } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const agenda = require('../services/agenda');

const router = express.Router();
const baseUrl = (req) => (process.env.URL_PUBLICA || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

router.use(async (req, res, next) => {
  // Lida por sites de qualquer endereco (fetch do navegador ou do servidor do site).
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'public, max-age=60');
  req.agenda = await agenda.empresaDaChave(pool, req.get('x-agenda-chave') || req.query.chave);
  next();
});

router.get('/eventos', async (req, res) => {
  const base = baseUrl(req);
  res.json({
    empresa: req.agenda.empresa,
    eventos: await agenda.eventosPublicos(pool, req.agenda.tenantId, base, req.query.limite),
    popup: await agenda.popupDoDia(pool, req.agenda.tenantId, base),
  });
});

router.get('/popup', async (req, res) => {
  res.json({ popup: await agenda.popupDoDia(pool, req.agenda.tenantId, baseUrl(req)) });
});

router.get('/eventos/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'evento não encontrado');
  res.json(await agenda.eventoPublico(pool, req.agenda.tenantId, baseUrl(req), req.params.id));
});

module.exports = router;
