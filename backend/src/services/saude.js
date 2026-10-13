// Saude do sistema para a Visao geral do painel Master. Nada aqui lanca erro por indisponibilidade:
// cada bloco devolve { status: 'ok' | 'atencao' | 'erro' | 'indisponivel', ... }.
// Limiares (documentados): latencia do banco > 500 ms = atencao; migration pendente = erro; memoria do sistema > 85% = atencao;
// disco > 85% = atencao (> 95% = erro); carga > 100% dos nucleos = atencao.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db/pool');

const LIMIAR_USO = 85;
const dirMigrations = path.join(__dirname, '..', 'db', 'migrations');

function versaoDaApi() {
  try { return require('../../package.json').version; } catch { return null; }
}

// Migrations aplicadas x arquivos existentes. Pendentes = arquivos ainda nao aplicados no banco `db`.
async function verificarMigracoes(db) {
  const arquivos = fs.readdirSync(dirMigrations).filter((f) => f.endsWith('.sql')).sort();
  let aplicadas = [];
  try {
    aplicadas = (await db.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename);
  } catch { aplicadas = []; }
  const pendentes = arquivos.filter((f) => !aplicadas.includes(f));
  return { arquivos: arquivos.length, aplicadas: arquivos.length - pendentes.length, pendentes };
}

// Checagem de um banco: latencia, versao, tamanho e migrations.
async function checarBanco(db) {
  const t0 = process.hrtime.bigint();
  try {
    await db.query('SELECT 1');
  } catch (err) {
    return { status: 'erro', online: false, mensagem: 'banco não respondeu' };
  }
  const latenciaMs = Number(process.hrtime.bigint() - t0) / 1e6;
  try {
    const v = (await db.query('SHOW server_version')).rows[0].server_version;
    const tam = Number((await db.query('SELECT pg_database_size(current_database()) AS t')).rows[0].t);
    const mig = await verificarMigracoes(db);
    let status = 'ok';
    if (latenciaMs > 500) status = 'atencao';
    if (mig.pendentes.length > 0) status = 'erro';
    return { status, online: true, latenciaMs: Math.round(latenciaMs * 10) / 10, versao: v, tamanhoBytes: tam, migrations: mig };
  } catch (err) {
    return { status: 'erro', online: true, latenciaMs: Math.round(latenciaMs), mensagem: 'não foi possível ler os detalhes do banco' };
  }
}

// Disco da pasta do processo. fs.statfs so existe no Node >= 18.15: sem ele, "indisponivel" (sem excecao).
function checarDisco(statfs = fs.statfs, dir = process.cwd()) {
  return new Promise((resolve) => {
    if (typeof statfs !== 'function') return resolve({ status: 'indisponivel', motivo: 'o Node deste servidor não oferece a leitura de disco' });
    try {
      statfs(dir, (err, s) => {
        if (err || !s || !s.blocks) return resolve({ status: 'indisponivel', motivo: 'leitura de disco não permitida neste servidor' });
        const total = s.blocks * s.bsize;
        const livre = s.bavail * s.bsize;
        const pct = Math.round(((total - livre) / total) * 100);
        resolve({ status: pct > 95 ? 'erro' : pct > LIMIAR_USO ? 'atencao' : 'ok', totalBytes: total, livreBytes: livre, usoPct: pct });
      });
    } catch { resolve({ status: 'indisponivel', motivo: 'leitura de disco não permitida neste servidor' }); }
  });
}

function checarMemoria() {
  const total = os.totalmem();
  const livre = os.freemem();
  const pct = Math.round(((total - livre) / total) * 100);
  return { status: pct > LIMIAR_USO ? 'atencao' : 'ok', totalBytes: total, livreBytes: livre, usoPct: pct, processoBytes: process.memoryUsage().rss };
}

// Carga media (1 min) em % dos nucleos. No Windows loadavg() e sempre 0: "indisponivel".
function checarCarga(plataforma = os.platform()) {
  if (plataforma === 'win32') return { status: 'indisponivel', motivo: 'o Windows não informa a carga do processador' };
  const nucleos = os.cpus().length || 1;
  const pct = Math.round((os.loadavg()[0] / nucleos) * 100);
  return { status: pct > 100 ? 'atencao' : 'ok', usoPct: pct, nucleos };
}

async function saude() {
  const banco = await checarBanco(pool.producao);
  let bancoTeste = { status: 'indisponivel', motivo: 'banco de teste não configurado' };
  if (pool.testeConfigurado()) {
    try { bancoTeste = await checarBanco(pool.teste()); } catch { bancoTeste = { status: 'erro', online: false, mensagem: 'banco de teste não respondeu' }; }
  }
  const disco = await checarDisco();
  const memoria = checarMemoria();
  const carga = checarCarga();
  const commit = (process.env.GIT_COMMIT || '').slice(0, 7) || null;
  return {
    verificadoEm: new Date().toISOString(),
    api: { status: 'ok', online: true, uptimeSeg: Math.round(process.uptime()), versao: versaoDaApi(), commit, node: process.version },
    banco,
    bancoTeste,
    recursos: { memoria, disco, carga },
  };
}

module.exports = { saude, verificarMigracoes, checarBanco, checarDisco, checarCarga, checarMemoria };
