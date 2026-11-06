// e2e da nota fiscal (NFC-e): modulo, configuracao fiscal da loja, certificado, CSC, perfis fiscais, NCM, emissao (teste),
// rejeicao e reenvio, contingencia offline, cancelamento, permissoes e isolamento.
// Precisa do servidor com FISCAL_SIMULADOR=1 (a nota e montada, assinada e validada no XSD de verdade; so o envio a SEFAZ
// e simulado) e do PHP com as dependencias de backend/fiscal (composer install).
// npm run test:e2e:fiscal   (API em http://localhost:3000)
import 'dotenv/config';
import { tokenDoMasterComDoisFatores } from './e2e-2fa-helper.mjs';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.API_URL || 'http://localhost:3000';
const rnd = () => crypto.randomBytes(9).toString('base64url');
const SUF = Date.now().toString(36);
const EMAIL_M = 'e2e.fiscal.master@girostock.local';
const SENHA_M = rnd();
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
await prod.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
const login = (e, s) => api('POST', '/auth/login', { email: e, senha: s });
const igual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

// certificado A1 de teste (autoassinado): vale para montar/assinar/validar, nao para a SEFAZ de verdade
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fiscal-'));
spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '365', '-subj', '/C=BR/O=ICP-Brasil/CN=EMPRESA TESTE LTDA:11222333000181']);
spawnSync('openssl', ['pkcs12', '-export', '-inkey', `${tmp}/k.pem`, '-in', `${tmp}/c.pem`, '-out', `${tmp}/t.pfx`, '-passout', 'pass:1234', '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']);
const PFX = fs.readFileSync(`${tmp}/t.pfx`).toString('base64');

spawnSync('node', ['scripts/master.js'], { cwd: raiz, env: { ...process.env, MASTER_EMAIL: EMAIL_M, MASTER_PASSWORD: SENHA_M, MASTER_NOME: 'E2E Fiscal Master' }, encoding: 'utf8' });
const MAS = await tokenDoMasterComDoisFatores(B, EMAIL_M, SENHA_M);
async function novaEmpresa(rotulo) {
  const email = `e2e.fiscal.${rotulo}.${SUF}@girostock.local`;
  const r = await api('POST', '/master/empresas', { nome: `E2E FISCAL ${rotulo} ${SUF}`, plano: 'completo', loja_nome: 'Distribuidora', admin: { nome: `Admin ${rotulo}`, email } }, MAS);
  const lg = await login(email, r.j.senha_temporaria);
  const nova = rnd();
  await api('POST', '/auth/change-password', { senha_atual: r.j.senha_temporaria, nova_senha: nova }, lg.j.token);
  return { id: r.j.empresa.id, token: lg.j.token };
}

