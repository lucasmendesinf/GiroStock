// Teste ponta a ponta do Painel Master, fase 3: backups, restauracao, exportacao, manutencao e configuracoes globais.
//
// Uso (API rodando em http://localhost:3000, banco migrado ate a 021, DATABASE_URL_TESTE configurado):
//   npm run test:e2e:master-fase3
//
// Cria empresas "E2E M3 ..." e usuarios e2e.m3.* pela API do Master (senhas aleatorias, so em memoria).
// Use somente em banco de DESENVOLVIMENTO. A restauracao pelo script roda num banco DESCARTAVEL (criado e apagado aqui),
// nunca na base de desenvolvimento. O modo manutencao e os parametros sao sempre devolvidos ao normal no final.
import 'dotenv/config';
import { createRequire } from 'node:module';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const SENHA_MASTER = rnd();
const EMAIL_MASTER = 'e2e.m3.master@girostock.local';
const email = (q) => `e2e.m3.${q}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
const teste = new pg.Client({ connectionString: process.env.DATABASE_URL_TESTE });
await teste.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rotaOriginal, body, tok, bruto = false) {
  try {
    const rota = method === 'GET' && /^\/master\/(empresas|usuarios|auditoria|uso)/.test(rotaOriginal) ? rotaOriginal + (rotaOriginal.includes('?') ? '&' : '?') + 'teste=1' : rotaOriginal; // dados E2E ficam ocultos por padrao
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    if (bruto) return { s: res.status, buf: Buffer.from(await res.arrayBuffer()) };
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const contar = async (c, t) => Number((await c.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);

// Estado a restaurar no final, aconteça o que acontecer
let MAS = null;
async function restaurarEstado() {
  try { await api('PUT', '/master/config/manutencao', { ativo: false, mensagem: '' }, MAS); } catch { /* ignora */ }
  await prod.query(`DELETE FROM config_global WHERE chave IN ('manutencao','pedido_atrasado_min','cliente_risco_dias','cliente_inativo_dias','vip_limite_padrao','backup_hora','backup_automatico','backup_retencao_dias')`);
  await prod.query(`UPDATE avisos_globais SET ativo = false, removido_em = now() WHERE ativo`);
  await prod.query(`UPDATE planos SET max_usuarios = 3 WHERE codigo = 'basico'`);
}
process.on('exit', () => {});

// ---------- preparo ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E M3 Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
MAS = await tokenDoMasterComDoisFatores(B, EMAIL_MASTER, SENHA_MASTER);
check('login do Master', !!MAS);
const masterId = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [EMAIL_MASTER])).rows[0].id;
const plataformaId = (await prod.query(`SELECT id FROM tenants WHERE nome = 'Plataforma' ORDER BY criado_em LIMIT 1`)).rows[0].id;

async function novaEmpresa(rotulo, plano = 'completo') {
  const r = await api('POST', '/master/empresas', { nome: `E2E M3 ${rotulo} ${SUF}`, plano, loja_nome: `Loja ${rotulo}`, admin: { nome: `Admin ${rotulo}`, email: email(rotulo.toLowerCase()) } }, MAS);
  if (r.s !== 201) throw new Error('empresa nao criada: ' + JSON.stringify(r.j));
  const senhaTemp = r.j.senha_temporaria;
  const lg = await login(email(rotulo.toLowerCase()), senhaTemp);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: senhaTemp, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, nome: r.j.empresa.nome, token: lg.j.token, senha: nova, email: email(rotulo.toLowerCase()) };
}
const A = await novaEmpresa('Alfa');
const Bm = await novaEmpresa('Beta');

try {
  // ---------- 1. Gerar backup ----------
  console.log('\n# 1. Gerar backup (manual), SHA-256, download e falhas');
  const negado = await api('GET', '/master/backups', null, A.token);
  check('administrador de empresa recebe 403', negado.s === 403, negado.s);
  const ger = await api('POST', '/master/backups', null, MAS);
  check('POST /master/backups -> 201 concluido', ger.s === 201 && ger.j.backup.status === 'concluido' && ger.j.backup.tamanho_bytes > 0, ger);
  const regB1 = (await prod.query(`SELECT * FROM backups WHERE id = $1`, [ger.j.backup.id])).rows[0];
  const arquivoB1 = path.join(process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(raiz, 'backups'), regB1.arquivo);
  check('arquivo existe, tamanho e SHA-256 conferem com o registro', fs.existsSync(arquivoB1) && sha(fs.readFileSync(arquivoB1)) === regB1.sha256 && fs.statSync(arquivoB1).size === Number(regB1.tamanho_bytes), { formato: regB1.formato });
  console.log(`  info  formato do backup do servidor: ${regB1.formato}`);
  const dl = await api('GET', `/master/backups/${regB1.id}/download`, null, MAS, true);
  check('download em streaming idêntico ao arquivo (mesmo SHA-256)', dl.s === 200 && sha(dl.buf) === regB1.sha256, dl.s);
  const lista = await api('GET', '/master/backups', null, MAS);
  check('listagem traz o backup, pasta ok, rotina e espaço usado', lista.j.pasta.ok && lista.j.backups.some((b) => b.id === regB1.id) && lista.j.usado_bytes > 0 && lista.j.rotina.hora, lista.j.rotina);

  const backup = require('../src/services/backup');
  const auto = async (d, o) => { require('../src/services/config').invalidar(); return backup.executarAutomaticoSeDevido(d, o); };
  const pool = require('../src/db/pool');
  // sem pg_dump (forcado): usa o formato JS
  const bjs = await backup.gerarBackup({ tipo: 'manual', usuarioId: masterId, usarPgDump: false });
  check('sem pg_dump (forçado): backup em formato JS concluído', bjs.status === 'concluido' && bjs.formato === 'js' && /\.gbk\.gz$/.test(bjs.arquivo), bjs);
  const dirB = backup.dirBackups();
  // cabecalho e contagens do JS
  const cab = await new Promise((ok) => { const rl = require('readline').createInterface({ input: fs.createReadStream(path.join(dirB, bjs.arquivo)).pipe(zlib.createGunzip()) }); rl.once('line', (l) => { rl.close(); ok(JSON.parse(l)); }); });
  check('cabeçalho do JS: formato, versão do schema e contagens', cab.formato === 'girostock-js-v1' && cab.versao_schema && cab.contagens.tenants > 0 && !cab.tabelas.includes('backups') && !cab.tabelas.includes('schema_migrations'), { f: cab.formato, v: cab.versao_schema });
  // falha simulada: sem arquivo parcial
  const antesArqs = fs.readdirSync(dirB).length;
  const bfalha = await backup.gerarBackup({ tipo: 'manual', usuarioId: masterId, usarPgDump: false, falharEm: 'locations' });
  check('falha simulada -> registro "falhou", sem arquivo e sem parcial', bfalha.status === 'falhou' && !bfalha.arquivo && fs.readdirSync(dirB).length === antesArqs && !fs.readdirSync(dirB).some((f) => f.endsWith('.parcial')), { status: bfalha.status, erro: bfalha.erro });
  // uma geracao por vez
  const par = await Promise.allSettled([backup.gerarBackup({ tipo: 'manual', usuarioId: masterId, usarPgDump: false }), backup.gerarBackup({ tipo: 'manual', usuarioId: masterId, usarPgDump: false })]);
  const ok409 = par.filter((p) => p.status === 'rejected' && p.reason.status === 409).length;
  check('duas gerações ao mesmo tempo: uma conclui, a outra recebe 409', par.filter((p) => p.status === 'fulfilled').length === 1 && ok409 === 1, par.map((p) => p.status));
  // arquivo adulterado nao e entregue
  const tmpAdulterado = path.join(dirB, bjs.arquivo);
  const original = fs.readFileSync(tmpAdulterado);
  fs.writeFileSync(tmpAdulterado, Buffer.concat([original, Buffer.from('x')]));
  const dlRuim = await api('GET', `/master/backups/${bjs.id}/download`, null, MAS, true);
  fs.writeFileSync(tmpAdulterado, original);
  check('arquivo adulterado: download recusado (409)', dlRuim.s === 409, dlRuim.s);
  // pg_dump real (se existir no PATH ou em PG_BIN_DIR)
  const pgBin = process.env.PG_BIN_DIR || 'C:/Program Files/PostgreSQL/16/bin';
  let bpg = null;
  if (fs.existsSync(path.join(pgBin, 'pg_dump.exe')) || fs.existsSync(path.join(pgBin, 'pg_dump'))) {
    process.env.PG_BIN_DIR = pgBin;
    bpg = await backup.gerarBackup({ tipo: 'manual', usuarioId: masterId, usarPgDump: true });
    check('com pg_dump disponível: backup em formato pgdump concluído', bpg.status === 'concluido' && bpg.formato === 'pgdump', { s: bpg.status, e: bpg.erro });
  } else console.log('  (pg_dump não encontrado neste computador: teste do formato pgdump pulado)');

  // ---------- 2. Restaurar no teste ----------
  console.log('\n# 2. Restaurar no banco de TESTE (producao intacta)');
  const prodAntesDeAlterar = await contar(prod, 'tenants');
  const posBackup = await novaEmpresa('Pos'); // empresa criada DEPOIS do backup bjs
  const prodDepois = await contar(prod, 'tenants');
  check('produção mudou depois do backup (nova empresa)', prodDepois === (prodAntesDeAlterar + 1) && prodDepois > cab.contagens.tenants - 1 + 0, { prodDepois, doBackup: cab.contagens.tenants });
  const sem = await api('POST', `/master/backups/${bjs.id}/restaurar-teste`, {}, MAS);
  check('sem a confirmação RESTAURAR -> 400', sem.s === 400, sem);
  const naoMaster = await api('POST', `/master/backups/${bjs.id}/restaurar-teste`, { confirmacao: 'RESTAURAR' }, A.token);
  check('não-Master -> 403', naoMaster.s === 403, naoMaster.s);
  const prodAntesRest = { tenants: await contar(prod, 'tenants'), users: await contar(prod, 'users'), audit: await contar(prod, 'audit_logs') };
  const rest = await api('POST', `/master/backups/${bjs.id}/restaurar-teste`, { confirmacao: 'RESTAURAR' }, MAS);
  check('restaurar no teste -> 200', rest.s === 200 && rest.j.contagens, rest);
  const contTeste = { tenants: await contar(teste, 'tenants'), users: await contar(teste, 'users'), locations: await contar(teste, 'locations') };
  check('contagens do TESTE = as do backup (e não as da produção atual)', contTeste.tenants === cab.contagens.tenants && contTeste.users === cab.contagens.users && contTeste.locations === cab.contagens.locations && contTeste.tenants < prodDepois, { contTeste, backup: { t: cab.contagens.tenants, u: cab.contagens.users }, prodDepois });
  const prodDepoisRest = { tenants: await contar(prod, 'tenants'), users: await contar(prod, 'users'), audit: await contar(prod, 'audit_logs') };
  check('produção INTACTA (mesmas contagens; só a auditoria da restauração a mais)', prodDepoisRest.tenants === prodAntesRest.tenants && prodDepoisRest.users === prodAntesRest.users && prodDepoisRest.audit >= prodAntesRest.audit, { prodAntesRest, prodDepoisRest });
  check('a empresa criada depois do backup não existe no teste', (await teste.query(`SELECT 1 FROM tenants WHERE id = $1`, [posBackup.id])).rows.length === 0);
  check('teste sem segredos de 2FA', Number((await teste.query(`SELECT count(*) AS n FROM users WHERE totp_ativo OR totp_segredo_cript IS NOT NULL`)).rows[0].n) === 0 && (await contar(teste, 'user_recovery_codes')) === 0);
  // falha no meio: teste anterior preservado
  const antesFalha = { tenants: await contar(teste, 'tenants'), users: await contar(teste, 'users'), prods: await contar(teste, 'products') };
  const modoTeste = require('../src/services/modoTeste');
  let errRest = null;
  try { await backup.restaurarNoTeste(regB1.id, { usuarioId: masterId, tenantId: plataformaId, falharNaTabela: 'locations' }); } catch (e) { errRest = e; }
  const depoisFalha = { tenants: await contar(teste, 'tenants'), users: await contar(teste, 'users'), prods: await contar(teste, 'products') };
  check('falha no meio da restauração -> ROLLBACK, teste anterior preservado', !!errRest && JSON.stringify(antesFalha) === JSON.stringify(depoisFalha) && !modoTeste.estaCopiando(), { antesFalha, depoisFalha, err: errRest && errRest.message });
  // teste igual a producao: recusado
  const urlTesteOriginal = process.env.DATABASE_URL_TESTE;
  process.env.DATABASE_URL_TESTE = process.env.DATABASE_URL;
  let errIgual = null;
  try { await backup.restaurarNoTeste(bjs.id, { usuarioId: masterId }); } catch (e) { errIgual = e; }
  process.env.DATABASE_URL_TESTE = urlTesteOriginal;
  check('banco de teste igual ao de produção -> recusado (409)', errIgual && errIgual.status === 409, errIgual && errIgual.message);
  // pgdump no teste
  if (bpg && bpg.status === 'concluido') {
    const rpg = await backup.restaurarNoTeste(bpg.id, { usuarioId: masterId, tenantId: plataformaId }).then(() => 'ok', (e) => e.message);
    check('backup pg_dump também restaura no teste (pg_restore)', rpg === 'ok' && (await contar(teste, 'tenants')) === cab.contagens.tenants, rpg);
  }

  // ---------- 3. Script restaurar-backup (banco descartavel) ----------
  console.log('\n# 3. npm run restaurar-backup em banco descartável');
  const admUrl = new URL(process.env.DATABASE_URL_TESTE); admUrl.pathname = '/postgres';
  const scratchNome = `girostock_e2e_restore_${SUF}`;
  const adm = new pg.Client({ connectionString: admUrl.toString() });
  await adm.connect();
  await adm.query(`CREATE DATABASE "${scratchNome}"`);
  const scratchUrl = new URL(process.env.DATABASE_URL_TESTE); scratchUrl.pathname = '/' + scratchNome;
  const scratchPool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const { aplicarMigracoes } = require('../src/db/migrate');
  await aplicarMigracoes(scratchPool, () => {});
  const dirScratch = fs.mkdtempSync(path.join(raiz, 'backups-e2e-'));
  const envScript = { ...process.env, DATABASE_URL: scratchUrl.toString(), BACKUP_DIR: dirScratch, BACKUP_ARQUIVO: path.join(dirB, bjs.arquivo) };
  try {
    const confErrada = spawnSync('node', ['scripts/restaurar-backup.js'], { cwd: raiz, env: envScript, input: 'qualquer coisa\n', encoding: 'utf8' });
    check('confirmação errada -> sai com erro e nada muda', confErrada.status === 1 && (await contar(scratchPool, 'tenants')) === 0 && /confirmação/.test(confErrada.stderr), confErrada.stderr);
    const ok1 = spawnSync('node', ['scripts/restaurar-backup.js'], { cwd: raiz, env: envScript, input: 'RESTAURAR PRODUCAO\n', encoding: 'utf8' });
    const saida = ok1.stdout + ok1.stderr;
    check('restauração concluída: mostra a data do backup e os registros perdidos', ok1.status === 0 && /Backup de/.test(saida) && /serão PERDIDOS/.test(saida) && /Restauração concluída/.test(saida), saida.slice(-300));
    check('o banco descartável ficou com as contagens do backup', (await contar(scratchPool, 'tenants')) === cab.contagens.tenants && (await contar(scratchPool, 'users')) === cab.contagens.users, { t: await contar(scratchPool, 'tenants') });
    const segs = (await scratchPool.query(`SELECT * FROM backups WHERE tipo = 'manual' AND status = 'concluido'`)).rows;
    check('criou backup de segurança ANTES (registrado e com arquivo)', segs.length >= 1 && fs.existsSync(path.join(dirScratch, segs[0].arquivo)), segs.length);
    const man = (await scratchPool.query(`SELECT valor FROM config_global WHERE chave = 'manutencao'`)).rows[0];
    check('modo manutenção desligado ao final', !man || man.valor.ativo === false, man);
    check('auditoria "master_restaurar_producao" registrada', (await scratchPool.query(`SELECT 1 FROM audit_logs WHERE acao = 'master_restaurar_producao'`)).rows.length === 1);
    // segunda restauracao desfaz o que foi criado no meio
    await scratchPool.query(`INSERT INTO tenants (nome) VALUES ('Empresa Extra E2E')`);
    const ok2 = spawnSync('node', ['scripts/restaurar-backup.js'], { cwd: raiz, env: envScript, input: 'RESTAURAR PRODUCAO\n', encoding: 'utf8' });
    check('registros criados depois do backup são perdidos na restauração (como avisado)', ok2.status === 0 && (await scratchPool.query(`SELECT 1 FROM tenants WHERE nome = 'Empresa Extra E2E'`)).rows.length === 0, ok2.stderr);
    const semArq = spawnSync('node', ['scripts/restaurar-backup.js'], { cwd: raiz, env: { ...envScript, BACKUP_ARQUIVO: 'nao-existe.gbk.gz' }, input: 'RESTAURAR PRODUCAO\n', encoding: 'utf8' });
    check('arquivo inexistente -> erro e nada alterado', semArq.status === 1, semArq.stderr);
  } finally {
    await scratchPool.end().catch(() => {});
    await adm.query(`DROP DATABASE IF EXISTS "${scratchNome}" WITH (FORCE)`).catch(async () => adm.query(`DROP DATABASE IF EXISTS "${scratchNome}"`).catch(() => {}));
    await adm.end().catch(() => {});
    fs.rmSync(dirScratch, { recursive: true, force: true });
  }

  // ---------- 4. Rotina automatica e retencao ----------
  console.log('\n# 4. Rotina automática diária e retenção');
  await prod.query(`DELETE FROM backups WHERE tipo = 'automatico' AND criado_em >= date_trunc('day', now())`);
  await api('PUT', '/master/config/parametros', { backup_hora: '00:00', backup_automatico: true }, MAS);
  const agora = new Date();
  const [r1, r2] = await Promise.all([auto(agora, { usarPgDump: false }), auto(agora, { usarPgDump: false })]);
  const hoje = (await prod.query(`SELECT count(*) AS n FROM backups WHERE tipo = 'automatico' AND criado_em >= date_trunc('day', now())`)).rows[0].n;
  check('duas instâncias ao mesmo tempo geram UM backup automático no dia', Number(hoje) === 1 && [r1, r2].filter(Boolean).length === 1, { hoje, r1: !!r1, r2: !!r2 });
  const r3 = await auto(new Date(), { usarPgDump: false });
  check('já houve hoje: não gera outro', r3 === null);
  await prod.query(`DELETE FROM backups WHERE tipo = 'automatico' AND criado_em >= date_trunc('day', now())`);
  await api('PUT', '/master/config/parametros', { backup_hora: '23:59' }, MAS);
  const cedo = new Date(); cedo.setHours(8, 0, 0, 0);
  check('antes da hora configurada: não gera', (await auto(cedo, { usarPgDump: false })) === null);
  await api('PUT', '/master/config/parametros', { backup_automatico: false, backup_hora: '00:00' }, MAS);
  check('rotina desligada: não gera', (await auto(new Date(), { usarPgDump: false })) === null);
  // retencao
  const velho = (arq, tipo) => prod.query(`INSERT INTO backups (arquivo, tipo, status, formato, criado_em, tamanho_bytes, sha256) VALUES ($1, $2, 'concluido', 'js', now() - interval '40 days', 1, 'x') RETURNING id`, [arq, tipo]);
  fs.writeFileSync(path.join(dirB, `e2e-velho-auto-${SUF}.gbk.gz`), 'x');
  fs.writeFileSync(path.join(dirB, `e2e-velho-manual-${SUF}.gbk.gz`), 'x');
  const vAuto = (await velho(`e2e-velho-auto-${SUF}.gbk.gz`, 'automatico')).rows[0].id;
  const vMan = (await velho(`e2e-velho-manual-${SUF}.gbk.gz`, 'manual')).rows[0].id;
  const apagados = await backup.aplicarRetencao();
  check('retenção (30 dias) apaga só automáticos antigos (registro e arquivo), nunca os manuais', apagados >= 1 && (await prod.query(`SELECT 1 FROM backups WHERE id = $1`, [vAuto])).rows.length === 0 && !fs.existsSync(path.join(dirB, `e2e-velho-auto-${SUF}.gbk.gz`)) && (await prod.query(`SELECT 1 FROM backups WHERE id = $1`, [vMan])).rows.length === 1 && fs.existsSync(path.join(dirB, `e2e-velho-manual-${SUF}.gbk.gz`)), apagados);
  const rem = await api('DELETE', `/master/backups/${vMan}`, null, MAS);
  check('remover backup: apaga registro e arquivo (auditado)', rem.s === 204 && !fs.existsSync(path.join(dirB, `e2e-velho-manual-${SUF}.gbk.gz`)) && (await prod.query(`SELECT 1 FROM audit_logs WHERE acao = 'master_backup_remover' AND recurso_id = $1`, [vMan])).rows.length === 1, rem.s);
  await prod.query(`DELETE FROM config_global WHERE chave IN ('backup_hora','backup_automatico')`);
  require('../src/services/config').invalidar();

  // ---------- 5. Exportar empresa ----------
  console.log('\n# 5. Exportar dados de uma empresa');
  await prod.query(`INSERT INTO customers (tenant_id, nome) VALUES ($1, 'Cliente da Alfa E2E'), ($2, 'Cliente da Beta E2E')`, [A.id, Bm.id]);
  const exp = await api('POST', `/master/empresas/${A.id}/exportar`, null, MAS);
  check('exportar -> 201 com arquivo e contagens', exp.s === 201 && /\.json\.gz$/.test(exp.j.arquivo) && exp.j.contagens.users === 1, exp);
  const baixa = await api('GET', `/master/exportacoes/${exp.j.arquivo}`, null, MAS, true);
  const json = JSON.parse(zlib.gunzipSync(baixa.buf).toString());
  const texto = JSON.stringify(json);
  check('contém só a empresa A (nenhuma linha/e-mail/id da B)', json.empresa.id === A.id && texto.includes('Cliente da Alfa E2E') && !texto.includes('Cliente da Beta E2E') && !texto.includes(Bm.id) && !texto.includes(Bm.email) && json.tabelas.users.every((u) => u.tenant_id === A.id), { users: json.tabelas.users.length });
  check('sem senha_hash, segredo/estado TOTP nem códigos de recuperação', !/senha_hash|totp_|user_recovery_codes|codigo_hash/.test(texto) && !json.tabelas.user_recovery_codes, null);
  check('exportação auditada (master_exportar_empresa)', (await prod.query(`SELECT 1 FROM audit_logs WHERE acao = 'master_exportar_empresa' AND recurso_id = $1`, [A.id])).rows.length >= 1);
  check('nome de arquivo malicioso é recusado', (await api('GET', '/master/exportacoes/..%2F..%2F.env', null, MAS)).s >= 400);
  check('administrador de empresa não exporta (403)', (await api('POST', `/master/empresas/${A.id}/exportar`, null, A.token)).s === 403);

  // ---------- 6. Verificar / corrigir saldos (banco de TESTE) ----------
  console.log('\n# 6. Manutenção: saldos e otimizar');
  const base0 = await Promise.all((await teste.query(`SELECT DISTINCT tenant_id FROM stock_balances`)).rows.map(async (r) => ({ t: r.tenant_id, v: (await api('POST', '/master/manutencao/saldos', { empresa_id: r.tenant_id, banco: 'teste' }, MAS)).j })));
  const todos = (await teste.query(`SELECT product_id, location_id, tenant_id, saldo FROM stock_balances`)).rows;
  const divs = new Map(base0.flatMap((x) => (x.v.itens || []).map((i) => [`${i.product_id}|${i.location_id}`, i])));
  const bal = todos.find((r) => !divs.has(`${r.product_id}|${r.location_id}`)) || todos.find((r) => divs.has(`${r.product_id}|${r.location_id}`) && divs.get(`${r.product_id}|${r.location_id}`).esperado >= 0);
  if (!bal) {
    console.log('  (teste sem saldos de estoque: verificação de saldos pulada)');
  } else {
    const d0 = (divs.get(`${bal.product_id}|${bal.location_id}`) || { diferenca: 0 }).diferenca;
    await teste.query(`UPDATE stock_balances SET saldo = saldo + 7 WHERE product_id = $1 AND location_id = $2`, [bal.product_id, bal.location_id]);
    const somaAntes = Number((await teste.query(`SELECT COALESCE(SUM(saldo),0) AS s FROM stock_balances`)).rows[0].s);
    const movAntes = await contar(teste, 'stock_movements');
    const ver = await api('POST', '/master/manutencao/saldos', { empresa_id: bal.tenant_id, banco: 'teste' }, MAS);
    const item = ver.j.itens && ver.j.itens.find((i) => i.product_id === bal.product_id && i.location_id === bal.location_id);
    check('verificar relata a divergência artificial (+7 sobre o que já havia) sem alterar nada', ver.s === 200 && item && Math.abs(item.diferenca - (d0 + 7)) < 0.0005, { d0, item });
    check('verificar não alterou saldos nem movimentos', Number((await teste.query(`SELECT COALESCE(SUM(saldo),0) AS s FROM stock_balances`)).rows[0].s) === somaAntes && (await contar(teste, 'stock_movements')) === movAntes);
    check('corrigir sem confirmação -> 400', (await api('POST', '/master/manutencao/saldos/corrigir', { empresa_id: bal.tenant_id, banco: 'teste' }, MAS)).s === 400);
    const cor = await api('POST', '/master/manutencao/saldos/corrigir', { empresa_id: bal.tenant_id, banco: 'teste', confirmacao: 'CORRIGIR' }, MAS);
    const mov = await teste.query(`SELECT motivo, saldo_anterior, saldo_novo FROM stock_movements WHERE product_id = $1 AND tipo = 'balanco' ORDER BY criado_em DESC LIMIT 1`, [bal.product_id]);
    check('corrigir gera movimento de ajuste (balanço) e auditoria', cor.s === 200 && cor.j.corrigidos >= 1 && mov.rows[0] && /divergência/.test(mov.rows[0].motivo) && (await contar(teste, 'stock_movements')) > movAntes && (await teste.query(`SELECT 1 FROM audit_logs WHERE acao = 'master_corrigir_saldos'`)).rows.length >= 1, cor);
    const ver2 = await api('POST', '/master/manutencao/saldos', { empresa_id: bal.tenant_id, banco: 'teste' }, MAS);
    check('depois de corrigir, a divergência artificial some', !ver2.j.itens.some((i) => i.product_id === bal.product_id && i.location_id === bal.location_id), ver2.j.itens.slice(0, 2));
  }
  const otim = await api('POST', '/master/manutencao/otimizar', null, MAS);
  check('otimizar (ANALYZE) responde com a duração', otim.s === 200 && typeof otim.j.duracao_ms === 'number', otim);

  // ---------- 7. Aviso global ----------
  console.log('\n# 7. Aviso global');
  const av0 = await api('GET', '/aviso-global', null, A.token);
  check('sem aviso: nada para mostrar', av0.s === 200 && av0.j.aviso === null, av0.j);
  const av1 = await api('POST', '/master/avisos', { mensagem: 'Manutenção às 23h (e2e)' }, MAS);
  check('Master publica o aviso', av1.s === 201, av1);
  const vA = await api('GET', '/aviso-global', null, A.token);
  const vB = await api('GET', '/aviso-global', null, Bm.token);
  check('usuários de QUALQUER empresa recebem o aviso', vA.j.aviso && vA.j.aviso.mensagem === 'Manutenção às 23h (e2e)' && vB.j.aviso && vB.j.aviso.id === vA.j.aviso.id, vA.j);
  await api('POST', '/master/avisos', { mensagem: 'Novo aviso (e2e)' }, MAS);
  check('publicar substitui o ativo (apenas um por vez)', (await api('GET', '/aviso-global', null, A.token)).j.aviso.mensagem === 'Novo aviso (e2e)' && Number((await prod.query(`SELECT count(*) AS n FROM avisos_globais WHERE ativo`)).rows[0].n) === 1);
  check('aviso curto demais -> 400', (await api('POST', '/master/avisos', { mensagem: 'ok' }, MAS)).s === 400);
  check('administrador de empresa não publica (403)', (await api('POST', '/master/avisos', { mensagem: 'Hackeado pelo admin' }, A.token)).s === 403);
  await api('DELETE', '/master/avisos', null, MAS);
  check('ao remover, some para todos', (await api('GET', '/aviso-global', null, Bm.token)).j.aviso === null);

  // ---------- 8. Modo manutencao ----------
  console.log('\n# 8. Modo manutenção');
  const man = await api('PUT', '/master/config/manutencao', { ativo: true, mensagem: 'Voltamos em 10 minutos (e2e)' }, MAS);
  check('Master liga a manutenção', man.s === 200 && man.j.ativo === true, man);
  await new Promise((ok) => setTimeout(ok, 100));
  const bloqueado = await api('GET', '/locations', null, A.token);
  check('usuário comum recebe 503 com a mensagem', bloqueado.s === 503 && bloqueado.j.manutencao === true && /10 minutos/.test(bloqueado.j.erro), bloqueado);
  const lgMan = await login(A.email, A.senha);
  check('login de usuário comum também é barrado (503)', lgMan.s === 503 && lgMan.j.manutencao === true, lgMan.s);
  const meMan = await api('GET', '/auth/me', null, A.token);
  check('/auth/me continua respondendo e traz o aviso de manutenção', meMan.s === 200 && meMan.j.manutencao && meMan.j.manutencao.ativo, meMan.j.manutencao);
  const masterOk = await api('GET', '/master/saude', null, MAS);
  const masterMe = await api('GET', '/auth/me', null, MAS);
  check('o Master continua operando o painel', masterOk.s === 200 && masterMe.s === 200 && masterMe.j.manutencao === null, { saude: masterOk.s });
  const masterLogin = await tokenDoMasterComDoisFatores(B, EMAIL_MASTER, SENHA_MASTER).catch((e) => null);
  check('o Master consegue entrar (login) durante a manutenção', !!masterLogin);
  if (masterLogin) MAS = masterLogin;
  await api('PUT', '/master/config/manutencao', { ativo: false, mensagem: '' }, MAS);
  await new Promise((ok) => setTimeout(ok, 100));
  check('ao desligar, tudo volta', (await api('GET', '/locations', null, A.token)).s === 200 && (await login(A.email, A.senha)).s === 200);

  // ---------- 9. Parametros ----------
  console.log('\n# 9. Parâmetros padrão');
  const inval = [
    await api('PUT', '/master/config/parametros', { cliente_risco_dias: 0 }, MAS),
    await api('PUT', '/master/config/parametros', { pedido_atrasado_min: 0 }, MAS),
    await api('PUT', '/master/config/parametros', { backup_retencao_dias: 400 }, MAS),
    await api('PUT', '/master/config/parametros', { backup_hora: '25:00' }, MAS),
    await api('PUT', '/master/config/parametros', { vip_limite_padrao: -1 }, MAS),
    await api('PUT', '/master/config/parametros', { cliente_risco_dias: 70, cliente_inativo_dias: 60 }, MAS),
    await api('PUT', '/master/config/parametros', {}, MAS),
  ];
  check('valores fora da faixa -> 400', inval.every((r) => r.s === 400), inval.map((r) => r.s));
  const padrao = (await api('GET', '/master/config/parametros', null, MAS)).j;
  check('padrões: VIP 400, risco 30, inativo 60, atraso 25, retenção 30', padrao.vip_limite_padrao === 400 && padrao.cliente_risco_dias === 30 && padrao.cliente_inativo_dias === 60 && padrao.pedido_atrasado_min === 25 && padrao.backup_retencao_dias === 30, padrao);
  check('com os padrões, /auth/me entrega pedidoAtrasadoMin = 25', (await api('GET', '/auth/me', null, A.token)).j.parametros.pedidoAtrasadoMin === 25);
  // cliente com ultimo pedido ha 45 dias na empresa A
  const loja = (await prod.query(`SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1`, [A.id])).rows[0].id;
  const cli = (await prod.query(`SELECT id FROM customers WHERE tenant_id = $1 AND nome = 'Cliente da Alfa E2E'`, [A.id])).rows[0].id;
  await prod.query(`INSERT INTO orders (tenant_id, location_id, numero, origem, tipo, customer_id, status, criado_em, finalizado_em) VALUES ($1, $2, 1, 'balcao', 'retirada', $3, 'finalizado', now() - interval '45 days', now() - interval '45 days')`, [A.id, loja, cli]).catch(async (e) => { console.log('  (aviso: pedido de teste não inserido:', e.message.slice(0, 80), ')'); });
  const seg = async () => { const l = (await api('GET', '/customers', null, A.token)).j; const c = (Array.isArray(l) ? l : l.clientes || []).find((x) => x.id === cli); return c ? c.segmentos : null; };
  const segPadrao = await seg();
  check('padrão (risco ≥ 30, inativo ≥ 60): cliente de 45 dias está "em risco"', segPadrao && segPadrao.includes('risco') && !segPadrao.includes('inativo'), segPadrao);
  await api('PUT', '/master/config/parametros', { cliente_risco_dias: 20, cliente_inativo_dias: 40, pedido_atrasado_min: 40 }, MAS);
  const segNovo = await seg();
  check('com risco 20 / inativo 40: o mesmo cliente passa a "inativo" (comportamento real mudou)', segNovo && segNovo.includes('inativo') && !segNovo.includes('risco'), segNovo);
  check('/auth/me entrega pedidoAtrasadoMin = 40 (faixa de atraso dos Pedidos)', (await api('GET', '/auth/me', null, A.token)).j.parametros.pedidoAtrasadoMin === 40);
  await api('PUT', '/master/config/parametros', { vip_limite_padrao: 555 }, MAS);
  const novaVip = await novaEmpresa('Vip');
  check('vip_limite_padrao vale só para empresas NOVAS (a antiga mantém o seu)', Number((await prod.query(`SELECT clientes_vip_limite AS v FROM tenants WHERE id = $1`, [novaVip.id])).rows[0].v) === 555 && Number((await prod.query(`SELECT clientes_vip_limite AS v FROM tenants WHERE id = $1`, [A.id])).rows[0].v) === 400);
  await prod.query(`DELETE FROM config_global WHERE chave IN ('cliente_risco_dias','cliente_inativo_dias','pedido_atrasado_min','vip_limite_padrao')`);
  require('../src/services/config').invalidar();
  await new Promise((ok) => setTimeout(ok, 5200)); // cache do servidor (5 s)
  const segVolta = await seg();
  check('voltando aos padrões o comportamento volta ao original', segVolta && segVolta.includes('risco') && !segVolta.includes('inativo'), segVolta);

  // ---------- 10. Planos ----------
  console.log('\n# 10. Planos');
  const basico = await novaEmpresa('Basico', 'basico');
  const u2 = await api('POST', '/master/usuarios', { empresa_id: basico.id, nome: 'Segundo', email: email('segundo'), perfil: 'Administrador' }, MAS);
  check('empresa Básico com 2 usuários', u2.s === 201, u2);
  const pl0 = await api('GET', '/master/planos/basico', null, MAS);
  check('GET plano traz limites e quantas empresas o usam', pl0.s === 200 && pl0.j.max_usuarios === 3 && pl0.j.empresas >= 1, pl0.j);
  check('limites inválidos -> 400', (await api('PUT', '/master/planos/basico', { max_usuarios: 0 }, MAS)).s === 400 && (await api('PUT', '/master/planos/basico', { max_lojas: 'x' }, MAS)).s === 400);
  const pl1 = await api('PUT', '/master/planos/basico', { max_usuarios: 1 }, MAS);
  check('reduzir o limite avisa as empresas que já excedem', pl1.s === 200 && pl1.j.max_usuarios === 1 && pl1.j.empresas_acima_do_limite.includes(basico.nome), pl1.j);
  check('empresa acima do limite continua funcionando', (await api('GET', '/users', null, basico.token)).s === 200 && (await api('GET', '/locations', null, basico.token)).s === 200);
  const u3 = await api('POST', '/master/usuarios', { empresa_id: basico.id, nome: 'Terceiro', email: email('terceiro'), perfil: 'Administrador' }, MAS);
  check('mas não consegue cadastrar mais usuários (409)', u3.s === 409, u3);
  const pl2 = await api('PUT', '/master/planos/basico', { max_usuarios: 3, recursos: { pedidos: false } }, MAS);
  check('plano restaurado', pl2.s === 200 && pl2.j.max_usuarios === 3 && !pl2.j.empresas_acima_do_limite.includes(basico.nome));
  check('administrador de empresa não edita plano (403)', (await api('PUT', '/master/planos/basico', { max_usuarios: 99 }, A.token)).s === 403);

  // ---------- 11. Integracoes e segredos ----------
  console.log('\n# 11. Integrações (só status) e segredos');
  const integ = await api('GET', '/master/config/integracoes', null, MAS);
  check('integrações listam status de banco de teste, BACKUP_DIR, TOTP, SMTP, WhatsApp, iFood e 99Food', ['banco_teste', 'backup_dir', 'totp', 'smtp', 'whatsapp', 'ifood', '99food'].every((id) => integ.j.integracoes.some((i) => i.id === id)), integ.j.integracoes.map((i) => i.id));
  const t1 = await api('POST', '/master/config/integracoes/banco_teste/testar', null, MAS);
  const t2 = await api('POST', '/master/config/integracoes/backup_dir/testar', null, MAS);
  check('"Testar" real: banco de teste e pasta de backups', t1.s === 200 && t1.j.ok && t2.s === 200 && t2.j.ok, { t1: t1.j, t2: t2.j });
  const corpos = [JSON.stringify(integ.j), JSON.stringify(lista.j), JSON.stringify((await api('GET', '/master/config/parametros', null, MAS)).j), JSON.stringify(exp.j)];
  const senhaDb = new URL(process.env.DATABASE_URL).password;
  const segredos = [process.env.JWT_SECRET, senhaDb, process.env.TOTP_ENC_KEY].filter((x) => x && x.length >= 12);
  check('nenhuma resposta contém DATABASE_URL, senha do banco, JWT_SECRET ou chave do 2FA', corpos.every((c) => !/postgres(ql)?:\/\//.test(c) && !c.includes(`:${senhaDb}@`) && segredos.every((s) => !c.includes(s))), null);
  const linhasAudit = (await prod.query(`SELECT detalhes::text AS d FROM audit_logs WHERE acao LIKE 'master_%' AND criado_em > now() - interval '30 minutes'`)).rows.map((r) => r.d || '').join('\n');
  check('auditoria desta rodada sem segredos', segredos.every((s) => !linhasAudit.includes(s)) && !/postgres(ql)?:\/\//.test(linhasAudit), null);
  check('auditoria global mostra as ações novas com o tipo "Backups e dados"', (await api('GET', '/master/auditoria?tipo=backup', null, MAS)).j.itens.some((i) => i.acao === 'master_backup_gerar'));
} finally {
  await restaurarEstado();
  await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.m3.%'`);
  await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E M3 %'`);
  await prod.query(`DELETE FROM customers WHERE nome LIKE '%Alfa E2E' OR nome LIKE '%Beta E2E'`).catch(() => {});
  await prod.end();
  await teste.end();
  console.log(`\n${pass} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}
