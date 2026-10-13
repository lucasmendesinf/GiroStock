// Emergencia: zera o 2FA de um usuario (inclusive o Master que perdeu o celular e os codigos de recuperacao).
//   RESET_EMAIL=usuario@empresa.com npm run resetar-2fa
// O usuario reativa no proximo login (Master/exigido: e obrigado) ou quando quiser. Imprime so "2FA resetado para <nome> <email>".
require('dotenv').config();
const pool = require('../src/db/pool');
const { resetarDoisFatores } = require('../src/services/usuarios');
const { logAudit } = require('../src/utils/audit');

async function run() {
  const email = (process.env.RESET_EMAIL || '').trim();
  if (!email) throw new Error('informe RESET_EMAIL com o e-mail do usuário');
  const { rows } = await pool.query(`SELECT id, tenant_id, nome, email FROM users WHERE lower(email::text) = lower($1)`, [email]);
  if (rows.length === 0) throw new Error(`nenhum usuário com o e-mail ${email}`);
  const u = rows[0];
  await resetarDoisFatores(pool, u.id);
  await logAudit(pool, { tenantId: u.tenant_id, usuarioId: null, acao: 'resetar_2fa', recurso: 'users', recursoId: u.id, detalhes: { origem: 'script resetar-2fa' } });
  console.log(`2FA resetado para ${u.nome} <${u.email}>`);
  await pool.end();
}

run().catch((err) => { console.error(err.message); process.exit(1); });