console.log('\n# 1. Módulo e configuração da loja');
const E = await novaEmpresa('a');
check('sem o módulo: /fiscal -> 403', (await api('GET', '/fiscal/lojas', null, E.token)).s === 403);
await api('PATCH', `/master/empresas/${E.id}`, { recursos: { nota_fiscal: true } }, MAS);
const LOJA = (await prod.query('SELECT id FROM locations WHERE tenant_id = $1', [E.id])).rows[0].id;
const lojas = await api('GET', '/fiscal/lojas', null, E.token);
check('lista as lojas (ainda sem configuração)', lojas.s === 200 && lojas.j.lojas.length === 1 && lojas.j.lojas[0].configurada === false && lojas.j.simulador === true, lojas.j);
const cfgBase = { cnpj: '11.222.333/0001-81', ie: '9012345678', razao_social: 'JA CONVENIENCIA LTDA', nome_fantasia: 'J&A Conveniência', logradouro: 'Rua Enette Dubard', numero: '229', bairro: 'Tatuquara', cod_municipio: '4106902', municipio: 'Curitiba', uf: 'PR', cep: '81470-075', telefone: '(41) 99520-9684', ambiente: 'homologacao', modo_pdv: 'perguntar' };
const salvar = (b) => api('PUT', `/fiscal/lojas/${LOJA}`, { ...cfgBase, ...b }, E.token);
check('CNPJ inválido -> 400', (await salvar({ cnpj: '11.222.333/0001-82' })).s === 400);
check('município de outro estado -> 400', (await salvar({ cod_municipio: '3550308' })).s === 400);
check('CEP inválido -> 400', (await salvar({ cep: '123' })).s === 400);
const sv = await salvar({});
check('salva a configuração fiscal (teste/homologação, perguntar no PDV)', sv.s === 200 && sv.j.configurada && sv.j.ambiente === 'homologacao' && sv.j.cnpj === '11222333000181' && sv.j.pronta === false, sv.j);
check('pendências: certificado e CSC', sv.j.pendencias.some((p) => /certificado/.test(p)) && sv.j.pendencias.some((p) => /CSC/.test(p)), sv.j.pendencias);
check('certificado com senha errada -> 400', (await api('POST', `/fiscal/lojas/${LOJA}/certificado`, { pfx_b64: PFX, senha: 'errada' }, E.token)).s === 400);
const cert = await api('POST', `/fiscal/lojas/${LOJA}/certificado`, { pfx_b64: PFX, senha: '1234' }, E.token);
check('certificado A1 aceito (titular e validade)', cert.s === 200 && /EMPRESA TESTE/.test(cert.j.titular) && /^\d{4}-\d{2}-\d{2}$/.test(cert.j.validade), cert.j);
const comCsc = await salvar({ csc_homologacao: '0123456789ABCDEF0123456789ABCDEF', csc_homolog_id: '1' });
check('com o CSC de homologação: pronta para emitir', comCsc.j.pronta === true && comCsc.j.csc_homologacao === true && comCsc.j.csc_homolog_id === '000001' && !JSON.stringify(comCsc.j).includes('0123456789ABCDEF'), comCsc.j);
check('segredos ficam cifrados no banco', !(await prod.query(`SELECT csc_homolog_cript, cert_senha_cript FROM fiscal_lojas WHERE location_id = $1`, [LOJA])).rows[0].csc_homolog_cript.includes('0123456789'));
check('testar comunicação com a SEFAZ (simulador)', (await api('POST', `/fiscal/lojas/${LOJA}/testar`, {}, E.token)).j.ok === true);

console.log('\n# 2. Perfis fiscais e NCM');
check('perfil com CFOP de fora do estado -> 400', (await api('POST', '/fiscal/perfis', { nome: 'X', cfop: '6102', csosn: '102' }, E.token)).s === 400);
const pBebida = (await api('POST', '/fiscal/perfis', { nome: 'Bebida com ST', cfop: '5405', csosn: '500' }, E.token)).j;
const pPadrao = (await api('POST', '/fiscal/perfis', { nome: 'Mercadoria (padrão)', cfop: '5102', csosn: '102', padrao: true }, E.token)).j;
check('cria perfis (um padrão)', pBebida.id && pPadrao.padrao === true, [pBebida, pPadrao]);
check('nome repetido -> 409', (await api('POST', '/fiscal/perfis', { nome: 'bebida com st', cfop: '5405', csosn: '500' }, E.token)).s === 409);
await api('POST', '/categories', { nome: 'Bebidas' }, E.token);
await api('POST', '/categories', { nome: 'Tabacaria' }, E.token);
const cats = Object.fromEntries((await api('GET', '/categories', null, E.token)).j.map((c) => [c.nome, c.id]));
const bc = () => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const produto = async (nome, cat, venda) => (await api('POST', '/products', { nome, categoria_id: cat, barcode: bc(), unidade: 'UN', preco_custo: 2, preco_venda: venda, location_id: LOJA, estoque_inicial: 100 }, E.token)).j.id;
const REFRI = await produto('Refrigerante Lata 350ml', cats.Bebidas, 6);
const ESSENCIA = await produto('Essência Narguilé 50g', cats.Tabacaria, 25);
check('categoria com perfil (Bebidas = Bebida com ST)', (await api('PUT', `/fiscal/categorias/${cats.Bebidas}`, { perfil_fiscal_id: pBebida.id }, E.token)).s === 200);
const pend = (await api('GET', '/fiscal/produtos?pendentes=1', null, E.token)).j;
check('produtos sem NCM aparecem como pendentes; perfil vem da categoria ou do padrão', pend.length === 2 && pend.find((p) => p.id === REFRI).perfil_origem === 'categoria' && pend.find((p) => p.id === ESSENCIA).perfil_origem === 'padrão', pend);
check('NCM inválido -> 400', (await api('PUT', `/fiscal/produtos/${REFRI}`, { ncm: '2202' }, E.token)).s === 400);

