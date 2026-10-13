// Modo teste: banco de teste separado da producao (DATABASE_URL_TESTE).
// Funcoes de apoio da ativacao: garantir que o banco existe e esta migrado, tabela de controle das copias,
// usuario presente no teste (chaves estrangeiras) e lista de empresas do teste.
const { Client } = require('pg');
const pool = require('../db/pool');
const { aplicarMigracoes } = require('../db/migrate');
const { HttpError } = require('../utils/http');

let copiaEmAndamento = false;
const estaCopiando = () => copiaEmAndamento;
const marcarCopia = (valor) => { copiaEmAndamento = !!valor; };

// Banco de teste acessivel e migrado. Se o banco nao existe, tenta cria-lo pela conexao da producao
// (precisa do privilegio CREATEDB); se nao der, orienta a criar manualmente (sem expor a URL).
async function garantirBancoTeste() {
  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
  const teste = pool.teste();
  try {
    const c = await teste.connect();
    c.release();
  } catch (err) {
    if (err.code !== '3D000') throw new HttpError(409, 'não foi possível conectar ao banco de teste');
    const nome = new URL(process.env.DATABASE_URL_TESTE).pathname.replace(/^\//, '');
    const admin = new URL(process.env.DATABASE_URL);
    admin.pathname = '/postgres';
    const cliente = new Client({ connectionString: admin.toString() });
    try {
      if (!/^[A-Za-z0-9_]+$/.test(nome)) throw new Error('nome de banco inválido');
      await cliente.connect();
      await cliente.query(`CREATE DATABASE "${nome}"`);
    } catch (e2) {
      throw new HttpError(409, 'o banco de teste ainda não existe e não pôde ser criado automaticamente: crie-o (mesmo usuário) e rode npm run migrate');
    } finally {
      await cliente.end().catch(() => {});
    }
  }
  await aplicarMigracoes(teste, () => {});
  await teste.query(`
    CREATE TABLE IF NOT EXISTS teste_copias (
      id SERIAL PRIMARY KEY,
      copiado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      copiado_por UUID,
      contagens JSONB
    )`);
}

async function ultimaCopia() {
  const { rows } = await pool.teste().query(`SELECT copiado_em, copiado_por, contagens FROM teste_copias ORDER BY id DESC LIMIT 1`);
  return rows[0] || null;
}

async function precisaCopiar() {
  return !(await ultimaCopia());
}

function valorParaPg(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
}

async function copiarLinha(tabela, id, ajustes = {}) {
  const { rows } = await pool.producao.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id]);
  const linha = rows[0] && { ...rows[0], ...ajustes };
  if (!linha) return false;
  const cols = Object.keys(linha);
  const sets = cols.filter((c) => c !== 'id').map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  await pool.teste().query(
    `INSERT INTO ${tabela} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (id) DO ${sets ? `UPDATE SET ${sets}` : 'NOTHING'}`,
    cols.map((c) => valorParaPg(linha[c]))
  );
  return true;
}

// O usuario logado (e a empresa dele) precisam existir no teste: ha chaves estrangeiras (operador_id etc.).
async function garantirUsuarioNoTeste(usuarioId) {
  const { rows } = await pool.producao.query(`SELECT id, tenant_id, location_id FROM users WHERE id = $1`, [usuarioId]);
  if (rows.length === 0) return;
  await copiarLinha('tenants', rows[0].tenant_id);
  const teste = pool.teste();
  // Loja criada na producao depois da copia: o usuario entra no teste sem loja principal (a FK exige que a loja exista).
  const lojaExiste = rows[0].location_id
    ? (await teste.query(`SELECT 1 FROM locations WHERE id = $1`, [rows[0].location_id])).rows.length > 0
    : true;
  try {
    // Segredos de 2FA nunca vao para o banco de teste.
    await copiarLinha('users', usuarioId, { ...(lojaExiste ? {} : { location_id: null }), totp_segredo_cript: null, totp_ativo: false, totp_ativado_em: null, totp_ultimo_passo: null, totp_falhas: 0, totp_bloqueado_ate: null });
  } catch (err) {
    if (err.code !== '23505' && err.code !== '23503') throw err; // e-mail ja usado no teste / loja ausente: segue
  }
}

async function empresasDoTeste() {
  const { rows } = await pool.teste().query(`SELECT id, nome FROM tenants WHERE nome <> 'Plataforma' ORDER BY nome`);
  return rows;
}

module.exports = { garantirBancoTeste, ultimaCopia, precisaCopiar, garantirUsuarioNoTeste, empresasDoTeste, estaCopiando, marcarCopia };
