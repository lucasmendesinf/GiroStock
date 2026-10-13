const express = require('express');
const fs = require('fs');
const { requireArea } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const pool = require('../db/pool');
const config = require('../services/config');
const backup = require('../services/backup');
const { exportarEmpresa, caminhoDaExportacao } = require('../services/exportacao');
const manutencao = require('../services/manutencao');
const totp = require('../services/totp');
const { verificarMigracoes } = require('../services/saude');

// Painel Master, fase 3: backups e dados, manutencao segura, configuracoes globais (aviso, manutencao, parametros, planos).
// Segredos (senhas, chaves, DATABASE_URL*) nunca saem daqui: so "configurado / nao configurado".
const router = express.Router();
router.use('/master', requireArea('Master'));
const db = pool.producao;

async function tenantMaster() {
  const r = await db.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`);
  return r.rows[0] && r.rows[0].id;
}
const audit = async (req, acao, recurso, recursoId, detalhes) =>
  logAudit(db, { tenantId: await tenantMaster(), usuarioId: req.user.id, acao, recurso, recursoId, detalhes });

// ---------------------------------------------------------------- Backups
router.get('/master/backups', async (req, res) => {
  const pasta = backup.diretorioPronto();
  const cfg = await config.todos();
  const lista = pasta.ok ? await backup.listar() : { backups: [], usado_bytes: 0 };
  res.json({
    ...lista,
    pasta: { ok: pasta.ok, erro: pasta.erro || null },
    rotina: { automatico: cfg.backup_automatico, hora: cfg.backup_hora, retencao_dias: cfg.backup_retencao_dias },
    pg_dump: backup.temPgDump(),
    teste_configurado: pool.testeConfigurado(),
  });
});

router.post('/master/backups', async (req, res) => {
  const r = await backup.gerarBackup({ tipo: 'manual', usuarioId: req.user.id });
  res.status(r.status === 'concluido' ? 201 : 500).json({ backup: { id: r.id, status: r.status, arquivo: r.arquivo, tamanho_bytes: r.tamanho_bytes, erro: r.erro } });
});

router.get('/master/backups/:id/download', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'backup inválido');
  const { backup: b, arquivo } = await backup.arquivoVerificado(req.params.id);
  await audit(req, 'master_backup_baixar', 'backups', b.id, { arquivo: b.arquivo });
  res.download(arquivo, b.arquivo);
});

router.delete('/master/backups/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'backup inválido');
  await backup.remover(req.params.id, req.user.id);
  res.status(204).end();
});

// Restaurar pela tela vai SEMPRE para o banco de TESTE. Na producao so pelo script do servidor (npm run restaurar-backup).
router.post('/master/backups/:id/restaurar-teste', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'backup inválido');
  const b = req.body || {};
  if (b.confirmacao !== 'RESTAURAR') throw new HttpError(400, 'digite RESTAURAR para confirmar');
  const r = await backup.restaurarNoTeste(req.params.id, { usuarioId: req.user.id, tenantId: await tenantMaster(), anonimizar: b.anonimizar !== false });
  await require('../services/modoTeste').garantirUsuarioNoTeste(req.user.id);
  res.json(r);
});

// ---------------------------------------------------------------- Exportar dados de uma empresa
router.post('/master/empresas/:id/exportar', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'empresa inválida');
  res.status(201).json(await exportarEmpresa(req.params.id, { usuarioId: req.user.id, tenantMaster: await tenantMaster() }));
});
router.get('/master/exportacoes/:arquivo', async (req, res) => {
  const p = caminhoDaExportacao(req.params.arquivo);
  res.download(p, req.params.arquivo);
});

// ---------------------------------------------------------------- Manutencao segura
function bancoDe(nome) {
  if (nome === 'teste') {
    if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
    return pool.teste();
  }
  return db;
}
router.post('/master/manutencao/saldos', async (req, res) => {
  const b = req.body || {};
  if (b.empresa_id && !isUuid(b.empresa_id)) throw new HttpError(400, 'empresa inválida');
  res.json(await manutencao.verificarSaldos(bancoDe(b.banco), { empresaId: b.empresa_id }));
});
router.post('/master/manutencao/saldos/corrigir', async (req, res) => {
  const b = req.body || {};
  if (b.confirmacao !== 'CORRIGIR') throw new HttpError(400, 'digite CORRIGIR para confirmar');
  if (!isUuid(b.empresa_id)) throw new HttpError(400, 'escolha a empresa');
  const banco = bancoDe(b.banco);
  const r = await manutencao.corrigirSaldos(banco, { empresaId: b.empresa_id, usuarioId: req.user.id, tenantAuditoria: banco === db ? await tenantMaster() : b.empresa_id });
  if (banco === db) await audit(req, 'master_corrigir_saldos_resumo', 'stock_balances', null, { empresa_id: b.empresa_id, corrigidos: r.corrigidos });
  res.json(r);
});
router.post('/master/manutencao/otimizar', async (req, res) => {
  const r = await manutencao.otimizar(db);
  await audit(req, 'master_otimizar_banco', 'banco', null, { duracao_ms: r.duracao_ms });
  res.json(r);
});

// ---------------------------------------------------------------- Integracoes (so status)
async function statusIntegracoes() {
  const pasta = backup.diretorioPronto();
  let testeOk = null;
  if (pool.testeConfigurado()) { try { await pool.teste().query('SELECT 1'); testeOk = true; } catch { testeOk = false; } }
  return [
    { id: 'banco_teste', nome: 'Banco de teste (modo teste)', status: !pool.testeConfigurado() ? 'nao_configurado' : testeOk ? 'ok' : 'erro', detalhe: !pool.testeConfigurado() ? 'DATABASE_URL_TESTE ausente ou igual à produção' : testeOk ? 'conectado' : 'não respondeu', testavel: pool.testeConfigurado() },
    { id: 'backup_dir', nome: 'Pasta de backups (BACKUP_DIR)', status: pasta.ok ? 'ok' : 'erro', detalhe: pasta.ok ? 'gravável' : pasta.erro, testavel: true },
    { id: 'pg_dump', nome: 'pg_dump no servidor', status: backup.temPgDump() ? 'ok' : 'indisponivel', detalhe: backup.temPgDump() ? 'disponível (backups em formato pg_dump)' : 'não encontrado: os backups usam o formato próprio (JavaScript)', testavel: false },
    { id: 'totp', nome: 'Chave do 2FA (TOTP_ENC_KEY)', status: totp.disponivel() ? 'ok' : 'nao_configurado', detalhe: totp.disponivel() ? 'configurada' : 'ausente: o 2FA fica indisponível', testavel: false },
    { id: 'smtp', nome: 'E-mail (SMTP)', status: process.env.SMTP_HOST ? 'ok' : 'nao_configurado', detalhe: process.env.SMTP_HOST ? 'configurado' : 'não configurado (o sistema ainda não envia e-mails)', testavel: false },
    { id: 'whatsapp', nome: 'WhatsApp (API)', status: 'nao_contratado', detalhe: 'não contratado: as mensagens usam o link wa.me', testavel: false },
    { id: 'ifood', nome: 'iFood', status: 'futuro', detalhe: 'etapa futura', testavel: false },
    { id: '99food', nome: '99Food', status: 'futuro', detalhe: 'etapa futura', testavel: false },
  ];
}
router.get('/master/config/integracoes', async (req, res) => {
  res.json({ integracoes: await statusIntegracoes() });
});
router.post('/master/config/integracoes/:id/testar', async (req, res) => {
  if (req.params.id === 'banco_teste') {
    if (!pool.testeConfigurado()) throw new HttpError(409, 'banco de teste não configurado');
    const t0 = Date.now();
    await pool.teste().query('SELECT 1');
    const mig = await verificarMigracoes(pool.teste());
    return res.json({ ok: true, mensagem: `Conectado em ${Date.now() - t0} ms · migrations ${mig.aplicadas}/${mig.arquivos}` });
  }
  if (req.params.id === 'backup_dir') {
    const p = backup.diretorioPronto();
    return res.json({ ok: p.ok, mensagem: p.ok ? 'A pasta de backups está gravável.' : p.erro });
  }
  throw new HttpError(404, 'esta integração não tem teste');
});

// ---------------------------------------------------------------- Aviso global (todos os usuarios)
router.get('/master/avisos', async (req, res) => {
  const { rows } = await db.query(`SELECT id, mensagem, ativo, criado_em, removido_em FROM avisos_globais ORDER BY criado_em DESC LIMIT 20`);
  res.json({ ativo: rows.find((r) => r.ativo) || null, historico: rows });
});
router.post('/master/avisos', async (req, res) => {
  const mensagem = String((req.body || {}).mensagem || '').trim();
  if (mensagem.length < 3 || mensagem.length > 300) throw new HttpError(400, 'o aviso precisa ter de 3 a 300 caracteres');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE avisos_globais SET ativo = false, removido_em = now() WHERE ativo`);
    const r = await client.query(`INSERT INTO avisos_globais (mensagem, criado_por) VALUES ($1, $2) RETURNING id, mensagem, criado_em`, [mensagem, req.user.id]);
    await client.query('COMMIT');
    await audit(req, 'master_aviso_publicar', 'avisos_globais', r.rows[0].id, { mensagem });
    res.status(201).json(r.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
});
router.delete('/master/avisos', async (req, res) => {
  const r = await db.query(`UPDATE avisos_globais SET ativo = false, removido_em = now() WHERE ativo RETURNING id`);
  if (r.rows[0]) await audit(req, 'master_aviso_remover', 'avisos_globais', r.rows[0].id, null);
  res.status(204).end();
});
// Decisao: o aviso chega ao front por esta rota leve (qualquer usuario logado), nao por /auth/me.
router.get('/aviso-global', async (req, res) => {
  const r = await db.query(`SELECT id, mensagem FROM avisos_globais WHERE ativo LIMIT 1`);
  res.json({ aviso: r.rows[0] || null });
});

