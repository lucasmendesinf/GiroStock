// Agenda publica de eventos (Fase 4): o site do cliente lista os eventos marcados "Divulgar no site", pela chave publica da
// empresa (vai no codigo do site; so le eventos publicados). Usada pelo widget /agenda.js e por sites com integracao propria.
const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { dadosDaEmpresa, efetivos } = require('../utils/limites');
const { FUSO } = require('../utils/query');

const CHAVE_RE = /^ag_[0-9a-f]{32}$/;
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const novaChave = () => `ag_${crypto.randomBytes(16).toString('hex')}`;
const urlImagem = (base, id) => `${base}/api/loja/v1/imagens/${id}`;

async function agendaDaEmpresa(db, tenantId) {
  const atual = (await db.query(`SELECT * FROM eventos_agenda WHERE tenant_id = $1`, [tenantId])).rows[0];
  if (atual) return atual;
  const { rows } = await db.query(
    `INSERT INTO eventos_agenda (tenant_id, chave) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET atualizado_em = eventos_agenda.atualizado_em RETURNING *`,
    [tenantId, novaChave()]
  );
  return rows[0];
}

async function trocarChave(db, tenantId) {
  await agendaDaEmpresa(db, tenantId);
  return (await db.query(`UPDATE eventos_agenda SET chave = $2, atualizado_em = now() WHERE tenant_id = $1 RETURNING *`, [tenantId, novaChave()])).rows[0];
}

async function definirAtiva(db, tenantId, ativa) {
  await agendaDaEmpresa(db, tenantId);
  return (await db.query(`UPDATE eventos_agenda SET ativa = $2, atualizado_em = now() WHERE tenant_id = $1 RETURNING *`, [tenantId, !!ativa])).rows[0];
}

// Empresa da chave. Chave invalida: 401. Agenda desligada, empresa suspensa ou sem o modulo: 403.
async function empresaDaChave(db, chave) {
  if (!CHAVE_RE.test(String(chave || ''))) throw new HttpError(401, 'chave da agenda ausente ou inválida');
  const ag = (await db.query(`SELECT * FROM eventos_agenda WHERE chave = $1`, [chave])).rows[0];
  if (!ag) throw new HttpError(401, 'chave da agenda ausente ou inválida');
  const emp = await dadosDaEmpresa(db, ag.tenant_id);
  if (!ag.ativa || !emp || emp.status !== 'ativa' || !efetivos(emp).recursos.eventos) throw new HttpError(403, 'agenda indisponível');
  return { tenantId: ag.tenant_id, empresa: emp.nome };
}

const SELECT_PUBLICO = `
  SELECT e.id, e.nome, e.descricao, e.atracoes, e.inicio, e.fim, e.status, e.preco_ingresso, e.link_ingresso, e.imagem_id,
         to_char(e.inicio AT TIME ZONE '${FUSO}', 'DD/MM/YYYY') AS data_br, to_char(e.inicio AT TIME ZONE '${FUSO}', 'HH24:MI') AS hora,
         to_char(e.fim AT TIME ZONE '${FUSO}', 'HH24:MI') AS hora_fim, EXTRACT(DOW FROM e.inicio AT TIME ZONE '${FUSO}')::int AS dow,
         EXTRACT(MONTH FROM e.inicio AT TIME ZONE '${FUSO}')::int AS mes, to_char(e.inicio AT TIME ZONE '${FUSO}', 'DD') AS dia
  FROM eventos e
  WHERE e.tenant_id = $1 AND e.publicado_site AND e.status IN ('agendado', 'aberto')
    AND COALESCE(e.fim, e.inicio + interval '12 hours') > now()`;

function publico(base, r) {
  return {
    id: r.id, nome: r.nome, descricao: r.descricao, atracoes: r.atracoes, inicio: r.inicio, fim: r.fim,
    em_andamento: r.status === 'aberto',
    data: r.data_br, dia: r.dia, mes: MESES[r.mes - 1], dia_semana: SEMANA[r.dow], hora: r.hora, hora_fim: r.hora_fim,
    preco_ingresso: r.preco_ingresso === null ? null : Number(r.preco_ingresso),
    link_ingresso: r.link_ingresso || null,
    imagem: r.imagem_id ? urlImagem(base, r.imagem_id) : null,
  };
}

async function eventosPublicos(db, tenantId, base, limite = 20) {
  const n = Math.min(Math.max(Number(limite) || 20, 1), 50);
  const { rows } = await db.query(`${SELECT_PUBLICO} ORDER BY e.inicio LIMIT ${n}`, [tenantId]);
  return rows.map((r) => publico(base, r));
}

async function eventoPublico(db, tenantId, base, id) {
  const { rows } = await db.query(`${SELECT_PUBLICO} AND e.id = $2`, [tenantId, id]);
  if (!rows.length) throw new HttpError(404, 'evento não encontrado');
  return publico(base, rows[0]);
}

module.exports = { CHAVE_RE, agendaDaEmpresa, trocarChave, definirAtiva, empresaDaChave, eventosPublicos, eventoPublico };
