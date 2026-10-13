// Restaura um backup NA PRODUCAO (so por script, no servidor; a tela nunca faz isso).
//   BACKUP_ARQUIVO=girostock-AAAAMMDD-HHMMSS-manual.gbk.gz npm run restaurar-backup
//   (nome do arquivo dentro de BACKUP_DIR, ou caminho completo)
// O script: mostra a data do backup e quantos registros serao perdidos, exige a confirmacao digitada no terminal,
// cria ANTES um backup de seguranca, coloca o sistema em modo manutencao durante a operacao, restaura numa unica
// transacao (falhou = nada muda) e registra a auditoria. Nada de senhas ou URLs e impresso.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pool = require('../src/db/pool');
const config = require('../src/services/config');
const backup = require('../src/services/backup');
const { tabelasEmOrdem, contagens } = require('../src/services/copiaProducao');
const { logAudit } = require('../src/utils/audit');

function lerCabecalho(arquivo) {
  return new Promise((resolve, reject) => {
    const zlib = require('zlib');
    const entrada = fs.createReadStream(arquivo);
    const gunzip = entrada.pipe(zlib.createGunzip());
    gunzip.on('error', () => reject(new Error('arquivo de backup inválido')));
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
    rl.once('line', (l) => {
      let cab = null;
      try { cab = JSON.parse(l); } catch (e) { rl.close(); return reject(new Error('arquivo de backup inválido')); }
      resolve(cab); // resolve ANTES de fechar: o evento 'close' resolveria com null
      return rl.close();
    });
    rl.once('close', () => resolve(null));
  });
}

function perguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) => rl.question(texto, (r) => { rl.close(); ok(r); }));
}

(async () => {
  let manutencaoLigada = false;
  try {
    const entrada = process.env.BACKUP_ARQUIVO;
    if (!entrada) throw new Error('informe BACKUP_ARQUIVO (nome do arquivo em BACKUP_DIR ou caminho completo)');
    const arquivo = path.isAbsolute(entrada) ? entrada : path.join(backup.dirBackups(), path.basename(entrada));
    if (!fs.existsSync(arquivo)) throw new Error('arquivo de backup não encontrado');
    if (!/\.gbk\.gz$/.test(arquivo) && !/\.dump$/.test(arquivo)) throw new Error('formato de arquivo desconhecido');
    const ehDump = /\.dump$/.test(arquivo);

    const atuais = await contagens(pool.producao, await tabelasEmOrdem(pool.producao));
    const totalAtual = Object.values(atuais).reduce((s, n) => s + n, 0);
    let perdidos = totalAtual;
    let quando = 'desconhecida';
    if (!ehDump) {
      const cab = await lerCabecalho(arquivo);
      if (!cab || cab.formato !== backup.FORMATO_JS) throw new Error('arquivo de backup inválido');
      quando = new Date(cab.criado_em).toLocaleString('pt-BR');
      perdidos = Object.entries(atuais).reduce((s, [t, n]) => s + Math.max(0, n - ((cab.contagens || {})[t] || 0)), 0);
      console.log(`Backup de ${quando} (esquema ${cab.versao_schema}).`);
    } else {
      console.log('Backup no formato pg_dump (data não disponível sem abrir o arquivo).');
    }
    console.log(`A PRODUÇÃO ATUAL tem ${totalAtual} registros no total; ${ehDump ? 'tudo será substituído' : `cerca de ${perdidos} registro(s) criados depois do backup serão PERDIDOS`}.`);
    const resp = await perguntar('Digite RESTAURAR PRODUCAO para confirmar: ');
    if (resp.trim() !== 'RESTAURAR PRODUCAO') throw new Error('confirmação não digitada; nada foi alterado');

    console.log('Gerando backup de segurança antes de restaurar...');
    const seg = await backup.gerarBackup({ tipo: 'manual' });
    if (!seg || seg.status !== 'concluido') throw new Error('não foi possível criar o backup de segurança; nada foi alterado');
    console.log(`Backup de segurança: ${seg.arquivo}`);

    await config.salvar(pool.producao, 'manutencao', { ativo: true, mensagem: 'Sistema em manutenção (restauração de backup). Volte em alguns minutos.' }, null);
    manutencaoLigada = true;
    console.log('Modo manutenção ligado. Restaurando...');
    if (ehDump) {
      if (!backup.temPgRestore()) throw new Error('pg_restore não encontrado no servidor');
      await backup.pgRestore(arquivo, process.env.DATABASE_URL);
    } else {
      const c = await pool.producao.connect();
      try {
        await c.query('BEGIN');
        await backup.restaurarJsEm(c, arquivo);
        // a manutencao continua ligada ate o fim, mesmo que o backup tenha outro valor guardado
        await c.query(`INSERT INTO config_global (chave, valor) VALUES ('manutencao', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify({ ativo: true, mensagem: 'Sistema em manutenção (restauração de backup). Volte em alguns minutos.' })]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    }
    config.invalidar();
    const plat = (await pool.producao.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`)).rows[0];
    if (plat) await logAudit(pool.producao, { tenantId: plat.id, usuarioId: null, acao: 'master_restaurar_producao', recurso: 'backups', detalhes: { arquivo: path.basename(arquivo), backup_de_seguranca: seg.arquivo, registros_perdidos_estimados: perdidos } }).catch(() => {});
    await config.salvar(pool.producao, 'manutencao', { ativo: false, mensagem: '' }, null);
    manutencaoLigada = false;
    console.log('Restauração concluída. Modo manutenção desligado.');
  } catch (err) {
    console.error(`ERRO: ${backup.curto(err)}`);
    if (manutencaoLigada) {
      await config.salvar(pool.producao, 'manutencao', { ativo: false, mensagem: '' }, null).catch(() => {});
      console.error('Nada foi restaurado; o modo manutenção foi desligado.');
    }
    process.exitCode = 1;
  }
  await pool.producao.end().catch(() => {});
})();
