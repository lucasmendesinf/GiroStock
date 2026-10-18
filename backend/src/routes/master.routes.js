const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { requireArea, normalizarOverrides } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const { isValidDocumento, onlyDigits } = require('../utils/validators');
const { dadosDaEmpresa, efetivos, uso, modulosDoPlano } = require('../utils/limites');
const { CHAVES, catalogo, conflitoDeDependencia } = require('../config/modulos');
const { criarUsuario, resetarDoisFatores, validarNovoEmail } = require('../services/usuarios');
const { copiarProducao, status } = require('../services/copiaProducao');
const modoTeste = require('../services/modoTeste');
const config = require('../services/config');
const { mostrarTeste, semDadosDeTeste } = require('../utils/dadosTeste');
const pool = require('../db/pool');
const lojaVirtual = require('../services/lojaVirtual');
const dnsLoja = require('../services/dnsLoja');

// Painel Master. Todas as rotas exigem a area Master e usam SEMPRE a producao (pool.producao), mesmo em modo teste.
// Nada aqui le ou devolve vendas, pedidos, clientes ou produtos das empresas: o Master administra a plataforma.
const router = express.Router();
router.use('/master', requireArea('Master'));
const db = pool.producao;

const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem caracteres ambiguos (i, l, o, 0, 1)
function gerarSenha(tamanho = 10) {
  let s = '';
  for (let i = 0; i < tamanho; i += 1) s += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return s;
}

async function empresaOuErro(id) {
  if (!isUuid(id)) throw new HttpError(400, 'empresa inválida');
  const { rows } = await db.query(`SELECT id, nome FROM tenants WHERE id = $1 AND nome <> 'Plataforma'`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'empresa não encontrada');
  return rows[0];
}

// ---------------------------------------------------------------- Modo teste
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

