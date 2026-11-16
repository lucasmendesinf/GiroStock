// "Testar sem gravar" no suporte do Master: copia a empresa atendida para o banco de teste (cadastros + ultimos 30 dias),
// o Master testa la como Administrador (nada vai para a conta do cliente) e, no fim, a copia e apagada.
// Fim do teste: "Encerrar teste" / "Voltar ao suporte", fim da sessao de suporte (encerrada ou vencida) ou 2 horas parado.
// O controle mora na producao (suporte_testes); a varredura de 1 em 1 minuto apaga o que ficou para tras (inclusive apos reinicio).
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const copiaEmpresa = require('./copiaEmpresa');
const suporte = require('./suporte');

const DIAS = 30;
const PARADO_MIN = 120;
const db = () => pool.producao;

// Caminhos (sem /api) que nao valem no teste do suporte: painel Master e a conta do proprio Master.
function bloqueio(metodo, caminho) {
  if (metodo === 'POST' && caminho === '/master/suporte/testar/encerrar') return null;
  if (/^\/master(\/|$)/.test(caminho)) return 'O painel Master não está disponível no teste do suporte.';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo) && /^\/auth\/(change-password|alterar-email|modo-teste|2fa)(\/|$)/.test(caminho)) {
    return 'Senha, 2FA e modo teste não podem ser alterados no teste do suporte.';
  }
  return null;
}

function tokenDoTeste(master, teste, sessao) {
  const segundos = Math.max(1, Math.floor((new Date(sessao.expiraEm).getTime() - Date.now()) / 1000));
  return jwt.sign(
    { sub: master.id, tenantId: master.tenantIdProprio, perfil: 'Master', modo: 'teste', empresaTeste: sessao.empresaId, suporteTeste: { id: teste.id, sessaoId: sessao.sessaoId } },
    process.env.JWT_SECRET,
    { expiresIn: segundos }
  );
}

// Inicia (ou refaz) o teste da sessao de suporte atual. `user` e o req.user da sessao de suporte.
async function iniciar(user) {
  const s = user.suporte;
  if (!s) throw new HttpError(409, 'abra uma sessão de suporte antes de testar');
  if (!pool.testeConfigurado()) throw new HttpError(409, 'o banco de teste não está configurado neste servidor');
  await varrer().catch(() => {});
  const ativo = (await db().query(
    `SELECT id, sessao_suporte_id FROM suporte_testes WHERE tenant_id = $1 AND encerrado_em IS NULL`, [s.empresaId]
  )).rows;
  if (ativo.some((t) => t.sessao_suporte_id !== s.sessaoId)) throw new HttpError(409, 'outro Master está testando esta empresa agora');
  // Teste anterior desta mesma sessao: a nova copia substitui a antiga.
  if (ativo.length) await db().query(`UPDATE suporte_testes SET encerrado_em = now(), encerrado_por = 'novo_teste' WHERE id = ANY($1::uuid[])`, [ativo.map((t) => t.id)]);

  const r = await copiaEmpresa.copiarEmpresa(s.empresaId, { dias: DIAS });
  const teste = (await db().query(
    `INSERT INTO suporte_testes (sessao_suporte_id, tenant_id, master_id, contagens) VALUES ($1, $2, $3, $4) RETURNING id`,
    [s.sessaoId, s.empresaId, user.id, JSON.stringify({ ...r.contagens, _dias: DIAS })]
  )).rows[0];
  // As copias anteriores desta empresa (ja encerradas) foram substituidas por esta: nada mais a apagar delas.
  await db().query(`UPDATE suporte_testes SET apagado_em = now() WHERE tenant_id = $1 AND id <> $2 AND encerrado_em IS NOT NULL AND apagado_em IS NULL`, [s.empresaId, teste.id]);
  await logAudit(db(), {
    tenantId: s.empresaId, usuarioId: user.id, acao: 'master_suporte_testar', recurso: 'suporte_testes', recursoId: teste.id,
    detalhes: { sessao_id: s.sessaoId, dias: DIAS, linhas: r.linhas },
  }).catch(() => {});
  const prop = (await db().query(`SELECT tenant_id FROM users WHERE id = $1`, [user.id])).rows[0];
  const token = tokenDoTeste({ id: user.id, tenantIdProprio: prop.tenant_id }, teste, s);
  return { token, teste: { id: teste.id, dias: DIAS, linhas: r.linhas } };
}

