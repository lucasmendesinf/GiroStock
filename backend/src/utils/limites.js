// Plano da empresa: limites (lojas, usuarios, PDVs) e recursos (Pedidos, Clientes).
// Valor efetivo = override da empresa (tenants.limites / tenants.recursos), senao o do plano (tabela planos).
const { HttpError } = require('./http');

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

// { limites: {lojas, usuarios, pdvs}, recursos: {pedidos, clientes}, origem: {...} } a partir da linha de dadosDaEmpresa.
function efetivos(e) {
  const ov = e.limites || {};
  const ovr = e.recursos || {};
  const pr = e.plano_recursos || {};
  const num = (v, padrao) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : padrao);
  const limites = {
    lojas: num(ov.lojas, e.max_lojas),
    usuarios: num(ov.usuarios, e.max_usuarios),
    pdvs: num(ov.pdvs, e.max_pdvs),
  };
  const recursos = {
    pedidos: typeof ovr.pedidos === 'boolean' ? ovr.pedidos : !!pr.pedidos,
    clientes: typeof ovr.clientes === 'boolean' ? ovr.clientes : !!pr.clientes,
  };
  const origem = {
    lojas: ov.lojas !== undefined && ov.lojas !== null ? 'empresa' : 'plano',
    usuarios: ov.usuarios !== undefined && ov.usuarios !== null ? 'empresa' : 'plano',
    pdvs: ov.pdvs !== undefined && ov.pdvs !== null ? 'empresa' : 'plano',
    pedidos: typeof ovr.pedidos === 'boolean' ? 'empresa' : 'plano',
    clientes: typeof ovr.clientes === 'boolean' ? 'empresa' : 'plano',
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

// Areas do usuario com os recursos da empresa aplicados: recurso desligado = area false para todos da empresa.
function aplicarRecursos(areas, recursos) {
  const r = { ...areas };
  if (recursos && recursos.pedidos === false) r.Pedidos = false;
  if (recursos && recursos.clientes === false) r.Clientes = false;
  return r;
}

module.exports = { dadosDaEmpresa, efetivos, uso, checarLimite, aplicarRecursos };