// ---------------------------------------------------------------- Modo manutencao e parametros
router.get('/master/config/manutencao', async (req, res) => {
  res.json(await config.obter('manutencao'));
});
router.put('/master/config/manutencao', async (req, res) => {
  const b = req.body || {};
  if (typeof b.ativo !== 'boolean') throw new HttpError(400, 'informe ativo (verdadeiro/falso)');
  const mensagem = String(b.mensagem || '').trim().slice(0, 300);
  await config.salvar(db, 'manutencao', { ativo: b.ativo, mensagem }, req.user.id);
  await audit(req, b.ativo ? 'master_config_manutencao_ligar' : 'master_config_manutencao_desligar', 'config_global', null, { mensagem });
  res.json({ ativo: b.ativo, mensagem });
});

router.get('/master/config/parametros', async (req, res) => {
  const cfg = await config.todos();
  res.json(Object.fromEntries(config.PARAMETROS.map((k) => [k, cfg[k]])));
});
router.put('/master/config/parametros', async (req, res) => {
  const novos = config.validarParametros(req.body || {});
  if (Object.keys(novos).length === 0) throw new HttpError(400, 'nenhum parâmetro informado');
  const atual = await config.todos();
  const risco = novos.cliente_risco_dias ?? atual.cliente_risco_dias;
  const inativo = novos.cliente_inativo_dias ?? atual.cliente_inativo_dias;
  if (inativo <= risco) throw new HttpError(400, 'os dias de "inativo" precisam ser maiores que os de "em risco"');
  for (const [k, v] of Object.entries(novos)) await config.salvar(db, k, v, req.user.id);
  await audit(req, 'master_config_parametros', 'config_global', null, { alterados: novos });
  const cfg = await config.todos();
  res.json(Object.fromEntries(config.PARAMETROS.map((k) => [k, cfg[k]])));
});

