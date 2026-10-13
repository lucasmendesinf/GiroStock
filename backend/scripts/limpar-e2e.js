// Remove do banco de DESENVOLVIMENTO as empresas "E2E ..." e os usuarios criados pelos testes e2e (e2e.*@girostock.local,
// ui2fa@teste.local), com todos os dados deles. Uso:  npm run limpar-e2e
// Recusa rodar em producao (NODE_ENV=production) e nao toca em nenhuma outra empresa/usuario.
require('dotenv').config();
const pool = require('../src/db/pool');
const { tabelasEmOrdem } = require('../src/services/copiaProducao');

(async () => {
  if (process.env.NODE_ENV === 'production') {
    console.error('Recusado: este script só roda em desenvolvimento.');
    process.exit(1);
  }
  const c = await pool.producao.connect();
  try {
    const ordem = (await tabelasEmOrdem(c)).reverse();
    await c.query('BEGIN');
    const ten = (await c.query(`SELECT id FROM tenants WHERE nome LIKE 'E2E %'`)).rows.map((r) => r.id);
    const usr = (await c.query(
      `SELECT id FROM users WHERE tenant_id = ANY($1) OR lower(email::text) LIKE 'e2e.%@girostock.local' OR lower(email::text) = 'ui2fa@teste.local'`, [ten]
    )).rows.map((r) => r.id);
    const comTenant = new Set((await c.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'`)).rows.map((r) => r.table_name));
    const refs = (await c.query(
      `SELECT cl.relname AS tabela, at.attname AS coluna, NOT at.attnotnull AS anulavel
         FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class rf ON rf.oid = k.confrelid
         JOIN pg_attribute at ON at.attrelid = k.conrelid AND at.attnum = k.conkey[1]
        WHERE k.contype = 'f' AND rf.relname = 'users' AND cl.relname <> 'users'`
    )).rows;
    await c.query(`UPDATE users SET location_id = NULL WHERE id = ANY($1)`, [usr]);
    for (const t of ordem) {
      if (t === 'tenants' || t === 'users' || !comTenant.has(t)) continue;
      await c.query(`DELETE FROM "${t}" WHERE tenant_id = ANY($1)`, [ten]);
    }
    for (const { tabela, coluna, anulavel } of refs) {
      if (tabela === 'tenants') continue;
      if (anulavel) await c.query(`UPDATE "${tabela}" SET "${coluna}" = NULL WHERE "${coluna}" = ANY($1)`, [usr]);
      else await c.query(`DELETE FROM "${tabela}" WHERE "${coluna}" = ANY($1)`, [usr]);
    }
    const du = await c.query(`DELETE FROM users WHERE id = ANY($1)`, [usr]);
    const dt = await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [ten]);
    await c.query('COMMIT');
    console.log(`removidos: ${dt.rowCount} empresa(s) e ${du.rowCount} usuário(s) de teste`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ERRO (nada foi alterado):', e.message);
    process.exitCode = 1;
  }
  c.release();
  process.exit();
})();
