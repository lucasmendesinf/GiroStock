require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const dir = path.join(__dirname, 'migrations');

// Aplica as migrations pendentes no banco `db` (um Pool). Usado pelo script (producao e teste) e pelo modo teste.
async function aplicarMigracoes(db, log = console.log) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_em TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (rows.length > 0) {
        log(`skip (ja aplicada): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      log(`aplicando: ${file}`);
      // ALTER TYPE ... ADD VALUE nao roda dentro de transacao no PostgreSQL < 12: executa essas linhas antes, fora dela
      // (sao idempotentes, com IF NOT EXISTS) e o restante do arquivo segue na transacao.
      const reAddValue = /^[ \t]*ALTER TYPE[^;]*ADD VALUE[^;]*;[ \t]*$/gim;
      for (const stmt of sql.match(reAddValue) || []) await client.query(stmt);
      const restante = sql.replace(reAddValue, '');
      await client.query('BEGIN');
      try {
        await client.query(restante);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function run() {
  console.log('== banco de producao ==');
  await aplicarMigracoes(pool.producao);

  // O banco de teste recebe a mesma estrutura (extensoes incluidas, pois fazem parte da migration 001).
  if (pool.testeConfigurado()) {
    console.log('== banco de teste ==');
    try {
      await aplicarMigracoes(pool.teste());
    } catch (err) {
      if (err.code === '3D000') console.warn('banco de teste ainda nao existe: crie-o (ou ative o modo teste pelo painel Master) e rode de novo.');
      else throw err;
    }
  } else if (process.env.DATABASE_URL_TESTE) {
    console.warn('DATABASE_URL_TESTE igual a DATABASE_URL: modo teste indisponivel (o banco de teste nao foi migrado).');
  }

  console.log('migrations concluidas');
  await pool.end();
}

module.exports = { aplicarMigracoes };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
