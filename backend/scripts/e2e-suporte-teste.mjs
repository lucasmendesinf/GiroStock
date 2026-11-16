// Teste ponta a ponta do "Testar sem gravar" do suporte do Master.
//
// Uso (API rodando em http://localhost:3000, com DATABASE_URL_TESTE configurado):
//   npm run test:e2e:suporte-teste
//
// Cria uma empresa "E2E ST ..." pela API do Master (senhas aleatorias, so em memoria). Use somente em banco de DESENVOLVIMENTO.
import 'dotenv/config';
import { masterComSegredo } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const SENHA_MASTER = rnd();
const EMAIL_MASTER = 'e2e.st.master@girostock.local';
const email = (q) => `e2e.st.${q}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
const teste = new pg.Client({ connectionString: process.env.DATABASE_URL_TESTE });
await teste.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 400)}`); }
};
async function api(method, rotaOriginal, body, tok) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const rota = method === 'GET' && /^\/master\/(empresas|usuarios)/.test(rotaOriginal) ? rotaOriginal + (rotaOriginal.includes('?') ? '&' : '?') + 'teste=1' : rotaOriginal;
      const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
      const t = await res.text();
      let j; try { j = JSON.parse(t); } catch { j = t; }
      return { s: res.status, j };
    } catch (e) {
      if (method !== 'GET' || i === 2) return { s: 'CAIU', j: e.message };
    }
  }
}
const login = (em, senha) => api('POST', '/auth/login', { email: em, senha });
const decodificar = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
const n = async (db, sql, p) => Number((await db.query(sql, p)).rows[0].n);

// ---------- preparo ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E ST Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
const { token: MAS } = await masterComSegredo(B, EMAIL_MASTER, SENHA_MASTER);
check('login do Master (com 2FA)', !!MAS);
const master = (await prod.query(`SELECT id FROM users WHERE lower(email::text) = $1`, [EMAIL_MASTER])).rows[0];
await prod.query(`UPDATE sessoes_suporte SET encerrada_em = now(), encerrada_por = 'sistema' WHERE master_id = $1 AND encerrada_em IS NULL`, [master.id]);

const r = await api('POST', '/master/empresas', { nome: `E2E ST Empresa ${SUF}`, plano: 'completo', loja_nome: 'Loja ST', admin: { nome: 'Admin ST', email: email('admin') } }, MAS);
check('empresa criada', r.s === 201, r);
const EMP = r.j.empresa.id;
const A_OUTRA = (await prod.query(`SELECT id FROM tenants WHERE id <> $1 AND nome <> 'Plataforma' LIMIT 1`, [EMP])).rows[0].id;
const lg = await login(email('admin'), r.j.senha_temporaria);
const novaSenha = rnd();
await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: novaSenha }, lg.j.token);
const ADM = (await login(email('admin'), novaSenha)).j.token;
const loja = (await api('GET', '/locations', null, ADM)).j[0];
const term = (await api('GET', '/terminals', null, ADM)).j.find((t) => t.location_id === loja.id) || (await api('POST', '/terminals', { nome: 'PDV ST', location_id: loja.id }, ADM)).j;
const cat = (await api('POST', '/categories', { nome: 'Categoria ST' }, ADM)).j;
const prodA = (await api('POST', '/products', { nome: `Produto ST ${SUF}`, categoria_id: cat.id, barcode: String(7891000000000 + (Date.now() % 100000000)), unidade: 'UN', preco_custo: 2, preco_venda: 5, location_id: loja.id, estoque_inicial: 50 }, ADM)).j;
check('produto com estoque 50', !!prodA.id, prodA);
const cx = await api('POST', '/cash-sessions', { terminal_id: term.id, valor_inicial: 10 }, ADM);
check('caixa aberto na produção', cx.s === 201, cx);
const v1 = await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.id, quantidade: 1 }], forma_pagamento: 'pix' }, ADM);
const v2 = await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.id, quantidade: 1 }], forma_pagamento: 'pix' }, ADM);
check('duas vendas na produção', v1.s === 201 && v2.s === 201, [v1, v2]);
// uma venda "antiga" (40 dias): nao vai para a copia
const idAntiga = v1.j.id || v1.j.venda?.id || (await prod.query(`SELECT id FROM sales WHERE tenant_id = $1 ORDER BY criado_em LIMIT 1`, [EMP])).rows[0].id;
await prod.query(`UPDATE sales SET criado_em = now() - interval '40 days' WHERE id = $1`, [idAntiga]);
await prod.query(`UPDATE stock_movements SET criado_em = now() - interval '40 days' WHERE tenant_id = $1 AND sale_id = $2`, [EMP, idAntiga]).catch(() => {});
const vendasProd = await n(prod, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]);
const saldoProd = async () => Number((await prod.query(`SELECT COALESCE(sum(saldo), 0) AS q FROM stock_balances WHERE product_id = $1`, [prodA.id])).rows[0].q);
const saldo0 = await saldoProd();

