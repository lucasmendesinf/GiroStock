// Administracao de usuarios fora da tela (ex.: producao sem terminal).
//   npm run usuarios                       -> lista usuarios (nome, e-mail, perfil, ativo); nao mostra senhas
//   RESET_EMAIL=... RESET_PASSWORD=... npm run usuarios
//                                          -> redefine a senha do usuario com esse e-mail (a senha vem do ambiente,
//                                             digitada por quem administra; apague as duas variaveis depois)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

async function run() {
  const email = (process.env.RESET_EMAIL || '').trim();
  const senha = process.env.RESET_PASSWORD || '';
  if (email && senha) {
    if (senha.length < 6) throw new Error('a senha precisa ter ao menos 6 caracteres');
    const r = await pool.query(
      'UPDATE users SET senha_hash = $1, ativo = true WHERE lower(email::text) = lower($2) RETURNING nome, email',
      [await bcrypt.hash(senha, 10), email]
    );
    if (r.rowCount === 0) throw new Error(`nenhum usuario com o e-mail ${email}`);
    console.log(`senha redefinida para: ${r.rows.map((u) => `${u.nome} <${u.email}>`).join(', ')}`);
  } else {
    const r = await pool.query(
      `SELECT u.nome, u.email, u.perfil, u.ativo, t.nome AS empresa FROM users u JOIN tenants t ON t.id = u.tenant_id ORDER BY t.nome, u.criado_em`
    );
    console.log(`${r.rowCount} usuario(s):`);
    r.rows.forEach((u) => console.log(`- ${u.nome} <${u.email}> · ${u.perfil} · ${u.ativo ? 'ativo' : 'inativo'} · ${u.empresa}`));
  }
  await pool.end();
}

run().catch((err) => { console.error(err.message); process.exit(1); });
