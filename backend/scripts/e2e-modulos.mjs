// Teste ponta a ponta dos modulos (segmentos) por plano e por empresa: o Master libera PDV, Lanchonete, Pedidos,
// Clientes e os modulos futuros (iFood/99Food, Eventos, Loja virtual, Financeiro); o cliente so usa o que contratou.
//
// Uso (API rodando, banco migrado ate a 024):
//   npm run test:e2e:modulos        # API_URL padrao: http://localhost:3000
//
// Cria empresas "E2E MOD ..." e usuarios e2e.mod.* pela API do Master. Use somente em banco de DESENVOLVIMENTO.
// No fim, as empresas ficam suspensas.
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
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
const EMAIL_MASTER = 'e2e.mod.master@girostock.local';
const email = (quem) => `e2e.mod.${quem}.${SUF}@girostock.local`;

const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0;
let fail = 0;
const check = (nome, cond, info) => {
  if (cond) { pass++; console.log(`  ok   ${nome}`); } else { fail++; console.log(`  FALHA ${nome} -> ${String(JSON.stringify(info)).slice(0, 300)}`); }
};
async function api(method, rotaOriginal, body, tok) {
  try {
    const rota = method === 'GET' && /^\/master\/empresas/.test(rotaOriginal) ? rotaOriginal + (rotaOriginal.includes('?') ? '&' : '?') + 'teste=1' : rotaOriginal;
    const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { s: res.status, j };
  } catch (e) { return { s: 'CAIU', j: e.message }; }
}
// Cria a empresa pelo Master e devolve o token do administrador (ja com a senha trocada).
async function empresaComAdmin(rotulo, extra) {
  const c = await api('POST', '/master/empresas', { nome: `E2E MOD ${rotulo} ${SUF}`, loja_nome: 'Loja ' + rotulo, admin: { nome: 'Admin ' + rotulo, email: email(rotulo.toLowerCase()) }, ...extra }, MAS);
  if (c.s !== 201) return { c };
  const lg = await api('POST', '/auth/login', { email: email(rotulo.toLowerCase()), senha: c.j.senha_temporaria });
  const nova = 'Nova' + rnd();
  await api('POST', '/auth/change-password', { senha_atual: c.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  const lg2 = await api('POST', '/auth/login', { email: email(rotulo.toLowerCase()), senha: nova });
  return { c, empresa: c.j.empresa, tok: lg2.j.token, usuario: lg2.j.usuario };
}

// ---------- preparo: Master e2e ----------
const mk = spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_MASTER, MASTER_PASSWORD: SENHA_MASTER, MASTER_NOME: 'E2E MOD Master' }, encoding: 'utf8' });
check('Master e2e criado/atualizado por script', mk.status === 0, mk.stderr);
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_MASTER, SENHA_MASTER);
check('login do Master', !!MAS);

// ---------- 1. Catalogo e planos ----------
console.log('\n# 1. Catalogo de modulos e planos prontos');
const cat = await api('GET', '/master/modulos', null, MAS);
const chaves = cat.s === 200 ? cat.j.modulos.map((m) => m.chave) : [];
check('GET /master/modulos traz os 8 modulos', ['pdv', 'lanchonete', 'pedidos', 'clientes', 'delivery_apps', 'eventos', 'loja_virtual', 'financeiro'].every((k) => chaves.includes(k)), cat.j);
check('iFood/99Food, Eventos, Loja virtual e Financeiro marcados como em breve', cat.j.modulos.filter((m) => !m.disponivel).map((m) => m.chave).sort().join() === 'delivery_apps,eventos,financeiro,loja_virtual', cat.j.modulos);
check('Pedidos depende do PDV', cat.j.modulos.find((m) => m.chave === 'pedidos').requer.includes('pdv'));
const pls = await api('GET', '/master/planos', null, MAS);
const plano = (c) => pls.j.planos.find((p) => p.codigo === c);
check('planos Só PDV e Lanchonete criados pela migracao', !!plano('so_pdv') && !!plano('lanchonete'), pls.j);
check('Só PDV: so o PDV ligado', plano('so_pdv') && chaves.every((k) => plano('so_pdv').recursos[k] === (k === 'pdv')), plano('so_pdv'));
check('Completo continua com PDV, Lanchonete, Pedidos e Clientes (nada mudou para quem ja usa)', ['pdv', 'lanchonete', 'pedidos', 'clientes'].every((k) => plano('completo').recursos[k] === true) && plano('completo').recursos.eventos === false, plano('completo'));
check('Básico continua com PDV e Lanchonete, sem Pedidos/Clientes', plano('basico').recursos.pdv && plano('basico').recursos.lanchonete && !plano('basico').recursos.pedidos && !plano('basico').recursos.clientes, plano('basico'));

