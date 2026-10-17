// Copia COMPLETA da producao para o banco de teste (so nesse sentido: nunca teste -> producao).
// Leitura na producao em transacao READ ONLY / REPEATABLE READ (foto consistente); escrita so no teste, em UMA
// transacao: TRUNCATE de todas as tabelas de negocio + COPY em streaming na ordem das chaves estrangeiras.
// Qualquer falha faz ROLLBACK e o teste anterior permanece intacto.
const stream = require('stream');
const { promisify } = require('util');
const { from: copyFrom, to: copyTo } = require('pg-copy-streams');
const pool = require('../db/pool');
const { logAudit } = require('../utils/audit');
const { HttpError } = require('../utils/http');
const modoTeste = require('./modoTeste');

const pipeline = promisify(stream.pipeline);
const LOCK_CHAVE = 727001; // advisory lock: impede duas copias simultaneas (mesmo entre processos)
// Tabelas de controle de cada banco: nunca copiadas nem truncadas (registro de backups e erros pertencem a cada banco).
const FORA_DA_COPIA = ['schema_migrations', 'teste_copias', 'backups', 'erros_sistema'];
// Tabelas truncadas no teste mas NUNCA copiadas (segredos de 2FA ficam so na producao).
const SEM_DADOS = ['user_recovery_codes'];
// Colunas que viram valor neutro na copia: nenhum segredo TOTP chega ao banco de teste.
const NEUTRAS = {
  users: { totp_segredo_cript: 'NULL', totp_ativo: 'false', totp_ativado_em: 'NULL', totp_ultimo_passo: 'NULL', totp_falhas: '0', totp_bloqueado_ate: 'NULL' },
  // Tokens do iFood/99Food nunca vao para o teste: la a integracao fica desconectada (o teste nao recebe pedidos reais).
  integracoes_delivery: { access_token_cript: 'NULL', refresh_token_cript: 'NULL', verificador_token_cript: 'NULL', token_expira_em: 'NULL', status: "'desconectado'" },
};

