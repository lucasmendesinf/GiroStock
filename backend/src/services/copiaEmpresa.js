// Copia de UMA empresa da producao para o banco de teste ("Testar sem gravar" do suporte do Master) e a limpeza depois.
// Diferente da copia completa (copiaProducao): nao trava o modo teste das outras empresas, copia so os cadastros e o estado
// atual da empresa e o movimento dos ultimos N dias (vendas, pedidos, caixas, movimentacoes...). Sem auditoria, sem historico
// antigo, sem tokens das integracoes. Ao terminar o teste, apaga tudo dessa empresa do banco de teste.
//
// Como funciona: as tabelas sao lidas do catalogo (chaves estrangeiras), entao uma tabela nova entra sozinha.
//  - tabela com tenant_id: linhas da empresa;  tabela "filha" sem tenant_id: linhas cujo pai (chave obrigatoria) foi copiado;
//  - tabelas de historico: so os ultimos N dias (o que esta aberto, como caixa e comanda, vem sempre);
//  - chave obrigatoria para uma linha que ficou de fora => a linha fica de fora; chave opcional => vira NULL.
const stream = require('stream');
const { promisify } = require('util');
const { from: copyFrom, to: copyTo } = require('pg-copy-streams');
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const modoTeste = require('./modoTeste');
const { NEUTRAS: NEUTRAS_COPIA } = require('./copiaProducao');

const pipeline = promisify(stream.pipeline);
// Alem dos valores neutros da copia completa: nada de WhatsApp real nem certificado/CSC fiscal no teste do suporte
// (nenhuma nota sai com o CNPJ do cliente; a loja fica em homologacao e sem certificado).
const NEUTRAS = {
  ...NEUTRAS_COPIA,
  whatsapp_contas: { token_cript: "''", status: "'desconectado'" },
  fiscal_lojas: { ambiente: "'homologacao'", cert_cript: 'NULL', cert_senha_cript: 'NULL', csc_prod_cript: 'NULL', csc_homolog_cript: 'NULL' },
};
const LOCK_CHAVE = 727002; // advisory lock por empresa (727001 e o da copia completa)

// Nunca copiadas (controle de cada banco, auditoria, segredos, avisos e o proprio controle do suporte).
const NAO_COPIAR = new Set([
  'schema_migrations', 'teste_copias', 'backups', 'erros_sistema', 'geo_cache', 'user_recovery_codes',
  'audit_logs', 'sessoes_suporte', 'suporte_testes', 'avisos_empresa', 'avisos_globais', 'config_global',
  'lv_login_codigos', 'planos',
]);
// Tabelas globais que a empresa precisa (chave estrangeira): as linhas que faltam no teste sao incluidas, nunca apagadas.
const GLOBAIS_NECESSARIAS = ['planos'];

// Filtro de historico (D = inicio da janela). O que ainda esta aberto vem sempre.
const HISTORICO = {
  sales: `"criado_em" >= D`,
  orders: `("criado_em" >= D OR ("finalizado_em" IS NULL AND "cancelado_em" IS NULL))`,
  order_status_log: `"criado_em" >= D`,
  stock_movements: `"criado_em" >= D`,
  cash_sessions: `("aberto_em" >= D OR "fechado_em" IS NULL)`,
  cash_movements: `"criado_em" >= D`,
  comandas: `("aberta_em" >= D OR "fechada_em" IS NULL)`,
  comissoes: `"criado_em" >= D`,
  comissao_acertos: `"criado_em" >= D`,
  notas_fiscais: `("emitida_em" IS NULL OR "emitida_em" >= D)`,
  message_log: `"criado_em" >= D`,
  whatsapp_mensagens: `"criado_em" >= D`,
  whatsapp_campanhas: `"criado_em" >= D`,
  pedidos_externos: `"criado_em" >= D`,
  entregas_ifood: `"criado_em" >= D`,
  ingredient_consumptions: `"criado_em" >= D`,
  lv_pagamentos: `"criado_em" >= D`,
  purchase_notes: `"criado_em" >= D`,
  fin_titulos: `(("pago_em" IS NULL AND "cancelado_em" IS NULL) OR "criado_em" >= D OR "vencimento" >= D::date)`,
};

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
const lista = (cols) => cols.map(q).join(', ');
const tupla = (cols) => (cols.length === 1 ? q(cols[0]) : `(${lista(cols)})`);

