// Casa de shows e eventos (modulo "eventos", area Eventos): agenda, cadastro, abrir/encerrar/cancelar e o resumo de vendas.
// GET /evento-em-andamento fica fora da area Eventos: o PDV e a tela de Comandas mostram a faixa do evento aberto.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const { filtroLocais, assertLocationAccess } = require('../utils/access');
const { HttpError } = require('../utils/http');
const { FUSO } = require('../utils/query');
const eventos = require('../services/eventos');
const estoqueEv = require('../services/eventosEstoque');

const router = express.Router();
const DATA = /^\d{4}-\d{2}-\d{2}$/;

async function emTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
const idValido = (id) => { if (!isUuid(id)) throw new HttpError(404, 'evento não encontrado'); return id; };

const SELECT_EVENTO = `
  SELECT e.*, l.nome AS location_nome, d.nome AS deposito_nome, ua.nome AS aberto_por_nome, ue.nome AS encerrado_por_nome,
         (SELECT COUNT(*) FROM sales s WHERE s.evento_id = e.id AND s.status = 'concluida')::int AS vendas,
         (SELECT COALESCE(SUM(s.total), 0) FROM sales s WHERE s.evento_id = e.id AND s.status = 'concluida') AS faturamento
  FROM eventos e JOIN locations l ON l.id = e.location_id LEFT JOIN locations d ON d.id = e.deposito_id
  LEFT JOIN users ua ON ua.id = e.aberto_por LEFT JOIN users ue ON ue.id = e.encerrado_por`;
const saida = (r) => ({ ...r, popup_inicio: eventos.diaTexto(r.popup_inicio), popup_fim: eventos.diaTexto(r.popup_fim), imagem_url: r.imagem_id ? `/api/loja/v1/imagens/${r.imagem_id}` : null, faturamento: Number(Number(r.faturamento || 0).toFixed(2)), preco_ingresso: r.preco_ingresso === null ? null : Number(r.preco_ingresso) });

async function eventoCompleto(tenantId, id) {
  const { rows } = await pool.query(`${SELECT_EVENTO} WHERE e.id = $1 AND e.tenant_id = $2`, [id, tenantId]);
  if (!rows.length) throw new HttpError(404, 'evento não encontrado');
  const e = saida(rows[0]);
  return { ...e, resumo: await eventos.resumo(pool, tenantId, id), pendencias: e.status === 'aberto' ? await eventos.pendencias(pool, tenantId, e.location_id) : null };
}

// Faixa do PDV/Comandas: evento aberto no setor (ou em qualquer setor que o usuario acessa).
router.get('/evento-em-andamento', requireModulo('eventos'), async (req, res) => {
  const locais = filtroLocais(req.user, isUuid(req.query.location_id) ? req.query.location_id : null);
  const { rows } = await pool.query(
    `SELECT e.id, e.nome, e.inicio, e.fim, e.aberto_em, e.location_id, l.nome AS location_nome
     FROM eventos e JOIN locations l ON l.id = e.location_id
     WHERE e.tenant_id = $1 AND e.status = 'aberto' AND ($2::uuid[] IS NULL OR e.location_id = ANY($2::uuid[]))`,
    [req.user.tenantId, locais]
  );
  res.json(rows[0] || null);
});

router.use('/eventos', requireModulo('eventos'), requireArea('Eventos'));
router.use('/eventos-imagens', requireModulo('eventos'), requireArea('Eventos'));

// Foto do evento (JPG, PNG ou WebP ate 2 MB; a tela ja reduz). Mesmo armazenamento das fotos da loja virtual.
router.post('/eventos-imagens', async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) throw new HttpError(400, 'envie a imagem (JPG, PNG ou WebP)');
  if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, 'imagem grande demais (máximo 2 MB)');
  const mime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.slice(1, 4).toString('ascii') === 'PNG' ? 'image/png'
    : buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw new HttpError(400, 'formato não suportado: use JPG, PNG ou WebP');
  const { rows } = await pool.query(`INSERT INTO lv_imagens (tenant_id, mime, dados, tamanho) VALUES ($1, $2, $3, $4) RETURNING id`, [req.user.tenantId, mime, buf, buf.length]);
  res.status(201).json({ id: rows[0].id, url: `/api/loja/v1/imagens/${rows[0].id}` });
});