// Tabelas de negocio do schema public, ordenadas pelas chaves estrangeiras (pais antes dos filhos).
async function tabelasEmOrdem(db) {
  const t = await db.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> ALL($1) ORDER BY c.relname`,
    [FORA_DA_COPIA]
  );
  const nomes = t.rows.map((r) => r.relname);
  const e = await db.query(
    `SELECT a.relname AS filha, b.relname AS pai FROM pg_constraint k
     JOIN pg_class a ON a.oid = k.conrelid JOIN pg_class b ON b.oid = k.confrelid
     WHERE k.contype = 'f' AND a.relname <> b.relname`
  );
  const deps = new Map(nomes.map((n) => [n, new Set()]));
  for (const r of e.rows) if (deps.has(r.filha) && deps.has(r.pai)) deps.get(r.filha).add(r.pai);
  const ordem = [];
  const feitas = new Set();
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const n of nomes) {
      if (!feitas.has(n) && [...deps.get(n)].every((p) => feitas.has(p))) { feitas.add(n); ordem.push(n); mudou = true; }
    }
  }
  const sobra = nomes.filter((n) => !feitas.has(n));
  if (sobra.length > 0) throw new Error('ciclo de chaves estrangeiras entre tabelas: ' + sobra.join(', '));
  return ordem;
}

// Lista de colunas do SELECT de origem (com valores neutros onde a coluna e sensivel) e do COPY de destino.
async function colunasDaCopia(db, tabela) {
  const nomes = (await colunas(db, tabela)).map((c) => c.replace(/"/g, ''));
  const neutras = NEUTRAS[tabela] || {};
  return {
    origem: nomes.map((n) => (n in neutras ? `${neutras[n]} AS "${n}"` : `"${n}"`)).join(', '),
    destino: nomes.map((n) => `"${n}"`).join(', '),
  };
}

async function colunas(db, tabela) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tabela]
  );
  return rows.map((r) => `"${r.column_name}"`);
}

// Troca nomes, telefones e enderecos de clientes por dados ficticios (mesma transacao da copia).
async function anonimizarClientes(c) {
  await c.query(`
    UPDATE customers c SET nome = 'Cliente ' || x.rn,
           telefone = CASE WHEN c.telefone IS NULL OR c.telefone = '' THEN c.telefone ELSE '119' || lpad(x.rn::text, 8, '0') END,
           observacao = ''
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM customers) x WHERE x.id = c.id`);
  await c.query(`UPDATE customer_addresses SET endereco = 'Rua Teste, ' || (abs(hashtext(id::text)) % 900 + 100), bairro = 'Centro'`);
  await c.query(`UPDATE orders SET cliente_nome = c.nome, cliente_telefone = COALESCE(c.telefone, '') FROM customers c WHERE c.id = orders.customer_id`);
  await c.query(`UPDATE orders SET cliente_nome = CASE WHEN cliente_nome = '' THEN '' ELSE 'Cliente' END, cliente_telefone = '' WHERE customer_id IS NULL`);
  await c.query(`UPDATE orders SET endereco = 'Rua Teste, 100' WHERE tipo = 'entrega'`);
  await c.query(`UPDATE message_log SET texto = '[anonimizado]'`);
  await c.query(`UPDATE pedidos_externos SET payload = payload - 'customer' - 'delivery' - 'receive_address'`);
}

async function contagens(db, tabelas) {
  const r = {};
  for (const t of tabelas) r[t] = Number((await db.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
  return r;
}

// opcoes: { usuarioId, tenantId, anonimizar = true, motivo, falharNaTabela (somente testes automatizados) }
async function copiarProducao(opcoes) {
  const { usuarioId, tenantId, anonimizar = true, motivo = 'copia manual', falharNaTabela } = opcoes;
  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado');
  if (modoTeste.estaCopiando()) throw new HttpError(409, 'já existe uma cópia em andamento');
  await modoTeste.garantirBancoTeste();

  const leitura = await pool.producao.connect();
  const escrita = await pool.teste().connect();
  modoTeste.marcarCopia(true);
  let travou = false;
  try {
    const lock = await leitura.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_CHAVE]);
    if (!lock.rows[0].ok) throw new HttpError(409, 'já existe uma cópia em andamento');
    travou = true;

    await leitura.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await escrita.query('BEGIN');
    try {
      const tabelas = await tabelasEmOrdem(leitura);
      await escrita.query(`TRUNCATE ${tabelas.map((t) => `"${t}"`).join(', ')} CASCADE`);
      for (const t of tabelas) {
        if (SEM_DADOS.includes(t)) continue;
        const cols = await colunasDaCopia(leitura, t);
        const origem = leitura.query(copyTo(`COPY (SELECT ${cols.origem} FROM "${t}") TO STDOUT`));
        const destino = escrita.query(copyFrom(`COPY "${t}" (${cols.destino}) FROM STDIN`));
        await pipeline(origem, destino);
        if (falharNaTabela === t && process.env.NODE_ENV !== 'production') throw new Error(`falha simulada após copiar ${t}`);
      }
      if (anonimizar) await anonimizarClientes(escrita);
      const total = await contagens(escrita, tabelas);
      await escrita.query(`INSERT INTO teste_copias (copiado_por, contagens) VALUES ($1, $2)`, [usuarioId || null, JSON.stringify({ ...total, _anonimizado: !!anonimizar })]);
      await escrita.query('COMMIT');
      await leitura.query('ROLLBACK'); // so leitura: encerra a foto

      // Auditoria na PRODUCAO (nunca o conteudo dos dados): quem copiou, quando, contagens.
      await logAudit(pool.producao, { tenantId, usuarioId, acao: 'copiar_producao_para_teste', recurso: 'modo_teste', detalhes: { motivo, anonimizado: !!anonimizar, contagens: total } });
      return { contagens: total, anonimizado: !!anonimizar };
    } catch (err) {
      await escrita.query('ROLLBACK').catch(() => {});
      await leitura.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    if (travou) await leitura.query('SELECT pg_advisory_unlock($1)', [LOCK_CHAVE]).catch(() => {});
    modoTeste.marcarCopia(false);
    leitura.release();
    escrita.release();
  }
}

// Contagens por tabela (producao x teste) e dados da ultima copia, para a tela do Master.
async function status() {
  const tabelas = await tabelasEmOrdem(pool.producao);
  const prod = await contagens(pool.producao, tabelas);
  let teste = null;
  let ultima = null;
  let empresas = [];
  if (pool.testeConfigurado()) {
    try {
      const c = await pool.teste().connect();
      c.release();
      const existe = await pool.teste().query(`SELECT to_regclass('public.teste_copias') AS t`);
      if (existe.rows[0].t) {
        ultima = await modoTeste.ultimaCopia();
        teste = await contagens(pool.teste(), tabelas);
        empresas = await modoTeste.empresasDoTeste();
      }
    } catch (err) {
      teste = null; // banco de teste ainda nao existe / nao migrado
    }
  }
  return {
    configurado: pool.testeConfigurado(),
    copiaEmAndamento: modoTeste.estaCopiando(),
    ultimaCopia: ultima ? { copiado_em: ultima.copiado_em, anonimizado: !!(ultima.contagens && ultima.contagens._anonimizado) } : null,
    tabelas: tabelas.map((t) => ({ tabela: t, producao: prod[t], teste: teste ? teste[t] : null })),
    empresas,
  };
}

module.exports = { copiarProducao, status, tabelasEmOrdem, colunas, anonimizarClientes, contagens, SEM_DADOS, NEUTRAS, FORA_DA_COPIA };
