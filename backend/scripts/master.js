// Cria ou atualiza o usuario Master (dono da plataforma). So existe por script: a tela de usuarios nao cria Master.
//   MASTER_EMAIL=... MASTER_PASSWORD=... MASTER_NOME=... npm run master
// Os valores vem do ambiente (digitados por quem administra); nada e impresso alem de "nome <e-mail>".
// O Master pertence a uma empresa especial "Plataforma" (sem lojas, sem produtos). Idempotente.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function run() {
  const email = (process.env.MASTER_EMAIL || '').trim();
  const senha = process.env.MASTER_PASSWORD || '';
  const nome = (process.env.MASTER_NOME || '').trim() || 'Master';
  if (!EMAIL_RE.test(email)) throw new Error('informe MASTER_EMAIL com um e-mail válido');
  if (senha.length < 8) throw new Error('MASTER_PASSWORD precisa ter ao menos 8 caracteres');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let tenant = await client.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`);
    if (tenant.rows.length === 0) tenant = await client.query(`INSERT INTO tenants (nome) VALUES ('Plataforma') RETURNING id`);
    const tenantId = tenant.rows[0].id;

    const hash = await bcrypt.hash(senha, 10);
    const existente = await client.query(`SELECT id, tenant_id, perfil FROM users WHERE lower(email::text) = lower($1)`, [email]);
    let acao;
    if (existente.rows.length === 0) {
      await client.query(
        `INSERT INTO users (tenant_id, nome, email, senha_hash, perfil, location_id, ativo, permissoes) VALUES ($1, $2, $3, $4, 'Master', NULL, true, NULL)`,
        [tenantId, nome, email, hash]
      );
      acao = 'criado';
    } else {
      if (existente.rows[0].perfil !== 'Master') {
        throw new Error('já existe um usuário comum com este e-mail; use outro e-mail para o Master');
      }
      await client.query(`UPDATE users SET nome = $1, senha_hash = $2, ativo = true, tenant_id = $3 WHERE id = $4`, [nome, hash, tenantId, existente.rows[0].id]);
      acao = 'atualizado';
    }
    await client.query('COMMIT');
    console.log(`master ${acao}: ${nome} <${email}>`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

run().catch((err) => { console.error(err.message); process.exit(1); });
