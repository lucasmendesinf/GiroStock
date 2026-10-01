const { HttpError } = require('./http');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
// Datas dos filtros sao dias no fuso do Brasil (a loja fecha o dia em horario local).
const FUSO = 'America/Sao_Paulo';

// Acrescenta ao WHERE o filtro de periodo (data_inicio/data_fim, inclusivos, AAAA-MM-DD).
function filtroPeriodo(coluna, query, params) {
  let sql = '';
  const { data_inicio: inicio, data_fim: fim } = query || {};
  if (inicio) {
    if (!DATA_RE.test(inicio)) throw new HttpError(400, 'data_inicio deve estar no formato AAAA-MM-DD');
    params.push(inicio);
    sql += ` AND ${coluna} >= ($${params.length}::date::timestamp AT TIME ZONE '${FUSO}')`;
  }
  if (fim) {
    if (!DATA_RE.test(fim)) throw new HttpError(400, 'data_fim deve estar no formato AAAA-MM-DD');
    params.push(fim);
    sql += ` AND ${coluna} < (($${params.length}::date + 1)::timestamp AT TIME ZONE '${FUSO}')`;
  }
  return sql;
}

// limit/offset seguros (inteiros, com teto).
function paginacao(query, padrao = 50, maximo = 500) {
  let limit = parseInt((query && query.limit) || padrao, 10);
  let offset = parseInt((query && query.offset) || 0, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = padrao;
  if (limit > maximo) limit = maximo;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

module.exports = { filtroPeriodo, paginacao, FUSO };
