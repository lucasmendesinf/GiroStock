// Teste ponta a ponta do Painel Master, fase 2: Visao geral (saude, uso, erros) e Auditoria global.
//
// Uso (API rodando em http://localhost:3000, banco migrado ate a 020):
//   npm run test:e2e:master-fase2        # API_URL padrao: http://localhost:3000
//
// Cria a empresa "E2E M2 ..." e usuarios e2e.m2.* pela propria API (senhas aleatorias, so em memoria, nunca impressas).
// Use somente em banco de DESENVOLVIMENTO. O erro 5xx de teste e produzido por um app Express LOCAL do proprio teste
// que reaproveita o middleware de erro real (nenhum codigo de teste existe no servidor).
import 'dotenv/config';
import { createRequire } from 'node:module';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const SENHA_MASTER = rnd();
const EMAIL_MASTER = 'e2e.m2.master@girostock.local';
const email = (quem) => `e2e.m2.${quem}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rota, body, tok, bruto = false) {
  try {
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    if (bruto) return { s: res.status, texto: t, tipo: res.headers.get('content-type') || '', disp: res.headers.get('content-disposition') || '' };
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- preparo ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E M2 Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_MASTER, SENHA_MASTER);
check('login do Master', !!MAS);

const cA = await api('POST', '/master/empresas', { nome: 'E2E M2 Alfa ' + SUF, plano: 'completo', loja_nome: 'Loja Alfa', admin: { nome: 'Admin M2', email: email('adm') } }, MAS);
check('empresa e administrador de teste criados', cA.s === 201, cA);
const A = cA.j.empresa;
const SENHA_ADM = cA.j.senha_temporaria;
const NOVA = rnd();
let TA = (await login(email('adm'), SENHA_ADM)).j.token;
await api('POST', '/auth/change-password', { senha_atual: SENHA_ADM, nova_senha: NOVA }, TA);
const admRow = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = lower($1)`, [email('adm')])).rows[0];

// ---------- 1. Acesso ----------
console.log('\n# 1. So o Master acessa /master/saude|uso|erros|auditoria*');
const rotas = ['/master/saude', '/master/uso', '/master/erros', '/master/auditoria', '/master/auditoria/exportar'];
const negadas = [];
for (const r of rotas) negadas.push((await api('GET', r, null, TA)).s);
check('administrador de empresa recebe 403 em todas', negadas.every((s) => s === 403), negadas);
const semToken = [];
for (const r of rotas) semToken.push((await api('GET', r)).s);
check('sem token -> 401', semToken.every((s) => s === 401), semToken);
const okMaster = [];
for (const r of rotas) okMaster.push((await api('GET', r, null, MAS)).s);
check('Master recebe 200 em todas', okMaster.every((s) => s === 200), okMaster);

