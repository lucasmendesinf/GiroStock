// Contexto da requisicao durante uma sessao de suporte (AsyncLocalStorage): aberto em middleware/auth.js e lido por
// utils/audit.js, que marca TODO registro de auditoria feito nessa requisicao (um ponto so, sem editar cada rota).
const { AsyncLocalStorage } = require('async_hooks');

const armazenamento = new AsyncLocalStorage();

module.exports = {
  executar: (contexto, fn) => armazenamento.run(contexto, fn),
  atual: () => armazenamento.getStore() || null,
};
