// Backups do banco de producao.
//
// Formatos (campo backups.formato):
//  - "pgdump": pg_dump -Fc (so quando o pg_dump existe no servidor). Restaura com pg_restore.
//  - "js": arquivo .gbk.gz feito em JavaScript, sem depender de pg_dump (hospedagem compartilhada):
//      linha 1: JSON de cabecalho { formato: 'girostock-js-v1', versao_schema, criado_em, tabelas: [...], contagens: {...} }
//      depois, para cada tabela (na ordem das chaves estrangeiras):
//        "@@TABELA {"tabela":"x","colunas":["a","b"]}"  +  linhas do COPY ... TO STDOUT (formato texto)  +  "@@FIM"
//      O formato texto do COPY escapa quebras de linha dentro dos dados, entao cada registro e UMA linha do arquivo.
//  Ficam FORA do backup as tabelas de controle: schema_migrations, teste_copias, backups e erros_sistema
//  (o registro dos backups precisa sobreviver a uma restauracao; erros sao descartaveis).
//  A leitura e feita em transacao READ ONLY / REPEATABLE READ (foto consistente).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');
const { spawn, spawnSync } = require('child_process');
const { from: copyFrom, to: copyTo } = require('pg-copy-streams');
const pool = require('../db/pool');
const config = require('./config');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const { tabelasEmOrdem, colunas, anonimizarClientes, contagens, SEM_DADOS, NEUTRAS } = require('./copiaProducao');
const modoTeste = require('./modoTeste');

const LOCK_BACKUP = 727002;
const FORMATO_JS = 'girostock-js-v1';
const SEGURANCA = process.env.NODE_ENV !== 'production';

function dirBackups() {
  return process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(__dirname, '..', '..', 'backups');
}

// Pasta gravavel? Nunca lanca: a tela mostra o erro e nada quebra.
function diretorioPronto() {
  const dir = dirBackups();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, `.teste-${process.pid}`);
    fs.writeFileSync(t, 'ok');
    fs.unlinkSync(t);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, erro: 'a pasta de backups não existe ou não pode ser gravada (confira BACKUP_DIR)' };
  }
}