// ---------- 1. Iniciar o teste ----------
console.log('\n# 1. Testar sem gravar (a partir do suporte)');
check('sem sessão de suporte: Master puro -> 409/403', [403, 409].includes((await api('POST', '/master/suporte/testar', null, MAS)).s));
check('administrador da empresa -> 409 (não está em suporte)', (await api('POST', '/master/suporte/testar', null, ADM)).s === 409);
const sup = await api('POST', `/master/empresas/${EMP}/suporte`, { motivo: 'Chamado e2e: testar sem gravar', edicao: false, avisar: false }, MAS);
check('suporte somente leitura aberto', sup.s === 201, sup);
const SUP = sup.j.token;
check('no suporte somente leitura, abrir caixa/vender na produção é bloqueado (403)', (await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.id, quantidade: 1 }], forma_pagamento: 'pix' }, SUP)).s === 403);
const t0 = Date.now();
const ts = await api('POST', '/master/suporte/testar', null, SUP);
check('POST /master/suporte/testar -> 200 com token do teste', ts.s === 200 && ts.j.token && ts.j.teste && ts.j.teste.dias === 30, ts);
console.log(`       (cópia em ${Date.now() - t0} ms, ${ts.j.teste && ts.j.teste.linhas} linhas)`);
const TT = ts.j.token;
const dec = decodificar(TT);
check('token do teste: modo teste, empresa atendida, prazo <= suporte', dec.modo === 'teste' && dec.empresaTeste === EMP && dec.suporteTeste && dec.exp <= decodificar(SUP).exp + 1, dec);
const reg = (await prod.query(`SELECT * FROM suporte_testes WHERE id = $1`, [ts.j.teste.id])).rows[0];
check('registro do teste na produção (aberto)', reg && reg.tenant_id === EMP && reg.master_id === master.id && !reg.encerrado_em, reg);

// ---------- 2. Cópia parcial ----------
console.log('\n# 2. Cópia parcial no banco de teste');
check('empresa e produto no banco de teste', await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) >= 1 && await n(teste, `SELECT count(*) AS n FROM tenants WHERE id = $1`, [EMP]) === 1);
check('só as vendas dos últimos 30 dias (a de 40 dias ficou de fora)', await n(teste, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]) === vendasProd - 1 && await n(teste, `SELECT count(*) AS n FROM sales WHERE id = $1`, [idAntiga]) === 0);
check('caixa aberto copiado', await n(teste, `SELECT count(*) AS n FROM cash_sessions WHERE tenant_id = $1 AND fechado_em IS NULL`, [EMP]) === 1);
check('sem auditoria nem sessões de suporte da empresa no teste', await n(teste, `SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1`, [EMP]) === 0 && await n(teste, `SELECT count(*) AS n FROM sessoes_suporte WHERE tenant_id = $1`, [EMP]) === 0);
check('nenhum segredo de 2FA no teste', await n(teste, `SELECT count(*) AS n FROM users WHERE tenant_id = $1 AND totp_segredo_cript IS NOT NULL`, [EMP]) === 0);

// ---------- 3. Movimentar sem gravar ----------
console.log('\n# 3. Movimentações no teste não chegam à produção');
const me = await api('GET', '/auth/me', null, TT);
check('/auth/me: Administrador da empresa, modo teste, suporteTeste ativo, sem área Master', me.s === 200 && me.j.perfil === 'Administrador' && me.j.modoTeste === true && me.j.suporteTeste && me.j.suporteTeste.empresa === r.j.empresa.nome && !me.j.areas.Master && !me.j.areas.ModoTeste && me.j.areas.Vendas, me.j);
const vt = await api('POST', '/sales', { terminal_id: term.id, itens: [{ product_id: prodA.id, quantidade: 3 }], forma_pagamento: 'dinheiro', valor_recebido: 20 }, TT);
check('venda no teste (mesmo com suporte somente leitura) -> 201', vt.s === 201, vt);
const et = await api('POST', `/products/${prodA.id}/stock-adjustment`, { location_id: loja.id, novo_saldo: 999, motivo: 'teste e2e do suporte' }, TT);
check('ajuste de estoque no teste (saldo 999)', [200, 201].includes(et.s), et);
check('banco de teste: saldo 999', Number((await teste.query(`SELECT saldo FROM stock_balances WHERE product_id = $1 AND location_id = $2`, [prodA.id, loja.id])).rows[0]?.saldo) === 999);
check('produção: mesma quantidade de vendas', await n(prod, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]) === vendasProd);
check('produção: estoque intacto', (await saldoProd()) === saldo0, { antes: saldo0, depois: await saldoProd() });
check('banco de teste: a venda nova está lá', await n(teste, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]) === vendasProd);
const { iat: _i, exp: _e, ...claims } = dec;
const jwtLib = (await import('jsonwebtoken')).default;
const forjado = await api('GET', '/products', null, jwtLib.sign({ ...claims, empresaTeste: A_OUTRA }, process.env.JWT_SECRET, { expiresIn: 60 }));
check('token do teste com outra empresa (mesmo assinado) -> 401', forjado.s === 401, forjado);
check('painel Master bloqueado no teste (403)', (await api('GET', '/master/empresas', null, TT)).s === 403);
check('trocar a senha no teste -> 403', (await api('POST', '/auth/change-password', { senha_atual: 'x', nova_senha: 'yyyyyy' }, TT)).s === 403);
check('ligar o modo teste comum no teste -> 403', (await api('POST', '/auth/modo-teste', { ativo: false }, TT)).s === 403);
check('o token de suporte continua valendo (produção, somente leitura)', (await api('GET', '/products', null, SUP)).s === 200);