console.log('\n# 3. Emissão da NFC-e (teste)');
const T = (await api('POST', '/terminals', { location_id: LOJA, nome: 'Caixa 1' }, E.token)).j.id;
await api('POST', '/cash-sessions', { terminal_id: T, valor_inicial: 0 }, E.token);
const v1 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 3 }, { product_id: ESSENCIA, quantidade: 1 }], forma_pagamento: 'dinheiro', valor_recebido: 50, desconto: 3 }, E.token)).j;
const semNcm = await api('POST', '/fiscal/nfce', { sale_id: v1.id }, E.token);
check('produto sem NCM: nota recusada antes de gastar número', semNcm.s === 400 && /NCM/.test(semNcm.j.erro) && !(await prod.query(`SELECT 1 FROM notas_fiscais WHERE tenant_id = $1`, [E.id])).rows.length, semNcm.j);
await api('PUT', `/fiscal/produtos/${REFRI}`, { ncm: '22021000', cest: '0300700' }, E.token);
const ncmNota = await api('POST', '/fiscal/produtos/ncm-da-nota', { itens: [{ product_id: ESSENCIA, ncm: '24031900' }, { product_id: REFRI, ncm: '99999999' }] }, E.token);
check('NCM da nota de compra preenche só quem não tem', ncmNota.j.atualizados === 1 && (await prod.query(`SELECT ncm FROM products WHERE id = $1`, [REFRI])).rows[0].ncm === '22021000', ncmNota.j);
check('CPF inválido -> 400', (await api('POST', '/fiscal/nfce', { sale_id: v1.id, cpf: '111.111.111-11' }, E.token)).s === 400);
const n1 = await api('POST', '/fiscal/nfce', { sale_id: v1.id, cpf: '529.982.247-25' }, E.token);
check('NFC-e autorizada (nº 1, série 1, teste)', n1.s === 201 && n1.j.situacao === 'autorizada' && n1.j.numero === 1 && n1.j.serie === 1 && n1.j.teste === true && /^41\d{42}$/.test(n1.j.chave) && n1.j.protocolo, n1.j);
check('QR Code da SEFAZ-PR', /fazenda\.pr\.gov\.br\/nfce\/qrcode\?p=/.test(n1.j.qrcode), n1.j.qrcode);
const xml = await (await fetch(`${B}/api/fiscal/notas/${n1.j.id}/xml`, { headers: { authorization: 'Bearer ' + E.token } })).text();
const tot = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) || [''])[0];
const tag = (t, onde = xml) => (onde.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
check('XML: total da nota = total da venda, desconto rateado, troco e CPF', igual(tag('vNF', tot), v1.total) && igual(tag('vDesc', tot), 3) && igual(tag('vTroco'), 50 - v1.total) && tag('CPF') === '52998224725' && xml.includes('<nfeProc'), { vNF: tag('vNF', tot), total: v1.total, vDesc: tag('vDesc', tot), vTroco: tag('vTroco') });
check('XML de teste: "SEM VALOR FISCAL", CSOSN 500 na bebida e 102 na essência', xml.includes('SEM VALOR FISCAL') && xml.includes('<CSOSN>500</CSOSN>') && xml.includes('<CSOSN>102</CSOSN>') && xml.includes('<CFOP>5405</CFOP>') && xml.includes('<NCM>24031900</NCM>'));
const de2 = await api('POST', '/fiscal/nfce', { sale_id: v1.id }, E.token);
check('emitir de novo a mesma venda devolve a mesma nota', de2.j.id === n1.j.id);

console.log('\n# 4. Rejeição, reenvio e contingência');
const v2 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 1 }], forma_pagamento: 'pix' }, E.token)).j;
const rej = await api('POST', '/fiscal/nfce', { sale_id: v2.id, simular: 'rejeitar' }, E.token);
check('rejeitada pela SEFAZ: guarda o motivo (nº 2)', rej.j.situacao === 'rejeitada' && rej.j.numero === 2 && /NCM/.test(rej.j.motivo), rej.j);
const re = await api('POST', `/fiscal/notas/${rej.j.id}/reenviar`, {}, E.token);
check('reenviar depois de corrigir: autorizada com o mesmo número', re.j.situacao === 'autorizada' && re.j.numero === 2 && re.j.id === rej.j.id, re.j);
const v3 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: ESSENCIA, quantidade: 2 }], forma_pagamento: 'cartao_debito' }, E.token)).j;
const cont = await api('POST', '/fiscal/nfce', { sale_id: v3.id, simular: 'sem_conexao' }, E.token);
check('sem conexão com a SEFAZ: sai em contingência offline (com QR Code, nº 3)', cont.j.situacao === 'contingencia' && cont.j.numero === 3 && cont.j.qrcode && cont.j.chave && cont.j.chave[34] === '9', cont.j);
const xmlC = (await prod.query(`SELECT xml FROM notas_fiscais WHERE id = $1`, [cont.j.id])).rows[0].xml;
check('XML de contingência: tpEmis 9 com a justificativa', xmlC.includes('<tpEmis>9</tpEmis>') && xmlC.includes('<xJust>'));
check('nota em contingência não pode ser cancelada antes de enviar (409)', (await api('POST', `/fiscal/notas/${cont.j.id}/cancelar`, { justificativa: 'cliente desistiu da compra' }, E.token)).s === 409);
const tx = await api('POST', `/fiscal/notas/${cont.j.id}/reenviar`, {}, E.token);
check('quando a conexão volta, a nota de contingência é transmitida e autorizada', tx.j.situacao === 'autorizada' && tx.j.protocolo, tx.j);