console.log('\n# 2. Criar, validar e remover planos');
const semPdv = await api('POST', '/master/planos', { nome: 'E2E MOD Ruim ' + SUF, recursos: { pdv: false, pedidos: true } }, MAS);
check('plano com Pedidos sem PDV -> 400 explicando a dependencia', semPdv.s === 400 && /PDV/.test(semPdv.j.erro), semPdv);
const desconhecido = await api('POST', '/master/planos', { nome: 'E2E MOD X ' + SUF, recursos: { voar: true } }, MAS);
check('modulo desconhecido -> 400', desconhecido.s === 400, desconhecido);
const novoPl = await api('POST', '/master/planos', { nome: 'E2E MOD Eventos ' + SUF, max_lojas: 2, max_usuarios: 4, max_pdvs: 3, recursos: { pdv: true, eventos: true } }, MAS);
check('cria plano novo (PDV + Eventos) com codigo gerado do nome', novoPl.s === 201 && novoPl.j.codigo.startsWith('e2e_mod_eventos') && novoPl.j.recursos.eventos === true && novoPl.j.recursos.lanchonete === false, novoPl);
const dupPl = await api('POST', '/master/planos', { nome: 'E2E MOD Eventos ' + SUF }, MAS);
check('nome de plano repetido -> 409', dupPl.s === 409, dupPl);
const edPl = await api('PUT', `/master/planos/${novoPl.j.codigo}`, { recursos: { pdv: false } }, MAS);
check('editar plano desligando o PDV com Eventos ligado -> 400', edPl.s === 400, edPl);
const edPl2 = await api('PUT', `/master/planos/${novoPl.j.codigo}`, { recursos: { clientes: true } }, MAS);
check('editar plano somando Clientes mantem os outros modulos', edPl2.s === 200 && edPl2.j.recursos.clientes && edPl2.j.recursos.eventos && edPl2.j.recursos.pdv, edPl2);
const rmPl = await api('DELETE', `/master/planos/${novoPl.j.codigo}`, null, MAS);
check('remove plano sem empresas -> 204', rmPl.s === 204, rmPl);
const rmCompleto = await api('DELETE', '/master/planos/completo', null, MAS);
check('plano Completo (padrão do sistema) não pode ser removido -> 409', rmCompleto.s === 409, rmCompleto);
const rmUsado = await api('DELETE', '/master/planos/so_pdv', null, MAS);
const usadoAntes = (await prod.query(`SELECT COUNT(*)::int AS n FROM tenants WHERE plano = 'so_pdv'`)).rows[0].n;
check('remover plano em uso -> 409 (ou 204 se ninguem usa ainda)', usadoAntes > 0 ? rmUsado.s === 409 : rmUsado.s === 204 || rmUsado.s === 409, rmUsado);
if (rmUsado.s === 204) await prod.query(`INSERT INTO planos (codigo, nome, max_lojas, max_usuarios, max_pdvs, recursos) VALUES ('so_pdv', 'Só PDV (varejo/distribuidora)', 1, 3, 2, '{"pdv": true, "lanchonete": false, "pedidos": false, "clientes": false, "delivery_apps": false, "eventos": false, "loja_virtual": false, "financeiro": false}') ON CONFLICT DO NOTHING`);

