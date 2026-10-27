const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireArea, MATRIX, PERMISSOES, areasEfetivas, normalizarOverrides } = require('../middleware/permissions');
const { MODULOS } = require('../config/modulos');
const { logAudit } = require('../utils/audit');
const { getOwnedLocation } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const { PERFIS, criarUsuario, lojasAdicionais, gravarLojasAdicionais, resetarDoisFatores } = require('../services/usuarios');

const router = express.Router();

// Padrao de cada perfil e lista de permissoes ajustaveis (a tela de usuarios monta os checkboxes com isso).
// Permissoes de modulos que a empresa nao contratou nao aparecem (ex.: sem PDV, some "dar desconto").
router.get('/users/permissoes', requireArea('Configuracoes'), (req, res) => {
  const fora = new Set(MODULOS.filter((m) => req.user.modulos && req.user.modulos[m.chave] === false).flatMap((m) => m.areas));
  const permissoes = Object.fromEntries(Object.entries(PERMISSOES).filter(([k]) => !fora.has(k)));
  res.json({ permissoes, padrao: MATRIX });
});

router.get('/users', requireArea('Configuracoes'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.location_id, u.ativo, u.criado_em, u.permissoes, u.totp_ativo, u.totp_exigido, u.comissao_pct,
            COALESCE((SELECT json_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id), '[]') AS location_ids
     FROM users u WHERE u.tenant_id = $1 AND u.perfil <> 'Master' ORDER BY u.nome`,
    [req.user.tenantId]
  );
  res.json(rows);
});

router.post('/users', requireArea('Configuracoes'), async (req, res) => {
  const { nome, email, senha, perfil, location_id } = req.body || {};
  if (perfil === 'Master') throw new HttpError(403, 'o perfil Master só pode ser criado por script');
  const permissoes = normalizarOverrides(perfil, (req.body || {}).permissoes);
  if (permissoes === false) throw new HttpError(400, 'permissões inválidas');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const usuario = await criarUsuario(client, {
      tenantId: req.user.tenantId, nome, email, senha, perfil, location_id, location_ids: (req.body || {}).location_ids, permissoes, totpExigido: (req.body || {}).totp_exigido === true,
      auditoria: { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar', detalhes: { perfil, permissoes } },
    });
    await client.query('COMMIT');
    res.status(201).json(usuario);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Altera perfil e/ou local de atuacao (location_id null = todos os locais).
router.patch('/users/:id', requireArea('Configuracoes'), async (req, res) => {
  const body = req.body || {};
  if (body.perfil === 'Master') throw new HttpError(403, 'o perfil Master só pode ser criado por script');
  const alvo = await pool.query(
    `SELECT id, perfil, location_id, permissoes FROM users WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.user.tenantId]
  );
  if (alvo.rows.length === 0) return res.status(404).json({ erro: 'usuário não encontrado' });
  const atual = alvo.rows[0];
  if (atual.perfil === 'Master') throw new HttpError(403, 'o usuário Master não pode ser alterado por aqui');

  const nome = body.nome !== undefined ? String(body.nome).trim() : null;
  if (nome !== null && nome.length < 2) throw new HttpError(400, 'nome deve ter no mínimo 2 caracteres');
  const perfil = body.perfil !== undefined ? body.perfil : atual.perfil;
  if (!PERFIS.includes(perfil)) throw new HttpError(400, 'perfil inválido');
  let locationId = atual.location_id;
  if (body.location_id !== undefined) {
    locationId = body.location_id || null;
    if (locationId) await getOwnedLocation(pool, locationId, req.user.tenantId);
  }
  let extras = await lojasAdicionais(pool, req.user.tenantId, body.location_ids, locationId);
  if (perfil === 'Garçom' && !locationId) throw new HttpError(400, 'o garçom precisa de uma loja principal');
  // Sem loja principal (todas as lojas) nao existem lojas adicionais; mudar a principal tira ela da lista.
  if (!locationId) extras = [];
  if (extras === undefined && body.location_id !== undefined) {
    const ja = await pool.query(`SELECT location_id FROM user_locations WHERE user_id = $1`, [req.params.id]);
    extras = locationId ? ja.rows.map((r) => r.location_id).filter((id) => id !== locationId) : [];
  }
  // Ajustes individuais: se vierem no corpo, valem; se o perfil mudou sem ajustes, voltam ao padrao.
  let permissoes = atual.permissoes;
  if (body.permissoes !== undefined) {
    permissoes = normalizarOverrides(perfil, body.permissoes);
    if (permissoes === false) throw new HttpError(400, 'permissões inválidas');
  } else if (perfil !== atual.perfil) {
    permissoes = null;
  }
  // % de comissao deste garcom (vazio = usa a regra da empresa). So quem gere comissoes ou configuracoes altera (a rota ja exige Configuracoes).
  let comissaoPct = null; let mudaComissao = false;
  if (body.comissao_pct !== undefined) {
    mudaComissao = true;
    if (body.comissao_pct !== null && body.comissao_pct !== '') {
      comissaoPct = Number(body.comissao_pct);
      if (!(comissaoPct >= 0 && comissaoPct <= 100)) throw new HttpError(400, 'comissão do garçom: informe de 0 a 100%');
    }
  }
  if (req.params.id === req.user.id && !areasEfetivas(perfil, permissoes).Configuracoes) {
    throw new HttpError(400, 'você não pode tirar o seu próprio acesso a Configurações');
  }
  if (req.params.id === req.user.id && perfil !== 'Administrador' && atual.perfil === 'Administrador') {
    throw new HttpError(400, 'você não pode remover o seu próprio perfil de Administrador');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET perfil = $1, location_id = $2, nome = COALESCE($5, nome), permissoes = $6 WHERE id = $3 AND tenant_id = $4
       RETURNING id, nome, email, perfil, location_id, ativo, permissoes`,
      [perfil, locationId, req.params.id, req.user.tenantId, nome, permissoes ? JSON.stringify(permissoes) : null]
    );
    if (extras !== undefined) await gravarLojasAdicionais(client, req.user.tenantId, req.params.id, extras);
    if (mudaComissao) {
      await client.query(`UPDATE users SET comissao_pct = $1 WHERE id = $2 AND tenant_id = $3`, [comissaoPct, req.params.id, req.user.tenantId]);
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'comissao_pct_garcom', recurso: 'users', recursoId: req.params.id, detalhes: { comissao_pct: comissaoPct } });
    }
    if (typeof body.totp_exigido === 'boolean') {
      await client.query(`UPDATE users SET totp_exigido = $1 WHERE id = $2 AND tenant_id = $3`, [body.totp_exigido, req.params.id, req.user.tenantId]);
      await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: body.totp_exigido ? 'exigir_2fa' : 'dispensar_2fa', recurso: 'users', recursoId: req.params.id });
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: 'alterar_permissao',
      recurso: 'users',
      recursoId: req.params.id,
      detalhes: { perfil_anterior: atual.perfil, perfil, permissoes_anteriores: atual.permissoes, permissoes, location_anterior: atual.location_id, location_id: locationId, location_ids: extras },
    });
    await client.query('COMMIT');
    res.json({ ...rows[0], location_ids: extras });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Administrador define uma nova senha para o usuario (ex: esqueceu a senha).
router.patch('/users/:id/password', requireArea('Configuracoes'), async (req, res) => {
  const { senha } = req.body || {};
  if (!senha || String(senha).length < 6) throw new HttpError(400, 'a senha deve ter no mínimo 6 caracteres');
  const alvo = await pool.query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  if (alvo.rows.length === 0) return res.status(404).json({ erro: 'usuário não encontrado' });
  const hash = await bcrypt.hash(String(senha), 10);
  await pool.query(`UPDATE users SET senha_hash = $1 WHERE id = $2 AND tenant_id = $3`, [hash, req.params.id, req.user.tenantId]);
  await logAudit(pool, {
    tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'redefinir_senha', recurso: 'users', recursoId: req.params.id,
  });
  res.status(204).send();
});

router.patch('/users/:id/status', requireArea('Configuracoes'), async (req, res) => {
  const { ativo } = req.body || {};
  if (req.params.id === req.user.id && !ativo) {
    return res.status(400).json({ erro: 'você não pode desativar o seu próprio usuário' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET ativo = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, ativo`,
      [!!ativo, req.params.id, req.user.tenantId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'usuário não encontrado' });
    }
    await logAudit(client, {
      tenantId: req.user.tenantId,
      usuarioId: req.user.id,
      acao: ativo ? 'ativar' : 'desativar',
      recurso: 'users',
      recursoId: req.params.id,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Reset do 2FA por quem administra (Administrador da empresa: so usuarios dela; nunca o Master).
router.post('/users/:id/2fa/resetar', requireArea('Configuracoes'), async (req, res) => {
  const { rows } = await pool.query(`SELECT id, tenant_id, nome, perfil FROM users WHERE id = $1`, [req.params.id]);
  const alvo = rows[0];
  if (alvo && alvo.perfil === 'Master') throw new HttpError(403, 'o 2FA do Master só pode ser resetado pelo próprio Master ou por script');
  if (!alvo || alvo.tenant_id !== req.user.tenantId) throw new HttpError(404, 'usuário não encontrado');
  await resetarDoisFatores(pool, alvo.id);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'resetar_2fa', recurso: 'users', recursoId: alvo.id });
  res.json({ ok: true });
});

module.exports = router;