// ---------- 2. Erros 5xx ----------
console.log('\n# 2. Captura de erros 5xx');
const app = require('../src/app');
const express = require('express');
const outer = express();
outer.get('/api/teste-erro/:id', () => { throw new Error('falha de teste senha=abc123XYZ usuario joao@exemplo.com token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinaturaFalsa123 postgres://u:p@host/db'); });
outer.use(app.tratarErros);
const srv = http.createServer(outer);
await new Promise((ok) => srv.listen(0, ok));
const portaLocal = srv.address().port;
const antesErros = (await api('GET', '/master/erros', null, MAS)).j;
const r500 = await fetch(`http://127.0.0.1:${portaLocal}/api/teste-erro/${crypto.randomUUID()}?x=segredo`);
check('o erro de teste responde 500 generico', r500.status === 500 && (await r500.json()).erro === 'erro interno do servidor');
srv.close();
await espera(300);
const erros = (await api('GET', '/master/erros?horas=24', null, MAS)).j;
const ult = erros.ultimos[0] || {};
check('contagem por hora tem 24 baldes e subiu', erros.por_hora.length === 24 && erros.total === antesErros.total + 1 && erros.por_hora[23].total >= 1, { total: erros.total, antes: antesErros.total });
check('ultimo erro: metodo + rota (sem query string, id trocado por :id) + status 500', ult.metodo === 'GET' && ult.rota === '/api/teste-erro/:id' && ult.status === 500, ult);
check('mensagem sem senha, e-mail, token nem URL de banco', !/abc123|joao@|eyJ|assinaturaFalsa|postgres:\/\//.test(ult.mensagem) && /\[email\]/.test(ult.mensagem), ult.mensagem);
check('a lista de ultimos tem no maximo 20', erros.ultimos.length <= 20);
await prod.query(`DELETE FROM erros_sistema WHERE rota = '/api/teste-erro/:id'`);

// ---------- 3. Ultimo acesso / online ----------
console.log('\n# 3. ultimo_acesso (max. 1x/min) e usuarios online (5 min)');
const t1 = (await prod.query(`SELECT ultimo_acesso FROM users WHERE id = $1`, [admRow.id])).rows[0].ultimo_acesso;
check('as requisicoes do usuario gravaram ultimo_acesso', !!t1, t1);
const on1 = (await api('GET', '/master/uso', null, MAS)).j.usuarios_online;
await prod.query(`UPDATE users SET ultimo_acesso = now() - interval '6 minutes' WHERE id = $1`, [admRow.id]);
const velho = (await prod.query(`SELECT ultimo_acesso FROM users WHERE id = $1`, [admRow.id])).rows[0].ultimo_acesso;
await api('GET', '/locations', null, TA);
await api('GET', '/locations', null, TA);
await espera(400);
const t2 = (await prod.query(`SELECT ultimo_acesso FROM users WHERE id = $1`, [admRow.id])).rows[0].ultimo_acesso;
check('requisicoes dentro de 1 min NAO regravam ultimo_acesso (no maximo 1x/min)', new Date(t2).getTime() === new Date(velho).getTime(), { velho, t2 });
const on2 = (await api('GET', '/master/uso', null, MAS)).j.usuarios_online;
check('usuarios online respeita a janela de 5 min', on1 >= 1 && on2 === on1 - 1, { on1, on2 });
const uso = (await api('GET', '/master/uso', null, MAS)).j;
check('uso: empresas ativas hoje, cadastrados, lojas e pico de requisicoes (numeros)', ['empresas_ativas_hoje', 'usuarios_online', 'usuarios_cadastrados', 'lojas_ativas', 'requisicoes_por_min_pico'].every((k) => typeof uso[k] === 'number') && uso.requisicoes_por_min_pico >= 1 && uso.requisicoes_serie.length === 60, uso);

// ---------- 4. Saude ----------
console.log('\n# 4. Saude');
const saude = (await api('GET', '/master/saude', null, MAS)).j;
check('API e banco ok, com latencia, versao, tamanho e migrations em dia', saude.api.status === 'ok' && saude.banco.online === true && typeof saude.banco.latenciaMs === 'number' && saude.banco.versao && saude.banco.tamanhoBytes > 0 && saude.banco.migrations.pendentes.length === 0 && saude.banco.status === 'ok', saude.banco);
check('recursos trazem memoria, disco e carga, cada um com status', ['memoria', 'disco', 'carga'].every((k) => ['ok', 'atencao', 'erro', 'indisponivel'].includes(saude.recursos[k].status)), saude.recursos);
const sv = require('../src/services/saude');
const semStatfs = await sv.checarDisco(null);
check('sem fs.statfs o disco vira "indisponivel" sem excecao', semStatfs.status === 'indisponivel', semStatfs);
const statfsQuebrado = await sv.checarDisco((d, cb) => cb(new Error('negado')));
check('statfs com erro tambem vira "indisponivel"', statfsQuebrado.status === 'indisponivel', statfsQuebrado);
check('carga no Windows = "indisponivel"', sv.checarCarga('win32').status === 'indisponivel');
const statfsCheio = await sv.checarDisco((d, cb) => cb(null, { blocks: 1000, bsize: 1, bavail: 100 }));
check('disco acima de 85% = atencao', statfsCheio.status === 'atencao' && statfsCheio.usoPct === 90, statfsCheio);
if (process.env.DATABASE_URL_TESTE) {
  const { aplicarMigracoes } = require('../src/db/migrate');
  const dbTeste = new pg.Pool({ connectionString: process.env.DATABASE_URL_TESTE });
  await aplicarMigracoes(dbTeste, () => {});
  const ultima = (await dbTeste.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`)).rows[0].filename;
  const okAntes = await sv.checarBanco(dbTeste);
  await dbTeste.query(`DELETE FROM schema_migrations WHERE filename = $1`, [ultima]);
  const pend = await sv.checarBanco(dbTeste);
  await dbTeste.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [ultima]);
  check('banco de teste: migration pendente simulada -> status "erro" listando o arquivo', okAntes.status === 'ok' && pend.status === 'erro' && pend.migrations.pendentes.includes(ultima), { okAntes: okAntes.status, pend: pend.status });
  await dbTeste.end();
  check('saude traz tambem o banco de teste', ['ok', 'atencao', 'erro'].includes(saude.bancoTeste.status), saude.bancoTeste);
} else {
  console.log('  (sem DATABASE_URL_TESTE: checagem de migration pendente no teste pulada)');
}

// ---------- 5. Auditoria ----------
console.log('\n# 5. Auditoria global');
// login com falha: 2 falhas nao auditam; a 3a audita; e-mail inexistente cai na empresa "Plataforma"
for (let i = 0; i < 2; i++) await login(email('adm'), 'errada-' + rnd());
const semAudit = await api('GET', `/master/auditoria?tipo=login_falha&empresa_id=${A.id}`, null, MAS);
check('2 falhas seguidas ainda nao geram registro', semAudit.j.total === 0, semAudit.j.total);
await login(email('adm'), 'errada-' + rnd());
const comAudit = await api('GET', `/master/auditoria?tipo=login_falha&empresa_id=${A.id}`, null, MAS);
check('3a falha gera "login_falha" da empresa/usuario certos, sem a senha tentada', comAudit.j.total === 1 && comAudit.j.itens[0].usuario_nome === 'Admin M2' && comAudit.j.itens[0].empresa_nome === 'E2E M2 Alfa ' + SUF && !/errada/.test(JSON.stringify(comAudit.j.itens[0])), comAudit.j.itens[0]);
const fantasma = `e2e.m2.fantasma.${SUF}@girostock.local`;
for (let i = 0; i < 3; i++) await login(fantasma, 'qualquer-' + rnd());
const plat = await api('GET', '/master/auditoria?tipo=login_falha&q=usuario_inexistente', null, MAS);
check('e-mail inexistente: registro na empresa Plataforma (sem o e-mail digitado)', plat.j.itens.length >= 1 && plat.j.itens[0].empresa_nome === 'Plataforma' && !JSON.stringify(plat.j.itens[0]).includes('fantasma'), plat.j.itens[0]);
// criar empresa e suspender (Master)
const susp = await api('POST', `/master/empresas/${A.id}/suspender`, { motivo: 'e2e: auditoria' }, MAS);
check('suspender empresa ok', susp.s === 200, susp);
const aSusp = (await api('GET', `/master/auditoria?tipo=suspensao&empresa_id=${A.id}`, null, MAS)).j;
check('suspensao aparece com tipo "suspensao", empresa e autor Master', aSusp.total === 1 && aSusp.itens[0].tipo === 'suspensao' && aSusp.itens[0].usuario_nome === 'E2E M2 Master', aSusp.itens[0]);
const aCfg = (await api('GET', `/master/auditoria?tipo=config&empresa_id=${A.id}`, null, MAS)).j;
check('criar empresa aparece como "config" (Empresas e usuarios)', aCfg.itens.some((i) => i.acao === 'master_criar_empresa'), aCfg.itens.map((i) => i.acao));
const porUsuario = (await api('GET', `/master/auditoria?usuario_id=${admRow.id}`, null, MAS)).j;
check('filtro por usuario', porUsuario.total >= 1 && porUsuario.itens.every((i) => i.usuario_id === admRow.id), porUsuario.total);
const hoje = new Date().toISOString().slice(0, 10);
const porData = (await api('GET', `/master/auditoria?empresa_id=${A.id}&de=${hoje}&ate=${hoje}`, null, MAS)).j;
const futuro = (await api('GET', `/master/auditoria?empresa_id=${A.id}&de=2999-01-01`, null, MAS)).j;
check('filtro por periodo (hoje inclui, futuro nao)', porData.total >= 2 && futuro.total === 0, { hoje: porData.total, futuro: futuro.total });
const porBusca = (await api('GET', `/master/auditoria?empresa_id=${A.id}&q=suspender`, null, MAS)).j;
check('busca livre por acao', porBusca.total >= 1 && porBusca.itens.every((i) => /suspender/.test(i.acao)), porBusca.total);
check('filtro com id invalido -> lista vazia, sem erro', (await api('GET', '/master/auditoria?empresa_id=nao-e-uuid', null, MAS)).j.total === 0);
const tudo = (await api('GET', '/master/auditoria', null, MAS)).j;
check('paginacao: 50 por pagina, ordem do mais recente', tudo.itens.length <= 50 && tudo.por_pagina === 50 && tudo.itens.every((it, i, a) => i === 0 || new Date(a[i - 1].criado_em) >= new Date(it.criado_em)), { n: tudo.itens.length });
if (tudo.total > 50) {
  const p2 = (await api('GET', '/master/auditoria?pagina=2', null, MAS)).j;
  check('pagina 2 traz itens diferentes da 1', p2.pagina === 2 && p2.itens.length > 0 && !p2.itens.some((x) => tudo.itens.some((y) => y.id === x.id)), p2.pagina);
} else console.log('  (menos de 51 registros: paginacao 2 nao verificada)');
check('lista de tipos acompanha a resposta', tudo.tipos.some((t) => t.codigo === 'login_falha') && tudo.tipos.some((t) => t.codigo === 'suspensao'));
// detalhes sensiveis ficam ocultos
await prod.query(`INSERT INTO audit_logs (tenant_id, usuario_id, acao, recurso, detalhes) VALUES ($1, $2, 'criar', 'e2e_m2', $3)`, [A.id, admRow.id, JSON.stringify({ senha: 'SEGREDO-E2E-123', token: 'tok-E2E-456', totp_segredo_cript: 'cript-E2E', ok: 'visivel', aninhado: { password_hash: 'hash-E2E-789' } })]);
const sens = (await api('GET', `/master/auditoria?empresa_id=${A.id}&q=e2e_m2`, null, MAS)).j;
check('detalhes sensiveis saem como [oculto] na API', sens.itens.length === 1 && sens.itens[0].detalhes.ok === 'visivel' && sens.itens[0].detalhes.senha === '[oculto]' && sens.itens[0].detalhes.aninhado.password_hash === '[oculto]' && !/E2E-\d|cript-E2E/.test(JSON.stringify(sens.j)), sens.itens[0]);
// CSV
const csv = await api('GET', `/master/auditoria/exportar?empresa_id=${A.id}`, null, MAS, true);
const linhasCsv = csv.texto.replace(/^﻿/, '').trim().split('\r\n');
const lista = (await api('GET', `/master/auditoria?empresa_id=${A.id}`, null, MAS)).j;
check('CSV: text/csv, anexo, BOM e cabecalhos em portugues', csv.s === 200 && /text\/csv/.test(csv.tipo) && /attachment/.test(csv.disp) && (new Uint8Array(await (await fetch(B + `/api/master/auditoria/exportar?empresa_id=${A.id}`, { headers: { authorization: 'Bearer ' + MAS } })).arrayBuffer()).slice(0, 3).join() === '239,187,191') && linhasCsv[0] === '"Quando";"Quem";"Empresa";"Tipo";"Ação";"Recurso";"Detalhe"', { tipo: csv.tipo, cab: linhasCsv[0] });
check('CSV: mesmo numero de linhas da lista filtrada e sem segredos', linhasCsv.length - 1 === lista.total && !/SEGREDO-E2E|tok-E2E|cript-E2E|hash-E2E|errada-/.test(csv.texto), { csv: linhasCsv.length - 1, lista: lista.total });
await prod.query(`DELETE FROM audit_logs WHERE recurso = 'e2e_m2'`);

// ---------- 6. Imutavel ----------
console.log('\n# 6. audit_logs nao pode ser editado nem apagado pela API');
const nAntes = Number((await prod.query(`SELECT count(*) AS n FROM audit_logs`)).rows[0].n);
const idAud = lista.itens[0].id;
const tentativas = [];
for (const m of ['PATCH', 'PUT', 'DELETE', 'POST']) for (const r of ['/master/auditoria', `/master/auditoria/${idAud}`]) tentativas.push((await api(m, r, { acao: 'x' }, MAS)).s);
const nDepois = Number((await prod.query(`SELECT count(*) AS n FROM audit_logs`)).rows[0].n);
check('nenhuma rota de escrita (todas 404) e nada mudou', tentativas.every((s) => s === 404) && nDepois >= nAntes, { tentativas, nAntes, nDepois });

// ---------- 7. Sem dados de negocio ----------
console.log('\n# 7. Nada de vendas/pedidos/clientes');
const proibidas = /"(vendas|faturamento|sales|orders|pedidos|customers|clientes|produtos|products|receita|total_vendas)"\s*:/i;
const corpos = [JSON.stringify(saude), JSON.stringify(uso), JSON.stringify(erros)];
check('respostas sem chaves de vendas/pedidos/clientes/produtos', corpos.every((c) => !proibidas.test(c)), corpos.map((c) => (c.match(proibidas) || [])[0]));

// ---------- 8. Regressao e latencia ----------
console.log('\n# 8. Regressao basica e latencia do middleware de metricas');
const lg = await login(email('adm'), NOVA);
check('login de empresa suspensa segue bloqueado (regressao Fase 1)', lg.s === 403);
const t0 = Date.now();
for (let i = 0; i < 100; i++) await fetch(B + '/health');
const msHealth = (Date.now() - t0) / 100;
const t1b = Date.now();
for (let i = 0; i < 100; i++) await fetch(B + '/api/auth/me', { headers: { authorization: 'Bearer ' + MAS } });
const msApi = (Date.now() - t1b) / 100;
console.log(`  info  /health (sem middleware): ${msHealth.toFixed(1)} ms/req; /api/auth/me (com contador + ultimo_acesso): ${msApi.toFixed(1)} ms/req`);
check('requisicao autenticada continua rapida (< 100 ms em media, local)', msApi < 100, msApi);
const finalMe = await api('GET', '/auth/me', null, MAS);
check('Master segue entrando normalmente', finalMe.s === 200 && finalMe.j.areas.Master === true);

// ---------- limpeza ----------
await prod.query(`UPDATE users SET ativo = false WHERE lower(email::text) LIKE 'e2e.m2.%'`);
await prod.query(`UPDATE tenants SET status = 'suspensa', suspenso_motivo = 'e2e', suspenso_em = now() WHERE nome LIKE 'E2E M2 %'`);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
