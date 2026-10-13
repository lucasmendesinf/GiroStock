// Configuracoes globais (tabela config_global) com valores padrao no codigo e cache em memoria.
// Chave ausente = padrao; nada muda enquanto os valores estiverem nos padroes. O cache vale 5 s e e invalidado ao salvar
// (com mais de um processo, os outros enxergam a mudanca em ate 5 s).
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');

const PADROES = {
  vip_limite_padrao: 400,
  cliente_risco_dias: 30,
  cliente_inativo_dias: 60,
  pedido_atrasado_min: 25,
  backup_retencao_dias: 30,
  backup_hora: '03:00',
  backup_automatico: true,
  manutencao: { ativo: false, mensagem: '' },
};

const TTL_MS = 5000;
let cache = null;
let cacheEm = 0;

async function todos() {
  if (cache && Date.now() - cacheEm < TTL_MS) return cache;
  const c = { ...PADROES };
  try {
    const { rows } = await pool.producao.query('SELECT chave, valor FROM config_global');
    for (const r of rows) if (r.chave in PADROES) c[r.chave] = r.valor;
  } catch (err) { /* tabela ainda nao migrada: usa os padroes */ }
  cache = c;
  cacheEm = Date.now();
  return c;
}

async function obter(chave) {
  return (await todos())[chave];
}

function invalidar() { cache = null; }

function inteiro(v, min, max, nome) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new HttpError(400, `${nome} inválido: use um número inteiro de ${min}${max !== undefined ? ` a ${max}` : ' em diante'}`);
  }
  return n;
}

// Valida e normaliza os parametros editaveis pela tela (faixas: dias >= 1, minutos >= 1, retencao 1-365, VIP >= 0).
function validarParametros(b) {
  const r = {};
  if (b.vip_limite_padrao !== undefined) {
    const n = Number(b.vip_limite_padrao);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'valor VIP inválido: use 0 ou mais');
    r.vip_limite_padrao = n;
  }
  if (b.cliente_risco_dias !== undefined) r.cliente_risco_dias = inteiro(b.cliente_risco_dias, 1, undefined, 'dias para cliente em risco');
  if (b.cliente_inativo_dias !== undefined) r.cliente_inativo_dias = inteiro(b.cliente_inativo_dias, 1, undefined, 'dias para cliente inativo');
  if (b.pedido_atrasado_min !== undefined) r.pedido_atrasado_min = inteiro(b.pedido_atrasado_min, 1, undefined, 'minutos de pedido atrasado');
  if (b.backup_retencao_dias !== undefined) r.backup_retencao_dias = inteiro(b.backup_retencao_dias, 1, 365, 'retenção de backups');
  if (b.backup_hora !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.backup_hora))) throw new HttpError(400, 'hora do backup inválida: use HH:MM');
    r.backup_hora = String(b.backup_hora);
  }
  if (b.backup_automatico !== undefined) {
    if (typeof b.backup_automatico !== 'boolean') throw new HttpError(400, 'backup automático deve ser verdadeiro ou falso');
    r.backup_automatico = b.backup_automatico;
  }
  return r;
}

async function salvar(db, chave, valor, usuarioId) {
  await db.query(
    `INSERT INTO config_global (chave, valor, atualizado_por) VALUES ($1, $2, $3)
     ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`,
    [chave, JSON.stringify(valor), usuarioId || null]
  );
  invalidar();
}

// Parametros que o front precisa conhecer (entregues em /auth/me).
async function parametrosPublicos() {
  const c = await todos();
  return { pedidoAtrasadoMin: c.pedido_atrasado_min };
}

const PARAMETROS = ['vip_limite_padrao', 'cliente_risco_dias', 'cliente_inativo_dias', 'pedido_atrasado_min', 'backup_retencao_dias', 'backup_hora', 'backup_automatico'];

module.exports = { PADROES, PARAMETROS, todos, obter, invalidar, validarParametros, salvar, parametrosPublicos };