// ---------------------------------------------------------------- Empresas
router.get('/master/empresas', async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.nome, t.documento, t.plano, p.nome AS plano_nome, t.status, t.criado_em,
            (SELECT COUNT(*)::int FROM locations l WHERE l.tenant_id = t.id AND l.ativo) AS qtd_lojas,
            (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.ativo AND u.perfil <> 'Master') AS qtd_usuarios_ativos,
            (SELECT MAX(u.ultimo_login) FROM users u WHERE u.tenant_id = t.id) AS ultimo_acesso,
            EXISTS(SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.ativo AND u.totp_ativo) AS cliente_2fa
     FROM tenants t LEFT JOIN planos p ON p.codigo = t.plano
     WHERE t.nome <> 'Plataforma' ${mostrarTeste(req) ? '' : `AND ${semDadosDeTeste({ empresa: 't' })}`} ORDER BY t.nome`
  );
  res.json({
    resumo: {
      empresas: rows.length,
      ativas: rows.filter((e) => e.status === 'ativa').length,
      lojas: rows.reduce((s, e) => s + e.qtd_lojas, 0),
      usuarios: rows.reduce((s, e) => s + e.qtd_usuarios_ativos, 0),
    },
    empresas: rows,
  });
});

// Catalogo de modulos (segmentos) que podem ser liberados por plano ou por empresa.
router.get('/master/modulos', async (req, res) => {
  res.json({ modulos: catalogo() });
});

router.get('/master/empresas/:id', async (req, res) => {
  await empresaOuErro(req.params.id);
  const e = await dadosDaEmpresa(db, req.params.id);
  const ef = efetivos(e);
  const usados = await uso(db, req.params.id);
  const lojas = await db.query(`SELECT id, nome, ativo FROM locations WHERE tenant_id = $1 ORDER BY ativo DESC, nome`, [req.params.id]);
  const usuarios = await db.query(
    `SELECT id, nome, email, perfil, ativo, ultimo_login, totp_ativo FROM users WHERE tenant_id = $1 AND perfil <> 'Master' ORDER BY ativo DESC, nome`,
    [req.params.id]
  );
  res.json({
    id: e.id, nome: e.nome, documento: e.documento, status: e.status, suspenso_motivo: e.suspenso_motivo, suspenso_em: e.suspenso_em,
    plano: e.plano, plano_nome: e.plano_nome, criado_em: e.criado_em,
    cliente_2fa: usuarios.rows.some((u) => u.ativo && u.totp_ativo),
    contato: (await db.query(`SELECT email_contato, telefone, responsavel FROM tenants WHERE id = $1`, [req.params.id])).rows[0],
    limites: ['lojas', 'usuarios', 'pdvs'].map((k) => ({ chave: k, limite: ef.limites[k], usado: usados[k], origem: ef.origem[k] })),
    // Modulos liberados (valor efetivo), de onde vem cada um (plano ou liberacao da empresa) e o que o plano daria sozinho.
    recursos: { ...ef.recursos, origem: Object.fromEntries(CHAVES.map((k) => [k, ef.origem[k]])) },
    modulos: catalogo().map((m) => ({ ...m, ligado: ef.recursos[m.chave], origem: ef.origem[m.chave], no_plano: modulosDoPlano(e.plano_recursos)[m.chave] })),
    overrides: { limites: e.limites || null, recursos: e.recursos || null },
    lojas: lojas.rows,
    usuarios: usuarios.rows,
  });
});

async function planoOuErro(codigo) {
  const { rows } = await db.query(`SELECT codigo, max_lojas, max_usuarios, recursos FROM planos WHERE codigo = $1`, [codigo]);
  if (rows.length === 0) throw new HttpError(400, 'plano inválido');
  return rows[0];
}

function validarDocumento(doc) {
  const d = String(doc || '').trim();
  if (!d) return null;
  if (!isValidDocumento(onlyDigits(d))) throw new HttpError(400, 'CNPJ/CPF inválido');
  return onlyDigits(d);
}

// Cria empresa + primeira loja + primeiro Administrador numa transacao: o usuario nunca existe sem empresa.
router.post('/master/empresas', async (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (nome.length < 2) throw new HttpError(400, 'informe o nome da empresa');
  if (nome.toLowerCase() === 'plataforma') throw new HttpError(400, 'este nome é reservado');
  const documento = validarDocumento(b.documento);
  const plano = await planoOuErro(b.plano || 'completo');
  if (plano.max_lojas < 1 || plano.max_usuarios < 1) throw new HttpError(409, 'o plano escolhido não permite criar a primeira loja e o administrador');
  // Modulos ja na criacao: o que difere do plano escolhido fica como liberacao da empresa.
  const recursos = b.recursos === undefined ? null : validarRecursos(b.recursos);
  if (recursos) {
    const plano_ = modulosDoPlano(plano.recursos);
    const conflito = conflitoDeDependencia(Object.fromEntries(CHAVES.map((k) => [k, typeof recursos[k] === 'boolean' ? recursos[k] : plano_[k]])));
    if (conflito) throw new HttpError(400, conflito);
  }
  const adm = b.admin || {};
  if (!String(adm.nome || '').trim()) throw new HttpError(400, 'informe o nome do administrador');
  const senha = adm.senha ? String(adm.senha) : gerarSenha();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const vipPadrao = await config.obter('vip_limite_padrao'); // valor inicial; cada empresa mantem o seu depois
    const t = await client.query(`INSERT INTO tenants (nome, documento, plano, clientes_vip_limite, recursos) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, documento, plano, status, criado_em`, [nome, documento, plano.codigo, vipPadrao, recursos ? JSON.stringify(recursos) : null]);
    const empresa = t.rows[0];
    await client.query(`INSERT INTO locations (tenant_id, nome) VALUES ($1, $2)`, [empresa.id, String(b.loja_nome || '').trim() || 'Loja única']);
    const administrador = await criarUsuario(client, {
      tenantId: empresa.id, nome: String(adm.nome).trim(), email: String(adm.email || '').trim(), senha, perfil: 'Administrador',
      deveTrocarSenha: true,
      auditoria: { tenantId: empresa.id, usuarioId: req.user.id, acao: 'master_criar_usuario', detalhes: { perfil: 'Administrador', primeiro_administrador: true } },
    });
    await logAudit(client, { tenantId: empresa.id, usuarioId: req.user.id, acao: 'master_criar_empresa', recurso: 'tenants', recursoId: empresa.id, detalhes: { plano: plano.codigo, recursos } });
    await client.query('COMMIT');
    // A senha temporaria aparece UMA vez, nesta resposta; nunca e registrada em log ou auditoria.
    res.status(201).json({ empresa, administrador: { id: administrador.id, nome: administrador.nome, email: administrador.email }, senha_temporaria: senha });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

function validarLimites(l) {
  if (l === null) return null;
  if (typeof l !== 'object' || Array.isArray(l)) throw new HttpError(400, 'limites inválidos');
  const r = {};
  for (const [k, v] of Object.entries(l)) {
    if (!['lojas', 'usuarios', 'pdvs'].includes(k)) throw new HttpError(400, 'limites inválidos');
    if (v === null || v === undefined || v === '') continue;
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw new HttpError(400, 'limites inválidos: use números inteiros');
    r[k] = Number(v);
  }
  return Object.keys(r).length > 0 ? r : null;
}
function validarRecursos(rec) {
  if (rec === null) return null;
  if (typeof rec !== 'object' || Array.isArray(rec)) throw new HttpError(400, 'recursos inválidos');
  const r = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!CHAVES.includes(k)) throw new HttpError(400, `módulo desconhecido: ${k}`);
    if (v === null || v === undefined) continue; // volta ao plano
    if (typeof v !== 'boolean') throw new HttpError(400, 'recursos inválidos');
    r[k] = v;
  }
  return Object.keys(r).length > 0 ? r : null;
}

router.patch('/master/empresas/:id', async (req, res) => {
  const emp = await empresaOuErro(req.params.id);
  const b = req.body || {};
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  const mudou = {};
  if (b.nome !== undefined) {
    const nome = String(b.nome).trim();
    if (nome.length < 2) throw new HttpError(400, 'informe o nome da empresa');
    if (nome.toLowerCase() === 'plataforma') throw new HttpError(400, 'este nome é reservado');
    add('nome', nome); mudou.nome = true;
  }
  if (b.documento !== undefined) { add('documento', validarDocumento(b.documento)); mudou.documento = true; }
  if (b.plano !== undefined) { add('plano', (await planoOuErro(b.plano)).codigo); mudou.plano = b.plano; }
  if (b.limites !== undefined) { const l = validarLimites(b.limites); add('limites', l ? JSON.stringify(l) : null); mudou.limites = l; }
  if (b.recursos !== undefined) {
    // Liberacao parcial ({"pedidos": true}) soma as que a empresa ja tinha; null em um modulo volta ao plano; recursos: null limpa tudo.
    const atual = (await db.query(`SELECT recursos FROM tenants WHERE id = $1`, [emp.id])).rows[0].recursos || {};
    const entrada = b.recursos === null ? null : { ...atual, ...b.recursos };
    const r = validarRecursos(entrada);
    add('recursos', r ? JSON.stringify(r) : null); mudou.recursos = r;
  }
  if (sets.length === 0) throw new HttpError(400, 'nada para alterar');
  if (b.recursos !== undefined || b.plano !== undefined) {
    // Confere o resultado (plano novo + liberacoes da empresa): modulo ligado sem a dependencia e recusado com explicacao.
    const planoCodigo = b.plano !== undefined ? b.plano : (await dadosDaEmpresa(db, emp.id)).plano;
    const pl = (await db.query(`SELECT recursos FROM planos WHERE codigo = $1`, [planoCodigo])).rows[0];
    const ovr = b.recursos !== undefined ? (mudou.recursos || {}) : ((await db.query(`SELECT recursos FROM tenants WHERE id = $1`, [emp.id])).rows[0].recursos || {});
    const plano = modulosDoPlano(pl && pl.recursos);
    const final = Object.fromEntries(CHAVES.map((k) => [k, typeof ovr[k] === 'boolean' ? ovr[k] : plano[k]]));
    const conflito = conflitoDeDependencia(final);
    if (conflito) throw new HttpError(400, conflito);
  }
  params.push(emp.id);
  await db.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  await logAudit(db, { tenantId: emp.id, usuarioId: req.user.id, acao: 'master_alterar_empresa', recurso: 'tenants', recursoId: emp.id, detalhes: mudou });
  res.json({ ok: true });
});

router.post('/master/empresas/:id/suspender', async (req, res) => {
  const emp = await empresaOuErro(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 3) throw new HttpError(400, 'informe o motivo da suspensão');
  await db.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = $1, suspenso_em = now() WHERE id = $2`, [motivo, emp.id]);
  await logAudit(db, { tenantId: emp.id, usuarioId: req.user.id, acao: 'master_suspender_empresa', recurso: 'tenants', recursoId: emp.id, detalhes: { motivo } });
  res.json({ status: 'suspensa' });
});