// Catalogo: tabelas (com/sem tenant_id), colunas e chaves estrangeiras (com as colunas e se sao obrigatorias).
async function catalogo(db) {
  const t = await db.query(
    `SELECT c.relname AS tabela,
            array_agg(a.attname::text ORDER BY a.attnum) AS colunas
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      GROUP BY c.relname ORDER BY c.relname`
  );
  const tabelas = new Map(t.rows.map((r) => [r.tabela, { nome: r.tabela, colunas: r.colunas, fks: [] }]));
  const f = await db.query(
    `SELECT a.relname AS filha, b.relname AS pai,
            (SELECT array_agg(x.attname::text ORDER BY u.o) FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute x ON x.attrelid = k.conrelid AND x.attnum = u.n) AS cols,
            (SELECT array_agg(x.attname::text ORDER BY u.o) FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute x ON x.attrelid = k.confrelid AND x.attnum = u.n) AS refs,
            (SELECT bool_and(x.attnotnull) FROM unnest(k.conkey) u(n) JOIN pg_attribute x ON x.attrelid = k.conrelid AND x.attnum = u.n) AS obrigatoria
       FROM pg_constraint k JOIN pg_class a ON a.oid = k.conrelid JOIN pg_class b ON b.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = a.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public'`
  );
  for (const r of f.rows) if (tabelas.has(r.filha)) tabelas.get(r.filha).fks.push(r);
  for (const tb of tabelas.values()) tb.temTenant = tb.colunas.includes('tenant_id');
  // ordem pelas chaves estrangeiras (pais antes dos filhos)
  const ordem = [];
  const feitas = new Set();
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const tb of tabelas.values()) {
      if (feitas.has(tb.nome)) continue;
      if (tb.fks.every((k) => k.pai === tb.nome || feitas.has(k.pai) || !tabelas.has(k.pai))) { feitas.add(tb.nome); ordem.push(tb.nome); mudou = true; }
    }
  }
  const sobra = [...tabelas.keys()].filter((n) => !feitas.has(n));
  if (sobra.length) throw new Error('ciclo de chaves estrangeiras entre tabelas: ' + sobra.join(', '));
  return { tabelas, ordem };
}

// Plano da copia: para cada tabela, o WHERE (sobre a producao) e a lista de colunas (chaves opcionais filtradas).
// extras: { usuarios: [ids], empresas: [ids] } linhas de fora da empresa que podem ser referenciadas (os Masters).
function planejar(cat, tenantId, desde, extras = { usuarios: [], empresas: [] }) {
  const T = `'${tenantId}'::uuid`;
  const D = `'${desde.toISOString()}'::timestamptz`;
  const inLista = (ids) => ids.map((i) => `'${i}'::uuid`).join(', ');
  const plano = new Map(); // tabela -> { where, origem, destino }
  // Linhas que uma chave estrangeira pode apontar (as copiadas + os extras).
  const alvo = (pai) => {
    const p = plano.get(pai);
    if (!p) return null;
    if (pai === 'users' && extras.usuarios.length) return `(${p.where}) OR "id" IN (${inLista(extras.usuarios)})`;
    if (pai === 'tenants' && extras.empresas.length) return `(${p.where}) OR "id" IN (${inLista(extras.empresas)})`;
    return p.where;
  };

  for (const nome of cat.ordem) {
    const tb = cat.tabelas.get(nome);
    if (NAO_COPIAR.has(nome)) continue;
    const conds = [];
    let escopo = false;
    if (nome === 'tenants') { conds.push(`"id" = ${T}`); escopo = true; } else if (tb.temTenant) { conds.push(`"tenant_id" = ${T}`); escopo = true; }
    if (HISTORICO[nome]) conds.push(HISTORICO[nome].replace(/\bD\b/g, D));
    let fora = false;
    for (const k of tb.fks) {
      if (!k.obrigatoria || k.pai === nome) continue;
      if (GLOBAIS_NECESSARIAS.includes(k.pai)) continue;
      if (k.pai === 'tenants' && k.cols.length === 1 && k.cols[0] === 'tenant_id') continue; // ja filtrado
      const a = alvo(k.pai);
      if (a === null) { fora = true; break; } // pai que nao e copiado: a linha nao teria pai
      conds.push(`${tupla(k.cols)} IN (SELECT ${lista(k.refs)} FROM ${q(k.pai)} WHERE ${a})`);
      if (plano.get(k.pai)) escopo = true;
    }
    if (fora || !escopo) continue; // global (sem ligacao com a empresa) ou dependente de tabela fora da copia
    const where = conds.join(' AND ');
    plano.set(nome, { where });
  }

  // Colunas: valores neutros (segredos) e chaves opcionais para linhas fora da copia => NULL.
  for (const [nome, p] of plano) {
    const tb = cat.tabelas.get(nome);
    const neutras = NEUTRAS[nome] || {};
    const opcionais = new Map();
    for (const k of tb.fks) {
      if (k.obrigatoria || k.cols.length !== 1 || GLOBAIS_NECESSARIAS.includes(k.pai)) continue;
      const a = k.pai === nome ? p.where : alvo(k.pai);
      opcionais.set(k.cols[0], a === null ? 'NULL' : `CASE WHEN ${q(k.cols[0])} IN (SELECT ${q(k.refs[0])} FROM ${q(k.pai)} WHERE ${a}) THEN ${q(k.cols[0])} END`);
    }
    p.origem = tb.colunas.map((c) => {
      if (c in neutras) return `${neutras[c]} AS ${q(c)}`;
      if (opcionais.has(c)) return `${opcionais.get(c)} AS ${q(c)}`;
      return q(c);
    }).join(', ');
    p.destino = lista(tb.colunas);
  }
  return plano;
}

