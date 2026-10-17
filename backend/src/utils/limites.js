// Plano da empresa: limites (lojas, usuarios, PDVs) e recursos = modulos liberados (PDV, Lanchonete, Pedidos...).
// Valor efetivo = override da empresa (tenants.limites / tenants.recursos), senao o do plano (tabela planos),
// senao o padrao do modulo (config/modulos.js). Modulo sem a dependencia ligada fica desligado.
const { HttpError } = require('./http');
const { MODULOS, aplicarDependencias } = require('../config/modulos');

const NOME_LIMITE = { lojas: 'lojas', usuarios: 'usuários', pdvs: 'PDVs' };

async function dadosDaEmpresa(db, tenantId) {
  const { rows } = await db.query(
    `SELECT t.id, t.nome, t.documento, t.status, t.suspenso_motivo, t.suspenso_em, t.plano, t.limites, t.recursos, t.criado_em,
            p.nome AS plano_nome, p.max_lojas, p.max_usuarios, p.max_pdvs, p.recursos AS plano_recursos
     FROM tenants t LEFT JOIN planos p ON p.codigo = t.plano WHERE t.id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

// Modulos de um plano (recursos JSONB), com o padrao de cada modulo para as chaves que o plano nao tem.
function modulosDoPlano(recursosPlano) {
  const pr = recursosPlano || {};
  return Object.fromEntries(MODULOS.map((m) => [m.chave, typeof pr[m.chave] === 'boolean' ? pr[m.chave] : m.padrao]));
}

// { limites: {lojas, usuarios, pdvs}, recursos: {pdv, lanchonete, pedidos, ...}, origem: {...} } a partir da linha de dadosDaEmpresa.
function efetivos(e) {
  const ov = e.limites || {};
  const ovr = e.recursos || {};
  const doPlano = modulosDoPlano(e.plano_recursos);
  const num = (v, padrao) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : padrao);
  const limites = {
    lojas: num(ov.lojas, e.max_lojas),
    usuarios: num(ov.usuarios, e.max_usuarios),
    pdvs: num(ov.pdvs, e.max_pdvs),
  };
  const recursos = aplicarDependencias(Object.fromEntries(MODULOS.map((m) => [m.chave, typeof ovr[m.chave] === 'boolean' ? ovr[m.chave] : doPlano[m.chave]])));
  const origem = {
    lojas: ov.lojas !== undefined && ov.lojas !== null ? 'empresa' : 'plano',
    usuarios: ov.usuarios !== undefined && ov.usuarios !== null ? 'empresa' : 'plano',
    pdvs: ov.pdvs !== undefined && ov.pdvs !== null ? 'empresa' : 'plano',
    ...Object.fromEntries(MODULOS.map((m) => [m.chave, typeof ovr[m.chave] === 'boolean' ? 'empresa' : 'plano'])),
  };
  return { limites, recursos, origem };
}

async function uso(db, tenantId) {
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM locations WHERE tenant_id = $1 AND ativo) AS lojas,
            (SELECT COUNT(*)::int FROM users WHERE tenant_id = $1 AND ativo AND perfil <> 'Master') AS usuarios,
            (SELECT COUNT(*)::int FROM terminals WHERE tenant_id = $1 AND ativo) AS pdvs`,
    [tenantId]
  );
  return rows[0];
}

// Chamado ANTES de criar: 409 com mensagem clara quando o limite do plano seria excedido.
async function checarLimite(db, tenantId, tipo, adicionar = 1) {
  const e = await dadosDaEmpresa(db, tenantId);
  if (!e) return; // sem linha de empresa (nao deveria acontecer): nao bloqueia
  const lim = efetivos(e).limites[tipo];
  const usados = (await uso(db, tenantId))[tipo];
  if (usados + adicionar > lim) {
    throw new HttpError(409, `limite de ${NOME_LIMITE[tipo]} do plano atingido: ${usados} de ${lim}`);
  }
}

// Areas do usuario com os modulos da empresa aplicados: modulo desligado = suas areas false para todos da empresa.
function aplicarRecursos(areas, recursos) {
  const r = { ...areas };
  if (!recursos) return r;
  for (const m of MODULOS) {
    if (recursos[m.chave] === false) for (const a of m.areas) r[a] = false;
  }
  return r;
}

module.exports = { dadosDaEmpresa, efetivos, uso, checarLimite, aplicarRecursos, modulosDoPlano };
