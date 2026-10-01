// Erro com status HTTP: pode ser lancado de qualquer rota (inclusive dentro de
// transacoes) e o handler de erros do app.js responde com { erro: message }.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Traduz erros do PostgreSQL que vem de dados enviados pelo cliente em respostas 4xx,
// em vez de 500. Retorna null para erros que sao realmente internos.
function mapPgError(err) {
  switch (err && err.code) {
    case '22P02': // invalid_text_representation (ex: uuid invalido)
    case '22003': // numeric_value_out_of_range
      return { status: 400, erro: 'valor ou identificador invalido na requisicao' };
    case '23503': // foreign_key_violation
      return { status: 400, erro: 'registro vinculado nao encontrado' };
    case '23505': // unique_violation
      return { status: 409, erro: 'registro duplicado' };
    case '23514': // check_violation
      return { status: 400, erro: `valor invalido (regra: ${err.constraint || 'restricao do banco'})` };
    case '40P01': // deadlock_detected
      return { status: 409, erro: 'operacao concorrente, tente novamente' };
    default:
      return null;
  }
}

module.exports = { HttpError, mapPgError };
