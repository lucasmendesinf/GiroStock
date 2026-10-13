// Exportacao dos dados de UMA empresa (LGPD e migracao): arquivo .json.gz com um bloco por tabela.
// So linhas da empresa (tenant_id) e as filhas ligadas a ela. Nunca sai senha_hash, segredo/estado do TOTP,
// codigos de recuperacao nem tokens.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const pool = require('../db/pool');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const { dirBackups, diretorioPronto } = require('./backup');

const gzip = promisify(zlib.gzip);
const IGNORAR = ['schema_migrations', 'teste_copias', 'backups', 'config_global', 'avisos_globais', 'erros_sistema', 'planos', 'user_recovery_codes', 'tenants'];
// Filhas sem tenant_id: tabela -> [coluna, tabela-mae].
const FILHAS = { customer_addresses: ['customer_id', 'customers'], order_items: ['order_id', 'orders'], order_status_log: ['order_id', 'orders'] };
const COLUNA_SENSIVEL = /^(senha_hash|totp_.*|.*token.*|.*segredo.*)$/i;

function dirExportacoes() {
  return path.join(dirBackups(), 'exportacoes');
}

async function exportarEmpresa(tenantId, { usuarioId, tenantMaster }) {
  const pronto = diretorioPronto();
  if (!pronto.ok) throw new HttpError(503, pronto.erro);
  const db = pool.producao;
  const emp = (await db.query(`SELECT id, nome FROM tenants WHERE id = $1 AND nome <> 'Plataforma'`, [tenantId])).rows[0];
  if (!emp) throw new HttpError(404, 'empresa não encontrada');

  const tabelas = (await db.query(
    `SELECT t.table_name, ARRAY(SELECT c.column_name::text FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name ORDER BY c.ordinal_position) AS colunas
       FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' ORDER BY t.table_name`
  )).rows;
  const dados = {};
  const contagem = {};
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const empRow = (await cliente.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId])).rows[0];
    dados.tenants = [empRow];
    for (const t of tabelas) {
      const nome = t.table_name;
      if (IGNORAR.includes(nome)) continue;
      const cols = t.colunas.filter((c) => !COLUNA_SENSIVEL.test(c));
      const lista = cols.map((c) => `x."${c}"`).join(', ');
      let rows;
      if (t.colunas.includes('tenant_id')) {
        rows = (await cliente.query(`SELECT ${lista} FROM "${nome}" x WHERE x.tenant_id = $1`, [tenantId])).rows;
      } else if (FILHAS[nome]) {
        const [col, mae] = FILHAS[nome];
        rows = (await cliente.query(`SELECT ${lista} FROM "${nome}" x WHERE x."${col}" IN (SELECT id FROM "${mae}" WHERE tenant_id = $1)`, [tenantId])).rows;
      } else {
        continue; // tabela desconhecida sem vinculo com a empresa: nao exporta (na duvida, fora)
      }
      dados[nome] = rows;
    }
    await cliente.query('ROLLBACK');
  } finally {
    cliente.release();
  }
  for (const [k, v] of Object.entries(dados)) contagem[k] = v.length;

  fs.mkdirSync(dirExportacoes(), { recursive: true });
  const nomeArq = `empresa-${tenantId}-${Date.now()}.json.gz`;
  const corpo = JSON.stringify({ formato: 'girostock-exportacao-empresa-v1', gerado_em: new Date().toISOString(), empresa: { id: emp.id, nome: emp.nome }, contagens: contagem, tabelas: dados });
  fs.writeFileSync(path.join(dirExportacoes(), nomeArq), await gzip(Buffer.from(corpo)));
  await logAudit(db, { tenantId: tenantMaster, usuarioId, acao: 'master_exportar_empresa', recurso: 'tenants', recursoId: tenantId, detalhes: { empresa: emp.nome, arquivo: nomeArq, contagens: contagem } });
  return { arquivo: nomeArq, tamanho_bytes: fs.statSync(path.join(dirExportacoes(), nomeArq)).size, contagens: contagem, empresa: emp.nome };
}

function caminhoDaExportacao(nome) {
  if (!/^empresa-[0-9a-f-]{36}-\d+\.json\.gz$/.test(String(nome))) throw new HttpError(400, 'arquivo inválido');
  const p = path.join(dirExportacoes(), nome);
  if (!fs.existsSync(p)) throw new HttpError(404, 'exportação não encontrada');
  return p;
}

module.exports = { exportarEmpresa, caminhoDaExportacao };