router.post('/master/empresas/:id/reativar', async (req, res) => {
  const emp = await empresaOuErro(req.params.id);
  await db.query(`UPDATE tenants SET status = 'ativa', suspenso_motivo = NULL, suspenso_em = NULL WHERE id = $1`, [emp.id]);
  await logAudit(db, { tenantId: emp.id, usuarioId: req.user.id, acao: 'master_reativar_empresa', recurso: 'tenants', recursoId: emp.id });
  res.json({ status: 'ativa' });
});

// ---------------------------------------------------------------- Loja virtual (endereco)
// O Master define o subdominio gratis (joao.<LOJA_DOMINIO_BASE>) e os dominios proprios da loja da empresa.
// O cliente so aponta o DNS; o resto (layout, produtos, pagamentos) ele configura no proprio painel.
async function lojaDoMaster(emp, req) {
  const loja = await lojaVirtual.lojaDaEmpresa(db, emp.id);
  const dominios = await lojaVirtual.dominiosDaLoja(db, loja.id);
  return {
    modulo_ligado: !!efetivos(await dadosDaEmpresa(db, emp.id)).recursos.loja_virtual,
    publicada: loja.publicada, nome: loja.nome, tipo: lojaVirtual.tipoValido(loja.tipo),
    ...lojaVirtual.enderecosDaLoja(loja, dominios, `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`),
    dns_alvo: dnsLoja.alvo(),
  };
}