// Encerra um teste e apaga a copia da empresa do banco de teste. Devolve a linha encerrada (ou null).
async function encerrar(testeId, por) {
  const t = (await db().query(
    `UPDATE suporte_testes SET encerrado_em = now(), encerrado_por = $2 WHERE id = $1 AND encerrado_em IS NULL RETURNING id, tenant_id, master_id, sessao_suporte_id`,
    [testeId, por]
  )).rows[0];
  await apagarPendentes();
  return t || null;
}

// Apaga do banco de teste as copias de testes encerrados (se nao houver outro teste ativo da mesma empresa).
async function apagarPendentes() {
  const { rows } = await db().query(
    `SELECT DISTINCT tenant_id FROM suporte_testes t WHERE encerrado_em IS NOT NULL AND apagado_em IS NULL`
  );
  for (const { tenant_id: tenantId } of rows) {
    const ativo = (await db().query(`SELECT 1 FROM suporte_testes WHERE tenant_id = $1 AND encerrado_em IS NULL`, [tenantId])).rows.length > 0;
    try {
      if (!ativo) await copiaEmpresa.apagarEmpresa(tenantId);
      await db().query(`UPDATE suporte_testes SET apagado_em = now() WHERE tenant_id = $1 AND encerrado_em IS NOT NULL AND apagado_em IS NULL`, [tenantId]);
    } catch (err) {
      console.error('teste do suporte: não foi possível apagar a cópia da empresa (nova tentativa em 1 minuto)', err.message);
    }
  }
}

// Fim por sessao de suporte encerrada/vencida ou 2 horas parado; depois apaga as copias.
async function varrer() {
  await db().query(
    `UPDATE suporte_testes t SET encerrado_em = now(),
            encerrado_por = CASE WHEN s.encerrada_em IS NOT NULL OR s.expira_em <= now() THEN 'suporte_encerrado' ELSE 'parado' END
       FROM sessoes_suporte s
      WHERE s.id = t.sessao_suporte_id AND t.encerrado_em IS NULL
        AND (s.encerrada_em IS NOT NULL OR s.expira_em <= now() OR t.ultimo_uso_em < now() - make_interval(mins => $1))`,
    [PARADO_MIN]
  );
  await apagarPendentes();
}

const usoGravado = new Map(); // testeId -> ms (grava o "ultimo uso" no maximo 1x por minuto)

// Confere o token do teste a cada requisicao. Devolve { teste, sessao, empresa } ou lanca HttpError
// (com `suporteAtivo` = true quando so o teste acabou e a sessao de suporte continua valida).
async function validar(claim, user, dadosDaEmpresa) {
  const t = (await db().query(`SELECT * FROM suporte_testes WHERE id = $1`, [claim && claim.id])).rows[0];
  if (!t || t.master_id !== user.id || t.sessao_suporte_id !== claim.sessaoId) throw new HttpError(401, 'teste do suporte inválido');
  let ativa;
  try {
    ativa = await suporte.validarSessao(db(), t.sessao_suporte_id, user, dadosDaEmpresa);
  } catch (err) {
    if (!t.encerrado_em) encerrar(t.id, 'suporte_encerrado').catch(() => {});
    throw err;
  }
  const erroTeste = (msg) => Object.assign(new HttpError(401, msg), { suporteAtivo: true });
  if (t.encerrado_em) throw erroTeste('o teste foi encerrado: a cópia da empresa foi apagada');
  if (new Date(t.ultimo_uso_em).getTime() < Date.now() - PARADO_MIN * 60000) {
    await encerrar(t.id, 'parado');
    throw erroTeste('o teste foi encerrado depois de 2 horas parado');
  }
  const agora = Date.now();
  if (!usoGravado.has(t.id) || agora - usoGravado.get(t.id) > 60000) {
    usoGravado.set(t.id, agora);
    db().query(`UPDATE suporte_testes SET ultimo_uso_em = now() WHERE id = $1`, [t.id]).catch(() => {});
  }
  return { teste: t, sessao: ativa.sessao, empresa: ativa.empresa };
}

let timer = null;
function iniciarVarredura() {
  if (timer || !pool.testeConfigurado()) return;
  varrer().catch(() => {}); // apos reinicio: apaga o que ficou para tras
  timer = setInterval(() => varrer().catch(() => {}), 60 * 1000);
  timer.unref();
}

module.exports = { iniciar, encerrar, varrer, validar, bloqueio, iniciarVarredura, apagarPendentes, DIAS, PARADO_MIN };