console.log('\n# 5. Cancelamento, lista e permissões');
const CX = await (async () => {
  const email = `e2e.fiscal.cx.${SUF}@girostock.local`; const senha = rnd();
  await api('POST', '/users', { nome: 'Caixa Fiscal', email, senha, perfil: 'Caixa/Operador', location_id: LOJA }, E.token);
  return (await login(email, senha)).j.token;
})();
const v4 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 2 }], forma_pagamento: 'pix' }, CX)).j;
const nCx = await api('POST', '/fiscal/nfce', { sale_id: v4.id }, CX);
check('caixa emite a nota da venda dele', nCx.s === 201 && nCx.j.situacao === 'autorizada' && nCx.j.numero === 4, nCx.j);
check('caixa não cancela nota (403: precisa de "Cancelar vendas")', (await api('POST', `/fiscal/notas/${nCx.j.id}/cancelar`, { justificativa: 'cliente desistiu da compra' }, CX)).s === 403);
check('caixa não mexe na configuração fiscal (403)', (await api('PUT', `/fiscal/lojas/${LOJA}`, cfgBase, CX)).s === 403);
check('justificativa curta -> 400', (await api('POST', `/fiscal/notas/${nCx.j.id}/cancelar`, { justificativa: 'desistiu' }, E.token)).s === 400);
const canc = await api('POST', `/fiscal/notas/${nCx.j.id}/cancelar`, { justificativa: 'Cliente desistiu da compra no caixa' }, E.token);
check('cancela a NFC-e autorizada', canc.s === 200 && canc.j.situacao === 'cancelada' && canc.j.cancel_justificativa, canc.j);
check('cancelar de novo -> 409', (await api('POST', `/fiscal/notas/${nCx.j.id}/cancelar`, { justificativa: 'Cliente desistiu da compra no caixa' }, E.token)).s === 409);
const lista = (await api('GET', '/fiscal/notas', null, E.token)).j;
check('lista as notas (mais recente primeiro, com a venda)', lista.length === 4 && lista[0].numero === 4 && lista.every((n) => n.venda_numero), lista.map((n) => [n.numero, n.situacao]));
check('filtro por situação', (await api('GET', '/fiscal/notas?situacao=cancelada', null, E.token)).j.length === 1);
check('PDV sabe o modo da loja (perguntar)', (await api('GET', `/fiscal/pdv?location_id=${LOJA}`, null, CX)).j.modo_pdv === 'perguntar');