// WHERE para APAGAR a empresa do banco de teste: tudo dela (sem janela de tempo), inclusive tabelas que nao sao copiadas.
function planejarLimpeza(cat, tenantId) {
  const T = `'${tenantId}'::uuid`;
  const where = new Map();
  for (const nome of cat.ordem) {
    if (nome === 'schema_migrations' || nome === 'teste_copias') continue;
    const tb = cat.tabelas.get(nome);
    if (nome === 'tenants') { where.set(nome, `"id" = ${T}`); continue; }
    if (tb.temTenant) { where.set(nome, `"tenant_id" = ${T}`); continue; }
    const ligacoes = tb.fks.filter((k) => k.obrigatoria && k.pai !== nome && where.has(k.pai))
      .map((k) => `${tupla(k.cols)} IN (SELECT ${lista(k.refs)} FROM ${q(k.pai)} WHERE ${where.get(k.pai)})`);
    if (ligacoes.length) where.set(nome, ligacoes.join(' OR '));
  }
  return where;
}

// Apaga a empresa (filhos antes dos pais). `c` e um cliente do banco de teste dentro de uma transacao.
async function apagarNoCliente(c, cat, tenantId) {
  const where = planejarLimpeza(cat, tenantId);
  const ordem = cat.ordem.filter((n) => where.has(n)).reverse();
  let linhas = 0;
  for (const nome of ordem) {
    const r = await c.query(`DELETE FROM ${q(nome)} WHERE ${where.get(nome)}`);
    linhas += r.rowCount;
  }
  return linhas;
}

async function travar(c, tenantId) {
  const r = await c.query('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS ok', [LOCK_CHAVE, tenantId]);
  if (!r.rows[0].ok) throw new HttpError(409, 'já existe uma cópia desta empresa em andamento: aguarde alguns instantes');
}

// Masters (e a empresa deles) precisam existir no teste: podem aparecer como autor de linhas da empresa (suporte com edicao).
async function garantirMasters() {
  const { rows } = await pool.producao.query(`SELECT id, tenant_id FROM users WHERE perfil = 'Master'`);
  for (const m of rows) await modoTeste.garantirUsuarioNoTeste(m.id);
  const noTeste = await pool.teste().query(`SELECT id, tenant_id FROM users WHERE id = ANY($1::uuid[])`, [rows.map((m) => m.id)]);
  return { usuarios: noTeste.rows.map((m) => m.id), empresas: [...new Set(noTeste.rows.map((m) => m.tenant_id))] };
}

