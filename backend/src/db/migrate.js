require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function run() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (rows.length > 0) {
      console.log(`skip (ja aplicada): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`aplicando: ${file}`);
    // ALTER TYPE ... ADD VALUE nao roda dentro de transacao no PostgreSQL < 12: executa essas linhas antes, fora dela
    // (sao idempotentes, com IF NOT EXISTS) e o restante do arquivo segue na transacao.
    const reAddValue = /^[ \t]*ALTER TYPE[^;]*ADD VALUE[^;]*;[ \t]*$/gim;
    for (const stmt of sql.match(reAddValue) || []) await pool.query(stmt);
    const restante = sql.replace(reAddValue, '');
    await pool.query('BEGIN');
    try {
      await pool.query(restante);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }

  console.log('migrations concluidas');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
