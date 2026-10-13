const express = require('express');
const { requireArea } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { copiarProducao, status } = require('../services/copiaProducao');
const modoTeste = require('../services/modoTeste');
const pool = require('../db/pool');

// Painel Master (minimo): so o Modo teste por enquanto. Todas as rotas exigem a area Master.
const router = express.Router();
router.use('/master', requireArea('Master'));

// Estado do banco de teste: contagens por tabela (producao x teste), ultima copia, copia em andamento.
router.get('/master/modo-teste/status', async (req, res) => {
  res.json(await status());
});

// Copia TUDO da producao para o teste (substitui o banco de teste inteiro). So Master; confirmacao digitada.
router.post('/master/modo-teste/copiar-producao', async (req, res) => {
  const b = req.body || {};
  if (b.confirmacao !== 'COPIAR') throw new HttpError(400, 'digite COPIAR para confirmar');
  if (!req.user.master) throw new HttpError(403, 'somente o Master pode copiar a produção para o teste');
  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
  const r = await copiarProducao({ usuarioId: req.user.id, tenantId: req.user.tenantId, anonimizar: b.anonimizar !== false, motivo: 'copia manual (painel Master)' });
  await modoTeste.garantirUsuarioNoTeste(req.user.id);
  res.json(r);
});

module.exports = router;