// pg_dump/pg_restore leem a conexao de variaveis de ambiente do processo filho (nunca da linha de comando, para a senha
// nao aparecer na lista de processos). PGDATABASE sozinho nao aceita URL completa, entao separamos as partes.
function envDeConexao(url) {
  const u = new URL(url);
  return { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

function binPg(nome) {
  return process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, nome) : nome;
}
function temPgDump() {
  try { return spawnSync(binPg('pg_dump'), ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch { return false; }
}
function temPgRestore() {
  try { return spawnSync(binPg('pg_restore'), ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch { return false; }
}

function curto(err) {
  return String((err && err.message) || err || 'erro').replace(/postgres(ql)?:\/\/\S+/gi, '[url-banco]').slice(0, 200);
}

async function ultimaMigration(db) {
  try { return (await db.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`)).rows[0].filename; } catch { return null; }
}

function sha256DoArquivo(arquivo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(arquivo).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- geracao
async function dumpJs(destino, falharEm) {
  const leitura = await pool.producao.connect();
  try {
    await leitura.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tabelas = await tabelasEmOrdem(leitura);
    const cont = await contagens(leitura, tabelas);
    const gz = zlib.createGzip();
    const saida = fs.createWriteStream(destino);
    const fim = new Promise((res, rej) => { saida.on('finish', res); saida.on('error', rej); gz.on('error', rej); });
    gz.pipe(saida);
    gz.write(`${JSON.stringify({ formato: FORMATO_JS, versao_schema: await ultimaMigration(leitura), criado_em: new Date().toISOString(), tabelas, contagens: cont })}\n`);
    for (const t of tabelas) {
      const cols = (await colunas(leitura, t)).map((c) => c.replace(/"/g, ''));
      gz.write(`@@TABELA ${JSON.stringify({ tabela: t, colunas: cols })}\n`);
      const origem = leitura.query(copyTo(`COPY (SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}") TO STDOUT`));
      await new Promise((res, rej) => { origem.on('error', rej); origem.on('end', res); origem.on('data', (d) => { if (!gz.write(d)) { origem.pause(); gz.once('drain', () => origem.resume()); } }); });
      gz.write('@@FIM\n');
      if (SEGURANCA && falharEm === t) throw new Error(`falha simulada após copiar ${t}`);
    }
    gz.end();
    await fim;
    await leitura.query('ROLLBACK');
  } catch (err) {
    await leitura.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    leitura.release();
  }
}

function dumpPg(destino) {
  return new Promise((resolve, reject) => {
    const args = ['-w', '-Fc', '--no-owner', '-f', destino, '--exclude-table=backups', '--exclude-table=erros_sistema', '--exclude-table=teste_copias', '--exclude-table=erros_sistema_id_seq'];
    // A URL do banco vai por variavel de ambiente do processo filho (nunca na linha de comando).
    const p = spawn(binPg('pg_dump'), args, { env: { ...process.env, ...envDeConexao(process.env.DATABASE_URL) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump falhou (${curto(err)})`))));
  });
}

// opcoes: { tipo: 'manual' | 'automatico', usuarioId, usarPgDump (true/false/undefined=auto), falharEm (so testes) }
// Devolve o registro; null se for automatico e ja houver um no dia.
async function gerarBackup(opcoes = {}) {
  const { tipo = 'manual', usuarioId = null, usarPgDump, falharEm, diaDe } = opcoes;
  const pronto = diretorioPronto();
  if (!pronto.ok) throw new HttpError(503, pronto.erro);
  const trava = await pool.producao.connect();
  let id = null;
  let parcial = null;
  try {
    const lock = await trava.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_BACKUP]);
    if (!lock.rows[0].ok) throw new HttpError(409, 'já existe um backup em andamento');
    if (tipo === 'automatico') {
      const inicioDoDia = new Date(diaDe || Date.now()); inicioDoDia.setHours(0, 0, 0, 0);
      const ja = await trava.query(`SELECT 1 FROM backups WHERE tipo = 'automatico' AND criado_em >= $1 LIMIT 1`, [inicioDoDia]);
      if (ja.rows.length > 0) return null;
    }
    const pg = usarPgDump === false ? false : (usarPgDump === true || temPgDump());
    const formato = pg ? 'pgdump' : 'js';
    const nome = `girostock-${carimbo()}-${crypto.randomBytes(2).toString('hex')}-${tipo}.${pg ? 'dump' : 'gbk.gz'}`; // sufixo aleatorio: dois backups no mesmo segundo nunca colidem
    const arquivo = path.join(pronto.dir, nome);
    parcial = `${arquivo}.parcial`;
    const ins = await trava.query(
      `INSERT INTO backups (arquivo, tipo, status, formato, criado_por, versao_schema) VALUES ($1, $2, 'gerando', $3, $4, $5) RETURNING id`,
      [nome, tipo, formato, usuarioId, await ultimaMigration(trava)]
    );
    id = ins.rows[0].id;
    try {
      if (pg) await dumpPg(parcial); else await dumpJs(parcial, falharEm);
      fs.renameSync(parcial, arquivo);
      parcial = null;
      const tam = fs.statSync(arquivo).size;
      const sha = await sha256DoArquivo(arquivo);
      await trava.query(`UPDATE backups SET status = 'concluido', tamanho_bytes = $2, sha256 = $3, concluido_em = now() WHERE id = $1`, [id, tam, sha]);
      await logAudit(trava, { tenantId: await tenantPlataforma(trava), usuarioId, acao: 'master_backup_gerar', recurso: 'backups', recursoId: id, detalhes: { tipo, formato, tamanho_bytes: tam } }).catch(() => {});
    } catch (err) {
      if (parcial) fs.rmSync(parcial, { force: true });
      await trava.query(`UPDATE backups SET status = 'falhou', erro = $2, arquivo = NULL, concluido_em = now() WHERE id = $1`, [id, curto(err)]);
      await logAudit(trava, { tenantId: await tenantPlataforma(trava), usuarioId, acao: 'master_backup_falhou', recurso: 'backups', recursoId: id, detalhes: { tipo, erro: curto(err) } }).catch(() => {});
    }
    return (await trava.query(`SELECT * FROM backups WHERE id = $1`, [id])).rows[0];
  } finally {
    await trava.query('SELECT pg_advisory_unlock($1)', [LOCK_BACKUP]).catch(() => {});
    trava.release();
  }
}

async function tenantPlataforma(db) {
  const r = await db.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`);
  return r.rows[0] && r.rows[0].id;
}

// ---------------------------------------------------------------- consulta / download / remocao
const COLUNAS_PUBLICAS = `b.id, b.arquivo, b.tamanho_bytes, b.tipo, b.status, b.formato, b.erro, b.criado_em, b.concluido_em, b.versao_schema, u.nome AS criado_por_nome`;

async function listar() {
  const { rows } = await pool.producao.query(`SELECT ${COLUNAS_PUBLICAS} FROM backups b LEFT JOIN users u ON u.id = b.criado_por ORDER BY b.criado_em DESC LIMIT 200`);
  const usado = rows.filter((r) => r.status === 'concluido').reduce((s, r) => s + Number(r.tamanho_bytes || 0), 0);
  return { backups: rows, usado_bytes: usado };
}

async function backupConcluido(id) {
  const { rows } = await pool.producao.query(`SELECT * FROM backups WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'backup não encontrado');
  const b = rows[0];
  if (b.status !== 'concluido' || !b.arquivo) throw new HttpError(409, 'este backup não está concluído');
  return b;
}

// Caminho do arquivo (so o nome fica no banco); confere existencia e SHA-256 antes de entregar.
async function arquivoVerificado(id) {
  const b = await backupConcluido(id);
  const arquivo = path.join(dirBackups(), path.basename(b.arquivo));
  if (!fs.existsSync(arquivo)) throw new HttpError(404, 'o arquivo deste backup não foi encontrado no servidor');
  if ((await sha256DoArquivo(arquivo)) !== b.sha256) throw new HttpError(409, 'o arquivo do backup não confere com o registro (SHA-256); não será entregue');
  return { backup: b, arquivo };
}

async function remover(id, usuarioId) {
  const { rows } = await pool.producao.query(`SELECT * FROM backups WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'backup não encontrado');
  if (rows[0].status === 'gerando') throw new HttpError(409, 'o backup ainda está sendo gerado');
  if (rows[0].arquivo) fs.rmSync(path.join(dirBackups(), path.basename(rows[0].arquivo)), { force: true });
  await pool.producao.query(`DELETE FROM backups WHERE id = $1`, [id]);
  await logAudit(pool.producao, { tenantId: await tenantPlataforma(pool.producao), usuarioId, acao: 'master_backup_remover', recurso: 'backups', recursoId: id, detalhes: { tipo: rows[0].tipo } });
}

// ---------------------------------------------------------------- agendador e retencao
// Retencao: apaga so backups AUTOMATICOS mais antigos que backup_retencao_dias (nunca os manuais).
async function aplicarRetencao() {
  const dias = await config.obter('backup_retencao_dias');
  const { rows } = await pool.producao.query(
    `SELECT id, arquivo FROM backups WHERE tipo = 'automatico' AND status <> 'gerando' AND criado_em < now() - make_interval(days => $1)`, [dias]
  );
  for (const r of rows) {
    if (r.arquivo) fs.rmSync(path.join(dirBackups(), path.basename(r.arquivo)), { force: true });
    await pool.producao.query(`DELETE FROM backups WHERE id = $1`, [r.id]);
  }
  return rows.length;
}

// Um ciclo do agendador: gera o backup automatico do dia se ja passou da hora configurada e ainda nao houve um hoje.
// Falhou -> fica registrado como "falhou" e so tenta de novo amanha (o registro conta como a tentativa do dia).
async function executarAutomaticoSeDevido(agora = new Date(), opcoes = {}) {
  const cfg = await config.todos();
  if (!cfg.backup_automatico) return null;
  const [h, m] = String(cfg.backup_hora).split(':').map(Number);
  if (agora.getHours() * 60 + agora.getMinutes() < h * 60 + m) return null;
  const r = await gerarBackup({ tipo: 'automatico', diaDe: agora, ...opcoes }).catch((err) => { if (err.status === 409) return null; throw err; });
  if (r) await aplicarRetencao().catch(() => {});
  return r;
}

let timer = null;
function iniciarAgendador() {
  if (timer) return;
  const tick = () => executarAutomaticoSeDevido().catch((err) => console.error('backup automático:', curto(err)));
  timer = setInterval(tick, 60 * 1000);
  timer.unref();
}

// ---------------------------------------------------------------- restauracao
// Le o arquivo .gbk.gz e grava dentro da transacao ja aberta no `cliente`: TRUNCATE das tabelas do backup + COPY em ordem.
async function restaurarJsEm(cliente, arquivo, { falharNaTabela } = {}) {
  const linhas = readline.createInterface({ input: fs.createReadStream(arquivo).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let cabecalho = null;
  let copia = null;
  const restauradas = [];
  try {
    for await (const linha of linhas) {
      if (!cabecalho) {
        cabecalho = JSON.parse(linha);
        if (cabecalho.formato !== FORMATO_JS) throw new HttpError(400, 'arquivo de backup em formato desconhecido');
        await cliente.query(`TRUNCATE ${cabecalho.tabelas.map((t) => `"${t}"`).join(', ')} CASCADE`);
      } else if (copia === null && linha.startsWith('@@TABELA ')) {
        const { tabela, colunas: cols } = JSON.parse(linha.slice(9));
        if (!cabecalho.tabelas.includes(tabela) || !/^[a-z0-9_]+$/.test(tabela) || cols.some((c) => !/^[a-z0-9_]+$/.test(c))) throw new HttpError(400, 'arquivo de backup inválido');
        copia = { tabela, stream: cliente.query(copyFrom(`COPY "${tabela}" (${cols.map((c) => `"${c}"`).join(', ')}) FROM STDIN`)) };
      } else if (copia && linha === '@@FIM') {
        await new Promise((res, rej) => { copia.stream.on('finish', res); copia.stream.on('error', rej); copia.stream.end(); });
        restauradas.push(copia.tabela);
        if (SEGURANCA && falharNaTabela === copia.tabela) throw new Error(`falha simulada após restaurar ${copia.tabela}`);
        copia = null;
      } else if (copia) {
        if (!copia.stream.write(`${linha}\n`)) await once(copia.stream, 'drain');
      }
    }
  } catch (err) {
    if (copia) { copia.stream.on('error', () => {}); copia.stream.destroy(); }
    throw err;
  } finally {
    linhas.close();
  }
  if (!cabecalho || copia) throw new HttpError(400, 'arquivo de backup incompleto');
  return { cabecalho, restauradas };
}

function pgRestore(arquivo, urlBanco) {
  return new Promise((resolve, reject) => {
    const p = spawn(binPg('pg_restore'), ['-w', '--clean', '--if-exists', '--no-owner', '--single-transaction', '-d', envDeConexao(urlBanco).PGDATABASE, arquivo], { env: { ...process.env, ...envDeConexao(urlBanco) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore falhou (${curto(err)})`))));
  });
}

// Substitui o banco de TESTE pelo conteudo do backup. Producao nunca e tocada.
async function restaurarNoTeste(id, { usuarioId, tenantId, anonimizar = true, falharNaTabela } = {}) {
  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
  if (modoTeste.estaCopiando()) throw new HttpError(409, 'já existe uma cópia ou restauração em andamento');
  const { backup, arquivo } = await arquivoVerificado(id);
  await modoTeste.garantirBancoTeste();
  modoTeste.marcarCopia(true); // sessoes em modo teste recebem 503 enquanto isso
  try {
    let tabelas = [];
    if (backup.formato === 'pgdump') {
      if (!temPgRestore()) throw new HttpError(409, 'este backup é do tipo pg_dump e o servidor não tem pg_restore');
      await pgRestore(arquivo, process.env.DATABASE_URL_TESTE);
    } else {
      const escrita = await pool.teste().connect();
      try {
        await escrita.query('BEGIN');
        const r = await restaurarJsEm(escrita, arquivo, { falharNaTabela });
        tabelas = r.restauradas;
        // Segredos de 2FA nunca ficam no banco de teste.
        await escrita.query(`UPDATE users SET totp_segredo_cript = NULL, totp_ativo = false, totp_ativado_em = NULL, totp_ultimo_passo = NULL, totp_falhas = 0, totp_bloqueado_ate = NULL`);
        await escrita.query(`DELETE FROM user_recovery_codes`);
        if (anonimizar) await anonimizarClientes(escrita);
        const total = await contagens(escrita, tabelas);
        await escrita.query(`INSERT INTO teste_copias (copiado_por, contagens) VALUES ($1, $2)`, [usuarioId || null, JSON.stringify({ ...total, _anonimizado: !!anonimizar, _origem_backup: backup.arquivo })]);
        await escrita.query('COMMIT');
        await logAudit(pool.producao, { tenantId, usuarioId, acao: 'master_restaurar_teste', recurso: 'backups', recursoId: id, detalhes: { arquivo: backup.arquivo, anonimizado: !!anonimizar } });
        return { contagens: total, anonimizado: !!anonimizar };
      } catch (err) {
        await escrita.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        escrita.release();
      }
    }
    await logAudit(pool.producao, { tenantId, usuarioId, acao: 'master_restaurar_teste', recurso: 'backups', recursoId: id, detalhes: { arquivo: backup.arquivo, formato: 'pgdump' } });
    return { contagens: null, anonimizado: false };
  } finally {
    modoTeste.marcarCopia(false);
  }
}

module.exports = {
  dirBackups, diretorioPronto, temPgDump, temPgRestore, gerarBackup, listar, arquivoVerificado, remover, aplicarRetencao,
  executarAutomaticoSeDevido, iniciarAgendador, restaurarJsEm, restaurarNoTeste, pgRestore, sha256DoArquivo, curto, FORMATO_JS,
};
