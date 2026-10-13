// Sessoes de suporte: o Master entra numa empresa ativa como Administrador, por tempo curto, com motivo, auditado.
// O JWT de suporte (claim `suporte`) NAO basta: a cada requisicao o servidor confere a linha em sessoes_suporte
// (encerrada? vencida? senha do Master trocada? empresa suspensa?).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const { DURACAO_MIN } = require('../config/suporteBloqueios');

const fp = (senhaHash) => crypto.createHash('sha256').update(String(senhaHash)).digest('hex').slice(0, 16);

function formatarQuando(d) {
  return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

// Marca como vencidas (e audita) as sessoes cujo prazo passou. Chamada pelo servidor a cada minuto e ao consultar o historico.
async function encerrarVencidas(db = pool.producao) {
  const { rows } = await db.query(
    `UPDATE sessoes_suporte SET encerrada_em = now(), encerrada_por = 'expirou' WHERE encerrada_em IS NULL AND expira_em <= now() RETURNING id, master_id, tenant_id`
  );
  for (const s of rows) {
    await logAudit(db, { tenantId: s.tenant_id, usuarioId: s.master_id, acao: 'master_suporte_expirar', recurso: 'sessoes_suporte', recursoId: s.id }).catch(() => {});
  }
  return rows.length;
}

async function encerrar(db, sessaoId, por) {
  const { rows } = await db.query(
    `UPDATE sessoes_suporte SET encerrada_em = now(), encerrada_por = $2 WHERE id = $1 AND encerrada_em IS NULL RETURNING id, master_id, tenant_id`, [sessaoId, por]
  );
  return rows[0] || null;
}

// Confere a sessao a cada requisicao. Devolve { sessao, empresa } ou lanca HttpError 401/403.
async function validarSessao(db, sessaoId, user, dadosEmpresa) {
  const { rows } = await db.query(`SELECT s.*, u.senha_hash FROM sessoes_suporte s JOIN users u ON u.id = s.master_id WHERE s.id = $1`, [sessaoId]);
  const s = rows[0];
  if (!s || s.master_id !== user.id) throw new HttpError(401, 'sessão de suporte inválida');
  if (s.encerrada_em) throw new HttpError(401, 'sessão de suporte encerrada');
  if (new Date(s.expira_em) <= new Date()) {
    await encerrarVencidas(db);
    throw new HttpError(401, 'sessão de suporte encerrada');
  }
  if (fp(s.senha_hash) !== s.senha_fp) {
    await encerrar(db, s.id, 'sistema');
    throw new HttpError(401, 'sessão de suporte encerrada: a senha do Master foi alterada');
  }
  const empresa = await dadosEmpresa(db, s.tenant_id);
  if (!empresa || empresa.status === 'suspensa') {
    await encerrar(db, s.id, 'sistema');
    throw new HttpError(401, 'sessão de suporte encerrada: a empresa foi suspensa');
  }
  return { sessao: s, empresa };
}

// O codigo do 2FA do Master so e pedido quando a empresa acessada TEM verificacao em duas etapas ativa
// (algum usuario ativo dela com 2FA). Empresa sem 2FA: entra so com o motivo.
async function clienteTemDoisFatores(db, tenantId) {
  const r = await db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND ativo AND totp_ativo LIMIT 1`, [tenantId]);
  return r.rows.length > 0;
}

// Inicia o suporte. `reautenticar(userId, codigo)` confere o codigo TOTP recente do Master (lanca se invalido).
async function iniciar({ master, empresaId, motivo, edicao, avisar, codigo, ip, reautenticar, modoTesteAtivo }) {
  const db = pool.producao;
  const texto = String(motivo || '').trim();
  if (texto.length < 10) throw new HttpError(400, 'informe o motivo do acesso (mínimo de 10 caracteres)');
  if (texto.length > 300) throw new HttpError(400, 'o motivo pode ter no máximo 300 caracteres');
  if (modoTesteAtivo) throw new HttpError(409, 'saia do modo teste antes de entrar como suporte');
  const emp = (await db.query(`SELECT id, nome, status FROM tenants WHERE id = $1 AND nome <> 'Plataforma'`, [empresaId])).rows[0];
  if (!emp) throw new HttpError(404, 'empresa não encontrada');
  if (emp.status !== 'ativa') throw new HttpError(409, 'só empresas ativas podem receber suporte');
  await encerrarVencidas(db);
  // "Encerrar sessoes" do Master (sessoes_validas_desde) derruba o token de suporte: libera a linha para um novo acesso.
  await db.query(`UPDATE sessoes_suporte s SET encerrada_em = now(), encerrada_por = 'sistema' FROM users u WHERE u.id = s.master_id AND s.master_id = $1 AND s.encerrada_em IS NULL AND u.sessoes_validas_desde IS NOT NULL AND s.iniciada_em < u.sessoes_validas_desde`, [master.id]);
  const aberta = await db.query(`SELECT 1 FROM sessoes_suporte WHERE master_id = $1 AND encerrada_em IS NULL AND expira_em > now()`, [master.id]);
  if (aberta.rows.length > 0) throw new HttpError(409, 'já existe uma sessão de suporte aberta; encerre-a antes');

  // Reautenticacao: codigo TOTP recente do Master (sem ele, nada acontece).
  if (await clienteTemDoisFatores(db, emp.id)) {
    if (!codigo) throw new HttpError(400, 'esta empresa usa verificação em duas etapas: informe o código do seu app autenticador para confirmar');
    await reautenticar(master.id, codigo);
  }

  const { rows: u } = await db.query(`SELECT id, tenant_id, senha_hash FROM users WHERE id = $1`, [master.id]);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const s = (await client.query(
      `INSERT INTO sessoes_suporte (master_id, tenant_id, motivo, edicao, avisou_admins, expira_em, senha_fp, ip)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7, $8) RETURNING id, iniciada_em, expira_em`,
      [master.id, emp.id, texto, !!edicao, !!avisar, DURACAO_MIN, fp(u[0].senha_hash), ip || null]
    )).rows[0];
    if (avisar) {
      await client.query(
        `INSERT INTO avisos_empresa (tenant_id, tipo, mensagem, sessao_suporte_id) VALUES ($1, 'suporte', $2, $3)`,
        [emp.id, `A equipe de suporte da plataforma acessou sua conta em ${formatarQuando(s.iniciada_em)}. Motivo: ${texto}`, s.id]
      );
    }
    await logAudit(client, { tenantId: emp.id, usuarioId: master.id, acao: 'master_suporte_iniciar', recurso: 'sessoes_suporte', recursoId: s.id, detalhes: { empresa: emp.nome, motivo: texto, edicao: !!edicao, avisou_admins: !!avisar, sessao_id: s.id } });
    await client.query('COMMIT');
    const segundos = Math.max(1, Math.floor((new Date(s.expira_em).getTime() - Date.now()) / 1000));
    // Token de no maximo 30 min e SEM renovacao (nao existe refresh). tenantId e o do proprio Master (confere com o banco).
    const token = jwt.sign({ sub: master.id, tenantId: u[0].tenant_id, perfil: 'Master', suporte: { sessaoId: s.id, tenantId: emp.id } }, process.env.JWT_SECRET, { expiresIn: segundos });
    return { token, sessao: { id: s.id, empresa: emp.nome, empresa_id: emp.id, edicao: !!edicao, expira_em: s.expira_em } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

let timer = null;
function iniciarVarredura() {
  if (timer) return;
  timer = setInterval(() => encerrarVencidas().catch(() => {}), 60 * 1000);
  timer.unref();
}

module.exports = { clienteTemDoisFatores, iniciar, encerrar, validarSessao, encerrarVencidas, iniciarVarredura, formatarQuando };
