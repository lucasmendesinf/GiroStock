const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Conexao ociosa derrubada pelo banco (reinicio, timeout de rede) emite 'error' no pool;
// sem este listener o Node encerraria o processo.
pool.on('error', (err) => {
  console.error('erro em conexao ociosa do PostgreSQL:', err.message);
});

module.exports = pool;