// Copia a empresa. opcoes: { dias = 30 }. Devolve { contagens, linhas }.
async function copiarEmpresa(tenantId, opcoes = {}) {
  if (!isUuid(tenantId)) throw new HttpError(400, 'empresa inválida');
  if (!pool.testeConfigurado()) throw new HttpError(409, 'modo teste não configurado (banco de teste ausente)');
  if (modoTeste.estaCopiando()) throw new HttpError(409, 'cópia completa da produção em andamento: aguarde alguns instantes');
  const dias = Math.max(1, Math.min(365, Number(opcoes.dias) || 30));
  const desde = new Date(Date.now() - dias * 86400000);
  await modoTeste.garantirBancoTeste();
  const extras = await garantirMasters();

  const leitura = await pool.producao.connect();
  const escrita = await pool.teste().connect();
  try {
    await leitura.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await escrita.query('BEGIN');
    try {
      await travar(escrita, tenantId);
      const existe = await leitura.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
      if (!existe.rows.length) throw new HttpError(404, 'empresa não encontrada');
      const catProd = await catalogo(leitura);
      const catTeste = await catalogo(escrita);
      // Globais que a empresa referencia (planos): inclui as que faltam no teste, sem mexer nas existentes.
      for (const g of GLOBAIS_NECESSARIAS) {
        if (!catProd.tabelas.has(g) || !catTeste.tabelas.has(g)) continue;
        const cols = lista(catProd.tabelas.get(g).colunas.filter((c) => catTeste.tabelas.get(g).colunas.includes(c)));
        await escrita.query(`CREATE TEMP TABLE _g (LIKE ${q(g)}) ON COMMIT DROP`);
        await pipeline(leitura.query(copyTo(`COPY (SELECT ${cols} FROM ${q(g)}) TO STDOUT`)), escrita.query(copyFrom(`COPY _g (${cols}) FROM STDIN`)));
        await escrita.query(`INSERT INTO ${q(g)} (${cols}) SELECT ${cols} FROM _g ON CONFLICT DO NOTHING`);
        await escrita.query('DROP TABLE _g');
      }
      const apagadas = await apagarNoCliente(escrita, catTeste, tenantId);
      const plano = planejar(catProd, tenantId, desde, extras);
      const contagens = {};
      let linhas = 0;
      for (const nome of catProd.ordem) {
        const p = plano.get(nome);
        if (!p || !catTeste.tabelas.has(nome)) continue;
        // colunas presentes nos dois bancos (o teste pode estar uma migracao atras/a frente)
        const colsTeste = new Set(catTeste.tabelas.get(nome).colunas);
        const colsProd = catProd.tabelas.get(nome).colunas;
        let { origem, destino } = p;
        if (colsProd.some((c) => !colsTeste.has(c))) {
          const plano1 = planejar({ ...catProd, tabelas: new Map([...catProd.tabelas].map(([k, v]) => [k, k === nome ? { ...v, colunas: v.colunas.filter((c) => colsTeste.has(c)) } : v])) }, tenantId, desde, extras).get(nome);
          ({ origem, destino } = plano1);
        }
        const ent = escrita.query(copyFrom(`COPY ${q(nome)} (${destino}) FROM STDIN`));
        await pipeline(leitura.query(copyTo(`COPY (SELECT ${origem} FROM ${q(nome)} WHERE ${p.where}) TO STDOUT`)), ent);
        const n = Number(ent.rowCount || 0);
        if (n) contagens[nome] = n;
        linhas += n;
      }
      await escrita.query('COMMIT');
      await leitura.query('ROLLBACK');
      return { contagens, linhas, apagadas, dias };
    } catch (err) {
      await escrita.query('ROLLBACK').catch(() => {});
      await leitura.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    leitura.release();
    escrita.release();
  }
}

// Apaga a empresa do banco de teste (fim do teste). Devolve o numero de linhas apagadas.
async function apagarEmpresa(tenantId) {
  if (!isUuid(tenantId)) throw new HttpError(400, 'empresa inválida');
  if (!pool.testeConfigurado()) return 0;
  const c = await pool.teste().connect();
  try {
    await c.query('BEGIN');
    try {
      await travar(c, tenantId);
      const cat = await catalogo(c);
      const n = await apagarNoCliente(c, cat, tenantId);
      await c.query('COMMIT');
      return n;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    c.release();
  }
}

module.exports = { copiarEmpresa, apagarEmpresa, catalogo, planejar, planejarLimpeza, HISTORICO, NAO_COPIAR };