// ---------- 3. Cliente que so comprou o PDV ----------
console.log('\n# 3. Empresa no plano Só PDV: so o ponto de venda');
const P = await empresaComAdmin('Varejo', { plano: 'so_pdv' });
check('empresa Só PDV criada e administrador entra', P.c.s === 201 && !!P.tok, P.c);
const meP = await api('GET', '/auth/me', null, P.tok);
check('/auth/me traz os modulos (pdv sim, lanchonete/pedidos/clientes nao)', meP.s === 200 && meP.j.modulos && meP.j.modulos.pdv === true && meP.j.modulos.lanchonete === false && meP.j.modulos.pedidos === false && meP.j.modulos.clientes === false, meP.j.modulos);
check('login tambem traz os modulos', P.usuario && P.usuario.modulos && P.usuario.modulos.pdv === true && P.usuario.modulos.lanchonete === false, P.usuario && P.usuario.modulos);
check('areas: Vendas sim, Pedidos e Clientes nao (mesmo sendo Administrador)', meP.j.areas.Vendas === true && meP.j.areas.Pedidos === false && meP.j.areas.Clientes === false, meP.j.areas);
const ingP = await api('GET', '/ingredients', null, P.tok);
check('GET /ingredients -> 403 "não faz parte do plano"', ingP.s === 403 && ingP.j.modulo === 'lanchonete' && /plano/.test(ingP.j.erro), ingP);
check('POST /ingredients -> 403', (await api('POST', '/ingredients', { nome: 'Pão', unidade: 'UN' }, P.tok)).s === 403);
check('GET /consumption-feed -> 403', (await api('GET', '/consumption-feed', null, P.tok)).s === 403);
check('GET /orders -> 403', (await api('GET', '/orders', null, P.tok)).s === 403);
check('GET /customers -> 403', (await api('GET', '/customers', null, P.tok)).s === 403);
const cats = await api('POST', '/categories', { nome: 'Bebidas' }, P.tok);
const fichaP = await api('POST', '/products', { nome: 'X-Burguer', categoria_id: cats.j.id, barcode: '78910001' + String(Date.now()).slice(-5), unidade: 'UN', preco_custo: 5, preco_venda: 12, ficha_tecnica: [{ ingredient_id: '00000000-0000-0000-0000-000000000000', quantidade_por_unidade: 1 }] }, P.tok);
check('produto com ficha tecnica -> 403 (sem modulo Lanchonete)', fichaP.s === 403 && fichaP.j.modulo === 'lanchonete', fichaP);
const lojasP = await api('GET', '/locations', null, P.tok);
const prodP = await api('POST', '/products', { nome: 'Refrigerante Lata', categoria_id: cats.j.id, barcode: '78910002' + String(Date.now()).slice(-5), unidade: 'UN', preco_custo: 3, preco_venda: 6, location_id: lojasP.j[0].id }, P.tok);
check('produto comum (revenda) continua normal -> 201', prodP.s === 201, prodP);
// O PDV funciona de ponta a ponta: terminal, entrada de estoque, abrir caixa e vender.
const termP = await api('POST', '/terminals', { nome: 'PDV Balcão', location_id: lojasP.j[0].id }, P.tok);
await api('POST', '/stock-movements', { product_id: prodP.j.id, tipo: 'entrada', quantidade: 10, location_destino_id: lojasP.j[0].id, motivo: 'estoque inicial e2e' }, P.tok);
const cxP = await api('POST', '/cash-sessions', { terminal_id: termP.j.id, valor_inicial: 0 }, P.tok);
const vendaP = await api('POST', '/sales', { terminal_id: termP.j.id, itens: [{ product_id: prodP.j.id, quantidade: 2 }], forma_pagamento: 'pix' }, P.tok);
check('PDV completo: cadastra terminal, abre caixa e vende', termP.s === 201 && cxP.s === 201 && vendaP.s === 201, { t: termP.s, c: cxP, v: vendaP });
const permsP = await api('GET', '/users/permissoes', null, P.tok);
check('tela de usuarios nao oferece Pedidos/Clientes, mas oferece Vendas e Desconto', permsP.s === 200 && !('Pedidos' in permsP.j.permissoes) && !('Clientes' in permsP.j.permissoes) && 'Vendas' in permsP.j.permissoes && 'Desconto' in permsP.j.permissoes, permsP.j.permissoes);

