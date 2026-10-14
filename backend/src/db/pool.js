const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Atalho para hospedagem sem editar senha: DATABASE_NOME_TESTE (so o NOME do segundo banco) monta a URL do teste a partir da
// DATABASE_URL (mesmo servidor, usuario e senha). DATABASE_URL_TESTE, se existir, continua mandando.
if (!process.env.DATABASE_URL_TESTE && process.env.DATABASE_NOME_TESTE && process.env.DATABASE_URL) {
  try {
    const u = new URL(process.env.DATABASE_URL);
    u.pathname = '/' + String(process.env.DATABASE_NOME_TESTE).trim();
    process.env.DATABASE_URL_TESTE = u.toString();
  } catch (err) { /* DATABASE_URL invalida: o modo teste fica indisponivel */ }
}

// Dois bancos: producao (DATABASE_URL) e teste (DATABASE_URL_TESTE). O resto do sistema continua usando
// `require('../db/pool')` como antes: este objeto delega ao banco do contexto atual. Sem contexto = producao
// (inclusive scripts, jobs e workers). O contexto "teste" so e aberto em middleware/auth.js, depois de validar o token.
const contexto = new AsyncLocalStorage();

const producao = new Pool({ connectionString: process.env.DATABASE_URL });
// Conexao ociosa derrubada pelo banco (reinicio, timeout de rede) emite 'error' no pool;
// sem este listener o Node encerraria o processo.
producao.on('error', (err) => {
  console.error('erro em conexao ociosa do PostgreSQL:', err.message);
});

class ModoTesteIndisponivel extends Error {
  constructor(msg = 'modo teste não configurado') {
    super(msg);
    this.status = 409;
  }
}

// host:porta/banco, sem usuario/senha (nunca expomos DATABASE_URL*). localhost e 127.0.0.1 contam como o mesmo servidor.
function identidade(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === '::1' || host === '[::1]') host = 'localhost';
    return `${host}:${u.port || '5432'}${u.pathname}`;
  } catch (err) {
    return null;
  }
}

// Trava de seguranca: sem DATABASE_URL_TESTE, ou igual a DATABASE_URL, o modo teste fica indisponivel
// (nunca cair na producao por engano).
function testeConfigurado() {
  const t = identidade(process.env.DATABASE_URL_TESTE || '');
  const p = identidade(process.env.DATABASE_URL || '');
  return !!t && t !== p;
}

let teste = null;
function poolTeste() {
  if (!testeConfigurado()) throw new ModoTesteIndisponivel();
  if (!teste) {
    teste = new Pool({ connectionString: process.env.DATABASE_URL_TESTE });
    teste.on('error', (err) => console.error('erro em conexao ociosa do banco de teste:', err.message));
  }
  return teste;
}

function emTeste() {
  const ctx = contexto.getStore();
  return !!ctx && ctx.modo === 'teste';
}

// Banco da requisicao atual. Contexto de teste nunca cai em producao: sem configuracao, falha.
function atual() {
  return emTeste() ? poolTeste() : producao;
}

module.exports = {
  query: (...args) => atual().query(...args),
  connect: (...args) => atual().connect(...args),
  on: (...args) => producao.on(...args),
  end: async () => {
    await producao.end();
    if (teste) await teste.end();
  },
  producao,
  teste: poolTeste,
  testeConfigurado,
  emTeste,
  // Executa `fn` com o banco de teste como banco de negocio.
  executarEmTeste: (fn) => contexto.run({ modo: 'teste' }, fn),
  contexto,
  ModoTesteIndisponivel,
};