router.get('/master/empresas/:id/loja-virtual', async (req, res) => {
  res.json(await lojaDoMaster(await empresaOuErro(req.params.id), req));
});

router.put('/master/empresas/:id/loja-virtual', async (req, res) => {
  const emp = await empresaOuErro(req.params.id);
  const b = req.body || {};
  const loja = await lojaVirtual.lojaDaEmpresa(db, emp.id);
  if (b.tipo !== undefined && !['varejo', 'cardapio'].includes(b.tipo)) throw new HttpError(400, 'tipo de loja inválido (varejo ou cardapio)');
  const tipo = b.tipo === undefined ? lojaVirtual.tipoValido(loja.tipo) : b.tipo;
  const sub = b.subdominio === undefined ? loja.subdominio : b.subdominio === null || b.subdominio === '' ? null : lojaVirtual.normalizarSubdominio(b.subdominio);
  let dominios;
  if (b.dominios !== undefined) {
    const lista = Array.isArray(b.dominios) ? b.dominios : String(b.dominios || '').split(/[\s,;]+/);
    dominios = [...new Set(lista.map((d) => String(d).trim()).filter(Boolean).map(lojaVirtual.normalizarDominio))];
    if (dominios.length > 5) throw new HttpError(400, 'no máximo 5 domínios por loja');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (sub) {
      const outra = await client.query(`SELECT 1 FROM lv_lojas WHERE lower(subdominio) = $1 AND id <> $2`, [sub, loja.id]);
      if (outra.rows.length) throw new HttpError(409, `o subdomínio "${sub}" já é de outra empresa`);
    }
    await client.query(`UPDATE lv_lojas SET subdominio = $2, tipo = $3, atualizado_em = now() WHERE id = $1`, [loja.id, sub, tipo]);
    if (dominios) {
      const outros = await client.query(`SELECT dominio FROM lv_dominios WHERE dominio = ANY($1::text[]) AND loja_id <> $2`, [dominios, loja.id]);
      if (outros.rows.length) throw new HttpError(409, `o domínio ${outros.rows[0].dominio} já está ligado à loja de outra empresa`);
      await client.query(`DELETE FROM lv_dominios WHERE loja_id = $1`, [loja.id]);
      // clock_timestamp: cada linha com a sua hora (a lista volta na ordem em que foi digitada)
      for (const d of dominios) await client.query(`INSERT INTO lv_dominios (dominio, loja_id, criado_em) VALUES ($1, $2, clock_timestamp())`, [d, loja.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new HttpError(409, 'subdomínio ou domínio já usado por outra empresa');
    throw err;
  } finally {
    client.release();
  }
  lojaVirtual.limparCacheHost();
  await logAudit(db, { tenantId: emp.id, usuarioId: req.user.id, acao: 'master_loja_endereco', recurso: 'lv_lojas', recursoId: loja.id, detalhes: { subdominio: sub, dominios, tipo } });
  res.json(await lojaDoMaster(emp, req));
});

// Confere se os dominios proprios ja apontam para o servidor (consulta DNS publica).
router.get('/master/empresas/:id/loja-virtual/dns', async (req, res) => {
  const emp = await empresaOuErro(req.params.id);
  const loja = await lojaVirtual.lojaDaEmpresa(db, emp.id);
  const dominios = await lojaVirtual.dominiosDaLoja(db, loja.id);
  res.json({ alvo: dnsLoja.alvo(), dominios: await Promise.all(dominios.map((d) => dnsLoja.conferir(d))) });
});

// ---------------------------------------------------------------- Usuarios & seguranca
router.get('/master/usuarios', async (req, res) => {
  const { empresa_id: empresaId, q, situacao } = req.query;
  const params = [];
  const where = [`u.perfil <> 'Master'`, `t.nome <> 'Plataforma'`];
  const ocultarTeste = !mostrarTeste(req);
  if (ocultarTeste) where.push(semDadosDeTeste({ empresa: 't', usuario: 'u' }));
  if (empresaId) {
    if (!isUuid(empresaId)) throw new HttpError(400, 'empresa inválida');
    params.push(empresaId);
    where.push(`u.tenant_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(lower(u.nome) LIKE $${params.length} OR lower(u.email::text) LIKE $${params.length})`);
  }
  if (situacao === 'ativos') where.push('u.ativo');
  else if (situacao === 'inativos') where.push('NOT u.ativo');
  else if (situacao === 'falhas') where.push('u.falhas_login >= 3');
  else if (situacao === 'sem_login') where.push(`u.ativo AND (u.ultimo_login IS NULL OR u.ultimo_login < now() - interval '30 days')`);
  const { rows } = await db.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_login, u.falhas_login, u.ultima_falha_em, u.deve_trocar_senha,
            t.id AS empresa_id, t.nome AS empresa_nome,
            COALESCE((u.permissoes ->> 'ModoTeste')::boolean, false) AS modo_teste, u.totp_ativo, u.totp_exigido,
            (SELECT COALESCE(json_agg(l.nome ORDER BY l.nome), '[]'::json) FROM locations l
              WHERE l.id = u.location_id OR l.id IN (SELECT ul.location_id FROM user_locations ul WHERE ul.user_id = u.id)) AS lojas
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY t.nome, u.nome`,
    params
  );
  const r = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE u.ativo)::int AS ativos, COUNT(*)::int AS total,
            COALESCE(SUM(u.falhas_login) FILTER (WHERE u.ultima_falha_em > now() - interval '24 hours'), 0)::int AS falhas_24h,
            COUNT(*) FILTER (WHERE u.falhas_login >= 3)::int AS usuarios_3_falhas,
            COUNT(*) FILTER (WHERE u.ativo AND (u.ultimo_login IS NULL OR u.ultimo_login < now() - interval '30 days'))::int AS sem_login_30d
     FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.perfil <> 'Master' AND t.nome <> 'Plataforma' ${ocultarTeste ? `AND ${semDadosDeTeste({ empresa: 't', usuario: 'u' })}` : ''}`
  )).rows[0];
  res.json({ resumo: r, usuarios: rows });
});

// Novo usuario SEMPRE dentro de uma empresa. A senha temporaria (informada ou gerada) aparece uma unica vez.
router.post('/master/usuarios', async (req, res) => {
  const b = req.body || {};
  if (!b.empresa_id) throw new HttpError(400, 'escolha a empresa do usuário');
  if (b.perfil === 'Master') throw new HttpError(403, 'o perfil Master só pode ser criado por script');
  const emp = await empresaOuErro(b.empresa_id);
  const senha = b.senha ? String(b.senha) : gerarSenha();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const usuario = await criarUsuario(client, {
      tenantId: emp.id, nome: String(b.nome || '').trim(), email: String(b.email || '').trim(), senha, perfil: b.perfil,
      location_id: b.location_id, location_ids: b.location_ids, deveTrocarSenha: true, exigirLoja: true,
      auditoria: { tenantId: emp.id, usuarioId: req.user.id, acao: 'master_criar_usuario', detalhes: { perfil: b.perfil } },
    });
    await client.query('COMMIT');
    res.status(201).json({ usuario, senha_temporaria: senha });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Usuario alvo das acoes de seguranca: nunca o Master (403) e nunca a empresa Plataforma.
async function alvoOuErro(id) {
  if (!isUuid(id)) throw new HttpError(400, 'usuário inválido');
  const { rows } = await db.query(`SELECT id, tenant_id, nome, perfil, permissoes FROM users WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'usuário não encontrado');
  if (rows[0].perfil === 'Master') throw new HttpError(403, 'o usuário Master não pode ser alterado por aqui');
  return rows[0];
}

router.post('/master/usuarios/:id/forcar-troca-senha', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  await db.query(`UPDATE users SET deve_trocar_senha = true WHERE id = $1`, [u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'master_forcar_troca_senha', recurso: 'users', recursoId: u.id });
  res.json({ ok: true });
});

router.post('/master/usuarios/:id/encerrar-sessoes', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  await db.query(`UPDATE users SET sessoes_validas_desde = now() WHERE id = $1`, [u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'master_encerrar_sessoes', recurso: 'users', recursoId: u.id });
  res.json({ ok: true });
});

// Redefinir a senha de um usuario de empresa: o servidor GERA uma senha aleatoria, que aparece UMA vez na resposta (nunca em log
// ou auditoria). Exige troca no proximo login e derruba as sessoes abertas do usuario. Nunca vale para o Master (so por script).
router.post('/master/usuarios/:id/redefinir-senha', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  const senha = gerarSenha();
  const hash = await bcrypt.hash(senha, 10);
  await db.query(`UPDATE users SET senha_hash = $1, deve_trocar_senha = true, sessoes_validas_desde = now(), falhas_login = 0 WHERE id = $2`, [hash, u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'master_redefinir_senha', recurso: 'users', recursoId: u.id });
  res.json({ senha_temporaria: senha });
});

// Alterar o e-mail de acesso de um usuario de empresa (unico no sistema). Derruba as sessoes abertas dele.
router.patch('/master/usuarios/:id/email', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  const novo = await validarNovoEmail(db, u.id, (req.body || {}).email);
  const ant = (await db.query(`SELECT email FROM users WHERE id = $1`, [u.id])).rows[0].email;
  if (novo === ant) throw new HttpError(400, 'este já é o e-mail de acesso do usuário');
  await db.query(`UPDATE users SET email = $1, sessoes_validas_desde = now() WHERE id = $2`, [novo, u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'master_alterar_email', recurso: 'users', recursoId: u.id, detalhes: { anterior: ant, novo } });
  res.json({ email: novo });
});

// O Master pode resetar o 2FA de qualquer usuario (inclusive outro Master nao: so por script).
router.post('/master/usuarios/:id/2fa/resetar', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  await resetarDoisFatores(db, u.id);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'resetar_2fa', recurso: 'users', recursoId: u.id });
  res.json({ ok: true });
});

router.patch('/master/usuarios/:id/exigir-2fa', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  const exigido = !!(req.body || {}).exigido;
  await db.query(`UPDATE users SET totp_exigido = $1 WHERE id = $2`, [exigido, u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: exigido ? 'exigir_2fa' : 'dispensar_2fa', recurso: 'users', recursoId: u.id });
  res.json({ exigido });
});

router.patch('/master/usuarios/:id/status', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  const ativo = !!(req.body || {}).ativo;
  await db.query(`UPDATE users SET ativo = $1 WHERE id = $2`, [ativo, u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: ativo ? 'master_ativar_usuario' : 'master_desativar_usuario', recurso: 'users', recursoId: u.id });
  res.json({ ativo });
});

// Permissao "Modo teste" por usuario (so as chaves ajustaveis; normalizarOverrides descarta o que for igual ao padrao do perfil).
router.patch('/master/usuarios/:id/permissoes', async (req, res) => {
  const u = await alvoOuErro(req.params.id);
  const b = req.body || {};
  if (typeof b.ModoTeste !== 'boolean') throw new HttpError(400, 'informe ModoTeste: true ou false');
  const permissoes = normalizarOverrides(u.perfil, { ...(u.permissoes || {}), ModoTeste: b.ModoTeste });
  if (permissoes === false) throw new HttpError(400, 'permissões inválidas');
  await db.query(`UPDATE users SET permissoes = $1 WHERE id = $2`, [permissoes ? JSON.stringify(permissoes) : null, u.id]);
  await logAudit(db, { tenantId: u.tenant_id, usuarioId: req.user.id, acao: 'master_alterar_permissao', recurso: 'users', recursoId: u.id, detalhes: { ModoTeste: b.ModoTeste } });
  res.json({ ModoTeste: b.ModoTeste });
});

module.exports = router;
