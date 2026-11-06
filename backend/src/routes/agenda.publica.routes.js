// Agenda publica de eventos (sem login): ?chave=ag_... (ou cabecalho x-agenda-chave). So eventos marcados "Divulgar no site",
// agendados ou em andamento. Usada pelo widget /agenda.js e por sites com integracao propria (ex.: PHP no servidor do site).
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
  res.json({ empresa: req.agenda.empresa, eventos: await agenda.eventosPublicos(pool, req.agenda.tenantId, baseUrl(req), req.query.limite) });
});

router.get('/eventos/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'evento não encontrado');
  res.json(await agenda.eventoPublico(pool, req.agenda.tenantId, baseUrl(req), req.params.id));
});

module.exports = router;