// ---------- 4. Encerrar o teste ----------
console.log('\n# 4. Encerrar o teste apaga a cópia');
const enc = await api('POST', '/master/suporte/testar/encerrar', null, TT);
check('encerrar -> 200', enc.s === 200, enc);
check('cópia da empresa apagada do banco de teste', await n(teste, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]) === 0 && await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) === 0 && await n(teste, `SELECT count(*) AS n FROM tenants WHERE id = $1`, [EMP]) === 0);
const depois = await api('GET', '/products', null, TT);
check('token do teste não vale mais (401, suporteTesteEncerrado, suporte ainda ativo)', depois.s === 401 && depois.j.suporteTesteEncerrado === true && depois.j.suporteAtivo === true, depois);
const fim = (await prod.query(`SELECT * FROM suporte_testes WHERE id = $1`, [ts.j.teste.id])).rows[0];
check('registro: encerrado pelo master e apagado', fim.encerrado_por === 'master' && fim.encerrado_em && fim.apagado_em, fim);
check('o suporte continua aberto depois do teste', (await api('GET', '/auth/me', null, SUP)).j.suporte?.ativo === true);
const audit = await n(prod, `SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND acao IN ('master_suporte_testar', 'master_suporte_testar_encerrar')`, [EMP]);
check('auditoria na produção: início e fim do teste', audit === 2, audit);

// ---------- 5. Fim por inatividade (2 h) ----------
console.log('\n# 5. Teste parado por 2 horas é encerrado e apagado');
const ts2 = await api('POST', '/master/suporte/testar', null, SUP);
check('novo teste na mesma sessão', ts2.s === 200, ts2);
await prod.query(`UPDATE suporte_testes SET ultimo_uso_em = now() - interval '3 hours' WHERE id = $1`, [ts2.j.teste.id]);
const parado = await api('GET', '/products', null, ts2.j.token);
check('requisição depois de 2 h parado -> 401 (teste encerrado)', parado.s === 401 && parado.j.suporteTesteEncerrado === true, parado);
check('cópia apagada', await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) === 0);
check('registro: encerrado_por = parado', (await prod.query(`SELECT encerrado_por FROM suporte_testes WHERE id = $1`, [ts2.j.teste.id])).rows[0].encerrado_por === 'parado');

// ---------- 6. Fim do suporte ----------
console.log('\n# 6. Encerrar o suporte encerra o teste e apaga a cópia');
const ts3 = await api('POST', '/master/suporte/testar', null, SUP);
check('novo teste', ts3.s === 200, ts3);
check('cópia presente', await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) >= 1);
const ts4 = await api('POST', '/master/suporte/testar', null, SUP);
check('testar de novo na mesma sessão refaz a cópia (substitui a anterior)', ts4.s === 200 && (await prod.query(`SELECT encerrado_por FROM suporte_testes WHERE id = $1`, [ts3.j.teste.id])).rows[0].encerrado_por === 'novo_teste', ts4);
check('o token do teste anterior deixa de valer', (await api('GET', '/products', null, ts3.j.token)).s === 401);
check('a cópia continua lá para o teste novo', await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) >= 1 && (await api('GET', '/products', null, ts4.j.token)).s === 200);
const es = await api('POST', '/master/suporte/encerrar', null, SUP);
check('encerrar o suporte -> 200', es.s === 200, es);
await new Promise((ok) => setTimeout(ok, 1500));
check('cópia apagada junto com o fim do suporte', await n(teste, `SELECT count(*) AS n FROM products WHERE tenant_id = $1`, [EMP]) === 0);
const pos = await api('GET', '/products', null, ts4.j.token);
check('token do teste depois do fim do suporte -> 401', pos.s === 401, pos);
check('registro: encerrado_por = suporte_encerrado', (await prod.query(`SELECT encerrado_por FROM suporte_testes WHERE id = $1`, [ts4.j.teste.id])).rows[0].encerrado_por === 'suporte_encerrado');

// ---------- 7. Outro Master não usa o teste de outra sessão; empresa nunca é a Plataforma ----------
console.log('\n# 7. Segurança');
check('produção intacta no fim (vendas e estoque)', await n(prod, `SELECT count(*) AS n FROM sales WHERE tenant_id = $1`, [EMP]) === vendasProd && (await saldoProd()) === saldo0);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
await teste.end();
process.exit(fail ? 1 : 0);