// Agenda: ?status=agendado,aberto & de=AAAA-MM-DD & ate=AAAA-MM-DD (dias no horario de Brasilia)
router.get('/eventos', async (req, res) => {
  const params = [req.user.tenantId];
  let where = 'e.tenant_id = $1';
  const status = String(req.query.status || '').split(',').filter((s) => eventos.STATUS.includes(s));
  if (status.length) { params.push(status); where += ` AND e.status = ANY($${params.length}::text[])`; }
  for (const [k, op] of [['de', '>='], ['ate', '<']]) {
    if (!req.query[k]) continue;
    if (!DATA.test(req.query[k])) throw new HttpError(400, 'período inválido');
    params.push(req.query[k]);
    where += ` AND e.inicio ${op} ((($${params.length}::date${k === 'ate' ? ' + 1' : ''})::timestamp) AT TIME ZONE '${FUSO}')`;
  }
  const locais = filtroLocais(req.user);
  if (locais) { params.push(locais); where += ` AND e.location_id = ANY($${params.length}::uuid[])`; }
  const { rows } = await pool.query(`${SELECT_EVENTO} WHERE ${where} ORDER BY e.inicio`, params);
  res.json(rows.map(saida));
});

router.get('/eventos/:id', async (req, res) => {
  res.json(await eventoCompleto(req.user.tenantId, idValido(req.params.id)));
});

router.post('/eventos', async (req, res) => {
  const e = await emTransacao(async (client) => {
    if (req.body && req.body.location_id) assertLocationAccess(req.user, req.body.location_id, 'criar eventos neste setor');
    const ev = await eventos.criar(client, req.user, req.body || {});
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_evento', recurso: 'eventos', recursoId: ev.id, detalhes: { nome: ev.nome, inicio: ev.inicio } });
    return ev;
  });
  res.status(201).json(await eventoCompleto(req.user.tenantId, e.id));
});

router.put('/eventos/:id', async (req, res) => {
  const id = idValido(req.params.id);
  await emTransacao(async (client) => {
    const d = await eventos.editar(client, req.user, id, req.body || {});
    assertLocationAccess(req.user, d.depois.location_id, 'alterar eventos deste setor');
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'editar_evento', recurso: 'eventos', recursoId: id, detalhes: { nome: d.depois.nome } });
  });
  res.json(await eventoCompleto(req.user.tenantId, id));
});

for (const [rota, fn, acao] of [['abrir', 'abrir', 'abrir_evento'], ['encerrar', 'encerrar', 'encerrar_evento'], ['cancelar', 'cancelar', 'cancelar_evento']]) {
  router.post(`/eventos/:id/${rota}`, async (req, res) => {
    const id = idValido(req.params.id);
    await emTransacao(async (client) => {
      const atual = await eventos.eventoDaEmpresa(client, req.user.tenantId, id);
      assertLocationAccess(req.user, atual.location_id, `${rota} eventos deste setor`);
      const e = await eventos[fn](client, req.user, id, req.body && req.body.motivo);
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao, recurso: 'eventos', recursoId: id, detalhes: { nome: e.nome, ...(rota === 'cancelar' ? { motivo: e.motivo_cancelamento } : {}) } });
    });
    res.json(await eventoCompleto(req.user.tenantId, id));
  });
}

// ---------- estoque do evento (Fase 2) ----------
router.get('/eventos/:id/estoque', async (req, res) => {
  res.json(await estoqueEv.estoque(pool, req.user.tenantId, idValido(req.params.id)));
});

for (const [rota, fn, acao] of [['carga', 'carga', 'evento_carga'], ['perdas', 'perda', 'evento_perda'], ['fechar-estoque', 'fechar', 'evento_fechar_estoque']]) {
  router.post(`/eventos/:id/${rota}`, async (req, res) => {
    const id = idValido(req.params.id);
    await emTransacao(async (client) => {
      const atual = await eventos.eventoDaEmpresa(client, req.user.tenantId, id);
      assertLocationAccess(req.user, atual.location_id, 'mexer no estoque deste evento');
      const r = await estoqueEv[fn](client, req.user, id, req.body || {});
      const { evento, ...detalhes } = r;
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao, recurso: 'eventos', recursoId: id, detalhes });
    });
    res.status(rota === 'fechar-estoque' ? 200 : 201).json(await estoqueEv.estoque(pool, req.user.tenantId, id));
  });
}

module.exports = router;