// ---------------------------------------------------------------- Planos
// Empresas que, no plano, ja usam mais do que o limite (sem override proprio): continuam funcionando; so novos cadastros sao barrados.
const SQL_EXCEDEM = `
  SELECT t.id, t.nome,
         (SELECT COUNT(*) FROM locations l WHERE l.tenant_id = t.id AND l.ativo) AS lojas,
         (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.ativo AND u.perfil <> 'Master') AS usuarios,
         (SELECT COUNT(*) FROM terminals x WHERE x.tenant_id = t.id AND x.ativo) AS pdvs,
         t.limites
    FROM tenants t WHERE t.plano = $1 AND t.nome <> 'Plataforma'`;
async function empresasQueExcedem(codigo, plano) {
  const { rows } = await db.query(SQL_EXCEDEM, [codigo]);
  return rows.filter((t) => {
    const ov = t.limites || {};
    const lim = { lojas: ov.lojas ?? plano.max_lojas, usuarios: ov.usuarios ?? plano.max_usuarios, pdvs: ov.pdvs ?? plano.max_pdvs };
    return Number(t.lojas) > lim.lojas || Number(t.usuarios) > lim.usuarios || Number(t.pdvs) > lim.pdvs;
  }).map((t) => t.nome);
}
async function planoComUso(p) {
  const empresas = (await db.query(`SELECT COUNT(*)::int AS n FROM tenants WHERE plano = $1 AND nome <> 'Plataforma'`, [p.codigo])).rows[0].n;
  return { ...p, empresas, empresas_acima_do_limite: await empresasQueExcedem(p.codigo, p) };
}
router.get('/master/planos', async (req, res) => {
  const { rows } = await db.query(`SELECT codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos FROM planos ORDER BY max_lojas, codigo`);
  res.json({ planos: await Promise.all(rows.map(planoComUso)) });
});
router.get('/master/planos/:codigo', async (req, res) => {
  const { rows } = await db.query(`SELECT codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos FROM planos WHERE codigo = $1`, [req.params.codigo]);
  if (rows.length === 0) throw new HttpError(404, 'plano não encontrado');
  res.json(await planoComUso(rows[0]));
});
router.put('/master/planos/:codigo', async (req, res) => {
  const b = req.body || {};
  const { rows } = await db.query(`SELECT codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos FROM planos WHERE codigo = $1`, [req.params.codigo]);
  if (rows.length === 0) throw new HttpError(404, 'plano não encontrado');
  const atual = rows[0];
  const nome = b.nome === undefined ? atual.nome : String(b.nome).trim();
  if (nome.length < 2) throw new HttpError(400, 'informe o nome do plano');
  const inteiro = (v, padrao, min, rotulo) => {
    if (v === undefined) return padrao;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${rotulo} inválido: use um número inteiro de ${min} em diante`);
    return n;
  };
  const max_lojas = inteiro(b.max_lojas, atual.max_lojas, 1, 'limite de lojas');
  const max_usuarios = inteiro(b.max_usuarios, atual.max_usuarios, 1, 'limite de usuários');
  const max_pdvs = inteiro(b.max_pdvs, atual.max_pdvs, 0, 'limite de PDVs');
  let recursos = atual.recursos || {};
  if (b.recursos !== undefined) {
    const r = b.recursos;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.entries(r).some(([k, v]) => !['pedidos', 'clientes'].includes(k) || typeof v !== 'boolean')) throw new HttpError(400, 'recursos inválidos');
    recursos = { ...recursos, ...r };
  }
  await db.query(`UPDATE planos SET nome = $2, max_lojas = $3, max_usuarios = $4, max_pdvs = $5, recursos = $6 WHERE codigo = $1`, [atual.codigo, nome, max_lojas, max_usuarios, max_pdvs, JSON.stringify(recursos)]);
  await audit(req, 'master_plano_editar', 'planos', null, { codigo: atual.codigo, antes: { nome: atual.nome, max_lojas: atual.max_lojas, max_usuarios: atual.max_usuarios, max_pdvs: atual.max_pdvs, recursos: atual.recursos }, depois: { nome, max_lojas, max_usuarios, max_pdvs, recursos } });
  res.json(await planoComUso({ codigo: atual.codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos }));
});

module.exports = router;