console.log('\n# 5b. Cancelar a venda cancela a nota');
const vendaCom = async (simular) => {
  const v = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 1 }], forma_pagamento: 'pix' }, E.token)).j;
  const n = (await api('POST', '/fiscal/nfce', { sale_id: v.id, simular }, E.token)).j;
  return { v, n };
};
const situacaoVenda = async (id) => (await prod.query(`SELECT status FROM sales WHERE id = $1`, [id])).rows[0].status;
const situacaoNota = async (id) => (await prod.query(`SELECT situacao FROM notas_fiscais WHERE id = $1`, [id])).rows[0].situacao;
const a1 = await vendaCom();
const ca = await api('POST', `/sales/${a1.v.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
check('cancelar a venda cancela a NFC-e autorizada na SEFAZ', ca.s === 200 && ca.j.nfce_cancelada && ca.j.nfce_cancelada.numero === a1.n.numero && await situacaoNota(a1.n.id) === 'cancelada', ca.j);
check('justificativa da nota vem do motivo da venda', /Cancelamento da venda \d+: cliente desistiu/.test((await prod.query(`SELECT cancel_justificativa FROM notas_fiscais WHERE id = $1`, [a1.n.id])).rows[0].cancel_justificativa));
const a2 = await vendaCom();
const cr = await api('POST', `/sales/${a2.v.id}/cancel`, { motivo: 'cliente desistiu', simular_nota: 'rejeitar' }, E.token);
check('SEFAZ recusa o cancelamento (prazo): a venda NÃO é cancelada (422)', cr.s === 422 && /não foi cancelada/.test(cr.j.erro) && await situacaoVenda(a2.v.id) === 'concluida' && await situacaoNota(a2.n.id) === 'autorizada', cr.j);
const a3 = await vendaCom('sem_conexao');
const cc = await api('POST', `/sales/${a3.v.id}/cancel`, { motivo: 'cliente desistiu', simular_nota: 'sem_conexao' }, E.token);
check('nota em contingência sem conexão: a venda não é cancelada (409)', cc.s === 409 && await situacaoVenda(a3.v.id) === 'concluida', cc.j);
const cc2 = await api('POST', `/sales/${a3.v.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
check('com a conexão de volta: envia a nota de contingência e cancela as duas', cc2.s === 200 && cc2.j.nfce_cancelada && await situacaoNota(a3.n.id) === 'cancelada' && await situacaoVenda(a3.v.id) === 'cancelada', cc2.j);
const a4 = await vendaCom('rejeitar');
const cj = await api('POST', `/sales/${a4.v.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
check('nota rejeitada (sem valor): a venda cancela normalmente', cj.s === 200 && cj.j.nfce_cancelada === null && a4.n.situacao === 'rejeitada', cj.j);
const v6 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 1 }], forma_pagamento: 'pix' }, E.token)).j;
const cs = await api('POST', `/sales/${v6.id}/cancel`, { motivo: 'cliente desistiu' }, E.token);
check('venda sem nota: cancela como sempre', cs.s === 200 && cs.j.nfce_cancelada === null, cs.j);
check('nota cancelada sozinha deixa emitir de novo para a venda', (await api('POST', `/fiscal/nfce`, { sale_id: v4.id }, E.token)).j.situacao === 'autorizada');

console.log('\n# 6. Produção e isolamento');
check('passar para produção pede confirmação (409)', (await salvar({ ambiente: 'producao' })).s === 409);
const pr = await salvar({ ambiente: 'producao', confirmar_producao: true });
check('em produção sem o CSC de produção: não fica pronta', pr.s === 200 && pr.j.ambiente === 'producao' && pr.j.pronta === false && pr.j.pendencias.some((p) => /produção/.test(p)), pr.j);
const v5 = (await api('POST', '/sales', { terminal_id: T, itens: [{ product_id: REFRI, quantidade: 1 }], forma_pagamento: 'pix' }, E.token)).j;
check('sem o CSC de produção, a emissão é recusada (400)', (await api('POST', '/fiscal/nfce', { sale_id: v5.id }, E.token)).s === 400);
await salvar({ ambiente: 'producao', csc_producao: 'ABCDEF0123456789ABCDEF0123456789', csc_prod_id: '2' });
const nProd = await api('POST', '/fiscal/nfce', { sale_id: v5.id }, E.token);
check('produção: numeração própria (nº 1 de produção), sem marca de teste', nProd.j.situacao === 'autorizada' && nProd.j.numero === 1 && nProd.j.ambiente === 'producao' && nProd.j.teste === false, nProd.j);
const F = await novaEmpresa('b');
await api('PATCH', `/master/empresas/${F.id}`, { recursos: { nota_fiscal: true } }, MAS);
check('outra empresa não vê nem cancela a nota (404)', (await api('GET', `/fiscal/notas/${n1.j.id}`, null, F.token)).s === 404 && (await api('POST', `/fiscal/notas/${n1.j.id}/cancelar`, { justificativa: 'Cliente desistiu da compra no caixa' }, F.token)).s === 404);
check('outra empresa não emite nota de venda alheia (404)', (await api('POST', '/fiscal/nfce', { sale_id: v1.id }, F.token)).s === 404);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end();
process.exit(fail ? 1 : 0);