// ---------- 4. Master libera / bloqueia na hora ----------
console.log('\n# 4. Liberar e bloquear modulos de uma empresa (vale na hora, sem novo login)');
const lib = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { pedidos: true } }, MAS);
check('Master libera Pedidos so para esta empresa', lib.s === 200, lib);
check('na hora: GET /orders -> 200', (await api('GET', '/orders', null, P.tok)).s === 200);
const ficha = await api('GET', `/master/empresas/${P.empresa.id}`, null, MAS);
const fPed = ficha.j.modulos.find((m) => m.chave === 'pedidos');
check('ficha: Pedidos ligado, origem empresa, no plano desligado', fPed && fPed.ligado === true && fPed.origem === 'empresa' && fPed.no_plano === false, fPed);
check('ficha: PDV segue o plano', ficha.j.modulos.find((m) => m.chave === 'pdv').origem === 'plano');
const lib2 = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { clientes: true } }, MAS);
const ficha2 = await api('GET', `/master/empresas/${P.empresa.id}`, null, MAS);
check('liberar outro modulo soma (nao apaga a liberacao de Pedidos)', lib2.s === 200 && ficha2.j.recursos.pedidos === true && ficha2.j.recursos.clientes === true, ficha2.j.recursos);
const conflito = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { pdv: false } }, MAS);
check('desligar o PDV com Pedidos ligado -> 400 explicando', conflito.s === 400 && /PDV/.test(conflito.j.erro), conflito);
const tiraPdv = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { pdv: false, pedidos: null } }, MAS);
check('desliga PDV e Pedidos volta ao plano (desligado)', tiraPdv.s === 200, tiraPdv);
const meSemPdv = await api('GET', '/auth/me', null, P.tok);
check('na hora: /auth/me sem PDV e sem a area Vendas/Desconto', meSemPdv.j.modulos.pdv === false && meSemPdv.j.areas.Vendas === false && meSemPdv.j.areas.Desconto === false, { m: meSemPdv.j.modulos, a: meSemPdv.j.areas });
check('abrir caixa -> 403', (await api('POST', '/cash-sessions', { terminal_id: '00000000-0000-0000-0000-000000000000', valor_abertura: 0 }, P.tok)).s === 403);
check('vender -> 403', (await api('POST', '/sales', { itens: [] }, P.tok)).s === 403);
check('produtos e estoque continuam (sempre incluidos)', (await api('GET', '/products', null, P.tok)).s === 200 && (await api('GET', '/suppliers', null, P.tok)).s === 200);
const voltar = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { pdv: null } }, MAS);
check('PDV volta a seguir o plano (ligado)', voltar.s === 200 && (await api('GET', '/auth/me', null, P.tok)).j.modulos.pdv === true, voltar);
const modDesc = await api('PATCH', `/master/empresas/${P.empresa.id}`, { recursos: { teletransporte: true } }, MAS);
check('modulo desconhecido na empresa -> 400', modDesc.s === 400, modDesc);
const pr = await api('PATCH', `/master/empresas/${P.empresa.id}`, { plano: 'lanchonete' }, MAS);
const mePl = await api('GET', '/auth/me', null, P.tok);
check('trocar para o plano Lanchonete libera Lanchonete e Pedidos na hora', pr.s === 200 && mePl.j.modulos.lanchonete && mePl.j.modulos.pedidos, mePl.j.modulos);
check('agora GET /ingredients -> 200', (await api('GET', '/ingredients', null, P.tok)).s === 200);

// ---------- 5. Criar empresa ja com modulos ajustados ----------
console.log('\n# 5. Nova empresa com módulos diferentes do plano');
const L = await empresaComAdmin('Lanche', { plano: 'lanchonete', recursos: { clientes: false, delivery_apps: true } });
check('cria empresa no plano Lanchonete sem Clientes e com iFood/99Food liberado', L.c.s === 201, L.c);
const fL = await api('GET', `/master/empresas/${L.empresa.id}`, null, MAS);
const mod = (k) => fL.j.modulos.find((m) => m.chave === k);
check('ficha: Clientes bloqueado so para a empresa; iFood/99Food liberado so para a empresa; Pedidos segue o plano',
  mod('clientes').ligado === false && mod('clientes').origem === 'empresa' && mod('delivery_apps').ligado === true && mod('delivery_apps').origem === 'empresa' && mod('pedidos').origem === 'plano', fL.j.modulos);
const meL = await api('GET', '/auth/me', null, L.tok);
check('admin da lanchonete: lanchonete/pedidos sim, clientes nao', meL.j.modulos.lanchonete && meL.j.modulos.pedidos && !meL.j.modulos.clientes && meL.j.areas.Pedidos && !meL.j.areas.Clientes, meL.j.modulos);
const ruim = await api('POST', '/master/empresas', { nome: 'E2E MOD Ruim ' + SUF, plano: 'so_pdv', recursos: { delivery_apps: true }, admin: { nome: 'X', email: email('ruim') } }, MAS);
check('criar empresa com iFood/99Food sem Pedidos -> 400 (e nada e criado)', ruim.s === 400 && /Pedidos/.test(ruim.j.erro) && (await prod.query(`SELECT 1 FROM tenants WHERE nome = $1`, ['E2E MOD Ruim ' + SUF])).rows.length === 0, ruim);

// ---------- 6. Quem ja usa nao muda ----------
console.log('\n# 6. Empresa existente (plano Completo) continua igual');
const seed = await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' });
if (seed.s === 200 && seed.j.token) {
  const meS = await api('GET', '/auth/me', null, seed.j.token);
  check('empresa do seed: PDV, Lanchonete, Pedidos e Clientes ligados', ['pdv', 'lanchonete', 'pedidos', 'clientes'].every((k) => meS.j.modulos[k] === true), meS.j.modulos);
  check('empresa do seed: insumos e pedidos respondem', (await api('GET', '/ingredients', null, seed.j.token)).s === 200 && (await api('GET', '/orders', null, seed.j.token)).s === 200);
} else {
  console.log('  (pulado: admin do seed com outra senha neste banco)');
}

// ---------- limpeza ----------
for (const e of [P.empresa, L.empresa].filter(Boolean)) await api('POST', `/master/empresas/${e.id}/suspender`, { motivo: 'fim do teste e2e de módulos' }, MAS);
await prod.end();
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
